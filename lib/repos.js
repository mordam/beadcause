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
const DEFAULT_TOKEN_PATH = 'config/config.yaml';

/** The key in that file whose value is the repo's identity. */
const DEFAULT_TOKEN_KEY = 'serviceToken';

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
 */
function readToken(dir, tokenPath, tokenKey) {
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
    const { token, problem } = readToken(e.dir, tokenPath, tokenKey);
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
    fallback =
      repos.find((r) => r.name === wanted) ||
      repos.find((r) => r.token === wanted) ||
      repos.find((r) => r.dir === expandHome(wanted)) ||
      null;
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

/**
 * Every workspace's warnings, prefixed with the workspace, for the startup log.
 *
 * "Reported at load, not guessed at" is the whole point of the block, and this is where
 * the reporting happens: bin/beadcause.js prints these beside the Slack token warnings.
 * A wrong `approved` list is otherwise invisible until a bead resolves to nothing at
 * three in the morning.
 */
export function repoWarnings(cfg = {}) {
  const all = cfg && typeof cfg.repos === 'object' && cfg.repos ? cfg.repos : {};
  const out = [];
  for (const name of Object.keys(all).sort()) {
    for (const w of repoList(cfg, name).warnings) out.push(w);
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
