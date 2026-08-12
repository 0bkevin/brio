package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"nhooyr.io/websocket"
)

const controlEventLimit = 500

type controlCaller interface {
	Call(context.Context, string, map[string]any) (json.RawMessage, error)
	Events(after uint64) []controlEvent
	TrackBackground(string, string, string)
	BackgroundTasks() []controlBackgroundTask
	Close()
}

type controlClient struct {
	baseURL string
	token   string
	http    *http.Client

	connectMu sync.Mutex
	writeMu   sync.Mutex
	mu        sync.Mutex
	conn      *websocket.Conn
	pending   map[string]chan controlResult

	eventMu  sync.RWMutex
	eventSeq uint64
	events   []controlEvent
	tasks    map[string]controlBackgroundTask
	nextID   atomic.Uint64
}

type controlResult struct {
	result json.RawMessage
	err    error
}

type controlRPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *controlRPCError) Error() string {
	if e == nil {
		return "Hermes control request failed"
	}
	return e.Message
}

type controlEnvelope struct {
	ID     json.RawMessage  `json:"id"`
	Method string           `json:"method"`
	Params controlEventData `json:"params"`
	Result json.RawMessage  `json:"result"`
	Error  *controlRPCError `json:"error"`
}

type controlEventData struct {
	Type      string          `json:"type"`
	SessionID string          `json:"session_id"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type controlEvent struct {
	Sequence  uint64          `json:"sequence"`
	Type      string          `json:"type"`
	SessionID string          `json:"session_id,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type controlBackgroundTask struct {
	TaskID     string  `json:"task_id"`
	SessionID  string  `json:"session_id"`
	Prompt     string  `json:"prompt"`
	Status     string  `json:"status"`
	StartedAt  float64 `json:"started_at"`
	FinishedAt float64 `json:"finished_at,omitempty"`
	Output     string  `json:"output,omitempty"`
}

func newControlClient(cfg Config, client *http.Client) *controlClient {
	return &controlClient{
		baseURL: strings.TrimRight(strings.TrimSpace(cfg.HermesControlURL), "/"),
		token:   strings.TrimSpace(cfg.HermesControlToken),
		http:    client,
		pending: map[string]chan controlResult{},
		tasks:   map[string]controlBackgroundTask{},
	}
}

func (c *controlClient) Call(ctx context.Context, method string, params map[string]any) (json.RawMessage, error) {
	if strings.TrimSpace(c.baseURL) == "" {
		return nil, errors.New("Hermes control URL is not configured")
	}
	conn, err := c.ensureConnected(ctx)
	if err != nil {
		return nil, err
	}
	id := "brio-" + strconv.FormatUint(c.nextID.Add(1), 10)
	resultCh := make(chan controlResult, 1)
	c.mu.Lock()
	c.pending[id] = resultCh
	c.mu.Unlock()

	request := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}
	payload, err := json.Marshal(request)
	if err == nil {
		c.writeMu.Lock()
		err = conn.Write(ctx, websocket.MessageText, payload)
		c.writeMu.Unlock()
	}
	if err != nil {
		c.removePending(id)
		c.disconnect(conn, err)
		return nil, fmt.Errorf("Hermes control write failed: %w", err)
	}

	select {
	case <-ctx.Done():
		c.removePending(id)
		return nil, ctx.Err()
	case response := <-resultCh:
		return response.result, response.err
	}
}

func (c *controlClient) ensureConnected(ctx context.Context) (*websocket.Conn, error) {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn != nil {
		return conn, nil
	}

	c.connectMu.Lock()
	defer c.connectMu.Unlock()
	c.mu.Lock()
	conn = c.conn
	c.mu.Unlock()
	if conn != nil {
		return conn, nil
	}

	endpoint, err := controlWebSocketURL(c.baseURL, c.token)
	if err != nil {
		return nil, err
	}
	conn, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPClient: c.http})
	if err != nil {
		if response != nil {
			return nil, fmt.Errorf("Hermes control connection failed (HTTP %d): %w", response.StatusCode, err)
		}
		return nil, fmt.Errorf("Hermes control connection failed: %w", err)
	}
	conn.SetReadLimit(16 * 1024 * 1024)
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
	go c.readLoop(conn)
	return conn, nil
}

func controlWebSocketURL(baseURL string, token string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", fmt.Errorf("invalid Hermes control URL: %w", err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported Hermes control URL scheme: %s", u.Scheme)
	}
	if u.Host == "" {
		return "", errors.New("Hermes control URL has no host")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/ws"
	if token != "" {
		query := u.Query()
		query.Set("token", token)
		u.RawQuery = query.Encode()
	}
	return u.String(), nil
}

