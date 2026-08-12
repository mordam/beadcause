/**
 * The second engineer's install — one profile in the repo, and a tracker that is not empty.
 *
 * lib/sync.js made a tracker two Macs can share. This is the half that gets a *second*
 * Mac to the point where sharing means anything, and the reason it needs its own file is
 * that almost everything the installer asks is the wrong question for the second person
 * onward. `npm run install-service` was written for somebody setting up their own laptop:
 * it discovers `~/beads/*`, asks which of the workspaces it found are shared, and writes
 * the answers into `~/.config/beadcause/config.json`. Run that on a machine that has
 * just cloned the repo and every one of those steps quietly does nothing useful —
 *
 * - **the workspace does not exist.** `~/beads/<name>/.beads` is made once, by hand, on
 *   the first engineer's Mac. `discoverWorkspaces()` readdirs `~/beads` and finds
 *   nothing, `npm run configure` prints "No beads workspaces found" and exits 0, and the
 *   daemon comes up perfectly, serving an empty inbox. Nothing is broken and nothing
 *   works.
 * - **a plain `git clone` fetches no beads.** Dolt data rides `refs/dolt/data`, which git
 *   does not pull by default, so even with the workspace in place the tracker is empty
 *   until somebody runs `bd bootstrap` — a command nothing in the install story has ever
 *   mentioned, in a session six weeks later, after the empty screen has been explained
 *   away twice.
 * - **the questions are answered from scratch, differently, by each person.** The one
 *   that matters is *which workspaces are shared*: it drives `autoDispatchExclude` and
 *   `ntfy.minimalWorkspaces`, and on a graph the whole team reads, an unattended agent
 *   commenting is visible to everyone — "a different bar than talking to yourself", as
 *   lib/config.js puts it. Left to a question, it is right on the machines where somebody
 *   read the question carefully.
 *
 * ## `team.json`, committed, and deliberately small
 *
 * So the shared half of the answer stops being a question and becomes a file in the repo
 * the team already clones. It names the trackers — a workspace, a directory, and the Dolt
 * remote it rides — and the policy that has to be the same everywhere. Everyone's install
 * reads the same one; changing it is a pull request rather than six conversations.
 *
 * The interesting design constraint is what it may **not** contain, and it is enforced
 * rather than documented: `owner`, `me`, the token, the ntfy topic, `baseUrl`, `port`,
 * `assetRoots`, `projectRoot`, `advocates`. Those are already per-machine and already
 * correct — `detectOwner()` guesses each engineer's own name from their git identity,
 * the token and topic are generated per install — and a profile that carried them would
 * be a file that quietly makes six Macs claim to be the same person. A key that is not on
 * the allowlist is a **refusal, not an ignored line**, because a setting silently dropped
 * from a committed file is a policy the whole team believes it has.
 *
 * Where the line sits: a key is team policy only if getting it different on two machines
 * changes how the *shared graph* behaves. That is why `sync.seconds` is on the list — the
 * collision window is only as narrow as the slowest machine's — and why `autoDispatch` is
 * not, even though it looks like the obvious candidate. The shared workspace is excluded
 * from auto-dispatch by being shared; the global flag governs the engineer's *own* private
 * workspaces, which is nobody else's business.
 *
 * ## It never invents a remote, and it never merges two histories
 *
 * lib/sync.js refuses to add a Dolt remote, because where a tracker is published is a
 * decision that cannot be taken back. Nothing here weakens that. A remote in `team.json`
 * is not a daemon guessing: it is the team's decision, written down, reviewed in a pull
 * request, and applied only when a person runs the installer — and the direction on a
 * fresh machine is a clone, which reads. What is refused instead is the *other* way of
 * getting this wrong, which is the expensive one:
 *
 * **A local database already sitting where the team's tracker goes is a refusal.** Not a
 * merge, not a bootstrap, not a "probably fine". `bd bootstrap` will not clone over a
 * database that exists — measured, it stops with `can't create database beads; database
 * exists` — so the team's history never arrives, and the first `bd dolt pull` of the sync
 * tick meets two unrelated histories instead. That is the one outcome lib/sync.js says
 * never retries its way out: a conflict, on every tick, for as long as it stands.
 * The order — bootstrap *before* the workspace has ever been written to — is the whole
 * difference, and it is not recoverable by hand in a hurry, so it is worth stopping the
 * install over.
 *
 * Everything here is pure: `readTeam` reads one file, and the rest turns a profile plus
 * what was *observed* about a workspace into a config patch or a list of steps. The steps
 * are data — `mkdir`, `write`, `bd` — so scripts/onboard.mjs owns every side effect and
 * test/team.mjs can assert on the plan for all six states without a `bd` on PATH.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { expandHome } from './repos.js';
import { tildeHome } from './reposcan.js';

const HOME = os.homedir();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** In the repo, not in `~/.config`: the point is that it is the same file for everyone. */
export const TEAM_FILE = 'team.json';
export const teamPath = (root = REPO_ROOT) => path.join(root, TEAM_FILE);

