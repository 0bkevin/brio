# Brio

Brio is a mobile control plane for Hermes Agent.

The preferred UX is:

1. Open the mobile app.
2. Sign in to the Brio relay.
3. Generate a setup command.
4. Run that command on the Hermes machine.
5. It installs the slim `brio` connector, enables the Hermes API server,
   enrolls the machine with the relay, and installs/starts the connector
   service — the agent appears in the app.

Hermes Agent stays completely stock: the connector is a small Go binary in
this repo that keeps an outbound WebSocket tunnel to the relay and forwards
a fixed set of request paths to Hermes' local API server
(`http://127.0.0.1:8642`). There is no local HTTP server in the connector.

## What Is Here

- `apps/mobile` - Expo React Native app.
- `apps/relay` - Go relay/control-plane service for remote connections.
- `apps/connect` - the `brio` connector binary (Go).
- `packages/protocol` - Shared JSON protocol schemas.

## Prerequisites

- Go `1.26.1` (relay and connector).
- Node.js and npm (mobile app).
- Hermes Agent on the target machine (stock; no fork needed).
- `hermes serve` on loopback for optional Command Center controls.

Postgres is optional. The relay uses in-memory development storage when
`BRIO_DATABASE_URL` is unset.

## Quick Start

```bash
make setup
make check
```

Start the relay and mobile app:

```bash
make dev-relay
make dev-mobile
```

In the app, sign in to the relay and generate a setup command. Run that command
on the Hermes machine.

## Enrollment Flow

On the Hermes machine:

```bash
curl -fsSL https://github.com/0bkevin/brio/releases/latest/download/install.sh \
  | BRIO_RELAY_URL="http://127.0.0.1:8082" \
    BRIO_ENROLL_CODE="ABCD1234" \
    BRIO_AGENT_NAME="Hermes" \
    sh
```

The installer downloads the release binary (with checksum verification) and
runs `brio setup`. Setup merges `API_SERVER_ENABLED=true`,
`API_SERVER_HOST/PORT`, and `API_SERVER_KEY` into `~/.hermes/.env`
(preserving unrelated keys and any existing API key), claims the enrollment
code, writes its state to `~/.brio/connect.env`, and installs/starts the
background service. Restart Hermes if it was already running so the API
server picks up the new settings.

For goals, heartbeats, background tasks, and agent controls, start the Hermes
control plane with a shared local token. The connector also accepts the token
from `HERMES_DASHBOARD_SESSION_TOKEN` in `~/.hermes/.env`:

```bash
HERMES_DASHBOARD_SESSION_TOKEN=replace-with-a-random-local-token \
  hermes serve --host 127.0.0.1 --port 9119
```

The control server stays loopback-only. The connector keeps one persistent
JSON-RPC/WebSocket connection so background completion events, agent ownership,
and scheduled heartbeats survive mobile app reconnects.

On the Hermes machine you can also manage the connector directly:

```bash
brio setup --relay-url <relay-url> --code <code>   # enroll/re-enroll
brio connect                                       # run the tunnel in the foreground
brio status                                        # service + relay + tunnel credentials
brio recover --relay-url <url> --agent-id <id> \
  --device-token <owner-device-token> --restart    # recover credentials
brio install / uninstall / start / stop / restart  # service lifecycle
```

The service is a user-level LaunchAgent (`app.brio.connect`) on macOS, a user
systemd unit (`Restart=always`) on Linux, and a schtasks ONLOGON task on
Windows; it runs `brio connect` with the home directory as working
directory.

## What the Connector Serves

Everything rides the relay tunnel. Per request frame:

- Forwarded to the stock Hermes API server with
  `Authorization: Bearer API_SERVER_KEY` (replacing any frame credentials):
  `/v1/responses`, `/v1/runs...`, `/api/jobs...`, `/v1/capabilities`,
  `/api/sessions`, `/api/sessions/{id}/messages`, `/health`, plus the legacy
  aliases `/chat/responses` and `/capabilities`. Hermes remains responsible
  for session filtering, pagination, profiles, and compression lineage.
  SSE responses stream as complete UTF-8-safe `stream_chunk` frames and
  finish with an empty `stream_end` marker; the mobile client parses the SSE
  stream into the terminal Responses API object.
- Served locally by brio from `~/.hermes`:
  `/v1/memory` GET/PUT (legacy `/memory`) with atomic 0600 writes to
  `memories/MEMORY.md` and `USER.md`. `HERMES_HOME` is respected. The same
  routes under `/p/<profile>/...`, plus the full `/api/profiles*` management
  surface, operate on that profile's home instead.
