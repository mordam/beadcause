#!/usr/bin/env node
/**
 * The graph's auto-fit — the transform math, not the measurement.
 *
 *     npm test
 *     node test/graphfit.mjs
 *
 * fit() (public/graph.js) used to build the extent it frames from node *centres*
 * plus/minus the box constant (NODE_W/2, NODE_H/2) and a fixed pad — a box that
 * looks like what is drawn but isn't: a long title runs past it (clip(d.title, 20)
 * at font-size 10.5) and a claimed bead's pulse swells its stroke past it too, both
 * landing on whichever bead ends up outermost. phone-check.mjs caught it as "226 of
 * 226 beads visible, worst bead 5px outside the canvas" on the live cl- graph
 * (bc-nc6o.11) — correct by the letter of the old box, wrong by the pixels on
 * screen.
 *
 * The fix measures the scene's own drawn extent (gNodes.node().getBBox()) instead,
 * which needs a live SVG and can't be pinned here. What *can* be pinned, and is
 * pinned below, is the part of fit() that turns an extent into a transform: the
 * `Math.min(1, …)` clamp that refuses to magnify a small graph, and the
 * `zoom.scaleExtent` floor that follows the fit down (both carry comments in
 * public/graph.js about live bugs they fixed — this test exists so neither one
 * regresses silently under a refactor of the part around them).
 *
 * **How it runs the real code.** public/graph.js is one big IIFE over a live DOM
 * and a d3 canvas and cannot be imported. `fitTransform` itself is pure — no DOM,
 * no simulation, just an extent and a viewport — so its function body is sliced out
 * of the file by name and evaluated on its own in a vm. A change that renames it or
 * moves the clamp/floor logic out of it fails loudly here rather than passing
 * quietly against a copy of math the page no longer runs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GRAPH = fs.readFileSync(path.join(ROOT, 'public/graph.js'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n')[0]}`);
  }
};

/* ------------------------------------------------- the real code, in a bare room */

const START = 'function fitTransform(';
const from = GRAPH.indexOf(START);
if (from < 0) {
  console.log('  \x1b[31m✗\x1b[0m public/graph.js no longer has a fitTransform function to slice');
  process.exit(1);
}
// Through the line-initial `  }` that closes the function.
const close = GRAPH.indexOf('\n  }', from);
if (close < 0) {
  console.log('  \x1b[31m✗\x1b[0m could not find the end of fitTransform');
  process.exit(1);
}
const region = GRAPH.slice(from, close + 4);

const ctx = vm.createContext({});
const { fitTransform } = vm.runInContext(`${region}\n;({ fitTransform })`, ctx, {
  filename: 'graph.js#fitTransform',
});

/* ------------------------------------------------------------------ the checks */

console.log('\nfitting an extent into a viewport');

check('a graph bigger than the viewport shrinks to fit the tighter axis', () => {
  // 1000x400 extent into a 393x852 viewport (roughly the iPhone check): width is
  // the binding constraint.
  const { k } = fitTransform(0, 0, 1000, 400, 393, 852, 0.15, 3);
  assert.ok(Math.abs(k - 393 / 1000) < 1e-9, `k was ${k}, expected 393/1000`);
});

check('never magnifies past 1:1, however small the graph', () => {
  // A tiny extent that would need to grow 10x to fill the viewport stays at 1.
  const { k } = fitTransform(0, 0, 40, 40, 393, 852, 0.15, 3);
  assert.equal(k, 1, `k was ${k}, a small graph was magnified past 1:1`);
});

check('the scale floor follows the fit down when the fit lands below it', () => {
  // deluvia's shape: a graph wide enough that the fit itself lands under ZOOM_MIN.
  const { k, scaleFloor } = fitTransform(0, 0, 3000, 800, 393, 852, 0.15, 3);
  assert.ok(k < 0.15, `fixture is wrong — k=${k} is not below the 0.15 floor`);
  assert.equal(scaleFloor, k, `scaleFloor was ${scaleFloor}, expected it to follow k down to ${k}`);
});

check('the scale floor stays put when the fit lands above it', () => {
  const { k, scaleFloor } = fitTransform(0, 0, 200, 200, 393, 852, 0.15, 3);
  assert.ok(k > 0.15, `fixture is wrong — k=${k} is not above the 0.15 floor`);
  assert.equal(scaleFloor, 0.15, `scaleFloor was ${scaleFloor}, expected it to stay at the configured 0.15`);
});

check('the transform centres the extent in the viewport', () => {
  const { k, tx, ty } = fitTransform(0, 0, 400, 800, 400, 800, 0.15, 3);
  assert.equal(k, 1);
  // Extent already matches the viewport exactly, so no translation is needed.
  assert.ok(Math.abs(tx) < 1e-9, `tx was ${tx}, expected 0`);
  assert.ok(Math.abs(ty) < 1e-9, `ty was ${ty}, expected 0`);
});

check('an off-centre extent is translated back to the middle of the viewport', () => {
  // Extent [100,900] on x (centre 500) fit at k=1 into an 800-wide viewport (centre
  // 400): tx has to slide it left by 100 to land on-centre.
  const { k, tx } = fitTransform(100, 0, 900, 400, 800, 400, 0.15, 3);
  assert.equal(k, 1);
  assert.ok(Math.abs(tx - -100) < 1e-9, `tx was ${tx}, expected -100`);
});

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
