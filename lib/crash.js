/**
 * The daemon files its own crashes, down the same path a browser error takes.
 *
 * `POST /api/error` gave the *phone* a way to turn an error into tracker state
 * (bc-p38c.1, lib/errors.js). The daemon had nothing. Nothing in lib/ or scripts/
 * handled `uncaughtException` or `unhandledRejection` at all, so a thrown error in the
 * one process that runs unattended all night went to stderr, into whatever log launchd
 * happens to be keeping, and no further — and launchd restarted it, which is the worst
 * possible combination: the failure is invisible *and* it looks like it healed.
 *
 * So the daemon reports itself, and it reports through `intake` — in process, no HTTP
 * round trip to its own port. That is the whole reason lib/errors.js knows nothing about
 * requests: a crash cannot be relied on to be able to make an HTTP call to a server it
 * has just broken, and a loopback POST from a process that is about to exit is a race
 * with its own death.
 *
 * **The fingerprint is deliberately the same shape**, which means a daemon crash and a
 * browser error that are genuinely the same bug land on the same bead. `lib/foo.js:41`
 * normalises identically whichever side noticed it — `normalizeSource` already reduces
 * an absolute daemon path to its last two segments, because the checkout root differs
 * between the main checkout and each of the ~30 worktrees. Nothing here had to be added
 * for that; it is why the report is built as a `report` and not as something new.
 *
 * ## What it does *not* change: the crash still kills the process
 *
 * Installing an `uncaughtException` listener takes over from Node, whose default is to
 * print the stack and exit 1. A daemon that swallowed the exception instead would keep
 * serving from a process whose invariants are, by definition, unknown — and that is a
 * much larger decision than "file a bead about it". Node's default is also the behaviour
 * every other guard in this repo is built on: `listen()` exits on a bind failure and
 * `assertRoutes` throws at boot precisely *because* launchd's KeepAlive turns a crash
 * into a loud restart with the reason in the log.
 *
 * So the sequence is: print the stack exactly as before, file the bead, exit 1. The only
 * change to the process's life is that it lives a few seconds longer than it used to,
 * bounded by `FILE_TIMEOUT_MS`, and a bead exists afterwards. `unhandledRejection` gets
 * the same treatment for the same reason — since Node 15 its default *is* an uncaught
 * exception, so exiting is what preserving today's behaviour means, not a new severity.
 *
 * ## The three edges, which are the actual work
 *
 * **Not during shutdown.** SIGTERM closes servers and kills terminals, and things in
 * flight reject as they are torn down. Every one of those would file a P0 bug about a
 * daemon that was doing exactly as it was told, and the router SIGTERMs a backend on
 * every single hot swap — which is to say on every deploy. `beginShutdown()` is called by
 * the shutdown path before anything is closed, and from then on this module only logs.
 *
 * **A failure inside filing must not recurse.** Four guards, and they overlap on purpose
 * because the failure mode is unbounded rather than merely wrong: an error whose stack
 * passes through the filing modules is never filed (`fromFilingPath` — those modules are
 * only ever on a stack when we are filing), one fingerprint is never filed twice at once
 * (`inFlight`), each distinct fingerprint may be filed `PER_ERROR_CAP` times per process,
 * and the process as a whole stops at `PROCESS_CAP`. The two caps are what make a loop
 * *impossible* rather than merely unlikely — they only ever count up, so no arrangement of
 * failures inside the filer can produce unbounded work. And `reportCrash` never rejects: a
 * rejected promise nobody awaited is an `unhandledRejection`, which is the one input
 * guaranteed to bring it straight back here.
 *
 * **An observer files nothing.** `OBSERVING` means every autonomous act is off, and
 * filing a P0 unbidden is an autonomous act — the same reason a second instance sends no
 * ntfy push, so the live daemon's output stays unambiguous. A *reported* error still
 * files on an observer, because a phone asking it to is not the observer acting on its
 * own.
 *
 * ## And the failures the daemon already noticed and swallowed
 *
 * The poll cycle in lib/server.js catches and logs six background failures — the poll
 * itself, the deploy sweep, the owed-close sweep, the advocate tick, the release sweep and
 * the per-question reply push — and carries on. That is right: none of them should be able
 * to stop the others, and most of what they hit is the tracker being locked or `gh` being
 * logged out. But it also means a `TypeError` in the advocate has been logged every thirty
 * seconds for a week with nobody reading it, and *that* is a bug that should be a bead.
 *
 * `reportSweepFailure` is the bar for those, and it is higher than the crash path's: only
 * errors that are bugs **by construction** are filed. A sweep that failed did not kill
 * anything and may well work on the next tick, so a `spawn ENOENT` or a bd lock timeout
 * stays a log line, while a `TypeError` or a `ReferenceError` — which cannot be anything
 * except code that is wrong — becomes a bead. `isBug` is that line, and it deliberately
 * excludes `SyntaxError`: in a sweep that is nearly always somebody *else's* output being
 * parsed, and a real syntax error in this repo would stop the module loading rather than
 * surface in a tick.
 */
