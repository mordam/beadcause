import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { effective, withModel, claudeArgs, promptArgs, systemPrompt, agentExports } from './foundation.js';
// The routing half of bc-nc6o: how hard the bead is → which model the window comes up
// on. One call, in `openWorkSession` alone — see the note there for why a planner is not
// routed by the tier of the epic it is planning.
import { modelForBead } from './complexity.js';
import { memoryBrief, notesBrief, notesIn, debriefBrief, debriefFamily } from './memory.js';
import * as agentrepo from './agentrepo.js';
// Tier 4's read half — the archive is what holds a debrief, so this is where it is read
// from. See `readDebriefs`; `debriefsFor` below is the one call this file makes of it.
import { archivedBeads, readDebriefs } from './sessionlog.js';
import { placement, frontmostApp, restoreApp, boundsArg, parseBounds } from './iterm.js';
import { assertEndorsed } from './endorse.js';
import { assertUnderP0 } from './underp0.js';
import { EPIC_ADVOCATE, epicAdvocatePrompt, isCrash, wantsAdvocate } from './epicadvocate.js';
import { isP0 } from './ownership.js';
import { assertNotSuperseded, SUPERSEDE_PREFIX } from './superseded.js';
import { assertStillOpen } from './stillopen.js';
import { assertNotShipBead } from './shipbead.js';
import { editBriefFor } from './editwork.js';
import { ownerName } from './owner.js';
import { baseFor } from './prbase.js';
import { multiRepo, resolveRepo, beadToken, repoLabel, repoSummary, whereLanded } from './repos.js';
import * as github from './pr.js';
import { prPolicyFor, autoEndorseAllowed, autoShipAllowed } from './spaces.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'open-session.applescript');
const MESSAGE_SCRIPT = path.join(ROOT, 'scripts', 'message-session.applescript');
const TTY_SCRIPT = path.join(ROOT, 'scripts', 'iterm-ttys.applescript');
const FOCUS_SCRIPT = path.join(ROOT, 'scripts', 'focus-session.applescript');

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
const PLAN_CMD = `node ${path.join(ROOT, 'bin', 'plan.js')}`;

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
 * Where to start a session about a question in `workspace`, and which repo that is.
 *
 * Returns `{ dir, repo }`. `repo` is `{name, dir, token}` for a workspace that holds
 * several checkouts and **null** for every other workspace on every other install —
 * which is almost all of them, and is why `dir` is what nearly every caller wants.
 *
 * Three modes now, and the first is the only new one:
 *
 * - **A workspace with an approved repo list.** The bead says which checkout it is
 *   about, by carrying that repo's service token as a `repo:<token>` label, and
 *   lib/repos.js turns that token into a directory. A bead carrying none belongs to the
 *   list's `default` repo. This branch is reached only when `repos.<workspace>.approved`
 *   names something — see below for why it takes the whole answer when it is.
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
 * `sessionDirs.<workspace>` overrides the second and third. It does **not** override the
 * first, and that is a decision rather than an oversight: it pins one directory, and a
 * multi-repo workspace has no one directory to pin. Honouring it would send every bead
 * in the workspace to the same checkout however it was labelled, silently — so a
 * workspace configured both ways gets a warning at load (`repoWarnings`) and the repo
 * the bead named.
 *
 * **Nothing that is one repo today changes answer.** `multiRepo` is false for every
 * workspace with no `repos` block, which is the whole of `sophab`, `deluvia`, `ehatt`
 * and `beadcause` itself, and the branch below returns before reading anything from
 * disk. That is asserted in `test/sessiondir.mjs` rather than argued here.
 */
export function resolveSessionRepo(cfg, workspace, bead = null) {
  if (!multiRepo(cfg, workspace.name)) return { dir: resolvePlainSessionDir(cfg, workspace), repo: null };
  const repo = repoFor(cfg, workspace, bead);
  return { dir: repo.dir, repo };
}

/**
 * The same question, answered with the directory alone.
 *
 * The name every one of the twenty-five call sites already uses, and the third argument
 * is optional at every one of them: a caller with no bead in hand — the advocate's
 * open-PR sweep, the deploy board — gets the workspace's `default` repo, which is the
 * right answer for a question that is about the workspace rather than about one bead.
 */
export const resolveSessionDir = (cfg, workspace, bead = null) => resolveSessionRepo(cfg, workspace, bead).dir;

/**
 * The checkout a bead in a multi-repo workspace belongs in, or a 409 saying why there
 * isn't one.
 *
 * It throws rather than falling back, and the sentence it throws is `resolveRepo`'s own.
 * "A bead with no service token belongs to `architecture`" is true and is what `default`
 * is for; "a bead whose token I could not resolve belongs to `architecture`" is how work
 * aimed at one service quietly lands in the repo that holds the workspace's Dolt remote,
 * hours before anybody looks. An unknown token, a token two approved repos both declare,
 * and a bead labelled `repo:` twice are all that second thing, and all three refuse.
 *
 * 409 because that is the status every other refusal here carries, and lib/server.js
 * already turns it into a sentence on the screen the tap came from.
 */
function repoFor(cfg, workspace, bead) {
  const { token, problem: labelProblem } = beadToken(bead);
  if (labelProblem) {
    throw Object.assign(new Error(`this bead ${labelProblem}, so it names no ${workspace.name} checkout`), { status: 409 });
  }
  const { repo, problem } = resolveRepo(cfg, workspace.name, token);
  if (repo) return repo;
  throw Object.assign(new Error(`no ${workspace.name} checkout for this bead — ${problem}`), { status: 409 });
}

