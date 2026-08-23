package hermes

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/brio/brio/apps/connect/internal/tunnel"
)

const (
	attachmentChunkMaxBytes = 128 * 1024
	attachmentFileMaxBytes  = 8 * 1024 * 1024
	attachmentTotalMaxBytes = 20 * 1024 * 1024
	attachmentMaxCount      = 20
	contextItemMaxBytes     = 256 * 1024
	contextSoftMaxBytes     = 512 * 1024
	contextHardMaxBytes     = 1024 * 1024
	contextFolderMaxEntries = 200
	contextMaxReferences    = 20
	composerInputMaxBytes   = 64 * 1024
)

var (
	attachmentIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
	lineRangePattern    = regexp.MustCompile(`^(.*?):([0-9]+)(?:-([0-9]+))?$`)
	contextRefPattern   = regexp.MustCompile(`@(file|folder|git|url|session):([^\s]+)|@(diff|staged)(?:\b|$)`)
)

type attachmentMetadata struct {
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	Name      string `json:"name"`
	MimeType  string `json:"mime_type"`
	Kind      string `json:"kind"`
	Size      int64  `json:"size"`
	Received  int64  `json:"received"`
	NextChunk int    `json:"next_chunk"`
	SHA256    string `json:"sha256,omitempty"`
	Complete  bool   `json:"complete"`
	CreatedAt int64  `json:"created_at"`
}

type composerFailure struct {
	status  int
	code    string
	message string
}

func (e *composerFailure) Error() string { return e.message }

