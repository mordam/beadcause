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

### Keeping your place in a long brief

Deferring the repaint covers the case where you are typing. It does not cover the
much commoner one: reading. An open card is `position: fixed; inset: 0;
overflow-y: auto` — it takes the whole screen and **scrolls its own contents** — so
`window.scrollY` is 0 for the entire time a brief is on screen, and the list's
`innerHTML` rebuild throws that card away and builds a new one at `scrollTop` 0.
That is the jump back to the top of the card, and it is why putting `window.scrollY`
back afterwards never helped anyone with a brief open: it was restoring a number
that was zero all along. (It was doing real work for the list behind, which is why
the list's own offset is still put back too.)

Restoring the card's own offset is still not enough on its own, because mermaid
renders **asynchronously**. At the instant the position is put back, every diagram
is an empty placeholder and the card is at its shortest; the offset gets clamped to
the short content, the diagrams then draw and push everything down, and you are left
above where you were by exactly the height of the diagrams above you.

So what is stored is an *element* — the card by its key, then the way down into it
by child index to the deepest thing still starting above the fold — and it is
re-measured every time the layout changes: immediately, on the next frame, as each
image decodes, and when the diagrams finish. Each restore is absolute rather than
incremental, so a later one refines the answer instead of compounding the last.
Anything deliberate that moves the page — your thumb, a wheel, an arrow key, or the
scroll that **↑ Collapse** does to put you back on the card's head — ends the
sequence rather than fighting it. The caret, the selection and the focused textarea
come back the same way, for the repaints that genuinely cannot be deferred.

`node scripts/scroll-check.mjs` checks all of it: headless Chrome at phone size,
driving the real `public/app.js` against fixtures served by the script itself, so it
never touches a bead. It asserts that a poll leaves a long brief where it was, that
it still does when a diagram sits above the reading point and sizes late, that a
deep link naming the card you already have open moves nothing, that a forced repaint
keeps a half-typed answer with its caret, and that collapsing still lands on the
card's head. `--baseline` serves `HEAD:public/app.js` instead of the working copy —
which is how you tell a real failure from a flaky one: baseline must fail the scroll
cases, the working copy must pass all of them.

## Who you are talking to

Commenting dispatches an agent to reply — and you choose which one. Above the
comment box is a row of chips; the one you pick answers, and the foundation it
answers from is printed underneath, because an agent whose brief you cannot read is
a name you are guessing at.

Four are built in, and they are the four shapes a comment on a decision actually
takes:

| | for |
|---|---|
| 💬 **Answerer** | do the thing the comment asks. The default, and what this used to be |
| 🔍 **Researcher** | answer from evidence in the repo — real paths, quoted lines, and the cases where the evidence contradicts the question |
| 🧨 **Critic** | argue the strongest case against whatever is being proposed, with the one condition that would change its mind |
| 📋 **Summariser** | hand back the decision still left in a thread that has gone on too long |

**＋ makes a new one from a name and a foundation** — a paragraph that goes in front
of the standard thread instructions. That is the whole definition: everything else is
shared. It is saved to `agents` in the config, so it survives restarts and can be
edited by hand later.

### Allow tools — for one comment, and only that one

An agent can be given more than the read-only allowlist, and it takes two separate
acts by design: **defining** the reach, and **using** it.

**Defining** it is a config-file edit, and only that. Give the agent a `tools`
string:

```json
"agents": [
  { "id": "critic", "tools": "Bash(bd show:*) Bash(bd comment:*) Bash(git log:*) Read Grep Glob Edit" }
]
```

An entry that names a built-in only overrides the fields it sets, so the line above
is the whole of giving the Critic edit rights — its name and foundation stay where
they are. Nothing in the app can write this string; there is no endpoint that accepts
one. A form on a lock screen is the wrong place to hand out edit rights.

**Using** it is a checkbox under the agent chips, and it is spent by the comment it
rides on:

- **Off every time.** Arming applies to the **next reply only** and is dropped the
  moment the dispatch goes. Want tools on the comment after that? Tick it again.
  Nothing about it is persisted; restarting the daemon disarms everything.
- **A warning the first time, per agent.** The dialog names the tools verbatim —
  a warning that won't say what is being granted is theatre — and the acknowledgement
  is recorded per agent in `agentToolsAcknowledged`, because the content of the
  warning is *what this particular agent may now do*.
- **Not while it is answering.** Arming is refused with a 409 naming the bead:
  changing what a running agent may do is either meaningless or an attempt to widen
  it mid-flight.
- **Loud in the log.** Both the arming and the dispatch print the whole tools string
  to `~/Library/Logs/beadcause.log`, which is what makes an elevated run findable
  after the fact.

The elevated run is also told, in its prompt, that it is elevated deliberately for
one reply and should say in its comment exactly what it did with the reach.

### What a reply agent may do — and the four verbs it used to have by accident

The allowlist was `Bash(bd *)`, which is one pattern and four verbs too many: it
allowed `bd create`, `bd close`, `bd delete` and `bd label`. So the agent you chat
with could file beads without asking — the exact thing the [proposal
flow](#it-will-not-create-beads) exists to prevent — and could close the very
question it was answering. It is now named subcommand by subcommand:

```
Bash(bd show:*) Bash(bd comments:*) Bash(bd comment:*) Bash(bd list:*)
Bash(bd ready:*) Bash(bd blocked:*) Bash(bd search:*) Bash(bd stats:*)
Bash(bd memories:*) Bash(bd dep:*) Read Grep Glob
```

Adding a verb there should feel like a decision, which is why they are listed rather
than globbed. The prompt says the same thing in words — answer, never close, never
create — but the allowlist is what makes it true.

The agent's reply is authored as `--actor <agent-id>`, so the thread says which one
answered, the phase chip says which one is thinking, and the reply poller still
notifies you exactly as before (anything not authored `beadcause` is an agent
talking back). A comment costs one model run: the Critic's reply on a real thread,
which read four files and quoted line numbers, was **98s and $0.85**.

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
and two buttons. **Details** opens the bead itself in a sheet — who owns it, what it
blocks and what it waits on, then the whole body: description, **acceptance**,
**design**, **notes** and the thread, each rendered as markdown under its own label,
in the order `bd` itself prints them. Served by `/api/bead`, which is `bd show` plus
comments rather than `/api/question`'s decision shape (every node is an ordinary
issue; only some are questions). The sheet takes 72% of the screen, and **⤢** takes
the rest of it.

This is the only general-purpose bead reader in the app — the inbox card only ever
shows beads carrying the `human` or agent labels — so anything the sheet leaves out
is readable nowhere but a terminal. It used to stop after the description, which
meant the acceptance criteria, the one part you close a bead against, were exactly
that. The description alone stays unlabelled, the way it is on the card, so a bead
carrying none of the other three looks precisely as it did.

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

### The glass in the middle

A phone can hold the whole graph or one readable bead, never both. deluvia's 128
beads only fit a 393px screen by shrinking to a thirteenth, where a title measures
**1.4 css px** — the fit was working perfectly and producing a field of coloured
specks. Zooming in to read one is the obvious answer and the wrong one: you lose
the shape of the work, which is the only reason to draw a graph at all.

So the fitted view stays, and a **circle in the middle of it is magnified** — sized
for three beads across and the rows above and below, at a scale that never passes
1:1. You pan the graph under the glass instead of zooming into it. A `[ ]` reticle
frames whichever bead is under it and a pill underneath names it in full, because
a node clips its title at twenty characters and that is the one thing magnifying
cannot fix. Open the graph for a particular bead — the **What this is blocking**
link — and once the layout settles that bead slides under the glass on its own.

The magnification needs no layout maths at all. Holding the centre of the screen
fixed and scaling about it by `m` is, in screen space, exactly
`translate(c(1-m)) scale(m)` — so the loupe is a `<use>` of the scene carrying that
transform, clipped to a circle. There is no second layout and nothing to keep in
sync: the force simulation ticks the original and the copy follows.

Two things that are not obvious:

- **The copy takes no pointer events, so taps have to be re-aimed.** Inside the
  circle you are looking at the magnified copy while your finger lands on the
  shrunken original underneath — without intercepting the tap and mapping it back
  through the magnification, tapping a bead you can read selects a different bead
  you cannot. It is a capture-phase listener, so it runs before the nodes' own.
- **The glass is down until the graph has finished arriving**, and hides itself
  whenever it would magnify by less than 1.1 — at that point it is a ring drawn
  around what the screen already shows.

On a workspace as large as deluvia the glass is about as wide as the whole fitted
graph, so the overview it is supposed to sit inside has very little left to show.
That is the layout's fault rather than the loupe's: the force spreads by dependency
layer along **x**, so a portrait phone fits to width and leaves 59% of the screen
empty above and below. Rotating that axis is still open — see `bc-z7s`.

### Checking it on a phone

The graph is the one screen that was only ever verified in a desktop browser, which
is the one place it is never used. `node scripts/phone-check.mjs <workspace>` opens
it the way a phone does — headless Chrome emulating an iPhone 14 Pro at 393x852 and
3x, mobile user agent, real two-finger touch events — and asserts the four things
that only break on a phone: every bead ends up on screen, a pinch zooms, the view it
opened on is still reachable afterwards, and a tap raises the card. It needs the
daemon running; `--base=http://127.0.0.1:PORT` points it at a checkout instead, and
`--out=DIR` saves a screenshot. No dependency — it drives Chrome over the DevTools
protocol on Node's built-in `WebSocket`.

Run it with the window hidden and it will still be honest: Chrome throttles an
occluded renderer to about one frame a second, the force layout never settles, and
every measurement becomes a measurement of the throttling — so the script disables
that explicitly. That is also the answer if the numbers ever look impossible.

It also prints what the glass is doing — how much it magnifies, how big a title is
inside it, how many beads it has room for — and `--id=<bead>` opens the graph the
way **What this is blocking** does and asserts that bead ends up under it.

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

## Advocates — an agent per repo, whose job is the queue reaching zero

Everything above is a **channel**. A question reaches your phone, an answer reaches
the bead, a comment reaches an agent. None of it ever cared whether the work got
done — so a repo could sit on nine ready beads for a fortnight, and the daemon that
knew about all nine would say nothing, because none of them was labelled `human` and
nobody had asked.

An advocate is the missing party: one per repo, interested in nothing except *that*
repo's queue reaching zero.

```
poll tick ──► bd ready (minus human, minus P4)
                 │
                 ├── something ready, a slot free ──► iTerm2 + claude on the bead
                 │                                        │
                 │                                   bd close ──► slot frees
                 └── nothing ready ──► survey agent ──► "create these 3?" ──► your phone
                                                                  │
                                                     you tap create ──► bd create ×3
```

Turn them on by naming repos — the list is empty out of the box, because something
that opens Claude sessions on your Mac unprompted should never be a surprise:

```json
"advocates": {
  "workspaces": ["sophab", "beadcause"],
  "maxWorkers": 1,
  "maxWorkersLimit": 3,
  "globalMaxWorkers": 3,
  "perWorkspace": { "sophab": { "maxWorkers": 2 } }
}
```

### It has no clock

There is no schedule and no interval to tune. The daemon is already asking every
workspace what is ready every `pollSeconds`, and *a bead becoming actionable* is the
event worth waking for — so the advocates run on that same tick. Adding a timer would
only mean two answers that can disagree. The tick runs **after** the pushes, so a slow
`bd ready` across six workspaces can never delay a question reaching your phone.

### What counts as work

`bd ready`, which is already blocker-aware: it excludes `in_progress`, `blocked`,
`deferred` and hooked issues, so an advocate never pushes at something only another
bead can move. On top of that, two exclusions of our own:

- **`human` beads are yours.** A question is not work an agent can do.
- **P4 is a backlog** — a list of things deliberately not being done. Without this
  the queue can never reach zero and "clear" stops meaning anything. Move the line
  with `minPriority`.

When that set is empty the advocate says **clear** and stops. That is the whole of
"done".

### One to three sessions, and never silently fewer

`maxWorkers` is how many sessions one advocate may have open at once; it is clamped
to `maxWorkersLimit` (default 3, and a config asking for six gets three *and a log
line*, rather than failing to start). `globalMaxWorkers` caps every advocate
together, so four repos each allowed 3 cannot open twelve windows.

Whenever a cap is what stopped a launch, it says so — on the card and in the log —
because a slot limit that quietly drops a launch reads exactly like an advocate that
has decided there is nothing to do.

Each session opens the same way the **Discuss** button does: a real iTerm2 window
running `claude --permission-mode auto` in the repo, which means you can watch it,
steer it, or close it. Its brief tells it to claim the bead first, to read and obey
the repo's own `CLAUDE.md` (worktrees, tests, deploy — the daemon has no business
knowing those), and to end in one of exactly two ways: closed, or handed back to you
with the `human` label and a decision block. A session with no honest exit invents
one, and the one it invents is "close it and hope".

