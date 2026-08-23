package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct {
	pool *pgxpool.Pool
}

type postgresMigration struct {
	version int
	name    string
	sql     string
}

const postgresMigrationLockID int64 = 0x4252494f52454c59

var postgresMigrations = []postgresMigration{
	{
		version: 1,
		name:    "baseline_control_plane",
		sql: `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  identity_issuer TEXT,
  identity_subject TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  companion_token_hash TEXT,
  mode TEXT NOT NULL DEFAULT 'self_hosted',
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pairing_sessions (
  code_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS enrollment_sessions (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_owner_user_id ON agents(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_agent_id ON pairing_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_sessions_user_id ON enrollment_sessions(user_id);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS companion_token_hash TEXT;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_issuer TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_subject TEXT;
WITH legacy_unverified_users AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY lower(btrim(email))
           ORDER BY
             EXISTS(SELECT 1 FROM agents WHERE agents.owner_user_id = users.id) DESC,
             EXISTS(SELECT 1 FROM devices WHERE devices.user_id = users.id) DESC,
             created_at ASC
         ) AS principal_rank
  FROM users
  WHERE identity_issuer IS NULL
    AND identity_subject IS NULL
    AND NULLIF(btrim(email), '') IS NOT NULL
)
UPDATE users
SET identity_issuer = 'urn:brio:unverified-email',
    identity_subject = lower(btrim(users.email))
FROM legacy_unverified_users
WHERE users.id = legacy_unverified_users.id
  AND legacy_unverified_users.principal_rank = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_identity ON users(identity_issuer, identity_subject)
  WHERE identity_issuer IS NOT NULL AND identity_subject IS NOT NULL;
`,
	},
}

func NewPostgresStore(ctx context.Context, databaseURL string) (*PostgresStore, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	s := &PostgresStore{pool: pool}
	if err := s.migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return s, nil
}

func (s *PostgresStore) Close() {
	s.pool.Close()
}

func (s *PostgresStore) migrate(ctx context.Context) error {
	if err := validatePostgresMigrations(postgresMigrations); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS brio_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
`); err != nil {
		return fmt.Errorf("create schema migration ledger: %w", err)
	}
	for _, migration := range postgresMigrations {
		if err := s.applyMigration(ctx, migration); err != nil {
			return err
		}
	}
	return nil
}

func validatePostgresMigrations(migrations []postgresMigration) error {
	previous := 0
	for _, migration := range migrations {
		if migration.version <= previous || strings.TrimSpace(migration.name) == "" || strings.TrimSpace(migration.sql) == "" {
			return fmt.Errorf("invalid postgres migration version %d (%q)", migration.version, migration.name)
		}
		previous = migration.version
	}
	return nil
}

func (s *PostgresStore) applyMigration(ctx context.Context, migration postgresMigration) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin postgres migration %d (%s): %w", migration.version, migration.name, err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, postgresMigrationLockID); err != nil {
		return fmt.Errorf("lock postgres migrations: %w", err)
	}
	var appliedName string
	err = tx.QueryRow(ctx, `SELECT name FROM brio_schema_migrations WHERE version = $1`, migration.version).Scan(&appliedName)
	if err == nil {
		if appliedName != migration.name {
			return fmt.Errorf("postgres migration %d is recorded as %q, expected %q", migration.version, appliedName, migration.name)
		}
		return tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("read postgres migration %d: %w", migration.version, err)
	}
	if _, err := tx.Exec(ctx, migration.sql); err != nil {
		return fmt.Errorf("apply postgres migration %d (%s): %w", migration.version, migration.name, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO brio_schema_migrations (version, name) VALUES ($1, $2)`, migration.version, migration.name); err != nil {
		return fmt.Errorf("record postgres migration %d (%s): %w", migration.version, migration.name, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit postgres migration %d (%s): %w", migration.version, migration.name, err)
	}
	return nil
}

