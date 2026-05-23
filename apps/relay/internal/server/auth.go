package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/brio/brio/apps/relay/internal/store"
)

type authContextKey struct{}

func (a *app) requireDevice(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing bearer token"})
			return
		}
		auth, err := a.store.AuthenticateDevice(r.Context(), token)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		ctx := context.WithValue(r.Context(), authContextKey{}, auth)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func authFromContext(ctx context.Context) store.Auth {
	auth, _ := ctx.Value(authContextKey{}).(store.Auth)
	return auth
}

func bearerToken(r *http.Request) string {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(auth, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
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
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
	}
}
