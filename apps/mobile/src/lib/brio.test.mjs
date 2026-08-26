import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  explainConnectionError,
  friendlyPayloadError,
  validateManualConnection,
} from '../features/connection/connection-experience.ts';
import {
  removeStoredConnection,
  removeStoredConnectionsWhere,
  upsertStoredConnection,
  validStoredConnections,
} from '../state/connection-store-model.ts';
import {
  aggregateRootAgentUsage,
  BrioRequestError,
  brioFetch,
  connectionFromPairingPayload,
  createSession,
  ensureSession,
  decodePairingPayload,
  extractPairingPayload,
  filterAgentsForControlSession,
  finalizeConnection,
  getHealth,
  normalizeMessageList,
  normalizeCapabilities,
  normalizeFileList,
  normalizeHealth,
  normalizeSessionList,
  normalizeSkills,
  normalizeToolsets,
  normalizeConnectionURL,
  parseGoalStatus,
  parseHeartbeatStatus,
} from './brio.ts';

test('normalizes current Hermes list envelopes without breaking legacy responses', () => {
  const sessions = [{ id: 's1' }];
  const messages = [{ role: 'assistant', content: 'ok' }];
  assert.deepEqual(normalizeSessionList({ data: sessions }).sessions, sessions);
  assert.deepEqual(normalizeSessionList({ sessions }).sessions, sessions);
  assert.deepEqual(normalizeMessageList({ data: messages }).messages, messages);
  assert.deepEqual(normalizeMessageList({ messages }).messages, messages);
});

