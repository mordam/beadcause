import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveSessionDir } from './session.js';
import { setActivity, clearActivity } from './activity.js';
import { autoDispatchAllowed } from './spaces.js';
import * as agentlog from './agentlog.js';

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
  return `You are answering a question thread in beadcause. The user commented from
their phone and is waiting for a reply — they cannot see your terminal, only what
you write onto the bead.

Bead: **${workspace}/${id}**
Question: ${title || '(untitled)'}

1. Read the thread:

       bd show ${id}
       bd comments ${id}

2. **Their most recent comment is what you are answering.** Actually do what it asks
   — if they want links, find the real paths or URLs in this repo and give them; if
   they want a summary, write it. A comment that merely acknowledges them is a wasted
   round trip, because they are on a phone and can only act on what is in the reply.

3. Reply by commenting on the bead:

       bd comment ${id} --actor claude-session "<your reply>"

   Pass --actor exactly as shown. It is what marks the comment as coming from an
   agent rather than from the user, and it is what makes their phone notify.

4. **Do not close the bead.** The decision is theirs; you are answering, not deciding.

You are running unattended with a narrow allowlist: you can run \`bd\` and read files,
and nothing else. If you cannot do what they asked — missing context, or it needs a
decision only they can make — say that plainly in the comment. Silence is the exact failure this
was built to fix, so never finish without commenting.`;
}

/**
 * Spawn an agent to answer the latest comment. Fire-and-forget: the phone must not
 * wait on a model round trip, so this returns as soon as the process is launched.
 */
export function dispatchReply(cfg, workspace, id, title) {
  const key = `${workspace.name}/${id}`;

  // Global switch, per-workspace exclusion and per-space policy, in one check.
  if (!autoDispatchAllowed(cfg, workspace.name)) {
    return { dispatched: false, reason: `auto-dispatch is off for ${workspace.name}` };
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
  // `--output-format stream-json` is what makes the run watchable: plain `-p` prints
  // only the final answer, so a phone asking "is anything happening" would have had
  // nothing to show until the moment there was nothing left to wait for. `--verbose`
  // is not optional — the CLI refuses stream-json with --print without it.
  const command =
    `P="$(cat '${promptFile}')"; rm -f '${promptFile}'; ` +
    `exec claude -p "$P" --allowedTools '${ALLOWED_TOOLS}' --output-format stream-json --verbose`;

  inFlight.add(key);
  // Show it on the card immediately. Half the complaint was not knowing whether
  // anything had picked the comment up at all.
  setActivity(key, { phase: 'thinking', detail: 'picking up your comment', actor: 'auto-dispatch' });

  // A fresh run gets a fresh log. Appending would leave yesterday's answer sitting
  // above today's question, which reads as progress that has already happened.
  agentlog.reset(key);
  agentlog.append(key, `● dispatched in ${dir}`);

  const child = spawn('/bin/zsh', ['-lc', command], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // stream-json is newline-delimited, but a chunk boundary lands mid-line often
  // enough that parsing chunks directly loses events — hold the remainder over.
  let pending = '';
  let lastText = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // Not JSON: something wrote to stdout that isn't the stream. Show it as-is
        // rather than dropping it — that is usually the error worth reading.
        agentlog.append(key, line);
        continue;
      }
      const rendered = agentlog.renderEvent(event);
      if (rendered) agentlog.append(key, rendered);
      if (event.type === 'result' && typeof event.result === 'string') lastText = event.result;
      // The phase chip on the card follows the log, so the summary line and the
      // detail never disagree about what the agent is doing.
      if (event.type === 'assistant') {
        setActivity(key, { phase: 'drafting', detail: 'writing a reply', actor: 'auto-dispatch' });
      }
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    agentlog.append(key, String(chunk).trimEnd());
  });

  const timer = setTimeout(() => child.kill('SIGTERM'), cfg.autoDispatchTimeoutMs ?? 600000);

  child.on('close', (code) => {
    clearTimeout(timer);
    inFlight.delete(key);
    fs.rmSync(promptFile, { force: true });
    if (code !== 0) {
      const detail = (stderr || `exited ${code}`).split('\n')[0];
      console.error(`[beadcause] auto-dispatch failed for ${key}: ${detail}`);
      agentlog.append(key, `● failed: ${detail}`);
      // Leave it visible rather than clearing to idle: a silently failed dispatch
      // is indistinguishable from the bug this whole feature exists to fix.
      setActivity(key, { phase: 'blocked', detail: `agent failed: ${detail}`.slice(0, 140), actor: 'auto-dispatch' });
      return;
    }
    console.log(`[beadcause] auto-dispatch answered ${key} (${lastText.trim().length} chars)`);
    // The agent's own comment is what notifies the phone, via the reply poller.
    clearActivity(key);
  });
  child.unref?.();

  console.log(`[beadcause] auto-dispatched an agent for ${key} in ${dir}`);
  return { dispatched: true, dir };
}
