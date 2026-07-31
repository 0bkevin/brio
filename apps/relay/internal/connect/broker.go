package connect

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/brio/brio/apps/relay/internal/store"
	"github.com/brio/brio/packages/connectauth"
)

const (
	LinkProofType      = "brio-connect-link+jwt"
	HealthRequestType  = "brio-connect-health-request+jwt"
	HealthResponseType = "brio-connect-health-response+jwt"
	MintRequestType    = "brio-connect-mint-request+jwt"
	MintResponseType   = "brio-connect-mint-response+jwt"
	requestTimeout     = 8 * time.Second
)

type Broker struct {
	issuer      string
	key         *ecdsa.PrivateKey
	store       store.Store
	http        *http.Client
	endpoints   *endpointProvisioner
	tunnelLimit int
}

type Error struct {
	Status int
	Code   string
	Reason string
	Cause  error
}

func (e *Error) Error() string {
	if e.Reason != "" {
		return e.Code + ": " + e.Reason
	}
	return e.Code
}

func (e *Error) Unwrap() error { return e.Cause }

type EnrollmentLink struct {
	Link       store.ConnectLink
	PrivateKey connectauth.JWK
	Name       string
	OriginHost string
	OriginPort int
}

type Config struct {
	Issuer             string
	SigningPrivateKey  string
	Cloudflare         CloudflareConfig
	ManagedTunnelLimit int
}

type ConnectResponse struct {
	EnvironmentID string                `json:"environment_id"`
	Endpoint      store.ManagedEndpoint `json:"endpoint"`
	Credential    string                `json:"credential"`
	ExpiresAt     time.Time             `json:"expires_at"`
}

type StatusResponse struct {
	EnvironmentID string                `json:"environment_id"`
	Endpoint      store.ManagedEndpoint `json:"endpoint"`
	Status        string                `json:"status"`
	CheckedAt     time.Time             `json:"checked_at"`
	Descriptor    any                   `json:"descriptor,omitempty"`
	Error         string                `json:"error,omitempty"`
}

