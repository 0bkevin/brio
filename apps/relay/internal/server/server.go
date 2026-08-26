package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	identityauth "github.com/brio/brio/apps/relay/internal/auth"
	"github.com/brio/brio/apps/relay/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"nhooyr.io/websocket"
)

const (
	// Expire relay state before Mobile's five-minute request deadline. This
	// gives the caller a structured terminal frame and avoids retaining work
	// after the client has already abandoned it.
	pendingRequestTTL          = 4*time.Minute + 30*time.Second
	maxPendingRequestsPerAgent = 1024
	maxPendingRequestsPerPeer  = 256
	maxRelayFrameIDLength      = 128
	maxTunnelCredentialLength  = 512
	maxJSONBodyBytes           = 16 * 1024
	maxAgentIDLength           = 128
	maxDisplayNameLength       = 160
	maxEmailLength             = 320
	maxPairingCodeLength       = 64
	requestBodyReadTimeout     = 10 * time.Second
	credentialMutationTimeout  = 10 * time.Second
	peerPingInterval           = 30 * time.Second
	peerPingTimeout            = 10 * time.Second
)

const (
	relayTunnelSubprotocol         = "brio.tunnel.v1"
	mobileAuthSubprotocolPrefix    = "brio.mobile.auth."
	companionAuthSubprotocolPrefix = "brio.companion.auth."
)

type Config struct {
	Addr                   string
	DatabaseURL            string
	AllowedOrigins         []string
	DeviceRegistrationKey  string
	InsecureDevMode        bool
	AllowLegacyQueryTokens bool
	TrustedProxyCIDRs      []string
	ClerkSecretKey         string
	ClerkJWTKey            string
	ClerkIssuer            string
	ClerkJWTAudience       string
	ClerkAuthorizedParties []string
}

type hub struct {
	mu      sync.Mutex
	agents  map[string]map[*peer]bool
	pending map[string]map[string]pendingRequest
}

type pendingRequest struct {
	requester *peer
	companion *peer
	createdAt time.Time
	channel   bool
}

type peer struct {
	id       string
	agentID  string
	deviceID string
	role     string
	conn     *websocket.Conn
	send     chan []byte
	joined   time.Time
}

type app struct {
	cfg            Config
	hub            *hub
	store          store.Store
	identity       identityauth.IdentityVerifier
	peerMu         sync.Mutex
	tunnelWG       sync.WaitGroup
	presenceMu     sync.Mutex
	presenceLocks  map[string]*sync.Mutex
	trustedProxies trustedProxySet
	rateLimiters   map[string]*fixedWindowLimiter
}

type tunnelFrame struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

func Run(ctx context.Context, cfg Config) error {
	identityVerifier, err := newIdentityVerifier(cfg)
	if err != nil {
		return err
	}
	st, err := openStore(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	trustedProxies, err := parseTrustedProxyCIDRs(cfg.TrustedProxyCIDRs)
	if err != nil {
		return err
	}
	a := &app{
		cfg:            cfg,
		hub:            newHub(),
		store:          st,
		identity:       identityVerifier,
		trustedProxies: trustedProxies,
		rateLimiters:   newRelayRateLimiters(),
	}
	if cfg.InsecureDevMode {
		slog.Warn("relay insecure development mode is enabled; email identities are unverified and browser origins are unrestricted")
	}
	if cfg.AllowLegacyQueryTokens {
		slog.Warn("legacy WebSocket query-token authentication is enabled; credentials may appear in infrastructure request logs")
	}
	go a.hub.pruneLoop(ctx)
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(requestLogger)
	router.Use(middleware.Recoverer)
	router.Use(a.requireSecureTransport)
	router.Use(a.cors)
	router.Get("/health", a.health)
	router.Post("/auth/devices", a.rateLimit("device-registration", a.createDevice))
	router.Group(func(r chi.Router) {
		r.Use(a.requireDevice)
		r.Get("/me", a.me)
		r.Get("/devices", a.listDevices)
		r.Delete("/devices/{id}", a.revokeDevice)
		r.Get("/agents", a.listAgents)
		r.Delete("/agents/{id}", a.unlinkAgent)
		r.Post("/enrollments", a.rateLimit("enrollment-create", a.createEnrollment))
		r.Post("/agents/{id}/recover", a.rateLimit("agent-recovery", a.recoverAgent))
		r.Post("/pairings/{code}/claim", a.rateLimit("pairing-claim", a.claimPairing))
	})
	router.Post("/enrollments/{code}/claim", a.rateLimit("enrollment-claim", a.claimEnrollment))
	router.Post("/pairings", a.rateLimit("pairing-create", a.createPairing))
	router.Get("/pairings/{code}", a.rateLimit("pairing-read", a.getPairing))
	router.Get("/tunnel/{role}/{agentID}", a.rateLimit("tunnel-auth", a.tunnel))

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    32 * 1024,
		BaseContext: func(net.Listener) context.Context {
			return ctx
		},
	}
	shutdownDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		a.disconnectAllPeers()
		a.tunnelWG.Wait()
		close(shutdownDone)
	}()

	slog.Info("brio relay listening", "addr", cfg.Addr)
	err = srv.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		if ctx.Err() != nil {
			<-shutdownDone
		}
		return nil
	}
	return err
}

