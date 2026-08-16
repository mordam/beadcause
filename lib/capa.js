/**
 * The nonconformity record, and the dated check that says the fix worked.
 *
 * `lib/errors.js` files a P0 the moment something breaks and `lib/crash.js` does the
 * same for the daemon's own crashes, so **detection and correction are already done
 * here** — further than most programmes ever get, because theirs is a procedure that
 * runs when somebody remembers to run it. `lib/incident.js` then put a severity, a
 * commitment and a clock on that bead. What none of them do is the part Clause 10.2
 * asks for *after* the bug is fixed:
 *
 * - **why it happened**, which is an evaluation of whether action is needed so it
 *   cannot recur — not the fix, which is already on the bug bead;
 * - **what was changed** so it cannot recur;
 * - and **whether that worked**, checked on a date, by somebody who has to look.
 *
 * The last one is the whole of this module's reason to exist. A corrective action
 * whose effectiveness nobody ever checked is the commonest finding there is, and it is
 * common because the check has no natural moment: the bug is fixed, the bead is closed,
 * everybody has moved on, and thirty days later there is nothing to remind anyone. Here
 * there is. The check is **a bead of its own that blocks the record's closure**, and bd
 * refuses a close over an open blocker (lib/bd.js `gateFor`), so the tracker itself
 * declines to call a corrective action finished before anybody has looked at whether it
 * worked. Nothing has to remember; the graph refuses.
 *
 * ## The record is not the bug bead, and that is measured rather than preferred
 *
 * The obvious design is to grow these fields on the P0 the error path already files.
 * It cannot be that, for a reason the code settles: **the merge queue closes the bug
 * bead when the fix lands**, and a blocker on it would turn every merge into an owed
 * close (bin/deliver.js `oweClose`) with a P0 sitting open on the board over a fix that
 * has shipped. The two records also have genuinely different lifecycles — the bug is
 * resolved when the fix merges, the nonconformity is closed when the action is shown to
 * have worked — and one bead cannot carry two close conditions.
 *
 * So a nonconformity is its own bead, raised *from* the bug, exactly as
 * `lib/incident.js` made the post-incident review its own bead and for the same reason:
 * a record whose absence is invisible is a record that does not exist.
 *
 * ## A gate refusal is not a nonconformity, and they are not stored alike
 *
 * This is the distinction this module owns on behalf of the rest of the programme, and
 * it is worth more than any field below. bc-eqn1.8 adds gates that refuse work — a
 * session on a bead with no impact assessment, a merge carrying no control claim, an
 * egress to a host nobody registered. **Every one of those refusals is the control
 * operating correctly.** An auditor who reads a pile of them as failures draws exactly
 * the wrong conclusion, and unwinding that is far more expensive than preventing it.
 *
 * They are kept apart in the strongest way available: they are not the same *kind of
 * thing* in storage. A nonconformity is a bead. **A refusal is a comment on the bead it
 * refused**, with a parseable first line, and the refused bead carries `gate-refused` so
 * one `bd list` finds every bead a gate has ever stopped. Two reasons that beats a
 * second label on a second bead:
 *
 * - **Volume.** A gate that works refuses often. A bead per refusal is a board nobody
 *   reads, and the beads that matter stop being read with it.
 * - **A refusal is about a bead.** It has one already — the work that was stopped —
 *   and a comment on it is where somebody hitting the refusal will actually look.
 *
 * `kindFromLabels` throws if a row somehow carries both labels, and `register` counts
 * them in different fields with different words. There is no arrangement of these two
 * that quietly adds up to "twelve failures this quarter".
 *
 * Nothing here writes anything or talks to bd. It builds records and reads rows, the
 * same way lib/incident.js does, and bin/capa.js is the terminal.
 */

/** The class label. `bd list --label nonconformity` is the register, closed ones kept. */
export const NONCONFORMITY_LABEL = 'nonconformity';

/** The label an effectiveness check carries, so the register can see whether one exists. */
export const CHECK_LABEL = 'effectiveness-check';

