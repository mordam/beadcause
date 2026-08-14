#!/usr/bin/env node
/**
 * `Bd.closeGate` — would bd refuse to close this bead, and why?
 *
 *     npm test
 *     node test/closegate.mjs
 *
 * *Answer & close* is two writes, and only the second one had a gate on it. bd
 * refuses to close a bead blocked by open dependencies, and refuses to close an
 * epic with open children — so the comment went in, the close threw, and the whole
 * answer came back to the phone as an error over a question that had in fact been
 * answered. The card stayed in the inbox looking untouched, and it got answered
 * again: five beads across two workspaces ended up carrying the same answer two and
 * three times over.
 *
 * This is the check that runs before anything is written. Three failures are worth
 * a file, and the middle one is the expensive one:
 *
 * 1. **Missing a gate** puts the duplicate comments back — the whole bug.
 * 2. **Inventing one** is worse, and silently so: a question that bd would close
 *    perfectly happily becomes unanswerable from the phone, and nothing anywhere
 *    says why. So the closed-blocker, the non-`blocks` dependency and the
 *    all-children-closed epic each get their own assertion.
 * 3. **Failing shut on a lookup that errored.** Not being able to *ask* is not the
 *    same as being refused, and a Dolt lock on `bd show` must not present itself as
 *    "this bead cannot be closed".
 *
 * The `bd` binary is never run: `run()` is replaced with a log-and-reply stub, so
 * the module is exercised without a tracker, a workspace, or a lock to lose.
 *
 * **Two of the gates here are not bd's**, and are marked as such where they appear: an
 * epic with an unapplied `Adopts:` entry, and an epic closing on a merge reason. Both
 * are beadcause refusing something the binary permits — bc-arj0.3, filed after six epics
 * closed on their own pull request merge with sixty adoptees still open between them.
 *
 * Which is also the one thing this file cannot do. A stub answers with what the code
 * already believes, so failure 2 above — inventing a gate — is invisible here by
 * construction, and bc-5864 was filed believing it had happened. **test/closegatereal.mjs
 * is the other half**: same shapes, a real `bd init` in a throwaway workspace, and every
 * case asserting the gate's answer against what the binary then does with the same close.
 * Anything asserted here about bd's rules is asserted there against bd.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { Bd } = await import(path.join(HERE, '..', 'lib', 'bd.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const WS = { name: 'demo', dir: '/nowhere' };

/**
 * A Bd whose `run` answers from a script instead of spawning anything.
 *
 * `replies` is keyed by the first argument — `show`, `list` — and a value that is
 * an Error is thrown rather than returned, which is how the lock cases are written.
 */
function fakeBd(replies) {
  const bd = new Bd({ bin: '/nonexistent/bd', actor: 'beadcause' });
  bd.calls = [];
  bd.run = async (workspace, args) => {
    bd.calls.push(args.join(' '));
    const reply = replies[args[0]];
    if (reply instanceof Error) throw reply;
    return JSON.stringify(reply ?? []);
  };
  return bd;
}

const issue = (over = {}) => ({
  id: 'dm-1',
  issue_type: 'task',
  status: 'open',
  title: 'A question',
  dependencies: null,
  ...over,
});

const dep = (id, status, type = 'blocks') => ({ id, status, title: `${id} title`, dependency_type: type });

console.log('\nclose gate\n');

/* ---------------------------------------------------------------- it refuses */

{
  // The sophab case: sp-hz3.5, blocked by three open beads, answered three times.
  const bd = fakeBd({
    show: [issue({ dependencies: [dep('dm-2', 'open'), dep('dm-3', 'in_progress'), dep('dm-4', 'closed')] })],
  });
  const gate = await bd.closeGate(WS, 'dm-1');
  check('a bead blocked by open dependencies is refused', gate?.kind === 'blocked', JSON.stringify(gate));
  check(
    'and only the open ones are named',
    gate?.blockers.map((b) => b.id).join(',') === 'dm-2,dm-3',
    gate?.blockers.map((b) => b.id).join(',')
  );
  check('the reason is a sentence, not a code', /blocked by dm-2, dm-3/.test(gate?.reason || ''), gate?.reason);
  check('it costs one call', bd.calls.length === 1, bd.calls.join(' | '));
}

{
  // The deluvia case: dv-gr6, an epic with 24 open children.
  const bd = fakeBd({
    show: [issue({ issue_type: 'epic' })],
    list: [{ id: 'dm-1.1', status: 'open' }, { id: 'dm-1.2', status: 'closed' }, { id: 'dm-1.3', status: 'in_progress' }],
  });
  const gate = await bd.closeGate(WS, 'dm-1');
  check('an epic with open children is refused', gate?.kind === 'epic', JSON.stringify(gate));
  check('counting only the open ones', /2 open child issues/.test(gate?.reason || ''), gate?.reason);
  check(
    'children come from --parent, which is the only place they are',
    bd.calls.some((c) => c.includes('list --parent dm-1')),
    bd.calls.join(' | ')
  );
}

