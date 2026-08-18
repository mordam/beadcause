/**
 * Carrying a promotion bead — one leg per repo, four steps each, and a close that is earned.
 *
 * lib/promote.js **files** the bead: one per epic, the moment every bead the epic's plan
 * named has closed, and its own header says outright that "the release agent that will work
 * it does not exist yet". This is the half of that agent which does not care what the
 * pipeline is. It picks a promotion bead up, claims it the way every other agent here claims
 * work, drives four calls per repo, writes on the bead what was deployed and what was
 * checked, and closes it only when every repo it names has been verified in production.
 *
 * ## The driver, and why it is an interface rather than Azure
 *
 * Four calls, always in this order, and none of them knows what is behind it:
 *
 * | call | what it must answer |
 * |---|---|
 * | `deployToUat`  | the UAT deploy happened, **and the image it deployed** |
 * | `testInUat`    | the release was exercised in UAT, and by which checks |
 * | `promoteToProd`| that *same* image is in production — promoted, never rebuilt |
 * | `testInProd`   | the release was exercised in production, and by which checks |
 *
 * bc-y8k4.3 supplies the real one against Climative's Azure DevOps. Everything here is
 * testable against a fake with no network and no pipeline, which is the whole reason the two
 * halves were split: every acceptance clause on bc-y8k4 except "identify the exact image"
 * and "test against something the release actually contains" is expressible against this
 * interface, and both of those are the driver's to keep.
 *
 * ## Three states, and the third one is the point
 *
 * `passed`, `failed`, and *cannot say* — the same three lib/release.js settles a ship bead
 * on, for the same reason. **Cannot-say neither closes nor promotes.** A driver that throws
 * is cannot-say and not failure: an exception on the way out of `deployToUat` means nobody
 * knows whether the deploy happened, and treating that as "it failed" is as much an
 * invention as treating it as "it worked".
 *
 * Two of the three states are read out of the driver's answer rather than taken from it, and
 * both are the epic's own argument turned into code:
 *
 * - **A test step that passes without naming a single check is cannot-say.** bc-y8k4 says it
 *   plainly — "a green deploy of the previous image looks identical from outside" — so a
 *   `testInUat` that answers `passed` and cannot say what it exercised has not distinguished
 *   this release from the last one. That is the failure the whole bead exists to prevent,
 *   and it is indistinguishable from success unless it is refused here.
 * - **The checks outrank the step's own verdict.** A step that says `passed` over a failed
 *   check is failed, and over an unknown one is unknown. A driver reporting a summary that
 *   disagrees with its own rows is a driver whose summary cannot be trusted, and the
 *   conservative reading is the only safe direction: over-claiming here closes a bead over a
 *   release nobody verified.
 *
 * ## The same image, and what happens when it is not
 *
 * `deployToUat` names the image; `promoteToProd` is *given* that name and must come back
 * having promoted it. A production step that answers with a different digest is a **failed**
 * step and not a cannot-say, because it is not ignorance — it is a positive answer that the
 * thing in production is not the thing that was tested. A deploy that passes but names no
 * image at all is cannot-say instead: nothing can promote what it cannot name.
 *
 * ## More than one repo — three images, and a result that may be partial (bc-y8k4.4)
 *
 * An epic spanning three repos is three images with three UAT runs and three production
 * runs, and they may not all pass. This used to be refused by name. It is now carried as
 * **one leg per repo on one bead**, which needs three things that a single-repo run did not:
 *
 * - **A per-repo outcome, written where the next run can read it.** Every run appends a
 *   ledger to its own comment (`RUN_OPEN`), and the next run starts from the union of every
 *   ledger on the bead. So a repo verified in production is *not driven again* — it is not
 *   re-deployed, not re-tested and not re-promoted — and the run that failed on the third
 *   repo has not thrown away the two that passed. Only `verified: true` skips a repo; a
 *   garbled entry, a missing ledger, a `bd` that cannot list comments all mean "do it
 *   again", which costs a repeat and never a close over a repo nobody promoted.
 * - **A close that waits for all of them.** `done` is every repo verified, so two of three
 *   leaves the bead open with the third named on the card — the bead can be partial without
 *   the board lying, which is what it could not do before.
 * - **UAT for everything before production for anything.** The four steps stay in order
 *   within a repo, but they are driven in two passes across repos: every owed repo is
 *   deployed to UAT and tested there, and production is entered only if *all* of them got
 *   through. Learning that the third repo is red after the first is already in production
 *   leaves a feature half-shipped in the environment customers are on, and UAT is the cheap
 *   place to find out. A repo held back this way says so on the record rather than reading
 *   as untried. (One repo makes the two passes indistinguishable from the old four calls,
 *   which is why the single-repo record and return shape are unchanged.)
 *
 * A partial result can still happen in production — the second repo's `promoteToProd` can
 * fail after the first repo's has been verified — and that is exactly the state the ledger
 * is for. It is not designed away; it is written down.
 *
 * ## What is written, and where
 *
 * One comment per run, on the bead, whatever the outcome — every repo, its image, its steps,
 * its checks, what is still owed, and the sentence saying where it stopped. Not only in a
 * log: a promotion is read weeks later by whoever asks what was released, and the daemon log
 * has rolled by then. A run that ends anywhere but a verified production result for every
 * repo hands the bead back unclaimed, so the next run can pick it up; an `in_progress` bead
 * nobody holds is invisible to every queue here forever.
 *
 * ## The hold is not routed around
 *
 * A promotion bead is filed `unendorsed` and the hold means what it says here too: nothing
 * picks one up and nothing carries one until Adam has looked at it. See `isEndorsed`.
 */