import os from 'node:os';
import { inspect } from 'node:util';

import { OBSERVING, OBSERVING_NOTE } from './config.js';
import { fingerprint, intake, isNewBead } from './errors.js';

/**
 * How long filing gets before the process gives up on it.
 *
 * It bounds the wrong thing to be generous with: on the crash path this is a dying daemon
 * held open, and behind the router that is a phone getting nothing until launchd or the
 * router replaces it. A `bd create` shells out and has its own lock retry, so a couple of
 * seconds is normal and ten is already an outlier — long enough that the common case
 * always lands, short enough that a wedged `bd` cannot turn one crash into a process that
 * never exits.
 *
 * It is the default and not the only value: `installCrashHandlers({timeoutMs})` overrides
 * it for a process the trade lands differently on. bin/router.js is the one that takes
 * that up, because it is holding port 4318 while it waits and the backend never is — see
 * the arming there for why it spends half of this.
 */
export const FILE_TIMEOUT_MS = 10000;

/**
 * How many times one distinct error may be filed by one process.
 *
 * Per fingerprint rather than in total, so a sweep failing on every tick cannot starve a
 * genuinely different crash of its report. It is a backstop against volume, not the
 * throttle: the second occurrence of an error is a *comment* on the existing bead,
 * and those are coalesced into one line per widening window (lib/errors.js) — so a sweep
 * broken for a day is 2,880 ticks and about a dozen comments rather than 2,880 of them.
 * This cap sits in front of that: five reports of one fingerprint is already everything
 * distinct one process has to say about it.
 */
export const PER_ERROR_CAP = 5;

/** And a ceiling over all of them, for a loop that manages to be different every time. */
export const PROCESS_CAP = 40;

/**
 * The modules that *are* the filing path.
 *
 * Any of these on a stack means we were filing when it broke, because that is the only
 * time they are on one. Filing an error about the filer, through the filer, is the loop
 * the acceptance criterion names.
 */
const FILING_MODULES = ['/lib/crash.js', '/lib/errors.js', '/lib/filing.js'];

/**
 * Errors that cannot be anything but code that is wrong — the bar for a swallowed sweep
 * failure. A crash files regardless of class; a sweep failure has to clear this.
 */
const BUG_NAMES = new Set(['TypeError', 'ReferenceError', 'RangeError', 'URIError', 'EvalError', 'AssertionError']);

/** What `installCrashHandlers` armed us with, or null when nothing has. */
let armed = null;
/** Set the moment the daemon starts going down, and never unset. */
let stopping = false;
/**
 * Fingerprints being filed right now — the re-entrancy guard, and deliberately keyed
 * rather than a bare "am I filing" flag.
 *
 * A global flag would have been shorter and would have dropped real reports: two
 * *different* sweeps failing in one tick is an ordinary Tuesday, and the second one is
 * not recursion just for arriving during the first. What recursion looks like is the
 * *same* error coming back while we are filing it, and that is what this holds.
 */
const inFlight = new Set();
/** Fingerprint key → how many times this process has filed it. */
const counts = new Map();
/** Filed in total, against PROCESS_CAP. */
let total = 0;
/** So a cap says so once rather than on every tick forever. */
let capAnnounced = false;

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Nothing files from here on. Called by the shutdown path before it closes anything. */
export function beginShutdown() {
  stopping = true;
}

/**
 * Whether the daemon has begun going down — for the suite, and for a caller that wants to
 * skip work of its own on the way out.
 */
export function isShuttingDown() {
  return stopping;
}

/** Is this error, of itself, proof that some code is wrong? See `BUG_NAMES`. */
export function isBug(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'ERR_ASSERTION') return true;
  return BUG_NAMES.has(String(err.name || err.constructor?.name || ''));
}

/** Did this error come out of the filing path itself? See `FILING_MODULES`. */
export function fromFilingPath(stack) {
  const text = String(stack || '');
  return FILING_MODULES.some((m) => text.includes(m));
}

