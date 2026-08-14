#!/usr/bin/env node
/**
 * The `Adopts:` parser — which ids an epic actually claims, and which it merely mentions.
 *
 *     npm test
 *     node test/adopts.mjs
 *
 * lib/adopts.js is read by two things that must not disagree: the close gate, which
 * refuses an epic over a list nothing applied, and the applier that reparents the named
 * beads. Disagreement is worse than either being absent — an epic held closed over an
 * adoption the applier does not believe in cannot be fixed from the phone.
 *
 * The cases that matter are all about **where the list stops**. Every one of the seven
 * real lists is followed by prose that names more beads — "bc-297u and bc-syzm are the
 * same duplicate-`.chip` bug filed twice" — and adopting those would reparent beads the
 * author was explaining rather than claiming. The fixtures below are the real lines from
 * bc-ka5y, bc-huk9 and bc-4m2j, trimmed only in length.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { adoptedIds, adoptedBy } = await import(path.join(HERE, '..', 'lib', 'adopts.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const same = (name, got, want) => check(name, got.join(',') === want.join(','), `got ${got.join(',') || '(none)'}`);

console.log('\nthe Adopts: line\n');

/* ------------------------------------------------------------------ the shape */

same('one line, comma separated', adoptedIds('Adopts: bc-7utr, bc-04wd, bc-297u.'), ['bc-7utr', 'bc-04wd', 'bc-297u']);

same(
  // bc-ka5y, as written: twenty-three ids wrapped over three lines.
  'a list that wraps over lines is still one list',
  adoptedIds('Adopts: bc-7utr, bc-04wd, bc-297u,\nbc-syzm, bc-izs0, bc-5orx,\nbc-jdwc.'),
  ['bc-7utr', 'bc-04wd', 'bc-297u', 'bc-syzm', 'bc-izs0', 'bc-5orx', 'bc-jdwc']
);

same('the connective agents write', adoptedIds('Adopts: bc-a1, bc-b2 and bc-c3.'), ['bc-a1', 'bc-b2', 'bc-c3']);

same('a dotted child is adopted as itself, not as its parent', adoptedIds('Adopts: bc-arj0.3, bc-rfnr.9.1.'), ['bc-arj0.3', 'bc-rfnr.9.1']);

same('any workspace prefix, since a graph is not always bc-', adoptedIds('Adopts: cl-d4u, al-hfk, sp-9q.'), ['cl-d4u', 'al-hfk', 'sp-9q']);

same('written as a bullet under a heading', adoptedIds('## What it holds\n\n- Adopts: bc-a1, bc-b2.\n'), ['bc-a1', 'bc-b2']);

same('case is not part of an id', adoptedIds('ADOPTS: BC-A1, bc-B2.'), ['bc-a1', 'bc-b2']);

same('the same id twice is one adoption', adoptedIds('Adopts: bc-a1, bc-a1, bc-b2.'), ['bc-a1', 'bc-b2']);

/* -------------------------------------------------------------- where it stops */

same(
  // bc-ka5y's own next paragraph. These two are *explained*, not adopted — and they are
  // already in the list above, so the failure this catches is subtler than a wrong id:
  // it is a list that keeps reading into the argument underneath it.
  'the prose under the list is not part of it',
  adoptedIds('Adopts: bc-7utr, bc-04wd.\n\nbc-297u and bc-syzm are the same duplicate bug filed twice; bc-767a\nand bc-giuc are the same missing disarm.'),
  ['bc-7utr', 'bc-04wd']
);

same(
  // bc-huk9 puts this immediately under its list with no blank line between.
  'a sentence starting on the very next line stops it too',
  adoptedIds('Adopts: bc-xecw, bc-xmdw, bc-itf8, bc-l8f6.\n**Verified 2026-08-12 against main at 45b21f58: all three criteria are on main.**'),
  ['bc-xecw', 'bc-xmdw', 'bc-itf8', 'bc-l8f6']
);

same(
  'a note in the middle ends the list where the note begins',
  adoptedIds('Adopts: bc-r87b, bc-3qsw.\nNote bc-1ci5 and bc-uaug are the same bug filed twice.'),
  ['bc-r87b', 'bc-3qsw']
);

same('an id mentioned anywhere else is not an adoption', adoptedIds('This sits in bc-42ow neighbourhood and supersedes bc-767a.'), []);

same('mid-sentence, the word is prose', adoptedIds('Whatever this epic adopts: it is not a list.'), []);

same('nothing at all', adoptedIds(''), []);
same('a description with no line', adoptedIds('An epic about the tracker holding structure.'), []);

same(
  // Nothing writes two today. A description edited twice easily could, and taking only
  // the first would silently drop whatever was added most recently.
  'two lines are read as one list',
  adoptedIds('Adopts: bc-a1, bc-b2.\n\nSome argument.\n\nAdopts: bc-c3.'),
  ['bc-a1', 'bc-b2', 'bc-c3']
);

/* ------------------------------------------------------------------ the issue */

{
  const ids = adoptedBy({ id: 'bc-ka5y', issue_type: 'epic', description: 'Adopts: bc-a1, bc-b2.' });
  same('an issue is read through its description', ids, ['bc-a1', 'bc-b2']);
}

{
  const ids = adoptedBy({ id: 'bc-x', description: 'Adopts: bc-a1.', notes: 'Adopts: bc-b2.', acceptance_criteria: 'Adopts: bc-c3.' });
  same('and through the other fields a line gets written into', ids, ['bc-a1', 'bc-b2', 'bc-c3']);
}

{
  // A typo, not a cycle: an epic naming itself would otherwise be a bead the gate can
  // never let close, since it can never become its own child.
  const ids = adoptedBy({ id: 'bc-x', description: 'Adopts: bc-x, bc-a1.' });
  same('an epic naming itself does not hold itself open', ids, ['bc-a1']);
}

check('a missing issue is no adoptions rather than a throw', adoptedBy(null).length === 0);

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
