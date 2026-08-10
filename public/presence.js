/* Tell the daemon which view this device has open.
 *
 * One file shared by every client page, because the alternative is five slightly
 * different debounces. A page calls `presence.report({...})` whenever its view
 * changes — and it may call it on every render, which is what most of them do: the
 * payload is compared with the last one sent and an identical report costs nothing.
 * That is the property worth keeping. Publishing where you are must never be
 * something a page has to remember to do at exactly the right moment; it only has to
 * be *able* to say where it is, as often as it likes.
 *
 * Nothing here blocks a repaint: the send is debounced, fire-and-forget, and a
 * failure is swallowed. The monitor going blind is not a reason for the phone to
 * stall or to show an error about a feature the person holding it is not using.
 *
 * The monitor loads this too, which took some care: it is the mirror *and*, since it
 * absorbed /sessions, a view worth mirroring. A device that followed another device
 * would list itself, so the two halves that stop it are `notMe` in public/mirror.js —
 * the pane never follows the profile it is drawn on — and `showTab`, which reports
 * `null` while the mirror pane is the one you are looking at.
 */
(() => {
  'use strict';

  const SEND_DEBOUNCE_MS = 250;
  // Well inside the server's 15-minute TTL, and rare enough that a phone left on a
  // card overnight is not a request per minute all night.
  const HEARTBEAT_MS = 45000;

  /**
   * A device is a browser profile, not a person and not a session.
   *
   * Stored rather than derived: the whole point is that the monitor can tell the
   * phone from the tablet across reloads, and anything derived from the user agent
   * cannot tell two phones apart at all.
   */
  const device = (() => {
    let id = localStorage.getItem('beadcause.device');
    if (!id) {
      id = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 12);
      localStorage.setItem('beadcause.device', id);
    }
    return id;
  })();

  /** What the monitor calls it. Guessed once, and overridable by hand. */
  const label = (() => {
    const saved = localStorage.getItem('beadcause.device.label');
    if (saved) return saved;
    const ua = navigator.userAgent;
    const guess = /iPhone/.test(ua)
      ? 'iPhone'
      : /iPad/.test(ua)
        ? 'iPad'
        : /Android/.test(ua)
          ? 'Android'
          : /Macintosh/.test(ua)
            ? 'Mac'
            : 'this device';
    localStorage.setItem('beadcause.device.label', guess);
    return guess;
  })();

  let last = ''; // JSON of the last payload actually sent
  let pending = null; // the payload waiting on the debounce
  let timer = null;
  let current = { view: null };

  const token = () => localStorage.getItem('beadcause.token') || '';

  function send(payload) {
    const body = JSON.stringify({ device, label, ...payload });
    if (body === last) return;
    last = body;
    fetch('/api/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beadcause-token': token() },
      body,
      // So a report made as the tab goes away still leaves.
      keepalive: true,
    }).catch(() => {
      // Offline, or not paired yet. Forget what we claimed to have sent so the next
      // report re-states it rather than being deduped against a send that failed.
      last = '';
    });
  }

  function flush() {
    timer = null;
    if (!pending) return;
    const p = pending;
    pending = null;
    send(p);
  }

  /**
   * Say where this device is.
   *
   * Fields are merged into the running picture, so a page can report its view once
   * and then report only what moved. `view: null` means "not looking at anything" —
   * the record stays, marked idle, rather than vanishing, because a monitor that
   * blanks the moment you glance away is worse than one that says how long ago.
   */
  function report(patch = {}) {
    current = { ...current, ...patch };
    pending = { ...current, hidden: document.visibilityState === 'hidden' };
    if (timer) return;
    timer = setTimeout(flush, SEND_DEBOUNCE_MS);
  }

  /** Stop reporting and drop the record — for a page that is handing over. */
  function forget() {
    clearTimeout(timer);
    timer = null;
    pending = null;
    last = '';
    fetch('/api/presence', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-beadcause-token': token() },
      body: JSON.stringify({ device }),
      keepalive: true,
    }).catch(() => {});
  }

  // A screen that locks or a tab that goes to the background stops being somewhere
  // you are looking, and the mirror should say so at once rather than after the
  // heartbeat it is about to miss.
  document.addEventListener('visibilitychange', () => report({}));

  // The heartbeat exists for the TTL, not for freshness: it repeats what was already
  // sent, so the server stores it and stays quiet. `send` dedupes on the payload,
  // which is why this passes through `last = ''` rather than calling `report`.
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    last = '';
    report({});
  }, HEARTBEAT_MS);

  window.beadcause = window.beadcause || {};
  window.beadcause.presence = { report, forget, device, label };
})();