func (c *Client) serveComposer(ctx context.Context, frame tunnel.Frame, method string, route Route, emit func(tunnel.Frame) error) error {
	var body any
	var failure *composerFailure
	switch route.Name {
	case "composer-capabilities":
		if method != http.MethodGet {
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
		body = composerCapabilities()
	case "composer-commands":
		if method != http.MethodGet {
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
		body, failure = c.commandCatalog(ctx)
	case "composer-command-complete":
		if method != http.MethodPost {
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
		body, failure = c.completeCommand(ctx, frame.Body)
	case "composer-command-dispatch":
		if method != http.MethodPost {
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
		body, failure = c.dispatchCommand(ctx, frame.Body)
	case "composer-context-complete":
		if method != http.MethodPost {
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
		body, failure = c.completeContext(ctx, frame.Body)
	case "composer-prepare":
		if method != http.MethodPost {
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
		body, failure = c.prepareComposerPrompt(ctx, frame.Body)
	case "composer-redirect":
		if method != http.MethodPost {
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
		body, failure = c.interruptForRedirect(ctx, frame.Body)
	case "composer-attachments":
		if method != http.MethodPost {
			return emit(methodNotAllowed(frame.ID, method, frame.Path))
		}
		body, failure = c.createAttachment(frame.Body)
	case "composer-attachment":
		body, failure = c.serveAttachment(method, route.Path, frame.Body)
	}
	if failure != nil {
		return emit(tunnel.Frame{Type: "response", ID: frame.ID, Status: failure.status, Body: map[string]any{
			"error": failure.message, "code": failure.code,
		}})
	}
	status := http.StatusOK
	if route.Name == "composer-attachments" {
		status = http.StatusCreated
	}
	return emit(responseFrame(frame.ID, status, body))
}

func composerCapabilities() map[string]any {
	return map[string]any{
		"attachment_chunk_bytes": attachmentChunkMaxBytes,
		"attachment_file_bytes":  attachmentFileMaxBytes,
		"attachment_total_bytes": attachmentTotalMaxBytes,
		"attachment_max_count":   attachmentMaxCount,
		"context_item_bytes":     contextItemMaxBytes,
		"context_soft_bytes":     contextSoftMaxBytes,
		"context_hard_bytes":     contextHardMaxBytes,
		"context_max_references": contextMaxReferences,
		"folder_entries":         contextFolderMaxEntries,
		"attachment_kinds":       []string{"image", "file"},
		"context_references":     []string{"file", "folder", "diff", "staged", "git", "url", "session"},
		"redirect_mode":          "interrupt_then_redirect",
	}
}

func decodeComposerBody(value any, destination any) *composerFailure {
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > composerInputMaxBytes*4 {
		return badComposerRequest("request body is invalid or too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return badComposerRequest("request body is invalid: " + err.Error())
	}
	return nil
}

func badComposerRequest(message string) *composerFailure {
	return &composerFailure{status: http.StatusBadRequest, code: "BAD_REQUEST", message: message}
}

func composerGatewayFailure(err error) *composerFailure {
	return &composerFailure{status: http.StatusBadGateway, code: "HERMES_CONTROL_FAILED", message: err.Error()}
}

func validComposerSessionID(value string) bool {
	return value != "" && len(value) <= maxControlIDLength && !strings.ContainsAny(value, "/\\\x00\r\n")
}

func (c *Client) attachmentRoot() string {
	return filepath.Join(c.Home, "brio", "attachments")
}

func (c *Client) attachmentDir(id string) (string, error) {
	if !attachmentIDPattern.MatchString(id) {
		return "", errors.New("invalid attachment id")
	}
	return filepath.Join(c.attachmentRoot(), id), nil
}

func (c *Client) createAttachment(value any) (any, *composerFailure) {
	var body struct {
		SessionID string `json:"session_id"`
		Name      string `json:"name"`
		MimeType  string `json:"mime_type"`
		Size      int64  `json:"size"`
	}
	if failure := decodeComposerBody(value, &body); failure != nil {
		return nil, failure
	}
	body.SessionID = strings.TrimSpace(body.SessionID)
	if !validComposerSessionID(body.SessionID) {
		return nil, badComposerRequest("invalid session_id")
	}
	body.Name = safeAttachmentName(body.Name)
	if body.Name == "" {
		return nil, badComposerRequest("attachment name is required")
	}
	if body.Size <= 0 || body.Size > attachmentFileMaxBytes {
		return nil, &composerFailure{status: http.StatusRequestEntityTooLarge, code: "ATTACHMENT_TOO_LARGE", message: fmt.Sprintf("attachment must be between 1 byte and %d bytes", attachmentFileMaxBytes)}
	}
	c.composerMu.Lock()
	defer c.composerMu.Unlock()
	if count, total := c.sessionAttachmentUsage(body.SessionID); count >= attachmentMaxCount || total+body.Size > attachmentTotalMaxBytes {
		return nil, &composerFailure{status: http.StatusRequestEntityTooLarge, code: "ATTACHMENT_LIMIT", message: "attachment count or total size limit exceeded"}
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, &composerFailure{status: http.StatusInternalServerError, code: "STORAGE_FAILED", message: "could not allocate attachment"}
	}
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(body.MimeType))
	if err != nil || mediaType == "" || len(mediaType) > 128 {
		mediaType = "application/octet-stream"
	}
	metadata := attachmentMetadata{
		ID: hex.EncodeToString(idBytes), SessionID: body.SessionID, Name: body.Name,
		MimeType: mediaType, Kind: "file", Size: body.Size, CreatedAt: time.Now().Unix(),
	}
	if strings.HasPrefix(strings.ToLower(mediaType), "image/") {
		metadata.Kind = "image"
	}
	if err := os.MkdirAll(filepath.Join(c.attachmentRoot(), metadata.ID), 0o700); err != nil {
		return nil, &composerFailure{status: http.StatusInternalServerError, code: "STORAGE_FAILED", message: "could not create attachment storage"}
	}
	if err := c.writeAttachmentMetadata(metadata); err != nil {
		return nil, &composerFailure{status: http.StatusInternalServerError, code: "STORAGE_FAILED", message: "could not initialize attachment"}
	}
	return metadata, nil
}

func (c *Client) serveAttachment(method string, path string, value any) (any, *composerFailure) {
	parts := strings.Split(strings.TrimPrefix(path, "/attachments/"), "/")
	if len(parts) == 1 && method == http.MethodDelete {
		return c.deleteAttachment(parts[0])
	}
	if len(parts) == 3 && parts[1] == "chunks" && method == http.MethodPut {
		index, err := strconv.Atoi(parts[2])
		if err != nil || index < 0 {
			return nil, badComposerRequest("invalid chunk index")
		}
		return c.appendAttachmentChunk(parts[0], index, value)
	}
	return nil, &composerFailure{status: http.StatusMethodNotAllowed, code: "METHOD_NOT_ALLOWED", message: "method is not allowed for attachment path"}
}

func (c *Client) appendAttachmentChunk(id string, index int, value any) (any, *composerFailure) {
	dir, err := c.attachmentDir(id)
	if err != nil {
		return nil, badComposerRequest(err.Error())
	}
	var body struct {
		DataBase64 string `json:"data_base64"`
		Final      bool   `json:"final"`
	}
	if failure := decodeComposerBody(value, &body); failure != nil {
		return nil, failure
	}
	chunk, err := base64.StdEncoding.DecodeString(body.DataBase64)
	if err != nil || len(chunk) == 0 || len(chunk) > attachmentChunkMaxBytes {
		return nil, badComposerRequest("invalid attachment chunk")
	}
	c.composerMu.Lock()
	defer c.composerMu.Unlock()
	metadata, err := c.readAttachmentMetadata(id)
	if err != nil {
		return nil, &composerFailure{status: http.StatusNotFound, code: "NOT_FOUND", message: "attachment not found"}
	}
	if metadata.Complete || index != metadata.NextChunk {
		return nil, &composerFailure{status: http.StatusConflict, code: "CHUNK_CONFLICT", message: fmt.Sprintf("expected chunk %d", metadata.NextChunk)}
	}
	if metadata.Received+int64(len(chunk)) > metadata.Size {
		return nil, &composerFailure{status: http.StatusRequestEntityTooLarge, code: "ATTACHMENT_TOO_LARGE", message: "attachment exceeds declared size"}
	}
	dataPath := filepath.Join(dir, "content")
	file, err := os.OpenFile(dataPath, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, &composerFailure{status: http.StatusInternalServerError, code: "STORAGE_FAILED", message: "could not write attachment"}
	}
	_, writeErr := file.WriteAt(chunk, metadata.Received)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		return nil, &composerFailure{status: http.StatusInternalServerError, code: "STORAGE_FAILED", message: "could not write attachment"}
	}
	metadata.Received += int64(len(chunk))
	metadata.NextChunk++
	if body.Final {
		if metadata.Received != metadata.Size {
			return nil, &composerFailure{status: http.StatusConflict, code: "SIZE_MISMATCH", message: "final chunk does not match declared size"}
		}
		data, err := os.ReadFile(dataPath)
		if err != nil {
			return nil, &composerFailure{status: http.StatusInternalServerError, code: "STORAGE_FAILED", message: "could not verify attachment"}
		}
		if metadata.Kind == "image" && !strings.HasPrefix(http.DetectContentType(data), "image/") {
			return nil, badComposerRequest("attachment content is not a supported image")
		}
		digest := sha256.Sum256(data)
		metadata.SHA256 = hex.EncodeToString(digest[:])
		metadata.Complete = true
	}
	if err := c.writeAttachmentMetadata(metadata); err != nil {
		return nil, &composerFailure{status: http.StatusInternalServerError, code: "STORAGE_FAILED", message: "could not save attachment metadata"}
	}
	return metadata, nil
}

func (c *Client) deleteAttachment(id string) (any, *composerFailure) {
	dir, err := c.attachmentDir(id)
	if err != nil {
		return nil, badComposerRequest(err.Error())
	}
	c.composerMu.Lock()
	defer c.composerMu.Unlock()
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return map[string]any{"deleted": true}, nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return nil, &composerFailure{status: http.StatusInternalServerError, code: "STORAGE_FAILED", message: "could not delete attachment"}
	}
	return map[string]any{"deleted": true}, nil
}

func (c *Client) writeAttachmentMetadata(metadata attachmentMetadata) error {
	dir, err := c.attachmentDir(metadata.ID)
	if err != nil {
		return err
	}
	data, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(dir, "metadata.json"), data, 0o600)
}

func (c *Client) readAttachmentMetadata(id string) (attachmentMetadata, error) {
	var metadata attachmentMetadata
	dir, err := c.attachmentDir(id)
	if err != nil {
		return metadata, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "metadata.json"))
	if err != nil {
		return metadata, err
	}
	if err := json.Unmarshal(data, &metadata); err != nil || metadata.ID != id {
		return metadata, errors.New("invalid attachment metadata")
	}
	return metadata, nil
}

func (c *Client) sessionAttachmentUsage(sessionID string) (int, int64) {
	entries, _ := os.ReadDir(c.attachmentRoot())
	count := 0
	var total int64
	for _, entry := range entries {
		metadata, err := c.readAttachmentMetadata(entry.Name())
		if err != nil || metadata.SessionID != sessionID {
			continue
		}
		if time.Since(time.Unix(metadata.CreatedAt, 0)) > 24*time.Hour {
			_ = os.RemoveAll(filepath.Join(c.attachmentRoot(), entry.Name()))
			continue
		}
		count++
		total += metadata.Size
	}
	return count, total
}

func safeAttachmentName(value string) string {
	value = filepath.Base(strings.TrimSpace(value))
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, value)
	if value == "." || len(value) > 256 || !utf8.ValidString(value) {
		return ""
	}
	return value
}

func (c *Client) commandCatalog(ctx context.Context) (any, *composerFailure) {
	result, err := c.commandCenter().control.Call(ctx, "commands.catalog", map[string]any{})
	if err != nil {
		return nil, composerGatewayFailure(err)
	}
	decoded, failure := rawComposerResult(result)
	if failure != nil {
		return nil, failure
	}
	annotateCommandPermissions(decoded)
	return decoded, nil
}

func annotateCommandPermissions(value any) {
	catalog, ok := value.(map[string]any)
	if !ok {
		return
	}
	permissions, _ := catalog["permissions"].(map[string]any)
	if permissions == nil {
		permissions = map[string]any{}
	}
	if skills, ok := catalog["skills"].(map[string]any); ok {
		for name := range skills {
			permissions[name] = "agent-turn"
		}
	}
	if quickCommands, ok := catalog["quick_commands"].(map[string]any); ok {
		for name, raw := range quickCommands {
			permission := "command"
			if command, ok := raw.(map[string]any); ok && command["type"] == "exec" {
				permission = "computer-exec"
			}
			permissions["/"+strings.TrimPrefix(name, "/")] = permission
		}
	}
	catalog["permissions"] = permissions
}

func (c *Client) completeCommand(ctx context.Context, value any) (any, *composerFailure) {
	var body struct {
		Text string `json:"text"`
	}
	if failure := decodeComposerBody(value, &body); failure != nil {
		return nil, failure
	}
	body.Text = strings.TrimSpace(body.Text)
	if len(body.Text) > 512 || !strings.HasPrefix(body.Text, "/") {
		return nil, badComposerRequest("text must be a slash command prefix")
	}
	result, err := c.commandCenter().control.Call(ctx, "complete.slash", map[string]any{"text": body.Text})
	if err != nil {
		return nil, composerGatewayFailure(err)
	}
	decoded, failure := rawComposerResult(result)
	if failure != nil {
		return nil, failure
	}
	normalizeCommandCompletions(body.Text, decoded)
	return decoded, nil
}

func normalizeCommandCompletions(query string, value any) {
	result, ok := value.(map[string]any)
	if !ok {
		return
	}
	replaceFrom := 0
	if number, ok := result["replace_from"].(float64); ok && number >= 0 && number <= float64(len(query)) {
		replaceFrom = int(number)
	}
	prefix := query[:replaceFrom]
	if prefix == "" && strings.HasPrefix(query, "/") {
		prefix = "/"
	}
	items, _ := result["items"].([]any)
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		text, _ := item["text"].(string)
		if text != "" && !strings.HasPrefix(text, "/") {
			item["text"] = prefix + text
		}
	}
	result["replace_from"] = 0
}

func (c *Client) dispatchCommand(ctx context.Context, value any) (any, *composerFailure) {
	var body struct {
		SessionID string `json:"session_id"`
		Text      string `json:"text"`
		RequestID string `json:"request_id"`
	}
	if failure := decodeComposerBody(value, &body); failure != nil {
		return nil, failure
	}
	body.SessionID = strings.TrimSpace(body.SessionID)
	body.Text = strings.TrimSpace(body.Text)
	if !validComposerSessionID(body.SessionID) || !strings.HasPrefix(body.Text, "/") || len(body.Text) > maxControlTextLength {
		return nil, badComposerRequest("valid session_id and slash command text are required")
	}
	commandBody := strings.TrimPrefix(body.Text, "/")
	fields := strings.Fields(commandBody)
	if len(fields) == 0 {
		return nil, badComposerRequest("command name is required")
	}
	name := fields[0]
	argument := strings.TrimSpace(commandBody[len(name):])
	control := c.commandCenter().control
	finishOperation := control.BeginControlOperation()
	defer finishOperation()
	params := map[string]any{"name": name, "arg": argument}
	result, dispatchErr := control.Call(ctx, "command.dispatch", params)
	if dispatchErr == nil {
		return rawComposerResult(result)
	}
	// Resolve through Hermes before falling back to slash.exec so Brio never
	// carries a hard-coded built-in command list.
	if _, err := control.Call(ctx, "command.resolve", map[string]any{"name": name}); err != nil {
		return nil, composerGatewayFailure(dispatchErr)
	}
	runtimeSessionID := ""
	if resumed, err := control.Call(ctx, "session.resume", map[string]any{
		"session_id": body.SessionID, "omit_messages": true,
	}); err == nil {
		if decoded, failure := rawComposerResult(resumed); failure == nil {
			if object, ok := decoded.(map[string]any); ok {
				if id, ok := object["session_id"].(string); ok && validComposerSessionID(id) {
					runtimeSessionID = id
				}
			}
		}
	}
	if runtimeSessionID == "" {
		if created, err := control.Call(ctx, "session.create", map[string]any{"cols": 100}); err == nil {
			if decoded, failure := rawComposerResult(created); failure == nil {
				if object, ok := decoded.(map[string]any); ok {
					if id, ok := object["session_id"].(string); ok && validComposerSessionID(id) {
						runtimeSessionID = id
					}
				}
			}
		}
	}
	if runtimeSessionID == "" {
		return nil, composerGatewayFailure(errors.New("Hermes did not create a command session"))
	}
	defer func() {
		closeContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = control.Call(closeContext, "session.close", map[string]any{"session_id": runtimeSessionID})
	}()
	result, err := control.Call(ctx, "slash.exec", map[string]any{
		"session_id": runtimeSessionID,
		"command":    body.Text,
	})
	if err != nil {
		params["session_id"] = runtimeSessionID
		result, err = control.Call(ctx, "command.dispatch", params)
	}
	if err != nil {
		return nil, composerGatewayFailure(err)
	}
	decoded, failure := rawComposerResult(result)
	if object, ok := decoded.(map[string]any); ok {
		object["type"] = "exec"
	}
	return decoded, failure
}

func rawComposerResult(value json.RawMessage) (any, *composerFailure) {
	var result any
	if err := json.Unmarshal(value, &result); err != nil {
		return nil, composerGatewayFailure(errors.New("Hermes returned invalid JSON"))
	}
	return result, nil
}

func (c *Client) interruptForRedirect(ctx context.Context, value any) (any, *composerFailure) {
	var body struct {
		SessionID string `json:"session_id"`
	}
	if failure := decodeComposerBody(value, &body); failure != nil {
		return nil, failure
	}
	body.SessionID = strings.TrimSpace(body.SessionID)
	if !validComposerSessionID(body.SessionID) {
		return nil, badComposerRequest("valid session_id is required")
	}
	control := c.commandCenter().control
	finishOperation := control.BeginControlOperation()
	defer finishOperation()
	runtimeSessionID := body.SessionID
	if resumed, err := control.Call(ctx, "session.resume", map[string]any{
		"session_id": body.SessionID, "omit_messages": true,
	}); err == nil {
		if decoded, failure := rawComposerResult(resumed); failure == nil {
			if object, ok := decoded.(map[string]any); ok {
				if id, ok := object["session_id"].(string); ok && validComposerSessionID(id) {
					runtimeSessionID = id
				}
			}
		}
	}
	result, err := control.Call(ctx, "session.interrupt", map[string]any{"session_id": runtimeSessionID})
	if err != nil {
		return nil, composerGatewayFailure(err)
	}
	decoded, failure := rawComposerResult(result)
	if failure != nil {
		return nil, failure
	}
	return map[string]any{"ok": true, "result": decoded}, nil
}

func (c *Client) completeContext(ctx context.Context, value any) (any, *composerFailure) {
	var body struct {
		Query string `json:"query"`
	}
	if failure := decodeComposerBody(value, &body); failure != nil {
		return nil, failure
	}
	query := strings.TrimSpace(body.Query)
	if len(query) > 512 || !strings.HasPrefix(query, "@") {
		return nil, badComposerRequest("query must be a context reference prefix")
	}
	items, err := c.contextCompletions(ctx, query)
	if err != nil {
		return nil, badComposerRequest(err.Error())
	}
	return map[string]any{"items": items}, nil
}

func (c *Client) contextCompletions(ctx context.Context, query string) ([]map[string]any, error) {
	base := []map[string]any{
		{"text": "@file:", "display": "File", "meta": "Attach a file or line range", "kind": "file"},
		{"text": "@folder:", "display": "Folder", "meta": "List a folder", "kind": "folder"},
		{"text": "@diff", "display": "Working diff", "meta": "Uncommitted Git changes", "kind": "git"},
		{"text": "@staged", "display": "Staged diff", "meta": "Staged Git changes", "kind": "git"},
		{"text": "@git:", "display": "Git revision", "meta": "Show a commit or range", "kind": "git"},
		{"text": "@url:", "display": "Web URL", "meta": "Fetch public HTTPS text", "kind": "url"},
		{"text": "@session:", "display": "Session", "meta": "Include another session", "kind": "session"},
	}
	if !strings.Contains(query, ":") {
		filtered := make([]map[string]any, 0, len(base))
		for _, item := range base {
			if strings.HasPrefix(item["text"].(string), strings.ToLower(query)) {
				filtered = append(filtered, item)
			}
		}
		return filtered, nil
	}
	kind, value, _ := strings.Cut(strings.TrimPrefix(query, "@"), ":")
	if kind == "session" {
		return c.sessionCompletions(ctx, value)
	}
	if kind != "file" && kind != "folder" {
		return []map[string]any{}, nil
	}
	return c.pathCompletions(kind, value)
}

func (c *Client) pathCompletions(kind string, value string) ([]map[string]any, error) {
	value = filepath.ToSlash(strings.TrimSpace(value))
	directoryPart := filepath.Dir(value)
	if directoryPart == "." {
		directoryPart = ""
	}
	namePart := strings.ToLower(filepath.Base(value))
	items := []map[string]any{}
	for _, root := range c.composerRoots() {
		if len(items) >= 40 {
			break
		}
		directory, err := c.safeComposerPath(root, directoryPart)
		if err != nil {
			continue
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if len(items) >= 40 {
				break
			}
			if (!entry.IsDir() && kind == "folder") || !strings.HasPrefix(strings.ToLower(entry.Name()), namePart) {
				continue
			}
			relative := filepath.ToSlash(filepath.Join(directoryPart, entry.Name()))
			if sensitiveReferencePath(relative) {
				continue
			}
			text := "@" + kind + ":" + relative
			if entry.IsDir() {
				text += "/"
			}
			items = append(items, map[string]any{"text": text, "display": entry.Name(), "meta": filepath.Base(root), "kind": kind})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["text"].(string) < items[j]["text"].(string) })
	return items, nil
}

func (c *Client) sessionCompletions(ctx context.Context, query string) ([]map[string]any, error) {
	target := strings.TrimRight(c.BaseURL, "/") + "/api/sessions?limit=60"
	data, err := c.readHermesJSON(ctx, target, contextItemMaxBytes)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Data []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, errors.New("Hermes returned invalid sessions")
	}
	query = strings.ToLower(query)
	items := []map[string]any{}
	for _, session := range payload.Data {
		if !validComposerSessionID(session.ID) || (!strings.Contains(strings.ToLower(session.ID), query) && !strings.Contains(strings.ToLower(session.Title), query)) {
			continue
		}
		items = append(items, map[string]any{"text": "@session:" + session.ID, "display": session.Title, "meta": session.ID, "kind": "session"})
		if len(items) == 20 {
			break
		}
	}
	return items, nil
}

