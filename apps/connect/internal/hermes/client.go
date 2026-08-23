// Package hermes routes tunnel request frames: a fixed set of paths is
// forwarded to the stock Hermes API server with the local API key, memory is
// served from the Hermes home directory, and everything else is rejected.
package hermes

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/brio/brio/apps/connect/internal/tunnel"
)

// Client routes and serves tunnel request frames.
type Client struct {
	// BaseURL is the Hermes API server base URL (for example
	// http://127.0.0.1:8642).
	BaseURL string
	// APIKey is the API_SERVER_KEY bearer used for forwarded requests.
	APIKey string
	// Home is the Hermes home directory (~/.hermes).
	Home string
	// ControlBaseURL is the Hermes serve JSON-RPC endpoint.
	ControlBaseURL string
	// ControlToken authenticates the Hermes serve WebSocket session.
	ControlToken string

	HTTP *http.Client

	controlOnce sync.Once
	controlApp  *app
}

const (
	maxResponseBytes = 10 * 1024 * 1024
	maxStreamBytes   = 10 * 1024 * 1024
	forwardTimeout   = 5 * time.Minute
)

// RouteKind classifies a request path.
type RouteKind int

const (
	// RouteUnknown means the path is not served at all.
	RouteUnknown RouteKind = iota
	// RouteForward means the path is proxied to the Hermes API server.
	RouteForward
	// RouteLocal means the path is served from the Hermes home directory.
	RouteLocal
)

// Route is the routing decision for one request path.
type Route struct {
	Kind RouteKind
	// Path is the forwarded path after legacy alias mapping.
	Path string
	// Name identifies the local handler ("memory").
	Name string
}

// RoutePath maps a request path (without query string) to a route. Legacy
// companion-era aliases are mapped to their /v1 equivalents.
func RoutePath(path string) Route {
	switch path {
	case "/health":
		return Route{Kind: RouteForward, Path: "/health"}
	case "/v1/capabilities", "/capabilities":
		return Route{Kind: RouteForward, Path: "/v1/capabilities"}
	case "/v1/responses", "/chat/responses":
		return Route{Kind: RouteForward, Path: "/v1/responses"}
	case "/v1/memory", "/memory":
		return Route{Kind: RouteLocal, Name: "memory"}
	case "/control/rpc":
		return Route{Kind: RouteLocal, Name: "control-rpc"}
	case "/control/command":
		return Route{Kind: RouteLocal, Name: "control-command"}
	case "/control/background":
		return Route{Kind: RouteLocal, Name: "control-background"}
	case "/control/events":
		return Route{Kind: RouteLocal, Name: "control-events"}
	case "/api/sessions":
		return Route{Kind: RouteForward, Path: path}
	case "/api/model/options":
		return Route{Kind: RouteForward, Path: path}
	}
	switch {
	case strings.HasPrefix(path, "/v1/runs"), strings.HasPrefix(path, "/api/jobs"):
		return Route{Kind: RouteForward, Path: path}
	}
	if isSessionMessagesPath(path) || isSessionDetailPath(path) || isSessionModelPath(path) {
		return Route{Kind: RouteForward, Path: path}
	}
	return Route{Kind: RouteUnknown}
}

func isSessionMessagesPath(path string) bool {
	return isSessionTailPath(path, "messages")
}

func isSessionDetailPath(path string) bool {
	const prefix = "/api/sessions/"
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	id := strings.TrimPrefix(path, prefix)
	return id != "" && !strings.Contains(id, "/")
}

func isSessionModelPath(path string) bool {
	return isSessionTailPath(path, "model")
}

func isSessionTailPath(path string, tail string) bool {
	const prefix = "/api/sessions/"
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	id, suffix, ok := strings.Cut(strings.TrimPrefix(path, prefix), "/")
	return ok && suffix == tail && id != "" && !strings.Contains(id, "/")
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: forwardTimeout}
}

func (c *Client) commandCenter() *app {
	c.controlOnce.Do(func() {
		c.controlApp = &app{control: newControlClient(Config{
			HermesControlURL:   c.ControlBaseURL,
			HermesControlToken: c.ControlToken,
		}, c.httpClient())}
	})
	return c.controlApp
}

// Close stops the persistent Hermes control connection and heartbeat worker.
func (c *Client) Close() {
	if c.controlApp != nil {
		c.controlApp.control.Close()
	}
}

