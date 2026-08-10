# The beadcause UX review

*bc-l8jp.1 — written 2026-08-10, against `main` at `2b68d2c`.*

This is a document, not a change. Nothing in the app moved to produce it. Read it, cross
out what you disagree with, and the work it calls for gets filed afterwards as beads
under bc-l8jp — the sequenced plan in §6 is written so each step is one bead.

Two things to know before the arguments start.

**"Unused" is not an argument here.** You have used every surface at least once, so the
case against anything has to be one of three: it is *duplicated* (two screens answer the
same question and disagree), it is *dead weight* (it costs real estate or maintenance out
of proportion to what it answers), or there is a *better shape* (the thing it does
belongs somewhere else). Every verdict below names which of the three it is.

**Some of what follows are facts, not opinions.** §2 is a list of defects I found while
inventorying, each one verified rather than inferred — one of them (D1) means a whole
four-tab screen has been unreachable in the running app for some time. Those are not
things to have a view about. They are the first three steps of the plan.

---

## 0. Method, and one correction to the epic

I read every page in `public/`, every route in `lib/server.js`, and the file headers of
the sixteen `lib/` modules behind them. Where a claim needed proof I got proof: D1 was
confirmed by booting `createApp` on a scratch port and calling the route (see §2), and
D3 by reading the two live beads it produced.

One correction to bc-l8jp's own framing, because the plan should count the real thing:
the app does not have "roughly ninety `/api` routes". It has **49 distinct `/api` paths
behind 56 method+path handlers**, plus 5 `/auth/*`, 5 `/internal/*`, and 11 HTML pages
served under 20 URLs. Ninety would be a scale problem on its own. Fifty-six is not — the
problem is not how many there are, it is that 17 of them are absent from the README's API
table and two of them are the same path.

---

## 1. The app as it stands

### 1.1 Every surface, and the paths that serve it

| Surface | Served at | What it answers | Behind it |
|---|---|---|---|
| **Inbox** | `/`, `/index.html` | What is asking me something? | `/api/questions`, `/api/question`, `/api/poll`, `/api/respond`, `/api/comment`, `/api/dismiss`, `/api/filter`, `/api/notifications/dismiss`, `/api/status`, `/api/agents`, `/api/agent-arm`, `/api/agent-log`, `/api/pr`, `/api/session`, `/api/asset` |
| **Chat** | `/console` (+`?id=`, `?ws=&seed=`) | What should the next bead be? | `/api/consoles`, `/api/console` (GET/POST), `/api/console/message`, `/api/console/poll`, `/api/console/draft`, `/api/console/create`, `/api/console/close` |
| **PRs** | `/prs`, `/pulls` | Did it merge, push, ship? | `/api/prs`, `/api/pr/merge`, `/api/pr/ship`, `/api/pr/comment`, `/api/deploys`, `/api/deploy` |
| **Advocates** | `/monitor`, `/advocates`, `/monitor.html`, `/sessions`, `/work`, `/work.html` | What is running, per repo? | `/api/work`, `/api/advocate`, `/api/advocate-log`, `/api/session-archive`, `/api/questions`, `/api/respond` |
| **Mirror** | *(in-page pane on Advocates)* | What does the phone have open? | `/api/presence`, `/api/poll`, `/api/work`, `/api/console`, `/api/respond` |
| **Admin** | `/admin` | Stop everything. | `/api/admin` (GET/POST), `/api/work`, `/auth/whoami`, `/auth/signout` |
| **Foundations** | `/foundations` | What is each agent allowed to be? | `/api/foundations`, `/api/foundation`, `/api/foundation/amend`, `/api/foundation/decline`, `/api/foundation/log`, `/api/consoles`, `/api/console/*` |
| **Terminal** | `/terminal` (+`?id=`, `?ws=&seed=`) | Drive a Claude session by hand. | `/api/terminals`, `/api/terminal` (GET/POST), `/api/terminal/close`, `ws://…/ws/terminal` |
| **Session detail** | `/session?pid=` | What is this one session doing? | `/api/session-log`, `/api/session-say` |
| **Graph** | `/graph?ws=&id=` | How does this bead sit in the graph? | `/api/graph`, `/api/bead` |
| **Document** | `/doc?p=` | Read the file the card pointed at. | `/api/asset` |
| **Sign-in** | `/login` | Get a credential. | `/auth/whoami`, `/auth/google`, `/auth/signout`, callback |

