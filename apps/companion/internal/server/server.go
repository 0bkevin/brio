package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"gopkg.in/yaml.v3"
	_ "modernc.org/sqlite"
)

type app struct {
	cfg   Config
	roots []string
	http  *http.Client
}

func Run(ctx context.Context, cfg Config) error {
	a := &app{
		cfg:   cfg,
		roots: cfg.normalizedRoots(),
		http:  &http.Client{Timeout: 20 * time.Second},
	}

	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.RealIP)
	router.Use(middleware.Logger)
	router.Use(middleware.Recoverer)
	router.Use(a.auth)

	router.Get("/health", a.health)
	router.Get("/capabilities", a.capabilities)
	router.Post("/chat/responses", a.proxyHermes("/v1/responses"))
	router.Post("/runs", a.proxyHermes("/v1/runs"))
	router.Get("/runs/{id}", a.proxyHermesDynamic("/v1/runs/{id}"))
	router.Get("/runs/{id}/events", a.proxyHermesDynamic("/v1/runs/{id}/events"))
	router.Post("/runs/{id}/approval", a.proxyHermesDynamic("/v1/runs/{id}/approval"))
	router.Post("/runs/{id}/stop", a.proxyHermesDynamic("/v1/runs/{id}/stop"))
	router.Route("/jobs", func(r chi.Router) {
		r.Get("/", a.proxyHermes("/api/jobs"))
		r.Post("/", a.proxyHermes("/api/jobs"))
		r.Get("/{id}", a.proxyHermesDynamic("/api/jobs/{id}"))
		r.Patch("/{id}", a.proxyHermesDynamic("/api/jobs/{id}"))
		r.Delete("/{id}", a.proxyHermesDynamic("/api/jobs/{id}"))
		r.Post("/{id}/pause", a.proxyHermesDynamic("/api/jobs/{id}/pause"))
		r.Post("/{id}/resume", a.proxyHermesDynamic("/api/jobs/{id}/resume"))
		r.Post("/{id}/trigger", a.proxyHermesDynamic("/api/jobs/{id}/trigger"))
	})
	router.Get("/sessions", a.sessions)
	router.Get("/sessions/search", a.sessionSearch)
	router.Get("/sessions/{id}/messages", a.sessionMessages)
	router.Get("/config/raw", a.configRaw)
	router.Put("/config/raw", a.updateConfigRaw)
	router.Get("/skills", a.skills)
	router.Get("/tools/toolsets", a.toolsets)
	router.Patch("/tools/toolsets/{name}", a.updateToolset)
	router.Get("/memory", a.memory)
	router.Put("/memory", a.updateMemory)
	router.Get("/logs", a.logs)
	router.Get("/gateway/status", a.gatewayStatus)
	router.Post("/gateway/restart", a.gatewayRestart)
	router.Get("/files", a.fileList)
	router.Get("/files/read", a.fileRead)
	router.Put("/files/write", a.fileWrite)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	slog.Info("brio companion listening", "addr", cfg.Addr, "hermes_home", cfg.HermesHome, "hermes_api", cfg.HermesBaseURL)
	err := srv.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (a *app) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.cfg.Token == "" {
			next.ServeHTTP(w, r)
			return
		}
		auth := strings.TrimSpace(r.Header.Get("Authorization"))
		if auth != "Bearer "+a.cfg.Token {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *app) health(w http.ResponseWriter, r *http.Request) {
	hermesStatus, hermesBody := a.hermesGET(r.Context(), "/health")
	writeJSON(w, http.StatusOK, map[string]any{
		"service":       "brio-companion",
		"ok":            true,
		"hermes_ok":     hermesStatus == http.StatusOK,
		"hermes_status": hermesStatus,
		"hermes":        hermesBody,
		"hermes_home":   a.cfg.HermesHome,
		"allowed_roots": a.roots,
	})
}

func (a *app) capabilities(w http.ResponseWriter, r *http.Request) {
	_, hermesBody := a.hermesGET(r.Context(), "/v1/capabilities")
	writeJSON(w, http.StatusOK, map[string]any{
		"companion": map[string]any{
			"files":    true,
			"config":   true,
			"memory":   true,
			"sessions": true,
			"logs":     true,
			"gateway":  true,
		},
		"hermes": hermesBody,
	})
}

func (a *app) proxyHermes(path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a.doProxy(w, r, path)
	}
}

func (a *app) proxyHermesDynamic(pattern string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := strings.ReplaceAll(pattern, "{id}", chi.URLParam(r, "id"))
		a.doProxy(w, r, path)
	}
}