// Serve handles one tunnel request frame and emits response, stream, or
// error frames. It returns a non-nil error only when emit fails.
func (c *Client) Serve(ctx context.Context, frame tunnel.Frame, emit func(tunnel.Frame) error) error {
	method := frame.Method
	if method == "" {
		method = http.MethodGet
	}
	if frame.Path == "" || !strings.HasPrefix(frame.Path, "/") {
		return emit(errorFrame(frame.ID, "BAD_REQUEST", "request path must start with /"))
	}
	path, query, _ := strings.Cut(frame.Path, "?")
	route := RoutePath(path)
	switch route.Kind {
	case RouteForward:
		return c.forward(ctx, frame, method, route.Path, query, emit)
	case RouteLocal:
		return c.serveLocal(ctx, frame, method, route, query, emit)
	default:
		return emit(errorFrame(frame.ID, "NOT_FOUND", "no route for "+method+" "+frame.Path))
	}
}

func (c *Client) forward(ctx context.Context, frame tunnel.Frame, method string, path string, query string, emit func(tunnel.Frame) error) error {
	var requestBody io.Reader = http.NoBody
	if frame.Body != nil {
		payload, err := json.Marshal(frame.Body)
		if err != nil {
			return emit(errorFrame(frame.ID, "BAD_REQUEST", err.Error()))
		}
		requestBody = bytes.NewReader(payload)
	}
	target := strings.TrimRight(c.BaseURL, "/") + path
	if query != "" {
		target += "?" + query
	}
	req, err := http.NewRequestWithContext(ctx, method, target, requestBody)
	if err != nil {
		return emit(errorFrame(frame.ID, "BAD_REQUEST", err.Error()))
	}
	for key, value := range frame.Headers {
		switch strings.ToLower(key) {
		case "authorization", "host", "content-length":
		default:
			if value != "" {
				req.Header.Set(key, value)
			}
		}
	}
	if frame.Body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	// The local API key always replaces whatever credentials the frame
	// carried.
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return emit(errorFrame(frame.ID, "LOCAL_UNREACHABLE", err.Error()))
	}
	defer resp.Body.Close()
	contentType := resp.Header.Get("Content-Type")
	if resp.StatusCode < http.StatusBadRequest && strings.Contains(strings.ToLower(contentType), "text/event-stream") {
		return streamEventStream(frame.ID, resp, emit)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return emit(errorFrame(frame.ID, "LOCAL_READ_FAILED", err.Error()))
	}
	if len(data) > maxResponseBytes {
		return emit(errorFrame(frame.ID, "RESPONSE_TOO_LARGE", "local response is larger than 10 MiB"))
	}
	var body any
	if len(data) > 0 && strings.Contains(contentType, "json") {
		_ = json.Unmarshal(data, &body)
	}
	if body == nil {
		body = string(data)
	}
	return emit(tunnel.Frame{
		Type:    "response",
		ID:      frame.ID,
		Status:  resp.StatusCode,
		Headers: map[string]string{"Content-Type": contentType},
		Body:    body,
	})
}

// streamEventStream forwards complete SSE lines as stream_chunk frames. Line
// framing keeps UTF-8 code points intact even when the HTTP body reader splits
// a multi-byte character across reads. The mobile client owns SSE parsing, so
// stream_end is only a terminal marker and deliberately carries no body.
func streamEventStream(id string, resp *http.Response, emit func(tunnel.Frame) error) error {
	reader := bufio.NewReader(resp.Body)
	line := make([]byte, 0, 32*1024)
	total := 0
	for {
		fragment, readErr := reader.ReadSlice('\n')
		if len(fragment) > 0 {
			total += len(fragment)
			if total > maxStreamBytes {
				return emit(errorFrame(id, "RESPONSE_TOO_LARGE", "local response stream is larger than 10 MiB"))
			}
			line = append(line, fragment...)
			if readErr != bufio.ErrBufferFull {
				if err := emit(tunnel.Frame{Type: "stream_chunk", ID: id, Data: string(line)}); err != nil {
					return err
				}
				line = line[:0]
			}
		}
		if readErr != nil {
			if readErr == bufio.ErrBufferFull {
				continue
			}
			if readErr == io.EOF {
				return emit(tunnel.Frame{
					Type:    "stream_end",
					ID:      id,
					Status:  resp.StatusCode,
					Headers: map[string]string{"Content-Type": resp.Header.Get("Content-Type")},
				})
			}
			return emit(errorFrame(id, "LOCAL_READ_FAILED", readErr.Error()))
		}
	}
}

func errorFrame(id string, code string, message string) tunnel.Frame {
	return tunnel.Frame{Type: "error", ID: id, Code: code, Message: message}
}

func responseFrame(id string, status int, body any) tunnel.Frame {
	return tunnel.Frame{
		Type:    "response",
		ID:      id,
		Status:  status,
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    body,
	}
}
