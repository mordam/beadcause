import { isGeneratedBaseUrl, reconcileBaseUrl, saveConfig } from './config.js';
import { certificateState, forgetMagicDnsName, obtainCertificate, tlsEnabled, TAILNET_HTTPS_URL } from './tls.js';
import { qrSvg } from './qr.js';

/**
 * HTTPS as a switch on a screen, rather than an edit to a file nobody can reach from
 * a phone.
 *
 * Everything this needs already existed and none of it was reachable. `tls.enabled`
 * lives in `~/.config/beadcause/config.json`; the certificate comes from `tailscale
 * cert`, which needs **HTTPS Certificates** enabled for the tailnet at a URL on
 * Tailscale's website; and when that setting is off the fetch fails with one specific
 * sentence, logged once to launchd and visible nowhere else. So the honest description
 * of the feature before this file was: a setting you cannot see, gated on a setting on
 * a different website, failing in a log you would have to be at the Mac to read.
 *
 * Four things shape it.
 *
 * **Turning it on changes the origin, and that signs every browser out.** The token
 * lives in `localStorage`, which is scoped per origin, and both the scheme and the
 * host move — `http://100.96.105.106:4318` becomes
 * `https://<host>.<tailnet>.ts.net:4318`. Observed for real: a phone that had worked
 * all day asked for a token the moment a certificate arrived. So the control says so
 * *before* it flips, and hands back the new pairing URL and a QR on the other side.
 * A button that logs you out with no explanation is worse than no button.
 *
 * **The failure that matters is not an error.** `tailscale cert` exits 0 and writes
 * nothing when the tailnet has HTTPS Certificates off. There is nothing this code can
 * do about that, and pretending otherwise — a retry, a spinner, "something went
 * wrong" — wastes the one minute in which somebody is willing to go and fix it. That
 * case gets its own sentence and the link, every time.
 *
 * **Nothing here rebinds a socket, and it no longer has to.** TLS still belongs to
 * whichever process owns the port — bin/router.js in the installed configuration — and
 * this is a *backend*, so all it can do is write the setting, fetch the certificate into
 * `~/.config/beadcause/tls/` and move the URL. What changed is what happens next: the
 * process holding the port comes up behind a front that can be given a certificate
 * (`tailnetServer`) and looks for one every minute (`acquireOnce`), so a pair written
 * here is on the socket about a minute later, without a restart. `restartNeeded` is
 * computed from what is live rather than asserted, so it turns itself off when that
 * happens — and stays on for the case it is still true of, which is turning HTTPS
 * *off*: a listener that is already terminating TLS cannot stop without being rebound.
 *
 * **Turning it off keeps the certificate.** The files stay in `~/.config/beadcause/tls`
 * and stay renewable; only the setting moves. Deleting them would make an accidental
 * press cost a Let's Encrypt round trip to undo, and would throw away the one artefact
 * that is slow to get back.
 */

/** What `/api/tls` says a restart is done with. The same line bin/router.js prints. */
export const restartCommand = () => `launchctl kickstart -k gui/${process.getuid?.() ?? 501}/m4m.beadcause`;

/**
 * The URL this daemon would hand a phone, if it were restarted right now.
 *
 * `publicBaseUrl` answers the same question and shells out to `tailscale ip` to do it,
 * which is fine once at startup and not fine behind a screen that polls. Every input
 * here is already in hand: the name and the certificate come from `certificateState`,
 * and the address is `cfg.host`, which *is* the Tailscale IP — it is where
 * `defaults()` got it from.
 *
 * A `baseUrl` this repo did not write is returned untouched, for the reason
 * `reconcileBaseUrl` never moves one: a reverse proxy or a real domain in front of
 * this daemon is a decision somebody made, and TLS on the tailnet address does not
 * change where that points.
 */
export function wouldServe(cfg, state, { enabled = state.enabled } = {}) {
  if (!isGeneratedBaseUrl(cfg.baseUrl)) return String(cfg.baseUrl || '');
  const port = cfg.port || 4318;
  if (enabled && state.have && state.name) return `https://${state.name}:${port}`;
  const host = cfg.host && cfg.host !== '127.0.0.1' ? cfg.host : '127.0.0.1';
  return `http://${host}:${port}`;
}

/** The origin of a URL, or the URL itself when it will not parse. */
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return String(url || '');
  }
};

