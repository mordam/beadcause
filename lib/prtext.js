/**
 * The title and the body of a pull request beadcause opens.
 *
 * Both used to be expressions inside `bin/deliver.js` — one template literal and one
 * array with a `.join('\n')` on the end — which is why neither was ever tested and why
 * both were wrong in ways you could read on github.com without knowing anything about
 * this codebase.
 *
 * ## What was wrong with the body, and why nobody caught it
 *
 * The array had `''` entries in it, in exactly the places markdown needs a blank line,
 * and then a `.filter((l) => l !== '')` took them all out again on the way to the join.
 * The filter was there for the optional fields — `--tests`, `--risk`, `--left` each
 * contribute `''` when unset — and it could not tell those apart from the separators
 * placed on purpose. Two things followed, on every pull request this has ever opened:
 *
 * - the opening line ran straight into the summary's first paragraph, so a body whose
 *   first sentence was written to stand alone was rendered as its preamble;
 * - the trailing `---` landed directly underneath the last line of prose, and `text`
 *   followed by `---` is **setext** — GitHub rendered the "Worth knowing" paragraph, the
 *   one that exists to carry a risk, as an `<h2>` with a rule under it.
 *
 * Neither is visible in the source, both are obvious in the rendered page, and nothing
 * between the two ever looked. So the body is assembled here from *blocks* instead of
 * lines: a block is a paragraph, empties are dropped, and the join puts the blank line
 * back between whatever survives. A separator cannot be filtered out because there are
 * no separators to filter.
 *
 * ## What was wrong with the title
 *
 * `<beadId>: <bead.title>`, uncapped. Bead titles in this tracker are whole sentences —
 * the one on bc-lco2 is 118 characters — and a pull request title is read in four places
 * that are all narrower than that: GitHub's list, an ntfy notification, the delivery
 * card's heading, and `Merge #<n>? …` sliced at 160 characters with the number already
 * spent. A title that says everything in the source says nothing in any of them.
 *
 * So `prTitle` takes the head clause when the bead title has one — the half before the
 * first `:` or `—`, which is how these titles are written and is almost always the
 * summary of the summary — and falls back to a word-boundary cut. Nothing is lost by
 * that: the full bead title goes into the body's footer, where a reader who wants it is
 * one scroll away and a *machine* reading it is looking at the `bead:` line beside it.
 *
 * ## And the half that was missing
 *
 * `~/climative.dev/architecture/agent-context/skills/climative-create-pr` puts it in one
 * sentence — *a PR description describes intent; the diff describes reality* — and asks
 * that the second be reconciled against the first before pushing, by copy-pasting from
 * `git diff <base>...HEAD --name-only` rather than writing from memory. A worker writing
 * its summary is writing from memory by definition; it has been editing files for an
 * hour and the summary is what it believes it did. So the reconciliation is done here,
 * mechanically, from the branch itself: `diffstat` parses `--numstat` and the body
 * carries the result in a `<details>` — which keeps the description to the one page the
 * same skill asks for while making the claim checkable in one click.
 *
 * Everything in this file is pure. It takes strings and returns strings, touches no
 * process and no network, and that is the point: `test/prtext.mjs` renders the real
 * bodies and asserts on the markdown, which is the thing that was broken.
 */

/** The longest a title's descriptive half may be before it is cut. */
const TITLE_LIMIT = 72;

/**
 * Below this a head clause is a fragment rather than a title, so the cut is refused.
 *
 * Sixteen because `Pause an EpicAdvocate` is twenty-one and is exactly the title anybody
 * would have written, while `Fix` and `Also` and `bc-x` are the things a lower bound is
 * here to refuse. It is a length and not a word count on purpose: two long words say more
 * than four short ones, and the constraint being defended is characters on a card.
 */
const MIN_CLAUSE = 16;

/** How many files the diffstat names before it stops and says how many are left. */
const MAX_FILES = 40;

/**
 * The pull request's title: `<beadId>: <one readable clause>`.
 *
 * `raw` is whatever the session passed to `--title`, or the bead's own title, or the
 * branch name — this does not care which, and deliberately treats all three the same.
 * A session that writes its own title gets the same length discipline as one that does
 * not, because the reason for the discipline is where the string is read and not who
 * wrote it.
 *
 * Five things happen to it, in this order, and the order matters:
 *
 * 1. **Whitespace collapses.** A newline inside `--title` is not a formatting problem,
 *    it is a broken `gh pr create` argument, and a bead title pasted out of a plan can
 *    have one in it.
 * 2. **A bead id at the front is taken off.** `--title "bc-x: does the thing"` is the
 *    natural thing to type and would otherwise render as `bc-x: bc-x: does the thing`.
 * 3. **A trailing full stop goes.** Only a full stop: `?` and `!` and `…` are all doing
 *    something a period is not.
 * 4. **It is shortened if it must be** — see `shorten`.
 * 5. **The first letter is capitalised**, last, so it applies to whatever survived the
 *    shortening rather than to a word the cut removed.
 */
