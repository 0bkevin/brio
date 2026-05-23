package cli

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func launchAgentPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", serviceName+".plist"), nil
}

func installService(exe string, startNow bool) error {
	path, err := launchAgentPath()
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	brioDir, err := brioHomeDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(brioDir, 0o700); err != nil {
		return err
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>connect</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
</dict>
</plist>
`, xmlEscape(serviceName), xmlEscape(exe), xmlEscape(filepath.Join(brioDir, "companion.log")), xmlEscape(filepath.Join(brioDir, "companion.err.log")))
	if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
		return err
	}
	if !startNow {
		return nil
	}
	target := fmt.Sprintf("gui/%d", os.Getuid())
	_ = runCommand("launchctl", "bootout", target, path)
	if err := runCommand("launchctl", "bootstrap", target, path); err != nil {
		return err
	}
	return runCommand("launchctl", "kickstart", "-k", target+"/"+serviceName)
}

func stopService() error {
	_ = runCommand("launchctl", "bootout", fmt.Sprintf("gui/%d/%s", os.Getuid(), serviceName))
	return nil
}

func startService() error {
	path, err := launchAgentPath()
	if err != nil {
		return err
	}
	target := fmt.Sprintf("gui/%d", os.Getuid())
	if err := runCommand("launchctl", "print", target+"/"+serviceName); err != nil {
		if err := runCommand("launchctl", "bootstrap", target, path); err != nil {
			return err
		}
	}
	return runCommand("launchctl", "kickstart", "-k", target+"/"+serviceName)
}

func restartService() error {
	_ = stopService()
	return startService()
}

func uninstallService() error {
	path, err := launchAgentPath()
	if err != nil {
		return err
	}
	_ = stopService()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func serviceStatus() (string, error) {
	output, err := exec.Command("launchctl", "print", fmt.Sprintf("gui/%d/%s", os.Getuid(), serviceName)).CombinedOutput()
	if err != nil {
		if len(output) > 0 {
			return "not running", nil
		}
		return "not running", nil
	}
	return "running", nil
}

func xmlEscape(value string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(value))
	return b.String()
}
