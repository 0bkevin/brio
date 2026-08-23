package cli

import (
	"log/slog"
	"os"
	"strings"

	"github.com/brio/brio/apps/relay/internal/server"
	"github.com/spf13/cobra"
)

func Execute() {
	root := &cobra.Command{
		Use:   "brio-relay",
		Short: "Brio cloud relay",
	}
	root.AddCommand(serveCommand())
	if err := root.Execute(); err != nil {
		slog.Error("command failed", "error", err)
		os.Exit(1)
	}
}

func serveCommand() *cobra.Command {
	var cfg server.Config
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Start the relay service",
		RunE: func(cmd *cobra.Command, args []string) error {
			return server.Run(cmd.Context(), cfg)
		},
	}
	cmd.Flags().StringVar(&cfg.Addr, "addr", envDefault("BRIO_RELAY_ADDR", ":8080"), "HTTP bind address")
	cmd.Flags().StringVar(&cfg.DatabaseURL, "database-url", envDefault("BRIO_DATABASE_URL", ""), "Postgres database URL")
	cmd.Flags().StringSliceVar(&cfg.AllowedOrigins, "allowed-origin", envList("BRIO_RELAY_ALLOWED_ORIGINS"), "allowed browser origin for CORS and WebSocket upgrades; repeatable")
	cmd.Flags().StringVar(&cfg.DeviceRegistrationKey, "device-registration-key", envDefault("BRIO_DEVICE_REGISTRATION_KEY", ""), "optional key required to create relay device tokens")
	cmd.Flags().BoolVar(&cfg.InsecureDevMode, "insecure-dev-mode", envBool("BRIO_INSECURE_DEV_MODE"), "enable unverified email sign-in and unrestricted browser origins for local development")
	return cmd
}

func envDefault(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
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

func envBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