func (c *Client) prepareComposerPrompt(ctx context.Context, value any) (any, *composerFailure) {
	var body struct {
		Input       string   `json:"input"`
		SessionID   string   `json:"session_id"`
		Attachments []string `json:"attachments"`
	}
	if failure := decodeComposerBody(value, &body); failure != nil {
		return nil, failure
	}
	body.SessionID = strings.TrimSpace(body.SessionID)
	if !validComposerSessionID(body.SessionID) || len(body.Input) > composerInputMaxBytes {
		return nil, badComposerRequest("valid session_id and input are required")
	}
	if len(body.Attachments) > attachmentMaxCount {
		return nil, badComposerRequest("too many attachments")
	}
	input, failure := c.buildComposerInput(ctx, body.Input, body.SessionID, body.Attachments)
	if failure != nil {
		return nil, failure
	}
	return map[string]any{"input": input}, nil
}

func (c *Client) prepareResponseRequest(ctx context.Context, value any) (map[string]any, *composerFailure) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, badComposerRequest("response request is invalid")
	}
	var body map[string]any
	if err := json.Unmarshal(encoded, &body); err != nil {
		return nil, badComposerRequest("response request must be an object")
	}
	sessionID, _ := body["brio_session_id"].(string)
	if sessionID == "" {
		return body, nil
	}
	prompt, ok := body["input"].(string)
	if !ok {
		return nil, badComposerRequest("Brio composer input must be text before expansion")
	}
	attachmentIDs := []string{}
	if rawIDs, ok := body["brio_attachments"].([]any); ok {
		for _, rawID := range rawIDs {
			id, ok := rawID.(string)
			if !ok {
				return nil, badComposerRequest("attachment ids must be strings")
			}
			attachmentIDs = append(attachmentIDs, id)
		}
	}
	input, failure := c.buildComposerInput(ctx, prompt, sessionID, attachmentIDs)
	if failure != nil {
		return nil, failure
	}
	delete(body, "brio_session_id")
	delete(body, "brio_attachments")
	body["input"] = input
	return body, nil
}

