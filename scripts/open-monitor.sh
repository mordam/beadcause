#!/usr/bin/env bash
#
# Open the advocate console at login.
#
# This used to ask iTerm2 to draw bin/monitor.js, because launchd cannot draw
# anything: a LaunchAgent runs headless with no session to attach to, so the only way
# to get a *visible* window is to ask an app that already has one to make it. That is
# still true — the app asked is just a browser now.
#
# The console it opens is public/monitor.js at /monitor, which shows the whole of
# `advocates.snapshot()` per repo: what each advocate is working on, what it will pick
# up next, the survey agent's live transcript, the beads it wants to file, and what
# its finished sessions archived to a git ref. bin/monitor.js showed one line of that
# per advocate and is kept as `npm run monitor` for when you are already in a
# terminal — but nothing opens it automatically any more, so the two cannot drift
# into two consoles that disagree.
#
# The token rides in the URL on purpose. This window is opened by launchd in whatever
# browser profile is default, which may never have been paired — the phone scanned
# the QR, this Mac window did not. public/monitor.js stores it and strips it from the
# address bar on the first paint, so it does not linger in history.
#
# Run by the m4m.beadcause.monitor LaunchAgent, which fires once at login and then
# exits — the window it opened outlives it.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${BEADCAUSE_NODE:-$(command -v node || echo /usr/bin/env node)}"
CONFIG="${BEADCAUSE_CONFIG_DIR:-$HOME/.config/beadcause}/config.json"

if [[ ! -r "$CONFIG" ]]; then
  echo "[beadcause] no config at $CONFIG — run scripts/install.sh first" >&2
  exit 1
fi

# Read with node rather than jq: node is already a hard dependency and jq is not, and
# a login-time script that fails for want of a formatter is a bad trade.
read -r URL TOKEN < <("$NODE" -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  // 127.0.0.1 rather than the Tailscale address in baseUrl: this window is on the
  // Mac serving it, and the loopback address works before the network is up.
  process.stdout.write(`http://127.0.0.1:${c.port || 4318}/monitor ${c.token || ""}\n`);
' "$CONFIG")

TARGET="$URL"
[[ -n "$TOKEN" ]] && TARGET="$URL?t=$TOKEN"

# Wait for the daemon. Both agents are RunAtLoad, so at login this one can easily win
# the race and open a window on a connection refused. Ten tries at half a second is
# well inside how long a browser takes to come up anyway.
for _ in $(seq 1 10); do
  if /usr/bin/curl -fsS -o /dev/null --max-time 1 "$URL"; then break; fi
  sleep 0.5
done

# `open -n` would start a second copy of the browser; plain `open` reuses the running
# one and adds a window, which is what you want at login. BEADCAUSE_BROWSER picks a
# specific app — "Google Chrome", "Safari" — and unset means the default handler.
if [[ -n "${BEADCAUSE_BROWSER:-}" ]]; then
  if out=$(/usr/bin/open -a "$BEADCAUSE_BROWSER" "$TARGET" 2>&1); then
    echo "[beadcause] advocate console opened in $BEADCAUSE_BROWSER"
    exit 0
  fi
elif out=$(/usr/bin/open "$TARGET" 2>&1); then
  echo "[beadcause] advocate console opened at $URL"
  exit 0
fi

echo "[beadcause] could not open the advocate console: ${out:-unknown error}" >&2
echo "            open it by hand: $URL" >&2
exit 1
