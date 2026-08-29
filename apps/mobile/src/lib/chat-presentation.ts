export type ConversationMessage = {
  role: string;
  content: string;
  display_content?: string;
  display_kind?: string;
  tool_calls?: unknown[];
  tool_name?: string;
};

export type ChatActivityStatus = 'running' | 'complete';

export type ChatActivity = {
  id: string;
  label: string;
  status: ChatActivityStatus;
};

const TODO_SNAPSHOT_HEADER = '[Your active task list was preserved across context compression]';
const COMPACTION_PREFIX = '[CONTEXT COMPACTION — REFERENCE ONLY]';
const LEGACY_COMPACTION_PREFIX = '[CONTEXT SUMMARY]:';
const COMPACTION_END_MARKER =
  '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---';
const MERGED_CONTEXT_HEADER = '[PRIOR CONTEXT — for reference only; not a new message]';
const MERGED_CONTEXT_DELIMITER = '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]';

const INTERNAL_USER_MESSAGES = new Set([
  'Continue from the compressed conversation context above. This marker exists because no human user turn was available.',
  'Continue from the compressed conversation context above. This marker exists because the compacted transcript contained no preserved user turn.',
  "You've reached the maximum number of tool-calling iterations allowed. Please provide a final response summarizing what you've found and accomplished so far, without calling any more tools.",
  '[System: Your previous response contained only internal reasoning and never produced a visible answer or tool call. Do not keep thinking. Produce your final answer as plain text now (or make the tool call you were planning).]',
  '[System: Continue now. Execute the required tool calls and only send your final answer after completing the task.]',
  'Your previous turn indicated a tool call but none was included. Do not narrate a plan or restate intent — issue the actual tool call now to continue the task.',
  'You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task.',
]);

const INTERNAL_USER_PREFIXES = [
  "You've reached the maximum number of tool-calling iterations allowed.",
  'You have reached the maximum number of tool-calling iterations allowed.',
  '[System: Your previous response was truncated',
  '[System: The previous response was cut off',
  '[System: Your previous tool call ',
  '[System: The active model for this chat has changed to ',
  '[System: You edited code in this turn, but the workspace does not have fresh passing verification evidence yet.',
  '[System: You are a Hermes kanban worker.',
  '[IMPORTANT: Background process ',
  '[Skills pruned during compression — reload before acting on these tasks]',
];

function withoutSyntheticUserSuffix(content: string) {
  const snapshotIndex = content.indexOf(TODO_SNAPSHOT_HEADER);
  return snapshotIndex >= 0 ? content.slice(0, snapshotIndex).trim() : content.trim();
}

function contentOutsideCompaction(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith(MERGED_CONTEXT_HEADER)) {
    const delimiterIndex = trimmed.indexOf(MERGED_CONTEXT_DELIMITER);
    if (delimiterIndex >= 0) {
      return trimmed.slice(MERGED_CONTEXT_HEADER.length, delimiterIndex).trim();
    }
  }
  if (trimmed.startsWith(COMPACTION_PREFIX) || trimmed.startsWith(LEGACY_COMPACTION_PREFIX)) {
    const markerIndex = trimmed.indexOf(COMPACTION_END_MARKER);
    return markerIndex >= 0
      ? trimmed.slice(markerIndex + COMPACTION_END_MARKER.length).trim()
      : '';
  }
  return trimmed;
}

/**
 * Hermes persists provider-alternation scaffolding under role="user" even
 * though nobody typed it. Project the stored transcript to the human-facing
 * conversation and retain real text if a compaction carrier contains both.
 */
