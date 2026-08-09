import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CONFIG_DIR } from './config.js';
import { resolveSessionDir } from './session.js';
import { extractProposal, draftToYaml } from './draft.js';
import { effective, withConfig, claudeArgs, systemPrompt } from './foundation.js';

/**
 * The bead console — a conversation about what to file, before anything is filed.
 *
 * Everything else in beadcause acts on beads that already exist. This is the one
 * place work is *decided*: you open a console, describe the thing however it comes
 * out, and an agent asks you the questions that would change the answer — is this
 * one bead or four, what does done mean, does something already cover it — until
 * there is a proposal worth creating. Nothing reaches the tracker until you have
 * read that proposal on screen, edited it, and pressed the button.
 *
 * Three decisions shape this file.
 *
 * **A turn is a fresh `claude -p`, resumed by session id.** Not a long-lived
 * process. A phone conversation has minutes of silence in it, and a process parked
 * across those minutes is a process that dies to a laptop lid, a `launchctl
 * kickstart` or an OOM, taking the conversation with it. `--session-id` on the
 * first turn and `--resume` on every one after gives the same continuity for free,
 * and Claude Code's own transcript becomes the durable copy — a console survives a
 * daemon restart because the state here is small and the history lives there.
 *
 * **The agent cannot write to the tracker.** Its allowlist is read-only `bd` plus
 * Read/Grep/Glob. That is not belt-and-braces around the prompt: the review step is
 * the entire promise of the feature, and an agent that could call `bd create` would
 * eventually do it mid-conversation and then beadcause would create the same beads
 * again from the proposal. One writer, and it is the button you press.
 *
 * **It runs through a login shell, in the resolved session directory.** Same rule
 * as lib/dispatch.js and lib/session.js: `~/.zshenv` derives `BEADS_DIR`,
 * `BEADS_ACTOR` and `CLAUDE_CONFIG_DIR` from `$PWD`, so where the process starts is
 * what decides which tracker it reads and which account it bills.
 */

const CONSOLE_DIR = path.join(CONFIG_DIR, 'consoles');

/** Consoles older than this are pruned on start — a conversation is not an archive. */
const KEEP_DAYS = 30;

/**
 * The wire format, and why it is here rather than in the foundation.
 *
 * What this agent *is* — its role, its read-only allowlist, its model — moved to
 * `lib/foundation.js`, where it is one object that beadcause owns and an approved
 * amendment can change. This block did not move, because it is not what the agent
 * is: it is the contract `lib/draft.js` parses, and it belongs beside that parser so
 * the two cannot drift apart. It is also the half that must never be amendable — an
 * agent free to restyle its own output could break the parser reading it and look
 * merely unhelpful while doing so.
 *
 * `foundation.systemPrompt()` appends it after the role, so it is the most recent
 * thing in context when the agent writes the block that has to match it.
 */
const PROTOCOL = `When you have enough to be useful, end the message with a proposal — a fenced
\`beads\` block, exactly this shape:

\`\`\`beads
beads:
  - ref: short-handle
    title: One line, imperative — what will be true once it is done
    type: task            # task | bug | feature | epic | chore
    priority: 2           # 0 critical, 1 high, 2 medium, 3 low, 4 backlog
    description: |
      Why this exists and what needs doing. Enough that whoever picks it up cold
      does not have to reconstruct this conversation to understand it.
    acceptance: |
      How we will know it is done.
    labels: [area]
    parent: other-handle                 # optional: a ref above, or a real bead id
    dependsOn: [other-handle, cl-1jw]    # refs above, or real ids that already exist
\`\`\`

Rules for the block:

- **One block per message, at the end, and always the whole proposal.** It replaces
  the previous one rather than adding to it — a revision re-emits every bead,
  including the ones that did not change.
- \`ref\` is a handle for this conversation only. Real ids may appear in \`parent\` and
  \`dependsOn\` to point at beads that already exist.
- Only \`title\` is required. Propose the fields you actually have an opinion about.
- **Do not propose until you can say what each bead is for.** An early half-guessed
  proposal is worse than one more question, because the user has to read it either way.
- The user edits your proposal on screen. When you are shown the current draft, that
  draft is the truth — build on it rather than re-proposing what you said before.`;

