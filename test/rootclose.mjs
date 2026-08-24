#!/usr/bin/env node
//
// A root closing strands every open bead under it — and now something says so.
//
//   npm test                     (runs it alongside the rest)
//   node test/rootclose.mjs
//
// bc-xl7n.107. `rootsOf` counts only open roots (lib/underroot.js), so the moment a root
// closes, every still-open bead beneath it leaves the ready queue and is refused 409 at
// every session launcher — while still reading as ordinary open work on every screen. It
// happened three times (bc-b4fs.1, bc-ysqd.1, bc-ibt8g.1), each to a bead that had been
// homed *correctly*, and each was found only because somebody ran a census by hand.
//
// The acceptance criterion is exact, and case 5 below is it verbatim: the bc-ysqd shape —
// parent is a root, child is open and carries `unendorsed` so it is outside the ready queue
// and outside `heldByNoRoot`'s reach — and the trace still appears.
//
// Four things are worth a suite here and none is visible by reading one function:
//
// 1. **The discriminator.** A bead with no ancestors at all must NOT be traced. That is
//    bc-xl7n.25, answered on 2026-08-21 the other way: a parentless person-filed bead stays
//    parentless. Six of them sit in the tracker today, and a sweep that commented on those
//    would be a daily false alarm rather than a fix.
// 2. **It cannot disagree with the dispatcher.** The test is `hasRootAbove`, so a live epic
//    anywhere in the chain means no stranding — including the fail-open that makes an
//    unreadable graph produce nothing rather than everything.
// 3. **It says each thing once, across a restart.** The in-memory ledger covers the tick;
//    reading the thread for the mark is what covers the process boundary, and a tracker that
//    will not answer that question has to read as "already said" rather than "say it again".
// 4. **The bound is loud.** A pass cut short by `TRACE_CAP` must name itself, because a
//    silent truncation reads exactly like the quiet, healthy pass this sweep usually is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-rootclose-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const { createStrandWatch, strandingsIn, strandedNote, strandingNote, STRANDED_MARK, STRANDING_MARK, TRACE_CAP } =
  await import(LIB('rootclose.js'));
const { indexFrom } = await import(LIB('ancestry.js'));

const WS = { name: 'demo', dir: path.join(tmp, 'demo') };

/**
 * A tracker, as the rows `bd export` writes — one JSONL line each, fed through the real
 * `indexFrom`, so the shape under test is the shape lib/bd.js actually hands a sweep.
 */
const graphOf = (rows) => indexFrom(rows.map((r) => JSON.stringify(r)).join('\n'));

const kid = (id, parent) => (parent ? { dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }] } : {});
const epicRow = (id, extra = {}) => ({ id, title: `epic ${id}`, issue_type: 'epic', status: 'open', priority: 2, ...extra });
const p0Row = (id, extra = {}) => ({ id, title: `p0 ${id}`, issue_type: 'bug', status: 'open', priority: 0, ...extra });
/**
 * One open root that has nothing to do with the case under test, in every fixture.
 *
 * Not decoration. `hasRootAbove` answers **true** for everything when a workspace has no
 * open roots at all — the fail-open lib/underroot.js argues for, because an unreadable
 * graph and a workspace nobody has filed an epic in are indistinguishable from in there.
 * A fixture whose only root is the one that closed therefore has *no* stranded beads, by
 * the same rule the dispatcher uses, and it is the last case in section 1 rather than a
 * bug. Every other case needs a live root present so the gate is actually gating.
 */
const LIVE = () => ({ id: 'zz-live', title: 'somebody else’s epic', issue_type: 'epic', status: 'open', priority: 2 });

const taskRow = (id, parent, extra = {}) => ({
  id,
  title: `task ${id}`,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  ...kid(id, parent),
  ...extra,
});

/**
 * A `bd` with the three calls the watcher makes, and a record of every write.
 *
 * `comments` answers per bead so a suite can stage a thread that already carries the mark,
 * which is the only way to test the restart case — the ledger is a closure and a fresh
 * watch has an empty one by construction.
 */
const fakeBd = ({ graphs = [], threads = {}, failComment = null, failComments = null } = {}) => {
  const queue = [...graphs];
  let last = null;
  return {
    graphCalls: 0,
    commentReads: [],
    written: [],
    async graph() {
      this.graphCalls += 1;
      if (queue.length) last = queue.shift();
      if (last instanceof Error) throw last;
      return last;
    },
    async comments(ws, id) {
      this.commentReads.push(id);
      if (failComments && failComments(id)) throw new Error('dolt is locked');
      return (threads[id] || []).map((text) => ({ text }));
    },
    async comment(ws, id, text) {
      if (failComment && failComment(id)) throw new Error('bd refused the comment');
      this.written.push({ id: typeof ws === 'string' ? id : id, text });
      (threads[id] ||= []).push(text);
    },
  };
};

