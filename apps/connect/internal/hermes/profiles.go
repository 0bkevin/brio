package hermes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Distribution staging budgets guard preview/apply against unbounded local
// trees and hostile clones. They are vars so tests can shrink them.
var (
	distMaxFiles     = 20000
	distMaxFileBytes = int64(16 * 1024 * 1024)
	distMaxTotal     = int64(64 * 1024 * 1024)
)

// DefaultProfileName is the stock Hermes home itself (~/.hermes). It always
// exists and can never be renamed or deleted.
const DefaultProfileName = "default"

// Layout constants mirror the pinned Hermes implementation
// (hermes_cli/profiles.py @ 69ae247c): the sticky selection lives in
// `active_profile`, per-profile metadata in `profile.yaml`, and gateway
// runtime state in `gateway_state.json`. Brio reads this exact layout and
// delegates every mutation to the installed hermes CLI (profiles_cli.go) so
// aliases, services, skill seeding, Honcho migration and future Hermes
// behavior stay authoritative.
const (
	activeProfileMarker  = "active_profile"
	profileMetaFileName  = "profile.yaml"
	gatewayStateFileName = "gateway_state.json"
	distributionManifest = "distribution.yaml"
	envTemplateFileName  = ".env.template"
	envExampleFileName   = ".env.EXAMPLE"
	soulFileName         = "SOUL.md"
	envFileName          = ".env"
	authFileName         = "auth.json"
	configFileName       = "config.yaml"
	gatewayPIDFileName   = "gateway.pid"
	processesFileName    = "processes.json"
	profilesDirName      = "profiles"
	maxSoulBytes         = 512 * 1024
	// maxExportArchiveBytes bounds the RAW archive before base64+JSON
	// framing (~4/3 expansion) so the response frame always traverses the
	// connector's 10 MiB maxResponseBytes with headroom: 6 MiB raw → ~8 MiB
	// encoded frame.
	maxExportArchiveBytes = 6 * 1024 * 1024
	maxImportArchiveBytes = 12 * 1024 * 1024
	maxListedPreviewFiles = 500
	wrapperReadLimit      = 8192
)

// profileIDRE mirrors Hermes' _PROFILE_ID_RE.
var profileIDRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// reservedProfileNames mirrors Hermes' _RESERVED_NAMES minus `default`,
// which validation treats as the special built-in alias.
var reservedProfileNames = map[string]bool{
	"hermes": true, "test": true, "tmp": true, "root": true, "sudo": true,
}

// ErrProfileNotFound marks unknown profile lookups.
var ErrProfileNotFound = errors.New("profile not found")

// ValidateProfileName normalizes a candidate profile name exactly like
// Hermes' normalize_profile_name + validate_profile_name pair: lowercase,
// [a-z0-9][a-z0-9_-]{0,63}, reserved system names rejected, `default` a
// valid pass-through alias for ~/.hermes.
func ValidateProfileName(name string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(name))
	if normalized == "" {
		return "", errors.New("profile name is required")
	}
	if normalized == DefaultProfileName {
		return DefaultProfileName, nil
	}
	if !profileIDRE.MatchString(normalized) {
		return "", fmt.Errorf("invalid profile name %q: must match [a-z0-9][a-z0-9_-]{0,63}", name)
	}
	if reservedProfileNames[normalized] {
		return "", fmt.Errorf("profile name %q is reserved: it collides with a system binary or the Hermes installation", normalized)
	}
	if normalized == profilesDirName {
		return "", fmt.Errorf("profile name %q is reserved", normalized)
	}
	return normalized, nil
}

// ProfileManager reads the real Hermes profile layout under Home and
// delegates mutations to the installed hermes CLI. Runner/HermesBin are
// injectable for tests; zero values pick production defaults.
type ProfileManager struct {
	Home string
	// HermesBin overrides the binary name (tests); default "hermes".
	HermesBin string
	// Runner executes external commands; default ExecRunner.
	Runner CLIRunner
}

func newProfileManager(home string) *ProfileManager {
	return &ProfileManager{Home: home}
}

// Exists reports whether a profile directory is present.
func (m *ProfileManager) Exists(name string) bool {
	if name == "" || name == DefaultProfileName {
		return true
	}
	dir, err := m.dirFor(name)
	if err != nil {
		return false
	}
	info, err := os.Stat(dir)
	return err == nil && info.IsDir()
}

func (m *ProfileManager) dirFor(name string) (string, error) {
	if name == "" || name == DefaultProfileName {
		return m.Home, nil
	}
	normalized, err := ValidateProfileName(name)
	if err != nil {
		return "", err
	}
	return filepath.Join(m.Home, profilesDirName, normalized), nil
}

// ---------------------------------------------------------------------------
// Sticky active profile (`hermes profile use`)
// ---------------------------------------------------------------------------

// Active returns the sticky default profile per Hermes semantics: text file
// `<home>/active_profile`; missing or empty means default.
func (m *ProfileManager) Active() string {
	data, err := os.ReadFile(filepath.Join(m.Home, activeProfileMarker))
	if err != nil {
		return DefaultProfileName
	}
	name := strings.TrimSpace(string(data))
	if name == "" {
		return DefaultProfileName
	}
	normalized, err := ValidateProfileName(name)
	if err != nil || !m.Exists(normalized) {
		return DefaultProfileName
	}
	return normalized
}

