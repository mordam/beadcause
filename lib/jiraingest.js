/**
 * Reading the ticket — the asynchronous half, and the one that turns a link into work.
 *
 * lib/jirapoll.js says which tickets are yours. lib/jiraepic.js gives each of them one
 * P1 epic, held, forever. Neither of those has read a word of the ticket: the epic is
 * built from a summary and a status, which is enough to *find* the work and nothing like
 * enough to *do* it. This is the step in between — an agent reads the ticket's own
 * description and thread, proposes the beads it decomposes into, and those beads are
 * created as real children of the epic.
 *
 * ## It is the chat session's path, with a ticket where the conversation was
 *
 * Nothing here invents a way to propose beads. `lib/console.js` already runs an agent
 * that reads something and answers with a fenced `beads` block; `lib/draft.js` already
 * parses that block, repairs its graph, orders it for creation and resolves refs to
 * parents. Both are used verbatim — the protocol string is *imported* from console.js
 * rather than copied, because a second copy is a second thing that can drift away from
 * the parser reading it.
 *
 * What is different is only the input and who presses the button:
 *
 *   - **The input is a ticket**, fetched with its description and its thread
 *     (`lib/jira.js`'s `issue`, `descriptionText`, `threadOf`), because a decomposition
 *     made from a one-line summary is a decomposition of the title.
 *   - **Nobody presses anything.** A chat session waits for you; a ticket arrives while
 *     you are asleep and the whole point of the epic is that the inbox has something to
 *     tap by morning. So the children are created by this file.
 *
 * That is not the review going missing. It is the review moving up one level, which is
 * what bc-0i27 asks for in so many words: the children arrive `unendorsed`, exactly as
 * the epic does, and **nothing will open a session on a held bead** (`lib/endorse.js` —
 * `assertEndorsed` asks the tracker itself, so even the launcher refuses). They are
 * beads you can read, edit, re-prioritise, delete and argue with, and none of them is
 * work until the approve on the row (bc-0i27.7) lifts the hold. Held-and-editable is
 * what "the proposal is editable before it becomes work" means here; the alternative —
 * parking a proposal in a queue nobody has opened — would leave the row saying *still
 * reading* until somebody happened to look, which is the state this whole epic exists to
 * keep off the screen.
 *
 * ## Exactly once, and never twice — the same problem as the epic, one net short
 *
 * lib/jiraepic.js has `external_ref` to ask the tracker with. A child has no ref of its
 * own, so the question "has this ticket been ingested?" is asked of the *epic*: an epic
 * with children has been. That is deliberately the safe direction and it is worth being
 * plain about the cost. A run that failed half way leaves two children of the five it
 * meant to make, and the next daemon start will see two children and call it done rather
 * than filing three more beside them. A half-decomposed epic that says so on the row is
 * recoverable by anybody reading it; a duplicated one is a tracker nobody trusts.
 *
 * So the state machine is small and every arrow is on purpose:
 *
 *     (nothing) --epic exists, no children--> reading --agent + creates--> done
 *                        |                       |
 *                 children already          agent failed, or bd refused
 *                        v                       v
 *                      done                    failed   (retried on the next daemon start)
 *
 * `failed` is sticky within the life of the process. A ticket whose ingestion failed is
 * not tried again a minute later: the failures that reach here are an agent that could
 * not run, a JIRA read that was refused, a `bd` that would not take a title — none of
 * which a retry in sixty seconds fixes, and all of which would otherwise buy a `claude`
 * process a minute, forever, for a ticket nobody can see is stuck. It says so on the row
 * instead, which is where somebody can do something about it.
 *
 * ## What it costs, and why the cap is one
 *
 * An ingestion is a `claude -p` process that reads a ticket and greps a repo — minutes,
 * and real money. `MAX_RUNNING` is 1 across every workspace, so a morning that assigns
 * you nine tickets ingests them one after another rather than putting nine agents on
 * this Mac at once; the rest simply wait for a later tick, with their rows saying so.
 * `sweep` never awaits a run — it starts what it can and returns — because it is called
 * from the poll cycle, and a cycle that blocked for four minutes would stop the phone
 * being answered.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { PROTOCOL } from './console.js';
import { extractProposal, topoOrder } from './draft.js';
import { applyEdges } from './edges.js';
import { UNENDORSED } from './endorse.js';
import { effective, claudeArgs, promptArgs, systemPrompt, agentEnv } from './foundation.js';
import { descriptionText, issue as fetchIssue, settingsFor, threadOf } from './jira.js';
import { EPIC_PRIORITY, TICKET_LABEL } from './jiraepic.js';
import { memoryBrief } from './memory.js';
import { ownerName } from './owner.js';
import { resolveSessionDir } from './session.js';
import { autoEndorseAllowed } from './spaces.js';

/** One ingestion at a time, across every workspace. See the header for why it is one. */
export const MAX_RUNNING = 1;

