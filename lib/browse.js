/**
 * Reading a page that only exists after its JavaScript has run.
 *
 * `lib/lookup.js` covers the two shapes that were worth having first: `WebFetch` for a
 * page as prose, `beadcause-get` for the bytes as served. Between them they answer most
 * questions, and both of them see exactly what the server sent. Neither can read a page
 * whose content is assembled in the browser — a docs site that ships an empty `<div id=
 * "root">`, a table rendered from a JSON payload, a spec viewer that is a single-page
 * app. Against those, both existing shapes return something that looks like an answer
 * and is a shell, which is worse than a refusal because nothing on the page says so.
 *
 * So this is the third shape, and it is the one Adam ruled on directly (bc-awr,
 * 2026-08-10):
 *
 * > **browsing is headless Chrome, not the claude-in-chrome extension.** Agents do not
 * > drive the live logged-in browser.
 *
 * **Why the ruling is the whole design and not a preference.** The objection to the
 * extension was never browsing. It is that the extension drives the Chrome Adam is
 * signed into — an agent holding it acts as him on every site with a live session, and
 * the per-site permission prompt that is supposed to bound that has nobody present to
 * answer it at three in the morning, which is when these agents run. A Chrome launched
 * here has a `--user-data-dir` made by `mkdtemp` a few milliseconds earlier and deleted
 * when the run ends. It has no cookies, no saved passwords, no extensions, no history
 * and no identity. It is the same capability with none of the authority, which is why
 * `assertThrowawayProfile` below is not a tidiness check: it is the ruling, in code, on
 * the one line where it could be violated.
 *
 * **What is deliberately missing.** There is no way to ask this to run JavaScript of the
 * agent's choosing, no way to click, type, submit or log in, and no way to name an
 * output file. It navigates to one URL, waits, and reads back the rendered text or the
 * DOM. That is the same argument `bin/beadcause-get` makes about curl one module over:
 * a browser is an enormous binary, and the grant should be the narrow thing the job
 * needs rather than the verb that happens to contain it. `Runtime.evaluate` is used
 * three times in this file and each expression is written *here*, in source.
 *
 * **Every request the page makes is vetted, not just the one that was typed.** A page
 * chooses its own subresources, and this machine answers on loopback with things it
 * would not answer a stranger with — the beadcause daemon's own API, another agent's
 * CDP endpoint, whatever else is bound on a developer's laptop. `Fetch.requestPaused`
 * puts `allowSubresource` in front of all of them. Same honest limit `lib/lookup.js`
 * records for itself: this is a guard against accident and obvious misuse, not a
 * hardened SSRF barrier, because a public hostname that resolves to `127.0.0.1` is
 * resolved inside Chrome where this cannot see it.
 *
 * **Traps carried over from the sophab recipe**, each of which cost a run there:
 *
 * - A reused profile serves cached HTML, and `Network.setCacheDisabled` alone was not
 *   enough (verified 2026-08-01). A fresh profile per run fixes it — the same decision
 *   the security rule above already forces, which is the happy case of one choice
 *   satisfying two arguments.
 * - `Runtime.evaluate` has no top-level `await`. Only a trailing *expression* returns a
 *   value, so a statement list needs an IIFE.
 * - `--disable-gpu` means no WebGL, and anything WebGL-drawn photographs black. `--webgl`
 *   swaps in the swiftshader flags and a much longer settle, because software rendering
 *   is slow.
 *
 * And it is bounded in four places, because nobody is present to notice a hang: a
 * whole-operation deadline, a cap on the characters brought back (applied *inside the
 * page*, so a 50 MB document is never serialised across the wire), a cap on how long
 * the launch may take, and a `finally` that kills Chrome and deletes the profile on
 * every path out — including the ones that throw.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vetUrl, LookupError } from './lookup.js';

/** The text cap, in characters. A long spec page; not a memory event. */
export const DEFAULT_MAX_CHARS = 200_000;
/** The ceiling `--max-chars` cannot argue its way past. */
export const HARD_MAX_CHARS = 2_000_000;
/** The default whole-operation deadline: launch, navigate, settle and read. */
export const DEFAULT_TIMEOUT_MS = 45_000;
/** The ceiling `--timeout` cannot argue its way past. */
export const HARD_MAX_TIMEOUT_MS = 180_000;
/** How long to keep rendering after `load` fires, for the app to fetch and draw. */
export const DEFAULT_SETTLE_MS = 1500;
/** The same, when software WebGL is in play — swiftshader needs most of ten seconds. */
export const WEBGL_SETTLE_MS = 9000;
/** How long Chrome gets to come up and publish a debugging port before it is a failure. */
export const LAUNCH_TIMEOUT_MS = 30_000;

