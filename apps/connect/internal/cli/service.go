package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// serviceName identifies the user-level background service that runs
// `brio connect`.
const serviceName = "app.brio.connect"

func installCommand() *cobra.Command {
	startNow := true
	cmd := &cobra.Command{
		Use:   "install",
		Short: "Install the brio background service",
		RunE: func(cmd *cobra.Command, args []string) error {
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			if isTemporaryGoRunExecutable(exe) {
				return fmt.Errorf("cannot install a temporary go run binary; build or install brio first, then run `brio install` from that binary")
			}
			if err := installService(exe, startNow); err != nil {
				return err
			}
			fmt.Println("Brio service installed.")
			fmt.Println("Run `brio status` to check it.")
			return nil
		},
	}
	cmd.Flags().BoolVar(&startNow, "start", startNow, "start the service after installing")
	return cmd
}

func uninstallCommand() *cobra.Command {
	purge := false
	cmd := &cobra.Command{
		Use:   "uninstall",
		Short: "Remove the brio background service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := uninstallService(); err != nil {
				return err
			}
			if purge {
				if dir, err := brioHomeDir(); err == nil {
					_ = os.RemoveAll(dir)
				}
			}
			fmt.Println("Brio service removed.")
			return nil
		},
	}
	cmd.Flags().BoolVar(&purge, "purge", false, "also remove the ~/.brio connector state")
	return cmd
}

func startCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "start",
		Short: "Start the installed brio background service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := startService(); err != nil {
				return err
			}
			fmt.Println("Brio service started.")
			return nil
		},
	}
}

func stopCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "stop",
		Short: "Stop the installed brio background service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := stopService(); err != nil {
				return err
			}
			fmt.Println("Brio service stopped.")
			return nil
		},
	}
}

func restartCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "restart",
		Short: "Restart the installed brio background service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := restartService(); err != nil {
				return err
			}
			fmt.Println("Brio service restarted.")
			return nil
		},
	}
}