Twelve surfaces. Five are bottom tabs; the other seven are reached seven different ways.

### 1.2 The bar, and the two views that never got on it

`public/tabbar.js` exists because the app used to be a hallway: every page ended in an ✕
that hard-navigated to `/`, so chat → advocates was two taps through a screen you did not
want. One bar, fixed to the bottom, five tabs, nothing closes.

It is loaded by exactly five pages — `index`, `console`, `prs`, `monitor`, `admin`. That
is right for `doc`, `graph`, `session` (they are drawer contents, §1.4) and `login`.

It leaves out **Foundations** and **Terminal**, which are not drawer contents and not
modal — they are standing views, reached from two icon buttons in the inbox header. So
the hallway survives on exactly the two surfaces that the header still owns, and it is
worse there than it was anywhere else, because `foundations.html` carries *two* controls
that go to the same place in one header: a `‹` back at the left of the brand and an `✕`
at the right of the actions, both `href="/"`.

### 1.3 The two tab bars on one page

`monitor.html` draws the bottom bar *and* an in-page `.chip-row.tabs` with two chips
(Advocates | Mirror). Two rows of tabs on one screen meaning two different things: one
moves between pages, one swaps a pane. bc-3xb is the open bead about it and it has been
open since the day both landed in the same window.

### 1.4 The drawer, which is the one piece of navigation that is unambiguously right

`public/drawer.js` intercepts `/graph?`, `/doc?` and `/session?` links on the four
content pages and loads the real page into an iframe in a panel that slides in from the
right, pushing exactly one history entry so Android back and iOS back-swipe dismiss it.
The pages keep working standalone for a pasted URL. This is the correct shape for
detail-about-the-thing-you-tapped, and nothing below proposes touching it.

### 1.5 The counts, and where each one is drawn

`/api/questions` carries `summary: {sessions, proposals, questions}`.

- `questions` → the "N waiting" pill in the inbox brand space, which is also a shortcut
  to the `human` scope.
- `proposals` → a badge on the **Advocates** tab.
- `sessions` → nothing in the chrome; read on the Advocates page as "N working".
- `/api/prs` separately sets a badge on the **PRs** tab (open + owed).
- Foundation requests get their own `⚖️` badge in the inbox header.

So four numbers, three destinations, and one of them (`proposals`) counts beads that are
also inside the `questions` pill three inches to its left. §4.3 is about what that costs.

---

## 2. Defects found while inventorying

These are not verdicts. They are things that are wrong now.

### D1. The Foundations agent-detail screen is unreachable — `/api/foundation` GET is registered twice

`lib/server.js` registers `GET /api/foundation` at **line 1385** (the foundation
*channel*: `{requests, workspaces}`) and again at **line 2214** (one *agent* by id:
`{agent, workspace}`). Both sit at the same brace depth in one straight-line `if` chain,
so the first returns and the second is dead code.

`public/foundations.js:175` calls the route expecting the second one:

```js
const data = await api(`/api/foundation?${q}`);
state.agent = data.agent;      // undefined
…
$('#title').textContent = a.title;   // TypeError
```

Verified against a real server (`createApp` on a scratch port, one scratch workspace):

```
/api/foundation?id=advocate&workspace=demo
  -> 200 {"requests":[],"workspaces":["demo"]}
```

So tapping any agent on `/foundations` throws in `renderDetail()` after `#list` has
already been hidden — the list disappears and nothing replaces it. Four tabs
(Foundation, History, Chat, Activity), the amend flow, the per-agent chat and the
activity list are all behind that one call.

The test suite does not catch it because `scripts/queue-check.mjs:185` is a *fake*
server that answers `/api/foundation` with the payload the client wants. The fake is
right about the contract and the real server is wrong about it, which is the one
arrangement where a green suite means nothing.

This also disposes of an argument the review might otherwise have had to make about
whether Foundations deserves a tab. It has not been usable at all.

### D2. `bc-jin` landed and was never closed, and it is blocking three beads

`bc-jin` (launcher repo chips → tabs) is `IN_PROGRESS`. Its PR #1 merged — `bc-1wh`, the
merge question, is closed, and the code is in `main`: `public/console.html:36-52` has the
`repo-tabs` row, the `＋`, and the All-tab `#ws-pick` fallback; `public/console.js:243`
persists the selection to `localStorage`. Every line of its acceptance criteria is
satisfied.