func (c *Client) buildComposerInput(ctx context.Context, prompt string, sessionID string, attachmentIDs []string) (any, *composerFailure) {
	if !validComposerSessionID(strings.TrimSpace(sessionID)) || len(prompt) > composerInputMaxBytes {
		return nil, badComposerRequest("valid session_id and input are required")
	}
	expanded, err := c.expandContextReferences(ctx, prompt)
	if err != nil {
		return nil, badComposerRequest(err.Error())
	}
	if len(attachmentIDs) > attachmentMaxCount {
		return nil, badComposerRequest("too many attachments")
	}
	seen := map[string]bool{}
	var total int64
	embeddedBytes := 0
	fileContext := strings.Builder{}
	images := []any{}
	for _, id := range attachmentIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		metadata, err := c.readAttachmentMetadata(id)
		if err != nil || !metadata.Complete || metadata.SessionID != sessionID {
			return nil, badComposerRequest("attachment is missing, incomplete, or belongs to another session")
		}
		total += metadata.Size
		if total > attachmentTotalMaxBytes {
			return nil, badComposerRequest("attachment total exceeds the configured limit")
		}
		dir, _ := c.attachmentDir(id)
		path := filepath.Join(dir, "content")
		if metadata.Kind == "image" {
			data, readErr := os.ReadFile(path)
			if readErr != nil || int64(len(data)) != metadata.Size {
				return nil, badComposerRequest("image attachment could not be read")
			}
			images = append(images, map[string]any{
				"type":      "image_url",
				"image_url": map[string]any{"url": "data:" + metadata.MimeType + ";base64," + base64.StdEncoding.EncodeToString(data)},
			})
			continue
		}
		metadataJSON, _ := json.Marshal(map[string]any{
			"name": metadata.Name, "type": metadata.MimeType, "size": metadata.Size,
			"sha256": metadata.SHA256, "path": path,
		})
		fmt.Fprintf(&fileContext, "\n<attachment>\nmetadata: %s", metadataJSON)
		if data, readErr := readLimitedFile(path, contextItemMaxBytes); readErr == nil && embeddedBytes+len(data) <= contextHardMaxBytes {
			fmt.Fprintf(&fileContext, "\ncontent:\n%s", data)
			embeddedBytes += len(data)
		} else {
			fileContext.WriteString("\ncontent: [available to Hermes tools at metadata.path]")
		}
		fileContext.WriteString("\n</attachment>")
	}
	if embeddedBytes > contextSoftMaxBytes {
		fileContext.WriteString("\n[Brio warning: uploaded file context exceeds the soft limit.]")
	}
	expanded = strings.TrimSpace(expanded + fileContext.String())
	if expanded == "" && len(images) == 0 {
		return nil, badComposerRequest("prompt is empty")
	}
	if len(images) == 0 {
		return expanded, nil
	}
	if expanded == "" {
		expanded = "Please inspect the attached image."
	}
	parts := []any{map[string]any{"type": "text", "text": expanded}}
	parts = append(parts, images...)
	return []any{map[string]any{"role": "user", "content": parts}}, nil
}

