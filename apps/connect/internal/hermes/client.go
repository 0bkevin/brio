// Package hermes routes tunnel request frames: a fixed set of paths is
// forwarded to the stock Hermes API server with the local API key, memory is
// served from the Hermes home directory, and everything else is rejected.
// Every route can additionally be scoped to a Hermes profile through the
// `/p/<profile>/...` prefix: forwarded requests keep their prefix upstream
// (multiplexed gateway semantics) and authenticate with that profile's own
// credentials, while local routes operate on the profile's home directory.
package hermes

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/brio/brio/apps/connect/internal/tunnel"
)

// Client routes and serves tunnel request frames.
type Client struct {
	// BaseURL is the Hermes API server base URL (for example
	// http://127.0.0.1:8642).
	BaseURL string
	// APIKey is the API_SERVER_KEY bearer used for default-scope requests.
	APIKey string
	// Home is the Hermes home directory (~/.hermes).
	Home string
	// ComposerRoots is the explicit allow-list used by @file, @folder, and
	// Git context references.
	ComposerRoots []string
	// ControlBaseURL is the Hermes serve JSON-RPC endpoint for the machine.
	ControlBaseURL string
	// ControlToken authenticates the Hermes serve WebSocket session.
	ControlToken string
	// ControlOverrides maps a named profile to its dedicated `hermes serve`
	// control endpoint. The default scope always uses ControlBaseURL and
	// ControlToken.
	ControlOverrides map[string]ControlEndpoint

	HTTP *http.Client

	controlOnce     sync.Once
	controlApp      *app
	composerMu      sync.Mutex
	profileApps     sync.Map // profile name -> *app
	profilesOnce    sync.Once
	profileMgr      *ProfileManager
	gatewayMu       sync.Mutex
	gatewayChannels map[string]*gatewayChannel
}

// ControlEndpoint points at one `hermes serve` control plane instance.
type ControlEndpoint struct {
	BaseURL string
	Token   string
}

const (
	maxResponseBytes = 10 * 1024 * 1024
	maxStreamBytes   = 10 * 1024 * 1024
	forwardTimeout   = 5 * time.Minute
)

// RouteKind classifies a request path.
type RouteKind int

const (
	// RouteUnknown means the path is not served at all.
	RouteUnknown RouteKind = iota
	// RouteForward means the path is proxied to the Hermes API server.
	RouteForward
	// RouteControlForward means the path is proxied to the authenticated
	// Hermes dashboard/control HTTP server.
	RouteControlForward
	// RouteLocal means the path is served from the Hermes home directory.
	RouteLocal
)

// Route is the routing decision for one request path.
type Route struct {
	Kind RouteKind
	// Path is the forwarded path after legacy alias mapping.
	Path string
	// Name identifies the local handler ("memory", "profiles", ...).
	Name string
	// Profile scopes the request to a Hermes profile via /p/<profile>/...
	// routing. Empty means the default/unscoped home.
	Profile string
}

