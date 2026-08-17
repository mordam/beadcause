/**
 * Deny by default: every grant in every foundation is classified, or the repo fails.
 *
 * This is the free half of `npm run evals` — two objects and a loop, no model, no
 * tokens — and it is the assertion the rest of the directory is built around. The live
 * evals below it can only ever say "this agent, on this prompt, on this day, did not
 * reach for anything". This one says "no agent has been *given* anything nobody thought
 * about", which is the claim that keeps holding while nobody is looking.
 *
 * It is also in `npm test` (test/grants.mjs), for the reason lib/checkaudit.js is in
 * both `npm run checks` and `test/checks.mjs`: a guard that runs only when somebody
 * remembers to run it is a guard against nothing. The evals it sits beside are opt-in
 * because they cost money; this one costs nothing, so the argument for keeping it out of
 * the gate does not reach it.
 */
import { ROOT } from '../helpers.mjs';
import path from 'node:path';

export const meta = {
  tag: 'free',
  title: 'every granted capability is classified, and no write has spread',
  cost: 'nothing — no model is run',
};

export async function run() {
  const foundation = await import(path.join(ROOT, 'lib', 'foundation.js'));
  const { grantProblems } = await import(path.join(ROOT, 'lib', 'grants.js'));

  const problems = grantProblems(foundation.AGENTS, foundation.baseline);
  if (problems.length) {
    throw new Error(
      `${problems.length} ${problems.length === 1 ? 'grant disagrees' : 'grants disagree'} with lib/grants.js:\n` +
        problems.map((p) => `    · ${p}`).join('\n')
    );
  }
  const granted = new Set(foundation.AGENTS.flatMap((a) => foundation.baseline(a).allowedTools || []));
  return `${granted.size} distinct grants across ${foundation.AGENTS.length} agents, all classified`;
}
