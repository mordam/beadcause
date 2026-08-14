/**
 * Git plumbing for payloads that ride inside a repo without ever touching its files.
 *
 * `lib/sessionlog.js` established the trick and explains why it works: a ref outside
 * `refs/heads/*` and `refs/tags/*` is invisible to `git log`, `git branch`, `git
 * status` and `git checkout`; it is never fetched or pushed unless it is named; and
 * it keeps its objects alive against `gc`. Write to one with `hash-object` /
 * `mktree` / `commit-tree` / `update-ref` and there is no index, no checkout and no
 * working tree involved — so a daemon can commit while a human is mid-edit in the
 * same repo and neither notices the other.
 *
 * That was one file's private plumbing until `lib/foundation.js` needed the same
 * four calls and the same compare-and-swap. It lives here rather than exported from
 * sessionlog because the CAS is the part that must not be reimplemented: two writers
 * racing on a ref is the failure this whole storage shape exists to survive, and it
 * should have exactly one implementation to be wrong in.
 *
 * Nothing here pushes. Naming a refspec is an explicit act, and on a shared repo it
 * should stay one — see the note at the top of sessionlog.js about what an agent
 * transcript carries.
 */
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
// A leaf that imports nothing — see the note at the top of lib/timing.js.
import { measure } from './timing.js';

const run = promisify(execFile);

/** git args that stamp beadcause as the author, never whoever owns the checkout. */
const IDENTITY = ['-c', 'user.name=beadcause', '-c', 'user.email=beadcause@localhost'];

/**
 * git, with an identity of our own.
 *
 * Without this every object written here is authored by whoever's git identity the
 * repo carries, which would put Adam's name on commits he did not write — the same
 * attribution problem `--actor` fixes for bd comments in lib/bd.js.
 */
export async function git(cwd, args, opts = {}) {
  try {
    // Timed like `bd` and `gh` are, because the session-archive and pull-request routes
    // reach GitHub's refs through here and a `git fetch` is not a cheap local read. See
    // lib/timing.js.
    const { stdout } = await measure('git', () =>
      run('git', [...IDENTITY, ...args], {
        cwd,
        timeout: 30000,
        maxBuffer: 96 * 1024 * 1024,
        ...opts,
      })
    );
    return stdout;
  } catch (err) {
    // execFile's own message is `Command failed: git <args>` and nothing else, which
    // names the command and not the reason. Half of git's useful output is stderr.
    throw new Error(`git ${args[0]}: ${(err.stderr || '').trim().split('\n')[0] || err.message}`);
  }
}

/**
 * git with something on stdin.
 *
 * Separate from `git()` above because `execFile` has no `input` option — that
 * belongs to the *Sync* family, and passing it is silently ignored, so the command
 * hangs on an empty stdin and fails with a message that names no cause. Every object
 * written here (`hash-object`, `mktree`) arrives that way, so this is the path that
 * matters.
 */
