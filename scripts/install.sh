#!/usr/bin/env bash
#
# Install beadcause as a login-time background service on macOS.
#
#   npm run install-service
#   npm run install-service -- --non-interactive    # ask nothing; keep the answers on file
#
# Everything machine-specific is discovered here rather than committed: the plist is
# generated with *this* user's home, node binary and checkout path. A checked-in
# plist cannot work on a second machine — node alone moves between
# /opt/homebrew/bin, /usr/local/bin and a dozen nvm paths.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="m4m.beadcause"
USER_ID="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# A second agent, opt-in, that opens the advocate console in a browser window at
# login. Separate from the daemon on purpose: the daemon must come up headless and
# stay up, whereas this fires once, opens a window and exits.
MONITOR_LABEL="$LABEL.monitor"
MONITOR_PLIST="$HOME/Library/LaunchAgents/$MONITOR_LABEL.plist"
LOG="$HOME/Library/Logs/beadcause.log"
LEGACY_LABELS=("com.neadamthal.beadcause" "com.beadcause" "n8l.beadcause")

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }

# Scratch space for the plist being replaced and for the bootstrap probe below.
# Removed however this exits, including the die()s.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/beadcause-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# -------------------------------------------------------------------- arguments

usage() {
  cat <<USAGE
Install beadcause as a launchd agent (macOS).

  npm run install-service                        ask the setup questions
  npm run install-service -- --non-interactive   ask nothing, keep the answers on file
  bash scripts/install.sh --non-interactive

  -n, --non-interactive  do not run scripts/configure.js. What is already in
                         ~/.config/beadcause/config.json is printed and left alone;
                         change it later with 'npm run configure' in a terminal.
      --interactive      ask even when the environment looks unattended.
  -h, --help             this.

SKIP_CONFIGURE=1 in the environment means the same as --non-interactive, and an
agent or CI environment (CLAUDECODE, AI_AGENT, CI) implies it — see the note above
the configure step for why an agent session must not be asked questions.
USAGE
}

NON_INTERACTIVE=0
FORCE_INTERACTIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--non-interactive) NON_INTERACTIVE=1 ;;
    --interactive)        FORCE_INTERACTIVE=1 ;;
    -h|--help)            usage; exit 0 ;;
    *)                    usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

# ---------------------------------------------------------------- prerequisites

[ "$(uname -s)" = "Darwin" ] || die "this installer is macOS-only (it uses launchd)."

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found. Install Node 20+ (brew install node) and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node $NODE_MAJOR is too old; beadcause needs 20+."

# launchd starts with a bare PATH, so `bd` has to be found by absolute path or live
# somewhere the plist's PATH covers. Fail now rather than at the first poll.
BD="$(command -v bd || true)"
[ -n "$BD" ] || die "the beads CLI (bd) is not on your PATH. Install it first — beadcause is a front-end for it."

# Said as a warning rather than a failure, because the tracker step below may be about to
# create one — a second engineer's Mac has no ~/beads at all, and on that machine this is
# a note about what is coming rather than a problem with the install.
if [ ! -d "$HOME/beads" ]; then
  if [ -f "$ROOT/team.json" ]; then
    say "no ~/beads yet — the team's tracker is named in team.json and comes next"
  else
    warn "no ~/beads directory: beadcause serves every ~/beads/*/.beads workspace and will find none."
    warn "make one (bd init in ~/beads/<name>), or name the team's tracker in team.json — see"
    warn "\"Onboarding a second engineer\" in the README."
  fi
fi

command -v tailscale >/dev/null 2>&1 || \
  warn "tailscale not found. beadcause binds to 127.0.0.1 and your Tailscale IP; without it, only this Mac can reach it."

# ------------------------------------------------------------------- dependencies

say "installing dependencies"
( cd "$ROOT" && npm install --silent )

# ------------------------------------------------------------- the team's tracker

# Before the questions, deliberately: a second engineer's Mac has no workspace at all, so
# `discoverWorkspaces()` finds nothing, `configure.js` prints "No beads workspaces found"
# and exits, and the daemon comes up serving an empty inbox with nothing wrong with it.
# This is what puts the tracker there — from `team.json`, which is committed so that six
# engineers get one answer rather than six — and it needs node_modules, so it runs after
# the install above and not with the other prerequisites.
#
# With no team.json it prints one line and does nothing, which is every solo install.
#
# The exit code is read rather than ignored, and 1 is fatal. `1` means a *decision* is
# needed — most often a private tracker sitting where the team's goes, which `bd bootstrap`
# will not clone over, so the first sync would ask Dolt to merge two unrelated histories
# and conflict on every tick from then on. Better to stop here, where nothing has been
# booted out and the running service is untouched, than to hand somebody that. `2` is a
# step that failed and may work next time — no network, ssh locked — and the daemon's own
# sync banner keeps saying so, so the install carries on.
ONBOARD_RC=0
( cd "$ROOT" && node scripts/onboard.mjs --yes ) || ONBOARD_RC=$?
if [ "$ONBOARD_RC" = 1 ]; then
  warn "the service was left exactly as it was; nothing has been loaded or unloaded."
  die "the team's tracker needs a decision first — see above, then re-run this."
