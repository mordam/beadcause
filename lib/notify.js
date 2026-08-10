/**
 * ntfy push.
 *
 * The notification is the fast path: for a two- or three-option question the
 * action buttons answer it outright (ntfy allows at most 3), and tapping the
 * body deep-links into the PWA for the full brief — diagram, images, links.
 */
import { ntfyDetailFor } from './spaces.js';
// An observer instance shares the topic with the live one — it was booted from a
// copy of its config. Two notifications for one question, whose buttons answer via
// two different ports, is a worse phone than no second instance at all.
import { OBSERVING } from './config.js';
import { displayName } from './foundation.js';

const PRIORITY_MAP = { 0: 5, 1: 4, 2: 3, 3: 2, 4: 2 };

export async function pushQuestion(cfg, q) {
  const n = cfg.ntfy || {};
  if (!n.enabled || !n.topic || OBSERVING) return { skipped: true };

  // No token in the click URL: the PWA already has it in localStorage from the
  // one-time setup link, and a notification passes through the ntfy relay.
  const link = `${cfg.baseUrl}/#${encodeURIComponent(q.key)}`;
  // `decision.options`, and deliberately never `q.suggested`. A notification button
  // answers and closes the bead on one tap from a lock screen, with the card never
  // opened — which is exactly the gesture a suggestion may not have, since its words
  // were read out of a paragraph rather than written as the answer. On the phone a
  // chip fills the box and you press the button; out here there is no "fills the
  // box", so there is no button. See lib/suggest.js.
  const opts = q.decision?.options || [];

  // A topic on the public ntfy.sh is readable by anyone who guesses its name, and
  // option labels leak as much as the question does. So "minimal" workspaces get
  // a bare nudge with no text and no buttons — you tap through to the tailnet.
  // Space policy is consulted here too, so adding a workspace to a space picks up
  // its privacy setting without also having to list it in minimalWorkspaces.
  const minimal = ntfyDetailFor(cfg, q.workspace) === 'minimal';

  const actions = [];
  if (n.actionButtons && !minimal) {
    for (const o of opts.slice(0, 3)) {
      actions.push({
        action: 'http',
        label: o.label.slice(0, 24),
        url: `${cfg.baseUrl}/api/respond`,
        method: 'POST',
        headers: { 'x-beadcause-token': cfg.token, 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: q.workspace, id: q.id, response: o.response }),
        clear: true,
      });
    }
  }

  const body = {
    topic: n.topic,
    title: minimal ? 'Beadcause' : `${q.workspace} · ${q.id}`,
    message: minimal ? 'A decision is waiting — tap to open.' : q.question || q.title,
    click: link,
    priority: PRIORITY_MAP[q.priority] ?? 3,
    tags: ['thought_balloon'],
  };
  if (actions.length) body.actions = actions;

  return publish(n, body);
}

/**
 * An agent asking to change what it is — the other channel, on the notification
 * layer.
 *
 * Deliberately not `pushQuestion` with a different tag. Three things differ, and
 * each of them is the point of the separation:
 *
 * - **It says what kind of decision it is before you read a word of it.** "⚖️ chat
 *   session asks to change what it is" and "climative · cl-abc" are different enough on a
 *   lock screen that you know, without opening it, whether this is about work.
 * - **It never inherits the bead's priority.** A question is urgent when the work is;
 *   an amendment is a constitutional change and there is no such thing as one that
 *   should interrupt you harder. Fixed at 3 — arrives, does not shout.
 * - **The two buttons are the whole decision.** Approve and decline both fit inside
 *   ntfy's three, so this is one of the few notifications that can genuinely be
 *   answered from the shade. `AMEND:` is what makes the approve button consent and
 *   nothing else — see `amendment.APPROVE_MARKER`.
 *
 * The body tap still deep-links into the PWA, because the *conversation* about a
 * request is a thread and a notification cannot be one.
 */
