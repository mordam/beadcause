/* Keeping the thing you are holding in step with the thing that just shipped.
 *
 * A deploy on this Mac moves two artefacts and neither of them is the running daemon:
 * the files under `public/` that every open tab is made of, and — when `android/` moved
 * — the APK the WebView shell itself is. Until this file, both changes were invisible
 * from the client side. A phone left on the inbox went on running whatever bundle it had
 * loaded that morning, against a daemon that had moved underneath it; and the shell was
 * upgraded by somebody remembering to open `/beadcause.apk` and thumb through an
 * installer. The deploy knew. Nothing told the app.
 *
 * So: **the daemon says what it did, and the app decides what that means for it.** The
 * saying is two booleans on the `deploy` event lib/server.js already emits when a record
 * settles, and `GET /api/update` for a client that has just arrived and saw no event
 * (lib/update.js is where both come from, and why they follow the *pull* rather than the
 * restart). The deciding is here.
 *
 * ## Two very different sizes of "update", and only one of them is automatic
 *
 * - **The page moved** — reload it. That is cheap, invisible when it lands well, and the
 *   alternative is a bundle talking to files that have moved under it. So it happens on
 *   its own, and the whole of the care in it is *when*: never over something you are
 *   typing (see `busy`), and never without going through the service worker first, or
 *   the shell cache hands the same files straight back (public/sw.js).
 * - **The shell moved** — download it silently, then **ask**. Installing an APK restarts
 *   the app; doing that unasked to somebody mid-answer would be indefensible however
 *   good the reason. The download is not the install, and the split is deliberate: by
 *   the time you are asked, the 28 MB is already on the phone and saying yes is
 *   seconds rather than a minute of watching a bar over a tailnet.
 *
 * ## The event is not enough, and the boot read is the dangerous half
 *
 * The obvious design is: reload on the live event, and use `/api/update` only for the
 * APK. It is wrong, and wrong in the one case the whole feature is about. A beadcause
 * deploy **kills the daemon every client is parked on**; the settle event is emitted by
 * the *new* process at its first sweep, and by then every parked poll has broken and is
 * sitting out a backoff. A poll that comes back asks cold — current sequence, no backlog
 * (see public/stream.js) — so the one event that matters is precisely the one a page can
 * be relied upon to miss.
 *
 * So the boot read reloads too, and the reason it is dangerous is that a page reloading
 * off "the last deploy changed the page" comes back up, asks, is told about the same
 * deploy, and reloads again. Forever, on every device, fastest on the one that just got
 * the fix. Two things stop that, and both are needed:
 *
 * - **One reload per deploy id, ever, per device.** The id is written down *before* the
 *   reload, so the page that comes back finds it already spent. That is the loop-breaker
 *   and it holds no matter what else is wrong — a clock miles out, a service worker
 *   handing back the old bundle, a page that reloads for its own reasons.
 * - **And only when this page predates the deploy.** A page loaded *after* the deploy
 *   finished already fetched the new files, and reloading it would be a flicker for
 *   nothing. Compared against when this script first ran, which is as close to "when
 *   these files arrived" as anything on the page gets.
 *
 * The second is the heuristic and the first is the guarantee; the comparison is between
 * two different machines' clocks, so it is allowed to be wrong and is never load-bearing.
 *
 * ## It borrows the page's poll rather than opening one
 *
 * One parked request per page is a rule this app keeps carefully — public/montabs.js
 * stands a hidden pane's poll down to keep it. This script is on every standing page, so
 * a poll of its own would be a second parked request everywhere, on every device, for
 * one boolean. `stream.listen` hands it the events the page's own `follow()` already
 * receives. A page with no stream (the login screen, a doc in the reader) hears nothing
 * and does nothing, which is right: nobody is working there.
 */