/**
 * Which profile a run actually reads.
 *
 * `BEADCAUSE_TEAM_FILE` overrides the committed one, which is what makes the onboarding
 * runnable against a profile that has not been committed yet — try the file before six
 * people clone it — and what lets a suite drive the real script against a real local
 * remote. Read at call time rather than at module load, so a test can set it after
 * importing.
 */
export const activeTeamPath = () => process.env.BEADCAUSE_TEAM_FILE || teamPath();

/**
 * The only keys `policy` may carry, and what each one is for.
 *
 * Dotted, because these are paths into the config rather than top-level fields, and the
 * patch is applied one path at a time so a profile can set `sync.seconds` without
 * flattening `sync.enabled` beside it.
 */
export const POLICY_KEYS = {
  'sync.seconds':
    'how often each machine pulls and pushes the shared tracker — the width of the window in which two Macs can act on stale information, so it is only as narrow as the slowest machine sets it',
};

/**
 * Keys a profile may never carry, and the sentence said when one does.
 *
 * Not a blanket "unknown key" message: each of these is a plausible thing to reach for,
 * and the useful refusal says why the machine already has a better answer than the file
 * does. Anything else unknown gets the generic refusal, which lists this allowlist.
 */
export const PER_MACHINE = {
  owner: 'what the agents call you is per person, and `npm run configure` guesses it from your git identity',
  me: "who this Mac's person is in the tracker is the one thing that must differ per machine — see \"Who a question is for\"",
  token: 'the shared token is generated per install and pairing it is per phone; a token in a committed file is a token in the repo history',
  ntfy: 'the ntfy topic is generated per install, and a topic six Macs share is six phones buzzing for one question',
  baseUrl: "the origin is this Mac's tailnet name, maintained by the daemon itself",
  port: "the port is this Mac's, and the daemon reconciles it with what it can bind",
  host: "the addresses bound are this Mac's loopback and Tailscale IP",
  assetRoots: 'where your code lives is per machine; `npm run configure` asks',
  projectRoot: 'whether your shell derives BEADS_DIR from the working directory is a property of your shell',
  advocates:
    "how many unattended sessions may open on this Mac spends this Mac's tokens and opens windows on this Mac's screen",
  auth: 'the Google client secret and the allowlist are credentials, and credentials never live in a committed file',
  slack: 'the Slack tokens are credentials, and the channel is asked once by `npm run configure`',
};

/**
 * Read and validate the profile. `exists: false` is the ordinary answer, not an error —
 * a solo install has no team, and everything downstream must behave exactly as it did.
 *
 * `problems` is a list of sentences, and any entry means the profile is unusable: a
 * half-applied team policy is worse than none, because the half that applied makes the
 * install look configured.
 */
export function readTeam(file = activeTeamPath()) {
  if (!fs.existsSync(file)) return { path: file, exists: false, profile: null, problems: [] };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      path: file,
      exists: true,
      profile: null,
      problems: [`${tildeHome(file)} could not be read: ${err.message}`],
    };
  }
  return { path: file, exists: true, ...parseTeam(raw, file) };
}

