package hermes

import (
	"errors"
	"io"
	"net/http"
	"strings"
)

const maxProfilesBodyBytes = 12 * 1024 * 1024

type profileCreateRequest struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Clone       bool   `json:"clone,omitempty"`
	CloneAll    bool   `json:"clone_all,omitempty"`
	CloneFrom   string `json:"clone_from,omitempty"`
}

type profileDescribeRequest struct {
	Description string `json:"description"`
}

type profileRenameRequest struct {
	Name    string `json:"name"`
	Confirm string `json:"confirm"`
}

type profileDeleteRequest struct {
	Confirm string `json:"confirm"`
}

type profileSOULRequest struct {
	Content string `json:"content"`
}

type profileImportRequest struct {
	ArchiveB64 string `json:"archive_b64"`
	Name       string `json:"name"`
	DryRun     bool   `json:"dry_run,omitempty"`
	// AllowSecrets consents to importing credential files (.env/.env.*/auth.json).
	AllowSecrets bool   `json:"allow_secrets,omitempty"`
	PreviewToken string `json:"preview_token"`
}

type distributionInstallRequest struct {
	Source      string `json:"source"`
	Name        string `json:"name,omitempty"`
	Force       bool   `json:"force,omitempty"`
	CreateAlias bool   `json:"alias,omitempty"`
	DryRun      bool   `json:"dry_run,omitempty"`
	// PreviewToken binds apply to an exact prior preview (server-issued digest).
	PreviewToken string `json:"preview_token,omitempty"`
}

type distributionUpdateRequest struct {
	Name        string `json:"name"`
	ForceConfig bool   `json:"force_config,omitempty"`
}

type gatewayActionRequest struct {
	Action string `json:"action"`
}

type profileExportRequest struct {
	Name string `json:"name"`
}

// serveProfiles handles the /api/profiles routes served locally from the
// Hermes home directory. Reads come from the real Hermes layout; mutations
// are delegated to the installed hermes CLI.
func (c *Client) serveProfiles(w http.ResponseWriter, r *http.Request) {
	manager := c.profileManager()
	ctx := r.Context()
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/profiles")
	trimmed = strings.Trim(trimmed, "/")
	if trimmed == "" {
		switch r.Method {
		case http.MethodGet:
			profiles, err := manager.List()
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"profiles": profiles,
				"active":   manager.Active(),
			})
		case http.MethodPost:
			var request profileCreateRequest
			if err := decodeJSONBodyLimit(r, &request, 64*1024); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			info, err := manager.Create(ctx, request.Name, CreateOptions{
				Description: request.Description,
				Clone:       request.Clone,
				CloneAll:    request.CloneAll,
				CloneFrom:   request.CloneFrom,
			})
			if err != nil {
				writeProfileError(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, info)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		}
		return
	}

	switch trimmed {
	case "import":
		handleProfilesImport(w, r, manager)
		return
	case "export":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		var request profileExportRequest
		if err := decodeJSONBodyLimit(r, &request, 16*1024); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		result, err := manager.Export(ctx, request.Name)
		if err != nil {
			writeProfileError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
		return
	case "install-distribution":
		handleDistributionInstall(w, r, manager)
		return
	case "update-distribution":
		handleDistributionUpdate(w, r, manager)
		return
	}

	name, action, _ := strings.Cut(trimmed, "/")
	switch r.Method {
	case http.MethodGet:
		switch action {
		case "":
			info, err := manager.Show(name)
			if err != nil {
				writeProfileError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, info)
		case "soul":
			content, err := manager.GetSOUL(name)
			if err != nil {
				writeProfileError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"content": content})
		case "export-preview":
			// File-level preview from the on-disk tree with Hermes' portable
			// snapshot exclusions; no CLI run, no archive built.
			normalized, err := manager.normalizeExisting(name)
			if err != nil {
				writeProfileError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, manager.exportPreview(normalized))
		default:
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown profiles action " + action})
		}
	case http.MethodPost:
		switch action {
		case "use":
			info, err := manager.Use(ctx, name)
			if err != nil {
				writeProfileError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, info)
		case "describe":
			var request profileDescribeRequest
			if err := decodeJSONBodyLimit(r, &request, 8*1024); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			info, err := manager.Describe(ctx, name, request.Description)
			if err != nil {
				writeProfileError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, info)
		case "rename":
			var request profileRenameRequest
			if err := decodeJSONBodyLimit(r, &request, 16*1024); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			info, warnings, err := manager.Rename(ctx, name, request.Name, request.Confirm)
			if err != nil {
				writeProfileError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"profile": info, "warnings": warnings})
		case "delete":
			var request profileDeleteRequest
			if err := decodeJSONBodyLimit(r, &request, 16*1024); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			warnings, err := manager.Delete(ctx, name, request.Confirm)
			if err != nil {
				writeProfileError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "warnings": warnings})
		case "gateway":
			var request gatewayActionRequest
			if err := decodeJSONBodyLimit(r, &request, 4*1024); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			output, info, err := manager.GatewayAction(ctx, name, strings.TrimSpace(strings.ToLower(request.Action)))
			if err != nil && output == "" {
				writeProfileError(w, err)
				return
			}
			response := map[string]any{"profile": info, "output": output}
			if err != nil {
				response["error"] = err.Error()
			}
			status := http.StatusOK
			if err != nil {
				// Hermes ran but reported a failure (e.g. multiplexer
				// conflict): surface it as a failed operation with its
				// verbatim message.
				status = http.StatusConflict
			}
			writeJSON(w, status, response)
		default:
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown profiles action " + action})
		}
	case http.MethodPut:
		if action != "soul" {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown profiles action " + action})
			return
		}
		var request profileSOULRequest
		if err := decodeJSONBodyLimit(r, &request, maxSoulBytes+64*1024); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		if err := manager.SetSOUL(name, request.Content); err != nil {
			writeProfileError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case http.MethodDelete:
		if action != "" && action != "delete" {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown profiles action " + action})
			return
		}
		confirm := r.URL.Query().Get("confirm")
		if action == "delete" {
			var request profileDeleteRequest
			if err := decodeJSONBodyLimit(r, &request, 16*1024); err == nil && request.Confirm != "" {
				confirm = request.Confirm
			}
		}
		warnings, err := manager.Delete(ctx, name, confirm)
		if err != nil {
			writeProfileError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "warnings": warnings})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
	}
}

