import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveSessionDir } from './session.js';
import { setActivity, clearActivity } from './activity.js';
import { autoDispatchAllowed } from './spaces.js';
import { agentFor, DEFAULT_TOOLS } from './agents.js';
import * as agentlog from './agentlog.js';
import { effective } from './foundation.js';
import * as amendment from './amendment.js';

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

/**
 * What this agent may *do* lives in lib/foundation.js — one object per agent kind,
 * owned by beadcause, so an approved amendment has a single place to land. What it
 * was *asked* stays here, in `promptFor`: the foundation is what the agent is on
 * every run, the prompt is this one comment on this one bead.
 *
 * The reach is deliberately narrow, and lib/foundation.js says why at the list
 * itself: `Bash(bd *)` was one pattern and four verbs too many — it allowed
 * `bd create`, `bd close`, `bd delete` and `bd label`, so the agent you chat with
 * could file beads without asking, which is what the proposal flow exists to
 * prevent, and could close the very question it was answering.
 */

/**
 * One agent per bead. A second comment while one is thinking must not spawn a rival.
 *
 * A Map rather than a Set because *which* agent is running is now load-bearing:
 * elevated tools may not be armed for an agent that is mid-reply, and the only
 * honest way to enforce that is to know what is in flight.
 */
const inFlight = new Map();

/** The bead an agent is answering right now, or null. */
export function agentBusyOn(agentId) {
  for (const [key, run] of inFlight) if (run.agentId === agentId) return key;
  return null;
}

/** Every running reply, as `agentId → bead key`, for the roster the phone draws. */
export function busyAgents() {
  const out = new Map();
  for (const [key, run] of inFlight) if (!out.has(run.agentId)) out.set(run.agentId, key);
  return out;
}

function promptFor(workspace, id, title, agent, elevated, reflection = '') {
  return `${agent.description}

---

You are answering a question thread in beadcause, as **${agent.name}**. The user
commented from their phone and is waiting for a reply — they cannot see your
terminal, only what you write onto the bead. They chose you from a list, so answer as
the brief above says, not as a general assistant.

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

       bd comment ${id} --actor ${agent.id} "<your reply>"

   Pass --actor exactly as shown. It is what marks the comment as coming from an
   agent rather than from the user, it is what makes their phone notify, and it is
   what tells them afterwards which agent answered.

4. **Do not close the bead.** The decision is theirs; you are answering, not deciding.

5. **Do not create beads.** Adam approves every bead before it exists. If this thread
   has turned up work worth tracking, say so in your comment and let him ask for it.

${
  elevated
    ? `**You are running this one reply with EXTENDED TOOLS**, granted deliberately for
this reply and nothing after it. Adam accepted a warning to give you them, so use
them for what he asked and no more: no unrelated tidying, no changes he did not ask
for, and say in your comment exactly what you did with them.

`
    : ''
}You are running unattended with a read-only allowlist: you can read files and run the
\`bd\` subcommands that only look. Creating, closing, labelling and deleting are not
available to you, by design rather than by omission. If you cannot do what they asked — missing context, or it needs a
decision only they can make — say that plainly in the comment. Silence is the exact failure this
was built to fix, so never finish without commenting.

${reflection}`;
}


/**
 * File whatever the agent asked for at the end of its run, if it asked for anything.
 *
 * Almost always a no-op, and that is the design: an agent that files a request after
 * every task turns the one channel Adam reads for constitutional questions into a
 * feed he stops opening. Everything here is arranged so that silence costs nothing
 * and noise is caught before it reaches him — a request with no scope, a request
 * re-arguing something already refused, or a second request while one is open all
 * die in this function with a line in the log.
 *
 * `bd` arrives from the caller rather than being constructed here because the daemon
 * owns exactly one adapter, with the retry policy the Dolt lock needs. Without it the
 * reflection step still runs and its output is logged and dropped, which is the right
 * degradation: a dispatch that cannot file is still a dispatch that answered.
 */
async function fileAmendment(bd, workspace, dir, key, text, denials) {
  const request = amendment.parseAmendment(text);
  if (!request) return;
  if (request.error) {
    // Logged loudly. "It did not ask" and "it asked and we threw it away" look
    // identical from outside, and only one of them is something to fix.
    console.error(`[beadcause] ${key}: ignoring a malformed amendment request — ${request.error}`);
    agentlog.append(key, `● amendment request rejected: ${request.error}`);
    return;
  }
  if (!bd) {
    console.log(`[beadcause] ${key}: ${request.agent} asked to amend ${Object.keys(request.set).join(', ')}, but no tracker was passed`);
    return;
  }

  // The agent's own account, plus what the transcript actually shows. Both, in that
  // order, because a denial it did not mention is the evidence Adam most wants and
  // an account of a denial that never happened is the thing he most needs to catch.
  if (denials.length) {
    request.evidence = [request.evidence, ...denials.map((d) => `- ${d}`)].filter(Boolean).join('\n');
  }

  try {
    if (await amendment.alreadyRefused(dir, request)) {
      console.log(`[beadcause] ${key}: ${request.agent} re-asked for something already refused — not filing`);
      agentlog.append(key, '● amendment request dropped: you have already said no to this');
      return;
    }
    const filed = await amendment.fileRequest(bd, workspace, dir, request, { from: key });
    if (!filed) return;
    if (filed.skipped) {
      console.log(`[beadcause] ${key}: ${request.agent} has a request open already (${filed.skipped})`);
      agentlog.append(key, `● amendment request held back: ${filed.skipped}`);
      return;
    }
    console.log(`[beadcause] ${key}: ${request.agent} asked to change itself — filed ${workspace.name}/${filed.id}`);
    agentlog.append(key, `● asked to change its own foundation — ${filed.id}`);
  } catch (err) {
    console.error(`[beadcause] ${key}: could not file an amendment request — ${err.message.split('\n')[0]}`);
  }
}

