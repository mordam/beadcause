/**
 * Which documents are controlled, who owns them, and when each one goes stale.
 *
 * The documentation here is unusually good and entirely uncontrolled. `README.md` is
 * about nineteen thousand lines and is the specification for the whole system; `docs/`
 * holds a handful more; two of the registers this programme has already produced are
 * source files. Not one of them carries a version, an owner, an approval or a date it
 * was last looked at. An auditor does not read a document for accuracy — they ask who
 * approved it, which version is current, and when it was last reviewed, and until this
 * file existed there was no answer to any of the three.
 *
 * **This is not a licence to turn the README into a compliance manual.** Its density is
 * the reason the whole programme is tractable, and a document rewritten for an auditor
 * is a document the people who need it stop reading. So what lands is a control *layer*
 * over documents that are left exactly as they are: an owner and a review period per
 * document, an approval that names somebody, and a check that fails the repo when a
 * review is overdue. The change history is already in git and is made legible by
 * `history()` rather than transcribed into a table nobody maintains.
 *
 * ## Why the check is allowed to fail on a day nobody committed anything
 *
 * `lib/checkaudit.js` exists because a check that has silently not passed for a month
 * is worse than no check. **An overdue document review is that same failure with a
 * longer fuse**, and it is worse in one specific way: nothing about a stale document
 * looks stale. It reads exactly as well on the day it stops being true as it did the
 * day it was approved, so the only thing that can catch it is a date and something
 * willing to fail on it.
 *
 * Which means this check will one day turn `main` red with no diff behind it, and that
 * is the control operating rather than a bug in it. Two things soften it into something
 * a person can act on rather than route around:
 *
 * - **It says so first.** `WARN_DAYS` before the date, `reviewStatus` returns
 *   `approaching` and `registerProblems` reports it as a warning rather than a problem,
 *   so the repo asks a month before it insists.
 * - **The fix is a real review, and the failure says what one is.** Read the document,
 *   change what is no longer true, then move `reviewedOn` — in that order. Moving the
 *   date alone passes this check and is the one way to make the register lie, which is
 *   why `version` has to move with it: a document that was reviewed and needed no change
 *   still gets a new version, because "somebody looked at this on that date" is the
 *   claim being recorded and it is a different claim each time.
 *
 * ## What an entry is, and what it deliberately is not
 *
 * An entry is a *document*, not a file — `path` plus an optional `section`, because the
 * README is one file holding several documents and the four this programme cares about
 * are sections of it. Naming the section makes the ownership real (a heading that is
 * renamed fails this check by name) without splitting a file whose density is its whole
 * value. It also means the substrate can carry a document that is not about code and
 * not a README section at all: `bc-eqn1.1`'s AI policy, scope statement,
 * interested-parties register and roles table are four documents into this same
 * register, and none of them is a source file.
 *
 * `approvedBy` and `owner` are *people*, written as names rather than roles, and today
 * they are the same person because this install has one operator. That is a fact about
 * beadcause and not a claim about segregation of duties: `bc-eqn1.1` settled the legal
 * entity and the top-management role (`bc-jlpj` asked which entity the certificate
 * names), and `lib/aims.js` is where the roles that sign are written down. What this
 * file refuses to do is invent an approver, because an approval nobody gave is worse
 * than an approval nobody has recorded.
 *
 * ## A document may be a draft, and saying so is the whole point
 *
 * `bc-eqn1.1` produced four documents an agent could write and only a person can sign:
 * the AI policy commits an organisation to something, and a system that stamped it
 * approved on a date nobody approved anything would be manufacturing the exact artefact
 * this programme exists to make impossible. So an entry may carry `awaitingApproval` —
 * the name of whoever has to sign — and when it does, `approvedBy` and `approvedOn` must
 * both be `null`. Not "not yet filled in": *null*, checked, because a draft with an
 * approver's name idling in the approval field is one careless edit away from a lie.
 *
 * A draft **warns rather than fails**, every time anybody asks. Failing would turn the
 * repo red on a state only a signature can clear, which is not something a terminal can
 * do and not something an unattended session should be able to route around — and the
 * fix an unattended session would reach for is precisely the fabricated approval. The
 * review clock still runs, because a draft that has sat unsigned for a year is a
 * different problem and the date is what finds it.
 *
 * ## What is deliberately not controlled, so nobody has to wonder
 *
 * `docs/` is not in the register and should not be. `ide-websocket-spike.md` is a spike
 * writeup, `ux-review.md` is one person's read of a screen on a day, `architecture.html`
 * is a picture — each of them is a *record of something that happened*, and a record does
 * not go stale, it just gets older. What goes stale is a document that makes a standing
 * claim about how the system works today, and that is the whole of the test for whether
 * something belongs below. Controlling a spike writeup would produce a review date
 * somebody has to clear by re-reading a note about a decision that was made and is
 * finished, which is how a register full of documents becomes a register nobody reviews.
 *
 * A leaf, on purpose, like `lib/evidence.js` and `lib/organisation.js`: it reads the
 * repo it is handed and nothing else, so a check, a service and a script can each hold
 * it without one of them dragging in a config directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The longest a review period may be, in months.
 *
 * Twelve is the outside of what "reviewed annually" means and this allows twice it, so
 * the ceiling is not a policy so much as a refusal: a period longer than two years is
 * not a review cycle, it is a way of writing "never" that passes a check. Anything
 * describing something that moves — the supplier register, anything naming a third
 * party's terms — should be well under it and says so in its own entry.
 */