import { UNENDORSED } from './endorse.js';
import { PROMOTE_LABEL, landedWork } from './promote.js';

export { PROMOTE_LABEL };

/** The release was exercised and it worked. */
export const PASSED = 'passed';
/** It was exercised and it did not. */
export const FAILED = 'failed';
/** Nobody knows — and this one neither closes nor promotes, ever. */
export const UNKNOWN = 'unknown';

/** The three, in the order they are argued about. */
export const STATES = [PASSED, FAILED, UNKNOWN];

/**
 * The four calls, in the one order they may be made.
 *
 * `verb` is what the step *is*, and it is load-bearing rather than decorative: a `test` step
 * is the one that must name its checks, and a `deploy` step is the one that must name its
 * image. See `readStep`.
 *
 * `env` is load-bearing too, and it is what the two passes are cut along: everything in
 * `uat` for every repo, then — only if all of that passed — everything in `production`.
 */
export const STEPS = Object.freeze([
  Object.freeze({ id: 'deploy-uat', call: 'deployToUat', env: 'uat', verb: 'deploy', says: 'UAT deploy' }),
  Object.freeze({ id: 'test-uat', call: 'testInUat', env: 'uat', verb: 'test', says: 'UAT tests' }),
  Object.freeze({ id: 'promote-prod', call: 'promoteToProd', env: 'production', verb: 'promote', says: 'production promote' }),
  Object.freeze({ id: 'test-prod', call: 'testInProd', env: 'production', verb: 'test', says: 'production tests' }),
]);

/** The first pass: what happens to every repo before anything happens to production. */
export const UAT_STEPS = STEPS.filter((s) => s.env === 'uat');
/** And the second, which is only reached when every owed repo got through the first. */
export const PROD_STEPS = STEPS.filter((s) => s.env === 'production');

const labelsOf = (row) => (row?.labels || []).map((l) => String(l).trim());

/** Is this bead one a release agent may carry? Takes a `bd --json` row. */
export const isPromotionBead = (row) => labelsOf(row).includes(PROMOTE_LABEL);

/**
 * Has anybody agreed this promotion should happen?
 *
 * `filePromotion` files every promotion bead `unendorsed`, and says why in as many words:
 * nothing should act on one until Adam has looked at it. That hold is the *only* thing
 * standing between an unattended sweep and a production deploy, so it is enforced in the two
 * layers lib/shipbead.js and lib/endorse.js are both built from — a filter in `openPromotions`
 * so an unendorsed bead is never picked up, and a refusal in `carry` so one handed straight to
 * it is still not carried. The filter is what keeps the refusal from being reached; the
 * refusal is the guarantee, because a filter is one caller away from being routed around.
 */
export const isEndorsed = (row) => !labelsOf(row).includes(UNENDORSED);

/**
 * The epic a promotion bead promotes, from its title.
 *
 * `title()` in lib/promote.js writes `Promote <epic> — <epic title>`, so the id is in a fixed
 * place. A bead whose title somebody rewrote yields nothing rather than a guess: the id is
 * what the test list is derived from, and deriving it for the wrong epic is a promotion that
 * exercises another feature's work and passes.
 */
