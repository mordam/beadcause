/**
 * The other end of lib/edits.js: what a *worker* is told when the bead it opened on was
 * typed into the running app.
 *
 * lib/edits.js turns a pass with edit mode on into beads. Every one of those beads is
 * then ordinary ready work — the advocate queues it, `openWorkSession` opens a window on
 * it, and the session gets the same brief every other bead gets. That brief is right
 * about almost everything and wrong about the two things that make an in-app edit
 * different from a task somebody wrote out in words.
 *
 * ## An anchor is not a description, and the first job is turning it into a source site
 *
 * A bead filed from a screen carries `anchorFor`'s record: the selector chain, the class
 * names, the visible text, and the lines of source the app's own search matched. That
 * record is worth more than any sentence Adam could have typed on a phone — and it is
 * the one part of the bead an agent reads straight past, because it is a JSON block at
 * the bottom under a heading that looks like provenance. So the brief lifts it out and
 * says what it is for, per bead, with the actual file and line in it.
 *
 * **Two searches, and they answer different questions.** `anchor.text.sites` is where the
 * *string on the screen* is written, which is the only thing a retype may touch.
 * `anchor.source.sites` is where the *element* is drawn, found by class name and narrowed
 * by the chain, which is where a described or pointed edit has to be implemented. They
 * are usually the same file and often the same line, and when they are not it is
 * precisely because the element is drawing data — the case where confusing them means
 * editing the tracker instead of the app.
 *
 * ## Two kinds of edit, and the line between them is the whole epic
 *
 * A **retype** is the one literal edit in bc-p49x: a hand-written string in this app's
 * own source, replaced with another. It should come out very nearly character-exact, and
 * an agent that "improves" the wording on the way past has done something nobody asked
 * for. Everything else is **intent** — a sentence about what should be different —
 * implemented in the layout system this app already has. Nothing captured geometry;
 * public/editmode.js deliberately records the *relationship* a drop landed in and throws
 * the pixels away. So there is no before-and-after to diff and "56 pixels left" is not
 * something anybody can ask a stylesheet for. An agent handed a drag and no rule reaches
 * for absolute positioning, which is the one outcome the epic says outright it does not
 * want.
 *
 * ## An unresolvable anchor is a question, not a guess
 *
 * `found: 0` is an honest report — the element could not be traced to source at all —
 * and `found: 3` is the app saying it narrowed as far as it could and there are still
 * three candidates. Both are states this file names and hands back through
 * `beadcause-ask`, because the alternative is an unattended session editing whichever of
 * three lines it liked the look of, in a repo nobody is reading, at three in the
 * morning. The brief already carries the ask command; what it did not carry is the
 * sentence saying that this is one of the two occasions to use it.
 *
 * ## And it stops at the pull request
 *
 * Adam's standing line is that the reversible preparation is automatable and the publish
 * is a tap. Every other worker in beadcause merges its own work, and that is right for a
 * bead somebody decided was work: it was on the board, it went through review by
 * existing, and the diff is against a specification written in prose. An in-app edit had
 * none of that. It is a sentence said to a screen, and the whole of the review is Adam
 * looking at what came back — so the tap is the **Merge** on its delivery card, and the
 * worker's job ends at the pull request.
 *
 * That is said in two places on purpose, and only one of them is a sentence. The brief
 * asks the session to deliver with `--review`; `bin/deliver.js` refuses to auto-merge one
 * of these whether it was asked to or not (`fromEditMode` below). A brief is a promise
 * about what a command will do, and the command is what actually keeps it — a session
 * that forgets the flag, or a future brief that stops saying it, must not be able to put
 * an unreviewed in-app edit into main.
 */
import { EDIT_LABEL, KINDS, quote } from './edits.js';

/** The one-line reason a delivery of one of these hands over instead of merging. */
export const EDIT_HOLD =
  'this bead was typed into the running app with edit mode on, and an in-app edit is merged by ' +
  'the person who asked for it';

/** Did this bead arrive through edit mode's Save — pass, edit or standing root alike? */
export const fromEditMode = (row) => (row?.labels || []).some((l) => String(l).trim() === EDIT_LABEL);

/**
 * Is this bead **one edit**, as opposed to the pass holding it or the root holding that?
 *
 * All three carry the label; only the leaf is work. The pass and the root are epics
 * (lib/edits.js says why the pass is one), so the type is the whole distinction — and it
 * is the right way round for a bead this cannot read: something new under the label that
 * is not an epic gets the edit brief, which is a section of prose, where an epic wrongly
 * given it would be told to grep for an anchor that is not there. The epics are not left
 * with nothing — see `passBriefFor`, which is what they get instead.
 */
