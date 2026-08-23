import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_ID_HEADER,
  flattenHeaders,
  getHermesModelOptions,
  getHermesSession,
  headerValue,
  mergeRequestHeaders,
  normalizeHermesRunUsage,
  normalizeHermesSessionMessages,
  normalizeHermesSessions,
  sessionIdentityHeaders,
  setHermesSessionModel,
} from '../src/lib/hermes-api.ts';

function createCaptureFetch(response, capture = []) {
  const fetchImpl = async (url, init) => {
    let body;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    } catch {
      body = init?.body;
    }
    capture.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body,
      headers: init?.headers ?? {},
    });
    return { ok: true, status: 200, json: async () => response };
  };
  return { fetchImpl, capture };
}

function hermesRequest(fetchImpl) {
  return { baseUrl: 'http://hermes.local/', apiKey: 'secret', fetchImpl };
}

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

test('getHermesModelOptions issues GET /api/model/options and only adds ?refresh=1 on refresh', async () => {
  const root = {
    model: 'claude-x',
    provider: 'anthropic',
    providers: [
      {
        slug: 'anthropic',
        name: 'Anthropic',
        models: ['claude-x', 'claude-y'],
        backend_provider: 'anthropic',
      },
      { slug: 'openai', name: 'OpenAI', models: ['gpt-test'] },
    ],
  };

  const plain = createCaptureFetch(root);
  assert.deepEqual(await getHermesModelOptions(hermesRequest(plain.fetchImpl)), root);
  assert.equal(plain.capture.length, 1);
  assert.equal(plain.capture[0].method, 'GET');
  assert.equal(plain.capture[0].url, 'http://hermes.local/api/model/options');
  assert.equal(plain.capture[0].headers.authorization, 'Bearer secret');

  const refreshed = createCaptureFetch(root);
  assert.deepEqual(
    await getHermesModelOptions(hermesRequest(refreshed.fetchImpl), true),
    root,
  );
  assert.equal(refreshed.capture[0].url, 'http://hermes.local/api/model/options?refresh=1');

  const empty = createCaptureFetch({});
  assert.deepEqual(await getHermesModelOptions(hermesRequest(empty.fetchImpl)), {
    model: null,
    provider: null,
    providers: [],
  });
});

test('getHermesSession encodes the id, unwraps {session}, tolerates direct objects, rejects bad ids', async () => {
  const session = {
    id: 'abc/1 x',
    source: 'api_server',
    started_at: 1,
    ended_at: null,
    end_reason: 'completed',
    tool_call_count: 3,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 5,
    cache_write_tokens: 6,
    reasoning_tokens: 7,
    estimated_cost_usd: 0.01,
    actual_cost_usd: null,
    api_call_count: 2,
    parent_session_id: null,
    message_count: 4,
  };

  const wrapped = createCaptureFetch({ session });
  assert.deepEqual(
    await getHermesSession(hermesRequest(wrapped.fetchImpl), 'abc/1 x'),
    session,
  );
  assert.equal(wrapped.capture[0].method, 'GET');
  assert.equal(wrapped.capture[0].url, 'http://hermes.local/api/sessions/abc%2F1%20x');

  const direct = createCaptureFetch(session);
  assert.deepEqual(await getHermesSession(hermesRequest(direct.fetchImpl), 'ok'), session);
  assert.equal(direct.capture[0].url, 'http://hermes.local/api/sessions/ok');

  for (const bad of ['', '   ', undefined, 42]) {
    await assert.rejects(
      () => getHermesSession(hermesRequest(createCaptureFetch({}).fetchImpl), bad),
      /non-empty session id/,
    );
  }

  await assert.rejects(
    () => getHermesSession(hermesRequest(createCaptureFetch({}).fetchImpl), 'x'),
    /no valid session/,
  );
});

test('setHermesSessionModel POSTs to /model with payload and returns the unwrapped lock', async () => {
  const payload = {
    provider: 'openai',
    model: 'gpt-test',
    model_options: { temperature: 0.2 },
    require_model_lock: true,
  };
  const lock = {
    provider: 'openai',
    model: 'gpt-test',
    requested_provider: 'openai',
    requested_model: 'gpt-test',
    route_source: 'explicit',
    model_lock: { require_model_lock: true },
  };

  const direct = createCaptureFetch(lock);
  assert.deepEqual(
    await setHermesSessionModel(hermesRequest(direct.fetchImpl), 's/1', payload),
    lock,
  );
  assert.equal(direct.capture[0].method, 'POST');
  assert.equal(direct.capture[0].url, 'http://hermes.local/api/sessions/s%2F1/model');
  assert.deepEqual(direct.capture[0].body, payload);

  const second = createCaptureFetch(lock);
  assert.deepEqual(
    await setHermesSessionModel(hermesRequest(second.fetchImpl), 's1', payload),
    lock,
  );

  await assert.rejects(() =>
    setHermesSessionModel(hermesRequest(createCaptureFetch({}).fetchImpl), '', payload),
  );
});

