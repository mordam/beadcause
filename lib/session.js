import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { effective, claudeArgs, systemPrompt, agentExports } from './foundation.js';
import { memoryBrief } from './memory.js';
import { placement, frontmostApp, restoreApp } from './iterm.js';
import { assertEndorsed } from './endorse.js';
import { assertNotSuperseded, SUPERSEDE_PREFIX } from './superseded.js';
import { ownerName } from './owner.js';
import * as github from './pr.js';
import { prPolicyFor, autoEndorseAllowed } from './spaces.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'open-session.applescript');
const MESSAGE_SCRIPT = path.join(ROOT, 'scripts', 'message-session.applescript');
const TTY_SCRIPT = path.join(ROOT, 'scripts', 'iterm-ttys.applescript');

/**
 * The commands a worker is told to run, as absolute paths.
 *
 * Not `beadcause-deliver` on its own: whether the package is linked onto PATH depends
 * on how it was installed, and a brief that names a command the session cannot run
 * fails at the very last step — after the work is done, in a window nobody is
 * watching. The daemon knows where it lives, so it says so.
 */
const DELIVER_CMD = `node ${path.join(ROOT, 'bin', 'deliver.js')}`;
const FILE_CMD = `node ${path.join(ROOT, 'bin', 'file.js')}`;
const PROPOSE_CMD = `node ${path.join(ROOT, 'bin', 'propose.js')}`;
const ASK_CMD = `node ${path.join(ROOT, 'bin', 'ask.js')}`;
const CHECKIN_CMD = `node ${path.join(ROOT, 'bin', 'checkin.js')}`;

const HOME = os.homedir();

/** Single-quote for /bin/sh. The only untrusted thing reaching a shell, so it is the only escaping. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** `claude --permission-mode` choices as of 2.1.223. */
const PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);

/**
 * How much the opened session may do without asking.
 *
 * Defaults to `auto`, because the whole point of the button is that you're not at
 * the keyboard — a session that stops on the first permission prompt and waits is
 * useless when you tapped it from a phone in another room.
 *
 * Validated against a fixed set rather than passed through: an unrecognised value
 * makes `claude` exit immediately, and the failure would show up as an iTerm window
 * that opens and instantly dies, which is a miserable thing to debug.
 */
export function permissionFlag(mode, key = 'sessionPermissionMode') {
  if (!mode) return '';
  if (!PERMISSION_MODES.has(mode)) {
    console.warn(`[beadcause] ignoring unknown ${key} "${mode}" — expected one of ${[...PERMISSION_MODES].join(', ')}`);
    return '';
  }
  return ` --permission-mode ${shq(mode)}`;
}

/**
 * What `BEADS_DIR` a login shell would resolve to in `dir`, for setups whose shell
 * derives it from the working directory.
 *
 * Only meaningful when `projectRoot` is configured. The convention it encodes is
 * "`<projectRoot>/<repo>` uses `~/beads/<repo>`, everything else uses the fallback
 * workspace" — which is what a `chpwd`-style hook in `.zshrc`/`.zshenv` typically
 * does. We reimplement it rather than shelling out because the answer decides which
 * issue tracker — and, where CLAUDE_CONFIG_DIR is scoped the same way, which Claude
 * account — the new session gets.
 */
export function beadsDirFor(dir, projectRoot, fallbackWorkspace = 'default') {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(dir);
  const inRoot = resolved === root || resolved.startsWith(root + path.sep);
  if (!inRoot) return path.join(HOME, 'beads', fallbackWorkspace, '.beads');
  const rel = path.relative(root, resolved);
  const repo = rel.split(path.sep)[0] || fallbackWorkspace;
  return path.join(HOME, 'beads', repo, '.beads');
}

/**
 * Where to start a session about a question in `workspace`.
 *
 * Two modes, because two very different setups have to work:
 *
 * - **Plain (default).** No `projectRoot` configured, so there is no shell rule to
 *   honour. The session opens in the workspace's own directory, `~/beads/<name>`,
 *   where `bd` finds `.beads` by walking up from the cwd. Always correct, needs no
 *   configuration, and is what someone installing this for the first time gets.
 *
 * - **projectRoot configured.** The shell derives BEADS_DIR (and possibly
 *   CLAUDE_CONFIG_DIR) from cwd, so the session must open in the matching checkout
 *   — `<projectRoot>/<name>` — and we *verify* that a shell there really would
 *   resolve back to this workspace. Opening a session that quietly writes to the
 *   wrong tracker, or bills the wrong account, is worse than refusing.
 *
 * `sessionDirs.<workspace>` overrides both.
 */
export function resolveSessionDir(cfg, workspace) {
  const override = cfg.sessionDirs?.[workspace.name];
  if (override) {
    if (fs.existsSync(override)) return override;
    throw Object.assign(new Error(`sessionDirs.${workspace.name} points at a missing directory: ${override}`), {
      status: 409,
    });
  }

  if (!cfg.projectRoot) {
    // `~/beads/<name>`, the parent of the workspace's own `.beads`.
    const workspaceHome = path.dirname(path.resolve(workspace.dir));
    return fs.existsSync(workspaceHome) ? workspaceHome : HOME;
  }

  const fallback = cfg.fallbackWorkspace || 'default';
  for (const dir of [path.join(path.resolve(cfg.projectRoot), workspace.name), HOME]) {
    if (!fs.existsSync(dir)) continue;
    if (path.resolve(beadsDirFor(dir, cfg.projectRoot, fallback)) === path.resolve(workspace.dir)) return dir;
  }

  throw Object.assign(
    new Error(
      `no directory maps to the ${workspace.name} workspace — a shell there would use a different issue graph. ` +
        `Set sessionDirs.${workspace.name} in ~/.config/beadcause/config.json.`
    ),
    { status: 409 }
  );
}

/** What the session opens with. Deliberately brief — it can read the bead itself. */
function promptFor(workspace, id, title) {
  return `Discuss beadcause question **${workspace}/${id}** with me.

> ${title || '(untitled)'}

I opened this from my phone because I want to talk it through, so **don't answer it
on my behalf** — read it, tell me what you think, and we'll decide together.

Read it with:

    bd show ${id}
    bd comments ${id}

Once we've settled on an answer, record it against the bead:

    bd comment ${id} "<the answer we agreed>"
    bd close ${id} --reason "Answered in a Claude session"

Do not use \`bd human respond\` — it is broken in bd 1.1.2 ("resolving issue ID:
storage is nil"). The two commands above are what beadcause itself does.

Name this session "${projectName(workspace)} - discuss ${id}".
`;
}

/**
 * The brief for a terminal opened on the phone — see lib/terminal.js.
 *
 * Same intent as the iTerm one above and deliberately not the same text, because
 * the screen is different in a way the agent has to know about. That window is on a
 * Mac; this one is roughly forty columns wide, and a reply written for a desk
 * monitor arrives as a wall of hard-wrapped fragments with an on-screen keyboard
 * over the bottom half of it. Everything here follows from that, plus one thing the
 * TUI cannot say for itself: on a phone keyboard, being asked to approve something
 * is genuinely expensive, so it is worth asking for fewer, larger permissions.
 */
export function terminalPrompt(workspace, id, title) {
  const opener = id
    ? `Let's talk through beadcause question **${workspace}/${id}**.

> ${title || '(untitled)'}

Read it first (\`bd show ${id}\`, and \`bd comments ${id}\` if it has a thread). Don't
answer it on my behalf — tell me what you think and we'll decide together.

Once we've settled on an answer, record it against the bead:

    bd comment ${id} "<the answer we agreed>"
    bd close ${id} --reason "Answered in a Claude session"

Do not use \`bd human respond\` — it is broken in bd 1.1.2 ("resolving issue ID:
storage is nil"). The two commands above are what beadcause itself does.`
    : `You're running in the **${workspace}** workspace, so a plain \`bd\` command already
points at the right tracker. I'll tell you what I want in a moment.`;

  return `${opener}

**I am typing this on a phone**, in a terminal about forty columns wide, with a
soft keyboard over half the screen. So:

- Short paragraphs and short lines. No ASCII tables, no wide diagrams, no banner
  blocks, and don't rename your session.
- Say what you're doing in one line before a long tool run, or I'm watching a
  spinner with no idea whether you're stuck.
- Batch what you need approved. Every prompt costs me a tap on a keyboard I can
  barely hit, so ask once for the whole job rather than six times for its parts.
- Ask me short questions. I can answer "yes" or "option 2" easily; writing you a
  paragraph is hard here.
`;
}