- Served by brio through the official `hermes serve` control connection:
  `/control/rpc`, `/control/command`, `/control/background`, and
  `/control/events`. These require `HERMES_CONTROL_TOKEN` (or
  `HERMES_DASHBOARD_SESSION_TOKEN`) and default to
  `HERMES_CONTROL_BASE=http://127.0.0.1:9119`. Under `/p/<profile>/...` they
  require a per-profile control override (see Hermes Profiles).
- Everything else returns a 404-style error frame. The old file/config/
  gateway/skills/tools/logs endpoints are intentionally gone.

## Hermes Profiles

One Brio environment (a connected machine) can host many Hermes profiles —
isolated agents with their own config, keys, memory, sessions, and gateway.
Identity is always the triple `environmentId + profileName (+ sessionId)`;
threads, composer drafts, relay caches, and deep links are keyed per profile
so nothing is ever reused between two agents on the same machine.

Brio operates on the REAL Hermes profile layout (hermes_cli/profiles.py):
the sticky selection lives in `<home>/active_profile`, per-profile metadata
in `<profile>/profile.yaml`, gateway runtime state in
`<profile>/gateway_state.json`, and name validation/reserved aliases match
Hermes exactly. Reads are served from the filesystem; every mutation is
delegated to the installed stock `hermes` CLI with `HERMES_HOME` scoped to
the connector home, behind an injectable runner — so bundled-skill seeding,
standard directories, wrapper command aliases, managed gateway services,
Honcho host migration, s6 registration, and future Hermes invariants stay
authoritative rather than re-implemented in parallel.

The Manage tab exposes:

- list/show, create (blank / `--clone` / `--clone-all` / `--clone-from`),
  use (sticky default), describe, rename, delete — mirroring `hermes
  profile` semantics including typed-name confirmation at Brio's boundary;
  rename/delete update or remove command aliases and managed services
  because the CLI performs them natively. Failed creates validate before
  anything is invoked, leaving no orphan directory.
- SOUL.md/description editing plus a per-profile setup command.
- Gateway Start/Stop/Restart per profile through real
  `hermes [-p <name>] gateway <action>` semantics; multiplex conflicts
  surface verbatim as Hermes errors (the multiplexer is owned by the
  default gateway).
- Export/import of real Hermes archives via the CLI (`profile export` /
  `profile import`), which are credential-free by design; previews list
  files and env var NAMES only. Importing is two-phase: the preview issues a
  `preview_token` bound to the exact sanitized payload + target, and apply
  must echo it; archives that carry `.env`/`.env.*`/`auth.json` additionally
  require an explicit `allow_secrets` consent checkbox (values never leave
  the machine). Replacement imports are not offered — existing targets are
  rejected, matching stock Hermes.
