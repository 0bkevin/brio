package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	identityauth "github.com/brio/brio/apps/relay/internal/auth"
	"github.com/brio/brio/apps/relay/internal/store"
	"github.com/go-chi/chi/v5"
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

func TestHubIgnoresFramesAlreadyReadFromRemovedPeer(t *testing.T) {
	h := newHub()
	mobile := testPeer("mobile", "agent-1")
	companion := testPeer("companion", "agent-1")
	h.add(mobile)
	h.add(companion)
	h.remove(mobile)

	// A socket read can finish just before revocation removes the peer. Routing
	// that already-read frame must neither panic on the closed send queue nor
	// forward a request authenticated by the revoked connection.
	h.route(mobile, mustJSON(tunnelFrame{Type: "ping", ID: "ping-1"}))
	h.route(mobile, mustJSON(tunnelFrame{Type: "request", ID: "req-1"}))
	h.route(mobile, []byte(`not-json`))
	assertNoFrame(t, companion)
}

func TestCredentialMutationBoundaryBlocksConcurrentFrameRouting(t *testing.T) {
	a := &app{hub: newHub(), store: store.NewMemoryStore()}
	mobile := testPeer("mobile", "agent-1")
	companion := testPeer("companion", "agent-1")
	a.hub.add(mobile)
	a.hub.add(companion)

	a.peerMu.Lock()
	routed := make(chan struct{})
	go func() {
		a.routePeer(mobile, mustJSON(tunnelFrame{Type: "request", ID: "req-1"}))
		close(routed)
	}()
	select {
	case <-routed:
		t.Fatal("frame routed through an in-progress credential mutation")
	case <-time.After(25 * time.Millisecond):
	}
	a.hub.remove(mobile)
	a.peerMu.Unlock()
	<-routed
	assertNoFrame(t, companion)
}

