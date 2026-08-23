package hermes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/iotest"

	"github.com/brio/brio/apps/connect/internal/tunnel"
)

func collectFrames(ctx context.Context, t *testing.T, client *Client, frame tunnel.Frame) []tunnel.Frame {
	t.Helper()
	frames := []tunnel.Frame{}
	emit := func(f tunnel.Frame) error {
		// Round-trip through JSON like the tunnel wire does.
		encoded, err := json.Marshal(f)
		if err != nil {
			return err
		}
		var decoded tunnel.Frame
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			return err
		}
		frames = append(frames, decoded)
		return nil
	}
	if err := client.Serve(ctx, frame, emit); err != nil {
		t.Fatalf("Serve returned error: %v", err)
	}
	return frames
}

func TestRoutePath(t *testing.T) {
	tests := []struct {
		path      string
		kind      RouteKind
		forwardTo string
		localName string
	}{
		{path: "/health", kind: RouteForward, forwardTo: "/health"},
		{path: "/v1/capabilities", kind: RouteForward, forwardTo: "/v1/capabilities"},
		{path: "/capabilities", kind: RouteForward, forwardTo: "/v1/capabilities"},
		{path: "/v1/responses", kind: RouteForward, forwardTo: "/v1/responses"},
		{path: "/chat/responses", kind: RouteForward, forwardTo: "/v1/responses"},
		{path: "/v1/runs", kind: RouteForward, forwardTo: "/v1/runs"},
		{path: "/v1/runs/run_1", kind: RouteForward, forwardTo: "/v1/runs/run_1"},
		{path: "/v1/runs/run_1/events", kind: RouteForward, forwardTo: "/v1/runs/run_1/events"},
		{path: "/v1/runs/run_1/approval", kind: RouteForward, forwardTo: "/v1/runs/run_1/approval"},
		{path: "/api/jobs", kind: RouteForward, forwardTo: "/api/jobs"},
		{path: "/api/jobs/job_1", kind: RouteForward, forwardTo: "/api/jobs/job_1"},
		{path: "/api/jobs/job_1/pause", kind: RouteForward, forwardTo: "/api/jobs/job_1/pause"},
		{path: "/api/sessions", kind: RouteForward, forwardTo: "/api/sessions"},
		{path: "/api/sessions/sess_1/messages", kind: RouteForward, forwardTo: "/api/sessions/sess_1/messages"},
		{path: "/v1/memory", kind: RouteLocal, localName: "memory"},
		{path: "/memory", kind: RouteLocal, localName: "memory"},
		{path: "/composer/capabilities", kind: RouteLocal, localName: "composer-capabilities"},
		{path: "/composer/commands", kind: RouteLocal, localName: "composer-commands"},
		{path: "/composer/prepare", kind: RouteLocal, localName: "composer-prepare"},
		{path: "/composer/redirect", kind: RouteLocal, localName: "composer-redirect"},
		{path: "/attachments", kind: RouteLocal, forwardTo: "/attachments", localName: "composer-attachments"},
		{path: "/attachments/0123456789abcdef0123456789abcdef/chunks/0", kind: RouteLocal, forwardTo: "/attachments/0123456789abcdef0123456789abcdef/chunks/0", localName: "composer-attachment"},

		{path: "/files/write", kind: RouteUnknown},
		{path: "/files/read", kind: RouteUnknown},
		{path: "/config/raw", kind: RouteUnknown},
		{path: "/gateway/restart", kind: RouteUnknown},
		{path: "/gateway/status", kind: RouteUnknown},
		{path: "/skills", kind: RouteUnknown},
		{path: "/tools/toolsets", kind: RouteUnknown},
		{path: "/logs", kind: RouteUnknown},
		{path: "/sessions/search", kind: RouteUnknown},
		{path: "/v1/sessions/search", kind: RouteUnknown},
		{path: "/v1/sessions/sess_1", kind: RouteUnknown},
		{path: "/v1/sessions/sess_1/messages/extra", kind: RouteUnknown},
		{path: "/api/sessions/search", kind: RouteUnknown},
		{path: "/api/sessions/sess_1", kind: RouteUnknown},
		{path: "/api/sessions/sess_1/messages/extra", kind: RouteUnknown},
		{path: "/v1/unknown", kind: RouteUnknown},
		{path: "/", kind: RouteUnknown},
	}
	for _, tt := range tests {
		got := RoutePath(tt.path)
		if got.Kind != tt.kind {
			t.Fatalf("RoutePath(%q) kind = %d, want %d", tt.path, got.Kind, tt.kind)
		}
		if got.Path != tt.forwardTo {
			t.Fatalf("RoutePath(%q) forward path = %q, want %q", tt.path, got.Path, tt.forwardTo)
		}
		if tt.kind == RouteLocal && got.Name != tt.localName {
			t.Fatalf("RoutePath(%q) local name = %q, want %q", tt.path, got.Name, tt.localName)
		}
	}
}

