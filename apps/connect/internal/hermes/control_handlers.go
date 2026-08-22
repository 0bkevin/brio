package hermes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type app struct {
	control controlCaller
}

const maxControlTextLength = 16 * 1024
const maxControlIDLength = 512
const maxSessionBackgroundTasks = 3

type controlRPCRequest struct {
	Method           string         `json:"method"`
	Params           map[string]any `json:"params"`
	Confirm          bool           `json:"confirm,omitempty"`
	RuntimeSessionID string         `json:"runtime_session_id,omitempty"`
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
	if serializedControlRPCMethod(request.Method) {
		finishOperation := a.control.BeginControlOperation()
		defer finishOperation()
	}
	if request.Method == "subagent.interrupt" || request.Method == "subagent.steer" {
		sessionID, _ := request.Params["session_id"].(string)
		subagentID, _ := request.Params["subagent_id"].(string)
		if !a.control.OwnsSubagent(sessionID, subagentID) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "subagent ownership was not observed for this runtime session"})
			return
		}
	}
	result, err := a.control.Call(r.Context(), request.Method, request.Params)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	if request.Method == "delegation.status" {
		result, err = filterDelegationStatus(result, request.RuntimeSessionID, a.control.OwnsSubagent)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
	}
	writeRawJSON(w, http.StatusOK, result)
}

func serializedControlRPCMethod(method string) bool {
	switch method {
	case "slash.exec", "delegation.pause", "session.interrupt", "subagent.interrupt", "subagent.steer", "process.kill":
		return true
	default:
		return false
	}
}

func validateControlRequest(request *controlRPCRequest) error {
	request.Method = strings.TrimSpace(request.Method)
	if request.Params == nil {
		request.Params = map[string]any{}
	}
	request.RuntimeSessionID = strings.TrimSpace(request.RuntimeSessionID)
	if len(request.RuntimeSessionID) > maxControlIDLength {
		return fmt.Errorf("runtime_session_id is too large")
	}
	if request.Method != "delegation.status" && request.RuntimeSessionID != "" {
		return fmt.Errorf("runtime_session_id is only supported for delegation.status")
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
	switch request.Method {
	case "session.list":
		if err := validateControlParams(request.Params, "limit"); err != nil {
			return err
		}
		if value, ok := request.Params["limit"]; ok {
			if err := validateControlLimit(value, 1, 200); err != nil {
				return fmt.Errorf("session.list limit: %w", err)
			}
		}
	case "session.resume":
		if err := validateControlParams(request.Params, "session_id", "omit_messages"); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "session_id", maxControlIDLength); err != nil {
			return err
		}
		// The Command Center never needs transcript hydration. Force Hermes'
		// metadata-only mode so reasoning or private conversation context cannot
		// leak through this administrative endpoint.
		request.Params["omit_messages"] = true
	case "session.status", "session.usage", "session.interrupt", "process.list":
		if err := validateControlParams(request.Params, "session_id"); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "session_id", maxControlIDLength); err != nil {
			return err
		}
		if request.Method == "session.interrupt" && !request.Confirm {
			return fmt.Errorf("session.interrupt requires explicit confirmation")
		}
	case "slash.exec":
		if err := validateControlParams(request.Params, "session_id", "command"); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "session_id", maxControlIDLength); err != nil {
			return err
		}
		command, _ := request.Params["command"].(string)
		if err := validateReadOnlyControlCommand(command); err != nil {
			return err
		}
	case "delegation.status":
		if err := validateControlParams(request.Params); err != nil {
			return err
		}
		if request.RuntimeSessionID == "" {
			return fmt.Errorf("delegation.status requires runtime_session_id scope")
		}
	case "delegation.pause":
		if err := validateControlParams(request.Params, "paused"); err != nil {
			return err
		}
		if _, ok := request.Params["paused"].(bool); !ok {
			return fmt.Errorf("paused must be a boolean")
		}
	case "subagent.interrupt":
		if err := validateControlParams(request.Params, "session_id", "subagent_id"); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "session_id", maxControlIDLength); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "subagent_id", maxControlIDLength); err != nil {
			return err
		}
		if !request.Confirm {
			return fmt.Errorf("subagent.interrupt requires explicit confirmation")
		}
	case "subagent.steer":
		if err := validateControlParams(request.Params, "session_id", "subagent_id", "text"); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "session_id", maxControlIDLength); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "subagent_id", maxControlIDLength); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "text", maxControlTextLength); err != nil {
			return err
		}
	case "process.kill":
		if err := validateControlParams(request.Params, "session_id", "process_id"); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "session_id", maxControlIDLength); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "process_id", maxControlIDLength); err != nil {
			return err
		}
		if !request.Confirm {
			return fmt.Errorf("process.kill requires explicit confirmation")
		}
	case "spawn_tree.list":
		if err := validateControlParams(request.Params, "session_id", "limit", "cross_session"); err != nil {
			return err
		}
		if _, err := requireControlString(request.Params, "session_id", maxControlIDLength); err != nil {
			return err
		}
		if value, ok := request.Params["limit"]; ok {
			if err := validateControlLimit(value, 1, 200); err != nil {
				return fmt.Errorf("spawn_tree.list limit: %w", err)
			}
		}
		if crossSession, ok := request.Params["cross_session"]; ok && crossSession != false {
			return fmt.Errorf("cross-session spawn tree access is not supported")
		}
	}
	return nil
}