/** The label a bead carries once a gate has refused something about it. */
export const REFUSAL_LABEL = 'gate-refused';

/** `raisedfrom:<bead>` — what this nonconformity was raised from. */
export const RAISED_FROM_PREFIX = 'raisedfrom:';

/** `checkof:<nonconformity>` — which record this check is the check of. */
export const CHECK_OF_PREFIX = 'checkof:';

/** `due:<YYYY-MM-DD>` — the date on the check, in the one place a list can sort by. */
export const DUE_PREFIX = 'due:';

/** How long after the action lands the check falls due, when nobody says otherwise. */
export const DEFAULT_CHECK_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * **The two record kinds, closed.**
 *
 * Closed for the same reason the severity scale is: a vocabulary you can add to at the
 * moment of the record says whatever the person writing it wanted it to say. But the
 * reason it is *two* and not one is the whole point of the module — see the header. The
 * `means` sentences are written to be read out at an audit, because that is the moment
 * the confusion costs something.
 */
export const KINDS = Object.freeze([
  Object.freeze({
    id: 'nonconformity',
    label: NONCONFORMITY_LABEL,
    means: 'a requirement was not met — something was supposed to hold and did not',
    counts: 'as a finding, and it owes a correction, a root cause, an action and a dated check',
  }),
  Object.freeze({
    id: 'refusal',
    label: REFUSAL_LABEL,
    means: 'a gate refused non-conformant work — the control operating, not a failure',
    counts: 'as evidence that the control ran, and never as a finding of any kind',
  }),
]);

const BY_ID = new Map(KINDS.map((k) => [k.id, k]));

/** A kind id → its record, or a throw. The refusal is the point; see `requireSeverity`. */
export function requireKind(id) {
  const found = BY_ID.get(String(id || '').trim().toLowerCase());
  if (!found) throw new Error(`no such record kind: ${JSON.stringify(id)} — the vocabulary is ${KINDS.map((k) => k.id).join(', ')}`);
  return found;
}

/**
 * Which kind a row is, from its labels — and a throw if it is somehow both.
 *
 * Both is not a state anything here can produce, which is exactly why it throws rather
 * than picking one: a row carrying both labels means something outside this module put
 * them there, and the two possible guesses are "count the control working as a failure"
 * and "stop counting a real finding". Neither is a guess worth making quietly.
 *
 * Null for a row that is neither, because most rows are neither.
 */
export function kindFromLabels(labels = []) {
  const list = (labels || []).map((l) => String(l || '').trim().toLowerCase());
  const nc = list.includes(NONCONFORMITY_LABEL);
  const refused = list.includes(REFUSAL_LABEL);
  if (nc && refused) {
    throw new Error(
      `a row carries both ${NONCONFORMITY_LABEL} and ${REFUSAL_LABEL} — a gate refusal is the control working ` +
        'and a nonconformity is a requirement not met; they are never the same record',
    );
  }
  if (nc) return BY_ID.get('nonconformity');
  if (refused) return BY_ID.get('refusal');
  return null;
}

/**
 * **The five sections, in the order Clause 10.2 asks them**, and each with the sentence
 * that says what a bad answer looks like.
 *
 * The third is the one that decides whether any of this is worth having. "The root cause
 * was that the code was wrong" is not a root cause, and a record full of those is a form
 * rather than a control — so the prompt asks the question the clause actually asks:
 * whether action is needed so it cannot recur, and whether the same cause is sitting
 * somewhere else in the system right now.
 */
