/**
 * The audit agent — what did a session do by hand that code should have done?
 *
 * Every other agent here is triggered by *work*: a bead goes ready and an advocate opens
 * a window on it, a comment arrives and dispatch answers it, a ticket lands and the
 * ingester decomposes it. This one is triggered by a session **ending**. It reads what
 * that session actually did, next to what the sessions before it did, and asks one
 * question that nothing else in this repo asks: which of that was procedure?
 *
 * ## Why the archive is the right input, and the only one
 *
 * lib/sessionlog.js already writes every finished session into the repo it ran in —
 * `refs/beadcause/sessions/<bead>`, one commit per session, whose tree is `meta.json`
 * (what it was routed to, which branch, what it committed, how it ended), `session.log`
 * (the transcript rendered down to the part a person would read) and, when the session
 * left one, `memory.md` (its own debrief — the closest thing there is to a session
 * saying out loud what it had to work out). That is a corpus of hundreds of runs sitting
 * in git objects, and until this file nothing had ever read more than one of them at a
 * time.
 *
 * It is also the only honest input. The live logs in `~/.config/beadcause/logs/` are
 * per-bead and overwritten by the next attempt; Claude Code's own transcripts are on one
 * laptop and are deleted whenever that directory is cleared; the advocate's `workers`
 * array holds only the windows open *right now*. A pattern across three sessions is a
 * claim about three runs that have all finished, and the archive is where finished runs
 * are.
 *
 * ## What counts as a finding
 *
 * **A repeated shape, not a one-off.** The same sequence of reads, the same derivation,
 * the same context assembly, done — usually differently — in `MIN_SESSIONS` sessions or
 * more. One session doing something laborious is a session having a bad day; three doing
 * the same laborious thing three different ways is a command nobody has written yet. The
 * floor is enforced here rather than asked for in the prompt (`findingProblems`), because
 * "cite three sessions" is exactly the instruction a model will satisfy by citing three.
 *
 * **A pattern that already has a skill is not a candidate — it is a miss.** If the
 * library already ships `b7e-context` and a session assembled its context by hand
 * anyway, the work is not writing the command, it is finding out why the command was not
 * used. Those are recorded on the run rather than filed, because the bead they would
 * become is a metrics question (bc-dgx7.6) and not a piece of work.
 *
 * **A candidate says what shipping it takes.** bc-dgx7.1 is explicit that the wiring is
 * in scope: where the command belongs, how it reaches PATH, whether it needs an entry on
 * the toolbelt allowlist. Most of that is fixed knowledge about this repo rather than
 * anything an agent should rediscover per finding, so it is written once, here, into
 * every candidate's body (`WIRING`). What the agent supplies is the part only it knows:
 * the verb, what the command takes, what it returns, and where it belongs.
 *
 * ## Exactly once, from a ledger rather than from memory
 *
 * `refs/beadcause/audits` in the audited checkout: one commit per run, chained, whose
 * tree is the run itself (`run.json`) and the cumulative state (`state.json`). The state
 * carries every session commit that has been read and every candidate that has been
 * filed, which is what makes the second acceptance criterion true — a daemon that
 * restarts has forgotten every audit it ever ran, and the ref has not. Duplicates are
 * refused on both halves: a session commit already in `audited` is not re-read, and a
 * finding whose command name has already been filed is dropped with a reason rather than
 * filed a second time under a new id.
 *
 * The ledger is *not* the evidence of what the sessions did — that is the archive, and
 * this ref never copies it. It records what was looked at and what was concluded, which
 * is the thing that has to survive for "re-running does not file duplicates" to mean
 * anything.
 *
 * ## What it costs, and the three things that bound it
 *
 * A run is a `claude -p` that reads up to `MAX_SESSIONS` transcripts. That is minutes
 * and real money, and a beadcause day finishes a dozen sessions, so the naive "audit on
 * every ending" is a dozen agents a day over a corpus that has barely moved. Three
 * bounds, all of them config:
 *
 * - **`every`** — how many *unread* sessions have to pile up before a run is worth it.
 *   Five by default, and it is also what makes a run's input interesting: a batch of
 *   five ended sessions is a day of this repo's work, which is the scale a repeated
 *   shape is visible at.
 * - **`cooldownMinutes`** — the floor between runs, whatever the arrivals.
 * - **one at a time** — `running` is a single flag across every workspace, for the same
 *   reason `MAX_RUNNING` is 1 in lib/jiraingest.js.
 *
 * Nothing here ever awaits the agent from the caller's side: `noteArchive` starts a run
 * and returns, because the caller is the advocate's tick and a tick that blocked for
 * four minutes is a phone that goes unanswered.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { fileBeads as fileBeadsDefault } from './filing.js';
import { effective, claudeArgs, promptArgs, systemPrompt, agentEnv } from './foundation.js';
import { git, ok, mainCheckout, writeTree, commitToRef, readRefFile } from './gitref.js';
import { autoEndorseAllowed } from './spaces.js';

/** The ledger, in the checkout whose sessions were read. */
export const AUDIT_REF = 'refs/beadcause/audits';

