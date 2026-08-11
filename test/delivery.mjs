#!/usr/bin/env node
/**
 * lib/delivery.js — the `beadpr` block, and the four words that act on it.
 *
 *     npm test
 *     node test/delivery.mjs
 *
 * No gh, no network, no temp files: this is all parsing, which is exactly why it is
 * worth pinning. The block is the thing that survives between a session ending and
 * Adam answering hours later, and every field in it is read back by a *different*
 * process than wrote it.
 *
 * The failure that matters most is not a crash. It is consent widening:
 *
 *     deliveryAction('I think we should MERGE: it')
 *
 * If that ever returns `{action: 'merge'}`, a sentence Adam typed as a comment
 * merges a pull request. `startsWith` is the whole safeguard, and nothing about the
 * code makes that obvious enough to be safe from a well-meaning refactor toward
 * `includes` or a case-insensitive compare. So it is tested from both ends: the
 * marker must be at the start, and it must be the exact case.
 *
 * Second: the fence. A delivery body carries a ```decision block *and* a ```beadpr
 * block, and splitDelivery removes only the second. A greedy match there would eat
 * the options on the way past, and the card would render with no buttons — which
 * looks like a question nobody can answer rather than a bug. So the block order is
 * tested both ways round, since only one of them is the one you happen to generate.
 *
 * Third: the first paragraph. A worker merges its own pull request now, so one of these
 * cards means something went differently — GitHub refused the merge, the space it is in
 * asks for an approving review and has not got one, or the session asked for a human on
 * purpose — and the four openings must not collapse into one polite sentence. A card
 * that cannot say which of them happened is a card that invites a puzzled look at a
 * green pull request. The approval one is the newest and the easiest to lose: without a
 * sentence of its own it reads as *auto-merge is off*, which is a fact about a switch
 * that is emphatically on, and sends you hunting for a setting already set the way you
 * want it.
 *
 * Fourth: an unparseable block must be an `error`, never a `null`. Null is the answer
 * for every ordinary question in the inbox, so a delivery that degrades to null does
 * not look broken — it looks like an ordinary question, and pressing merge on it
 * silently does nothing, on the one card where that matters most.
 *
 * Fifth, and newest: **`MERGE:` must never widen into `SHIP:`**. Ship is the same merge
 * plus the repo's declared deploy, so it changes what is *running* — and on this repo
 * that means SIGKILLing the daemon. Two things are pinned here because of it: the
 * markers are distinct prefixes and neither is a prefix of the other, and the Ship
 * option only appears when a deploy was actually found. A card that offers Ship in a
 * repo with nothing declared is a button that merges and then reports a failure,
 * which is the worst of both answers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib', 'delivery.js');

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const {
  deliveryAction,
  splitDelivery,
  parseDelivery,
  deliveryBody,
  deliveryTitle,
  cardsForDelivery,
  DELIVERY_LABEL,
  MERGE_MARKER,
  SHIP_MARKER,
  CHANGES_MARKER,
  DECLINE_MARKER,
} = await import(LIB);

/** What `deployHint` hands over for this repo. The card never invents its own. */
const HINT = 'runs `launchctl` · rebuilds apk · restarts beadcause';

/** A delivery as a worker files it. */
const D = (over = {}) => ({
  workspace: 'beadcause',
  bead: 'bc-7qo',
  repo: 'mordam/beadcause',
  number: 42,
  url: 'https://github.com/mordam/beadcause/pull/42',
  branch: 'bead/bc-7qo-delivery',
  base: 'main',
  method: 'squash',
  summary: 'The gh wrapper, the beadpr block, and the two worker CLIs.',
  tests: 'npm test — 42 passing',
  risk: 'The poller now runs gh on every tick.',
  left: 'The worktree sweep still retires on main, not on merge.',
  ...over,
});

const block = (yaml) => ['```beadpr', yaml, '```'].join('\n');

/* ------------------------------------------------------------ the three words */

console.log('\nwhat counts as consent');

