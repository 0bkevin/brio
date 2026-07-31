package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	connectcontrol "github.com/brio/brio/apps/relay/internal/connect"
	"github.com/brio/brio/apps/relay/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"nhooyr.io/websocket"
)

type Config struct {
	Addr                string
	DatabaseURL         string
	RelayIssuer         string
	SigningPrivateKey   string
	CloudflareAccountID string
	CloudflareAPIToken  string
	CloudflareZoneID    string
	TunnelBaseDomain    string
	ManagedTunnelLimit  int
}

type hub struct {
	mu     sync.Mutex
	agents map[string]map[*peer]bool
}

type peer struct {
	agentID string
	role    string
	conn    *websocket.Conn
	send    chan []byte
}

type app struct {
	hub     *hub
	store   store.Store
	connect *connectcontrol.Broker
}

func Run(ctx context.Context, cfg Config) error {
	if strings.TrimSpace(cfg.DatabaseURL) != "" && strings.TrimSpace(cfg.SigningPrivateKey) == "" {
		return errors.New("BRIO_RELAY_SIGNING_KEY is required when persistent relay storage is enabled")
	}
	st, err := openStore(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	issuer := strings.TrimRight(strings.TrimSpace(cfg.RelayIssuer), "/")
	if issuer == "" {
		issuer = issuerFromAddr(cfg.Addr)
	}
	broker, err := connectcontrol.New(connectcontrol.Config{
		Issuer:            issuer,
		SigningPrivateKey: cfg.SigningPrivateKey,
		Cloudflare: connectcontrol.CloudflareConfig{
			AccountID:  cfg.CloudflareAccountID,
			APIToken:   cfg.CloudflareAPIToken,
			ZoneID:     cfg.CloudflareZoneID,
			BaseDomain: cfg.TunnelBaseDomain,
		},
		ManagedTunnelLimit: cfg.ManagedTunnelLimit,
	}, st)
	if err != nil {
		return err
	}
	a := &app{hub: &hub{agents: map[string]map[*peer]bool{}}, store: st, connect: broker}
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.RealIP)
	router.Use(middleware.Logger)
	router.Use(middleware.Recoverer)
	router.Use(cors)
	router.Get("/health", a.health)
	router.Post("/auth/devices", a.createDevice)
	router.Group(func(r chi.Router) {
		r.Use(a.requireDevice)
		r.Get("/me", a.me)
		r.Get("/devices", a.listDevices)
		r.Delete("/devices/{id}", a.revokeDevice)
		r.Get("/agents", a.listAgents)
		r.Get("/v1/environments", a.listEnvironments)
		r.Post("/enrollments", a.createEnrollment)
		r.Post("/agents/{id}/recover", a.recoverAgent)
		r.Post("/pairings/{code}/claim", a.claimPairing)
		r.Post("/v1/environments/{id}/connect", a.connectEnvironment)
		r.Post("/v1/environments/{id}/status", a.environmentStatus)
		r.Delete("/v1/client/environment-links/{id}", a.unlinkEnvironment)
	})
	router.Post("/enrollments/{code}/claim", a.claimEnrollment)
	router.Post("/pairings", a.createPairing)
	router.Get("/pairings/{code}", a.getPairing)
	router.Get("/tunnel/{role}/{agentID}", a.tunnel)
	router.Get("/.well-known/brio-connect", a.connectMetadata)
	router.Post("/v1/environments/{id}/tunnel/reconcile", a.reconcileEnvironmentEndpoint)
	router.Delete("/v1/environments/{id}/tunnel", a.releaseEnvironmentEndpoint)
	apiHandler := http.TimeoutHandler(router, 9*time.Second, `{"error":"relay_request_deadline_exceeded"}`+"\n")

	srv := &http.Server{
		Addr: cfg.Addr,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/tunnel/") {
				router.ServeHTTP(w, r)
				return
			}
			recorder := httptest.NewRecorder()
			apiHandler.ServeHTTP(recorder, r)
			for key, values := range recorder.Header() {
				for _, value := range values {
					w.Header().Add(key, value)
				}
			}
			status := recorder.Code
			if status == http.StatusServiceUnavailable && strings.Contains(recorder.Body.String(), "relay_request_deadline_exceeded") {
				status = http.StatusGatewayTimeout
				w.Header().Set("Content-Type", "application/json")
			}
			w.WriteHeader(status)
			_, _ = w.Write(recorder.Body.Bytes())
		}),
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

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, DPoP, B3, Traceparent")
		w.Header().Set("Access-Control-Expose-Headers", "Traceparent, WWW-Authenticate")
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
	for _, set := range a.hub.agents {
		peers += len(set)
	}
	a.hub.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"service": "brio-relay",
		"ok":      true,
		"agents":  agents,
		"peers":   peers,
		"issuer":  a.connect.Issuer(),
	})
}