func (m *ProfileManager) setActive(name string) error {
	if name == "" || name == DefaultProfileName {
		// Hermes removes the marker with missing_ok semantics.
		if err := os.Remove(filepath.Join(m.Home, activeProfileMarker)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	return atomicWrite(filepath.Join(m.Home, activeProfileMarker), []byte(name+"\n"), 0o600)
}

// ---------------------------------------------------------------------------
// Profile info
// ---------------------------------------------------------------------------

// ProfileInfo describes one Hermes profile. Secret values are never exposed:
// only whether credential files exist and which variable NAMES they define.
type ProfileInfo struct {
	Name               string         `json:"name"`
	Path               string         `json:"path"`
	IsDefault          bool           `json:"is_default"`
	Active             bool           `json:"active"`
	Description        string         `json:"description,omitempty"`
	DescriptionAuto    bool           `json:"description_auto,omitempty"`
	Model              string         `json:"model,omitempty"`
	Provider           string         `json:"provider,omitempty"`
	GatewayMultiplex   bool           `json:"gateway_multiplex,omitempty"`
	HasConfig          bool           `json:"has_config"`
	HasEnv             bool           `json:"has_env"`
	HasSoul            bool           `json:"has_soul"`
	SkillCount         int            `json:"skill_count"`
	EnvVarNames        []string       `json:"env_var_names,omitempty"`
	GatewayRunning     bool           `json:"gateway_running"`
	GatewayPID         int            `json:"gateway_pid,omitempty"`
	RuntimeStatus      map[string]any `json:"runtime_status,omitempty"`
	AliasName          string         `json:"alias_name,omitempty"`
	DistributionName   string         `json:"distribution_name,omitempty"`
	DistributionVer    string         `json:"distribution_version,omitempty"`
	DistributionSource string         `json:"distribution_source,omitempty"`
}

// List returns the default profile plus every named profile, sorted by name.
func (m *ProfileManager) List() ([]ProfileInfo, error) {
	active := m.Active()
	aliasMap := m.aliasMap()
	profiles := []ProfileInfo{m.describe(DefaultProfileName, active, aliasMap)}
	entries, err := os.ReadDir(m.profilesRoot())
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == DefaultProfileName {
			continue
		}
		if !profileIDRE.MatchString(entry.Name()) {
			continue
		}
		profiles = append(profiles, m.describe(entry.Name(), active, aliasMap))
	}
	sortProfiles(profiles[1:])
	return profiles, nil
}

// Show returns detailed info for one profile.
func (m *ProfileManager) Show(name string) (ProfileInfo, error) {
	normalized, err := m.normalizeExisting(name)
	if err != nil {
		return ProfileInfo{}, err
	}
	return m.describe(normalized, m.Active(), m.aliasMap()), nil
}

func (m *ProfileManager) normalizeExisting(name string) (string, error) {
	normalized, err := ValidateProfileName(name)
	if err != nil {
		return "", err
	}
	if normalized != DefaultProfileName && !m.Exists(normalized) {
		return "", fmt.Errorf("%w: profile %q does not exist", ErrProfileNotFound, normalized)
	}
	return normalized, nil
}

func sortProfiles(profiles []ProfileInfo) {
	for i := 1; i < len(profiles); i++ {
		for j := i; j > 0 && profiles[j].Name < profiles[j-1].Name; j-- {
			profiles[j], profiles[j-1] = profiles[j-1], profiles[j]
		}
	}
}

func (m *ProfileManager) profilesRoot() string {
	return filepath.Join(m.Home, profilesDirName)
}

func (m *ProfileManager) describe(name string, active string, aliasMap map[string]string) ProfileInfo {
	dir, err := m.dirFor(name)
	if err != nil {
		dir = filepath.Join(m.Home, profilesDirName, name)
	}
	info := ProfileInfo{
		Name:      name,
		Path:      dir,
		IsDefault: name == DefaultProfileName,
		Active:    name == active,
	}
	info.HasConfig = fileExists(filepath.Join(dir, configFileName))
	info.HasEnv = fileExists(filepath.Join(dir, envFileName))
	info.HasSoul = fileExists(filepath.Join(dir, soulFileName))
	if info.HasEnv {
		info.EnvVarNames = dotEnvVarNames(filepath.Join(dir, envFileName))
	}
	meta := readProfileYAML(filepath.Join(dir, profileMetaFileName))
	info.Description = meta.Description
	info.DescriptionAuto = meta.DescriptionAuto
	config := readHermesConfig(filepath.Join(dir, configFileName))
	info.Model = config.model
	info.Provider = config.provider
	info.GatewayMultiplex = config.multiplexProfiles
	info.SkillCount = countSkills(filepath.Join(dir, "skills"))
	info.GatewayRunning, info.GatewayPID = m.gatewayState(dir)
	if status := readJSONFile(filepath.Join(dir, gatewayStateFileName)); status != nil {
		info.RuntimeStatus = status
	}
	if alias := aliasMap[name]; alias != "" {
		info.AliasName = alias
	}
	if manifest := readDistributionManifest(filepath.Join(dir, distributionManifest)); manifest != nil {
		info.DistributionName = manifest.Name
		info.DistributionVer = manifest.Version
		info.DistributionSource = manifest.Source
	}
	return info
}

// gatewayState resolves liveness like Hermes' _check_gateway_running: the
// PID file first, then the persisted gateway_state.json record.
func (m *ProfileManager) gatewayState(dir string) (bool, int) {
	if pid, ok := readGatewayPID(filepath.Join(dir, gatewayPIDFileName)); ok && processAlive(pid) {
		return true, pid
	}
	record := readJSONFile(filepath.Join(dir, gatewayStateFileName))
	if record == nil {
		return false, 0
	}
	switch record["gateway_state"] {
	case nil, "stopped", "startup_failed":
		return false, 0
	}
	pid, ok := numericField(record["pid"])
	if !ok || !processAlive(pid) {
		return false, 0
	}
	return true, pid
}

func numericField(value any) (int, bool) {
	switch v := value.(type) {
	case float64:
		if v > 0 && v == float64(int(v)) {
			return int(v), true
		}
	case int:
		if v > 0 {
			return v, true
		}
	case string:
		if parsed, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && parsed > 0 {
			return parsed, true
		}
	}
	return 0, false
}

// aliasMap reproduces Hermes' build_alias_map: scan ~/.local/bin once for
// wrapper scripts invoking `hermes -p <profile>` and reverse-map them.
// Reads are strictly bounded (at most wrapperReadLimit bytes via a size
// pre-check and bounded io.Copy), NUL/binary content is rejected, and
// iteration is deterministic (sorted entries) so large binaries on PATH
// never dominate runtime.
func (m *ProfileManager) aliasMap() map[string]string {
	result := map[string]string{}
	home, err := os.UserHomeDir()
	if err != nil {
		return result
	}
	wrapperDir := filepath.Join(home, ".local", "bin")
	entries, err := os.ReadDir(wrapperDir)
	if err != nil {
		return result
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)

	const prefix = "hermes -p "
	for _, name := range names {
		if strings.Contains(name, ".") { // wrappers carry no extension; skips .bat too
			continue
		}
		path := filepath.Join(wrapperDir, name)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		content, ok := readWrapperHead(path, info.Size())
		if !ok {
			continue
		}
		idx := bytes.Index(content, []byte(prefix))
		if idx < 0 {
			continue
		}
		fields := strings.Fields(string(content[idx+len(prefix):]))
		if len(fields) == 0 {
			continue
		}
		canon, err := ValidateProfileName(fields[0])
		if err != nil || canon == DefaultProfileName {
			continue
		}
		if name == canon {
			if _, exists := result[canon]; !exists {
				result[canon] = name
			}
		} else {
			result[canon] = name // custom aliases win over profile-named wrappers
		}
	}
	return result
}

// readWrapperHead reads at most wrapperReadLimit bytes from the start of a
// candidate wrapper. Files larger than a small tolerance for the head slice,
// or containing NUL bytes, are treated as binaries and skipped without ever
// reading them whole.
func readWrapperHead(path string, size int64) ([]byte, bool) {
	const maxHeadBytes = int64(wrapperReadLimit) * 4
	if size <= 0 || size > maxHeadBytes {
		return nil, false
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	head := make([]byte, wrapperReadLimit)
	n, err := io.ReadFull(file, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, false
	}
	head = head[:n]
	if bytes.IndexByte(head, 0) >= 0 {
		return nil, false // binary
	}
	return head, true
}

func countSkills(skillsDir string) int {
	count := 0
	_ = filepath.WalkDir(skillsDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return fs.SkipDir
		}
		if count > 5000 {
			return fs.SkipAll
		}
		if !d.IsDir() && d.Name() == "SKILL.md" {
			count++
		}
		return nil
	})
	return count
}

