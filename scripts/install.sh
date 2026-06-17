#!/bin/sh
# Brio companion installer.
#   curl -fsSL https://github.com/0bkevin/brio/releases/latest/download/install.sh | sh
#
# Optional env vars:
#   BRIO_INSTALL_DIR   install location (default: /usr/local/bin, falls back to ~/.local/bin)
#   BRIO_VERSION       release tag to install (default: latest)
set -eu

REPO="0bkevin/brio"
RELAY_URL="https://brio-relay.xa95xa94cj2n4.us-east-1.cs.amazonlightsail.com"
VERSION="${BRIO_VERSION:-latest}"

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
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

# ---- pick install dir ----
dir="${BRIO_INSTALL_DIR:-/usr/local/bin}"
if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then
  if [ -w "$(dirname "$dir")" ] 2>/dev/null; then :; else
    dir="$HOME/.local/bin"
    mkdir -p "$dir"
  fi
fi

tmp="$(mktemp)"
echo "Downloading ${asset} (${VERSION})..."
curl -fsSL "$url" -o "$tmp"
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

echo ""
echo "Next — enroll this machine with the Brio relay (Hermes must be running at 127.0.0.1:8642):"
echo ""
echo "  brio companion enroll \\"
echo "    --relay-url ${RELAY_URL} \\"
echo "    --code <CODE_FROM_THE_APP> \\"
echo "    --run"
echo ""
echo "Generate <CODE_FROM_THE_APP> in the Brio mobile app (Sign in → Generate enrollment code)."
echo "To keep it running across reboots, use 'brio companion install' instead of --run."
