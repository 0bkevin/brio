package hermes

import (
	"bytes"
	"context"
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
