# Brio Agent Infra

This project now uses a control-plane enrollment model as the primary way to connect Hermes agents to the Brio app.

## Architecture

- `apps/relay`
  - Cloud control plane.
  - Stores users, device sessions, signed environment links, managed endpoints,
    enrollments, pairings, and recovery state.
  - Mobile app talks to this service first.
- `apps/companion`
  - Runs next to Hermes on each machine.
  - Exposes the local Brio API to Hermes.
  - Runs the relay-provisioned managed endpoint connector.
  - Mints short-lived, DPoP-bound client sessions only after validating a
    relay-signed request.
- `apps/mobile`
  - Signs into the relay.
  - Lists owned agents.
  - Generates enrollment codes.
  - Uses the relay to bootstrap a direct managed-endpoint connection.

## Preferred User Flow

1. User opens the mobile app.
2. User signs into the relay with email + device name.
3. User generates an enrollment code in the app.
4. On the Hermes machine, user runs:

```bash
brio companion enroll --relay-url <relay-url> --code <code> --run
```

5. The companion signs a single-use link proof and claims the enrollment.
6. The relay provisions/reconciles a stable managed endpoint when configured.
7. The app requests a connection bootstrap from the relay, exchanges it with
   the companion, then sends normal traffic directly with DPoP.
8. The agent appears in the app automatically.

## Relay Modes

- `pairing`
  - Legacy/manual relay mode.
  - Uses pairing payloads and pairing codes.
- `control-plane`
  - Preferred mode.
  - Uses enrollment, signed persistent environment identity, managed endpoint
    reconciliation, and short-lived direct credentials.
  - The relay is not the normal API traffic path.

The companion config key is:

```bash
BRIO_RELAY_MODE=control-plane
```

## Important Commands

Run relay locally:

```bash
make dev-relay
```

Run mobile locally:

```bash
make dev-mobile
```

Run companion in legacy local mode:

```bash
make dev-companion
```

Enroll a Hermes machine into the control plane:

```bash
brio companion enroll --relay-url http://127.0.0.1:8082 --code ABCD1234 --run
```

Recover an enrolled agent if local relay state is lost:

```bash
brio companion recover \
  --relay-url http://127.0.0.1:8082 \
  --agent-id agent_xxx \
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

Public companion-facing endpoints:

- `POST /enrollments/{code}/claim`
- `POST /pairings`
- `GET /pairings/{code}`
- `GET /tunnel/companion/{agentID}?token=...`
- `GET /tunnel/mobile/{agentID}?token=...`

Brio Connect endpoints:

- `GET /.well-known/brio-connect`
- `GET /v1/environments`
- `POST /v1/environments/{id}/status`
- `POST /v1/environments/{id}/connect`
- `DELETE /v1/client/environment-links/{id}`
- `POST /v1/environments/{id}/tunnel/reconcile`
- `DELETE /v1/environments/{id}/tunnel`

The `/tunnel/*` routes are legacy compatibility surfaces.

## Data Requirements

The relay needs persistent storage because it is the system of record for:

- users
- device sessions
- owned agents
- enrollment codes
- pairing codes
- companion token rotation
- recovery state

Without Postgres, the in-memory relay is only suitable for development.

## Current Storage/Config

Companion local state is written under:

- `~/.brio/companion.env`
- `~/.brio/pairing.json`
- `~/.brio/connect.json` (environment private key and installed relay trust;
  mode `0600`)

Important config values:

- `BRIO_RELAY_URL`
- `BRIO_RELAY_TOKEN`
- `BRIO_RELAY_MODE`
- `BRIO_AGENT_ID`
- `BRIO_TOKEN`
- `HERMES_API_BASE`

## Development Notes

- Prefer the control-plane flow over manual pairing for product work.
- Keep direct local connect as a fallback for development and offline debugging.
- Recovery is owner-authenticated and intentionally separate from normal enrollment.
- Mobile relay sign-in is still lightweight and not a production identity system yet.
- Production relay storage requires a stable `BRIO_RELAY_SIGNING_KEY`.
- Managed endpoints use retry-safe stable Cloudflare tunnel/DNS names, a
  default per-user limit of three, bounded exponential startup reconciliation,
  release on shutdown, and deprovision on unlink.

## Validation

Use:

```bash
make check
```

That runs Go tests plus mobile lint, typecheck, and static web export.