func handleProfilesImport(w http.ResponseWriter, r *http.Request, manager *ProfileManager) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	var request profileImportRequest
	if err := decodeJSONBodyLimit(r, &request, maxProfilesBodyBytes); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if request.DryRun {
		// Preview never needs a token: it issues one bound to this payload.
		preview, err := manager.ImportPreviewFromArchive(request.ArchiveB64, request.Name)
		if err != nil {
			writeProfileError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, preview)
		return
	}
	preview, err := manager.Import(r.Context(), request.ArchiveB64, request.Name, request.AllowSecrets, request.PreviewToken)
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func handleDistributionInstall(w http.ResponseWriter, r *http.Request, manager *ProfileManager) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	var request distributionInstallRequest
	if err := decodeJSONBodyLimit(r, &request, 256*1024); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if request.DryRun {
		preview, err := manager.PreviewDistribution(r.Context(), request.Source, request.Name)
		if err != nil {
			writeProfileError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, preview)
		return
	}
	preview, err := manager.InstallDistribution(r.Context(), request.Source, request.Name, request.Force, request.CreateAlias, request.PreviewToken)
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func handleDistributionUpdate(w http.ResponseWriter, r *http.Request, manager *ProfileManager) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	var request distributionUpdateRequest
	if err := decodeJSONBodyLimit(r, &request, 16*1024); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	preview, err := manager.UpdateDistribution(r.Context(), request.Name, request.ForceConfig)
	if err != nil {
		writeProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func writeProfileError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	var cliErr *CLIError
	switch {
	case errors.Is(err, ErrProfileNotFound):
		status = http.StatusNotFound
	case errors.As(err, &cliErr):
		status = http.StatusBadGateway
	case strings.Contains(err.Error(), "requires typing") ||
		strings.Contains(err.Error(), "already exists") ||
		strings.Contains(err.Error(), "cannot be deleted"):
		status = http.StatusConflict
	}
	writeJSON(w, status, map[string]any{"error": err.Error()})
}

// decodeJSONBodyLimit decodes a single JSON object body with a caller-provided
// size budget.
func decodeJSONBodyLimit(r *http.Request, target any, limit int64) error {
	data, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return errors.New("invalid request body")
	}
	if int64(len(data)) > limit {
		return errors.New("request body is too large")
	}
	return decodeStrictJSON(data, target)
}