- Profile distributions from git URLs (`file://`, github shorthand,
  https/ssh, `#ref` pins for branches/tags/commits) or local checkouts: a
  safe staged preview parses `distribution.yaml` (name, version,
  hermes_requires, env_requires, distribution_owned), rejects symlinks,
  honors Hermes' hard USER_OWNED_EXCLUDE set (memories, sessions,
  .env/auth.json, state databases, caches, ...) and bounded file/size
  budgets, issues its own `preview_token` digest over the staged tree, and
  apply verifies that digest before running `hermes profile install`
  against the same validated tree. The original URL/path (including #ref)
  is preserved as the installed manifest's source so future updates re-pull
  correctly.

Profile-scoped requests use the `/p/<profile>/...` prefix: chat, sessions,
runs, and jobs authenticate with that profile's own `API_SERVER_KEY`
(fail-closed when missing), unknown profiles get 404s before any upstream
call, and memory endpoints read/write that profile's home. Cross-profile
session importing pins the conversation to its source profile. Deep links
(`brio://chat?agent=&profile=&session=`) resolve to exactly one environment,
switch its profile, and open the named session; links for other
environments are dropped.

Per-profile Command Center support requires a dedicated `hermes serve` for
that profile; configure it in `~/.brio/connect.env` as
`HERMES_CONTROL_BASE_<ENCODED>`. Simple `[a-z0-9]+` names keep the legacy
raw uppercase key (`CODER`); separator names use a versioned form —
`research-bot` → `V1_72657365617263682d626f74` (V1_ plus hex) — and
ambiguous legacy raw keys like `RESEARCH_BOT` or `RESEARCH_HBOT` are
rejected rather than misrouted. Without an override, profile-scoped control
requests fail closed instead of mixing another profile's control state.

Operational notes: archive transfers cap the raw export at 6 MiB so the
base64-encoded frame (~8 MiB) always fits inside the connector's 10 MiB
response frame limit; larger machines should copy `hermes profile export`
output directly. The hermes CLI and git must be installed on the agent
machine for mutations and git-URL distributions.

## Direct Connections

The app can also reach a Hermes API server directly on a LAN or private
network (for example over Tailscale): point it at the machine's
`http://<host>:8642` with the `API_SERVER_KEY` from `~/.hermes/.env`.
Chat and native session history work in direct mode. Memory-file editing is a
connector-only feature and is hidden for direct connections. Internet-facing
endpoints must terminate HTTPS before the API server.

## Configuration

The root `Makefile` reads `.env` automatically if it exists. Start from:

```bash
cp .env.example .env
```

Common values:

- `BRIO_RELAY_ADDR` - relay bind address, default `127.0.0.1:8082`.
- `BRIO_DATABASE_URL` - optional Postgres URL for relay persistence.
- `BRIO_RELAY_ALLOWED_ORIGINS` - optional comma-separated browser origins allowed for relay CORS and WebSocket upgrades. If unset, development mode allows all origins.
- `BRIO_DEVICE_REGISTRATION_KEY` - optional secret required on `POST /auth/devices` through `Authorization: Bearer ...` or `X-Brio-Registration-Key`. Use this only as a deployment guard until the hosted account-auth flow replaces development device registration.
- `HERMES_CONTROL_BASE` - `hermes serve` base URL, default `http://127.0.0.1:9119`.
- `HERMES_CONTROL_TOKEN` - session token shared with `hermes serve` through `HERMES_DASHBOARD_SESSION_TOKEN`.

## Validation

`make check` runs:

- `go test ./apps/connect/... ./apps/relay/...`
- `sh -n scripts/install.sh && sh scripts/install_test.sh`
- `npm run lint`
- `npm run typecheck`
- `npm run export:web`

The web export is written to `/tmp/brio-web-export` by default.

## Releases

Pushing a `v*` tag triggers `.github/workflows/release.yml`: it validates the
repo (`make check`), cross-compiles the connector for
linux/darwin/windows on amd64/arm64 (`CGO_ENABLED=0`), and publishes a
GitHub release with the binaries, `scripts/install.sh`, and a
`checksums.txt` manifest. The installer downloads the release binary and
verifies its checksum.

## Relay Endpoints

- `POST /auth/devices` - create a device auth token for a user.
- `GET /me` - inspect the authenticated device/user.
- `GET /devices` - list devices for the authenticated user.
- `DELETE /devices/{id}` - revoke a device token.
- `GET /agents` - list agents owned by the authenticated user.
- `POST /enrollments` - create a short-lived enrollment code for a user.
- `POST /enrollments/{code}/claim` - claim an enrollment code from a Hermes machine.
- `POST /agents/{id}/recover` - owner-authenticated recovery path that returns a fresh relay pairing code and connector token.
- `POST /pairings` - create a short-lived pairing record.
- `GET /pairings/{code}` - inspect a pairing record.
- `POST /pairings/{code}/claim` - claim a pairing once with a device token.
- `GET /tunnel/companion/{agentID}?token=...` - authenticated connector WebSocket tunnel.
- `GET /tunnel/mobile/{agentID}?token=...` - authenticated mobile WebSocket tunnel.

The relay routes request frames to one connected connector and records the
requesting mobile peer by frame ID. Response, error, and stream frames
from the connector are delivered only to that requesting peer. Pending relay
requests expire after six minutes if the connector does not finish.

Chat requests use Hermes' Responses API SSE stream. The connector preserves
the SSE bytes in `stream_chunk` frames and finishes with `stream_end`. The
mobile app renders `response.output_text.delta` events incrementally and
falls back to ordinary JSON responses for older Hermes installations.

If a Hermes machine loses its `~/.brio` state, recover the agent through the
relay and restart the connector with the returned token (see `brio recover`
above). The mobile app includes the same recovery flow.

## Deployment

The relay ships as a Docker image (`apps/relay/Dockerfile`) and is currently
deployed on AWS Lightsail; an AWS Copilot manifest lives under `copilot/`. Set
`BRIO_DATABASE_URL` (Postgres) and `BRIO_DEVICE_REGISTRATION_KEY` as secrets
in any deployed environment.