/**
 * The brief an advocate's session opens with.
 *
 * Everything in it is there because the alternative is worse:
 *
 * - **Claim first.** `bd update --claim` is the only signal every other view in
 *   beadcause already reads, so claiming is what makes this window appear on the
 *   sessions page and stops a second advocate tick picking the same bead up.
 * - **Read the repo's CLAUDE.md.** The daemon has no idea whether this repo wants
 *   a worktree, a test run or a particular deploy script, and hard-coding one
 *   repo's rules here would be wrong in every other one.
 * - **Two honest exits.** Closed, or handed back with the `human` label. A session
 *   left with neither invents a third — usually "close it and hope" — and that is
 *   the failure mode that makes an autonomous queue untrustworthy.
 * - **Name yourself after the bead.** It is the only string that lets the advocate
 *   match this window to the work; without it a running session and a claimed bead
 *   in the same repo are merely *probably* the same thing, which lib/claude.js is
 *   careful never to assert.
 * - **Say so, in fixed words, when the work is done — and say what is still owed.**
 *   A `DONE-` prefix on the session name, and a last line built from the fixed prefix
 *   `** BEAD WORK DONE **` and the steps the work has not been through yet. Both are
 *   for a human scrolling a `/resume` list or a wall of windows hours later, and
 *   neither follows from the closed bead: a session that closed its bead and one that
 *   quietly stalled look identical there, and a session can close a bead and still
 *   have more to say. The wording is fixed rather than paraphrased so it can be
 *   searched for.
 * - **Leave something behind for the next agent, not only for Adam.** The ending used to
 *   be those two things and nothing else, and both are for a person reading a list of
 *   windows. `LEARNED_STEP` is the third, and it is the only one aimed at whoever opens
 *   these files next — written at the one moment the session knows the most and is about
 *   to lose all of it. It is foreshadowed up in the brief as well as carried in the
 *   ending, because a session told about it only at the end has to reconstruct the run
 *   from memory, and what it reconstructs is a summary of what it did rather than the
 *   thing that surprised it.
 *
 * That last line used to be `CAN BE CLOSED` and nothing else, which said only that the
 * *window* had nothing left to do. A session that committed to a worktree branch and
 * stopped there printed exactly what a session whose work was merged, pushed and
 * deployed printed. That is worse than uninformative, because an unmerged branch is
 * never swept — the worktree sweep retires a worktree only when its branch is an
 * ancestor of `main` — so the work sat in a worktree indefinitely while every list
 * Adam scans said it was finished. The line now names the state of the *work*:
 *
 *     ** BEAD WORK DONE ** CAN BE MERGED, PUSHED, DEPLOYED **
 *     ** BEAD WORK DONE ** CAN BE CLOSED **     nothing outstanding — the only line that means done
 *
 * Three things about that were decisions rather than obvious:
 *
 * - **It lists every outstanding step, not only the first.** Owing merge *and* push
 *   *and* deploy at once is the normal case, and a line naming only the merge
 *   understates it. Greppability survives: the fixed part is the `** BEAD WORK DONE **`
 *   prefix, and each verb after it is itself a fixed word.
 * - **The verbs are the `ship` skill's own stages** — merge and push are the repo,
 *   deploy is the daemon restart, rebuild is the app artefact — so one word means one
 *   thing in both places, rather than beadcause inventing a second vocabulary for the
 *   same four acts.
 * - **The session names them; it does not do them.** In this ending, the one for a
 *   workspace with no pull requests to open, all four stay Adam's — several sessions
 *   run at once, and when each merged its own work into a local `main` the merges raced
 *   and every conflict landed on him anyway, hours later and in a repo he had not been
 *   reading.
 *
 * Which of the four a session can *honestly* owe depends on the ending it was given,
 * so there are three marker steps and each one names only the verbs that can be true:
 *
 * - **No pull requests here** (`OWED_MARKER_STEP`) — all four apply, and the session
 *   does none of them. The ladder above.
 * - **It landed its own work** (`LAND_MARKER_STEP`) — merged and pushed are already
 *   done, by GitHub, so the line can only owe a deploy, a rebuild, or a review if the
 *   merge was refused. This is the ordinary ending.
 * - **The merge is Adam's tap** (`PR_MARKER_STEP`, auto-merge off for this space) — none of the
 *   four are the session's at all: it delivers a branch and a question, and the merge
 *   *is* him answering. `CAN BE REVIEWED`, and nothing else it could write is true.
 *
 * The point survives all three: a session says how far the work actually got, and it
 * never claims a step it did not take.
 *
 * Exported for test/land.mjs, and only for it. The brief is the whole interface between
 * this daemon and an unattended agent — everything beadcause can make a worker do, it
 * does by writing a sentence here — so a change that quietly tells a session to merge
 * `main` by hand, or to claim a merge it did not make, is worth catching in a test
 * rather than in a repo a fortnight later. `checkinMessage` and `terminalPrompt` are
 * asserted the same way.
 */
export function workPromptFor(workspace, bead, attempt, pr = null, owner = ownerName(), { autoEndorse = false } = {}) {
  const id = bead.id;
  const retry =
    attempt > 1
      ? `\n**This is attempt ${attempt}.** A previous session was opened on this bead and ended without\nclosing it. Read the comments before you start — whatever stopped it is probably\nstill there, and if it is a question for ${owner}, hand it back rather than grinding.\n`
      : '';

  const delivery = pr ? (pr.autoMerge ? landSection(workspace, id, pr, owner) : deliverSection(workspace, id, pr, owner)) : closeSection(id);
  // Unconditional, and that is the fix. This used to be `pr ? propose : discovered`,
  // which tied whether a worker could *speak to Adam at all* to whether `gh` could see
  // the repo — so three of his four repos got the old "write it in a comment" ending
  // for a reason that has nothing to do with discovery, questions or contradictions.
  // None of the three needs GitHub: they are `bd` beads, filed through this daemon.
  const discovery = proposeSection(workspace, id, owner, autoEndorse);
  // In ask-first PR mode the session does not close the bead — merging does — so the
  // marker paragraph cannot go on saying "only when the bead really is closed". The
  // three strings say the same thing about three different facts.
  const doneWhen = !pr
    ? 'Write them only when the bead really is closed.'
    : pr.autoMerge
      ? 'Write them only when the delivery has run and told you what it did — merged, or handed over.'
      : 'Write them only when the pull request is open and the question is filed.';
  // The same distinction again, for the marker itself: what a session can still owe
  // depends entirely on which of the three endings it was given.
  const marker = pr ? (pr.autoMerge ? LAND_MARKER_STEP : PR_MARKER_STEP) : OWED_MARKER_STEP;

  return `You are working bead **${workspace}/${id}**, opened automatically by the ${workspace}
advocate in beadcause because it came up ready. **${owner} is not at the keyboard** — treat
this as unattended work that they will read the results of later.

> ${bead.title || '(untitled)'}
${retry}
Start:

    bd show ${id}
    bd comments ${id}
    bd update ${id} --claim

Claim it before you touch anything. It is what tells every other view — and the
advocate that opened this window — that the bead is being worked, and it is what
stops a second session being opened on top of you.

**Then read this repo's own CLAUDE.md and follow it.** It is not background reading:
it is where the rules that make work here mergeable live — worktrees, how the tests
are run, how anything gets deployed. If it says to create a worktree before the first
edit, do that before the first edit.

Run whatever this repo calls its tests before you call the work done, and gate on the
exit code rather than on what scrolled past.

**And notice the surprises as you hit them.** Before you stop you get one chance to
write what you learned into a memory that outlives this window — and by then whatever
cost you twenty minutes today will read as obvious, and you will not think to mention
it. The step is at the end; the noticing has to happen here.
${delivery}
Then end the session properly, in this order:

${LEARNED_STEP}

2. **Rename this session to its own current name with \`DONE-\` in front** — so
   \`${projectName(workspace)} - ${id} …\` becomes
   \`DONE-${projectName(workspace)} - ${id} …\`. Keep everything after the prefix
   exactly as it was, bead id included.
${marker}
The rename and the marker are for whoever reads a list of windows and sessions
afterwards, and neither is implied by the closed bead. The prefix is what separates
finished work from work that stalled halfway, in a \`/resume\` list where every entry
otherwise looks alike; the line is what says how far the work actually got, which a
closed bead does not — a bead can be closed over a commit sitting on a branch nobody
will ever merge.
${doneWhen}
None of the endings below earns those two — but the first step above is owed whichever
way this session ends.

**If you cannot finish it, do not force it.** There are exactly three honest endings,
and none of them is a failure:

1. **It needs a decision from ${owner}.** Put the question on the bead and hand it to
   them — the \`decision\` block is what makes it answerable from a phone:

       bd comment ${id} "Blocked on which way to go. See the decision block."
       bd label add ${id} human

   Then stop. Do not guess at their intent to keep moving; a wrong guess costs more
   than the wait.
2. **It is bigger than it looked.** Say so in a comment, with what you learned, and
   leave the bead open. The advocate will bring it back to them.
3. **It is the same job as a bead that already exists.** Closing it is not yours to do —
   but neither is writing "close this when the other one lands" in a comment, because
   nothing can read that, and when the other one *does* land this bead goes ready and
   the next tick opens a session on work you already knew was gone. Say it as a marker
   instead, then stop:

       bd dep add ${id} <the-original>
       bd label add ${id} ${SUPERSEDE_PREFIX}<the-original>

   The label takes it out of every queue for good — nothing opens a session on a bead
   that carries one — and when \`<the-original>\` closes, ${owner} gets a card whose one
   tap is the close. Name the original in a comment too, and say why you think they are
   the same job; the card sends them to it.

${discovery}
Name this session "${projectName(workspace)} - ${id} ${(bead.title || '').slice(0, 40)}" and keep the bead id
in the name as you rename it. That id is the only thing that lets the advocate match
this window to the bead it opened it for.
`;
}