func (a *app) createDevice(w http.ResponseWriter, r *http.Request) {
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

func (a *app) listEnvironments(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	agents, err := a.store.ListAgents(r.Context(), auth.User.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"environments": agents})
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
		Proof   string `json:"proof"`
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
	var link *store.ConnectLink
	var endpointRuntime *connectcontrol.EndpointRuntime
	if strings.TrimSpace(body.Proof) != "" {
		verified, err := a.connect.VerifyEnrollmentProof(body.Proof, code, body.AgentID)
		if err != nil {
			writeConnectError(w, r, err)
			return
		}
		enrollment, err := a.store.GetEnrollment(r.Context(), code)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		verified, endpointRuntime, err = a.connect.ProvisionEndpoint(r.Context(), enrollment.UserID, body.AgentID, verified)
		if err != nil {
			writeConnectError(w, r, err)
			return
		}
		link = &verified.Link
		if strings.TrimSpace(body.Name) == "" {
			body.Name = verified.Name
		}
	} else {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "signed environment link proof is required"})
		return
	}
	agent, relayToken, environmentCredential, err := a.store.ClaimEnrollment(r.Context(), code, body.AgentID, body.Name, link)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if link != nil {
		agent.Status = "offline"
		_ = a.store.TouchAgent(r.Context(), agent.ID, "offline")
	}
	writeNoStore(w)
	result := map[string]any{
		"agent":       agent,
		"relay_token": relayToken,
	}
	if link != nil {
		result["connect"] = map[string]any{
			"relay_issuer":           a.connect.Issuer(),
			"relay_public_key":       a.connect.PublicKey(),
			"cloud_user_id":          *agent.OwnerUserID,
			"environment_credential": environmentCredential,
			"endpoint":               agent.Endpoint,
			"endpoint_runtime":       endpointRuntime,
		}
	}
	writeJSON(w, http.StatusCreated, result)
}

func (a *app) connectMetadata(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":           a.connect.Issuer(),
		"public_key":       a.connect.PublicKey(),
		"connect_endpoint": a.connect.Issuer() + "/v1/environments/{environment_id}/connect",
		"status_endpoint":  a.connect.Issuer() + "/v1/environments/{environment_id}/status",
	})
}

