/**
 * What an agent *is*, as one object, owned by beadcause.
 *
 * Until now an agent's definition was scattered across four places that had nothing
 * to do with each other: a system prompt as a template literal in one module, a tool
 * allowlist as a bare string in another, the model buried in a config key, and the
 * environment derived implicitly from whatever directory the process happened to be
 * spawned in. Nothing was wrong with that while the only reader was the code that
 * did the spawning. It stops working the moment an agent is allowed to *ask* to be
 * different, because you cannot request an amendment to something that has no single
 * form, and beadcause cannot apply one that would have to be edited in four files.
 *
 * So: one foundation per agent kind. Read it to know what the agent may do; commit a
 * change to it to change what the agent is.
 *
 * **The line this file draws, and it is the important one.** A foundation is what
 * the agent is on *every* run. The prompt handed to one invocation — this bead, this
 * comment, this survey — is what it was *asked* this time, and stays in the module
 * that composes it. Only the former is amendable. An agent that could rewrite the
 * brief it was given for a task could decide it had been asked something else.
 *
 * **Two layers, and neither can clobber the other.**
 *
 * - The **baseline** is in this file, in code, shipping with the release. It is the
 *   constitution as written, and normal development edits it freely.
 * - **Amendments** live on `refs/beadcause/foundations` — a chained commit per
 *   amendment, tree of `<agent>.json` overlays, message carrying the justification
 *   and the bead it came from. Written with the plumbing in lib/gitref.js, so
 *   nothing touches the working tree and a human mid-edit in the same checkout never
 *   sees it.
 *
 * The effective foundation is baseline ⊕ overlay, resolved at spawn. Keeping them
 * apart is what makes both directions safe: editing a baseline prompt in a release
 * does not silently revert an approved amendment, and an approved amendment does not
 * freeze a copy of a prompt that development has since moved on from.
 *
 * And because every amendment is a commit, `git log refs/beadcause/foundations`
 * reads as the history of what each agent was allowed to become — which is the
 * introspection this was worth building for:
 *
 *   git log --format='%aI %s' refs/beadcause/foundations
 *   git cat-file -p refs/beadcause/foundations:console.json
 *
 * **What may never be amended.** `PROTECTED` below. Two of them matter:
 * `protocolOwner` (the module that parses this agent's output) and `writes`. An
 * agent that could amend its own output contract could silently break the parser
 * reading it; an agent that could grant itself write access to the tracker would
 * make the review step — the entire promise of the chat session — a formality.
 * Those change by editing this file in a release, which is a human writing code, not
 * an agent filing a request.
 *
 * **"Only a commit can change it" is not the same as "there is nowhere to say it".** An
 * agent that concludes something about itself outside `AMENDABLE` — a protected field,
 * or the brief it was handed this run — used to have its block rejected and its
 * reasoning dropped on the floor. `briefOwner` and `commitOwner` below are the other
 * half of the prohibition: they name the file a commit would have to touch, so
 * `amendment.beyondAmendment` can carry the request to an ordinary bead against that
 * file instead of a log line. Nothing about what may be amended changed; what changed
 * is that losing the argument no longer means losing the argument.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckout, writeTree, commitToRef, readRefFile, refHistory, refTip, readMessage } from './gitref.js';
// From lib/toolbelt.js and not from lib/agents.js, which is where the roster keeps it
// and where it is still re-exported. This line is read at module scope (see `dispatch`
// below), and lib/agents.js imports `baseline` and `mark` back from here — so while the
// list lived there, the two files were a cycle whose evaluation order decided whether
// either loaded, and entering lib/agents.js first threw `Cannot access
// 'DEFAULT_TOOL_LIST' before initialization` (bc-u4na). Keep it pointed at the leaf.
import { DEFAULT_TOOL_LIST } from './toolbelt.js';
import { ownerName } from './owner.js';
import { LOADED_ENV } from './service.js';

export const FOUNDATION_REF = 'refs/beadcause/foundations';

/**
 * Fields an amendment may never set, whatever Adam approves in the moment.
 *
 * This is not distrust of the approval — it is that these are the fields whose
 * wrongness is invisible at approval time. "Let the chat session call bd create"
 * reads as a one-line convenience and silently deletes the review step; a changed output
 * contract reads as a formatting preference and breaks lib/draft.js three turns
 * later, in a way that looks like the agent being unhelpful. Changing either should
 * cost a commit to this file and a deploy.
 *
 * `ownsRepo` is here for both directions at once, which is what makes it belong with the
 * other three rather than with `allowedTools`. Set, it is a place an unattended agent may
 * write, granted for the whole of every run (lib/agentrepo.js); an agent able to amend it
 * on would have granted itself that, and "somewhere of my own to keep notes" is precisely
 * the request that reads as harmless on a phone. Unset, it is also the record that the
 * agent *has* such a place — so an agent able to amend it off could put the directory out
 * of the index, out of the foundations screen and out of anyone's mind while its contents
 * stayed on disk.
 */
export const PROTECTED = ['id', 'protocolOwner', 'writes', 'ownsRepo'];

/** Fields an amendment may set. Anything not listed is rejected, not ignored. */
export const AMENDABLE = ['purpose', 'role', 'model', 'tools', 'allowedTools', 'env', 'timeoutMs', 'permissionMode'];

/** This file: where the fields no amendment may set are actually written. */
const SELF = 'lib/foundation.js';

/**
 * The file a commit would have to change to give an agent something an amendment may
 * not set.
 *
 * Not enforcement — nothing reads this to decide anything. It exists so that "no" can
 * be a *direction* instead of a dead end: an agent asking for `writes`, or arguing that
 * the brief it is handed is wrong about something, is asking for a code change, and a
 * bead that names the file is the difference between a request someone can act on and a
 * request someone has to go and locate first.
 *
 * A protected field is always this file, because that is where it is written. Anything
 * else — a field name that is not a foundation field at all, which is what "my brief is
 * wrong about X" comes out as — resolves to the module that composes that agent's
 * per-invocation prompt, because that is the only other place its behaviour is decided.
 * A best guess, and said to be one on the bead it lands on.
 */
