import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_COMPOSER_STATE,
  addComposerAttachment,
  addQueuedPrompt,
  enqueueComposerDraft,
  finalizeAcceptedPrompt,
  moveComposerThread,
  moveQueuedPrompt,
  nextQueuedPrompt,
  removeQueuedPrompt,
  restoreQueuedPromptToDraft,
  updateQueuedPrompt,
  validStoredComposerState,
} from './composer-store-model.ts';

const prompt = (id, text = `prompt ${id}`) => ({
  id,
  text,
  attachments: [],
  deliveryMode: 'queue',
  createdAt: 123,
  state: 'pending',
});

test('validStoredComposerState preserves multiline drafts and delivery state', () => {
  const value = validStoredComposerState({
    drafts: { thread: 'first\n\nthird' },
    queues: {
      thread: [
        { ...prompt('one'), state: 'sending', attemptedAt: 456 },
        { ...prompt('two'), state: 'failed', error: 'delivery uncertain' },
        { id: '', text: 'invalid', createdAt: 1, state: 'pending' },
      ],
    },
    paused: { thread: true, other: false },
  });

  assert.deepEqual(value, {
    drafts: { thread: 'first\n\nthird' },
    attachments: {},
    queues: {
      thread: [
        { ...prompt('one'), state: 'sending', attemptedAt: 456 },
        { ...prompt('two'), state: 'failed', error: 'delivery uncertain' },
      ],
    },
    paused: { thread: true },
    promptHistory: {},
    sessionIds: {},
  });
});

test('validStoredComposerState drops duplicate ids that would make acknowledgements ambiguous', () => {
  const value = validStoredComposerState({
    drafts: {},
    queues: { thread: [prompt('same', 'first'), prompt('same', 'second')] },
    paused: {},
  });

  assert.deepEqual(value?.queues.thread, [prompt('same', 'first')]);
});

test('validStoredComposerState retains stable new-thread session ids only', () => {
  const value = validStoredComposerState({
    drafts: {},
    queues: {},
    paused: {},
    sessionIds: {
      'connection:new': 'brio_new_stable',
      unsafe: '../escape',
    },
  });

  assert.deepEqual(value?.sessionIds, { 'connection:new': 'brio_new_stable' });
});

test('enqueueComposerDraft consumes the current draft exactly once', () => {
  const initial = {
    ...EMPTY_COMPOSER_STATE,
    drafts: { thread: 'preserve\nmultiline' },
  };
  const first = enqueueComposerDraft(initial, 'thread', 'one', 123);
  const duplicate = enqueueComposerDraft(first?.state ?? initial, 'thread', 'two', 124);

  assert.deepEqual(first?.prompt, prompt('one', 'preserve\nmultiline'));
  assert.equal(first?.state.drafts.thread, undefined);
  assert.equal(duplicate, null);
  assert.deepEqual(first?.state.promptHistory.thread, ['preserve\nmultiline']);
});

test('attachment-only drafts queue safely and retain the requested delivery mode', () => {
  const attachment = {
    id: 'a'.repeat(32),
    name: 'diagram.png',
    mimeType: 'image/png',
    kind: 'image',
    size: 123,
    sha256: 'b'.repeat(64),
  };
  const initial = addComposerAttachment(EMPTY_COMPOSER_STATE, 'thread', attachment);
  const enqueued = enqueueComposerDraft(initial, 'thread', 'one', 123, 'redirect');

  assert.equal(enqueued?.prompt.text, '');
  assert.deepEqual(enqueued?.prompt.attachments, [attachment]);
  assert.equal(enqueued?.prompt.deliveryMode, 'redirect');
  assert.equal(enqueued?.state.attachments.thread, undefined);
});

test('a claimed prompt stays non-pending until the user explicitly retries it', () => {
  let state = addQueuedPrompt(EMPTY_COMPOSER_STATE, 'thread', prompt('one'));
  state = updateQueuedPrompt(state, 'thread', 'one', {
    state: 'sending',
    attemptedAt: 456,
  });

  assert.equal(state.queues.thread?.[0]?.state, 'sending');
  assert.equal(nextQueuedPrompt(state, 'thread'), null);

  state = updateQueuedPrompt(state, 'thread', 'one', {
    state: 'pending',
  });
  assert.deepEqual(state.queues.thread?.[0], prompt('one'));
  assert.deepEqual(nextQueuedPrompt(state, 'thread'), prompt('one'));
});

test('an unconfirmed head item blocks later prompts to preserve queue order', () => {
  let state = addQueuedPrompt(EMPTY_COMPOSER_STATE, 'thread', {
    ...prompt('one'),
    state: 'failed',
    error: 'timeout',
  });
  state = addQueuedPrompt(state, 'thread', prompt('two'));

  assert.equal(nextQueuedPrompt(state, 'thread'), null);
});

