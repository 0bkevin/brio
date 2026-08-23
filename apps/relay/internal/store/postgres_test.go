package store

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresMigrationPreservesLegacyEmailPrincipal(t *testing.T) {
	databaseURL := os.Getenv("BRIO_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BRIO_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)

	schema := "legacy_" + strings.ToLower(RandomCode(12))
	if _, err := admin.Exec(ctx, fmt.Sprintf(`
CREATE SCHEMA %s;
CREATE TABLE %s.users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE %s.devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES %s.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE TABLE %s.agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES %s.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'self_hosted',
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO %s.users (id, email) VALUES ('usr_legacy', 'owner@example.com');
INSERT INTO %s.agents (id, owner_user_id, name) VALUES ('agent_legacy', 'usr_legacy', 'Legacy Hermes');
`, schema, schema, schema, schema, schema, schema, schema, schema)); err != nil {
		t.Fatalf("create legacy schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), fmt.Sprintf("DROP SCHEMA IF EXISTS %s CASCADE", schema))
	})

	parsedURL, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsedURL.Query()
	query.Set("search_path", schema)
	parsedURL.RawQuery = query.Encode()
	s, err := NewPostgresStore(ctx, parsedURL.String())
	if err != nil {
		t.Fatalf("migrate legacy store: %v", err)
	}
	defer s.Close()
	if err := s.migrate(ctx); err != nil {
		t.Fatalf("rerun recorded migrations: %v", err)
	}
	var appliedMigrations int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM brio_schema_migrations`).Scan(&appliedMigrations); err != nil {
		t.Fatalf("read migration ledger: %v", err)
	}
	if appliedMigrations != len(postgresMigrations) {
		t.Fatalf("applied migrations = %d, want %d", appliedMigrations, len(postgresMigrations))
	}

	user, _, _, err := s.CreateDeviceToken(ctx, "OWNER@example.com", "Migrated phone")
	if err != nil {
		t.Fatalf("create device for legacy principal: %v", err)
	}
	if user.ID != "usr_legacy" {
		t.Fatalf("device registration created principal %q, want preserved usr_legacy", user.ID)
	}
	agents, err := s.ListAgents(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 || agents[0].ID != "agent_legacy" {
		t.Fatalf("legacy agent ownership was stranded after migration: %+v", agents)
	}
}

func TestPostgresStoreControlPlaneAndPairingParity(t *testing.T) {
	databaseURL := os.Getenv("BRIO_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BRIO_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	s, err := NewPostgresStore(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open Postgres store: %v", err)
	}
	t.Cleanup(s.Close)

	suffix := strings.ToLower(RandomCode(12))
	verified, err := s.UpsertIdentity(ctx, "https://clerk.example/", "user-"+suffix, "Verified-"+suffix+"@Example.com")
	if err != nil {
		t.Fatalf("upsert verified identity: %v", err)
	}
	verifiedAgain, err := s.UpsertIdentity(ctx, "https://clerk.example", "user-"+suffix, "updated-"+suffix+"@example.com")
	if err != nil {
		t.Fatalf("update verified identity: %v", err)
	}
	if verifiedAgain.ID != verified.ID || verifiedAgain.Email != "updated-"+suffix+"@example.com" {
		t.Fatalf("verified identity was not stable: first=%+v updated=%+v", verified, verifiedAgain)
	}
	verifiedUser, verifiedDevice, verifiedToken, err := s.CreateDeviceTokenForUser(ctx, verified.ID, "Verified phone")
	if err != nil {
		t.Fatalf("create verified device: %v", err)
	}
	if verifiedUser.ID != verified.ID || verifiedDevice.UserID != verified.ID || verifiedToken == "" {
		t.Fatalf("unexpected verified device: user=%+v device=%+v token_empty=%v", verifiedUser, verifiedDevice, verifiedToken == "")
	}
	user, _, deviceToken, err := s.CreateDeviceToken(ctx, "  Owner-"+suffix+"@Example.com  ", "Phone")
	if err != nil {
		t.Fatalf("create device: %v", err)
	}
	if user.Email != "owner-"+suffix+"@example.com" {
		t.Fatalf("normalized email = %q", user.Email)
	}
	if !strings.HasPrefix(deviceToken, "brio_dev_") {
		t.Fatalf("device token prefix = %q", deviceToken)
	}

	enrollment, err := s.CreateEnrollment(ctx, user.ID, "Studio Hermes", time.Minute)
	if err != nil {
		t.Fatalf("create enrollment: %v", err)
	}
	agentID := "agent-enrolled-" + suffix
	agent, companionToken, err := s.ClaimEnrollment(ctx, strings.ToLower(enrollment.Code), agentID, "")
	if err != nil {
		t.Fatalf("claim normalized enrollment code: %v", err)
	}
	if agent.Status != "offline" || agent.LastSeenAt != nil || companionToken == "" {
		t.Fatalf("unexpected enrolled agent state: %+v, token empty=%v", agent, companionToken == "")
	}
	if err := s.AuthenticateCompanion(ctx, agentID, ""); err != ErrUnauthorized {
		t.Fatalf("empty companion token error = %v, want unauthorized", err)
	}

	pairingAgentID := "agent-pairing-" + suffix
	first, err := s.CreatePairing(ctx, pairingAgentID, "Hermes", time.Minute, "")
	if err != nil {
		t.Fatalf("create initial pairing: %v", err)
	}
	if _, err := s.CreatePairing(ctx, pairingAgentID, "Hermes", time.Minute, ""); err != ErrUnauthorized {
		t.Fatalf("tokenless pairing rotation error = %v, want unauthorized", err)
	}
	if _, err := s.GetPairing(ctx, strings.ToLower(first.Code)); err != nil {
		t.Fatalf("get normalized pairing code: %v", err)
	}
	claimed, err := s.ClaimPairing(ctx, strings.ToLower(first.Code), user.ID)
	if err != nil {
		t.Fatalf("claim normalized pairing code: %v", err)
	}
	if claimed.OwnerUserID == nil || *claimed.OwnerUserID != user.ID {
		t.Fatalf("unexpected pairing owner: %+v", claimed.OwnerUserID)
	}
	if claimed.Status != "offline" || claimed.LastSeenAt != nil {
		t.Fatalf("pairing claim marked agent online before tunnel connection: %+v", claimed)
	}

	unlinked, err := s.UnlinkAgent(ctx, user.ID, agentID)
	if err != nil {
		t.Fatalf("unlink enrolled agent: %v", err)
	}
	if unlinked.ID != agentID {
		t.Fatalf("unexpected unlinked agent: %+v", unlinked)
	}
	if err := s.AuthenticateCompanion(ctx, agentID, companionToken); err != ErrUnauthorized {
		t.Fatalf("unlinked companion credential error = %v, want unauthorized", err)
	}
	if allowed, err := s.UserCanAccessAgent(ctx, user.ID, agentID); err != nil || allowed {
		t.Fatalf("unlinked agent access = %v, err = %v", allowed, err)
	}
}
