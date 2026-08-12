# Brio Mobile

Expo app for the Brio mobile control plane.

The interface follows the native T3 Code mobile work model, adapted to the
Hermes/Brio protocol:

- searchable Hermes session list and persistent run state
- conversation history, persistent drafts and queued follow-ups, cancellation, and approvals
- direct and relay-backed environments
- saved multi-environment switching, reconnect, editing, and removal
- workspace file browser and editor
- memory, config, skills, toolsets, scheduled jobs, logs, and gateway controls

Expo is configured to use the Hermes JavaScript engine on iOS and Android.

## Run

From the repo root:

```bash
make setup
make dev-mobile
```

From this directory:

```bash
npm ci
npm run web
```

## Validate

From the repo root:

```bash
make check
```

From this directory:

```bash
npm run check
```

`npm run check` runs Expo linting, TypeScript, and a static web export.

## Connect Locally

Start the companion in a separate terminal:

```bash
make dev-companion
```

In the mobile app, tap **Connect to Hermes**, run `brio companion pair` on the
Hermes machine, and scan the terminal QR code. Brio validates the payload and
checks both Companion and Hermes before saving the environment. Pasting the
payload, asking Hermes for it, and entering host/token details manually remain
available as fallback paths.

Saved environments can be switched, retried, renamed, updated, or removed
from the environment picker and Settings.

For an installed companion binary on an end-user machine:

```bash
brio companion install
brio companion pair
```
