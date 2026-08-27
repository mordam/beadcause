#!/usr/bin/env node
//
// b7e-episode — a webseries episode's measured facts (bc-dgx7.105). Three deluvia
// sessions (dv-2uu.6, dv-2uu.5, dv-2uu.3) each re-derived the same facts about one
// episode directory by hand before a single post could be written. This is that command.
//
//   npm test
//   node test/episode.mjs
//
// Same split as test/manifest.mjs and test/plate.mjs: everything in lib/episode.js that
// is pure logic (computeBeats, resolveEpisodeDir, discoverEpisodes, measureEpisode's
// structural fields) is exercised against fabricated fixtures with `probe: false`, so it
// runs with no dependency on `deluvia` or `ffprobe`/`ffmpeg` being on disk at all. A
// second block, gated on `ffprobe`/`ffmpeg` actually being runnable (the same
// toolsAvailable() gate bin/b7e-episode itself uses), drives real tiny generated audio
// so the audio-duration wiring into computeBeats is proven end to end, not just the pure
// function. bin/b7e-episode is then driven as a real subprocess for argv/exit codes.
//
// computeBeats itself was hand-verified against the real kazran-orves and alban-orves
// episodes while this was written (not part of this suite, which must not depend on a
// sibling checkout existing — see a-real-repo-assertion-in-a-test-rots-between-your-run-and-ci):
// build_beats(transcript.json, duration(audio.mp3)) with each start offset by TITLE_SEC
// reproduces every one of ffmpeg's own scene-detect boundaries in the rendered mp4, to
// the millisecond, at any threshold from 0.1 to 0.3 — including the exact sequence
// "4 46.4 90.7 133.466667 175.1" the bead's own filed description quotes (that turned out
// to be alban-orves, not kazran-orves as the surrounding prose implied).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TITLE_SEC,
  computeBeats,
  discoverEpisodes,
  measureEpisode,
  repoRoot,
  resolveEpisodeDir,
  toolsAvailable,
} from '../lib/episode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-episode');

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

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/* ==================================================================== computeBeats() */

check('computeBeats: empty lines, or a non-positive total, is an empty beat list', () => {
  assert.deepEqual(computeBeats([], 100), []);
  assert.deepEqual(computeBeats(['A sentence.'], 0), []);
  assert.deepEqual(computeBeats(['A sentence.'], -5), []);
});

check('computeBeats: durations sum to the given total, however many beats it lands on', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `This is narration paragraph number ${i}, with a few words in it. It has two sentences.`);
  for (const total of [20, 100, 250, 474.75576, 900]) {
    const beats = computeBeats(lines, total);
    const sum = beats.reduce((a, b) => a + b.duration, 0);
    assert.ok(Math.abs(sum - total) < 1e-6, `total=${total} sum=${sum}`);
  }
});

check('computeBeats: n is clamped to [5, 12] — max(5, min(12, round(total/28)))', () => {
  // Many TINY sentences (2 words each) so the greedy "stop once cur_w >= target" cut
  // never overshoots by much relative to the target — with big or lumpy sentences a
  // cut can overshoot far enough that the loop runs out of sentences before reaching
  // n-1 cuts, landing on fewer than n beats even though n itself only depends on
  // `total`, not on the text. 2000 sentences is comfortably enough for every n in [5,12].
  const lines = Array.from({ length: 2000 }, (_, i) => `w${i} w${i}.`);
  assert.equal(computeBeats(lines, 10).length, 5, 'a short total still gets at least 5 beats');
  assert.equal(computeBeats(lines, 28 * 5).length, 5);
  assert.equal(computeBeats(lines, 28 * 12).length, 12);
  assert.equal(computeBeats(lines, 28 * 40).length, 12, 'a long total is capped at 12, not one per source line');
});

check('computeBeats: reproduces the real kazran-orves scene-detect boundaries', () => {
  // The 14 real transcript.json paragraphs, verbatim (test/fixtures/kazran-orves-transcript.json)
  // — the grouping cuts at SENTENCE boundaries mid-paragraph (e.g. beat 2 starts partway
  // through paragraph 3), so a word-count-only stand-in with one sentence per paragraph
  // would cut at the wrong granularity. Using the real text is what makes this an exact
  // reproduction rather than an approximation; it does not touch a live deluvia checkout.
  const lines = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'kazran-orves-transcript.json'), 'utf8'));
  const total = 470.75575; // duration(audio.mp3) for the real episode
  const beats = computeBeats(lines, total);
  assert.equal(beats.length, 12);
  let t = TITLE_SEC;
  const expectedStarts = [4.0, 47.3, 87.833333, 130.733333, 170.1, 210.633333, 253.933333, 293.7, 336.2, 377.133333, 419.633333, 459.4];
  const actualStarts = beats.map((b) => {
    const s = t;
    t += b.duration;
    return s;
  });
  actualStarts.forEach((s, i) => {
    assert.ok(Math.abs(s - expectedStarts[i]) < 0.05, `beat ${i}: expected ~${expectedStarts[i]}, got ${s}`);
  });
});

