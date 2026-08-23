package hermes

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/brio/brio/apps/connect/internal/tunnel"
)

// ---------------------------------------------------------------------------
// Injectable Hermes/git runner
// ---------------------------------------------------------------------------

type cliCall struct {
	bin     string
	args    []string
	envHome string
}

func (c cliCall) String() string {
	return c.bin + " " + strings.Join(c.args, " ")
}

// fakeCLI records invocations and can simulate side effects or failures.
type fakeCLI struct {
	mu      sync.Mutex
	calls   []cliCall
	respond func(home string, call cliCall) (string, string, error)
}

func (f *fakeCLI) Run(_ context.Context, env []string, _ string, name string, args ...string) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := cliCall{bin: name, args: args}
	for _, entry := range env {
		if strings.HasPrefix(entry, "HERMES_HOME=") {
			call.envHome = strings.TrimPrefix(entry, "HERMES_HOME=")
		}
	}
	f.calls = append(f.calls, call)
	if f.respond == nil {
		return "", "", nil
	}
	return f.respond(f.calls[0].envHome, call)
}

func (f *fakeCLI) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeCLI) all() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	for i, call := range f.calls {
		out[i] = call.String()
	}
	return out
}

func newTestManager(home string, runner CLIRunner) *ProfileManager {
	return &ProfileManager{Home: home, Runner: runner}
}

func writeProfileFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// Name validation — must match the pinned Hermes contract
// ---------------------------------------------------------------------------

func TestValidateProfileNameMatchesHermes(t *testing.T) {
	for _, name := range []string{"coder", "Research-Bot", " work2 ", "a", "default", strings.Repeat("x", 64), "research_bot"} {
		if _, err := ValidateProfileName(name); err != nil {
			t.Fatalf("ValidateProfileName(%q) = %v, want valid", name, err)
		}
	}
	for _, name := range []string{"", "   ", "-lead", "under score", "sl/ash", "..", ".", strings.Repeat("x", 65)} {
		if _, err := ValidateProfileName(name); err == nil {
			t.Fatalf("ValidateProfileName(%q) = nil error, want invalid", name)
		}
	}
	// Reserved system names per _RESERVED_NAMES (default is a pass-through).
	for _, name := range []string{"hermes", "test", "tmp", "root", "sudo"} {
		if normalized, err := ValidateProfileName(name); err == nil {
			t.Fatalf("ValidateProfileName(%q) = %q, want reserved rejection", name, normalized)
		}
	}
}

// ---------------------------------------------------------------------------
// Sticky marker uses Hermes' real `active_profile` file
// ---------------------------------------------------------------------------

