/**
 * Department relays — the bead's **assignee** names a studio role, and one window carries
 * the work through that role's whole check chain instead of stopping after the first one.
 *
 * Every other dispatcher in this file's neighbourhood answers the question *which window
 * opens on this bead*. This one answers a question none of them could: **who is the agent
 * in that window**. deluvia has nineteen named agents in `docs/STUDIO_CHARTER.md`, five
 * producing departments, and a six-step loop in §6 of that document that every deliverable
 * runs — brief, draft, check, file, rule, count. None of it was read by any code. The
 * advocate opened one generic session per ready bead and the roles existed only as prose
 * an agent might happen to read.
 *
 * `dv-vzg` asked whether such a relay should run unattended or stop for a card after each
 * role, and the answer was **(a) full relay** — *"Full Relay, but all the steps and
 * handoffs are recorded in the bead for me to view/access in the EpicCards"*. So one
 * launch carries a deliverable from draft to review packet, and the trail it writes is the
 * mitigation for the cost that carries (a bad early choice propagating through three more
 * roles before anybody sees it). The trail is `bc-bmry.4`; this file is the dispatch.
 *
 * ## What a chain is, and why it is not a list somebody typed
 *
 * §6 of the charter is a *shape*, not five hand-written orderings: **the drafting agent,
 * then the department's checks, then the drafting agent again to answer what the checks
 * raised, then the filer.** clio on fact always; muse or lens on craft; palette on look
 * for anything visual. So a department is stated here as its members and its checks, and
 * the chain is derived — which means a department that gains a checker gains it in every
 * chain at once, and a chain can never disagree with the table above it.
 *
 * Three consequences worth naming, because each is a decision:
 *
 * - **The revise step exists only when something checked.** A department with no checkers
 *   would otherwise get a chain that hands the bead back to the agent that just drafted
 *   it, for nothing.
 * - **A checker that is also the drafting role does not check itself.** aria drafting a
 *   Story bead is checked by clio and muse; clio drafting one is checked by muse alone,
 *   and is still the last word on fact, which is the charter's rule 1 and not something
 *   this file gets to restate.
 * - **Executive is not a department and gets no relay.** vox, tally and ward produce
 *   process, not reviewable deliverables (charter §3), so a bead assigned to one of them
 *   dispatches as an ordinary worker. That is the difference between a role this file
 *   knows and a role it will relay.
 *
 * ## Why the assignee, and what happens when the claim eats it
 *
 * The assignee is the only field on a bead that already means *who is meant to do this*,
 * it is on `bd ready --json` rows at no cost, and `APPROVAL_PIPELINE.md` already uses it
 * that way by hand. It has one flaw: `bd update --claim` overwrites it with the claiming
 * identity, so the role is destroyed by the first thing the window does.
 *
 * That is survivable rather than fatal, because the chain is resolved **at launch**, out
 * of the `bd show` row `openWorkSession` has already paid for, before any window exists to
 * claim anything. Deliberately *not* off the advocate's queue row, where `batch`, `group`
 * and `filesBusy` ride: those three are decisions the advocate made about one launch and
 * have nowhere on the bead to live, where a relay is a fact about the bead — the same
 * distinction lib/session.js already draws to explain why the identity comes off `row` and
 * the decorations off the caller's object. Resolving it off `row` also means every door
 * into `openWorkSession` gets it, not only the tick that happened to survey first.
 *
 * What the claim costs is the *second* window: a relay that ran out of room and handed the
 * bead back has no assignee left to say where it stopped. So the brief tells a session that
 * stops mid-chain to hand back with the role it stopped at —
 * `bd update <id> --status open --assignee <role>` — which is the existing hand-back idiom
 * with the one word that makes it resumable. Nothing else has to be persisted, and a relay
 * is recomputed from the assignee every launch rather than remembered between them.
 *
 * ## Why this is config and not a parse of the charter
 *
 * The charter is a document that argues. Its department table is markdown, its hierarchy
 * is mermaid, and its §6 loop is a numbered list with the rules in the prose beside it —
 * all of which a parser can read today and misread the moment somebody rewrites a
 * sentence, silently, into a chain with a step missing. A relay that quietly drops the
 * fact-check is worse than one that never ran. So the chain is stated once, in a form
 * that cannot be misread, and the charter stays the human document it is.
 *
 * `relays` is keyed by **workspace name**, which is what makes the shipped `deluvia` entry
 * harmless: an install with no such workspace never consults it, and one that has it gets
 * the studio wired without pasting JSON. Set `"relays": {}` to turn the whole mechanism
 * off; there is no other switch, because a relay nothing is assigned to costs nothing.
 */

/** `relays`, or an empty map. */
export const relayOptions = (cfg = {}) => (cfg && typeof cfg.relays === 'object' && cfg.relays) || {};

