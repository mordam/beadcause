/**
 * Tier 3: a directory and a git repo one agent fully owns — and the experiment that
 * is the actual point of it.
 *
 * Tier 1 gave an agent a ref in the repo it was working on. Tier 2 gave every agent a
 * shared place and four calls (`lib/memory.js`) with the storage deliberately hidden
 * behind them, so nothing an agent writes ever names a path. This is the opposite of
 * that on purpose, and the inversion is the experiment:
 *
 *   ~/.config/beadcause/agents/<workspace>/<agent>/
 *
 * A real directory with a real working tree and a real `.git`, outside every project
 * checkout — put it inside one and it fights `git status` and `.gitignore` forever —
 * **seeded with nothing at all**. No README, no schema, no example. An empty repo is
 * the whole instrument: what an agent reaches for when handed a space with no shape
 * is a fact about agents, and a seeded one would only tell us it can follow a
 * template.
 *
 * **Success is not that the state was durable.** Durability was settled by tiers 1 and
 * 2. Success here is the agent doing something nobody designed for. Evaluate it that
 * way or the result means nothing — which is why half this file is measurement.
 *
 * ## The prediction under test
 *
 * *The agent writes on the first turn of every session and never reads back*, because
 * nothing prompts it to. A repo with no recall path is a write-only diary, and the
 * variable that decides it is not the repo — it is whether the session start says
 * "you have a memory, and here is what is in it". Same lesson MEMORY.md teaches, and
 * the same lesson `beadcause-memory agents` taught in lib/memory.js: a capability
 * nobody was told about is indistinguishable from one nobody chose to use.
 *
 * So there are two arms and `armFor` alternates between them:
 *
 * - **`blind`** — the brief says the directory exists and how to reach it. Nothing more.
 * - **`index`** — the same brief, plus a listing of what is in there right now.
 *
 * The comparison of those two is the finding. Everything else here is what makes the
 * comparison possible: `record` writes one line per command, `summary` reports, per
 * arm, how many runs touched the repo at all, how many read, and how many read
 * *before* they wrote. A run is counted whether or not the agent ever touches the
 * repo, because the denominator is the interesting half — a `session` line is written
 * at spawn for exactly that reason.
 *
 * ## Permissions, which is where the real work is
 *
 * The console allowlist is load-bearing rather than belt-and-braces (see the header of
 * lib/console.js), and this grants an unattended agent the one thing no agent here has
 * had: somewhere it may write. Three things keep that scoped to a sentence anyone can
 * hold in their head — *this agent may write inside its own directory, and nowhere else*:
 *
 * 1. **One allowlist entry, and it is a command rather than a tool.**
 *    `Bash(beadcause-agentrepo:*)`. `Write`/`Edit` cannot be pinned to an absolute path
 *    outside the working directory, and `Bash(git -C <dir>:*)` is not the fence it
 *    looks like — `git -C a -C b` chains, so a prefix match on the first `-C` permits
 *    the second. The wrapper is the fence: every path resolves under the repo and
 *    every argument that could repoint git is refused (`bin/beadcause-agentrepo`).
 * 2. **`ownsRepo` is PROTECTED in lib/foundation.js.** An agent that could amend
 *    itself into owning a repo has granted itself write access, and one that could
 *    amend it away could hide what it had already written. Both are commits to a file
 *    a human edits.
 * 3. **Local-only, enforced rather than merely intended.** No remote is configured and
 *    the wrapper refuses `push`, `fetch`, `remote` and the rest. sessionlog.js refused
 *    to push by default because a transcript carries absolute paths and whatever tool
 *    output scrolled past; this inverts the authorship — *the agent* decides what lands
 *    here — so it can write a secret nobody anticipated, into a repo nobody reviews. A
 *    remote is a decision to take after weeks of reading what actually accumulates, and
 *    the only shape that would enforce owner-plus-owning-agent is a private repo per
 *    agent with a fine-grained PAT scoped to that one repository. A shared private repo
 *    with a ref namespace per agent is cheaper and isolates by convention alone.
 *
 * ## Two sharp edges worth knowing about
 *
 * **`agents/` must be ignored by the common repo, and that is not tidiness.**
 * `~/.config/beadcause` is itself a git repo whose `commit()` runs `git add -A`
 * (lib/commonrepo.js). A nested repo under it is added as a gitlink — but a *freshly
 * created, not yet initialised* one is not, and its files would be committed straight
 * into the shared history, which is the exact opposite of a private repo. The ignore
 * rule is in `GITIGNORE` there, and `topUpIgnore` is what gets it onto installs that
 * predate it.
 *
 * **The usage log lives beside the repos, never inside one.** Measurement is
 * beadcause's, the repo is the agent's, and a log file appearing in a directory
 * documented as seeded-with-nothing would be beadcause answering its own experiment.
 * It is also, for the same reason as the repos, not committed anywhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.js';
import { git } from './gitref.js';

/** Every tier 3 repo lives under here, one per workspace per agent. */
export const AGENTS_DIR = path.join(CONFIG_DIR, 'agents');