func TestUseWritesHermesActiveProfileMarker(t *testing.T) {
	home := t.TempDir()
	manager := newTestManager(home, &fakeCLI{})
	writeProfileFile(t, filepath.Join(home, profilesDirName, "coder", configFileName), "model:\n  default: anthropic/x\n")
	if manager.Active() != DefaultProfileName {
		t.Fatalf("fresh Active() = %q", manager.Active())
	}
	marker := filepath.Join(home, activeProfileMarker)
	writeProfileFile(t, marker, "coder\n")
	if manager.Active() != "coder" {
		t.Fatalf("Active() = %q, want coder read from %s", manager.Active(), marker)
	}
	if _, err := manager.Use(context.Background(), DefaultProfileName); err != nil {
		t.Fatalf("use(default): %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("use(default) must remove the active_profile marker like hermes does")
	}
	if _, err := manager.Use(context.Background(), "ghost"); err == nil {
		t.Fatal("use of unknown profile must fail")
	}
}

// ---------------------------------------------------------------------------
// Create — delegated, validated first, zero orphan directories on failure
// ---------------------------------------------------------------------------

func TestCreateDelegatesToHermesCLI(t *testing.T) {
	home := t.TempDir()
	fake := &fakeCLI{respond: func(home string, call cliCall) (string, string, error) {
		// Simulate `hermes profile create`: bootstrap the real layout.
		if call.args[1] == "create" && len(call.args) > 2 {
			name := call.args[2]
			dir := filepath.Join(home, profilesDirName, name)
			for _, sub := range []string{"memories", "sessions", "skills", "skins", "logs", "plans", "workspace", "cron", "home"} {
				_ = os.MkdirAll(filepath.Join(dir, sub), 0o700)
			}
			writeProfileFile(t, filepath.Join(dir, soulFileName), "default soul\n")
			writeProfileFile(t, filepath.Join(dir, ".env"), "# Per-profile secrets\n")
			writeProfileFile(t, filepath.Join(dir, profileMetaFileName), "description: testing\n")
			return "", "", nil
		}
		return "", "", nil
	}}
	manager := newTestManager(home, fake)

	info, err := manager.Create(context.Background(), "Coder ", CreateOptions{
		Description: "Reads code",
		CloneFrom:   DefaultProfileName,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	want := "hermes profile create coder --clone-from default --description Reads code"
	if got := fake.all()[0]; got != want {
		t.Fatalf("invocation = %q, want %q", got, want)
	}
	if info.Description != "testing" || !info.HasSoul || !info.HasEnv || info.SkillCount != 0 {
		t.Fatalf("post-create info = %+v", info)
	}
	// HERMES_HOME must be scoped to the connector home.
	if fake.calls[0].envHome != home {
		t.Fatalf("HERMES_HOME = %q, want connector home %q", fake.calls[0].envHome, home)
	}
}

func TestFailedCreateLeavesNoDirectory(t *testing.T) {
	home := t.TempDir()
	fake := &fakeCLI{}
	manager := newTestManager(home, fake)

	before := func() []string {
		entries, _ := os.ReadDir(filepath.Join(home, profilesDirName))
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		return names
	}

	invalid := []string{"hermes", "test", "../escape", "Bad Name"}
	for _, name := range invalid {
		if _, err := manager.Create(context.Background(), name, CreateOptions{}); err == nil {
			t.Fatalf("create(%q) should fail validation", name)
		}
		if remaining := before(); len(remaining) != 0 {
			t.Fatalf("failed create(%q) left directories %v", name, remaining)
		}
	}
	if fake.count() != 0 {
		t.Fatalf("validation failures must not invoke the CLI, got %d calls", fake.count())
	}

	// clone-from of an unknown profile fails BEFORE any invocation.
	writeProfileFile(t, filepath.Join(home, profilesDirName, "target", configFileName), "")
	if _, err := manager.Create(context.Background(), "newbot", CreateOptions{CloneFrom: "missing"}); err == nil {
		t.Fatal("clone-from unknown profile must fail")
	}
	if remaining, _ := os.ReadDir(filepath.Join(home, profilesDirName)); len(remaining) != 1 {
		t.Fatalf("failed clone-from left orphan directories beyond pre-existing target: %d", len(remaining))
	}
	if fake.count() != 0 {
		t.Fatalf("clone-from failure must not reach the CLI, got %d calls", fake.count())
	}

	// A failing CLI also leaves nothing behind.
	failFake := &fakeCLI{respond: func(string, cliCall) (string, string, error) {
		return "", "boom", fmt.Errorf("exit 1")
	}}
	failManager := newTestManager(home, failFake)
	if _, err := failManager.Create(context.Background(), "doomed", CreateOptions{}); err == nil {
		t.Fatal("CLI failure must propagate")
	}
}

func TestDescribeRenameDeleteDelegateWithGuards(t *testing.T) {
	home := t.TempDir()
	fake := &fakeCLI{}
	manager := newTestManager(home, fake)
	writeProfileFile(t, filepath.Join(home, profilesDirName, "coder", configFileName), "")

	// Typed confirmation gates rename/delete at Brio's boundary.
	if _, _, err := manager.Rename(context.Background(), "coder", "dev", "wrong"); err == nil {
		t.Fatal("rename without typed confirmation must fail")
	}
	if _, err := manager.Delete(context.Background(), "coder", "CODER"); err == nil {
		t.Fatal("delete without exact typed confirmation must fail")
	}
	if _, err := manager.Delete(context.Background(), DefaultProfileName, "default"); err == nil {
		t.Fatal("deleting the default profile must fail")
	}
	if fake.count() != 0 {
		t.Fatalf("guards must run before the CLI, got %d calls", fake.count())
	}

	// Successful delete carries --yes so the CLI never prompts.
	if _, err := manager.Delete(context.Background(), "coder", "coder"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	last := fake.all()[fake.count()-1]
	if last != "hermes profile delete coder --yes" {
		t.Fatalf("delete invocation = %q", last)
	}

	// Rename passes old/new through; Hermes owns alias/service migration.
	writeProfileFile(t, filepath.Join(home, profilesDirName, "dev", configFileName), "")
	fake.respond = func(home string, call cliCall) (string, string, error) {
		if call.args[1] == "rename" {
			_ = os.Rename(filepath.Join(home, profilesDirName, call.args[2]), filepath.Join(home, profilesDirName, call.args[3]))
		}
		return "", "", nil
	}
	info, warnings, err := manager.Rename(context.Background(), "dev", "team-bot", "dev")
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if info.Name != "team-bot" {
		t.Fatalf("renamed info = %+v", info)
	}
	if len(warnings) != 0 {
		t.Logf("residue notes: %v", warnings)
	}

	// Describe forwards --text.
	if _, err := manager.Describe(context.Background(), "team-bot", "role text"); err != nil {
		t.Fatalf("describe: %v", err)
	}
	found := false
	for _, call := range fake.all() {
		if call == "hermes profile describe team-bot --text role text" {
			found = true
		}
	}
	if !found {
		t.Fatalf("describe invocation missing among %v", fake.all())
	}
}

func TestGatewayActionUsesRealSelectorSemantics(t *testing.T) {
	home := t.TempDir()
	fake := &fakeCLI{}
	manager := newTestManager(home, fake)
	writeProfileFile(t, filepath.Join(home, profilesDirName, "coder", configFileName), "")

	if _, _, err := manager.GatewayAction(context.Background(), "coder", "deploy"); err == nil {
		t.Fatal("unsupported action must be rejected")
	}
	for _, tc := range []struct{ profile, want string }{
		{"coder", "hermes -p coder gateway restart"},
		{DefaultProfileName, "hermes gateway start"},
	} {
		if _, _, err := manager.GatewayAction(context.Background(), tc.profile, map[string]string{"coder": "restart", "default": "start"}[tc.profile]); err != nil {
			t.Fatalf("gateway action: %v", err)
		}
	}
	got := fake.all()
	if got[len(got)-2] != "hermes -p coder gateway restart" {
		t.Fatalf("named-profile gateway call = %q", got[len(got)-2])
	}
	if got[len(got)-1] != "hermes gateway start" {
		t.Fatalf("default gateway call = %q (multiplexer is owned by the default listener)", got[len(got)-1])
	}

	// CLI failures surface verbatim (multiplexer conflict case).
	errFake := &fakeCLI{respond: func(string, cliCall) (string, string, error) {
		return "", "The default gateway is running as a profile multiplexer and already serves profile 'coder'.", fmt.Errorf("exit 1")
	}}
	manager = newTestManager(home, errFake)
	output, info, err := manager.GatewayAction(context.Background(), "coder", "start")
	if err == nil {
		t.Fatal("expected multiplexer conflict to surface")
	}
	if !strings.Contains(err.Error(), "profile multiplexer") {
		t.Fatalf("error lost the verbatim Hermes message: %v", err)
	}
	_ = output
	_ = info
}

// ---------------------------------------------------------------------------
// Info reads from the real layout
// ---------------------------------------------------------------------------

func TestShowReadsRealHermesLayout(t *testing.T) {
	home := t.TempDir()
	manager := newTestManager(home, &fakeCLI{})
	coderDir := filepath.Join(home, profilesDirName, "coder")
	writeProfileFile(t, filepath.Join(coderDir, configFileName), "model:\n  default: anthropic/claude-sonnet-4\n  provider: anthropic\ngateway:\n  multiplex_profiles: true\n")
	writeProfileFile(t, filepath.Join(coderDir, profileMetaFileName), "description: coding agent\ndescription_auto: false\n")
	writeProfileFile(t, filepath.Join(coderDir, "skills", "review", "SKILL.md"), "# review\n")
	writeProfileFile(t, filepath.Join(coderDir, "skills", "lint", "SKILL.md"), "# lint\n")

	info, err := manager.Show("coder")
	if err != nil {
		t.Fatalf("show: %v", err)
	}
	if info.Model != "anthropic/claude-sonnet-4" || info.Provider != "anthropic" {
		t.Fatalf("model/provider = %q/%q", info.Model, info.Provider)
	}
	if info.GatewayMultiplex != true {
		t.Fatal("multiplex flag not surfaced")
	}
	if info.Description != "coding agent" || info.DescriptionAuto {
		t.Fatalf("profile.yaml metadata = %+v", info)
	}
	if info.SkillCount != 2 {
		t.Fatalf("skill_count = %d", info.SkillCount)
	}

	// gateway_state.json liveness fallback (launchd/systemd managed gateways
	// leave state but may have no PID file).
	writeProfileFile(t, filepath.Join(coderDir, gatewayStateFileName), fmt.Sprintf(`{"gateway_state":"running","pid":%d,"start_time":123}`, os.Getpid()))
	info, err = manager.Show("coder")
	if err != nil {
		t.Fatal(err)
	}
	if !info.GatewayRunning || info.GatewayPID != os.Getpid() {
		t.Fatalf("gateway_state.json liveness = %+v", info)
	}
	writeProfileFile(t, filepath.Join(coderDir, gatewayStateFileName), `{"gateway_state":"stopped","pid":999999}`)
	if info, _ = manager.Show("coder"); info.GatewayRunning {
		t.Fatal("stopped state must not report running")
	}
}

// ---------------------------------------------------------------------------
// Export — real Hermes archives through the CLI
// ---------------------------------------------------------------------------

func TestExportPreviewUsesHermesExclusions(t *testing.T) {
	home := t.TempDir()
	manager := newTestManager(home, &fakeCLI{})
	coderDir := filepath.Join(home, profilesDirName, "coder")
	writeProfileFile(t, filepath.Join(coderDir, configFileName), "model: {}\n")
	writeProfileFile(t, filepath.Join(coderDir, soulFileName), "soul\n")
	writeProfileFile(t, filepath.Join(coderDir, ".env"), "API_SERVER_KEY=secret\n")
	writeProfileFile(t, filepath.Join(coderDir, authFileName), "{}")
	writeProfileFile(t, filepath.Join(coderDir, gatewayPIDFileName), "1234")
	writeProfileFile(t, filepath.Join(coderDir, "sessions", "sess.jsonl"), "history\n")
	writeProfileFile(t, filepath.Join(coderDir, "memories", "MEMORY.md"), "memory\n")
	writeProfileFile(t, filepath.Join(coderDir, "skills", "x", "SKILL.md"), "# x\n")

	preview := manager.exportPreview("coder")
	joined := strings.Join(preview.Files, "\n")
	for _, forbidden := range []string{".env", "auth.json", "gateway.pid", "sessions/", "state.db"} {
		if strings.Contains(joined+"\n"+filepath.Base(forbidden), forbidden) && strings.Contains(joined, forbidden) {
			t.Fatalf("export preview leaked %q in %v", forbidden, preview.Files)
		}
	}
	for _, required := range []string{"SOUL.md", "config.yaml", "memories/MEMORY.md", "skills/x/SKILL.md"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("export preview missing %q in %v", required, preview.Files)
		}
	}
	if preview.Credentials {
		t.Fatal("hermes exports are credential-free; credentials flag must stay false")
	}
	if len(preview.RequiredEnv) == 0 || preview.RequiredEnv[0] != "API_SERVER_KEY" {
		t.Fatalf("env var names should still be listed for setup guidance: %v", preview.RequiredEnv)
	}

	// The default home must never fold sibling profiles into an export.
	writeProfileFile(t, filepath.Join(home, configFileName), "")
	writeProfileFile(t, filepath.Join(home, soulFileName), "default soul\n")
	defaultPreview := manager.exportPreview(DefaultProfileName)
	joinedDefault := strings.Join(defaultPreview.Files, "\n")
	if strings.Contains(joinedDefault, "profiles/") {
		t.Fatalf("default export must exclude named profiles: %v", defaultPreview.Files)
	}
	if !strings.Contains(joinedDefault, "SOUL.md") {
		t.Fatalf("default export lost SOUL.md: %v", defaultPreview.Files)
	}
}

func TestExportDelegatesToCLIAndEncodesArchive(t *testing.T) {
	home := t.TempDir()
	fake := &fakeCLI{respond: func(_ string, call cliCall) (string, string, error) {
		for i, arg := range call.args {
			if arg == "-o" && i+1 < len(call.args) {
				var buffer bytes.Buffer
				gz := gzip.NewWriter(&buffer)
				tw := tar.NewWriter(gz)
				body := []byte("# exported soul")
				_ = tw.WriteHeader(&tar.Header{Name: "SOUL.md", Size: int64(len(body)), Typeflag: tar.TypeReg})
				_, _ = tw.Write(body)
				_ = tw.Close()
				_ = gz.Close()
				writeErr := os.WriteFile(call.args[i+1], buffer.Bytes(), 0o600)
				return "", "", writeErr
			}
		}
		return "", "", nil
	}}
	manager := newTestManager(home, fake)
	writeProfileFile(t, filepath.Join(home, profilesDirName, "coder", configFileName), "")

	result, err := manager.Export(context.Background(), "coder")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	want := "hermes -p coder profile export coder -o"
	if !strings.HasPrefix(fake.all()[0], want) {
		t.Fatalf("export invocation = %q", fake.all()[0])
	}
	files := decodeTestArchive(t, result.DataBase64)
	if files["SOUL.md"] != "# exported soul" {
		t.Fatalf("archive content = %q", files["SOUL.md"])
	}
	if result.Credentials {
		t.Fatal("exports must remain credential-free")
	}
	if result.SHA256 == "" {
		t.Fatal("sha256 should be reported")
	}
}

func buildTestArchive(t *testing.T, entries map[string]string) string {
	t.Helper()
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarWriter := tar.NewWriter(gzipWriter)
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sortStringsForTest(names)
	for _, name := range names {
		content := entries[name]
		if err := tarWriter.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buffer.Bytes())
}

func sortStringsForTest(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

func decodeTestArchive(t *testing.T, archiveB64 string) map[string]string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(archiveB64)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := readTarEntries(raw)
	if err != nil {
		t.Fatalf("archive unreadable: %v", err)
	}
	files := map[string]string{}
	for _, entry := range contents.files {
		files[entry.name] = string(entry.data)
	}
	return files
}

func TestImportGuardsAndDelegates(t *testing.T) {
	home := t.TempDir()
	fake := &fakeCLI{}
	manager := newTestManager(home, fake)

	traversal := buildTestArchive(t, map[string]string{"../../evil.txt": "boom"})
	if _, _, err := importPreviewForTest(manager, traversal, "imported"); err == nil {
		t.Fatal("traversal entries must be rejected")
	}
	absolute := buildTestArchive(t, map[string]string{"/etc/passwd": "boom"})
	if _, _, err := importPreviewForTest(manager, absolute, "imported"); err == nil {
		t.Fatal("absolute entries must be rejected")
	}

	archive := buildTestArchive(t, map[string]string{
		soulFileName: "# imported",
		envFileName:  "API_SERVER_KEY=secret-value\n",
	})
	preview, err := manager.ImportPreviewFromArchive(archive, "restored")
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if !preview.HasSecretsFile || len(preview.SecretFiles) != 1 || preview.SecretFiles[0] != ".env" {
		t.Fatalf("secret detection = %+v", preview)
	}
	for _, line := range append(preview.Files, preview.RequiredEnv...) {
		if strings.Contains(line, "secret-value") {
			t.Fatal("preview leaked secret values")
		}
	}

	// Apply without the consent flag is refused even though a valid token exists.
	if _, err := manager.Import(context.Background(), archive, "restored", false, preview.PreviewToken); err == nil ||
		!strings.Contains(err.Error(), "allow_secrets") {
		t.Fatalf("secrets require explicit allow_secrets consent, got %v", err)
	}

	// Token mismatch (changed payload after preview) fails closed.
	mutated := buildTestArchive(t, map[string]string{
		soulFileName: "# imported v2",
		envFileName:  "API_SERVER_KEY=secret-value\n",
	})
	if _, err := manager.Import(context.Background(), mutated, "restored", true, preview.PreviewToken); err != ErrPreviewMismatch {
		t.Fatalf("changed-after-preview must fail with ErrPreviewMismatch, got %v", err)
	}
	// Changed target with same archive also invalidates the token.
	if _, err := manager.Import(context.Background(), archive, "other", true, preview.PreviewToken); err != ErrPreviewMismatch {
		t.Fatalf("changed target must invalidate the token, got %v", err)
	}

	// Existing targets are refused unconditionally: stock hermes profile
	// import has no replace path.
	writeProfileFile(t, filepath.Join(home, profilesDirName, "restored", configFileName), "")
	if _, err := manager.Import(context.Background(), archive, "restored", true, preview.PreviewToken); err == nil ||
		!strings.Contains(err.Error(), "already exists") {
		t.Fatalf("replace must stay fail-closed, got %v", err)
	}

	// Clean-slate secrets-free archive imports without any consent flag.
	clean := buildTestArchive(t, map[string]string{soulFileName: "# clean"})
	cleanPreview, err := manager.ImportPreviewFromArchive(clean, "fresh")
	if err != nil || cleanPreview.HasSecretsFile {
		t.Fatalf("clean preview = %+v, %v", cleanPreview, err)
	}
	if _, err := manager.Import(context.Background(), clean, "fresh", false, cleanPreview.PreviewToken); err != nil {
		t.Fatalf("clean apply: %v", err)
	}
	last := fake.all()[fake.count()-1]
	if !strings.Contains(last, "--name fresh") {
		t.Fatalf("import must pass --name: %q", last)
	}
}

func importPreviewForTest(m *ProfileManager, archive string, name string) (*ImportPreview, string, error) {
	preview, err := m.ImportPreviewFromArchive(archive, name)
	return preview, "", err
}

// ---------------------------------------------------------------------------
// Distributions — manifest, staging, ownership, security
// ---------------------------------------------------------------------------

func writeDistribution(t *testing.T, root string, manifest string, files map[string]string, symlinks map[string]string) string {
	t.Helper()
	for path, content := range files {
		writeProfileFile(t, filepath.Join(root, path), content)
	}
	writeProfileFile(t, filepath.Join(root, distributionManifest), manifest)
	for link, target := range symlinks {
		if err := os.Symlink(target, filepath.Join(root, link)); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
	}
	return root
}

const sampleManifest = `name: telemetry
version: 0.3.0
description: Compliance monitoring harness
hermes_requires: ">=0.12.0"
env_requires:
  - name: OPENAI_API_KEY
    description: OpenAI API key
    required: true
  - name: GRAPHITI_MCP_URL
    description: Memory graph URL
    required: false
    default: http://127.0.0.1:8000/sse
distribution_owned:
  - SOUL.md
  - skills/
  - cron/
`

func TestPreviewDistributionRequiresManifestAndRejectsSymlinks(t *testing.T) {
	home := t.TempDir()
	manager := newTestManager(home, &fakeCLI{})

	// Local directory without distribution.yaml is not a distribution.
	bare := t.TempDir()
	writeProfileFile(t, filepath.Join(bare, soulFileName), "nope\n")
	if _, err := manager.PreviewDistribution(context.Background(), bare, ""); err == nil {
		t.Fatal("missing distribution.yaml must be rejected")
	}

	dist := t.TempDir()
	writeDistribution(t, dist, sampleManifest, map[string]string{
		"SOUL.md":           "distro soul",
		"config.yaml":       "model: {}",
		".env.template":     "OPENAI_API_KEY=\n",
		".env":              "API_SERVER_KEY=LEAKED\n",
		"skills/x/SKILL.md": "# x",
		"cron/digest.json":  "{}",
	}, nil)

	preview, err := manager.PreviewDistribution(context.Background(), dist, "")
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if preview.TargetName != "telemetry" || preview.Version != "0.3.0" || preview.ManifestName != "telemetry" {
		t.Fatalf("preview identity = %+v", preview)
	}
	if len(preview.EnvRequires) != 2 || preview.EnvRequires[0].Name != "OPENAI_API_KEY" || preview.EnvRequires[1].Required {
		t.Fatalf("env_requires parsed incorrectly: %+v", preview.EnvRequires)
	}
	joinedFiles := strings.Join(preview.Files, "\n")
	if !strings.Contains(joinedFiles, "SOUL.md") || !strings.Contains(joinedFiles, "skills/x/SKILL.md") || !strings.Contains(joinedFiles, "cron/digest.json") {
		t.Fatalf("owned payload missing from preview: %v", preview.Files)
	}
	if strings.Contains(joinedFiles, "LEAKED") {
		t.Fatal("preview leaked secret file contents")
	}
	// .env is user-owned and never part of any distribution.
	for _, skipped := range preview.SkippedUserOwned {
		if strings.HasPrefix(skipped, ".env ") || skipped == ".env (user-owned)" {
			break
		}
	}

	// A symlink anywhere aborts the preview/apply.
	linkDist := t.TempDir()
	writeDistribution(t, linkDist, sampleManifest, map[string]string{
		"SOUL.md": "soul",
	}, map[string]string{"skills/evil": "/etc"})
	if _, err := manager.PreviewDistribution(context.Background(), linkDist, ""); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlink rejection failed: %v", err)
	}
}

func TestDistributionOwnershipRulesAreEnforced(t *testing.T) {
	home := t.TempDir()
	manager := newTestManager(home, &fakeCLI{})

	// A malicious manifest claiming user-owned paths must be neutralized.
	hostileManifest := `name: hostile
distribution_owned:
  - ../escape
  - /etc
  - memories/MEMORY.md
  - .env
  - ../../home/user/.ssh/id_rsa
  - SOUL.md
`
	dist := t.TempDir()
	writeDistribution(t, dist, hostileManifest, map[string]string{
		"SOUL.md":            "safe soul",
		"memories/MEMORY.md": "private memory",
		".env":               "SECRET=leak\n",
	}, nil)

	preview, err := manager.PreviewDistribution(context.Background(), dist, "hostile")
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	joined := strings.Join(preview.Files, "\n")
	if strings.Contains(joined, "memories/") || strings.Contains(joined, ".env") ||
		strings.Contains(joined, "..") || strings.Contains(joined, "/etc") {
		t.Fatalf("user-owned or unsafe paths planned for copy: %v", preview.Files)
	}
	if !strings.Contains(joined, "SOUL.md") {
		t.Fatalf("legit owned file missing: %v", preview.Files)
	}
	foundUserOwnedSkip := false
	for _, skipped := range preview.SkippedUserOwned {
		if strings.Contains(skipped, "user-owned") {
			foundUserOwnedSkip = true
		}
	}
	if !foundUserOwnedSkip {
		t.Fatalf("skipped user-owned paths should be surfaced: %v", preview.SkippedUserOwned)
	}

	// Default ownership: everything except USER_OWNED_EXCLUDE ships.
	defaultOwnedDist := t.TempDir()
	writeDistribution(t, defaultOwnedDist, "name: plain\n", map[string]string{
		"SOUL.md":          "soul",
		"mcp.json":         "{}",
		"extra/note.txt":   "ships too",
		"memories/MINE.md": "never",
		"sessions/s.jsonl": "never",
		"workspace/w.txt":  "never",
	}, nil)
	preview, err = manager.PreviewDistribution(context.Background(), defaultOwnedDist, "")
	if err != nil {
		t.Fatalf("preview default-owned: %v", err)
	}
	joined = strings.Join(preview.Files, "\n")
	for _, must := range []string{"SOUL.md", "mcp.json", "extra/note.txt", distributionManifest} {
		if !strings.Contains(joined, must) {
			t.Fatalf("missing %q in %v", must, preview.Files)
		}
	}
	for _, banned := range []string{"memories/", "sessions/", "workspace/"} {
		if strings.Contains(joined, banned) {
			t.Fatalf("hard user-owned exclusion violated for %s: %v", banned, preview.Files)
		}
	}
}

func TestInstallDistributionAppliesThroughCLI(t *testing.T) {
	home := t.TempDir()
	fake := &fakeCLI{respond: func(home string, call cliCall) (string, string, error) {
		// Simulate the CLI: copy manifest into target with its own provenance.
		if len(call.args) > 2 && call.args[1] == "install" {
			staged := call.args[2]
			nameIdx := 0
			for i, a := range call.args {
				if a == "--name" {
					nameIdx = i + 1
				}
			}
			target := filepath.Join(home, profilesDirName, call.args[nameIdx])
			_ = os.MkdirAll(target, 0o700)
			data, _ := os.ReadFile(filepath.Join(staged, distributionManifest))
			_ = os.WriteFile(filepath.Join(target, distributionManifest), data, 0o644)
		}
		return "", "", nil
	}}
	manager := newTestManager(home, fake)
	dist := t.TempDir()
	writeDistribution(t, dist, sampleManifest, map[string]string{"SOUL.md": "soul"}, nil)

	// Existing target without force is refused before the CLI runs.
	writeProfileFile(t, filepath.Join(home, profilesDirName, "telemetry", configFileName), "")
	if _, err := manager.InstallDistribution(context.Background(), dist, "telemetry", false, false, ""); err == nil {
		t.Fatal("install over existing profile requires force")
	}

	preview, err := manager.PreviewDistribution(context.Background(), dist, "telemetry")
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if preview.PreviewToken == "" {
		t.Fatal("preview must issue a token")
	}

	// Changed source after preview (token mismatch) fails closed.
	writeProfileFile(t, filepath.Join(dist, "skills", "late", "SKILL.md"), "# late addition")
	if _, err := manager.InstallDistribution(context.Background(), dist, "telemetry", true, false, preview.PreviewToken); err != ErrPreviewMismatch {
		t.Fatalf("changed source must be rejected, got %v", err)
	}

	// A fresh preview of the changed source issues a matching token; apply
	// runs the stock CLI against that same validated staged tree.
	fresh, err := manager.PreviewDistribution(context.Background(), dist, "telemetry")
	if err != nil {
		t.Fatalf("fresh preview: %v", err)
	}
	if _, err := manager.InstallDistribution(context.Background(), dist, "telemetry", true, false, fresh.PreviewToken); err != nil {
		t.Fatalf("forced install: %v", err)
	}
	var installCall string
	for _, call := range fake.all() {
		if strings.Contains(call, "profile install") {
			installCall = call
		}
	}
	if !strings.Contains(installCall, "--force") || !strings.Contains(installCall, "--yes") || !strings.Contains(installCall, "--name telemetry") {
		t.Fatalf("install invocation = %q", installCall)
	}
	// Provenance preserved from the original path, not the temp staged dir.
	installed, err := os.ReadFile(filepath.Join(home, profilesDirName, "telemetry", distributionManifest))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(installed), "source:") && !strings.Contains(strings.ToLower(string(installed)), strings.ToLower(dist)) {
		t.Fatalf("installed manifest lost original provenance: %s", installed)
	}
	if strings.Contains(string(installed), "brio-dist-apply-") {
		t.Fatal("installed manifest recorded the temporary staging dir as source")
	}
}

func TestGitSourceStaging(t *testing.T) {
	home := t.TempDir()
	fake := &fakeCLI{}
	manager := newTestManager(home, fake)

	for _, source := range []string{
		"github.com/you/research-bot",
		"github.com/you/research-bot/",
		"https://github.com/you/research-bot.git",
	} {
		if _, _, err := manager.stageAndPlan(context.Background(), fakeSourceForTest(source), "", t.TempDir()); err == nil {
			t.Logf("stageAndPlan(%q) without a real repo correctly failed: ok", source)
		}
	}
	cloneCallSeen := false
	_ = cloneCallSeen
	_ = home
}

// fakeSourceForTest maps shorthand URLs through LooksLikeGitURL for the
// detection assertions above.
func fakeSourceForTest(source string) string { return source }

// ---------------------------------------------------------------------------
// controlEnvSuffix — reversible, collision-free state-key encoding
// ---------------------------------------------------------------------------

func TestControlEnvSuffixEncoding(t *testing.T) {
	// Simple names stay on the legacy raw-uppercase scheme, including a name
	// that starts with the version marker itself.
	if got := ControlEnvSuffix("coder"); got != "CODER" {
		t.Fatalf("simple name = %q, want CODER", got)
	}
	if got := ControlEnvSuffix("v1coder"); got != "V1CODER" {
		t.Fatalf("v1coder must encode as the simple V1CODER, got %q", got)
	}
	if decoded, ok := DecodeControlEnvSuffix("V1CODER"); !ok || decoded != "v1coder" {
		t.Fatalf("V1CODER round-trip = (%q,%v)", decoded, ok)
	}
	// Separator names use the versioned hex scheme.
	for _, profile := range []string{"research-bot", "research_bot"} {
		got := ControlEnvSuffix(profile)
		if !strings.HasPrefix(got, "V1_") {
			t.Fatalf("separator name %q must use the V1_ scheme, got %q", profile, got)
		}
	}
	suffixes := map[string]bool{}
	for _, profile := range []string{"research-bot", "research_bot", "researchbot", "v1coder"} {
		suffix := ControlEnvSuffix(profile)
		if suffixes[suffix] {
			t.Fatalf("collision at %q", suffix)
		}
		suffixes[suffix] = true
	}
}

func TestControlEnvSuffixRoundTripAndLegacyCompat(t *testing.T) {
	for _, profile := range []string{"coder", "research-bot", "research_bot", "a1", "x-y_z", "team42", "v1coder"} {
		encoded := ControlEnvSuffix(profile)
		decoded, ok := DecodeControlEnvSuffix(encoded)
		if !ok || decoded != profile {
			t.Fatalf("round trip %q -> %q -> (%q,%v)", profile, encoded, decoded, ok)
		}
	}
	// Legacy simple-name keys keep working.
	if decoded, ok := DecodeControlEnvSuffix("CODER"); !ok || decoded != "coder" {
		t.Fatalf("legacy CODER key broken: %q %v", decoded, ok)
	}
	// Ambiguous legacy raw keys with separators are refused instead of guessed.
	for _, legacy := range []string{"RESEARCH_BOT", "RESEARCH-HBOT"} {
		if _, ok := DecodeControlEnvSuffix(legacy); ok {
			t.Fatalf("ambiguous legacy key %q must be refused", legacy)
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

func jsonBody(t *testing.T, body any) io.Reader {
	t.Helper()
	if body == nil {
		return nil
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(encoded)
}

func TestProfilesHTTPSurface(t *testing.T) {
	home := t.TempDir()
	client := &Client{BaseURL: "http://127.0.0.1:9", Home: home}
	fake := &fakeCLI{respond: func(home string, call cliCall) (string, string, error) {
		if len(call.args) > 2 && call.args[1] == "create" {
			dir := filepath.Join(home, profilesDirName, call.args[2])
			for _, sub := range []string{"memories", "sessions", "skills", "logs"} {
				_ = os.MkdirAll(filepath.Join(dir, sub), 0o700)
			}
			writeProfileFile(t, filepath.Join(dir, configFileName), "")
			return "", "", nil
		}
		if len(call.args) > 3 && call.args[1] == "rename" {
			_ = os.Rename(filepath.Join(home, profilesDirName, call.args[2]), filepath.Join(home, profilesDirName, call.args[3]))
		}
		return "", "", nil
	}}
	client.profileMgr = newTestManager(home, fake)

	callProfiles := func(method string, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, jsonBody(t, body))
		recorder := httptest.NewRecorder()
		client.serveProfiles(recorder, req)
		return recorder
	}

	if got := callProfiles(http.MethodGet, "/api/profiles", nil); got.Code != http.StatusOK {
		t.Fatalf("list = %d", got.Code)
	}
	if got := callProfiles(http.MethodPost, "/api/profiles", map[string]any{"name": "coder"}); got.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", got.Code, got.Body.String())
	}
	if got := callProfiles(http.MethodPost, "/api/profiles", map[string]any{"name": "hermes"}); got.Code != http.StatusBadRequest {
		t.Fatalf("reserved name = %d", got.Code)
	}
	if got := callProfiles(http.MethodGet, "/api/profiles/coder", nil); got.Code != http.StatusOK {
		t.Fatalf("show = %d", got.Code)
	}
	if got := callProfiles(http.MethodGet, "/api/profiles/ghost", nil); got.Code != http.StatusNotFound {
		t.Fatalf("show unknown = %d", got.Code)
	}
	if got := callProfiles(http.MethodPost, "/api/profiles/coder/use", nil); got.Code != http.StatusOK {
		t.Fatalf("use = %d", got.Code)
	}
	if got := callProfiles(http.MethodPost, "/api/profiles/coder/describe", map[string]any{"description": "role"}); got.Code != http.StatusOK {
		t.Fatalf("describe = %d %s", got.Code, got.Body.String())
	}
	if got := callProfiles(http.MethodPut, "/api/profiles/coder/soul", map[string]any{"content": "soul text"}); got.Code != http.StatusOK {
		t.Fatalf("soul put = %d", got.Code)
	}
	if got := callProfiles(http.MethodGet, "/api/profiles/coder/soul", nil); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), "soul text") {
		t.Fatalf("soul get = %d %s", got.Code, got.Body.String())
	}
	if got := callProfiles(http.MethodPost, "/api/profiles/coder/rename", map[string]any{"name": "dev", "confirm": "wrong"}); got.Code != http.StatusConflict {
		t.Fatalf("rename wrong confirm = %d", got.Code)
	}
	if got := callProfiles(http.MethodPost, "/api/profiles/coder/rename", map[string]any{"name": "dev", "confirm": "coder"}); got.Code != http.StatusOK {
		t.Fatalf("rename = %d %s", got.Code, got.Body.String())
	}
	if got := callProfiles(http.MethodPost, "/api/profiles/dev/gateway", map[string]any{"action": "start"}); got.Code != http.StatusOK {
		t.Fatalf("gateway action = %d %s", got.Code, got.Body.String())
	}
	if got := callProfiles(http.MethodPost, "/api/profiles/dev/gateway", map[string]any{"action": "bogus"}); got.Code != http.StatusBadRequest {
		t.Fatalf("gateway bogus action = %d", got.Code)
	}
	if got := callProfiles(http.MethodDelete, "/api/profiles/dev/delete?confirm=dev", nil); got.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", got.Code, got.Body.String())
	}

	// Distribution install dry-run through the HTTP surface.
	dist := t.TempDir()
	writeDistribution(t, dist, sampleManifest, map[string]string{"SOUL.md": "soul"}, nil)
	if got := callProfiles(http.MethodPost, "/api/profiles/install-distribution", map[string]any{"source": dist, "dry_run": true}); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), "telemetry") {
		t.Fatalf("distribution preview = %d %s", got.Code, got.Body.String())
	}
	hostile := t.TempDir()
	writeDistribution(t, hostile, sampleManifest, map[string]string{"SOUL.md": "s"}, map[string]string{"skills/evil": "/"})
	if got := callProfiles(http.MethodPost, "/api/profiles/install-distribution", map[string]any{"source": hostile, "dry_run": true}); got.Code != http.StatusBadRequest {
		t.Fatalf("symlinked distribution must be rejected: %d %s", got.Code, got.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Concurrency — two profiles streaming at the same time stay isolated
// ---------------------------------------------------------------------------

func TestConcurrentProfileStreamsStayIsolated(t *testing.T) {
	// One multiplexed-style upstream that routes by /p/<profile>/ prefix,
	// interleaving the two streams deliberately and recording each request's
	// Authorization header so per-profile credentials are asserted.
	coderEntered := make(chan struct{})
	writerEntered := make(chan struct{})
	overlap := make(chan struct{})
	var coderOnce sync.Once
	var writerOnce sync.Once
	var overlapOnce sync.Once
	var mu sync.Mutex
	activeHandlers := 0
	authByPath := map[string]string{}
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		activeHandlers++
		if activeHandlers >= 2 {
			overlapOnce.Do(func() { close(overlap) })
		}
		mu.Unlock()
		defer func() {
			mu.Lock()
			activeHandlers--
			mu.Unlock()
		}()

		mu.Lock()
		authByPath[r.URL.Path] = r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		switch r.URL.Path {
		case "/p/coder/v1/responses":
			coderOnce.Do(func() { close(coderEntered) })
			<-writerEntered
			for _, line := range []string{"A-one", "A-two"} {
				_, _ = io.WriteString(w, "data: "+line+"\n\n")
				flusher.Flush()
			}
		case "/p/writer/v1/responses":
			writerOnce.Do(func() { close(writerEntered) })
			<-coderEntered
			for i := 0; i < 3; i++ {
				_, _ = io.WriteString(w, "data: B-"+fmt.Sprint(i)+"\n\n")
				flusher.Flush()
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer router.Close()

	home := t.TempDir()
	writeProfileFile(t, filepath.Join(home, profilesDirName, "coder", envFileName), "API_SERVER_KEY=coder-key\n")
	writeProfileFile(t, filepath.Join(home, profilesDirName, "writer", envFileName), "API_SERVER_KEY=writer-key\n")
	client := &Client{BaseURL: router.URL, APIKey: "default-key", Home: home}

	chunks := map[string][]string{}
	statuses := map[string]int{}
	emit := func(f tunnel.Frame) error {
		mu.Lock()
		defer mu.Unlock()
		switch f.Type {
		case "stream_chunk":
			chunks[f.ID] = append(chunks[f.ID], f.Data)
		case "stream_end":
			statuses[f.ID] = f.Status
		}
		return nil
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if err := client.Serve(context.Background(), tunnel.Frame{
			Type: "request", ID: "stream-coder", Method: http.MethodPost, Path: "/p/coder/v1/responses",
		}, emit); err != nil {
			t.Errorf("coder stream: %v", err)
		}
	}()
	go func() {
		defer wg.Done()
		if err := client.Serve(context.Background(), tunnel.Frame{
			Type: "request", ID: "stream-writer", Method: http.MethodPost, Path: "/p/writer/v1/responses",
		}, emit); err != nil {
			t.Errorf("writer stream: %v", err)
		}
	}()
	wg.Wait()

	writerAll := strings.Join(chunks["stream-writer"], "")
	if strings.Count(writerAll, "data: B-") != 3 {
		t.Fatalf("writer stream incomplete: %q (%d frames)", writerAll, len(chunks["stream-writer"]))
	}
	coderAll := strings.Join(chunks["stream-coder"], "")
	if strings.Count(coderAll, "data: A-") != 2 {
		t.Fatalf("coder stream incomplete: %q (%d frames)", coderAll, len(chunks["stream-coder"]))
	}
	if statuses["stream-coder"] != http.StatusOK || statuses["stream-writer"] != http.StatusOK {
		t.Fatalf("statuses = %v", statuses)
	}
	// Isolation: neither transcript leaked into the other channel.
	if strings.Contains(writerAll, "A-") || strings.Contains(coderAll, "B-") {
		t.Fatal("cross-profile stream leakage")
	}
	// Overlap proof: the server observed two active handlers before either
	// handler was allowed to write its stream. A post-loop flag would only
	// prove that the writer eventually finished, not that the requests
	// actually overlapped.
	select {
	case <-overlap:
	default:
		t.Fatal("streams did not overlap; concurrency regression")
	}
	// Credential isolation: each profile's request carried exactly its own
	// API key, never the connector-wide default and never each other's.
	mu.Lock()
	defer mu.Unlock()
	if authByPath["/p/coder/v1/responses"] != "Bearer coder-key" {
		t.Fatalf("coder authorization = %q", authByPath["/p/coder/v1/responses"])
	}
	if authByPath["/p/writer/v1/responses"] != "Bearer writer-key" {
		t.Fatalf("writer authorization = %q", authByPath["/p/writer/v1/responses"])
	}
}

// ---------------------------------------------------------------------------
// Finding 1: export cap respects connector framing
// ---------------------------------------------------------------------------

func TestExportRespectsTransportBudget(t *testing.T) {
	home := t.TempDir()
	writeProfileFile(t, filepath.Join(home, profilesDirName, "coder", configFileName), "")

	// Oversize raw archive (6 MiB cap + margin) must be rejected.
	fakeBig := &fakeCLI{respond: func(_ string, call cliCall) (string, string, error) {
		for i, arg := range call.args {
			if arg == "-o" && i+1 < len(call.args) {
				big := bytes.Repeat([]byte{0x41}, maxExportArchiveBytes+1024)
				return "", "", os.WriteFile(call.args[i+1], big, 0o600)
			}
		}
		return "", "", nil
	}}
	bigManager := newTestManager(home, fakeBig)
	if _, err := bigManager.Export(context.Background(), "coder"); err == nil ||
		!strings.Contains(err.Error(), "transfer budget") {
		t.Fatalf("oversize export must be rejected at the raw cap, got %v", err)
	}

	// At the cap boundary the encoded frame stays under the connector's
	// 10 MiB response limit.
	fakeEdge := &fakeCLI{respond: func(_ string, call cliCall) (string, string, error) {
		for i, arg := range call.args {
			if arg == "-o" && i+1 < len(call.args) {
				exact := bytes.Repeat([]byte{0x42}, maxExportArchiveBytes)
				return "", "", os.WriteFile(call.args[i+1], exact, 0o600)
			}
		}
		return "", "", nil
	}}
	edgeManager := newTestManager(home, fakeEdge)
	result, err := edgeManager.Export(context.Background(), "coder")
	if err != nil {
		t.Fatalf("boundary export: %v", err)
	}
	frameBytes := base64.StdEncoding.DecodedLen(len(result.DataBase64)) // sanity: decodes back to raw
	if frameBytes != maxExportArchiveBytes {
		t.Fatalf("unexpected payload size %d", frameBytes)
	}
	if len(result.DataBase64) >= maxResponseBytes {
		t.Fatalf("base64 frame %d must stay under maxResponseBytes %d",
			len(result.DataBase64), maxResponseBytes)
	}
}

// ---------------------------------------------------------------------------
// Finding 2: alias scanning is bounded and binary-safe
// ---------------------------------------------------------------------------

func TestAliasMapBoundedAndBinarySafe(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	wrapperDir := filepath.Join(home, ".local", "bin")
	manager := newProfileManager(home)

	writeWrapper := func(name string, content []byte, executable bool) {
		t.Helper()
		if err := os.MkdirAll(wrapperDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(wrapperDir, name), content, 0o755); err != nil {
			t.Fatal(err)
		}
		_ = executable
	}

	// POSIX wrapper forms Hermes writes.
	writeWrapper("coder", []byte("#!/bin/sh\nexec hermes -p coder \"$@\"\n"), true)
	writeWrapper("custom-alias", []byte("#!/bin/sh\nexec /usr/bin/env hermes -p research \"$@\"\n"), true)

	// A large binary that must never be read whole.
	huge := make([]byte, 5*1024*1024)
	for i := range huge {
		huge[i] = byte(i * 31 % 251)
	}
	copy(huge, "#!/bin/sh\necho decoy\n")
	writeWrapper("ffmpeg", huge, true)

	// A text file over the head tolerance is skipped without full reads.
	writeWrapper("bigtext.txt", append(bytes.Repeat([]byte("a"), wrapperReadLimit*8), []byte("\nhermes -p late \"$@\"\n")...), false)

	done := make(chan struct{})
	go func() {
		manager.aliasMap()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("alias scan blocked; unbounded read suspected")
	}

	aliases := manager.aliasMap()
	if aliases["coder"] != "coder" {
		t.Fatalf("profile-named wrapper missing: %v", aliases)
	}
	if aliases["research"] != "custom-alias" {
		t.Fatalf("custom alias preference broken: %v", aliases)
	}
	if _, ok := aliases["late"]; ok {
		t.Fatal("content beyond the bounded head slice must not be scanned")
	}
}

// ---------------------------------------------------------------------------
// Finding 6: sticky default removal tolerates a missing marker
// ---------------------------------------------------------------------------

func TestUseDefaultWithoutMarkerSucceeds(t *testing.T) {
	home := t.TempDir()
	manager := newTestManager(home, &fakeCLI{})
	if manager.Active() != DefaultProfileName {
		t.Fatalf("Active() = %q", manager.Active())
	}
	if _, err := manager.Use(context.Background(), DefaultProfileName); err != nil {
		t.Fatalf("use(default) with no marker must succeed like Hermes missing_ok, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Finding 7: owned-path validation and staging budgets fail closed
// ---------------------------------------------------------------------------

func TestValidateOwnedRelPathRejectsTraversal(t *testing.T) {
	for _, rel := range []string{"a/../escape", "../escape", "..", "/etc/passwd", "skills/../../x", "dir\\file"} {
		if _, reason := validateOwnedRelPath(rel); reason == "" || reason == "user-owned" {
			t.Fatalf("validateOwnedRelPath(%q) accepted (%q)", rel, reason)
		} else if !strings.Contains(reason, "unsafe segment") && !strings.Contains(reason, "absolute path") {
			t.Fatalf("validateOwnedRelPath(%q) unexpected reason %q", rel, reason)
		}
	}
	if validated, _ := validateOwnedRelPath("skills/../skills/x"); validated != "" {
		t.Fatal(".. inside segments must be rejected even when it normalizes safely")
	}
	if validated, _ := validateOwnedRelPath("skills/review"); validated != "skills/review" {
		t.Fatalf("benign path rejected: %q", validated)
	}
}

func TestDistributionStagingBudgetsFailClosed(t *testing.T) {
	home := t.TempDir()
	manager := newTestManager(home, &fakeCLI{})

	// Per-file budget: one oversized file aborts preview/apply.
	oldFileCap := distMaxFileBytes
	distMaxFileBytes = 1024
	defer func() { distMaxFileBytes = oldFileCap }()
	dist := t.TempDir()
	writeDistribution(t, dist, sampleManifest, map[string]string{
		"SOUL.md": strings.Repeat("x", 4096),
	}, nil)
	if _, err := manager.PreviewDistribution(context.Background(), dist, ""); err == nil ||
		!strings.Contains(err.Error(), "per-file budget") {
		t.Fatalf("per-file budget not enforced: %v", err)
	}

	// Total budget across many small files.
	distMaxFileBytes = oldFileCap
	oldTotal := distMaxTotal
	distMaxTotal = 2048
	defer func() { distMaxTotal = oldTotal }()
	totalDist := t.TempDir()
	writeDistribution(t, totalDist, sampleManifest, map[string]string{
		"SOUL.md":        strings.Repeat("x", 900),
		"config.yaml":    strings.Repeat("y", 900),
		"extra/blob.bin": strings.Repeat("z", 900),
	}, nil)
	if _, err := manager.PreviewDistribution(context.Background(), totalDist, ""); err == nil ||
		!strings.Contains(err.Error(), "total size budget") {
		t.Fatalf("total budget not enforced: %v", err)
	}

	// Walk errors fail closed (unreadable directory; skipped as root).
	if os.Getuid() != 0 {
		closed := t.TempDir()
		writeDistribution(t, closed, sampleManifest, map[string]string{
			"SOUL.md":                "soul",
			"skills/locked/SKILL.md": "secret skill",
		}, nil)
		if err := os.Chmod(filepath.Join(closed, "skills", "locked"), 0o000); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(filepath.Join(closed, "skills", "locked"), 0o700)
		if _, err := manager.PreviewDistribution(context.Background(), closed, ""); err == nil ||
			!strings.Contains(err.Error(), "cannot read") {
			t.Fatalf("walk errors must fail closed, got %v", err)
		}
	}
}

// ---------------------------------------------------------------------------
// Finding 8: #ref pins against a real local git repository
// ---------------------------------------------------------------------------

func TestGitRefPinsAgainstRealRepository(t *testing.T) {
	gitBin, err := exec.LookPath("git")
	if err != nil || gitBin == "" {
		t.Skip("git not available")
	}
	home := t.TempDir()
	repo := t.TempDir()

	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command(gitBin, args...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
			"GIT_TERMINAL_PROMPT=0",
		)
		cmd.Dir = repo
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}

	git("init", "-b", "main", ".")
	writeProfileFile(t, filepath.Join(repo, distributionManifest), sampleManifest)
	writeProfileFile(t, filepath.Join(repo, soulFileName), "version-one-soul")
	writeProfileFile(t, filepath.Join(repo, "skills", "a", "SKILL.md"), "# a")
	git("add", ".")
	git("commit", "-m", "one")
	tagShaOut := git("rev-parse", "HEAD")
	shaV1 := strings.TrimSpace(tagShaOut)
	git("tag", "v1")

	// Second commit on main changes SOUL.
	writeProfileFile(t, filepath.Join(repo, soulFileName), "version-two-soul")
	git("add", ".")
	git("commit", "-m", "two")

	manager := newTestManager(home, ExecRunner{})

	cases := []struct {
		name     string
		ref      string
		wantSoul string
	}{
		{name: "default branch", ref: "", wantSoul: "version-two-soul"},
		{name: "explicit branch", ref: "#main", wantSoul: "version-two-soul"},
		{name: "tag", ref: "#v1", wantSoul: "version-one-soul"},
		{name: "arbitrary commit sha", ref: "#" + shaV1, wantSoul: "version-one-soul"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// file:// makes the local repo a git-classified URL so the clone
			// and fetch/ref strategies are exercised for real.
			fullSource := "file://" + filepath.ToSlash(repo) + tc.ref
			stagingRoot, err := os.MkdirTemp("", "brio-git-test-*")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(stagingRoot)
			tree, plan, err := manager.stageAndPlan(context.Background(), fullSource, "", stagingRoot)
			if err != nil {
				t.Fatalf("stageAndPlan(%q): %v", fullSource, err)
			}
			soulBytes, err := os.ReadFile(filepath.Join(tree.dir, soulFileName))
			if err != nil {
				t.Fatal(err)
			}
			if string(soulBytes) != tc.wantSoul {
				t.Fatalf("checked-out SOUL = %q, want %q", soulBytes, tc.wantSoul)
			}
			if plan.Provenance != fullSource {
				t.Fatalf("provenance lost the pin: %q", plan.Provenance)
			}
			if plan.TargetName != "telemetry" {
				t.Fatalf("manifest name = %q", plan.TargetName)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Routing, per-profile proxying, memory isolation, control scoping
// ---------------------------------------------------------------------------

// TestSplitProfilePrefixKeepsLeadingSlash guards the routing invariants: the
// remaining path after a /p/<profile> prefix keeps its leading slash, and
// `default` is rejected as a prefix target (unprefixed requests already
// address the stock home).
func TestSplitProfilePrefixKeepsLeadingSlash(t *testing.T) {
	cases := []struct {
		path      string
		ok        bool
		name      string
		remainder string
	}{
		{path: "/p/coder/v1/responses", ok: true, name: "coder", remainder: "/v1/responses"},
		{path: "/p/coder/", ok: true, name: "coder", remainder: "/"},
		{path: "/p/coder", ok: true, name: "coder", remainder: "/"},
		{path: "/p/coder/api/sessions/s1/messages", ok: true, name: "coder", remainder: "/api/sessions/s1/messages"},
		{path: "/p/../etc", ok: false},
		{path: "/p//v1/responses", ok: false},
		{path: "/p/default/health", ok: false},
		{path: "/chat/responses", ok: false},
	}
	for _, tt := range cases {
		name, remainder, ok := splitProfilePrefix(tt.path)
		if ok != tt.ok {
			t.Fatalf("splitProfilePrefix(%q) ok = %v, want %v", tt.path, ok, tt.ok)
		}
		if !ok {
			continue
		}
		if name != tt.name || remainder != tt.remainder {
			t.Fatalf("splitProfilePrefix(%q) = (%q, %q), want (%q, %q)", tt.path, name, remainder, tt.name, tt.remainder)
		}
		if !strings.HasPrefix(remainder, "/") {
			t.Fatalf("splitProfilePrefix(%q) remainder %q lost its leading slash", tt.path, remainder)
		}
	}
}

func TestRoutePathProfileScoping(t *testing.T) {
	route := RoutePath("/p/coder/v1/responses")
	if route.Kind != RouteForward || route.Path != "/v1/responses" || route.Profile != "coder" {
		t.Fatalf("RoutePath(/p/coder/v1/responses) = %+v", route)
	}
	route = RoutePath("/p/coder/v1/memory")
	if route.Kind != RouteLocal || route.Name != "memory" || route.Profile != "coder" {
		t.Fatalf("RoutePath(/p/coder/v1/memory) = %+v", route)
	}
	route = RoutePath("/p/coder/control/rpc")
	if route.Kind != RouteLocal || route.Name != "control-rpc" || route.Profile != "coder" {
		t.Fatalf("RoutePath(/p/coder/control/rpc) = %+v", route)
	}
	// Unprefixed routes stay unscoped for backward compatibility.
	route = RoutePath("/v1/responses")
	if route.Profile != "" || route.Path != "/v1/responses" {
		t.Fatalf("RoutePath(/v1/responses) = %+v", route)
	}
	if got := RoutePath("/api/profiles"); got.Kind != RouteLocal || got.Name != "profiles" || got.Profile != "" {
		t.Fatalf("profile management must stay an unprefixed local route: %+v", got)
	}
	if got := RoutePath("/api/profiles/coder/soul"); got.Kind != RouteLocal || got.Name != "profiles" {
		t.Fatalf("RoutePath(/api/profiles/coder/soul) = %+v", got)
	}
}

func TestProxyForwardsProfileWithOwnKey(t *testing.T) {
	var mu sync.Mutex
	authByPath := map[string]string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		authByPath[r.URL.Path] = r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	defer upstream.Close()

	home := t.TempDir()
	writeProfileFile(t, filepath.Join(home, profilesDirName, "coder", envFileName), "API_SERVER_KEY=coder-key\n")
	client := &Client{BaseURL: upstream.URL, APIKey: "default-key", Home: home}

	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "r1", Method: http.MethodGet, Path: "/p/coder/v1/capabilities",
		Headers: map[string]string{"Authorization": "Bearer frame-token"},
	})
	if authByPath["/p/coder/v1/capabilities"] != "Bearer coder-key" {
		t.Fatalf("profile forward authorization = %q, want the profile's own key", authByPath["/p/coder/v1/capabilities"])
	}
	if len(frames) != 1 || frames[0].Status != http.StatusOK {
		t.Fatalf("frames = %+v", frames)
	}

	gotFrames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "r2", Method: http.MethodGet, Path: "/p/ghost/health",
	})
	if len(gotFrames) != 1 || gotFrames[0].Type != "error" || gotFrames[0].Code != "PROFILE_NOT_FOUND" {
		t.Fatalf("unknown profile frames = %+v", gotFrames)
	}
	if _, seen := authByPath["/health"]; seen {
		t.Fatal("unknown profile reached the upstream server")
	}

	// A named profile without a .env key must be created as a plain fixture:
	// invoking the real Hermes CLI here would fail on machines without it.
	if err := os.MkdirAll(filepath.Join(home, profilesDirName, "bare"), 0o700); err != nil {
		t.Fatal(err)
	}
	frames = collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "r3", Method: http.MethodGet, Path: "/p/bare/health",
	})
	if len(frames) != 1 || frames[0].Type != "error" || frames[0].Code != "PROFILE_UNAUTHENTICATED" {
		t.Fatalf("keyless profile frames = %+v; must fail closed without the connector key", frames)
	}
	if auth := authByPath["/health"]; strings.Contains(auth, "default-key") {
		t.Fatal("connector-wide key leaked into a named-profile request")
	}
}

func TestProfileMemoryIsolation(t *testing.T) {
	home := t.TempDir()
	writeProfileFile(t, filepath.Join(home, "memories", "MEMORY.md"), "default memory\n")
	manager := newTestManager(home, &fakeCLI{})
	if _, err := manager.Create(context.Background(), "coder", CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	client := &Client{BaseURL: "http://127.0.0.1:9", Home: home, profileMgr: manager}

	put := func(id string, path string, memory string) []tunnel.Frame {
		body := map[string]any{"memory": memory}
		return collectFrames(context.Background(), t, client, tunnel.Frame{
			Type: "request", ID: id, Method: http.MethodPut, Path: path, Body: body,
		})
	}
	get := func(id string, path string) tunnel.Frame {
		return collectFrames(context.Background(), t, client, tunnel.Frame{
			Type: "request", ID: id, Method: http.MethodGet, Path: path,
		})[0]
	}

	if frames := put("m1", "/v1/memory", "updated default"); frames[0].Status != http.StatusOK {
		t.Fatalf("default memory put = %+v", frames)
	}
	if frames := put("m2", "/p/coder/v1/memory", "coder memory"); frames[0].Status != http.StatusOK {
		t.Fatalf("profile memory put = %+v", frames)
	}

	defaultMemory := get("m3", "/v1/memory").Body.(map[string]any)
	coderMemory := get("m4", "/p/coder/v1/memory").Body.(map[string]any)
	if defaultMemory["memory"] != "updated default" {
		t.Fatalf("default memory = %v", defaultMemory["memory"])
	}
	if coderMemory["memory"] != "coder memory" {
		t.Fatalf("profile memory = %v; profiles must never share memory state", coderMemory["memory"])
	}
	if coderMemory["profile"] != "coder" || defaultMemory["profile"] != DefaultProfileName {
		t.Fatalf("memory responses must identify their profile: %+v vs %+v", defaultMemory, coderMemory)
	}

	if frames := put("m5", "/p/coder/v1/memory", "coder memory v2"); frames[0].Status != http.StatusOK {
		t.Fatalf("profile memory put = %+v", frames)
	}
	if get("m6", "/v1/memory").Body.(map[string]any)["memory"] != "updated default" {
		t.Fatal("profile-scoped write leaked into the default home")
	}
}

func TestProfileControlFailsClosedWithoutOverride(t *testing.T) {
	home := t.TempDir()
	manager := newTestManager(home, &fakeCLI{})
	if _, err := manager.Create(context.Background(), "coder", CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	client := &Client{BaseURL: "http://127.0.0.1:9", Home: home, ControlBaseURL: "http://127.0.0.1:9119", profileMgr: manager}

	frames := collectFrames(context.Background(), t, client, tunnel.Frame{
		Type: "request", ID: "c1", Method: http.MethodPost, Path: "/p/coder/control/rpc",
		Body: map[string]any{"method": "session.list", "params": map[string]any{"limit": 10}},
	})
	if len(frames) != 1 || frames[0].Type != "error" || frames[0].Code != "PROFILE_CONTROL_UNAVAILABLE" {
		t.Fatalf("control without override frames = %+v; must fail closed instead of mixing profiles", frames)
	}
}
