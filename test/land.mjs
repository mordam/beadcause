#!/usr/bin/env node
/**
 * lib/session.js — the three endings a worker can be given, and what each may claim.
 *
 *     npm test
 *     node test/land.mjs
 *
 * The brief is the entire interface between this daemon and an unattended agent. There
 * is no API, no hook and no supervisor: everything beadcause gets a worker to do, it
 * does by writing a sentence in a markdown file and handing it to `claude`. So the
 * sentences are the behaviour, and they are worth asserting.
 *
 * Three failures are worth this file, in descending order of how much damage they do:
 *
 * 1. **A brief that tells a session to merge `main` by hand.** The one thing that must
 *    never come back. Five sessions run on this laptop at once; five `git merge`s into a
 *    local `main` race each other, and every conflict from that lands on Adam hours
 *    later in a repo he had not been reading. That race is the reason pull requests
 *    exist here, and a worker merging its own work does not undo it — the merge happens
 *    at GitHub, which serialises. A brief drifting back toward `git merge main` is the
 *    regression this file exists for.
 * 2. **A marker line claiming a step the session did not take.** `** BEAD WORK DONE **`
 *    is prose for a human scrolling a wall of windows, and its whole value is that it is
 *    honest: `CAN BE MERGED` from a session whose work is already in `main` is noise,
 *    and `CAN BE CLOSED` over an unmerged branch is worse — it says finished work is
 *    live when it is sitting in a pull request nobody has looked at. Each of the three
 *    endings can honestly claim a different set of verbs, so each is checked for the
 *    ones it must name and the ones it must not.
 * 3. **The brief and the command disagreeing.** The brief promises what
 *    `beadcause-deliver` will do. If `pr.autoMerge` is off and the brief still says "it
 *    merges it", the session reports work as landed and the bead says otherwise. So the
 *    flag is followed from `prMode` — where it is read off the config — all the way to
 *    which ending gets written.
 *
 * The `gh` on PATH here is a fake that answers two questions and nothing else, because
 * `prMode` asks exactly two: is gh usable, and does this directory have a GitHub remote.
 * Nothing here opens a window, spawns an agent, touches a bead or reaches the network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib', 'session.js');

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ---------------------------------------------------------------- a fake gh */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-land-'));
const BIN = path.join(tmp, 'bin');
const REPO = path.join(tmp, 'repo');
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/bin/sh
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view") echo '{"nameWithOwner":"mordam/beadcause"}' ; exit 0 ;;
esac
echo "unexpected gh: $*" >&2
exit 1
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const { workPromptFor, prMode } = await import(LIB);

const BEAD = { id: 'bc-fmt', title: 'Workers land their own work when the bead is done' };
const OWNER = 'Adam';
const MODE = (over = {}) => ({
  repo: 'mordam/beadcause',
  base: 'main',
  method: 'squash',
  autoMerge: true,
  deliver: 'node /opt/beadcause/bin/deliver.js',
  propose: 'node /opt/beadcause/bin/propose.js',
  ...over,
});

const land = workPromptFor('beadcause', BEAD, 1, MODE(), OWNER);
const ask = workPromptFor('beadcause', BEAD, 1, MODE({ autoMerge: false }), OWNER);
const none = workPromptFor('beadcause', BEAD, 1, null, OWNER);

/* ------------------------------------------- the ending where it lands its own work */

console.log('\nthe ordinary ending: it lands its own work');

