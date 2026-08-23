import { brioFetch, type AgentConnection } from './brio';
import {
  profileName,
  type DistributionPreview,
  type ExportPreview,
  type ExportResult,
  type HermesProfile,
  type ImportPreview,
  type ProfileCreateInput,
  type ProfileListResponse,
} from './profiles-model';

export * from './profiles-model';

// ---------------------------------------------------------------------------
// Profile management API. All calls go through the connector's local
// /api/profiles routes; nothing here ever exposes secret values, only names.
// ---------------------------------------------------------------------------

type ConnectionArg = Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>;

export function listProfiles(connection: ConnectionArg) {
  return brioFetch<ProfileListResponse>(connection, '/api/profiles');
}

export function getProfile(connection: ConnectionArg, name: string) {
  return brioFetch<HermesProfile>(
    connection,
    `/api/profiles/${encodeURIComponent(profileName(name))}`,
  );
}

export function createProfile(connection: ConnectionArg, input: ProfileCreateInput) {
  return brioFetch<HermesProfile>(connection, '/api/profiles', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name.trim(),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      clone: input.clone === true,
      clone_all: input.clone_all === true,
      ...(input.clone_from?.trim() ? { clone_from: input.clone_from.trim() } : {}),
    }),
  });
}

export function useProfile(connection: ConnectionArg, name: string) {
  return brioFetch<HermesProfile>(
    connection,
    `/api/profiles/${encodeURIComponent(profileName(name))}/use`,
    { method: 'POST', body: '{}' },
  );
}

export function describeProfile(connection: ConnectionArg, name: string, description: string) {
  return brioFetch<HermesProfile>(
    connection,
    `/api/profiles/${encodeURIComponent(profileName(name))}/describe`,
    { method: 'POST', body: JSON.stringify({ description }) },
  );
}

/** Rename requires typing the current profile name as confirmation. */
export function renameProfile(connection: ConnectionArg, name: string, newName: string, confirm: string) {
  return brioFetch<{ profile: HermesProfile; warnings?: string[] }>(
    connection,
    `/api/profiles/${encodeURIComponent(profileName(name))}/rename`,
    { method: 'POST', body: JSON.stringify({ name: newName.trim(), confirm }) },
  );
}

/**
 * Delete requires typing the profile name exactly. The connector refuses the
 * default profile and any profile whose gateway is still running.
 */
export function deleteProfile(connection: ConnectionArg, name: string, confirm: string) {
  return brioFetch<{ ok: boolean; warnings?: string[] }>(
    connection,
    `/api/profiles/${encodeURIComponent(profileName(name))}/delete`,
    { method: 'POST', body: JSON.stringify({ confirm }) },
  );
}

export function getProfileSOUL(connection: ConnectionArg, name: string) {
  return brioFetch<{ content: string }>(
    connection,
    `/api/profiles/${encodeURIComponent(profileName(name))}/soul`,
  );
}

export function updateProfileSOUL(connection: ConnectionArg, name: string, content: string) {
  return brioFetch<{ ok: boolean }>(
    connection,
    `/api/profiles/${encodeURIComponent(profileName(name))}/soul`,
    { method: 'PUT', body: JSON.stringify({ content }) },
  );
}

export function previewProfileExport(connection: ConnectionArg, name: string) {
  return brioFetch<ExportPreview>(
    connection,
    `/api/profiles/${encodeURIComponent(profileName(name))}/export-preview`,
  );
}

/** Runs the real `hermes [-p <name>] profile export` on the machine. */
export function exportProfileArchive(connection: ConnectionArg, name: string) {
  return brioFetch<ExportResult>(connection, '/api/profiles/export', {
    method: 'POST',
    body: JSON.stringify({ name: profileName(name) }),
  });
}

/**
 * Import a previously exported Hermes archive. Dry-run returns the sanitized
 * preview (file list + env var NAMES only); apply delegates to the stock
 * `hermes profile import`.
 */
export type ArchiveImportInput = {
  archiveB64: string;
  name: string;
};

/** Dry-run preview: sanitizes the archive and issues a bound preview token. */
export function previewProfileArchiveImport(
  connection: ConnectionArg,
  input: ArchiveImportInput,
) {
  return brioFetch<ImportPreview>(connection, '/api/profiles/import', {
    method: 'POST',
    body: JSON.stringify({
      archive_b64: input.archiveB64.trim(),
      name: input.name.trim(),
      dry_run: true,
    }),
  });
}

/**
 * Apply a previously previewed Hermes archive. Requires the exact
 * preview_token from the matching dry-run and, when that preview reported
 * credential files, explicit allow_secrets consent.
 */
export function importProfileArchive(
  connection: ConnectionArg,
  input: ArchiveImportInput & { previewToken: string; allowSecrets?: boolean },
) {
  return brioFetch<ImportPreview>(connection, '/api/profiles/import', {
    method: 'POST',
    body: JSON.stringify({
      archive_b64: input.archiveB64.trim(),
      name: input.name.trim(),
      allow_secrets: input.allowSecrets === true,
      preview_token: input.previewToken,
    }),
  });
}

export type DistributionInstallInput = {
  /** Git URL (github.com/u/r shorthand, https/ssh, #ref pins) or local path. */
  source: string;
  /** Target profile; defaults to the manifest name when omitted. */
  name?: string;
  force?: boolean;
  alias?: boolean;
  /** Server-issued digest from the matching preview; required for apply. */
  previewToken?: string;
};

/** Safe staged preview of a distribution: manifest, files, env requires. */
export function previewProfileDistribution(
  connection: ConnectionArg,
  input: Pick<DistributionInstallInput, 'source' | 'name'>,
) {
  return brioFetch<DistributionPreview>(connection, '/api/profiles/install-distribution', {
    method: 'POST',
    body: JSON.stringify({
      source: input.source.trim(),
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      dry_run: true,
    }),
  });
}

/** Applies via `hermes profile install`; Hermes owns aliases and bootstrap. */
export function installProfileDistribution(
  connection: ConnectionArg,
  input: DistributionInstallInput & { previewToken: string },
) {
  return brioFetch<DistributionPreview>(connection, '/api/profiles/install-distribution', {
    method: 'POST',
    body: JSON.stringify({
      source: input.source.trim(),
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      force: input.force === true,
      alias: input.alias === true,
      preview_token: input.previewToken,
    }),
  });
}

/** Re-pulls a distribution-installed profile's recorded source. */
export function updateProfileDistribution(
  connection: ConnectionArg,
  name: string,
  forceConfig = false,
) {
  return brioFetch<DistributionPreview>(connection, '/api/profiles/update-distribution', {
    method: 'POST',
    body: JSON.stringify({ name: profileName(name), force_config: forceConfig }),
  });
}

export type GatewayAction = 'start' | 'stop' | 'restart' | 'status';

/** Runs the real `hermes [-p <profile>] gateway <action>` on the machine. */
export function profileGatewayAction(
  connection: ConnectionArg,
  name: string,
  action: GatewayAction,
) {
  return brioFetch<{ output: string; profile: HermesProfile }>(
    connection,
    `/api/profiles/${encodeURIComponent(profileName(name))}/gateway`,
    { method: 'POST', body: JSON.stringify({ action }) },
  );
}
