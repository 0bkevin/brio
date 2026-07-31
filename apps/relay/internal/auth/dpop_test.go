package auth

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/brio/brio/apps/relay/internal/store"
	"github.com/brio/brio/packages/connectauth"
)

func TestDPoPProofBindsMethodURLTokenAndRejectsReplay(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC().Truncate(time.Second)
	key, _ := connectauth.GeneratePrivateKey()
	target := "https://relay.example/v1/environments/env-1/connect"
	accessToken := "relay-token"
	proof, err := connectauth.Sign(key, "dpop+jwt", map[string]any{
		"htm": http.MethodPost,
		"htu": target,
		"iat": now.Unix(),
		"jti": "proof-1",
		"ath": connectauth.HashToken(accessToken),
	})
	if err != nil {
		t.Fatal(err)
	}
	replays := store.NewMemoryStore()
	result, err := VerifyAndConsumeDPoP(context.Background(), replays, proof, http.MethodPost, target, "", accessToken, now)
	if err != nil || result.Thumbprint == "" {
		t.Fatalf("expected valid proof: result=%+v err=%v", result, err)
	}
	if _, err := VerifyAndConsumeDPoP(context.Background(), replays, proof, http.MethodPost, target, "", accessToken, now); !errors.Is(err, ErrInvalidDPoPProof) {
		t.Fatalf("expected replay rejection, got %v", err)
	}
}

func TestTokenEndpointDPoPRejectsUnexpectedAccessTokenHash(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC().Truncate(time.Second)
	key, _ := connectauth.GeneratePrivateKey()
	target := "https://relay.example/v1/client/dpop-token"
	proof, _ := connectauth.Sign(key, "dpop+jwt", map[string]any{
		"htm": http.MethodPost,
		"htu": target,
		"iat": now.Unix(),
		"jti": "proof-2",
		"ath": connectauth.HashToken("not-valid-at-a-token-endpoint"),
	})
	if _, err := VerifyAndConsumeDPoP(context.Background(), store.NewMemoryStore(), proof, http.MethodPost, target, "", "", now); !errors.Is(err, ErrInvalidDPoPProof) {
		t.Fatalf("expected unexpected ath rejection, got %v", err)
	}
}
