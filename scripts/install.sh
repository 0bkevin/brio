#!/bin/sh
# Brio connector installer.
#   curl -fsSL https://github.com/0bkevin/brio/releases/latest/download/install.sh | sh
#
# Optional env vars:
#   BRIO_INSTALL_DIR   install location (default: /usr/local/bin, falls back to ~/.local/bin)
#   BRIO_VERSION       release tag to install (default: latest)
#   BRIO_RELAY_URL     relay URL for automatic setup
#   BRIO_ENROLL_CODE   enrollment code from the Brio app
#   BRIO_AGENT_NAME    display name for this Hermes machine (default: Hermes)
#   BRIO_INSTALL_SERVICE install background service during setup (default: true)
#   BRIO_START_SERVICE start background service during setup (default: true)
#   BRIO_HERMES_URL    Hermes API URL (default: http://127.0.0.1:8642)
set -eu

REPO="0bkevin/brio"
RELAY_URL="${BRIO_RELAY_URL:-}"
VERSION="${BRIO_VERSION:-latest}"
HERMES_URL="${BRIO_HERMES_URL:-http://127.0.0.1:8642}"
AGENT_NAME="${BRIO_AGENT_NAME:-Hermes}"
INSTALL_SERVICE="${BRIO_INSTALL_SERVICE:-true}"
START_SERVICE="${BRIO_START_SERVICE:-true}"

# ---- detect platform ----
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux)  goos="linux" ;;
  Darwin) goos="darwin" ;;
  *) echo "Unsupported OS: $os (Windows: download brio-windows-amd64.exe from the releases page)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) goarch="amd64" ;;
  arm64|aarch64) goarch="arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac
asset="brio-${goos}-${goarch}"

# ---- resolve download URL ----
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
  checksums_url="https://github.com/${REPO}/releases/latest/download/checksums.txt"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
  checksums_url="https://github.com/${REPO}/releases/download/${VERSION}/checksums.txt"
fi

# ---- pick install dir ----
dir="${BRIO_INSTALL_DIR:-/usr/local/bin}"
if [ ! -d "$dir" ]; then
  mkdir -p "$dir" 2>/dev/null || true
fi
if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then
  if [ -w "$(dirname "$dir")" ] 2>/dev/null; then :; else
    dir="$HOME/.local/bin"
    mkdir -p "$dir"
  fi
fi

tmp="$(mktemp)"
checksums_tmp="$(mktemp)"
trap 'rm -f "$tmp" "$checksums_tmp"' EXIT HUP INT TERM
echo "Downloading ${asset} (${VERSION})..."
if ! curl -fsSL "$url" -o "$tmp"; then
  echo "INSTALL_DOWNLOAD_FAILED: could not download ${url}" >&2
  exit 1
fi

if curl -fsSL "$checksums_url" -o "$checksums_tmp"; then
  expected="$(awk -v asset="$asset" '$2 == asset || $2 == "dist/" asset || $2 == "*" asset { print $1; exit }' "$checksums_tmp")"
  if [ -z "$expected" ]; then
    echo "INSTALL_CHECKSUM_MISSING: ${asset} is not listed in checksums.txt" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp" | awk '{ print $1 }')"
  else
    actual="$(shasum -a 256 "$tmp" | awk '{ print $1 }')"
  fi
  if [ "$actual" != "$expected" ]; then
    echo "INSTALL_CHECKSUM_FAILED: checksum mismatch for ${asset}" >&2
    exit 1
  fi
  echo "Checksum verified."
else
  echo "⚠️  Release checksum is unavailable; continuing for compatibility with older Brio releases." >&2
fi
chmod +x "$tmp"

target="${dir}/brio"
if [ -w "$dir" ]; then
  mv "$tmp" "$target"
else
  echo "Elevating to write ${dir} (sudo)..."
  sudo mv "$tmp" "$target"
fi

echo ""
echo "✅ Installed: ${target}"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "⚠️  ${dir} is not on your PATH. Add it:  export PATH=\"${dir}:\$PATH\"" ;;
esac

if [ "${BRIO_ENROLL_CODE:-}" ]; then
  if [ -z "$RELAY_URL" ]; then
    echo "SETUP_RELAY_URL_REQUIRED: set BRIO_RELAY_URL to the relay that issued this enrollment code." >&2
    exit 1
  fi
  install_flag="--install"
  start_flag="--start"
  if [ "$INSTALL_SERVICE" = "false" ]; then
    install_flag="--install=false"
  fi
  if [ "$START_SERVICE" = "false" ]; then
    start_flag="--start=false"
  fi

  echo ""
  echo "Running Brio setup..."
  if ! "$target" setup \
    --relay-url "$RELAY_URL" \
    --code "$BRIO_ENROLL_CODE" \
    --name "$AGENT_NAME" \
    --hermes-url "$HERMES_URL" \
    "$install_flag" \
    "$start_flag"; then
    echo "SETUP_FAILED: Brio setup did not complete." >&2
    exit 1
  fi
  exit 0
fi

echo ""
echo "Next — connect this Hermes machine from the Brio mobile app:"
echo ""
echo "  curl -fsSL https://github.com/${REPO}/releases/latest/download/install.sh \\"
echo "    | BRIO_RELAY_URL=\"<RELAY_URL_FROM_THE_APP>\" \\"
echo "      BRIO_ENROLL_CODE=\"<CODE_FROM_THE_APP>\" \\"
echo "      BRIO_AGENT_NAME=\"Hermes\" \\"
echo "      sh"
echo ""
echo "Generate <CODE_FROM_THE_APP> in the Brio mobile app (Sign in → Generate enrollment code)."
echo "The setup command configures the Hermes API server, enrolls this machine, installs the background service, and starts it."
