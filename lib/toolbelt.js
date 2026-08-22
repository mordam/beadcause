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
];

/**
 * The same list as one space-separated string, which is the shape `--allowedTools`
 * wants. Derived rather than written twice — and the array is the source, because
 * several entries contain a space (`Bash(bd show:*)`), so the string cannot be split
 * back apart on whitespace. lib/foundation.js records this as the dispatch agent's
 * baseline and needs the array form.
 */
export const DEFAULT_TOOLS = DEFAULT_TOOL_LIST.join(' ');
