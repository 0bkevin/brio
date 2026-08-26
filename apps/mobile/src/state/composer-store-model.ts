import type { ChatModelOverride } from './chat-thread-model.ts';

export type QueuedPromptState = 'pending' | 'sending' | 'failed';
export type PromptDeliveryMode = 'queue' | 'redirect';

export type ComposerAttachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'file';
  size: number;
  sha256: string;
};

export type QueuedPrompt = {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  deliveryMode: PromptDeliveryMode;
  /** Runtime choice captured when the prompt was queued. */
  modelOverride?: ChatModelOverride;
  createdAt: number;
  state: QueuedPromptState;
  attemptedAt?: number;
  error?: string;
};

export type StoredComposerState = {
  drafts: Record<string, string>;
  attachments: Record<string, ComposerAttachment[]>;
  queues: Record<string, QueuedPrompt[]>;
  paused: Record<string, boolean>;
  promptHistory: Record<string, string[]>;
  sessionIds: Record<string, string>;
};

export const EMPTY_COMPOSER_STATE: StoredComposerState = {
  drafts: {},
  attachments: {},
  queues: {},
  paused: {},
  promptHistory: {},
  sessionIds: {},
};

export const EMPTY_PROMPT_QUEUE: QueuedPrompt[] = [];
export const EMPTY_COMPOSER_ATTACHMENTS: ComposerAttachment[] = [];
export const EMPTY_PROMPT_HISTORY: string[] = [];

export type EnqueuedComposerDraft = {
  prompt: QueuedPrompt;
  state: StoredComposerState;
};

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
  const attachments = validAttachmentRecord(candidate.attachments);
  const queues: Record<string, QueuedPrompt[]> = {};
  for (const [key, rawQueue] of Object.entries(candidate.queues)) {
    if (!validKey(key) || !Array.isArray(rawQueue)) continue;
    const seen = new Set<string>();
    const queue: QueuedPrompt[] = [];
    for (const item of rawQueue) {
      const prompt = storedQueuedPrompt(item);
      if (!prompt || seen.has(prompt.id)) continue;
      seen.add(prompt.id);
      queue.push(prompt);
    }
    if (queue.length > 0) queues[key] = queue;
  }
  const paused = Object.fromEntries(
    Object.entries(candidate.paused).filter(
      (entry): entry is [string, boolean] => validKey(entry[0]) && entry[1] === true,
    ),
  );
  const promptHistory: Record<string, string[]> = {};
  for (const [key, items] of Object.entries(
    isRecord(candidate.promptHistory) ? candidate.promptHistory : {},
  )) {
    if (!validKey(key) || !Array.isArray(items)) continue;
    const valid = items
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .slice(-100);
    if (valid.length > 0) promptHistory[key] = valid;
  }
  const sessionIds = Object.fromEntries(
    Object.entries(isRecord(candidate.sessionIds) ? candidate.sessionIds : {}).filter(
      (entry): entry is [string, string] =>
        validKey(entry[0]) && typeof entry[1] === 'string' && validSessionID(entry[1]),
    ),
  );
  return { drafts, attachments, queues, paused, promptHistory, sessionIds };
}

export function enqueueComposerDraft(
  state: StoredComposerState,
  threadKey: string,
  id: string,
  createdAt: number,
  deliveryMode: PromptDeliveryMode = 'queue',
  modelOverride?: ChatModelOverride,
): EnqueuedComposerDraft | null {
  const text = state.drafts[threadKey] ?? '';
  const attachments = state.attachments[threadKey] ?? [];
  if (!text.trim() && attachments.length === 0) return null;
  const prompt: QueuedPrompt = {
    id,
    text,
    attachments,
    deliveryMode,
    ...(modelOverride ? { modelOverride } : {}),
    createdAt,
    state: 'pending',
  };
  return { prompt, state: addQueuedPrompt(state, threadKey, prompt) };
}

