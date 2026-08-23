// Hermes profiles are separate agent homes on one machine: the stock home
// (~/.hermes) is the `default` profile and named profiles live under
// ~/.hermes/profiles/<name>. Brio environments (connections) are orthogonal:
// one environment hosts many profiles.
//
// This module is dependency-free so identity rules can be unit tested in
// isolation (see profiles-model.test.mjs).

/** Structural subset of AgentConnection needed to derive identity keys. */
export type ConnectionIdentity = {
  id: string;
  agentId?: string;
  transport: 'relay' | 'direct';
  url: string;
};

export const DEFAULT_PROFILE_NAME = 'default';

export type HermesProfile = {
  name: string;
  path: string;
  is_default: boolean;
  active: boolean;
  description?: string;
  model?: string;
  gateway_multiplex?: boolean;
  has_config: boolean;
  has_env: boolean;
  has_soul: boolean;
  env_var_names?: string[];
  skill_count: number;
  alias_name?: string;
  distribution_name?: string;
  distribution_version?: string;
  distribution_source?: string;
  description_auto?: boolean;
  provider?: string;
  gateway_running: boolean;
  gateway_pid?: number;
  runtime_status?: Record<string, unknown>;
};

export type ProfileListResponse = {
  profiles: HermesProfile[];
  active: string;
};

export type ProfileCreateInput = {
  name: string;
  description?: string;
  clone?: boolean;
  clone_all?: boolean;
  clone_from?: string;
};

export type ExportPreview = {
  filename: string;
  file_count: number;
  total_bytes: number;
  files?: string[];
  /** Hermes exports are credential-free by design; always false. */
  credentials_included: boolean;
  required_env_vars?: string[];
  warnings?: string[];
};

export type ExportResult = {
  filename: string;
  file_count: number;
  total_bytes: number;
  files?: string[];
  credentials_included: boolean;
  required_env_vars?: string[];
  warnings?: string[];
  data_base64: string;
  sha256: string;
};

export type ImportPreview = {
  name: string;
  new_profile: boolean;
  file_count: number;
  total_bytes: number;
  files?: string[];
  has_secrets_file: boolean;
  /** Credential FILE NAMES detected in the archive; values never leave the machine. */
  secret_files?: string[];
  required_env_vars?: string[];
  /** Server-issued digest binding this preview to the exact payload + target. */
  preview_token: string;
};

export type DistributionEnvRequirement = {
  name: string;
  description?: string;
  required: boolean;
  default?: string;
};

/** Mirrors the parsed distribution.yaml plus Brio's staging result. */
export type DistributionPreview = {
  target_name: string;
  new_profile: boolean;
  existing: boolean;
  provenance: string;
  manifest_name: string;
  version?: string;
  description?: string;
  hermes_requires?: string;
  files?: string[];
  file_count: number;
  env_requires?: DistributionEnvRequirement[];
  skipped_user_owned?: string[];
  /** Server-issued digest from the staged tree; apply must echo it. */
  preview_token: string;
};

// ---------------------------------------------------------------------------
// Identity model: environmentId + profileName (+ sessionId). Every cache,
// query key, stored thread, and deep link must carry all three dimensions so
// no state is ever reused across profiles.
// ---------------------------------------------------------------------------

/** Stable Brio environment id for a connection. */
export function environmentId(
  connection: Pick<ConnectionIdentity, 'id' | 'agentId'> | null | undefined,
): string {
  if (!connection) return '';
  return connection.agentId ?? connection.id;
}

/**
 * Base key shared by every profile of one environment. Stored threads carry
 * this in `connectionKey`; their profile dimension lives in `thread.profile`.
 */
export function environmentKey(
  connection: Pick<ConnectionIdentity, 'transport' | 'url' | 'id' | 'agentId'> | null | undefined,
): string {
  if (!connection) return '';
  return `${connection.transport}:${connection.url}:${environmentId(connection)}`;
}

