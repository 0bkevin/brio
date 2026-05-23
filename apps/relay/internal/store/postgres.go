package store

import (
	"context"
	"errors"
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
  email TEXT NOT NULL UNIQUE,
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
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_owner_user_id ON agents(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_pairing_sessions_agent_id ON pairing_sessions(agent_id);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS companion_token_hash TEXT;
`)
	return err
}

func (s *PostgresStore) CreateDeviceToken(ctx context.Context, email string, deviceName string) (User, Device, string, error) {
	if email == "" {
		email = "dev@brio.local"
	}
	if deviceName == "" {
		deviceName = "Development device"
	}
	userID := "usr_" + RandomCode(24)
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
ON CONFLICT (email) DO NOTHING
`, userID, email)
	if err != nil {
		return User{}, Device{}, "", err
	}
	var user User
	err = tx.QueryRow(ctx, `SELECT id, email, created_at FROM users WHERE email = lower($1)`, email).Scan(&user.ID, &user.Email, &user.CreatedAt)
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

func (s *PostgresStore) CreatePairing(ctx context.Context, agentID string, name string, ttl time.Duration) (Pairing, error) {
	if _, err := s.UpsertAgent(ctx, agentID, name); err != nil {
		return Pairing{}, err
	}
	code := RandomCode(8)
	agentToken := "brio_agent_" + RandomCode(48)
	var p Pairing
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Pairing{}, err
	}
	defer tx.Rollback(ctx)
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

func (s *PostgresStore) UserCanAccessAgent(ctx context.Context, userID string, agentID string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agents WHERE id = $1 AND owner_user_id = $2)`, agentID, userID).Scan(&ok)
	return ok, err
}
