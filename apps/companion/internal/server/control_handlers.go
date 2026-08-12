package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

const maxControlTextLength = 16 * 1024

type controlRPCRequest struct {
	Method  string         `json:"method"`
	Params  map[string]any `json:"params"`
	Confirm bool           `json:"confirm,omitempty"`
}

func (a *app) controlRPC(w http.ResponseWriter, r *http.Request) {
	var request controlRPCRequest
	if err := decodeJSONBody(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if err := validateControlRequest(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	result, err := a.control.Call(r.Context(), request.Method, request.Params)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeRawJSON(w, http.StatusOK, result)
}

func validateControlRequest(request *controlRPCRequest) error {
	request.Method = strings.TrimSpace(request.Method)
	if request.Params == nil {
		request.Params = map[string]any{}
	}
	allowed := map[string]bool{
		"session.list":       true,
		"session.resume":     true,
		"session.status":     true,
		"session.usage":      true,
		"session.interrupt":  true,
		"slash.exec":         true,
		"delegation.status":  true,
		"delegation.pause":   true,
		"subagent.interrupt": true,
		"subagent.steer":     true,
		"process.list":       true,
		"process.kill":       true,
		"spawn_tree.list":    true,
	}
	if !allowed[request.Method] {
		return fmt.Errorf("unsupported Hermes control method: %s", request.Method)
	}
	if request.Method == "session.resume" {
		// The Command Center never needs transcript hydration. Force Hermes'
		// metadata-only mode so reasoning or private conversation context cannot
		// leak through this administrative endpoint.
		request.Params["omit_messages"] = true
	}
	if request.Method == "slash.exec" {
		command, _ := request.Params["command"].(string)
		if err := validateControlCommand(command); err != nil {
			return err
		}
	}
	if request.Method == "process.kill" && !request.Confirm {
		return fmt.Errorf("process.kill requires explicit confirmation")
	}
	return nil
}

func validateControlCommand(command string) error {
	command = strings.TrimSpace(strings.TrimPrefix(command, "/"))
	if command == "" {
		return fmt.Errorf("command is required")
	}
	if len(command) > maxControlTextLength {
		return fmt.Errorf("command is too large")
	}
	name := strings.ToLower(strings.Fields(command)[0])
	switch name {
	case "goal", "subgoal", "heartbeat", "agents", "background":
		return nil
	default:
		return fmt.Errorf("unsupported Command Center command: /%s", name)
	}
}

type controlCommandRequest struct {
	SessionID string `json:"session_id"`
	Command   string `json:"command"`
}

func (a *app) controlCommand(w http.ResponseWriter, r *http.Request) {
	var request controlCommandRequest
	if err := decodeJSONBody(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	request.SessionID = strings.TrimSpace(request.SessionID)
	if request.SessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "session_id is required"})
		return
	}
	if err := validateControlCommand(request.Command); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	runtimeSessionID, err := a.resumeControlSession(r.Context(), request.SessionID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	result, err := a.control.Call(r.Context(), "slash.exec", map[string]any{
		"session_id": runtimeSessionID,
		"command":    request.Command,
	})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}

	response := map[string]any{"result": json.RawMessage(result)}
	var commandResult struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	if json.Unmarshal(result, &commandResult) == nil && commandResult.Type == "send" && strings.TrimSpace(commandResult.Message) != "" {
		kickoff, kickoffErr := a.control.Call(r.Context(), "prompt.submit", map[string]any{
			"session_id": runtimeSessionID,
			"text":       commandResult.Message,
		})
		if kickoffErr != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": kickoffErr.Error()})
			return
		}
		response["kickoff"] = json.RawMessage(kickoff)
	}
	writeJSON(w, http.StatusOK, response)
}

type controlBackgroundRequest struct {
	SessionID string `json:"session_id"`
	Text      string `json:"text"`
}

func (a *app) controlBackground(w http.ResponseWriter, r *http.Request) {
	var request controlBackgroundRequest
	if err := decodeJSONBody(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.Text = strings.TrimSpace(request.Text)
	if request.SessionID == "" || request.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "session_id and text are required"})
		return
	}
	if len(request.Text) > maxControlTextLength {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "background prompt is too large"})
		return
	}
	runtimeSessionID, err := a.resumeControlSession(r.Context(), request.SessionID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	result, err := a.control.Call(r.Context(), "prompt.background", map[string]any{
		"session_id": runtimeSessionID,
		"text":       request.Text,
	})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	var task struct {
		TaskID string `json:"task_id"`
	}
	if json.Unmarshal(result, &task) == nil {
		a.control.TrackBackground(task.TaskID, request.SessionID, request.Text)
	}
	writeRawJSON(w, http.StatusOK, result)
}

func (a *app) resumeControlSession(ctx context.Context, storedSessionID string) (string, error) {
	result, err := a.control.Call(ctx, "session.resume", map[string]any{
		"session_id":    storedSessionID,
		"omit_messages": true,
	})
	if err != nil {
		return "", err
	}
	var resumed struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(result, &resumed); err != nil {
		return "", fmt.Errorf("Hermes returned an invalid session.resume result: %w", err)
	}
	if strings.TrimSpace(resumed.SessionID) == "" {
		return "", fmt.Errorf("Hermes session.resume did not return a runtime session id")
	}
	return resumed.SessionID, nil
}

func (a *app) controlEvents(w http.ResponseWriter, r *http.Request) {
	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	events := a.control.Events(after)
	latest := after
	if len(events) > 0 {
		latest = events[len(events)-1].Sequence
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"events":           events,
		"latest":           latest,
		"background_tasks": a.control.BackgroundTasks(),
	})
}

func decodeJSONBody(r *http.Request, target any) error {
	data, err := io.ReadAll(io.LimitReader(r.Body, 64*1024+1))
	if err != nil {
		return fmt.Errorf("invalid request body: %w", err)
	}
	if len(data) > 64*1024 {
		return fmt.Errorf("request body is too large")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid request body: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("invalid request body: multiple JSON values")
	}
	return nil
}

func writeRawJSON(w http.ResponseWriter, status int, body json.RawMessage) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if len(body) == 0 {
		_, _ = w.Write([]byte("null"))
		return
	}
	_, _ = w.Write(body)
}