func newIdentityVerifier(cfg Config) (identityauth.IdentityVerifier, error) {
	if strings.TrimSpace(cfg.ClerkSecretKey) == "" && strings.TrimSpace(cfg.ClerkJWTKey) == "" {
		return nil, nil
	}
	verifier, err := identityauth.NewClerkVerifier(identityauth.ClerkConfig{
		SecretKey:         cfg.ClerkSecretKey,
		JWTKey:            cfg.ClerkJWTKey,
		Issuer:            cfg.ClerkIssuer,
		Audience:          cfg.ClerkJWTAudience,
		AuthorizedParties: cfg.ClerkAuthorizedParties,
	})
	if err != nil {
		return nil, fmt.Errorf("configure Clerk authentication: %w", err)
	}
	return verifier, nil
}

func newHub() *hub {
	return &hub{
		agents:  map[string]map[*peer]bool{},
		pending: map[string]map[string]pendingRequest{},
	}
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wrapped := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		requestID := middleware.GetReqID(r.Context())
		if requestID != "" {
			wrapped.Header().Set("X-Request-ID", requestID)
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			responseController := http.NewResponseController(wrapped)
			if err := responseController.SetReadDeadline(time.Now().Add(requestBodyReadTimeout)); err == nil {
				defer responseController.SetReadDeadline(time.Time{})
			}
		}
		started := time.Now()
		next.ServeHTTP(wrapped, r)
		slog.Info("relay request",
			"request_id", requestID,
			"method", r.Method,
			"path", safeRequestLogPath(r.URL.EscapedPath()),
			"status", wrapped.Status(),
			"bytes", wrapped.BytesWritten(),
			"duration", time.Since(started),
		)
	})
}

func (a *app) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && !originAllowed(origin, a.cfg.AllowedOrigins, a.cfg.InsecureDevMode) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "origin is not allowed"})
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, X-Brio-Registration-Key")
		w.Header().Set("Access-Control-Expose-Headers", "Retry-After, X-Request-ID")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.Header().Set("Vary", "Origin")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *app) health(w http.ResponseWriter, r *http.Request) {
	a.hub.mu.Lock()
	agents := len(a.hub.agents)
	peers := 0
	pending := 0
	for _, set := range a.hub.agents {
		peers += len(set)
	}
	for _, requests := range a.hub.pending {
		pending += len(requests)
	}
	a.hub.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"service":          "brio-relay",
		"ok":               true,
		"auth_mode":        a.authMode(),
		"agents":           agents,
		"peers":            peers,
		"pending_requests": pending,
	})
}

func (a *app) createDevice(w http.ResponseWriter, r *http.Request) {
	identityToken := bearerToken(r)
	var verifiedUser *store.User
	if identityToken != "" && a.identity != nil {
		identity, err := a.identity.Verify(r.Context(), identityToken)
		if err != nil {
			if !secretEqual(deviceRegistrationKey(r), a.cfg.DeviceRegistrationKey) {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "identity token is invalid"})
				return
			}
		} else {
			user, err := a.store.UpsertIdentity(r.Context(), identity.Issuer, identity.Subject, identity.Email)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "could not persist verified identity"})
				return
			}
			verifiedUser = &user
		}
	}
	registrationAuthorized := secretEqual(deviceRegistrationKey(r), a.cfg.DeviceRegistrationKey)
	if verifiedUser == nil && a.identity != nil && identityToken == "" && !registrationAuthorized {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "verified identity bearer token is required"})
		return
	}
	if verifiedUser == nil && a.cfg.DeviceRegistrationKey == "" && !a.cfg.InsecureDevMode {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "verified account authentication is not configured; unverified email sign-in is disabled",
		})
		return
	}
	if verifiedUser == nil && a.cfg.DeviceRegistrationKey != "" && !registrationAuthorized {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "device registration is not authorized"})
		return
	}
	var body struct {
		Email      string `json:"email"`
		DeviceName string `json:"device_name"`
	}
	if !decodeJSONBody(w, r, &body, false) {
		return
	}
	body.Email = strings.TrimSpace(body.Email)
	body.DeviceName = strings.TrimSpace(body.DeviceName)
	if !fieldLengthAllowed(w, "email", body.Email, maxEmailLength) ||
		!fieldLengthAllowed(w, "device_name", body.DeviceName, maxDisplayNameLength) {
		return
	}
	var user store.User
	var device store.Device
	var token string
	var err error
	if verifiedUser != nil {
		user, device, token, err = a.store.CreateDeviceTokenForUser(r.Context(), verifiedUser.ID, body.DeviceName)
	} else {
		user, device, token, err = a.store.CreateDeviceToken(r.Context(), body.Email, body.DeviceName)
	}
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": user, "device": device, "token": token})
}