/** Everything `resolveSessionDir` did before a workspace could hold more than one repo. */
function resolvePlainSessionDir(cfg, workspace) {
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

/**
 * One sentence saying which checkout this is, for a brief opened in a workspace that
 * holds several.
 *
 * Empty everywhere else, and that is the point: `sophab` is one repo and an agent told
 * "you are in the sophab checkout of the sophab workspace" has been given a fact it can
 * see from `pwd`. Where the workspace holds forty, the same sentence is the difference
 * between an agent that knows what it is looking at and one that reads `~/climative.dev`
 * off its prompt and starts guessing.
 */
function repoNote(workspaceName, repo) {
  if (!repo) return '';
  return `\n**This window is the \`${repo.name}\` checkout.** The ${workspaceName} workspace holds
several repos behind one tracker, and this bead names that one (\`${repoLabel(repo.token)}\`).
Work here belongs to that repo; if it turns out to belong to another, say so rather than
moving to it.\n`;
}

/** What the session opens with. Deliberately brief — it can read the bead itself. */
function promptFor(workspace, id, title, repo = null) {
  return `Discuss beadcause question **${workspace}/${id}** with me.

> ${title || '(untitled)'}
${repoNote(workspace, repo)}
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
 * - **Claim first — but read the status first of all.** `bd update --claim` is the only
 *   signal every other view in beadcause already reads, so claiming is what makes this
 *   window appear on the sessions page and stops a second advocate tick picking the same
 *   bead up. On a *closed* bead the same command reopens merged work, which is bc-uaxn:
 *   a window opened on a bead closed seventy-eight minutes earlier, where obeying the
 *   brief in order would have put it back in the queue for the next window to find. So
 *   the brief says outright what to do when `bd show` answers `CLOSED`, and
 *   lib/stillopen.js refuses the launch on the doors this daemon owns — the brief covers
 *   the windows it does not.
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
 * - **Hand it what the last session in this repo already paid for.** `LEARNED_STEP` at
 *   the bottom asks a session to write a note; this puts the notes it wrote in front of
 *   the next one, selected against the bead — see `notesBrief` in lib/memory.js for the
 *   rule and what it costs when the pile is large. The system prompt already says to run
 *   `beadcause-memory notes`, and that line stays: the two are push and pull of the same
 *   store, and the pull is what still works for everything the selection did not pick.
 *   But a session that has to *remember* to read before it has read anything mostly does
 *   not, and this repo's store went from empty to twenty notes in a day — a store nobody
 *   opens is a store that was never worth writing to.
 * - **And what the last session at this bead actually hit.** The bullet above is tier 1,
 *   selected by similarity out of what this repo's workers know. `debriefBrief` is tier 4
 *   beside it: the reports earlier runs at this bead, its epic and its siblings left as
 *   they ended, narrowed by the graph rather than by vocabulary. The two are not
 *   redundant and the difference is what each is for — a note is a lesson that should
 *   still hold next month, a debrief is an account of an attempt, and it is the second
 *   that answers "has anybody tried this before, and what happened". This is the push
 *   half; `beadcause-memory debriefs` is the pull, and both are named in the brief.
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
 * - **The merge is Adam's tap** (`PR_MARKER_STEP`) — none of the four are the session's at
 *   all: it delivers a branch and a question, and the merge *is* him answering.
 *   `CAN BE REVIEWED`, and nothing else it could write is true. Two things reach it: a
 *   space with auto-merge off, and — whatever the space says — a bead that came out of
 *   edit mode, because an in-app edit is merged by the person who asked for it. See
 *   `editBriefFor` in lib/editwork.js, and `edit` in the options below: it is the
 *   section of brief that says so, and it doubles as the flag for this ending, so a
 *   window can never be told what an in-app edit is and then offered the landing ending
 *   underneath it.
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
 *
 * `bead.batch`, when the advocate set it, is the other beads under this epic that this
 * one window is briefed on — see `batchesFor` in lib/advocate.js. It arrives on the bead
 * rather than as a parameter so this stays a pure function of its arguments, which is
 * what lets test/land.mjs assert every ending without a repo.
 *
 * `bead.group` is the same idea one step up: the group of an epic's **plan** that this
 * window carries, written by an epic worker rather than computed (lib/plan.js). The two
 * are mutually exclusive by construction — a bead is dispatched by a plan or by the
 * mechanical batching that runs when there is no plan, never both — and the difference
 * they make to the brief is the same difference in kind: a batch says "you decide what
 * belongs together", a group says "somebody already decided, and here is what they said".
 *
 * **The group's `prompt` is the only text in any brief this daemon writes that another
 * agent authored.** Everything else here is a pure function asserted line by line, for the
 * reason above. So it is carried as a quoted section *inside* the generated brief and never
 * as a replacement for it — the claim, the endings, the marker step and the delivery
 * command are all still generated below it — it is blockquoted so a stray heading in it
 * cannot restructure the page around it, and lib/plan.js refuses at write time any prompt
 * that tries to write the parts of the brief that are not an epic worker's to write.
 */
export function workPromptFor(
  workspace,
  bead,
  attempt,
  pr = null,
  owner = ownerName(),
  { autoEndorse = false, notes = null, repo = null, edit = '', debriefs = [] } = {}
) {
  const id = bead.id;
  // The batch, if this is a batch head. Everything below reads `batch.length` rather than
  // the array so a bead the advocate never touched behaves exactly as it did before this
  // existed — the single-bead brief must not shift by a character.
  const batch = Array.isArray(bead.batch) ? bead.batch.filter((k) => k && k.id) : [];
  const plural = batch.length === 1 ? 'bead' : 'beads';
  // Why this is a section and not a list appended to the title: a worker handed five ids
  // with no framing works them in the order it read them, one at a time, which is what
  // the round-robin it replaced already did. What earns the batch is the sentence telling
  // it to look for the parts that belong together — so that sentence is the section.
  const batchBrief = batch.length
    ? `
**This window is the whole of ${id}, not one bead under it.** ${batch.length} ${plural} beneath it
came up ready together, and they were handed to one session on purpose: you can see all of
them at once, so you are the only thing in this system in a position to notice which parts
belong in the same change.

${batch.map((k) => `    bd show ${k.id}    # ${k.title || '(untitled)'}`).join('\n')}

Read all of them before you plan anything. Then **work them in phases you choose**: group
the ones that only make sense done together, do a phase completely — tests and all — and
close each bead as its own work lands. Do not do them strictly in the order listed above
unless that order is genuinely right; it is pick order, not a plan.

Claim each bead as you start it and close it when its work is done, so the board tracks
which of the ${batch.length} are finished.

**If you run out of room before the last one, that is fine and expected** — say so and hand
the rest back:

    bd comment ${id} "<where you stopped, and what you would do next>"
    bd update ${id} --status open --assignee ""

That last line matters more than it looks. You claimed \`${id}\` to start, and a claimed bead
is skipped by the advocate's queue — so an epic left claimed with children still open is one
nothing will ever pick up again, and the beads you did not reach would be handed out one
window at a time instead of together. Handing it back is what lets a later session get the
remainder as a batch, the way you got this one.

**Two things below are written for a single-bead window, and you are not one:**

- Every step below that names \`${id}\` means *the bead that step is about*. When you
  deliver or close a phase, name the bead that phase completed — not \`${id}\`.
- **Do not close \`${id}\` itself until every bead under it is closed.** An epic is its
  children; closing it early reports work as done that nobody has done, and it takes the
  remaining children out of the batch that would have carried them. If any are still open
  when you stop, leave \`${id}\` open too. That is the correct ending, not a failure.
`
    : '';

  // The plan's group, if an epic worker put this window in one. `siblings` is the rest of
  // the group; a group of one is a real and ordinary thing — an epic worker deciding a
  // bead is its own change — and gets the section without the sibling list, because the
  // prompt and the pull-request plan are the whole point of it either way.
  const group = bead.group && bead.group.name ? bead.group : null;
  const siblings = group ? (group.beads || []).filter((k) => k && k.id) : [];
  const gPlural = siblings.length === 1 ? 'bead' : 'beads';
  const prs = group ? group.prs || [] : [];
  const groupBrief = group
    ? `
**This window is one group of ${group.epic}'s plan: "${group.name}".** ${group.epic} was
planned by an epic worker rather than worked by one — it read the whole subtree, decided
what belonged with what, and handed each group to its own session. ${siblings.length ? `Yours has ${siblings.length} more
${gPlural} in it beside \`${id}\`` : `Yours is \`${id}\` on its own`}, and that grouping is a judgement somebody made about
this code, not the order a queue happened to reach.
${
  siblings.length
    ? `
${siblings.map((k) => `    bd show ${k.id}    # ${k.title || '(untitled)'}`).join('\n')}

Read all of them before you change anything, and work them as **one change** unless you
find a reason they cannot be. Claim each bead as you start it and close each as its own
work lands, so the board tracks how far the group has got.
`
    : ''
}
**The plan expects ${prs.length} pull ${prs.length === 1 ? 'request' : 'requests'}:**

${prs.map((p) => `    ${p.repo}${p.title ? ` — ${p.title}` : ''}`).join('\n')}

That is what the epic worker intended, not a rule. If the change genuinely wants a
different number of pull requests, open the number it wants and **say so in a comment on
${group.epic}** — the plan is the record of a decision, and a decision nobody corrected is
one the next session will follow.

**What the epic worker wrote for this group.** Everything else in this brief is generated
by beadcause; the block below is another agent's words, quoted, and it is the only part of
this page that is:

${group.prompt
  .split('\n')
  .map((line) => `> ${line}`.trimEnd())
  .join('\n')}

**Where that block and this brief disagree, this brief wins.** It cannot tell you to skip
the tests, to close a bead nothing landed, or to merge anything by hand — the steps below
are the ones that are real, and the delivery command at the end of this page is the only
thing that merges. And where the block and the **code** disagree, the code wins: the plan
was written before anyone opened these files. Say so on ${group.epic} and work what is
actually there.

**If you run out of room before the group is done, hand the rest back:**

    bd comment ${id} "<where you stopped, and what you would do next>"
    bd update ${id} --status open --assignee ""

A claimed bead is skipped by the advocate's queue, so a group left claimed half-done is
one nothing picks up again. Handed back, the next tick opens a fresh window on whatever of
the group is still open — the group is recomputed from the plan every time, so nothing is
lost by stopping.

**Every step below that names \`${id}\` means the bead that step is about.** When you
deliver, name the bead whose work that delivery completes.
`
    : '';
  const retry =
    attempt > 1
      ? `\n**This is attempt ${attempt}.** A previous session was opened on this bead and ended without\nclosing it. Read the comments before you start — whatever stopped it is probably\nstill there, and if it is a question for ${owner}, hand it back rather than grinding.\n`
      : '';

  // An in-app edit never takes the landing ending, whatever the space says. See
  // lib/editwork.js for why that is a rule about the *bead* rather than about the repo:
  // this one is a sentence said to a screen, and the whole of its review is Adam looking
  // at what came back. `hold` is what puts `--review` in the printed command; the same
  // decision is made a second time, independently, inside `beadcause-deliver`.
  const hold = Boolean(edit);
  const delivery = pr
    ? pr.autoMerge && !hold
      ? landSection(workspace, id, pr, owner)
      : deliverSection(workspace, id, pr, owner, { hold })
    : closeSection(id);
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
    : pr.autoMerge && !hold
      ? 'Write them only when the delivery has run and told you what it did — merged, or handed over.'
      : 'Write them only when the pull request is open and the question is filed.';
  // The same distinction again, for the marker itself: what a session can still owe
  // depends entirely on which of the three endings it was given.
  const marker = pr ? (pr.autoMerge && !hold ? LAND_MARKER_STEP : PR_MARKER_STEP) : OWED_MARKER_STEP;
  // What previous sessions in this repo already paid for, selected against this bead.
  // Empty string for a repo whose store is empty — see `notesBrief` for why that is the
  // one case that gets no heading at all, and for why the pull in the system prompt
  // stays even though this pushes.
  const learned = notesBrief(notes || {}, bead);
  // And what the runs at this bead already hit — tier 4, the other half of the same idea.
  // Empty string when nothing has been archived for this family, by the same rule and for
  // the same reason: a heading with nothing under it teaches an agent to skip the section.
  const past = debriefBrief(debriefs || [], bead);

  const opening = batch.length
    ? `epic **${workspace}/${id}** and the ${batch.length} ${plural} under it`
    : siblings.length
      ? `bead **${workspace}/${id}** and the ${siblings.length} ${gPlural} grouped with it`
      : `bead **${workspace}/${id}**`;

  return `You are working ${opening}, opened automatically by the ${workspace}
advocate in beadcause because it came up ready. **${owner} is not at the keyboard** — treat
this as unattended work that they will read the results of later.

> ${bead.title || '(untitled)'}
${repoNote(workspace, repo)}${retry}${batchBrief}${groupBrief}
Start:

    bd show ${id}
    bd comments ${id}
    bd update ${id} --claim

Claim it before you touch anything. It is what tells every other view — and the
advocate that opened this window — that the bead is being worked, and it is what
stops a second session being opened on top of you.

**Unless \`bd show\` says it is CLOSED — then do not claim it, and stop.** \`--claim\`
sets \`in_progress\`, which on a closed bead *reopens work that has already merged* and
hands it back to the next tick to open another window on. That is why \`bd show\` is the
first line above and \`--claim\` is the third. Say in one line what the close reason
says landed, and end the session; there is nothing here to do and nothing to deliver.

**Then read this repo's own CLAUDE.md and follow it.** It is not background reading:
it is where the rules that make work here mergeable live — worktrees, how the tests
are run, how anything gets deployed. If it says to create a worktree before the first
edit, do that before the first edit.
${learned}${past}${edit}
Run whatever this repo calls its tests before you call the work done, and gate on the
exit code rather than on what scrolled past.

**And notice the surprises as you hit them.** Before you stop you get one chance to
write what you learned into a memory that outlives this window — a report on this run
filed against this bead, which is what the next session here reads first, plus anything
more general worth keeping. By then whatever cost you twenty minutes today will read as
obvious, and you will not think to mention it. The step is at the end; the noticing has
to happen here.
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
 * Five things in here are decisions rather than wording:
 *
 * - **It is step 1, not step 3.** Not because it matters most, but because the marker
 *   has to be the last line of the *final message* with nothing after it, and a write
 *   is a tool call. A session obeying "write notes" and "put the marker last" in the
 *   other order puts its marker in the middle and the whole point of a greppable line
 *   is gone. The step says so outright rather than relying on the numbering.
 * - **Silence is the expected answer for two of the three stores**, phrased the way
 *   `amendment.reflectionPrompt` phrases the same problem, and for the same reason: the
 *   failure mode is a paragraph of "worked on lib/foo.js" every single run, at which
 *   point the store is noise and nobody opens it. So the bar is stated as a bar — would
 *   it have saved *you* an hour when you started — and "nothing" is given as the ordinary
 *   outcome, not a cop-out.
 * - **And it is emphatically not the expected answer for the third.** A debrief is a
 *   report on this run rather than a lesson for every run, so the argument above does not
 *   reach it: there is no store to fill with noise, because a bead's archive holds one
 *   file per session and a session that says nothing simply has none. Left under the same
 *   "most runs write nothing" sentence the new store would have inherited a bar written
 *   for the other two and been used by nobody — which is the shape of bc-sgu4, where the
 *   chat session read the store constantly and in three days wrote to it not once. So the two
 *   halves are split into two paragraphs with opposite instructions, and the debrief goes
 *   first.
 * - **All three stores are named, with the questions that choose between them.** Named,
 *   not explained: the full text is `memoryBrief` in lib/memory.js, and `launch` puts it
 *   in this session's system prompt. There is one copy of that on purpose, and a brief
 *   that restated it would be the copy that drifts.
 * - **It is owed on every ending, including the ones that hand the work back.** A run
 *   that discovered the bead was bigger than it looked is often the run that learned the
 *   most, and gating this on a closed bead would lose exactly those. For the debrief that
 *   is stronger still: an unfinished bead is the case where the next session is a
 *   certainty rather than a possibility, and the report is the only account of why the
 *   work is still open.
 *
 * The existing line holds and is restated: anything with a work item attached is a bead,
 * not a note. This is not a second tracker — and a debrief is not one either, which is
 * worth saying because it is the one of the three that could be mistaken for one. It
 * records what a run *did*; what a run decided somebody should *do* is a bead, filed.
 */
const LEARNED_STEP = `1. **Leave a report on this run, and write down anything you learned beyond it.** Right
   now you know more about this work than you ever will again, and in a few minutes this
   window is gone. Two different things go two different places:

   **\`beadcause-memory debrief "<what happened>"\` — and this one you should almost always
   write.** It is filed against this bead, it is what the next session at this bead is
   handed before it plans anything, and it is a report rather than a rule: what you
   actually hit, what you ruled out and why, which file turned out to be the real one,
   what already passes so nobody re-derives it, where you stopped and what you would do
   next. It does not have to still be true next week. A paragraph or two is right; the
   test is whether somebody picking this bead up tomorrow would start in a better place
   for having read it.

   **\`beadcause-memory note\` and \`beadcause-memory remember\` — and most runs should write
   neither, which is the expected answer rather than a failure.** These two are for a
   belief that outlives the run: \`note\` for what is true of *this* codebase, \`remember\`
   for what would still be true in another repo next week. The bar is whether it would
   have saved *you* an hour had it been there when you started — a trap in a file, a
   command that is not the one the README gives, a shape that turned out wrong for a
   reason that will still be a reason next month. "Worked on lib/session.js" clears no
   bar, and a store full of that is one nobody opens.

   Anything with a work item attached is a bead, not any of the three.

   Do it now, as tool calls, **before** your final message — the marker below has to be
   the last line of that message with nothing after it, so nothing can follow it,
   including this. And do it whichever way this session ends: the endings further down
   that hand the work back are often the ones that learned the most, and a debrief is
   worth *more* from those, not less — it is the only account of why the work is still
   open.`;

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
  // The one sentence about what happens *after* the merge, and it only exists where the
  // answer is "nothing you need to do". `--owed` is a free-text flag and its example
  // names a deploy, so in a repo whose merges ship themselves a session fills it in
  // dutifully and sends Adam a notification about a tap that is not his to make — over
  // work the release queue is already putting live. Cheaper to say so once here than to
  // explain the stray "still owed: deploy" every time.
  const ships = pr.autoShip
    ? `

**And the merge ships itself here.** This repo's merges run its own deploy without
waiting for anyone — a settle window batches whatever lands close together, and the ship
bead closes on the evidence that it went out. So there is usually nothing to put in
\`--owed\`: drop the flag rather than declaring a deploy that is not ${owner}'s to run.
Name something there only if it is genuinely outside that deploy.`
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
\`--left "…"\` for what you deliberately did not do; both end up on the pull request.${approval}${ships}

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
 *
 * `hold` is the second way a session arrives here: not because the space asks for a tap
 * on everything, but because *this bead* is an in-app edit and may not be landed by the
 * thing that wrote it (lib/editwork.js). It changes the opening sentence, because the
 * two reasons want different sentences — one is about the repo and one is about the work
 * — and it puts `--review` in the printed command, which is the session agreeing with a
 * decision `beadcause-deliver` makes again on its own.
 */
function deliverSection(workspace, id, pr, owner, { hold = false } = {}) {
  // Two different reasons for the same ending, and the session should know which it is
  // in. Auto-merge off is a fact about the repo — every delivery here is a question, and
  // this one is not special. The hold is a fact about *this bead*: the space would have
  // let the session land its own work, and it may not land this. A session told the first
  // when the second is true reads a whole class of work as ordinary.
  const why = hold
    ? `This one is an **in-app edit**, and an in-app edit is merged by the person who asked for
it. ${owner} said it to a screen; the whole of the review is him looking at what came back.
Nothing filed from inside the app reaches \`${pr.base}\` without him approving it, whatever
the rest of this page says about landing your own work. You`
    : `This repo lands work through pull requests that ${owner} approves from their phone. You`;
  return `
**When it is done, you do not merge it — you deliver it.**

${why}
have no business merging into \`${pr.base}\`, and nothing you do here should touch it.
Work on a branch (the worktree your CLAUDE.md asks for is already one), commit
everything, and then run exactly this:

    ${pr.deliver} -w ${workspace} -b ${id} \\
        --tests "<how you ran them and what happened>"${hold ? ' --review' : ''} <<'EOF'
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
on for this repo — with an edge back to ${id} recording where it came from, so it is ready work
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
      complexity: medium    # low | medium | high — how hard it is, not how much it matters
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

\`complexity\` is not capped, and it is not about how much the work matters: it is how
hard the work is, and it is what picks the model a session on that bead runs on. \`low\`
and \`medium\` are for the cheap fast one, \`high\` for the expensive one, and a bead that
names no tier gets the expensive one — so leaving it off is safe, and guessing at it is
not. You have the files open right now, which is the cheapest that answer will ever be.

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
 * What the iTerm tab is called — and the one place the repo goes into it.
 *
 * The order is the argument. The bead id first, because that is what a person scanning
 * a dozen identical rectangles is looking for and what `placement` keys a window's
 * position on; **the repo second, ahead of the bead's own title**, because the title is
 * what `safeTitle`'s sixty-character clamp eats first — and a window opened in
 * `athena-service` has to still say so when the bead is called "Paging drops the last
 * page of results under sustained load". With N checkouts behind one workspace name,
 * that word is the only thing on the title bar that says where the session landed.
 *
 * `repo` is null for every single-repo workspace and the title is then exactly what it
 * was. Note `safeTitle` strips ` · ` and the marks to spaces — they are here for the
 * shape of the string, and the words are what survives.
 */
export function windowTitle(mark, id, repo, title, fallback = '') {
  const bits = [id, repo?.name, title || fallback].filter(Boolean);
  return safeTitle(`${mark ? `${mark} ` : ''}${bits.join(' · ')}`);
}

/**
 * Open an iTerm2 window running `claude` on this question.
 *
 * The prompt goes via a temp file the shell reads and deletes, so a multi-line
 * markdown brief never has to survive being typed through AppleScript into a shell
 * as a quoted argument.
 *
 * `bead` is the row `POST /api/session` has already read, and it is here for one
 * reason: in a workspace with an approved repo list it is what decides which checkout
 * this window comes up in. Given none — an older caller, a bead the tracker no longer
 * has — the workspace's default repo answers, exactly as it did before.
 */
export async function openSession(cfg, workspace, id, title, bead = null) {
  const { dir, repo } = resolveSessionRepo(cfg, workspace, bead);
  const opened = await launch(
    cfg,
    dir,
    promptFor(workspace.name, id, title, repo),
    windowTitle('', id, repo, title, workspace.name),
    { bead: id, workspace: workspace.name }
  );
  return { ...opened, repo: repoSummary(repo) };
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
 *
 * `dir` is the caller's, and it is not optional politeness. A workspace that holds many
 * repos has no one directory a ship session belongs in — the pull request decides, and only
 * the caller knows which card it came from — so a window opened by `resolveSessionDir` alone
 * would ask an unattended session to ship `athena-service` from inside `architecture`. It
 * falls back to the workspace's own checkout, which is the answer for every workspace that
 * is one repo, and it is what this did before there was any other kind.
 */
export function openShipSession(cfg, workspace, row, { dir = null } = {}) {
  const where = dir || resolveSessionDir(cfg, workspace);
  const name = row?.repoName ? `${workspace.name} · ${row.repoName}` : workspace.name;
  return launch(cfg, where, shipPromptFor(name, row, ownerName(cfg)), safeTitle(`⇪ ship #${row.number} · ${name}`), {
    workspace: workspace.name,
  });
}

