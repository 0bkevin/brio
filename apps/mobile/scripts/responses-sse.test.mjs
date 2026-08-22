import assert from 'node:assert/strict';
import test from 'node:test';

import { ResponsesSSEParser } from '../src/lib/responses-sse.ts';

test('parses split CRLF response events and emits text deltas', () => {
  const deltas = [];
  const parser = new ResponsesSSEParser((delta) => deltas.push(delta));
  parser.push('event: response.created\r\ndata: {"type":"response.created","response":{"id":"resp_1"}}\r');
  parser.push('\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Hel"}\r\n\r\n');
  parser.push('data: {"type":"response.output_text.delta","delta":"lo"}\n\n');
  parser.push('data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n');

  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.deepEqual(parser.finish(), {
    id: 'resp_1',
    status: 'completed',
    output_text: 'Hello',
  });
});

test('surfaces failed response messages', () => {
  const parser = new ResponsesSSEParser();
  assert.throws(
    () => parser.push('data: {"type":"response.failed","response":{"error":{"message":"provider failed"}}}\n\n'),
    /provider failed/,
  );
});
