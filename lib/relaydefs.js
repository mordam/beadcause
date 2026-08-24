/**
 * A repo's **own** relay definition — read out of the checkout, validated hard, and
 * chosen between.
 *
 * lib/relay.js turns a definition into a chain. Until now there was exactly one place a
 * definition could come from: `cfg.relays[<workspace>]`, keyed by workspace name, living
 * in `~/.config/beadcause/config.json` on one Mac. That is the right home for a studio
 * you configured once, and the wrong home for two things it cannot express:
 *
 * - **A repo wants to version its own definition.** deluvia's departments are argued out
 *   in `docs/STUDIO_CHARTER.md` inside the repo; the code that reads them lives in a JSON
 *   file outside it, changed by hand, reviewed by nobody, and absent from every other
 *   machine. A definition in the tree is one a pull request can argue with.
 * - **One workspace, several relays.** `relayFor` takes a workspace name and returns *the*
 *   definition. sophab needs software-dev and marketing and engineering at once, which is
 *   not a bigger config entry — it is a second question, *which* relay, that nothing was
 *   ever asked.
 *
 * So a definition may now come from `.beadcause/relays.yaml` in the checkout, it holds
 * **named** relays, and this file answers both halves: what the file says (`relaysIn`)
 * and which relay a given bead runs under (`relayDefFor`).
 *
 * ## The authority line, which is why the validation is asymmetric
 *
 * `cfg` is the config on this Mac. Its keys are yours, they are unvalidated, and they
 * always will be. `.beadcause/relays.yaml` is **a branch's file** — anything that lands
 * on it can write one, including an agent — so it is validated against an allow-list, and
 * an unknown key refuses the whole file rather than being ignored. A typo'd `deparments:`
 * quietly skipped is a repo dispatching with no departments at all, which reads as
 * working. Two refusals are worth naming on their own, because both are the authority
 * line rather than tidiness:
 *
 * - **`packet:` is refused.** It is not part of a definition at all any more (see
 *   `PACKET` in lib/relay.js): the `needs-approval`/`human` pair is what makes a review
 *   packet answerable from a lock screen, and a repo that could restate it could quietly
 *   file approvals that never reach the phone.
 * - **A department key must start with `dept:`.** `departmentOf` matches *any* bead label
 *   against the department keys — there is no prefix logic anywhere — so an unprefixed
 *   repo-defined key `agent-filed` or `needs-approval` would capture every bead in the
 *   checkout carrying that label. `bd ready` already excludes `human`, `ship`,
 *   `container` and `unendorsed`; nothing else is excluded.
 *
 * ## Whole-definition replacement, and the one-typo pair
 *
 * A file that parses and validates **replaces** the `cfg` entry entirely; only an absent
 * or refused file falls through to it. Never a merge — a half-overridden department chain
 * is the silently-wrong-chain failure lib/relay.js's header argues against.
 *
 * That makes an **empty** definition meaningful, and it is the reason `relaysIn` returns
 * a `defined` flag rather than the three fields the design sketched. `relays: {}` is a
 * definition that says *no relay in this checkout* — the only off switch a repo has, and
 * the same sentence `"relays": {}` is for `cfg`. An **absent** file is the opposite
 * answer: no definition, fall through. The two are one typo apart and produce identical
 * `relays`/`default`/`problem`, so nothing but an explicit flag can tell them apart.
 *
 * ## Cost
 *
 * The advocate asks this every 30s tick, per checkout, and must not pay a parse for it.
 * So: results are cached by path and mtime, and the *ordinary* answer — a repo with no
 * `.beadcause/` at all, which is every repo today — costs a single `statSync` that fails,
 * with no read, no parse and no readdir. The directory is named, never discovered, and
 * the two filenames are named too, the same discipline `readRepoToken` (lib/repos.js)
 * keeps so that a test can assert it.
 *
 * Nothing here throws. A checkout that cannot be read is a bead dispatching exactly as it
 * does today, plus a sentence somebody can act on.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { DEPT_PREFIX, relayFor } from './relay.js';

/** The directory a repo keeps its beadcause-facing files in. Named, never discovered. */
export const RELAY_DIR = '.beadcause';

