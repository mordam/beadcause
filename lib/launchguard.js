/**
 * The seam over the one side effect in lib/session.js — a test may not open a window.
 *
 * The single line in that file which reaches the world outside the process is the
 * `execFile('/usr/bin/osascript', …)` at the bottom of `launch`. Everything above it is
 * strings and temp files; that line opens a real iTerm window, on a real Mac, running a
 * real `claude` that will spend a real hour. It is the only irreversible thing there, and
 * until 2026-08-14 nothing stood in front of it but the gates further up the call.
 *
 * **That is not a hypothetical.** Nine suites call the real `openWorkSession` /
 * `openPlanSession` with only `bd` stubbed — shipbead, stillopen, superseded, endorse,
 * underroot, openrepo, claimqueue, jiragate, tiermodel. They pass today because a gate
 * throws first, so the day a gate stops throwing the suite does not merely go red: it
 * opens the window. One was opened that morning by `node test/shipbead.mjs`, in the
 * suite's own `mkdtemp` directory, which the suite then deleted from under the live
 * session. It cost a window, an agent-hour, and a brief addressed to bead `undefined`.
 *
 * So the refusal is at the side effect rather than at any of the places that call it —
 * the lesson lib/shipbead.js already paid for twice: a guarantee that depends on every
 * caller remembering is not a guarantee, and a filter is never the thing that holds.
 *
 * **Its own module, and that is not tidiness** — the same reason lib/shipbead.js is one.
 * scripts/test.mjs has to name the variable it sets for every child, and lib/session.js
 * imports half the tree; a runner that reached into the session launcher to read one
 * string would be importing iTerm placement, foundations and the agent-repo experiment to
 * find out what to put in an environment. One string, one place, imported by both.
 *
 * ## Two layers, because they cover different holes
 *
 * 1. **The entry point.** A process whose `argv[1]` is a file under `test/` may not open a
 *    window, and it does not have to have been told. This is the layer that would have
 *    caught the incident, because the incident was a suite run *directly* — `node
 *    test/shipbead.mjs`, with no runner above it to set anything. It is also the layer
 *    that covers a suite written next month by someone who never read this file.
 * 2. **`BEADCAUSE_NO_LAUNCH`,** which scripts/test.mjs sets for every child it spawns. A
 *    suite that starts a *daemon* is running `bin/router.js`, and no amount of looking at
 *    `argv[1]` will see a test in that — the env var is inherited and does.
 *
 * Neither is the guarantee on its own, which is why both are here.
 *
 * ## And one way out, taken exactly once
 *
 * `BEADCAUSE_ALLOW_LAUNCH` turns both off. test/tiermodel.mjs sets it, because it drives
 * the real launcher end to end against a **stub AppleScript** beside a mirrored `lib/` —
 * a seam of its own and a better one, since it proves what the shell in that window would
 * have run. Opting out is one visible line in a diff, which is the whole point of it being
 * an opt-out rather than the default.
 *
 * The daemon sets neither variable and is not started on a suite, so in production none of
 * this branch exists.
 */

/** Set by scripts/test.mjs for every suite it spawns. Layer 2. */
export const NO_LAUNCH = 'BEADCAUSE_NO_LAUNCH';

/** The one way out. Set by test/tiermodel.mjs, which has a stub AppleScript in place. */
export const ALLOW_LAUNCH = 'BEADCAUSE_ALLOW_LAUNCH';

/**
 * Was this process started on a test suite? Layer 1.
 *
 * `argv[1]` and not the import graph: what is being asked is "who ran this", and a suite
 * that imports lib/session.js is indistinguishable from the daemon by any other means.
 * Matched on the directory as well as the extension so that `bin/test-something.js` — a
 * name nobody has used yet and somebody will — is not quietly unable to open a session.
 */
export const startedByASuite = (argv = process.argv) => /(^|\/)test\/[^/]+\.m?js$/.test(argv[1] || '');

/**
 * May this process open a window at all?
 *
 * The allow-out is checked first and wins over both layers: it is the deliberate act, and
 * a suite that has put a stub in front of the AppleScript is safer than one that has not
 * regardless of what its filename looks like.
 */
export const mayLaunch = (env = process.env, argv = process.argv) =>
  Boolean(env[ALLOW_LAUNCH]) || !(env[NO_LAUNCH] || startedByASuite(argv));

/**
 * Why no window opened — a 409 with a named boolean, matching lib/shipbead.js and
 * lib/endorse.js field for field, so a caller can tell this from a launch that failed and
 * nothing retries it.
 *
 * **It carries what it refused, and that is the useful half** rather than a debugging
 * courtesy. A launch that does not happen leaves no command file and no window, so without
 * this there is nothing to assert against: a suite could prove a door *refuses*, and could
 * not prove the brief it would have written names the right bead. That is precisely the
 * defect that rode in with the incident (bc-xl7n.43), and test/launchseam.mjs catches it
 * by reading `err.prompt`.
 */
export const launchRefusal = (tabTitle, prompt) =>
  Object.assign(
    new Error(
      `no window opened — this process may not open sessions (${NO_LAUNCH} is set, or it was ` +
        `started on a test suite)${tabTitle ? `; it would have been ${tabTitle}` : ''}`
    ),
    { status: 409, noLaunch: true, tabTitle: tabTitle || null, prompt: prompt || '' }
  );

/** The gate itself, called from `launch` before it writes anything or spends anything. */
export const assertMayLaunch = (tabTitle, prompt) => {
  if (!mayLaunch()) throw launchRefusal(tabTitle, prompt);
};
