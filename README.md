# Beadcause

Answer `bd human` questions from your phone — with the diagram, the images and
the links that make the decision answerable, not just a line of text and two
buttons.

A Node daemon on the Mac reads every beads workspace under `~/beads/`, serves a
mobile-first PWA over Tailscale, and pushes new questions to ntfy. Answering
comments on the bead and closes it, so whatever was blocked on the answer turns
up in `bd ready` for the next agent session.

```
agent files a `human` bead ──► beadcause polls ──► ntfy push to phone
                                                       │
                              PWA over Tailscale ◄─────┘ (tap)
                                       │
                            bd comment + bd close ──► `bd ready` unblocks
```

## Install

macOS only — it runs as a launchd agent and drives iTerm2.

**You need:** Node 20+, the [`bd`](https://github.com/steveyegge/beads) CLI with at
least one workspace under `~/beads/<name>/.beads`, and
[Tailscale](https://tailscale.com) on the Mac and the phone, signed in as the same
user. Optional: iTerm2 and Claude Code, for the "discuss this on the Mac" button.

```bash
git clone <this repo> beadcause && cd beadcause
npm run install-service
```

That checks the prerequisites, installs dependencies, **asks you the handful of
things that can't be guessed**, generates a launchd plist for *your* home directory
and node binary, starts the service, waits for it to answer, and prints the pairing
QR. It's re-runnable — run it again after pulling.

The questions, all with a safe default on Enter: which workspaces are **shared with
other people** (those get a contentless push and no unattended agents), where your
**code lives** (so a question can show you files from it), whether your shell
**derives `BEADS_DIR` from the working directory**, whether to use **ntfy**,
whether commenting should **spawn an agent** to answer you, and whether to open the
**[activity monitor](#the-monitor--what-it-is-doing-right-now)** at login. Re-run them any time
with `npm run configure`; nothing is written until the last answer, so Ctrl+C is
always safe.

```bash
npm run monitor              # live view of what the daemon is doing
npm run uninstall-service    # remove the service (keeps your config and token)
tail -f ~/Library/Logs/beadcause.log
launchctl kickstart -k gui/$(id -u)/m4m.beadcause   # restart after changing lib/ or bin/
```

The plist is generated, never committed: a checked-in one cannot work on a second
machine, because `node` alone moves between `/opt/homebrew/bin`, `/usr/local/bin`
and any number of nvm paths. Kill any hand-started instance before installing — a
second one can't bind the port, and it exits 1 rather than lingering, because
otherwise its poller would keep firing notifications with no listener behind them.

### Pairing a phone

1. **Both devices on the tailnet.** `tailscale status` should list them both.
2. **Scan the QR** from `npm run qr` (or `node bin/beadcause.js --url` for the same
   link as text). It carries the token, which is captured into localStorage and
   stripped from the address bar on first load. `npm run qr` prints **two** codes —
   the pairing link, then the APK with its size and build time, whenever one has
   been published; `npm run android` ends with the same install code, because a
   build ends where the install begins and nobody should thumb a tailnet IP, a port
   and a path into a phone. Every device needs this once — a
   notification opened on an unpaired phone lands on the token prompt, which is the
   tell.
3. **Share → Add to Home Screen**, and it installs as a standalone app. Android
   users can instead install the native app — see [The Android app](#the-android-app).
4. **Push:** the Android app posts its own notifications over the tailnet and needs
   nothing else. For the PWA, install [ntfy](https://ntfy.sh) and subscribe to the
   topic printed at startup, then set `ntfy.enabled: true` in the config.

### Worth knowing before you rely on it

- **`~/.config/beadcause/config.json` is written on first run** and holds the shared
  token. Everything below is tunable there; see [Config](#config--configbeadcauseconfigjson).
- **`assetRoots`** is what a question may show you — images and documents outside it
  are refused. Setup asks for your code directory; add more later.
- **Sessions open in `~/beads/<workspace>` by default**, which always works. Setup
  asks whether your shell derives `BEADS_DIR` from the working directory; see
  [Discussing a question on the Mac](#discussing-a-question-on-the-mac).
- **Nothing is exposed beyond the tailnet.** The daemon binds `127.0.0.1` and your
  Tailscale IP, never `0.0.0.0`.

## Asking a question

Anything labelled `human` shows up. To get buttons, diagrams and links, put a
fenced `decision` block in the body:

````markdown
Some markdown context. Tables, images, links, `code` — all of it renders.

```decision
question: Charge the platform fee on gross or on net?
options:
  - id: gross
    label: Gross — fee on the full charge
    hint: Simpler to reconcile
    response: "Gross: take the platform fee on the full charge amount."
  - id: net
    label: Net — after Stripe's cut
    response: "Net: calculate the fee after processing costs."
diagram: |
  graph LR
    Buyer --> Platform --> Seller
docs:
  - label: The spec you need to read first
    path: /Users/you/code/acme/SPEC.md
  - /Users/you/code/acme/notes.txt
links:
  - "[Stripe application fees](https://docs.stripe.com/connect/direct-charges)"
  - label: Payouts sheet
    url: https://example.com/payouts
images:
  - /Users/you/code/acme/current-flow.png
```
````

- `options[].response` is the exact text recorded as the answer — write it so a
  future agent can act on it without re-reading the question.
- `diagram` is mermaid, rendered on the phone. ` ```mermaid ` fences in the prose
  render too.
- `docs` are files on the Mac you need to read before answering. Each opens in a
  **separate reader tab** (`/doc?p=…`): markdown is rendered, text/log/csv shown
  as-is, PDFs embedded. Relative links inside a rendered markdown doc resolve
  against that doc's directory, so a spec that links its sibling files stays
  navigable. Servable extensions are images plus
  `.md .markdown .txt .log .csv .json .jsonl .yaml .yml .pdf` — source files are
  refused, deliberately.
- **A local path written inline in the prose becomes a reader link too** —
  `[the spec](/Users/you/code/acme/SPEC.md)` needs no `docs` entry. Every link in
  a brief opens in a new tab so you never navigate away mid-answer.
- `images` may be absolute paths on the Mac — they're served through
  `/api/asset`, restricted to `config.assetRoots`.
- A block that isn't valid YAML shows the parse error on the card rather than
  silently dropping to free-text. Quote markdown links: bare `- [x](y)` is a YAML
  flow sequence (beadcause repairs that one case, but quoting is clearer).

From an agent session, piping the body avoids shell-quoting hell:

```bash
node bin/ask.js -w acme -t "Gross or net platform fee?" -f brief.md
node bin/ask.js -w acme -t "Which auth flow?" -b ac-abc < brief.md   # -b blocks that issue
```

`-b <id>` makes the named issue depend on the question, so it stays out of
`bd ready` until you answer.

## Spaces — keeping work out of your evening

Workspaces can be grouped into **spaces**, and a space is defined by *when it may
interrupt you*:

```json
"spaces": [
  { "name": "Personal", "workspaces": ["notes", "sideproject"] },
  { "name": "Work", "workspaces": ["acme"],
    "quietHours": { "from": "18:00", "to": "09:00" },
    "quietDays": ["sat", "sun"],
    "ntfyDetail": "minimal",
    "autoDispatch": false }
]
```

The phone then shows a space row above the workspace chips, and picking a space
narrows both the list and the chips below it.

**A quiet space is quiet, not hidden.** Its questions still arrive, still appear in
the list, still count towards the badge — they just don't light up your phone, and
the chip shows 🔕 so the silence is legible rather than looking like a fault. That
asymmetry is deliberate: an unwanted buzz is annoying, a question you never saw is a
real failure.

`muted: true` silences a space regardless of the clock. `quietHours` may cross
midnight (`18:00` → `09:00` is the normal case) and is evaluated in local time,
because "after six" means your evening. A malformed time disables the rule rather
than muting the space forever. `ntfyDetail` and `autoDispatch` set at space level
keep applying as you add workspaces to that space — which is exactly the drift that
otherwise leaks a work question onto a public relay.

`npm run configure` walks you through it. Run it **in a terminal** — it needs one to
ask questions. Anywhere else (a pipe, CI, an agent shell) it prints the current
configuration and changes nothing, which also makes it a quick way to see what is
set.

## Answering

- **Two taps on an option.** The first arms it, the second commits — a pocket tap
  shouldn't close a bead. It disarms after 6s.
- **Free text**, with *Answer & close* or *Comment only* if you want the question
  to stay open. **Drafts are saved on every keystroke** to localStorage, so
  collapsing the card, opening a doc, a background refresh, or the phone killing
  the tab can't eat a half-written answer. A collapsed card with a draft says
  *Resume your answer* and shows a "draft saved" flag; the draft is cleared only
  once the answer is accepted. **The list never repaints while an answer is in
  progress** — not on the 25s refresh, not when the two-tap arm timer expires.
  Rebuilding it would destroy the textarea, drop focus, close the keyboard and
  reset scroll, which reads exactly like the answer being thrown away. Repaints
  are deferred until the box is empty and unfocused; the armed-option state is
  painted in place instead.
- **From the notification**, when a question has ≤3 options: ntfy's action buttons
  POST the answer straight to the daemon over the tailnet.

Either way the answer lands as a comment authored by `beadcause` and the bead
closes with reason "Answered via Beadcause".

## The conversation, both ways

*Comment only* is not a dead end — it starts a thread.

- **You → agent.** Commenting without answering labels the bead `human-replied`.
  That's the signal a session can actually find: `bd list --label=human-replied`
  shows every question waiting on an agent rather than on you. The card shows
  "⏳ you replied · waiting on an agent to pick this up".
- **Someone actually answers.** A comment dispatches an unattended `claude -p` in
  that workspace's directory to read the thread and reply on the bead. Without it
  `human-replied` was only a *passive flag*: it waited for an agent session to come
  looking, and the session that filed the question had exited days ago. Five threads
  sat unanswered that way, one of them reading "Can anyone hear me?".
  The agent runs with a narrow allowlist — `Bash(bd *) Read Grep Glob`, so it can
  research and comment but not edit anything — and is told to comment with
  `--actor claude-session`, never to close the bead. One agent per bead at a time.
  Off with `autoDispatch: false`, and workspaces you marked as shared during setup
  are excluded for the same reason they push `minimal`.
- **Agent → you.** The poller watches those threads and pushes an ntfy the moment
  a comment lands from anyone other than `beadcause`, then clears the flag. Only
  questions you've replied to are watched — `bd human list` carries no comment
  count and a comment doesn't move `updated_at`, so this costs one extra `bd`
  call per watched thread per tick, and there are usually none.
- **Links in comments are live.** Comment bodies render as markdown, bare URLs
  autolink, and local paths become reader-tab links, all opening in a new tab.
  Comments from an agent are marked with an accent bar.

## ⚙ What the inbox shows

The inbox is `bd human list` filtered to open, and that is the app's whole premise:
a bead reaches your phone because it is *asking you something*. The cost of that
premise is that a workspace with no `human` beads reads as completely idle — the
Climative space chip said **0** while 54 beads were open in it and five were being
worked on. Arithmetically correct, and indistinguishable from a broken app.

So the **gear at the top left** carries one setting, in three positions:

| | shows | costs |
|---|---|---|
| **Human** (default) | beads labelled `human` — the questions | one `bd human list` per workspace |
| **Both** | questions first, then every live bead | both sweeps, in parallel |
| **Agent** | only what is *not* a question | one `bd list` per workspace |

"Live" is `open`, `in_progress` or `blocked`; deferred and closed are out, because
neither is anything an agent is on. **Every count on the screen follows the scope** —
that is the point of it, and why the gear takes an accent border once it leaves
`Human`: with the panel closed it is the only thing on screen saying why "Climative
59" is not a count of questions.

Three things make this safe to widen:

- **The default never moved.** `/api/questions` treats an absent or unrecognised
  `scope` as `human`, so the poller, the pushes and the Android shell see exactly
  what they always saw. Only the phone's own list changes.
- **Agent beads are read-only.** There is no decision block to answer, so the card has
  no options and deliberately no **Answer & close** — that path comments "Answered via
  Beadcause" and closes the bead, which on another session's in-progress work would be
  vandalism rather than an answer. What you get is what the bead is, who has it, its
  description and notes, and the two ways in: the graph, or a session on the Mac.
- **The rows are slim.** `bd list --json` returns the full description *and* notes of
  every row — climative alone is 88KB of it — so the list carries only what a card
  draws and `/api/bead` fetches the body when you actually open one. `--limit 0`
  overrides bd's default of 50, or a busy workspace would report its first fifty beads
  as the whole truth.

The wider scopes poll at 60s rather than the inbox's 25s: they are a full `bd list`
sweep, about 2.5s of `bd` across seven workspaces, and that does not want to run four
times a minute for a list you are glancing at.

## What a question is blocking

A question whose answer nothing is waiting on is just a question. One that blocks
seven issues is a queue, and that changes how fast you want to answer it — so an
open card that blocks anything gets a **What this is blocking** link, into the
dependency graph. It appears with the details rather than on the collapsed card,
because `bd human list` doesn't return a dependent count and `bd show` does — the
same reason `commentCount` is 0 until you open a question.

The graph itself is at `/graph?ws=<workspace>` with an optional `&id=<bead>`, and a
scope switch between *this bead* and the *whole workspace*.

### It grows, five beads at a time

beadcause used to frame `bd graph --html` directly. It was free, and it was wrong on
a phone in three ways — all of which came from the same thing: the page is built to
be opened on a desktop, once, by somebody who will wait.

- **Nothing happened for five seconds, then everything did.** deluvia is 108 beads
  and 140 edges; `bd` takes ~4s to walk it, and the page draws the lot in one frame.
  A blank screen for five seconds reads as broken.
- **Every title was truncated.** bd's nodes are 130x40, so each one is an ellipsis.
- **A node was a dead end.** Tapping told you nothing you didn't already see.

So the server now hands over `{nodes, links}` and the phone draws it (`lib/graph.js`,
`public/graph.js`). Beads arrive in batches of **five, every 130ms**, ordered by bd's
computed layer — so the graph grows the way the work does, things that can start now
first — and a counter reads `35 of 108` while it fills, with a **Pause**. The view
re-frames itself as it grows and once the layout settles, never zooming past 1:1.

The numbers still come out of `bd graph --html`, parsed server-side, rather than from
`bd graph --all --json`: that page embeds exactly the render model we want — id,
title, status, priority, type, layer, typed edges — where `--json` returns entire
issue descriptions we would throw away.

### Tap a bead, then open it

Tapping a node raises a **card** with the whole title, its status, priority and type,
and two buttons. **Details** opens the bead itself in a sheet — description rendered
as markdown, the thread, who owns it, what it blocks and what it waits on — served by
`/api/bead`, which is `bd show` plus comments rather than `/api/question`'s
decision shape (every node is an ordinary issue; only some are questions). The sheet
takes 72% of the screen, and **⤢** takes the rest of it.

Three bugs found building this, all worth knowing because they're the kind that look
like something else:

- **`hidden` loses to `display`.** `#empty` is an absolutely-positioned overlay across
  the whole canvas; giving it `display: grid` silently beat the UA's `[hidden]` rule,
  so an invisible box sat over the graph eating every tap. The graph looked drawn and
  completely dead. Every overlay here now carries its own `[hidden] { display: none }`.
- **d3-drag suppresses the click after any movement.** Its `clickDistance` defaults to
  0, so a tap that slides one pixel — which is every tap made by a finger — is a drag,
  and the click never fires. `.clickDistance(8)` fixes it.
- **d3 transitions share a default name.** The nodes' fade-in and the auto-fit's zoom
  transition kept cancelling each other, leaving every node stuck at opacity 0.0004 —
  a fully drawn, entirely invisible graph. The fade is a CSS animation now.

## Current sessions — who is working, and on what

The inbox answers *what needs me*. It is `bd human list`, so a bead only appears if
it carries the `human` label — which means everything the sessions on the Mac are
actually doing was invisible from the phone. Nine beads claimed in sophab five
minutes ago showed up nowhere at all.

**🤖 in the inbox's top bar** opens `/sessions`: one card per workspace, busiest
first. (`/work`, what this used to be called, still resolves to the same page.)

```
climative                        5 on a bead · 5 sessions
  ◗ pipeline-service: client built without retry…      11h
    cl-1jw  adam.morgan
  ◗ TECH-5989 fanout: downmerge 25 service repos       17h
    cl-wyv  adam.morgan
  CLAUDE SESSIONS  Which of these is on which bead is not recorded.
  ● Climative - newrelic v14 override fix              11h
    dms-client-retry-4e7 · pid 90310 · idle
  54 open · 51 ready · 3 blocked            [ Graph → ]

deluvia                                       2 sessions
  CLAUDE SESSIONS  Nothing claimed in the tracker yet.
  ● Deluvia - apply canon audit fixes                   3m
    canon-audit-apply-b7e · pid 44124 · busy
  123 open · 87 ready · 36 blocked          [ Graph → ]
```

A session reaches this page through **either of two independent signals**, and the
page keeps them apart on purpose.

**A claimed bead — `status = in_progress`.** That is the one signal every session
already emits, because claiming work *is* `bd update --claim` — no hook, no
cooperation from the agent, no beadcause-specific convention. Live phase and detail
(✍️ drafting, 🔍 researching — from `status.json` and `agent:<phase>` labels) are
layered on where they exist; their absence is normal rather than a gap, because most
sessions never post one. The age beside each row is time since it was claimed, and
it is the number that tells you something is stuck. This is the half that says
**which bead**, so the id is a pill on the row and the row links into that bead in
the graph.

**A live `claude` process.** Claude Code writes one record per running session to
`~/.claude/sessions/<pid>.json` — pid, cwd, the `<project> - <task>` name the session
gave itself, and busy/idle. That is the only place a session which has *claimed
nothing* shows up at all, which is the common state at the start of a session and
precisely when you want to know it exists. Records are not removed when a session
exits, so every one is liveness-checked (`kill(pid, 0)`) before it is reported. A
directory is mapped to a workspace with the same rule the shell uses, so a worktree
files under its parent repo — see `beadsDirFor` in `lib/session.js`. Turn it off with
`claudeSessions: false`, or point it elsewhere with `claudeSessionsDir`; with no such
directory the page is just beads, as it was before.

**The two are never paired up.** Nothing on the Mac records which bead a given
process is on, so a session and a claimed bead in the same workspace are *probably*
the same work — and reporting that as fact would invent a link the machine does not
have. So the card says which case it is (*"Which of these is on which bead is not
recorded"* against *"Nothing claimed in the tracker yet"*) and lets you draw the
line. The state worth acting on is a session with nothing claimed, and that is
exactly the one a guess would have hidden.

Every card has a **Graph →** into the whole workspace — which is also the answer to
"how do I see what another session just created", since the graph draws every open
issue rather than only the questions.

Two `bd` calls per workspace (`status --json` for the counts, `list
--status=in_progress --limit 0 --json` for the beads — `--limit 0` because bd's own
default is 50, and a silently truncated list here would read as the whole truth),
run in parallel across all of them:
about two seconds for six. It refreshes every 45s and on ⟳, deliberately not on the
inbox's 30s cycle — the inbox is polled by every client all day, and this is opened
when you want it. A workspace that fails reports its error in place rather than
vanishing from the list; a missing row would read as "nothing happening there",
which is the one thing it doesn't mean.

## The Android app

A native shell around the same PWA, in `android/`. It exists for the four things a
web page on a phone cannot do:

1. **Notifications the app posts itself** over the tailnet, with no ntfy relay in
   the middle — so nothing about a question leaves your network.
2. **A typed answer straight from the shade.** `RemoteInput` gives the notification
   a real text field; ntfy's buttons can only send a fixed string.
3. **A watcher that outlives the tab.** A foreground service, not a page the OS may
   evict at any moment.
4. **A share target.** Anything on the phone becomes a `human` bead in the same
   inbox as everything an agent asks.

Everything else — markdown, mermaid, images, the document reader, the two-tap
confirm, per-keystroke drafts, the render deferral — is the existing `public/app.js`
running in a WebView. There is deliberately no second implementation to keep in step.

### Install

```bash
npm run android:key     # once: sideload signing key in ~/.config/beadcause
npm run android         # build, and publish the APK to public/
```

Then on the phone, **open `http://<tailnet-ip>:4318/beadcause.apk`** and install it
— the same tailnet that carries the questions carries the app, so there's no cable
and no Play track. `npm run android -- --install` uses `adb` instead if a device is
attached. Pair by scanning the `npm run qr` code, which is the same QR the PWA uses:
the URL carries the token, and the app stores it in EncryptedSharedPreferences.

Needs the Homebrew Android toolchain, not Android Studio:

```bash
brew install --cask android-commandlinetools
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```

### What it costs you to know

- **A channel's sound and vibration are immutable once created.** Android takes them
  from the first `createNotificationChannel` and ignores every later one, forever —
  they belong to the user from that moment. Changing either means publishing a new
  channel id and deleting the old, which is why the ids carry a `_v2`. Decisions get
  a bundled 75ms pip (`res/raw/blip.wav`) and one 40ms shake; replies get the pip and
  no vibration; the Watching row stays silent. Anything finer is the phone's own
  per-channel settings, which now win over all of it.
- **Android renders at most 3 notification actions.** Going native does *not* lift
  ntfy's three-button cap. The budget is spent as: two option buttons plus a typed
  "Answer…", or — when a question has no options — "Answer & close" and "Comment",
  both typed. Every option is still listed in the expanded notification, and the
  rest are one tap into the app.
- **Notification actions are one tap, not two.** The in-app two-tap confirm guards
  against a pocket tap on a screen you're already looking at; the shade needs an
  unlock first, and ntfy's buttons have always been one tap.
- **The service is `specialUse`, not `dataSync`.** A `dataSync` foreground service
  is capped at six hours a day on Android 15 and would go quiet each evening.
  `specialUse` has no timeout; it needs a Play Store justification, which a
  sideloaded build never has to give. This is the concrete reason distribution and
  push transport aren't independent choices.
- **Cleartext HTTP is permitted only for `100.64.0.0/10`** (Tailscale's range) plus
  loopback, via `network_security_config.xml`. A mistyped pairing address pointed at
  a public host will refuse to connect rather than send the token in the clear.
- **Samsung will kill it.** On a Galaxy, add Beadcause to Settings → Battery →
  Background usage limits → **Never sleeping apps**, or the watcher dies silently
  after a few hours.
- **The APK is 28 MB**, nearly all of it ML Kit's bundled QR model. Swapping to
  `play-services-mlkit-barcode-scanning` would cut ~20 MB at the cost of depending
  on Play Services being current.
- **Keep the signing key.** Android refuses an update signed by a different key, so
  losing `~/.config/beadcause/android-keystore.jks` means uninstall-and-re-pair.

### How the phone hears about a question

`GET /api/poll?since=<seq>&wait=25` parks server-side until the poller sees a new
question or an agent reply, then returns the events *and* the current question list
in one round trip. A poll that times out with nothing to report returns
`questions: null` — deliberately, so an idle watcher never costs a `bd human list`
across five workspaces. Off the tailnet the poll just fails and backs off to one
attempt every two minutes.

`resync: true` means the caller was away longer than the server's in-memory event
log; trust `questions` over the event stream. `seq` is persisted on the phone, so a
service restart resumes rather than re-notifying — and a cold start (no `since`)
reads current state with no backlog, the same way the daemon's own poller refuses to
push the questions already waiting when it boots.

## Discussing a question on the Mac

Some questions can't be answered with two taps — you want to argue with someone
first. **Discuss in a Claude session on the Mac** opens an iTerm2 window with
`claude` already reading that bead, from the phone, over the tailnet.

**Where the session starts** decides everything else, so there are two modes.

*Default.* The session opens in `~/beads/<workspace>` — the workspace's own
directory, where `bd` finds `.beads` by walking up from the cwd. Always correct,
nothing to configure. This is what you get on a fresh install.

*`projectRoot` set.* Some shells derive `BEADS_DIR` from the working directory — a
`chpwd` hook mapping `<projectRoot>/<repo>` → `~/beads/<repo>`, often carrying
`BEADS_ACTOR`, an API token and even `CLAUDE_CONFIG_DIR` (i.e. **which account gets
billed**) along with it. If yours does, set `projectRoot` and the session opens in
the matching checkout instead, picking all of that up from the shell's own startup
with nothing passed in. Set `fallbackWorkspace` to whatever a shell *outside* that
root resolves to.

In that second mode the mapping is *verified*, not assumed: beadcause recomputes
what `BEADS_DIR` a shell in the candidate directory would resolve to, and refuses to
open the session if it doesn't match the workspace the question came from. Opening a
session that quietly writes to the wrong tracker, or bills the wrong account, is
worse than not opening one.

`sessionDirs.<workspace>` overrides both modes for a single workspace.

The session opens with a short brief: which bead, how to read it (`bd show`,
`bd comments`), how to record the answer (`bd comment` + `bd close --reason`, never
the broken `bd human respond`), and an instruction not to answer on your behalf —
you opened it to talk, not to delegate. It also names itself
`<Project> - discuss <id>`.

### Permission mode

Sessions start with `claude --permission-mode auto`, set by `sessionPermissionMode`.
That default is the point of the button: you tapped it from another room, so a
session that halts on the first permission prompt and waits for a keyboard is no
use. Any of `auto`, `acceptEdits`, `manual`, `dontAsk`, `plan`, `bypassPermissions`
works; `null` launches with no flag and inherits your settings. Unrecognised values
are ignored with a warning rather than passed through — `claude` exits immediately
on a bad mode, which would look like an iTerm window that opens and instantly dies.

The mode is logged on every launch (`permission mode: auto`), because a session that
quietly came up in the wrong one is otherwise invisible until it stops to ask you
something you aren't there to answer.

Worth knowing what does and doesn't backstop this. `auto` is classifier-driven, not
carte blanche — it still refuses things. And `~/.claude/hooks/worktree-guard.sh`
denies edits in the main checkout of any repo using the `.claude/worktrees/`
workflow — so repos without one are unprotected. Check which of yours qualify. If
that gap matters, set `sessionPermissionMode: "plan"` and promote by hand.

Two notes:

- **This is the only endpoint that starts a process** rather than running `bd` with
  fixed arguments, so it is guarded harder: the workspace must be one already being
  served, the id must match a bead-id pattern before it goes anywhere near a shell,
  and the question's title is read back from `bd` rather than taken from the request
  body — a crafted body cannot put text on the command line. The prompt travels via
  a temp file the shell reads and deletes, so a multi-line markdown brief never has
  to survive being typed through AppleScript. Set `openSessions: false` to turn the
  whole thing off.
- **macOS may block the first attempt.** The daemon runs under launchd, where a TCC
  prompt might never be shown to anyone; if you get "macOS blocked beadcause from
  controlling iTerm", approve it once in System Settings → Privacy & Security →
  Automation.

## Progress: what an agent is doing right now

An agent working on a question can say so, and it shows on the card — a breathing
dot, the phase, the detail line and how long ago:

```bash
node bin/status.js -w acme -i ac-abc -p researching -m "reading the Stripe docs"
node bin/status.js -w acme -i ac-abc -p drafting    -m "comparing both fee models"
node bin/status.js -w acme -i ac-abc --clear
```

Phases: `thinking` `researching` `drafting` `building` `blocked` `waiting` `done`
— anything else is accepted and shown as-is. `POST /api/status` does the same
thing over HTTP.

Progress lives in `~/.config/beadcause/status.json`, **not** in beads. `bd
set-state` writes an event bead per change, which inflates the issue's dependent
count ("blocks 7") with churn that's obsolete seconds later. Set
`mirrorStateToBeads: true` if you want the `agent:<phase>` labels anyway — the
app reads them either way, so a session that calls `bd set-state` directly still
shows up.

Your own writes get progress too: submitting shows "Recording your answer…" while
`bd` retries through the Dolt lock, instead of a dimmed card and no explanation.

## The monitor — what it is doing right now

The daemon works invisibly: polling five workspaces, deciding whether a space is
allowed to interrupt, dispatching agents at your comments. `npm run monitor` is the
window onto that.

```
┌─ Beadcause ───────────────────────────────────── 127.0.0.1:4318  ● live ─┐
│ Personal  4 open                                              🔔 push on │
│ Work      1 open                              🔇 quiet until Mon 09:00   │
├─ questions (5) ──────────────────────────────────────────────────────────┤
│ climative/cl-8f2  P1  Deploy to staging before the demo?              2d │
│    ✍️ drafting · comparing both fee models  auto-dispatch            12m │
│ sophab/sp-1a9     P2  Which palette for the pricing page?             4h │
│    ⏳ waiting on an agent                                                │
├─ events ─────────────────────────────────────────────────────────────────┤
│ 13:02:11  reply      deluvia/dv-5i2.39  from claude-session              │
│ 13:01:48  activity   climative/cl-8f2   drafting · comparing fee models  │
│ 12:58:02  question   sophab/sp-1a9      Which palette?  (quiet — not pu… │
└─ q quit · r refresh ────────────────────────────────── seq 1482 · 13:02 ─┘
```

`q` quits, `r` forces a full refresh. It reads `GET /api/poll` — the same long-poll
feed the phone lives on — so it is a **consumer, not new instrumentation**: a
monitor that is closed, wedged or never started cannot cost the daemon a question.
Agent progress is read straight from `status.json` as well as from the feed,
because `lib/dispatch.js` writes there without raising an event, and a monitor that
sat still while an agent was visibly working would be worse than none.

Quiet state is recomputed locally every second rather than trusted from the poll —
it turns over on a clock, and "why didn't my phone buzz" is the question this is
going to be asked.

**Starting it at login.** Answer `y` to the last `npm run configure` question and
`npm run install-service` generates a second LaunchAgent, `m4m.beadcause.monitor`,
that opens the monitor in its own iTerm2 window when you log in. It is off by
default, because nobody installing this for the first time should find a terminal
window opening itself.

launchd cannot draw a window — a LaunchAgent is headless — so the agent runs
`scripts/open-monitor.sh`, which drives iTerm2 through the same
`scripts/open-session.applescript` the "discuss on the Mac" button uses. macOS will
ask once for permission to control iTerm; if it is refused, the log says so and
what to click. The agent fires once and exits; the window it opened outlives it.

```bash
npm run monitor                  # foreground, any terminal, no install needed
node bin/monitor.js --once       # one frame and exit
node bin/monitor.js --url http://100.x.y.z:4318   # watch another machine's daemon
launchctl kickstart -k gui/$(id -u)/m4m.beadcause.monitor   # reopen the window now
```

Piped rather than shown on a terminal, it drops the box and prints one line per
event instead, so `node bin/monitor.js >> somewhere.log` does something sensible.

## HTTP API

Auth on everything under `/api/` except `/api/health`: header
`x-beadcause-token: <token>`, or `?t=<token>` for URLs that have to be linkable.

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, workspaces[]}` · **no token** |
| GET | `/api/questions` | `?scope=human\|both\|agent` | `{questions[], workspaces[], spaces[], scope}` — `scope` defaults to `human`, and an unrecognised value falls back to it rather than erroring |
| GET | `/api/question` | `?workspace=&id=` | one question **plus `comments[]`** |
| GET | `/api/poll` | `?since=<seq>&wait=<s>` | long-poll: `{seq, resync, events[], questions, workspaces[]}` |
| POST | `/api/respond` | `{workspace, id, response}` | comments, then closes the bead |
| POST | `/api/comment` | `{workspace, id, text}` | comments, sets `human-replied` |
| POST | `/api/ask` | `{workspace, title, body, priority}` | `{id, key}` — files a new `human` bead |
| POST | `/api/session` | `{workspace, id}` | `{dir}` — opens iTerm2 + `claude` on that bead |
| POST | `/api/status` | `{workspace, id, phase, detail, actor}` | agent progress |
| GET | `/api/asset` | `?p=<abs path>` | image/doc bytes, restricted to `assetRoots` |
| GET | `/doc` | `?p=<abs path>` | the HTML reader page |
| GET | `/api/graph` | `?workspace=&id=` | `{nodes, links}` — the whole workspace with no `id` |
| GET | `/api/bead` | `?workspace=&id=` | one issue in full, plus `comments[]` — for the graph's detail sheet |
| GET | `/api/work` | — | `{workspaces[], elsewhere[]}` — per workspace: claimed beads, live `claude` sessions, counts, errors |
| GET | `/sessions`, `/work` | — | the current-sessions page (same page, two paths) |
| GET | `/graph` | `?ws=&id=` | the HTML graph page |

Two things that bite: `commentCount` is **0 from `/api/questions`** and only correct
from `/api/question`, because `bd human list` doesn't return it. And a question
filed through `/api/ask` is **not** pushed — you filed it yourself and are looking
at the screen — though it does raise a `created` event so other clients refresh.

A row from `scope=agent` is **not** a question: it carries `agent: true`, has no
`decision`, and its `description` is deliberately absent — fetch that from
`/api/bead`. `/api/question` is the wrong endpoint for one, because it parses the
decision block and only means anything for a `human` bead.

## Config — `~/.config/beadcause/config.json`

| key | meaning |
|---|---|
| `port`, `host` | listens on `127.0.0.1` **and** the Tailscale IP only — never the LAN |
| `token` | required on every `/api/*` call; regenerate by deleting the file |
| `workspaces` | auto-discovered from `~/beads/*/.beads`, and **reconciled on every start** — entries whose directory has gone are dropped and new ones picked up, both logged. Renaming a workspace directory used to leave a stale entry that failed on every poll tick, silently hiding that whole workspace from the phone |
| `openSessions` | allow `POST /api/session` to open a Claude session on the Mac (default `true`) |
| `sessionDirs` | override where a workspace's session opens. Normally unnecessary — see Discussing a question on the Mac |
| `sessionPermissionMode` | `--permission-mode` for an opened session (default `auto`; `null` to omit the flag) |
| `autoDispatch` | commenting spawns an unattended agent to reply (default `true`) |
| `autoDispatchExclude` | workspaces that never auto-dispatch — put shared trackers here |
| `autoDispatchTimeoutMs` | kill a dispatched agent after this long (default 10 min) |
| `spaces` | groups of workspaces sharing a notification policy — see [Spaces](#spaces--keeping-work-out-of-your-evening) |
| `claudeSessions` | `false` to stop reading `~/.claude/sessions` for the current-sessions page (default on; absent directory is not an error) |
| `claudeSessionsDir` | where those per-process records live, if not `$CLAUDE_CONFIG_DIR/sessions` or `~/.claude/sessions` |
| `assetRoots` | the only directories `/api/asset` will read images from |
| `pollSeconds` | how often new `human` beads are looked for (default 30) |
| `monitor.enabled` | generate the LaunchAgent that opens the [activity monitor](#the-monitor--what-it-is-doing-right-now) at login (default `false`; `npm run monitor` works either way) |
| `sharedServer` | leave `false` — see the note below |
| `mirrorStateToBeads` | write `agent:<phase>` state labels into beads too (off — see Progress) |
| `ntfy.detail` | `full` = question + option buttons in the notification; `minimal` = contentless nudge |
| `ntfy.minimalWorkspaces` | forced to `minimal` regardless — put shared/work trackers here |

`host` falls back to `127.0.0.1` if Tailscale was down when the config was
written — fix the IP in the file if the phone can't connect.

### Privacy of the push

An ntfy.sh topic is readable by anyone who guesses its name. The topic is random,
but work questions still default to `minimal`: the notification says only that a
decision is waiting, and the content lives behind the tailnet. Self-host ntfy and
set `ntfy.detail` per taste if you'd rather have full pushes everywhere.

The click URL deliberately carries **no** token — the PWA already has one from the
setup link, and everything in a push transits the relay. The action buttons are
the exception: they must send the token as a header to authenticate the POST. So
a `full` push on a public server does place the token on ntfy.sh. It's useless
without tailnet access, but if that bothers you, either self-host ntfy or set
`ntfy.actionButtons: false` and answer by tapping through to the app.

## Notes on bd

- **`bd human respond` is broken in bd 1.1.2** — it dies with `storage is nil`.
  Beadcause does the two steps it documents (`bd comment` then `bd close`) itself.
  If a later bd fixes it, the two-step is still fine.
- **`bd` is spawned directly, never through a shell.** `~/.zshenv` runs
  `_bd_set_workspace`, which rewrites `BEADS_DIR` from the shell's cwd — so
  `BEADS_DIR=… zsh -c 'bd …'` silently hits the wrong workspace. `execFile` does
  no shell startup, which is how one daemon serves five workspaces.
- **Don't set `sharedServer: true`** unless you've run `bd dolt start`. The
  workspaces pin `dolt_mode="embedded"`; forcing shared mode makes every command
  fail against a Dolt server that isn't listening. Writes retry through the
  embedded single-writer lock instead.
- **The public registry is pinned in `.npmrc`.** The global `~/.npmrc` points npm
  at Climative's Azure Artifacts feed with an expired token, which 401s here.