/**
 * What the other three agents are told when Adam opens a chat with them.
 *
 * They are running with their real foundation — same role, same allowlist, same
 * model — but not doing their job: nobody filed a bead, no queue ran dry. Without
 * being told that, an advocate handed a bare message reasonably assumes it is
 * mid-survey and answers with a proposal nobody asked for.
 *
 * The last paragraph is the part that matters for bc-goo.4. An agent is closest to
 * knowing what its foundation stops it doing right after being asked to do
 * something it cannot — so this is where that observation is invited, and it is
 * invited as a description rather than a request, because the request has a form
 * (a bead, a justification, a scope) that does not belong in a chat bubble.
 */
const CHAT_PROTOCOL = `You are in a direct conversation with Adam on the beadcause agents screen. He opened
it deliberately, to talk to *you*, about how you work.

- **You are not doing your job right now.** No bead was filed for this and no queue
  ran dry. Answer what he asks; do not produce your usual output unless he asks for it.
- **You are running with your real foundation** — the same role, allowlist, model and
  working directory you have when you run for real. So what you can and cannot do
  here is exactly what you can and cannot do at work. If a tool call is denied, say
  so plainly rather than working around it; that denial is information he wants.
- **He is on a phone.** Short paragraphs, plain markdown. No ASCII tables, no banner
  blocks, no status headers.

If, in the course of this, you notice something you could usefully do but cannot —
because your foundation prohibits it, or simply never gave it to you — say so, in one
or two sentences, naming the specific thing and what you would do with it. Do not
file anything and do not argue for it at length. Adam decides what becomes a request.`;

/* ------------------------------------------------------------------ storage */

/** Loaded consoles, keyed by id. The file on disk is the durable copy. */
const live = new Map();
/** Per-console long-poll waiters, so the phone learns about a token without polling. */
const waiters = new Map();

const filePath = (id) => path.join(CONSOLE_DIR, `${id}.json`);

function persist(c) {
  try {
    fs.mkdirSync(CONSOLE_DIR, { recursive: true });
    fs.writeFileSync(filePath(c.id), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error(`[beadcause] could not save console ${c.id}: ${err.message}`);
  }
}

/**
 * Bump the change counter and release anyone parked on it.
 *
 * Called on every streamed token, so it deliberately does NOT write to disk —
 * persistence happens at turn boundaries. A daemon killed mid-turn loses the half
 * of a reply it had streamed, which is recoverable (the turn is in Claude Code's
 * own transcript) and is a better trade than fsync-ing a file per token.
 */
function touch(c) {
  c.seq += 1;
  c.updatedAt = new Date().toISOString();
  for (const w of waiters.get(c.id) || []) w(c.seq);
  waiters.set(c.id, []);
}

export function getConsole(id) {
  if (!/^[a-z0-9-]{6,64}$/i.test(String(id || ''))) return null;
  if (live.has(id)) return live.get(id);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath(id), 'utf8'));
  } catch {
    return null;
  }
  // A console read back from disk is by definition not mid-turn: whatever process
  // was streaming into it belongs to a daemon that is gone. Saying "thinking"
  // forever would leave the composer disabled with nothing on the way.
  if (raw.status === 'thinking') {
    raw.status = 'idle';
    const last = raw.messages?.[raw.messages.length - 1];
    if (last?.pending) {
      last.pending = false;
      last.interrupted = true;
    }
  }
  live.set(id, raw);
  return raw;
}

/** Wait until this console changes, or `ms` passes. Returns the current seq. */
export function waitForConsole(id, since, ms) {
  const c = getConsole(id);
  if (!c) return Promise.resolve(0);
  if (c.seq > since) return Promise.resolve(c.seq);
  return new Promise((resolve) => {
    const list = waiters.get(id) || [];
    const timer = setTimeout(() => resolve(c.seq), ms);
    list.push((seq) => {
      clearTimeout(timer);
      resolve(seq);
    });
    waiters.set(id, list);
  });
}

/**
 * Every console, newest first, slim enough to list.
 *
 * Reads the directory rather than the in-memory map: consoles opened before the
 * last restart are exactly the ones you want to find again.
 */
