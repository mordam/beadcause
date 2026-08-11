#!/usr/bin/env bash
#
# Remove the beadcause background service.
#
#   npm run uninstall-service
#
# Deliberately leaves ~/.config/beadcause alone: it holds your token, and deleting
# it would silently un-pair every phone you have set up. Remove it by hand if you
# actually want a clean slate.
#
set -euo pipefail

LABEL="m4m.beadcause"
LEGACY_LABELS=("com.neadamthal.beadcause" "com.beadcause" "n8l.beadcause")

# The monitor agent goes first: it is a child of this install, and leaving it loaded
# would open a window at every login for a daemon that is no longer there.
for label in "$LABEL.monitor" "$LABEL" "${LEGACY_LABELS[@]}"; do
  plist="$HOME/Library/LaunchAgents/$label.plist"
  # Here-string, not a pipe — see the same note in install.sh. Under `set -o pipefail` a
  # `… | grep -q` that *matches* can report 141 via SIGPIPE, and a false "not loaded"
  # here skips the bootout while the plist is deleted anyway: the daemon then runs on
  # until logout with nothing left on disk to explain it.
  if grep -qF -- "$label" <<<"$(launchctl list 2>/dev/null)"; then
    echo "==> stopping $label"
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  fi
  [ -f "$plist" ] && { echo "==> removing $plist"; rm -f "$plist"; }
done

echo "==> done. Config and token kept at ~/.config/beadcause (delete it by hand to fully reset)."