/**
 * Anything at all → the report shape `intake` takes.
 *
 * **A non-`Error` rejection gets no stack, deliberately.** `Promise.reject('nope')`
 * carries nowhere at all, and synthesising `new Error(String(value))` here would stamp it
 * with *this* file's stack — so the fingerprint would say the bug is in lib/crash.js,
 * every unrelated non-Error rejection in the daemon would collapse onto one bead, and
 * `fromFilingPath` would then refuse to file any of them. An empty stack is the honest
 * answer: `fingerprint` falls back to the message alone, which it already does for a
 * cross-origin `window.onerror`, and the bead says its source is unknown rather than
 * saying something false.
 *
 * `source` is left unset on purpose even when there *is* a stack, so `fingerprint` reads
 * the throw site off the top frame with the same parser the phone's
 * `unhandledrejection` reports go through.
 */
export function toReport(value, { kind = 'error', where = '' } = {}) {
  const err =
    value instanceof Error || (value && typeof value === 'object' && typeof value.stack === 'string') ? value : null;
  const message = err
    ? oneLine(err.message) || oneLine(String(err)) || err.name || 'an error with no message'
    : describeNonError(value);
  return {
    message,
    stack: typeof err?.stack === 'string' ? err.stack : '',
    kind,
    url: oneLine(where) || 'the beadcause daemon',
    at: new Date().toISOString(),
    userAgent: `node ${process.version} on ${os.platform()}`,
  };
}

/**
 * A rejection that was not an Error, said in words.
 *
 * The prefix is load-bearing rather than decoration: the message *is* the fingerprint for
 * these, so `undefined` rejected from two unrelated places would otherwise be one bead
 * titled "undefined". Saying what shape it was at least makes the bead legible, and
 * `inspect` is bounded because the message becomes a bead title.
 */
function describeNonError(value) {
  if (typeof value === 'string' && value.trim()) return oneLine(value);
  let shown;
  try {
    shown = oneLine(inspect(value, { depth: 1, breakLength: Infinity }));
  } catch {
    shown = Object.prototype.toString.call(value);
  }
  return `a promise rejected with a non-Error ${typeof value}: ${shown.slice(0, 200)}`;
}

/**
 * One crash in, at most one bead or comment out. **Never rejects** — see the header.
 *
 * The return value is the whole of what the caller can know, and it exists for the suite
 * as much as for the log: `{filed: false, why}` names which guard stopped it, so a test
 * can assert that a failure while filing was refused *for the right reason* rather than
 * merely not happening.
 */
