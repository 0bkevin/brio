#!/bin/sh
# Brio installer — connects this machine's Hermes agent to the Brio relay.
#
#   curl -fsSL https://github.com/0bkevin/brio/raw/main/scripts/install.sh | sh
#
# The Brio companion binary is gone: Hermes itself now runs the relay tunnel
# (`hermes brio` in the hermes-agent CLI). This script installs Hermes when
# missing, enrolls it with the Brio relay, and installs/starts the gateway
# service, which keeps the tunnel running in the background.
#
# Optional env vars:
#   BRIO_RELAY_URL       relay URL for enrollment (default: the deployed relay)
#   BRIO_ENROLL_CODE     enrollment code from the Brio app
#   BRIO_AGENT_NAME      display name for this machine (default: Hermes)
#   BRIO_INSTALL_SERVICE install the hermes gateway service (default: true)
#   BRIO_START_SERVICE   start/restart the gateway service (default: true)
#   BRIO_HERMES_REPO     GitHub repo to install Hermes from
#                        (default: 0bkevin/hermes-agent — carries `hermes brio`)
set -eu

REPO="0bkevin/brio"
HERMES_REPO="${BRIO_HERMES_REPO:-0bkevin/hermes-agent}"
DEFAULT_RELAY_URL="https://brio-relay.xa95xa94cj2n4.us-east-1.cs.amazonlightsail.com"
RELAY_URL="${BRIO_RELAY_URL:-$DEFAULT_RELAY_URL}"
AGENT_NAME="${BRIO_AGENT_NAME:-Hermes}"
INSTALL_SERVICE="${BRIO_INSTALL_SERVICE:-true}"
START_SERVICE="${BRIO_START_SERVICE:-true}"

# ---- detect platform ----
os="$(uname -s)"
case "$os" in
  Linux)  ;;
  Darwin) ;;
  *) echo "Unsupported OS: $os (Windows: install Hermes from https://github.com/${HERMES_REPO}, then run: hermes brio enroll)" >&2; exit 1 ;;
esac

# ---- locate or install Hermes ----
HERMES_BIN="$(command -v hermes 2>/dev/null || true)"
if [ -z "$HERMES_BIN" ] && [ -x "$HOME/.local/bin/hermes" ]; then
  HERMES_BIN="$HOME/.local/bin/hermes"
fi

if [ -n "$HERMES_BIN" ]; then
  echo "Hermes found: ${HERMES_BIN}"
else
  echo "Installing Hermes Agent from ${HERMES_REPO}..."
  if ! curl -fsSL "https://raw.githubusercontent.com/${HERMES_REPO}/main/scripts/install.sh" | bash -s -- --skip-setup --skip-browser; then
    echo "INSTALL_HERMES_FAILED: could not install Hermes Agent" >&2
    exit 1
  fi
  HERMES_BIN="$(command -v hermes 2>/dev/null || true)"
  if [ -z "$HERMES_BIN" ] && [ -x "$HOME/.local/bin/hermes" ]; then
    HERMES_BIN="$HOME/.local/bin/hermes"
  fi
  if [ -z "$HERMES_BIN" ]; then
    echo "INSTALL_HERMES_FAILED: Hermes installed but the 'hermes' command was not found on PATH. Open a new shell and re-run this script with BRIO_ENROLL_CODE set to finish enrollment." >&2
    exit 1
  fi
fi

# ---- verify this Hermes build has the brio connector ----
if ! "$HERMES_BIN" brio --help >/dev/null 2>&1; then
  echo "INSTALL_HERMES_TOO_OLD: this Hermes build does not include 'hermes brio'." >&2
  echo "Update to the ${HERMES_REPO} build of Hermes and re-run this script." >&2
  exit 1
fi

if [ -z "${BRIO_ENROLL_CODE:-}" ]; then
  echo ""
  echo "Hermes is ready. Next — connect it from the Brio mobile app:"
  echo ""
  echo "  curl -fsSL https://github.com/${REPO}/raw/main/scripts/install.sh \\"
  echo "    | BRIO_RELAY_URL=\"${RELAY_URL}\" \\"
  echo "      BRIO_ENROLL_CODE=\"<CODE_FROM_THE_APP>\" \\"
  echo "      BRIO_AGENT_NAME=\"Hermes\" \\"
  echo "      sh"
  echo ""
  echo "Generate <CODE_FROM_THE_APP> in the Brio mobile app (Sign in → Generate enrollment code)."
  exit 0
fi

# ---- enroll with the relay ----
echo ""
echo "Enrolling this machine with the Brio relay..."
if ! "$HERMES_BIN" brio enroll \
  --relay-url "$RELAY_URL" \
  --code "$BRIO_ENROLL_CODE" \
  --name "$AGENT_NAME"; then
  echo "SETUP_FAILED: Brio enrollment did not complete." >&2
  exit 1
fi

# ---- install / restart the gateway service (it runs the relay tunnel) ----
if [ "$INSTALL_SERVICE" = "true" ]; then
  echo ""
  echo "Installing the Hermes gateway service..."
  "$HERMES_BIN" gateway install || echo "⚠️  gateway install failed; continuing (the gateway may already be installed)" >&2
fi

if [ "$START_SERVICE" = "true" ]; then
  echo ""
  echo "Starting the gateway (runs the API server and the Brio relay tunnel)..."
  if ! "$HERMES_BIN" gateway restart 2>/dev/null; then
    "$HERMES_BIN" gateway start || {
      echo "⚠️  Could not start the gateway service. Run: hermes gateway start" >&2
    }
  fi
fi

echo ""
echo "✅ Done. The agent should now appear in the Brio mobile app."
echo "   Check status any time with: hermes brio status"
