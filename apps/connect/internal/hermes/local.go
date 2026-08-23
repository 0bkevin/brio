package hermes

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"github.com/brio/brio/apps/connect/internal/tunnel"
)

// serveLocal handles the endpoints that read the Hermes home directory
// directly instead of going through the Hermes API server.
func (c *Client) serveLocal(ctx context.Context, frame tunnel.Frame, method string, route Route, _ string, emit func(tunnel.Frame) error) error {
	switch route.Name {
	case "memory":
		switch method {
		case http.MethodGet:
			return emit(responseFrame(frame.ID, http.StatusOK, c.memory()))
		case http.MethodPut:
			body, err := c.updateMemory(frame.Body)
			if err != nil {
				return emit(errorFrame(frame.ID, "BAD_REQUEST", err.Error()))
			}
			return emit(responseFrame(frame.ID, http.StatusOK, body))
		default:
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
	case "control-rpc", "control-command", "control-background", "control-events":
		return c.serveControl(ctx, frame, method, route, emit)
	case "composer-capabilities", "composer-commands", "composer-command-complete",
		"composer-command-dispatch", "composer-context-complete", "composer-prepare",
		"composer-redirect", "composer-attachments", "composer-attachment":
		return c.serveComposer(ctx, frame, method, route, emit)
	default:
		return emit(errorFrame(frame.ID, "NOT_FOUND", "no route for "+method+" "+frame.Path))
	}
}

func methodNotAllowed(id string, method string, path string) tunnel.Frame {
	return errorFrame(id, "METHOD_NOT_ALLOWED", "method "+method+" is not allowed for "+path)
}

func (c *Client) memory() any {
	mem, _ := os.ReadFile(filepath.Join(c.Home, "memories", "MEMORY.md"))
	user, _ := os.ReadFile(filepath.Join(c.Home, "memories", "USER.md"))
	return map[string]any{"memory": string(mem), "user": string(user)}
}

func (c *Client) updateMemory(frameBody any) (any, error) {
	var body struct {
		Memory *string `json:"memory"`
		User   *string `json:"user"`
	}
	encoded, err := json.Marshal(frameBody)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(encoded, &body); err != nil {
		return nil, err
	}
	dir := filepath.Join(c.Home, "memories")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if body.Memory != nil {
		if err := atomicWrite(filepath.Join(dir, "MEMORY.md"), []byte(*body.Memory), 0o600); err != nil {
			return nil, err
		}
	}
	if body.User != nil {
		if err := atomicWrite(filepath.Join(dir, "USER.md"), []byte(*body.User), 0o600); err != nil {
			return nil, err
		}
	}
	return map[string]any{"ok": true}, nil
}

func atomicWrite(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}
