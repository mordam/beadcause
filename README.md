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

The questions, all with a safe default on Enter: **what the agents should call you**
(the name every prompt, pull request body and bead note uses — guessed from your git
identity), which workspaces are **shared with
other people** (those get a contentless push and no unattended agents), where your
**code lives** (so a question can show you files from it), whether your shell
**derives `BEADS_DIR` from the working directory**, whether to use **ntfy**,
whether commenting should **spawn an agent** to answer you, and whether to open the
**[activity monitor](#the-monitor--what-it-is-doing-right-now)** at login. Re-run them any time
with `npm run configure`; nothing is written until the last answer, so Ctrl+C is
always safe.

```bash
npm run monitor              # live view of what the daemon is doing
npm run check                # the checks around the agent log — safe with the daemon up
npm run swap:status          # which build is actually answering the port
npm run uninstall-service    # remove the service (keeps your config and token)
tail -f ~/Library/Logs/beadcause.log
launchctl kickstart -k gui/$(id -u)/m4m.beadcause   # only for bin/router.js itself
```

**You do not restart it after editing `lib/`.** What launchd runs is
[the router](#the-router--why-you-never-restart-it), which swaps a fresh backend in
under the port a few seconds after the files settle.

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
- **Nothing is exposed beyond the tailnet.** The router binds `127.0.0.1` and your
  Tailscale IP, never `0.0.0.0`; the backends behind it bind loopback only.
- **Editing `lib/` needs no restart.** The router swaps a fresh backend in under the
  port a few seconds later — see [The router](#the-router--why-you-never-restart-it)
  for what it will and will not do for you.
- **`npm run check` is not a test suite.** It is one file — `scripts/check-agent-log.js`,
  the contract the [session log](#watching-it-work--the-session-log) rests on — and it
  says so rather than pretending to cover the rest. It runs against a throwaway config
  directory on an ephemeral port and never touches `bd`, so it is safe to run with the
  daemon up. The suite proper is `npm test`, and the browser checks it deliberately
  leaves out are listed with the pages they cover.

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
- `docs` are files on the Mac you need to read before answering. Each opens in the
  **reader** (`/doc?p=…`) as a [drawer over the card you were
  reading](#detail-opens-over-the-tab-not-instead-of-it): markdown is rendered,
  text/log/csv shown as-is, PDFs embedded. Relative links inside a rendered markdown
  doc resolve against that doc's directory, so a spec that links its sibling files
  stays navigable — and follows into the same drawer. Servable extensions are images plus
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
- **Write the prose as paragraphs; the hard wrap doesn't survive.** bd stores a
  description, notes, design or acceptance hard-wrapped at about 78 columns, and
  on a phone each of those lines wraps again — so anything that came out of bd
  renders with markdown's `breaks` off and reflows into real paragraphs and real
  lists. A blank line is what makes a new paragraph, there as anywhere. Comments
  are the other way round: someone typed those on a phone, meaning every newline,
  so a comment keeps the line breaks it was written with.

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

- **An open card takes the screen.** It used to expand inline, which on a phone
  meant the brief, the thread and the answer box all competed with the list around
  them — a question is read one at a time. Open, a card is `position: fixed` across
  the viewport with the list underneath it, and there is a way out at each end:
  **↑ Collapse** in the top corner, where your thumb already is when the card opens,
  and another at the foot of the brief, where you land after a diagram and a thread.
  Collapsing scrolls you back onto the card you were reading rather than leaving you
  wherever the shrinking list happened to put you.
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
- **Or dismiss it**, under the two buttons: the question you are never going to
  answer, closed with nothing written on it. Two taps like everything else that
  closes a bead, and the second one spells out what it is about to do — *Tap again —
  closes bc-7qo unanswered*. Anything already in the box rides along as the reason,
  and the label says so before you commit rather than after. It closes the question
  and **nothing else**: no proposal is created, no amendment committed, no pull
  request merged or declined — "I am never going to answer this" is not consent to
  any of them, so a dismissed delivery leaves its PR open on GitHub. The one thing
  it does record is a refusal, when the question was an agent asking to be changed;
  without that the request is not refused but unheard, and it comes back next week.
- **From the notification**, when a question has ≤3 options: ntfy's action buttons
  POST the answer straight to the daemon over the tailnet.

Either way the answer lands as a comment authored by `beadcause` and the bead
closes with reason "Answered via Beadcause" — or "Dismissed via Beadcause", with
your note after it, for the one that was never answered. Both write the line as a
comment *and* as the close reason, because `bd show` prints the reason months later
and an agent watching the thread only ever sees comments.

`node scripts/dismiss-check.mjs` holds the dismissal to all of that in headless
Chrome at phone size: that one tap writes nothing, that the arm expires and any
other armed control steals it, that the note reaches the wire as a `reason` and
never as a `response` — a dismissal read as an answer would be read for markers,
and `MERGE:` in the box would merge a pull request you meant to walk away from.
`node test/dismiss.mjs` is the other end: the argv `bd` actually receives, pinned
because `bd human dismiss` — the subcommand this obviously wants — is broken in bd
1.1.2 the same way `bd human respond` is.

### When bd will not close the bead

*Answer & close* is two writes, and only the second one has a gate on it. bd
refuses to close a bead **blocked by open dependencies**, and refuses to close an
**epic with open children** — both with a sentence and a `--force` you are not
being offered here.

That used to arrive as a failure. The comment went in first, the close threw, and
the whole answer came back to the phone as a red toast over a question that had in
fact been answered. The card stayed in the inbox looking untouched, so it got
answered again — five beads across two workspaces ended up carrying the same
answer two and three times over, and one of them says *"Do your best"* four times.

So the refusal happens **before anything is written**. The server asks the two
questions bd would ask — the `blocks` dependencies that are still open, and, for
an epic only, the children that are still open — and answers with a `409` carrying
the reason and the beads behind it. Nothing is commented, nothing is created, and
the question is exactly as answerable as it was a moment ago.

What you get is not an error. The card comes back with the reason on it, the
blockers named and linked into the graph, and the offer: **Save as a comment**,
which is the half that was always going to work. Three things about it are
deliberate:

- **The note lives on the card, not in a toast.** A toast is gone in three
  seconds, and the one conclusion that must never be reached here is *the answer
  was lost*. Your draft is still in the box underneath for the same reason.
- **It is amber, not red** — the same `--warn` as the unfinished mark down a
  card's edge. Something is incomplete and waiting on you; nothing went wrong.
- **Saving goes down the ordinary comment path** — same endpoint, same
  `human-replied` label, same agent dispatched. What you typed is a reply on a
  thread, and the only thing the tracker refused was the closing of the bead.

There is deliberately **no force-close**. "Close this epic over its 24 open
children" is not a decision to take from a lock screen, and a `force` flag that
skipped the check would only reach the same refusal from bd a moment later, since
`respond` does not pass `--force` either.

### Dismissing is a close too

**Every path that closes a bead has to ask, not just the one that answers it.** The
answer path was fixed first, and `/api/dismiss` — *Dismiss without answering* — was
written in the same week, did the same two writes in the same order, and asked
nothing. So it shipped carrying the identical bug, and dv-gr6 collected three
`Dismissed via Beadcause` comments, one per attempt.

It gates the same way now, ahead of the refusal record it owes an amendment
request as well as ahead of the write — a dismissal that never happened must not
tell an agent its request was refused. What differs is the offer. An answer always
has something worth keeping; a dismissal is usually wordless, which is the ordinary
case, and a **Save as a comment** button over an empty box would save nothing and
say it had. The server decides which in `canComment`, because it is the side that
knows whether a note came with the request, and the note says *cannot be dismissed*
rather than *cannot be closed*.

The one close that is deliberately **not** gated is the work bead a merged pull
request finishes. That one is already `.catch`-ed and logged: the merge has
happened by then, and failing the request over a bead that would not close would
be reporting the merge as a failure.

### Checking it

Three, because the three things that can break here are different things:

- **`node test/closegate.mjs`** — the gate itself: the two refusals, and, the
  expensive half, the six cases that must **not** be refused. A question bd would
  close happily becoming unanswerable from the phone is a worse bug than the one
  this fixes, and a silent one.
- **`node test/closepaths.mjs`** — that the endpoints actually *ask* it. A
  different claim, and the one that broke: `closeGate` was correct the whole time
  `/api/dismiss` was not calling it. Both endpoints are driven over real HTTP with
  `cfg.bdBin` pointed at a fake `bd`, so *"nothing was written"* is asserted
  against the argv bd would have been given. It fails 7/12 against the version
  before this section was written.
- **`node scripts/gate-check.mjs`** — what it looks like in your hand: headless
  Chrome at phone size driving the real `public/app.js`, asserting mostly what must
  *not* happen — no error toast, no write, the draft still in the box. Note what it
  cannot tell you: the fixture supplies the 409 itself, so it passes whether or not
  the real server would send one. That is `closepaths`' job, and the reason it
  exists. `--baseline` serves the committed `app.js`/`style.css`; `--out=<dir>`
  writes the note.

### Where the answer goes

Answering used to end in a dead pause. The card dimmed to half opacity, a
"Recording your answer…" row appeared under it, and then nothing happened at all
for as long as `bd` spent retrying against the Dolt lock — a second, sometimes
three — after which the list rebuilt itself and the card was simply gone. Dim,
hang, jump cut. Nothing said where the thing you had just decided went, and on a
slow write it read as a freeze rather than as work.

What happens instead is that **the answer becomes a bead, and the bead goes into
the tracker**, in six steps:

1. **Collapse.** The open answer view shrinks and rounds down in place, from card
   to a single bead-sized circle, floating *in front of* a list that has already
   reflowed underneath it. The card is gone by the time the bead exists.
2. **Ignite.** At bead size it pulses once, white → blue, and holds blue.
3. **Travel.** It arcs across the screen toward the app mark in the top-left of the
   header — an arc, not a shove.
4. **Attract.** Just short of the mark the motion goes magnetic: it stops coasting
   and starts being pulled.
5. **Thread.** A line grows out of the mark to meet it. Contact is capture.
6. **Absorb.** It is drawn straight down the thread into the mark and swallowed,
   and the thread retracts with it.

**One bead per bead created, plus one for the bead you answered.** Approving an
advocate's proposal files N beads in the same call, and today they arrived with no
ceremony whatsoever; now each one flies its own arc, and the created ones pulse
**green and faster** than the answered one's single slow blue pulse. The thing you
decided and the things your decision made should not look identical. They fan out
around the mark rather than stacking on it, each with a thread of its own, because
four beads landing on one point look like one bead.

Four things about this are load-bearing, and each of them is a way it could have
been built wrong:

- **It plays over the wait, not after it.** The flight starts on the tap and the
  write is issued behind it. Everything up to *attract* runs while the request is
  out; the beads then hold in the magnetic zone, visibly being pulled, for however
  long `bd` takes. The latency lands in the one part of the sequence that already
  looks like something is happening. A flight that began when the response arrived
  would only have moved the pause somewhere else.
- **A refused write takes it back.** The last step is gated: the beads are absorbed
  only once the server has accepted, and if it hasn't they fly home the way they
  came and the card re-opens underneath them with your text still in it. A tracker
  that rejected your answer must not be shown swallowing it. Which is why the card
  is removed *optimistically* but every piece of state it was built from — its index
  in each channel, whether it was open, the proposal's per-bead yes/no, and above
  all the draft, which is still only cleared once the server says yes — is kept
  until the write resolves. A poll that overlaps the write is suppressed for that
  one bead, or the list would drop a card back underneath the flight leaving it.
- **A comment ends differently, deliberately.** *Comment only* does not close the
  bead, so nothing is absorbed: the card collapses to a bead on the tap and the bead
  settles back onto the row it came from. The mark eating a bead that is still open
  would be a lie about what just happened.
- **The beads are not in the list.** They live on a fixed overlay on `<body>`,
  because `render()` destroys the card they came out of while they are still in the
  air. A flight parented to that card would be wiped out by the very repaint it
  exists to cover.

With `prefers-reduced-motion` nothing is put in the air at all — the end state is
reached directly, per the convention the rest of the app follows. The target is
resolved from a short list of selectors ending at `.brand`, so the mark can be
swapped for something else without any of the geometry being redone.

`node scripts/absorb-check.mjs` checks all of it: headless Chrome at phone size,
driving the real `public/app.js` and `public/absorb.js` against fixtures served by
the script itself, with `/api/respond` deliberately slow — which is what turns a
1.5-second animation into something a test can stand in the middle of and measure.
It asserts that the card leaves the list on the tap rather than when the write
lands, that what replaces it is a bead-sized circle on the overlay, that approving
three beads puts four in the air in two colours, that a forced repaint underneath
destroys none of them, that they arrive at the mark and are held there with nothing
threaded while the write is still out, that a thread then grows and the overlay ends
empty, that a refused write returns them and gives the card back with the typed
answer verbatim, that a comment is never threaded, and that with reduced motion no
bead ever moves and the card still goes. `--baseline` serves the committed `public/`
instead of the working copy — which is how you tell a real failure from a flaky one:
baseline must fail every flight case and pass the controls. `--shots` drops a PNG per
stage into `.claude/shots/`, because the one thing an assertion about coordinates
cannot tell you is whether it looks like anything.

### The answer box does not scroll away

An open card is the same three-part shape the bead console uses: a **head that
stays** — workspace, id, the question, its option buttons — a **brief that scrolls
on its own**, and the **answer box pinned to the bottom of the screen**. Before
this the card was one long scroller, so on a bead with a real description the box
sat several screens below the fold: you read down, scrolled back to reply, and
every glance back at the details lost the box again.

The composer needs no position of its own. The card is already a fixed full-screen
layer, so once the card stops being the scroller its last row *is* the bottom of
the screen. The keyboard is handled a level up — the Android activity is
`windowSoftInputMode="adjustResize"` and the page asks a browser for
`interactive-widget=resizes-content` — so both shrink the layout viewport rather
than sliding the keyboard over a fixed layer, and the box comes up with it.

Resizing the viewport is also what makes the keyboard the hard case, because it
takes a third of the screen away at the moment you most need the box. So the rows
above the brief **shrink rather than push**: the question, the options and an open
session log each get a share of what is left and scroll within it, in the order
they can most afford to, and the brief keeps a floor of 80px so there is still a
strip of the details to glance at while you type. Nothing switches layout on
focus — a card that unpinned the box the moment you tapped it would be worse than
one that never pinned it.

Below **440px** of viewport it does switch: the card goes back to being one long
scroller. That threshold has the keyboard on the right side of it deliberately — a
phone with the keyboard up is still around 500px, a phone on its side is around
390px, and only the second one genuinely wants the old shape back, because head,
options and composer are the better part of 400px between them.

**Landscape with two real columns undoes the pin**, deliberately. There the
question and its options are already pinned on the left while the brief scrolls on
the right, so the answer box just sits at the foot of the left column — visible
without pinning, and the card can scroll as a whole if that column runs long.

### Keeping your place in a long brief

Deferring the repaint covers the case where you are typing. It does not cover the
much commoner one: reading. An open card is `position: fixed; inset: 0` — it takes
the whole screen and **scrolls its own contents**, its `.brief` in the shape above
or the card itself on a viewport too short for it — so
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
image decodes, and when the diagrams finish. **Which part of the card was scrolling
is stored by name, not measured twice**: straight after a rebuild the card is at its
shortest and would measure as scrolling nothing at all, so capture decides — the
brief, the card, or the page — and restore obeys. The fold the descent measures
against is the top of *that* scroller rather than the top of the card, or with the
head fixed it would match the head every time and never reach the brief. Each
restore is absolute rather than
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

### One open at a time, and where you are in the list

Opening a question **collapses whichever one was open before it**. An open card is a
fixed full-screen layer, so before this a second one just stacked on the first — tap a
notification while reading, close what it opened, and you were looking at a brief you
had already finished with rather than the list. Left to accumulate they also made the
list unscrollable in the only sense that matters: you could not find your place in it.

**Collapsing is never suppressed, not even for an unsent draft.** The alternative — a
card that refuses to close because you started typing in it — trades a small surprise
for a bigger one. Instead the card comes back **marked in orange down its left edge**,
so a question you have half answered is legible from the list while you scroll past it.
Same `--warn` as the "draft saved" flag it sits beside, deliberately: one orange, one
meaning. It is a solid edge where the P0/P1 pill is a 22% tint of the same colour, so
*high priority* and *unfinished* can't be mistaken for each other. The mark comes off
where the draft does — on **Comment only**, which is the one path that clears a draft
and leaves the card in the list.

Scrolling raises a **"5 of 9"** against the right edge, with a rail whose thumb is
sized by how much of the list is on screen: how many above, how many below, how many
in total, which several open questions otherwise give you no sense of at all. It fades
out 1.6s after you stop, because it is a navigation aid and not a permanent fixture
sitting on top of a card's buttons. It counts what the space and workspace chips have
left in the list rather than what the server sent, and it is hidden entirely while a
card is open — that card scrolls itself, and a count of the list underneath would be
describing something you can't see.

Both are painted the way `paintArmed()` is — a class toggled on the card in place, not
a `render()` — so nothing here can rebuild the list under a half-typed answer.

### Reading a paragraph bd folded at 78 columns

bd hard-wraps what it stores. A phone is narrower than 78 columns, so every one of
those stored lines wraps again on its own — and rendering markdown with `breaks` on
puts a `<br>` at each fold as well, which draws a paragraph as a staircase and a
folded list item as two lines of loose prose. Turning `breaks` off everywhere is not
the fix either: a comment is typed on the phone, by a person, who means the newlines
they put in.

So `renderMarkdown` takes the flag rather than assuming it, and the caller decides.
Description, notes, design, acceptance and the decision block's own context came out
of bd and reflow; comments and chat-session messages were typed and keep their breaks. The
graph's detail sheet follows the same split.

`node scripts/wrap-check.mjs` checks both halves, in the same headless-Chrome-on-
fixtures way as the scroll check, over the inbox card and the graph sheet: a folded
paragraph comes back as one sentence with no break in it, a folded list item stays
one item, and a three-line comment still has its two breaks. `--baseline` serves
`HEAD:public/app.js` and `HEAD:public/graph.js`, where the bd-prose cases must fail.

## Who you are talking to

Commenting dispatches an agent to reply — and you choose which one. The answer box
says which, on a strip along its top edge: **Comment only → 💬 Answerer replies**. It
names the button as well as the agent, because the choice governs exactly one of the
two: a comment dispatches, and **Answer & close** spawns nobody.

The roster itself is behind the **⋯ at that strip's right-hand end** — chips for
every agent, ＋ to make one, the foundation of the one selected, and the allow-tools
checkbox. It used to be drawn in full every time a bead opened, which on a phone was
several centimetres of a control nearly every comment leaves alone, sitting between
the thread you had just read and the box you were about to type in. Folded, but not
hidden: which agent replies stays on the strip, and so does an armed tools override —
[that one is spent the moment you send](#allow-tools--for-one-comment-and-only-that-one),
so a shut panel must never leave the box looking ordinary. Choosing a chip repaints
the panel and nothing else, so it cannot eat a half-written comment. Escape closes
it and leaves the caret where it was.

The foundation of the selected agent is printed in the panel rather than left to the
name, because an agent whose brief you cannot read is a name you are guessing at.

`node scripts/agent-chooser-check.mjs` checks the fold and, more to the point, what
the fold must not hide: headless Chrome at phone size driving the real
`public/app.js` against a roster built by `lib/agents.js` and a question parsed by
`lib/decision.js`, so it never touches a bead. It asserts the thread runs into the
box with no chooser in between, that the ⋯ sits on the box's top-right corner and
says which agent replies without being opened, that the panel holds everything the
old block drew, that choosing a chip or arming tools keeps a half-typed comment and
leaves the panel open, that an armed override shows with the panel shut, and that
the trigger is labelled, `aria-expanded` flips, Escape closes it and the caret stays
in the box. `--baseline` serves `HEAD:public/app.js` and `HEAD:public/style.css`
instead of the working copy, which is how you tell a real failure from a flaky one —
baseline has no ⋯ at all, so it must fail. `--out=<dir>` writes a screenshot of the
box shut, the panel open and the armed state.

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

**Using** it is a checkbox under the agent chips in the ⋯ panel, and it is spent by
the comment it rides on:

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
- **Visible with the panel shut.** An armed box says so on its strip — *⚠ with
  tools, this once* — and rings the ⋯ in the same amber, so pressing **Comment only**
  is never an elevation you had forgotten granting.

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

## What an agent is — and how it asks to be different

An agent's definition used to be spread across four places that had nothing to do
with each other: a system prompt as a template literal in `lib/console.js`, an
allowlist as a bare string in `lib/dispatch.js`, a model buried in a config key, and
an environment derived implicitly from whichever directory the process was spawned
in. That was fine while the only reader was the code doing the spawning. It stops
working the moment an agent is allowed to *ask* to be different, because you cannot
request a change to something with no single form.

So `lib/foundation.js`: **one foundation per agent kind**, for all four of them —
the chat session, the comment answerer, the repo advocate, and the worker session opened
in iTerm. Read it to know what an agent may do; commit a change to it to change what
the agent is.

The line it draws is the important part. A foundation is what the agent is on **every**
run. The prompt handed to one invocation — this bead, this comment, this survey — is
what it was *asked* this time, and stays in the module that composes it. Only the
former is amendable: an agent that could rewrite the brief it was given for a task
could decide it had been asked something else.

**Two layers, and neither can clobber the other.**

- The **baseline** is in code, shipping with the release. Normal development edits it
  freely.
- **Amendments** live on `refs/beadcause/foundations` — a commit per amendment, a tree
  of `<agent>.json` overlays, the justification in the message. Written with the same
  plumbing as the session log (`lib/gitref.js`), so nothing touches the working tree
  and a human mid-edit in the same checkout never sees it.

Effective = baseline ⊕ overlay, resolved at spawn. Editing a prompt in a release
therefore cannot silently revert an approved amendment, and an approved amendment
cannot freeze a copy of a prompt development has since moved past.

Because every amendment is a commit, the history reads as what each agent was
allowed to become:

```
git log --format='%aI %s' refs/beadcause/foundations
git cat-file -p refs/beadcause/foundations:console.json
```

### What may never be amended

`id`, `protocolOwner` and `writes`. Not distrust of the approval — these are the
fields whose wrongness is invisible at approval time. "Let the chat session call `bd
create`" reads as a one-line convenience and silently deletes the review step; a
changed output contract reads as a formatting preference and breaks the parser three
turns later, in a way that looks like the agent being unhelpful. Those change by
editing the file in a release, which is a human writing code.

Amendable: `purpose`, `role`, `model`, `tools`, `allowedTools`, `env`, `timeoutMs`,
`permissionMode`. A request naming anything else is **rejected, not filtered** —
silently dropping half a request would apply an amendment you did not approve.

### The loop

1. **It reflects.** After the task — answering a comment, running a survey — the agent
   is asked one question: was there something you could not do? Its own foundation is
   printed for it, along with every request of its that has already been refused.
2. **It writes a block.** Not a bead. `lib/amendment.js` parses an `amendment` block
   off the end of its output; the agent never files anything and never writes a
   foundation. Both of those are beadcause's, and that separation is the whole safety
   property.
3. **beadcause files one question.** An ordinary `human` bead, labelled `foundation`,
   carrying what it wants, what it is now, the scope, the argument, and what actually
   happened. One at a time, per agent.
4. **You answer it from your phone.** Approve, decline, or ask — commenting starts a
   thread the way any other question does.
5. **Approval is a commit**, and the agent starts its next session on the new
   definition.

```amendment
agent: dispatch
kind: prohibited
scope: reading git history in the repo I am already reading; no writes
justification: |
  The comment asked which commit introduced the bug. I can read the files but not
  the history, so I answered with a guess at the file instead of the commit.
evidence: |
  Bash(git log --oneline -20) was denied.
add:
  allowedTools:
    - Bash(git log:*)
```

**Scope is mandatory.** A request without it is thrown away before it can become a
bead. "Give me Write" is not a decision anyone can make on a phone; "give me Write
under my own directory, because X" is. So is a justification — a phrase does not
clear the bar, and a request re-arguing something already refused never reaches you
at all.

**`add`/`remove`, not a rewritten list.** A model asked to restate a thirteen-entry
allowlist in order to append one line to it will eventually drop an entry, and that
would read as an approved amendment quietly *removing* a tool nobody discussed. The
agent names the delta; beadcause computes the result against the effective
foundation, so two amendments in sequence compose instead of the second reverting the
first.

### Prohibition and omission are not symmetric

A prohibition is observable: the agent asked for a tool and was denied, and the
denial is in the transcript. beadcause **reads it off the stream** rather than taking
the agent's word for it, and puts it on the card under "what actually happened" — so
a denial the agent forgot to mention still reaches you, and an account of a denial
that never happened is catchable.

An omission is not observable at all. The agent cannot see what it was never given,
so those requests are speculative by construction. Both are allowed; `kind` says
which it is, and the justification bar is what keeps the speculative half honest.

### A "no" is remembered

Declining writes a commit too, with your words as the reason, and every future
reflection is seeded with it verbatim. Without that the same argument arrives every
session forever — reasoned to from the same starting point by an agent with no memory
of having lost it — and the one channel you read for constitutional questions fills
with arguments you have already had.

### Who answers a question about a request

The agent that made it. Commenting on an ordinary question dispatches whichever agent
you picked from the roster; commenting on an amendment request instead re-seeds the
*requesting* agent with its own foundation and its own argument, because a Critic
explaining why the chat session wants a tool is a stranger guessing at someone else's
motive. It is told, in as many words, that withdrawing the request is a better
outcome than defending it.

### Where it takes effect

Three of the four agent kinds re-seed themselves for free: dispatch, the advocate
survey and a worker session are each one `claude` process that exits, so the next
spawn reads the amended foundation and *is* the new session. The chat session is the
exception — a turn is a fresh `claude -p` resumed by session id — so an approved
amendment restarts it on a new session, keeps the conversation on screen, and says so
in the transcript.

### A channel of its own, on every surface

A request to change what an agent is arrives as an ordinary `human` bead — the
decision block, the thread, the answer-and-close path are all the machinery a question
already has, and forking that would be two of everything for no gain. What is *not*
shared is the place it lands. "Should the chat session be allowed to run `git log`" is not
a question about work: it does not compete with one for priority, it should not be
counted with them, and it must never be the row that pushes a P0 off a phone screen.

So the split happens once, server-side, in `splitChannels` — and everything downstream
is handed two lists rather than one list it has to filter correctly:

| | Questions | Foundation requests |
|---|---|---|
| **Event** | `question`, `reply` | `foundation-request`, `foundation-reply`, `amended` |
| **Route** | `/api/questions`, `/api/poll` → `questions` | the same two → `requests`, plus **`/api/foundation`** on its own |
| **ntfy** | `pushQuestion` — bead priority, 💭 | `pushFoundationRequest` — always priority 3, ⚖️, leads with the *scope* |
| **Android** | channel `questions_v2`, tray card 3 | channel `foundation_v1`, tray card 4 |
| **PWA** | the list, under the space and workspace filters | a pane above it, outside every filter, badged on ⚖️ |
| **Terminal** | the `questions` pane | its own `foundation requests` pane, in the head |

Three things are deliberate in there:

- **`/api/foundation` exists even though the data is already in the other two.** It is
  the caller that wants the channel without the inbox — the agent scope, a badge, or
  `curl` — and it costs one `bd list --label` per workspace instead of a full sweep.
- **A request never inherits the bead's priority.** A question is urgent when the work
  is; an amendment is important and never urgent, so it is fixed at 3 and the Android
  channel is `IMPORTANCE_DEFAULT`. It arrives; it does not shout.
- **Approve and decline both fit in ntfy's three buttons**, so this is one of the few
  notifications that can genuinely be answered from the shade — but a reply *about* a
  request carries no buttons at all. The Q and A is a thread, and a notification
  cannot be one; tapping opens it where the whole argument is.

The Android channel is the part that is worth more than it looks. A channel is the
unit *you* control: you can set foundation requests to silent, or off for a fortnight,
without touching whether a question about work can reach you. A tag on a shared
channel would have looked identical in the shade and given you nothing to hold.

**Which channel a bead is in comes from its label, not from whether its block
parsed.** A malformed request still arrives in the foundation channel carrying its
error, rather than falling back into the work feed where nobody is looking for a
constitutional decision.

## What an agent remembers, and how agents tell each other things

A foundation is what an agent *is*. This is what it has *learned* — and it is the
half that used to evaporate at the end of every run. Four calls, and an agent
reaches all of them as a command:

```
beadcause-memory remember tone "evidence first, then the ask"
beadcause-memory recall tone
beadcause-memory post proposals "the graph work is blocked on a decision"
beadcause-memory read proposals --since=4
```

`remember` / `recall` are one agent's own knowledge. `post` / `read` are a
**blackboard**: an agent publishes what it believes and the others read it whenever
they next look. Deliberately not a mailbox and not a conversation — there is no
addressee and no delivery, because git has no notification to give. The nudge, when
something needs one, is the event bus (`lib/events.js`), which is in-memory and
un-persisted and is the exact complement of this: payload and durability here,
wake-up there.

**No call names a repo, a path or a ref, and none of them will take one.** That is
the point of the indirection — the day this should be SQLite or a table in beads,
the change is `lib/memory.js` and nothing else. An agent handed a path would have
put that path into its own memory, its habits and its prompts.

**Who you are is not an argument either.** The daemon exports `BEADCAUSE_AGENT`
when it spawns an agent, and both halves attribute to that. An agent that could name
itself on the command line could name itself `console`, and the first time one wrote
into another's memory it would be indistinguishable from the other agent having
written it. It is the *foundation's* id, so `answerer` and `critic` — who share the
dispatch foundation — share what dispatch has learned. Memory belongs to the thing
that has a definition, which is the same boundary the amendment loop draws.

### Where it lives: `~/.config/beadcause` is a git repo

Tier 1 put an agent's memory on a ref inside the codebase it was working on, which
is right for knowledge *about that codebase* and is exactly why nothing could be
shared: the beadcause advocate and the sophab advocate write into different
checkouts and cannot see each other. So the config directory — the one place every
agent on this Mac has in common — became a repo, and both halves ride on refs in it:

```
refs/beadcause/memory            one commit per write, tree = <agent>.json
refs/beadcause/bus/<topic>       one commit per message, tree = message.json

git -C ~/.config/beadcause log --format='%aI %s' refs/beadcause/memory
git -C ~/.config/beadcause cat-file -p refs/beadcause/memory:advocate.json
git -C ~/.config/beadcause log refs/beadcause/bus/proposals
```

Same trick as the session logs: a ref outside `refs/heads/*` and `refs/tags/*` has
no working tree, so the daemon can commit one while something else is rewriting
`config.json` beside it. Nothing here has a remote and nothing pushes.

**The `.gitignore` is written before `git init`, and that ordering is the whole
safety of it.** That directory holds `android-keystore.jks` — the release signing
key for the Android app — and its password file next to it. A `git init && git add
-A` there commits a signing key into a history that is then genuinely hard to
remove. So the ignore file lands first, *and* every commit re-checks the staged list
against a denylist and aborts rather than dropping the file quietly. An ignore rule
is one `git add -f` away from not applying; the cost of being wrong once is a
rotated key.

### Two writers, and why it is a compare-and-swap

Every write reads the ref tip, builds its value from it, and hands that tip back to
`update-ref` as the expected old value. Git refuses if anyone landed first, and the
whole operation retries against the new tip — not just the commit, because losing
the race means the value you merged into is stale too.

The interesting case is the *first* write to a ref, where every writer reads `null`
at once and each believes it is creating it. `update-ref <ref> <new>` with the old
value left off means "overwrite whatever is there"; the empty string means "and it
must not exist". Omitting it made six concurrent posts to a new topic land as one
surviving commit with five silently lost and no error anywhere. `lib/gitref.js` now
always passes it, which also closes the same hole for foundations and session logs.

`node test/memory.mjs` races six processes onto one topic and asserts the sequence
1..6 is there exactly once — a compare-and-swap you have not raced is one you have
not tested.

### The state files get a history for free

The same repo means `config.json`, `state.json`, `advocates.json` and the consoles
are now committed after they change — which is what the `config.json.bak-20260808`
and `config.json.bak-scope` sitting in that directory were: backups made by hand at
moments somebody was nervous. `git -C ~/.config/beadcause log` answers "what did
this say before the advocate rewrote it" without anyone having remembered to ask.

Snapshots are debounced by two seconds and the reasons accumulate, because one
advocate cycle rewrites `advocates.json` three or four times in a second and those
are one event to whoever reads the history back. `status.json`, `logs/` and the
check PNGs are ignored — churn, and not the thing you want a history of.

## What an agent can see — a picture of the running app

Almost everything in flight in this repo is visual. How the graph fits a phone,
where a card lands after its prose reflows, whether the kebab collapses, what the
chat-session pane does at 390px — and every one of those shipped from an agent that had
read the source and never seen the screen. It would write the CSS, run the tests,
and hand over a change it was in no position to have an opinion about.

```
node scripts/shot.mjs [path] [--desktop] [--full] [--wait SEL] [--settle MS]
                      [--out FILE] [--base URL] [--strict]
```

It renders a page of the running daemon to a PNG under `.claude/shots/` and prints
the path. The agent then `Read`s the PNG, which is a thing it could already do — the
missing half was never the looking, it was having something to look at.

```
$ node scripts/shot.mjs /graph?ws=beadcause --wait svg
.claude/shots/graph-ws-beadcause-20260809-150650.png
  http://127.0.0.1:4318/graph?ws=beadcause - 390x844 @3x mobile - 141 KB

what the page complained about
  http: 404 /api/presence
```

**The phone is the default**, 390×844 at 3× with touch and a mobile user agent —
the same device `phone-check.mjs` emulates, so a shot and a check describe the same
pixels. A 1280px screenshot is a picture of the one layout nobody uses, and it hides
exactly the failures worth catching. `--desktop` when the bug really is a
wide-window one.

**The token never touches the command line.** It comes from `loadConfig()` and goes
into `localStorage` through an init script that runs before any of the page's own
code, so the app finds itself already paired and never draws the setup dialog over
the thing you came to photograph. Agent shell commands get echoed into transcripts,
quoted into beads and read on a phone; a secret that reaches the screen once needs
rotating. `?t=` would have put it in the URL bar, which is to say in the screenshot.

**It waits for `load`, never for an idle network.** The app holds a WebSocket open
for live updates, so the network is never idle — an idle-wait would have timed out
on every page that rendered perfectly. `load` then a settle, and `--wait SEL` for a
page that fans out over every workspace before it has anything to draw.

**The console errors are output, not decoration.** A screenshot shows you a blank
panel. It does not show you the 401 behind it, and that is precisely the case where
a picture on its own actively misleads. `console.error`, uncaught exceptions, failed
requests and any response ≥ 400 are collected, deduped and printed under the path.
The 404 in the example above is real, and nothing else in the repo was going to
mention it.

Exit code is 1 when the page never loaded — Chrome renders its own error page in
that case and reports no error at all, so without it a shot of "this site can't be
reached" would read as a page that rendered. `--strict` widens that to any complaint
at all. Either way it still writes the PNG: a run that produces nothing sends the
agent back to guessing from source, and the error state is usually the single most
informative frame there is.

Two shots taken a week apart differ only where the app does — `prefers-color-scheme`
is pinned dark and `prefers-reduced-motion` to `reduce`, because an animation caught
mid-flight is a diff every single time.

It drives headless Chrome over the DevTools protocol on Node's global `WebSocket`,
the same way `scroll-check.mjs` and its five siblings already do, so it adds no
dependency and downloads no browser. Chrome is looked up in the usual places and
`CHROME_PATH` points it somewhere else.

`node scripts/shot-check.mjs` is what keeps it honest, because every way this breaks
is silent — a picture always arrives. Pairing stops working and it photographs the
setup dialog, which reads to an agent as "the app is broken". The error capture stops
working and a 401 behind a blank panel comes back looking fine. So: a fixture page
served from the check's own process, with its own throwaway config and a token this
file knows, shot for real by the real script. Fifteen assertions, including that the
token never reached the output and that the page itself agrees about the viewport and
the pinned media. It needs no daemon and no beads, so it can never photograph, or
leak, anything of yours. Like the other headless-Chrome checks it is not in
`npm test` — that suite stays pure Node.

**The advocate gets exactly this and nothing more.** `Bash(node scripts/shot.mjs:*)`
is in its `allowedTools` baseline — one command, not `Bash(node:*)`. The point is to
let it look, not to let it run arbitrary JavaScript, and `writes: false` would mean
very little standing next to a general `node`. Worker sessions needed no change at
all: `allowedTools` is `null` there, so the moment the script existed they could run
it. And `.claude/shots/` is gitignored, because every PNG is a picture of real
beads.

## The conversation, both ways

*Comment only* is not a dead end — it starts a thread.

- **You → agent.** Commenting without answering labels the bead `human-replied`.
  That's the signal a session can actually find: `bd list --label=human-replied`
  shows every question waiting on an agent rather than on you. The card shows
  "⏳ you replied · waiting on an agent to pick this up".
- **And then it gets out of your way.** Commenting collapses the card and sinks it
  below everything still waiting on you, dimmed. Leaving it open in front of you
  implies there is something left for you to do with it, when the next move belongs
  to the agent. The reply landing clears the flag, so it rises back into the queue
  in its own place — priority, then age. Answering removes it outright; that was
  always true.
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

### Watching it work — the session log

A dispatched agent can take minutes, and until it comments there was one piece of
evidence it had picked your comment up at all: a chip saying **thinking**. For a
run that long that is indistinguishable from nothing happening — the exact failure
auto-dispatch was built to fix.

So a card with an agent on it carries a **Session log** button, and it tails what
the agent is actually doing:

```
● dispatched in /Users/you/projects/acme
● session 4f1c9a2b · claude-opus-5 · cwd /Users/you/projects/acme
  > Bash bd show ac-abc
    ○ ac-abc · Deploy to staging before the demo? [P1 · OPEN]
  > Grep stripe.*fee
Both fee models are in lib/billing.js — gross is the default…
  > Bash bd comment ac-abc --actor claude-session "…"
● done · 47s · $0.0231
```

`dispatchReply` used to buffer the run with `execFile` and throw the output away.
It now runs `claude -p … --output-format stream-json --verbose` (the CLI refuses
stream-json under `--print` without it), and every event is turned into the line a
terminal would have shown and appended to a per-bead file under
`~/.config/beadcause/logs/`. **The rendering is server-side** (`lib/agentlog.js`),
so the format lives in one place and the phone only ever receives text — the same
renderer the session archive replays with. An event type nobody has handled yet
draws nothing rather than a wall of `{"type":…}`, because the point of the pane is
that it reads like a CLI.

`GET /api/agent-log` returns the tail — capped at 64KB and 400 lines, from the
*end*, since what a run in progress is doing now is always the last thing in it —
and a `running` flag. The pane polls every two seconds while the agent is up, keeps
your scroll position unless you were already at the bottom, and stops asking the
moment `running` goes false: a finished log does not change, and an open pane must
not cost a file read every two seconds for the rest of the day. The pane itself
stays until you close it, which is why the button outlives the `human-replied`
flag that first drew it — the reply often lands while you are still reading.

It is 9.5px monospace with `white-space: pre`, scrolling sideways rather than
reflowing. The output was laid out by something counting characters at 80 columns,
and wrapping it would destroy the only alignment it has.

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

### The top bar says who is asking, not what the app is called

The widest part of the bar used to be the word **Beadcause** — on a screen you
reached by tapping an icon labelled Beadcause, in an app whose title bar says
Beadcause. It is the app mark now, the same artwork as the home-screen icon, still
inside the `<h1>` with the name as the image's `alt` so the header is labelled and a
reader still hears which app this is.

What the reclaimed width is spent on is the premise itself:

```
  ⚙  ●  ◔  ( 8 waiting )                    ⌨️  ⚖️  ⟳
```

**8 waiting** is how many beads are asking you something, and tapping it is the way
back to the `human` scope — the count *is* the filter. It is hidden at zero, because
an empty inbox should look empty rather than report itself, and under 360px the word
drops and the number stays.

The other two numbers in that picture — agents running, advocates waiting — are
**badges on the tabs that answer them**, not chips up here: the number and the way to
act on it end up as the same tap target. See [the tab bar](#getting-around--the-tab-bar).

The count is drawn from the rows on screen whenever the scope actually swept them, so
answering a question drops it on the tap rather than on the next poll. In the `agent`
scope — which sweeps no questions at all — it falls back to the count the server
holds from the last sweep, for the same reason the advocate badge does: a zero there
would read as "nothing is asking you anything" when the truth is "you did not ask".

## What a question is blocking

A question whose answer nothing is waiting on is just a question. One that blocks
seven issues is a queue, and that changes how fast you want to answer it — so an
open card that blocks anything gets a **What this is blocking** link, into the
dependency graph. It appears with the details rather than on the collapsed card,
because `bd human list` doesn't return a dependent count and `bd show` does — the
same reason `commentCount` is 0 until you open a question.

The graph itself is at `/graph?ws=<workspace>` with an optional `&id=<bead>`, and a
scope switch between *this bead* and the *whole workspace*. Tapped from any view, it
opens as a [drawer over that view](#detail-opens-over-the-tab-not-instead-of-it)
rather than as a page you have to find your way back from.

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

## Getting around — the tab bar

The standing views — it started as four: the **inbox**, the **chat session**, the
**sessions** and the **advocates**, with the **pull requests** and the **admin**
screen since. The bar labels the second one just **Chat**, because six
tabs leave no room for two words at 360px. They are separate pages, and each one used to end in an ✕
in the top right that hard-navigated back to `/`. That made the inbox a hallway —
chat session to advocates was two taps through a page you did not want — and the ad-hoc
cross-links that grew to paper over it (sessions → advocates, advocates → sessions)
were the same complaint, admitting itself.

So all of them carry the same bar along the bottom, where a thumb already is:

```
  📥      🧾       🤖        🔀         📣         ⏸
 Inbox   Chat  Sessions    PRs    Advocates   Admin
 ▔▔▔▔▔
```

Six tabs is 60px each at 360px, which "Advocates" does not fit at the bar's normal
type size — so the stylesheet steps the type down when a sixth tab is there
(`.tabbar:has(.tab-item:nth-child(6))`), keyed off the bar's own contents rather than
off a count written down somewhere, so adding or removing a tab needs nothing else.

Sessions and Advocates carry a **badge** when there is something behind them — how
many agents are running, how many advocates are waiting on an answer. Both numbers
ride the inbox's own poll (`/api/questions` carries them; see [the three counts on
the poll](#the-three-counts-on-the-poll)), so they are live while you are on the
inbox and simply absent on a page that has no way to refresh them — which beats a
stale number that looks live. Zero shows nothing. The badge sits inside the tab's
`aria-hidden` icon, so the tab takes an `aria-label` saying what the number counts:
"2" read out after "Sessions" says nothing about two of what.

Any view is one tap from any other, and nothing closes any more. The current tab is
a `<span>` rather than a link — tapping where you already are should do nothing, not
throw away the list, the conversation and your scroll position to rebuild the same
screen — and it is marked twice over, by the accent colour and by the rule above it,
because colour alone is not a mark. The bar pads itself past the home indicator.

⚙ and ⟳ stay in the top bar of the views that have them: they act on the view you
are looking at rather than taking you off it. ⌨️ (the terminal) and ⚖️ (the
foundations) stay in the inbox's top bar too — they are places you go for one thing
and come back from, not views you live in.

An **open question is the exception**: a card you have opened takes the whole screen,
tab bar included, because the answer buttons at its foot must not sit under anything.
Collapsing it gives the bar back. That behaviour belongs to `.card.open` and to the
inbox alone — the accordions on the sessions and pull request views mark their
unfolded card `unfolded` instead, because a workspace card that took the screen over
the bar was a page you could not leave, on a view whose first load unfolds one.

`node scripts/tabbar-check.mjs` checks it, headless at phone size against fixtures
the script serves itself: the bar is on every page and pinned to the bottom,
exactly one tab is current and it is the right one, the current tab is not a link,
and the last row of the list, the chat session's composer and the last advocate card all
clear it — in both colour schemes. `--fake-inset` re-runs the safe-area sums with a
notch substituted in, for the Chromes with no `Emulation.setSafeAreaInsets`.

## Detail opens over the tab, not instead of it

The graph and the reader are linked from every view that names a bead — the inbox,
current sessions, the pull requests, the advocates and the chat session — and both used to be a full-page
navigation. Looking at what a bead blocks therefore cost you your place in the list,
your half-typed answer was behind a **✕ → inbox** you had to trust, and the back
gesture landed on whatever the browser felt like. They are not destinations. They
are detail about the thing you just tapped, so they **slide in from the right over
the current tab** and dismiss back to it.

`public/drawer.js` is one file loaded by both sides of it, picking its half at load:

- **On a tab**, it intercepts clicks on `/graph?` and `/doc?` links and loads the
  page that already exists into an iframe in the panel. The iframe is the whole
  trick — it keeps d3 out of the inbox's bundle and marked out of the graph's, and
  no page had to learn to render the other one. The anchors keep their real `href`,
  so long-press → open in new tab still works, and a pasted `/graph?ws=…` or
  `/doc?p=…` URL still loads the standalone page exactly as before. (A detail page
  opened on its own installs nothing: no drawer over a drawer's worth of the same
  thing.)
- **Inside the drawer**, the page stops being a page: it puts its own top bar away,
  hands its title up to the panel's header, and retargets a link from one document to
  the next instead of escaping to a new tab.

**One header, one ✕, and the ✕ means the drawer.** Both pages were built to be opened
on their own, so both carry a full top bar — a pulse dot, an `h1`, and a ✕ that meant
*close this tab* and fell back to navigating the whole app to the inbox. In a panel
that is wrong twice over: a second header stacked under the tab's own, and a way out
that throws away the thing the drawer was opened over. So the chrome moves out to the
panel, where it can mean what it says. The page's name goes with it — watched rather
than read once, because the graph renames itself every time the scope toggle moves
between one bead and the whole workspace — and a document keeps the monospace its own
bar gave it, since a path is read character by character. Everything that is not
chrome stays exactly where it was: the scope toggle, the reticle and the graph's
detail sheet are the detail you came for, and the sheet's own ✕ closes the sheet and
leaves you on the graph.

Opened as a page — a pasted URL, a long-press → new tab, a notification — none of
that applies and the top bar comes back, because out there it is the only chrome
there is. The switch is `.in-drawer` on `<html>`, set by `drawer.js` the moment it
sees it is in a frame.

**The tab underneath is never navigated and its scroll is never touched.** That is
the point of the change, and it is also why there is no scroll-restoring code
anywhere in the drawer: the inbox's own anchoring (see [Keeping your place in a long
brief](#keeping-your-place-in-a-long-brief)) keeps working behind the panel, and an
open brief is on the same paragraph when the drawer goes.

**One history entry, exactly.** The drawer pushes one, so Android's back button and
iOS's back-swipe close it and land you on the tab you were reading. Exactly one is
the fiddly part: an iframe's *initial* navigation adds no session-history entry and
every one after it does, so a drawer that re-pointed its iframe by `src` would make
back walk you through every document you had opened inside it before finally giving
you the tab. In-drawer navigation goes through `location.replace()`, and a closed
drawer drops its iframe so the next open is an initial load again — which also means
a graph left open is not still polling behind the tab you went back to.

Dismiss it with the ✕, with the backdrop, with a swipe right, or with back. The
swipe needs saying: a touch inside an iframe is never seen by the page around it, so
the drawer has a narrow transparent strip down its own left edge to start one from,
and the page in the drawer forwards its own swipes out. The graph pans, and a wide
table or code block scrolls sideways, so a swipe that starts on one of those is left
to it rather than stolen.

**Full width on a phone, inset on a wide screen** — with the tab still visible
around it, because there it reads as detail rather than as a new page. It covers the
[tab bar](#getting-around--the-tab-bar) while it is up, deliberately: the drawer is
one gesture deep, and the way out of it is back, not a fifth destination.

The Android shell needed one line for this. `shouldOverrideUrlLoading` fires for
subframe navigations too, so the WebView was intercepting the drawer's own iframe
load and opening `DocActivity` on top of a drawer that stayed empty behind it. It now
leaves anything that is not the main frame alone; a `/doc` link that *is* a main-frame
navigation — a notification, a deep link — still opens the native reader.

### Checking that it gives the tab back

`node scripts/drawer-check.mjs` drives the real `public/*.js` in headless Chrome at
phone size against fixtures served from the script, so it needs neither the daemon
nor a real bead. It reads a brief a long way down, opens the spec it links to, and
asserts the paragraph has not moved — then that the panel's ✕ closes the drawer and
not the tab, that a link inside a document retargets the drawer, that **one** back
closes it however many documents were read in there, that the same module behaves on
the sessions tab with a graph, that the panel is full width on a phone and inset with
a working backdrop on a wide screen, and that a pasted `/graph` URL still loads the
page itself.

It counts the chrome, too, because that is the part a screenshot flatters: exactly
one header and one ✕ inside the drawer, both the panel's, with a long filename clipped
to the one row rather than shoving the ✕ off the edge; the header saying what the page
in there says it is, and still saying it after the scope toggle moves; the graph's
detail sheet opening inside the panel and closing back to the graph rather than
closing the drawer; the page's own ✕ dismissing the drawer rather than the app if
anything ever reaches it; and both pages standing on their own — header, ✕ and no
drawer mode — when they are loaded as pages.

`--baseline` serves the committed copies instead of the working ones, which is how
you check a failure here is a real one: whatever a change brings has to fail without
it. `--out=DIR` saves the three shots worth eyeballing, since how it *looks* is not
something a number can say. Like the other browser checks it is not in `npm test`,
because it needs Chrome; run it when you touch the drawer, the graph, the reader, or
the links into either.

## Current sessions — who is working, and on what

The inbox answers *what needs me*. It is `bd human list`, so a bead only appears if
it carries the `human` label — which means everything the sessions on the Mac are
actually doing was invisible from the phone. Nine beads claimed in sophab five
minutes ago showed up nowhere at all.

**🤖 Sessions in the tab bar** opens `/sessions`: one card per workspace, busiest
first. (`/work`, what this used to be called, still resolves to the same page.)

**The cards are an accordion — one open at a time.** Six workspaces of beads and
sessions is several screens on a phone, and the whole page had to be paged through to
reach the one repo you opened it for. Collapsed, a heading still carries its own
summary, so the scan happens in one screen and only the card you want unfolds. The
busiest card (the first one) opens itself on arrival, because six closed headings
would charge you a tap on every visit for nothing.

```
climative                        5 on a bead · 5 sessions ⌄
  ◗ pipeline-service: client built without retry…      11h
    cl-1jw  adam.morgan
  ◗ TECH-5989 fanout: downmerge 25 service repos       17h
    cl-wyv  adam.morgan
  CLAUDE SESSIONS  Which of these is on which bead is not recorded.
  ● Climative - newrelic v14 override fix           11h  ›
    dms-client-retry-4e7 · pid 90310 · idle
  54 open · 51 ready · 3 blocked            [ Graph → ]

deluvia                                     2 sessions ›
sophab                                      1 session  ›
ehatt                                              idle ›
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

### Tap a session to see what it is actually doing

A session row used to be a dead end. It said a name, a pid and the word "busy" — and
"busy" reads exactly the same for a session mid-thought as for one that has been sat
on a permission prompt for an hour. The pid was on screen precisely because there was
nothing better to show.

Tapping one now unfolds what the process record knows — its full directory, its
workspace, when it started, when it last spoke — and under that, **its own Claude Code
transcript, tailed live**:

```
  ● Beadcause - bc-76c Sessions tab: accordion cards    22m ⌄
    sessions-accordion-log-5f7 · pid 30342 · busy
      WHERE      /Users/…/beadcause/.claude/worktrees/sessions-accordion-log-5f7
      WORKSPACE  beadcause
      PROCESS    pid 30342 · interactive · busy
      STARTED    Aug 8, 12:03 PM · 22m ago
      ACTIVE     Aug 8, 12:03 PM · 22m ago
      SESSION    a60224c4
    TRANSCRIPT  Its own log, as the terminal showed it.
    ┌──────────────────────────────────────────────────────────┐
    │ ❯ run whatever this repo calls its tests                 │
    │ ✻ thinking                                               │
    │   > Bash node --check lib/transcript.js                  │
    │     check=0                                              │
    └──────────────────────────────────────────────────────────┘
```

Claude Code already writes the whole conversation to
`~/.claude/projects/<slug>/<session-id>.jsonl`, one JSON object per line, appended as
it happens — so this reads that file (`GET /api/session-log?pid=`). **Nothing is
instrumented and nothing is asked of the session**, which is the point: a session
started by hand, that beadcause has never heard of, is as visible as one the daemon
dispatched itself. It is rendered into the same line grammar as the dispatched-agent
log, server-side, so the phone only ever receives text.

Four things worth knowing:

- **Addressed by pid, never by a path.** The pid is matched against the sessions the
  page itself just reported, and the file is resolved from the record Claude Code
  wrote — so a request cannot name a file of its own choosing. A pid that has gone
  says so, because "it finished" is a different fact from "it has done nothing".
- **The tail grows until there is something to read.** One transcript line is a whole
  message, and a `tool_result` carrying a 200 kB file is ordinary, so bytes are a
  terrible proxy for lines: measured on a real session, 256 kB of recent transcript
  was ten lines, six of which rendered. It widens the window — bounded at 2 MB — until
  it has a screenful of what it will actually show.
- **It looks in every config directory.** One Mac can run two Claude Code accounts out
  of `~/.claude` and, say, `~/.claude-personal`, chosen per shell with
  `CLAUDE_CONFIG_DIR`; the daemon runs under launchd where that variable is not set.
  Honouring it alone would find only the sessions sharing the daemon's environment.
  `claudeProjectsDir` overrides the search and takes a list.
- **A transcript is not redacted.** It holds every prompt and every byte of tool output
  from that session, which for a work repo can include things you would not put in a
  chat. It travels the same token-authenticated, tailnet-only path as the rest of
  `/api/` and no further — but it is the most sensitive thing this daemon serves, and
  `claudeSessions: false` turns it off along with the rest of the session reading.

Only one session is open at a time, and folding a card closes the session inside it —
a pane left open behind a fold would reappear on its own when you came back. The pane
polls every two seconds while it is open and never otherwise, and it keeps its scroll
position across the card refresh: following the tail is only right if you were already
at the bottom, and a pane that jumped to the end every 45 seconds would make reading
back through a run impossible.

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

## Pull requests — merged, pushed, deployed

The delivery question asks *may I merge this?*, and the card is gone the moment you
answer it. The question that starts the second it disappears had nowhere to be asked
from a phone: **it merged — did it reach origin, and is it running?** Those are three
different facts. They go true at three different times, and the gap between them is
where work sits for a week believing it has shipped.

So: the 🔀 tab, one card per repo, one row per pull request, and three lamps on every
row.

```
#42  Turn the launcher's repo chips into tabs            2h ›
     bc-jin   +764 −20   5 files   ✓ 3
     ● Merged   ● Pushed   ○ Deployed
```

**The lamps are the page.** They are on every row rather than behind the fold,
because "which of these has not shipped" is a question you answer by scanning, and a
fold would make it a question you answer by tapping twelve times. Tapping a row opens
what you can do about it.

**A lamp has three states, not two.** On, off, and *unknown* — a hollow, dashed ring:

- **Merged** — GitHub says so.
- **Pushed** — the merge commit is reachable from `origin/<base>` **as this Mac last
  fetched it**. The board re-fetches each checkout at most every two minutes, and
  only when something merged is waiting on the answer.
- **Deployed** — the merge commit is in the build that is *running*. beadcause deploys
  by `launchctl kickstart`, a restart, so the code that is running is the code that
  was at `HEAD` when this process started and nothing after it. That commit is read
  **once, at import**, and never again: reading it lazily would report main's newest
  commit as deployed the moment another session merged something, which is exactly
  the lie this column exists to prevent. The page names the commit at its foot, so
  the word "deployed" is never a claim you have to take on trust.

The third state is the one that matters. This Mac has never fetched that commit; this
repo has no deploy the daemon can see at all — only its own. An unknown drawn as
"off" would tell you work was not pushed when the truth is that nobody has looked,
and that is the one way this screen could actively mislead you. A repo the daemon
does not run says so in words on the row, rather than showing a dark lamp that means
something else everywhere else on the page.

### Which bead a pull request is for

The list comes from `gh pr list --state all` per repo — so a pull request opened by
hand, with no bead and no delivery block, is on the board like any other. Beads are
then matched back to it in **tiers**, strongest first, and the first tier that
resolves to a real bead wins outright:

1. the `bead:` line inside a [`beadpr` block](#landing-work--a-branch-a-pull-request-and-your-tap),
   or an id in the **title** or the **branch name**;
2. the branch's trailing tag — `worktree-launcher-repo-tabs-jin` ends in the bead's
   own suffix, because that is where the tag comes from;
3. the body, and only where it **claims** a bead: "fixes bc-x", "for bc-x". Not a
   mention.

The tiers exist because of a real row. A delivery whose body signed off with "nothing
was done about bc-2tr / bc-es8 / bc-dmt, which this unblocks" came back linked to four
beads, three of which it explicitly had not touched — and all four exist, so asking
the tracker cannot tell them apart. Only *where they were written* can. Every
candidate is still checked against `bd` before it is drawn, so a branch ending in a
word that names no bead simply drops out, and a pull request nobody tied to a bead
says **no bead named** rather than borrowing one.

### The three buttons

- **Merge & push** — `gh pr merge`, with lib/pr.js's own preflight in front of it, so
  an already-merged, closed or conflicting PR is refused *here* with a sentence that
  says which. GitHub's merge puts the commit on `origin/<base>` itself, so the work is
  off the laptop the moment it lands; the "& push" half is bringing this Mac's own
  `<base>` up with it, and it **will not touch a checkout with uncommitted work in
  it** — it says so instead. Both halves are always reported separately: a merge that
  landed and a fast-forward refused because you have files open is a good outcome, and
  one flat word over the pair would send you to the Mac to find out which happened.
  It takes **two taps**, with the consequence written into the button between them —
  the same arming pattern as the destructive control on /admin, and for the same
  reason: a `confirm()` on a phone is a system sheet you dismiss by reflex.
- **Ship** — opens an iTerm session on the Mac with a deploy-only brief. Not a thing
  the daemon does: what a deploy *is* lives in each repo's own CLAUDE.md (a launchd
  kickstart here, `fly deploy` there, an APK rebuild when `android/` moved), and
  beadcause can neither read that nor be trusted to guess it from another room. The
  brief carries what is already true — merged, on origin, not in the running build —
  so the session does not start by working out what this screen already knew. Offered
  on merged rows even when all three lamps are lit, because a repo can need shipping
  twice.
- **Comment** — goes to the pull request on GitHub and stops there. Not
  [`/api/comment`](#the-conversation-both-ways), which writes on a *bead* and puts an
  agent onto answering it.

An observer instance ([`BEADCAUSE_OBSERVE`](#a-second-instance--observer-mode)) can merge, because
merging happens at GitHub. It refuses to **ship**, for the same reason it refuses
`POST /api/session`: a button whose consequence is an unattended agent deploying a
checkout it is only visiting.

### What it costs, and what it keeps

One `gh pr list` per repo plus a handful of `bd` lookups, cached for 25 seconds on the
daemon — the page polls, and two phones looking at the same board must not be twice
the traffic of one. ⟳ forces a fresh sweep, and so does every acting call, so a button
never acts on a row the tab has been showing since last night. Open pull requests are
never aged out; settled ones drop off the board after three weeks. A repo with no
GitHub remote is a sentence, not an error — most workspaces under `~/beads/` are
trackers rather than repos, and they are named in one line at the foot rather than
given a card each.

`node test/prboard.mjs` covers the daemon's half against real git in a temp directory
with a real `origin` to fetch from — the three-state ancestry, deployed meaning the
boot commit rather than the newest one, the bead tiers, and that `landLocally` leaves
a dirty checkout exactly as it found it. `node scripts/prs-check.mjs` covers the
phone's half in headless Chrome with every POST recorded: that the first tap on merge
sends *nothing*, that Ship is absent until it is merged, and that a refusal lands
under the row as GitHub's own sentence.

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
knowing those), and to end in one of exactly three ways: **delivered** as a pull
request for you to merge, closed, or handed back to you with the `human` label and a
decision block. A session with no honest exit invents one, and the one it invents is
"close it and hope".

Delivered is the ordinary ending now, and closed is what a session is told to do only
where there is nowhere to open a pull request — see
[Landing work](#landing-work--a-branch-a-pull-request-and-your-tap), which is where
the rest of that lives.

### It will not create beads

Opening a session on a bead you filed needs no permission — you filed it. Filing a
bead *for* you is a different act: it makes you answerable for something an agent
thought of, and a tracker full of an agent's opinions is worse than an empty one.

That rule is unchanged, and it now has two ways of being kept rather than one. A
session that trips over something mid-work proposes it *then*, with
[`beadcause-propose`](#discoveries-and-conflicts-at-the-moment-they-happen) — same
card, same buttons, nothing created until you tap. What follows is the other way: what
happens when a repo runs *out* of work and something has to go looking.

So when a repo runs out of ready work, the advocate spawns a **read-only** survey
agent (`bd`, `git log`, read, grep — nothing that can write) which reads the recent
closes, the blocked beads, any `## Discovered` notes left in comments by sessions
older than the propose command, and the repo's own docs. If it finds nothing worth filing it says so and the advocate
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

**Each row is the whole record, not a summary of one.** The number sits in a gutter
and the body hangs off it, so the column reads as a numbered list of beads. Under the
title: the type and priority pills, then the description, then everything else that
approval would actually write — **Done when**, **Design**, **Notes**, **Labels**,
**Depends on** — each under a quiet label, in the same order the question body prints
them. Description and acceptance go through the markdown renderer, so a bulleted
description is bullets rather than one run-on line; before this they were escaped
text clamped to three lines, and acceptance criteria wrapped in among the pills with
nothing saying what they were. The rationale comes last and in italics, because it is
an argument for the bead and not part of it. A long row starts folded with a **Show
the rest** under it, so three proposals still fit on a screen — a fold and not a
clamp, because a clamp cuts a list mid-item and offers no way to see the rest.
Unfolding touches that one row and nothing else: the picks you have already made, and
the primary button's count, are exactly where you left them.

`node scripts/proposal-check.mjs` checks that: headless Chrome at phone size driving
the real `public/app.js` against a proposal built by `lib/proposal.js` and parsed back
by `lib/decision.js`, so the fixture is a round trip and it never touches a bead. It
asserts the lists render as lists under their labels, that every field appears, that
the body lines up under the title, that a long row folds and a short one is left
alone, that unfolding leaves the picks and the button untouched — and that a poll
does not fold the row back up under you. `--baseline` serves `HEAD:public/app.js`
and `HEAD:public/style.css` instead of the working copy, which is how you tell a real
failure from a flaky one. `--out=<dir>` writes a screenshot of each state.

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

- **The sessions page** (🤖 in the tab bar) grows an **Advocate** block on each repo's
  card: what it is doing, the beads it has windows open on, what it will pick up
  next, and **Pause** / **Reclaim sessions**. *Reclaim sessions* asks each open window
  whether it is still working — see below.
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
session finished; with it, four endings stop looking alike:

| the file appears and… | reading |
|---|---|
| the bead is closed | **done** — the slot frees, the attempt counter resets |
| an open `pr-delivery` question names this bead | **delivered** — the work is in a pull request waiting on you; a documented ending, so it costs no attempt |
| the bead carries `human` | **handed back to you** — a documented ending, so it costs no attempt |
| neither | **exited unfinished** — costs an attempt, and the exit code is logged |

The delivered row is asked of the tracker rather than read off the bead, because a
bead blocked by a question is not distinguishable from a bead blocked by anything
else — and the id of the question is worth having anyway. "Delivered" and "delivered,
and here is what to go and answer" are different things to put on a card.

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

#### Reclaiming a slot, by asking

The inference above is what the daemon can work out on its own. **Reclaim sessions** is
what it can find out by asking, and it exists because the button before it — *Free
slots* — could only assume: it emptied the slot list on the strength of you having
pressed it, so a session three hours into a bead lost its slot to the next launch, and
one whose window you had closed looked exactly the same.

There is no socket to an advocate's session; it is an iTerm window, and the daemon owns
neither the window nor the shell in it. What it does own is the window's **iTerm session
id**, captured from `scripts/open-session.applescript` at launch. That is the channel:
`scripts/message-session.applescript` writes one line into that session, exactly as if
it had been typed, and Claude Code takes input mid-turn and answers it when the turn
lands. Three outcomes per open session, each a fact rather than a guess:

| addressing the window… | reading |
|---|---|
| no session carries that id | **gone** — the slot frees immediately, proven rather than assumed |
| the line lands | **asked** — the slot is **held**, and the session has `checkinMinutes` (default 10) to answer |
| macOS refuses the Apple event | **unreachable** — the slot is held; a refusal is evidence about iTerm, not about the session |

An asked session has two honest answers, and both already existed. It can check in —
`beadcause-checkin -w <repo> -i <bead> -m "what you are doing"`, which writes
`~/.config/beadcause/workers/<repo>-<bead>.checkin` beside the done file, for the same
reason: the reply comes minutes later, from a process the daemon does not own, possibly
across a restart. Or it can finish, doing the `** BEAD WORK DONE **` steps its brief
already specifies and exiting, which the done file above catches unchanged.

Say nothing for `checkinMinutes` and the slot goes back — and the bead is charged **no
attempt**, because silence is evidence about the window, not about the work. A bead that
lost two attempts to unanswered questions would be given up on for something no session
did wrong. A check-in older than the question never answers it, so a session that
answered once and hung since does not keep its slot forever.

A worker launched before any of this has no window id recorded; the card says *no window
handle*, and reclaiming frees its slot without asking, which is all the old button ever
did.

Those four endings are what the *daemon* can tell apart. What **you** read is the last
line the session printed, and the brief asks for it in fixed words so it can be
searched for across a wall of windows:

    ** BEAD WORK DONE ** CAN BE MERGED, PUSHED, DEPLOYED **

`** BEAD WORK DONE **` never varies. What follows names every step the work has not
been through yet — `MERGED`, `PUSHED`, `DEPLOYED`, `REBUILT`, in that order — and
`CAN BE CLOSED` on its own is the one line that means nothing is outstanding. In PR
mode the only honest word is `CAN BE REVIEWED`: a delivering session never merges,
pushes or deploys, so it can owe nothing but your answer.

That line used to be `CAN BE CLOSED` unconditionally, which said the *window* had
nothing left to do and said nothing about the work — and it is the sweep below that
makes the difference expensive. An unmerged branch is never retired, so a session that
stopped at a worktree commit left it sitting there indefinitely while reading as
finished in every list. Nothing parses the marker; it is prose for a human, and
`lib/session.js` is the only file that mentions it.

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
| its branch is an ancestor of `main`, **or** GitHub says its PR merged | everything it did is already in main |

That last condition grew a second half when nothing started merging locally: a
squash-merged pull request puts a new commit on main carrying the branch's tree and
none of its history, so the ancestor test is false forever and every delivered
worktree would sit there unswept. GitHub is asked only when the local test has already
said no, and only for a branch that has a PR — so a repo with no `gh` behaves exactly
as it did.

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

## Landing work — a branch, a pull request, and your tap

An advocate opens sessions on ready work. For a long time the question of what
happened to that work afterwards had a bad answer: the session merged it into
`main` on the laptop and closed its bead, and the first Adam saw of a change was in
`git log`, after it had shipped.

That worked while one session ran at a time. With five it stopped working, in three
separate ways at once. They raced each other into `main`, so a session that started
from a clean tree finished against one that had moved twice underneath it. Every
conflict that came of it landed on Adam anyway — in the worst possible form, hours
later, in a repo he had not been reading. And nothing was reviewable, because by the
time anything was visible it was already in.

So the unit of delivery is now a **pull request**, and the merge is a question in the
inbox like any other:

```
session finishes ──► pushes its branch ──► gh pr create
                                               │
                          question with the PR link ──► your phone
                                               │
              ┌────────────────────────────────┼────────────────────────┐
              ▼                                ▼                        ▼
        Merge #42                      Request changes               Decline it
   gh pr merge --squash          note → the PR and the bead      gh pr close + direction
   bead closes: it landed        same branch, push more          fresh branch, start again
```

Three things follow from that, and they are the whole of the change:

- **No agent merges anything.** Not into main, not locally, not "just this once
  because it is trivial". There is deliberately no `push` anywhere in `lib/pr.js` —
  the daemon can open, read, comment on, merge and close pull requests, and that is
  all it can do. The branch is the deliverable; the merge is your tap.
- **A session that finishes does not close its bead.** Merging closes it, because
  merging is what makes the work true. A session that closed its own bead here would
  be telling the tracker something that had not happened yet.
- **The worktrees stop being your problem.** They still exist — several branches on
  one laptop need several working directories, and nothing changes that — but nothing
  merges out of them, and the sweep retires them once GitHub says their PR landed.
  You stop having to remember which of thirty directories still has something in it.

The card below is the *decision*, and it is gone the moment you answer it. What
happens to the work afterwards — whether the merge reached origin, whether it is
running — lives on its own tab: [Pull requests](#pull-requests--merged-pushed-deployed).

### The question, and what is on it

The card is built to be answerable without opening GitHub, because the answer to
"should this merge" is usually not in the diff. Above the fold: what changed, in the
words of whoever wrote it, plus how the tests were run, what the author thinks is
risky, and what they deliberately left undone — the commonest reason to ask for
changes is something the author already knew they had skipped.

Under that, the numbers, and these are **read from GitHub when the card is drawn**,
not from the bead: how many files, how many lines each way, and how the checks stand.
A diffstat frozen at the moment a session ended is wrong the instant anyone pushes to
the branch, and the one number that has to be right is the one you are looking at when
you press merge. The block on the bead carries identity and intent; `gh` carries state.

The check chip has four states and they are four different sentences. `3 checks
passing` is not the same as `no checks` — a repo with no CI has told you nothing, and
a green tick there would be a claim nobody made. `2 still running` is *wait*;
`1 failing: build` is *don't*, and it names which. Failing checks do not disable the
merge button: a red check is sometimes a flake, and the decision is yours. Merged,
closed and conflicting *do* disable it, because those are facts GitHub has already
stated and pressing would only produce an error.

**Merge** takes two taps, like every other answer that closes a bead — and unlike
every other one, this also lands code in `main`, which is the strongest argument for
the second tap in the whole app.

### Request changes is a sentence, not a button

There is no one-tap "changes requested". It opens the card and puts you in the answer
box, because "changes requested" with no note is the least useful thing you could send
a session that is about to try again.

What you type goes to both places it is needed: a comment on the pull request, where
whoever opens the diff will look for it, and a comment on the bead, where the next
session reads it before starting. Then the bead is **reopened and unclaimed** — it was
claimed by the session that built the branch, and a claimed bead never comes back
through `bd ready`, so without this your note would sit on work nothing would ever
pick up again. The branch stays open and the next session pushes to it.

On a delivery card the free-text box has one job, so it says so: the button reads
*Request changes & close*, and prose sent from there travels with the `CHANGES:`
marker. Note which way that fails. No wording of a typed answer can merge anything —
merging needs `MERGE:`, and only the button writes it. Prose is safe in the one
direction where safety matters.

### Decline is the other one, and it is not a stronger no

*Request changes* and *decline* look adjacent on a phone and are not the same act.
Choosing wrong costs a whole session, so the difference is the first thing the panel
says:

|  | request changes | decline |
|---|---|---|
| what was wrong | something **on** the branch | the **approach** |
| the pull request | stays open | closes |
| the branch | stays, push more commits to it | abandoned |
| the bead | back in the queue | back in the queue |
| the next session | continues the same attempt | starts again, fresh branch |

Declining takes two steps rather than a timed double-tap, because the second step has
a box in it. **The direction is optional and it is the most valuable sentence in this
whole channel** — a decline with nothing attached tells the next session only that its
predecessor was wrong, which is exactly enough information to do the same thing again.
So what you type goes onto the bead under a *This approach was declined* heading,
along with the closed PR's number and the name of the branch not to touch. Where you
left nothing, the bead says so plainly rather than pretending there was guidance:
*"No direction was given. Read the closed PR before starting again."*

What is **not** declined is the work. The bead is reopened and unclaimed, never
closed — deciding against an attempt is not deciding against the thing it attempted,
and closing the bead would quietly make it so. The unclaim is the part that actually
matters: the bead was claimed by the session that built the branch, and a claimed bead
never comes back through `bd ready`, so without it the work would sit open forever,
held by a process that exited hours ago.

Both buttons that can finish a decline — the one in the panel, and the primary under
the box you may have scrolled down to type in — send the same thing. They are far
apart on a long card, and either should be able to finish the job.

### Consent is a marker, because two of the three paths carry only text

The same discipline as an advocate's proposal, for the same reason: the phone sends
the option's response string, and an ntfy action button sends the same. There is no
option id on the wire, so each acting answer *starts* with its marker and nothing else
is treated as consent.

| marker | what it does |
|---|---|
| `MERGE:` | `gh pr merge --squash --delete-branch`, then closes the work bead with the PR number in its reason |
| `CHANGES:` | comments on the PR and the bead, reopens the bead, leaves the branch alone |
| `DECLINE:` | closes the PR unmerged, abandons the branch, reopens the bead — and writes whatever direction you gave onto it |

"Looks good to me" is a comment, which is exactly what it looks like. So is *"I think
we should MERGE: it"* — the marker only counts at the start.

The merge happens **before** the question is closed, the same order `createProposed`
keeps: a merge GitHub refuses leaves the question open and answerable rather than
closed on a promise nothing kept. And it is never `gh pr merge --auto`. Queuing a
merge to happen later when checks go green would make your tap a promise rather than
an act, and the question would close on work that had not landed.

A delivery question closes on all three answers, including *request changes* — the
question was *merge this?* and it has been answered. The next push files a new one, so
the inbox carries one card per attempt rather than one card that quietly changes
meaning under you.

### Discoveries and conflicts, at the moment they happen

**An agent still may not create a bead.** That rule is unchanged and absolute; Adam
approves every bead before it exists. What changed is *when* he gets to approve one.

A session used to write what it found into a `## Discovered` heading in a comment and
carry on. Those sat there — invisible, unanswerable — until the repo's advocate ran
out of ready work and surveyed the comments, which on a repo with a queue is never. So
a discovery arrived a fortnight after the context that made it obvious had gone, or it
arrived not at all.

Now a session proposes when it finds the thing:

```bash
beadcause-propose -w beadcause --from bc-7qo --kind discovery <<'EOF'
- title: Cache-bust site.js
  type: task
  priority: 2
  description: |
    No ?v= on the script tag, so a shipped header change looks absent.
  acceptance: A deploy changes the URL.
  rationale: Found while reading base.html for bc-7qo.
EOF
```

That files one ordinary question, which reaches your phone through the same channel
and renders as the same card an advocate's proposal does — a row per bead, with its
own controls. Nothing is created until you press the button. Only the waiting is gone.

`--kind conflict` is the other half, and the more valuable one. A session that hits
two things that genuinely disagree — its brief against the repo's `CLAUDE.md`, a bead
against what the code actually does, two beads that cannot both be right — used to
have no move except to pick one and carry on, which is how an unattended queue quietly
does the wrong thing for a week. A conflict is filed at P1, and it **parks the bead
that hit it behind the question**, so nothing reopens that work until you have settled
it. Then the session stops.

### Approve, adjust, decline

Every proposal row has had ✓ and ✕ since proposals existed. The third control is new,
and it is there because ✓ and ✕ are a verdict on someone else's sentence and the
common case is neither: the bead is worth filing, but the title is wrong, or it is a
P1 and not a P3. Without a third option that lands as a decline — and the work comes
back next week phrased exactly the same way, because nothing recorded what was
actually wrong with it.

**✎ opens the row for editing**: title, description, what done looks like, type and
priority. Tapping it also approves the row, which is not a shortcut — adjusting a bead
is the strongest possible statement that you want it, and making you rewrite the title
and *then* hunt for the ✓ is how a considered edit turns into an accidental decline.

Labels and dependencies are deliberately not editable here. They are structural, they
are rarely what is wrong with a proposed bead, and a chip editor is not something to
build onto a card you are trying to keep short. What you do not adjust is created
exactly as proposed.

Your edits live in the app's own state, not in the DOM, so a background poll cannot
lose a word of them — the same protection the answer box gives a half-written answer.
A field you type into and then change back stops counting as an edit, because the
**adjusted** flag has to mean something. On create, only the rows you approved carry
their edits: a bead you adjusted and then declined is a bead nobody filed, and sending
the rewrite for it would put your words in the record of something that does not exist.

Every edited field goes back through the same normaliser the block is parsed with, so
a priority typed into the wrong box is clamped on the way in rather than failing at
`bd create` with half the proposal already filed.

### The repos this does not apply to

Not every workspace is a repo, and not every repo has a remote — the scratch trackers
under `~/beads/` mostly have neither. So the whole channel asks three questions before
it engages, and any "no" is a state rather than a failure:

| condition | if no |
|---|---|
| `pr.enabled` in config | every workspace keeps the old ending |
| `gh` installed and authenticated | same, and the reason is logged once |
| the checkout has a GitHub remote | that workspace keeps the old ending; the others are unaffected |

A session in a workspace without a remote is told the older brief — work the bead,
close the bead — and everything else carries on. One unremoted repo must never be able
to stop the advocate working the rest, which is the failure mode a mandatory PR
channel would have.

```json
"pr": {
  "enabled": true,
  "base": "main",
  "mergeMethod": "squash",
  "tidyMerged": true
}
```

`squash` because a session's branch is thirty commits of an agent thinking out loud
and `main` should carry the conclusion.

### What it does to the two things that were already here

**A fourth ending.** The advocate reads three endings off a session that exits:
closed, handed back, or unfinished. A delivered session is none of them — its bead is
*supposed* to still be open, because merging is what closes it. Without a fourth the
best possible outcome would read as "exited unfinished", cost an attempt, and after
two deliveries the advocate would give up on a bead whose work was sitting in a pull
request waiting to be approved.

| the file appears and… | reading |
|---|---|
| the bead is closed | **done** |
| an open `pr-delivery` question names this bead | **delivered** — waiting on your merge, costs no attempt |
| the bead carries `human` | **handed back to you** |
| neither | **exited unfinished** — costs an attempt |

**The sweep learned a second way for a branch to be gone.** Its fifth condition was
"its branch is an ancestor of `main`", and a squash-merged pull request puts a *new*
commit on main with the branch's tree and none of its history — so that test is false
forever. Every delivered worktree would have piled up unswept while the log said "not
merged into main" about work that shipped last week. So when the cheap local test says
no, and only then, the sweep asks GitHub whether the branch's PR merged. The other four
conditions are unchanged, and a repo with no `gh` behaves exactly as it did.

The retirement note says which answered: `retired by beadcause after #42` and `retired
by beadcause after a1b2c3d` are different stories, and only one of them is findable
later.

**The session log's landing note had the same blind spot**, and it is worth naming
separately because it fails more quietly. `refs/notes/beadcause` records which commit
finally brought a session's branch into main, and it found that commit by walking the
ancestry — so after a squash merge it would never find one, the note would never be
written, and the entry waiting to write it would sit in the pending list being retried
on every sweep for good. GitHub knows the answer exactly: `mergeCommit` **is** the
squash commit, which is a better anchor than the ancestry walk could produce. Same
rule as the sweep — asked only after the local test says no.

### Checking it

`npm test` covers the two libraries — `test/pr.mjs` drives `lib/pr.js` against a fake
`gh` on `PATH`, keyed off a JSON world file and a call log, so *"it never shelled out"*
is an assertion rather than a hope; `test/delivery.mjs` covers the block, the markers
and the split. Neither touches the network, a bead, or a repo.

`node scripts/delivery-check.mjs` is the other half: the real `public/app.js` in a
headless Chrome the size of a phone, against a fixture built by `lib/delivery.js` and
parsed back by `lib/decision.js`, with `/api/pr` stubbed through its four states. It
asserts the things only a browser can answer — that a failing check is named and still
leaves merge pressable, that a conflict disables it and says why, that one tap arms
and two send, that typed prose leaves with `CHANGES:` and can never leave with
`MERGE:`, and that adjusting a row survives a background poll and rides out with the
create. `--out=<dir>` writes a screenshot; `--keep` leaves it served so you can open it
yourself. It needs `npm run vendor` to have run — a fresh worktree has no
`public/vendor`, and without it the app throws on its first markdown render and the
list never appears, which looks exactly like a bug in whatever you just changed.

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

## The chat session — deciding what to file

Everything above acts on beads that already exist. The chat session is upstream of that:
a chat where you work out *what the next bead should be*, and beadcause creates it
only once you have read the proposal and pressed the button.

**🧾 Chat in the tab bar** opens it. Pick a repo and press **＋** — or open one **on an
existing bead**, from *Work out the next beads from this* at the foot of any card,
which starts the conversation with that bead already read.

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

### The launcher is a tab per repo, and ＋ is what starts one

The repo row used to be the start button: tapping `sophab` opened a new conversation
in sophab, and underneath it every conversation from every repo sat in one pile. With
enough repos and enough sessions that pile is the thing you actually have to read, and
it never groups the way you think — the conversation you want is the third sophab one,
three beadcause rows down.

So the row is a **tab bar**. **All** on the left, one tab per repo, each carrying how
many conversations it holds, and the list below shows only the selected repo's. The
tab you leave on is the tab you come back to (`localStorage`, beside the token), so
the launcher opens where you left it rather than making you re-pick every visit.

Which means the row no longer starts anything, and starting moves to a **＋** beside
it. On a repo tab it starts there, immediately, exactly as tapping the chip used to.
**On All it asks** — a row of repos under *Start one in*, which is the control this
screen already had, kept for the one case the tabs cannot answer. The alternative was
a disabled ＋, and All is the tab the launcher opens on: a default screen with the
primary action greyed out is a worse trade than one extra tap.

Three smaller things that follow from it:

- **Every repo gets a tab, whether or not it has ever been talked to** — the bar is
  also how you reach a repo to start in. A repo with nothing in it shows no count
  rather than a `0`, and its empty list says so and names ＋, because a blank panel
  under a tab you just selected reads as a fault.
- **A repo that only exists in the conversations still gets a tab**, so a workspace
  dropped from the config does not take its transcripts out of reach. It gets no place
  in the ＋ picker, though: it is somewhere you can read, not somewhere you can start.
- **A remembered repo that is gone falls back to All.** Otherwise the launcher opens
  on an empty screen for a filter you cannot see the name of.

The tabs borrow the inbox's `.chip` deliberately: this row *is* the inbox's workspace
filter doing the same job to a different list, and a thumb should not have to learn two
shapes for one idea.

`node scripts/launcher-check.mjs` checks it in headless Chrome at phone size, against a
fixture `/api/consoles` served by the script itself, so it never touches a daemon or a
bead. Eighteen assertions: the tabs and their counts, that selecting one filters the
list to it, that the selection survives a reload, that ＋ POSTs the *selected* repo and
lands in the thread, that ＋ on All opens the picker and starts nothing by asking, the
empty and the removed-repo cases, and — the one that must not have changed — that
opening a conversation by id still bypasses the launcher entirely. `--baseline` serves
the committed `console.js`/`console.html`/`style.css`, where there is no All tab and no
＋ at all, so it must fail everything but that last one. `--out=<dir>` writes the three
screens, because a row of passing assertions says nothing about whether the tabs and
the ＋ fit beside each other at 393px.

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

### What you just filed, one tap away

Creating leaves a **✓ Created N beads** note in the scrollback, one row per bead. That
row is the one link in beadcause you tap while still holding the thought that made the
bead, so it goes straight to the bead: `?open=1` on the graph page raises that bead's
detail sheet as soon as the graph has drawn, and the text you just wrote is on screen
without finding a node in a force layout mid-animation. Dismissing the sheet leaves you
on the graph, scoped to that bead, which is where the link used to stop.

The whole row is the target — pill *and* title in one anchor, 40px tall. The title was
the big wrapping thing beside a 40px-wide pill, and it looked tappable long before it
was. Same for the **Starting from** line at the head of a seeded chat session.

`node scripts/created-link-check.mjs` checks all of it in headless Chrome at phone
size, against fixtures rather than the daemon, and aims `elementFromPoint` at the
middle of the *title* rather than trusting the markup. `--baseline` serves the
committed `console.js`/`graph.js`/`style.css` instead: it must fail the five link and
target cases and pass the two that describe what already worked.

### A chat session ends when the beads exist

A chat session is a conversation with one purpose, and pressing **Create** achieves it. So
accepting closes it and drops you back to the list — there is nothing left to say to
a conversation whose whole subject is now three rows in the tracker, and a list where
every finished one stays open is a list you read past to find the one that isn't.

Closing is **soft**. The transcript stays on disk, the id keeps working, and saying
anything to a closed chat session reopens it — "one more thing" is a normal thought to
have five minutes later, and a dead end you can navigate to and not use is worse than
a row you close twice. The unspent draft *is* dropped, because cards left on screen
after a close are an invitation to create them twice.

- **✕ on any row** in the list closes it by hand — for the conversations that end by
  going nowhere rather than by filing anything. The ✕ and the row are siblings, not
  nested, so closing one can never also open it.
- **Closed rows sink** below the live ones, dimmed, with a `closed` pill.
- **Warnings keep it open.** A create that reports one — a parent that does not
  exist, a dependency it could not resolve — leaves you on the screen that produced
  it. Dropping to the list would take the warning away before it was read.
- **Refused mid-turn**, with a `409` that says so: a chat session that is `thinking` has an
  agent streaming into it, and a reply arriving into something the list calls
  finished is worse than closing it twice.

Both the close and the reopen appear in the scrollback as quiet divider lines. They
belong in the history, but rendering them in an assistant bubble would read as
something the agent said.

### Keep typing while it is working

Both chat surfaces used to treat a running turn as a reason to shut the composer
down. The bead console disabled the box and the send button and swapped the
placeholder for `working…`, which on a phone means the keyboard drops and there is
nothing to type into; the agent chat let you type but refused to send, so what you
wrote came back into the box behind a red toast. On the CLI you can type — and queue
— the whole time an agent is working, and losing that on the phone is worse rather
than better, because a turn that spends ninety seconds reading files is ninety
seconds of a thought you have to hold in your head.

So the composer stays live for the whole turn, on both screens, and what a running
turn changes is only where the words go:

- **Sending mid-turn queues.** The message appears above the composer as its own
  dashed line, in your own words, so it reads as said-but-not-yet-delivered rather
  than as part of the conversation or as lost.
- **The queue flushes when the turn lands**, as the next turn, automatically.
- **Everything said during one turn arrives as one turn.** Two queued messages
  concatenate with a blank line between them. Firing them as two `claude -p` runs
  back to back would answer the first without knowing the second exists.
- **A queued message is editable and removable until it goes.** Tapping the line puts
  it back in the composer — above whatever is half-typed there, so taking a message
  back to fix a word cannot cost the sentence you were in the middle of. The ✕ drops
  it.
- **Nothing pushes through the server's refusal.** `sendTurn` still answers `409`
  while a console is mid-turn, and that stays the truth: this is the side that waits.
  A delivery refused in a genuine race puts the words back and retries, rather than
  reporting a red toast about a feature working as designed.

Delivering a message *into* the turn already running is deliberately not this. That
needs a persistent `--input-format stream-json` process instead of the one-shot
`claude -p --resume` per turn, and is its own piece of work.

The queue lives in the page, like the half-typed text in the composer beside it: a
reload loses what has not gone yet. Everything that *has* gone is on the server and in
the transcript, which is the line worth keeping — a message is either visibly waiting
on your screen or really sent, and never both or neither.

The queue itself is `public/sendqueue.js`, shared by both callers rather than written
twice — including the pending strip, which `queue.attach({ el, box })` draws and wires
back into the composer. The two screens still render a *conversation* their own way,
which is the line: a message that has not gone yet is not part of one, and two
hand-written copies of the same strip would drift. Each caller keeps its own
optimistic bubble, though, and that is deliberate too: the round trip is a process
spawn, and words that vanish for a second read as having been eaten, so the message
is drawn in the thread the moment it goes and taken back out again if the send fails.

`test/queue.mjs` (in `npm test`) covers the queue: queued mid-turn, delivered on the
turn ending, two arriving as one, a refusal that keeps the words and does not spin,
and an idle repaint that re-sends nothing. `node scripts/queue-check.mjs` covers the
half a unit test cannot see — the real `console.js` and `foundations.js` in headless
Chrome at phone size, against a fixture server that answers a mid-turn message with
the same `409` the daemon does: the textarea is enabled, the send button is tappable,
the placeholder is unchanged, the box keeps focus, and both messages land as one turn
with the fixture never once having been pushed through. `--baseline` serves the
committed copies of both files, which fail it.

### An old proposal says what became of it

A reply that proposed beads keeps its `🧾 proposed 3 beads — review` line for the life
of the transcript. The draft it pointed at does not: creating spends it, the next turn
replaces it, closing drops it. So by the time you scroll back up, that button is a
control whose target is gone — and what it used to do then was nothing, silently.

The line stays, because it is part of what the conversation said. What it *offers*
depends on what happened after it, read off the transcript rather than stored on the
message — the first thing below it that either consumed that draft or put another one
in its place:

- **✓ filed 2 beads** — it became beads. Tapping walks you down to the `✓ Created`
  note that consumed it and flashes it, because that note already lists the ids and
  each one opens the bead. It deliberately does not reopen the editor: those beads
  exist, and an editor over them is an offer to file them twice.
- **🧾 proposed 3 beads — revised since; open the current draft** — a later turn
  replaced it. Tapping opens the sheet, which is the honest thing to say about it:
  what is in there is the *newer* draft, not what this message proposed. Saying
  "review" and then showing something else is the quiet lie this replaced.
- **🧾 proposed 2 beads — draft discarded** — visibly disabled. The draft went away
  without becoming anything, which is what closing a chat session does to unspent cards.
  There is nothing to look at, and the only useful thing left to say is that.
- **🧾 proposed 1 bead — review** — the newest live proposal, unchanged. Opens the
  sheet, exactly as before.

`node scripts/console-check.mjs` holds the rule: the real `public/console.js` in a
headless Chrome at phone size, against a fixture chat session served by the script itself,
so it never talks to the daemon. It taps every proposal line in the thread and
requires the screen to answer — the sheet opens, the page moves, something lights up,
or it says why not. `--baseline` serves `HEAD:public/console.js` instead, which is how
you tell a real failure from a flaky one: baseline must fail the filed and revised
cases and the inert tap, the working copy must pass all of them.

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
  a chat session survives a daemon restart.
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
- **Chat sessions live in `~/.config/beadcause/consoles/`** — the directory keeps the
  old name, since it is where the records already are — and are pruned after 30 days.

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

### And it survives the daemon, too

Restarting the daemon still kills every pty — one relaying to a registry that no longer
exists is a leak. What it no longer does is lose the *conversation*.

The terminal picks the claude session id itself, before the process exists, and passes
`--session-id` on the first start; a record per terminal lands beside the chat sessions in
`~/.config/beadcause/terminals/`, written at lifecycle boundaries only — open, resume,
exit, shutdown — never per chunk. On the next boot the registry is rebuilt from those
records and each one comes back **`resumable`**: listed on the terminal page with a ↻
and "resumable — the daemon restarted", holding no process at all. Attaching is what
starts one, with `claude --resume <id>`, and the first thing in the pane says so.

Three things about that are deliberate:

- **Nothing is spawned at boot.** A daemon that respawned four `claude` processes on
  startup would be resurrecting sessions nobody asked for, before anyone was watching.
  The phone attaching is the signal that the conversation is still wanted.
- **A session you ended stays ended.** The record stores `live` (meaning "this did not
  end") or `exited`, and only the first becomes an offer. Getting that backwards would
  reopen finished work on every restart. `shutdownTerminals()` writes each record down
  *before* it kills the pty, and a flag stops the exit handler that follows from
  overwriting it — otherwise the daemon would record, on its way out, that everything
  you had open ended at 4am.
- **The scrollback does not come back, and the pane says so.** It is up to 256 kB of raw
  pty output per terminal, it would have to be written continuously to be worth
  anything, and replaying a dead session's bytes into a freshly resumed TUI draws a
  screen that is half history and half live. `claude --resume` redraws the conversation
  itself, which is the honest version of the same thing.

If the transcript has been pruned since, `claude` says `No conversation found with
session ID: …` and exits — the terminal ends the way any other ended session does,
rather than silently starting a different conversation under the same name.

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
  nothing else — the same rule the "discuss on the Mac" button and the chat session
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
  outliving the process that owns them is a leak. A resumable one (below) counts
  against the cap and ages out on the same clock.
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

## The router — why you never restart it

Static files are read from disk on every request. Server code is read **once**, at
startup. So an edit to `lib/` leaves a running daemon serving today's pages against
yesterday's routes, and nothing about it looks wrong: the files are correct, the
process is healthy, and `/sessions` returns 404 to a page that plainly asks for it.
That happened against a ten-hour-old process, and "remember to restart" is not a fix
— forgetting is the entire bug.

What launchd runs is therefore `bin/router.js`, not the server:

```
     phone ──▶ :4318  router ──▶ :49223  backend (active)   ← polls, notifies
                        │
                        └─────▶ :49238  backend (draining)  ← standby, no poller
```

The router owns the port and never needs replacing. It compares the files on disk
against the build the backend reported *at its own startup*, and when they part it
brings a second backend up beside the first, waits for it to answer, stands the old
one down, promotes the new one, and drains the old one's remaining sockets before
killing it. A few seconds after you save, the port is answering from new code, and
nothing in flight was dropped.

Two properties it holds onto, both of which cost more than they look:

- **Exactly one poller, ever.** A backend starts in `--standby`, with no poller and
  so no advocates and no notifications. The old one is told to stand down *before*
  the new one is promoted, never the other way round — two live pollers would both
  see a new question and both push it, and a duplicate notification on your phone is
  the one thing this must never produce. The few milliseconds in between cost
  nothing; the next tick picks up whatever appeared.
- **Nothing in flight is cut.** `/api/poll` parks for up to 55 seconds by design, so
  a superseded backend is left alive until its last request finishes (or 60 seconds
  pass). Killing it under a parked poll is the difference between a seamless swap and
  the phone deciding it is offline.

Every response carries `x-beadcause-build` and `x-beadcause-pid`, so `curl -sI`
against the real port settles the question that started all this:

```bash
npm run swap:status     # active pid, build, whether disk has moved past it
npm run swap            # swap now, even if nothing changed
npm test                # drives a real swap under load and proves nothing drops
curl -sI http://127.0.0.1:4318/api/health | grep beadcause
```

The limits, stated plainly:

- **The router cannot replace itself.** Doing so means giving up the socket, which is
  the outage the whole thing exists to avoid. Change `bin/router.js`, `lib/build.js`
  or `lib/config.js` and it says so once in the log; you restart it by hand with
  `launchctl kickstart -k gui/$(id -u)/m4m.beadcause`. It is small and it rarely
  moves, which is the trade.
- **A build that will not start is tried once.** If the new backend never becomes
  healthy — a syntax error, a bad import — the old one keeps serving and the failed
  build is not retried until the files change again, because respawning a broken
  process every three seconds helps nobody. `npm run swap:status` names it.
- **The stamp is size and mtime**, over `lib/*.js` and `bin/*.js`. `public/` is
  deliberately absent: it is served from disk per request, so a CSS edit is live
  already and swapping for one would be churn. `touch lib/server.js` is enough to
  force a swap by hand.
- **A backend nobody is steering shuts itself down.** If the router is `kill -9`'d,
  its children survive it — and a stranded backend still holds a poller while the
  replacement router starts a fresh one. So a backend that has heard nothing from a
  router for 60 seconds exits. `npm run start:bare` has no router and is exempt.

## HTTP API

Auth on everything under `/api/` except `/api/health`: header
`x-beadcause-token: <token>`, or `?t=<token>` for URLs that have to be linkable.

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, workspaces[]}` · **no token** |
| GET | `/api/questions` | `?scope=human\|both\|agent` | `{questions[], workspaces[], spaces[], summary, scope}` — `scope` defaults to `human`, and an unrecognised value falls back to it rather than erroring. `summary` is `{sessions, proposals, questions}`, the three counts the inbox's chrome draws |
| GET | `/api/question` | `?workspace=&id=` | one question **plus `comments[]`** |
| GET | `/api/poll` | `?since=<seq>&wait=<s>` | long-poll: `{seq, resync, events[], questions, workspaces[]}` |
| POST | `/api/respond` | `{workspace, id, response, create?, edits?}` | comments, then closes the bead. `create` is the 1-based indices of a proposal's beads to file; without it, `CREATE:` in the text means all and `CREATE: 1,3` means those. `edits` is `{n: {title, type, priority, description, acceptance}}` keyed by the same numbers, applied before creating. A `MERGE:` / `CHANGES:` / `DECLINE:` response on a delivery question acts on its pull request first — see [Landing work](#landing-work--a-branch-a-pull-request-and-your-tap) |
| GET | `/api/pr` | `?workspace=&id=` | `{delivery, pr, unavailable}` — the live diffstat, check rollup and mergeability of a delivery question's PR. Every failure is an answer rather than a 500: no `gh`, no remote, GitHub unreachable all come back with `pr: null` and a sentence in `unavailable` |
| POST | `/api/comment` | `{workspace, id, text, agent?}` | comments, sets `human-replied`, dispatches that agent to reply (default when absent or unknown) |
| POST | `/api/ask` | `{workspace, title, body, priority}` | `{id, key}` — files a new `human` bead |
| POST | `/api/session` | `{workspace, id}` | `{dir}` — opens iTerm2 + `claude` on that bead |
| POST | `/api/status` | `{workspace, id, phase, detail, actor}` | agent progress |
| GET | `/api/agent-log` | `?workspace=&id=` | `{lines[], running, phase}` — the dispatched agent's log, as the CLI would have shown it |
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
| GET | `/api/session-log` | `?pid=` | `{pid, sessionId, status, file, lines[]}` — the tail of that live session's own transcript. 404 for a pid that is not running |
| GET | `/sessions`, `/work` | — | the current-sessions page (same page, two paths) |
| GET | `/graph` | `?ws=&id=` | the HTML graph page |
| GET | `/api/consoles` | — | `{consoles[], workspaces[]}` — every chat session, newest first; `closedAt` set on the finished ones |
| POST | `/api/console/close` | `{id}` | soft-closes it and returns the new list. `409` mid-turn; saying anything to it reopens it |
| POST | `/api/console` | `{workspace, seed?}` | `{id, console}` — opens one; a `seed` bead auto-starts the first turn |
| GET | `/api/console` | `?id=` | the whole chat session: messages, draft, created beads |
| POST | `/api/console/message` | `{id, text}` | starts a turn and returns — follow it on `/api/console/poll` |
| GET | `/api/console/poll` | `?id=&since=&wait=` | long-poll: the whole chat session, once its `seq` moves |
| POST | `/api/console/draft` | `{id, draft}` | the cards as you edited them; re-normalised on the way in |
| POST | `/api/console/create` | `{id, draft?}` | `{created[], warnings[]}` — **the only writer in a chat session** |
| GET | `/console` | `?id=` or `?ws=&seed=` | the chat session page |
| GET | `/api/terminals` | — | `{terminals[], workspaces[], enabled}` — every terminal, newest first. `status` is `live` · `resumable` (was running when the daemon restarted; attaching resumes it) · `exited` |
| POST | `/api/terminal` | `{workspace, id?, cols?, rows?}` | `{terminal}` — opens one; an `id` seeds it on that bead |
| GET | `/api/terminal` | `?id=` | `{terminal}` — one, without its bytes |
| POST | `/api/terminal/close` | `{id}` | ends it (SIGTERM, then SIGKILL after 5s) |
| WS | `/ws/terminal` | `?id=`, subprotocols `beadcause.term.v1` + `tok.<token>` | binary frames both ways are pty bytes; JSON carries `hello` · `ready` · `exit` in, `input` · `resize` · `close` out |
| GET | `/terminal` | `?id=` or `?ws=&seed=` | the terminal page |

Two more, **loopback and token only**, and never proxied to a backend — anyone on
the tailnet holding the token could otherwise stop the poller:

| Method | Path | Returns |
|---|---|---|
| GET | `/internal/router/state` | `{router, disk, stale, poisoned, active, retiring[]}` — what `npm run swap:status` prints |
| POST | `/internal/router/swap` | `{ok, active}` — or `{ok:false, error}` if the new build would not start |

Every proxied response also carries `x-beadcause-build` and `x-beadcause-pid`,
naming the process that actually answered.

Two things that bite: `commentCount` is **0 from `/api/questions`** and only correct
from `/api/question`, because `bd human list` doesn't return it. And a question
filed through `/api/ask` is **not** pushed — you filed it yourself and are looking
at the screen — though it does raise a `created` event so other clients refresh.

A row from `scope=agent` is **not** a question: it carries `agent: true`, has no
`decision`, and its `description` is deliberately absent — fetch that from
`/api/bead`. `/api/question` is the wrong endpoint for one, because it parses the
decision block and only means anything for a `human` bead.

### The three counts on the poll

`/api/questions` carries a `summary` — `{sessions, proposals, questions}` — because
the chrome of the inbox wants to say how many beads are asking you something, how
many agents are running and how many advocates are waiting on an answer, and it is on
screen whenever the inbox is. Everything else in that picture is on `/api/work`,
which is two `bd` calls per workspace and about a second for six: fine when you open
it, not fine every thirty seconds on a phone.

These three are the exception because none of them costs a `bd` call. `sessions` is a
readdir of `~/.claude/sessions` plus a JSON parse per record — every live session on
the Mac, including ones in no configured workspace, which is exactly the set the
sessions page lists. `proposals` counts **advocates**, not beads: one open ask per
advocate is the rule `propose()` enforces, so a repo with two proposal-shaped beads
in it is still one repo waiting on you.

`questions` is the inbox's own count — the beads asking you something — and it is the
questions channel only: a [foundation request](#a-channel-of-its-own-on-every-surface)
has the ⚖️ badge in the bar already, and counting it in both places would make the two
disagree about the same bead.

`proposals` and `questions` are both held from the last `human` sweep rather than
counted out of the response, and that is deliberate. The `agent` scope runs no
`human` sweep at all, so counting the rows would empty them the moment you switched
tabs — which reads as "answered" rather than as "not fetched". The poller sweeps every
thirty seconds whatever any client asked for, so the numbers are at worst one poll old
in any scope.

The field is additive and its own object: a client that has never heard of it — the
installed Android build, a service worker still serving last week's `app.js` — reads
the fields it always read and renders exactly as it did.

## Config — `~/.config/beadcause/config.json`

| key | meaning |
|---|---|
| `owner` | what the agents call you. It goes into every agent prompt ("*<name>* is not at the keyboard", "*<name>* approves every bead before it exists"), the body of every pull request an agent opens, and the notes that land on a bead. Asked first by `npm run configure`; guessed from your git `user.name` (first word) when it has never been set |
| `port`, `host` | listens on `127.0.0.1` **and** the Tailscale IP only — never the LAN |
| `token` | required on every `/api/*` call; regenerate by deleting the file |
| `workspaces` | auto-discovered from `~/beads/*/.beads`, and **reconciled on every start** — entries whose directory has gone are dropped and new ones picked up, both logged. Renaming a workspace directory used to leave a stale entry that failed on every poll tick, silently hiding that whole workspace from the phone |
| `openSessions` | allow `POST /api/session` to open a Claude session on the Mac (default `true`) |
| `sessionDirs` | override where a workspace's session opens. Normally unnecessary — see Discussing a question on the Mac |
| `sessionPermissionMode` | `--permission-mode` for an opened session (default `auto`; `null` to omit the flag) |
| `beadConsole` | allow the [chat session](#the-chat-session--deciding-what-to-file) to open conversations and create beads (default `true`) |
| `consoleModel` | model for a chat-session turn (default `null` — whatever `claude` uses on its own; `"sonnet"` for a cheaper conversation) |
| `consoleTimeoutMs` | kill a chat-session turn that has been going this long (default 15 min) |
| `terminal` | allow the [in-app terminal](#the-terminal--driving-a-session-from-the-phone) to open a real Claude Code session over a WebSocket (default `true`) |
| `terminalPermissionMode` | `--permission-mode` for a terminal (default `null` — inherit your settings; unlike `sessionPermissionMode`, you are sitting in front of this one) |
| `terminalIdleMinutes` | close a terminal nobody has been watching for this long (default 30; the clock only runs with no socket attached) |
| `terminalScrollbackBytes` | replayed on reconnect, so a locked screen misses nothing (default 256 kB) |
| `terminalMax` | how many terminals may be open at once (default 4) |
| `autoDispatch` | commenting spawns an unattended agent to reply (default `true`) |
| `autoDispatchExclude` | workspaces that never auto-dispatch — put shared trackers here |
| `autoDispatchTimeoutMs` | kill a dispatched agent after this long (default 10 min) |
| `pr.enabled` | deliver finished work as a [pull request you merge](#landing-work--a-branch-a-pull-request-and-your-tap) (default `true`). `false` puts every workspace back on the old ending — work the bead, close the bead. A workspace with no `gh` or no GitHub remote gets that ending anyway, without needing to be named |
| `pr.base` | what a PR is opened against and merged into (default `main`) |
| `pr.mergeMethod` | `squash` (default), `merge` or `rebase`. Squash because a session's branch is thirty commits of an agent thinking out loud |
| `pr.tidyMerged` | let the worktree sweep ask GitHub whether a branch's PR merged, since a squash-merge never makes it an ancestor of main (default `true`) |
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
| `claudeProjectsDir` | where session transcripts live, if not the `projects` folder of every `~/.claude…` directory. Takes a list. Governed by `claudeSessions` — off there means no transcripts either |
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

### Every state file is replaced, never overwritten

Everything beadcause remembers between restarts is a small JSON file in that
directory: `config.json`, `state.json` (what has been pushed), `status.json` (what
each agent is doing), `advocates.json`, and one file per chat session under
`consoles/`. All of them used to be written with a bare `fs.writeFileSync`, which
truncates the file to zero and *then* writes — so a crash, a `kill -9`, a full
disk or a lid closing inside that window did not cost you the last change, it cost
you the whole file.

Worse, it cost it quietly. Every reader here treats an unparseable state file as
an absent one, because that is the right thing to do the first time you run:
`loadState` returns `{ notified: [] }`, `readAll` returns `{}`. So a torn file
does not raise anything. It just means every question is unread again, every
cooldown has reset, and the chat sessions you had open are gone — and nothing in the
log says why.

`lib/atomic.js` writes to a temp file beside the target, `fsync`s it, and renames
it over the top. `rename(2)` is atomic within a filesystem, so a reader sees the
whole old file or the whole new one and there is never an instant where the name
does not resolve. The `fsync` before the rename is the half that is easy to skip:
without it the rename can reach disk ahead of the data it points at, which turns a
power cut into a correctly-named empty file — intact-looking, and therefore worse.

`npm test` proves it — `test/atomic.mjs` SIGKILLs a child that is writing in a
loop and asserts the survivor is always a whole version. Run
`node test/atomic.mjs --baseline` to watch the plain `writeFileSync` it replaced
lose the file outright; that run is what makes a pass mean anything.

The temp prompt files handed to `claude` are deliberately left alone: they are
born, read once and deleted, so a torn one is a failed spawn rather than lost
state.

That covers a file being *torn*. What it cannot cover is a file being rewritten
with something you did not want — for which the directory is now a git repo and
every one of these files is committed after it changes. See
[the state files get a history for free](#the-state-files-get-a-history-for-free).

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
[beadcause]   the terminal, the chat session and answering still work
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
instance rather than absent, so a page can never paint the badge over a daemon
that is in fact opening windows.

**What still works** is everything you sit in front of: the terminal, the chat
session, answering and commenting on questions. A mode that broke those would be a
mode nobody uses. Note the tracker is shared regardless — a bead you create from the
chat session of an observer instance is a real bead, and an answer is a real answer.

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

Seven suites: `scripts/selftest.mjs`, then `test/observe.mjs`, `test/atomic.mjs`,
`test/memory.mjs`, `test/summary.mjs`, `test/terminal.mjs` and `test/queue.mjs`. What they have in common is that each covers something whose
failure is *silent* — a flag that does nothing, a state file that comes back empty,
a message that was never written. The loud failures are still covered by
`node --check` on changed files and by booting an observer instance and driving it.

`test/observe.mjs` is about observer mode only, and it is the oldest of them —
because this is the switch here that fails most quietly. Turn off the terminal
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
stops there.

`test/summary.mjs` covers the three counts on `/api/questions`, against a stub `bd`
that logs every invocation and a temp `~/.claude/sessions`. The arithmetic is not the
risk; four quieter things are. That the counts start costing a `bd` call — the log
is asserted to be one `human list` per workspace and nothing else, so a sweep added
by accident fails here rather than turning up as a slower inbox months later. That a
count empties in a scope that sweeps no questions. That the waiting count claims the
other channel's beads as well as its own — the fixture holds a `foundation` bead, and
it is asserted into `requests` and out of the count. And that the response stopped
being additive — every field an older client reads is asserted still present and
unchanged.

`test/terminal.mjs` covers what a terminal remembers across a restart, at the record
layer and nothing below it: that one which was running comes back `resumable` with the
session id that makes resuming possible, that one which *ended* stays ended, that a
record from before this existed or a half-written one is dropped rather than offered as
something that cannot be delivered, and that the flags are `--session-id` first and
`--resume` after. The pty itself is a named `skip` — `expect` and `claude` both being on
PATH is not something a test should assume, and a test that opened one would leave a
Claude session running in a temp directory.

`test/queue.mjs` covers what happens to words typed while a turn is running, because
every way that breaks is silent from the outside: a message queued and never sent
looks exactly like one you forgot to type, and one sent twice looks like the agent
repeating itself. It loads the real `public/sendqueue.js` in a `vm` context with
nothing in it but a `window` — a copy of the logic rewritten as a module would pass
while the page shipped something else — and holds five rules: mid-turn queues,
turn-ending delivers, two queued messages become one turn, a refused delivery keeps
the words and gives up rather than spinning, and an idle repaint re-sends nothing.
The browser half is `scripts/queue-check.mjs`, named as a `skip` at the end of the
suite so what it does *not* cover is on the screen rather than in a comment.

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