check(
  'the brief names the delivery command, with this workspace and this bead in it',
  land.includes('node /opt/beadcause/bin/deliver.js -w beadcause -b bc-fmt'),
  (land.match(/.*deliver\.js.*/) || [])[0]
);
check('and says what the command actually does — including the merge', /squash-merges it into \\?`main\\?`/.test(land), (land.match(/.*merges it into.*/) || [])[0]);
check(
  'it downmerges main into the branch first, which is the only place a conflict can be fixed properly',
  /git merge origin\/main/.test(land) && /re-run the tests afterwards/.test(land),
  (land.match(/.*git merge.*/) || [])[0]
);
check('it offers --owed, which is where a deploy still owed gets recorded', /--owed/.test(land));
check('and --review, the one escalation a worker may make on its own judgement', /--review/.test(land));
check('a refused merge is described as a finished session, not a failed one', /you are finished anyway/.test(land));
check('and the session is told not to rebase or retry after one', /Do not rebase, do not re-run CI, do not try again/.test(land));
check('the bead is not the session’s to close — the delivery closes it with the merge', /Do not close bc-fmt yourself/.test(land));

// The one that must never come back.
// The one that must never come back. Note the direction: `git merge origin/main` on the
// worker's own branch is the *good* one and is asked for above — what must never appear
// is a command block that stands on `main` and writes to it.
const commands = land.split('\n').filter((l) => /^ {4}\S/.test(l));
check(
  'nothing in it tells a session to merge or push main by hand',
  /Never merge or push \\?`main\\?` yourself/.test(land) &&
    !commands.some((l) => /^ {4}git (merge|push|checkout|switch)\b.*\bmain\b/.test(l) && !/origin\/main/.test(l)),
  commands.filter((l) => /\bmain\b/.test(l)).join(' | ')
);
check(
  'and it says why, because a rule with no reason is one an agent talks itself out of',
  /race each other/.test(land) && /GitHub does not race/.test(land)
);

check('the marker names the two steps that can still be owed', /\*\* BEAD WORK DONE \*\* CAN BE DEPLOYED, REBUILT \*\*/.test(land));
check('and REVIEWED, for the delivery that did not merge', /\*\*REVIEWED\*\*/.test(land));
check('and CAN BE CLOSED, the one line that means nothing is left', /\*\* BEAD WORK DONE \*\* CAN BE CLOSED \*\*/.test(land));
check(
  'it never offers CAN BE MERGED or CAN BE PUSHED — the delivery did both, through GitHub',
  !/CAN BE MERGED/.test(land) && !/CAN BE PUSHED/.test(land),
  (land.match(/.*CAN BE (MERGED|PUSHED).*/) || [])[0]
);
check(
  'and says so outright, so a session does not reason its way back to naming them',
  /MERGED and PUSHED are never on this\s+list/.test(land)
);

/* ------------------------------------------------- the ending where the merge is a tap */

console.log('\nwith pr.autoMerge off, the merge is Adam’s tap again');

check('the brief goes back to delivering rather than landing', /you do not merge it — you deliver it/.test(ask));
check('and to the review that is all such a session can owe', /\*\* BEAD WORK DONE \*\* CAN BE REVIEWED \*\*/.test(ask));
check(
  'it claims no deploy and no rebuild, because it has not merged anything',
  !/CAN BE DEPLOYED/.test(ask) && !/CAN BE REBUILT/.test(ask),
  (ask.match(/.*CAN BE.*/) || [])[0]
);
check('the bead still is not its to close', /Do not close bc-fmt/.test(ask));
check('and the two briefs are genuinely different documents', land !== ask);

/* ------------------------------------------------------ and where there is no remote */

console.log('\nwith nowhere to open a pull request, the old ending is untouched');

check('it closes its own bead, because nothing else will', /bd close bc-fmt --reason/.test(none));
check('the marker keeps all four verbs', /\*\* BEAD WORK DONE \*\* CAN BE MERGED, PUSHED, DEPLOYED \*\*/.test(none));
check('and it names them without doing them, which is still the rule here', /Name them; do not do them/.test(none));
check('no delivery command is mentioned at all', !/deliver\.js/.test(none));
check('and no pull request is promised', !/pull request/.test(none), (none.match(/.*pull request.*/) || [])[0]);

/* ------------------------------------------------ what every ending says regardless */

console.log('\nwhat every ending says, whichever it is');

