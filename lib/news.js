/**
 * The four arrivals that tell you something rather than ask you something.
 *
 * A question, a foundation request and an agent's reply have reached the phone as
 * real notifications since the Android app existed: the daemon emits on `app.bus`,
 * the watch service is parked on `/api/poll`, and the card is drawn by code this
 * repo owns. Everything *else* the daemon had to say went out over ntfy — a merge
 * landing, a deploy finishing, a tracker that stopped syncing — which meant it
 * arrived in ntfy's app, on ntfy's channel, with a sound beadcause cannot set and a
 * card beadcause cannot lay out. This module is the other half of that pipe.
 *
 * **Four types, not one `news` type with a `kind` field.** They are separate
 * Android channels (bc-ka5y.15.4), separate sounds and, for the stuck one, a
 * separate card that does not self-expire — so a client has to be able to file an
 * arrival without asking the server a second question, and a single type would make
 * every consumer switch on a payload field to find that out. The types are:
 *
 * - `landed`   — a pull request went into `main`. Good news, smallest possible blip.
 * - `released` — a deploy succeeded, so what is running is what is on `main`.
 * - `stuck`    — a deploy failed, was lost, or is unconfirmed; or a tracker is not
 *                syncing. Carries `state: 'stuck' | 'clear'`, because this one is a
 *                *state* rather than an arrival: the card that says it goes away when
 *                the state does, and nothing else here is ever taken back.
 * - `epic-done` — an epic completed. The emitter is bc-ka5y.15.2's, which is why that
 *                bead depends on this one: what completing *means* and which closes
 *                must stay silent (your own tap, from this app) is a judgement, and
 *                this file is only the shape it arrives in.
 *
 * **Every event is self-contained.** `title` and `text` are the two the card is drawn
 * from, and they are composed here rather than on the phone for the same reason the
 * ntfy bodies were composed in lib/notify.js: the sentence that says a deploy was
 * refused over a stale LaunchAgent, and the one that says a stuck tracker will not
 * clear on its own, are the product of arguments that live on this side (see
 * lib/launchagent.js, lib/sync.js) and would be a second copy to drift in Kotlin.
 *
 * **What deliberately did not move off ntfy.** `pushCertificate` and `pushNoBackend`
 * in lib/notify.js stay exactly where they are, and the reason is in their own doc
 * comments: both report a failure of the very path this one travels. A phone parked
 * on `/api/poll` cannot be told that the certificate for the name it is polling has
 * expired, and it cannot be told by a daemon that is not answering. ntfy goes through
 * a relay that has nothing to do with either, so it still arrives. `pushServingAgain`
 * is the other half of the second of those and stays with it.
 */

// One spelling of "where a deploy ran", shared with lib/deploy.js's own `whereOf` and
// with what lib/notify.js used to print. A workspace of forty checkouts has no single
// directory, and "climative deployed" says nothing on a Mac where climative is forty
// repos.
import { whereOf } from './deploy.js';
import { isQuiet, spaceFor } from './spaces.js';

/**
 * Is the space this workspace belongs to muted right now?
 *
 * Not `quietReasonFor`, which is the inbox's question and needs a filter and an
 * account to answer: those two narrow *what you are looking at*, and a release is not
 * something you were looking at. What survives of that idea here is the mute — a
 * space you have silenced for the evening should not chime because something in it
 * merged — and the mute alone is what this asks.
 *
 * **`stuck` is never quiet**, and that is the one deliberate exception. A mute is a
 * statement about news; a tracker that has stopped syncing is not news, it is the
 * app quietly lying to you about every other repo on the Mac, and the whole argument
 * for giving class 2 the one insistent voice (bc-ka5y.15) is that it cannot be
 * arranged not to speak.
 */
export function mutedNews(cfg, workspace, now = new Date()) {
  if (!workspace) return false;
  try {
    return isQuiet(spaceFor(cfg, workspace), now);
  } catch {
    // A config mid-edit is not a reason to swallow a notification.
    return false;
  }
}

/**
 * A pull request went into `main`.
 *
 * The fields are `pushLanded`'s, unchanged, because they were already the right ones:
 * the number and the title are what makes the card readable in the shade without
 * opening anything, and the bead is what makes it findable six months later.
 *
 * There is nothing to answer here and so there are no buttons — the reasoning is the
 * one `pushLanded` carried and it holds on a native card too. The only action a
 * landed merge could offer is a revert, and a revert is not a lock-screen gesture.
 */
export function landedEvent(landing, { quiet = false } = {}) {
  const lines = [];
  if (landing.sha) lines.push(`${landing.base || 'main'} ← ${String(landing.sha).slice(0, 8)}`);
  if (landing.owed) lines.push(`Still owed: ${landing.owed}`);
  return {
    type: 'landed',
    // Not the bead's own `<workspace>/<id>` key: that is the key a question card is
    // filed under, and a landing whose bead is still in the shade as a delivery card
    // would replace it. See Tray.add on the phone, which sweeps by key across decks.
    key: `news/landed/${landing.workspace}/${landing.bead || landing.number}`,
    workspace: landing.workspace || null,
    id: landing.bead || null,
    number: landing.number ?? null,
    title: `#${landing.number} ${landing.title || landing.bead || ''}`.trim().slice(0, 200),
    text: lines.join('\n'),
    quiet,
  };
}