func (a *app) me(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	writeJSON(w, http.StatusOK, auth)
}

func (a *app) listDevices(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	devices, err := a.store.ListDevices(r.Context(), auth.User.ID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (a *app) revokeDevice(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	mutationCtx, cancel := context.WithTimeout(r.Context(), credentialMutationTimeout)
	defer cancel()
	a.peerMu.Lock()
	device, err := a.store.RevokeDevice(mutationCtx, auth.User.ID, strings.TrimSpace(chi.URLParam(r, "id")))
	if err == nil {
		a.hub.disconnectDevice(device.ID)
	}
	a.peerMu.Unlock()
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": device})
}

func (a *app) listAgents(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	agents, err := a.store.ListAgents(r.Context(), auth.User.ID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": agents})
}

func (a *app) unlinkAgent(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	agentID := strings.TrimSpace(chi.URLParam(r, "id"))
	if agentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "agent id is required"})
		return
	}
	if !fieldLengthAllowed(w, "agent id", agentID, maxAgentIDLength) || !agentIDCharactersAllowed(w, agentID) {
		return
	}
	mutationCtx, cancel := context.WithTimeout(r.Context(), credentialMutationTimeout)
	defer cancel()
	a.peerMu.Lock()
	agent, err := a.store.UnlinkAgent(mutationCtx, auth.User.ID, agentID)
	if err == nil {
		a.hub.disconnectAgent(agentID)
	}
	a.peerMu.Unlock()
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent": agent})
}

func (a *app) createEnrollment(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	var body struct {
		Name string `json:"name"`
	}
	if !decodeJSONBody(w, r, &body, true) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if !fieldLengthAllowed(w, "name", body.Name, maxDisplayNameLength) {
		return
	}
	enrollment, err := a.store.CreateEnrollment(r.Context(), auth.User.ID, body.Name, 15*time.Minute)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, enrollment)
}

func (a *app) claimEnrollment(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "code")))
	if !fieldLengthAllowed(w, "code", code, maxPairingCodeLength) {
		return
	}
	var body struct {
		AgentID string `json:"agent_id"`
		Name    string `json:"name"`
	}
	if !decodeJSONBody(w, r, &body, false) {
		return
	}
	body.AgentID = strings.TrimSpace(body.AgentID)
	body.Name = strings.TrimSpace(body.Name)
	if body.AgentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "agent_id is required"})
		return
	}
	if !fieldLengthAllowed(w, "agent_id", body.AgentID, maxAgentIDLength) ||
		!agentIDCharactersAllowed(w, body.AgentID) ||
		!fieldLengthAllowed(w, "name", body.Name, maxDisplayNameLength) {
		return
	}
	mutationCtx, cancel := context.WithTimeout(r.Context(), credentialMutationTimeout)
	defer cancel()
	a.peerMu.Lock()
	agent, relayToken, err := a.store.ClaimEnrollment(mutationCtx, code, body.AgentID, body.Name)
	if err == nil {
		a.hub.disconnectCompanions(agent.ID)
	}
	a.peerMu.Unlock()
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"agent":       agent,
		"relay_token": relayToken,
	})
}

func (a *app) recoverAgent(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	agentID := strings.TrimSpace(chi.URLParam(r, "id"))
	if agentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "agent id is required"})
		return
	}
	if !fieldLengthAllowed(w, "agent id", agentID, maxAgentIDLength) || !agentIDCharactersAllowed(w, agentID) {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if !decodeJSONBody(w, r, &body, true) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if !fieldLengthAllowed(w, "name", body.Name, maxDisplayNameLength) {
		return
	}
	mutationCtx, cancel := context.WithTimeout(r.Context(), credentialMutationTimeout)
	defer cancel()
	a.peerMu.Lock()
	p, err := a.store.RecoverPairing(mutationCtx, auth.User.ID, agentID, body.Name, 10*time.Minute)
	if err == nil {
		a.hub.disconnectCompanions(agentID)
	}
	a.peerMu.Unlock()
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (a *app) createPairing(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AgentID string `json:"agent_id"`
		Name    string `json:"name"`
	}
	if !decodeJSONBody(w, r, &body, false) {
		return
	}
	body.AgentID = strings.TrimSpace(body.AgentID)
	body.Name = strings.TrimSpace(body.Name)
	if body.AgentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "agent_id is required"})
		return
	}
	if !fieldLengthAllowed(w, "agent_id", body.AgentID, maxAgentIDLength) ||
		!agentIDCharactersAllowed(w, body.AgentID) ||
		!fieldLengthAllowed(w, "name", body.Name, maxDisplayNameLength) {
		return
	}
	if body.Name == "" {
		body.Name = "Hermes"
	}
	mutationCtx, cancel := context.WithTimeout(r.Context(), credentialMutationTimeout)
	defer cancel()
	a.peerMu.Lock()
	p, err := a.store.CreatePairing(mutationCtx, body.AgentID, body.Name, 10*time.Minute, bearerToken(r))
	if err == nil {
		a.hub.disconnectCompanions(body.AgentID)
	}
	a.peerMu.Unlock()
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (a *app) getPairing(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "code")))
	if !fieldLengthAllowed(w, "code", code, maxPairingCodeLength) {
		return
	}
	p, err := a.store.GetPairing(r.Context(), code)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (a *app) claimPairing(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	code := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "code")))
	if !fieldLengthAllowed(w, "code", code, maxPairingCodeLength) {
		return
	}
	agent, err := a.store.ClaimPairing(r.Context(), code, auth.User.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent": agent})
}

