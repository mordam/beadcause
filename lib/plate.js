/**
 * `bin/b7e-plate` — one labelled montage PNG from a directory or list of images, so a
 * session that needs to *look at* several stills answers that in a single `Read` call
 * instead of building its own rig.
 *
 * bc-dgx7.91, filed by the session audit (`lib/sessionaudit.js`) against three deluvia
 * publicity sessions (`dv-2uu.6`, `dv-2uu.5`, `dv-2uu.3`) that each hand-built a version
 * of this: a `sips` batch resize plus twelve separate `Read` calls (one per file, then
 * done twice more at other widths), six raw full-resolution `Read`s straight off disk,
 * and three different hand-rolled PIL scripts (a montage, a second montage, a crop-and-
 * enlarge). This is the one answer, and it prints the source filenames in tile order and
 * each source's *native* dimensions, not the tile's — dv-2uu.3's montage script printed
 * exactly that pairing by hand.
 *
 * The bead's own text named ffmpeg's `tile` filter for the compositing, but the ffmpeg on
 * this machine (homebrew, 8.1.1) was built without libfreetype — `ffmpeg -filters` has no
 * `drawtext` line — so a sheet built that way would have no filenames on it, which is the
 * one thing three sessions kept re-deriving by hand. `python3`'s Pillow, already on this
 * machine and what `dv-2uu.3` used directly three times over, does the compositing and
 * the labelling in ffmpeg's place. `sips` still does the one thing it is uniquely cheap
 * at: reading a whole batch of native dimensions in a single call, which is what "the
 * reported dimensions are the source's, not the sheet's" needs — one process instead of
 * one per file.
 *
 * Both external tools are reached through an injectable `tools` object (`{ sips, python
 * }`) so `test/plate.mjs` can exercise every bit of target resolution, `--max` capping,
 * grid planning and crop math — which is all of what the three sessions actually got
 * wrong — without either tool needing to exist on whatever machine runs the suite.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, '..');

/** Non-recursive directory expansion only looks at these — a stray `.DS_Store` or a
 * subdirectory of thumbnails is never silently pulled onto the sheet. */
export const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.webp',
]);

export function isImageFile(p) {
  return IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase());
}

/**
 * Every `<path|glob>` target, in the order given, turned into one ordered, deduplicated
 * list of absolute file paths. A directory expands to its own recognised image files,
 * sorted by name, non-recursively. A string holding a glob metacharacter (`* ? [`) is
 * expanded with `fs.globSync`, relative to `cwd`, and filtered to real files (a glob
 * that happens to match a directory is not silently walked into). Anything else is a
 * literal path. Nothing that fails to resolve throws here — it is collected in
 * `problems` so a caller can decide whether an empty result is fatal.
 */
export function resolveTargets(targets, { cwd = process.cwd() } = {}) {
  const seen = new Set();
  const files = [];
  const problems = [];

  const add = (abs) => {
    if (!seen.has(abs)) {
      seen.add(abs);
      files.push(abs);
    }
  };

  for (const target of targets) {
    const abs = path.isAbsolute(target) ? target : path.join(cwd, target);
    if (/[*?[\]]/.test(target)) {
      const matches = fs
        .globSync(target, { cwd })
        .map((m) => path.join(cwd, m))
        .filter((m) => fs.statSync(m).isFile())
        .sort();
      if (matches.length === 0) problems.push(`${target}: matched nothing`);
      matches.forEach(add);
    } else if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const matches = fs
        .readdirSync(abs)
        .filter(isImageFile)
        .sort()
        .map((f) => path.join(abs, f));
      if (matches.length === 0) problems.push(`${target}: directory holds no recognised image file`);
      matches.forEach(add);
    } else if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      add(abs);
    } else {
      problems.push(`${target}: no such file or directory`);
    }
  }

  return { files, problems };
}

/**
 * The first `max` files, in resolved order, and what got left out — never a silent
 * truncation. `max` of `0` (or unset) is "no cap".
 */
export function applyMax(files, max) {
  if (!max || max <= 0 || files.length <= max) return { kept: files, dropped: [] };
  return { kept: files.slice(0, max), dropped: files.slice(max) };
}

/** `ceil(sqrt(n))` columns by default — near-square, which is what a contact sheet wants. */
export function planCols(n, cols) {
  if (cols && cols > 0) return Math.min(cols, Math.max(1, n));
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))));
}

