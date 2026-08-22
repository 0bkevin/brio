package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureHermesAPIConfigPreservesExistingValues(t *testing.T) {
	home := t.TempDir()
	envPath := filepath.Join(home, ".env")
	if err := os.WriteFile(envPath, []byte("EXISTING=value\n# keep this\nAPI_SERVER_KEY=existing-key\n"), 0o600); err != nil {
		t.Fatalf("write env: %v", err)
	}

	apiKey, err := ensureHermesAPIConfig(home, "http://127.0.0.1:8642", "")
	if err != nil {
		t.Fatalf("ensureHermesAPIConfig returned error: %v", err)
	}
	if apiKey != "existing-key" {
		t.Fatalf("api key = %q, want existing-key", apiKey)
	}

	values, err := readDotEnvValues(envPath)
	if err != nil {
		t.Fatalf("read env: %v", err)
	}
	if values["EXISTING"] != "value" {
		t.Fatalf("EXISTING = %q, want value", values["EXISTING"])
	}
	if values["API_SERVER_ENABLED"] != "true" {
		t.Fatalf("API_SERVER_ENABLED = %q, want true", values["API_SERVER_ENABLED"])
	}
	if values["API_SERVER_HOST"] != "127.0.0.1" {
		t.Fatalf("API_SERVER_HOST = %q, want 127.0.0.1", values["API_SERVER_HOST"])
	}
	if values["API_SERVER_PORT"] != "8642" {
		t.Fatalf("API_SERVER_PORT = %q, want 8642", values["API_SERVER_PORT"])
	}
	if values["API_SERVER_KEY"] != "existing-key" {
		t.Fatalf("API_SERVER_KEY = %q, want existing-key", values["API_SERVER_KEY"])
	}
	data, _ := os.ReadFile(envPath)
	if !containsLine(string(data), "# keep this") {
		t.Fatalf("expected comment to be preserved, got:\n%s", string(data))
	}
}

func TestEnsureHermesAPIConfigGeneratesAPIKey(t *testing.T) {
	home := t.TempDir()

	apiKey, err := ensureHermesAPIConfig(home, "http://127.0.0.1:8642", "")
	if err != nil {
		t.Fatalf("ensureHermesAPIConfig returned error: %v", err)
	}
	if apiKey == "" {
		t.Fatal("expected generated API key")
	}
	values, err := readDotEnvValues(filepath.Join(home, ".env"))
	if err != nil {
		t.Fatalf("read env: %v", err)
	}
	if values["API_SERVER_KEY"] != apiKey {
		t.Fatalf("API_SERVER_KEY = %q, want generated key", values["API_SERVER_KEY"])
	}
}

func TestSetupClaimsEnrollmentAndPersistsState(t *testing.T) {
	home := t.TempDir()
	hermesHome := filepath.Join(home, ".hermes")
	resetSetupEnv(t, home)

	hermes := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Errorf("Hermes path = %q, want /health", r.URL.Path)
		}
		if r.Header.Get("Authorization") == "" {
			t.Error("expected Hermes health check authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	}))
	defer hermes.Close()

	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/enrollments/SETUP123/claim" {
			t.Fatalf("relay path = %q, want /enrollments/SETUP123/claim", r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if !strings.HasPrefix(body["agent_id"], "hermes_") {
			t.Fatalf("agent_id = %q, want a hermes_ prefix", body["agent_id"])
		}
		if body["name"] != "Studio Hermes" {
			t.Fatalf("name = %q, want Studio Hermes", body["name"])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"agent":       map[string]string{"id": body["agent_id"], "name": body["name"]},
			"relay_token": "relay-token",
		})
	}))
	defer relay.Close()

	cmd := setupCommand()
	cmd.SetArgs([]string{
		"--relay-url", relay.URL,
		"--code", "setup123",
		"--name", "Studio Hermes",
		"--hermes-url", hermes.URL,
		"--hermes-home", hermesHome,
		"--install=false",
		"--start=false",
	})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("setup command returned error: %v", err)
	}

	values := readState()
	if values[stateKeyRelayToken] != "relay-token" {
		t.Fatalf("BRIO_RELAY_TOKEN = %q, want relay-token", values[stateKeyRelayToken])
	}
	if !strings.HasPrefix(values[stateKeyAgentID], "hermes_") {
		t.Fatalf("BRIO_AGENT_ID = %q, want a hermes_ prefix", values[stateKeyAgentID])
	}
	if values[stateKeyRelayURL] != relay.URL {
		t.Fatalf("BRIO_RELAY_URL = %q, want %q", values[stateKeyRelayURL], relay.URL)
	}
	if values[stateKeyHermesBase] != hermes.URL {
		t.Fatalf("HERMES_API_BASE = %q, want %q", values[stateKeyHermesBase], hermes.URL)
	}
	if values[stateKeyHermesKey] == "" {
		t.Fatal("expected setup to write HERMES_API_KEY")
	}

	envValues, err := readDotEnvValues(filepath.Join(hermesHome, ".env"))
	if err != nil {
		t.Fatalf("read hermes env: %v", err)
	}
	if envValues["API_SERVER_ENABLED"] != "true" {
		t.Fatalf("API_SERVER_ENABLED = %q, want true", envValues["API_SERVER_ENABLED"])
	}
	if envValues["API_SERVER_KEY"] != values[stateKeyHermesKey] {
		t.Fatalf("state and .env API keys disagree: %q vs %q", values[stateKeyHermesKey], envValues["API_SERVER_KEY"])
	}
}

func TestSetupSucceedsWhenHermesHealthIsDown(t *testing.T) {
	home := t.TempDir()
	resetSetupEnv(t, home)

	hermes := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer hermes.Close()

	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"agent":       map[string]string{"id": "hermes_degraded", "name": "Hermes"},
			"relay_token": "relay-token",
		})
	}))
	defer relay.Close()

	cmd := setupCommand()
	cmd.SetArgs([]string{
		"--relay-url", relay.URL,
		"--code", "DEGRADED",
		"--hermes-url", hermes.URL,
		"--hermes-home", filepath.Join(home, ".hermes"),
		"--install=false",
		"--start=false",
	})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("setup command returned error: %v", err)
	}

	values := readState()
	if values[stateKeyAgentID] != "hermes_degraded" {
		t.Fatalf("BRIO_AGENT_ID = %q, want hermes_degraded", values[stateKeyAgentID])
	}
}

func TestSetupRejectsExpiredCode(t *testing.T) {
	home := t.TempDir()
	resetSetupEnv(t, home)

	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"enrollment code is expired"}`, http.StatusNotFound)
	}))
	defer relay.Close()

	cmd := setupCommand()
	cmd.SetArgs([]string{
		"--relay-url", relay.URL,
		"--code", "EXPIRED1",
		"--hermes-home", filepath.Join(home, ".hermes"),
		"--install=false",
		"--start=false",
	})
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), setupErrEnrollmentExpired) {
		t.Fatalf("expected %s error, got %v", setupErrEnrollmentExpired, err)
	}
}

func resetSetupEnv(t *testing.T, home string) {
	t.Helper()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())
	for _, key := range []string{
		"BRIO_RELAY_URL",
		"BRIO_RELAY_TOKEN",
		"BRIO_AGENT_ID",
		"HERMES_API_BASE",
		"HERMES_API_KEY",
		"HERMES_HOME",
	} {
		t.Setenv(key, "")
	}
}

func containsLine(value string, line string) bool {
	for _, current := range strings.Split(value, "\n") {
		if current == line {
			return true
		}
	}
	return false
}
