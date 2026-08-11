#!/usr/bin/env node
//
// Can you say something to a live session from the phone — and go and find it — and is
// the page honest about both?
//
//   node scripts/say-check.mjs [--baseline] [--keep] [--out=DIR]
//
// `/session?pid=…` could show you a session thinking and give you no way to answer it —
// the last dead end in the app, because every other conversation here is one beadcause
// started and therefore owns. The box under the facts is the answer, and what is worth
// testing about it is not that it exists but that it never lies about a message you
// typed on a phone in another room. Three promises, and all three fail silently:
//
//   - **What you type lands, and the reply comes back where you are already looking.**
//     There is no second channel: the transcript pane below the box was already tailing
//     the file the session writes, so the answer arrives on the next poll.
//   - **A session that cannot be spoken to says why, and offers no box at all.** Not a
//     disabled one — a disabled box is an invitation with the door shut, and you write
//     the message anyway. Reach is `pid → controlling tty → the iTerm window showing
//     it`, so a session in Terminal.app or tmux, or one with no terminal at all, is
//     running fine and simply out of reach.
//   - **Nothing typed is lost without being told.** A refusal, a closed window, a
//     dropped connection: the words stay in the box and the reason goes under it. This
//     is the case a reasonable refactor breaks — clearing the box on send is the
//     obvious way to write it, and it only costs you anything on the day the send
//     fails.
//
// Plus the promise that replaced this channel's one surprise. `write text` used to press
// return at the end of a line, so a two-paragraph message went as one line, and the page
// warned you about it twice. It does not reflow any more — the AppleScript pastes the
// text and presses Return once — so what is checked here is the other direction, and it
// is the stricter of the two: the words go on the wire with their newlines intact, and
// nothing on the page claims a flattening that no longer happens. A warning left behind
// after the behaviour it described is a page lying about something it used to be honest
// about.
//
// And then the other half of what you can do to a session from here, which arrived after
// the box and is checked in the same file because it is the same page, the same reach and
// the same kind of promise. The button raises that session's iTerm window on the Mac and
// doubles it, and closing the view puts it back. Three things about it fail silently:
//
//   - **The page must not decide for itself whether the window is up.** The rectangle to
//     restore to is held by the daemon (lib/focus.js), so `focused` comes back with the
//     facts and the button obeys it — a page that kept its own idea would offer to
//     enlarge a window that already was, and the way back would be lost.
//   - **The second tap is a restore, not a second enlarge.** Doubling a doubled window
//     is how a window ends up with no rectangle to go back to.
//   - **Leaving the view puts it back.** Not on a lock — that is the lease's job, and
//     shrinking the window while you walk to the Mac would undo the whole feature — but
//     on a close, which reaches the daemon as a beacon from a page being torn down. That
//     one is checked here because a beacon is the kind of thing that works in every
//     example and not in the document that is actually going away.
//
// The real public/session.js in a headless Chrome the size of a phone, against fixtures
// served from this process — so nothing here touches the daemon, a real session, or an
// actual terminal. The delivery itself (`write text` into iTerm) is the one part no test
// should do: it would type a fixture string into whatever window answered. Everything up
// to the request is here; what happens after it is `messageSession`, and test/session.mjs
// covers the rules it follows.
//
// `--baseline` serves HEAD's copies of session.js and style.css instead of the working
// ones, which is how you prove a failure here is real. On baseline every case below
// fails, because there was no box.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'say-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

// Three sessions, and the pid is what picks between them — the same way the real page
// addresses one, and the reason a pid is the only thing in the URL.
const LIVE = 4242; // busy, in an iTerm window: the box is offered
const NO_TTY = 4243; // alive with no controlling terminal: out of reach, and says so
const DEAD = 999999; // not running at all: a 404 that says it finished

