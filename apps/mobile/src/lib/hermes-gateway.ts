import { openRelayGatewayChannel, type AgentConnection } from './brio.ts';
import { scopedPath } from './profiles-model.ts';

export type HermesGatewayState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'synchronizing'
  | 'degraded'
  | 'closed';

export type HermesGatewayEvent = {
  type: string;
  session_id?: string;
  seq?: number;
  payload?: Record<string, unknown>;
};

type JsonRPCFrame = {
  id?: string | number | null;
  method?: string;
  params?: HermesGatewayEvent;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type GatewayTransport = {
  send(data: string): void | Promise<void>;
  close(): void;
};

const REQUEST_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;
const REPLAY_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_DEADLINE_MS = 45_000;

export class HermesGatewayClient {
  private readonly connection: AgentConnection;
  private readonly profile: string;
  private state: HermesGatewayState = 'closed';
  private transport: GatewayTransport | null = null;
  private opening: Promise<void> | null = null;
  private nextID = 0;
  private pending = new Map<string | number, PendingCall>();
  private eventHandlers = new Set<(event: HermesGatewayEvent) => void>();
  private stateHandlers = new Set<(state: HermesGatewayState) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private lastSeenSequence = new Map<string, number>();
  private replayEpoch: string | null = null;
  private replaying = false;
  private replayHold: HermesGatewayEvent[] = [];
  private stopped = false;

  constructor(connection: AgentConnection, profile: string) {
    this.connection = connection;
    this.profile = profile;
  }

  get connectionState() {
    return this.state;
  }

  onEvent(handler: (event: HermesGatewayEvent) => void) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onState(handler: (state: HermesGatewayState) => void) {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }

  connect(): Promise<void> {
    if (this.transport && (this.state === 'open' || this.state === 'synchronizing')) {
      return Promise.resolve();
    }
    if (this.opening) return this.opening;
    if (this.transport && this.connection.transport === 'relay' && this.state === 'reconnecting') {
      return this.waitForRelayReconnect();
    }
    this.stopped = false;
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    this.opening = (this.connection.transport === 'relay' ? this.openRelay() : this.openDirect())
      .then(() => this.onTransportOpen())
      .catch((reason) => {
        this.setState('degraded');
        throw reason;
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private waitForRelayReconnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let removeListener: () => void = () => {};
      const timeout = setTimeout(() => {
        removeListener();
        reject(new Error('Hermes gateway reconnection timed out'));
      }, 15_000);
      removeListener = this.onState((state) => {
        if (state === 'open') {
          clearTimeout(timeout);
          removeListener();
          resolve();
        } else if (state === 'degraded' || state === 'closed') {
          clearTimeout(timeout);
          removeListener();
          reject(new Error('Hermes gateway could not reconnect'));
        }
      });
    });
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const effectiveTimeout = timeoutMs ?? (method === 'prompt.submit' ? PROMPT_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    if (!this.transport || (this.state !== 'open' && this.state !== 'synchronizing')) {
      return Promise.reject(new Error('Hermes gateway is not connected'));
    }
    return this.sendRequest<T>(method, params, effectiveTimeout);
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const transport = this.transport;
    this.transport = null;
    transport?.close();
    this.rejectPending(new Error('Hermes gateway connection closed'));
    this.setState('closed');
  }

  private openRelay(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Hermes gateway channel timed out'));
      }, 15_000);
      void openRelayGatewayChannel(
        this.connection,
        scopedPath('/api/ws', this.profile),
        {
          onOpen: () => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve();
            } else {
              void this.onTransportOpen();
            }
          },
          onMessage: (data) => this.handleRawMessage(data),
          onClose: (error, retrying) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(error ?? new Error('Hermes gateway channel closed'));
            }
            this.handleTransportClose(error, Boolean(retrying));
          },
        },
      ).then((channel) => {
        this.transport = channel;
      }, (reason) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(reason);
        }
      });
    });
  }

  private openDirect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(directGatewayURL(this.connection, this.profile));
      this.transport = {
        send: (data) => socket.send(data),
        close: () => socket.close(),
      };
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Hermes gateway connection timed out'));
      }, 15_000);
      socket.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.onmessage = (event) => this.handleRawMessage(String(event.data));
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Hermes gateway connection failed'));
      };
      socket.onclose = () => {
        clearTimeout(timeout);
        this.handleTransportClose(new Error('Hermes gateway connection closed'), false);
      };
    });
  }

  private async onTransportOpen() {
    if (this.stopped || !this.transport) return;
    this.reconnectAttempts = 0;
    this.lastInboundAt = Date.now();
    if (this.lastSeenSequence.size === 0) {
      this.setState('open');
      return;
    }
    this.setState('synchronizing');
    this.replaying = true;
    try {
      for (const [sessionID, lastSeen] of this.lastSeenSequence) {
        const replay = await this.sendRequest<{
          epoch?: string;
          events?: HermesGatewayEvent[];
        }>('session.events.since', { session_id: sessionID, last_seen: lastSeen }, REPLAY_TIMEOUT_MS);
        if (replay.epoch && this.replayEpoch && replay.epoch !== this.replayEpoch) {
          this.lastSeenSequence.clear();
        }
        if (replay.epoch) this.replayEpoch = replay.epoch;
        for (const event of replay.events ?? []) this.dispatchIfNewer(event);
      }
    } catch {
      // Replay is best-effort. session.resume below remains the authoritative
      // state sync when the conversation next becomes active.
    } finally {
      this.replaying = false;
      const held = this.replayHold;
      this.replayHold = [];
      for (const event of held) this.dispatchIfNewer(event);
      if (!this.stopped && this.transport) this.setState('open');
    }
  }

  private sendRequest<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error('Hermes gateway is not connected'));
    const id = `brio-${++this.nextID}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes gateway request timed out: ${method}`));
        this.invalidateTransport();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      Promise.resolve(transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))).catch((reason) => {
        const call = this.pending.get(id);
        if (!call) return;
        clearTimeout(call.timer);
        this.pending.delete(id);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      });
    });
  }

  private handleRawMessage(raw: string) {
    this.lastInboundAt = Date.now();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let frame: JsonRPCFrame;
      try {
        frame = JSON.parse(line) as JsonRPCFrame;
      } catch {
        continue;
      }
      if (frame.id !== undefined && frame.id !== null) {
        const call = this.pending.get(frame.id);
        if (!call) continue;
        clearTimeout(call.timer);
        this.pending.delete(frame.id);
        if (frame.error) {
          call.reject(new Error(frame.error.message ?? 'Hermes gateway request failed'));
        } else {
          call.resolve(frame.result);
        }
        continue;
      }
      if (frame.method !== 'event' || !frame.params?.type) continue;
      const event = frame.params;
      if (event.type === 'gateway.ready') {
        const epoch = event.payload?.replay_epoch;
        if (typeof epoch === 'string' && epoch) {
          if (this.replayEpoch && this.replayEpoch !== epoch) this.lastSeenSequence.clear();
          this.replayEpoch = epoch;
        }
        if (event.payload?.heartbeat === true) this.startHeartbeat();
      }
      if (this.replaying && event.session_id && typeof event.seq === 'number') {
        this.replayHold.push(event);
      } else {
        this.dispatchIfNewer(event);
      }
    }
  }

  private dispatchIfNewer(event: HermesGatewayEvent) {
    if (event.session_id && typeof event.seq === 'number') {
      const previous = this.lastSeenSequence.get(event.session_id) ?? 0;
      if (event.seq <= previous) return;
      this.lastSeenSequence.set(event.session_id, event.seq);
    }
    for (const handler of this.eventHandlers) handler(event);
  }

  private handleTransportClose(error: Error | undefined, retrying: boolean) {
    if (this.stopped) return;
    this.stopHeartbeat();
    this.rejectPending(error ?? new Error('Hermes gateway connection closed'));
    this.setState('reconnecting');
    if (retrying) return;
    this.transport = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(16_000, 750 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private invalidateTransport() {
    const transport = this.transport;
    this.transport = null;
    transport?.close();
    this.handleTransportClose(new Error('Hermes gateway transport was reset'), false);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.transport) return;
      if (Date.now() - this.lastInboundAt >= HEARTBEAT_DEADLINE_MS) {
        this.invalidateTransport();
        return;
      }
      const id = `heartbeat-${++this.nextID}`;
      void Promise.resolve(this.transport.send(JSON.stringify({
        jsonrpc: '2.0', id, method: 'gateway.ping', params: {},
      }))).catch(() => this.invalidateTransport());
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private rejectPending(error: Error) {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
  }

  private setState(state: HermesGatewayState) {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  }
}

type CachedGateway = {
  client: HermesGatewayClient;
  references: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
};
const gatewayClients = new Map<string, CachedGateway>();

export function acquireHermesGateway(connection: AgentConnection, profile: string) {
  const credential = connection.transport === 'relay' ? connection.relayToken : connection.token;
  const key = `${connection.id}\u0000${connection.url}\u0000${profile}\u0000${credential ?? ''}`;
  let cached = gatewayClients.get(key);
  if (!cached) {
    cached = {
      client: new HermesGatewayClient(connection, profile),
      references: 0,
      closeTimer: null,
    };
    gatewayClients.set(key, cached);
  }
  if (cached.closeTimer) clearTimeout(cached.closeTimer);
  cached.closeTimer = null;
  cached.references += 1;
  let released = false;
  return {
    client: cached.client,
    release: () => {
      if (released) return;
      released = true;
      const current = gatewayClients.get(key);
      if (!current) return;
      current.references -= 1;
      if (current.references > 0) return;
      // Route replacement unmounts the draft screen before mounting the
      // durable session route. A short grace keeps the same gateway socket
      // alive across that handoff so an accepted turn never loses its stream.
      current.closeTimer = setTimeout(() => {
        const latest = gatewayClients.get(key);
        if (latest !== current || latest.references > 0) return;
        latest.client.close();
        gatewayClients.delete(key);
      }, 250);
    },
  };
}

function directGatewayURL(connection: AgentConnection, profile: string) {
  const url = new URL(connection.url);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Hermes gateway URL must use HTTP(S) or WebSocket transport');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${scopedPath('/api/ws', profile)}`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('token', connection.token);
  return url.toString();
}
