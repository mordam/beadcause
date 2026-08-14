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
import { cleanupTmp } from './helpers/tmp.mjs';

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
// Before the first import that reaches lib/config.js, which fixes CONFIG_DIR at module
// load: without it the config section at the bottom of this file would read — and the
// state file it writes would be written into — whatever this machine actually runs on.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');

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
    // Three since bc-y4bi: hand it back, say it is bigger than it looked, or mark it a
    // duplicate of the bead that already covers it. The third is the one that used to be
    // improvised in a comment nothing could read — see lib/superseded.js.
    /three honest endings/.test(brief);
  check(`"${name}" claims the bead, reads CLAUDE.md, names the bead, and has all three exits`, all);
  // Since bc-28ef the three writes are one command rather than two lines a worker types.
  // Both halves are asserted because either alone is the bug: the command without the
  // warning is a brief that reads as optional, and the warning without the command is
  // the by-hand marking this replaced.
  check(
    `"${name}" marks a duplicate with the command rather than by hand`,
    /bin\/supersede\.js -w beadcause -b bc-fmt --original <the-original>/.test(brief) &&
      /superseded-by:<the-original>/.test(brief) &&
      /refused\*? when the original is an epic/.test(brief)
  );
}

/* --------------------------------------- the step that outlives the window (bc-goo.10) */

/**
 * The one part of the ending written for the next agent rather than for Adam.
 *
 * It is asserted here rather than trusted because the three things that make it work are
 * each one sentence, and each of them is the kind of sentence a later edit tidies away:
 *
 * 1. **The foreshadow comes before the ending.** A session told about this only in the
 *    closing sequence has to reconstruct the run from memory, and what it reconstructs is
 *    "worked on lib/foo.js" — a summary of what it did, not the thing that surprised it.
 *    So the position is the feature, and position is what the index comparison checks.
 * 2. **Silence is the expected answer.** The failure mode of the whole feature is a
 *    paragraph filed every single run, at which point the store is noise and nobody opens
 *    it. `amendment.reflectionPrompt` states that as a bar for the same reason; a brief
 *    that dropped the sentence would still work and would quietly fill the store.
 * 3. **The marker stays last.** The writes are tool calls and the marker is the last line
 *    of the final message, so the step has to come first *and* has to say why — a session
 *    obeying both instructions in the other order puts its marker in the middle, and a
 *    line whose whole value is that it can be grepped for stops being findable.
 *
 * All three stores are named because the choice between them is the whole of getting it
 * right: a repo fact in `remember` is advice followed where it is false, a general lesson
 * in `note` is one never seen again, and a report on this run in either of them is advice
 * that goes stale without anybody noticing. See `memoryBrief` in lib/memory.js, which is
 * the single copy of the long version.
 *
 * A fourth thing is asserted since tier 4 arrived, and it is the one a later tidy-up is
 * most likely to undo: **silence is the expected answer for two of the three and not for
 * the third**. `debrief` is a report on this run, so the "most runs write nothing" bar
 * written for the other two is wrong for it — and a store an agent has been told to use
 * sparingly is a store bc-sgu4 already showed us goes unused entirely. The two
 * instructions therefore sit in two paragraphs saying opposite things, and both are
 * checked.
 */
console.log('\nthe step that writes something down before the window closes');

