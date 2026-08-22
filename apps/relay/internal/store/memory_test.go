package store

import (
	"context"
	"testing"
	"time"
)

func TestMemoryStoreCreatePairingRequiresExistingCompanionTokenForClaimedAgent(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()

	firstPairing, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, "")
	if err != nil {
		t.Fatalf("first pairing: %v", err)
	}

	user, _, _, err := s.CreateDeviceToken(ctx, "owner@example.com", "Phone")
	if err != nil {
		t.Fatalf("create device token: %v", err)
	}

	if _, err := s.ClaimPairing(ctx, firstPairing.Code, user.ID); err != nil {
		t.Fatalf("claim pairing: %v", err)
	}

	if _, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, ""); err != ErrUnauthorized {
		t.Fatalf("expected unauthorized without companion token, got %v", err)
	}

	if _, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, "wrong-token"); err != ErrUnauthorized {
		t.Fatalf("expected unauthorized with wrong companion token, got %v", err)
	}

	nextPairing, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, firstPairing.AgentToken)
	if err != nil {
		t.Fatalf("pairing with existing companion token: %v", err)
	}
	if nextPairing.AgentToken == firstPairing.AgentToken {
		t.Fatal("expected rotated companion token")
	}
}

func TestMemoryStoreUpsertAgentMatchesPersistentOnlineState(t *testing.T) {
	s := NewMemoryStore()
	agent, err := s.UpsertAgent(context.Background(), "agent-1", "Studio Hermes")
	if err != nil {
		t.Fatalf("upsert agent: %v", err)
	}
	if agent.Status != "online" || agent.LastSeenAt == nil {
		t.Fatalf("unexpected upserted agent state: %+v", agent)
	}
}

func TestMemoryStoreCreatePairingRequiresTokenForExistingUnclaimedAgent(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()

	first, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, "")
	if err != nil {
		t.Fatalf("first pairing: %v", err)
	}
	if _, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, ""); err != ErrUnauthorized {
		t.Fatalf("expected unauthorized tokenless rotation, got %v", err)
	}
	if _, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, "wrong-token"); err != ErrUnauthorized {
		t.Fatalf("expected unauthorized rotation with wrong token, got %v", err)
	}
	if _, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, first.AgentToken); err != nil {
		t.Fatalf("rotate pairing with current token: %v", err)
	}
}

func TestMemoryStoreListAndRevokeDevices(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()

	user, firstDevice, _, err := s.CreateDeviceToken(ctx, "owner@example.com", "Phone")
	if err != nil {
		t.Fatalf("create first device: %v", err)
	}
	if _, _, _, err := s.CreateDeviceToken(ctx, "owner@example.com", "Tablet"); err != nil {
		t.Fatalf("create second device: %v", err)
	}

	devices, err := s.ListDevices(ctx, user.ID)
	if err != nil {
		t.Fatalf("list devices: %v", err)
	}
	if len(devices) != 2 {
		t.Fatalf("expected 2 devices, got %d", len(devices))
	}

	revoked, err := s.RevokeDevice(ctx, user.ID, firstDevice.ID)
	if err != nil {
		t.Fatalf("revoke device: %v", err)
	}
	if revoked.RevokedAt == nil {
		t.Fatal("expected revoked_at to be set")
	}
}

func TestMemoryStoreRecoverPairingRequiresOwner(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()

	initialPairing, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, "")
	if err != nil {
		t.Fatalf("initial pairing: %v", err)
	}
	user, _, _, err := s.CreateDeviceToken(ctx, "owner@example.com", "Phone")
	if err != nil {
		t.Fatalf("create owner device: %v", err)
	}
	if _, err := s.ClaimPairing(ctx, initialPairing.Code, user.ID); err != nil {
		t.Fatalf("claim pairing: %v", err)
	}

	recovered, err := s.RecoverPairing(ctx, user.ID, "agent-1", "Recovered Hermes", time.Minute)
	if err != nil {
		t.Fatalf("recover pairing: %v", err)
	}
	if recovered.Name != "Recovered Hermes" {
		t.Fatalf("unexpected pairing name %q", recovered.Name)
	}
	if recovered.AgentToken == "" || recovered.Code == "" {
		t.Fatal("expected recovery to issue a new code and companion token")
	}

	otherUser, _, _, err := s.CreateDeviceToken(ctx, "other@example.com", "Tablet")
	if err != nil {
		t.Fatalf("create other user device: %v", err)
	}
	if _, err := s.RecoverPairing(ctx, otherUser.ID, "agent-1", "", time.Minute); err != ErrUnauthorized {
		t.Fatalf("expected unauthorized recovery for other user, got %v", err)
	}
}

