/**
 * The tree under a workspace's root, read out loud so it can be **approved** — the one
 * place in beadcause that looks at a directory of checkouts rather than at a list.
 *
 * `lib/repos.js` deliberately never reads its root: an entry in `repos.<ws>.approved` is
 * the only thing that makes a checkout workable, because a directory appearing under
 * `~/climative.dev` because a colleague told you to clone it must not be enough to put an
 * unattended agent inside it. `node test/repos.mjs` asserts there is no `readdir` in that
 * module, so a later "just to be helpful" scan cannot quietly undo the decision.
 *
 * That decision is about **resolution**, and it left the list itself with no way to write
 * it. The list is long — forty-odd directories on this Mac — and the two facts that decide
 * an entry are invisible from the config file: whether the repo is cloned at all, and what
 * service token its own `config/config.yaml` declares. Writing it by hand means opening
 * forty YAML files and hoping.
 *
 * So this module is the other half: **discovery presented for approval**, which is a
 * different thing from discovery applied. It reads the root, says what is there and what
 * each one calls itself, and hands that to `scripts/configure.js` to print. Nothing here
 * writes anything, nothing here decides anything, and a repo becomes workable only by
 * being ticked — the rule survives, because the tick is still a human answer and the file
 * the resolver reads is still a list somebody wrote.
 *
 * Two smaller reasons it is a separate file rather than a few more exports over there:
 * the resolver is on the hot path (the advocate's survey, the board, every session launch)
 * and this is run once by a wizard; and the assertion about `readdir` is worth keeping
 * literal, since it is the cheapest possible check on the most expensive possible mistake.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reposBlock, expandHome, readRepoToken, DEFAULT_TOKEN_PATH, DEFAULT_TOKEN_KEY } from './repos.js';

/** `/Users/you/climative.dev` → `~/climative.dev`, so the config file stays readable. */
export function tildeHome(abs) {
  const home = os.homedir();
  const p = String(abs || '');
  if (p === home) return '~';
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Directories in `dir`, hidden ones left out. `[]` for anything unreadable. */
function childDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
      .map((e) => e.name)
      .filter((name) => {
        try {
          return fs.statSync(path.join(dir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Does this directory look like a checkout somebody works in? */
const isCheckout = (dir) => fs.existsSync(path.join(dir, '.git'));

/**
 * Where a workspace's checkouts might live, guessed, or null.
 *
 * Only ever a *guess offered as a default* — the same move question 4 of the wizard makes
 * when it looks for `~/code` and `~/projects`. It matters that the guess is narrow: this
 * is what decides whether the question is asked at all, and an install where every
 * workspace is one repo — which is almost every install — must be asked nothing.
 *
 * So both halves have to hold. The directory is named after the workspace (`climative` →
 * `climative.dev`, `climative-repos`, `climative_src`; a bare `climative` too), and it
 * holds **two or more git checkouts**, because one checkout is the ordinary shape and
 * there is nothing to approve about it. `~/beads` is excluded outright: it is the
 * tracker's own tree, `~/beads/<workspace>` is named after the workspace by construction,
 * and nothing in it is a repo anybody works in.
 */
export function candidateRoot(cfg = {}, workspaceName = '') {
  const ws = String(workspaceName || '').trim();
  if (!ws) return null;
  const home = os.homedir();
  const beads = path.join(home, 'beads');
  const searchIn = [home, cfg.projectRoot, ...(cfg.assetRoots || [])]
    .map((d) => (d ? expandHome(d) : ''))
    .filter(Boolean)
    .filter((d) => d !== beads && !d.startsWith(`${beads}/`));

  const named = (name) => name === ws || (name.startsWith(ws) && /^[.\-_]/.test(name.slice(ws.length)));

  for (const dir of [...new Set(searchIn)]) {
    for (const name of childDirs(dir)) {
      if (!named(name)) continue;
      const cand = path.join(dir, name);
      if (childDirs(cand).filter((c) => isCheckout(path.join(cand, c))).length < 2) continue;
      return cand;
    }
  }
  return null;
}

/**
 * The workspaces `npm run configure` should ask about, and where each one's repos live.
 *
 * `source` is why it is being asked, which is the difference between "you configured this,
 * here it is again" and "there is a directory here that looks like it":
 *
 *   config  `repos.<ws>` already exists — asked whatever is on disk, so a root that has
 *           moved or a repo that was never cloned can be fixed rather than only warned
 *           about at every startup
 *   guess   no block, but `candidateRoot` found a tree of checkouts named after it
 *
 * An install with neither gets an empty array and therefore no question, which is the
 * whole of "one workspace is one repo, as it was before any of this existed".
 */
export function scanTargets(cfg = {}) {
  const out = [];
  for (const w of cfg.workspaces || []) {
    const name = typeof w === 'string' ? w : w?.name;
    if (!name) continue;
    const block = reposBlock(cfg, name);
    if (block) {
      out.push({ workspace: name, root: block.root ? expandHome(block.root) : null, source: 'config' });
      continue;
    }
    const guess = candidateRoot(cfg, name);
    if (guess) out.push({ workspace: name, root: guess, source: 'guess' });
  }
  return out;
}

/**
 * Everything under one root, with what each directory calls itself.
 *
 *   exists  whether the root is there at all — a moved checkout tree is a fixable answer
 *   found   `{name, dir, token, problem, checkout}` per directory, in name order
 *   shared  tokens claimed by more than one directory — `{token, names}`
 *
 * `found` is every directory, not only the ones that resolved: `climative-apps` declares
 * no `serviceToken` and `tmp` is not a checkout at all, and both are more useful shown
 * with the reason than silently missing from a list somebody is about to tick.
 *
 * `shared` is computed over the whole tree rather than over the approved subset, because
 * it is drawn *before* anything is ticked and its job is to warn you off ticking the
 * second one. The collisions that actually matter are recomputed from the approved list by
 * `repoList` afterwards, which is the number the resolver will act on.
 */
export function scanRoot(root, { tokenPath = DEFAULT_TOKEN_PATH, tokenKey = DEFAULT_TOKEN_KEY } = {}) {
  const dir = root ? expandHome(root) : '';
  const empty = { root: dir, exists: false, found: [], shared: [] };
  if (!dir || !fs.existsSync(dir)) return empty;

  const found = childDirs(dir).map((name) => {
    const abs = path.join(dir, name);
    const checkout = isCheckout(abs);
    const { token, problem } = readRepoToken(abs, tokenPath, tokenKey);
    return { name, dir: abs, token, problem: token ? null : checkout ? problem : 'is not a git checkout', checkout };
  });

  const byToken = new Map();
  for (const r of found) {
    if (!r.token) continue;
    const k = r.token.toLowerCase();
    if (!byToken.has(k)) byToken.set(k, []);
    byToken.get(k).push(r.name);
  }
  const shared = [...byToken.entries()].filter(([, names]) => names.length > 1).map(([token, names]) => ({ token, names }));

  return { root: dir, exists: true, found, shared };
}

/**
 * A typed answer → the list to write.
 *
 * Numbers and ranges against the printed list (`1,4,7-9`) because forty names is not
 * something anybody types, plus names for the person who knows what they want. Case is
 * folded to the name the directory actually has, so `Athena-Service` becomes
 * `athena-service` and resolves.
 *
 * Three rules the whole approval story rests on:
 *
 *   - **`none` is the only way to clear it.** Blank never arrives here — the wizard's
 *     `ask` substitutes the default, which is whatever is approved today — so holding
 *     Enter through this question cannot unapprove a repo, and cannot approve one either.
 *   - **Nothing unticked survives.** The answer *is* the list; there is no merge with what
 *     was there before, because "I removed one and it stayed" is the failure that would
 *     make the screen worth less than the JSON file.
 *   - **A name that is not in the tree is kept, and said out loud** (`unknown`). It is
 *     usually a repo that is approved but not cloned yet, or an absolute path to a
 *     checkout living somewhere else — both legal, both already reported by `repoList` —
 *     and silently dropping it would unapprove a repo by refusing to echo the default back.
 *
 * A *number* outside the list is the one thing dropped rather than kept (`dropped`): it
 * cannot be a repo name, so it is a slip, and writing `"99"` into the approved list would
 * be a warning at every startup forever.
 */
export function parseApproved(answer, found = [], current = []) {
  const raw = String(answer ?? '').trim();
  if (!raw || /^none$/i.test(raw)) return { approved: [], unknown: [], dropped: [], cleared: true };

  const names = found.map((f) => f.name);
  const canon = new Map(names.map((n) => [n.toLowerCase(), n]));
  const approved = [];
  const unknown = [];
  const dropped = [];
  const take = (n) => {
    if (n && !approved.includes(n)) approved.push(n);
  };

  for (const piece of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(piece);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      let any = false;
      for (let i = lo; i <= hi; i += 1) {
        if (i >= 1 && i <= names.length) {
          take(names[i - 1]);
          any = true;
        }
      }
      if (!any) dropped.push(piece);
      continue;
    }
    if (/^\d+$/.test(piece)) {
      const i = Number(piece);
      if (i >= 1 && i <= names.length) take(names[i - 1]);
      else dropped.push(piece);
      continue;
    }
    const hit = canon.get(piece.toLowerCase());
    if (hit) take(hit);
    else {
      take(piece);
      // Only worth saying once, and only if it is not something already approved — the
      // default is the current list, so echoing it back must be silent.
      if (!current.some((c) => String(c).toLowerCase() === piece.toLowerCase())) unknown.push(piece);
    }
  }

  return { approved, unknown, dropped, cleared: false };
}

/**
 * The typed default repo → what to write, and what is wrong with it.
 *
 * Accepted as a name, as a service token, or as a path, in that order, because all three
 * are what `repoList` will accept later and a wizard that took only one of them would
 * reject an answer the resolver would have honoured.
 *
 * A value that matches nothing approved is **kept, with the problem said** rather than
 * dropped. It is nearly always a repo the person is about to approve or clone, and
 * quietly emptying the field would trade a sentence they can read now for a bead
 * resolving to nothing at three in the morning. `repoList` warns about it at every
 * startup until it resolves.
 */
export function resolveDefaultChoice(answer, approved = [], found = []) {
  const want = String(answer ?? '').trim();
  if (!want) return { value: null, problem: null };

  const inApproved = (name) => approved.some((a) => String(a).toLowerCase() === String(name).toLowerCase());
  if (inApproved(want)) return { value: want, problem: null };

  const byToken = found.find((f) => f.token && f.token.toLowerCase() === want.toLowerCase() && inApproved(f.name));
  if (byToken) return { value: byToken.name, problem: null };

  const asPath = found.find((f) => f.dir === expandHome(want) && inApproved(f.name));
  if (asPath) return { value: asPath.name, problem: null };

  return {
    value: want,
    problem: approved.length
      ? `"${want}" is not one of the repos you just approved — a bead with no service token will resolve to nothing until it is`
      : `"${want}" cannot be the default when nothing is approved`,
  };
}