for (const [name, brief] of [
  ['lands its own work', land],
  ['asks first', ask],
  ['no remote', none],
]) {
  const all =
    /bd update bc-fmt --claim/.test(brief) &&
    /read this repo's own CLAUDE\.md/.test(brief) &&
    /bc-fmt/.test(brief) &&
    /\*\* BEAD WORK DONE \*\*/.test(brief) &&
    /DONE-/.test(brief) &&
    /two honest endings/.test(brief);
  check(`"${name}" claims the bead, reads CLAUDE.md, names the bead, and has both exits`, all);
}

check(
  'a second attempt says so in all three, since whatever stopped the first is still there',
  [null, MODE(), MODE({ autoMerge: false })].every((m) => /This is attempt 2/.test(workPromptFor('beadcause', BEAD, 2, m, OWNER)))
);

/* ------------------------------------------ the three ways to reach a human */

/**
 * A worker can owe a human three different things, and none of them is GitHub's
 * business — they are `bd` beads, filed through this daemon, on a repo with a remote
 * or without one.
 *
 * They were gated on `prMode` anyway, which is the regression these assertions exist
 * to stop coming back. Three of Adam's four repos are private and owned by his second
 * `gh` account, so `slugFor` was null there, so `prMode` was null, so every worker the
 * advocate opened on sophab, deluvia or ehatt was told to write its discovery in a
 * comment nobody reads and had no way to ask a question at all. `sp-b5r` is what that
 * cost: the true blocker of a go-live, refused twice by two sessions, carrying no
 * `human` label, so it never reached a phone.
 *
 * The `none` brief is the important column here. If these ever pass for `land` and
 * `ask` but not for `none`, the coupling is back.
 */
console.log('\nthe three ways a worker reaches a human, on every repo');

for (const [name, brief] of [
  ['lands its own work', land],
  ['asks first', ask],
  ['no remote', none],
]) {
  check(`"${name}" can propose the work it found`, /--kind discovery/.test(brief) && /propose\.js/.test(brief));
  check(`"${name}" can ask for a fact only Adam has, and park the bead behind it`, /ask\.js/.test(brief) && /--blocks bc-fmt/.test(brief));
  check(`"${name}" can stop on a contradiction rather than pick one`, /--kind conflict/.test(brief));
  check(
    `"${name}" still may not create a bead itself`,
    /Do not create beads/.test(brief) && !/\bbd create\b/.test(brief),
    (brief.match(/.*bd create.*/) || [])[0]
  );
  check(
    `"${name}" is not sent back to the \`## Discovered\` comment nobody reads`,
    !/## Discovered/.test(brief),
    (brief.match(/.*## Discovered.*/) || [])[0]
  );
}

/* --------------------------------------------------- config reaching the brief */

console.log('\nthe config flag reaching the brief it decides');

const modeOn = await prMode({ pr: { base: 'main', mergeMethod: 'squash' } }, REPO);
check('autoMerge defaults on, which is what makes landing the ordinary ending', modeOn && modeOn.autoMerge === true, JSON.stringify(modeOn));
check('and it carries the repo and base the brief quotes', modeOn.repo === 'mordam/beadcause' && modeOn.base === 'main');

const modeOff = await prMode({ pr: { autoMerge: false } }, REPO);
check('an explicit false switches it off', modeOff && modeOff.autoMerge === false, JSON.stringify(modeOff));
check(
  'and that is the flag the brief follows, end to end',
  /you do not merge it — you deliver it/.test(workPromptFor('beadcause', BEAD, 1, modeOff, OWNER)) &&
    /squash-merges it into/.test(workPromptFor('beadcause', BEAD, 1, modeOn, OWNER))
);

check('pr delivery switched off entirely is still null, and gets the old ending', (await prMode({ pr: { enabled: false } }, REPO)) === null);

/* ------------------------------------------------------------------ verdict */

console.log('');
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mall checks passed\x1b[0m');
