/**
 * Gleaning a requirement out of work that has already shipped.
 *
 * The ordinary case, not the exception. Requirements are recorded once a ticket ships, so
 * a bead written on Monday usually names no requirement and often states nothing
 * requirement-shaped at all — the acceptance criterion is a sentence about this app, and
 * whatever general truth it was an instance of has to be read back out of it afterwards.
 *
 * **So the ask happens after the merge, and that is a claim about evidence rather than a
 * scheduling convenience.** A requirement gleaned from a plan is a guess about a diff that
 * does not exist yet; one gleaned from a landed diff is a description of something real —
 * the files are known, the tests that had to pass are known, and what the work turned out
 * to be is no longer in dispute. Everything this file does is arranged around asking at
 * the only moment the answer is cheap and correct.
 *
 * ## Why a label and not a queue
 *
 * A landing is noticed by `notePending` in lib/advocate.js, which runs inside a daemon
 * sweep with no agent anywhere near it. Something has to carry "this one still owes a
 * requirement" from that moment to the next time an advocate opens on the P0 above it,
 * and the tracker is the only thing here that both sides can see. So the bead is labelled
 * and the label *is* the queue: `bd list --label req-glean` is the backlog, it survives a
 * restart, it is visible from another Mac, and it cannot drift out of sync with itself
 * the way a second store would.
 *
 * The alternative — a list in the advocate's memory — was rejected for the reason
 * lib/claims.js gives for keeping file claims out of a file: a record that outlives the
 * thing it describes is worse than no record. A label is on the bead it is about, and
 * clearing it is one command by whoever did the work.
 *
 * ## The EpicAdvocate owns this, and it is asked for one thing at a time
 *
 * The section below goes into the P0 advocate's brief (lib/epicadvocate.js). It names the
 * children that landed, the commit each landed in, and the files each touched, and asks
 * for a candidate per bead — token, name, one definition sentence — written into the
 * child's own requirements block.
 *
 * **A candidate, never an id.** The advocate cannot mint an id, because minting one means
 * writing into `architecture`, which is a repo forty people clone; that is
 * lib/reqpromote.js's job and it goes through a human. What it can do is write the
 * sentence that would become one, in the corpus's own voice, at the moment it knows most.
 *
 * And "nothing here" is a real answer that the brief has to make cheap. Most work in a
 * personal repo fulfils no product requirement, and an agent that feels it owes an answer
 * will invent one — which is the failure lib/requirements.js exists to prevent, arriving
 * by a different door.
 */

/** The marker that says a landed bead still owes a requirement. `bd list --label` is the queue. */
export const GLEAN_LABEL = 'req-glean';

/**
 * Where the evidence rides, because a label cannot carry it.
 *
 * The label answers "does this owe a requirement"; the block answers "out of what" — the
 * commit it landed in and the files that commit touched. Both are known at landing time
 * and neither is recoverable later without walking history for a bead id, which is the
 * kind of lookup an advocate will decline to spend three tool calls on. Written as a
 * marked block in `notes` for lib/beadreqs.js's reasons, and read back off the same row
 * the label is read off, so the brief costs one `bd list`.
 */
export const GLEAN_OPEN = '<!-- beadcause:glean -->';
export const GLEAN_CLOSE = '<!-- /beadcause:glean -->';

/** How many files are kept on the bead. The brief quotes fewer; this is the record. */
const MAX_RECORDED = 20;

const tidy = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The block, or '' when there is no commit to point at. */
export function gleanBlock({ commit = '', files = [], at = '' } = {}) {
  const sha = tidy(commit, 40);
  if (!sha) return '';
  const list = [...new Set((files || []).map((f) => tidy(f, 300)).filter(Boolean))].slice(0, MAX_RECORDED);
  const payload = { commit: sha, files: list, at: tidy(at, 40) || new Date().toISOString() };
  return `${GLEAN_OPEN}\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n${GLEAN_CLOSE}`;
}

