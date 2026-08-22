package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteAndReadStateRoundTrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	values := map[string]string{
		stateKeyRelayURL:   "https://relay.example",
		stateKeyRelayToken: "relay-token",
		stateKeyAgentID:    "hermes_abc",
		stateKeyHermesBase: "http://127.0.0.1:8642",
		stateKeyHermesKey:  "hermes-key",
	}
	if err := writeState(values); err != nil {
		t.Fatalf("writeState: %v", err)
	}

	got := readState()
	for key, want := range values {
		if got[key] != want {
			t.Fatalf("state[%q] = %q, want %q", key, got[key], want)
		}
	}

	info, err := os.Stat(filepath.Join(home, ".brio", stateFileName))
	if err != nil {
		t.Fatalf("state file missing: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("state permissions = %o, want 600", perm)
	}
	dirInfo, err := os.Stat(filepath.Join(home, ".brio"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Fatalf("state directory permissions = %o, want 700", perm)
	}
}

func TestWriteStateRepairsPrivatePermissions(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".brio")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, stateFileName)
	if err := os.WriteFile(path, []byte("BRIO_AGENT_ID=old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeState(map[string]string{stateKeyAgentID: "hermes_new"}); err != nil {
		t.Fatalf("writeState: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("state permissions = %o, want 600", got)
	}
	if readState()[stateKeyAgentID] != "hermes_new" {
		t.Fatalf("state was not rewritten")
	}
}

func TestReadStateMissingFileIsEmpty(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if values := readState(); len(values) != 0 {
		t.Fatalf("readState = %v, want empty", values)
	}
}
