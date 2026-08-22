package store

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

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
}
