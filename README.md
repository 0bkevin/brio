# Brio

Brio is a mobile control plane for Hermes Agent.

The preferred UX is:

1. Open the mobile app.
2. Sign in to Brio Connect and generate an enrollment code.
3. Enroll the Hermes machine with `brio companion enroll`.
4. Select the linked environment. The relay brokers a short-lived credential,
   then the app talks directly to its managed endpoint.

The `Ask your agent` handoff remains available as a local/offline fallback.

## What Is Here

- `apps/mobile` - Expo React Native app.
- `apps/companion` - Go companion server that runs beside Hermes.
- `apps/relay` - Go relay/control-plane service for remote connections.
- `packages/protocol` - Shared JSON protocol schemas.

## Prerequisites

- Go `1.26.1`.
- Node.js and npm.
- Hermes Agent running at `http://127.0.0.1:8642` for a fully healthy companion connection.

Postgres is optional for development. Persistent deployments also require a
stable `BRIO_RELAY_SIGNING_KEY`; changing it invalidates the trust installed in
linked companions.

## Local Fallback

```bash
make setup
make check
```

Start the companion:

```bash
make dev-companion
```

Start the mobile app in another terminal:

```bash
make dev-mobile
```

In the app, use `Ask your agent` and paste the prompt into Hermes. Hermes can
look up the current companion pairing details by running `brio companion pair`.
Paste Hermes's reply back into Brio to connect.

## Brio Connect Flow

Brio Connect follows the same control-plane model as T3 Connect. The relay is
not in the hot path for normal companion traffic.

Start the relay:

```bash
make dev-relay
```

Start the mobile app:

```bash
make dev-mobile
```

In the app:

1. Sign in to the relay.
2. Generate an enrollment code.

On the Hermes machine:

```bash
brio companion enroll --relay-url http://127.0.0.1:8082 --code ABCD1234 --run
```

Enrollment creates a persistent P-256 environment identity and a signed,
single-use link proof. When the app connects, the relay sends a short-lived
signed mint request to the companion and verifies its signed response. The app
exchanges that one-time credential for a one-hour DPoP-bound session, so neither
the relay nor the tunnel transport can reuse the resulting access token.

For a hosted managed endpoint, put `cloudflared` on the companion's `PATH` and
configure the Cloudflare variables described below. Without them, development
uses the companion's `BRIO_PUBLIC_URL` (loopback HTTP is accepted only when the
relay issuer is also HTTP).

## Companion Service

For an end-user machine, Brio Companion can install itself as a background service:

```bash
brio companion install
brio companion status
brio companion pair
```

This writes local configuration to `~/.brio/companion.env`, starts the companion at login, and keeps it running in the background.

Supported service managers:

- macOS: user LaunchAgent.
- Linux: user `systemd` service.
- Windows: login task through Task Scheduler.

Useful commands:

```bash
brio companion install     # install and start background service
brio companion start       # start installed background service
brio companion restart     # restart installed background service
brio companion status      # service and /health status
brio companion pair        # print current mobile pairing payload
brio companion enroll      # enroll this machine into the control plane
brio companion recover     # recover relay credentials for a claimed agent
brio companion stop        # stop background service
brio companion uninstall   # remove background service
brio companion run         # foreground server for debugging
```

## Legacy Relay Compatibility

Start the relay:

```bash
make dev-relay
```

Start the companion through the relay:

```bash
make dev-companion-relay
```

Start the mobile app:

```bash
make dev-mobile
```

## Configuration

The root `Makefile` reads `.env` automatically if it exists. Start from:

```bash
cp .env.example .env
```

Common values:

- `BRIO_ADDR` - companion bind address, default `127.0.0.1:8787`.
- `HERMES_API_BASE` - Hermes API base URL, default `http://127.0.0.1:8642`.
- `BRIO_RELAY_ADDR` - relay bind address, default `127.0.0.1:8082`.
- `BRIO_RELAY_URL` - relay URL used by the companion, default `http://127.0.0.1:8082`.
- `BRIO_RELAY_TOKEN` - existing relay companion token used to recover relay mode if local pairing state is lost.
- `BRIO_DATABASE_URL` - optional Postgres URL for relay persistence.
- `BRIO_RELAY_ISSUER` - public absolute relay URL used as the JWT issuer.
- `BRIO_RELAY_SIGNING_KEY` - PEM P-256 private key; required with Postgres.
- `BRIO_CLOUDFLARE_ACCOUNT_ID`, `BRIO_CLOUDFLARE_API_TOKEN`,
  `BRIO_CLOUDFLARE_ZONE_ID`, `BRIO_TUNNEL_BASE_DOMAIN` - enable stable managed
  Cloudflare Tunnel endpoints.
- `BRIO_MANAGED_TUNNEL_LIMIT` - per-user managed endpoint limit, default `3`.
- `BRIO_CLOUDFLARED_PATH` - companion path to `cloudflared`, default
  `cloudflared`.

## Direct Commands

If you do not want to use `make`, these are the equivalent commands.

```bash
cd apps/companion
go run . companion run --addr 127.0.0.1:8787
```

```bash
cd apps/mobile
npm ci
npm run web
```

```bash
cd apps/relay
go run . serve --addr 127.0.0.1:8082
```

## Validation

`make check` runs:

- `go test ./apps/companion/... ./apps/relay/...`
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
- `GET /.well-known/brio-connect` - relay issuer and signing-key metadata.
- `GET /v1/environments` - list linked environments.
- `POST /v1/environments/{id}/status` - verify a signed environment health response.
- `POST /v1/environments/{id}/connect` - broker a one-time, DPoP-bound environment credential.
- `DELETE /v1/client/environment-links/{id}` - deprovision and unlink an environment.
- `POST /v1/environments/{id}/tunnel/reconcile` - retry-safe companion startup reconciliation.
- `DELETE /v1/environments/{id}/tunnel` - release the billable managed tunnel on shutdown.
- `POST /agents/{id}/recover` - owner-authenticated recovery path that returns a fresh relay pairing code and companion token.
- `POST /pairings` - create a short-lived pairing record.
- `GET /pairings/{code}` - inspect a pairing record.
- `POST /pairings/{code}/claim` - claim a pairing once with a device token.
- `GET /tunnel/companion/{agentID}?token=...` - authenticated companion WebSocket tunnel.
- `GET /tunnel/mobile/{agentID}?token=...` - authenticated mobile WebSocket tunnel.

The `/tunnel/*`, pairing, and recovery endpoints are compatibility surfaces.
New control-plane connections use the managed endpoint and do not proxy normal
API traffic through the relay.

For claimed agents, `POST /pairings` accepts the current companion token through
`Authorization: Bearer ...` so the companion can refresh relay pairing safely
after a restart.

If `~/.brio/pairing.json` is lost, recover the agent through the relay and then
restart the companion with the returned token:

```bash
brio companion recover \
  --relay-url "$BRIO_RELAY_URL" \
  --agent-id "$BRIO_AGENT_ID" \
  --device-token "$BRIO_DEVICE_TOKEN" \
  --restart
```

The mobile app includes the same recovery flow. It can request the recovered
relay token and code, but the companion still must restart with that token
before a fresh pairing payload can be used to reconnect.
