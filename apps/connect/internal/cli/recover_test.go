package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRecoverRelayAgent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if got := r.URL.Path; got != "/agents/agent%201/recover" && got != "/agents/agent 1/recover" {
			t.Fatalf("path = %q, want /agents/agent 1/recover", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer owner-token" {
			t.Fatalf("authorization = %q, want Bearer owner-token", got)
		}
		_ = json.NewEncoder(w).Encode(recoveryResult{
			Code:       "PAIR1234",
			AgentToken: "relay-token",
			AgentID:    "agent 1",
			Name:       "Recovered Hermes",
		})
	}))
	defer server.Close()

	result, err := recoverRelayAgent(t.Context(), server.URL, "owner-token", "agent 1")
	if err != nil {
		t.Fatalf("recoverRelayAgent returned error: %v", err)
	}
	if result.AgentToken != "relay-token" {
		t.Fatalf("agent token = %q, want relay-token", result.AgentToken)
	}
}

func TestRecoverRelayAgentRejectsPlaintextRemoteRelayBeforeSendingToken(t *testing.T) {
	if _, err := recoverRelayAgent(t.Context(), "http://relay.example", "owner-token", "agent-1"); err == nil {
		t.Fatal("recoverRelayAgent accepted a plaintext remote relay URL")
	}
}

func TestRecoverCommandPersistsToken(t *testing.T) {
	home := t.TempDir()
	resetSetupEnv(t, home)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(recoveryResult{
			Code:       "PAIR1234",
			AgentToken: "relay-token",
			AgentID:    "agent-1",
			Name:       "Recovered Hermes",
		})
	}))
	defer server.Close()

	cmd := recoverCommand()
	cmd.SetArgs([]string{
		"--relay-url", server.URL,
		"--agent-id", "agent-1",
		"--device-token", "owner-token",
	})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("recover command returned error: %v", err)
	}

	values := readState()
	if values[stateKeyRelayToken] != "relay-token" {
		t.Fatalf("BRIO_RELAY_TOKEN = %q, want relay-token", values[stateKeyRelayToken])
	}
	if values[stateKeyAgentID] != "agent-1" {
		t.Fatalf("BRIO_AGENT_ID = %q, want agent-1", values[stateKeyAgentID])
	}
	if values[stateKeyRelayURL] != server.URL {
		t.Fatalf("BRIO_RELAY_URL = %q, want %q", values[stateKeyRelayURL], server.URL)
	}
	if values[stateKeyHermesBase] != "http://127.0.0.1:8642" {
		t.Fatalf("HERMES_API_BASE = %q, want the default", values[stateKeyHermesBase])
	}
}

func TestRecoverCommandRequiresDeviceToken(t *testing.T) {
	resetSetupEnv(t, t.TempDir())
	cmd := recoverCommand()
	cmd.SetArgs([]string{
		"--relay-url", "https://relay.example",
		"--agent-id", "agent-1",
	})
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "device token is required") {
		t.Fatalf("expected device token error, got %v", err)
	}
}

func TestRecoverCommandRejectsMissingAgentID(t *testing.T) {
	resetSetupEnv(t, t.TempDir())
	cmd := recoverCommand()
	cmd.SetArgs([]string{
		"--relay-url", "https://relay.example",
		"--device-token", "owner-token",
	})
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "agent id is required") {
		t.Fatalf("expected agent id error, got %v", err)
	}
}

func TestRecoverCommandPropagatesRelayFailure(t *testing.T) {
	resetSetupEnv(t, t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"device cannot access agent"}`, http.StatusForbidden)
	}))
	defer server.Close()

	cmd := recoverCommand()
	cmd.SetArgs([]string{
		"--relay-url", server.URL,
		"--agent-id", "agent-1",
		"--device-token", "wrong-owner",
	})
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "device cannot access agent") {
		t.Fatalf("expected relay failure, got %v", err)
	}
	if values := readState(); values[stateKeyRelayToken] != "" {
		t.Fatalf("state was written despite failure: %v", values)
	}
}