export const isEditBead = (row) => fromEditMode(row) && String(row?.issue_type || '') !== 'epic';

/**
 * The record lib/edits.js wrote into the description, back out again.
 *
 * The **last** fenced JSON block, not the first: the block is the last thing `bodyFor`
 * writes, and a note Adam typed could perfectly well contain one of its own. Anything
 * that does not parse, or parses to a kind that is not one of the three gestures, is
 * `null` — a bead carrying the label and no readable anchor is a real state (an edit
 * filed before this existed, or one somebody hand-edited), and the brief has a paragraph
 * for it rather than a stack trace.
 */
export function editOf(row) {
  const text = String(row?.description || '');
  const at = text.lastIndexOf('```json');
  if (at === -1) return null;
  const end = text.indexOf('```', at + 7);
  if (end === -1) return null;
  let record = null;
  try {
    record = JSON.parse(text.slice(at + 7, end));
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || !KINDS.has(String(record.kind || ''))) return null;
  return record;
}

/**
 * A hit turned into something you can open: `public/app.js:3120`.
 *
 * The anchor's `file` is a **served URL**, because public/editmode.js searched what the
 * browser fetched. Everything served comes out of `public/`, so an asset translates
 * exactly — and a *page* does not, because `/`, `/monitor`, `/advocates`, `/login` and
 * `/admin` are aliases onto four html files in `serveStatic` (lib/server.js). That table
 * is deliberately not copied here: it would be a second copy of a mapping that changes
 * whenever a page is added, and a confidently wrong path is worse than an honest URL.
 * So a path with a file extension is translated and anything else is left as the URL,
 * with `pageUrl` true so the caller can say which it is.
 */
function siteOf(site) {
  const url = String(site?.file || '');
  const rel = url.replace(/^\/+/, '');
  const asset = /\.[a-z0-9]+$/i.test(rel);
  return { where: asset ? `public/${rel}` : url || '/', pageUrl: !asset, line: site?.line };
}

/** Up to `cap` sites as indented lines, each with the line of source it matched. */
function siteLines(sites, cap = 4) {
  const out = [];
  for (const s of (sites || []).slice(0, cap)) {
    const { where, pageUrl, line } = siteOf(s);
    out.push(`    ${where}:${line}${s.text ? `    ${String(s.text).slice(0, 90)}` : ''}`);
    if (pageUrl)
      out.push(`      (that is the URL of a page, not a path — it is one of the html files in \`public/\`)`);
  }
  if ((sites || []).length > cap) out.push(`    …and ${sites.length - cap} more`);
  return out;
}

/**
 * What the app found when it looked for this element in its own source, as prose.
 *
 * Both searches or neither: naming only the one that succeeded is how a retype gets
 * applied to the line that draws the element rather than the line that writes the
 * string. Every branch ends in something the session can do next, because "not found" on
 * its own is exactly the state that gets guessed at.
 */
function anchorSection(anchor) {
  const source = anchor?.source || {};
  const text = anchor?.text || {};
  const out = ['**The anchor, and the source it points at.** Two searches, and they are not the same question.'];

  out.push(
    '',
    `- **The string on the screen** — ${quote(text.value || '', 120)}, which the app calls \`${text.from || 'unknown'}\`.`
  );
  if (text.from === 'data') {
    out.push(
      `  That is **tracker data being drawn**, not a string in this app. Nothing about it is` +
        ` retypeable: the words come from a bead, and changing them here would edit the tracker.`
    );
  } else if ((text.sites || []).length === 1) {
    out.push(`  Written once, at:`, ...siteLines(text.sites));
  } else if ((text.sites || []).length) {
    out.push(`  Written in ${text.sites.length} places:`, ...siteLines(text.sites));
  } else {
    out.push(`  The search found it nowhere in this app's source.`);
  }

  out.push('', `- **The element that draws it** — searched by \`${source.kind || 'nothing'}\`, and:`);
  if (source.found === 1) {
    out.push(...siteLines(source.sites));
  } else if (source.found) {
    out.push(
      `    ${source.found} candidates, narrowed as far as the chain could take it:`,
      ...siteLines(source.sites)
    );
  } else {
    out.push(`    nothing. The element could not be traced to source at all.`);
  }
  out.push('', `- **Selector** — \`${anchor?.selector || 'unknown'}\`${anchor?.key ? `, inside the chunk keyed \`${anchor.key}\`` : ''}`);

  out.push(
    '',
    `**Check the site before you change it, and grep for yourself.** The anchor was computed` +
      ` against the source as it was served when Adam said this, and \`main\` has moved since —` +
      ` the line number is a strong hint, not an address. And when you grep, remember what this` +
      ` repo is: every file here argues in prose that names the identifiers around it, so a` +
      ` plain search of \`public/*.js\` finds the paragraph *explaining* a class as often as the` +
      ` line drawing it. \`blankJs\`/\`blankHtml\` in public/editmode.js are the scanner that does` +
      ` not — they blank comments to spaces and keep every offset — and they are why this` +
      ` anchor is worth trusting at all.`
  );
  return out;
}

