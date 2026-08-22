# Brio Mobile

Expo app for the Brio mobile control plane.

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
command on the Hermes machine. It installs Hermes when missing, enrolls the
machine with the relay, and installs/starts the gateway service, which runs
the Brio relay tunnel automatically.

For local CLI development without the installer:

```bash
hermes brio enroll --relay-url http://127.0.0.1:8082 --code ABCD1234
hermes gateway restart
```

Direct connections to a Hermes API server on the LAN are still available in
the app under Advanced.