/** One line per command, appended. Beside the repos, never in one. */
export const USAGE_LOG = path.join(AGENTS_DIR, 'usage.jsonl');

/** The two ways a session can be started. The comparison of them is the finding. */
export const ARMS = ['blind', 'index'];

/**
 * Same rule, and the same refusal, as `name()` in lib/memory.js.
 *
 * Rejected rather than sanitised: quietly turning `advocate/sophab` into a path
 * component would put one agent's repo where another's belongs, and nobody would find
 * out. A directory name is worse than a file name here, because it is also what the
 * wrapper's containment check is anchored to.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function name(kind, value) {
  const s = String(value ?? '');
  if (!NAME.test(s) || s.includes('..')) {
    throw new Error(`bad ${kind} "${s}" — letters, digits, dot, dash, underscore; 64 max; must not start with a symbol`);
  }
  return s;
}

/** Where one agent's repo is, for one workspace. Validated, never guessed at. */
export function repoDir(workspace, agent) {
  return path.join(AGENTS_DIR, name('workspace', workspace), name('agent', agent));
}

/**
 * Is this path inside the tier 3 tree, and does it name an agent's own repo?
 *
 * The wrapper's first check, and the reason it is here rather than there: the rule for
 * what counts as a tier 3 repo should live with the code that creates them.
 */
export function isRepoDir(dir) {
  const rel = path.relative(AGENTS_DIR, path.resolve(String(dir || '')));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return false;
  return parts.every((p) => NAME.test(p) && !p.includes('..'));
}

/* ------------------------------------------------------------ 0700 and 0600 */

/**
 * Owner-only, everywhere, every time — the convention the rest of this codebase keeps
 * for the token, the config and the prompt files.
 *
 * Re-applied rather than set once, because the interesting writer here is not us: git
 * creates objects and logs with whatever the umask says, and an agent that finds
 * another way to put a file in the tree would leave it 0644. Cheap enough to run on
 * every provision and every write — a tier 3 repo is a handful of small files.
 *
 * The group and other bits are cleared and the owner's are kept, rather than every file
 * being set to a flat 0600. Git writes loose objects 0444 — read-only on purpose, which
 * is how it notices corruption — and a blanket 0600 would hand write permission back on
 * every object in the repo in the name of privacy. `mode & 0o700` narrows 0644 to 0600
 * and 0444 to 0400, which is the same privacy and none of the damage.
 */
const OWNER_ONLY = (p, st) => {
  if ((st.mode & 0o077) === 0) return;
  fs.chmodSync(p, st.mode & 0o700);
};

export function harden(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  try {
    OWNER_ONLY(dir, fs.statSync(dir));
  } catch {
    /* gone between the read and the chmod; nothing to protect */
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      harden(p);
      continue;
    }
    try {
      OWNER_ONLY(p, fs.statSync(p));
    } catch {
      /* ditto */
    }
  }
}

/* --------------------------------------------------------------- provisioning */