/**
 * The one step in the ending that is for the *next* agent rather than for a person.
 *
 * Everything else a session does on its way out — the `DONE-` prefix, the marker line —
 * is written for Adam scrolling a wall of windows hours later. Nothing was written for
 * whoever opens these files next, and this is the last moment anything could be: the
 * doneFile is written, the shell exits, iTerm closes the window, and every surprise this
 * session paid for goes with it. lib/memory.js is the store that outlives it; this is
 * the only sentence that tells a worker to use it at the one moment it knows the most.
 *
 * Four things in here are decisions rather than wording:
 *
 * - **It is step 1, not step 3.** Not because it matters most, but because the marker
 *   has to be the last line of the *final message* with nothing after it, and a write
 *   is a tool call. A session obeying "write notes" and "put the marker last" in the
 *   other order puts its marker in the middle and the whole point of a greppable line
 *   is gone. The step says so outright rather than relying on the numbering.
 * - **Silence is the expected answer**, phrased the way `amendment.reflectionPrompt`
 *   phrases the same problem, and for the same reason: the failure mode is a paragraph
 *   of "worked on lib/foo.js" every single run, at which point the store is noise and
 *   nobody opens it. So the bar is stated as a bar — would it have saved *you* an hour
 *   when you started — and "nothing" is given as the ordinary outcome, not a cop-out.
 * - **Both stores are named, with the one question that chooses between them.** Named,
 *   not explained: the full text is `memoryBrief` in lib/memory.js, and `launch` puts it
 *   in this session's system prompt. There is one copy of that on purpose, and a brief
 *   that restated it would be the copy that drifts.
 * - **It is owed on every ending, including the ones that hand the work back.** A run
 *   that discovered the bead was bigger than it looked is often the run that learned the
 *   most, and gating this on a closed bead would lose exactly those.
 *
 * The existing line holds and is restated: anything with a work item attached is a bead,
 * not a note. This is not a second tracker.
 */
const LEARNED_STEP = `1. **Write down anything you learned that the next session would want.** You have a
   memory and it outlives this window: \`beadcause-memory note\` for what is true of
   *this* codebase, \`beadcause-memory remember\` for what would still be true in another
   repo next week. One question picks the store — would this still be true somewhere
   else? Right now you know more about this work than you ever will again, and in a few
   minutes this window is gone.

   **Most runs should write nothing, and that is the expected answer rather than a
   failure.** The bar is whether it would have saved *you* an hour had it been there
   when you started: a trap in a file, a command that is not the one the README gives, a
   shape that turned out wrong for a reason that will still be a reason next month.
   "Worked on lib/session.js" clears no bar, and a store full of that is one nobody
   opens. Anything with a work item attached is a bead, not a note.

   Do it now, as tool calls, **before** your final message — the marker below has to be
   the last line of that message with nothing after it, so nothing can follow it,
   including this. And do it whichever way this session ends: the endings further down
   that hand the work back are often the ones that learned the most.`;

/**
 * The last line, when the session is the one that could have landed its own work.
 *
 * Four verbs, and the session works out which of them still apply — it is the only
 * party that can. The daemon knows the repo but not what this session touched, and it
 * would have to guess at the deploy: whether a repo has one at all, and what it is,
 * lives in that repo's CLAUDE.md and nowhere beadcause can read.
 *
 * The checks are deliberately three git commands and one question about the diff,
 * rather than anything beadcause defines. Nothing parses this line — one grep across
 * `lib bin public scripts test README.md` finds the phrase in this file only — so it
 * is prose for a human reading a wall of windows, and the cost of a session getting a
 * verb wrong is that he reads a slightly wrong sentence, not that a tool misfires.
 */
const OWED_MARKER_STEP = `3. **Make the last line of your final message a marker naming what is still owed**,
   on its own, with nothing after it. You are the only one who can work that out —
   you are the one who knows what you touched:

       ** BEAD WORK DONE ** CAN BE MERGED, PUSHED, DEPLOYED **

   \`** BEAD WORK DONE **\` never changes. After it comes \`CAN BE \` and every step the
   work has not been through yet, in this order, comma-separated:

   - **MERGED** — \`git log main..HEAD\` is not empty: your commits are on a branch and
     not in \`main\`.
   - **PUSHED** — what is here is not on \`origin\`: \`git log origin/main..main\` is not
     empty, or would not be once that merge happens.
   - **DEPLOYED** — this repo's CLAUDE.md describes a deploy — a daemon restart, a
     \`fly deploy\`, a script — and you did not run it.
   - **REBUILT** — this repo builds an artefact from source you changed (an APK, an
     installer, a bundle) and your diff touched that source, so what is installed is
     now stale.

   Only when none of them apply — everything committed, merged, pushed, deployed —
   write the one line that means there is nothing left at all:

       ** BEAD WORK DONE ** CAN BE CLOSED **

   **Name them; do not do them.** Merging, pushing and deploying are Adam's. Several
   sessions run on this laptop at once, and one that merges its own work races the
   others and hands him the conflict hours later, in a repo he had not been reading.
   Saying what is owed is the whole of the job here.`;

/**
 * The same line for a session that landed its own work: two verbs, not four.
 *
 * MERGED and PUSHED are gone from the ladder because the delivery did both, and a
 * session claiming to owe them would be describing work that is already on `origin`.
 * What survives is the half of the ship that beadcause deliberately did not take on —
 * the deploy and the rebuild — plus one verb the four never had:
 *
 * **REVIEWED**, for the delivery that did not merge. That is the one case where the
 * work is pushed and open and *not* in main, and it needs a word of its own: the two
 * verbs above it would both be false, and `CAN BE CLOSED` would be a session telling a
 * `/resume` list that finished work is live when it is sitting in a pull request.
 */
const LAND_MARKER_STEP = `3. **Make the last line of your final message a marker naming what is still owed**,
   on its own, with nothing after it. You are the only one who can work that out —
   you are the one who knows what you touched:

       ** BEAD WORK DONE ** CAN BE DEPLOYED, REBUILT **

   \`** BEAD WORK DONE **\` never changes. After it comes \`CAN BE \` and every step the
   work has not been through yet, comma-separated. **MERGED and PUSHED are never on this
   list** — delivering did both, through GitHub — so there are only three:

   - **DEPLOYED** — this repo's CLAUDE.md describes a deploy (a daemon restart, a
     \`fly deploy\`, a script) and you did not run it. You did not: deploying is not
     yours, and the notification tells them so.
   - **REBUILT** — this repo builds an artefact from source you changed (an APK, an
     installer, a bundle) and your diff touched that source, so what is installed is
     now stale.
   - **REVIEWED** — the delivery did *not* merge: it printed a question id rather than
     \`landed\`. Then this is the only word that applies, because nothing after the merge
     can be owed by work that has not merged.

   Whatever you write here, pass the same thing to the delivery as \`--owed\` — it puts
   it on the bead and in the notification, which is where they will actually see it.

   Only when none of them apply — merged, and nothing left to deploy or rebuild — write
   the one line that means there is nothing left at all:

       ** BEAD WORK DONE ** CAN BE CLOSED **`;

/**
 * The same line in ask-first PR mode, where there is exactly one thing a session can owe.
 *
 * It cannot owe a merge, a push or a deploy: `deliverSection` forbids all three, the
 * delivery command has already pushed the branch, and the merge is Adam answering the
 * question. So the ladder above would have nothing true to say here, and its first
 * three words would each describe something he has not agreed to.
 */
