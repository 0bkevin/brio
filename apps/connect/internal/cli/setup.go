package cli

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/brio/brio/apps/connect/internal/tunnel"
	"github.com/spf13/cobra"
)

const (
	setupErrHermesConfigWrite = "HERMES_CONFIG_WRITE_FAILED"
	setupErrHermesAPIDown     = "HERMES_API_UNREACHABLE"
	setupErrEnrollmentExpired = "ENROLLMENT_EXPIRED"
	setupErrRelayUnreachable  = "RELAY_UNREACHABLE"
	setupErrServiceInstall    = "SERVICE_INSTALL_FAILED"
	setupErrServiceStart      = "SERVICE_START_FAILED"
)

type setupOptions struct {
	runOptions runOptions
	code       string
	name       string
	install    bool
	start      bool
}

type envAssignment struct {
	Key   string
	Value string
}

func setupCommand() *cobra.Command {
	opts := setupOptions{
		runOptions: defaultRunOptions(),
		name:       "Hermes",
		install:    true,
		start:      true,
	}
	cmd := &cobra.Command{
		Use:   "setup",
		Short: "Configure the Hermes API server, enroll with the relay, and install the service",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSetup(cmd.Context(), opts)
		},
	}
	addRunFlags(cmd, &opts.runOptions)
	cmd.Flags().StringVar(&opts.code, "code", opts.code, "enrollment code from the Brio app")
	cmd.Flags().StringVar(&opts.name, "name", opts.name, "agent display name")
	cmd.Flags().BoolVar(&opts.install, "install", opts.install, "install the brio background service")
	cmd.Flags().BoolVar(&opts.start, "start", opts.start, "start the brio background service after setup")
	return cmd
}

func runSetup(ctx context.Context, setup setupOptions) error {
	opts := setup.runOptions
	opts.applyDefaults()
	setup.code = strings.ToUpper(strings.TrimSpace(setup.code))
	setup.name = strings.TrimSpace(setup.name)
	if setup.name == "" {
		setup.name = "Hermes"
	}
	if opts.relayURL == "" {
		return setupFailure(setupErrRelayUnreachable, "relay URL is required", nil)
	}
	if setup.code == "" {
		return setupFailure(setupErrEnrollmentExpired, "enrollment code is required", nil)
	}
	if opts.agentID == "" {
		opts.agentID = newAgentID()
	}

	// 1. Ensure the Hermes API server is enabled in ~/.hermes/.env without
	// disturbing unrelated keys or an existing API_SERVER_KEY.
	apiKey, err := ensureHermesAPIConfig(opts.hermesHome, opts.hermesURL, opts.hermesAPIKey)
	if err != nil {
		return setupFailure(setupErrHermesConfigWrite, "could not write Hermes API configuration", err)
	}
	opts.hermesAPIKey = apiKey

	// 2. Claim the enrollment code.
	result, err := tunnel.ClaimEnrollment(ctx, opts.relayURL, setup.code, opts.agentID, setup.name)
	if err != nil {
		return classifyEnrollmentError(err)
	}
	opts.agentID = result.Agent.ID
	opts.relayToken = result.Token
	if result.Agent.Name != "" {
		setup.name = result.Agent.Name
	}

	// 3. Persist connector state.
	if err := writeState(stateValuesFromOptions(opts)); err != nil {
		return setupFailure(setupErrHermesConfigWrite, "could not write Brio connector state", err)
	}

	// The API server only reads ~/.hermes/.env at startup, so a running
	// Hermes may still need a restart before it is reachable.
	hermesOK := true
	warnings := []string{}
	if err := checkHermesHealth(ctx, opts.hermesURL, opts.hermesAPIKey); err != nil {
		hermesOK = false
		warnings = append(warnings, fmt.Sprintf("%s: %v", setupErrHermesAPIDown, err))
	}

	// 4. Install and start the background service.
	serviceState := "skipped"
	state, err := setupService(setup.install, setup.start)
	if err != nil {
		return err
	}
	serviceState = state

	printSetupSummary(setup.name, opts.agentID, serviceState, hermesOK, warnings)
	return nil
}

func setupService(install bool, start bool) (string, error) {
	if install {
		exe, err := os.Executable()
		if err != nil {
			return "", setupFailure(setupErrServiceInstall, "could not resolve the brio executable", err)
		}
		if isTemporaryGoRunExecutable(exe) {
			return "", setupFailure(setupErrServiceInstall, "cannot install a temporary go run binary; install the released brio binary first", nil)
		}
		if err := installService(exe, start); err != nil {
			return "", setupFailure(setupErrServiceInstall, "could not install the brio service", err)
		}
		if status, err := serviceStatus(); err == nil && status != "" {
			return status, nil
		}
		if start {
			return "started", nil
		}
		return "installed", nil
	}
	if start {
		if err := restartService(); err != nil {
			return "", setupFailure(setupErrServiceStart, "could not start the brio service", err)
		}
		if status, err := serviceStatus(); err == nil && status != "" {
			return status, nil
		}
		return "started", nil
	}
	return "not installed", nil
}

