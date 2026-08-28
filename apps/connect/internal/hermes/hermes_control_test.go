package hermes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

type fakeControlCaller struct {
	t           *testing.T
	callNumber  int
	events      []controlEvent
	tasks       []controlBackgroundTask
	denyOwner   bool
	operationMu sync.Mutex
}

func (f *fakeControlCaller) Call(_ context.Context, method string, params map[string]any) (json.RawMessage, error) {
	f.callNumber++
	switch f.callNumber {
	case 1:
		if method != "session.resume" || params["session_id"] != "stored-session" {
			f.t.Fatalf("resume call = %s %+v", method, params)
		}
		return json.RawMessage(`{"session_id":"runtime-session"}`), nil
	case 2:
		if method != "session.status" || params["session_id"] != "runtime-session" {
			f.t.Fatalf("status call = %s %+v", method, params)
		}
		return json.RawMessage(`{"output":"Agent Running: No"}`), nil
	case 3:
		if method != "slash.exec" || params["session_id"] != "runtime-session" || params["command"] != "goal status" {
			f.t.Fatalf("goal status call = %s %+v", method, params)
		}
		return json.RawMessage(`{"type":"exec","output":"No active goal. Set one with /goal <text>."}`), nil
	case 4:
		if method != "slash.exec" || params["session_id"] != "runtime-session" {
			f.t.Fatalf("slash call = %s %+v", method, params)
		}
		return json.RawMessage(`{"type":"send","message":"Ship it"}`), nil
	case 5:
		if method != "prompt.submit" || params["session_id"] != "runtime-session" {
			f.t.Fatalf("prompt call = %s %+v", method, params)
		}
		return json.RawMessage(`{"status":"started"}`), nil
	default:
		f.t.Fatalf("unexpected call %d: %s", f.callNumber, method)
		return nil, nil
	}
}

func (f *fakeControlCaller) BeginControlOperation() func() {
	f.operationMu.Lock()
	return f.operationMu.Unlock
}

func (f *fakeControlCaller) Events(after uint64) []controlEvent {
	result := []controlEvent{}
	for _, event := range f.events {
		if event.Sequence > after {
			result = append(result, event)
		}
	}
	return result
}
func (f *fakeControlCaller) OwnsSubagent(string, string) bool           { return !f.denyOwner }
func (*fakeControlCaller) TrackBackground(string, string, string)       {}
func (f *fakeControlCaller) BackgroundTasks() []controlBackgroundTask   { return f.tasks }
func (*fakeControlCaller) SyncHeartbeat(string, string, string, string) {}
func (*fakeControlCaller) Heartbeat(string) *controlHeartbeatState      { return nil }
func (*fakeControlCaller) Close()                                       {}

func TestControlWebSocketURL(t *testing.T) {
	got, err := controlWebSocketURL("https://hermes.example/base/", "secret value")
	if err != nil {
		t.Fatal(err)
	}
	want := "wss://hermes.example/base/api/ws?token=secret+value"
	if got != want {
		t.Fatalf("controlWebSocketURL = %q, want %q", got, want)
	}
}

func TestControlWebSocketURLRejectsCleartextRemoteToken(t *testing.T) {
	if _, err := controlWebSocketURL("http://hermes.example", "secret"); err == nil {
		t.Fatal("cleartext remote control URL was accepted")
	}
	if _, err := controlWebSocketURL("http://127.0.0.1:9119", "secret"); err != nil {
		t.Fatalf("loopback control URL was rejected: %v", err)
	}
}

func TestControlClientRequiresToken(t *testing.T) {
	client := newControlClient(Config{HermesControlURL: "http://127.0.0.1:9119"}, http.DefaultClient)
	defer client.Close()
	if _, err := client.Call(context.Background(), "session.list", map[string]any{}); err == nil {
		t.Fatal("control call without a token was accepted")
	}
}