func TestMemoryStoreClaimPairingDoesNotTransferOwnedAgent(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()

	initialPairing, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, "")
	if err != nil {
		t.Fatalf("initial pairing: %v", err)
	}
	owner, _, _, err := s.CreateDeviceToken(ctx, "owner@example.com", "Phone")
	if err != nil {
		t.Fatalf("create owner device: %v", err)
	}
	if _, err := s.ClaimPairing(ctx, initialPairing.Code, owner.ID); err != nil {
		t.Fatalf("claim initial pairing: %v", err)
	}

	nextPairing, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, initialPairing.AgentToken)
	if err != nil {
		t.Fatalf("create pairing with companion token: %v", err)
	}
	other, _, _, err := s.CreateDeviceToken(ctx, "other@example.com", "Tablet")
	if err != nil {
		t.Fatalf("create other device: %v", err)
	}

	if _, err := s.ClaimPairing(ctx, nextPairing.Code, other.ID); err != ErrUnauthorized {
		t.Fatalf("expected unauthorized claim by non-owner, got %v", err)
	}
	if _, err := s.ClaimPairing(ctx, nextPairing.Code, owner.ID); err != nil {
		t.Fatalf("owner should still be able to claim pairing after unauthorized attempt: %v", err)
	}
}

func TestMemoryStoreRecoverPairingDoesNotMarkAgentOnline(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()

	initialPairing, err := s.CreatePairing(ctx, "agent-1", "Hermes", time.Minute, "")
	if err != nil {
		t.Fatalf("initial pairing: %v", err)
	}
	owner, _, _, err := s.CreateDeviceToken(ctx, "owner@example.com", "Phone")
	if err != nil {
		t.Fatalf("create owner device: %v", err)
	}
	if _, err := s.ClaimPairing(ctx, initialPairing.Code, owner.ID); err != nil {
		t.Fatalf("claim initial pairing: %v", err)
	}
	if err := s.TouchAgent(ctx, "agent-1", "offline"); err != nil {
		t.Fatalf("touch offline: %v", err)
	}

	if _, err := s.RecoverPairing(ctx, owner.ID, "agent-1", "Recovered Hermes", time.Minute); err != nil {
		t.Fatalf("recover pairing: %v", err)
	}
	agents, err := s.ListAgents(ctx, owner.ID)
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(agents))
	}
	if agents[0].Status != "offline" {
		t.Fatalf("status after recovery = %q, want offline", agents[0].Status)
	}
	if agents[0].Name != "Recovered Hermes" {
		t.Fatalf("name after recovery = %q, want Recovered Hermes", agents[0].Name)
	}
}

func TestMemoryStoreEnrollmentLifecycle(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()

	user, _, _, err := s.CreateDeviceToken(ctx, "owner@example.com", "Phone")
	if err != nil {
		t.Fatalf("create device token: %v", err)
	}

	enrollment, err := s.CreateEnrollment(ctx, user.ID, "Studio Hermes", time.Minute)
	if err != nil {
		t.Fatalf("create enrollment: %v", err)
	}

	agent, relayToken, err := s.ClaimEnrollment(ctx, enrollment.Code, "agent-1", "")
	if err != nil {
		t.Fatalf("claim enrollment: %v", err)
	}
	if relayToken == "" {
		t.Fatal("expected relay token")
	}
	if agent.Name != "Studio Hermes" {
		t.Fatalf("agent name = %q", agent.Name)
	}
	if agent.Status != "offline" {
		t.Fatalf("agent status = %q, want offline until companion tunnel connects", agent.Status)
	}
	if agent.LastSeenAt != nil {
		t.Fatalf("last_seen_at = %v, want nil until companion tunnel connects", agent.LastSeenAt)
	}
	if agent.OwnerUserID == nil || *agent.OwnerUserID != user.ID {
		t.Fatalf("unexpected owner: %+v", agent.OwnerUserID)
	}

	if _, _, err := s.ClaimEnrollment(ctx, enrollment.Code, "agent-1", ""); err != ErrUsed {
		t.Fatalf("expected used enrollment, got %v", err)
	}
}
