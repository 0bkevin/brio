# Brio Mobile

Expo app for the Brio mobile control plane.

Conversation drafts and queued follow-ups are persisted locally. Queued prompts
can be paused, reordered, edited, retried, or removed before delivery.

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

## Connect A Hermes Machine

Start the relay for local development:

```bash
make dev-relay
```

In the mobile app, sign in to the relay and generate a setup command. Run that
command on the Hermes machine. It installs the slim `brio` connector, enables
the Hermes API server, enrolls the machine with the relay, and installs/starts
the connector service, which keeps the Brio relay tunnel running.

For local CLI development without the installer:

```bash
brio setup --relay-url http://127.0.0.1:8082 --code ABCD1234
```

Direct connections to a Hermes API server on the LAN are still available in
the app under Advanced.