/** How many children one ticket may produce. A ticket is not a backlog. */
export const MAX_CHILDREN = 20;

/** How much of the ticket reaches the prompt. Beyond this it is somebody's essay. */
export const BODY_MAX = 12000;

/** How many comments are read. Newest wins when a thread is longer than this. */
export const COMMENT_MAX = 12;

/** How long an ingestion may run before it is killed. Overridden by the foundation. */
export const TIMEOUT_MS = 15 * 60 * 1000;

/** `<workspace>::<KEY>` — the key everything here is remembered under. */
export const stateKey = (workspace, key) => `${String(workspace || '')}::${String(key || '')}`;

/** Trim without cutting a word in half, and say that it was cut. */
function clip(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf('\n');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}\n\n…[truncated at ${max} characters]`;
}

/**
 * The ticket, as the agent reads it.
 *
 * Prose rather than JSON, because the thing at the other end reads prose better than it
 * reads a payload, and because the fields that matter here — a description with a bulleted
 * list of requirements in it, a comment where somebody changed their mind — are prose to
 * begin with. Pure, and separate from the fetch, so the shape of the brief can be tested
 * without a JIRA.
 */
export function ticketBrief(ticket, detail = {}) {
  const lines = [`## ${ticket?.key || 'the ticket'} — ${ticket?.summary || '(no summary)'}`, ''];
  const facts = [];
  if (ticket?.status) facts.push(`status **${ticket.status}**`);
  if (ticket?.assignee) facts.push(`assigned to ${ticket.assignee}`);
  if (detail?.type) facts.push(`type ${detail.type}`);
  if (detail?.labels?.length) facts.push(`labels ${detail.labels.join(', ')}`);
  if (facts.length) lines.push(facts.join(' · '));
  if (ticket?.url) lines.push('', ticket.url);

  lines.push('', '### Description', '');
  lines.push(detail?.description ? clip(detail.description, BODY_MAX) : '_The ticket has no description._');

  const comments = (detail?.comments || []).slice(-COMMENT_MAX);
  if (comments.length) {
    lines.push('', `### Comments (${comments.length}${(detail.comments || []).length > comments.length ? ', most recent' : ''})`, '');
    for (const c of comments) {
      lines.push(`**${c.author}**${c.at ? ` — ${String(c.at).slice(0, 10)}` : ''}`, '', clip(c.text, 2000), '');
    }
  }
  return lines.join('\n').trim();
}

/**
 * The brief. What the agent is reading, what it is for, and the one thing it must not do.
 *
 * The last of those is worth stating rather than assuming: this agent runs with the chat
 * session's read-only foundation, so it *cannot* write to the tracker, and an agent that
 * spends four minutes trying is an agent that proposed nothing. Saying it plainly costs a
 * sentence and buys the run.
 */
export function ingestPrompt({ ticket, detail, epic, workspace, repo = null, owner = 'the user' }) {
  return [
    `A JIRA ticket has arrived assigned to ${owner}, in the **${workspace}** workspace, and beadcause has already`,
    `filed one epic for it: **${epic.id}**${epic.title ? ` — "${epic.title}"` : ''}. Your job is to read the ticket and`,
    'propose the beads it decomposes into. Nothing else about it is yours.',
    '',
    ticketBrief(ticket, detail),
    '',
    '---',
    '',
    '### What to do',
    '',
    `1. **Read the ticket above**, and then read enough of \`${repo || 'this checkout'}\` to know what doing it would`,
    `   actually touch. You have \`bd\` (read-only), \`Read\`, \`Grep\` and \`Glob\`; \`bd show ${epic.id}\` is the epic.`,
    '2. **Propose the children**, as the `beads` block below. Between two and six is the usual honest answer for one',
    '   ticket. One bead is right when the ticket is one thing — say so and propose one rather than inventing five.',
    `   More than ${MAX_CHILDREN} will be cut.`,
    '3. **Each bead has to stand on its own.** Whoever picks one up will not have read the ticket, will not have this',
    '   conversation, and may be an agent with no memory of any of it. Put the *why* in the description.',
    '',
    '### What not to do',
    '',
    '- **Do not create anything.** You are read-only against the tracker by design; beadcause creates what you',
    '  propose, as children of the epic, the moment you answer. A `bd create` here fails and wastes the run.',
    "- **Do not propose the epic again**, and do not propose \"investigate the ticket\" — that is what you are doing.",
    '- **Do not set `parent` unless one proposed bead genuinely belongs under another.** Every bead you propose is a',
    `  child of ${epic.id} already; saying so on each one is noise, and pointing one at a bead that is not in your`,
    '  block loses it.',
    '',
    '### What happens to your answer',
    '',
    `The beads are created under ${epic.id} straight away, **held** (\`${UNENDORSED}\`) exactly as the epic is: nothing`,
    'opens a session on any of them until somebody approves the ticket. So this is a proposal that is read on a',
    'phone and edited before it becomes work, not a set of tasks about to be started — propose what you actually',
    'believe, and do not hedge the decomposition to make it safer to approve.',
  ].join('\n');
}

