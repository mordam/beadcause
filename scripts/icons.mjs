#!/usr/bin/env node
/**
 * Raster `public/icon.svg` into the two PNGs beside it.
 *
 *     npm run icons
 *
 * The mark lives in five files — `public/icon.svg`, `public/icon-180.png`,
 * `public/icon-512.png` and the two Android vectors — and three of them are hand-edited
 * text that can be diffed. The PNGs are not: `icon-180.png` is the `apple-touch-icon` in
 * every page head and `icon-512.png` is the manifest's `"any maskable"`, and until this
 * file existed there was no committed way to make either from the SVG. Redrawing the
 * mark (bc-45yl) therefore began with half an hour of working out how to raster an SVG
 * on a laptop with no rsvg-convert, no ImageMagick and no Inkscape, which is exactly the
 * half hour the next redraw should not have to spend.
 *
 * **The rasteriser is the headless Chrome the browser checks already use.** Not a new
 * dependency, not a service, and the same renderer the PWA will use on the phone — so
 * what is committed is what a browser makes of the file, rather than one library's
 * reading of it.
 *
 * **The ground is white, not transparent, and that is deliberate.** The corners outside
 * the `rx="112"` round are opaque white in the committed PNGs, because both consumers
 * mask them away: iOS applies its own squircle to the touch icon, and `maskable` crops
 * to the centre circle. Rendering onto transparency instead would be a different change
 * from redrawing the mark, so this reproduces what is there. If that is ever revisited,
 * it is this one line.
 *
 * `scripts/icons-check.mjs` is what now catches the three falling out of step — it
 * re-renders `icon.svg` the same way this file does and compares the result to the
 * committed PNGs pixel-wise, so an edit that forgets to run this leaves a check red
 * rather than a phone silently serving the old mark.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './helpers/chrome.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

/** What the manifest and `index.html` ask for, and nothing else. */
export const SIZES = [512, 180];

const svg = fs.readFileSync(path.join(PUBLIC, 'icon.svg'), 'utf8');
const { s, close } = await launchChrome('beadcause-icons-');
try {
  await s.send('Page.enable');
  for (const size of SIZES) {
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // The SVG is inlined rather than linked so the page needs no server and no file://
    // origin, and sized in CSS so the 512 viewBox maps to whatever pixel box is asked
    // for. `display:block` because an inline <svg> otherwise sits on a text baseline
    // and leaves a few pixels of ground under the icon.
    const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#fff}
      svg{display:block;width:${size}px;height:${size}px}
    </style>${svg}`;
    await s.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
    // A data: URL with no subresources is painted well inside this, and the alternative
    // is listening for Page.loadEventFired plus a frame — more moving parts than a file
    // run by hand after a redraw is worth.
    await new Promise((r) => setTimeout(r, 400));
    const shot = await s.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
      captureBeyondViewport: true,
    });
    const out = path.join(PUBLIC, `icon-${size}.png`);
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`==> public/icon-${size}.png  ${fs.statSync(out).size} bytes`);
  }
} finally {
  close();
}