export async function pushFoundationRequest(cfg, q) {
  const n = cfg.ntfy || {};
  // Same guard as the question path, and it matters more here: an observer shares
  // the topic, so a foundation request would arrive twice with two approve buttons
  // posting to two different ports — and one of them would commit to the ref.
  if (!n.enabled || !n.topic || OBSERVING) return { skipped: true };

  const link = `${cfg.baseUrl}/#${encodeURIComponent(q.key)}`;
  const minimal = ntfyDetailFor(cfg, q.workspace) === 'minimal';
  const agent = q.amendment?.agent ? displayName(q.amendment.agent) : 'an agent';

  const actions = [];
  if (n.actionButtons && !minimal) {
    for (const o of (q.decision?.options || []).slice(0, 3)) {
      actions.push({
        action: 'http',
        label: o.label.slice(0, 24),
        url: `${cfg.baseUrl}/api/respond`,
        method: 'POST',
        headers: { 'x-beadcause-token': cfg.token, 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: q.workspace, id: q.id, response: o.response }),
        clear: true,
      });
    }
  }

  const body = {
    topic: n.topic,
    title: minimal ? 'Beadcause' : `⚖️ ${agent} asks to change what it is`,
    // The scope, not the justification: it is the one line that decides most of
    // these, and the argument for it needs a screen rather than a shade.
    message: minimal
      ? 'An agent is asking to be changed — tap to read.'
      : q.amendment?.scope || q.question || q.title,
    click: link,
    priority: 3,
    tags: ['scales'],
  };
  if (actions.length) body.actions = actions;

  return publish(n, body);
}

/**
 * The agent answering a question you put to it *about* its own request.
 *
 * No buttons, and that is not an omission: the Q and A is a thread, and a reply is
 * something to read before deciding, not a second decision. Tapping opens the thread
 * where the approve and decline still are.
 */
export async function pushFoundationReply(cfg, q, comment) {
  const n = cfg.ntfy || {};
  if (!n.enabled || !n.topic || OBSERVING) return { skipped: true };
  const minimal = ntfyDetailFor(cfg, q.workspace) === 'minimal';

  return publish(n, {
    topic: n.topic,
    title: minimal ? 'Beadcause' : `⚖️ ${comment.author} on its own request`,
    message: minimal ? 'A reply about a foundation request — tap to read.' : String(comment.text || '').slice(0, 400),
    click: `${cfg.baseUrl}/#${encodeURIComponent(q.key)}`,
    priority: 3,
    tags: ['scales'],
  });
}

/** An agent answered something you asked with "Comment only". */
export async function pushReply(cfg, q, comment) {
  const n = cfg.ntfy || {};
  if (!n.enabled || !n.topic || OBSERVING) return { skipped: true };
  // Space policy is consulted here too, so adding a workspace to a space picks up
  // its privacy setting without also having to list it in minimalWorkspaces.
  const minimal = ntfyDetailFor(cfg, q.workspace) === 'minimal';

  return publish(n, {
    topic: n.topic,
    title: minimal ? 'Beadcause' : `${comment.author} replied · ${q.id}`,
    message: minimal ? 'An agent replied — tap to read.' : String(comment.text || '').slice(0, 400),
    click: `${cfg.baseUrl}/#${encodeURIComponent(q.key)}`,
    priority: 3,
    tags: ['speech_balloon'],
  });
}

