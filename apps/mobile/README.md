# Brio Mobile

Expo app for the Brio mobile control plane.

The interface follows the native T3 Code mobile work model, adapted to the
Hermes/Brio protocol:

- searchable Hermes session list and persistent run state
- conversation history, long-running tasks, cancellation, and approvals
- Relay-backed environments
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

## Connect to Hermes

In the mobile app, tap **Connect with Brio Relay**, sign in to the Relay, and
generate an enrollment command. Run that command on the Hermes machine. It
downloads the slim `brio` connector, configures the stock Hermes API server,
enrolls the machine with the Relay, and starts the connector service.

Saved environments can be switched, retried, renamed, updated, or removed
from the environment picker and Settings. See the repository-level README for
the full connector setup, recovery, and service-management commands.