/**
 * Spawn an agent to answer the latest comment. Fire-and-forget: the phone must not
 * wait on a model round trip, so this returns as soon as the process is launched.
 *
 * Async only for the foundation read, which is one git call before the spawn.
 */
export async function dispatchReply(
  cfg,
  workspace,
  id,
  title,
  { agentId = null, elevated = false, bd = null, issue = null } = {}
) {
  const key = `${workspace.name}/${id}`;
  // Falls back to the configured default, then to the first agent there is — an
  // unknown id from an old phone must still get an answer, not silence.
  const agent = agentFor(cfg, agentId);

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

  // The foundation is the baseline reach — an approved amendment widens it there and
  // every reply agent inherits it. `elevated` is armed for ONE reply and consumed by
  // the caller, and its string still comes from the config file: arming decides
  // *whether* the override applies, never *what it says*.
  const f = await effective(dir, 'dispatch');
  const baseTools = f.allowedTools?.length ? f.allowedTools.join(' ') : DEFAULT_TOOLS;
  const tools = elevated && agent.tools ? agent.tools : baseTools;
  // The roster's model wins over the foundation's: you chose this agent by name, and
  // a per-agent model in config is a choice about that name specifically.
  const model = agent.model || f.model;

  // Is this thread a request to change what an agent is? Then the roster is the
  // wrong place to pick an answerer from — the agent that filed it should answer,
  // seeded with its own foundation and its own argument. See `amendment.replyPrompt`
  // for why a re-seeded one-shot is honestly that agent and not an impostor.
  const asked = issue
    ? amendment.parseAmendment([issue.description, issue.design, issue.notes].filter(Boolean).join('\n\n'))
    : null;
  const arguing = asked && !asked.error ? asked : null;

  // The reflection step, and the refusals that keep it from re-arguing a lost case.
  // Skipped when the agent is already arguing one: a request filed while a request
  // is open is the second question in an inbox that should only ever hold one.
  let reflection = '';
  if (!arguing) {
    try {
      reflection = amendment.reflectionPrompt(f, await amendment.refusalsFor(dir, 'dispatch'));
    } catch (err) {
      // Reflection is the optional half. An agent that cannot be asked to introspect
      // must still answer the question it was dispatched for.
      console.error(`[beadcause] no reflection step for ${key}: ${err.message.split('\n')[0]}`);
    }
  }

  const prompt = arguing
    ? amendment.replyPrompt(arguing, await effective(dir, arguing.agent), { workspace: workspace.name, id, title })
    : promptFor(workspace.name, id, title, agent, tools !== baseTools, reflection);

  const promptFile = path.join(os.tmpdir(), `beadcause-reply-${crypto.randomBytes(6).toString('hex')}.md`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });

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
    `exec claude -p "$P" --allowedTools '${tools}'${
      model ? ` --model ${model}` : ''
    } --output-format stream-json --verbose`;

  inFlight.set(key, { agentId: agent.id, at: new Date().toISOString() });
  // Show it on the card immediately. Half the complaint was not knowing whether
  // anything had picked the comment up at all.
  // The name is the point: you picked this one, so the chip has to say which one
  // picked it up, or choosing was theatre.
  setActivity(key, { phase: 'thinking', detail: `${agent.name} is picking up your comment`, actor: agent.name });

  // A fresh run gets a fresh log. Appending would leave yesterday's answer sitting
  // above today's question, which reads as progress that has already happened.
  agentlog.reset(key);
  agentlog.append(key, `● ${agent.name} dispatched in ${dir}`);

  const child = spawn('/bin/zsh', ['-lc', command], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // stream-json is newline-delimited, but a chunk boundary lands mid-line often
  // enough that parsing chunks directly loses events — hold the remainder over.
  let pending = '';
  let lastText = '';
  // Denied tool calls, read off the transcript rather than taken on trust. A
  // prohibition is the one half of "what stopped you" that beadcause can observe for
  // itself — see the note on `amendment.denialFrom`.
  const denials = [];
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
      const denied = amendment.denialFrom(event);
      if (denied && denials.length < 5 && !denials.includes(denied)) denials.push(denied);
      // The phase chip on the card follows the log, so the summary line and the
      // detail never disagree about what the agent is doing.
      if (event.type === 'assistant') {
        setActivity(key, { phase: 'drafting', detail: `${agent.name} is writing a reply`, actor: agent.name });
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
      setActivity(key, { phase: 'blocked', detail: `${agent.name} failed: ${detail}`.slice(0, 140), actor: agent.name });
      return;
    }
    console.log(`[beadcause] auto-dispatch answered ${key} (${lastText.trim().length} chars)`);
    // The agent's own comment is what notifies the phone, via the reply poller.
    clearActivity(key);
    // And then, separately, whether it wants to be different. Deliberately after the
    // answer is already in: the reply is the job, the request is a by-product, and a
    // failure to file one must never look like a failure to answer.
    void fileAmendment(bd, workspace, dir, key, lastText, denials);
  });
  child.unref?.();

  // Loud, and in the log launchd keeps: an elevated run is the one line anyone
  // reading this file afterwards needs to be able to find.
  console.log(
    `[beadcause] dispatched ${agent.name} for ${key} in ${dir}${
      tools !== baseTools ? ` — WITH EXTENDED TOOLS: ${tools}` : ''
    }`
  );
  return { dispatched: true, dir, agent: { id: agent.id, name: agent.name }, elevated: tools !== baseTools };
}
