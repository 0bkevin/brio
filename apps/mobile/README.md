# Brio Mobile

Expo app for the Brio mobile control plane.

The interface follows the native T3 Code mobile work model, adapted to the
Hermes/Brio protocol:

- searchable Hermes session list and persistent run state
- conversation history, long-running tasks, cancellation, and approvals
- direct and relay-backed environments
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

In the mobile app, use `Ask your agent`, paste the generated message into
Hermes, then paste Hermes's reply back into the app. Hermes can look up the
pairing details with `brio companion pair`.

The Add Environment sheet also matches T3 Code's pairing flow: run
`brio companion pair`, scan the terminal QR code, paste the pairing payload,
or enter the host and token manually.

For an installed companion binary on an end-user machine:

```bash
brio companion install
brio companion pair
```
