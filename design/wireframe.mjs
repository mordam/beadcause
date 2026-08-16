#!/usr/bin/env node
/**
 * The phone screens as something you can drag.
 *
 * There has never been a way to re-lay-out a beadcause screen except by editing
 * style.css and looking at what happened. This emits the same screens as an
 * `.excalidraw` file — plain JSON, in the repo — so a layout question can be
 * answered by moving a box instead of by guessing at a padding.
 *
 * Excalidraw and not Figma for one reason: the round trip. Figma can be imported
 * *into* (html.to.design will pull a live URL in as real layers), but its REST API
 * is read-only for document content — nothing an agent writes becomes a `.fig`, and
 * reading hand-edits back out is a re-implementation rather than a diff. An
 * `.excalidraw` file is JSON that git can diff and an agent can read directly, and
 * that is the whole point of keeping it here.
 *
 * ## The rule this file lives under
 *
 * **This generator seeds a screen once. After that the `.excalidraw` is the source
 * of truth and re-running over it is destructive** — it would overwrite exactly the
 * hand-edits the file exists to collect. `--check` is the safe verb: it regenerates
 * into memory and tells you whether the file on disk still matches, i.e. whether
 * anybody has moved anything yet. Adding a *new* screen is what `--write` is for.
 *
 * ## Two things that are load-bearing and look like details
 *
 * - **Every label is a bound text child of its box** (`containerId` on the text,
 *   `boundElements` on the rectangle). An unbound label is a separate element that
 *   stays behind when you drag the box it names, and after three drags the file is
 *   a field of orphaned words. That single link is what makes the loop survive
 *   editing at all.
 * - **Seeds are derived from element ids, not random.** Excalidraw stores a `seed`
 *   per element to keep its rendering stable; a random one would make every
 *   regenerate a whole-file diff and hide the real change.
 *
 * The numbers below are measured off public/style.css, not invented — the topbar's
 * 10/16/10 padding, --tabbar-h at 54px, --radius at 14px, .card-head's 14/15/0,
 * .list's 12px gap, the 52px compose. A wireframe that lies about spacing is worse
 * than none, because it gets believed.
 *
 *   node design/wireframe.mjs --check          # has anything been moved?
 *   node design/wireframe.mjs --write inbox    # (re)seed one screen — destructive
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ── Measured off public/style.css. Change these here, never in the JSON. ─────── */
const M = {
  phoneW: 390,           // an iPhone 14/15 at 1x, which is what the PWA is thumbed on
  phoneH: 844,
  topbarPadX: 16,        // .topbar padding: …10px 16px 10px
  topbarPadY: 10,
  topbarRow: 34,         // .icon-btn / .filter-summary min-height
  topbarGap: 12,         // .topbar gap, which is also the wrap gap to the spacebar row
  spacebarRow: 30,       // .spacebar, the second row the topbar wraps onto
  filtersPad: [10, 16, 6], // .filters padding
  filterRow: 34,         // .filter-summary min-height
  listPadX: 12,          // .list padding: 12px 12px 0
  listPadT: 12,
  listGap: 12,           // .list gap
  radius: 14,            // --radius
  cardTop: 40,           // .card-top — "Show details" and the bulk row
  cardHeadPadX: 15,      // .card-head padding: 14px 15px 0
  cardHeadPadT: 14,
  metaRow: 20,           // .pill height + line
  metaGapB: 8,           // .meta margin-bottom
  pillH: 20,
  tabbarH: 54,           // --tabbar-h
  composeD: 52,          // .compose width/height
  composeInset: 14,      // .compose-wrap right / bottom offset above the bar
};

/* Excalidraw's own palette, so the colour picker shows a swatch as selected rather
   than as a custom hex — it matters the first time you try to recolour something. */
const C = {
  ink: '#1e1e1e',
  muted: '#868e96',
  accent: '#1971c2',
  warn: '#e8590c',
  good: '#2f9e44',
  fillSurface: '#f8f9fa',
  fillAccent: '#a5d8ff',
  fillWarn: '#ffec99',
  transparent: 'transparent',
};

/* ── Element construction ─────────────────────────────────────────────────────── */

let seq = 0;
const nextId = (prefix) => `${prefix}${String(++seq).padStart(3, '0')}`;

/** FNV-1a over the id. Any stable hash would do; what matters is that it is stable. */
function seedOf(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2147483647;
}

