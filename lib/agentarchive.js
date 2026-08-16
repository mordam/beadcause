/**
 * The agent log, kept — because `reset()` is right about the pane and wrong about the record.
 *
 * lib/agentlog.js writes one file per bead and truncates it at every dispatch, and that
 * is correct for the thing it was built for: a phone tailing a live run wants this run,
 * not yesterday's answer sitting above today's question. It is fatal for the same file
 * read as *evidence*. What an agent did on a bead survived exactly until the next thing
 * was dispatched at that bead — so the run an incident is reconstructed from, which is
 * always the one that was retried, was the one guaranteed to be gone. `lib/evidence.js`
 * registered that as the `agent-run-logs` gap and named this bead; this is the half that
 * closes it.
 *
 * **The fix is not to stop resetting.** It is to archive first. `archiveAndReset` is the
 * only thing that may call `agentlog.reset` for a dispatched run, and `test/agentarchive.mjs`
 * holds that: a second call site would be a run destroyed with nobody noticing, which is
 * precisely the bug being fixed rather than a style preference.
 *
 * ## Two stores, and the split is the whole design
 *
 * - **The record** is a commit on `refs/beadcause/agentlogs`, appended through the
 *   compare-and-swap in lib/gitref.js, exactly the way lib/foundation.js chains an
 *   amendment. Every commit's sha covers its parent, so editing or removing anything but
 *   the tip breaks every sha after it. It is small — a few hundred bytes of provenance
 *   and a digest — and it is **permanent**.
 * - **The body** — the log text itself — is a file under `~/.config/beadcause/agentlogs/`,
 *   and it is **disposed of on a stated rule**.
 *
 * Splitting them is not tidiness. A chained store cannot dispose of anything: dropping
 * the middle of a commit chain rewrites every sha after it, which is the property the
 * chain exists for, so `session-transcripts` in the register says outright that its
 * permanence is a consequence of the shape rather than a preference. That is the right
 * trade for a transcript kept in the repo it belongs to. It is the wrong one for a store
 * that grows by a file per dispatch forever: keeping everything for all time is a
 * data-governance finding of its own, and "we never got round to deleting it" is not a
 * retention decision. So the disposable half is kept where it can be deleted, and the
 * half that proves the deletion was legitimate is kept where it cannot.
 *
 * What survives disposal is therefore not nothing. It is: this run happened, at this
 * time, on this bead, under this agent kind, this model, this foundation revision and
 * this endorsement, and its body hashed to *this* — followed, further up the same chain,
 * by a commit saying the body was disposed of under the retention rule. An auditor asking
 * about a run outside the window gets an answer with a date on it rather than a silence.
 *
 * ## Why the record is the commit message and the tree is empty
 *
 * Every other payload ref here puts its content in a tree, and this one deliberately does
 * not. The retrieval that matters is not "read the tip" — it is bc-eqn1.14's evidence pack
 * and bc-eqn1.10's data-store questions, which are both the same shape: *every run at this
 * bead*, and *every run between these two dates*. `git log --since --until --grep` answers
 * both in a single process with the full record in hand, because `--format=%B` returns a
 * message. A tree would make the same query one `cat-file` per run — fine for the three
 * runs on a bead, and a day's worth of subprocesses for a month of an audit window. The
 * cost in a Stage 2 audit is never the storage, it is the retrieval.
 *
 * The tree is empty rather than holding a copy of the record, because a fact with two
 * homes in the same commit is a fact that can disagree with itself. The body is not in
 * git at all — that is the point of the split above.
 *
 * ## Provenance is taken, never re-derived
 *
 * `model` comes from the call site, which is the only thing that knows what the process
 * was actually launched with; `foundation.revision` is the tip of `refs/beadcause/foundations`
 * read at archive time; endorsement comes from the tracker row the dispatch already had in
 * hand (lib/endorse.js). Nothing here recomputes any of them. A record that disagreed with
 * the app about which model a run used would be worse than no record: both are plausible
 * and there is nothing on either screen to say which one lied.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './config.js';
import * as agentlog from './agentlog.js';
import { FOUNDATION_REF } from './foundation.js';
import { RETENTION_FLOOR_MONTHS } from './evidence.js';
import { commitToRef, gitInput, git, mainCheckout, ok, refTip } from './gitref.js';

/** The chain. Outside `refs/heads/*`, so it rides in the repo and touches no file. */
export const ARCHIVE_REF = 'refs/beadcause/agentlogs';