{
  const bd = fakeBd({ show: [issue({ issue_type: 'epic' })], list: [{ id: 'dm-1.1', status: 'open' }] });
  const gate = await bd.closeGate(WS, 'dm-1');
  check('one open child reads as one, not "1 issues"', /1 open child issue$/.test(gate?.reason || ''), gate?.reason);
}

/* ------------------------------------------------------- it does not refuse */

// Every one of these is a question bd would close without complaint, and inventing
// a gate over any of them makes it unanswerable from the phone with no explanation.

{
  const bd = fakeBd({ show: [issue()] });
  check('an ordinary open question is not gated', (await bd.closeGate(WS, 'dm-1')) === null);
}

{
  const bd = fakeBd({ show: [issue({ dependencies: [dep('dm-2', 'closed'), dep('dm-3', 'closed')] })] });
  check('a bead whose blockers have all closed is not gated', (await bd.closeGate(WS, 'dm-1')) === null);
}

{
  // `related`, `discovered-from` and `parent-child` all show up in `dependencies`,
  // and none of them stops a close. Only `blocks` does.
  const bd = fakeBd({
    show: [
      issue({
        dependencies: [dep('dm-9', 'open', 'related'), dep('dm-8', 'open', 'parent-child'), dep('dm-7', 'open', 'discovered-from')],
      }),
    ],
  });
  const gate = await bd.closeGate(WS, 'dm-1');
  check('a dependency that is not `blocks` does not gate the close', gate === null, JSON.stringify(gate));
}

{
  const bd = fakeBd({ show: [issue({ issue_type: 'epic' })], list: [{ id: 'dm-1.1', status: 'closed' }] });
  check('an epic whose children are all closed is not gated', (await bd.closeGate(WS, 'dm-1')) === null);
}

{
  const bd = fakeBd({ show: [issue({ issue_type: 'epic' })], list: [] });
  const gate = await bd.closeGate(WS, 'dm-1');
  check('an epic with no children at all is not gated', gate === null, JSON.stringify(gate));
}

{
  // Children are asked about for **every** type since bd 1.2.1 (bc-xl7n.39). This used
  // to assert the opposite — one extra `bd` call per answer on every non-epic in the
  // tracker was not worth a gate that could not apply — and the trade changed when the
  // gate started applying: 1.2.1 refuses any close over an open child whatever the
  // parent's type, so not asking meant offering a close bd would refuse. The call is
  // the price; see the note in `gateFor` for why there is no cheap way to skip it.
  const bd = fakeBd({ show: [issue({ issue_type: 'task' })], list: [{ id: 'dm-1.1', status: 'open' }] });
  await bd.closeGate(WS, 'dm-1');
  check('children are asked about for a task too, not only an epic', bd.calls.some((c) => c.includes('list')), bd.calls.join(' | '));
}

{
  // And the answer that follows from it. This is the one somebody will read as a bug in
  // the other direction now: bc-5864 was filed on bc-rk2o — a **feature**, closed by a
  // delivery over an open child — read as bd and this file disagreeing, on a binary
  // where bd's parent gate really was the word `epic` and both were right. On 1.2.1 the
  // same close is refused, so the gate holds it. test/closegatereal.mjs asks bd itself.
  const bd = fakeBd({ show: [issue({ issue_type: 'feature' })], list: [{ id: 'dm-1.1', status: 'open' }] });
  const gate = await bd.closeGate(WS, 'dm-1');
  check('a feature with open children is gated too', gate?.kind === 'epic', JSON.stringify(gate));
  check('and the sentence says parent rather than epic', /a parent with 1 open child/.test(gate?.reason || ''), JSON.stringify(gate));
}

/* ------------------------------- and two gates bd has no idea about (bc-arj0.3) */

// Everything above models a refusal the binary would make anyway. These two are
// beadcause's own, and test/closegatereal.mjs is where they are asserted *against* bd —
// as the one pair of cases there that assert the gate and the binary deliberately
// disagree, because bd has no pre-close hook and cannot be taught either rule.

