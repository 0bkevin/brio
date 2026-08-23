package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"testing"
	"time"
)

func TestClerkVerifierRequiresExactIssuerAudienceAndAuthorizedParty(t *testing.T) {
	t.Parallel()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewClerkVerifier(ClerkConfig{
		JWTKey:            string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicKey})),
		Issuer:            "https://clerk.example/",
		Audience:          "brio-relay",
		AuthorizedParties: []string{"https://app.example"},
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	baseClaims := map[string]any{
		"iss":   "https://clerk.example",
		"sub":   "user_123",
		"sid":   "session_123",
		"aud":   []string{"brio-relay"},
		"azp":   "https://app.example",
		"email": "Owner@Example.com",
		"iat":   now.Unix(),
		"nbf":   now.Add(-time.Second).Unix(),
		"exp":   now.Add(5 * time.Minute).Unix(),
	}

	token := signTestJWT(t, privateKey, baseClaims)
	identity, err := verifier.Verify(context.Background(), token)
	if err != nil {
		t.Fatalf("verify valid token: %v", err)
	}
	if identity.Issuer != "https://clerk.example" || identity.Subject != "user_123" || identity.SessionID != "session_123" {
		t.Fatalf("unexpected identity: %+v", identity)
	}
	if identity.Email != "owner@example.com" {
		t.Fatalf("normalized email = %q", identity.Email)
	}

	for name, mutate := range map[string]func(map[string]any){
		"issuer":           func(claims map[string]any) { claims["iss"] = "https://attacker.example" },
		"audience":         func(claims map[string]any) { claims["aud"] = []string{"other-service"} },
		"authorized party": func(claims map[string]any) { claims["azp"] = "https://attacker.example" },
	} {
		t.Run(name, func(t *testing.T) {
			claims := cloneClaims(t, baseClaims)
			mutate(claims)
			_, err := verifier.Verify(context.Background(), signTestJWT(t, privateKey, claims))
			if !errors.Is(err, ErrInvalidIdentityToken) {
				t.Fatalf("verification error = %v, want invalid identity token", err)
			}
		})
	}
}

func TestNewClerkVerifierRejectsIncompleteConfiguration(t *testing.T) {
	t.Parallel()
	if _, err := NewClerkVerifier(ClerkConfig{SecretKey: "secret", Issuer: "https://clerk.example"}); err == nil {
		t.Fatal("missing audience was accepted")
	}
	if _, err := NewClerkVerifier(ClerkConfig{SecretKey: "secret", Audience: "brio-relay"}); err == nil {
		t.Fatal("missing issuer was accepted")
	}
}

func signTestJWT(t *testing.T, privateKey *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "RS256", "kid": "test-key", "typ": "JWT"})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(encoded))
	signature, err := rsa.SignPKCS1v15(rand.Reader, privateKey, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return encoded + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func cloneClaims(t *testing.T, claims map[string]any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	var cloned map[string]any
	if err := json.Unmarshal(encoded, &cloned); err != nil {
		t.Fatal(err)
	}
	return cloned
}