/* ==================================================================== repoRoot() */

check('repoRoot: resolves to git\'s own toplevel for a cwd inside a repo', () => {
  const gitProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-episode-reporoot-'));
  execFileSync('git', ['init', '-q'], { cwd: gitProbe });
  const nested = path.join(gitProbe, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(fs.realpathSync(repoRoot(nested)), fs.realpathSync(gitProbe));
});

check('repoRoot: falls back when cwd is not inside any git repository', () => {
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-episode-nogit-'));
  assert.equal(repoRoot(notGit, 'fallback-value'), 'fallback-value');
});

/* ==================================================================== resolveEpisodeDir() */

check('resolveEpisodeDir: a bare name resolves under <root>/webseries/episodes/<name> when that dir exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-episode-root-'));
  const epDir = path.join(root, 'webseries', 'episodes', 'foo');
  fs.mkdirSync(epDir, { recursive: true });
  assert.equal(fs.realpathSync(resolveEpisodeDir('foo', { root, cwd: '/somewhere/else' })), fs.realpathSync(epDir));
});

check('resolveEpisodeDir: a bare name with no matching directory under root falls back to cwd', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-episode-root2-'));
  assert.equal(resolveEpisodeDir('nope', { root, cwd: '/somewhere/else' }), path.join('/somewhere/else', 'nope'));
});

check('resolveEpisodeDir: anything containing a "/" is a path relative to cwd, root ignored', () => {
  assert.equal(
    resolveEpisodeDir('webseries/episodes/foo', { root: '/r', cwd: '/somewhere/else' }),
    path.join('/somewhere/else', 'webseries/episodes/foo')
  );
});

check('resolveEpisodeDir: an absolute path is passed through unchanged', () => {
  assert.equal(resolveEpisodeDir('/abs/path', { root: '/r', cwd: '/x' }), '/abs/path');
});

/* ==================================================================== discoverEpisodes() */

check('discoverEpisodes: every directory under <root>/webseries/episodes, sorted, files ignored', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-episode-discover-'));
  const epRoot = path.join(root, 'webseries', 'episodes');
  fs.mkdirSync(path.join(epRoot, 'zebra'), { recursive: true });
  fs.mkdirSync(path.join(epRoot, 'apple'), { recursive: true });
  fs.writeFileSync(path.join(epRoot, 'README.md'), 'not a directory');
  assert.deepEqual(discoverEpisodes(root), ['apple', 'zebra']);
});

check('discoverEpisodes: no webseries/episodes directory at all is an empty list, not a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-episode-noeps-'));
  assert.deepEqual(discoverEpisodes(root), []);
});

/* ==================================================================== measureEpisode() — pure fixture, probe:false */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-episode-'));
const fullDir = path.join(tmp, 'full-episode');
const imgDir = path.join(fullDir, 'images');
fs.mkdirSync(imgDir, { recursive: true });
for (const f of ['img_000.png', 'img_001.png', 'img_002.png']) fs.writeFileSync(path.join(imgDir, f), 'x');
for (const f of ['depth_000.png', 'depth_001.png', 'title_bg.png']) fs.writeFileSync(path.join(imgDir, f), 'x');
fs.writeFileSync(path.join(fullDir, 'title_card.png'), 'x');
fs.writeFileSync(path.join(fullDir, 'full-episode.mp4'), 'x'.repeat(1000));
fs.writeFileSync(path.join(fullDir, 'audio.mp3'), 'x');
fs.writeFileSync(path.join(fullDir, 'final_audio.mp3'), 'x');
fs.writeFileSync(path.join(fullDir, 'bed.wav'), 'x');
fs.writeFileSync(path.join(fullDir, 'script.txt'), 'Paragraph one has words.\n\nParagraph two also has words.\n\nParagraph three.\n');
fs.writeFileSync(path.join(fullDir, 'transcript.json'), JSON.stringify(['Paragraph one has words.', 'Paragraph two also has words.', 'Paragraph three.']));
fs.writeFileSync(path.join(fullDir, 'prompts.json'), JSON.stringify(['p1', 'p2']));
fs.writeFileSync(path.join(fullDir, 'moods.json'), JSON.stringify(['m1', 'm2']));