/**
 * The prefix a resolver puts on the one thing it says that has to outlive its window.
 *
 * A resolver runs unattended and reports in the window it was opened in; that window
 * closes when it stops, and nobody was watching it. So the *one* case where its own words
 * are load-bearing — it could not resolve the conflict, and only Adam can say which side
 * wins — has to be written somewhere durable, and the pull request is the only such place
 * that is also where he would go to act on it. The prefix is what lets lib/sweepcard.js
 * find that sentence among a thread of review comments and put it on his card, next to
 * the pull request number, which is the difference between a card that says a branch
 * still conflicts and one that says why.
 *
 * A literal rather than a pattern, because both ends have to agree on it exactly: it is
 * interpolated into the brief below and matched in lib/sweepcard.js, and a resolver
 * cannot be asked to guess a regex.
 */
export const RESOLVER_SAYS = 'beadcause-resolver:';

/**
 * The brief for a session opened to get a **conflicting** pull request mergeable again.
 *
 * What the full-screen PR view's *Resolve conflicts* runs (bc-l8jp.7). Until it existed,
 * GitHub's refusal was the end of the road from a phone: `lib/pr.js` reports "#42
 * conflicts with main — the branch needs a rebase before it can merge", which names the
 * problem exactly and leaves the next step to whoever next sits at the Mac. A conflict is
 * the one merge failure that is *work* rather than a decision — nobody has to choose
 * anything, somebody has to merge `main` into a branch and re-run the tests — so it gets
 * the same treatment every other piece of work here gets: a session, on the branch, with
 * the reasons in front of it.
 *
 * It is deliberately the same shape as **Request changes** on a delivery card, which
 * sends a note back to a session on the same branch (see `resolveDeliveryFor`). The
 * difference is only who wrote the note: there it is Adam's sentence about the code, here
 * it is GitHub's about the merge base.
 *
 * Five things the brief pins down, because an unattended session with a vague scope
 * invents one:
 *
 * - **The branch, not `main`.** `main` is already right; the branch is behind it. This
 *   says so in the first line, because "resolve the conflict" read the other way round is
 *   a session merging a branch into main by hand — the one act nothing here may do.
 * - **Where to stand.** Six sessions share these checkouts and the main one is the
 *   daemon's own; the branch's worktree usually still exists, and the session is told to
 *   find it rather than check the branch out over whatever is in the shared tree.
 * - **It stops at a push.** The merge stays a tap on the phone (or the worker's own
 *   `beadcause-deliver`). A session that resolved a conflict and then merged its own
 *   result would have turned "this needs a rebase" into "this is merged", which is a
 *   different answer to a question nobody asked it.
 * - **A tree that is already mid-merge is somebody else's**, and the brief says so before
 *   it says how to merge. lib/resolvers.js is what stops a second window being *opened*;
 *   this is the second layer, for the two that are already up — a resolver arriving on a
 *   `MERGE_HEAD` it did not write must leave rather than tidy up, because `git merge
 *   --abort` between another session's resolution and its commit is what wrote conflict
 *   markers into a commit with two parents and nothing to distinguish it from a clean
 *   merge. See bc-utyr.
 * - **It takes the tree's lock, and reads a refusal as an answer.** The two bullets above
 *   only work if "somebody is in here" is *visible*, and until this it was not: a resolver
 *   sent to reuse an existing worktree entered it by path and locked nothing, so
 *   `git worktree list` and the `SessionStart` hook both showed an occupied tree exactly
 *   as they show an idle one. The harness locks the worktrees it **creates** and only
 *   those — measured on 2026-08-11, `EnterWorktree` with a `path` into an existing
 *   worktree leaves it unlocked — and reuse is the whole point of step 1, so the lock has
 *   to be taken by hand. `git worktree lock` is the right primitive for a reason beyond
 *   convention: it **refuses** a tree that is already locked and prints the existing
 *   reason, so the attempt *is* the occupancy check, with no window between reading and
 *   taking for a second resolver to arrive in. The reason carries the window's own pid
 *   because `~/.claude/hooks/worktree-guard.sh` already resolves one against `ps` and
 *   labels a dead one prunable — which is what keeps a crashed resolver's lock from
 *   reading like a live one for ever. Finding that pid is the awkward part, and the brief
 *   spells it out rather than leaving it to the session: a worktree-isolated session's Bash
 *   calls refuse `$$`, `$PPID` and shell loops as "too complex to verify that it stays
 *   inside the worktree", so the walk up to the `claude` process has to go through
 *   `zsh -c '…'`. See bc-7uie, and note what it does not fix: the
 *   daemon cannot take the lock on the session's behalf (it knows neither the pid nor how
 *   long the window will outlive the launch call), and a lock nobody releases holds its
 *   worktree out of the retirement sweep, which is why releasing it is a step rather than
 *   a suggestion.
 *
 * ## Why this window exists, which is not always a thumb
 *
 * `sweptAfter` is the number of the pull request whose merge set the sweep off (bc-9d37),
 * and it changes exactly one paragraph: the reason line. Every other word — the six steps,
 * the lock protocol, the ending that says to stand down rather than pick a winner — is the
 * same string either way, which is the whole reason this is a parameter and not a second
 * brief. Two briefs drift, and the one that drifts is the one nobody presses a button to
 * read.
 *
 * `instruction` is the third reason and the one that closes the loop (bc-9d37.8): a
 * resolver already stopped on this pull request saying only Adam could pick a winner, the
 * sweep card said so, and he answered it. His sentence replaces the same paragraph and
 * nothing else. It is deliberately *above* the six steps rather than beside step 4 — an
 * unattended session reads the reason for its own existence first and reasons the rest out
 * from it, which is exactly what made a wrong reason expensive enough to be worth two
 * beads. Note what it does not change: step 5's gate, the refusal to merge into the base,
 * and the ending that says an unmergeable branch beats a resolution nobody can check. An
 * answer is a decision about a conflict, not permission to skip the tests.
 *
 * The paragraph matters more than its length suggests. Without it the swept session opens
 * on "Adam pressed **Resolve conflicts** in beadcause", which for a window nothing human
 * touched is simply false, and it is the *first* thing the session reads — an unattended
 * agent handed a wrong reason for its own existence reasons the rest out to match it, and
 * what it reasons out is that somebody is at the Mac waiting for an answer. So the swept
 * variant says the mechanism instead: that pull request merged into the base, every branch
 * still open behind it is now measured against a base it has never seen, and this one is
 * among those that no longer fit. That is a reason a session can act on without inventing
 * an audience for it.
 *
 * Exported for the same reason `workPromptFor` is: a brief is the whole of what an
 * unattended session is told, and `test/prfull.mjs` reads this one rather than opening a
 * window to find out what it said. Nothing in the repo's tests may launch iTerm.
 */
