import YAML from 'yaml';

/**
 * The `beadpr` block — a worker handing back finished work as a pull request.
 *
 * This is the ending that replaced "close the bead and hope". A session used to
 * finish by merging into main on the laptop and closing its bead, which meant the
 * first time Adam saw the change was in `git log`, after it had shipped. Now the
 * last thing a session does is push its branch, open a PR, and file *this* — an
 * ordinary `human` question whose answer is the merge:
 *
 *   ```beadpr
 *   workspace: beadcause
 *   bead: bc-7qo
 *   repo: mordam/beadcause
 *   number: 42
 *   url: https://github.com/mordam/beadcause/pull/42
 *   branch: bead/bc-7qo-delivery
 *   base: main
 *   method: squash
 *   summary: |
 *     What changed and why, in the words of whoever wrote it.
 *   tests: npm test — 42 passing
 *   risk: The poller now runs gh on every tick; it is cached, but that is new traffic.
 *   ```
 *
 * Deliberately the same shape as `beadproposal` (lib/proposal.js) and `decision`
 * (lib/decision.js): a fenced block inside an ordinary issue body, with prose above
 * it generated from the same parsed object so the two can never disagree. beads has
 * no schema for any of this and inventing a second mechanism to carry it would mean
 * a second thing that can rot.
 *
 * The live numbers — diffstat, checks, mergeability — are deliberately **not** in
 * the block. They are read from `gh` when the card is drawn, because a diffstat
 * frozen at the moment the session ended is a lie the instant anyone pushes to the
 * branch, and the one number that must be right is the one you are looking at when
 * you press merge. The block carries identity and intent; lib/pr.js carries state.
 */

const BLOCK_RE = /(^|\n)(?:```|~~~)[ \t]*beadpr[ \t]*\r?\n([\s\S]*?)(?:```|~~~)[ \t]*(?=\r?\n|$)/;

/** What marks a question as a worker delivering a PR. Searchable: `bd list --label=pr-delivery`. */
export const DELIVERY_LABEL = 'pr-delivery';

/**
 * The three markers, and why consent is checked against text.
 *
 * The phone sends the option's `response` string and an ntfy action button sends
 * the same — there is no option id on the wire. Rather than add one and have the
 * paths disagree, each acting answer *starts* with its marker and nothing else is
 * treated as consent. So free text can never merge a PR by accident: "looks good"
 * is a comment, which is exactly what it looks like, and the work stays unmerged
 * until something says `MERGE:`.
 */
export const MERGE_MARKER = 'MERGE:';
export const CHANGES_MARKER = 'CHANGES:';
export const CLOSE_MARKER = 'DROP:';

/**
 * Which of the three things an answer is asking for, or `null` for an ordinary
 * comment on the question.
 *
 * `note` is everything after the marker — for `CHANGES:` that is the actual request,
 * and it is what gets written onto the work bead for the next session to read, so it
 * is kept verbatim rather than normalised.
 */
export function deliveryAction(response) {
  const text = String(response || '').trimStart();
  for (const [action, marker] of [
    ['merge', MERGE_MARKER],
    ['changes', CHANGES_MARKER],
    ['close', CLOSE_MARKER],
  ]) {
    if (text.startsWith(marker)) return { action, note: text.slice(marker.length).trim() };
  }
  return null;
}

/** Split a body into { delivery, body } so the YAML never reaches the phone as a wall of text. */
export function splitDelivery(text) {
  const src = String(text || '');
  const m = src.match(BLOCK_RE);
  if (!m) return { delivery: null, body: src };
  const body = (src.slice(0, m.index) + '\n' + src.slice(m.index + m[0].length)).trim();
  return { delivery: parseDelivery(src), body };
}

const MERGE_METHODS = new Set(['squash', 'merge', 'rebase']);

/**
 * Pull the delivery out of an issue body. `null` when there isn't one, which is the
 * answer for every other question in the inbox.
 */
