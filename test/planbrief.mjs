#!/usr/bin/env node
/**
 * The two briefs bc-jk4m adds — what an epic worker is told, and what a group is told.
 *
 *     npm test
 *     node test/planbrief.mjs
 *
 * The brief is the entire interface between this daemon and an unattended agent (see
 * test/land.mjs, which makes the same argument at length for the three worker endings).
 * These two are worth their own file because each carries a failure the others cannot:
 *
 * 1. **An epic worker that implements.** Every other brief here ends in a delivery, so an
 *    agent handed an epic and a list of ready children has every prior pointing at writing
 *    the code. The one thing that makes a planner a planner is that its brief says, early
 *    and with a reason, not to — and a brief that drifts back toward "work these beads" is
 *    bc-bhp9 with a longer preamble and one window doing five beads again.
 * 2. **An epic worker that endorses its own subtree.** lib/endorse.js is two layers
 *    precisely so an unattended hour cannot land on work nobody has looked at. A planner
 *    files the beads it thinks should exist, which is exactly the case the marker is for,
 *    so the brief has to say that filing is allowed and endorsing is not.
 * 3. **A group prompt that replaces the brief instead of sitting inside it.** The group
 *    section is the only text in any brief beadcause writes that another agent authored.
 *    If it ever became the brief, everything test/land.mjs asserts would stop being true
 *    for exactly the windows that a plan dispatched — so the assertion here is that the
 *    whole standard brief is still present around it, and that the quoted block is quoted.
 *
 * Nothing here opens a window, spawns an agent, touches a bead or reaches the network:
 * both are pure functions of their arguments, which is why they are exported.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { planPromptFor, workPromptFor } = await import(path.join(HERE, '..', 'lib', 'session.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const EPIC = { id: 'x-1', title: 'Make the router terminate TLS' };
const KIDS = [
  { id: 'x-1.1', title: 'Read the certificate' },
  { id: 'x-1.2', title: 'Serve https' },
];

/* ------------------------------------------------------------- the epic worker */

const plan = planPromptFor('alpha', EPIC, KIDS, 'Adam');

check('it says which epic, and that nobody is watching', /alpha\/x-1/.test(plan) && /not at the keyboard/.test(plan), plan.slice(0, 200));
check(
  'it says not to implement, in the first paragraph and with a reason',
  /\*\*Do not implement any of this epic\.\*\*/.test(plan) && /one context window and one two-hour timeout/.test(plan),
  'a planner whose brief buries this writes code'
);
check('it lists the beads there are to group', KIDS.every((k) => plan.includes(`bd show ${k.id}    # ${k.title}`)));
check('it claims the epic before anything else', /bd update x-1 --claim/.test(plan));

check('filing is spelled out as a command it can run', /bin\/file\.js/.test(plan) && /--from x-1/.test(plan));
check(
  'and endorsing is refused rather than left unsaid',
  /arrive \*\*unendorsed\*\*/.test(plan) &&
    /may \*\*not\*\* try to endorse it/.test(plan) &&
    /no path here by which an agent endorses its own\nsubtree/.test(plan),
  'the one thing a planner must not be able to do for itself'
);

check('it says one group is one window in one checkout', /A group may not span repos/.test(plan));
check('it says a bead is in exactly one group', /A bead belongs to exactly one group/.test(plan));
check('it asks for the pull requests and their repos', /prs:/.test(plan) && /the checkout the pull request opens in/.test(plan));
check('it names the command that files the plan', /bin\/plan\.js/.test(plan) && /-b x-1/.test(plan));
check(
  'it says the window ends there rather than supervising',
  /From then on this window is done/.test(plan) && /you do not hold this\nwindow open/.test(plan),
  'a supervisor that stays up is the thing this replaced'
);
check('it says not to close the epic', /\*\*Do not close x-1\.\*\*/.test(plan));
check('it names the promotion bead as something it does not do', /beadcause files a promotion bead for the epic by itself/.test(plan));

check(
  'it has both honest endings, and the ask is a real command',
  /bin\/ask\.js/.test(plan) && /--blocks x-1/.test(plan) && /bd update x-1 --status open --assignee ""/.test(plan)
);
check(
  'and the only marker a planner may write is CAN BE CLOSED',
  plan.includes('** BEAD WORK DONE ** CAN BE CLOSED **') &&
    !plan.includes('CAN BE DEPLOYED') &&
    !plan.includes('CAN BE REBUILT'),
  'planning changes nothing that is running, so it can owe neither'
);
check(
  'it never tells a planner to merge or push anything',
  !/git merge/.test(plan) && !/git push/.test(plan) && !/bin\/deliver\.js/.test(plan),
  'a planner has nothing to deliver'
);