/**
 * One proposed bead → the arguments `Bd.create` takes, as a child of the epic.
 *
 * Pure, and this is where the three things a daemon-filed bead owes are paid — see
 * lib/filing.js for the argument and lib/jiraepic.js for the same payment one level up.
 * `fileBeads` is not the seam here for its reason there: it clamps to `PRIORITY_FLOOR`
 * and stamps `agent-filed` with a `discovered-from` edge, and a `discovered-from` edge is
 * exactly what makes `bd update --parent` refuse afterwards — the bead's own description
 * says so. A child of an epic is not a discovery.
 *
 *   - **The hold**, `UNENDORSED`, unless the space auto-endorses (lib/spaces.js).
 *   - **A home**, which is the epic — so bc-rfnr.7's "nothing decided above it" gate is satisfied
 *     through the parent rather than by a second homing call. This is the one place in
 *     the daemon where that is free, because the parent is the whole point of the bead.
 *   - **Provenance**: `jira-ticket`, the same label the epic carries, so everything one
 *     ticket produced can be found by one label after the hold has come off.
 *
 * Priority is clamped to the epic's rather than to `PRIORITY_FLOOR`: a child of a P1 epic
 * may be P1, and P0 is a thing Adam chooses, never an agent.
 */
export function childIssue(bead, { epic, ticket, parent = '', endorsed = false }) {
  const priority = Math.max(EPIC_PRIORITY, Number.isInteger(bead.priority) ? bead.priority : 2);
  const key = ticket?.key || '';
  return {
    title: bead.title,
    type: bead.type === 'epic' ? 'task' : bead.type,
    priority,
    body: bead.description,
    acceptance: bead.acceptance,
    design: bead.design,
    notes: [
      `_Ingested by beadcause from JIRA ${key}, under ${epic}._ ` +
        (endorsed
          ? 'It arrived **endorsed**: auto-endorsement is on for this repo, so nobody read it before it became ' +
            'workable and an advocate may open a session on it.'
          : `It is \`${UNENDORSED}\`, like the epic: nothing will open a session on it until the ticket is approved.`),
      '',
      'An agent read the ticket and proposed this bead; beadcause created it. If it is wrong, it is a bead — ' +
        'edit it, re-prioritise it or delete it. Nothing has been started.',
      bead.notes ? `\n${bead.notes}` : '',
    ]
      .join('\n')
      .trim(),
    labels: [...(endorsed ? [] : [UNENDORSED]), TICKET_LABEL, ...(bead.labels || [])],
    parent: parent || epic,
  };
}

/**
 * The proposal, as the run leaves it: what was proposed, what was cut, and in what order
 * it can be created.
 *
 * `extractProposal` has already repaired the graph — dropped edges pointing at nothing,
 * broken cycles — and `topoOrder` says which bead's parent has to exist first. The cap is
 * applied *after* ordering, and never silently: a run that proposed thirty beads and
 * filed twenty is a fact somebody has to be able to find.
 */
