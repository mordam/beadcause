/**
 * ntfy push.
 *
 * The notification is the fast path: for a two- or three-option question the
 * action buttons answer it outright (ntfy allows at most 3), and tapping the
 * body deep-links into the PWA for the full brief — diagram, images, links.
 *
 * **What is left here is not everything the daemon has to say, and the split is
 * deliberate.** A merge landing, a deploy finishing and a tracker that stopped
 * syncing left this file in bc-ka5y.15.1: they are events on `app.bus` now, drawn by
 * the Android app as cards this repo lays out, on channels this repo can give a sound
 * to. See lib/news.js. They are *gone* rather than duplicated, because a phone that
 * gets a native card and an ntfy push for the same landing is worse than one that
 * gets neither.
 *
 * The four below stayed, and each stayed for a reason of its own:
 *
 * - `pushQuestion`, `pushFoundationRequest`, `pushFoundationReply`, `pushReply` are
 *   the *other* surface for arrivals the app already draws natively. They are the
 *   PWA's only notification, on a machine with no Android app installed — and they
 *   carry ntfy's action buttons, which is the one thing the relay does that nothing
 *   else here does.
 * - `pushCertificate` and `pushNoBackend` report a failure of the path a native
 *   notification would have to travel. A phone parked on `/api/poll` cannot be told
 *   that the certificate for the name it is polling has expired, and it cannot be
 *   told anything at all by a daemon that is not answering. ntfy goes through a relay
 *   that has nothing to do with either, so it still arrives. `pushServingAgain` is
 *   the other half of the second one.
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
  // were read out of a paragraph rather than written as the answer. See lib/suggest.js.
  //
  // This is now the *only* place an option answers on its own. In the app both kinds
  // fill the answer box and you send them (public/app.js, public/mirror.js), because
  // a choice is usually worth a sentence — and a lock screen is the one surface with
  // no box to fill and no sentence to add, so the tap has to mean the whole answer or
  // mean nothing.
  //
  // One thing this path still gets wrong, and it is older than the change above: the
  // body carries no `option`, so `chosenOption` in lib/server.js has nothing to look
  // up and a `closes: false` option tapped from the lock screen closes the bead
  // anyway. Filed as bc-7qo.20 rather than fixed here — it is a notification-wire
  // change, not a card change. (This comment used to say "filed as its own bead" and
  // name none, and there was no such bead in the tracker; the id is written down now.)
  //
  // bc-7qo.11 made it worse and the sentence above no longer covers it. A `defers:
  // true` option means *not yet, leave this on the list* and keeps the card in the
  // inbox; tapped from a lock screen it closes the bead, which is the exact loss it
  // exists to prevent — a commission at least leaves the instruction on a thread
  // somebody will read, where a deferral just loses the card. Until bc-7qo.20 lands,
  // an agent writing a card that Adam may answer from a lock screen should assume a
  // deferral offered there behaves as an ordinary close.
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
 *
 * There is no certificate at all — `state.state === 'absent'` — is the same channel and a
 * different sentence. Nothing is expiring, nothing is dark: the daemon is up on plain
 * http and asking again on a timer, which costs the microphone, the installable PWA and
 * Google sign-in and costs the inbox nothing. So priority 3, said once rather than daily
 * (lib/tls.js decides that), and no calendar in it — a number of days left is exactly
 * what this state does not have.
 */
export async function pushCertificate(cfg, state) {
  const n = cfg.ntfy || {};
  if (!n.enabled || !n.topic || OBSERVING) return { skipped: true };
  const minimal = ntfyDetailFor(cfg) === 'minimal';

  const days = state.daysLeft;
  const absent = state.state === 'absent';
  const priority = absent ? 3 : days === null || days === undefined ? 4 : days <= 3 ? 5 : days <= 7 ? 4 : 3;
  const when = days === null || days === undefined ? 'is unreadable' : days <= 0 ? 'has EXPIRED' : `expires in ${days} days`;
  // Without a MagicDNS name there is no command to give — that missing name *is* the
  // reason there is no certificate — and a printed `tailscale cert null` would send
  // somebody to run it.
  const fix = state.name
    ? [`tailscale cert ${state.name}`, 'needs HTTPS Certificates on: https://login.tailscale.com/admin/dns']
    : ['check `tailscale status` on the Mac — Tailscale has not named it, so there is no name to certify'];

  return publish(n, {
    topic: n.topic,
    title: minimal
      ? 'Beadcause'
      : absent
        ? `⚠ no certificate — serving plain http${state.name ? ` · ${state.name}` : ''}`
        : `⚠ certificate ${when.replace('has ', '')} · ${state.name}`,
    message: minimal
      ? absent
        ? 'Beadcause could not get a certificate — tap to open.'
        : 'Beadcause cannot renew its certificate — tap to open.'
      : [
          absent
            ? 'Beadcause is serving plain http on the tailnet address: it has no certificate and could not get one. ' +
              'It keeps asking, and adopts one the moment it can.'
            : `The tailnet certificate ${when} and the daemon could not replace it.`,
          // Past the date, say where the link goes before it is tapped. The daemon keeps
          // the expired certificate on the socket rather than dropping the origin to
          // plain http (bc-jv86), so this URL answers with a browser warning rather than
          // not answering — and a push that does not say so reads as a broken link.
          !absent && days !== null && days !== undefined && days <= 0
            ? 'It is still on the socket, so this link answers with a certificate warning rather than moving to plain http.'
            : undefined,
          state.detail,
          '',
          ...fix,
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