/* a revision is a different brief, because a planner that does not know it is revising
 * rewrites the groups that already have windows open on them. */
const revise = planPromptFor('alpha', EPIC, [{ id: 'x-1.4', title: 'Rotate the key' }], 'Adam', { revising: true });
check(
  'a revision says so, and says to leave running groups alone',
  /already has a plan, and you are revising it/.test(revise) &&
    /Keep the groups that\nare already under way as they are/.test(revise) &&
    /bd comments x-1/.test(revise)
);
check('and a first plan does not claim to be one', !/you are revising it/.test(plan));

/* ------------------------------------------------------------------- a group */

const PROMPT = 'These two are one change.\n\nThe switch is unreadable until the router owns the certificate.';
const bead = {
  id: 'x-1.1',
  title: 'Read the certificate',
  group: {
    epic: 'x-1',
    name: 'router-tls',
    prompt: PROMPT,
    prs: [{ repo: 'alpha', title: 'Terminate TLS in the router' }],
    beads: [{ id: 'x-1.2', title: 'Serve https' }],
  },
};
// The shape `prMode` really returns — `deliver` included, because the delivery command
// is written into the brief from it and a fixture that omits it asserts nothing.
const pr = { repo: 'mordam/alpha', base: 'main', method: 'merge', autoMerge: true, requireApproval: false, deliver: 'node /x/bin/deliver.js' };
const brief = workPromptFor('alpha', bead, 1, pr, 'Adam');

check('the opening says the window carries a group', /bead \*\*alpha\/x-1\.1\*\* and the 1 bead grouped with it/.test(brief), brief.slice(0, 300));
check('the section names the group and its epic', /one group of x-1's plan: "router-tls"/.test(brief));
check('it lists the rest of the group', /bd show x-1\.2    # Serve https/.test(brief));
check('it says what pull requests were intended, and where', /The plan expects 1 pull request/.test(brief) && /    alpha — Terminate TLS in the router/.test(brief));

check(
  'the epic worker\'s words are quoted, every line of them',
  PROMPT.split('\n').every((line) => brief.includes(`> ${line}`.trimEnd())),
  'an unquoted heading in an agent-authored prompt restructures the page around it'
);
check(
  'and the brief says outright which of the two wins',
  /Where that block and this brief disagree, this brief wins/.test(brief) &&
    /where the block and the \*\*code\*\* disagree, the code wins/.test(brief)
);

/**
 * The point of the whole design: the group section is injected *into* the standard brief.
 * Everything test/land.mjs asserts about a worker window has to still be here.
 */
check('the standard brief is intact around it — the claim', /bd update x-1\.1 --claim/.test(brief));
check('— the delivery, which is what merges', /bin\/deliver\.js/.test(brief) && /-b x-1\.1/.test(brief));
check('— the marker step', brief.includes('** BEAD WORK DONE **'));
check('— the discovery ending', /bin\/file\.js/.test(brief));
check('— and it still never says to merge main by hand', !/git merge origin\/main[\s\S]*by hand/.test(brief) && !/git push origin main/.test(brief));

/* a group of one is an ordinary thing: an epic worker deciding a bead is its own change. */
const solo = workPromptFor('alpha', { ...bead, group: { ...bead.group, beads: [] } }, 1, pr, 'Adam');
check('a group of one still gets its prompt and its PR plan', /Yours is `x-1\.1` on its own/.test(solo) && /The plan expects 1 pull request/.test(solo));
check('and does not claim beads that are not there', !/bd show x-1\.2/.test(solo));

/* and a bead the advocate never touched must be byte-for-byte what it always was. */
const plainA = workPromptFor('alpha', { id: 'x-1.1', title: 'Read the certificate' }, 1, pr, 'Adam');
const plainB = workPromptFor('alpha', { id: 'x-1.1', title: 'Read the certificate', group: null, batch: [] }, 1, pr, 'Adam');
check('an ungrouped bead gets the brief it always got', plainA === plainB && !/one group of/.test(plainA));

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