check('measureEpisode: images — img_* count vs total, other files listed and sorted', () => {
  const r = measureEpisode(fullDir, { probe: false });
  assert.equal(r.images.total, 6);
  assert.equal(r.images.imgCount, 3);
  assert.deepEqual(r.images.otherFiles, ['depth_000.png', 'depth_001.png', 'title_bg.png']);
});

check('measureEpisode: title card detected, mp4 and audio files listed with sizes', () => {
  const r = measureEpisode(fullDir, { probe: false });
  assert.equal(r.titleCard, true);
  assert.equal(r.mp4s.length, 1);
  assert.equal(r.mp4s[0].file, 'full-episode.mp4');
  assert.equal(r.mp4s[0].sizeBytes, 1000);
  assert.deepEqual(
    r.audio.map((a) => a.file),
    ['audio.mp3', 'bed.wav', 'final_audio.mp3']
  );
});

check('measureEpisode: sourceCounts and disagreement — script/transcript agree, prompts/moods differ', () => {
  const r = measureEpisode(fullDir, { probe: false });
  assert.equal(r.sourceCounts['script.txt'], 3);
  assert.equal(r.sourceCounts['transcript.json'], 3);
  assert.equal(r.sourceCounts['prompts.json'], 2);
  assert.equal(r.sourceCounts['moods.json'], 2);
  assert.equal(r.disagreement, true);
});

check('measureEpisode: all source counts agreeing is not flagged', () => {
  const dir = path.join(tmp, 'agree-episode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'script.txt'), 'One.\n\nTwo.\n');
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(['One.', 'Two.']));
  const r = measureEpisode(dir, { probe: false });
  assert.equal(r.disagreement, false);
});

check('measureEpisode: a missing directory is reported, not thrown', () => {
  const r = measureEpisode(path.join(tmp, 'does-not-exist'), { probe: false });
  assert.equal(r.exists, false);
  assert.match(r.problems[0], /no such directory/);
});

check('measureEpisode: no mp4, no audio, no transcript is reported and everything else still comes back — nothing fails', () => {
  const dir = path.join(tmp, 'unrendered-episode');
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', 'img_000.png'), 'x');
  fs.writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify(['p1']));
  const r = measureEpisode(dir, { probe: false });
  assert.equal(r.exists, true);
  assert.equal(r.images.imgCount, 1);
  assert.equal(r.mp4s.length, 0);
  assert.equal(r.audio.length, 0);
  assert.equal(r.beats, null);
  assert.ok(r.problems.some((p) => /no rendered mp4/.test(p)));
  assert.ok(r.problems.some((p) => /no audio file/.test(p)));
  assert.ok(r.problems.some((p) => /no transcript\.json/.test(p)));
});

check('measureEpisode: an empty images/ directory (0 of 0) is not a "no directory" problem', () => {
  const dir = path.join(tmp, 'empty-images-episode');
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const r = measureEpisode(dir, { probe: false });
  assert.equal(r.images.exists, true);
  assert.equal(r.images.total, 0);
  assert.equal(r.images.imgCount, 0);
  assert.ok(!r.problems.some((p) => /no images/.test(p)));
});

/* =========================================================== measureEpisode() beats, real ffprobe/ffmpeg */

const tools = toolsAvailable();
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;

if (tools.ffprobe && ffmpegAvailable) {
  const realDir = path.join(tmp, 'real-audio-episode');
  fs.mkdirSync(realDir, { recursive: true });
  const mkSilence = (file, seconds) => {
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `anullsrc=r=8000:cl=mono`, '-t', String(seconds),
      '-q:a', '9', path.join(realDir, file),
    ], { stdio: 'ignore' });
  };
  mkSilence('audio.mp3', 10);
  mkSilence('final_audio.mp3', 14); // 4s intro, matching TITLE_SEC
  // Many tiny sentences per paragraph, same reasoning as the n-clamp test above: too
  // few sentences and the greedy cut can't reach 5 beats no matter what n wants.
  const tinyParagraph = Array.from({ length: 40 }, (_, i) => `w${i} w${i}.`).join(' ');
  fs.writeFileSync(path.join(realDir, 'transcript.json'), JSON.stringify([tinyParagraph, tinyParagraph]));

  check('measureEpisode: real ffprobe durations feed computeBeats — total is audio.mp3, offset is the final/narration gap', () => {
    const r = measureEpisode(realDir, { probe: true });
    assert.ok(r.beats, 'beats should have been computed with real audio on disk');
    assert.ok(Math.abs(r.beats.total - 10) < 0.2, `expected total ~10s, got ${r.beats.total}`);
    assert.ok(Math.abs(r.beats.offsetSeconds - 4) < 0.2, `expected offset ~4s, got ${r.beats.offsetSeconds}`);
    assert.equal(r.beats.count, 5, 'clamped to the minimum of 5 beats');
    const last = r.beats.items[r.beats.items.length - 1];
    assert.ok(Math.abs(last.end - 14) < 0.3, `last beat should end near the full 14s, got ${last.end}`);
  });
} else {
  console.log('  skip (ffprobe/ffmpeg not runnable on this machine) real-audio measureEpisode beats checks');
}