// RoutePath maps a request path (without query string) to a route. Legacy
// companion-era aliases are mapped to their /v1 equivalents. A `/p/<profile>`
// prefix scopes the remaining path to that profile while keeping the
// remainder's leading slash intact so it classifies like any other request.
func RoutePath(path string) Route {
	if profile, rest, ok := splitProfilePrefix(path); ok {
		route := RoutePath(rest)
		route.Profile = profile
		return route
	}
	switch path {
	case "/health":
		return Route{Kind: RouteForward, Path: "/health"}
	case "/v1/capabilities", "/capabilities":
		return Route{Kind: RouteForward, Path: "/v1/capabilities"}
	case "/v1/responses", "/chat/responses":
		return Route{Kind: RouteForward, Path: "/v1/responses"}
	case "/v1/memory", "/memory":
		return Route{Kind: RouteLocal, Name: "memory"}
	case "/control/rpc":
		return Route{Kind: RouteLocal, Name: "control-rpc"}
	case "/control/command":
		return Route{Kind: RouteLocal, Name: "control-command"}
	case "/control/background":
		return Route{Kind: RouteLocal, Name: "control-background"}
	case "/control/events":
		return Route{Kind: RouteLocal, Name: "control-events"}
	case "/api/profiles":
		return Route{Kind: RouteLocal, Name: "profiles"}
	case "/composer/capabilities":
		return Route{Kind: RouteLocal, Name: "composer-capabilities"}
	case "/composer/commands":
		return Route{Kind: RouteLocal, Name: "composer-commands"}
	case "/composer/commands/complete":
		return Route{Kind: RouteLocal, Name: "composer-command-complete"}
	case "/composer/commands/dispatch":
		return Route{Kind: RouteLocal, Name: "composer-command-dispatch"}
	case "/composer/context/complete":
		return Route{Kind: RouteLocal, Name: "composer-context-complete"}
	case "/composer/prepare":
		return Route{Kind: RouteLocal, Name: "composer-prepare"}
	case "/composer/redirect":
		return Route{Kind: RouteLocal, Name: "composer-redirect"}
	case "/attachments":
		return Route{Kind: RouteLocal, Path: path, Name: "composer-attachments"}
	case "/api/sessions":
		return Route{Kind: RouteForward, Path: path}
	case "/api/sessions/search":
		return Route{Kind: RouteControlForward, Path: path}
	case "/api/model/options":
		return Route{Kind: RouteForward, Path: path}
	case "/files":
		return Route{Kind: RouteControlForward, Path: "/api/files"}
	case "/files/read":
		return Route{Kind: RouteControlForward, Path: "/api/files/read"}
	case "/files/write":
		return Route{Kind: RouteControlForward, Path: "/api/files/upload"}
	case "/config/raw":
		return Route{Kind: RouteControlForward, Path: "/api/config/raw"}
	case "/skills":
		return Route{Kind: RouteControlForward, Path: "/api/skills"}
	case "/tools/toolsets":
		return Route{Kind: RouteControlForward, Path: "/api/tools/toolsets"}
	case "/gateway/status":
		return Route{Kind: RouteControlForward, Path: "/api/status"}
	case "/gateway/restart":
		return Route{Kind: RouteControlForward, Path: "/api/gateway/restart"}
	case "/logs":
		return Route{Kind: RouteControlForward, Path: "/api/logs"}
	case "/api/cron/jobs":
		return Route{Kind: RouteControlForward, Path: path}
	case "/jobs", "/jobs/":
		return Route{Kind: RouteControlForward, Path: "/api/cron/jobs"}
	}
	switch {
	case strings.HasPrefix(path, "/api/profiles/"):
		return Route{Kind: RouteLocal, Name: "profiles"}
	case strings.HasPrefix(path, "/attachments/"):
		return Route{Kind: RouteLocal, Path: path, Name: "composer-attachment"}
	case strings.HasPrefix(path, "/v1/runs"), strings.HasPrefix(path, "/api/jobs"):
		return Route{Kind: RouteForward, Path: path}
	case strings.HasPrefix(path, "/tools/toolsets/"):
		name := strings.TrimPrefix(path, "/tools/toolsets/")
		if name != "" && !strings.Contains(name, "/") {
			return Route{Kind: RouteControlForward, Path: "/api/tools/toolsets/" + name}
		}
	case strings.HasPrefix(path, "/api/cron/jobs/"):
		if canonicalCronJobPath(path) {
			return Route{Kind: RouteControlForward, Path: path}
		}
	case strings.HasPrefix(path, "/jobs/"):
		if mapped, ok := legacyCronJobPath(path); ok {
			return Route{Kind: RouteControlForward, Path: mapped}
		}
	}
	if isSessionMessagesPath(path) || isSessionDetailPath(path) || isSessionModelPath(path) {
		return Route{Kind: RouteForward, Path: path}
	}
	return Route{Kind: RouteUnknown}
}

func canonicalCronJobPath(path string) bool {
	rest := strings.TrimPrefix(path, "/api/cron/jobs/")
	id, action, hasAction := strings.Cut(rest, "/")
	if id == "" || strings.Contains(action, "/") {
		return false
	}
	if !hasAction {
		return true
	}
	switch action {
	case "pause", "resume", "trigger", "runs":
		return true
	default:
		return false
	}
}

