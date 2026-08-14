/**
 * A pass with edit mode on becomes beads — the other end of public/editmode.js.
 *
 * That file is the conversation: you point at something, say what you meant, and it
 * holds the list. Nothing in it writes to the tracker, deliberately, and this is the
 * one thing that does. The whole of bc-p49x is a way of saying a change to this app
 * from the phone the app is on; a pass that stayed in a browser tab would be a
 * conversation nobody kept.
 *
 * ## The shape, and why it is three levels rather than one
 *
 * Adam asked for it directly (bc-w156, 2026-08-13): a standing P0 root that never
 * closes, one P1 per editing *session* under it, and one child per individual edit
 * under that. So a pass where six things get nudged is one P1 with six children, not
 * six P0s and not one bead with six paragraphs in it.
 *
 * Both halves of that matter and they fail in opposite directions. Six loose beads is
 * six windows opened on what was one thought, each of them missing the other five —
 * and the second edit in a pass is very often a qualification of the first. One bead
 * with six paragraphs is one window that has to do six unrelated things before it can
 * be closed, which is exactly the shape a worker cannot finish. The session bead in
 * the middle is what keeps the pass together *and* keeps each edit dispatchable.
 *
 * **The session bead is a container, and it says so out loud.** It is an `epic`, not a
 * task, for the reason lib/advocate.js's `batchesFor` cares about: an epic with ready
 * children is a batch head and gets a planner, where a *task* with children is
 * ordinary worker dispatch — and a worker's one sanctioned ending closes the bead it
 * was opened on, which here would close the pass and orphan the edits under it. The
 * type is most of the protection; the sentence in the description is the rest, because
 * an epic with a single ready child falls under `minBatchBeads` and is dispatched like
 * anything else.
 *
 * ## What a child has to carry, and why it is so much
 *
 * The agent that acts on one of these opens cold, hours later, with no screen: the page
 * it was about has been thrown away and the app may have repainted twice since. So the
 * bead carries the whole of `anchorFor`'s record — the selector chain, the class names,
 * the visible text, whether that text came from source or from the tracker, and the
 * file and line the search actually found — plus where in the app you were standing
 * when you said it. A bead that says "make this bigger" is worth nothing; a bead that
 * says "the `.p0-title` written at public/app.js:3120, on the inbox with the P0 filter
 * on, should be bigger" is work.
 *
 * The JSON block is not decoration either. Prose is what a person reads and the anchor
 * is what an agent greps with, and flattening the sites into a sentence would lose the
 * one field that makes the apply half tractable — `source.sites[].line`.
 *
 * ## Endorsed, owned, and priced
 *
 * Filed **endorsed**: lib/filing.js holds an *agent's* proposal behind a tap because an
 * agent decided it was work. These are Adam's own words, typed into the app by hand,
 * and holding them for his approval would be asking him to approve himself. The one
 * provenance stamp that does go on is `in-app-edit`, for lib/filing.js's `agent-filed`
 * reason: one `bd list --label in-app-edit` finds every bead that arrived by this route,
 * which is the only way to audit the feature afterwards.
 *
 * The session is P1 because Adam said so. The edits under it are P2, which is a choice
 * and is worth the sentence: the *pass* is the thing he sat down to do and outranks the
 * ordinary queue, where a single nudge inside it does not — a board where every in-app
 * remark outranks the work someone chose is a board that stops meaning anything. Both
 * are inside `advocates.minPriority`, so every child is dispatchable, which is the
 * acceptance.
 *
 * ## The root, and the three ways of finding it
 *
 * A bead with no P0 ancestor is not workable (bc-rfnr.7), so the pass needs a root that
 * already exists at the moment it is filed — and nobody pressing Save on a phone is
 * going to choose a parent. In order: the id in `edits.root` if the config names one, a
 * live epic carrying the `edit-root` marker, or one created here and marked. The marker
 * rather than the title is what makes the second attempt safe: matching on a title is
 * how two epics for one job get created the day somebody renames one, and this module
 * would do it silently on every Save.
 */
import { ownOwnerLabels } from './ownership.js';

/** Provenance: this bead was typed into the running app. Survives everything. */
export const EDIT_LABEL = 'in-app-edit';

/** The marker on the standing root, so it is found by a fact rather than by its name. */
export const ROOT_LABEL = 'edit-root';

/** What Adam chose, and what this module is not free to change. See the header. */
export const SESSION_PRIORITY = 1;
/** One edit inside a pass. See the header for why it is not the session's priority. */
export const EDIT_PRIORITY = 2;
/** The root has to be a P0 or nothing under it is workable — bc-rfnr.7. */
export const ROOT_PRIORITY = 0;