check('MERGE: merges', deliveryAction('MERGE: squash and merge #42.').action === 'merge');
check('CHANGES: asks for changes', deliveryAction('CHANGES: not yet.').action === 'changes');
check('DECLINE: declines it', deliveryAction('DECLINE: close #42 — not this approach.').action === 'decline');
check('SHIP: merges and deploys', deliveryAction('SHIP: squash and merge #42, then deploy beadcause.').action === 'ship');
check(
  'and the exported markers are the ones it matches',
  MERGE_MARKER === 'MERGE:' && SHIP_MARKER === 'SHIP:' && CHANGES_MARKER === 'CHANGES:' && DECLINE_MARKER === 'DECLINE:'
);
// The widening that matters. Ship is merge *and a deploy*, so an answer that means one
// must never resolve to the other — not by prefix, not by a sentence appended to it.
check(
  'the four markers are four distinct prefixes, none of them a prefix of another',
  [MERGE_MARKER, SHIP_MARKER, CHANGES_MARKER, DECLINE_MARKER].every(
    (a, i, all) => all.filter((b, j) => j !== i && (a.startsWith(b) || b.startsWith(a))).length === 0
  )
);
check('a merge that mentions shipping is still only a merge', deliveryAction('MERGE: ship it after').action === 'merge');
check('and typing SHIP mid-sentence deploys nothing', deliveryAction('yes, SHIP: it') === null);
check('nor does the lowercase spelling', deliveryAction('ship: go on then') === null);

// The direction for the next attempt is the whole value of a decline, so it has to
// survive verbatim — and an empty one is still a valid decline.
check(
  'a decline carries its direction verbatim',
  deliveryAction('DECLINE: do it in the poller instead, not the router.').note === 'do it in the poller instead, not the router.',
  deliveryAction('DECLINE: do it in the poller instead, not the router.').note
);
check(
  'and a decline with no direction is still a decline',
  deliveryAction('DECLINE:').action === 'decline' && deliveryAction('DECLINE:').note === '',
  JSON.stringify(deliveryAction('DECLINE:'))
);

check(
  'a marker in the middle of a sentence is a comment, not a merge — this is the whole consent model',
  deliveryAction('I think we should MERGE: it') === null,
  JSON.stringify(deliveryAction('I think we should MERGE: it'))
);
check(
  'and so is a marker at the end',
  deliveryAction('do whatever you think best, MERGE:') === null,
  JSON.stringify(deliveryAction('do whatever you think best, MERGE:'))
);
check('ordinary approval is not consent — "looks good" is a comment, which is what it looks like', deliveryAction('looks good to me') === null);
check('nor is the word on its own without the colon', deliveryAction('MERGE it') === null);
check(
  'lower case is not consent either — the phone and the ntfy button both send the exact string',
  deliveryAction('merge: do it') === null,
  JSON.stringify(deliveryAction('merge: do it'))
);
check('an empty answer is not consent', deliveryAction('') === null);
check('and neither is no answer at all', deliveryAction(null) === null && deliveryAction(undefined) === null);

check(
  'leading whitespace is forgiven, because a phone keyboard adds it',
  deliveryAction('   \n MERGE: go') !== null && deliveryAction('   \n MERGE: go').action === 'merge'
);

const note = deliveryAction('CHANGES:   the rollup should not count skipped as passing.  ');
check('the note is everything after the marker', note.note === 'the rollup should not count skipped as passing.', JSON.stringify(note.note));
check('a marker with nothing after it is still an action, with an empty note', deliveryAction('MERGE:').note === '');
check(
  'and the note is kept verbatim, because "change what?" is the whole content of the answer',
  deliveryAction('CHANGES: Use `pr.base`, NOT pr.baseRefName.').note === 'Use `pr.base`, NOT pr.baseRefName.'
);

/* -------------------------------------------------------------- the block */

console.log('\nreading the beadpr block');

const body = deliveryBody(D());
const parsed = parseDelivery(body);