type profileMetaYAML struct {
	Description     string `yaml:"description"`
	DescriptionAuto bool   `yaml:"description_auto"`
}

// readProfileYAML parses `<dir>/profile.yaml` (Hermes metadata). Missing or
// corrupt files are empty defaults, never errors — same contract as Hermes.
func readProfileYAML(path string) profileMetaYAML {
	var meta profileMetaYAML
	data, err := os.ReadFile(path)
	if err != nil {
		return meta
	}
	var raw map[string]any
	if yaml.Unmarshal(data, &raw) != nil || raw == nil {
		return meta
	}
	if s, ok := raw["description"].(string); ok {
		meta.Description = strings.TrimSpace(s)
	}
	if b, ok := raw["description_auto"].(bool); ok {
		meta.DescriptionAuto = b
	}
	return meta
}

// ---------------------------------------------------------------------------
// Mutations — delegated to the installed hermes CLI (see profiles_cli.go)
// ---------------------------------------------------------------------------

// CreateOptions mirrors `hermes profile create` flags.
type CreateOptions struct {
	Description string
	Clone       bool
	CloneAll    bool
	CloneFrom   string
}

// Create installs a new profile through the stock CLI so bundled-skill
// seeding, standard directories, wrapper aliases, s6 registration, config
// migration and Honcho hooks all behave exactly as documented. Every check
// happens BEFORE the CLI is invoked: a rejected create leaves no directory.
func (m *ProfileManager) Create(ctx context.Context, name string, opts CreateOptions) (ProfileInfo, error) {
	normalized, err := ValidateProfileName(name)
	if err != nil {
		return ProfileInfo{}, err
	}
	if normalized == DefaultProfileName {
		return ProfileInfo{}, errors.New("the default profile already exists and cannot be created")
	}
	if m.Exists(normalized) {
		return ProfileInfo{}, fmt.Errorf("profile %q already exists", normalized)
	}
	args := []string{"profile", "create", normalized}
	if opts.CloneAll {
		args = append(args, "--clone-all")
	} else if opts.Clone {
		args = append(args, "--clone")
	}
	if strings.TrimSpace(opts.CloneFrom) != "" {
		source, err := ValidateProfileName(opts.CloneFrom)
		if err != nil {
			return ProfileInfo{}, fmt.Errorf("clone-from: %w", err)
		}
		if source == normalized {
			return ProfileInfo{}, errors.New("cannot clone a profile from itself")
		}
		if source != DefaultProfileName && !m.Exists(source) {
			return ProfileInfo{}, fmt.Errorf("%w: clone-from profile %q does not exist", ErrProfileNotFound, source)
		}
		args = append(args, "--clone-from", source)
	}
	if description := strings.TrimSpace(opts.Description); description != "" {
		if len(description) > 2000 {
			return ProfileInfo{}, errors.New("description is too large")
		}
		args = append(args, "--description", description)
	}
	if _, err := m.runHermes(ctx, args...); err != nil {
		return ProfileInfo{}, err
	}
	return m.Show(normalized)
}

// Use delegates sticky-profile selection to the stock CLI. The defensive
// marker sync keeps the real active_profile missing_ok behavior deterministic
// for an already-bootstrapped home while Hermes remains authoritative for the
// mutation itself.
func (m *ProfileManager) Use(ctx context.Context, name string) (ProfileInfo, error) {
	normalized, err := m.normalizeExisting(name)
	if err != nil {
		return ProfileInfo{}, err
	}
	if _, err := m.runHermes(ctx, "profile", "use", normalized); err != nil {
		return ProfileInfo{}, err
	}
	if err := m.setActive(normalized); err != nil {
		return ProfileInfo{}, err
	}
	return m.Show(normalized)
}

// Describe delegates to `hermes profile describe --text` so the stored
// profile.yaml shape stays native.
func (m *ProfileManager) Describe(ctx context.Context, name string, description string) (ProfileInfo, error) {
	normalized, err := m.normalizeExisting(name)
	if err != nil {
		return ProfileInfo{}, err
	}
	description = strings.TrimSpace(description)
	if len(description) > 2000 {
		return ProfileInfo{}, errors.New("description is too large")
	}
	if _, err := m.runHermes(ctx, "profile", "describe", normalized, "--text", description); err != nil {
		return ProfileInfo{}, err
	}
	return m.Show(normalized)
}

// Rename delegates to `hermes profile rename`, which stops the gateway,
// migrates the managed service, updates the command alias and Honcho hosts,
// and rewrites the sticky marker natively. The typed confirmation is
// enforced at Brio's API boundary before this runs.
func (m *ProfileManager) Rename(ctx context.Context, from string, to string, confirm string) (ProfileInfo, []string, error) {
	source, err := m.normalizeExisting(from)
	if err != nil {
		return ProfileInfo{}, nil, err
	}
	normalizedTo, err := ValidateProfileName(to)
	if err != nil {
		return ProfileInfo{}, nil, err
	}
	if normalizedTo == DefaultProfileName {
		return ProfileInfo{}, nil, errors.New("cannot rename into the reserved default profile")
	}
	if confirm != source {
		return ProfileInfo{}, nil, fmt.Errorf("rename requires typing the profile name %q to confirm", source)
	}
	if source != normalizedTo && m.Exists(normalizedTo) {
		return ProfileInfo{}, nil, fmt.Errorf("profile %q already exists", normalizedTo)
	}
	if _, err := m.runHermes(ctx, "profile", "rename", source, normalizedTo); err != nil {
		return ProfileInfo{}, nil, err
	}
	info, err := m.Show(normalizedTo)
	if err != nil {
		return ProfileInfo{}, nil, err
	}
	return info, serviceResidueNotes(normalizedTo), nil
}

// Delete delegates to `hermes profile delete --yes`: Hermes disables the
// managed gateway service first (preventing auto-restart), stops the running
// gateway and bound backends, removes the command alias, removes the tree,
// and resets the sticky marker. The typed confirmation is enforced at Brio's
// boundary; the default profile can never reach here.
func (m *ProfileManager) Delete(ctx context.Context, name string, confirm string) ([]string, error) {
	normalized, err := m.normalizeExisting(name)
	if err != nil {
		return nil, err
	}
	if normalized == DefaultProfileName {
		return nil, errors.New("the default profile cannot be deleted")
	}
	if confirm != normalized {
		return nil, fmt.Errorf("delete requires typing the profile name %q to confirm", normalized)
	}
	if _, err := m.runHermes(ctx, "profile", "delete", normalized, "--yes"); err != nil {
		return nil, err
	}
	if m.Active() == normalized {
		if err := m.setActive(DefaultProfileName); err != nil {
			return nil, fmt.Errorf("profile deleted but active_profile could not be cleared: %w", err)
		}
	}
	return serviceResidueNotes(normalized), nil
}