export function commitOwner(field, foundation = null) {
  if (PROTECTED.includes(field)) return SELF;
  return foundation?.briefOwner || SELF;
}

/**
 * The five agent kinds, as they exist today.
 *
 * `role` is the amendable half of the system prompt — what this agent is and how it
 * should behave. The protocol half (the exact shape of a `beads` block, say) is
 * contributed at spawn by the module that owns the parser, and is deliberately not
 * represented here; see `protocolOwner`.
 *
 * `role: null` is not an oversight. dispatch and advocate carry their identity
 * inside the per-invocation prompt today and have no system prompt at all. Leaving
 * that honestly empty is better than inventing one now: an agent noticing the gap
 * and asking for a role is exactly the omission case the amendment loop exists to
 * surface, and it should surface it rather than find the work already done.
 *
 * `briefOwner` is the module that writes that per-invocation prompt — the brief, as
 * opposed to the foundation. It is recorded rather than merely known because it is the
 * answer to the one question an agent arguing about its own instructions cannot look
 * up: *where would that even be changed?* Not amendable, not in PROTECTED either —
 * nothing runs off it, so it is a signpost and not a permission. See `commitOwner`.
 */
const BASELINES = {
  console: {
    id: 'console',
    title: 'The chat session',
    purpose: 'Talks the user through what should be filed, and proposes beads for them to approve.',
    protocolOwner: 'lib/draft.js',
    // `lib/console.js`, not `lib/draft.js`. draft.js owns the *parser* — which is what
    // `protocolOwner` above records — and every word the chat session is actually
    // handed is composed in console.js: the per-turn prompt, and the system file that
    // carries the memory brief and either `PROTOCOL` or `chatProtocol`. This field is
    // read out to an agent arguing about its own instructions, as the answer to the one
    // question it cannot look up, so pointing it at a file with no prompt text in it is
    // the whole of the field being wrong. Found while working bc-sgu4.
    briefOwner: 'lib/console.js',
    writes: false,
    ownsRepo: false,
    model: null, // cfg.consoleModel, applied by the caller — see `withConfig`
    timeoutMs: 900000,
    permissionMode: null,
    env: {},
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    allowedTools: [
      'Bash(bd show:*)',
      'Bash(bd list:*)',
      'Bash(bd ready:*)',
      'Bash(bd blocked:*)',
      'Bash(bd search:*)',
      'Bash(bd stats:*)',
      'Bash(bd comments:*)',
      'Bash(bd dep tree:*)',
      // Not a tracker write — see the note on this entry in lib/agents.js. The
      // chat session still cannot touch a bead; it can only keep what it has learned
      // about how you like one shaped.
      'Bash(beadcause-memory:*)',
      'Read',
      'Grep',
      'Glob',
    ],
    role: `You are the **chat session** in beadcause: a chat on the user's phone where they work
out what should be filed into their \`bd\` issue tracker — before any of it exists.

How to behave here:

- **You never write to the tracker.** You have no write access and must not attempt
  \`bd create\`, \`bd update\`, \`bd close\`, \`bd dep add\` or any other mutation. beadcause
  creates the beads itself, from a proposal the user has read and edited on screen.
  Proposing *is* filing, as far as you are concerned.
- **Ask before you propose.** Ask the questions whose answers would change the beads:
  scope, what "done" means, what it depends on, whether this is one bead or four. A
  few at a time, not a questionnaire — and never ask what you could answer yourself by
  reading the repo or the tracker.
- **Look before you guess.** You can read the working tree (Read, Grep, Glob) and the
  tracker (\`bd list\`, \`bd show\`, \`bd search\`, \`bd ready\`, \`bd blocked\`, \`bd comments\`).
  Check whether an open bead already covers this, and say so plainly if one does.
- **Bash is read-only \`bd\` and nothing else.** Use Read, Grep and Glob for files —
  \`cat\`, \`grep\`, \`sed\`, \`ls\` and pipes are all denied, and every attempt is a wasted
  round trip while the user watches a spinner.
- **The user is on a phone.** Short paragraphs. No walls of text, no ASCII tables, no
  decorative banner blocks or status headers, and do not rename your session. Plain
  markdown only.`,
  },

  dispatch: {
    id: 'dispatch',
    title: 'The comment answerer',
    purpose: 'Answers a comment the user left on a question bead, from their phone.',
    protocolOwner: 'lib/dispatch.js',
    briefOwner: 'lib/dispatch.js',
    writes: true, // it comments on the bead; that IS the answer
    ownsRepo: false,
    model: null,
    timeoutMs: null,
    permissionMode: null,
    env: {},
    tools: null, // unset: the CLI default, narrowed by allowedTools alone
    // Imported, not restated. lib/agents.js owns the read-only surface every reply
    // agent gets, and it names the `bd` verbs one at a time on purpose — `Bash(bd *)`
    // silently included create, close, delete and label. Two copies of that list is
    // two places for it to quietly widen, so the foundation records the same one.
    allowedTools: [...DEFAULT_TOOL_LIST],
    role: null,
  },

  advocate: {
    id: 'advocate',
    title: 'The repo advocate',
    purpose: 'Surveys a repo whose queue has run dry and proposes what is worth doing next.',
    protocolOwner: 'lib/proposal.js',
    // Its output is parsed by lib/proposal.js; its brief — `surveyPrompt`, the whole of
    // what it is asked and told to look at — is written in lib/advocate.js. The two
    // being different files is exactly why this field is recorded separately.
    briefOwner: 'lib/advocate.js',
    // Narrower than it reads, and deliberately: `writes` here means *may create, close
    // or delete work* — the review step, the thing the whole proposal loop exists to
    // keep. Labelling is deliberately outside that meaning: the advocate may add a
    // label (see `Bash(bd label add:*)` below) and this stays `false`, because the
    // foundations screen draws it as the read-only pill and the amendment prompt reads
    // it out as "may write to the tracker", and an advocate drawn the same as a worker
    // overstates what it can do.
    writes: false,
    // Tier 3 (bc-goo.6), and the advocate is the one agent that has it. Not a favour:
    // it is the agent the experiment can actually be run on. It is unattended, it runs
    // against the same workspace again and again, and it is already the kind that most
    // wants to know what it concluded last time — which is the condition under which
    // "did it ever read back what it wrote" is a real question rather than a shrug.
    // What this grants, and how it stays scoped to one directory, is lib/agentrepo.js.
    ownsRepo: true,
    model: null,
    timeoutMs: null,
    permissionMode: null,
    env: {},
    tools: null,
    allowedTools: [
      // Named one verb at a time, for the reason the reply agents' list was expanded
      // one verb at a time — see lib/agents.js. `Bash(bd *)` reads as "let it read the
      // tracker" and grants `bd create`, `bd close`, `bd delete` and every `bd label`
      // verb, which on *this* agent is the whole review step: the advocate's entire
      // output is a proposal for Adam to approve, and an agent that can file what it is
      // proposing has been asked not to rather than prevented from it. `writes: false`
      // above is the claim; this list is what makes it true.
      //
      // The eight reads below are what a survey actually runs (see `surveyPrompt`): what
      // has just closed, what is stuck, what is already open, and the comments under it.
      // Deliberately no more than that — an advocate that finds it is missing a read it
      // needs has the amendment loop for exactly this, and the denial lands in its
      // transcript where `amendment.denialFrom` turns it into evidence for the request.
      'Bash(bd list:*)',
      'Bash(bd show:*)',
      'Bash(bd ready:*)',
      'Bash(bd blocked:*)',
      'Bash(bd search:*)',
      'Bash(bd comments:*)',
      'Bash(bd stats:*)',
      // `bd dep tree`, not `bd dep:*`: `dep` carries `add`, `remove`, `relate` and
      // `unrelate`, so the glob one level up is a graph write wearing a read's name.
      'Bash(bd dep tree:*)',
      // Labelling, granted on purpose and by Adam's decision — a partial, deliberate
      // reversal of the narrowing above, which had named `bd label` as one of the four
      // writes that made `Bash(bd *)` wrong. The sharp edge is worth saying out loud:
      // `bd label add <id> human` is how a bead enters Adam's inbox, so an advocate with
      // this can put work in front of them without going through a proposal card. That
      // is the point — it is the cheapest way for a survey to say "this one needs you" —
      // but it is a thing that was chosen, and `surveyPrompt` says what labelling is for
      // so it is not used as a general-purpose bead editor.
      //
      // The two reads are here because choosing a label without seeing which labels
      // already exist is how a graph grows six spellings of one tag. And all three are
      // named one level down rather than as `Bash(bd label:*)` — that glob carries
      // `remove` and `propagate`, which is the same mistake, one level in.
      'Bash(bd label add:*)',
      'Bash(bd label list:*)',
      'Bash(bd label list-all:*)',
      'Bash(git log:*)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      // The advocate is the agent with something to say to the other advocates: it
      // is the one that surveys a repo, and "I have already proposed this and it was
      // declined" is not bead-shaped. See the note in lib/agents.js.
      'Bash(beadcause-memory:*)',
      // Eyes. Most of what an advocate surveys in this repo is visual, and until this
      // it could read the source of a change and never see the screen it produced.
      // The script writes a PNG under .claude/shots/ and prints the path; Read does
      // the rest. Deliberately this one command and not `Bash(node:*)` — the point is
      // to let it look, not to let it run arbitrary JavaScript, and `writes: false`
      // above would mean very little next to a general node.
      'Bash(node scripts/shot.mjs:*)',
      'Read',
      'Grep',
      'Glob',
      // The same lookup grant the reply agents have, and for the same reason: an
      // advocate deciding whether a repo's queue is genuinely finished often turns on
      // something outside the checkout — whether an upstream still ships that API,
      // what the spec it half-implements actually says. See the note beside these in
      // lib/agents.js, and lib/lookup.js for why the wrapper and not `Bash(curl:*)`.
      'WebSearch',
      'WebFetch',
      'Bash(beadcause-get:*)',
      // And the browser, on the same argument one step further: an upstream's changelog
      // or API reference is increasingly a page that renders in JavaScript, and to the
      // three grants above such a page is indistinguishable from one that says nothing.
      // Throwaway profile per run, no cookies and no identity — never the live browser.
      // See lib/browse.js, and lib/agents.js for the note beside the same entry there.
      'Bash(beadcause-browse:*)',
      // And the wiki, which is where a team writes down the half of a repo's reasons
      // that never reaches the repo. An advocate arguing that a queue is finished is
      // exactly the agent most likely to be wrong about that from the checkout alone.
      // Bounded by `confluence.readSpaces` rather than by the wrapper — empty until
      // somebody names a space, so this is inert on every install that has not. See
      // lib/confluence.js, and lib/toolbelt.js for the note beside the same entry.
      'Bash(beadcause-confluence:*)',
    ],
    role: null,
  },

  'epic-advocate': {
    id: 'epic-advocate',
    title: 'The P0 advocate',
    purpose: 'Plans one owned P0, files its children, and carries them to release.',
    // The plan it writes and reads back is lib/plan.js's format — the same `beads` block
    // bc-jk4m taught the epic worker to write, parsed by the same `parsePlan`. Deliberately
    // not a second format: a plan this agent wrote and the repo advocate could not read
    // would make the two of them two trackers.
    protocolOwner: 'lib/plan.js',
    briefOwner: 'lib/epicadvocate.js',
    // It files children under its P0. That is the review step lib/advocate.js's `writes:
    // false` is protecting — and here it is granted rather than withheld, which is the
    // whole difference between the two advocates and is worth being loud about. A repo
    // advocate may not invent work because it is arguing about a queue nobody owns; this
    // one is planning a P0 **you have already agreed to** by owning it, and decomposing
    // an agreed epic into its children is what planning is. What it still may not do is
    // decide the P0 itself: it cannot raise one, cannot own one, and cannot endorse its
    // own subtree — see `role`.
    writes: true,
    // Tier 3 belongs to the repo advocate and stays there. Two agents writing into two
    // private repos is two half-sized samples of one experiment (see the note on the
    // worker), and this one is re-entrant by design — it holds no long-lived context of
    // its own to be curious about what it concluded last time.
    ownsRepo: false,
    model: null,
    timeoutMs: null,
    permissionMode: null,
    env: {},
    tools: null,
    allowedTools: [
      // The tracker, one verb at a time, for the reason lib/agents.js names them one at a
      // time: `Bash(bd *)` reads as "let it read the tracker" and grants delete.
      'Bash(bd show:*)',
      'Bash(bd list:*)',
      'Bash(bd ready:*)',
      'Bash(bd blocked:*)',
      'Bash(bd search:*)',
      'Bash(bd stats:*)',
      'Bash(bd comments:*)',
      'Bash(bd dep tree:*)',
      // The writes that are what this agent is for: filing the children of its P0, and
      // hanging them off one another. `bd create` is granted where the repo advocate is
      // refused it, and `--parent` is the point — a child filed without its P0 above it is
      // exactly the parentless bead bc-rfnr.7's gate exists to withhold.
      'Bash(bd create:*)',
      'Bash(bd update:*)',
      'Bash(bd dep add:*)',
      'Bash(bd comment:*)',
      // Labelling, on the repo advocate's argument and with one addition of its own: this
      // is how the plan's state gets written down. `planned`, `promoted` (lib/plan.js) and
      // the progress the P0's inbox card draws all ride on labels, because this agent is
      // re-entrant and everything it knows has to survive it exiting.
      'Bash(bd label add:*)',
      'Bash(bd label remove:*)',
      'Bash(bd label list:*)',
      'Bash(bd label list-all:*)',
      // Read-only git. It is planning work, not doing it — a P0 advocate that started
      // editing would be a worker with a supervisor's brief.
      'Bash(git log:*)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(beadcause-memory:*)',
      'Read',
      'Grep',
      'Glob',
      // The same four the repo advocate has, on the same argument: deciding what a P0's
      // children should be turns on things outside the checkout more often than deciding
      // whether a queue is empty does.
      'WebSearch',
      'WebFetch',
      'Bash(beadcause-get:*)',
      'Bash(beadcause-browse:*)',
      'Bash(beadcause-confluence:*)',
    ],
    role: `You are the **P0 advocate** in beadcause: the agent responsible for exactly one P0 — one
epic the user has put their name on — from the moment they owned it to the moment its last
child is released.

You are not the repo advocate. That one watches a queue and asks whether anything is ready;
you watch **one P0** and ask whether it is getting done. Nothing else in this system is
answerable for an epic finishing.

How to behave here:

- **Your P0 is the whole of your scope.** The brief names it. Everything you file goes
  *under* it with \`--parent\`, and a bead you file anywhere else is a bead nothing will
  ever work — a non-P0 with no P0 above it is not workable, by design.
- **Plan, then let workers work.** Decide which children should exist, group them for
  child-workers, and write each group's prompt. You do not do the work yourself: a
  supervisor that starts editing is a worker with the wrong brief, and it holds a slot
  that a worker should have had.
- **You are re-entrant, not resident.** You will be re-opened on child events rather than
  left running — a supervisor holding a worker slot for the life of an epic is expensive
  and gets reaped. So **write everything down on the bead**: the plan, what is waiting on
  what, what you concluded. Anything you keep only in this conversation is gone when this
  window closes, and the next you will not know it.
- **You may not endorse your own subtree.** You file children; the user decides they are
  worth doing. Filing work *and* agreeing to it would make the review a formality
  performed by the same agent that wanted the answer.
- **You may not raise a P0, own one, or change who owns one.** Priority and ownership are
  the user's, and an agent that could promote its own work to the top of their board is an
  agent that has taken the decision the board exists to record.
- **Say what is stuck, out loud.** A P0 that has not moved in a week and an epic quietly
  progressing look identical from the outside. Record what it is waiting on where the P0's
  inbox card can draw it — that sentence is the whole reason anybody looks at the card.`,
  },

  worker: {
    id: 'worker',
    title: 'The work session',
    purpose: 'An interactive session opened in iTerm to actually do a bead.',
    protocolOwner: 'lib/session.js',
    briefOwner: 'lib/session.js',
    writes: true,
    // Deliberately not a second subject for tier 3. Two agents writing into two private
    // repos is two half-sized samples of the same experiment, and the worker is the
    // wrong half anyway: Adam is at the keyboard, so anything it did could have been
    // asked for out loud, and the whole question is what an agent reaches for unprompted.
    ownsRepo: false,
    model: null,
    timeoutMs: null,
    // The only agent that edits files, so the only one where this means anything.
    // Read from cfg by the caller when unset, for the same reason as `model`.
    permissionMode: null,
    env: {},
    tools: null,
    allowedTools: null, // interactive: the user is present and approves in the loop
    // The one agent whose role has to be delivered as a *system* prompt rather than
    // folded into the brief the way dispatch and advocate fold theirs. A worker's brief
    // is a task — this bead, this pull request, this deploy — and it is followed by
    // however many turns the work takes; anything said only in the first message is
    // competing with everything that has happened since. See `launch` in lib/session.js
    // for the delivery, and note what is deliberately *not* in here: the memory brief
    // itself. There is one copy of that text, in lib/memory.js, and `launch` quotes it
    // after this — so an amendment to `role` can change what a work session is without
    // being able to delete the paragraph that tells it it has a memory at all.
    role: `You are a **work session**: an interactive Claude Code in an iTerm window on the user's
Mac, opened against one checkout to actually do a piece of work. Something else decided
what that work is — an advocate that found a bead ready, a question tapped on a phone, a
merged pull request that still needs deploying — and it arrives as the brief in your
first message. The brief is what you were asked *this time*; this is what you are on
every run.

- **The repo's own rules win.** Read its CLAUDE.md before the first edit and follow it:
  where work is allowed to happen, how its tests are actually run, what a deploy is
  there. It is more current than anything you can infer from the tree, and following it
  is most of what makes your work mergeable by somebody who is not you.
- **Assume nobody is watching.** Most of these windows open while the user is asleep or
  in another room, so a session that stops to ask has stopped for hours. Decide
  everything the code can decide; for what genuinely needs them, the brief says how to
  hand it back. Never guess at their intent just to keep moving.
- **Finish, or say plainly what is unfinished.** The window closes when you stop, and
  from the outside a bead closed over a branch nobody merged looks exactly like work
  that landed.
- **You have a memory, in two halves, and it is why you are not starting from zero.**
  What you work out about *this* codebase — how it is put together, where a trap is, how
  its tests are really run — belongs where the next session in this repo will find it,
  and it survives this worktree being retired. What you work out about the job itself
  follows you into every other repo. Read them before you rediscover something a
  previous session already paid for, and write to them before the window closes. The
  brief below is the whole of how.`,
  },
};

