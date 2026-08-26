#!/usr/bin/env node
//
// b7e-plate — one labelled montage PNG from a directory or list of images (bc-dgx7.91).
// Three deluvia sessions (dv-2uu.6, dv-2uu.5, dv-2uu.3) each hand-built a version of
// this — a sips batch plus twelve Reads, six raw full-resolution Reads, three different
// PIL scripts — for the same underlying question. This is that command.
//
//   npm test
//   node test/plate.mjs
//
// Two kinds of proof, the same split test/count.mjs uses for the same reason: everything
// in lib/plate.js that is actually logic — target resolution (directory/glob/literal,
// non-recursive, deduplicated), --max capping, grid planning, crop math, the sips batch
// parser — is exercised directly with tiny fabricated inputs and injected fake `sips`/
// `python3` calls, so it needs neither tool on the machine the suite happens to run on.
// bin/b7e-plate is then driven as a real subprocess against real fixture images built
// with Pillow, but ONLY when sips and python3+Pillow are actually runnable here — skipped
// loudly otherwise, the same shape test/adoptsweepreal.mjs uses for a missing `bd`: a
// machine without the tools cannot answer "does the real render work", and failing there
// would say something untrue about the code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_EXTENSIONS,
  applyMax,
  buildPlate,
  isImageFile,
  nativeDimensions,
  parseCrop,
  parseSipsBatch,
  planCols,
  resolveTargets,
} from '../lib/plate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-plate');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nb7e-plate\n');

/* ============================================================== lib/plate.js */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-plate-'));
const imagesDir = path.join(tmp, 'images');
fs.mkdirSync(imagesDir);
// Mirrors dv-2uu.6's real directory shape: img_000..img_003 plus a differently-named
// file, and a non-image neighbour that a directory expansion must never pick up.
['img_000.png', 'img_001.png', 'img_002.png', 'img_003.png', 'title_card.png'].forEach((f) =>
  fs.writeFileSync(path.join(imagesDir, f), 'not a real png, just bytes for resolution tests')
);
fs.writeFileSync(path.join(imagesDir, '.DS_Store'), 'nope');
fs.writeFileSync(path.join(imagesDir, 'notes.txt'), 'nope');
fs.mkdirSync(path.join(imagesDir, 'thumbs'));
fs.writeFileSync(path.join(imagesDir, 'thumbs', 'img_000.png'), 'must not appear — not recursive');

check('isImageFile knows the recognised extensions and nothing else', () => {
  assert.equal(isImageFile('a.png'), true);
  assert.equal(isImageFile('a.PNG'), true);
  assert.equal(isImageFile('a.heic'), true);
  assert.equal(isImageFile('a.txt'), false);
  assert.equal(isImageFile('a'), false);
  assert.ok(IMAGE_EXTENSIONS.has('.webp'));
});

check('a directory resolves to its own image files, sorted, not recursive, no dotfiles', () => {
  const { files, problems } = resolveTargets([imagesDir], { cwd: tmp });
  assert.deepEqual(
    files.map((f) => path.basename(f)),
    ['img_000.png', 'img_001.png', 'img_002.png', 'img_003.png', 'title_card.png']
  );
  assert.equal(problems.length, 0);
});

check('a glob expands relative to cwd, in sorted order, files only', () => {
  const { files } = resolveTargets(['images/img_*.png'], { cwd: tmp });
  assert.deepEqual(
    files.map((f) => path.basename(f)),
    ['img_000.png', 'img_001.png', 'img_002.png', 'img_003.png']
  );
});

check('a literal path resolves to itself; a missing target is a problem, not a throw', () => {
  const one = path.join(imagesDir, 'img_000.png');
  const { files, problems } = resolveTargets([one, 'nope-does-not-exist.png'], { cwd: tmp });
  assert.deepEqual(files, [one]);
  assert.match(problems[0], /no such file or directory/);
});