/** Where the archives are — lib/sessionlog.js owns the prefix, and this is a `--glob`. */
const SESSIONS_GLOB = 'refs/beadcause/sessions';

/** The label the whole programme is one query on. bc-dgx7 puts it on everything. */
export const SKILL_LABEL = 'self-started-skills';

/** And what this particular filing is: a candidate, not a decision to build it. */
export const CANDIDATE_LABEL = 'skill-candidate';

/** How many sessions a finding has to be visible in. See the header — three, and enforced. */
export const MIN_SESSIONS = 3;

/** How many archived sessions one run reads. Beyond this it is a research project. */
export const MAX_SESSIONS = 12;

/** How many candidates one run may file. A run that finds nine has found a backlog. */
export const MAX_FINDINGS = 5;

/** How much of one `session.log` the agent is handed. Head and tail, never the middle. */
export const LOG_MAX = 180 * 1024;

/** How long a run may take before it is killed. Overridden by the foundation. */
export const TIMEOUT_MS = 15 * 60 * 1000;

/** How many read session commits the ledger remembers. Far past anything one run looks at. */
const AUDITED_MAX = 2000;

/** A command name this library will accept: `b7e-` and a verb. bc-dgx7.2 owns the shape. */
const COMMAND_RE = /^b7e-[a-z][a-z0-9-]{1,23}$/;

/** A bead id, loosely — enough to refuse prose in the `sessions` list. */
const BEAD_RE = /^[a-z]{1,6}-[a-z0-9]+(\.[0-9]+)*$/i;

/* ------------------------------------------------------------------ the block */

const BLOCK_RE = /(^|\n)(?:```|~~~)[ \t]*skills[ \t]*\r?\n([\s\S]*?)(?:```|~~~)[ \t]*(?=\r?\n|$)/;

/**
 * What the agent has to write, and it is the whole contract.
 *
 * A fenced `skills` block rather than free prose for the reason every other block in
 * this repo is one: the daemon files beads off it, and a filing seam that had to
 * interpret a paragraph would be a filing seam that files a paragraph. Appended after
 * the amendable role by `systemPrompt`, so it is the last thing in context when the
 * block is written.
 */
export const PROTOCOL = `## How to answer

Write your reasoning as ordinary prose, then end with **one fenced \`skills\` block** —
nothing after it. The block is what is read; the prose above it is not parsed.

\`\`\`skills
findings:
  - command: b7e-context          # the command that would replace the work: b7e-<verb>
    title: One command assembles a session's opening context
    kind: candidate               # or: miss — the library already has this and it went unused
    existing: b7e-context         # only on a miss: which shipped command was not used
    sessions: [bc-aaa, bc-bbb.2, bc-ccc]   # the beads whose sessions you saw it in
    evidence: |
      What each of those sessions actually did, in enough detail that somebody can go
      and check it. Name the commands and the files. Say how the sessions differed —
      that they differed is itself the argument for a command.
    takes: <the arguments it would take>
    returns: <what it prints, and in what shape>
    where: bin/b7e-context.js     # where the command belongs in this repo
    allowlist: true               # should agents be able to call it? true adds a toolbelt entry
    complexity: medium            # low | medium | high — how hard the command is to write
    acceptance: How we would know the command is done.
\`\`\`

Rules, and the run is worth nothing if they are not followed:

- **A finding is a repeated shape.** The same work, done in **${MIN_SESSIONS} or more**
  different sessions — usually differently each time, which is itself the argument. One
  session doing something laborious is not a finding. A finding citing fewer than
  ${MIN_SESSIONS} sessions is dropped unread.
- **Cite real sessions.** The bead ids in \`sessions\` must be ones you were given.
- **Nothing worth reporting is the ordinary answer.** Write \`findings: []\` and say why
  in the prose. A run that files nothing is a correct run; an invented finding costs
  somebody an hour of reading.
- **Do not repeat what is already filed.** The candidates already filed are listed in
  the prompt. If you see the same pattern again, that is not a new candidate.
- **A pattern the library already covers is \`kind: miss\`**, not a candidate. The work
  there is finding out why the command went unused, and it is recorded rather than filed.`;

/**
 * The block, parsed — or the reason it could not be.
 *
 * Every failure here is an *answer*, not a throw: an agent that wrote no block, or wrote
 * YAML that does not parse, has produced a run with an error on it, and a run with an
 * error on it is a thing the ledger records. Losing the whole run to an exception would
 * lose that too.
 */
export function extractFindings(text) {
  const m = BLOCK_RE.exec(String(text || ''));
  if (!m) return { findings: [], error: 'the agent wrote no `skills` block' };
  let doc;
  try {
    doc = YAML.parse(m[2]);
  } catch (err) {
    return { findings: [], error: `the \`skills\` block is not YAML — ${String(err.message).split('\n')[0]}` };
  }
  if (doc === null || doc === undefined) return { findings: [], error: null };
  if (typeof doc !== 'object') return { findings: [], error: 'the `skills` block is not a mapping' };
  const raw = doc.findings;
  if (raw === null || raw === undefined) return { findings: [], error: null };
  if (!Array.isArray(raw)) return { findings: [], error: '`findings` is not a list' };
  return { findings: raw.filter((f) => f && typeof f === 'object'), error: null };
}