func legacyCronJobPath(path string) (string, bool) {
	rest := strings.TrimPrefix(path, "/jobs/")
	id, action, hasAction := strings.Cut(rest, "/")
	if id == "" || strings.Contains(action, "/") {
		return "", false
	}
	if !hasAction {
		return "/api/cron/jobs/" + id, true
	}
	switch action {
	case "pause", "resume", "trigger", "runs":
		return "/api/cron/jobs/" + id + "/" + action, true
	default:
		return "", false
	}
}

// splitProfilePrefix recognizes `/p/<name>` and `/p/<name>/...` prefixes for
// NAMED profiles. The remaining path keeps its leading slash so it can be
// routed exactly like an unprefixed request. `default` is rejected as a
// prefix target because unprefixed requests already address the stock home;
// unknown names are rejected later against the real filesystem in Serve.
func splitProfilePrefix(path string) (string, string, bool) {
	const prefix = "/p/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	name, remainder, _ := strings.Cut(rest, "/")
	if name == "" || name == DefaultProfileName {
		return "", "", false
	}
	validated, err := ValidateProfileName(name)
	if err != nil {
		return "", "", false
	}
	return validated, "/" + remainder, true
}

func isSessionMessagesPath(path string) bool {
	return isSessionTailPath(path, "messages")
}

func isSessionDetailPath(path string) bool {
	const prefix = "/api/sessions/"
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	id := strings.TrimPrefix(path, prefix)
	return id != "" && !strings.Contains(id, "/")
}

func isSessionModelPath(path string) bool {
	return isSessionTailPath(path, "model")
}

func isSessionTailPath(path string, tail string) bool {
	const prefix = "/api/sessions/"
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	id, suffix, ok := strings.Cut(strings.TrimPrefix(path, prefix), "/")
	return ok && suffix == tail && id != "" && !strings.Contains(id, "/")
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: forwardTimeout}
}

// profileManager lazily binds the profile manager to this client's home. An
// already-injected manager (tests) is preserved.
func (c *Client) profileManager() *ProfileManager {
	c.profilesOnce.Do(func() {
		if c.profileMgr == nil {
			c.profileMgr = newProfileManager(c.Home)
		}
	})
	return c.profileMgr
}

// homeFor resolves the Hermes home backing a profile name.
func (c *Client) homeFor(profile string) string {
	if profile == "" || profile == DefaultProfileName {
		return c.Home
	}
	dir, err := c.profileManager().dirFor(profile)
	if err != nil {
		return filepath.Join(c.Home, profilesDirName, profile)
	}
	return dir
}

// apiKeyFor resolves the API server key for a request scope. Named profiles
// authenticate with their own .env; the default scope keeps the
// connector-wide key. Credentials are never shared across profiles.
func (c *Client) apiKeyFor(profile string) string {
	if profile == "" || profile == DefaultProfileName {
		return c.APIKey
	}
	return dotEnvValue(filepath.Join(c.homeFor(profile), envFileName), "API_SERVER_KEY")
}

func (c *Client) commandCenter() *app {
	c.controlOnce.Do(func() {
		c.controlApp = &app{control: newControlClient(Config{
			HermesControlURL:   c.ControlBaseURL,
			HermesControlToken: c.ControlToken,
		}, c.httpClient())}
	})
	return c.controlApp
}

// commandCenterFor returns the control app serving one profile. Named
// profiles require a dedicated `hermes serve` endpoint configured for them;
// without one the request fails closed instead of mixing another profile's
// control state. Instances are cached per profile.
func (c *Client) commandCenterFor(profile string) (*app, error) {
	if profile == "" || profile == DefaultProfileName {
		return c.commandCenter(), nil
	}
	override, ok := c.ControlOverrides[profile]
	if !ok || strings.TrimSpace(override.BaseURL) == "" {
		return nil, errors.New("this profile has no dedicated hermes serve control endpoint; start one for it and set HERMES_CONTROL_BASE_" + controlEnvSuffix(profile))
	}
	if cached, ok := c.profileApps.Load(profile); ok {
		return cached.(*app), nil
	}
	profileApp := &app{control: newControlClient(Config{
		HermesControlURL:   override.BaseURL,
		HermesControlToken: override.Token,
	}, c.httpClient())}
	actual, _ := c.profileApps.LoadOrStore(profile, profileApp)
	return actual.(*app), nil
}