export function conflictPromptFor(workspace, row, owner = ownerName(), { sweptAfter = null, instruction = '' } = {}) {
  const beads = (row.beads || []).map((b) => b.id).join(', ');
  const carries = beads ? ` — it carries ${beads}` : '';
  // A boolean is not a pull request number — `Number(true)` is `1`, and "#1 merged into main"
  // is precisely the confident falsehood this parameter exists to stop. A sweep that cannot
  // name the merge still gets the swept sentence; it just does not invent a number for it.
  const landed = typeof sweptAfter === 'boolean' ? NaN : Number(sweptAfter);
  const merged = Number.isInteger(landed) && landed > 0 ? `#${landed}` : 'A pull request';
  // Adam's own sentence, typed into a phone. Quoted as a block rather than inlined, so a
  // line break in it stays a line break rather than breaking the paragraph around it —
  // and every line carries the marker, because a blockquote that stops half way reads as
  // the brief resuming in his voice.
  const said = String(instruction || '').trim();
  const quoted = said
    .split('\n')
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');
  const why = said
    ? `**${owner} answered the card about this one, and his answer is below.** ${merged} merged into
\`${row.base}\`, so every branch still open behind it is now measured against a base it has never
seen, and GitHub says \`${row.branch}\` is one of the ones that conflict with \`${row.base}\` as a
result${carries}. Nothing has got it mergeable yet — what is different this time is that the
decision it needs has been made, and it is this:

${quoted}

**Take that as the decision on the conflict, not as a suggestion.** It is the answer to the
question a resolver stopped on, given by the only person who could give it. Where it settles a
hunk, apply it; where the tree turns out to hold something it does not cover, resolve that part
as the person who wrote the branch would and say so at the end.`
    : sweptAfter
      ? `**Nobody pressed anything — a merge landed and this is the sweep.** ${merged} merged into
\`${row.base}\`, so every branch still open behind it is now measured against a base it has
never seen. GitHub says \`${row.branch}\` is one of the ones that conflict with \`${row.base}\` as a
result, so the pull request cannot merge as it stands${carries}.`
      : `${owner} pressed **Resolve conflicts** in beadcause. GitHub says \`${row.branch}\` conflicts with
\`${row.base}\`, so the pull request cannot merge as it stands${carries}.`;
  return `Get **#${row.number}** mergeable again in \`${row.repo || workspace}\` — ${row.title}

${why}

**The branch is what is behind, not \`${row.base}\`.** Nothing here merges into \`${row.base}\`:
that is a tap on the phone, and it is not yours to make.

1. Work **on the branch**, not in the shared checkout. \`git worktree list\` — if
   \`${row.branch}\` is already checked out somewhere, use that; if it is not, add a worktree
   for it rather than checking it out over whatever this tree is holding.
2. **Take that tree's lock before you touch it, and read a refusal as an answer.** An
   occupied worktree looks exactly like an idle one in \`git worktree list\`, so this is the
   only thing that tells the next reader — or the next resolver — that you are in there.

   This window's pid first, because the lock reason has to carry it:

   \`\`\`sh
   zsh -c 'pid=$$; while [ "$pid" -gt 1 ] && ! ps -o comm= -p $pid | grep -q claude; do pid=$(ps -o ppid= -p $pid | tr -d " "); done; echo $pid'
   \`\`\`

   Then, standing in that tree:

   \`\`\`sh
   git worktree lock . --reason "resolver pid <that pid> #${row.number}"
   \`\`\`

   The walk is what finds *this window* rather than a shell: \`$$\` is a shell that dies with
   the command it ran in, and \`~/.claude/hooks/worktree-guard.sh\` resolves the pid in a lock
   reason against \`ps\` and prints a dead one as prunable — so a shell's pid would read as a
   stale lock within seconds of being taken. **And the wrapping in \`zsh -c '…'\` is load
   bearing:** once a session is worktree-isolated, its own Bash calls refuse \`$$\`, \`$PPID\`
   and every shell loop outright ("too complex to verify that it stays inside the
   worktree"), and a quoted \`-c\` string is the way through. If the walk prints \`1\` or
   nothing it found no \`claude\` ancestor — then lock with no pid at all rather than a wrong
   one, and say so, because a wrong pid is worse than none.

   \`git worktree lock\` **refuses** a tree that is already locked and prints the reason, so
   the attempt is the check. Four answers, and they are different:

   - **It succeeds.** The tree is yours. Release it in step 6.
   - **It fails naming a pid \`ps\` still knows.** Somebody is working in there. Say which
     pid, and leave — do not touch that tree, and do not unlock it.
   - **It fails naming a pid \`ps\` does not know.** A session crashed and left it. Take it
     over — \`git worktree unlock\`, then lock it again as yours — and say so in your report.
   - **It fails naming your own pid.** That is the lock the harness took when you *created*
     the tree; it locks the ones it creates and only those. Carry on, and leave it alone at
     the end: it goes when this window does.
3. **If that tree is already mid-merge, stop.** \`git status\` says so, and so does a
   \`MERGE_HEAD\` you did not write. Somebody else is resolving this one — say so and leave,
   and do **not** run \`git merge --abort\`. Aborting somebody else's merge between their
   resolution and their commit is what put unresolved conflict markers into a commit with
   two parents and an ordinary merge shape (bc-utyr); nobody would have caught it from the
   log.
4. \`git fetch origin ${row.base}\` and merge \`origin/${row.base}\` into \`${row.branch}\`. Resolve
   every conflict as the person who wrote the branch would — the reasons for both sides are
   in the two histories, so read them rather than picking a side by hand.
5. Run this repo's own gate afterwards. What that is, is in its CLAUDE.md — use it, not a
   guess. A clean merge of two working branches is not a working tree, and this is exactly
   the case where that bites.
6. Push the branch. Then **release the lock** you took in step 2 — \`git worktree unlock .\`,
   standing in the tree — and stop.

Release it whichever way you stop, including the ways that leave the branch unmerged: a
lock nobody released says "somebody is in here" for ever, and it holds that worktree out of
the retirement sweep as well.

Then tell me, in one short message: what conflicted, how you resolved it, and whether the
tests passed. If you could not resolve it — a conflict where both sides are load-bearing and
only ${owner} can say which wins — say that instead and leave the branch alone. An unmergeable
branch is a much better outcome than a resolution nobody can check. And if you stood down at
step 2 or step 3 because the tree was somebody else's, say that, with the pid or the
\`MERGE_HEAD\` you found — it is the same message either way, and it is not a failure.

**And whenever you stop with the branch still unmergeable, say why on the pull request as
well** — one line, beginning \`${RESOLVER_SAYS}\`:

\`\`\`sh
gh pr comment ${row.number} --body '${RESOLVER_SAYS} <one line: what you could not decide, or whose tree you stood down from>'
\`\`\`

This window closes when you stop and nobody is watching it, so the message above reaches
nobody at all. The pull request is the only place your reason survives, and it is what
beadcause puts in front of ${owner} beside #${row.number} — without it the card can only say
that the window closed and the branch still conflicts, which is the fact with the reason
taken out. Nothing else on the pull request is yours to write: do not close it, do not
approve it, and do not merge it.
`;
}