export function toVisibleConversationMessage<T extends ConversationMessage>(message: T): T | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  if (message.display_kind?.trim()) return null;
  if (message.role === 'assistant' && (message.tool_name || message.tool_calls?.length)) return null;
  const projectedContent = typeof message.display_content === 'string'
    ? message.display_content
    : message.content;
  if (typeof projectedContent !== 'string') return null;

  let content = contentOutsideCompaction(projectedContent);
  if (message.role === 'user') {
    content = withoutSyntheticUserSuffix(content);
    if (!content || INTERNAL_USER_MESSAGES.has(content)) return null;
    if (INTERNAL_USER_PREFIXES.some((prefix) => content.startsWith(prefix))) return null;
  } else if (!content || content === '(empty)') {
    return null;
  }
  if (/^(?:#+\s*)?Task Snapshot\b/i.test(content)) return null;

  return content === message.content ? message : { ...message, content };
}

export function cleanArchivedSearchSnippet(snippet: string) {
  return snippet
    .replace(/>>>|<<</g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isSafeArchivedUserSnippet(snippet: string) {
  const content = cleanArchivedSearchSnippet(snippet);
  if (!content) return false;
  return ![
    'CONTEXT COMPACTION',
    'active task list was preserved',
    'Skills pruned during compression',
    'maximum number of tool-calling iterations',
    'END OF PRIOR CONTEXT',
    '[tool:',
    '## Active State',
    'Task Snapshot',
    'deterministic, from compacted turns',
    'contenido quedó podado',
  ].some((marker) => content.includes(marker));
}

export function isVisibleConversationMessage(message: ConversationMessage) {
  return toVisibleConversationMessage(message) !== null;
}

export function hasMatchingUserMessage(messages: ConversationMessage[], content: string) {
  return messages.some(
    (message) => message.role === 'user' && message.content === content,
  );
}

export function toolActivityLabel(toolName: string, complete: boolean) {
  const normalized = toolName.trim().toLowerCase();
  const labels = (running: string, done: string) => (complete ? done : running);

  if (/test|lint|typecheck|check|verify|validate/.test(normalized)) {
    return labels('Checking the work', 'Checks finished');
  }
  if (/write|edit|patch|create|delete|remove|move|rename|replace/.test(normalized)) {
    return labels('Updating files', 'Files updated');
  }
  if (/search|web|browser|fetch|crawl|http|exa|serper|firecrawl/.test(normalized)) {
    return labels('Searching sources', 'Sources reviewed');
  }
  if (/read|list|find|glob|grep|file/.test(normalized)) {
    return labels('Reading project context', 'Project context reviewed');
  }
  if (/terminal|shell|exec|command|bash|powershell/.test(normalized)) {
    return labels('Running a command', 'Command finished');
  }
  if (/gmail|email|mail/.test(normalized)) {
    return labels('Working with email', 'Email step finished');
  }
  if (/calendar|schedule/.test(normalized)) {
    return labels('Checking the schedule', 'Schedule reviewed');
  }
  if (/image|photo|vision/.test(normalized)) {
    return labels('Working with an image', 'Image step finished');
  }
  if (/skill|prompt|instruction/.test(normalized)) {
    return labels('Preparing the task', 'Task prepared');
  }
  if (/subagent|delegate|agent/.test(normalized)) {
    return labels('Coordinating the work', 'Coordination finished');
  }
  return labels('Working on the next step', 'Step finished');
}

export function runActivityLabel(event: string | null | undefined, latest?: ChatActivity) {
  switch (event) {
    case 'message.start':
      return 'Starting the response';
    case 'message.delta':
      return 'Writing the response';
    case 'reasoning.delta':
    case 'reasoning.available':
    case 'thinking.delta':
      return 'Planning the next step';
    case 'tool.start':
    case 'tool.complete':
      return latest?.label ?? 'Working on the next step';
    case 'approval.request':
      return 'Waiting for your approval';
    case 'clarify.request':
      return 'Waiting for your answer';
    case 'sudo.request':
    case 'secret.request':
      return 'Waiting for a secure value';
    case 'session.usage':
      return 'Updating progress';
    default:
      return 'Hermes is working';
  }
}

export function upsertChatActivity(current: ChatActivity[], next: ChatActivity, limit = 4) {
  const withoutCurrent = current.filter((item) => item.id !== next.id);
  return [...withoutCurrent, next].slice(-limit);
}
