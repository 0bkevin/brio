package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/brio/brio/apps/relay/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"nhooyr.io/websocket"
)

const pendingRequestTTL = 6 * time.Minute

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
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	slog.Info("brio relay listening", "addr", cfg.Addr)
	err = srv.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
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
		started := time.Now()
		next.ServeHTTP(wrapped, r)
		slog.Info("relay request",
			"request_id", middleware.GetReqID(r.Context()),
			"method", r.Method,
			"path", r.URL.EscapedPath(),
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
	if a.cfg.DeviceRegistrationKey == "" && !a.cfg.InsecureDevMode {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": "verified account authentication is not configured; unverified email sign-in is disabled",
		})
		return
	}
	if a.cfg.DeviceRegistrationKey != "" && !secretEqual(deviceRegistrationKey(r), a.cfg.DeviceRegistrationKey) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "device registration is not authorized"})
		return
	}
	var body struct {
		Email      string `json:"email"`
		DeviceName string `json:"device_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	user, device, token, err := a.store.CreateDeviceToken(r.Context(), body.Email, body.DeviceName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
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
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (a *app) revokeDevice(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	device, err := a.store.RevokeDevice(r.Context(), auth.User.ID, strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.hub.disconnectDevice(device.ID)
	writeJSON(w, http.StatusOK, map[string]any{"device": device})
}

func (a *app) listAgents(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	agents, err := a.store.ListAgents(r.Context(), auth.User.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": agents})
}

func (a *app) createEnrollment(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	var body struct {
		Name string `json:"name"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
			return
		}
	}
	enrollment, err := a.store.CreateEnrollment(r.Context(), auth.User.ID, body.Name, 15*time.Minute)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, enrollment)
}

