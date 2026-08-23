import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateSessionAnalytics,
  buildRuntimeModelOptions,
  modelIncompatibilities,
  modelPresetKey,
  normalizeContextBreakdown,
  normalizeLiveUsage,
  normalizeModelOptions,
  parseModelPresets,
  selectedCapabilities,
  serializeModelPresets,
} from '../src/lib/session-runtime.ts';

const MODEL_OPTIONS = {
  model: 'claude-sonnet-4',
  provider: 'anthropic',
  providers: [
    {
      slug: 'anthropic',
      name: 'Anthropic',
      models: ['claude-opus-4', 'claude-sonnet-4'],
      auth: { authenticated: true, api_key_set: true },
      pricing: { input: '3', output: '15', cache: null, free: false },
      capabilities: {
        fast: true,
        reasoning: true,
        vision: true,
        tools: true,
        toolcall: true,
      },
    },
    {
      slug: 'ollama',
      name: 'Ollama',
      aliases: ['local', 'localhost'],
      models: ['llama3.2', 'qwen3'],
      auth: { authenticated: false, requires_api_key: false },
      unavailable: false,
      capabilities: {
        'llama3.2': { vision: false, tools: true },
        qwen3: { vision: true, attachment: false, tools: undefined },
      },
    },
    {
      slug: 'moa',
      name: 'MoA',
      models: ['mixture-a', 'mixture-b'],
      capabilities: { vision: true, input: { image: false }, toolcall: false },
    },
  ],
};

test('normalizeModelOptions keeps provider and model order and keeps every valid provider', () => {
  const options = normalizeModelOptions(MODEL_OPTIONS);
  assert.deepEqual(
    options.providers.map((provider) => provider.slug),
    ['anthropic', 'ollama', 'moa'],
  );
  assert.deepEqual(options.providers[0].models, ['claude-opus-4', 'claude-sonnet-4']);
  assert.deepEqual(options.providers[1].models, ['llama3.2', 'qwen3']);
  assert.equal(options.model, 'claude-sonnet-4');
  assert.equal(options.provider, 'anthropic');
  // Unauthenticated/local/MoA providers survive normalization with typed fields.
  assert.deepEqual(options.providers[1].auth, { authenticated: false, requires_api_key: false });
  assert.equal(options.providers[1].unavailable, false);
  assert.equal(options.providers[2].name, 'MoA');
});

test('normalizeModelOptions falls back to empty providers and unknown selection on bad roots', () => {
  for (const raw of [undefined, null, 'nope', 42, [], { providers: 'nope' }]) {
    const options = normalizeModelOptions(raw);
    assert.deepEqual(options, { model: null, provider: null, providers: [] });
  }
  const partial = normalizeModelOptions({
    providers: [
      { name: 'Name Only' },
      { slug: 'no-models' },
      'junk',
      null,
      { slug: '' },
    ],
  });
  assert.deepEqual(
    partial.providers.map((provider) => [provider.slug, provider.name, provider.models]),
    [['Name Only', 'Name Only', undefined], ['no-models', 'no-models', undefined]],
  );
});

test('selectedCapabilities matches provider slugs and aliases', () => {
  const options = normalizeModelOptions(MODEL_OPTIONS);
  assert.equal(selectedCapabilities(options, 'anthropic')?.vision, true);
  assert.equal(selectedCapabilities(options, 'local', 'llama3.2')?.vision, false);
  assert.equal(selectedCapabilities(options, 'localhost', 'qwen3')?.attachment, false);
  assert.equal(selectedCapabilities(options, 'missing'), undefined);
  assert.equal(selectedCapabilities(options, null), undefined);
});

test('modelIncompatibilities blocks only explicit false, unknown allows', () => {
  // Explicit false blocks.
  assert.deepEqual(modelIncompatibilities({ vision: false, tools: true }, { vision: true, tools: true }), ['vision']);
  assert.deepEqual(modelIncompatibilities({ vision: true, tools: false }, { vision: true, tools: true }), ['tools']);
  assert.deepEqual(modelIncompatibilities({ attachment: false }, { vision: true, tools: true }), ['vision']);
  assert.deepEqual(modelIncompatibilities({ input: { image: false } }, { vision: true, tools: true }), ['vision']);
  assert.deepEqual(modelIncompatibilities({ toolcall: false }, { vision: true, tools: true }), ['tools']);
  // Unknown (undefined) allows.
  assert.deepEqual(modelIncompatibilities({ vision: undefined, tools: undefined }, { vision: true, tools: true }), []);
  assert.deepEqual(modelIncompatibilities({}, { vision: true, tools: true }), []);
  assert.deepEqual(modelIncompatibilities(null, { vision: true, tools: true }), []);
  // No requirement means no incompatibility even when explicitly false.
  assert.deepEqual(modelIncompatibilities({ vision: false, tools: false }, { vision: false, tools: false }), []);
  assert.deepEqual(
    modelIncompatibilities({ vision: false, tools: false }, { vision: true, tools: true }),
    ['vision', 'tools'],
  );
});

