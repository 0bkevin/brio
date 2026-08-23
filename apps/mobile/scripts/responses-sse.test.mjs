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

test('retains the final response usage, model, and session id unchanged', () => {
  const usage = {
    input_tokens: 12,
    output_tokens: 34,
    total_tokens: 46,
    context_used: 120,
    context_max: 200,
    context_percent: 60,
    model: 'gpt-test',
  };
  const parser = new ResponsesSSEParser();
  parser.push(
    `data: {"type":"response.created","response":{"id":"resp_9","session_id":"sess_1","model":"gpt-test"}}\n\n`,
  );
  parser.push('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n');
  parser.push(
    `data: {"type":"response.completed","response":{"id":"resp_9","status":"completed","session_id":"sess_1","model":"gpt-test","usage":${JSON.stringify(usage)}}}\n\n`,
  );

  assert.deepEqual(parser.finish(), {
    id: 'resp_9',
    status: 'completed',
    output_text: 'Hi',
    session_id: 'sess_1',
    model: 'gpt-test',
    usage,
  });
});
