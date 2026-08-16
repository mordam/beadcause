/**
 * The management system, and the switch that says whether this install has one.
 *
 * Everything the compliance epics build — the control corpus, the control-to-evidence
 * edges, the enforcement gates, the coverage reads — is one layer, and this file is the
 * only thing that answers whether that layer is on. Off is the default and off is what
 * almost every install is: sophab, deluvia and ehatt have no architecture checkout, no
 * requirements corpus, no JIRA and no interest in an attestation, and a compliance layer
 * that warns, throws or blocks work on those installs makes the platform worse for every
 * user who is not pursuing one. So the shape here is the one lib/requirements.js took for
 * an absent corpus and lib/ownership.js took for an install that does not know who it is:
 * **absent configuration is an answer, not a failure** — the feature is off, byte for
 * byte, rather than broken.
 *
 * ## Why this is a commit and not a config key
 *
 * A gate that can be silently switched off is not a control. If `management.enabled:
 * false` in `config.json` turned the enforcement gates off, an auditor asking "how do you
 * know these operated for the whole observation window" would have no answer at all: the
 * key is a single line in a file with no history, no author and no reason, and the report
 * built on top of it would be worth nothing.
 *
 * So on is not a value that gets read at startup. **It is a transition, recorded as a
 * chained commit on `refs/beadcause/management`,** the way `refs/beadcause/foundations`
 * already records every change to what an agent may be (lib/foundation.js). Turning the
 * layer on appends a commit. Turning it off appends another. The on/off history is
 * therefore the evidence, in the same store and with the same compare-and-swap as every
 * other thing here that must not lose a concurrent write.
 *
 * That is also why **nothing in this file reads `config.json`** — `CONFIG_DIR` is a path
 * and is the only thing taken from that module, and the config loader itself is not
 * imported here at all. It is not a stylistic choice, and test/management.mjs pins it as a
 * static read of this source: the moment the state can be influenced by a settings file,
 * the commit chain stops being the record of what was true and becomes a record of what
 * somebody last typed, which is a different and much weaker claim.
 *
 * ## Off again is the transition an auditor actually reads
 *
 * A window with an unexplained gap in it is a finding. A window with a gap nobody
 * recorded is a report that cannot be relied on — so a disable has to be **visible as a
 * disabled period** rather than as an absence, which is what `windows()` and `coverage()`
 * exist for. `coverage({from, to})` takes an observation window and hands back the gaps in
 * it, each with the reason given at the time and the person who gave it. A `reason` is
 * mandatory on both directions for that read to mean anything: an enable with no reason
 * opens a window with no scope statement, and a disable with no reason is the gap the
 * whole mechanism is here to make impossible to leave silently.
 *
 * **What the chain does and does not prove.** Each transition carries a dense `seq` and
 * sits in a commit whose parent is the previous one, so removing a transition from the
 * middle means rewriting every commit after it and leaves a hole `verify()` reports.
 * What it does not defend against is a truncation at the tip by somebody with write
 * access to `~/.config/beadcause` — nothing outside that repo records its head, which is
 * the honest limit lib/commonrepo.js's history has too: it answers "what did this say
 * before" and not "was this altered". Anchoring the head somewhere an operator cannot
 * reach is real work and belongs to the enforcement-gate beads, not here.
 *
 * ## Nothing runs when it is off
 *
 * `whenOn()` is the door. A caller hands it a loader, and the loader is not called at all
 * when the layer is off — so a compliance module reached through a dynamic `import()`
 * inside that loader is never parsed, never constructed and never given a chance to
 * throw on an install that has none of what it needs. `null` is the answer an off install
 * gets, and every caller degrades to knowing nothing about controls, which is exactly
 * what a caller degrades to today when `loadCorpus` hands back `{}`.
 */
// CONFIG_DIR only — see the note above about why nothing here reads the config itself.
import { CONFIG_DIR } from './config.js';
import { ensureRepo } from './commonrepo.js';
import { ownerName } from './owner.js';
import { git, ok, refTip, writeTree, commitToRef, readRefFile, refCount, readMessage } from './gitref.js';

