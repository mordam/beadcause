/**
 * The crosswalk report — one matrix, generated, showing where a control answers three
 * standards at once and where an obligation has nothing pointed at it.
 *
 * The programme's premise is that a SOC 2 report, an ISO/IEC 27001 certificate and an
 * ISO/IEC 42001 certificate describe **one implemented system** rather than three, and that
 * a fourth standard therefore costs a fraction of the third. That premise is either true of
 * the corpus or it is marketing, and the difference is a matrix somebody can read.
 *
 * So this is not a document. `lib/controls.js` already holds every obligation and every
 * crosswalk edge; a matrix typed out beside it would be a second copy of the edges, wrong
 * within a quarter and wrong exactly where a buyer looks. **Nothing here is written down —
 * every cell is an edge asked of the corpus at the moment of asking**, and the module's own
 * suite fails the repository for any control id appearing in this file at all.
 *
 * ## Rows, columns, and why they are not the same set
 *
 * A **column is an obligation**: something an organisation can be held to. That is every
 * record in a *certifiable* framework and nothing else. ISO/IEC 23894, 42005 and 5338 are
 * guidance — nobody is certified against them, nothing anybody signs cites them — so they
 * are never columns, and a report that gave them one would be presenting a reading list as
 * a conformance claim.
 *
 * A **row is a thing that claims to answer an obligation**, which is every record that
 * declares a crosswalk edge. Guidance *is* a row: a life-cycle process that elaborates an
 * Annex A control is real reuse and belongs in the picture, one hop away from the criterion
 * rather than pretending to satisfy it directly.
 *
 * A criterion is a column and never a row, because `lib/controls.js` refuses a criterion
 * that declares an edge. That asymmetry is the corpus's, not this module's, and it is why
 * the matrix has a direction — see below.
 *
 * ## Span is the number the premise rests on
 *
 * A row's `span` is how many certifiable frameworks it touches *at once*: its own, plus
 * every framework its edges reach. A row of span three is one implementation with three
 * names — write the control once, evidence it once, and three auditors are answered. That
 * is the count a buyer is being asked to believe and the count the programme plans against,
 * and {@link shared} is it.
 *
 * `span` counts certifiable frameworks only. A guidance row that elaborates one Annex A
 * control has reached one standard, not two, however many documents were consulted.
 *
 * ## The matrix has a direction, and pretending otherwise is the tempting error
 *
 * Edges run from controls *to* criteria, never the other way, because a criterion is
 * satisfied by many controls and keeping the list on the criterion is how it goes stale.
 * The consequence for a report is that **inbound and outbound are different questions and
 * only one of them is coverage**:
 *
 * - *What claims to satisfy this?* — inbound. This is coverage, and an obligation with no
 *   inbound edge is one nothing in the corpus answers.
 * - *What does this claim to satisfy?* — outbound. Almost every control has one and almost
 *   nothing points back at it, so counting outbound edges as coverage would report the
 *   whole of two ISO Annex A sets as covered while saying nothing at all.
 *
 * Both numbers are on every column, and only the first is called `covered`.
 *
 * ## An empty column is not always a gap, and the difference is applicability
 *
 * "Nothing claims this" is a finding only where the obligation is one this organisation
 * actually carries. Three answers, and each comes from somewhere rather than from a
 * judgement made here:
 *
 * - **elected / declined** — a Trust Services criterion is in scope if its category was
 *   elected. `lib/policies.js` holds that decision and this asks it. The declined
 *   categories are not a hole in the report: `lib/gapassessment.js` records which were
 *   considered and left out, with the decision that left them out.
 * - **mandatory** — a management-system clause. Nobody may exclude one, so every clause is
 *   an obligation and an empty clause column is a real finding: the management system is
 *   work that no other standard's control does for you.
 * - **undecided** — an Annex A control. Whether it applies is what a Statement of
 *   Applicability decides, and there is not one yet (bc-eqn1.14). Calling these obligations
 *   would inflate the gap list with controls that may be excluded on the day somebody
 *   writes the statement; calling them covered would be worse. They are counted, named and
 *   kept out of {@link uncovered}, and the day the statement lands this reads it instead.
 *
 * So {@link uncovered} is *in-scope obligations nothing claims*, and it is the coverage
 * check the whole exercise is for: adding a standard means adding its records to the corpus
 * and reading off the empty columns.
 *
 * ## Indirect reach is offered, and it is labelled
 *
 * Guidance reaches a criterion in two hops — through the control that implements it —
 * because the corpus refuses the direct edge. {@link reach} follows the edges transitively
 * so that route is answerable, and it is deliberately a separate function from
 * {@link cellsFor}. A cell is a claim somebody would defend to an auditor; a transitive
 * reach is an argument about why work is not duplicated. Rendering them the same is how a
 * matrix comes to assert something nobody meant.
 *
 * ## What it is not
 *
 * It is a join, not a register — the compliance leaves deliberately do not import each
 * other, so anything needing two of them is a file of its own, exactly as
 * `lib/systemdescription.js` and `lib/gapassessment.js` are. Its suite pins the import list
 * for that reason. It reads and computes; there is no state, no configuration directory, no
 * git and no network, and every number below is derived from the corpus on the call.
 */
