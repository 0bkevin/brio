package hermes

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// walkProfile visits every regular file below root. Symlinks and special
// files are skipped: nothing that crosses a trust boundary (export preview,
// distribution planning) may escape the profile directory.
func walkProfile(root string, visit func(relPath string, info fs.FileInfo, read func() ([]byte, error)) error) error {
	info, err := os.Stat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("profile home is not a directory")
	}
	return walkRecursive(root, "", visit)
}

var dirOnlyExclusions = map[string]bool{
	"sessions": true, "backups": true, "state-snapshots": true,
	"checkpoints": true, "logs": true, ".git": true,
	"node_modules": true, "__pycache__": true,
	"hermes-agent": true, ".worktrees": true,
}

func walkRecursive(absRoot string, relPrefix string, visit func(string, fs.FileInfo, func() ([]byte, error)) error) error {
	if relPrefix != "" && dirOnlyExclusions[relPrefix] {
		return nil
	}
	entries, err := os.ReadDir(absRoot)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		relPath := entry.Name()
		if relPrefix != "" {
			relPath = relPrefix + "/" + entry.Name()
		}
		entryInfo, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if err := walkRecursive(filepath.Join(absRoot, entry.Name()), relPath, visit); err != nil {
				return err
			}
			continue
		}
		if !entryInfo.Mode().IsRegular() {
			continue
		}
		entryPath := filepath.Join(absRoot, entry.Name())
		read := func() ([]byte, error) { return os.ReadFile(entryPath) }
		if err := visit(relPath, entryInfo, read); err != nil {
			return err
		}
	}
	return nil
}

type tarEntry struct {
	name string
	size int
	data []byte
}

type tarContents struct {
	files []tarEntry
}

// readTarEntries decodes a gzip+tar archive defensively: absolute paths,
// traversal, links, devices, and oversized payloads are rejected.
func readTarEntries(payload []byte) (*tarContents, error) {
	if len(payload) > maxImportArchiveBytes {
		return nil, fmt.Errorf("archive is larger than %d bytes", maxImportArchiveBytes)
	}
	gzipReader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("archive is not gzip data: %w", err)
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	contents := &tarContents{}
	seen := map[string]bool{}
	total := 0
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("archive is corrupt: %w", err)
		}
		cleaned, err := sanitizeArchiveName(header.Name)
		if err != nil {
			return nil, err
		}
		if cleaned == "" {
			continue
		}
		if seen[cleaned] {
			return nil, fmt.Errorf("archive contains duplicate entry %q", cleaned)
		}
		seen[cleaned] = true
		if header.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("archive entry %q is not a regular file", header.Name)
		}
		if header.Size > maxImportArchiveBytes || total+int(header.Size) > maxImportArchiveBytes {
			return nil, errors.New("archive exceeds the import size budget")
		}
		data := make([]byte, header.Size)
		if _, err := io.ReadFull(reader, data); err != nil {
			return nil, fmt.Errorf("archive entry %q is truncated", header.Name)
		}
		total += len(data)
		contents.files = append(contents.files, tarEntry{name: cleaned, size: len(data), data: data})
		if len(contents.files) > 20000 {
			return nil, fmt.Errorf("archive contains more than %d files", 20000)
		}
	}
	return contents, nil
}

func sanitizeArchiveName(name string) (string, error) {
	name = strings.TrimSuffix(name, "/")
	if name == "" {
		return "", nil
	}
	if strings.HasPrefix(name, "/") || strings.Contains(name, "\\") || strings.IndexByte(name, 0) >= 0 {
		return "", fmt.Errorf("archive entry %q has an unsupported path", name)
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", fmt.Errorf("archive entry %q escapes the profile directory", name)
		}
	}
	cleaned := path_CleanSlash(name)
	if cleaned == "" || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("archive entry %q escapes the profile directory", name)
	}
	return cleaned, nil
}
