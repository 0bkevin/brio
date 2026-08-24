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
  - Forwards `/v1/responses`, `/v1/runs...`, `/api/jobs...`, `/api/sessions`, `/api/sessions/{id}/messages`, `/v1/capabilities`, and `/health` (plus `/chat/responses` and `/capabilities` aliases) to the Hermes API server with the local `API_SERVER_KEY`.
  - Serves `/v1/memory` from `~/.hermes/memories` directly (legacy `/memory` too); session state remains owned and shaped by the Hermes API server.
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
- `DELETE /agents/{id}`
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

Postgres migrations are recorded in `brio_schema_migrations` and serialized
with a transaction-scoped advisory lock. Relay and connector invariants copied
from T3 Connect, plus the remaining architectural gaps, are documented in
`docs/relay-practices.md`.

Without Postgres, the in-memory relay is only suitable for development.

## Current Storage/Config

Connector state is written to `~/.brio/connect.env` (0600):

- `BRIO_RELAY_URL`
- `BRIO_RELAY_TOKEN`
- `BRIO_AGENT_ID`
- `HERMES_API_BASE`
- `HERMES_API_KEY`

Optional per-profile control planes (for the Command Center on named Hermes
profiles): `HERMES_CONTROL_BASE_<PROFILE>` and `HERMES_CONTROL_TOKEN_<PROFILE>`.

Setup also merges into `~/.hermes/.env` (preserving unrelated keys):

- `API_SERVER_ENABLED`
- `API_SERVER_HOST`
- `API_SERVER_PORT`
- `API_SERVER_KEY`

## Hermes Profiles

The connector operates on the real Hermes profile layout: `default` is
`~/.hermes` itself, the sticky selection is `<home>/active_profile`,
metadata is `<profile>/profile.yaml`, gateway runtime state is
`<profile>/gateway_state.json`, and name validation/reserved aliases match
hermes_cli/profiles.py at the pinned SHA.

Reads (list/show/status/alias map/SOUL/export preview) come from the
filesystem. Every mutation — create, describe, rename, delete, archive
export/import, distribution install/update, and gateway start/stop/restart —
is delegated to the installed stock `hermes` CLI with `HERMES_HOME` scoped
to the connector home, behind an injectable CLIRunner
(`apps/connect/internal/hermes/profiles_cli.go`). This keeps bundled-skill
seeding, standard directories, wrapper aliases, managed services, Honcho
migration, and s6 registration native to Hermes instead of duplicated.

Routes (`apps/connect/internal/hermes/profiles_http.go`):

- `/api/profiles` list/create; `/api/profiles/{name}` show; `use`,
  `describe`, `rename` (typed confirm), `delete` (typed confirm), `gateway`
  POST {action}, `soul` GET/PUT, `export-preview` GET.
- `/api/profiles/export` POST runs the CLI export and returns base64 +
  sha256 (credential-free by Hermes design). Raw archives are capped at
  6 MiB so the base64 frame (~8 MiB) fits the connector's 10 MiB response
  limit.
- `/api/profiles/import` POST {archive_b64, name, dry_run, allow_secrets?,
  preview_token}: dry-run sanitizes the tar (credential FILE NAMES only,
  never values) and issues a preview_token digest bound to the exact
  payload + target; apply requires that token, rejects existing targets
  (stock Hermes import has no replace path), and requires explicit
  allow_secrets consent when the archive carries .env/.env.*/auth.json.
- `/api/profiles/install-distribution` POST {source, name?, force?, alias?,
  dry_run, preview_token?}: git URLs (file://, github shorthand, https/ssh,
  #ref pins for branches/tags/commits via shallow clone or fetch fallback)
  stage into a temp clone; local dirs must contain distribution.yaml;
  symlinks are rejected; ownership follows Hermes' distribution_owned /
  USER_OWNED_EXCLUDE rules under bounded file/size budgets; the preview
  issues a preview_token digest over the staged tree and apply re-stages,
  verifies it, then delegates to `hermes profile install` against that same
  tree, preserving the original URL/path (including #ref) as the installed
  manifest source.
- `/api/profiles/update-distribution` POST {name, force_config?} delegates to
  `hermes profile update`.
- Any allowed route can be prefixed with `/p/<profile>/...`: forwarded paths
  keep their prefix upstream and authenticate with that profile's own
  API_SERVER_KEY (fail-closed), unknown profiles return 404 before any
  upstream call, memory reads/writes scope to the profile home, and control
  routes require a per-profile override or fail closed.

Per-profile control overrides use a versioned, reversible state-key encoding
shared by writer/reader: `HERMES_CONTROL_BASE_<suffix>` where suffix =
ControlEnvSuffix(profile). Simple `[a-z0-9]+` names stay raw uppercase
(CODER); separator names use V1_ plus lowercase hex (research-bot →
V1_72657365617263682d626f74); ambiguous legacy raw separator keys such as
RESEARCH_BOT or RESEARCH_HBOT are rejected rather than misrouted.

Mobile identity keys are always `(environmentId, profileName)`:
`src/lib/profiles-model.ts` holds the pure helpers, chat threads store their
profile (`thread.profile`; legacy rows map to `default`), every query key
includes the profile dimension, and `brio://chat?agent=&profile=&session=`
deep links resolve through the layout + deep-link-store into the chat
workspace with environment-exact matching.

## Development Notes

- Prefer the control-plane flow over manual pairing for product work.
- Prefer `brio setup` + `brio install` for user-facing onboarding.
- Keep direct local connect (Hermes API server on the LAN) as a fallback for development and offline debugging.
- Recovery is owner-authenticated and intentionally separate from normal enrollment.
- Mobile relay sign-in is still lightweight and not a production identity system yet.
- The mobile app speaks Hermes-native `/v1/*` and `/api/sessions` paths; the connector maps only the remaining companion-era chat/capability aliases for compatibility.
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
