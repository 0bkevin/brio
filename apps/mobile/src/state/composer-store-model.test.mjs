import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_COMPOSER_STATE,
  addQueuedPrompt,
  moveComposerThread,
  moveQueuedPrompt,
  nextQueuedPrompt,
  removeQueuedPrompt,
  updateQueuedPrompt,
  validStoredComposerState,
} from './composer-store-model.ts';

const prompt = (id, text = `prompt ${id}`) => ({
  id,
  text,
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
    queues: {
      thread: [
        { ...prompt('one'), state: 'sending', attemptedAt: 456 },
        { ...prompt('two'), state: 'failed', error: 'delivery uncertain' },
      ],
    },
    paused: { thread: true },
  });
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

test('new-thread composer state moves to the durable session without duplication', () => {
  let state = addQueuedPrompt(EMPTY_COMPOSER_STATE, 'connection:new', prompt('one'));
  state = {
    ...state,
    drafts: { ...state.drafts, 'connection:new': 'next prompt' },
    paused: { 'connection:new': true },
  };

  const moved = moveComposerThread(state, 'connection:new', 'connection:session');
  const movedAgain = moveComposerThread(moved, 'connection:new', 'connection:session');

  assert.equal(moved.drafts['connection:new'], undefined);
  assert.equal(moved.drafts['connection:session'], 'next prompt');
  assert.deepEqual(moved.queues['connection:session']?.map((item) => item.id), ['one']);
  assert.equal(moved.paused['connection:session'], true);
  assert.deepEqual(movedAgain, moved);
});
