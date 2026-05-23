package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func systemdUserServicePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "systemd", "user", serviceName+".service"), nil
}

func installService(exe string, startNow bool) error {
	path, err := systemdUserServicePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	unit := fmt.Sprintf(`[Unit]
Description=Brio Companion
After=network-online.target

[Service]
Type=simple
ExecStart=%s connect
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`, systemdQuote(exe))
	if err := os.WriteFile(path, []byte(unit), 0o644); err != nil {
		return err
	}
	if err := runCommand("systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	if startNow {
		return runCommand("systemctl", "--user", "enable", "--now", serviceName+".service")
	}
	return runCommand("systemctl", "--user", "enable", serviceName+".service")
}

func stopService() error {
	return runCommand("systemctl", "--user", "stop", serviceName+".service")
}

func startService() error {
	return runCommand("systemctl", "--user", "start", serviceName+".service")
}

func restartService() error {
	return runCommand("systemctl", "--user", "restart", serviceName+".service")
}

func uninstallService() error {
	path, err := systemdUserServicePath()
	if err != nil {
		return err
	}
	_ = runCommand("systemctl", "--user", "disable", "--now", serviceName+".service")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	_ = runCommand("systemctl", "--user", "daemon-reload")
	return nil
}

func serviceStatus() (string, error) {
	output, err := exec.Command("systemctl", "--user", "is-active", serviceName+".service").CombinedOutput()
	status := strings.TrimSpace(string(output))
	if status == "" && err != nil {
		return "unknown", err
	}
	return status, nil
}

func systemdQuote(value string) string {
	escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value)
	return `"` + escaped + `"`
}