// Close stops every persistent Hermes control connection and heartbeat
// worker, including per-profile instances.
func (c *Client) Close() {
	if c.controlApp != nil {
		c.controlApp.control.Close()
	}
	c.profileApps.Range(func(_, value any) bool {
		value.(*app).control.Close()
		return true
	})
	c.closeGatewayChannels()
}

// Serve handles one tunnel request frame and emits response, stream, or
// error frames. It returns a non-nil error only when emit fails.
func (c *Client) Serve(ctx context.Context, frame tunnel.Frame, emit func(tunnel.Frame) error) error {
	switch frame.Type {
	case "channel_open", "channel_data", "channel_close":
		return c.serveGatewayChannel(ctx, frame, emit)
	}
	method := frame.Method
	if method == "" {
		method = http.MethodGet
	}
	if frame.Path == "" || !strings.HasPrefix(frame.Path, "/") {
		return emit(errorFrame(frame.ID, "BAD_REQUEST", "request path must start with /"))
	}
	path, query, _ := strings.Cut(frame.Path, "?")
	route := RoutePath(path)
	// Profile prefixes are verified against the real filesystem before any
	// work happens: unknown profiles never reach the upstream server.
	if route.Profile != "" && !c.profileManager().Exists(route.Profile) {
		return emit(errorFrame(frame.ID, "PROFILE_NOT_FOUND", "unknown profile: "+route.Profile))
	}
	switch route.Kind {
	case RouteForward:
		return c.forward(ctx, frame, method, route, query, emit)
	case RouteControlForward:
		return c.forwardControlHTTP(ctx, frame, method, route, query, emit)
	case RouteLocal:
		return c.serveLocal(ctx, frame, method, route, query, emit)
	default:
		return emit(errorFrame(frame.ID, "NOT_FOUND", "no route for "+method+" "+frame.Path))
	}
}

// forwardControlHTTP serves dashboard-only JSON endpoints that the Hermes
// gateway API does not expose. The control token is always injected locally;
// credentials supplied by Mobile are never forwarded.
func (c *Client) forwardControlHTTP(ctx context.Context, frame tunnel.Frame, method string, route Route, query string, emit func(tunnel.Frame) error) error {
	requestMethod := method
	requestBody := frame.Body
	if route.Path == "/api/files/upload" && method == http.MethodPut {
		body, ok := frame.Body.(map[string]any)
		if !ok {
			return emit(errorFrame(frame.ID, "BAD_REQUEST", "file write body must be an object"))
		}
		path, pathOK := body["path"].(string)
		content, contentOK := body["content"].(string)
		if !pathOK || strings.TrimSpace(path) == "" || !contentOK {
			return emit(errorFrame(frame.ID, "BAD_REQUEST", "file write requires path and content"))
		}
		if len(content) > 1024*1024 {
			return emit(errorFrame(frame.ID, "BAD_REQUEST", "file content exceeds 1 MiB"))
		}
		requestMethod = http.MethodPost
		requestBody = map[string]any{
			"path":      path,
			"data_url":  "data:text/plain;base64," + base64.StdEncoding.EncodeToString([]byte(content)),
			"overwrite": true,
		}
	}
	if strings.HasPrefix(route.Path, "/api/tools/toolsets/") && method == http.MethodPatch {
		requestMethod = http.MethodPut
	}
	endpoint, err := c.gatewayEndpoint(route.Profile)
	if err != nil {
		return emit(errorFrame(frame.ID, "CONTROL_UNAVAILABLE", err.Error()))
	}
	target := strings.TrimRight(endpoint.BaseURL, "/") + route.Path
	if query != "" {
		target += "?" + query
	}
	var bodyReader io.Reader = http.NoBody
	if requestBody != nil {
		payload, marshalErr := json.Marshal(requestBody)
		if marshalErr != nil {
			return emit(errorFrame(frame.ID, "BAD_REQUEST", marshalErr.Error()))
		}
		bodyReader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, requestMethod, target, bodyReader)
	if err != nil {
		return emit(errorFrame(frame.ID, "BAD_REQUEST", err.Error()))
	}
	req.Header.Set("Accept", "application/json")
	if requestBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+endpoint.Token)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return emit(errorFrame(frame.ID, "LOCAL_UNREACHABLE", err.Error()))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return emit(errorFrame(frame.ID, "LOCAL_READ_FAILED", err.Error()))
	}
	if len(data) > maxResponseBytes {
		return emit(errorFrame(frame.ID, "RESPONSE_TOO_LARGE", "local response is larger than 10 MiB"))
	}
	contentType := resp.Header.Get("Content-Type")
	var body any
	if len(data) > 0 && strings.Contains(strings.ToLower(contentType), "json") {
		_ = json.Unmarshal(data, &body)
	}
	if body == nil {
		body = string(data)
	}
	return emit(tunnel.Frame{
		Type:    "response",
		ID:      frame.ID,
		Status:  resp.StatusCode,
		Headers: map[string]string{"Content-Type": contentType},
		Body:    body,
	})
}

