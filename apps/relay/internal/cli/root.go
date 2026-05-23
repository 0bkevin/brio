package cli

import (
	"log/slog"
	"os"

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
	return cmd
}

func envDefault(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