test('queue items can be reordered and removed without mutating prior state', () => {
  const first = addQueuedPrompt(EMPTY_COMPOSER_STATE, 'thread', prompt('one'));
  const second = addQueuedPrompt(first, 'thread', prompt('two'));
  const reordered = moveQueuedPrompt(second, 'thread', 'two', -1);
  const removed = removeQueuedPrompt(reordered, 'thread', 'two');

  assert.deepEqual(first.queues.thread?.map((item) => item.id), ['one']);
  assert.deepEqual(reordered.queues.thread?.map((item) => item.id), ['two', 'one']);
  assert.deepEqual(removed.queues.thread?.map((item) => item.id), ['one']);
});

test('pending prompts cannot move across an in-flight delivery barrier', () => {
  let state = addQueuedPrompt(EMPTY_COMPOSER_STATE, 'thread', {
    ...prompt('sending'),
    state: 'sending',
    attemptedAt: 456,
  });
  state = addQueuedPrompt(state, 'thread', prompt('later'));

  const moved = moveQueuedPrompt(state, 'thread', 'later', -1);
  assert.deepEqual(moved.queues.thread?.map((item) => item.id), ['sending', 'later']);
});

test('redirect prompts are persisted directly behind the in-flight prompt', () => {
  let state = addQueuedPrompt(EMPTY_COMPOSER_STATE, 'thread', {
    ...prompt('sending'),
    state: 'sending',
    attemptedAt: 456,
  });
  state = addQueuedPrompt(state, 'thread', prompt('queued'));
  state = addQueuedPrompt(state, 'thread', {
    ...prompt('redirect'),
    deliveryMode: 'redirect',
  });

  assert.deepEqual(state.queues.thread?.map((item) => item.id), [
    'sending',
    'redirect',
    'queued',
  ]);
});

test('editing a queued prompt restores it atomically without overwriting another draft', () => {
  const queued = addQueuedPrompt(EMPTY_COMPOSER_STATE, 'thread', prompt('one'));
  const restored = restoreQueuedPromptToDraft(queued, 'thread', 'one');
  const occupied = restoreQueuedPromptToDraft(
    { ...queued, drafts: { thread: 'newer draft' } },
    'thread',
    'one',
  );

  assert.equal(restored.drafts.thread, 'prompt one');
  assert.equal(restored.queues.thread, undefined);
  assert.equal(occupied.drafts.thread, 'newer draft');
  assert.deepEqual(occupied.queues.thread, [prompt('one')]);
});

test('editing restores queued attachments with the text as one atomic draft', () => {
  const attachment = {
    id: 'c'.repeat(32),
    name: 'notes.txt',
    mimeType: 'text/plain',
    kind: 'file',
    size: 10,
    sha256: 'd'.repeat(64),
  };
  const queued = addQueuedPrompt(EMPTY_COMPOSER_STATE, 'thread', {
    ...prompt('one'),
    attachments: [attachment],
  });
  const restored = restoreQueuedPromptToDraft(queued, 'thread', 'one');

  assert.equal(restored.drafts.thread, 'prompt one');
  assert.deepEqual(restored.attachments.thread, [attachment]);
  assert.equal(restored.queues.thread, undefined);
});

test('new-thread composer state moves to the durable session without duplication', () => {
  let state = addQueuedPrompt(EMPTY_COMPOSER_STATE, 'connection:new', prompt('one'));
  state = {
    ...state,
    drafts: { ...state.drafts, 'connection:new': 'next prompt' },
    paused: { 'connection:new': true },
    sessionIds: { 'connection:new': 'brio_new_stable' },
  };

  const moved = moveComposerThread(state, 'connection:new', 'connection:session');
  const movedAgain = moveComposerThread(moved, 'connection:new', 'connection:session');

  assert.equal(moved.drafts['connection:new'], undefined);
  assert.equal(moved.drafts['connection:session'], 'next prompt');
  assert.deepEqual(moved.queues['connection:session']?.map((item) => item.id), ['one']);
  assert.equal(moved.paused['connection:session'], true);
  assert.equal(moved.sessionIds['connection:new'], undefined);
  assert.equal(moved.sessionIds['connection:session'], 'brio_new_stable');
  assert.deepEqual(movedAgain, moved);
});

test('accepted prompt finalization removes only the confirmed item while migrating the rest', () => {
  let state = addQueuedPrompt(EMPTY_COMPOSER_STATE, 'connection:new', {
    ...prompt('accepted'),
    state: 'sending',
    attemptedAt: 456,
  });
  state = addQueuedPrompt(state, 'connection:new', prompt('follow-up'));

  const finalized = finalizeAcceptedPrompt(
    state,
    'connection:new',
    'connection:session',
    'accepted',
  );
  assert.equal(finalized.queues['connection:new'], undefined);
  assert.deepEqual(finalized.queues['connection:session'], [prompt('follow-up')]);
});