func filterDelegationStatus(result json.RawMessage, runtimeSessionID string, owns func(string, string) bool) (json.RawMessage, error) {
	var payload map[string]any
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil, fmt.Errorf("Hermes returned an invalid delegation.status result: %w", err)
	}
	active, ok := payload["active"].([]any)
	if !ok {
		payload["active"] = []any{}
	} else {
		filtered := make([]any, 0, len(active))
		for _, value := range active {
			agent, ok := value.(map[string]any)
			if !ok {
				continue
			}
			subagentID, _ := agent["subagent_id"].(string)
			if !owns(runtimeSessionID, subagentID) {
				continue
			}
			agent["owner_session_id"] = runtimeSessionID
			filtered = append(filtered, agent)
		}
		payload["active"] = filtered
	}
	filtered, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("could not encode scoped delegation.status: %w", err)
	}
	return filtered, nil
}

func validateControlParams(params map[string]any, allowed ...string) error {
	allowedSet := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = true
	}
	for key := range params {
		if !allowedSet[key] {
			return fmt.Errorf("unsupported parameter: %s", key)
		}
	}
	return nil
}

func requireControlString(params map[string]any, key string, maxLength int) (string, error) {
	value, ok := params[key].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s is required and must be a string", key)
	}
	value = strings.TrimSpace(value)
	if len(value) > maxLength {
		return "", fmt.Errorf("%s is too large", key)
	}
	params[key] = value
	return value, nil
}

func validateControlLimit(value any, minimum int, maximum int) error {
	number, ok := value.(float64)
	if !ok || number != float64(int(number)) || number < float64(minimum) || number > float64(maximum) {
		return fmt.Errorf("must be an integer between %d and %d", minimum, maximum)
	}
	return nil
}

func normalizedControlCommand(command string) (string, string, error) {
	command = strings.TrimSpace(strings.TrimPrefix(command, "/"))
	if command == "" {
		return "", "", fmt.Errorf("command is required")
	}
	if len(command) > maxControlTextLength {
		return "", "", fmt.Errorf("command is too large")
	}
	fields := strings.Fields(command)
	name := strings.ToLower(fields[0])
	argument := strings.TrimSpace(command[len(fields[0]):])
	return name, argument, nil
}

func validateReadOnlyControlCommand(command string) error {
	name, argument, err := normalizedControlCommand(command)
	if err != nil {
		return err
	}
	switch name {
	case "goal", "heartbeat":
		if argument == "" || strings.EqualFold(argument, "status") {
			return nil
		}
	case "subgoal":
		if argument == "" {
			return nil
		}
	}
	return fmt.Errorf("mutating slash commands must use the Command Center command endpoint")
}

func validateControlCommand(command string, confirm bool) error {
	name, argument, err := normalizedControlCommand(command)
	if err != nil {
		return err
	}
	switch name {
	case "goal":
		lower := strings.ToLower(argument)
		if lower == "clear" || lower == "stop" || lower == "done" {
			if !confirm {
				return fmt.Errorf("clearing a goal requires explicit confirmation")
			}
			return nil
		}
		// hermes serve currently implements only the basic goal control surface.
		// Reject documented commands that its direct handler would otherwise
		// misinterpret as a replacement objective.
		if lower == "show" || lower == "unwait" || lower == "draft" || strings.HasPrefix(lower, "draft ") ||
			lower == "gate" || strings.HasPrefix(lower, "gate ") || lower == "wait" || strings.HasPrefix(lower, "wait ") {
			return fmt.Errorf("/%s is not supported by the Hermes serve control contract", strings.TrimSpace(command))
		}
		return nil
	case "subgoal":
		argumentFields := strings.Fields(strings.ToLower(argument))
		if len(argumentFields) > 0 && argumentFields[0] == "clear" && !confirm {
			return fmt.Errorf("clearing subgoals requires explicit confirmation")
		}
		if strings.ContainsAny(argument, "\r\n") {
			return fmt.Errorf("subgoal text must be a single line")
		}
		return nil
	case "heartbeat":
		lower := strings.ToLower(argument)
		if (lower == "clear" || lower == "stop" || lower == "off") && !confirm {
			return fmt.Errorf("clearing a heartbeat requires explicit confirmation")
		}
		if strings.ContainsAny(argument, "\r\n") {
			return fmt.Errorf("heartbeat configuration must be a single line")
		}
		return nil
	default:
		return fmt.Errorf("unsupported Command Center command: /%s", name)
	}
}

