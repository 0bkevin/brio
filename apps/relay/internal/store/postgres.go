package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct {
	pool *pgxpool.Pool
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
	_, err := s.pool.Exec(ctx, `
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
	token_hash TEXT UNIQUE,
	proof_key_thumbprint TEXT,
	installation_id TEXT,
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
CREATE TABLE IF NOT EXISTS dpop_proofs (
	thumbprint TEXT NOT NULL,
	jti TEXT NOT NULL,
	issued_at BIGINT NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (thumbprint, jti)
);
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_owner_user_id ON agents(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_agent_id ON pairing_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_sessions_user_id ON enrollment_sessions(user_id);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS companion_token_hash TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS environment_public_key TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS environment_credential_hash TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS endpoint_http_url TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS endpoint_ws_url TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS endpoint_provider TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_issuer TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_subject TEXT;
ALTER TABLE devices ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS proof_key_thumbprint TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS installation_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_identity ON users(identity_issuer, identity_subject)
	WHERE identity_issuer IS NOT NULL AND identity_subject IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dpop_proofs_expires_at ON dpop_proofs(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_user_installation ON devices(user_id, installation_id)
	WHERE installation_id IS NOT NULL;
`)
	return err
}

func (s *PostgresStore) UpsertIdentity(ctx context.Context, issuer string, subject string, email string) (User, error) {
	issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
	subject = strings.TrimSpace(subject)
	email = strings.TrimSpace(email)
	if issuer == "" || subject == "" {
		return User{}, ErrUnauthorized
	}
	var user User
	err := s.pool.QueryRow(ctx, `
INSERT INTO users (id, email, identity_issuer, identity_subject)
VALUES ($1, NULLIF(lower($2), ''), $3, $4)
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
	if email == "" {
		email = "dev@brio.local"
	}
	if deviceName == "" {
		deviceName = "Development device"
	}
	userID := IdentityUserID("urn:brio:development-email", strings.ToLower(strings.TrimSpace(email)))
	deviceID := "dev_" + RandomCode(24)
	token := "brio_" + RandomCode(48)
	tokenHash := HashSecret(token)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, Device{}, "", err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `
INSERT INTO users (id, email) VALUES ($1, lower($2))
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email
`, userID, email)
	if err != nil {
		return User{}, Device{}, "", err
	}
	var user User
	err = tx.QueryRow(ctx, `SELECT id, email, created_at FROM users WHERE id = $1`, userID).Scan(&user.ID, &user.Email, &user.CreatedAt)
	if err != nil {
		return User{}, Device{}, "", err
	}
	var device Device
	err = tx.QueryRow(ctx, `
INSERT INTO devices (id, user_id, name, token_hash)
VALUES ($1, $2, $3, $4)
RETURNING id, user_id, name, created_at, revoked_at
`, deviceID, user.ID, deviceName, tokenHash).Scan(&device.ID, &device.UserID, &device.Name, &device.CreatedAt, &device.RevokedAt)
	if err != nil {
		return User{}, Device{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, Device{}, "", err
	}
	return user, device, token, nil
}

func (s *PostgresStore) AuthenticateDevice(ctx context.Context, token string) (Auth, error) {
	var auth Auth
	err := s.pool.QueryRow(ctx, `
SELECT u.id, u.email, u.created_at, d.id, d.user_id, d.name, d.created_at, d.revoked_at
FROM devices d
JOIN users u ON u.id = d.user_id
WHERE d.token_hash = $1 AND d.revoked_at IS NULL
`, HashSecret(token)).Scan(
		&auth.User.ID, &auth.User.Email, &auth.User.CreatedAt,
		&auth.Device.ID, &auth.Device.UserID, &auth.Device.Name, &auth.Device.CreatedAt, &auth.Device.RevokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Auth{}, ErrUnauthorized
	}
	return auth, err
}

func (s *PostgresStore) UpsertDevice(ctx context.Context, userID string, deviceID string, name string, proofKeyThumbprint string) (Device, error) {
	installationID := strings.TrimSpace(deviceID)
	proofKeyThumbprint = strings.TrimSpace(proofKeyThumbprint)
	if installationID == "" || proofKeyThumbprint == "" {
		return Device{}, ErrUnauthorized
	}
	if name = strings.TrimSpace(name); name == "" {
		name = "Brio mobile"
	}
	deviceID = DeviceRecordID(userID, installationID)
	var device Device
	err := s.pool.QueryRow(ctx, `
INSERT INTO devices (id, user_id, name, proof_key_thumbprint, installation_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id, installation_id) WHERE installation_id IS NOT NULL DO UPDATE
SET name = EXCLUDED.name,
	proof_key_thumbprint = EXCLUDED.proof_key_thumbprint,
	revoked_at = NULL
RETURNING id, COALESCE(installation_id, ''), user_id, name, COALESCE(proof_key_thumbprint, ''), created_at, revoked_at
`, deviceID, userID, name, proofKeyThumbprint, installationID).Scan(
		&device.ID, &device.InstallationID, &device.UserID, &device.Name, &device.ProofKeyThumbprint, &device.CreatedAt, &device.RevokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, ErrUnauthorized
	}
	return device, err
}

func (s *PostgresStore) ConsumeDPoPProof(ctx context.Context, thumbprint string, jti string, issuedAt int64, expiresAt time.Time) (bool, error) {
	command, err := s.pool.Exec(ctx, `
INSERT INTO dpop_proofs (thumbprint, jti, issued_at, expires_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING
`, thumbprint, jti, issuedAt, expiresAt)
	if err != nil {
		return false, err
	}
	return command.RowsAffected() == 1, nil
}

func (s *PostgresStore) PruneDPoPProofs(ctx context.Context, now time.Time) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM dpop_proofs WHERE expires_at <= $1`, now)
	return err
}

func (s *PostgresStore) ListDevices(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.pool.Query(ctx, `
SELECT id, COALESCE(installation_id, ''), user_id, name, COALESCE(proof_key_thumbprint, ''), created_at, revoked_at
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
		if err := rows.Scan(&device.ID, &device.InstallationID, &device.UserID, &device.Name, &device.ProofKeyThumbprint, &device.CreatedAt, &device.RevokedAt); err != nil {
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

func (s *PostgresStore) AuthenticateEnvironment(ctx context.Context, agentID string, credential string) (Agent, error) {
	if credential == "" {
		return Agent{}, ErrUnauthorized
	}
	var agent Agent
	var endpointHTTP, endpointWS, endpointProvider string
	err := s.pool.QueryRow(ctx, `
SELECT id, owner_user_id, name, mode, status, last_seen_at, created_at,
  COALESCE(environment_public_key, ''), COALESCE(environment_credential_hash, ''),
  COALESCE(endpoint_http_url, ''), COALESCE(endpoint_ws_url, ''), COALESCE(endpoint_provider, ''), linked_at
FROM agents
WHERE id = $1 AND environment_credential_hash = $2 AND linked_at IS NOT NULL
`, agentID, HashSecret(credential)).Scan(
		&agent.ID, &agent.OwnerUserID, &agent.Name, &agent.Mode, &agent.Status, &agent.LastSeenAt, &agent.CreatedAt,
		&agent.EnvironmentPublicKey, &agent.EnvironmentCredentialHash,
		&endpointHTTP, &endpointWS, &endpointProvider, &agent.LinkedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrUnauthorized
	}
	if err != nil {
		return Agent{}, err
	}
	setAgentEndpoint(&agent, endpointHTTP, endpointWS, endpointProvider)
	return agent, nil
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
	_, err := s.pool.Exec(ctx, `
INSERT INTO agents (id, name, status, last_seen_at)
VALUES ($1, 'Hermes', $2, now())
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, last_seen_at = now()
`, agentID, status)
	return err
}

func (s *PostgresStore) CreateEnrollment(ctx context.Context, userID string, name string, ttl time.Duration) (Enrollment, error) {
	if name == "" {
		name = "Hermes"
	}
	code := RandomCode(16)
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

func (s *PostgresStore) GetEnrollment(ctx context.Context, code string) (Enrollment, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	var enrollment Enrollment
	err := s.pool.QueryRow(ctx, `
SELECT user_id, name, expires_at, used_at, created_at
FROM enrollment_sessions
WHERE code_hash = $1
`, HashSecret(code)).Scan(&enrollment.UserID, &enrollment.Name, &enrollment.ExpiresAt, &enrollment.UsedAt, &enrollment.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Enrollment{}, ErrNotFound
	}
	if err != nil {
		return Enrollment{}, err
	}
	if time.Now().After(enrollment.ExpiresAt) {
		return Enrollment{}, ErrExpired
	}
	if enrollment.UsedAt != nil {
		return Enrollment{}, ErrUsed
	}
	enrollment.Code = code
	return enrollment, nil
}

func (s *PostgresStore) ClaimEnrollment(ctx context.Context, code string, agentID string, name string, link *ConnectLink) (Agent, string, string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Agent{}, "", "", err
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
		return Agent{}, "", "", ErrNotFound
	}
	if err != nil {
		return Agent{}, "", "", err
	}
	if time.Now().After(enrollment.ExpiresAt) {
		return Agent{}, "", "", ErrExpired
	}
	if enrollment.UsedAt != nil {
		return Agent{}, "", "", ErrUsed
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
		return Agent{}, "", "", err
	}
	if err == nil && existingOwner != nil && *existingOwner != enrollment.UserID {
		return Agent{}, "", "", ErrUnauthorized
	}

	token := "brio_agent_" + RandomCode(48)
	environmentCredential := ""
	environmentPublicKey := ""
	endpointHTTP := ""
	endpointWS := ""
	endpointProvider := ""
	var linkedAt *time.Time
	if link != nil {
		environmentCredential = "brio_env_" + RandomCode(48)
		environmentPublicKey = link.EnvironmentPublicKey
		endpointHTTP = link.Endpoint.HTTPBaseURL
		endpointWS = link.Endpoint.WSBaseURL
		endpointProvider = link.Endpoint.ProviderKind
		now := time.Now().UTC()
		linkedAt = &now
	}
	now := time.Now().UTC()
	var agent Agent
	var returnedEndpointHTTP, returnedEndpointWS, returnedEndpointProvider string
	err = tx.QueryRow(ctx, `
INSERT INTO agents (
  id, owner_user_id, name, companion_token_hash, mode, status, last_seen_at,
  environment_public_key, environment_credential_hash,
  endpoint_http_url, endpoint_ws_url, endpoint_provider, linked_at
)
VALUES ($1, $2, $3, $4, 'self_hosted', 'online', $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), $11)
ON CONFLICT (id) DO UPDATE
SET owner_user_id = EXCLUDED.owner_user_id,
    name = EXCLUDED.name,
    companion_token_hash = EXCLUDED.companion_token_hash,
    status = 'online',
    last_seen_at = EXCLUDED.last_seen_at,
    environment_public_key = COALESCE(EXCLUDED.environment_public_key, agents.environment_public_key),
    environment_credential_hash = COALESCE(EXCLUDED.environment_credential_hash, agents.environment_credential_hash),
    endpoint_http_url = COALESCE(EXCLUDED.endpoint_http_url, agents.endpoint_http_url),
    endpoint_ws_url = COALESCE(EXCLUDED.endpoint_ws_url, agents.endpoint_ws_url),
    endpoint_provider = COALESCE(EXCLUDED.endpoint_provider, agents.endpoint_provider),
    linked_at = COALESCE(EXCLUDED.linked_at, agents.linked_at)
RETURNING id, owner_user_id, name, mode, status, last_seen_at, created_at,
  COALESCE(environment_public_key, ''), COALESCE(environment_credential_hash, ''),
  COALESCE(endpoint_http_url, ''), COALESCE(endpoint_ws_url, ''), COALESCE(endpoint_provider, ''), linked_at
`, agentID, enrollment.UserID, name, HashSecret(token), now,
		environmentPublicKey, hashOptional(environmentCredential), endpointHTTP, endpointWS, endpointProvider, linkedAt).Scan(
		&agent.ID,
		&agent.OwnerUserID,
		&agent.Name,
		&agent.Mode,
		&agent.Status,
		&agent.LastSeenAt,
		&agent.CreatedAt,
		&agent.EnvironmentPublicKey,
		&agent.EnvironmentCredentialHash,
		&returnedEndpointHTTP,
		&returnedEndpointWS,
		&returnedEndpointProvider,
		&agent.LinkedAt,
	)
	if err != nil {
		return Agent{}, "", "", err
	}
	setAgentEndpoint(&agent, returnedEndpointHTTP, returnedEndpointWS, returnedEndpointProvider)

	_, err = tx.Exec(ctx, `UPDATE enrollment_sessions SET used_at = now() WHERE code_hash = $1`, HashSecret(code))
	if err != nil {
		return Agent{}, "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, "", "", err
	}
	return agent, token, environmentCredential, nil
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
VALUES ($1, $2, 'online', now())
`, agentID, name)
		if err != nil {
			return Pairing{}, err
		}
	} else if err != nil {
		return Pairing{}, err
	} else {
		if ownerUserID != nil && (companionToken == "" || currentTokenHash == nil || *currentTokenHash != HashSecret(companionToken)) {
			return Pairing{}, ErrUnauthorized
		}
		_, err = tx.Exec(ctx, `
UPDATE agents
SET name = $2, status = 'online', last_seen_at = now()
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
SET name = $3, status = 'online', last_seen_at = now(), companion_token_hash = $4
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
SET owner_user_id = COALESCE(owner_user_id, $2), status = 'online', last_seen_at = now()
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
SELECT id, owner_user_id, name, mode, status, last_seen_at, created_at,
  COALESCE(endpoint_http_url, ''), COALESCE(endpoint_ws_url, ''), COALESCE(endpoint_provider, ''), linked_at
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
		var endpointHTTP, endpointWS, endpointProvider string
		if err := rows.Scan(&agent.ID, &agent.OwnerUserID, &agent.Name, &agent.Mode, &agent.Status, &agent.LastSeenAt, &agent.CreatedAt, &endpointHTTP, &endpointWS, &endpointProvider, &agent.LinkedAt); err != nil {
			return nil, err
		}
		setAgentEndpoint(&agent, endpointHTTP, endpointWS, endpointProvider)
		out = append(out, agent)
	}
	return out, rows.Err()
}

func (s *PostgresStore) UserCanAccessAgent(ctx context.Context, userID string, agentID string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agents WHERE id = $1 AND owner_user_id = $2)`, agentID, userID).Scan(&ok)
	return ok, err
}

