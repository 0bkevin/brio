package auth

import (
	"crypto/ecdsa"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/brio/brio/packages/connectauth"
)

const (
	RelayAccessTokenType    = "brio-relay-dpop-access+jwt"
	RelayAccessTokenTTL     = 30 * time.Minute
	MobileClientID          = "brio-mobile"
	WebClientID             = "brio-web"
	ScopeEnvironmentConnect = "environment:connect"
	ScopeEnvironmentStatus  = "environment:status"
	ScopeMobileRegistration = "mobile:registration"
)

var ErrInvalidRelayToken = errors.New("invalid relay access token")

type RelayTokenClaims struct {
	UserID     string
	ClientID   string
	Scopes     []string
	Thumbprint string
	ExpiresAt  time.Time
}

type TokenManager struct {
	issuer string
	key    *ecdsa.PrivateKey
}

func NewTokenManager(issuer string, key *ecdsa.PrivateKey) *TokenManager {
	return &TokenManager{issuer: strings.TrimRight(strings.TrimSpace(issuer), "/"), key: key}
}

func (m *TokenManager) Issue(userID, clientID string, scopes []string, thumbprint string, now time.Time, jti string) (string, error) {
	allowed, ok := ResolveScopes(clientID, strings.Join(scopes, " "))
	if !ok || userID == "" || thumbprint == "" || jti == "" {
		return "", ErrInvalidRelayToken
	}
	return connectauth.Sign(m.key, RelayAccessTokenType, map[string]any{
		"iss":       m.issuer,
		"aud":       m.issuer,
		"sub":       userID,
		"jti":       jti,
		"iat":       now.Unix(),
		"exp":       now.Add(RelayAccessTokenTTL).Unix(),
		"client_id": clientID,
		"scope":     strings.Join(allowed, " "),
		"cnf":       map[string]string{"jkt": thumbprint},
	})
}

func (m *TokenManager) Verify(token string, now time.Time) (RelayTokenClaims, error) {
	verified, err := connectauth.Verify(token, &m.key.PublicKey, RelayAccessTokenType, m.issuer, m.issuer, now)
	if err != nil {
		return RelayTokenClaims{}, ErrInvalidRelayToken
	}
	issuedAt, iatOK := connectauth.Int64Claim(verified.Claims, "iat")
	expires, expOK := connectauth.Int64Claim(verified.Claims, "exp")
	if !iatOK || !expOK || expires-issuedAt > int64(RelayAccessTokenTTL/time.Second) || issuedAt < now.Add(-RelayAccessTokenTTL-time.Minute).Unix() {
		return RelayTokenClaims{}, ErrInvalidRelayToken
	}
	clientID := connectauth.StringClaim(verified.Claims, "client_id")
	scopes, ok := ResolveScopes(clientID, connectauth.StringClaim(verified.Claims, "scope"))
	if !ok {
		return RelayTokenClaims{}, ErrInvalidRelayToken
	}
	confirmation, err := claimAs[struct {
		JKT string `json:"jkt"`
	}](verified.Claims, "cnf")
	if err != nil || confirmation.JKT == "" {
		return RelayTokenClaims{}, ErrInvalidRelayToken
	}
	return RelayTokenClaims{
		UserID:     connectauth.StringClaim(verified.Claims, "sub"),
		ClientID:   clientID,
		Scopes:     scopes,
		Thumbprint: confirmation.JKT,
		ExpiresAt:  time.Unix(expires, 0),
	}, nil
}

func ResolveScopes(clientID, raw string) ([]string, bool) {
	allowed := map[string]bool{
		ScopeEnvironmentConnect: true,
		ScopeEnvironmentStatus:  true,
	}
	if clientID == MobileClientID {
		allowed[ScopeMobileRegistration] = true
	} else if clientID != WebClientID {
		return nil, false
	}
	seen := map[string]bool{}
	for _, scope := range strings.Fields(raw) {
		if !allowed[scope] || seen[scope] {
			return nil, false
		}
		seen[scope] = true
	}
	if len(seen) == 0 {
		return nil, false
	}
	resolved := make([]string, 0, len(seen))
	for scope := range seen {
		resolved = append(resolved, scope)
	}
	sort.Strings(resolved)
	return resolved, true
}

func HasScope(scopes []string, expected string) bool {
	for _, scope := range scopes {
		if scope == expected {
			return true
		}
	}
	return false
}
