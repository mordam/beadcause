/**
 * Parking work behind a question — and the one bd rule that quietly stops it.
 *
 * Three commands park a bead behind something Adam has to answer: `beadcause-ask
 * --blocks`, `beadcause-propose --kind conflict`, and `beadcause-deliver` when the
 * merge did not happen. All three do it the same way — file the question, then
 * `bd dep add <the work> <the question>` — and all three used to break on the same
 * bead: an epic.
 *
 *     $ bd dep add bc-y3qk bc-uccd
 *     Error: epics can only block other epics, not tasks
 *
 * bd would not let an epic be blocked by anything that is not itself an epic (and,
 * symmetrically, would not let a task be blocked by an epic). Every other pair was
 * fine — a bug blocked by a task, a chore blocked by a decision — so the rule was
 * narrower than it looks and it was exactly one line: **epic-ness has to match.**
 *
 * **That rule is gone as of bd 1.2.1 (2026-08-11), and everything below is now
 * belt-and-braces rather than the load-bearing fix it was.** "Cross-type blocking
 * dependencies are now allowed" (bd-wg7ve, PR #4034) replaced the blanket same-type
 * rule (GH#1495) with a hierarchy deadlock guard that refuses only gating an issue on
 * its own ancestor or its own descendant; sibling edges — which is every edge a park
 * draws — go in whatever the two types are. test/epicedgereal.mjs pins the new
 * behaviour against the real binary and skips itself loudly on anything older.
 *
 * `questionType` is kept anyway, and deliberately. It is correct under both rules, it
 * costs one string comparison, and the machine a checkout runs on is not something
 * this file can check — a second Mac still on 1.1.x gets the working behaviour rather
 * than the stack trace bc-p9vx was about. What the bump does buy, and what no amount
 * of typing could: **one question can now park an epic and a non-epic at once.** That
 * was the failure that put bc-xl7n.14 back in `bd ready` three times — bc-s8zp had to
 * be epic-typed to hold bc-w156, which is precisely why it could not also hold the
 * decision bead, which nothing then held at all. See bc-xl7n.39.
 *
 * That mattered more than a refused edge usually does, because the question is
 * created *first*. bin/ask.js added the edge afterwards and did not catch it, so a
 * session asking about a P0 epic got a raw Node stack trace having already filed the
 * question and labelled it `human`: the question was on Adam's phone, the epic was
 * not parked, and the caller was told the whole thing had failed. A session that
 * believed the error asked nothing; a session that retried asked twice; and the epic
 * went on being `bd ready`, so the next advocate tick opened a window on work that
 * was explicitly waiting for an answer. That is bc-p9vx.
 *
 * So the fix is not a nicer error. It is to **type the question to match**, which is
 * what `questionType` is for — ask about an epic and the question is filed as an
 * epic, and the edge bd was refusing goes in. Nothing else about the question
 * changes: it is still labelled `human`, still excluded from every queue by that
 * label (lib/endorse.js), still drawn as an ordinary card (the phone never renders a
 * question's type), and closing it still un-parks the work the moment it is answered
 * — which is the thing `--blocks` exists for and the thing the by-hand workaround
 * below cannot do.
 *
 * One consequence worth knowing: a question typed `epic` costs the card one extra
 * `bd list --parent` when it is opened, because `Bd.gateFor` asks an epic for its
 * open children before drawing the answer button. A question has none, so the gate
 * is null and the card behaves exactly like a task's.
 *
 * `park` is still defensive underneath that, because a refused edge is no longer
 * only about types — a bd mid-write on the Dolt lock refuses too. When it cannot add
 * the edge it falls back to what a session had to do by hand: label the work bead
 * `human`, which takes it out of every queue so nothing opens a session on it. That
 * is **not** the same thing and the caller is told so in one plain sentence: the
 * label does not come off when the answer lands, so somebody has to come back to
 * that bead deliberately.
 *
 * That fallback is also why **the third way an edge fails matters more here than
 * anywhere else**. bd holds one row per ordered pair, so a work bead whose prose names
 * the thing it is waiting on — which is the description doing its job — can already be
 * joined to it by the `relates-to` a prose mention drew, and the park is then refused
 * over a see-also. `Bd.addDep` has outranked a mention since bc-arj0.20; this ran over a
 * synchronous runner and could not reach it, so it did not. `addDeclaredEdge` in
 * lib/mentions.js is the synchronous half, and bc-arj0.23 is why it exists. Without it
 * the collision costs a `human` label on a bead nothing ever takes it off again.
 */
import { parseJson } from './bd.js';
import { addDeclaredEdge, demotedNote } from './mentions.js';

/** The label that takes a bead out of every queue — the fallback when the edge fails. */
export const HUMAN_LABEL = 'human';

/** The first line of whatever an `execFileSync` threw, which is the part worth printing. */
export const firstLine = (err) => String(err?.message ?? err ?? '').split('\n')[0].trim();