export const SECTIONS = Object.freeze([
  Object.freeze({
    id: 'happened',
    heading: 'What happened',
    asks:
      'Which requirement was not met, and how it showed up. Name the requirement, not only the symptom — the ' +
      'symptom is on the bead this was raised from.',
  }),
  Object.freeze({
    id: 'correction',
    heading: 'Correction',
    asks:
      'What was done immediately to deal with it and with its consequences. This is containment, not the fix: ' +
      'what stopped the bleeding, and what the failure had already done that had to be undone.',
  }),
  Object.freeze({
    id: 'cause',
    heading: 'Root cause',
    asks:
      'Why it happened, and whether action is needed so it cannot recur — which is the evaluation the clause ' +
      'asks for, not the fix. Two questions make it a real answer: what would have had to be different for this ' +
      'to be impossible, and is that same cause sitting anywhere else in the system right now.',
  }),
  Object.freeze({
    id: 'action',
    heading: 'Corrective action',
    asks:
      'What was changed so it cannot recur, and where. Name the bead and the commit. "We fixed the bug" is a ' +
      'correction and belongs above; this line is about what changed so the next one of these never gets filed.',
  }),
  Object.freeze({
    id: 'effectiveness',
    heading: 'Effectiveness',
    asks:
      'Answered on the check bead below, on its date, and copied here when it is. Either the action held, with ' +
      'what was looked at to say so, or it did not — and "it did not" is the useful outcome, because it is the ' +
      'one that raises the next record instead of closing this one.',
  }),
]);

/** What an unanswered section says. Deleting this line is how a section is answered. */
export const UNANSWERED = '_Not yet answered._';

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

