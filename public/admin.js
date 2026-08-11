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

  async function load() {
    try {
      state = await api('/api/admin');
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
      if (observing) observing.hidden = !work.observing;
      if (work.observing) {
        for (const b of out.querySelectorAll('button[data-do]')) b.disabled = true;
      }
    } catch {
      /* The page is still useful without it. */
    }
  }

  /* ---------------------------------------------------------------------- TLS */

  /*
   * HTTPS, as a switch rather than a file on the Mac.
   *
   * The whole feature was previously reachable only by editing `tls.enabled` in
   * ~/.config/beadcause/config.json — on a machine you would have to be sitting at —
   * and it is gated on **HTTPS Certificates** being enabled for the tailnet, which is
   * a setting on Tailscale's website that announces its absence in one sentence in a
   * launchd log. So this card exists to say three things a log cannot: what is being
   * served, what pressing the switch costs, and which of the two failures you are
   * looking at.
   *
   * **The cost is stated before the press, in the button.** Turning HTTPS on moves the
   * origin from `http://100.x.y.z:4318` to `https://<name>.ts.net:4318`, and the token
   * lives in localStorage, which is per-origin — so every paired browser, including
   * the one reading this, is signed out by it. The arm-then-press pattern the kill
   * button uses puts that sentence in the button you are about to press again, and the
   * pairing link and QR appear underneath afterwards. A control that signed you out
   * with no explanation would be worse than no control.
   */
  const tlsOut = document.getElementById('tls');
  const pairingOut = document.getElementById('pairing');

  /** The last `/api/tls` body, and the last press's `did`, which outlives a repaint. */
  let tls = null;
  let tlsDid = null;

  /**
   * The Tailscale HTTPS-certificates page, opened by whatever can best take it here.
   *
   * Three environments, and only one of them has a hand-off worth making:
   *
   * - **A browser on Android** gets an `intent:` URL naming Tailscale's package with
   *   `browser_fallback_url` set to the same page. Chrome resolves it to the app when
   *   the app claims that link and loads the page itself when it does not, so the tap
   *   cannot be dead either way.
   * - **The beadcause app's own WebView** (it stamps `Beadcause/<version>` on the user
   *   agent) gets the plain URL, because MainActivity hands external links to
   *   `Links.open`, which puts an http(s) URL in a Custom Tab — already signed in to
   *   Tailscale — and would silently drop an `intent:` one.
   * - **Everything else** — iOS, the Mac, a desktop browser — gets the plain URL.
   *   Tailscale publishes no documented scheme for reaching a tailnet setting in its
   *   iOS or macOS app, and inventing one would trade a page that opens for a tap that
   *   does nothing.
   */
  function tailscaleHref(url) {
    const ua = navigator.userAgent || '';
    if (!/Android/i.test(ua) || /Beadcause\//.test(ua)) return url;
    const bare = url.replace(/^https?:\/\//, '');
    return `intent://${bare}#Intent;scheme=https;package=com.tailscale.ipn;S.browser_fallback_url=${encodeURIComponent(
      url
    )};end`;
  }

  /** The host of a URL, or the whole string. A hand-set `baseUrl` need not parse, and
   *  a card that throws on one is a blank screen where the switch used to be. */
  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return String(url || '');
    }
  }

  /** How the certificate is doing, in a phrase. */
  function certPhrase(t) {
    if (!t.name) return 'Tailscale has not named this Mac yet — `tailscale status` did not answer.';
    if (!t.have) return `No certificate for ${t.name} yet.`;
    const days = t.daysLeft === null ? 'an unreadable expiry' : `${Math.round(t.daysLeft)} days left`;
    return `Certificate for ${t.name} — ${days}${t.renewing ? ', renewing' : ''}.`;
  }

  /**
   * Why the last fetch failed, in the words that decide what to do about it.
   *
   * `tailnet-https-off` is the whole reason this card exists: `tailscale cert` exits 0
   * and writes nothing when HTTPS Certificates are off for the tailnet, there is
   * nothing the daemon can do about it, and the fix is two taps on a page this screen
   * can link to. Anything else is shown verbatim — a paraphrase of an error nobody has
   * classified is how you lose the one sentence that would have explained it.
   */
  function askFailure(asked) {
    if (!asked || asked.ok) return '';
    if (asked.reason === 'tailnet-https-off') {
      return `<p class="admin-warn"><strong>HTTPS Certificates are off for this tailnet.</strong> Tailscale said:
        “${esc(asked.detail)}”. Turn them on with the button below, then press <strong>Try again</strong> — nothing
        here can do it for you.</p>`;
    }
    if (asked.reason === 'no-tailscale') {
      return `<p class="admin-warn"><strong>No tailscale command on this Mac.</strong> ${esc(asked.detail)}</p>`;
    }
    if (asked.reason === 'no-name') {
      return `<p class="admin-warn"><strong>Tailscale has not named this Mac.</strong> ${esc(asked.detail)} — a
        certificate is for the MagicDNS name, so there is nothing to ask for one for.</p>`;
    }
    return `<p class="admin-warn"><strong>No certificate came back.</strong> ${esc(asked.detail)}</p>`;
  }

  function tlsCard(t) {
    const serving = t.serving;
    const ready = t.enabled && t.have;
    const state3 = serving?.tls
      ? { text: `serving ${serving.name || 'https'}`, tone: 'live' }
      : t.restartNeeded
        ? { text: ready ? 'ready — restart to serve it' : 'restart to stop serving it', tone: 'held' }
        : ready
          ? { text: 'on', tone: 'live' }
          : t.enabled
            ? { text: 'on, no certificate', tone: 'held' }
            : { text: 'off', tone: 'dim' };

    // What the switch costs, said in the button rather than beside it. Only when the
    // origin actually moves: a `baseUrl` you set by hand — a reverse proxy, a real
    // domain — is left alone by the daemon, and warning about a sign-out that will not
    // happen is how a warning stops being read.
    const cost = t.originWillChange
      ? `Tap again — every paired browser signs out (${esc(hostOf(t.wouldServe))} → ${esc(hostOf(t.ifFlipped))})`
      : 'Tap again to confirm';

    const buttons = [];
    if (!t.enabled) {
      buttons.push(
        `<button class="secondary" data-tls="on" data-confirm="${cost}">Turn HTTPS on${
          t.have ? '' : ' — and ask for a certificate'
        }</button>`
      );
    } else {
      if (!t.have) buttons.push(`<button class="primary" data-tls="on">Try again — ask Tailscale for a certificate</button>`);
      buttons.push(`<button class="secondary" data-tls="off" data-confirm="${cost}">Turn HTTPS off</button>`);
    }

    return `<section class="card admin-card">
      <div class="admin-head">
        <h2>HTTPS</h2>
        <span class="admin-state ${state3.tone}">${esc(state3.text)}</span>
      </div>
      <p class="admin-detail">
        ${esc(certPhrase(t))}
        Phones are handed <code>${esc(t.wouldServe)}</code>.
      </p>
      ${
        t.alarming && t.have
          ? `<p class="admin-warn"><strong>This certificate is nearly out.</strong> The daemon renews inside the last
             month; still being this close means the renewal is not working.</p>`
          : ''
      }
      ${askFailure(tlsDid?.asked)}
      ${
        t.restartNeeded
          ? `<p class="admin-warn"><strong>The daemon is still serving the old socket.</strong> TLS is decided when the
             listener is created, so this takes effect on the next restart — the Deploy button for beadcause on the PRs
             screen does one, or on the Mac:<br><code>${esc(t.restartCommand)}</code></p>`
          : ''
      }
      <div class="admin-btns">${buttons.join('')}</div>
      <a class="secondary tls-link" href="${esc(tailscaleHref(t.tailnetHttpsUrl))}" target="_blank" rel="noreferrer noopener">
        Tailscale · HTTPS Certificates ↗
      </a>
      <p class="admin-detail tls-foot">A certificate can only be had if that setting is on for the tailnet. It is not a
        setting on this Mac and nothing here can change it.</p>
    </section>`;
  }

  /**
   * The pairing panel: the link and the code that undo the sign-out.
   *
   * Both, because they answer different phones. The link is one tap for the browser
   * that is reading this — the one that has just been signed out of the origin it is
   * on — and the code is for every other device, which cannot be handed a link at all.
   * It stays on screen until you dismiss it: it holds the token, and a repaint taking
   * it away mid-scan is the one failure that leaves you locked out with the Mac in
   * another room.
   */
  function showPairing(view, did) {
    if (!view?.pairing) return;
    pairingOut.innerHTML = `<section class="card admin-card tls-pairing">
      <div class="admin-head">
        <h2>Pair again</h2>
        <span class="admin-state ${did?.originMoved ? 'held' : 'dim'}">${
          did?.originMoved ? 'the address changed' : 'the address is unchanged'
        }</span>
      </div>
      <p class="admin-detail">${
        did?.originMoved
          ? `Everything paired with <code>${esc(did.from)}</code> is signed out — the token is stored per origin.
             Open the new address here, or scan it on another device.`
          : 'Nothing moved, so nothing was signed out. The code is here anyway.'
      }</p>
      <div class="tls-qr">${view.pairing.qr}</div>
      <div class="admin-btns">
        <a class="primary" href="${esc(view.pairing.url)}">Open ${esc(hostOf(view.pairing.origin))}</a>
        <button class="secondary" data-tls="dismiss">Done</button>
      </div>
    </section>`;
    pairingOut.hidden = false;
  }

  function renderTls() {
    if (!tls) {
      tlsOut.innerHTML = '';
      return;
    }
    disarm();
    tlsOut.innerHTML = tlsCard(tls);
    if (tls.observing) for (const b of tlsOut.querySelectorAll('button[data-tls]')) b.disabled = true;
  }

  /**
   * Press the switch.
   *
   * Deliberately not sharing `press()` above: that one posts to /api/admin and repaints
   * the scope cards, and this one may take a Let's Encrypt round trip, so the button
   * says which of the two waits you are in rather than an anonymous ellipsis.
   */
  async function pressTls(btn) {
    if (busy) return;
    if (btn.dataset.tls === 'dismiss') {
      pairingOut.hidden = true;
      pairingOut.innerHTML = '';
      return;
    }
    if (btn.dataset.confirm && btn.dataset.armed !== 'yes') {
      const was = btn.textContent;
      btn.dataset.armed = 'yes';
      btn.classList.add('armed');
      btn.textContent = btn.dataset.confirm;
      armed = { btn, was, timer: setTimeout(() => disarm(), 6000) };
      return;
    }
    disarm({ keep: btn });

    const on = btn.dataset.tls === 'on';
    busy = true;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = on ? 'Asking Tailscale for a certificate…' : 'Turning HTTPS off…';
    try {
      const r = await api('/api/tls', { method: 'POST', body: JSON.stringify({ enabled: on }) });
      tls = r.view;
      tlsDid = r.did;
      renderTls();
      showPairing(r.view, r.did);
      const bits = [r.did.now ? 'HTTPS on' : 'HTTPS off'];
      if (r.did.asked?.ok) bits.push(r.view.have ? `certificate for ${r.view.name}` : 'certificate ok');
      else if (r.did.asked) bits.push('no certificate — see below');
      if (r.did.originMoved) bits.push(`address is now ${hostOf(r.did.to)}`);
      if (r.view.restartNeeded) bits.push('restart to serve it');
      said.textContent = bits.join(' · ');
      said.hidden = false;
    } catch (err) {
      btn.textContent = `${was} — ${err.message}`;
      btn.disabled = false;
    } finally {
      busy = false;
    }
  }

  tlsOut.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tls]');
    if (btn) pressTls(btn);
  });
  pairingOut.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tls]');
    if (btn) pressTls(btn);
  });

  async function loadTls() {
    try {
      tls = await api('/api/tls');
      renderTls();
    } catch {
      /* The pause controls are the point of this page; a daemon too old to have
         /api/tls draws no card rather than an error where one has never been. */
    }
  }

  refresh?.addEventListener('click', loadTls);
  refresh?.addEventListener('click', load);
  // Not while a press is in flight, and not while a destructive button is armed:
  // either would redraw the button out from under the thumb already moving to it.
  setInterval(() => {
    if (!busy && !armed) load();
    if (!busy && !armed) loadTls();
  }, REFRESH_MS);
  load();
  loadTls();
})();
