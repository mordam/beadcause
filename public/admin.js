/* The admin screen — pause all, resume all, and the two halves of that separately.
 *
 * Every other control in beadcause acts on one repo. This page is the only one that
 * acts on all of them at once, which is why it is a page of its own rather than a
 * block at the top of the advocate console: a button that stops everything should not
 * be on a screen you scroll past forty times a day.
 *
 * Two disciplines, both borrowed from the rest of the app and both load-bearing here.
 *
 * **The button says what it will do, with the real number in it.** Not "Pause all" —
 * "Pause 3 advocates · close 2 terminals". The counts come from /api/admin and are
 * recomputed on every repaint, so what the label promises is what the press does. A
 * control whose blast radius you have to guess at is the one you stop trusting.
 *
 * **The destructive one is drawn differently and says so twice.** Draining is the
 * default and is safe: nothing running is touched. Killing sessions mid-work is a
 * separate, red, confirm-first button, because the two differ by "an hour of agent
 * work survives" and nothing on screen should make them look alike.
 */
(() => {
  'use strict';

  /* The same `?t=` pickup /monitor does — this page is opened on the Mac as often
     as on the phone, and that browser profile may never have scanned the QR. */
  const token = (() => {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
      localStorage.setItem('beadcause.token', fromUrl);
      history.replaceState(null, '', location.pathname + location.hash);
    }
    return localStorage.getItem('beadcause.token') || '';
  })();

  /*
    Who got in, and the way back out.

    The only sign-out control in the app, on the only page that is about access to this
    Mac rather than about beads. It draws nothing at all unless a Google session is
    what authorised this browser: on a token-only install there is nothing to sign out
    of, and a dead button saying so would be worse than silence.

    A form POST rather than a link, so the browser's own prefetching can never sign
    somebody out by looking at the page.
  */
  (async () => {
    let who;
    try {
      who = await (await fetch('/auth/whoami', { headers: { accept: 'application/json' } })).json();
    } catch {
      return;
    }
    if (!who.signedIn) return;
    const el = document.getElementById('whoami');
    el.textContent = `Signed in as ${who.email} · `;
    const link = document.createElement('a');
    link.href = '/auth/signout';
    link.textContent = 'sign out';
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/auth/signout', { method: 'POST' }).catch(() => {});
      // Whatever the warm layer is holding stopped being yours the moment you signed
      // out, and the next page load must not paint it back. See public/warm.js.
      window.beadcause?.warm?.forget?.();
      location.assign('/login');
    });
    el.append(link);
    el.hidden = false;
  })();

  const out = document.getElementById('admin');
  const pulse = document.getElementById('pulse');
  const observing = document.getElementById('observing');
  const refresh = document.getElementById('refresh');
  const said = document.getElementById('said');

  /* Nothing here streams and nothing here is expensive — /api/admin reads two
     in-memory structures. Slow enough not to fight your thumb, fast enough that the
     counts on the buttons are the counts you are pressing. */
  const REFRESH_MS = 10000;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  let state = null;
  let busy = false;
  /** The armed destructive button, if one is waiting for its second press. */
  let armed = null;

  /** Put an armed button back the way it was. `keep` is the one about to fire. */
  function disarm({ keep = null } = {}) {
    if (!armed) return;
    clearTimeout(armed.timer);
    if (armed.btn !== keep) {
      armed.btn.textContent = armed.was;
      armed.btn.classList.remove('armed');
    }
    delete armed.btn.dataset.armed;
    armed = null;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        'x-beadcause-token': token,
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  }

  /* -------------------------------------------------------------------- draw */

  /**
   * One scope's card: what it covers, then a row per thing you can pause.
   *
   * A scope with nothing in it is drawn anyway, greyed, rather than hidden. A space
   * you configured and cannot see is indistinguishable from a space you forgot to
   * configure, and this is the screen where you would go looking.
   */
  function card(s) {
    const empty = !s.workspaces.length;
    return `<section class="card admin-card${empty ? ' plain' : ''}">
      <div class="admin-head">
        <h2>${esc(s.label)}</h2>
        <span class="admin-reach">${
          empty ? 'no workspaces' : s.workspaces.map((w) => `<span class="pill id">${esc(w)}</span>`).join('')
        }</span>
      </div>
      ${empty ? '' : advocateRow(s) + terminalRow(s)}
    </section>`;
  }

  /**
   * The advocates half.
   *
   * `workers` is the number the red button acts on and the number the safe button
   * deliberately leaves alone, so it is stated once, plainly, above both.
   */
  function advocateRow(s) {
    const a = s.advocates;
    const runnable = a.total - a.pausedCount;

    /* Every one of these is read off the live roster rather than off a flag this
       page set. The two can disagree — you pause a repo by hand, or you pause a
       space and then resume globally — and when they do it is the roster that is
       true. `ours` is the only number that comes from this page's own record, and
       it is used for exactly one thing: what a resume here would give back. */
    const state3 = !a.total
      ? { text: 'none configured', tone: 'dim' }
      : a.pausedCount === a.total
        ? { text: 'all paused', tone: 'held' }
        : a.pausedCount
          ? { text: `${a.pausedCount} of ${a.total} paused`, tone: 'held' }
          : { text: 'running', tone: 'live' };

    const detail = a.total
      ? `${plural(a.total, 'advocate')} · ${plural(a.workers, 'session')} running on the Mac`
      : 'No advocates reach this scope.';

    return `<div class="admin-row">
      <div class="admin-row-head">
        <span class="admin-what">Advocates</span>
        <span class="admin-state ${state3.tone}">${esc(state3.text)}</span>
      </div>
      <p class="admin-detail">${esc(detail)}</p>
      <div class="admin-btns">
        ${
          a.ours
            ? `<button class="primary" data-do="resume" data-what="advocates" data-scope="${esc(
                s.id
              )}">Resume ${plural(a.ours, 'advocate')}</button>`
            : ''
        }
        ${
          runnable
            ? `<button class="secondary" data-do="pause" data-what="advocates" data-scope="${esc(
                s.id
              )}">Pause — stop ${plural(runnable, 'advocate')} launching</button>`
            : ''
        }
        ${
          // Nothing to press. Say which of the two reasons it is, rather than
          // showing a disabled button that could be either.
          !a.ours && !runnable
            ? `<span class="admin-detail">${a.total ? 'All paused, none of them by this page.' : 'Nothing to pause.'}</span>`
            : ''
        }
      </div>
      ${
        a.workers
          ? `<button class="danger-btn admin-kill" data-do="pause" data-what="advocates" data-mode="kill" data-scope="${esc(
              s.id
            )}" data-confirm="Tap again to stop ${plural(a.workers, 'session')} — work in progress is lost">
              Pause and stop ${plural(a.workers, 'running session')} now
            </button>
            <p class="admin-warn">Stopping ends each session mid-edit. Draining, above, lets them finish.</p>`
          : ''
      }
    </div>`;
  }

  /** The in-app terminals half — separately pausable, because closing the phone's
   *  ptys and stopping the Mac's windows are different wants. */
  function terminalRow(s) {
    const t = s.terminals;
    return `<div class="admin-row">
      <div class="admin-row-head">
        <span class="admin-what">In-app terminals</span>
        <span class="admin-state ${t.closed ? 'held' : t.live ? 'live' : 'dim'}">${
          t.closed ? `${plural(t.closed, 'paused')}` : t.live ? `${plural(t.live, 'open')}` : 'none open'
        }</span>
      </div>
      <p class="admin-detail">${
        t.closed
          ? `${plural(t.closed, 'terminal')} paused — resuming continues the same conversation`
          : t.live
            ? 'The ptys on your phone. Pausing them ends nothing on the Mac.'
            : 'Nothing to pause, nothing waiting to come back.'
      }</p>
      ${
        t.live || t.closed
          ? `<div class="admin-btns">
        ${
          t.closed
            ? `<button class="primary" data-do="resume" data-what="terminals" data-scope="${esc(s.id)}">Resume ${plural(
                t.closed,
                'terminal'
              )}</button>`
            : ''
        }
        ${
          t.live
            ? `<button class="secondary" data-do="pause" data-what="terminals" data-scope="${esc(
                s.id
              )}">Pause ${plural(t.live, 'terminal')}</button>`
            : ''
        }
      </div>`
          : ''
      }
      ${
        t.closed && state?.reopenIsFresh
          ? `<p class="admin-warn">Reopening starts a <strong>new</strong> conversation in the same
             directory — the one you were talking to is not resumed.</p>`
          : ''
      }
    </div>`;
  }

  function render() {
    // A body without `scopes` is a daemon older than this page — the installed
    // Android build and a cached service worker both outlive a deploy. Say so
    // rather than throwing, which would leave a blank screen and no reason for it.
    if (!state?.scopes?.length) {
      out.innerHTML = `<div class="empty">${
        state ? 'This daemon has no admin controls — it is running an older build.' : 'Asking the daemon…'
      }</div>`;
      return;
    }
    // The armed button is about to be replaced by a fresh one, so drop the arm
    // rather than leaving `armed` pointing at a node that is no longer on the page.
    disarm();
    out.innerHTML = state.scopes.map(card).join('');
  }

  /* ------------------------------------------------------------------ acting */

  /**
   * Press a button.
   *
   * The outcome is written back into the button rather than toasted away: this is a
   * control that changes what the Mac does next, and "did that work?" must not be a
   * question you have to answer by watching iTerm.
   */
  async function press(btn) {
    if (busy) return;

    /* The destructive one arms rather than prompting. Nothing else in this app
       opens a native dialog, and a `confirm()` on the phone is a system sheet over
       a web view that you dismiss by reflex — which is the opposite of a second
       thought. Arming puts the consequence in the button you are about to press
       again, and disarms itself if you walk away. */
    if (btn.dataset.confirm && btn.dataset.armed !== 'yes') {
      const was = btn.textContent;
      btn.dataset.armed = 'yes';
      btn.classList.add('armed');
      btn.textContent = btn.dataset.confirm;
      armed = { btn, was, timer: setTimeout(() => disarm(), 6000) };
      return;
    }
    disarm({ keep: btn });

    busy = true;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const r = await api('/api/admin', {
        method: 'POST',
        body: JSON.stringify({
          action: btn.dataset.do,
          what: btn.dataset.what,
          scope: btn.dataset.scope,
          mode: btn.dataset.mode || 'drain',
        }),
      });
      state = r.status;
      render();
      report(r.did);
    } catch (err) {
      btn.textContent = `${was} — ${err.message}`;
      btn.disabled = false;
    } finally {
      busy = false;
    }
  }

  /**
   * What actually happened, in the numbers the daemon came back with rather than
   * the ones the label predicted. They differ exactly when it matters: a terminal
   * that would not reopen because the cap was full, a worker that had already gone.
   */
  function report(did) {
    const bits = [];
    if (did.paused?.length) bits.push(`paused ${plural(did.paused.length, 'advocate')}`);
    if (did.resumed?.length) bits.push(`resumed ${plural(did.resumed.length, 'advocate')}`);
    if (did.killed?.length) bits.push(`stopped ${plural(did.killed.length, 'session')}`);
    if (did.closed?.length) bits.push(`paused ${plural(did.closed.length, 'terminal')}`);
    if (did.opened?.length) bits.push(`resumed ${plural(did.opened.length, 'terminal')}`);
    // Worth saying out loud and separately: these came back as new conversations
    // because their records were gone, not as the sessions you were talking to.
    if (did.fresh?.length) bits.push(`${plural(did.fresh.length, 'terminal')} came back fresh`);
    if (did.failed?.length) bits.push(`${did.failed.length} could not come back — ${did.failed[0].error}`);
    if (!bits.length) bits.push('nothing to do');

    said.textContent = bits.join(' · ');
    said.hidden = false;
  }

  /* ------------------------------------------------------------------- wiring */

  out.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-do]');
    if (btn) press(btn);
  });

  /**
   * Draw the switches this tab had last time, before anything has been asked for.
   *
   * The one page you open *because* something needs stopping now — which is exactly
   * the moment the link is worst. sw.js already puts the shell on screen instantly
   * for that reason; this is the other half, so what arrives with it is the switches
   * and not a spinner over them. See public/warm.js.
   */
  function warmBoot() {
    const warm = window.beadcause?.warm;
    const hit = warm?.read?.('/api/admin');
    if (!hit?.data) return false;
    state = hit.data;
    render();
    // Held rather than fetched, and only to grey the buttons out. Absent is not
    // "not an observer" — it is "we do not know yet", and the fetch behind this
    // settles it either way a moment later.
    const work = warm.read('/api/work');
    if (work?.data && observing) observing.hidden = !work.data.observing;
    return true;
  }

  async function load() {
    const warm = window.beadcause?.warm;
    try {
      state = await api('/api/admin');
      warm?.write?.('/api/admin', state);
      pulse?.classList.remove('bad');
      render();
    } catch (err) {
      pulse?.classList.add('bad');
      if (!state) out.innerHTML = `<div class="empty">Cannot reach the daemon — ${esc(err.message)}</div>`;
    }
    // An observer may look at this page and may not act on it. The badge is the
    // same one /monitor shows, for the same reason: which daemon this is.
    try {
      const work = await api('/api/work');
      warm?.write?.('/api/work', work);
      if (observing) observing.hidden = !work.observing;
      if (work.observing) {
        for (const b of out.querySelectorAll('button[data-do]')) b.disabled = true;
      }
      // Both requests came back, so the credential is good: the moment it is safe to
      // go and warm the other four tabs. Once per document — see public/warm.js.
      warm?.prewarm?.({ here: 'admin', api });
    } catch {
      /* The page is still useful without it. */
    }
  }

  refresh?.addEventListener('click', load);
  // Not while a press is in flight, and not while a destructive button is armed:
  // either would redraw the button out from under the thumb already moving to it.
  setInterval(() => {
    if (!busy && !armed) load();
  }, REFRESH_MS);
  warmBoot();
  load();
})();