func New(config Config, st store.Store) (*Broker, error) {
	issuer := strings.TrimRight(strings.TrimSpace(config.Issuer), "/")
	if issuer == "" {
		return nil, errors.New("relay issuer is required")
	}
	var key *ecdsa.PrivateKey
	var err error
	if strings.TrimSpace(config.SigningPrivateKey) == "" {
		key, err = connectauth.GeneratePrivateKey()
	} else {
		key, err = connectauth.DecodePrivateKey(config.SigningPrivateKey)
	}
	if err != nil {
		return nil, fmt.Errorf("load relay signing key: %w", err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	limit := config.ManagedTunnelLimit
	if limit <= 0 {
		limit = 3
	}
	return &Broker{
		issuer:      issuer,
		key:         key,
		store:       st,
		endpoints:   newEndpointProvisioner(config.Cloudflare),
		tunnelLimit: limit,
		http: &http.Client{
			Timeout:       requestTimeout,
			Transport:     transport,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

func (b *Broker) Issuer() string             { return b.issuer }
func (b *Broker) PublicKey() connectauth.JWK { return connectauth.PublicJWK(&b.key.PublicKey) }

func (b *Broker) VerifyEnrollmentProof(proof, code, expectedEnvironmentID string) (EnrollmentLink, error) {
	header, claims, err := connectauth.DecodeUnverified(proof)
	if err != nil {
		return EnrollmentLink{}, invalidLink("decode_token", err)
	}
	if header["alg"] != "ES256" || header["typ"] != LinkProofType {
		return EnrollmentLink{}, invalidLink("invalid_signature_or_scope", nil)
	}
	environmentID := connectauth.StringClaim(claims, "environment_id")
	if environmentID == "" || environmentID != expectedEnvironmentID || connectauth.StringClaim(claims, "sub") != environmentID {
		return EnrollmentLink{}, invalidLink("descriptor_mismatch", nil)
	}
	jwk, err := decodeClaim[connectauth.JWK](claims, "environment_public_key")
	if err != nil {
		return EnrollmentLink{}, invalidLink("environment_public_key_invalid", err)
	}
	publicKey, err := connectauth.ParsePublicJWK(jwk)
	if err != nil {
		return EnrollmentLink{}, invalidLink("environment_public_key_invalid", err)
	}
	verified, err := connectauth.Verify(proof, publicKey, LinkProofType, "brio-env:"+environmentID, b.issuer, time.Now().UTC())
	if err != nil {
		return EnrollmentLink{}, invalidLink("invalid_signature_or_scope", err)
	}
	if connectauth.StringClaim(verified.Claims, "challenge") != strings.ToUpper(strings.TrimSpace(code)) {
		return EnrollmentLink{}, invalidLink("challenge_invalid", nil)
	}
	scopes, err := decodeClaim[[]string](verified.Claims, "scopes")
	if err != nil || (b.endpoints.configured() && !contains(scopes, "managed_tunnels")) {
		return EnrollmentLink{}, invalidLink("invalid_signature_or_scope", err)
	}
	origin, err := decodeClaim[struct {
		Host string `json:"local_http_host"`
		Port int    `json:"local_http_port"`
	}](verified.Claims, "origin")
	if err != nil || !isLoopback(origin.Host) || origin.Port < 1 || origin.Port > 65535 {
		return EnrollmentLink{}, invalidLink("origin_not_allowed", err)
	}
	endpoint, err := decodeClaim[store.ManagedEndpoint](verified.Claims, "endpoint")
	if err != nil {
		return EnrollmentLink{}, invalidLink("endpoint_invalid", err)
	}
	if endpoint.ProviderKind == "" {
		endpoint.ProviderKind = "manual"
	}
	if !b.endpoints.configured() {
		if err := validateEndpoint(endpoint, b.issuer); err != nil {
			return EnrollmentLink{}, invalidLink("endpoint_not_secure", err)
		}
	}
	return EnrollmentLink{
		Link:       store.ConnectLink{EnvironmentPublicKey: connectauth.EncodeJWK(jwk), Endpoint: endpoint},
		PrivateKey: jwk,
		Name:       strings.TrimSpace(connectauth.StringClaim(verified.Claims, "environment_name")),
		OriginHost: origin.Host,
		OriginPort: origin.Port,
	}, nil
}

func (b *Broker) ProvisionEndpoint(ctx context.Context, userID, environmentID string, link EnrollmentLink) (EnrollmentLink, *EndpointRuntime, error) {
	if !b.endpoints.configured() {
		return link, nil, nil
	}
	count, err := b.store.CountManagedEndpoints(ctx, userID, environmentID)
	if err != nil {
		return EnrollmentLink{}, nil, internal(err)
	}
	if count >= b.tunnelLimit {
		return EnrollmentLink{}, nil, &Error{Status: http.StatusConflict, Code: "environment_link_limit_exceeded", Reason: "managed_tunnel_limit_exceeded"}
	}
	endpoint, runtime, err := b.endpoints.provision(ctx, userID, environmentID, link.OriginHost, link.OriginPort)
	if err != nil {
		return EnrollmentLink{}, nil, &Error{Status: http.StatusServiceUnavailable, Code: "environment_link_unavailable", Reason: "managed_endpoint_provisioning_failed", Cause: err}
	}
	link.Link.Endpoint = endpoint
	return link, runtime, nil
}

func (b *Broker) Unlink(ctx context.Context, userID, environmentID string) (bool, error) {
	agent, err := b.store.GetConnectEnvironment(ctx, userID, environmentID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return b.store.UnlinkAgent(ctx, userID, environmentID)
		}
		return false, mapLookupError(err)
	}
	if agent.Endpoint != nil && agent.Endpoint.ProviderKind == "cloudflare_tunnel" {
		if err := b.endpoints.deprovision(ctx, userID, environmentID); err != nil {
			return false, &Error{Status: http.StatusServiceUnavailable, Code: "environment_link_unavailable", Reason: "managed_endpoint_deprovisioning_failed", Cause: err}
		}
	}
	return b.store.UnlinkAgent(ctx, userID, environmentID)
}

func (b *Broker) ReconcileEndpoint(ctx context.Context, environmentID, credential, originHost string, originPort int) (store.ManagedEndpoint, *EndpointRuntime, error) {
	agent, err := b.store.AuthenticateEnvironment(ctx, environmentID, credential)
	if err != nil {
		return store.ManagedEndpoint{}, nil, &Error{Status: http.StatusUnauthorized, Code: "not_authorized", Reason: "environment_credential_invalid", Cause: err}
	}
	if agent.OwnerUserID == nil {
		return store.ManagedEndpoint{}, nil, notAuthorized("environment_link_not_found")
	}
	if !isLoopback(originHost) || originPort < 1 || originPort > 65535 {
		return store.ManagedEndpoint{}, nil, invalidLink("origin_not_allowed", nil)
	}
	if !b.endpoints.configured() {
		if agent.Endpoint == nil {
			return store.ManagedEndpoint{}, nil, notAuthorized("managed_endpoint_allocation_not_found")
		}
		return *agent.Endpoint, nil, nil
	}
	endpoint, runtime, err := b.endpoints.provision(ctx, *agent.OwnerUserID, environmentID, originHost, originPort)
	if err != nil {
		return store.ManagedEndpoint{}, nil, &Error{Status: http.StatusServiceUnavailable, Code: "environment_link_unavailable", Reason: "managed_endpoint_provisioning_failed", Cause: err}
	}
	if err := b.store.UpdateConnectEndpoint(ctx, environmentID, endpoint); err != nil {
		return store.ManagedEndpoint{}, nil, internal(err)
	}
	return endpoint, runtime, nil
}

func (b *Broker) ReleaseEndpoint(ctx context.Context, environmentID, credential string) (bool, error) {
	agent, err := b.store.AuthenticateEnvironment(ctx, environmentID, credential)
	if err != nil {
		return false, &Error{Status: http.StatusUnauthorized, Code: "not_authorized", Reason: "environment_credential_invalid", Cause: err}
	}
	if agent.OwnerUserID == nil || agent.Endpoint == nil || agent.Endpoint.ProviderKind != "cloudflare_tunnel" {
		return false, nil
	}
	if err := b.endpoints.deprovision(ctx, *agent.OwnerUserID, environmentID); err != nil {
		return false, &Error{Status: http.StatusServiceUnavailable, Code: "environment_link_unavailable", Reason: "managed_endpoint_deprovisioning_failed", Cause: err}
	}
	return true, nil
}

func (b *Broker) Connect(ctx context.Context, userID, environmentID, clientThumbprint, deviceID string) (ConnectResponse, error) {
	if strings.TrimSpace(clientThumbprint) == "" {
		return ConnectResponse{}, notAuthorized("client_proof_key_thumbprint_missing")
	}
	agent, err := b.store.GetConnectEnvironment(ctx, userID, environmentID)
	if err != nil {
		return ConnectResponse{}, mapLookupError(err)
	}
	now := time.Now().UTC()
	nonce, err := connectauth.RandomToken(18)
	if err != nil {
		return ConnectResponse{}, internal(err)
	}
	proof, err := b.signRequest(MintRequestType, agent, userID, nonce, "environment:connect", map[string]any{
		"client_proof_key_thumbprint": clientThumbprint,
		"device_id":                   deviceID,
	})
	if err != nil {
		return ConnectResponse{}, internal(err)
	}
	var response struct {
		Credential string    `json:"credential"`
		ExpiresAt  time.Time `json:"expires_at"`
		Proof      string    `json:"proof"`
	}
	if err := b.callEnvironment(ctx, agent, "/api/brio-connect/mint-credential", proof, &response); err != nil {
		return ConnectResponse{}, err
	}
	claims, err := b.verifyEnvironmentResponse(agent, response.Proof, MintResponseType)
	if err != nil || response.Credential == "" || response.ExpiresAt.Before(now) ||
		connectauth.StringClaim(claims, "request_nonce") != nonce ||
		connectauth.StringClaim(claims, "credential") != response.Credential ||
		connectauth.StringClaim(claims, "client_proof_key_thumbprint") != clientThumbprint {
		return ConnectResponse{}, endpointUnavailable("endpoint_response_invalid", err)
	}
	expires, ok := connectauth.Int64Claim(claims, "exp")
	if !ok || expires != response.ExpiresAt.Unix() {
		return ConnectResponse{}, endpointUnavailable("endpoint_response_invalid", nil)
	}
	_ = b.store.TouchAgent(ctx, environmentID, "online")
	return ConnectResponse{EnvironmentID: environmentID, Endpoint: *agent.Endpoint, Credential: response.Credential, ExpiresAt: response.ExpiresAt}, nil
}

func (b *Broker) Status(ctx context.Context, userID, environmentID string) (StatusResponse, error) {
	agent, err := b.store.GetConnectEnvironment(ctx, userID, environmentID)
	if err != nil {
		return StatusResponse{}, mapLookupError(err)
	}
	now := time.Now().UTC()
	nonce, err := connectauth.RandomToken(18)
	if err != nil {
		return StatusResponse{}, internal(err)
	}
	proof, err := b.signRequest(HealthRequestType, agent, userID, nonce, "environment:status", nil)
	if err != nil {
		return StatusResponse{}, internal(err)
	}
	var response struct {
		EnvironmentID string    `json:"environment_id"`
		Status        string    `json:"status"`
		CheckedAt     time.Time `json:"checked_at"`
		Descriptor    any       `json:"descriptor"`
		Proof         string    `json:"proof"`
	}
	if err := b.callEnvironment(ctx, agent, "/api/brio-connect/health", proof, &response); err != nil {
		var connectErr *Error
		if errors.As(err, &connectErr) && (connectErr.Code == "environment_endpoint_unavailable" || connectErr.Code == "environment_endpoint_timed_out") {
			_ = b.store.TouchAgent(ctx, environmentID, "offline")
			return StatusResponse{EnvironmentID: environmentID, Endpoint: *agent.Endpoint, Status: "offline", CheckedAt: now, Error: connectErr.Reason}, nil
		}
		return StatusResponse{}, err
	}
	claims, err := b.verifyEnvironmentResponse(agent, response.Proof, HealthResponseType)
	if err != nil || response.EnvironmentID != environmentID || response.Status != "online" ||
		connectauth.StringClaim(claims, "request_nonce") != nonce ||
		connectauth.StringClaim(claims, "status") != response.Status ||
		connectauth.StringClaim(claims, "checked_at") != response.CheckedAt.Format(time.RFC3339Nano) ||
		!sameJSON(claims["descriptor"], response.Descriptor) {
		return StatusResponse{}, endpointUnavailable("endpoint_response_invalid", err)
	}
	if response.CheckedAt.Before(now.Add(-time.Minute)) || response.CheckedAt.After(time.Now().Add(time.Minute)) {
		return StatusResponse{}, endpointUnavailable("endpoint_response_invalid", errors.New("health timestamp outside allowed skew"))
	}
	_ = b.store.TouchAgent(ctx, environmentID, "online")
	return StatusResponse{EnvironmentID: environmentID, Endpoint: *agent.Endpoint, Status: "online", CheckedAt: response.CheckedAt, Descriptor: response.Descriptor}, nil
}

func (b *Broker) signRequest(typ string, agent store.Agent, userID, nonce, scope string, extra map[string]any) (string, error) {
	now := time.Now().UTC()
	claims := map[string]any{
		"iss": b.issuer, "aud": "brio-env:" + agent.ID, "sub": agent.ID,
		"jti": mustToken(18), "iat": now.Unix(), "exp": now.Add(time.Minute).Unix(),
		"environment_id": agent.ID, "cloud_user_id": userID, "nonce": nonce, "scope": scope,
	}
	for key, value := range extra {
		if value != "" {
			claims[key] = value
		}
	}
	return connectauth.Sign(b.key, typ, claims)
}

func (b *Broker) verifyEnvironmentResponse(agent store.Agent, token, typ string) (map[string]any, error) {
	jwk, err := connectauth.DecodeJWK(agent.EnvironmentPublicKey)
	if err != nil {
		return nil, err
	}
	key, err := connectauth.ParsePublicJWK(jwk)
	if err != nil {
		return nil, err
	}
	verified, err := connectauth.Verify(token, key, typ, "brio-env:"+agent.ID, b.issuer, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	if connectauth.StringClaim(verified.Claims, "environment_id") != agent.ID {
		return nil, errors.New("environment id mismatch")
	}
	return verified.Claims, nil
}

func (b *Broker) callEnvironment(ctx context.Context, agent store.Agent, path, proof string, output any) error {
	if agent.Endpoint == nil {
		return notAuthorized("managed_endpoint_allocation_not_found")
	}
	target := strings.TrimRight(agent.Endpoint.HTTPBaseURL, "/") + path
	body, _ := json.Marshal(map[string]string{"proof": proof})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return endpointUnavailable("endpoint_request_failed", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := b.http.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return &Error{Status: http.StatusGatewayTimeout, Code: "environment_endpoint_timed_out", Reason: "endpoint request timed out", Cause: err}
		}
		return endpointUnavailable("endpoint_request_failed", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return endpointUnavailable("endpoint_request_failed", fmt.Errorf("environment returned %d: %s", response.StatusCode, strings.TrimSpace(string(data))))
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output); err != nil {
		return endpointUnavailable("endpoint_response_invalid", err)
	}
	return nil
}

func validateEndpoint(endpoint store.ManagedEndpoint, relayIssuer string) error {
	if endpoint.HTTPBaseURL == "" || endpoint.WSBaseURL == "" {
		return errors.New("endpoint URLs are required")
	}
	httpURL, err := url.Parse(endpoint.HTTPBaseURL)
	if err != nil || httpURL.Host == "" {
		return errors.New("HTTP endpoint is invalid")
	}
	wsURL, err := url.Parse(endpoint.WSBaseURL)
	if err != nil || wsURL.Host == "" {
		return errors.New("WebSocket endpoint is invalid")
	}
	if httpURL.Scheme == "https" && wsURL.Scheme == "wss" {
		return nil
	}
	relayURL, _ := url.Parse(relayIssuer)
	if relayURL != nil && relayURL.Scheme == "http" && isLoopback(httpURL.Hostname()) && httpURL.Scheme == "http" && wsURL.Scheme == "ws" {
		return nil
	}
	return errors.New("managed endpoints must use HTTPS and WSS")
}

func isLoopback(host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1" || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}

func decodeClaim[T any](claims map[string]any, key string) (T, error) {
	var output T
	data, err := json.Marshal(claims[key])
	if err != nil {
		return output, err
	}
	if err := json.Unmarshal(data, &output); err != nil {
		return output, err
	}
	return output, nil
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func sameJSON(left, right any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func mustToken(size int) string {
	value, err := connectauth.RandomToken(size)
	if err != nil {
		panic(err)
	}
	return value
}

func invalidLink(reason string, cause error) error {
	return &Error{Status: http.StatusBadRequest, Code: "environment_link_proof_invalid", Reason: reason, Cause: cause}
}
func notAuthorized(reason string) error {
	return &Error{Status: http.StatusForbidden, Code: "environment_connect_not_authorized", Reason: reason}
}
func endpointUnavailable(reason string, cause error) error {
	return &Error{Status: http.StatusBadGateway, Code: "environment_endpoint_unavailable", Reason: reason, Cause: cause}
}
func internal(cause error) error {
	return &Error{Status: http.StatusInternalServerError, Code: "internal_error", Reason: "internal_error", Cause: cause}
}

func mapLookupError(err error) error {
	switch {
	case errors.Is(err, store.ErrUnauthorized):
		return notAuthorized("environment_link_not_found")
	case errors.Is(err, store.ErrNotFound):
		return notAuthorized("environment_link_not_found")
	default:
		return internal(err)
	}
}