export function gitInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...IDENTITY, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git ${args[0]}: ${err.trim() || `exited ${code}`}`))
    );
    child.stdin.end(input);
  });
}

/** A promise's value, or null if it rejected. For reads where "absent" is an answer. */
export const ok = (p) => p.then((v) => v, () => null);

/**
 * git's **exit code**, for the handful of questions git answers with one.
 *
 * `git()` above throws on any non-zero exit, which is right for a command that was
 * meant to do something and didn't. It is wrong for `merge-base --is-ancestor` and
 * `cat-file -e`, where 1 is not a failure but the word "no": caught as an exception
 * it becomes indistinguishable from a bad ref, an unfetched commit, or a repo that
 * isn't there — and lib/prboard.js has to tell "this commit is not deployed" apart
 * from "this Mac has never heard of this commit". Three states in, three states out.
 *
 * Nothing is thrown here. `code` is git's own, `-1` when it could not be run at all,
 * and stderr rides along for the caller that wants to say why.
 */
export async function gitCode(cwd, args) {
  try {
    await run('git', [...IDENTITY, ...args], { cwd, timeout: 30000 });
    return { code: 0, stderr: '' };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : -1, stderr: String(err.stderr || err.message || '').trim() };
  }
}

/** Write a buffer to a blob and return its sha. */
export async function hashObject(cwd, buf) {
  return (await gitInput(cwd, ['hash-object', '-w', '--stdin'], buf)).trim();
}

/** `main` for a directory, whether that directory is the checkout or a worktree of it. */
export async function mainCheckout(dir) {
  const common = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  return path.dirname(common);
}

/**
 * A flat tree from `[name, Buffer]` pairs.
 *
 * Flat on purpose: `mktree` reads one line per entry and does not recurse, and every
 * payload stored this way so far is a handful of files in one directory. A nested
 * tree would mean building subtrees bottom-up, which is worth doing the day
 * something needs it and not before.
 */
export async function writeTree(cwd, entries) {
  const lines = [];
  for (const [name, buf] of entries) {
    const sha = await hashObject(cwd, buf);
    lines.push(`100644 blob ${sha}\t${name}`);
  }
  return (await gitInput(cwd, ['mktree'], lines.join('\n') + '\n')).trim();
}

/** The commit a ref points at, or null if the ref does not exist yet. */
export async function refTip(cwd, ref) {
  return (await ok(git(cwd, ['rev-parse', '--verify', '--quiet', ref])))?.trim() || null;
}

/**
 * Append a commit to a ref, or fail if someone else appended first.
 *
 * The compare-and-swap is the whole point: `update-ref <ref> <new> <old>` refuses
 * unless the ref still points where we read it, so two writers cannot lose one
 * another's entry — they get an error and can retry against the new tip. Pass
 * `expect` when the caller already read the tip and built its tree from it, so the
 * check covers the read as well as the write.
 *
 * **The empty `<old>` is not a formality.** It is git's way of saying "and the ref
 * must not exist", and leaving the argument off instead means "overwrite whatever is
 * there". Those differ in exactly one case — the very first write to a ref — and
 * that is the case where every writer reads `null` at once and all of them think
 * they are creating it. Omitting it made six concurrent posts to a new topic land as
 * one surviving commit, five silently lost, with no error anywhere. So the old value
 * is always passed, and "nothing" is spelled `''`.
 */
export async function commitToRef(cwd, ref, tree, message, { expect = undefined } = {}) {
  const parent = expect === undefined ? await refTip(cwd, ref) : expect;
  const commit = (await git(cwd, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message])).trim();
  await git(cwd, ['update-ref', ref, commit, parent || '']);
  return { commit, parent };
}

/** One file out of a ref's tree, or null if either is missing. */
export async function readRefFile(cwd, ref, file) {
  return await ok(git(cwd, ['cat-file', '-p', `${ref}:${file}`]));
}

/** The names in a ref's tree, or `[]` if the ref does not exist yet. */
export async function listRefTree(cwd, ref) {
  const out = await ok(git(cwd, ['ls-tree', '--name-only', ref]));
  return out ? out.split('\n').filter(Boolean) : [];
}

/** A ref's commits, newest first, as `{commit, at, subject}`. */
export async function refHistory(cwd, ref, { limit = 50 } = {}) {
  const log = await ok(git(cwd, ['log', '--format=%H%x00%aI%x00%s', `--max-count=${limit}`, ref]));
  if (!log) return [];
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, at, subject] = line.split('\0');
      return { commit, at, subject };
    });
}

/** A commit's full message body — where an amendment keeps its justification. */
export async function readMessage(cwd, commit) {
  return (await ok(git(cwd, ['log', '-1', '--format=%B', commit])))?.replace(/\n+$/, '') ?? null;
}

/**
 * Remove a ref, and only if it still points where the caller last looked.
 *
 * The mirror of `commitToRef`'s compare-and-swap, and it exists for the same race in the
 * one place a payload ref is *consumed* rather than appended to: `archiveSession` folds a
 * staged debrief into a session's archive and then drops the staging ref, and an agent
 * that wrote one more line in between must not have it deleted out from under it.
 * `expect` is what makes that a lost race rather than a lost memory — git refuses, and
 * the caller reads the ref again instead of silently taking half of it.
 *
 * Omitting `expect` is an unconditional delete, which is the honest spelling of "remove
 * this whatever it says" and is what a human clearing a stuck ref wants. The return is a
 * boolean rather than a throw because both answers are ordinary here: `false` is a ref
 * that was already gone *or* a swap that lost, and the caller's next move — go and look
 * again — is the same for both.
 */
export async function deleteRef(cwd, ref, { expect = undefined } = {}) {
  const args = ['update-ref', '-d', ref, ...(expect === undefined ? [] : [expect || ''])];
  return (await ok(git(cwd, args))) !== null;
}