check('a body generated here parses back', parsed !== null && parsed.error === null, JSON.stringify(parsed && parsed.error));
check('the pull request number survives', parsed.number === 42);
check('so does the bead the work was for', parsed.bead === 'bc-7qo');
check('and the workspace, repo, branch and base', parsed.workspace === 'beadcause' && parsed.repo === 'mordam/beadcause' && parsed.branch === 'bead/bc-7qo-delivery' && parsed.base === 'main');
check('the prose fields round-trip', parsed.tests === 'npm test — 42 passing' && parsed.risk === 'The poller now runs gh on every tick.');
check('including what the session left undone', parsed.left === 'The worktree sweep still retires on main, not on merge.');
check('and the summary, across its newline', parsed.summary === 'The gh wrapper, the beadpr block, and the two worker CLIs.');

check('a body with no block at all is null — the answer for every ordinary question', parseDelivery('Just a question.') === null);
check('and so is no body', parseDelivery('') === null && parseDelivery(null) === null);

check('~~~ fences work as well as backticks', parseDelivery(['~~~beadpr', 'number: 7', '~~~'].join('\n')).number === 7);

/* ------------------------------------------------- when the block is wrong */

console.log('\nwhen the block is wrong, it says so rather than vanishing');

const noNumber = parseDelivery(block('bead: bc-7qo\nbranch: x'));
check('a block naming no pull request is an error, not a null', noNumber !== null && !!noNumber.error, JSON.stringify(noNumber));
check('and the error says which thing is missing', /pull request number/.test(noNumber.error), noNumber.error);

check('a zero is not a pull request number', !!parseDelivery(block('number: 0')).error);
check('nor is a negative one', !!parseDelivery(block('number: -3')).error);
check('nor is a word', !!parseDelivery(block('number: soon')).error);
check('nor is a fraction', !!parseDelivery(block('number: 4.5')).error);

const badYaml = parseDelivery(block('number: 42\n  bead: [unclosed'));
check('a block that is not YAML is an error', badYaml !== null && !!badYaml.error, JSON.stringify(badYaml));
check('naming YAML, so the worker knows what to fix', /YAML/.test(badYaml.error), badYaml.error);
check('and only the first line of the parser complaint, not its diagram', !/\n/.test(badYaml.error), JSON.stringify(badYaml.error));

const empty = parseDelivery(block(''));
check('an empty block is an error', empty !== null && !!empty.error, JSON.stringify(empty));
check('a block holding a bare string is an error too', !!parseDelivery(block('just some text')).error);

check(
  'every error carries only .error, so a caller that checks it cannot then read a half-built delivery',
  noNumber.number === undefined && noNumber.url === undefined,
  JSON.stringify(noNumber)
);
check('while a good one sets .error to null rather than leaving it off', parsed.error === null);

/* ------------------------------------------------------------ the fallbacks */

console.log('\nwhat it will accept from a worker writing the block by hand');

const fromUrl = parseDelivery(block('url: https://github.com/mordam/beadcause/pull/91'));
check('the number is dug out of the url when the field is absent', fromUrl.number === 91, JSON.stringify(fromUrl));
check('and the url is kept as given', fromUrl.url === 'https://github.com/mordam/beadcause/pull/91');
check('`pr:` works as an alias for `number:`', parseDelivery(block('pr: 13')).number === 13);
check(
  'an explicit number wins over the one in the url, since it is the one every later call uses',
  parseDelivery(block('number: 7\nurl: https://github.com/mordam/beadcause/pull/91')).number === 7
);
check('a url that is not a pull request url does not yield a number', !!parseDelivery(block('url: https://example.com/nope')).error);

check('base defaults to main', parseDelivery(block('number: 1')).base === 'main');
// `merge` and not `squash`, for the same reason `pr.mergeMethod` defaults to it: a
// squash merge is the one that leaves the branch a non-ancestor of main, and that is
// what every piece of worktree cleanup here tests before it removes anything.
check('method defaults to a merge commit', parseDelivery(block('number: 1')).method === 'merge');
check('merge and rebase are allowed through', parseDelivery(block('number: 1\nmethod: rebase')).method === 'rebase' && parseDelivery(block('number: 1\nmethod: merge')).method === 'merge');
check('case does not matter for the method', parseDelivery(block('number: 1\nmethod: REBASE')).method === 'rebase');
check(
  'a method nobody recognises falls back to the default rather than reaching gh as a usage error',
  parseDelivery(block('number: 1\nmethod: fast-forward')).method === 'merge'
);
check('`body:` is an alias for `summary:`', parseDelivery(block('number: 1\nbody: what changed')).summary === 'what changed');
check('`risks:` for `risk:`', parseDelivery(block('number: 1\nrisks: it might not')).risk === 'it might not');
check('`todo:` for `left:`', parseDelivery(block('number: 1\ntodo: the sweep')).left === 'the sweep');
check(
  'absent prose fields are empty strings, never undefined, so the card renders either way',
  parseDelivery(block('number: 1')).summary === '' && parseDelivery(block('number: 1')).tests === '' && parseDelivery(block('number: 1')).risk === ''
);
check('and absent identity fields are null, which is a different thing from empty', parseDelivery(block('number: 1')).bead === null && parseDelivery(block('number: 1')).repo === null);

