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

## Connect Locally

Start the companion in a separate terminal:

```bash
make dev-companion
```

The companion prints a pairing payload. Paste it into the mobile app to create a direct local connection.

For an installed companion binary on an end-user machine:

```bash
brio companion install
brio companion pair
```
