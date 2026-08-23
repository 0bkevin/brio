package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/brio/brio/apps/relay/internal/store"
)

func TestHubRoutesResponseOnlyToRequestingMobilePeer(t *testing.T) {
	h := newHub()
	mobileA := testPeer("mobile", "agent-1")
	mobileB := testPeer("mobile", "agent-1")
	companion := testPeer("companion", "agent-1")
	h.add(mobileA)
	h.add(mobileB)
	h.add(companion)

	request := mustJSON(tunnelFrame{Type: "request", ID: "req-1"})
	h.route(mobileA, request)

	if got := readFrame(t, companion); got.Type != "request" || got.ID != "req-1" {
		t.Fatalf("companion got %+v, want request req-1", got)
	}
	assertNoFrame(t, mobileB)

	response := mustJSON(tunnelFrame{Type: "response", ID: "req-1"})
	h.route(companion, response)

	if got := readFrame(t, mobileA); got.Type != "response" || got.ID != "req-1" {
		t.Fatalf("mobile A got %+v, want response req-1", got)
	}
	assertNoFrame(t, mobileB)
}

func TestHubKeepsStreamingRequestPendingUntilTerminalFrame(t *testing.T) {
	h := newHub()
	mobile := testPeer("mobile", "agent-1")
	companion := testPeer("companion", "agent-1")
	h.add(mobile)
	h.add(companion)

	h.route(mobile, mustJSON(tunnelFrame{Type: "request", ID: "req-1"}))
	_ = readFrame(t, companion)

	h.route(companion, mustJSON(tunnelFrame{Type: "stream_chunk", ID: "req-1"}))
	if got := readFrame(t, mobile); got.Type != "stream_chunk" || got.ID != "req-1" {
		t.Fatalf("mobile got %+v, want stream chunk req-1", got)
	}

	h.mu.Lock()
	_, pending := h.pending["agent-1"]["req-1"]
	h.mu.Unlock()
	if !pending {
		t.Fatal("request should stay pending after stream_chunk")
	}

	h.route(companion, mustJSON(tunnelFrame{Type: "stream_end", ID: "req-1"}))
	if got := readFrame(t, mobile); got.Type != "stream_end" || got.ID != "req-1" {
		t.Fatalf("mobile got %+v, want stream end req-1", got)
	}

	h.mu.Lock()
	_, pending = h.pending["agent-1"]["req-1"]
	h.mu.Unlock()
	if pending {
		t.Fatal("request should be removed after stream_end")
	}
}

func TestHubReturnsOfflineWhenNoCompanionConnected(t *testing.T) {
	h := newHub()
	mobile := testPeer("mobile", "agent-1")
	h.add(mobile)

	h.route(mobile, mustJSON(tunnelFrame{Type: "request", ID: "req-1"}))

	got := readFrame(t, mobile)
	if got.Type != "error" || got.ID != "req-1" || got.Code != "AGENT_OFFLINE" {
		t.Fatalf("mobile got %+v, want AGENT_OFFLINE error", got)
	}
}

func TestHubRejectsDuplicatePendingRequestID(t *testing.T) {
	h := newHub()
	mobileA := testPeer("mobile", "agent-1")
	mobileB := testPeer("mobile", "agent-1")
	companion := testPeer("companion", "agent-1")
	h.add(mobileA)
	h.add(mobileB)
	h.add(companion)

	h.route(mobileA, mustJSON(tunnelFrame{Type: "request", ID: "req-1"}))
	_ = readFrame(t, companion)

	h.route(mobileB, mustJSON(tunnelFrame{Type: "request", ID: "req-1"}))
	if got := readFrame(t, mobileB); got.Type != "error" || got.ID != "req-1" || got.Code != "DUPLICATE_REQUEST_ID" {
		t.Fatalf("mobile B got %+v, want DUPLICATE_REQUEST_ID error", got)
	}
	assertNoFrame(t, companion)

	h.route(companion, mustJSON(tunnelFrame{Type: "response", ID: "req-1"}))
	if got := readFrame(t, mobileA); got.Type != "response" || got.ID != "req-1" {
		t.Fatalf("mobile A got %+v, want response req-1", got)
	}
	assertNoFrame(t, mobileB)
}