/* ------------------------------------------------------------ splitting it */

console.log('\nsplitting the block off the body');

const split = splitDelivery(body);
check('the delivery comes out parsed', split.delivery !== null && split.delivery.number === 42);
// Tested by fence and by YAML key, not by the word: the summary is prose a worker
// wrote, and a worker describing the beadpr block would otherwise fail this.
check('the beadpr fence is gone from the body — no wall of YAML on a phone', !/```beadpr/.test(split.body), split.body.slice(-200));
check(
  'and so are the block’s own keys',
  !/^(workspace|branch|method):/m.test(split.body),
  (split.body.match(/^(workspace|branch|method):.*/m) || [])[0]
);
check('but the prose above it survives', /What changed/.test(split.body));
check(
  'including a summary that happens to talk about the beadpr block itself',
  /the beadpr block/.test(split.body),
  split.body
);

check(
  'and the ```decision block is left completely alone — decision.js parses what is left, and a greedy fence would eat the options',
  /```decision/.test(split.body) && /- id: merge/.test(split.body) && /- id: decline/.test(split.body),
  split.body
);
check(
  'every option in it is still intact after the split',
  (split.body.match(/^\s+- id: /gm) || []).length === 3,
  JSON.stringify(split.body.match(/^\s+- id: /gm))
);

// The generated body puts `decision` first. A hand-written one need not, and that
// is the order where a greedy match actually bites.
const reversed = [
  'Prose first.',
  '',
  block('number: 42\nbead: bc-7qo'),
  '',
  '```decision',
  'question: Merge it?',
  'options:',
  '  - id: merge',
  '    label: Merge',
  '```',
].join('\n');
const splitReversed = splitDelivery(reversed);
check('with the beadpr block first, it is still the one removed', splitReversed.delivery.number === 42 && !/beadpr/.test(splitReversed.body));
check(
  'and the decision block below it is untouched — this is the greedy-match regression',
  /```decision/.test(splitReversed.body) && /- id: merge/.test(splitReversed.body),
  splitReversed.body
);

const plain = splitDelivery('An ordinary question with no delivery.');
check('a body with no block splits to null and itself', plain.delivery === null && plain.body === 'An ordinary question with no delivery.');
check('and no body at all does not throw', splitDelivery(null).delivery === null && splitDelivery(undefined).body === '');

/* ------------------------------------------- what the phone is actually sent */

console.log('\nthe options the card offers are answers this file accepts');

const options = [...body.matchAll(/response: "([^"]+)"/g)].map((m) => m[1]);
check('the body offers three responses', options.length === 3, JSON.stringify(options));
// The default fixture declares no deploy, which is what most repos are. Offering Ship
// there would be offering a button whose whole content is a failure message.
check('and no Ship among them, because this fixture declares no deploy', !/SHIP:/.test(body), body);
for (const response of options) {
  const action = deliveryAction(response);
  check(`"${response.slice(0, 34)}…" is an action, not a comment`, action !== null, response);
}
check(
  'and they are the three distinct actions, so no button is a no-op',
  new Set(options.map((r) => deliveryAction(r).action)).size === 3,
  JSON.stringify(options.map((r) => deliveryAction(r) && deliveryAction(r).action))
);
check('the merge button carries the method the block asked for', /squash/.test(options[0]));

const rebaseOptions = [...deliveryBody(D({ method: 'rebase' })).matchAll(/response: "([^"]+)"/g)].map((m) => m[1]);
check('and follows it when the block says rebase', /rebase/.test(rebaseOptions[0]), rebaseOptions[0]);

/* ------------------------------------------------- the fourth option, when there is one */

console.log('\nShip it — offered only where there is a deploy to run');

const shipBody = deliveryBody(D(), { ship: HINT });
const shipOptions = [...shipBody.matchAll(/response: "([^"]+)"/g)].map((m) => m[1]);
check('a repo with a deploy gets four responses, not three', shipOptions.length === 4, JSON.stringify(shipOptions));
check(
  'and they are four distinct actions, so no button is a no-op or a duplicate',
  new Set(shipOptions.map((r) => deliveryAction(r)?.action)).size === 4,
  JSON.stringify(shipOptions.map((r) => deliveryAction(r)?.action))
);
// Four is what a phone can show. A fifth would make the card a menu, so the count is
// pinned rather than left to whoever adds the next lane.
check('four is the ceiling — nothing else crept in', shipOptions.length <= 4);
check(
  'merge is still first and ship is second, so the wider answer is not under the thumb',
  deliveryAction(shipOptions[0]).action === 'merge' && deliveryAction(shipOptions[1]).action === 'ship',
  JSON.stringify(shipOptions.slice(0, 2))
);
check('the ship response carries the workspace, so the card can say what it deploys', /deploy beadcause/.test(shipOptions[1]), shipOptions[1]);
check('and the method the block asked for, exactly as merge does', /squash and merge #42/.test(shipOptions[1]), shipOptions[1]);
check(
  'the hint on the button is what the deploy will actually run, not the word "deploy"',
  /hint: merge, then runs `launchctl` · rebuilds apk · restarts beadcause/.test(shipBody),
  (shipBody.match(/.*hint: merge.*/) || [])[0]
);
check(
  'the opening sentence names Ship only where it is offered',
  /\*\*Ship it\*\*/.test(shipBody) && !/\*\*Ship it\*\*/.test(body),
  shipBody.split('\n')[0]
);
check(
  'and the block underneath is unchanged — a deploy is not identity, it is this machine',
  !/ship|deploy/i.test(shipBody.split('```beadpr')[1] || ''),
  (shipBody.split('```beadpr')[1] || '').slice(0, 200)
);
check(
  'a ship body still parses back to the same delivery a merge body does',
  JSON.stringify(parseDelivery(shipBody)) === JSON.stringify(parseDelivery(body)),
  JSON.stringify(parseDelivery(shipBody))
);
check(
  'and the decision block survives the split, four options and all',
  /- id: ship/.test(splitDelivery(shipBody).body) && /- id: decline/.test(splitDelivery(shipBody).body)
);

