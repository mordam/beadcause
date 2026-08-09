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
  // Children are only ever asked about for an epic — one extra `bd` call per answer
  // on every other bead in the tracker is not worth a gate that cannot apply.
  const bd = fakeBd({ show: [issue({ issue_type: 'task' })], list: [{ id: 'dm-1.1', status: 'open' }] });
  await bd.closeGate(WS, 'dm-1');
  check('children are not asked about for anything but an epic', !bd.calls.some((c) => c.includes('list')), bd.calls.join(' | '));
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
