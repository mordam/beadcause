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
 * And since bc-ogicx.6 it answers a third thing, which is the first one that changes what
 * *dispatches* rather than what a window is briefed with: **how many windows a department
 * may hold at once** (`deptCapacityFor`, `departmentsFor`, `withinCapacity`). That lives
 * here rather than in lib/advocate.js on purpose — the ceiling is declared in the file this
 * module reads, the cost discipline the read depends on is this module's, and what lands in
 * the advocate is one filter and one line on the card.
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

import { DEPT_PREFIX, chainIn, relayFor, rolesOf } from './relay.js';

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
 * Keys one department may state. `capacity` is read by `deptCapacityFor` at the bottom of
 * this file, and it is deliberately a **department's** key and nothing above it: a
 * relay-level capacity would be a second spelling of `advocates.perWorkspace.<ws>.maxWorkers`,
 * which is Adam's switch, and an unknown key here refuses the whole file rather than being
 * quietly ignored.
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
  // `relays:` with nothing under it parses to null, and a person who wrote that meant the
  // same thing as `relays: {}` — the off switch — rather than a broken file.
  const relays = doc.relays === undefined || doc.relays === null ? {} : doc.relays;
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

/**
 * **Every role any relay of this workspace knows**, across every checkout it has:
 * `{ roles, problems }`.
 *
 * The question `relayDefFor` cannot answer, and the reason it cannot is the point of
 * bc-ogicx.7. A definition is selected per *bead*, out of a *checkout* — and bin/relaystep.js
 * is handed a workspace, a role and a step, with no bead and no checkout in sight. Under
 * named relays it therefore has no way to know which relay's role list a `--role` belongs
 * to, so it checks against all of them at once.
 *
 * **The union is deliberately wider than any one relay, and that is the correct trade.**
 * What this list is for is catching `--role clip` for `clio` — a typo, written into a trail
 * where it reads as an agent nobody has heard of. It is not for enforcing routing: a role
 * that is real in the marketing relay and typed against an engineering bead is a *routing*
 * mistake, and bin/relaystep.js already declines to police routing for exactly this reason
 * (its own header — it does not check step *order* either, because the chain is derived
 * from an assignee `bd update --claim` has already overwritten). A narrower list here would
 * refuse real roles on a rule this command cannot evaluate, which is the worse failure of
 * the two: a refused step is a trail entry that never gets written at all.
 *
 * **Precedence is per checkout**, the same rule `relayDefFor` applies: a checkout with a
 * definition contributes its relays' roles, a checkout with none contributes `cfg`'s
 * unnamed relay, and so does the case with no checkouts to ask. So a workspace where
 * nothing on disk defines anything — which is every workspace today — gets exactly
 * `rolesOf(relayFor(cfg, ws))`, the list this command has always checked against.
 *
 * `problems` carries a sentence per checkout whose file was refused. It is not a refusal
 * here either: a refused file falls through to `cfg`, which *narrows* the list, and a role
 * turned down because a file two directories away would not parse is the one refusal that
 * would read as a bug in this command rather than in that file. Never throws.
 */
export function rolesAcross(cfg = {}, workspaceName = '', dirs = []) {
  const roles = new Set();
  const problems = [];
  const add = (def) => {
    for (const role of rolesOf(def)) roles.add(role);
  };

  let fellThrough = false;
  for (const dir of dirs) {
    const read = relaysIn(dir);
    if (read.problem) problems.push(read.problem);
    if (!read.defined) {
      fellThrough = true;
      continue;
    }
    for (const def of Object.values(read.relays)) add(def);
  }

  if (fellThrough || !dirs.length) {
    const entry = relayFor(cfg, workspaceName);
    if (entry) add(entry);
  }
  return { roles, problems };
}

