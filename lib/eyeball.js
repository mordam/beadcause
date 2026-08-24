/**
 * Render a page against a fixture, and hand back the pixels *and* the geometry.
 *
 * `bin/b7e-eyeball` is the thin CLI shell and the one place a browser is touched;
 * everything that can be gotten wrong lives here so `test/eyeball.mjs` can drive it with
 * no Chrome at all — this repo's suite deliberately does not depend on a browser
 * (test/chromeprofile.mjs and test/chromeleak.mjs are the precedents), and a command whose
 * only cover needs one would have no cover in `npm test`.
 *
 * ## Why this is a command and not a paragraph in a debrief
 *
 * bc-khoe.45 is a session-audit finding: **six** sessions each hand-built the same rig in
 * a scratchpad to answer "what does this actually look like, in numbers", and no two built
 * the same one. bc-khoe.26 wrote `measure.mjs` (a fixture server over `public/` plus a
 * hand-written page mounting the real `filtermenu.js`); bc-mtdb wrote
 * `observing-eyeball.mjs` (the brand's children and `.observing`'s rect at 360, plus a PNG
 * it then read); bc-dgx7.5 wrote `skills-eyeball.mjs` (dark × light × full × empty, four
 * PNGs, "nothing runs past 393px"). The other three are in sophab, filed as `sp-6bt.10`
 * and folded into this bead on 2026-08-22 under this name: `sp-6bt.2`, `sp-jb1` and
 * `sp-auj` each wrote two or three of `shot.py`/`measure.py`/`overflow_check.py`.
 *
 * Three memory notes record three competing recipes for the same job, which is the tell.
 * `scripts/shot.mjs` could not be used by any of the six: it photographs the **running
 * daemon**, so it cannot show a page fed synthetic state and cannot mount a module on a
 * fixture at all.
 *
 * ## Four traps, each of which cost one of those sessions real time
 *
 * **The document is written here, so the charset trap cannot come back.** bc-khoe.26's
 * fixture had no `<meta charset="utf-8">`, its caret rendered as mojibake, and its debrief
 * says outright "you will chase a bug that is not there". A hand-written fixture forgets
 * it about half the time; a generated one cannot.
 *
 * **The mount is given an explicit width, because `min-width: auto` silently invalidates
 * every height.** bc-henk measured cards at 517px inside a 393px viewport and believed a
 * height that was a third out: `Emulation.setDeviceMetricsOverride` sets the *viewport*,
 * `document.documentElement.scrollWidth` then says 393 quite happily, and the flex item
 * underneath resolves `min-width: auto` to the min-content of its own contents. So the
 * generated fixture always carries `width: <viewport>px; min-width: 0` on the mount, and
 * every record prints the mount's measured width beside the viewport so the two can be
 * seen to agree.
 *
 * **Overflow is not one question, and `scrollWidth` alone answers the wrong half.** The
 * same trap is why: an ancestor with `overflow-x: hidden` clips the offender out of
 * `scrollWidth` while the element is still wider than the phone. So a run reports both —
 * the document's scroll width against the viewport, *and* the elements whose right edge is
 * past it, skipping anything inside a horizontally-scrollable ancestor (a real carousel is
 * not an overflow) and anything invisible. Either one failing fails the width.
 *
 * **The port is never a number.** `sp-jb1` started its server on a fixed 8099, spent four
 * calls measuring *another session's worktree* on the same port, and only found it via
 * `EADDRINUSE` in its own log; the same shape is what `scripts/helpers/chrome.mjs` exists
 * to have fixed for Chrome's debugging port. `listen(0, '127.0.0.1')` — the kernel picks,
 * nothing collides, and the port that was actually used is printed on every record.
 *
 * ## What it serves
 *
 * The **working tree**, not the daemon and not `HEAD`: `<root>/public/` behind the app's
 * own alias table (`lib/pagealias.js`, derived from `lib/server.js` rather than copied —
 * one 404 inside a service-worker install cost two sessions in bc-zjep), every `/api/*`
 * answered `{}` unless a `--payload` names it, and `--baseline` swapping any `public/`
 * file for its committed text so a before-shot costs no `git stash`.
 *
 * There is no credential anywhere in this: the fixture server is not the daemon, so the
 * pairing token is a fixed fake string. `scripts/shot.mjs` has to mask a real one out of
 * its own output (bc-sqab); this has nothing to mask.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aliasPage, hopLocation, pageAliases, viewHops } from './pagealias.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The checkout this file belongs to — the tree served when `--dir` is not given. */