/**
 * Make an agent's repo exist, and return where it is.
 *
 * Idempotent and safe on every spawn. **It seeds nothing** — no README, no schema, not
 * even an empty commit — and that is the experiment rather than an omission: see the
 * header. The only thing written is git's own identity for the repo, so that a
 * `commit` from the wrapper works without the agent having to configure anything and
 * the history says which agent wrote it rather than whoever owns the Mac.
 *
 * No remote, and `ensureRepo` is not where that is enforced — the wrapper is. A repo
 * with no remote is one `git remote add` away from having one, and the whole point of
 * local-only-first is that it should not depend on nobody having run that.
 */
export async function ensureAgentRepo(workspace, agent) {
  const dir = repoDir(workspace, agent);
  const created = !fs.existsSync(path.join(dir, '.git'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `recursive` applies the mode only to directories it actually creates, so a tree
  // that predates this — or was made by something with a looser umask — stays wrong
  // until something narrows it. `harden` at the end of this function is that something.
  if (created) {
    await git(dir, ['init', '--initial-branch=main', '-q']);
    await git(dir, ['config', 'user.name', agent]);
    await git(dir, ['config', 'user.email', `${agent}@beadcause.local`]);
  }
  harden(path.join(AGENTS_DIR, name('workspace', workspace)));
  return { dir, created };
}

/* ------------------------------------------------------------------- the index */

/** Everything in the working tree, `.git` aside, newest first. */
function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, base, out);
      continue;
    }
    if (!e.isFile()) continue;
    try {
      const st = fs.statSync(p);
      out.push({ name: path.relative(base, p), size: st.size, at: st.mtime.toISOString() });
    } catch {
      /* raced with a delete */
    }
  }
  return out;
}

/**
 * What is in an agent's repo right now — the payload of the `index` arm.
 *
 * Both halves are here because they answer different questions: the working tree is
 * what the agent would find if it looked, and the commits are what it decided was
 * worth keeping. An agent that writes files and never commits is itself a finding.
 */
export async function indexOf(workspace, agent, { files = 40, commits = 5 } = {}) {
  const dir = repoDir(workspace, agent);
  if (!fs.existsSync(dir)) return { dir, exists: false, files: [], commits: [] };
  const all = walk(dir).sort((a, b) => (a.at < b.at ? 1 : -1));
  let log = [];
  try {
    const out = await git(dir, ['log', `--max-count=${commits}`, '--format=%aI%x00%s']);
    log = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [at, subject] = line.split('\0');
        return { at, subject };
      });
  } catch {
    // No commits yet is the common case and is not an error — `git log` on an unborn
    // branch exits non-zero, which is a fact about git and not about the agent.
  }
  return { dir, exists: true, files: all.slice(0, files), truncated: all.length > files, commits: log };
}

/* -------------------------------------------------------------------- the brief */

const KB = (n) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/**
 * What the agent is told. One string, two arms, and the difference between them is the
 * whole experiment — so they share every word except the listing.
 *
 * Written to make *not* using it an honest answer. The failure mode of an affordance
 * introduced with enthusiasm is an agent that writes a diary entry every run to be
 * seen complying, which would produce a full repo and no finding at all.
 */
export function repoBrief(index, { arm = 'blind', owner = 'the owner' } = {}) {
  const listing = () => {
    if (!index?.exists || (!index.files.length && !index.commits.length)) {
      return '**It is empty.** Nothing has ever been written to it.';
    }
    const files = index.files.length
      ? index.files.map((f) => `    ${f.name}  ${KB(f.size)}  ${f.at.slice(0, 16).replace('T', ' ')}`).join('\n')
      : '    (no files in the working tree)';
    const log = index.commits.length
      ? `\n\nCommits, newest first:\n\n${index.commits
          .map((c) => `    ${(c.at || '').slice(0, 10)}  ${c.subject}`)
          .join('\n')}`
      : '\n\nNothing has been committed.';
    return `**What is in it right now:**\n\n${files}${index.truncated ? '\n    …' : ''}${log}`;
  };

  return `**You have a directory of your own, with a git repo in it.** It is yours: nothing
else in beadcause reads it, nothing here tells you what to put in it, there is no
schema and no format, and it has no remote — it never leaves this Mac.

    beadcause-agentrepo path                   where it is
    beadcause-agentrepo ls [<dir>]             what is in it
    beadcause-agentrepo cat <file>             read one
    beadcause-agentrepo write <file>           write one; content on stdin
    beadcause-agentrepo write <file> --append  add to the end of one
    beadcause-agentrepo rm <file>              delete one
    beadcause-agentrepo git <args...>          any git command, inside it

This is not \`beadcause-memory\`. That is four calls with a shape ${owner} chose, for
things that would still be true next week. This is a filesystem with nothing decided
about it — and no part of beadcause will ever ask you for what is in here, so anything
you leave is for you.

${arm === 'index' ? listing() : ''}`.trimEnd() + '\n';
}

