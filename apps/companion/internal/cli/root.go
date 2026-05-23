package cli

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/brio/brio/apps/companion/internal/server"
	"github.com/brio/brio/apps/companion/internal/tunnel"
	"github.com/spf13/cobra"
)

func Execute() {
	root := &cobra.Command{
		Use:   "brio",
		Short: "Brio companion for Hermes Agent",
	}
	root.AddCommand(connectCommand())
	root.AddCommand(companionCommand())
	if err := root.Execute(); err != nil {
		slog.Error("command failed", "error", err)
		os.Exit(1)
	}
}

type companionRunOptions struct {
	cfg       server.Config
	publicURL string
	relayURL  string
	agentID   string
}

func defaultCompanionRunOptions() companionRunOptions {
	return companionRunOptions{
		cfg: server.Config{
			Addr:          configDefault("BRIO_ADDR", "127.0.0.1:8787"),
			Token:         configDefault("BRIO_TOKEN", ""),
			HermesBaseURL: configDefault("HERMES_API_BASE", "http://127.0.0.1:8642"),
			HermesAPIKey:  configDefault("HERMES_API_KEY", ""),
			HermesHome:    configDefault("HERMES_HOME", ""),
			AllowedRoots:  configList("BRIO_ALLOWED_ROOTS"),
		},
		publicURL: configDefault("BRIO_PUBLIC_URL", ""),
		relayURL:  configDefault("BRIO_RELAY_URL", ""),
		agentID:   configDefault("BRIO_AGENT_ID", ""),
	}
}

func connectCommand() *cobra.Command {
	opts := defaultCompanionRunOptions()
	cmd := &cobra.Command{
		Use:   "connect",
		Short: "Start the Brio companion server and print pairing details",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCompanion(cmd.Context(), opts, true)
		},
	}
	addCompanionRunFlags(cmd, &opts)
	return cmd
}

func addCompanionRunFlags(cmd *cobra.Command, opts *companionRunOptions) {
	cmd.Flags().StringVar(&opts.cfg.Addr, "addr", opts.cfg.Addr, "HTTP bind address")
	cmd.Flags().StringVar(&opts.publicURL, "public-url", opts.publicURL, "URL the mobile app should use")
	cmd.Flags().StringVar(&opts.cfg.Token, "token", opts.cfg.Token, "Bearer token for mobile requests")
	cmd.Flags().StringVar(&opts.cfg.HermesBaseURL, "hermes-url", opts.cfg.HermesBaseURL, "Hermes API server base URL")
	cmd.Flags().StringVar(&opts.cfg.HermesAPIKey, "hermes-api-key", opts.cfg.HermesAPIKey, "Hermes API server bearer key")
	cmd.Flags().StringVar(&opts.cfg.HermesHome, "hermes-home", opts.cfg.HermesHome, "Hermes home directory")
	cmd.Flags().StringSliceVar(&opts.cfg.AllowedRoots, "allowed-root", opts.cfg.AllowedRoots, "allowed file root; repeatable")
	cmd.Flags().StringVar(&opts.relayURL, "relay-url", opts.relayURL, "Brio relay URL for remote access")
	cmd.Flags().StringVar(&opts.agentID, "agent-id", opts.agentID, "stable agent identifier for relay mode")
}

func runCompanion(ctx context.Context, opts companionRunOptions, print bool) error {
	if opts.cfg.Token == "" {
		token, err := randomToken(32)
		if err != nil {
			return err
		}
		opts.cfg.Token = token
	}
	if opts.cfg.HermesBaseURL == "" {
		opts.cfg.HermesBaseURL = "http://127.0.0.1:8642"
	}
	if opts.cfg.HermesHome == "" {
		opts.cfg.HermesHome = defaultHermesHome()
	}
	if opts.publicURL == "" {
		opts.publicURL = publicURLFromAddr(opts.cfg.Addr)
	}
	if opts.agentID == "" {
		opts.agentID = "agent_" + strings.ToLower(strings.ReplaceAll(randomTokenMust(9), "_", ""))
	}

	localURL := strings.TrimRight(opts.publicURL, "/")
	payload := tunnel.PairingPayload{
		URL:       localURL,
		Token:     opts.cfg.Token,
		Mode:      "direct",
		Transport: "direct",
	}
	if opts.relayURL != "" {
		relayCfg := tunnel.Config{
			AgentID:      opts.agentID,
			RelayURL:     strings.TrimRight(opts.relayURL, "/"),
			LocalBaseURL: localURL,
			Token:        opts.cfg.Token,
		}
		code, relayToken, err := tunnel.RegisterPairing(ctx, relayCfg)
		if err != nil {
			return err
		}
		relayCfg.RelayToken = relayToken
		tunnel.Run(ctx, relayCfg)
		payload = tunnel.PairingPayload{
			URL:       strings.TrimRight(opts.relayURL, "/"),
			Token:     opts.cfg.Token,
			Mode:      "relay",
			Transport: "relay",
			AgentID:   opts.agentID,
			Code:      code,
		}
	}
	if err := writePairingState(payload); err != nil {
		slog.Warn("could not write pairing state", "error", err)
	}
	if print {
		printPairing(payload)
	}
	return server.Run(ctx, opts.cfg)
}

func printPairing(payload tunnel.PairingPayload) {
	fmt.Println()
	fmt.Println("Brio companion is starting.")
	fmt.Printf("  URL:   %s\n", payload.URL)
	fmt.Printf("  Token: %s\n", payload.Token)
	if payload.AgentID != "" {
		fmt.Printf("  Agent: %s\n", payload.AgentID)
	}
	if payload.Code != "" {
		fmt.Printf("  Code:  %s\n", payload.Code)
	}
	fmt.Println()
	fmt.Println("Pairing payload:")
	fmt.Println(tunnel.PairingCode(payload))
	fmt.Println()
}

func configDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	if value := strings.TrimSpace(readLocalConfig()[key]); value != "" {
		return value
	}
	return fallback
}

func configList(key string) []string {
	raw := strings.TrimSpace(configDefault(key, ""))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			out = append(out, value)
		}
	}
	return out
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

func defaultHermesHome() string {
	if home, err := os.UserHomeDir(); err == nil {
		return home + string(os.PathSeparator) + ".hermes"
	}
	return ".hermes"
}

func publicURLFromAddr(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://" + addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	u := url.URL{Scheme: "http", Host: net.JoinHostPort(host, port)}
	return u.String()
}