// serviceResidueNotes reports stock artifacts that may legitimately outlive a
// delete/rename (e.g. user-created custom units). Purely informational —
// Hermes itself removes its own managed files during delete/rename.
func serviceResidueNotes(name string) []string {
	if name == DefaultProfileName {
		return nil
	}
	var notes []string
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	for _, candidate := range []string{
		filepath.Join(home, "Library", "LaunchAgents", fmt.Sprintf("ai.hermes.gateway-%s.plist", name)),
		filepath.Join(home, ".config", "systemd", "user", fmt.Sprintf("hermes-gateway-%s.service", name)),
	} {
		if fileExists(candidate) {
			notes = append(notes, fmt.Sprintf("gateway service file still present: %s", candidate))
		}
	}
	return notes
}

// GatewayAction delegates lifecycle control to the CLI using real Hermes
// semantics: named profiles go through `-p <name> gateway <action>`, the
// default profile targets the shared listener without a selector. Multiplex
// conflicts surface verbatim as Hermes errors via CLIError.
func (m *ProfileManager) GatewayAction(ctx context.Context, name string, action string) (string, ProfileInfo, error) {
	normalized, err := m.normalizeExisting(name)
	if err != nil {
		return "", ProfileInfo{}, err
	}
	switch action {
	case "start", "stop", "restart", "status":
	default:
		return "", ProfileInfo{}, fmt.Errorf("unsupported gateway action %q", action)
	}
	args := make([]string, 0, 4)
	if normalized != DefaultProfileName {
		args = append(args, "-p", normalized)
	}
	args = append(args, "gateway", action)
	output, err := m.runHermes(ctx, args...)
	info, infoErr := m.Show(normalized)
	if infoErr != nil {
		info = ProfileInfo{Name: normalized}
	}
	return strings.TrimSpace(output), info, err
}

// ---------------------------------------------------------------------------
// SOUL editing (plain files in the real layout)
// ---------------------------------------------------------------------------

