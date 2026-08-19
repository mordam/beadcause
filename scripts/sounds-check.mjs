/*
  /sounds in a real browser — the audition, driven end to end at phone widths.

      node scripts/sounds-check.mjs
      node scripts/sounds-check.mjs --out=/tmp/shots     # and photograph it

  ## Why this exists beside test/sounds.mjs

  `test/sounds.mjs` reads files. It can hold the wavs to what `scripts/sounds.mjs` renders,
  hold the two copies equal, and hold `public/sounds.js` to naming only sounds that are on
  disk. What it cannot do is the thing this page is: **press it**.

  Three claims here are unreachable from a suite that never paints.

  1. **The stylesheet actually applies.** Every control on this page is sized for a thumb —
     44px, the same floor the pill row is held to — and that is a `getComputedStyle` fact,
     not a fact about the text of `public/style.css`. A rule that lands under a selector
     that never matches reads identically in the file.
  2. **The audition really is blind, and really does shuffle.** A guess cannot be committed
     before every pad is named, no pad carries its own answer, and twenty consecutive runs
     do not produce the same order. The last one is why this is a browser and not a `vm`:
     `Math.random()` in a page is the page's, and the shuffle is the whole method.
  3. **Every sound the page reaches for answers.** This check is the reason that claim is
     here at all — the first version of the page played `/sounds/blip.wav` and the daemon
     answered 404, because the reference pip lives in `res/raw` and nothing had copied it
     into `public/sounds`. Nothing static noticed: the page was correct, the file list was
     correct, and the two had never been asked about each other.

  The fixture serves `public/` and takes its path aliases from `lib/pagealias.js`, so
  `/sounds` and `/audition` are resolved here by the same table `lib/server.js` holds rather
  than by a copy of it that can drift.
*/

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aliasPage, pageAliases } from '../lib/pagealias.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);

/* 360×640 is the cheap Android this app is for; 393×852 is the phone in the hand. Both,
   because a layout that holds at one width holds by accident. */
const SIZES = [
  { width: 360, height: 640 },
  { width: 393, height: 852 },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

let bad = 0;
const ok = (name, detail) => console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[2m${detail}\x1b[0m` : ''}`);
const no = (name, detail) => {
  bad++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const say = (pass, name, detail) => (pass ? ok(name, detail) : no(name, detail));

const ALIASES = pageAliases();

const serve = () => {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    // Nothing on this page asks the daemon anything; the shared scripts above it do.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const rel = aliasPage(p, ALIASES).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
};

const server = await serve();
const { port } = server.address();
const { s, close } = await launchChrome('beadcause-sounds-');

const evalJs = async (expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${expr}\n      ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result.value;
};

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  const thrown = [];
  s.on((method, params) => {
    if (method === 'Runtime.exceptionThrown') thrown.push(JSON.stringify(params).slice(0, 300));
  });

  for (const size of SIZES) {
    console.log(`\n\x1b[1m${size.width}×${size.height}\x1b[0m`);
    await s.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: true });
    await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/sounds` });
    await new Promise((r) => setTimeout(r, 900));

    /* ---------------------------------------------------------- it painted */

    say(await evalJs(`!!document.querySelector('.sound-start')`), 'the audition offers a way to start');
    const tap = await evalJs(`getComputedStyle(document.querySelector('.sound-start')).minHeight`);
    say(tap === '44px', 'and the stylesheet applied — the start button is a 44px tap target', tap);
    say((await evalJs(`document.querySelectorAll('.sound-row').length`)) === 5, 'five voices in the reference list');
    const wide = await evalJs('document.documentElement.scrollWidth');
    say(wide <= size.width, 'nothing overflows sideways', `scrollWidth ${wide}`);

    /* ------------------------------------------------------- it is an audition */

    await evalJs(`document.querySelector('.sound-start').click()`);
    say((await evalJs(`document.querySelectorAll('.sound-pad').length`)) === 4, 'four pads, one per sound to be named');
    say(
      await evalJs(`[...document.querySelectorAll('.sound-pad')].every(p => !/merge|release|epic|stuck/i.test(p.querySelector('.sound-padhead').textContent))`),
      'and no pad says what it is — which is the whole method'
    );
    say(await evalJs(`document.querySelector('.sound-reveal').disabled === true`), 'the answer is refused until all four are named');
    await evalJs(`[...document.querySelectorAll('.sound-pad')].forEach(p => p.querySelector('.sound-pick').click())`);
    say(await evalJs(`document.querySelector('.sound-reveal').disabled === false`), 'and offered once they are');
    await evalJs(`document.querySelector('.sound-reveal').click()`);
    say((await evalJs(`document.querySelectorAll('.sound-pick.is-right').length`)) === 4, 'the reveal marks the true answer on every pad');
    say(
      await evalJs(`getComputedStyle(document.querySelector('.sound-pick.is-right'), '::after').content.includes('✓')`),
      'with a mark and not only a colour'
    );
    const verdict = await evalJs(`document.querySelector('.sound-verdict')?.textContent || ''`);
    say(/named correctly/.test(verdict), 'and says how many were named', verdict.trim());

    /* ------------------------------------------------------------- it shuffles */

    // Twenty runs, reading back the real order each time. One distinct order out of twenty
    // is a shuffle that is not shuffling — which would leave the page looking exactly like
    // this one and testing nothing.
    const orders = await evalJs(`(() => {
      const seen = new Set();
      for (let i = 0; i < 20; i++) {
        (document.querySelector('.sound-again') || document.querySelector('.sound-start')).click();
        document.querySelectorAll('.sound-pad').forEach(p => p.querySelector('.sound-pick').click());
        document.querySelector('.sound-reveal').click();
        seen.add([...document.querySelectorAll('.sound-pad')]
          .map(p => p.querySelector('.sound-pick.is-right').textContent.trim())
          .join('|'));
      }
      return [...seen].length;
    })()`);
    say(orders > 1, 'twenty runs are not twenty of the same order', `${orders} distinct orders`);

    /* --------------------------------------------------- every sound answers */

    const answered = await evalJs(`(async () => {
      const ids = [...new Set([...document.querySelectorAll('.sound-file')].map(e => e.textContent.replace('.wav','')))];
      const rs = await Promise.all(ids.map(id => fetch('/sounds/' + id + '.wav')
        .then(r => id + ':' + r.status + ':' + r.headers.get('content-type'))
        .catch(() => id + ':threw')));
      return rs;
    })()`);
    say(
      answered.length === 5 && answered.every((a) => a.endsWith(':200:audio/wav')),
      'every sound the page names is served, as audio',
      answered.join('  ')
    );

    if (OUT) {
      const shot = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.mkdirSync(OUT, { recursive: true });
      const at = path.join(OUT, `sounds-${size.width}.png`);
      fs.writeFileSync(at, Buffer.from(shot.data, 'base64'));
      console.log(`  \x1b[2m→ ${at}\x1b[0m`);
    }
  }

  console.log('');
  say(thrown.length === 0, 'the page threw nothing', thrown.join(' | '));
} finally {
  await close();
  server.close();
}

console.log(bad ? `\n\x1b[31m${bad} failed\x1b[0m` : '\n\x1b[32mall good\x1b[0m');
process.exit(bad ? 1 : 0);