func (a *app) connectEnvironment(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	var body struct {
		ClientProofKeyThumbprint string `json:"client_proof_key_thumbprint"`
		ClientKeyThumbprint      string `json:"client_key_thumbprint"`
		DeviceID                 string `json:"device_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	thumbprint := strings.TrimSpace(body.ClientProofKeyThumbprint)
	if thumbprint == "" {
		thumbprint = strings.TrimSpace(body.ClientKeyThumbprint)
	}
	result, err := a.connect.Connect(r.Context(), auth.User.ID, strings.TrimSpace(chi.URLParam(r, "id")), thumbprint, strings.TrimSpace(body.DeviceID))
	if err != nil {
		writeConnectError(w, r, err)
		return
	}
	writeNoStore(w)
	writeJSON(w, http.StatusOK, result)
}

func (a *app) environmentStatus(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	result, err := a.connect.Status(r.Context(), auth.User.ID, strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		writeConnectError(w, r, err)
		return
	}
	writeNoStore(w)
	writeJSON(w, http.StatusOK, result)
}

func (a *app) unlinkEnvironment(w http.ResponseWriter, r *http.Request) {
	auth := authFromContext(r.Context())
	ok, err := a.connect.Unlink(r.Context(), auth.User.ID, strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		writeConnectError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": ok})
}

func (a *app) reconcileEnvironmentEndpoint(w http.ResponseWriter, r *http.Request) {
	credential := bearerToken(r)
	if credential == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing environment credential"})
		return
	}
	var body struct {
		Origin struct {
			Host string `json:"local_http_host"`
			Port int    `json:"local_http_port"`
		} `json:"origin"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	endpoint, runtime, err := a.connect.ReconcileEndpoint(r.Context(), strings.TrimSpace(chi.URLParam(r, "id")), credential, body.Origin.Host, body.Origin.Port)
	if err != nil {
		writeConnectError(w, r, err)
		return
	}
	writeNoStore(w)
	writeJSON(w, http.StatusOK, map[string]any{"endpoint": endpoint, "endpoint_runtime": runtime})
}

func (a *app) releaseEnvironmentEndpoint(w http.ResponseWriter, r *http.Request) {
	credential := bearerToken(r)
	if credential == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing environment credential"})
		return
	}
	ok, err := a.connect.ReleaseEndpoint(r.Context(), strings.TrimSpace(chi.URLParam(r, "id")), credential)
	if err != nil {
		writeConnectError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": ok})
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
	if role == "mobile" {
		token := r.URL.Query().Get("token")
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
		if !a.hub.hasRole(agentID, "companion") {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "agent is offline"})
			return
		}
	} else {
		token := r.URL.Query().Get("token")
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing companion token"})
			return
		}
		if err := a.store.AuthenticateCompanion(r.Context(), agentID, token); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		return
	}
	p := &peer{
		agentID: agentID,
		role:    role,
		conn:    conn,
		send:    make(chan []byte, 64),
	}
	a.hub.add(p)
	if role == "companion" {
		_ = a.store.TouchAgent(r.Context(), agentID, "online")
	}
	defer func() {
		a.hub.remove(p)
		if role == "companion" && !a.hub.hasRole(agentID, "companion") {
			_ = a.store.TouchAgent(context.Background(), agentID, "offline")
		}
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
		a.hub.broadcast(p, data)
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
		delete(peers, p)
		close(p.send)
		if len(peers) == 0 {
			delete(h.agents, p.agentID)
		}
	}
	_ = p.conn.Close(websocket.StatusNormalClosure, "bye")
}

func (h *hub) hasRole(agentID string, role string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for peer := range h.agents[agentID] {
		if peer.role == role {
			return true
		}
	}
	return false
}

func (h *hub) broadcast(from *peer, data []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for p := range h.agents[from.agentID] {
		if p == from || p.role == from.role {
			continue
		}
		select {
		case p.send <- data:
		default:
		}
	}
}

func (p *peer) writeLoop(ctx context.Context) {
	for data := range p.send {
		writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := p.conn.Write(writeCtx, websocket.MessageText, data)
		cancel()
		if err != nil {
			return
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
}

func writeConnectError(w http.ResponseWriter, r *http.Request, err error) {
	var connectErr *connectcontrol.Error
	if !errors.As(err, &connectErr) {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal_error", "trace_id": middleware.GetReqID(r.Context())})
		return
	}
	writeJSON(w, connectErr.Status, map[string]any{
		"error":    connectErr.Code,
		"code":     connectErr.Code,
		"reason":   connectErr.Reason,
		"trace_id": middleware.GetReqID(r.Context()),
	})
}

func issuerFromAddr(addr string) string {
	addr = strings.TrimSpace(addr)
	if strings.HasPrefix(addr, ":") {
		return "http://127.0.0.1" + addr
	}
	if strings.HasPrefix(addr, "0.0.0.0:") {
		return "http://127.0.0.1:" + strings.TrimPrefix(addr, "0.0.0.0:")
	}
	if strings.HasPrefix(addr, "[") || strings.Contains(addr, ":") {
		return "http://" + addr
	}
	return "http://127.0.0.1:8080"
}
