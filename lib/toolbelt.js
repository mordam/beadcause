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
 * ## What this file is *not* any more — bc-wbrhi
 *
 * It held the whole list until the `b7e-*` half of it became **derived**. Adding one of
 * those tools meant a line here, a line in `lib/grants.js` and a line in `package.json`,
 * all three at the same place in their files, and ten of the fourteen pull requests open
 * on 2026-08-26 were inserting at `lib/grants.js:333` — so one landing conflicted the
 * other nine, by construction rather than by luck.
 *
 * A `b7e-*` tool now declares its own grant, in its own header, as `@grant read`,
 * `@grant write` or `@grant excluded`. `lib/tooldecl.js` reads `bin/` and assembles
 * `DEFAULT_TOOL_LIST` from **this array plus those declarations**, and it is where
 * `DEFAULT_TOOL_LIST` and `DEFAULT_TOOLS` now live. What stayed here is what a person
 * wrote down and no tool can declare for itself: the `bd` verbs, the four shapes of
 * looking something up, and the one write on the list.
 *
 * **The argument moved with the half it argues about.** Every paragraph explaining why a
 * `b7e-*` tool is on the list — or, for twenty-nine of them, deliberately is not — is in
 * `lib/tooldecl.js`, in the order it was written and not one word of it rewritten. It is
 * a document that argues by cross-reference (twenty-six of the thirty-four blocks name a
 * sibling, seventeen of them positionally), so it survives being moved together and
 * would not survive being cut into sixty-three pieces.
 *
 * @manifest
 *
 * This file is data — one array, no imports, no functions — and the tag above is what
 * tells `lib/affected.js` not to propagate an `imports it` edge out of it. It is here
 * because being imported by `agents.js` and `foundation.js` put this file underneath
 * nearly every suite in the repo: adding a b7e tool selected **205 suites**, 196 of them
 * for no reason but the edge, and that one line is why a narrowed gate cost a median 30%
 * of the full suite rather than 2% (bc-xlz32.7).
 *
 * **That tag is the reason the scan is not in this file.** Deriving the b7e half means
 * reading `bin/`, which means importing `node:fs` and writing a parser —
 * `manifestProblems` refuses the tag to any file that imports something or declares a
 * function, so doing it here would have handed back the 30% and undone bc-xlz32.7 to buy
 * bc-wbrhi. `lib/tooldecl.js` is a normal module and does it there; this one stays data.
 *
 * The narrowing gets *better* rather than worse, which is the part worth noticing:
 * adding a b7e tool now changes only new files — `bin/b7e-X`, `lib/X.js`,
 * `test/b7eX.mjs` — and touches neither this array nor `lib/grants.js`, so it selects
 * the suites that cover the new tool and nothing else. What it costs is a blind spot in
 * the other direction: a declaration edited *inside* an existing `bin/b7e-*` file feeds
 * `lib/tooldecl.js` through the filesystem, which no static reading can see, so nothing
 * narrows to `test/tooldecl.mjs` on the strength of it. The full gate covers it, and
 * `test/tooldecl.mjs` says so in its own header.
 *
 * What still selects a suite is naming something here — `BASE_TOOL_LIST` or this file's
 * path. So **if you add a consumer that depends on what is in this list rather than
 * merely on there being a list, its suite must say one of those names out loud**, or it
 * will not run until the gate.
 */

/**
 * The hand-written half of the read-only surface every reply agent gets.
 *
 * The `bd` verbs are named one at a time rather than globbed, and the notes below say
 * which hole each one closed. This is the *baseline*, not the effective foundation:
 * resolving an amendment is a git read, so this is the fallback the dispatcher uses
 * when the effective one cannot be read, and the string the phone is shown.
 *
 * **Half, not all of it.** `lib/tooldecl.js` appends the `b7e-*` tools that declare
 * themselves granted, and `DEFAULT_TOOL_LIST` — the thing every caller actually wants —
 * is the two together. Nothing here is derived and nothing derived belongs here: a
 * grant in this array is one somebody argued for by hand, and the entries are in the
 * order those arguments were made rather than any order a machine would pick.
 */
export const BASE_TOOL_LIST = [
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
];