const esc = (text) => String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `2026-09-14` from a millisecond stamp, which is the only date format anything here writes. */
export function isoDay(ms) {
  const t = typeof ms === 'number' ? ms : Date.parse(ms);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

/** The day a check falls due: `days` after `from`, as a date and nothing finer. */
export function dueOn({ from = Date.now(), days = DEFAULT_CHECK_DAYS } = {}) {
  const start = typeof from === 'number' ? from : Date.parse(from);
  const n = Number(days);
  const span = Number.isFinite(n) && n >= 1 ? Math.round(n) : DEFAULT_CHECK_DAYS;
  return isoDay((Number.isFinite(start) ? start : Date.now()) + span * DAY_MS);
}

/**
 * The body of a nonconformity record: five headed sections, seeded with the questions.
 *
 * `answers` fills in whichever are already known — at raise time that is usually only
 * the first — and everything else carries `UNANSWERED`, which is what `capaFrom` reads
 * to say the record is incomplete. Seeded rather than empty because an empty heading is
 * a form somebody fills in with whatever occurs to them, and the sentences under each
 * one are the difference between a root cause and a restatement of the symptom.
 */
export function capaNote({ answers = {}, source = '', due = '', checkId = '' } = {}) {
  const lines = [
    '| | |',
    '|---|---|',
    `| **Raised from** | ${source || '_not stated_'} |`,
    `| **Effectiveness check** | ${checkId ? `${checkId}, due ${due || '_undated_'}` : `due ${due || '_undated_'} — a bead of its own, and it blocks this one closing`} |`,
    '',
  ];
  for (const s of SECTIONS) {
    const given = oneLine(answers?.[s.id]) ? String(answers[s.id]).trim() : '';
    lines.push(`#### ${s.heading}`, '', given || UNANSWERED, '', `_${s.asks}_`, '');
  }
  lines.push(
    '_This record is not the bug. The bug closed when its fix merged; this closes when the check below says the ' +
      'action worked — and it cannot close before then, because bd refuses a close over an open blocker. See lib/capa.js._',
  );
  return lines.join('\n');
}

/**
 * **A nonconformity, as a bead.**
 *
 * `source` is the bead it was raised from — an incident, an audit finding, a breached
 * commitment — and is kept as both a label and an edge: the label so one `bd list`
 * answers "which of these came from incidents", the edge so the graph carries it.
 *
 * Priority follows the source where one is given and is P2 otherwise, deliberately not
 * P0. The urgent half of a nonconformity is the bug, and the bug is already a P0 by
 * construction; the record is the unhurried half, and filing it as an emergency is how
 * an advocate spends a night writing a form instead of fixing something.
 */
export function nonconformityBead({
  source = '',
  title = '',
  requirement = '',
  answers = {},
  due = '',
  priority = 2,
} = {}) {
  const what = oneLine(title) || oneLine(requirement) || (source ? `the nonconformity raised from ${source}` : '');
  if (!what) throw new Error('a nonconformity needs a title, a requirement or a source bead to name it');
  const seeded = { ...answers };
  if (!oneLine(seeded.happened) && requirement) {
    seeded.happened = `The requirement not met: ${oneLine(requirement)}.`;
  }
  return {
    title: `Nonconformity: ${what}`.slice(0, 140),
    type: 'task',
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 2,
    labels: [NONCONFORMITY_LABEL, ...(source ? [`${RAISED_FROM_PREFIX}${source}`] : [])],
    deps: source ? [`discovered-from:${source}`] : [],
    description: capaNote({ answers: seeded, source, due }),
    acceptance:
      'All five sections are answered — the root cause is a cause and not a restatement of the symptom — and the ' +
      'effectiveness check has been done on its date and says what was looked at.',
    rationale:
      `Raised${source ? ` from ${source}` : ''} as the Clause 10.2 record: correction, root cause, action, and a ` +
      'dated check that the action worked. The bug is a different bead with a different close condition.',
  };
}

/**
 * **The effectiveness check, as a dated bead that blocks the record.**
 *
 * Two things make this more than a reminder. It is **dated** — `due:<day>` as a label so
 * a list can sort by it, and the date in words on the bead — and it is **a blocker**, so
 * the record it is the check of cannot be closed while it is open. `deferred` counts as
 * open for that (lib/bd.js filters on `!== 'closed'`), which is what lets the check be
 * deferred until its date without ceasing to hold the door.
 *
 * The question it asks is deliberately narrow, because a wide one gets a wide answer. Not
 * "is everything better" — did *this* action hold, what was looked at to say so, and has
 * the thing recurred since. And it says outright that "no" is a real answer: an
 * ineffective action raises the next record rather than being quietly rewritten into a
 * success, which is the failure mode this whole clause exists against.
 */
export function effectivenessBead({ nonconformity = '', title = '', due = '', action = '' } = {}) {
  const id = String(nonconformity || '').trim();
  if (!id) throw new Error('an effectiveness check has to be the check of a nonconformity — pass one');
  const day = String(due || '').trim() || dueOn({});
  return {
    title: `Effectiveness check ${day}: ${oneLine(title) || id}`.slice(0, 140),
    type: 'task',
    priority: 2,
    labels: [NONCONFORMITY_LABEL, CHECK_LABEL, `${CHECK_OF_PREFIX}${id}`, `${DUE_PREFIX}${day}`],
    deps: [`discovered-from:${id}`],
    description: [
      `**Due ${day}.** ${id} recorded a corrective action; this is the check that it worked, and until it is ` +
        `answered ${id} cannot close.`,
      '',
      action ? `**The action taken was:** ${oneLine(action)}` : '',
      '',
      'Three questions, and the third is the one worth the date:',
      '',
      '1. **Has it recurred?** Say what you looked at — the fingerprint, the register, the log — and over what window.',
      '2. **Is the change still in place?** An action reverted in a merge nobody read is an action that was never taken.',
      '3. **Did it address the cause or the symptom?** The root cause on the record named something. Is that thing ' +
        'now impossible, or merely unlikely because one instance of it was fixed?',
      '',
      '**"It did not work" is a real answer and the useful one.** An ineffective action raises the next ' +
        'nonconformity — it does not get rewritten into a success on the way to closing this. See lib/capa.js.',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    acceptance:
      'All three questions are answered on this bead, with what was looked at named, and the verdict is stated ' +
      'plainly either way.',
    rationale:
      `The dated effectiveness check owed by ${id}. It blocks that record closing, which is the only reason a check ` +
      'nobody is chasing gets done at all.',
  };
}

/**
 * What a record actually says, read back — which sections are answered and which are not.
 *
 * The text is looked for in the description, the notes and the design field *and* in any
 * comments passed in, because an answer arrives however the person answering felt like
 * writing it: an edit to the description, an `--append-notes`, or a comment. Insisting on
 * one of those would produce records that are complete and read as empty.
 *
 * **The last occurrence of a heading wins**, since appending is how an answer is usually
 * added and the appended one is the newer of the two.
 */
export function capaFrom(row = {}, { comments = [] } = {}) {
  const parts = [row.description, row.body, row.notes, row.design, ...(comments || []).map((c) => c?.text ?? c?.body ?? c)]
    .filter((p) => typeof p === 'string' && p.trim())
    .join('\n\n');

  const sections = {};
  for (const s of SECTIONS) {
    const re = new RegExp(`^#{1,6}\\s+${esc(s.heading)}\\s*$`, 'gim');
    let body = '';
    let m;
    while ((m = re.exec(parts))) {
      const after = parts.slice(m.index + m[0].length);
      const next = after.search(/^#{1,6}\s+\S/m);
      const chunk = next === -1 ? after : after.slice(0, next);
      // The seeded prompt is italic prose the writer is meant to leave alone, so it is
      // stripped before deciding whether anything was said — otherwise every section
      // reads as answered the moment it is created.
      const said = chunk
        .split('\n')
        .filter((line) => !/^_.*_$/.test(line.trim()))
        .join('\n')
        .replace(new RegExp(esc(UNANSWERED), 'g'), '')
        .trim();
      if (said) body = said;
    }
    sections[s.id] = body;
  }

  const missing = SECTIONS.filter((s) => !sections[s.id]).map((s) => s.id);
  return { sections, missing, complete: missing.length === 0 };
}

/** `due:2026-09-14` off a check bead's labels → the day, or ''. */
export function dueFromLabels(labels = []) {
  const found = (labels || []).map(String).find((l) => l.startsWith(DUE_PREFIX));
  return found ? found.slice(DUE_PREFIX.length).trim() : '';
}

const labelValue = (labels, prefix) => {
  const found = (labels || []).map(String).find((l) => l.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : '';
};

/**
 * **The register**: every nonconformity, closed ones kept, each with its check.
 *
 * Closed rows are not optional, for the reason the incident register spells out: every
 * record an auditor samples is closed by the time they ask about it, so a register that
 * drops them can evidence nothing. Feed it `bd.listLabelAny(ws, 'nonconformity')`, which
 * keeps them.
 *
 * The check beads arrive in the same list — they carry `nonconformity` too, so that one
 * call stays one call — and are pulled out here rather than counted as records of their
 * own, exactly as reviews and exercises are pulled out of the incident register. Counting
 * the paperwork about a finding as a second finding would make a quarter look worse for
 * having been handled properly.
 *
 * `forced` is the field worth having and the one nothing else can see: a record closed
 * while its check was still open. bd refuses that close, so it can only have happened
 * through `--force` — which is a decision somebody made, not an accident, and the
 * register's job is to make sure it was made in the open.
 */
export function register(rows = [], { now = Date.now(), comments = new Map() } = {}) {
  const all = (rows || []).filter(Boolean);
  for (const row of all) kindFromLabels(row.labels);

  const checks = all.filter((r) => (r.labels || []).includes(CHECK_LABEL));
  const byRecord = new Map();
  for (const c of checks) {
    const of = labelValue(c.labels, CHECK_OF_PREFIX);
    if (of) byRecord.set(of, c);
  }

  const records = all
    .filter((r) => !(r.labels || []).includes(CHECK_LABEL))
    .map((row) => {
      const capa = capaFrom(row, { comments: comments.get?.(row.id) || [] });
      const check = byRecord.get(row.id) || null;
      const due = check ? dueFromLabels(check.labels) : '';
      const dueMs = due ? Date.parse(`${due}T00:00:00Z`) : NaN;
      const checkOpen = Boolean(check) && check.status !== 'closed';
      const closed = row.status === 'closed';
      return {
        id: row.id || '',
        title: row.title || '',
        status: row.status || '',
        closed,
        raisedFrom: labelValue(row.labels, RAISED_FROM_PREFIX),
        sections: capa.sections,
        missing: capa.missing,
        complete: capa.complete,
        checkId: check?.id || '',
        checkStatus: check?.status || '',
        checkDue: due,
        // Overdue is about the check, not about the record: a record can sit open for
        // months legitimately while its action is still being watched.
        checkOverdue: Boolean(checkOpen && Number.isFinite(dueMs) && now > dueMs),
        checkDone: Boolean(check) && check.status === 'closed',
        // The door: open check, closed record. See the header.
        blocked: !closed && checkOpen,
        forced: closed && checkOpen,
        unchecked: !check,
      };
    });

  // Worst first: forced closes, then records with no check at all, then overdue ones,
  // then oldest. The order answers "what is wrong with this register" before it answers
  // "what is in it", which is the question anybody opening it actually has.
  const rank = (r) => (r.forced ? 0 : r.unchecked ? 1 : r.checkOverdue ? 2 : r.closed ? 4 : 3);
  records.sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)));
  return records;
}

/** Records whose check is open and past its date. The list somebody has to act on. */
export function checksOverdue(records = []) {
  return records.filter((r) => r.checkOverdue);
}

/** Records closed with the check still open — only reachable through `--force`. */
export function forcedCloses(records = []) {
  return records.filter((r) => r.forced);
}

/**
 * **Nonconformities that are owed and do not exist yet.**
 *
 * One source is machine-knowable and needs no judgement at all: an incident that
 * **missed a commitment stated in advance**. That is a requirement not met, by
 * construction — the number was written down before the incident, which is the whole
 * argument lib/incident.js makes for stating it — so it does not need somebody to decide
 * whether it counts.
 *
 * Everything else is a judgement and is raised by hand. That asymmetry is deliberate:
 * automating the ones that need a decision would fill the register with records nobody
 * believes, and a register nobody believes is worse than a short one.
 *
 * Takes incident clocks (lib/incident.js `register`) rather than importing them, so this
 * module stays free of anything that could make it a second incident register.
 */
export function nonconformitiesOwed(clocks = [], records = []) {
  const covered = new Set(records.map((r) => r.raisedFrom).filter(Boolean));
  return (clocks || []).filter((c) => c && c.breached && c.resolved != null && !covered.has(c.id));
}

/* ------------------------------------------------------- the other kind of record */

/**
 * **A gate refusal**, as the one line that goes on the bead it refused.
 *
 * This is the shape bc-eqn1.8's gates write. It carries the control it enforced, because
 * a refusal that does not name one is an obstruction rather than a control, and the
 * whole claim being made is that the refusal *is* the evidence the control operated.
 *
 * It is a comment and not a bead. See the header for why — and read the sentence it
 * ends with, which is on every single one on purpose: whoever finds this months later
 * finds it already saying what it is.
 */
export function refusalRecord({ control = '', gate = '', subject = '', why = '', at = Date.now() } = {}) {
  const c = oneLine(control);
  const g = oneLine(gate);
  if (!c) throw new Error('a refusal has to name the control it enforced — an unnamed refusal is an obstruction');
  if (!g) throw new Error('a refusal has to name the gate that refused — pass one');
  // The first line of the comment is field-separated by `·`, and a separator inside a
  // field would split it somewhere else — which parses back as a different refusal
  // rather than as an error, so it is refused at the point it can still be fixed.
  if (`${c}${g}`.includes('·')) throw new Error('a control or gate name may not contain `·` — it separates the fields on the line this is stored as');
  const when = Number.isFinite(at) ? at : Date.parse(at);
  return Object.freeze({
    kind: 'refusal',
    control: c,
    gate: g,
    subject: oneLine(subject),
    why: oneLine(why),
    at: Number.isFinite(when) ? when : Date.now(),
  });
}

/** The prefix that makes a refusal comment findable without reading the prose. */
export const REFUSAL_MARK = 'GATE REFUSED';

/** The comment a refusal writes. The first line parses; the rest is for a person. */
export function refusalComment(record) {
  const r = record?.kind === 'refusal' ? record : refusalRecord(record || {});
  const head = [`${REFUSAL_MARK} · ${r.gate} · ${r.control} · ${new Date(r.at).toISOString()}`];
  if (r.subject) head.push(`It refused: ${r.subject}`);
  if (r.why) head.push(`Why: ${r.why}`);
  head.push(
    '',
    '_This is the control working, not a fault. It is deliberately **not** a nonconformity and is never counted ' +
      'as one — see lib/capa.js._',
  );
  return head.join('\n');
}

/** One refusal comment → the record, or null for a comment that is not one. */
export function parseRefusal(text = '') {
  const body = String(text ?? '');
  const line = body.split('\n').find((l) => l.trim().startsWith(REFUSAL_MARK));
  if (!line) return null;
  const [, gate = '', control = '', when = ''] = line.trim().split('·').map((p) => p.trim());
  const at = Date.parse(when);
  const grab = (label) => {
    const found = body.split('\n').find((l) => l.trim().startsWith(label));
    return found ? found.trim().slice(label.length).trim() : '';
  };
  return {
    kind: 'refusal',
    gate,
    control,
    subject: grab('It refused:'),
    why: grab('Why:'),
    at: Number.isFinite(at) ? at : null,
  };
}

/**
 * Every refusal on one bead's comments, oldest first.
 *
 * `comments` is what `bd.comments` returns — objects with `text`, or plain strings,
 * because both shapes turn up depending on which call produced them.
 */
export function refusalsFrom(comments = [], { bead = '' } = {}) {
  return (comments || [])
    .map((c) => parseRefusal(typeof c === 'string' ? c : c?.text ?? c?.body ?? ''))
    .filter(Boolean)
    .map((r) => ({ ...r, bead }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}

/**
 * **The evidence, for a period** — and the two kinds counted apart, in the same call.
 *
 * They are in one function rather than two so that the one place anybody reads both
 * numbers is a place where the two are already named as different things. Splitting them
 * into two calls is how a caller ends up adding them together.
 *
 * `from` and `to` bound nonconformities by when the record was raised and refusals by
 * when the refusal happened. `records` are register rows; `raisedAt` comes off the source
 * rows because a register row has no timestamp of its own.
 */
export function periodEvidence(records = [], refusals = [], { from = null, to = null, raisedAt = new Map() } = {}) {
  const lo = from == null ? -Infinity : typeof from === 'number' ? from : Date.parse(from);
  const hi = to == null ? Infinity : typeof to === 'number' ? to : Date.parse(to);
  const at = (r) => {
    const t = raisedAt.get?.(r.id);
    // `Date.parse` of nonsense is NaN, which is a number — so a row with an unreadable
    // timestamp would be silently outside every window rather than inside all of them.
    const ms = typeof t === 'number' ? t : Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  };
  const inPeriod = records.filter((r) => {
    const t = at(r);
    return t == null ? lo === -Infinity : t >= lo && t <= hi;
  });
  const refs = refusals.filter((r) => r.at == null || (r.at >= lo && r.at <= hi));
  const byControl = {};
  for (const r of refs) byControl[r.control] = (byControl[r.control] || 0) + 1;

  return {
    from: lo === -Infinity ? null : lo,
    to: hi === Infinity ? null : hi,
    nonconformities: {
      total: inPeriod.length,
      open: inPeriod.filter((r) => !r.closed).length,
      complete: inPeriod.filter((r) => r.complete).length,
      unchecked: inPeriod.filter((r) => r.unchecked).length,
      checksDone: inPeriod.filter((r) => r.checkDone).length,
      checksOverdue: inPeriod.filter((r) => r.checkOverdue).length,
      forced: inPeriod.filter((r) => r.forced).length,
    },
    // Named `refusals` and never folded into the counts above. A refusal is the control
    // operating; the day these two are added together is the day the register says the
    // opposite of what happened.
    refusals: { total: refs.length, byControl, meaning: requireKind('refusal').counts },
  };
}