export function planFrom(text, { max = MAX_CHILDREN } = {}) {
  const { draft, error } = extractProposal(text);
  if (error) return { beads: [], warnings: [], error };
  if (!draft?.beads?.length) return { beads: [], warnings: [], error: 'the agent proposed no beads' };

  const order = topoOrder(draft.beads);
  const byRef = new Map(draft.beads.map((b) => [b.ref, b]));
  // Anything still unordered is in a cycle `validateDraft` could not break; created last
  // rather than dropped, which is what the console does with the same list.
  const sequence = [...order.refs, ...order.cycles].map((ref) => byRef.get(ref)).filter(Boolean);
  const warnings = [...(draft.warnings || [])];
  const kept = sequence.slice(0, max);
  if (sequence.length > kept.length) {
    warnings.push(`proposed ${sequence.length} beads, creating ${kept.length} — the rest are past MAX_CHILDREN`);
  }
  return { beads: kept, warnings, error: null };
}

/**
 * The default runner: one headless `claude -p`, the chat session's foundation, and its
 * final message as a string.
 *
 * Same shape as lib/advocate.js's survey and lib/console.js's turn, and for the same
 * reasons: a login shell so `~/.zshenv` resolves `BEADS_DIR` and `CLAUDE_CONFIG_DIR` from
 * the spawn directory, the prompt via a file so a markdown brief never has to survive
 * being quoted, and `agentEnv` so what the agent learned is filed as the agent it is.
 *
 * Injectable for the reason every other spawn here is: the paths worth testing are the
 * ones you cannot produce for real from inside a test.
 */
