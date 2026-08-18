#!/usr/bin/env node
//
// Do the two committed PNGs still match `public/icon.svg`?
//
//   node scripts/icons-check.mjs
//
// The app mark lives in five files (see the header of `scripts/icons.mjs`), and only
// three of them can be diffed as text. `public/icon-512.png` (the manifest's `"any
// maskable"`) and `public/icon-180.png` (the `apple-touch-icon` in every page head) are
// rasters, committed alongside the SVG they were made from — and until this file
// existed, nothing ever looked at the two together. Edit `icon.svg`, forget `npm run
// icons`, and the phone goes on serving, caching and showing the old mark from a file
// that is tracked in git and passes every other suite.
//
// So: render `icon.svg` again, the same way `npm run icons` does — the same headless
// Chrome, the same sizes, the same white ground — and compare the result to what is
// committed, pixel by pixel. Byte equality would be flaky across Chrome versions (two
// otherwise-identical renders can differ by a shade of anti-aliasing at a curve's edge),
// so a pixel counts as different only past a per-channel tolerance, and the render as a
// whole only fails past a tolerance on how many pixels that happens to. A redrawn mark
// clears both by a wide margin; a Chrome point release redrawing the same curve a shade
// softer does not.
//
// This needs a Chrome to rasterise the SVG, which is why it is a check and not a test —
// see `lib/checkaudit.js` for why `npm test` covers these by auditing their selectors
// rather than running them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

/** What `public/index.html`'s head and the manifest ask for. Mirrors `scripts/icons.mjs`'s
 *  own `SIZES` — not imported from it, because that file's top level renders and writes
 *  the PNGs the moment it is loaded, which is the one thing a check must never do. */
const SIZES = [512, 180];

/** Per-channel delta (0-255) below which a pixel counts as "the same". Anti-aliasing at
 *  a curve's edge can move a channel a handful of steps between Chrome versions without
 *  the mark having changed at all. */
const CHANNEL_TOLERANCE = 24;

/** Fraction of a rendering's pixels allowed past that tolerance before the check calls it
 *  a different image. A redrawn mark moves most of the ink; jittered anti-aliasing moves
 *  a rim of pixels around each curve, nowhere near this. */
const MISMATCH_FRACTION = 0.01;

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

const svgPath = path.join(PUBLIC, 'icon.svg');
if (!fs.existsSync(svgPath)) {
  console.error(`${svgPath} does not exist`);
  process.exit(1);
}
const svg = fs.readFileSync(svgPath, 'utf8');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const { s, close } = await launchChrome('beadcause-icons-check-');
try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');

  for (const size of SIZES) {
    const committedPath = path.join(PUBLIC, `icon-${size}.png`);
    if (!fs.existsSync(committedPath)) {
      check(`icon-${size}.png is committed`, false, `${committedPath} does not exist — run npm run icons`);
      continue;
    }

    // The exact render `scripts/icons.mjs` does: the SVG inlined into a page sized in
    // CSS to the target box, on a white ground, screenshotted at scale 1.
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#fff}
      svg{display:block;width:${size}px;height:${size}px}
    </style>${svg}`;
    await s.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
    await new Promise((r) => setTimeout(r, 400));
    const shot = await s.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
      captureBeyondViewport: true,
    });
    const freshBase64 = shot.data;
    const committedBase64 = fs.readFileSync(committedPath).toString('base64');

    // The diff itself runs in the page, via <canvas> — decoding a PNG in Node here
    // would mean shipping a decoder this repo has no other use for, and Chrome already
    // has one. Two `data:` images never taint a canvas, whatever the page's own origin,
    // so this works regardless of what the page last navigated to.
    const expression = `
      (async () => {
        const load = (src) => new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('image failed to decode'));
          img.src = src;
        });
        const [fresh, committed] = await Promise.all([
          load(${JSON.stringify(`data:image/png;base64,${freshBase64}`)}),
          load(${JSON.stringify(`data:image/png;base64,${committedBase64}`)}),
        ]);
        if (fresh.width !== committed.width || fresh.height !== committed.height) {
          return {
            ok: false,
            reason: 'size',
            fresh: [fresh.width, fresh.height],
            committed: [committed.width, committed.height],
          };
        }
        const box = fresh.width;
        const pixelsOf = (img) => {
          const c = document.createElement('canvas');
          c.width = box;
          c.height = box;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, box, box).data;
        };
        const a = pixelsOf(fresh);
        const b = pixelsOf(committed);
        let mismatched = 0;
        let maxDelta = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(
            Math.abs(a[i] - b[i]),
            Math.abs(a[i + 1] - b[i + 1]),
            Math.abs(a[i + 2] - b[i + 2]),
            Math.abs(a[i + 3] - b[i + 3]),
          );
          if (d > maxDelta) maxDelta = d;
          if (d > ${CHANNEL_TOLERANCE}) mismatched += 1;
        }
        return { ok: true, box, mismatched, total: box * box, maxDelta };
      })()
    `;
    const { result, exceptionDetails } = await s.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (exceptionDetails) {
      check(`icon-${size}.png matches a fresh render of icon.svg`, false, exceptionDetails.text || 'the in-page diff threw');
      continue;
    }
    const diff = result.value;
    if (diff.reason === 'size') {
      check(
        `icon-${size}.png matches a fresh render of icon.svg`,
        false,
        `committed is ${diff.committed.join('x')}, a fresh render is ${diff.fresh.join('x')} — run npm run icons`,
      );
      continue;
    }
    const fraction = diff.mismatched / diff.total;
    const pct = (fraction * 100).toFixed(2);
    check(
      `icon-${size}.png matches a fresh render of icon.svg`,
      fraction <= MISMATCH_FRACTION,
      fraction <= MISMATCH_FRACTION
        ? `${diff.mismatched}/${diff.total} px past tolerance (${pct}%), max channel delta ${diff.maxDelta}`
        : `${diff.mismatched}/${diff.total} px (${pct}%) differ by more than ${CHANNEL_TOLERANCE}/255 — the SVG changed since npm run icons last ran`,
    );
  }
} finally {
  close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
