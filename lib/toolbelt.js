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
  // Read-only in the same construction sense as b7e-def/b7e-siblings/b7e-census above:
  // its own file walk never touches anything outside lib/bin/test/scripts/public/android
  // and README.md, and the one `bd` verb it spawns is a single batched `show` for every
  // id it found — never a write. bc-4r10.22 is the argument: four sessions each found a
  // stale bead citation ("bc-228x has not settled...", written after bc-228x had closed)
  // by accident, while looking for something else, and none of them swept for the rest.
  // See bin/b7e-cites and lib/cites.js.
  'Bash(b7e-cites:*)',
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
  // b7e-gate (bc-khoe.39) is also deliberately NOT on this list, for a sharper version of
  // the b7e-apply argument below: lib/grants.js already classifies `Bash(npm test:*)` —
  // running this repo's own suites, which spawn daemons and bind ports — as a write, held
  // by merge-advocate alone. b7e-gate does exactly that, concurrently, for up to fifty
  // minutes; it is a heavier capability than npm test, not a lighter one, and this list
  // reaches only `dispatch`, which has no more use for the whole suite passing than it
  // does for anything else past its own single `bd comment`. See bin/b7e-gate.
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
  // b7e-prtree (bc-dgx7.38) is deliberately NOT on this list, for the b7e-sandbox
  // reason rather than the b7e-gate/b7e-blame one: its whole job is to materialise a
  // real directory on disk — a `git fetch` and a `git archive` extracted under
  // `os.tmpdir()`, optionally a `scripts/vendor.js` run inside it — which is real disk
  // and network activity even though it never touches the tree it runs in. `dispatch`,
  // the one agent this list governs, answers one phone comment with one `bd comment`
  // and has no pull request of its own to build a runnable copy of. See bin/b7e-prtree
  // and lib/prtree.js.
];

/**
 * The same list as one space-separated string, which is the shape `--allowedTools`
 * wants. Derived rather than written twice — and the array is the source, because
 * several entries contain a space (`Bash(bd show:*)`), so the string cannot be split
 * back apart on whitespace. lib/foundation.js records this as the dispatch agent's
 * baseline and needs the array form.
 */
export const DEFAULT_TOOLS = DEFAULT_TOOL_LIST.join(' ');
