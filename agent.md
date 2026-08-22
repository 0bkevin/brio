# Brio Agent Infra

This project uses a control-plane enrollment model as the primary way to connect Hermes agents to the Brio app. There is no companion binary anymore: the hermes-agent CLI itself runs the relay tunnel.

## Architecture

- `apps/relay`
  - Cloud control plane.
  - Stores users, device sessions, owned agents, enrollments, pairings, and recovery state.
  - Mobile app talks to this service first.
- hermes-agent (github.com/0bkevin/hermes-agent)
  - Runs the Brio connector natively (`gateway/platforms/brio_connector.py`).
  - `hermes brio enroll|connect|status|recover` CLI.
  - The gateway auto-starts the tunnel whenever BRIO_* credentials are present in `~/.hermes/.env`.
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
curl -fsSL https://github.com/0bkevin/brio/raw/main/scripts/install.sh \
  | BRIO_RELAY_URL="<relay-url>" \
    BRIO_ENROLL_CODE="<code>" \
    BRIO_AGENT_NAME="Hermes" \
    sh
```

5. The installer installs Hermes when missing, claims the enrollment code, writes relay credentials, enables the API server, and installs/starts the gateway service.
6. The agent appears in the app automatically.
7. The user selects the agent from the app and connects.

## Relay Modes

- `pairing`
  - Legacy/manual relay mode.
  - Uses pairing payloads and pairing codes.
- `control-plane`
  - Preferred mode.
  - Uses enrollment and persistent agent ownership.
  - Hermes keeps a relay token locally and reconnects without manual pairing.

## Important Commands

Run relay locally:

```bash
make dev-relay
```

Run mobile locally:

```bash
make dev-mobile
```

Set up a Hermes machine into the control plane:

```bash
hermes brio enroll --relay-url http://127.0.0.1:8082 --code ABCD1234
```

Recover an enrolled agent if local relay state is lost:

```bash
hermes brio recover \
  --relay-url http://127.0.0.1:8082 \
  --agent-id agent_xxx \
  --device-token <owner-device-token>
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

Hermes-side connector state is written to `~/.hermes/.env`:

- `BRIO_RELAY_URL`
- `BRIO_RELAY_TOKEN`
- `BRIO_AGENT_ID`
- `API_SERVER_ENABLED`
- `API_SERVER_KEY`

## Development Notes

- Prefer the control-plane flow over manual pairing for product work.
- Prefer `hermes brio enroll` + `hermes gateway install` for user-facing onboarding.
- Keep direct local connect (Hermes API server on the LAN) as a fallback for development and offline debugging.
- Recovery is owner-authenticated and intentionally separate from normal enrollment.
- Mobile relay sign-in is still lightweight and not a production identity system yet.
- The mobile app speaks Hermes-native `/v1/*` paths; the connector also maps legacy companion-era paths for compatibility.

## Validation

Use:

```bash
make check
```

That runs relay Go tests plus mobile lint, typecheck, and static web export.
