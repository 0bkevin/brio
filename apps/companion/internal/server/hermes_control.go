package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"nhooyr.io/websocket"
)

const controlEventLimit = 500
const controlEventStringLimit = 16 * 1024
const controlEventPayloadLimit = 64 * 1024

type controlCaller interface {
	Call(context.Context, string, map[string]any) (json.RawMessage, error)
	BeginControlOperation() func()
	Events(after uint64) []controlEvent
	OwnsSubagent(string, string) bool
	TrackBackground(string, string, string)
	BackgroundTasks() []controlBackgroundTask
	SyncHeartbeat(string, string, string, string)
	Heartbeat(string) *controlHeartbeatState
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

	eventMu     sync.RWMutex
	eventSeq    uint64
	events      []controlEvent
	tasks       map[string]controlBackgroundTask
	nextID      atomic.Uint64
	closed      atomic.Bool
	closing     atomic.Bool
	operationMu sync.Mutex

	heartbeatMu       sync.Mutex
	heartbeats        map[string]controlHeartbeatState
	heartbeatOnce     sync.Once
	heartbeatWG       sync.WaitGroup
	heartbeatStopping atomic.Bool
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

type controlHeartbeatState struct {
	Status           string  `json:"status"`
	Prompt           string  `json:"prompt"`
	Interval         string  `json:"interval"`
	NextInSeconds    int     `json:"nextInSeconds,omitempty"`
	FireCount        int     `json:"fireCount"`
	Detail           string  `json:"detail"`
	LastError        string  `json:"lastError,omitempty"`
	RuntimeSessionID string  `json:"-"`
	NextAt           float64 `json:"-"`
	InFlight         bool    `json:"-"`
}

var (
	controlHeartbeatActive = regexp.MustCompile(`^♥ Heartbeat \(every ([^,)]+), next in ~?(\d+)s(?:, fired (\d+)[×x])?\): (.+)$`)
	controlHeartbeatPaused = regexp.MustCompile(`^⏸ Heartbeat \(paused, every ([^,)]+)(?:, fired (\d+)[×x])?\): (.+)$`)
)

func newControlClient(cfg Config, client *http.Client) *controlClient {
	return &controlClient{
		baseURL:    strings.TrimRight(strings.TrimSpace(cfg.HermesControlURL), "/"),
		token:      strings.TrimSpace(cfg.HermesControlToken),
		http:       client,
		pending:    map[string]chan controlResult{},
		tasks:      map[string]controlBackgroundTask{},
		heartbeats: map[string]controlHeartbeatState{},
	}
}

func (c *controlClient) Call(ctx context.Context, method string, params map[string]any) (json.RawMessage, error) {
	if c.closed.Load() {
		return nil, errors.New("Hermes control client is stopped")
	}
	if strings.TrimSpace(c.baseURL) == "" {
		return nil, errors.New("Hermes control URL is not configured")
	}
	if strings.TrimSpace(c.token) == "" {
		return nil, errors.New("Hermes control token is not configured")
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

// BeginControlOperation serializes multi-RPC mutations. Hermes serializes
// slash.exec itself, but a Brio action often includes status checks and a
// follow-up prompt. Keeping the whole sequence ordered prevents another
// mobile action (or a due heartbeat) from changing the same session midway.
func (c *controlClient) BeginControlOperation() func() {
	c.operationMu.Lock()
	return c.operationMu.Unlock
}

func (c *controlClient) ensureConnected(ctx context.Context) (*websocket.Conn, error) {
	if c.closed.Load() {
		return nil, errors.New("Hermes control client is stopped")
	}
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
	if u.Scheme == "ws" && !isLoopbackControlHost(u.Hostname()) {
		return "", errors.New("insecure Hermes control URLs are limited to loopback; use HTTPS/WSS for remote hosts")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/ws"
	if token != "" {
		query := u.Query()
		query.Set("token", token)
		u.RawQuery = query.Encode()
	}
	return u.String(), nil
}

func isLoopbackControlHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
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
	event.Payload = sanitizeControlEventPayload(event.Type, event.Payload)
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
	c.mu.Lock()
	connected := c.conn != nil
	c.mu.Unlock()
	c.eventMu.Lock()
	existing, completedBeforeTracking := c.tasks[taskID]
	if completedBeforeTracking && existing.Status != "" && existing.Status != "running" {
		existing.SessionID = sessionID
		existing.Prompt = prompt
		if existing.StartedAt == 0 {
			existing.StartedAt = float64(time.Now().UnixMilli()) / 1000
		}
		c.tasks[taskID] = existing
		c.eventMu.Unlock()
		return
	}
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
	status := "running"
	output := ""
	finishedAt := float64(0)
	if !connected {
		status = "unknown"
		finishedAt = float64(time.Now().UnixMilli()) / 1000
		output = "Hermes control connection was lost before completion could be observed. The task may still have finished."
	}
	c.tasks[taskID] = controlBackgroundTask{
		TaskID:     taskID,
		SessionID:  sessionID,
		Prompt:     prompt,
		Status:     status,
		StartedAt:  float64(time.Now().UnixMilli()) / 1000,
		FinishedAt: finishedAt,
		Output:     output,
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

func (c *controlClient) SyncHeartbeat(storedSessionID string, runtimeSessionID string, command string, output string) {
	storedSessionID = strings.TrimSpace(storedSessionID)
	runtimeSessionID = strings.TrimSpace(runtimeSessionID)
	if storedSessionID == "" || runtimeSessionID == "" {
		return
	}
	state, ok := parseControlHeartbeatStatus(output)
	c.heartbeatMu.Lock()
	if !ok {
		delete(c.heartbeats, storedSessionID)
		c.heartbeatMu.Unlock()
		return
	}
	existing, existed := c.heartbeats[storedSessionID]
	state.RuntimeSessionID = runtimeSessionID
	if existed && !isHeartbeatReplacementCommand(command) && existing.Prompt == state.Prompt && existing.Interval == state.Interval {
		if existing.FireCount > state.FireCount {
			state.FireCount = existing.FireCount
		}
		state.InFlight = existing.InFlight
		state.LastError = existing.LastError
	}
	c.heartbeats[storedSessionID] = state
	c.heartbeatMu.Unlock()
	if !c.heartbeatStopping.Load() {
		c.heartbeatOnce.Do(func() { go c.heartbeatLoop() })
	}
}

func parseControlHeartbeatStatus(output string) (controlHeartbeatState, bool) {
	line := strings.TrimSpace(strings.Split(strings.ReplaceAll(output, "\r", ""), "\n")[0])
	if line == "" || strings.HasPrefix(strings.ToLower(line), "no heartbeat") {
		return controlHeartbeatState{}, false
	}
	if match := controlHeartbeatActive.FindStringSubmatch(line); match != nil {
		next, _ := strconv.Atoi(match[2])
		fires, _ := strconv.Atoi(match[3])
		return controlHeartbeatState{
			Status:        "active",
			Prompt:        match[4],
			Interval:      match[1],
			NextInSeconds: next,
			FireCount:     fires,
			Detail:        line,
			NextAt:        float64(time.Now().UnixMilli())/1000 + float64(next),
		}, true
	}
	if match := controlHeartbeatPaused.FindStringSubmatch(line); match != nil {
		fires, _ := strconv.Atoi(match[2])
		return controlHeartbeatState{
			Status:    "paused",
			Prompt:    match[3],
			Interval:  match[1],
			FireCount: fires,
			Detail:    line,
		}, true
	}
	return controlHeartbeatState{}, false
}

func (c *controlClient) Heartbeat(storedSessionID string) *controlHeartbeatState {
	c.heartbeatMu.Lock()
	defer c.heartbeatMu.Unlock()
	state, ok := c.heartbeats[strings.TrimSpace(storedSessionID)]
	if !ok {
		return nil
	}
	if state.Status == "active" {
		state.NextInSeconds = max(0, int(state.NextAt-float64(time.Now().UnixMilli())/1000))
		fired := ""
		if state.FireCount > 0 {
			fired = fmt.Sprintf(", fired %d×", state.FireCount)
		}
		state.Detail = fmt.Sprintf("♥ Heartbeat (every %s, next in ~%ds%s): %s", state.Interval, state.NextInSeconds, fired, state.Prompt)
	}
	return &state
}

func (c *controlClient) heartbeatLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for range ticker.C {
		now := float64(time.Now().UnixMilli()) / 1000
		due := []string{}
		c.heartbeatMu.Lock()
		if c.closed.Load() || c.heartbeatStopping.Load() {
			c.heartbeatMu.Unlock()
			return
		}
		for storedSessionID, state := range c.heartbeats {
			if state.Status == "active" && !state.InFlight && state.NextAt <= now {
				state.InFlight = true
				c.heartbeats[storedSessionID] = state
				due = append(due, storedSessionID)
				c.heartbeatWG.Add(1)
			}
		}
		c.heartbeatMu.Unlock()
		for _, storedSessionID := range due {
			go func() {
				defer c.heartbeatWG.Done()
				c.fireHeartbeat(storedSessionID)
			}()
		}
	}
}

func (c *controlClient) fireHeartbeat(storedSessionID string) {
	finishOperation := c.BeginControlOperation()
	defer finishOperation()

	c.heartbeatMu.Lock()
	state, ok := c.heartbeats[storedSessionID]
	c.heartbeatMu.Unlock()
	if !ok || state.Status != "active" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	resumed, err := c.Call(ctx, "session.resume", map[string]any{
		"session_id":    storedSessionID,
		"omit_messages": true,
	})
	if err != nil {
		c.finishHeartbeatAttempt(storedSessionID, err, 30*time.Second)
		return
	}
	var resumedSession struct {
		SessionID string `json:"session_id"`
	}
	if json.Unmarshal(resumed, &resumedSession) != nil || strings.TrimSpace(resumedSession.SessionID) == "" {
		c.finishHeartbeatAttempt(storedSessionID, errors.New("Hermes returned an invalid session.resume result for heartbeat"), 30*time.Second)
		return
	}
	runtimeSessionID := strings.TrimSpace(resumedSession.SessionID)
	status, err := c.Call(ctx, "session.status", map[string]any{"session_id": runtimeSessionID})
	if err != nil {
		c.finishHeartbeatAttempt(storedSessionID, err, 30*time.Second)
		return
	}
	statusOutput := strings.ToLower(controlResultOutput(status))
	if statusOutput == "" {
		c.finishHeartbeatAttempt(storedSessionID, errors.New("Hermes returned an invalid session.status result for heartbeat"), 30*time.Second)
		return
	}
	if strings.Contains(statusOutput, "agent running: yes") {
		c.finishHeartbeatAttempt(storedSessionID, nil, 5*time.Second)
		return
	}
	pause, err := c.Call(ctx, "slash.exec", map[string]any{
		"session_id": runtimeSessionID,
		"command":    "heartbeat pause",
	})
	if err != nil {
		c.finishHeartbeatAttempt(storedSessionID, err, 30*time.Second)
		return
	}
	pauseOutput := strings.ToLower(controlResultOutput(pause))
	if strings.HasPrefix(pauseOutput, "no heartbeat") {
		c.SyncHeartbeat(storedSessionID, runtimeSessionID, "heartbeat clear", "No heartbeat set.")
		return
	}
	if !strings.HasPrefix(pauseOutput, "⏸ heartbeat paused") {
		c.finishHeartbeatAttempt(storedSessionID, errors.New("Hermes did not pause the due heartbeat"), 30*time.Second)
		return
	}
	resumedHeartbeat := false
	defer func() {
		if !resumedHeartbeat {
			resumeContext, cancelResume := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancelResume()
			_, _ = c.Call(resumeContext, "slash.exec", map[string]any{
				"session_id": runtimeSessionID,
				"command":    "heartbeat resume",
			})
		}
	}()
	prompt := fmt.Sprintf(
		"[Heartbeat — recurring instruction, fires every %s]\n%s\n\nIf there is nothing meaningful to do or report for this instruction right now, reply briefly that nothing has changed and stop — do not invent work.",
		state.Interval,
		state.Prompt,
	)
	if _, err = c.Call(ctx, "prompt.submit", map[string]any{
		"session_id": runtimeSessionID,
		"text":       prompt,
		"queued":     true,
	}); err != nil {
		c.finishHeartbeatAttempt(storedSessionID, err, 30*time.Second)
		return
	}
	c.heartbeatMu.Lock()
	if current, exists := c.heartbeats[storedSessionID]; exists {
		current.FireCount = max(current.FireCount, state.FireCount+1)
		c.heartbeats[storedSessionID] = current
	}
	c.heartbeatMu.Unlock()
	if _, err = c.Call(ctx, "slash.exec", map[string]any{
		"session_id": runtimeSessionID,
		"command":    "heartbeat resume",
	}); err != nil {
		c.finishHeartbeatAttempt(storedSessionID, err, 30*time.Second)
		return
	}
	resumedHeartbeat = true
	heartbeatStatus, err := c.Call(ctx, "slash.exec", map[string]any{
		"session_id": runtimeSessionID,
		"command":    "heartbeat status",
	})
	if err != nil {
		c.finishHeartbeatAttempt(storedSessionID, err, 30*time.Second)
		return
	}
	c.SyncHeartbeat(storedSessionID, runtimeSessionID, "heartbeat status", controlResultOutput(heartbeatStatus))
	c.heartbeatMu.Lock()
	if current, exists := c.heartbeats[storedSessionID]; exists {
		current.InFlight = false
		current.LastError = ""
		c.heartbeats[storedSessionID] = current
	}
	c.heartbeatMu.Unlock()
}

func (c *controlClient) finishHeartbeatAttempt(storedSessionID string, err error, retryAfter time.Duration) {
	c.heartbeatMu.Lock()
	defer c.heartbeatMu.Unlock()
	state, ok := c.heartbeats[storedSessionID]
	if !ok {
		return
	}
	state.InFlight = false
	state.NextAt = float64(time.Now().Add(retryAfter).UnixMilli()) / 1000
	if err != nil {
		state.LastError = err.Error()
	} else {
		state.LastError = ""
	}
	c.heartbeats[storedSessionID] = state
}

func allowedControlEvent(eventType string) bool {
	switch eventType {
	case "background.complete", "subagent.spawn_requested", "subagent.start", "subagent.tool",
		"subagent.progress", "subagent.complete",
		"approval.request", "approval.resolved", "notification.show", "notification.clear":
		return true
	default:
		return false
	}
}

func sanitizeControlEventPayload(eventType string, raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var source map[string]any
	if json.Unmarshal(raw, &source) != nil {
		return nil
	}
	allowed := map[string]bool{}
	switch {
	case eventType == "background.complete":
		allowed = controlEventFields("task_id", "text")
	case strings.HasPrefix(eventType, "subagent."):
		// Deliberately omit output_tail, tool previews, and all reasoning text.
		// The mobile control surface needs lifecycle, ownership, usage, and files,
		// not private child transcripts or tool results.
		allowed = controlEventFields(
			"subagent_id", "parent_id", "child_session_id", "goal", "model",
			"status", "summary", "tool_name", "task_count", "task_index", "depth",
			"tool_count", "input_tokens", "output_tokens", "reasoning_tokens",
			"api_calls", "cost_usd", "duration_seconds", "files_read", "files_written",
		)
	case eventType == "approval.request" || eventType == "approval.resolved":
		allowed = controlEventFields(
			"request_id", "choices", "choice", "command", "description", "message",
			"status", "smart_denied", "allow_permanent",
		)
	case eventType == "notification.show":
		allowed = controlEventFields("id", "key", "kind", "level", "text", "ttl_ms")
	case eventType == "notification.clear":
		allowed = controlEventFields("key")
	}
	safe := make(map[string]any, len(allowed))
	for key := range allowed {
		if value, ok := source[key]; ok {
			safe[key] = sanitizeControlEventValue(value, 0)
		}
	}
	encoded, err := json.Marshal(safe)
	if err != nil {
		return nil
	}
	if len(encoded) > controlEventPayloadLimit {
		// Keep only routing/lifecycle fields when an upstream event contains an
		// unexpectedly large collection. Ownership must remain usable, but one
		// event must never retain megabytes of transcript-adjacent metadata.
		essential := map[string]any{}
		for _, key := range []string{
			"subagent_id", "parent_id", "child_session_id", "task_id",
			"request_id", "id", "key", "status", "choice", "level", "kind",
		} {
			if value, ok := safe[key]; ok {
				essential[key] = value
			}
		}
		encoded, err = json.Marshal(essential)
		if err != nil || len(encoded) > controlEventPayloadLimit {
			return nil
		}
	}
	return encoded
}

func controlEventFields(keys ...string) map[string]bool {
	fields := make(map[string]bool, len(keys))
	for _, key := range keys {
		fields[key] = true
	}
	return fields
}

func sanitizeControlEventValue(value any, depth int) any {
	if depth > 4 {
		return nil
	}
	switch typed := value.(type) {
	case string:
		return truncateControlEventString(typed)
	case []any:
		limit := len(typed)
		if limit > 40 {
			limit = 40
		}
		result := make([]any, 0, limit)
		for _, item := range typed[:limit] {
			result = append(result, sanitizeControlEventValue(item, depth+1))
		}
		return result
	case map[string]any:
		// Nested objects are not part of the administrative event contract.
		return nil
	case nil, bool, float64:
		return typed
	default:
		return nil
	}
}

func truncateControlEventString(value string) string {
	if len(value) <= controlEventStringLimit {
		return value
	}
	end := controlEventStringLimit
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end] + "…"
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

func (c *controlClient) OwnsSubagent(runtimeSessionID string, subagentID string) bool {
	runtimeSessionID = strings.TrimSpace(runtimeSessionID)
	subagentID = strings.TrimSpace(subagentID)
	if runtimeSessionID == "" || subagentID == "" {
		return false
	}
	c.eventMu.RLock()
	defer c.eventMu.RUnlock()
	for index := len(c.events) - 1; index >= 0; index-- {
		event := c.events[index]
		if !strings.HasPrefix(event.Type, "subagent.") {
			continue
		}
		var payload struct {
			SubagentID string `json:"subagent_id"`
		}
		if json.Unmarshal(event.Payload, &payload) == nil && payload.SubagentID == subagentID {
			return event.SessionID == runtimeSessionID
		}
	}
	return false
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
	if conn != nil {
		_ = conn.Close(websocket.StatusInternalError, "connection lost")
	}
	for _, ch := range pending {
		select {
		case ch <- controlResult{err: fmt.Errorf("Hermes control connection closed: %w", reason)}:
		default:
		}
	}
	c.markRunningBackgroundTasksUnknown()
	if !c.closed.Load() {
		go c.reconnectLoop()
	}
}

func (c *controlClient) Close() {
	if c.closing.Swap(true) {
		return
	}
	c.heartbeatStopping.Store(true)
	c.heartbeatMu.Lock()
	c.heartbeatMu.Unlock()
	c.heartbeatWG.Wait()
	c.closed.Store(true)
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

func (c *controlClient) reconnectLoop() {
	delay := time.Second
	for !c.closed.Load() {
		timer := time.NewTimer(delay)
		for !c.closed.Load() {
			select {
			case <-timer.C:
				goto connect
			case <-time.After(100 * time.Millisecond):
			}
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		return

	connect:
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		_, err := c.ensureConnected(ctx)
		cancel()
		if err == nil || c.closed.Load() {
			return
		}
		if delay < 30*time.Second {
			delay *= 2
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
		}
	}
}

func (c *controlClient) markRunningBackgroundTasksUnknown() {
	c.eventMu.Lock()
	defer c.eventMu.Unlock()
	now := float64(time.Now().UnixMilli()) / 1000
	for id, task := range c.tasks {
		if task.Status != "running" {
			continue
		}
		task.Status = "unknown"
		task.FinishedAt = now
		task.Output = "Hermes control connection was lost before completion could be observed. The task may still have finished."
		c.tasks[id] = task
	}
}