import { FRAMEWORKS, FRAMEWORK_TOKENS, byFramework, corpus, crosswalk, satisfiedBy } from './controls.js';
import { ELECTED, HELD_BY, categoryOf, isElected } from './policies.js';

/**
 * Re-exported rather than restated — the election has one home and it is `lib/policies.js`.
 * `HELD_BY` names the organisation the report is about.
 */
export { ELECTED, HELD_BY };

/** What settled the questions this report reads rather than answers. */
export const DECIDED_BY = Object.freeze({
  categories: 'bc-yfgo',
  applicability: 'bc-eqn1.14',
});

/**
 * Why an obligation is or is not in scope, closed.
 *
 * `elected` and `mandatory` are in scope; `declined` was considered and left out;
 * `undecided` is waiting on a Statement of Applicability. {@link IN_SCOPE} is the pair that
 * counts, and it is named once so no caller re-decides it.
 */
export const APPLICABILITY = Object.freeze(['elected', 'declined', 'mandatory', 'undecided']);

/** The two that make an empty column a finding. */
export const IN_SCOPE = Object.freeze(['elected', 'mandatory']);

/**
 * The frameworks whose records may be columns — derived from the corpus, never listed.
 *
 * Written out, a token added to `lib/controls.js` and forgotten here would be invisible to
 * the report: its obligations would not be columns, so they could not be uncovered, so the
 * one thing this file exists to say would be silently narrower than it looks.
 */
export const OBLIGATION_FRAMEWORKS = Object.freeze(FRAMEWORK_TOKENS.filter((t) => FRAMEWORKS[t].certifiable));

/** Is this record something somebody can be certified or attested against? */
export const isObligation = (record) => Boolean(record) && OBLIGATION_FRAMEWORKS.includes(record.framework);

/**
 * Which of the three answers applies to an obligation, and where each comes from.
 *
 * A criterion asks `lib/policies.js`; a clause is mandatory by what a clause is; an Annex A
 * control is undecided until a Statement of Applicability says otherwise. Nothing here is a
 * judgement made in this file, which is what lets the answer change without an edit here.
 */
export function applicabilityOf(record) {
  if (!isObligation(record)) return null;
  if (record.kind === 'clause') return 'mandatory';
  if (record.kind === 'criterion') return isElected(record.id) ? 'elected' : 'declined';
  return 'undecided';
}

/** Narrow a token list to the ones that are actually frameworks, keeping corpus order. */
const tokensOf = (frameworks, allowed) => {
  const want = Array.isArray(frameworks) ? frameworks.map((t) => String(t || '').trim()) : null;
  return allowed.filter((t) => !want || want.includes(t));
};

/**
 * The columns — every obligation, with both edge counts and why it is or is not in scope.
 *
 * `covered` is inbound and only inbound, for the reason the header sets out. `claims` is
 * kept beside it because a column is very often a row as well, and a reader looking at one
 * Annex A control wants both halves without going and asking twice.
 */
export function columns({ frameworks = null } = {}) {
  const out = [];
  for (const token of tokensOf(frameworks, OBLIGATION_FRAMEWORKS)) {
    for (const record of byFramework(token)) {
      const claimedBy = satisfiedBy(record.id);
      const applicability = applicabilityOf(record);
      out.push(
        Object.freeze({
          id: record.id,
          framework: record.framework,
          local: record.local,
          title: record.title,
          kind: record.kind,
          group: record.group,
          groupName: record.groupName,
          applicability,
          inScope: IN_SCOPE.includes(applicability),
          claimedBy,
          covered: claimedBy.length > 0,
          claims: crosswalk(record.id),
        })
      );
    }
  }
  return Object.freeze(out);
}

/**
 * The rows — everything that declares a crosswalk edge, with the frameworks it reaches.
 *
 * `frameworks` is the certifiable set the row touches at once, its own included when its
 * own is certifiable. A guidance row's own framework is not in it, because nobody is
 * certified against guidance and a span that counted it would report reuse that no auditor
 * will ever be shown.
 */