/** The half of `readTeam` that is pure, so a suite can hand it text. */
export function parseTeam(raw, file = teamPath()) {
  const where = tildeHome(file);
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    return { profile: null, problems: [`${where} is not valid JSON: ${err.message}`] };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { profile: null, problems: [`${where} must be a JSON object`] };
  }

  const problems = [];

  // `note` earns its place because JSON has no comments, and a file the whole team edits
  // with nowhere to say why is a file that accumulates changes nobody can date.
  for (const key of Object.keys(obj)) {
    if (['trackers', 'policy', 'note'].includes(key)) continue;
    problems.push(
      PER_MACHINE[key]
        ? `${where}: "${key}" is per machine and may not be set for the team — ${PER_MACHINE[key]}.`
        : `${where}: "${key}" is not something a team profile may set. It may set "trackers", "policy" and "note".`
    );
  }

  const trackers = [];
  const rawTrackers = obj.trackers === undefined ? [] : obj.trackers;
  if (!Array.isArray(rawTrackers)) {
    problems.push(`${where}: "trackers" must be an array.`);
  } else {
    for (const [i, entry] of rawTrackers.entries()) {
      const at = `${where}: trackers[${i}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`${at} must be an object with a "workspace" and a "remote".`);
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (!['workspace', 'dir', 'remote', 'shared'].includes(key)) {
          problems.push(
            `${at}: "${key}" is not a tracker field. A tracker has "workspace", "remote", and optionally "dir" and "shared".`
          );
        }
      }
      const workspace = String(entry.workspace || '').trim();
      const remote = String(entry.remote || '').trim();
      if (!workspace) {
        problems.push(
          `${at} has no "workspace" — the name the tracker is known by, and the directory under ~/beads unless "dir" says otherwise.`
        );
      }
      if (!remote) {
        problems.push(
          `${at} has no "remote" — a tracker with no Dolt remote is a private one, and there would be nothing for a second machine to bootstrap from.`
        );
      } else if (!/^[a-z+]+:\/\//i.test(remote)) {
        // Loose on purpose: the shapes that work are `git+ssh://`, `https://` and
        // whatever Dolt grows next, and a stricter rule here would refuse a working
        // remote on the day bd learns another one. What is worth catching is the
        // scp-style `git@host:org/repo` that looks right and is not a URL.
        problems.push(`${at}: "${remote}" is not a URL — Dolt remotes look like git+ssh://git@github.com/<org>/<repo>.git.`);
      }
      // Shared by default, and that is this file's point rather than a convenience: a
      // tracker with a remote is by definition one somebody else reads, so treating it
      // carefully must not depend on anybody having answered a question about it.
      const shared = entry.shared === undefined ? true : Boolean(entry.shared);
      if (workspace && remote) {
        trackers.push({
          workspace,
          dir: entry.dir ? expandHome(entry.dir) : path.join(HOME, 'beads', workspace),
          remote,
          shared,
        });
      }
    }
    const seen = new Set();
    for (const t of trackers) {
      if (seen.has(t.workspace)) problems.push(`${where}: "${t.workspace}" is named by two trackers.`);
      seen.add(t.workspace);
    }
  }

  const policy = {};
  const rawPolicy = obj.policy === undefined ? {} : obj.policy;
  if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
    problems.push(`${where}: "policy" must be a JSON object.`);
  } else {
    for (const [dotted, value] of Object.entries(flatten(rawPolicy))) {
      if (POLICY_KEYS[dotted]) {
        policy[dotted] = value;
        continue;
      }
      const top = dotted.split('.')[0];
      problems.push(
        PER_MACHINE[top]
          ? `${where}: policy.${dotted} is per machine and may not be set for the team — ${PER_MACHINE[top]}.`
          : `${where}: policy.${dotted} is not team policy. The keys a profile may set are ${Object.keys(POLICY_KEYS).join(
              ', '
            )} — a setting belongs here only if having it different on two machines changes how the shared graph behaves.`
      );
    }
  }
  if (typeof policy['sync.seconds'] !== 'undefined' && !(Number(policy['sync.seconds']) > 0)) {
    problems.push(`${where}: policy.sync.seconds must be a positive number of seconds.`);
    delete policy['sync.seconds'];
  }

  if (!trackers.length && !problems.length) {
    problems.push(
      `${where} names no trackers, so there is nothing for a second machine to install against. Remove the file, or name one.`
    );
  }

  return {
    profile: problems.length ? null : { trackers, policy, note: obj.note ? String(obj.note) : null },
    problems,
  };
}

/** `{a: {b: 1}}` → `{'a.b': 1}`. Arrays and nulls are leaves. */
function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

/**
 * What the profile changes about this machine's config, and nothing else.
 *
 * Returned as a patch plus a list of sentences rather than applied, so the caller can
 * print what it is about to do and a suite can assert that a second run does nothing.
 * Additive throughout: a workspace already in `autoDispatchExclude` is left there, and a
 * name the engineer added themselves is never removed. Being *more* careful than the
 * profile asks is always safe; being less never is.
 */