const wrote = (bd, id) => bd.written.filter((w) => w.id === id);

/* --------------------------------------------------- 1. what counts as stranded */

console.log('\nwhat a root closing leaves behind — and what it does not\n');

{
  const open = strandingsIn(graphOf([LIVE(), epicRow('zz-1'), taskRow('zz-1.1', 'zz-1')]));
  check('an open root over an open child strands nothing', open.length === 0, JSON.stringify(open));

  const shut = strandingsIn(graphOf([LIVE(), epicRow('zz-1', { status: 'closed' }), taskRow('zz-1.1', 'zz-1')]));
  check('a closed root over an open child is one stranding', shut.length === 1, JSON.stringify(shut));
  check('attributed to the root that closed', shut[0]?.root === 'zz-1', JSON.stringify(shut[0]?.root));
  check('carrying the root’s own title, which is what the note quotes', shut[0]?.title === 'epic zz-1', JSON.stringify(shut[0]?.title));
  check('and naming the bead it stranded', shut[0]?.stranded?.[0]?.id === 'zz-1.1', JSON.stringify(shut[0]?.stranded));
}

{
  const rows = [LIVE(), p0Row('zz-2', { status: 'closed' }), taskRow('zz-2.1', 'zz-2')];
  check('a P0 is a root too — `isRoot`, not `isEpic`', strandingsIn(graphOf(rows)).length === 1);
}

{
  const rows = [LIVE(), epicRow('zz-3', { status: 'closed' }), taskRow('zz-3.1', 'zz-3', { status: 'closed' })];
  check('a child that closed with its root is not stranded', strandingsIn(graphOf(rows)).length === 0);
}

{
  // bc-xl7n.25, answered 2026-08-21: a parentless person-filed bead stays parentless. This
  // sweep is about beads a *close* made unworkable, and requiring a closed root in the
  // chain is the whole of the discriminator between the two populations.
  const rows = [LIVE(), taskRow('zz-4', null), epicRow('zz-5', { status: 'closed' })];
  const out = strandingsIn(graphOf(rows));
  check('a bead with no ancestors at all is never reported — it was never rooted', out.length === 0, JSON.stringify(out));
}

{
  // A chain that dead-ends in an ordinary task rather than in a root. Unworkable, but
  // nothing closed above it, so it is the same population as the case above.
  const rows = [LIVE(), taskRow('zz-6', null), taskRow('zz-6.1', 'zz-6')];
  check('an unrooted chain with no closed root in it is not this bug', strandingsIn(graphOf(rows)).length === 0);
}

{
  const rows = [LIVE(), epicRow('zz-7', { status: 'closed' }), { ...epicRow('zz-7.1'), ...kid('zz-7.1', 'zz-7') }, taskRow('zz-7.1.1', 'zz-7.1')];
  const out = strandingsIn(graphOf(rows));
  check('a live epic between the close and the bead means nothing is stranded', out.length === 0, JSON.stringify(out));
}

{
  const rows = [
    LIVE(),
    epicRow('zz-8', { status: 'closed' }),
    taskRow('zz-8.1', 'zz-8'),
    taskRow('zz-8.1.1', 'zz-8.1'),
  ];
  const out = strandingsIn(graphOf(rows));
  check('a grandchild is stranded by the same close', out[0]?.stranded?.length === 2, JSON.stringify(out[0]?.stranded));
  check('and both are attributed to the one root, not to the task between them', out.length === 1, JSON.stringify(out.map((g) => g.root)));
}

{
  const rows = [
    LIVE(),
    epicRow('zz-9', { status: 'closed' }),
    { ...epicRow('zz-9.1', { status: 'closed' }), ...kid('zz-9.1', 'zz-9') },
    taskRow('zz-9.1.1', 'zz-9.1'),
  ];
  const out = strandingsIn(graphOf(rows));
  check('two closed roots in one chain is one stranding, not two', out.length === 1, JSON.stringify(out.map((g) => g.root)));
  check('attributed to the nearest one — the close that most recently decided it', out[0]?.root === 'zz-9.1', JSON.stringify(out[0]?.root));
}