/** Every temp profile this module makes starts with this, and nothing else may be used. */
export const PROFILE_PREFIX = 'beadcause-browse-';

/**
 * A refusal or a failure, told apart by `code` — the same split `LookupError` draws.
 *
 * "The wrapper would not do that" is a thing to argue with. "Chrome is not installed" is
 * a thing to fix. "The page never loaded" is a thing to retry. Whoever reads the log
 * afterwards is usually deciding which of those three happened.
 */
export class BrowseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowseError';
    this.code = code;
  }
}

/**
 * Where Chrome lives, in the order worth trying.
 *
 * `CHROME_PATH` first, because the honest answer to "it moved" is to let the caller say
 * where it went rather than to ship a browser. The list is `scripts/shot.mjs`'s, which
 * has been finding Chrome on this machine for months.
 */
export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/opt/homebrew/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** The first candidate that exists, or null. */
export const findChrome = () => CHROME_CANDIDATES.find((c) => fs.existsSync(c)) || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Refuse to launch against anything but a throwaway profile.
 *
 * This is the ruling on bc-awr expressed as an assertion, and it sits between the
 * argument and the `spawn` because that is the only place the argument can actually be
 * lost. The failure it exists for is not malice — it is a future change that wants to
 * "reuse a warm profile so pages load faster", which is a reasonable-sounding
 * optimisation that hands an unattended agent Adam's logged-in sessions, and which no
 * diff review reliably catches because the diff is one string.
 *
 * Two conditions, and both matter. Under the system temp directory, so it cannot be
 * `~/Library/Application Support/Google/Chrome`; and carrying `PROFILE_PREFIX`, so it
 * cannot be some other tool's directory that happens to live in `/tmp`.
 */
export function assertThrowawayProfile(dir) {
  const resolved = path.resolve(String(dir || ''));
  const tmp = fs.realpathSync(os.tmpdir());
  const real = (() => {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved; // not created yet; the prefix check below still applies
    }
  })();
  const inTmp = real === tmp || real.startsWith(tmp + path.sep);
  if (!inTmp || !path.basename(real).startsWith(PROFILE_PREFIX)) {
    throw new BrowseError(
      'profile',
      `refusing to drive Chrome with the profile at ${resolved}. Agents get a throwaway ` +
        `--user-data-dir under ${tmp} and nothing else — a real profile carries the ` +
        `cookies, sessions and extensions of whoever is signed in (bc-awr).`,
    );
  }
  return real;
}

/** Make one, and hand back its path. The only profile this module will ever launch on. */
export const makeProfile = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), PROFILE_PREFIX));

/**
 * The command line, as one function, so a test can read it without launching anything.
 *
 * `--remote-debugging-port=0` rather than a number picked from the pid: Chrome writes
 * the port it actually got into `DevToolsActivePort` in the profile, so concurrent
 * agents cannot collide, and nothing here binds a port another process could guess and
 * connect to. (`lib/lookup.js` refuses loopback partly because a CDP endpoint will open
 * a tab for anyone who asks; not publishing a predictable one is the other half.)
 */
export function chromeArgs({ profile, webgl = false } = {}) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    // A fresh profile means Chrome would otherwise do its first-run dance, and an
    // unattended run has nobody to dismiss it.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    // Not a performance flag. `--headless=new` still supports extensions, and the whole
    // point of the ruling is that no extension of Adam's is in the loop here.
    '--disable-sync',
    '--disable-background-networking',
    // Offscreen renderers are throttled to about a frame a second otherwise, which is
    // enough to read back a half-drawn page and call it the answer.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--hide-scrollbars',
    ...(webgl
      ? // Real WebGL in software. `--disable-gpu` is what makes a canvas photograph
        // black, so it is the flag that comes *out* here rather than one that is added.
        ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
      : ['--disable-gpu']),
    'about:blank',
  ];
}