/** Where the on/off history lives. Install-wide, so there is no `dir` to pass. */
export const MANAGEMENT_REF = 'refs/beadcause/management';

/** The one file in the ref's tree — the whole record, rewritten each transition. */
export const STATE_FILE = 'management.json';

/** What an install with no history looks like. Off, since always, by nobody. */
const ABSENT = Object.freeze({ on: false, since: null, by: null, reason: null, bead: null, seq: 0 });

const str = (v) => String(v ?? '').trim();

const stamp = () => new Date().toISOString();

/**
 * The retry every writer to a ref here has, copied from lib/memory.js for its reason.
 *
 * `update-ref` fails the same way for "someone got there first" and for a broken ref,
 * and telling them apart by message is guesswork across git versions. Retrying a real
 * error costs a few fast failures; not retrying a lost race loses a transition, which is
 * the one thing this file may never do.
 */
async function cas(attempts, body) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await body();
    } catch (err) {
      last = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * (i + 1)));
    }
  }
  throw last;
}

/* ------------------------------------------------------------------ reading it */

/**
 * The config repo, without creating it.
 *
 * The write path goes through `ensureRepo()` — it has to, since the repo must exist
 * before a ref can be written to it. The read path deliberately does not: an install
 * that has never enabled the layer should not have a git repo initialised underneath it
 * by the act of asking whether the layer is on. Off costs nothing, and that includes
 * costing no `git init`.
 */
const readDir = () => CONFIG_DIR;

/**
 * The whole record, newest state first — `{ on, since, transitions }`.
 *
 * Never throws. A missing ref, a missing config directory, a directory that is not a git
 * repo and a tree with no `management.json` in it are all the same answer, and it is the
 * answer an install that has never heard of any of this should get.
 */
export async function record() {
  const cwd = readDir();
  const raw = await ok(git(cwd, ['cat-file', '-p', `${MANAGEMENT_REF}:${STATE_FILE}`]));
  if (raw === null) return { on: false, since: null, transitions: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A payload we cannot read is not a licence to claim the layer is on. Same
    // direction every degradation here takes: unreadable means off.
    return { on: false, since: null, transitions: [], unreadable: true };
  }
  const transitions = Array.isArray(parsed?.transitions) ? parsed.transitions : [];
  return { on: Boolean(parsed?.on), since: parsed?.since ?? null, transitions };
}

/** The current state, as `{ on, since, by, reason, bead, seq }`. Off when there is none. */
export async function state() {
  const rec = await record();
  const last = rec.transitions[rec.transitions.length - 1] || null;
  if (!last) return { ...ABSENT };
  return {
    on: Boolean(rec.on),
    since: rec.since ?? last.at ?? null,
    by: last.by ?? null,
    reason: last.reason ?? null,
    bead: last.bead ?? null,
    seq: Number(last.seq) || rec.transitions.length,
  };
}

/** Is the management system on? The one question most callers have. */
export const isOn = async () => (await state()).on;

/**
 * The gate. `load` is called only when the layer is on, and its result is returned.
 *
 * This is what "no compliance code path runs at all when the layer is off" is made of:
 * put the `import()` of a compliance module *inside* the loader and an off install never
 * parses it. `fallback` is what an off install gets, and it defaults to `null` rather
 * than to a throw because a caller asking about controls on an install with none is
 * asking a reasonable question with a reasonable answer.
 */
export async function whenOn(load, { fallback = null } = {}) {
  const s = await state();
  if (!s.on) return fallback;
  return load(s);
}

/* -------------------------------------------------------------- the timeline */

/**
 * The record as periods rather than as events — what an auditor reads.
 *
 * Every entry is `{ on, from, to, by, reason, bead }`, oldest first. `to` is `null` on
 * the period that is still running. The first entry is the implicit one: the stretch
 * before the layer was ever enabled, which is off, has no author and no reason, and is
 * marked `implicit` so nobody reads it as a decision somebody made. It is included
 * because "never enabled before this date" is a fact about the window an auditor is
 * looking at, and leaving it out would make the timeline start in the middle.
 *
 * A disabled period between two enables is an ordinary entry with `on: false` and the
 * reason given at the time. That is the whole of "a disabled period is visible as such
 * rather than absent from the record".
 */