export function epicOf(row) {
  const found = /^Promote\s+(\S+)\s+—/.exec(String(row?.title || ''));
  return found ? found[1] : '';
}

/**
 * The repos a promotion bead covers, from the line `body()` writes for exactly this reader.
 *
 * The plan is the only thing that knows which repos an epic's work landed in, and it is long
 * gone by the time anybody promotes — so the filed body is the record, and this is the parse
 * of it. Read out of the body rather than re-derived because the body is what a human is
 * looking at when they ask what a run covered.
 *
 * De-duplicated, because two groups of a plan landing in the same repo is the ordinary shape
 * and one image is one image: a repo named twice would otherwise be deployed twice and, far
 * worse, counted twice in what is still owed.
 */
export function reposOf(row) {
  const line = /^\*\*Repos\*\*[^:\n]*:\s*(.+)$/m.exec(String(row?.description || row?.body || ''));
  if (!line) return [];
  return [...new Set([...line[1].matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean))];
}

/** One of the three, from whatever a driver felt like answering with. Never a guess. */
export function stateOf(raw) {
  if (raw === true) return PASSED;
  if (raw === false) return FAILED;
  const said = String(raw?.state ?? '').trim().toLowerCase();
  if (STATES.includes(said)) return said;
  if (raw?.ok === true) return PASSED;
  if (raw?.ok === false) return FAILED;
  return UNKNOWN;
}

const first = (err) => String(err?.message || err || '').split('\n')[0];
const text = (value) => String(value ?? '').trim();

/** A driver's checks, normalised — a name and one of the three, or it is not a check. */
export function checksOf(raw) {
  const rows = Array.isArray(raw?.checks) ? raw.checks : [];
  return rows
    .map((c) => ({ name: text(c?.name || c?.id), state: stateOf(c), detail: text(c?.detail) }))
    .filter((c) => c.name);
}

/**
 * What a driver's answer to one step actually means — the reading, not the report.
 *
 * Everything the module refuses to take at face value happens here, so there is one place to
 * read when a run stopped somewhere a driver said it should not have.
 */
export function readStep(step, raw, { image = '' } = {}) {
  const checks = checksOf(raw);
  const detail = text(raw?.detail || raw?.reason);
  const said = stateOf(raw);
  const answered = text(raw?.image);
  const out = { id: step.id, env: step.env, verb: step.verb, says: step.says, state: said, detail, checks, image: answered };

  // The checks outrank the summary, in the conservative direction only: a step cannot talk
  // its way *up* from a failed check, and an unknown one leaves the whole step unknown.
  if (checks.some((c) => c.state === FAILED)) {
    out.state = FAILED;
    if (said !== FAILED) out.detail = [detail, `the step reported ${said} over a failed check`].filter(Boolean).join(' — ');
    return out;
  }
  if (out.state === PASSED && checks.some((c) => c.state === UNKNOWN)) {
    out.state = UNKNOWN;
    out.detail = [detail, 'the step reported passed over a check nothing could say'].filter(Boolean).join(' — ');
    return out;
  }
  if (out.state !== PASSED) return out;

  if (step.verb === 'test' && !checks.length) {
    out.state = UNKNOWN;
    out.detail = [detail, 'passed without naming a single check, so nothing here distinguishes this release from the last one'].filter(Boolean).join(' — ');
    return out;
  }
  if (step.verb === 'deploy' && !answered) {
    out.state = UNKNOWN;
    out.detail = [detail, 'deployed without naming an image, and nothing can promote what it cannot name'].filter(Boolean).join(' — ');
    return out;
  }
  if (step.verb === 'promote' && answered && image && answered !== image) {
    // Not cannot-say. This is a positive answer that what is in production is not what was
    // tested in UAT, which is the one thing the whole four-step order exists to prevent.
    out.state = FAILED;
    out.detail = [detail, `production was given \`${image}\` and came back with \`${answered}\` — a promotion is the same image or it is a rebuild`].filter(Boolean).join(' — ');
  }
  return out;
}

/**
 * A driver missing one of the four is refused before anything is claimed.
 *
 * `status: 501` and a named boolean, matching the refusal shape lib/shipbead.js and
 * lib/endorse.js use: a caller can tell a driver that was never wired from a run that failed.
 * Refused up front rather than at the third call, because by then a bead is claimed, an image
 * is in UAT, and the half-finished state is on the tracker.
 */