test('buildRuntimeModelOptions maps effort levels and preserves boolean fast including false', () => {
  assert.equal(buildRuntimeModelOptions({}), undefined);
  assert.equal(buildRuntimeModelOptions({ reasoningEffort: '  ' }), undefined);
  assert.equal(buildRuntimeModelOptions({ reasoningEffort: null, fast: undefined }), undefined);
  assert.deepEqual(buildRuntimeModelOptions({ reasoningEffort: 'none' }), {
    reasoning: { enabled: false },
  });
  assert.deepEqual(buildRuntimeModelOptions({ reasoningEffort: ' None ' }), {
    reasoning: { enabled: false },
  });
  assert.deepEqual(buildRuntimeModelOptions({ reasoningEffort: 'high' }), {
    reasoning: { enabled: true, effort: 'high' },
  });
  assert.deepEqual(buildRuntimeModelOptions({ reasoningEffort: 'medium', fast: false }), {
    reasoning: { enabled: true, effort: 'medium' },
    fast: false,
  });
  assert.deepEqual(buildRuntimeModelOptions({ fast: true }), { fast: true });
  assert.deepEqual(buildRuntimeModelOptions({ fast: false }), { fast: false });
});

test('normalizeLiveUsage accepts API/control key families and rejects malformed metrics', () => {
  assert.deepEqual(normalizeLiveUsage({
    input_tokens: 10,
    output_tokens: '5',
    total_tokens: 15,
    reasoning_tokens: 3,
    cache_read_tokens: 7,
    cache_write_tokens: 0,
    api_calls: 2,
    context_used: 100,
    context_max: 200,
    context_percent: 50,
    estimated_cost_usd: 0.01,
    actual_cost_usd: 0,
    duration_seconds: 1.5,
    model: 'claude-sonnet-4',
  }), {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    reasoningTokens: 3,
    cacheReadTokens: 7,
    cacheWriteTokens: 0,
    apiCalls: 2,
    contextUsed: 100,
    contextMax: 200,
    contextPercent: 50,
    compressions: undefined,
    tokensPerSecond: undefined,
    timeToFirstTokenSeconds: undefined,
    timeToFirstTokenMs: undefined,
    queuedMs: undefined,
    retries: undefined,
    estimatedCostUsd: 0.01,
    actualCostUsd: 0,
    durationSeconds: 1.5,
    model: 'claude-sonnet-4',
  });

  // Control-plane key family.
  assert.deepEqual(
    (({ inputTokens, outputTokens, totalTokens, apiCalls, reasoningTokens }) => ({
      inputTokens, outputTokens, totalTokens, apiCalls, reasoningTokens,
    }))(normalizeLiveUsage({ input: 1, output: 2, total: 3, calls: 4, reasoning: 5 })),
    { inputTokens: 1, outputTokens: 2, totalTokens: 3, apiCalls: 4, reasoningTokens: 5 },
  );
  // prompt/completion family.
  assert.deepEqual(
    (({ inputTokens, outputTokens }) => ({ inputTokens, outputTokens }))(
      normalizeLiveUsage({ prompt: 8, completion: 9 }),
    ),
    { inputTokens: 8, outputTokens: 9 },
  );

  // Malformed values become undefined; unknown context/cost is not coerced to 0.
  const malformed = normalizeLiveUsage({
    input_tokens: Number.NaN,
    output_tokens: -4,
    total_tokens: 'abc',
    context_used: null,
    context_max: Number.POSITIVE_INFINITY,
    actual_cost_usd: 'oops',
    estimated_cost_usd: -1,
    model: '',
  });
  assert.equal(malformed.inputTokens, undefined);
  assert.equal(malformed.outputTokens, undefined);
  assert.equal(malformed.totalTokens, undefined);
  assert.equal(malformed.contextUsed, undefined);
  assert.equal(malformed.contextMax, undefined);
  assert.equal(malformed.actualCostUsd, undefined);
  assert.equal(malformed.estimatedCostUsd, undefined);
  assert.equal(malformed.model, null);
  const emptyUsage = normalizeLiveUsage(null);
  assert.equal(emptyUsage.inputTokens, undefined);
  assert.equal(emptyUsage.model, null);
  assert.equal(normalizeLiveUsage('junk').totalTokens, undefined);
});

test('normalizeContextBreakdown normalizes categories and drops malformed numbers', () => {
  const breakdown = normalizeContextBreakdown({
    categories: [
      { id: 'system', label: 'System', tokens: 120, color: '#ff0000' },
      { id: 'tools', label: '', tokens: '30' },
      { id: 'bad', label: 'Bad', tokens: -5 },
      { tokens: 12 },
      'junk',
    ],
    context_used: 150,
    context_max: 1000,
    context_percent: 15,
    estimated_total: 160,
    model: 'claude-sonnet-4',
  });
  assert.deepEqual(breakdown, {
    categories: [
      { id: 'system', label: 'System', tokens: 120, color: '#ff0000' },
      { id: 'tools', label: 'tools', tokens: 30 },
      { id: 'bad', label: 'Bad' },
    ],
    contextUsed: 150,
    contextMax: 1000,
    contextPercent: 15,
    estimatedTotal: 160,
    model: 'claude-sonnet-4',
  });
  assert.equal(normalizeContextBreakdown(undefined), undefined);
  assert.equal(normalizeContextBreakdown(42), undefined);
  const bare = normalizeContextBreakdown([{ id: 'a', label: 'A', tokens: 1 }]);
  assert.equal(bare?.categories.length, 1);
  assert.equal(bare?.contextUsed, undefined);
});