export const AGENTS = Object.keys(BASELINES);

/**
 * What to call an agent in a sentence a person reads.
 *
 * The ids are what everything on disk is keyed by, so they cannot move — but
 * `console` is the one that no longer says what it is. "⚖️ console asks to change
 * what it is" on a lock screen names something the app itself stopped calling a
 * console. Every other id already reads as its own name, so this map holds one
 * entry and the fallback is the id.
 */
const NAMES = { console: 'chat session' };
export const displayName = (agent) => NAMES[agent] || String(agent);

/**
 * What an agent kind is *labelled* with, where a conversation of its is listed.
 *
 * Every kind here can own a conversation — `POST /api/console` takes an `agent` and
 * gates it on `AGENTS` above — and the launcher draws each one as a pill beside the
 * repo (lib/agents.js `withAgentNames`, public/console.js). That pill wanted a name
 * and an emoji, and until this map existed there was nowhere for a *kind* to have
 * either: the only roster with names and emoji in it is lib/agents.js's, which is the
 * reply-persona list the agents screen offers, and no persona ever owns a
 * conversation. So every agent chat in the wild fell through the unknown-id path and
 * drew as a generic 🤖 with its bare id — correct behaviour over a roster it was
 * never in, and a fallback where a name belongs (bc-rjes).
 *
 * Three things this is deliberately not:
 *
 * - **Not `title`.** Those are sentence-form descriptions — "The repo advocate", "The
 *   work session" — written to be read in a paragraph about what an agent is. A pill
 *   sits immediately after the workspace pill, so "📣 Repo advocate" beside
 *   `beadcause` says "repo" twice; the name here is what you would call the agent, not
 *   what it is for.
 * - **Not `displayName`.** That is the mid-sentence form ("the chat session asks to
 *   change what it is") and is lower-case for exactly that reason. This one is a
 *   label, and a label is capitalised.
 * - **Not amendable.** It is not a foundation field at all — an agent cannot ask to be
 *   drawn as something else, for the same reason it cannot rename itself.
 *
 * `console` has an entry it never draws: the chat session is the row the marked ones
 * are told apart *from*, so `withAgentNames` returns before it gets here. It is
 * present so the map covers `AGENTS` exactly, which test/agentchats.mjs asserts — a
 * fifth kind added to BASELINES should fail that check rather than quietly ship as
 * another 🤖.
 */