export const MAX_REVIEW_MONTHS = 24;

/** How long before a review falls due the repo starts saying so rather than failing. */
export const WARN_DAYS = 30;

/** The three things a controlled document can be, relative to its own review date. */
export const STATE = Object.freeze(['current', 'approaching', 'overdue']);

/* ------------------------------------------------------------------ dates */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` as a UTC timestamp, or `null` for anything that is not one. */
export function parseDate(iso) {
  if (!DATE_RE.test(String(iso ?? ''))) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  // Date.UTC rolls 2026-02-31 forward into March rather than refusing it, and a date
  // that silently means a different day is the one kind of typo this must not accept.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t;
}

/**
 * `iso` plus `months`, clamped to the end of the month it lands in.
 *
 * The 31st of January plus one month is the 28th of February, not the 3rd of March.
 * Rolling over would put a review date in a month the person who set the period did not
 * choose, and the direction it rolls is always *later*, which is the wrong direction for
 * anything whose whole job is to come due.
 */
export function addMonths(iso, months) {
  const t = parseDate(iso);
  if (t === null) return null;
  const from = new Date(t);
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + Number(months);
  const day = from.getUTCDate();
  const lastOfTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const at = new Date(Date.UTC(y, m, Math.min(day, lastOfTarget)));
  return at.toISOString().slice(0, 10);
}

/**
 * When this document's review falls due, how many days away that is, and what it is.
 *
 * `days` is whole days and counts down: negative means the date has passed. `now` is a
 * parameter rather than a call to the clock so a check can point this at a date and see
 * each of the three states fire — a rule only ever run against a register that passes
 * is a rule nobody has seen fail.
 */
export function reviewStatus(entry, now = new Date()) {
  const due = addMonths(entry?.reviewedOn, entry?.reviewMonths);
  if (due === null || !Number.isInteger(Number(entry?.reviewMonths))) return { due: null, days: null, state: null };
  const dueAt = parseDate(due);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((dueAt - today) / DAY_MS);
  const state = days < 0 ? 'overdue' : days <= WARN_DAYS ? 'approaching' : 'current';
  return { due, days, state };
}

/* --------------------------------------------------------- the register */

/**
 * Every controlled document, and everything an auditor asks about one.
 *
 * Ordered by how much of the system each one decides, which is also roughly the order
 * somebody new would read them in. Adding one is a code change on purpose: a register
 * you can extend from a form is a register that grows entries nobody read.
 */
export const REGISTER = Object.freeze([
  {
    id: 'readme',
    title: 'Beadcause — the specification',
    path: 'README.md',
    section: null,
    owner: 'Adam Morgan',
    approvedBy: 'Adam Morgan',
    approvedOn: '2026-08-15',
    version: '2026.08.15',
    reviewedOn: '2026-08-15',
    reviewMonths: 12,
    serves: 'ISO/IEC 42001 Clause 7.5 — documented information the AI management system needs, kept current and available.',
    why:
      'It is the specification. Every behaviour claimed to an auditor is claimed here first, and a section describing ' +
      'something the code stopped doing is the exact shape of a control described but not operating.',
  },
  {
    id: 'supplier-register',
    title: 'Supplier and third-party register',
    path: 'lib/suppliers.js',
    section: null,
    owner: 'Adam Morgan',
    approvedBy: 'Adam Morgan',
    approvedOn: '2026-08-15',
    version: '1.0.0',
    reviewedOn: '2026-08-15',
    reviewMonths: 6,
    serves: 'ISO/IEC 42001 Annex A.10 — third parties and suppliers, what is sent to each and under what terms.',
    why:
      'Every entry restates somebody else\'s terms, and those change without telling anybody here. Six months rather ' +
      'than twelve for that reason alone: a stale answer about what a supplier does with prompt content is worse than none.',
  },
  {
    id: 'data-store-register',
    title: 'Data stores — provenance, purpose, access, personal data and disposal',
    path: 'lib/datastores.js',
    section: null,
    owner: 'Adam Morgan',
    approvedBy: 'Adam Morgan',
    approvedOn: '2026-08-17',
    version: '1.0.0',
    reviewedOn: '2026-08-17',
    reviewMonths: 12,
    serves: 'ISO/IEC 42001 Annex A.7 — data for AI systems: where it came from, what it is used for, whether it is adequate for that, who can reach it and when it goes.',
    why:
      'It is the register that says where personal data is, and the wrong kind of wrong sentence in it — "this store holds ' +
      'none" — reads exactly as well after the store starts holding some. The coverage check catches a new store; only a ' +
      'date catches a store whose contents changed under a sentence that was true when it was written.',
  },
  {
    id: 'evidence-register',
    title: 'Evidence register — what is kept, for how long, and how you would know it was altered',
    path: 'lib/evidence.js',
    section: null,
    owner: 'Adam Morgan',
    approvedBy: 'Adam Morgan',
    approvedOn: '2026-08-15',
    version: '1.0.0',
    reviewedOn: '2026-08-15',
    reviewMonths: 12,
    serves: 'SOC 2 CC7 and ISO/IEC 42001 Clause 7.5 — the record of what evidence exists, its retention and its disposal.',
    why:
      'A retention decision made a year ago against a module that has since been rewritten is a retention decision about ' +
      'nothing. The register enforces its own coverage; nothing but a date enforces that its sentences are still true.',
  },
  {
    id: 'election',
    title: 'What this install elected to be held to',
    path: 'README.md',
    section: '## What you elected to be held to — `lib/election.js`',
    owner: 'Adam Morgan',
    approvedBy: 'Adam Morgan',
    approvedOn: '2026-08-15',
    version: '2026.08.15',
    reviewedOn: '2026-08-15',
    reviewMonths: 12,
    serves: 'ISO/IEC 42001 Clause 4.3 — the mechanism by which the scope of the management system is enforced on an install.',
    why:
      'The formal scope statement is `aims-scope` below; this section is the other half of it, and the two must agree. ' +
      'It decides which installs a gate may fire on at all, so drift here silently changes what the scope statement means.',
  },
  {
    id: 'ai-policy',
    title: 'Beadcause AI policy',
    path: 'README.md',
    section: '#### The AI policy',
    owner: 'Adam Morgan',
    approvedBy: null,
    approvedOn: null,
    awaitingApproval: 'Adam Morgan, as top management',
    version: '0.1.0-draft',
    reviewedOn: '2026-08-17',
    reviewMonths: 12,
    serves: 'ISO/IEC 42001 Clause 5.2 — the AI policy, issued by top management and appropriate to the purpose of the organisation.',
    why:
      'Every gate in this system refuses something on the strength of a clause in it, so a clause that stopped being ' +
      'true is a refusal with nothing behind it. `lib/aims.js` pins the clause ids into the document; only a review ' +
      'can tell whether the commitments still describe what the organisation is willing to be held to.',
  },
  {
    id: 'aims-scope',
    title: 'Scope of the AI management system',
    path: 'README.md',
    section: '#### Scope of the AI management system',
    owner: 'Adam Morgan',
    approvedBy: null,
    approvedOn: null,
    awaitingApproval: 'Adam Morgan, as top management',
    version: '0.1.0-draft',
    reviewedOn: '2026-08-17',
    reviewMonths: 12,
    serves: 'ISO/IEC 42001 Clause 4.3 — the scope of the AI management system, with its exclusions and their justification.',
    why:
      'Scope is the first document an auditor reads and the exclusions are the half they read twice. An exclusion that ' +
      'was true when the system was smaller is how an audit ends up covering something nobody meant it to cover, or ' +
      'missing something everybody assumed it did.',
  },
  {
    id: 'interested-parties',
    title: 'Interested parties and what they need',
    path: 'README.md',
    section: '#### Interested parties and what they need',
    owner: 'Adam Morgan',
    approvedBy: null,
    approvedOn: null,
    awaitingApproval: 'Adam Morgan, as top management',
    version: '0.1.0-draft',
    reviewedOn: '2026-08-17',
    reviewMonths: 12,
    serves: 'ISO/IEC 42001 Clauses 4.1 and 4.2 — the context of the organisation, the interested parties and their requirements.',
    why:
      'A party arrives without announcing itself: the first customer, the first repository this system writes into that ' +
      'somebody else owns, the first regulator with an opinion. The register is only ever complete as of the day ' +
      'somebody last thought about who else is affected.',
  },
  {
    id: 'aims-roles',
    title: 'Roles, and who may approve what',
    path: 'README.md',
    section: '#### Roles, and who may approve what',
    owner: 'Adam Morgan',
    approvedBy: null,
    approvedOn: null,
    awaitingApproval: 'Adam Morgan, as top management',
    version: '0.1.0-draft',
    reviewedOn: '2026-08-17',
    reviewMonths: 12,
    serves: 'ISO/IEC 42001 Clause 5.3 and Annex A.3 — roles, responsibilities and authorities within the management system.',
    why:
      'Five roles are held by one person, and the day that stops being true the table is wrong in the direction that ' +
      'matters most — an approval recorded against a role somebody else now holds. It is also the document that says ' +
      'who may approve an impact assessment, which is a refusal in code rather than a convention.',
  },
  {
    id: 'policy-set',
    title: 'The policy set — which policies are owed, who owns each, and when each expires',
    path: 'lib/policies.js',
    section: null,
    owner: 'Adam Morgan',
    approvedBy: 'Adam Morgan',
    approvedOn: '2026-08-17',
    version: '1.0.0',
    reviewedOn: '2026-08-17',
    reviewMonths: 12,
    serves: 'SOC 2 CC5.3 and ISO/IEC 27001 A.5.1 — the policies through which control activities are deployed, and the record of which of them exist.',
    why:
      'It says which policy is the documented answer for which criterion, and a mapping nobody re-reads is how a policy ' +
      'comes to be cited for a criterion it stopped covering. Note what is approved here: this register, by the owner of ' +
      'this repository. The fifteen documents it tracks belong to another organisation and not one of them is approved ' +
      'by anybody yet, which is precisely what the register records.',
  },
]);

/* ---------------------------------------------------------- what must hold */

const prose = (v) => typeof v === 'string' && v.trim().length >= 40;
const named = (v) => typeof v === 'string' && v.trim().length >= 2;

/**
 * Everything wrong with one entry, as sentences.
 *
 * Takes one entry rather than reading `REGISTER`, for the reason `lib/evidence.js` gives
 * for the same split: the register is frozen and supposed to be clean, so rules that only
 * ever run against it can report a pass and can never be shown to fail. `test/documents.mjs`
 * runs these against deliberately broken entries.
 *
 * The date rules are the ones that carry weight. Everything else here is only stopping the
 * four fields an auditor asks about from being answered with a word.
 */
export function entryProblems(e) {
  const problems = [];
  const at = `REGISTER[${e?.id || '?'}]`;

  if (!/^[a-z][a-z0-9-]*$/.test(String(e?.id || ''))) problems.push(`${at}: id must be kebab-case`);
  if (!named(e?.title)) problems.push(`${at}: \`title\` must name the document`);
  if (!named(e?.path)) problems.push(`${at}: \`path\` must name the file the document lives in`);
  if (e?.section !== null && !named(e?.section)) {
    problems.push(`${at}: \`section\` must be the heading line, verbatim, or null for a whole file`);
  }
  if (!named(e?.owner)) problems.push(`${at}: \`owner\` must name the person accountable for it`);
  if (!named(e?.version)) problems.push(`${at}: \`version\` must say which version this is`);
  if (!prose(e?.serves)) problems.push(`${at}: \`serves\` must say which clause or criterion it is documented information for`);
  if (!prose(e?.why)) problems.push(`${at}: \`why\` must say what goes wrong if it is left unreviewed, in a sentence`);

  const approved = parseDate(e?.approvedOn);
  const reviewed = parseDate(e?.reviewedOn);
  const draft = e?.awaitingApproval !== undefined && e?.awaitingApproval !== null;

  if (draft) {
    if (!named(e?.awaitingApproval)) {
      problems.push(`${at}: \`awaitingApproval\` must name whose signature the document is waiting for`);
    }
    if (e?.approvedBy !== null || e?.approvedOn !== null) {
      problems.push(
        `${at}: a document awaiting approval must carry \`approvedBy: null\` and \`approvedOn: null\` — ` +
          'it is waiting for a signature precisely because it does not have one'
      );
    }
  } else {
    if (!named(e?.approvedBy)) problems.push(`${at}: \`approvedBy\` must name whoever approved it — an approval nobody gave cannot be recorded`);
    if (approved === null) problems.push(`${at}: \`approvedOn\` must be a real date, as YYYY-MM-DD`);
  }

  if (reviewed === null) problems.push(`${at}: \`reviewedOn\` must be a real date, as YYYY-MM-DD`);
  if (approved !== null && reviewed !== null && reviewed < approved) {
    problems.push(`${at}: reviewed ${e.reviewedOn}, before it was approved on ${e.approvedOn} — one of the two dates is wrong`);
  }

  if (!Number.isInteger(e?.reviewMonths) || e.reviewMonths < 1 || e.reviewMonths > MAX_REVIEW_MONTHS) {
    problems.push(
      `${at}: \`reviewMonths\` must be a whole number of months between 1 and ${MAX_REVIEW_MONTHS} — ` +
        'anything longer is not a review cycle, it is "never" with a number beside it'
    );
  }

  return problems;
}

