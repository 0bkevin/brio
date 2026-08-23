import assert from 'node:assert/strict';
import test from 'node:test';

import { responseRequestBody } from '../src/lib/response-request.ts';

test('request bodies carry model overrides together with composer fields', () => {
  const body = responseRequestBody(
    'hello',
    {
      conversation: 'thread_1',
      provider: 'anthropic',
      model: 'claude-x',
      modelOptions: { reasoning: { enabled: true, effort: 'high' } },
      composerSessionId: 'composer_1',
      attachmentIds: ['att_1', 'att_2'],
    },
    true,
  );
  assert.deepEqual(body, {
    model: 'claude-x',
    provider: 'anthropic',
    model_options: { reasoning: { enabled: true, effort: 'high' } },
    input: 'hello',
    stream: true,
    brio_session_id: 'composer_1',
    brio_attachments: ['att_1', 'att_2'],
    conversation: 'thread_1',
  });
});

test('requests without an override keep the profile default and drop empty composer fields', () => {
  const body = responseRequestBody('hello', {}, false);
  assert.deepEqual(body, { model: 'hermes-agent', input: 'hello', stream: false });

  const withEmptyExtras = responseRequestBody(
    'hello',
    { composerSessionId: '', attachmentIds: [] },
    false,
  );
  assert.deepEqual(withEmptyExtras, { model: 'hermes-agent', input: 'hello', stream: false });
});

test('retry requests preserve the same override and composer data as the primary', () => {
  const options = {
    conversation: 'composer_1',
    previousResponseId: 'resp_1',
    provider: 'openai',
    model: 'gpt-test',
    modelOptions: { fast: true },
    sessionId: 'sess_runtime',
    composerSessionId: 'composer_1',
    attachmentIds: ['att_1'],
  };
  const primary = responseRequestBody('hi', options, true);
  // A retry drops previous_response_id and re-seeds the full history but must
  // keep the frozen override and composer identity/attachments.
  const retry = responseRequestBody('hi', { ...options, previousResponseId: undefined }, true);
  for (const body of [primary, retry]) {
    assert.equal(body.model, 'gpt-test');
    assert.equal(body.provider, 'openai');
    assert.deepEqual(body.model_options, { fast: true });
    assert.equal(body.brio_session_id, 'composer_1');
    assert.deepEqual(body.brio_attachments, ['att_1']);
  }
  assert.equal(primary.previous_response_id, 'resp_1');
  assert.equal(retry.previous_response_id, undefined);
  assert.equal(retry.conversation, 'composer_1');
});

test('conversation history is only sent without a previous response id', () => {
  const history = [{ role: 'user', content: 'hi' }];
  const seeded = responseRequestBody(
    'again',
    { conversation: 'c1', conversationHistory: history },
    true,
  );
  assert.deepEqual(seeded.conversation_history, history);
  assert.equal(seeded.conversation, 'c1');

  const continued = responseRequestBody(
    'again',
    { conversation: 'c1', conversationHistory: history, previousResponseId: 'resp_9' },
    true,
  );
  assert.equal(continued.previous_response_id, 'resp_9');
  assert.equal(continued.conversation_history, undefined);

  const bare = responseRequestBody('again', { conversation: 'c1' }, true);
  assert.equal(bare.conversation, 'c1');
  assert.equal(bare.conversation_history, undefined);
});
