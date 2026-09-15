#!/usr/bin/env bash
#
# Install beadcause as a login-time background service on macOS.
#
#   npm run install-service
#   npm run install-service -- --non-interactive    # ask nothing; keep the answers on file
#   npm run install-service -- --no-deps            # install nothing with brew; only check
#   npm run install-service -- --phone              # reach it from a phone, over Tailscale
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
                         With --phone, Tailscale is not installed either: its
                         installer asks for an admin password.
      --interactive      ask even when the environment looks unattended.
      --phone            turn on phone support: install Tailscale if it is missing,
                         listen on this Mac's tailnet address as well as 127.0.0.1,
                         and print the pairing QR. Without it beadcause answers on
                         this Mac only — run this again with --phone any time.
      --no-deps          install nothing. Node, bd, gh, jq, iTerm2, Claude Code (and
                         Tailscale, with --phone) are still checked for and what is
                         missing is named, but brew is never run.
  -h, --help             this.

SKIP_CONFIGURE=1 in the environment means the same as --non-interactive, and an
agent or CI environment (CLAUDECODE, AI_AGENT, CI) implies it — see the note where
UNATTENDED_WHY is decided for why an agent session must not be asked questions.
BEADCAUSE_NO_DEPS=1 means the same as --no-deps, and BEADCAUSE_PHONE=1 as --phone.
USAGE
}

NON_INTERACTIVE=0
FORCE_INTERACTIVE=0
INSTALL_DEPS=1
[ -z "${BEADCAUSE_NO_DEPS:-}" ] || INSTALL_DEPS=0
PHONE=0
[ -z "${BEADCAUSE_PHONE:-}" ] || PHONE=1
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--non-interactive) NON_INTERACTIVE=1 ;;
    --interactive)        FORCE_INTERACTIVE=1 ;;
    --no-deps)            INSTALL_DEPS=0 ;;
    --phone)              PHONE=1 ;;
    -h|--help)            usage; exit 0 ;;
    *)                    usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

# Is anybody there to answer? Two steps need to know: the setup questions, and — with
# --phone — Tailscale's installer, a .pkg that asks for an admin password: the same hang.
#
# The questions are read from /dev/tty, because `npm run` pipes stdin. But /dev/tty is
# *the controlling terminal*, which is not the same thing as a human who is paying
# attention. In an agent session it belongs to the agent: the questions are asked of
# nobody, no prompt is visible anywhere, and the install hangs on the first one for as
# long as you let it. The escape people reached for — drop the controlling terminal
# (setsid) so /dev/tty fails and the step warns and carries on — also leaves the GUI
# session, and `launchctl bootstrap gui/<uid>` then fails *after* the bootout, leaving
# the daemon unloaded. Two workarounds cancelling each other out.
#
# So say it in a flag instead, and recognise the obvious cases without being asked.
UNATTENDED_WHY=""
if [ "$NON_INTERACTIVE" = 1 ]; then
  UNATTENDED_WHY="--non-interactive"
elif [ -n "${SKIP_CONFIGURE:-}" ]; then
  UNATTENDED_WHY="SKIP_CONFIGURE=$SKIP_CONFIGURE"
elif [ -n "${CLAUDECODE:-}" ] || [ -n "${AI_AGENT:-}" ]; then
  UNATTENDED_WHY="this is an agent session, and nobody would see the questions"
elif [ -n "${CI:-}" ]; then
  UNATTENDED_WHY="CI=$CI"
fi
if [ "$FORCE_INTERACTIVE" = 1 ]; then UNATTENDED_WHY=""; fi

# ---------------------------------------------------------------- prerequisites

[ "$(uname -s)" = "Darwin" ] || die "this installer is macOS-only (it uses launchd)."

