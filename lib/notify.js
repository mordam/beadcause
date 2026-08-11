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
import { answeredAgo } from './answered.js';

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

  // Three is ntfy's own ceiling, not a taste. It matters on exactly one card: a
  // delivery in a repo that declares a deploy offers four — merge, ship, changes,
  // decline — and decline is the one that falls off the lock screen. That is the right
  // one to lose. Declining throws a session's work away and asks for a direction to
  // take instead, which is a paragraph and not a tap; on the card itself it is already
  // a two-step panel for that reason. The other three are complete answers on their own.
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

  /**
   * A question you have answered before, coming back.
   *
   * The buttons above are the reason this has to be on the notification and not only
   * on the card: from a lock screen an option is one tap and the card is never opened,
   * which is exactly how the same answer gets given twice (see lib/answered.js). So
   * the repeat is said in the title, where it is read before the thumb moves, and the
   * answer itself goes above the question in the body.
   *
   * A minimal workspace gets the marker and not the answer. "You have seen this
   * before" leaks nothing; the sentence you typed leaks as much as the question does,
   * which is the whole reason that mode exists.
   */
  const before = q.answeredBefore;
  const ago = before ? answeredAgo(before.at) : '';
  const body = {
    topic: n.topic,
    title: `${minimal ? 'Beadcause' : `${q.workspace} · ${q.id}`}${before ? ' · asked again' : ''}`,
    message: minimal
      ? before
        ? 'A decision you have answered before is waiting — tap to open.'
        : 'A decision is waiting — tap to open.'
      : before
      ? `You answered this ${ago || 'already'}:\n${before.response}\n\n${q.question || q.title}`
      : q.question || q.title,
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

/**
 * The tailnet certificate is running out and the daemon cannot replace it.
 *
 * This is the only channel that works for this particular failure, which is why it
 * exists. Everything else beadcause can say to you it says over HTTPS on the tailnet
 * name — so by the time the certificate has actually expired, the inbox itself answers
 * a phone with an interstitial and no explanation, and the log line explaining it is on
 * a Mac nobody is sitting at. ntfy goes through a relay that has nothing to do with
 * this listener, so it still arrives.
 *
 * Priority climbs with the calendar rather than sitting at one level, because a
 * fortnight out this is a chore and three days out it is the app going dark. And the
 * message is the command that fixes it: a warning you have to go and research is a
 * warning that waits until the weekend.
 */
export async function pushCertificate(cfg, state) {
  const n = cfg.ntfy || {};
  if (!n.enabled || !n.topic || OBSERVING) return { skipped: true };
  const minimal = ntfyDetailFor(cfg) === 'minimal';

  const days = state.daysLeft;
  const priority = days === null || days === undefined ? 4 : days <= 3 ? 5 : days <= 7 ? 4 : 3;
  const when = days === null || days === undefined ? 'is unreadable' : days <= 0 ? 'has EXPIRED' : `expires in ${days} days`;

  return publish(n, {
    topic: n.topic,
    title: minimal ? 'Beadcause' : `⚠ certificate ${when.replace('has ', '')} · ${state.name}`,
    message: minimal
      ? 'Beadcause cannot renew its certificate — tap to open.'
      : [
          `The tailnet certificate ${when} and the daemon could not replace it.`,
          state.detail,
          '',
          `tailscale cert ${state.name}`,
          'needs HTTPS Certificates on: https://login.tailscale.com/admin/dns',
        ]
          .filter((l) => l !== undefined)
          .join('\n'),
    click: `${cfg.baseUrl}/`,
    priority,
    tags: ['warning', 'lock'],
  });
}

/**
 * The router is holding the port and has nothing behind it.
 *
 * The same argument as pushCertificate, one layer in: every other way this daemon has
 * of telling you something goes *through* the thing that is down. A backend that will
 * not start means the inbox answers 503, the advocate console cannot load, and the only
 * record of it is a line in ~/Library/Logs/beadcause.log on a Mac nobody is sitting at
 * — which is precisely how a good build stayed unserved twice in one evening. ntfy is
 * the one channel that does not depend on the backend being up.
 *
 * Priority 5: this is not a warning about the future, it is the app being down now. The
 * message carries the router's own verdict, which already distinguishes a build that
 * died from a machine that was too busy, and says whether it is retrying itself — the
 * difference between "wait" and "go and do something", which is the whole of what you
 * want to know from a lock screen.
 */
export async function pushNoBackend(cfg, state) {
  const n = cfg.ntfy || {};
  if (!n.enabled || !n.topic || OBSERVING) return { skipped: true };
  const minimal = ntfyDetailFor(cfg) === 'minimal';
  const verdict = state?.verdict || {};

  return publish(n, {
    topic: n.topic,
    title: minimal ? 'Beadcause' : '⚠ beadcause is serving nothing',
    message: minimal
      ? 'Beadcause is not answering — tap to open.'
      : [
          verdict.summary || 'The router holds the port and no backend is running.',
          ...(verdict.lines || []),
          '',
          `disk build ${state?.disk || 'unknown'}`,
        ].join('\n'),
    click: `${cfg.baseUrl}/`,
    priority: 5,
    tags: ['warning', 'electric_plug'],
  });
}

/** And the other half: it came back on its own, so stop worrying about it. */
export async function pushServingAgain(cfg, { seconds = null, build = null } = {}) {
  const n = cfg.ntfy || {};
  if (!n.enabled || !n.topic || OBSERVING) return { skipped: true };
  const minimal = ntfyDetailFor(cfg) === 'minimal';

  return publish(n, {
    topic: n.topic,
    title: minimal ? 'Beadcause' : '✅ beadcause is serving again',
    message: minimal
      ? 'Beadcause is answering again — tap to open.'
      : [
          seconds === null ? 'A backend is answering again.' : `A backend is answering again after ${seconds}s.`,
          build ? `Serving build ${build}.` : null,
        ]
          .filter(Boolean)
          .join('\n'),
    click: `${cfg.baseUrl}/`,
    priority: 2,
    tags: ['white_check_mark'],
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
