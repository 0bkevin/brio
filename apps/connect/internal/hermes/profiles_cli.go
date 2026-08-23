package hermes

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Mutating profile operations are delegated to the installed stock Hermes
// CLI instead of reimplemented here. That keeps command aliases, managed
// gateway services, bundled-skill seeding, Honcho host migration, s6
// registration, and every future Hermes invariant byte-for-byte faithful —
// Brio must not maintain a parallel half-compatible profile format.
//
// All calls run with HERMES_HOME pointed at the connector home so the CLI
// resolves profiles against exactly the tree Brio serves.

// CLIRunner executes one external command and captures its output. It is an
// interface so tests can fake the Hermes/git binaries deterministically.
type CLIRunner interface {
	Run(ctx context.Context, env []string, dir string, name string, args ...string) (string, string, error)
}

// ExecRunner runs real binaries.
type ExecRunner struct{}

// Run implements CLIRunner using os/exec.
func (ExecRunner) Run(ctx context.Context, env []string, dir string, name string, args ...string) (string, string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = env
	if dir != "" {
		cmd.Dir = dir
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

// CLIError carries the stderr tail of a failed Hermes invocation so mobile
// can surface the real reason (multiplexer conflicts, unknown profiles...).
type CLIError struct {
	Command  string
	Stderr   string
	ExitCode int
}

func (e *CLIError) Error() string {
	detail := strings.TrimSpace(e.Stderr)
	if detail == "" {
		return fmt.Sprintf("hermes %s failed", e.Command)
	}
	return fmt.Sprintf("hermes %s failed: %s", e.Command, tailLines(detail, 6))
}

func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "; ")
}

const cliTimeout = 3 * time.Minute

// runHermes invokes the Hermes CLI with the connector's home as HERMES_HOME.
func (m *ProfileManager) runHermes(ctx context.Context, args ...string) (string, error) {
	if m.HermesBin == "" {
		m.HermesBin = "hermes"
	}
	runner := m.Runner
	if runner == nil {
		runner = ExecRunner{}
	}
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	// Strip any inherited HERMES_HOME before appending the scoped value so
	// the CLI resolves profiles against exactly the connector home.
	env := filterEnv(os.Environ(), "HERMES_HOME")
	env = append(env, "HERMES_HOME="+m.Home)
	stdout, stderr, err := runner.Run(ctx, env, m.Home, m.HermesBin, args...)
	if err != nil {
		exitCode := 1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
		if errors.Is(err, exec.ErrNotFound) || strings.Contains(stderr, "executable file not found") {
			return stdout, fmt.Errorf("the hermes CLI is required for this operation but was not found on PATH; install Hermes and retry (%s)", strings.TrimSpace(stderr))
		}
		return stdout, &CLIError{Command: strings.Join(args, " "), Stderr: stderr, ExitCode: exitCode}
	}
	return stdout, nil
}

var githubShorthandRe = regexp.MustCompile(`^github\.com/[\w.-]+/[\w.-]+/?$`)

// LooksLikeGitURL mirrors hermes_cli.profile_distribution._looks_like_git_url
// (plus explicit file:// support so local repositories exercise clone/ref
// behavior): git URLs get cloned into a staging directory; anything else
// must be an existing local directory containing a distribution manifest.
func LooksLikeGitURL(source string) bool {
	s := strings.TrimSpace(source)
	if strings.HasSuffix(s, ".git") {
		return true
	}
	if strings.HasPrefix(s, "file://") ||
		strings.HasPrefix(s, "git@") || strings.HasPrefix(s, "ssh://") || strings.HasPrefix(s, "git://") ||
		strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
		return true
	}
	return githubShorthandRe.MatchString(s)
}

// NormalizeGitURL expands bare github.com/user/repo shorthand to https.
func NormalizeGitURL(source string) string {
	s := strings.TrimSpace(source)
	if githubShorthandRe.MatchString(s) {
		return "https://" + strings.TrimSuffix(s, "/")
	}
	return s
}

var shaLikeRe = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)

