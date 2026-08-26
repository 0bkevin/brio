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
  };
  const acquired = acquireHermesGateway(connection, 'coder');
  try {
    const events = [];
    acquired.client.onEvent((event) => events.push(event));
    await acquired.client.connect();
    const socket = FakeWebSocket.instances[0];
    assert.equal(socket.url, 'wss://hermes.example/base/p/coder/api/ws?token=session-secret');

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