func (c *Client) expandContextReferences(ctx context.Context, prompt string) (string, error) {
	matches := contextRefPattern.FindAllStringSubmatchIndex(prompt, -1)
	if len(matches) > contextMaxReferences {
		return "", fmt.Errorf("a prompt can include at most %d context references", contextMaxReferences)
	}
	if len(matches) == 0 {
		return prompt, nil
	}
	var result strings.Builder
	last := 0
	total := 0
	for _, match := range matches {
		result.WriteString(prompt[last:match[0]])
		kind, refValue := "", ""
		if match[2] >= 0 {
			kind, refValue = prompt[match[2]:match[3]], prompt[match[4]:match[5]]
		} else {
			kind = prompt[match[6]:match[7]]
		}
		content, err := c.expandReference(ctx, kind, refValue)
		if err != nil {
			return "", fmt.Errorf("%s: %w", prompt[match[0]:match[1]], err)
		}
		total += len(content)
		if total > contextHardMaxBytes {
			return "", errors.New("expanded context exceeds the hard size limit")
		}
		fmt.Fprintf(&result, "\n<context source=%q>\n%s\n</context>\n", prompt[match[0]:match[1]], content)
		last = match[1]
	}
	result.WriteString(prompt[last:])
	return result.String(), nil
}

func (c *Client) expandReference(ctx context.Context, kind string, value string) (string, error) {
	switch kind {
	case "file":
		pathValue, firstLine, lastLine := value, 0, 0
		if match := lineRangePattern.FindStringSubmatch(value); match != nil {
			pathValue = match[1]
			firstLine, _ = strconv.Atoi(match[2])
			lastLine = firstLine
			if match[3] != "" {
				lastLine, _ = strconv.Atoi(match[3])
			}
			if firstLine < 1 || lastLine < firstLine || lastLine-firstLine > 2000 {
				return "", errors.New("invalid line range")
			}
		}
		path, err := c.resolveComposerPath(pathValue)
		if err != nil {
			return "", err
		}
		data, err := readLimitedFile(path, contextItemMaxBytes)
		if err != nil {
			return "", err
		}
		if firstLine > 0 {
			lines := strings.Split(string(data), "\n")
			if firstLine > len(lines) {
				return "", errors.New("line range starts beyond end of file")
			}
			if lastLine > len(lines) {
				lastLine = len(lines)
			}
			return strings.Join(lines[firstLine-1:lastLine], "\n"), nil
		}
		return string(data), nil
	case "folder":
		path, err := c.resolveComposerPath(value)
		if err != nil {
			return "", err
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			return "", err
		}
		lines := make([]string, 0, min(len(entries), contextFolderMaxEntries))
		for _, entry := range entries {
			if len(lines) == contextFolderMaxEntries {
				break
			}
			if sensitiveReferencePath(entry.Name()) {
				continue
			}
			suffix := ""
			if entry.IsDir() {
				suffix = "/"
			}
			lines = append(lines, entry.Name()+suffix)
		}
		return strings.Join(lines, "\n"), nil
	case "diff", "staged", "git":
		return c.gitContext(ctx, kind, value)
	case "url":
		return c.publicURLContext(ctx, value)
	case "session":
		return c.sessionContext(ctx, value)
	default:
		return "", errors.New("unsupported context reference")
	}
}

