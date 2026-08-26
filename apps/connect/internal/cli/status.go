package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/brio/brio/apps/connect/internal/tunnel"
	"github.com/spf13/cobra"
)

func statusCommand() *cobra.Command {
	opts := defaultRunOptions()
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show service, relay, and tunnel credential status",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runStatus(cmd.Context(), opts)
		},
	}
	addRunFlags(cmd, &opts)
	return cmd
}

func runStatus(ctx context.Context, opts runOptions) error {
	opts.applyDefaults()
	statePath, _ := stateFilePath()
	fmt.Printf("State: %s\n", statePath)
	if opts.agentID != "" {
		fmt.Printf("Agent: %s\n", opts.agentID)
	}
	if opts.relayURL != "" {
		fmt.Printf("Relay URL: %s\n", opts.relayURL)
	}

	serviceState := ""
	if status, err := serviceStatus(); err != nil {
		fmt.Printf("Service: unknown (%v)\n", err)
	} else {
		serviceState = status
		fmt.Printf("Service: %s\n", status)
	}

	if opts.relayURL == "" {
		fmt.Println("Relay: not configured (run `brio setup`)")
		return nil
	}
	statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := checkRelayHealth(statusCtx, opts.relayURL); err != nil {
		fmt.Printf("Relay: unreachable (%v)\n", err)
		return nil
	}
	fmt.Println("Relay: reachable")

	if opts.agentID == "" || opts.relayToken == "" {
		fmt.Println("Tunnel: no stored credentials (run `brio setup` or `brio recover`)")
		return nil
	}
	// A companion probe authenticates by opening a real tunnel. The relay permits
	// one companion per agent, so probing while the service is active would
	// replace the production tunnel and cause a visible reconnect in Mobile.
	if !shouldProbeTunnel(serviceState) {
		fmt.Println("Tunnel: service active (credential probe skipped)")
		return nil
	}
	if err := tunnel.Probe(statusCtx, tunnel.Config{
		AgentID:    opts.agentID,
		RelayURL:   opts.relayURL,
		RelayToken: opts.relayToken,
	}); err != nil {
		fmt.Printf("Tunnel: credentials rejected (%v)\n", err)
		return nil
	}
	fmt.Println("Tunnel: credentials accepted")
	return nil
}

func shouldProbeTunnel(serviceState string) bool {
	return serviceState != "active"
}

func checkRelayHealth(ctx context.Context, relayURL string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, relayURL+"/health", nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var body struct {
		OK bool `json:"ok"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("relay health returned HTTP %d", resp.StatusCode)
	}
	if !body.OK {
		return fmt.Errorf("relay health reported ok=false")
	}
	return nil
}