elif [ "$ONBOARD_RC" != 0 ]; then
  warn "the team's tracker is not set up yet (npm run onboard, exit $ONBOARD_RC) — carrying on."
fi

# ------------------------------------------------------------------- configure

# Writes ~/.config/beadcause/config.json on first run, then asks the few things that
# cannot be guessed. Fed from /dev/tty rather than stdin because `npm run` pipes stdin,
# and an installer that silently skipped its own questions was the original bug.
#
# But /dev/tty is *the controlling terminal*, which is not the same thing as a human
# who is paying attention. In an agent session it belongs to the agent: the questions
# are asked of nobody, no prompt is visible anywhere, and the install hangs on the
# first one for as long as you let it. The escape people reached for — drop the
# controlling terminal (setsid) so /dev/tty fails and this step warns and carries on —
# also leaves the GUI session, and `launchctl bootstrap gui/<uid>` then fails *after*
# the bootout, leaving the daemon unloaded. Two workarounds cancelling each other out.
#
# So say it in a flag instead, and recognise the obvious cases without being asked.
SKIP_CONFIGURE_WHY=""
if [ "$NON_INTERACTIVE" = 1 ]; then
  SKIP_CONFIGURE_WHY="--non-interactive"
elif [ -n "${SKIP_CONFIGURE:-}" ]; then
  SKIP_CONFIGURE_WHY="SKIP_CONFIGURE=$SKIP_CONFIGURE"
elif [ -n "${CLAUDECODE:-}" ] || [ -n "${AI_AGENT:-}" ]; then
  SKIP_CONFIGURE_WHY="this is an agent session, and nobody would see the questions"
elif [ -n "${CI:-}" ]; then
  SKIP_CONFIGURE_WHY="CI=$CI"
fi
if [ "$FORCE_INTERACTIVE" = 1 ]; then SKIP_CONFIGURE_WHY=""; fi

if [ -n "$SKIP_CONFIGURE_WHY" ]; then
  say "not asking the setup questions ($SKIP_CONFIGURE_WHY)"
  # Fed /dev/null deliberately: with no TTY configure.js prints what is currently
  # configured and changes nothing, which is the useful half of it when nobody can
  # answer. Everything below reads the same config either way.
  ( cd "$ROOT" && node scripts/configure.js < /dev/null ) || \
    warn "could not read the current configuration — carrying on with the defaults."
else
  ( cd "$ROOT" && node scripts/configure.js < /dev/tty ) || \
    warn "configuration skipped — run 'npm run configure' later to set it up."
fi

# ------------------------------------------------------------ migrate old install

# Labels this service has been known by. Leaving an old one loaded would leave two
# daemons fighting over port 4318 — the loser exits, but which one loses is a race.
for legacy in "${LEGACY_LABELS[@]}"; do
  legacy_plist="$HOME/Library/LaunchAgents/$legacy.plist"
  # Here-string, not a pipe: `set -o pipefail` above turns `… | grep -q` into a trap.
  # grep exits at its first match, the writer takes SIGPIPE while it is still writing,
  # and the pipeline reports 141 — so a match reads as "not found". `-F` because a label
  # is a literal and its dots are not wildcards.
  if grep -qF -- "$legacy" <<<"$(launchctl list 2>/dev/null)" || [ -f "$legacy_plist" ]; then
    say "removing the previous $legacy service (now $LABEL)"
    launchctl bootout "gui/$USER_ID/$legacy" 2>/dev/null || true
    rm -f "$legacy_plist"
  fi
done

# ------------------------------------------------------------------ monitor flag

# Asked by configure.js. Read after it runs so the answer takes effect immediately.
MONITOR_ENABLED="$(cd "$ROOT" && node -e '
  import("./lib/config.js")
    .then((m) => process.stdout.write(m.loadConfig().monitor?.enabled ? "1" : "0"))
    .catch(() => process.stdout.write("0"));
' 2>/dev/null || echo 0)"

# --------------------------------------------------------------------- the plist

say "writing $PLIST"
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"

# Keep the plist that is loaded right now. If the new one will not bootstrap, the label
# has to end up loaded again rather than left empty — and that needs the file it was
# loaded from, which is about to be overwritten.
PREV_PLIST=""
if [ -f "$PLIST" ]; then
  PREV_PLIST="$WORK/previous.plist"
  cp "$PLIST" "$PREV_PLIST"