export function rows({ frameworks = null } = {}) {
  const wanted = tokensOf(frameworks, FRAMEWORK_TOKENS);
  const out = [];
  for (const record of corpus().ids.values()) {
    if (!record.crosswalk.length) continue;
    if (!wanted.includes(record.framework)) continue;
    const touched = new Set(record.crosswalk.map((id) => id.split('.')[0]).filter((t) => OBLIGATION_FRAMEWORKS.includes(t)));
    if (OBLIGATION_FRAMEWORKS.includes(record.framework)) touched.add(record.framework);
    const reached = OBLIGATION_FRAMEWORKS.filter((t) => touched.has(t));
    out.push(
      Object.freeze({
        id: record.id,
        framework: record.framework,
        local: record.local,
        title: record.title,
        kind: record.kind,
        group: record.group,
        groupName: record.groupName,
        guidance: !FRAMEWORKS[record.framework].certifiable,
        covers: record.crosswalk,
        frameworks: Object.freeze(reached),
        span: reached.length,
      })
    );
  }
  return Object.freeze(out);
}

/** The obligations one row claims directly — its cells, in column order. */
export const cellsFor = (id) => crosswalk(id).filter((target) => isObligation(corpus().ids.get(target)));

/**
 * Everything an id reaches by following edges, however many hops.
 *
 * Guidance reaches a criterion in two, because the corpus refuses it the direct edge, and
 * this is how that route is answerable at all. **It is not a cell and must never be
 * rendered as one** — see the header. Cycles are impossible in the corpus today and are
 * survived here anyway, because a report that hangs is worse than one that is wrong.
 */
export function reach(id, seen = new Set()) {
  for (const target of crosswalk(id)) {
    if (seen.has(target)) continue;
    seen.add(target);
    reach(target, seen);
  }
  return seen;
}

/**
 * The whole matrix — columns, rows, and the sparse cell list.
 *
 * `frameworks` narrows the columns and `rowFrameworks` the rows, because those are two
 * different questions — one standard's obligations are still answered by controls from
 * everywhere — and one option meaning both would be unreadable at the call site.
 *
 * Sparse, because the dense grid is fifty thousand cells of which a few hundred are set,
 * and because the empty ones are not a thing to store: a cell is absent exactly when the
 * corpus has no edge, which is the one fact the whole artefact turns on. {@link csv}
 * densifies it for a spreadsheet, where the empty column is what a reader's eye finds.
 */
export function matrix({ frameworks = null, rowFrameworks = null } = {}) {
  const cols = columns({ frameworks });
  const index = new Set(cols.map((c) => c.id));
  const rs = rows({ frameworks: rowFrameworks });
  const cells = [];
  for (const row of rs) {
    for (const target of cellsFor(row.id)) {
      if (index.has(target)) cells.push(Object.freeze({ row: row.id, column: target }));
    }
  }
  return Object.freeze({ columns: cols, rows: rs, cells: Object.freeze(cells) });
}

/**
 * The rows that answer `min` certifiable standards at once — the premise, as a list.
 *
 * Three is the default because three is what the programme claims. Two is still reuse and
 * is worth asking for; one is every row in the corpus and answers nothing.
 */
export const shared = (min = 3, options = {}) =>
  rows(options)
    .filter((r) => r.span >= min)
    .sort((a, b) => b.span - a.span || a.id.localeCompare(b.id));

/**
 * In-scope obligations that nothing claims to satisfy. The coverage check.
 *
 * Deliberately *not* every empty column: an Annex A control whose applicability nobody has
 * decided is not yet an obligation, and padding this list with every one of them would bury
 * the ones that are. {@link undecided} is where those are counted instead, out loud.
 */
export const uncovered = (options = {}) => columns(options).filter((c) => c.inScope && !c.covered);

/** Obligations waiting on a Statement of Applicability, covered or not. Counted, never hidden. */
export const undecided = (options = {}) => columns(options).filter((c) => c.applicability === 'undecided');

/** Obligations considered and left out, with the decision in {@link DECIDED_BY}. */
export const declined = (options = {}) => columns(options).filter((c) => c.applicability === 'declined');

/** Every column of one framework, for a report that wants one standard's block at a time. */
export const forFramework = (token) => columns({ frameworks: [token] });

/** The numbers, all derived. Nothing here is a stored total. */
export function counts(options = {}) {
  const cols = columns(options);
  const rs = rows(options);
  const applicability = Object.fromEntries(APPLICABILITY.map((a) => [a, 0]));
  const perFramework = {};
  for (const c of cols) {
    applicability[c.applicability] += 1;
    const f = (perFramework[c.framework] ||= { obligations: 0, covered: 0, inScope: 0, uncovered: 0 });
    f.obligations += 1;
    if (c.covered) f.covered += 1;
    if (c.inScope) f.inScope += 1;
    if (c.inScope && !c.covered) f.uncovered += 1;
  }
  const span = {};
  for (const r of rs) span[r.span] = (span[r.span] || 0) + 1;
  return Object.freeze({
    obligations: cols.length,
    rows: rs.length,
    cells: cols.reduce((n, c) => n + c.claimedBy.length, 0),
    covered: cols.filter((c) => c.covered).length,
    uncovered: cols.filter((c) => c.inScope && !c.covered).length,
    applicability: Object.freeze(applicability),
    perFramework: Object.freeze(perFramework),
    span: Object.freeze(span),
    allStandards: rs.filter((r) => r.span >= OBLIGATION_FRAMEWORKS.length).length,
  });
}

