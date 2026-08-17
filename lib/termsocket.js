import crypto from 'node:crypto';
import { attach, closeTerminal, getTerminal, resize, resumeTerminal, scrollback, summary, terminalsEnabled, writeTo } from './terminal.js';
import { isSecure } from './tls.js';
import { googleAuth, sessionOf } from './auth.js';

/**
 * The wire between the phone's xterm.js and a pty on the Mac.
 *
 * A WebSocket rather than SSE-plus-POST because this is the one thing in beadcause
 * that is genuinely bidirectional and latency-sensitive: every keystroke is a
 * message, and a POST per keystroke would be both slow and absurd.
 *
 * **The token travels as a subprotocol, never in the URL.** `new WebSocket(url,
 * [proto, tok])` is the only way a browser can put a header on a WebSocket
 * handshake — there is no `headers` option — so `Sec-WebSocket-Protocol` is where
 * it has to go. Not the query string: `/doc` already avoids token-in-URL
 * deliberately, and a URL is the thing that ends up in history, in a screenshot,
 * and in every access log between here and there.
 *
 * **A closed socket does not close the terminal.** Attaching and detaching are all
 * that happen here; the pty belongs to lib/terminal.js and outlives every
 * connection. Reconnecting replays the scrollback and carries on. See the header of
 * that file for why this is the central requirement rather than a nicety.
 *
 * **Binary is bytes, text is control.** Output and keystrokes are binary frames,
 * unmodified. JSON only ever carries `resize`, `close` and the opening `hello` —
 * so there is no framing to get wrong on the hot path, and no chance of a pty byte
 * sequence being mistaken for a message.
 */

const PROTOCOL = 'beadcause.term.v1';
const PATH = '/ws/terminal';

/** The subprotocol that carries the shared token. `tok.` because a bare secret in a list is ambiguous. */
const TOKEN_PREFIX = 'tok.';

/** How often to ping, and therefore how quickly a phone that locked its screen stops counting as a viewer. */
const PING_MS = 30000;

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Refuse the upgrade before a WebSocket exists.
 *
 * Plain HTTP, because the client has not been promised a socket yet — a browser
 * reports a failed handshake with a status far more usefully than it reports a
 * socket that opens and immediately closes with a code.
 */