func (c *Client) forward(ctx context.Context, frame tunnel.Frame, method string, route Route, query string, emit func(tunnel.Frame) error) error {
	if route.Path == "/v1/responses" && method == http.MethodPost {
		prepared, failure := c.prepareResponseRequest(ctx, frame.Body)
		if failure != nil {
			return emit(tunnel.Frame{Type: "response", ID: frame.ID, Status: failure.status, Body: map[string]any{
				"error": failure.message, "code": failure.code,
			}})
		}
		frame.Body = prepared
	}
	var requestBody io.Reader = http.NoBody
	if frame.Body != nil {
		payload, err := json.Marshal(frame.Body)
		if err != nil {
			return emit(errorFrame(frame.ID, "BAD_REQUEST", err.Error()))
		}
		requestBody = bytes.NewReader(payload)
	}
	// Profile-prefixed requests keep their upstream prefix so a multiplexing
	// gateway listener routes them to the right profile. The default scope
	// forwards unprefixed exactly as before.
	target := strings.TrimRight(c.BaseURL, "/") + route.Path
	if route.Profile != "" {
		target = strings.TrimRight(c.BaseURL, "/") + "/p/" + route.Profile + route.Path
	}
	if query != "" {
		target += "?" + query
	}
	req, err := http.NewRequestWithContext(ctx, method, target, requestBody)
	if err != nil {
		return emit(errorFrame(frame.ID, "BAD_REQUEST", err.Error()))
	}
	for key, value := range frame.Headers {
		switch strings.ToLower(key) {
		case "authorization", "host", "content-length":
		default:
			if value != "" {
				req.Header.Set(key, value)
			}
		}
	}
	if frame.Body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	// The scoped API key always replaces whatever credentials the frame
	// carried. Named profiles use their own API_SERVER_KEY and fail closed
	// when it is absent instead of falling back to the connector-wide key.
	apiKey := c.apiKeyFor(route.Profile)
	if route.Profile != "" && apiKey == "" {
		return emit(errorFrame(frame.ID, "PROFILE_UNAUTHENTICATED",
			"profile "+route.Profile+" has no API_SERVER_KEY in its .env; configure it before sending profile-scoped API requests"))
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return emit(errorFrame(frame.ID, "LOCAL_UNREACHABLE", err.Error()))
	}
	defer resp.Body.Close()
	contentType := resp.Header.Get("Content-Type")
	if resp.StatusCode < http.StatusBadRequest && strings.Contains(strings.ToLower(contentType), "text/event-stream") {
		return streamEventStream(frame.ID, resp, emit)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return emit(errorFrame(frame.ID, "LOCAL_READ_FAILED", err.Error()))
	}
	if len(data) > maxResponseBytes {
		return emit(errorFrame(frame.ID, "RESPONSE_TOO_LARGE", "local response is larger than 10 MiB"))
	}
	var body any
	if len(data) > 0 && strings.Contains(contentType, "json") {
		_ = json.Unmarshal(data, &body)
	}
	if body == nil {
		body = string(data)
	}
	return emit(tunnel.Frame{
		Type:    "response",
		ID:      frame.ID,
		Status:  resp.StatusCode,
		Headers: map[string]string{"Content-Type": contentType},
		Body:    body,
	})
}