func (a *app) tunnel(w http.ResponseWriter, r *http.Request) {
	a.tunnelWG.Add(1)
	defer a.tunnelWG.Done()

	role := chi.URLParam(r, "role")
	if role != "mobile" && role != "companion" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "role must be mobile or companion"})
		return
	}
	agentID := strings.TrimSpace(chi.URLParam(r, "agentID"))
	if agentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "agent id is required"})
		return
	}
	if !fieldLengthAllowed(w, "agent id", agentID, maxAgentIDLength) || !agentIDCharactersAllowed(w, agentID) {
		return
	}
	deviceID := ""
	token, selectedSubprotocol, credentialErr := tunnelCredential(r, role, a.cfg.AllowLegacyQueryTokens)
	if credentialErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid tunnel credential transport"})
		return
	}
	if role == "mobile" {
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing device token"})
			return
		}
		auth, err := a.store.AuthenticateDevice(r.Context(), token)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		ok, err := a.store.UserCanAccessAgent(r.Context(), auth.User.ID, agentID)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if !ok {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "device cannot access agent"})
			return
		}
		deviceID = auth.Device.ID
	} else {
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing companion token"})
			return
		}
		if err := a.store.AuthenticateCompanion(r.Context(), agentID, token); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	peerID := role + "_" + store.RandomCode(24)
	acceptOptions := websocketAcceptOptions(a.cfg.AllowedOrigins, a.cfg.InsecureDevMode)
	if selectedSubprotocol != "" {
		acceptOptions.Subprotocols = []string{selectedSubprotocol}
	}
	conn, err := websocket.Accept(w, r, acceptOptions)
	if err != nil {
		return
	}
	conn.SetReadLimit(12 * 1024 * 1024)
	p := &peer{
		id:       peerID,
		agentID:  agentID,
		deviceID: deviceID,
		role:     role,
		conn:     conn,
		send:     make(chan []byte, 64),
		joined:   time.Now().UTC(),
	}
	if err := a.revalidateAndAddPeer(r.Context(), p, token); err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, "credential is no longer valid")
		return
	}
	defer a.removePeer(p)
	slog.Info("relay tunnel connected", "agent_id", p.agentID, "peer_id", p.id, "role", p.role)
	defer func() {
		slog.Info("relay tunnel disconnected", "agent_id", p.agentID, "peer_id", p.id, "role", p.role, "connected_for", time.Since(p.joined))
	}()

	ctx := r.Context()
	go p.writeLoop(ctx)
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText && typ != websocket.MessageBinary {
			continue
		}
		a.routePeer(p, data)
	}
}

func (a *app) routePeer(p *peer, data []byte) {
	var frame tunnelFrame
	parseErr := json.Unmarshal(data, &frame)
	a.peerMu.Lock()
	defer a.peerMu.Unlock()
	a.hub.routeFrame(p, data, frame, parseErr)
}

func (a *app) disconnectAllPeers() {
	a.peerMu.Lock()
	defer a.peerMu.Unlock()
	a.hub.disconnectMatching(func(*peer) bool { return true })
}

func (a *app) addPeer(ctx context.Context, p *peer) {
	a.peerMu.Lock()
	a.hub.replaceSession(p)
	a.peerMu.Unlock()
	a.updateAgentPresence(ctx, p)
}

func (a *app) removePeer(p *peer) {
	a.peerMu.Lock()
	a.hub.remove(p)
	a.peerMu.Unlock()
	a.updateAgentPresence(context.Background(), p)
}

func (a *app) revalidateAndAddPeer(ctx context.Context, p *peer, token string) error {
	authCtx, cancel := context.WithTimeout(ctx, credentialMutationTimeout)
	defer cancel()
	a.peerMu.Lock()

	if p.role == "mobile" {
		auth, err := a.store.AuthenticateDevice(authCtx, token)
		if err != nil {
			a.peerMu.Unlock()
			return err
		}
		ok, err := a.store.UserCanAccessAgent(authCtx, auth.User.ID, p.agentID)
		if err != nil {
			a.peerMu.Unlock()
			return err
		}
		if !ok || auth.Device.ID != p.deviceID {
			a.peerMu.Unlock()
			return store.ErrUnauthorized
		}
	} else if err := a.store.AuthenticateCompanion(authCtx, p.agentID, token); err != nil {
		a.peerMu.Unlock()
		return err
	}

	a.hub.replaceSession(p)
	a.peerMu.Unlock()
	a.updateAgentPresence(ctx, p)
	return nil
}

