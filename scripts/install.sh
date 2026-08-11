#!/bin/sh
# Brio companion installer.
#   curl -fsSL https://github.com/0bkevin/brio/releases/latest/download/install.sh | sh
#
# Optional env vars:
#   BRIO_INSTALL_DIR   install location (default: /usr/local/bin, falls back to ~/.local/bin)
#   BRIO_VERSION       release tag to install (default: latest)
set -eu

REPO="0bkevin/brio"
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
echo "Next — start Brio Companion (Hermes must be running at 127.0.0.1:8642):"
echo ""
echo "  brio companion install"
echo "  brio companion pair"
echo ""
echo "Scan the QR code from the Brio mobile app."
echo "For Tailscale or optional development Relay setup, see the project README."
