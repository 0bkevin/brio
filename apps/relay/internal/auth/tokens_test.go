package auth

import (
	"testing"
	"time"

	"github.com/brio/brio/packages/connectauth"
)

func TestRelayTokenEnforcesClientScopeAndProofKey(t *testing.T) {
	t.Parallel()
	key, _ := connectauth.GeneratePrivateKey()
	now := time.Now().UTC().Truncate(time.Second)
	manager := NewTokenManager("https://relay.example", key)
	token, err := manager.Issue(
		"user-1",
		MobileClientID,
		[]string{ScopeEnvironmentConnect, ScopeMobileRegistration},
		"proof-thumbprint",
		now,
		"token-1",
	)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := manager.Verify(token, now)
	if err != nil {
		t.Fatal(err)
	}
	if claims.UserID != "user-1" || claims.Thumbprint != "proof-thumbprint" || !HasScope(claims.Scopes, ScopeMobileRegistration) {
		t.Fatalf("unexpected claims: %+v", claims)
	}
	if _, err := manager.Issue("user-1", WebClientID, []string{ScopeMobileRegistration}, "proof-thumbprint", now, "token-2"); err == nil {
		t.Fatal("expected web client to be denied mobile registration scope")
	}
}
