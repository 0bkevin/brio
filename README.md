# Brio

Brio is a mobile control plane for Hermes Agent.

## What Is Here

- `apps/mobile` - Expo React Native app.
- `apps/companion` - Go companion server that runs beside Hermes.
- `apps/relay` - Go relay/control-plane service for remote connections.
- `packages/protocol` - Shared JSON protocol schemas.

## Prerequisites

- Go `1.26.1`.
- Node.js and npm.
- Hermes Agent running at `http://127.0.0.1:8642` for a fully healthy companion connection.

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

Start the mobile app in another terminal:

```bash
make dev-mobile
```

Paste the pairing payload printed by the companion into the mobile app.

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
brio companion stop        # stop background service
brio companion uninstall   # remove background service
brio companion run         # foreground server for debugging
```

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

- `BRIO_ADDR` - companion bind address, default `127.0.0.1:8787`.
- `HERMES_API_BASE` - Hermes API base URL, default `http://127.0.0.1:8642`.
- `BRIO_RELAY_ADDR` - relay bind address, default `127.0.0.1:8082`.
- `BRIO_RELAY_URL` - relay URL used by the companion, default `http://127.0.0.1:8082`.
- `BRIO_DATABASE_URL` - optional Postgres URL for relay persistence.

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
- `GET /agents` - list agents owned by the authenticated user.
- `POST /pairings` - create a short-lived pairing record.
- `GET /pairings/{code}` - inspect a pairing record.
- `POST /pairings/{code}/claim` - claim a pairing once with a device token.
- `GET /tunnel/companion/{agentID}?token=...` - authenticated companion WebSocket tunnel.
- `GET /tunnel/mobile/{agentID}?token=...` - authenticated mobile WebSocket tunnel.