const PR_MARKER_STEP = `3. **Make the last line of your final message this, on its own, with nothing after
   it:**

       ** BEAD WORK DONE ** CAN BE REVIEWED **

   Not MERGED, not PUSHED, not DEPLOYED — none of those are yours here. Delivering
   pushed the branch, opened the pull request and filed the question that carries it
   to Adam; what is outstanding after all of that is his answer, and a line claiming
   any of the other three would be describing work he has not agreed to yet.`;

/**
 * How a session finishes when the repo has no GitHub remote: the old ending, kept.
 *
 * Not every workspace is a repo, and not every repo has a remote — the personal
 * scratch trackers under `~/beads/` mostly don't. Making the PR ending mandatory
 * would mean one unremoted repo breaks the advocate for all of them, so this is
 * what a session is told when there is nowhere to open a pull request.
 */
const closeSection = (id) => `
**When it is done:**

    bd close ${id} --reason "<one line: what you actually did>"
`;

/**
 * How a session finishes when it may land its own work — the ordinary ending now.
 *
 * The one thing this has to get across is that "land it yourself" is not permission to
 * merge however you like. There is exactly one route into `${base}` — push a branch,
 * open a pull request, ask GitHub to merge it — and the command does all three. The
 * reason is the one that put the pull request there in the first place: five sessions
 * run on this laptop at once, and five `git merge`s into a local `main` race each other
 * and hand Adam the conflict hours later. GitHub does not race; it serialises the
 * merges and refuses the ones that cannot land. So the branch is still the deliverable
 * and the merge is still a pull request's merge — what changed is only who asks for it.
 *
 * Three things the brief spells out that a session would otherwise get wrong:
 *
 * - **The command closes the bead.** A session that also closes it has closed a bead
 *   twice, and a session that *waits* to close it after the command has run has done
 *   nothing, slowly. Neither is harmful; both look like confusion in the log.
 * - **A refused merge is a finished session, not a failed one.** The delivery prints a
 *   question id, the branch is Adam's call, and there is nothing left for the session
 *   to do — it must not start rebasing, re-running CI, or trying again.
 * - **`--review` exists and is theirs to use.** The escalation for work a session
 *   genuinely does not want to land unseen. Naming it in the brief is what stops the
 *   only alternative, which is merging and worrying about it in a comment.
 */
function landSection(workspace, id, pr, owner) {
  // "squash-merges it" and "rebase-merges it" are how those two read in English;
  // "merge-merges it" is not, and `merge` is now the default, so it would be the phrase
  // nearly every brief carried. The method is still named either way — a session that
  // has to reason about what lands in the log can read it.
  const merges = pr.method === 'merge' ? 'merges it with a merge commit into' : `${pr.method}-merges it into`;
  // The one sentence in the brief that is a promise about what the command will do, in
  // a space that has said green checks are not enough on their own. Leaving it out
  // would have the brief describe a merge as the ordinary ending in the one setup
  // where the ordinary ending is a card — and a session told to expect `landed` reads
  // a question id as something having gone wrong, which is the wrong lesson entirely.
  const approval = pr.requireApproval
    ? `

**This repo waits for an approving review before anything merges**, so green checks are
not enough on their own. With no approval on the pull request yet, the delivery stops
after opening it and files the merge card — where **Merge** *is* ${owner} approving it.
That is the ordinary ending here and not a fault: expect the question id rather than
\`landed\`, and do not go looking for what went wrong.`
    : '';
  return `
**When it is done, you land it — with the command, not by hand.**

Work on a branch (the worktree your CLAUDE.md asks for is already one) and commit
everything. Then, **before you deliver, bring \`${pr.base}\` into your branch:**

    git fetch origin ${pr.base}
    git merge origin/${pr.base}

\`${pr.base}\` moves while you work — other sessions are landing on it — and GitHub will
refuse a merge that conflicts. Your branch is the only place that conflict can be fixed
by the person who wrote the code, which is you, right now, with the reasons still on your
screen. Resolve it there, **re-run the tests afterwards** (a clean merge of two working
branches is not a working tree), and only then deliver:

    ${pr.deliver} -w ${workspace} -b ${id} \\
        --tests "<how you ran them and what happened>" \\
        --owed "<what is still owed after the merge — deploy, rebuild, or drop the flag>" <<'EOF'
    <two or three paragraphs: what changed, why, and anything you are unsure of>
    EOF

That pushes your branch to \`origin\`, opens the pull request (or reuses the one already
open for the branch), waits for its checks, **${merges} \`${pr.base}\`**,
closes ${id}, and sends ${owner} a notification with nothing to answer. It prints
\`landed #<n> <url> <sha>\`. Add \`--risk "…"\` for anything that could bite and
\`--left "…"\` for what you deliberately did not do; both end up on the pull request.${approval}

**Never merge or push \`${pr.base}\` yourself.** Not \`git merge\`, not \`git push origin
${pr.base}\`, not "just this once because it is trivial". Several sessions run on this
laptop at once: five merges into a local \`${pr.base}\` race each other and hand ${owner}
the conflict hours later, in a repo they had not been reading. GitHub does not race —
it serialises the merges and refuses what cannot land — which is the entire reason the
merge happens there and not here.

**Do not close ${id} yourself.** The delivery closes it, because the merge is what makes
the work true, and it closes it in the same breath as the merge.

**If it does not merge, you are finished anyway.** It prints a question id instead of
\`landed\`, and that means GitHub refused the merge, a check went red, the checks
never reported${pr.requireApproval ? ', or nobody has approved it yet' : ''}. The reason is on ${id}, on the
pull request, and on a card in ${owner}'s inbox where the merge is one tap. Do not rebase, do not re-run CI, do not try again:
the branch is their call now, and this session's work is over.

**\`--review\` if you are genuinely unsure.** Add it and the delivery stops after opening
the pull request and asks ${owner} instead of merging. It is the right move for a
migration, a permissions change, or a diff you think is correct but wide — and the card
says outright that you chose it, so it does not read as a failure. Use it when you mean
it; it costs them a decision.
`;
}

/**
 * How a session finishes when there *is* somewhere to open a pull request and the
 * merge is Adam's — auto-merge off for this workspace's space.
 *
 * Three rules, and the first is the one that matters:
 *
 * 1. **You do not merge.** Not into main, not locally, not "just this once because
 *    it is trivial". Several sessions run at once on this laptop; when each of them
 *    merged its own work the merges raced, and every conflict that came of it landed
 *    on Adam anyway — in the worst possible form, hours later, in a repo he had not
 *    been reading. The branch is the deliverable and the merge is his tap.
 * 2. **Deliver with the command, not by hand.** `beadcause-deliver` pushes, opens or
 *    reuses the PR, files the question carrying its link, and parks this bead behind
 *    that question so nothing opens a second session on work already in review. A
 *    session doing those four things by hand will get three of them right.
 * 3. **The bead is not yours to close.** Merging closes it, because merging is what
 *    makes the work true. A session that closes its own bead here has told the
 *    tracker something that has not happened yet.
 */
function deliverSection(workspace, id, pr, owner) {
  return `
**When it is done, you do not merge it — you deliver it.**

This repo lands work through pull requests that ${owner} approves from their phone. You
have no business merging into \`${pr.base}\`, and nothing you do here should touch it.
Work on a branch (the worktree your CLAUDE.md asks for is already one), commit
everything, and then run exactly this:

    ${pr.deliver} -w ${workspace} -b ${id} \\
        --tests "<how you ran them and what happened>" <<'EOF'
    <two or three paragraphs: what changed, why, and anything you are unsure of>
    EOF

That pushes your branch to \`origin\`, opens the pull request (or updates the one
already open for this branch), and files the question that carries its link to ${owner}.
It prints the question id and the PR url. Add \`--risk "…"\` for anything that could
bite, and \`--left "…"\` for what you deliberately did not do — the commonest reason
they ask for changes is something the author already knew they had skipped.

**Do not close ${id}.** Merging closes it, and merging is theirs. Three things can come
back instead, and they mean different things:

- **Changes requested.** The approach is right, something on it is wrong. Their note is
  on the bead, the branch stays open, and the next session pushes to **the same
  branch** and delivers again — do not start a new one.
- **Declined.** The approach is wrong. The pull request is closed and that branch is
  abandoned; the bead comes back to the queue for a fresh start on a fresh branch. If
  they left direction, it is on the bead under *This approach was declined* — read it
  before you write anything, because it is the only thing separating the next attempt
  from the one they just turned down.
- **Nothing yet.** They have not answered. That is not a state you can do anything
  about, and this session is finished either way.
`;
}