func TestHubIgnoresResponseFromUnassignedCompanion(t *testing.T) {
	h := newHub()
	mobile := testPeer("mobile", "agent-1")
	oldCompanion := testPeer("companion", "agent-1")
	newCompanion := testPeer("companion", "agent-1")
	oldCompanion.joined = time.Now().UTC().Add(-time.Minute)
	newCompanion.joined = time.Now().UTC()
	h.add(mobile)
	h.add(oldCompanion)
	h.add(newCompanion)

	h.route(mobile, mustJSON(tunnelFrame{Type: "request", ID: "req-1"}))
	if got := readFrame(t, newCompanion); got.Type != "request" || got.ID != "req-1" {
		t.Fatalf("new companion got %+v, want request req-1", got)
	}
	assertNoFrame(t, oldCompanion)

	h.route(oldCompanion, mustJSON(tunnelFrame{Type: "response", ID: "req-1"}))
	assertNoFrame(t, mobile)

	h.route(newCompanion, mustJSON(tunnelFrame{Type: "response", ID: "req-1"}))
	if got := readFrame(t, mobile); got.Type != "response" || got.ID != "req-1" {
		t.Fatalf("mobile got %+v, want response req-1", got)
	}
}

func TestHubNotifiesRequesterWhenCompanionDisconnects(t *testing.T) {
	h := newHub()
	mobile := testPeer("mobile", "agent-1")
	companion := testPeer("companion", "agent-1")
	h.add(mobile)
	h.add(companion)

	h.route(mobile, mustJSON(tunnelFrame{Type: "request", ID: "req-1"}))
	_ = readFrame(t, companion)
	h.remove(companion)

	got := readFrame(t, mobile)
	if got.Type != "error" || got.ID != "req-1" || got.Code != "COMPANION_DISCONNECTED" {
		t.Fatalf("mobile got %+v, want COMPANION_DISCONNECTED error", got)
	}
}

func TestRemovePeerMarksLastCompanionOffline(t *testing.T) {
	st := &touchStore{}
	a := &app{hub: newHub(), store: st}
	companion := testPeer("companion", "agent-1")
	a.hub.add(companion)

	a.removePeer(companion)

	if got := st.statuses; !reflect.DeepEqual(got, []string{"agent-1:offline"}) {
		t.Fatalf("touch statuses = %#v, want last companion offline", got)
	}
}

func TestAddPeerOnlyMarksCompanionOnline(t *testing.T) {
	st := &touchStore{}
	a := &app{hub: newHub(), store: st}
	mobile := testPeer("mobile", "agent-1")
	companion := testPeer("companion", "agent-1")

	a.addPeer(context.Background(), mobile)
	if len(st.statuses) != 0 {
		t.Fatalf("touch statuses after mobile add = %#v, want none", st.statuses)
	}

	a.addPeer(context.Background(), companion)
	if got := st.statuses; !reflect.DeepEqual(got, []string{"agent-1:online"}) {
		t.Fatalf("touch statuses after companion add = %#v, want companion online", got)
	}
}

func TestRemovePeerKeepsAgentOnlineWhenAnotherCompanionRemains(t *testing.T) {
	st := &touchStore{}
	a := &app{hub: newHub(), store: st}
	oldCompanion := testPeer("companion", "agent-1")
	newCompanion := testPeer("companion", "agent-1")
	a.hub.add(oldCompanion)
	a.hub.add(newCompanion)

	a.removePeer(oldCompanion)

	if len(st.statuses) != 0 {
		t.Fatalf("touch statuses = %#v, want no offline update while another companion remains", st.statuses)
	}
	if !a.hub.hasCompanion("agent-1") {
		t.Fatal("expected another companion to remain connected")
	}
}

func TestHubPrunesExpiredPendingRequests(t *testing.T) {
	h := newHub()
	mobile := testPeer("mobile", "agent-1")
	companion := testPeer("companion", "agent-1")
	h.add(mobile)
	h.add(companion)

	h.route(mobile, mustJSON(tunnelFrame{Type: "request", ID: "req-1"}))
	_ = readFrame(t, companion)

	h.mu.Lock()
	h.pruneLocked(time.Now().UTC().Add(pendingRequestTTL + time.Second))
	h.mu.Unlock()

	got := readFrame(t, mobile)
	if got.Type != "error" || got.ID != "req-1" || got.Code != "REQUEST_EXPIRED" {
		t.Fatalf("mobile got %+v, want REQUEST_EXPIRED error", got)
	}

	h.mu.Lock()
	_, pending := h.pending["agent-1"]["req-1"]
	h.mu.Unlock()
	if pending {
		t.Fatal("request should be removed after expiry")
	}
}

func TestHubDisconnectDeviceRemovesOnlyThatDevicesMobilePeers(t *testing.T) {
	h := newHub()
	revoked := testPeer("mobile", "agent-1")
	revoked.deviceID = "device-revoked"
	other := testPeer("mobile", "agent-1")
	other.deviceID = "device-other"
	companion := testPeer("companion", "agent-1")
	h.add(revoked)
	h.add(other)
	h.add(companion)

	h.disconnectDevice("device-revoked")

	if peerConnected(h, revoked) {
		t.Fatal("revoked device peer remained connected")
	}
	if !peerConnected(h, other) {
		t.Fatal("another device peer was disconnected")
	}
	if !peerConnected(h, companion) {
		t.Fatal("companion peer was disconnected with the device")
	}
}