/** Where the disposable half lives. One file per archived run, `0600` like the live log. */
export const BODY_DIR = path.join(CONFIG_DIR, 'agentlogs');

/** This checkout, so the chain has one home rather than one per repo an agent ran in. */
const SELF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How long a body is kept, in months.
 *
 * The number is `lib/evidence.js`'s floor and the argument is the register's: a Type II
 * observation window is twelve months and the report is relied on for about twelve months
 * after issuance, during which the auditor or a buyer's security review can come back to
 * the population the sample was drawn from. Twenty-four is the sum.
 *
 * Configurable **upwards only** (`agentLogRetentionMonths`). An install with a longer
 * retention obligation than ours can say so; an install that wants a shorter one is asking
 * for disk convenience, and the floor is where the argument for the number lives.
 */
export const retentionMonths = (cfg = {}) => {
  const n = Number(cfg?.agentLogRetentionMonths);
  return Number.isFinite(n) && n > RETENTION_FLOOR_MONTHS ? Math.floor(n) : RETENTION_FLOOR_MONTHS;
};

/**
 * `2026-08-15T19:30:12.345Z` → `20260815T193012345Z`. Sortable, and a filename.
 *
 * **Milliseconds, and they are load-bearing.** At second resolution two archives at one
 * bead inside the same second produce the same id, and the second silently writes over the
 * first — an evidence store losing a run without a word, which is the whole of the bug
 * being fixed here wearing a different hat. It is not hypothetical for a suite, a retry
 * loop, or a daemon restarting mid-tick, and `archiveRun` disambiguates below that too.
 */
const stampOf = (iso) => String(iso).replace(/[-:.]/g, '');