// ensureHermesAPIConfig merges API_SERVER_* keys into the Hermes .env file,
// preserving unrelated keys and any existing API_SERVER_KEY. It returns the
// effective API key.
func ensureHermesAPIConfig(hermesHome string, hermesURL string, explicitKey string) (string, error) {
	if hermesHome == "" {
		hermesHome = defaultHermesHome()
	}
	host, port, err := hermesHostPort(hermesURL)
	if err != nil {
		return "", err
	}
	path := filepath.Join(hermesHome, ".env")
	values, err := readDotEnvValues(path)
	if err != nil {
		return "", err
	}
	apiKey := strings.TrimSpace(explicitKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(values["API_SERVER_KEY"])
	}
	if apiKey == "" {
		apiKey = randomTokenMust(32)
	}
	assignments := []envAssignment{
		{Key: "API_SERVER_ENABLED", Value: "true"},
		{Key: "API_SERVER_HOST", Value: host},
		{Key: "API_SERVER_PORT", Value: port},
		{Key: "API_SERVER_KEY", Value: apiKey},
	}
	if err := updateDotEnvFile(path, assignments); err != nil {
		return "", err
	}
	return apiKey, nil
}

// readHermesAPIKey reads API_SERVER_KEY from the Hermes .env file.
func readHermesAPIKey(hermesHome string) string {
	if hermesHome == "" {
		hermesHome = defaultHermesHome()
	}
	values, err := readDotEnvValues(filepath.Join(hermesHome, ".env"))
	if err != nil {
		return ""
	}
	return values["API_SERVER_KEY"]
}

func hermesHostPort(baseURL string) (string, string, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", "", err
	}
	host := parsed.Hostname()
	if host == "" {
		return "", "", fmt.Errorf("Hermes API URL is missing a host")
	}
	port := parsed.Port()
	if port == "" {
		switch parsed.Scheme {
		case "https":
			port = "443"
		default:
			port = "80"
		}
	}
	return host, port, nil
}

func readDotEnvValues(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := parseDotEnvLine(line)
		if ok {
			values[key] = value
		}
	}
	return values, nil
}

// updateDotEnvFile rewrites the listed keys in place and appends the ones
// that are missing, leaving every other line (comments included) untouched.
func updateDotEnvFile(path string, assignments []envAssignment) error {
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	assignmentByKey := map[string]string{}
	for _, assignment := range assignments {
		assignmentByKey[assignment.Key] = assignment.Value
	}

	lines := []string{}
	if len(data) > 0 {
		lines = strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	}
	seen := map[string]bool{}
	for index, line := range lines {
		key, _, ok := parseDotEnvLine(line)
		if !ok {
			continue
		}
		value, shouldUpdate := assignmentByKey[key]
		if !shouldUpdate {
			continue
		}
		lines[index] = key + "=" + value
		seen[key] = true
	}
	for _, assignment := range assignments {
		if !seen[assignment.Key] {
			lines = append(lines, assignment.Key+"="+assignment.Value)
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return writePrivateFile(path, []byte(strings.Join(lines, "\n")+"\n"))
}

func parseDotEnvLine(line string) (string, string, bool) {
	trimmed := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return "", "", false
	}
	key, value, ok := strings.Cut(trimmed, "=")
	if !ok {
		return "", "", false
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return "", "", false
	}
	value = strings.TrimSpace(value)
	value = strings.Trim(value, `"'`)
	return key, value, true
}

func checkHermesHealth(ctx context.Context, baseURL string, apiKey string) error {
	healthCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(healthCtx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/health", nil)
	if err != nil {
		return err
	}
	if strings.TrimSpace(apiKey) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	}
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Hermes API returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func classifyEnrollmentError(err error) error {
	message := err.Error()
	lower := strings.ToLower(message)
	if strings.Contains(lower, "expired") || strings.Contains(lower, "used") || strings.Contains(lower, "not found") {
		return setupFailure(setupErrEnrollmentExpired, "enrollment code is expired, used, or invalid", err)
	}
	if strings.Contains(lower, "connection refused") || strings.Contains(lower, "no such host") || strings.Contains(lower, "timeout") {
		return setupFailure(setupErrRelayUnreachable, "could not reach relay", err)
	}
	return setupFailure(setupErrEnrollmentExpired, "could not claim enrollment code", err)
}

func setupFailure(code string, message string, err error) error {
	if err != nil {
		return fmt.Errorf("%s: %s: %w", code, message, err)
	}
	return fmt.Errorf("%s: %s", code, message)
}

func printSetupSummary(name string, agentID string, serviceState string, hermesOK bool, warnings []string) {
	if hermesOK {
		fmt.Println("Brio setup complete.")
	} else {
		fmt.Println("Brio setup completed, but the Hermes API server is not reachable.")
	}
	fmt.Printf("Agent: %s\n", name)
	fmt.Printf("Agent ID: %s\n", agentID)
	fmt.Printf("Brio service: %s\n", serviceState)
	fmt.Println("Relay: enrolled")
	if hermesOK {
		fmt.Println("Hermes API: reachable")
	} else {
		fmt.Println("Hermes API: not reachable")
		fmt.Println("Restart Hermes so it picks up the API server settings in ~/.hermes/.env, then run: brio status")
	}
	for _, warning := range warnings {
		fmt.Printf("Warning: %s\n", warning)
	}
}