test('normalizeHermesRunUsage accepts both API and control-RPC usage shapes', () => {
  assert.deepEqual(normalizeHermesRunUsage(null), {
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    api_calls: null,
    context_used: null,
    context_max: null,
    context_percent: null,
    compressions: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    duration_seconds: null,
    model: null,
  });

  assert.deepEqual(normalizeHermesRunUsage({ input_tokens: 3, output_tokens: 4, total_tokens: 7 }), {
    ...normalizeHermesRunUsage(null),
    input_tokens: 3,
    output_tokens: 4,
    total_tokens: 7,
  });

  assert.deepEqual(
    normalizeHermesRunUsage({
      input: '8',
      output: 9,
      reasoning: 5,
      total: 22,
      calls: 2,
      context_used: 100,
      context_max: 200,
      context_percent: 50,
      compressions: 1,
      cache_read_tokens: 11,
      cache_write_tokens: 12,
      estimated_cost_usd: 0.25,
      actual_cost_usd: 0.3,
      duration_seconds: 12.5,
      model: 'gpt-test',
    }),
    {
      input_tokens: 8,
      output_tokens: 9,
      total_tokens: 22,
      reasoning_tokens: 5,
      cache_read_tokens: 11,
      cache_write_tokens: 12,
      api_calls: 2,
      context_used: 100,
      context_max: 200,
      context_percent: 50,
      compressions: 1,
      estimated_cost_usd: 0.25,
      actual_cost_usd: 0.3,
      duration_seconds: 12.5,
      model: 'gpt-test',
    },
  );

  assert.equal(normalizeHermesRunUsage({ input_tokens: Number.NaN }).input_tokens, null);
});

test('session identity headers are only sent for non-empty ids', () => {
  assert.deepEqual(sessionIdentityHeaders('sess_1'), { [SESSION_ID_HEADER]: 'sess_1' });
  assert.deepEqual(sessionIdentityHeaders('  sess_1  '), { [SESSION_ID_HEADER]: 'sess_1' });
  assert.equal(sessionIdentityHeaders(undefined), undefined);
  assert.equal(sessionIdentityHeaders(null), undefined);
  assert.equal(sessionIdentityHeaders('   '), undefined);
  assert.equal(sessionIdentityHeaders(''), undefined);
});

test('relay request headers keep Authorization and merge caller headers on top', () => {
  assert.deepEqual(mergeRequestHeaders('Bearer agent'), { Authorization: 'Bearer agent' });
  assert.deepEqual(mergeRequestHeaders('Bearer agent', { [SESSION_ID_HEADER]: 'sess_9' }), {
    Authorization: 'Bearer agent',
    [SESSION_ID_HEADER]: 'sess_9',
  });
  // The connection Authorization always wins: a caller-supplied Authorization
  // is dropped, never allowed to override the frame credential.
  assert.deepEqual(
    mergeRequestHeaders('Bearer agent', {
      Authorization: 'Bearer caller-token',
      [SESSION_ID_HEADER]: 'sess_9',
    }),
    { Authorization: 'Bearer agent', [SESSION_ID_HEADER]: 'sess_9' },
  );
  assert.deepEqual(flattenHeaders([['a', '1'], ['b', '2']]), { a: '1', b: '2' });
  assert.deepEqual(flattenHeaders(undefined), {});
  if (typeof Headers !== 'undefined') {
    // Node's Headers normalizes keys to lowercase; consumers use headerValue,
    // which is case-insensitive.
    assert.deepEqual(flattenHeaders(new Headers({ [SESSION_ID_HEADER]: 'sess_9' })), {
      'x-hermes-session-id': 'sess_9',
    });
  }
});

test('headerValue looks up terminal headers case-insensitively', () => {
  assert.equal(headerValue({ 'x-hermes-session-id': 'sess_1' }, SESSION_ID_HEADER), 'sess_1');
  assert.equal(headerValue({ 'X-HERMES-SESSION-ID': 'sess_2' }, SESSION_ID_HEADER), 'sess_2');
  assert.equal(headerValue({ [SESSION_ID_HEADER]: '' }, SESSION_ID_HEADER), undefined);
  assert.equal(headerValue({}, SESSION_ID_HEADER), undefined);
  assert.equal(headerValue(undefined, SESSION_ID_HEADER), undefined);
});