export function addQueuedPrompt(
  state: StoredComposerState,
  threadKey: string,
  prompt: QueuedPrompt,
): StoredComposerState {
  const currentQueue = state.queues[threadKey] ?? [];
  const queue = prompt.deliveryMode === 'redirect'
    ? currentQueue[0]?.state === 'sending'
      ? [currentQueue[0], prompt, ...currentQueue.slice(1)]
      : [prompt, ...currentQueue]
    : [...currentQueue, prompt];
  return {
    ...state,
    drafts: withoutKey(state.drafts, threadKey),
    attachments: withoutKey(state.attachments, threadKey),
    queues: {
      ...state.queues,
      [threadKey]: queue,
    },
    promptHistory: prompt.text.trim()
      ? {
          ...state.promptHistory,
          [threadKey]: appendPromptHistory(state.promptHistory[threadKey] ?? [], prompt.text),
        }
      : state.promptHistory,
  };
}

export function addComposerAttachment(
  state: StoredComposerState,
  threadKey: string,
  attachment: ComposerAttachment,
): StoredComposerState {
  const current = state.attachments[threadKey] ?? [];
  if (current.some((item) => item.id === attachment.id)) return state;
  return {
    ...state,
    attachments: { ...state.attachments, [threadKey]: [...current, attachment] },
  };
}

export function removeComposerAttachment(
  state: StoredComposerState,
  threadKey: string,
  attachmentId: string,
): StoredComposerState {
  const current = state.attachments[threadKey];
  if (!current?.some((item) => item.id === attachmentId)) return state;
  const next = current.filter((item) => item.id !== attachmentId);
  return {
    ...state,
    attachments: next.length
      ? { ...state.attachments, [threadKey]: next }
      : withoutKey(state.attachments, threadKey),
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
  if (queue[from]?.state !== 'pending' || queue[to]?.state !== 'pending') return state;
  const next = [...queue];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return { ...state, queues: { ...state.queues, [threadKey]: next } };
}

export function restoreQueuedPromptToDraft(
  state: StoredComposerState,
  threadKey: string,
  promptId: string,
): StoredComposerState {
  if (state.drafts[threadKey]?.trim() || state.attachments[threadKey]?.length) return state;
  const prompt = state.queues[threadKey]?.find((item) => item.id === promptId);
  if (!prompt || prompt.state === 'sending') return state;
  const withoutPrompt = removeQueuedPrompt(state, threadKey, promptId);
  return {
    ...withoutPrompt,
    drafts: { ...withoutPrompt.drafts, [threadKey]: prompt.text },
    attachments: prompt.attachments.length
      ? { ...withoutPrompt.attachments, [threadKey]: prompt.attachments }
      : withoutPrompt.attachments,
  };
}

export function finalizeAcceptedPrompt(
  state: StoredComposerState,
  sourceKey: string,
  destinationKey: string,
  promptId: string,
): StoredComposerState {
  const withoutPrompt = removeQueuedPrompt(state, sourceKey, promptId);
  return moveComposerThread(withoutPrompt, sourceKey, destinationKey);
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
  const sourceAttachments = state.attachments[sourceKey] ?? [];
  const destinationAttachments = state.attachments[destinationKey] ?? [];

  const drafts = withoutKey(state.drafts, sourceKey);
  if (destinationDraft === undefined && sourceDraft !== undefined) drafts[destinationKey] = sourceDraft;
  const attachments = withoutKey(state.attachments, sourceKey);
  if (destinationAttachments.length === 0 && sourceAttachments.length > 0) {
    attachments[destinationKey] = sourceAttachments;
  }
  const queues = withoutKey(state.queues, sourceKey);
  if (mergedQueue.length > 0) queues[destinationKey] = mergedQueue;
  const paused = withoutKey(state.paused, sourceKey);
  if (state.paused[destinationKey] || state.paused[sourceKey]) paused[destinationKey] = true;
  const promptHistory = withoutKey(state.promptHistory, sourceKey);
  const sourceHistory = state.promptHistory[sourceKey] ?? [];
  const destinationHistory = state.promptHistory[destinationKey] ?? [];
  const mergedHistory = [...destinationHistory, ...sourceHistory].slice(-100);
  if (mergedHistory.length > 0) promptHistory[destinationKey] = mergedHistory;
  const sessionIds = withoutKey(state.sessionIds, sourceKey);
  const sourceSessionID = state.sessionIds[sourceKey];
  if (!state.sessionIds[destinationKey] && sourceSessionID) {
    sessionIds[destinationKey] = sourceSessionID;
  }
  return { drafts, attachments, queues, paused, promptHistory, sessionIds };
}

function storedQueuedPrompt(value: unknown): QueuedPrompt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<QueuedPrompt>;
  const attachments = candidate.attachments ?? [];
  const deliveryMode = candidate.deliveryMode ?? 'queue';
  const modelOverride = storedModelOverride(candidate.modelOverride);
  if (!(
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    candidate.id.length <= 256 &&
    typeof candidate.text === 'string' &&
    Array.isArray(attachments) &&
    attachments.every(isComposerAttachment) &&
    (candidate.text.trim().length > 0 || attachments.length > 0) &&
    isPromptDeliveryMode(deliveryMode) &&
    (candidate.modelOverride === undefined || modelOverride !== null) &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    isQueuedPromptState(candidate.state) &&
    (candidate.attemptedAt === undefined ||
      (typeof candidate.attemptedAt === 'number' && Number.isFinite(candidate.attemptedAt))) &&
    (candidate.error === undefined || typeof candidate.error === 'string')
  )) return null;
  return {
    ...candidate,
    attachments,
    deliveryMode,
    ...(modelOverride ? { modelOverride } : {}),
  } as QueuedPrompt;
}

