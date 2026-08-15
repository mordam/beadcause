/**
 * The change-management sample — every change that landed in a window, with the evidence
 * for each one, assembled by a command rather than by a person the week before fieldwork.
 *
 * SOC 2 CC8.1 asks that changes to infrastructure, data, software and procedures are
 * authorised, designed, developed, configured, documented, tested, approved and
 * implemented to meet objectives. ISO/IEC 27001:2022 A.8.32 asks the same thing in fewer
 * words. It is the criterion a first-time service organisation most often fails, and the
 * reason is always the same: the answer is a convention rather than a control, so it can
 * only be evidenced by a human assembling screenshots per sampled change, and what the
 * screenshots show is what the convention *usually* produced.
 *
 * Beadcause's answer is a gate, and the gate leaves records nobody assembled:
 *
 * - an unattended session cannot be opened on a bead that is not endorsed
 *   (`assertEndorsed`, lib/endorse.js) — so a change has an authorisation or it has no
 *   session;
 * - a session's work is archived against the bead on `refs/beadcause/sessions/<bead>`
 *   and noted onto the commits it made (lib/sessionlog.js);
 * - a worker does not merge its own branch — it files a merge bead carrying what it ran,
 *   and the work bead is made to depend on it (lib/mergebead.js), so the approval is a
 *   separate agent looking at the whole board;
 * - the merge is noted onto the merge commit, immutably;
 * - and a deploy closes a ship bead against the pull request number (lib/release.js).
 *
 * **This file does not create any of that.** It reads it. That distinction is the whole
 * value of the artefact: an auditor sampling 25 changes from a past quarter is asking for
 * records that were written at the time and could not have been written any other way,
 * and a tool that could only produce them by writing something now would be producing the
 * wrong thing.
 *
 * ## Two stores, and only one of them is immutable
 *
 * lib/reqindex.js draws this line and it is the same line here. **Git is the population.**
 * A commit on the branch, its date, and the note attached to it are anchored to an
 * immutable object; nothing can retroactively add a change to a closed quarter or take one
 * out. **The tracker is the evidence.** A bead's labels, its merge bead, its ship bead are
 * live records that can be edited after the fact.
 *
 * So the population is built from git and only from git, and every fact from the tracker
 * carries a `how` saying where it came from. An auditor is entitled to weigh those
 * differently, and cannot if the report has flattened them into one column of ticks.
 *
 * ## Absent, unknown, and why they are not the same
 *
 * lib/reqcoverage.js makes the argument this file inherits: the failure that sinks a
 * report like this is not being wrong, it is **reading as complete while it is partial**.
 * A change-management sample where every row is a tick is exactly what a report looks like
 * when the tool quietly dropped the rows it could not answer for.
 *
 * Three states, therefore, and the middle one is the one that earns its keep:
 *
 * - `evidenced` — a record exists and says so.
 * - `absent` — the record that would say so does not exist. **This is a finding.** A
 *   change with no merge bead was merged by some path other than the queue, and that is
 *   worth an auditor's attention whether or not it was fine.
 * - `unknown` — nothing here could ask. No tracker configured, a workspace that is not in
 *   this install, a pull request nothing was ever filed against. Not a finding, and never
 *   folded into either of the others, because "could not ask" reported as a tick is a lie
 *   and reported as a finding is noise that trains a reader to ignore the findings.
 *
 * Nothing is ever dropped. A change with no bead at all stays in the population as a row
 * of `absent`, because a change nobody authorised is the single most important row in the
 * sample and the one a tool that filtered on "has a bead" would never show.
 *
 * ## The sample is reproducible or it is not a sample
 *
 * An auditor selects, and then expects to be able to re-select and get the same 25. So
 * selection is a pure function of `(seed, commit)` — a hash, sorted, sliced — with no
 * clock and no randomness in it, and the seed and the population size travel in the
 * output. Given the same window on the same repository, the same seed returns the same
 * rows on any machine, forever. `Math.random()` would make this artefact worthless in the
 * only way that matters: a second run would disagree with the one in the audit file.
 */