/**
 * What bd said, rather than what node said about the exit code.
 *
 * `execFileSync`'s own `message` is `Command failed: <the whole argv>` — the absolute
 * path of the binary and nothing whatsoever about what bd objected to. Quoting it in a
 * sentence about a refused edge is worse than saying nothing, because bd's actual words
 * are *already on the session's stderr*: none of the three commands pipes the child's
 * stderr, and an unpiped stderr goes straight to the parent's. So the reason is on the
 * line above ours, and this points at it rather than burying it under a placeholder.
 *
 * A caller that does pipe stderr gets the real sentence quoted inline, which is why
 * `err.stderr` is preferred over everything.
 */
export function bdSaid(err) {
  const captured = String(err?.stderr || '').trim() || String(err?.stdout || '').trim();
  if (captured) return captured.split('\n').filter(Boolean)[0];
  const line = firstLine(err);
  return /^Command failed:/.test(line) ? 'bd refused it, and said why on the line above' : line;
}

/**
 * What a question has to be typed as to be allowed to block `targetType`.
 *
 * Epic-ness had to match and nothing else did, so this is a two-valued answer:
 * `epic` for an epic, `task` for everything else — including an unknown type, which
 * is the old behaviour and the right guess for a bead we could not read.
 *
 * **bd 1.2.1 no longer requires it** (see the header). Kept because it is right under
 * both rules and free, and because a checkout on an older binary still needs it — but
 * nothing new should be built on the assumption that a question's type constrains what
 * it can park.
 */
export function questionType(targetType) {
  return String(targetType || '').trim().toLowerCase() === 'epic' ? 'epic' : 'task';
}

/**
 * One bead as bd sees it, or `null` if bd would not say.
 *
 * Two callers want two different things out of one lookup, which is why this returns
 * the row rather than either of them: the *type*, to decide what the question has to
 * be, and merely *whether it is there at all*, which is the one thing that can still
 * refuse the whole command — and it can only refuse while there is nothing to lose by
 * refusing, i.e. before the question is created. A bead id that is not in the
 * workspace is a typo, and a typo caught here costs one retry.
 *
 * `null` is a real answer rather than an error for the type question: a lookup that
 * failed must never be the reason a question does not get asked. `bd` is the caller's
 * own runner — all three build one over `execFileSync` with the workspace's
 * `BEADS_DIR` in the environment — so this works from any of them without either of
 * us knowing about the other's config.
 */
export function beadRow(bd, id) {
  if (!id) return null;
  let out;
  try {
    out = parseJson(bd(['show', String(id), '--json']));
  } catch {
    return null;
  }
  const row = Array.isArray(out) ? out[0] : out?.issues?.[0] || out;
  return row?.id ? row : null;
}

/** The type of a bead, or `null` — `beadRow` for callers who only want this. */
export function beadType(bd, id) {
  const row = beadRow(bd, id);
  return row?.issue_type || row?.type || null;
}

/**
 * Park `target` behind `question`, and never throw.
 *
 * Returns `{ parked, labelled, demoted, note }`. `note` is one plain sentence whenever
 * there is anything to say — no stack trace, and when the park failed it always names the
 * question that does exist before it says what did not happen, because the caller's next
 * decision is whether to ask again. A caller printing it should gate on `note` rather than
 * on `!parked`: a park that worked can still have taken an edge off to do it.
 *
 * **A declared edge outranks a prose-mention see-also here too, and `addDeclaredEdge` is
 * where that happens** — bc-arj0.23, and the daemon's half of it is `Bd.addDep`. A
 * refusal over anything that is not a mention reaches the `catch` below exactly as it
 * always did, in bd's own words. `demoted` is the type that was dropped, or `''`.
 *
 * `label: false` for a caller whose fallback would do more harm than the unparked
 * bead — bin/deliver.js, whose work bead is about to be closed by the merge and
 * would otherwise carry a `human` label into the inbox that nothing ever takes off.
 */
export function park(bd, target, question, { label = true } = {}) {
  try {
    const { demoted } = addDeclaredEdge(bd, String(target), String(question));
    return {
      parked: true,
      labelled: false,
      demoted,
      note: demoted ? demotedNote(target, question, demoted) : '',
    };
  } catch (err) {
    const why = bdSaid(err);
    if (!label) {
      return { parked: false, labelled: false, demoted: '', note: `filed ${question}, but could not park ${target} behind it — ${why}` };
    }
    try {
      bd(['label', 'add', String(target), HUMAN_LABEL]);
      return {
        parked: false,
        labelled: true,
        demoted: '',
        note:
          `filed ${question}, but could not park ${target} behind it — ${why}. ` +
          `Labelled ${target} \`${HUMAN_LABEL}\` instead, so nothing will open a session on it — but that does ` +
          `NOT come off when you answer, so somebody has to come back to ${target} deliberately.`,
      };
    } catch (labelErr) {
      return {
        parked: false,
        labelled: false,
        demoted: '',
        note:
          `filed ${question}, but could not park ${target} behind it — ${why} — and could not label it ` +
          `\`${HUMAN_LABEL}\` either (${bdSaid(labelErr)}). ${target} is still in the queue: run ` +
          `\`bd label add ${target} ${HUMAN_LABEL}\` to take it out.`,
      };
    }
  }
}
