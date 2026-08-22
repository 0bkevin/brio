package hermes

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/brio/brio/apps/connect/internal/tunnel"
	_ "modernc.org/sqlite"
)

// serveLocal handles the endpoints that read the Hermes home directory
// directly instead of going through the Hermes API server.
func (c *Client) serveLocal(ctx context.Context, frame tunnel.Frame, method string, route Route, query string, emit func(tunnel.Frame) error) error {
	switch route.Name {
	case "sessions":
		if method != http.MethodGet {
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
		limit := queryInt(query, "limit", 30, 1, 200)
		return emit(responseFrame(frame.ID, http.StatusOK, c.sessions(ctx, limit)))
	case "session-messages":
		if method != http.MethodGet {
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
		return emit(responseFrame(frame.ID, http.StatusOK, c.sessionMessages(ctx, route.ID)))
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
	default:
		return emit(errorFrame(frame.ID, "NOT_FOUND", "no route for "+method+" "+frame.Path))
	}
}

func methodNotAllowed(id string, method string, path string) tunnel.Frame {
	return errorFrame(id, "METHOD_NOT_ALLOWED", "method "+method+" is not allowed for "+path)
}

func (c *Client) openStateDB() (*sql.DB, error) {
	return sql.Open("sqlite", filepath.Join(c.Home, "state.db"))
}

func (c *Client) sessions(ctx context.Context, limit int) any {
	db, err := c.openStateDB()
	if err != nil {
		return map[string]any{"sessions": []any{}, "error": err.Error()}
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, `SELECT id, source, user_id, model, started_at, ended_at, message_count, title FROM sessions ORDER BY started_at DESC LIMIT ?`, limit)
	if err != nil {
		return map[string]any{"sessions": []any{}, "error": err.Error()}
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, source string
		var userID, model, title sql.NullString
		var startedAt float64
		var endedAt sql.NullFloat64
		var messageCount int
		_ = rows.Scan(&id, &source, &userID, &model, &startedAt, &endedAt, &messageCount, &title)
		items = append(items, map[string]any{
			"id": id, "source": source, "user_id": userID.String, "model": model.String,
			"started_at": startedAt, "ended_at": nullableFloat(endedAt), "message_count": messageCount,
			"title": title.String,
		})
	}
	return map[string]any{"sessions": items}
}

func (c *Client) sessionMessages(ctx context.Context, sessionID string) any {
	db, err := c.openStateDB()
	if err != nil {
		return map[string]any{"messages": []any{}, "error": err.Error()}
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, `SELECT role, content, tool_name, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC`, sessionID)
	if err != nil {
		return map[string]any{"messages": []any{}, "error": err.Error()}
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var role string
		var content, toolName sql.NullString
		var ts float64
		_ = rows.Scan(&role, &content, &toolName, &ts)
		items = append(items, map[string]any{"role": role, "content": content.String, "tool_name": toolName.String, "timestamp": ts})
	}
	return map[string]any{"messages": items}
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

func nullableFloat(v sql.NullFloat64) any {
	if v.Valid {
		return v.Float64
	}
	return nil
}

func queryInt(query string, key string, fallback int, min int, max int) int {
	for _, pair := range strings.Split(query, "&") {
		name, value, ok := strings.Cut(pair, "=")
		if !ok || name != key {
			continue
		}
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return fallback
		}
		if parsed < min {
			return min
		}
		if parsed > max {
			return max
		}
		return parsed
	}
	return fallback
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
