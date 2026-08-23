package tunnel

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

func TestTunnelURL(t *testing.T) {
	got, err := tunnelURL("https://relay.example/base/", "mobile", "agent 123")
	if err != nil {
		t.Fatalf("tunnelURL returned error: %v", err)
	}

	want := "wss://relay.example/base/tunnel/mobile/agent%20123"
	if got != want {
		t.Fatalf("unexpected tunnel URL: got %q want %q", got, want)
	}
}

func TestProbeSendsRelayCredentialInAuthorizationHeader(t *testing.T) {
	authorization := make(chan string, 1)
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization <- r.Header.Get("Authorization")
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		_ = conn.Close(websocket.StatusNormalClosure, "done")
	}))
	defer relay.Close()

	if err := Probe(context.Background(), Config{RelayURL: relay.URL, AgentID: "agent-1", RelayToken: "relay-secret"}); err != nil {
		t.Fatalf("Probe failed: %v", err)
	}
	if got := <-authorization; got != "Bearer relay-secret" {
		t.Fatalf("Authorization = %q, want bearer relay credential", got)
	}
}

func TestJitterStaysWithinBounds(t *testing.T) {
	for _, base := range []time.Duration{time.Second, 16 * time.Second, 32 * time.Second} {
		for i := 0; i < 50; i++ {
			got := jitter(base)
			if got < time.Duration(0.85*float64(base)) || got > time.Duration(1.15*float64(base)) {
				t.Fatalf("jitter(%v) = %v, outside +-10%% bounds", base, got)
			}
		}
	}
}

// fakeRelay returns an httptest server that accepts one tunnel connection
// and hands control of it to the supplied function.
func fakeRelay(t *testing.T, handle func(conn *websocket.Conn)) *httptest.Server {
	t.Helper()
	relayErr := make(chan error, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			relayErr <- err
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		handle(conn)
	}))
	t.Cleanup(func() {
		server.Close()
		select {
		case err := <-relayErr:
			t.Logf("fake relay: %v", err)
		default:
		}
	})
	return server
}

