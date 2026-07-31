package connect

import (
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/brio/brio/packages/connectauth"
)

func TestMintExchangeAndDPoPAuthenticatedRequest(t *testing.T) {
	relayKey, _ := connectauth.GeneratePrivateKey()
	environmentKey, _ := connectauth.GeneratePrivateKey()
	privatePEM, _ := connectauth.EncodePrivateKey(environmentKey)
	m, err := Open(t.TempDir() + "/connect.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Configure(State{
		EnvironmentID: "agent-test", EnvironmentName: "Hermes", PrivateKeyPEM: privatePEM,
		RelayIssuer: "https://relay.example", RelayPublicKey: connectauth.PublicJWK(&relayKey.PublicKey),
		CloudUserID: "user-test", EnvironmentCredential: "env-secret",
		Endpoint: Endpoint{HTTPBaseURL: "https://agent.example", WSBaseURL: "wss://agent.example", ProviderKind: "manual"},
		LinkedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	clientKey, _ := connectauth.GeneratePrivateKey()
	clientJWK := connectauth.PublicJWK(&clientKey.PublicKey)
	thumbprint, _ := connectauth.Thumbprint(clientJWK)
	now := time.Now().UTC().Truncate(time.Second)
	mintProof, _ := connectauth.Sign(relayKey, MintRequestType, map[string]any{
		"iss": "https://relay.example", "aud": "brio-env:agent-test", "sub": "agent-test",
		"jti": "relay-proof-1", "iat": now.Unix(), "exp": now.Add(time.Minute).Unix(),
		"environment_id": "agent-test", "cloud_user_id": "user-test", "nonce": "request-nonce",
		"scope": "environment:connect", "client_proof_key_thumbprint": thumbprint,
	})
	mintRequest := httptest.NewRequest(http.MethodPost, "https://agent.example/api/brio-connect/mint-credential", strings.NewReader(`{"proof":`+quote(mintProof)+`}`))
	mintResponse := httptest.NewRecorder()
	m.MintCredential(mintResponse, mintRequest)
	if mintResponse.Code != http.StatusOK {
		t.Fatalf("mint status %d: %s", mintResponse.Code, mintResponse.Body.String())
	}
	var minted struct {
		Credential string `json:"credential"`
	}
	if err := json.Unmarshal(mintResponse.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}

	tokenURL := "https://agent.example/oauth/token"
	form := url.Values{
		"grant_type":                  {TokenExchangeGrantType},
		"subject_token":               {minted.Credential},
		"subject_token_type":          {EnvironmentBootstrapType},
		"requested_token_type":        {AccessTokenType},
		"client_proof_key_thumbprint": {thumbprint},
		"scope":                       {ScopeRead},
	}
	exchangeRequest := httptest.NewRequest(http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	exchangeRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	exchangeRequest.Header.Set("DPoP", signDPoP(t, clientKey, http.MethodPost, tokenURL, "", "dpop-1"))
	exchangeResponse := httptest.NewRecorder()
	m.ExchangeToken(exchangeResponse, exchangeRequest)
	if exchangeResponse.Code != http.StatusOK {
		t.Fatalf("exchange status %d: %s", exchangeResponse.Code, exchangeResponse.Body.String())
	}
	var token struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Scope       string `json:"scope"`
	}
	if err := json.Unmarshal(exchangeResponse.Body.Bytes(), &token); err != nil {
		t.Fatal(err)
	}
	if token.TokenType != "DPoP" || token.AccessToken == "" || token.Scope != ScopeRead {
		t.Fatalf("unexpected token: %#v", token)
	}

	protectedURL := "https://agent.example/health"
	protected := httptest.NewRequest(http.MethodGet, protectedURL, nil)
	protected.Header.Set("DPoP", signDPoP(t, clientKey, http.MethodGet, protectedURL, token.AccessToken, "dpop-2"))
	if err := m.AuthenticateRequest(protected, token.AccessToken, ScopeRead); err != nil {
		t.Fatalf("expected DPoP-bound session authentication: %v", err)
	}
	if err := m.AuthenticateRequest(protected, token.AccessToken, ScopeRead); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("expected replayed DPoP proof rejection, got %v", err)
	}

	writeURL := "https://agent.example/runs"
	writeRequest := httptest.NewRequest(http.MethodPost, writeURL, nil)
	writeRequest.Header.Set("DPoP", signDPoP(t, clientKey, http.MethodPost, writeURL, token.AccessToken, "dpop-3"))
	if err := m.AuthenticateRequest(writeRequest, token.AccessToken, ScopeOperate); !errors.Is(err, ErrInsufficientScope) {
		t.Fatalf("expected read-only token to reject an operation, got %v", err)
	}
}

func signDPoP(t *testing.T, key *ecdsa.PrivateKey, method, target, accessToken, jti string) string {
	t.Helper()
	claims := map[string]any{"htm": method, "htu": target, "iat": time.Now().Unix(), "jti": jti}
	if accessToken != "" {
		claims["ath"] = connectauth.HashToken(accessToken)
	}
	proof, err := connectauth.Sign(key, "dpop+jwt", claims)
	if err != nil {
		t.Fatal(err)
	}
	return proof
}

func quote(value string) string { data, _ := json.Marshal(value); return string(data) }
