/**
 * Is this bead already on the graph? — the net in front of `Bd.duplicateOf`.
 *
 * lib/dupe.js is a word-set Dice coefficient at 0.9, which is *near-verbatim* and says so.
 * It exists for bc-j6x and bc-ec6, which were byte-identical. It catches nothing else, and
 * the measurement that motivates this file is what "nothing else" means on a real graph:
 *
 *   Twelve live beads carry `superseded-by:` — every one a duplicate a worker found by
 *   hand, after the fact. Scored against the bead each was superseded by, with this
 *   repo's own `titleSimilarity`, they run **0.07 to 0.64**. Median 0.30. Not one is
 *   within reach of the bar. Eleven of the twelve carry `agent-filed`.
 *
 * They are not one sentence typed twice. They are the same defect written from a different
 * angle by a session that had not read the tracker — *"test/finishedepic.mjs is red on
 * main"* against *"the finished-epic sweep opens a session with no window"*.
 *
 * ## Why the threshold is not simply lowered
 *
 * Because it was measured, over all 45,451 live non-`human` pairs in beadcause:
 *
 *     dice >= 0.50  ->  flags  11 pairs, catches  2/12
 *     dice >= 0.40  ->  flags  45 pairs, catches  4/12
 *     dice >= 0.35  ->  flags 100 pairs, catches  5/12
 *
 * Eight times more noise than signal at the loosest bar that catches even five, and the
 * noise lands on the one path where noise costs the most. Requiring a shared source file
 * alongside it halves the flags and adds no recall at all. Structure on its own is worse:
 * 583 of those pairs share files at Jaccard >= 0.5, against twelve real duplicates. This is
 * lib/dupesweep.js's own conclusion, re-measured on a graph a fortnight older, and it still
 * holds. **No lexical threshold separates these two populations**, because the thing that
 * separates them is what the words mean.
 *
 * ## So: shortlist cheaply, judge semantically
 *
 * 1. `shortlist` — pure, no model, no spawn. Three signals, none of them decisive: a shared
 *    file surface, kinship (two beads in one epic's family), and title similarity well below
 *    the near-verbatim bar. Anything clearing any of them is a candidate; the top
 *    `SHORTLIST_MAX` by combined score go to the judge. Replayed over the twelve pairs at
 *    the moment the second of each was filed, the first is in that top eight **ten times**.
 *    The two it misses are epics with generic titles and no path in them, which nothing
 *    reading text could have found.
 * 2. `sameJob` — one headless `claude -p` over that shortlist, answering one question. This
 *    is the only step that can tell "the same defect, different words" from "shares a few
 *    words", and it is affordable precisely because step 1 handed it eight rows rather than
 *    three hundred.
 *
 * The shortlist is deliberately generous and the judge deliberately strict. A candidate that
 * should not have been shown costs a line in a prompt; a duplicate never shown cannot be
 * caught at all.
 *
 * ## It runs as the chat session's foundation, not a kind of its own
 *
 * lib/sessionaudit.js's argument, and this is the same case: what a read-only judge needs is
 * exactly the read-only surface every other reading agent already has, and a new foundation
 * kind owes five registrations across lib/ before it can run at all. Nothing here writes.
 *
 * Nothing in this file touches the tracker. `shortlist`, `judgePrompt` and `parseVerdict`
 * are pure — rows in, verdict out — and `sameJob` owns one spawn and no writes. The refusal,
 * the comment onto the covering bead and the exit code are `bin/file.js`'s, because the
 * decision to *not file* belongs to the path that was asked to file.
 */
import YAML from 'yaml';
import { runHeadless } from './agentrun.js';
import { titleSimilarity, LIVE_STATUSES } from './dupe.js';
import { declaredFiles, guessedFiles, overlap } from './beadfiles.js';

