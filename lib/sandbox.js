/**
 * A disposable beadcause install and tracker — the piece bc-zjab.1, bc-y3qk.1, bc-bmry.4
 * and bc-bmry.3 each built by hand, once, and then threw away.
 *
 * Every one of those sessions needed the same two things: a `BEADCAUSE_CONFIG_DIR` that
 * is not `~/.config/beadcause`, and a `bd` workspace that is not a real tracker — so that
 * running a beadcause command end to end, or learning what `bd` actually writes, never
 * risks the live install. `createSandbox` below is that pair, built once.
 *
 * **Nothing here ever writes under the real `CONFIG_DIR` or under the machine's home
 * directory at all.** Everything lives under `os.tmpdir()`, in a directory named for
 * `--name` so a second call with the same name can find and replace the first. `CONFIG_DIR`
 * is imported from lib/config.js and asserted against below — not read from, not written
 * to — purely so that promise is checked in code rather than merely stated in a comment.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { CONFIG_DIR as REAL_CONFIG_DIR } from './config.js';

/** Where every sandbox lives — one subdirectory per `--name`, never under `os.homedir()`. */
export function sandboxRoot() {
  return path.join(os.tmpdir(), 'beadcause-sandbox');
}

const BD_CANDIDATES = ['/opt/homebrew/bin/bd', '/usr/local/bin/bd', '/usr/bin/bd'];

/**
 * The real `bd`, for `--bd real` — a second, small copy of `findBd()` in lib/config.js
 * rather than an import of it, because importing that module's `defaults()` would mean
 * pulling in Tailscale probing and owner detection for one binary path. Null, not a
 * guess, when nothing is found: `--bd real` has to refuse rather than hand back the bare
 * string `'bd'` and fail two spawns later with no explanation.
 */
export function findRealBd() {
  for (const p of BD_CANDIDATES) if (fs.existsSync(p)) return p;
  const which = spawnSync('/usr/bin/which', ['bd'], { encoding: 'utf8' });
  const out = (which.stdout || '').trim();
  return which.status === 0 && out ? out : null;
}

/**
 * Guard against the one mistake this whole file exists to make impossible: a path that
 * resolves outside the sandbox, into the real config directory or the real home. Thrown
 * rather than logged — a sandbox that cannot prove this about itself must not be handed
 * back as though it were safe to run anything against.
 */
function assertContained(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t !== r && !t.startsWith(r + path.sep)) {
    throw new Error(`refusing to write outside the sandbox: ${t} is not under ${r}`);
  }
  const home = path.resolve(os.homedir());
  if (t === home || t.startsWith(home + path.sep)) {
    throw new Error(`refusing to write under the home directory: ${t}`);
  }
  if (t === path.resolve(REAL_CONFIG_DIR) || t.startsWith(`${path.resolve(REAL_CONFIG_DIR)}${path.sep}`)) {
    throw new Error(`refusing to write under the real CONFIG_DIR: ${t}`);
  }
}

/** `zz-3`, `zz-3.2`, `zz-3.2.1` — the same dotted numbering every bead in this tracker uses. */
function nextId(store, prefix, parentId) {
  if (parentId) {
    const bead = store.beads[parentId];
    if (!bead) throw new Error(`seed names parent "${parentId}", which was not created before it`);
    bead.seq = (bead.seq || 0) + 1;
    return `${parentId}.${bead.seq}`;
  }
  store.seq = (store.seq || 0) + 1;
  return `${prefix}-${store.seq}`;
}

/* ------------------------------------------------------------------- the fake `bd` */

