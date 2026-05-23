package cli

import (
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
	if err := root.Execute(); err != nil {
		slog.Error("command failed", "error", err)
		os.Exit(1)
	}
}

func connectCommand() *cobra.Command {
	var cfg server.Config
	var publicURL string
	var relayURL string
	var agentID string

	cmd := &cobra.Command{
		Use:   "connect",
		Short: "Start the Brio companion server and print pairing details",
		RunE: func(cmd *cobra.Command, args []string) error {
			if cfg.Token == "" {
				token, err := randomToken(32)
				if err != nil {
					return err
				}
				cfg.Token = token
			}
			if cfg.HermesBaseURL == "" {
				cfg.HermesBaseURL = "http://127.0.0.1:8642"
			}
			if cfg.HermesHome == "" {
				cfg.HermesHome = defaultHermesHome()
			}
			if publicURL == "" {
				publicURL = publicURLFromAddr(cfg.Addr)
			}
			if agentID == "" {
				agentID = "agent_" + strings.ToLower(strings.ReplaceAll(randomTokenMust(9), "_", ""))
			}

			localURL := strings.TrimRight(publicURL, "/")
			payload := tunnel.PairingPayload{
				URL:       localURL,
				Token:     cfg.Token,
				Mode:      "direct",
				Transport: "direct",
			}
			if relayURL != "" {
				relayCfg := tunnel.Config{
					AgentID:      agentID,
					RelayURL:     strings.TrimRight(relayURL, "/"),
					LocalBaseURL: localURL,
					Token:        cfg.Token,
				}
				code, relayToken, err := tunnel.RegisterPairing(cmd.Context(), relayCfg)
				if err != nil {
					return err
				}
				relayCfg.RelayToken = relayToken
				tunnel.Run(cmd.Context(), relayCfg)
				payload = tunnel.PairingPayload{
					URL:       strings.TrimRight(relayURL, "/"),
					Token:     cfg.Token,
					Mode:      "relay",
					Transport: "relay",
					AgentID:   agentID,
					Code:      code,
				}
			}
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

			return server.Run(cmd.Context(), cfg)
		},
	}

	cmd.Flags().StringVar(&cfg.Addr, "addr", envDefault("BRIO_ADDR", "127.0.0.1:8787"), "HTTP bind address")
	cmd.Flags().StringVar(&publicURL, "public-url", envDefault("BRIO_PUBLIC_URL", ""), "URL the mobile app should use")
	cmd.Flags().StringVar(&cfg.Token, "token", envDefault("BRIO_TOKEN", ""), "Bearer token for mobile requests")
	cmd.Flags().StringVar(&cfg.HermesBaseURL, "hermes-url", envDefault("HERMES_API_BASE", "http://127.0.0.1:8642"), "Hermes API server base URL")
	cmd.Flags().StringVar(&cfg.HermesAPIKey, "hermes-api-key", envDefault("HERMES_API_KEY", ""), "Hermes API server bearer key")
	cmd.Flags().StringVar(&cfg.HermesHome, "hermes-home", envDefault("HERMES_HOME", ""), "Hermes home directory")
	cmd.Flags().StringSliceVar(&cfg.AllowedRoots, "allowed-root", envList("BRIO_ALLOWED_ROOTS"), "allowed file root; repeatable")
	cmd.Flags().StringVar(&relayURL, "relay-url", envDefault("BRIO_RELAY_URL", ""), "Brio relay URL for remote access")
	cmd.Flags().StringVar(&agentID, "agent-id", envDefault("BRIO_AGENT_ID", ""), "stable agent identifier for relay mode")
	return cmd
}

func envDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envList(key string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
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