/** The relay definition for a workspace, or null where there is none. */
export function relayFor(cfg = {}, workspaceName = '') {
  const name = String(workspaceName || '').trim();
  if (!name) return null;
  const def = relayOptions(cfg)[name];
  if (!def || typeof def !== 'object') return null;
  const departments = def.departments && typeof def.departments === 'object' ? def.departments : null;
  if (!departments || !Object.keys(departments).length) return null;
  return def;
}

const clean = (v) => String(v ?? '').trim().toLowerCase();
const list = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

/**
 * Every role the definition knows — producing members, checkers named by a department that
 * does not staff them (clio checks Design and is a Story member), the leads, the filer and
 * the executive. Used to decide whether an assignee is a *role at all*, which is the gate
 * on the whole mechanism: an assignee that is a person's name or an email address must
 * leave the bead exactly as it was.
 */
export function rolesOf(def) {
  const roles = new Set();
  for (const dept of Object.values(def?.departments || {})) {
    for (const r of list(dept?.members)) roles.add(r);
    for (const r of list(dept?.check)) roles.add(r);
    const lead = clean(dept?.lead);
    if (lead) roles.add(lead);
  }
  for (const r of list(def?.executive)) roles.add(r);
  const filer = clean(def?.filer);
  if (filer) roles.add(filer);
  return roles;
}

/** The role a bead names, or '' — the assignee, lowercased, when the definition knows it. */
export function roleOf(def, bead = {}) {
  const who = clean(bead?.assignee);
  if (!who) return '';
  return rolesOf(def).has(who) ? who : '';
}

/**
 * Which department a bead belongs to.
 *
 * The bead's own `dept:` label wins where it has one, because that is the routing label
 * `APPROVAL_PIPELINE.md` defines and the thing a human actually set. Failing that, the
 * department that *staffs* this role — `members`, not `check`, so clio checking a Design
 * deliverable is still a Story agent and a Design bead assigned to clio is still Design.
 * Null when neither answers, which is every executive role and every unstaffed one.
 */
export function departmentOf(def, bead = {}, role = '') {
  const departments = def?.departments || {};
  const labelled = list(bead?.labels).find((l) => Object.prototype.hasOwnProperty.call(departments, l));
  if (labelled) return { key: labelled, dept: departments[labelled] };
  const who = clean(role);
  if (!who) return null;
  for (const [key, dept] of Object.entries(departments)) {
    if (list(dept?.members).includes(who)) return { key, dept };
  }
  return null;
}

/**
 * The relay this bead would run, or null.
 *
 * Null is the ordinary answer and means *dispatch this bead exactly as before*: no relay
 * config for the workspace, an assignee that is not a role, a role with no department, or
 * an executive role. Every one of those has to leave the brief unchanged to a character,
 * because they are all of deluvia and all four other workspaces.
 */
export function chainFor(cfg = {}, workspaceName = '', bead = {}) {
  const def = relayFor(cfg, workspaceName);
  if (!def) return null;
  const role = roleOf(def, bead);
  if (!role) return null;
  if (list(def.executive).includes(role)) return null;
  const found = departmentOf(def, bead, role);
  if (!found) return null;
  const { key, dept } = found;
  // The charter's §6 loop, derived rather than typed: draft, check, revise, file. A
  // checker that is the drafting role is dropped — an agent does not check its own draft,
  // and the step it would occupy is the revise step it already gets.
  const checks = list(dept?.check).filter((r) => r !== role);
  const filer = clean(def.filer);
  const steps = [{ role, step: 'draft' }];
  for (const r of checks) steps.push({ role: r, step: 'check' });
  if (checks.length) steps.push({ role, step: 'revise' });
  if (filer) steps.push({ role: filer, step: 'file' });
  return {
    workspace: String(workspaceName || ''),
    dept: key,
    department: String(dept?.name || key),
    lead: clean(dept?.lead) || null,
    role,
    filer: filer || null,
    steps,
    packet: list(def.packet),
    profile: String(def.profile || ''),
    docs: (Array.isArray(def.docs) ? def.docs : []).map((d) => String(d || '').trim()).filter(Boolean),
  };
}

/**
 * Where a role's standing profile lives, relative to the checkout — `profile` with
 * `{role}` filled in. '' when the definition names no profile path, which is legal: a
 * relay with no profiles is still a relay, it just has nothing extra to read.
 */
export function profilePath(relay, role) {
  const tpl = String(relay?.profile || '');
  const who = clean(role);
  if (!tpl || !who) return '';
  return tpl.replaceAll('{role}', who);
}

/** `aria → clio → muse → aria → ward`, for a log line and the card that has room for one. */
export const chainLine = (relay) => (relay?.steps || []).map((s) => s.role).join(' → ');