/**
 * The two names a definition may have, in order. YAML first because it is the one that
 * carries the comments a reviewer reads; `.json` accepted because the parser reads it
 * anyway and a generated file has no comments to lose.
 */
export const RELAY_FILES = ['relays.yaml', 'relays.json'];

/**
 * `relay:name`. What a bead carries to name the relay it runs under, following `repo:`
 * (lib/repos.js) and `superseded-by:` (lib/superseded.js), and for the same reason: a
 * label is the only per-bead thing beads itself carries, syncs and filters on without
 * beadcause owning a schema. Free today — nothing in lib, bin or public reads it.
 */
export const RELAY_PREFIX = 'relay:';

/** Top-level keys a repo file may state. Anything else refuses the file. */
const FILE_KEYS = new Set(['relays', 'default']);

/** Keys one named relay may state. `packet` is refused loudly rather than ignored. */
const RELAY_KEYS = new Set(['profile', 'profiles', 'docs', 'filer', 'executive', 'departments']);

/**
 * Keys one department may state. `capacity` is here because bc-ogicx.1 settled the file
 * shape with it; lib/advocate.js does not read it yet, and a key nothing reads is still
 * better than a key that refuses the file the day something does.
 */
const DEPT_KEYS = new Set(['name', 'lead', 'members', 'check', 'capacity']);

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clean = (v) => String(v ?? '').trim().toLowerCase();
const labels = (bead) => (Array.isArray(bead?.labels) ? bead.labels.map(clean).filter(Boolean) : []);

/** The absent answer: no definition here, fall through to whatever `cfg` says. */
const ABSENT = Object.freeze({ file: null, defined: false, relays: {}, default: null, problem: null });

/** A file that exists and is refused. Same fall-through, plus a sentence about why. */
const refused = (file, problem) => ({ file, defined: false, relays: {}, default: null, problem });

const cache = new Map();

/**
 * Validate one named relay. Returns a problem sentence, or '' when it is sound.
 *
 * Every message names the relay and the offending key, because the person reading it is
 * looking at a file they wrote and needs to know which line — a sentence that says only
 * "invalid" sends them back to guess.
 */
function relayProblem(name, def) {
  if (!isObj(def)) return `relay "${name}" is not a block`;
  for (const key of Object.keys(def)) {
    if (key === 'packet') {
      return `relay "${name}" states packet:, which a repo may not set — the needs-approval/human pair is what makes a review packet answerable from a lock screen, so it is beadcause's and not a branch's`;
    }
    if (!RELAY_KEYS.has(key)) return `relay "${name}" states unknown key "${key}"`;
  }
  if ('profile' in def && typeof def.profile !== 'string') return `relay "${name}" profile: is not a string`;
  if ('filer' in def && typeof def.filer !== 'string') return `relay "${name}" filer: is not a string`;
  if ('docs' in def && !(Array.isArray(def.docs) && def.docs.every((d) => typeof d === 'string'))) {
    return `relay "${name}" docs: is not a list of paths`;
  }
  if ('executive' in def && !(Array.isArray(def.executive) && def.executive.every((r) => typeof r === 'string'))) {
    return `relay "${name}" executive: is not a list of roles`;
  }
  if ('profiles' in def) {
    if (!isObj(def.profiles)) return `relay "${name}" profiles: is not a block`;
    for (const [role, at] of Object.entries(def.profiles)) {
      if (typeof at !== 'string') return `relay "${name}" profiles.${role} is not a path`;
    }
  }
  if (!isObj(def.departments) || !Object.keys(def.departments).length) {
    return `relay "${name}" declares no departments`;
  }
  for (const [key, dept] of Object.entries(def.departments)) {
    if (!key.startsWith(DEPT_PREFIX)) {
      return `relay "${name}" department "${key}" does not start with "${DEPT_PREFIX}" — a department key is matched against every label a bead carries, so an unprefixed one would capture beads that have nothing to do with it`;
    }
    if (!isObj(dept)) return `relay "${name}" department "${key}" is not a block`;
    for (const k of Object.keys(dept)) {
      if (!DEPT_KEYS.has(k)) return `relay "${name}" department "${key}" states unknown key "${k}"`;
    }
    if ('name' in dept && typeof dept.name !== 'string') return `relay "${name}" department "${key}" name: is not a string`;
    if ('lead' in dept && typeof dept.lead !== 'string') return `relay "${name}" department "${key}" lead: is not a string`;
    for (const k of ['members', 'check']) {
      if (k in dept && !(Array.isArray(dept[k]) && dept[k].every((r) => typeof r === 'string'))) {
        return `relay "${name}" department "${key}" ${k}: is not a list of roles`;
      }
    }
    if ('capacity' in dept && !(Number.isInteger(dept.capacity) && dept.capacity >= 0)) {
      return `relay "${name}" department "${key}" capacity: is not a whole number`;
    }
  }
  return '';
}