func (s *PostgresStore) UpsertIdentity(ctx context.Context, issuer string, subject string, email string) (User, error) {
	issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
	subject = strings.TrimSpace(subject)
	email = strings.ToLower(strings.TrimSpace(email))
	if issuer == "" || subject == "" {
		return User{}, ErrUnauthorized
	}
	var user User
	err := s.pool.QueryRow(ctx, `
INSERT INTO users (id, email, identity_issuer, identity_subject)
VALUES ($1, NULLIF($2, ''), $3, $4)
ON CONFLICT (identity_issuer, identity_subject)
  WHERE identity_issuer IS NOT NULL AND identity_subject IS NOT NULL
DO UPDATE SET email = COALESCE(NULLIF(EXCLUDED.email, ''), users.email)
RETURNING id, COALESCE(email, ''), COALESCE(identity_issuer, ''), COALESCE(identity_subject, ''), created_at
`, IdentityUserID(issuer, subject), email, issuer, subject).Scan(
		&user.ID, &user.Email, &user.IdentityIssuer, &user.IdentitySubject, &user.CreatedAt,
	)
	return user, err
}

func (s *PostgresStore) CreateDeviceToken(ctx context.Context, email string, deviceName string) (User, Device, string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		email = "dev@brio.local"
	}
	if deviceName == "" {
		deviceName = "Development device"
	}
	user, err := s.UpsertIdentity(ctx, "urn:brio:unverified-email", email, email)
	if err != nil {
		return User{}, Device{}, "", err
	}
	return s.CreateDeviceTokenForUser(ctx, user.ID, deviceName)
}