export const ROOT_TITLE = 'App improvements — the standing root every in-app edit lands under';

/** The prose a created root carries. bc-w156's own description, said once. */
export const ROOT_BODY = `A permanent container, not a piece of work.

Since bc-rfnr.7 a bead with no P0 ancestor is not workable, so anything filed from
inside the app needs a root that already exists at the moment it is filed. This is it:
a standing P0 that is never closed, one P1 per editing session under it, and one child
per individual edit under that.

Created by edit mode's Save (bc-p49x.3) because this install had no root carrying the
\`${ROOT_LABEL}\` marker. Nothing else files here, and nothing here should be delivered
against — see the children.`;

/** The three gestures. Anything else is not an edit this app knows how to act on. */
const KINDS = new Set(['retype', 'describe', 'point']);

/* ------------------------------------------------------------------ the pass in */

/** `“…”` around a string, trimmed to something that fits in a title. */
export function quote(s, cap = 60) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return `“${text.length > cap ? `${text.slice(0, cap - 1)}…` : text}”`;
}

/** One line of a source hit — `public/app.js:3756`, or nothing when it was not found. */
export function siteOf(anchor) {
  const site = anchor?.source?.found === 1 ? anchor.source.sites?.[0] : null;
  return site ? `${String(site.file).replace(/^\//, '')}:${site.line}` : '';
}

/**
 * What a client posted, reduced to the pass this module will file — or nothing.
 *
 * Everything here is a string from a browser, so nothing is trusted: a change with no
 * recognised `kind` is not one of the three gestures and is dropped rather than filed
 * as a bead nobody can act on, and an edit with neither a note nor a new string is the
 * empty gesture public/editmode.js already refuses at the note box. The dropped ones
 * are reported rather than swallowed — a pass that quietly filed four of five edits is
 * the one failure this feature cannot survive, because the fifth is gone with the tab.
 */
export function normalizePass(body) {
  const raw = Array.isArray(body?.changes) ? body.changes : [];
  const dropped = [];
  const changes = [];
  for (const c of raw) {
    const kind = String(c?.kind || '').trim();
    if (!KINDS.has(kind)) {
      dropped.push({ id: c?.id || null, why: `not one of the three gestures: ${kind || 'nothing'}` });
      continue;
    }
    const note = String(c?.note || '').trim();
    const to = String(c?.to ?? '').trim();
    if (kind === 'retype' ? !to : !note) {
      dropped.push({ id: c?.id || null, why: 'nothing was said about it' });
      continue;
    }
    changes.push({
      id: String(c?.id || `e${changes.length + 1}`),
      kind,
      said: String(c?.said || '').trim(),
      note,
      from: String(c?.from ?? ''),
      to,
      anchor: c?.anchor && typeof c.anchor === 'object' ? c.anchor : null,
      where: c?.where && typeof c.where === 'object' ? c.where : null,
      context: c?.context && typeof c.context === 'object' ? c.context : null,
    });
  }
  const page = String(body?.page || changes[0]?.anchor?.page || '/').trim() || '/';
  const view = String(body?.view || '').trim();
  return { changes, dropped, page, view, at: String(body?.at || '').trim() };
}

/** What the pass happened on, said the way a title can carry it. */
export const surfaceOf = (pass) => pass.view || pass.page || '/';

/* --------------------------------------------------------------- the bead bodies */

const countOf = (n) => `${n} ${n === 1 ? 'change' : 'changes'}`;

/** Where in the app you were standing, as lines — or nothing when nobody said. */
function contextLines(context) {
  const out = [];
  for (const [key, value] of Object.entries(context || {})) {
    const said = String(value ?? '').trim();
    if (said) out.push(`- **${key}** — ${said}`);
  }
  return out;
}

/** The title of one edit. Enough to tell it from its five siblings in a list. */
export function titleFor(change) {
  const anchor = change.anchor || {};
  const at = siteOf(anchor);
  if (change.kind === 'retype') {
    return `Retype ${quote(change.from, 40)} → ${quote(change.to, 40)}${at ? ` in ${at}` : ''}`;
  }
  const about = quote(anchor.text?.value || change.said || 'this element', 40);
  if (change.kind === 'point') {
    const rel = change.where?.rel || 'beside';
    const target = quote(change.where?.target?.text?.value || 'what it was dropped on', 30);
    return rel === 'nowhere'
      ? `Move ${about} — dropped where the app has nothing anchored`
      : `Move ${about} ${rel} ${target}`;
  }
  return `${about}: ${String(change.note).replace(/\s+/g, ' ').trim().slice(0, 70)}`;
}

