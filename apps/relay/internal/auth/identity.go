package auth

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/clerk/clerk-sdk-go/v2"
	"github.com/clerk/clerk-sdk-go/v2/jwks"
	clerkjwt "github.com/clerk/clerk-sdk-go/v2/jwt"
)

var ErrInvalidIdentityToken = errors.New("invalid identity token")

type Identity struct {
	Issuer    string
	Subject   string
	SessionID string
	Email     string
}

type IdentityVerifier interface {
	Verify(context.Context, string) (Identity, error)
}

type ClerkConfig struct {
	SecretKey         string
	JWTKey            string
	Issuer            string
	Audience          string
	AuthorizedParties []string
}

type ClerkVerifier struct {
	config     ClerkConfig
	jwksClient *jwks.Client
	staticKey  *clerk.JSONWebKey
	mu         sync.RWMutex
	keys       map[string]*clerk.JSONWebKey
}

type identityCustomClaims struct {
	Email string `json:"email"`
}

func NewClerkVerifier(config ClerkConfig) (*ClerkVerifier, error) {
	config.SecretKey = strings.TrimSpace(config.SecretKey)
	config.JWTKey = strings.TrimSpace(strings.ReplaceAll(config.JWTKey, `\n`, "\n"))
	config.Issuer = strings.TrimRight(strings.TrimSpace(config.Issuer), "/")
	config.Audience = strings.TrimSpace(config.Audience)
	for index := range config.AuthorizedParties {
		config.AuthorizedParties[index] = strings.TrimSpace(config.AuthorizedParties[index])
	}
	if config.Audience == "" {
		return nil, errors.New("Clerk JWT audience is required")
	}
	if config.Issuer == "" {
		return nil, errors.New("exact Clerk issuer is required")
	}
	verifier := &ClerkVerifier{config: config, keys: map[string]*clerk.JSONWebKey{}}
	if config.JWTKey != "" {
		key, err := clerk.JSONWebKeyFromPEM(config.JWTKey)
		if err != nil {
			return nil, err
		}
		verifier.staticKey = key
		return verifier, nil
	}
	if config.SecretKey == "" {
		return nil, errors.New("Clerk secret key or JWT public key is required")
	}
	clientConfig := &clerk.ClientConfig{}
	clientConfig.Key = clerk.String(config.SecretKey)
	verifier.jwksClient = jwks.NewClient(clientConfig)
	return verifier, nil
}

func (v *ClerkVerifier) Verify(ctx context.Context, token string) (Identity, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return Identity{}, ErrInvalidIdentityToken
	}
	decoded, err := clerkjwt.Decode(ctx, &clerkjwt.DecodeParams{Token: token})
	if err != nil {
		return Identity{}, ErrInvalidIdentityToken
	}
	key, cached, err := v.key(ctx, decoded.KeyID)
	if err != nil {
		return Identity{}, ErrInvalidIdentityToken
	}
	claims, err := v.verifyWithKey(ctx, token, key)
	if err != nil && cached && v.staticKey == nil {
		v.mu.Lock()
		delete(v.keys, decoded.KeyID)
		v.mu.Unlock()
		key, _, fetchErr := v.key(ctx, decoded.KeyID)
		if fetchErr == nil {
			claims, err = v.verifyWithKey(ctx, token, key)
		}
	}
	if err != nil || claims.Subject == "" || !containsString(claims.Audience, v.config.Audience) {
		return Identity{}, ErrInvalidIdentityToken
	}
	if v.config.Issuer != "" && strings.TrimRight(claims.Issuer, "/") != v.config.Issuer {
		return Identity{}, ErrInvalidIdentityToken
	}
	custom, _ := claims.Custom.(*identityCustomClaims)
	identity := Identity{Issuer: claims.Issuer, Subject: claims.Subject, SessionID: claims.SessionID}
	if custom != nil {
		identity.Email = strings.TrimSpace(custom.Email)
	}
	return identity, nil
}

func (v *ClerkVerifier) verifyWithKey(ctx context.Context, token string, key *clerk.JSONWebKey) (*clerk.SessionClaims, error) {
	allowed := make(map[string]struct{}, len(v.config.AuthorizedParties))
	for _, party := range v.config.AuthorizedParties {
		if party != "" {
			allowed[party] = struct{}{}
		}
	}
	params := &clerkjwt.VerifyParams{
		Token:                   token,
		JWK:                     key,
		Leeway:                  5 * time.Second,
		CustomClaimsConstructor: func(context.Context) any { return &identityCustomClaims{} },
	}
	if len(allowed) > 0 {
		params.AuthorizedPartyHandler = func(party string) bool {
			_, ok := allowed[party]
			return ok
		}
	}
	return clerkjwt.Verify(ctx, params)
}

func (v *ClerkVerifier) key(ctx context.Context, keyID string) (*clerk.JSONWebKey, bool, error) {
	if v.staticKey != nil {
		return v.staticKey, true, nil
	}
	v.mu.RLock()
	key := v.keys[keyID]
	v.mu.RUnlock()
	if key != nil {
		return key, true, nil
	}
	key, err := clerkjwt.GetJSONWebKey(ctx, &clerkjwt.GetJSONWebKeyParams{KeyID: keyID, JWKSClient: v.jwksClient})
	if err != nil {
		return nil, false, err
	}
	v.mu.Lock()
	v.keys[keyID] = key
	v.mu.Unlock()
	return key, false, nil
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
