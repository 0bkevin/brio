package hermes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/brio/brio/apps/connect/internal/tunnel"
	"nhooyr.io/websocket"
)

func TestGatewayChannelTransparentlyProxiesHermesWebSocket(t *testing.T) {
	received := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ws" || r.URL.Query().Get("token") != "control-secret" {
			t.Errorf("gateway request = %s token=%q", r.URL.Path, r.URL.Query().Get("token"))
			http.Error(w, "bad gateway request", http.StatusBadRequest)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		_ = conn.Write(context.Background(), websocket.MessageText, []byte(`{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready"}}`))
		_, payload, err := conn.Read(context.Background())
		if err == nil {
			received <- string(payload)
		}
	}))
	defer server.Close()

	client := &Client{
		ControlBaseURL: server.URL,
		ControlToken:   "control-secret",
		HTTP:           server.Client(),
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	frames := make(chan tunnel.Frame, 4)
	emit := func(frame tunnel.Frame) error {
		frames <- frame
		return nil
	}
	if err := client.Serve(ctx, tunnel.Frame{Type: "channel_open", ID: "ws-1", Path: "/api/ws"}, emit); err != nil {
		t.Fatal(err)
	}
	if frame := <-frames; frame.Type != "channel_opened" {
		t.Fatalf("first frame = %+v, want channel_opened", frame)
	}
	if frame := <-frames; frame.Type != "channel_data" || frame.Data == "" {
		t.Fatalf("second frame = %+v, want gateway event data", frame)
	}
	request := `{"jsonrpc":"2.0","id":"r1","method":"gateway.ping","params":{}}`
	if err := client.Serve(ctx, tunnel.Frame{Type: "channel_data", ID: "ws-1", Data: request}, emit); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-received:
		if got != request {
			t.Fatalf("upstream payload = %q, want %q", got, request)
		}
	case <-ctx.Done():
		t.Fatal("upstream did not receive channel data")
	}
	if err := client.Serve(ctx, tunnel.Frame{Type: "channel_close", ID: "ws-1"}, emit); err != nil {
		t.Fatal(err)
	}
}

func TestGatewayChannelRejectsNonGatewayPaths(t *testing.T) {
	client := &Client{ControlBaseURL: "http://127.0.0.1:9119", ControlToken: "secret"}
	var got tunnel.Frame
	err := client.Serve(context.Background(), tunnel.Frame{
		Type: "channel_open", ID: "ws-1", Path: "/v1/runs",
	}, func(frame tunnel.Frame) error {
		got = frame
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != "channel_error" || got.Code != "BAD_CHANNEL_PATH" {
		t.Fatalf("frame = %+v, want BAD_CHANNEL_PATH", got)
	}
}