export function assertDriver(driver) {
  const missing = STEPS.filter((s) => typeof driver?.[s.call] !== 'function').map((s) => s.call);
  if (missing.length) {
    throw Object.assign(new Error(`this driver cannot carry a promotion — it has no ${missing.join(', no ')}`), {
      status: 501,
      driver: true,
    });
  }
  return driver;
}

/** Promotion beads nobody has closed — what a release agent picks up from. */
export async function openPromotions(bd, workspace) {
  if (typeof bd?.listLabel !== 'function') return [];
  const rows = (await bd.listLabel(workspace, PROMOTE_LABEL)) || [];
  return rows.filter((r) => r && String(r.status || '').toLowerCase() !== 'closed' && isEndorsed(r));
}

/* ------------------------------------------------------- the per-repo ledger (bc-y8k4.4) */

/**
 * The markers the per-repo ledger sits between, inside the run comment that carries it.
 *
 * In a **comment** rather than in `notes`, and lib/plan.js is the precedent: a comment is
 * append-only, so a run can never destroy what an earlier run wrote, and the machine-readable
 * state sits inside the very prose a human reads about that run rather than in a second place
 * that can disagree with it. The alternative — a marked block in `notes` — is a whole-field
 * rewrite every time, and lib/mergebead.js's `withBlock` exists because of what that does to
 * a block whose closing marker has gone missing.
 *
 * The JSON goes **inside** the comment rather than in a fenced block between two of them, so
 * it does not draw on the card. See `runBlock`.
 */
export const RUN_OPEN = '<!-- beadcause:promotion';
export const RUN_CLOSE = '/beadcause:promotion -->';

/**
 * Read a ledger out of a comment body, or null.
 *
 * Tolerant about what surrounds the block and strict about the block itself: unparseable
 * JSON between the markers is null rather than a throw. A comment somebody hand-edited must
 * not be able to stop a release agent, and — because only `verified: true` skips a repo — the
 * cost of not understanding one is a repo carried again, which is the safe direction.
 */
export function parseRun(body) {
  const src = String(body ?? '');
  const from = src.indexOf(RUN_OPEN);
  if (from === -1) return null;
  const to = src.indexOf(RUN_CLOSE, from);
  const inner = to === -1 ? src.slice(from + RUN_OPEN.length) : src.slice(from + RUN_OPEN.length, to);
  const json = inner.replace(/^\s*```(?:json)?/, '').replace(/```\s*$/, '').trim();
  if (!json) return null;
  let ledger;
  try {
    ledger = JSON.parse(json);
  } catch {
    return null;
  }
  if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.repos)) return null;
  return ledger;
}

/**
 * Every repo outcome a bead's comments carry — `Map(repo → row)`, latest write per repo.
 *
 * **Merged across every comment, per repo, rather than taken from the last one**, which is
 * where this differs from `planFrom` and the difference is deliberate. A plan is revised as a
 * whole and the newest one is the plan; a promotion run reports the repos it knew about, and
 * a later run that named fewer of them — the Repos line edited, a ledger half written — must
 * not be able to erase the record that a repo *is* in production. Later still wins for a repo
 * both mention, so a re-run's verdict replaces an older one.
 *
 * `bd comments` returns oldest first, which is the order this relies on.
 */
export function ledgerFrom(comments) {
  const found = new Map();
  for (const c of comments || []) {
    const ledger = parseRun(c?.text ?? c?.body ?? c?.comment ?? '');
    for (const row of ledger?.repos || []) {
      const repo = text(row?.repo);
      if (!repo) continue;
      found.set(repo, {
        repo,
        // Only an explicit `true` is a repo nothing needs to do again. Anything else — a
        // missing field, a string, an older ledger written by something that did not have
        // this field — is "carry it", and a repeat costs a deploy where the other direction
        // costs a bead closed over a repo nobody promoted.
        verified: row?.verified === true,
        state: STATES.includes(text(row?.state)) ? text(row.state) : UNKNOWN,
        image: text(row?.image),
        at: text(row?.at),
        detail: text(row?.detail),
      });
    }
  }
  return found;
}