/**
 * The pairing link and a code for it — the way back in after the origin moves.
 *
 * Held behind a flag rather than always included because the QR is ten kilobytes of
 * SVG and this endpoint is polled: the screen asks for it when it is going to draw it,
 * which is after a switch and when you press "show the pairing code".
 */
export function pairing(cfg, url = cfg.baseUrl) {
  const link = `${url}/?t=${cfg.token}`;
  return { url: link, origin: originOf(url), qr: qrSvg(link) };
}

/**
 * What is true about TLS right now, for a screen to draw without deciding anything.
 *
 * `live` is what the process that owns the port is *actually* serving, which this
 * process usually is not — behind the router the backend binds loopback and speaks
 * plain HTTP by design. The caller passes it in (from the router's own state, or from
 * its own listener under `npm run start:bare`) and `null` means nobody could say. A
 * `null` is drawn as silence rather than as agreement: "restart needed" asserted from
 * a guess would be worse than not saying it.
 */
export function tlsView(cfg, { live = null, withPairing = false } = {}) {
  const state = certificateState(cfg);
  const serve = wouldServe(cfg, state);
  const flipped = wouldServe(cfg, state, { enabled: !state.enabled });

  // What the switch would cost, computed for the direction it is currently pointing —
  // so the button can say it before it is pressed rather than after.
  const originWillChange = originOf(serve) !== originOf(flipped);

  const wants = state.enabled && state.have;
  const restartNeeded =
    live === null ? null : Boolean(live.tls) !== Boolean(wants) || Boolean(wants && live.name && live.name !== state.name);

  return {
    ...state,
    // `enabled` is the setting and `serving` is the socket. They are apart exactly
    // between pressing the switch and restarting the daemon, which is the one window
    // in which this screen is being read for something other than curiosity.
    serving: live === null ? null : { tls: Boolean(live.tls), name: live.name || null, daysLeft: live.daysLeft ?? null },
    baseUrl: String(cfg.baseUrl || ''),
    wouldServe: serve,
    ifFlipped: flipped,
    originWillChange,
    restartNeeded,
    restartCommand: restartCommand(),
    tailnetHttpsUrl: TAILNET_HTTPS_URL,
    ...(withPairing ? { pairing: pairing(cfg, serve) } : {}),
  };
}

/**
 * Press the switch: write the setting, fetch a certificate if one is wanted, and move
 * the URL a phone is handed.
 *
 * Order matters and is the opposite of the obvious one. The setting is written
 * *first*, before the certificate is asked for, so that a fetch which fails because
 * the tailnet has HTTPS Certificates off still leaves the intent recorded — the next
 * restart after somebody turns that on gets a certificate without anybody having to
 * come back here and press this again. lib/tls.js is built for exactly that state: no
 * certificate means plain HTTP and a log line, never a daemon that will not start.
 *
 * `obtain` is injected so this is testable without a tailnet; it defaults to the real
 * asynchronous `tailscale cert`, which is the only kind that may run here — the
 * synchronous one blocks every request, every WebSocket and every terminal in the
 * process for as long as Let's Encrypt takes.
 *
 * Returns `{did, view}`: what happened, and the whole picture afterwards, so one press
 * repaints the screen without a second round trip.
 */
export async function setTls(cfg, { enabled, live = null, obtain = obtainCertificate, log, warn } = {}) {
  const want = Boolean(enabled);
  const was = tlsEnabled(cfg);
  const before = wouldServe(cfg, certificateState(cfg));

  cfg.tls = { ...(cfg.tls || {}), enabled: want };
  saveConfig(cfg);

  // Only ever on the way on. Turning it off leaves the certificate where it is —
  // renewable, and instant to come back to.
  let asked = null;
  if (want) {
    asked = await obtain(cfg, { log, warn });
    // The name that fetch resolved is the freshest anything has; a memo from before it
    // could be a rename old.
    forgetMagicDnsName();
  }

  // The URL a *new* link should use. Persisted, because every short-lived CLI — `--qr`,
  // `beadcause-ask`, the notification bodies — reads it off disk rather than asking.
  reconcileBaseUrl(cfg, { persist: true });

  const view = tlsView(cfg, { live, withPairing: true });
  return {
    did: {
      action: want ? 'enable' : 'disable',
      was,
      now: want,
      asked,
      originMoved: originOf(before) !== originOf(view.wouldServe),
      from: before,
      to: view.wouldServe,
    },
    view,
  };
}