/** What landing wrote, read back off a `bd list --json` row. Null when there is none. */
export function gleanRecord(issue) {
  const text = String(issue?.notes || '');
  const from = text.indexOf(GLEAN_OPEN);
  if (from < 0) return null;
  const to = text.indexOf(GLEAN_CLOSE, from);
  const body = (to < 0 ? text.slice(from + GLEAN_OPEN.length) : text.slice(from + GLEAN_OPEN.length, to))
    .replace(/```(?:json)?/g, '')
    .trim();
  try {
    const parsed = JSON.parse(body);
    return parsed?.commit ? { commit: String(parsed.commit), files: Array.isArray(parsed.files) ? parsed.files : [], at: parsed.at || '' } : null;
  } catch {
    return null;
  }
}

/** `notes` with the block replaced or added. Splices, like lib/beadreqs.js, and for its reason. */
export function withGlean(notes, rec) {
  const text = String(notes || '');
  const block = gleanBlock(rec || {});
  const from = text.indexOf(GLEAN_OPEN);
  if (from < 0) return block ? `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${block}` : text;
  const to = text.indexOf(GLEAN_CLOSE, from);
  const head = text.slice(0, from).trimEnd();
  const tail = to < 0 ? '' : text.slice(to + GLEAN_CLOSE.length).trimStart();
  return [head, block, tail].filter(Boolean).join('\n\n');
}

/** How many landed beads one brief names. Beyond this it is a report, not a task. */
const MAX_NAMED = 8;

/** How many files are quoted per bead. Enough to recognise the work, not the whole diff. */
const MAX_FILES = 6;

const short = (sha) => String(sha || '').slice(0, 8);

/**
 * One line per bead that landed without naming a requirement.
 *
 * The commit and the files are the evidence, and they are quoted rather than left to be
 * looked up because the advocate is re-entrant and cheap: a brief that says "go and find
 * out what bc-x.3 touched" is three tool calls it will often not spend.
 */
export function gleanLines(pending = []) {
  return pending.slice(0, MAX_NAMED).map((p) => {
    const files = (p.files || []).slice(0, MAX_FILES);
    const more = (p.files || []).length > files.length ? `, +${p.files.length - files.length} more` : '';
    const where = files.length ? ` touching ${files.join(', ')}${more}` : '';
    return `- \`${p.bead}\`${p.title ? ` — ${p.title}` : ''} — landed in ${short(p.commit)}${where}`;
  });
}

/**
 * The section the P0 advocate is handed, or '' when nothing is owed.
 *
 * Empty rather than a cheerful "nothing to glean" for lib/memory.js's reason: a heading
 * over an empty list teaches an agent that the section is furniture, and the next one it
 * sees with something in it gets skipped too.
 */
export function gleanSection(pending = [], tokens = []) {
  if (!pending.length) return '';
  const vocab = tokens.length
    ? `The tokens that exist are: ${tokens.join(', ')}. Use one of them — a token that does not exist is a question for a human, not a file to invent.`
    : 'No requirements corpus is readable on this machine, so name the token you believe it belongs under and say that you could not check.';
  const more = pending.length > MAX_NAMED ? `\n\n…and ${pending.length - MAX_NAMED} more carrying the same label.` : '';

  return `
**${pending.length} bead${pending.length === 1 ? '' : 's'} under this P0 landed without naming a requirement.** They
are labelled \`${GLEAN_LABEL}\`, and clearing that label is part of this turn's work.

${gleanLines(pending).join('\n')}${more}

For each one, read what actually shipped — the bead, and the commit named above — and
decide whether it is an instance of something a person would write down as a requirement.
If it is, write a **candidate** onto that bead: a token, a short name, and one testable
definition sentence in the corpus's own voice. ${vocab}

    bd update <bead> --notes "$(...)"          # the requirements block, replacing any there
    bd update <bead> --remove-label ${GLEAN_LABEL}

**You may not mint a requirement id.** An id exists when it is written into the
architecture repo, which is a proposal a human approves — you are writing the sentence
that would become one, not the thing itself.

**And "this fulfils no requirement" is the right answer most of the time.** Most work in
this repo is about this repo. Say so, remove the label, and move on; a candidate invented
to fill the space is worse than an empty answer, because it will be promoted by somebody
who assumes you had a reason.`;
}
