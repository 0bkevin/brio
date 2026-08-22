//go:build !darwin && !linux && !windows

package cli

import (
	"fmt"
	"runtime"
)

func installService(exe string, startNow bool) error {
	return fmt.Errorf("background service install is not supported on %s", runtime.GOOS)
}

func stopService() error {
	return fmt.Errorf("background service stop is not supported on %s", runtime.GOOS)
}

func startService() error {
	return fmt.Errorf("background service start is not supported on %s", runtime.GOOS)
}

func restartService() error {
	return fmt.Errorf("background service restart is not supported on %s", runtime.GOOS)
}

func uninstallService() error {
	return fmt.Errorf("background service uninstall is not supported on %s", runtime.GOOS)
}

func serviceStatus() (string, error) {
	return "", fmt.Errorf("background service status is not supported on %s", runtime.GOOS)
}
