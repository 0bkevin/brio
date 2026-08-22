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
  `/health`, plus the legacy aliases `/chat/responses` and `/capabilities`.
  SSE responses stream as `stream_chunk` frames and finish with a
  `stream_end` whose body carries the last valid SSE data JSON.
- Served locally by brio from `~/.hermes` (same JSON shapes as before):
  `/v1/sessions?limit=` (legacy `/sessions`),
  `/v1/sessions/{id}/messages` (legacy `/sessions/{id}/messages`), and
  `/v1/memory` GET/PUT (legacy `/memory`) with atomic 0600 writes to
  `memories/MEMORY.md` and `USER.md`. `HERMES_HOME` is respected.
- Everything else returns a 404-style error frame. The old file/config/
  gateway/skills/tools/logs endpoints are intentionally gone.

## Direct Connections

The app can also reach a Hermes API server directly on a LAN or private
network (for example over Tailscale): point it at the machine's
`http://<host>:8642` with the `API_SERVER_KEY` from `~/.hermes/.env`.
Internet-facing endpoints must terminate HTTPS before the API server.

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
