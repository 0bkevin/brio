//go:build windows

package cli

import (
	"os/exec"
	"strings"
)

const windowsTaskName = "Brio Connect"

func installService(exe string, startNow bool) error {
	// schtasks has no working-directory option, so the task shell cds into
	// the user profile before running the connector.
	command := `cmd /c cd /d "%USERPROFILE%" && "` + exe + `" connect`
	if err := runCommand("schtasks", "/Create", "/TN", windowsTaskName, "/SC", "ONLOGON", "/TR", command, "/F"); err != nil {
		return err
	}
	if startNow {
		return runCommand("schtasks", "/Run", "/TN", windowsTaskName)
	}
	return nil
}

func stopService() error {
	_ = runCommand("schtasks", "/End", "/TN", windowsTaskName)
	return nil
}

func startService() error {
	return runCommand("schtasks", "/Run", "/TN", windowsTaskName)
}

func restartService() error {
	_ = stopService()
	return startService()
}

func uninstallService() error {
	output, err := exec.Command("schtasks", "/Delete", "/TN", windowsTaskName, "/F").CombinedOutput()
	if err != nil && !strings.Contains(string(output), "cannot find") {
		return err
	}
	return nil
}

func serviceStatus() (string, error) {
	if err := runCommand("schtasks", "/Query", "/TN", windowsTaskName); err != nil {
		return "not installed", nil
	}
	return "installed", nil
}
