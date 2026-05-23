package server

import (
	"os"
	"path/filepath"
)

type Config struct {
	Addr          string
	Token         string
	HermesBaseURL string
	HermesAPIKey  string
	HermesHome    string
	AllowedRoots  []string
}

func (c Config) normalizedRoots() []string {
	roots := make([]string, 0, len(c.AllowedRoots)+2)
	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots, cwd)
	}
	if c.HermesHome != "" {
		roots = append(roots, c.HermesHome)
	}
	roots = append(roots, c.AllowedRoots...)

	out := make([]string, 0, len(roots))
	seen := map[string]bool{}
	for _, root := range roots {
		if root == "" {
			continue
		}
		abs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		clean := filepath.Clean(abs)
		if !seen[clean] {
			seen[clean] = true
			out = append(out, clean)
		}
	}
	return out
}
