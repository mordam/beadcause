import YAML from 'yaml';

/**
 * The `beadpr` block — a worker handing a pull request to Adam because it could not
 * land it itself.
 *
 * This was the ordinary ending and is now the exception, which is worth stating
 * plainly because nothing in the code below changed when that happened. A worker's
 * last act is still `beadcause-deliver`: push the branch, open the pull request. What
 * follows it is now the worker's own `gh pr merge` — see bin/deliver.js — and this
 * block is what gets written when that merge does not happen: GitHub refused it, a
 * check went red, the checks never reported, or the session asked for review outright
 * with `--review`.
 *
 * So the card this builds is unchanged in shape and changed in meaning. It used to be
 * *the* gate on every piece of work, and it is now the answer to "something stopped
 * this landing on its own" — which is exactly the card worth carrying to a phone, and
 * a far smaller number of them per day.
 *
 * It is an ordinary `human` question whose answer is the merge:
 *
 *   ```beadpr
 *   workspace: beadcause
 *   bead: bc-7qo
 *   repo: mordam/beadcause
 *   number: 42
 *   url: https://github.com/mordam/beadcause/pull/42
 *   branch: bead/bc-7qo-delivery
 *   base: main
 *   method: merge
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
 * The four markers, and why consent is checked against text.
 *
 * The phone sends the option's `response` string and an ntfy action button sends
 * the same — there is no option id on the wire. Rather than add one and have the
 * paths disagree, each acting answer *starts* with its marker and nothing else is
 * treated as consent. So free text can never merge a PR by accident: "looks good"
 * is a comment, which is exactly what it looks like, and the work stays unmerged
 * until something says `MERGE:`.
 *
 * `SHIP:` is the widest of the four and the newest: it merges *and* runs the repo's
 * declared deploy, which on this repo restarts beadcause itself. It gets its own
 * marker rather than a flag on `MERGE:` for exactly the reason the others are
 * separate words — the wire carries the response string and nothing else, so a
 * distinct prefix is the whole protocol, and "merge" must never widen into "merge
 * and deploy" because someone appended a sentence to it.
 */
export const MERGE_MARKER = 'MERGE:';
export const SHIP_MARKER = 'SHIP:';
export const CHANGES_MARKER = 'CHANGES:';
export const DECLINE_MARKER = 'DECLINE:';

/**
 * Which of the four things an answer is asking for, or `null` for an ordinary
 * comment on the question.
 *
 * `note` is everything after the marker, kept verbatim rather than normalised, because
 * for two of the four it is the entire content of the answer: for `CHANGES:` it is
 * the request, and for `DECLINE:` it is the direction to take instead. Both end up on
 * the work bead, which is what the next session reads before it starts.
 *
 * The difference between those two is worth stating, because from a phone they look
 * adjacent and they are not. **Changes** means the branch is right and something on it
 * is wrong — push more commits to it, same PR, same approach. **Decline** means the
 * approach is wrong — the PR closes, the branch is abandoned, and the bead goes back
 * to the queue for someone to start again. A note on a decline is optional but is the
 * most valuable sentence in the whole channel: without it the next session has been
 * told only that its predecessor was wrong, which is exactly enough information to do
 * the same thing again.
 *
 * **Merge** and **ship** are the pair that look adjacent and are not. Both merge, and
 * exactly the same merge; ship then runs the repo's declared deploy on top, so what is
 * *running* changes and not just what is on `origin`. Merge is therefore the safe one
 * and stays the default answer — a merge you did not want to deploy yet is a `POST
 * /api/deploy` away, and a deploy you did not want is not undoable from a phone.
 */
