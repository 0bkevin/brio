package cli

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const stateFileName = "connect.env"

// stateKeys are the keys persisted under ~/.brio/connect.env.
const (
	stateKeyRelayURL   = "BRIO_RELAY_URL"
	stateKeyRelayToken = "BRIO_RELAY_TOKEN"
	stateKeyAgentID    = "BRIO_AGENT_ID"
	stateKeyHermesBase = "HERMES_API_BASE"
	stateKeyHermesKey  = "HERMES_API_KEY"
)

func brioHomeDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".brio"), nil
}

func stateFilePath() (string, error) {
	dir, err := brioHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, stateFileName), nil
}

// readState reads the connector state file. A missing file is an empty map.
func readState() map[string]string {
	path, err := stateFilePath()
	if err != nil {
		return map[string]string{}
	}
	file, err := os.Open(path)
	if err != nil {
		return map[string]string{}
	}
	defer file.Close()

	values := map[string]string{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key != "" {
			values[key] = strings.Trim(value, `"'`)
		}
	}
	return values
}

// writeState persists the connector state with sorted keys and 0600
// permissions inside a 0700 ~/.brio directory.
func writeState(values map[string]string) error {
	dir, err := brioHomeDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, stateFileName)
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("# Brio connector local state.\n")
	b.WriteString("# Edit this file or rerun `brio setup` with flags.\n")
	for _, key := range keys {
		value := strings.TrimSpace(values[key])
		if value == "" {
			continue
		}
		b.WriteString(key)
		b.WriteString("=")
		b.WriteString(value)
		b.WriteString("\n")
	}
	return writePrivateFile(path, []byte(b.String()))
}

func writePrivateFile(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

// stateValuesFromOptions maps connector options onto state file keys.
func stateValuesFromOptions(opts runOptions) map[string]string {
	return map[string]string{
		stateKeyRelayURL:   opts.relayURL,
		stateKeyRelayToken: opts.relayToken,
		stateKeyAgentID:    opts.agentID,
		stateKeyHermesBase: opts.hermesURL,
		stateKeyHermesKey:  opts.hermesAPIKey,
	}
}
