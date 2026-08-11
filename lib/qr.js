// The QR encoder that already ships with this repo: `qrcode-terminal` draws to a
// terminal, but the matrix it draws *from* is a plain implementation sitting in its
// vendor directory, and that is the only part wanted here. Reaching past the package's
// `main` is deliberate — the alternative was a second QR dependency for the same
// arithmetic, and there is no `exports` map in that package to make this fragile.
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';

/**
 * A pairing URL as an SVG a phone camera can read, drawn on the server.
 *
 * `npm run qr` has printed these to a terminal since the first week, which is the
 * right surface for a Mac you are sitting at and no use at all for the case this
 * exists for: turning HTTPS on moves the origin, every paired browser is signed out
 * by it — the token lives in localStorage, which is per-origin — and the phone that
 * has just been signed out is the phone in your hand. A code on the screen that did
 * the signing out is the shortest way back in; nobody has to walk to the Mac.
 *
 * Server-side rather than a library in the page, for the reason everything else in
 * `public/vendor` is vendored: the pages load no external origin, and adding a
 * client-side QR library to `scripts/vendor.js` for one code on one screen is more
 * moving parts than a string of rectangles.
 *
 * **Dark on light, always, whatever the page's theme is.** A scanner needs the
 * contrast and it needs the quiet zone; an inverted code reads on some phones and not
 * others, and "it worked on mine" is the worst property the thing that gets you back
 * in could have. So the light square is painted rather than inherited.
 *
 * Returns an SVG string with no width or height — the caller sizes it in CSS, and a
 * `viewBox` in module units keeps it crisp at any size.
 */
export function qrSvg(text, { quiet = 4, level = QRErrorCorrectLevel.M } = {}) {
  const value = String(text ?? '');
  if (!value) throw new Error('nothing to encode');

  // -1 is "the smallest version this fits in". Error correction M rather than the
  // library's own default of L: the code is read off a screen, at an angle, often
  // with a thumb over a corner, and the redundancy costs a few modules.
  const code = new QRCode(-1, level);
  code.addData(value);
  code.make();

  const n = code.getModuleCount();
  const side = n + quiet * 2;

  // One path for every dark module rather than an element each: a 33×33 code is around
  // five hundred of them, and the whole thing travels inside a JSON reply.
  let d = '';
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (code.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }

  // No label text: the only thing this ever encodes is a URL with a token in it, and
  // an `aria-label` carrying that token would put it into accessibility trees and
  // screen-reader histories for a code whose whole point is that you photograph it.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" ` +
    `role="img" aria-label="Pairing QR code">` +
    `<rect width="${side}" height="${side}" fill="#ffffff"/>` +
    `<path d="${d}" fill="#000000"/>` +
    `</svg>`
  );
}