func (c *Client) composerRoots() []string {
	candidates := append([]string{}, c.ComposerRoots...)
	if len(candidates) == 0 {
		candidates = filepath.SplitList(os.Getenv("BRIO_COMPOSER_ROOTS"))
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	candidates = append(candidates, c.Home)
	userHome, _ := os.UserHomeDir()
	seen := map[string]bool{}
	roots := []string{}
	for _, candidate := range candidates {
		absolute, err := filepath.Abs(strings.TrimSpace(candidate))
		if err != nil || absolute == string(filepath.Separator) || (absolute == userHome && absolute != c.Home) || seen[absolute] {
			continue
		}
		info, err := os.Stat(absolute)
		if err != nil || !info.IsDir() {
			continue
		}
		seen[absolute] = true
		roots = append(roots, absolute)
	}
	return roots
}

func (c *Client) resolveComposerPath(value string) (string, error) {
	if sensitiveReferencePath(value) {
		return "", errors.New("sensitive paths cannot be referenced")
	}
	for _, root := range c.composerRoots() {
		path, err := c.safeComposerPath(root, value)
		if err == nil {
			if _, statErr := os.Stat(path); statErr == nil {
				return path, nil
			}
		}
	}
	return "", errors.New("path is outside configured composer roots or does not exist")
}

func (c *Client) safeComposerPath(root string, value string) (string, error) {
	value = filepath.FromSlash(strings.TrimSpace(value))
	if filepath.IsAbs(value) || sensitiveReferencePath(value) {
		return "", errors.New("path is not allowed")
	}
	path := filepath.Clean(filepath.Join(root, value))
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes the configured root")
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", errors.New("configured root could not be resolved")
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", errors.New("path does not exist")
	}
	resolvedRelative, err := filepath.Rel(resolvedRoot, resolvedPath)
	if err != nil || resolvedRelative == ".." || strings.HasPrefix(resolvedRelative, ".."+string(filepath.Separator)) {
		return "", errors.New("symlink target escapes the configured root")
	}
	return resolvedPath, nil
}

