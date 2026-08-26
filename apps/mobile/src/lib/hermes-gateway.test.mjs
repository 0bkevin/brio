import assert from 'node:assert/strict';
import test from 'node:test';

import { acquireHermesGateway } from './hermes-gateway.ts';

class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  readyState = 0;
  sent = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    });
  }

  send(data) {
    this.sent.push(data);
    const frame = JSON.parse(data);
    if (frame.method === 'session.create') {
      queueMicrotask(() => this.receive({
        jsonrpc: '2.0',
        id: frame.id,
        result: { session_id: 'runtime-1', stored_session_id: 'stored-1' },
      }));
    } else if (frame.method === 'legacy.unsupported') {
      queueMicrotask(() => this.receive({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: -32601, message: 'method not found' },
      }));
    }
  }

  receive(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

test('direct Hermes gateway uses /api/ws, dispatches ordered events, and speaks JSON-RPC', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  const connection = {
    id: 'direct-1',
    name: 'Hermes',
    mode: 'self_hosted',
    transport: 'direct',
    status: 'online',
    capabilities: {},
    url: 'https://hermes.example/base/',
    token: 'session-secret',
    gatewayUrl: 'https://hermes.example:9119/base/',
    gatewayToken: 'dashboard-secret',
  };
  const acquired = acquireHermesGateway(connection, 'coder');
  try {
    const events = [];
    acquired.client.onEvent((event) => events.push(event));
    await acquired.client.connect();
    const socket = FakeWebSocket.instances[0];
    assert.equal(socket.url, 'wss://hermes.example:9119/base/p/coder/api/ws?token=dashboard-secret');

    const created = await acquired.client.request('session.create', { source: 'brio' });
    assert.deepEqual(created, { session_id: 'runtime-1', stored_session_id: 'stored-1' });
    assert.equal(JSON.parse(socket.sent[0]).method, 'session.create');

    const event = {
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'message.delta', session_id: 'runtime-1', seq: 4, payload: { text: 'hi' } },
    };
    socket.receive(event);
    socket.receive(event);
    socket.receive({
      ...event,
      params: { ...event.params, seq: 5, payload: { text: '!' } },
    });
    assert.deepEqual(events.map((item) => item.payload?.text), ['hi', '!']);

    await assert.rejects(
      acquired.client.request('legacy.unsupported'),
      /method not found/,
      'an older gateway must surface unsupported RPCs so the caller can degrade explicitly',
    );
    await assert.rejects(
      acquired.client.request('never.responds', {}, 5),
      /timed out/,
      'a stalled gateway request must reset instead of hanging the conversation',
    );
  } finally {
    acquired.release();
    globalThis.WebSocket = originalWebSocket;
  }
});

test('direct mode degrades instead of sending API_SERVER_KEY to hermes serve', async () => {
  const acquired = acquireHermesGateway({
    id: 'direct-without-gateway',
    name: 'Hermes',
    mode: 'self_hosted',
    transport: 'direct',
    status: 'online',
    capabilities: {},
    url: 'http://hermes.example:8642',
    token: 'api-server-key',
  }, 'default');
  try {
    await assert.rejects(acquired.client.connect(), /separate addresses and credentials/);
    assert.equal(acquired.client.connectionState, 'degraded');
  } finally {
    acquired.release();
  }
});

test('a late close from an old direct socket cannot close its replacement', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  const connection = {
    id: 'direct-generation-guard',
    name: 'Hermes',
    mode: 'self_hosted',
    transport: 'direct',
    status: 'online',
    capabilities: {},
    url: 'http://hermes.example:8642',
    token: 'api-server-key',
    gatewayUrl: 'http://hermes.example:9119',
    gatewayToken: 'dashboard-token',
  };
  const acquired = acquireHermesGateway(connection, 'default');
  try {
    await acquired.client.connect();
    const first = FakeWebSocket.instances[0];
    first.onclose?.({});
    await acquired.client.connect();
    const second = FakeWebSocket.instances[1];
    first.onclose?.({});
    assert.equal(acquired.client.connectionState, 'open');
    const created = await acquired.client.request('session.create', { source: 'brio' });
    assert.equal(created.session_id, 'runtime-1');
    assert.ok(second.sent.length > 0);
  } finally {
    acquired.release();
    globalThis.WebSocket = originalWebSocket;
  }
});