/**
 * How alike two titles must be to earn a place on the shortlist on that account alone.
 *
 * 0.25, and it is a *candidate* bar rather than a verdict bar — the number where the twelve
 * pairs stop being missed, not a number at which two titles mean the same thing. At 0.30 the
 * replay finds nine of twelve; at 0.25, ten. Below it the candidate set roughly doubles for
 * no further recall (median 28 rows at 0.25, 35 at 0.20, same two misses), which is the
 * shape of a floor that has stopped buying anything.
 */
export const TITLE_FLOOR = 0.25;

/** How many rows reach the judge. Eight is where the replay's hit rate stops improving. */
export const SHORTLIST_MAX = 8;

/** How long the judge may run. It is on a worker's critical path, so it is short. */
export const TIMEOUT_MS = 2 * 60 * 1000;

/** A formulaic title is not evidence of anything — `duplicateOf`'s exclusion, for its reason. */
const HUMAN_LABEL = 'human';

/** How much of a description the judge is shown per row. Enough to recognise, not to read. */
const EXCERPT = 600;

/**
 * Every field a bead's file surface could be written in, as one string.
 *
 * `guessedFiles` reads its own fields off a row; this exists for the *candidate*, which is
 * not a row yet — it is the parsed YAML a session piped in, where the description is `body`
 * or `description` and the rest are separate keys that would otherwise never be read.
 */
const textOf = (row) =>
  [row?.description, row?.body, row?.acceptance_criteria, row?.acceptance, row?.design, row?.notes, row?.rationale]
    .filter(Boolean)
    .join('\n\n');

/**
 * The paths a bead names, declared and guessed together.
 *
 * **The union, where `surfaceOf` takes declared *or* guessed.** That is not a disagreement
 * with lib/beadfiles.js — it is a different question. `surfaceOf` answers "what does this
 * bead claim it will touch", where mixing a declaration with a guess would produce a surface
 * whose strength no reader could name, and strength decides whether work may be held. Here
 * nothing is held: the question is "what is this bead *about*", every path in it is evidence
 * toward that, and dropping the prose the moment a `beadfiles` block exists measurably lost
 * pairs in the replay — bc-jjdar.2 and bc-mwhkg.1 share three paths in prose and none once
 * the declaration wins.
 */
export function surfaceUnion(row, dirs = []) {
  const merged = { ...row, description: textOf(row) };
  return [...new Set([...declaredFiles(merged), ...guessedFiles(merged, dirs)])];
}

/**
 * The family an id belongs to — `bc-7qo.18` and `bc-7qo.19` are both `bc-7qo`.
 *
 * A root id is its own family and that is treated as no family at all, because "these two
 * beads are both top-level" is true of most of the graph. What earns the signal is two
 * *children* of one epic: three of the twelve pairs are exactly that, an epic replanned so
 * that two of its own tasks describe one job.
 */
export const familyOf = (id) => String(id || '').split('.')[0];

/** Are these two beads children of one family? */
const kin = (a, b) => {
  const fa = familyOf(a);
  return fa === familyOf(b) && fa !== String(a || '') && fa !== String(b || '');
};

/**
 * The live beads this one might already be, best first.
 *
 * Pure: rows in, ranked candidates out, nothing spawned and nothing read from disk beyond
 * `guessedFiles`'s existence check against `dirs`.
 *
 * `rows` is a `bd list --status=open,in_progress,blocked` — the same call `bin/file.js`
 * already makes for `annotateDuplicates`, so this adds no round trip. `ignore` drops ids the
 * caller knows are not candidates: the bead the session is filing *from*, above all, which a
 * discovery routinely resembles because it was found while working it.
 *
 * The score is a ranking, not a probability, and the weights say only what order the judge
 * should see things in: a shared file outranks a shared word, and a sibling outranks a
 * stranger. Nothing downstream compares it to a threshold.
 */