fi

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by scripts/install.sh. Re-run it rather than editing by hand. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <!-- The router, not the server. It owns the port and supervises a backend on an
       internal one, so an edit to lib/ is picked up by swapping the backend rather
       than by you remembering to restart. See bin/router.js. -->
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/bin/router.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$ROOT</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>

  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd starts with a bare PATH; bd, tailscale and node may all be
         outside it. This covers Homebrew on both architectures plus the node
         found at install time. -->
    <key>PATH</key>
    <string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

# --------------------------------------------------------------------- load it

# Can this shell load a job into the GUI domain at all? Answered by loading one that
# does nothing and unloading it again, rather than by finding out halfway through.
#
# `launchctl bootstrap gui/<uid>` fails with `Bootstrap failed: 5: Input/output error`
# for a process that has left the GUI session — one that called setsid, a launchd job of
# its own, ssh with no console. Replacing a running job means booting it out first, so
# by the time that error arrives the daemon is already gone: the port dead, the
# readiness wait below dying, and every step after it skipped, on the one path whose
# entire job is to have no outage. It cost a real one. Asking first costs a few
# milliseconds.
#
# The probe job never runs anything — RunAtLoad false, no KeepAlive, and /usr/bin/true
# if it somehow were started — and its plist lives in $WORK, so nothing is left on disk.
# If the bootout of it ever failed, what remains is an idle label that owns nothing,
# until the next logout.
can_bootstrap() {
  local probe="$LABEL.bootstrap-probe.$$"
  local plist="$WORK/$probe.plist"
  cat > "$plist" <<PROBE_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$probe</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/true</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PROBE_EOF
  if launchctl bootstrap "gui/$USER_ID" "$plist" 2>/dev/null; then
    launchctl bootout "gui/$USER_ID/$probe" 2>/dev/null || true
    return 0
  fi
  return 1
}

say "loading the service"

if ! can_bootstrap; then
  # Nothing has been booted out yet, so whatever was loaded still is. It is running the
  # code it was loaded with rather than what is in $ROOT, which is worse than the new
  # code and enormously better than nothing at all.
  warn "this shell cannot load launchd jobs into gui/$USER_ID, so the service was left"
  warn "exactly as it was instead of being booted out into nothing."
  if curl -fsS -m 2 http://127.0.0.1:4318/api/health >/dev/null 2>&1; then
    warn "what is loaded is still up and answering on 4318 — on the code it was loaded"
    warn "with, which after an edit to bin/ is not what is in $ROOT."
  fi
  warn "$PLIST has been rewritten but never reloaded, so the file and the job launchd is"
  warn "holding disagree. Finish it from a Terminal window you are logged in to:"
  warn "  launchctl bootout gui/$USER_ID/$LABEL"
  warn "  launchctl bootstrap gui/$USER_ID $PLIST"
  warn "  launchctl kickstart -k gui/$USER_ID/$LABEL"
  die "not loaded. This is what a process with no GUI session gets; it is not your plist."
fi

launchctl bootout "gui/$USER_ID/$LABEL" 2>/dev/null || true

if ! launchctl bootstrap "gui/$USER_ID" "$PLIST"; then
  # The probe has just proved the domain accepts jobs, so this is about *this* plist.
  # Either way the label is booted out and nothing is running — the state this whole
  # section exists to avoid — so put back what was there and say what happened.
  warn "launchctl refused $PLIST."
  mv "$PLIST" "$PLIST.rejected"
  warn "kept as $PLIST.rejected, so it can be diffed against one that works."
  if [ -n "$PREV_PLIST" ]; then
    cp "$PREV_PLIST" "$PLIST"
    if launchctl bootstrap "gui/$USER_ID" "$PLIST"; then
      launchctl kickstart -k "gui/$USER_ID/$LABEL" 2>/dev/null || true
      warn "the plist that was installed before is back in place and loaded again: the"
      warn "service is running what it was running before this script started."
    else
      warn "the previous plist would not load either — NOTHING IS LOADED under $LABEL."
      warn "the service is down. From a Terminal window you are logged in to:"
      warn "  launchctl bootstrap gui/$USER_ID $PLIST"
    fi
  else
    warn "there was no plist here before, so there is nothing to fall back to: $LABEL is"
    warn "not loaded, and it was not loaded when this started either."
  fi
  die "bootstrap failed — see above."
fi

launchctl kickstart -k "gui/$USER_ID/$LABEL" 2>/dev/null || \
  warn "kickstart failed; RunAtLoad should have started it anyway — the wait below decides."

# Give it a moment to bind before we claim it works.
for _ in $(seq 1 20); do
  sleep 0.5
  if curl -fsS -m 2 http://127.0.0.1:4318/api/health >/dev/null 2>&1; then READY=1; break; fi
done

if [ "${READY:-}" != "1" ]; then
  die "the service did not come up. Check $LOG"
fi