/**
 * **How many windows one department may hold at once** — `{ dept, capacity, problem }`
 * for one queued bead, read out of the checkout it would be worked in.
 *
 * The first thing in this family that changes what *dispatches* rather than what a window
 * is briefed with. Everything above answers "which relay is this bead under"; this answers
 * "and is that department already full", which is a question the advocate asks before it
 * picks, not after.
 *
 * ## A department may declare it. A relay may not.
 *
 * `capacity: N` is a key of a **department** and of nothing else — `DEPT_KEYS` has said so
 * since bc-ogicx.1, and `relayProblem` above refuses anything that is not a whole number ≥
 * 0. A relay-level capacity was deliberately never added, because it is a second spelling
 * of `advocates.perWorkspace.<ws>.maxWorkers`: that number is **yours**, it lives in the
 * config on this Mac, and two switches for one limit is the failure this whole family
 * objects to everywhere else — a repo turning its own dispatch up would be an authority
 * escalation, and a repo turning it down twice is a number nobody can find.
 *
 * **A capacity can only ever subtract**, and that sentence is the whole reason a branch is
 * allowed to write one at all. It is counted against windows the advocate was going to
 * open anyway, *inside* `maxWorkers` and inside `globalMaxWorkers`; nothing here can raise
 * either. `capacity: 4` on a workspace running two windows buys the department nothing.
 * That is what makes it safe in a file a pull request can change.
 *
 * ## The department is `chainIn`'s, and it has to be
 *
 * Not `departmentOf` directly, which would answer for a bead whose assignee is a person
 * and whose only claim on the department is a `dept:` label. A window on such a bead runs
 * with no relay at all — `openWorkSession` resolves the chain the same way, and a null
 * chain is a window that carries no department to be counted against. Holding a bead
 * against a ceiling its own window could never occupy is a cap that subtracts for ever, so
 * both sides of the count ask the same function and get the same answer.
 *
 * `null` capacity is the ordinary answer and means *no ceiling*: no definition, no relay,
 * an executive role, a department that states no `capacity:`. `problem` is passed straight
 * through from `relayDefFor` — a refused file has no departments to cap with, and it is
 * still never a hold.
 */
export function deptCapacityFor(cfg = {}, workspaceName = '', dir = '', bead = {}) {
  const { def, problem } = relayDefFor(cfg, workspaceName, dir, bead);
  const chain = chainIn(def, workspaceName, bead);
  if (!chain) return { dept: null, capacity: null, problem };
  const stated = def?.departments?.[chain.dept]?.capacity;
  return {
    dept: chain.dept,
    capacity: Number.isInteger(stated) && stated >= 0 ? stated : null,
    problem: problem || null,
  };
}

/**
 * The same question asked of a **whole queue at once** — `{ seen, problems }`.
 *
 * `rows` is one entry per queued bead: `{ id, dir, assignee, labels }`, where `dir` is the
 * checkout that bead would be worked in. Back comes `seen`, one `{ id, dept, capacity }`
 * per row in the order handed in, and `problems`, one sentence per *checkout* whose
 * definition would not load — keyed by the sentence rather than by the bead, because a
 * broken file is a fact about a directory and forty beads in that directory are not forty
 * problems. The first bead that hit each one is kept, so whoever reads it has somewhere to
 * start looking.
 *
 * ## Why this is a list function and not a loop the caller writes
 *
 * The cost. The advocate asks this on every tick, for every ready bead, up to four times a
 * tick as it re-surveys — and the ordinary answer for every workspace that exists today is
 * *no relay anywhere*. Answered one bead at a time that is one failed `statSync` per bead
 * per pass, several hundred a minute, to reach a conclusion that was settled by the first
 * one. So the read is memoised per directory for the length of the call, and a bead in a
 * checkout that defines nothing — with no `cfg` entry for the workspace either — is
 * answered without the definition being consulted a second time.
 *
 * That discipline is this module's from the beginning (see `relaysIn`: the directory is
 * named, never discovered, and the ordinary answer is one syscall) and it belongs here
 * rather than in the caller for the reason the whole of this file does: the caller would
 * have to know what makes a read cheap in order to avoid making it expensive.
 *
 * Never throws. A row with no `dir` is answered from `cfg` alone, which is what a scratch
 * tracker with no checkout on disk gets.
 */
export function departmentsFor(cfg = {}, workspaceName = '', rows = []) {
  const problems = new Map();
  const reads = new Map();
  const readOf = (dir) => {
    if (!reads.has(dir)) reads.set(dir, relaysIn(dir));
    return reads.get(dir);
  };
  // Asked once for the whole call rather than once per bead: a `cfg` entry is keyed by
  // workspace name, so it is the same answer for every row here by construction.
  const fromCfg = Boolean(relayFor(cfg, workspaceName));
  const seen = rows.map((row) => {
    const dir = str(row?.dir);
    const read = dir ? readOf(dir) : ABSENT;
    if (read.problem && !problems.has(read.problem)) {
      problems.set(read.problem, { why: read.problem, id: row?.id || '', dir });
    }
    // The whole ordinary answer, and the one that has to stay free: nothing in this
    // checkout defines a relay and nothing in the config does either, so there is no
    // department to be in and no ceiling to be under. A refused file lands here too — it
    // falls through to `cfg`, exactly as `relayDefFor` says, and the sentence above is
    // already carrying what went wrong.
    if (!read.defined && !fromCfg) return { id: row?.id || '', dept: null, capacity: null };
    const { dept, capacity } = deptCapacityFor(cfg, workspaceName, dir, {
      assignee: row?.assignee || '',
      labels: Array.isArray(row?.labels) ? row.labels : [],
    });
    return { id: row?.id || '', dept, capacity };
  });
  return { seen, problems: [...problems.values()] };
}