export function listConsoles(limit = 30) {
  let names;
  try {
    names = fs.readdirSync(CONSOLE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const c = getConsole(name.replace(/\.json$/, ''));
    if (!c) continue;
    out.push({
      id: c.id,
      // Which agent this conversation is with. Absent on anything written before
      // agent chats existed, and those are all bead consoles.
      agent: c.agent || 'console',
      workspace: c.workspace,
      title: c.title,
      seed: c.seed,
      status: c.status,
      // The list draws these apart: finished conversations sink, and the row that
      // still wants something from you stays where you can see it.
      closedAt: c.closedAt || null,
      messageCount: c.messages.length,
      beadCount: c.draft?.beads?.length || 0,
      created: c.created,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    });
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
}

/** Drop conversations nobody came back to. Best-effort, called once at startup. */
export function pruneConsoles(days = KEEP_DAYS) {
  const cutoff = Date.now() - days * 86400000;
  let names = [];
  try {
    names = fs.readdirSync(CONSOLE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  let dropped = 0;
  for (const name of names) {
    const full = path.join(CONSOLE_DIR, name);
    try {
      if (fs.statSync(full).mtimeMs >= cutoff) continue;
      fs.rmSync(full, { force: true });
      live.delete(name.replace(/\.json$/, ''));
      dropped += 1;
    } catch {
      /* a console we cannot stat is one we leave alone */
    }
  }
  if (dropped) console.log(`[beadcause] pruned ${dropped} console(s) older than ${days} days`);
  return dropped;
}

/* ----------------------------------------------------------------- creating */

const now = () => new Date().toISOString();

/**
 * Open a console on a workspace, optionally seeded with a bead.
 *
 * The directory is resolved up front, and a workspace with no directory that maps
 * back to it fails here rather than at the first turn — the same guard
 * `POST /api/session` applies, for the same reason: a console that quietly reads
 * the wrong tracker would propose beads about the wrong project.
 */
export function createConsole(cfg, workspace, seed = null, { agent = 'console' } = {}) {
  const dir = resolveSessionDir(cfg, workspace);
  const c = {
    id: crypto.randomBytes(8).toString('hex'),
    // Which agent is on the other end. 'console' is the bead console this file was
    // written for; anything else is the agents screen talking to one of the other
    // three, which is the same conversation machinery with a different foundation
    // and no proposal expected. Stored per conversation rather than passed per turn,
    // because a conversation cannot change who it has been talking to.
    agent,
    workspace: workspace.name,
    dir,
    seed: seed ? { id: seed.id, title: seed.title || '' } : null,
    // Claude Code's id for the conversation. We choose it so the first turn can
    // create it and every turn after can resume it without parsing anything back.
    claudeSessionId: crypto.randomUUID(),
    started: false,
    title: agent !== 'console' ? `Chat with the ${agent}` : seed ? `From ${seed.id}` : 'New beads',
    status: 'idle',
    error: null,
    seq: 1,
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    draft: null,
    // Set when you edit the cards, cleared once the agent has been shown the edit.
    draftDirty: false,
    created: [],
    costUsd: 0,
  };
  live.set(c.id, c);
  persist(c);
  const what = agent === 'console' ? 'console' : `${agent} chat`;
  console.log(`[beadcause] ${what} ${c.id} opened on ${workspace.name}${seed ? ` from ${seed.id}` : ''} in ${dir}`);
  return c;
}

/**
 * Whether this conversation should expect a proposal back.
 *
 * Only the bead console does. Chatting with the advocate about why it proposed
 * something must not hand the create button a `beads` block scraped out of an
 * example it quoted — the button is the only writer, and it should only ever be
 * offered what an agent meant as a proposal.
 */
const proposes = (c) => (c.agent || 'console') === 'console';

/* ------------------------------------------------------------------ prompts */

/** Context the agent only needs once — after this it is in its own transcript. */
function openingContext(c) {
  const lines = [
    `${proposes(c) ? 'This console is' : 'This conversation is'} for the **${c.workspace}** workspace.`,
    `You are running in \`${c.dir}\`, so a plain \`bd\` command already points at the right tracker.`,
  ];
  if (c.seed) {
    lines.push(
      '',
      `We are starting from an existing bead: **${c.seed.id}**${c.seed.title ? ` — "${c.seed.title}"` : ''}.`,
      '',
      `Read it first (\`bd show ${c.seed.id}\`, and \`bd comments ${c.seed.id}\` if it has a thread).`
    );
  }
  return lines.join('\n');
}

/** What an auto-started, seeded console says before the user has typed anything. */
function seedOpener(c) {
  return `${openingContext(c)}

Then open the conversation: in a couple of lines, what do you think the next piece of
work off the back of that bead is, and what do you need to know from me? Ask the
questions that would change the answer.

Do not propose a \`beads\` block yet — unless the bead already spells the work out, in
which case propose it and say why you think it is that clear.`;
}

/**
 * One user turn, with whatever state the agent could not have seen.
 *
 * The edited draft is fed back verbatim whenever the cards have been touched. Without
 * it the agent argues with the proposal it remembers rather than the one on screen,
 * and re-proposes a title you rewrote two turns ago — which reads as it ignoring you.
 */
function turnPrompt(c, text) {
  const parts = [];
  if (!c.started) parts.push(openingContext(c), '');

  if (c.created.length) {
    const made = c.created.map((x) => `- ${x.id} — ${x.title}`).join('\n');
    parts.push(
      'These beads have already been created from this conversation and now exist in the tracker:',
      '',
      made,
      '',
      'Do not propose them again. Any new proposal is work *in addition* to those, and may',
      'depend on them by id.',
      ''
    );
  }

  if (c.draftDirty && c.draft?.beads?.length) {
    parts.push(
      'I edited the proposal on screen. This is the current draft — treat it as the truth:',
      '',
      '```beads',
      draftToYaml(c.draft).trim(),
      '```',
      ''
    );
  }

  parts.push(String(text || '').trim());
  return parts.join('\n').trim();
}

/* -------------------------------------------------------------------- turns */

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A one-line label for what a tool call is doing, for the "working" line on screen. */
function toolBrief(name, input) {
  const first = (s) => String(s || '').split('\n')[0].slice(0, 80);
  if (name === 'Bash') return first(input?.command);
  if (name === 'Read') return first(input?.file_path)?.split('/').pop() || '';
  if (name === 'Grep') return first(input?.pattern);
  if (name === 'Glob') return first(input?.pattern);
  return first(input?.description);
}

/**
 * Run a turn: append the user's message, spawn `claude`, stream the reply back.
 *
 * Returns as soon as the process is launched. The phone follows along through
 * `/api/console/poll`, which is the same shape as the inbox's long poll — so a turn
 * that takes ninety seconds of tool calls is watched rather than waited on, and
 * closing the app mid-turn loses nothing: the reply lands in the console either way.
 *
 * Async only because the foundation is resolved per turn, and reading it is a git
 * call. Per turn rather than once at startup on purpose: a turn is already a fresh
 * `claude -p`, so an amendment approved while a console is open takes effect on the
 * next message rather than the next daemon restart.
 */
export async function sendTurn(cfg, c, text) {
  // Saying something to a closed console reopens it. The alternative is a dead end
  // you can navigate to and not use, and "one more thing" is a normal thought to
  // have five minutes after filing.
  if (c.closedAt) {
    c.closedAt = null;
    c.messages.push({ role: 'system', kind: 'reopened', text: 'Reopened.', at: now() });
  }
  if (c.status === 'thinking') {
    throw Object.assign(new Error('this console is already working on a turn'), { status: 409 });
  }
  const prompt = turnPrompt(c, text);
  if (!prompt) throw Object.assign(new Error('nothing to send'), { status: 400 });

  // Before the message is appended, so a foundation that cannot be read fails the
  // turn cleanly instead of leaving a pending assistant bubble nothing will fill.
  // The agent's real foundation, not a sandbox copy of it. Chatting with the
  // advocate about what it cannot do is only worth anything if it is running under
  // the same constraints it works under.
  const f = withConfig(await effective(c.dir, c.agent || 'console'), cfg);

  // The user's own words go in the transcript, not the assembled prompt: the draft
  // dump and the created-bead list are plumbing, and showing them as something you
  // said would be a lie about the conversation.
  if (String(text || '').trim()) {
    c.messages.push({ role: 'user', text: String(text).trim(), at: now() });
  }
  const reply = { role: 'assistant', text: '', streaming: '', tools: [], at: now(), pending: true };
  c.messages.push(reply);
  c.status = 'thinking';
  c.error = null;
  c.draftDirty = false;
  touch(c);
  persist(c);

  const stamp = crypto.randomBytes(6).toString('hex');
  const promptFile = path.join(os.tmpdir(), `beadcause-console-${stamp}.md`);
  const systemFile = path.join(os.tmpdir(), `beadcause-console-sys-${stamp}.md`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  fs.writeFileSync(systemFile, systemPrompt(f, proposes(c) ? PROTOCOL : CHAT_PROTOCOL), { mode: 0o600 });

  const args = [
    '-p',
    '"$P"',
    c.started ? '--resume' : '--session-id',
    shq(c.claudeSessionId),
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // No MCP servers. They are irrelevant to designing a bead, and each one is
    // startup latency and system-prompt tokens on every single turn.
    '--strict-mcp-config',
    ...claudeArgs(f, { systemFile }),
  ];

  // Same shape as lib/dispatch.js: a login shell so ~/.zshenv resolves BEADS_DIR and
  // CLAUDE_CONFIG_DIR from the spawn directory, with the prompt arriving via a file
  // so a multi-line markdown brief never has to survive being quoted through it.
  const command =
    `P="$(cat ${shq(promptFile)})"; rm -f ${shq(promptFile)}; ` + `exec claude ${args.join(' ')}`;

  const child = spawn('/bin/zsh', ['-lc', command], {
    cwd: c.dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const cleanup = () => {
    fs.rmSync(promptFile, { force: true });
    fs.rmSync(systemFile, { force: true });
  };

  const timeoutMs = f.timeoutMs ?? 900000;
  const timer = setTimeout(() => {
    console.error(`[beadcause] console ${c.id}: turn timed out after ${Math.round(timeoutMs / 1000)}s`);
    child.kill('SIGTERM');
  }, timeoutMs);

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    // The last piece is whatever arrived without its newline yet.
    buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // not every line on stdout is ours to understand
      }
      consume(c, reply, msg);
    }
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    cleanup();
    finish(c, reply, `could not start claude: ${err.message}`);
  });

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    cleanup();
    // A turn that produced text and then exited badly still gave you the text —
    // reporting only the exit code would throw away a complete reply.
    const detail = reply.text.trim()
      ? null
      : signal === 'SIGTERM'
        ? 'the turn timed out'
        : code === 0
          ? 'claude returned nothing'
          : `claude exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`;
    finish(c, reply, detail);
  });

  return c;
}

/**
 * Fold one stream-json event into the reply.
 *
 * Partial deltas and completed messages are kept in separate fields on purpose. A
 * turn with tool calls emits several `assistant` messages, so the completed text has
 * to accumulate; the deltas are only the in-flight block, and adding both to one
 * string would print every sentence twice the moment its block closed.
 */
function consume(c, reply, msg) {
  if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      reply.streaming += ev.delta.text || '';
      touch(c);
    }
    return;
  }

  if (msg.type === 'assistant') {
    // A subagent's chatter is not this conversation. Only the top-level turn is.
    if (msg.parent_tool_use_id) return;
    for (const block of msg.message?.content || []) {
      if (block.type === 'text' && block.text) reply.text += (reply.text ? '\n\n' : '') + block.text;
      if (block.type === 'tool_use') {
        reply.tools.push({ name: block.name, brief: toolBrief(block.name, block.input), at: now() });
      }
    }
    reply.streaming = '';
    touch(c);
    return;
  }

  if (msg.type === 'result') {
    if (typeof msg.total_cost_usd === 'number') c.costUsd = Number((c.costUsd + msg.total_cost_usd).toFixed(4));
    // `result` carries the whole final answer. Trust it over the accumulated
    // blocks — it is what the CLI itself considers the reply.
    if (!msg.is_error && typeof msg.result === 'string' && msg.result.trim()) reply.text = msg.result.trim();
    if (msg.is_error) reply.error = String(msg.result || 'the turn failed').split('\n')[0];
  }
}