It still `blocks` bc-2tr, bc-es8 and bc-dmt. Three beads are parked behind work that
shipped a day ago.

### D3. A re-delivery files a second merge card instead of reusing the first

There are two open beads in the tracker right now, `bc-a0vc` and `bc-t7wf`, with
identical titles — *"Merge #25? bc-ec6: The advocate's allowlist still has Bash(bd \*)"* —
and identical bodies, both saying #25 conflicts with main.

`bin/deliver.js` is careful to *reuse* the pull request on a second delivery ("finds the
one already open for the branch, which is the ordinary case on the second delivery after
changes were requested"). Its fallback path then unconditionally `bd create`s a new
question bead. So every retry of a delivery that cannot merge adds another card to your
inbox for the same merge, and answering one leaves the other sitting there looking
unanswered.

### D4. `.tabs` is defined twice in `style.css`, and each page is running with the other's values

`public/style.css:2727` (foundations' four tabs) and `public/style.css:3100` (the
monitor's two). Same selector, no page scoping, so the cascade mixes them: foundations
runs with the monitor's `z-index: 3` and `padding: 8px 14px`, and the monitor's tab row
inherits foundations' `margin: -18px -16px 14px` — a negative margin meant to bleed out
of a padded container, applied to a direct child of `body`.

This is bc-4aw, filed at P3 with "nothing looks broken today, which is exactly the
problem". Its line numbers (~1978, ~2351) are stale; the rules are at 2727 and 3100.

### D5. 17 of 49 `/api` paths are absent from the README's API table

Missing: `/api/admin`, `/api/deploy`, `/api/deploys`, `/api/dismiss`, `/api/filter`,
`/api/foundation`, `/api/foundation/amend`, `/api/foundation/decline`,
`/api/foundation/log`, `/api/foundations`, `/api/notifications/dismiss`,
`/api/pr/comment`, `/api/pr/merge`, `/api/pr/ship`, `/api/presence`, `/api/prs`,
`/api/session-say`.

That is not a sloppy row here and there — it is Admin, the whole PR board, the whole
Foundations screen and the inbox's filter, i.e. four surfaces documented nowhere. `/api/prs`,
`/api/admin`, `/api/filter`, `/api/dismiss` and `/api/foundations` appear **zero** times
in a 4,864-line README.

### D6. `GET /api/advocates` has no caller

`lib/server.js:2597`, commented "for anything that isn't the work page". Nothing is: the
only mention anywhere outside the handler is the README's own table row. Its payload
(`advocates.snapshot()`) is already inside `/api/work`.

### D7. The `pr-merged` bus event has no consumer

`lib/server.js:1503` emits it on every merge from the board. Nothing subscribes. An
inbox delivery card for a PR you merged on the PR board is not retired by it.

### D8. The in-app terminal does not work in the installed configuration

Not my finding — bc-sqlp, filed the day before this review, measured against a live
router: `bin/router.js` has no upgrade listener and `HOP_BY_HOP` strips `upgrade` and
`connection`, so `GET /ws/terminal` reaches the backend as an ordinary request and gets a
404. The terminal only works under `npm run start:bare`, which is not what launchd runs.

It matters to this review because the terminal holds a `⌨️` button in the inbox header —
prime real estate on the screen you open most — and behind that button, in the
configuration you actually run, is a 404.

---

## 3. Verdict per surface

### Inbox — **keep**, and take two things off its header

The premise of the app and the only screen that is genuinely load-bearing. Everything
about the card — the answered-before warning above the options, the optimistic write, the
scroll anchoring, three rows of filter chips coarsest-first — is the product of real use
and should not be touched by this rework.

The header is a different matter. It carries `⌨️` (terminal) and `⚖️` (foundations)
because both predate the bottom bar, and both are wrong there now: the terminal is the
least-used surface in the app *and* currently broken (D8), and Foundations is a standing
view that deserves a route in the bar rather than a glyph beside the refresh button.
bc-l8jp.2 already rules on the first half. §6 sequences the second.

### Chat — **keep**

`/console` is the only place work is *decided*, and the shape is right: a launcher that
filters by repo, a thread, and a proposal sheet that is explicitly the review step rather
than a confirmation over one. The three open beads on it (bc-2tr, bc-dmt, bc-es8) are all
refinements of the launcher, not arguments with it.

One thing to fix that is not on any bead: the page's `<h1>` says "Chat session", the tab
says "Chat", the agent id and every stored record say `console`, and the route is
`/console`. The route and the records should stay — they are in bookmarks and on disk, and
`lib/console.js` says so at the top. But the review should note that this is now three
names for one thing and only two of them are visible.

### PRs — **keep**

`lib/prboard.js` and `public/prs.js` are the best-argued pair of files in the repo: three
lamps that go true at three different times, three states per lamp because "nobody has
looked" is not "no", deployed meaning the running process rather than the newest commit,
and a deploy-in-flight strip above the board with four endings rather than two. It answers
the question the inbox's merge card cannot, because that card is gone the moment you
answer it.

### Advocates — **keep the page, move the proposal off it** (see §4.3)

The absorption of `/sessions` into this page was right and the five-paths-one-page
compatibility is right. What is wrong is that it is the second full implementation of the
proposal card (§4.3), and that its in-page tab bar makes it the only two-tab-bar screen in
the app.

### Mirror — **merge into Advocates, and say so out loud** (bc-3xb, ruled in §5)

Keep it as a pane. It is a *mode* of the advocates page — "show me what the phone has
open instead of what the Mac is running" — not a standing view, and it is the only surface
in the app that is meaningless on the device you would tap a bottom tab from. A sixth tab
would also push every label under the 72px that `tabbar.js:33-44` already calls tight,
and `style.css:3345` already has a `:has(.tab-item:nth-child(6))` rule shrinking the font
to 9.5px, which is a stylesheet quietly admitting the bar is full.

What has to go is the *ambiguity*: two tab bars stacked on one screen with no visual
distinction between "changes the page" and "changes a pane". Restyle the in-page pair as a
segmented control (which is what it is — two mutually exclusive modes) and scope its CSS,
which fixes D4 in the same edit.

### Admin — **keep, and give it the terminal**

A page whose whole job is "stop everything" should not be a block on a screen you scroll
past forty times a day, and the arming pattern on the destructive control is right. It is
also the natural home for the rarely-but-urgently-needed, which is exactly what the
terminal is. bc-l8jp.2 says so already.

### Foundations — **keep, fix D1, and put it on the bar**

It is the one screen that answers "what is this agent allowed to be", and the amendment
history behind it (`refs/beadcause/foundations`) is the whole audit trail for how agents
got their reach. That is not a candidate for deletion — but it has been throwing on every
detail open (D1), and it is reached by a glyph in another screen's header with two ways
back to that screen in its own.

Once D1 is fixed it wants a place in the bar. The bar has five tabs and no room for a
sixth. §6 proposes the trade.

### Terminal — **keep the route, delete the header button, and fix it or say it is broken**

Three facts sit badly together: it is the least-used surface (bc-l8jp.2's own words), it
holds a button on the busiest screen, and it 404s in the installed configuration (D8).

The verdict is not "delete" — a pty you can drive from a phone is genuinely the escape
hatch when a session needs a hand and you are not at the Mac, and `lib/terminal.js` +
`term.js` are 1,161 lines of working code that only the transport is wrong for. But the
order matters: take the button off the inbox now (bc-l8jp.2, already decided), and treat
bc-sqlp as the gate on it ever being promoted anywhere. A surface reached from Admin that
404s costs you one tap and a shrug; the same surface with a button on the inbox costs it
every time you glance at the header.

### Session detail — **keep**

`/session?pid=` gave the session a single address so that four different lists could stop
each having their own fold-open. It is a drawer page and it behaves like one. Nothing to
argue with.

### Graph and Document — **keep**

Both are detail-about-the-thing-you-tapped, both open in the drawer, both work standalone
for a pasted URL. The growing-graph and loupe decisions in `public/graph.js` are phone
constraints solved properly.

### Sign-in — **keep**

The one page that is never gated, and it gives an unauthenticated caller nothing but
whether sign-in is configured. Correct.

### `GET /api/advocates` — **delete** (D6)

One handler, no caller, payload already inside `/api/work`. Delete the handler and the
README row.

### The five paths of `/monitor` and the two of `/prs` — **keep all seven**

`/monitor`, `/advocates`, `/monitor.html`, `/sessions`, `/work`, `/work.html` and
`/prs`, `/pulls`. Every one is a rewrite line in `serveStatic` and a `paths` entry in
`tabbar.js`; together they cost about fifteen lines. They are on your phone's home screen
and in the Android shell's history, and a bookmark that 404s is worse than five paths for
one page. This is the one duplication in the app that is load-bearing.

---

## 4. The loop

### 4.1 As it runs

```
conversation        /console → an agent that cannot write to bd
      ↓             POST /api/console/create  ← the only writer
proposal            a `human` bead, rendered as a card with per-bead yes/no
      ↓             POST /api/respond {create: [1,3]}
beads               filed under bd
      ↓             an advocate surveys its repo's ready set every 30s
agent session       openWorkSession → iTerm + claude, named after the bead
      ↓             the worker runs bin/deliver.js
pull request        pushed, opened, checks awaited, merged at GitHub
      ↓             pushLanded → your phone, nothing to answer
deploy              cfg.deploys[<ws>] → POST /api/deploy, or Ship on the board
      ↓             pushDeploy → your phone
back to Adam
```

That loop closes, and it closes *towards you*: the three steps that need you — a proposal
to approve, a landing to know about, a deploy that ran — each push to the phone
(`pushQuestion`, `pushLanded`, `pushDeploy` in `lib/notify.js`). The steps that are silent
are silent on purpose: you were in the conversation, you filed the beads, and an advocate
opening a session on a bead you already approved needs nothing from you.

So the loop itself is in good shape. The problems are all at its edges.

### 4.2 Where you go looking rather than being brought

Notifications exist for: a question, a reply on a question, a foundation request, a
foundation reply, a landing, a deploy, a certificate. That is a good list. What is *not*
on it, and has to be gone and looked for:

1. **An advocate that has stopped making progress.** `lib/advocate.js`'s third rule is
   "every cap is loud" — and loud means "in the log and on the card". The card is on the
   Advocates page. A repo with nine ready beads and no free slot looks, from the phone,
   exactly like a repo with nothing to do. Nothing badges, nothing pushes.
2. **A pull request whose checks went red after it was opened.** `deliver.js` waits for
   checks and files a question if they fail *during* the delivery. A PR that goes red
   later, or a check that reports after the wait expired, is a lamp on a board you have
   to open.
3. **A hot-swap that did not take.** bc-6alb is already open for this: "surface hot-swap
   is not live on the phone, not only in the log and `swap:status`". A poisoned build
   serves stale code and looks healthy.
4. **A worker session that died mid-bead.** `reclaim` exists as a button on the advocate
   card; nothing tells you it is worth pressing.

All four are the same shape: the daemon knows, and the only place it says so is a screen
you have to think to open. The fix is not four more push notifications — that is how a
useful channel becomes one you mute. It is one thing: **the Advocates tab should carry a
badge when a repo is stuck**, the same way PRs carries one for owed ships. A badge is the
honest middle: it does not interrupt, and it means you never have to open a page to find
out whether opening it was worth it.

### 4.3 Where you answer the same thing twice

Twice literally, and twice structurally.

**Literally: two identical merge cards.** D3. `bc-a0vc` and `bc-t7wf` are in the inbox
right now, same PR, same question, both open.

**Structurally: the proposal card is implemented three times.**

| Where | File | What it offers |
|---|---|---|
| Inbox | `public/app.js:798-881` — `data-act="pick"`, `pick-all`, `pick-submit`, `picksFor` at :637 | per-bead yes/no, edit-in-place, approve/decline all, submit |
| Advocates | `public/monitor.js:417-465` — `data-pick`, `data-pick-all`, `data-submit`, `picksFor` at :150 | per-bead Create/Decline, All/None, submit |
| Mirror | `public/mirror.js:283-299` | read-only, plus *"Per-bead buttons live on the Advocates tab"* |

Three renderers, two independent `picksFor` stores, both POSTing `/api/respond` with
`create` indices, and no shared code between them. The picks you make in one are invisible
in the other. The third one names only one of the other two — a phone reading the mirror is
told the buttons are on Advocates, and never told they are also on the card three inches
into the inbox it just came from.

Add the `proposals` badge on the Advocates tab (§1.5) to that, and the app is actively
pointing you at the *second* implementation of a decision the first one already offers.

**This is the single biggest duplication in the app and the one this rework most needs to
resolve.** My recommendation, and the plan in §6 assumes it unless you say otherwise:
extract the proposal card into one shared module (`public/proposal.js`, loaded like
`absorb.js` and `sendqueue.js` already are — this app already has the pattern for shared
front-end behaviour and uses it twice), render it from that one module in all three places,
and drop `summary.proposals` from the Advocates badge in favour of the inbox pill it is
already inside.

The alternative — delete the Advocates copy outright and make a proposal answerable only
on the inbox — is cleaner and I do not recommend it. The Advocates rendering exists
because a proposal is *about that repo's queue*, and reading it beside the advocate that
asked, with that repo's ready set and its last survey next to it, is a genuinely better
place to judge it from. Two good places to answer, one implementation.

### 4.4 What the system knows and does not say

Three smaller ones, all cheap:

- **`GET /api/work` knows which sessions are in no configured workspace** (`elsewhere`) and
  the Advocates page draws them. Nothing else in the app mentions them.
- **A delivery card knows its PR's live mergeability** (`/api/pr`) but not that the PR was
  merged from the board since (D7 — the `pr-merged` event nobody consumes).
- **`summary.sessions` is served on every inbox poll and drawn nowhere in the chrome.** The
  comment at `app.js:2064` argues this deliberately: a running agent needs nothing from
  you, so it does not deserve a badge. That reasoning is right. The number should probably
  stop being computed on the inbox's poll at all, then — `liveSessions()` is a readdir per
  poll for a number only the Advocates page reads, and the Advocates page fetches
  `/api/work` anyway.

---

## 5. Rulings on the open UI beads

So none is silently orphaned.

**bc-jin** — *Turn the launcher's repo chips into tabs* — **close it as done.** D2: the
code is in `main`, every acceptance line is met, PR #1 merged. It is `IN_PROGRESS` and
blocking three beads for no reason. This is step 1 of the plan because it is free and it
unblocks three others.

**bc-2tr** — *A tab per opened chat, with a permanent All tab* — **keep as-is, unblocked
by closing bc-jin.** It is a well-specified refinement of a launcher this review endorses
and it does not interact with anything else here. One note for whoever takes it: it and
bc-dmt overlap heavily — a tab per open chat and holding several chats open without a
reload are close to the same feature seen from two ends — and they should be read together
before either starts.

**bc-3xb** — *Mirror as a fifth bottom tab, or a pane* — **decided: a pane.** §3 gives the
reasons (the mirror is a mode, not a destination; it is meaningless on a phone, which is
where a bottom tab is tapped; the bar is full and the stylesheet already admits it at
`style.css:3345`). Supersede the *decision* and refile the *work* it implies, which is not
what the bead currently describes: restyle the in-page pair as a segmented control so two
tab bars on one screen stop looking like one thing, and scope its CSS while you are there.
That last part is bc-4aw, so the two should be one bead.

**bc-es8** — *Hide closed sessions behind a "show dismissed" toggle* — **keep as-is,
unblocked by closing bc-jin.** Straightforwardly right; nothing in this review changes it.

**bc-6np** — *Change the inbox's chat icon from 🧾 to 💬* — **supersede.** The bead is
stale in the way that matters: it names `public/index.html:29` as the thing to change, and
there is no chat entry in the inbox header any more — it moved to the bottom bar when
`tabbar.js` landed. The glyph is now `tabbar.js:47`, where 🧾 sits under the label
"Chat". The complaint is still correct (a receipt is the proposal, not the conversation)
and the trap it records about U+2328 is still worth keeping, so refile it against
`tabbar.js` rather than closing it. It also needs one thing the original could not know:
the tab badge hangs off that icon, so whatever replaces 🧾 has to still read correctly with
a number on its corner.

**bc-4aw** — *Two `.tabs` rules* — **fold into the bc-3xb work.** It is D4 and it is real,
but it is one CSS edit inside the change that restyles the monitor's bar anyway, and doing
it separately means touching the same two blocks twice. Its stated acceptance — "neither
page's rendering changes as part of the fix" — needs relaxing if it is folded in, because
the bc-3xb work changes the monitor's rendering on purpose.

**bc-dmt** — *Hold several chat sessions open at once* — not on the epic's list, but it is
blocked by bc-jin and it is a launcher bead, so: **keep, and read it with bc-2tr.**

---

## 6. The plan

Sequenced. Each numbered step is one bead's worth of work. The first three are defects
and should go first regardless of what you think of the rest.

**1. Close bc-jin.** No code. It shipped (D2) and it is blocking bc-2tr, bc-es8 and
bc-dmt. *(Not a bead — a `bd close`.)*

**2. Fix D1: give the two `GET /api/foundation` handlers different paths, and test the
real server.** The channel is the older, broader route and the agent detail is the
narrower one, so the agent detail should move: `GET /api/foundation/agent?id=` (or fold it
into `/api/foundations?id=`). Whichever way, the test that matters is against `createApp`,
not against a fake — `scripts/queue-check.mjs` currently asserts the contract the real
server does not honour, and it is the reason this survived. Add a route-collision guard
while you are there: a startup assertion that no `(method, path)` pair is registered twice
would have caught this at boot.

**3. Fix D3: make a re-delivery reuse its open merge card.** `bin/deliver.js` already
finds the existing PR for the branch; the fallback path should likewise look for an open
`delivery`-labelled bead naming that PR and comment on it rather than `bd create` a
second. Then reconcile the two that exist (`bc-a0vc`, `bc-t7wf`) by hand.

**4. bc-l8jp.2 — terminal off the inbox header, onto Admin.** Already decided, already
filed, unaffected by anything above. Independent of everything else here, so it can go in
parallel.

**5. One proposal card, rendered in three places.** §4.3. Extract `public/app.js`'s
proposal rendering and pick-state into a shared module on the `window.beadcause` namespace
the app already uses for `tabBadge`, `absorb` and `sendqueue`; render it from `app.js`,
`monitor.js` and `mirror.js`; delete `monitor.js`'s duplicate `picksFor` and
`proposalHtml`; give the mirror the real buttons instead of a sentence pointing at one of
the two screens that has them. **This is the biggest single win in the rework and the one
step I would not cut.**

**6. Drop the `proposals` badge from the Advocates tab.** Follows step 5: once a proposal
is answerable in the same form wherever you meet it, a badge sending you to the second
place for a bead the inbox pill already counts is one number too many. Fold `summary` down
to what is drawn (§4.4) and stop the per-poll `liveSessions()` readdir for a count nobody
reads there.

**7. bc-3xb + bc-4aw as one bead: the monitor's in-page tabs become a segmented control,
and `.tabs` gets scoped.** §5. Two tab bars on one screen stop being ambiguous, and D4
goes with it.

**8. Foundations gets a place in the bar, and the inbox header gives up its last glyph.**
After step 2, because promoting a screen that throws on open is worse than leaving it
where it is. The bar has five tabs and `style.css:3345` already shrinks the labels at six,
so this is a trade, not an addition, and it is the one decision in this plan I do not think
should be made without you. Three ways, in the order I would pick them:
  - **a.** Foundations replaces Admin on the bar; Admin moves behind Foundations, on the
    grounds that "what is each agent allowed to be" is read more often than "stop
    everything" and Admin is already the page you go to deliberately.
  - **b.** Foundations replaces nothing and stays a header glyph, but gets the bottom bar
    on its own page and loses the duplicate `‹`/`✕`. Cheapest, fixes the hallway, leaves
    the bar alone.
  - **c.** Six tabs, and accept the 9.5px labels the stylesheet is already prepared for.
  I would do **(b)** now and let (a) wait until Foundations has been usable long enough for
  you to know how often you open it — which, given D1, nobody knows yet.

**9. Housekeeping the review turned up, one bead:** delete `GET /api/advocates` and its
README row (D6); delete the `pr-merged` emit or give it the consumer that retires a stale
delivery card (D7); refile bc-6np against `tabbar.js:47` (§5); bring the README's API table
up to 49 paths (D5).

**10. bc-2tr, bc-es8 and bc-dmt, read together, after step 1 unblocks them.** All three are
launcher work and all three are unaffected by this rework. bc-2tr and bc-dmt should be
scoped against each other before either is started.

### What this plan deliberately does not do

- **It deletes almost nothing.** One endpoint (D6), one dead emit (D7), one duplicate
  renderer (step 5). The epic put deletion on the table and I went looking for it: the
  five paths of `/monitor` are the only real redundancy left and they are load-bearing,
  and every page in `public/` answers a question no other page does. The duplication in
  this app is not in its surfaces. It is in the *code behind* two of them and in the *chrome
  pointing at* them.
- **It does not touch the inbox card, the drawer, or the PR board.** Those three are the
  parts of the app that have been argued out properly already.
- **It does not fix bc-sqlp** (the terminal's WebSocket, D8). That is a transport bug with
  its own bead, and step 4 makes the terminal's UX correct whether or not it is ever
  fixed.