/** Everything off the block is untrusted text: one line, bounded, and never undefined. */
const line = (v, max = 200) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const block = (v, max = 4000) =>
  String(v ?? '')
    .replace(/\r/g, '')
    .trim()
    .slice(0, max);

/** One finding, normalised into the shape everything below reads. */
export function normalise(finding) {
  const command = line(finding.command || finding.skill || '', 40).toLowerCase();
  const sessions = (Array.isArray(finding.sessions) ? finding.sessions : [])
    .map((s) => line(s, 40))
    .filter((s) => BEAD_RE.test(s))
    .filter((s, i, all) => all.indexOf(s) === i);
  const kind = line(finding.kind, 20).toLowerCase() === 'miss' ? 'miss' : 'candidate';
  return {
    command,
    title: line(finding.title, 160),
    kind,
    existing: line(finding.existing, 40).toLowerCase(),
    sessions,
    evidence: block(finding.evidence),
    takes: line(finding.takes, 300),
    returns: line(finding.returns, 300),
    where: line(finding.where, 120),
    allowlist: finding.allowlist !== false,
    complexity: line(finding.complexity, 20).toLowerCase(),
    acceptance: block(finding.acceptance, 800),
  };
}

/**
 * Why this finding is not going to be filed, or null.
 *
 * The refusals are the ways a run is worth nothing while looking like a run: a finding
 * that is really a one-off, a finding that cites sessions this run never read, a second
 * copy of one already filed, and one naming a command the library already ships. Each is
 * returned as a sentence rather than a boolean, because the sentence goes on the run
 * record and is the only thing that will ever explain a quiet audit.
 */
export function findingProblems(f, { library = [], filed = [], sessions = [] } = {}) {
  if (!COMMAND_RE.test(f.command)) return `"${f.command || '(no command)'}" is not a b7e-<verb> command name`;
  if (!f.title) return `${f.command} has no title`;
  if (f.sessions.length < MIN_SESSIONS) {
    return `${f.command} cites ${f.sessions.length} session(s) — a finding is a repeated shape, and the floor is ${MIN_SESSIONS}`;
  }
  if (sessions.length) {
    const seen = new Set(sessions);
    const invented = f.sessions.filter((s) => !seen.has(s));
    const real = f.sessions.length - invented.length;
    if (real < MIN_SESSIONS) {
      return `${f.command} cites ${invented.join(', ')}, which this run did not read — leaving ${real} real session(s)`;
    }
  }
  if (library.includes(f.command)) return `${f.command} already exists in this repo — that is a miss, not a candidate`;
  if (filed.includes(f.command)) return `${f.command} has already been filed as a candidate`;
  return null;
}

/* ---------------------------------------------------------------- the candidate */

/**
 * What shipping one of these takes, written once rather than rediscovered per finding.
 *
 * bc-dgx7.1 puts the wiring in this agent's scope, and almost all of it is a fact about
 * *this repo* rather than about the finding: it does not change between candidates, and
 * an agent asked to work it out each time will get the second registration wrong, which
 * is the one that stops the whole test sweep at suite one.
 */
export const WIRING = [
  '- **The command itself**, executable, at the path above. `bin/` of the *main checkout* is already on every',
  "  agent's `PATH` — lib/foundation.js prefixes it (`BIN`) so a command resolves by the name it is typed as —",
  '  so there is nothing to install and nothing to link.',
  '- **Two registrations, not one**: `bin` in `package.json` *and* `packages[""].bin` in `package-lock.json`.',
  '  test/lockfile.mjs is pinned first in the sweep, so a lock that disagrees stops every later suite.',
  '- **A `test/<name>.mjs`**, which scripts/test.mjs discovers with no wiring.',
  '- **A `###` section in README.md** saying what it does and what went wrong without it. A feature is not',
  '  finished here until the README says it exists.',
];

/** The one extra line a command agents are meant to call owes. */
const ALLOWLIST_LINE = (command) =>
  `- **\`Bash(${command}:*)\` in \`DEFAULT_TOOL_LIST\` (lib/toolbelt.js)**, or the command is on PATH and refused at ` +
  'the moment an agent reaches for it. One copy: lib/foundation.js quotes that list as the dispatch baseline.';

/**
 * One finding, as the bead lib/filing.js will file.
 *
 * The description is the agent's argument plus the wiring; `notes` is left alone
 * deliberately, because that is where lib/filing.js writes the provenance and a bead
 * carrying two provenance paragraphs reads as beadcause arguing with itself.
 */