// streamEventStream forwards complete SSE lines as stream_chunk frames. Line
// framing keeps UTF-8 code points intact even when the HTTP body reader splits
// a multi-byte character across reads. The mobile client owns SSE parsing, so
// stream_end is only a terminal marker and deliberately carries no body.
func streamEventStream(id string, resp *http.Response, emit func(tunnel.Frame) error) error {
	reader := bufio.NewReader(resp.Body)
	line := make([]byte, 0, 32*1024)
	total := 0
	for {
		fragment, readErr := reader.ReadSlice('\n')
		if len(fragment) > 0 {
			total += len(fragment)
			if total > maxStreamBytes {
				return emit(errorFrame(id, "RESPONSE_TOO_LARGE", "local response stream is larger than 10 MiB"))
			}
			line = append(line, fragment...)
			if readErr != bufio.ErrBufferFull {
				if err := emit(tunnel.Frame{Type: "stream_chunk", ID: id, Data: string(line)}); err != nil {
					return err
				}
				line = line[:0]
			}
		}
		if readErr != nil {
			if readErr == bufio.ErrBufferFull {
				continue
			}
			if readErr == io.EOF {
				return emit(tunnel.Frame{
					Type:    "stream_end",
					ID:      id,
					Status:  resp.StatusCode,
					Headers: terminalStreamHeaders(resp),
				})
			}
			return emit(errorFrame(id, "LOCAL_READ_FAILED", readErr.Error()))
		}
	}
}

// terminalStreamHeaders carries the content type plus the stable runtime
// session identity so the mobile client can continue the session later.
func terminalStreamHeaders(resp *http.Response) map[string]string {
	headers := map[string]string{"Content-Type": resp.Header.Get("Content-Type")}
	if sessionID := resp.Header.Get("X-Hermes-Session-Id"); sessionID != "" {
		headers["X-Hermes-Session-Id"] = sessionID
	}
	return headers
}

func errorFrame(id string, code string, message string) tunnel.Frame {
	return tunnel.Frame{Type: "error", ID: id, Code: code, Message: message}
}

func responseFrame(id string, status int, body any) tunnel.Frame {
	return tunnel.Frame{
		Type:    "response",
		ID:      id,
		Status:  status,
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    body,
	}
}

// simpleProfileNameRe matches legacy-compatible profile names whose env-key
// suffix needs no versioning.
var simpleProfileNameRe = regexp.MustCompile(`^[a-z0-9]+$`)

// controlEnvSuffix maps a profile name to a state-file variable suffix.
//
// Versioned scheme:
//   - Simple names ([a-z0-9]+): raw uppercase (CODER). Identical to the
//     legacy scheme, so existing configurations keep working. A profile
//     literally named v1coder encodes to V1CODER and round-trips.
//   - Names containing '-' or '_': "V1_" (a delimiter that cannot appear in
//     a legacy simple key) followed by lowercase hex of the UTF-8 bytes
//     (research-bot → V1_72657365617263682d626f74). The V1_ prefix cannot
//     collide with a simple name such as v1coder (V1CODER). Legacy raw keys
//     for separator names were ambiguous across writers and are REJECTED by
//     the decoder instead of silently misrouted.
func controlEnvSuffix(profile string) string {
	if simpleProfileNameRe.MatchString(profile) {
		return strings.ToUpper(profile)
	}
	return "V1_" + hex.EncodeToString([]byte(profile))
}

// ControlEnvSuffix is the exported form used by the CLI state-file reader so
// writer and reader can never drift apart.
func ControlEnvSuffix(profile string) string { return controlEnvSuffix(profile) }

// DecodeControlEnvSuffix inverts ControlEnvSuffix. Only "V1_" versioned
// payloads and raw uppercase simple names decode; ambiguous legacy raw
// separator keys are refused rather than guessed.
func DecodeControlEnvSuffix(suffix string) (string, bool) {
	if strings.HasPrefix(suffix, "V1_") {
		raw, err := hex.DecodeString(strings.ToLower(strings.TrimPrefix(suffix, "V1_")))
		if err != nil {
			return "", false
		}
		profile := string(raw)
		if _, err := ValidateProfileName(profile); err != nil {
			return "", false
		}
		return profile, true
	}
	lowered := strings.ToLower(suffix)
	if simpleProfileNameRe.MatchString(lowered) && strings.ToUpper(lowered) == suffix {
		if _, err := ValidateProfileName(lowered); err != nil {
			return "", false
		}
		return lowered, true
	}
	return "", false
}