/** Loopback, by name or by literal address — the only thing `allowLocal` opens up. */
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[?::1\]?)$/i;

/**
 * May the page fetch this?
 *
 * Split from `vetUrl` because a subresource is not a URL somebody typed. Inline data and
 * blobs are how a page ships its own images and workers and are no reach at all, so
 * refusing them would break ordinary pages for nothing. `file:` is refused outright: a
 * page reading local files is the thing a network grant must not turn into. Everything
 * over http/https gets the scrutiny the typed URL got.
 *
 * **`allowLocal` here means loopback and nothing else**, which is narrower than
 * `vetUrl`'s version of the same flag. The suite needs it because its fixture server is
 * on `127.0.0.1` and there is nowhere else to serve a page from offline; it does not
 * need `10/8`, `192.168/16` or `169.254.169.254`, and the difference is the whole of
 * what an escape hatch left one notch too wide would have cost. It also leaves the live
 * test able to prove the interception works at all — a fixture page reaching for the
 * cloud-metadata address is refused with the flag on, which is an assertion that could
 * not exist if the flag opened every private range.
 */
export function allowSubresource(raw, { allowLocal = false } = {}) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { ok: false, why: 'not a URL' };
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return { ok: true };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, why: `${u.protocol} is not http or https` };
  }
  if (allowLocal && LOOPBACK.test(u.hostname)) return { ok: true };
  try {
    vetUrl(u.href, { allowLocal: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err instanceof LookupError ? err.message : String(err?.message || err) };
  }
}

/* ---------------------------------------------------------------- the transport */

/**
 * A CDP session over Node's global WebSocket.
 *
 * Same shape `scripts/shot.mjs` and the two dozen `scripts/*-check.mjs` already use, so
 * this adds no dependency and no downloaded browser. Kept private: the point of this
 * module is that the surface an agent reaches is `browse()`, not a protocol.
 */
function connect(url, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* never opened */
      }
      reject(new BrowseError('launch', 'Chrome never accepted a DevTools connection'));
    }, timeoutMs);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.method) {
        for (const fn of listeners) fn(msg.method, msg.params);
        return;
      }
      const p = msg.id != null && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new BrowseError('protocol', msg.error.message)) : p.resolve(msg.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new BrowseError('launch', 'could not attach to Chrome'));
    };
    ws.onclose = () => {
      // Every outstanding call has to be failed, or a `send` awaiting a browser that
      // just died hangs until the whole-operation deadline — which is a 45-second wait
      // to be told something that was knowable immediately.
      for (const p of pending.values()) p.reject(new BrowseError('protocol', 'Chrome closed the connection'));
      pending.clear();
    };
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        on: (fn) => listeners.push(fn),
        close: () => {
          try {
            ws.close();
          } catch {
            /* already gone */
          }
        },
      });
    };
  });
}

/** The port Chrome chose, read from the profile it wrote it into. */
async function activePort(profile, deadline) {
  const file = path.join(profile, 'DevToolsActivePort');
  for (;;) {
    try {
      const first = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
      if (first) return Number(first);
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) throw new BrowseError('launch', 'Chrome never published a debugging port');
    await sleep(100);
  }
}

/**
 * Delete the profile, and say honestly whether it went.
 *
 * Chrome holds files in it for a moment after the process dies, so a single `rmSync`
 * loses the race often enough to matter. Retried, then reported rather than asserted:
 * `browse()` returns `profileRemoved`, and the command prints a warning if it is false.
 * A cleanup that quietly failed and said nothing is how a machine accumulates a hundred
 * profile directories nobody knows the origin of.
 */
async function removeProfile(profile) {
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* still letting go */
    }
    if (!fs.existsSync(profile)) return true;
    await sleep(150);
  }
  return !fs.existsSync(profile);
}

/* --------------------------------------------------------------------- the run */

/**
 * Open one URL in a throwaway headless Chrome and read back what it rendered.
 *
 * Returns `{ url, requestedUrl, title, text, isHtml, chars, truncated, shot, problems,
 * blocked, profileRemoved }`. `url` is where the browser ended up, which is the one
 * worth citing.
 *
 * `allowLocal` exists for the test suite, which has to serve itself something on
 * loopback to have anything to render. There is deliberately **no flag on the command
 * that sets it** — an escape hatch an agent can type is not a guard. Same arrangement,
 * and same reasoning, as `lib/lookup.js`.
 */