# Everything below that Homebrew can install is installed when it is missing, rather than
# only complained about: a second engineer's Mac should get from `git clone` to a running
# service without a list to work through first. What is already there is left alone —
# never upgraded, except a bd too old for beadcause, or a Homebrew node too old to run it.
#
# Homebrew itself is not installed here. Its installer wants sudo and a person at the
# keyboard, and piping a remote script into bash is not a thing to do on somebody's
# behalf. Without it every check below still runs and names what to install by hand.
#
# brew is looked for off PATH too, because the shell that has just installed Homebrew has
# not yet read the profile line that puts it there. BEADCAUSE_BREW_SEARCH replaces those
# places, and test/install.mjs sets it empty so that a test run can never reach the real
# Homebrew on the Mac it runs on.
BD_MIN="1.2.1"
BREW=""
if [ "$INSTALL_DEPS" = 1 ]; then
  BREW="$(command -v brew || true)"
  if [ -z "$BREW" ]; then
    for candidate in ${BEADCAUSE_BREW_SEARCH-/opt/homebrew/bin/brew /usr/local/bin/brew}; do
      if [ -x "$candidate" ]; then BREW="$candidate"; break; fi
    done
    if [ -n "$BREW" ]; then PATH="$(dirname "$BREW"):$PATH"; export PATH; fi
  fi
  if [ -z "$BREW" ]; then
    warn "Homebrew not found (https://brew.sh), so nothing missing can be installed for you."
  fi
fi

# brew_get <what> <brew arguments…> — install one thing and say so. Never fatal on its
# own: whatever is still missing afterwards is for the check that called it to judge.
brew_get() {
  local what="$1"
  shift
  if [ -z "$BREW" ]; then return 1; fi
  say "installing $what — brew $*"
  if NONINTERACTIVE=1 "$BREW" "$@"; then return 0; fi
  warn "brew $* failed."
  return 1
}

# version_lt A B — is the x.y.z A older than B.
version_lt() {
  local IFS=.
  local -a a=($1) b=($2)
  local i
  for i in 0 1 2; do
    if [ "${a[i]:-0}" -lt "${b[i]:-0}" ]; then return 0; fi
    if [ "${a[i]:-0}" -gt "${b[i]:-0}" ]; then return 1; fi
  done
  return 1
}

# An app bundle in either Applications folder. BEADCAUSE_APP_DIRS replaces the two, for the
# same reason BEADCAUSE_BREW_SEARCH exists.
have_app() {
  local dir
  for dir in ${BEADCAUSE_APP_DIRS-/Applications $HOME/Applications}; do
    if [ -d "$dir/$1" ]; then return 0; fi
  done
  return 1
}

# Looked for where lib/config.js's tailscaleBin() looks, not on PATH: the daemon runs under
# launchd and finds it by absolute path, so a tailscale on this shell's PATH alone is one
# the service would never see. BEADCAUSE_TAILSCALE overrides it there and so here.
have_tailscale() {
  if [ -n "${BEADCAUSE_TAILSCALE:-}" ]; then
    if [ -e "$BEADCAUSE_TAILSCALE" ]; then return 0; fi
    return 1
  fi
  local bin
  for bin in /usr/local/bin/tailscale /opt/homebrew/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
    if [ -e "$bin" ]; then return 0; fi
  done
  return 1
}

if ! command -v node >/dev/null 2>&1; then brew_get "Node" install node || true; fi
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found. Install Node 20+ (brew install node) and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
# Upgraded only when it is Homebrew's own node. One from nvm or asdf is somebody's choice,
# and a second node installed beside it would lose to it on PATH anyway.
if [ "$NODE_MAJOR" -lt 20 ] && [ -n "$BREW" ] && [ "$NODE" = "$(dirname "$BREW")/node" ]; then
  brew_get "a newer Node (this one is $NODE_MAJOR)" upgrade node || true
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
fi
[ "$NODE_MAJOR" -ge 20 ] || die "node $NODE_MAJOR is too old; beadcause needs 20+."

# launchd starts with a bare PATH, so `bd` has to be found by absolute path or live
# somewhere the plist's PATH covers. Fail now rather than at the first poll.
if ! command -v bd >/dev/null 2>&1; then brew_get "beads (bd)" install beads || true; fi
BD="$(command -v bd || true)"
[ -n "$BD" ] || die "the beads CLI (bd) is not on your PATH. Install it first (brew install beads) — beadcause is a front-end for it."