{
  // bc-ka5y: an epic that named 23 beads in prose, reparented none of them, and so
  // presented to bd as an epic with no children at all.
  const bd = fakeBd({
    show: [issue({ issue_type: 'epic', description: 'Adopts: dm-2, dm-3, dm-4.\n' })],
    list: [{ id: 'dm-2', status: 'closed' }],
  });
  const gate = await bd.closeGate(WS, 'dm-1');
  check('an epic with an unapplied Adopts: entry is refused', gate?.kind === 'adopts', JSON.stringify(gate));
  check('naming the entries nothing applied', gate?.blockers.map((b) => b.id).join(',') === 'dm-3,dm-4', JSON.stringify(gate?.blockers));
  check('and saying what to do about it', /adopt them or drop them/.test(gate?.reason || ''), gate?.reason);
}

{
  // The same list, applied. A named bead that *is* a child is held by the epic, which
  // is the whole point — and a closed one is finished, so nothing is left to refuse.
  const bd = fakeBd({
    show: [issue({ issue_type: 'epic', description: 'Adopts: dm-2, dm-3.' })],
    list: [
      { id: 'dm-2', status: 'closed' },
      { id: 'dm-3', status: 'closed' },
    ],
  });
  check('an epic whose Adopts: list was applied is not gated', (await bd.closeGate(WS, 'dm-1')) === null);
}

{
  // An applied adoption that is still open is bd's own gate, reported in bd's words
  // rather than as an adoption problem — there is nothing left to apply.
  const bd = fakeBd({
    show: [issue({ issue_type: 'epic', description: 'Adopts: dm-2.' })],
    list: [{ id: 'dm-2', status: 'open' }],
  });
  const gate = await bd.closeGate(WS, 'dm-1');
  check('an open adoptee reads as an open child, which it now is', gate?.kind === 'epic', JSON.stringify(gate));
}

{
  // Only an epic adopts. A task writing the word is describing something else.
  const bd = fakeBd({ show: [issue({ issue_type: 'task', description: 'Adopts: dm-2, dm-3.' })] });
  check('a task with an Adopts: line is not gated', (await bd.closeGate(WS, 'dm-1')) === null);
}

{
  // The one that took the classification with it: bc-ka5y closed as "Merged #212 as
  // 72789c0b into main". Refused whatever the children say, and refused without asking
  // them — the sentence is enough on its own.
  const bd = fakeBd({ show: [issue({ issue_type: 'epic' })], list: [] });
  const gate = await bd.closeGate(WS, 'dm-1', { reason: 'Merged #212 as 72789c0b into main on GitHub' });
  check('an epic closing on a merge reason is refused', gate?.kind === 'merge-reason', JSON.stringify(gate));
  check('and costs no child lookup to refuse', !bd.calls.some((c) => c.includes('list')), bd.calls.join(' | '));
}

{
  const bd = fakeBd({ show: [issue({ issue_type: 'epic' })], list: [] });
  const gate = await bd.closeGate(WS, 'dm-1', { reason: 'Landed as #42 — still owed: deploy' });
  check("the worker's own wording is the same merge", gate?.kind === 'merge-reason', JSON.stringify(gate));
}

{
  // A theme somebody decided is finished. That is what closing an epic is for.
  const bd = fakeBd({ show: [issue({ issue_type: 'epic' })], list: [] });
  const gate = await bd.closeGate(WS, 'dm-1', { reason: 'The whole theme is done — every piece of it shipped.' });
  check('an epic closing on any other reason is not gated', gate === null, JSON.stringify(gate));
}

{
  // The ordinary case, and the one this must not break: a work bead closes *because*
  // its pull request merged.
  const bd = fakeBd({ show: [issue({ issue_type: 'task' })] });
  const gate = await bd.closeGate(WS, 'dm-1', { reason: 'Landed as #42' });
  check('a work bead closing on a merge is exactly right', gate === null, JSON.stringify(gate));
}

{
  // A caller with no reason in hand — the hold, the phone drawing a card — gets the
  // answer it always did.
  const bd = fakeBd({ show: [issue({ issue_type: 'epic' })], list: [] });
  check('no reason means no merge-reason gate', (await bd.closeGate(WS, 'dm-1')) === null);
}

/* ------------------------------------------------------------ it fails open */

{
  const bd = fakeBd({ show: new Error('bd show dm-1 failed in demo: database is locked') });
  const gate = await bd.closeGate(WS, 'dm-1');
  check('a lookup that failed on the lock does not read as a refusal', gate === null, JSON.stringify(gate));
}

{
  const bd = fakeBd({ show: [] });
  check('a bead bd has never heard of is left to the close itself', (await bd.closeGate(WS, 'dm-1')) === null);
}

{
  const bd = fakeBd({ show: [issue({ issue_type: 'epic' })], list: new Error('bd list failed in demo: database is locked') });
  const gate = await bd.closeGate(WS, 'dm-1');
  check('nor does a child lookup that failed', gate === null, JSON.stringify(gate));
}

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
