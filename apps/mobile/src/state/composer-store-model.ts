export type QueuedPromptState = 'pending' | 'sending' | 'failed';

export type QueuedPrompt = {
  id: string;
  text: string;
  createdAt: number;
  state: QueuedPromptState;
  attemptedAt?: number;
  error?: string;
};

export type StoredComposerState = {
  drafts: Record<string, string>;
  queues: Record<string, QueuedPrompt[]>;
  paused: Record<string, boolean>;
};

export const EMPTY_COMPOSER_STATE: StoredComposerState = {
  drafts: {},
  queues: {},
  paused: {},
};

export const EMPTY_PROMPT_QUEUE: QueuedPrompt[] = [];

export function validStoredComposerState(value: unknown): StoredComposerState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredComposerState>;
  if (!isRecord(candidate.drafts) || !isRecord(candidate.queues) || !isRecord(candidate.paused)) {
    return null;
  }

  const drafts = Object.fromEntries(
    Object.entries(candidate.drafts).filter(
      (entry): entry is [string, string] => validKey(entry[0]) && typeof entry[1] === 'string',
    ),
  );
  const queues: Record<string, QueuedPrompt[]> = {};
  for (const [key, rawQueue] of Object.entries(candidate.queues)) {
    if (!validKey(key) || !Array.isArray(rawQueue)) continue;
    const queue = rawQueue.filter(isQueuedPrompt);
    if (queue.length > 0) queues[key] = queue;
  }
  const paused = Object.fromEntries(
    Object.entries(candidate.paused).filter(
      (entry): entry is [string, boolean] => validKey(entry[0]) && entry[1] === true,
    ),
  );
  return { drafts, queues, paused };
}

export function addQueuedPrompt(
  state: StoredComposerState,
  threadKey: string,
  prompt: QueuedPrompt,
): StoredComposerState {
  return {
    ...state,
    drafts: withoutKey(state.drafts, threadKey),
    queues: {
      ...state.queues,
      [threadKey]: [...(state.queues[threadKey] ?? []), prompt],
    },
  };
}

export function nextQueuedPrompt(state: StoredComposerState, threadKey: string) {
  if (state.paused[threadKey]) return null;
  const prompt = state.queues[threadKey]?.[0];
  return prompt?.state === 'pending' ? prompt : null;
}

export function updateQueuedPrompt(
  state: StoredComposerState,
  threadKey: string,
  promptId: string,
  patch: Partial<Pick<QueuedPrompt, 'text' | 'state' | 'attemptedAt' | 'error'>>,
): StoredComposerState {
  const queue = state.queues[threadKey];
  if (!queue?.some((item) => item.id === promptId)) return state;
  return {
    ...state,
    queues: {
      ...state.queues,
      [threadKey]: queue.map((item) =>
        item.id === promptId ? normalizeQueuedPrompt({ ...item, ...patch }) : item,
      ),
    },
  };
}

export function removeQueuedPrompt(
  state: StoredComposerState,
  threadKey: string,
  promptId: string,
): StoredComposerState {
  const queue = state.queues[threadKey];
  if (!queue?.some((item) => item.id === promptId)) return state;
  const next = queue.filter((item) => item.id !== promptId);
  return {
    ...state,
    queues: next.length > 0 ? { ...state.queues, [threadKey]: next } : withoutKey(state.queues, threadKey),
  };
}

export function moveQueuedPrompt(
  state: StoredComposerState,
  threadKey: string,
  promptId: string,
  offset: -1 | 1,
): StoredComposerState {
  const queue = state.queues[threadKey];
  if (!queue) return state;
  const from = queue.findIndex((item) => item.id === promptId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= queue.length) return state;
  const next = [...queue];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return { ...state, queues: { ...state.queues, [threadKey]: next } };
}

export function moveComposerThread(
  state: StoredComposerState,
  sourceKey: string,
  destinationKey: string,
): StoredComposerState {
  if (sourceKey === destinationKey) return state;
  const sourceQueue = state.queues[sourceKey] ?? [];
  const destinationQueue = state.queues[destinationKey] ?? [];
  const seen = new Set(destinationQueue.map((item) => item.id));
  const mergedQueue = [...destinationQueue, ...sourceQueue.filter((item) => !seen.has(item.id))];
  const sourceDraft = state.drafts[sourceKey];
  const destinationDraft = state.drafts[destinationKey];

  const drafts = withoutKey(state.drafts, sourceKey);
  if (destinationDraft === undefined && sourceDraft !== undefined) drafts[destinationKey] = sourceDraft;
  const queues = withoutKey(state.queues, sourceKey);
  if (mergedQueue.length > 0) queues[destinationKey] = mergedQueue;
  const paused = withoutKey(state.paused, sourceKey);
  if (state.paused[destinationKey] || state.paused[sourceKey]) paused[destinationKey] = true;
  return { drafts, queues, paused };
}

function isQueuedPrompt(value: unknown): value is QueuedPrompt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<QueuedPrompt>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    candidate.id.length <= 256 &&
    typeof candidate.text === 'string' &&
    candidate.text.trim().length > 0 &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    isQueuedPromptState(candidate.state) &&
    (candidate.attemptedAt === undefined ||
      (typeof candidate.attemptedAt === 'number' && Number.isFinite(candidate.attemptedAt))) &&
    (candidate.error === undefined || typeof candidate.error === 'string')
  );
}

function normalizeQueuedPrompt(prompt: QueuedPrompt): QueuedPrompt {
  const next = { ...prompt };
  if (next.state === 'pending') {
    delete next.attemptedAt;
    delete next.error;
  } else if (next.state === 'sending') {
    delete next.error;
  }
  return next;
}

function isQueuedPromptState(value: unknown): value is QueuedPromptState {
  return value === 'pending' || value === 'sending' || value === 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validKey(value: string) {
  return value.length > 0 && value.length <= 1024;
}

function withoutKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}
