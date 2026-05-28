package cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/brio/brio/apps/companion/internal/tunnel"
)

func TestWriteAndReadPairingStatePreservesRelayToken(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	payload := tunnel.PairingPayload{
		URL:       "https://relay.example",
		Token:     "mobile-token",
		Mode:      "relay",
		Transport: "relay",
		AgentID:   "agent-1",
		Code:      "PAIR1234",
	}

	if err := writePairingState(payload, "relay-token"); err != nil {
		t.Fatalf("write pairing state: %v", err)
	}

	state, err := readPairingState()
	if err != nil {
		t.Fatalf("read pairing state: %v", err)
	}
	if state.RelayToken != "relay-token" {
		t.Fatalf("relay token = %q, want relay-token", state.RelayToken)
	}
	if state.Payload.AgentID != payload.AgentID {
		t.Fatalf("agent id = %q, want %q", state.Payload.AgentID, payload.AgentID)
	}

	if _, err := os.Stat(filepath.Join(home, ".brio", pairingFileName)); err != nil {
		t.Fatalf("pairing file missing: %v", err)
	}
}
