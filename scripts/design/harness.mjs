// Serving the bundle and driving Chrome over it — shared by every check that renders.
//
// Extracted when the contrast audit became the second such check. A second copy of the
// boot sequence is how the two halves drift, and this repo has already paid for that
// once (bc-uytt, the attic sweep): the gates diverged from the writer they mirrored and
// neither run's output said so.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from '../helpers/chrome.mjs';

export const BUNDLE = 'design-bundle';

/** Serve design-bundle/ on a port, for Chrome to fetch from. */
export async function serveBundle(port) {
  const server = createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    // Read before answering: writeHead(200) followed by a throwing read leaves the 404
    // path setting headers that already went out.
    let body;
    try {
      body = readFileSync(join(BUNDLE, p));
    } catch {
      res.writeHead(404);
      return res.end('not in the bundle');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

/** A page with Runtime and Page enabled, plus a console-error sink you can drain. */
export async function openPage(prefix) {
  const chrome = await launchChrome(prefix);
  const { s } = chrome;
  await s.send('Page.enable');
  await s.send('Runtime.enable');

  let errors = [];
  s.on((method, params) => {
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails?.text || 'exception');
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      errors.push((params.args || []).map((a) => a.value ?? a.description ?? '?').join(' '));
    }
  });

  return {
    s,
    close: chrome.close,
    drainErrors: () => {
      const e = errors;
      errors = [];
      return e;
    },
    /** Navigate and wait for load — with a ceiling, because a card is static. */
    go: async (url) => {
      const done = new Promise((resolve) => {
        s.on((m) => m === 'Page.loadEventFired' && resolve());
        setTimeout(resolve, 4000);
      });
      await s.send('Page.navigate', { url });
      await done;
    },
    /** Emulate one of the two colour schemes. */
    theme: (value) => s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] }),

    /**
     * Pin every animation to one frame, so two screenshots of an unchanged card match.
     *
     * `.spark` breathes on a 1.3s loop and eight cards draw one, so a hash taken at an
     * arbitrary moment differs from the last one for no reason anybody changed — which
     * is how the first regression run reported twelve moved components when four had.
     * It also quietly weakened the dark-vs-light check in shots.mjs: two renders that
     * differ only in animation phase satisfy "the themes are really two" without the
     * themes being anything of the kind.
     *
     * Removed outright rather than paused. `animation-play-state: paused` with a negative
     * delay ought to seek every animation to one offset and hold it, and measurably does
     * not: a save-then-compare with nothing changed still reported nine components moved.
     * `animation: none` has no such ambiguity, and the thing being compared here is
     * layout and colour, not motion.
     *
     * The cost, stated because it is real: a baseline cannot detect a change to an
     * animation. `shots.mjs` deliberately does NOT freeze — its probe asserts that a live
     * row's spark really is running, which a frozen page cannot show.
     */
    freeze: async () => {
      await s.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.createElement('style');
          el.textContent = '*, *::before, *::after {' +
            'animation: none !important;' +
            'transition: none !important;' +
            'caret-color: transparent !important; }';
          document.head.append(el);
        })()`,
      });
      // And then let it settle. Killing the animations was not enough on its own: a
      // save-then-compare still moved one or two cards per run, and never the same ones,
      // which is capture racing layout rather than anything animating. Two frames plus a
      // beat is what made two consecutive runs of an unchanged tree agree.
      await s.send('Runtime.evaluate', {
        expression: `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))))`,
        awaitPromise: true,
      });
    },
    size: (width, height, deviceScaleFactor = 2) =>
      s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false }),
    async evaluate(expression) {
      const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    },
  };
}

/** Every card in the manifest, flattened, optionally filtered by a path fragment. */
export async function cardList(filter) {
  const { GROUPS } = await import('./manifest.mjs');
  return GROUPS.flatMap((g) => g.cards.map((c) => ({ ...c, group: g.group })))
    .filter((c) => !filter || c.path.includes(filter));
}