check('the PR link is in the body for when the answer is "I need to see the diff"', body.includes('https://github.com/mordam/beadcause/pull/42'));
check('and the branch and base are shown, since that is what merging acts on', /bead\/bc-7qo-delivery/.test(body) && /main/.test(body));

/* -------------------------------------------------------- title, and the label */

console.log('\nthe one line that names it');

check('the title names the PR and the bead', deliveryTitle(D()) === 'Merge #42? bc-7qo', deliveryTitle(D()));
check('a PR title is preferred when there is one', deliveryTitle(D({ title: 'Branch-and-PR delivery' })) === 'Merge #42? Branch-and-PR delivery');
check(
  'and a long one is cut to something a list can show',
  deliveryTitle(D({ title: 'x'.repeat(400) })).length === 160,
  String(deliveryTitle(D({ title: 'x'.repeat(400) })).length)
);
check('the label is the one `bd list --label=` searches for', DELIVERY_LABEL === 'pr-delivery');

/* ------------------------------------------------- why this card exists at all */

console.log('\nthe first paragraph says which of the three things happened');

// A worker normally merges its own pull request, so a card in the inbox is now the
// exception — and the first thing to know is *which* exception. Four openings, and
// the failure worth testing is any two of them reading the same.
const refusedBody = deliveryBody(D(), { refused: '#42 conflicts with main — the branch needs a rebase before it can merge.' });
const approvalBody = deliveryBody(D(), { approval: true });
const askedBody = deliveryBody(D(), { asked: true });
const plainBody = deliveryBody(D());

