/**
 * The repos one workspace may be worked in, and the token that names each of them.
 *
 * Every other part of beadcause assumes a workspace *is* a repo: one tracker, one
 * checkout, one deploy, one advocate. Climative is the shape that breaks it — a GitHub
 * org of forty-odd repos sharing a single `cl-` beads workspace, because only
 * `architecture` has beads installed and everything else files into that same graph. A
 * bead there is not about "climative", it is about `athena-service`, and until this
 * module existed there was nowhere to write that down.
 *
 * So: a workspace may name a set of checkouts, and a bead says which one it is about by
 * carrying that repo's **service token** — the short identifier the repo declares in its
 * own `config/config.yaml`, which is already how a Climative service names itself to
 * every other Climative service.
 *
 *     "repos": {
 *       "climative": {
 *         "root": "~/climative.dev",
 *         "default": "architecture",
 *         "approved": ["architecture", "athena-service", "building-service"]
 *       }
 *     }
 *
 * Keyed by workspace name, like `jira`, `sessionDirs` and `advocates.perWorkspace`, and
 * deliberately **not** a field on a `workspaces` entry — that array is discovered from
 * `~/beads/*​/.beads` and reconciled on every start (lib/config.js), so anything written
 * onto it by hand is gone at the next restart.
 *
 * ## An approved list, and never discovery
 *
 * `discoverWorkspaces()` in lib/config.js reads a directory and takes what is in it.
 * That is right for `~/beads`, which is a tracker's own private tree, and it is the
 * pattern **not** to follow here. An org has repos nobody wants an unattended agent
 * inside — a secrets repo, somebody else's service, an experiment — and a directory
 * appearing under `~/climative.dev` because a colleague told you to clone it must not be
 * enough to make it workable. `approved` is a list Adam writes. Everything else in that
 * tree resolves to nothing, and it does so by construction: nothing here ever reads the
 * root directory, only the entries named in the list.
 *
 * ## Why the token is read from the checkout and not restated here
 *
 * One source of truth. `athena-service` says `serviceToken: as` in its own config, and
 * beadcause asks it rather than keeping a copy — so a repo that renames its service says
 * so itself, in the commit that renames it, and a stale mapping in a JSON file on one
 * Mac cannot survive it. The cost is that a token is a *fact about a checkout on disk*
 * rather than a fact about the config, so it can be missing, unreadable, or shared with
 * another repo. All three are reported (see `repoList` below); none of them is guessed
 * at.
 *
 * ## The duplicates are real, and they are why nothing falls back
 *
 * On this Mac today, three approved-looking repos declare `as` (athena-service,
 * audit-service, rules-engine-service), two declare `ps`, and eight declare `xs` —
 * because `microservice-base` ships `xs` as a placeholder and a service that never
 * changed it keeps it. A resolver that answered the *first* match would send a session
 * into whichever repo sorted first, in a checkout it was never meant to touch, hours
 * before anybody looked.
 *
 * And it must not fall back to the default repo either. "A bead with no token belongs to
 * `architecture`" is true and useful; "a bead whose token I could not resolve belongs to
 * `architecture`" is how work aimed at one service quietly lands in the repo that holds
 * the workspace's Dolt remote. So `resolveRepo` distinguishes them: no token is an
 * answer, an unresolvable token is a `problem` sentence and no repo at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

/** Where a repo declares itself, relative to its checkout, unless the block says otherwise. */
export const DEFAULT_TOKEN_PATH = 'config/config.yaml';

/** The key in that file whose value is the repo's identity. */
export const DEFAULT_TOKEN_KEY = 'serviceToken';

