// Relative import keeps this module loadable under plain node test runs
// (the `@/` alias is only resolved by Metro/tsc).
import { profileName } from '../lib/profiles-model.ts';

// Pure thread-scoping model. Kept free of storage/store dependencies so it
// runs in unit tests and can be reasoned about in isolation.

export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

export type ChatThread = {
  id: string;
  connectionKey?: string;
  /**
   * Hermes profile this thread belongs to. Undefined on legacy threads, which
   * predate profiles and always map to the default profile.
   */
  profile?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  lastResponseId?: string;
  importedSessionId?: string;
  needsHistorySeed?: boolean;
};

/** Resolves the concrete Hermes profile a thread is scoped to. */
export function threadProfileName(thread: Pick<ChatThread, 'profile'> | null | undefined): string {
  return profileName(thread?.profile);
}

/**
 * Scope match for stored threads: same environment base key AND same Hermes
 * profile. Legacy rows (no `profile`) belong to the default profile so
 * upgrading never strands existing conversations.
 */
export function threadMatchesScope(
  thread: ChatThread,
  connectionKey: string,
  profile: string | undefined,
): boolean {
  if (!thread.connectionKey || thread.connectionKey !== connectionKey) return false;
  return threadProfileName(thread) === profileName(profile);
}