/**
 * How a deploy ended — one record, two different pieces of news.
 *
 * `pushDeploy` sent all four statuses down one channel at two priorities, which was
 * the best a single ntfy topic could do. On the phone they are two classes out of the
 * five: a deploy that worked is a release (a calm water drop, no vibration, gone in a
 * minute) and a deploy that did not is work being stuck (the only voice allowed to
 * insist, and a card that stays until it clears). So this returns one or the other,
 * and the caller emits whatever it gets.
 *
 * `unconfirmed` counts as stuck rather than as a release, and that is the same
 * judgement `pushDeploy` made when it refused to round it to either side: the deploy
 * that restarts beadcause always kills the process reporting on it, and "we ran it and
 * nothing outlived it to check" is not a release you can rely on.
 */
export function deployEvent(rec, { quiet = false } = {}) {
  const ok = rec.status === 'ok';
  const word = { ok: 'deployed', failed: 'deploy failed', lost: 'deploy lost', unconfirmed: 'deploy unconfirmed' }[rec.status] || `deploy ${rec.status}`;
  return {
    type: ok ? 'released' : 'stuck',
    key: ok ? `news/released/${rec.workspace || ''}/${rec.id || ''}` : deployStuckKey(rec),
    workspace: rec.workspace || null,
    id: rec.id || null,
    ...(ok ? {} : { state: 'stuck', source: 'deploy' }),
    title: `${whereOf(rec)} ${word}`,
    text: deployLines(rec).join('\n'),
    // A release is news and obeys a muted space; a stuck deploy is not and does not.
    quiet: ok ? quiet : false,
  };
}

/**
 * Which card a broken deploy of this repo owns — one per repo, not one per attempt.
 *
 * A second failed deploy of the same checkout is the *same* problem said again, so it
 * replaces the row rather than stacking beside it. And it is the key a success cancels,
 * which is what `deployClearEvent` is for. Keyed on the repo rather than the record id
 * for exactly that reason: an id is unique per attempt, and a card keyed by one could
 * never be taken back by the attempt that fixed it.
 */
const deployStuckKey = (rec) => `stuck/deploy/${rec.workspace || ''}/${rec.repo || ''}`;

/**
 * And the deploy that worked, taking the last one's warning away.
 *
 * Emitted beside the release rather than folded into it, because they are two different
 * facts about two different cards: the release is news you have not heard, and this is a
 * warning you *have* heard that has stopped being true. Without it a failed deploy would
 * leave its card in the shade until somebody swiped it — including through the deploy
 * that fixed it, which is the one moment the warning is provably wrong.
 *
 * A no-op on the phone when nothing is showing, which is the ordinary case: removing a
 * key that is not in the tray removes nothing and re-renders nothing.
 */
export function deployClearEvent(rec) {
  return {
    type: 'stuck',
    key: deployStuckKey(rec),
    workspace: rec.workspace || null,
    id: rec.id || null,
    state: 'clear',
    source: 'deploy',
    title: `${whereOf(rec)} deployed`,
    text: '',
    quiet: false,
  };
}

/**
 * What a deploy record has to say for itself, as lines.
 *
 * Lifted out of `pushDeploy` unchanged, including the one failure that is written out
 * in full rather than truncated. `error` on a refusal over a stale LaunchAgent is
 * lib/launchagent.js's whole verdict as a paragraph, and `error.slice(0, 300)` cut it
 * at the refusal — so the message said what would not happen and never reached the
 * program launchd would have restarted or the command that fixes it, which are the two
 * things it exists to deliver. The record carries all three as fields, so this sends
 * the fields. See test/launchagentcard.mjs.
 */
export function deployLines(rec) {
  const la = rec.launchAgent || null;
  const lines = [];
  if (rec.to) lines.push(`${rec.base || 'main'} → ${String(rec.to).slice(0, 8)}`);
  if (rec.bead) lines.push(`after ${rec.bead}`);
  if (la) {
    lines.push(`refused: ${la.label} is stale`);
    lines.push(la.program ? `launchd would restart ${la.program}` : 'no readable LaunchAgent to name');
    // The command wins the last line when there is one: it is the shortest thing here
    // and the only one you can act on without opening anything.
    if (la.fixCommand || la.fix) lines.push(`fix: ${la.fixCommand || la.fix}`);
  } else if (rec.error) {
    lines.push(rec.error.slice(0, 300));
  }
  if (!lines.length) lines.push(rec.reason || rec.id || '');
  return lines.filter(Boolean);
}