export const REPO_ROOT = path.resolve(HERE, '..');

/**
 * Both phone widths, because the two disagree often enough to be worth always having.
 * 360 is the narrow Android the topbar checks use; 393 is the iPhone 14 Pro every
 * `scripts/*-check.mjs` here emulates.
 */
export const DEFAULT_WIDTHS = [360, 393];

/** Both schemes by default: bc-dgx7.5's sweep was dark × light and found a bug in one. */
export const DEFAULT_THEMES = ['dark', 'light'];

/** The viewport height. Tall enough that a phone page is one screen, short enough to shoot. */
export const DEFAULT_HEIGHT = 852;

/** The path the generated fixture document is served at. Never a real page's. */
export const FIXTURE_PATH = '/__eyeball__';

/** The element a fixture mounts into, and the one carrying the explicit width. */
export const MOUNT_ID = 'eyeball-mount';

/**
 * Not a secret and deliberately so: nothing here is the daemon, so nothing here has a
 * credential to leak. Pages that refuse an unpaired device read this out of localStorage
 * under the dotted key (`beadcause.token`, not the dashed one the query param uses — the
 * distinction cost three failed runs on the graph page) and off `?t=` as well, because
 * localStorage rides on no navigation.
 */
export const TOKEN = 'b7e-eyeball-token';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/* --------------------------------------------------------------- payloads */

/**
 * One `--payload file.json`, as `{ name, data, routes }`.
 *
 * **One rule, two jobs, and no reserved key.** The whole file is handed to the fixture
 * document as `payload` — bc-khoe.26's case, where it is the synthetic data a module is
 * mounted on. *Separately*, any top-level key that starts with `/` is served at that path
 * — bc-dgx7.5's case, where it is the API response a real page is fed. A file can do both
 * at once and neither reading can surprise the other.
 *
 * `name` comes off the filename, because it is what tells four PNGs of the same page
 * apart on disk.
 */
export function readPayload(file) {
  const text = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not JSON: ${e.message}`);
  }
  const routes = {};
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) if (k.startsWith('/')) routes[k] = v;
  }
  return { name: path.basename(file).replace(/\.json$/i, ''), data, routes };
}

/* ------------------------------------------------------------- the run plan */

/** A filename fragment that survives a shell, a finder and a `Read`. */
export const slug = (s) =>
  String(s)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40) || 'index';

/**
 * The cross product, in the order a reader wants it: one target at a time, widest last.
 *
 * Every cell knows its own PNG name before anything is rendered, which is what lets the
 * report name a file that a failed run never wrote — the difference between "this cell
 * produced nothing" and "you are looking at the wrong picture".
 */
export function planCells({ targets, widths = DEFAULT_WIDTHS, themes = DEFAULT_THEMES, payloads = [null], outDir = '.' }) {
  const cells = [];
  for (const target of targets) {
    for (const payload of payloads) {
      for (const theme of themes) {
        for (const width of widths) {
          const parts = [slug(target), String(width), theme];
          if (payload) parts.push(slug(payload.name));
          const png = path.join(outDir, `eyeball-${parts.join('-')}.png`);
          cells.push({ target, width, theme, payload, png, label: parts.join(' · ') });
        }
      }
    }
  }
  return cells;
}

/* -------------------------------------------------------- the fixture page */

/** `</script>` inside embedded JSON ends the script tag it is inside. `<` never survives. */
const embed = (value) => JSON.stringify(value === undefined ? null : value).replace(/</g, '\\u003c');

/**
 * The document a fixture run renders — written here rather than by the caller.
 *
 * That is the whole of acceptance criterion four. A hand-written fixture page is where the
 * charset trap lives, where the `min-width: auto` trap lives, and where "did you remember
 * to link the real stylesheet" lives; none of the three can be reintroduced through this
 * function, because none of them is the caller's to write.
 *
 * `mounts` are module specifiers imported in order — real files under `public/`, served by
 * the same fixture server, so the module under test is the one on disk. `call` is
 * evaluated after them with `mount`, `payload`, `mod` (the first namespace) and `mods` in
 * scope; a module that mounts itself on import needs no `call` at all. Either way the
 * result is recorded on `window.__eyeball`, so a module that threw is reported as a module
 * that threw rather than photographed as an empty box.
 */
export function fixtureDocument({
  width = 393,
  html = '',
  mounts = [],
  call = '',
  payload = null,
  stylesheets = ['/style.css'],
  bodyClass = 'doc-body',
  mountClass = 'work',
  title = 'b7e-eyeball fixture',
} = {}) {
  const links = stylesheets.map((href) => `  <link rel="stylesheet" href="${href}">`).join('\n');
  const imports = mounts.length
    ? `  const mods = await Promise.all(${embed(mounts)}.map((s) => import(s)));\n  const mod = mods[0];\n`
    : '  const mods = [];\n  const mod = null;\n';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${title}</title>
${links}
  <style>
    /* The one rule this file exists to guarantee. A flex item resolves min-width:auto to
       its own min-content, so a mount without this renders wider than the phone it is
       being measured on and every height taken off it is an under-estimate — with nothing
       anywhere reporting an overflow. bc-henk paid a whole round of measurements for it. */
    #${MOUNT_ID} { width: ${width}px; min-width: 0; box-sizing: border-box; }
  </style>
</head>
<body class="${bodyClass}">
  <main id="${MOUNT_ID}" class="${mountClass}">${html}</main>
  <script type="module">
  const payload = ${embed(payload)};
  window.eyeballPayload = payload;
  const mount = document.getElementById(${embed(MOUNT_ID)});
  try {
${imports}${call ? `    ${call}\n` : ''}    window.__eyeball = { ok: true, mounted: mods.length, hasMount: !!mount, payload: payload !== null };
  } catch (err) {
    window.__eyeball = { ok: false, error: String((err && err.stack) || err) };
    console.error('eyeball fixture: ' + ((err && err.message) || err));
  }
  </script>
</body>
</html>
`;
}