/* ------------------------------------------------------------------ the dimensions */

/**
 * The six things this system records about a change, and which of CC8.1's eight verbs
 * each one answers.
 *
 * Six rather than eight because two of the verbs have no separate record here and
 * inventing one would be worse than saying so: *configured* is the same act as developed
 * in a repository where configuration is files in the diff, and *implemented* is the
 * commit the row is keyed on — a column that is true by construction is not evidence, it
 * is decoration, and a reader who sees it tick learns nothing.
 *
 * `verbs` is carried rather than left to the prose because this is the mapping an auditor
 * will argue with, and it should be in the output where they can see it rather than in a
 * comment only we read.
 */
export const DIMENSIONS = [
  {
    key: 'authorised',
    verbs: ['authorised'],
    what: 'an endorsed bead in the tracker that this change closes',
  },
  {
    key: 'designed',
    verbs: ['designed', 'documented'],
    what: 'that bead states what was to be done and why, before the work',
  },
  {
    key: 'developed',
    verbs: ['developed', 'configured'],
    what: 'a session archived against the bead, naming the agent, the branch and the commits',
  },
  {
    key: 'tested',
    verbs: ['tested'],
    what: 'what the worker ran, recorded on the merge bead at delivery',
  },
  {
    key: 'approved',
    verbs: ['approved'],
    what: 'a merge bead the work bead depended on, closed by the merge queue',
  },
  {
    key: 'deployed',
    verbs: ['implemented'],
    what: 'a ship bead for the pull request, closed on the evidence it went live',
  },
];

/** The keys, in report order. Derived so the two can never disagree. */
export const DIMENSION_KEYS = DIMENSIONS.map((d) => d.key);

/** The three states a dimension can be in. See the header on why the third exists. */
export const STATES = ['evidenced', 'absent', 'unknown'];

const cell = (state, how, detail = '') => ({
  state: STATES.includes(state) ? state : 'unknown',
  how: String(how || ''),
  detail: String(detail || ''),
});

/* ------------------------------------------------------------------ reading git */

/**
 * `beadcause: landed <workspace>/<bead>` — the line `noteMerge` writes onto a merge
 * commit, and the strongest thing in this whole file.
 *
 * Anchored to an immutable commit and written at the moment of the merge by the process
 * that performed it. Everything else about a change can be edited afterwards; this cannot
 * be, without rewriting main.
 */
const LANDED_RE = /^beadcause:\s*landed\s+([^\s/]+)\/(\S+)\s*$/m;

export function parseLanded(note) {
  const m = LANDED_RE.exec(String(note || ''));
  return m ? { workspace: m[1], bead: m[2] } : null;
}

/**
 * The pull request a commit came from, in the two shapes GitHub writes.
 *
 * `(#123)` is the suffix on a squash, which is what this repository takes; `Merge pull
 * request #123 from …` is the subject of a merge commit, which is what a repository with
 * a different merge method takes. Both, because the alternative is a tool that reports a
 * whole organisation's changes as commits that skipped the process, on the grounds that
 * they configured GitHub differently — and that report would be wrong in the one direction
 * nobody double-checks, since it reads as diligence.
 */
