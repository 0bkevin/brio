// Package tunnel keeps the outbound WebSocket connection to the Brio relay
// and dispatches inbound request frames to a request handler.
package tunnel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"time"

	"nhooyr.io/websocket"
)

// Frame is one JSON frame on the relay tunnel. The wire format is defined by
// packages/protocol/tunnel-frame.schema.json.
type Frame struct {
	Type    string            `json:"type"`
	ID      string            `json:"id"`
	Method  string            `json:"method,omitempty"`
	Path    string            `json:"path,omitempty"`
	Status  int               `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    any               `json:"body,omitempty"`
	Data    string            `json:"data,omitempty"`
	Code    string            `json:"code,omitempty"`
	Message string            `json:"message,omitempty"`
}

// Config configures one relay tunnel.
type Config struct {
	AgentID    string
	RelayURL   string
	RelayToken string
	Handler    RequestHandler
}

// RequestHandler serves one inbound request frame. Response, stream, and
// error frames are delivered through emit; the handler returns a non-nil
// error only when the connection can no longer accept frames.
type RequestHandler func(ctx context.Context, frame Frame, emit func(Frame) error) error

// EnrollmentResult is the relay response for a claimed enrollment code.
type EnrollmentResult struct {
	Agent AgentInfo `json:"agent"`
	Token string    `json:"relay_token"`
}

// AgentInfo describes an enrolled agent.
type AgentInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

const (
	maxFrameBytes         = 12 * 1024 * 1024
	maxConcurrentRequests = 16
	initialBackoff        = time.Second
	maxBackoff            = 32 * time.Second
	stableConnection      = 30 * time.Second
	pingInterval          = 25 * time.Second
	pingTimeout           = 10 * time.Second
	writeTimeout          = 15 * time.Second
	dialTimeout           = 15 * time.Second
)

var relayHTTPClient = &http.Client{Timeout: 30 * time.Second}

// ClaimEnrollment claims an enrollment code with the relay and returns the
// owned agent plus the long-lived relay token.
func ClaimEnrollment(ctx context.Context, relayURL string, code string, agentID string, name string) (EnrollmentResult, error) {
	body := map[string]string{
		"agent_id": agentID,
	}
	if strings.TrimSpace(name) != "" {
		body["name"] = strings.TrimSpace(name)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return EnrollmentResult{}, err
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		strings.TrimRight(relayURL, "/")+"/enrollments/"+url.PathEscape(strings.ToUpper(strings.TrimSpace(code)))+"/claim",
		bytes.NewReader(encoded),
	)
	if err != nil {
		return EnrollmentResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := relayHTTPClient.Do(req)
	if err != nil {
		return EnrollmentResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(resp.Body)
		return EnrollmentResult{}, fmt.Errorf("enrollment claim failed: %s", strings.TrimSpace(string(data)))
	}
	var result EnrollmentResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return EnrollmentResult{}, err
	}
	if result.Token == "" || result.Agent.ID == "" {
		return EnrollmentResult{}, fmt.Errorf("enrollment response is incomplete")
	}
	return result, nil
}

// Run keeps an outbound tunnel to the relay until ctx is cancelled,
// reconnecting with exponential backoff. It returns nil when ctx is done.
func Run(ctx context.Context, cfg Config) error {
	if cfg.RelayURL == "" || cfg.AgentID == "" {
		return fmt.Errorf("relay URL and agent id are required")
	}
	if cfg.Handler == nil {
		return fmt.Errorf("tunnel requires a request handler")
	}
	backoff := initialBackoff
	for ctx.Err() == nil {
		started := time.Now()
		if err := connect(ctx, cfg); err != nil && ctx.Err() == nil {
			slog.Warn("relay tunnel disconnected", "error", err)
		}
		if time.Since(started) > stableConnection {
			backoff = initialBackoff
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(jitter(backoff)):
		}
		if backoff < maxBackoff {
			backoff *= 2
		}
	}
	return nil
}

// Probe briefly opens the tunnel WebSocket to verify that the stored relay
// credentials are still accepted.
func Probe(ctx context.Context, cfg Config) error {
	wsURL, err := tunnelURL(cfg.RelayURL, "companion", cfg.AgentID, cfg.RelayToken)
	if err != nil {
		return err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(probeCtx, wsURL, nil)
	if err != nil {
		if resp != nil && resp.StatusCode > 0 {
			return fmt.Errorf("relay rejected tunnel credentials (HTTP %d)", resp.StatusCode)
		}
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "probe")
	return nil
}

// jitter adds +-10% jitter to a backoff duration.
func jitter(d time.Duration) time.Duration {
	scaled := time.Duration(float64(d) * (0.9 + 0.2*rand.Float64()))
	if scaled < 100*time.Millisecond {
		return 100 * time.Millisecond
	}
	return scaled
}

// connect serves one tunnel connection until it drops.
func connect(ctx context.Context, cfg Config) error {
	wsURL, err := tunnelURL(cfg.RelayURL, "companion", cfg.AgentID, cfg.RelayToken)
	if err != nil {
		return err
	}
	dialCtx, cancelDial := context.WithTimeout(ctx, dialTimeout)
	conn, _, err := websocket.Dial(dialCtx, wsURL, nil)
	cancelDial()
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")

	connCtx, cancelConnection := context.WithCancel(ctx)
	defer cancelConnection()
	conn.SetReadLimit(maxFrameBytes)

	// Single-writer discipline: every frame and ping on this connection is
	// written by one goroutine. Request handlers only push into the channel.
	writes := make(chan Frame, 64)
	go writeLoop(connCtx, conn, writes, cancelConnection)
	emit := func(frame Frame) error {
		select {
		case writes <- frame:
			return nil
		case <-connCtx.Done():
			return connCtx.Err()
		}
	}

	slog.Info("connected relay tunnel", "agent_id", cfg.AgentID)
	requests := make(chan struct{}, maxConcurrentRequests)
	for {
		_, data, err := conn.Read(connCtx)
		if err != nil {
			return err
		}
		var frame Frame
		if err := json.Unmarshal(data, &frame); err != nil {
			continue
		}
		switch frame.Type {
		case "request":
		case "ping":
			if err := emit(Frame{Type: "pong", ID: frame.ID}); err != nil {
				return err
			}
			continue
		default:
			continue
		}
		select {
		case requests <- struct{}{}:
			go func(frame Frame) {
				defer func() { <-requests }()
				if err := cfg.Handler(connCtx, frame, emit); err != nil {
					slog.Warn("tunnel request handler failed", "frame_id", frame.ID, "error", err)
				}
			}(frame)
		default:
			if err := emit(errorFrame(frame.ID, "COMPANION_BUSY", "too many requests are in progress")); err != nil {
				return err
			}
		}
	}
}

// writeLoop owns every write on the tunnel connection, including pings.
func writeLoop(ctx context.Context, conn *websocket.Conn, writes <-chan Frame, fail func()) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-writes:
			if err := writeFrame(ctx, conn, frame); err != nil {
				_ = conn.Close(websocket.StatusInternalError, "write failed")
				fail()
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				_ = conn.Close(websocket.StatusGoingAway, "ping failed")
				fail()
				return
			}
		}
	}
}

func writeFrame(ctx context.Context, conn *websocket.Conn, frame Frame) error {
	encoded, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageText, encoded)
}

func errorFrame(id string, code string, message string) Frame {
	return Frame{Type: "error", ID: id, Code: code, Message: message}
}

func tunnelURL(base string, role string, agentID string, token string) (string, error) {
	u, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported relay URL scheme: %s", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/tunnel/" + role + "/" + agentID
	if token != "" {
		q := u.Query()
		q.Set("token", token)
		u.RawQuery = q.Encode()
	} else {
		u.RawQuery = ""
	}
	return u.String(), nil
}