/**
 * The three things a worker can owe a human, and the three different acts they are.
 *
 * The ending this replaced said "write it in a comment under `## Discovered`", and that
 * comment was invisible until the repo's advocate ran out of ready work and surveyed
 * the comments, which on a repo with a queue is never — so a discovery arrived a
 * fortnight after the context that made it obvious had gone, or it arrived not at all.
 *
 * It is now every worker's ending, not just the ones on a repo `gh` happened to be
 * able to see. This used to be reached only when `prMode` resolved, which coupled it
 * to a GitHub login it has nothing to do with: on three of Adam's four repos the
 * active `gh` account could not see the repo, so every worker there was told to write
 * a comment instead. All three channels below are `bd` beads filed through this
 * daemon; none of them touches GitHub.
 *
 * - **Discovery** — "there is more work here". The worker **creates the bead**, with
 *   `beadcause-file`, and carries on. This is the half that inverted: the bead used to
 *   be a proposal that existed only once a button was pressed, so a session that found
 *   a bug at 02:00 had to choose between dropping it and parking on a tap. It now
 *   exists immediately and arrives `unendorsed`, which means *nothing may be worked on
 *   it* — not queued by an advocate, not launchable by anything (lib/endorse.js). The
 *   review did not go away; it moved to the other side of the filing, where it costs
 *   Adam a tap rather than costing the finder its context. Say all three of those
 *   things to the worker, because a session told "file it yourself" and nothing else
 *   will either not dare or file P0s.
 * - **A question** — "I need a fact only you have". `beadcause-ask` with `--blocks`,
 *   so the bead goes blocked rather than open, and comes back to `bd ready` by itself
 *   the moment it is answered. Without this a session had two moves, and both were
 *   bad: guess, or fail quietly and let the next attempt guess. The bead that proved
 *   it was `sp-b5r` — the real blocker of a go-live, refused twice by two sessions,
 *   carrying no `human` label, so nothing ever put it in front of anyone.
 * - **A contradiction** — "two things disagree and it is not mine to settle". This one
 *   is still a *proposal*, deliberately: `--kind conflict` files a question and parks
 *   the work bead behind it, because the thing owed is an answer rather than a bead,
 *   and the session is stopped until it arrives. A session that picks one is how an
 *   unattended queue quietly does the wrong thing for a week.
 *
 * The command is named rather than the act described, and it is `beadcause-file` and
 * not `bd create`: the marker, the provenance label and the `discovered-from` edge are
 * what make an agent-filed bead safe to have created, and only that command stamps all
 * three (lib/filing.js).
 *
 * **`autoEndorse` rewrites the discovery paragraph, and it has to.** A space may file
 * without the hold (lib/spaces.js), and in that space every clause here about a tap is
 * false: the bead is ready work the moment it exists and an advocate may open a window on
 * it within the minute. This is the same trap `prMode` documents for `autoMerge` — the
 * brief is a promise about what a command will do, and a worker told "nothing will be
 * worked on it" that then watches a session start on what it filed has been lied to by
 * this file. So both versions are written here, from the same resolver `bin/file.js`
 * calls, and the one sentence that survives either way is the one that matters most to
 * the session reading it: it is not yours, carry on with the bead you have.
 */
function proposeSection(workspace, id, owner, autoEndorse = false) {
  const filed = autoEndorse
    ? `That creates the bead for real and prints its id. **It arrives endorsed** — auto-endorsement is
on for this space — with an edge back to ${id} recording where it came from, so it is ready work
straight away and ${owner}'s advocate may open its own session on it without being asked.
That still does not make it yours: **file it and carry straight on with ${id}**, do not
work the bead you just filed. ${owner} reads it after the fact rather than before, and can
close or re-aim it then, which is why what you write in it is the whole of the case for it.`
    : `That creates the bead for real and prints its id. It arrives marked \`unendorsed\`, with
an edge back to ${id} recording where it came from, and **unendorsed means nothing will
be worked on it**: no advocate queues it and no session can be opened on it until
${owner} endorses it from their phone, where they can also adjust or revoke it first. So
this costs them a tap rather than an hour, and it costs you nothing at all — **file it
and carry straight on with ${id}**, do not wait for an answer and do not go and work the
bead you just filed.`;
  return `
**Found more work while doing this? File the bead — do not swallow it, and do not wait
for permission.** Write what you found as YAML and file it the moment you find it:

    ${FILE_CMD} -w ${workspace} --from ${id} <<'EOF'
    - title: <one line>
      type: task
      priority: 2
      description: |
        What needs doing and why.
      acceptance: How we would know it is done.
      rationale: How you found it, while working ${id}.
    EOF

${filed}

File *while the reason is still on your screen* — a discovery described three hours
later is a discovery nobody can act on. Priority is capped at P2, because what you file
may not outrank the work they chose; say in the \`rationale\` if you think it is worse
than that and let them decide.

**If you need a fact only ${owner} has, ask for it — do not guess and do not give up.**
A missing decision, a number nobody wrote down, a credential, "which of these two did
you mean": that is a question, and a question you keep to yourself is the same as no
question at all. Ask it as a bead they can answer from their phone:

    ${ASK_CMD} -w ${workspace} -t '<the question, in one line>' --blocks ${id} <<'EOF'
    What you need, and why you cannot proceed without it.

    What you already tried or looked at, so they are not asked to repeat your work.

    If there are only a few possible answers, list them — an answer they can pick is
    one they can give from a phone in thirty seconds.
    EOF

\`--blocks ${id}\` parks this bead behind the question, so it leaves \`bd ready\` instead
of being handed straight back to the next advocate tick to fail the same way. It comes
back on its own the moment they answer. Then stop — say in a comment on ${id} what you
did get done, and end the session.

**If two things genuinely disagree, stop and ask — do not pick one.** Your brief
against this repo's CLAUDE.md, a bead against what the code actually does, two beads
that cannot both be right: that is not yours to resolve, and guessing is how an
unattended queue does the wrong thing for a week.

    ${PROPOSE_CMD} -w ${workspace} --from ${id} --kind conflict <<'EOF'
    - title: <the decision that has to be made>
      type: decision
      priority: 1
      description: |
        What disagrees with what, and what each way would cost.
      rationale: Hit while working ${id}; it is stopped until this is settled.
    EOF

That one parks ${id} behind the question, so nothing reopens this work until they have
answered. Then stop.
`;
}

const projectName = (workspace) => workspace.charAt(0).toUpperCase() + workspace.slice(1);