func TestServeReplacesAuthorizationWithHermesKey(t *testing.T) {
	var gotAuth, gotPath string
	hermes := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	defer hermes.Close()

	client := &Client{BaseURL: hermes.URL, APIKey: "hermes-key", Home: t.TempDir()}
	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "r1", Method: http.MethodGet, Path: "/health",
		Headers: map[string]string{"Authorization": "Bearer frame-token"},
	})
	if gotAuth != "Bearer hermes-key" {
		t.Fatalf("Authorization = %q, want Bearer hermes-key", gotAuth)
	}
	if gotPath != "/health" {
		t.Fatalf("path = %q, want /health", gotPath)
	}
	if len(frames) != 1 || frames[0].Type != "response" || frames[0].Status != http.StatusOK {
		t.Fatalf("frames = %+v, want one 200 response", frames)
	}
	body, ok := frames[0].Body.(map[string]any)
	if !ok || body["ok"] != true {
		t.Fatalf("response body = %#v, want {ok: true}", frames[0].Body)
	}
}

func TestServeMapsLegacyAliases(t *testing.T) {
	seen := map[string]string{}
	hermes := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen[r.Method+" "+r.URL.Path] = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	defer hermes.Close()

	client := &Client{BaseURL: hermes.URL, APIKey: "hermes-key", Home: t.TempDir()}
	collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "a1", Method: http.MethodPost, Path: "/chat/responses", Body: map[string]string{"input": "hi"},
	})
	collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "a2", Method: http.MethodGet, Path: "/capabilities",
	})
	collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "a3", Method: http.MethodGet, Path: "/api/jobs?status=pending",
	})
	collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "a4", Method: http.MethodGet, Path: "/api/sessions?limit=5",
	})
	collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "a5", Method: http.MethodGet, Path: "/api/sessions/session_1/messages?order=latest",
	})
	for _, want := range []string{
		"POST /v1/responses",
		"GET /v1/capabilities",
		"GET /api/jobs",
		"GET /api/sessions",
		"GET /api/sessions/session_1/messages",
	} {
		if _, ok := seen[want]; !ok {
			t.Fatalf("alias was not forwarded as %q; seen = %v", want, seen)
		}
	}
	if seen["GET /api/jobs"] != "status=pending" {
		t.Fatalf("query string was dropped: %q", seen["GET /api/jobs"])
	}
	if seen["GET /api/sessions"] != "limit=5" || seen["GET /api/sessions/session_1/messages"] != "order=latest" {
		t.Fatalf("session query strings were dropped: %v", seen)
	}
}

func TestServeRejectsUnknownPath(t *testing.T) {
	client := &Client{BaseURL: "http://127.0.0.1:1", APIKey: "hermes-key", Home: t.TempDir()}
	for _, path := range []string{"/files/write", "/config/raw", "/gateway/restart", "/skills", "/tools/toolsets", "/logs"} {
		frames := collectFrames(context.Background(), t, client, tunnel.Frame{
			Type: "request", ID: "u1", Method: http.MethodGet, Path: path,
		})
		if len(frames) != 1 || frames[0].Type != "error" || frames[0].Code != "NOT_FOUND" {
			t.Fatalf("path %q frames = %+v, want NOT_FOUND error", path, frames)
		}
		if !strings.Contains(frames[0].Message, "404") && !strings.Contains(frames[0].Message, "no route") {
			t.Fatalf("path %q message = %q, want a 404-style message", path, frames[0].Message)
		}
	}
}

func TestServeRejectsRelativePath(t *testing.T) {
	client := &Client{BaseURL: "http://127.0.0.1:1", Home: t.TempDir()}
	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "b1", Method: http.MethodGet, Path: "health",
	})
	if len(frames) != 1 || frames[0].Type != "error" || frames[0].Code != "BAD_REQUEST" {
		t.Fatalf("frames = %+v, want BAD_REQUEST error", frames)
	}
}