### It will not create beads

Opening a session on a bead you filed needs no permission — you filed it. Filing a
bead *for* you is a different act: it makes you answerable for something an agent
thought of, and a tracker full of an agent's opinions is worse than an empty one.

So when a repo runs out of ready work, the advocate spawns a **read-only** survey
agent (`bd`, `git log`, read, grep — nothing that can write) which reads the recent
closes, the blocked beads, the `## Discovered` notes sessions leave in comments, and
the repo's own docs. If it finds nothing worth filing it says so and the advocate
goes idle, which is a perfectly good outcome and one the prompt asks for explicitly.

If it does find something, you get **one ordinary question in the inbox** carrying
the entire text of every bead it wants — title, type, priority, the full
description, what done looks like, and how it found it. Nothing is created until you
say so. Approving runs `bd create` for each, labelled `advocate`, and the answer
comes back with the new ids in it.

**Each bead gets its own ✓ and ✕, and there are bulk controls above them.** A
proposal is *n* decisions that happen to arrive together, and flattening them into
all-or-nothing is what makes an agent's suggestions annoying: one good bead in three
is an ordinary outcome, and having to decline all three to avoid the two bad ones
teaches you to decline everything. So the card draws a row per bead — approve,
decline, or leave it undecided — with **Approve all** / **Decline all** beside an
undecided count, and one primary button that says exactly what it will do (*"Create 2
of 3"*). Two taps to commit, like every other answer here. The YAML block no longer
renders on the phone at all; it is parsed out and drawn as those rows.

What was **declined is recorded** on the closed question along with what was created,
because a proposal answered "create 1 and 3" and closed with only the new ids reads,
later, as though 2 was never offered.

Consent is still checked against text, because two of the three paths have nothing
else: an ntfy action button and a typed answer can only send a string. `CREATE:` on
its own means all of them; `CREATE: 1,3` picks by the numbers printed beside the
beads. The app sends both — the sentence for you, the indices as a field — and the
field wins. Free text can never create a bead by accident: *"yeah go on then"* is a
comment, which is exactly what it looks like. One open proposal per repo at a time,
and at most one every `proposeCooldownHours`.

### What you see, and where

- **The sessions page** (🤖 in the inbox) grows an **Advocate** block on each repo's
  card: what it is doing, the beads it has windows open on, what it will pick up
  next, and **Pause** / **Free slots**. *Free slots* is for "I closed those windows
  myself" — the sessions belong to iTerm, so nothing here can see them go.
- **The monitor** (`npm run monitor`) has an advocates pane above the questions, and
  every launch, close, lapse and proposal appears in its event log.
- **The launchd log** (`~/Library/Logs/beadcause.log`) carries the same events as
  `[advocate] <repo>: …` lines, and the startup banner names every repo that has one
  with the number of sessions it may open.

### How a session ends, and the parts that stay guesses

The command is typed into an interactive shell, so when `claude` exits you get a
prompt back and the window sits there forever — fine for the one you opened to talk
something through, useless for an advocate that will open dozens. So a **work**
session's command ends with two extra things: its exit status written to
`~/.config/beadcause/workers/<repo>-<bead>.done`, and `exit`, which ends the shell
and lets iTerm close the window behind it.

The file is the more valuable half. Without it the daemon can only *infer* that a
session finished; with it, three endings stop looking alike:

| the file appears and… | reading |
|---|---|
| the bead is closed | **done** — the slot frees, the attempt counter resets |
| the bead carries `human` | **handed back to you** — a documented ending, so it costs no attempt |
| neither | **exited unfinished** — costs an attempt, and the exit code is logged |

Everything else really is inference, and is treated as such. Nothing on the Mac
records which process is on which bead; an advocate knows it *opened a window* for
a bead, and that is all it knows. So:

- The bead is the evidence. Claimed means started; closed means done.
- A window closed by hand kills its shell with a SIGHUP before it can write
  anything, so the guess is kept as a fallback: a bead never claimed, with nothing
  running in that repo, is treated as closed-by-hand after `lapseMinutes` — the slot
  frees and the bead costs an attempt. After `maxAttemptsPerBead` the advocate
  leaves it alone rather than reopening the same window forever.
- A pid is shown only where the session took the bead id into its own name, which
  the brief asks it to do. Where it didn't, the row says when the window was opened
  and nothing more.

### Clearing up after it

A session that obeys its repo's rules makes a git worktree before its first edit.
Two beads a day is seven hundred worktrees a year, so the daemon sweeps them: on the
tick after a session ends, and every `tidyIntervalMinutes` otherwise.

A worktree is retired only when **all five** hold — and if any one fails it is left
alone and *named*, with the reason, in the log and on the card:

| condition | why |
|---|---|
| under `.claude/worktrees/` | never the main checkout, never `worktrees-retired/`, never anything outside |
| not locked | a lock is a session's claim on it, and `EnterWorktree` takes one |
| no live `claude` in it | nothing is moved out from under someone working |
| `git status --porcelain` empty | untracked files count; uncommitted work is never swept |
| its branch is an ancestor of `main` | everything it did is already in main |

**Retired means moved, not deleted**: `git worktree move` into
`.claude/worktrees-retired/`, the same soft delete the `ship` skill does by hand, so
it is resumable. The branch is kept deliberately — `git branch -d` refuses a branch
checked out in another worktree, and the branch is what makes the retirement
reversible. Retired worktrees accumulate; nothing here ever removes one.

Two limits worth knowing. A session's `cwd` is recorded when it starts, so a session
that later entered a worktree does not show as being *in* it — the lock is what
actually protects it, which is why `EnterWorktree` taking one matters. And the sweep
runs whether or not the advocate is paused: pausing means "open no more sessions",
not "leave the mess". `tidyWorktrees: false` is the setting that means that.

### The session log, kept in the repo

A session's window closes when it exits, the rendered log in `~/.config/beadcause/`
is per-bead and the next run overwrites it, and Claude Code's transcript lives under
`~/.claude/projects/` — outside the repo, on one laptop. Three months later the
commit is all that is left, and a commit does not say which bead it was, which agent
wrote it, or what it was asked.

So the log goes into the repo, in refs — the same trick beads uses to carry Dolt data
on `refs/dolt/*`. It is worth separating the two halves of that trick, because only
one of them is Dolt's:

- **Transport.** A ref outside `refs/heads/*` and `refs/tags/*` is invisible to
  `git log`, `git branch`, `git status` and `git checkout`, is never fetched or
  pushed unless named, and keeps its objects alive against `gc`. Dolt layers a
  database inside those objects; a log file needs no database, so these are plain
  blobs.
- **Anchoring.** Dolt attaches nothing to a code commit — its history is its own.
  Attaching data *to a commit hash* is what `git notes` is for.

Both, therefore, written when the session exits:

```
refs/beadcause/sessions/<bead>   one commit per session, chained, tree =
                                 meta.json + session.log [+ transcript.jsonl]
refs/notes/beadcause             three lines on each commit the session made — and
                                 on the merge that later lands them in main
```

Read it with plain git, which is the whole reason for storing it this way:

```bash
git log --notes=beadcause main                        # which bead wrote each commit
git log refs/beadcause/sessions/bc-bk6                # every session that worked it
git cat-file -p refs/beadcause/sessions/bc-bk6:session.log
git for-each-ref refs/beadcause/                      # note the trailing slash
```

**`session.log` is a rendering, not the transcript.** It reuses `renderEvent` from
lib/agentlog.js — the same code that draws the live pane on your phone — so one real
session came out at **31KB from a 1.7MB transcript**, which is the difference between
something you can keep forever and something you can't. The raw `.jsonl` is stored
too only where `sessionTranscripts` is on, per repo, because it is megabytes and it
carries absolute paths, environment and whatever tool output scrolled past.

`meta.json` records the branch, the worktree, the outcome, the session uuid and the
commits — plus `commitsFrom`, which says **how** the commit list was decided:
`not-in-main` when the work was still on its branch (exact), or
`since-session-start` when it had already been merged and the only remaining signal
was time (a heuristic, labelled as one rather than presented as fact). A session that
committed nothing gets no landing note at all, since its branch is trivially an
ancestor of main and the note would put its bead's name on someone else's merge.

Two caveats. `git log --all` **does** walk `refs/*`, so these commits appear there and
in some GUIs — everything else ignores them. And nothing is pushed unless you ask:
`git push origin 'refs/beadcause/*:refs/beadcause/*'` and `refs/notes/beadcause` are
explicit acts, and on a shared repo they should stay that way.

### Stopping it

Pause from the phone, per repo. `advocates.enabled: false` stops all of them.
Removing a repo from `workspaces` stops that one. A space with `"advocate": false`
vetoes every workspace in it, the same way it can veto auto-dispatch — which is the
setting that keeps applying as you add repos to a shared space, instead of being
forgotten. A quiet space's advocate **watches without launching**: the same asymmetry
as the notifications, where quiet means "not into my evening", never "hidden".

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

## The bead console — deciding what to file

Everything above acts on beads that already exist. The console is upstream of that:
a chat where you work out *what the next bead should be*, and beadcause creates it
only once you have read the proposal and pressed the button.

**🧾 in the inbox's top bar** opens it. Pick a workspace and start talking — or open
one **on an existing bead**, from *Work out the next beads from this* at the foot of
any card, which starts the conversation with that bead already read.

```
you: the install script never checks that iTerm2 is there before
     offering the monitor-at-login option

     ◗ Read install.sh   ◗ bd search iterm   ◗ Read configure.js

     Nothing in the tracker covers this. install.sh:29-48 checks Darwin,
     node, bd and tailscale but never iTerm2 — so configure.js still offers
     the monitor, the agent gets bootstrapped, and install.sh prints
     "monitor window opens at login" while open-monitor.sh fails inside
     launchd. Two things that would change the bead:

     1. warn and carry on, or skip the monitor agent entirely?
     2. installer only, or the "discuss on the Mac" button too?

     🧾 proposed 1 bead — review
```

It asks before it proposes, and it looks before it guesses: it can read the working
tree and the tracker, so "does something already cover this?" is answered rather than
assumed. A conversation that has not earned a proposal yet doesn't make one — an
early half-guessed set of beads costs you more to read than one more question does.

### The proposal is the review, so the review is editable

Tapping **🧾** opens the proposal: one card per bead, and that is exactly what will be
created. There is deliberately no second *are you sure?* screen after it — a
confirmation you cannot change is only a delay.

Tap a card and everything is editable in place: title, type, priority, description,
acceptance, labels, and — as chips naming the other beads in the proposal — **parent**
and **blocked by**. Remove a bead, or **＋** one the conversation missed. **Create N
beads** takes two taps, the same as answering a question, because creating six beads
in a tracker off a pocket tap is not undoable in any way that matters.

Your edits go back to the agent. The next thing you say arrives with the current draft
attached, so it argues with what is on your screen rather than what it last wrote —
without that it re-proposes a title you rewrote two turns ago, which reads exactly like
being ignored. And the sheet never repaints under your hands: a turn that lands while
you are mid-sentence in a description parks its revision behind a *use its version*
button instead of taking the textarea away.

Dependencies are resolved at creation time, in order — parents and in-proposal
dependencies exist before the bead that points at them. A `dependsOn` may also name a
bead that already exists (`dependsOn: [bc-7rx]`), which is how "this waits on the one
we started from" is written; those are checked against the tracker before anything is
written, so a made-up id costs a warning rather than a half-created proposal.

### A console ends when the beads exist

A console is a conversation with one purpose, and pressing **Create** achieves it. So
accepting closes it and drops you back to the list — there is nothing left to say to
a conversation whose whole subject is now three rows in the tracker, and a list where
every finished one stays open is a list you read past to find the one that isn't.

Closing is **soft**. The transcript stays on disk, the id keeps working, and saying
anything to a closed console reopens it — "one more thing" is a normal thought to
have five minutes later, and a dead end you can navigate to and not use is worse than
a row you close twice. The unspent draft *is* dropped, because cards left on screen
after a close are an invitation to create them twice.

- **✕ on any row** in the list closes it by hand — for the conversations that end by
  going nowhere rather than by filing anything. The ✕ and the row are siblings, not
  nested, so closing a console can never also open it.
- **Closed rows sink** below the live ones, dimmed, with a `closed` pill.
- **Warnings keep it open.** A create that reports one — a parent that does not
  exist, a dependency it could not resolve — leaves you on the screen that produced
  it. Dropping to the list would take the warning away before it was read.
- **Refused mid-turn**, with a `409` that says so: a console that is `thinking` has an
  agent streaming into it, and a reply arriving into something the list calls
  finished is worse than closing it twice.

Both the close and the reopen appear in the scrollback as quiet divider lines. They
belong in the history, but rendering them in an assistant bubble would read as
something the agent said.

### What it costs you to know

- **The agent cannot write to the tracker.** Its allowlist is read-only `bd` plus
  Read/Grep/Glob. That is not belt-and-braces around the prompt — the review step is
  the whole promise of the feature, and an agent that could call `bd create` would
  eventually do it mid-conversation, after which beadcause would create the same beads
  again from the proposal. One writer, and it is the button you press.
- **A turn is a fresh `claude -p`, resumed by session id** — not a process parked
  across the minutes of silence in a phone conversation, where a laptop lid or a
  `launchctl kickstart` would take the conversation with it. `--session-id` on the
  first turn, `--resume` after, so Claude Code's own transcript is the durable copy and
  a console survives a daemon restart.
- **It starts in the workspace's session directory**, the same rule the "discuss on the
  Mac" button follows (`resolveSessionDir`), so `~/.zshenv` points `BEADS_DIR` and
  `CLAUDE_CONFIG_DIR` — which tracker, and which account is billed — at the right tree.
- **A turn that reads half a repo is not cheap.** The one in the example above was
  about $0.40. `consoleModel: "sonnet"` trades some judgement for a cheaper
  conversation; `beadConsole: false` turns the whole thing off.
- **The proposal is a fenced `beads` block** in the agent's own reply, parsed the same
  way a `decision` block is (`lib/proposal.js`). It replaces rather than appends, so a
  revision re-emits every bead — merging partial proposals would mean reconstructing
  what the agent meant from a diff it never wrote.
- **Consoles live in `~/.config/beadcause/consoles/`** and are pruned after 30 days.

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

## The terminal — driving a session from the phone

That button needs you to walk to the Mac. **⌨️** in the top bar, or **Drive a session
on it from here** in a card's ⋮ menu, opens the same thing on the screen you are
already holding: the real Claude Code TUI, on a pty, over a WebSocket. Everywhere else
in beadcause you answer an agent; this is the one place you steer one.

Seeded from a card it opens on that bead with the same *talk it through, don't answer
for me* brief. Opened cold it asks which workspace, and starts there.

### It keeps running when your screen locks

This is the whole design, not a nicety. A phone that locks drops the socket within
seconds and iOS kills it the moment the tab is backgrounded — so a terminal whose
process died with its connection would lose the conversation every single time the
screen went dark, which is worse than not having one.

So the pty belongs to the daemon, not to the connection. Sockets attach and detach;
output keeps accumulating into a scrollback ring while nobody is watching; coming back
replays it into a cleared screen. Reconnecting is automatic and backs off, and the page
drops its own socket when you background the tab rather than waiting for the OS to.
What ends a terminal is quitting `claude`, pressing **⏹**, or the idle reaper — never
a dropped connection.

### The keys a phone doesn't have

Claude Code is driven by esc, ^C and shift-tab, and an Android soft keyboard offers
none of the three. The row above the keyboard is therefore the feature and not the
trim: **esc · tab · ⇧tab · ^C · arrows · ⏎**, plus **⌨** to bring the keyboard back
after a tap on one of them stole focus. They send real bytes, so ^C is a real SIGINT
handled by `claude` itself.

Rotating the phone reflows properly. The pty is resized for real — `stty` against the
slave device, which makes the kernel raise SIGWINCH in the foreground process group —
rather than the TUI being left drawn at the width it started at.

### What it costs you to know

- **The pty comes from `expect`, and could not have come from `script(1)`.** There is
  no `openpty(3)` in Node's standard library, and `node-pty` is a native module
  ABI-locked to the Node the launchd plist pins. `script(1)` is the obvious substitute
  and does not work: it calls `tcgetattr()` on its own stdin before allocating
  anything and only tolerates `ENOTTY`, while a spawned child's stdin is a socket and
  gives `ENOTSUP`. Redirecting from `/dev/null` gets past that and then there is no way
  to send a keystroke, which is the entire point. `expect` is in the base system, needs
  no Homebrew and no npm, relays raw bytes both ways over ordinary pipes, and writes
  out the slave device name — which is what buys back the resize. See the long note at
  the top of `scripts/pty-relay.exp`.
- **It starts in the workspace's session directory**, by `resolveSessionDir` and
  nothing else — the same rule the "discuss on the Mac" button and the bead console
  follow, so `~/.zshenv` points `BEADS_DIR`, `BEADS_ACTOR` and `CLAUDE_CONFIG_DIR`
  (which tracker, and which account is billed) at the right tree.
- **The token rides as a WebSocket subprotocol**, `new WebSocket(url, [proto, tok])`,
  never in the URL. A browser cannot set a header on a handshake, and the query string
  is the one place a secret must not go — it is what ends up in history and in every
  log between here and there. The same token as everything else; the same tailnet.
- **Permission prompts are left on.** `terminalPermissionMode` defaults to `null` —
  inherit whatever your settings do — unlike `sessionPermissionMode`, which is `auto`
  precisely because nobody is watching. Here you are watching; the prompts are the
  point. The brief asks the agent to batch what it needs approved, because every
  prompt is a tap on a keyboard you can barely hit.
- **Idle terminals are reaped.** After `terminalIdleMinutes` (default 30) with no
  socket attached, a terminal is closed. The clock only runs while nobody is watching:
  a session you have open is never reaped for being quiet, because quiet is exactly
  what one looks like while it reads a repo. At most `terminalMax` (default 4) at once,
  and the daemon kills them all on shutdown — outliving a *socket* is the point,
  outliving the process that owns them is a leak.
- **Scrollback is bytes, not lines** — `terminalScrollbackBytes`, 256 kB by default —
  and it is kept as raw chunks, never decoded on the way in. A pty splits UTF-8
  sequences across chunk boundaries constantly, and decoding per chunk would put
  replacement characters in the scrollback permanently. When the ring overflows you get
  a one-off "scrollback was trimmed" toast.
- **This is a bigger escalation than `POST /api/session`** — arbitrary interaction with
  an agent rather than one fixed command — so it has its own switch: `terminal: false`.
  It is on by default, on the grounds that what gates it (tailnet plus token) already
  gates a button that starts an *unattended* agent on the same Mac.
- **`script(1)`'s limitation is gone, but `ws` is a dependency.** If the daemon starts
  without it installed the terminal switches itself off with a warning and nothing else
  is affected — an install that pulls this update and restarts before `npm install`
  loses one page, not the inbox.

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
| POST | `/api/respond` | `{workspace, id, response, create?}` | comments, then closes the bead. `create` is the 1-based indices of an advocate proposal's beads to file; without it, `CREATE:` in the text means all and `CREATE: 1,3` means those |
| POST | `/api/comment` | `{workspace, id, text, agent?}` | comments, sets `human-replied`, dispatches that agent to reply (default when absent or unknown) |
| POST | `/api/ask` | `{workspace, title, body, priority}` | `{id, key}` — files a new `human` bead |
| POST | `/api/session` | `{workspace, id}` | `{dir}` — opens iTerm2 + `claude` on that bead |
| POST | `/api/status` | `{workspace, id, phase, detail, actor}` | agent progress |
| GET | `/api/asset` | `?p=<abs path>` | image/doc bytes, restricted to `assetRoots` |
| GET | `/doc` | `?p=<abs path>` | the HTML reader page |
| GET | `/api/graph` | `?workspace=&id=` | `{nodes, links}` — the whole workspace with no `id` |
| GET | `/api/bead` | `?workspace=&id=` | one issue in full, plus `comments[]` — for the graph's detail sheet |
| GET | `/api/work` | — | `{workspaces[], elsewhere[], advocates[]}` — per workspace: claimed beads, live `claude` sessions, counts, errors |
| GET | `/api/agents` | — | `{agents[], default}` — the roster you can address a comment to |
| POST | `/api/agents` | `{name, description}` | creates one and returns the new roster. `tools` is never accepted here |
| POST | `/api/agent-arm` | `{id, acknowledge?, disarm?}` | arms that agent's configured tools override for **one** reply. `428` the first time, carrying the warning to show; `409` while it is answering; `400` if it has no override |
| DELETE | `/api/agents` | `?id=` | removes one of yours; built-ins refuse |
| GET | `/api/advocates` | — | `{advocates[]}` — per repo: queue, open sessions, note, error |
| POST | `/api/advocate` | `{workspace, action}` | `pause` · `resume` · `release` (free the slots) · `forget` (clear attempt counters) |
| GET | `/api/advocate-log` | `?workspace=` | the survey agent's transcript, as the CLI would have shown it |
| GET | `/api/session-archive` | `?workspace=&id=` | the archived sessions for a bead |
| GET | `/api/session-archive` | `?workspace=&commit=&file=` | one archived `session.log`, `meta.json` or `transcript.jsonl` |
| GET | `/sessions`, `/work` | — | the current-sessions page (same page, two paths) |
| GET | `/graph` | `?ws=&id=` | the HTML graph page |
| GET | `/api/consoles` | — | `{consoles[], workspaces[]}` — every bead console, newest first; `closedAt` set on the finished ones |
| POST | `/api/console/close` | `{id}` | soft-closes it and returns the new list. `409` mid-turn; saying anything to it reopens it |
| POST | `/api/console` | `{workspace, seed?}` | `{id, console}` — opens one; a `seed` bead auto-starts the first turn |
| GET | `/api/console` | `?id=` | the whole console: messages, draft, created beads |
| POST | `/api/console/message` | `{id, text}` | starts a turn and returns — follow it on `/api/console/poll` |
| GET | `/api/console/poll` | `?id=&since=&wait=` | long-poll: the whole console, once its `seq` moves |
| POST | `/api/console/draft` | `{id, draft}` | the cards as you edited them; re-normalised on the way in |
| POST | `/api/console/create` | `{id, draft?}` | `{created[], warnings[]}` — **the only writer in the console** |
| GET | `/console` | `?id=` or `?ws=&seed=` | the bead console page |
| GET | `/api/terminals` | — | `{terminals[], workspaces[], enabled}` — every terminal, newest first |
| POST | `/api/terminal` | `{workspace, id?, cols?, rows?}` | `{terminal}` — opens one; an `id` seeds it on that bead |
| GET | `/api/terminal` | `?id=` | `{terminal}` — one, without its bytes |
| POST | `/api/terminal/close` | `{id}` | ends it (SIGTERM, then SIGKILL after 5s) |
| WS | `/ws/terminal` | `?id=`, subprotocols `beadcause.term.v1` + `tok.<token>` | binary frames both ways are pty bytes; JSON carries `hello` · `ready` · `exit` in, `input` · `resize` · `close` out |
| GET | `/terminal` | `?id=` or `?ws=&seed=` | the terminal page |

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
| `beadConsole` | allow the [bead console](#the-bead-console--deciding-what-to-file) to open conversations and create beads (default `true`) |
| `consoleModel` | model for a console turn (default `null` — whatever `claude` uses on its own; `"sonnet"` for a cheaper conversation) |
| `consoleTimeoutMs` | kill a console turn that has been going this long (default 15 min) |
| `terminal` | allow the [in-app terminal](#the-terminal--driving-a-session-from-the-phone) to open a real Claude Code session over a WebSocket (default `true`) |
| `terminalPermissionMode` | `--permission-mode` for a terminal (default `null` — inherit your settings; unlike `sessionPermissionMode`, you are sitting in front of this one) |
| `terminalIdleMinutes` | close a terminal nobody has been watching for this long (default 30; the clock only runs with no socket attached) |
| `terminalScrollbackBytes` | replayed on reconnect, so a locked screen misses nothing (default 256 kB) |
| `terminalMax` | how many terminals may be open at once (default 4) |
| `autoDispatch` | commenting spawns an unattended agent to reply (default `true`) |
| `autoDispatchExclude` | workspaces that never auto-dispatch — put shared trackers here |
| `autoDispatchTimeoutMs` | kill a dispatched agent after this long (default 10 min) |
| `advocates.workspaces` | which repos get an [advocate](#advocates--an-agent-per-repo-whose-job-is-the-queue-reaching-zero). **Empty by default**; `["*"]` for every one |
| `advocates.maxWorkers` | sessions one advocate may have open at once (default 1), clamped to `maxWorkersLimit` |
| `advocates.maxWorkersLimit` | the ceiling that clamps it (default 3). A larger `maxWorkers` is clamped **and logged**, never silently applied |
| `advocates.globalMaxWorkers` | across every advocate (default 3), so four repos can't open twelve windows |
| `advocates.perWorkspace` | per-repo overrides, e.g. `{"sophab": {"maxWorkers": 2}}` |
| `advocates.minPriority` | beads above this priority aren't work (default 3 — P4 is a backlog) |
| `advocates.propose` | ask to create beads when the queue empties (default `true`; **nothing is ever created without your approval**) |
| `advocates.proposeCooldownHours` | at most one ask per repo per this many hours (default 12) |
| `advocates.settleSeconds` | how long a new bead sits before a session opens on it (default 60) |
| `advocates.lapseMinutes`, `advocates.maxAttemptsPerBead` | when an unclaimed window is treated as gone, and how many times one bead may be retried |
| `advocates.respectQuietHours` | a quiet space's advocate watches without launching (default `true`) |
| `advocates.tidyWorktrees` | retire merged, clean, unlocked worktrees after a session ends (default `true`) — moved to `.claude/worktrees-retired/`, never deleted |
| `advocates.tidyIntervalMinutes` | how often it sweeps when nothing has just finished (default 15) |
| `advocates.sessionLog` | archive each finished session to `refs/beadcause/sessions/<bead>` and note its commits (default `true`) |
| `advocates.sessionTranscripts` | also store the raw Claude Code transcript — megabytes, and it carries paths and tool output (default `false`; set per repo in `perWorkspace`) |
| `agents` | extra reply agents beyond the four built in — `{id, name, emoji, description}`, plus `tools`/`model` if you set them by hand |
| `defaultAgent` | which one answers when you haven't picked (default `answerer`) |
| `agents[].tools` | the allowlist that agent may be *armed* with, for one reply at a time. Config-file only — see [Allow tools](#allow-tools--for-one-comment-and-only-that-one) |
| `agentToolsAcknowledged` | agents whose extended-tools warning you have accepted; written when you accept it |
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

### Environment

| variable | meaning |
|---|---|
| `BEADCAUSE_CONFIG_DIR` | where the config, state and tokens live (default `~/.config/beadcause`). Isolates **only those** — see [observer mode](#a-second-instance--observer-mode) before booting a second instance |
| `BEADCAUSE_OBSERVE` | watch and never act: no sessions, proposals, sweeps, session logs, reply agents or pushes. `BEADCAUSE_READONLY` is the same flag |
| `BEADCAUSE_NODE` | the `node` the LaunchAgent runs (`scripts/install.sh`, `scripts/open-monitor.sh`) |
| `BEADCAUSE_BROWSER` | which browser `scripts/open-monitor.sh` opens the console in |

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

## A second instance — observer mode

Sooner or later you want to look at a change to the UI without restarting the live
daemon on `:4318`, so you boot a second one on a spare port with its own config
directory. **Do not do that without `BEADCAUSE_OBSERVE=1`.**

`BEADCAUSE_CONFIG_DIR` isolates the config, the state file and the token. That is
*all* it isolates. The tracker, the repos and `.claude/worktrees/` belong to the
machine, so a second daemon is a second **fully live** daemon: it has its own
advocates, its own poll loop, and no idea the first one exists. Booted from a copy
of your real config, its first tick — thirty seconds in — opened two Claude sessions
in two repos and retired a worktree in the shared checkout. Nothing malfunctioned.
It did exactly what the live one does, twice.

So:

```sh
mkdir -p /tmp/bc
jq '.port=4372 | .baseUrl="http://127.0.0.1:4372" | .host="127.0.0.1"' \
  ~/.config/beadcause/config.json > /tmp/bc/config.json

BEADCAUSE_CONFIG_DIR=/tmp/bc BEADCAUSE_OBSERVE=1 node bin/beadcause.js
```

Reach it at `http://127.0.0.1:4372/?t=<token from that config>`. Pick the port
yourself and check it's free — `4319` is taken by something unrelated on this Mac.

It says so at startup, unmissably, because the way this flag fails is you believing
you set it:

```
[beadcause] ─────────────────────────────────────────────────────
[beadcause] OBSERVING — this instance watches and never acts.
[beadcause]   no sessions · no proposals · no worktree sweeps
[beadcause]   no session logs · no reply agents · no ntfy push
[beadcause]   the terminal, the bead console and answering still work
[beadcause] ─────────────────────────────────────────────────────
```

**What it switches off** — everything the daemon would do on its own:

| off | otherwise |
|---|---|
| advocates opening sessions | a real Claude window per ready bead, in the shared checkout |
| bead proposals | a survey agent, and a question in your inbox from an instance you booted to look at CSS |
| worktree sweeps | `.claude/worktrees/` retired out from under sibling sessions — the one act that reaches outside the config directory to move somebody else's work |
| session logs | `refs/beadcause/sessions/*` and git notes written into repos this instance is only visiting |
| reply agents | two daemons dispatching two agents at the same comment |
| ntfy push | two notifications per question, whose buttons answer on two different ports |
| `POST /api/session` | the one button whose consequence is an hour of unattended agent |

Advocates still **survey**, so the ready queue and what each would pick up next are
on screen — that is usually the thing you booted a second instance to look at. Each
card reads `observing — this instance never acts on its own · N ready`.

**Which daemon am I looking at?** An amber `⦿ OBSERVING` badge sits beside the page
title on `/monitor` and `/work`, and beside the name in the terminal monitor. The
advocate cards say it too, but an instance with *no* advocates configured would
otherwise look identical to the live one — and believing you are in observer mode
when you are not is the whole failure this mode exists to prevent. The signal is one
field, `observing`, on `/api/work` and `/api/poll`; it is `false` on the live
instance rather than absent, so a console can never paint the badge over a daemon
that is in fact opening windows.

**What still works** is everything you sit in front of: the terminal, the bead
console, answering and commenting on questions. A mode that broke those would be a
mode nobody uses. Note the tracker is shared regardless — a bead you create from the
console of an observer instance is a real bead, and an answer is a real answer.

Nothing is written to the config file: your switches stay as you set them, and the
mode is asked about at each point where the daemon would otherwise act. That also
means it cannot leak into the live instance. `BEADCAUSE_READONLY=1` is accepted as
the same flag — not for elegance, but because the one failure worth engineering
against here is typing the name slightly wrong and getting silence.

**This is not the sandbox for testing the advocates themselves.** It stops them
acting; it does not give them a private tracker or a private checkout. To watch an
advocate actually launch something, use the live instance and its pause/resume
controls.

### `npm test`

The repo has one test file, `test/observe.mjs`, and it is about this flag only —
because this is the only switch here that fails *silently*. Turn off the terminal
and the terminal is gone; get this one subtly wrong and everything looks fine until
there are two Claude windows open on repos you weren't working in. It checks that
the flag reads the way this section says (both spellings, and `0`/`false`/empty
meaning off), that an armed advocate with a full queue surveys and launches nothing,
that no reply agent or push goes out, that `/api/work` and `/api/poll` carry the
`observing` field the badge is drawn from — and, as the control, that with the flag
off all of that goes down the ordinary path and the field reads `false`.

The mirror-image test is deliberately absent: "with the flag off, does an advocate
really open a window?" can only be answered by opening one. That is the incident
this flag exists because of, so the suite proves the guards are *conditional* and
stops there. Everything else is still gated by `node --check` on changed files and
by booting an observer instance and driving it.

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