export function candidateBead(f, { runAt = '' } = {}) {
  const cited = f.sessions.join(', ');
  const description = [
    `\`${f.command}\` — ${f.title}`,
    '',
    `**Done by hand in ${f.sessions.length} sessions: ${cited}.** A session audit found the same work in each`,
    'of them, and this is the command that would have replaced it.',
    '',
    f.evidence || '(the audit gave no evidence, which is itself worth checking before this is endorsed)',
    '',
    '**The command.**',
    '',
    `- Takes: ${f.takes || '(not stated)'}`,
    `- Returns: ${f.returns || '(not stated)'}`,
    `- Belongs at: \`${f.where || `bin/${f.command}.js`}\``,
    '',
    '**What shipping it takes.** bc-dgx7.2 is the definition of a skill; this is the wiring as it stands today:',
    '',
    ...WIRING,
    ...(f.allowlist ? [ALLOWLIST_LINE(f.command)] : []),
    '',
    `Filed by the session audit agent (lib/sessionaudit.js)${runAt ? ` on ${runAt}` : ''}. The evidence is the`,
    'session archive: `git log refs/beadcause/sessions/<bead>` for each bead named above.',
  ].join('\n');
  return {
    title: `${f.command} — ${f.title}`.slice(0, 200),
    type: 'task',
    priority: 2,
    description,
    acceptance:
      f.acceptance ||
      `\`${f.command}\` exists, is registered in both bin maps, has a test, and the work the sessions above did by hand is one call.`,
    labels: [SKILL_LABEL, CANDIDATE_LABEL],
    complexity: ['low', 'medium', 'high'].includes(f.complexity) ? f.complexity : '',
  };
}

/* -------------------------------------------------------------------- the input */

/**
 * Every archived session in this checkout, newest first, in one process.
 *
 * `--glob` rather than a `for-each-ref` and a `git log` per bead: the archives are one
 * ref per bead and there are hundreds of them, so the per-bead shape is hundreds of
 * processes to build one list. The subject is written by `archiveSession` as
 * `<workspace>/<bead> · <outcome>`, which is where the bead comes from; a subject that
 * does not parse is skipped rather than guessed at.
 */
export async function sessionsIn(dir, { limit = MAX_SESSIONS } = {}) {
  const main = await ok(mainCheckout(dir));
  if (!main) return [];
  const out = await ok(
    git(main, ['log', `--glob=${SESSIONS_GLOB}`, '--format=%H%x00%aI%x00%s', `--max-count=${Math.max(1, limit)}`])
  );
  if (!out) return [];
  const rows = [];
  for (const raw of out.split('\n').filter(Boolean)) {
    const [commit, at, subject = ''] = raw.split('\0');
    const bead = String(subject).split(' · ')[0].split('/').pop()?.trim() || '';
    if (!commit || !bead) continue;
    rows.push({ commit, at, subject, bead });
  }
  return rows;
}

/**
 * The commands this repo already ships — which is what turns a repeat into a *miss*.
 *
 * Two sources because a skill is two things (bc-dgx7.2): a file in `bin/` and an entry in
 * the `bin` map that puts it on `PATH`. Either on its own is enough to say "this exists",
 * and the union is deliberately generous — calling something a candidate when it already
 * exists is the worse error, because it is the one that files a bead.
 *
 * Empty is the honest answer today and is not a failure: nothing has shipped yet, so
 * every real finding is a candidate and there are no misses to record.
 */
export async function skillLibrary(dir) {
  const found = new Set();
  const main = (await ok(mainCheckout(dir))) || dir;
  try {
    for (const name of fs.readdirSync(path.join(main, 'bin'))) {
      const command = name.replace(/\.(js|mjs|sh)$/, '');
      if (COMMAND_RE.test(command)) found.add(command);
    }
  } catch {
    /* no bin/, which is every checkout that is not this one */
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(main, 'package.json'), 'utf8'));
    for (const key of Object.keys(pkg?.bin || {})) if (COMMAND_RE.test(key)) found.add(key);
  } catch {
    /* not a node package, or a package.json we cannot read */
  }
  return [...found].sort();
}

