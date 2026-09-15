/**
 * `b7e-episode` — the facts three deluvia sessions (dv-2uu.6, dv-2uu.5, dv-2uu.3) each
 * re-derived by hand about one `webseries/episodes/<name>/` directory before a single
 * post about it could be written. See `bin/b7e-episode` for the fuller history and the
 * argv/printing half; this module is the measurement.
 *
 * `computeBeats` is a line-for-line reimplementation of `webseries/make_episode.py`'s own
 * `build_beats(lines, total)` — verified against the real `kazran-orves` episode: called
 * with `total = duration(audio.mp3)` (470.755750s, the narration track *before* the
 * `TITLE_SEC` intro is prepended) and each start offset by `TITLE_SEC`, its 12 beat starts
 * land at 4.0, 47.3, 87.833333, 130.733333, 170.1, 210.633333, 253.933333, 293.7, 336.2,
 * 377.133333, 419.633333, 459.4 — an EXACT match, to the millisecond, for every boundary
 * `ffmpeg`'s own scene-detect finds in the rendered `kazran-orves.mp4` at any threshold
 * from 0.1 to 0.3. `transcript.json`'s 14 entries are the raw narration paragraphs fed
 * into `build_beats`, not the beat count itself — `build_beats` resplits at sentence
 * boundaries and regroups by word count into `n = max(5, min(12, round(total/28)))`
 * beats, which is 12 here. A bead or comment that says "14 beats" for this episode is
 * counting paragraphs, not beats; report both, but the beat count that matches the video
 * is `beats.length`, not `transcript.length`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const TITLE_SEC = 4.0;

export function repoRoot(cwd = process.cwd(), fallback = cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

/**
 * A bare name (no path separator) resolves under `<root>/webseries/episodes/<name>` when
 * that directory exists; otherwise (and for anything containing a separator, or absolute)
 * it is a path, relative to `cwd` if not absolute — the same split `resolveBookDir` in
 * `lib/manifest.js` (bc-dgx7.103) uses for a bare book number, duplicated rather than
 * imported because that module is on an unlanded branch (dont-import-an-unmerged-siblings-module).
 */
export function resolveEpisodeDir(nameOrPath, { root, cwd = process.cwd() } = {}) {
  if (path.isAbsolute(nameOrPath) || nameOrPath.includes('/')) {
    return path.isAbsolute(nameOrPath) ? nameOrPath : path.join(cwd, nameOrPath);
  }
  if (root) {
    const underRoot = path.join(root, 'webseries', 'episodes', nameOrPath);
    if (fs.existsSync(underRoot) && fs.statSync(underRoot).isDirectory()) return underRoot;
  }
  return path.join(cwd, nameOrPath);
}

/** Every directory under `<root>/webseries/episodes`, sorted. Empty if that dir is absent. */
export function discoverEpisodes(root) {
  const dir = path.join(root, 'webseries', 'episodes');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function toolsAvailable() {
  const probe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' });
  return { ffprobe: probe.status === 0 };
}

export function ffprobeDuration(file) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function ffprobeDims(file) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const [w, h] = out.split('x').map(Number);
    return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}

