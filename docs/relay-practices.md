# Relay practices adopted from T3 Connect

This note records the relay invariants Brio intentionally shares with T3
Connect and the places where the architectures differ. The comparison was
made against [`pingdotgg/t3code` at `a9cd94eb`](https://github.com/pingdotgg/t3code/tree/a9cd94eb935fed8e73b0d88e599c27048f2939c3)
on 2026-08-23.

## Invariants in Brio

- Credentials are never stored in plaintext. Device and connector tokens are
  hashed, pairing and enrollment codes are single-use and expiring, token
  rotation disconnects existing sockets, and unlinking an agent deletes its
  credentials and live relay sessions.
- A logical tunnel has one owner. An agent has one active connector socket and
  each device has one active Mobile socket per agent; a reconnect atomically
  replaces the stale lease.
- The hot path is bounded. Frame sizes, send queues, concurrent connector work,
  pending work per agent/device, write time, and request lifetime all have hard
  limits. The relay expires pending work before Mobile's own deadline so the
  client receives a terminal error instead of timing out first.
- Dead sockets are actively reclaimed with WebSocket pings. Connector retries
  use jittered exponential backoff and reset only after a stable connection.
- Sensitive JSON responses use `Cache-Control: no-store`; request IDs are
  returned in `X-Request-ID`; logs omit credentials and redact pairing and
  enrollment codes from paths.
- Browser origins, proxy forwarding, production transport, request bodies, and
  authentication modes fail closed. Plain HTTP and unverified identity are
  explicit loopback-development choices.
- Postgres schema changes are ordered, recorded in
  `brio_schema_migrations`, and serialized with a transaction-scoped advisory
  lock so concurrent deployments cannot race migrations.
- Installed connectors are supervised without crash storms. systemd bounds
  repeated starts and isolates child-process OOM failures; launchd has an
  explicit restart cadence and graceful-exit window.

## Intentional architectural difference

T3 Connect uses its relay as a control plane. It links accounts, provisions a
managed endpoint, and mints short-lived connection credentials; ordinary RPC
traffic then goes directly between the client and environment. Brio currently
routes ordinary Hermes traffic through the relay WebSocket hub. Cloudflare
tunnel allocation, signed endpoint health proofs, and environment credential
minting therefore cannot be copied as isolated helpers—they require moving
Brio's data path out of the relay.

The in-memory hub and rate limits are also process-local. A production Brio
relay must run as a single replica unless WebSocket routing and limits are
moved to shared infrastructure or clients receive direct managed endpoints.
Sticky load balancing alone does not let Mobile and connector sockets on
different replicas find each other.

## Best next ports

1. Move normal traffic to per-agent managed endpoints, leaving this service as
   discovery/control plane. This is the prerequisite for safe horizontal
   scaling and removes the relay's bandwidth bottleneck.
2. Replace long-lived bearer use at the client boundary with short-lived,
   scoped, proof-of-possession credentials. T3 Connect uses DPoP, nonce replay
   storage, and capability-specific scopes.
3. Add OpenTelemetry spans across Mobile, relay, and connector, with response
   trace correlation and strict header/credential redaction.
4. Add persistent per-account agent/tunnel quotas. Current connection and work
   limits protect one process, but do not enforce an account-level allocation
   policy.

Until the first item is implemented, deploy one relay replica with Postgres and
monitor its connection, pending-request, memory, and egress ceilings.