func (s *PostgresStore) GetConnectEnvironment(ctx context.Context, userID string, agentID string) (Agent, error) {
	var agent Agent
	var endpointHTTP, endpointWS, endpointProvider string
	err := s.pool.QueryRow(ctx, `
SELECT id, owner_user_id, name, mode, status, last_seen_at, created_at,
  COALESCE(environment_public_key, ''), COALESCE(environment_credential_hash, ''),
  COALESCE(endpoint_http_url, ''), COALESCE(endpoint_ws_url, ''), COALESCE(endpoint_provider, ''), linked_at
FROM agents
WHERE id = $1 AND owner_user_id = $2
`, agentID, userID).Scan(
		&agent.ID, &agent.OwnerUserID, &agent.Name, &agent.Mode, &agent.Status, &agent.LastSeenAt, &agent.CreatedAt,
		&agent.EnvironmentPublicKey, &agent.EnvironmentCredentialHash,
		&endpointHTTP, &endpointWS, &endpointProvider, &agent.LinkedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if checkErr := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agents WHERE id = $1)`, agentID).Scan(&exists); checkErr != nil {
			return Agent{}, checkErr
		}
		if exists {
			return Agent{}, ErrUnauthorized
		}
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, err
	}
	setAgentEndpoint(&agent, endpointHTTP, endpointWS, endpointProvider)
	if agent.Endpoint == nil || agent.EnvironmentPublicKey == "" || agent.LinkedAt == nil {
		return Agent{}, ErrNotFound
	}
	return agent, nil
}

func (s *PostgresStore) UnlinkAgent(ctx context.Context, userID string, agentID string) (bool, error) {
	command, err := s.pool.Exec(ctx, `
UPDATE agents
SET environment_public_key = NULL,
    environment_credential_hash = NULL,
    endpoint_http_url = NULL,
    endpoint_ws_url = NULL,
    endpoint_provider = NULL,
    linked_at = NULL,
    status = 'offline'
WHERE id = $1 AND owner_user_id = $2
  AND (environment_public_key IS NOT NULL OR endpoint_http_url IS NOT NULL)
`, agentID, userID)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() > 0 {
		return true, nil
	}
	var owner *string
	err = s.pool.QueryRow(ctx, `SELECT owner_user_id FROM agents WHERE id = $1`, agentID).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if owner == nil || *owner != userID {
		return false, ErrUnauthorized
	}
	return false, nil
}

func hashOptional(value string) string {
	if value == "" {
		return ""
	}
	return HashSecret(value)
}

func setAgentEndpoint(agent *Agent, httpURL, wsURL, provider string) {
	if httpURL == "" || provider == "" {
		return
	}
	agent.Endpoint = &ManagedEndpoint{HTTPBaseURL: httpURL, WSBaseURL: wsURL, ProviderKind: provider}
}

func (s *PostgresStore) UpdateConnectEndpoint(ctx context.Context, agentID string, endpoint ManagedEndpoint) error {
	command, err := s.pool.Exec(ctx, `
UPDATE agents SET endpoint_http_url = $2, endpoint_ws_url = $3, endpoint_provider = $4
WHERE id = $1 AND linked_at IS NOT NULL
`, agentID, endpoint.HTTPBaseURL, endpoint.WSBaseURL, endpoint.ProviderKind)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) CountManagedEndpoints(ctx context.Context, userID string, excludingAgentID string) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM agents
WHERE owner_user_id = $1 AND id <> $2 AND endpoint_provider = 'cloudflare_tunnel' AND linked_at IS NOT NULL
`, userID, excludingAgentID).Scan(&count)
	return count, err
}
