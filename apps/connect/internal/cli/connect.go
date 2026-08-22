package cli

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/brio/brio/apps/connect/internal/hermes"
	"github.com/brio/brio/apps/connect/internal/tunnel"
	"github.com/spf13/cobra"
)

func connectCommand() *cobra.Command {
	opts := defaultRunOptions()
	cmd := &cobra.Command{
		Use:   "connect",
		Short: "Run the relay tunnel in the foreground",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runConnect(cmd.Context(), opts)
		},
	}
	addRunFlags(cmd, &opts)
	return cmd
}

func runConnect(ctx context.Context, opts runOptions) error {
	opts.applyDefaults()
	if opts.hermesAPIKey == "" {
		// Fall back to the key written into the Hermes .env by setup.
		opts.hermesAPIKey = readHermesAPIKey(opts.hermesHome)
	}
	if opts.relayURL == "" {
		return fmt.Errorf("relay URL is required; run `brio setup` first or pass --relay-url")
	}
	if opts.agentID == "" {
		return fmt.Errorf("agent id is required; run `brio setup` first or pass --agent-id")
	}
	if opts.relayToken == "" {
		return fmt.Errorf("relay token is required; run `brio setup` or `brio recover` first")
	}
	client := &hermes.Client{
		BaseURL: opts.hermesURL,
		APIKey:  opts.hermesAPIKey,
		Home:    opts.hermesHome,
	}
	slog.Info("brio connector starting",
		"relay_url", opts.relayURL,
		"agent_id", opts.agentID,
		"hermes_api", opts.hermesURL,
		"hermes_home", opts.hermesHome,
	)
	return tunnel.Run(ctx, tunnel.Config{
		AgentID:    opts.agentID,
		RelayURL:   opts.relayURL,
		RelayToken: opts.relayToken,
		Handler:    client.Serve,
	})
}