export async function reportCrash(value, { kind = 'error', from = '' } = {}) {
  const report = toReport(value, { kind, where: whereNow() });

  if (stopping) return skip('shutting-down', report);
  if (fromFilingPath(report.stack)) return skip('from-the-filing-path', report);
  if (OBSERVING) return skip('observing', report);
  if (!armed?.bd || !armed?.workspace) return skip('no-daemon-armed', report);

  const fp = fingerprint(report);
  const key = `${fp.atLabel}::${fp.msgLabel}`;
  if (total >= PROCESS_CAP) return skip('process-cap', report);
  if ((counts.get(key) || 0) >= PER_ERROR_CAP) return skip('per-error-cap', report);
  if (inFlight.has(key)) return skip('already-filing', report);

  inFlight.add(key);
  counts.set(key, (counts.get(key) || 0) + 1);
  total += 1;
  try {
    const out = await withTimeout(
      intake(armed.bd, armed.workspace, report, { actor: armed.actor || null, from, config: armed.cfg || null }),
      armed.timeoutMs || FILE_TIMEOUT_MS
    );
    const beadKey = `${armed.workspace.name}/${out.id}`;
    console.error(`[beadcause] ${kind} ${out.action} ${beadKey} — ${fp.at || 'no source'} — ${report.message.slice(0, 80)}`);
    // Only a new bead is news, exactly as the endpoint has it: a comment on a bead
    // already on somebody's screen moves nothing on the inbox.
    if (isNewBead(out.action)) {
      try {
        armed.bus?.emit({ type: 'created', key: beadKey, workspace: armed.workspace.name, id: out.id });
      } catch {
        /* the bead is filed, which is the part that matters */
      }
    }
    return { filed: true, action: out.action, id: out.id, key: beadKey, report, fingerprint: fp };
  } catch (err) {
    // Swallowed rather than rethrown, and this is the deepest point of the recursion
    // guard: whatever went wrong filing must end here, in a caught branch, with nothing
    // left to reject and nobody left to report it to.
    console.error(`[beadcause] could not file the daemon's own ${kind}: ${oneLine(err?.message) || err}`);
    return { filed: false, why: 'filing-failed', detail: oneLine(err?.message), report };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * A background sweep failed, was logged, and carried on — as it should. File it only if it
 * is a bug by construction; see the header for why the bar is higher here.
 *
 * Returns the same shape as `reportCrash` and never rejects, so a call site can drop the
 * promise. `void`-ing a promise that *could* reject would be an `unhandledRejection`,
 * which is the one thing this file must not manufacture.
 */
export async function reportSweepFailure(label, err) {
  if (!isBug(err)) return { filed: false, why: 'not-a-bug', label };
  const out = await reportCrash(err, { kind: `daemon sweep — ${oneLine(label) || 'unnamed'}` });
  return { ...out, label };
}

/**
 * Arm the module and take over from Node. Returns the function that gives it back, which
 * is what a test uses to leave the process as it found it.
 *
 * `exit` is injectable for the same reason: the suite has to drive the fatal path and
 * assert what it filed, and it cannot do that in a process that really exits.
 *
 * @param {object} cfg
 * @param {object} opts
 * @param {object} opts.bd            the daemon's Bd instance (app.bd)
 * @param {object} opts.workspace     which graph a crash here belongs on
 * @param {Function|string} [opts.where] what to call this process on the bead
 * @param {object} [opts.bus]         the event bus, so a new bead reaches a parked poll
 * @param {Function} [opts.exit]      how to exit; defaults to process.exit
 * @param {number} [opts.timeoutMs]   how long filing gets, when `FILE_TIMEOUT_MS` is the wrong
 *                                    trade for this process — see the router's arming
 */
export function installCrashHandlers(
  cfg,
  { bd, workspace, where = '', bus = null, actor = null, exit = null, timeoutMs = 0 } = {}
) {
  armed = { cfg, bd, workspace, where, bus, actor, timeoutMs };
  const leave = exit || ((code) => process.exit(code));

  const fatal = (value, kind) => {
    // First, and before anything can go wrong: the stack, on stderr, exactly as Node
    // would have printed it. Whatever happens to the filing, the log must not come out of
    // this *worse* than it did before the handler existed.
    console.error(`[beadcause] ${kind} — the daemon is going down`);
    console.error(value instanceof Error ? value.stack || String(value) : inspect(value, { depth: 2 }));
    if (OBSERVING) console.error(`[beadcause] ${OBSERVING_NOTE} — not filing a bead for it`);

    // Both arms, not just the happy one. `reportCrash` is documented never to reject, and
    // the exit must not be contingent on that documentation being right: a crash handler
    // whose own filing threw and which then never exited would leave the daemon running in
    // exactly the state Node's default exists to prevent.
    const done = (out) => {
      if (out && !out.filed && out.why && out.why !== 'observing') console.error(`[beadcause] not filed (${out.why})`);
      leave(1);
    };
    reportCrash(value, { kind }).then(done, () => done(null));
  };

  const onUncaught = (err) => fatal(err, 'uncaughtException');
  const onRejection = (reason) => fatal(reason, 'unhandledRejection');

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
    armed = null;
  };
}

/** What this process is called on the bead — a function, so it can name a role that moves. */
function whereNow() {
  const w = armed?.where;
  if (typeof w !== 'function') return oneLine(w);
  try {
    return oneLine(w());
  } catch {
    return '';
  }
}

function skip(why, report) {
  if ((why === 'process-cap' || why === 'per-error-cap') && !capAnnounced) {
    capAnnounced = true;
    console.error(
      `[beadcause] not filing this crash again — ${
        why === 'process-cap' ? `${PROCESS_CAP} filed by this process` : `${PER_ERROR_CAP} for this one error`
      }. It is still in the log, and the bead already has it.`
    );
  }
  return { filed: false, why, report };
}

function withTimeout(promise, ms = FILE_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`filing took longer than ${ms}ms`)), ms);
      // Unreferenced so a pending timer cannot be the reason a healthy process refuses to
      // exit — the crash path exits explicitly, and nothing else waits on this.
      timer.unref?.();
    }),
  ]);
}

/** Everything this process has filed and refused, for the suite and for a status line. */
export function crashStats() {
  return { total, filing: inFlight.size, stopping, armed: Boolean(armed), distinct: counts.size };
}

/** Back to a fresh process, for a suite that drives several scenarios in one. */
export function resetCrashState() {
  stopping = false;
  total = 0;
  capAnnounced = false;
  counts.clear();
  inFlight.clear();
}