for (const [name, brief] of [
  ['lands its own work', land],
  ['asks first', ask],
  ['no remote', none],
]) {
  check(
    `"${name}" foreshadows the step up in the brief, where the surprise is still in front of it`,
    brief.indexOf('notice the surprises as you hit them') > 0 &&
      brief.indexOf('notice the surprises as you hit them') < brief.indexOf('Leave a report on this run'),
    (brief.match(/.*notice the surprises.*/) || [])[0]
  );
  check(
    `"${name}" names all three stores`,
    /beadcause-memory note\b/.test(brief) &&
      /beadcause-memory remember\b/.test(brief) &&
      /beadcause-memory debrief /.test(brief),
    (brief.match(/.*beadcause-memory.*/) || [])[0]
  );
  check(
    `"${name}" gives the question that chooses between the two that outlive the run`,
    /would still be true in another repo next week/.test(brief),
    (brief.match(/.*another repo next week.*/) || [])[0]
  );
  check(
    `"${name}" does not ask for a note every run — silence is the expected answer there`,
    /most runs should write\s+neither, which is the expected answer/.test(brief),
    (brief.match(/.*most runs should write.*/) || [])[0]
  );
  check(
    `"${name}" asks for a debrief every run, which is the opposite instruction and has to survive beside it`,
    /this one you should almost always\s+write/.test(brief),
    (brief.match(/.*almost always.*/) || [])[0]
  );
  check(
    `"${name}" says what a debrief is for, so it is not written as a second copy of the note`,
    /It does not have to still be true next week/.test(brief)
  );
  check(
    `"${name}" keeps the line that stops this becoming a second tracker`,
    /work item attached is a bead, not any of the three/.test(brief)
  );
  // The ordering the marker depends on: write, rename, then the message whose last line
  // is the marker. Numbered *and* argued, because a session reads the numbers.
  check(
    `"${name}" runs the three closing steps in the order the marker needs`,
    /^1\. \*\*Leave a report on this run/m.test(brief) &&
      /^2\. \*\*Rename this session/m.test(brief) &&
      /^3\. \*\*Make the last line of your final message/m.test(brief),
    (brief.match(/^\d\. \*\*.*/gm) || []).join(' | ')
  );
  check(
    `"${name}" says outright that the writes happen before the final message, not after the marker`,
    /\*\*before\*\* your final message/.test(brief) && /nothing can follow it/.test(brief)
  );
  check(
    `"${name}" owes the step whichever way it ends, including the ones that hand the work back`,
    /whichever way this session ends/.test(brief),
    (brief.match(/.*whichever way this session ends.*/) || [])[0]
  );
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
 *
 * **The first of the three inverted (bc-3zo9).** A worker used to be told, in these
 * words, that it may not create a bead: a discovery was a proposal, and nothing existed
 * until a button was pressed. It now files the bead itself. What replaced the old
 * assertion is not "it may create beads" but the three sentences that make creating one
 * safe, and all three have to be in the brief or the feature is a worse version of the
 * thing it replaced:
 *
 *   - the bead is **real** — filed with `beadcause-file`, not proposed;
 *   - it arrives **unendorsed**, and that means nothing is worked on it until Adam
 *     says so — a session that does not know this has no reason not to file P0s;
 *   - the session **carries on** rather than waiting, or the whole point is lost, and
 *     it does not go and work the bead it just filed, which is the same failure with
 *     the queue's permission.
 *
 * `bd create` stays forbidden, and that assertion is unchanged: the marker, the
 * provenance label and the `discovered-from` edge are what make an agent-filed bead
 * safe to have created, and only `beadcause-file` stamps all three (lib/filing.js). A
 * brief that drifts into naming the raw CLI hands back exactly the hole bc-3zo9.1 shut.
 */
console.log('\nthe three ways a worker reaches a human, on every repo');

for (const [name, brief] of [
  ['lands its own work', land],
  ['asks first', ask],
  ['no remote', none],
]) {
  check(
    `"${name}" files the work it found as a real bead, off the bead it was working`,
    /file\.js -w beadcause --from bc-fmt/.test(brief),
    (brief.match(/.*file\.js.*/) || [])[0]
  );
  check(
    `"${name}" is told the bead it files cannot be worked until Adam endorses it`,
    /unendorsed/.test(brief) && /endorses it/.test(brief),
    (brief.match(/.*unendorsed.*/) || [])[0]
  );
  check(
    `"${name}" is told to carry on rather than wait for the endorsement`,
    /carry straight on with bc-fmt/.test(brief) && /do not wait for an answer/.test(brief),
    (brief.match(/.*carry straight on.*/) || [])[0]
  );
  check(`"${name}" can ask for a fact only Adam has, and park the bead behind it`, /ask\.js/.test(brief) && /--blocks bc-fmt/.test(brief));
  check(`"${name}" can stop on a contradiction rather than pick one`, /--kind conflict/.test(brief));
  check(
    `"${name}" files through the command that stamps the marker, never bare \`bd create\``,
    !/\bbd create\b/.test(brief),
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

// A config with no `mergeMethod` — the shape of every config written before the key
// existed — has to fall through to a merge commit, and to the *same* one bin/deliver.js
// falls through to. The brief is a promise about what that command will do, and the two
// reading different defaults is how a session is told it will squash and does not.
const modeBare = await prMode({ pr: {} }, REPO);
check('an unset mergeMethod is a merge commit, not a squash', modeBare.method === 'merge', JSON.stringify(modeBare.method));
// And it has to read as English. "squash-merges it" is a phrase; "merge-merges it" is a
// template showing through, and with `merge` the default it would be in nearly every
// brief an unattended session is ever handed.
const bareBrief = workPromptFor('beadcause', BEAD, 1, modeBare, OWNER);
check(
  'and the brief says so, in the sentence describing the command',
  /merges it with a merge commit into \\?`main\\?`/.test(bareBrief),
  (bareBrief.match(/.*merges it.*into.*/) || [])[0]
);
check('and never says "merge-merges"', !/merge-merges/.test(bareBrief));

/* ---------------------------------- what the last session in this repo already learned */

console.log('\nthe repo-local notes the brief carries');

// The push half of tier 1. The system prompt already tells every worker to run
// `beadcause-memory notes` before it starts, and that line stays — but a session that has
// to remember to read before it has read anything mostly does not, and a store nobody
// opens is a store that was never worth writing to. So the daemon selects against the
// bead and puts the likely ones in the brief. The rule and its caps live in lib/memory.js
// and are tested there; what is asserted here is that the brief carries the result, that
// it survives a workspace with no notes at all, and — the one that would quietly undo the
// whole thing — that a section arriving is never allowed to read as permission to skip
// the rest of the store.
const NOTES = {
  'sw-cache-version-conflicts': {
    value: 'public/sw.js is the most likely merge conflict here — read both blocks before renumbering.',
    at: '2026-08-11T14:36:36.114Z',
  },
  'fixed-port-suites-collide': { value: 'test/dedupe.mjs binds 127.0.0.1:4389, so two suites at once is EADDRINUSE.', at: '2026-08-11T14:08:31.486Z' },
};
const WORKED = { id: 'bc-fmt', title: 'Workers land their own work when the bead is done', description: 'public/sw.js and the merge conflict it causes.' };
const noted = workPromptFor('beadcause', WORKED, 1, MODE(), OWNER, { notes: NOTES });

check('the brief carries the note the bead is about', noted.includes('most likely merge conflict here'), (noted.match(/.*sw\.js.*/) || [])[0]);
check(
  'and names the rest by key, so a capped section never reads as the whole store',
  noted.includes('`fixed-port-suites-collide`') && noted.includes('beadcause-memory notes <key>'),
  (noted.match(/.*unread here.*/) || [])[0]
);
check(
  'the section sits above the tests paragraph, where what it mostly says is how they are really run',
  noted.indexOf('already worked out') < noted.indexOf('Run whatever this repo calls its tests'),
  `${noted.indexOf('already worked out')} vs ${noted.indexOf('Run whatever this repo calls its tests')}`
);
// A workspace whose store is empty — every workspace, on the day this shipped — must get
// no heading rather than a heading over nothing. An agent shown an empty section twice
// learns the section is furniture, and stops reading it on the day it has something in it.
check('a workspace with no notes gets no section at all', !land.includes('already worked out') && !land.includes('beadcause-memory notes <key>'), land);
// Whatever else changes, this cannot: the brief is passed the notes rather than reading
// them, so every ending stays assertable here without a repo, a ref or a store.
check('every ending can still carry one', [MODE(), MODE({ autoMerge: false }), null].every((m) => workPromptFor('beadcause', WORKED, 1, m, OWNER, { notes: NOTES }).includes('already worked out')));

/* -------------------------------------------- the stored value the new default needs */

console.log('\nthe one-time move of a stored `squash`');

// Changing a default in `defaults()` changes nothing on a machine that already has a
// config, because the stored value wins the merge in `loadConfig`. This one has said
// `"squash"` since the day the key existed, so without the move the whole fix would be
// notional: every delivery would go on squashing and every delivered worktree would go
// on being stranded in the attic. Bounded by count rather than by cleverness — it
// happens once, records that it did, and never fights a value set back on purpose.
// The *default* is pinned end to end by scripts/land-check.mjs scenario 6 — a config
// with the key removed, run through the real `loadConfig` and the real deliver.js, and
// asserted at the `gh pr merge` argv. What is left for here is the stored value.
const { moveSquashDefault, loadState } = await import(path.join(HERE, '..', 'lib', 'config.js'));

const stored = { pr: { enabled: true, base: 'main', mergeMethod: 'squash', tidyMerged: true } };
const said = moveSquashDefault(stored);
check('a stored squash moves to a merge commit', stored.pr.mergeMethod === 'merge', stored.pr.mergeMethod);
check('and it says so rather than moving a setting silently', /squash.*→.*merge/.test(said), said);
check('and says why, in the terms of the thing that breaks', /ancestor of\s*\n?\s*main/.test(said) || /ancestor of main/.test(said), said);
check('the move is recorded, so it is a migration and not a policy', loadState().squashDefaultMoved === true);

// The half that makes it a migration: `squash` chosen deliberately, after the move, is
// a choice — and a choice that gets overwritten on the next `beadcause-ask` is not one.
const again = { pr: { enabled: true, base: 'main', mergeMethod: 'squash', tidyMerged: true } };
check('a squash set back afterwards is left alone', moveSquashDefault(again) === '' && again.pr.mergeMethod === 'squash', again.pr.mergeMethod);
check('and anything already on merge is not touched at all', moveSquashDefault({ pr: { mergeMethod: 'merge' } }) === '');
check('nor is an explicit rebase', moveSquashDefault({ pr: { mergeMethod: 'rebase' } }) === '');

/* -------------------------------------------------- the batch head's extra sentences */

/**
 * A batch brief (bc-bhp9). The advocate can now hand one window an epic plus its ready
 * children, and two sentences in that brief are load-bearing in a way the rest are not.
 *
 * The delivery and close sections are written for a single-bead window: both interpolate
 * one bead id, and in a batch that id is the *epic*. A worker that follows them literally
 * closes the epic on its first phase — which reports every remaining child as done, and
 * takes them out of the batch that would have carried them next tick. So the brief has to
 * override its own later sections, and if that override ever goes missing the failure is
 * silent: the work still happens, the board just lies about it.
 */
console.log('\na batch head is told it is not a single-bead window');

const BATCH = {
  id: 'bc-epic',
  title: 'The epic',
  batch: [
    { id: 'bc-epic.1', title: 'first child' },
    { id: 'bc-epic.2', title: 'second child' },
  ],
};
const batched = workPromptFor('beadcause', BATCH, 1, MODE(), OWNER);

check('the opening says it holds the epic and its children, not one bead', /epic \*\*beadcause\/bc-epic\*\* and the 2 beads under it/.test(batched), (batched.match(/^You are working.*/) || [])[0]);
check('every bead in the batch is named, so it can read them all before planning', batched.includes('bd show bc-epic.1') && batched.includes('bd show bc-epic.2'));
check('it is told to choose phases rather than work the list in order', /work them in phases you choose/.test(batched));
check('and told the order it was given is not a plan', /it is pick order, not a plan/.test(batched));
check(
  'the epic must not be closed while a child is open — the sentence that stops a lying board',
  /Do not close \\?`bc-epic\\?` itself until every bead under it is closed/.test(batched),
  (batched.match(/.*until every bead under it.*/) || [])[0]
);
check('and the delivery step is re-pointed at the bead each phase completes', /name the bead that phase completed — not \\?`bc-epic\\?`/.test(batched), (batched.match(/.*name the bead that phase.*/) || [])[0]);
check('stopping part-way is named as a correct ending, so it does not grind', /That is the correct ending, not a failure/.test(batched));

/**
 * The one command in the batch brief that is load-bearing across ticks. The worker claimed
 * the epic to start, and `bd ready` skips a claimed bead — the same fact `bd.reopen` exists
 * for. So an epic left claimed with children still open is a bead nothing will pick up
 * again, and the remainder gets handed out one window at a time instead of as a batch. The
 * flags have to match `reopen`'s, or the hand-back does not hand anything back.
 */
check(
  'a part-done batch hands the epic back unclaimed, or the remainder never batches again',
  batched.includes('bd update bc-epic --status open --assignee ""'),
  (batched.match(/.*bd update bc-epic.*/) || [])[0]
);
check('and says why that line is there, since it reads like bookkeeping', /a claimed bead\s*\n?is skipped by the advocate's queue/.test(batched));

// The other half of the contract, and the one a regression would reach first: a bead the
// advocate never batched must get byte-identical prose to what it got before any of this
// existed. `land` above is that bead, built from the same MODE.
check('a single-bead brief is untouched by any of it', land === workPromptFor('beadcause', { id: BEAD.id, title: BEAD.title, batch: [] }, 1, MODE(), OWNER));
check('and carries none of the batch sentences', !/in phases you choose/.test(land) && !/until every bead under it/.test(land));

/**
 * A window opened over somebody else's open files is told so.
 *
 * bc-b9vt. `withoutClaimedFiles` in lib/advocate.js reads lib/claims.js at dispatch, and
 * when the surface it matched was only *guessed* out of the bead's prose it may not
 * withhold the work (bc-hrno) — so it opens the window anyway. Before this it opened it
 * silently, and the session learned the same fact at its first `Write`, from
 * scripts/claim-guard.sh's refusal, after it had read the tree and made a plan. That is
 * the exact lateness the dispatch-time read exists to end.
 *
 * Two failures are worth asserting, and they pull in opposite directions:
 *
 * 1. **Saying nothing** — the regression this section exists for. The evidence has to be
 *    in the brief: which files, which tree, and what the session can do about it.
 * 2. **Saying it too hard.** A guess may not withhold work, and a brief that read as a
 *    prohibition would put back, in prose, exactly the hold `holdGuessedFiles` is off in
 *    order not to take. So the words "warning and not a boundary" are load-bearing, and
 *    the section must not tell the session to stop.
 */
console.log('\na window opened over another session\'s open files is told which ones');

const BUSY = {
  id: 'bc-busy',
  title: 'The bead whose files are taken',
  filesBusy: {
    id: 'bc-busy',
    why: "another session is editing lib/advocate.js on worktree-other-thing — which this bead's text names",
    files: ['lib/advocate.js', 'lib/session.js'],
    branch: 'worktree-other-thing',
    source: 'guessed',
  },
};
const busy = workPromptFor('beadcause', BUSY, 1, MODE(), OWNER);

check('the collision is named at all — the whole of bc-b9vt', /Another session on this Mac already has/.test(busy));
check(
  'the advocate\'s own sentence travels, so the session sees the evidence and not a summary of it',
  busy.includes(BUSY.filesBusy.why)
);
check(
  'every file is listed, because "some of your files" is a warning nobody can act on',
  busy.includes('    lib/advocate.js') && busy.includes('    lib/session.js'),
  (busy.match(/.*lib\/session\.js.*/) || [])[0]
);
check(
  'the worktree holding them is named and reachable — the second cheapest thing to do about it',
  /git log --oneline -20 worktree-other-thing/.test(busy),
  (busy.match(/.*git log --oneline.*/) || [])[0]
);
check('and the first is named too: start where those files are not', /Start somewhere those files are not/.test(busy));
check('the guard is named, so the refusal it will hit is not a surprise twice', /claim-guard\.sh/.test(busy));

/**
 * The half that has to hold in the other direction. `holdGuessedFiles` is off precisely so
 * that a resemblance does not park work — see `withoutTwins`' rule in lib/advocate.js —
 * and a brief telling this session to stand down would re-impose that hold in prose, where
 * no config switch can reach it.
 */
check('it is a warning and says so, because a guess may not withhold work', /a warning and not a boundary/.test(busy));
check(
  'and it never tells the session to stop, wait, or leave the files alone',
  !/do not (touch|edit|write)/i.test(busy) && !/wait (for|until) (that|the other) session/i.test(busy),
  (busy.match(/.*do not (touch|edit|write).*/i) || [])[0]
);

check(
  'an entry the advocate did not finish writing still reads as prose, not as `undefined.`',
  (() => {
    const half = workPromptFor(
      'beadcause',
      { id: 'bc-half', title: 't', filesBusy: { id: 'bc-half', files: ['lib/one.js'] } },
      1,
      MODE(),
      OWNER
    );
    return /is editing lib\/one\.js\./.test(half) && !/undefined/.test(half) && /that tree is doing/.test(half);
  })(),
  'a brief is the whole of what an unattended session is told; `undefined` in it reads as a bug, not a warning'
);

check(
  'a bead with no collision carries none of it — byte-identical to the brief before any of this',
  land === workPromptFor('beadcause', { id: BEAD.id, title: BEAD.title }, 1, MODE(), OWNER)
);
check(
  'and an entry that names no file is no collision either — an empty list would print an empty block',
  land ===
    workPromptFor(
      'beadcause',
      { id: BEAD.id, title: BEAD.title, filesBusy: { id: BEAD.id, why: 'x', files: [], branch: null } },
      1,
      MODE(),
      OWNER
    )
);

/* ------------------------------------------------------------------ verdict */

console.log('');
await cleanupTmp(tmp);
if (failures) {
  console.log(`\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mall checks passed\x1b[0m');
