/**
 * A timestamp on every line the daemon writes, installed once, at the top of a process.
 *
 * The failure: `~/Library/Logs/beadcause.log` carried no times at all. The lines
 * themselves are good — "opened a session on bc-y3qk.3 in <path> (auto, opus
 * (unrated), attempt 1)", "claimed bc-y3qk for neadamthal@gmail.com — a window here
 * has it open (pid 74048)" — and reading them you can reconstruct almost everything
 * except *when*, and therefore except order across subsystems. The file is append-only
 * so the lines are ordered, but they come from a daemon interleaving sweeps,
 * dispatches, merges and syncs plus its child processes, so line 58021 sitting above
 * line 58251 says nothing about how far apart they were. "The sync recovered on the
 * very next tick" and "the sync recovered four hours later" are the same two adjacent
 * lines. bc-zjab is the worked example: a plan was filed and its children dispatched
 * ungrouped about two minutes later, the obvious hypothesis was a tick that surveyed
 * before the label landed, and two sessions could not close it because the log records
 * both events in order and stamps neither.
 *
 * **This wraps the console rather than touching call sites, and that is the whole
 * design.** There are ~300 `console.log`/`console.error` calls across lib/ and bin/ —
 * 182 in lib/server.js alone — and a stamp threaded through them would be 300 chances
 * to miss one and 300 lines of diff over code that is otherwise fine. One wrapper at
 * process start covers every line, including the ones nobody has written yet, and the
 * ones inside dependencies.
 *
 * **Prefix only, never a rewrite.** Greps and line-number references into this log are
 * already written into beads, notes and test fixtures (test/reassignguard.mjs quotes a
 * refusal verbatim; test/closeverify.mjs cites line 42283). So a line's content is
 * untouched after the prefix: nothing is reflowed, wrapped, re-ordered or re-worded,
 * and no line is added or removed. An existing `grep "could not hand"` still matches.
 *
 * **Format: `2026-08-18T22:41:03.512Z ` — ISO 8601, UTC, milliseconds, one space.**
 * Sortable as plain text, which a local wall clock is not across a DST change, and
 * unambiguous about the offset, which matters here: this repo has notes about UTC
 * being misread as ADT off tracker timestamps, and a bare `19:43:54` is exactly that
 * trap again. Milliseconds because the question that started this — did the survey run
 * before or after the label landed — is decided inside one second.
 *
 * TWO DECISIONS WORTH STATING RATHER THAN LEAVING TO BE DISCOVERED:
 *
 * 1. **Every line of a multi-line write is stamped, including continuations.** A single
 *    `console.log` can carry embedded newlines — banners, stack traces, `problemBanner`
 *    — and an unstamped continuation line is precisely the failure being fixed: you
 *    grep for a phrase, land on a line, and it has no time. Stack traces gain a stamp
 *    per frame, which reads oddly for a moment and then tells you how long the frames
 *    took to print.
 * 2. **A blank line stays blank.** Stamping an empty line turns a separator into
 *    content and pushes every banner's shape around for a timestamp that orders
 *    nothing. Trailing newlines therefore survive as trailing newlines.
 *
 * WHERE IT IS INSTALLED, and where it deliberately is not. `beadcause.log` is what
 * launchd captures: `StandardOutPath` and `StandardErrorPath` both point at it for
 * bin/router.js (scripts/install.sh), and the router spawns backends — bin/beadcause.js
 * — with `stdio: 'inherit'`, so two processes' console output lands in one file. Those
 * two are the daemon, and nothing else needs this.
 *
 * **It installs itself, on import, and that is not laziness — it is the only way to
 * catch the first line.** A call in a bin's *body* runs after every one of its imports
 * has been evaluated, and one module in that graph prints while it is being evaluated:
 * lib/resolvers.js restores the previous daemon's resolver windows at module load,
 * on purpose, and says so. Measured across the whole import graph of bin/beadcause.js
 * it is the only such line today — and an explicit call would leave it, and every one
 * added later, silently unstamped, which is the failure this module exists to end. So
 * the install is a side effect of importing, and the bins import this FIRST.
 *
 * **The CLI modes of those same bins are excluded, and one of them would be a real
 * break rather than noise.** `node bin/beadcause.js --url` is command-substituted —
 * `BASE_URL=$(… --url)` in scripts/build-android.sh — so a stamp in front of it is an
 * address that resolves to nothing; `--qr` draws a QR code out of block characters that
 * no camera would read with a prefix on every row; `--status` and `--swap` are six lines
 * in a terminal somebody is reading right now. None of the four ever reaches the log,
 * because none of them is ever run by launchd or by the router.
 */

