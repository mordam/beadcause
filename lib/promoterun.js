/**
 * Carrying a promotion bead — pick one up, drive four steps, close only on production.
 *
 * lib/promote.js **files** the bead: one per epic, the moment every bead the epic's plan
 * named has closed, and its own header says outright that "the release agent that will work
 * it does not exist yet". This is the half of that agent which does not care what the
 * pipeline is. It picks a promotion bead up, claims it the way every other agent here claims
 * work, drives four calls in order, writes on the bead what was deployed and what was
 * checked, and closes it only when production has been verified.
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
 * ## What is written, and where
 *
 * One comment per run, on the bead, whatever the outcome — the image, every step, every
 * check, and the sentence saying where it stopped. Not only in a log: a promotion is read
 * weeks later by whoever asks what was released, and the daemon log has rolled by then.
 * A run that ends anywhere but a verified production result hands the bead back unclaimed,
 * so the next run can pick it up; an `in_progress` bead nobody holds is invisible to every
 * queue here forever.
 *
 * ## What this half deliberately does not do
 *
 * **More than one repo.** An epic spanning three repos is three images with three UAT runs
 * and three production runs, and they may not all pass — one bead cannot hold "two of three
 * promoted" without either lying or closing early. That shape is bc-y8k4.4, which depends on
 * this bead; until it lands, a promotion bead naming more than one repo is refused by name
 * rather than carried half way.
 */

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
 */
export const STEPS = Object.freeze([
  Object.freeze({ id: 'deploy-uat', call: 'deployToUat', env: 'uat', verb: 'deploy', says: 'UAT deploy' }),
  Object.freeze({ id: 'test-uat', call: 'testInUat', env: 'uat', verb: 'test', says: 'UAT tests' }),
  Object.freeze({ id: 'promote-prod', call: 'promoteToProd', env: 'production', verb: 'promote', says: 'production promote' }),
  Object.freeze({ id: 'test-prod', call: 'testInProd', env: 'production', verb: 'test', says: 'production tests' }),
]);

/** Is this bead one a release agent may carry? Takes a `bd --json` row. */
export const isPromotionBead = (row) => (row?.labels || []).some((l) => String(l).trim() === PROMOTE_LABEL);

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
 */
