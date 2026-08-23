#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/fake-bin" "$tmp/home"

# Fake uname: Darwin on arm64.
printf '%s\n' '#!/bin/sh' 'if [ "$1" = "-s" ]; then echo Darwin; else echo arm64; fi' > "$tmp/fake-bin/uname"

# Fake brio binary: records its invocation and succeeds.
cat > "$tmp/fake-brio" <<'EOF'
#!/bin/sh
echo "$@" >> "$BRIO_SETUP_LOG"
exit 0
EOF

# Fake curl: serves the fake binary and checksums from the environment.
cat > "$tmp/fake-bin/curl" <<'EOF'
#!/bin/sh
url=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */checksums.txt) printf "%s  brio-darwin-arm64\n" "$FAKE_CHECKSUM" > "$output" ;;
  *) cat "$FAKE_BRIO" > "$output" ;;
esac
EOF
chmod +x "$tmp/fake-bin/uname" "$tmp/fake-bin/curl"

FAKE_BRIO="$tmp/fake-brio"; export FAKE_BRIO
GOOD_CHECKSUM="$(shasum -a 256 "$FAKE_BRIO" | awk '{ print $1 }')"

# --- test 1: download + checksum verified + setup invoked with the right flags ---
FAKE_CHECKSUM="$GOOD_CHECKSUM"; export FAKE_CHECKSUM
BRIO_SETUP_LOG="$tmp/log1"; export BRIO_SETUP_LOG; : > "$BRIO_SETUP_LOG"
out1="$tmp/out1"
PATH="$tmp/fake-bin:$PATH" HOME="$tmp/home" \
  BRIO_INSTALL_DIR="$tmp/new/bin" \
  BRIO_VERSION="vtest" \
  BRIO_RELAY_URL="http://relay.test" \
  BRIO_ENROLL_CODE="ABCD1234" \
  BRIO_AGENT_NAME="Laptop" \
  sh "$root/scripts/install.sh" > "$out1" 2>&1
test -x "$tmp/new/bin/brio"
grep -q 'Checksum verified.' "$out1"
grep -q -- '--relay-url http://relay.test --code ABCD1234 --name Laptop --hermes-url http://127.0.0.1:8642 --install --start' "$BRIO_SETUP_LOG"

# --- test 2: service flags off -> setup runs with both flags disabled ---
BRIO_SETUP_LOG="$tmp/log2"; : > "$BRIO_SETUP_LOG"
out2="$tmp/out2"
PATH="$tmp/fake-bin:$PATH" HOME="$tmp/home" \
  BRIO_INSTALL_DIR="$tmp/new2/bin" \
  BRIO_VERSION="vtest" \
  BRIO_RELAY_URL="http://relay.test" \
  BRIO_ENROLL_CODE="ABCD1234" \
  BRIO_INSTALL_SERVICE="false" \
  BRIO_START_SERVICE="false" \
  sh "$root/scripts/install.sh" > "$out2" 2>&1
test -x "$tmp/new2/bin/brio"
grep -q -- '--install=false --start=false' "$BRIO_SETUP_LOG"
! grep -q -- '--install --start' "$BRIO_SETUP_LOG"

# --- test 3: bad checksum -> clear failure, nothing installed, no setup ---
FAKE_CHECKSUM="0000000000000000000000000000000000000000000000000000000000000000"; export FAKE_CHECKSUM
BRIO_SETUP_LOG="$tmp/log3"; : > "$BRIO_SETUP_LOG"
out3="$tmp/out3"
PATH="$tmp/fake-bin:$PATH" HOME="$tmp/home" \
  BRIO_INSTALL_DIR="$tmp/new3/bin" \
  BRIO_VERSION="vtest" \
  BRIO_ENROLL_CODE="ABCD1234" \
  sh "$root/scripts/install.sh" > "$out3" 2>&1 && rc=0 || rc=$?
[ "$rc" -eq 1 ]
grep -q 'INSTALL_CHECKSUM_FAILED' "$out3"
[ ! -e "$tmp/new3/bin/brio" ]
[ ! -s "$BRIO_SETUP_LOG" ]

# --- test 4: no enrollment code -> binary installed, setup never invoked ---
FAKE_CHECKSUM="$GOOD_CHECKSUM"; export FAKE_CHECKSUM
BRIO_SETUP_LOG="$tmp/log4"; : > "$BRIO_SETUP_LOG"
out4="$tmp/out4"
PATH="$tmp/fake-bin:$PATH" HOME="$tmp/home" \
  BRIO_INSTALL_DIR="$tmp/new4/bin" \
  BRIO_VERSION="vtest" \
  sh "$root/scripts/install.sh" > "$out4" 2>&1
test -x "$tmp/new4/bin/brio"
grep -q 'RELAY_URL_FROM_THE_APP' "$out4"
[ ! -s "$BRIO_SETUP_LOG" ]

# --- test 5: an enrollment code cannot silently use a stale built-in relay ---
BRIO_SETUP_LOG="$tmp/log5"; : > "$BRIO_SETUP_LOG"
out5="$tmp/out5"
PATH="$tmp/fake-bin:$PATH" HOME="$tmp/home" \
  BRIO_INSTALL_DIR="$tmp/new5/bin" \
  BRIO_VERSION="vtest" \
  BRIO_ENROLL_CODE="ABCD1234" \
  sh "$root/scripts/install.sh" > "$out5" 2>&1 && rc=0 || rc=$?
[ "$rc" -eq 1 ]
grep -q 'SETUP_RELAY_URL_REQUIRED' "$out5"
[ ! -s "$BRIO_SETUP_LOG" ]

echo "install_test: all 5 tests passed"