/* ------------------------------------------------------------- the measurement */

/** Which commands are a read, which are a change. `path` is neither. */
const FILE_KIND = { path: 'meta', ls: 'read', cat: 'read', write: 'write', rm: 'write' };

/**
 * git subcommands that only look.
 *
 * A denylist would be wrong here: the point of `git <args...>` is that it is all of
 * git, so the set that will exist tomorrow is unknown, and an unknown subcommand
 * counted as a *read* would quietly inflate the half of the experiment being argued
 * for. Unknown means write.
 */
const GIT_READS = new Set([
  'log', 'show', 'status', 'diff', 'cat-file', 'ls-files', 'ls-tree', 'rev-parse',
  'rev-list', 'blame', 'grep', 'shortlog', 'describe', 'reflog', 'count-objects',
  'check-ignore', 'whatchanged', 'version', 'help',
]);

/** What one invocation did, as one word. Exported because the wrapper stamps it. */
export function kindOf(verb, args = []) {
  if (verb !== 'git') return FILE_KIND[verb] || 'meta';
  const sub = String(args[0] || '');
  // `git config --get x` reads; `git config x y` writes. One subcommand on both sides
  // of the line, which is the whole reason this is not a lookup on the subcommand alone
  // — and why it is asked before the set, not after it.
  if (sub === 'config') return args.some((a) => a === '--get' || a === '--list' || a === '-l') ? 'read' : 'write';
  return GIT_READS.has(sub) ? 'read' : 'write';
}

/** A run id — the thing that ties one session's commands together. */
export const newRun = () => crypto.randomBytes(6).toString('hex');

/**
 * Append one line to the usage log.
 *
 * Never throws: the measurement must not be able to break the thing it is measuring,
 * and a session that fails because its instrumentation could not write would be the
 * silliest possible outcome for an experiment about affordances.
 */