export async function runAgent({ dir, prompt, owner = 'the user', timeoutMs = TIMEOUT_MS, cfg = null }) {
  const f = await effective(dir, 'console');
  const stamp = crypto.randomBytes(6).toString('hex');
  const promptFile = path.join(os.tmpdir(), `beadcause-ingest-${stamp}.md`);
  const systemFile = path.join(os.tmpdir(), `beadcause-ingest-${stamp}.sys`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  fs.writeFileSync(systemFile, systemPrompt(f, `${memoryBrief(owner)}\n\n${PROTOCOL}`), { mode: 0o600 });

  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const command =
    `P="$(cat ${shq(promptFile)})"; rm -f ${shq(promptFile)}; ` +
    `exec claude -p --output-format stream-json --verbose --strict-mcp-config ` +
    `${claudeArgs(f, { systemFile }).join(' ')} ${promptArgs().join(' ')}`;

  return new Promise((resolve, reject) => {
    const child = spawn('/bin/zsh', ['-lc', command], { cwd: dir, env: agentEnv(f, {}, cfg), stdio: ['ignore', 'pipe', 'pipe'] });
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
        try {
          const event = JSON.parse(line);
          if (event.type === 'result' && typeof event.result === 'string') answer = event.result;
        } catch {
          /* not every line on stdout is ours to understand */
        }
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
    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`could not start claude: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      cleanup();
      // An answer that arrived before a bad exit is still an answer — the same trade
      // lib/console.js makes, and here it is the difference between a decomposition and
      // a ticket that reads as unreadable.
      if (answer.trim()) return resolve(answer);
      if (signal === 'SIGTERM') return reject(new Error('the ingestion timed out'));
      reject(new Error(`claude exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`));
    });
  });
}

/**
 * The ingester: what has been read, what is being read, and what refused to be.
 *
 * `bd`, `run` and `fetchImpl` are injected for the reason they are everywhere else here.
 * `onSettled` is how the poll cycle learns a run finished — a run outlives the sweep that
 * started it by minutes, so the wake for the phone parked on `/api/poll` cannot come from
 * the sweep's return value (see lib/events.js, and the note on `sweepJira`).
 */
export function createIngester({ bd = null, run = runAgent, fetchImpl = undefined, onSettled = null } = {}) {
  /** `<workspace>::<KEY>` → `{ state, epic, children, error, at }`. */
  const states = new Map();
  /** The runs in flight, by the same key — `MAX_RUNNING` is a count of this. */
  const running = new Map();

  const put = (workspace, key, patch) => {
    const k = stateKey(workspace, key);
    const next = { workspace, key, epic: '', children: 0, error: null, ...(states.get(k) || {}), ...patch };
    states.set(k, next);
    return next;
  };

  /**
   * Create what was proposed, in order, and say what actually happened.
   *
   * A create that fails part way is reported with what *did* get made rather than rolled
   * back — beads has no transaction, and three real beads nobody was told about is the
   * worse of the two failures. It is also why the cold-start check treats any child as
   * "already ingested": see the header.
   */
  async function createChildren(workspace, { epic, ticket, beads, endorsed }) {
    const made = [];
    const ids = new Map();
    for (const bead of beads) {
      // A parent inside the proposal becomes the bead created for it; anything else —
      // including a real id the agent named — falls back to the epic, because a child of
      // this ticket that hangs off something else is not this ticket's decomposition.
      const parent = bead.parent && ids.has(bead.parent) ? ids.get(bead.parent) : '';
      const id = await bd.create(workspace, childIssue(bead, { epic, ticket, parent, endorsed }));
      if (!id) throw new Error(`bd created "${bead.title}" but returned no id`);
      ids.set(bead.ref, id);
      made.push({ ref: bead.ref, id, title: bead.title });
    }
    // Edges last, once every id is known, exactly as the console does it — and through
    // the same lib/edges.js since bc-arj0.19, so a refusal reads the same and costs the
    // same here as there: the edge, never the rest of the batch. A dependency that
    // cannot be resolved is a warning and never a reason to lose a created bead.
    //
    // `resolve` is a ref in this proposal, or a real id the agent named that the tracker
    // will own to. Against neither it is a warning rather than a failure, and it costs
    // one `bd show` per named id at most.
    const { warnings } = await applyEdges(
      bd,
      workspace,
      beads.flatMap((bead) =>
        (bead.dependsOn || []).map((dep) => ({ from: ids.get(bead.ref), dep, ref: bead.ref }))
      ),
      {
        resolve: async (dep) =>
          ids.get(dep) || ((await bd.exists(workspace, dep).catch(() => false)) ? dep : null),
      }
    );
    return { made, warnings };
  }

  /** One ticket, start to finish. Never throws: everything it can go wrong as is a state. */
  async function ingestOne(cfg, workspace, ticket, epic) {
    const name = workspace?.name || '';
    let outcome;
    try {
      // Inside the try, and it is the first thing in it: a workspace no directory maps to
      // throws a 409 out of lib/session.js, and that is a configuration problem the row
      // should say out loud rather than an unhandled rejection in the poll cycle.
      const dir = resolveSessionDir(cfg, workspace);
      const settings = await settingsFor(bd, workspace, cfg);
      const raw = await fetchIssue(settings, ticket.key, fetchImpl ? { fetchImpl } : {});
      const fields = raw?.fields || {};
      const detail = {
        description: descriptionText(fields),
        comments: threadOf(fields),
        type: fields.issuetype?.name || '',
        labels: Array.isArray(fields.labels) ? fields.labels : [],
      };

      const text = await run({
        dir,
        cfg,
        owner: ownerName(cfg),
        prompt: ingestPrompt({
          ticket,
          detail,
          epic,
          workspace: name,
          repo: dir,
          owner: ownerName(cfg),
        }),
      });

      const plan = planFrom(text);
      if (plan.error) throw new Error(plan.error);
      for (const w of plan.warnings) console.log(`[jira] ${name}: ${ticket.key} — ${w}`);

      const endorsed = autoEndorseAllowed(cfg, name);
      const { made, warnings } = await createChildren(workspace, { epic: epic.id, ticket, beads: plan.beads, endorsed });
      for (const w of warnings) console.log(`[jira] ${name}: ${ticket.key} — ${w}`);
      // Said on the epic, not only in the log: whoever opens it in the morning is owed
      // the sentence that explains where its children came from.
      await bd
        .comment(
          workspace,
          epic.id,
          `Ingested from JIRA ${ticket.key}: ${made.length} child bead${made.length === 1 ? '' : 's'} — ` +
            `${made.map((m) => m.id).join(', ')}. ` +
            (endorsed
              ? 'Auto-endorsement is on for this repo, so they are workable now.'
              : `They are \`${UNENDORSED}\`, like this epic: nothing opens a session on any of them until you approve.`)
        )
        .catch(() => {});
      outcome = put(name, ticket.key, { state: 'done', epic: epic.id, children: made.length, error: null, at: Date.now() });
      console.log(`[jira] ${name}: ${ticket.key} ingested into ${made.length} bead(s) under ${epic.id}`);
    } catch (err) {
      const why = String(err?.message || err).split('\n')[0];
      outcome = put(name, ticket.key, { state: 'failed', epic: epic.id, error: why, at: Date.now() });
      console.error(`[jira] ${name}: could not ingest ${ticket.key} into ${epic.id} — ${why}`);
    } finally {
      running.delete(stateKey(name, ticket.key));
    }
    try {
      onSettled?.(outcome);
    } catch (err) {
      // A listener that throws must not take the run's own result with it.
      console.error(`[jira] ingest listener failed — ${String(err?.message || err).split('\n')[0]}`);
    }
    return outcome;
  }

  return {
    /** What the row draws: `{ state, epic, children, error }`, or null for a ticket nobody has reached. */
    stateFor(workspace, key) {
      return states.get(stateKey(workspace, key)) || null;
    },

    /** Every ticket this ingester has an opinion about. For the log and the tests. */
    all() {
      return [...states.values()];
    },

    /** Forget one workspace, or all of them — for a caller that knows the tracker moved. */
    forget(name = null) {
      if (name === null) return states.clear();
      for (const k of [...states.keys()]) if (k.startsWith(`${name}::`)) states.delete(k);
    },

    /**
     * Forget one ticket — what beadify needs, and the reason it is not `forget(name)`.
     *
     * `done` and `failed` are answers, and `sweep` skips a ticket that has either
     * (see above). That is right for every caller but one: a ticket cancelled while its
     * ingestion was `failed` comes back on beadify with the failure still in this map,
     * so nothing reads it again and the row says *could not be read* forever, with no
     * surface left that would retry it. Dropping the one entry sends it back through
     * the cold-start question — has this epic children? — which files nothing when the
     * answer is yes and reads the ticket again when it is no.
     *
     * One ticket rather than the workspace, because the workspace's other tickets have
     * not moved and each of them would cost a `bd list --parent` to find that out.
     * A run in flight is deliberately not cancelled: it is holding the same `states`
     * map and writes its own answer when it lands, which is the answer this wanted.
     */
    forgetTicket(workspace, key) {
      return states.delete(stateKey(workspace?.name || workspace || '', key));
    },

    /** Every run in flight. Only the tests await this; the poll cycle never does. */
    drain() {
      return Promise.all([...running.values()]);
    },

    /**
     * Start what can be started, and return. Never throws, never awaits a run.
     *
     * `pending` is `[{ workspace, ticket, epic }]` — the join the caller is holding
     * anyway: lib/jirapoll.js has the tickets and lib/jiraepic.js has each one's epic id,
     * and asking either of them for the other here would be this file guessing at how
     * both remember things.
     */
    async sweep(cfg, pending = []) {
      const started = [];
      const waiting = [];
      for (const item of pending) {
        const workspace = item?.workspace;
        const ticket = item?.ticket;
        const epicId = String(item?.epic || '').trim();
        const name = workspace?.name || '';
        if (!name || !ticket?.key || !epicId) continue;
        const k = stateKey(name, ticket.key);
        if (running.has(k)) continue;

        const known = states.get(k);
        // `queued` is the one state a later tick may act on. `done` and `failed` are
        // answers; `reading` is impossible to hold without a run in flight, because
        // nothing here is written to disk — a daemon that died mid-ingestion comes back
        // with no memory at all, and the tracker answers for it below.
        if (known && known.state !== 'queued') continue;

        if (!known) {
          // The cold-start question, and the only one there is: has this epic children?
          // One `bd list --parent` per ticket per daemon life, and never again.
          let kids;
          try {
            kids = await bd.children(workspace, epicId);
          } catch (err) {
            put(name, ticket.key, {
              state: 'failed',
              epic: epicId,
              error: `could not read ${epicId}'s children — ${String(err?.message || err).split('\n')[0]}`,
              at: Date.now(),
            });
            continue;
          }
          if (kids.length) {
            put(name, ticket.key, { state: 'done', epic: epicId, children: kids.length, at: Date.now() });
            continue;
          }
        }

        if (running.size >= MAX_RUNNING) {
          // Remembered as `queued` rather than left blank, and it buys two things: the
          // row can say *waiting to be read* instead of nothing at all, and the next tick
          // does not spend a second `bd list --parent` finding out what this one already
          // knows. A queue of nine tickets otherwise costs nine `bd` calls a minute.
          put(name, ticket.key, { state: 'queued', epic: epicId, children: 0, error: null, at: Date.now() });
          waiting.push({ workspace: name, key: ticket.key, epic: epicId });
          continue;
        }

        const epic = { id: epicId, title: String(item?.title || '') };
        put(name, ticket.key, { state: 'reading', epic: epicId, children: 0, error: null, at: Date.now() });
        started.push({ workspace: name, key: ticket.key, epic: epicId });
        console.log(`[jira] ${name}: reading ${ticket.key} into ${epicId}`);
        running.set(k, ingestOne(cfg, workspace, ticket, epic));
      }
      return { started, waiting };
    },
  };
}