/**
 * A worker landed its own work — the one push in this file with nothing to answer.
 *
 * Every other notification here is a decision arriving. This one is a decision that
 * has already been taken, by an agent, on Adam's behalf: the pull request is merged,
 * the bead is closed, and there is no card in the inbox because there is nothing left
 * to ask. So three things are different from `pushQuestion`, and each is the point:
 *
 * - **No action buttons, ever.** Not even one. A button on a notification about work
 *   that is already in `main` could only offer a revert, and a revert is not a thing
 *   to hand someone in a lock screen with one line of context.
 * - **Priority 2 — it arrives, it does not shout.** A question can be urgent because
 *   something is blocked on it. Nothing is blocked on this: it is the record of a
 *   thing that went right, and a phone that buzzes hard for those is a phone that
 *   gets silenced, taking the questions with it.
 * - **It links to the pull request board, not to a bead.** `/prs` is where the
 *   question this raises actually lives — it merged, but has it reached the running
 *   build? — and that board has the Ship button on it. Deploying stays Adam's, which
 *   is why this is a nudge toward it rather than a report that the work is live.
 *
 * `owed` is what the worker says is still outstanding after the merge — a deploy, a
 * rebuild, both, or nothing. It is passed through verbatim rather than worked out
 * here, for the same reason lib/session.js makes the session name its own outstanding
 * steps: the daemon knows the repo, but only the session knows what it touched.
 */
export async function pushLanded(cfg, landing) {
  const n = cfg.ntfy || {};
  if (!n.enabled || !n.topic || OBSERVING) return { skipped: true };
  const minimal = ntfyDetailFor(cfg, landing.workspace) === 'minimal';

  const lines = [`#${landing.number} ${landing.title || landing.bead}`.slice(0, 200)];
  if (landing.sha) lines.push(`${landing.base || 'main'} ← ${String(landing.sha).slice(0, 8)}`);
  if (landing.owed) lines.push(`Still owed: ${landing.owed}`);

  return publish(n, {
    topic: n.topic,
    title: minimal ? 'Beadcause' : `✅ landed · ${landing.workspace} ${landing.bead}`,
    message: minimal ? 'A worker landed its work — tap to open.' : lines.join('\n'),
    click: `${cfg.baseUrl}/prs`,
    priority: 2,
    tags: ['white_check_mark'],
  });
}

/**
 * How a deploy ended — and the only push here that is worth sending on failure alone.
 *
 * The reason it exists at all is lib/deploy.js's third promise: a failed deploy must
 * be visible and must not read as success. A record on disk is visible to something
 * that looks; this is what looks for you. `unconfirmed` gets its own wording rather
 * than being rounded to either side, because rounding it is exactly the lie — the
 * deploy that restarts beadcause always kills the process that was reporting on it,
 * and "we ran it and nothing outlived it to check" is the whole truth available.
 *
 * A success is priority 2 and easy to ignore; anything else is 4, because a deploy
 * that did not happen is a repo whose running build is not what the board says.
 */
export async function pushDeploy(cfg, rec) {
  const n = cfg.ntfy || {};
  if (!n.enabled || !n.topic || OBSERVING) return { skipped: true };
  const minimal = ntfyDetailFor(cfg, rec.workspace) === 'minimal';

  const face = {
    ok: { tag: 'rocket', word: 'deployed', priority: 2 },
    failed: { tag: 'x', word: 'deploy failed', priority: 4 },
    lost: { tag: 'question', word: 'deploy lost', priority: 4 },
    unconfirmed: { tag: 'grey_question', word: 'deploy unconfirmed', priority: 3 },
  }[rec.status] || { tag: 'question', word: `deploy ${rec.status}`, priority: 3 };

  const lines = [];
  if (rec.to) lines.push(`${rec.base || 'main'} → ${String(rec.to).slice(0, 8)}`);
  if (rec.bead) lines.push(`after ${rec.bead}`);
  if (rec.error) lines.push(rec.error.slice(0, 300));
  if (!lines.length) lines.push(rec.reason || rec.id);

  return publish(n, {
    topic: n.topic,
    title: minimal ? 'Beadcause' : `${rec.workspace} ${face.word}`,
    message: minimal ? 'A deploy finished — tap to open.' : lines.join('\n'),
    click: `${cfg.baseUrl}/prs`,
    priority: face.priority,
    tags: [face.tag],
  });
}

async function publish(n, body) {
  const res = await fetch(n.server.replace(/\/$/, '') + '/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(n.token ? { authorization: `Bearer ${n.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { ok: true };
}
