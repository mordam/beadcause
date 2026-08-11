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

**Nothing to answer? Say so.** `npm run install-service -- --non-interactive` (or
`SKIP_CONFIGURE=1`) prints the configuration on file and changes none of it. An agent
session or CI is assumed to mean that already — `--interactive` asks anyway. The
questions are read from `/dev/tty` rather than stdin, because `npm run` pipes stdin;
but `/dev/tty` is the *controlling terminal*, not a person, so in an agent session
they are asked of nobody and the install waits forever on the first one. Working
around that by dropping the terminal (`setsid`) leaves the GUI session too, and
`launchctl bootstrap gui/<uid>` then fails — after the bootout, so the daemon ends up
unloaded. The flag exists so neither workaround is needed.

Relatedly, a load that fails now puts back what it replaced. The installer bootstraps
a job that does nothing before it boots the real one out, so a session that cannot
load launchd jobs at all is found out while the service is still running rather than
after it has been stopped; and a plist launchd refuses is set aside as
`m4m.beadcause.plist.rejected` while the previous one is restored and loaded again.
It still exits non-zero — it just never exits with nothing running.

```bash
npm run monitor              # live view of what the daemon is doing
npm run check                # the checks around the agent log — safe with the daemon up
npm run secrets              # has a secret ever reached the config repo's history?
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
   build ends where the install begins and nobody should thumb a tailnet name, a port
   and a path into a phone. The link is `https://<host>.<tailnet>.ts.net:4318` once
   the tailnet can issue certificates, and the Tailscale address over plain http until
   then — see [the URL you are given](#the-url-you-are-given-and-what-happens-to-a-phone-that-already-has-one).
   Every device needs this once — a
   notification opened on an unpaired phone lands on the token prompt, or on the
   [sign-in screen](#signing-in-with-google) if you have configured Google, which either
   way is the tell. **A phone paired before the URL moved needs it a second time**, because the
   token is stored per origin and the name is a different origin from the address.
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
- **The tailnet address is HTTPS**, with a real certificate for your MagicDNS name and
  a TLS 1.2 floor — once *HTTPS Certificates* is enabled for the tailnet. Until then it
  logs why and serves plain http. Loopback is plain http on purpose. The daemon
  [renews the certificate under itself](#renewing-it-before-it-expires) and pushes to
  your phone if it ever cannot. See
  [HTTPS on the tailnet name](#https-on-the-tailnet-name).
- **Two credentials, and the token is not going anywhere.** Everything that is not a
  browser uses the shared token, exactly as it always did. A browser can *also* sign in
  with Google against an allowlist of addresses, once you configure one — see
  [Signing in with Google](#signing-in-with-google). Configure nothing and nothing
  changes.
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
- `recommended: true` on one option puts a ★ and a tag on its button. `recommend:
  <id or label>` beside the list is the same thing said once instead of per row,
  and wins if both are written. Only one option is ever starred: two is the block
  contradicting itself, and a card is the wrong place to discover that.
- **`closes: false` on an option that commissions work rather than settling it.**
  Answering normally closes the bead, which is right for a verdict and wrong for a
  build order: "Build both as written" is an instruction, and closing on it files
  the work as finished at the moment it is ordered. An option marked this way
  comments the answer, drops the `human` label and leaves the bead open and
  unclaimed — so it goes straight into `bd ready` and an advocate picks it up as
  work, instead of a session having to reopen it by hand and put the card back in
  your inbox. Everything else about the tap is the same, including the card
  leaving the inbox; the toast says which of the two happened.
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

### Suggested answers — when there is no block

Most beads are not filed by anything that has heard of beadcause. A session ends,
writes its open question into `bd` as ordinary prose with the choices in a list,
and the card used to render that as paragraphs with an empty box under them — the
answer visible on screen and still needing to be typed out with a thumb.

So when a bead carries **no** `decision` block, beadcause reads the prose and
offers what it finds as chips on the top edge of the answer box:

```
Suggested — read out of the design            tap to fill the box
[ ★ Restore at promotion ]  [ Restore at startup ]
```

**A chip fills the box; it never sends.** That is the whole difference between
these and the buttons above. An `options[].response` was written by an agent as
the answer, so tapping it twice answers and closes. A suggestion is a sentence
this parser lifted out of a paragraph, so it goes where you can read it, edit it
and add a caveat, and *Answer & close* is still what commits it. Tapping a second
chip swaps your pick; tapping one after you have typed something appends, because
the words you wrote are never thrown away.

**Write the list and it will be found.** Any of these parse, in this order:

- `**Bold label** — the rest.` as a bulleted or numbered list. The bold run
  becomes the chip; everything after it rides along in the answer.
- `Option A — …`, `Option B: …`, anywhere — list, heading or bare paragraph.
- A plain list directly under a lead-in line: *The options:*, *Choices:*,
  *Candidates:*, *Two ways forward:*.

**Say which one you would pick** with `(recommended)` in the item, or a closing
line — `RECOMMEND Restore at promotion — the swap read is cheap`, which is the
spelling the `handoff` skill already tells every session to write. A closing line
beats an inline marker, because it is the later thought. `not recommended` never
stars anything, which matters more than it sounds: it is ordinary prose, and a ★
on it would be the app recommending the thing the brief warned you off.

**It fails towards silence**, and that is deliberate — a card with no chips is
the card you have today, while chips scraped off an unrelated bullet list invite
the wrong tap. Nothing is offered for: one item, more than six, a `- [ ]`
checklist, a list inside a fenced block, two candidate lists with no question
between them to say which one is being asked, or two items that read the same.
Nor for a proposal, an amendment or a delivery — those draw their own controls,
and a second set of chips beside them would be two answers to one question
disagreeing about what the question is.

**A `decision` block is still better** and is what to write when you know the
question is going to a phone: it gets full-width buttons above the fold, the
exact sentence you chose recorded as the answer, and one tap fewer. This is the
safety net under everything else.

#### Checking it

Two, because the parser and the gesture fail in different ways:

- **`node test/suggest.mjs`** — the parser, in `npm test`. Every shape it reads,
  and — the half that carries the weight — every shape it must refuse, since a
  card with no chips is the card you have today while chips scraped off the wrong
  list invite the wrong tap. Both directions of the ★, including `not
  recommended`.
- **`node scripts/suggest-check.mjs`** — the tap, in headless Chrome at phone
  size, driving the real `public/app.js`. It counts writes and fails on one: the
  claim it exists to defend is that a chip fills the box and never sends, and the
  refactor that would break that — routing a chip through the `option` handler —
  reads like tidying up a duplicate. `--baseline` serves the committed `public/`,
  where it must score 7/23: every suggestion case failing, every control passing.
  Not in `npm test` — it needs Chrome.

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

**And it narrows the notifications, not just the view.** The filter is stored on the
server rather than per device, so the poller reads the same value the list is drawn
from: a bead outside what you are filtered to arrives without a push. It still files,
still counts, and turns up the moment you widen the filter — the same contract a
muted space gets, for the same reason. A filter that was only a view meant narrowing
to one workspace and still being buzzed about every other one. The log says which of
the two kinds of quiet it was, because one ends on a clock and the other ends when
you press **All**:

```
[beadcause] sophab/sp-4kd arrived quietly (outside the inbox filter: Work / acme)
[beadcause] acme/cl-9x2 arrived quietly (Work is muted right now)
```

### And it offers to tidy up the noise it already made

Narrowing the filter silences what comes *next*. It used to say nothing at all about
the notifications already sitting unread on the phone for the beads it has just
hidden — which are precisely the ones you have decided not to think about.

So when a filter change excludes beads that are currently ringing, the inbox asks,
once, naming how many:

> **3 unread notifications for beads this filter hides**
> Clearing them touches the phone and nothing else — the beads stay open and
> unanswered, and they come back when you widen the filter.
>
> [ Clear them ]  [ Leave them ]

**Clearing is not answering, and not dismissing either.** It drops the rows from the
Android shell's tray and stops there: `bd` is never called, the beads stay open, they
stay in the inbox, and widening the filter shows them again — if one of them says
something new, it rings again. That is why it travels as its own event type,
`dismissed`, rather than reusing `answered`: every client cancels the row on
`answered` *and* treats the bead as settled, and nothing here settles anything.

**Leave them** is an answer too, not a cancel — it is recorded, so the next poll does
not ask again about the same beads. Widening the filter forgets that, so narrowing
again later is a fresh question rather than a silence you inherited from last week.
Notifications for beads still inside the filter are never touched, and a filter change
with nothing excluded and unread prompts nothing at all.

```
[beadcause] filter narrowed to Work — asking about 2 unread notification(s): sophab/sp-4kd, deluvia/dv-1x9
[beadcause] cleared 2 notification(s) the filter excludes: sophab/sp-4kd, deluvia/dv-1x9 — the beads are untouched
```

**The honest limit: an ntfy notification already delivered cannot be recalled.** ntfy
is a one-way relay and the server has no handle on a message it has published. What
can actually be cleared is the Android shell's own tray, because that shell holds a
live connection and cancels on the event. So the prompt only appears when a client
that *owns* a tray has been seen — the shell passes `shade=1` on its long-poll, and
nothing else does, so a terminal monitor parked on the same endpoint cannot be
mistaken for a phone. If ntfy is your only surface, this offers nothing and therefore
says nothing, rather than showing a button that reports success and clears nothing.
Two weeks without a shade client counts as an app that has been uninstalled.

There is deliberately no in-app unread marker to clear alongside it. The badge counts
beads that are **open**, clearing leaves them open, and a count that dropped would be
claiming a decision nobody made.

`node test/ringing.mjs` (part of `npm test`) covers the server half — including the
real poller, because the one line that records that a bead rang is the easiest thing
here to lose in a merge and the hardest to notice: losing it makes the prompt simply
never appear. `node scripts/shade-check.mjs` is the half that lives in a thumb, in
headless Chrome at phone size: that the pane lands **inside `#list`** so its buttons
are delegated to at all, that each one reaches `/api/notifications/dismiss` with the
right `confirm` and the keys it was shown, and that a poll landing under an unanswered
prompt does not take it away. `--baseline` runs it against the committed `app.js`,
where 13 of the 17 fail.

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
- **Or set it aside**, under the two buttons — see [Setting a card
  aside](#setting-a-card-aside-is-not-answering-it) below. Two taps like everything
  else that makes something disappear, and the second one spells out what it is
  about to do: *Tap again — hides bc-7qo*.
- **From the notification**, when a question has ≤3 options: ntfy's action buttons
  POST the answer straight to the daemon over the tailnet.

An answer lands as a comment authored by `beadcause` and the bead closes with reason
"Answered via Beadcause".

### Setting a card aside is not answering it

**Dismissing closes nothing.** It used to — comment the reason, then `bd close
--reason "Dismissed via Beadcause"` — and that was the wrong shape rather than a
broken one. It read like the tracker's own `bd human dismiss` and it passed its
tests. What it could not survive was the card you most want gone: an **epic with
thirty open children**, which bd flatly refuses to close. Three taps, three
duplicate comments, no dismissal.

The fix was not to make the close work. *"I am not dealing with this now"* is not
*"this is decided"*, and closing the bead to clear the card throws away the thing it
was tracking. So the acknowledgement lives in beadcause's own state, keyed
`workspace/id`, and the tracker never hears about it:

| you typed | what bd is told |
|---|---|
| nothing | **nothing at all** — bd has no idea it happened |
| a note | one comment, verbatim, no wrapper — and no close |

The note is a comment rather than a close reason because an agent watching the
thread reads comments; a close reason is a line only `bd show` prints. And it is
recorded **verbatim**: the bead is not dismissed, you are, so an agent should see
what you wrote rather than a status word beadcause invented.

Dismissing still consents to nothing else. No proposal is created, no amendment
committed, no pull request merged or declined, so a dismissed delivery leaves its PR
open on GitHub. It no longer records a *refusal* against an agent's amendment
request either — that was bookkeeping a close owed, and setting a card aside decides
nothing to record.

#### What brings it back

A card that never returned would be the silent loss this whole app exists to
prevent, so every dismissal is stored with the condition that ends it, decided once
at the moment you dismiss rather than re-derived on every sweep:

| the bead | comes back when |
|---|---|
| an **epic** with open children | every child is closed |
| **blocked** by open dependencies | every blocker is closed |
| anything else | somebody comments on it |

The first two are the same question the answer path's gate asks, which is why they
share `closeGate` — the moment a bead stops being un-closeable is the moment it
stops being a question's *future* and becomes a question. The third is the honest
fallback: nothing about an unblocked bead will change on its own, so a new comment
is the only trigger there is. The toast says which, because a card that vanishes
under the word *Dismissed* reads as gone for good.

The recheck costs one `bd show` per dismissed bead per sweep, and only for beads
still in the inbox — a handful, usually none. A bead that has left the sweep was
answered or closed elsewhere, so its record goes with it rather than accumulating.

`node scripts/dismiss-check.mjs` holds the interaction to its promises in headless
Chrome at phone size: that one tap writes nothing, that the arm expires and any
other armed control steals it, that the note reaches the wire as a `reason` and
never as a `response` — a dismissal read as an answer would be read for markers, and
`MERGE:` in the box would merge a pull request you meant to walk away from.
`node test/dismiss.mjs` is the other end: the argv `bd` actually receives, pinned so
that a wordless dismissal stays a no-op and nothing here drifts back into being a
close. `node test/closepaths.mjs` is what keeps answering and dismissing from being
confused for each other again.

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

### The best refusal is a button that was never there

Refusing before anything is written fixed the damage. It did not fix the shape:
you still opened an epic with thirty open children, read it, typed a paragraph,
pressed **Answer & close**, and *then* learned the tracker was never going to
allow it. That is a lot of work to be told no, and on the beads it happens to —
the epic that is a whole feature's worth of children — it happens every single
time.

So the card asks when it **opens** instead. `/api/question` already does a
`bd show` to build the detail; it now runs the same gate check off that record and
sends the answer with it. Free for anything that is not an epic, because the
blockers are on the record already; one `bd list --parent` for one that is.
Deliberately **not** on `/api/questions` — there it would be a child list per epic
row on every 25-second poll, for cards nobody has opened.

Knowing it, an open card on a gated bead **draws no *Answer & close* at all**.
What is in its place:

- **Comment**, promoted to the primary button, because it is now the only thing
  the box does. The placeholder changes with it — *Say something on the thread…*
  rather than *Answer in your own words…*, which would be inviting a decision the
  screen cannot record.
- **A dashed amber note** where the button would have been, naming the reason and
  linking the children into the graph. Quieter than the `409` note above it —
  dashed and unfilled, with no buttons — because nothing has gone wrong and
  nothing is waiting on you: it is a fact about the bead, and the buttons on the
  refusal note exist only to rescue words you had already typed.
- **Set aside**, unchanged. It closes nothing, so it was never gated, and the bead
  you can least close is the one you most want off the screen.

The `409` path stays exactly as it is, and is now the rare one: what reaches it is
a gate that appeared **between** the card opening and the press — a child reopened,
a blocker filed while you were reading. That window is real, so nothing about the
server-side check is relaxed on the strength of the card having asked first.

Two known limits, both deliberate: a **decision block's option buttons** and a
**proposal's Create-all** also close the bead and are still drawn on a gated card,
falling back to the `409` note when pressed — hiding them would leave a decision
card with no visible way to decide. And a **delivery** keeps its three buttons,
because those are about a pull request rather than about the bead.

### What is gated, and what is deliberately not

The gate belongs to **closing**, and only one of the three ways out of a card
closes anything:

| | closes the bead? | gated? |
|---|---|---|
| **Answer & close** | yes | yes — and not even drawn when the card knew in advance |
| **Comment only** | no | no |
| **Set aside** | **no** — see [above](#setting-a-card-aside-is-not-answering-it) | no |

Dismissing briefly *was* gated, and that was a mistake worth recording: it made the
card bd would least let you close also the card you could not get off your screen.
Fixing the answer path and then applying the same fix to dismiss looked consistent
and was exactly backwards — the two acts are not the same act, and gating both is
what proved it.

The one close that is deliberately **not** gated is the work bead a merged pull
request finishes. That one is already `.catch`-ed and logged: the merge has
happened by then, and failing the request over a bead that would not close would
be reporting the merge as a failure.

### Checking it

Four, because the things that can break here are different things:

- **`node test/closegate.mjs`** — the gate itself: the two refusals, and, the
  expensive half, the six cases that must **not** be refused. A question bd would
  close happily becoming unanswerable from the phone is a worse bug than the one
  this fixes, and a silent one.
- **`node test/closepaths.mjs`** — what each of the two ways out is allowed to
  write, which is a different claim and the one that kept breaking. Both endpoints
  are driven over real HTTP with `cfg.bdBin` pointed at a fake `bd`, so *"wrote
  nothing"* is asserted against the argv bd would have been given: the answer path
  refusing before it writes, the dismiss path succeeding on the same bead and
  writing at most a comment, the card leaving the inbox, and — the promise that
  makes setting aside safe — coming back once what it was waiting on clears.
- **`node scripts/gate-check.mjs`** — what it looks like in your hand: headless
  Chrome at phone size driving the real `public/app.js`, asserting mostly what must
  *not* happen — no error toast, no write, the draft still in the box, and the
  dismiss button never claiming to close anything. Note what it cannot tell you:
  the fixture supplies the responses itself, so it passes whether or not the real
  server would send them. That is `closepaths`' job, and the reason it exists.
  `--baseline` serves the committed `app.js`/`style.css`; `--out=<dir>` writes the
  note.
- **`node scripts/card-thread-check.mjs`** — the other half of the same story: that
  a gated epic never draws the button at all, that the comment takes its place as the
  primary, that the note names the children, and — the control that matters most —
  that an ordinary question keeps every button it had. The same script covers the
  folded thread below, since both are about what an opened card spends your attention
  on.

### A question you have already answered, arriving again

The close gate above explains four of the five beads that ended up carrying the
same answer twice. It does not explain the fifth, and the fifth is a different
mechanism entirely.

**Answering closes the bead — and for a decision, closing is often wrong.** Three
of bc-goo.2's four options were build orders: *build both as written*, *build the
common repo only*, *build the API only*. An answer like that is a commission, not a
conclusion, so the session that picks the work up reopens the bead — and a reopened
bead still labelled `human` walks straight back into the inbox. The card is rebuilt
from the tracker every time, so it arrives carrying the same question, the same four
options, and no trace whatsoever of the answer given an hour earlier. It was
answered identically at 13:33 and again at 14:35 on 2026-08-09, and the log said
only `bc-goo.2 arrived` three times, with nothing marking two of those as the same
question coming back.

**So it still arrives, and it arrives saying what you said.** The other fix — refuse
the second arrival, because the bead has been answered — trades a duplicated answer
for a lost question, and nothing in the tracker distinguishes a pointless reopen
from a bead that has genuinely come back with something new to ask. A question in
front of you is the whole premise here. What was missing was not the card; it was
the fact.

Where that fact shows up, in the order you would meet it:

- **On the card**, between the question and the buttons that answer it — on the
  collapsed row as well as the open card, because the gesture that goes wrong is a
  two-tap answer straight from the list. `⟳ You answered this an hour ago`, the
  answer quoted underneath, and `answered 2 times already` once it has happened
  twice. Nothing is disabled: re-answering is often right, and this states the fact
  rather than making the decision.
- **On the notification**, for the same reason and more urgently — the shade offers
  the first three options as buttons, so a repeat can be answered from a lock screen
  with the card never opened. The title gains `asked again` and the body leads with
  the previous answer. A `minimal` workspace gets the marker and not the answer: *you
  have seen this before* leaks nothing, the sentence you typed leaks as much as the
  question does.
- **In the log**, so this is reconstructable next time: `bc-goo.2 arrived — asked
  again, you answered it an hour ago`.

It is remembered in beadcause's own `state.json`, keyed `workspace/id` like
`dismissed` and `ringing`, written once at the moment you answer — the answer is on
the bead as a comment, and finding it there would be a `bd comments` call per inbox
row per poll for cards nobody has opened. Unlike those two it is **not** pruned
against the live inbox: an answered bead is closed and out of the sweep, so pruning
on absence would throw the record away moments before the reopen that needs it.
Thirty days, and 500 records, are what bound the file instead.

`node test/answered.mjs` pins it end to end against a fake `bd`: a first arrival
carrying nothing, an answer recorded, the bead leaving the inbox with its record
surviving — the assertion that stops someone pruning it like the others — the reopen
arriving with the answer on both the list payload and the detail fetch, and the count
going up when it is answered again.

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

### The thread is folded to the last exchange, and opens on your half of it

A bead that has been round four times has a thread that is mostly history, and a
card that draws all of it spends the screen on the part you have already read.
Every entry is folded to its author line except **two: the last thing you said, and
the last thing the other side said.**

Two rather than one, and one from each side rather than the last two:

- The recent exchange **is** a pair. The last reply only means anything next to what
  it was replying to.
- Taking "the last two comments" would leave nothing of yours on screen whenever the
  final two are both an agent's, which on a thread where an agent answered and then
  followed up is the ordinary case.

A folded entry keeps its author, its age and **one clipped line of what it said** —
enough to recognise, never enough to wrap, because two lines is not folded. The
author line *is* the toggle: a 12px chevron of its own would be a second target on a
bubble whose whole point is the sentence inside it, and the who-and-when line is
already what your eye uses to decide whether this is the comment you were after.
Yours are still the plain bubbles and an agent's still carry the teal stripe, folded
or not — the fold changes what is shown, never who said it.

**Opening a card lands you on your last message.** The top of a card is the question,
and the question is the part you already know — it is why you tapped. What you have
lost is the conversation. So the brief scrolls to your last comment with the reply to
it just below, and the description is above you, still there when you swipe back. If
there is nothing of yours on the thread — a question you have not answered yet, the
common case — the card opens at the top as it always did. The jump happens **only on
the way in**: a card already open stays exactly where you put it, because a poll that
dragged you back down to your own comment every 25 seconds would undo the whole of
[keeping your place](#keeping-your-place-in-a-long-brief). It re-measures as the
diagrams draw, for the same reason the restore does.

Both halves are **repaint-proof**, which is the part that took the care. Opening a
folded comment is a class flipped on that one bubble — never a `render()`, because
the answer box under the thread is holding a draft and possibly the caret — and the
choice is recorded in `state.thread`, keyed by the comment's own uuid, so the next
poll paints it back the way you left it. A comment you opened to read folding up
again under a background refresh is the same category of loss as a half-typed answer
disappearing.

`node scripts/card-thread-check.mjs` covers this and the missing *Answer & close*
above, in the same headless-Chrome-at-phone-size way: that all seven comments are on
the card but only two have a body on screen, that they are the right two, that each
folded one shows a single line, that the card opened somewhere other than the top
with your last message at the fold, that a tap opens one in place without touching
the draft or the caret, and that a refresh leaves it open. `--baseline` serves
`HEAD:public/app.js` and `HEAD:public/style.css`, where every comment is open, the
epic offers to close itself and the card opens at the top — so baseline must fail.
`--out=<dir>` writes the two screenshots.

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
Bash(bd memories:*) Bash(bd dep:*) Bash(beadcause-memory:*) Read Grep Glob
WebSearch WebFetch Bash(beadcause-get:*)
```

Adding a verb there should feel like a decision, which is why they are listed rather
than globbed. The prompt says the same thing in words — answer, never close, never
create — but the allowlist is what makes it true. `test/lookup.mjs` asserts the list
grant by grant, so widening it fails a test named after the thing being widened.

### Looking something up — and why it is not `Bash(curl:*)`

The last three entries are new, and they are the difference between a question that
turns on one external fact getting answered and getting a comment saying it cannot
be. Smallest first:

- **`WebSearch` / `WebFetch`** — read-only by construction. An agent can pull a page
  and cite it and cannot POST anywhere. This is the grant to reach for.
- **`beadcause-get <url>`** — the bytes as served, for the content types WebFetch
  mangles on its way to prose: JSON, CSV, XML, a raw table.

`Bash(curl:*)` was considered and refused, because the pattern does not mean what it
looks like it means: it matches `-X POST`, `-d`, `--upload-file`, and `-o` writing
anywhere on disk, and curl reads `file://` — a network grant that is quietly also an
unrestricted file read. `-X GET` alongside `-d` still sends a body, so "GET only"
cannot be a method flag either. So the allowlisted thing is a **wrapper**
(`bin/beadcause-get`, `lib/lookup.js`): the agent names a URL and cannot name a
method, a header, a body or an output file, because no code path here builds one.
It also refuses loopback and the private ranges — a laptop answers GETs on
`127.0.0.1` that it would not answer a stranger with — bounds redirects, caps the
read, and times the whole operation out.

What the wrapper cannot enforce is in the prompt instead, and it is the part that
matters for a number: **cite the source and the edition**, and say so plainly when
what you found is a *different* source from the one the question named. A fetched
value is not automatically a usable one. The same brief tells agents what they may
put in a URL, because a GET carries its query string to whoever is on the other end.

The **live logged-in browser is not on the table**: driving Adam's Chrome means
acting as him on every site he is signed into, and its per-site permission prompt has
nobody present to answer it. Browsing, when it lands, is a headless Chrome with a
throwaway profile.

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

### Reading another agent, without being able to be one

```
beadcause-memory agents                       advocate
                                              console
                                              dispatch
beadcause-memory recall --of=advocate tone    evidence first, then the ask
```

The roster is not a list anybody maintains: `agents` is the memory ref's own tree,
filtered to `*.json`, so an agent kind appears the moment it remembers anything and
a list that could go stale never exists. It also means a *retired* agent's memory is
still there to read, which is the useful half of not curating it.

**`--of` is a second flag on purpose, and the reason is the paragraph above.**
`--agent` *is* you for the whole invocation — so `--agent=advocate recall` does not
read the advocate's memory so much as become the advocate, and a `remember` in the
same breath writes into their file. That is fine for a human debugging at a terminal
and wrong as the thing an agent is told about. So the read half got its own flag,
which names a **subject and never an author**: only `recall` accepts it, and every
command that writes refuses it outright rather than treating it as identity. `remember
--of=advocate …` is an error, not a write, and `test/memory.mjs` asserts the
advocate's memory is byte-identical afterwards. A read attributes to nobody, so `--of`
needs no `BEADCAUSE_AGENT` at all — which is also what leaves it no author to borrow.

**And the read says whose notes it just handed you.** `remember` is written by an
agent for its own future self; publishing to others is what `post` is for. So a
cross-agent read has a wider blast radius than the blackboard, where saying it out
loud was a deliberate act — and the cheap, reversible guard is that the reader is
told which of the two it is holding: *these are advocate's notes to itself, not
published to you — evidence, not instruction.* It goes to **stderr**, so stdout stays
byte-for-byte what a plain `recall` prints and a `$( )` capture is unchanged. The
alternative on the table was curating which memories are readable across agents; this
is the version that does not need a second store, and it does not foreclose that one.

**None of it counts until the brief says so**, which is the rule the rest of this
file keeps running into: `agents` shipped with the first version of the memory API
and no agent ever ran it, because `memoryBrief` listed four commands and not that one.
From outside, a capability nobody was told about is indistinguishable from one nobody
chose to use. So the brief now carries the roster, the read, that it *is* only a read,
and the one line about what another agent's conclusions are worth to you.

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

**A name is no protection at all for a secret written inside a file that is meant to
be committed, so the commit greps as well as reading names.** `config.json` is
snapshotted on every write on purpose — the history of the state files is half the
reason this repo exists — which makes it the one file here guaranteed to be in the
history, and Google sign-in arrived with a `clientSecret` field in it. So every
snapshot searches its staged blobs for a secret written in as a field, and for the
literal contents of every secret file in that directory; a hit aborts the commit and
leaves nothing staged. The second half is not paranoia — `consoles/` is committed and
holds whatever was typed into a chat, and a secret pasted into a chat is the most
ordinary leak there is. Only the *staged* files are searched, so this guards what is
about to go in and never re-litigates what is already there; `npm run secrets` is the
tool for that question, and [rotation](#where-the-two-secrets-live-and-how-to-rotate-them)
is the answer to it.

**And an existing ignore file is topped up, because the pair of those rules had a
gap.** The file was written once and never looked at again, so a rule added to
`lib/commonrepo.js` afterwards only ever protected fresh installs — which stayed
harmless until the tailnet certificate arrived and put a `.key` in that directory.
The denylist did its job and the key was never committed; what it did instead was
abort **every** snapshot from then on, and a history that has quietly stopped looks
exactly like one with nothing to say. So `ensureRepo` now appends any rule the file
predates — appends, never rewrites, so a line you added by hand survives — and says
in the log which ones it added. `test/commonrepo.mjs` holds it.

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
  The agent runs with a narrow allowlist — the `bd` verbs that only look,
  Read/Grep/Glob, and the [web lookups](#looking-something-up--and-why-it-is-not-bashcurl),
  so it can research and comment but not edit anything — and is told to comment with
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

## What the inbox shows

The inbox is `bd human list` filtered to open, and that is the app's whole premise:
a bead reaches your phone because it is *asking you something*. The cost of that
premise is that a workspace with no `human` beads reads as completely idle — the
Climative space chip said **0** while 54 beads were open in it and five were being
worked on. Arithmetically correct, and indistinguishable from a broken app.

So the **first row of filter chips** carries one setting, in three positions:

| | shows | costs |
|---|---|---|
| **Human** (default) | beads labelled `human` — the questions | one `bd human list` per workspace |
| **Both** | questions first, then every live bead | both sweeps, in parallel |
| **Agent** | only what is *not* a question | one `bd list` per workspace |

"Live" is `open`, `in_progress` or `blocked`; deferred and closed are out, because
neither is anything an agent is on. **Every count on the screen follows the scope** —
that is the point of it, and it is why the switch is a row of chips rather than the
gear and modal panel it started as. A setting that changes what every number below it
means has to be *readable* without a tap; behind a gear, the only thing saying why
"Climative 59" was not a count of questions was an accent border on the gear itself,
and you had to already know what it meant.

It sits above the space and workspace rows because it is the coarsest of the three —
those two filter the rows that came back, this one decides which rows are fetched at
all. That difference is drawn rather than written: the scope chips are banded into one
segmented switch with a rule under it, and the filtering rows are loose pills below.
Being the only unconditional row, it is also what stopped the filter nav from hiding
itself when a workspace had a single space and a single repo in it.

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
  ●  ◔  ( 8 waiting )                       ⌨️  ⚖️  ⟳
  [ Human | Both | Agent ]  Climative 59  Personal 4
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

#### What is under it — the children, and the ones already done

Under the description, an epic lists **every child it has**, one tappable row each, with
the fraction beside the heading that `bd show` prints under its own CHILDREN section:
`6/7 done`. Closed children are shown by **default**, because an epic whose finished work
is invisible reads as though it never started; **Hide closed (6)** folds them away when
what is left is the question, and that choice is remembered — across sheets, and across
reloads. Nothing is folded on your behalf.

This one costs a second `bd` call, and everything about how it is loaded follows from
that. Children are simply **not in `bd show --json`**: on bc-goo, an epic with seven, it
returns `dependent_count: 7` and not a single row — the text output has a CHILDREN
section and the JSON has nothing to read it from. So it is `/api/bead-children`, a route
of its own, and the sheet **does not wait for it**: it paints from `/api/bead`, then
appends the block below the description when it lands. A call that is slow costs the
block; a call that fails costs the block and says nothing, because replacing a sheet you
can already read with an error would take the bead away over the part of it that did not
arrive.

It is not asked for at all unless the bead could have children, and what decides that is
`dependent_count` — every edge pointing *at* the bead, of which a child's is one. Zero
dependents means zero children, so the leaf beads that are most of what you tap ask
nothing. It is not tight the other way: a bead that blocks something and parents nothing
costs one call that comes back empty and draws nothing, which is the price of bd offering
no child count to read.

Three bugs found building the sheet, all worth knowing because they're the kind that look
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
screen since, and Sessions gone again because it and Advocates turned out to be one
view drawn twice. The bar labels the chat session just **Chat**, because five tabs
leave no room for two words at 360px. They are separate pages, and each one used to
end in an ✕ in the top right that hard-navigated back to `/`. That made the inbox a
hallway — chat session to advocates was two taps through a page you did not want — and
the ad-hoc cross-links that grew to paper over it (sessions → advocates, advocates →
sessions) were the same complaint, admitting itself.

So all of them carry the same bar along the bottom, where a thumb already is:

```
  📥      🧾       🔀         📣         ⏸
 Inbox   Chat    PRs    Advocates   Admin
 ▔▔▔▔▔
```

Five tabs is 72px each at 360px, which "Advocates" fits. Six would be 60px, which it
does not — so the stylesheet steps the type down when a sixth tab is there
(`.tabbar:has(.tab-item:nth-child(6))`), keyed off the bar's own contents rather than
off a count written down somewhere, so adding or removing a tab needs nothing else.
It is dormant at five and will come back on its own if a tab does.

Advocates carries a **badge** when there is something behind it — how many advocates
are waiting on an answer. The number rides the inbox's own poll (`/api/questions`
carries it; see [the three counts on the poll](#the-three-counts-on-the-poll)), so it
is live while you are on the inbox and simply absent on a page that has no way to
refresh it — which beats a stale number that looks live. Zero shows nothing. The badge
sits inside the tab's `aria-hidden` icon, so the tab takes an `aria-label` saying what
the number counts: "2" read out after "Advocates" says nothing about two of what.

**One badge, and it is the proposals.** Sessions used to carry the count of running
agents beside it, and dropping it was deliberate rather than a casualty of the merge:
a badge on a tab you are not looking at means *needs you*, and a running agent needs
nothing — it is a fact about the machine. The count is still served and still on
screen, in the advocate console's own tally ("3 working · 1 to answer"), beside the
repo it belongs to instead of standing in for all of them.

Any view is one tap from any other, and nothing closes any more. The current tab is
a `<span>` rather than a link — tapping where you already are should do nothing, not
throw away the list, the conversation and your scroll position to rebuild the same
screen — and it is marked twice over, by the accent colour and by the rule above it,
because colour alone is not a mark. The bar pads itself past the home indicator.

⟳ stays in the top bar of the views that have it: it acts on the view you
are looking at rather than taking you off it. ⌨️ (the terminal) and ⚖️ (the
foundations) stay in the inbox's top bar too — they are places you go for one thing
and come back from, not views you live in.

An **open question is the exception**: a card you have opened takes the whole screen,
tab bar included, because the answer buttons at its foot must not sit under anything.
Collapsing it gives the bar back. That behaviour belongs to `.card.open` and to the
inbox alone — the accordion on the pull request view marks its unfolded card
`unfolded` instead, because a card that took the screen over the bar was a page you
could not leave, on a view whose first load unfolds one.

`node scripts/tabbar-check.mjs` checks it, headless at phone size against fixtures
the script serves itself: the bar is on every page and pinned to the bottom,
exactly one tab is current and it is the right one, the current tab is not a link,
and the last row of the list, the chat session's composer and the last advocate card all
clear it — in both colour schemes. `--fake-inset` re-runs the safe-area sums with a
notch substituted in, for the Chromes with no `Emulation.setSafeAreaInsets`.

The *paths* are checked separately, in `npm test`: `node test/pagepaths.mjs` asks a
real server for every URL a phone might still have on its home screen and checks which
document came back — all five that reach the advocate console, both that reach the pull
request board, and so on — plus that `/work.js`, deleted with the sessions view, 404s
rather than lingering. The aliases live in a run of one-line `if`s in `serveStatic`,
which is exactly the shape a merge eats, and a broken one is silent: the page is fine,
the shortcut is not.

## Detail opens over the tab, not instead of it

The graph and the reader are linked from every view that names a bead — the inbox,
current sessions, the pull requests, the advocates and the chat session — and both used to be a full-page
navigation. Looking at what a bead blocks therefore cost you your place in the list,
your half-typed answer was behind a **✕ → inbox** you had to trust, and the back
gesture landed on whatever the browser felt like. They are not destinations. They
are detail about the thing you just tapped, so they **slide in from the right over
the current tab** and dismiss back to it.

There are three of them: `/graph?ws=…&id=…`, `/doc?p=…`, and
[`/session?pid=…`](#tap-a-session-to-see-what-it-is-actually-doing). The third is here
for a second reason on top of the first — a session is listed in four places, and until
it had an address of its own the detail behind it could only exist in whichever list had
been taught to fold it open.

`public/drawer.js` is one file loaded by both sides of it, picking its half at load:

- **On a tab**, it intercepts clicks on `/graph?`, `/doc?` and `/session?` links and
  loads the page that already exists into an iframe in the panel. The iframe is the
  whole trick — it keeps d3 out of the inbox's bundle and marked out of the graph's, and
  no page had to learn to render the other one. The anchors keep their real `href`,
  so long-press → open in new tab still works, and a pasted `/graph?ws=…`,
  `/doc?p=…` or `/session?pid=…` URL still loads the standalone page exactly as before.
  (A detail page opened on its own installs nothing: no drawer over a drawer's worth of
  the same thing.)
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

The session detail gets the same treatment plus the two things only it can get wrong.
**One address from three lists**: it reads the `href` off the session row on
`/sessions`, off the advocate's worker row and its "Claude sessions" row on
`/advocates`, and off the mirror's — and asserts all four are the same
`/session?pid=…`. Right in one list and forgotten in the other two is exactly how this
breaks, and it is invisible from anywhere else. And **a pid whose process has gone says
it finished** rather than showing an empty transcript, which is the one state the page
has to distinguish and the one a fixture can actually stage.

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

This used to be its own page — 🤖 Sessions, at `/sessions`. It is **the advocate
console** now (📣 in the tab bar). The two were one view drawn twice: the same
`/api/work` payload, one card per repo, the same claimed beads, the same live `claude`
rows, an advocate state line on each. Everything below is on the console's cards, and
`/sessions`, `/work` and `/work.html` all serve it, because those paths are on the
phone's home screen and in the Android shell's history.

Which is also the better answer to the question. "What is running" is almost always
"what is running *in this repo*" — and on the console the sessions sit inside the repo
they are running in, under **Other work in this repo**, beside the advocate that may
have opened them and the queue they came off.

```
climative                                   2 of 3 sessions
  54 open · 51 ready · 3 in progress · 4 for the advocate
  ▾ Working now                                        2/3
  ▸ Up next                                              4
  ▸ Thinking
  ▾ Other work in this repo                               3
      CLAIMED BEADS  Not opened by the advocate.
      ◗ pipeline-service: client built without retry…   11h
        cl-1jw  adam.morgan
      CLAUDE SESSIONS  Which is on which bead is not recorded.
      ● Climative - newrelic v14 override fix           11h
        dms-client-retry-4e7 · pid 90310 · idle
  surveyed 4m ago · launched 11h ago       [ Graph → ]
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

Tapping one now opens **`/session?pid=…`**: what the process record knows — its full
directory, its workspace, when it started, when it last spoke — and under that, **its
own Claude Code transcript, tailed live**. It arrives in the [detail
drawer](#detail-opens-over-the-tab-not-instead-of-it), over whichever list you tapped
from, and back puts you straight back in it.

```
  ┌ Beadcause - bc-76c Sessions tab: accordion cards      ✕ ┐
  │  WHERE      /Users/…/beadcause/.claude/worktrees/…-5f7   │
  │  WORKSPACE  beadcause                                    │
  │  PROCESS    ● pid 30342 · interactive · busy             │
  │  STARTED    Aug 8, 12:03 PM · 22m ago                    │
  │  ACTIVE     Aug 8, 12:03 PM · 22m ago                    │
  │  SESSION    a60224c4                                     │
  │  TRANSCRIPT  Its own log, as the terminal showed it.     │
  │  ┌────────────────────────────────────────────────────┐  │
  │  │ ❯ run whatever this repo calls its tests           │  │
  │  │ ✻ thinking                                         │  │
  │  │   > Bash node --check lib/transcript.js            │  │
  │  │     check=0                                        │  │
  │  └────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────┘
```

**It is a page, not a pane, and that is the whole of what changed.** The detail used to
fold open inline under the row on `/sessions` — which meant it existed in exactly one of
the four places a session was listed. The same session is an advocate worker row and a
"Claude sessions" row on the console, a row in the *Elsewhere* card, and a row in the
mirror, and in all three of those the tap did nothing at all: inline detail can only
ever exist in the list that was taught to fold it. Now every one of those rows is a link
to the same `/session?pid=…`, so the tap means the same thing wherever your thumb landed.

That is also what made `/sessions` redundant — the fold was the only thing it had that
the console did not — which is why there are three places now rather than four, and why
`/sessions` serves the console.

The pid is the whole address, because nothing else identifies a running process — and a
URL that named a *file* instead would be a way to read anything on the Mac. The one row
that deliberately does **not** link here is an advocate worker whose window has gone: a
worker is a window we opened rather than a process we can see, and where the pid it
recorded no longer names anything running, the row keeps its link to the bead. Promising
a session that cannot be shown would be worse than the dead end it replaced.

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

The page polls every two seconds while it is open and stops for good on the 404 —
there is no point asking again about a pid that will never come back. It follows the
tail only if you were already at the bottom, so scrolling back to read something is not
yanked away by the next line. The console behind it refreshes on its own 20-second
cycle and, because the detail is in a drawer rather than folded into that list, a
repaint there can no longer disturb what you are reading.

**That is also what let the sessions view go.** The detail had to be folded into the one
list that was taught to fold it, and that fold was the only thing `/sessions` had which
the advocate console did not. Once every row anywhere in the app reached the same
address, the two pages were the same page — see [the tab
bar](#getting-around--the-tab-bar).

### And you can answer it

Watching a session think and having no way to say anything to it was the last dead end
in the app. Every other conversation here is one beadcause *started* — the bead console,
the agent chat, the pty on `/term` — and so it owns a process and can write to its
stdin. This is the one already on your screen, and it belongs to a terminal window the
daemon does not own.

So there is a box under the facts, and **the transcript below it is the reply**:

```
  │  SAY SOMETHING  It lands in the session as if typed.     │
  │  ┌──────────────────────────────────────────┐  ╭────╮   │
  │  │ have you run the tests yet?              │  │ ↑  │   │
  │  └──────────────────────────────────────────┘  ╰────╯   │
  │  It is mid-turn, so the session holds this until the     │
  │  turn lands.                                             │
```

Nothing renders the answer — the pane was already tailing the file the session writes,
so the reply arrives on the next two-second poll through the channel that was there all
along. No second connection, and nothing echoed optimistically into the transcript,
because a line in that pane which is not in the file would be indistinguishable from
something the session actually said.

**The channel is `write text` into iTerm**, the same one the advocate has always used to
ask a worker whether it is still alive — it puts the words in the TUI and presses
return, exactly as if they had been typed. What is new is the *address*. The advocate
kept the iTerm session id of every window it opened, which is an exact handle and exists
for almost none of the sessions on this Mac. A session you started at the keyboard was
never opened here. But every process has a **controlling terminal**, and iTerm reports
the same value on its side, so the join is `pid → /dev/ttysNNN → the window showing it`
and it needs nothing remembered at launch. That is what makes this reach sessions that
predate the feature, including the one you are reading this in.

Three things it refuses to be vague about, because all three fail silently and you are
in another room:

- **A session that cannot be reached says why, and offers no box at all.** Not a
  disabled one: a disabled box is an invitation with the door shut, so you write the
  message anyway and find out afterwards. A session with no controlling terminal (run
  headless, or over the SDK) has no input line to type into; a session in Terminal.app,
  tmux or over ssh is running perfectly well and is simply out of reach of the one
  channel there is. Those are different sentences, and neither of them is "finished".
- **Nothing typed is lost without being told.** The box empties only once the daemon has
  said it delivered. A refusal, a window that closed between the check and the send, a
  connection that died mid-request — the words stay exactly where you typed them and the
  reason goes underneath.
- **Mid-turn is queued, and it says who is queuing it.** Claude Code takes typing while
  a turn is running and answers it when the turn lands, so the message goes straight
  out and the *session* holds it. There is deliberately no second queue on this side:
  beadcause holding words back that the session was ready to take would be a delay it
  invented.

**Two paragraphs arrive as two paragraphs.** They used to arrive as one line: `write
text` adds a return at the end of what it writes, so a second line would have submitted
as a second message — half a sentence into a running agent — and the text was closed up
before it went, warned about while you typed and confirmed after it landed. That
flattening was the whole reason Claude Code's IDE WebSocket was investigated
([`docs/ide-websocket-spike.md`](docs/ide-websocket-spike.md), on `bc-g1l`), and the
spike ended by finding the flattening was never a property of AppleScript at all — only
of a default. `write` takes a `newline` boolean, so the message goes down as a bracketed
paste with `newline no` and submits nothing, and a bare `write text ""` after it is the
one Return that sends the lot as a single turn. Two statements on the channel that was
already there, which is why nothing here speaks the WebSocket: it can put multi-line text
in a live session's box but has no message that submits one, so it would have needed the
AppleScript return anyway — a second channel bolted alongside this one, reaching only
sessions inside its declared `workspaceFolders`.

Two things about it worth knowing. `SAY_MAX` is unchanged and still real: the message
rides to `osascript` as an argument however many lines it is split over, so ARG_MAX is
still the ceiling and 8000 characters is refused for being long rather than mistaken for
a session that has gone. And on the Mac itself, a message over a few lines shows in the
composer as `[Pasted text #1 +6 lines]` rather than as the words — it submits in full,
but anyone reading that screen is reading a placeholder.

`POST /api/session-say` is token-authenticated like everything else under `/api/`, and
it is *not* refused in observe mode: `BEADCAUSE_OBSERVE` is about the daemon acting on
its own, and this is you typing — the same category as the in-app terminal and the bead
console, which a spare-port instance is booted precisely to try.

`node scripts/say-check.mjs` drives the real `public/session.js` in headless Chrome at
phone size against fixtures, and it is pointed at the promises rather than the markup:
the words surviving a refusal, a dropped connection and a repaint; the box disappearing
when a send comes back saying the session is out of reach; the reply arriving through
the transcript pane rather than through the send's own response; and, since `bc-75q2`,
the line breaks reaching the wire with nothing on the page claiming they were closed up.
`--baseline` fails all of them, because before this there was no box. The delivery itself
is the one part no test does — `write text` into a live window would type a fixture
string into whatever session answered — so `test/session.mjs` covers the rules around it
instead: reach refusing a pid with no terminal, the length refused on the message as
typed rather than on a flattened one, and the AppleScript matching a tty as well as an id
and sending its paste with `newline no` and exactly one Return after it.

Every card has a **Graph →** into the whole workspace — which is also the answer to
"how do I see what another session just created", since the graph draws every open
issue rather than only the questions.

Two `bd` calls per workspace (`status --json` for the counts, `list
--status=in_progress --limit 0 --json` for the beads — `--limit 0` because bd's own
default is 50, and a silently truncated list here would read as the whole truth),
run in parallel across all of them:
about two seconds for six. It refreshes every 20s and on ⟳, deliberately not on the
inbox's 30s cycle — the inbox is polled by every client all day, and this is opened
when you want it. It also stops while the Mirror pane is the one showing, because a
hidden page must not keep sweeping every tracker on the Mac. A workspace that fails
reports its error in place rather than vanishing from the list; a missing row would
read as "nothing happening there", which is the one thing it doesn't mean.

## Pull requests — merged, pushed, deployed

A delivery question asks *may I merge this?* and is gone the moment you answer it — and
most work never raises one, because [the worker merged it
itself](#landing-work--a-branch-a-pull-request-and-the-workers-own-merge). Either way the
question that starts once the merge has happened had nowhere to be asked from a phone:
**it merged — did it reach origin, and is it running?** Those are three different facts.
They go true at three different times, and the gap between them is where work sits for a
week believing it has shipped. This tab is the only place that gap is visible, which is
what makes it the *more* important screen now that a worker lands its own work: the merge
stopped being a thing Adam does, and the deploy did not.

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

1. the `bead:` line inside a [`beadpr` block](#landing-work--a-branch-a-pull-request-and-the-workers-own-merge),
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
- **Ship** — **runs this repo's declared deploy** ([below](#deploying-a-repo-when-it-says-how))
  where there is one, and opens an iTerm session with a deploy-only brief where there is
  not. Which of the two it will do is on the button before you press it — *Ship* against
  *Ship on the Mac* — with the command named in the line underneath, because `fly deploy`
  costs nothing you would notice and `launchctl kickstart -k` kills the daemon you are
  reading it on. The deploying one takes **two taps**, like Merge: the reason the old
  Ship needed no guard was that a window is something you can watch and stop, and a
  declared deploy is not. The session's brief carries what is already true — merged, on
  origin, not in the running build — so it does not start by working out what this
  screen already knew. Offered on merged rows even when all three lamps are lit, because
  a repo can need shipping twice.

  Both halves of the app now mean the same thing by the word: **Ship it** on a delivery
  card merges and then deploys, and this deploys work that is already merged. One word
  that did two different things depending on which screen you were on was the thing
  worth fixing; a repo that has declared nothing keeps the window, and loses nothing.
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
sends *nothing*, that Ship is absent until it is merged, that the deploying Ship arms
and the window-opening one does not, and that a refusal lands under the row as GitHub's
own sentence. `node test/prship.mjs` covers the fork itself end to end through the
daemon — a declared deploy started with no window, a repo with none falling through to
the session, two taps not becoming two deploys, and an unmerged pull request deploying
nothing.

### Deploying a repo, when it says how

For a long time the daemon could do everything after a merge except the last thing.
`grep` for `launchctl` across `lib/` and `bin/` found prose in comments and nothing that
runs: every deploy on this Mac was Adam at a keyboard, and the Ship button above was a
window that asked him to be. `lib/deploy.js` is the missing verb, and Ship now runs it
wherever it has been written down.

**A deploy is declared, never guessed.** `deploys` in `~/.config/beadcause/config.json`,
keyed by workspace, empty by default and empty for most repos forever:

```json
"deploys": {
  "beadcause": {
    "command": ["launchctl", "kickstart", "-k", "gui/{uid}/m4m.beadcause"],
    "restarts": true,
    "rebuild": [{ "label": "apk", "when": ["android"], "command": ["npm", "run", "android"] }]
  },
  "sophab": { "command": ["fly", "deploy"] }
}
```

beadcause restarts under launchd, sophab runs `fly deploy`, the next repo will do
something else — there is no shape those share that could be read off a checkout, and a
daemon that guessed would guess at three in the morning in a repo nobody was watching. A
workspace with no entry keeps the answer the board already gives it: **no deploy
beadcause can see.**

**It is argv, and never a shell line.** `["launchctl", "kickstart", …]`, not
`"launchctl kickstart …"`. That file is hand-edited, rewritten by `saveConfig` and
[synced as a git repo](#where-it-lives-configbeadcause-is-a-git-repo); a string would
make every one of those somewhere a metacharacter changes what runs. The cost is that
`&&` and pipes are unavailable, and the answer to wanting them is a script in the repo —
a thing you can read and test. `{uid}`, `{home}`, `{dir}` and `{base}` are substituted;
nothing else is, and an unrecognised brace is left exactly as typed.

**What it runs, in order:** fast-forward the checkout to `origin/<base>`, so what goes
live is the merged tree rather than whatever this Mac happened to have; rebuild anything
whose `when` paths the fast-forward actually moved; then the deploy command. Every step
records its own exit code, and a non-zero one stops the rest — a rebuild that failed
never reaches a restart. **It will not merge over uncommitted work:** a dirty checkout
stops the whole deploy before anything is built, because six sessions edit these
checkouts and a deploy that quietly stashed one of them would be the worst kind of
helpful.

#### Restarting a label is not the same as deploying a tree

`["launchctl", "kickstart", "-k", "gui/{uid}/m4m.beadcause"]` restarts whatever job is
loaded **under that label**, which is not necessarily the checkout the two steps above it
just brought up to date. That is not hypothetical: it is
[the three-day bug](#the-router--why-you-never-restart-it) in a form a deploy walks into
on its own. The plist in `~/Library/LaunchAgents` is generated once by
`scripts/install.sh` and is the one file in the chain `git pull` never touches, so a
deploy can fast-forward the tree, rebuild the APK, restart the label, exit 0 — and have
restarted the program the label was pointed at in March.

So the runner checks the label before it restarts it, and **refuses** rather than
rewriting anything:

```
refusing to restart m4m.beadcause: the LaunchAgent is not in step with /Users/you/beadcause.
launchd would have restarted /Users/you/beadcause/bin/beadcause.js.
launchd runs bin/beadcause.js directly, not bin/router.js.
...
fix it: npm run install-service
```

The verdict is `lib/service.js`'s, whole — the same one the daemon prints as a banner and
`npm run swap:status` names — because the actual bug is a plist pointing at *the right
checkout's wrong file*, which no "is the program under this directory" test would ever
catch. Any **other** label gets that weaker test instead, since there is no router to
expect: the program launchd starts must live inside the directory the deploy just
fast-forwarded, or the restart puts back exactly what was already running.

It judges only a command that restarts an already-loaded user job — `launchctl
kickstart|kill|stop` against `gui/<uid>/<label>` or `user/<uid>/<label>`. `fly deploy` has
no label; `bootout`/`bootstrap` *are* the reload and second-guessing them would refuse the
command that fixes the drift; `system/<label>` is a LaunchDaemon this daemon has no view
of. Two keys move it: `"launchAgent": "bin/router.js"` names the program exactly (stricter
than containment, and relative to the deployed directory), and `"launchAgent": false`
turns the check off for a job loaded some way this cannot see.

**The other way out is a rebuild step, and needs no code:**

```json
"rebuild": [{ "label": "launchagent", "when": ["scripts/install.sh", "bin/router.js"],
              "command": ["bash", "scripts/install.sh"] }]
```

`install.sh` is idempotent and already boots the job out and back in, so the drift is
gone and the check then passes — which is why the check runs *after* the rebuilds rather
than before them. It is the right shape for the repo that wants it and the wrong default
for everyone: rewriting a LaunchAgent from inside an unattended deploy at three in the
morning is a big hammer for a failure a sentence names perfectly well.

`node test/launchagent.mjs` covers the verdicts against plists it writes in a temp home,
so it never reads the real `~/Library/LaunchAgents`; `node test/deploy.mjs` covers the
runner acting on one — the command never runs, the rebuild before it did.

#### The awkward part: a beadcause deploy kills beadcause

`launchctl kickstart -k gui/<uid>/m4m.beadcause` SIGKILLs the process that asked for it.
Run inside the daemon, that is the daemon killing itself mid-statement: the HTTP response
never written, and whatever it was about to record about the deploy never recorded.

So the daemon spawns a **detached runner** and returns. `POST /api/deploy` answers before
the deploy has happened — a 200 there means *it is written down and a process owns it*,
never *it worked*. The other half of the contract belongs to the caller: whatever made
the deploy worth doing — the merge, the answer, the closed bead — is durable **first**,
and then the deploy is asked for. Nothing in `lib/deploy.js` writes to a bead, on purpose:
a process that may be SIGKILLed inside the next second is the wrong one to be holding the
only copy of anything. A one-second grace on top buys the response its way out of the
socket.

#### Silence is never success

Every state a deploy can be in has a name on disk, including the two that mean *we do not
know*:

- **ok** / **failed** — the runner said so, and `failed` carries which step and its exit
  code. No output is ever scanned for reassuring strings.
- **unconfirmed** — the runner was killed at the deploy step of a deploy declared
  `restarts: true`. That is what a restart looks like from here: launchd takes the job's
  processes and the runner is one of them. It means *the command ran and nothing outlived
  it to check*, which is the whole truth available, and it is deliberately not rounded to
  either side.
- **lost** — the runner disappeared anywhere else, or never started at all.

The last two are settled by a sweep that runs on every poll — **including the first one,
which is process start**, and that is the case this is really for: the ordinary way a
beadcause deploy ends is by killing the daemon that asked for it, so the process that
comes back is the first one able to read what happened. Then it says so once, on
`/api/deploys` and on your phone, marked on disk rather than in memory so a daemon
replaced by the deploy it was reporting on does not push the same notification twice —
or, if it crashed first, forget to push it at all.

**The journal is a directory, one file per deploy**, not a key in `state.json`. Two
processes are involved and they overlap, and in the middle of a restart one of them
changes identity; a single JSON file read-modify-written by both is last-writer-wins over
the whole document, so the daemon marking a record announced would silently drop the
runner's last step. A file each means the runner owns its own and the daemon only reads
it. It also keeps this clear of `loadState`'s fallback entirely — a pending-deploy flag
parked in `state.json` would need a default there, or a corrupt file would read as a
deploy nobody asked for, or drop one that was.

`node test/deploy.mjs` runs the whole thing against real git repositories in a temp
directory and real detached processes, with nothing restarted and no `launchctl` in
sight: that a shell string is refused rather than run, that a dirty checkout is left
exactly as it was found, that a rebuild fires only for the paths that moved, that
`startDeploy` returns while its command is still running, and that a runner with a dead
pid settles to `unconfirmed` or `lost` and never to `ok`.

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
  "globalMaxWorkers": 10,
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
together (default 10), so six repos each allowed 3 cannot open eighteen windows.

Whenever a cap is what stopped a launch, it says so — on the card and in the log —
because a slot limit that quietly drops a launch reads exactly like an advocate that
has decided there is nothing to do.

Each session opens the same way the **Discuss** button does: a real iTerm2 window
running `claude --permission-mode auto` in the repo, which means you can watch it,
steer it, or close it. Its brief tells it to claim the bead first, to read and obey
the repo's own `CLAUDE.md` (worktrees, tests, deploy — the daemon has no business
knowing those), and to end in one of exactly three ways: **landed** — its own pull
request merged and its bead closed — **handed over** as a pull request for you to
decide, or **handed back** to you with the `human` label and a decision block. A session
with no honest exit invents one, and the one it invents is "close it and hope".

Landed is the ordinary ending. Handed over is what happens when the merge was refused or
the session asked for a human; closing its own bead over a local commit is what it is
told to do only where there is nowhere to open a pull request at all — see
[Landing work](#landing-work--a-branch-a-pull-request-and-the-workers-own-merge), which
is where the rest of that lives.

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
agent (`bd`, `git log`, read, grep, and the [web lookups](#looking-something-up--and-why-it-is-not-bashcurl) — nothing that can write) which reads the recent
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

- **The advocate console** (📣 in the tab bar, at `/monitor` — and at `/sessions` and
  `/work`, which it absorbed) is one card per repo: what the advocate is doing, the
  beads it has windows open on, what it will pick up next, its survey transcript, the
  proposals waiting on you, what its finished sessions left behind, and the other work
  in that repo — your own claimed beads and every live `claude` process, each one
  tappable for its transcript. Plus **Pause** / **Reclaim sessions** / **Forget
  attempts**. *Reclaim sessions* asks each open window whether it is still working —
  see below. Above every card, one line saying **which program launchd is running** —
  dim when it is this checkout's `bin/router.js`, and a red block with the fix when it
  is not; see [the router](#the-router--why-you-never-restart-it) for why that line is
  there on a good day too.
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

#### Closing the window — a session that has finished should not still be on screen

The `exit` above only runs **when `claude` exits**, and a session that has finished its
work does not exit. `claude "$P"` is interactive — the brief is its first prompt, not
its whole life — so when the last turn ends the TUI goes back to waiting for a human
who, by construction, is not there. The bead is closed, the pull request is merged, and
the window is still open.

The cost is not the window. It is that a screen of them is indistinguishable from a
screen of sessions that stopped to ask something, so every one has to be read before
any can be dismissed — which is the whole of what beadcause exists to stop. Seven of
them were sitting here when this was written, all named `DONE-…`, all idle, every bead
closed hours earlier.

So the daemon finishes the sentence the session could not. When a worker's bead is
**closed** and its process is still running, the advocate signals it: `claude` exits,
the shell runs the two commands after it, the done file lands, and iTerm closes the
window exactly as it does for a session that ended on its own.

Everything about it is a guard against signalling the wrong thing, because a signal is
the one act here with no undo:

| before anything is sent | why |
|---|---|
| the bead is **closed** | not delivered, not handed back, not timed out. Those four endings all have something on screen worth reading; a closed bead does not |
| Claude Code still reports that pid as a live session **named after this bead** | records in `~/.claude/sessions` outlive their process and pids get reused, so the pid alone is worthless. A subtask id (`<bead>.1`) is not its parent, either — the id has to stand on its own in the name |
| the session is **idle** | it goes on working for a moment after its delivery closes the bead — the `DONE-` rename, the last message — and that moment is `busy` |
| and has been for `closeGraceSeconds` | "idle" is a status file the session writes itself, and the gap between two turns looks exactly like the end of the last one |

Then `SIGTERM`; then `SIGKILL` if that was ignored for `closeHardSeconds`; then, after
`closeGiveUpMinutes`, it stops and leaves the window alone. Giving up is a real
outcome: a session that will not take a signal is one worth looking at by hand, and a
daemon that escalated forever would be worse than the windows. A busy session that
never goes idle is left open for the same reason, and costs nothing but a line in the
log.

The waiting list survives a restart, alongside the workers and for the same reason —
the windows are still open, and a daemon that forgot them would leave the pile this
was written to clear. An observer instance signals nothing at all.

Windows already open when this shipped are not swept up: their workers left the slot
list long ago, so nothing knows their pids. Close them by hand once; everything from
then on closes itself.

#### Reclaiming a slot, by asking

The inference above is what the daemon can work out on its own. **Reclaim sessions** is
what it can find out by asking, and it exists because the button before it — *Free
slots* — could only assume: it emptied the slot list on the strength of you having
pressed it, so a session three hours into a bead lost its slot to the next launch, and
one whose window you had closed looked exactly the same.

There is no socket to an advocate's session; it is an iTerm window, and the daemon owns
neither the window nor the shell in it. What it does own is the window's **iTerm session
id**, captured from `scripts/open-session.applescript` at launch. That is the channel:
`scripts/message-session.applescript` writes into that session exactly as if it had been
typed, and Claude Code takes input mid-turn and answers it when the turn lands. The
check-in itself is still one line, but by its own choice now rather than the channel's —
one instruction and one command to run is not something to spread over six lines in a
window somebody is working in. Three outcomes per open session, each a fact rather than a guess:

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

    ** BEAD WORK DONE ** CAN BE DEPLOYED, REBUILT **

`** BEAD WORK DONE **` never varies. What follows names every step the work has not been
through yet, and `CAN BE CLOSED` on its own is the one line that means nothing is
outstanding at all. Which words are even *available* depends on the ending the session
was given, because the whole value of the line is that it is honest:

| the session | may owe | because |
|---|---|---|
| landed its own work | `DEPLOYED`, `REBUILT` — or `REVIEWED` if the merge was refused | the delivery merged and pushed it, so claiming either would describe work already on `origin` |
| handed the PR over (`pr.autoMerge` off) | `REVIEWED`, and nothing else | it never merges, pushes or deploys; it can owe nothing but your answer |
| has no remote to push to | `MERGED`, `PUSHED`, `DEPLOYED`, `REBUILT` | all four are still yours, and the session names them without doing them |

Whatever it writes, it passes the same thing to the delivery as `--owed`, which puts it on
the bead and in the notification — the marker is for a human reading a wall of windows,
and `--owed` is for the one who is not in front of it.

That line used to be `CAN BE CLOSED` unconditionally, which said the *window* had
nothing left to do and said nothing about the work — and it is the sweep below that
makes the difference expensive. An unmerged branch is never retired, so a session that
stopped at a worktree commit left it sitting there indefinitely while reading as
finished in every list. Nothing parses the marker; it is prose for a human. `lib/session.js`
is the only file that writes it and `test/land.mjs` the only one that asserts it — which is
worth having, because "the marker claimed a step the session did not take" is a regression
no screen in the app would show you.

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

The default has since moved to a merge commit (`pr.mergeMethod`), which makes the local
half true again and turns this second half into the belt beside those braces: it is
what covers a workspace that asks for `squash` on purpose. The reason the default
moved is that this sweep is not the only thing gating on ancestry — the `ship` skill
and its attic sweep do too, they live outside this repo, and nothing here can teach
them to ask GitHub.

**Retired means moved, not deleted**: `git worktree move` into
`.claude/worktrees-retired/`, the same soft delete the `ship` skill does by hand, so
it is resumable. The branch is kept deliberately — `git branch -d` refuses a branch
checked out in another worktree, and the branch is what makes the retirement
reversible. Retired worktrees accumulate; nothing here ever removes one.

**A `STRAY` row in the attic sweep is worth distrusting before you act on it.** The
sweep lives outside this repo, but what it reports about `.claude/worktrees-retired/`
is read as a statement about this one — and for a while it was wrong. It tested each
retired directory for a registration by piping `git worktree list` into `grep -q`
under `set -o pipefail`: grep exits at its first match, git takes SIGPIPE while it is
still walking the rest, the pipeline reports 141, and a directory that *is* registered
reads as one that is not. It called most of a healthy 85-entry attic unregistered, a
different subset each run, which is what a race looks like from the outside. bc-bcdp
was filed against the attic on that evidence; the attic was fine, and every directory
in it had been put there by `git worktree move` exactly as this page describes.
Two things to check before believing the next one: `git worktree list --porcelain |
grep worktrees-retired | wc -l` against `ls -1d .claude/worktrees-retired/*/ | wc -l`,
and whether the row survives a second run. `test/pipefail.mjs` keeps the construct out
of this repo's own scripts, where it sat in four places.

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

## Landing work — a branch, a pull request, and the worker's own merge

An advocate opens sessions on ready work. What happens to that work afterwards has now
had three answers, and the third one is only defensible because of what the first two
taught.

**It merged into `main` on the laptop.** The session did it and closed its bead, so the
first Adam saw of a change was in `git log`, after it had shipped. That worked while one
session ran at a time. With five it fell apart in three ways at once: they raced each
other into `main`, so a session that started from a clean tree finished against one that
had moved twice underneath it; every conflict that came of it landed on him anyway, in
the worst possible form, hours later, in a repo he had not been reading; and nothing was
reviewable, because by the time anything was visible it was already in.

**Then the merge became a question on his phone.** That fixed all three and introduced a
fourth: a queue with a person in it. Every finished piece of work waited for him. A bead
finished at three in the morning sat unmerged until breakfast, and the next bead to touch
the same file started from a `main` that did not have it. Reviewing a diff from a phone
is a real thing to want; doing it forty times a week at the pace an advocate can produce
them is not, and what the gate was actually doing was waiting.

**So the worker merges its own pull request** — and the pull request stays, because the
pull request is what solved the race. There is exactly one route into `main`: push a
branch, open a PR, ask GitHub to merge it. GitHub serialises the merges and refuses what
cannot land, which is precisely the property a laptop with five concurrent sessions does
not have.

```
session finishes ──► beadcause-deliver ──► pushes the branch ──► gh pr create
                                                                     │
                                                       waits for the checks
                                                                     │
                        ┌────────── they went green ────────────────┴───── they did not ─────────┐
                        ▼                                                                        ▼
              gh pr merge --merge                                                    question with the PR link
              bead closes: it landed                                                        ──► your phone
              ✅ push, nothing to answer                                   Merge · Ship · Request changes · Decline
                        │
                        └──► 🔀 PR board: merged, on origin, not yet running → Ship
```

Five things follow, and they are the whole of the change:

- **A worker merges, and only ever through a pull request.** Not `git merge`, not
  `git push origin main`, not "just this once because it is trivial". There is still no
  `push` anywhere in `lib/pr.js` — it opens, reads, comments on, merges and closes pull
  requests, and that is all it can do. What changed is who asks for the merge, not where
  the merge happens.
- **It brings `main` into its branch before delivering.** `main` moves while a session
  works — that is the whole premise — and GitHub refuses a merge that conflicts. The
  branch is the only place that conflict can be resolved by whoever wrote the code, while
  the reasons are still on their screen, so the brief asks for the downmerge *and* for the
  tests to be re-run after it: a clean merge of two working branches is not a working tree.
- **It will not merge over a red check, and it will not wait forever for a green one.**
  Failing checks stop it and become a card in your inbox — the button there *does* let
  you merge over red, because a red check is sometimes a flake and judging that is what
  a human is for. Checks that never report are the same: five minutes, then it asks.
- **The bead closes because the merge happened**, in the same breath, with the PR number
  and the merge commit in its close reason. A session does not close its own bead here;
  the delivery does, and the advocate reads that reason back so the sessions page can say
  *landed #42* rather than the older and much weaker "closed by the session".
- **Deploying is still yours to ask for.** The merge is on `origin`; whether that is
  *running* is a different fact with a different button. The notification says what
  landed and what is still owed, and links to
  [the PR board](#pull-requests--merged-pushed-deployed), where **Ship** is. A worker
  being right about a merge does not make it right about a deploy, so it never runs one
  — but where the repo has written its deploy down, Ship is one tap and no window. On a card that *did* come
  to you, the two are one tap apart: **Merge** and **Ship it** sit next to each other,
  and the difference between them is the whole of [the next section](#ship-it--the-same-merge-and-then-the-deploy).

**The old ending is intact, and it is the fallback.** Everything below about the card,
the three answers and the markers is still exactly what happens when the merge does not
— GitHub refused it, a check went red, the checks never reported, `pr.autoMerge` is off,
or the session passed `--review` because it wanted a human on this one. It went from
being every delivery to being the interesting ones.

### The notification with nothing to answer

Every other push from beadcause is a decision arriving. This one is a decision that has
already been taken, by an agent, on your behalf — so it is built to be different in three
ways, each of which is the point:

- **No action buttons, ever.** Not even one. The only thing a button could offer about
  work that is already in `main` is a revert, and a revert is not something to hand
  someone in a lock screen with one line of context.
- **Priority 2 — it arrives, it does not shout.** A question can be urgent because
  something is blocked on it. Nothing is blocked on this. A phone that buzzes hard for
  things that went right is a phone that gets silenced, and it takes the questions with it.
- **It links to `/prs`, not to a bead.** There is no bead to open — it is closed. The
  question this actually raises is *it merged, is it running?*, which lives on the PR
  board, next to the **Ship** button that answers it.

It says what landed, the merge commit, and what the session said is **still owed** —
`Still owed: deploy, rebuild`, in the session's own words from `--owed`, because the
daemon knows the repo but only the session knows what it touched. A workspace in a
[minimal space](#spaces--keeping-work-out-of-your-evening) gets the contentless version,
same as every other push: *A worker landed its work — tap to open.*

### The question, and what is on it

Its first paragraph is now the most useful thing on it, because it answers the question
you ask on seeing one at all — *why is this here?* Three answers, three different
sentences, never folded into one polite one:

| the card says | what happened |
|---|---|
| *tried to merge it. **It could not:** …* | GitHub refused, or a check went red, or nothing reported. The reason is quoted from whatever refused |
| *could have merged this itself and **deliberately did not*** | the session passed `--review`. Its reason is in the summary |
| *Nothing is merged until you say so* | `pr.autoMerge` is off, so every delivery is a question and this one is not special |

A refusal is prose on the card and never a field in the `beadpr` block — the block
carries identity and intent, and "why it didn't merge this time" is neither. The same
sentence goes on the pull request itself, because a green PR sitting open for two days
with nothing on it to say why is the state this fallback exists to *not* be mysterious
about.

The rest is built to be answerable without opening GitHub, because the answer to
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

### Ship it — the same merge, and then the deploy

The fourth button, and the only one that is not always there. **Ship it** is `MERGE:`
plus the repo's [declared deploy](#deploying-a-repo-when-it-says-how),
so what changes is not only what is on `origin` but what is *running*.

**It appears only where there is a deploy to run.** `deploys` in the config is empty by
default and most repos have no entry, so most cards get the three answers they always
had — a Ship button in a repo that declares nothing would be a button whose entire
content is a failure message. `beadcause-deliver` looks the declaration up when it files
the card, and the server looks it up **again** before anything runs, so a declaration
removed in between costs a stale button and never a wrong deploy.

**And it says what it will actually do**, on the button, in two lines:

```
  Ship #42
  merge, then runs launchctl · rebuilds apk · restarts beadcause
```

Because "deploy it" means something different in every repo, and the difference is
exactly the part worth a second's thought: `fly deploy` costs nothing you would notice,
and `launchctl kickstart -k` on this Mac SIGKILLs the daemon you are holding.

**Merge is still first, and still the safe one.** Ship sits second, deliberately not
under a thumb aiming at the top button: a merge you meant to ship is two more taps on
[the PR board](#the-three-buttons), where Ship runs the same declared deploy this one
does, and a deploy you did not mean is not a tap at all. Both arm the same way —
tap, then tap again — and both are disabled on the same facts, because a pull request
GitHub will not take is not one to ship either.

**The deploy starts last of everything.** This is the whole reason it is not simply
`MERGE:` with a flag. A beadcause deploy kills the process serving the request that
asked for it, so by the time it starts, everything durable this answer owed is already
done: the merge is on GitHub, the work bead is closed with the PR number in its reason,
the answer is written, the question is closed, and every other client has been told.
Then — and only then — `startDeploy` hands the work to a detached runner and the reply
goes out. A 200 here means *written down and a process owns it*, never *it worked*; how
it went arrives on `/api/deploys`, on the PR board, and on your phone.

**Ship in a repo with nothing declared still merges.** It has to: the merge is the half
both buttons asked for, and throwing it away over a missing config entry would be the
worst possible reading of "ship it". The bead says why nothing was deployed, in that
sentence, rather than implying it shipped. The same is true of a deploy already running
for that repo, and of a declaration that is present and malformed.

One thing to know about the lock screen: ntfy allows three action buttons and a
shippable delivery offers four, so **decline** is the one that falls off the
notification. That is the right one to lose — declining asks for a direction to take
instead, which is a paragraph and not a tap, and on the card itself it is already a
two-step panel for exactly that reason.

`node test/ship.mjs` drives the whole thing through a real `POST /api/respond` with a
fake `bd`, a fake `gh` and a declared deploy whose command writes a file: that `MERGE:`
deploys nothing, that free text does neither, that a repo with no declaration merges and
says so — and, the one that needs an end-to-end test to prove at all, that the deploy
command sees a `bd` call log which **already** contains the closed bead and the answered
question.

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
| `MERGE:` | `gh pr merge --merge --delete-branch` (whatever `pr.mergeMethod` says), then closes the work bead with the PR number in its reason |
| `SHIP:` | the same merge, and then the repo's declared deploy — started after the answer is written, never before |
| `CHANGES:` | comments on the PR and the bead, reopens the bead, leaves the branch alone |
| `DECLINE:` | closes the PR unmerged, abandons the branch, reopens the bead — and writes whatever direction you gave onto it |

"Looks good to me" is a comment, which is exactly what it looks like. So is *"I think
we should MERGE: it"* — the marker only counts at the start.

`SHIP:` is a fourth word rather than a flag on `MERGE:` for the same reason the other
three are separate words: the wire carries the response string and nothing else, so the
prefix is the whole protocol — and *merge* must never widen into *merge and deploy*
because somebody appended a sentence to it. `MERGE: ship it after` merges, and deploys
nothing.

The merge happens **before** the question is closed, the same order `createProposed`
keeps: a merge GitHub refuses leaves the question open and answerable rather than
closed on a promise nothing kept. And it is never `gh pr merge --auto`, from either
caller. Queuing a merge to happen later when checks go green would make a tap a promise
rather than an act, and the bead would close on work that had not landed — which is also
why a worker *waits* for its checks and then merges, rather than handing GitHub a
standing instruction and exiting. Whatever closes a bead here is a merge that has
already happened.

A delivery question closes on all four answers, including *request changes* — the
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
  "mergeMethod": "merge",
  "autoMerge": true,
  "mergeWaitMs": 300000,
  "tidyMerged": true
}
```

`merge` — a merge commit — because ancestry is load-bearing here, and this is the one
setting where the obvious answer is the wrong one.

The obvious answer was `squash`: a session's branch is thirty commits of an agent
thinking out loud, and `main` should carry the conclusion. That is right about the log
and wrong about the cost. A squash merge writes a *new* commit with the branch's tree
and none of its history, so the branch never becomes an ancestor of anything — and the
worktree cleanup asks exactly that question, in two places, before it will remove a
directory: the `ship` skill's retirement gate, and the attic sweep that re-checks it
before deleting an entry that has aged out. Both keep anything that fails, with "NOT
merged into main — removing it destroys its only copy", and both are *right* to: that
gate is the only thing standing between the sweep and the sole copy of unmerged work.

So under `squash` every delivered worktree became a permanent attic resident, kept
forever over work that shipped last week. `merge` is the way out that needs no gate
weakened anywhere, and it matches what this repo has always actually done — every
`ship` produces a merge commit, and the log is wall-to-wall `Merge branch
'worktree-…'`. The log stays readable too: `git log --first-parent` reads exactly like
a squash history, one line per branch, with the thirty commits still there when you
want them.

`squash` is still supported and still honoured — `--method` overrides per delivery, and
the daemon's own worktree sweep covers it by asking GitHub whether the PR merged (see
`tidyMerged`). What it costs is that the attic keeps its worktrees, because nothing can
make an external `--is-ancestor` say yes.

**A stored `"squash"` is moved once, and says so.** Changing a default fixes nothing on a
machine that already has a config, because the stored value wins the merge — and this one
said `"squash"` from the day the key existed, when that *was* the default. So the first
`loadConfig` after this change edits that one value in the file, prints a line saying it
did, and records in `state.json` that the move has happened. It happens once, ever: set
`squash` back on purpose and it stays, because the receipt has been spent. The file is
edited rather than rewritten — the other settings in it are left exactly as they were,
including the ones you never set.

`autoMerge: false` is the one knob worth knowing about: it puts every delivery back on
the ask-first ending, where the worker stops after opening the pull request and the merge
is your tap. Nothing else changes — same branch, same PR, same card, same three answers —
so it is a safe thing to flip for an afternoon, and flipping it back needs no cleanup. A
worker can reach the same ending on its own for one delivery with `--review`, and the
card says which of you decided.

`mergeWaitMs` is how long a worker waits for its checks before giving up and asking. Too
short and a repo with CI hands you every delivery as a question — a pull request is at
its most pending in the second after it is opened. Too long and a stuck CI queue holds a
worker's window open for an hour. Five minutes, then it asks.

### What it does to the two things that were already here

**A fourth ending.** The advocate reads three endings off a session that exits: closed,
handed back, or unfinished. A session that *handed over* a pull request is none of them —
its bead is supposed to still be open, because merging is what closes it. Without a
fourth, the second-best outcome in the system would read as "exited unfinished", cost an
attempt, and after two of them the advocate would give up on a bead whose work was
sitting in a pull request waiting on a tap.

| the file appears and… | reading |
|---|---|
| the bead is closed, reason `Landed as #42 …` | **landed #42** — the session merged its own pull request |
| the bead is closed | **done** |
| an open `pr-delivery` question names this bead | **handed over** — waiting on your merge, costs no attempt |
| the bead carries `human` | **handed back to you** |
| neither | **exited unfinished** — costs an attempt |

The first row is read off the close reason `bin/deliver.js` writes, which costs nothing:
`bd show` has already returned by then. The alternative — asking GitHub, per ended worker,
per tick — would be a `gh` call to re-derive something the delivery already knew. And the
distinction is worth drawing, because "closed by the session" is the one sentence on the
sessions page that does not say whether the work reached `main`.

**The sweep learned a second way for a branch to be gone.** Its fifth condition was
"its branch is an ancestor of `main`", and a squash-merged pull request puts a *new*
commit on main with the branch's tree and none of its history — so that test is false
forever. Every delivered worktree would have piled up unswept while the log said "not
merged into main" about work that shipped last week. So when the cheap local test says
no, and only then, the sweep asks GitHub whether the branch's PR merged. The other four
conditions are unchanged, and a repo with no `gh` behaves exactly as it did. (The
default is now a merge commit, so the local test usually answers on its own; this path
is what a deliberate `squash` still rides on.)

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

`npm test` covers three libraries. `test/pr.mjs` drives `lib/pr.js` against a fake `gh` on
`PATH`, keyed off a JSON world file and a call log, so *"it never shelled out"* is an
assertion rather than a hope — including the wait for the checks, whose `sleep` is
injected and is where the fake's world changes, so pending-then-green runs in
milliseconds. `test/delivery.mjs` covers the block, the markers, the split, and that the
three openings of a card are three different sentences. `test/land.mjs` covers the thing
with no other interface: the **brief**, which is all beadcause can make a worker do. It
asserts that the landing ending never tells a session to merge `main` by hand, that its
marker line cannot claim `CAN BE MERGED` over work already in `main`, that the ask-first
ending can claim nothing but a review, and that `pr.autoMerge` reaches the brief it
decides. None of the three touches the network, a bead, or a repo.

`node scripts/land-check.mjs` is the end-to-end half, and it is the only place the merge
itself is exercised: a real `git` against a real bare remote, a real `bd` against a
scratch workspace under `/tmp`, the real `bin/deliver.js`, and a fake `gh` that logs every
call. Five scenarios — green checks, a refusal from GitHub, a red check, `--review`, and
`--owed`. The assertions that matter are the negative ones: `gh pr merge` must not appear
in the log for the red check or for `--review`, and the work bead must still be open in
every scenario that did not merge, because a bead closed over work sitting in an unmerged
pull request is invisible from every screen in the app. `BEADCAUSE_CONFIG_DIR` points it
at a scratch config whose ntfy is off, so a harness run cannot reach anyone's phone;
`--keep` leaves the temp world for inspection.

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
bead. Twenty-one assertions: the tabs and their counts, that selecting one filters the
list to it, that the selection survives a reload, that ＋ POSTs the *selected* repo and
lands in the thread, that ＋ on All opens the picker and starts nothing by asking, the
empty and the removed-repo cases, and — the one that must not have changed — that
opening a conversation by id still bypasses the launcher entirely. `--baseline` serves
the committed `console.js`/`console.html`/`style.css`, where there is no All tab and no
＋ at all, so it must fail everything but that last one. `--out=<dir>` writes the three
screens, because a row of passing assertions says nothing about whether the tabs and
the ＋ fit beside each other at 393px.

### A chat with an agent says so

Two screens start conversations, and they write the same record. `/console` starts a
**chat session** — describe a thing, get a proposal. [The agents
screen](#what-an-agent-is--and-how-it-asks-to-be-different) starts a **chat with one of
the agents** — the Critic, the Researcher, whoever — which is the same
machinery with a different foundation and no proposal expected. Both carry a workspace,
so both are in `/api/consoles`, and the repo tabs made that *more* visible rather than
less: an agent chat lands under its repo's tab as if it had been started there.

Which left a chat with the Critic sitting in *Pick up again* looking exactly like a
conversation about what to file next, with only its title to tell them apart — and a
title is the one thing on that row you can rename.

So an agent chat is marked twice:

- **The agent's own emoji in the phase slot**, where a chat session draws 💬. Free, and
  it is the first thing your eye lands on down the left edge of the list.
- **A tinted pill beside the repo**, `🧨 Critic`, and this is the one that holds. The
  phase slot is *status* as well: a running turn draws a spark there and a finished one
  a tick, and both of those take the emoji away. The pill never moves.

Leaving agent chats out of the list entirely was the other option, and it is worse:
they would then be reachable only from the agent they were started with, which is a
place you go to *change* an agent, not a place you go to find a conversation you had.
The point of *Pick up again* is that it is the one list of everything you were saying.

The name and the emoji are resolved **on the server** (`withAgentNames`, lib/agents.js),
because the record only ever stored the agent's *id* — the roster is where a name lives,
a custom agent's emoji exists nowhere else, and a second fetch for the roster from the
phone would paint every agent chat as an ordinary chat session and then correct itself.
Both routes that hand the list back use it, reading it *and* closing a row: the close
returns a fresh list the phone renders directly, so an undecorated one there would
un-mark every agent chat on screen until the next reload. An id with nothing behind it
any more keeps its own name and a generic 🤖 rather than falling back to the default
agent — the conversation happened, whatever the roster says now.

`node test/agentchats.mjs` (in `npm test`) covers the naming and both routes;
`scripts/launcher-check.mjs` covers what the row draws.

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

**A hot swap is a daemon restart as far as a terminal is concerned**, and it happens
every time you save a file in `lib/` rather than once a week — so the socket is closed
deliberately at the cutover, with a code the page reconnects from, rather than being cut
when the drain gives up on it. See
[the WebSocket goes through it too](#the-websocket-goes-through-it-too-and-a-swap-ends-it-on-purpose).

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
node bin/monitor.js --url https://<host>.<tailnet>.ts.net:4318   # another machine's daemon
launchctl kickstart -k gui/$(id -u)/m4m.beadcause.monitor   # reopen the window now
```

Piped rather than shown on a terminal, it drops the box and prints one line per
event instead, so `node bin/monitor.js >> somewhere.log` does something sensible.

## The router — why you never restart it

Static files are read from disk on every request. Server code is read **once**, at
startup. So an edit to `lib/` leaves a running daemon serving today's pages against
yesterday's routes, and nothing about it looks wrong: the files are correct, the
process is healthy, and a path the page plainly asks for returns 404.
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
- **None of it is live until `npm run install-service` has been re-run.** The plist in
  `~/Library/LaunchAgents` is generated once and never touched by `git pull`, and a
  deploy used to `kickstart` a *label* without looking at what the label points to. So
  the router landed, the installer was updated, this section was written, and launchd went
  on restarting `bin/beadcause.js` for three days with the port answering perfectly the
  whole time. Nothing was broken; nothing was live. It is now checked in four places,
  because the halves fail apart: the installer reads back from `launchctl print`
  what it actually loaded, the daemon prints a `HOT-SWAP IS NOT LIVE` banner when
  launchd started *it* rather than the router, `npm run swap:status` names the
  installed program instead of only reporting that nothing answered, and
  [a deploy refuses to restart a label](#restarting-a-label-is-not-the-same-as-deploying-a-tree)
  whose plist has drifted from the tree it just pulled. A plist rewritten
  without a bootout counts as stale too — launchd keeps the argv it bootstrapped with,
  so editing the file changes nothing on its own.
- **And it says so where somebody is standing.** All three of those checks land
  somewhere nobody looks: `~/Library/Logs/beadcause.log`, and a command you only type
  once you already suspect something. The reason the original bug survived three days is
  that the inbox and the advocate console — the two surfaces actually read, from a phone,
  every day — reported nothing at all, because from their point of view the port was
  answering perfectly. So **the advocate console carries the same verdict**, above every
  card, on `/api/work`'s `service`: one dim line naming the program launchd runs when it
  is the right one, and a red block with the diagnosis and `npm run install-service` when
  it is not. It is drawn on a good day deliberately — a health line that appears only
  when something is wrong teaches you to read its absence as health, which is exactly
  what that console did while it was wrong. The one wrinkle is that the process serving
  the console is a *grandchild* of launchd, so the router passes down what it was handed
  in `BEADCAUSE_LAUNCHD_PROGRAM`; a backend reading its own `argv` would call every
  healthy install stale.

### The WebSocket goes through it too, and a swap ends it on purpose

[The terminal](#the-terminal--driving-a-session-from-the-phone) is an HTTP upgrade, and
an upgrade is not a request the proxy above can carry: `connection` and `upgrade` are
hop-by-hop headers — they describe *this* hop — so a proxy strips them, and has to state
them again when it means to open the next hop as a tunnel. The router did the first half
and not the second. A server with no `upgrade` listener hands the request to its
ordinary handler rather than refusing it, so `GET /ws/terminal` reached the backend
looking like any other GET, missed the upgrade listener there entirely, and the app
answered the only thing it could: `404`, reported by a browser as `Unexpected server
response: 404`.

Which made it the exact shape of the bug this whole section exists to prevent — correct
files, a healthy process, and a path the page plainly asks for returning 404 — with one
extra turn of the screw: it worked perfectly under `npm run start:bare`, where the phone
reaches `lib/termsocket.js` directly, and that is the one configuration launchd never
runs. Both halves are load-bearing, and the suite proves it by breaking each one on its
own: a listener that forwarded the stripped headers produces the identical 404 one hop
later.

So the router tunnels it. It dials the active backend carrying the original `upgrade`,
`connection` and `sec-websocket-*` headers, relays the `101` back along with whatever
bytes followed it — `ws` sends its first frames immediately, and dropping them would eat
the `hello` the page waits for — then pipes the two sockets together and never looks at
a frame. Nothing in `lib/termsocket.js` changed and nothing should: the handshake, the
subprotocol carrying the token, and the accepted-then-closed `1008` for an unknown id
are the same whether the socket arrived over loopback from the router or straight off the
tailnet. A refusal that is *not* a 101 — `401` for a bad token, `404` for a path that is
not the terminal — is written back verbatim, because a proxy that turned that into a
dropped socket would cost the client the one useful sentence in the exchange.

**What a swap does to an attached terminal is a decision, and this is it.** The pty is a
child of the backend and cannot outlive one, so there is no version of this where the
terminal survives a swap — only versions where it ends well or badly. Left alone, an
attached socket holds `inflight` above zero for the whole 60 seconds of the drain: the
phone spends a minute typing into a process that is already condemned, and then loses it
mid-keystroke with `1006`, which is indistinguishable from a tunnel. So the outgoing
backend is asked to close them itself, with a real close frame carrying **1012 — Service
Restart**. The page reconnects within a second onto the new backend, where the record has
come back `resumable`, and `claude --resume` puts the conversation back with the note
that [says so](#and-it-survives-the-daemon-too). The socket is counted in `inflight`
either way, so a backend is never killed out from under one; `npm run swap:status` names
the count beside the requests.

## HTTPS on the tailnet name

The wire was never in the clear — WireGuard already encrypts everything between the
phone and the Mac — so this is not about eavesdropping. It is about three things the
tailnet cannot give you:

- **Secure-context browser features.** The microphone, service workers on anything
  but loopback, the clipboard, WebAuthn: a browser gates all of them on the *origin*,
  and `http://100.x.y.z:4318` is not a secure one whatever tunnel it arrives through.
- **Google sign-in.** It will not accept a non-HTTPS redirect URI. Full stop.
- **Defence in depth.** A tailnet ACL that is one day wrong should cost an
  eavesdropper a TLS handshake, not the whole conversation.

**Where the certificate comes from.** No authority will sign `100.96.105.106`, so
HTTPS means serving the MagicDNS name — `<host>.<tailnet>.ts.net` — and
`tailscale cert` is what gets a certificate for it: Let's Encrypt, fetched through
Tailscale. It is cached in `~/.config/beadcause/tls/`, re-fetched when it has under a
month left, and — because that copy is ours and nothing outside this process touches it
— [renewed by the daemon itself while it runs](#renewing-it-before-it-expires).

**It needs one thing switched on that this repo cannot switch on for you:** *HTTPS
Certificates*, at [the tailnet DNS page](https://login.tailscale.com/admin/dns).
Without it `tailscale cert` answers "your Tailscale account does not support getting
TLS certs", and beadcause says so in the log and **serves plain http exactly as
before** — a daemon that refused to boot over a certificate would take the inbox down
for a feature nobody had asked for yet.

**Terminated in the daemon, not by `tailscale serve`.** Fronting it with Tailscale's
own proxy would be less code and the same certificate, but then the protocol floor
would be Tailscale's to choose and ours to discover. An explicit `minVersion` is only
enforceable where the socket is made — so TLS 1.2 is the floor, 1.1 and below are
refused the handshake, and `test/tls.mjs` pins that with a real client rather than
leaving it as an option nobody would notice being dropped.

**Loopback stays plain http, deliberately.** `127.0.0.1` is already a secure context,
so it gains nothing — and it is where the control plane lives: `npm run swap:status`,
`/internal/*`, `npm run monitor`, and the router's own proxy hop to its backend. A
certificate there would guard the one hop that never leaves the machine and break
every one of those callers on the way.

```
     phone ──▶ :4318 tailnet address   TLS 1.2+, cert for <host>.<tailnet>.ts.net
                       │
     mac   ──▶ :4318 127.0.0.1         plain http — control plane, monitor, router hop
```

**Nothing that already points at the IP breaks.** Every QR you have scanned, every
notification already sent and every installed PWA says `http://100.x.y.z:4318/…`, and
a plain request arriving on a TLS port normally produces a parse error with nothing on
screen to explain it. So the tailnet listener peeks at the first byte: a TLS handshake
goes to the HTTPS server untouched, and anything else gets a **307 to the same path on
the certificate's name** — query kept, so the `?t=<token>` on a pairing link still
pairs. It is a temporary redirect, and method-preserving, so a POST stays a POST and
nothing is cached past `tls.enabled: false`.

The terminal WebSocket needs no change: `public/term.js` derives `wss:` from the
page's own scheme, the upgrade is wired onto whatever `listen()` returned, and the
token still travels as a subprotocol rather than in the URL.

```bash
curl -sI https://$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//'):4318/api/health
curl -sI http://127.0.0.1:4318/api/health          # still plain, still the control plane
openssl s_client -connect <name>:4318 -tls1_1      # refused: alert 70, protocol version
```

### The URL you are given, and what happens to a phone that already has one

`baseUrl` is the one string every generated link is built from — the pairing QR, the
APK install code, the click target on every ntfy notification, the action buttons that
POST back to `/api/respond`, the terminal's `wss://`. It names the certificate now:

```
https://<host>.<tailnet>.ts.net:4318      what the phone is given
http://127.0.0.1:4318                     the control plane, unchanged and still plain
```

**It follows the certificate, and only the certificate.** If there is no servable pair
in `~/.config/beadcause/tls/` — the tailnet has no *HTTPS Certificates*, `tailscale` is
down, `tls.enabled` is false — every one of those links is the Tailscale address over
plain http exactly as before. This is not caution for its own sake: an `https://` link
to a port serving plain HTTP is a TLS parse error with nothing on screen, and it would
be generated precisely on the machines that cannot fix it. So the address is not a
fallback so much as the honest answer to what the daemon is actually serving.

The move happens on its own, in two places. Every `loadConfig()` — so every `npm run
qr`, every `--url`, every `beadcause-ask` — reads the cached certificate off disk and
builds the URL from it; that costs nothing and never fetches. And the daemon asks again
straight after `listen()`, because that is the one moment a certificate can *appear*:
the first boot after you switch HTTPS on obtains one, and the config is rewritten then
so the next `npm run qr` in a different process agrees. A saved `baseUrl` only moves if
this repo generated it — a Tailscale address, loopback, or a `.ts.net` name. A real
domain, a LAN address or a proxy is yours and is never rewritten.

**An already-paired device keeps working, and should be re-paired once anyway.**
Nothing breaks: the URL saved in its home-screen shortcut still names the address, and
the TLS front 307s it to the name with the path and query intact. But the token lives
in `localStorage`, which is scoped to an *origin*, and `https://<name>:4318` is a
different origin from `http://100.x.y.z:4318` — so the redirect lands on a page that
asks for a token it cannot see. **Scan the QR from `npm run qr` again**, once per
device, and the new origin captures the token the same way the first one did. The old
shortcut can then be deleted; leaving it costs a redirect and a token prompt.

### Renewing it before it expires

A `tailscale cert` certificate lasts 90 days, and the copy in
`~/.config/beadcause/tls/` is **ours** — `tailscale serve` would have renewed one for
us, and we are not using it. So the default outcome of fetching a certificate at
startup and never looking again is an app that goes dark about three months later, on a
phone, behind a certificate warning, for a reason nothing on screen explains.

So the listener that owns the port keeps it alive. **Every six hours** it compares the
certificate on the socket against the calendar, and inside the last month it re-asks
`tailscale cert`. Six hours is absurdly often for a date three months out and exactly
right for the two cases that matter: a Mac that sleeps more than it runs is only up for
an hour or two a day, and Tailscale's own renewal — it reissues once a certificate is
two thirds through, so around 30 days left — becomes due at a moment this process has no
way to be told about. A check with nothing due reads one file and compares one date; it
does not shell out.

**The swap does not interrupt anything.** A new certificate goes onto the running
sockets with `setSecureContext`, which decides how the *next* handshake goes and touches
nothing else: the `net.Server` in front still owns port 4318, requests in flight are
still being served, and **a terminal WebSocket that has been open for an hour stays
open**. No restart, no dropped port, nothing for the phone to notice. `test/certrenew.mjs`
holds all three of those — including a WebSocket opened before a renewal, echoing a
message after it.

**And when it cannot renew, it says so where you will see it.** This is the one failure
whose own error message cannot reach you: once the certificate has actually expired the
inbox answers the phone with an interstitial, and the log line explaining it is on a Mac
nobody is sitting at. So a renewal that fails gets an ntfy push — through a relay that
has nothing to do with this listener — carrying what `tailscale` actually said and the
command that fixes it. It repeats daily rather than every six hours, and its priority
climbs as the expiry approaches: a fortnight out this is a chore, three days out it is
the app going dark.

```
[beadcause] tls  CERTIFICATE NOT RENEWING — mac.tailnet.ts.net expires in 6.2 days:
                 your Tailscale account does not support getting TLS certs
[beadcause] tls  fix it by hand: tailscale cert mac.tailnet.ts.net
```

Two details worth knowing if you ever debug this:

- `tailscale cert` **can fail while exiting 0** — an account without *HTTPS
  Certificates* prints a 500 to stderr and returns success — so what counts as a
  renewal here is a certificate whose bytes *changed*, not an exit code and not the
  presence of a file. A `cert` that hands back the one we already had is normal at 30
  days and an alarm at 10.
- `BEADCAUSE_TAILSCALE` overrides where the `tailscale` binary is looked for (the
  built-in list is three macOS paths, no `PATH` lookup, because launchd's `PATH` is not
  yours). It is what lets `test/certrenew.mjs` drive the whole renewal against
  certificates it mints itself instead of asking Let's Encrypt for a real one every time
  somebody runs the suite.

## Signing in with Google

There are **two** credentials, and which one a caller uses is decided by whether it can
hold a cookie. The token is the original and it is going nowhere; Google sign-in is
beside it, for the one caller that has a face.

| | credential | who uses it |
|---|---|---|
| **The shared token** | `x-beadcause-token: <token>`, or `?t=<token>` on a link | ntfy action buttons, `lib/notify.js` calling back to cancel a push, the Android app, `scripts/shot.mjs`, `bin/router.js`'s proxy hop and its `/internal/*` control plane, `npm run check`, `curl` |
| **A Google session** | a signed httpOnly cookie, from an address on the allowlist | a browser, and only a browser |

**The order is the compatibility guarantee.** The token is asked first on every single
request, and a request that has it never reaches the sign-in code at all — whether
sign-in is configured or not. Nothing in the list above can perform a redirect dance:
an action button POSTs an answer from the notification shade, the Android app is Kotlin,
`shot.mjs` drives a headless Chrome that has never signed into anything. Sign-in is
purely additive, and `test/auth.mjs` asserts that in both directions — the token working
with sign-in on, and a page with no credential still being served with sign-in off.

**It is off until it is configured, and "configured" is strict.** All three of a client
id, a secret and a non-empty allowlist, *and* something to serve an https callback from:

```json
"auth": {
  "google": {
    "clientId": "1234-abc.apps.googleusercontent.com",
    "allowed": ["you@gmail.com"]
  }
}
```

```bash
# the secret goes in a file, never in config.json — see below for why
printf '%s' 'GOCSPX-…' > ~/.config/beadcause/google-client-secret.key
chmod 600 ~/.config/beadcause/google-client-secret.key
```

Anything less and the token stays the only credential, with the reason in the log
(`[auth] Google sign-in is off — …`). That includes having no certificate yet: Google
refuses a plain-http redirect URI, and a `Secure` cookie is dropped by the browser over
plain http — so half-configured, sign-in would be a login screen nobody could get past,
in front of the inbox that explains why. See
[HTTPS on the tailnet name](#https-on-the-tailnet-name).

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials): an
OAuth client of type **Web application**, with the redirect URI
`https://<host>.<tailnet>.ts.net:4318/auth/google/callback` — the MagicDNS name, not the
Tailscale address, because no authority signs an IP. The scopes are `openid email` and
nothing else, so the consent screen asks for an address and no more.

### What a browser sees

A navigation to any *page* with no credential is answered with `/login`, which offers
the Google button and — folded away — the pairing token, because that is still the way
in for a browser whose account is not on the allowlist. Where you were going is carried
through, so a notification opened on a locked phone lands on the card it was about.

**Only pages.** Every asset stays open: the stylesheet, `app.js`, the icon, the service
worker, the vendor bundles. None of them contains anything — every page in this app is
an empty shell that fetches its data through `/api/*`, behind the same gate as
before — and gating a service worker or a manifest breaks an installed PWA in ways that
look nothing like "please sign in".

A `?t=<token>` link still opens the page it names, which is load-bearing: that is what a
notification click is. It also leaves a `beadcause_pair` cookie behind, and that cookie
is the one non-obvious piece of this. A token lives in `localStorage`, so it is on every
`fetch` and on **no navigation at all** — without the cookie, a phone paired by QR code
would open `/?t=…` perfectly and then be bounced to the login screen the moment it
tapped the tab bar, with the token working the whole time, invisibly. The pairing cookie
says only "this browser has been paired", and it is deliberately **not** accepted for
`/api/*`: it opens documents, never data.

### The session, and how it ends

An HMAC over `{sub, email, exp}` with a key in `~/.config/beadcause/session.key` —
`httpOnly`, `SameSite=Lax`, and `Secure` whenever what is served is https. There is no
session store, and that is deliberate: the daemon is
[replaced under the port](#the-router--why-you-never-restart-it) several times an hour,
and a store in memory would sign everybody out on every swap.

What that costs is per-session revocation, so be clear about what each act does:

- **Sign out** — on `/admin`, next to the pause-all controls, because that is the page
  about what you may do to this Mac rather than about beads. It ends the browser you are
  holding, and it is not drawn at all on an install with no sign-in configured. `/login`
  offers it too, once you are already signed in.
- **Delete `session.key`** — ends every session on every device, everywhere. The only
  global revocation there is. It takes effect on the next backend swap or restart.
- **Rotate the token** — a separate act entirely, and it does not touch sign-in. Delete
  `token` from `config.json` and re-pair every device.

### Whose answer it is

A session is an identity, so it is used as one: **an answer, a comment or a dismissal
note written by a signed-in browser goes onto the bead under that address**, not under
`beadcause`. That is `bd`'s `--actor` (and `BEADS_ACTOR`, which it has to agree with —
see `lib/bd.js`), so it is on the comment, on the close, and in `bd show` six months
later, which is the only place the question "who decided this" ever actually gets asked.

Two rules keep it honest:

- **A caller with no session is written exactly as it always was.** An ntfy action
  button, `lib/notify.js`, the Android app, `curl` — none of them can hold a cookie and
  none of them has an identity to name, so all of them still write as `actor` from
  `config.json`. A request carrying **both** a token and a session is a signed-in
  browser (the phone sends its pairing token on every fetch), and the session wins;
  otherwise the attribution would never once apply to the device it was built for.
- **Only what you *said* gets your name.** The `human-replied` label, the status
  changes behind a hand-back, the beads a "yes" creates and the note a merge leaves on
  a work bead are all the daemon's record of its own actions, and they stay
  `beadcause`. A byline on those would read as you having done them by hand.

`test/attribution.mjs` holds both halves.

### Where the two secrets live, and how to rotate them

Both of them are named so that the git repo in that directory *cannot* commit them, and
that is the design rather than a habit. `~/.config/beadcause` is
[a repo](#where-it-lives-configbeadcause-is-a-git-repo) that snapshots `config.json`
after every write — which is the point of it — so a secret in that file is not "on disk
in the clear", it is in a **history**, and a rotation cannot reach back into a history.

| | where it lives | rotate it by |
|---|---|---|
| **Session signing key** | `~/.config/beadcause/session.key`, generated on first use at 0600. `BEADCAUSE_SESSION_KEY` overrides it | deleting the file — every browser everywhere is signed out, and the next swap makes a new one |
| **Google client secret** | `~/.config/beadcause/google-client-secret.key`, or wherever `clientSecretFile` points, or `BEADCAUSE_GOOGLE_CLIENT_SECRET` (no copy on disk at all) | regenerating it in the [Google Cloud console](https://console.cloud.google.com/apis/credentials) and writing the new one to that file. Sign-in picks it up within 30 seconds; nobody is signed out |
| **Shared token** | `token` in `config.json`, and it is *meant* to be there — every non-browser caller needs it | deleting the field and re-pairing every device |

Both secret files end in `.key`, and the extension is doing the work: `*.key` is ignored
in that repo **and** on its `FORBIDDEN` list, so one cannot reach the history even if
somebody edits the ignore file. `*.secret` and `google-client-secret*` are on both lists
too, because an earlier version of this page suggested `google.secret`.

**There is no `clientSecret` field any more.** There was, briefly, documented as the
convenient-and-worst option — and a secret there would have been committed within seconds
of being saved. Three things replaced it, and the third is the one that makes the first
two true:

- it is not read. A secret in that field configures nothing.
- it is not merely ignored, either: **any that is still there is moved.** Every process
  that loads the config empties the field into the secret file at 0600 and writes the
  config back without it, so an install that had one keeps working and stops leaking. The
  log says where it went.
- and **the commit itself refuses.** Every snapshot greps its staged blobs, not just their
  names: a secret written into any committed file as a field, and the literal contents of
  every secret file in that directory — the second of which is what catches one pasted
  into a bead console, since `consoles/` is committed too. The commit aborts and nothing
  is left staged. That is the guard that covers the window between a hand-edit and the
  next load, and it needs nothing to have gone right first.

```bash
npm run secrets   # has one EVER been in the history? every commit, every ref
```

That last one is the question the guard cannot answer, because a guard is a promise about
the future. If it finds something, the fix is to **rotate that credential** using the
table above — not to rewrite the history. A commit cannot be honestly unmade, and the one
thing you can be certain of afterwards is that the old value no longer works.

If `clientSecretFile` points at a file *inside* `~/.config/beadcause` whose name none of
those rules match — `google-secret.txt`, say — the secret in it will be committed, and
nothing stops it, because refusing would turn a working sign-in off over a filename. What
happens instead is a line in the log every time sign-in is checked, and it names the file.

### What is checked, and what is not

`test/auth.mjs` drives the whole dance over real HTTP with Google's token endpoint
stubbed: authorize → callback → session cookie → an API call carrying only that cookie →
sign out → refused. The refusals get the same treatment, including the two that are
easiest to get wrong — an address off the allowlist (turned away, logged, and *not*
echoed back on the screen, because a login page that says which addresses exist is a
directory) and a `state` that does not match the cookie.

What it does **not** check is Google itself. The `id_token`'s signature is deliberately
not verified, because it arrives from a direct TLS call from this process to Google's
token endpoint carrying the client secret — the case Google's own documentation says
verification can be skipped in. Everything that does not need a key *is* checked: the
issuer, that the token was minted for this client, that it has not expired, that the
nonce is the one we sent, and that Google says the address is verified — which is the
hole the allowlist would otherwise have, since anybody can put any address on an account
they have not proved they own.

## HTTP API

Auth on everything under `/api/` except `/api/health`: header
`x-beadcause-token: <token>`, or `?t=<token>` for URLs that have to be linkable — **or**
a Google session cookie, if [sign-in](#signing-in-with-google) is configured and this is
a browser. The token is asked first, always, so nothing below changes for a caller that
has one.

`/auth/*` is the one family of routes with no credential in front of it, because it is
how a browser gets one: `/auth/google` starts the dance, `/auth/google/callback` ends
it, `/auth/whoami` says which credentials this install has (and who you are, if the
cookie says so), and `/auth/signout` ends the session.

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, workspaces[]}` · **no token** |
| GET | `/api/questions` | `?scope=human\|both\|agent` | `{questions[], workspaces[], spaces[], summary, scope}` — `scope` defaults to `human`, and an unrecognised value falls back to it rather than erroring. `summary` is `{sessions, proposals, questions}`, the three counts the inbox's chrome draws |
| GET | `/api/question` | `?workspace=&id=` | one question **plus `comments[]`** |
| GET | `/api/poll` | `?since=<seq>&wait=<s>` | long-poll: `{seq, resync, events[], questions, workspaces[]}` |
| POST | `/api/respond` | `{workspace, id, response, create?, edits?}` | comments, then closes the bead. `create` is the 1-based indices of a proposal's beads to file; without it, `CREATE:` in the text means all and `CREATE: 1,3` means those. `edits` is `{n: {title, type, priority, description, acceptance}}` keyed by the same numbers, applied before creating. A `MERGE:` / `CHANGES:` / `DECLINE:` response on a delivery question acts on its pull request first — see [Landing work](#landing-work--a-branch-a-pull-request-and-the-workers-own-merge) |
| GET | `/api/pr` | `?workspace=&id=` | `{delivery, pr, unavailable}` — the live diffstat, check rollup and mergeability of a delivery question's PR. Every failure is an answer rather than a 500: no `gh`, no remote, GitHub unreachable all come back with `pr: null` and a sentence in `unavailable` |
| GET | `/api/prs` | `?refresh=1` | the PR board: every pull request in every repo with its Merged · Pushed · Deployed lamps, plus `observing`. Cached 25s on the daemon; `refresh=1` forces the `gh` sweep |
| POST | `/api/pr/merge` | `{workspace, number, method?}` | merges it at GitHub, then fast-forwards this Mac's `main`. The two halves report separately — `{pr, alreadyMerged, land}` — because a merge that landed and a fast-forward refused over open files is a *good* outcome and one flat failure over both would send you to GitHub to find out which |
| POST | `/api/pr/ship` | `{workspace, number}` | the declared deploy where the repo has one, an iTerm session where it does not. `409` if the PR is not merged — shipping an unmerged pull request has no meaning. Refused on an observer |
| POST | `/api/pr/comment` | `{workspace, number, text}` | a note on the pull request at GitHub and nothing else. Not `/api/comment`, which writes on a *bead* and puts an agent onto answering it |
| POST | `/api/comment` | `{workspace, id, text, agent?}` | comments, sets `human-replied`, dispatches that agent to reply (default when absent or unknown) |
| POST | `/api/dismiss` | `{workspace, id, reason?}` | takes the card off the screen and **closes nothing**. Writes your note if you typed one, writes nothing at all if you did not, and never touches the status — "I am not dealing with this now" is not "this is decided" |
| POST | `/api/filter` | `{space, workspace}` | which slice the inbox is, remembered server-side so every client agrees and the notifications match. Each is a name or `all`, bounded at 120 characters. Widening forgets what you had declined |
| POST | `/api/notifications/dismiss` | `{keys[], confirm}` | clears the phone's notification rows for beads the filter excludes. `confirm: false` records the decline, which is what stops the next sweep asking again. The beads are untouched either way |
| POST | `/api/ask` | `{workspace, title, body, priority}` | `{id, key}` — files a new `human` bead |
| POST | `/api/session` | `{workspace, id}` | `{dir}` — opens iTerm2 + `claude` on that bead |
| POST | `/api/status` | `{workspace, id, phase, detail, actor}` | agent progress |
| GET | `/api/agent-log` | `?workspace=&id=` | `{lines[], running, phase}` — the dispatched agent's log, as the CLI would have shown it |
| GET | `/api/asset` | `?p=<abs path>` | image/doc bytes, restricted to `assetRoots` |
| GET | `/doc` | `?p=<abs path>` | the HTML reader page |
| GET | `/api/graph` | `?workspace=&id=` | `{nodes, links}` — the whole workspace with no `id` |
| GET | `/api/bead` | `?workspace=&id=` | one issue in full, plus `comments[]` — for the graph's detail sheet |
| GET | `/api/bead-children` | `?workspace=&id=` | `{children[]}` — every child of that bead, closed ones included, open work first. Its own route because `bd show` does not carry children |
| GET | `/api/work` | — | `{workspaces[], elsewhere[], advocates[], service}` — per workspace: claimed beads, live `claude` sessions, counts, errors. `service` is what launchd is running — see the router section |
| GET | `/api/agents` | — | `{agents[], default}` — the roster you can address a comment to |
| POST | `/api/agents` | `{name, description}` | creates one and returns the new roster. `tools` is never accepted here |
| POST | `/api/agent-arm` | `{id, acknowledge?, disarm?}` | arms that agent's configured tools override for **one** reply. `428` the first time, carrying the warning to show; `409` while it is answering; `400` if it has no override |
| DELETE | `/api/agents` | `?id=` | removes one of yours; built-ins refuse |
| GET | `/api/foundation` | — | `{requests[], workspaces[]}` — the foundation channel on its own, without an inbox sweep. **The bare path is the channel and nothing else** |
| GET | `/api/foundations` | `?workspace=` | `{agents[], workspace, workspaces[]}` — every agent kind, for the list on the agents screen |
| GET | `/api/foundation/agent` | `?id=&workspace=` | `{agent, workspace}` — one agent's foundation, history and activity. `404` for an id that is not an agent kind. Named for its neighbours `/api/foundation/{amend,decline,log}`, and *not* the bare path: it was registered there too, where it never answered once |
| POST | `/api/foundation/amend` | `{id, workspace?, set, bead?, justification}` | edits one agent's foundation, recorded exactly like an amendment the agent asked for — same history, same justification. `400` naming the field if `set` carries a protected one, rather than dropping it silently |
| POST | `/api/foundation/decline` | `{id, workspace?, bead?, request, reason}` | records a refusal against that agent, so `git log refs/beadcause/foundations` carries the no as well as the yes |
| GET | `/api/foundation/log` | `?id=&ws=&bead=` | `{key, log}` — that agent's transcript. `{key: null}` and a sentence when the kind keeps no log file |
| POST | `/api/advocate` | `{workspace, action}` | `pause` · `resume` · `release` (free the slots) · `forget` (clear attempt counters) |
| GET | `/api/advocate-log` | `?workspace=` | the survey agent's transcript, as the CLI would have shown it |
| GET | `/api/session-archive` | `?workspace=&id=` | the archived sessions for a bead |
| GET | `/api/session-archive` | `?workspace=&commit=&file=` | one archived `session.log`, `meta.json` or `transcript.jsonl` |
| GET | `/api/session-log` | `?pid=` | the whole session record — `{pid, sessionId, name, cwd, where, workspace, status, kind, at, startedAt}` — plus `{file, lines[]}`, the tail of its own transcript. 404 for a pid that is not running |
| GET | `/monitor`, `/advocates`, `/sessions`, `/work`, `/work.html` | — | the advocate console — and the sessions view it absorbed (one page, five paths) |
| GET | `/session` | `?pid=` | the HTML page for one live session: its facts and its transcript |
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
| GET | `/api/admin` | — | every scope and what pausing it would cost. Read-only and cheap — no `bd` call, no spawn — because `/admin` polls it and the counts on the buttons have to be current when you press one |
| POST | `/api/admin` | `{action, what, scope, mode}` | pause or resume everything, one space, or one half of it. `what` is `all` · `advocates` · `terminals`; `mode` is `drain` (default — no new launches, running workers finish untouched) or `kill`. Never run at boot: a `launchctl kickstart -k` behaves exactly as it did. Refused on an observer |
| GET | `/api/deploys` | `?limit=` or `?id=` | the recent deploys, or one with its log. Four endings, not two: `ok`, `failed`, and the two that mean nobody knows — `unconfirmed` (the ordinary ending of a restart) and `lost` |
| POST | `/api/deploy` | `{workspace, bead?, reason?}` | runs that repo's declared deploy. `409` with no declaration, or if one is already running. Means "written down and a process owns it", never "it worked". Refused on an observer |
| POST | `/api/presence` | `{device, view, key}` | which view this device has open, so the mirror can follow it. Wakes `/api/poll` without costing a `bd` sweep — see `changed` there |
| GET | `/api/presence` | — | `{devices[]}` — who is where |
| DELETE | `/api/presence` | `{device}` | forget one device |
| POST | `/api/session-say` | `{pid, text}` | says one line into a live session's own iTerm window. `413` with the words left in the box if it is past `SAY_MAX` — the message rides to `osascript` as an argument, and past `ARG_MAX` the failure reads as "the session is gone", which is the one thing this must not lie about |

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
advocate console lists (the ones outside every workspace under **Elsewhere**). It is
no longer a tab badge — see [the tab bar](#getting-around--the-tab-bar) — but the
console's tally is drawn from it. `proposals` counts **advocates**, not beads: one open ask per
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
| `port`, `host` | listens on `127.0.0.1` **and** the Tailscale IP only — never the LAN. The *address* is what gets bound; `baseUrl` is what gets handed out, and they differ on purpose |
| `baseUrl` | the origin every generated link is built from — the pairing QR, the APK code, every notification's click target and action button, the terminal's `wss://`. Maintained for you: `https://<host>.<tailnet>.ts.net:<port>` when there is a certificate to serve it, the Tailscale address over plain http when there is not, and moved between the two on its own. Set it to something else — a real domain, a proxy — and it is never rewritten. See [the URL you are given](#the-url-you-are-given-and-what-happens-to-a-phone-that-already-has-one) |
| `tls.enabled` | HTTPS on the tailnet address with a `tailscale cert` certificate and a TLS 1.2 floor (default `true`). Loopback is never TLS whatever this says, and a tailnet without *HTTPS Certificates* enabled falls back to plain http with the reason in the log — see [HTTPS on the tailnet name](#https-on-the-tailnet-name) |
| `tls.name` | the name to get a certificate for, if not the MagicDNS name `tailscale status` reports (default `null` — ask). The protocol floor is deliberately not a setting |
| `token` | required on every `/api/*` call; regenerate by deleting the file |
| `auth.google.clientId` | the OAuth **Web application** client for this Mac (default `null` — sign-in off). All of this key, a secret and a non-empty `allowed` are needed before sign-in switches on at all — see [Signing in with Google](#signing-in-with-google) |
| `auth.google.clientSecretFile` | where to read the client secret from. Default `null`, meaning `~/.config/beadcause/google-client-secret.key`. **There is deliberately no `clientSecret` field** — this file is committed to the git repo in that directory, so one there would be in a history a rotation cannot reach; any left over from an older version is moved into the file on load. See [rotating them](#where-the-two-secrets-live-and-how-to-rotate-them) |
| `auth.google.allowed` | the addresses allowed in, case-insensitive. Empty — the default — means sign-in is off, because a login screen nobody can pass is worse than none |
| `auth.google.redirectUri` | the callback registered with Google. Derived from the certificate's MagicDNS name and normally left `null`; sign-in cannot switch on without one, because Google refuses a plain-http callback |
| `auth.google.sessionDays` | how long a signed-in browser stays signed in (default `30`) |
| `auth.google.enabled` | `false` turns sign-in off while leaving the rest of the block configured (default `true`) |
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
| `pr.enabled` | land finished work as [a pull request the worker merges](#landing-work--a-branch-a-pull-request-and-the-workers-own-merge) (default `true`). `false` puts every workspace back on the oldest ending — work the bead, close the bead. A workspace with no `gh` or no GitHub remote gets that ending anyway, without needing to be named |
| `pr.base` | what a PR is opened against and merged into (default `main`) |
| `pr.mergeMethod` | `merge` (default), `squash` or `rebase`. A merge commit because a squash-merged branch is never an ancestor of `main`, and the worktree cleanup will not remove a worktree that fails that test |
| `pr.autoMerge` | the worker merges its own pull request once the checks report (default `true`). `false` stops it after opening the PR and makes the merge your tap, which is what every delivery used to do. A worker can choose the same for one delivery with `--review` |
| `pr.mergeWaitMs` | how long a worker waits for its checks before handing the PR over instead (default 5 min). A PR is at its most pending the second after it is opened, so without this a repo with CI would ask you about every delivery |
| `pr.tidyMerged` | let the worktree sweep ask GitHub whether a branch's PR merged, since a squash-merge never makes it an ancestor of main (default `true`; belt beside `mergeMethod`'s braces) |
| `advocates.workspaces` | which repos get an [advocate](#advocates--an-agent-per-repo-whose-job-is-the-queue-reaching-zero). **Empty by default**; `["*"]` for every one |
| `advocates.maxWorkers` | sessions one advocate may have open at once (default 1), clamped to `maxWorkersLimit` |
| `advocates.maxWorkersLimit` | the ceiling that clamps it (default 3). A larger `maxWorkers` is clamped **and logged**, never silently applied |
| `advocates.globalMaxWorkers` | across every advocate (default 10), so six repos can't open eighteen windows |
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
| `advocates.closeFinishedSessions` | [close a work session's window once its bead is closed](#closing-the-window--a-session-that-has-finished-should-not-still-be-on-screen) (default `true`). `false` leaves every window open, which is what it did before |
| `advocates.closeGraceSeconds` | how long an idle session gets between its bead closing and the first signal (default 90) |
| `advocates.closeHardSeconds`, `advocates.closeGiveUpMinutes` | how long `SIGTERM` gets before `SIGKILL` (default 45), and how long the whole thing gets before it gives up and leaves the window for you (default 30 min) |
| `agents` | extra reply agents beyond the four built in — `{id, name, emoji, description}`, plus `tools`/`model` if you set them by hand |
| `defaultAgent` | which one answers when you haven't picked (default `answerer`) |
| `agents[].tools` | the allowlist that agent may be *armed* with, for one reply at a time. Config-file only — see [Allow tools](#allow-tools--for-one-comment-and-only-that-one) |
| `agentToolsAcknowledged` | agents whose extended-tools warning you have accepted; written when you accept it |
| `spaces` | groups of workspaces sharing a notification policy — see [Spaces](#spaces--keeping-work-out-of-your-evening) |
| `claudeSessions` | `false` to stop reading `~/.claude/sessions` for the session rows on the advocate console (default on; absent directory is not an error) |
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
| `SKIP_CONFIGURE` | `scripts/install.sh` asks nothing and keeps the answers on file — the same as `--non-interactive`. `CLAUDECODE`, `AI_AGENT` and `CI` imply it, because a question asked of a terminal nobody is watching is a hang; `--interactive` asks anyway |
| `BEADCAUSE_GOOGLE_CLIENT_SECRET` | the Google OAuth client secret, taking precedence over the secret file. The one place it leaves no copy on disk — see [rotating the two secrets](#where-the-two-secrets-live-and-how-to-rotate-them) |
| `BEADCAUSE_SESSION_KEY` | the HMAC key sessions are signed with, instead of `~/.config/beadcause/session.key`. Setting it to a new value signs everybody out |
| `BEADCAUSE_TAILSCALE` | the `tailscale` binary, overriding the three macOS paths that are searched by default. Has to exist to count — a path typed wrong reads as "no tailscale" rather than failing mysteriously later. See [renewing the certificate](#renewing-it-before-it-expires) |

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

`test/lockfile.mjs`, then `scripts/selftest.mjs`, then every suite under `test/` in
alphabetical order, then `scripts/test-swap.js`. **Nothing lists them** — `scripts.test`
is `node scripts/test.mjs`, and the runner reads the directory, so adding a suite is
adding a file and nothing else. `node scripts/test.mjs --list` prints what would run
without running it. What the suites have in common is that each covers something whose
failure is *silent* — a flag that does nothing, a state file that comes back empty,
a message that was never written. The loud failures are still covered by
`node --check` on changed files and by booting an observer instance and driving it.

**Discovery is a merge fix, not a tidying-up.** The list used to be a single line in
`package.json` naming every suite in order, and adding a suite meant editing that one
line — so a dozen concurrent sessions all edited the same line, and git cannot merge
that: two changes to one line is a conflict however far apart the two insertions read.
bc-ec6 hit it three times in twenty minutes on that line and nothing else, and each
collision cost a downmerge, a resolution and a four-minute suite — by which time main
had moved again, so a branch could lose that race indefinitely while every step it took
was correct. Only three suites are still named in the runner, because only three have an
order that matters: the lockfile check first (a lock that disagrees with `package.json`
makes every later failure suspect), the smoke test second (if the daemon cannot start,
the 30-odd suites after it fail for the same uninteresting reason), and the swap under
load last (it is slower than everything else together). The long tail — where every
collision happened — is unordered, sorted only so the output is stable.

`test/testrunner.mjs` covers that, and the check that matters is not about running tests
at all: it builds two branches in a temp repo that each add a suite and merges them with
a real `git merge-tree` — the same three-way merge GitHub refuses a pull request over —
asserting the merge is clean, with the old one-line chain as the control, asserted to
conflict. Without the control the clean case proves nothing, since two branches adding
two different files were never going to collide. The rest is what discovery can newly
get wrong in silence: that every `test/*.mjs` on disk is in the list (the chain used to
*be* the inventory; the directory is now), that the two `scripts/` entries which are not
`test/*.mjs` survive, that the three pinned positions hold, and that a failure still
stops the run, propagates its exit code, and does not run what comes after it.

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

`test/session.mjs` covers the one address a session has, because every way that breaks
is invisible until you tap a row and get nothing. The session it reads is the test
process itself — `liveSessions` liveness-checks every pid, so a made-up one is filtered
out before the endpoint sees it. It holds that `/api/session-log` answers with the
*whole* record and not the three fields the folded pane happened to need (the regression
that would leave the facts pane blank with nothing on screen to say why), that a dead pid
is a 404 naming it, that `file` comes back even when nothing has rendered yet, that a
transcript needs a token and the page does not, that `public/drawer.js` still owns
`/session` — one line, and nothing about it is visible from the server — and, last, that
`/api/session-log` has exactly one reader in `public/`. That last one *is* the bead: a
second reader is a second detail view growing back.

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

`test/tls.mjs` covers the [protocol floor](#https-on-the-tailnet-name), which is the
quietest thing in this repo: `minVersion` is one option on one object, it has no visible
effect until something old dials in, and nothing in the app would notice it being
dropped. So it is a real handshake against a self-signed certificate in a temp
directory — a client that offers TLS 1.1 is refused, and the assertion is that the
*server* refused it (`ciphers: 'DEFAULT:@SECLEVEL=0'`, because Node's client will not
even offer 1.1 otherwise, and a client-side refusal would pass this test with the floor
removed), while 1.2 and 1.3 both connect and get an answer. Then the three seams the
sniffing front sits on: an HTTPS request served intact, a plain-http request answered
with a 307 to the certificate's name with its query kept, and the terminal WebSocket
over `wss` still gated by the token subprotocol — accepted-then-closed `1008` for an
unknown id, refused with a `401` for a wrong token. Whether a *phone* trusts the real
certificate is a named `skip`: that is a fact about Let's Encrypt and `tailscale cert`,
and no test on this machine can answer it.

The same file covers the other silent failure in that neighbourhood — [the URL the
phone is given](#the-url-you-are-given-and-what-happens-to-a-phone-that-already-has-one).
An `https://` link built on a machine that cannot issue certificates reaches a port
serving plain HTTP, and a TLS parse error is not a page anyone can read; nothing in the
app would notice, because the daemon comes up and the log says http. So the pair on
disk is planted and taken away, and `baseUrl` is asserted to follow it in both
directions — including the halfway states, a fetch interrupted between the two files
and `tls.enabled: false`. The other half is that a `baseUrl` *you* set is never
rewritten: `reconcileBaseUrl` runs on every `loadConfig()`, in every CLI, so a
too-generous match would quietly overwrite a reverse proxy or a real domain on the next
`beadcause-ask`.

`test/certrenew.mjs` covers [the renewal](#renewing-it-before-it-expires), which is
quieter still — the failure it prevents has no symptom for 89 days and then takes the
whole app down, and you could not find it by hand without leaving a Mac untouched for a
quarter and being surprised. `BEADCAUSE_TAILSCALE` points `lib/config.js` at a shell
script that answers `status --json` and mints certificates with `openssl`, so what runs
is the real `obtain()` — the same `spawnSync`, the same "the files decide whether this
worked" rule — against a certificate authority the test made up. Its `refuse` mode is the
actual failure, reproduced faithfully: stderr gets a 500, and the exit code is **0**.
Four things are held. A certificate with months left costs nothing (asserted as *no
calls to tailscale at all*, not as a fast return). A renewal that fails keeps the working
certificate on the socket, says `CERTIFICATE NOT RENEWING` in the log with the fixing
command beside it, and pushes **once** across six checks rather than once per check. A
renewal that succeeds swaps the live sockets — new fingerprint on the next handshake, the
same port still listening, an HTTPS request answered immediately, the TLS 1.2 floor still
refusing 1.1, and **a WebSocket opened before the swap still echoing a message after
it**, which is the acceptance criterion no amount of reading the code proves. And behind
the router, where the listener is loopback-only plain http, the whole thing is a no-op
that starts no timer.

`test/service.mjs` covers whether anything notices that launchd is running the wrong
program — the [three-day bug](#the-router--why-you-never-restart-it) — in two halves.
Detection: a plist written into a fake home, and the verdict `lib/service.js` reaches
about it, including the case where the file is right and the *job* is stale. Delivery,
which is the half that was actually missing: the verdict on `/api/work` from a real
daemon booted with `HOME` pointed at a plist naming `bin/beadcause.js`, so the assertion
is the diagnosis and not merely a field being present. Plus the hop that makes it
possible — the process serving the console is a grandchild of launchd, so passing down
`BEADCAUSE_LAUNCHD_PROGRAM` is what stops a healthy install being reported as stale, and
an *empty* value has to mean "not a launchd job" rather than "read your own argv".

`test/css.mjs` covers something nothing else in this repo would ever say a word about: a
rule in `public/style.css` that has lost its closing brace. Under CSS nesting that is not
a parse error — every rule after it becomes a *nested* rule of it and applies to nothing,
so the file stays valid, the brace count can still balance, no browser console complains,
and the page merely looks a bit plain. It happened: a merge took seven declarations and
the closing brace off `#save-dialog textarea` and gave them to `.key` a hundred lines
below, which killed the last five hundred lines of the stylesheet — the whole advocate
console and the admin page — until bc-4irq tried to add a rule there and could not make
it apply. So the invariant is that a selector block contains no other block, which
forbids nested syntax on purpose: that is the price of a truncated rule failing on the
next `npm test` rather than quietly for a week. The detector is shown the exact wreck, so
a guard that cannot fail is not mistaken for a file that is fine.

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