/**
 * What earlier runs got done, off the bead itself — an empty ledger when nothing can say.
 *
 * A `bd` with no `comments` (a fake in a suite, an older shim) and a tracker that throws are
 * the same answer here, and it is the safe one: every repo is carried again. The unsafe
 * direction — treating silence as "already verified" — would close the bead over a repo that
 * has never been near production.
 */
export async function priorRuns(bd, workspace, id) {
  if (typeof bd?.comments !== 'function') return new Map();
  try {
    return ledgerFrom(await bd.comments(workspace, id));
  } catch {
    return new Map();
  }
}

/** The ledger this run leaves behind — one row per repo, and the block it is written in. */
export function runBlock(run) {
  const rows = run.legs.map((leg) => {
    const stopped = leg.steps[leg.steps.length - 1];
    const bad = (stopped?.checks || []).filter((c) => c.state !== PASSED);
    return {
      repo: leg.repo,
      // The repo's own state, which is verified-in-production or not — never the last step's.
      // A repo whose UAT passed and whose production was held back is `passed` on its last
      // step and emphatically not verified, and writing that as verified would skip it for
      // good on the next run.
      verified: leg.verified === true,
      state: leg.verified ? PASSED : leg.state,
      image: leg.image || '',
      at: leg.at || run.at,
      // The step's own words where it had any, and the checks it stopped on where it did
      // not — a row saying `failed` and nothing else is a row nobody can act on.
      detail: leg.held || stopped?.detail || bad.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join(', '),
    };
  });
  // A repo the body no longer names but an earlier run did promote. The Repos line is prose
  // and prose gets edited; forgetting a promotion that happened is the one thing this ledger
  // exists to prevent, so it is carried forward rather than dropped.
  for (const [repo, was] of run.carried || []) if (!run.legs.some((l) => l.repo === repo)) rows.push({ ...was, repo });
  // Inside the HTML comment rather than in a fenced block beside it, which is the one place
  // this differs from lib/plan.js's block: a plan is written for a person to read and the
  // JSON is the same thing said precisely, where this is bookkeeping that says nothing the
  // prose above it has not already said in words. A promotion bead accumulates one of these
  // per run, and three runs of thirty lines of JSON on a phone is the card being less legible
  // for having recorded more — which is the opposite of what bc-y8k4.4 asks for.
  //
  // `-->` inside a driver's own words would end the comment early, so it is escaped as the
  // `>` JSON already has for exactly this — lossless, and `JSON.parse` gives it back.
  const json = JSON.stringify({ bead: run.bead, epic: run.epic, at: run.at, repos: rows }, null, 2).replaceAll('-->', '--\\u003e');
  return [RUN_OPEN, json, RUN_CLOSE].join('\n');
}

/* ------------------------------------------------------------------------- the record */

const stateWord = (s) => (s === UNKNOWN ? 'cannot say' : s);

