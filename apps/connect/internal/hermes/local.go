package hermes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"

	"github.com/brio/brio/apps/connect/internal/tunnel"
)

// serveLocal handles the endpoints that read the Hermes home directory
// directly instead of going through the Hermes API server. Profile-prefixed
// requests operate on that profile's own home.
func (c *Client) serveLocal(ctx context.Context, frame tunnel.Frame, method string, route Route, _ string, emit func(tunnel.Frame) error) error {
	switch route.Name {
	case "memory":
		home := c.homeFor(route.Profile)
		switch method {
		case http.MethodGet:
			return emit(responseFrame(frame.ID, http.StatusOK, c.memory(home)))
		case http.MethodPut:
			body, err := c.updateMemory(frame.Body, home)
			if err != nil {
				return emit(errorFrame(frame.ID, "BAD_REQUEST", err.Error()))
			}
			return emit(responseFrame(frame.ID, http.StatusOK, body))
		default:
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
	case "profiles":
		// Profile management is a local connector surface. If a caller uses
		// the general /p/<profile>/ prefix, remove that transport-only prefix
		// before handing the request to the /api/profiles router; the manager
		// itself owns the complete profile tree.
		localPath, query, _ := strings.Cut(frame.Path, "?")
		if route.Profile != "" {
			if _, remainder, ok := splitProfilePrefix(localPath); ok {
				localPath = remainder
			}
		}
		if query != "" {
			localPath += "?" + query
		}
		req := httptest.NewRequest(method, localPath, bodyReader(frame.Body)).WithContext(ctx)
		recorder := httptest.NewRecorder()
		c.serveProfiles(recorder, req)
		return emit(recorderFrame(frame.ID, recorder))
	case "control-rpc", "control-command", "control-background", "control-events":
		return c.serveControl(ctx, frame, method, route, emit)
	default:
		return emit(errorFrame(frame.ID, "NOT_FOUND", "no route for "+method+" "+frame.Path))
	}
}

func methodNotAllowed(id string, method string, path string) tunnel.Frame {
	return errorFrame(id, "METHOD_NOT_ALLOWED", "method "+method+" is not allowed for "+path)
}

func (c *Client) memory(home string) any {
	mem, _ := os.ReadFile(filepath.Join(home, "memories", "MEMORY.md"))
	user, _ := os.ReadFile(filepath.Join(home, "memories", "USER.md"))
	return map[string]any{"memory": string(mem), "user": string(user), "profile": c.profileLabel(home)}
}

// profileLabel maps a home directory back to its profile name for responses.
func (c *Client) profileLabel(home string) string {
	if home == c.Home {
		return DefaultProfileName
	}
	base := filepath.Base(home)
	if _, err := ValidateProfileName(base); err != nil {
		return DefaultProfileName
	}
	return base
}

func (c *Client) updateMemory(frameBody any, home string) (any, error) {
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
	dir := filepath.Join(home, "memories")
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