/** A future date is the one way a register can pass every rule above and still be false. */
function futureProblems(e, now) {
  const problems = [];
  const at = `REGISTER[${e?.id || '?'}]`;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const field of ['approvedOn', 'reviewedOn']) {
    const t = parseDate(e?.[field]);
    if (t !== null && t > today) problems.push(`${at}: \`${field}\` is ${e[field]}, which has not happened yet`);
  }
  return problems;
}

/**
 * Does this file still hold that heading, exactly?
 *
 * Matched against whole lines, and the whole line, because a heading is the only handle
 * an entry has on a section of a nineteen-thousand-line file. Renaming one is a perfectly
 * ordinary edit and it silently detaches the section from its owner, so the register would
 * go on naming an owner for something that no longer exists — which reads, to anybody
 * checking, exactly like a section that is owned.
 */
export function hasSection(source, heading) {
  const want = String(heading).trim();
  return String(source)
    .split('\n')
    .some((line) => line.trim() === want);
}

/**
 * Everything wrong with the register in this checkout, split into what fails and what warns.
 *
 * Returned rather than thrown so one run names every problem: reviews come due in batches
 * — the day a person sits down to do one they should be told about all four, not the first.
 *
 * `now` is a parameter for the same reason it is one on `reviewStatus`, and it is the seam
 * the whole suite hangs off: pointed at a date two years out, every entry here is overdue
 * and the check can be shown to fail rather than asserted to.
 */
