/*
  The sign-in screen's own small script.

  Two jobs. It asks the daemon which credentials this install actually has, so the
  page never draws a Google button on a machine where sign-in is not configured — a
  button that leads to a 404 is worse than no button, because the person then has no
  idea which of the two things is broken. And it keeps the token fallback working
  exactly as the old setup dialog did: the token goes into `localStorage` under the
  same key every page reads, and nothing is sent anywhere.

  `next` is carried through in the query string by the redirect in lib/server.js, so a
  notification opened on a locked phone lands on the card it was about rather than on
  the inbox. It is re-checked on the way back out — `startsWith('/')` and not `//` —
  because this page is reached with the credential in hand and is therefore the best
  place in the app to be sent somewhere off it.
*/
(() => {
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);

  const next = (() => {
    const raw = params.get('next') || '/';
    return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  })();

  /** Why the last attempt did not work, in the words of somebody who has to fix it. */
  const REASONS = {
    notallowed: 'That Google account is not on this install’s allowlist. Add it to auth.google.allowed in ~/.config/beadcause/config.json, or use a pairing token.',
    cancelled: 'Sign-in was cancelled at Google.',
    expired: 'That sign-in took too long, or the browser dropped the cookie. Try again.',
    state: 'The sign-in did not match the one this browser started. Try again.',
    nocode: 'Google came back without an authorization code. Try again.',
    exchange: 'Google refused the exchange — the client secret on this Mac may be wrong or rotated. The daemon log has the reason.',
    claims: 'The identity Google returned could not be accepted. The daemon log has the reason.',
    // A session is a row in ~/.config/beadcause/state.json now, so that it can be
    // revoked one device at a time — and a cookie that could not be written down is
    // one the very next request would refuse, so it is not handed out at all.
    nodevice: 'The device list on this Mac could not be written, so no session was issued. The daemon log has the reason.',
    failed: 'Sign-in failed on this Mac. The daemon log has the reason.',
  };

  const err = params.get('error');
  if (err) {
    const el = $('#error');
    el.textContent = REASONS[err] || 'Sign-in did not work. The daemon log has the reason.';
    el.hidden = false;
    // A refusal is the one case where the fallback should be in front of you rather
    // than behind a summary: you are standing at a door that has just said no.
    $('#token-block').open = true;
  }

  $('#google-link').href = `/auth/google?next=${encodeURIComponent(next)}`;

  fetch('/auth/whoami', { headers: { accept: 'application/json' } })
    .then((r) => r.json())
    .then((who) => {
      if (who.google) $('#google').hidden = false;
      else {
        // No Google on this install: the token is not a fallback here, it is the only
        // way in, so it is open and explained rather than folded away.
        $('#token-block').open = true;
        const note = $('#signed-in');
        note.textContent = 'Google sign-in is not configured on this install — a pairing token is the way in.';
        note.hidden = false;
      }
      // Already signed in and looking at a login page: something sent you here, and
      // the useful thing is a way onward rather than a second sign-in.
      if (who.signedIn) {
        const note = $('#signed-in');
        note.innerHTML = `Signed in as <strong></strong>. <a href="${next.replace(/"/g, '&quot;')}">Continue</a> · <a href="/auth/signout">sign out</a>`;
        note.querySelector('strong').textContent = who.email || '';
        note.hidden = false;
      }
    })
    .catch(() => {
      // The daemon is not answering. Say so, and leave the token box available — it is
      // the half that needs no server to fill in.
      const el = $('#error');
      if (!el.hidden) return;
      el.textContent = 'The daemon on this Mac is not answering. It may be restarting.';
      el.hidden = false;
    });

  $('#token-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = $('#token-input').value.trim();
    if (!val) return;
    localStorage.setItem('beadcause.token', val);
    // With `?t=` on the way out, not just in localStorage — otherwise the very next
    // request is a navigation with no credential on it and the page gate sends this
    // browser straight back here, in a loop, with a perfectly good token saved. The
    // server pairs the browser off that parameter and the app strips it from the
    // address bar on load. See PAIR_COOKIE in lib/auth.js.
    const to = new URL(next, location.origin);
    to.searchParams.set('t', val);
    location.assign(to.pathname + to.search + to.hash);
  });
})();
