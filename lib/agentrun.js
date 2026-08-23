/**
 * The shared runner behind both headless daemon agents.
 *
 * lib/jiraingest.js's `runAgent` and lib/sessionaudit.js's `runAgent` are the same twenty
 * lines of spawn-and-parse — the second was a deliberate copy of the first (see the note on
 * lib/sessionaudit.js's own runner), and copying it a second time is what surfaced the gap
 * this module closes: both parse `stream-json` for the one `result` event and drop every
 * other event on the floor, so what the agent actually did while it ran — which files it
 * read, which tools it was refused — existed nowhere once the process exited. Each keeps a
 * record of its *conclusion* (the ingested children, the audit ledger); neither kept a
 * record of the *run*. lib/agentlog.js is the log a dispatched reply or a survey already
 * gets, and lib/agentarchive.js is what carries it onto `refs/beadcause/agentlogs` — the
 * chain lib/evidence.js's `agent-run-logs` register claims covers every unattended run.
 * Neither headless agent went through either half. This is that path, factored out once so
 * a third headless agent gets it by construction rather than by remembering to copy it
 * correctly a third time.
 *
 * ## Archived when it ends, not when the next one starts
 *
 * lib/dispatch.js and the advocate's survey archive the *previous* run at a key the moment
 * a *new* one is about to reuse it — right, for a pane that is reused forever, because the
 * model that run proceeded under has to be read before the log recording it is cleared.
 * Neither headless agent has that guarantee: a JIRA ticket is ingested once and its key may
 * never be spawned again, and an audited checkout can go quiet for good. So this archives on
 * the way *out* of a run instead — success, failure or timeout alike, because a run that
 * failed is exactly the run an incident wants the evidence for — which is what makes every
 * run reach the chain rather than every run but whichever one turns out to be the last at
 * that key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { effective, claudeArgs, promptArgs, systemPrompt, agentEnv } from './foundation.js';
import * as agentlog from './agentlog.js';
import { archiveAndReset } from './agentarchive.js';

/**
 * One headless `claude -p`, its final message as a string — streamed onto `lib/agentlog.js`
 * under `key` as it runs, and archived onto `refs/beadcause/agentlogs` the moment it ends.
 *
 * `key` is optional. A caller with nothing to key a run under gets the old behaviour back —
 * spawn-and-parse with no log and no archive — rather than a throw; today every call site
 * has one, but a runner that requires a key is a runner a future caller works around.
 *
 * Everything about *what* to run — the foundation kind, the system prompt text, which
 * directories it may additionally read — is the caller's; this owns only the process and the
 * two stores. `spawnImpl` is injected for the reason every other spawn here is: the paths
 * worth testing are the ones you cannot produce for real from inside a test.
 */
export async function runHeadless({
  dir,
  prompt,
  systemText,
  addDirs = [],
  timeoutMs,
  cfg = null,
  key = null,
  meta = {},
  tmpPrefix = 'beadcause-agent',
  foundationKind = 'console',
  spawnImpl = spawn,
} = {}) {
  const f = await effective(dir, foundationKind);
  const stamp = crypto.randomBytes(6).toString('hex');
  const promptFile = path.join(os.tmpdir(), `${tmpPrefix}-${stamp}.md`);
  const systemFile = path.join(os.tmpdir(), `${tmpPrefix}-${stamp}.sys`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  fs.writeFileSync(systemFile, systemPrompt(f, systemText), { mode: 0o600 });

  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const command =
    `P="$(cat ${shq(promptFile)})"; rm -f ${shq(promptFile)}; ` +
    `exec claude -p --output-format stream-json --verbose --strict-mcp-config ` +
    `${claudeArgs(f, { systemFile, addDirs }).join(' ')} ${promptArgs().join(' ')}`;

  return new Promise((resolve, reject) => {
    const child = spawnImpl('/bin/zsh', ['-lc', command], {
      cwd: dir,
      env: agentEnv(f, {}, cfg),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    let answer = '';
    let stderr = '';
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
          // Not JSON: something wrote to stdout that isn't the stream. Kept as-is rather
          // than dropped — that is usually the error worth reading afterwards.
          if (key) agentlog.append(key, line);
          continue;
        }
        if (key) {
          const rendered = agentlog.renderEvent(event);
          if (rendered) agentlog.append(key, rendered);
        }
        if (event.type === 'result' && typeof event.result === 'string') answer = event.result;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), f.timeoutMs ?? timeoutMs);
    const cleanup = () => {
      fs.rmSync(promptFile, { force: true });
      fs.rmSync(systemFile, { force: true });
    };

    /** Archive whatever this run wrote, then settle the promise. Never throws. */
    const finish = async (settle) => {
      clearTimeout(timer);
      cleanup();
      if (key) {
        try {
          const archiveMeta = { ...meta, cfg, dir };
          if (archiveMeta.model == null) archiveMeta.model = f.model || null;
          const kept = await archiveAndReset(key, archiveMeta);
          if (kept.archived && !kept.chained) {
            console.error(`[agentlog] ${key}: kept but unchained — ${kept.reason}`);
          }
        } catch (err) {
          // The run already happened; a log that cannot be archived must not turn a
          // finished agent into a failed one on that account.
          console.error(`[agentlog] ${key}: could not archive — ${String(err?.message || err).split('\n')[0]}`);
        }
      }
      settle();
    };

    child.on('error', (err) => {
      finish(() => reject(new Error(`could not start claude: ${err.message}`)));
    });
    child.on('close', (code, signal) => {
      finish(() => {
        // An answer that arrived before a bad exit is still an answer — the same trade
        // lib/dispatch.js and lib/console.js make.
        if (answer.trim()) return resolve(answer);
        if (signal === 'SIGTERM') return reject(new Error('the run timed out'));
        reject(new Error(`claude exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`));
      });
    });
  });
}
