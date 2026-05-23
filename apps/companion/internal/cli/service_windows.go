package cli

import (
	"os/exec"
	"strings"
)

func installService(exe string, startNow bool) error {
	task := "Brio Companion"
	command := `"` + exe + `" connect`
	if err := runCommand("schtasks", "/Create", "/TN", task, "/SC", "ONLOGON", "/TR", command, "/F"); err != nil {
		return err
	}
	if startNow {
		return runCommand("schtasks", "/Run", "/TN", task)
	}
	return nil
}

func stopService() error {
	_ = runCommand("schtasks", "/End", "/TN", "Brio Companion")
	return nil
}

func startService() error {
	return runCommand("schtasks", "/Run", "/TN", "Brio Companion")
}

func restartService() error {
	_ = stopService()
	return startService()
}

func uninstallService() error {
	output, err := exec.Command("schtasks", "/Delete", "/TN", "Brio Companion", "/F").CombinedOutput()
	if err != nil && !strings.Contains(string(output), "cannot find") {
		return err
	}
	return nil
}

func serviceStatus() (string, error) {
	if err := runCommand("schtasks", "/Query", "/TN", "Brio Companion"); err != nil {
		return "not installed", nil
	}
	return "installed", nil
}
