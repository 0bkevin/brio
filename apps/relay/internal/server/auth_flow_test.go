package server

import (
	"crypto/ecdsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	relayauth "github.com/brio/brio/apps/relay/internal/auth"
	connectcontrol "github.com/brio/brio/apps/relay/internal/connect"
	"github.com/brio/brio/apps/relay/internal/store"
	"github.com/brio/brio/packages/connectauth"
)

func TestDevelopmentIdentityExchangesForReplayProtectedDPoPToken(t *testing.T) {
	t.Parallel()
	issuer := "http://127.0.0.1:8082"
	st := store.NewMemoryStore()
	_, _, identityToken, err := st.CreateDeviceToken(t.Context(), "owner@example.com", "Test phone")
	if err != nil {
		t.Fatal(err)
	}
	broker, err := connectcontrol.New(connectcontrol.Config{Issuer: issuer}, st)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	a := &app{
		hub:        &hub{agents: map[string]map[*peer]bool{}},
		store:      st,
		connect:    broker,
		identities: &identityService{store: st, devAuth: true},
		tokens:     relayauth.NewTokenManager(issuer, broker.SigningKey()),
		devAuth:    true,
		now:        func() time.Time { return now },
	}
	router := newRouter(a)
	deviceKey, err := connectauth.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	tokenURL := issuer + "/v1/client/dpop-token"
	form := url.Values{
		"grant_type":           {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"subject_token":        {identityToken},
		"subject_token_type":   {"urn:ietf:params:oauth:token-type:jwt"},
		"requested_token_type": {"urn:ietf:params:oauth:token-type:access_token"},
		"resource":             {issuer},
		"scope":                {"mobile:registration environment:connect"},
		"client_id":            {"brio-mobile"},
	}
	exchange := httptest.NewRequest(http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	exchange.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	exchange.Header.Set("DPoP", signDPoPProof(t, deviceKey, http.MethodPost, tokenURL, "", "exchange-1", now))
	exchangeResponse := httptest.NewRecorder()
	router.ServeHTTP(exchangeResponse, exchange)
	if exchangeResponse.Code != http.StatusOK {
		t.Fatalf("exchange status = %d: %s", exchangeResponse.Code, exchangeResponse.Body.String())
	}
	var exchanged struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if err := json.Unmarshal(exchangeResponse.Body.Bytes(), &exchanged); err != nil {
		t.Fatal(err)
	}
	if exchanged.AccessToken == "" || exchanged.TokenType != "DPoP" {
		t.Fatalf("unexpected token exchange response: %+v", exchanged)
	}

	registerURL := issuer + "/v1/mobile/devices"
	proof := signDPoPProof(t, deviceKey, http.MethodPost, registerURL, exchanged.AccessToken, "register-1", now)
	register := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, registerURL, strings.NewReader(`{"device_id":"installation-1","label":"Phone"}`))
		request.Header.Set("Authorization", "DPoP "+exchanged.AccessToken)
		request.Header.Set("DPoP", proof)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	if response := register(); response.Code != http.StatusOK {
		t.Fatalf("register status = %d: %s", response.Code, response.Body.String())
	}
	if response := register(); response.Code != http.StatusUnauthorized {
		t.Fatalf("replayed proof status = %d: %s", response.Code, response.Body.String())
	}
}

func signDPoPProof(t *testing.T, key *ecdsa.PrivateKey, method, target, accessToken, jti string, now time.Time) string {
	t.Helper()
	claims := map[string]any{
		"htm": method,
		"htu": target,
		"iat": now.Unix(),
		"jti": jti,
	}
	if accessToken != "" {
		claims["ath"] = connectauth.HashToken(accessToken)
	}
	proof, err := connectauth.Sign(key, "dpop+jwt", claims)
	if err != nil {
		t.Fatal(err)
	}
	return proof
}
