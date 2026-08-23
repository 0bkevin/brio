package hermes

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Low-level helpers shared by the profile manager. Kept in one place so the
// layout readers (gateway PID, config summary, dotenv names) stay next to
// their consumers.

// readGatewayPID parses gateway.pid, which Hermes writes either as a bare
// integer or a JSON object {"pid": N}.
func readGatewayPID(path string) (int, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	raw := strings.TrimSpace(string(data))
	if strings.HasPrefix(raw, "{") {
		var record struct {
			PID json.Number `json:"pid"`
		}
		if json.Unmarshal([]byte(raw), &record) == nil && record.PID != "" {
			if pid, err := record.PID.Int64(); err == nil && pid > 0 {
				return int(pid), true
			}
		}
		return 0, false
	}
	pid, err := strconv.Atoi(raw)
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

func readJSONFile(path string) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var payload map[string]any
	if json.Unmarshal(data, &payload) != nil {
		return nil
	}
	return payload
}

type hermesConfigSummary struct {
	model             string
	provider          string
	multiplexProfiles bool
}

// readHermesConfig reads model/provider/gateway multiplexing from a
// profile's config.yaml with real YAML parsing.
func readHermesConfig(path string) hermesConfigSummary {
	summary := hermesConfigSummary{}
	data, err := os.ReadFile(path)
	if err != nil {
		return summary
	}
	var raw map[string]any
	if yaml.Unmarshal(data, &raw) != nil || raw == nil {
		return summary
	}
	switch model := raw["model"].(type) {
	case string:
		summary.model = model
	case map[string]any:
		summary.model = scalarString(firstNonEmpty(model["default"], model["model"]))
		summary.provider = scalarString(model["provider"])
	}
	gateway, _ := raw["gateway"].(map[string]any)
	if gateway != nil {
		multiplexScalar(gateway["multiplex_profiles"], &summary.multiplexProfiles)
	} else {
		multiplexScalar(raw["multiplex_profiles"], &summary.multiplexProfiles)
	}
	return summary
}

func firstNonEmpty(values ...any) any {
	for _, value := range values {
		if s, ok := value.(string); ok && strings.TrimSpace(s) != "" {
			return value
		}
		if _, isStr := value.(string); !isStr && value != nil {
			return value
		}
	}
	return nil
}

func scalarString(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	default:
		return ""
	}
}

func multiplexScalar(value any, target *bool) {
	if b, ok := value.(bool); ok {
		*target = b
	}
}

func dotEnvVarNames(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return dotEnvVarNamesFromBytes(data)
}

// dotEnvVarNamesFromBytes extracts variable NAMES from .env-style content.
// Values are discarded immediately so previews can never leak secrets.
func dotEnvVarNamesFromBytes(data []byte) []string {
	var names []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, _, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		names = append(names, key)
	}
	sort.Strings(names)
	return dedupeStrings(names)
}

// dotEnvValue reads a single variable from .env-style content. Values never
// leave the connector process except as upstream credentials.
func dotEnvValue(path string, key string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		name, value, found := strings.Cut(line, "=")
		if !found || strings.TrimSpace(name) != key {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') ||
				(value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		return value
	}
	return ""
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dedupeStrings(values []string) []string {
	if len(values) == 0 {
		return values
	}
	out := make([]string, 0, len(values))
	out = append(out, values[0])
	for _, value := range values[1:] {
		if value != out[len(out)-1] {
			out = append(out, value)
		}
	}
	return out
}

func sortedStrings(values []string) []string {
	out := append([]string(nil), values...)
	sort.Strings(out)
	return out
}

// cutRef splits a trailing "#ref" pin from a git source.
func cutRef(source string) (struct {
	url string
	ref string
}, bool,
) {
	idx := strings.LastIndex(source, "#")
	if idx < 0 || idx == len(source)-1 {
		return struct {
			url string
			ref string
		}{}, false
	}
	return struct {
		url string
		ref string
	}{source[:idx], source[idx+1:]}, true
}

// expandHome resolves a leading "~" against the user's home directory.
func expandHome(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(path, "~"), "/"))
		}
	}
	return path
}

func limitPreviewFiles(files []string) []string {
	if len(files) <= maxListedPreviewFiles {
		return files
	}
	limited := make([]string, 0, maxListedPreviewFiles+1)
	limited = append(limited, files[:maxListedPreviewFiles]...)
	limited = append(limited, fmt.Sprintf("… (%d more files)", len(files)-maxListedPreviewFiles))
	return limited
}

// path_CleanSlash cleans a slash-separated relative path without letting it
// climb above the root.
func path_CleanSlash(name string) string {
	parts := strings.Split(name, "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		switch part {
		case "", ".":
			continue
		case "..":
			if len(out) == 0 {
				return ".."
			}
			out = out[:len(out)-1]
		default:
			out = append(out, part)
		}
	}
	return strings.Join(out, "/")
}