/** Normalizes an optional profile reference to a concrete name. */
export function profileName(profile?: string | null): string {
  const trimmed = profile?.trim();
  return trimmed ? trimmed : DEFAULT_PROFILE_NAME;
}

/**
 * Full identity scope for caches and query keys:
 * `<environment>::<profile>`. Two profiles of the same environment never
 * share a scope.
 */
export function profileScope(
  connection: Pick<ConnectionIdentity, 'transport' | 'url' | 'id' | 'agentId'> | null | undefined,
  profile?: string | null,
): string {
  return `${environmentKey(connection)}::${profileName(profile)}`;
}

/** True when the profile is real (named) rather than the stock home. */
export function isNamedProfile(profile?: string | null): boolean {
  return profileName(profile) !== DEFAULT_PROFILE_NAME;
}

/** URL prefix that scopes forwarded routes to one Hermes profile. */
export function profilePathPrefix(profile?: string | null): string {
  if (!isNamedProfile(profile)) return '';
  return `/p/${encodeURIComponent(profileName(profile))}`;
}

/**
 * Wraps an API path so the connector (or a multiplexed gateway listener)
 * routes it with the target profile's own credentials and state.
 */
export function scopedPath(path: string, profile?: string | null): string {
  return `${profilePathPrefix(profile)}${path}`;
}

// ---------------------------------------------------------------------------
// Deep links. Identity travels as query parameters so a link can point at one
// exact (environment, profile, session) conversation.
// ---------------------------------------------------------------------------

export type BrioDeepLink = {
  environmentId: string;
  profile?: string;
  sessionId?: string;
};

export type ResolvedBrioDeepLink = {
  environmentId: string;
  profile: string;
  sessionId?: string;
};

export function buildBrioDeepLink(link: BrioDeepLink): string {
  const params = new URLSearchParams();
  params.set('agent', link.environmentId);
  if (isNamedProfile(link.profile)) params.set('profile', profileName(link.profile));
  if (link.sessionId) params.set('session', link.sessionId);
  return `brio://chat?${params.toString()}`;
}

export function parseBrioDeepLink(url: string): BrioDeepLink | null {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith('brio://')) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed.replace(/^brio:\/\//i, 'http://'));
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== 'chat' || parsed.pathname !== '/') return null;
  const agent = parsed.searchParams.get('agent');
  if (!agent) return null;
  const profile = parsed.searchParams.get('profile');
  const session = parsed.searchParams.get('session');
  return {
    environmentId: agent,
    ...(isNamedProfile(profile) ? { profile: profileName(profile) } : {}),
    ...(session ? { sessionId: session } : {}),
  };
}

/**
 * Resolves a parsed link against one concrete environment and its real
 * profile list. A link is usable only when all requested identity dimensions
 * resolve: foreign environments and unknown profiles are rejected before a
 * session request can be made.
 */
export function resolveBrioDeepLink(
  link: BrioDeepLink | null | undefined,
  targetEnvironmentId: string,
  profiles: readonly Pick<HermesProfile, 'name'>[],
): ResolvedBrioDeepLink | null {
  if (!link || !targetEnvironmentId || link.environmentId !== targetEnvironmentId) {
    return null;
  }
  const profile = profileName(link.profile);
  if (!profiles.some((candidate) => profileName(candidate.name) === profile)) {
    return null;
  }
  return {
    environmentId: targetEnvironmentId,
    profile,
    ...(link.sessionId?.trim() ? { sessionId: link.sessionId.trim() } : {}),
  };
}

// Short alias for callers that already work with parsed deep-link values.
export const resolveDeepLink = resolveBrioDeepLink;

/**
 * Setup guidance for one profile, mirroring Hermes' per-profile commands.
 */
export function profileSetupCommand(name: string): string {
  const profile = profileName(name);
  if (!isNamedProfile(profile)) {
    return 'hermes setup --portal';
  }
  return `hermes -p ${profile} setup --portal`;
}