func (a *app) doProxy(w http.ResponseWriter, r *http.Request, path string) {
	target := strings.TrimRight(a.cfg.HermesBaseURL, "/") + path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	req.Header.Set("Content-Type", r.Header.Get("Content-Type"))
	if a.cfg.HermesAPIKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.cfg.HermesAPIKey)
	}
	resp, err := a.http.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	defer resp.Body.Close()
	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (a *app) hermesGET(ctx context.Context, path string) (int, any) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(a.cfg.HermesBaseURL, "/")+path, nil)
	if err != nil {
		return 0, map[string]any{"error": err.Error()}
	}
	if a.cfg.HermesAPIKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.cfg.HermesAPIKey)
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return 0, map[string]any{"error": err.Error()}
	}
	defer resp.Body.Close()
	var body any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		body = map[string]any{"status": resp.Status}
	}
	return resp.StatusCode, body
}

func (a *app) openStateDB() (*sql.DB, error) {
	return sql.Open("sqlite", filepath.Join(a.cfg.HermesHome, "state.db"))
}

func (a *app) sessions(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 30, 1, 200)
	db, err := a.openStateDB()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"sessions": []any{}, "error": err.Error()})
		return
	}
	defer db.Close()
	rows, err := db.QueryContext(r.Context(), `SELECT id, source, user_id, model, started_at, ended_at, message_count, title FROM sessions ORDER BY started_at DESC LIMIT ?`, limit)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"sessions": []any{}, "error": err.Error()})
		return
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
	writeJSON(w, http.StatusOK, map[string]any{"sessions": items})
}

func (a *app) sessionSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
		return
	}
	db, err := a.openStateDB()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}, "error": err.Error()})
		return
	}
	defer db.Close()
	rows, err := db.QueryContext(r.Context(), `SELECT m.session_id, m.role, snippet(messages_fts, 0, '[', ']', '...', 16) FROM messages_fts JOIN messages m ON messages_fts.rowid = m.id WHERE messages_fts MATCH ? LIMIT ?`, q+"*", queryInt(r, "limit", 20, 1, 100))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{}, "error": err.Error()})
		return
	}
	defer rows.Close()
	results := []map[string]any{}
	for rows.Next() {
		var sessionID, role, snippet string
		_ = rows.Scan(&sessionID, &role, &snippet)
		results = append(results, map[string]any{"session_id": sessionID, "role": role, "snippet": snippet})
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (a *app) sessionMessages(w http.ResponseWriter, r *http.Request) {
	db, err := a.openStateDB()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"messages": []any{}, "error": err.Error()})
		return
	}
	defer db.Close()
	rows, err := db.QueryContext(r.Context(), `SELECT role, content, tool_name, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC`, chi.URLParam(r, "id"))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"messages": []any{}, "error": err.Error()})
		return
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
	writeJSON(w, http.StatusOK, map[string]any{"messages": items})
}

func (a *app) configRaw(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(filepath.Join(a.cfg.HermesHome, "config.yaml"))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"yaml": "", "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"yaml": string(data)})
}

func (a *app) updateConfigRaw(w http.ResponseWriter, r *http.Request) {
	var body struct {
		YAML string `json:"yaml"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	var parsed any
	if err := yaml.Unmarshal([]byte(body.YAML), &parsed); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	path := filepath.Join(a.cfg.HermesHome, "config.yaml")
	if err := atomicWrite(path, []byte(body.YAML), 0o600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *app) skills(w http.ResponseWriter, r *http.Request) {
	root := filepath.Join(a.cfg.HermesHome, "skills")
	items := []map[string]any{}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Name() != "SKILL.md" {
			return nil
		}
		dir := filepath.Dir(path)
		rel, _ := filepath.Rel(root, dir)
		name := filepath.Base(dir)
		category := filepath.Dir(rel)
		if category == "." {
			category = ""
		}
		description := ""
		if data, err := os.ReadFile(path); err == nil {
			description = firstMeaningfulLine(string(data))
		}
		items = append(items, map[string]any{
			"name":        name,
			"category":    category,
			"path":        dir,
			"description": description,
			"enabled":     true,
		})
		return nil
	})
	writeJSON(w, http.StatusOK, map[string]any{"skills": items})
}

func (a *app) toolsets(w http.ResponseWriter, r *http.Request) {
	cfg, err := a.readYAMLConfig()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"toolsets": map[string]any{}, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"toolsets": cfg["platform_toolsets"]})
}

func (a *app) updateToolset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled  bool   `json:"enabled"`
		Platform string `json:"platform"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	platform := body.Platform
	if platform == "" {
		platform = "cli"
	}
	name := chi.URLParam(r, "name")
	cfg, err := a.readYAMLConfig()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	rawPlatforms, _ := cfg["platform_toolsets"].(map[string]any)
	if rawPlatforms == nil {
		rawPlatforms = map[string]any{}
		cfg["platform_toolsets"] = rawPlatforms
	}
	current := stringSlice(rawPlatforms[platform])
	next := setStringEnabled(current, name, body.Enabled)
	rawPlatforms[platform] = next

	data, err := yaml.Marshal(cfg)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if err := atomicWrite(filepath.Join(a.cfg.HermesHome, "config.yaml"), data, 0o600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "platform": platform, "toolsets": next})
}