function deny(socket, code, message) {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Wire the terminal socket onto the HTTP servers `listen()` returned.
 *
 * `ws` is imported dynamically and its absence is survivable on purpose: an install
 * that pulls this update and restarts the daemon before running `npm install`
 * should lose the terminal and nothing else, rather than failing to boot and taking
 * the inbox with it.
 *
 * **Behind the router these servers bind loopback only**, so nothing on the tailnet
 * reaches this listener directly and it is bin/router.js that has to tunnel an
 * upgrade to it — which for a while it did not, and the terminal 404'd in the only
 * configuration launchd actually runs. Nothing here changed to fix that and nothing
 * here should: the handshake, the subprotocol and the token check are the same
 * whether the socket arrived over loopback from the router or straight off the
 * tailnet under `npm run start:bare`.
 */
export async function attachTerminalSocket(cfg, servers) {
  if (!terminalsEnabled(cfg)) return null;

  let WebSocketServer;
  try {
    ({ WebSocketServer } = await import('ws'));
  } catch {
    console.warn('[beadcause] terminal disabled — the `ws` package is not installed (npm install)');
    return null;
  }

  const wss = new WebSocketServer({
    noServer: true,
    // Say yes to ours and nothing else. The token subprotocol is never echoed back:
    // the client already knows it, and a response header is one more place for it
    // to be logged.
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
    // Terminal output is small and constant; compression would cost CPU per
    // keystroke to save nothing worth having.
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });

  wss.on('connection', (ws, req, t) => onConnection(cfg, ws, req, t));

  attachUpgrade(cfg, wss, servers);

  // Off `baseUrl` rather than `cfg.host`, so this line names the same origin the phone
  // was given — a `wss://` to the raw address could not present a certificate for
  // itself, and printing one would send anybody debugging the terminal at a URL that
  // cannot work. Falls back to the bound address for callers that have no baseUrl at
  // all, which is every test that attaches a socket to a bare loopback server — and
  // there these servers are the only evidence of what the socket actually speaks.
  const base = cfg.baseUrl || `${servers.some(isSecure) ? 'https' : 'http'}://${cfg.host}:${cfg.port}`;
  // And the scheme comes off that origin, *not* off these servers, because under the
  // router the two disagree by construction: the router terminates TLS and owns the
  // tailnet port, while the backend printing this line binds loopback only — so
  // `isSecure` is false in this process while the phone is on an https page, and the
  // line used to name a `ws://` that cannot connect to the very URL the paragraph
  // above exists to keep printable. The origin is what the client goes on too
  // (public/term.js derives the scheme from `location.protocol`), so going off it is
  // what makes this line the URL the browser will actually dial. Nothing about the
  // handshake changes either way — the token still travels as a subprotocol, and the
  // upgrade is wired onto whatever `listen()` returned, TLS or not.
  const scheme = /^https:/i.test(base) ? 'wss' : 'ws';
  console.log(`[beadcause] terminal    ${base.replace(/^https?/i, scheme)}${PATH}`);
  return wss;
}

/**
 * Wire the same terminal socket onto servers that were bound *later*.
 *
 * There is exactly one late binder and it is the reason this is separate: a tailnet
 * address that was not on this Mac at startup is bound the moment Tailscale comes up
 * (lib/tailnet.js, and `listen` in lib/server.js), which under `npm run start:bare`
 * hands the daemon a socket the terminal has never seen. Calling `attachTerminalSocket`
 * a second time would reach the same place by the wrong road: it builds a **second**
 * `WebSocketServer`, and only the first one is what bin/beadcause.js kept — so a phone
 * attached over the late address would be invisible to `releaseSockets`, survive the
 * `/internal/release` a swap makes, and be cut off as a 1006 mid-keystroke instead of
 * a close frame it can act on. It would also print the startup line twice, at a moment
 * nothing is starting.
 *
 * One `wss`, one client set, one handler — the same shape bin/router.js already uses
 * for its own late bind, where `onUpgrade` is simply added to the new servers.
 */
export function attachUpgrade(cfg, wss, servers) {
  if (!wss) return 0;
  for (const server of servers || []) server.on('upgrade', (req, socket, head) => onUpgrade(cfg, wss, req, socket, head));
  return (servers || []).length;
}

/** The handshake itself, one server's `upgrade` event at a time. */
function onUpgrade(cfg, wss, req, socket, head) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return deny(socket, 400, 'Bad Request');
  }
  if (url.pathname !== PATH) return deny(socket, 404, 'Not Found');

  const offered = String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const supplied = offered.find((p) => p.startsWith(TOKEN_PREFIX))?.slice(TOKEN_PREFIX.length);
  // The same two credentials the HTTP side takes, in the same order — see the gate in
  // lib/server.js. A browser signed in with Google has no token to put in the
  // subprotocol, and the terminal is reached from a page it can only have loaded by
  // being signed in; refusing the upgrade would leave it a page that opens and then
  // never connects, with 1006 as the only clue.
  //
  // The cookie is only consulted when sign-in is configured, and `sessionOf` answers
  // null when it is not — so with Google off this is exactly the token check it has
  // always been.
  const signedIn = googleAuth(cfg) ? Boolean(sessionOf(req)) : false;
  if (!offered.includes(PROTOCOL) || (!timingSafeEqual(supplied, cfg.token) && !signedIn)) {
    return deny(socket, 401, 'Unauthorized');
  }

  const t = getTerminal(url.searchParams.get('id'));

  wss.handleUpgrade(req, socket, head, (ws) => {
    // An unknown id is the one refusal that happens *after* the upgrade, on purpose. A
    // browser cannot see the status of a rejected handshake — it reports the
    // abnormal-closure code 1006, which is exactly what a phone going through a tunnel
    // also produces. Accepting and then closing with a policy code is the only way the
    // client can tell "this terminal has been reaped" from "try again in a second", and
    // the difference is a screen that says so against one that reconnects forever.
    if (!t) return ws.close(1008, 'no such terminal');
    wss.emit('connection', ws, req, t);
  });
}