/**
 * Close out a turn: split the proposal out of the reply and make it the draft.
 *
 * A block that fails to parse is attached to the message rather than dropped. An
 * agent that proposed something and a phone that shows nothing are indistinguishable
 * from the outside, and the second one looks like beadcause losing your work.
 */
function finish(c, reply, errorDetail) {
  reply.pending = false;
  reply.streaming = '';

  // Only where a proposal is the point. A chat with the advocate that happens to
  // quote a `beads` block is quoting, not proposing, and lighting up the create
  // button for it would offer to file an example.
  const parsed = proposes(c) ? extractProposal(reply.text) : { text: reply.text };
  reply.text = parsed.text;
  if (parsed.error) reply.proposalError = parsed.error;
  if (parsed.draft) {
    c.draft = parsed.draft;
    c.draftDirty = false;
    reply.proposed = parsed.draft.beads.length;
    // Name the console after what it is actually about, once there is an answer.
    if (!c.seed && c.title === 'New beads') c.title = parsed.draft.beads[0].title.slice(0, 60);
  }

  const failed = errorDetail || reply.error;
  if (failed && !reply.text.trim()) {
    c.status = 'error';
    c.error = failed;
    reply.text = '';
    console.error(`[beadcause] console ${c.id}: ${failed}`);
  } else {
    c.status = 'idle';
    c.error = null;
    // The first successful turn is what creates the Claude Code session; every turn
    // after it resumes. Setting this on failure would resume a session that was
    // never written, and every subsequent turn would fail the same way.
    c.started = true;
  }

  if (!c.seed && c.title === 'New beads') {
    const firstUser = c.messages.find((m) => m.role === 'user');
    if (firstUser) c.title = firstUser.text.split('\n')[0].slice(0, 60);
  }

  touch(c);
  persist(c);
}

