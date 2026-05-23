package cli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/brio/brio/apps/companion/internal/tunnel"
)

const (
	configFileName  = "companion.env"
	pairingFileName = "pairing.json"
)

type pairingState struct {
	Payload   tunnel.PairingPayload `json:"payload"`
	UpdatedAt time.Time             `json:"updated_at"`
}

func brioHomeDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".brio"), nil
}

func localConfigPath() (string, error) {
	dir, err := brioHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, configFileName), nil
}

func pairingStatePath() (string, error) {
	dir, err := brioHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, pairingFileName), nil
}

func readLocalConfig() map[string]string {
	path, err := localConfigPath()
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

func writeLocalConfig(values map[string]string) error {
	dir, err := brioHomeDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, configFileName)
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("# Brio Companion local configuration.\n")
	b.WriteString("# Edit this file or rerun `brio companion install` with flags.\n")
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
	return os.WriteFile(path, []byte(b.String()), 0o600)
}

func writePairingState(payload tunnel.PairingPayload) error {
	dir, err := brioHomeDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, pairingFileName)
	data, err := json.MarshalIndent(pairingState{Payload: payload, UpdatedAt: time.Now().UTC()}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o600)
}

func readPairingState() (pairingState, error) {
	path, err := pairingStatePath()
	if err != nil {
		return pairingState{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return pairingState{}, err
	}
	var state pairingState
	if err := json.Unmarshal(data, &state); err != nil {
		return pairingState{}, err
	}
	if state.Payload.URL == "" || state.Payload.Token == "" {
		return pairingState{}, fmt.Errorf("pairing state is incomplete")
	}
	return state, nil
}

func configValuesFromOptions(opts companionRunOptions) map[string]string {
	values := map[string]string{
		"BRIO_ADDR":          opts.cfg.Addr,
		"BRIO_PUBLIC_URL":    opts.publicURL,
		"BRIO_TOKEN":         opts.cfg.Token,
		"HERMES_API_BASE":    opts.cfg.HermesBaseURL,
		"HERMES_API_KEY":     opts.cfg.HermesAPIKey,
		"HERMES_HOME":        opts.cfg.HermesHome,
		"BRIO_RELAY_URL":     opts.relayURL,
		"BRIO_AGENT_ID":      opts.agentID,
		"BRIO_ALLOWED_ROOTS": strings.Join(opts.cfg.AllowedRoots, ","),
	}
	return values
}