func TestHubCapsPendingRequestsPerMobilePeer(t *testing.T) {
	h := newHub()
	mobile := testPeer("mobile", "agent-1")
	companion := testPeer("companion", "agent-1")
	companion.send = make(chan []byte, maxPendingRequestsPerPeer+1)
	h.add(mobile)
	h.add(companion)

	for index := 0; index < maxPendingRequestsPerPeer; index++ {
		id := fmt.Sprintf("req-%d", index)
		h.route(mobile, mustJSON(tunnelFrame{Type: "request", ID: id}))
	}
	h.route(mobile, mustJSON(tunnelFrame{Type: "request", ID: "one-too-many"}))

	got := readFrame(t, mobile)
	if got.Type != "error" || got.Code != "RELAY_BACKPRESSURE" {
		t.Fatalf("mobile got %+v, want RELAY_BACKPRESSURE error", got)
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

	if got := st.statuses; !reflect.DeepEqual(got, []string{"agent-1:online"}) {
		t.Fatalf("touch statuses = %#v, want current online state while another companion remains", got)
	}
	if !a.hub.hasCompanion("agent-1") {
		t.Fatal("expected another companion to remain connected")
	}
}

func TestPeerPresenceUpdatesCannotRaceReplacementConnection(t *testing.T) {
	st := newOrderedTouchStore()
	a := &app{hub: newHub(), store: st}
	oldCompanion := testPeer("companion", "agent-1")
	newCompanion := testPeer("companion", "agent-1")
	a.hub.add(oldCompanion)

	removed := make(chan struct{})
	go func() {
		a.removePeer(oldCompanion)
		close(removed)
	}()
	<-st.offlineStarted

	added := make(chan struct{})
	go func() {
		a.addPeer(context.Background(), newCompanion)
		close(added)
	}()
	select {
	case <-st.onlineStarted:
		t.Fatal("replacement companion wrote online before the prior offline update completed")
	case <-time.After(25 * time.Millisecond):
	}

	close(st.releaseOffline)
	<-removed
	<-added
	if got := st.snapshot(); !reflect.DeepEqual(got, []string{"agent-1:offline", "agent-1:online"}) {
		t.Fatalf("touch statuses = %#v, want ordered offline then online", got)
	}
}

func TestDeviceRevocationCannotMissPeerJoiningAfterRevalidation(t *testing.T) {
	st := newRevocationRaceStore()
	a := &app{hub: newHub(), store: st}
	mobile := testPeer("mobile", "agent-1")
	mobile.deviceID = "device-1"

	registered := make(chan error, 1)
	go func() {
		registered <- a.revalidateAndAddPeer(context.Background(), mobile, "device-token")
	}()
	<-st.authenticationStarted

	req := httptest.NewRequest(http.MethodDelete, "/devices/device-1", nil)
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", "device-1")
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeContext)
	ctx = context.WithValue(ctx, authContextKey{}, store.Auth{User: store.User{ID: "user-1"}})
	req = req.WithContext(ctx)
	recorder := httptest.NewRecorder()
	revoked := make(chan struct{})
	go func() {
		a.revokeDevice(recorder, req)
		close(revoked)
	}()

	select {
	case <-st.revocationStarted:
		t.Fatal("revocation mutated credentials while peer revalidation was still in progress")
	case <-time.After(25 * time.Millisecond):
	}
	close(st.releaseAuthentication)
	if err := <-registered; err != nil {
		t.Fatalf("revalidate and add peer: %v", err)
	}
	<-revoked
	if recorder.Code != http.StatusOK {
		t.Fatalf("revoke status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if peerConnected(a.hub, mobile) {
		t.Fatal("revoked device peer joined after the revocation disconnect pass")
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

func TestDisconnectAllPeersDrainsHub(t *testing.T) {
	a := &app{hub: newHub(), store: &touchStore{}}
	a.hub.add(testPeer("mobile", "agent-1"))
	a.hub.add(testPeer("companion", "agent-1"))
	a.hub.add(testPeer("companion", "agent-2"))

	a.disconnectAllPeers()

	a.hub.mu.Lock()
	remaining := len(a.hub.agents)
	a.hub.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("hub retained %d agent peer sets after shutdown", remaining)
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

func TestCreateDeviceRejectsOversizedAndAmbiguousJSONBodies(t *testing.T) {
	a := &app{cfg: Config{InsecureDevMode: true}, hub: newHub(), store: store.NewMemoryStore()}

	oversized := `{"email":"` + strings.Repeat("a", maxJSONBodyBytes) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/auth/devices", strings.NewReader(oversized))
	recorder := httptest.NewRecorder()
	a.createDevice(recorder, req)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status = %d, want %d: %s", recorder.Code, http.StatusRequestEntityTooLarge, recorder.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/auth/devices", strings.NewReader(`{"email":"owner@example.com"} {"email":"other@example.com"}`))
	recorder = httptest.NewRecorder()
	a.createDevice(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("multiple JSON values status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}

	req = httptest.NewRequest(http.MethodPost, "/auth/devices", strings.NewReader(`{"email":"owner@example.com","admin":true}`))
	recorder = httptest.NewRecorder()
	a.createDevice(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unknown JSON field status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestCreatePairingRejectsAgentIDThatCannotBeAddressedByTunnel(t *testing.T) {
	a := &app{hub: newHub(), store: store.NewMemoryStore()}
	req := httptest.NewRequest(http.MethodPost, "/pairings", strings.NewReader(`{"agent_id":"parent/child"}`))
	recorder := httptest.NewRecorder()
	a.createPairing(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
}

func TestInternalStoreErrorsAreNotExposedToClients(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	recorder := httptest.NewRecorder()
	writeStoreError(recorder, errors.New("postgres password=super-secret"))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
	if strings.Contains(recorder.Body.String(), "super-secret") || !strings.Contains(recorder.Body.String(), "internal server error") {
		t.Fatalf("unsafe internal error response: %s", recorder.Body.String())
	}
	if strings.Contains(logs.String(), "super-secret") {
		t.Fatalf("unsafe internal error log: %s", logs.String())
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

func TestCreateDeviceUsesVerifiedIdentityInsteadOfSubmittedEmail(t *testing.T) {
	st := store.NewMemoryStore()
	a := &app{
		cfg:   Config{},
		hub:   newHub(),
		store: st,
		identity: fakeIdentityVerifier{identity: identityauth.Identity{
			Issuer:  "https://clerk.example",
			Subject: "user-123",
			Email:   "verified@example.com",
		}},
	}
	req := httptest.NewRequest(http.MethodPost, "/auth/devices", strings.NewReader(`{"email":"attacker@example.com","device_name":"Phone"}`))
	req.Header.Set("Authorization", "Bearer valid-clerk-token")
	recorder := httptest.NewRecorder()

	a.createDevice(recorder, req)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}
	var response struct {
		User   store.User   `json:"user"`
		Device store.Device `json:"device"`
		Token  string       `json:"token"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.User.Email != "verified@example.com" || response.User.IdentitySubject != "user-123" {
		t.Fatalf("unverified request metadata affected identity: %+v", response.User)
	}
	if response.Device.UserID != response.User.ID || response.Token == "" {
		t.Fatalf("unexpected device response: %+v", response)
	}
	authenticated, err := st.AuthenticateDevice(t.Context(), response.Token)
	if err != nil || authenticated.User.ID != response.User.ID {
		t.Fatalf("issued device token did not authenticate verified user: auth=%+v err=%v", authenticated, err)
	}
}

func TestCreateDeviceRejectsInvalidVerifiedIdentity(t *testing.T) {
	a := &app{
		hub:      newHub(),
		store:    store.NewMemoryStore(),
		identity: fakeIdentityVerifier{err: identityauth.ErrInvalidIdentityToken},
	}
	req := httptest.NewRequest(http.MethodPost, "/auth/devices", strings.NewReader(`{"device_name":"Phone"}`))
	req.Header.Set("Authorization", "Bearer forged-token")
	recorder := httptest.NewRecorder()

	a.createDevice(recorder, req)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusUnauthorized, recorder.Body.String())
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

func TestRequestLoggerRedactsEnrollmentAndPairingCodesFromPaths(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	handler := requestLogger(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, path := range []string{
		"/enrollments/SECRET01/claim",
		"/pairings/SECRET02",
		"/pairings/SECRET03/claim",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, nil))
	}

	if strings.Contains(logs.String(), "SECRET") {
		t.Fatalf("request log exposed a short-lived credential: %s", logs.String())
	}
	if !strings.Contains(logs.String(), "path=/enrollments/:code/claim") ||
		!strings.Contains(logs.String(), "path=/pairings/:code") {
		t.Fatalf("request log omitted redacted route shape: %s", logs.String())
	}
}

func TestTunnelCredentialPrefersAuthorizationAndSupportsMobileSubprotocol(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1?token=legacy-secret", nil)
	req.Header.Set("Authorization", "Bearer header-secret")
	req.Header.Set("Sec-WebSocket-Protocol", relayTunnelSubprotocol+", "+mobileAuthSubprotocolPrefix+"protocol-secret")
	token, protocol, err := tunnelCredential(req, "mobile", true)
	if err != nil {
		t.Fatalf("authorization credential: %v", err)
	}
	if token != "header-secret" || protocol != "" {
		t.Fatalf("authorization credential = (%q, %q)", token, protocol)
	}

	req = httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1", nil)
	offered := mobileAuthSubprotocolPrefix + "protocol-secret"
	req.Header.Set("Sec-WebSocket-Protocol", "unrelated, "+relayTunnelSubprotocol+", "+offered)
	token, protocol, err = tunnelCredential(req, "mobile", false)
	if err != nil {
		t.Fatalf("subprotocol credential: %v", err)
	}
	if token != "protocol-secret" || protocol != relayTunnelSubprotocol {
		t.Fatalf("subprotocol credential = (%q, %q), want token and fixed selected protocol", token, protocol)
	}

	req = httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1", nil)
	req.Header.Set("Sec-WebSocket-Protocol", offered)
	token, protocol, err = tunnelCredential(req, "mobile", false)
	if err != nil {
		t.Fatalf("credential-only subprotocol: %v", err)
	}
	if token != "" || protocol != "" {
		t.Fatalf("credential-only subprotocol was accepted without protocol negotiation: (%q, %q)", token, protocol)
	}

	req = httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1?token=legacy-secret", nil)
	req.Header.Set("Sec-WebSocket-Protocol", relayTunnelSubprotocol+", "+companionAuthSubprotocolPrefix+"wrong-role")
	token, protocol, err = tunnelCredential(req, "mobile", true)
	if err != nil {
		t.Fatalf("wrong-role subprotocol: %v", err)
	}
	if token != "legacy-secret" || protocol != "" {
		t.Fatalf("wrong-role subprotocol bypassed role binding: (%q, %q)", token, protocol)
	}

	token, protocol, err = tunnelCredential(req, "mobile", false)
	if err != nil {
		t.Fatalf("disabled legacy credential: %v", err)
	}
	if token != "" || protocol != "" {
		t.Fatalf("production accepted disabled legacy query credential: (%q, %q)", token, protocol)
	}

	req = httptest.NewRequest(http.MethodGet, "/tunnel/mobile/agent-1", nil)
	req.Header.Set("Sec-WebSocket-Protocol", relayTunnelSubprotocol+", "+mobileAuthSubprotocolPrefix+"first, "+mobileAuthSubprotocolPrefix+"second")
	if _, _, err = tunnelCredential(req, "mobile", false); err == nil {
		t.Fatal("multiple credential-bearing subprotocols were accepted ambiguously")
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

type orderedTouchStore struct {
	store.Store
	mu             sync.Mutex
	statuses       []string
	offlineStarted chan struct{}
	onlineStarted  chan struct{}
	releaseOffline chan struct{}
	offlineOnce    sync.Once
	onlineOnce     sync.Once
}

func newOrderedTouchStore() *orderedTouchStore {
	return &orderedTouchStore{
		offlineStarted: make(chan struct{}),
		onlineStarted:  make(chan struct{}),
		releaseOffline: make(chan struct{}),
	}
}

func (s *orderedTouchStore) TouchAgent(_ context.Context, agentID string, status string) error {
	if status == "offline" {
		s.offlineOnce.Do(func() { close(s.offlineStarted) })
		<-s.releaseOffline
	} else if status == "online" {
		s.onlineOnce.Do(func() { close(s.onlineStarted) })
	}
	s.mu.Lock()
	s.statuses = append(s.statuses, agentID+":"+status)
	s.mu.Unlock()
	return nil
}

func (s *orderedTouchStore) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.statuses...)
}

type revocationRaceStore struct {
	store.Store
	authenticationStarted chan struct{}
	releaseAuthentication chan struct{}
	revocationStarted     chan struct{}
	authenticationOnce    sync.Once
	revocationOnce        sync.Once
}

func newRevocationRaceStore() *revocationRaceStore {
	return &revocationRaceStore{
		authenticationStarted: make(chan struct{}),
		releaseAuthentication: make(chan struct{}),
		revocationStarted:     make(chan struct{}),
	}
}

func (s *revocationRaceStore) AuthenticateDevice(context.Context, string) (store.Auth, error) {
	s.authenticationOnce.Do(func() { close(s.authenticationStarted) })
	<-s.releaseAuthentication
	return store.Auth{
		User:   store.User{ID: "user-1"},
		Device: store.Device{ID: "device-1", UserID: "user-1"},
	}, nil
}

func (s *revocationRaceStore) UserCanAccessAgent(context.Context, string, string) (bool, error) {
	return true, nil
}

func (s *revocationRaceStore) RevokeDevice(context.Context, string, string) (store.Device, error) {
	s.revocationOnce.Do(func() { close(s.revocationStarted) })
	return store.Device{ID: "device-1", UserID: "user-1"}, nil
}

type fakeIdentityVerifier struct {
	identity identityauth.Identity
	err      error
}

func (v fakeIdentityVerifier) Verify(context.Context, string) (identityauth.Identity, error) {
	return v.identity, v.err
}

func (s *touchStore) TouchAgent(ctx context.Context, agentID string, status string) error {
	s.statuses = append(s.statuses, agentID+":"+status)
	return nil
}