export function shortlist(candidate, rows, { dirs = [], ignore = [], limit = SHORTLIST_MAX, floor = TITLE_FLOOR } = {}) {
  const title = String(candidate?.title || '').trim();
  if (!title) return [];
  const skip = new Set((ignore || []).filter(Boolean));
  const mine = surfaceUnion(candidate, dirs);

  const scored = [];
  for (const row of rows || []) {
    if (!row || !row.title || skip.has(row.id)) continue;
    if (!LIVE_STATUSES.has(String(row.status || 'open'))) continue;
    if ((row.labels || []).includes(HUMAN_LABEL)) continue;

    const shared = overlap(mine, surfaceUnion(row, dirs), { limit: 3 });
    const dice = titleSimilarity(title, row.title);
    const sibling = kin(candidate?.id || '', row.id);
    if (!shared.length && dice < floor && !sibling) continue;

    scored.push({
      id: row.id,
      title: row.title,
      status: row.status || 'open',
      description: String(row.description || '').slice(0, EXCERPT),
      shared: shared.map((h) => h.path),
      sibling,
      score: (shared.length ? 0.5 + 0.1 * Math.min(shared.length, 3) : 0) + (sibling ? 0.25 : 0) + dice * 0.4,
    });
  }

  // Ties break on id so two machines reading one graph shortlist in one order —
  // lib/dupesweep.js's reason, and what keeps a test asserting *which* row won honest.
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.slice(0, Math.max(0, limit));
}

/** The block the judge answers in — one spelling, read back by `parseVerdict`. */
const BLOCK_RE = /```samejob\s*\n([\s\S]*?)```/;

/**
 * What the judge is asked.
 *
 * Two instructions carry the whole design. **Same job, not same area** — the failure mode of
 * every cheap duplicate check is that two beads about `lib/advocate.js` look alike, and the
 * shortlist deliberately handed over rows that share files precisely so the judge can throw
 * most of them out. And **when unsure, say none** — a wrong refusal loses a real discovery a
 * session found at 02:00 and cannot re-find, while a wrong pass costs one duplicate bead of
 * the kind the graph has been absorbing all along. The errors are not symmetric and the
 * prompt says so.
 */
export function judgePrompt(candidate, rows) {
  const body = String(candidate?.description || candidate?.body || '').slice(0, 2000);
  const lines = [
    'You are deciding whether a bead a worker is about to file is **the same job** as one already on the tracker.',
    '',
    '## The bead about to be filed',
    '',
    `**${candidate?.title || ''}**`,
    '',
    body || '_(no description)_',
    '',
    '## Beads already open',
    '',
  ];
  for (const r of rows) {
    lines.push(`### ${r.id} — ${r.title}`);
    const why = [r.shared.length ? `shares ${r.shared.join(', ')}` : '', r.sibling ? 'same epic family' : '']
      .filter(Boolean)
      .join('; ');
    if (why) lines.push(`_(${why})_`);
    lines.push('');
    if (r.description) lines.push(`${r.description}\n`);
  }
  lines.push(
    '## What to answer',
    '',
    'Name a bead only if working it would do the job the new bead describes — the same defect, the',
    'same change, such that filing the new one would put two sessions on one piece of work. Two beads',
    'about the same file, the same subsystem or the same epic are **not** the same job; neither is a',
    'follow-up to work one of them already did. Most of the list above shares a file with the new bead',
    'and that is why it is in front of you, not evidence of anything.',
    '',
    '**If you are not sure, answer `none`.** A wrong `none` costs one duplicate bead, which is ordinary',
    'and gets tidied later. A wrong name throws away a real discovery a session cannot find again.',
    '',
    'Read the beads if you need to — you have the checkout and read-only `bd`. Answer with exactly one',
    'fenced block and nothing after it:',
    '',
    '```samejob',
    'duplicate: bc-xyz   # or: none',
    'why: one sentence saying what makes them one job, or why none of them is',
    '```',
  );
  return lines.join('\n');
}

