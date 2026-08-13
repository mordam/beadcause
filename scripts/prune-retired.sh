#!/usr/bin/env bash
# prune-retired.sh — the name the `ship` skill used to sweep the attic with.
#
#   prune-retired.sh <main-checkout> [--days N] [--dry-run] [--backfill] [--quiet] [--no-pr]
#
# The sweep itself is `bin/attic.js` over the gates in `lib/tidy.js`. This is the old
# name, kept working, and nothing else: it finds the checkout it is part of and execs
# that. Flags and output are `bin/attic.js`'s, unchanged; exit 0 whenever the sweep ran,
# 2 for a bad invocation.
#
# ## Why a shim exists at all, and why it is in here
#
# This was 210 lines of bash in `~/.claude-personal/skills/ship/`, versioned by nothing
# and tested by nothing, and run by every ship. bc-bcdp is what that cost: one line of it
# inverted its own answer — `git worktree list --porcelain | grep -q …` under
# `set -o pipefail`, where grep exits at the first match, git dies of SIGPIPE still
# walking the rest, and pipefail reports the *successful* match as a failure — so 68 of
# 85 healthy attic entries were reported as unregistered strays, and a session believed
# that output and filed a bug against a hand-`mv` that never happened.
#
# bc-uytt moved the gates into `lib/`, under `npm test`, and left this file behind at the
# old path so that anything still naming it kept working. Which fixed the sweep and not
# the thing that produced both of its bugs: the file a ship actually invokes was still
# outside every repo, with no history, no review and no test. A shim is small until
# somebody edits it, and nothing would have shown that they had.
#
# So it lives here now, and the path the skill has always named —
# `~/.claude/skills/ship/prune-retired.sh` — is a **symlink to this file**. Not a copy:
# a copy is the same arrangement that drifted, one `cp` later. `test/pruneshim.mjs`
# asserts the symlink is a symlink, so a hand-edited copy put back in its place is a
# test failure rather than a discovery six weeks on.
#
# Still repo-agnostic: it takes any repo's main checkout, and sophab — which has no
# daemon, and where this is the only thing that empties the attic — shares the
# retirement convention.

set -uo pipefail

# Resolve this script through however many symlinks reach it, because the installed path
# *is* a symlink and `dirname "$0"` there is `~/.claude/skills/ship`, which is not a
# checkout of anything. `readlink -f` is not portable to every macOS this has to run on,
# so the loop is written out.
resolve() {
  local target="$1" dir
  while [ -L "$target" ]; do
    dir="$(cd -P "$(dirname "$target")" && pwd)" || return 1
    target="$(readlink "$target")"
    case "$target" in
      /*) ;;
       *) target="$dir/$target" ;;
    esac
  done
  dir="$(cd -P "$(dirname "$target")" && pwd)" || return 1
  printf '%s/%s\n' "$dir" "$(basename "$target")"
}

# Three ways to find the checkout, most explicit first:
#
# 1. BEADCAUSE_DIR, when somebody means a particular one.
# 2. The checkout this file is physically in — right whether it is run from the repo,
#    from a worktree, or through the installed symlink, and the reason the "your checkout
#    is behind" failure below is now rare: reached through the symlink, the sweep it execs
#    is the one sitting beside the shim that named it, so the two cannot disagree.
# 3. The historical default, for a shim hand-copied somewhere outside any checkout.
SELF="$(resolve "${BASH_SOURCE[0]}")"
HERE="$(dirname "$(dirname "$SELF")")"
DEFAULT="$HOME/neadamthal.projects/beadcause"

if [ -n "${BEADCAUSE_DIR:-}" ]; then
  BEADCAUSE="$BEADCAUSE_DIR"
elif [ -f "$HERE/bin/attic.js" ]; then
  BEADCAUSE="$HERE"
else
  BEADCAUSE="$DEFAULT"
fi

SWEEP="$BEADCAUSE/bin/attic.js"

if [ ! -f "$SWEEP" ]; then
  printf 'prune-retired: the attic sweep is bin/attic.js in beadcause, and %s is not there.\n' "$SWEEP" >&2
  # By far the likeliest reason, on a repo where every merge happens at GitHub: the
  # working tree is behind the ref that has the file. Nothing pulls that checkout on its
  # own, so a session can merge this and still not see it here for hours.
  printf 'prune-retired: that checkout is probably behind — git -C %s pull --ff-only\n' "$BEADCAUSE" >&2
  printf 'prune-retired: or set BEADCAUSE_DIR to a checkout that has it.\n' >&2
  exit 2
fi

exec node "$SWEEP" "$@"
