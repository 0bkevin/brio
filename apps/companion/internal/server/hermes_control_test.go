package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

type fakeControlCaller struct {
	t          *testing.T
	callNumber int
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
		if method != "slash.exec" || params["session_id"] != "runtime-session" {
			f.t.Fatalf("slash call = %s %+v", method, params)
		}
		return json.RawMessage(`{"type":"send","message":"Ship it"}`), nil
	case 3:
		if method != "prompt.submit" || params["session_id"] != "runtime-session" {
			f.t.Fatalf("prompt call = %s %+v", method, params)
		}
		return json.RawMessage(`{"status":"started"}`), nil
	default:
		f.t.Fatalf("unexpected call %d: %s", f.callNumber, method)
		return nil, nil
	}
}

func (*fakeControlCaller) Events(uint64) []controlEvent             { return nil }
func (*fakeControlCaller) TrackBackground(string, string, string)   {}
func (*fakeControlCaller) BackgroundTasks() []controlBackgroundTask { return nil }
func (*fakeControlCaller) Close()                                   {}

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
		Params: map[string]any{"command": "shell rm -rf /"},
	}); err == nil {
		t.Fatal("unsafe slash command was accepted")
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
	if fake.callNumber != 3 {
		t.Fatalf("calls = %d, want 3", fake.callNumber)
	}
}
