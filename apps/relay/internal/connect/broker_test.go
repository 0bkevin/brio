package connect

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/brio/brio/apps/relay/internal/store"
	"github.com/brio/brio/packages/connectauth"
)

func TestBrokerLinksChecksStatusAndMintsCredential(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemoryStore()
	user, _, _, err := st.CreateDeviceToken(ctx, "owner@example.com", "phone")
	if err != nil {
		t.Fatal(err)
	}
	enrollment, err := st.CreateEnrollment(ctx, user.ID, "Hermes", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	broker, err := New(Config{Issuer: "http://relay.test"}, st)
	if err != nil {
		t.Fatal(err)
	}
	environmentKey, err := connectauth.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}

	var environmentID = "agent-test"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Proof string `json:"proof"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		_, claims, err := connectauth.DecodeUnverified(request.Proof)
		if err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		now := time.Now().UTC().Truncate(time.Second)
		common := map[string]any{
			"iss": "brio-env:" + environmentID, "aud": broker.Issuer(), "sub": environmentID,
			"jti": mustToken(18), "iat": now.Unix(), "exp": now.Add(time.Minute).Unix(),
			"environment_id": environmentID, "request_nonce": connectauth.StringClaim(claims, "nonce"),
		}
		switch r.URL.Path {
		case "/api/brio-connect/mint-credential":
			credential := "bootstrap-test"
			common["credential"] = credential
			common["client_proof_key_thumbprint"] = connectauth.StringClaim(claims, "client_proof_key_thumbprint")
			proof, _ := connectauth.Sign(environmentKey, MintResponseType, common)
			_ = json.NewEncoder(w).Encode(map[string]any{"credential": credential, "expires_at": now.Add(time.Minute), "proof": proof})
		case "/api/brio-connect/health":
			common["status"] = "online"
			common["checked_at"] = now.Format(time.RFC3339Nano)
			common["descriptor"] = map[string]any{"kind": "hermes"}
			proof, _ := connectauth.Sign(environmentKey, HealthResponseType, common)
			_ = json.NewEncoder(w).Encode(map[string]any{"environment_id": environmentID, "status": "online", "checked_at": now, "descriptor": common["descriptor"], "proof": proof})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	now := time.Now().UTC()
	linkProof, err := connectauth.Sign(environmentKey, LinkProofType, map[string]any{
		"iss": "brio-env:" + environmentID, "aud": broker.Issuer(), "sub": environmentID,
		"jti": mustToken(18), "iat": now.Unix(), "exp": now.Add(time.Minute).Unix(),
		"challenge": enrollment.Code, "environment_id": environmentID, "environment_name": "Hermes",
		"environment_public_key": connectauth.PublicJWK(&environmentKey.PublicKey),
		"endpoint":               store.ManagedEndpoint{HTTPBaseURL: server.URL, WSBaseURL: "ws" + server.URL[4:], ProviderKind: "manual"},
		"origin":                 map[string]any{"local_http_host": "127.0.0.1", "local_http_port": 8787},
	})
	if err != nil {
		t.Fatal(err)
	}
	verified, err := broker.VerifyEnrollmentProof(linkProof, enrollment.Code, environmentID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := st.ClaimEnrollment(ctx, enrollment.Code, environmentID, "Hermes", &verified.Link); err != nil {
		t.Fatal(err)
	}

	connected, err := broker.Connect(ctx, user.ID, environmentID, "client-thumbprint", "phone")
	if err != nil {
		t.Fatal(err)
	}
	if connected.Credential != "bootstrap-test" || connected.Endpoint.HTTPBaseURL != server.URL {
		t.Fatalf("unexpected connect response: %#v", connected)
	}
	status, err := broker.Status(ctx, user.ID, environmentID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "online" {
		t.Fatalf("status = %q", status.Status)
	}
}

func TestBrokerRejectsLinkOriginAndMissingClientKey(t *testing.T) {
	st := store.NewMemoryStore()
	broker, err := New(Config{Issuer: "https://relay.example"}, st)
	if err != nil {
		t.Fatal(err)
	}
	_, err = broker.Connect(context.Background(), "user", "agent", "", "")
	var connectErr *Error
	if !errors.As(err, &connectErr) || connectErr.Reason != "client_proof_key_thumbprint_missing" {
		t.Fatalf("unexpected error: %v", err)
	}
}