func sensitiveReferencePath(value string) bool {
	normalized := strings.ToLower(filepath.ToSlash(value))
	segments := strings.FieldsFunc(normalized, func(r rune) bool { return r == '/' || r == '\\' })
	for _, segment := range segments {
		switch segment {
		case ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".npmrc", ".pypirc", ".env", "credentials", "secrets", "private_keys", "keychains":
			return true
		}
		if strings.HasSuffix(segment, ".pem") || strings.HasSuffix(segment, ".key") || strings.Contains(segment, "credential") || strings.Contains(segment, "secret") || strings.Contains(segment, "token") {
			return true
		}
	}
	return false
}

func readLimitedFile(path string, limit int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("file is not regular or exceeds %d bytes", limit)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("file exceeds context limit")
	}
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return nil, errors.New("binary files cannot be expanded as text context")
	}
	return data, nil
}

func (c *Client) gitContext(ctx context.Context, kind string, value string) (string, error) {
	root := ""
	for _, candidate := range c.composerRoots() {
		if _, err := os.Stat(filepath.Join(candidate, ".git")); err == nil {
			root = candidate
			break
		}
	}
	if root == "" {
		return "", errors.New("no Git workspace is configured")
	}
	arguments := []string{"-C", root}
	switch kind {
	case "diff":
		arguments = append(arguments, "diff", "--no-ext-diff")
	case "staged":
		arguments = append(arguments, "diff", "--no-ext-diff", "--cached")
	case "git":
		if value == "" || strings.HasPrefix(value, "-") || strings.ContainsAny(value, "\x00\r\n") {
			return "", errors.New("invalid Git revision")
		}
		arguments = append(arguments, "show", "--no-ext-diff", "--format=fuller", value)
	}
	commandCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	output := &boundedBuffer{limit: contextItemMaxBytes}
	command := exec.CommandContext(commandCtx, "git", arguments...)
	command.Stdout = output
	err := command.Run()
	if err != nil {
		return "", errors.New("Git context could not be read")
	}
	if output.exceeded {
		return "", errors.New("Git context exceeds the per-reference limit")
	}
	return output.String(), nil
}