{
  const rows = [
    LIVE(),
    epicRow('zz-10', { status: 'closed' }),
    taskRow('zz-10.1', 'zz-10', { labels: ['superseded-by:zz-99'] }),
    taskRow('zz-10.2', 'zz-10'),
  ];
  const out = strandingsIn(graphOf(rows));
  check('a superseded bead is being tidied away, not left behind — skipped', out[0]?.stranded?.length === 1, JSON.stringify(out[0]?.stranded));
  check('and the one beside it is still reported', out[0]?.stranded?.[0]?.id === 'zz-10.2', JSON.stringify(out[0]?.stranded));
}

{
  const rows = [
    LIVE(),
    epicRow('zz-11', { status: 'closed' }),
    taskRow('zz-11.1', 'zz-11', { status: 'in_progress' }),
    taskRow('zz-11.2', 'zz-11', { status: 'blocked' }),
    taskRow('zz-11.3', 'zz-11', { status: 'deferred' }),
  ];
  const out = strandingsIn(graphOf(rows));
  check('every non-closed status is stranded, not just `open`', out[0]?.stranded?.length === 3, JSON.stringify(out[0]?.stranded));
  check('and each carries its own status, so the note on the root is honest', out[0]?.stranded?.map((b) => b.status).join(',') === 'in_progress,blocked,deferred', JSON.stringify(out[0]?.stranded));
}

{
  check('an index that could not be read strands nothing — the fail-open, not a comment per bead', strandingsIn({ error: 'timed out', beads: new Map(), parents: new Map() }).length === 0);
  check('and neither does an empty one', strandingsIn(graphOf([])).length === 0);
  // The fail-open, stated as the case it actually is: a closed root with an open child
  // under it and **no other open root in the workspace**. `hasRootAbove` answers true for
  // everything there, so the dispatcher withholds nothing — and a sweep that reported a
  // stranding would be saying the opposite of what the gate does. It is the same reasoning
  // that makes an unreadable graph quiet, and it is why every fixture above carries `LIVE`.
  const noRoots = graphOf([{ ...epicRow('zz-12', { status: 'closed' }) }, taskRow('zz-12.1', 'zz-12')]);
  check('with no open root anywhere, the gate withholds nothing and neither does this', strandingsIn(noRoots).length === 0, JSON.stringify(strandingsIn(noRoots)));
}

/* --------------------------------------- 2. the bc-ysqd shape, which is the acceptance */

console.log('\nthe measured shape: an unendorsed child under a root that merged\n');

{
  const rows = [
    LIVE(),
    p0Row('zz-13', { status: 'closed', title: 'the merge queue reads no checks as green' }),
    taskRow('zz-13.1', 'zz-13', { labels: ['unendorsed', 'agent-filed'], title: 'sweep the suite for wall-clock fixtures' }),
  ];
  const bd = fakeBd({ graphs: [graphOf(rows)] });
  const out = await createStrandWatch({ bd }).sweep([WS]);

  check('the trace appears even though the bead is unendorsed and outside every queue', out.traced.length === 1, JSON.stringify(out.traced));
  check('it names the bead and the root that closed above it', out.traced[0]?.id === 'zz-13.1' && out.traced[0]?.root === 'zz-13', JSON.stringify(out.traced[0]));
  check('and the workspace, which is what the log line leads with', out.traced[0]?.workspace === 'demo', JSON.stringify(out.traced[0]));

  const note = wrote(bd, 'zz-13.1')[0]?.text || '';
  check('the comment on the stranded bead names the root', note.includes('zz-13'), note.slice(0, 120));
  check('quotes the root’s title, so it is readable without opening it', note.includes('the merge queue reads no checks as green'), note.slice(0, 200));
  check('uses the one spelling of the refusal, so a grep finds the pill and the note together', note.includes('nothing decided above this'), note.slice(0, 300));
  check('names the fix rather than only the fault', /adopt it under an open epic/i.test(note), note.slice(-300));
  check('and ends in the fixed sentence the duplicate guard matches', note.trim().endsWith(`${STRANDED_MARK}, noticed by lib/rootclose.js`), note.slice(-120));

  check('the root is told once, whatever the child count', out.roots.length === 1, JSON.stringify(out.roots));
  const onRoot = wrote(bd, 'zz-13')[0]?.text || '';
  check('and its note lists what it left behind, by id and status', onRoot.includes('zz-13.1') && onRoot.includes('(open)'), onRoot.slice(0, 300));
  check('with its own fixed sentence', onRoot.trim().endsWith(`${STRANDING_MARK}, noticed by lib/rootclose.js`), onRoot.slice(-120));
  check('nothing is written anywhere else', bd.written.length === 2, JSON.stringify(bd.written.map((w) => w.id)));
}

