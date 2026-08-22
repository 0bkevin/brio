import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateRootAgentUsage,
  filterAgentsForControlSession,
  parseGoalStatus,
  parseHeartbeatStatus,
} from '../src/lib/control-model.ts';

test('parses the official Hermes goal and heartbeat status lines', () => {
  assert.deepEqual(
    parseGoalStatus('⊙ Goal (active, 3/20 turns, 2 subgoals, contract, 1 gate): Ship the app'),
    {
      status: 'active', objective: 'Ship the app', turnsUsed: 3, maxTurns: 20,
      subgoalCount: 2, subgoals: [], gateCount: 1, hasContract: true,
      detail: '⊙ Goal (active, 3/20 turns, 2 subgoals, contract, 1 gate): Ship the app',
    },
  );
  assert.equal(parseGoalStatus('No active goal. Set one with /goal <text>.'), null);
  assert.equal(
    parseGoalStatus('⏸ Goal (paused, 20/20 turns, 1 gate — turn budget exhausted (20/20)): Ship the app')?.status,
    'blocked',
  );
  assert.equal(
    parseGoalStatus('⏸ Goal (paused, 2/20 turns — user-paused): Ship the app')?.status,
    'paused',
  );
  assert.equal(
    parseGoalStatus('⊙ Goal (active, 1/20 turns): Ship the app\nwithout changing auth')?.objective,
    'Ship the app\nwithout changing auth',
  );
  assert.deepEqual(
    parseHeartbeatStatus('♥ Heartbeat (every 10m, next in ~42s, fired 2×): Check CI'),
    {
      status: 'active', interval: '10m', nextInSeconds: 42, fireCount: 2,
      prompt: 'Check CI', detail: '♥ Heartbeat (every 10m, next in ~42s, fired 2×): Check CI',
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
      [{
        sequence: 1,
        type: 'subagent.start',
        session_id: 'runtime-a',
        payload: { subagent_id: 'owned-a' },
      }],
      'runtime-a',
    ),
    [{ subagent_id: 'owned-a', owner_session_id: 'runtime-a' }],
  );
});
