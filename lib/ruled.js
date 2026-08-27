/**
 * Has Adam already decided this — every ruling on a topic, newest first.
 *
 * bc-dgx7.102: five sessions (`dv-afr.7`, `dv-52r.2`, `dv-afr.8`, `dv-gr6.8`, `dv-b5d.4`)
 * each needed to know whether a question was already answered before putting it to
 * Adam, and the corpus that answers it is scattered across two places this module reads
 * together: closed `decision`/`human` beads (the ruling is the comment `respond()` wrote
 * right before closing — `lib/beadanswer.js`'s `answerFromComments` already knows how to
 * find that comment, and this reuses it rather than re-deriving it) and, in a repo like
 * deluvia's, `CHANGE_LOG.md` entries whose `**Type:**` field names a decision rather than
 * an execution step (`WORLD DECISION`, `LORE DECISION`, `CHARACTER DECISION` — never
 * `STRUCTURAL CHANGE` or `CRAFT ENFORCEMENT`, which record work done, not a ruling made).
 *
 * A third corpus dv-52r.2 actually used — arbitrary reference docs like
 * `METALLURGY.md` and `TECHNOLOGY_GUIDE.md` — is deliberately not read here: those are
 * per-repo prose with no shared shape a generic tool could scan honestly, and grepping a
 * whole doc tree for a topic is a different, much fuzzier tool than this one. `CHANGE_LOG.md`
 * is the one file this bead's own corpus names as structured, and it is the one this
 * module reads.
 *
 * Matching is deliberately plain: every significant word (3+ letters, ignoring a short
 * stopword list) in the topic must appear, case-insensitively, somewhere in the
 * candidate's text. That is a blunter instrument than `lib/changelog.js`'s Jaccard
 * similarity (built for "is this edit of that decision the same decision", not for "does
 * this topic touch that decision"), but it is the one an agent typing a topic phrase can
 * predict the behaviour of.
 */
import { toQuestion } from './decision.js';
import { answerFromComments } from './beadanswer.js';
import { entryHeadings, decisionFingerprint } from './changelog.js';
import { pickBase } from './notinmain.js';
import { readRefFile } from './gitref.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'is', 'was', 'were', 'be',
  'been', 'for', 'with', 'this', 'that', 'has', 'have', 'had', 'it', 'its', 'as', 'by',
]);

/** Significant words out of a free-text topic — what `textMatches` requires present. */
export function topicWords(topic) {
  return [
    ...new Set(
      String(topic || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    ),
  ];
}

/**
 * Every word in `words` present, case-insensitively, somewhere in `text` — AND, not OR,
 * so "chapter word count" does not match a document that only ever says "chapter". An
 * empty `words` list (no topic given, `-b` alone scoping the search) matches everything.
 */
export function textMatches(text, words) {
  if (!words.length) return true;
  const hay = String(text || '').toLowerCase();
  return words.every((w) => hay.includes(w));
}

function beadHaystack(issue) {
  return [issue.title, issue.description, issue.design, issue.notes, issue.acceptance_criteria]
    .filter(Boolean)
    .join('\n');
}

/**
 * Every closed `decision`-typed or `human`/`needs-approval`-labelled bead, plus every
 * still-open one of those (a packet already sitting on Adam's tap), whose text matches
 * `words`. Two `bd list` calls narrow the corpus before anything is read word-by-word —
 * a whole tracker's beads are never scanned client-side, only the subset that could ever
 * be a ruling.
 */
export async function findBeadRulings(bd, ws, words, { since = null } = {}) {
  const [decisions, human] = await Promise.all([
    bd.json(ws, ['list', '--type', 'decision', '--all', '--limit', '0']).catch(() => []),
    bd.json(ws, ['list', '--label-any', 'human,needs-approval', '--all', '--limit', '0']).catch(() => []),
  ]);

  const byId = new Map();
  for (const issue of [...(decisions || []), ...(human || [])]) {
    if (issue?.id && !byId.has(issue.id)) byId.set(issue.id, issue);
  }

  const sinceMs = since ? Date.parse(since) : null;
  const rows = [];
  for (const issue of byId.values()) {
    if (!textMatches(beadHaystack(issue), words)) continue;

    const closed = issue.status === 'closed';
    const { decision } = toQuestion(ws.name, issue);

    let comments = [];
    try {
      comments = (await bd.comments(ws, issue.id)) || [];
    } catch {
      comments = [];
    }

    let text = null;
    let at = null;
    if (closed) {
      const found = answerFromComments(decision, comments);
      if (found?.comment) {
        text = String(found.comment.text ?? found.comment.body ?? found.comment.comment ?? '').trim();
        at = found.comment.created_at || found.comment.createdAt || issue.closed_at || issue.updated_at || null;
      } else {
        at = issue.closed_at || issue.updated_at || null;
      }
    } else {
      at = issue.updated_at || issue.created_at || null;
    }

    if (sinceMs && at && Date.parse(at) < sinceMs) continue;

    rows.push({
      kind: 'bead',
      id: issue.id,
      title: issue.title,
      open: !closed,
      question: decision?.question || null,
      text,
      at,
    });
  }

  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return rows;
}

const TYPE_RE = /\*\*Type:\*\*\s*(.*)$/im;
const HEADING_DATE_RE = /—\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/;

function entryType(body) {
  const m = TYPE_RE.exec(body);
  return m ? m[1].trim() : '';
}

function entryDate(heading) {
  const m = HEADING_DATE_RE.exec(heading);
  return m ? m[1] : null;
}

/**
 * Every `CHANGE_LOG.md` entry, at `base`, whose `Type` names a decision (contains
 * "DECISION" — `WORLD DECISION`, `LORE DECISION`, `CHARACTER DECISION`; never
 * `STRUCTURAL CHANGE` or `CRAFT ENFORCEMENT`, which record work rather than a ruling)
 * and whose text matches `words`. `null` (not `[]`) when the repo carries no such file
 * at all, so a caller can tell "no file to search" from "searched it, found nothing".
 */
export async function findChangeLogRulings(dir, words, { file = 'CHANGE_LOG.md', base = 'main', since = null } = {}) {
  const baseInfo = await pickBase(dir, base);
  if (!baseInfo) return null;
  const content = await readRefFile(dir, baseInfo.ref, file);
  if (content === null) return null;

  const sinceMs = since ? Date.parse(since) : null;
  const rows = [];
  for (const h of entryHeadings(content)) {
    const type = entryType(h.body);
    if (!/decision/i.test(type)) continue;
    if (!textMatches(h.body, words)) continue;

    const at = entryDate(h.heading);
    if (sinceMs && at && Date.parse(at) < sinceMs) continue;

    rows.push({
      kind: 'changelog',
      id: h.heading.replace(/^##\s*/, ''),
      title: h.heading.replace(/^##\s*/, ''),
      type,
      text: decisionFingerprint(h.body) || h.body.slice(0, 400),
      at,
    });
  }

  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return rows;
}

/** Bead rulings and CHANGE_LOG rulings, merged and sorted newest first by timestamp. */
export function mergeRulings(beadRows, changeLogRows) {
  return [...beadRows, ...(changeLogRows || [])].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}