(() => {
  'use strict';

  const token = () => {
    try {
      return localStorage.getItem('beadcause.token') || '';
    } catch {
      return '';
    }
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /**
   * The shell, when there is one. `window.BeadcauseNative` is the Android bridge
   * (MainActivity.Bridge); every method is checked for by name rather than by version,
   * because an APK that predates this feature has the object and not the methods — and
   * the honest behaviour there is to do nothing at all rather than throw on every deploy.
   */
  const native = () => {
    const n = window.BeadcauseNative;
    return n && typeof n.downloadUpdate === 'function' && typeof n.installUpdate === 'function' ? n : null;
  };

  /**
   * When these files arrived, near enough.
   *
   * The moment this script first ran, which for a page is within a few milliseconds of
   * everything else on it being fetched. Compared against a deploy's finishing time to
   * decide whether this page predates it — see the header, and note that the two stamps
   * come off different machines' clocks, which is why the loop-breaker below is a
   * separate mechanism rather than a tighter comparison.
   */
  const LOADED_AT = Date.now();

  /** Deploys this device has already reloaded for, so it cannot do so twice. */
  const SEEN_KEY = 'beadcause.update.seen';

  const seen = (id) => {
    try {
      return localStorage.getItem(SEEN_KEY) === String(id);
    } catch {
      // No storage — a locked-down browser, or private mode. Then the id cannot be
      // remembered, and the *time* comparison is the only guard against a second reload.
      // That is weaker and it is the right way round: a page that reloads twice is worse
      // than one that reloads never, so `markSeen` failing must not stop the reload.
      return false;
    }
  };

  const markSeen = (id) => {
    try {
      localStorage.setItem(SEEN_KEY, String(id));
    } catch {
      /* see above */
    }
  };

  const state = {
    /** What `/api/update` last said the published APK is. */
    apk: null,
    /** What the shell says about its own download: `{phase, versionName, error}`. */
    shell: null,
    /** True once the ask has been put up for this download, so it is asked once. */
    asked: false,
    /** Dismissed the banner — the top-bar button stays until it is actually installed. */
    later: false,
    /** Armed the install button; the second tap is what starts it. */
    armed: false,
    /** A reload is owed and the page was busy when it came due. */
    owed: false,
  };

  async function api(path) {
    const res = await fetch(path, { headers: { 'x-beadcause-token': token() } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /* ------------------------------------------------------------------ reloading */

  /**
   * Is this a bad moment to pull the page out from under somebody?
   *
   * Deliberately generous about what counts as busy. A reload that lands on a half-typed
   * answer costs real work — app.js keeps drafts per keystroke precisely because that
   * work is worth keeping — and a reload that waits four minutes costs nothing anybody
   * will notice. Anything with a caret in it, any open `<dialog>`, and a selection.
   */
  function busy() {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return true;
    if (document.querySelector('dialog[open]')) return true;
    const sel = window.getSelection?.();
    return Boolean(sel && !sel.isCollapsed && String(sel).trim());
  }

  /**
   * Reload onto the files the deploy left behind.
   *
   * `registration.update()` first, and it is not a formality: the service worker
   * precaches the whole shell under one key, so a plain reload on an installed PWA is
   * answered out of that cache with the very bundle we are trying to leave. `sw.js`
   * calls `skipWaiting()` on install, so the fetched generation takes over as soon as it
   * is there — the wait below is for that, with a ceiling, because a phone on a bad link
   * must still end up reloading rather than sitting here.
   */
  async function reloadNow() {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        const took = new Promise((done) => {
          navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
          setTimeout(done, 4000);
        });
        await reg.update();
        await took;
      }
    } catch {
      // No worker, or an update that failed. The reload below is still worth doing: a
      // page with no service worker was never being served out of a cache anyway.
    }
    location.reload();
  }

  /** Reload when it is safe to, and keep waiting while it is not. */
  function reloadWhenIdle() {
    state.owed = true;
    if (busy()) return;
    state.owed = false;
    reloadNow();
  }

  /**
   * A deploy moved the page. Reload for it at most once, on this device, ever.
   *
   * The id is spent *before* the reload rather than after it, and the difference is the
   * whole guarantee: written afterwards it would never be written at all, because the
   * reload is what stops this page existing.
   */
  function reloadFor(id) {
    if (id && seen(id)) return;
    if (id) markSeen(id);
    reloadWhenIdle();
  }

  /* --------------------------------------------------------------------- the APK */

  /** Which build the shell is, or `null` where it cannot say — an APK from before this. */
  function installedVersion() {
    const n = native();
    if (!n || typeof n.updateVersion !== 'function') return null;
    const v = Number(n.updateVersion());
    return Number.isInteger(v) && v > 0 ? v : null;
  }

  /**
   * Is the published APK a *newer* build than the one running?
   *
   * Three ways to be unable to answer, and every one of them means "do nothing": no
   * shell (a browser, where an APK is meaningless), no `versionCode` on the published
   * file (see `apkInfo` — a sidecar that does not match the APK beside it), and no
   * version out of the shell. Equal is not newer, and older is certainly not: Android
   * refuses a downgrade, so offering one would be a button that cannot work.
   */
  function apkIsNewer() {
    const mine = installedVersion();
    const theirs = Number(state.apk?.versionCode);
    if (!mine || !Number.isInteger(theirs)) return false;
    return theirs > mine;
  }

  /** Ask the shell to fetch it. Idempotent — the shell ignores a download it is doing. */
  function fetchApk() {
    const n = native();
    if (!n || !apkIsNewer()) return;
    if (state.shell?.phase === 'downloading' || state.shell?.phase === 'ready') return;
    try {
      n.downloadUpdate(JSON.stringify(state.apk));
    } catch (err) {
      console.error('[update] the shell would not take the download', err);
    }
  }

  /* ------------------------------------------------------------------- the button */

  /** Where a control that belongs to the whole app goes, on whichever page this is. */
  function slot() {
    return document.querySelector('.topbar .sheet-actions') || document.querySelector('.topbar');
  }

  function render() {
    const host = slot();
    if (!host) return;
    const ready = state.shell?.phase === 'ready';
    const failed = state.shell?.phase === 'failed';
    const installing = state.shell?.phase === 'installing';

    let btn = document.getElementById('app-update');
    if (!ready && !installing && !failed) {
      btn?.remove();
      banner(null);
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'app-update';
      btn.className = 'icon-btn app-update';
      btn.addEventListener('click', install);
      // First in the row rather than last: it is the only control in that bar that is
      // about the app itself rather than about what is on the screen, and it is the one
      // you are looking for when you are looking for it.
      host.prepend(btn);
    }
    btn.textContent = installing ? 'Updating…' : failed ? 'Retry update' : state.armed ? 'Install — sure?' : 'Update app';
    btn.classList.toggle('armed', Boolean(state.armed));
    btn.disabled = Boolean(installing);
    btn.title = failed
      ? `The download failed — ${state.shell?.error || 'no reason recorded'}. Tap to try again.`
      : `Beadcause ${state.shell?.versionName || 'update'} is downloaded and ready to install. The app restarts itself afterwards.`;

    // Asked once per download, and only once: after Later, the button above is the whole
    // of the reminder. A banner that came back on every repaint would be a nag.
    if (ready && !state.asked && !state.later) {
      state.asked = true;
      banner(
        `Beadcause ${state.shell?.versionName || 'update'} is downloaded. Install it now? The app will restart.`
      );
    }
    if (!ready) banner(null);
  }

  /**
   * The ask, over the top bar.
   *
   * Its own element rather than one of the page's, because this script is loaded onto
   * eleven pages that agree about almost nothing else in their markup — and because
   * whatever is underneath it is somebody's work, which a modal would interrupt and this
   * does not.
   */
  function banner(text) {
    let el = document.getElementById('app-update-ask');
    if (!text) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-update-ask';
      el.className = 'app-update-ask';
      document.body.appendChild(el);
    }
    el.innerHTML = `<p>${esc(text)}</p><div class="app-update-row">
      <button data-act="install">Install</button>
      <button data-act="later" class="ghost">Later</button>
    </div>`;
    el.querySelector('[data-act="install"]').addEventListener('click', () => {
      // Asked and answered — no second tap here. Arming exists for the top-bar button,
      // which sits inches from the ⟳ and is pressed by accident; this one was just read.
      state.armed = true;
      install();
    });
    el.querySelector('[data-act="later"]').addEventListener('click', () => {
      state.later = true;
      banner(null);
      render();
    });
  }

  /** Second tap applies it. The first arms, like every other button here that restarts something. */
  function install() {
    const n = native();
    if (!n) return;
    if (state.shell?.phase === 'failed') {
      state.armed = false;
      state.shell = { ...state.shell, phase: 'idle' };
      render();
      return fetchApk();
    }
    if (!state.armed) {
      state.armed = true;
      render();
      return;
    }
    state.armed = false;
    banner(null);
    try {
      n.installUpdate();
      // Nothing after this is guaranteed to run: the installer takes over, and a
      // successful install kills this process. `installing` is what the button says
      // while that is true, and the shell repaints it if the install is declined.
      state.shell = { ...state.shell, phase: 'installing' };
      render();
    } catch (err) {
      state.shell = { ...state.shell, phase: 'failed', error: err.message };
      render();
    }
  }

  /* ------------------------------------------------------------------- the wiring */

  /** Everything the shell says about its own download arrives here. */
  function fromNative(json) {
    let next = null;
    try {
      next = typeof json === 'string' ? JSON.parse(json) : json;
    } catch {
      return;
    }
    if (!next || typeof next !== 'object') return;
    // A new download supersedes whatever the last one was told to say.
    if (next.phase === 'downloading') {
      state.asked = false;
      state.later = false;
    }
    state.shell = next;
    render();
  }

  /**
   * What `/api/update` says now: what the last deploy did to us, and what the APK is.
   *
   * Both halves act. The deploy half is the one that catches the case a live event
   * cannot — a restart that killed the poll the news was going to arrive on — and it is
   * guarded twice: once by the id (never twice for one deploy) and once by the clock (a
   * page younger than the deploy already has the files). See the header.
   */
  async function refresh() {
    let data;
    try {
      data = await api('/api/update');
    } catch {
      // The daemon is restarting, or the tailnet has gone. Both are ordinary a second
      // after a deploy, and both are answered by the next event or the next visit.
      return;
    }
    state.apk = data?.apk || null;
    const d = data?.deploy;
    if (d?.web && !seen(d.id)) {
      const finished = Date.parse(d.at || '');
      // `NaN` — a record with no usable stamp — reads as "older than this page", which is
      // the quiet direction: no reload, and the next deploy has a stamp like every other.
      if (Number.isFinite(finished) && finished > LOADED_AT) reloadFor(d.id);
    }
    fetchApk();
  }

  /**
   * A deploy settled. Two booleans, and an event from a daemon that predates them
   * carries neither — in which case `/api/update` is asked, which is what a client with
   * no event at all does anyway.
   */
  function onDeploy(ev) {
    // Through the same one-per-id door the boot read uses, so an event that arrives and
    // a boot read that finds the same record cannot reload twice between them.
    if (ev.web === true) reloadFor(ev.id);
    if (ev.apk === true) refresh();
    if (ev.web === undefined && ev.apk === undefined) refresh();
  }

  function boot() {
    window.beadcause = window.beadcause || {};
    // The shell calls into this by name from Kotlin (`Updater.report`), so it is part of
    // the bridge's contract in both directions and cannot be renamed on one side.
    window.beadcause.update = { native: fromNative, refresh, state };

    window.beadcause.stream?.listen((events) => {
      for (const ev of events || []) if (ev?.type === 'deploy') onDeploy(ev);
    });

    // A download that was already in flight, or already finished, when this page loaded
    // — which is the ordinary case: a deploy that rebuilds the APK usually moves
    // `public/` too, so the page reloads out from under the download it just started.
    const n = native();
    if (n && typeof n.updateState === 'function') {
      try {
        fromNative(n.updateState());
      } catch {
        /* an older shell with no state to report */
      }
    }
    refresh();

    // The two moments a deferred reload can become due: the caret left the box, and the
    // screen came back. Nothing here polls — a page nobody is touching is a page nobody
    // is typing into, and the next of these arrives within seconds of that being true.
    document.addEventListener('focusout', () => {
      if (state.owed) setTimeout(reloadWhenIdle, 250);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.owed) reloadWhenIdle();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