func TestServeReportsUnreachableHermes(t *testing.T) {
	client := &Client{BaseURL: "http://127.0.0.1:1", APIKey: "k", Home: t.TempDir()}
	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "d1", Method: http.MethodGet, Path: "/health",
	})
	if len(frames) != 1 || frames[0].Type != "error" || frames[0].Code != "LOCAL_UNREACHABLE" {
		t.Fatalf("frames = %+v, want LOCAL_UNREACHABLE error", frames)
	}
}

func TestServeRejectsOversizedResponse(t *testing.T) {
	hermes := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(make([]byte, maxResponseBytes+1))
	}))
	defer hermes.Close()

	client := &Client{BaseURL: hermes.URL, Home: t.TempDir()}
	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "large", Method: http.MethodGet, Path: "/health",
	})
	if len(frames) != 1 || frames[0].Type != "error" || frames[0].Code != "RESPONSE_TOO_LARGE" {
		t.Fatalf("frames = %+v, want RESPONSE_TOO_LARGE error", frames)
	}
}

func TestServeForwardsSSEAsStreamFrames(t *testing.T) {
	hermes := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\n")
		flusher.Flush()
		_, _ = io.WriteString(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}\n\n")
	}))
	defer hermes.Close()

	client := &Client{BaseURL: hermes.URL, Home: t.TempDir()}
	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "stream", Method: http.MethodPost, Path: "/v1/responses", Body: map[string]string{"input": "hi"},
	})

	var end *tunnel.Frame
	chunks := 0
	var streamed strings.Builder
	for i := range frames {
		switch frames[i].Type {
		case "stream_chunk":
			chunks++
			streamed.WriteString(frames[i].Data)
		case "stream_end":
			end = &frames[i]
		case "error":
			t.Fatalf("unexpected error frame: %+v", frames[i])
		}
	}
	if chunks == 0 {
		t.Fatal("expected at least one stream chunk")
	}
	if !strings.Contains(streamed.String(), "response.output_text.delta") || !strings.Contains(streamed.String(), "response.completed") {
		t.Fatalf("stream data = %q, want the complete SSE events", streamed.String())
	}
	if end == nil {
		t.Fatalf("frames = %+v, want a terminal stream_end", frames)
	}
	if end.Status != http.StatusOK {
		t.Fatalf("stream_end status = %d, want 200", end.Status)
	}
	if end.Body != nil {
		t.Fatalf("stream_end body = %#v, want an empty terminal marker", end.Body)
	}
}

func TestStreamEventStreamPreservesSplitUTF8(t *testing.T) {
	sse := "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Olá 👋 世界\"}\n\n"
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(iotest.OneByteReader(strings.NewReader(sse))),
	}
	frames := []tunnel.Frame{}
	err := streamEventStream("unicode", resp, func(frame tunnel.Frame) error {
		encoded, err := json.Marshal(frame)
		if err != nil {
			return err
		}
		var decoded tunnel.Frame
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			return err
		}
		frames = append(frames, decoded)
		return nil
	})
	if err != nil {
		t.Fatalf("streamEventStream returned error: %v", err)
	}
	var got strings.Builder
	for _, frame := range frames {
		if frame.Type == "stream_chunk" {
			got.WriteString(frame.Data)
		}
	}
	if got.String() != sse {
		t.Fatalf("stream data = %q, want exact UTF-8 %q", got.String(), sse)
	}
	if strings.ContainsRune(got.String(), '\uFFFD') {
		t.Fatalf("stream data contains a replacement character: %q", got.String())
	}
}

func TestStreamEventStreamRejectsOversizedLine(t *testing.T) {
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(strings.Repeat("a", maxStreamBytes+1))),
	}
	frames := []tunnel.Frame{}
	err := streamEventStream("large-stream", resp, func(frame tunnel.Frame) error {
		frames = append(frames, frame)
		return nil
	})
	if err != nil {
		t.Fatalf("streamEventStream returned error: %v", err)
	}
	if len(frames) != 1 || frames[0].Type != "error" || frames[0].Code != "RESPONSE_TOO_LARGE" {
		t.Fatalf("frames = %+v, want one RESPONSE_TOO_LARGE error", frames)
	}
}