/** Tab titles go through AppleScript and a window title bar; keep them boring. */
const safeTitle = (s) =>
  String(s || '')
    .replace(/[^\w .,:/'()&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

/**
 * Open an iTerm2 window running `claude` on this question.
 *
 * The prompt goes via a temp file the shell reads and deletes, so a multi-line
 * markdown brief never has to survive being typed through AppleScript into a shell
 * as a quoted argument.
 */
export function openSession(cfg, workspace, id, title) {
  const dir = resolveSessionDir(cfg, workspace);
  return launch(cfg, dir, promptFor(workspace.name, id, title), safeTitle(`${id} · ${title || workspace.name}`));
}

/**
 * The brief for a session opened to *land* a merged pull request.
 *
 * What Ship does in a repo that has **not** written its deploy down. Where there is a
 * `deploys.<workspace>` entry the daemon runs it directly and this is never reached
 * (`POST /api/pr/ship`); where there is not, there is nothing to run — what a deploy
 * *is* lives in that repo's CLAUDE.md (a launchd kickstart here, `fly deploy` there, an
 * APK rebuild when `android/` moved), beadcause cannot read it and must not guess it
 * from a phone in another room, so it asks for the one thing that can: a session in the
 * checkout with the repo's own rules in front of it.
 *
 * So the brief says what is already true and asks for the rest. It deliberately does
 * not restate the steps: this Mac has a `ship` skill that is the authority on them,
 * it is kept current, and a second copy here would be wrong within a fortnight. What
 * it *does* pin down is the scope — this is a deploy-only run, the branch work is
 * over — because "ship it" to a session that has just read the ship skill could
 * otherwise mean sweeping worktrees and retiring things nobody asked it to touch.
 */
function shipPromptFor(workspace, row, owner = ownerName()) {
  const beads = (row.beads || []).map((b) => b.id).join(', ');
  const state = [
    row.pushed === true ? `it is on origin/${row.base}` : `it may not be on origin/${row.base} yet`,
    row.local === true ? `local ${row.base} has it` : `local ${row.base} does not have it yet`,
    row.deployTracked
      ? row.deployed === true
        ? 'and it is already in the running build'
        : 'and it is **not** in the build that is running'
      : 'and this repo has no deploy beadcause can see',
  ].join(', ');

  return `Ship **#${row.number}** in \`${row.repo || workspace}\` — ${row.title}

${owner} pressed Ship on the beadcause PR board. The pull request is **already merged**${
    beads ? ` and it carried ${beads}` : ''
  }: ${state}.

**This is a deploy-only run.** There is no branch to merge and no worktree of yours to
retire — the work landed through GitHub. What is left is everything after the merge:

1. Bring this checkout's \`${row.base}\` up to date with \`origin/${row.base}\`, and stop
   and say so if there is uncommitted work in the way rather than merging over it.
2. Run this repo's own gate before anything is restarted. What that is, is in its
   CLAUDE.md — use it, not a guess.
3. Deploy the way *this repo* deploys, and rebuild whatever it builds from source that
   moved. Use the \`ship\` skill for the how; it is the authority on both, and only the
   steps after the merge apply here.

Then tell me, in one short message, what you actually ran and what is now live. If any
of it failed, say which step and stop — a half-deploy reported as done is worse than a
deploy that did not happen.
`;
}

/**
 * Open an iTerm window to land a merged pull request.
 *
 * `row` is one entry from lib/prboard.js, passed whole: the prompt needs the number,
 * the base, and the three facts about where the merge commit has and has not reached,
 * and a session told "ship it" without them starts by working out what beadcause
 * already knew.
 */
export function openShipSession(cfg, workspace, row) {
  const dir = resolveSessionDir(cfg, workspace);
  return launch(cfg, dir, shipPromptFor(workspace.name, row, ownerName(cfg)), safeTitle(`⇪ ship #${row.number} · ${workspace.name}`));
}

/**
 * Open a session to *work* a bead, on an advocate's initiative rather than yours.
 *
 * Same window, same permission mode, deliberately different brief. The discuss
 * prompt above exists because you tapped a question and want to talk; this one is
 * opened by lib/advocate.js when a bead comes ready and you are, as often as not,
 * asleep. So it says the thing the other prompt never has to: nobody is watching,
 * the repo's own rules are the rules, and the two ways to stop — done, or handed
 * back to you — are both spelled out, because an unattended session with no honest
 * exit invents one. "You" is named in the brief itself, from `owner` in the config
 * — see lib/owner.js.
 *
 * **It refuses an unendorsed bead**, before it resolves a directory or writes a
 * prompt, and that refusal — not the advocate's queue filter — is what actually makes
 * endorsement mean something: this is the only door into an unattended session, so a
 * held bead that reached it by any other route still cannot be worked. It needs `bd`
 * to ask, and a caller that passes none gets the refusal too, because "I could not
 * check" and "it is fine" are not the same answer. See lib/endorse.js.
 *
 * **And it refuses a bead marked `superseded-by:` another**, off the row that check has
 * just read — a duplicate somebody parked behind its original is that original's work
 * rather than its own, and the moment the original lands is precisely when it looks like
 * ready work to everything that has not read its labels. See lib/superseded.js, and note
 * that this refusal carries more weight than the endorsement one: the marker's id makes
 * it un-excludable on bd's own command line, so the queue filter behind it is a row
 * check in one function rather than a flag the tracker itself honours.
 */
export async function openWorkSession(cfg, workspace, bead, { attempt = 1, doneFile = null, bd = null } = {}) {
  assertNotSuperseded(await assertEndorsed(bd, workspace, bead));
  const dir = resolveSessionDir(cfg, workspace);
  return launch(
    cfg,
    dir,
    // `autoEndorse` is resolved here rather than inside `prMode`, deliberately: `prMode`
    // is null on a repo with no GitHub remote, and what happens to a bead this session
    // files has nothing to do with GitHub. Coupling the two is the bug this file already
    // fixed once, when a repo `gh` could not see got no discovery ending at all.
    workPromptFor(workspace.name, bead, attempt, await prMode(cfg, dir, workspace.name), ownerName(cfg), {
      autoEndorse: autoEndorseAllowed(cfg, workspace.name),
    }),
    safeTitle(`▶ ${bead.id} · ${bead.title || workspace.name}`),
    { doneFile }
  );
}

/**
 * Can this session deliver through a pull request, and against what?
 *
 * `null` means no, and every "no" here is a state rather than a failure: PR delivery
 * switched off in config, no `gh` on the Mac, or a checkout with no GitHub remote —
 * a scratch tracker under `~/beads/` has none, and there is nothing wrong with that.
 * The session then gets the older brief, closes its own bead, and the repos that *do*
 * have remotes are unaffected. One unremoted workspace must never be able to stop the
 * advocate opening sessions on the others.
 *
 * Asked per launch rather than cached with the config, because the answer is per
 * repo. `available()` inside it is cached, so this costs one `gh repo view` per
 * session opened, which against the twenty seconds an iTerm window takes to come up
 * is nothing.
 */
export async function prMode(cfg, dir, workspaceName = null) {
  if (cfg.pr?.enabled === false) return null;
  if (!(await github.available()).ok) return null;
  const repo = await github.slugFor(dir);
  if (!repo) return null;
  // Both PR answers come from one place, resolved for this workspace's space — the
  // same call `bin/deliver.js` makes, so the brief and the command cannot disagree
  // about which ending this session is heading for.
  const policy = prPolicyFor(cfg, workspaceName);
  return {
    repo,
    base: cfg.pr?.base || 'main',
    // The same fallback `bin/deliver.js` uses, because this is the sentence that
    // promises what that command will do and the two must not disagree.
    method: cfg.pr?.mergeMethod || 'merge',
    // Does the delivery end in a merge, or in a question? It decides which of two
    // endings the brief describes and which marker line the session is asked to write,
    // and those have to agree with what `beadcause-deliver` will actually do — a brief
    // promising a merge to a session whose delivery then files a question is how you
    // get a window that reports work as landed and a bead that says otherwise.
    autoMerge: policy.autoMerge,
    // Whether the merge waits on an approving review. Only ever true alongside
    // `autoMerge`, and it changes two sentences rather than the ending: the brief must
    // not promise a merge "once the checks report" in a space where green checks are
    // explicitly not enough, and the reason a delivery hands over is one item longer.
    requireApproval: policy.autoMerge && policy.requireApproval,
    deliver: DELIVER_CMD,
    // `propose` used to be handed out here too, which is the shape of the bug this
    // file just lost: the propose command was only reachable through a PR mode, so a
    // repo `gh` could not see had no way to propose anything. It is a constant in this
    // module and the brief now names it directly, whatever GitHub says.
  };
}

/**
 * The send-off: a countdown and an explosion, on the way out.
 *
 * A worker window used to vanish the instant `claude` stopped, and that is the one
 * thing a finished run and a crash look identical doing. Nobody is reading that
 * window's scrollback and it has no status line, so the only moment it can ever say
 * "this ended on purpose" is the moment it closes — and it was spending that moment
 * disappearing. Now it counts 3, 2, 1 and goes out with a bang: five seconds in which
 * anyone at the Mac can watch a window *finish* rather than merely stop, and a beat
 * long enough to catch the last thing the session said before the window takes it.
 *
 * Three things about its shape are load-bearing:
 *
 * - **It runs after `$?` is captured, never before.** Everything in here is a `printf`
 *   or a `sleep`, and every one of them overwrites the status. The done file is the
 *   daemon's only fact about how a session ended (see `sessionEnding`), so the
 *   countdown has to come second — put it first and every session reports success.
 * - **One line, no newlines.** The whole command is typed into a shell by
 *   `scripts/open-session.applescript`, where a newline is a command boundary rather
 *   than a character; half of this would run on its own, immediately, as its own
 *   command line.
 * - **The art arrives as arguments to `printf '%s\n'`, not as a format string.**
 *   `\`, `|` and `/` are most of what an explosion is drawn from, and a backslash does
 *   not survive a format intact: `\ ` and `\(` are undefined escapes that each shell
 *   renders however it likes. As arguments they are bytes, and what is written here is
 *   what lands on the screen.
 *
 * The countdown rewrites one line in place with `\r`, then wipes it with a blank
 * `%40s` field, so the explosion prints onto a clean line instead of over the tail of
 * "closing this window...".
 */
const BOOM = [
  '',
  '        \\   .  |  .   /',
  '      .  \\  \\ | /  /  .',
  '   ---  *   B O O M   *  ---',
  '      .  /  / | \\  \\  .',
  '        /   .  |  .   \\',
  '',
  '            \\(^_^)/   all done',
  '',
];

const SENDOFF = [
  `printf '\\n'`,
  `for n in 3 2 1; do printf '\\r   ( %s )  closing this window... ' "$n"; sleep 1; done`,
  `printf '\\r%40s\\r' ''`,
  `printf '%s\\n' ${BOOM.map((line) => `'${line}'`).join(' ')}`,
  `sleep 2`,
].join('; ');

/**
 * What a launched session runs once `claude` has exited — or nothing at all.
 *
 * `null` is the chat session, and an empty string is the point of it: that window was
 * opened for you to talk in, so it must come back to a prompt and stay there. Only a
 * session with a done file is one nobody is sitting at, and only that one may end
 * itself — which is why the send-off hangs off the same condition as `exit` rather
 * than off a switch of its own. A window that is not closing has nothing to count
 * down to.
 *
 * Exported because the order inside it is the whole of its correctness and nothing
 * downstream can see it: `launch` hands the string to AppleScript, and by the time it
 * is observable it is a window on a screen. test/sendoff.mjs runs this very string in
 * a real zsh and reads the done file back out.
 *
 * `cleanup` is the temp files the *session* owns rather than the daemon — the system
 * prompt, today. The daemon cannot delete them itself: it hands the command to
 * AppleScript and returns, with `claude` yet to read the file, and it never learns when
 * the window closed. So the shell that outlives it does it. Note where they go: after
 * the status capture, never before it. Every `rm` sets `$?` too, and the done file is
 * the daemon's only fact about how a session ended.
 */
export const sessionEnding = (doneFile, cleanup = []) => {
  const parts = [];
  if (doneFile) parts.push(`printf '%s' "$?" > ${shq(doneFile)}`);
  if (cleanup.length) parts.push(`rm -f ${cleanup.map(shq).join(' ')}`);
  if (doneFile) parts.push(SENDOFF, 'exit');
  return parts.length ? `; ${parts.join('; ')}` : '';
};

/**
 * The whole line a work session runs, from `cd` to the send-off.
 *
 * Exported and pure for the same reason `sessionEnding` is: everything below is
 * invisible from Node the moment `launch` hands it to AppleScript, and three of the
 * things it has to get right are things nothing downstream would ever complain about.
 *
 * - **The exports are in the string, not in the spawn.** iTerm runs this in a fresh
 *   login shell that inherits nothing from the daemon, so an env object handed to
 *   `osascript` reaches osascript and dies there. `agentEnv` is therefore the wrong
 *   tool here and `agentExports` is the right one — see the note beside it. Without it
 *   `beadcause-memory` is not on PATH, and if it were, every write would fail for want
 *   of a `BEADCAUSE_AGENT` to write as.
 * - **The prompt comes before the flags.** `--tools` and `--allowedTools` are variadic,
 *   so a foundation that ever sets either would swallow a trailing `"$P"` as one more
 *   tool name and the session would come up having been asked nothing at all. The
 *   baseline sets neither; an amendment may, and this is not a thing that should wait
 *   to be discovered by the amendment that does it.
 * - **`cd` is first**, because the interactive `chpwd` hook re-runs `_bd_set_workspace`
 *   there, and that is what points BEADS_DIR and CLAUDE_CONFIG_DIR at the right tree
 *   before `claude` starts.
 */
export function sessionCommand(f, { dir, promptFile, systemFile = null, mode = null, doneFile = null }) {
  const flags = [permissionFlag(mode), ...claudeArgs(f, { systemFile }).map((a) => ` ${a}`)].join('');
  return [
    `cd ${shq(dir)}`,
    agentExports(f),
    `P="$(cat ${shq(promptFile)})"`,
    `rm -f ${shq(promptFile)}`,
    `claude "$P"${flags}${sessionEnding(doneFile, systemFile ? [systemFile] : [])}`,
  ].join(' && ');
}

/**
 * The AppleScript half, shared by both: write the brief, hand iTerm the command.
 *
 * `doneFile` is what makes an unattended session *end* rather than merely stop.
 * The command is typed into an interactive shell, so when `claude` exits you get a
 * prompt back and the window sits there forever — fine for the one you opened to
 * talk something through, useless for an advocate that will open dozens. So a work
 * session appends three things: the exit status written to a file, the send-off above,
 * and `exit`, which ends the shell and lets iTerm close the window behind it.
 *
 * The file is the more valuable half. Without it the daemon can only *infer* that a
 * session finished, by watching the bead and waiting out a grace period; with it,
 * the moment the process exits is a fact, and "exited having closed the bead" and
 * "exited leaving it open" stop looking the same. It is written with `;` rather
 * than `&&` on purpose — a session that failed is exactly the one worth hearing
 * about.
 */
async function launch(cfg, dir, prompt, tabTitle, { doneFile = null } = {}) {
  const stamp = crypto.randomBytes(6).toString('hex');
  const promptFile = path.join(os.tmpdir(), `beadcause-${stamp}.md`);
  const systemFile = path.join(os.tmpdir(), `beadcause-sys-${stamp}.md`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });

  // An approved amendment wins over config, because it was approved for this agent
  // specifically; config is the deployment-wide default underneath it. Same order as
  // `withConfig` applies for the chat session.
  const f = await effective(dir, 'worker');
  const mode = f.permissionMode ?? cfg.sessionPermissionMode;

  // The amendable half of what this agent is, then the one copy of the memory brief —
  // the same order and the same reasoning as lib/console.js. A system prompt and not a
  // preamble to the brief: a work session runs for as long as the work takes, and what
  // it *is* has to still be in front of it on the fortieth turn, not buried under
  // forty turns of a task. `role` is amendable and the brief below it is not, which is
  // the line the whole of lib/foundation.js draws.
  fs.writeFileSync(systemFile, systemPrompt(f, memoryBrief(ownerName(cfg))), { mode: 0o600 });

  const command = sessionCommand(f, { dir, promptFile, systemFile, mode, doneFile });

  // Where the window goes, and what it opens as. Keyed on the tab title because that is
  // what carries the bead id: the same bead reopened lands on the same square of the
  // table, which is worth more than it sounds when you are looking for the session you
  // started twenty minutes ago among a dozen identical rectangles.
  //
  // Both halves fail soft, inside lib/iterm.js — a Mac that would not answer the screen
  // probe, or an iTerm too old to have been given the profile yet, gets an empty string
  // here and the AppleScript opens the window exactly as it did before any of this.
  const windows = cfg.sessionWindows || {};
  const { profile, bounds } = await placement(windows, tabTitle);
  const takeFocus = windows.stealFocus === true;
  // Asked *before* the window exists, because a moment later the answer is iTerm.
  const prior = takeFocus ? null : await frontmostApp();

  return new Promise((resolve, reject) => {
    const args = [SCRIPT, command, tabTitle, profile, bounds, takeFocus ? 'take-focus' : 'return-focus'];
    execFile('/usr/bin/osascript', args, { timeout: 20000 }, (err, stdout, stderr) => {
      // The AppleScript has already handed the keyboard back to whichever *iTerm* window
      // had it; this is the other half, for the case where you were not in iTerm at all
      // — the usual one, since the button that opens a session is on a phone or in a
      // browser. Deliberately not awaited: the session is open either way, and nothing
      // downstream should wait on a courtesy.
      if (prior) restoreApp(prior);
      // Report the mode back so it lands in the log. A session that silently came
      // up in the wrong permission mode is invisible otherwise — you'd only notice
      // when it stopped to ask you something from the other room.
      //
      // `term` is the iTerm session id the script printed: the handle `messageSession`
      // needs to talk to this window later. Empty rather than absent on an older iTerm
      // that returns nothing — the caller must treat "no handle" as a state, because
      // every worker launched before this existed is in it.
      if (!err) return resolve({ dir, mode: mode || 'default', term: String(stdout || '').trim() || null });
      fs.rmSync(promptFile, { force: true });
      const detail = `${stderr || ''}${err.message}`;
      // -1743 is macOS refusing the Apple event outright. The daemon runs under
      // launchd, where a TCC prompt may never be shown to anyone, so say what to do.
      if (/-1743|not authori[sz]ed|Not authorized to send Apple events/i.test(detail)) {
        return reject(
          Object.assign(
            new Error(
              'macOS blocked beadcause from controlling iTerm. Approve it once in ' +
                'System Settings → Privacy & Security → Automation, then try again.'
            ),
            { status: 403 }
          )
        );
      }
      reject(new Error(detail.split('\n')[0] || 'could not open a session'));
    });
  });
}

/* ------------------------------------------------------- talking to a session */

/**
 * Can this session be spoken to at all, and if not, why not?
 *
 * Everything above this line talks to windows *this daemon opened*: the advocate keeps
 * the iTerm session id it got back from `open-session.applescript`, and that id is an
 * exact handle. Most sessions on the Mac are not those. A session you started at the
 * keyboard was never opened here, has no id recorded anywhere, and until now was a row
 * you could watch and not answer.
 *
 * What every process has instead is a **controlling terminal**, and iTerm exposes the
 * same value on its side as `tty of session`. So the join is `pid → /dev/ttysNNN →
 * the window showing it`, and it needs nothing remembered at launch — which is the
 * only reason this reaches sessions that predate the feature.
 *
 * Three answers, and the point of the whole function is that they are different:
 *
 *   - **`can: true`** — a tty, hosted by iTerm. Typing will land.
 *   - **no controlling terminal** — `ps` says `??`. A session run headless, over the
 *     SDK, or from a launchd job. There is no input to type into, not merely no window.
 *   - **a terminal iTerm is not showing** — Terminal.app, tmux, a VS Code panel, ssh.
 *     The session is running fine and is simply out of reach of the one channel there
 *     is, and saying "finished" or staying silent about it would both be lies.
 *
 * `why` is written to be shown to a person as-is, because the page has nothing else to
 * go on and a code it had to translate would be a second place to keep this list.
 */
export async function sessionReach(pid) {
  const tty = await ttyForPid(pid);
  if (!tty) {
    return {
      can: false,
      tty: null,
      why: 'It has no terminal — nothing on this Mac has an input line for it.',
    };
  }
  const ttys = await itermTtys(tty);
  if (!ttys.has(tty)) {
    return {
      can: false,
      tty,
      why: `Its terminal (${tty}) is not an iTerm window — it may be in Terminal.app, tmux, or over ssh.`,
    };
  }
  return { can: true, tty, why: null };
}

/**
 * The controlling terminal of a process, as the absolute path iTerm reports.
 *
 * `ps -o tty=` prints the device without its directory (`ttys004`), and `??` — or on
 * some releases a bare `?` — for a process that has none. Both become null: "no
 * terminal" is a state this has to be able to return, not an error, because it is the
 * honest answer for every session that is not in a window.
 */
function ttyForPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'tty=', '-p', String(pid)], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null); // the process went away between the list and here
      const t = String(stdout || '').trim();
      resolve(!t || t.startsWith('?') ? null : `/dev/${t}`);
    });
  });
}

