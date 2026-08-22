import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeHermesSessionMessages,
  normalizeHermesSessions,
} from '../src/lib/hermes-api.ts';

test('normalizes native Hermes session resources for the Brio UI', () => {
  const session = {
    id: 'session_1',
    source: 'api_server',
    started_at: 1_720_000_000,
    message_count: 2,
    title: 'Native session',
  };
  const message = {
    role: 'assistant',
    content: 'Hello from Hermes',
    timestamp: 1_720_000_001,
  };

  assert.deepEqual(normalizeHermesSessions({ data: [session] }), { sessions: [session] });
  assert.deepEqual(normalizeHermesSessionMessages({ data: [message] }), { messages: [message] });
  assert.deepEqual(normalizeHermesSessions({}), { sessions: [] });
  assert.deepEqual(normalizeHermesSessionMessages({}), { messages: [] });
});
