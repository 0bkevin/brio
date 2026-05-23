package cli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/brio/brio/apps/companion/internal/tunnel"
	"github.com/spf13/cobra"
)

const serviceName = "app.brio.companion"

func companionCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "companion",
		Short: "Manage the Brio companion background service",
	}
	cmd.AddCommand(companionRunCommand())
	cmd.AddCommand(companionStartCommand())
	cmd.AddCommand(companionInstallCommand())
	cmd.AddCommand(companionUninstallCommand())
	cmd.AddCommand(companionStopCommand())
	cmd.AddCommand(companionRestartCommand())
	cmd.AddCommand(companionStatusCommand())
	cmd.AddCommand(companionPairCommand())
	return cmd
}

func companionRunCommand() *cobra.Command {
	opts := defaultCompanionRunOptions()
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Start the Brio companion in the foreground",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCompanion(cmd.Context(), opts, true)
		},
	}
	addCompanionRunFlags(cmd, &opts)
	return cmd
}

func companionStartCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "start",
		Short: "Start the installed Brio companion background service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := startService(); err != nil {
				return err
			}
			fmt.Println("Brio Companion service started.")
			return nil
		},
	}
}

func companionInstallCommand() *cobra.Command {
	opts := defaultCompanionRunOptions()
	startNow := true
	cmd := &cobra.Command{
		Use:   "install",
		Short: "Install Brio companion as a background service",
		RunE: func(cmd *cobra.Command, args []string) error {
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			if isTemporaryGoRunExecutable(exe) {
				return fmt.Errorf("cannot install a temporary go run binary; build or install brio first, then run `brio companion install` from that binary")
			}
			if opts.cfg.Token == "" {
				token, err := randomToken(32)
				if err != nil {
					return err
				}
				opts.cfg.Token = token
			}
			if opts.agentID == "" {
				opts.agentID = "agent_" + strings.ToLower(strings.ReplaceAll(randomTokenMust(9), "_", ""))
			}
			if opts.cfg.HermesBaseURL == "" {
				opts.cfg.HermesBaseURL = "http://127.0.0.1:8642"
			}
			if opts.cfg.HermesHome == "" {
				opts.cfg.HermesHome = defaultHermesHome()
			}
			if err := writeLocalConfig(configValuesFromOptions(opts)); err != nil {
				return err
			}
			if err := installService(exe, startNow); err != nil {
				return err
			}
			configPath, _ := localConfigPath()
			fmt.Println("Brio Companion service installed.")
			fmt.Printf("Config: %s\n", configPath)
			fmt.Println("Run `brio companion status` to check it.")
			fmt.Println("Run `brio companion pair` to connect a phone.")
			return nil
		},
	}
	addCompanionRunFlags(cmd, &opts)
	cmd.Flags().BoolVar(&startNow, "start", startNow, "start the service after installing")
	return cmd
}

func companionUninstallCommand() *cobra.Command {
	purge := false
	cmd := &cobra.Command{
		Use:   "uninstall",
		Short: "Remove the Brio companion background service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := uninstallService(); err != nil {
				return err
			}
			if purge {
				if dir, err := brioHomeDir(); err == nil {
					_ = os.RemoveAll(dir)
				}
			}
			fmt.Println("Brio Companion service removed.")
			return nil
		},
	}
	cmd.Flags().BoolVar(&purge, "purge", false, "also remove ~/.brio local config and pairing state")
	return cmd
}

func companionStopCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "stop",
		Short: "Stop the Brio companion background service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := stopService(); err != nil {
				return err
			}
			fmt.Println("Brio Companion service stopped.")
			return nil
		},
	}
}

func companionRestartCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "restart",
		Short: "Restart the Brio companion background service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := restartService(); err != nil {
				return err
			}
			fmt.Println("Brio Companion service restarted.")
			return nil
		},
	}
}

func companionStatusCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show Brio companion service and health status",
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, _ := localConfigPath()
			fmt.Printf("Config: %s\n", configPath)
			serviceStatus, err := serviceStatus()
			if err != nil {
				fmt.Printf("Service: unknown (%v)\n", err)
			} else {
				fmt.Printf("Service: %s\n", serviceStatus)
			}
			if err := printHealthStatus(); err != nil {
				fmt.Printf("Health: unavailable (%v)\n", err)
			}
			return nil
		},
	}
}

func companionPairCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "pair",
		Short: "Print the current mobile pairing payload",
		RunE: func(cmd *cobra.Command, args []string) error {
			state, err := readPairingState()
			if err != nil {
				payload, fallbackErr := pairingFromConfig()
				if fallbackErr != nil {
					return fmt.Errorf("no pairing payload is available; start Brio Companion first")
				}
				printPairingPayload(payload)
				return nil
			}
			printPairingPayload(state.Payload)
			if state.Payload.Transport == "relay" && time.Since(state.UpdatedAt) > 9*time.Minute {
				fmt.Fprintln(os.Stderr, "Warning: relay pairing codes expire after 10 minutes; run `brio companion restart` if the mobile app cannot claim this code.")
			}
			return nil
		},
	}
}

func pairingFromConfig() (tunnel.PairingPayload, error) {
	opts := defaultCompanionRunOptions()
	if opts.cfg.Token == "" {
		return tunnel.PairingPayload{}, fmt.Errorf("missing token")
	}
	if opts.relayURL != "" {
		return tunnel.PairingPayload{}, fmt.Errorf("relay pairing requires a running companion")
	}
	url := opts.publicURL
	if url == "" {
		url = publicURLFromAddr(opts.cfg.Addr)
	}
	return tunnel.PairingPayload{
		URL:       strings.TrimRight(url, "/"),
		Token:     opts.cfg.Token,
		Mode:      "direct",
		Transport: "direct",
	}, nil
}

func printPairingPayload(payload tunnel.PairingPayload) {
	if payload.Code != "" {
		fmt.Printf("Code: %s\n", payload.Code)
	}
	fmt.Println("Pairing payload:")
	fmt.Println(tunnel.PairingCode(payload))
}

func printHealthStatus() error {
	if len(readLocalConfig()) == 0 {
		if state, err := readPairingState(); err == nil {
			return printHealthForTarget(state.Payload.URL, state.Payload.Token)
		}
	}
	opts := defaultCompanionRunOptions()
	url := opts.publicURL
	if url == "" {
		url = publicURLFromAddr(opts.cfg.Addr)
	}
	return printHealthForTarget(url, opts.cfg.Token)
}

func printHealthForTarget(baseURL string, token string) error {
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(baseURL, "/")+"/health", nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var body struct {
		OK           bool `json:"ok"`
		HermesOK     bool `json:"hermes_ok"`
		HermesStatus int  `json:"hermes_status"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	fmt.Printf("Health: HTTP %d, companion_ok=%t, hermes_ok=%t", resp.StatusCode, body.OK, body.HermesOK)
	if body.HermesStatus != 0 {
		fmt.Printf(", hermes_status=%d", body.HermesStatus)
	}
	fmt.Println()
	return nil
}

func runCommand(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	output, err := cmd.CombinedOutput()
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
	clean := filepath.ToSlash(path)
	return strings.Contains(clean, "/go-build") || strings.Contains(clean, "/go-build/")
}