/** A hit is good for this long: a session's tty never changes while it lives. */
const ITERM_TTY_TTL = 10_000;
/** …but a *miss* re-asks this often, because a miss is the answer worth being right about. */
const ITERM_TTY_MIN = 1_500;

let ttyCache = { at: 0, set: new Set() };
let ttyInFlight = null;

/**
 * Which terminals iTerm is hosting — cached, because `/api/session-log` polls.
 *
 * The probe costs about half a second of `osascript`, which is far too much to spend
 * twice a second per open page, and far too little to be worth a watcher. So it is
 * cached, with the asymmetry that makes a cache safe here: **`wanted` is the tty the
 * caller is asking about, and a cached set that does not contain it is refreshed
 * early.** A stale "yes" is harmless — the send is the real authority and reports
 * `missing` if the window has gone — while a stale "no" tells you a session you are
 * looking at cannot be spoken to when it can, which is the one wrong answer that
 * stops you using the feature. `ITERM_TTY_MIN` is what keeps that from becoming an
 * `osascript` per poll for a session that genuinely is out of reach.
 *
 * A failure resolves to the last known set rather than throwing. iTerm not running is
 * already an empty answer from the script itself, so the only things left here are a
 * TCC refusal or a timeout, and neither is a reason for the page to break — the send
 * will say so properly, with the wording that tells you what to approve.
 */