const NOW = new Date().toISOString();
const base = (pid, extra) => ({
  pid,
  sessionId: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
  name: `Demo - sc-1 session ${pid}`,
  cwd: '/Users/demo/projects/demo/.claude/worktrees/a-thing-4e7',
  where: 'a-thing-4e7',
  workspace: 'demo',
  kind: 'claude',
  status: 'busy',
  at: NOW,
  startedAt: NOW,
  ...extra,
});

const SESSIONS = {
  [LIVE]: base(LIVE, { reach: { can: true, tty: '/dev/ttys004', why: null } }),
  [NO_TTY]: base(NO_TTY, {
    status: 'idle',
    reach: { can: false, tty: null, why: 'It has no terminal — nothing on this Mac has an input line for it.' },
  }),
};

const FIRST_LINE = '❯ working on the thing';
// What the session "replies" — appended to the transcript only after a send has been
// accepted, so the reply arriving through the pane rather than through the send's own
// response is a thing this can actually observe.
const REPLY = '● right, doing that now';

/* ------------------------------------------------------------------ server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const committed = (rel) => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });

/** What the fixture does to the next send. Set per case, read once. */
const behave = { mode: 'ok', queued: true };
/** Every send that arrived, so a case can assert what was actually on the wire. */
const received = [];
/**
 * The other half: whether the fixture is holding the live session's window up.
 *
 * Server-side, exactly as the daemon holds it, because that is the thing under test —
 * the page must not decide for itself whether the window is big, or a reload would
 * offer to enlarge one that already is.
 */
const win = { focused: false, mode: 'ok' };
/** Every focus or restore that arrived, including the one a closing page beacons out. */
const asks = [];
/** Flipped once a send is accepted: the session has answered, in the transcript. */
let replied = false;

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (p === '/api/session-log') {
      const pid = Number(url.searchParams.get('pid'));
      const s = SESSIONS[pid];
      if (!s) return json({ error: `no session running as pid ${pid}` }, 404);
      const lines = [FIRST_LINE, ...(replied && pid === LIVE ? [REPLY] : [])];
      return json({ ...s, file: '/tmp/whatever.jsonl', lines, focused: pid === LIVE && win.focused });
    }

    // Raise that session's window on the Mac, or put it back. The real one drives
    // AppleScript; here it only has to remember, which is the whole of what the page
    // is not allowed to do for itself.
    if (p === '/api/session-focus' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const ask = JSON.parse(body || '{}');
        asks.push(ask);
        if (ask.action === 'restore') {
          win.focused = false;
          return json({ ok: true, focused: false, restored: true });
        }
        if (win.mode === 'closed') {
          return json({ error: 'That window has closed — /dev/ttys004 is no longer an iTerm session.' }, 409);
        }
        win.focused = true;
        return json({ ok: true, focused: true });
      });
    }

    if (p === '/api/session-say' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const sent = JSON.parse(body || '{}');
        received.push(sent);
        // Each mode is one of the ways a send can end, and the page has to do something
        // different with the words for every one of them.
        if (behave.mode === 'refuse') {
          return json({ error: SESSIONS[NO_TTY].reach.why, reach: SESSIONS[NO_TTY].reach }, 409);
        }
        if (behave.mode === 'closed') {
          return json({ error: 'That window has closed — /dev/ttys004 is no longer an iTerm session.' }, 409);
        }
        if (behave.mode === 'boom') {
          res.destroy(); // the link died mid-send: the words must not go with it
          return;
        }
        const answer = () => {
          replied = true;
          // Shaped like the real endpoint's answer, which no longer has anything to say
          // about what happened to the text — because nothing happens to it.
          json({ ok: true, sent: sent.text, queued: behave.queued });
        };
        // A send held open on purpose, so the case that types *during* one has a
        // window to type in.
        if (behave.mode === 'hold') return behave.hold.then(answer);
        return answer();
      });
    }

    if (p.startsWith('/api/')) return json({});

    if (BASELINE && (p === '/session.js' || p === '/style.css')) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] });
      return res.end(committed(`public${p}`));
    }

    const rel = p === '/' ? 'index.html' : p === '/session' ? 'session.html' : p.replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------ chrome */

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const p = msg.id != null && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error('could not attach to Chrome'));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