/* ------------------------------------------------------- draft & bookkeeping */

/** Accept the cards as edited on the phone. `draftDirty` makes the next turn see them. */
export function setDraft(c, draft) {
  c.draft = draft;
  c.draftDirty = true;
  if (!draft) c.draftDirty = false;
  touch(c);
  persist(c);
  return c;
}

/**
 * Record what was created, in the transcript as well as the state.
 *
 * The conversation keeps going after a create — "good, now the follow-up work" is a
 * normal next thing to say — so the beads have to be visible in the scrollback and
 * known to the agent, or it would propose them all over again.
 */
/**
 * Close a console.
 *
 * A console is a conversation with one purpose — decide what to file — and it is
 * over when the beads exist. Leaving it open leaves a list that only ever grows,
 * where every row is finished work you have to read past to find the one that is
 * not.
 *
 * A **soft** close: the transcript stays on disk, the id keeps working, and saying
 * anything to it reopens it (see `sendTurn`). Nothing is deleted here — that is
 * `pruneConsoles`, on its own timer.
 *
 * Refused mid-turn. A console that is `thinking` has a `claude` process streaming
 * into it, and closing under that would leave the reply arriving into something the
 * list says is finished.
 */
export function closeConsole(c, { reason = '' } = {}) {
  if (c.status === 'thinking') {
    throw Object.assign(new Error('this console is mid-turn — wait for it to finish'), { status: 409 });
  }
  if (c.closedAt) return c;
  c.closedAt = now();
  c.status = 'closed';
  c.messages.push({ role: 'system', kind: 'closed', text: reason || 'Closed.', at: c.closedAt });
  // A closed console keeps its transcript but not its unspent draft: cards left on
  // screen after a close are an invitation to create them twice.
  c.draft = null;
  c.draftDirty = false;
  touch(c);
  persist(c);
  return c;
}

export function recordCreated(c, created, warnings = []) {
  c.created.push(...created);
  c.messages.push({
    role: 'system',
    kind: 'created',
    text: '',
    created,
    warnings,
    at: now(),
  });
  // The draft is spent: those beads exist now, and leaving the cards on screen would
  // invite creating them twice.
  c.draft = null;
  c.draftDirty = false;
  touch(c);
  persist(c);
  return c;
}

export { CONSOLE_DIR };