const PR_RE = /\(#(\d+)\)\s*$/;
const MERGE_SUBJECT_RE = /^Merge pull request #(\d+)\b/;

const prOf = (subject) => Number((PR_RE.exec(subject) || MERGE_SUBJECT_RE.exec(subject) || [])[1] || NaN);

/**
 * A bead id at the head of a subject line — the fallback, and deliberately a weak one.
 *
 * A commit subject is prose that a human can edit and a rebase can rewrite, so an id read
 * out of one is a guess about a change rather than a record of it. It is here because the
 * alternative for a commit whose note is missing is `null`, and `null` sends the row to
 * "no bead at all" — the strongest finding in the report — over what is usually a note
 * that was never written rather than work nobody authorised. The row says which of the two
 * it got (`beadFrom`), and every downstream reader is expected to weigh them differently.
 */
const SUBJECT_BEAD_RE = /^([a-z][a-z0-9]{0,9}-[a-z0-9]+(?:\.\d+)*)\s*:/i;

/**
 * One commit as a change row, or `null` for a commit that is not one.
 *
 * A change is a **pull request that landed**, not a commit: work arrives here in squashes
 * and merges of branches whose individual commits are the session's own working history,
 * and counting those as changes would inflate the population with rows no approval ever
 * covered separately. So the `(#N)` suffix is the filter, and a commit without one is a
 * commit that reached main some other way — which `strays` reports rather than hides.
 */
export function changeOf(commit) {
  const subject = String(commit?.subject || '').trim();
  const pr = prOf(subject);
  if (!Number.isInteger(pr) || pr <= 0) return null;
  const landed = parseLanded(commit?.note);
  const fromSubject = (SUBJECT_BEAD_RE.exec(subject) || [])[1] || null;
  return {
    commit: String(commit?.commit || '').trim(),
    at: String(commit?.at || '').trim(),
    subject,
    pr,
    workspace: landed?.workspace || null,
    bead: landed?.bead || fromSubject,
    // How we know which bead this change is for. `note` is a record; `subject` is a read
    // of prose; `null` is neither, and is the finding.
    beadFrom: landed ? 'note' : fromSubject ? 'subject' : null,
    evidence: null,
    exceptions: [],
  };
}

/**
 * Every commit in the window that landed a pull request, newest first, and everything
 * else that reached the branch in the same window.
 *
 * The second half is not a curiosity. A change-management assertion is about a *complete*
 * population, and a report that silently counted only the commits it could shape into
 * rows would understate the denominator by exactly the changes that skipped the process —
 * which is the population an auditor is looking for.
 */
export function population(commits = []) {
  const changes = [];
  const strays = [];
  for (const c of commits) {
    const row = changeOf(c);
    if (row) changes.push(row);
    else if (c?.commit) strays.push({ commit: String(c.commit), at: String(c.at || ''), subject: String(c.subject || '') });
  }
  return { changes, strays };
}

/* ------------------------------------------------------------------ the evidence */

const nonEmpty = (v) => !!String(v ?? '').trim();

/**
 * The six cells for one change, from the records the gatherer found for it.
 *
 * Pure, and every argument optional — which is what lets the test drive every combination
 * of present and missing record without a tracker, and what makes the `unknown` state
 * reachable rather than theoretical. A caller that could not reach the tracker passes
 * `asked: false` and gets six `unknown`s instead of six findings; that is the difference
 * between a report that says "the daemon was down when I ran this" and one that says the
 * organisation abandoned change management for a day.
 */
export function evidenceFor(change, { bead = null, merge = null, ship = null, release = null, archived = false, asked = true } = {}) {
  const unknown = (how) => cell('unknown', how, 'nothing here could ask the tracker');
  if (!asked) {
    return Object.fromEntries(DIMENSION_KEYS.map((k) => [k, unknown('not asked')]));
  }

  const beadHow = change?.beadFrom === 'note' ? 'git note on the merge commit' : 'the commit subject';

  const authorised = !change?.bead
    ? cell('absent', 'git note on the merge commit', 'no bead is named for this change, by note or by subject')
    : !bead
      ? cell('absent', beadHow, `the tracker has no bead ${change.bead}`)
      : (bead.labels || []).some((l) => String(l).trim() === 'unendorsed')
        ? cell('absent', 'tracker', `${change.bead} still carries \`unendorsed\` — nothing should have opened a session on it`)
        : cell('evidenced', `${beadHow} + tracker`, `${change.bead} — ${String(bead.title || '').trim()}`);

  const designed = !bead
    ? (change?.bead ? cell('absent', beadHow, `no bead ${change.bead} to read`) : cell('absent', 'tracker', 'no bead to read'))
    : nonEmpty(bead.description) || nonEmpty(bead.design)
      ? cell('evidenced', 'tracker', `${String(bead.description || bead.design).trim().replace(/\s+/g, ' ').slice(0, 160)}`)
      : cell('absent', 'tracker', `${change.bead} carries neither a description nor a design`);

  const developed = !change?.bead
    ? cell('unknown', 'session archive', 'no bead to look up an archive for')
    : archived
      ? cell('evidenced', `refs/beadcause/sessions/${change.bead}`, 'a session is archived against the bead')
      : cell('absent', 'session archive', `nothing is archived at refs/beadcause/sessions/${change.bead}`);

  const tested = !merge
    ? cell('unknown', 'merge bead', `no merge bead names pull request #${change?.pr}`)
    : nonEmpty(merge.tests)
      ? cell('evidenced', `merge bead ${merge.id}`, String(merge.tests).replace(/\s+/g, ' ').slice(0, 240))
      : cell('absent', `merge bead ${merge.id}`, 'the delivery recorded no test run');

  const approved = !merge
    ? cell('absent', 'merge bead', `no merge-queue bead names pull request #${change?.pr} — it was merged by some other path`)
    : merge.status === 'closed'
      ? cell('evidenced', `merge bead ${merge.id}`, 'filed by the worker, merged and closed by the merge queue')
      : cell('absent', `merge bead ${merge.id}`, 'the merge bead is still open, so nothing recorded an approval');

  /**
   * Two records, and the ledger is asked first because it is the one that still exists.
   *
   * A deploy used to close a `ship` bead somebody pressed, and that bead is a permanent
   * record in the tracker. Auto-ship replaced the tap with a settle window, and a merge
   * that ships itself files no ship bead at all — so on this repository the bead is the
   * record for pull requests up to #313 and the ledger is the record after it, and a
   * reader who only knew about one of them would report half a year of deployments as
   * unevidenced. Both, therefore, newest mechanism first.
   */
  const deployed = release?.shippedAt
    ? cell('evidenced', 'release ledger', `shipped ${release.shippedAt}${release.sha ? ` as ${String(release.sha).slice(0, 12)}` : ''}`)
    : ship
      ? ship.status === 'closed'
        ? cell('evidenced', `ship bead ${ship.id}`, String(ship.closeReason || 'closed on the evidence the merge went live').replace(/\s+/g, ' ').slice(0, 240))
        : cell('absent', `ship bead ${ship.id}`, 'the ship bead is still open — this change is merged and not live')
      : release
        ? cell('absent', 'release ledger', 'the ledger has this merge and no deployment against it')
        : cell('unknown', 'release ledger, ship bead', `neither names pull request #${change?.pr}`);

  return { authorised, designed, developed, tested, approved, deployed };
}

/** The dimensions of one row that are findings. `unknown` is not one — see the header. */
export const exceptionsOf = (evidence = {}) => DIMENSION_KEYS.filter((k) => evidence[k]?.state === 'absent');

/* ------------------------------------------------------------------ the selection */

/**
 * FNV-1a, 32-bit, unsigned.
 *
 * A hash rather than a seeded PRNG because the property that matters is not randomness,
 * it is that the same `(seed, commit)` gives the same number on any machine and in any
 * version of node — and a PRNG's guarantee is about a *sequence*, which makes selection
 * depend on the order the population arrived in. Ten lines of arithmetic with no
 * dependency and no state is the right size for that.
 */
export function hashKey(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * `size` rows chosen from the population, reproducibly.
 *
 * Sorted back into date order before it is handed out, because the selection order is an
 * artefact of the hash and a report whose rows run in hash order reads as though somebody
 * shuffled it to make a point.
 *
 * A population at or below `size` is returned whole — an auditor asking for 25 from a
 * quarter that had 11 changes wants the 11, not a refusal.
 */
export function sampleOf(rows = [], { size = 25, seed = 1 } = {}) {
  const n = Math.max(0, Math.floor(Number(size) || 0));
  const all = rows.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!n || all.length <= n) return all;
  return all
    .map((row) => ({ row, key: hashKey(`${seed}:${row.commit}`) }))
    .sort((a, b) => a.key - b.key || a.row.commit.localeCompare(b.row.commit))
    .slice(0, n)
    .map((e) => e.row)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/* ------------------------------------------------------------------ the totals */

/**
 * How the sample came out, per dimension and overall.
 *
 * `rows` here is the *sample*, not the population, and that is deliberate: an auditor's
 * conclusion is drawn from what they sampled, and totals computed over the population
 * would let a report claim coverage for rows nobody looked at.
 */
export function tally(rows = []) {
  const dimensions = DIMENSIONS.map((d) => {
    const counts = { evidenced: 0, absent: 0, unknown: 0 };
    for (const row of rows) {
      const state = row?.evidence?.[d.key]?.state;
      if (state && counts[state] !== undefined) counts[state] += 1;
    }
    return { ...d, ...counts };
  });
  /**
   * Clean is **every column evidenced**, not "no findings".
   *
   * The difference is the one bug this file could ship that would matter: a row of six
   * `unknown`s has no findings on it, so "no findings" counts a change nothing could be
   * asked about as a change with a complete record — and a run against a checkout with no
   * tracker reported 47 of 47 clean, which is the most confident possible way to say
   * nothing at all. Three groups, and they add up to the sample.
   */
  const clean = rows.filter((r) => DIMENSION_KEYS.every((k) => r?.evidence?.[k]?.state === 'evidenced')).length;
  const withExceptions = rows.filter((r) => (r.exceptions || []).length).length;
  return {
    dimensions,
    sampled: rows.length,
    clean,
    withExceptions,
    /** Rows with no finding and no complete record: something could not be asked. */
    unanswered: rows.length - clean - withExceptions,
    exceptions: rows.reduce((n, r) => n + (r.exceptions || []).length, 0),
  };
}

/**
 * One line, and it states every denominator it has.
 *
 * `describeCoverage` in lib/reqcoverage.js makes the argument: "18 rows clean" is a
 * number that sounds like a result and cannot be checked, where "18 of 25 sampled, from a
 * population of 214" is the same fact and cannot be mistaken for anything else.
 */
export function describeSample(result) {
  const t = result?.totals;
  if (!t?.sampled) return 'no changes landed in that window';
  const parts = [
    `${t.clean} of ${t.sampled} sampled changes carry every record`,
    `${t.exceptions} exception${t.exceptions === 1 ? '' : 's'} across ${t.withExceptions} row${t.withExceptions === 1 ? '' : 's'}`,
    `from a population of ${result.population}`,
  ];
  // Said even when it is the whole sample, and especially then: a run that could not reach
  // the tracker must not be reportable as a run that found nothing wrong.
  if (t.unanswered) parts.push(`${t.unanswered} row${t.unanswered === 1 ? '' : 's'} nothing could be asked about`);
  if (result.strays?.length) parts.push(`${result.strays.length} commit${result.strays.length === 1 ? '' : 's'} reached the branch outside a pull request`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ the artefact */

const MARK = { evidenced: '✓', absent: '✗', unknown: '?' };

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * The sample as markdown — the thing that is handed to a CPA firm.
 *
 * Written as one document rather than a table alone, because a table of ticks with no
 * statement of what was asked, over what window, from which population, and by what
 * selection is not evidence: it is a claim, and the auditor's first question is how it was
 * produced. The header answers that before the table, and the legend answers what a `?`
 * means before a reader has to guess it means the same as a `✗`.
 */
export function renderReport(result) {
  const out = [];
  const t = result.totals;
  out.push('# Change management sample');
  out.push('');
  out.push(`Generated ${result.generatedAt} by \`beadcause-changes sample\`, from ${result.repo || 'this repository'}.`);
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| Window | ${esc(result.from || 'the first commit')} → ${esc(result.to || 'now')} |`);
  out.push(`| Branch | \`${esc(result.branch)}\` at \`${esc(String(result.head).slice(0, 12))}\` |`);
  out.push(`| Population | ${result.population} changes landed |`);
  out.push(`| Sampled | ${t.sampled}, selected by seed \`${esc(result.seed)}\` |`);
  out.push(`| Clean | ${t.clean} of ${t.sampled} |`);
  out.push('');
  out.push(
    'The selection is a pure function of the seed and the commit hash, so re-running this ' +
      'command with the same window and the same seed returns the same rows.'
  );
  out.push('');
  if (result.asked === false) {
    // Loud, and above the table rather than in a footnote. A reader who reaches a page of
    // `?` and only then learns why has already formed an impression of the organisation.
    out.push(
      '> **The tracker could not be read when this was generated, so no column below is ' +
        'evidenced.** The population is complete — it comes from git — but every record ' +
        'that lives in the tracker reads as `?`. This is a fault in the run, not a finding ' +
        'about the changes; re-run it where the tracker can be reached.'
    );
    out.push('');
  }
  out.push('## What each column is evidence of');
  out.push('');
  out.push('| Column | CC8.1 | Evidence |');
  out.push('|---|---|---|');
  for (const d of DIMENSIONS) out.push(`| ${d.key} | ${d.verbs.join(', ')} | ${esc(d.what)} |`);
  out.push('');
  out.push('`✓` a record exists and says so · `✗` the record that would say so does not exist — a finding · `?` nothing here could ask.');
  out.push('');
  out.push('## The sample');
  out.push('');
  out.push(`| # | Landed | Change | Bead | ${DIMENSION_KEYS.join(' | ')} |`);
  out.push(`|---|---|---|---|${DIMENSION_KEYS.map(() => '---').join('|')}|`);
  result.sample.forEach((row, i) => {
    const marks = DIMENSION_KEYS.map((k) => MARK[row.evidence?.[k]?.state] || '?').join(' | ');
    const bead = row.bead ? `${row.bead}${row.beadFrom === 'subject' ? ' *(from the subject)*' : ''}` : '**none**';
    out.push(`| ${i + 1} | ${esc(String(row.at).slice(0, 10))} | [#${row.pr}](${result.prUrl ? `${result.prUrl}${row.pr}` : '#'}) ${esc(row.subject.replace(PR_RE, '').trim().slice(0, 70))} | ${esc(bead)} | ${marks} |`);
  });
  out.push('');
  out.push('## Findings');
  out.push('');
  const withEx = result.sample.filter((r) => (r.exceptions || []).length);
  if (!withEx.length) out.push('None. Every sampled change carries every record.');
  for (const row of withEx) {
    out.push(`### #${row.pr} — ${esc(row.subject.replace(PR_RE, '').trim())}`);
    out.push('');
    for (const key of row.exceptions) out.push(`- **${key}** — ${esc(row.evidence[key].detail)} (looked in: ${esc(row.evidence[key].how)})`);
    out.push('');
  }
  out.push('## Totals');
  out.push('');
  out.push('| Column | evidenced | absent | unknown |');
  out.push('|---|---|---|---|');
  for (const d of t.dimensions) out.push(`| ${d.key} | ${d.evidenced} | ${d.absent} | ${d.unknown} |`);
  out.push('');
  // Said only when it is load-bearing, and then said plainly. An `unknown` on `deployed`
  // over a window that begins before the ledger does is a retention limit rather than a
  // missing deployment, and those two conclusions are as far apart as conclusions get.
  if (result.ledgerSince && t.dimensions.find((d) => d.key === 'deployed')?.unknown) {
    out.push(
      `> **The release ledger only goes back to ${esc(result.ledgerSince)}.** It prunes, where every ` +
        'other record here is permanent, so a `?` in the deployed column over a window that starts ' +
        'before that date is this file having forgotten rather than a change that never shipped.'
    );
    out.push('');
  }
  if (result.strays?.length) {
    out.push('## Commits that reached the branch outside a pull request');
    out.push('');
    out.push(
      `${result.strays.length} in this window. They are outside the population above because no ` +
        'pull request, and therefore no approval, covers them individually.'
    );
    out.push('');
    for (const s of result.strays.slice(0, 40)) out.push(`- \`${esc(s.commit.slice(0, 12))}\` ${esc(String(s.at).slice(0, 10))} — ${esc(s.subject.slice(0, 90))}`);
    if (result.strays.length > 40) out.push(`- … and ${result.strays.length - 40} more`);
    out.push('');
  }
  return out.join('\n');
}