check(
  'a refused merge leads with what stopped it, in the words of whatever refused',
  /tried to merge it/.test(refusedBody) && /conflicts with main/.test(refusedBody),
  refusedBody.split('\n')[0]
);
check(
  'and says outright that it is now Adam’s, since the worker has run out of moves',
  /So it is yours/.test(refusedBody),
  refusedBody.split('\n')[0]
);
check(
  'a worker that chose review says so, so green checks in the inbox do not read as a bug',
  /deliberately did not/.test(askedBody) && !/tried to merge/.test(askedBody),
  askedBody.split('\n')[0]
);
check(
  'and with autoMerge off it is the original sentence, unchanged',
  /Nothing is merged until you say so/.test(plainBody) && !/deliberately|tried to merge/.test(plainBody),
  plainBody.split('\n')[0]
);
check(
  'a green pull request waiting on a review says that, and does not claim anything refused it',
  /waiting on an approving review/.test(approvalBody) && !/tried to merge|deliberately did not/.test(approvalBody),
  approvalBody.split('\n')[0]
);
check(
  'and it says the tap is the review, since that is the whole of what answering does',
  /Your \*\*Merge\*\* is that review/.test(approvalBody),
  approvalBody.split('\n')[0]
);
check(
  'a refusal that actually happened outranks the policy that would have stopped one',
  /tried to merge it/.test(deliveryBody(D(), { refused: 'GitHub said no.', approval: true })) &&
    !/waiting on an approving review/.test(deliveryBody(D(), { refused: 'GitHub said no.', approval: true })),
  deliveryBody(D(), { refused: 'GitHub said no.', approval: true }).split('\n')[0]
);
check(
  'the four openings are four different sentences',
  new Set([refusedBody, approvalBody, askedBody, plainBody].map((b) => b.split('\n')[0])).size === 4
);
check(
  'a refusal is prose on the card and never a field in the block — the block is identity and intent',
  parseDelivery(refusedBody).error === null && !/refused|conflicts with/.test(refusedBody.split('```beadpr')[1] || ''),
  (refusedBody.match(/.*refused.*/) || [])[0]
);
check(
  'and every opening still ends up offering the same three answers',
  [refusedBody, approvalBody, askedBody, plainBody].every((b) => /id: merge/.test(b) && /id: changes/.test(b) && /id: decline/.test(b))
);
check(
  'and each of them gains Ship in a repo that has a deploy — the reason the card exists does not decide that',
  [{ refused: 'it conflicts' }, { asked: true }, {}].every((o) => /id: ship/.test(deliveryBody(D(), { ...o, ship: HINT })))
);
check(
  'the merge wording follows the block’s method rather than saying squash regardless',
  /rebase-merges it/.test(deliveryBody(D({ method: 'rebase' }), { asked: true })),
  deliveryBody(D({ method: 'rebase' }), { asked: true }).split('\n')[0]
);

/* ---------------------------------------- what the block deliberately omits */

console.log('\nwhat the block deliberately does not carry');

const roundTripped = parseDelivery(deliveryBody(D({ title: 'Branch-and-PR delivery' })));
check(
  'no diffstat, no checks, no mergeability — those are read live from gh, because a frozen one is a lie the moment anyone pushes',
  !/additions|changedFiles|statusCheckRollup|mergeable/.test(body),
  (body.match(/.*(additions|mergeable).*/) || [])[0]
);
check(
  'not even the PR title, which is gh state too — the block carries identity and intent',
  roundTripped.title === undefined,
  JSON.stringify(roundTripped.title)
);
check(
  'and empty fields are left out of the block rather than written as blanks',
  !/tests:/.test(deliveryBody(D({ tests: '', risk: '', left: '' }))),
  deliveryBody(D({ tests: '', risk: '', left: '' }))
);

/* ------------------------------------------------- one open ask at a time */