// gitCommandError carries the failing command and its stderr so every stage
// failure surfaces the real git diagnostics.
type gitCommandError struct {
	Command string
	Stderr  string
}

func (e *gitCommandError) Error() string {
	detail := strings.TrimSpace(e.Stderr)
	if detail == "" {
		return fmt.Sprintf("git %s failed", e.Command)
	}
	return fmt.Sprintf("git %s failed: %s", e.Command, tailLines(detail, 4))
}

// stageGit materializes a git source into dest. Pinning strategy:
//   - no ref:      shallow clone of the default branch,
//   - branch/tag:  `git clone --depth 1 --branch <ref>`,
//   - arbitrary commit SHA (server permitting): init + shallow
//     `git fetch origin <ref>` + checkout FETCH_HEAD, falling back to a full
//     fetch when the server rejects shallow SHA requests. A failed shallow
//     clone leaves a partial directory behind, so dest is removed before the
//     init/fetch fallback.
//
// Everything runs through the injectable runner with prompt hooks disabled
// and HERMES_HOME scoped to the connector home.
func (m *ProfileManager) stageGit(ctx context.Context, url string, dest string, ref string) error {
	runner := m.Runner
	if runner == nil {
		runner = ExecRunner{}
	}
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	env := filterEnv(os.Environ(),
		"GIT_ASKPASS", "SSH_ASKPASS", "GIT_TERMINAL_PROMPT", "HERMES_HOME")
	env = append(env,
		"HERMES_HOME="+m.Home,
		"GIT_TERMINAL_PROMPT=0",
	)
	run := func(args ...string) error {
		_, stderr, err := runner.Run(ctx, env, "", "git", args...)
		if err != nil {
			if errors.Is(err, exec.ErrNotFound) {
				return errors.New("git is required to install distributions from git URLs")
			}
			exitCode := 1
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				exitCode = exitErr.ExitCode()
			}
			_ = exitCode // retained for future typed handling; stderr carries the diagnosis
			return &gitCommandError{Command: strings.Join(args, " "), Stderr: stderr}
		}
		return nil
	}

	if ref == "" {
		if err := run("clone", "--depth", "1", url, dest); err != nil {
			return fmt.Errorf("git clone failed: %w", err)
		}
		return nil
	}
	isSHA := shaLikeRe.MatchString(ref)
	if !isSHA {
		// Branches and tags resolve directly with a shallow clone.
		if err := run("clone", "--depth", "1", "--branch", ref, url, dest); err == nil {
			return nil
		}
		// A failed clone may leave a partial checkout; clear it so the
		// fetch fallback starts from a clean destination.
		_ = os.RemoveAll(dest)
	}
	// Fallback for raw commit SHAs (and tags some servers refuse via clone):
	// fetch exactly one object graph edge and check out FETCH_HEAD.
	if err := run("init", dest); err != nil {
		return fmt.Errorf("git init failed: %w", err)
	}
	if err := run("-C", dest, "remote", "add", "origin", url); err != nil {
		return fmt.Errorf("git remote add failed: %w", err)
	}
	if err := run("-C", dest, "fetch", "--depth", "1", "origin", ref); err != nil {
		// Shallow SHA fetches are commonly disabled server-side; retry with
		// a bounded full fetch before giving up.
		if fetchErr := run("-C", dest, "fetch", "origin", ref); fetchErr != nil {
			return fmt.Errorf("git fetch %s failed: %w", ref, errors.Join(err, fetchErr))
		}
	}
	if err := run("-C", dest, "checkout", "FETCH_HEAD"); err != nil {
		return fmt.Errorf("git checkout FETCH_HEAD failed: %w", err)
	}
	return nil
}

func filterEnv(environ []string, remove ...string) []string {
	out := environ[:0]
	for _, entry := range environ {
		dropped := false
		for _, key := range remove {
			if entry == key || strings.HasPrefix(entry, key+"=") {
				dropped = true
				break
			}
		}
		if !dropped {
			out = append(out, entry)
		}
	}
	return out
}