WORKSPACES="$(curl -fsS -m 5 http://127.0.0.1:4318/api/health | sed 's/.*"workspaces":\[//;s/\].*//')"
say "running — workspaces: ${WORKSPACES:-none}"

# Prove what got loaded, rather than assume the heredoc above is what launchd is
# holding. It went wrong exactly this way once: a plist written before bin/router.js
# existed stayed loaded for weeks, every kickstart restarted bin/beadcause.js, and the
# port answered perfectly the whole time — so nothing anyone could see was broken.
# launchd keeps the arguments it bootstrapped with, so this reads them back from it
# and not from the file.
# `sed -n 1p` rather than `head -1`: head stops reading as soon as it has its line, and
# under `set -o pipefail` the SIGPIPE that sends back up the pipe fails the whole
# substitution. It happens to be harmless here — the `|| true` swallows it and the value
# was already captured — but it is the same construct that inverted the attic sweep in
# bc-bcdp, and one that only reads correctly by accident is not worth keeping. sed reads
# to EOF; `launchctl print` is a few hundred lines.
LOADED="$(launchctl print "gui/$USER_ID/$LABEL" 2>/dev/null | grep -oE '[^[:space:]]+/bin/[A-Za-z0-9._-]+\.js' | sed -n 1p || true)"
if [ "$LOADED" = "$ROOT/bin/router.js" ]; then
  say "launchd is running bin/router.js — editing lib/ swaps under the port, no restart"
elif [ -n "$LOADED" ]; then
  warn "launchd is running $LOADED, not $ROOT/bin/router.js"
  warn "the hot-swap is NOT live — edits to lib/ will need a restart. Re-run this script."
else
  warn "could not read back what launchd loaded for $LABEL; check with:"
  warn "  launchctl print gui/$USER_ID/$LABEL | grep -A3 arguments"
fi

# ------------------------------------------------------------- the monitor agent

# Always tear the old one down first, so answering "no" in configure actually
# removes the window rather than leaving a stale agent loaded from last time.
launchctl bootout "gui/$USER_ID/$MONITOR_LABEL" 2>/dev/null || true
rm -f "$MONITOR_PLIST"

if [ "$MONITOR_ENABLED" = "1" ]; then
  say "writing $MONITOR_PLIST"
  cat > "$MONITOR_PLIST" <<MONITOR_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by scripts/install.sh. Re-run it rather than editing by hand. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$MONITOR_LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/open-monitor.sh</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$ROOT</string>

  <!-- Fires once at login, opens a window and exits. KeepAlive would relaunch it
       the moment it finished and open a new window every few seconds. -->
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>

  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <!-- open-monitor.sh reads the port and token out of config.json with node,
         and a login-time PATH may not have the one this was installed with. Pin it. -->
    <key>BEADCAUSE_NODE</key>
    <string>$NODE</string>
  </dict>
</dict>
</plist>
MONITOR_EOF

  # RunAtLoad means bootstrap opens the window straight away, which is also the
  # only honest way to prove the whole path works — daemon up, token readable,
  # browser willing.
  #
  # A failure here is not a failure of the install: the daemon is loaded and answering
  # by this point, and this is a window. Warning rather than exiting is also what keeps
  # the pairing QR below from being skipped over a browser that would not open.
  if launchctl bootstrap "gui/$USER_ID" "$MONITOR_PLIST"; then
    say "the advocate console opens at login (and just opened) — http://127.0.0.1:4318/monitor"
  else
    warn "the console agent would not load; the daemon itself is unaffected."
    warn "open http://127.0.0.1:4318/monitor yourself, or 'npm run monitor' in a terminal."
  fi
else
  say "console not opened at login — visit /monitor when you want it"
fi

echo
say "pair your phone (needs Tailscale on both devices):"
( cd "$ROOT" && node bin/beadcause.js --qr ) || true

cat <<NEXT

Useful from here:
  tail -f $LOG
  open http://127.0.0.1:4318/monitor             # the advocate console
  npm run monitor                                # the same thing in a terminal, roughly
  npm run swap:status                            # which build is actually answering
  npm run swap                                   # swap now, without waiting
  launchctl kickstart -k gui/$USER_ID/$LABEL     # only needed for bin/router.js itself

Editing lib/ no longer needs a restart: the router notices within a few seconds and
swaps the backend under the port, draining the old one. The exception is
bin/router.js, which cannot replace itself — it says so in the log when it changes.

  npm run uninstall-service                      # remove it again
  npm run install-service -- --non-interactive   # re-run this without the questions
  npm run onboard -- --dry-run                   # is this Mac pointed at the team's tracker?

Config (token, ntfy topic, workspaces) lives in ~/.config/beadcause/config.json. What is
shared with the rest of the team — which trackers, and the policy that has to match on
every Mac — lives in team.json in this checkout.
NEXT
