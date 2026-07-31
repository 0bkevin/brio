package connect

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/brio/brio/packages/connectauth"
)

const (
	LinkProofType      = "brio-connect-link+jwt"
	HealthRequestType  = "brio-connect-health-request+jwt"
	HealthResponseType = "brio-connect-health-response+jwt"
	MintRequestType    = "brio-connect-mint-request+jwt"
	MintResponseType   = "brio-connect-mint-response+jwt"

	TokenExchangeGrantType   = "urn:ietf:params:oauth:grant-type:token-exchange"
	EnvironmentBootstrapType = "urn:brio:params:oauth:token-type:environment-bootstrap"
	AccessTokenType          = "urn:ietf:params:oauth:token-type:access_token"
	ScopeRead                = "brio:read"
	ScopeOperate             = "brio:operate"
)

var (
	ErrInvalidSession    = errors.New("invalid DPoP session")
	ErrInsufficientScope = errors.New("insufficient session scope")
)

type Endpoint struct {
	HTTPBaseURL  string `json:"http_base_url"`
	WSBaseURL    string `json:"ws_base_url"`
	ProviderKind string `json:"provider_kind"`
}

type EndpointRuntime struct {
	ProviderKind   string `json:"provider_kind"`
	ConnectorToken string `json:"connector_token"`
	TunnelID       string `json:"tunnel_id,omitempty"`
	TunnelName     string `json:"tunnel_name,omitempty"`
}

type State struct {
	EnvironmentID         string           `json:"environment_id"`
	EnvironmentName       string           `json:"environment_name"`
	PrivateKeyPEM         string           `json:"private_key_pem"`
	RelayIssuer           string           `json:"relay_issuer"`
	RelayPublicKey        connectauth.JWK  `json:"relay_public_key"`
	CloudUserID           string           `json:"cloud_user_id"`
	EnvironmentCredential string           `json:"environment_credential"`
	Endpoint              Endpoint         `json:"endpoint"`
	EndpointRuntime       *EndpointRuntime `json:"endpoint_runtime,omitempty"`
	LinkedAt              time.Time        `json:"linked_at"`
}

type ReconcileResult struct {
	Endpoint        Endpoint         `json:"endpoint"`
	EndpointRuntime *EndpointRuntime `json:"endpoint_runtime,omitempty"`
}

type Manager struct {
	mu         sync.Mutex
	path       string
	state      *State
	key        *ecdsa.PrivateKey
	bootstraps map[string]bootstrap
	sessions   map[string]session
	replay     map[string]time.Time
}

type bootstrap struct {
	ExpiresAt  time.Time
	Thumbprint string
	Scopes     []string
}

type session struct {
	ExpiresAt  time.Time
	Thumbprint string
	Scopes     map[string]struct{}
}

func Open(path string) (*Manager, error) {
	m := &Manager{
		path: path, bootstraps: map[string]bootstrap{}, sessions: map[string]session{}, replay: map[string]time.Time{},
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return nil, err
	}
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode Brio Connect state: %w", err)
	}
	key, err := connectauth.DecodePrivateKey(state.PrivateKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("decode Brio Connect identity: %w", err)
	}
	m.state = &state
	m.key = key
	return m, nil
}

func NewIdentityProof(code, relayIssuer, environmentID, name, publicURL, localAddr string) (string, string, error) {
	key, err := connectauth.GeneratePrivateKey()
	if err != nil {
		return "", "", err
	}
	privateKey, err := connectauth.EncodePrivateKey(key)
	if err != nil {
		return "", "", err
	}
	endpoint, origin, err := proposedEndpoint(publicURL, localAddr)
	if err != nil {
		return "", "", err
	}
	now := time.Now().UTC()
	nonce, err := connectauth.RandomToken(18)
	if err != nil {
		return "", "", err
	}
	proof, err := connectauth.Sign(key, LinkProofType, map[string]any{
		"iss":                    "brio-env:" + environmentID,
		"aud":                    strings.TrimRight(relayIssuer, "/"),
		"sub":                    environmentID,
		"jti":                    nonce,
		"iat":                    now.Unix(),
		"exp":                    now.Add(5 * time.Minute).Unix(),
		"challenge":              strings.ToUpper(strings.TrimSpace(code)),
		"environment_id":         environmentID,
		"environment_name":       name,
		"environment_public_key": connectauth.PublicJWK(&key.PublicKey),
		"endpoint":               endpoint,
		"origin":                 origin,
		"scopes":                 []string{"managed_tunnels", "agent_activity_notifications"},
	})
	return proof, privateKey, err
}

