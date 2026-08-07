import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolveSessionDir } from './session.js';
import { setActivity, clearActivity } from './activity.js';

/**
 * Close the other half of the conversation loop.
 *
 * `human-replied` was only ever a passive flag: commenting labelled the bead and
 * then waited for some agent session to happen to run
 * `bd list --label=human-replied`. The session that filed the question exited days
 * ago and nothing else was looking, so comments went into a mailbox with no
 * postman — five threads sat unanswered, one of them reading "Can anyone hear me?".
 *
 * So a comment now dispatches an unattended `claude -p` to answer it. When that
 * agent comments, the existing reply poller notices an author that isn't
 * `beadcause`, pushes it to the phone, and clears the flag. Nothing else changes.
 */

/** Only what answering a question needs: read the repo, write a bd comment. */
const ALLOWED_TOOLS = 'Bash(bd *) Read Grep Glob';

/** One agent per bead. A second comment while one is thinking must not spawn a rival. */
const inFlight = new Set();

function promptFor(workspace, id, title) {
  return `You are answering a question thread in beadcause. Adam commented from his
phone and is waiting for a reply — he cannot see your terminal, only what you write
onto the bead.

Bead: **${workspace}/${id}**
Question: ${title || '(untitled)'}

1. Read the thread:

       bd show ${id}
       bd comments ${id}

2. **His most recent comment is what you are answering.** Actually do what it asks —
   if he wants links, find the real paths or URLs in this repo and give them; if he
   wants a summary, write it. A comment that just acknowledges him is a wasted round
   trip, because he is on a phone and can only act on what you put in the reply.

3. Reply by commenting on the bead:

       bd comment ${id} --actor claude-session "<your reply>"

   Pass --actor exactly as shown. It is what marks the comment as coming from an
   agent rather than from him, and it is what makes his phone notify.

4. **Do not close the bead.** The decision is his; you are answering, not deciding.

You are running unattended with a narrow allowlist: you can run \`bd\` and read files,
and nothing else. If you cannot do what he asked — missing context, needs a decision
only he can make — say that plainly in the comment. Silence is the exact failure this
was built to fix, so never finish without commenting.`;
}

/**
 * Spawn an agent to answer the latest comment. Fire-and-forget: the phone must not
 * wait on a model round trip, so this returns as soon as the process is launched.
 */
export function dispatchReply(cfg, workspace, id, title) {
  const key = `${workspace.name}/${id}`;

  if (cfg.autoDispatch === false) return { dispatched: false, reason: 'autoDispatch disabled' };
  if ((cfg.autoDispatchExclude || []).includes(workspace.name)) {
    return { dispatched: false, reason: `${workspace.name} is excluded from auto-dispatch` };
  }
  if (inFlight.has(key)) return { dispatched: false, reason: 'an agent is already working on this' };

  let dir;
  try {
    dir = resolveSessionDir(cfg, workspace);
  } catch (err) {
    console.error(`[beadcause] cannot dispatch for ${key}: ${err.message}`);
    return { dispatched: false, reason: err.message };
  }

  const promptFile = path.join(os.tmpdir(), `beadcause-reply-${crypto.randomBytes(6).toString('hex')}.md`);
  fs.writeFileSync(promptFile, promptFor(workspace.name, id, title), { mode: 0o600 });

  // A login shell, with cwd set on the *spawn* rather than by a `cd`. ~/.zshenv
  // derives BEADS_DIR, BEADS_ACTOR and CLAUDE_CONFIG_DIR — which account this is
  // billed to — from $PWD at shell startup, and the `cd`-triggered chpwd hook lives
  // in ~/.zshrc, which a non-interactive shell never sources. Spawning in the right
  // directory is therefore the only thing that gets the identity right here.
  const command =
    `P="$(cat '${promptFile}')"; rm -f '${promptFile}'; ` +
    `exec claude -p "$P" --allowedTools '${ALLOWED_TOOLS}'`;

  inFlight.add(key);
  // Show it on the card immediately. Half the complaint was not knowing whether
  // anything had picked the comment up at all.
  setActivity(key, { phase: 'thinking', detail: 'picking up your comment', actor: 'auto-dispatch' });

  const child = execFile(
    '/bin/zsh',
    ['-lc', command],
    { cwd: dir, timeout: cfg.autoDispatchTimeoutMs ?? 600000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => {
      inFlight.delete(key);
      fs.rmSync(promptFile, { force: true });
      if (err) {
        const detail = (stderr || err.message || '').split('\n')[0];
        console.error(`[beadcause] auto-dispatch failed for ${key}: ${detail}`);
        // Leave it visible rather than clearing to idle: a silently failed dispatch
        // is indistinguishable from the bug this whole feature exists to fix.
        setActivity(key, { phase: 'blocked', detail: `agent failed: ${detail}`.slice(0, 140), actor: 'auto-dispatch' });
        return;
      }
      console.log(`[beadcause] auto-dispatch answered ${key} (${(stdout || '').trim().length} chars)`);
      // The agent's own comment is what notifies the phone, via the reply poller.
      clearActivity(key);
    }
  );
  child.unref?.();

  console.log(`[beadcause] auto-dispatched an agent for ${key} in ${dir}`);
  return { dispatched: true, dir };
}