/** Head and tail, with the cut stated. A silent truncation reads as a short session. */
export function clipEnds(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n…[${s.length - max} characters of the middle omitted]…\n\n${s.slice(-tail)}\n`;
}

/**
 * The sessions, on disk, where the agent can read them.
 *
 * The transcripts live in git objects and the agent's allowlist has `Read`, `Grep` and
 * `Glob` and no `git` at all — deliberately, since lib/toolbelt.js names every verb one
 * at a time. So the batch is materialised into a temporary directory handed to `claude`
 * with `--add-dir`, and removed in a `finally` whatever happens. Nothing is written into
 * the checkout: a session audit that dirtied the tree would fail the next delivery's
 * dirty guard for reasons nobody would connect to it.
 *
 * A log is clipped from **both ends**. The opening of a session is where the context
 * assembly this whole agent is looking for happens, and the end is where the session says
 * what it learned; the middle is the work itself, which is the least interesting part for
 * this question and by far the largest.
 */
export async function materialise(dir, sessions, root) {
  const main = (await ok(mainCheckout(dir))) || dir;
  const read = async (commit, file) => await ok(git(main, ['cat-file', '-p', `${commit}:${file}`]));
  const out = [];
  let n = 0;
  for (const s of sessions) {
    n += 1;
    const folder = path.join(root, `${String(n).padStart(2, '0')}-${s.bead.replace(/[^a-z0-9.-]/gi, '_')}`);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const meta = (await read(s.commit, 'meta.json')) || '{}';
    fs.writeFileSync(path.join(folder, 'meta.json'), meta, { mode: 0o600 });
    const log = (await read(s.commit, 'session.log')) || '';
    fs.writeFileSync(path.join(folder, 'session.log'), clipEnds(log, LOG_MAX), { mode: 0o600 });
    const memory = await read(s.commit, 'memory.md');
    if (memory) fs.writeFileSync(path.join(folder, 'memory.md'), memory.slice(0, LOG_MAX), { mode: 0o600 });
    let parsed = {};
    try {
      parsed = JSON.parse(meta);
    } catch {
      /* an archive written by a version that wrote something else */
    }
    out.push({
      ...s,
      dir: folder,
      title: line(parsed.title, 120),
      outcome: line(parsed.outcome, 40),
      model: line(parsed.model, 60),
      commits: Array.isArray(parsed.commits) ? parsed.commits.length : 0,
      hasMemory: Boolean(memory),
      bytes: log.length,
    });
  }
  return out;
}

/** The prompt: what to read, what already exists, and what has already been said. */
export function auditPrompt({ sessions = [], library = [], filed = [], misses = [], repo = '' } = {}) {
  const rows = sessions.map(
    (s) =>
      `- **${s.bead}**${s.title ? ` — ${s.title}` : ''} · ${s.outcome || 'ended'}${s.model ? ` · ${s.model}` : ''}` +
      ` · ${s.commits} commit(s)${s.hasMemory ? ' · left a debrief' : ''}\n  \`${s.dir}\``
  );
  return [
    `# Audit ${sessions.length} finished session(s)${repo ? ` in ${repo}` : ''}`,
    '',
    'Each directory below holds one finished agent session, exactly as it was archived:',
    '`meta.json` (what it was routed to, what it committed, how it ended), `session.log` (the',
    'transcript, rendered) and sometimes `memory.md` (what the session said it had learned).',
    'Read them with Read and Grep — they are outside the repo, and that is deliberate.',
    '',
    ...rows,
    '',
    '## The question',
    '',
    '**What did these agents do by hand that code should have done?**',
    '',
    'Look for the same work repeated across sessions: the same sequence of reads to work out the',
    'same thing, the same derivation from the same files, the same context assembled at the top of',
    'every run — and usually assembled *differently* each time, which is the tell. What you are',
    'looking for is a command that could have replaced it: one call, arguments in, a definite answer',
    'out. Not a habit, not advice, not a paragraph for a prompt — a program.',
    '',
    "Ignore anything that is the work itself. Editing this repo's files, deciding what a change should",
    'be, reading a bead to understand it: that is what a session is for. What you are after is the',
    'plumbing around it.',
    '',
    library.length
      ? `## The library already ships\n\n${library.map((c) => `- \`${c}\``).join('\n')}\n\nA pattern one of these already covers is a **miss** — the command existed and went unused — not a new candidate.`
      : '## The library is empty\n\nNothing has shipped yet, so every real finding is a candidate and there are no misses to record.',
    '',
    filed.length
      ? `## Already filed as candidates — do not file these again\n\n${filed
          .map((c) => `- \`${c.slug}\`${c.title ? ` — ${c.title}` : ''}`)
          .join('\n')}`
      : '## Nothing has been filed yet',
    '',
    misses.length ? `## Misses recorded before\n\n${misses.map((m) => `- \`${m.slug}\``).join('\n')}` : null,
    '',
    '## Before you write the block',
    '',
    'You may read this repo itself — the checkout you are running in — to work out where a command',
    'would belong and what it would have to call. `README.md` is the spec; `lib/` and `bin/` are what',
    "exists. Saying where the command goes is part of the finding, not somebody else's problem.",
    '',
    `At most ${MAX_FINDINGS} findings. Fewer is normal. None is a perfectly good run — say so in the prose.`,
  ]
    // `null` is the one line that was not written — the misses section, when there are
    // none. An empty string is a deliberate blank line, and filtering those out is how
    // this prompt spent its first draft with every heading welded to the paragraph above
    // it, which is markdown for "not a heading".
    .filter((s) => s !== null)
    .join('\n')
    // A section that was not written leaves its separator behind, and a heading with two
    // blank lines above it reads as a gap in the brief rather than as the next thing.
    .replace(/\n{3,}/g, '\n\n');
}

/* -------------------------------------------------------------------- the ledger */

const EMPTY_STATE = { version: 1, audited: [], candidates: [], misses: [], runs: 0, at: null };

/** A fresh empty ledger — a new object every time, so no caller can mutate the constant. */
const emptyLedger = () => ({ ...EMPTY_STATE, audited: [], candidates: [], misses: [] });