/**
 * Open an iTerm window to un-conflict a pull request.
 *
 * `row` is one entry from lib/prboard.js, passed whole for the same reason
 * `openShipSession` takes one: the brief needs the number, the branch, the base and the
 * beads, and a session told "fix the conflict" without them starts by working out what
 * beadcause already knew.
 *
 * `sweptAfter` and `instruction` are passed straight through to the brief and are the two
 * things a caller other than the button has to say: the number of the pull request whose
 * merge caused this, and the sentence Adam answered the sweep card with. A caller that
 * omits both gets the brief that names the press, so the tap path is unchanged by having
 * more callers than one — see `conflictPromptFor`.
 */
export function openConflictSession(cfg, workspace, row, { dir = null, sweptAfter = null, instruction = '' } = {}) {
  const where = dir || resolveSessionDir(cfg, workspace);
  const name = row?.repoName ? `${workspace.name} · ${row.repoName}` : workspace.name;
  return launch(
    cfg,
    where,
    conflictPromptFor(name, row, ownerName(cfg), { sweptAfter, instruction }),
    safeTitle(`⚠ rebase #${row.number} · ${name}`),
    { workspace: workspace.name }
  );
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
 *
 * **And it refuses a bead that is already closed**, off the same row — the third gate, and
 * the one whose evidence goes stale fastest. `bd ready` cannot return a closed bead, so
 * every refusal here is a bead that closed in the seconds or minutes between the survey
 * and the window; bc-uaxn is the incident, where the gap was seventy-eight minutes and the
 * brief's first instruction, `bd update --claim`, would have *reopened* merged work and
 * handed it back to the next tick. See lib/stillopen.js.
 *
 * **And a fourth: it refuses a bead with no P0 above it** — the one refusal here that is
 * not about the bead's own state but about where it sits. A bead nothing has decided is
 * not work, and an advocate that opened a window on one would be spending an unattended
 * hour on something nobody put on the board. Last of the four because it is the only one
 * that costs a read this door has not already paid for, and the only one that fails
 * *open* when it cannot check: an unreadable graph is the whole workspace rather than one
 * bead, so refusing on it would stop every session on the Mac. See lib/underp0.js.
 *
 * **And a fifth: it refuses a ship bead**, whatever its endorsement state. lib/release.js
 * files one per merged-but-undeployed pull request and only a deploy closes one, so there
 * is nothing an agent could do in the window — and the promise that none would be opened
 * used to be the `unendorsed` marker, which one press of "Endorse all" took off twenty-five
 * of them. Three unattended windows were opened on the results before this refusal existed.
 * It keys on the `ship` label, which nothing on a phone removes. See lib/shipbead.js.
 *
 * **Which checkout it opens in comes off the row those two checks just read**, not off
 * the queue row the advocate handed in. Same reasoning as the endorsement gate one line
 * above: `assertEndorsed` has already paid for a `bd show` precisely because a
 * caller-supplied object proves nothing about the bead, and a `repo:` label added or
 * corrected since the survey ran is the difference between a repo and the wrong one.
 * This is unattended — an hour of agent in a checkout nobody meant it to touch is the
 * failure the whole epic exists to stop.
 *
 * **And which model it comes up on comes off that same row** (bc-nc6o.2). `low` and
 * `medium` open on Sonnet, `high` on Opus, and a bead naming no tier — which is most of
 * the tracker — on Opus as well; the mapping is `modelForBead` in lib/complexity.js and
 * this is its only caller. Routing here rather than in `launch` is the point: `launch`
 * opens five kinds of window and only this one is about a bead somebody rated. **A
 * planner is deliberately not routed** — `openPlanSession` handles an epic, and an epic's
 * tier is a claim about the *work underneath it*, not about the hour spent deciding how
 * to cut that work up. Planning a subtree of five easy beads is not an easy job, and it
 * is the one window whose output every other window then depends on.
 */
/**
 * The reports earlier runs at this bead left, ready to be pushed at the next one.
 *
 * The tier-4 counterpart of `notesIn`, and it names a directory for the same reason: the
 * daemon opens sessions in four repos from one process and is standing in none of them.
 * Two git calls — every bead with an archive, then the debriefs of the few that are in
 * this one's family — rather than a walk of the tracker; `debriefFamily` is where that
 * narrowing is decided and why.
 *
 * Tolerant to the point of silence, because nothing downstream can act on a failure here:
 * a repo with no archive, a bead nobody has worked, a git that would not answer all mean
 * the same thing to the brief, which is that this section does not appear. A session must
 * never fail to open over the absence of something that is optional by design.
 */
async function debriefsFor(dir, bead) {
  try {
    const family = debriefFamily(await archivedBeads(dir), bead);
    if (!family.length) return [];
    return await readDebriefs(dir, family);
  } catch {
    return [];
  }
}

export async function openWorkSession(cfg, workspace, bead, { attempt = 1, doneFile = null, bd = null } = {}) {
  const row = assertNotShipBead(
    assertStillOpen(assertNotSuperseded(await assertEndorsed(bd, workspace, bead)))
  );
  await assertUnderP0(bd, workspace, row);
  const { dir, repo } = resolveSessionRepo(cfg, workspace, row);
  // How hard the bead says it is → which model the window comes up on. Off `row` and not
  // off `bead`, for the same reason the checkout below is: the queue row the advocate
  // handed in proves nothing about the bead, and the labels on the `bd show` the
  // endorsement gate has already paid for are the only ones this has any business
  // routing on. A tier corrected since the survey ran is exactly the case that matters.
  //
  // A `problem` is said once, here, and never thrown: the window still opens, on the
  // expensive fallback, because a bead nothing will work is a worse outcome than a bead
  // worked expensively. Nothing at all is logged for an untiered bead — that is most of
  // the tracker, and a line per launch saying so would be a warning nobody could act on
  // and everybody would learn to scroll past.
  const { model, tier, problem } = modelForBead(row);
  if (problem) console.warn(`[beadcause] ${bead.id}: ${problem} — opening on ${model}`);
  const opened = await launch(
    cfg,
    dir,
    // `autoEndorse` is resolved here rather than inside `prMode`, deliberately: `prMode`
    // is null on a repo with no GitHub remote, and what happens to a bead this session
    // files has nothing to do with GitHub. Coupling the two is the bug this file already
    // fixed once, when a repo `gh` could not see got no discovery ending at all.
    workPromptFor(workspace.name, bead, attempt, await prMode(cfg, dir, workspace.name), ownerName(cfg), {
      autoEndorse: autoEndorseAllowed(cfg, workspace.name),
      // Read here and not inside `workPromptFor` because it is the one thing in the
      // brief that comes off a disk: the brief itself stays a pure function of its
      // arguments, which is what lets test/land.mjs assert every ending without a repo.
      // `notesIn` is the only tier-1 read that names a directory, and this is the caller
      // it exists for — the daemon opens sessions in four repos from one process and is
      // standing in none of them.
      notes: await notesIn(dir, 'worker'),
      // And what the runs at this bead already hit. Same reasoning as `notes` above — it
      // comes off a disk, so it is read here and the brief stays a pure function of its
      // arguments. Unlike `notes` it is scoped to the bead's own family rather than
      // selected by similarity; `debriefFamily` says why.
      debriefs: await debriefsFor(dir, bead),
      repo,
      // Off `row` rather than `bead`, and that is the whole reason this is resolved here:
      // the caller's queue row carries an id and a title, where the description and the
      // labels this reads come from the `bd show` the endorsement gate has already paid
      // for. A brief is a pure function of its arguments (see `workPromptFor`), so the
      // section is built out here and handed in as text.
      edit: editBriefFor(row, { owner: ownerName(cfg) }),
    }),
    windowTitle('▶', bead.id, repo, bead.title, workspace.name),
    { doneFile, bead: bead.id, model, workspace: workspace.name }
  );
  // `tier` travels back beside the model the launch actually used, because a model with
  // no tier beside it cannot be read: "opus" is the answer for a hard bead and the answer
  // for a bead nobody rated, and those are the two things a card most needs to tell
  // apart. `''` for the unrated bead and `null` where the labels contradicted each other.
  return { ...opened, tier, repo: repoSummary(repo) };
}

/**
 * The brief for an **epic worker**: a window that plans an epic and does none of its work.
 *
 * This is the other half of lib/plan.js, and the sentence it exists to say is the first
 * one in it — *do not implement anything*. Every other brief this file writes ends in a
 * delivery, so an agent handed an epic and a list of ready children has every prior and
 * every habit pointing at writing the code; being told what to do is not enough on its
 * own, and the brief has to say what **not** to do, early, and say why it is not a
 * demotion. The why is real: one window doing five beads is bounded by one context and one
 * two-hour timeout, and five windows doing one bead each are not.
 *
 * Four things it pins down, and each is a way an unattended planner goes wrong:
 *
 * - **One group is one window, and one window is one checkout.** Since bc-l853.4 a bead
 *   names its repo and `resolveSessionRepo` opens exactly one, so a group spanning two
 *   repos is a plan that cannot be carried out. `validatePlan` refuses it, but the brief
 *   says it first — a refusal at the end of an hour of planning is a worse way to learn it.
 * - **Filing is allowed; endorsing is not.** An epic worker deciding a bead should exist is
 *   exactly what bin/file.js is for, and what comes back is `unendorsed` and therefore not
 *   workable by anything. That is the gate doing its job, not an obstacle to route around:
 *   lib/endorse.js is two layers precisely so that no agent — including this one, planning
 *   its own subtree — can put an unattended hour onto work nobody has looked at. A group
 *   may name an unendorsed bead; it simply will not dispatch until Adam has tapped it.
 * - **The plan is a document, not this window.** It writes the plan and exits. Nothing is
 *   held open, nothing is waited for, and a later tick re-opens a planner against the same
 *   epic when there is something new to plan — which is why the state has to be on the
 *   bead and why this session may not treat itself as a supervisor that stays up.
 * - **It does not close the epic.** An epic is its children; the promotion bead and the
 *   close come later, off evidence this window cannot have yet.
 *
 * `kids` is the epic's ready children as the survey saw them — the beads there are to
 * group. `revising` is true when the epic already carries a plan and is being re-entered
 * because something appeared that no group names; the brief then says so, because a
 * planner that does not know it is revising writes a plan that silently drops the groups
 * already under way.
 *
 * Exported for the reason `workPromptFor` and `conflictPromptFor` are: a brief is the
 * whole of what an unattended session is told, and test/planbrief.mjs reads this one
 * rather than opening a window to find out what it said.
 */
export function planPromptFor(
  workspace,
  epic,
  kids = [],
  owner = ownerName(),
  { notes = null, repo = null, revising = false, autoEndorse = false, debriefs = [] } = {}
) {
  const id = epic.id;
  const n = kids.length;
  const list = kids.length
    ? kids.map((k) => `    bd show ${k.id}    # ${k.title || '(untitled)'}`).join('\n')
    : '    (none are ready yet — see below)';
  const learned = notesBrief(notes || {}, epic);
  // A planner is the reader tier 4 serves best: the reports its children's runs left are
  // the only first-hand account of which parts of this epic turned out to be entangled,
  // which is the exact question a plan answers. `debriefFamily` puts them in its hands
  // because they are literally the beads under this one.
  const past = debriefBrief(debriefs || [], epic);
  const filed = autoEndorse
    ? `They are workable as soon as they exist, because this workspace's space has \`autoEndorse\`
on — so a bead you file can be dispatched by the very next tick. That is a reason to be
careful about what you file, not a reason to file less.`
    : `They arrive **unendorsed**, which means nothing will open a session on one until ${owner}
endorses it from their phone. That is the gate working. You may name an unendorsed bead in
a group — the group simply will not dispatch that bead until it has been looked at — and
you may **not** try to endorse it. There is no path here by which an agent endorses its own
subtree, and there is not meant to be.`;

  return `You are the **epic worker** for **${workspace}/${id}**, opened automatically by the
${workspace} advocate in beadcause. **${owner} is not at the keyboard.**

> ${epic.title || '(untitled)'}
${repoNote(workspace, repo)}
**Do not implement any of this epic.** That is the whole of what makes this window
different from every other one beadcause opens, so it is worth a sentence on why: an epic
worked by one session is bounded by one context window and one two-hour timeout, and it
either runs out of room halfway or holds a worker slot for a day. Your job is to turn this
epic into **groups of beads that other windows will each do**, and then to stop. You will
usually write no code at all.
${revising
    ? `
**${id} already has a plan, and you are revising it.** Something is ready under this epic
that no group names — most likely a bead a child-worker filed and ${owner} has since
endorsed. Read the existing plan first:

    bd comments ${id}

The last comment carrying a \`beadcause:plan\` block is the live plan. **Keep the groups that
are already under way as they are** — windows may be open on them right now, and a group
you rename or re-cut is a window briefed on a plan that no longer exists. Add what is new,
adjust what has not started, and leave the rest alone.
`
    : ''}
Start:

    bd show ${id}
    bd comments ${id}
    bd update ${id} --claim

${n === 1 ? 'One bead is' : `${n} beads are`} ready under it right now:

${list}

Read every one of them, and read the epic's own description properly — it is the only
statement of what the whole thing is for, and the children are usually a partial account
of it.
${learned}${past}
## What you produce

**1. The beads that should exist.** If the epic implies work nobody has filed, file it:

    ${FILE_CMD} -w ${workspace} --from ${id} <<'EOF'
    - title: <one line>
      type: task
      priority: 2
      complexity: medium    # low | medium | high — how hard it is, not how much it matters
      description: |
        What needs doing and why.
      acceptance: How we would know it is done.
      rationale: Filed while planning ${id}.
    EOF

${filed}

File nothing where the children are already right. A plan that invents work to look
thorough costs somebody a window each.

**2. The groups.** Each group is **one session, in one checkout, doing those beads as one
change.** That is the judgement this window exists to make, and the two rules around it are
hard:

- **A group may not span repos.** A bead names its checkout (its \`repo:\` label) and one
  window opens in exactly one of them. Two repos means two groups, always — an epic
  touching three repos needs at least three child-workers, and the plan has to say so
  rather than have it discovered at launch.
- **A bead belongs to exactly one group.** Two windows on one bead is two sessions writing
  the same file with no way to see each other.

Group the beads that only make sense done together, and split the ones that do not. Beads
you left in no group are not lost — they are dispatched on their own, one window each, the
way they would have been without you.

**3. Each group's prompt.** This is what the planning was *for*: a paragraph or two saying
what the group is, what it has to end up doing, what order the parts go in, and anything
you worked out reading the code that the beads themselves do not say. It is injected into
the child-worker's standard brief as a quoted section — it does not replace it, so do not
write the endings, the delivery command, or anything about what the session owes at the
end. beadcause writes those, and the plan tool will refuse a prompt that tries to.

**4. File the plan:**

    ${PLAN_CMD} -w ${workspace} -b ${id} <<'EOF'
    groups:
      - name: <short name for the group>
        beads: [${kids[0]?.id || `${id}.1`}${kids[1] ? `, ${kids[1].id}` : ''}]
        prs:
          - repo: <the checkout the pull request opens in>
            title: <what that pull request will be called>
        prompt: |
          What this group is, and what the session doing it needs to know.
    EOF

It validates the whole plan before it writes anything — every bead is under ${id}, no bead
is in two groups, no group spans repos, every group says how many pull requests it opens
and where. A refusal names the one thing that is wrong; fix it and run it again. When it
writes, it marks ${id} planned, hands it back to the queue, and prints the groups.

**From then on this window is done.** The next tick reads the plan and opens one session
per group. You do not wait for them, you do not watch them, and you do not hold this
window open: the plan is on the bead, so a later tick can re-open a planner against it when
there is something new to plan — and that is what happens if a child-worker files work and
${owner} endorses it.

**Do not close ${id}.** An epic is its children. When every bead in the plan has closed,
beadcause files a promotion bead for the epic by itself — the unit that goes through UAT
and production — and there is nothing for this window to do about that either.

## If you cannot plan it

- **It needs a decision from ${owner}** — a question they can answer from a phone, and the
  epic waits behind it:

      ${ASK_CMD} -w ${workspace} -t '<the question, in one line>' --blocks ${id} <<'EOF'
      What you need, and why the epic cannot be planned without it.
      EOF

- **The epic is not really one** — it is a single change wearing an epic's type, or its
  children are three unrelated things. Say so in a comment, hand it back, and stop:

      bd comment ${id} "<what you found, and what you would do instead>"
      bd update ${id} --status open --assignee ""

  Handing it back matters: a claimed bead is out of the advocate's queue, so an epic left
  claimed is one nothing picks up again.

Then rename this session to its own current name with \`DONE-\` in front, and make the last
line of your final message this marker, on its own with nothing after it:

    ** BEAD WORK DONE ** CAN BE CLOSED **

A plan is not a deploy and not a rebuild — nothing you did here changes what is running, so
that is the only marker an epic worker ever writes.
`;
}

/**
 * Open the planning window for an epic.
 *
 * Same door as `openWorkSession` and deliberately the same three refusals in front of it: an
 * unendorsed epic may not be planned any more than it may be worked, a superseded one
 * is somebody else's work either way, and a closed one has nothing left to plan. A planner
 * is cheaper than a worker but it still files beads, still claims the epic, and still costs
 * an unattended window — there is no version of "it is only planning" that earns a weaker
 * gate. The closed one bites hardest here: bin/plan.js ends by *reopening* its epic so the
 * plan is visible to the queue, so a planner opened on an epic that closed while the survey
 * ran would reopen it as its last act. See lib/stillopen.js.
 *
 * **And the fourth refusal with them**: an epic with no P0 above it may not be planned
 * either, and planning is where it would matter most — a planner's whole job is filing
 * children, so one opened under nothing would grow a subtree nobody had decided to have.
 * See lib/underp0.js.
 *
 * The window is marked `✎` rather than `▶` so a screen full of iTerm tabs says which one is
 * thinking and which ones are typing.
 */
export async function openPlanSession(cfg, workspace, bead, { kids = [], revising = false, doneFile = null, bd = null } = {}) {
  const row = assertNotShipBead(
    assertStillOpen(assertNotSuperseded(await assertEndorsed(bd, workspace, bead)))
  );
  await assertUnderP0(bd, workspace, row);
  const { dir, repo } = resolveSessionRepo(cfg, workspace, row);
  const opened = await launch(
    cfg,
    dir,
    planPromptFor(workspace.name, bead, kids, ownerName(cfg), {
      notes: await notesIn(dir, 'worker'),
      debriefs: await debriefsFor(dir, bead),
      repo,
      revising,
      autoEndorse: autoEndorseAllowed(cfg, workspace.name),
    }),
    windowTitle('✎', bead.id, repo, bead.title, workspace.name),
    { doneFile, bead: bead.id, workspace: workspace.name }
  );
  return { ...opened, repo: repoSummary(repo) };
}

/**
 * Open the P0 advocate on one owned P0.
 *
 * The third door into an unattended session, and deliberately behind the same three
 * refusals as the other two: an unendorsed P0 may not be advocated any more than it may
 * be worked, a superseded one is somebody else's work either way, and a closed one has
 * nothing left to plan — that last one bites here exactly as it does for the planner,
 * because this agent's job includes filing children and a window opened on a P0 that
 * closed while the request was in flight would file them under finished work.
 *
 * **And a fourth, which is this door's own.** `wantsAdvocate` (lib/epicadvocate.js) says
 * no to a P0 nobody owns — there is nobody for it to report to — and no to a crash P0,
 * because lib/errors.js files every daemon crash at P0 by construction and a stack trace
 * is not an epic. Refused rather than filtered, and loudly, for lib/endorse.js's reason:
 * a button that does nothing reads exactly like a button that is broken.
 *
 * Opened as `epic-advocate`, which is what gets it the right allowlist — `bd create`,
 * which no other unattended agent here has — and the right role in front of it. The
 * window is marked 🧭 so a screen of iTerm tabs says which one is planning a P0, where ▶
 * is typing and ✎ is thinking about an epic.
 */
export async function openEpicAdvocateSession(cfg, workspace, bead, { kids = [], plan = null, reason = '', doneFile = null, bd = null } = {}) {
  const row = assertNotShipBead(
    assertStillOpen(assertNotSuperseded(await assertEndorsed(bd, workspace, bead)))
  );
  if (!wantsAdvocate(row)) throw advocateRefusal(row);
  const { dir, repo } = resolveSessionRepo(cfg, workspace, row);
  const opened = await launch(
    cfg,
    dir,
    epicAdvocatePrompt(workspace.name, row, kids, plan, ownerName(cfg), { reason }),
    windowTitle('\u{1F9ED}', row.id, repo, row.title, workspace.name),
    { doneFile, agent: EPIC_ADVOCATE, workspace: workspace.name }
  );
  return { ...opened, repo: repoSummary(repo) };
}

/**
 * Why this P0 may not have an advocate — a 409 with the reason in it, matching
 * lib/endorse.js, lib/superseded.js and lib/stillopen.js field for field.
 *
 * The sentence names which of the three it is, because all three are things you can fix
 * from the phone and only one of them is "this is not that kind of bead".
 */
function advocateRefusal(row) {
  const why = !isP0(row)
    ? 'it is not a P0, and an advocate is answerable for a P0'
    : isCrash(row)
      ? 'it is a crash the app filed on itself — a stack trace is not an epic, so it stays a leaf you can work directly'
      : 'nobody owns it, so there is nobody for an advocate to report to — set an owner first';
  return Object.assign(new Error(`${row?.id || 'that bead'} may not have a P0 advocate — ${why}`), {
    status: 409,
    unadvocatable: true,
  });
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
    // And through the same helper, for the same reason. The brief tells the session to
    // merge `origin/<base>` into its branch before delivering; in a multi-repo workspace
    // `pr.base` is the fallback rather than the answer, so a brief that read it directly
    // would send a session working a `develop` repo to merge `origin/main` — a branch it
    // has no business in, or none at all. See lib/prbase.js.
    base: await baseFor(cfg, workspaceName, dir),
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
    // And whether the merge then deploys itself, which is the other end of the same
    // promise. It changes no ending and one sentence: the printed command asks for
    // `--owed "…deploy, rebuild…"`, and in a repo whose merges ship themselves the honest
    // answer to that is usually nothing at all. A session that declares a deploy owed
    // there sends Adam a notification about a tap that is not his to make, over work the
    // release queue is about to put live on its own.
    //
    // Resolved without the epic layer on purpose. lib/autoship.js walks up from the bead
    // *the merge delivered*, which is a walk this brief could make and should not: the
    // answer is read again at merge time, from a tracker that may have moved in the hour
    // between, and a brief is better saying what the repo does than guessing what one
    // label above this bead will still say by then.
    autoShip: policy.autoMerge && autoShipAllowed(cfg, workspaceName),
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
 * - **One line, no newlines.** This is spliced into the middle of a single `&&` chain,
 *   so a newline is a command boundary rather than a character: half of this would run
 *   on its own, immediately, ahead of everything it is supposed to follow. That was
 *   doubly true when the chain was typed straight into a shell; it is still true now
 *   that it is written to a file and sourced (see `sourceLine`), because what breaks is
 *   the chain, not the typing.
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
 * - **The prompt comes last, behind a `--`.** It used to come *first*, because `--tools`
 *   and `--allowedTools` are variadic and would otherwise swallow a trailing `"$P"` as
 *   one more tool name — the session coming up having been asked nothing at all. `--`
 *   ends option parsing, which terminates a variadic option as well, so last is safe and
 *   a brief beginning with a dash is no longer read as a flag. See `promptArgs`, which
 *   is where the whole reason lives; the ordering here is not this file's to choose.
 * - **`cd` is first**, because the interactive `chpwd` hook re-runs `_bd_set_workspace`
 *   there, and that is what points BEADS_DIR and CLAUDE_CONFIG_DIR at the right tree
 *   before `claude` starts.
 * - **`BEADCAUSE_BEAD` rides in the same exports, when this session is about a bead.**
 *   It is what lets `beadcause-memory debrief` file a report without the agent naming the
 *   work — the same argument as `BEADCAUSE_AGENT` beside it, one level down: an agent that
 *   could pass its own bead could file against somebody else's, and afterwards that is
 *   indistinguishable from their having written it. It goes in as `extra`, which
 *   `agentExports` emits *after* the foundation's own `env`, so an amendment cannot
 *   repoint it. A session with no bead — a ship window, a rebase window — is stamped with
 *   nothing and `debrief` refuses rather than guessing, which is correct: those windows
 *   are about a pull request, and a report from one filed against the bead would read as
 *   the report of the run that wrote the code.
 * - **`env` is the tier 3 grant**, for an agent whose foundation says it owns a repo —
 *   empty for every other agent and on every install with `advocates.agentRepo: off`.
 *   Same `extra`, same ordering, same argument as the line above it.
 */
export function sessionCommand(f, {
  dir,
  promptFile,
  systemFile = null,
  mode = null,
  doneFile = null,
  commandFile = null,
  bead = null,
  env = {},
}) {
  const flags = [permissionFlag(mode), ...claudeArgs(f, { systemFile }).map((a) => ` ${a}`)].join('');
  const cleanup = [systemFile, commandFile].filter(Boolean);
  return [
    `cd ${shq(dir)}`,
    // `env` is the tier 3 grant, when this agent owns a repo — the concrete directory,
    // the arm and the run id (lib/agentrepo.js). It rides in the same `extra` as
    // `BEADCAUSE_BEAD` and for the same reason: `agentExports` emits it *after* the
    // foundation's own `env`, so an amendment cannot repoint the wrapper at another
    // agent's directory. Per run rather than per foundation, because the path contains
    // the workspace and a foundation is what the agent is on every run.
    agentExports(f, { ...(bead ? { BEADCAUSE_BEAD: String(bead) } : {}), ...env }),
    `P="$(cat ${shq(promptFile)})"`,
    `rm -f ${shq(promptFile)}`,
    `claude${flags} ${promptArgs().join(' ')}${sessionEnding(doneFile, cleanup)}`,
  ].join(' && ');
}

/**
 * The 1024 bytes a shell will actually accept, and why the command goes in a file.
 *
 * `scripts/open-session.applescript` types the command in with iTerm's `write text`,
 * and what it types into is a **fresh login shell still running `~/.zshrc`** — nvm,
 * pnpm, a minute's worth of nothing in particular. Until zsh's line editor takes over,
 * that tty is in canonical mode, and a canonical-mode tty on macOS holds exactly
 * `MAX_CANON` = **1024 bytes** of unread input. Byte 1025 onward is discarded, and the
 * discarded part includes the newline — so the line is never submitted at all. The
 * window comes up, echoes a command cut off mid-argument, and sits at a prompt.
 *
 * Measured rather than inferred: `cat` on a pty, sent 1500 characters, echoes back
 * 1024. And the console this was reported from truncated at byte 1024 exactly.
 *
 * Nothing about the command was wrong — it had simply grown. Every session was over
 * the line the day it was reported (worker 1047, advocate 1541, epic-advocate 1622),
 * and the two that were furthest over are the ones with the longest allowlists, which
 * is a number that only ever goes up: every tool an agent is granted adds ~20 bytes to
 * a line a tty will not read. So the fix cannot be to shorten the command, because the
 * command is not the thing that has to fit.
 *
 * What fits is `source '<path>'` — a hair over 60 bytes, and **constant** whatever the
 * command grows into. `source` and not `zsh <file>`: everything below the first line
 * depends on running in *this* shell — `cd` fires the interactive `chpwd` hook that
 * points BEADS_DIR at the right tree, and the final `exit` is what ends the window.
 *
 * The file deletes itself on the way out, through the same `cleanup` the system prompt
 * uses — after the status capture, never before, because every `rm` sets `$?` and the
 * done file is the daemon's only fact about how a session ended.
 */
export const sourceLine = (commandFile) => `source ${shq(commandFile)}`;

/**
 * The AppleScript half, shared by both: write the brief, hand iTerm the command.
 *
 * Three temp files go out of here and none of them is the same kind of thing: the
 * *prompt* is what the session is asked, the *system prompt* is what it is, and the
 * *command file* is the line the shell runs — the last one only exists because a tty
 * will not accept a line that long. `sourceLine` is where that argument lives.
 *
 * `doneFile` is what makes an unattended session *end* rather than merely stop.
 * The command runs in an interactive shell, so when `claude` exits you get a
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
async function launch(
  cfg,
  dir,
  prompt,
  tabTitle,
  { doneFile = null, agent = 'worker', bead = null, model = null, workspace = null } = {}
) {
  const stamp = crypto.randomBytes(6).toString('hex');
  const promptFile = path.join(os.tmpdir(), `beadcause-${stamp}.md`);
  const systemFile = path.join(os.tmpdir(), `beadcause-sys-${stamp}.md`);
  const commandFile = path.join(os.tmpdir(), `beadcause-cmd-${stamp}.zsh`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });

  // An approved amendment wins over config, because it was approved for this agent
  // specifically; config is the deployment-wide default underneath it. Same order as
  // `withConfig` applies for the chat session.
  // Which agent's foundation this window comes up under. `worker` is the default and
  // every existing caller means it — but a P0 advocate is a different kind with a
  // different role, a different allowlist and a different mark, and hardcoding the
  // worker here would have opened it with a work session's permissions and a work
  // session's identity while calling it something else. See lib/foundation.js.
  // And the model this run was routed to, which is the one field of a foundation with a
  // per-run source under it. `withModel` is where the precedence is written down and why
  // an approved amendment still wins; `model` is null for every window that is not a
  // worker on a bead, and then this changes nothing at all.
  const f = withModel(await effective(dir, agent), model);
  const mode = f.permissionMode ?? cfg.sessionPermissionMode;

  // Tier 3 (lib/agentrepo.js): the directory this agent owns, the arm this run is in, and
  // the line that puts the run in the denominator whether or not it ever looks in there.
  //
  // Here rather than in the two prompt builders, which is not where bc-goo.12 expected it:
  // `workPromptFor` and `epicAdvocatePrompt` are pure functions of their arguments on
  // purpose — it is what lets test/land.mjs and test/epicadvocate.mjs assert every branch
  // of a brief with no tracker, no checkout and no disk — and provisioning a repo, writing
  // a usage line and reading an index are three disk reads apiece. So the *grant* is
  // composed at the one door both agents come through, and what the agent is told rides in
  // the system prompt beside the memory brief, which is the other thing it is handed about
  // where it may keep what it knows.
  //
  // Wrapped, and the run goes ahead without it: this experiment rides along with the real
  // job, and a work session that did not open because its diary would not initialise would
  // be the silliest outcome available. `workspace` is null for a caller that has none, and
  // an agent whose foundation does not own a repo gets null back and pays nothing.
  let repo = null;
  try {
    if (workspace) {
      repo = await agentrepo.startRun(f, workspace, {
        setting: agentrepo.armSetting(cfg),
        owner: ownerName(cfg),
      });
    }
  } catch (err) {
    console.error(`[beadcause] ${agent}: no agent repo this session — ${err.message.split('\n')[0]}`);
  }
  // Added to the effective foundation rather than baked into the baseline, for the reason
  // `grantsFor` gives: the concrete path is per run and a foundation is what the agent is
  // on every run. It widens the allowlist by one entry and never narrows it — the worker
  // carries no allowlist at all (it is interactive), and one entry there is one command it
  // need not be asked about rather than the only command it may run.
  if (repo) f.allowedTools = [...(f.allowedTools || []), ...repo.grant.allowedTools];

  // The amendable half of what this agent is, then the one copy of the memory brief —
  // the same order and the same reasoning as lib/console.js. A system prompt and not a
  // preamble to the brief: a work session runs for as long as the work takes, and what
  // it *is* has to still be in front of it on the fortieth turn, not buried under
  // forty turns of a task. `role` is amendable and the brief below it is not, which is
  // the line the whole of lib/foundation.js draws.
  //
  // The tier 3 brief goes after the memory brief and for the same reason lib/advocate.js
  // puts it there: an agent should have read what it *knows* before being handed somewhere
  // with nothing decided about it. It is absent entirely for an agent that owns no repo —
  // an unset affordance has to read as one that does not exist, not as an empty heading.
  fs.writeFileSync(
    systemFile,
    systemPrompt(f, [memoryBrief(ownerName(cfg)), repo?.brief].filter(Boolean).join('\n\n')),
    { mode: 0o600 }
  );

  // What runs, and — separately — what is typed. They are not the same string any more:
  // a tty being typed into before its shell is ready holds 1024 bytes and drops the
  // rest, which is every session's command today. See `sourceLine`.
  const script = sessionCommand(f, {
    dir,
    promptFile,
    systemFile,
    mode,
    doneFile,
    commandFile,
    bead,
    env: repo?.grant.env || {},
  });
  fs.writeFileSync(commandFile, script + '\n', { mode: 0o600 });
  const command = sourceLine(commandFile);

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
      //
      // `model` is reported back for the same reason, one step further on: the card has
      // to be able to say what this window came up on *before* it ends, and the only
      // process that ever knew is this one. It is `f.model` and not the routed argument
      // — what actually went on the command line, so a worker running an amended model
      // says so rather than reporting the tier's answer and being wrong about it. Null
      // where nothing set one, which is `claude`'s own default and not a fact beadcause
      // has; what the session *really* ran with is bc-nc6o.3, off the finished run.
      if (!err) {
        return resolve({
          dir,
          mode: mode || 'default',
          model: f.model || null,
          term: String(stdout || '').trim() || null,
        });
      }
      // No window means no shell to run the cleanup at the end of the command — and
      // the command is now one of the files that needs cleaning up.
      for (const f_ of [promptFile, systemFile, commandFile]) fs.rmSync(f_, { force: true });
      const detail = `${stderr || ''}${err.message}`;
      const blocked = itermBlocked(detail);
      if (blocked) return reject(blocked);
      reject(new Error(detail.split('\n')[0] || 'could not open a session'));
    });
  });
}

/* ------------------------------------------------------- talking to a session */

/**
 * macOS refusing the Apple event, said once for all three scripts that can hit it.
 *
 * -1743 is the refusal, and it is the one `osascript` failure worth translating: this
 * daemon runs under launchd, where a TCC prompt may never be shown to anybody at all,
 * so the error a person sees has to name the checkbox rather than the error code. Null
 * when the failure was something else, which the caller reports as itself.
 */
function itermBlocked(detail) {
  if (!/-1743|not authori[sz]ed|Not authorized to send Apple events/i.test(detail)) return null;
  return Object.assign(
    new Error(
      'macOS blocked beadcause from controlling iTerm. Approve it once in ' +
        'System Settings → Privacy & Security → Automation, then try again.'
    ),
    { status: 403 }
  );
}

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
          const blocked = itermBlocked(detail);
          if (blocked) return reject(blocked);
          return reject(new Error(detail.split('\n')[0] || 'could not reach that session'));
        }
        resolve(String(stdout || '').trim() === 'missing' ? 'missing' : 'sent');
      }
    );
  });
}