func (a *app) updateAgentPresence(ctx context.Context, p *peer) {
	if p.role != "companion" {
		return
	}
	presenceLock := a.presenceLock(p.agentID)
	presenceLock.Lock()
	defer presenceLock.Unlock()

	a.peerMu.Lock()
	status := "offline"
	if a.hub.hasCompanion(p.agentID) {
		status = "online"
	}
	a.peerMu.Unlock()
	touchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := a.store.TouchAgent(touchCtx, p.agentID, status); err != nil && !errors.Is(err, store.ErrNotFound) {
		slog.Error("could not update relay agent presence", "agent_id", p.agentID, "status", status, "error_type", fmt.Sprintf("%T", err))
	}
}

func (a *app) presenceLock(agentID string) *sync.Mutex {
	a.presenceMu.Lock()
	defer a.presenceMu.Unlock()
	if a.presenceLocks == nil {
		a.presenceLocks = map[string]*sync.Mutex{}
	}
	lock := a.presenceLocks[agentID]
	if lock == nil {
		lock = &sync.Mutex{}
		a.presenceLocks[agentID] = lock
	}
	return lock
}

func (h *hub) add(p *peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.agents[p.agentID] == nil {
		h.agents[p.agentID] = map[*peer]bool{}
	}
	h.agents[p.agentID][p] = true
}

func (h *hub) remove(p *peer) bool {
	h.mu.Lock()
	removed := h.removeLocked(p)
	h.mu.Unlock()
	if removed && p.conn != nil {
		_ = p.conn.CloseNow()
	}
	return removed
}

func (h *hub) removeLocked(p *peer) bool {
	removed := false
	if peers := h.agents[p.agentID]; peers != nil {
		if _, ok := peers[p]; ok {
			delete(peers, p)
			close(p.send)
			removed = true
		}
		if len(peers) == 0 {
			delete(h.agents, p.agentID)
		}
	}
	if requests := h.pending[p.agentID]; requests != nil {
		for id, req := range requests {
			switch {
			case req.requester == p:
				if req.channel {
					h.enqueueLocked(req.companion, mustJSON(tunnelFrame{Type: "channel_close", ID: id}))
				}
				delete(requests, id)
			case req.companion == p:
				delete(requests, id)
				if req.channel {
					h.enqueueLocked(req.requester, channelErrorFrame(id, "COMPANION_DISCONNECTED", "companion disconnected while the channel was open"))
				} else {
					h.enqueueLocked(req.requester, errorFrame(id, "COMPANION_DISCONNECTED", "companion disconnected before responding"))
				}
			}
		}
		if len(requests) == 0 {
			delete(h.pending, p.agentID)
		}
	}
	return removed
}

func (h *hub) hasCompanion(agentID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for p := range h.agents[agentID] {
		if p.role == "companion" {
			return true
		}
	}
	return false
}

func (h *hub) disconnectDevice(deviceID string) {
	if deviceID == "" {
		return
	}
	h.disconnectMatching(func(p *peer) bool {
		return p.role == "mobile" && p.deviceID == deviceID
	})
}

func (h *hub) disconnectCompanions(agentID string) {
	if agentID == "" {
		return
	}
	h.disconnectMatching(func(p *peer) bool {
		return p.role == "companion" && p.agentID == agentID
	})
}

func (h *hub) disconnectAgent(agentID string) {
	if agentID == "" {
		return
	}
	h.disconnectMatching(func(p *peer) bool {
		return p.agentID == agentID
	})
}

// replaceSession keeps one active connector for an agent and one active
// Mobile socket for a device/agent pair. Reconnect overlap is normal, but old
// sockets must not keep consuming queues or receive newly routed work.
func (h *hub) replaceSession(next *peer) {
	h.mu.Lock()
	var replaced []*peer
	for current := range h.agents[next.agentID] {
		matchesCompanion := next.role == "companion" && current.role == "companion"
		matchesMobile := next.role == "mobile" && current.role == "mobile" &&
			next.deviceID != "" && current.deviceID == next.deviceID
		if matchesCompanion || matchesMobile {
			replaced = append(replaced, current)
		}
	}
	for _, current := range replaced {
		h.removeLocked(current)
	}
	if h.agents[next.agentID] == nil {
		h.agents[next.agentID] = map[*peer]bool{}
	}
	h.agents[next.agentID][next] = true
	h.mu.Unlock()
	for _, current := range replaced {
		if current.conn != nil {
			_ = current.conn.CloseNow()
		}
	}
}

func (h *hub) disconnectMatching(matches func(*peer) bool) {
	h.mu.Lock()
	var peers []*peer
	for _, set := range h.agents {
		for p := range set {
			if matches(p) {
				peers = append(peers, p)
			}
		}
	}
	for _, p := range peers {
		h.removeLocked(p)
	}
	h.mu.Unlock()
	for _, p := range peers {
		if p.conn != nil {
			_ = p.conn.CloseNow()
		}
	}
}

