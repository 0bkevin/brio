import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  connectionFromPairingPayload,
  decodePairingPayload,
  extractPairingPayload,
  finalizeConnection,
  getHealth,
  normalizeConnectionURL,
} from './brio.ts';
import {
  removeStoredConnection,
  removeStoredConnectionsWhere,
  upsertStoredConnection,
  validStoredConnections,
} from '../state/connection-store-model.ts';
import {
  explainConnectionError,
  friendlyPayloadError,
  validateManualConnection,
} from '../features/connection/connection-experience.ts';

const directPayload = {
  url: 'http://192.168.1.25:8787',
  token: 'mobile-secret',
  mode: 'direct',
  transport: 'direct',
};

test('decodes the base64url payload emitted by Brio Companion', () => {
  const encoded = Buffer.from(JSON.stringify(directPayload)).toString('base64url');
  assert.deepEqual(decodePairingPayload(encoded), directPayload);
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
    /invalid Companion address/,
  );
});

test('normalizes local IPv4, IPv6, and mDNS hosts to HTTP', () => {
  assert.equal(normalizeConnectionURL('192.168.1.25:8787'), 'http://192.168.1.25:8787');
  assert.equal(normalizeConnectionURL('[::1]:8787'), 'http://[::1]:8787');
  assert.equal(normalizeConnectionURL('hermes.local:8787'), 'http://hermes.local:8787');
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
    new Error('Brio Companion is online, but Hermes Agent is not reachable'),
  );
  assert.match(offlineAgent.title, /Hermes is offline/);
  assert.ok(offlineAgent.checklist?.some((item) => item.includes('restart Hermes')));

  const unreachable = explainConnectionError(new Error('Network request timed out'));
  assert.match(unreachable.title, /reach your computer/);
  assert.ok(unreachable.checklist?.some((item) => item.includes('Wi-Fi')));
});

test('onboarding translates pairing parser errors without exposing implementation detail', () => {
  assert.match(friendlyPayloadError('Pairing payload is empty'), /full code/);
  assert.match(friendlyPayloadError('Malformed JSON'), /QR code or full connection code/);
});

test('connection verification accepts provider-neutral agent health', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, agent_ok: true, hermes_ok: false }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
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