export function reposOf(row) {
  const line = /^\*\*Repos\*\*[^:\n]*:\s*(.+)$/m.exec(String(row?.description || row?.body || ''));
  if (!line) return [];
  return [...line[1].matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
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
  return rows.filter((r) => r && String(r.status || '').toLowerCase() !== 'closed');
}

const stateWord = (s) => (s === UNKNOWN ? 'cannot say' : s);

/**
 * What goes on the bead — the whole run, whatever it did, in one comment.
 *
 * Written for somebody reading the card in three weeks asking what was released and what was
 * checked. Every step that ran gets a line whether it passed or not, because a run that
 * stopped in UAT is exactly the one whose record matters, and every check is named because
 * "it was tested" is the claim this file exists to stop anybody making without evidence.
 */
export function record(run) {
  const lines = [`**Promotion run** — ${run.at} · \`${run.repo}\``];
  lines.push('');
  lines.push(`- **Image** — ${run.image ? `\`${run.image}\`` : '_none named_'}`);
  for (const s of run.steps) {
    const checks = s.checks.length
      ? ` — ${s.checks.map((c) => `\`${c.name}\` ${stateWord(c.state)}${c.detail ? ` (${c.detail})` : ''}`).join(', ')}`
      : '';
    lines.push(`- **${s.says}** — ${stateWord(s.state)}${s.detail ? ` (${s.detail})` : ''}${checks}`);
  }
  for (const s of STEPS.slice(run.steps.length)) lines.push(`- **${s.says}** — not reached`);
  lines.push('');
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
  lines.push(run.closed ? verdict(run) : `${verdict(run)} Not closed: a promotion bead closes on a verified production result and nothing else.`);
  return lines.join('\n');
}

/** The one sentence: where it got to, and — when it stopped — in which environment and on what. */
export function verdict(run) {
  if (run.closed) return `Production is verified, so ${run.bead} is closed.`;
  const stopped = run.steps[run.steps.length - 1];
  if (!stopped) return 'Nothing ran.';
  const failed = stopped.checks.filter((c) => c.state !== PASSED);
  const on = failed.length ? ` on ${failed.map((c) => `\`${c.name}\``).join(', ')}` : '';
  const what = stopped.state === FAILED ? 'failed' : 'could not be settled';
  return `Stopped in **${stopped.env}**: the ${stopped.says} ${what}${on}.${stopped.state === UNKNOWN ? ' Cannot-say neither closes nor promotes.' : ''}`;
}

const refused = (why) => ({ refused: why, bead: '', steps: [], state: UNKNOWN, closed: false, promoted: false });

/**
 * Carry one promotion bead as far as its driver will take it.
 *
 * Never throws. This is meant to be called from a sweep, and a tracker mid-write or a driver
 * that blew up must not take the caller down with it — the failure is a returned reason and a
 * retry next time round, which is safe because the only irreversible act in here is the close,
 * and the close happens once production has answered.
 *
 * Answers the whole run: `{ bead, epic, repo, image, steps, state, closed, promoted, ... }`,
 * or `{ refused }` when nothing ran at all. The two are deliberately different — a refusal is
 * a bead that was never claimed and never touched, and a run that stopped in UAT is a bead
 * that has an image in an environment and a record saying so.
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
  const status = String(row.status || '').toLowerCase();
  if (status === 'closed') return refused(`${id} is already closed`);
  // A claimed bead belongs to whoever claimed it, and two release agents on one promotion is
  // two deploys of one image racing each other into production.
  if (status === 'in_progress' && text(row.assignee) && text(row.assignee) !== text(actor)) {
    return refused(`${id} is held by ${text(row.assignee)}`);
  }

  const epic = epicOf(row);
  if (!epic) return refused(`${id}'s title does not name the epic it promotes, so what to test cannot be derived`);

  const repos = reposOf(row);
  if (!repos.length) return refused(`${id} names no repo, so there is no image to promote`);
  // bc-y8k4.4. Refused by name rather than carried half way: this half has one image, one UAT
  // run and one production run in it, and a bead that closed on the first of three repos would
  // be the board lying about the other two.
  if (repos.length > 1) {
    return refused(`${id} covers ${repos.length} repos (${repos.join(', ')}) and a partial result has nowhere to go yet — bc-y8k4.4`);
  }
  const repo = repos[0];

  // Asked before anything is claimed, because a promotion whose test list cannot be derived is
  // a promotion that would exercise nothing in particular and pass. bc-y8k4.1: the tracker is
  // the authority on what an epic's work was, and the filed body is a snapshot that cannot grow.
  const work = await landedWork(bd, workspace, epic);
  if (work.error) return refused(`could not derive what ${epic} closed, so there is nothing to exercise — ${work.error}`);

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

  const run = {
    bead: id,
    epic,
    repo,
    image: '',
    at: now().toISOString(),
    steps: [],
    work: work.beads,
    open: work.open,
    state: UNKNOWN,
    closed: false,
    promoted: false,
    handedBack: false,
    recorded: false,
    warn: [],
  };

  for (const step of STEPS) {
    let answer;
    try {
      answer = await driver[step.call]({ repo, bead: id, epic, image: run.image, work: work.beads });
    } catch (err) {
      // A throw is cannot-say and never failure. Nobody knows whether the deploy happened, and
      // saying it did not is as much an invention as saying it did.
      answer = { state: UNKNOWN, detail: `${step.call} threw — ${first(err)}` };
    }
    const read = readStep(step, answer, { image: run.image });
    run.steps.push(read);
    if (read.image && !run.image) run.image = read.image;
    run.state = read.state;
    if (read.state !== PASSED) break;
    if (step.id === 'promote-prod') run.promoted = true;
  }

  const done = run.steps.length === STEPS.length && run.state === PASSED;

  // Written before the close and before the handback, and outside both of their failure paths:
  // the record is the only thing that survives either write going wrong, and a bead closed with
  // no comment saying what was checked is exactly the promotion nobody can audit.
  try {
    await bd.comment(workspace, id, record({ ...run, closed: done }));
    run.recorded = true;
  } catch (err) {
    run.warn.push(`could not write the run onto ${id} — ${first(err)}`);
  }

  if (done) {
    try {
      await bd.close(workspace, id, `Promoted and verified in production — ${run.image ? `\`${run.image}\`` : 'no image named'} in \`${repo}\`, ${run.steps[3].checks.length} check${run.steps[3].checks.length === 1 ? '' : 's'} green.`, { actor: actor || null });
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