// bc-ec6 was delivered three times against #25 and produced three cards, each asking
// the same thing about the same pull request and each carrying an older version of the
// story. Two of them were then wrong — they described a conflict that had since been
// resolved — and answering the wrong one asks for a merge of a state that no longer
// exists. One card is a decision; three are a triage job.
//
// So a delivery finds what it is about to ask again and supersedes it, and `cardsForDelivery`
// is that half: given `bd list --label pr-delivery`, which of these open cards is this
// same question? The two ways to be the same question are tested separately, because
// only one of them was here before and the missing one is a pile the other cannot see.
console.log('\nwhat a re-delivery supersedes rather than filing beside');

const CARD = (id, over = {}, row = {}) => ({
  id,
  status: 'open',
  title: `Merge #${over.number ?? 42}?`,
  description: deliveryBody(D(over)),
  ...row,
});

{
  // The common one: the same branch, so the same pull request, delivered again before
  // anybody answered.
  const rows = [CARD('q-1'), CARD('q-2', { number: 43, url: 'https://github.com/mordam/beadcause/pull/43', bead: 'bc-other' })];
  const found = cardsForDelivery(rows, { repo: 'mordam/beadcause', number: 42, bead: 'bc-7qo' }).map((c) => c.id);
  check('the open card for this pull request is the one this delivery replaces', found.join(',') === 'q-1', found.join(','));
}

{
  // The one matching on the number alone cannot see: the branch was abandoned and the
  // same work delivered on a new pull request, so the first card is still in the inbox
  // pointing at a merge nobody is going to make.
  const rows = [CARD('q-old', { number: 25, url: 'https://github.com/mordam/beadcause/pull/25' })];
  const found = cardsForDelivery(rows, { repo: 'mordam/beadcause', number: 99, bead: 'bc-7qo' });
  check('a card for the same bead on an older pull request is superseded too', found.map((c) => c.id).join(',') === 'q-old', JSON.stringify(found));
  check(
    'and it hands back the number it asked about, so the close reason can name it rather than look like the wrong card',
    found[0]?.number === 25,
    JSON.stringify(found[0])
  );
  check('a bead this delivery is not for is left alone', cardsForDelivery(rows, { repo: 'mordam/beadcause', number: 99, bead: 'bc-else' }).length === 0);
}

{
  const rows = [
    CARD('q-1'),
    CARD('q-2'),
    CARD('q-closed', {}, { status: 'closed' }),
    { id: 'q-plain', status: 'open', title: 'An ordinary question', description: 'Which of these two?' },
  ];
  const found = cardsForDelivery(rows, { repo: 'mordam/beadcause', number: 42, bead: 'bc-7qo' }).map((c) => c.id);
  // The pile that is already in the inbox: every one of them comes back, because the
  // caller closes all of them and files one. Leaving the second is the bug.
  check('every open card for this delivery comes back, not just the first', found.join(',') === 'q-1,q-2', found.join(','));
  check('an answered card is not asked again', !found.includes('q-closed'), found.join(','));
  check('and an ordinary question in the inbox is not a delivery card', !found.includes('q-plain'), found.join(','));
}

{
  const rows = [CARD('q-1')];
  check('the same number in another repo is a coincidence, not a duplicate', cardsForDelivery(rows, { repo: 'someone/else', number: 42 }).length === 0);
  check('ids are matched whatever their case', cardsForDelivery(rows, { bead: 'BC-7QO' }).length === 1);
  // A caller with nothing to compare must match nothing. Matching everything here
  // would close every card in the inbox on the way to filing one.
  check('no number and no bead matches nothing at all', cardsForDelivery(rows, {}).length === 0);
  check('and neither does a number that is not one', cardsForDelivery(rows, { number: 0 }).length === 0 && cardsForDelivery(rows, { number: -1 }).length === 0);
  check('no rows at all is an empty answer rather than a throw', cardsForDelivery(null, { bead: 'bc-7qo' }).length === 0);
}

const src = fs.readFileSync(LIB, 'utf8');
check(
  'nothing in lib/delivery.js shells out or reaches the network — it is parsing, and stays parsing',
  !/child_process|execFile|spawn|fetch\(/.test(src),
  (src.match(/.*(child_process|execFile|fetch\().*/) || [])[0]
);

/* ------------------------------------------------------------------ verdict */

console.log('');
if (failures) {
  console.log(`${failures} check${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('all checks passed');