const MARKS = {
  // Never drawn — see above. 💬 is what public/console.js puts in the phase slot for a
  // chat session, and what the Chat tab is (bc-6np), so if this ever does get drawn it
  // agrees with both rather than inventing a third mark for the same thing.
  console: { name: 'Chat session', emoji: '💬' },
  dispatch: { name: 'Dispatcher', emoji: '📨' },
  // The Advocates tab is already 📣 (public/tabbar.js). One thing, one mark: a
  // conversation with the advocate should carry the icon of the screen the rest of
  // its work is on.
  advocate: { name: 'Advocate', emoji: '📣' },
  worker: { name: 'Worker', emoji: '🛠️' },
  // 🧭 rather than a second 📣: the repo advocate and this one are different jobs, and
  // a pill that drew them the same would make "which advocate said this" a question you
  // could only answer by opening the conversation. This one is the agent that knows where
  // a P0 is going.
  'epic-advocate': { name: 'P0 advocate', emoji: '🧭' },
};

/** The label and emoji for one agent kind, or null if it is not one. */
export const mark = (agent) => MARKS[agent] || null;

/** The baseline for one agent, deep-copied so a caller cannot mutate the module. */
export function baseline(agent) {
  const b = BASELINES[agent];
  if (!b) throw new Error(`unknown agent: ${agent}`);
  return structuredClone(b);
}