/* ==================================================================== bin/b7e-episode — CLI */

check('--help prints usage and exits 0 without needing an episode argument', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-episode/);
});

check('no arguments is refused', () => {
  const { status, stderr } = run([]);
  assert.equal(status, 2);
  assert.match(stderr, /needs an <episode-name\|path>/);
});

check('--all with an episode-name argument is refused', () => {
  const { status, stderr } = run(['--all', 'foo']);
  assert.equal(status, 2);
  assert.match(stderr, /takes no/);
});

check('an unknown flag is refused', () => {
  const { status, stderr } = run(['foo', '--bogus']);
  assert.equal(status, 2);
  assert.match(stderr, /unknown flag/);
});

check('a nonexistent episode path exits 2 with a clear message', () => {
  const { status, stderr } = run([path.join(tmp, 'nope-at-all')]);
  assert.equal(status, 2);
  assert.match(stderr, /no such directory/);
});

check('a real directory path (not under any webseries/episodes) reports fully, exit 0', () => {
  const { status, stdout } = run([fullDir]);
  assert.equal(status, 0);
  assert.match(stdout, /images: 3 img_\* frames of 6 files/);
  assert.match(stdout, /title card: yes/);
  assert.match(stdout, /DISAGREE/);
});

check('--json prints a single parseable report object for one episode', () => {
  const { status, stdout } = run([fullDir, '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.name, 'full-episode');
  assert.equal(parsed.images.imgCount, 3);
});

check('an unrendered episode (no mp4, no audio, no transcript) still exits 0 and reports the gaps', () => {
  const { status, stdout } = run([path.join(tmp, 'unrendered-episode')]);
  assert.equal(status, 0);
  assert.match(stdout, /mp4: none rendered/);
  assert.match(stdout, /audio: none/);
  assert.match(stdout, /beats: not computed/);
  assert.match(stdout, /no rendered mp4/);
});

check('--all with no webseries/episodes directory under repo root exits 4', () => {
  const noEpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-episode-cli-noeps-'));
  execFileSync('git', ['init', '-q'], { cwd: noEpRoot });
  const { status, stderr } = run(['--all'], { cwd: noEpRoot });
  assert.equal(status, 4);
  assert.match(stderr, /no "webseries\/episodes" directory/);
});

check('--all lists every episode under repo root, sorted, one block each, --json is an array', () => {
  const epRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-episode-cli-all-'));
  execFileSync('git', ['init', '-q'], { cwd: epRoot });
  const episodesDir = path.join(epRoot, 'webseries', 'episodes');
  fs.mkdirSync(path.join(episodesDir, 'zebra'), { recursive: true });
  fs.mkdirSync(path.join(episodesDir, 'apple'), { recursive: true });

  const { status: s1, stdout: out1 } = run(['--all'], { cwd: epRoot });
  assert.equal(s1, 0);
  assert.ok(out1.indexOf('apple') < out1.indexOf('zebra'), 'apple should print before zebra');

  const { status: s2, stdout: out2 } = run(['--all', '--json'], { cwd: epRoot });
  assert.equal(s2, 0);
  const parsed = JSON.parse(out2);
  assert.equal(parsed.length, 2);
  assert.deepEqual(
    parsed.map((r) => r.name),
    ['apple', 'zebra']
  );
});

check('a bare episode name resolves under repo root\'s webseries/episodes from a nested cwd', () => {
  const epRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-episode-cli-bare-'));
  execFileSync('git', ['init', '-q'], { cwd: epRoot });
  const dir = path.join(epRoot, 'webseries', 'episodes', 'named-one');
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', 'img_000.png'), 'x');
  const nested = path.join(epRoot, 'webseries');
  fs.mkdirSync(nested, { recursive: true });

  const { status, stdout } = run(['named-one'], { cwd: nested });
  assert.equal(status, 0, stdout);
  assert.match(stdout, /1 img_\* frames of 1 files/);
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