check('targets are deduplicated, keeping first-seen order across overlapping globs', () => {
  const { files } = resolveTargets(['images/img_000.png', 'images/img_*.png'], { cwd: tmp });
  assert.deepEqual(
    files.map((f) => path.basename(f)),
    ['img_000.png', 'img_001.png', 'img_002.png', 'img_003.png']
  );
});

check('an empty directory is a problem naming the target, not a silent empty list', () => {
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty);
  const { files, problems } = resolveTargets([empty], { cwd: tmp });
  assert.equal(files.length, 0);
  assert.match(problems[0], /holds no recognised image file/);
});

check('applyMax caps at the first N in resolved order and names what was dropped', () => {
  const { kept, dropped } = applyMax(['a', 'b', 'c', 'd'], 2);
  assert.deepEqual(kept, ['a', 'b']);
  assert.deepEqual(dropped, ['c', 'd']);
});

check('applyMax with 0 (or unset) is no cap', () => {
  assert.deepEqual(applyMax(['a', 'b'], 0), { kept: ['a', 'b'], dropped: [] });
  assert.deepEqual(applyMax(['a', 'b'], undefined), { kept: ['a', 'b'], dropped: [] });
});

check('applyMax past the end of the list keeps everything, drops nothing', () => {
  assert.deepEqual(applyMax(['a', 'b'], 10), { kept: ['a', 'b'], dropped: [] });
});

check('planCols defaults to near-square (ceil(sqrt(n))), an explicit --cols wins, capped at n', () => {
  assert.equal(planCols(4, 0), 2);
  assert.equal(planCols(5, 0), 3);
  assert.equal(planCols(1, 0), 1);
  assert.equal(planCols(5, 2), 2);
  assert.equal(planCols(2, 9), 2);
});

check('parseCrop accepts x,y,w,h and refuses anything else', () => {
  assert.deepEqual(parseCrop('10,20,300,150'), { x: 10, y: 20, w: 300, h: 150 });
  assert.throws(() => parseCrop('10,20,300'), /wants x,y,w,h/);
  assert.throws(() => parseCrop('-1,0,10,10'), /wants x,y,w,h/);
  assert.throws(() => parseCrop('0,0,0,10'), /wants x,y,w,h/);
  assert.throws(() => parseCrop('0,0,10,10.5'), /wants x,y,w,h/);
});

// The exact shape `sips -g pixelWidth -g pixelHeight -g format <files>` was measured to
// print on this machine: one header line per file (the path, exactly as sips echoes it
// back — which can differ from the path passed in, e.g. /tmp resolved to /private/tmp),
// then two-space-indented `key: value` lines.
const SIPS_SAMPLE = [
  '/private/tmp/a.png',
  '  pixelWidth: 300',
  '  pixelHeight: 200',
  '  format: png',
  '/private/tmp/b.jpg',
  '  pixelWidth: 150',
  '  pixelHeight: 150',
  '  format: jpeg',
  '',
].join('\n');

check('parseSipsBatch reads header + indented properties, one block per file, in order', () => {
  const blocks = parseSipsBatch(SIPS_SAMPLE);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].props, { pixelWidth: 300, pixelHeight: 200, format: 'png' });
  assert.deepEqual(blocks[1].props, { pixelWidth: 150, pixelHeight: 150, format: 'jpeg' });
});

check('nativeDimensions zips its own file list against sips output positionally', () => {
  const fakeSips = () => ({ status: 0, stdout: SIPS_SAMPLE, stderr: '' });
  const dims = nativeDimensions(['a.png', 'b.jpg'], { sips: fakeSips });
  assert.deepEqual(dims.get('a.png'), { width: 300, height: 200, format: 'png' });
  assert.deepEqual(dims.get('b.jpg'), { width: 150, height: 150, format: 'jpeg' });
});

check('nativeDimensions surfaces a sips failure rather than returning partial data', () => {
  const fakeSips = () => ({ status: 1, stdout: '', stderr: 'sips: bad format' });
  assert.throws(() => nativeDimensions(['a.png'], { sips: fakeSips }), /sips failed/);
});