/** The ledger as it stands, or the empty one — a checkout that has never been audited. */
export async function readLedger(dir) {
  const main = await ok(mainCheckout(dir));
  if (!main) return emptyLedger();
  const raw = await readRefFile(main, AUDIT_REF, 'state.json');
  if (!raw) return emptyLedger();
  try {
    const s = JSON.parse(raw);
    return {
      ...emptyLedger(),
      ...s,
      audited: Array.isArray(s.audited) ? s.audited.map(String) : [],
      candidates: Array.isArray(s.candidates) ? s.candidates : [],
      misses: Array.isArray(s.misses) ? s.misses : [],
    };
  } catch {
    // A state file that will not parse cannot be trusted to say what has been audited, and
    // the safe direction is to re-read the sessions rather than to skip them: the duplicate
    // check on filed candidates is the second net under this one.
    return emptyLedger();
  }
}

/**
 * Append this run to the ledger.
 *
 * Two files, and the split is the same one lib/agentarchive.js makes: `run.json` is what
 * happened this time and is only ever read by somebody looking at that commit, while
 * `state.json` is the cumulative answer every later run asks — so "have I read this
 * session?" is one `cat-file` rather than a walk of the whole history.
 */
export async function writeRun(dir, run) {
  const main = await ok(mainCheckout(dir));
  if (!main) return null;
  const prev = await readLedger(dir);
  const audited = [...prev.audited, ...run.sessions.map((s) => s.commit)]
    .filter((c, i, all) => all.indexOf(c) === i)
    .slice(-AUDITED_MAX);
  const state = {
    version: 1,
    audited,
    candidates: [
      ...prev.candidates,
      ...run.filed.map((f) => ({ slug: f.slug, bead: f.bead, title: f.title, at: run.at })),
    ],
    misses: [...prev.misses, ...run.misses.map((m) => ({ ...m, at: run.at }))],
    runs: (prev.runs || 0) + 1,
    at: run.at,
  };
  const tree = await writeTree(main, [
    ['run.json', Buffer.from(JSON.stringify(run, null, 2) + '\n')],
    ['state.json', Buffer.from(JSON.stringify(state, null, 2) + '\n')],
  ]);
  const subject =
    `audit · ${run.sessions.length} session(s) · ` +
    (run.filed.length ? `${run.filed.length} candidate(s)` : 'nothing worth a command') +
    (run.misses.length ? ` · ${run.misses.length} miss(es)` : '');
  const body = [
    subject,
    '',
    ...run.sessions.map((s) => `read ${s.bead} ${s.commit.slice(0, 12)}`),
    ...run.filed.map((f) => `filed ${f.bead} ${f.slug}`),
    ...run.misses.map((m) => `miss ${m.slug} (${m.existing || 'unknown'})`),
    ...run.dropped.map((d) => `dropped ${d}`),
    ...(run.error ? ['', `error: ${run.error}`] : []),
  ].join('\n');
  const { commit } = await commitToRef(main, AUDIT_REF, tree, body);
  return { commit, subject, state };
}

/* --------------------------------------------------------------------- the agent */

/**
 * One headless `claude -p`, its final message as a string.
 *
 * The same shape as lib/jiraingest.js's runner and for the same reasons: a login shell so
 * `~/.zshenv` resolves the workspace from the spawn directory, the prompt through a file
 * so a markdown brief never has to survive being quoted, and `agentEnv` so what it learns
 * is filed as the agent it is. The one addition is `--add-dir`, which is what lets it read
 * the transcripts materialised outside the repo.
 *
 * It runs as the **chat session's** foundation rather than a kind of its own. That is a
 * deliberate reuse: what this agent needs is exactly the read-only surface every other
 * reading agent has, a new kind owes five registrations across lib/ (the foundation
 * marks, lib/access.js, the SOC 2 boundary record, the flowchart and the pinned counts),
 * and none of them would say anything that is not already true of `console`. If it ever
 * needs reach the chat session should not have, that is the moment for a kind of its own.
 */
export async function runAgent({ dir, prompt, readDir = null, timeoutMs = TIMEOUT_MS, cfg = null }) {
  const f = await effective(dir, 'console');
  const stamp = crypto.randomBytes(6).toString('hex');
  const promptFile = path.join(os.tmpdir(), `beadcause-audit-${stamp}.md`);
  const systemFile = path.join(os.tmpdir(), `beadcause-audit-${stamp}.sys`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  fs.writeFileSync(systemFile, systemPrompt(f, PROTOCOL), { mode: 0o600 });

  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const command =
    `P="$(cat ${shq(promptFile)})"; rm -f ${shq(promptFile)}; ` +
    `exec claude -p --output-format stream-json --verbose --strict-mcp-config ` +
    `${claudeArgs(f, { systemFile, addDirs: readDir ? [readDir] : [] }).join(' ')} ${promptArgs().join(' ')}`;

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
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const event = JSON.parse(l);
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
      // lib/jiraingest.js makes one file along.
      if (answer.trim()) return resolve(answer);
      if (signal === 'SIGTERM') return reject(new Error('the audit timed out'));
      reject(new Error(`claude exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`));
    });
  });
}