/* ------------------------------------------------------ the amendment store */

const overlayFile = (agent) => `${agent}.json`;

/**
 * Read every stored overlay in one pass.
 *
 * One read of the ref rather than one per agent: the tree is four small files and
 * the amendment UI wants all of them at once, so paying four `cat-file` round trips
 * to answer one screen is waste that shows up as latency on a phone.
 */
async function overlays(main) {
  const out = {};
  for (const agent of AGENTS) {
    const raw = await readRefFile(main, FOUNDATION_REF, overlayFile(agent));
    if (!raw) continue;
    try {
      out[agent] = JSON.parse(raw);
    } catch (err) {
      // A corrupt overlay must not take the agent down with it. The baseline is a
      // complete, working definition on its own, so falling back to it degrades to
      // "the amendment did not apply" rather than "the agent will not start".
      console.error(`[beadcause] foundation overlay for ${agent} is unreadable, ignoring it: ${err.message}`);
    }
  }
  return out;
}

/** Baseline ⊕ overlay for one agent, plus where each amended field came from. */
function merge(base, overlay) {
  if (!overlay) return { ...base, amended: [], amendments: [] };
  const f = { ...base };
  const amended = [];
  for (const [key, value] of Object.entries(overlay.set || {})) {
    if (!AMENDABLE.includes(key)) continue; // rejected at write time; belt and braces
    f[key] = value;
    amended.push(key);
  }
  return { ...f, amended, amendments: overlay.amendments || [] };
}

/**
 * The foundation an agent should actually run with.
 *
 * `dir` is any directory in the repo that owns the foundations — a worktree is fine,
 * `mainCheckout` resolves it. Reads are tolerant by design: a repo that has never
 * had an amendment has no ref, which is not an error, it is the common case.
 */