func (s *PostgresStore) CreateDeviceTokenForUser(ctx context.Context, userID string, deviceName string) (User, Device, string, error) {
	if deviceName == "" {
		deviceName = "Development device"
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, Device{}, "", err
	}
	defer tx.Rollback(ctx)

	var user User
	err = tx.QueryRow(ctx, `
SELECT id, COALESCE(email, ''), COALESCE(identity_issuer, ''), COALESCE(identity_subject, ''), created_at
FROM users
WHERE id = $1
`, strings.TrimSpace(userID)).Scan(
		&user.ID, &user.Email, &user.IdentityIssuer, &user.IdentitySubject, &user.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, Device{}, "", ErrUnauthorized
	}
	if err != nil {
		return User{}, Device{}, "", err
	}
	device, token, err := createPostgresDeviceToken(ctx, tx, user.ID, deviceName)
	if err != nil {
		return User{}, Device{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, Device{}, "", err
	}
	return user, device, token, nil
}

type postgresDeviceTokenTx interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func createPostgresDeviceToken(ctx context.Context, tx postgresDeviceTokenTx, userID string, deviceName string) (Device, string, error) {
	deviceID := "dev_" + RandomCode(24)
	token := "brio_dev_" + RandomCode(48)
	tokenHash := HashSecret(token)
	var device Device
	err := tx.QueryRow(ctx, `
INSERT INTO devices (id, user_id, name, token_hash)
VALUES ($1, $2, $3, $4)
RETURNING id, user_id, name, created_at, revoked_at
`, deviceID, userID, deviceName, tokenHash).Scan(&device.ID, &device.UserID, &device.Name, &device.CreatedAt, &device.RevokedAt)
	if err != nil {
		return Device{}, "", err
	}
	return device, token, nil
}

func (s *PostgresStore) AuthenticateDevice(ctx context.Context, token string) (Auth, error) {
	var auth Auth
	err := s.pool.QueryRow(ctx, `
SELECT u.id, COALESCE(u.email, ''), COALESCE(u.identity_issuer, ''), COALESCE(u.identity_subject, ''), u.created_at,
       d.id, d.user_id, d.name, d.created_at, d.revoked_at
FROM devices d
JOIN users u ON u.id = d.user_id
WHERE d.token_hash = $1 AND d.revoked_at IS NULL
`, HashSecret(token)).Scan(
		&auth.User.ID, &auth.User.Email, &auth.User.IdentityIssuer, &auth.User.IdentitySubject, &auth.User.CreatedAt,
		&auth.Device.ID, &auth.Device.UserID, &auth.Device.Name, &auth.Device.CreatedAt, &auth.Device.RevokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Auth{}, ErrUnauthorized
	}
	return auth, err
}

func (s *PostgresStore) ListDevices(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.pool.Query(ctx, `
SELECT id, user_id, name, created_at, revoked_at
FROM devices
WHERE user_id = $1
ORDER BY created_at DESC
`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Device
	for rows.Next() {
		var device Device
		if err := rows.Scan(&device.ID, &device.UserID, &device.Name, &device.CreatedAt, &device.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, device)
	}
	return out, rows.Err()
}

func (s *PostgresStore) RevokeDevice(ctx context.Context, userID string, deviceID string) (Device, error) {
	var device Device
	err := s.pool.QueryRow(ctx, `
UPDATE devices
SET revoked_at = COALESCE(revoked_at, now())
WHERE id = $1 AND user_id = $2
RETURNING id, user_id, name, created_at, revoked_at
`, deviceID, userID).Scan(&device.ID, &device.UserID, &device.Name, &device.CreatedAt, &device.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		checkErr := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE id = $1)`, deviceID).Scan(&exists)
		if checkErr != nil {
			return Device{}, checkErr
		}
		if exists {
			return Device{}, ErrUnauthorized
		}
		return Device{}, ErrNotFound
	}
	return device, err
}

func (s *PostgresStore) AuthenticateCompanion(ctx context.Context, agentID string, token string) error {
	if token == "" {
		return ErrUnauthorized
	}
	var ok bool
	err := s.pool.QueryRow(ctx, `
SELECT EXISTS(
  SELECT 1 FROM agents
  WHERE id = $1 AND companion_token_hash = $2
)
`, agentID, HashSecret(token)).Scan(&ok)
	if err != nil {
		return err
	}
	if !ok {
		return ErrUnauthorized
	}
	return nil
}

func (s *PostgresStore) UpsertAgent(ctx context.Context, agentID string, name string) (Agent, error) {
	if name == "" {
		name = "Hermes"
	}
	var agent Agent
	err := s.pool.QueryRow(ctx, `
INSERT INTO agents (id, name, status, last_seen_at)
VALUES ($1, $2, 'online', now())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = 'online', last_seen_at = now()
RETURNING id, owner_user_id, name, mode, status, last_seen_at, created_at
`, agentID, name).Scan(&agent.ID, &agent.OwnerUserID, &agent.Name, &agent.Mode, &agent.Status, &agent.LastSeenAt, &agent.CreatedAt)
	return agent, err
}

func (s *PostgresStore) TouchAgent(ctx context.Context, agentID string, status string) error {
	result, err := s.pool.Exec(ctx, `
UPDATE agents
SET status = $2, last_seen_at = now()
WHERE id = $1
`, agentID, status)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) CreateEnrollment(ctx context.Context, userID string, name string, ttl time.Duration) (Enrollment, error) {
	if name == "" {
		name = "Hermes"
	}
	code := RandomCode(8)
	var enrollment Enrollment
	err := s.pool.QueryRow(ctx, `
INSERT INTO enrollment_sessions (code_hash, user_id, name, expires_at)
VALUES ($1, $2, $3, $4)
RETURNING user_id, name, expires_at, used_at, created_at
`, HashSecret(code), userID, name, time.Now().UTC().Add(ttl)).Scan(
		&enrollment.UserID,
		&enrollment.Name,
		&enrollment.ExpiresAt,
		&enrollment.UsedAt,
		&enrollment.CreatedAt,
	)
	if err != nil {
		return Enrollment{}, err
	}
	enrollment.Code = code
	return enrollment, nil
}

func (s *PostgresStore) ClaimEnrollment(ctx context.Context, code string, agentID string, name string) (Agent, string, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Agent{}, "", err
	}
	defer tx.Rollback(ctx)

	var enrollment Enrollment
	err = tx.QueryRow(ctx, `
SELECT user_id, name, expires_at, used_at, created_at
FROM enrollment_sessions
WHERE code_hash = $1
FOR UPDATE
`, HashSecret(code)).Scan(
		&enrollment.UserID,
		&enrollment.Name,
		&enrollment.ExpiresAt,
		&enrollment.UsedAt,
		&enrollment.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, "", ErrNotFound
	}
	if err != nil {
		return Agent{}, "", err
	}
	if time.Now().After(enrollment.ExpiresAt) {
		return Agent{}, "", ErrExpired
	}
	if enrollment.UsedAt != nil {
		return Agent{}, "", ErrUsed
	}
	if name == "" {
		name = enrollment.Name
	}

	var existingOwner *string
	err = tx.QueryRow(ctx, `
SELECT owner_user_id
FROM agents
WHERE id = $1
FOR UPDATE
`, agentID).Scan(&existingOwner)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, "", err
	}
	if err == nil && existingOwner != nil && *existingOwner != enrollment.UserID {
		return Agent{}, "", ErrUnauthorized
	}

	token := "brio_agent_" + RandomCode(48)
	var agent Agent
	err = tx.QueryRow(ctx, `
INSERT INTO agents (id, owner_user_id, name, companion_token_hash, mode, status, last_seen_at)
VALUES ($1, $2, $3, $4, 'self_hosted', 'offline', NULL)
ON CONFLICT (id) DO UPDATE
SET owner_user_id = EXCLUDED.owner_user_id,
    name = EXCLUDED.name,
    companion_token_hash = EXCLUDED.companion_token_hash,
    status = 'offline'
RETURNING id, owner_user_id, name, mode, status, last_seen_at, created_at
`, agentID, enrollment.UserID, name, HashSecret(token)).Scan(
		&agent.ID,
		&agent.OwnerUserID,
		&agent.Name,
		&agent.Mode,
		&agent.Status,
		&agent.LastSeenAt,
		&agent.CreatedAt,
	)
	if err != nil {
		return Agent{}, "", err
	}

	_, err = tx.Exec(ctx, `UPDATE enrollment_sessions SET used_at = now() WHERE code_hash = $1`, HashSecret(code))
	if err != nil {
		return Agent{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, "", err
	}
	return agent, token, nil
}

func (s *PostgresStore) CreatePairing(ctx context.Context, agentID string, name string, ttl time.Duration, companionToken string) (Pairing, error) {
	if name == "" {
		name = "Hermes"
	}
	code := RandomCode(8)
	agentToken := "brio_agent_" + RandomCode(48)
	var p Pairing
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Pairing{}, err
	}
	defer tx.Rollback(ctx)
	var ownerUserID *string
	var currentTokenHash *string
	err = tx.QueryRow(ctx, `
SELECT owner_user_id, companion_token_hash
FROM agents
WHERE id = $1
FOR UPDATE
`, agentID).Scan(&ownerUserID, &currentTokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `
INSERT INTO agents (id, name, status, last_seen_at)
VALUES ($1, $2, 'offline', NULL)
`, agentID, name)
		if err != nil {
			return Pairing{}, err
		}
	} else if err != nil {
		return Pairing{}, err
	} else {
		if companionToken == "" || currentTokenHash == nil || *currentTokenHash != HashSecret(companionToken) {
			return Pairing{}, ErrUnauthorized
		}
		_, err = tx.Exec(ctx, `
UPDATE agents
SET name = $2, status = 'offline'
WHERE id = $1
`, agentID, name)
		if err != nil {
			return Pairing{}, err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE agents SET companion_token_hash = $2 WHERE id = $1`, agentID, HashSecret(agentToken))
	if err != nil {
		return Pairing{}, err
	}
	err = tx.QueryRow(ctx, `
INSERT INTO pairing_sessions (code_hash, agent_id, name, expires_at)
VALUES ($1, $2, $3, $4)
RETURNING agent_id, name, expires_at, used_at, created_at
`, HashSecret(code), agentID, name, time.Now().UTC().Add(ttl)).Scan(&p.AgentID, &p.Name, &p.ExpiresAt, &p.UsedAt, &p.CreatedAt)
	if err != nil {
		return Pairing{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Pairing{}, err
	}
	p.Code = code
	p.AgentToken = agentToken
	return p, nil
}

func (s *PostgresStore) RecoverPairing(ctx context.Context, userID string, agentID string, name string, ttl time.Duration) (Pairing, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Pairing{}, err
	}
	defer tx.Rollback(ctx)

	var currentName string
	err = tx.QueryRow(ctx, `
SELECT name
FROM agents
WHERE id = $1 AND owner_user_id = $2
FOR UPDATE
`, agentID, userID).Scan(&currentName)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		checkErr := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agents WHERE id = $1)`, agentID).Scan(&exists)
		if checkErr != nil {
			return Pairing{}, checkErr
		}
		if exists {
			return Pairing{}, ErrUnauthorized
		}
		return Pairing{}, ErrNotFound
	}
	if err != nil {
		return Pairing{}, err
	}
	if name == "" {
		name = currentName
	}

	code := RandomCode(8)
	agentToken := "brio_agent_" + RandomCode(48)
	var p Pairing
	_, err = tx.Exec(ctx, `
UPDATE agents
SET name = $3, companion_token_hash = $4, status = 'offline'
WHERE id = $1 AND owner_user_id = $2
`, agentID, userID, name, HashSecret(agentToken))
	if err != nil {
		return Pairing{}, err
	}
	err = tx.QueryRow(ctx, `
INSERT INTO pairing_sessions (code_hash, agent_id, name, expires_at)
VALUES ($1, $2, $3, $4)
RETURNING agent_id, name, expires_at, used_at, created_at
`, HashSecret(code), agentID, name, time.Now().UTC().Add(ttl)).Scan(&p.AgentID, &p.Name, &p.ExpiresAt, &p.UsedAt, &p.CreatedAt)
	if err != nil {
		return Pairing{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Pairing{}, err
	}
	p.Code = code
	p.AgentToken = agentToken
	return p, nil
}

func (s *PostgresStore) GetPairing(ctx context.Context, code string) (Pairing, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	var p Pairing
	err := s.pool.QueryRow(ctx, `
SELECT agent_id, name, expires_at, used_at, created_at
FROM pairing_sessions
WHERE code_hash = $1
`, HashSecret(code)).Scan(&p.AgentID, &p.Name, &p.ExpiresAt, &p.UsedAt, &p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Pairing{}, ErrNotFound
	}
	if err != nil {
		return Pairing{}, err
	}
	p.Code = code
	if time.Now().After(p.ExpiresAt) {
		return Pairing{}, ErrExpired
	}
	if p.UsedAt != nil {
		return Pairing{}, ErrUsed
	}
	return p, nil
}

func (s *PostgresStore) ClaimPairing(ctx context.Context, code string, userID string) (Agent, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Agent{}, err
	}
	defer tx.Rollback(ctx)
	var p Pairing
	err = tx.QueryRow(ctx, `
SELECT agent_id, name, expires_at, used_at, created_at
FROM pairing_sessions
WHERE code_hash = $1
FOR UPDATE
`, HashSecret(code)).Scan(&p.AgentID, &p.Name, &p.ExpiresAt, &p.UsedAt, &p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, err
	}
	if time.Now().After(p.ExpiresAt) {
		return Agent{}, ErrExpired
	}
	if p.UsedAt != nil {
		return Agent{}, ErrUsed
	}
	_, err = tx.Exec(ctx, `UPDATE pairing_sessions SET used_at = now() WHERE code_hash = $1`, HashSecret(code))
	if err != nil {
		return Agent{}, err
	}
	var agent Agent
	err = tx.QueryRow(ctx, `
UPDATE agents
SET owner_user_id = COALESCE(owner_user_id, $2)
WHERE id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2)
RETURNING id, owner_user_id, name, mode, status, last_seen_at, created_at
`, p.AgentID, userID).Scan(&agent.ID, &agent.OwnerUserID, &agent.Name, &agent.Mode, &agent.Status, &agent.LastSeenAt, &agent.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrUnauthorized
	}
	if err != nil {
		return Agent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, err
	}
	return agent, nil
}

func (s *PostgresStore) ListAgents(ctx context.Context, userID string) ([]Agent, error) {
	rows, err := s.pool.Query(ctx, `