/** One line, the same one the command prints first and the README quotes. */
export function summarise(options = {}) {
  const c = counts(options);
  const n = OBLIGATION_FRAMEWORKS.length;
  return (
    `${HELD_BY} · ${c.obligations} obligations across ${n} certifiable standards · ${c.cells} crosswalk edges · ` +
    `${c.allStandards} answer all ${n} at once · ${c.uncovered} in scope and unclaimed · ` +
    `${c.applicability.undecided} awaiting a statement of applicability`
  );
}

/** RFC 4180 enough for a spreadsheet: quote everything, double the quotes inside. */
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/**
 * The dense grid, for the one reader who wants a spreadsheet.
 *
 * This is the artefact a buyer is actually shown, and it is the same computation as
 * {@link matrix} rather than a second rendering of the same idea — which is what stops the
 * readable version and the shareable version disagreeing. Columns carry their applicability
 * in a second header line, so a blank column in the sheet can be read without a legend.
 */
export function csv({ frameworks = null, rowFrameworks = null } = {}) {
  const { columns: cols, rows: rs } = matrix({ frameworks, rowFrameworks });
  const set = new Set();
  for (const row of rs) for (const target of cellsFor(row.id)) set.add(`${row.id} ${target}`);
  const lines = [
    ['control', 'framework', 'title', 'span', ...cols.map((c) => c.id)].map(cell).join(','),
    ['', '', 'applicability', '', ...cols.map((c) => c.applicability)].map(cell).join(','),
  ];
  for (const row of rs) {
    lines.push(
      [row.id, row.framework, row.title, row.span, ...cols.map((c) => (set.has(`${row.id} ${c.id}`) ? 'x' : ''))]
        .map(cell)
        .join(',')
    );
  }
  return lines.join('\n');
}

/**
 * What would make this report a lie, checked rather than assumed.
 *
 * Run at import, because every failure below is a bug in how the matrix is derived and the
 * moment to find it is the suite importing the file — not the sales call where somebody
 * notices a column that should not be there.
 *
 * It takes the two derived structures rather than fetching them, so the suite can hand it a
 * doctored matrix and watch each rule fail. A rule only ever run against a matrix that
 * passes is a rule nobody has seen work. Note what is *not* injectable: the corpus itself,
 * because a cell is checked against the real declared edges and a fixture allowed to supply
 * those would be checking a claim against itself.
 */
export function reportProblems({ cols = columns(), cells = matrix().cells } = {}) {
  const problems = [];
  const ids = new Set(cols.map((c) => c.id));
  if (ids.size !== cols.length) problems.push('a column appears twice');
  for (const c of cols) {
    if (!FRAMEWORKS[c.framework]?.certifiable) problems.push(`${c.id} is a column and nobody is certified against ${c.framework}`);
    if (!APPLICABILITY.includes(c.applicability)) problems.push(`${c.id} has no applicability`);
    if (c.inScope !== IN_SCOPE.includes(c.applicability)) problems.push(`${c.id} is in scope and its applicability does not say so`);
    // A criterion whose category `lib/policies.js` cannot classify would fall through to
    // "declined" and vanish from the coverage check without anybody deciding anything. That
    // is the silent hole the election has, one level down, and it is refused here.
    if (c.kind === 'criterion' && !categoryOf(c.id)) problems.push(`${c.id} is a criterion in no category the election can read`);
    if (c.covered !== c.claimedBy.length > 0) problems.push(`${c.id} is marked covered against ${c.claimedBy.length} inbound edges`);
  }
  let declared = 0;
  for (const row of rows()) declared += cellsFor(row.id).filter((id) => ids.has(id)).length;
  if (cells.length !== declared) problems.push(`the matrix holds ${cells.length} cells and the corpus declares ${declared}`);
  for (const { row, column } of cells) {
    if (!ids.has(column)) problems.push(`a cell points at ${column}, which is not a column`);
    else if (!crosswalk(row).includes(column)) problems.push(`${row} has a cell at ${column} that the corpus does not declare`);
  }
  return problems;
}

const PROBLEMS = reportProblems();
if (PROBLEMS.length) throw new Error(`crosswalk report: ${PROBLEMS.join('; ')}`);