# 1.2.1 is where cross-type blocking dependencies arrived. A version that cannot be read
# is left alone rather than upgraded on a guess.
BD_VERSION="$(bd --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sed -n 1p || true)"
if [ -n "$BD_VERSION" ] && version_lt "$BD_VERSION" "$BD_MIN"; then
  brew_get "a newer beads (bd $BD_VERSION is older than $BD_MIN)" upgrade beads || \
    warn "bd $BD_VERSION is older than $BD_MIN, which beadcause needs — brew upgrade beads."
fi

# The rest are not needed for the service to come up, so each one missing is a warning.
# Each is here because something runs it (lib/suppliers.js keeps that list): gh opens and
# reads pull requests, jq is how scripts/claim-guard.sh reads a hook payload, iTerm2 is
# the terminal every agent window opens in, and every agent is a `claude` subprocess.
for tool in gh jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    brew_get "$tool" install "$tool" || warn "$tool not found — brew install $tool"
  fi
done

if ! have_app iTerm.app; then
  brew_get "iTerm2" install --cask iterm2 || \
    warn "iTerm2 not found, and agent windows open in it — brew install --cask iterm2"
fi

if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  if brew_get "Claude Code" install --cask claude-code; then
    say "run \`claude\` once in a terminal to sign it in."
  else
    warn "claude not found, so no agent can run — brew install --cask claude-code"
  fi
fi

# Tailscale only with --phone. Everything but the phone works on loopback, and a first
# install should not stop for an admin password over a feature nobody has asked for yet.
if [ "$PHONE" = 1 ] && ! have_tailscale; then
  if [ -n "$BREW" ] && [ -n "$UNATTENDED_WHY" ]; then
    warn "Tailscale not found, and not installed now: its installer asks for an admin password"
    warn "and nobody is here to type one ($UNATTENDED_WHY). From a terminal:"
    warn "  brew install --cask tailscale-app"
  elif brew_get "Tailscale" install --cask tailscale-app; then
    say "Tailscale installed — open it and sign in, here and on the phone, as the same user."
  else
    warn "Tailscale not found, so a phone cannot reach this Mac — brew install --cask tailscale-app"
  fi
fi

# Said as a warning rather than a failure, because the tracker step below may be about to
# create one — a second engineer's Mac has no ~/beads at all, and on that machine this is
# a note about what is coming rather than a problem with the install.
#
# `~/beads` is only the *default* root: an install can serve any directory named in
# `workspaceRoots`, including a repo whose own `.beads` makes the repo the workspace. So a
# config that already names roots is not warned at — it has answered this question — and
# the warning that is left says the setting's name rather than only the default path.
CONFIGURED_ROOTS=""
if [ -f "$HOME/.config/beadcause/config.json" ]; then
  CONFIGURED_ROOTS="$(node -e 'try{const c=require(process.argv[1]);process.stdout.write((c.workspaceRoots||[]).join(" "))}catch{}' \
    "$HOME/.config/beadcause/config.json" 2>/dev/null || true)"
fi
if [ ! -d "$HOME/beads" ] && [ -z "$CONFIGURED_ROOTS" ]; then
  if [ -f "$ROOT/team.json" ]; then
    say "no ~/beads yet — the team's tracker is named in team.json and comes next"
  else
    warn "no ~/beads directory: beadcause serves every <root>/*/.beads workspace under the"
    warn "roots in workspaceRoots, which defaults to ~/beads alone, and will find none."
    warn "make one (bd init in ~/beads/<name>); or, if your tracker lives inside the repo it"
    warn "tracks, name that repo when \`npm run configure\` asks where workspaces live; or name"
    warn "the team's tracker in team.json — see \"Onboarding a second engineer\" in the README."
  fi