test('aggregateSessionAnalytics prefers actual cost, filters by period, and clamps durations', () => {
  const sessions = [
    {
      id: 's1',
      source: 'hermes',
      model: 'claude-sonnet-4',
      started_at: 100,
      ended_at: 190,
      message_count: 2,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 20,
      reasoning_tokens: 5,
      api_call_count: 2,
      estimated_cost_usd: 0.5,
      actual_cost_usd: 0,
    },
    {
      id: 's2',
      source: 'hermes',
      model: 'claude-sonnet-4',
      started_at: 200,
      ended_at: 260,
      message_count: 1,
      input_tokens: 30,
      output_tokens: 70,
      estimated_cost_usd: 0.25,
    },
    {
      id: 's3',
      source: 'hermes',
      model: 'gpt-5',
      started_at: 300,
      ended_at: 250,
      message_count: 1,
      input_tokens: 8,
      output_tokens: 9,
    },
    {
      id: 's4',
      source: 'hermes',
      model: 'gpt-5',
      started_at: 400,
      ended_at: 460,
      message_count: 1,
      input_tokens: 1,
      output_tokens: 2,
      actual_cost_usd: 0.75,
    },
    {
      id: 'old',
      source: 'hermes',
      model: 'claude-sonnet-4',
      started_at: 50,
      ended_at: 60,
      message_count: 1,
      input_tokens: 999,
      output_tokens: 999,
    },
  ];

  const analytics = aggregateSessionAnalytics(sessions, { since: 100 });
  assert.equal(analytics.sessions, 4);
  assert.equal(analytics.inputTokens, 139);
  assert.equal(analytics.outputTokens, 131);
  assert.equal(analytics.cacheReadTokens, 10);
  assert.equal(analytics.cacheWriteTokens, 20);
  assert.equal(analytics.reasoningTokens, 5);
  assert.equal(analytics.apiCalls, 2);
  // s3 has ended_at < started_at so contributes 0; s1/s2/s4 contribute 90+60+60.
  assert.ok(Math.abs(analytics.durationSeconds - 210) < 1e-9);
  // Actual cost wins even when zero (s1 -> 0 known); s2 uses estimate; s3 unknown.
  assert.ok(Math.abs(analytics.costUsd - 1) < 1e-9);
  assert.equal(analytics.costKnown, 3);

  assert.deepEqual(Object.keys(analytics.byModel), ['claude-sonnet-4', 'gpt-5']);
  assert.equal(analytics.byModel['claude-sonnet-4'].sessions, 2);
  assert.equal(analytics.byModel['claude-sonnet-4'].costKnown, 2);
  assert.ok(Math.abs(analytics.byModel['claude-sonnet-4'].costUsd - 0.25) < 1e-9);
  assert.equal(analytics.byModel['gpt-5'].sessions, 2);
  assert.equal(analytics.byModel['gpt-5'].costKnown, 1);
  assert.ok(Math.abs(analytics.byModel['gpt-5'].durationSeconds - 60) < 1e-9);

  // Without a period filter everything counts.
  assert.equal(aggregateSessionAnalytics(sessions).sessions, 5);
  assert.equal(aggregateSessionAnalytics([]).sessions, 0);
});

test('model preset keys parse, reject malformed entries, and roundtrip deterministically', () => {
  assert.equal(modelPresetKey('anthropic', 'claude-sonnet-4'), 'anthropic::claude-sonnet-4');

  const parsed = parseModelPresets({
    'anthropic::claude-sonnet-4': { effort: 'high', fast: false },
    'ollama::llama3.2': { fast: true },
    'no-separator': { effort: 'low' },
    '::empty-provider': { effort: 'low' },
    'empty-model::': { effort: 'low' },
    'bad-value::m': 'high',
    'bad-effort::m': { effort: '' },
    'bad-fast::m': { fast: 'yes' },
    'empty-preset::m': {},
    'null-preset::m': null,
  });
  assert.deepEqual(parsed, {
    'anthropic::claude-sonnet-4': { effort: 'high', fast: false },
    'ollama::llama3.2': { fast: true },
  });

  const serialized = serializeModelPresets(parsed);
  assert.deepEqual(JSON.parse(serialized), parsed);
  // Deterministic ordering regardless of insertion order.
  assert.equal(
    serialized,
    serializeModelPresets({
      'ollama::llama3.2': { fast: true },
      'anthropic::claude-sonnet-4': { fast: false, effort: 'high' },
    }),
  );
  assert.equal(serialized, '{"anthropic::claude-sonnet-4":{"effort":"high","fast":false},"ollama::llama3.2":{"fast":true}}');
  assert.equal(serializeModelPresets(parseModelPresets('junk')), '{}');
});
