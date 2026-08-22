#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/fake-bin" "$tmp/home/.local/bin"

# Fake hermes: records invocations, accepts every subcommand.
cat > "$tmp/fake-bin/hermes" <<'EOF'
#!/bin/sh
echo "$@" >> "$HERMES_LOG"
case "$1" in
  brio) [ "$2" = "--help" ] || [ "$2" = "enroll" ] ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$tmp/fake-bin/hermes"

# --- test 1: no enrollment code -> prints next steps, never enrolls ---
HERMES_LOG="$tmp/log1"; export HERMES_LOG; : > "$HERMES_LOG"
out1="$tmp/out1"
PATH="$tmp/fake-bin:$PATH" HOME="$tmp/home" \
  BRIO_RELAY_URL="http://relay.test" \
  sh "$root/scripts/install.sh" > "$out1" 2>&1
grep -q 'Hermes found' "$out1"
grep -q 'CODE_FROM_THE_APP' "$out1"
! grep -q 'enroll' "$HERMES_LOG"

# --- test 2: enrollment code -> enroll + gateway install + restart ---
HERMES_LOG="$tmp/log2"; : > "$HERMES_LOG"
out2="$tmp/out2"
PATH="$tmp/fake-bin:$PATH" HOME="$tmp/home" \
  BRIO_RELAY_URL="http://relay.test" \
  BRIO_ENROLL_CODE="ABCD1234" \
  BRIO_AGENT_NAME="Laptop" \
  sh "$root/scripts/install.sh" > "$out2" 2>&1
grep -q -- '--relay-url http://relay.test --code ABCD1234 --name Laptop' "$HERMES_LOG"
grep -q 'gateway install' "$HERMES_LOG"
grep -q 'gateway restart' "$HERMES_LOG"
grep -q 'Done. The agent should now appear' "$out2"

# --- test 3: service flags off -> no gateway calls ---
HERMES_LOG="$tmp/log3"; : > "$HERMES_LOG"
PATH="$tmp/fake-bin:$PATH" HOME="$tmp/home" \
  BRIO_ENROLL_CODE="ABCD1234" \
  BRIO_INSTALL_SERVICE="false" \
  BRIO_START_SERVICE="false" \
  sh "$root/scripts/install.sh" > "$tmp/out3" 2>&1
grep -q 'enroll' "$HERMES_LOG"
! grep -q 'gateway' "$HERMES_LOG"

# --- test 4: hermes without the brio subcommand -> clear error, exit 1 ---
mkdir -p "$tmp/old-bin"
printf '#!/bin/sh\nexit 1\n' > "$tmp/old-bin/hermes"
chmod +x "$tmp/old-bin/hermes"
PATH="$tmp/old-bin:$PATH" HOME="$tmp/home" \
  BRIO_ENROLL_CODE="ABCD1234" \
  sh "$root/scripts/install.sh" > "$tmp/out4" 2>&1 && rc=0 || rc=$?
[ "$rc" -eq 1 ]
grep -q 'INSTALL_HERMES_TOO_OLD' "$tmp/out4"

# --- test 5: hermes missing -> installs from the fork, then enrolls ---
# Fake curl is reachable on PATH but hermes is not, until curl "installs" it.
mkdir -p "$tmp/curl-bin"
cat > "$tmp/curl-bin/curl" <<EOF
#!/bin/sh
while [ "\$#" -gt 0 ]; do
  case "\$1" in http*) url="\$1" ;; esac
  shift
done
case "\$url" in
  *hermes-agent*)
    printf '#!/bin/sh\\nmkdir -p "\$HOME/.local/bin"\\ncp "\$HERMES_SRC" "\$HOME/.local/bin/hermes" && chmod +x "\$HOME/.local/bin/hermes"\\n'
    ;;
  *) cat ;;
esac
EOF
chmod +x "$tmp/curl-bin/curl"
HERMES_LOG="$tmp/log5"; : > "$HERMES_LOG"
HERMES_SRC="$tmp/fake-bin/hermes"; export HERMES_SRC
out5="$tmp/out5"
PATH="$tmp/curl-bin:/usr/bin:/bin" HOME="$tmp/home" \
  BRIO_RELAY_URL="http://relay.test" \
  BRIO_ENROLL_CODE="WXYZ7890" \
  sh "$root/scripts/install.sh" > "$out5" 2>&1
test -x "$tmp/home/.local/bin/hermes"
grep -q 'Installing Hermes Agent' "$out5"
grep -q -- '--code WXYZ7890' "$HERMES_LOG"

echo "install_test: all 5 tests passed"
