/**
 * The git plumbing behind `bin/b7e-show` — one file, materialised as it was at some
 * other ref, without inventing a redirect for the caller to guess at.
 *
 * `bc-dgx7.72` names four sessions (`dv-3rn.12`, `dv-gr6.50`, `dv-gr6.48`, `dv-3rn`) that
 * each needed the other side of a ref and each built the step by hand, one of them
 * differently. `dv-3rn.12`'s first attempt — `git show ref:path > /tmp/x.md` — wrote
 * nothing because the redirect target's directory did not exist, and a shell redirect
 * that writes nothing looks exactly like a `grep` that found nothing: the failure was
 * invisible until a second attempt used a real scratch directory. That is the shape this
 * exists to close off — a path absent at the ref is refused, not silently turned into an
 * empty file — and it is why presence is read from `git show`'s own exit code rather than
 * from whether a write happened to land.
 *
 * `lib/gitref.js` already has the primitives (`git`, `gitCode`, `refTip`) that
 * `lib/sessionlog.js` and `lib/commonrepo.js` use for the same reads; this is nothing new
 * on top, just `git show <ref>:<path>` read as a buffer (never a string — a materialised
 * copy has to byte-match, and this repo's own `public/vendor` bundles are exactly the
 * binary content a `utf8`-decoded read would corrupt) and written under a scratch
 * directory built lazily, so a ref that resolves but names no real path leaves nothing on
 * disk at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, refTip, ok } from './gitref.js';

/** Every materialised copy lives under here — one scratch directory per invocation. */
export function showTreeRoot() {
  return path.join(os.tmpdir(), 'beadcause-show');
}

/** `ref`, resolved in `cwd`'s repo, or `null` if it does not name a real revision. */
export async function resolveRef(cwd, ref) {
  return refTip(cwd, ref);
}

/**
 * `path` as a repo-relative path safe to join under a scratch directory.
 *
 * An absolute path or one that climbs out with `..` would let a caller-named path write
 * outside the scratch directory `mkdtempSync` just built — `path.join` does not stop
 * that on its own, so this is the check that does.
 */
function safeRelative(file) {
  const norm = path.normalize(file);
  if (path.isAbsolute(file) || norm.split(path.sep).includes('..')) return null;
  return norm;
}

/**
 * `git show <ref>:<file>` as a `Buffer`, or `null` if `file` does not exist at `ref` —
 * the same three-state read `gitCode` gives the rest of this module, `null` meaning
 * "absent" rather than "empty" so an empty-but-present file is never mistaken for a miss.
 */
export async function readRefFileBuffer(cwd, ref, file) {
  return ok(git(cwd, ['show', `${ref}:${file}`], { encoding: 'buffer', maxBuffer: 200 * 1024 * 1024 }));
}

/**
 * Materialise every `files` entry as it stood at `ref`, into a fresh scratch directory
 * under `showTreeRoot()` — built lazily, so a call where every path is absent leaves no
 * directory behind at all.
 *
 * Returns `{ hits, misses }` — `hits` is `{ path, file }` for every path that existed
 * (`file` the absolute path of the materialised copy), `misses` the repo-relative paths
 * that did not. A path outside the repo (`safeRelative` refusing it) is reported as a
 * miss with `unsafe: true` rather than written anywhere.
 */
export async function materialise(cwd, ref, files) {
  const hits = [];
  const misses = [];
  let scratchDir = null;
  for (const file of files) {
    const rel = safeRelative(file);
    if (rel === null) {
      misses.push({ path: file, unsafe: true });
      continue;
    }
    const buf = await readRefFileBuffer(cwd, ref, file);
    if (buf === null) {
      misses.push({ path: file, unsafe: false });
      continue;
    }
    if (!scratchDir) {
      fs.mkdirSync(showTreeRoot(), { recursive: true });
      scratchDir = fs.mkdtempSync(path.join(fs.realpathSync(showTreeRoot()), 'copy-'));
    }
    const dest = path.join(scratchDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    hits.push({ path: file, file: dest });
  }
  return { hits, misses };
}

/** A unified diff of `files` as they stood at `ref` against the working tree. */
export async function diffAgainstRef(cwd, ref, files) {
  return git(cwd, ['diff', ref, '--', ...files]);
}
