package connectauth

import (
	"testing"
	"time"
)

func TestSignVerifyAndKeyRoundTrip(t *testing.T) {
	key, err := GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodePrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	key, err = DecodePrivateKey(encoded)
	if err != nil {
		t.Fatal(err)
	}
	jwk := PublicJWK(&key.PublicKey)
	if _, err := Thumbprint(jwk); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	token, err := Sign(key, "brio-test+jwt", map[string]any{
		"iss": "issuer", "aud": "audience", "sub": "subject", "jti": "nonce",
		"iat": now.Unix(), "exp": now.Add(time.Minute).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	verified, err := Verify(token, &key.PublicKey, "brio-test+jwt", "issuer", "audience", now)
	if err != nil {
		t.Fatal(err)
	}
	if StringClaim(verified.Claims, "sub") != "subject" {
		t.Fatalf("subject = %q", StringClaim(verified.Claims, "sub"))
	}
}

func TestVerifyRejectsExpiredAndWrongAudience(t *testing.T) {
	key, _ := GeneratePrivateKey()
	now := time.Now().UTC().Truncate(time.Second)
	token, _ := Sign(key, "brio-test+jwt", map[string]any{
		"iss": "issuer", "aud": "audience", "sub": "subject", "jti": "nonce",
		"iat": now.Add(-time.Minute).Unix(), "exp": now.Add(-time.Second).Unix(),
	})
	if _, err := Verify(token, &key.PublicKey, "brio-test+jwt", "issuer", "audience", now); err == nil {
		t.Fatal("expected expired token rejection")
	}
	token, _ = Sign(key, "brio-test+jwt", map[string]any{
		"iss": "issuer", "aud": "other", "sub": "subject", "jti": "nonce",
		"iat": now.Unix(), "exp": now.Add(time.Minute).Unix(),
	})
	if _, err := Verify(token, &key.PublicKey, "brio-test+jwt", "issuer", "audience", now); err == nil {
		t.Fatal("expected audience rejection")
	}
}

func TestParsePublicJWKRejectsPrivateMaterial(t *testing.T) {
	key, _ := GeneratePrivateKey()
	jwk := PublicJWK(&key.PublicKey)
	jwk.D = "private-key-material"
	if _, err := ParsePublicJWK(jwk); err == nil {
		t.Fatal("expected a DPoP header containing private key material to be rejected")
	}
}