async function launch() {
  const port = 9700 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-say-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw new Error('Chrome never exposed a page target');
  const s = await connect(target.webSocketDebuggerUrl);
  return {
    s,
    close: () => {
      s.close();
      proc.kill();
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Chrome is still letting go of a temp dir */
      }
    },
  };
}

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 120)}`);
  return r.result.value;
};

const waitFor = async (s, expr, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try {
      if (await evalJs(s, expr)) return true;
    } catch {
      /* mid-navigation */
    }
    await sleep(150);
  }
  return false;
};

/* ------------------------------------------------------------------- probe */

// Everything the composer is saying, in one read. `offsetParent` rather than a class
// check for "is the box there": what matters is whether you could type in it, and a box
// hidden by CSS is one you cannot, however present it is in the markup.
const SAY = `(() => {
  const box = document.querySelector('.session-say textarea');
  const send = document.querySelector('.session-say [data-say-send]');
  const t = (sel) => [...document.querySelectorAll(sel)].map((el) => el.textContent.trim()).join(' ');
  const pre = document.querySelector('[data-session-log]');
  return {
    box: !!box && box.offsetParent !== null,
    draft: box ? box.value : null,
    disabled: send ? send.disabled : null,
    hint: t('.say-hint'),
    note: t('.say-note'),
    noteKind: (() => { const n = document.querySelector('.say-note'); return n ? [...n.classList].find((c) => c.startsWith('say-') && c !== 'say-note') || '' : null; })(),
    blocked: t('.say-blocked'),
    log: pre ? pre.textContent : null,
    empty: t('.empty'),
  };
})()`;

// Everything the window button is saying, in one read. Same rule as SAY above:
// `offsetParent` rather than a class check, because what matters is whether a thumb
// could press it.
const WIN = `(() => {
  const b = document.querySelector('.win-btn');
  const row = document.querySelector('.win-block .session-label');
  const t = (sel) => [...document.querySelectorAll(sel)].map((el) => el.textContent.trim()).join(' ');
  return {
    btn: !!b && b.offsetParent !== null,
    label: b ? b.textContent.trim() : null,
    action: b ? b.dataset.focus : null,
    row: row ? row.textContent.replace(/\\s+/g, ' ').trim() : null,
    note: t('.win-block .say-note'),
  };
})()`;

const tapWindow = `(() => {
  const b = document.querySelector('.win-btn');
  if (!b) return false;
  b.click();
  return true;
})()`;

/** Wait for the fixture to have been asked something — the beacon arrives after the page has gone. */
async function asked(action, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (asks.some((a) => a.action === action)) return true;
    await sleep(50);
  }
  return false;
}

/** Put words in the box the way a thumb would: value, then the event the page listens for. */
const type = (text) => `(() => {
  const box = document.querySelector('.session-say textarea');
  if (!box) return false;
  box.focus();
  box.value = ${JSON.stringify(text)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const submit = `(() => {
  const form = document.querySelector('[data-say]');
  if (!form) return false;
  form.requestSubmit();
  return true;
})()`;

// The other way to send, and the one a phone keyboard actually offers. Enter sends,
// shift+Enter is a newline — the bargain the bead console strikes, so this proves the
// two composers have not drifted apart.
const pressEnter = `(() => {
  const box = document.querySelector('.session-say textarea');
  if (!box) return false;
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
})()`;

async function shot(s, name) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
}

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launch();

/** Load one session's page with the token already in localStorage, as a paired phone has. */
async function openSession(pid) {
  await s.send('Page.navigate', { url: `${BASE}/session?pid=${pid}&t=${TOKEN}` });
  await waitFor(s, `!!document.body`);
  await evalJs(s, `localStorage.setItem('beadcause.token', ${JSON.stringify(TOKEN)})`);
  await s.send('Page.reload');
  return waitFor(s, `!!document.querySelector('.session-facts') || !!document.querySelector('.empty strong')`);
}

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
    screenWidth: VP.width,
    screenHeight: VP.height,
  });
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  /* ---- a live session in a window: there is a box, and it says what it will do ---- */

  if (!(await openSession(LIVE))) throw new Error('the session page never rendered');
  await waitFor(s, `!!document.querySelector('.session-say textarea')`, 40);
  let v = await evalJs(s, SAY);
  check('a session in a terminal gets a box to answer it', v.box, v.box ? '' : `no box; blocked said ${JSON.stringify(v.blocked)}`);
  check(
    'and a session mid-turn says the words will wait for the turn to land',
    /mid-turn/i.test(v.hint),
    JSON.stringify(v.hint)
  );
  await shot(s, 'phone-session-say');

  /* ---- what the channel will do to a multi-line message, said before you send ---- */

  await evalJs(s, type('two\n\nparagraphs'));
  await sleep(150);
  v = await evalJs(s, SAY);
  check(
    'a message with a newline says the line breaks are kept, before it goes',
    /kept|line breaks/i.test(v.hint) && !/one line/i.test(v.hint),
    JSON.stringify(v.hint)
  );
  check('and the words survive the repaint that put the hint there', v.draft === 'two\n\nparagraphs', JSON.stringify(v.draft));

  /* ---- the send: what goes on the wire, and the box emptying only then ---- */

  behave.mode = 'ok';
  received.length = 0;
  await evalJs(s, submit);
  await waitFor(s, `(${SAY}).note.length > 0 && !/Sending/.test((${SAY}).note)`, 40);
  v = await evalJs(s, SAY);
  check(
    'sending posts the pid and the text to the daemon',
    received.length === 1 && received[0].pid === LIVE && received[0].text === 'two\n\nparagraphs',
    JSON.stringify(received)
  );
  check(
    'and the newlines are on the wire, not closed up on the way to it',
    received.length === 1 && received[0].text.split('\n').length === 3,
    JSON.stringify(received[0]?.text)
  );
  check('the box empties once the daemon says it delivered', v.draft === '', JSON.stringify(v.draft));
  check(
    'and it says the line breaks went too, rather than warning about a reflow that no longer happens',
    /line breaks/i.test(v.note) && !/one line/i.test(v.note) && v.noteKind !== 'say-warn',
    `${JSON.stringify(v.note)} (${v.noteKind})`
  );
  check(
    'a queued send says the session is holding it, not that it was refused',
    /mid-turn|land/i.test(v.note) && !/refus/i.test(v.note),
    JSON.stringify(v.note)
  );

  /* ---- and the reply comes back through the pane, with no second channel ---- */

  const answered = await waitFor(s, `(${SAY}).log.includes(${JSON.stringify(REPLY)})`, 40);
  v = await evalJs(s, SAY);
  check(
    "the session's reply arrives in the transcript below, where you were already looking",
    answered,
    answered ? '' : `the pane still said ${JSON.stringify((v.log || '').slice(0, 80))}`
  );

  /* ---- the keyboard's own send button ---- */

  received.length = 0;
  await evalJs(s, type('and again'));
  await evalJs(s, pressEnter);
  await waitFor(s, `${received.length} > 0 || (${SAY}).draft === ''`, 30);
  await sleep(250);
  check(
    'Enter sends, the way the keyboard says it will',
    received.length === 1 && received[0].text === 'and again',
    JSON.stringify(received)
  );

  /* ---- typing on while the last one is still going ---- */

  // The composer stays live during a send, which is the right call — a box that shuts
  // while the network thinks is a thought you have to hold in your head. But it means
  // `state.draft` can be the *next* message by the time the first one lands, and
  // clearing the box on success then deletes words that were never sent. Held open here
  // by a send that cannot answer until the fixture is let go.
  let release;
  behave.mode = 'hold';
  behave.hold = new Promise((r) => (release = r));
  received.length = 0;
  await evalJs(s, type('first message'));
  await evalJs(s, submit);
  await waitFor(s, `${received.length} > 0`, 40);
  await evalJs(s, type('second, typed while the first was still going'));
  release();
  await waitFor(s, `/Sent/.test((${SAY}).note)`, 40);
  v = await evalJs(s, SAY);
  check(
    'words typed while a send is in flight are not cleared by it landing',
    v.draft === 'second, typed while the first was still going' && received[0].text === 'first message',
    `${JSON.stringify(v.draft)} · sent ${JSON.stringify(received.map((r) => r.text))}`
  );
  await evalJs(s, type(''));

  /* ---- a refusal: the words stay put, and the reason goes under them ---- */

  behave.mode = 'closed';
  received.length = 0;
  await evalJs(s, type('did that window close'));
  await evalJs(s, submit);
  await waitFor(s, `/closed/i.test((${SAY}).note)`, 40);
  v = await evalJs(s, SAY);
  check(
    'a send the daemon refuses leaves the message exactly where you typed it',
    v.draft === 'did that window close',
    JSON.stringify(v.draft)
  );
  check(
    'and says why, in the colour of something that did not happen',
    /closed/i.test(v.note) && v.noteKind === 'say-bad' && /still here/i.test(v.note),
    `${JSON.stringify(v.note)} (${v.noteKind})`
  );

  /* ---- a dropped link is the same promise, by a different route ---- */

  behave.mode = 'boom';
  await evalJs(s, type('over a bad connection'));
  await evalJs(s, submit);
  await waitFor(s, `/reach the server/i.test((${SAY}).note)`, 40);
  v = await evalJs(s, SAY);
  check(
    'a connection that dies mid-send does not take the words with it',
    v.draft === 'over a bad connection' && /still here/i.test(v.note),
    `${JSON.stringify(v.draft)} · ${JSON.stringify(v.note)}`
  );

  /* ---- a refusal that carries reach shuts the box, rather than offering it again ---- */

  behave.mode = 'refuse';
  await evalJs(s, submit);
  await waitFor(s, `(${SAY}).blocked.length > 0`, 40);
  v = await evalJs(s, SAY);
  check(
    'a stale tab told the session is out of reach takes the box away',
    !v.box && /no terminal/i.test(v.blocked),
    `box ${v.box ? 'still there' : 'gone'}; blocked said ${JSON.stringify(v.blocked)}`
  );

  /* ---- the other half: the button that brings that window to the front ---- */

  behave.mode = 'ok';
  if (!(await openSession(LIVE))) throw new Error('the session page never came back');
  await waitFor(s, `!!document.querySelector('.win-btn')`, 40);
  asks.length = 0;
  let w = await evalJs(s, WIN);
  check(
    'a session in an iTerm window gets a button that brings it up',
    w.btn && w.action === 'focus',
    JSON.stringify(w)
  );

  await evalJs(s, tapWindow);
  await waitFor(s, `(${WIN}).action === 'restore'`, 40);
  w = await evalJs(s, WIN);
  check(
    'tapping it asks the daemon to focus that pid, and nothing else',
    asks.length === 1 && asks[0].pid === LIVE && asks[0].action === 'focus',
    JSON.stringify(asks)
  );
  check('and the button becomes the way back', w.label === 'Put it back', JSON.stringify(w));
  await shot(s, 'phone-session-window-up');

  // The second tap is a restore, not a second enlarge — the daemon is holding the
  // rectangle from before the first one, and asking it to focus again would be asking
  // it to double a doubled window.
  await evalJs(s, tapWindow);
  await waitFor(s, `(${WIN}).action === 'focus'`, 40);
  check(
    'and tapping it again puts the window back rather than doubling it a second time',
    asks.length === 2 && asks[1].action === 'restore',
    JSON.stringify(asks)
  );

  /* ---- the daemon owns whether it is up, so a reload does not offer a second enlarge ---- */

  // Set *after* the page is up, because a reload is itself a close: this page beacons a
  // restore as it goes away, so arranging the fixture before navigating would have the
  // page correctly undo it on the way in. What is under test is that the page follows
  // the daemon — the poll below carries `focused`, and the button has to obey it.
  asks.length = 0;
  if (!(await openSession(LIVE))) throw new Error('the session page never came back');
  await waitFor(s, `!!document.querySelector('.win-btn')`, 40);
  win.focused = true;
  const followed = await waitFor(s, `(${WIN}).action === 'restore'`, 80);
  check(
    'a page told the window is already up offers the way back, not another enlarge',
    followed,
    JSON.stringify(await evalJs(s, WIN))
  );

  /* ---- and closing the view puts it back, which is the half nothing else can do ---- */

  asks.length = 0;
  if (!(await openSession(DEAD))) throw new Error('the page never went away');
  check(
    'leaving the view sends the restore, so a window is never left doubled behind you',
    await asked('restore'),
    JSON.stringify(asks)
  );

  /* ---- a window that closed under the tap: the button stays the enlarge, and says why ---- */

  win.focused = false;
  win.mode = 'closed';
  if (!(await openSession(LIVE))) throw new Error('the session page never came back');
  await waitFor(s, `!!document.querySelector('.win-btn')`, 40);
  await evalJs(s, tapWindow);
  await waitFor(s, `(${WIN}).note.length > 0`, 40);
  w = await evalJs(s, WIN);
  check(
    'a window closed under the tap says so, and the button still offers to bring one up',
    /closed/i.test(w.note) && w.action === 'focus',
    JSON.stringify(w)
  );
  win.mode = 'ok';

  /* ---- a session that was never reachable: the reason, and no box at all ---- */

  if (!(await openSession(NO_TTY))) throw new Error('the unreachable session page never rendered');
  await sleep(400);
  w = await evalJs(s, WIN);
  check(
    'a session with no iTerm window gets no button, and its row says there is none to bring up',
    !w.btn && /no window|none to bring up|isn.t one/i.test(w.row || ''),
    JSON.stringify(w)
  );
  v = await evalJs(s, SAY);
  check(
    'a session with no terminal says why it cannot be spoken to',
    /no terminal/i.test(v.blocked),
    JSON.stringify(v.blocked)
  );
  check(
    'and offers no box rather than a disabled one you would type into anyway',
    !v.box,
    v.box ? 'the box is there' : ''
  );
  await shot(s, 'phone-session-unreachable');

  /* ---- and one that has exited says so, which is a different fact again ---- */

  if (!(await openSession(DEAD))) throw new Error('the dead session page never rendered');
  await sleep(400);
  v = await evalJs(s, SAY);
  check(
    'a session that has finished says so, and has nothing to type into either',
    /finished/i.test(v.empty) && !v.box,
    `${JSON.stringify(v.empty)}${v.box ? ' — with a box under it' : ''}`
  );

  /* ---- the transcript still fits the phone with a composer above it ---- */

  if (!(await openSession(LIVE))) throw new Error('the session page never came back');
  await waitFor(s, `!!document.querySelector('.session-say textarea')`, 40);
  const fit = await evalJs(
    s,
    `(() => {
      const doc = document.documentElement;
      const pre = document.querySelector('[data-session-log]');
      return {
        over: doc.scrollWidth - doc.clientWidth,
        preH: pre ? Math.round(pre.getBoundingClientRect().height) : 0,
        bottom: pre ? Math.round(pre.getBoundingClientRect().bottom) : 0,
        vh: innerHeight,
      };
    })()`
  );
  check('the page does not scroll sideways on a 393px screen', fit.over <= 0, `${fit.over}px over`);
  check(
    'and the transcript still has room to read once the box is above it',
    fit.preH >= 160 && fit.bottom <= fit.vh + 40,
    `${fit.preH}px tall, bottom at ${fit.bottom} of ${fit.vh}`
  );
} finally {
  if (!KEEP) close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