func (c *controlClient) readLoop(conn *websocket.Conn) {
	for {
		_, payload, err := conn.Read(context.Background())
		if err != nil {
			c.disconnect(conn, err)
			return
		}
		for _, line := range strings.Split(string(payload), "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			var envelope controlEnvelope
			if json.Unmarshal([]byte(line), &envelope) != nil {
				continue
			}
			if envelope.Method == "event" {
				c.recordEvent(envelope.Params)
				continue
			}
			id := rawID(envelope.ID)
			if id == "" {
				continue
			}
			c.mu.Lock()
			ch := c.pending[id]
			delete(c.pending, id)
			c.mu.Unlock()
			if ch == nil {
				continue
			}
			if envelope.Error != nil {
				ch <- controlResult{err: envelope.Error}
			} else {
				ch <- controlResult{result: envelope.Result}
			}
		}
	}
}

func rawID(value json.RawMessage) string {
	if len(value) == 0 || string(value) == "null" {
		return ""
	}
	var id string
	if json.Unmarshal(value, &id) == nil {
		return id
	}
	return strings.TrimSpace(string(value))
}

func (c *controlClient) recordEvent(event controlEventData) {
	if !allowedControlEvent(event.Type) {
		return
	}
	c.eventMu.Lock()
	c.eventSeq++
	c.events = append(c.events, controlEvent{
		Sequence:  c.eventSeq,
		Type:      event.Type,
		SessionID: event.SessionID,
		Payload:   event.Payload,
	})
	if event.Type == "background.complete" {
		var payload struct {
			TaskID string `json:"task_id"`
			Text   string `json:"text"`
		}
		if json.Unmarshal(event.Payload, &payload) == nil && payload.TaskID != "" {
			task := c.tasks[payload.TaskID]
			task.TaskID = payload.TaskID
			if task.SessionID == "" {
				task.SessionID = event.SessionID
			}
			task.Status = "completed"
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(payload.Text)), "error:") {
				task.Status = "failed"
			}
			task.FinishedAt = float64(time.Now().UnixMilli()) / 1000
			task.Output = payload.Text
			c.tasks[payload.TaskID] = task
		}
	}
	if len(c.events) > controlEventLimit {
		c.events = append([]controlEvent(nil), c.events[len(c.events)-controlEventLimit:]...)
	}
	c.eventMu.Unlock()
}

func (c *controlClient) TrackBackground(taskID string, sessionID string, prompt string) {
	if strings.TrimSpace(taskID) == "" {
		return
	}
	c.eventMu.Lock()
	if len(c.tasks) >= controlEventLimit {
		oldestID := ""
		oldestAt := float64(0)
		for id, task := range c.tasks {
			if oldestID == "" || task.StartedAt < oldestAt {
				oldestID, oldestAt = id, task.StartedAt
			}
		}
		delete(c.tasks, oldestID)
	}
	c.tasks[taskID] = controlBackgroundTask{
		TaskID:    taskID,
		SessionID: sessionID,
		Prompt:    prompt,
		Status:    "running",
		StartedAt: float64(time.Now().UnixMilli()) / 1000,
	}
	c.eventMu.Unlock()
}

func (c *controlClient) BackgroundTasks() []controlBackgroundTask {
	c.eventMu.RLock()
	defer c.eventMu.RUnlock()
	result := make([]controlBackgroundTask, 0, len(c.tasks))
	for _, task := range c.tasks {
		result = append(result, task)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].StartedAt > result[j].StartedAt })
	return result
}

func allowedControlEvent(eventType string) bool {
	switch eventType {
	case "gateway.ready", "background.complete", "session.info", "status.update",
		"subagent.spawn_requested", "subagent.start", "subagent.tool",
		"subagent.progress", "subagent.complete",
		"approval.request", "approval.resolved", "notification.show", "notification.clear":
		return true
	default:
		return false
	}
}

func (c *controlClient) Events(after uint64) []controlEvent {
	c.eventMu.RLock()
	defer c.eventMu.RUnlock()
	result := make([]controlEvent, 0, len(c.events))
	for _, event := range c.events {
		if event.Sequence > after {
			result = append(result, event)
		}
	}
	return result
}

func (c *controlClient) removePending(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *controlClient) disconnect(conn *websocket.Conn, reason error) {
	c.mu.Lock()
	if c.conn != conn {
		c.mu.Unlock()
		return
	}
	c.conn = nil
	pending := c.pending
	c.pending = map[string]chan controlResult{}
	c.mu.Unlock()
	_ = conn.Close(websocket.StatusInternalError, "connection lost")
	for _, ch := range pending {
		select {
		case ch <- controlResult{err: fmt.Errorf("Hermes control connection closed: %w", reason)}:
		default:
		}
	}
}

func (c *controlClient) Close() {
	c.mu.Lock()
	conn := c.conn
	c.conn = nil
	pending := c.pending
	c.pending = map[string]chan controlResult{}
	c.mu.Unlock()
	if conn != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "Brio Companion stopped")
	}
	for _, ch := range pending {
		select {
		case ch <- controlResult{err: errors.New("Hermes control client stopped")}:
		default:
		}
	}
}