async function itermTtys(wanted = null) {
  const age = Date.now() - ttyCache.at;
  const fresh = wanted && !ttyCache.set.has(wanted) ? age < ITERM_TTY_MIN : age < ITERM_TTY_TTL;
  if (fresh) return ttyCache.set;
  // One probe serves every caller that arrives while it is running. Without this, four
  // pages polling in step would each start their own `osascript`.
  if (!ttyInFlight) {
    ttyInFlight = new Promise((resolve) => {
      execFile('/usr/bin/osascript', [TTY_SCRIPT], { timeout: 15000 }, (err, stdout) => {
        if (!err) {
          ttyCache = {
            at: Date.now(),
            set: new Set(
              String(stdout || '')
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean)
            ),
          };
        }
        ttyInFlight = null;
        resolve(ttyCache.set);
      });
    });
  }
  return ttyInFlight;
}

/**
 * Close a message up to one line, newlines and all.
 *
 * This used to be mandatory on the way out — `write text` pressed return at the end of
 * a line, so anything with a second line in it submitted twice. It is not any more:
 * `message-session.applescript` sends the text as a bracketed paste with no newline and
 * a bare Return after it, so what you type is what arrives.
 *
 * It stays because the *templates* still want it. A check-in written as one line is one
 * line by construction rather than by a rule enforced somewhere else, and reads that way
 * in the window it lands in. So this is now a choice a caller makes about its own text,
 * not a toll every message pays.
 */
export const oneLine = (text) => String(text).replace(/\s*\n+\s*/g, ' ').trim();

/**
 * What the pty must not carry: a bare carriage return.
 *
 * Inside a bracketed paste, Claude Code takes CR (`0x0d`) as submit and LF (`0x0a`) as a
 * line break — so a `\r\n` that survived from somewhere would send half the message and
 * type the rest into the next turn. Browsers normalise a textarea to LF already, which
 * is why nothing has ever hit this; it is here because the one thing this channel must
 * never do is submit a message in the middle, and a normalise is cheaper than trusting
 * every future caller to have come from a textarea.
 */
export const pasteSafe = (text) => String(text).replace(/\r\n?/g, '\n');

/**
 * Say something to a session, and find out if it is still there.
 *
 * Resolves `'sent'` or `'missing'`. Missing means no iTerm session carries that handle
 * any more, which is the one fact the daemon could never establish before: a window
 * closed by hand kills the shell with a SIGHUP, so nothing is written, nothing is
 * observed, and the slot it held stayed held until it timed out hours later.
 *
 * `handle` is either an iTerm session id — what the advocate kept when it opened a
 * worker — or a `/dev/ttysNNN` path from `sessionReach`, which is how a session nobody
 * here launched is addressed. The AppleScript matches either; see its header for why
 * they cannot be confused for one another.
 *
 * **Multi-line, as typed.** Two paragraphs arrive as two paragraphs and submit as a
 * single turn: the AppleScript wraps the text in bracketed paste, sends it with no
 * newline, and presses Return once afterwards. Nothing is flattened on the way out any
 * more, and nothing downstream should say it was. The only thing done to the text here
 * is `pasteSafe`, because a stray CR would submit the message halfway through.
 *
 * A refusal from macOS is *not* turned into `missing`: "iTerm would not talk to us"
 * and "that window is gone" would then be indistinguishable, and the second one frees
 * a slot out from under a session that is still working in it.
 */
export function messageSession(handle, text) {
  const body = pasteSafe(text);
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      [MESSAGE_SCRIPT, String(handle), body],
      { timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = `${stderr || ''}${err.message}`;
          if (/-1743|not authori[sz]ed|Not authorized to send Apple events/i.test(detail)) {
            return reject(
              Object.assign(
                new Error(
                  'macOS blocked beadcause from controlling iTerm. Approve it once in ' +
                    'System Settings → Privacy & Security → Automation, then try again.'
                ),
                { status: 403 }
              )
            );
          }
          return reject(new Error(detail.split('\n')[0] || 'could not reach that session'));
        }
        resolve(String(stdout || '').trim() === 'missing' ? 'missing' : 'sent');
      }
    );
  });
}

/**
 * What a worker is asked when you press Reclaim sessions.
 *
 * Two endings, both already defined elsewhere in the brief, and no third: check in
 * and carry on, or finish the way the brief says to finish. Deliberately *not* "reply
 * and tell me" — a prose answer typed into a window nobody is watching reaches
 * nothing. The check-in is a command because a command is the only kind of answer the
 * daemon can hear.
 *
 * One line by choice, not because the channel demands it any more — a check-in is one
 * sentence of instruction and a command to run, and six lines of it in a window someone
 * is working in is six lines to scroll past. `oneLine` is what makes that a property of
 * this template rather than a rule enforced two layers down. It names the deadline so
 * the choice is informed: a session that decides to keep working knows what silence
 * costs.
 */
export function checkinMessage(workspaceName, id, minutes) {
  return oneLine([
    `** BEADCAUSE CHECK-IN ** Are you still working on ${id}?`,
    `If yes, run this now and carry straight on:`,
    `${CHECKIN_CMD} -w ${workspaceName} -i ${id} -m "<what you are doing>".`,
    `If the work is finished, do the ** BEAD WORK DONE ** steps from your brief and exit.`,
    `Answer with the command, not with prose — nobody is reading this window.`,
    `Unanswered for ${minutes} minutes and your slot goes to another bead.`,
  ].join(' '));
}