fi

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
# and an installer that silently skipped its own questions was the original bug. Not
# asked at all when nobody is there — see where UNATTENDED_WHY is decided, near the top.
if [ -n "$UNATTENDED_WHY" ]; then
  say "not asking the setup questions ($UNATTENDED_WHY)"
  # Fed /dev/null deliberately: with no TTY configure.js prints what is currently
  # configured and changes nothing, which is the useful half of it when nobody can
  # answer. Everything below reads the same config either way.
  ( cd "$ROOT" && node scripts/configure.js < /dev/null ) || \
    warn "could not read the current configuration — carrying on with the defaults."
else
  ( cd "$ROOT" && node scripts/configure.js < /dev/tty ) || \
    warn "configuration skipped — run 'npm run configure' later to set it up."
fi

# ----------------------------------------------------------------- phone support

# Off unless asked for: without it beadcause answers on 127.0.0.1 alone, which is all a
# first install needs. The phone is a second step, taken with --phone once Tailscale is
# installed and signed in.
#
# It writes the address as well as installing Tailscale, because `host` is filled in once,
# when config.json is first written. A Mac set up without Tailscale keeps 127.0.0.1 on
# disk, and installing Tailscale afterwards changes nothing the daemon reads. The base URL
# follows by itself: the router reconciles a generated one every time it starts.
if [ "$PHONE" = 1 ]; then
  PHONE_RESULT="$(cd "$ROOT" && node -e '/* phone-host */
    import("./lib/config.js").then((m) => {
      const ip = m.tailscaleIp();
      if (!ip) return process.stdout.write("noip");
      const cfg = m.loadConfig();
      if (cfg.host === ip) return process.stdout.write("same " + ip);
      cfg.host = ip;
      m.saveConfig(cfg);
      process.stdout.write("set " + ip);
    }).catch((e) => process.stdout.write("error " + e.message));
  ' 2>/dev/null || echo error)"
  case "$PHONE_RESULT" in
    set\ *|same\ *) say "phone support on — listening on ${PHONE_RESULT#* } as well as 127.0.0.1" ;;
    noip)           warn "phone support needs Tailscale up: open Tailscale, sign in, then re-run with --phone." ;;
    *)              warn "could not set the tailnet address ($PHONE_RESULT) — carrying on, on 127.0.0.1 only." ;;
  esac
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
         found at install time. /usr/sbin is in a login shell's PATH and was
         missing here, which is bc-xl7n.109: lsof lives there on macOS and
         nowhere else, so the lock-clearing in lib/commonrepo.js could not run
         at all in the daemon while working perfectly by hand. That code now
         resolves lsof by absolute path and does not depend on this line —
         but a tool in sbin should not be unreachable from here either. -->
    <key>PATH</key>
    <string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin</string>
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
    <string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin</string>
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

# The pairing code only means something to a phone that can reach this Mac — that is, when
# the daemon listens on a tailnet address. On loopback it would encode http://127.0.0.1,
# which on the phone opens the phone.
BIND_HOST="$(cd "$ROOT" && node -e '/* bind-host */
  import("./lib/config.js")
    .then((m) => process.stdout.write(String(m.loadConfig().host || "127.0.0.1")))
    .catch(() => process.stdout.write("127.0.0.1"));
' 2>/dev/null || echo 127.0.0.1)"
echo
if [ "$BIND_HOST" != "127.0.0.1" ]; then
  say "pair your phone (needs Tailscale on both devices):"
  ( cd "$ROOT" && node bin/beadcause.js --qr ) || true
else
  say "phone support is off — beadcause answers on http://127.0.0.1:4318, on this Mac only."
  say "to use it from a phone later: npm run install-service -- --phone"
fi

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
  npm run install-service -- --phone             # reach it from a phone, over Tailscale
  npm run onboard -- --dry-run                   # is this Mac pointed at the team's tracker?

Config (token, ntfy topic, workspaces) lives in ~/.config/beadcause/config.json. What is
shared with the rest of the team — which trackers, and the policy that has to match on
every Mac — lives in team.json in this checkout.
NEXT
