# Brio Connect security architecture

Brio Connect follows T3 Connect's split-credential design while keeping the
relay and companion implementations in Go.

## Trust boundaries

1. **Clerk identifies the person.** The app requests the configured Clerk JWT
   template. The Go relay verifies its signature, exact issuer, exact audience,
   expiry, and configured authorized party. The relay maps `(issuer, subject)`
   to an internal Brio user; email is display metadata, not an account key.
2. **The phone proves possession.** The app creates a P-256 DPoP key. It exchanges
   the Clerk JWT for a relay-signed ES256 token bound to that key's RFC 7638
   thumbprint. The token lasts 30 minutes and contains only approved client
   scopes.
3. **The environment remains sovereign.** For a connect request, the relay sends
   a signed request to the linked companion. The companion returns a random,
   two-minute, one-use bootstrap credential bound to the same phone key. The
   phone exchanges it directly with the companion.
4. **The companion issues final access.** The companion returns a random,
   one-hour DPoP access token. The relay never receives this token and cannot use
   it. Companion requests enforce `brio:read` for safe methods and
   `brio:operate` for mutations.

Every DPoP proof contains `jti`, `iat`, `htm`, `htu`, and—when used with an
access token—`ath`. Both Go services verify the P-256 signature, key thumbprint,
method, normalized URL, token hash, and clock window. The relay persists each
`(thumbprint, jti)` for five minutes so replays are rejected across replicas.

## Relay scopes

- `environment:connect`
- `environment:status`
- `mobile:registration` (mobile client only)

The relay accepts only the known `brio-mobile` and `brio-web` client IDs. It does
not grant unrequested scopes, and the web client cannot request mobile device
registration.

## Production checklist

- Use HTTPS for the public relay and every managed companion endpoint.
- Configure a Clerk JWT template with exact audience `brio-relay`.
- Set `BRIO_CLERK_ISSUER` to the exact Clerk issuer.
- Set `BRIO_CLERK_AUTHORIZED_PARTIES` to the deployed web origin and approved
  native app scheme(s).
- Configure either `BRIO_CLERK_SECRET_KEY` for Clerk JWKS rotation or a rotated
  `BRIO_CLERK_JWT_KEY` public key.
- Set a stable PEM P-256 `BRIO_RELAY_SIGNING_KEY` and keep it in a secret manager.
- Use Postgres so identity mappings and DPoP replay records survive restarts and
  work across relay replicas.
- Do not set `BRIO_DEV_AUTH` or `EXPO_PUBLIC_BRIO_DEV_AUTH` in production.
- Keep the companion's `~/.brio/connect.json` permissions at `0600` and protect
  the device's SecureStore/Keychain access.

The relay refuses production startup without Clerk configuration. Development
auth is additionally restricted to a loopback HTTP issuer, and the legacy
mobile relay tunnel is disabled when development auth is off.