test('creates a persisted Hermes session before a REST-backed new thread starts', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify({
      object: 'hermes.session',
      session: { id: 'brio_new_test', source: 'api_server', started_at: 1, message_count: 0 },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const created = await createSession({
      id: 'direct-1',
      name: 'Hermes',
      mode: 'self_hosted',
      transport: 'direct',
      status: 'online',
      capabilities: {},
      url: 'http://127.0.0.1:8787',
      token: 'secret',
    }, 'brio_new_test', 'coder');
    assert.equal(created.session.id, 'brio_new_test');
    assert.equal(request.input, 'http://127.0.0.1:8787/p/coder/api/sessions');
    assert.equal(request.init.method, 'POST');
    assert.deepEqual(JSON.parse(request.init.body), { id: 'brio_new_test', source: 'api_server' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reuses a session created by an earlier failed REST attempt', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({
        error: { message: 'Session already exists: brio_new_retry' },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      object: 'hermes.session',
      session: { id: 'brio_new_retry', source: 'api_server', started_at: 1, message_count: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const existing = await ensureSession({
      id: 'direct-1',
      name: 'Hermes',
      mode: 'self_hosted',
      transport: 'direct',
      status: 'online',
      capabilities: {},
      url: 'http://127.0.0.1:8787',
      token: 'secret',
    }, 'brio_new_retry');
    assert.equal(existing.session.id, 'brio_new_retry');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].input, 'http://127.0.0.1:8787/api/sessions/brio_new_retry');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('persists a selected model after ensuring a retry-safe session', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    if (String(input).endsWith('/model')) {
      return new Response(JSON.stringify({
        provider: 'openrouter',
        model: 'test/model',
        model_options: { reasoning: { enabled: true, effort: 'high' } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      object: 'hermes.session',
      session: { id: 'brio_new_model', source: 'api_server', started_at: 1, message_count: 0 },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await ensureSession({
      id: 'direct-1',
      name: 'Hermes',
      mode: 'self_hosted',
      transport: 'direct',
      status: 'online',
      capabilities: {},
      url: 'http://127.0.0.1:8787',
      token: 'secret',
    }, 'brio_new_model', 'coder', {
      provider: 'openrouter',
      model: 'test/model',
      model_options: { reasoning: { enabled: true, effort: 'high' } },
      require_model_lock: true,
    });
    assert.deepEqual(requests.map((request) => request.input), [
      'http://127.0.0.1:8787/p/coder/api/sessions',
      'http://127.0.0.1:8787/p/coder/api/sessions/brio_new_model/model',
    ]);
    assert.deepEqual(JSON.parse(requests[1].init.body), {
      provider: 'openrouter',
      model: 'test/model',
      model_options: { reasoning: { enabled: true, effort: 'high' } },
      require_model_lock: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preserves HTTP status on structured API failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'Run not found' },
  }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  try {
    await assert.rejects(
      brioFetch({ url: 'http://127.0.0.1:8787', token: 'secret' }, '/v1/runs/missing'),
      (error) =>
        error instanceof BrioRequestError &&
        error.status === 404 &&
        error.message === 'Run not found',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizes native Hermes health and capabilities for connection screens', () => {
  assert.deepEqual(
    normalizeHealth({ status: 'ok', platform: 'hermes-agent', version: '0.20.5' }),
    {
      status: 'ok',
      platform: 'hermes-agent',
      version: '0.20.5',
      ok: true,
      agent_ok: true,
      agent_kind: 'hermes',
      agent_name: 'Hermes Agent',
      hermes_ok: true,
    },
  );
  assert.deepEqual(
    normalizeCapabilities({ features: { responses_api: true, audio_api: false } }).companion,
    { responses_api: true, audio_api: false },
  );
});

test('normalizes current Hermes dashboard resources for the Mobile screens', () => {
  const files = normalizeFileList({
    path: '/workspace',
    entries: [{ name: 'src', path: '/workspace/src', is_directory: true, size: null }],
    root: '/workspace',
  });
  assert.equal(files.entries[0].dir, true);
  assert.equal(files.entries[0].size, 0);
  assert.deepEqual(files.roots, ['/workspace']);

  const skills = normalizeSkills([
    { name: 'browser', category: 'web', provenance: 'bundled', enabled: true },
  ]);
  assert.equal(skills.skills[0].path, 'bundled');

  const toolsets = normalizeToolsets([
    { name: 'browser', platform: 'cli', enabled: true },
    { name: 'vision', platform: 'cli', enabled: false },
  ]);
  assert.deepEqual(toolsets.toolsets, { cli: ['browser'] });
});

test('surfaces structured API errors as useful messages', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'not_found', message: 'Session does not exist' } }), {
      headers: { 'Content-Type': 'application/json' },
      status: 404,
    });
  try {
    await assert.rejects(
      brioFetch({ url: 'http://127.0.0.1:8787', token: 'secret', transport: 'direct' }, '/missing'),
      /Session does not exist/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const directPayload = {
  url: 'http://192.168.1.25:8787',
  token: 'mobile-secret',
  mode: 'direct',
  transport: 'direct',
};

test('decodes a legacy direct-pairing payload', () => {
  const encoded = Buffer.from(JSON.stringify(directPayload)).toString('base64url');
  assert.deepEqual(decodePairingPayload(encoded), directPayload);
});

test('keeps Hermes serve address and credential separate from the direct API server', () => {
  const payload = decodePairingPayload(JSON.stringify({
    ...directPayload,
    gateway_url: 'http://192.168.1.25:9119',
    gateway_token: 'dashboard-secret',
  }));
  const connection = connectionFromPairingPayload(payload);
  assert.equal(connection.url, directPayload.url);
  assert.equal(connection.token, directPayload.token);
  assert.equal(connection.gatewayUrl, 'http://192.168.1.25:9119');
  assert.equal(connection.gatewayToken, 'dashboard-secret');
});

test('unwraps Brio mobile pairing deep links', () => {
  const encoded = Buffer.from(JSON.stringify(directPayload)).toString('base64url');
  const deepLink = `brio://pair?pairingPayload=${encodeURIComponent(encoded)}`;
  assert.deepEqual(extractPairingPayload(deepLink), directPayload);
});

test('extracts labeled details from a Hermes response', () => {
  assert.deepEqual(extractPairingPayload('URL: http://10.0.0.8:8787\nToken: secret-token'), {
    url: 'http://10.0.0.8:8787',
    token: 'secret-token',
    mode: 'direct',
    transport: 'direct',
  });
});

test('rejects incomplete, unsupported, and unsafe pairing payloads', () => {
  assert.throws(
    () => decodePairingPayload(JSON.stringify({ url: 'http://host:8787', transport: 'direct' })),
    /token/,
  );
  assert.throws(
    () =>
      decodePairingPayload(
        JSON.stringify({ url: 'javascript:alert(1)', token: 'secret', transport: 'direct' }),
      ),
    /HTTP or HTTPS/,
  );
  assert.throws(
    () =>
      decodePairingPayload(
        JSON.stringify({ url: 'https://host', token: 'secret', transport: 'bluetooth' }),
      ),
    /unsupported connection type/,
  );
  assert.throws(
    () => decodePairingPayload(JSON.stringify({ url: 'https://relay', transport: 'relay' })),
    /claim code/,
  );
  assert.throws(
    () =>
      decodePairingPayload(
        JSON.stringify({
          url: 'https://host',
          token: 'secret',
          mode: 'relay',
          transport: 'direct',
        }),
      ),
    /conflicting connection types/,
  );
  assert.throws(
    () =>
      decodePairingPayload(
        JSON.stringify({ url: 'https://host#token=secret', token: 'secret', transport: 'direct' }),
      ),
    /invalid server address/,
  );
  assert.throws(
    () => decodePairingPayload(JSON.stringify({ ...directPayload, gateway_url: 'http://host:9119' })),
    /both an address and a token/,
  );
});

test('normalizes only private and tailnet addresses to HTTP by default', () => {
  assert.equal(normalizeConnectionURL('192.168.1.25:8787'), 'http://192.168.1.25:8787');
  assert.equal(normalizeConnectionURL('100.64.0.1:8787'), 'http://100.64.0.1:8787');
  assert.equal(normalizeConnectionURL('100.100.10.25:8787'), 'http://100.100.10.25:8787');
  assert.equal(normalizeConnectionURL('100.127.255.254:8787'), 'http://100.127.255.254:8787');
  assert.equal(normalizeConnectionURL('100.63.255.255:8787'), 'https://100.63.255.255:8787');
  assert.equal(normalizeConnectionURL('100.128.0.1:8787'), 'https://100.128.0.1:8787');
  assert.equal(normalizeConnectionURL('8.8.8.8:8787'), 'https://8.8.8.8:8787');
  assert.equal(normalizeConnectionURL('[::1]:8787'), 'http://[::1]:8787');
  assert.equal(
    normalizeConnectionURL('[fd7a:115c:a1e0::1]:8787'),
    'http://[fd7a:115c:a1e0::1]:8787',
  );
  assert.equal(
    normalizeConnectionURL('[2001:4860:4860::8888]:8787'),
    'https://[2001:4860:4860::8888]:8787',
  );
  assert.equal(normalizeConnectionURL('hermes.local:8787'), 'http://hermes.local:8787');
  assert.equal(
    normalizeConnectionURL('mac.tailnet.ts.net:8787'),
    'https://mac.tailnet.ts.net:8787',
  );
  assert.equal(
    normalizeConnectionURL('http://mac.tailnet.ts.net:8787'),
    'http://mac.tailnet.ts.net:8787',
  );
  assert.equal(normalizeConnectionURL('remote.example.com'), 'https://remote.example.com');
});

test('gives direct environments stable and distinct identities', () => {
  const first = connectionFromPairingPayload(directPayload);
  const same = connectionFromPairingPayload({ ...directPayload, token: 'rotated-token' });
  const other = connectionFromPairingPayload({ ...directPayload, url: 'http://192.168.1.26:8787' });

  assert.equal(first.id, same.id);
  assert.notEqual(first.id, other.id);
  assert.equal(first.name, '192.168.1.25');
});

test('stores multiple environments and rotates credentials without duplicates', () => {
  const first = connectionFromPairingPayload(directPayload);
  const second = connectionFromPairingPayload({
    ...directPayload,
    url: 'http://192.168.1.26:8787',
  });
  const rotated = connectionFromPairingPayload({ ...directPayload, token: 'rotated-token' });

  let stored = upsertStoredConnection({ activeConnectionId: null, connections: [] }, first);
  stored = upsertStoredConnection(stored, second);
  assert.equal(stored.connections.length, 2);
  assert.equal(stored.activeConnectionId, second.id);

  stored = upsertStoredConnection(stored, rotated);
  assert.equal(stored.connections.length, 2);
  assert.equal(stored.connections.find((item) => item.id === rotated.id)?.token, 'rotated-token');
});

test('removing the active environment selects a remaining environment', () => {
  const first = connectionFromPairingPayload(directPayload);
  const second = connectionFromPairingPayload({
    ...directPayload,
    url: 'http://192.168.1.26:8787',
  });
  const stored = removeStoredConnection(
    { activeConnectionId: second.id, connections: [first, second] },
    second.id,
  );
  assert.equal(stored.activeConnectionId, first.id);
  assert.deepEqual(stored.connections, [first]);
});

test('repairs a stale active environment id while validating storage', () => {
  const first = connectionFromPairingPayload(directPayload);
  const stored = validStoredConnections({ activeConnectionId: 'missing', connections: [first] });
  assert.equal(stored?.activeConnectionId, first.id);
});

test('Relay sign-out removes matching Relay environments but preserves direct ones', () => {
  const direct = connectionFromPairingPayload(directPayload);
  const relay = {
    ...direct,
    id: 'relay-agent',
    transport: 'relay',
    url: 'https://relay.example',
    relayToken: 'owner-token',
    agentId: 'relay-agent',
  };
  const stored = removeStoredConnectionsWhere(
    { activeConnectionId: relay.id, connections: [direct, relay] },
    (connection) => connection.transport === 'relay' && connection.url === relay.url,
  );
  assert.deepEqual(stored.connections, [direct]);
  assert.equal(stored.activeConnectionId, direct.id);
});

test('manual onboarding validates both local and remote computer addresses', () => {
  assert.equal(validateManualConnection('192.168.1.25:8787', 'secret'), null);
  assert.equal(validateManualConnection('https://brio.example.com', 'secret'), null);
  assert.match(validateManualConnection('not a host', 'secret')?.title ?? '', /address/i);
  assert.match(validateManualConnection('', '')?.title ?? '', /information/i);
});

test('onboarding errors give specific, recoverable connection guidance', () => {
  const offlineAgent = explainConnectionError(
    new Error('The Brio connector is online, but Hermes Agent is not reachable'),
  );
  assert.match(offlineAgent.title, /Hermes is offline/);
  assert.ok(offlineAgent.checklist?.some((item) => item.includes('restart Hermes')));

  const unreachable = explainConnectionError(new Error('Network request timed out'));
  assert.match(unreachable.title, /reach your computer/);
  assert.ok(unreachable.checklist?.some((item) => item.includes('Wi-Fi')));
});

test('onboarding translates pairing parser errors without exposing implementation detail', () => {
  assert.match(friendlyPayloadError('Pairing payload is empty'), /full enrollment command/);
  assert.match(friendlyPayloadError('Malformed JSON'), /current enrollment command/);
});

test('connection verification accepts the newer health alias for Hermes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        agent_ok: true,
        agent_kind: 'hermes',
        agent_name: 'Hermes Agent',
        hermes_ok: false,
      }),
      {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
      },
    );
  try {
    const connection = connectionFromPairingPayload(directPayload);
    const connected = await finalizeConnection(connection);
    assert.equal(connected.status, 'online');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('connection verification can be cancelled without waiting for timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new Error('aborted by signal'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  try {
    const controller = new AbortController();
    const health = getHealth(connectionFromPairingPayload(directPayload), controller.signal);
    controller.abort();
    await assert.rejects(health, /Connection cancelled/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parses the official Hermes goal and heartbeat status lines', () => {
  assert.deepEqual(
    parseGoalStatus('⊙ Goal (active, 3/20 turns, 2 subgoals, contract, 1 gate): Ship the app'),
    {
      status: 'active',
      objective: 'Ship the app',
      turnsUsed: 3,
      maxTurns: 20,
      subgoalCount: 2,
      subgoals: [],
      gateCount: 1,
      hasContract: true,
      detail: '⊙ Goal (active, 3/20 turns, 2 subgoals, contract, 1 gate): Ship the app',
    },
  );
  assert.equal(parseGoalStatus('No active goal. Set one with /goal <text>.'), null);
  assert.deepEqual(
    parseGoalStatus('⏸ Goal (paused, 20/20 turns, 1 gate — turn budget exhausted (20/20)): Ship the app'),
    {
      status: 'blocked',
      objective: 'Ship the app',
      turnsUsed: 20,
      maxTurns: 20,
      subgoalCount: 0,
      subgoals: [],
      gateCount: 1,
      hasContract: false,
      pausedReason: 'turn budget exhausted (20/20)',
      detail: '⏸ Goal (paused, 20/20 turns, 1 gate — turn budget exhausted (20/20)): Ship the app',
    },
  );
  assert.equal(
    parseGoalStatus('⏸ Goal (paused, 2/20 turns — user-paused): Ship the app')?.status,
    'paused',
  );
  assert.deepEqual(
    parseGoalStatus('⊙ Goal (active, 1/20 turns): Fix parser): preserve 3 gates and contract text'),
    {
      status: 'active',
      objective: 'Fix parser): preserve 3 gates and contract text',
      turnsUsed: 1,
      maxTurns: 20,
      subgoalCount: 0,
      subgoals: [],
      gateCount: 0,
      hasContract: false,
      detail: '⊙ Goal (active, 1/20 turns): Fix parser): preserve 3 gates and contract text',
    },
  );
  assert.equal(
    parseGoalStatus('⊙ Goal (active, 1/20 turns): Ship the app\nwithout changing auth')?.objective,
    'Ship the app\nwithout changing auth',
  );
  assert.deepEqual(
    parseHeartbeatStatus('♥ Heartbeat (every 10m, next in ~42s, fired 2×): Check CI'),
    {
      status: 'active',
      interval: '10m',
      nextInSeconds: 42,
      fireCount: 2,
      prompt: 'Check CI',
      detail: '♥ Heartbeat (every 10m, next in ~42s, fired 2×): Check CI',
    },
  );
});

test('aggregates agent usage at roots so nested rollups are not double counted', () => {
  assert.deepEqual(
    aggregateRootAgentUsage([
      { subagent_id: 'root', input_tokens: 100, output_tokens: 30, cost_usd: 0.2 },
      { subagent_id: 'child', parent_id: 'root', input_tokens: 40, output_tokens: 10, cost_usd: 0.08 },
      { subagent_id: 'orphan', parent_id: 'missing', input_tokens: 5, output_tokens: 2, cost_usd: 0.01 },
    ]),
    { inputTokens: 100, outputTokens: 30, costUsd: 0.2 },
  );
});

test('filters global Hermes agents to the selected runtime session', () => {
  assert.deepEqual(
    filterAgentsForControlSession(
      [
        { subagent_id: 'owned-a' },
        { subagent_id: 'owned-b', owner_session_id: 'runtime-b' },
        { subagent_id: 'unknown' },
      ],
      [
        {
          sequence: 1,
          type: 'subagent.start',
          session_id: 'runtime-a',
          payload: { subagent_id: 'owned-a' },
        },
      ],
      'runtime-a',
    ),
    [{ subagent_id: 'owned-a', owner_session_id: 'runtime-a' }],
  );
});

test('Relay pairing never creates an implicit shared development identity', async () => {
  const relay = connectionFromPairingPayload({
    url: 'https://relay.example.com',
    token: '',
    code: 'PAIR1234',
    mode: 'relay',
    transport: 'relay',
  });
  await assert.rejects(
    finalizeConnection(relay),
    /Development Relay pairing must be completed from the Relay screen/,
  );
});

test('unknown agent adapters are rejected before saving an incompatible environment', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ ok: true, agent_ok: true, agent_kind: 'openclaw', agent_name: 'OpenClaw' }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 },
    );
  try {
    await assert.rejects(
      finalizeConnection(connectionFromPairingPayload(directPayload)),
      /OpenClaw is not supported by this version of Brio/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
