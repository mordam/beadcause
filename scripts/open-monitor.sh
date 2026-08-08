#!/usr/bin/env bash
#
# Open the activity monitor in its own iTerm2 window.
#
# This exists because launchd cannot draw anything. A LaunchAgent runs headless
# with no session to attach to, so the only way to get a *visible* window at login
# is to ask an app that already has one to make it — which is exactly what
# `lib/session.js` does for the "open a Claude session" button, through the same
# scripts/open-session.applescript. Reusing it keeps one place where the iTerm
# bundle id, the argv-not-interpolation rule and the TCC failure mode are handled.
#
# Run by the m4m.beadcause.monitor LaunchAgent, which fires once at login and then
# exits — the window it opened outlives it.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${BEADCAUSE_NODE:-$(command -v node || echo /usr/bin/env node)}"

# `exec` so quitting the monitor with `q` closes the window rather than dropping
# you into a stray shell in the repo.
COMMAND="cd '$ROOT' && exec '$NODE' bin/monitor.js"

if out=$(/usr/bin/osascript "$ROOT/scripts/open-session.applescript" "$COMMAND" "beadcause monitor" 2>&1); then
  echo "[beadcause] monitor window opened"
  exit 0
fi

# -1743 is macOS refusing the Apple event. Under launchd there may be no one to
# show the consent prompt to, so say what to click rather than exiting silently.
if printf '%s' "$out" | grep -qiE -- '-1743|not authori[sz]ed'; then
  echo "[beadcause] macOS blocked beadcause from controlling iTerm — approve it in" >&2
  echo "            System Settings → Privacy & Security → Automation, then run:" >&2
  echo "            launchctl kickstart -k gui/\$(id -u)/m4m.beadcause.monitor" >&2
  exit 1
fi

echo "[beadcause] could not open the monitor window: $out" >&2
exit 1