func TestHubDisconnectCompanionsRotatesOnlyTargetAgent(t *testing.T) {
	h := newHub()
	target := testPeer("companion", "agent-1")
	other := testPeer("companion", "agent-2")
	mobile := testPeer("mobile", "agent-1")
	h.add(target)
	h.add(other)
	h.add(mobile)

	h.disconnectCompanions("agent-1")

	if peerConnected(h, target) {
		t.Fatal("target companion remained connected after credential rotation")
	}
	if !peerConnected(h, other) {
		t.Fatal("another agent's companion was disconnected")
	}
	if !peerConnected(h, mobile) {
		t.Fatal("mobile peer was disconnected during companion rotation")
	}
}

func TestCreateDeviceRequiresExplicitAuthenticationMode(t *testing.T) {
	body := `{"email":"owner@example.com","device_name":"Phone"}`

	production := &app{cfg: Config{}, hub: newHub(), store: store.NewMemoryStore()}
	req := httptest.NewRequest(http.MethodPost, "/auth/devices", strings.NewReader(body))
	recorder := httptest.NewRecorder()
	production.createDevice(recorder, req)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("production status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}

	development := &app{cfg: Config{InsecureDevMode: true}, hub: newHub(), store: store.NewMemoryStore()}
	req = httptest.NewRequest(http.MethodPost, "/auth/devices", strings.NewReader(body))
	recorder = httptest.NewRecorder()
	development.createDevice(recorder, req)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("development status = %d, want %d: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}
}

func TestCreateDeviceRequiresConfiguredRegistrationKey(t *testing.T) {
	a := &app{
		cfg:   Config{DeviceRegistrationKey: "registration-secret"},
		hub:   newHub(),
		store: store.NewMemoryStore(),
	}
	body := `{"email":"owner@example.com","device_name":"Phone"}`

	req := httptest.NewRequest(http.MethodPost, "/auth/devices", strings.NewReader(body))
	recorder := httptest.NewRecorder()
	a.createDevice(recorder, req)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("missing-key status = %d, want %d", recorder.Code, http.StatusUnauthorized)
	}

	req = httptest.NewRequest(http.MethodPost, "/auth/devices", strings.NewReader(body))
	req.Header.Set("X-Brio-Registration-Key", "registration-secret")
	recorder = httptest.NewRecorder()
	a.createDevice(recorder, req)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("valid-key status = %d, want %d: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}
}

func TestOriginAllowedNormalizesFullOriginsAndHostPatterns(t *testing.T) {
	if !originAllowed("https://app.brio.dev", []string{"https://app.brio.dev/"}, false) {
		t.Fatal("expected exact full origin with trailing slash to be allowed")
	}
	if originAllowed("http://app.brio.dev", []string{"https://app.brio.dev"}, false) {
		t.Fatal("expected mismatched origin scheme to be rejected")
	}
	if !originAllowed("https://preview.brio.dev", []string{"*.brio.dev"}, false) {
		t.Fatal("expected host pattern to be allowed")
	}
}

func TestOriginPolicyFailsClosedUnlessDevelopmentIsExplicit(t *testing.T) {
	if originAllowed("https://untrusted.example", nil, false) {
		t.Fatal("empty production allowlist accepted a browser origin")
	}
	if !originAllowed("https://localhost.example", nil, true) {
		t.Fatal("explicit development mode did not accept a browser origin")
	}
	if originAllowed("https://untrusted.example", []string{"*"}, false) {
		t.Fatal("production wildcard accepted a browser origin")
	}
}

func TestCORSRejectsDisallowedWebSocketUpgradeBeforeHandler(t *testing.T) {
	called := false
	a := &app{cfg: Config{AllowedOrigins: []string{"https://app.brio.dev"}}}
	handler := a.cors(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1", nil)
	req.Header.Set("Origin", "http://app.brio.dev")
	req.Header.Set("Upgrade", "websocket")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, req)

	if called {
		t.Fatal("disallowed origin reached the WebSocket handler")
	}
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
	}
}

func TestCORSAllowsConfiguredOrigin(t *testing.T) {
	a := &app{cfg: Config{AllowedOrigins: []string{"https://app.brio.dev"}}}
	handler := a.cors(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://app.brio.dev")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNoContent)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "https://app.brio.dev" {
		t.Fatalf("allow origin = %q", got)
	}
}

func TestCORSRejectsBrowserOriginWhenProductionAllowlistIsEmpty(t *testing.T) {
	called := false
	a := &app{cfg: Config{}}
	handler := a.cors(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://untrusted.example")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, req)

	if called {
		t.Fatal("browser request reached handler without a production allowlist")
	}
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
	}
}

func TestRequestLoggerPreservesTokenForAuthentication(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	var requestURI string
	var token string
	handler := requestLogger(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestURI = r.RequestURI
		token = r.URL.Query().Get("token")
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1?token=super-secret&mode=test", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, req)

	if requestURI != "/tunnel/mobile/agent-1?token=super-secret&mode=test" {
		t.Fatalf("handler request URI = %q, want original URI", requestURI)
	}
	if token != "super-secret" {
		t.Fatalf("handler token = %q, want original token", token)
	}
	if strings.Contains(logs.String(), "super-secret") {
		t.Fatalf("request log exposed token: %s", logs.String())
	}
	if !strings.Contains(logs.String(), "path=/tunnel/mobile/agent-1") {
		t.Fatalf("request log omitted safe path: %s", logs.String())
	}
}

func TestTunnelCredentialPrefersAuthorizationAndSupportsMobileSubprotocol(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1?token=legacy-secret", nil)
	req.Header.Set("Authorization", "Bearer header-secret")
	req.Header.Set("Sec-WebSocket-Protocol", relayTunnelSubprotocol+", "+mobileAuthSubprotocolPrefix+"protocol-secret")
	token, protocol := tunnelCredential(req, "mobile", true)
	if token != "header-secret" || protocol != "" {
		t.Fatalf("authorization credential = (%q, %q)", token, protocol)
	}

	req = httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1", nil)
	offered := mobileAuthSubprotocolPrefix + "protocol-secret"
	req.Header.Set("Sec-WebSocket-Protocol", "unrelated, "+relayTunnelSubprotocol+", "+offered)
	token, protocol = tunnelCredential(req, "mobile", false)
	if token != "protocol-secret" || protocol != relayTunnelSubprotocol {
		t.Fatalf("subprotocol credential = (%q, %q), want token and fixed selected protocol", token, protocol)
	}

	req = httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1", nil)
	req.Header.Set("Sec-WebSocket-Protocol", offered)
	token, protocol = tunnelCredential(req, "mobile", false)
	if token != "" || protocol != "" {
		t.Fatalf("credential-only subprotocol was accepted without protocol negotiation: (%q, %q)", token, protocol)
	}

	req = httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1?token=legacy-secret", nil)
	req.Header.Set("Sec-WebSocket-Protocol", relayTunnelSubprotocol+", "+companionAuthSubprotocolPrefix+"wrong-role")
	token, protocol = tunnelCredential(req, "mobile", true)
	if token != "legacy-secret" || protocol != "" {
		t.Fatalf("wrong-role subprotocol bypassed role binding: (%q, %q)", token, protocol)
	}

	token, protocol = tunnelCredential(req, "mobile", false)
	if token != "" || protocol != "" {
		t.Fatalf("production accepted disabled legacy query credential: (%q, %q)", token, protocol)
	}
}

func TestWebsocketOriginPatternsUseHostsFromConfiguredOrigins(t *testing.T) {
	got := websocketOriginPatterns([]string{
		"https://app.brio.dev",
		"http://localhost:19006/",
		"*.preview.brio.dev",
	})
	want := []string{"app.brio.dev", "localhost:19006", "*.preview.brio.dev"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("websocket origin patterns = %#v, want %#v", got, want)
	}

	if opts := websocketAcceptOptions(nil, false); opts == nil || opts.InsecureSkipVerify {
		t.Fatal("empty production allowlist should retain WebSocket origin verification")
	}
	if opts := websocketAcceptOptions([]string{"*"}, true); opts == nil || !opts.InsecureSkipVerify {
		t.Fatal("wildcard allowed origin should explicitly allow all WebSocket origins")
	}
}

func testPeer(role string, agentID string) *peer {
	return &peer{
		id:      role + "-test",
		agentID: agentID,
		role:    role,
		send:    make(chan []byte, 8),
		joined:  time.Now().UTC(),
	}
}

func readFrame(t *testing.T, p *peer) tunnelFrame {
	t.Helper()
	select {
	case data := <-p.send:
		var frame tunnelFrame
		if err := json.Unmarshal(data, &frame); err != nil {
			t.Fatalf("unmarshal frame: %v", err)
		}
		return frame
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for frame")
		return tunnelFrame{}
	}
}

func assertNoFrame(t *testing.T, p *peer) {
	t.Helper()
	select {
	case data := <-p.send:
		t.Fatalf("unexpected frame: %s", string(data))
	default:
	}
}

func peerConnected(h *hub, target *peer) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.agents[target.agentID][target]
}

type touchStore struct {
	store.Store
	statuses []string
}

func (s *touchStore) TouchAgent(ctx context.Context, agentID string, status string) error {
	s.statuses = append(s.statuses, agentID+":"+status)
	return nil
}