/**
 * `--crop x,y,w,h` → `{x,y,w,h}`, four non-negative integers with `w` and `h` positive.
 * Refused rather than clamped on a bad shape — clamping a typo silently is how a session
 * ends up looking at the wrong sixteen pixels and not knowing it.
 */
export function parseCrop(spec) {
  const parts = String(spec).split(',').map(Number);
  const ok =
    parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0) && parts[2] > 0 && parts[3] > 0;
  if (!ok) {
    throw new Error(`--crop wants x,y,w,h — four non-negative integers, w and h positive — got "${spec}"`);
  }
  const [x, y, w, h] = parts;
  return { x, y, w, h };
}

const SIPS_PROP_RE = /^\s{2}(\w+):\s*(.+)$/;

/**
 * `sips -g pixelWidth -g pixelHeight -g format <files>` prints one header line (the
 * path, exactly as given — which may not equal the path this passed in, since `sips`
 * resolves `/tmp` to `/private/tmp` on this machine) followed by indented `key: value`
 * lines, per file, in the order given. Parsed positionally rather than by matching the
 * header back to a path for exactly that reason.
 */
export function parseSipsBatch(output) {
  const blocks = [];
  let current = null;
  for (const rawLine of output.split('\n')) {
    if (!rawLine) continue;
    if (!rawLine.startsWith(' ')) {
      current = { header: rawLine.trim(), props: {} };
      blocks.push(current);
      continue;
    }
    const m = rawLine.match(SIPS_PROP_RE);
    if (m && current) {
      const [, key, value] = m;
      if (key === 'pixelWidth' || key === 'pixelHeight') current.props[key] = Number(value);
      else if (key === 'format') current.props.format = value;
    }
  }
  return blocks;
}