func (h *hub) route(from *peer, data []byte) {
	var frame tunnelFrame
	parseErr := json.Unmarshal(data, &frame)
	h.routeFrame(from, data, frame, parseErr)
}

func (h *hub) routeFrame(from *peer, data []byte, frame tunnelFrame, parseErr error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.isConnectedLocked(from) {
		return
	}
	if parseErr != nil {
		h.enqueueLocked(from, errorFrame("", "BAD_FRAME", "frame must be valid JSON"))
		return
	}
	if frame.Type == "" {
		h.enqueueLocked(from, errorFrame(frame.ID, "BAD_FRAME", "frame type is required"))
		return
	}
	if frame.Type == "ping" {
		h.enqueueLocked(from, mustJSON(tunnelFrame{Type: "pong", ID: frame.ID}))
		return
	}
	if frame.Type == "pong" {
		return
	}
	if frame.ID == "" {
		h.enqueueLocked(from, errorFrame("", "BAD_FRAME", "frame id is required"))
		return
	}
	if len(frame.ID) > maxRelayFrameIDLength {
		h.enqueueLocked(from, errorFrame("", "BAD_FRAME", "frame id is too long"))
		return
	}
	now := time.Now().UTC()
	h.pruneLocked(now)

	switch from.role {
	case "mobile":
		if frame.Type == "channel_data" || frame.Type == "channel_close" {
			requests := h.pending[from.agentID]
			req, ok := requests[frame.ID]
			if !ok || !req.channel || req.requester != from {
				h.enqueueLocked(from, channelErrorFrame(frame.ID, "CHANNEL_NOT_OPEN", "channel is not open"))
				return
			}
			req.createdAt = now
			requests[frame.ID] = req
			if !h.enqueueLocked(req.companion, data) {
				delete(requests, frame.ID)
				h.enqueueLocked(from, channelErrorFrame(frame.ID, "COMPANION_BACKPRESSURE", "companion is not accepting channel frames"))
				if len(requests) == 0 {
					delete(h.pending, from.agentID)
				}
				return
			}
			if frame.Type == "channel_close" {
				delete(requests, frame.ID)
				if len(requests) == 0 {
					delete(h.pending, from.agentID)
				}
			}
			return
		}
		if frame.Type != "request" && frame.Type != "channel_open" {
			h.enqueueLocked(from, errorFrame(frame.ID, "BAD_FRAME", "mobile clients may only send request or channel frames"))
			return
		}
		companion := h.selectCompanionLocked(from.agentID)
		if companion == nil {
			if frame.Type == "channel_open" {
				h.enqueueLocked(from, channelErrorFrame(frame.ID, "AGENT_OFFLINE", "no companion is connected for this agent"))
			} else {
				h.enqueueLocked(from, errorFrame(frame.ID, "AGENT_OFFLINE", "no companion is connected for this agent"))
			}
			return
		}
		if h.pending[from.agentID] == nil {
			h.pending[from.agentID] = map[string]pendingRequest{}
		}
		if _, exists := h.pending[from.agentID][frame.ID]; exists {
			if frame.Type == "channel_open" {
				h.enqueueLocked(from, channelErrorFrame(frame.ID, "DUPLICATE_CHANNEL_ID", "a relay channel with this id is already open"))
			} else {
				h.enqueueLocked(from, errorFrame(frame.ID, "DUPLICATE_REQUEST_ID", "a relay request with this frame id is already pending"))
			}
			return
		}
		if len(h.pending[from.agentID]) >= maxPendingRequestsPerAgent || h.pendingForPeerLocked(from) >= maxPendingRequestsPerPeer {
			if frame.Type == "channel_open" {
				h.enqueueLocked(from, channelErrorFrame(frame.ID, "RELAY_BACKPRESSURE", "too many relay channels or requests are open"))
			} else {
				h.enqueueLocked(from, errorFrame(frame.ID, "RELAY_BACKPRESSURE", "too many relay requests are pending"))
			}
			return
		}
		h.pending[from.agentID][frame.ID] = pendingRequest{
			requester: from,
			companion: companion,
			createdAt: now,
			channel:   frame.Type == "channel_open",
		}
		if !h.enqueueLocked(companion, data) {
			delete(h.pending[from.agentID], frame.ID)
			if len(h.pending[from.agentID]) == 0 {
				delete(h.pending, from.agentID)
			}
			if frame.Type == "channel_open" {
				h.enqueueLocked(from, channelErrorFrame(frame.ID, "COMPANION_BACKPRESSURE", "companion is not accepting channel frames"))
			} else {
				h.enqueueLocked(from, errorFrame(frame.ID, "COMPANION_BACKPRESSURE", "companion is not accepting relay frames"))
			}
		}
	case "companion":
		requests := h.pending[from.agentID]
		req, ok := requests[frame.ID]
		if !ok {
			return
		}
		if req.companion != from {
			return
		}
		if req.channel {
			if !isCompanionChannelFrame(frame.Type) {
				h.enqueueLocked(from, channelErrorFrame(frame.ID, "BAD_FRAME", "companion sent an invalid channel frame"))
				return
			}
			req.createdAt = now
			requests[frame.ID] = req
			delivered := h.enqueueLocked(req.requester, data)
			if !delivered {
				// The requester can no longer consume this stream. Best-effort a
				// close back to the connector so its upstream Hermes socket is not
				// left alive after Relay drops the channel for backpressure.
				h.enqueueLocked(from, mustJSON(tunnelFrame{Type: "channel_close", ID: frame.ID}))
			}
			if !delivered || isTerminalChannelFrame(frame.Type) {
				delete(requests, frame.ID)
			}
		} else {
			if !isCompanionResponseFrame(frame.Type) {
				h.enqueueLocked(from, errorFrame(frame.ID, "BAD_FRAME", "companion clients may only send response, stream, or error frames"))
				return
			}
			if !h.enqueueLocked(req.requester, data) || isTerminalFrame(frame.Type) {
				delete(requests, frame.ID)
			}
		}
		if _, exists := requests[frame.ID]; !exists {
			if len(requests) == 0 {
				delete(h.pending, from.agentID)
			}
		}
	}
}