func proposedEndpoint(publicURL, localAddr string) (Endpoint, map[string]any, error) {
	host, port, err := splitHostPort(localAddr)
	if err != nil {
		return Endpoint{}, nil, fmt.Errorf("invalid companion listen address: %w", err)
	}
	endpoint := Endpoint{ProviderKind: "manual"}
	if strings.TrimSpace(publicURL) != "" {
		u, err := url.Parse(strings.TrimRight(publicURL, "/"))
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return Endpoint{}, nil, errors.New("public URL must be an absolute HTTP(S) URL")
		}
		endpoint.HTTPBaseURL = u.String()
		if u.Scheme == "https" {
			u.Scheme = "wss"
		} else {
			u.Scheme = "ws"
		}
		endpoint.WSBaseURL = u.String()
	}
	return endpoint, map[string]any{"local_http_host": host, "local_http_port": port}, nil
}

func splitHostPort(addr string) (string, int, error) {
	u, err := url.Parse("http://" + addr)
	if err != nil || u.Hostname() == "" || u.Port() == "" {
		return "", 0, errors.New("expected host:port")
	}
	port := 0
	if _, err := fmt.Sscanf(u.Port(), "%d", &port); err != nil || port < 1 || port > 65535 {
		return "", 0, errors.New("invalid port")
	}
	host := u.Hostname()
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return host, port, nil
}

func ReconcileEndpoint(ctx context.Context, state State, localAddr string) (ReconcileResult, error) {
	host, port, err := splitHostPort(localAddr)
	if err != nil {
		return ReconcileResult{}, err
	}
	data, _ := json.Marshal(map[string]any{"origin": map[string]any{"local_http_host": host, "local_http_port": port}})
	target := strings.TrimRight(state.RelayIssuer, "/") + "/v1/environments/" + url.PathEscape(state.EnvironmentID) + "/tunnel/reconcile"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(data))
	if err != nil {
		return ReconcileResult{}, err
	}
	request.Header.Set("Authorization", "Bearer "+state.EnvironmentCredential)
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}).Do(request)
	if err != nil {
		return ReconcileResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return ReconcileResult{}, fmt.Errorf("endpoint reconciliation failed (%d): %s", response.StatusCode, strings.TrimSpace(string(data)))
	}
	var result ReconcileResult
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return ReconcileResult{}, err
	}
	if result.Endpoint.HTTPBaseURL == "" {
		return ReconcileResult{}, errors.New("endpoint reconciliation response is incomplete")
	}
	return result, nil
}

func ReleaseEndpoint(ctx context.Context, state State) error {
	target := strings.TrimRight(state.RelayIssuer, "/") + "/v1/environments/" + url.PathEscape(state.EnvironmentID) + "/tunnel"
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, target, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+state.EnvironmentCredential)
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("endpoint release failed (%d): %s", response.StatusCode, strings.TrimSpace(string(data)))
	}
	return nil
}

func (m *Manager) Configure(state State) error {
	key, err := connectauth.DecodePrivateKey(state.PrivateKeyPEM)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(m.path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(m.path, append(data, '\n'), 0o600); err != nil {
		return err
	}
	m.mu.Lock()
	m.state = &state
	m.key = key
	m.mu.Unlock()
	return nil
}

func (m *Manager) State() (State, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil {
		return State{}, false
	}
	return *m.state, true
}

func (m *Manager) AuthenticateRequest(r *http.Request, token, requiredScope string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked(time.Now())
	value, ok := m.sessions[connectauth.HashToken(token)]
	if !ok || !value.ExpiresAt.After(time.Now()) {
		return ErrInvalidSession
	}
	if err := m.verifyDPoPLocked(r, value.Thumbprint, connectauth.HashToken(token)); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidSession, err)
	}
	if _, ok := value.Scopes[requiredScope]; !ok {
		return ErrInsufficientScope
	}
	return nil
}