// GetSOUL returns the raw SOUL.md contents of a profile.
func (m *ProfileManager) GetSOUL(name string) (string, error) {
	normalized, err := m.normalizeExisting(name)
	if err != nil {
		return "", err
	}
	dir, _ := m.dirFor(normalized)
	data, err := os.ReadFile(filepath.Join(dir, soulFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if len(data) > maxSoulBytes {
		return "", fmt.Errorf("SOUL.md is larger than %d bytes", maxSoulBytes)
	}
	return string(data), nil
}

// SetSOUL atomically replaces a profile's SOUL.md.
func (m *ProfileManager) SetSOUL(name string, content string) error {
	normalized, err := m.normalizeExisting(name)
	if err != nil {
		return err
	}
	if len(content) > maxSoulBytes {
		return fmt.Errorf("SOUL.md is larger than %d bytes", maxSoulBytes)
	}
	dir, _ := m.dirFor(normalized)
	return atomicWrite(filepath.Join(dir, soulFileName), []byte(content), 0o600)
}

// ---------------------------------------------------------------------------
// Archive export/import — real Hermes archives through the CLI
// ---------------------------------------------------------------------------

// ExportPreview describes an export before it is transferred. Hermes exports
// are portable credential-free snapshots by design (.env/auth.json are
// excluded upstream), so credentials_included is always false.
type ExportPreview struct {
	Filename    string   `json:"filename"`
	FileCount   int      `json:"file_count"`
	TotalBytes  int64    `json:"total_bytes"`
	Files       []string `json:"files,omitempty"`
	Credentials bool     `json:"credentials_included"`
	RequiredEnv []string `json:"required_env_vars,omitempty"`
	Warnings    []string `json:"warnings,omitempty"`
}

// ExportResult carries the base64 gzip+tar archive plus its preview.
type ExportResult struct {
	ExportPreview
	DataBase64 string `json:"data_base64"`
	SHA256     string `json:"sha256"`
}

// Export produces a real Hermes profile archive via the CLI
// (`hermes -p <name> profile export`), then streams it back as base64.
// The preview is computed from the on-disk tree using Hermes' own exclusion
// policy so users see what a portable snapshot carries before transferring.
func (m *ProfileManager) Export(ctx context.Context, name string) (*ExportResult, error) {
	normalized, err := m.normalizeExisting(name)
	if err != nil {
		return nil, err
	}
	preview := m.exportPreview(normalized)

	tmp, err := os.CreateTemp("", "brio-export-*.tar.gz")
	if err != nil {
		return nil, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Close(); err != nil {
		return nil, err
	}

	args := make([]string, 0, 6)
	if normalized != DefaultProfileName {
		args = append(args, "-p", normalized)
	}
	args = append(args, "profile", "export", normalized, "-o", tmpName)
	if _, err := m.runHermes(ctx, args...); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(tmpName)
	if err != nil {
		return nil, fmt.Errorf("hermes did not produce the expected archive: %w", err)
	}
	if len(data) > maxExportArchiveBytes {
		return nil, fmt.Errorf("hermes export exceeds the %d byte transfer budget; use a local copy instead", maxExportArchiveBytes)
	}
	sum := sha256.Sum256(data)
	result := &ExportResult{
		ExportPreview: preview,
		DataBase64:    base64.StdEncoding.EncodeToString(data),
		SHA256:        fmt.Sprintf("%x", sum),
	}
	result.FileCount = len(preview.Files)
	result.Credentials = false
	return result, nil
}

// exportPreview walks the profile with Hermes' portable-snapshot exclusions
// (_DEFAULT_EXPORT_EXCLUDE_ROOT semantics): infrastructure, databases,
// runtime state, caches, logs and credentials never appear in an export.
func (m *ProfileManager) exportPreview(name string) ExportPreview {
	dir, _ := m.dirFor(name)
	isDefaultHome := dir == m.Home
	var files []string
	var total int64
	count := 0
	_ = walkProfile(dir, func(relPath string, info fs.FileInfo, read func() ([]byte, error)) error {
		if info != nil && info.IsDir() {
			return nil
		}
		if exportExcluded(relPath, isDefaultHome) {
			return nil
		}
		size := int64(0)
		if read != nil {
			if data, err := read(); err == nil {
				size = int64(len(data))
			}
		} else if info != nil {
			size = info.Size()
		}
		total += size
		if count < maxListedPreviewFiles {
			files = append(files, relPath)
		}
		count++
		return nil
	})
	preview := ExportPreview{
		Filename:   fmt.Sprintf("%s.tar.gz", name),
		FileCount:  count,
		TotalBytes: total,
		Files:      files,
	}
	// Credentials are excluded from the archive, but their variable NAMES
	// still guide setup on a restored machine.
	if fileExists(filepath.Join(dir, envFileName)) {
		preview.RequiredEnv = dotEnvVarNames(filepath.Join(dir, envFileName))
	}
	if pid, ok := readGatewayPID(filepath.Join(dir, gatewayPIDFileName)); ok && processAlive(pid) {
		preview.Warnings = append(preview.Warnings,
			fmt.Sprintf("the %s gateway is running; the archive reflects files on disk, not a quiesced snapshot", name))
	}
	return preview
}

// cloneAllHistoryExcludeRoot mirrors _CLONE_ALL_HISTORY_EXCLUDE_ROOT:
// per-profile history that belongs to the source profile only.
var cloneAllHistoryExcludeRoot = map[string]bool{
	"state.db": true, "state.db-wal": true, "state.db-shm": true,
	"sessions": true, "backups": true, "state-snapshots": true, "checkpoints": true,
}

// defaultSourceInfraExcludeRoot mirrors _CLONE_ALL_DEFAULT_EXCLUDE_ROOT:
// infrastructure only the default home ever contains.
var defaultSourceInfraExcludeRoot = map[string]bool{
	"hermes-agent": true, ".worktrees": true, "profiles": true,
	"bin": true, "node_modules": true,
}

// runtimeStateFiles mirrors _CLONE_ALL_STRIP plus neighbors.
var runtimeStateFiles = map[string]bool{
	gatewayPIDFileName: true, gatewayStateFileName: true, processesFileName: true,
	activeProfileMarker: true,
}

// exportCredentialFiles are stripped from every portable snapshot, matching
// Hermes' export behavior (.env / auth.json carry secrets).
var exportCredentialFiles = map[string]bool{
	envFileName: true, authFileName: true, envTemplateFileName: true,
}

// exportExcluded implements the portable-snapshot exclusion policy. The
// named sets are ROOT-LEVEL entries (Hermes semantics), so they prune the
// whole subtree of an excluded directory; generic suffix rules apply at any
// depth. relPath uses forward slashes with no leading slash.
func exportExcluded(relPath string, isDefaultHome bool) bool {
	base := filepath.Base(relPath)
	switch {
	case strings.HasSuffix(base, ".pyc"), strings.HasSuffix(base, ".pyo"),
		strings.HasSuffix(base, ".sock"), strings.HasSuffix(base, ".tmp"),
		strings.HasSuffix(base, ".pid"), strings.HasSuffix(base, ".lock"):
		return true
	}
	firstSegment := relPath
	if idx := strings.IndexByte(relPath, '/'); idx >= 0 {
		firstSegment = relPath[:idx]
	}
	if cloneAllHistoryExcludeRoot[firstSegment] || runtimeStateFiles[firstSegment] ||
		exportCredentialFiles[firstSegment] {
		return true
	}
	switch firstSegment {
	case "logs", "errors.log", ".update_check", ".hermes_history", "auth.lock",
		"image_cache", "audio_cache", "document_cache", "browser_screenshots",
		"sandboxes", "__pycache__":
		return true
	}
	if isDefaultHome && defaultSourceInfraExcludeRoot[firstSegment] {
		return true
	}
	return false
}

// ImportPreview is the dry-run result of importing an archive. Token binds
// the preview to the exact sanitized payload + target; apply must echo it.
type ImportPreview struct {
	Name           string   `json:"name"`
	NewProfile     bool     `json:"new_profile"`
	FileCount      int      `json:"file_count"`
	TotalBytes     int64    `json:"total_bytes"`
	Files          []string `json:"files,omitempty"`
	SecretFiles    []string `json:"secret_files,omitempty"`
	HasSecretsFile bool     `json:"has_secrets_file"`
	RequiredEnv    []string `json:"required_env_vars,omitempty"`
	PreviewToken   string   `json:"preview_token"`
}

// ErrPreviewMismatch rejects apply calls whose inputs changed after preview.
var ErrPreviewMismatch = errors.New("inputs changed since preview; refresh the preview and try again")

func isSecretEntry(name string) bool {
	base := filepath.Base(name)
	return base == envFileName || base == authFileName || strings.HasPrefix(base, ".env.")
}

// archiveDigest derives a server-issued preview token bound to the exact
// sanitized payload, target profile, and planned operation.
func archiveDigest(entries []tarEntry, target string) string {
	h := sha256.New()
	fmt.Fprintf(h, "brio-import-v1\x00target=%s\x00files=%d\x00", target, len(entries))
	for _, entry := range entries {
		sum := sha256.Sum256(entry.data)
		fmt.Fprintf(h, "e\x00%s\x00%d\x00%s\x00", entry.name, entry.size, hex.EncodeToString(sum[:]))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ImportPreviewFromArchive inspects an uploaded Hermes archive without
// applying it: entries are sanitized (traversal, absolute paths, links and
// devices rejected) and only credential FILE NAMES — never values — are
// surfaced.
func (m *ProfileManager) ImportPreviewFromArchive(archiveB64 string, name string) (*ImportPreview, error) {
	payload, err := decodeArchive(archiveB64)
	if err != nil {
		return nil, err
	}
	entries, err := readTarEntries(payload)
	if err != nil {
		return nil, err
	}
	normalized, err := ValidateProfileName(name)
	if err != nil || normalized == DefaultProfileName || normalized == "" {
		return nil, errors.New("a target profile name is required and archives cannot overwrite the default profile")
	}
	preview := &ImportPreview{
		Name:       normalized,
		NewProfile: !m.Exists(normalized),
	}
	var total int64
	for _, entry := range entries.files {
		if int64(entry.size) > maxImportArchiveBytes {
			return nil, fmt.Errorf("archive entry %q is too large", entry.name)
		}
		preview.Files = append(preview.Files, entry.name)
		total += int64(entry.size)
		if isSecretEntry(entry.name) {
			preview.HasSecretsFile = true
			preview.SecretFiles = append(preview.SecretFiles, entry.name)
			preview.RequiredEnv = append(preview.RequiredEnv, dotEnvVarNamesFromBytes(entry.data)...)
		}
	}
	preview.FileCount = len(entries.files)
	preview.TotalBytes = total
	sort.Strings(preview.RequiredEnv)
	preview.RequiredEnv = dedupeStrings(preview.RequiredEnv)
	preview.Files = limitPreviewFiles(preview.Files)
	sort.Strings(preview.SecretFiles)
	preview.PreviewToken = archiveDigest(entries.files, normalized)
	return preview, nil
}

// decodeArchive decodes and bounds a base64 archive payload.
func decodeArchive(archiveB64 string) ([]byte, error) {
	payload, err := base64.StdEncoding.DecodeString(archiveB64)
	if err != nil {
		return nil, fmt.Errorf("archive is not valid base64: %w", err)
	}
	if len(payload) > maxImportArchiveBytes*2 {
		return nil, fmt.Errorf("archive is larger than %d bytes", maxImportArchiveBytes)
	}
	return payload, nil
}

// Import applies an uploaded Hermes archive through the stock CLI
// (`hermes profile import`). Fail-closed rules:
//   - a valid preview token bound to this exact payload + target is required
//     (dry-run previews go through ImportPreviewFromArchive instead),
//   - existing targets are rejected (stock Hermes import has no reliable
//     replace path; issue #20 does not require replacement imports),
//   - archives containing credential files additionally require explicit
//     allow_secrets consent at apply time.
func (m *ProfileManager) Import(ctx context.Context, archiveB64 string, name string, allowSecrets bool, token string) (*ImportPreview, error) {
	payload, err := decodeArchive(archiveB64)
	if err != nil {
		return nil, err
	}
	entries, err := readTarEntries(payload)
	if err != nil {
		return nil, err
	}
	normalized, err := ValidateProfileName(name)
	if err != nil || normalized == DefaultProfileName || normalized == "" {
		return nil, errors.New("a target profile name is required and archives cannot overwrite the default profile")
	}
	computed := archiveDigest(entries.files, normalized)
	if strings.TrimSpace(token) != computed {
		return nil, ErrPreviewMismatch
	}
	hasSecrets := false
	for _, entry := range entries.files {
		if isSecretEntry(entry.name) {
			hasSecrets = true
			break
		}
	}
	preview := &ImportPreview{
		Name:       normalized,
		NewProfile: !m.Exists(normalized),
	}
	var total int64
	for _, entry := range entries.files {
		preview.Files = append(preview.Files, entry.name)
		total += int64(entry.size)
		if isSecretEntry(entry.name) {
			hasSecrets = true
			preview.SecretFiles = append(preview.SecretFiles, entry.name)
			preview.RequiredEnv = append(preview.RequiredEnv, dotEnvVarNamesFromBytes(entry.data)...)
		}
	}
	preview.FileCount = len(entries.files)
	preview.TotalBytes = total
	preview.HasSecretsFile = hasSecrets
	sort.Strings(preview.RequiredEnv)
	preview.RequiredEnv = dedupeStrings(preview.RequiredEnv)
	preview.Files = limitPreviewFiles(preview.Files)
	preview.SecretFiles = sortedStrings(preview.SecretFiles)
	preview.PreviewToken = computed

	if hasSecrets && !allowSecrets {
		return nil, errors.New("this archive contains credential files; pass allow_secrets with explicit consent to import them")
	}
	if m.Exists(normalized) {
		return nil, fmt.Errorf("profile %q already exists; stock hermes profile import cannot replace an existing profile", normalized)
	}
	tmp, err := os.CreateTemp("", "brio-import-*.tar.gz")
	if err != nil {
		return nil, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	if _, err := m.runHermes(ctx, "profile", "import", tmpName, "--name", normalized); err != nil {
		return nil, err
	}
	return preview, nil
}

// ---------------------------------------------------------------------------
// Profile distributions — real Hermes git distributions
// ---------------------------------------------------------------------------

// EnvRequirement mirrors Hermes' EnvRequirement manifest entry.
type EnvRequirement struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required"`
	Default     string `json:"default,omitempty"`
}

// DistributionManifest mirrors Hermes' distribution.yaml.
type DistributionManifest struct {
	Name              string           `yaml:"name" json:"name"`
	Version           string           `yaml:"version" json:"version"`
	Description       string           `yaml:"description" json:"description,omitempty"`
	HermesRequires    string           `yaml:"hermes_requires" json:"hermes_requires,omitempty"`
	EnvRequirements   []EnvRequirement `yaml:"env_requires" json:"env_requires,omitempty"`
	DistributionOwned []string         `yaml:"distribution_owned" json:"distribution_owned,omitempty"`
	Source            string           `yaml:"source" json:"source,omitempty"`
}

// userOwnedExclude mirrors Hermes' USER_OWNED_EXCLUDE: paths that are NEVER
// part of a distribution and must never be copied or previewed. First-level
// entries only; nested payload under these roots is equally off-limits.
var userOwnedExclude = map[string]bool{
	// Credentials & runtime secrets
	"auth.json": true, ".env": true,
	// Databases & runtime state
	"state.db": true, "state.db-shm": true, "state.db-wal": true,
	"hermes_state.db": true, "response_store.db": true,
	"response_store.db-shm": true, "response_store.db-wal": true,
	gatewayPIDFileName: true, gatewayStateFileName: true, processesFileName: true,
	"auth.lock": true, activeProfileMarker: true, ".update_check": true,
	"errors.log": true, ".hermes_history": true,
	// User data
	"memories": true, "sessions": true, "logs": true, "plans": true,
	"workspace": true, "home": true,
	"image_cache": true, "audio_cache": true, "document_cache": true,
	"browser_screenshots": true, "checkpoints": true, "sandboxes": true,
	"backups": true, "cache": true,
	// Infrastructure & user customization namespace
	"hermes-agent": true, ".worktrees": true, "profiles": true, "bin": true,
	"node_modules": true, "local": true,
}

// defaultDistributionOwned mirrors DEFAULT_DIST_OWNED.
var defaultDistributionOwned = []string{
	soulFileName, configFileName, "mcp.json", "skills", "cron", distributionManifest,
}

func (d *DistributionManifest) ownedPaths() []string {
	if len(d.DistributionOwned) > 0 {
		return d.DistributionOwned
	}
	return defaultDistributionOwned
}

// readDistributionManifest parses distribution.yaml; nil when absent or
// malformed beyond recovery (matching Hermes' tolerant metadata reads).
func readDistributionManifest(path string) *DistributionManifest {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	manifest, err := parseDistributionManifest(data)
	if err != nil {
		return nil
	}
	return manifest
}

func parseDistributionManifest(data []byte) (*DistributionManifest, error) {
	var raw map[string]any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("failed to parse %s: %w", distributionManifest, err)
	}
	name := strings.TrimSpace(stringField(raw["name"]))
	if name == "" {
		return nil, fmt.Errorf("%s missing 'name'", distributionManifest)
	}
	manifest := &DistributionManifest{
		Name:           name,
		Version:        stringField(raw["version"]),
		Description:    stringField(raw["description"]),
		HermesRequires: stringField(raw["hermes_requires"]),
		Source:         stringField(raw["source"]),
	}
	if manifest.Version == "" {
		manifest.Version = "0.1.0"
	}
	if envRaw, ok := raw["env_requires"].([]any); ok {
		for _, entry := range envRaw {
			item, ok := entry.(map[string]any)
			if !ok {
				return nil, errors.New("env_requires entry must be a mapping")
			}
			envName := strings.TrimSpace(stringField(item["name"]))
			if envName == "" {
				return nil, errors.New("env_requires entry missing 'name'")
			}
			required := true
			if b, ok := item["required"].(bool); ok {
				required = b
			}
			manifest.EnvRequirements = append(manifest.EnvRequirements, EnvRequirement{
				Name:        envName,
				Description: stringField(item["description"]),
				Required:    required,
				Default:     stringField(item["default"]),
			})
		}
	}
	if ownedRaw, ok := raw["distribution_owned"].([]any); ok {
		for _, entry := range ownedRaw {
			s, ok := entry.(string)
			if !ok {
				continue
			}
			// Keep the raw path shape (only surrounding whitespace is
			// trimmed) so validateOwnedRelPath can still see and reject
			// leading slashes, backslashes, and ".." segments.
			trimmed := strings.TrimSpace(s)
			if trimmed != "" {
				manifest.DistributionOwned = append(manifest.DistributionOwned, trimmed)
			}
		}
	}
	return manifest, nil
}

func stringField(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

// DistributionPreview is the dry-run result for a distribution install.
type DistributionPreview struct {
	TargetName       string           `json:"target_name"`
	NewProfile       bool             `json:"new_profile"`
	Existing         bool             `json:"existing"`
	Provenance       string           `json:"provenance"`
	ManifestName     string           `json:"manifest_name"`
	Version          string           `json:"version,omitempty"`
	Description      string           `json:"description,omitempty"`
	HermesRequires   string           `json:"hermes_requires,omitempty"`
	Files            []string         `json:"files,omitempty"`
	FileCount        int              `json:"file_count"`
	EnvRequires      []EnvRequirement `json:"env_requires,omitempty"`
	SkippedUserOwned []string         `json:"skipped_user_owned,omitempty"`
	PreviewToken     string           `json:"preview_token"`
}

// stagedTree is the validated snapshot of one distribution source.
type stagedTree struct {
	dir        string
	provenance string
	manifest   *DistributionManifest
	files      []stagedFile
	digest     string
}

type stagedFile struct {
	rel  string
	size int64
	sum  string
}

// inventoryStagedTree walks a staged source once, failing closed: symlinks
// are rejected, walk/read errors abort, and file-count/size budgets are
// enforced before anything is planned or applied.
func inventoryStagedTree(staged string) ([]stagedFile, error) {
	var files []stagedFile
	var total int64
	err := filepath.WalkDir(staged, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return fmt.Errorf("cannot read %s: %w", path, err)
		}
		if d.Type()&fs.ModeSymlink != 0 {
			rel, _ := filepath.Rel(staged, path)
			return fmt.Errorf("profile distributions cannot contain symlinks: %s", rel)
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			rel, _ := filepath.Rel(staged, path)
			return fmt.Errorf("profile distributions support regular files only: %s", rel)
		}
		info, err := d.Info()
		if err != nil {
			return fmt.Errorf("cannot stat %s: %w", path, err)
		}
		if info.Size() > distMaxFileBytes {
			return fmt.Errorf("distribution file %s exceeds the per-file budget (%d bytes)", relPathOf(staged, path), info.Size())
		}
		total += info.Size()
		if total > distMaxTotal {
			return fmt.Errorf("distribution exceeds the total size budget (%d bytes)", distMaxTotal)
		}
		if len(files) >= distMaxFiles {
			return fmt.Errorf("distribution exceeds the file count budget (%d files)", distMaxFiles)
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return fmt.Errorf("cannot read %s: %w", path, readErr)
		}
		sum := sha256.Sum256(data)
		files = append(files, stagedFile{
			rel:  relPathOf(staged, path),
			size: info.Size(),
			sum:  hex.EncodeToString(sum[:]),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].rel < files[j].rel })
	return files, nil
}

func relPathOf(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(rel)
}

// treeDigest derives the preview token bound to the exact staged tree,
// resolved target, provenance, and planned operation.
func treeDigest(files []stagedFile, target string, provenance string) string {
	h := sha256.New()
	fmt.Fprintf(h, "brio-dist-v1\x00target=%s\x00provenance=%s\x00files=%d\x00", target, provenance, len(files))
	for _, f := range files {
		fmt.Fprintf(h, "f\x00%s\x00%d\x00%s\x00", f.rel, f.size, f.sum)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// validateOwnedRelPath rejects unsafe distribution-owned declarations BEFORE
// any normalization: ".." segments, absolute paths, backslashes and
// user-owned first segments are refused so a/../escape can never be
// laundered into an allowed path.
func validateOwnedRelPath(rel string) (string, string) {
	raw := strings.TrimSpace(rel)
	if raw == "" {
		return "", "empty path"
	}
	if strings.HasPrefix(raw, "/") || strings.Contains(raw, "\\") ||
		filepath.IsAbs(filepath.FromSlash(raw)) || strings.Contains(raw, ":") {
		return "", "absolute path"
	}
	cleanedDisplay := strings.Trim(raw, "/")
	for _, part := range strings.Split(cleanedDisplay, "/") {
		if part == "" {
			continue
		}
		if part == "." || part == ".." {
			return "", "unsafe segment"
		}
	}
	firstSegment := strings.SplitN(cleanedDisplay, "/", 2)[0]
	if userOwnedExclude[firstSegment] {
		return "", "user-owned"
	}
	return cleanedDisplay, ""
}

// stageAndPlan resolves a distribution source into a fully validated staged
// tree plus its plan. Git URLs (github shorthand, https/ssh, #ref pins for
// branches/tags/commits) are cloned/fetched with bounded depth; local dirs
// must already be distributions; symlinks, traversal and budget overruns
// fail closed.
func (m *ProfileManager) stageAndPlan(ctx context.Context, source string, overrideName string, workdir string) (*stagedTree, *DistributionPreview, error) {
	src := strings.TrimSpace(source)
	if src == "" {
		return nil, nil, errors.New("source is required")
	}
	base := src
	pinned := ""
	if ref, hasRef := cutRef(base); hasRef {
		base = ref.url
		pinned = ref.ref
	}
	var staged string
	provenance := NormalizeGitURL(src)
	if LooksLikeGitURL(base) {
		cloned := filepath.Join(workdir, "clone")
		url := NormalizeGitURL(base)
		if err := m.stageGit(ctx, url, cloned, pinned); err != nil {
			return nil, nil, err
		}
		if err := os.RemoveAll(filepath.Join(cloned, ".git")); err != nil {
			return nil, nil, fmt.Errorf("cannot remove temporary git metadata: %w", err)
		}
		staged = cloned
	} else {
		path := expandHome(base)
		info, statErr := os.Stat(path)
		if statErr != nil || !info.IsDir() {
			return nil, nil, fmt.Errorf("cannot resolve distribution source %q: expected a git URL or a local directory", src)
		}
		resolved, resolveErr := filepath.EvalSymlinks(path)
		if resolveErr != nil {
			return nil, nil, resolveErr
		}
		staged = resolved
		provenance = src
	}
	if !fileExists(filepath.Join(staged, distributionManifest)) {
		return nil, nil, fmt.Errorf("no %s at the root of %q: this source is not a Hermes profile distribution", distributionManifest, src)
	}
	data, err := os.ReadFile(filepath.Join(staged, distributionManifest))
	if err != nil {
		return nil, nil, err
	}
	manifest, err := parseDistributionManifest(data)
	if err != nil {
		return nil, nil, err
	}
	targetName := manifest.Name
	if strings.TrimSpace(overrideName) != "" {
		targetName = strings.TrimSpace(overrideName)
	}
	normalized, err := ValidateProfileName(targetName)
	if err != nil {
		return nil, nil, err
	}
	if normalized == DefaultProfileName {
		return nil, nil, errors.New("cannot install a distribution as 'default': that is the built-in root profile; pass a target profile name instead")
	}
	tree, err := inventoryStagedTree(staged)
	if err != nil {
		return nil, nil, err
	}
	st := &stagedTree{dir: staged, provenance: provenance, manifest: manifest, files: tree}
	st.digest = treeDigest(tree, normalized, provenance)

	planFiles, planSkipped, planErr := distributionPayloadPlan(staged, st.files, manifest)
	if planErr != nil {
		return nil, nil, planErr
	}
	plan := &DistributionPreview{
		TargetName:       normalized,
		NewProfile:       !m.Exists(normalized),
		Existing:         m.Exists(normalized),
		Provenance:       provenance,
		ManifestName:     manifest.Name,
		Version:          manifest.Version,
		Description:      manifest.Description,
		HermesRequires:   manifest.HermesRequires,
		EnvRequires:      manifest.EnvRequirements,
		PreviewToken:     st.digest,
		Files:            planFiles,
		FileCount:        len(planFiles),
		SkippedUserOwned: planSkipped,
	}
	return st, plan, nil
}

// PreviewDistribution stages a distribution safely and reports exactly what
// an install would do, plus the preview token that apply must echo.
func (m *ProfileManager) PreviewDistribution(ctx context.Context, source string, overrideName string) (*DistributionPreview, error) {
	stagingRoot, err := os.MkdirTemp("", "brio-dist-preview-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(stagingRoot)
	_, plan, err := m.stageAndPlan(ctx, source, overrideName, stagingRoot)
	if err != nil {
		return nil, err
	}
	return plan, nil
}

// distributionPayloadPlan lists the files an install would copy using
// Hermes' ownership rules. Every declared/implicit path is validated raw
// (".." segments, absolutes and backslashes are refused outright).
func distributionPayloadPlan(staged string, tree []stagedFile, manifest *DistributionManifest) ([]string, []string, error) {
	files := make([]string, 0, len(tree))
	skipped := []string{}
	byRel := make(map[string]stagedFile, len(tree))
	for _, f := range tree {
		byRel[f.rel] = f
	}

	explicitOwned := manifest.DistributionOwned
	if len(explicitOwned) == 0 {
		// Implicit ownership: every staged entry outside USER_OWNED_EXCLUDE.
		for _, f := range tree {
			firstSegment := f.rel
			if idx := strings.IndexByte(f.rel, '/'); idx >= 0 {
				firstSegment = f.rel[:idx]
			}
			switch f.rel {
			case distributionManifest:
				files = append(files, f.rel)
				continue
			case envTemplateFileName:
				continue // renamed to .env.EXAMPLE by the CLI install
			}
			if userOwnedExclude[firstSegment] {
				skipped = append(skipped, firstSegment+" (user-owned)")
				continue
			}
			files = append(files, f.rel)
		}
		sort.Strings(files)
		return dedupeStrings(files), dedupeStrings(sortedStrings(skipped)), nil
	}

	ownedSet := map[string]bool{}
	for _, rel := range explicitOwned {
		validated, reason := validateOwnedRelPath(rel)
		if reason != "" {
			skipped = append(skipped, rel+" ("+reason+")")
			continue
		}
		ownedSet[validated] = true
	}
	for _, rel := range explicitOwned {
		validated, reason := validateOwnedRelPath(rel)
		if reason != "" {
			continue // already reported above
		}
		if _, isFile := byRel[validated]; isFile {
			files = append(files, validated)
			continue
		}
		// Directory entry in the owned allowlist: include every staged file
		// under it.
		prefix := validated + "/"
		emitted := false
		for _, candidate := range tree {
			if strings.HasPrefix(candidate.rel, prefix) {
				files = append(files, candidate.rel)
				emitted = true
			}
		}
		if !emitted && ownedSet[validated] {
			skipped = append(skipped, validated+" (missing in source)")
		}
	}
	sort.Strings(files)
	return dedupeStrings(files), dedupeStrings(sortedStrings(skipped)), nil
}

// InstallDistribution applies a distribution through the stock Hermes CLI
// against the SAME validated staged tree that produced the preview. Apply
// re-stages and recomputes the digest first; if the source changed since
// preview the request is rejected instead of silently installing different
// content. Provenance (original URL/path including #ref) is preserved in the
// installed distribution.yaml after Hermes stamps its own record.
func (m *ProfileManager) InstallDistribution(ctx context.Context, source string, name string, force bool, createAlias bool, token string) (*DistributionPreview, error) {
	stagingRoot, err := os.MkdirTemp("", "brio-dist-apply-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(stagingRoot)
	tree, plan, err := m.stageAndPlan(ctx, source, name, stagingRoot)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(token) != tree.digest {
		return nil, ErrPreviewMismatch
	}
	if plan.Existing && !force {
		return nil, fmt.Errorf("profile %q already exists; pass force with explicit confirmation to overwrite it", plan.TargetName)
	}
	originalSource := strings.TrimSpace(source)
	args := []string{"profile", "install", tree.dir, "--name", plan.TargetName, "--yes"}
	if force {
		args = append(args, "--force")
	}
	if createAlias {
		args = append(args, "--alias")
	}
	if _, err := m.runHermes(ctx, args...); err != nil {
		return nil, err
	}
	// Preserve useful provenance: the CLI records its local staged path as
	// the source; restore the caller-facing original URL/path (with #ref) so
	// future `hermes profile update` re-pulls from the right place. A failed
	// patch is surfaced instead of silently claiming success with a manifest
	// that points at a temporary staging directory.
	targetDir, dirErr := m.dirFor(plan.TargetName)
	if dirErr != nil {
		return nil, fmt.Errorf("distribution installed but target dir could not be resolved for provenance: %w", dirErr)
	}
	if err := patchManifestSource(targetDir, originalSource); err != nil {
		return nil, fmt.Errorf("distribution installed but provenance could not be persisted: %w", err)
	}
	return plan, nil
}

// patchManifestSource rewrites only the `source:` field of an installed
// distribution.yaml, preserving Hermes' manifest format. Read, parse,
// marshal, and write failures are returned; nothing is silently ignored.
func patchManifestSource(profileDir string, source string) error {
	path := filepath.Join(profileDir, distributionManifest)
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", distributionManifest, err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("parse %s: %w", distributionManifest, err)
	}
	if doc == nil {
		return fmt.Errorf("%s is empty", distributionManifest)
	}
	doc["source"] = source
	encoded, err := yaml.Marshal(doc)
	if err != nil {
		return fmt.Errorf("encode %s: %w", distributionManifest, err)
	}
	if err := atomicWrite(path, encoded, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", distributionManifest, err)
	}
	return nil
}

// UpdateDistribution delegates `hermes profile update`: re-pulls the
// recorded source and overwrites distribution-owned files while user data
// stays untouched. Profiles that are not distributions fail in the pre-check.
func (m *ProfileManager) UpdateDistribution(ctx context.Context, name string, forceConfig bool) (*DistributionPreview, error) {
	normalized, err := m.normalizeExisting(name)
	if err != nil {
		return nil, err
	}
	if normalized == DefaultProfileName {
		return nil, errors.New("the default profile cannot be updated as a distribution")
	}
	dir, _ := m.dirFor(normalized)
	manifest := readDistributionManifest(filepath.Join(dir, distributionManifest))
	if manifest == nil || strings.TrimSpace(manifest.Source) == "" {
		return nil, fmt.Errorf("profile %q is not installed from a distribution with a recorded source", normalized)
	}
	args := []string{"profile", "update", normalized, "--yes"}
	if forceConfig {
		args = append(args, "--force-config")
	}
	if _, err := m.runHermes(ctx, args...); err != nil {
		return nil, err
	}
	source := strings.TrimSpace(manifest.Source)
	preview, previewErr := m.PreviewDistribution(ctx, source, normalized)
	if previewErr != nil {
		return &DistributionPreview{TargetName: normalized}, nil
	}
	return preview, nil
}