/** Validate the parsed document. Returns `{ relays, default, problem }`. */
function validate(doc) {
  // A blank file parses to null, and a blank file is still a file somebody committed:
  // it declares no relays, which is the off switch rather than an absence.
  if (doc === null || doc === undefined) return { relays: {}, default: null, problem: '' };
  if (!isObj(doc)) return { relays: {}, default: null, problem: 'is not a block' };
  for (const key of Object.keys(doc)) {
    if (!FILE_KEYS.has(key)) return { relays: {}, default: null, problem: `states unknown key "${key}"` };
  }
  const relays = doc.relays === undefined ? {} : doc.relays;
  if (!isObj(relays)) return { relays: {}, default: null, problem: 'relays: is not a block' };
  for (const [name, def] of Object.entries(relays)) {
    if (!str(name)) return { relays: {}, default: null, problem: 'names a relay with an empty name' };
    const problem = relayProblem(name, def);
    if (problem) return { relays: {}, default: null, problem };
  }
  const fallback = doc.default === undefined || doc.default === null ? '' : doc.default;
  if (typeof fallback !== 'string') return { relays: {}, default: null, problem: 'default: is not a relay name' };
  const chosen = fallback.trim();
  if (chosen && !Object.prototype.hasOwnProperty.call(relays, chosen)) {
    return { relays: {}, default: null, problem: `default: names "${chosen}", which is not a relay in this file` };
  }
  return { relays, default: chosen || null, problem: '' };
}

/**
 * What the checkout at `dir` declares:
 * `{ file, defined, relays, default, problem }`.
 *
 * `defined` is the field that matters and the one the design did not have: it is true
 * only for a file that parsed **and** validated, and it is what `relayDefFor` replaces on
 * — an empty definition and an absent file are otherwise the same three fields and the
 * opposite answers. `problem` is a sentence for a log line or a tick note; it is never a
 * hold, because a definition problem still dispatches the bead, just without a relay.
 *
 * Never throws.
 */
export function relaysIn(dir) {
  const root = str(dir);
  if (!root) return ABSENT;
  const home = path.join(root, RELAY_DIR);
  // The whole ordinary answer, in one failed syscall: no `.beadcause/`, nothing to read.
  try {
    if (!fs.statSync(home).isDirectory()) return ABSENT;
  } catch {
    return ABSENT;
  }
  for (const name of RELAY_FILES) {
    const file = path.join(home, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
    let result;
    try {
      const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      const { relays, default: fallback, problem } = validate(doc);
      result = problem
        ? refused(file, `${path.join(RELAY_DIR, name)} ${problem}`)
        : { file, defined: true, relays, default: fallback, problem: null };
    } catch (err) {
      result = refused(file, `${path.join(RELAY_DIR, name)} does not parse — ${String(err?.message || err).split('\n')[0]}`);
    }
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result });
    return result;
  }
  return ABSENT;
}

/** Forget every cached read. For suites, and for nothing else. */
export const forgetRelayDefs = () => cache.clear();

/** Every department key any of these relays declares, and which relays declared it. */
function byDepartment(relays) {
  const index = new Map();
  for (const [name, def] of Object.entries(relays)) {
    for (const key of Object.keys(def?.departments || {})) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(name);
    }
  }
  return index;
}

/** The relays whose `members` staff this role, by name. */
function byMember(relays, who) {
  if (!who) return [];
  const found = [];
  for (const [name, def] of Object.entries(relays)) {
    const staffs = Object.values(def?.departments || {}).some((dept) =>
      (Array.isArray(dept?.members) ? dept.members : []).some((r) => clean(r) === who),
    );
    if (staffs) found.push(name);
  }
  return found;
}