function storedModelOverride(value: unknown): ChatModelOverride | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ChatModelOverride>;
  if (
    typeof candidate.provider !== 'string' ||
    !candidate.provider.trim() ||
    candidate.provider.length > 256 ||
    typeof candidate.model !== 'string' ||
    !candidate.model.trim() ||
    candidate.model.length > 256 ||
    (candidate.reasoningEffort !== undefined &&
      (typeof candidate.reasoningEffort !== 'string' ||
        !candidate.reasoningEffort.trim() ||
        candidate.reasoningEffort.length > 64)) ||
    (candidate.fast !== undefined && typeof candidate.fast !== 'boolean')
  ) {
    return null;
  }
  return {
    provider: candidate.provider,
    model: candidate.model,
    ...(candidate.reasoningEffort ? { reasoningEffort: candidate.reasoningEffort } : {}),
    ...(typeof candidate.fast === 'boolean' ? { fast: candidate.fast } : {}),
  };
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

function isPromptDeliveryMode(value: unknown): value is PromptDeliveryMode {
  return value === 'queue' || value === 'redirect';
}

function validSessionID(value: string) {
  return value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f/\\]/.test(value);
}

function isComposerAttachment(value: unknown): value is ComposerAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ComposerAttachment>;
  return (
    typeof candidate.id === 'string' &&
    /^[a-f0-9]{32}$/.test(candidate.id) &&
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    candidate.name.length <= 256 &&
    typeof candidate.mimeType === 'string' &&
    (candidate.kind === 'image' || candidate.kind === 'file') &&
    typeof candidate.size === 'number' &&
    Number.isFinite(candidate.size) &&
    candidate.size > 0 &&
    typeof candidate.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.sha256)
  );
}

function validAttachmentRecord(value: unknown) {
  const record: Record<string, ComposerAttachment[]> = {};
  if (!isRecord(value)) return record;
  for (const [key, items] of Object.entries(value)) {
    if (!validKey(key) || !Array.isArray(items)) continue;
    const seen = new Set<string>();
    const valid = items.filter((item): item is ComposerAttachment => {
      if (!isComposerAttachment(item) || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    if (valid.length > 0) record[key] = valid;
  }
  return record;
}

function appendPromptHistory(history: string[], text: string) {
  const withoutDuplicate = history.filter((item) => item !== text);
  return [...withoutDuplicate, text].slice(-100);
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
