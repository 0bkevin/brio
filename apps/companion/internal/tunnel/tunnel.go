package tunnel

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"nhooyr.io/websocket"
)

type Config struct {
	AgentID      string
	RelayURL     string
	LocalBaseURL string
	Token        string
	RelayToken   string
}

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

type PairingPayload struct {
	URL       string `json:"url"`
	Token     string `json:"token"`
	Mode      string `json:"mode"`
	Transport string `json:"transport"`
	AgentID   string `json:"agent_id,omitempty"`
	Code      string `json:"code,omitempty"`
}

func PairingCode(payload PairingPayload) string {
	encoded, _ := json.Marshal(payload)
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func Run(ctx context.Context, cfg Config) {
	if cfg.RelayURL == "" || cfg.AgentID == "" {
		return
	}
	go func() {
		backoff := time.Second
		for ctx.Err() == nil {
			if err := connect(ctx, cfg); err != nil {
				slog.Warn("relay tunnel disconnected", "error", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
		}
	}()
}

func RegisterPairing(ctx context.Context, cfg Config) (string, string, error) {
	body := map[string]string{"agent_id": cfg.AgentID, "name": "Hermes"}
	encoded, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(cfg.RelayURL, "/")+"/pairings", bytes.NewReader(encoded))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(resp.Body)
		return "", "", fmt.Errorf("pairing registration failed: %s", strings.TrimSpace(string(data)))
	}
	var result struct {
		Code       string `json:"code"`
		AgentToken string `json:"agent_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", err
	}
	return result.Code, result.AgentToken, nil
}

func connect(ctx context.Context, cfg Config) error {
	wsURL, err := tunnelURL(cfg.RelayURL, "companion", cfg.AgentID, cfg.RelayToken)
	if err != nil {
		return err
	}
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")
	slog.Info("connected relay tunnel", "agent_id", cfg.AgentID)
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var frame Frame
		if err := json.Unmarshal(data, &frame); err != nil {
			continue
		}
		if frame.Type != "request" {
			continue
		}
		response := proxyLocal(ctx, cfg, frame)
		encoded, _ := json.Marshal(response)
		writeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err = conn.Write(writeCtx, websocket.MessageText, encoded)
		cancel()
		if err != nil {
			return err
		}
	}
}

func proxyLocal(ctx context.Context, cfg Config, frame Frame) Frame {
	method := frame.Method
	if method == "" {
		method = http.MethodGet
	}
	payload, _ := json.Marshal(frame.Body)
	target := strings.TrimRight(cfg.LocalBaseURL, "/") + frame.Path
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(payload))
	if err != nil {
		return errorFrame(frame.ID, "BAD_REQUEST", err.Error())
	}
	req.Header.Set("Content-Type", "application/json")
	if cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.Token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return errorFrame(frame.ID, "LOCAL_UNREACHABLE", err.Error())
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024))
	var body any
	if len(data) > 0 && strings.Contains(resp.Header.Get("Content-Type"), "json") {
		_ = json.Unmarshal(data, &body)
	}
	if body == nil {
		body = string(data)
	}
	return Frame{Type: "response", ID: frame.ID, Status: resp.StatusCode, Body: body}
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