/* ------------------------------------------------------- 3. saying it exactly once */

console.log('\nsaid once — within the run, and across a restart\n');

{
  const rows = [LIVE(), epicRow('zz-14', { status: 'closed' }), taskRow('zz-14.1', 'zz-14')];
  const bd = fakeBd({ graphs: [graphOf(rows), graphOf(rows), graphOf(rows)] });
  const watch = createStrandWatch({ bd });

  const first = await watch.sweep([WS]);
  check('the first pass writes', first.traced.length === 1, JSON.stringify(first.traced));
  const second = await watch.sweep([WS]);
  check('the second says nothing — the state has not changed, and neither has the answer', second.traced.length === 0, JSON.stringify(second.traced));
  check('and does not re-read the thread either: the ledger is what makes it free', bd.commentReads.filter((id) => id === 'zz-14.1').length === 1, JSON.stringify(bd.commentReads));
  check('the root is not told twice', bd.written.filter((w) => w.id === 'zz-14').length === 1, JSON.stringify(bd.written.map((w) => w.id)));
}

{
  // The restart case: a brand-new watch, with an empty ledger, over a tracker whose beads
  // already carry the note. A transition-based watcher cannot tell this from a fresh
  // stranding; reading the thread is what can.
  const rows = [LIVE(), epicRow('zz-15', { status: 'closed' }), taskRow('zz-15.1', 'zz-15')];
  const threads = {
    'zz-15.1': [`something else entirely\n\n— ${STRANDED_MARK}, noticed by lib/rootclose.js`],
    'zz-15': [`— ${STRANDING_MARK}, noticed by lib/rootclose.js`],
  };
  const bd = fakeBd({ graphs: [graphOf(rows)], threads });
  const out = await createStrandWatch({ bd }).sweep([WS]);
  check('a fresh daemon over a bead that was already told says nothing', out.traced.length === 0, JSON.stringify(out.traced));
  check('and writes nothing at all', bd.written.length === 0, JSON.stringify(bd.written));
}

{
  const rows = [LIVE(), epicRow('zz-16', { status: 'closed' }), taskRow('zz-16.1', 'zz-16')];
  const bd = fakeBd({ graphs: [graphOf(rows)], failComments: (id) => id === 'zz-16.1' });
  const out = await createStrandWatch({ bd }).sweep([WS]);
  check('a thread that will not answer reads as already said — a duplicate is worse than a late note', out.traced.length === 0, JSON.stringify(out.traced));
  check('so nothing is written', bd.written.length === 0, JSON.stringify(bd.written));
}

{
  // A root already told, over a child that has not been. The child still gets its note; the
  // root does not get a second one.
  const rows = [LIVE(), epicRow('zz-17', { status: 'closed' }), taskRow('zz-17.1', 'zz-17')];
  const threads = { 'zz-17': [`— ${STRANDING_MARK}, noticed by lib/rootclose.js`] };
  const bd = fakeBd({ graphs: [graphOf(rows)], threads });
  const out = await createStrandWatch({ bd }).sweep([WS]);
  check('a newly stranded bead under an already-told root is still told', out.traced.length === 1, JSON.stringify(out.traced));
  check('and the root is not told again', out.roots.length === 0 && wrote(bd, 'zz-17').length === 0, JSON.stringify(bd.written.map((w) => w.id)));
}

/* --------------------------------------------------- 4. every failure is an outcome */

console.log('\nnothing here throws, and nothing here is silent\n');

{
  const bd = fakeBd({ graphs: [new Error('bd export timed out')] });
  const out = await createStrandWatch({ bd }).sweep([WS]);
  check('a tracker that cannot be read lands in the outcome rather than the cycle’s catch', out.errors.length === 1, JSON.stringify(out));
  check('naming the workspace', out.errors[0]?.workspace === 'demo', JSON.stringify(out.errors[0]));
  check('and writes nothing on a graph it could not read', bd.written.length === 0, JSON.stringify(bd.written));
}

{
  const bd = fakeBd({ graphs: [{ error: 'timed out', beads: new Map(), parents: new Map() }] });
  const out = await createStrandWatch({ bd }).sweep([WS]);
  check('an export that came back empty carrying `.error` is the same answer, not a whole workspace stranded', out.errors.length === 1 && bd.written.length === 0, JSON.stringify(out));
}