/**
 * Enough of `bd`'s own argv shape to stand in for it — `show`, `list --parent`,
 * `comment`, `comments`, `label add`/`remove`, `update`, `dep add`/`relate`/`list`,
 * `create` and `export` — backed by one JSON file per workspace (`store.json`, inside
 * the directory that stands in for `BEADS_DIR`) rather than a database.
 *
 * Not a general model of `bd`: `export`'s JSONL is only as complete as `indexFrom` (see
 * lib/ancestry.js) needs, and a verb this does not know exits 1 rather than guessing. What
 * it does support is exactly what bin/plan.js's whole flow touches — `bd.show`,
 * `bd.children`, `bd.comment`, `bd.addLabel`, `bd.reopenAbandoned` and `bd.graph` all
 * either succeed against it or fail the way lib/bd.js already tolerates failing.
 */
const FAKE_BD_SOURCE = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.BEADS_DIR;
if (!dir) {
  process.stderr.write('fake bd: BEADS_DIR is not set\\n');
  process.exit(1);
}
const storePath = path.join(dir, 'store.json');
const load = () => JSON.parse(fs.readFileSync(storePath, 'utf8'));
const save = (s) => fs.writeFileSync(storePath, JSON.stringify(s, null, 2));

const argv = process.argv.slice(2);
// Every real call carries a trailing '--actor <who>' (lib/bd.js). Strip it before
// looking at the verb so this does not have to special-case it in every branch below.
const actorAt = argv.indexOf('--actor');
if (actorAt !== -1) argv.splice(actorAt, 2);
const args = argv.filter((a) => a !== '--json');

