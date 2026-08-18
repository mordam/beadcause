/*
  Every pane built at boot, staged — and one poll behind all of them (bc-khoe.30.4).

  ## What this is for

  public/panes.js made the app one document with a `[data-pane]` container per view and a
  hash that says which of them is up. It deliberately builds nothing: the containers are
  markup that was parsed with the page, and what goes *in* them is here.

  Two claims, and they pull against each other, which is the whole of why this is staged
  rather than a loop.

  **The view you land on must not be slower than it was.** A home-screen shortcut to
  `/#history`, or a notification tap on a bead, must not spend its first frames building a
  board nobody asked for. So the landed-on pane is built first, in the same turn as the
  boot that would have built it when it was a document of its own.

  **Every other pane must be ready before the first tap.** A pane built on the tap that
  shows it is a document load wearing a different mechanism — the second of white this
  epic exists to remove. So the rest are built after the first paint, one per task, and by
  the time a thumb has moved they are up.

  ## Hidden is not paused

  A pane that has been hidden for an hour has to be correct the instant it is shown, with
  nothing to catch up on. That is a property of the *events*, not of the pane: a pane is
  built once and then follows the log for as long as the page is open, exactly as the page
  it replaced did.

  What it must not do is follow the log **itself**. public/stream.js is one long poll and
  its own note is explicit about the bill: several parked clients asking for the inbox
  means several `bd` sweeps per event, and five panes each mounting one would be exactly
  that from a single page. So the document holds one poll and this file fans its wakes out
  to the panes; a pane says what it wants from an event (`want`) and what to do with one
  (`wake`), and never opens a socket.

  **The want is the union of the panes', not the widest thing on the page.** `want:
  'presence'` is what makes a park free — it tells the daemon this client is not going to
  read the inbox questions it would otherwise sweep `bd` to build. A pane that draws the
  advocate roster wants presence; a pane that draws the inbox wants the questions; the one
  request asks for whichever of those is wider among the panes actually built. Widening it
  because *some* pane on the page might one day want more is how the timer's bill comes
  back.

  ## Which mount, and why there are two of them

  The inbox owns the real poll — it is the one consumer that asks the daemon for the
  questions, it hands the stream a sequence off its own payload, and it has a timer behind
  it (see the `follow` call at the foot of public/app.js). Nothing here takes that over.

  But that mount follows the log only in `human` scope, so on any wider scope it is off —
  and panes riding its wakes would go quiet with it, where the pages they replaced polled
  regardless. So this file mounts a second, `standby: true`, which public/stream.js runs
  **only** while no ordinary mount is following and stands down the instant one starts.
  Two mounts, never two sockets, and `alive()` in that file refuses a standby started from
  anywhere else meanwhile — a visibility handler, a retry, the freshness banner's Retry
  now.

  It is mounted lazily and only when some built pane has a `wake`, which today is none of
  them: Home is the one pane with contents and it keeps its own poll. So on this branch
  the page holds exactly the one connection it held before, and the standby is machinery
  waiting for bc-khoe.30.5 and .30.6 rather than a second park landing early.

  ## What a pane registers, and what happens if it does not

  `register` is called by a pane's own script as it loads, and it answers **whether the
  stager took it**. A page with no panes — eleven of the twelve that draw the pill row —
  never loads this file at all, so the call is `window.beadcause?.stage?.register?.(…)`,
  comes back `undefined`, and the script builds itself the way it always did. That
  fallback is not a nicety: it is what keeps a phone holding a service-worker cache from
  before this file working, and it is why `build` must be the same function the script
  would have called on its own rather than something only reachable through here.

  A builder that throws takes its own pane down and nothing else. It is rethrown out of a
  timer rather than swallowed, so public/report.js's window handler still files it as the
  P0 it is — a pane that silently did not build is a blank screen with no account of why.

  ## What is deliberately not here

  **No hiding and no showing.** Which pane is up is public/panes.js's, off the hash, and
  this file only listens: `onShow` is the safety net for a tap that beats the staged
  build, not a second answer to the same question.

  **No fetching of its own beyond the poll.** Each pane's `build` goes and gets whatever
  it draws, because only it knows what that is — the same division public/stream.js makes
  between owning the socket and knowing what an event means.
*/
(() => {
  'use strict';

  const panes = window.beadcause?.panes;
  const route = window.beadcause?.route;

  /** What each registered pane declared, by view id, in registration order. */
  const specs = new Map();

  /** The views whose `build` has been called. Added *before* the call, so a thrower is
   *  not retried on every subsequent show. */
  const done = new Set();

  /** The views whose `build` came back. A pane that threw half way is not one of them and
   *  is told nothing: a wake against a container that is partly drawn is a second failure
   *  on top of the one already filed. */
  const live = new Set();

  /** Has the staged boot run? A `register` after it builds at once rather than never. */
  let booted = false;

  /* ------------------------------------------------------------------ the poll */

  const token = () => {
    try {
      return localStorage.getItem('beadcause.token') || '';
    } catch {
      return '';
    }
  };

  /**
   * A fetch wrapper for the standby poll, and only for it.
   *
   * Small on purpose. Every page here has one of these and they differ in what they do
   * about a refusal — the inbox forgets the stored token and puts the sign-in prompt up,
   * because it is the screen you are looking at. This one is behind a poll nobody sees,
   * so it does the one thing public/stream.js's contract needs: `token rejected` is the
   * message that file reads as "already handled, do not retry", and retrying a credential
   * the daemon has refused is a request every five seconds for as long as the tab is open.
   */
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'x-beadcause-token': token(), ...(opts.headers || {}) },
    });
    if (res.status === 401) throw new Error('token rejected');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** The standby mount, and the `want` it is currently asking with — `null` is the full
   *  one. Read per request by `follow`, so widening it is a re-park rather than a remount. */
  let shell = null;
  let shellWant;

  /** Every built pane that asked to be told, in registration order. */
  const following = () => [...specs].filter(([id, spec]) => spec.wake && live.has(id));

  /**
   * What the one request should ask for: the union of what the built panes want.
   *
   * `'questions'` is the wider of the two and maps to *no* `want` parameter, which is the
   * daemon's "sweep `bd` and put the inbox on the answer". Anything else is presence, so a
   * pane that declares nothing costs nothing — the safe default, because the failure of
   * guessing the other way is a sweep per event that nobody reads.
   */
  const want = () => (following().some(([, s]) => s.want === 'questions') ? null : 'presence');

  /**
   * Put the standby up, or move it to a wider want.
   *
   * Called after every build rather than once at the end, because a pane built late — by
   * `onShow`, ahead of the staged pass — has to start following in the same turn it was
   * built. Idempotent: with the want unchanged it is a comparison and a return, which is
   * what makes calling it three times at boot cost one mount.
   */
  function feed() {
    if (!following().length) return;
    const next = want();
    if (shell) {
      if (shellWant === next) return;
      // The union widened under the mount — a pane built after the first that needs more
      // than presence. Re-parked rather than replaced: `follow` reads `want` per request,
      // and a second `follow` would leave the first in public/stream.js's registry for the
      // life of the page, where `arbitrate` would dutifully start it again beside this one.
      shellWant = next;
      shell.repark();
      return;
    }
    shellWant = next;
    shell =
      window.beadcause?.stream?.follow?.({
        api,
        want: () => shellWant,
        // `/api/poll` is the only thing this mount asks for and it carries no payload of
        // its own to take a sequence off, so the first request goes out without a `since`
        // to learn one. Free, because that request is the one the daemon answers at once
        // — and with `want=presence` it sweeps nothing on the way.
        cold: true,
        standby: true,
      }) || null;
    shell?.start();
  }

  /* ----------------------------------------------------------------- the fan-out */

  /**
   * Hand one answered poll to every built pane that wants it.
   *
   * The shape is `follow`'s own `onWake` argument — `{data, events, resync}` — so a pane
   * script converted from a page moves its handler across unchanged rather than learning
   * a second vocabulary for the same event.
   *
   * Contained per pane: one pane throwing on an event is one pane's screen, and the
   * others are mid-fan-out behind it.
   */
  function fanout(events, extra) {
    const wake = { data: extra?.data ?? null, events: events || [], resync: Boolean(extra?.resync) };
    for (const [id, spec] of following()) {
      try {
        spec.wake(wake);
      } catch (err) {
        console.error(`[stage] ${id} failed on a wake`, err);
      }
    }
  }

  window.beadcause?.stream?.listen?.(fanout);

  /* ------------------------------------------------------------------- building */

  /**
   * Build one pane, once.
   *
   * The throw is rethrown out of a timer rather than swallowed: it must not take the
   * staged pass down with it — the other panes are the rest of the app — and it must not
   * disappear either, because public/report.js turns an uncaught error into a P0 bead and
   * a pane that quietly did not build is a blank screen with nothing to read.
   */
  function build(view) {
    const spec = specs.get(view);
    if (!spec || done.has(view)) return false;
    done.add(view);
    try {
      spec.build();
      live.add(view);
    } catch (err) {
      setTimeout(() => {
        throw err;
      }, 0);
      return false;
    }
    feed();
    return true;
  }

  /**
   * After the browser has painted, rather than merely after this turn.
   *
   * A frame callback runs *before* the paint it was scheduled for, so the task queued
   * from inside it is the first thing after it — the standard way to say "when the screen
   * has something on it". Without a frame clock (a `node:vm`, a very old browser) a task
   * is the honest approximation: the ordering this buys is a nicety, and the pane being
   * built is not.
   */
  function afterPaint(fn) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(fn, 0));
    else setTimeout(fn, 0);
  }

  /**
   * The staged boot: the landed-on pane now, the rest after the first paint.
   *
   * "Landed on" is whichever pane public/panes.js is showing, which is what the hash
   * named — and Home when it named nothing, because Home is where an unrecognised hash
   * falls and a bare `/` is the commonest address this app has.
   *
   * One task per remaining pane rather than a loop through them: three builders in one
   * task is one long frame, and the point of waiting for the paint was not to hand the
   * jank back immediately afterwards.
   */
  function boot() {
    if (booted) return;
    booted = true;
    build(panes?.showing?.() || route?.HOME || 'epics');
    afterPaint(() => {
      for (const view of specs.keys()) {
        if (!done.has(view)) setTimeout(() => build(view), 0);
      }
    });
  }

  /*
    Every pane script registers as it loads, and they all load before this runs — the
    document's scripts are one block at the foot of the body, so `DOMContentLoaded` is the
    first moment every one of them has had its say. It is also, on this page, the very next
    thing after the last script executes, which is why the landed-on pane is built in the
    same instant it was built before this file existed.
  */
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  /*
    And the safety net. A pane shown before the staged pass reached it — a very fast thumb,
    or a `hashchange` arriving while the first frame is still out — is built on the spot
    rather than shown empty. `build` is a no-op for a pane already done, so this costs a set
    lookup on every ordinary switch.
  */
  panes?.onShow?.((view) => build(view));

  window.beadcause = window.beadcause || {};
  window.beadcause.stage = {
    /**
     * A pane's script saying how to build it, what to do with a wake, and what it needs.
     *
     * @param {string} view                 the view id, as in public/hashroute.js
     * @param {object} spec
     * @param {function} spec.build         build this pane's contents; called once
     * @param {function} [spec.wake]        `({data, events, resync})` — an answered poll
     * @param {string} [spec.want]          `'questions'` if this pane draws the inbox
     * @returns {boolean} whether the stager took it — `false` means build yourself
     */
    register(view, spec) {
      if (!panes?.has?.(view) || typeof spec?.build !== 'function') return false;
      specs.set(view, spec);
      if (booted) build(view);
      return true;
    },
    /** The views built so far, in the order they were built. */
    built: () => [...live],
    /** The `want` the one request is asking for — `null` is the full inbox sweep. */
    want,
    /** Whether the standby poll is up. `false` while a view owns the socket. */
    standing: () => Boolean(shell?.following),
    /** Run the staged boot now. For a document that is already parsed, and for a test. */
    boot,
  };
})();
