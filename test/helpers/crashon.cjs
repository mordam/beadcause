/**
 * A signal that makes any node process throw where it stands. Preloaded, never imported.
 *
 * `test/routercrash.mjs` has to make a *real* `bin/router.js` take a *real* uncaught
 * exception, and the router has nothing that throws on request — nor should it. The
 * alternative everyone reaches for is a `if (process.env.BEADCAUSE_TEST_CRASH)` branch in
 * the router, and that is a seam in the one process this repo works hardest to keep small,
 * shipped to every user, to serve a test. test/outagepush.mjs makes the same point at more
 * length about not adding one for the push.
 *
 * So the throw comes from outside the program instead:
 *
 *     node --require test/helpers/crashon.cjs bin/router.js
 *
 * `--require` preloads this before the main module, the listener outlives it, and SIGUSR2
 * then throws from inside an ordinary event-loop callback — which is exactly the shape of
 * the crashes this is standing in for, and is delivered to `uncaughtException` by exactly
 * the same route. SIGUSR2 and not SIGUSR1, which node keeps for the inspector.
 *
 * CommonJS because `--require` is: `--import` would work too and would have to be an ESM
 * URL, and there is nothing here that wants to be a module.
 *
 * It lives under `test/helpers/` for the reason everything here does — `scripts/test.mjs`
 * reads `test/` non-recursively for `.mjs`, so a helper in a subdirectory is never run as
 * a suite, and a `.cjs` would not be picked up in any case.
 */
process.on('SIGUSR2', () => {
  throw new Error('a deliberate crash, from test/helpers/crashon.cjs');
});