SELECT id, owner_user_id, name, mode, status, last_seen_at, created_at
FROM agents
WHERE owner_user_id = $1
ORDER BY created_at DESC
`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Agent
	for rows.Next() {
		var agent Agent
		if err := rows.Scan(&agent.ID, &agent.OwnerUserID, &agent.Name, &agent.Mode, &agent.Status, &agent.LastSeenAt, &agent.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, agent)
	}
	return out, rows.Err()
}

func (s *PostgresStore) UnlinkAgent(ctx context.Context, userID string, agentID string) (Agent, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Agent{}, err
	}
	defer tx.Rollback(ctx)

	var agent Agent
	err = tx.QueryRow(ctx, `
SELECT id, owner_user_id, name, mode, status, last_seen_at, created_at
FROM agents
WHERE id = $1
FOR UPDATE
`, agentID).Scan(
		&agent.ID,
		&agent.OwnerUserID,
		&agent.Name,
		&agent.Mode,
		&agent.Status,
		&agent.LastSeenAt,
		&agent.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, err
	}
	if agent.OwnerUserID == nil || *agent.OwnerUserID != userID {
		return Agent{}, ErrUnauthorized
	}
	if _, err := tx.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID); err != nil {
		return Agent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, err
	}
	return agent, nil
}

func (s *PostgresStore) UserCanAccessAgent(ctx context.Context, userID string, agentID string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agents WHERE id = $1 AND owner_user_id = $2)`, agentID, userID).Scan(&ok)
	return ok, err
}