export async function browse(raw, opts = {}) {
  const allowLocal = opts.allowLocal === true;
  const webgl = opts.webgl === true;
  const wantHtml = opts.html === true;
  const maxChars = Math.max(1, Math.min(Number(opts.maxChars) || DEFAULT_MAX_CHARS, HARD_MAX_CHARS));
  const timeoutMs = Math.max(5000, Math.min(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS));
  const settleMs = Math.max(0, Number.isFinite(Number(opts.settleMs)) && opts.settleMs != null ? Number(opts.settleMs) : webgl ? WEBGL_SETTLE_MS : DEFAULT_SETTLE_MS);
  const waitFor = opts.waitFor ? String(opts.waitFor) : null;
  const shotPath = opts.shotPath ? String(opts.shotPath) : null;
  const viewport = opts.viewport || { width: 1280, height: 900, dpr: 1 };

  // Vetted before anything is launched: an argument about a `file://` URL should not
  // cost a browser start-up, and a refusal reads better without one in the log.
  const url = vetUrl(raw, { allowLocal });

  const chrome = findChrome();
  if (!chrome) {
    throw new BrowseError(
      'no-chrome',
      `no Chrome on this machine. Looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`,
    );
  }

  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());
  const profile = assertThrowawayProfile(makeProfile());

  const proc = spawn(chrome, chromeArgs({ profile, webgl }), { stdio: 'ignore' });
  let session = null;
  const out = {
    requestedUrl: url.href,
    url: url.href,
    // The profile this run actually used, reported rather than merely promised. It is
    // one short string and it is the single field that answers "which browser was
    // driven?" from outside — which is the question bc-awr was decided on, so a test can
    // assert the answer dynamically instead of trusting a comment.
    profile,
    title: '',
    text: '',
    chars: 0,
    truncated: false,
    shot: null,
    problems: [],
    blocked: [],
    profileRemoved: false,
  };

  try {
    const port = await activePort(profile, Math.min(deadline, Date.now() + LAUNCH_TIMEOUT_MS));

    // `/json/list` on the loopback port Chrome just told us about. Not a fetch an agent
    // chose — the address came from a file this process wrote the path of.
    let target = null;
    for (;;) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch {
        /* not up yet */
      }
      if (target) break;
      if (!left()) throw new BrowseError('launch', 'Chrome never exposed a page target');
      await sleep(150);
    }

    session = await connect(target.webSocketDebuggerUrl, { timeoutMs: Math.max(1000, Math.min(left(), 15_000)) });

    /* ------------------------------------------------------------ what went wrong */

    // Deduped by text: one broken fetch inside a render loop says the same thing forty
    // times, and a wall of it buries the other three problems. Same trick as shot.mjs.
    const seen = new Map();
    const note = (kind, text) => {
      if (!text) return;
      const key = `${kind} ${text}`;
      seen.set(key, { kind, text, n: (seen.get(key)?.n || 0) + 1 });
    };
    let docFailed = null;

    session.on((method, p) => {
      if (method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails || {};
        note('pageerror', (d.exception?.description || d.text || 'uncaught exception').split('\n')[0].slice(0, 200));
      } else if (method === 'Network.loadingFailed') {
        if (!p.canceled) {
          note('request failed', `${p.errorText} (${p.type || 'request'})`);
          if (p.type === 'Document') docFailed = p.errorText;
        }
      } else if (method === 'Network.responseReceived' && p.response.status >= 400) {
        note('http', `${p.response.status} ${p.response.url.slice(0, 120)}`);
      }
    });

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    // Belt as well as braces on the cache trap: the fresh profile is what actually fixes
    // it, and this costs nothing and means a page fetched twice in one run is fetched
    // twice.
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr || 1,
      mobile: false,
    });

    /* ------------------------------------------ every request the page tries to make */

    const blocked = new Map();
    session.on(async (method, p) => {
      if (method !== 'Fetch.requestPaused') return;
      const verdict = allowSubresource(p.request.url, { allowLocal });
      try {
        if (verdict.ok) {
          await session.send('Fetch.continueRequest', { requestId: p.requestId });
        } else {
          const key = `${p.request.url.slice(0, 160)} — ${verdict.why}`;
          blocked.set(key, (blocked.get(key) || 0) + 1);
          await session.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'AccessDenied' });
        }
      } catch {
        // The request went away, or Chrome did. Neither is worth failing the read over.
      }
    });
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

    /* ------------------------------------------------------------------ navigate */

    let onLoad;
    const loaded = new Promise((resolve) => {
      onLoad = resolve;
    });
    session.on((method) => {
      if (method === 'Page.loadEventFired') onLoad(true);
    });

    const nav = await session.send('Page.navigate', { url: url.href });
    if (nav.errorText) throw new BrowseError('navigate', `${url.href}: ${nav.errorText}`);

    // `load`, never an idle network — a page holding a WebSocket open is never idle, and
    // an idle-wait times out on every page that rendered perfectly. Raced against what
    // is left of the deadline, so a page that never fires `load` still yields whatever
    // it did manage rather than nothing at all.
    await Promise.race([loaded, sleep(Math.max(0, left() - 2000))]);

    if (waitFor) {
      // A selector, passed as data through `JSON.stringify` — the agent may say *what to
      // wait for* and cannot say *what to run*, which is the same line the rest of this
      // module draws.
      let found = false;
      while (!found && left() > 2000) {
        const r = await session.send('Runtime.evaluate', {
          expression: `!!document.querySelector(${JSON.stringify(waitFor)})`,
          returnByValue: true,
        });
        found = r.result.value === true;
        if (!found) await sleep(200);
      }
      if (!found) note('wait', `--wait ${waitFor} never appeared`);
    }

    await sleep(Math.min(settleMs, Math.max(0, left() - 2000)));

    /* --------------------------------------------------------------------- read */

    // The cap is applied *inside the page*. A 50 MB document read whole and then sliced
    // is 50 MB across the wire and through this process's heap first, which is the hang
    // the cap exists to prevent rather than a smaller version of it. `+1` so the
    // truncation is detectable without a second read.
    const expr = wantHtml
      ? `(() => { const s = document.documentElement ? document.documentElement.outerHTML : ''; return { t: document.title, u: location.href, n: s.length, s: s.slice(0, ${maxChars + 1}) }; })()`
      : `(() => { const s = (document.body && document.body.innerText) || ''; return { t: document.title, u: location.href, n: s.length, s: s.slice(0, ${maxChars + 1}) }; })()`;
    const read = await session.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const value = read?.result?.value || {};
    out.title = String(value.t || '');
    out.url = String(value.u || url.href);
    const body = String(value.s || '');
    out.truncated = body.length > maxChars;
    out.text = out.truncated ? body.slice(0, maxChars) : body;
    out.chars = Number(value.n) || out.text.length;
    // Which of the two reads this was. The content is in `text` either way — one field,
    // so a caller printing the result cannot print the wrong one.
    out.isHtml = wantHtml;

    if (shotPath) {
      const shot = await session.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(shotPath), { recursive: true });
      fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      out.shot = shotPath;
    }

    if (docFailed) {
      // Chrome renders its own error page and the protocol reports no error at all, so
      // without this a read of "This site can't be reached" comes back as a page that
      // rendered — an empty answer wearing an answer's clothes, which is the exact
      // failure this module exists to stop happening one layer down.
      throw new BrowseError('navigate', `the page never loaded (${docFailed})`);
    }

    out.problems = [...seen.values()];
    out.blocked = [...blocked.entries()].map(([what, n]) => ({ what, n }));
    return out;
  } catch (err) {
    if (err instanceof BrowseError || err instanceof LookupError) throw err;
    throw new BrowseError('browse', err?.message || String(err));
  } finally {
    try {
      session?.close();
    } catch {
      /* already gone */
    }
    proc.kill('SIGKILL');
    out.profileRemoved = await removeProfile(profile);
  }
}

// What the agents are *told* about this lives in `lookupBrief` (lib/lookup.js), with the
// other three shapes, rather than in a second brief here. That is deliberate: the rules
// that matter — cite the source, do not infer a value a table should supply, watch what
// you put in a URL — are identical for all four, and a brief per module is four copies
// of one paragraph, of which three go stale.
