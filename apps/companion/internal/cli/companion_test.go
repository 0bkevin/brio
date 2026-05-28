package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRecoverRelayPairing(t *testing.T) {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if got := r.URL.Path; got != "/agents/agent%201/recover" && got != "/agents/agent 1/recover" {
			t.Fatalf("path = %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer owner-token" {
			t.Fatalf("authorization = %q", got)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["name"] != "Recovered Hermes" {
			t.Fatalf("name = %q", body["name"])
		}
		_ = json.NewEncoder(w).Encode(relayRecoveryResult{
			Code:       "PAIR1234",
			AgentToken: "relay-token",
			AgentID:    "agent 1",
			Name:       "Recovered Hermes",
		})
	}))
	defer server.Close()

	result, err := recoverRelayPairing(context.Background(), server.URL, "owner-token", "agent 1", "Recovered Hermes")
	if err != nil {
		t.Fatalf("recoverRelayPairing returned error: %v", err)
	}
	if result.Code != "PAIR1234" || result.AgentToken != "relay-token" {
		t.Fatalf("unexpected result: %+v", result)
	}
}