/* --- buildPlate end to end, with both external tools injected as fakes --- */

// A fake `sips` that answers from a table keyed by basename, in the batch shape above —
// exercises the full grid pipeline (target resolution, --max, dimension lookup, grid
// planning, the render job actually built) without needing sips or Pillow to exist.
function fakeSipsFor(sizes) {
  return (files) => {
    const stdout = files
      .map((f) => {
        const s = sizes[path.basename(f)] || { w: 100, h: 100 };
        return `${f}\n  pixelWidth: ${s.w}\n  pixelHeight: ${s.h}\n  format: png\n`;
      })
      .join('');
    return { status: 0, stdout, stderr: '' };
  };
}

let lastRenderJob = null;
const fakePython = (job) => {
  lastRenderJob = job;
  const dims = job.mode === 'crop' ? { width: job.crop.w, height: job.crop.h } : { width: 999, height: 888 };
  fs.writeFileSync(job.out, `fake-render:${JSON.stringify(job)}`);
  return { status: 0, stdout: JSON.stringify(dims), stderr: '' };
};

check('buildPlate honours --max, reports native (not tile) dimensions, in resolved order', () => {
  const sizes = {
    'img_000.png': { w: 1376, h: 768 },
    'img_001.png': { w: 1376, h: 768 },
    'img_002.png': { w: 1376, h: 768 },
    'img_003.png': { w: 1376, h: 768 },
    'title_card.png': { w: 1920, h: 1080 },
  };
  const manifest = buildPlate(
    { targets: [imagesDir], max: 3, cwd: tmp },
    { sips: fakeSipsFor(sizes), python: fakePython }
  );
  assert.equal(manifest.mode, 'grid');
  assert.equal(manifest.tiles.length, 3);
  assert.deepEqual(
    manifest.tiles.map((t) => t.file.slice(-11)),
    ['img_000.png', 'img_001.png', 'img_002.png']
  );
  assert.deepEqual(
    manifest.tiles.map((t) => [t.nativeWidth, t.nativeHeight]),
    [
      [1376, 768],
      [1376, 768],
      [1376, 768],
    ]
  );
  assert.equal(manifest.dropped.length, 2);
  assert.ok(manifest.dropped[0].endsWith('img_003.png'));
  assert.equal(lastRenderJob.tiles.length, 3);
  assert.deepEqual(
    lastRenderJob.tiles.map((t) => t.label),
    ['1. img_000.png', '2. img_001.png', '3. img_002.png']
  );
});

check('buildPlate with --crop takes exactly one target and reports the source native size', () => {
  const one = path.join(imagesDir, 'img_000.png');
  const sizes = { 'img_000.png': { w: 1376, h: 768 } };
  const manifest = buildPlate(
    { targets: [one], crop: '100,50,240,180', cwd: tmp },
    { sips: fakeSipsFor(sizes), python: fakePython }
  );
  assert.equal(manifest.mode, 'crop');
  assert.equal(manifest.sourceNativeWidth, 1376);
  assert.equal(manifest.sourceNativeHeight, 768);
  assert.deepEqual(manifest.box, { x: 100, y: 50, w: 240, h: 180 });
});

check('buildPlate with --crop over more than one resolved target is refused', () => {
  assert.throws(
    () => buildPlate({ targets: [imagesDir], crop: '0,0,10,10', cwd: tmp }, { sips: fakeSipsFor({}), python: fakePython }),
    /--crop takes exactly one/
  );
});

check('buildPlate with no resolvable target is refused, naming what was tried', () => {
  assert.throws(
    () => buildPlate({ targets: ['nope.png'], cwd: tmp }, { sips: fakeSipsFor({}), python: fakePython }),
    /no image files resolved from: nope\.png/
  );
});