{
  const rows = [LIVE(), epicRow('zz-18', { status: 'closed' }), taskRow('zz-18.1', 'zz-18'), taskRow('zz-18.2', 'zz-18')];
  const bd = fakeBd({ graphs: [graphOf(rows)], failComment: (id) => id === 'zz-18.1' });
  const out = await createStrandWatch({ bd }).sweep([WS]);
  check('a refused comment is an error in the outcome', out.errors.some((e) => e.id === 'zz-18.1'), JSON.stringify(out.errors));
  check('and does not stop the bead beside it being told', out.traced.map((t) => t.id).join(',') === 'zz-18.2', JSON.stringify(out.traced));
}

{
  const rows = [LIVE(), epicRow('zz-19', { status: 'closed' }), taskRow('zz-19.1', 'zz-19')];
  const bd = fakeBd({ graphs: [graphOf(rows), graphOf(rows)], failComment: (id) => id === 'zz-19.1' });
  const watch = createStrandWatch({ bd });
  await watch.sweep([WS]);
  const again = await watch.sweep([WS]);
  check('a bead whose comment was refused is tried again next pass — the ledger records writes, not attempts', again.errors.some((e) => e.id === 'zz-19.1'), JSON.stringify(again));
  check('and the root is never told over a pass that told nobody', bd.written.length === 0, JSON.stringify(bd.written.map((w) => w.id)));
}

{
  const rows = [LIVE(), epicRow('zz-20', { status: 'closed' })];
  for (let i = 1; i <= TRACE_CAP + 5; i += 1) rows.push(taskRow(`zz-20.${i}`, 'zz-20'));
  const bd = fakeBd({ graphs: [graphOf(rows), graphOf(rows)] });
  const watch = createStrandWatch({ bd });

  const first = await watch.sweep([WS]);
  check('one pass writes no more than the cap', first.traced.length === TRACE_CAP, String(first.traced.length));
  check('and says out loud that it stopped there', first.capped.join(',') === 'demo', JSON.stringify(first.capped));
  check('and the root is not told over a pass the cap cut short — its note would be false today and true in a minute', first.roots.length === 0 && wrote(bd, 'zz-20').length === 0, JSON.stringify(first.roots));
  const second = await watch.sweep([WS]);
  check('the rest are taken on the next pass rather than dropped', second.traced.length === 5, String(second.traced.length));
  check('which no longer needs the cap', second.capped.length === 0, JSON.stringify(second.capped));
  check('and that is the pass the root is told on', second.roots.length === 1 && second.roots[0]?.stranded === TRACE_CAP + 5, JSON.stringify(second.roots));
}

{
  const many = [LIVE(), epicRow('zz-21', { status: 'closed' })];
  for (let i = 1; i <= 24; i += 1) many.push(taskRow(`zz-21.${i}`, 'zz-21'));
  const note = strandingNote(strandingsIn(graphOf(many))[0]);
  check('the note on the root stops listing at twenty and says how many it did not name', note.includes('…and 4 more'), note.slice(0, 200));
  check('while still leading with the true total', note.includes('left 24 open bead(s)'), note.split('\n')[0]);
}

{
  const bead = { id: 'zz-22.1', title: 'a bead', status: 'open' };
  check('a root with no title is named by id alone rather than by an empty quote', !strandedNote('zz-22', '', bead).includes('("")'), strandedNote('zz-22', '', bead).slice(0, 120));
}

/* ------------------------------------------------- 5. wired into the cycle, and loud */

console.log('\nwired into the poll cycle, and reported when it breaks\n');

{
  const server = read('lib/server.js');
  check('the watcher is built once, beside the epic watch', /const strandWatch = createStrandWatch\(\{ bd \}\)/.test(server));
  check('and hung on the app, which is how the cycle reaches it', /^\s*strandWatch,$/m.test(server));
  check('the cycle calls it', /await sweepStranded\(\);/.test(server));
  check('inside a catch that reports rather than swallows', /\[stranded\] sweep failed[\s\S]{0,120}sweepFailed\('the stranded-bead sweep', err\)/.test(server));
  check('a traced bead is a line in the log — the trace the bead asks for', /console\.log\(`\[stranded\] \$\{bead\.workspace\}: \$\{bead\.id\}/.test(server));
  check('and a pass cut short by the cap is one too', /stopped at the cap for this pass/.test(server));

  const crash = read('test/crash.mjs');
  check('and the crash suite knows the label exists', crash.includes("'the stranded-bead sweep'"));
}

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