export function configPatch(profile, cfg = {}) {
  const patch = {};
  const changes = [];
  const shared = (profile?.trackers || []).filter((t) => t.shared).map((t) => t.workspace);

  /** The list with `name` in it, or null when it was already there. */
  const addTo = (list, name) => {
    const next = [...new Set([...(list || []), name])];
    return next.length === (list || []).length ? null : next;
  };

  for (const name of shared) {
    const excl = addTo(patch.autoDispatchExclude || cfg.autoDispatchExclude, name);
    if (excl) {
      patch.autoDispatchExclude = excl;
      changes.push(`${name}: no unattended agent will comment on it (autoDispatchExclude)`);
    }
    const minimal = addTo(patch.ntfy?.minimalWorkspaces || cfg.ntfy?.minimalWorkspaces, name);
    if (minimal) {
      patch.ntfy = { ...(cfg.ntfy || {}), ...(patch.ntfy || {}), minimalWorkspaces: minimal };
      changes.push(`${name}: its questions push a contentless nudge rather than the text (ntfy.minimalWorkspaces)`);
    }
    // Per workspace rather than the global flag, because it is the shared tracker that
    // must keep holding beads for a tap — a private repo where the tap is a formality
    // can still say yes for itself.
    const per = { ...(cfg.autoEndorsePerWorkspace || {}), ...(patch.autoEndorsePerWorkspace || {}) };
    if (per[name] !== false) {
      per[name] = false;
      patch.autoEndorsePerWorkspace = per;
      changes.push(`${name}: beads an agent files itself wait for a tap (autoEndorsePerWorkspace)`);
    }
  }

  for (const [dotted, value] of Object.entries(profile?.policy || {})) {
    // The allowlist again, having already been applied by `parseTeam`, and deliberately
    // not trusted from here: this is the function that writes to the config, and the cost
    // of one path reaching it that the validator did not see is a machine that claims to
    // be somebody else. A second check on a list of one key is cheap.
    if (!POLICY_KEYS[dotted]) continue;
    const [top, key] = dotted.split('.');
    const current = key ? cfg[top]?.[key] : cfg[top];
    if (current === value) continue;
    if (key) patch[top] = { ...(cfg[top] || {}), ...(patch[top] || {}), [key]: value };
    else patch[top] = value;
    changes.push(`${dotted}: ${JSON.stringify(current)} → ${JSON.stringify(value)}`);
  }

  return { patch, changes };
}

/* --------------------------------------------------------- the workspace itself */

/** Where the `sync.remote` in a `.beads/config.yaml` points, or null. */
export function readSyncRemote(text) {
  try {
    const doc = YAML.parse(String(text || ''));
    const remote = doc?.sync?.remote;
    return remote ? String(remote).trim() : null;
  } catch {
    return null;
  }
}

/**
 * The same file with `sync.remote` set — comments and all.
 *
 * `parseDocument` rather than `parse`, because the file this is usually applied to is
 * bd's stock template: sixty lines of commented-out settings that are the only
 * documentation of what else can go in there. Measured against the `yaml` package
 * already in package.json: an all-comments document parses to `contents: null`, `setIn`
 * appends the block, and every comment survives.
 *
 * `null` when a *different* remote is already named — the caller's move is to refuse,
 * not to overwrite. Rewriting that line points a tracker somebody else set up at
 * somewhere else, and the first push is what discovers it.
 */
export function withSyncRemote(text, remote) {
  const current = readSyncRemote(text);
  if (current && !sameRemote(current, remote)) return null;
  if (current) return String(text);
  const doc = YAML.parseDocument(String(text || ''));
  doc.setIn(['sync', 'remote'], remote);
  return doc.toString();
}

/**
 * What a tracker looks like on this machine — six states, from what was observed.
 *
 * `observed` is deliberately dumb data (`{ beadsExists, configRemote, hasDb, remote,
 * issues }`) rather than a directory to go and read, because the classification is the
 * part worth testing and every one of these states is a nuisance to produce for real.
 *
 *   `absent`    — nothing there yet. The ordinary second-engineer case.
 *   `declared`  — the remote is written down but there is no database: a fresh clone, or
 *                 a bootstrap that failed. Bootstrapping again is the fix either way.
 *   `ready`     — a database, wired to the remote the profile names. Nothing to do.
 *   `empty`     — the same, with no beads in it. Not an error and not fixable from here:
 *                 either the remote genuinely has none yet, or somebody's `bd dolt push`
 *                 has not happened.
 *   `unwired`   — a local database with no remote, sitting where the team's tracker goes.
 *   `elsewhere` — a local database wired to a different remote.
 *
 * The last two are refusals rather than repairs, and that is the whole point of the file:
 * `bd bootstrap` will not clone over an existing database, so "fixing" either one means
 * asking `bd dolt pull` to merge two unrelated histories — the conflict lib/sync.js says
 * nothing has ever retried its way out of.
 */