/* -------------------------------------------------------------------- the auditor */

/** What the config says, with every number clamped to something a run can survive. */
export function options(cfg) {
  const a = cfg?.advocates || {};
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
  };
  return {
    enabled: a.sessionAudit !== false,
    every: clamp(a.sessionAuditEvery, 1, 50, 5),
    cooldownMs: clamp(a.sessionAuditCooldownMinutes, 0, 24 * 60, 60) * 60 * 1000,
    max: clamp(a.sessionAuditMax, MIN_SESSIONS, 40, MAX_SESSIONS),
  };
}

/**
 * The auditor: a session ended, and here is what to do about it.
 *
 * `noteArchive` is the trigger, and it is deliberately a *nudge* rather than a queue
 * entry. Everything it would have remembered — which sessions have been read, which
 * candidates exist — is in the ledger and is re-read at the start of every run, so a
 * daemon that restarts between the archive and the audit loses nothing but the timing:
 * the next session to end picks up the whole backlog. A queue held in memory would be a
 * queue that is wrong after every restart and right nowhere else.
 *
 * Nothing here throws at its caller. The caller is the advocate's archive loop, which is
 * inside a tick, and an audit that could fail a tick would be an audit that stops
 * sessions being opened.
 */
export function createAuditor({
  cfg = {},
  bd = null,
  run = runAgent,
  file = fileBeadsDefault,
  onSettled = null,
  now = () => Date.now(),
  log = console.log,
  warn = console.error,
} = {}) {
  let running = false;
  let lastAt = 0;
  const last = { at: null, dir: null, workspace: null, sessions: 0, filed: [], misses: [], dropped: [], error: null };

  /** Which of the newest archives in this checkout have not been read into a run yet. */
  async function pending(dir) {
    const o = options(cfg);
    const sessions = await sessionsIn(dir, { limit: o.max });
    const ledger = await readLedger(dir);
    const seen = new Set(ledger.audited);
    return { sessions, ledger, fresh: sessions.filter((s) => !seen.has(s.commit)).length, o };
  }

  /**
   * Audit one checkout, start to finish. Never throws; the outcome says what happened.
   *
   * `force` is what a caller uses when it means "now" rather than "if it is worth it" —
   * the threshold and the cooldown are about *cost*, and a run somebody asked for has
   * already had that decision made about it.
   */
  async function audit(dir, workspace, { force = false } = {}) {
    const out = {
      dir: dir || null,
      workspace: workspace?.name || String(workspace || ''),
      ran: false,
      why: '',
      at: new Date(now()).toISOString(),
      sessions: [],
      filed: [],
      misses: [],
      dropped: [],
      error: null,
    };
    if (!dir) return { ...out, why: 'no checkout to audit' };
    /**
     * The latch is taken **before the first `await`**, and that is the whole of why this
     * function is shaped the way it is.
     *
     * Deciding whether a run is worth starting takes two git reads, so a check made after
     * them is a check made a tick late: the advocate archives its finished sessions in a
     * loop with awaits in it, and two archives in one loop would both have found `running`
     * false and both put a `claude -p` on this Mac. Taking it first costs the honest
     * refusal below for a caller that arrives during someone else's decision, which is
     * exactly what that caller should be told.
     */
    if (running) return { ...out, why: 'an audit is already running' };
    running = true;
    let root = null;
    try {
      const { sessions, ledger, fresh, o } = await pending(dir);
      if (!o.enabled && !force) return { ...out, why: 'session auditing is switched off' };
      if (!sessions.length) return { ...out, why: 'nothing is archived in this checkout' };
      if (sessions.length < MIN_SESSIONS && !force) {
        return { ...out, why: `only ${sessions.length} session(s) archived — a pattern needs ${MIN_SESSIONS}` };
      }
      if (!fresh && !force) return { ...out, why: 'every archived session has already been audited' };
      if (fresh < o.every && !force) return { ...out, why: `${fresh} unread session(s) — the threshold is ${o.every}` };
      if (!force && lastAt && now() - lastAt < o.cooldownMs) {
        return { ...out, why: `the last audit was ${Math.round((now() - lastAt) / 60000)} minute(s) ago` };
      }

      lastAt = now();
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-audit-'));
      const read = await materialise(dir, sessions, root);
      const library = await skillLibrary(dir);
      const prompt = auditPrompt({
        sessions: read,
        library,
        filed: ledger.candidates,
        misses: ledger.misses,
        repo: path.basename(dir),
      });
      log(`[audit] ${out.workspace}: reading ${read.length} session(s) in ${path.basename(dir)} (${fresh} new)`);
      out.sessions = read.map((s) => ({ bead: s.bead, commit: s.commit, at: s.at }));

      let answer = '';
      try {
        answer = await run({ dir, prompt, readDir: root, cfg });
      } catch (err) {
        out.error = String(err?.message || err).split('\n')[0];
      }

      if (!out.error) {
        const { findings, error } = extractFindings(answer);
        out.error = error;
        const beads = [];
        const known = read.map((s) => s.bead);
        const filedSlugs = ledger.candidates.map((c) => c.slug);
        for (const raw of findings.slice(0, MAX_FINDINGS)) {
          const f = normalise(raw);
          if (f.kind === 'miss') {
            out.misses.push({ slug: f.command, existing: f.existing || f.command, sessions: f.sessions });
            continue;
          }
          const problem = findingProblems(f, { library, filed: filedSlugs, sessions: known });
          if (problem) {
            out.dropped.push(problem);
            continue;
          }
          filedSlugs.push(f.command);
          beads.push({ finding: f, bead: candidateBead(f, { runAt: out.at }) });
        }
        if (findings.length > MAX_FINDINGS) {
          out.dropped.push(
            `${findings.length} findings proposed, ${MAX_FINDINGS} read — the rest are past MAX_FINDINGS`
          );
        }
        if (beads.length && bd) {
          // A cited session's bead is the `from`, which is what lib/homing.js hangs the
          // candidate under: the *root* above that work, never the work itself. A
          // candidate with no home is a bead nothing will ever queue (bc-rfnr.7).
          const from = beads[0].finding.sessions.find((s) => known.includes(s)) || known[0] || '';
          const res = await file(
            bd,
            workspace,
            beads.map((b) => b.bead),
            {
              from,
              endorsed: autoEndorseAllowed(cfg, out.workspace),
              onWarn: (m) => warn(`[audit] ${out.workspace}: ${m}`),
            }
          );
          const bySlug = new Map(beads.map((b) => [b.bead.title, b.finding.command]));
          out.filed = res.filed.map((row) => ({ bead: row.id, slug: bySlug.get(row.title) || '', title: row.title }));
          for (const f of res.failed) out.dropped.push(`could not file "${f.title}" — ${f.error}`);
        } else if (beads.length) {
          out.dropped.push(`${beads.length} candidate(s) found with no tracker to file them into`);
        }
      }

      out.ran = true;
      try {
        const written = await writeRun(dir, out);
        if (written) out.record = written.commit;
        log(
          `[audit] ${out.workspace}: ${
            out.filed.length ? `filed ${out.filed.map((f) => f.bead).join(', ')}` : 'nothing worth a command'
          }${out.misses.length ? `, ${out.misses.length} miss(es)` : ''}${out.error ? ` (${out.error})` : ''}`
        );
      } catch (err) {
        // The beads are already filed by this point, so a ledger that would not take the
        // run is a duplicate risk rather than a lost run — said out loud for that reason.
        out.error = `${out.error ? `${out.error}; ` : ''}the run could not be recorded — ${String(err?.message || err)
          .split('\n')[0]}`;
        warn(`[audit] ${out.workspace}: could not record the run — ${out.error}`);
      }
      return out;
    } catch (err) {
      out.error = String(err?.message || err).split('\n')[0];
      warn(`[audit] ${out.workspace}: the audit failed — ${out.error}`);
      return out;
    } finally {
      running = false;
      // Only ever a directory this call made — the early returns above take the latch and
      // give it back without materialising anything, and a blind `rmSync(root)` there
      // would be an `rmSync(null)`.
      if (root) fs.rmSync(root, { recursive: true, force: true });
      /**
       * Every run that actually ran is reported, including the quiet ones and the ones
       * whose agent fell over — and *whether that is worth waking a phone for* is the
       * consumer's decision, not this one's. A run outlives by minutes the tick that
       * started it, so this callback is the only moment at which anything downstream can
       * learn the answer changed; a filter here would be a filter nobody downstream could
       * see, on the one signal they have.
       */
      if (out.ran && onSettled) {
        try {
          onSettled(out);
        } catch (err) {
          warn(`[audit] the settle callback threw — ${String(err?.message || err).split('\n')[0]}`);
        }
      }
      // `last` is what the last *run* did, so a refusal must not overwrite it: "no unread
      // sessions" is the commonest answer there is here, and a screen showing it would
      // report an audit that read nothing over the one that filed something an hour ago.
      if (out.ran) {
        Object.assign(last, {
          at: out.at,
          dir,
          workspace: out.workspace,
          sessions: out.sessions.length,
          filed: out.filed,
          misses: out.misses,
          dropped: out.dropped,
          error: out.error,
        });
      }
    }
  }

  /**
   * A session ended. Start a run if one is worth starting, and return immediately.
   *
   * Not awaited by the caller and not awaitable: the promise is consumed here so that a
   * rejection can never reach an advocate tick as an unhandled one.
   */
  function noteArchive({ dir, workspace } = {}) {
    if (!dir || running || !options(cfg).enabled) return;
    Promise.resolve()
      .then(() => audit(dir, workspace))
      .catch((err) => warn(`[audit] the audit failed — ${String(err?.message || err).split('\n')[0]}`));
  }

  return {
    audit,
    noteArchive,
    /** What the last run did, for a screen that wants to say so. */
    state: () => ({ running, lastAt: lastAt || null, ...last }),
  };
}
