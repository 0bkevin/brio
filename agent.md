# Brio Agent Infra

This project uses a control-plane enrollment model as the primary way to connect Hermes agents to the Brio app. The connector is a slim `brio` Go binary in this repo (`apps/connect`); hermes-agent stays completely stock.

## Architecture

- `apps/relay`
  - Cloud control plane.
  - Stores users, device sessions, owned agents, enrollments, pairings, and recovery state.
  - Mobile app talks to this service first.
- `apps/connect`
  - The `brio` connector binary.
  - `brio setup` enables the stock Hermes API server in `~/.hermes/.env`, claims an enrollment code, persists state under `~/.brio/`, and installs/starts the service.
  - `brio connect` keeps an outbound WebSocket tunnel to the relay (no local HTTP listener).
  - Forwards `/v1/responses`, `/v1/runs...`, `/api/jobs...`, `/v1/capabilities`, `/health` (plus `/chat/responses` and `/capabilities` aliases) to the Hermes API server with the local `API_SERVER_KEY`.
  - Serves `/v1/sessions`, `/v1/sessions/{id}/messages`, and `/v1/memory` from `~/.hermes` directly (state.db + memories/, legacy paths too).
  - Everything else is a 404 error frame; there are no file/config/gateway/skills/tools/logs endpoints anymore.
- hermes-agent (stock)
  - Only needs its built-in API server (`http://127.0.0.1:8642`, bearer `API_SERVER_KEY`).
- `apps/mobile`
  - Signs into the relay.
  - Lists owned agents.
  - Generates enrollment codes.
  - Connects to enrolled agents through the relay.

## Preferred User Flow

1. User opens the mobile app.
2. User signs into the relay with email + device name.
3. User generates a setup command.
4. On the Hermes machine, user runs:

```bash
curl -fsSL https://github.com/0bkevin/brio/releases/latest/download/install.sh \
  | BRIO_RELAY_URL="<relay-url>" \
    BRIO_ENROLL_CODE="<code>" \
    BRIO_AGENT_NAME="Hermes" \
    sh
```

5. The installer downloads the release binary (checksum-verified) and runs
   `brio setup`, which configures the Hermes API server, claims the
   enrollment code, writes connector state, and installs/starts the
   background service.
6. The agent appears in the app automatically.
7. The user selects the agent from the app and connects.

## Relay Modes

- `pairing`
  - Legacy/manual relay mode.
  - Uses pairing payloads and pairing codes.
- `control-plane`
  - Preferred mode.
  - Uses enrollment and persistent agent ownership.
  - The connector keeps a relay token in `~/.brio/connect.env` and reconnects without manual pairing.

## Important Commands

Run relay locally:

```bash
make dev-relay
```

Run connector locally:

```bash
make dev-connect
```

Run mobile locally:

```bash
make dev-mobile
```

Set up a Hermes machine into the control plane:

```bash
brio setup --relay-url http://127.0.0.1:8082 --code ABCD1234
```

Check connector status:

```bash
brio status
```

Recover an enrolled agent if local relay state is lost:

```bash
brio recover \
  --relay-url http://127.0.0.1:8082 \
  --agent-id hermes_xxx \
  --device-token <owner-device-token> \
  --restart
```

## Relay Endpoints

Authenticated device endpoints:

- `POST /auth/devices`
- `GET /me`
- `GET /devices`
- `DELETE /devices/{id}`
- `GET /agents`
- `POST /enrollments`
- `POST /agents/{id}/recover`
- `POST /pairings/{code}/claim`

Public connector-facing endpoints:

- `POST /enrollments/{code}/claim`
- `POST /pairings`
- `GET /pairings/{code}`
- `GET /tunnel/companion/{agentID}?token=...`
- `GET /tunnel/mobile/{agentID}?token=...`

## Data Requirements

The relay needs persistent storage because it is the system of record for:

- users
- device sessions
- owned agents
- enrollment codes
- pairing codes
- connector token rotation
- recovery state

Without Postgres, the in-memory relay is only suitable for development.

## Current Storage/Config

Connector state is written to `~/.brio/connect.env` (0600):

- `BRIO_RELAY_URL`
- `BRIO_RELAY_TOKEN`
- `BRIO_AGENT_ID`
- `HERMES_API_BASE`
- `HERMES_API_KEY`

Setup also merges into `~/.hermes/.env` (preserving unrelated keys):

- `API_SERVER_ENABLED`
- `API_SERVER_HOST`
- `API_SERVER_PORT`
- `API_SERVER_KEY`

## Development Notes

- Prefer the control-plane flow over manual pairing for product work.
- Prefer `brio setup` + `brio install` for user-facing onboarding.
- Keep direct local connect (Hermes API server on the LAN) as a fallback for development and offline debugging.
- Recovery is owner-authenticated and intentionally separate from normal enrollment.
- Mobile relay sign-in is still lightweight and not a production identity system yet.
- The mobile app speaks Hermes-native `/v1/*` paths; the connector also maps legacy companion-era paths for compatibility.
- Releases publish connector binaries again: pushing a `v*` tag builds
  linux/darwin/windows amd64/arm64 assets plus `checksums.txt`, and
  `scripts/install.sh` downloads them with checksum verification.

## Validation

Use:

```bash
make check
```

That runs connector and relay Go tests, installer script tests, plus mobile
lint, typecheck, and static web export.