func writeRelayFrame(ctx context.Context, conn *websocket.Conn, frame Frame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

func TestConnectRespondsWithSingleWriterUnderConcurrency(t *testing.T) {
	const total = 60
	handler := func(ctx context.Context, frame Frame, emit func(Frame) error) error {
		return emit(Frame{Type: "response", ID: frame.ID, Status: http.StatusOK, Body: map[string]string{"echo": frame.ID}})
	}

	received := make(chan Frame, total*2)
	var sequence sync.Once
	relay := fakeRelay(t, func(conn *websocket.Conn) {
		// Only the FIRST connection may blast requests: if the connector
		// drops and reconnects, replaying the sequence would produce
		// duplicate frame IDs that crowd out the distinct IDs the test
		// collects. The real relay never replays pending requests, so
		// reconnected tunnels here just drain quietly.
		drained := true
		sequence.Do(func() {
			drained = false
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			for i := 0; i < total; i++ {
				if err := writeRelayFrame(ctx, conn, Frame{Type: "request", ID: fmt.Sprintf("req-%d", i), Method: http.MethodGet, Path: "/health"}); err != nil {
					return
				}
			}
			seen := map[string]bool{}
			for {
				_, data, err := conn.Read(ctx)
				if err != nil {
					return
				}
				var frame Frame
				if err := json.Unmarshal(data, &frame); err != nil {
					t.Errorf("frame was not valid JSON (single-writer violation?): %v", err)
					return
				}
				if frame.Type != "response" {
					continue
				}
				received <- frame
				seen[frame.ID] = true
				if len(seen) == total {
					return
				}
			}
		})
		if drained {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			for {
				if _, _, err := conn.Read(ctx); err != nil {
					return
				}
			}
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = connect(ctx, Config{RelayURL: relay.URL, AgentID: "agent-1", RelayToken: "token", Handler: handler})
	}()

	ids := map[string]bool{}
	timeout := time.After(20 * time.Second)
	for len(ids) < total {
		select {
		case frame := <-received:
			if frame.Status != http.StatusOK {
				t.Fatalf("response status = %d, want 200", frame.Status)
			}
			ids[frame.ID] = true
		case <-timeout:
			t.Fatalf("received %d of %d responses", len(ids), total)
		}
	}
}

func TestConnectHandlesRequestsConcurrently(t *testing.T) {
	slowStarted := make(chan struct{})
	releaseSlow := make(chan struct{})
	handler := func(ctx context.Context, frame Frame, emit func(Frame) error) error {
		if frame.Path == "/slow" {
			close(slowStarted)
			select {
			case <-releaseSlow:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return emit(Frame{Type: "response", ID: frame.ID, Status: http.StatusOK, Body: map[string]string{"path": frame.Path}})
	}

	fastResponse := make(chan Frame, 1)
	relay := fakeRelay(t, func(conn *websocket.Conn) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, frame := range []Frame{
			{Type: "request", ID: "slow", Method: http.MethodGet, Path: "/slow"},
			{Type: "request", ID: "fast", Method: http.MethodGet, Path: "/fast"},
		} {
			if err := writeRelayFrame(ctx, conn, frame); err != nil {
				return
			}
			if frame.ID == "slow" {
				select {
				case <-slowStarted:
				case <-ctx.Done():
					return
				}
			}
		}
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var frame Frame
			if err := json.Unmarshal(data, &frame); err != nil {
				return
			}
			if frame.ID == "fast" {
				fastResponse <- frame
				return
			}
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = connect(ctx, Config{RelayURL: relay.URL, AgentID: "agent-1", RelayToken: "token", Handler: handler})
	}()

	select {
	case frame := <-fastResponse:
		if frame.Status != http.StatusOK {
			t.Fatalf("fast response status = %d, want 200", frame.Status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("fast request was blocked behind the slow request")
	}
	close(releaseSlow)
}

func TestConnectRepliesPongToPing(t *testing.T) {
	pongs := make(chan Frame, 1)
	relay := fakeRelay(t, func(conn *websocket.Conn) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := writeRelayFrame(ctx, conn, Frame{Type: "ping", ID: "ping-1"}); err != nil {
			return
		}
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var frame Frame
			if err := json.Unmarshal(data, &frame); err != nil {
				return
			}
			if frame.Type == "pong" {
				pongs <- frame
				return
			}
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = connect(ctx, Config{RelayURL: relay.URL, AgentID: "agent-1", RelayToken: "token", Handler: func(context.Context, Frame, func(Frame) error) error { return nil }})
	}()

	select {
	case frame := <-pongs:
		if frame.ID != "ping-1" {
			t.Fatalf("pong id = %q, want ping-1", frame.ID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for pong")
	}
}

func TestConnectReportsBusyWhenSaturated(t *testing.T) {
	const saturation = 16
	release := make(chan struct{})
	var started sync.WaitGroup
	started.Add(saturation)
	handler := func(ctx context.Context, frame Frame, emit func(Frame) error) error {
		started.Done()
		select {
		case <-release:
		case <-ctx.Done():
		}
		return emit(Frame{Type: "response", ID: frame.ID, Status: http.StatusOK})
	}

	busy := make(chan Frame, 1)
	relay := fakeRelay(t, func(conn *websocket.Conn) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for i := 0; i < saturation; i++ {
			_ = writeRelayFrame(ctx, conn, Frame{Type: "request", ID: fmt.Sprintf("sat-%d", i), Method: http.MethodGet, Path: "/hang"})
		}
		started.Wait()
		_ = writeRelayFrame(ctx, conn, Frame{Type: "request", ID: "extra", Method: http.MethodGet, Path: "/hang"})
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var frame Frame
			if err := json.Unmarshal(data, &frame); err != nil {
				return
			}
			if frame.ID == "extra" {
				busy <- frame
				return
			}
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = connect(ctx, Config{RelayURL: relay.URL, AgentID: "agent-1", RelayToken: "token", Handler: handler})
	}()

	select {
	case frame := <-busy:
		if frame.Type != "error" || frame.Code != "COMPANION_BUSY" {
			t.Fatalf("extra frame = %+v, want COMPANION_BUSY error", frame)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for COMPANION_BUSY")
	}
	close(release)
}

func TestRunReconnectsWithBackoffReset(t *testing.T) {
	connections := make(chan struct{}, 4)
	drop := make(chan struct{}, 4)
	var mu sync.Mutex
	count := 0
	relay := fakeRelay(t, func(conn *websocket.Conn) {
		mu.Lock()
		count++
		current := count
		mu.Unlock()
		connections <- struct{}{}
		if current == 1 {
			<-drop
			_ = conn.Close(websocket.StatusGoingAway, "drop")
			return
		}
		ctx := context.Background()
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		_ = Run(ctx, Config{RelayURL: relay.URL, AgentID: "agent-1", RelayToken: "token", Handler: func(context.Context, Frame, func(Frame) error) error { return nil }})
		close(done)
	}()

	select {
	case <-connections:
	case <-time.After(5 * time.Second):
		t.Fatal("first connection never established")
	}
	drop <- struct{}{}

	select {
	case <-connections:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not reconnect after the connection dropped")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after context cancellation")
	}
}

func TestProbeReportsCredentialFailures(t *testing.T) {
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer relay.Close()

	if err := Probe(context.Background(), Config{RelayURL: relay.URL, AgentID: "agent-1", RelayToken: "bad"}); err == nil {
		t.Fatal("Probe accepted credentials the relay rejected")
	}

	relayOK := fakeRelay(t, func(conn *websocket.Conn) {
		ctx := context.Background()
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	})
	if err := Probe(context.Background(), Config{RelayURL: relayOK.URL, AgentID: "agent-1", RelayToken: "good", Handler: nil}); err != nil {
		t.Fatalf("Probe rejected valid credentials: %v", err)
	}
}