export async function effective(dir, agent) {
  const base = baseline(agent);
  let main;
  try {
    main = await mainCheckout(dir);
  } catch {
    // Not a git repo, or git is unavailable. The baseline is still a complete
    // definition, and refusing to start an agent because its *amendment history*
    // could not be read would be the wrong failure.
    return merge(base, null);
  }
  const raw = await readRefFile(main, FOUNDATION_REF, overlayFile(agent));
  if (!raw) return merge(base, null);
  try {
    return merge(base, JSON.parse(raw));
  } catch {
    return merge(base, null);
  }
}

/** Every agent's effective foundation, for the amendment UI. */
export async function all(dir) {
  let main = null;
  try {
    main = await mainCheckout(dir);
  } catch {
    /* baselines only */
  }
  const stored = main ? await overlays(main) : {};
  return AGENTS.map((agent) => merge(baseline(agent), stored[agent] || null));
}

/**
 * Config that belongs to the deployment rather than to the agent.
 *
 * The model and the permission mode are settings Adam changes in config.json without
 * anyone filing anything, so they are not amendments — but an amendment that *does*
 * set them has been approved specifically and must win. Hence the order: baseline,
 * then config, then the amendment on top.
 */
export function withConfig(foundation, cfg = {}) {
  const f = { ...foundation };
  const amended = new Set(f.amended || []);
  if (!amended.has('model') && f.id === 'console' && cfg.consoleModel) f.model = cfg.consoleModel;
  if (!amended.has('timeoutMs') && f.id === 'console' && cfg.consoleTimeoutMs != null) {
    f.timeoutMs = cfg.consoleTimeoutMs;
  }
  return f;
}

/* ------------------------------------------------------------- amending it */

function validate(patch) {
  const bad = Object.keys(patch).filter((k) => !AMENDABLE.includes(k));
  if (bad.length) {
    // Rejected rather than filtered. Silently dropping half a request would apply an
    // amendment Adam did not approve — he approved the whole of what he read.
    throw new Error(`not amendable: ${bad.join(', ')} (amendable: ${AMENDABLE.join(', ')})`);
  }
  return patch;
}

const stamp = () => new Date().toISOString();

/**
 * Apply an approved amendment.
 *
 * The justification is the commit message, not a field, because the message is what
 * `git log` shows and the whole point of storing this in git is that the history
 * reads as an argument someone made and someone else accepted.
 *
 * Returns the new effective foundation, so the caller can re-seed the agent from
 * exactly what was committed rather than from what it believed it was committing.
 */
export async function amend(dir, agent, patch, { bead = null, justification = '', by = ownerName() } = {}) {
  baseline(agent); // throws on an unknown agent before anything is written
  validate(patch);
  const main = await mainCheckout(dir);

  const tip = await refTip(main, FOUNDATION_REF);
  const stored = await overlays(main);
  const prior = stored[agent] || { set: {}, amendments: [] };

  const next = {
    agent,
    set: { ...prior.set, ...patch },
    amendments: [
      ...(prior.amendments || []),
      { at: stamp(), bead, by, fields: Object.keys(patch), justification, outcome: 'approved' },
    ],
  };
  stored[agent] = next;

  const entries = Object.entries(stored).map(([name, overlay]) => [
    overlayFile(name),
    Buffer.from(JSON.stringify(overlay, null, 2) + '\n'),
  ]);
  const tree = await writeTree(main, entries);

  const message = [
    `${agent}: amend ${Object.keys(patch).join(', ')}${bead ? ` (${bead})` : ''}`,
    '',
    justification || '(no justification recorded)',
    '',
    `approved by ${by}`,
  ].join('\n');

  await commitToRef(main, FOUNDATION_REF, tree, message, { expect: tip });
  return effective(dir, agent);
}

/**
 * Record a refusal, so the same request cannot arrive every session forever.
 *
 * This is the half that is easy to skip and expensive to have skipped. A declined
 * request that leaves no trace is a request the agent has every reason to file again
 * next week, having reasoned its way to the same conclusion from the same starting
 * point — and the channel Adam reads fills with arguments he has already had. So the
 * refusal is stored beside the amendments and seeded back in, which turns "no" into
 * something the agent knows rather than something only Adam remembers.
 */