/** Python `round()` half-to-even, for positive `x` only (all callers here are durations). */
function pyRound(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Reimplementation of `make_episode.py`'s `build_beats(lines, total)`: join the
 * paragraphs, resplit at sentence boundaries, group into `n` beats of roughly equal word
 * count, then give each beat a duration proportional to its own word count, scaled so the
 * durations sum to exactly `total`. Returns `[{ text, duration }]`, `n` beats, empty if
 * `lines` is empty or `total` is not a positive number.
 */
export function computeBeats(lines, total) {
  if (!Array.isArray(lines) || lines.length === 0 || !Number.isFinite(total) || total <= 0) return [];
  const text = lines.join(' ');
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return [];
  const n = Math.max(5, Math.min(12, pyRound(total / 28)));
  const words = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const targetWords = words.reduce((a, b) => a + b, 0) / n;

  const beats = [];
  let cur = [];
  let curWords = 0;
  for (let i = 0; i < sentences.length; i += 1) {
    cur.push(sentences[i]);
    curWords += words[i];
    if (curWords >= targetWords && beats.length < n - 1) {
      beats.push(cur.join(' '));
      cur = [];
      curWords = 0;
    }
  }
  if (cur.length) beats.push(cur.join(' '));

  const beatWords = beats.map((b) => Math.max(1, b.split(/\s+/).filter(Boolean).length));
  const totalWords = beatWords.reduce((a, b) => a + b, 0);
  let durs = beatWords.map((w) => Math.max(2.0, (total * w) / totalWords));
  const scale = total / durs.reduce((a, b) => a + b, 0);
  durs = durs.map((d) => d * scale);

  return beats.map((text2, i) => ({ text: text2, duration: durs[i] }));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function countScriptParagraphs(file) {
  try {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.length;
  } catch {
    return null;
  }
}

function openingWords(text, n = 8) {
  const words = text.split(/\s+/).filter(Boolean).slice(0, n);
  return words.join(' ') + (text.split(/\s+/).filter(Boolean).length > n ? '…' : '');
}

const IMG_RE = /^img_\d+\.\w+$/i;
const TITLE_CARD_RE = /^title_card\.\w+$/i;
const MP4_RE = /\.mp4$/i;
const AUDIO_RE = /\.(mp3|wav)$/i;

/** The whole report for one episode directory. Never throws on a missing file — everything absent is a `problems` entry, not a failure. */
export function measureEpisode(dir, { probe = true } = {}) {
  const name = path.basename(dir);
  const problems = [];
  const exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  if (!exists) {
    return { dir, name, exists: false, problems: [`no such directory: ${dir}`] };
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  const imagesDir = path.join(dir, 'images');
  const imagesExists = fs.existsSync(imagesDir) && fs.statSync(imagesDir).isDirectory();
  let imageFiles = [];
  if (imagesExists) {
    imageFiles = fs.readdirSync(imagesDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } else {
    problems.push('no images/ directory');
  }
  const imgFrames = imageFiles.filter((f) => IMG_RE.test(f));
  const otherImageFiles = imageFiles.filter((f) => !IMG_RE.test(f)).sort();
  const images = {
    exists: imagesExists,
    total: imageFiles.length,
    imgCount: imgFrames.length,
    otherFiles: otherImageFiles,
  };

  const titleCard = files.some((f) => TITLE_CARD_RE.test(f));

  const mp4Files = files.filter((f) => MP4_RE.test(f)).sort();
  if (mp4Files.length === 0) problems.push('no rendered mp4');
  const mp4s = mp4Files.map((f) => {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    const duration = probe ? ffprobeDuration(full) : null;
    const dims = probe ? ffprobeDims(full) : null;
    return {
      file: f,
      sizeBytes: stat.size,
      duration,
      width: dims ? dims.width : null,
      height: dims ? dims.height : null,
    };
  });

  const audioFiles = files.filter((f) => AUDIO_RE.test(f)).sort();
  if (audioFiles.length === 0) problems.push('no audio file');
  const audio = audioFiles.map((f) => ({
    file: f,
    duration: probe ? ffprobeDuration(path.join(dir, f)) : null,
  }));
  const narrationDuration = audio.find((a) => a.file === 'audio.mp3')?.duration ?? null;
  const finalDuration =
    audio.find((a) => a.file === 'final_audio.mp3')?.duration ?? (mp4s.length ? mp4s[0].duration : null);

  const sourceCounts = {
    'script.txt': fs.existsSync(path.join(dir, 'script.txt')) ? countScriptParagraphs(path.join(dir, 'script.txt')) : null,
    'transcript.json': (() => {
      const t = readJson(path.join(dir, 'transcript.json'));
      return Array.isArray(t) ? t.length : fs.existsSync(path.join(dir, 'transcript.json')) ? null : null;
    })(),
    'prompts.json': (() => {
      const p = readJson(path.join(dir, 'prompts.json'));
      return Array.isArray(p) ? p.length : null;
    })(),
    'moods.json': (() => {
      const m = readJson(path.join(dir, 'moods.json'));
      return Array.isArray(m) ? m.length : null;
    })(),
  };
  const presentCounts = Object.values(sourceCounts).filter((v) => v !== null);
  const disagreement = presentCounts.length > 1 && new Set(presentCounts).size > 1;

  let beatsReport = null;
  const transcriptPath = path.join(dir, 'transcript.json');
  const transcriptLines = readJson(transcriptPath);
  if (!Array.isArray(transcriptLines)) {
    problems.push('no transcript.json — beats not computed');
  } else if (narrationDuration == null && finalDuration == null) {
    problems.push('no audio duration available — beats not computed');
  } else {
    const total = narrationDuration != null ? narrationDuration : finalDuration;
    const offsetSeconds =
      narrationDuration != null && finalDuration != null
        ? Math.max(0, finalDuration - narrationDuration)
        : narrationDuration != null
          ? TITLE_SEC
          : 0;
    const beats = computeBeats(transcriptLines, total);
    let t = offsetSeconds;
    const items = beats.map((b, i) => {
      const start = t;
      const end = t + b.duration;
      t = end;
      return { index: i, start, end, openingWords: openingWords(b.text) };
    });
    beatsReport = { count: items.length, total, offsetSeconds, items };
  }

  return {
    dir,
    name,
    exists: true,
    images,
    titleCard,
    mp4s,
    audio,
    sourceCounts,
    disagreement,
    beats: beatsReport,
    problems,
  };
}