/* ------------------------------------------------------- what to ask the page */

/**
 * The expression evaluated in the page — the whole measurement, in one round trip.
 *
 * It is one string rather than a call per selector because a second `Runtime.evaluate` is
 * a second layout against a page that may have moved, and the numbers in one record have
 * to describe one moment.
 *
 * The offender walk is the half `scrollWidth` cannot answer (see this file's header). An
 * element inside a horizontally scrollable ancestor is *not* an overflow — a carousel is
 * allowed to be wider than the phone — and neither is one that is not being painted, so
 * both are skipped rather than reported and then argued about.
 */
export function measureExpression(selectors = []) {
  return `(() => {
  const vw = window.innerWidth;
  const px = (n) => Math.round(n * 100) / 100;
  const SLACK = 0.5;
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    return el.tagName.toLowerCase() + id + (cls.length ? '.' + cls.join('.') : '');
  };
  const lines = (el) => {
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getClientRects().length;
    } catch (e) { return null; }
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      sel: name(el),
      x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height), right: px(r.right), bottom: px(r.bottom),
      children: el.children.length,
      lines: lines(el),
      color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize, display: cs.display,
      // "overflow: hidden" means an overflowing control is silently CUT rather than
      // reported by any rect — the shape bc-8l74 found a fourth button already clipped by.
      clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
      past: r.right > vw + SLACK || r.left < -SLACK,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    };
  };
  const measured = {};
  for (const sel of ${JSON.stringify(selectors)}) {
    let nodes = [];
    try { nodes = Array.prototype.slice.call(document.querySelectorAll(sel)); }
    catch (e) { measured[sel] = { n: 0, error: String(e.message || e), nodes: [] }; continue; }
    measured[sel] = { n: nodes.length, nodes: nodes.slice(0, 8).map(describe) };
  }
  // 'auto' and 'scroll' only — a genuine horizontal scroller is allowed to be wider than
  // the phone, and a filter row or a carousel is one. 'hidden' and 'clip' are NOT an
  // exemption: they are the case worth reporting hardest, because they take the offender
  // out of scrollWidth while it is still being cut off screen. That is the whole reason
  // this walk exists beside scrollWidth rather than instead of it.
  const scrollable = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    if (r.right <= vw + SLACK) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (scrollable(el)) continue;
    offenders.push({ sel: name(el), right: px(r.right), w: px(r.width), over: px(r.right - vw) });
  }
  offenders.sort((a, b) => b.right - a.right);
  const doc = document.documentElement;
  const scrollWidth = px(Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0));
  const mount = document.getElementById(${JSON.stringify(MOUNT_ID)});
  return {
    title: document.title,
    viewport: { w: vw, h: window.innerHeight },
    scrollWidth: scrollWidth,
    // The mount's own width beside the viewport, so the min-width:auto trap is visible
    // rather than merely guarded against: 393 and 393 agree, 393 and 517 is the bug.
    mountWidth: mount ? px(mount.getBoundingClientRect().width) : null,
    offenders: offenders.slice(0, 3),
    measured: measured,
    fixture: window.__eyeball || null,
  };
})()`;
}