export function registerProblems(root, now = new Date(), register = REGISTER) {
  const problems = [];
  const warnings = [];
  const seenId = new Set();
  const seenDoc = new Set();

  for (const e of register) {
    problems.push(...entryProblems(e), ...futureProblems(e, now));

    if (seenId.has(e.id)) problems.push(`REGISTER[${e.id}]: two entries with the same id`);
    seenId.add(e.id);

    const doc = `${e.path}::${e.section ?? ''}`;
    if (seenDoc.has(doc)) {
      problems.push(`REGISTER[${e.id}]: ${e.path}${e.section ? ` — ${e.section}` : ''} is already controlled by another entry, so it has two owners`);
    }
    seenDoc.add(doc);

    const abs = path.join(root, e.path);
    let source = null;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      problems.push(`REGISTER[${e.id}]: ${e.path} is not in the repo — a controlled document that is not there is not controlled`);
    }
    if (source !== null && e.section && !hasSection(source, e.section)) {
      problems.push(
        `REGISTER[${e.id}]: ${e.path} no longer has the heading \`${e.section}\` — either it was renamed, in which case ` +
          'say so here, or the section is gone and this entry owns nothing'
      );
    }

    const { due, days, state } = reviewStatus(e, now);
    if (state === 'overdue') {
      problems.push(
        `REGISTER[${e.id}]: review was due ${due}, ${-days} day${days === -1 ? '' : 's'} ago. ` +
          `Read it, change what is no longer true, bump \`version\`, then move \`reviewedOn\` — in that order. ` +
          `${e.owner} owns it.`
      );
    }
    if (state === 'approaching') {
      warnings.push(`REGISTER[${e.id}]: review due ${due}, in ${days} day${days === 1 ? '' : 's'} — ${e.owner} owns it.`);
    }
    if (e.awaitingApproval) {
      warnings.push(
        `REGISTER[${e.id}]: draft, awaiting ${e.awaitingApproval}. A session can draft it; only a person can sign it.`
      );
    }
  }

  return { problems, warnings };
}

/**
 * The change history that already exists, rather than a table of it.
 *
 * Nobody maintains a revision table in a repo that has git, and the one thing a
 * hand-maintained table reliably records is the revisions somebody remembered to write
 * down. This reads the real thing. Best-effort by construction — no git, a shallow clone
 * or a path with no history each gives an empty list rather than an error, because a
 * document's history is context for a reviewer and never a pass condition.
 */
export function history(root, entry, limit = 10) {
  try {
    const out = execFileSync(
      'git',
      ['log', `-${Number(limit)}`, '--format=%h%x09%aI%x09%an%x09%s', '--', entry.path],
      { cwd: root, encoding: 'utf8', timeout: 10000 }
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, at, who, subject] = line.split('	');
        return { sha, at, who, subject };
      });
  } catch {
    return [];
  }
}