const stepLines = (leg) => {
  const lines = [];
  for (const s of leg.steps) {
    const checks = s.checks.length
      ? ` — ${s.checks.map((c) => `\`${c.name}\` ${stateWord(c.state)}${c.detail ? ` (${c.detail})` : ''}`).join(', ')}`
      : '';
    lines.push(`- **${s.says}** — ${stateWord(s.state)}${s.detail ? ` (${s.detail})` : ''}${checks}`);
  }
  for (const s of STEPS.slice(leg.steps.length)) {
    lines.push(`- **${s.says}** — ${leg.held ? `held back — ${leg.held}` : 'not reached'}`);
  }
  return lines;
};

/** Where one repo got to, in a clause — the half of `verdict` that is per-leg. */
function legVerdict(leg) {
  if (leg.already) return `already verified in production${leg.image ? ` — \`${leg.image}\`` : ''}, by an earlier run`;
  if (leg.verified) return `promoted and verified in production${leg.image ? ` — \`${leg.image}\`` : ''}`;
  const stopped = leg.steps[leg.steps.length - 1];
  if (!stopped) return leg.held ? `held back in UAT — ${leg.held}` : 'nothing ran';
  if (leg.held) return `got through UAT and was held back — ${leg.held}`;
  const bad = stopped.checks.filter((c) => c.state !== PASSED);
  const on = bad.length ? ` on ${bad.map((c) => `\`${c.name}\``).join(', ')}` : '';
  const what = stopped.state === FAILED ? 'failed' : 'could not be settled';
  return `stopped in **${stopped.env}**: the ${stopped.says} ${what}${on}`;
}

/**
 * What goes on the bead — the whole run, whatever it did, in one comment.
 *
 * Written for somebody reading the card in three weeks asking what was released and what was
 * checked. Every step that ran gets a line whether it passed or not, because a run that
 * stopped in UAT is exactly the one whose record matters, and every check is named because
 * "it was tested" is the claim this file exists to stop anybody making without evidence.
 *
 * One repo renders exactly as it always did. More than one grows a block per repo and, below
 * them, the line that is the whole of bc-y8k4.4 from a phone: which repos are done and which
 * are still owed.
 */
export function record(run) {
  const many = run.legs.length > 1;
  const lines = [
    `**Promotion run** — ${run.at} · ${many ? `${run.legs.length} repos: ${run.legs.map((l) => `\`${l.repo}\``).join(', ')}` : `\`${run.legs[0]?.repo || ''}\``}`,
  ];
  lines.push('');
  for (const leg of run.legs) {
    if (many) {
      lines.push(`**\`${leg.repo}\`** — ${legVerdict(leg)}`);
      lines.push('');
    }
    if (leg.already) {
      // Nothing was driven, and saying "not reached" four times over a repo that is in
      // production would read as a run that skipped it rather than one that respected it.
      lines.push(`- **Image** — ${leg.image ? `\`${leg.image}\`` : '_none named_'}`);
      lines.push(`- **All four steps** — done by an earlier run${leg.at ? ` (${leg.at})` : ''}, so nothing was driven again`);
    } else {
      lines.push(`- **Image** — ${leg.image ? `\`${leg.image}\`` : '_none named_'}`);
      lines.push(...stepLines(leg));
    }
    lines.push('');
  }
  if (run.work.length) {
    lines.push(`**What it was carrying** (${run.work.length} closed under \`${run.epic}\`): ${run.work.map((b) => `\`${b.id}\``).join(', ')}`);
    lines.push('');
  }
  if (run.open.length) {
    // bc-4bet.2's defect, showing up in the one place somebody is still in a position to
    // stop a release over it. It does not stop the run — the image is main's build and is
    // right for what did land — but what it costs is the completeness of the list above.
    lines.push(`**Still open under \`${run.epic}\`** (${run.open.length}), so this promotion is not all of it: ${run.open.map((b) => `\`${b.id}\``).join(', ')}`);
    lines.push('');
  }
  const owed = run.legs.filter((l) => !l.verified);
  if (many && owed.length) {
    lines.push(
      `**Still owed** (${owed.length} of ${run.legs.length}): ${owed.map((l) => `\`${l.repo}\` — ${legVerdict(l)}`).join('; ')}.`
    );
    lines.push('');
  }
  lines.push(run.closed ? verdict(run) : `${verdict(run)} Not closed: a promotion bead closes when every repo it names has a verified production result, and nothing else.`);
  lines.push('');
  lines.push(runBlock(run));
  return lines.join('\n');
}

/** The one sentence: where it got to, and — when it stopped — in which environment and on what. */
export function verdict(run) {
  const legs = run.legs || [];
  const many = legs.length > 1;
  if (run.closed) {
    return many
      ? `All ${legs.length} repos are promoted and verified in production, so ${run.bead} is closed.`
      : `Production is verified, so ${run.bead} is closed.`;
  }
  if (!many) {
    const leg = legs[0];
    if (!leg || (!leg.steps.length && !leg.already)) return 'Nothing ran.';
    const said = legVerdict(leg);
    const sentence = `${said.charAt(0).toUpperCase()}${said.slice(1)}.`;
    return leg.steps[leg.steps.length - 1]?.state === UNKNOWN
      ? `${sentence} Cannot-say neither closes nor promotes.`
      : sentence;
  }
  const done = legs.filter((l) => l.verified);
  const owed = legs.filter((l) => !l.verified);
  const kept = done.length
    ? ` ${done.map((l) => `\`${l.repo}\``).join(', ')} ${done.length === 1 ? 'is' : 'are'} promoted and ${done.length === 1 ? 'stays' : 'stay'} that way.`
    : '';
  return `${done.length} of ${legs.length} repos are verified in production.${kept} Still owed: ${owed.map((l) => `\`${l.repo}\``).join(', ')}.`;
}

const refused = (why) => ({ refused: why, bead: '', legs: [], steps: [], state: UNKNOWN, closed: false, promoted: false });

/** Drive one repo through the steps it is owed, stopping at the first that is not a pass. */
async function drive(driver, leg, steps, ctx) {
  for (const step of steps) {
    let answer;
    try {
      answer = await driver[step.call]({ ...ctx, repo: leg.repo, image: leg.image });
    } catch (err) {
      // A throw is cannot-say and never failure. Nobody knows whether the deploy happened, and
      // saying it did not is as much an invention as saying it did.
      answer = { state: UNKNOWN, detail: `${step.call} threw — ${first(err)}` };
    }
    const read = readStep(step, answer, { image: leg.image });
    leg.steps.push(read);
    if (read.image && !leg.image) leg.image = read.image;
    leg.state = read.state;
    if (read.state !== PASSED) return false;
    if (step.id === 'promote-prod') leg.promoted = true;
  }
  return true;
}

/**
 * Carry one promotion bead as far as its driver will take it.
 *
 * Never throws. This is meant to be called from a sweep, and a tracker mid-write or a driver
 * that blew up must not take the caller down with it — the failure is a returned reason and a
 * retry next time round, which is safe because the only irreversible act in here is the close,
 * and the close happens once every repo's production result is in.
 *
 * Answers the whole run: `{ bead, epic, legs, image, steps, state, closed, promoted, ... }`,
 * or `{ refused }` when nothing ran at all. The two are deliberately different — a refusal is
 * a bead that was never claimed and never touched, and a run that stopped in UAT is a bead
 * that has an image in an environment and a record saying so.
 *
 * `legs` is one entry per repo and is always the truth; `repo`, `image` and `steps` are the
 * single-repo case flattened onto the run for the callers that predate bc-y8k4.4, and they
 * are empty on a bead that names more than one.
 */
export async function carry(bd, workspace, id, driver, { actor = '', now = () => new Date() } = {}) {
  try {
    assertDriver(driver);
  } catch (err) {
    return refused(first(err));
  }

  let row;
  try {
    row = await bd.show(workspace, id);
  } catch (err) {
    return refused(`could not read ${id} — ${first(err)}`);
  }
  if (!row) return refused(`${workspace?.name || 'that workspace'} has no bead ${id}`);
  if (!isPromotionBead(row)) return refused(`${id} is not a promotion bead — it does not carry \`${PROMOTE_LABEL}\``);
  if (!isEndorsed(row)) return refused(`${id} is not endorsed, and a promotion nobody has agreed to is not one to run`);
  if (String(row.status || '').toLowerCase() === 'closed') return refused(`${id} is already closed`);
  // A bead with somebody's name on it belongs to them, and two release agents on one promotion
  // is two deploys of one image racing each other into production. On the assignee alone and
  // not on `in_progress` beside it: a handback clears the assignee (`reopenAbandoned`), so a
  // name still on an *open* promotion bead is a holder, and reading the status as well would
  // make that guard depend on which of `in_progress` and `in progress` bd happened to write.
  if (text(row.assignee) && text(row.assignee) !== text(actor)) return refused(`${id} is held by ${text(row.assignee)}`);
  const epic = epicOf(row);
  if (!epic) return refused(`${id}'s title does not name the epic it promotes, so what to test cannot be derived`);

  const repos = reposOf(row);
  if (!repos.length) return refused(`${id} names no repo, so there is no image to promote`);

  // Asked before anything is claimed, because a promotion whose test list cannot be derived is
  // a promotion that would exercise nothing in particular and pass. bc-y8k4.1: the tracker is
  // the authority on what an epic's work was, and the filed body is a snapshot that cannot grow.
  const work = await landedWork(bd, workspace, epic);
  if (work.error) return refused(`could not derive what ${epic} closed, so there is nothing to exercise — ${work.error}`);

  // What earlier runs already got into production, before this one claims anything. bc-y8k4.4:
  // a repo verified once is never driven again, which is what stops a partial result from
  // either re-deploying production or being thrown away.
  const prior = await priorRuns(bd, workspace, id);

  try {
    // Assignee first, status second. The window between the two writes is a bead that is owned
    // and not yet started, which every queue here reads correctly; the other order leaves an
    // `in_progress` bead with nobody on it, which is the exact state `reopenAbandoned` exists
    // to clean up after.
    if (actor) await bd.assign(workspace, id, actor);
    await bd.setStatus(workspace, id, 'in_progress');
  } catch (err) {
    return refused(`could not claim ${id} — ${first(err)}`);
  }

  const legs = repos.map((repo) => {
    const was = prior.get(repo);
    return was?.verified
      ? { repo, image: was.image, steps: [], state: PASSED, promoted: true, verified: true, already: true, held: '', at: was.at }
      : { repo, image: '', steps: [], state: UNKNOWN, promoted: false, verified: false, already: false, held: '', at: '' };
  });
  const owed = legs.filter((leg) => !leg.already);
  const ctx = { bead: id, epic, work: work.beads };

  // Pass one: UAT for every repo still owed, whatever the others did. A repo whose UAT fails
  // does not stop the next repo being deployed and tested — the point of the run is to come
  // back knowing as much as it can about every repo, and UAT is where finding out is cheap.
  for (const leg of owed) await drive(driver, leg, UAT_STEPS, ctx);

  // Pass two, and the gate. Production is entered only when every owed repo got through UAT:
  // an epic is one feature, and putting two of its three repos live while the third is red is
  // a half-shipped feature in front of customers. A repo held back this way says so.
  const short = owed.filter((leg) => leg.state !== PASSED);
  if (short.length) {
    const why = `${short.map((l) => `\`${l.repo}\``).join(', ')} did not get through UAT`;
    for (const leg of owed) if (leg.state === PASSED) leg.held = why;
  } else {
    for (const leg of owed) {
      await drive(driver, leg, PROD_STEPS, ctx);
      leg.verified = leg.steps.length === STEPS.length && leg.state === PASSED;
    }
  }

  const run = {
    bead: id,
    epic,
    legs,
    carried: prior,
    // The single-repo flattening, for everything written before a bead could span three.
    repo: legs.length === 1 ? legs[0].repo : '',
    image: legs.length === 1 ? legs[0].image : '',
    steps: legs.length === 1 ? legs[0].steps : [],
    at: now().toISOString(),
    work: work.beads,
    open: work.open,
    // Conservative in the same direction everything else here is: one failed repo makes the
    // run failed, and anything short of every repo verified is at best cannot-say.
    state: legs.some((l) => l.state === FAILED) ? FAILED : legs.every((l) => l.verified) ? PASSED : UNKNOWN,
    closed: false,
    promoted: legs.every((l) => l.promoted),
    handedBack: false,
    recorded: false,
    warn: [],
  };
  for (const leg of run.legs) if (!leg.at) leg.at = run.at;

  const done = legs.every((leg) => leg.verified);

  // Written before the close and before the handback, and outside both of their failure paths:
  // the record is the only thing that survives either write going wrong, and a bead closed with
  // no comment saying what was checked is exactly the promotion nobody can audit. It also
  // carries the per-repo ledger, so a comment that does not get written costs the next run its
  // memory of this one — a repo carried twice, never a repo closed over.
  try {
    await bd.comment(workspace, id, record({ ...run, closed: done }));
    run.recorded = true;
  } catch (err) {
    run.warn.push(`could not write the run onto ${id} — ${first(err)}`);
  }

  if (done) {
    try {
      await bd.close(workspace, id, closeReason(run), { actor: actor || null });
      run.closed = true;
    } catch (err) {
      run.warn.push(`production is verified but ${id} would not close — ${first(err)}`);
    }
    return run;
  }

  try {
    await bd.reopenAbandoned(workspace, id);
    run.handedBack = true;
  } catch (err) {
    run.warn.push(`could not hand ${id} back to the queue — ${first(err)}`);
  }
  return run;
}

/**
 * Why the bead closed — the image, per repo, and what was green.
 *
 * The image belongs in the close reason and not only in the comment: a close reason is what
 * a board shows against a closed bead, and "promoted" without a digest is the claim this
 * whole file exists to stop anybody making.
 */
function closeReason(run) {
  if (run.legs.length === 1) {
    const leg = run.legs[0];
    const checks = leg.steps[3]?.checks.length || 0;
    return `Promoted and verified in production — ${leg.image ? `\`${leg.image}\`` : 'no image named'} in \`${leg.repo}\`, ${checks} check${checks === 1 ? '' : 's'} green.`;
  }
  return `Promoted and verified in production — ${run.legs.length} repos: ${run.legs
    .map((l) => `\`${l.repo}\` ${l.image ? `\`${l.image}\`` : '(no image named)'}${l.already ? ' (an earlier run)' : ''}`)
    .join(', ')}.`;
}
