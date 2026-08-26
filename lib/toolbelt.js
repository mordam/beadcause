/**
 * The read-only surface every reply agent gets — the list, and nothing else.
 *
 * This is one array and one string derived from it, and it has a file to itself for
 * a reason that has nothing to do with size. It is read by **both** halves of a pair
 * that import each other: `lib/agents.js` owns the roster and exports the list as
 * part of it, and `lib/foundation.js` records the same list as the dispatch agent's
 * baseline (`allowedTools`) so that an amendment has something to land on. Two copies
 * of an allowlist is one copy that gets widened without the other noticing, so it is
 * quoted rather than repeated — and that quote used to be the import that made
 * `lib/agents.js` unloadable.
 *
 * The failure it removes (bc-u4na): `foundation.js` read `DEFAULT_TOOL_LIST` from
 * `agents.js` at **module scope**, and `agents.js` imports `baseline` and `mark` back.
 * A cycle is not itself a problem in ESM — `lib/owner.js` and `lib/config.js` are one,
 * happily — but a cycle where one side *uses* the other's binding while that side is
 * still evaluating is, because the binding is in its temporal dead zone. So whichever
 * module the graph entered first decided whether the pair loaded at all:
 * `foundation.js` first worked, `agents.js` first threw `Cannot access
 * 'DEFAULT_TOOL_LIST' before initialization`.
 *
 * Nothing was ever broken in the running daemon — every real entry point happened to
 * reach `foundation.js` first — and that is exactly what made it expensive. It was a
 * trap rather than a bug: nine test suites opened with an otherwise-pointless
 * `await import('lib/foundation.js')` to force the order, the next module to import
 * the roster paid twenty minutes rediscovering why, and the error named a constant
 * rather than a cycle.
 *
 * A third module both sides import is the whole fix. `foundation.js` no longer
 * imports `agents.js` at all, so the cycle is gone rather than merely survivable, and
 * `test/loadorder.mjs` imports every `lib/` module first, on its own, so the next one
 * that reintroduces this fails a test instead of a daemon at boot.
 *
 * Callers do not need to know any of that: `lib/agents.js` re-exports both names, and
 * importing them from there is still correct.
 *
 * @manifest
 *
 * This file is data — one array and one string joined from it, no imports, no functions —
 * and the tag above is what tells `lib/affected.js` not to propagate an `imports it` edge
 * out of it. It is here because being imported by `agents.js` and `foundation.js` put
 * this file underneath nearly every suite in the repo: adding a b7e tool selected **205
 * suites**, 196 of them for no reason but the edge, and that one line is why a narrowed
 * gate cost a median 30% of the full suite rather than 2% (bc-xlz32.7).
 *
 * What still selects a suite is naming something here — `DEFAULT_TOOL_LIST`,
 * `DEFAULT_TOOLS`, or this file's path. So **if you add a consumer that depends on what
 * is in this list rather than merely on there being a list, its suite must say one of
 * those names out loud**, or it will not run until the gate. `lib/affected.js` refuses
 * the tag to any file that imports something or declares a function, so the moment this
 * file stops being data it stops being a manifest and the edge comes back.
 */

/**
 * The read-only surface every reply agent gets.
 *
 * The `bd` verbs are named one at a time rather than globbed, and the notes below say
 * which hole each one closed. This is the *baseline*, not the effective foundation:
 * resolving an amendment is a git read, so this is the fallback the dispatcher uses
 * when the effective one cannot be read, and the string the phone is shown.
 */