export async function windows() {
  const rec = await record();
  const ts = rec.transitions;
  if (!ts.length) {
    return [{ on: false, from: null, to: null, by: null, reason: null, bead: null, implicit: true }];
  }
  const out = [
    { on: false, from: null, to: ts[0].at ?? null, by: null, reason: null, bead: null, implicit: true },
  ];
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i];
    out.push({
      on: Boolean(t.on),
      from: t.at ?? null,
      to: ts[i + 1]?.at ?? null,
      by: t.by ?? null,
      reason: t.reason ?? null,
      bead: t.bead ?? null,
      implicit: false,
    });
  }
  return out;
}

const ms = (iso) => {
  const n = Date.parse(String(iso || ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Was the layer on for the whole of an observation window, and where was it not?
 *
 * The question a Type II report is built on, answered from the record rather than from
 * anybody's memory. `from` and `to` are ISO strings; `to` defaults to now. The gaps come
 * back with the reason recorded at the time and the person who recorded it, so a finding
 * arrives with its explanation already attached — and a gap that predates the first
 * enable comes back `implicit: true` with no reason, because there is none to give.
 *
 * `complete` is the headline and it is deliberately a boolean rather than a percentage:
 * 99.4% of an observation window is not a passing grade, it is a finding with a number
 * beside it.
 */
export async function coverage({ from = null, to = null } = {}) {
  const start = ms(from) ?? 0;
  const end = ms(to) ?? Date.now();
  const gaps = [];
  let coveredMs = 0;
  for (const w of await windows()) {
    const a = Math.max(ms(w.from) ?? -Infinity, start);
    const b = Math.min(ms(w.to) ?? Infinity, end);
    if (!(b > a)) continue;
    if (w.on) coveredMs += b - a;
    else
      gaps.push({
        from: new Date(a).toISOString(),
        to: new Date(b).toISOString(),
        by: w.by,
        reason: w.reason,
        bead: w.bead,
        implicit: w.implicit,
      });
  }
  const totalMs = Math.max(0, end - start);
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    complete: totalMs > 0 && gaps.length === 0,
    coveredMs,
    totalMs,
    gaps,
  };
}

/**
 * The transitions as commits, newest first, each with the message it was written with.
 *
 * `windows()` is the derived read and this is the raw one; both exist because they
 * answer different questions. A person asking "when did this change and who said so"
 * wants the commits, and can reach the same thing with
 * `git -C ~/.config/beadcause log refs/beadcause/management` on a machine with no
 * beadcause running at all — which is the property that makes this retrievable months
 * later rather than only for as long as the daemon is alive.
 */
export async function history({ limit = 50 } = {}) {
  const cwd = readDir();
  const log = await ok(
    git(cwd, ['log', '--format=%H%x00%aI%x00%s', `--max-count=${limit}`, MANAGEMENT_REF])
  );
  if (!log) return [];
  const out = [];
  for (const line of log.split('\n').filter(Boolean)) {
    const [commit, at, subject] = line.split('\0');
    out.push({ commit, at, subject, message: await readMessage(cwd, commit) });
  }
  return out;
}

/**
 * Does the record hold together?
 *
 * Four things, and each of them is a way a chain can be tampered with or a way a bug
 * here could corrupt it. The commit count must equal the number of transitions, because
 * every transition is exactly one commit and a mismatch means the ref was rewritten. The
 * `seq` numbers must be dense from 1, so a removed entry shows as a hole. The states must
 * alternate starting from on, because off is the default and a redundant transition is
 * never written. And the timestamps must not go backwards.
 *
 * An install that has never enabled anything verifies clean: zero commits, zero
 * transitions, nothing to be wrong.
 */
export async function verify() {
  const cwd = readDir();
  const rec = await record();
  const ts = rec.transitions;
  const commits = await refCount(cwd, MANAGEMENT_REF);
  const problems = [];

  if (rec.unreadable) problems.push(`${STATE_FILE} is not readable JSON`);
  if (commits !== ts.length)
    problems.push(`${commits} commit${commits === 1 ? '' : 's'} on the ref but ${ts.length} transition${ts.length === 1 ? '' : 's'} recorded`);

  let expect = true;
  let last = null;
  ts.forEach((t, i) => {
    if (Number(t.seq) !== i + 1) problems.push(`transition ${i + 1} carries seq ${t.seq ?? '(none)'}`);
    if (Boolean(t.on) !== expect)
      problems.push(`transition ${i + 1} is ${t.on ? 'on' : 'off'} where the record already says ${expect ? 'off' : 'on'}`);
    expect = !Boolean(t.on);
    const at = ms(t.at);
    if (at === null) problems.push(`transition ${i + 1} has no readable timestamp`);
    else if (last !== null && at < last) problems.push(`transition ${i + 1} is dated before the one before it`);
    if (at !== null) last = at;
  });

  return { ok: problems.length === 0, commits, transitions: ts.length, problems };
}

/* ------------------------------------------------------------------ writing it */

/**
 * Turn the layer on or off, and record that somebody did.
 *
 * `reason` is mandatory in both directions and the refusal is deliberate. An enable with
 * no reason opens a window with no scope statement — nobody months later can say what
 * the layer was turned on *for* — and a disable with no reason is precisely the silent
 * gap this whole mechanism exists to make impossible. The message an auditor reads is
 * the commit message, exactly as `lib/foundation.js` puts an amendment's justification
 * in the message rather than in a field.
 *
 * A redundant call writes nothing and says so: `{ changed: false }`. Enabling an install
 * that is already on is not a transition, and a record padded with non-events is one
 * nobody can read. It is not an error either — a script that wants the layer on and does
 * not care whether it already was should not have to look first.
 */
export async function setManagement(on, { reason = '', by = ownerName(), bead = null } = {}) {
  const want = Boolean(on);
  const why = str(reason);
  if (!why)
    throw new Error(
      `turning the management system ${want ? 'on' : 'off'} needs a reason — it is what the record is for`
    );

  const cwd = await ensureRepo();
  return cas(8, async () => {
    const tip = await refTip(cwd, MANAGEMENT_REF);
    const raw = tip ? await readRefFile(cwd, MANAGEMENT_REF, STATE_FILE) : null;
    let prior = { on: false, since: null, transitions: [] };
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        prior = {
          on: Boolean(parsed?.on),
          since: parsed?.since ?? null,
          transitions: Array.isArray(parsed?.transitions) ? parsed.transitions : [],
        };
      } catch {
        throw new Error(`${STATE_FILE} on ${MANAGEMENT_REF} is not readable JSON — refusing to write over it`);
      }
    }

    if (prior.on === want) return { changed: false, state: await state() };

    const at = stamp();
    const transition = { seq: prior.transitions.length + 1, on: want, at, by: str(by) || 'unknown', reason: why, bead: str(bead) || null };
    const next = {
      on: want,
      since: at,
      transitions: [...prior.transitions, transition],
    };
    const tree = await writeTree(cwd, [[STATE_FILE, Buffer.from(JSON.stringify(next, null, 2) + '\n')]]);
    const message = [
      `management: ${want ? 'on' : 'off'}${transition.bead ? ` (${transition.bead})` : ''}`,
      '',
      why,
      '',
      `${want ? 'enabled' : 'disabled'} by ${transition.by}`,
    ].join('\n');
    await commitToRef(cwd, MANAGEMENT_REF, tree, message, { expect: tip });
    return { changed: true, state: await state() };
  });
}

/** Turn it on. `reason` is required — see `setManagement`. */
export const enable = (opts = {}) => setManagement(true, opts);

/** Turn it off, which is the transition an auditor actually reads. `reason` is required. */
export const disable = (opts = {}) => setManagement(false, opts);

/** Where the record lives, for a message that tells somebody how to read it themselves. */
export const recordLocation = () => `${CONFIG_DIR} — ${MANAGEMENT_REF}`;