/* --------------------------------------------------------- the fixture server */

/**
 * `public/` of the given tree, on a port the kernel picked, with the app's alias table
 * **and its hops**.
 *
 * Both halves are derived from `lib/server.js` rather than restated (`lib/pagealias.js`),
 * and both are needed. A path that is now a *view* of the shell rather than a page — the
 * shape bc-khoe.4 moved `/monitor` into — is neither a file nor an alias, so a fixture
 * that knows only the alias table 404s on it, Chrome renders its own error page, and the
 * error page has no `<meta viewport>`: `innerWidth` comes back 980 on a 360px run and
 * every number in the record is about a page nobody asked for. Measured here on the first
 * real run of this command, against `/monitor`.
 *
 * `serve()` is called by the run between cells: `{ routes, document }` — the payload's
 * routes for this cell, and the generated fixture document if this cell is a fixture. One
 * server for the whole run, because a server per cell is a port per cell and a race per cell.
 */
export async function createFixtureServer({ root = REPO_ROOT, baseline = false, aliases = null } = {}) {
  const PUBLIC = path.join(root, 'public');
  // Derived from *this* tree's server source when it has one, so `--dir <fabricated tree>`
  // does not silently inherit the real daemon's aliases.
  const serverJs = path.join(root, 'lib', 'server.js');
  const src = fs.existsSync(serverJs) ? fs.readFileSync(serverJs, 'utf8') : '';
  const table = aliases || pageAliases(src);
  const hops = viewHops(src);
  const state = { routes: {}, document: null };

  const committed = (rel) => {
    try {
      return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body === undefined ? {} : body));
    };
    if (p === FIXTURE_PATH) {
      if (!state.document) return void res.writeHead(404).end('no fixture');
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return void res.end(state.document);
    }
    if (Object.prototype.hasOwnProperty.call(state.routes, p)) return void json(state.routes[p]);
    // Every other `/api/*` answers `{}` rather than 404, which is what every
    // `scripts/*-check.mjs` fixture here already does: a 404 on a route the page merely
    // polls hides the top bar and reads as the feature being broken.
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.resume();
        return void json({ ok: true });
      }
      return void json({});
    }

    const hop = hopLocation(p, url.search, hops);
    if (hop) {
      res.writeHead(302, { location: hop });
      return void res.end();
    }

    const rel = aliasPage(p, table).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return void res.writeHead(403).end('no');
    const type = TYPES[path.extname(rel)] || 'application/octet-stream';
    if (baseline) {
      const body = committed(`public/${rel}`);
      if (body) {
        res.writeHead(200, { 'content-type': type });
        return void res.end(body);
      }
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end('no');
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    state,
    /** What this cell is: its payload's routes, and its fixture document if it has one. */
    serve({ routes = {}, document = null } = {}) {
      state.routes = routes;
      state.document = document;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The address a cell is navigated to, token on it — see TOKEN for why it is on the URL. */
export function cellUrl(origin, cell, { fixture = false } = {}) {
  const raw = fixture ? FIXTURE_PATH : cell.target;
  const u = new URL(raw.startsWith('/') ? `${origin}${raw}` : `${origin}/${raw}`);
  if (!u.searchParams.has('t')) u.searchParams.set('t', TOKEN);
  return u.toString();
}

/* ------------------------------------------------------------- the verdict */

/**
 * One cell's record, and whether it passed.
 *
 * Three separate things fail a cell and they are kept apart on purpose, because "it
 * overflowed" and "it never loaded" send a reader to different places:
 *
 * - the document never arrived, or the fixture's own module threw;
 * - a `--measure` selector matched nothing — a green run that measured nothing is a lie,
 *   and every one of the six sessions this replaces had a selector go stale under it;
 * - the width overflowed, by either of the two readings in the header.
 *
 * Console errors and responses `>= 400` are reported always and fail only under `strict`,
 * which is `scripts/shot.mjs`'s bargain: a screenshot shows you a blank panel and not the
 * 401 behind it, but plenty of pages log something harmless on the way up.
 */
export function shapeCell(cell, raw, { strict = false } = {}) {
  const m = raw && raw.measure;
  const problems = (raw && raw.problems) || [];
  const failed = (raw && raw.failed) || null;
  const fixtureError = m && m.fixture && m.fixture.ok === false ? m.fixture.error : null;
  const empty = m ? Object.entries(m.measured || {}).filter(([, v]) => !v.n).map(([sel]) => sel) : [];
  const overflow = m
    ? {
        scrollWidth: m.scrollWidth,
        viewport: m.viewport.w,
        offenders: m.offenders || [],
        ok: m.scrollWidth <= m.viewport.w + 0.5 && !(m.offenders || []).length,
      }
    : { scrollWidth: null, viewport: cell.width, offenders: [], ok: false };
  const reasons = [];
  if (failed) reasons.push(`page: ${failed}`);
  if (fixtureError) reasons.push(`fixture threw: ${String(fixtureError).split('\n')[0]}`);
  if (!m) reasons.push('nothing was measured');
  if (empty.length) reasons.push(`matched nothing: ${empty.join(', ')}`);
  if (m && !overflow.ok)
    reasons.push(
      `overflows ${overflow.viewport}px — scrollWidth ${overflow.scrollWidth}${
        overflow.offenders.length ? `, widest ${overflow.offenders[0].sel} to ${overflow.offenders[0].right}` : ''
      }`
    );
  if (strict && problems.length) reasons.push(`${problems.length} console/network problem(s)`);
  return {
    target: cell.target,
    width: cell.width,
    theme: cell.theme,
    payload: cell.payload ? cell.payload.name : null,
    png: cell.png,
    shot: !!(raw && raw.png),
    title: m ? m.title : null,
    viewport: m ? m.viewport : { w: cell.width, h: null },
    mountWidth: m ? m.mountWidth : null,
    overflow,
    measured: m ? m.measured : {},
    problems,
    ok: reasons.length === 0,
    reasons,
  };
}

/** `6/8 cells clean` / `6/8 cells clean, 2 failed: /monitor 360 dark, …`. */
export function summaryLine(records) {
  const bad = records.filter((r) => !r.ok);
  const head = `${records.length - bad.length}/${records.length} cells clean`;
  const say = (r) => `${r.target} ${r.width} ${r.theme}${r.payload ? ` ${r.payload}` : ''}`;
  return bad.length ? `${head}, ${bad.length} failed: ${bad.map(say).join(', ')}` : head;
}

/* ------------------------------------------------------------------- the run */

/**
 * Every cell, in order, through an injected driver — which is what makes this testable.
 *
 * The driver is the only part that needs a browser: `shoot({ url, cell, selectors })`
 * returns `{ measure, problems, failed, png }` and `close()` ends it. `bin/b7e-eyeball`
 * builds the real one over `scripts/helpers/chrome.mjs`; `test/eyeball.mjs` passes a fake
 * and asserts the orchestration, the PNG writing and the exit rule without a Chrome
 * anywhere near `npm test`.
 *
 * Cells run one at a time on purpose. They share one browser and one server, and the
 * thing being measured is a layout — two pages laid out concurrently in one renderer is
 * the throttling the `--disable-*-backgrounding` flags exist to stop, measured instead of
 * the page.
 */
export async function runEyeball({ root = REPO_ROOT, cells, fixture = null, selectors = [], strict = false, server, driver, onCell = null }) {
  const records = [];
  for (const cell of cells) {
    const document = fixture ? fixtureDocument({ ...fixture, width: cell.width, payload: cell.payload ? cell.payload.data : null }) : null;
    server.serve({ routes: cell.payload ? cell.payload.routes : {}, document });
    const url = cellUrl(server.origin, cell, { fixture: !!fixture });
    let raw = null;
    try {
      raw = await driver.shoot({ url, cell, selectors, root });
    } catch (err) {
      raw = { measure: null, problems: [], failed: err.message, png: null };
    }
    if (raw && raw.png) {
      fs.mkdirSync(path.dirname(cell.png), { recursive: true });
      fs.writeFileSync(cell.png, raw.png);
    }
    const record = shapeCell(cell, raw, { strict });
    records.push(record);
    if (onCell) onCell(record);
  }
  return { records, ok: records.every((r) => r.ok), port: server.port };
}