func (m *Manager) Health(w http.ResponseWriter, r *http.Request, descriptor map[string]any) {
	state, key, claims, ok := m.verifyRelayProof(w, r, HealthRequestType, "environment:status")
	if !ok {
		return
	}
	now := time.Now().UTC()
	proof, err := connectauth.Sign(key, HealthResponseType, map[string]any{
		"iss":            "brio-env:" + state.EnvironmentID,
		"aud":            state.RelayIssuer,
		"sub":            state.EnvironmentID,
		"jti":            mustRandomToken(18),
		"iat":            now.Unix(),
		"exp":            now.Add(time.Minute).Unix(),
		"environment_id": state.EnvironmentID,
		"request_nonce":  connectauth.StringClaim(claims, "nonce"),
		"status":         "online",
		"checked_at":     now.Format(time.RFC3339Nano),
		"descriptor":     descriptor,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not sign health response"})
		return
	}
	writeNoStore(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"environment_id": state.EnvironmentID,
		"status":         "online",
		"checked_at":     now.Format(time.RFC3339Nano),
		"descriptor":     descriptor,
		"proof":          proof,
	})
}

func (m *Manager) MintCredential(w http.ResponseWriter, r *http.Request) {
	state, key, claims, ok := m.verifyRelayProof(w, r, MintRequestType, "environment:connect")
	if !ok {
		return
	}
	thumbprint := connectauth.StringClaim(claims, "client_proof_key_thumbprint")
	if thumbprint == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "client proof key thumbprint is required"})
		return
	}
	credential := "brio_bootstrap_" + mustRandomToken(32)
	now := time.Now().UTC()
	expiresAt := now.Add(2 * time.Minute)
	m.mu.Lock()
	m.pruneLocked(now)
	m.bootstraps[connectauth.HashToken(credential)] = bootstrap{
		ExpiresAt:  expiresAt,
		Thumbprint: thumbprint,
		Scopes:     []string{ScopeRead, ScopeOperate},
	}
	m.mu.Unlock()
	proof, err := connectauth.Sign(key, MintResponseType, map[string]any{
		"iss":                         "brio-env:" + state.EnvironmentID,
		"aud":                         state.RelayIssuer,
		"sub":                         state.EnvironmentID,
		"jti":                         mustRandomToken(18),
		"iat":                         now.Unix(),
		"exp":                         expiresAt.Unix(),
		"environment_id":              state.EnvironmentID,
		"client_proof_key_thumbprint": thumbprint,
		"request_nonce":               connectauth.StringClaim(claims, "nonce"),
		"credential":                  credential,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not sign credential response"})
		return
	}
	writeNoStore(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"credential": credential,
		"expires_at": expiresAt.Format(time.RFC3339Nano),
		"proof":      proof,
	})
}

