# Brio

Brio is a mobile control plane for Hermes Agent.

The preferred UX is:

1. Open the mobile app.
2. Sign in to the Brio relay.
3. Generate a setup command.
4. Run that command on the Hermes machine.
5. It installs Hermes (when missing), enrolls the machine with the relay, and
   installs/starts the gateway service — the agent appears in the app.

There is no separate companion binary. Hermes runs the Brio relay tunnel
itself (`hermes brio` in the hermes-agent CLI), so one install covers
everything.

## What Is Here

- `apps/mobile` - Expo React Native app.
- `apps/relay` - Go relay/control-plane service for remote connections.
- `packages/protocol` - Shared JSON protocol schemas.

The Hermes-side connector lives in the
[hermes-agent](https://github.com/0bkevin/hermes-agent) repo
(`gateway/platforms/brio_connector.py`, `hermes brio` CLI).

## Prerequisites

- Go `1.26.1` (relay only).
- Node.js and npm (mobile app).
- Hermes Agent on the target machine — with the `hermes brio` connector — for
  enrollment.

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
curl -fsSL https://github.com/0bkevin/brio/raw/main/scripts/install.sh \
  | BRIO_RELAY_URL="http://127.0.0.1:8082" \
    BRIO_ENROLL_CODE="ABCD1234" \
    BRIO_AGENT_NAME="Hermes" \
    sh
```

The installer installs Hermes when missing (from the fork that carries the
Brio connector), claims the enrollment code, writes `BRIO_RELAY_URL`,
`BRIO_RELAY_TOKEN`, and `BRIO_AGENT_ID` into `~/.hermes/.env`, enables the
Hermes API server, and installs/starts the gateway service. The gateway runs
the relay tunnel automatically whenever the BRIO credentials are present.

On the Hermes machine you can also manage everything directly:

```bash
hermes brio enroll --relay-url <relay-url> --code <code>   # enroll/re-enroll
hermes brio status                                        # tunnel + relay status
hermes brio recover --relay-url <url> --agent-id <id> \
  --device-token <owner-device-token>                     # recover credentials
hermes gateway install / start / restart / stop            # service lifecycle
```

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

- `go test ./apps/relay/...`
- `npm run lint`
- `npm run typecheck`
- `npm run export:web`

The web export is written to `/tmp/brio-web-export` by default.

## Relay Endpoints

- `POST /auth/devices` - create a device auth token for a user.
- `GET /me` - inspect the authenticated device/user.
- `GET /devices` - list devices for the authenticated user.
- `DELETE /devices/{id}` - revoke a device token.
- `GET /agents` - list agents owned by the authenticated user.
- `POST /enrollments` - create a short-lived enrollment code for a user.
- `POST /enrollments/{code}/claim` - claim an enrollment code from a Hermes machine.
- `POST /agents/{id}/recover` - owner-authenticated recovery path that returns a fresh relay pairing code and companion token.
- `POST /pairings` - create a short-lived pairing record.
- `GET /pairings/{code}` - inspect a pairing record.
- `POST /pairings/{code}/claim` - claim a pairing once with a device token.
- `GET /tunnel/companion/{agentID}?token=...` - authenticated Hermes-connector WebSocket tunnel.
- `GET /tunnel/mobile/{agentID}?token=...` - authenticated mobile WebSocket tunnel.

The relay routes request frames to one connected Hermes connector and records
the requesting mobile peer by frame ID. Response, error, and stream frames
from the connector are delivered only to that requesting peer. Pending relay
requests expire after six minutes if the connector does not finish.

Chat requests use Hermes' Responses API SSE stream. The connector preserves
the SSE bytes in `stream_chunk` frames and finishes with `stream_end`. The
mobile app renders `response.output_text.delta` events incrementally and
falls back to ordinary JSON responses for older Hermes installations.

If a Hermes machine loses its `~/.hermes/.env` BRIO credentials, recover the
agent through the relay and restart the gateway with the returned token (see
`hermes brio recover` above). The mobile app includes the same recovery flow.

## Deployment

The relay ships as a Docker image (`apps/relay/Dockerfile`) and is currently
deployed on AWS Lightsail; an AWS Copilot manifest lives under `copilot/`. Set
`BRIO_DATABASE_URL` (Postgres) and `BRIO_DEVICE_REGISTRATION_KEY` as secrets
in any deployed environment.