export function trackerState(tracker, observed = {}) {
  const { beadsExists = false, configRemote = null, hasDb = false, remote = null, issues = null } = observed;
  const wired = remote?.url || configRemote || null;
  if (hasDb) {
    if (!wired) return 'unwired';
    if (!sameRemote(wired, tracker.remote)) return 'elsewhere';
    return issues === 0 ? 'empty' : 'ready';
  }
  if (beadsExists && configRemote) return sameRemote(configRemote, tracker.remote) ? 'declared' : 'elsewhere';
  return 'absent';
}

/**
 * Two spellings of the same Dolt remote.
 *
 * A trailing `.git`, a trailing slash and the case of the host are all noise that would
 * otherwise read as "this machine points somewhere else" and stop an install that is
 * perfectly correct. The path is left case-sensitive, because on GitHub it is.
 */
export function sameRemote(a, b) {
  const norm = (s) =>
    String(s || '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .replace(/^([a-z+]+:\/\/)([^/]+)/i, (_, scheme, host) => `${scheme.toLowerCase()}${host.toLowerCase()}`);
  return Boolean(a) && Boolean(b) && norm(a) === norm(b);
}

/**
 * What to do about one tracker: the steps, in order, and the refusal if there is one.
 *
 * Steps are data, and there are three kinds — `mkdir`, `write` and `bd`. Nothing here
 * deletes or moves anything, which is not a coincidence: every state whose repair would
 * need that is a refusal instead.
 */
export function trackerPlan(tracker, observed = {}) {
  const state = trackerState(tracker, observed);
  const beadsDir = path.join(tracker.dir, '.beads');
  const configFile = path.join(beadsDir, 'config.yaml');
  const bootstrap = {
    kind: 'bd',
    what: `bd bootstrap — clone ${tracker.workspace}'s beads from ${tracker.remote}`,
    argv: ['bootstrap', '--yes'],
    cwd: tracker.dir,
    beadsDir,
  };

  switch (state) {
    case 'absent':
      return {
        state,
        steps: [
          { kind: 'mkdir', what: `create ${tildeHome(beadsDir)}`, path: beadsDir, mode: 0o700 },
          {
            kind: 'write',
            what: `name the remote in ${tildeHome(configFile)}`,
            path: configFile,
            remote: tracker.remote,
          },
          bootstrap,
        ],
        refusal: null,
      };
    case 'declared':
      return { state, steps: [bootstrap], refusal: null };
    case 'ready':
    case 'empty':
      return { state, steps: [], refusal: null };
    case 'unwired':
      return {
        state,
        steps: [],
        refusal:
          `${tracker.workspace} already has beads of its own at ${tildeHome(beadsDir)}, with no Dolt remote` +
          `${typeof observed.issues === 'number' ? ` and ${observed.issues} in it` : ''}. That is a private tracker ` +
          `sitting where the team's goes, and it cannot become the team's one from here: \`bd bootstrap\` will not clone ` +
          `over a database that exists, so the first \`bd dolt pull\` would be asked to merge two unrelated histories — ` +
          `a conflict that never resolves itself. Move it aside and onboard into the empty space ` +
          `(\`mv ${tildeHome(beadsDir)} ${tildeHome(beadsDir)}.local\`, then \`npm run onboard\`), or give the team's ` +
          `tracker a \`dir\` of its own in team.json.`,
      };
    case 'elsewhere':
      return {
        state,
        steps: [],
        refusal:
          `${tracker.workspace} is already wired to ${observed.remote?.url || observed.configRemote}, and team.json ` +
          `names ${tracker.remote}. Nothing here rewrites that: pointing a tracker somebody else set up at a different ` +
          `repo is a mistake discovered by its first push. Fix whichever of the two is wrong.`,
      };
    default:
      return { state, steps: [], refusal: `${tracker.workspace}: unknown state ${state}` };
  }
}

/** How a state reads on the installer's own output. */
export function describeState(state, tracker) {
  switch (state) {
    case 'absent':
      return `${tracker.workspace}: not on this Mac yet — it will be cloned from ${tracker.remote}`;
    case 'declared':
      return `${tracker.workspace}: the remote is written down but there are no beads yet — bootstrapping`;
    case 'ready':
      return `${tracker.workspace}: in place, wired to ${tracker.remote}`;
    case 'empty':
      return `${tracker.workspace}: in place and wired, and the tracker has no beads in it yet — that is the remote's state rather than a failed install`;
    case 'unwired':
      return `${tracker.workspace}: a private tracker is in the way`;
    case 'elsewhere':
      return `${tracker.workspace}: wired to a different remote`;
    default:
      return `${tracker.workspace}: ${state}`;
  }
}