func (a *app) claimEnrollment(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "code")))
	var body struct {
		AgentID string `json:"agent_id"`
		Name    string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	body.AgentID = strings.TrimSpace(body.AgentID)
	if body.AgentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "agent_id is required"})
		return
	}
	agent, relayToken, err := a.store.ClaimEnrollment(r.Context(), code, body.AgentID, body.Name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.hub.disconnectCompanions(agent.ID)
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
	var body struct {
		Name string `json:"name"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
			return
		}
	}
	p, err := a.store.RecoverPairing(r.Context(), auth.User.ID, agentID, body.Name, 10*time.Minute)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.hub.disconnectCompanions(agentID)
	writeJSON(w, http.StatusCreated, p)
}

func (a *app) createPairing(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AgentID string `json:"agent_id"`
		Name    string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	body.AgentID = strings.TrimSpace(body.AgentID)
	if body.AgentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "agent_id is required"})
		return
	}
	if body.Name == "" {
		body.Name = "Hermes"
	}
	p, err := a.store.CreatePairing(r.Context(), body.AgentID, body.Name, 10*time.Minute, bearerToken(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	a.hub.disconnectCompanions(body.AgentID)
	writeJSON(w, http.StatusCreated, p)
}

func (a *app) getPairing(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "code")))
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
	agent, err := a.store.ClaimPairing(r.Context(), code, auth.User.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent": agent})
}

func (a *app) tunnel(w http.ResponseWriter, r *http.Request) {
	role := chi.URLParam(r, "role")
	if role != "mobile" && role != "companion" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "role must be mobile or companion"})
		return
	}
	agentID := chi.URLParam(r, "agentID")
	if agentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "agent id is required"})
		return
	}
	deviceID := ""
	token, selectedSubprotocol := tunnelCredential(r, role, a.cfg.AllowLegacyQueryTokens)
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
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
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
		id:       role + "_" + store.RandomCode(24),
		agentID:  agentID,
		deviceID: deviceID,
		role:     role,
		conn:     conn,
		send:     make(chan []byte, 64),
		joined:   time.Now().UTC(),
	}
	a.addPeer(r.Context(), p)
	defer a.removePeer(p)

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
		a.hub.route(p, data)
	}
}

func (a *app) addPeer(ctx context.Context, p *peer) {
	a.hub.add(p)
	if p.role == "companion" {
		_ = a.store.TouchAgent(ctx, p.agentID, "online")
	}
}

func (a *app) removePeer(p *peer) {
	a.hub.remove(p)
	if p.role == "companion" && !a.hub.hasCompanion(p.agentID) {
		_ = a.store.TouchAgent(context.Background(), p.agentID, "offline")
	}
}

func (h *hub) add(p *peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.agents[p.agentID] == nil {
		h.agents[p.agentID] = map[*peer]bool{}
	}
	h.agents[p.agentID][p] = true
}

func (h *hub) remove(p *peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if peers := h.agents[p.agentID]; peers != nil {
		if _, ok := peers[p]; ok {
			delete(peers, p)
			close(p.send)
		}
		if len(peers) == 0 {
			delete(h.agents, p.agentID)
		}
	}
	if requests := h.pending[p.agentID]; requests != nil {
		for id, req := range requests {
			switch {
			case req.requester == p:
				delete(requests, id)
			case req.companion == p:
				delete(requests, id)
				h.enqueueLocked(req.requester, errorFrame(id, "COMPANION_DISCONNECTED", "companion disconnected before responding"))
			}
		}
		if len(requests) == 0 {
			delete(h.pending, p.agentID)
		}
	}
	if p.conn != nil {
		_ = p.conn.Close(websocket.StatusNormalClosure, "bye")
	}
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
	for _, p := range h.matchingPeers(func(p *peer) bool {
		return p.role == "mobile" && p.deviceID == deviceID
	}) {
		h.remove(p)
	}
}

func (h *hub) disconnectCompanions(agentID string) {
	if agentID == "" {
		return
	}
	for _, p := range h.matchingPeers(func(p *peer) bool {
		return p.role == "companion" && p.agentID == agentID
	}) {
		h.remove(p)
	}
}

func (h *hub) matchingPeers(matches func(*peer) bool) []*peer {
	h.mu.Lock()
	defer h.mu.Unlock()
	var peers []*peer
	for _, set := range h.agents {
		for p := range set {
			if matches(p) {
				peers = append(peers, p)
			}
		}
	}
	return peers
}

func (h *hub) route(from *peer, data []byte) {
	var frame tunnelFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		h.enqueue(from, errorFrame("", "BAD_FRAME", "frame must be valid JSON"))
		return
	}
	if frame.Type == "" {
		h.enqueue(from, errorFrame(frame.ID, "BAD_FRAME", "frame type is required"))
		return
	}
	if frame.Type == "ping" {
		h.enqueue(from, mustJSON(tunnelFrame{Type: "pong", ID: frame.ID}))
		return
	}
	if frame.Type == "pong" {
		return
	}
	if frame.ID == "" {
		h.enqueue(from, errorFrame("", "BAD_FRAME", "frame id is required"))
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now().UTC()
	h.pruneLocked(now)

	switch from.role {
	case "mobile":
		if frame.Type != "request" {
			h.enqueueLocked(from, errorFrame(frame.ID, "BAD_FRAME", "mobile clients may only send request frames"))
			return
		}
		companion := h.selectCompanionLocked(from.agentID)
		if companion == nil {
			h.enqueueLocked(from, errorFrame(frame.ID, "AGENT_OFFLINE", "no companion is connected for this agent"))
			return
		}
		if h.pending[from.agentID] == nil {
			h.pending[from.agentID] = map[string]pendingRequest{}
		}
		if _, exists := h.pending[from.agentID][frame.ID]; exists {
			h.enqueueLocked(from, errorFrame(frame.ID, "DUPLICATE_REQUEST_ID", "a relay request with this frame id is already pending"))
			return
		}
		h.pending[from.agentID][frame.ID] = pendingRequest{requester: from, companion: companion, createdAt: now}
		if !h.enqueueLocked(companion, data) {
			delete(h.pending[from.agentID], frame.ID)
			if len(h.pending[from.agentID]) == 0 {
				delete(h.pending, from.agentID)
			}
			h.enqueueLocked(from, errorFrame(frame.ID, "COMPANION_BACKPRESSURE", "companion is not accepting relay frames"))
		}
	case "companion":
		if !isCompanionResponseFrame(frame.Type) {
			h.enqueueLocked(from, errorFrame(frame.ID, "BAD_FRAME", "companion clients may only send response, stream, or error frames"))
			return
		}
		requests := h.pending[from.agentID]
		req, ok := requests[frame.ID]
		if !ok {
			return
		}
		if req.companion != from {
			return
		}
		if !h.enqueueLocked(req.requester, data) || isTerminalFrame(frame.Type) {
			delete(requests, frame.ID)
			if len(requests) == 0 {
				delete(h.pending, from.agentID)
			}
		}
	}
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
	for data := range p.send {
		writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := p.conn.Write(writeCtx, websocket.MessageText, data)
		cancel()
		if err != nil {
			_ = p.conn.Close(websocket.StatusPolicyViolation, "write failed")
			return
		}
	}
}

func isCompanionResponseFrame(frameType string) bool {
	return frameType == "response" || frameType == "stream_chunk" || frameType == "stream_end" || frameType == "error"
}

func isTerminalFrame(frameType string) bool {
	return frameType == "response" || frameType == "stream_end" || frameType == "error"
}

func errorFrame(id string, code string, message string) []byte {
	return mustJSON(tunnelFrame{Type: "error", ID: id, Code: code, Message: message})
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

func tunnelCredential(r *http.Request, role string, allowLegacyQueryTokens bool) (token string, selectedSubprotocol string) {
	if token := bearerToken(r); token != "" {
		return token, ""
	}
	prefix := mobileAuthSubprotocolPrefix
	if role == "companion" {
		prefix = companionAuthSubprotocolPrefix
	}
	offeredProtocols := map[string]bool{}
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, offered := range strings.Split(header, ",") {
			offered = strings.TrimSpace(offered)
			offeredProtocols[offered] = true
		}
	}
	if offeredProtocols[relayTunnelSubprotocol] {
		for offered := range offeredProtocols {
			if candidate := strings.TrimPrefix(offered, prefix); candidate != offered && candidate != "" {
				// Echo only the fixed protocol, never the credential-bearing offer.
				return candidate, relayTunnelSubprotocol
			}
		}
	}
	if allowLegacyQueryTokens {
		// Explicit migration-only compatibility for already-released clients.
		// Current clients use Authorization (connector) or a negotiated WebSocket
		// subprotocol (mobile) so long-lived credentials do not appear in URLs.
		return strings.TrimSpace(r.URL.Query().Get("token")), ""
	}
	return "", ""
}

func secretEqual(got string, want string) bool {
	if got == "" || want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
