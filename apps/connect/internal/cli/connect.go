package cli

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

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
	if opts.controlToken == "" {
		opts.controlToken = readHermesControlToken(opts.hermesHome)
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
		BaseURL:          opts.hermesURL,
		APIKey:           opts.hermesAPIKey,
		Home:             opts.hermesHome,
		ControlBaseURL:   opts.controlURL,
		ControlToken:     opts.controlToken,
		ControlOverrides: profileControlOverrides(),
	}
	defer client.Close()
	slog.Info("brio connector starting",
		"relay_url", opts.relayURL,
		"agent_id", opts.agentID,
		"hermes_api", opts.hermesURL,
		"hermes_home", opts.hermesHome,
		"hermes_control", opts.controlURL,
	)
	return tunnel.Run(ctx, tunnel.Config{
		AgentID:    opts.agentID,
		RelayURL:   opts.relayURL,
		RelayToken: opts.relayToken,
		Handler:    client.Serve,
	})
}

// profileControlOverrides reads optional per-profile control planes from the
// state file. Keys use the versioned suffix encoding shared with the hermes
// package: HERMES_CONTROL_BASE_<ENCODED PROFILE> plus
// HERMES_CONTROL_TOKEN_<ENCODED PROFILE>. Simple [a-z0-9]+ names keep the
// legacy raw uppercase key (HERMES_CONTROL_BASE_CODER); names containing
// separators use V1_ plus lowercase hex (research-bot →
// HERMES_CONTROL_BASE_V1_72657365617263682d626f74). Ambiguous legacy raw
// separator keys such as RESEARCH_BOT or RESEARCH_HBOT are rejected, never
// silently misrouted.
func profileControlOverrides() map[string]hermes.ControlEndpoint {
	const basePrefix = "HERMES_CONTROL_BASE_"
	const tokenPrefix = "HERMES_CONTROL_TOKEN_"
	state := readState()
	overrides := map[string]hermes.ControlEndpoint{}
	for key, value := range state {
		value = strings.TrimSpace(value)
		if value == "" || !strings.HasPrefix(key, basePrefix) {
			continue
		}
		suffix := strings.TrimPrefix(key, basePrefix)
		if suffix == "" {
			continue
		}
		profile, ok := hermes.DecodeControlEnvSuffix(suffix)
		if !ok || profile == hermes.DefaultProfileName {
			continue
		}
		endpoint := overrides[profile]
		endpoint.BaseURL = value
		endpoint.Token = strings.TrimSpace(state[tokenPrefix+suffix])
		overrides[profile] = endpoint
	}
	if len(overrides) == 0 {
		return nil
	}
	return overrides
}
