package cli

import (
	"log/slog"
	"os"
	"strconv"
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
	cmd.Flags().StringVar(&cfg.RelayIssuer, "issuer", envDefault("BRIO_RELAY_ISSUER", ""), "public relay issuer URL")
	cmd.Flags().StringVar(&cfg.SigningPrivateKey, "signing-key", envDefault("BRIO_RELAY_SIGNING_KEY", ""), "PEM-encoded P-256 relay signing key")
	cmd.Flags().StringVar(&cfg.CloudflareAccountID, "cloudflare-account-id", envDefault("BRIO_CLOUDFLARE_ACCOUNT_ID", ""), "Cloudflare account id for managed endpoints")
	cmd.Flags().StringVar(&cfg.CloudflareAPIToken, "cloudflare-api-token", envDefault("BRIO_CLOUDFLARE_API_TOKEN", ""), "Cloudflare API token for managed endpoints")
	cmd.Flags().StringVar(&cfg.CloudflareZoneID, "cloudflare-zone-id", envDefault("BRIO_CLOUDFLARE_ZONE_ID", ""), "Cloudflare DNS zone id for managed endpoints")
	cmd.Flags().StringVar(&cfg.TunnelBaseDomain, "tunnel-base-domain", envDefault("BRIO_TUNNEL_BASE_DOMAIN", ""), "base domain for managed environment endpoints")
	cmd.Flags().IntVar(&cfg.ManagedTunnelLimit, "managed-tunnel-limit", envIntDefault("BRIO_MANAGED_TUNNEL_LIMIT", 3), "maximum managed endpoints per user")
	return cmd
}

func envIntDefault(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDefault(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
