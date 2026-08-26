# Oracle deployment

This Compose stack runs exactly one Brio relay replica, PostgreSQL for durable
user/device/agent state, and Caddy for automatic HTTPS and WebSocket proxying.

Copy `.env.example` to `.env`, set a strong PostgreSQL password and a domain
whose A record points to the VM, then run:

```sh
docker compose up -d --build
```

Configure either Clerk or `BRIO_DEVICE_REGISTRATION_KEY` before issuing new
device credentials. Existing device and connector tokens remain valid when
registration is closed. Keep `BRIO_INSECURE_DEV_MODE=false` on the public
relay. During a client migration only, set
`BRIO_ALLOW_LEGACY_QUERY_TOKENS=true`; return it to `false` as soon as the
mobile app and connector are both current.

Set `BRIO_RELAY_ALLOWED_ORIGINS` to the relay's public HTTPS origin (for
example, `https://relay.example.com`). React Native Android includes that
origin on WebSocket upgrades; add separate browser app origins as a
comma-separated list when needed.

Do not scale the relay above one replica until its live peer hub is moved out
of process memory or sticky peer routing is implemented.