/** `~/climative.dev` → `/Users/you/climative.dev`. Anything else is returned resolved. */
export function expandHome(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

/**
 * The block for one workspace, or null.
 *
 * An absent block is the answer for almost every workspace on almost every install, and
 * it has to cost nothing: no readdir, no stat, no YAML. `sophab` is a repo, `beadcause`
 * is a repo, and neither should pay for a shape only Climative has.
 */
export function reposBlock(cfg = {}, workspaceName = '') {
  const all = cfg && typeof cfg.repos === 'object' && cfg.repos ? cfg.repos : {};
  const block = all[workspaceName];
  return block && typeof block === 'object' && !Array.isArray(block) ? block : null;
}

/** Does this workspace hold more than one repo at all? Asked before anything costs anything. */
export function multiRepo(cfg = {}, workspaceName = '') {
  const block = reposBlock(cfg, workspaceName);
  return Array.isArray(block?.approved) && block.approved.some((e) => String(e || '').trim());
}

/**
 * One approved entry → an absolute directory and the name we call it by.
 *
 * An entry is normally a bare directory name under `root` — `"athena-service"` — which
 * is what makes the list readable as *a list of repos* rather than a list of paths. A
 * path is accepted too, for the checkout that lives somewhere else, and then the name is
 * its basename.
 */
function entryDir(entry, root) {
  const raw = String(entry || '').trim();
  if (!raw) return null;
  const isPath = raw.startsWith('~') || raw.startsWith('/') || raw.startsWith('.') || raw.includes('/');
  const dir = isPath ? expandHome(raw) : root ? path.join(root, raw) : null;
  return dir ? { name: path.basename(dir), entry: raw, dir } : { name: raw, entry: raw, dir: null };
}

/**
 * The service token a checkout declares, or the reason there is none.
 *
 * Parsed with the YAML parser rather than grepped, because these files carry trailing
 * comments on exactly this key — one repo on this Mac says
 * `serviceToken: prs   # ps already in use by project-service`, and a line-scan that
 * kept the comment would invent a token no bead will ever carry. The regex is kept as
 * the *fallback* for a file the parser refuses outright: a service whose config has an
 * unrelated syntax error still has an identity, and refusing to read it would take a
 * whole repo out of reach over a stray tab two hundred lines below.
 *
 * Exported for `lib/reposcan.js`, which shows the tree for approval in
 * `npm run configure` and has to read a token exactly the same way — a setup screen that
 * kept the trailing comment would offer a token the resolver will never agree with. It
 * takes a *named* directory and reads one file in it; the readdir stays over there, which
 * is what `node test/repos.mjs` asserts about this module.
 */
export function readRepoToken(dir, tokenPath = DEFAULT_TOKEN_PATH, tokenKey = DEFAULT_TOKEN_KEY) {
  const file = path.join(dir, tokenPath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { token: null, problem: err.code === 'ENOENT' ? `has no ${tokenPath}` : `cannot read ${tokenPath} — ${err.message.split('\n')[0]}` };
  }
  let value;
  try {
    const doc = YAML.parse(raw);
    if (doc && typeof doc === 'object') value = doc[tokenKey];
  } catch {
    const line = new RegExp(`^${tokenKey}\\s*:\\s*(.+)$`, 'm').exec(raw);
    // Strip a trailing comment and any quotes the hand-written line carried.
    if (line) value = line[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
  }
  const token = value === null || value === undefined ? '' : String(value).trim();
  if (!token) return { token: null, problem: `declares no ${tokenKey} in ${tokenPath}` };
  return { token, problem: null };
}

/**
 * The repo a *config value* names: by directory name, by service token, or by path.
 *
 * All three, because all three are how somebody writes a repo down by hand. `approved`
 * lists names, a bead carries a token, and a checkout that lives outside `root` is a
 * path — and a config key that accepted only one of them would be a second spelling of
 * the same repo to get wrong. `repos.<ws>.default` has resolved this way since bc-l853.1
 * and `deploys.<ws>/<repo>` now resolves the same way, off the same list, deliberately:
 * two config keys naming a repo must not disagree about what naming one means.
 *
 * Case-folded on the token for the reason `repoList` folds its duplicate check — a
 * declaration written `climative/AS` names the same checkout to everyone reading it.
 * Never falls back to anything: a value that resolves to no approved repo is reported by
 * its caller, and the whole of `resolveRepo`'s argument applies to a `deploys` key too.
 */
function pick(repos, wanted) {
  const want = String(wanted || '').trim();
  if (!want) return null;
  const k = want.toLowerCase();
  return (
    repos.find((r) => r.name === want) ||
    repos.find((r) => r.token.toLowerCase() === k) ||
    repos.find((r) => r.dir === expandHome(want)) ||
    null
  );
}

/**
 * Everything read off disk for one workspace, cached against the files it was read from.
 *
 * The cache exists because this is asked on the hot path — the advocate's survey, the
 * board, every session launch — and answering it costs a `readFileSync` per approved
 * repo, forty of them for Climative. The key is the block itself plus each token file's
 * mtime, so editing a repo's `config/config.yaml` or the config's `approved` list is
 * picked up on the next call without a restart, and a run of calls that changed nothing
 * costs one `statSync` per repo.
 */
const cache = new Map();

function signature(block, dirs, tokenPath) {
  const stamps = dirs.map((d) => {
    if (!d.dir) return `${d.entry}:none`;
    try {
      return `${d.dir}:${fs.statSync(path.join(d.dir, tokenPath)).mtimeMs}`;
    } catch {
      return `${d.dir}:gone`;
    }
  });
  return `${JSON.stringify(block)}\n${stamps.join('\n')}`;
}

/**
 * The approved repos of one workspace, resolved, with everything that went wrong said
 * out loud.
 *
 *   repos       the ones that resolved — `{name, dir, token}`, in the order listed
 *   unresolved  the ones that did not — `{name, dir, problem}`
 *   duplicates  tokens claimed by more than one approved repo — `{token, names}`
 *   fallback    the repo a bead with no token belongs to, or null
 *   warnings    one sentence per problem, for the startup log
 *
 * A repo whose token collides is in **neither** `repos` nor `unresolved`: it resolved
 * fine and the token is simply not usable as an address. `resolveRepo` says so in those
 * words rather than reporting the repo as broken, because nothing is wrong with the
 * checkout — two of them are wearing the same name.
 */
export function repoList(cfg = {}, workspaceName = '') {
  const block = reposBlock(cfg, workspaceName);
  const empty = {
    workspace: workspaceName,
    root: null,
    repos: [],
    unresolved: [],
    duplicates: [],
    fallback: null,
    warnings: [],
  };
  if (!block || !multiRepo(cfg, workspaceName)) return empty;

  const root = block.root ? expandHome(block.root) : null;
  const tokenPath = String(block.tokenPath || DEFAULT_TOKEN_PATH);
  const tokenKey = String(block.tokenKey || DEFAULT_TOKEN_KEY);

  // Deduplicated by resolved directory, first mention winning, so a list edited twice
  // does not report a repo as colliding with itself.
  const seen = new Set();
  const entries = [];
  for (const raw of block.approved) {
    const e = entryDir(raw, root);
    if (!e) continue;
    const key = e.dir || `?${e.entry}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(e);
  }

  const sig = signature(block, entries, tokenPath);
  const hit = cache.get(workspaceName);
  if (hit && hit.sig === sig) return hit.value;

  const repos = [];
  const unresolved = [];
  const warnings = [];
  const where = (e) => e.dir || `${e.entry} (no repos.${workspaceName}.root, and the entry is not a path)`;

  if (root && !fs.existsSync(root)) {
    warnings.push(
      `repos.${workspaceName}.root is ${block.root} (${root}), which does not exist — no ${workspaceName} repo can be resolved`
    );
  }

  for (const e of entries) {
    if (!e.dir) {
      unresolved.push({ name: e.name, dir: null, problem: 'is not a path and there is no root to join it to' });
      warnings.push(`repos.${workspaceName}.approved lists "${e.entry}" but repos.${workspaceName}.root is not set`);
      continue;
    }
    if (!fs.existsSync(e.dir)) {
      unresolved.push({ name: e.name, dir: e.dir, problem: 'is not on disk' });
      warnings.push(`${workspaceName} repo "${e.name}" is approved but ${e.dir} does not exist — clone it, or take it out of repos.${workspaceName}.approved`);
      continue;
    }
    const { token, problem } = readRepoToken(e.dir, tokenPath, tokenKey);
    if (!token) {
      unresolved.push({ name: e.name, dir: e.dir, problem });
      warnings.push(
        `${workspaceName} repo "${e.name}" ${problem} — beadcause cannot tell which service it is, so no bead can name it (${where(e)})`
      );
      continue;
    }
    repos.push({ name: e.name, dir: e.dir, token });
  }

  // Case-folded, because two repos differing only in the case of their token are
  // ambiguous to the person writing the bead whatever a string comparison says.
  const byToken = new Map();
  for (const r of repos) {
    const k = r.token.toLowerCase();
    if (!byToken.has(k)) byToken.set(k, []);
    byToken.get(k).push(r);
  }
  const duplicates = [];
  for (const [k, group] of byToken) {
    if (group.length < 2) continue;
    const names = group.map((r) => r.name);
    duplicates.push({ token: k, names });
    warnings.push(
      `service token "${k}" is declared by ${group.length} approved ${workspaceName} repos (${names.join(', ')}) — ` +
        `a bead naming it resolves to nothing, because guessing between them would open a session in the wrong checkout`
    );
  }

  const wanted = String(block.default || '').trim();
  let fallback = null;
  if (wanted) {
    fallback = pick(repos, wanted);
    if (!fallback) {
      warnings.push(
        `repos.${workspaceName}.default is "${wanted}", which is not an approved ${workspaceName} repo that resolved — ` +
          `a bead carrying no service token belongs nowhere until it is`
      );
    }
  } else if (repos.length === 1) {
    // One repo and no argument about it: the list is the answer.
    [fallback] = repos;
  }

  const value = { workspace: workspaceName, root, repos, unresolved, duplicates, fallback, warnings };
  cache.set(workspaceName, { sig, value });
  return value;
}

/**
 * Which approved repo a bead naming `token` is about — or why none of them is.
 *
 * Returns `{ repo, problem }` and never throws, because every caller of this is
 * answering a question about a bead somebody is looking at, and "this bead cannot be
 * placed, here is why" belongs on the screen rather than in a stack trace.
 *
 * The three answers that are not a repo are deliberately different sentences:
 *
 *   - **no token, no default** — the workspace has not said where a plain bead goes
 *   - **unknown token** — nothing approved declares it, which is usually a repo Adam
 *     has not approved rather than a typo, so the sentence lists what *is* approved
 *   - **ambiguous token** — two approved repos declare it, and this is the one case
 *     where an answer exists and is deliberately withheld
 */
export function resolveRepo(cfg = {}, workspaceName = '', token = '') {
  const list = repoList(cfg, workspaceName);
  const want = String(token || '').trim();

  if (!want) {
    if (list.fallback) return { repo: list.fallback, problem: null };
    if (!multiRepo(cfg, workspaceName)) return { repo: null, problem: null };
    return {
      repo: null,
      problem: `no service token, and repos.${workspaceName}.default does not name a repo that resolved — set it to the repo a bead with no token belongs to`,
    };
  }

  const k = want.toLowerCase();
  const dup = list.duplicates.find((d) => d.token === k);
  if (dup) {
    return {
      repo: null,
      problem: `service token "${want}" is declared by ${dup.names.length} approved ${workspaceName} repos (${dup.names.join(', ')}) — beadcause will not guess between them`,
    };
  }

  const hit = list.repos.find((r) => r.token.toLowerCase() === k);
  if (hit) return { repo: hit, problem: null };

  const broke = list.unresolved.find((u) => u.name.toLowerCase() === k);
  if (broke) {
    return { repo: null, problem: `${workspaceName} repo "${broke.name}" ${broke.problem}, so nothing can resolve to it` };
  }

  return {
    repo: null,
    problem: list.repos.length
      ? `no approved ${workspaceName} repo declares the service token "${want}" — approved: ${list.repos.map((r) => `${r.name} (${r.token})`).join(', ')}`
      : `no ${workspaceName} repo has been approved — add one to repos.${workspaceName}.approved`,
  };
}

/** The repo a bead carrying no token belongs to, or null. */
export const defaultRepo = (cfg = {}, workspaceName = '') => repoList(cfg, workspaceName).fallback;

/* --------------------------------------------------- the unit a deploy is declared for */

/**
 * What the rest of beadcause keys a deploy, a pull request board card and a release queue
 * by, now that a workspace is not a repo.
 *
 * Every one of those three is about **a checkout with a GitHub remote**: a deploy runs in
 * one, a board card lists one's pull requests, a queue is what one deploy of one repo
 * would make live. A workspace is none of those things — it is a tracker — and the day
 * Climative arrived the difference stopped being cosmetic. `cfg.deploys.climative` has no
 * single true answer, and `deployFor` reverse-mapping a directory to a workspace name
 * returned `climative` for all forty-odd of them, so the same entry would have deployed
 * `architecture` whichever repo's Ship you pressed.
 *
 * So a **unit** is one repo, and its **key** is the string every one of those keys by:
 *
 *   - `beadcause`, `sophab` — a workspace that is one repo keys by its own name, which is
 *     exactly what it keyed by before any of this existed. Nothing changes for the installs
 *     that are not Climative, and no config anybody has written needs editing.
 *   - `climative/athena-service` — a workspace with an approved list keys per repo, and the
 *     half after the `/` names one the way `repos.<ws>.default` does (see `pick`): its
 *     directory name, its service token, or its path.
 *
 * The separator is `/` because that is already how this codebase writes a pair whose left
 * half is a workspace — `${ws.name}/${id}` is the key of every inbox card and every
 * dismissal record in `state.json`. A workspace name cannot contain one: it is a directory
 * name under `~/beads`.
 *
 * **A bare workspace key for a multi-repo workspace is refused rather than resolved**, by
 * every caller that reads one. See `deployFor` in lib/deploy.js for the argument in full;
 * the short version is that the entry which used to mean "deploy climative" now means
 * nothing anybody can act on, and running the default repo's deploy for it would ship the
 * one repo whose Ship nobody pressed.
 */
export const REPO_KEY_SEP = '/';

/** `climative/athena-service`, or just `beadcause` where the workspace is the repo. */
export const repoKey = (workspaceName, repo = null) =>
  repo?.name ? `${String(workspaceName || '')}${REPO_KEY_SEP}${repo.name}` : String(workspaceName || '');

/** `climative/as` → `{ workspace: 'climative', wanted: 'as' }`. Never throws. */
export function splitRepoKey(key) {
  const s = String(key || '').trim();
  const at = s.indexOf(REPO_KEY_SEP);
  return at < 0 ? { workspace: s, wanted: '' } : { workspace: s.slice(0, at), wanted: s.slice(at + 1).trim() };
}

/**
 * Every unit of one workspace: one per approved repo, or the workspace itself.
 *
 * The order is `approved`'s, which is the order Adam wrote — a list of forty repos has a
 * shape in his head and the board should not resort it alphabetically underneath him.
 *
 * A repo that did not resolve is **not** a unit: there is no checkout to deploy, no remote
 * to list pull requests from, and `repoList` has already said why in a warning. And a
 * multi-repo workspace with nothing approved that resolved has no units at all rather than
 * falling back to the workspace — that fallback is the exact bug this file exists to end.
 */
export function repoUnits(cfg = {}, workspaceName = '') {
  const name = String(workspaceName || '');
  if (!multiRepo(cfg, name)) return [{ key: name, workspace: name, repo: null }];
  return repoList(cfg, name).repos.map((repo) => ({ key: repoKey(name, repo), workspace: name, repo }));
}

/** Every unit of every configured workspace, in configured order. */
export const allUnits = (cfg = {}) => (cfg.workspaces || []).flatMap((w) => repoUnits(cfg, w.name));

/**
 * A key read back: which workspace, which repo, or why neither.
 *
 * `{ workspace, repo, key, problem }`, and `problem` is a sentence rather than a throw for
 * the reason `resolveRepo` gives — every caller is answering for something somebody is
 * looking at, and a `deploys` key nobody can resolve belongs on that screen.
 *
 * The four answers, and the third is the one this bead is about:
 *
 *   - **A single-repo workspace** — `repo: null`, no problem. What every key was.
 *   - **`<ws>/<repo>` naming an approved repo** — that repo.
 *   - **A bare `<ws>` where the workspace holds many repos** — a problem. The key is
 *     ambiguous by forty, and answering with the default repo is how work aimed at one
 *     service is done to another.
 *   - **`<ws>/<something>` that names no approved repo** — `resolveRepo`'s own sentence,
 *     which lists what *is* approved, because the usual cause is a repo not on the list.
 */
export function unitFor(cfg = {}, key = '') {
  const { workspace, wanted } = splitRepoKey(key);
  if (!multiRepo(cfg, workspace)) {
    return wanted
      ? {
          workspace,
          repo: null,
          key: String(key || ''),
          problem: `${workspace} is one repo, so nothing names "${wanted}" in it — the key for it is just "${workspace}"`,
        }
      : { workspace, repo: null, key: workspace, problem: null };
  }
  if (!wanted) {
    const list = repoList(cfg, workspace);
    return {
      workspace,
      repo: null,
      key: workspace,
      problem:
        `${workspace} holds ${list.repos.length} approved repo${list.repos.length === 1 ? '' : 's'}, so "${workspace}" ` +
        `on its own names no checkout — key it per repo, as ${
          list.repos.length ? `"${repoKey(workspace, list.repos[0])}"` : `"${workspace}/<repo>"`
        }`,
    };
  }
  const repo = pick(repoList(cfg, workspace).repos, wanted);
  if (repo) return { workspace, repo, key: repoKey(workspace, repo), problem: null };
  return { workspace, repo: null, key: String(key || ''), problem: resolveRepo(cfg, workspace, wanted).problem };
}

/* ------------------------------------------------- how a bead says which repo it is about */

/**
 * The label prefix. One spelling in one place — the same decision, for the same reason,
 * as `SUPERSEDE_PREFIX` in lib/superseded.js.
 *
 * A label rather than a field because it is the only per-bead thing beads itself will
 * carry, sync and filter on without beadcause owning a schema: `bd create --label
 * repo:as`, `bd label add cl-9f2 repo:as`, and `bd list --label repo:as` all work today
 * and go through Dolt to every other machine on the workspace. The alternative — a line
 * in the description that beadcause parses — is prose, and prose is what this whole epic
 * exists to stop relying on.
 */
export const REPO_PREFIX = 'repo:';

/** `repo:as`. What a bead carries, and what the resolver reads back. */
export const repoLabel = (token) => `${REPO_PREFIX}${String(token || '').trim()}`;

/**
 * How a window title, a card and a log line say **where** something opened.
 *
 * `climative · athena-service` where the workspace holds several checkouts, and the
 * bare workspace name where it is the one repo it has always been. The second half is
 * omitted rather than filled in with the workspace again, because every install that is
 * not Climative would otherwise grow a repeated word on every card that says nothing —
 * and a label that is noise everywhere stops being read in the one place it matters.
 */
export const whereLanded = (workspaceName, repo) =>
  repo?.name ? `${String(workspaceName || '')} · ${repo.name}` : String(workspaceName || '');

/**
 * What a launch record keeps of the repo it opened in.
 *
 * The name and the token, and no path: the directory is already on the record as `dir`,
 * and a second copy of it is a second thing to be wrong. Null for a single-repo
 * workspace, so a card can ask `if (repo)` and every install that is not Climative
 * answers no without knowing this module exists.
 */
export const repoSummary = (repo) => (repo?.name ? { name: repo.name, token: repo.token || '' } : null);

/**
 * The `repo:` labels off a bead, and nothing else.
 *
 * A terminal record and a chat session both outlive the row they were opened from, and
 * a terminal can be **re-opened from the record alone** — that is what /admin does with
 * one whose pty is gone. Keeping the labels that decided the checkout is what makes the
 * replacement land in the same one; keeping the whole row would be a stale copy of a
 * bead that has moved on, and keeping nothing would quietly reopen an `athena-service`
 * terminal in `architecture`.
 */
export const repoLabelsOf = (bead) =>
  (bead?.labels || []).map((l) => String(l).trim()).filter((l) => l.toLowerCase().startsWith(REPO_PREFIX));

/**
 * The service token a bead names, or why it names none usable.
 *
 * Takes a `bd --json` row, anything carrying `labels`, or a bare token string — the last
 * because a caller that already knows the token (a route with `?repo=as` on it, a test)
 * should not have to build a fake bead to ask.
 *
 * Returns `{ token, problem }`, the same shape `resolveRepo` answers in, so a caller can
 * check `problem` once and print it. Both of the not-a-token answers are deliberate:
 *
 *   - **no `repo:` label at all** — `{ token: '', problem: null }`, which is a real
 *     answer: that bead belongs to the workspace's `default` repo.
 *   - **two different `repo:` labels** — `{ token: null, problem: … }`. Somebody labelled
 *     it twice, or a sweep did; taking the first would open a session in whichever label
 *     sorted first, which is the same failure mode as a duplicate service token and gets
 *     the same refusal. Two labels naming the *same* token is not a conflict, it is one
 *     answer written twice.
 *   - **a bare `repo:` with nothing after it** — also a `problem`, and not "no token".
 *     A typed label that resolved to the default repo would look exactly like a bead
 *     nobody had labelled at all.
 */
export function beadToken(bead) {
  if (!bead) return { token: '', problem: null };
  if (typeof bead === 'string') return { token: bead.trim(), problem: null };

  const found = [];
  let bare = false;
  for (const raw of bead.labels || []) {
    const label = String(raw).trim();
    if (!label.toLowerCase().startsWith(REPO_PREFIX)) continue;
    const token = label.slice(REPO_PREFIX.length).trim();
    if (!token) {
      bare = true;
      continue;
    }
    if (!found.some((t) => t.toLowerCase() === token.toLowerCase())) found.push(token);
  }

  if (found.length > 1) {
    return {
      token: null,
      problem: `carries ${found.length} service tokens (${found.map(repoLabel).join(', ')}) — beadcause will not guess between them, take the wrong one off`,
    };
  }
  if (found.length === 1) return { token: found[0], problem: null };
  if (bare) return { token: null, problem: `carries a bare "${REPO_PREFIX}" label with no service token after it` };
  return { token: '', problem: null };
}

/**
 * Every workspace's warnings, prefixed with the workspace, for the startup log.
 *
 * "Reported at load, not guessed at" is the whole point of the block, and this is where
 * the reporting happens: bin/beadcause.js prints these beside the Slack token warnings.
 * A wrong `approved` list is otherwise invisible until a bead resolves to nothing at
 * three in the morning.
 *
 * The last one is not about the list at all: `sessionDirs.<workspace>` is the older,
 * blunter way of saying where a workspace opens, and it pins one directory. A workspace
 * that has both is a config that says two different things, and `resolveSessionDir`
 * answers with the repo — because "this bead is about `athena-service`" is more specific
 * than "this workspace opens in one place", and honouring the override would send every
 * bead in the workspace to the same checkout with nothing on screen to say why. Saying
 * so at load is what stops that being discovered from a pull request in the wrong repo.
 */
export function repoWarnings(cfg = {}) {
  const all = cfg && typeof cfg.repos === 'object' && cfg.repos ? cfg.repos : {};
  const out = [];
  for (const name of Object.keys(all).sort()) {
    for (const w of repoList(cfg, name).warnings) out.push(w);
    const pinned = cfg.sessionDirs?.[name];
    if (pinned && multiRepo(cfg, name)) {
      out.push(
        `sessionDirs.${name} pins ${pinned}, but ${name} has an approved repo list — the repo a bead names wins, ` +
          `so that override no longer decides anything. Take it out, or empty repos.${name}.approved`
      );
    }
  }
  return out;
}

/** `climative: 12 repos, architecture by default` — one line for the startup banner. */
export function repoStatusLine(cfg = {}) {
  const all = cfg && typeof cfg.repos === 'object' && cfg.repos ? cfg.repos : {};
  const names = Object.keys(all).filter((n) => multiRepo(cfg, n)).sort();
  if (!names.length) return '(none — every workspace is one repo)';
  return names
    .map((n) => {
      const list = repoList(cfg, n);
      const bad = list.unresolved.length ? `, ${list.unresolved.length} unresolved` : '';
      return `${n}: ${list.repos.length} repo${list.repos.length === 1 ? '' : 's'}${bad}${
        list.fallback ? `, ${list.fallback.name} by default` : ', no default'
      }`;
    })
    .join(' · ');
}

/** Drop the memo, so a suite can rewrite a checkout's config and ask again in the same ms. */
export const forgetRepos = () => cache.clear();