/**
 * Two machines are drifting apart, and neither screen can tell you so.
 *
 * `pushSyncTrouble`'s argument, its wording and its three states, moved whole. A repo
 * that could not be *read* shows you a stale list, which is a lie you are at least
 * looking at; a tracker that is not *syncing* shows you a list that is completely
 * correct about this Mac and silently out of date about everybody else's. There is
 * nothing on the screen to notice.
 *
 * A conflict and a stuck sync say the opposite of what a plain failure says, on
 * purpose: the sentence "it retries on every interval" was true-sounding and wrong for
 * 73 ticks running, which is what the `stuck` state exists to stop saying.
 */
export function syncStuckEvent(rows) {
  const conflicted = rows.filter((r) => r.conflict);
  const stuck = rows.filter((r) => r.stuck);
  const names = rows.map((r) => r.workspace).join(', ');
  const title = conflicted.length
    ? `tracker CONFLICT · ${conflicted.map((r) => r.workspace).join(', ')}`
    : stuck.length
      ? `tracker STUCK · ${stuck.map((r) => r.workspace).join(', ')}`
      : `tracker not syncing · ${names}`;
  return {
    type: 'stuck',
    // One card for the tracker however many workspaces are in it, so a second bad tick
    // replaces the row rather than stacking beside it — and so the recovery below can
    // take that one row away by naming the same key.
    key: 'stuck/sync',
    workspace: rows[0]?.workspace || null,
    state: 'stuck',
    source: 'sync',
    title,
    text: syncLines(rows).join('\n'),
    quiet: false,
  };
}

/** And the other half: they agree again, so the card goes. */
export function syncClearEvent(rows) {
  const names = rows.map((r) => r.workspace).join(', ');
  return {
    type: 'stuck',
    key: 'stuck/sync',
    workspace: rows[0]?.workspace || null,
    state: 'clear',
    source: 'sync',
    title: `tracker syncing again · ${names}`,
    text: `${names} ${rows.length === 1 ? 'is' : 'are'} in sync again. Anything written on either machine while it was down has been merged in both directions.`,
    quiet: false,
  };
}

/**
 * What a broken sync has to say for itself, as lines — `pushSyncTrouble`'s body.
 *
 * The command rather than an instruction to go and find one: a warning you have to
 * research is a warning that waits until the weekend. The directory comes off the
 * workspace rather than being built from its name — a workspace is not necessarily
 * under `~/beads`, and a suggested `cd` into a path that does not exist teaches you
 * that this message is not to be trusted.
 */
export function syncLines(rows) {
  const conflicted = rows.filter((r) => r.conflict);
  const stuck = rows.filter((r) => r.stuck);
  return [
    conflicted.length
      ? 'Dolt cannot merge the two histories, so this will not clear on its own — the beads on this Mac and the beads on the other one have both moved and somebody has to say which wins.'
      : stuck.length
        ? 'The same error has come back every interval and the retry is not getting anywhere, so this one will not clear on its own.'
        : 'Beads written here are not reaching the other machines, and theirs are not reaching this one. It retries on every interval.',
    '',
    ...rows.map((r) => `${r.workspace} — ${r.error}`),
    '',
    // A stuck row gets a *different* command, because the obvious one is the one that
    // has already failed every two minutes for a week. `bd dolt commit` has been tried
    // by then (see lib/sync.js), so what is left to suggest is the half a daemon may
    // not do on its own.
    ...rows
      .filter((r) => r.dir)
      .map((r) =>
        r.stuck
          ? `cd ${r.dir} && bd dolt ${r.phase || 'pull'}   # if it still says "stomped by merge", the working set differs from HEAD invisibly:\n` +
            `cd ${r.dir}/.beads/embeddeddolt/* && dolt checkout <the table the error names>`
          : `cd ${r.dir} && bd dolt ${r.phase || 'pull'}`
      ),
  ];
}

/**
 * An epic completed — the milestone, and the largest of the three sizes of good news.
 *
 * **Nothing calls this yet, and that is the shape of bc-ka5y.15.2 rather than an
 * oversight.** Nothing closes an epic on its own here: lib/bd.js refuses an epic close
 * on a merge, because a pull request is no evidence about a theme, and six epics closed
 * that way in August with sixty adoptees still open. So the close is a judgement, the
 * event is the bead *transitioning* to closed, and the detection owes one suppression
 * that has to be built with it — an epic you closed yourself, from the app in your
 * hand, must not chime, because a notification for your own tap is the fastest way to
 * teach somebody that a sound means nothing.
 *
 * That detection is .15.2's whole content and .15.2 depends on this bead. What is
 * settled here is what it will emit: the epic's title, and how many beads closed under
 * it, which is the pair the card is required to show.
 */
export function epicDoneEvent({ workspace, id, title, closed = 0 }, { quiet = false } = {}) {
  return {
    type: 'epic-done',
    key: `news/epic/${workspace}/${id}`,
    workspace: workspace || null,
    id: id || null,
    title: title || id || 'An epic is finished',
    text: closed ? `${closed} bead${closed === 1 ? '' : 's'} closed under it.` : 'Every bead under it is closed.',
    quiet,
  };
}