/**
 * The rule itself: **which of these beads this tick may open a window on**, given what is
 * already open — `{ kept, held }`.
 *
 * `rows` is the candidate list *in pick order*, each `{ id, dept, capacity }` as
 * `deptCapacityFor` answered for it; `open` is one department key (or null) per window this
 * advocate already has running. Pure, so the rule can be argued with in a test without a
 * tracker, a checkout or an iTerm — which matters more here than usual, because the thing
 * that goes wrong with a cap is arithmetic and not plumbing.
 *
 * **Two populations are counted, not one, and the second is the half that is easy to
 * miss.** A tick does not open one window: it opens `min(free, globalFree, ready.length)`
 * of them, straight down this list. So a department at `capacity: 1` with nothing running
 * would launch three windows in one tick and be over its ceiling before the next tick could
 * see it. Every row this function *keeps* therefore counts against the ceiling too, which
 * is the only reading of "capacity" that holds within the tick as well as across it.
 *
 * The cost of that is deliberate and worth naming: a bead can be held behind a same-tick
 * sibling that then does not launch, because the worker limit ran out first. It comes back
 * on the next tick with nothing to release, exactly as `heldBySurface` does — and the
 * alternative, counting only live windows, is a ceiling that binds on quiet ticks and not
 * on busy ones, which is the opposite of what a ceiling is for. The `why` says which of the
 * two is holding it, so the card never claims a department is busy when what is really
 * ahead of the bead is a sibling in the same tick.
 *
 * A row with no department, or a department that states no `capacity:`, is kept and counts
 * against nothing. That is every bead in every workspace today.
 */
export function withinCapacity(rows = [], { open = [] } = {}) {
  const kept = [];
  const held = [];
  const running = new Map();
  const queued = new Map();
  for (const dept of open) {
    if (dept) running.set(dept, (running.get(dept) || 0) + 1);
  }
  for (const row of rows) {
    const dept = row?.dept || null;
    const cap = Number.isInteger(row?.capacity) && row.capacity >= 0 ? row.capacity : null;
    if (!dept || cap === null) {
      kept.push(row);
      continue;
    }
    const live = running.get(dept) || 0;
    const ahead = queued.get(dept) || 0;
    if (live + ahead < cap) {
      queued.set(dept, ahead + 1);
      kept.push(row);
      continue;
    }
    held.push({ id: row.id, dept, capacity: cap, open: live, tick: ahead, why: capacityWhy(dept, cap, live, ahead) });
  }
  return { kept, held };
}

/**
 * The sentence on the card, and the one thing it must never do is say "busy" over a
 * department that is not. Three states, because they clear in three different ways: a
 * department switched off in the file, one whose windows are running, and one whose place
 * was taken by a higher-priority bead a few lines above it in this same tick.
 */
function capacityWhy(dept, cap, live, ahead) {
  const at = `${dept} declares capacity: ${cap}`;
  if (!cap) {
    return `${at}, which is that department switched off — nothing will open a window on it until the definition in the checkout says otherwise. A capacity only ever subtracts, so this is the file's own doing and not a limit of yours.`;
  }
  if (live && ahead) {
    return `${at}, and it is full — ${live} window(s) open and ${ahead} more being opened by this same tick, ahead of this bead in pick order. It comes back on the next tick with nothing to release.`;
  }
  if (live) {
    return `${at}, and ${live} window(s) in it are already open. It comes back as soon as one of them ends; a capacity only ever subtracts from maxWorkers, never adds to it.`;
  }
  return `${at}, and this same tick is already opening ${ahead} window(s) in it on higher-priority beads. Nothing is holding it but pick order — it comes back on the next tick with nothing to release.`;
}