/** The paragraph that turns "I cannot find it" into a bead Adam can answer. */
function unresolvableSection(id, kind, anchor) {
  const source = anchor?.source || {};
  const text = anchor?.text || {};
  const nothing = !source.found && !(text.sites || []).length;
  const ambiguous = kind === 'retype' ? (text.sites || []).length > 1 : source.found > 1;
  if (!nothing && !ambiguous) return [];
  return [
    '',
    nothing
      ? `**This anchor resolves to nothing, and that is a question rather than a guess.** The app` +
        ` searched its own source for this element and came back empty, so there is no line here` +
        ` for you to be confident about. Look for it yourself first — the search is a substring` +
        ` match and a string built from two pieces defeats it. If you still cannot say which line` +
        ` draws it, **ask**, with the command further down and \`--blocks ${id}\`: it parks this` +
        ` bead behind the question and it comes back by itself the moment Adam answers.`
      : `**The anchor is ambiguous, and picking one is a guess.** The app narrowed it as far as the` +
        ` chain could and there is still more than one candidate above. If reading them settles it —` +
        ` and it often will, because you can see what the surrounding code is drawing and the app` +
        ` could not — say in a comment which one you took and why. If it does not settle it, **ask**,` +
        ` with the command further down and \`--blocks ${id}\`, rather than editing whichever line` +
        ` came first.`,
  ];
}

/** What this particular gesture asks for, and what it is not asking for. */
function kindSection(record) {
  const anchor = record.anchor || {};
  if (record.kind === 'retype') {
    return [
      '',
      `**This is a retype — the one literal edit in this whole epic.** A hand-written string in` +
        ` this app's own source, replaced with another one. It should come out very nearly` +
        ` character-exact: change the string and nothing else, keep the surrounding code, the` +
        ` quoting and the escaping exactly as they are, and do not improve the new wording on the` +
        ` way past. Adam typed what he wanted to see.`,
      '',
      `Two things refuse it rather than approximate it: a string the search finds in more than one` +
        ` place — two lines a rename would have to land on, and picking one is a guess — and text` +
        ` the anchor calls \`data\`, which is a bead being drawn and belongs to the tracker.`,
    ];
  }
  const rel = record.where?.rel || '';
  return [
    '',
    record.kind === 'point'
      ? `**This is a pointed edit: a drag, and then a sentence.** Nothing moved and no geometry was` +
        ` captured — the drag existed so Adam could show you what he meant, and what was recorded is` +
        ` the relationship it landed in${rel ? ` (\`${rel}\`)` : ''} plus the words underneath.` +
        ` **The words are the edit.**`
      : `**This is a described edit: no gesture at all.** The element was held down and the note is` +
        ` what should be different about it. **The words are the whole of it** — there is nothing` +
        ` else to go on and nothing else was meant.`,
    '',
    `So this is intent, and you reimplement it in the layout system this app already has: the` +
      ` stylesheet, the templates, the classes that are already doing this job three elements` +
      ` away. **Not absolute positioning bolted on top, and not a pixel offset** — there is no` +
      ` before-and-after here to diff, "56 pixels left" is not something anybody can ask a` +
      ` stylesheet for, and a change that only holds at one width is not the change that was` +
      ` asked for.`,
    ...(anchor?.text?.from === 'data'
      ? [
          '',
          `Note that the text on this element is **tracker data**, not a string in this app. Whatever` +
            ` you change here, it is not those words.`,
        ]
      : []),
  ];
}

/**
 * The short version, for the **pass** — or the standing root — rather than one edit.
 *
 * Neither is work and neither carries an anchor, so nothing above applies to them
 * directly. They still reach a window: an epic whose children are all ready is a batch
 * head or a planner (`batchesFor` in lib/advocate.js), and with planning switched off a
 * worker gets the epic *and* its children in one brief. That worker is about to do three
 * in-app edits with none of the three sentences that say what an in-app edit is, and it
 * would then be offered the landing ending underneath them.
 *
 * So this says the two things that survive without an anchor — what the beads under it
 * are, and that none of them is yours to merge — and leaves the rest to the per-bead
 * sections those children get when they are dispatched on their own.
 */
function passBriefFor(row, { owner = 'Adam' } = {}) {
  return [
    '',
    `**Everything under this bead was typed into the running app.** ${owner} turned edit mode on,` +
      ` pointed at things on a screen he was standing in front of, and said what should be` +
      ` different about them (bc-p49x); \`${row.id}\` is the container, not the work. Each child` +
      ` carries the app's own record of what was pointed at — a JSON block at the foot of its` +
      ` description with the selector, the text, and the lines of source the app's own search` +
      ` matched. **Read that block before the prose**, per child: it is the most valuable thing on` +
      ` one of these beads and it is the part that looks like provenance.`,
    '',
    `Three things hold for every one of them. A **retype** is a literal string replacement in` +
      ` this app's own source and should come out very nearly character-exact; **everything else` +
      ` is intent**, implemented in the layout system this app already has — no geometry was ever` +
      ` captured, so absolute positioning and pixel offsets are not what was asked for. And an` +
      ` anchor that resolves to nothing, or to more sites than the chain could narrow, is a` +
      ` question rather than a guess: ask, with the command further down.`,
    '',
    `**None of this is yours to merge.** An in-app edit is merged by the person who asked for it,` +
      ` so deliver each one with \`--review\` and do not deploy anything. The delivery command holds` +
      ` these whether it is asked to or not.`,
    '',
  ].join('\n');
}