export function parseDelivery(text) {
  const m = String(text || '').match(BLOCK_RE);
  if (!m) return null;
  let spec;
  try {
    spec = YAML.parse(m[2]);
  } catch (err) {
    // Surfaced rather than swallowed. A delivery whose block won't parse must not
    // look like a question with nothing behind it: pressing merge would then do
    // nothing at all, silently, on the one card where that matters most.
    return { error: `beadpr block is not valid YAML: ${err.message.split('\n')[0]}` };
  }
  if (!spec || typeof spec !== 'object') return { error: 'beadpr block is empty' };

  const number = Number(spec.number ?? spec.pr ?? urlNumber(spec.url));
  if (!Number.isInteger(number) || number <= 0) {
    return { error: 'beadpr block names no pull request number' };
  }

  const method = String(spec.method ?? 'squash').toLowerCase();
  return {
    workspace: spec.workspace ? String(spec.workspace) : null,
    // The bead the work was for — the one that closes when this merges. Distinct
    // from the question's own id, which is this bead, and is closed by answering.
    bead: spec.bead ? String(spec.bead).trim() : null,
    repo: spec.repo ? String(spec.repo).trim() : null,
    number,
    url: String(spec.url ?? '').trim(),
    branch: String(spec.branch ?? '').trim(),
    base: String(spec.base ?? 'main').trim(),
    method: MERGE_METHODS.has(method) ? method : 'squash',
    summary: String(spec.summary ?? spec.body ?? '').trim(),
    tests: String(spec.tests ?? '').trim(),
    risk: String(spec.risk ?? spec.risks ?? '').trim(),
    // What the session decided not to do. Kept because the most common reason to
    // ask for changes is something the author already knew they had skipped.
    left: String(spec.left ?? spec.todo ?? '').trim(),
    error: null,
  };
}

const urlNumber = (url) => Number((String(url || '').match(/\/pull\/(\d+)/) || [])[1] || NaN);

/**
 * The question body a worker files: the same delivery twice over, once for Adam and
 * once for the machine.
 *
 * Everything above the block is what makes the PR judgeable from a phone without
 * opening GitHub — what changed, whether the tests ran, what the author is unsure
 * about. The link is there for when the answer is "I need to see the diff", which
 * is a perfectly good answer and one this is meant to make rarer, not impossible.
 */
export function deliveryBody(d, { context = '' } = {}) {
  const parts = [];

  parts.push(
    `**${d.repo || d.workspace}** — the ${d.workspace} worker finished **${d.bead}** and has opened a pull request. ` +
      `Nothing is merged until you say so: answering **Merge** squash-merges it and closes ${d.bead}, ` +
      `**Request changes** sends your note back to a session on the same branch.`
  );

  parts.push(`### [#${d.number} — ${d.title || d.branch}](${d.url})`);
  if (context) parts.push(context.trim());
  if (d.summary) parts.push(['**What changed**', '', d.summary].join('\n'));
  if (d.tests) parts.push(`**Tests:** ${d.tests}`);
  if (d.risk) parts.push(`**Worth knowing:** ${d.risk}`);
  if (d.left) parts.push(`**Left undone:** ${d.left}`);
  parts.push(`\`${d.branch}\` → \`${d.base}\``);

  // Two acting options and a free-text lane. `CHANGES:` is offered as an option so
  // the ntfy button has something to send, but the useful version of it is typed —
  // "change what?" is the whole content of the answer, and a button cannot carry it.
  parts.push(
    [
      '```decision',
      `question: Merge #${d.number} into ${d.base}?`,
      'options:',
      '  - id: merge',
      `    label: Merge #${d.number}`,
      `    response: "${MERGE_MARKER} ${d.method} and merge #${d.number}, then close ${d.bead}."`,
      `    hint: ${d.method} · deletes the branch`,
      '  - id: changes',
      '    label: Request changes',
      `    response: "${CHANGES_MARKER} not yet — see my note on the bead."`,
      '    hint: sends it back to a session on the same branch',
      '  - id: drop',
      '    label: Close it unmerged',
      `    response: "${CLOSE_MARKER} close #${d.number} without merging."`,
      `links:`,
      `  - [#${d.number} on GitHub](${d.url})`,
      '```',
    ].join('\n')
  );

  parts.push(
    ['_What merging would act on, in the form the server reads it:_', '', '```beadpr', YAML.stringify(strip(d)).trimEnd(), '```'].join(
      '\n'
    )
  );

  return parts.join('\n\n');
}

/** What goes in the block: identity and intent, no live state, no empties. */
function strip(d) {
  const out = {
    workspace: d.workspace,
    bead: d.bead,
    repo: d.repo,
    number: d.number,
    url: d.url,
    branch: d.branch,
    base: d.base,
    method: d.method,
  };
  for (const k of ['summary', 'tests', 'risk', 'left']) if (d[k]) out[k] = d[k];
  return out;
}

/** A one-line title for the question itself. */
export function deliveryTitle(d) {
  return `Merge #${d.number}? ${d.title || d.bead}`.slice(0, 160);
}