/** Helvetica-ish advance width. Only the initial guess — Excalidraw remeasures. */
const textW = (s, size) => Math.round(s.length * size * 0.55);
const textH = (size, lines = 1) => Math.round(size * 1.25 * lines);

function baseEl(type, id, o) {
  return {
    id,
    type,
    x: o.x,
    y: o.y,
    width: o.w,
    height: o.h,
    angle: 0,
    strokeColor: o.stroke ?? C.ink,
    backgroundColor: o.fill ?? C.transparent,
    fillStyle: 'solid',
    strokeWidth: o.strokeWidth ?? 1,
    strokeStyle: o.dashed ? 'dashed' : 'solid',
    roughness: 0,            // "architect" — a wireframe should not look sketchy
    opacity: 100,
    groupIds: o.groups ? [...o.groups] : [],
    frameId: null,
    roundness: o.sharp ? null : { type: 3 },
    seed: seedOf(id),
    version: 1,
    versionNonce: seedOf(`${id}!`),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

/** Shrink a label until it fits its box on one line, rather than letting it wrap
 *  and push the container taller on load — which would silently break the layout. */
function fitSize(text, w, h, want) {
  let size = Math.min(want, Math.floor(h * 0.6));
  while (size > 8 && textW(text, size) > w - 12) size -= 1;
  return Math.max(size, 8);
}

/**
 * A box, and — if it is labelled — the text bound inside it.
 *
 * The binding is the reason this helper exists at all rather than callers pushing
 * two elements: it is easy to forget, and forgetting it is invisible until the
 * first time somebody drags the box.
 */
function box(out, o) {
  const id = nextId('r');
  const el = baseEl('rectangle', id, o);
  if (o.label != null) {
    const tid = nextId('t');
    const size = fitSize(o.label, o.w, o.h, o.labelSize ?? 14);
    const w = Math.min(textW(o.label, size), o.w - 10);
    const h = textH(size);
    const t = {
      ...baseEl('text', tid, {
        x: o.x + (o.w - w) / 2,
        y: o.y + (o.h - h) / 2,
        w,
        h,
        stroke: o.labelColor ?? o.stroke ?? C.ink,
        groups: o.groups,
      }),
      fontSize: size,
      fontFamily: 2,              // 2 = the sans; 1 is the hand-drawn one
      text: o.label,
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: id,
      originalText: o.label,
      lineHeight: 1.25,
      autoResize: true,
    };
    delete t.roundness;
    el.boundElements = [{ type: 'text', id: tid }];
    out.push(el, t);
    return el;
  }
  out.push(el);
  return el;
}

/** Free text — a caption, a screen title. Not bound to anything, deliberately. */
function note(out, o) {
  const id = nextId('n');
  const size = o.size ?? 13;
  const lines = String(o.text).split('\n');
  const el = {
    ...baseEl('text', id, {
      x: o.x,
      y: o.y,
      w: Math.max(...lines.map((l) => textW(l, size))),
      h: textH(size, lines.length),
      stroke: o.color ?? C.muted,
      groups: o.groups,
    }),
    fontSize: size,
    fontFamily: 2,
    text: o.text,
    textAlign: o.align ?? 'left',
    verticalAlign: 'top',
    containerId: null,
    originalText: o.text,
    lineHeight: 1.25,
    autoResize: true,
  };
  delete el.roundness;
  out.push(el);
  return el;
}

function ellipse(out, o) {
  const el = baseEl('ellipse', nextId('e'), o);
  out.push(el);
  return el;
}

function line(out, o) {
  const id = nextId('l');
  const el = {
    ...baseEl('line', id, { ...o, w: o.w, h: o.h ?? 0 }),
    points: [
      [0, 0],
      [o.w, o.h ?? 0],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  };
  el.roundness = null;
  out.push(el);
  return el;
}

/* ── The screens ──────────────────────────────────────────────────────────────── */

/**
 * One phone: the outline, the chrome that is on every standing view, and whatever
 * the caller draws into the space between. Returns the content band so a screen
 * does not have to re-derive where the topbar ended.
 */
function phone(out, { x, y, title, caption, gid, chrome = true }) {
  const g = [gid];
  note(out, { x, y: y - 58, text: title, size: 18, color: C.ink, groups: g });
  // Hand-wrapped, and it has to stay that way: a caption wider than the phone runs
  // under the next screen's title, which is how two screens become unreadable.
  if (caption) note(out, { x, y: y - 32, text: caption, size: 11, groups: g });

  box(out, { x, y, w: M.phoneW, h: M.phoneH, groups: g, stroke: C.ink, strokeWidth: 2 });
  if (!chrome) return { contentTop: y, contentBottom: y + M.phoneH, g };

  // ── the top bar, both rows of it (.topbar wraps; see the comment in style.css)
  const barH = M.topbarPadY * 2 + M.topbarRow + M.topbarGap + M.spacebarRow;
  const r1y = y + M.topbarPadY;
  ellipse(out, { x: x + M.topbarPadX, y: r1y + 12, w: 10, h: 10, fill: C.good, stroke: C.good, groups: g });
  box(out, { x: x + M.topbarPadX + 19, y: r1y + 4, w: 26, h: 26, label: '◈', groups: g, stroke: C.ink });
  box(out, { x: x + M.topbarPadX + 53, y: r1y + 5, w: 74, h: 24, label: '3 waiting', labelSize: 11,
    fill: C.fillWarn, stroke: C.warn, labelColor: C.warn, groups: g });

  const icons = ['⌨', '🗳', '⚖', '⟳'];
  icons.forEach((ic, i) => {
    const bw = 34;
    box(out, {
      x: x + M.phoneW - M.topbarPadX - (icons.length - i) * (bw + 6) + 6,
      y: r1y, w: bw, h: M.topbarRow, label: ic, labelSize: 15, groups: g, stroke: C.muted,
    });
  });

  // the space picker — the second row the bar wraps onto
  const r2y = r1y + M.topbarRow + M.topbarGap;
  box(out, { x: x + M.topbarPadX, y: r2y, w: M.phoneW - M.topbarPadX * 2, h: M.spacebarRow,
    label: 'Work  ·  beadcause  ▾', labelSize: 12, stroke: C.muted, groups: g });

  line(out, { x, y: y + barH, w: M.phoneW, stroke: C.muted, groups: g });

  // ── the filter summary line
  const fy = y + barH + M.filtersPad[0];
  box(out, { x: x + M.filtersPad[1], y: fy, w: 232, h: M.filterRow,
    label: 'Ready · questions, PRs, chats', labelSize: 11, stroke: C.muted, groups: g });

  const contentTop = fy + M.filterRow + M.filtersPad[2];

  // ── the tab bar, which is the same on every standing view
  const ty = y + M.phoneH - M.tabbarH;
  line(out, { x, y: ty, w: M.phoneW, stroke: C.muted, groups: g });
  const tabs = [
    ['📥', 'Inbox'], ['🖥', 'Advocates'], ['🕸', 'Graph'], ['📜', 'History'], ['⏸', 'Admin'],
  ];
  const tw = M.phoneW / tabs.length;
  tabs.forEach(([icon, label], i) => {
    const on = i === 0;
    const tx = x + i * tw;
    note(out, { x: tx + tw / 2 - 9, y: ty + 8, text: icon, size: 17, color: C.ink, groups: g });
    note(out, { x: tx + tw / 2 - textW(label, 10.5) / 2, y: ty + 30, text: label, size: 10.5,
      color: on ? C.accent : C.muted, groups: g });
  });

  return { contentTop, contentBottom: ty, g };
}

/** A collapsed inbox card: the top row, the meta pills, the question. */
function inboxCard(out, { x, y, w, gid, id, ws, prio, question, subtitle, draft, blocks }) {
  const g = [gid];
  const h = M.cardTop + M.cardHeadPadT + M.metaRow + M.metaGapB + textH(15.5, 2) + 14;
  box(out, { x, y, w, h, groups: g, fill: C.fillSurface, stroke: C.ink });

  // .card-top — the details toggle, and nothing else while the card is closed
  box(out, { x: x + 10, y: y + 8, w: 104, h: 26,
    label: draft ? 'Resume answer' : 'Show details', labelSize: 11.5,
    stroke: draft ? C.warn : C.muted, labelColor: draft ? C.warn : C.muted, groups: g });
  if (draft) {
    // .card.has-draft — an inset 3px edge, readable while you scroll past twenty
    box(out, { x, y, w: 3, h, fill: C.warn, stroke: C.warn, sharp: true, groups: g });
  }

  // .meta — the pills, and the time pushed right by margin-left:auto
  const my = y + M.cardTop + M.cardHeadPadT;
  let px = x + M.cardHeadPadX;
  const pills = [[ws, C.muted], [id, C.muted], ...(prio != null ? [[`P${prio}`, C.warn]] : []),
    ...(blocks ? [[`blocks ${blocks}`, C.muted]] : [])];
  for (const [label, col] of pills) {
    const pw = textW(label, 11) + 16;
    box(out, { x: px, y: my, w: pw, h: M.pillH, label, labelSize: 11,
      stroke: col, labelColor: col, fill: col === C.warn ? C.fillWarn : C.transparent, groups: g });
    px += pw + 7;
  }
  note(out, { x: x + w - M.cardHeadPadX - 22, y: my + 4, text: '3h', size: 12, groups: g });

  const qy = my + M.metaRow + M.metaGapB;
  note(out, { x: x + M.cardHeadPadX, y: qy, text: question, size: 15.5, color: C.ink, groups: g });
  if (subtitle) note(out, { x: x + M.cardHeadPadX, y: qy + 21, text: subtitle, size: 12.5, groups: g });
  return h;
}

/* ── Screen: the inbox, in its two states ─────────────────────────────────────── */

function inboxScreen() {
  const out = [];
  const GAP = 120;

  /* A — the list */
  const a = phone(out, {
    x: 0, y: 0, gid: 'scr-list',
    title: 'Inbox — the list',
    caption: 'Everything asking you something, one card each.\nDrag a card to move it; drag the outline to move the screen.',
  });

  let cy = a.contentTop + M.listPadT;
  const cw = M.phoneW - M.listPadX * 2;
  cy += inboxCard(out, { x: M.listPadX, y: cy, w: cw, gid: 'card-1',
    ws: 'beadcause', id: 'bc-l5mw', prio: 2, blocks: 3,
    question: 'Which way should the wireframe round-trip?',
    subtitle: 'A wireframe you can move by hand' }) + M.listGap;
  cy += inboxCard(out, { x: M.listPadX, y: cy, w: cw, gid: 'card-2',
    ws: 'beadcause', id: 'bc-9d37.3', prio: 0, draft: true,
    question: 'Two pull requests conflict — which is ours?' }) + M.listGap;
  inboxCard(out, { x: M.listPadX, y: cy, w: cw, gid: 'card-3',
    ws: 'sophab', id: 'sp-4k1',
    question: 'Should the hero keep the second CTA?' });

  // ＋ over the list, clear of the bar — see .compose-wrap in style.css
  ellipse(out, {
    x: M.phoneW - M.composeInset - M.composeD,
    y: a.contentBottom - M.composeInset - M.composeD,
    w: M.composeD, h: M.composeD, fill: C.fillAccent, stroke: C.accent, groups: ['scr-list'],
  });
  note(out, { x: M.phoneW - M.composeInset - M.composeD / 2 - 8,
    y: a.contentBottom - M.composeInset - M.composeD / 2 - 14,
    text: '＋', size: 24, color: C.accent, groups: ['scr-list'] });

  /* B — a card open: fixed head, scrolling brief, pinned composer */
  const bx = M.phoneW + GAP;
  /* No chrome on this one, and that is the point rather than a shortcut: .card.open
     is `position: fixed; inset: 0` at z-index 40, over a tab bar at 25 and a top bar
     at 20. Drawing the bars here would show a screen the app never renders. */
  const b = phone(out, {
    x: bx, y: 0, gid: 'scr-open', chrome: false,
    title: 'Inbox — a card open',
    caption: 'A fixed full-screen layer over everything, tab bar included.\nHead stays, brief scrolls, composer pinned above the keyboard.',
  });

  const og = ['scr-open'];
  const oy = b.contentTop;
  box(out, { x: bx, y: oy, w: M.phoneW, h: b.contentBottom - oy, fill: '#ffffff', stroke: C.ink, groups: og });

  box(out, { x: bx + 10, y: oy + 8, w: 34, h: 26, label: '⋮', labelSize: 14, stroke: C.muted, groups: og });
  box(out, { x: bx + M.phoneW - 104, y: oy + 8, w: 94, h: 26, label: '↑ Collapse', labelSize: 11.5,
    stroke: C.muted, groups: og });

  const hy = oy + M.cardTop + M.cardHeadPadT;
  note(out, { x: bx + M.cardHeadPadX, y: hy, text: 'beadcause · bc-l5mw · P2', size: 11, groups: og });
  note(out, { x: bx + M.cardHeadPadX, y: hy + 20, text: 'Which way should the wireframe\nround-trip?', size: 15.5, color: C.ink, groups: og });

  const briefY = hy + 74;
  const composerH = 132;
  const briefH = b.contentBottom - briefY - composerH - 10;
  box(out, { x: bx + M.cardHeadPadX, y: briefY, w: M.phoneW - M.cardHeadPadX * 2, h: briefH,
    dashed: true, stroke: C.muted, groups: og,
    label: 'the brief — scrolls on its own', labelSize: 12, labelColor: C.muted });

  // .composer — the reply bar, the box, and the two things you can do with it
  const compY = b.contentBottom - composerH;
  box(out, { x: bx + 10, y: compY, w: M.phoneW - 20, h: composerH - 10, stroke: C.ink, fill: C.fillSurface, groups: og });
  box(out, { x: bx + 20, y: compY + 10, w: 120, h: 24, label: 'reply as ⋯', labelSize: 11, stroke: C.muted, groups: og });
  box(out, { x: bx + 20, y: compY + 42, w: M.phoneW - 40, h: 40, label: 'your answer…', labelSize: 12.5,
    stroke: C.muted, labelColor: C.muted, groups: og });
  box(out, { x: bx + 20, y: compY + 88, w: 40, h: 28, label: '🎤', labelSize: 13, stroke: C.muted, groups: og });
  box(out, { x: bx + M.phoneW - 120, y: compY + 88, w: 100, h: 28, label: 'Answer', labelSize: 12.5,
    fill: C.fillAccent, stroke: C.accent, labelColor: C.accent, groups: og });

  return out;
}

/* ── File assembly, and the checks that keep a broken file off disk ───────────── */

const SCREENS = { inbox: inboxScreen };

function build(name) {
  seq = 0;                                  // ids restart per file, so diffs stay local
  const elements = SCREENS[name]();
  validate(elements);
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://github.com/neadamthal/beadcause',
    elements,
    appState: { gridSize: 20, gridStep: 5, gridModeEnabled: true, viewBackgroundColor: '#ffffff' },
    files: {},
  };
}

/** The three ways a hand-assembled Excalidraw file is silently wrong. */
function validate(els) {
  const byId = new Map();
  for (const e of els) {
    if (byId.has(e.id)) throw new Error(`duplicate element id ${e.id}`);
    byId.set(e.id, e);
  }
  for (const e of els) {
    if (e.containerId && !byId.has(e.containerId)) {
      throw new Error(`text ${e.id} is bound to a container that is not in the file`);
    }
    for (const b of e.boundElements || []) {
      if (!byId.has(b.id)) throw new Error(`${e.id} claims a bound element ${b.id} that is not in the file`);
      if (byId.get(b.id).containerId !== e.id) {
        throw new Error(`${e.id} and ${b.id} disagree about their binding — the label would not move with the box`);
      }
    }
    for (const k of ['x', 'y', 'width', 'height']) {
      if (!Number.isFinite(e[k])) throw new Error(`${e.id} has a non-finite ${k}`);
    }
  }
}

const argv = process.argv.slice(2);
const mode = argv.includes('--write') ? 'write' : 'check';
const only = argv.find((a) => !a.startsWith('--'));
const names = only ? [only] : Object.keys(SCREENS);
let drift = 0;

for (const name of names) {
  if (!SCREENS[name]) {
    console.error(`no such screen: ${name} (have: ${Object.keys(SCREENS).join(', ')})`);
    process.exit(2);
  }
  const path = join(HERE, `${name}.excalidraw`);
  const doc = build(name);
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  if (mode === 'write') {
    writeFileSync(path, json);
    console.log(`wrote ${path} — ${doc.elements.length} elements`);
  } else if (!existsSync(path)) {
    console.log(`${name}: not seeded yet — run --write ${name}`);
    drift++;
  } else if (readFileSync(path, 'utf8') === json) {
    console.log(`${name}: unchanged from the generated layout — nothing has been moved yet`);
  } else {
    console.log(`${name}: HAS BEEN EDITED BY HAND — do not --write over it`);
    drift++;
  }
}
/* Drift is the desired state, not a failure: the file exists to collect hand edits.
   So this never exits non-zero, and npm test has no business gating on it. */
if (mode === 'check' && drift) console.log(`\n${drift} screen(s) carry hand edits — read the file, do not regenerate it.`);