/**
 * Point the Mac at a session's window — and say where that window was.
 *
 * The other direction of the channel `messageSession` opened. That one puts words into
 * a window from a phone in another room; this one is for when you are about to walk
 * over to the Mac and cannot find which of a dozen worktree windows you have been
 * reading about. `scripts/focus-session.applescript` has the detail.
 *
 * Resolves the window's bounds **as they were before this call changed anything**, or
 * `null` when no iTerm session carries the handle — the same `missing` that
 * `messageSession` reports, and the same meaning: the window has gone, which is a fact
 * nothing else on this machine can establish.
 *
 * The reading and the set happen in one call on purpose. Split into two, the second
 * would read the rectangle the first had already enlarged and save *that* as the thing
 * to put the window back to — so a double tap would leave a window nothing could
 * restore. See `lib/focus.js`, which is the only caller and holds what comes back.
 *
 * `bounds` is a rectangle or null; null leaves the window's geometry alone, which is
 * how you ask only for the reading. `front` raises iTerm and selects the window.
 */
export function focusSession(handle, { bounds = null, front = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      [FOCUS_SCRIPT, String(handle), boundsArg(bounds), front ? 'front' : 'quiet'],
      { timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = `${stderr || ''}${err.message}`;
          const blocked = itermBlocked(detail);
          if (blocked) return reject(blocked);
          return reject(new Error(detail.split('\n')[0] || 'could not reach that session'));
        }
        // `missing` and an unparseable reading end the same way, and must: both mean
        // there is no rectangle to put back, and inventing one would move the window.
        resolve(parseBounds(String(stdout || '').trim()));
      }
    );
  });
}

