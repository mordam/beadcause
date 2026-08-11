/**
 * How many terminal columns a string occupies.
 *
 * Terminal columns, not code units. The monitor's box has a right-hand border, so a
 * phase icon miscounted by one column shears every line beneath it — and JS string
 * length is no guide at all: '⏳' is one code unit and two columns, '🤔' is two of
 * each. So the East-Asian-wide and emoji ranges are consulted directly, and the two
 * modifiers that change a *neighbour's* width are handled where they appear: U+FE0F
 * promotes the character before it to emoji presentation, and a ZWJ fuses the glyph
 * after it into the one before.
 *
 * This lives in `lib/` rather than in `bin/monitor.js`, where it was written, for one
 * reason: it could not be tested there. `bin/monitor.js` polls the daemon and takes
 * over the screen at import time, so a suite that imported it to reach `dw` would
 * hang rather than assert — and a wrong entry in the WIDE table is exactly the kind
 * of silent breakage that only a test catches, because the symptom is a right border
 * one column out on a screen nobody is looking at. `test/monitorwidth.mjs` measures
 * the table here against Unicode's own answer (`\p{Emoji_Presentation}` and the
 * scripts that are wide), which is an oracle independent of the table itself.
 *
 * The only consumer is the monitor. Nothing here knows about the monitor.
 */

/**
 * Codepoints that occupy two columns: East-Asian Wide/Fullwidth, plus the emoji
 * blocks and the scattered pre-emoji BMP characters that render double-width.
 *
 * Coarse on purpose — a range is cheaper to hold in your head than a generated
 * table, and the cases where a range is generous (a text-presentation character
 * inside an emoji block) are not characters this program prints.
 */
export const WIDE = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
  // The scattered pre-emoji BMP characters that still render double-width.
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
];

/** Codepoints that occupy no columns of their own: combining marks, the invisible
 *  format characters, the variation selectors and the skin-tone modifiers. */
export const ZERO = [[0x0300, 0x036f], [0x200b, 0x200f], [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0x1f3fb, 0x1f3ff]];

export const inRanges = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (s) => [...SEGMENTER.segment(String(s))].map((g) => g.segment);

/** Columns occupied by one grapheme cluster. */
export function clusterWidth(g) {
  let n = 0;
  let last = 0;
  let joined = false;
  for (const ch of g) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d) { joined = true; continue; }
    if (joined) { joined = false; continue; }
    if (cp === 0xfe0f) { if (last === 1) { n += 1; last = 2; } continue; }
    if (cp < 0x20) continue;
    last = inRanges(cp, ZERO) ? 0 : inRanges(cp, WIDE) ? 2 : 1;
    n += last;
  }
  return n;
}

/** Columns occupied by a string. */
export const dw = (s) => graphemes(s).reduce((n, g) => n + clusterWidth(g), 0);

/** The longest prefix of `s` that fits in `max` columns. */
export function cut(s, max) {
  let text = '';
  let width = 0;
  for (const g of graphemes(s)) {
    const w = clusterWidth(g);
    if (width + w > max) break;
    text += g;
    width += w;
  }
  return { text, width };
}