/** The description of one edit — the prose an agent reads, then the record it greps. */
export function bodyFor(change, { surface, at = '' } = {}) {
  const anchor = change.anchor || {};
  const site = siteOf(anchor);
  const out = [];

  if (change.kind === 'retype') {
    out.push(
      `**Retyped in place**, on ${surface}. The one literal edit in bc-p49x: the string is` +
        ` written by hand in this app's own source, so this is a replacement and not a` +
        ` reimplementation.`,
      '',
      `- **Was** — ${quote(change.from, 200)}`,
      `- **Should be** — ${quote(change.to, 200)}`,
      site
        ? `- **Written at** — \`${site}\`, and the search found it in exactly one place; a retype is refused otherwise.`
        : `- **Written at** — the source search found no single site, so check before replacing anything.`
    );
  } else if (change.kind === 'point') {
    const rel = change.where?.rel || 'beside';
    const target = change.where?.target?.text?.value || '';
    out.push(
      `**Pointed at**, on ${surface}. ${change.said || ''}`.trim(),
      '',
      `Nothing moved on the screen and no geometry was captured — the drag was a way of` +
        ` showing what was meant, and what was recorded is the relationship. Implement it in` +
        ` the layout this app already has; "56 pixels left" is not a change anybody can make` +
        ` to a stylesheet and a template, and it is not what was asked for.`,
      '',
      `- **Relationship** — ${rel}${target ? ` ${quote(target, 80)}` : ''}`,
      change.where?.left ? `- **Out of** — ${quote(change.where.left, 80)}` : '',
      `- **Said** — ${String(change.note)}`
    );
  } else {
    out.push(
      `**Described**, on ${surface}. No gesture at all — the element was held down and this` +
        ` is what should be different about it.`,
      '',
      `- **About** — ${quote(anchor.text?.value || change.said || 'an element', 120)}`,
      `- **Said** — ${String(change.note)}`
    );
  }

  const where = contextLines(change.context);
  if (where.length) out.push('', '**Where in the app this was said.**', ...where);

  out.push(
    '',
    '**The anchor.** What the element was, and where the app writes it. `text.from` is the' +
      ' distinction the whole epic turns on: `source` is this app, `data` is the tracker' +
      ' being drawn, and only the first is editable here.',
    '',
    `- **Selector** — \`${anchor.selector || 'unknown'}\``,
    anchor.key ? `- **Inside** — the chunk keyed \`${anchor.key}\`` : '',
    `- **Text** — ${quote(anchor.text?.value || '', 120)}, from \`${anchor.text?.from || 'unknown'}\``,
    `- **Source search** — ${
      anchor.source?.found === 1
        ? `one site, \`${site}\``
        : anchor.source?.found
          ? `${anchor.source.found} sites — ambiguous, and the record below says which`
          : 'nothing found; the element could not be traced to source'
    }`,
    '',
    '```json',
    JSON.stringify({ kind: change.kind, anchor, where: change.where || undefined, at: at || undefined }, null, 2),
    '```'
  );
  return out
    .filter((line) => line !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** How we would know this one edit is done. */
export function acceptanceFor(change) {
  const site = siteOf(change.anchor);
  if (change.kind === 'retype') {
    return (
      `${site || 'The one line of source that draws it'} reads ${quote(change.to, 80)}, the old` +
      ` string is gone from the file, and nothing else on the screen changed.`
    );
  }
  if (change.kind === 'point') {
    return (
      `The element sits where the note asks, implemented in the stylesheet and templates this` +
      ` app already has. The relationship is what has to hold, not any particular pixel.`
    );
  }
  return 'The element does what the note asks. The note is intent, not a string to paste in.';
}

/** The pass itself: what it was, what is in it, and that it is not the work. */
export function sessionBead(pass) {
  const surface = surfaceOf(pass);
  const lines = pass.changes.map((c, i) => `${i + 1}. **${c.kind}** — ${c.said || titleFor(c)}`);
  const context = contextLines(pass.changes[0]?.context);
  const body = [
    `One pass with edit mode on, on ${surface}${pass.at ? `, ${pass.at}` : ''} — ${countOf(pass.changes.length)}.`,
    '',
    `**This bead is the pass, not the work.** Every child under it is one edit and each is` +
      ` dispatchable on its own; there is nothing to build here and nothing to deliver against.` +
      ` The pass exists because the edits were said in one sitting and the later ones are very` +
      ` often qualifications of the earlier — an agent working one of them should read its` +
      ` siblings before deciding what was meant.`,
    '',
    '**What was said, in the order it was said.**',
    '',
    ...lines,
    ...(context.length ? ['', '**Where in the app the pass happened.**', ...context] : []),
    '',
    `Filed from inside the running app by Save (bc-p49x.3). Nothing here was proposed by an` +
      ` agent, which is why none of it is held for endorsement.`,
  ];
  return {
    title: `Edit pass on ${surface} — ${countOf(pass.changes.length)}`,
    body: body.join('\n'),
    acceptance:
      'Every child is closed or dropped with a reason. This bead is closed when they are, and' +
      ' never by a worker delivering against it.',
    type: 'epic',
    priority: SESSION_PRIORITY,
  };
}

/** Every bead this pass files, root aside. */
export function beadsFor(pass, { labels = [] } = {}) {
  const surface = surfaceOf(pass);
  const session = { ...sessionBead(pass), labels: [...labels] };
  const edits = pass.changes.map((change) => ({
    changeId: change.id,
    title: titleFor(change),
    body: bodyFor(change, { surface, at: pass.at }),
    acceptance: acceptanceFor(change),
    type: 'task',
    priority: EDIT_PRIORITY,
    labels: [...labels],
  }));
  return { session, edits };
}

/** Every label a bead filed this way carries. `me` unset means no owner label at all. */
export function labelsFor(cfg) {
  return [EDIT_LABEL, ...ownOwnerLabels(cfg)];
}

/* ------------------------------------------------------------------- the root */

/**
 * The standing root, found or made.
 *
 * Three attempts, narrowing to a write only when the first two have nothing. The
 * configured id is checked rather than trusted — a root that has been closed or deleted
 * would otherwise file every future pass under a bead nothing can reach.
 */
export async function rootFor(bd, ws, cfg, { actor = null } = {}) {
  const named = String(cfg?.edits?.root || '').trim();
  if (named) {
    const issue = await bd.show(ws, named).catch(() => null);
    if (issue && issue.status !== 'closed') return { id: named, made: false, from: 'config' };
  }
  const marked = (await bd.listLabel(ws, ROOT_LABEL).catch(() => [])) || [];
  if (marked.length) {
    // Oldest wins. Two roots is a mistake somebody made once, and the one with beads
    // already under it is the one every earlier pass was filed against.
    const oldest = [...marked].sort((a, b) =>
      String(a.created_at || '').localeCompare(String(b.created_at || ''))
    )[0];
    return { id: oldest.id, made: false, from: 'label' };
  }
  const id = await bd.create(
    ws,
    {
      title: ROOT_TITLE,
      body: ROOT_BODY,
      acceptance: 'The root exists and is never closed. A pass filed from the app lands under it.',
      type: 'epic',
      priority: ROOT_PRIORITY,
      labels: [ROOT_LABEL, ...labelsFor(cfg)],
    },
    { actor }
  );
  if (!id) throw new Error('bd created the standing root but returned no id');
  return { id, made: true, from: 'created' };
}

/* ------------------------------------------------------------------- the filing */

/**
 * File a whole pass: the root if there is none, the session bead, then one child each.
 *
 * **A failure keeps the pass rather than losing it**, which is the acceptance and is the
 * reason this reports every id as it goes. What has been filed is carried on the error
 * as `partial` — `filed` is the caller's contract with the phone, which drops exactly
 * those entries from the change list and keeps the rest. A Save that reported a flat
 * failure over three beads that exist would have Adam file them all a second time.
 */
export async function filePass(bd, ws, pass, { cfg = {}, actor = null } = {}) {
  const labels = labelsFor(cfg);
  const { session, edits } = beadsFor(pass, { labels });
  const filed = [];
  const root = await rootFor(bd, ws, cfg, { actor });
  const sessionId = await bd.create(ws, { ...session, parent: root.id }, { actor });
  if (!sessionId) throw new Error('bd created the pass but returned no id');
  const out = { root, session: { id: sessionId, title: session.title }, filed };
  for (const edit of edits) {
    try {
      const id = await bd.create(ws, { ...edit, parent: sessionId }, { actor });
      if (!id) throw new Error('bd created the edit but returned no id');
      filed.push({ changeId: edit.changeId, id, title: edit.title });
    } catch (err) {
      throw Object.assign(new Error(`filed ${filed.length} of ${edits.length}: ${err.message.split('\n')[0]}`), {
        partial: out,
      });
    }
  }
  return out;
}