export function prTitle(beadId, raw, { limit = TITLE_LIMIT } = {}) {
  const id = String(beadId || '').trim();
  let text = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (id) {
    const lead = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\\u2014-]\\s*`, 'i');
    text = text.replace(lead, '').trim();
  }
  text = text.replace(/\.+$/, '').trim();
  text = shorten(text, limit);
  text = text.charAt(0).toUpperCase() + text.slice(1);

  if (!text) return id || 'Untitled';
  return id ? `${id}: ${text}` : text;
}

/**
 * Cut a title down to `limit`, preferring a boundary its author already put there.
 *
 * A bead title on this board reads *"Pause an EpicAdvocate: stop dispatching under one
 * P0, and tell its live windows to write their memory first"* — a claim, a colon, the
 * detail, a comma, the second detail. Every one of those punctuation marks is a place the
 * sentence can stop and still be a sentence, which is the whole difference between a
 * shortened title and a truncated one.
 *
 * It takes the **last** such boundary inside the budget rather than the first. Taking the
 * first is the tidier-looking rule and it gives up information for nothing: on the title
 * above it yields *"Pause an EpicAdvocate"* and leaves forty characters of the budget
 * unspent, where the last yields *"Pause an EpicAdvocate: stop dispatching under one P0"*
 * and stops in the same place a person would have. `MIN_CLAUSE` is the floor that stops it
 * taking *"Fix"* off the front of `Fix: …`.
 *
 * With no boundary at all it cuts on a word and marks the cut with an ellipsis, because a
 * title that has been shortened and does not say so reads as a sentence somebody forgot to
 * finish.
 */
function shorten(text, limit) {
  if (text.length <= limit) return text;

  let best = -1;
  for (const m of text.matchAll(/\s*[,;:]\s|\s+[—–]\s+/g)) {
    const at = m.index;
    if (at >= MIN_CLAUSE && at <= limit && at > best) best = at;
  }
  if (best > -1) return text.slice(0, best).trim();

  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > MIN_CLAUSE ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, '')}…`;
}

/**
 * `git diff --numstat <base>...HEAD`, as something a body can be written from.
 *
 * `--numstat` and not `--stat` because `--stat` is already formatted for a terminal of
 * some assumed width and truncates long paths with an ellipsis in the middle — which is
 * fine to look at and useless to reconcile against, since the path it prints is not a
 * path. This parses the three-column form and does its own rendering.
 *
 * Binary files report `-` for both counts. They are counted as files and contribute
 * nothing to the line totals, which is the truth: a PNG has no lines.
 *
 * Rename entries (`a/{b => c}/d`) are left exactly as git wrote them. Unpicking them
 * into two paths would be more work to arrive at less information.
 */
export function diffstat(raw) {
  const files = [];
  let added = 0;
  let removed = 0;

  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const plus = m[1] === '-' ? null : Number(m[1]);
    const minus = m[2] === '-' ? null : Number(m[2]);
    if (plus !== null) added += plus;
    if (minus !== null) removed += minus;
    files.push({ path: m[3], added: plus, removed: minus, binary: plus === null });
  }

  files.sort((a, b) => (b.added || 0) + (b.removed || 0) - ((a.added || 0) + (a.removed || 0)) || a.path.localeCompare(b.path));
  return { files, added, removed };
}

/**
 * The "Files changed" block, or `''` when there is nothing to say.
 *
 * Collapsed by default. The point of it is that the claim above it can be *checked* —
 * it is not asking to be read, and a body that opens with forty file names has buried
 * the paragraph that says why they changed.
 *
 * The paths are in a fenced block so that a path containing `_` or `*` is the path and
 * not an accident of emphasis, and so the columns line up.
 */
export function filesBlock(stat, base) {
  const { files, added, removed } = stat || {};
  if (!files?.length) return '';

  const shown = files.slice(0, MAX_FILES);
  const width = Math.max(...shown.map((f) => f.path.length));
  const rows = shown.map((f) => `${f.path.padEnd(width)}  ${f.binary ? 'bin' : `+${f.added} −${f.removed}`}`);
  if (files.length > shown.length) rows.push(`… and ${files.length - shown.length} more`);

  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  const head = `${count} · +${added} −${removed}${base ? ` · against \`${base}\`` : ''}`;

  return `<details><summary><b>Files changed</b> — ${head}</summary>\n\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n\n</details>`;
}

/**
 * Bare `#123` references in prose, which are a hazard in a workspace of forty repos.
 *
 * GitHub autolinks any `#N` in a body to issue or pull request N **in the repo the body is
 * in**, and it does that regardless of what the surrounding words say and regardless of a
 * full URL to the real one sitting on the same line. The create-pr skill in `agent-context`
 * calls this out as a hard requirement for exactly one reason: it is silent. The reference
 * resolves, it renders as a link, and it points at an unrelated pull request in a different
 * service — which is worse than a broken link, because a broken link gets looked at.
 *
 * Only worth saying in a workspace that is more than one repo. Where the workspace *is* the
 * repo, `#N` means what it says and warning about it would be noise on every delivery.
 *
 * Refs already inside a URL are skipped — `…/pull/12` is not a bare reference — as are
 * fenced code blocks, where a `#3` is far more likely to be a comment than a link.
 */