/**
 * The relay this bead runs under: `{ key, def, problem }`.
 *
 * **Definition precedence** — the in-repo file at `dir`, else `cfg.relays[<workspace>]`
 * wrapped as a single unnamed relay (which is exactly what it is today), else nothing.
 * Whole-definition replacement: a file that validates wins even when it declares no
 * relays at all, and only an absent or refused file falls through. A refused file falls
 * through **and says so** — `problem` carries the sentence even when the fall-through
 * then selects a relay, because a repo whose file is being ignored should hear about it.
 *
 * **Selection**, first match wins, each step a pure function of the bead and the
 * definition:
 *
 * 1. A `relay:<name>` label naming a key in `relays`.
 * 2. The bead's department label, where exactly one relay declares that key.
 * 3. The relay that staffs the assignee in `members`.
 * 4. The file's `default:`.
 * 5. Nothing — dispatch exactly as today.
 *
 * An unknown `relay:` name and a department two relays claim are **problems, not
 * fallbacks**: falling back is how marketing work quietly dispatches as engineering, and
 * a chain that ran under the wrong department is worse than one that never ran. Steps 3
 * and 4 are reached only when the bead said nothing, so they cannot overrule it.
 *
 * `key` is the relay's name, and `null` for the `cfg` wrap — a config entry has no name
 * because a workspace only ever had one. Never throws.
 */
export function relayDefFor(cfg = {}, workspaceName = '', dir = '', bead = {}) {
  const read = relaysIn(dir);
  const fileProblem = read.problem;
  const answer = (key, def, problem = null) => ({
    key,
    def: def || null,
    problem: [fileProblem, problem].filter(Boolean).join(' ') || null,
  });

  if (!read.defined) {
    // The `cfg` wrap: one unnamed relay, which is exactly what a config entry is. Every
    // selection step below would resolve to it, so there is nothing to select between and
    // the answer is today's answer, unchanged. The one exception is a bead that named a
    // relay: an unnamed one cannot be what it meant, and a silent miss here is the
    // wrong-department dispatch this whole selection rule exists to refuse.
    const entry = relayFor(cfg, workspaceName);
    if (!entry) return answer(null, null);
    const asked = labels(bead).find((l) => l.startsWith(RELAY_PREFIX));
    if (asked) {
      return answer(null, null, `bead names ${asked}, and ${workspaceName || 'this workspace'} has only the unnamed relay in your config`);
    }
    return answer(null, entry);
  }

  const relays = read.relays;
  const fallbackName = read.default;
  const names = Object.keys(relays);
  if (!names.length) return answer(null, null);

  // 1. `relay:<name>`.
  const named = labels(bead).find((l) => l.startsWith(RELAY_PREFIX));
  if (named) {
    const want = named.slice(RELAY_PREFIX.length);
    const hit = names.find((n) => n.toLowerCase() === want);
    if (!hit) return answer(null, null, `bead names ${named}, and no relay in ${RELAY_DIR}/ is called "${want}" (${names.join(', ')})`);
    return answer(hit, relays[hit]);
  }

  // 2. A department label. The key *is* the label — see departmentOf in lib/relay.js.
  const departments = byDepartment(relays);
  for (const label of labels(bead)) {
    const claimed = departments.get(label);
    if (!claimed) continue;
    if (claimed.length > 1) return answer(null, null, `department "${label}" is declared by ${claimed.length} relays (${claimed.join(', ')}), so nothing can say which one this bead runs under`);
    return answer(claimed[0], relays[claimed[0]]);
  }

  // 3. The relay that staffs the assignee.
  const staffed = byMember(relays, clean(bead?.assignee));
  if (staffed.length > 1) return answer(null, null, `"${clean(bead?.assignee)}" is staffed by ${staffed.length} relays (${staffed.join(', ')}), so nothing can say which one this bead runs under`);
  if (staffed.length === 1) return answer(staffed[0], relays[staffed[0]]);

  // 4. The file's default, then 5. nothing.
  if (fallbackName && Object.prototype.hasOwnProperty.call(relays, fallbackName)) {
    return answer(fallbackName, relays[fallbackName]);
  }
  return answer(null, null);
}