check('two buildPlate calls against the same input produce the same manifest shape', () => {
  const sizes = { 'img_000.png': { w: 1376, h: 768 } };
  const out = path.join(tmp, 'twice.png');
  const opts = { targets: [path.join(imagesDir, 'img_000.png')], out, cwd: tmp };
  const tools = { sips: fakeSipsFor(sizes), python: fakePython };
  const first = buildPlate(opts, tools);
  const second = buildPlate(opts, tools);
  assert.equal(first.outPath, second.outPath);
  assert.deepEqual(first.tiles, second.tiles);
});

/* ============================================================== bin/b7e-plate (argv) */

const run = (args) => spawnSync('node', [BIN, ...args], { encoding: 'utf8', cwd: tmp });

check('bin/b7e-plate --help prints usage and exits 0 without touching any tool', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-plate/);
});

check('bin/b7e-plate with no targets is refused with exit 2', () => {
  const { status, stderr } = run([]);
  assert.equal(status, 2);
  assert.match(stderr, /needs at least one/);
});

check('bin/b7e-plate --crop with a bad shape is refused before any tool runs', () => {
  const { status, stderr } = run(['images/img_000.png', '--crop', 'nope']);
  assert.equal(status, 2);
  assert.match(stderr, /--crop wants x,y,w,h|not runnable|Pillow/);
});

/* =========================================================== real render, if available */

const availability = spawnSync('sips', ['--help'], { encoding: 'utf8' });
const pilCheck = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
const toolsHere = !availability.error && !pilCheck.error && pilCheck.status === 0;

if (!toolsHere) {
  console.log('  \x1b[33m—\x1b[0m skipped: sips and python3+Pillow are not both runnable here, so the real render cannot be asked');
} else {
  const realDir = path.join(tmp, 'real');
  fs.mkdirSync(realDir);
  const buildFixturePy = `
from PIL import Image
colors = [(200,80,60),(60,150,200),(90,200,90),(200,200,60)]
for i, c in enumerate(colors):
    Image.new('RGB', (400 + i * 10, 300), c).save('${realDir}/img_%03d.png' % i)
`;
  const gen = spawnSync('python3', ['-c', buildFixturePy], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  check('a real run over a directory prints the path and native dims in tile order', () => {
    const { status, stdout } = run([realDir]);
    assert.equal(status, 0, stdout);
    const lines = stdout.trim().split('\n');
    assert.ok(fs.existsSync(lines[0]), `expected ${lines[0]} to exist`);
    assert.equal(lines[1], `1  ${path.join(realDir, 'img_000.png')}  400x300`);
    assert.equal(lines[2], `2  ${path.join(realDir, 'img_001.png')}  410x300`);
    assert.equal(lines[3], `3  ${path.join(realDir, 'img_002.png')}  420x300`);
    assert.equal(lines[4], `4  ${path.join(realDir, 'img_003.png')}  430x300`);
  });

  check('--max on a real directory honours the cap and reports what was dropped', () => {
    const { status, stdout } = run([realDir, '--max', '2']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /2 tiles, 2 cols x 1 rows/);
    assert.match(stdout, /--max dropped 2:/);
  });

  check('a second real run over the same input and --out is byte-identical (idempotent)', () => {
    const out1 = path.join(tmp, 'idem1.png');
    const out2 = path.join(tmp, 'idem2.png');
    const r1 = run([realDir, '--out', out1]);
    const r2 = run([realDir, '--out', out2]);
    assert.equal(r1.status, 0, r1.stdout);
    assert.equal(r2.status, 0, r2.stdout);
    assert.ok(fs.readFileSync(out1).equals(fs.readFileSync(out2)));
  });

  check('--crop writes an enlarged region and reports the source native size, not the crop size', () => {
    const one = path.join(realDir, 'img_000.png');
    const outCrop = path.join(tmp, 'crop.png');
    const { status, stdout } = run([one, '--crop', '50,50,100,100', '--out', outCrop]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /native 400x300/);
    assert.ok(fs.existsSync(outCrop));
  });
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exitCode = failures ? 1 : 0;
