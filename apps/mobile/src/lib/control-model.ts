export type ControlGoalStatus = {
  status: 'active' | 'paused' | 'blocked' | 'waiting' | 'done';
  objective: string;
  turnsUsed?: number;
  maxTurns?: number;
  subgoalCount: number;
  subgoals: string[];
  gateCount: number;
  hasContract: boolean;
  pausedReason?: string;
  detail: string;
};

export type ControlHeartbeatStatus = {
  status: 'active' | 'paused';
  prompt: string;
  interval: string;
  nextInSeconds?: number;
  fireCount: number;
  detail: string;
};

type ControlAgent = {
  subagent_id: string;
  owner_session_id?: string;
  parent_id?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  [key: string]: unknown;
};

type ControlEvent = {
  session_id?: string;
  payload?: Record<string, unknown>;
};

export function filterAgentsForControlSession<T extends ControlAgent>(
  agents: readonly T[],
  events: readonly ControlEvent[],
  runtimeSessionId: string,
) {
  const observed = new Set(
    events
      .filter((event) => event.session_id === runtimeSessionId)
      .map((event) =>
        typeof event.payload?.subagent_id === 'string' ? event.payload.subagent_id : '',
      )
      .filter(Boolean),
  );
  return agents
    .filter((agent) =>
      agent.owner_session_id
        ? agent.owner_session_id === runtimeSessionId
        : observed.has(agent.subagent_id),
    )
    .map((agent) => ({ ...agent, owner_session_id: runtimeSessionId }));
}

export function parseGoalStatus(value: string): ControlGoalStatus | null {
  const detail = value.replace(/\r/g, '').trim();
  const statusLine = detail.split('\n')[0]?.trim() ?? '';
  if (!statusLine || /^No (?:active )?goal\b/i.test(statusLine)) return null;
  let status: ControlGoalStatus['status'] | null = null;
  if (/^⊙ Goal\b/.test(statusLine)) status = 'active';
  else if (/^⏸ Goal\b/.test(statusLine)) status = 'paused';
  else if (/^⏳ Goal\b/.test(statusLine)) status = 'waiting';
  else if (/^✓ Goal done\b/.test(statusLine)) status = 'done';
  if (!status) return null;

  const marker = statusLine.indexOf('): ');
  const metadataStart = statusLine.indexOf('(');
  const metadata =
    metadataStart >= 0 && marker > metadataStart
      ? statusLine.slice(metadataStart + 1, marker)
      : '';
  const pausedReason = status === 'paused'
    ? metadata.match(/\s—\s(.+)$/)?.[1]?.trim()
    : undefined;
  if (status === 'paused' && pausedReason && pausedReason.toLowerCase() !== 'user-paused') {
    status = 'blocked';
  }
  const objective = marker >= 0
    ? detail.slice(marker + 3).trim()
    : detail.replace(/^\S+\s+Goal(?:\s+\w+)?\s*:?\s*/i, '').trim();
  const turns = metadata.match(/(\d+)\s*\/\s*(\d+)\s+turns?/i);
  const subgoals = metadata.match(/(\d+)\s+subgoals?/i);
  const gates = metadata.match(/(\d+)\s+gates?/i);
  return {
    status,
    objective,
    turnsUsed: turns ? Number(turns[1]) : undefined,
    maxTurns: turns ? Number(turns[2]) : undefined,
    subgoalCount: subgoals ? Number(subgoals[1]) : 0,
    subgoals: [],
    gateCount: gates ? Number(gates[1]) : 0,
    hasContract: /(?:^|[,\s])contract(?:[,\s]|$)/i.test(metadata),
    ...(pausedReason ? { pausedReason } : {}),
    detail,
  };
}

export function parseHeartbeatStatus(value: string): ControlHeartbeatStatus | null {
  const detail = value.replace(/\r/g, '').trim().split('\n')[0]?.trim() ?? '';
  if (!detail || /^No heartbeat\b/i.test(detail)) return null;
  const active = detail.match(/^♥ Heartbeat \(every ([^,\)]+)(?:, next in ~?(\d+)s)?(?:, fired (\d+)[×x])?\): (.+)$/i);
  const paused = detail.match(/^⏸ Heartbeat \(paused, every ([^,\)]+)(?:, fired (\d+)[×x])?\): (.+)$/i);
  if (active) {
    return {
      status: 'active',
      interval: active[1],
      nextInSeconds: active[2] ? Number(active[2]) : undefined,
      fireCount: active[3] ? Number(active[3]) : 0,
      prompt: active[4],
      detail,
    };
  }
  if (paused) {
    return {
      status: 'paused',
      interval: paused[1],
      fireCount: paused[2] ? Number(paused[2]) : 0,
      prompt: paused[3],
      detail,
    };
  }
  return null;
}

export function aggregateRootAgentUsage(agents: readonly ControlAgent[]) {
  const roots = agents.filter((agent) => !agent.parent_id);
  return roots.reduce(
    (total, agent) => ({
      inputTokens: total.inputTokens + (agent.input_tokens ?? 0),
      outputTokens: total.outputTokens + (agent.output_tokens ?? 0),
      costUsd: total.costUsd + (agent.cost_usd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}