type controlCommandRequest struct {
	SessionID string `json:"session_id"`
	Command   string `json:"command"`
	Confirm   bool   `json:"confirm,omitempty"`
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
	if len(request.SessionID) > maxControlIDLength {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "session_id is too large"})
		return
	}
	if err := validateControlCommand(request.Command, request.Confirm); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	finishOperation := a.control.BeginControlOperation()
	defer finishOperation()
	runtimeSessionID, err := a.resumeControlSession(r.Context(), request.SessionID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	goalReplacement := isGoalReplacementCommand(request.Command)
	if goalReplacement {
		sessionStatus, statusErr := a.control.Call(r.Context(), "session.status", map[string]any{
			"session_id": runtimeSessionID,
		})
		if statusErr != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": statusErr.Error()})
			return
		}
		statusOutput := controlResultOutput(sessionStatus)
		if statusOutput == "" {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "Hermes returned an invalid session.status result"})
			return
		}
		if strings.Contains(strings.ToLower(statusOutput), "agent running: yes") {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "cannot replace a goal while the session is running"})
			return
		}
		goalStatus, goalStatusErr := a.control.Call(r.Context(), "slash.exec", map[string]any{
			"session_id": runtimeSessionID,
			"command":    "goal status",
		})
		if goalStatusErr != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": goalStatusErr.Error()})
			return
		}
		goalOutput := controlResultOutput(goalStatus)
		if goalOutput == "" {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "Hermes returned an invalid goal status result"})
			return
		}
		if goalStatusExists(goalOutput) && !request.Confirm {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "replacing an existing goal requires explicit confirmation"})
			return
		}
	}
	heartbeatReplacement := isHeartbeatReplacementCommand(request.Command)
	if heartbeatReplacement {
		heartbeatStatus, heartbeatStatusErr := a.control.Call(r.Context(), "slash.exec", map[string]any{
			"session_id": runtimeSessionID,
			"command":    "heartbeat status",
		})
		if heartbeatStatusErr != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": heartbeatStatusErr.Error()})
			return
		}
		heartbeatOutput := controlResultOutput(heartbeatStatus)
		if heartbeatOutput == "" {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "Hermes returned an invalid heartbeat status result"})
			return
		}
		if heartbeatStatusExists(heartbeatOutput) && !request.Confirm {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "replacing an existing heartbeat requires explicit confirmation"})
			return
		}
	}
	result, err := a.control.Call(r.Context(), "slash.exec", map[string]any{
		"session_id": runtimeSessionID,
		"command":    request.Command,
	})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}

	response := map[string]any{
		"result":             json.RawMessage(result),
		"runtime_session_id": runtimeSessionID,
	}
	if isHeartbeatControlCommand(request.Command) {
		heartbeatStatus := result
		if !isHeartbeatStatusCommand(request.Command) {
			heartbeatStatus, err = a.control.Call(r.Context(), "slash.exec", map[string]any{
				"session_id": runtimeSessionID,
				"command":    "heartbeat status",
			})
			if err != nil {
				writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
				return
			}
		}
		heartbeatOutput := controlResultOutput(heartbeatStatus)
		if heartbeatOutput == "" {
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": "Hermes returned an invalid heartbeat status result"})
			return
		}
		a.control.SyncHeartbeat(request.SessionID, runtimeSessionID, request.Command, heartbeatOutput)
		response["heartbeat"] = a.control.Heartbeat(request.SessionID)
	}
	var commandResult struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	commandResultErr := json.Unmarshal(result, &commandResult)
	if goalReplacement && (commandResultErr != nil || commandResult.Type != "send" || strings.TrimSpace(commandResult.Message) == "") {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "Hermes did not return a goal kickoff prompt"})
		return
	}
	if goalReplacement {
		// Once Hermes has persisted the goal, starting its first turn is part of
		// the accepted mutation. Do not abandon that kickoff merely because the
		// phone backgrounds or its HTTP request is cancelled at this boundary.
		kickoffContext, cancelKickoff := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelKickoff()
		kickoff, kickoffErr := a.control.Call(kickoffContext, "prompt.submit", map[string]any{
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

func isGoalReplacementCommand(command string) bool {
	name, argument, err := normalizedControlCommand(command)
	if err != nil || name != "goal" || argument == "" {
		return false
	}
	switch strings.ToLower(argument) {
	case "status", "pause", "resume", "clear", "stop", "done":
		return false
	default:
		return true
	}
}

func isHeartbeatReplacementCommand(command string) bool {
	name, argument, err := normalizedControlCommand(command)
	if err != nil || name != "heartbeat" || argument == "" {
		return false
	}
	switch strings.ToLower(argument) {
	case "status", "pause", "resume", "clear", "stop", "off":
		return false
	default:
		return true
	}
}

func isHeartbeatControlCommand(command string) bool {
	name, _, err := normalizedControlCommand(command)
	return err == nil && name == "heartbeat"
}

func isHeartbeatStatusCommand(command string) bool {
	name, argument, err := normalizedControlCommand(command)
	return err == nil && name == "heartbeat" && (argument == "" || strings.EqualFold(argument, "status"))
}

func controlResultOutput(result json.RawMessage) string {
	var payload struct {
		Output string `json:"output"`
	}
	if json.Unmarshal(result, &payload) != nil {
		return ""
	}
	return strings.TrimSpace(payload.Output)
}

func goalStatusExists(output string) bool {
	output = strings.TrimSpace(output)
	return output != "" && !strings.HasPrefix(strings.ToLower(output), "no active goal") && !strings.HasPrefix(strings.ToLower(output), "no goal set")
}

func heartbeatStatusExists(output string) bool {
	output = strings.TrimSpace(output)
	return output != "" && !strings.HasPrefix(strings.ToLower(output), "no heartbeat")
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
	if len(request.SessionID) > maxControlIDLength {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "session_id is too large"})
		return
	}
	if len(request.Text) > maxControlTextLength {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "background prompt is too large"})
		return
	}
	finishOperation := a.control.BeginControlOperation()
	defer finishOperation()
	activeTasks := 0
	now := float64(time.Now().UnixMilli()) / 1000
	for _, task := range a.control.BackgroundTasks() {
		unknownRecently := task.Status == "unknown" && now-task.FinishedAt < 10*60
		if task.SessionID == request.SessionID && (task.Status == "running" || unknownRecently) {
			activeTasks++
		}
	}
	if activeTasks >= maxSessionBackgroundTasks {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "this session already has the maximum number of background tasks"})
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
	if err := json.Unmarshal(result, &task); err != nil || strings.TrimSpace(task.TaskID) == "" || len(task.TaskID) > maxControlIDLength {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "Hermes returned an invalid background task id"})
		return
	}
	task.TaskID = strings.TrimSpace(task.TaskID)
	a.control.TrackBackground(task.TaskID, request.SessionID, request.Text)
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
	storedSessionID := strings.TrimSpace(r.URL.Query().Get("stored_session_id"))
	runtimeSessionID := strings.TrimSpace(r.URL.Query().Get("runtime_session_id"))
	if len(storedSessionID) > maxControlIDLength || len(runtimeSessionID) > maxControlIDLength {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "session id is too large"})
		return
	}
	allEvents := a.control.Events(after)
	latest := after
	if len(allEvents) > 0 {
		latest = allEvents[len(allEvents)-1].Sequence
	}
	events := allEvents
	if runtimeSessionID != "" {
		events = make([]controlEvent, 0, len(allEvents))
		for _, event := range allEvents {
			if event.SessionID == runtimeSessionID {
				events = append(events, event)
			}
		}
	}
	tasks := a.control.BackgroundTasks()
	if storedSessionID != "" {
		filteredTasks := make([]controlBackgroundTask, 0, len(tasks))
		for _, task := range tasks {
			if task.SessionID == storedSessionID {
				filteredTasks = append(filteredTasks, task)
			}
		}
		tasks = filteredTasks
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"events":           events,
		"latest":           latest,
		"background_tasks": tasks,
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

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