export const DEFAULT_TOOL_LIST = [
  'Bash(bd show:*)',
  'Bash(bd comments:*)',
  'Bash(bd comment:*)',
  'Bash(bd list:*)',
  'Bash(bd ready:*)',
  'Bash(bd blocked:*)',
  'Bash(bd search:*)',
  'Bash(bd stats:*)',
  'Bash(bd memories:*)',
  // `bd dep tree`, not `bd dep:*` (bc-1f99). `dep` is not a read: it carries `add`,
  // `remove`, `relate` and `unrelate`, and `bd dep <id> --blocks <id>` is a fifth
  // spelling of `add` on the bare verb — so the glob one level up let a comment
  // answered from a phone rewire the dependency graph, which is the arrangement the
  // rest of this list was expanded verb-by-verb to get off. Same shape of hole
  // bc-ec6 closed on the advocate, one agent down; that agent and the chat session
  // already name `tree` and nothing wider. If a reply agent ever wants the flat
  // `bd dep list`, that is an amendment to ask for, not a glob to take.
  'Bash(bd dep tree:*)',
  // The one write on this list, and it writes nowhere near the tracker: an agent's
  // own memory and the blackboard it shares with the others (lib/memory.js). It is
  // here rather than behind an elevation because the alternative is an agent that
  // can be told something and cannot keep it — the whole of what Tier 2 is for.
  'Bash(beadcause-memory:*)',
  'Read',
  'Grep',
  'Glob',
  // Looking something up, in the three shapes it takes — added deliberately (bc-awr),
  // because an agent that answers "I cannot look things up" to a question turning on
  // one external fact has given a true answer and a useless one.
  //
  // `WebSearch` and `WebFetch` are the preferable grant and are read-only by
  // construction: an agent can pull a page and cite it and cannot POST anywhere.
  // `beadcause-get` is the wrapper for what WebFetch mangles on its way to prose —
  // JSON, CSV, a raw table. It is here instead of `Bash(curl:*)` because that pattern
  // matches `-X POST`, `-d`, `--upload-file` and `-o` writing anywhere on disk, and
  // because curl reads `file://`. See lib/lookup.js for the whole argument; the short
  // version is that the agent may name a URL and may not name a method.
  'WebSearch',
  'WebFetch',
  'Bash(beadcause-get:*)',
  // The fourth shape, and the narrowest reading of a very wide capability (bc-8yw,
  // implementing the ruling on bc-awr). A page that assembles itself in the browser
  // reads as empty to all three above, and an agent cannot tell that answer from a page
  // that genuinely says nothing. So: a headless Chrome with a throwaway `--user-data-dir`
  // per run — no cookies, no sessions, no extensions, no identity — and never the
  // claude-in-chrome MCP tools, which drive the browser Adam is signed into and whose
  // per-site prompt has nobody present to answer it. The wrapper is what keeps those two
  // things different: it navigates and reads, and there is no flag through which an
  // agent can click, type, submit, log in or run JavaScript of its own. See lib/browse.js.
  'Bash(beadcause-browse:*)',
  // The fifth shape, and the first one that is not a public URL (bc-xecw). Much of
  // what a question turns on is written down on the team's wiki rather than in the
  // repo, and to all four grants above a Confluence page behind a login is a login
  // screen — an agent cannot tell that from a page that says nothing.
  //
  // It is a wider grant than those four and it is worth being plain about why it is
  // still narrow enough to sit beside them. They read as *nobody*; this carries the
  // install's Atlassian API token, so it reads as Adam. What bounds it is not the
  // wrapper alone but `confluence.readSpaces`, which is **empty until somebody writes
  // it**: an install that publishes to Confluence happily still reads nothing, and one
  // that never configured Confluence at all gets a refusal rather than a wiki. So the
  // entry costs an install that never wanted this exactly nothing, and an install that
  // did has named the readable spaces one at a time — the same shape as expanding `bd`
  // verb by verb rather than taking the glob. There is no path through the wrapper
  // that writes a page, comments, searches the site, lists a space or fetches an
  // attachment. See lib/confluence.js.
  'Bash(beadcause-confluence:*)',
  // Read-only by construction — it only ever runs `fs.readdirSync`/`readFileSync`
  // over lib/, bin/, public/, scripts/ and test/, and prints what it found. bc-khoe.27.5
  // is the whole argument: an agent that cannot look up where a symbol is defined
  // reaches for `grep`+`sed` instead, and several sessions broke doing that by hand
  // against files too big to read (lib/server.js, public/app.js). See bin/b7e-def.
  'Bash(b7e-def:*)',
  // Read-only in exactly the same construction as b7e-def just above: it parses every
  // file in lib/, bin/ and scripts/ with lib/noundef.js's own acorn/eslint-scope
  // pipeline and prints what it finds — no `bd`, no `git`, no subprocess, and the one
  // thing it writes to is stdout. bc-ka5y.30 is the session audit — four sessions each
  // answered "where is this exported from, is it already imported, would it collide,
  // would it cycle" with four to six greps apiece, one of them chasing twelve false
  // positives out of a `heldBy`/`held` substring match a real identifier reference
  // cannot produce. See bin/b7e-import and lib/imports.js.
  'Bash(b7e-import:*)',
  // Also read-only, in the same sense lib/evidence.js's own coverage check is: it
  // imports lib/config.js and lib/advocate.js to see what they default, but under a
  // throwaway `BEADCAUSE_CONFIG_DIR` it creates and deletes around the call, so it
  // never touches the real `~/.config/beadcause` and never writes into the repo.
  // bc-khoe.27.7 is the argument — four sessions each hand-rediscovered the same
  // handful of registries a new route, page, module or config key incurs debt in.
  // See bin/b7e-owes.js.
  'Bash(b7e-owes:*)',
  // Read-only by construction too, and a sharper case than b7e-def/b7e-owes above: it
  // never runs a suite, it only reads `git diff` and the text of bin/, lib/, public/,
  // scripts/ and test/ to say which suites *would* cover a diff. bc-khoe.40 is the
  // argument — eight sessions each hand-wrote the same grep to answer that question
  // before running anything. Unlike b7e-gate just below, this never spawns a daemon,
  // binds a port or runs a test; it is exactly the shape b7e-def and b7e-owes already
  // are, not a lighter version of `npm test`. See bin/b7e-affected.
  'Bash(b7e-affected:*)',
  // Read-only in the same sense, and its one write-shaped-looking step is already covered:
  // `Bash(bd show:*)` is on this list two lines above, and the single `bd show <id> --json`
  // this shells out to is exactly that grant with no wider surface — it never claims, labels
  // or comments. bc-khoe.43 is the argument — eleven sessions guessed a `beadcause-memory`
  // key by hand rather than asking for it, 58 calls between them. See bin/b7e-notes.
  'Bash(b7e-notes:*)',
  // Read-only in exactly the same sense: it only ever reads README.md, computed once per
  // call, and prints where a term or file path is documented. bc-khoe.46 is the argument
  // — six sessions each hand-wrote four to ten greps against a 24,700-line file to answer
  // "which section, what line range, what anchor slug", one of them losing a whole call
  // to shell quoting along the way. See bin/b7e-readme and lib/readme.js.
  'Bash(b7e-readme:*)',
  // Read-only in the same construction sense — the only thing it can reach `bd` with is
  // a fixed allowlist of read verbs (show, comments, list, ready, search), forwarded
  // as-is; anything else is refused before a workspace is even resolved. bc-bmry.10 is
  // the argument — three sessions each hand-rolled `cd ~/beads/<name> && zsh -c 'bd
  // …'` to read a workspace other than the daemon's own, one of them getting the wrong
  // graph entirely because the shell's own cwd resolution picked a different `.beads`
  // than the name implied. See bin/b7e-ws.
  'Bash(b7e-ws:*)',
  // Read-only in the same sense as b7e-def/b7e-owes/b7e-affected above: it runs `git
  // worktree list`, `git diff`/`git log` against refs and a shared checkout's own
  // `~/.claude/sessions/*.json`, and writes nothing anywhere — not even the `bd show` it
  // makes for `--bead` touches the tracker. bc-bmry.11 is the argument — four sessions
  // each hand-rolled the same survey of which other worktree already holds a file, one of
  // them paying for skipping it with a mid-session module rename. See bin/b7e-siblings
  // and lib/siblings.js.
  'Bash(b7e-siblings:*)',
  // Read-only in the same sense as b7e-siblings just above — every call it makes is a
  // `git fetch` (never pushes, never writes a ref) followed by `rev-parse`/`rev-list`/
  // `merge-base`/`diff --name-only`, none of which touch the working tree or the index.
  // bc-36xx.25 is the argument — nine sessions each hand-rolled "am I current with
  // main" in five different shapes, seven of them comparing against a ref nobody had
  // fetched, one of them (bc-bmry.8) reading local `main` as if it were `origin/main`
  // and calling a stale branch "up to date". See bin/b7e-base and lib/gitref.js.
  'Bash(b7e-base:*)',
  // Read-only by construction in the same way b7e-def/b7e-owes/b7e-affected/b7e-readme
  // are: it runs exactly one `bd` verb, `export`, and only ever reads the result — there
  // is no argv path through it that reaches a write verb at all. bc-bmry.12 is the
  // argument — three sessions (bc-bmry.2, bc-bmry.5, bc-xl7n.98) each hand-rolled the
  // same "which beads carry a label or an edge" question a different way, one of them
  // via three separate python3 heredocs over a saved export. See bin/b7e-census and
  // lib/census.js.
  'Bash(b7e-census:*)',
  // Read-only in the same construction sense as b7e-def/b7e-owes/b7e-affected/b7e-census
  // above: the only subprocess it ever spawns is `git grep` at a fixed ref (a tree
  // object, never `--no-index`), and the only `bd`-adjacent thing it touches is
  // `lib/session.js`'s `resolveSessionDir` to turn a `-w <workspace>` name into a
  // checkout path — a read, not a call to `bd` at all. bc-dgx7.59 is the argument: four
  // sessions (dv-i5v, dv-5i2.44, dv-nnk, dv-6cn) each hand-rolled a different occurrence
  // count for the same literal and got different numbers back — a `git grep -lI | wc -l`
  // pipeline, a `while read`+`awk` loop, a `scratchpad/count.py`, a `grep --include=*.md`
  // rejected by zsh globbing before it ran — at least two of which disagreed on the same
  // tree. See bin/b7e-count and lib/count.js.
  'Bash(b7e-count:*)',
  // Read-only in the same construction sense as b7e-def/b7e-siblings/b7e-census above:
  // its own file walk never touches anything outside lib/bin/test/scripts/public/android
  // and README.md, and the one `bd` verb it spawns is a single batched `show` for every
  // id it found — never a write. bc-4r10.22 is the argument: four sessions each found a
  // stale bead citation ("bc-228x has not settled...", written after bc-228x had closed)
  // by accident, while looking for something else, and none of them swept for the rest.
  // See bin/b7e-cites and lib/cites.js.
  'Bash(b7e-cites:*)',
  // Read-only in the same construction sense as b7e-cites/b7e-census above: it spawns
  // only `bd show --include-comments` and `bd list --label <app-error>`, reads
  // `~/Library/Logs/beadcause.log` and `~/.config/beadcause/deploys` (or a fixture
  // named with `--log`/`--deploys`) by streaming rather than buffering whole, and runs
  // one read-only `git log`. bc-dgx7.55 is the argument — three auto-filed `app-error`
  // beads, three sessions, each hand-joining the same four sources ("what else was this
  // machine doing at this created_at") a different way, none of it reusable by the
  // next. See bin/b7e-moment and lib/moment.js.
  'Bash(b7e-moment:*)',
  // Read-only in the same construction sense as b7e-siblings/b7e-census just above: it
  // spawns exactly three `bd` verbs — `show`, `export`, `comments` — all reads, and never
  // writes anything of its own. bc-zjab.9 is the argument — nine sessions each opened by
  // hand-assembling the same four questions (the bead and its thread, its parent epic and
  // siblings, its epic's plan group, what earlier runs left) in nine different orders,
  // with nine of twelve independently rediscovering that this repo has no `CLAUDE.md`.
  // See bin/b7e-orient.
  'Bash(b7e-orient:*)',
  // Read-only in the same construction sense as b7e-orient just above: it spawns `bd
  // show`, and everything else is `git`/`gh` reads — no push, no merge, no write of any
  // kind. bc-zjab.10 is the argument — four sessions independently hand-built "has
  // somebody already done this" out of six or more `git`/`gh` calls each, one of them
  // spending most of a session on it before concluding a prior attempt had already
  // written the whole change. See bin/b7e-prior and lib/prior.js.
  'Bash(b7e-prior:*)',
  // Read-only in the same construction sense as b7e-prior just above: it spawns `bd
  // show` and `bd export`, and everything else is `git log`/`git diff`/`git merge-base`
  // reads — no push, no merge, no write of any kind. bc-dgx7.64 is the argument — four
  // sessions each needed what an earlier sibling bead had already committed, as a
  // template, and each rebuilt the search out of `git log --oneline --all | grep`,
  // guessing the wrong sibling first at least twice. See bin/b7e-precedent and
  // lib/precedent.js.
  'Bash(b7e-precedent:*)',
  // The plainest read on this list: b7e-harness spawns nothing at all. It reads `test/*.mjs`
  // and `public/app.js` off disk, computes the majority shape of a suite from them, and
  // prints it — no `bd`, no `git`, no subprocess, and nothing written anywhere but stdout.
  // bc-zjab.11 is the argument: six sessions wrote a suite here and all six began by opening
  // a different neighbouring suite to copy its preamble, between two and five reads each,
  // for a convention that is written down nowhere. See bin/b7e-harness and lib/harness.js.
  'Bash(b7e-harness:*)',
  // As plain as b7e-harness just above: it reads test/*.mjs and one lib/ module off disk,
  // computes which local names hold that module's output, and prints where test/*.mjs pins
  // a string or regex literal against one of them — no subprocess, nothing written anywhere
  // but stdout. bc-khoe.27.12 is the audit: three sessions each edited a generated brief by
  // hand and learned which words were load-bearing by breaking one and reading the failure —
  // a guessed grep that still shipped a red, a count baked into a regex nobody remembered
  // was there. See bin/b7e-pinned and lib/pinned.js.
  'Bash(b7e-pinned:*)',
  // Read-only in the same construction sense as b7e-def/b7e-owes/b7e-affected/b7e-readme
  // above: it reads README.md and this repo's own memory store (a fixed set of standing
  // notes keys, quoted verbatim) and prints a brief — the "read this repo's CLAUDE.md"
  // instruction has no target here, and this is what an agent gets instead. It shells out
  // to `node scripts/test.mjs --list` for a live suite count, and only ever `--list` —
  // that flag's own header comment guarantees it "creates nothing", unlike b7e-gate below,
  // which actually runs the suites and is deliberately not on this list. bc-ka5y.15.15 is
  // the session audit: eight sessions each burned a call discovering there is no CLAUDE.md
  // here, no two the same way. See bin/b7e-brief.
  'Bash(b7e-brief:*)',
  // Read-only in the same construction sense as b7e-def/b7e-owes/b7e-brief above: it reads
  // the two memory-store tiers that live per-agent (`beadcause-memory recall`/`notes`) and,
  // given `-b`, the debrief entries for that bead's family (`beadcause-memory debriefs`) —
  // three reads, no `bd` write, nothing under a checkout ever touched. bc-xl7n.112 is the
  // argument: three sessions (bc-xl7n.83, bc-ywiy, bc-khoe.18) each checked by hand whether
  // an insight was already on file before writing it down, no two the same way, and one of
  // them searched the *personal* memory directory instead of any of beadcause's own stores.
  // See bin/b7e-known and lib/memory.js's `nearestEntries`.
  'Bash(b7e-known:*)',
  // Read-only in the sense that matters here, even though it writes: `git merge-tree
  // --write-tree` never touches a working tree or an index, only the object database —
  // the same shape lib/gitref.js's `hashObject`/`commitToRef` already write session refs
  // through without a checkout ever happening, and unlike b7e-gate/b7e-blame below it
  // spawns nothing long-running (a handful of bounded `git` calls). `--tree` extracts a
  // merge under `os.tmpdir()`, the same scratch-directory shape `lib/blame.js`'s
  // `makeMainWorktree` already uses for a granted read tool. bc-dgx7.52 is the audit:
  // three sessions on 2026-08-24 resolved "does this merge?" three different ways — a
  // full hand-resolve with `git merge-tree`/`sed` inside the branch about to be
  // delivered, an after-the-fact check that never simulated the merge, and a claim
  // refusal re-issued and ignored twice. See bin/b7e-premerge and lib/premerge.js.
  'Bash(b7e-premerge:*)',
  // Read-only in the same construction sense as b7e-def/b7e-owes/b7e-affected above: it
  // only ever calls `fs.readdirSync`/`readFileSync`/`statSync` over package.json,
  // package-lock.json, README.md, lib/toolbelt.js, lib/grants.js and test/, and prints
  // what a bin/ command still owes. bc-khoe.27.11 is the argument — six sessions each
  // hand-rediscovered the same seven registries a new bin/ entry incurs debt in, one
  // of them (bc-khoe.27.6) paying for the gap with a full parallel-gate run. See
  // bin/b7e-enroll.
  'Bash(b7e-enroll:*)',
  // Read-only in the same construction sense as b7e-def/b7e-owes/b7e-affected/b7e-readme
  // above, and unlike b7e-gate/b7e-watch/b7e-blame just below: it never runs a suite and
  // never calls runBlame, so it never touches the "run the tests" write lib/grants.js
  // already classifies. The whole comparison is a read of a run's own already-written
  // JSONL record (lib/gaterun.js's readRun) plus two git plumbing reads with no
  // working-tree or index side effects (`git stash create`, `git diff --name-only`)
  // against whatever is on disk right now. bc-dgx7.39 is the argument — four sessions
  // each launched b7e-gate in the background, kept editing the worktree while it ran,
  // and delivered the run's verdict as though it still described the tree; one caught
  // its own case only by remembering an edit made after the gate had already started.
  // See bin/b7e-gated and lib/gaterun.js's compareToTree.
  'Bash(b7e-gated:*)',
  // Read-only in the same construction sense as b7e-def/b7e-siblings/b7e-cites above:
  // every path through it is `git for-each-ref` and `git cat-file -p <ref>:<file>`
  // (lib/gitref.js's readRefFile) against whatever this Mac's local git object store
  // already has — no fetch, no checkout, no write to the file it scans or anywhere
  // else. bc-dgx7.61 is the argument — six sessions each allocated a CHANGE_LOG.md
  // entry number by hand, one of them colliding with a decision already live on
  // another branch it never looked at, four more declining to file an entry at all
  // rather than pay the collision-risk-and-ledger-remeasure cost by hand. See
  // bin/b7e-entry and lib/changelog.js.
  'Bash(b7e-entry:*)',
  // Read-only in the same construction sense as b7e-entry just above: every path
  // through it is `git cat-file -p <ref>:<path>` (lib/gitref.js's readRefFile)
  // against whatever this Mac's git object store already has — no fetch, no
  // checkout, no write to CHANGE_LOG.md or anywhere else. bc-dgx7.82 is the
  // argument — four sessions (dv-b5d.32, dv-2uu.5, dv-gr6.5, dv-5eu) each
  // independently found an entry stamped [PROPAGATED] whose own checklist named a
  // file as done while that file still carried the pre-ruling value. See
  // bin/b7e-propagated and lib/propagated.js.
  'Bash(b7e-propagated:*)',
  // Read-only in the same construction sense as b7e-gated just above, and for the same
  // reason: it never runs a suite and never builds a `git worktree`, unlike b7e-gate/
  // b7e-watch/b7e-blame/b7e-triage. Every path through it is a filesystem read of an
  // already-written `.claude/gate-runs` JSONL record (lib/gaterun.js's readRun), a
  // handful of bounded `git` plumbing calls (`rev-parse`, `merge-base`, `log --
  // <path>`), and a `bd search`. bc-dgx7.62 is the argument — six sessions on
  // 2026-08-24 each spent five to forty minutes deciding by hand whether a red suite
  // was already known and already fixed on origin/main, one of them by moving a live
  // locked worktree's HEAD to prove a point. See bin/b7e-stillred and lib/stillred.js.
  'Bash(b7e-stillred:*)',
  // b7e-gate (bc-khoe.39) is also deliberately NOT on this list, for a sharper version of
  // the b7e-apply argument below: lib/grants.js already classifies `Bash(npm test:*)` —
  // running this repo's own suites, which spawn daemons and bind ports — as a write, held
  // by merge-advocate alone. b7e-gate does exactly that, concurrently, for up to fifty
  // minutes; it is a heavier capability than npm test, not a lighter one, and this list
  // reaches only `dispatch`, which has no more use for the whole suite passing than it
  // does for anything else past its own single `bd comment`. See bin/b7e-gate.
  // b7e-shipgate (bc-xlz32.2) is deliberately NOT on this list either, for exactly the
  // b7e-gate reason just above: it is b7e-affected piped into b7e-gate --only, so every
  // run it does is still `Bash(npm test:*)`-shaped underneath, only narrower. See
  // bin/b7e-shipgate.
  // b7e-apply (bc-khoe.27.6) is deliberately NOT on this list. This is "the read-only
  // surface every reply agent gets" and its one consumer is `dispatch` (lib/foundation.js)
  // — a single turn that answers a phone comment with a `bd comment` and exits, with no
  // git tools, no branch of its own and no oversight loop. b7e-apply writes to whatever
  // checkout it is run in; granting it here would let a one-shot comment-answerer edit
  // the tracked tree of a repo it does not own mid-session, with no path to commit or
  // review the result. test/grants.mjs is what catches an addition like this — it fails
  // an unclassified grant on sight — and the classification that belongs in lib/grants.js
  // for a live grant is not the right answer to that failure here; not granting it is.
  // b7e-worktree (bc-khoe.41) is also deliberately NOT on this list, and the argument is
  // narrower than "it writes": its whole occasion is a worktree `EnterWorktree` just
  // created, and only `worker` foundations ever call that. `worker`'s `allowedTools` is
  // `null` — the CLI default, unrestricted — so a grant here would widen nothing a worker
  // can already reach. `dispatch`, the one agent this list actually governs, has
  // `ownsRepo: false` and no branch of its own; it never creates a worktree to run this
  // command in, so the grant would sit here unused. See bin/b7e-worktree.
  // b7e-eyeball (bc-khoe.45) is deliberately NOT on this list, on the same reading as
  // b7e-gate: it launches a headless Chrome, binds a port and writes PNGs to disk, which is
  // the shape lib/grants.js already calls a write on the strength of "nothing about run the
  // tests is a read". It is also pointless here — `dispatch` answers one phone comment with
  // one `bd comment` and has no page of its own to look at, no branch, and nothing to
  // compare a screenshot against. Its occasion is a worker session with a diff in front of
  // it, and `worker`'s tool list is the unrestricted CLI default, so a grant here would
  // widen nothing that agent cannot already reach. See bin/b7e-eyeball and lib/eyeball.js.
  // b7e-blame (bc-khoe.42) is deliberately NOT on this list either, for the same reason
  // as b7e-gate above rather than the read-only shape of b7e-def/b7e-owes/b7e-affected:
  // it runs a suite, twice, exactly like `Bash(npm test:*)` — which lib/grants.js already
  // classifies as a write held by merge-advocate alone, on the strength of "nothing about
  // run the tests is a read" — and it also creates a real (if detached and outside
  // `.claude/worktrees/`) `git worktree`. Its whole occasion is deciding whether a suite a
  // worker session just ran red is already red on `origin/main`; `dispatch`, the one agent
  // this list actually governs, has no branch, no test run of its own to doubt and never
  // spawns a process past its own single `bd comment`. See lib/blame.js and bin/b7e-blame.
  // b7e-swbump (bc-khoe.44) is deliberately NOT on this list, for the b7e-apply reason
  // rather than the b7e-gate/b7e-blame one: it writes to whatever checkout it runs in —
  // a new docs/sw-cache/vNN.md and a rewritten public/sw.js — with no branch of its own
  // and no path to commit or review the result. `dispatch`, the one agent this list
  // governs, has no branch and no oversight loop; granting this here would let a
  // one-shot comment-answerer edit the tracked tree of a repo it does not own mid-turn,
  // which is exactly the argument b7e-apply already made. See bin/b7e-swbump.
  // b7e-watch (bc-gdub.3) is deliberately NOT on this list either, for the b7e-blame
  // reason rather than a read-only one. Reading a finished run's own JSONL record is
  // free, but once that run has any suite still red, this reruns every one of them
  // through `runBlame` — the same "runs a suite, twice, and builds a real git worktree"
  // shape `lib/grants.js` already calls a write on `Bash(npm test:*)` for. Its whole
  // occasion is a session watching a `b7e-gate` it just started in the background;
  // `dispatch`, the one agent this list governs, has no branch and starts no gate of
  // its own to watch. See lib/gaterun.js and bin/b7e-watch.
  // b7e-call (bc-zjab.7) is deliberately NOT on this list either, and the argument is
  // sharper than any single one above: unlike b7e-def/b7e-census/b7e-owes/b7e-affected,
  // which each run exactly one fixed, read-only operation, b7e-call imports whatever
  // module its argument names and calls whatever export its argument names, with
  // whatever arguments its argument names — there is no argv shape to check for "reaches
  // a write", because the whole point of the command is that it reaches whatever the
  // caller points it at, up to and including a `bd` write buried three imports deep.
  // `dispatch`, the one agent this list governs, has no branch and no oversight loop past
  // its own single `bd comment`; granting this here would let a one-shot comment-answerer
  // run arbitrary code from the tree with nothing to catch a write it did not expect. See
  // bin/b7e-call.
  // b7e-triage (bc-ka5y.15.16) is deliberately NOT on this list, for the b7e-blame reason
  // rather than any read-only one: it re-runs every suite it is given, one at a time,
  // which is `Bash(npm test:*)`'s own shape — already a write held by merge-advocate
  // alone, on "nothing about run the tests is a read" — and on a suite it decides needs
  // it, `scripts/vendor.js`, a write to the tree. Its whole occasion is a worker or a
  // human reading a sweep's own failure list; `dispatch`, the one agent this list
  // governs, has no sweep of its own to triage and no branch to have run one on. See
  // lib/triage.js and bin/b7e-triage.
  // b7e-counterproof (bc-68ou.14) is deliberately NOT on this list either, for the
  // b7e-triage/b7e-blame reason and then some: it runs every suite it is given, twice —
  // once against the tree as it is and once with the given paths reverted to an older
  // ref — which is `Bash(npm test:*)`'s own shape, already a write held by
  // merge-advocate alone. It also writes to the tracked tree itself while it runs,
  // if only for the run: the revert overwrites the given paths with `git show
  // <ref>:<path>` before putting them back, the b7e-swbump/b7e-apply argument on top of
  // the b7e-gate one. Its whole occasion is a worker session proving its own new check
  // catches the bug it was written for, before delivering; `dispatch`, the one agent
  // this list governs, has no branch, no new check of its own to prove and no suite run
  // to doubt. See lib/counterproof.js and bin/b7e-counterproof.js.
  // b7e-chrome (bc-ka5y.15.13) is deliberately NOT on this list, and the grant here has
  // no way to split it: `Bash(b7e-chrome:*)` matches the whole command, listing and
  // `--reap` alike, and `--reap` signals a process it did not start and deletes the
  // directory it was on — exactly the shape `lib/grants.js` already calls a write on
  // `Bash(npm test:*)` for, on the strength of "nothing about run the tests is a read".
  // `dispatch`, the one agent this list governs, has no browser check running and
  // nothing of its own to clean up after; its only use for this command would be ending
  // a process a session it cannot see is depending on. See bin/b7e-chrome and
  // lib/strays.js.
  // b7e-sh (bc-ka5y.29) is deliberately NOT on this list either, and unlike every read-
  // only entry above it has no fixed operation to point at: it hands whatever script or
  // -c string it is given to `bash`, unconstrained past staying inside its own allowed
  // roots — the exact shape b7e-call is refused for above, "there is no argv shape to
  // check for reaches a write, because the whole point of the command is that it reaches
  // whatever the caller points it at." `dispatch`, the one agent this list governs, has
  // no branch and no oversight loop past its own single `bd comment`; granting this here
  // would let a one-shot comment-answerer run an arbitrary shell script against the tree
  // it does not own, with nothing to catch a write it did not expect. See lib/shguard.js
  // and bin/b7e-sh.
  // b7e-sandbox (bc-zjab.6) and b7e-fixture (bc-dgx7.41) are also deliberately NOT on
  // this list, but for neither the read-only reason above nor the b7e-gate/b7e-apply
  // write-hazard one: both build a disposable tree strictly under `os.tmpdir()` — a
  // throwaway `bd` workspace, a throwaway git repo — and both assert in code that they
  // never write under the real CONFIG_DIR or leave `os.tmpdir()` (lib/sandbox.js's
  // assertContained, lib/fixture.js's own tree root). `dispatch`, the one agent this
  // list governs, answers one comment and exits; it has no more occasion to build a
  // throwaway tracker or git tree than it does to run `npm test` or enter a worktree,
  // and unlike the write-shaped commands above, a tmpdir-only builder run by dispatch
  // could not reach anything real even if it were granted. See bin/b7e-sandbox,
  // lib/sandbox.js, bin/b7e-fixture and lib/fixture.js.
  // b7e-gates (bc-khoe.55) is deliberately NOT on this list either, and not for the
  // read-only reason b7e-def/b7e-siblings/b7e-census above are granted: its `--end-mine`
  // sends `SIGTERM`/`SIGKILL` to a live process, which is a write with no undo, and a
  // wildcard grant here cannot separate that flag from the plain report the way the
  // allowlist has no syntax to scope one flag out of a binary. Its whole occasion is a
  // session that started a gate and needs to end its own, or is untangling which of
  // several is whose; `dispatch`, the one agent this list governs, has no gate of its
  // own running and no branch to have started one on. See lib/gates.js and bin/b7e-gates.
  // b7e-commit (bc-xl7n.119) is deliberately NOT on this list, for the reason the
  // say-command is off it rather than a new one: it stages the whole tree (`git add -A`)
  // and writes a commit, which is a write to the checkout no reading of "the read-only
  // surface every reply agent gets" can cover. Its whole occasion is the last step of a worker's own run —
  // confirm the scope, commit, deliver — and `dispatch`, the one agent this list
  // governs, has no branch of its own to commit onto and no delivery waiting on one. A
  // worker session, which is what actually hit this bug five times, already carries an
  // unrestricted allowlist and needs no grant to run it. See lib/commit.js and
  // bin/b7e-commit. The say-command is referred to by description rather than by its
  // bare name on purpose, and it must stay that way: bin/b7e-enroll's allowlistProblem
  // treats ANY occurrence of a name anywhere in this array's text as a recorded decision
  // about that name, so spelling a sibling here silently clears that sibling's own gap —
  // which is exactly the still-open gap this paragraph is citing as precedent.
  // b7e-shard (bc-xlz32.4) is deliberately NOT on this list. It is read-only by
  // construction — the same shape as b7e-affected above — but unlike b7e-affected it
  // answers a question that only exists because of how .github/workflows/test.yml
  // happens to slice the suite this week ("which CI shard is test/x.mjs in"), not one
  // an agent with a diff in front of it would ask. The one real occasion — working out
  // why a shard went red — is answered faster by reading that shard's own log than by
  // re-deriving which suites it held, so a grant here would sit unused the same way
  // b7e-worktree's does above. See bin/b7e-shard and lib/shard.js.
  // b7e-prtree (bc-dgx7.38) is deliberately NOT on this list, for the b7e-sandbox
  // reason rather than the b7e-gate/b7e-blame one: its whole job is to materialise a
  // real directory on disk — a `git fetch` and a `git archive` extracted under
  // `os.tmpdir()`, optionally a `scripts/vendor.js` run inside it — which is real disk
  // and network activity even though it never touches the tree it runs in. `dispatch`,
  // the one agent this list governs, answers one phone comment with one `bd comment`
  // and has no pull request of its own to build a runnable copy of. See bin/b7e-prtree
  // and lib/prtree.js.
  // b7e-bound (bc-xl7n.120) is deliberately NOT on this list either, for the b7e-call
  // reason rather than a read-only one: it runs whatever command its own argument names,
  // under a deadline — there is no argv shape to check for "reaches a write", because
  // reaching whatever the caller points it at is the entire job, exactly the argument
  // b7e-call already made for itself. Checked against lib/grants.js first, per
  // [[b7e-command-write-shaped-check-grants-before-default-tool-list]] — granting this to
  // `dispatch`, the one agent this list governs, would be strictly more capability than
  // `Bash(npm test:*)` (a write held by merge-advocate alone), which has no branch, no
  // oversight loop and no use for running an arbitrary command past its own single `bd
  // comment`. See bin/b7e-bound.
  // Read-only in the same construction sense as b7e-def/b7e-cites/b7e-census above (bc-
  // dgx7.60): it only ever reads markdown and python source under a given tree and prints
  // what names the target, never spawns a process or touches `bd`. Its whole occasion is
  // a session about to edit a file that some other script or doc asserts something about;
  // `dispatch`, the one agent this list governs, answers one comment and has no file of
  // its own about to change, but the grant costs nothing unused the way the read-only
  // ones above don't either. See bin/b7e-claims, lib/corpus.js and lib/probes.js.
  'Bash(b7e-claims:*)',
  // b7e-checks (bc-dgx7.57) is deliberately NOT on this list either, for the b7e-gate/
  // b7e-blame reason rather than a read-only one, even though the bead that asked for it
  // said to add it here — checked against lib/grants.js first, per
  // [[b7e-command-write-shaped-check-grants-before-default-tool-list]], and it fits the
  // precedent squarely: it spawns an external process per check, for as long as
  // `--timeout` allows, against a *different* repo's checkout — one deluvia selftest
  // this command runs today (check_g0_canon_lock_selftest.py) alone takes over a minute
  // — which is a heavier capability than `Bash(npm test:*)` (a write held by
  // merge-advocate alone on "nothing about run the tests is a read"), not a lighter one.
  // `--baseline` also creates a real (if throwaway, detached) `git worktree`, the same
  // write-shaped step `b7e-blame` is withheld for. `dispatch`, the one agent this list
  // governs, has no more use for a battery of another repo's checks than it does for
  // running this one's own suite. See bin/b7e-checks and lib/checks.js.
  // b7e-rebaseline (bc-dgx7.76) is deliberately NOT on this list either, and it inherits
  // the b7e-checks argument directly rather than restating it: it runs that exact set of
  // checks, through the same manifestFor/discoverChecks/runChecks, so every objection just
  // above applies unchanged before this command has done anything of its own. Its own half
  // is heavier still — `--write` rewrites tracked files in a checkout it does not own,
  // which is the b7e-apply reason as well. Its bead's "what shipping it takes" list does
  // say to add `Bash(b7e-rebaseline:*)` here; that list is the bc-dgx7.2 skill checklist,
  // and [[b7e-command-write-shaped-check-grants-before-default-tool-list]] is the note
  // written for exactly this case — check lib/grants.js's precedent before following the
  // checklist, and for something write-shaped the answer is usually "not on this list at
  // all". `dispatch`, the one agent this list actually governs, answers one phone comment
  // with one `bd comment`: no branch to re-baseline on, and no way to commit or review the
  // result of one. See bin/b7e-rebaseline and lib/rebaseline.js.
  // b7e-at (bc-dgx7.63) is deliberately NOT on this list, for the b7e-blame/b7e-worktree
  // reason and the b7e-call/b7e-bound one together: it creates a real (if detached and
  // short-lived) `git worktree` — the same write-shaped step `b7e-blame` is withheld for
  // — and, given a command, runs whatever the caller names with whatever arguments the
  // caller names, the same "no argv shape to check for reaches a write" `b7e-call` is
  // withheld for. `dispatch`, the one agent this list actually governs, has no branch of
  // its own, no ref to want a runnable copy of, and no oversight loop past its own single
  // `bd comment` for whatever a caller-named command might do. See bin/b7e-at and
  // lib/at.js.
  // Read-only in the same construction sense as b7e-def/b7e-claims/b7e-cites above (bc-
  // dgx7.65): it only ever reads bin/*, README.md and this very file off disk and prints
  // what it finds, never spawns a process or touches `bd`. Its whole occasion is a
  // session that needs one of the other `b7e-*` commands and does not yet know which;
  // `dispatch`, the one agent this list governs, has the same need and no cheaper way to
  // answer it than reading these same three registries by hand. See bin/b7e-which and
  // lib/which.js.
  'Bash(b7e-which:*)',
  // Read-only in the same construction sense as b7e-def/b7e-claims/b7e-which above (bc-
  // dgx7.72): it only ever reads a blob out of git's own object store with `git show
  // <ref>:<path>` and writes the copy under `os.tmpdir()`, never inside this repo's own
  // tree and never touching `bd`. Its whole occasion is a session that needs the other
  // side of a ref — a branch it is not on, a commit before its own change — which is
  // exactly the read `dispatch`, the one agent this list governs, would otherwise have
  // no way to make at all. See bin/b7e-show and lib/show.js.
  'Bash(b7e-show:*)',
  // Read-only in the same construction sense as b7e-def/b7e-import above (bc-dgx7.81):
  // it parses every file in lib/, bin/ and scripts/ with its own acorn pass — comments
  // included, which lib/imports.js doesn't collect — and prints what it finds, never
  // spawning a process or touching `bd`. Its whole occasion is a session asking "does
  // lib/ already have a function for this" before writing one; five sessions answered
  // that by hand with a different pile of speculative greps each, one missing `export
  // const resolveSessionDir = (...) => ...` twice because `^export function` cannot
  // match an arrow assigned to a const. See bin/b7e-already and lib/already.js.
  'Bash(b7e-already:*)',
  // Read-only (bc-dgx7.84): two `bd` reads per bead in the chain (`bd show
  // --include-comments`, walked up through `--family`) plus `state.json`'s own
  // `answered` map, never a write. Its whole occasion is a session opened on a bead
  // it was told is answered, that then has to work out by hand whether that is true
  // and where the answer actually is — four sessions did, four different ways, and
  // one of them concluded the premise was wrong after six calls. See bin/b7e-answered
  // and lib/beadanswer.js.
  'Bash(b7e-answered:*)',
  // b7e-run (bc-dgx7.87) is deliberately NOT on this list, and the argument is the
  // b7e-call/b7e-bound one rather than a read-only or a b7e-gate-shaped one: it runs
  // whatever bin/ entry its own argument names, with whatever arguments follow —
  // there is no argv shape to check for "reaches a write", because reaching whatever
  // the caller points it at is the entire job. That includes commands already refused
  // a grant here for exactly that reason on their own — b7e-apply, b7e-commit — plus
  // the conflict-hunk applier's own take-one-side flag, deliberately not named here:
  // per the b7e-commit paragraph above, bin/b7e-enroll's allowlistProblem treats ANY
  // occurrence of a name in this array's text as that command's own recorded decision,
  // and that one does not have one yet. Granting b7e-run would hand dispatch every one
  // of them back through one more hop. `dispatch`, the one agent this list governs,
  // has no branch of its own to write to and no oversight loop past its own single
  // `bd comment`. See bin/b7e-run and lib/run.js.
];

/**
 * The same list as one space-separated string, which is the shape `--allowedTools`
 * wants. Derived rather than written twice — and the array is the source, because
 * several entries contain a space (`Bash(bd show:*)`), so the string cannot be split
 * back apart on whitespace. lib/foundation.js records this as the dispatch agent's
 * baseline and needs the array form.
 */
export const DEFAULT_TOOLS = DEFAULT_TOOL_LIST.join(' ');