func (m *Manager) ExchangeToken(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, "invalid_request", "invalid token request")
		return
	}
	grantType, grantOK := singleFormValue(r.Form, "grant_type")
	subjectType, subjectTypeOK := singleFormValue(r.Form, "subject_token_type")
	requestedType, requestedTypeOK := singleFormValue(r.Form, "requested_token_type")
	credential, credentialOK := singleFormValue(r.Form, "subject_token")
	thumbprint, thumbprintOK := singleFormValue(r.Form, "client_proof_key_thumbprint")
	requestedScope, scopeOK := singleFormValue(r.Form, "scope")
	if !grantOK || grantType != TokenExchangeGrantType ||
		!subjectTypeOK || subjectType != EnvironmentBootstrapType ||
		!requestedTypeOK || requestedType != AccessTokenType ||
		!credentialOK || !thumbprintOK || !scopeOK {
		writeOAuthError(w, "invalid_request", "token exchange parameters are missing, duplicated, or unsupported")
		return
	}
	now := time.Now().UTC()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked(now)
	entry, ok := m.bootstraps[connectauth.HashToken(credential)]
	if !ok || entry.ExpiresAt.Before(now) || entry.Thumbprint == "" || entry.Thumbprint != thumbprint {
		writeNoStore(w)
		w.Header().Set("WWW-Authenticate", "DPoP")
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_grant", "error_description": "invalid or expired bootstrap credential"})
		return
	}
	scopes, validScopes := requestedScopes(requestedScope, entry.Scopes)
	if !validScopes {
		writeOAuthError(w, "invalid_scope", "requested scope is empty or is not allowed by the bootstrap credential")
		return
	}
	if m.verifyDPoPLocked(r, entry.Thumbprint, "") != nil {
		writeNoStore(w)
		w.Header().Set("WWW-Authenticate", "DPoP")
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_dpop_proof", "error_description": "DPoP proof is missing or invalid"})
		return
	}
	delete(m.bootstraps, connectauth.HashToken(credential))
	token := "brio_access_" + mustRandomToken(32)
	expiresAt := now.Add(time.Hour)
	scopeSet := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		scopeSet[scope] = struct{}{}
	}
	m.sessions[connectauth.HashToken(token)] = session{ExpiresAt: expiresAt, Thumbprint: thumbprint, Scopes: scopeSet}
	writeNoStore(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":      token,
		"issued_token_type": AccessTokenType,
		"token_type":        "DPoP",
		"expires_in":        3600,
		"scope":             strings.Join(scopes, " "),
	})
}

func singleFormValue(values url.Values, key string) (string, bool) {
	items, ok := values[key]
	if !ok || len(items) != 1 {
		return "", false
	}
	value := strings.TrimSpace(items[0])
	return value, value != ""
}

func requestedScopes(raw string, allowed []string) ([]string, bool) {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, scope := range allowed {
		allowedSet[scope] = struct{}{}
	}
	seen := make(map[string]struct{})
	var scopes []string
	for _, scope := range strings.Fields(raw) {
		if _, ok := allowedSet[scope]; !ok {
			return nil, false
		}
		if _, duplicate := seen[scope]; duplicate {
			return nil, false
		}
		seen[scope] = struct{}{}
		scopes = append(scopes, scope)
	}
	return scopes, len(scopes) > 0
}

func (m *Manager) verifyDPoPLocked(r *http.Request, expectedThumbprint, expectedAccessHash string) error {
	proof := strings.TrimSpace(r.Header.Get("DPoP"))
	if proof == "" || len(proof) > 16<<10 {
		return errors.New("missing DPoP proof")
	}
	header, _, err := connectauth.DecodeUnverified(proof)
	if err != nil {
		return err
	}
	jwk, err := decodeMap[connectauth.JWK](header, "jwk")
	if err != nil {
		return err
	}
	thumbprint, err := connectauth.Thumbprint(jwk)
	if err != nil || thumbprint != expectedThumbprint {
		return errors.New("DPoP key does not match credential binding")
	}
	key, err := connectauth.ParsePublicJWK(jwk)
	if err != nil {
		return err
	}
	verified, err := connectauth.VerifySigned(proof, key, "dpop+jwt")
	if err != nil {
		return err
	}
	issuedAt, ok := connectauth.Int64Claim(verified.Claims, "iat")
	now := time.Now().Unix()
	if !ok || issuedAt < now-60 || issuedAt > now+60 {
		return errors.New("DPoP proof time is outside allowed skew")
	}
	jti := connectauth.StringClaim(verified.Claims, "jti")
	if jti == "" || len(jti) > 128 {
		return errors.New("DPoP proof is missing jti")
	}
	replayKey := "dpop:" + expectedThumbprint + ":" + jti
	if _, replayed := m.replay[replayKey]; replayed {
		return errors.New("DPoP proof was already used")
	}
	if !strings.EqualFold(connectauth.StringClaim(verified.Claims, "htm"), r.Method) {
		return errors.New("DPoP HTTP method mismatch")
	}
	if canonicalHTU(connectauth.StringClaim(verified.Claims, "htu")) != requestHTU(r) {
		return errors.New("DPoP HTTP URL mismatch")
	}
	if expectedAccessHash != "" && connectauth.StringClaim(verified.Claims, "ath") != expectedAccessHash {
		return errors.New("DPoP access-token hash mismatch")
	}
	if expectedAccessHash == "" && connectauth.StringClaim(verified.Claims, "ath") != "" {
		return errors.New("unexpected DPoP access-token hash")
	}
	m.replay[replayKey] = time.Now().Add(2 * time.Minute)
	return nil
}

