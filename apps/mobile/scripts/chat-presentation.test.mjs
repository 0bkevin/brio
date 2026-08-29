import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanArchivedSearchSnippet,
  hasMatchingUserMessage,
  isSafeArchivedUserSnippet,
  isVisibleConversationMessage,
  runActivityLabel,
  toVisibleConversationMessage,
  toolActivityLabel,
  upsertChatActivity,
} from '../src/lib/chat-presentation.ts';

test('chat history excludes Hermes internals and empty transcript records', () => {
  const messages = [
    { role: 'system', content: 'private instructions' },
    { role: 'tool', content: 'raw command output' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'Build the screen' },
    { role: 'assistant', content: 'Done.' },
  ];

  assert.deepEqual(messages.filter(isVisibleConversationMessage), [
    { role: 'user', content: 'Build the screen' },
    { role: 'assistant', content: 'Done.' },
  ]);
});

test('synthetic user-role runtime prompts never appear as messages from the person', () => {
  const internalMessages = [
    {
      role: 'user',
      content: "You've reached the maximum number of tool-calling iterations allowed. Please provide a final response summarizing what you've found and accomplished so far, without calling any more tools.",
    },
    {
      role: 'user',
      content: '[Your active task list was preserved across context compression]\n- Reload skills\n\n[Skills pruned during compression — reload before acting on these tasks]\nThe task list above crossed the compression boundary verbatim.',
    },
    {
      role: 'user',
      content: '[System: Your previous response was truncated by the output length limit. Continue exactly where you left off.]',
    },
    { role: 'user', content: '[IMPORTANT: Background process 123 completed]' },
    { role: 'user', content: 'internal event', display_kind: 'internal_notification' },
    { role: 'assistant', content: '(empty)' },
    { role: 'assistant', content: "Task Snapshot\nUser asked (deterministic, from compacted turns): 'Create a form'" },
    { role: 'assistant', content: 'I will inspect it.', tool_calls: [{ id: 'tool-1' }] },
  ];

  assert.deepEqual(internalMessages.map(toVisibleConversationMessage), internalMessages.map(() => null));
});

test('compaction carriers keep human-authored text while removing internal context', () => {
  const todoCarrier = {
    role: 'user',
    content: 'Please finish the form.\n\n[Your active task list was preserved across context compression]\n- Internal task',
  };
  const summaryCarrier = {
    role: 'user',
    content: '[CONTEXT COMPACTION — REFERENCE ONLY] internal summary\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---\nPlease use the blue theme.',
  };
  const mergedCarrier = {
    role: 'user',
    content: '[PRIOR CONTEXT — for reference only; not a new message]\nMy earlier real request\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n[CONTEXT COMPACTION — REFERENCE ONLY] internal summary',
  };

  assert.equal(toVisibleConversationMessage(todoCarrier)?.content, 'Please finish the form.');
  assert.equal(toVisibleConversationMessage(summaryCarrier)?.content, 'Please use the blue theme.');
  assert.equal(toVisibleConversationMessage(mergedCarrier)?.content, 'My earlier real request');
});

test('dashboard display projections take precedence over physical compaction content', () => {
  const projected = toVisibleConversationMessage({
    role: 'user',
    content: '[CONTEXT COMPACTION — REFERENCE ONLY] internal summary',
    display_content: 'Please create the registration form.',
  });
  assert.equal(projected?.content, 'Please create the registration form.');
});

test('archived history search cleans FTS markup and rejects internal summaries', () => {
  assert.equal(
    cleanArchivedSearchSnippet('...crea un >>>formulario<<< de pagos...'),
    '...crea un formulario de pagos...',
  );
  assert.equal(isSafeArchivedUserSnippet('Quiero un formulario para ABBA'), true);
  assert.equal(isSafeArchivedUserSnippet('[CONTEXT COMPACTION] formulario ABBA'), false);
  assert.equal(isSafeArchivedUserSnippet('[tool: skill_view] ## Active State'), false);
  assert.equal(
    isSafeArchivedUserSnippet("...Task Snapshot User asked (deterministic, from compacted turns): 'Create a form'..."),
    false,
  );
});

test('optimistic prompts deduplicate even after Hermes has appended a response', () => {
  const messages = [
    { role: 'user', content: 'Check the project' },
    { role: 'assistant', content: 'Everything looks good.' },
  ];

  assert.equal(hasMatchingUserMessage(messages, 'Check the project'), true);
  assert.equal(hasMatchingUserMessage(messages, 'Another prompt'), false);
});

test('tool activity uses safe category labels instead of names or payloads', () => {
  assert.equal(toolActivityLabel('terminal', false), 'Running a command');
  assert.equal(toolActivityLabel('terminal', true), 'Command finished');
  assert.equal(toolActivityLabel('web_search', false), 'Searching sources');
  assert.equal(toolActivityLabel('apply_patch', true), 'Files updated');
  assert.equal(toolActivityLabel('skill_loader', false), 'Preparing the task');
  assert.equal(toolActivityLabel('secret-internal-tool', false), 'Working on the next step');
});

test('run labels never expose raw unknown event names', () => {
  assert.equal(runActivityLabel('reasoning.delta'), 'Planning the next step');
  assert.equal(runActivityLabel('tool.start', { id: '1', label: 'Searching sources', status: 'running' }), 'Searching sources');
  assert.equal(runActivityLabel('private.skill.bootstrap'), 'Hermes is working');
});

test('activity list updates in place and stays compact', () => {
  let activity = upsertChatActivity([], { id: 'tool-1', label: 'Running a command', status: 'running' });
  activity = upsertChatActivity(activity, { id: 'tool-1', label: 'Command finished', status: 'complete' });
  assert.deepEqual(activity, [{ id: 'tool-1', label: 'Command finished', status: 'complete' }]);

  for (let index = 2; index <= 7; index += 1) {
    activity = upsertChatActivity(activity, { id: `tool-${index}`, label: `Step ${index}`, status: 'complete' });
  }
  assert.deepEqual(activity.map((item) => item.id), ['tool-4', 'tool-5', 'tool-6', 'tool-7']);
});
