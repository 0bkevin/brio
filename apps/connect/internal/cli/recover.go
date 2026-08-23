package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/brio/brio/apps/connect/internal/tunnel"
	"github.com/spf13/cobra"
)

type recoveryResult struct {
	Code       string `json:"code"`
	AgentToken string `json:"agent_token"`
	AgentID    string `json:"agent_id"`
	Name       string `json:"name"`
}

const maxRecoveryResponseBytes = 64 * 1024

func recoverCommand() *cobra.Command {
	opts := defaultRunOptions()
	deviceToken := ""
	restart := false
	cmd := &cobra.Command{
		Use:   "recover",
		Short: "Recover relay credentials for an owned agent",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRecover(cmd.Context(), opts, deviceToken, restart)
		},
	}
	addRunFlags(cmd, &opts)
	cmd.Flags().StringVar(&deviceToken, "device-token", deviceToken, "owner device token from the relay")
	cmd.Flags().BoolVar(&restart, "restart", restart, "restart the installed brio service after recovery")
	return cmd
}

func runRecover(ctx context.Context, opts runOptions, deviceToken string, restart bool) error {
	opts.applyDefaults()
	deviceToken = strings.TrimSpace(deviceToken)
	if opts.relayURL == "" {
		return fmt.Errorf("relay URL is required")
	}
	if opts.agentID == "" {
		return fmt.Errorf("agent id is required")
	}
	if deviceToken == "" {
		return fmt.Errorf("owner device token is required")
	}

	result, err := recoverRelayAgent(ctx, opts.relayURL, deviceToken, opts.agentID)
	if err != nil {
		return err
	}
	opts.relayToken = result.AgentToken
	if err := writeState(stateValuesFromOptions(opts)); err != nil {
		return fmt.Errorf("could not write Brio connector state: %w", err)
	}

	fmt.Println("Relay credentials recovered.")
	fmt.Printf("Agent: %s\n", opts.agentID)

	if restart {
		if err := restartService(); err != nil {
			fmt.Println("Saved recovery token locally, but the service restart failed.")
			return err
		}
		fmt.Println("Brio service restarted.")
	}
	return nil
}

func recoverRelayAgent(ctx context.Context, relayURL string, deviceToken string, agentID string) (recoveryResult, error) {
	endpoint, err := tunnel.RelayAPIURL(relayURL, "/agents/"+agentID+"/recover")
	if err != nil {
		return recoveryResult{}, err
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		strings.NewReader("{}"),
	)
	if err != nil {
		return recoveryResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(deviceToken))
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}).Do(req)
	if err != nil {
		return recoveryResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, maxRecoveryResponseBytes))
		return recoveryResult{}, fmt.Errorf("relay recovery failed: %s", strings.TrimSpace(string(data)))
	}
	var result recoveryResult
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxRecoveryResponseBytes)).Decode(&result); err != nil {
		return recoveryResult{}, err
	}
	if result.AgentToken == "" {
		return recoveryResult{}, fmt.Errorf("relay recovery response is incomplete")
	}
	return result, nil
}