/**
 * The judge's answer, read back — `{ duplicate, why }`, `duplicate` null for none.
 *
 * Everything unreadable is `none`: no block, a block that is not YAML, a name that is not one
 * of the rows it was shown. That last one matters most and is the reason `allowed` is a
 * parameter rather than a courtesy — a model naming a plausible id it invented, or naming the
 * bead being filed, would otherwise refuse a filing in favour of a bead that does not exist.
 * A refusal has to be traceable to a row somebody can go and read.
 */
export function parseVerdict(text, allowed = []) {
  const none = { duplicate: null, why: '' };
  const m = BLOCK_RE.exec(String(text || ''));
  if (!m) return none;
  let doc;
  try {
    doc = YAML.parse(m[1]);
  } catch {
    return none;
  }
  if (!doc || typeof doc !== 'object') return none;
  const why = String(doc.why || '').trim();
  const id = String(doc.duplicate ?? '').trim();
  if (!id || /^(none|null|no|n\/a)$/i.test(id)) return { duplicate: null, why };
  const ok = new Set((allowed || []).filter(Boolean));
  if (!ok.has(id)) return { duplicate: null, why };
  return { duplicate: id, why };
}

/**
 * Is this bead already on the graph? — the whole question, one answer.
 *
 * `{ duplicate, why, rows }`, `duplicate` null when it is not, and `rows` is what the judge
 * was shown so the caller can say what was considered. An empty shortlist skips the spawn
 * entirely, which is the overwhelmingly common case: most filings resemble nothing.
 *
 * **Every failure is a pass, not a throw.** A judge that cannot start, times out, or answers
 * nonsense must not lose a discovery — that is the same call `bin/file.js` already makes when
 * the duplicate lookup itself fails, and the same one lib/dupesweep.js makes about a sweep
 * that is "a courtesy on top of the tick". `onWarn` is how the session hears about it.
 *
 * `runImpl` is injected for the reason every spawn in this repo is: the paths worth testing
 * are the ones you cannot produce for real from inside a test.
 */
export async function sameJob(
  candidate,
  rows,
  { dirs = [], ignore = [], cfg = null, dir = process.cwd(), key = null, onWarn = () => {}, runImpl = runHeadless } = {}
) {
  const list = shortlist(candidate, rows, { dirs, ignore });
  if (!list.length) return { duplicate: null, why: '', rows: [] };

  let answer = '';
  try {
    answer = await runImpl({
      dir,
      prompt: judgePrompt(candidate, list),
      systemText:
        'You judge whether two beads describe one job. You read; you never write. ' +
        'You answer in one fenced `samejob` block and nothing else.',
      timeoutMs: TIMEOUT_MS,
      cfg,
      key,
      meta: { kind: 'samejob', candidates: list.length },
      tmpPrefix: 'beadcause-samejob',
    });
  } catch (err) {
    onWarn(`filing without the duplicate judge — ${String(err?.message || err).split('\n')[0]}`);
    return { duplicate: null, why: '', rows: list };
  }

  const verdict = parseVerdict(answer, list.map((r) => r.id));
  return { ...verdict, rows: list };
}

/**
 * What goes on the bead that already covered this, when a filing is refused.
 *
 * The evidence, not a notification. The session that ran the filing had read something the
 * covering bead has not got — that is why it thought this was new work — and the whole point
 * of refusing rather than filing is that the observation survives the refusal. A comment
 * saying only "a duplicate was refused" would throw away the one thing worth keeping.
 */
export function refusalComment(candidate, { why = '', from = '' } = {}) {
  const body = String(candidate?.description || candidate?.body || '').trim();
  return [
    `**A session tried to file this again** — refused as the same job, and what it had to say is below.`,
    why ? `\nWhy they are one job: ${why}` : '',
    from ? `\nFound while working ${from}.` : '',
    '',
    `> **${candidate?.title || ''}**`,
    body ? `\n${body}` : '',
    '',
    'Filed nowhere: `beadcause-file` refused it rather than opening a second bead on one job. If this is ' +
      'actually different work, run the filing again with `--force` and say on both what the difference is.',
  ]
    .filter((s) => s !== '')
    .join('\n');
}