func (h *hub) isConnectedLocked(p *peer) bool {
	return p != nil && h.agents[p.agentID][p]
}

func (h *hub) pendingForPeerLocked(p *peer) int {
	count := 0
	for _, request := range h.pending[p.agentID] {
		if request.requester == p {
			count++
		}
	}
	return count
}

func (h *hub) pruneLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			h.mu.Lock()
			h.pruneLocked(now.UTC())
			h.mu.Unlock()
		}
	}
}

func (h *hub) pruneLocked(now time.Time) {
	for agentID, requests := range h.pending {
		for id, req := range requests {
			if req.channel {
				continue
			}
			if now.Sub(req.createdAt) <= pendingRequestTTL {
				continue
			}
			delete(requests, id)
			h.enqueueLocked(req.requester, errorFrame(id, "REQUEST_EXPIRED", "relay request expired before the companion responded"))
		}
		if len(requests) == 0 {
			delete(h.pending, agentID)
		}
	}
}

func (h *hub) selectCompanionLocked(agentID string) *peer {
	var selected *peer
	for p := range h.agents[agentID] {
		if p.role != "companion" {
			continue
		}
		if selected == nil || p.joined.After(selected.joined) {
			selected = p
		}
	}
	return selected
}

func (h *hub) enqueue(p *peer, data []byte) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.enqueueLocked(p, data)
}

func (h *hub) enqueueLocked(p *peer, data []byte) bool {
	if p == nil {
		return false
	}
	select {
	case p.send <- data:
		return true
	default:
		return false
	}
}

func (p *peer) writeLoop(ctx context.Context) {
	ticker := time.NewTicker(peerPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case data, ok := <-p.send:
			if !ok {
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := p.conn.Write(writeCtx, websocket.MessageText, data)
			cancel()
			if err != nil {
				_ = p.conn.CloseNow()
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, peerPingTimeout)
			err := p.conn.Ping(pingCtx)
			cancel()
			if err != nil {
				_ = p.conn.CloseNow()
				return
			}
		}
	}
}

func isCompanionResponseFrame(frameType string) bool {
	return frameType == "response" || frameType == "stream_chunk" || frameType == "stream_end" || frameType == "error"
}

func isTerminalFrame(frameType string) bool {
	return frameType == "response" || frameType == "stream_end" || frameType == "error"
}

func isCompanionChannelFrame(frameType string) bool {
	return frameType == "channel_opened" || frameType == "channel_data" || frameType == "channel_close" || frameType == "channel_error"
}

func isTerminalChannelFrame(frameType string) bool {
	return frameType == "channel_close" || frameType == "channel_error"
}

func errorFrame(id string, code string, message string) []byte {
	return mustJSON(tunnelFrame{Type: "error", ID: id, Code: code, Message: message})
}

func channelErrorFrame(id string, code string, message string) []byte {
	return mustJSON(tunnelFrame{Type: "channel_error", ID: id, Code: code, Message: message})
}

func mustJSON(v any) []byte {
	data, _ := json.Marshal(v)
	return data
}

func originAllowed(origin string, allowed []string, insecureDevMode bool) bool {
	if len(allowed) == 0 {
		return insecureDevMode
	}
	normalizedOrigin := normalizeOrigin(origin)
	originHost := originHostPattern(origin)
	for _, item := range allowed {
		item = strings.TrimSpace(item)
		if item == "*" {
			return insecureDevMode
		}
		if strings.Contains(item, "://") {
			if normalizeOrigin(item) == normalizedOrigin {
				return true
			}
			continue
		}
		if hostPatternMatches(item, originHost) {
			return true
		}
	}
	return false
}

