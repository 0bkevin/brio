# Brio

Brio is a mobile control plane for Hermes Agent.

The preferred UX is:

1. Open the mobile app.
2. Run `brio companion pair` on the Hermes machine.
3. Scan the terminal QR code; Brio verifies Companion and Hermes before saving it.
4. Add or switch environments from the environment picker. Use Tailscale for private access away from the local network.

## What Is Here

- `apps/mobile` - Expo React Native app.
- `apps/companion` - Go companion server that runs beside Hermes.
- `apps/relay` - Go relay/control-plane service for remote connections.
- `packages/protocol` - Shared JSON protocol schemas.

## Prerequisites

- Go `1.26.1`.
- Node.js and npm.
- Hermes Agent running at `http://127.0.0.1:8642` for a fully healthy companion connection.
- `hermes serve` running on loopback for Command Center controls. Brio uses its official JSON-RPC/WebSocket surface and requires the same session token.

Postgres is optional. The relay uses in-memory development storage when `BRIO_DATABASE_URL` is unset.

## Quick Start

```bash
make setup
make check
```

Start the companion:

```bash
make dev-companion
```

For goals, heartbeats, background tasks, and agent controls, start the Hermes
control plane with a shared local token before Companion:

```bash
HERMES_DASHBOARD_SESSION_TOKEN=replace-with-a-random-local-token \
  hermes serve --host 127.0.0.1 --port 9119

HERMES_CONTROL_TOKEN=replace-with-a-random-local-token \
  make dev-companion
```

The Hermes control server stays loopback-only. The phone authenticates to Brio
Companion; Companion keeps one persistent gateway connection so background
completion events and exact agent ownership survive mobile app reconnects. It
also drives due session heartbeats through Hermes' official pause, resume, and
queued prompt contracts, so the phone does not need to remain open.

Start the mobile app in another terminal:

```bash
make dev-mobile
```

In the app, tap **Connect to Hermes** and scan the QR code shown by
`brio companion pair`. Pasting the payload and manual host/token entry remain
available as fallbacks.

## Development Relay Flow

The current Relay flow is for local development only. It trusts the entered
email without verification, so it does not establish secure account ownership
and must not be exposed as a public production service.

Start the relay:

```bash
make dev-relay
```

Start the mobile app:

```bash
make dev-mobile
```

In the app:

1. Open **Development Relay** and connect to a Relay you control.
2. Generate an enrollment code.

On the Hermes machine:

```bash
brio companion enroll --relay-url http://127.0.0.1:8082 --code ABCD1234 --run
```

After enrollment, the agent appears under that development identity and can be
opened without another manual pairing payload.

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
brio companion pair        # print current mobile pairing payload or QR
brio companion enroll      # enroll this machine into the control plane
brio companion recover     # recover relay credentials for a claimed agent
brio companion stop        # stop background service
brio companion uninstall   # remove background service
brio companion run         # foreground server for debugging
```

When run in a terminal, `brio companion pair` also renders a QR code that the
mobile Add Environment sheet can scan. Piped output remains text-only.

## Optional Relay Mode

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

- `BRIO_ADDR` - companion bind address, default `0.0.0.0:8787` so phones on the local network can connect.
- `BRIO_PUBLIC_URL` - optional explicit address advertised in pairing payloads; by default Brio discovers the active LAN address.
- `HERMES_API_BASE` - Hermes API base URL, default `http://127.0.0.1:8642`.
- `HERMES_CONTROL_BASE` - `hermes serve` base URL, default `http://127.0.0.1:9119`.
- `HERMES_CONTROL_TOKEN` - session token shared with `hermes serve` through `HERMES_DASHBOARD_SESSION_TOKEN`.
- `BRIO_RELAY_ADDR` - relay bind address, default `127.0.0.1:8082`.
- `BRIO_RELAY_URL` - relay URL used by the companion, default `http://127.0.0.1:8082`.
- `BRIO_RELAY_TOKEN` - existing relay companion token used to recover relay mode if local pairing state is lost.
- `BRIO_DATABASE_URL` - optional Postgres URL for relay persistence.

### Connect through Tailscale

Tailscale can replace the Relay for private remote connectivity. Keep Brio Companion: it is the small bridge that translates the mobile app's requests to the agent running on your computer.

On the computer running Hermes, bind Companion only to its Tailscale address and advertise that same address:

```bash
BRIO_TAILSCALE_IP="$(tailscale ip -4)"
brio companion install \
  --addr "${BRIO_TAILSCALE_IP}:8787" \
  --public-url "http://${BRIO_TAILSCALE_IP}:8787"
brio companion pair
```

Then scan the QR code while the phone is connected to the same tailnet. The tailnet policy must allow the phone to reach TCP port `8787` on the computer. Binding to the Tailscale address keeps Companion off the regular LAN.

For a MagicDNS hostname with the default HTTP Companion, include `http://` explicitly in `--public-url`. Bare remote hostnames are treated as HTTPS. Direct HTTP on an ordinary LAN is not transport-encrypted; Tailscale encrypts it underneath.

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
- `POST /agents/{id}/recover` - owner-authenticated recovery path that returns a fresh relay pairing code and companion token.
- `POST /pairings` - create a short-lived pairing record.
- `GET /pairings/{code}` - inspect a pairing record.
- `POST /pairings/{code}/claim` - claim a pairing once with a device token.
- `GET /tunnel/companion/{agentID}?token=...` - authenticated companion WebSocket tunnel.
- `GET /tunnel/mobile/{agentID}?token=...` - authenticated mobile WebSocket tunnel.

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
