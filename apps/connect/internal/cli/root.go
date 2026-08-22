package cli

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/spf13/cobra"
)

// Execute runs the brio connector CLI.
func Execute() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	root := &cobra.Command{
		Use:   "brio",
		Short: "Brio connector for Hermes Agent",
		Long:  "Slim connector that enrolls with the Brio relay and keeps a tunnel to it, forwarding a small set of request paths to the stock Hermes API server.",
	}
	root.AddCommand(setupCommand())
	root.AddCommand(connectCommand())
	root.AddCommand(statusCommand())
	root.AddCommand(recoverCommand())
	root.AddCommand(installCommand())
	root.AddCommand(uninstallCommand())
	root.AddCommand(startCommand())
	root.AddCommand(stopCommand())
	root.AddCommand(restartCommand())
	if err := root.ExecuteContext(ctx); err != nil {
		slog.Error("command failed", "error", err)
		os.Exit(1)
	}
}

// runOptions carries the shared connector configuration. Values come from
// environment variables first, then the ~/.brio/connect.env state file, then
// built-in defaults.
type runOptions struct {
	relayURL     string
	relayToken   string
	agentID      string
	hermesURL    string
	hermesAPIKey string
	hermesHome   string
}

func defaultRunOptions() runOptions {
	return runOptions{
		relayURL:     configDefault("BRIO_RELAY_URL", ""),
		relayToken:   configDefault("BRIO_RELAY_TOKEN", ""),
		agentID:      configDefault("BRIO_AGENT_ID", ""),
		hermesURL:    configDefault("HERMES_API_BASE", "http://127.0.0.1:8642"),
		hermesAPIKey: configDefault("HERMES_API_KEY", ""),
		hermesHome:   configDefault("HERMES_HOME", ""),
	}
}

func addRunFlags(cmd *cobra.Command, opts *runOptions) {
	cmd.Flags().StringVar(&opts.relayURL, "relay-url", opts.relayURL, "Brio relay URL")
	cmd.Flags().StringVar(&opts.relayToken, "relay-token", opts.relayToken, "relay token for the enrolled agent")
	cmd.Flags().StringVar(&opts.agentID, "agent-id", opts.agentID, "enrolled agent id")
	cmd.Flags().StringVar(&opts.hermesURL, "hermes-url", opts.hermesURL, "Hermes API server base URL")
	cmd.Flags().StringVar(&opts.hermesAPIKey, "hermes-api-key", opts.hermesAPIKey, "Hermes API server bearer key (API_SERVER_KEY)")
	cmd.Flags().StringVar(&opts.hermesHome, "hermes-home", opts.hermesHome, "Hermes home directory")
}

func (o *runOptions) applyDefaults() {
	o.relayURL = strings.TrimRight(strings.TrimSpace(o.relayURL), "/")
	o.relayToken = strings.TrimSpace(o.relayToken)
	o.agentID = strings.TrimSpace(o.agentID)
	o.hermesURL = strings.TrimRight(strings.TrimSpace(o.hermesURL), "/")
	if o.hermesURL == "" {
		o.hermesURL = "http://127.0.0.1:8642"
	}
	o.hermesAPIKey = strings.TrimSpace(o.hermesAPIKey)
	o.hermesHome = strings.TrimSpace(o.hermesHome)
	if o.hermesHome == "" {
		o.hermesHome = defaultHermesHome()
	}
}

func configDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	if value := strings.TrimSpace(readState()[key]); value != "" {
		return value
	}
	return fallback
}

func randomToken(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func randomTokenMust(size int) string {
	token, err := randomToken(size)
	if err != nil {
		panic(err)
	}
	return token
}

// newAgentID returns a fresh agent id such as hermes_1a2b3c4d5.
func newAgentID() string {
	return "hermes_" + strings.ToLower(strings.ReplaceAll(randomTokenMust(9), "_", ""))
}

func defaultHermesHome() string {
	if home, err := os.UserHomeDir(); err == nil {
		return home + string(os.PathSeparator) + ".hermes"
	}
	return ".hermes"
}

func runCommand(name string, args ...string) error {
	output, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(output))
		if text == "" {
			return err
		}
		return fmt.Errorf("%s: %s", err, text)
	}
	return nil
}

func isTemporaryGoRunExecutable(path string) bool {
	return strings.Contains(filepath.ToSlash(path), "/go-build")
}