func decodeMap[T any](values map[string]any, key string) (T, error) {
	var output T
	data, err := json.Marshal(values[key])
	if err != nil {
		return output, err
	}
	if err := json.Unmarshal(data, &output); err != nil {
		return output, err
	}
	return output, nil
}

func canonicalHTU(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.Host = strings.ToLower(u.Host)
	return u.String()
}

func requestHTU(r *http.Request) string {
	scheme := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if scheme == "" {
		scheme = r.URL.Scheme
	}
	if scheme == "" {
		scheme = "http"
	}
	return canonicalHTU((&url.URL{Scheme: scheme, Host: r.Host, Path: r.URL.Path}).String())
}

func (m *Manager) verifyRelayProof(w http.ResponseWriter, r *http.Request, typ, scope string) (State, *ecdsa.PrivateKey, map[string]any, bool) {
	var body struct {
		Proof string `json:"proof"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil || body.Proof == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid signed request"})
		return State{}, nil, nil, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil || m.key == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Brio Connect is not linked"})
		return State{}, nil, nil, false
	}
	relayKey, err := connectauth.ParsePublicJWK(m.state.RelayPublicKey)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "relay trust configuration is invalid"})
		return State{}, nil, nil, false
	}
	verified, err := connectauth.Verify(body.Proof, relayKey, typ, m.state.RelayIssuer, "brio-env:"+m.state.EnvironmentID, time.Now().UTC())
	if err != nil || connectauth.StringClaim(verified.Claims, "environment_id") != m.state.EnvironmentID || connectauth.StringClaim(verified.Claims, "cloud_user_id") != m.state.CloudUserID || connectauth.StringClaim(verified.Claims, "scope") != scope {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "relay proof is invalid or not authorized"})
		return State{}, nil, nil, false
	}
	nonce := connectauth.StringClaim(verified.Claims, "jti")
	m.pruneLocked(time.Now())
	if _, replayed := m.replay[nonce]; replayed {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "relay proof was already used"})
		return State{}, nil, nil, false
	}
	expires, _ := connectauth.Int64Claim(verified.Claims, "exp")
	m.replay[nonce] = time.Unix(expires, 0)
	return *m.state, m.key, verified.Claims, true
}

func (m *Manager) pruneLocked(now time.Time) {
	for key, value := range m.bootstraps {
		if !value.ExpiresAt.After(now) {
			delete(m.bootstraps, key)
		}
	}
	for key, value := range m.sessions {
		if !value.ExpiresAt.After(now) {
			delete(m.sessions, key)
		}
	}
	for key, expires := range m.replay {
		if !expires.After(now) {
			delete(m.replay, key)
		}
	}
}

func mustRandomToken(size int) string {
	token, err := connectauth.RandomToken(size)
	if err != nil {
		panic(err)
	}
	return token
}

func writeNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
}

func writeOAuthError(w http.ResponseWriter, code, description string) {
	writeNoStore(w)
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": code, "error_description": description})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// RunManagedEndpoint launches the relay-provisioned connector and reconciles
// transient startup failures with exponential backoff. The retry window is
// intentionally bounded; an invalid token or missing binary must become a
// visible failure instead of an immortal tight loop.
func RunManagedEndpoint(ctx context.Context, state State, run func(context.Context, string) error, report func(error)) {
	if state.EndpointRuntime == nil || state.EndpointRuntime.ConnectorToken == "" {
		return
	}
	go func() {
		deadline := time.Now().Add(10 * time.Minute)
		backoff := time.Second
		for ctx.Err() == nil && time.Now().Before(deadline) {
			err := run(ctx, state.EndpointRuntime.ConnectorToken)
			if ctx.Err() != nil {
				return
			}
			report(err)
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
		if ctx.Err() == nil {
			report(errors.New("managed endpoint reconciliation stopped after 10 minutes"))
		}
	}()
}
