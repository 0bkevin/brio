package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	relayauth "github.com/brio/brio/apps/relay/internal/auth"
	"github.com/brio/brio/apps/relay/internal/store"
)

type authContextKey struct{}

type authPrincipal struct {
	User               store.User
	Identity           relayauth.Identity
	Token              string
	ProofKeyThumbprint string
	Scopes             []string
	Mode               string
}

type identityService struct {
	verifier relayauth.IdentityVerifier
	store    store.Store
	devAuth  bool
}

func (s *identityService) authenticate(ctx context.Context, token string) (authPrincipal, error) {
	if s.verifier != nil {
		identity, err := s.verifier.Verify(ctx, token)
		if err == nil {
			user, err := s.store.UpsertIdentity(ctx, identity.Issuer, identity.Subject, identity.Email)
			if err != nil {
				return authPrincipal{}, err
			}
			return authPrincipal{User: user, Identity: identity, Token: token, Mode: "clerk_bearer"}, nil
		}
	}
	if s.devAuth {
		legacy, err := s.store.AuthenticateDevice(ctx, token)
		if err == nil {
			return authPrincipal{
				User:     legacy.User,
				Identity: relayauth.Identity{Issuer: "urn:brio:dev", Subject: legacy.User.ID, Email: legacy.User.Email},
				Token:    token,
				Mode:     "development_device_bearer",
			}, nil
		}
	}
	return authPrincipal{}, store.ErrUnauthorized
}

func (a *app) requireIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			writeAuthError(w, "missing_bearer")
			return
		}
		principal, err := a.identities.authenticate(r.Context(), token)
		if err != nil {
			writeAuthError(w, "invalid_bearer")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), authContextKey{}, principal)))
	})
}

func (a *app) requireDPoP(scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("WWW-Authenticate", "DPoP")
			token := authorizationToken(r, "DPoP")
			if token == "" {
				writeAuthError(w, "invalid_bearer")
				return
			}
			claims, err := a.tokens.Verify(token, a.now())
			if err != nil || !relayauth.HasScope(claims.Scopes, scope) {
				writeAuthError(w, "invalid_bearer")
				return
			}
			proof, err := relayauth.VerifyAndConsumeDPoP(
				r.Context(), a.store, r.Header.Get("DPoP"), r.Method, a.requestURL(r),
				claims.Thumbprint, token, a.now(),
			)
			if err != nil {
				writeAuthError(w, "invalid_dpop")
				return
			}
			principal := authPrincipal{
				User:               store.User{ID: claims.UserID},
				Token:              token,
				ProofKeyThumbprint: proof.Thumbprint,
				Scopes:             claims.Scopes,
				Mode:               "relay_dpop",
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), authContextKey{}, principal)))
		})
	}
}

func authFromContext(ctx context.Context) authPrincipal {
	auth, _ := ctx.Value(authContextKey{}).(authPrincipal)
	return auth
}

func bearerToken(r *http.Request) string {
	return authorizationToken(r, "Bearer")
}

func authorizationToken(r *http.Request, scheme string) string {
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	prefix := scheme + " "
	if !strings.HasPrefix(authorization, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(authorization, prefix))
}

func writeAuthError(w http.ResponseWriter, reason string) {
	writeNoStore(w)
	writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "auth_invalid", "reason": reason})
}

func openStore(ctx context.Context, databaseURL string) (store.Store, error) {
	if strings.TrimSpace(databaseURL) == "" {
		slog.Warn("BRIO_DATABASE_URL is not set; using in-memory relay store for development")
		return store.NewMemoryStore(), nil
	}
	return store.NewPostgresStore(ctx, databaseURL)
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthorized):
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
	case errors.Is(err, store.ErrExpired):
		writeJSON(w, http.StatusGone, map[string]any{"error": "expired"})
	case errors.Is(err, store.ErrUsed):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "already used"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal_error"})
	}
}