/**
 * The whole section, or `''` for a bead that did not come from edit mode.
 *
 * A pure function of the row, like everything else a brief is built from — the point of
 * that is test/editwork.mjs, which asserts every branch of this without a repo, a screen
 * or a tracker. `''` rather than a null so the caller can interpolate it unconditionally
 * and a bead that has nothing to do with edit mode produces a brief that is unchanged to
 * the character.
 *
 * It doubles as the flag for the ask-first ending in lib/session.js — anything that gets a
 * section here may not merge its own work — which is why the pass and the root get one
 * too, short, rather than being skipped for having no anchor on them.
 */
export function editBriefFor(row, { owner = 'Adam' } = {}) {
  if (!fromEditMode(row)) return '';
  if (!isEditBead(row)) return passBriefFor(row, { owner });
  const id = row.id;
  const record = editOf(row);
  const head = [
    '',
    `**This bead was typed into the running app, and it is not an ordinary task.** ${owner} turned` +
      ` edit mode on, pointed at something on a screen he was standing in front of, and said what` +
      ` should be different about it (bc-p49x). The words on this bead are his; the JSON block at` +
      ` the bottom of it is the app's own record of what he was pointing at, and it is worth more` +
      ` than any sentence anybody could type on a phone.`,
    '',
    `**Read its siblings before you decide what it means.** The parent bead is one *pass* — one` +
      ` sitting with edit mode on — and the edits in a pass were said in order, where the second is` +
      ` very often a qualification of the first (\`bd show\` the parent, then its children).`,
  ];
  const body = record
    ? [...kindSection(record), '', ...anchorSection(record.anchor || {}), ...unresolvableSection(id, record.kind, record.anchor || {})]
    : [
        '',
        `**The anchor on this bead could not be read.** It carries the in-app-edit label but the` +
          ` record at the bottom of its description is missing or malformed, so nothing below could` +
          ` be lifted out for you. Read the bead itself, and if what it points at is not obvious from` +
          ` the prose, ask rather than guess — the command is further down, with \`--blocks ${id}\`.`,
      ];
  return [
    ...head,
    ...body,
    '',
    `**And this one stops at the pull request.** ${owner}'s standing line is that the reversible` +
      ` preparation is automatable and the publish is a tap, and an in-app edit is the clearest case` +
      ` there is: it is a sentence said to a screen, and the whole of the review is him looking at` +
      ` what came back. So deliver it with \`--review\` — **you do not merge this and you do not` +
      ` deploy it**, whatever the rest of this page says about landing your own work. The delivery` +
      ` command holds it either way, so the flag is you agreeing with it rather than the thing that` +
      ` makes it true.`,
    '',
  ].join('\n');
}