func websocketAcceptOptions(allowed []string, insecureDevMode bool) *websocket.AcceptOptions {
	if insecureDevMode && (len(allowed) == 0 || containsWildcardOrigin(allowed)) {
		return &websocket.AcceptOptions{InsecureSkipVerify: true}
	}
	return &websocket.AcceptOptions{OriginPatterns: websocketOriginPatterns(allowed)}
}

func (a *app) authMode() string {
	if a.identity != nil && a.cfg.DeviceRegistrationKey != "" {
		return "clerk_or_registration_key"
	}
	if a.identity != nil {
		return "clerk"
	}
	if a.cfg.DeviceRegistrationKey != "" {
		return "registration_key"
	}
	if a.cfg.InsecureDevMode {
		return "insecure_development"
	}
	return "disabled"
}

func websocketOriginPatterns(allowed []string) []string {
	out := make([]string, 0, len(allowed))
	for _, origin := range allowed {
		value := strings.TrimSpace(origin)
		if value == "" || value == "*" {
			continue
		}
		if pattern := originHostPattern(value); pattern != "" {
			out = append(out, pattern)
		}
	}
	return out
}

func containsWildcardOrigin(allowed []string) bool {
	for _, origin := range allowed {
		if strings.TrimSpace(origin) == "*" {
			return true
		}
	}
	return false
}

func normalizeOrigin(origin string) string {
	value := strings.TrimRight(strings.TrimSpace(origin), "/")
	u, err := url.Parse(value)
	if err == nil && u.Scheme != "" && u.Host != "" {
		return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
	}
	return value
}

func originHostPattern(origin string) string {
	value := strings.TrimRight(strings.TrimSpace(origin), "/")
	u, err := url.Parse(value)
	if err == nil && u.Host != "" {
		return strings.ToLower(u.Host)
	}
	return strings.ToLower(value)
}

func hostPatternMatches(pattern string, host string) bool {
	if pattern == "" || host == "" {
		return false
	}
	matched, err := filepath.Match(strings.ToLower(pattern), strings.ToLower(host))
	return err == nil && matched
}

func deviceRegistrationKey(r *http.Request) string {
	if key := strings.TrimSpace(r.Header.Get("X-Brio-Registration-Key")); key != "" {
		return key
	}
	return bearerToken(r)
}

func tunnelCredential(r *http.Request, role string, allowLegacyQueryTokens bool) (token string, selectedSubprotocol string, err error) {
	if token := bearerToken(r); token != "" {
		if len(token) > maxTunnelCredentialLength {
			return "", "", errors.New("tunnel credential is too long")
		}
		return token, "", nil
	}
	prefix := mobileAuthSubprotocolPrefix
	if role == "companion" {
		prefix = companionAuthSubprotocolPrefix
	}
	offeredProtocols := map[string]bool{}
	credential := ""
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, offered := range strings.Split(header, ",") {
			offered = strings.TrimSpace(offered)
			offeredProtocols[offered] = true
			if candidate := strings.TrimPrefix(offered, prefix); candidate != offered && candidate != "" {
				if credential != "" || len(candidate) > maxTunnelCredentialLength {
					return "", "", errors.New("ambiguous or oversized tunnel credential")
				}
				credential = candidate
			}
		}
	}
	if offeredProtocols[relayTunnelSubprotocol] && credential != "" {
		// Echo only the fixed protocol, never the credential-bearing offer.
		return credential, relayTunnelSubprotocol, nil
	}
	if allowLegacyQueryTokens {
		// Explicit migration-only compatibility for already-released clients.
		// Current clients use Authorization (connector) or a negotiated WebSocket
		// subprotocol (mobile) so long-lived credentials do not appear in URLs.
		credential = strings.TrimSpace(r.URL.Query().Get("token"))
		if len(credential) > maxTunnelCredentialLength {
			return "", "", errors.New("tunnel credential is too long")
		}
		return credential, "", nil
	}
	return "", "", nil
}

func secretEqual(got string, want string) bool {
	if got == "" || want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, destination any, allowEmpty bool) bool {
	if r.Body == nil {
		if allowEmpty {
			return true
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "JSON body is required"})
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		if allowEmpty && errors.Is(err, io.EOF) {
			return true
		}
		writeJSONDecodeError(w, err)
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeJSONDecodeError(w, err)
		return false
	}
	return true
}

func safeRequestLogPath(path string) string {
	segments := strings.Split(path, "/")
	if len(segments) >= 3 && (segments[1] == "enrollments" || segments[1] == "pairings") {
		segments[2] = ":code"
	}
	return strings.Join(segments, "/")
}

func writeJSONDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "JSON body is too large"})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
}

func fieldLengthAllowed(w http.ResponseWriter, field string, value string, maximum int) bool {
	if len(value) <= maximum {
		return true
	}
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": fmt.Sprintf("%s is too long", field)})
	return false
}

func agentIDCharactersAllowed(w http.ResponseWriter, value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) || strings.ContainsRune(`/\\?#`, character) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "agent id contains unsupported characters"})
			return false
		}
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