func (a *app) memory(w http.ResponseWriter, r *http.Request) {
	mem, _ := os.ReadFile(filepath.Join(a.cfg.HermesHome, "memories", "MEMORY.md"))
	user, _ := os.ReadFile(filepath.Join(a.cfg.HermesHome, "memories", "USER.md"))
	writeJSON(w, http.StatusOK, map[string]any{"memory": string(mem), "user": string(user)})
}

func (a *app) updateMemory(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Memory *string `json:"memory"`
		User   *string `json:"user"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	dir := filepath.Join(a.cfg.HermesHome, "memories")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if body.Memory != nil {
		if err := atomicWrite(filepath.Join(dir, "MEMORY.md"), []byte(*body.Memory), 0o600); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
	}
	if body.User != nil {
		if err := atomicWrite(filepath.Join(dir, "USER.md"), []byte(*body.User), 0o600); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *app) logs(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("file")
	if name == "" {
		name = "agent"
	}
	allowed := map[string]string{
		"agent":   "agent.log",
		"errors":  "errors.log",
		"gateway": "gateway.log",
	}
	file, ok := allowed[name]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown log file"})
		return
	}
	lines := tailLines(filepath.Join(a.cfg.HermesHome, "logs", file), queryInt(r, "lines", 200, 1, 2000))
	writeJSON(w, http.StatusOK, map[string]any{"file": name, "lines": lines})
}

func (a *app) gatewayStatus(w http.ResponseWriter, r *http.Request) {
	statusPath := filepath.Join(a.cfg.HermesHome, "gateway", "runtime_status.json")
	data, err := os.ReadFile(statusPath)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"running": false, "status": nil})
		return
	}
	var status any
	if err := json.Unmarshal(data, &status); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"running": true, "raw": string(data)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"running": true, "status": status})
}

func (a *app) gatewayRestart(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "hermes", "gateway", "restart")
	out, err := cmd.CombinedOutput()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "output": string(out), "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": string(out)})
}

func (a *app) fileList(w http.ResponseWriter, r *http.Request) {
	path, err := a.safePath(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	items := []map[string]any{}
	for _, entry := range entries {
		info, _ := entry.Info()
		items = append(items, map[string]any{"name": entry.Name(), "path": filepath.Join(path, entry.Name()), "dir": entry.IsDir(), "size": info.Size()})
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "entries": items, "roots": a.roots})
}

func (a *app) fileRead(w http.ResponseWriter, r *http.Request) {
	path, err := a.safePath(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if len(data) > 1024*1024 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "file is larger than 1 MiB"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "content": string(data)})
}

func (a *app) fileWrite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON"})
		return
	}
	path, err := a.safePath(body.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if len(body.Content) > 1024*1024 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "content is larger than 1 MiB"})
		return
	}
	if err := atomicWrite(path, []byte(body.Content), 0o600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *app) safePath(raw string) (string, error) {
	if raw == "" {
		if len(a.roots) == 0 {
			return "", fmt.Errorf("no allowed roots configured")
		}
		return a.roots[0], nil
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		resolved = filepath.Clean(abs)
	}
	for _, root := range a.roots {
		rel, err := filepath.Rel(root, resolved)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("path is outside allowed roots")
}

func (a *app) readYAMLConfig() (map[string]any, error) {
	data, err := os.ReadFile(filepath.Join(a.cfg.HermesHome, "config.yaml"))
	if err != nil {
		return nil, err
	}
	cfg := map[string]any{}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func nullableFloat(v sql.NullFloat64) any {
	if v.Valid {
		return v.Float64
	}
	return nil
}

func queryInt(r *http.Request, key string, fallback int, min int, max int) int {
	value, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func atomicWrite(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func tailLines(path string, limit int) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return []string{}
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) > limit {
		return lines[len(lines)-limit:]
	}
	return lines
}

func firstMeaningfulLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(line, "#"))
		if line != "" && line != "---" {
			if len(line) > 180 {
				return line[:180]
			}
			return line
		}
	}
	return ""
}

func stringSlice(value any) []string {
	switch typed := value.(type) {
	case []string:
		return append([]string{}, typed...)
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return []string{}
	}
}

func setStringEnabled(values []string, value string, enabled bool) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values)+1)
	for _, item := range values {
		if item == value {
			if enabled && !seen[item] {
				out = append(out, item)
				seen[item] = true
			}
			continue
		}
		if !seen[item] {
			out = append(out, item)
			seen[item] = true
		}
	}
	if enabled && !seen[value] {
		out = append(out, value)
	}
	return out
}