// Node builtins only, and two of them, because this is imported before everything else
// a daemon loads and must not be able to fail on the way in.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One process, one stamp — even if this module is evaluated twice.
 *
 * The router restarts backends, and a backend is a separate process with its own
 * module registry, so that is not the case this guards. The case it guards is a
 * double install inside one process: two `installLogStamp()` calls, or two copies of
 * this module reached under different specifiers (a test importing it by path beside a
 * bin importing it by relative path). Either would prefix a line twice, and a line
 * carrying two timestamps is worse than one carrying none — it looks like a bug in the
 * clock. It therefore lives on `globalThis` rather than in module scope, which is the
 * only thing both copies share, and it holds the undo rather than a bare `true` so that
 * whichever copy installed the wrapper, either can take it off again.
 */
const INSTALLED = Symbol.for('beadcause.logstamp.installed');

/**
 * The five this tree actually uses. `trace`, `dir`, `table` and `group` write straight
 * to the stream rather than through `error`, so wrapping these does not cover them —
 * and nothing here calls them, which is why the list is the five rather than all nine.
 * A line that arrives unstamped is a call site that started using one of the other four.
 */
const METHODS = ['log', 'info', 'warn', 'error', 'debug'];

/**
 * `2026-08-18T22:41:03.512Z` — `toISOString` already is exactly this, and is UTC by
 * definition rather than by a format string somebody can get wrong later.
 */
export function stampOf(when = new Date()) {
  return when.toISOString();
}

/**
 * Put `stamp` in front of every line of `text`, leaving blank lines blank.
 *
 * Exported because it is the whole behaviour, and a suite that can call it directly can
 * pin the two decisions above without capturing a stream.
 */
export function stampLines(text, stamp) {
  const s = String(text);
  if (!s.includes('\n')) return s === '' ? s : `${stamp} ${s}`;
  return s
    .split('\n')
    .map((line) => (line === '' ? line : `${stamp} ${line}`))
    .join('\n');
}

/**
 * Wrap the console so every line it writes carries the time it was written.
 *
 * Idempotent, and it answers whether it did anything so a caller can say so. `now` is
 * injectable for the same reason every clock in this repo is: a suite asserting on a
 * timestamp cannot assert on the real one.
 */
export function installLogStamp({ console: target = console, now = () => new Date() } = {}) {
  if (globalThis[INSTALLED]) return false;
  const restore = [];
  for (const name of METHODS) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    restore.push(() => {
      target[name] = original;
    });
    target[name] = (...args) => {
      // A bare `console.log()` is a blank separator line and stays one, for the same
      // reason a trailing newline does: there is nothing in it to order.
      if (args.length === 0) return original.call(target);
      // The stamp is taken per call, not per install: a process that runs for a week
      // must not print the time it started.
      const stamp = stampOf(now());
      // Formatting is left to the console — `%s` substitution, object inspection,
      // colour — and only the first argument is prefixed, because that is the one
      // console puts at the start of the line. A later argument is joined with a
      // space by the console itself and never begins a line.
      const [first, ...rest] = args;
      if (typeof first === 'string') return original.call(target, stampLines(first, stamp), ...rest);
      // A non-string first argument (an Error, an object) is left entirely alone —
      // its own formatting is the console's business — and the stamp goes in front of
      // it as a separate argument, which the console joins with a space.
      return original.call(target, stamp, first, ...rest);
    };
  }
  globalThis[INSTALLED] = () => {
    for (const undo of restore) undo();
  };
  return true;
}

/**
 * Put the console back. Only a suite has any use for this — a daemon that installed the
 * stamp keeps it for the life of the process — but a suite that wraps the real console
 * and cannot put it back poisons every suite after it in the same runner, and clearing
 * only the flag would leave the wrapper in place and install a second one on top of it.
 */
export function uninstallLogStamp() {
  const undo = globalThis[INSTALLED];
  globalThis[INSTALLED] = null;
  if (typeof undo === 'function') undo();
}

/**
 * The two programs whose console output is `~/Library/Logs/beadcause.log`, and the four
 * flags that mean a person is reading it instead.
 *
 * Deliberately a check on `argv[1]` rather than on anything the bins pass in, because
 * the whole point is to decide *before* the importing module's body runs. It is exact
 * about the path — `<repo>/bin/router.js`, not any file called router.js anywhere —
 * so importing this from a suite, a script or another bin installs nothing, which is
 * what keeps `node test/logstamp.mjs` able to test the wrapper at all.
 */
const DAEMON_ENTRIES = ['bin/router.js', 'bin/beadcause.js'];
const CONSOLE_MODES = ['--url', '--qr', '--status', '--swap'];

/** Exported so the suite can pin the decision rather than infer it from behaviour. */
export function isDaemonEntry(argv = process.argv, root = ROOT) {
  const entry = argv[1] ? path.resolve(argv[1]) : '';
  if (!DAEMON_ENTRIES.some((rel) => entry === path.join(root, rel))) return false;
  return !CONSOLE_MODES.some((flag) => argv.includes(flag));
}

if (isDaemonEntry()) installLogStamp();
