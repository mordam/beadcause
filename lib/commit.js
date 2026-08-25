/**
 * The commit before the delivery, written the house way instead of four ways
 * (`bc-xl7n.119`).
 *
 * The session audit ([lib/sessionaudit.js](./sessionaudit.js)) found the same three-step
 * ending — confirm the scope with `git diff main...HEAD --name-only`, commit, then
 * `bin/deliver.js` — done by hand in ten runs across five beads (`bc-xl7n.93`,
 * `bc-1kwl.30`, `bc-7qo.14`, `bc-ka5y.19`, `bc-dgx7.7`). The confirm and the deliver
 * were each one call that worked first time. The commit in between was written four
 * different ways and failed three of them:
 *
 * - `bc-xl7n.93` ran `git commit -m "…\`clearAbandonedLocks\`…"` inside a Bash tool
 *   call, and the backtick inside the double-quoted argument is command substitution —
 *   the exact hazard [bin/b7e-say.js](../bin/b7e-say.js) exists for, at the one call
 *   site it did not cover. The call hung for two minutes before anyone noticed. That
 *   same run also passed `--author="Adam Morgan <adam.morgan@climative.ai>"` — the
 *   *work* address, in a personal repo whose `~/.gitconfig` `includeIf` exists
 *   specifically to resolve `neadamthal@gmail.com` instead — and separately forgot the
 *   `Co-Authored-By` trailer, fixing it after the fact with a `printf` append and an
 *   amend.
 * - The other nine each got the message onto the command line a different way —
 *   a scratch file plus `-F`, `-m "$(cat <<'EOF' … EOF)"`, a plain multi-line `-m`, or a
 *   one-line `-m` — and none of them added, checked for, or normalised the trailer.
 *
 * The fix for the whole family is the same idiom `bin/b7e-say.js` already uses for the
 * same reason: **the message body is never a shell argument.** It arrives as a string
 * (from stdin or `--file`, in the CLI), is written to a throwaway temp file, and is
 * committed with `git commit -F <file>` — so backticks, `$(...)` and a heredoc
 * terminator inside it are inert no matter how it reaches this module. `--author` is
 * never passed, so identity is whatever `git` resolves for the checkout, which is what
 * bc-xl7n.93's own hardcoded flag got wrong.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configuredBase } from './prbase.js';

/** The trailer every commit needs exactly one of. Nothing in this repo wrote it before. */
export const CO_AUTHORED_BY = 'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

/** The branch HEAD is on in `dir`. `'HEAD'` back means detached. */
export function currentBranch(dir) {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

/**
 * The commit message this command writes, given the raw body a caller handed it.
 *
 * `<bead>: <first line>` is the subject; everything after the first line is the body,
 * trimmed of the blank lines a heredoc leaves at each end but otherwise untouched —
 * backticks, `$(...)`, a heredoc terminator included, since this never passes through a
 * shell. Exactly one `Co-Authored-By` trailer: the body's own, if it already carries
 * one anywhere, or the standard line appended as its own paragraph if it does not.
 *
 * Returns `null` for a body that is empty once trimmed, which is the one case the
 * caller must refuse rather than commit — a message with nothing in it but a trailer
 * is not a message.
 *
 * Exported on its own because it is pure and it is the whole of what "written the
 * house way" means; the git plumbing around it is unavoidably impure and is tested
 * against a real repo instead.
 */
export function commitMessage(beadId, rawBody) {
  const normalised = String(rawBody ?? '').replace(/\r\n/g, '\n');
  const trimmed = normalised.replace(/^\n+/, '').replace(/[ \t\n]+$/, '');
  if (!trimmed) return null;

  const nl = trimmed.indexOf('\n');
  const subjectLine = nl === -1 ? trimmed : trimmed.slice(0, nl);
  const rest = (nl === -1 ? '' : trimmed.slice(nl + 1)).replace(/^\n+/, '').replace(/[ \t\n]+$/, '');

  const subject = `${beadId}: ${subjectLine}`;
  const hasTrailer = /^Co-Authored-By:/im.test(trimmed);

  const parts = [subject];
  if (rest) parts.push(rest);
  if (!hasTrailer) parts.push(CO_AUTHORED_BY);
  return `${parts.join('\n\n')}\n`;
}

/**
 * Stage everything in `dir`, commit it the house way, and say what landed.
 *
 * Refuses, having written nothing, in exactly the three cases the acceptance
 * criteria names: on `main` (or whatever the workspace's configured base branch is —
 * `master` besides, matching `bin/deliver.js`'s own guard), on a tree with nothing
 * staged, and on a body that is empty once trimmed. An `--amend` is exempted from the
 * empty-tree refusal, because amending only the message with the same tree is a
 * legitimate call — the empty-body and wrong-branch refusals still apply to it.
 *
 * Returns `{ sha, subject, files }` — `files` is the staged path list, computed
 * *before* the commit, which is what a caller prints above the sha as the confirmation
 * of what actually got written.
 */
export function commitAll(dir, { beadId, body, amend = false, cfg = {}, workspaceName = '' } = {}) {
  if (!beadId) throw new Error('no bead id given');

  const branch = currentBranch(dir);
  const base = configuredBase(cfg, workspaceName);
  if ([base, 'main', 'master'].includes(branch)) {
    throw new Error(`refusing to commit on ${branch} — this work belongs on its own branch`);
  }

  const message = commitMessage(beadId, body);
  if (!message) throw new Error('nothing to say — the body is empty, nothing was written');

  git(dir, ['add', '-A']);
  const files = git(dir, ['diff', '--cached', '--name-only'])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  if (!files.length && !amend) {
    throw new Error('nothing staged — the tree is clean, nothing was written');
  }

  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'b7e-commit-'));
  const file = path.join(tmp, 'message.txt');
  try {
    fs.writeFileSync(file, message, 'utf8');
    const args = ['commit', '-F', file];
    if (amend) args.push('--amend');
    git(dir, args);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  const subject = git(dir, ['log', '-1', '--format=%s']).trim();
  return { sha, subject, files };
}