export function bareRefs(text) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, '');
  const out = new Set();
  for (const m of prose.matchAll(/(\S)?#(\d+)\b/g)) if (!m[1] || !/[/\w]/.test(m[1])) out.add(`#${m[2]}`);
  return [...out];
}

/**
 * Who opened this, what merges it, and which bead it is — the last block of the body.
 *
 * It ends with a bare `bead: <id>` line, and that line is not decoration. `candidateTiers`
 * in lib/beadref.js reads a pull request three ways to work out what it delivers, and the
 * strongest of the three is a body that *declares* it in exactly this shape; the other two
 * are the title and a guess off the branch name. Both of those are strings a session is
 * free to overwrite with `--title` or a hand-named worktree, and when they stop naming the
 * bead the sweep in lib/landed.js stops being able to close it. This line cannot be
 * overwritten by anything, so the declaration is always there to be found.
 */
export function footer({ beadId, beadTitle = '', owner = 'the owner', autoMerge = false, requireApproval = false, editHold = false, gate = '' }) {
  const named = beadTitle ? `${beadId} — *${beadTitle.replace(/\s+/g, ' ').trim()}*` : beadId;
  const how = autoMerge
    ? `It merges itself once the checks report${requireApproval ? ' and it has an approving review' : ''}; ` +
      `merging is what closes the bead. If this is still open, something stopped that, and the reason is on ` +
      `${beadId} and in ${owner}'s inbox.`
    : `Merging is what closes the bead, and it is not merged until ${owner} answers the question in their inbox.` +
      `${editHold ? ' This one was typed into the running app with edit mode on, and an in-app edit is merged by the person who asked for it.' : ''}` +
      `${gate ? ` This one is labelled \`${gate}\`, and ${gate === 'needs-approval' ? 'is waiting on an approval a green pull request is not' : 'a gate closes when it is met, which a pull request merging is no evidence about'} — it was never on the merge queue either.` : ''}`;

  return `_Opened by a beadcause worker session on ${named}. ${how}_\n\nbead: ${beadId}`;
}

/**
 * The whole body.
 *
 * Blocks in, one string out, with a blank line between every pair — which is the entire
 * fix to the two rendering bugs this file was written for. Nothing downstream filters
 * anything, so an optional field that is absent contributes an empty block and empty
 * blocks are dropped here, before the separators exist rather than after.
 *
 * `summary` leads, because the skill this follows says to lead with what changed and
 * why. A summary that opens by restating the pull request's own title is a paragraph
 * spent saying nothing, and that happens more often than not — a session writes the
 * bead's title as its first sentence out of habit — so the repeat is taken off.
 */
export function prBody({
  beadId,
  beadTitle = '',
  title = '',
  summary = '',
  tests = '',
  risk = '',
  left = '',
  stat = null,
  base = '',
  owner = 'the owner',
  autoMerge = false,
  requireApproval = false,
  editHold = false,
  gate = '',
}) {
  const blocks = [
    withoutEchoedTitle(summary, [title, beadTitle], beadId),
    tests ? `**Tests:** ${tests}` : '',
    risk ? `**Worth knowing:** ${risk}` : '',
    left ? `**Left undone:** ${left}` : '',
    filesBlock(stat, base),
    '---',
    footer({ beadId, beadTitle, owner, autoMerge, requireApproval, editHold, gate }),
  ];

  return blocks
    .map((b) => String(b || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Drop the summary's first line when it is the title again.
 *
 * Checked against **both** titles, because they are two different sentences and a session
 * can echo either: the pull request's own title, which has been through `prTitle` and may
 * be a clause of the original, and the bead's title, which is what a session that opened
 * with "here is what I did" was most likely copying. On bc-lco2's delivery the first line
 * of the summary was the bead title exactly, and the PR title was the six words before its
 * first colon — comparing against one of the two would have caught neither case reliably.
 *
 * Punctuation and case come off both sides first, since the strings arrive from the same
 * sentence by different routes. Only a *whole* first line is ever removed, and only when a
 * line follows it: a summary that is one sentence long and happens to be the title is
 * still the summary, and taking it away would leave the pull request with no description.
 */
function withoutEchoedTitle(summary, titles, beadId) {
  const text = String(summary || '').trim();
  const lines = text.split('\n');
  const rest = lines.slice(1).join('\n').trim();
  if (!text || !rest) return text;

  const norm = (s) =>
    String(s || '')
      .replace(new RegExp(`^\\s*${String(beadId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\\u2014-]\\s*`, 'i'), '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const first = norm(lines[0]).replace(/[.…]+$/, '');
  if (!first) return text;

  for (const candidate of [].concat(titles)) {
    const head = norm(candidate);
    if (!head) continue;
    // A shortened title is a prefix of the sentence it was cut out of, so the echo is
    // still an echo — `prTitle` marks its own cuts with an ellipsis, which is what makes
    // that safe to act on rather than a guess about two strings that happen to start alike.
    const hit = head.endsWith('…') ? first.startsWith(head.slice(0, -1).trim()) : first === head.replace(/\.+$/, '');
    if (hit) return rest;
  }
  return text;
}