export async function decline(dir, agent, { bead = null, request = '', reason = '', by = ownerName() } = {}) {
  baseline(agent);
  const main = await mainCheckout(dir);

  const tip = await refTip(main, FOUNDATION_REF);
  const stored = await overlays(main);
  const prior = stored[agent] || { set: {}, amendments: [] };
  stored[agent] = {
    agent,
    set: prior.set || {},
    amendments: [
      ...(prior.amendments || []),
      { at: stamp(), bead, by, request, reason, outcome: 'declined' },
    ],
  };

  const entries = Object.entries(stored).map(([name, overlay]) => [
    overlayFile(name),
    Buffer.from(JSON.stringify(overlay, null, 2) + '\n'),
  ]);
  const tree = await writeTree(main, entries);

  const message = [
    `${agent}: decline${bead ? ` ${bead}` : ''}`,
    '',
    request ? `requested: ${request}` : '',
    reason || '(no reason recorded)',
    '',
    `declined by ${by}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  await commitToRef(main, FOUNDATION_REF, tree, message, { expect: tip });
  return effective(dir, agent);
}

/** Requests already refused for this agent, newest first — for the seed. */
export async function declined(dir, agent) {
  const f = await effective(dir, agent);
  return (f.amendments || []).filter((a) => a.outcome === 'declined').reverse();
}

/**
 * The amendment history as commits, newest first, each with its justification.
 *
 * **`agent` narrows it to one, and a screen about one agent has to pass it.** There is a
 * single ref for every agent's amendments — which is right, because the interesting
 * read is `git log refs/beadcause/foundations` as one story of what agents have been
 * allowed to become — and it means the unnarrowed list is everybody's. The agents
 * screen showed that list under each agent's own History tab, so the worker's history
 * was one declined request the *dispatch* agent had made: an amendment attributed, on
 * screen, to an agent that never asked for it.
 *
 * The subject is the filter because both writers build it the same way — `<agent>:
 * amend …` and `<agent>: decline …` — and it is what `git log --oneline` on that ref
 * shows, so what the screen selects on is what a person at a terminal would select on.
 * The window widens when narrowing, so one agent's older amendments are not pushed out
 * of `limit` by another's newer ones.
 */
export async function history(dir, { limit = 50, agent = null } = {}) {
  let main;
  try {
    main = await mainCheckout(dir);
  } catch {
    return [];
  }
  const commits = await refHistory(main, FOUNDATION_REF, { limit: agent ? Math.max(limit * 5, 100) : limit });
  const mine = agent ? commits.filter((c) => String(c.subject || '').startsWith(`${agent}: `)) : commits;
  const out = [];
  for (const c of mine.slice(0, limit)) out.push({ ...c, message: await readMessage(main, c.commit) });
  return out;
}

/* -------------------------------------------------------------- spawning it */

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The `claude` flags a foundation implies.
 *
 * Quoted for a shell because every agent here is spawned through `/bin/zsh -lc` —
 * `~/.zshenv` derives BEADS_DIR, BEADS_ACTOR and CLAUDE_CONFIG_DIR from `$PWD`, so
 * the login shell is not incidental, it is what decides which tracker the agent
 * reads and which account it bills. See the note in lib/dispatch.js.
 *
 * `systemFile` is passed in rather than written here: the caller already manages a
 * temp file's lifetime for the prompt, and a second owner of a second temp file is
 * how one of them gets leaked.
 *
 * `addDirs` is the other half of *where* an agent runs, and it is per run rather than
 * per foundation on purpose. A working directory is one path and `cwd` already carries
 * it; a workspace holding forty checkouts (lib/repos.js) means the read-only advocate's
 * survey is about all of them, and `claude` refuses a read outside its working
 * directory unless the directory was named on the command line. So the caller — which
 * is the one thing that knows how many repos this workspace turned out to have —
 * passes the rest, and every single-repo workspace passes none and pays nothing.
 *
 * It widens what an agent may *read*, never what it may do: the allowlist above is
 * still the whole of that, and an agent whose foundation cannot write is one that
 * cannot write in forty directories rather than one.
 */
export function claudeArgs(foundation, { systemFile = null, addDirs = [] } = {}) {
  const args = [];
  if (foundation.tools?.length) args.push('--tools', shq(foundation.tools.join(',')));
  if (foundation.allowedTools?.length) args.push('--allowedTools', foundation.allowedTools.map(shq).join(' '));
  // Repeated rather than comma-joined, and repeated rather than `--add-dir a b` even
  // though the flag is variadic (`--add-dir <directories...>`). Commander concatenates
  // repeated occurrences of a variadic option — measured, `--add-dir /a --add-dir /b`
  // arrives as `["/a","/b"]` — so this form is right today and stays right if the
  // signature ever narrows to one path, which the variadic form would not.
  for (const d of addDirs) if (d) args.push('--add-dir', shq(d));
  if (systemFile) args.push('--append-system-prompt-file', shq(systemFile));
  if (foundation.model) args.push('--model', shq(foundation.model));
  return args;
}

/**
 * The prompt, and the `--` that is the whole reason this is a function.
 *
 * `claude`'s prompt is a **positional** argument — `-p/--print` is a boolean flag and
 * takes no value, so `claude -p "$P"` is not "the prompt of -p", it is an operand
 * sitting in argv. Which means that if the first character of `$P` is `-`, the option
 * parser reads it as an option, finds no such option, and exits 1 having done nothing:
 *
 *     $ claude -p "-hello there"
 *     error: unknown option '-hello there'
 *
 * That is bc-i4sa. A chat message beginning with "- ", "--" or "-p" is the whole prompt
 * on a follow-up turn, so the turn died and lib/console.js reported the last line of
 * stderr — which is the argument echoed back. The app appeared to quote you at you.
 *
 * `--` ends option parsing (POSIX Utility Syntax Guideline 10), so everything after it
 * is an operand whatever it starts with. Two things make this the fix rather than one
 * of the alternatives:
 *
 * - **It works where stdin cannot.** Two of the five call sites do not own the child's
 *   stdin: lib/session.js types its line into an interactive iTerm shell, and
 *   lib/terminal.js drives `claude` through `expect` on a pty. Feeding the prompt in
 *   on stdin would fix the three spawned agents and leave those two, and the *typed*
 *   one is the prompt most likely to lead with a dash.
 * - **A variadic flag no longer forces the ordering.** The prompt used to go *first*
 *   because `--tools <tools...>` and `--allowedTools <tools...>` are variadic and
 *   would swallow a trailing operand as one more tool name. `--` terminates a variadic
 *   option too, so the prompt is safe last — measured, not assumed:
 *   `claude -p --allowedTools Read Edit --model haiku -- "-hello"` runs the prompt.
 *   Hence the prompt goes last at every call site, and `--` immediately before it.
 *
 * Returned as an array so a call site cannot get the order wrong by concatenating in
 * the other direction, and defaulted to `"$P"` because every call site reads the
 * prompt out of a temp file into that shell variable.
 */
export function promptArgs(ref = '"$P"') {
  return ['--', ref];
}

/**
 * The system prompt text for a run: the amendable role, then the module's protocol.
 *
 * In that order deliberately. The protocol is the contract beadcause parses, it is
 * not amendable, and it goes last so that it is the most recent thing in context
 * when the agent writes the block that has to match it.
 */
export function systemPrompt(foundation, protocol = null) {
  return [foundation.role, protocol].filter(Boolean).join('\n\n');
}

/** This repo's own `bin/`, which is where `beadcause-memory` lives. */
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');

/**
 * The environment an agent is spawned into — and the two things in it it cannot lie
 * about.
 *
 * `env` has been an amendable field with no reader since foundations existed; this
 * is that reader. Two keys are set *after* it and so cannot be amended away:
 *
 * - **`BEADCAUSE_AGENT`** is who the agent is, and it is how `beadcause-memory`
 *   knows whose memory to write without the agent naming itself. An agent that could
 *   set this could write into another agent's memory, and the write would look
 *   exactly like the other agent having written it. So it is stamped by the spawner,
 *   which is the only party that actually knows.
 * - **`PATH`** is prefixed with this repo's `bin/` so `beadcause-memory` resolves
 *   without a global `npm link`. An allowlist entry of `Bash(beadcause-memory:*)`
 *   matches the command as typed, so the command has to be reachable by that name;
 *   an absolute path in the allowlist would bake this checkout's location into every
 *   agent's foundation.
 *
 * It is the *foundation's* id, not the roster name the user picked: `answerer` and
 * `critic` share the dispatch foundation, so they share what dispatch has learned.
 * Memory belongs to the thing that has a definition, which is the same boundary the
 * amendment loop draws.
 *
 * A third key is stamped for a different reason, and it is a *scrub*: `LOADED_ENV` is
 * emptied rather than inherited. See `AGENT_LAUNCHD_SCRUB` below — the argument is the
 * same on both sides, and this is the side where `...process.env` is what carries it in.
 */
export function agentEnv(foundation, extra = {}) {
  return {
    ...process.env,
    [LOADED_ENV]: '',
    ...(foundation.env || {}),
    ...extra,
    BEADCAUSE_AGENT: foundation.id,
    PATH: `${BIN}:${process.env.PATH || ''}`,
  };
}

/**
 * The one variable an agent has to be told it does *not* have.
 *
 * `launchdProgram()` (lib/service.js) treats a non-empty `BEADCAUSE_LAUNCHD_PROGRAM` as
 * authoritative, on the strength of an invariant that holds for the processes the router
 * spawns: the router writes it on every spawn, empty when it was not launchd that started
 * the router, so an inherited value can never be mistaken for a fact about this job.
 *
 * That invariant does not reach a terminal. iTerm.app was itself started downstream of the
 * router launchd runs, so the variable is in the *application's* environment, and every
 * window it opens carries it — including windows opened days later, in a different
 * checkout, for work that has nothing to do with that router. The comment beside
 * `agentExports` says a fresh login shell "inherits nothing from the daemon", which is
 * true of the daemon→osascript hop and not of the app osascript is talking to.
 *
 * So in a worker session the value is a fact about the terminal's ancestry, read as a fact
 * about whatever tree is underneath it. Two things it cost (bc-6sst, bc-nv25): a
 * `beadcause` server run by hand from a worktree reports its code not-reloaded and draws
 * HOT-SWAP IS NOT LIVE against a perfectly good install, because the worktree's router
 * path is not the main checkout's; and test/service.mjs went red in every session an
 * advocate opened, which the suite now scrubs for itself.
 *
 * Empty is not "unset" here, it is the positive statement — `launchdProgram()` reads `''`
 * as *the spawner says nobody's launchd job*, which is exactly true of a shell in a
 * terminal window and of an agent the daemon spawned. Neither is a backend serving the
 * app, which is the only thing the variable was ever about.
 *
 * It goes *before* the foundation's own `env` rather than after, unlike `BEADCAUSE_AGENT`:
 * this is a scrub of something inherited, not a claim the agent must not be able to make,
 * and an amendment that deliberately sets it should still win.
 */
const AGENT_LAUNCHD_SCRUB = [LOADED_ENV, ''];

/** A shell variable name. Anything else is a statement wearing an assignment's clothes. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The same environment, for the agent that is not spawned as a child process.
 *
 * `agentEnv` hands `spawn` an object, which is the whole story for the three agents the
 * daemon runs itself. The worker is not one of them: its command is typed into an iTerm
 * window by `scripts/open-session.applescript`, and what iTerm starts is a **fresh login
 * shell that inherits nothing from the daemon**. An env object passed to `osascript`
 * reaches osascript and stops there. So the exports have to be *in the command string*,
 * and this is that string — the same four decisions as `agentEnv`, rendered for a shell
 * instead of for `execve`:
 *
 * - **`BEADCAUSE_LAUNCHD_PROGRAM` emptied first of all**, because a login shell inherits
 *   nothing from *the daemon* and rather a lot from *iTerm.app* — see
 *   `AGENT_LAUNCHD_SCRUB` above, which is where that argument lives.
 * - **The foundation's own `env` next**, so an amendment can set what it likes.
 * - **`BEADCAUSE_AGENT` after it**, for the reason it is stamped last above: an agent
 *   that could set this could write into another agent's memory, and the write would
 *   look exactly like the other agent having written it. A later `export` of the same
 *   name is what wins in a shell, which is the same rule as a later key in an object
 *   literal — so "last" means the same thing on both sides.
 * - **`PATH` prefixed with this repo's `bin/`**, so `beadcause-memory` resolves by the
 *   name it is typed as. `"$PATH"` and not the daemon's copy of it: by the time this
 *   runs the login shell has built its own, and overwriting that with whatever launchd
 *   handed the daemon would be a strictly worse PATH than the one the user configured.
 *
 * A key that is not a shell variable name is dropped with a line in the log rather than
 * emitted. `env` is amendable, and while every *value* here is quoted, a *key* is not:
 * `{'X; rm -rf ~': '1'}` renders as a command rather than an assignment. Approval is not
 * the place to catch that — on the screen where it is approved it does not look like
 * anything.
 */
export function agentExports(foundation, extra = {}) {
  const pairs = [AGENT_LAUNCHD_SCRUB, ...Object.entries(foundation.env || {}), ...Object.entries(extra)].filter(([k]) => {
    if (ENV_NAME.test(k)) return true;
    console.error(`[beadcause] ${foundation.id}: dropping env key ${JSON.stringify(k)} — not a variable name`);
    return false;
  });
  pairs.push(['BEADCAUSE_AGENT', foundation.id]);
  const out = pairs.map(([k, v]) => `export ${k}=${shq(v)}`);
  out.push(`export PATH=${shq(BIN)}:"$PATH"`);
  return out.join(' && ');
}