export function record(entry) {
  try {
    fs.mkdirSync(AGENTS_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(USAGE_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* see above */
  }
}

/** The log, oldest first, unparseable lines dropped. */
export function entries({ limit = 5000 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(USAGE_LOG, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn append; one line is not worth failing a report over */
    }
  }
  return out;
}

/**
 * The log grouped into runs — one per spawn, in the order they happened.
 *
 * A run with only its `session` line is a run where the agent was told it had a repo
 * and did nothing with it, and that is a result rather than missing data. It is the
 * reason `session` is written at spawn and not on first use.
 */
export function runs({ agent = null, workspace = null, ...opts } = {}) {
  const byRun = new Map();
  for (const e of entries(opts)) {
    if (!e.run) continue;
    // Narrowing here rather than in the caller, because a run's rows carry the agent
    // and the workspace on every line and a caller filtering afterwards would have to
    // know that. See `summary` for why it is not optional to be able to.
    if (agent && e.agent && e.agent !== agent) continue;
    if (workspace && e.workspace && e.workspace !== workspace) continue;
    let r = byRun.get(e.run);
    if (!r) {
      r = { run: e.run, workspace: e.workspace, agent: e.agent, arm: e.arm, at: e.at, commands: [] };
      byRun.set(e.run, r);
    }
    if (e.arm && !r.arm) r.arm = e.arm;
    if (e.verb === 'session') continue;
    r.commands.push(e);
  }
  return [...byRun.values()];
}

/**
 * The comparison the whole thing exists for: per arm, what the agent actually did.
 *
 * `readFirst` is the number that answers the prediction. "Wrote and never read back" is
 * `wrote` minus `read`; "was told what was in there and went and looked" is `readFirst`
 * under the `index` arm. Reported per arm and never pooled, because a pooled number
 * would answer a question nobody asked.
 *
 * **`agent` and `workspace` narrow it, and that stopped being optional the moment a
 * second agent kind got a repo.** Every row carries both, and this bucketed on the arm
 * alone — which was indistinguishable from correct while exactly one agent had ever
 * run, and becomes a pooled number the day two do. Two agents' `blind` arms added
 * together answer a question nobody asked, in the one place the docstring above
 * promises never to.
 */
export function summary(opts = {}) {
  const blank = () => ({ runs: 0, touched: 0, read: 0, wrote: 0, readFirst: 0, commands: 0 });
  const out = { blind: blank(), index: blank() };
  for (const r of runs(opts)) {
    const arm = ARMS.includes(r.arm) ? r.arm : 'blind';
    const a = out[arm];
    a.runs += 1;
    const acts = r.commands.filter((c) => c.kind === 'read' || c.kind === 'write');
    a.commands += r.commands.length;
    if (r.commands.length) a.touched += 1;
    const firstRead = acts.findIndex((c) => c.kind === 'read');
    const firstWrite = acts.findIndex((c) => c.kind === 'write');
    if (firstRead !== -1) a.read += 1;
    if (firstWrite !== -1) a.wrote += 1;
    if (firstRead !== -1 && (firstWrite === -1 || firstRead < firstWrite)) a.readFirst += 1;
  }
  return out;
}

/**
 * Which arm this run gets.
 *
 * `alternate` is the default because the alternative is a switch somebody has to
 * remember to flip, and an experiment that depends on that produces one arm's worth of
 * data and no comparison. It picks whichever arm has had fewer runs *for this
 * workspace and agent* — per pair, because two workspaces advocating at different rates
 * would otherwise leave one of them always in the same arm.
 *
 * Ties go to `blind`, so the arm that tests the prediction is the one that goes first.
 */
export function armFor(workspace, agent, setting = 'alternate') {
  const want = String(setting || 'alternate');
  if (want === 'off') return null;
  if (ARMS.includes(want)) return want;
  const mine = runs().filter((r) => r.workspace === workspace && r.agent === agent);
  const blind = mine.filter((r) => r.arm === 'blind').length;
  const index = mine.filter((r) => r.arm === 'index').length;
  return blind <= index ? 'blind' : 'index';
}

/* ------------------------------------------------------------------ the grant */

/**
 * What a foundation with `ownsRepo` turns into at spawn: one allowlist entry and three
 * environment variables.
 *
 * Derived here rather than written in the baseline for the same reason `BEADCAUSE_AGENT`
 * and `PATH` are stamped in `foundation.agentEnv` and not stored: the concrete path
 * contains the workspace, which the foundation cannot know — a foundation is what an
 * agent is on *every* run, and this is per-run. What is in the foundation is the fact
 * that it owns one at all, which is the part an amendment must never be able to reach.
 *
 * The env is returned as `extra` for `agentEnv`, which spreads it *after* `foundation.env`
 * — so an amended `env` cannot repoint the wrapper at another agent's directory.
 */
export function grantsFor(foundation, workspace, { arm = 'blind', run = null } = {}) {
  if (!foundation?.ownsRepo) return null;
  const dir = repoDir(workspace, foundation.id);
  const id = run || newRun();
  return {
    dir,
    arm,
    run: id,
    allowedTools: ['Bash(beadcause-agentrepo:*)'],
    env: {
      BEADCAUSE_AGENT_REPO: dir,
      BEADCAUSE_AGENT_REPO_ARM: arm,
      BEADCAUSE_AGENT_REPO_RUN: id,
    },
  };
}