export function deliveryAction(response) {
  const text = String(response || '').trimStart();
  for (const [action, marker] of [
    ['merge', MERGE_MARKER],
    ['ship', SHIP_MARKER],
    ['changes', CHANGES_MARKER],
    ['decline', DECLINE_MARKER],
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
 * How a merge method reads in a sentence, and in the one typed back on the wire.
 *
 * `squash` and `rebase` compose: "squash-merges it", "squash and merge #42". `merge`
 * does not — "merge-merges it" and "merge and merge #42" are the template showing
 * through — and `merge` is now the default (`pr.mergeMethod` in lib/config.js), so it
 * would be the wording on nearly every card rather than a rare one. The method is still
 * named in the hint beside the button, which is where it is a fact rather than grammar.
 */
const mergesIt = (m) => (m === 'merge' ? 'merges it with a merge commit' : `${m}-merges it`);
const mergeVerb = (m, n) => (m === 'merge' ? `merge #${n}` : `${m} and merge #${n}`);

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

  // `merge` for an absent or unrecognised method, matching `pr.mergeMethod`'s default
  // and for its reason: a squash merge is the one outcome that leaves the branch a
  // non-ancestor of main, which is what the worktree cleanup gates on. Every block
  // bin/deliver.js writes names a method, so this is the hand-written or older card.
  const method = String(spec.method ?? 'merge').toLowerCase();
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
    method: MERGE_METHODS.has(method) ? method : 'merge',
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
 *
 * The first paragraph is built from *why this card exists*, and there are three
 * different answers now that a worker normally merges its own work. They are kept
 * distinct rather than folded into one polite sentence, because the first thing to
 * know when one of these arrives is which of the three happened:
 *
 * - **`refused`** — it tried to merge and could not. GitHub's own sentence, or the
 *   red check that stopped it, is the most important text on the card: it is the
 *   difference between "press merge" and "this needs a rebase first".
 * - **`asked`** — the worker could have merged and chose not to, which is the one
 *   thing a worker is allowed to escalate on judgement alone. Worth saying outright,
 *   or the card looks identical to a refusal and invites a puzzled look at green
 *   checks.
 * - **Neither** — `pr.autoMerge` is off, so every delivery is a question and this one
 *   is not special. The original wording, kept verbatim.
 */
export function deliveryBody(d, { context = '', refused = '', asked = false, ship = '' } = {}) {
  const parts = [];

  const opening = refused
    ? `**${d.repo || d.workspace}** — the ${d.workspace} worker finished **${d.bead}**, opened a pull request and ` +
      `tried to merge it. **It could not:** ${refused} So it is yours: answering **Merge** ${mergesIt(d.method)} ` +
      `and closes ${d.bead}, **Request changes** sends your note back to a session on the same branch.`
    : asked
      ? `**${d.repo || d.workspace}** — the ${d.workspace} worker finished **${d.bead}** and opened a pull request. ` +
        `It could have merged this itself and **deliberately did not** — it wants your eyes on it, and its reason is ` +
        `below. Answering **Merge** ${mergesIt(d.method)} and closes ${d.bead}, **Request changes** sends your note ` +
        `back to a session on the same branch.`
      // This branch said "squash-merges it" whatever the block asked for — the one of the
      // three the wording fix missed, and now the one it matters most on: with
      // `pr.autoMerge` off, every delivery there is comes through here.
      : `**${d.repo || d.workspace}** — the ${d.workspace} worker finished **${d.bead}** and has opened a pull request. ` +
        `Nothing is merged until you say so: answering **Merge** ${mergesIt(d.method)} and closes ${d.bead}, ` +
        `**Request changes** sends your note back to a session on the same branch.`;
  // The fourth option, and the only one whose absence is normal. Most repos declare no
  // deploy at all (lib/deploy.js), and a card that offered to ship one would be offering
  // a button with nothing behind it. So the sentence and the option arrive together or
  // not at all, and what `ship` says is what the deploy will actually run — not a
  // generic promise, because "deploy it" means something different in every repo.
  parts.push(ship ? `${opening} **Ship it** does the same and then deploys — ${ship}.` : opening);

  parts.push(`### [#${d.number} — ${d.title || d.branch}](${d.url})`);
  if (context) parts.push(context.trim());
  if (d.summary) parts.push(['**What changed**', '', d.summary].join('\n'));
  if (d.tests) parts.push(`**Tests:** ${d.tests}`);
  if (d.risk) parts.push(`**Worth knowing:** ${d.risk}`);
  if (d.left) parts.push(`**Left undone:** ${d.left}`);
  parts.push(`\`${d.branch}\` → \`${d.base}\``);

  // Two or three acting options and a free-text lane. `CHANGES:` is offered as an
  // option so the ntfy button has something to send, but the useful version of it is
  // typed — "change what?" is the whole content of the answer, and a button cannot
  // carry it.
  //
  // Four is the ceiling a phone can show without the list becoming a menu, which is
  // the whole reason `ship` is conditional rather than always drawn and disabled: a
  // repo with no deploy declared gets the three it always had.
  parts.push(
    [
      '```decision',
      `question: Merge #${d.number} into ${d.base}?`,
      'options:',
      '  - id: merge',
      `    label: Merge #${d.number}`,
      `    response: "${MERGE_MARKER} ${mergeVerb(d.method, d.number)}, then close ${d.bead}."`,
      `    hint: ${d.method} · deletes the branch`,
      // Second rather than first, deliberately. Merge is the recoverable one — a merge
      // you meant to ship is one more tap on the PR board, and a deploy you did not
      // mean is not a tap at all — so the wider answer is never the one under a thumb
      // aiming at the top button.
      ...(ship
        ? [
            '  - id: ship',
            `    label: Ship #${d.number}`,
            `    response: "${SHIP_MARKER} ${mergeVerb(d.method, d.number)}, then deploy ${d.workspace || 'it'}."`,
            `    hint: merge, then ${ship}`,
          ]
        : []),
      '  - id: changes',
      '    label: Request changes',
      `    response: "${CHANGES_MARKER} not yet — see my note on the bead."`,
      '    hint: same branch, same PR — push more commits to it',
      '  - id: decline',
      '    label: Decline it',
      `    response: "${DECLINE_MARKER} close #${d.number} — this approach is not the one."`,
      `    hint: closes the PR and puts ${d.bead || 'the bead'} back in the queue`,
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
