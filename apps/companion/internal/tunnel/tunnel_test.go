package tunnel

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestPairingCodeRoundTrip(t *testing.T) {
	payload := PairingPayload{
		URL:       "https://relay.example",
		Token:     "secret",
		Mode:      "relay",
		Transport: "relay",
		AgentID:   "agent_123",
		Code:      "ABCDEFGH",
	}

	encoded := PairingCode(payload)
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode pairing code: %v", err)
	}

	var decoded PairingPayload
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal pairing code: %v", err)
	}

	if decoded != payload {
		t.Fatalf("decoded payload mismatch: got %+v want %+v", decoded, payload)
	}
}

func TestTunnelURL(t *testing.T) {
	got, err := tunnelURL("https://relay.example/base/", "mobile", "agent 123", "relaytoken")
	if err != nil {
		t.Fatalf("tunnelURL returned error: %v", err)
	}

	want := "wss://relay.example/base/tunnel/mobile/agent%20123?token=relaytoken"
	if got != want {
		t.Fatalf("unexpected tunnel URL: got %q want %q", got, want)
	}
}