/**
 * WebSocket close code 1012, "Service Restart" — the one this is for.
 *
 * Registered in RFC 6455's IANA table rather than in the RFC's own list, which is why
 * it looks unfamiliar next to 1000 and 1008. It is exactly right here: the phone is
 * being disconnected because the process behind it is being replaced, and the client's
 * ordinary reconnect is the correct response.
 */
export const CLOSE_SERVICE_RESTART = 1012;

/** After this long, a client that has not answered the close frame is dropped. */
const CLOSE_GRACE_MS = 3000;

/**
 * Close every attached terminal socket, on purpose, because this process is going.
 *
 * Called from the `/internal/release` control path when bin/router.js retires this
 * backend after a swap. The pty is a child of *this* process and cannot outlive it, so
 * the socket cannot be saved — only ended well. 1012 with a reason is a real close
 * frame, which is what makes it different from the alternative: the router draining for
 * a minute and then killing us, which reaches the phone as 1006 mid-keystroke and is
 * indistinguishable from a tunnel.
 *
 * `close()` and not `terminate()`, so the frame is actually delivered — with a grace
 * period, because a phone that has gone quiet must not be able to hold the swap's drain
 * open by never answering.
 */
export function releaseSockets(wss, reason = 'the daemon is being replaced') {
  if (!wss?.clients?.size) return 0;
  let closed = 0;
  for (const ws of wss.clients) {
    if (ws.readyState === ws.CLOSED) continue;
    ws.close(CLOSE_SERVICE_RESTART, reason);
    closed += 1;
    setTimeout(() => {
      if (ws.readyState !== ws.CLOSED) ws.terminate();
    }, CLOSE_GRACE_MS).unref();
  }
  if (closed) console.log(`[beadcause] released ${closed} terminal socket(s) — ${reason}`);
  return closed;
}

function onConnection(cfg, ws, req, t) {
  const say = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  // Someone attaching is the signal that a conversation the last daemon was killed
  // in the middle of is still wanted. Before the hello, so `summary(t)` describes a
  // live terminal rather than an offer the client would have to poll to see taken up.
  const resumed = t.status === 'resumable';
  if (resumed) resumeTerminal(cfg, t);

  // What the client needs before the bytes start: which terminal this is, and
  // whether what follows is history or live. Without the flag a reconnect looks
  // identical to a session that suddenly repeated itself.
  // `resumed` is about THIS attach, not about the record: `terminal.resumedAt` stays
  // set forever afterwards, and a client that read it would announce the restart
  // again on every reconnect for the rest of the session's life.
  say({ type: 'hello', terminal: summary(t), replay: t.bytes > 0, truncated: t.truncated, resumed });

  const history = scrollback(t);
  if (history.length) ws.send(history);
  say({ type: 'ready' });
  if (t.status !== 'live') say({ type: 'exit', code: t.exitCode, signal: t.exitSignal });

  const detach = attach(t.id, (chunk, event) => {
    if (event) return say(event);
    if (ws.readyState !== ws.OPEN) return;
    // A phone on a bad link can buffer faster than it drains. Dropping bytes would
    // corrupt the screen in a way that never repairs itself, so close instead: the
    // client reconnects and gets a clean replay from the ring.
    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      console.warn(`[beadcause] terminal ${t.id}: client too far behind — closing so it can resync`);
      return ws.terminate();
    }
    ws.send(chunk);
  });

  // Liveness. Without it a phone that locked its screen stays counted as a viewer
  // until TCP gives up, which is minutes — and while it is counted, the idle reaper
  // will not touch the terminal it is no longer watching.
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  const beat = setInterval(() => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }, PING_MS);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return void writeTo(t.id, data);
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'input') return void writeTo(t.id, Buffer.from(String(msg.data ?? ''), 'utf8'));
    if (msg.type === 'resize') return void resize(t.id, msg.cols, msg.rows);
    if (msg.type === 'close') {
      closeTerminal(t.id);
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(beat);
    detach?.();
  });
  ws.on('error', () => {
    clearInterval(beat);
    detach?.();
  });
}
