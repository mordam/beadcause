#!/usr/bin/env bash
# claim-guard.sh — tell a session when another session is already editing this file.
#
# The client half of lib/claims.js. Two modes, both driven from ~/.claude/settings.json:
#
#   guard    PreToolUse   — claim the file this Write/Edit is about to touch, and DENY
#            (Write|Edit)   once if another live session holds it, naming who.
#   release  SessionEnd   — let go of everything this session held, rather than leaving
#                           its files looking busy until the TTL expires.
#
# ## Why a hook rather than a brief
#
# A register nothing writes to is shelfware, and a brief that asks an agent to remember
# to claim its files will be forgotten by the third turn. `PreToolUse` carries the file
# path in the tool call itself, so the claim can be taken at the exact moment of the edit
# with no agent cooperation at all — and a deny is the one channel here whose text the
# model is guaranteed to read. ~/.claude/hooks/worktree-guard.sh does the same thing one
# granularity up (whole checkout) and this deliberately copies its shape.
#
# ## It fails open, always
#
# No daemon, no token, a timeout, no `jq`, not a git repo: exit 0 and say nothing. This
# sits in front of every edit in every session on this Mac, so the failure mode has to be
# "the warning is missing", never "the edit is blocked". Everything below is written to
# that rule, which is why there is no `set -e` and every capture ends in `|| true`.
#
# ## Every process here is paid for on every edit
#
# Measured at ~128ms with one `jq` per field and one `git` per fact, which is a tax on
# every Write in every session — so the reads are folded: one `jq` for the config, one for
# the payload, one `git rev-parse` for all three git facts. `test/claims.mjs` covers the
# behaviour, and the reason to keep the process count down is written here because the
# obvious way to add a field later is another `jq`.

set -uo pipefail

MODE="${1:-guard}"
CONFIG_DIR="${BEADCAUSE_CONFIG_DIR:-$HOME/.config/beadcause}"
CONFIG="$CONFIG_DIR/config.json"

command -v jq >/dev/null 2>&1 || exit 0
[ -r "$CONFIG" ] || exit 0

# One jq, two answers. Newline-separated rather than on one line, because a token is
# opaque and splitting a line on whitespace assumes something about it.
conf=$(jq -r '.token // empty, (.port // 4318)' "$CONFIG" 2>/dev/null) || exit 0
TOKEN=${conf%%$'\n'*}
PORT=${conf##*$'\n'}
[ -n "$TOKEN" ] || exit 0
BASE="http://127.0.0.1:$PORT"

# One second, and it is a ceiling rather than a target: the daemon answers a claim from a
# map in memory. A second of latency on an edit is already too much to pay for a warning,
# and the router in front of it can be mid-swap.
post() {
  curl -s --max-time 1 -X "$1" "$BASE/api/claims" \
    -H "x-beadcause-token: $TOKEN" -H 'content-type: application/json' \
    --data-binary @- 2>/dev/null || true
}

payload=$(cat)

# ── release ──────────────────────────────────────────────────────────────────
if [ "$MODE" = release ]; then
  session=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null) || exit 0
  [ -n "$session" ] || exit 0
  jq -Rn --arg s "$session" '{session:$s}' | post DELETE >/dev/null
  exit 0
fi

# ── guard ────────────────────────────────────────────────────────────────────
fields=$(printf '%s' "$payload" |
  jq -r '(.session_id // ""), (.tool_input.file_path // .tool_input.notebook_path // "")' 2>/dev/null) || exit 0
session=${fields%%$'\n'*}
file=${fields##*$'\n'}
[ -n "$session" ] && [ -n "$file" ] || exit 0
case "$file" in /*) ;; *) file="$PWD/$file" ;; esac

# Deepest existing ancestor — a Write target need not exist yet.
dir="$file"
[ -d "$dir" ] || dir=$(dirname "$dir")
while [ ! -d "$dir" ] && [ "$dir" != "/" ]; do dir=$(dirname "$dir"); done

# Three facts, one process. `--path-format=absolute` applies to the options after it, so
# the order here is load-bearing: the first two must come before it.
facts=$(git -C "$dir" rev-parse --abbrev-ref HEAD --show-toplevel --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
branch=${facts%%$'\n'*}
rest=${facts#*$'\n'}
top=${rest%%$'\n'*}
common=${rest##*$'\n'}
[ -n "$top" ] && [ -n "$common" ] || exit 0

# The MAIN checkout, not this worktree — that is the whole point. Two worktrees editing
# one logical file are the collision this exists for, so the key has to be the thing they
# share: the repo they were branched from, plus the path within it.
main=$(dirname "$common")
rel=${file#"$top"/}
[ "$rel" != "$file" ] || exit 0   # outside the tree somehow; not ours to claim

# The bead is deliberately NOT read here. This Mac's worktree branches end in the bead's
# own tag (`worktree-file-claims-q5c2`), so the branch already leads you to it, and turning
# a tag into a verified id needs the tracker prefix — see `candidateTiers` in
# lib/beadref.js on why a guess must not pass as an answer. Doing it properly is the
# daemon's job, once per branch rather than once per edit; doing it here cost a 20KB
# transcript read and two more processes on every Write in every session.
out=$(jq -Rn --arg s "$session" --arg repo "$main" --arg file "$rel" --arg dir "$top" \
  --arg branch "$branch" --arg label "${main##*/}" \
  '{session:$s, repo:$repo, file:$file, dir:$dir, branch:$branch, label:$label}' |
  post POST)

[ -n "$out" ] || exit 0
reason=$(printf '%s' "$out" | jq -r 'select(.decision == "conflict") | .reason // empty' 2>/dev/null) || exit 0
[ -n "$reason" ] || exit 0

jq -nc --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