type boundedBuffer struct {
	bytes.Buffer
	limit    int
	exceeded bool
}

func (b *boundedBuffer) Write(value []byte) (int, error) {
	originalLength := len(value)
	remaining := b.limit - b.Len()
	if remaining < len(value) {
		b.exceeded = true
		if remaining < 0 {
			remaining = 0
		}
		value = value[:remaining]
	}
	_, _ = b.Buffer.Write(value)
	return originalLength, nil
}

func (c *Client) publicURLContext(ctx context.Context, rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return "", errors.New("only public HTTPS URLs without credentials are allowed")
	}
	if err := validatePublicHost(ctx, u.Hostname()); err != nil {
		return "", err
	}
	transport := &http.Transport{Proxy: nil, DialContext: dialPublicContext}
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	redirects := 0
	client.CheckRedirect = func(request *http.Request, _ []*http.Request) error {
		redirects++
		if redirects > 3 || request.URL.Scheme != "https" || request.URL.User != nil {
			return errors.New("URL redirect is not allowed")
		}
		return validatePublicHost(request.Context(), request.URL.Hostname())
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	request.Header.Set("Accept", "text/plain, text/markdown, application/json, application/xml, text/xml")
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("public URL could not be fetched")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("URL returned HTTP %d", response.StatusCode)
	}
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if !strings.HasPrefix(contentType, "text/") && !strings.Contains(contentType, "json") && !strings.Contains(contentType, "xml") {
		return "", errors.New("URL content type is not textual")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, contextItemMaxBytes+1))
	if err != nil || len(data) > contextItemMaxBytes || !utf8.Valid(data) {
		return "", errors.New("URL content is invalid or exceeds the context limit")
	}
	return string(data), nil
}

func validatePublicHost(ctx context.Context, host string) error {
	_, err := publicAddresses(ctx, host)
	return err
}

func publicAddresses(ctx context.Context, host string) ([]netip.Addr, error) {
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("URL host could not be resolved")
	}
	for _, address := range addresses {
		address = address.Unmap()
		if !address.IsValid() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() || address.IsMulticast() || address.IsUnspecified() || isDocumentationAddress(address) {
			return nil, errors.New("private or special-purpose URL hosts are not allowed")
		}
	}
	return addresses, nil
}

func dialPublicContext(ctx context.Context, network string, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := publicAddresses(ctx, host)
	if err != nil {
		return nil, err
	}
	// Dial the already-validated address directly. Resolving the hostname a
	// second time here would reopen a DNS-rebinding path to private services.
	target := net.JoinHostPort(addresses[0].String(), port)
	return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, target)
}

func isDocumentationAddress(address netip.Addr) bool {
	prefixes := []netip.Prefix{
		netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.51.100.0/24"),
		netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("2001:db8::/32"),
	}
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func (c *Client) sessionContext(ctx context.Context, sessionID string) (string, error) {
	if !validComposerSessionID(sessionID) {
		return "", errors.New("invalid session id")
	}
	target := strings.TrimRight(c.BaseURL, "/") + "/api/sessions/" + url.PathEscape(sessionID) + "/messages"
	data, err := c.readHermesJSON(ctx, target, contextItemMaxBytes)
	if err != nil {
		return "", err
	}
	var payload struct {
		Data []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", errors.New("Hermes returned invalid session messages")
	}
	var transcript strings.Builder
	for _, message := range payload.Data {
		if message.Role != "user" && message.Role != "assistant" {
			continue
		}
		fmt.Fprintf(&transcript, "%s: %s\n", message.Role, message.Content)
		if transcript.Len() > contextItemMaxBytes {
			return "", errors.New("session context exceeds the per-reference limit")
		}
	}
	return transcript.String(), nil
}

func (c *Client) readHermesJSON(ctx context.Context, target string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	if c.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	response, err := c.httpClient().Do(request)
	if err != nil {
		return nil, errors.New("Hermes API is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("Hermes API returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("Hermes response exceeds the context limit")
	}
	return data, nil
}