/** And back, so disposal reads the date off the name rather than off a touchable mtime. */
export function stampDate(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{0,3})Z$/.exec(String(stamp || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${(ms || '0').padEnd(3, '0')}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** A run's id: the log's own filename stem, plus when it was archived. */
export const runId = (key, archivedAt) => `${agentlog.slug(key)}-${stampOf(archivedAt)}`;

/** The body of an archived run, by id. Present until disposal, absent after it. */
export const bodyPath = (id) => path.join(BODY_DIR, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.log`);

/**
 * The date in a run id, or null. `beadcause_bc-eqn1.7-20260815T193012345Z` → the Date.
 *
 * Matched at the end rather than sliced at a fixed offset, because a key can be any length
 * and because `archiveRun` may append `-2` to break a same-millisecond tie. A slice would
 * read the disambiguator as part of the date and quietly return null — and a body nothing
 * can date is a body the retention sweep leaves alone forever.
 */
export const runIdDate = (id) => stampDate(/-(\d{8}T\d{6,9}Z)(?:-\d+)?$/.exec(String(id || ''))?.[1] || '');

/**
 * The checkout the chain lives in, or null.
 *
 * One home for every workspace's runs, unlike `refs/beadcause/sessions/<bead>`, which
 * belongs in the checkout the session changed. A dispatch log is keyed by `workspace/bead`
 * across every repo the daemon watches and its body is in `~/.config/beadcause`, which is
 * global — so a per-repo chain would be a chain per accident of which repo the bead names.
 *
 * Null rather than a throw when beadcause is not installed from a git checkout: that
 * install keeps bodies and no chain, which is a degraded archive and not a dead daemon.
 */
export async function archiveRepo(cwd = null) {
  if (cwd) return cwd;
  return await mainOf(SELF);
}

/**
 * `mainCheckout`, remembered.
 *
 * Which checkout a directory belongs to does not change while the daemon is up, and this
 * sits in the dispatch path: `archiveAndReset` runs between the phone's tap and the agent
 * being spawned, so every subprocess it makes is latency somebody is watching for. Two
 * `rev-parse`es per dispatch, forever, to re-answer a question whose answer is a property
 * of the filesystem is the kind of cost that is invisible until it is the whole budget.
 */
const MAIN = new Map();
async function mainOf(dir) {
  const at = path.resolve(dir || SELF);
  if (!MAIN.has(at)) MAIN.set(at, await ok(mainCheckout(at)));
  return MAIN.get(at);
}

/** The empty tree, written for real so `commit-tree` never depends on git's implicit one. */
const emptyTree = (cwd) => gitInput(cwd, ['hash-object', '-t', 'tree', '-w', '--stdin'], '').then((s) => s.trim());

/** `refs/beadcause/foundations`' tip, which is *which* foundation a run proceeded under. */
export async function foundationRevision(dir) {
  const main = await mainOf(dir);
  if (!main) return null;
  return await refTip(main, FOUNDATION_REF);
}

/**
 * One record onto the chain. Retried on a lost compare-and-swap, never on anything else.
 *
 * The retry is the ordinary case rather than an exception: the advocate tick and a
 * dispatch can archive within the same second, and `update-ref <ref> <new> <old>` is
 * designed to refuse the second one. Refusing is the mechanism working — what would be
 * wrong is taking the refusal as "this run was not archivable" and dropping it.
 */
async function append(cwd, record, { attempts = 4 } = {}) {
  const subject =
    record.type === 'disposal'
      ? `disposal · ${record.disposed.length} body(ies) · ${record.at}`
      : `agent run · ${record.key} · ${record.agent || 'agent'} · ${record.archivedAt}`;
  const message = `${subject}\n\n${JSON.stringify(record, null, 2)}\n`;

  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const tip = await refTip(cwd, ARCHIVE_REF);
      const tree = await emptyTree(cwd);
      return await commitToRef(cwd, ARCHIVE_REF, tree, message, { expect: tip });
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error('could not append to the archive');
}

/**
 * Archive the live log for `key`, then reset it. **The only thing that may reset one.**
 *
 * Ordered so that no failure can lose a run. The body is copied first and synchronously,
 * so by the time anything is deleted the evidence is already on disk; the chain is
 * appended next; the reset happens last and happens even when the chain write failed,
 * because the pane still needs its clean file and the body is already safe. An orphaned
 * body — kept, unchained — is a loud line in the log and a recoverable state. A reset
 * before the copy would be neither.
 *
 * Never throws, for the reason `append` in lib/agentlog.js never throws: an archive that
 * cannot be written must not take the agent down with it. It says what happened in its
 * answer instead, and the caller logs it.
 */
export async function archiveAndReset(key, meta = {}) {
  const out = await archiveRun(key, meta);
  agentlog.reset(key);
  return out;
}

/**
 * The archive half on its own, so a test can drive it without a reset and so the reset
 * above is one line rather than a function with two jobs.
 */
export async function archiveRun(key, meta = {}) {
  const src = agentlog.logPath(key);
  let text;
  try {
    text = fs.readFileSync(src, 'utf8');
  } catch {
    // No log at all is the ordinary case on the first dispatch at a bead, and an empty
    // one is a run that produced nothing. Neither is a record and neither is a failure.
    return { archived: false, reason: 'nothing to archive' };
  }
  if (!text.trim()) return { archived: false, reason: 'nothing to archive' };

  const archivedAt = (meta.now instanceof Date ? meta.now : new Date()).toISOString();
  // The last line of defence on uniqueness. Milliseconds make a collision improbable rather
  // than impossible, and "improbable" is not a property an evidence store may rest on: the
  // failure it would produce is one run silently overwriting another, which is the bug this
  // module exists to fix. `runIdDate` knows about the suffix.
  let id = runId(key, archivedAt);
  for (let n = 2; fs.existsSync(bodyPath(id)); n++) id = `${runId(key, archivedAt)}-${n}`;
  let stat = null;
  try {
    stat = fs.statSync(src);
  } catch {
    /* the size and the times are a nicety; the bytes are the record */
  }

  let body;
  try {
    fs.mkdirSync(BODY_DIR, { recursive: true });
    body = bodyPath(id);
    fs.writeFileSync(body, text, { mode: 0o600 });
  } catch (err) {
    return { archived: false, reason: `could not keep the body — ${err.message}` };
  }

  const record = {
    type: 'run',
    id,
    key,
    workspace: meta.workspace ?? String(key).split('/')[0] ?? null,
    // Null rather than the string after the slash for a run that is not about a bead at
    // all — an advocate survey is keyed `<workspace>/advocate`, and a bead field holding
    // the word "advocate" is a bead id that does not exist.
    bead: meta.bead ?? null,
    // The four the acceptance criteria name, and all four are taken rather than derived.
    agent: meta.agent || null,
    persona: meta.persona || null,
    model: meta.model || null,
    foundation: { ref: FOUNDATION_REF, revision: await foundationRevision(meta.dir) },
    endorsement: {
      endorsed: typeof meta.endorsed === 'boolean' ? meta.endorsed : null,
      note: meta.endorsementNote || null,
    },
    repo: meta.repo || null,
    startedAt: stat?.birthtime ? new Date(stat.birthtime).toISOString() : null,
    endedAt: stat?.mtime ? new Date(stat.mtime).toISOString() : null,
    archivedAt,
    bytes: Buffer.byteLength(text),
    lines: text.split('\n').filter((l) => l.length).length,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    body: path.basename(body),
    retentionMonths: retentionMonths(meta.cfg),
  };

  const cwd = await archiveRepo(meta.cwd);
  if (!cwd) return { archived: true, chained: false, id, record, reason: 'no git checkout to chain into' };
  try {
    const { commit } = await append(cwd, record);
    return { archived: true, chained: true, id, commit, record };
  } catch (err) {
    return { archived: true, chained: false, id, record, reason: `could not chain it — ${err.message}` };
  }
}

/** One `git log` line's worth of a commit, split back into its record. */
function parse(entry) {
  const [commit, at, message] = entry.split('\0');
  if (!commit) return null;
  const open = message?.indexOf('{');
  if (open === undefined || open < 0) return null;
  try {
    return { commit, at, record: JSON.parse(message.slice(open)) };
  } catch {
    return null;
  }
}

/**
 * The retrieval, and it is the reason the record lives in the message.
 *
 * `bead` and `key` narrow by `--grep` rather than in JS, so `limit` caps the runs at that
 * bead rather than capping the walk before the filter — a cap applied on the wrong side is
 * how a query silently answers "no runs" about a busy month. `since` and `until` are
 * git's own, taking anything it takes; both are inclusive of the day named.
 *
 * Disposal commits are walked past. They are part of the chain and part of the answer to
 * "what happened to that body", which is `disposals()`, not "which runs were there".
 */
export async function runs({ cwd = null, key = null, bead = null, since = null, until = null, limit = 500 } = {}) {
  const repo = await archiveRepo(cwd);
  if (!repo) return [];
  const args = ['log', '--format=%x01%H%x00%aI%x00%B', `--max-count=${Math.max(1, limit)}`];
  // `·` either side, because `beadcause/bc-eqn1.7` is a prefix of `beadcause/bc-eqn1.70`
  // and a substring match would answer a question about one bead with another bead's runs.
  const needle = key ? `· ${key} ·` : bead ? `/${bead} ·` : null;
  if (needle) args.push('--fixed-strings', `--grep=${needle}`);
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);
  args.push(ARCHIVE_REF);

  const out = await ok(git(repo, args));
  if (!out) return [];
  return out
    .split('\x01')
    .filter((s) => s.trim())
    .map(parse)
    .filter((r) => r && r.record?.type === 'run')
    .map((r) => ({ ...r.record, commit: r.commit, at: r.at, present: fs.existsSync(bodyPath(r.record.id)) }));
}

/** Every disposal the chain records, newest first. What happened to a body that is gone. */
export async function disposals({ cwd = null, since = null, until = null, limit = 200 } = {}) {
  const repo = await archiveRepo(cwd);
  if (!repo) return [];
  const args = ['log', '--format=%x01%H%x00%aI%x00%B', `--max-count=${Math.max(1, limit)}`, '--fixed-strings', '--grep=disposal ·'];
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);
  args.push(ARCHIVE_REF);
  const out = await ok(git(repo, args));
  if (!out) return [];
  return out
    .split('\x01')
    .filter((s) => s.trim())
    .map(parse)
    .filter((r) => r && r.record?.type === 'disposal')
    .map((r) => ({ ...r.record, commit: r.commit, at: r.at }));
}

/** An archived run's body, or null once it has been disposed of. `runs()` says which. */
export function readBody(id) {
  try {
    return fs.readFileSync(bodyPath(id), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Enforce the retention rule: delete every body past it, and **record that we did**.
 *
 * The disposal is itself a commit on the chain, which is the half that makes this a rule
 * rather than a cleanup. A store that quietly deletes has no way to tell an auditor apart
 * from a leaver: "there is no run from March" and "the run from March was disposed of on
 * 3 May under a 24-month rule" are the same absence and completely different answers.
 *
 * The date comes off the run id rather than the file's mtime, because an mtime is the one
 * thing about a file anybody can change by accident — a copy, a restore, a backup tool —
 * and a retention sweep keying on it disposes of the wrong decade quietly.
 *
 * Costs one `readdir` and nothing else on the overwhelmingly common day where nothing is
 * old enough, which is why it is safe to call from the poll cycle.
 */
export async function dispose({ cwd = null, cfg = {}, now = new Date(), months = null } = {}) {
  const keepFor = months ?? retentionMonths(cfg);
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - keepFor);

  let names;
  try {
    names = fs.readdirSync(BODY_DIR);
  } catch {
    return { disposed: [], kept: 0, cutoff: cutoff.toISOString(), months: keepFor };
  }

  const disposed = [];
  let kept = 0;
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const id = name.slice(0, -4);
    const at = runIdDate(id);
    // A body whose name carries no date is left alone rather than guessed at. It cannot
    // have got there from `archiveRun`, and deleting what you cannot date is the failure
    // mode the whole rule is written against.
    if (!at) continue;
    if (at.getTime() >= cutoff.getTime()) {
      kept++;
      continue;
    }
    try {
      fs.rmSync(path.join(BODY_DIR, name), { force: true });
      disposed.push(id);
    } catch {
      kept++;
    }
  }

  if (!disposed.length) return { disposed, kept, cutoff: cutoff.toISOString(), months: keepFor };

  const repo = await archiveRepo(cwd);
  const record = {
    type: 'disposal',
    at: now.toISOString(),
    rule: `bodies are kept ${keepFor} months from the archive date; the chained record of each run is permanent`,
    months: keepFor,
    cutoff: cutoff.toISOString(),
    disposed,
  };
  if (!repo) return { disposed, kept, cutoff: record.cutoff, months: keepFor, chained: false };
  try {
    const { commit } = await append(repo, record);
    return { disposed, kept, cutoff: record.cutoff, months: keepFor, chained: true, commit };
  } catch (err) {
    return { disposed, kept, cutoff: record.cutoff, months: keepFor, chained: false, reason: err.message };
  }
}
