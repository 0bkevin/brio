package hermes

import (
	"bytes"
	"context"
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/brio/brio/apps/connect/internal/tunnel"
)

func seedHermesHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(home, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	statements := []string{
		`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, user_id TEXT, model TEXT, started_at REAL, ended_at REAL, message_count INTEGER, title TEXT)`,
		`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, timestamp REAL)`,
		`INSERT INTO sessions (id, source, user_id, model, started_at, ended_at, message_count, title) VALUES ('s1', 'cli', 'u1', 'gpt', 1720000000.5, 1720000100.25, 2, 'First')`,
		`INSERT INTO sessions (id, source, user_id, model, started_at, ended_at, message_count, title) VALUES ('s2', 'gateway', NULL, NULL, 1720000200, NULL, 0, NULL)`,
		`INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES ('s1', 'user', 'hello', NULL, 1720000001)`,
		`INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES ('s1', 'assistant', 'hi', 'shell', 1720000002)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("seed %q: %v", statement, err)
		}
	}
	if err := os.MkdirAll(filepath.Join(home, "memories"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "memories", "MEMORY.md"), []byte("memory body"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "memories", "USER.md"), []byte("user body"), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func decodeSessions(t *testing.T, body any) []map[string]any {
	t.Helper()
	outer, ok := body.(map[string]any)
	if !ok {
		t.Fatalf("body = %#v, want an object", body)
	}
	items, ok := outer["sessions"].([]any)
	if !ok {
		t.Fatalf("sessions = %#v, want a list", outer["sessions"])
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("session entry = %#v, want an object", item)
		}
		out = append(out, entry)
	}
	return out
}

func TestServeSessionsReadsStateDB(t *testing.T) {
	home := seedHermesHome(t)
	client := &Client{BaseURL: "http://127.0.0.1:1", Home: home}

	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "s1", Method: http.MethodGet, Path: "/v1/sessions?limit=1",
	})
	if len(frames) != 1 || frames[0].Type != "response" || frames[0].Status != http.StatusOK {
		t.Fatalf("frames = %+v, want one 200 response", frames)
	}
	sessions := decodeSessions(t, frames[0].Body)
	if len(sessions) != 1 {
		t.Fatalf("got %d sessions, want 1 (limit)", len(sessions))
	}
	first := sessions[0]
	if first["id"] != "s2" {
		t.Fatalf("id = %v, want s2 (newest first)", first["id"])
	}
	if first["started_at"] != float64(1720000200) {
		t.Fatalf("started_at = %v, want epoch seconds", first["started_at"])
	}
	if first["ended_at"] != nil {
		t.Fatalf("ended_at = %v, want null", first["ended_at"])
	}

	legacy := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "s2", Method: http.MethodGet, Path: "/sessions",
	})
	sessions = decodeSessions(t, legacy[0].Body)
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions from legacy path, want 2", len(sessions))
	}
	if sessions[0]["id"] != "s2" || sessions[1]["id"] != "s1" {
		t.Fatalf("session order = %v, want newest first", sessions)
	}
	if sessions[1]["title"] != "First" || sessions[1]["message_count"] != float64(2) {
		t.Fatalf("session fields = %#v", sessions[1])
	}
}

func TestServeSessionMessages(t *testing.T) {
	home := seedHermesHome(t)
	client := &Client{BaseURL: "http://127.0.0.1:1", Home: home}

	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "m1", Method: http.MethodGet, Path: "/v1/sessions/s1/messages",
	})
	if len(frames) != 1 || frames[0].Type != "response" || frames[0].Status != http.StatusOK {
		t.Fatalf("frames = %+v, want one 200 response", frames)
	}
	outer := frames[0].Body.(map[string]any)
	messages := outer["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("got %d messages, want 2", len(messages))
	}
	first := messages[0].(map[string]any)
	if first["role"] != "user" || first["content"] != "hello" || first["tool_name"] != "" {
		t.Fatalf("first message = %#v", first)
	}
	if first["timestamp"] != float64(1720000001) {
		t.Fatalf("timestamp = %v, want epoch seconds", first["timestamp"])
	}

	legacy := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "m2", Method: http.MethodGet, Path: "/sessions/s1/messages",
	})
	outer = legacy[0].Body.(map[string]any)
	if len(outer["messages"].([]any)) != 2 {
		t.Fatal("legacy message path returned the wrong payload")
	}
}

func TestServeSessionsWithoutStateDB(t *testing.T) {
	client := &Client{BaseURL: "http://127.0.0.1:1", Home: filepath.Join(t.TempDir(), "missing")}
	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "s", Method: http.MethodGet, Path: "/v1/sessions",
	})
	if len(frames) != 1 || frames[0].Type != "response" || frames[0].Status != http.StatusOK {
		t.Fatalf("frames = %+v, want a 200 response even without a state db", frames)
	}
	sessions := decodeSessions(t, frames[0].Body)
	if len(sessions) != 0 {
		t.Fatalf("sessions = %v, want empty", sessions)
	}
}

func TestServeSessionsRejectsNonGET(t *testing.T) {
	client := &Client{BaseURL: "http://127.0.0.1:1", Home: t.TempDir()}
	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "x1", Method: http.MethodDelete, Path: "/v1/sessions",
	})
	if len(frames) != 1 || frames[0].Type != "error" || frames[0].Code != "METHOD_NOT_ALLOWED" {
		t.Fatalf("frames = %+v, want METHOD_NOT_ALLOWED", frames)
	}
}

func TestServeMemoryGetAndUpdate(t *testing.T) {
	home := seedHermesHome(t)
	client := &Client{BaseURL: "http://127.0.0.1:1", Home: home}

	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "g1", Method: http.MethodGet, Path: "/v1/memory",
	})
	if len(frames) != 1 || frames[0].Type != "response" || frames[0].Status != http.StatusOK {
		t.Fatalf("frames = %+v, want one 200 response", frames)
	}
	body := frames[0].Body.(map[string]any)
	if body["memory"] != "memory body" || body["user"] != "user body" {
		t.Fatalf("memory body = %#v", body)
	}

	frames = collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "p1", Method: http.MethodPut, Path: "/v1/memory",
		Body: map[string]any{"memory": "updated memory"},
	})
	if len(frames) != 1 || frames[0].Type != "response" || frames[0].Status != http.StatusOK {
		t.Fatalf("frames = %+v, want one 200 response", frames)
	}
	updated, err := os.ReadFile(filepath.Join(home, "memories", "MEMORY.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(updated) != "updated memory" {
		t.Fatalf("MEMORY.md = %q, want updated memory", updated)
	}
	untouched, err := os.ReadFile(filepath.Join(home, "memories", "USER.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(untouched) != "user body" {
		t.Fatalf("USER.md = %q, want the untouched original", untouched)
	}
	info, err := os.Stat(filepath.Join(home, "memories", "MEMORY.md"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("MEMORY.md permissions = %o, want 600", info.Mode().Perm())
	}

	legacy := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "p2", Method: http.MethodPut, Path: "/memory",
		Body: map[string]any{"user": "updated user"},
	})
	if len(legacy) != 1 || legacy[0].Type != "response" {
		t.Fatalf("legacy frames = %+v", legacy)
	}
	userBytes, _ := os.ReadFile(filepath.Join(home, "memories", "USER.md"))
	if string(userBytes) != "updated user" {
		t.Fatalf("USER.md = %q, want updated user", userBytes)
	}
}

func TestServeMemoryRejectsInvalidBody(t *testing.T) {
	client := &Client{BaseURL: "http://127.0.0.1:1", Home: t.TempDir()}
	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "bad", Method: http.MethodPut, Path: "/v1/memory",
		Body: "not an object",
	})
	if len(frames) != 1 || frames[0].Type != "error" || frames[0].Code != "BAD_REQUEST" {
		t.Fatalf("frames = %+v, want BAD_REQUEST", frames)
	}
}

func TestAtomicWriteSupportsConcurrentWriters(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "MEMORY.md")
	contents := [][]byte{
		bytes.Repeat([]byte("a"), 64*1024),
		bytes.Repeat([]byte("b"), 64*1024),
		bytes.Repeat([]byte("c"), 64*1024),
	}

	var wg sync.WaitGroup
	errs := make(chan error, 30)
	for index := 0; index < 30; index++ {
		wg.Add(1)
		go func(data []byte) {
			defer wg.Done()
			errs <- atomicWrite(path, data, 0o600)
		}(contents[index%len(contents)])
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("atomicWrite returned error: %v", err)
		}
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	matched := false
	for _, want := range contents {
		matched = matched || bytes.Equal(got, want)
	}
	if !matched {
		t.Fatal("result was not one complete writer payload")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "MEMORY.md" {
		t.Fatalf("temporary files were left behind: %+v", entries)
	}
}