func TestControlClientCallsRPCAndFiltersPrivateEvents(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ws" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("token") != "control-token" {
			t.Fatalf("token = %q", r.URL.Query().Get("token"))
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		ctx := context.Background()
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"s1","payload":{"text":"private"}}}`))
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","method":"event","params":{"type":"subagent.thinking","session_id":"s1","payload":{"text":"hidden reasoning"}}}`))
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","method":"event","params":{"type":"subagent.start","session_id":"s1","payload":{"subagent_id":"a1"}}}`))
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var request struct {
			ID     string         `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal(payload, &request); err != nil {
			t.Fatal(err)
		}
		if request.Method != "delegation.status" {
			t.Fatalf("method = %q", request.Method)
		}
		response, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result":  map[string]any{"active": []any{}},
		})
		_ = conn.Write(ctx, websocket.MessageText, response)
	}))
	defer server.Close()

	client := newControlClient(Config{
		HermesControlURL:   server.URL,
		HermesControlToken: "control-token",
	}, server.Client())
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := client.Call(ctx, "delegation.status", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if string(result) != `{"active":[]}` {
		t.Fatalf("result = %s", result)
	}
	events := client.Events(0)
	if len(events) != 1 || events[0].Type != "subagent.start" {
		t.Fatalf("filtered events = %+v", events)
	}
}

func TestControlClientReconnectsAfterTransportLoss(t *testing.T) {
	var connections atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		current := connections.Add(1)
		if current == 1 {
			_, payload, readErr := conn.Read(context.Background())
			if readErr != nil {
				return
			}
			var request struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(payload, &request) != nil {
				return
			}
			response, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result":  map[string]any{"active": []any{}},
			})
			_ = conn.Write(context.Background(), websocket.MessageText, response)
			return
		}
		_, _, _ = conn.Read(context.Background())
	}))
	defer server.Close()

	client := newControlClient(Config{
		HermesControlURL:   server.URL,
		HermesControlToken: "control-token",
	}, server.Client())
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := client.Call(ctx, "delegation.status", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for connections.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if connections.Load() < 2 {
		t.Fatalf("connections = %d, want automatic reconnect", connections.Load())
	}
}

func TestValidateControlRequest(t *testing.T) {
	resume := controlRPCRequest{Method: "session.resume", Params: map[string]any{"session_id": "s1", "omit_messages": false}}
	if err := validateControlRequest(&resume); err != nil {
		t.Fatal(err)
	}
	if resume.Params["omit_messages"] != true {
		t.Fatalf("session.resume did not force omit_messages: %+v", resume.Params)
	}

	if err := validateControlRequest(&controlRPCRequest{
		Method: "slash.exec",
		Params: map[string]any{"session_id": "s1", "command": "shell rm -rf /"},
	}); err == nil {
		t.Fatal("unsafe slash command was accepted")
	}
	if err := validateControlRequest(&controlRPCRequest{
		Method: "slash.exec",
		Params: map[string]any{"session_id": "s1", "command": "goal clear"},
	}); err == nil {
		t.Fatal("mutating slash command bypassed the command endpoint")
	}
	if err := validateControlRequest(&controlRPCRequest{
		Method: "process.kill",
		Params: map[string]any{"session_id": "s1", "process_id": "p1"},
	}); err == nil {
		t.Fatal("unconfirmed process.kill was accepted")
	}
	if err := validateControlRequest(&controlRPCRequest{
		Method:  "process.kill",
		Params:  map[string]any{"session_id": "s1", "process_id": "p1"},
		Confirm: true,
	}); err != nil {
		t.Fatalf("confirmed process.kill was rejected: %v", err)
	}
	if err := validateControlRequest(&controlRPCRequest{
		Method: "subagent.interrupt",
		Params: map[string]any{"session_id": "s1", "subagent_id": "a1"},
	}); err == nil {
		t.Fatal("unconfirmed subagent.interrupt was accepted")
	}
	if err := validateControlRequest(&controlRPCRequest{
		Method: "session.list",
		Params: map[string]any{"limit": float64(201)},
	}); err == nil {
		t.Fatal("unbounded session.list was accepted")
	}
	if err := validateControlRequest(&controlRPCRequest{
		Method: "delegation.status",
		Params: map[string]any{"unexpected": true},
	}); err == nil {
		t.Fatal("unexpected RPC parameter was accepted")
	}
	if err := validateControlRequest(&controlRPCRequest{
		Method:           "delegation.status",
		Params:           map[string]any{},
		RuntimeSessionID: "runtime-a",
	}); err != nil {
		t.Fatalf("scoped delegation.status was rejected: %v", err)
	}
	if err := validateControlCommand("goal clear", false); err == nil {
		t.Fatal("unconfirmed goal clear was accepted")
	}
	if err := validateControlCommand("goal clear", true); err != nil {
		t.Fatalf("confirmed goal clear was rejected: %v", err)
	}
	if err := validateControlCommand("goal gate add npm test", true); err == nil {
		t.Fatal("unsupported goal gate was accepted as replacement goal text")
	}
	if err := validateControlCommand("heartbeat every 10m Check CI\nthen deploy", false); err == nil {
		t.Fatal("multiline heartbeat configuration was accepted")
	}
	if !isGoalReplacementCommand("goal Ship it") || isGoalReplacementCommand("goal status") {
		t.Fatal("goal replacement classification is incorrect")
	}
	if !goalStatusExists("⊙ Goal (active, 1/20 turns): Ship it") || goalStatusExists("No active goal. Set one with /goal <text>.") {
		t.Fatal("goal existence classification is incorrect")
	}
	if !isHeartbeatReplacementCommand("heartbeat every 10m Check CI") || isHeartbeatReplacementCommand("heartbeat pause") {
		t.Fatal("heartbeat replacement classification is incorrect")
	}
	if !heartbeatStatusExists("♥ Heartbeat (every 10m): Check CI") || heartbeatStatusExists("No heartbeat set.") {
		t.Fatal("heartbeat existence classification is incorrect")
	}
}

func TestBackgroundTasksSurviveMobileReconnectAndCaptureFailure(t *testing.T) {
	client := newControlClient(Config{}, http.DefaultClient)
	client.TrackBackground("bg_1", "stored-session", "Check deployment")
	client.recordEvent(controlEventData{
		Type:      "background.complete",
		SessionID: "runtime-session",
		Payload:   json.RawMessage(`{"task_id":"bg_1","text":"error: deployment failed"}`),
	})
	tasks := client.BackgroundTasks()
	if len(tasks) != 1 {
		t.Fatalf("tasks = %+v", tasks)
	}
	if tasks[0].Status != "failed" || tasks[0].SessionID != "stored-session" {
		t.Fatalf("task = %+v", tasks[0])
	}
}

func TestBackgroundCompletionBeforeTrackingStaysComplete(t *testing.T) {
	client := newControlClient(Config{}, http.DefaultClient)
	client.recordEvent(controlEventData{
		Type:      "background.complete",
		SessionID: "runtime-session",
		Payload:   json.RawMessage(`{"task_id":"bg_fast","text":"done"}`),
	})
	client.TrackBackground("bg_fast", "stored-session", "Fast task")
	tasks := client.BackgroundTasks()
	if len(tasks) != 1 || tasks[0].Status != "completed" || tasks[0].Prompt != "Fast task" || tasks[0].SessionID != "stored-session" {
		t.Fatalf("task = %+v", tasks)
	}
}

func TestConnectionLossDoesNotLeaveBackgroundTaskRunning(t *testing.T) {
	client := newControlClient(Config{}, http.DefaultClient)
	client.TrackBackground("bg_1", "stored-session", "Deploy")
	tasks := client.BackgroundTasks()
	if len(tasks) != 1 || tasks[0].Status != "unknown" {
		t.Fatalf("disconnected task = %+v", tasks)
	}
	client.recordEvent(controlEventData{
		Type:      "background.complete",
		SessionID: "runtime-session",
		Payload:   json.RawMessage(`{"task_id":"bg_1","text":"deployed"}`),
	})
	tasks = client.BackgroundTasks()
	if tasks[0].Status != "completed" || tasks[0].Output != "deployed" {
		t.Fatalf("recovered task = %+v", tasks[0])
	}
}

func TestHeartbeatStatusSyncUsesCompanionRuntimeState(t *testing.T) {
	client := newControlClient(Config{}, http.DefaultClient)
	defer client.Close()
	client.SyncHeartbeat(
		"stored-session",
		"runtime-session",
		"heartbeat status",
		"♥ Heartbeat (every 10m, next in ~42s, fired 2×): Check CI",
	)
	state := client.Heartbeat("stored-session")
	if state == nil || state.Status != "active" || state.Interval != "10m" || state.Prompt != "Check CI" || state.FireCount != 2 || state.NextInSeconds > 42 {
		t.Fatalf("heartbeat = %+v", state)
	}
	client.SyncHeartbeat(
		"stored-session",
		"runtime-session",
		"heartbeat status",
		"♥ Heartbeat (every 10m, next in ~40s, fired 1×): Check CI",
	)
	if state = client.Heartbeat("stored-session"); state == nil || state.FireCount != 2 {
		t.Fatalf("local fire count regressed: %+v", state)
	}
	client.SyncHeartbeat("stored-session", "runtime-session", "heartbeat clear", "No heartbeat set.")
	if state = client.Heartbeat("stored-session"); state != nil {
		t.Fatalf("cleared heartbeat survived: %+v", state)
	}
}

func TestHeartbeatRunnerQueuesDuePromptAndReanchorsHermes(t *testing.T) {
	promptSubmitted := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		for {
			_, payload, readErr := conn.Read(context.Background())
			if readErr != nil {
				return
			}
			var request struct {
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.Unmarshal(payload, &request) != nil {
				return
			}
			var result any
			switch request.Method {
			case "session.resume":
				if request.Params["eager_build"] != true || request.Params["omit_messages"] != nil {
					t.Fatalf("source heartbeat resume params = %+v", request.Params)
				}
				result = map[string]any{
					"session_id": "runtime-session",
					"messages": []map[string]any{
						{"role": "user", "text": "Work in this repository"},
						{"role": "assistant", "text": "Understood"},
					},
					"info": map[string]any{
						"cwd": "/tmp/source-workspace", "model": "test-model", "provider": "test-provider",
						"reasoning_effort": "high", "fast": false,
					},
				}
			case "session.create":
				title, _ := request.Params["title"].(string)
				if request.Params["source"] != "heartbeat" || !strings.HasPrefix(title, "Heartbeat response ") {
					t.Fatalf("heartbeat session params = %+v", request.Params)
				}
				messages, _ := request.Params["messages"].([]any)
				if len(messages) != 2 || request.Params["cwd"] != "/tmp/source-workspace" ||
					request.Params["model"] != "test-model" || request.Params["provider"] != "test-provider" ||
					request.Params["reasoning_effort"] != "high" || request.Params["fast"] != false {
					t.Fatalf("heartbeat did not inherit source context: %+v", request.Params)
				}
				result = map[string]any{"session_id": "heartbeat-runtime", "stored_session_id": "heartbeat-stored"}
			case "session.status":
				result = map[string]any{"output": "Agent Running: No"}
			case "prompt.submit":
				promptSubmitted <- request.Params
				result = map[string]any{"status": "streaming"}
			case "slash.exec":
				switch request.Params["command"] {
				case "heartbeat pause":
					result = map[string]any{"output": "⏸ Heartbeat paused: Check CI"}
				case "heartbeat resume":
					result = map[string]any{"output": "▶ Heartbeat resumed (every 10m): Check CI"}
				case "heartbeat status":
					result = map[string]any{"output": "♥ Heartbeat (every 10m, next in ~600s): Check CI"}
				default:
					t.Fatalf("unexpected slash command: %+v", request.Params)
				}
			default:
				t.Fatalf("unexpected method: %s", request.Method)
			}
			response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
			if conn.Write(context.Background(), websocket.MessageText, response) != nil {
				return
			}
		}
	}))
	defer server.Close()

	client := newControlClient(Config{
		HermesControlURL:   server.URL,
		HermesControlToken: "control-token",
	}, server.Client())
	defer client.Close()
	client.SyncHeartbeat(
		"stored-session",
		"runtime-session",
		"heartbeat status",
		"♥ Heartbeat (every 10m, next in ~0s): Check CI",
	)
	select {
	case params := <-promptSubmitted:
		if params["session_id"] != "heartbeat-runtime" || params["queued"] != true || !strings.Contains(params["text"].(string), "[Heartbeat — recurring instruction, fires every 10m]") {
			t.Fatalf("prompt params = %+v", params)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("due heartbeat was not submitted")
	}
	deadline := time.Now().Add(time.Second)
	for {
		state := client.Heartbeat("stored-session")
		if state != nil && state.FireCount == 1 && state.NextInSeconds > 500 && state.OutputSessionID == "heartbeat-stored" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("heartbeat was not reanchored: %+v", state)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestHeartbeatRunnerDoesNotQueueWhileResponseSessionIsBusy(t *testing.T) {
	promptSubmitted := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		for {
			_, payload, readErr := conn.Read(context.Background())
			if readErr != nil {
				return
			}
			var request struct {
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.Unmarshal(payload, &request) != nil {
				return
			}
			var result any
			switch request.Method {
			case "session.resume":
				if request.Params["session_id"] == "heartbeat-stored" {
					result = map[string]any{"session_id": "heartbeat-runtime", "stored_session_id": "heartbeat-stored"}
				} else {
					result = map[string]any{"session_id": "runtime-session"}
				}
			case "session.status":
				if request.Params["session_id"] == "heartbeat-runtime" {
					result = map[string]any{"output": "Agent Running: Yes"}
				} else {
					result = map[string]any{"output": "Agent Running: No"}
				}
			case "prompt.submit":
				promptSubmitted <- struct{}{}
				result = map[string]any{"status": "streaming"}
			default:
				t.Fatalf("unexpected method while heartbeat output is busy: %s %+v", request.Method, request.Params)
			}
			response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
			if conn.Write(context.Background(), websocket.MessageText, response) != nil {
				return
			}
		}
	}))
	defer server.Close()

	client := newControlClient(Config{
		HermesControlURL:   server.URL,
		HermesControlToken: "control-token",
	}, server.Client())
	defer client.Close()
	client.heartbeats["stored-session"] = controlHeartbeatState{
		Status:          "active",
		Prompt:          "Check CI",
		Interval:        "10m",
		OutputSessionID: "heartbeat-stored",
		InFlight:        true,
	}
	client.fireHeartbeat("stored-session")
	select {
	case <-promptSubmitted:
		t.Fatal("busy heartbeat response session received another prompt")
	default:
	}
	state := client.Heartbeat("stored-session")
	if state == nil || state.InFlight || state.FireCount != 0 || state.NextAt <= float64(time.Now().UnixMilli())/1000 {
		t.Fatalf("heartbeat retry state = %+v", state)
	}
}

func TestPrepareHeartbeatOutputAllowsPrunedSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		_, payload, err := conn.Read(context.Background())
		if err != nil {
			return
		}
		var request struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(payload, &request) != nil {
			return
		}
		response, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0", "id": request.ID,
			"error": map[string]any{"code": 4007, "message": "session not found"},
		})
		_ = conn.Write(context.Background(), websocket.MessageText, response)
	}))
	defer server.Close()

	client := newControlClient(Config{HermesControlURL: server.URL, HermesControlToken: "control-token"}, server.Client())
	defer client.Close()
	busy, err := client.prepareHeartbeatOutput(context.Background(), controlHeartbeatState{OutputSessionID: "pruned-response"})
	if err != nil || busy {
		t.Fatalf("pruned heartbeat output blocked the next run: busy=%v err=%v", busy, err)
	}
}

func TestPrepareHeartbeatOutputClosesIdleRuntime(t *testing.T) {
	closed := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		for {
			_, payload, readErr := conn.Read(context.Background())
			if readErr != nil {
				return
			}
			var request struct {
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if json.Unmarshal(payload, &request) != nil {
				return
			}
			var result any
			switch request.Method {
			case "session.resume":
				result = map[string]any{"session_id": "idle-runtime"}
			case "session.status":
				result = map[string]any{"output": "Agent Running: No"}
			case "session.close":
				closed <- request.Params["session_id"].(string)
				result = map[string]any{"closed": true}
			default:
				t.Fatalf("unexpected method: %s", request.Method)
			}
			response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
			if conn.Write(context.Background(), websocket.MessageText, response) != nil {
				return
			}
		}
	}))
	defer server.Close()

	client := newControlClient(Config{HermesControlURL: server.URL, HermesControlToken: "control-token"}, server.Client())
	defer client.Close()
	busy, err := client.prepareHeartbeatOutput(context.Background(), controlHeartbeatState{OutputSessionID: "stored-response"})
	if err != nil || busy {
		t.Fatalf("idle heartbeat output was not released: busy=%v err=%v", busy, err)
	}
	select {
	case sessionID := <-closed:
		if sessionID != "idle-runtime" {
			t.Fatalf("closed runtime = %q", sessionID)
		}
	default:
		t.Fatal("idle heartbeat runtime was not closed")
	}
}

func TestSanitizeHeartbeatSeedDropsInterruptedToolTail(t *testing.T) {
	seed := sanitizeHeartbeatSeed([]map[string]any{
		{"role": "system", "text": "Use the repository instructions"},
		{"role": "user", "text": "Check the build"},
		{"role": "assistant", "text": "The build is green"},
		{"role": "user", "text": "Now inspect the logs"},
		{"role": "assistant", "text": "", "tool_calls": []any{map[string]any{"name": "terminal"}}},
		{"role": "tool", "text": "unfinished"},
	})
	if len(seed) != 3 || seed[0]["role"] != "system" || seed[1]["role"] != "user" ||
		seed[2]["role"] != "assistant" || seed[2]["content"] != "The build is green" {
		t.Fatalf("sanitized heartbeat seed = %+v", seed)
	}
}

func TestControlOperationsAreSerialized(t *testing.T) {
	client := newControlClient(Config{}, http.DefaultClient)
	defer client.Close()

	finishFirst := client.BeginControlOperation()
	secondEntered := make(chan struct{})
	secondFinished := make(chan struct{})
	go func() {
		finishSecond := client.BeginControlOperation()
		close(secondEntered)
		finishSecond()
		close(secondFinished)
	}()

	select {
	case <-secondEntered:
		t.Fatal("a second control mutation entered before the first completed")
	case <-time.After(50 * time.Millisecond):
	}
	finishFirst()
	select {
	case <-secondFinished:
	case <-time.After(time.Second):
		t.Fatal("the serialized control mutation did not resume")
	}
}

func TestControlEventPayloadDropsPrivateAgentDetails(t *testing.T) {
	client := newControlClient(Config{}, http.DefaultClient)
	client.recordEvent(controlEventData{
		Type:      "subagent.complete",
		SessionID: "runtime-session",
		Payload: json.RawMessage(`{
			"subagent_id":"a1",
			"summary":"finished",
			"reasoning":"hidden chain of thought",
			"output_tail":[{"preview":"private tool output"}],
			"tool_preview":"secret argument"
		}`),
	})
	events := client.Events(0)
	if len(events) != 1 {
		t.Fatalf("events = %+v", events)
	}
	var payload map[string]any
	if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["summary"] != "finished" || payload["subagent_id"] != "a1" {
		t.Fatalf("safe fields missing: %+v", payload)
	}
	for _, key := range []string{"reasoning", "output_tail", "tool_preview"} {
		if _, ok := payload[key]; ok {
			t.Fatalf("private field %q survived: %+v", key, payload)
		}
	}
}

func TestControlEventPayloadHasAnOverallSizeBound(t *testing.T) {
	paths := make([]string, 40)
	for index := range paths {
		paths[index] = strings.Repeat("x", controlEventStringLimit)
	}
	payload, err := json.Marshal(map[string]any{
		"subagent_id":   "a1",
		"files_read":    paths,
		"files_written": paths,
	})
	if err != nil {
		t.Fatal(err)
	}
	client := newControlClient(Config{}, http.DefaultClient)
	client.recordEvent(controlEventData{Type: "subagent.complete", SessionID: "runtime", Payload: payload})
	events := client.Events(0)
	if len(events) != 1 || len(events[0].Payload) > controlEventPayloadLimit {
		t.Fatalf("bounded event = %+v", events)
	}
	var safe map[string]any
	if json.Unmarshal(events[0].Payload, &safe) != nil || safe["subagent_id"] != "a1" {
		t.Fatalf("ownership field was not retained: %s", events[0].Payload)
	}
}

func TestSubagentOwnershipFailsClosed(t *testing.T) {
	client := newControlClient(Config{}, http.DefaultClient)
	client.recordEvent(controlEventData{
		Type:      "subagent.start",
		SessionID: "runtime-a",
		Payload:   json.RawMessage(`{"subagent_id":"a1"}`),
	})
	if !client.OwnsSubagent("runtime-a", "a1") {
		t.Fatal("observed owner was rejected")
	}
	if client.OwnsSubagent("runtime-b", "a1") || client.OwnsSubagent("runtime-a", "unknown") {
		t.Fatal("unobserved subagent ownership was accepted")
	}
	client.recordEvent(controlEventData{
		Type:      "subagent.start",
		SessionID: "runtime-b",
		Payload:   json.RawMessage(`{"subagent_id":"a1"}`),
	})
	if client.OwnsSubagent("runtime-a", "a1") || !client.OwnsSubagent("runtime-b", "a1") {
		t.Fatal("stale ownership was accepted after a newer owner event")
	}
}

func TestDelegationStatusIsFilteredBeforeReturningToMobile(t *testing.T) {
	client := newControlClient(Config{}, http.DefaultClient)
	client.recordEvent(controlEventData{
		Type:      "subagent.start",
		SessionID: "runtime-a",
		Payload:   json.RawMessage(`{"subagent_id":"a1"}`),
	})
	client.recordEvent(controlEventData{
		Type:      "subagent.start",
		SessionID: "runtime-b",
		Payload:   json.RawMessage(`{"subagent_id":"b1"}`),
	})
	filtered, err := filterDelegationStatus(
		json.RawMessage(`{"active":[{"subagent_id":"a1"},{"subagent_id":"b1"}],"paused":false}`),
		"runtime-a",
		client.OwnsSubagent,
	)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Active []struct {
			SubagentID     string `json:"subagent_id"`
			OwnerSessionID string `json:"owner_session_id"`
		} `json:"active"`
	}
	if err := json.Unmarshal(filtered, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Active) != 1 || payload.Active[0].SubagentID != "a1" || payload.Active[0].OwnerSessionID != "runtime-a" {
		t.Fatalf("filtered delegation = %s", filtered)
	}
}

func TestControlRPCRejectsUnobservedSubagentBeforeHermesCall(t *testing.T) {
	fake := &fakeControlCaller{t: t, denyOwner: true}
	a := &app{control: fake}
	body := []byte(`{
		"method":"subagent.interrupt",
		"params":{"session_id":"runtime-a","subagent_id":"a1"},
		"confirm":true
	}`)
	request := httptest.NewRequest(http.MethodPost, "/control/rpc", bytes.NewReader(body))
	response := httptest.NewRecorder()
	a.controlRPC(response, request)
	if response.Code != http.StatusConflict || fake.callNumber != 0 {
		t.Fatalf("status = %d, calls = %d, body = %s", response.Code, fake.callNumber, response.Body.String())
	}
}

func TestControlEventsAreScopedToSelectedSession(t *testing.T) {
	fake := &fakeControlCaller{
		t: t,
		events: []controlEvent{
			{Sequence: 1, Type: "notification.show", SessionID: "runtime-a"},
			{Sequence: 2, Type: "notification.show", SessionID: "runtime-b"},
		},
		tasks: []controlBackgroundTask{
			{TaskID: "a", SessionID: "stored-a"},
			{TaskID: "b", SessionID: "stored-b"},
		},
	}
	a := &app{control: fake}
	request := httptest.NewRequest(http.MethodGet, "/control/events?stored_session_id=stored-a&runtime_session_id=runtime-a", nil)
	response := httptest.NewRecorder()
	a.controlEvents(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Events []controlEvent          `json:"events"`
		Tasks  []controlBackgroundTask `json:"background_tasks"`
		Latest uint64                  `json:"latest"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Events) != 1 || body.Events[0].SessionID != "runtime-a" || len(body.Tasks) != 1 || body.Tasks[0].SessionID != "stored-a" || body.Latest != 2 {
		t.Fatalf("scoped response = %+v", body)
	}
}

func TestControlCommandUsesRuntimeSessionAndStartsGoal(t *testing.T) {
	fake := &fakeControlCaller{t: t}
	a := &app{control: fake}
	body := []byte(`{"session_id":"stored-session","command":"goal Ship it"}`)
	request := httptest.NewRequest(http.MethodPost, "/control/command", bytes.NewReader(body))
	response := httptest.NewRecorder()
	a.controlCommand(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if fake.callNumber != 5 {
		t.Fatalf("calls = %d, want 5", fake.callNumber)
	}
}