/**
 * Is that window still there? — asked without typing anything into it.
 *
 * `messageSession` already answers this, and until lib/resolvers.js grew a queue that
 * was enough: every question about a resolver arrived with a sentence to deliver, so
 * the liveness came free with the nudge. A queue asks the question with nothing to say.
 * Repeating the nudge to find out whether a slot has freed would put a line into a
 * window an agent is working in every time the drain ran, which is a worse answer than
 * no queue at all.
 *
 * So it is the *focus* script, in the mode that touches nothing: no bounds to set and
 * `quiet` rather than `front`, which makes it a pure reading of a window it does not
 * move, raise or select. It prints the literal `missing` when no session carries the
 * handle — the fact its own header calls "the only honest way to learn it" — and four
 * integers when one does. `focusSession` collapses those two into `null` because both
 * mean there is no rectangle to restore; here they must stay apart, because one of them
 * frees a slot.
 *
 * Resolves `true` (the window is there) or `false` (proven gone), and **rejects** when
 * macOS will not talk to iTerm — the rule `messageSession` states and `reclaim` keeps:
 * a refusal is not evidence about the session, and turning it into `false` would hand
 * a slot away from an agent that is still working in it. Anything the script prints
 * that is not `missing` counts as there, for the same reason: only the word means gone.
 *
 * It never launches iTerm — `is running` is a question, not a use — so a Mac with no
 * terminal open answers `missing` for every handle, which is exactly right.
 */
export function sessionAlive(handle) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      [FOCUS_SCRIPT, String(handle), '', 'quiet'],
      { timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = `${stderr || ''}${err.message}`;
          const blocked = itermBlocked(detail);
          if (blocked) return reject(blocked);
          return reject(new Error(detail.split('\n')[0] || 'could not reach that session'));
        }
        resolve(String(stdout || '').trim() !== 'missing');
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