function defaultSips(files) {
  return spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', ...files], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Native `{width, height, format}` for each of `files`, one `sips` call for the batch. */
export function nativeDimensions(files, { sips = defaultSips } = {}) {
  const out = new Map();
  if (files.length === 0) return out;
  const { status, stdout, stderr, error } = sips(files);
  if (error) throw new Error(`sips is not runnable: ${error.message}`);
  if (status !== 0) throw new Error(`sips failed reading dimensions: ${stderr || stdout}`);
  const blocks = parseSipsBatch(stdout);
  files.forEach((f, i) => {
    const props = blocks[i] && blocks[i].props;
    if (!props || !props.pixelWidth || !props.pixelHeight) {
      throw new Error(`sips reported no dimensions for ${f}`);
    }
    out.set(f, { width: props.pixelWidth, height: props.pixelHeight, format: props.format });
  });
  return out;
}

/**
 * The compositing itself, in Pillow rather than ffmpeg's `tile` (see file header for
 * why) — a grid of resized, labelled tiles, or (`mode: 'crop'`) one enlarged region of
 * one source. Deterministic: `ImageFont.load_default()` is a bundled bitmap font, not a
 * system one, so this owes nothing to what fonts happen to be installed, and nothing in
 * the job carries a timestamp — two calls with the same job produce byte-identical PNGs.
 */
const RENDER_SCRIPT = `
import sys, json
from PIL import Image, ImageDraw, ImageFont

job = json.load(sys.stdin)


def load(p):
    return Image.open(p).convert('RGB')


if job['mode'] == 'crop':
    im = load(job['crop']['path'])
    x, y, w, h = job['crop']['x'], job['crop']['y'], job['crop']['w'], job['crop']['h']
    box = (x, y, min(x + w, im.width), min(y + h, im.height))
    out = im.crop(box)
    out.save(job['out'])
    print(json.dumps({'width': out.width, 'height': out.height}))
    sys.exit(0)

tile_w = job['tileWidth']
cols = job['cols']
label_h = job['labelHeight']
pad = job['padding']
font = ImageFont.load_default()

tiles = []
for t in job['tiles']:
    im = load(t['path'])
    scale = tile_w / im.width
    th = max(1, round(im.height * scale))
    tiles.append((im.resize((tile_w, th)), t['label']))

rows = (len(tiles) + cols - 1) // cols
row_heights = [0] * rows
for i, (im, _label) in enumerate(tiles):
    r = i // cols
    row_heights[r] = max(row_heights[r], im.height)

canvas_w = pad + cols * (tile_w + pad)
canvas_h = pad + sum(rh + label_h + pad for rh in row_heights)
canvas = Image.new('RGB', (canvas_w, canvas_h), (24, 24, 24))
draw = ImageDraw.Draw(canvas)

y = pad
for r in range(rows):
    x = pad
    for c in range(cols):
        i = r * cols + c
        if i >= len(tiles):
            break
        im, label = tiles[i]
        canvas.paste(im, (x, y))
        bbox = draw.textbbox((0, 0), label, font=font)
        tw = bbox[2] - bbox[0]
        tx = x + max(0, (tile_w - tw) // 2)
        draw.text((tx, y + row_heights[r] + 2), label, fill=(255, 255, 255), font=font)
        x += tile_w + pad
    y += row_heights[r] + label_h + pad

canvas.save(job['out'])
print(json.dumps({'width': canvas.width, 'height': canvas.height}))
`;

function defaultPython(job) {
  return spawnSync('python3', ['-c', RENDER_SCRIPT], {
    input: JSON.stringify(job),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

export function renderComposite(job, { python = defaultPython } = {}) {
  const { status, stdout, stderr, error } = python(job);
  if (error) throw new Error(`python3 is not runnable: ${error.message}`);
  if (status !== 0) throw new Error(`plate render failed: ${stderr || stdout}`);
  const lastLine = stdout.trim().split('\n').pop();
  return JSON.parse(lastLine);
}

/** Whether the two external tools this needs are actually usable, for a caller that
 * wants to skip rather than crash — the same shape `test/adoptsweepreal.mjs` uses for
 * `bd`. */
export function toolsAvailable() {
  const sipsCheck = spawnSync('sips', ['--help'], { encoding: 'utf8' });
  const pyCheck = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
  return { sips: !sipsCheck.error, pil: !pyCheck.error && pyCheck.status === 0 };
}

/** A fresh temp file, never inside a checkout — the default when `--out` is not given. */
function defaultOutPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7e-plate-'));
  return path.join(dir, 'plate.png');
}

/**
 * The whole command, minus argv parsing and printing: resolve targets, cap at `--max`,
 * read native dimensions, render (grid or, with `crop`, one enlarged region), and hand
 * back a manifest a caller can print or serialise as `--json`.
 */
export function buildPlate(opts, tools = {}) {
  const { targets, max = 0, cols: colsArg = 0, width = 320, crop = null, out = null, cwd = process.cwd() } =
    opts;

  const { files, problems } = resolveTargets(targets, { cwd });
  if (files.length === 0) {
    const why = problems.length ? ` (${problems.join('; ')})` : '';
    throw new Error(`no image files resolved from: ${targets.join(', ')}${why}`);
  }

  const outPath = out ? path.resolve(cwd, out) : defaultOutPath();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (crop) {
    if (files.length !== 1) {
      throw new Error(`--crop takes exactly one source image, got ${files.length}`);
    }
    const box = parseCrop(crop);
    const source = files[0];
    const dims = nativeDimensions(files, tools);
    const native = dims.get(source);
    const rendered = renderComposite({ mode: 'crop', crop: { path: source, ...box }, out: outPath }, tools);
    return {
      mode: 'crop',
      outPath,
      source,
      sourceNativeWidth: native.width,
      sourceNativeHeight: native.height,
      box,
      renderedWidth: rendered.width,
      renderedHeight: rendered.height,
      problems,
    };
  }

  const { kept, dropped } = applyMax(files, max);
  const dims = nativeDimensions(kept, tools);
  const cols = planCols(kept.length, colsArg);
  const rows = Math.ceil(kept.length / cols);

  const renderTiles = kept.map((f, i) => ({ path: f, label: `${i + 1}. ${path.basename(f)}` }));
  const rendered = renderComposite(
    { mode: 'grid', tiles: renderTiles, tileWidth: width, cols, labelHeight: 18, padding: 8, out: outPath },
    tools
  );

  return {
    mode: 'grid',
    outPath,
    cols,
    rows,
    renderedWidth: rendered.width,
    renderedHeight: rendered.height,
    tiles: kept.map((f, i) => ({
      index: i + 1,
      file: f,
      nativeWidth: dims.get(f).width,
      nativeHeight: dims.get(f).height,
    })),
    dropped,
    problems,
  };
}