const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const notFound = (id) => {
  process.stderr.write(\`Error fetching \${id}: no issue found matching "\${id}"\\n\`);
  console.log(JSON.stringify({ error: 'no issues found matching the provided IDs' }));
  process.exit(1);
};
const asRow = (b) => ({
  id: b.id,
  title: b.title || '',
  status: b.status || 'open',
  issue_type: b.issue_type || 'task',
  priority: b.priority ?? 2,
  assignee: b.assignee || '',
  labels: b.labels || [],
  notes: b.notes || '',
  description: b.description || '',
  parent: b.parent || null,
  dependencies: b.parent ? [{ issue_id: b.id, depends_on_id: b.parent, type: 'parent-child' }] : [],
});

const [verb, sub] = args;

if (verb === 'show') {
  const store = load();
  const ids = args.slice(1).filter((a) => !a.startsWith('--'));
  const rows = [];
  for (const id of ids) {
    const b = store.beads[id];
    if (!b) notFound(id);
    rows.push(asRow(b));
  }
  console.log(JSON.stringify(rows));
  process.exit(0);
}

if (verb === 'list') {
  const store = load();
  const parent = flag('--parent');
  let rows = Object.values(store.beads);
  if (parent) rows = rows.filter((b) => b.parent === parent);
  rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  console.log(JSON.stringify(rows.map(asRow)));
  process.exit(0);
}

if (verb === 'comment') {
  const id = args[1];
  const text = args[2];
  const store = load();
  const b = store.beads[id];
  if (!b) notFound(id);
  b.comments = b.comments || [];
  b.comments.push({ text: text || '', at: '1970-01-01T00:00:00.000Z' });
  save(store);
  process.exit(0);
}

if (verb === 'comments') {
  const id = args[1];
  const store = load();
  const b = store.beads[id];
  if (!b) notFound(id);
  console.log(JSON.stringify(b.comments || []));
  process.exit(0);
}

if (verb === 'label' && (sub === 'add' || sub === 'remove')) {
  const id = args[2];
  const label = args[3];
  const store = load();
  const b = store.beads[id];
  if (!b) notFound(id);
  b.labels = b.labels || [];
  if (sub === 'add') {
    if (!b.labels.includes(label)) b.labels.push(label);
  } else {
    b.labels = b.labels.filter((l) => l !== label);
  }
  save(store);
  process.exit(0);
}

if (verb === 'update') {
  const id = args[1];
  const store = load();
  const b = store.beads[id];
  if (!b) notFound(id);
  const status = flag('--status');
  if (status !== undefined) b.status = status;
  const assignee = flag('--assignee');
  if (assignee !== undefined) b.assignee = assignee;
  const notes = flag('--notes');
  if (notes !== undefined) b.notes = notes;
  const append = flag('--append-notes');
  if (append !== undefined) b.notes = b.notes ? \`\${b.notes}\\n\${append}\` : append;
  save(store);
  process.exit(0);
}

if (verb === 'dep' && (sub === 'add' || sub === 'relate')) {
  const from = args[2];
  const to = args[3];
  const store = load();
  if (!store.beads[from]) notFound(from);
  if (!store.beads[to]) notFound(to);
  store.deps = store.deps || [];
  store.deps.push({ from, to, type: sub === 'relate' ? 'related' : 'depends-on' });
  save(store);
  process.exit(0);
}

if (verb === 'dep' && sub === 'list') {
  // Direction is read but unused: this fixture never needs a real answer here, only one
  // that does not throw — see the note atop this file on what relateMentions tolerates.
  console.log(JSON.stringify([]));
  process.exit(0);
}

if (verb === 'create') {
  const store = load();
  const title = flag('--title') || args[1];
  const type = flag('--type') || 'task';
  const priority = Number(flag('--priority') ?? 2);
  const parent = flag('--parent') || null;
  const description = flag('--description') || flag('-d') || '';
  const prefix = (store.prefix || 'zz');
  let id;
  if (parent) {
    const p = store.beads[parent];
    if (!p) notFound(parent);
    p.seq = (p.seq || 0) + 1;
    id = \`\${parent}.\${p.seq}\`;
  } else {
    store.seq = (store.seq || 0) + 1;
    id = \`\${prefix}-\${store.seq}\`;
  }
  store.beads[id] = { id, title, issue_type: type, priority, parent, description, status: 'open', labels: [], comments: [] };
  save(store);
  if (args.includes('--silent')) console.log(id);
  else console.log(JSON.stringify(asRow(store.beads[id])));
  process.exit(0);
}

if (verb === 'export') {
  const store = load();
  const lines = Object.values(store.beads).map((b) => JSON.stringify(asRow(b)));
  console.log(lines.join('\\n'));
  process.exit(0);
}

process.stderr.write(\`fake bd: unsupported verb "\${args.join(' ')}" — this is a sandbox stand-in, not a full model of bd\\n\`);
process.exit(1);
`;

/* --------------------------------------------------------------------------- seeding */

/**
 * `--seed <file.yaml>`: either a flat `beads:` list, applied to the sole (or first)
 * workspace, or a `workspaces: { <name>: { beads: [...] } }` map for seeding more than
 * one differently. Each bead is `{ ref?, title, type?, priority?, parent?, description? }`
 * — `ref` is a name local to the seed file, not written anywhere, so a later entry's
 * `parent:` can name an earlier one before either has a real id.
 */
function seedFor(spec, workspaceName, isSole) {
  if (!spec) return [];
  if (Array.isArray(spec.beads)) {
    if (!isSole) {
      throw new Error('a flat `beads:` seed only applies when there is one --workspace; use `workspaces: { <name>: { beads: [...] } }` for more than one');
    }
    return spec.beads;
  }
  const ws = spec.workspaces?.[workspaceName];
  return Array.isArray(ws?.beads) ? ws.beads : [];
}

function seedWorkspace({ beads, bdMode, bdBin, trackerDir }) {
  const refs = new Map();
  const seeded = [];
  const store = bdMode === 'fake' ? JSON.parse(fs.readFileSync(path.join(trackerDir, 'store.json'), 'utf8')) : null;
  for (const b of beads) {
    if (!b?.title) throw new Error(`a seed bead is missing a title: ${JSON.stringify(b)}`);
    const parentId = b.parent ? refs.get(b.parent) || b.parent : null;
    if (b.parent && !parentId) throw new Error(`seed bead "${b.title}" names parent "${b.parent}", which no earlier bead's \`ref\` matches`);
    let id;
    if (bdMode === 'real') {
      const args = ['create', '--title', b.title, '--type', b.type || 'task', '--priority', String(b.priority ?? 2), '--silent'];
      if (parentId) args.push('--parent', parentId);
      if (b.description) args.push('--description', b.description);
      const res = spawnSync(bdBin, args, {
        env: { ...process.env, BEADS_DIR: trackerDir },
        cwd: trackerDir,
        encoding: 'utf8',
        timeout: 30000,
      });
      if (res.status !== 0) {
        throw new Error(`seeding "${b.title}" failed: ${(res.stderr || res.stdout || '').trim() || `bd exited ${res.status}`}`);
      }
      id = res.stdout.trim();
    } else {
      id = nextId(store, store.prefix || 'zz', parentId);
      store.beads[id] = {
        id,
        title: b.title,
        issue_type: b.type || 'task',
        priority: b.priority ?? 2,
        parent: parentId,
        description: b.description || '',
        status: 'open',
        labels: [],
        comments: [],
      };
    }
    if (b.ref) refs.set(b.ref, id);
    seeded.push({ ref: b.ref || null, id, title: b.title });
  }
  if (store) fs.writeFileSync(path.join(trackerDir, 'store.json'), JSON.stringify(store, null, 2));
  return seeded;
}

/* ----------------------------------------------------------------------- the sandbox */

/**
 * Build one. `opts`:
 *
 *   name        slug — the sandbox lives at `sandboxRoot()/<name>` and a second call
 *               with the same name tears the first down first, unless it was `--keep`.
 *   bdMode      'fake' (default) or 'real'.
 *   workspaces  [{ name, checkoutDir? }] — at least one; `checkoutDir` pins the "session
 *               directory" a tool like resolveSessionDir would open, and defaults to an
 *               empty directory made inside the sandbox.
 *   seedPath    path to a seed YAML file, or null.
 *   keep        if true, a later call with the same `name` refuses rather than deleting.
 *
 * Returns `{ dir, configDir, bdMode, env, workspaces, seeded }` — see bin/b7e-sandbox
 * for what each field means to a caller.
 */
export function createSandbox({ name, bdMode = 'fake', workspaces, seedPath = null, keep = false }) {
  if (!name) throw new Error('a sandbox needs a --name');
  if (bdMode !== 'fake' && bdMode !== 'real') throw new Error(`--bd must be "fake" or "real", not "${bdMode}"`);
  if (!workspaces?.length) throw new Error('a sandbox needs at least one --workspace');

  const root = sandboxRoot();
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, name);
  const keepMarker = path.join(dir, '.kept-by-a-previous-run');

  if (fs.existsSync(dir)) {
    if (fs.existsSync(keepMarker)) {
      throw new Error(`sandbox "${name}" was kept by a previous run (${dir}) — remove it by hand, or pick a different --name`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assertContained(root, dir);
  fs.mkdirSync(dir, { recursive: true });

  let realBd = null;
  if (bdMode === 'real') {
    realBd = findRealBd();
    if (!realBd) throw new Error('--bd real needs `bd` on this machine and it was not found — try --bd fake instead');
    const version = spawnSync(realBd, ['version'], { encoding: 'utf8' });
    if (version.status !== 0) throw new Error(`--bd real found ${realBd} but it would not run: ${version.stderr || version.error}`);
  }

  const configDir = path.join(dir, 'config');
  assertContained(root, configDir);
  fs.mkdirSync(configDir, { recursive: true });

  const resolved = [];
  for (const w of workspaces) {
    if (!w?.name) throw new Error('every --workspace needs a name');
    const trackerDir = path.join(dir, 'workspaces', w.name, '.beads');
    assertContained(root, trackerDir);
    fs.mkdirSync(trackerDir, { recursive: true });

    let checkoutDir = w.checkoutDir || null;
    if (checkoutDir) {
      checkoutDir = path.resolve(checkoutDir);
      if (!fs.existsSync(checkoutDir)) throw new Error(`--workspace ${w.name}=${checkoutDir}: no such directory`);
    } else {
      checkoutDir = path.join(dir, 'checkouts', w.name);
      assertContained(root, checkoutDir);
      fs.mkdirSync(checkoutDir, { recursive: true });
    }

    if (bdMode === 'real') {
      const init = spawnSync(
        realBd,
        ['init', '--skip-agents', '--skip-hooks', '--non-interactive', '--prefix', 'zz'],
        { env: { ...process.env, BEADS_DIR: trackerDir }, cwd: path.dirname(trackerDir), encoding: 'utf8', timeout: 60000 }
      );
      if (init.status !== 0) {
        throw new Error(`bd init failed for workspace "${w.name}": ${(init.stderr || init.stdout || '').trim()}`);
      }
    } else {
      fs.writeFileSync(path.join(trackerDir, 'store.json'), JSON.stringify({ prefix: 'zz', seq: 0, beads: {}, deps: [] }, null, 2));
    }

    resolved.push({ name: w.name, dir: trackerDir, checkoutDir });
  }

  let bdBin;
  if (bdMode === 'real') {
    bdBin = realBd;
  } else {
    const binDir = path.join(dir, 'bin');
    assertContained(root, binDir);
    fs.mkdirSync(binDir, { recursive: true });
    bdBin = path.join(binDir, 'bd');
    fs.writeFileSync(bdBin, FAKE_BD_SOURCE);
    fs.chmodSync(bdBin, 0o755);
  }

  const seeded = [];
  if (seedPath) {
    const spec = YAML.parse(fs.readFileSync(seedPath, 'utf8'));
    for (const w of resolved) {
      const beads = seedFor(spec, w.name, resolved.length === 1);
      if (!beads.length) continue;
      const rows = seedWorkspace({ beads, bdMode, bdBin, trackerDir: w.dir });
      for (const row of rows) seeded.push({ workspace: w.name, ...row });
    }
  }

  const config = {
    bdBin,
    // `workspaceDirs` pins every sandbox workspace by name — see the note atop this
    // file. `workspaceRoots` points at a path inside the sandbox that is never created,
    // so `discoverWorkspaces()` finds nothing under it and `loadConfig()` never scans
    // this machine's real `~/beads` at all: an empty array would not do this (a missing
    // or empty `workspaceRoots` falls back to the real default, per lib/workspaceroots.js),
    // which is why this is a path rather than `[]`. `workspaces: []` matters too, and for
    // a sharper reason: `defaults()` computes its own `workspaces` field by calling
    // `discoverWorkspaces()` with no config at all, before this file is even read — so
    // without this line `loadConfig()`'s merge would start from *this machine's real
    // workspace list* every time, and `adoptHandAddedWorkspaces` would then read every
    // one of them as "not found by my roots" (true, now that `workspaceRoots` above
    // points nowhere) and pin all of them into `workspaceDirs`, permanently, in this
    // sandbox's own config file. Measured while building this: without the line, a
    // sandbox created on this Mac picked up nine unrelated real workspace paths.
    workspaces: [],
    workspaceRoots: [path.join(dir, 'no-such-root')],
    workspaceDirs: Object.fromEntries(resolved.map((w) => [w.name, w.dir])),
    sessionDirs: Object.fromEntries(resolved.map((w) => [w.name, w.checkoutDir])),
    actor: 'beadcause-sandbox',
    sharedServer: false,
  };
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));

  if (keep) fs.writeFileSync(keepMarker, 'kept — a later run of this sandbox name will refuse rather than delete it\n');

  const env = `BEADCAUSE_CONFIG_DIR=${configDir} BEADS_DIR=${resolved[0].dir}`;
  return { dir, configDir, bdMode, bdBin, env, workspaces: resolved, seeded };
}
