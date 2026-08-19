/**
 * Every body of data this system holds or ships, and the five answers an auditor wants.
 *
 * ISO/IEC 42001 Annex A.7 asks the same five questions of each: **where it came from,
 * what it is used for, whether it is adequate for that use, who can reach it, and when
 * it is disposed of.** Three of the registers this programme has already produced answer
 * a *different* question each and none of them answers those five:
 *
 * - `lib/evidence.js` is keyed on **what is kept as evidence** — retention, integrity,
 *   and who could alter it. It is a *write* model. It says nothing about where a record's
 *   contents came from, and its `alterableBy` is deliberately not a read rule.
 * - `lib/access.js` is keyed on **principals** — the grants that let a human, a device or
 *   an agent reach the system at all. It answers "who can sign in", not "who can read
 *   this particular store", and for the stores below the honest answer to the second is
 *   usually *every agent, by design*, which no principal row says.
 * - `lib/suppliers.js` is keyed on **third parties** — what leaves and under whose terms.
 *   It is the egress model and stops at the boundary.
 *
 * This file is the fourth axis and deliberately not a fourth format: it **cites** the
 * other three rather than restating them, and `coverageProblems` fails the repo when a
 * citation is wrong, when an evidence class is not classified here at all, or when this
 * register and the evidence register disagree about how long one store lives. Two
 * documents disagreeing about a retention period is worse than either answer, and it is
 * the failure a fourth register would otherwise produce on its first day.
 *
 * ## The finding this file exists to write down: personal data is not where you look
 *
 * The instinct on a single-operator install is to record that there is no personal data
 * in it. That is false in four separate places and an auditor finds the one you did not
 * look at:
 *
 * - **A bead can name a person.** A title says who asked, a comment quotes a colleague,
 *   an ingested JIRA ticket carries a reporter and often a customer, and a close reason
 *   quotes either. This is the largest concentration of it and it is in the *tracker*,
 *   which is not beadcause's own store — which is precisely why it was not in any
 *   register until this one.
 * - **A screenshot carries whatever was on the screen.** A session that takes one has no
 *   idea what else was in the window, and it goes to a supplier as prompt content.
 * - **An agent memory is written by an agent about a person.** "How Adam likes a thing
 *   shaped" is a memory this system is designed to keep, it is a statement about an
 *   identified individual, and it is readable by every other agent by design.
 * - **The git identity is on every commit in every chained ref.** Name and email address,
 *   in `session-transcripts`, `merge-notes`, the memory refs and the archive chain alike.
 *   It is the one category that is genuinely in all of them, so it is said once here
 *   rather than repeated into fifteen `personal` fields that would then have to agree.
 *
 * So `personal.state` is a closed vocabulary of three and `none` is not a blank: an entry
 * claiming a store holds no personal data has to say *why* it does not, in a sentence, and
 * the sentence is what a reviewer argues with.
 *
 * ## Why so much of this says `permanent`, and why that is a decision
 *
 * `lib/evidence.js` already refuses a retention shorter than two years and most of the
 * chained refs say `permanent` because **the disposal unit of a hash chain is the whole
 * ref** — removing the middle rewrites every sha after it, which is the property the chain
 * exists for. `bc-eqn1.7` found the one way out of that and it is a *split*: the record is
 * chained and permanent, the body is a file beside it and is deleted at 24 months, and the
 * deletion is itself a commit on the chain. That is available only where the two halves can
 * be separated.
 *
 * They cannot be separated for a memory. A memory *is* its body — there is nothing left of
 * "the advocate believed this" once the belief is removed — so the choice is genuinely
 * between keeping it and keeping nothing. It is kept, and the argument is written into the
 * entry rather than left as an omission: its purpose is reconstructing what an agent was
 * operating on the belief of at the time it acted, that belief explains a session
 * transcript, and the transcripts are permanent. A memory disposed of at two years would
 * leave the transcripts it explains unexplained for the rest of their lives.
 *
 * **What makes that a decision rather than a default is the other four answers.** A store
 * that never forgets is governed by what may be put in it and who may read it, not by a
 * sweep — so every entry below states its read rule outright, `agent-memory` states what
 * must never be written there, and disposal is a *deliberate act against a named bead*,
 * which is the same path `session-transcripts` already has.
 *
 * ## The confidentiality control, stated as one
 *
 * `CONTENTLESS_PUSH` is the one place in this file that is not a description. The
 * behaviour has been in `lib/notify.js` since long before this programme: a workspace in
 * `ntfy.minimalWorkspaces`, or in a space set to `ntfyDetail: "minimal"`, gets a
 * notification with no question text, no option labels, no reply and no buttons — a nudge
 * you tap through to the tailnet. It exists because an `ntfy.sh` topic is a shared secret
 * on a public relay and anybody who guesses the name receives the messages.
 *
 * A feature becomes a control when something fails if it stops working. `test/datastores.mjs`
 * drives **every** exported `push*` in `lib/notify.js` against a minimal workspace with
 * loaded fixtures and asserts the published body carries none of the text — and drives the
 * same call against a `full` workspace to prove the fixture was loaded, because a test that
 * passes against a function which sends nothing is a test of nothing. The list of pushers is
 * checked against the module's own exports, so a new notification cannot ship without being
 * covered.
 *
 * And it states the limit rather than overclaiming it, which is the half a description
 * leaves out: the deep link **must** name the workspace and the bead — that is what the tap
 * lands on — and the tailnet hostname is in every push regardless. So minimal removes the
 * *content* and not the *fact* that a question exists in a named repo. `LINK_ONLY` below is
 * that limit written as a rule, and the suite fails if a bead id ever migrates from the
 * click URL into a title or a message.
 *
 * A leaf, like `lib/evidence.js` and `lib/documents.js`: it imports the two registers it
 * cites and nothing else, reads no state and writes none, so a check, a report and a screen
 * can each hold it. `lib/access.js` is the one neighbour that is not a leaf — it reads the
 * live allowlist and the live device rows, because "who can sign in" is a fact about a file
 * — which is also why the read rules below are stated per store here rather than derived
 * from there.
 */
import { REGISTER as EVIDENCE, RETENTION_FLOOR_MONTHS } from './evidence.js';
import { REGISTER as SUPPLIERS } from './suppliers.js';

/**
 * What a store's `personal` answer may be.
 *
 * Three rather than two, because `possible` is the true answer for most of them and
 * rounding it either way is the failure. A session transcript does not *set out* to record
 * a person and quotes whatever the bead said; calling that `none` is a claim nobody
 * checked, and calling it `present` would put every transcript on a list that then means
 * nothing. `possible` is the answer that survives being read by somebody who disagrees.
 */
export const PERSONAL_STATES = Object.freeze(['present', 'possible', 'none']);

/** What a retention answer may be, other than a whole number of months. */
export const RETENTION_WORDS = Object.freeze(['permanent', 'external']);

/**
 * The personal data that is in every one of them, said once.
 *
 * Repeating this into fifteen `personal` fields would produce fifteen sentences that have
 * to be kept agreeing with each other, and the first one to drift would be the one an
 * auditor read. It is a property of using git for the records rather than of any store.
 */
export const UBIQUITOUS_PERSONAL =
  'The git identity — a name and an email address — is the author of every commit in every ' +
  'ref below, and of every commit in this repo. It is personal data, it is in all of them, ' +
  'and it is not disposable without destroying the record it authenticates.';

/* ------------------------------------------------------------------ the register */

/**
 * Every body of data, ordered by how much of it there is and how sensitive it is.
 *
 * `evidence` cites `lib/evidence.js` by id where the store is also an evidence class, and
 * is `null` where it is not — bead content and prompt context are the two, and they are not
 * omissions from that register but things it is not about: one belongs to the tracker and
 * the other has already left. `suppliers` cites `lib/suppliers.js` by id for every third
 * party the store can reach. Both citations are checked.
 */
export const REGISTER = Object.freeze([
  {
    id: 'bead-content',
    title: 'Bead content — titles, descriptions, comments, answers and close reasons',
    holds:
      'The whole text of the work: what a bead asks, what an agent commented, what was answered from a phone, ' +
      'the reason a bead was closed, and any JIRA ticket ingested into one.',
    where: Object.freeze([
      'the workspace tracker itself — an embedded Dolt database under each workspace\'s `.beads/`',
      '`.beads/issues.jsonl` in a repo that keeps its workspace inside the checkout, as an auto-exported mirror',
      'a shared workspace also rides `refs/dolt/data` in the private repository the team clones',
    ]),
    provenance:
      'Three authors and they are not equivalent. A person writes a bead or an answer; an agent writes a comment, a ' +
      'close reason and most of the descriptions in a planned subtree; and `lib/jiraingest.js` copies a third party\'s ' +
      'ticket in wholesale. The third is the one that carries data nobody here composed.',
    purpose:
      'The work itself — what is to be done, what was decided and why. Every other store below is about a run; this is ' +
      'the thing the runs are about, and it is the input a brief is generated from.',
    adequacy:
      'Adequate for deciding and recording work, which is what it is for. Not adequate as a system of record for anything ' +
      'else, and specifically not for anything about a person: a bead names whoever the writer happened to name, with no ' +
      'field for it, no rule about it and nothing that would notice.',
    personal: Object.freeze({
      state: 'present',
      what:
        'The largest concentration of it in the system. A title or comment can name a colleague; an ingested JIRA ticket ' +
        'carries its reporter and assignee and frequently a customer; a close reason quotes whichever of those the agent ' +
        'was reading. It arrives without being asked for, which is why it is stated as present rather than possible.',
    }),
    access:
      'Anybody with the tracker. A personal workspace is a directory on this Mac; a shared one is a private repository, ' +
      'so every person with access to that repository can read every bead in it — which is the point of sharing it and ' +
      'is also the reason a shared workspace is the case `CONTENTLESS_PUSH` exists for.',
    retention: 'external',
    disposal:
      'Not this system\'s decision to make and it must not pretend otherwise. The tracker is the operator\'s, and for a ' +
      'shared workspace the history is a Dolt history in somebody else\'s repository — deleting a bead here leaves it in ' +
      'that history and on every clone. What beadcause can say is that it disposes of nothing and adds nothing beyond ' +
      'what an agent wrote, and that a bead is the right place to raise a deletion because it is the only store below ' +
      'with a person in front of it.',
    evidence: null,
    suppliers: Object.freeze(['github', 'atlassian', 'anthropic']),
    gap: null,
  },
  {
    id: 'prompt-context',
    title: 'Prompt context — what is shipped to the model on the way past',
    holds:
      'Everything an agent is given or gathers: the generated brief, bead text, the contents of any repository file it ' +
      'reads, the output of any command it runs, and a screenshot when a session takes one.',
    where: Object.freeze([
      'nowhere on this Mac as a store of its own — it is assembled per call and passed to a `claude -p` subprocess',
      'whatever the supplier retains of a conversation, which is the supplier register\'s open question',
      'the run log and the session transcript keep what the agent *said*, never the context it was given',
    ]),
    provenance:
      'This machine, and that is the whole of the concern. A file read is a file on this disk, a command output is this ' +
      'shell, and a screenshot is this screen — none of them chosen by the person whose data may be in them, and none of ' +
      'them reviewed before it leaves.',
    purpose:
      'Running the agent. There is no other model and no other channel: every worker, advocate, planner, chat session and ' +
      'ingest is a subprocess, so this is the largest egress in the system by a wide margin and the one with no URL in it.',
    adequacy:
      'Adequate for the task and deliberately over-broad for it — an agent is handed a repository rather than a curated ' +
      'extract, because narrowing it is what produces confidently wrong work. The cost of that trade is exactly this ' +
      'entry, and pretending the trade was not made would be the dishonest version.',
    personal: Object.freeze({
      state: 'present',
      what:
        'A screenshot carries whatever was on the screen, including a window nobody meant to capture. A file read can be ' +
        'anything in the checkout. Bead text brings its own, per the entry above. This is the store where personal data is ' +
        'least bounded and least visible, because it never lands anywhere somebody could go and look at it.',
    }),
    access:
      'The subprocess, and the supplier behind it. Nothing on this Mac can read it back — there is no store to read — so ' +
      'the read rule that matters is the supplier\'s, and it is the line `lib/suppliers.js` records as unconfirmed.',
    retention: 'external',
    disposal:
      'Governed entirely by the supplier\'s retention schedule and by which account and plan the sessions run under, ' +
      'neither of which this repo can read. `lib/suppliers.js` records that as the single most consequential unconfirmed ' +
      'line in the whole programme and `bc-eqn1.17` is where it is read and transcribed. Nothing here should state a ' +
      'period, because a period invented on this side would read exactly like one somebody had confirmed.',
    evidence: null,
    suppliers: Object.freeze(['anthropic']),
    gap: Object.freeze({
      bead: 'bc-eqn1.17',
      says:
        'What the supplier retains of a conversation, and for how long, has not been read against the account these ' +
        'sessions actually run under. Everything above about what is sent is verifiable from the code; what happens to it ' +
        'afterwards is not.',
    }),
  },
  {
    id: 'agent-memory',
    title: 'Agent memory — what an agent has learned, anywhere',
    holds: 'One document per agent kind of what that kind knows for good, across every repo it has ever worked in.',
    where: Object.freeze(['refs/beadcause/memory — in the common repo, ~/.config/beadcause']),
    provenance:
      'Written by agents, about their own work, with no review step between the writing and the next agent reading it. ' +
      'That is the property that makes it useful and the one that makes it a governance question: it is the only store ' +
      'here whose contents are both authored and consumed by the system itself.',
    purpose:
      'Carrying a lesson from one run into the next. It is also, after the fact, the answer to what an agent was ' +
      'operating on the belief of at the time it acted — which is what makes it a record rather than a cache.',
    adequacy:
      'Adequate as supporting context and explicitly not as a control record: `lib/evidence.js` says so of the same store, ' +
      'and the primary records are the bead and the session transcript. An agent-authored belief is evidence of what was ' +
      'believed and never of what was true, and anything read out of here is held to that.',
    personal: Object.freeze({
      state: 'present',
      what:
        'By design. A memory about how the operator likes work shaped is a statement about an identified individual, it is ' +
        'exactly the kind of thing this store exists to keep, and every agent kind can read it. What must never be written ' +
        'here is anything about a third party, any credential, and any customer detail lifted out of a ticket — that is the ' +
        'actual control on a store that never forgets, and it is a rule for the writers rather than a sweep.',
    }),
    access:
      'Every agent kind, by design, and that is a stated rule rather than a missing one. `recall --of=<kind>` reads any ' +
      'other kind\'s memory and there is no private half; writes are always as the writer. So the correct summary is that ' +
      'anything written here is readable by every agent this install ever runs, and the memory brief says so to each of them.',
    retention: 'permanent',
    disposal:
      'None on a schedule, and the reason is that a memory cannot be split the way `bc-eqn1.7` split the run archive: the ' +
      'body *is* the record, so disposing of it leaves nothing that says a belief was ever held. It also explains session ' +
      'transcripts that are themselves permanent, and a two-year sweep would leave the longer-lived record unexplained. ' +
      'The disposal path is therefore the same one `session-transcripts` has — a deliberate act against a named bead, ' +
      'rewriting the ref, rather than a sweep — and the governing control is the write rule above.',
    evidence: 'agent-memory',
    suppliers: Object.freeze(['anthropic']),
    gap: Object.freeze({
      bead: 'bc-eqn1.20',
      says:
        'The write rule above is the whole of what governs a store that is never disposed of, and today it is prose in ' +
        'this entry and in the brief every agent is handed. Nothing refuses a write carrying a credential. That is the ' +
        'one gap in this entry and it is the load-bearing one, because the argument for permanence rests on it.',
    }),
  },
  {
    id: 'agent-notes',
    title: 'Agent notes — what an agent knows about one repository',
    holds: 'One document per agent kind per checkout: how this codebase is put together, where its traps are, how its tests are really run.',
    where: Object.freeze(['refs/beadcause/agents/<kind> — in the checkout the note is about']),
    provenance:
      'The same authorship as the memory above and a different scope, which is the whole reason the two stores are ' +
      'separate: a repo fact stored as a general memory is advice an agent will follow somewhere it is false.',
    purpose:
      'Not re-deriving what a previous session in this repository already paid for. It is the store the brief draws on ' +
      'most heavily, and `lib/memoryuse.js` appends a line every time any of these four stores is read back — which is ' +
      'the only thing that can say whether any of it is ever opened, since a ref cannot record having been looked at.',
    adequacy:
      'Adequate for orientation and stale by construction — a note describing a file that has since been rewritten reads ' +
      'exactly as confidently as one that is still true. The brief says outright that a note is evidence rather than an ' +
      'instruction and that anything load-bearing has to be checked against the code, which is the mitigation and is a ' +
      'weaker one than a date would be.',
    personal: Object.freeze({
      state: 'possible',
      what:
        'It is about code and mostly contains none. It can name a person incidentally — who owns a subsystem, whose ' +
        'convention a file follows — and nothing distinguishes that from the rest of the sentence it is in.',
    }),
    access:
      'Every agent kind, exactly as above, and additionally scoped by the checkout: a note lives on a ref in the repository ' +
      'it is about, so it is readable by anybody with that repository and travels with a clone of it. That is a wider ' +
      'audience than the memory ref for a shared repo and a narrower one for a personal Mac.',
    retention: 'permanent',
    disposal:
      'None on a schedule, for the reason `agent-memory` gives. The one difference worth stating is that these die with ' +
      'their repository rather than outliving it: a note is on a ref in that checkout, so a repository nobody clones ' +
      'again is a store that is gone without anybody deciding it should be.',
    evidence: 'agent-memory',
    suppliers: Object.freeze(['anthropic', 'github']),
    gap: null,
  },
  {
    id: 'agent-bus',
    title: 'The bus — what one agent told the others',
    holds: 'Messages on a topic, one commit each: what an agent wanted a different kind of agent to know.',
    where: Object.freeze(['refs/beadcause/bus/<topic> — in the common repo, ~/.config/beadcause']),
    provenance: 'An agent, addressing other agents rather than a person, with no reader guaranteed and none required.',
    purpose:
      'The one channel between agent kinds that is not a bead. Read with a window — `read <topic> --since=N` — which is ' +
      'the shape of a feed and not of an archive, and it is worth noticing that the *reading* is already bounded even ' +
      'though the storing is not.',
    adequacy:
      'Adequate as a nudge and inadequate as anything with a work item in it, which is a rule the brief states to every ' +
      'agent: a message here is not tracked, not assigned and not closed. The failure mode is a real task posted as chatter ' +
      'and read by nobody, and nothing detects it.',
    personal: Object.freeze({
      state: 'possible',
      what:
        'A message is free text written by an agent and can quote a bead, which brings whatever that bead named. Small in ' +
        'volume and unbounded in content, which is the worst pair to have to reason about.',
    }),
    access: 'Every agent kind, on this Mac. The refs are in the common repo, so nothing off this machine reads them unless the machine is copied.',
    retention: 'permanent',
    disposal:
      'None today, and this is the store where a period would be easiest to justify — the read path is already a window, ' +
      'so nothing would notice a topic being truncated behind it. It is not truncated because the ref is the record of ' +
      'what an agent was told before it acted, and that is worth more than the disk. Registered as the honest candidate ' +
      'for the first real sweep if the volume ever argues for one.',
    evidence: 'agent-memory',
    suppliers: Object.freeze(['anthropic']),
    gap: null,
  },
  {
    id: 'agent-debriefs',
    title: 'Debriefs — how one run at one bead actually went',
    holds: 'A report per run, filed against the bead it was working: what was hit, what was ruled out, where it stopped.',
    where: Object.freeze([
      'refs/beadcause/debrief/<bead> — staged only, for the few minutes between writing and the session being archived',
      'refs/beadcause/sessions/<bead>, as `memory.md` in the session\'s own tree, which is where it lands',
    ]),
    provenance: 'The agent that just did the work, writing at the end of its own run, about that run.',
    purpose:
      'The first thing the next session at the same bead is handed. It is a report and not a rule — it does not have to ' +
      'still be true next week, which is exactly what neither of the two stores above can hold.',
    adequacy:
      'Adequate and self-limiting: it is explicitly an account of one run rather than a standing claim, so a stale one ' +
      'misleads far less than a stale note does. The brief tells the reader as much before quoting one.',
    personal: Object.freeze({
      state: 'possible',
      what: 'A narrative of a run, quoting whatever the bead and the code said. The same unbounded-content answer as the bus, at more length.',
    }),
    access: 'Every agent kind, through the same reader, and anybody with the checkout the session ref lives in.',
    retention: 'permanent',
    disposal:
      'The staging ref *is* disposed of, and it is the one place in this family where something is actually deleted: ' +
      '`archiveSession` consumes `refs/beadcause/debrief/<bead>` and drops it once the text is in the session tree. So the ' +
      'transient location has a real lifecycle and the durable one inherits `session-transcripts` — permanent, disposed of ' +
      'only as a deliberate act against a named bead. A staged debrief left behind by a crashed run is the exception worth ' +
      'knowing about, and `for-each-ref refs/beadcause/debrief` is how you find one.',
    evidence: 'agent-memory',
    suppliers: Object.freeze(['anthropic', 'github']),
    gap: null,
  },
  {
    id: 'agent-repos',
    title: 'Agent-owned repositories — whatever an agent chose to keep for itself',
    holds:
      'One git repository per agent kind with no schema and no format imposed on it, plus beadcause\'s own log of which ' +
      'memories a run was handed.',
    where: Object.freeze([
      '~/.config/beadcause/agents/<kind>/ — a git repository each, ignored by the common repo on purpose',
      '~/.config/beadcause/agents/memory-reads.jsonl — what was read, rather than what was written',
    ]),
    provenance:
      'The agent alone. Nothing in beadcause reads these, nothing prescribes what goes in them, and they have no remote — ' +
      'so what is in one is whatever an agent decided was worth keeping where nothing would ask it for anything.',
    purpose:
      'A place for an agent to keep what does not fit the four calls of the memory API. The read log beside it is the ' +
      'opposite direction and is beadcause\'s rather than any agent\'s: one line per read across all four memory stores, ' +
      'which is what makes a memory\'s influence on a run traceable at all.',
    adequacy:
      'Deliberately unconstrained, so adequacy is not assertable — that is the trade, and it is why nothing downstream ' +
      'depends on the contents. The read log is adequate for tracing influence and for nothing else; it records that a note ' +
      'was handed over, never that it was followed.',
    personal: Object.freeze({
      state: 'possible',
      what:
        'Unknown by construction, which is the honest answer and the uncomfortable one: a store with no schema and no ' +
        'reader cannot be characterised, only bounded. It is bounded by staying on this Mac and by having no remote.',
    }),
    access:
      'The owning agent kind writes it and every kind can read it, through `recall --of=`. It never leaves this Mac: no ' +
      'remote, and the common repo refuses to sweep a nested repository into the shared history.',
    retention: 'permanent',
    disposal:
      'None on a schedule, and the same argument as `agent-memory` with one addition: each of these is its own git ' +
      'history rather than part of the common repo\'s, so disposing of one is `rm -rf` on a directory and does not break ' +
      'any chain. That makes it the one store here that *could* be swept cheaply, and the reason it is not is that ' +
      'nothing can say what would be lost — see the entry\'s own admission above.',
    evidence: 'agent-owned-repos',
    suppliers: Object.freeze([]),
    gap: null,
  },
  {
    id: 'agent-run-logs',
    title: 'Agent run logs — what a run printed while it was running',
    holds: 'The streamed output of a dispatched run, line by line, and every prior run at the same bead archived before the live file is cleared.',
    where: Object.freeze([
      '~/.config/beadcause/logs/<workspace>_<bead>.log — the run in progress, cleared at the next dispatch',
      'refs/beadcause/agentlogs — one chained commit per archived run, carrying its provenance and the digest of the body',
      '~/.config/beadcause/agentlogs/<key>-<stamp>.log — the archived body, which is the half that is disposed of',
    ]),
    provenance:
      'The subprocess itself, taken rather than re-derived: the model comes from the call site that launched it, the ' +
      'foundation revision from the tip of the foundation ref at archive time, and the endorsement from the tracker row ' +
      'the dispatch already had. Nothing here recomputes any of the three, because a record that disagreed with the app ' +
      'about which model ran would be worse than no record.',
    purpose:
      'Watching a run on a phone while it happens, and reconstructing one afterwards — including the runs that failed, ' +
      'which are the ones an incident is actually reconstructed from and the ones that used to be destroyed at the next ' +
      'dispatch.',
    adequacy:
      'Adequate for both, and the split is what makes the second true over a period: a body that is gone reads as disposed ' +
      'of rather than as absent, because the disposal is a commit on the chain naming what it removed and the rule it ' +
      'removed it under.',
    personal: Object.freeze({
      state: 'possible',
      what:
        'A run log is whatever the agent printed, which includes bead text and file contents, so it inherits everything ' +
        'the two entries at the top of this register hold. It is the only store below with a real disposal schedule, which ' +
        'is also the only reason that inheritance is bounded in time.',
    }),
    access:
      'Anybody with the config directory, and the phone: a live log is tailed over the tailnet by whoever is signed in to ' +
      'the app. It is the one store here with a routine *human* reader, which is why the archived half being the disposable ' +
      'half matters.',
    retention: RETENTION_FLOOR_MONTHS,
    disposal:
      'Taken from `bc-eqn1.7` rather than restated: the body is deleted once it is older than the retention period, by an ' +
      'hourly sweep in the poll cycle, and the deletion is itself a commit on the chain. The record of the run is ' +
      'permanent because removing the middle of a chain breaks every sha after it — which is the whole reason the two ' +
      'halves are stored apart. This register must not state a different number, and `coverageProblems` fails if it does.',
    evidence: 'agent-run-logs',
    suppliers: Object.freeze([]),
    gap: null,
  },
  {
    id: 'session-transcripts',
    title: 'Session transcripts — every dispatched run, as it was written',
    holds: 'The brief a session was given, what it did, and what it said back — plus the debrief it filed on the way out.',
    where: Object.freeze(['refs/beadcause/sessions/<bead> — in the checkout the session ran in']),
    provenance:
      'Composed by beadcause from the run: the brief is generated here, the account is the agent\'s own words, and neither ' +
      'is edited afterwards. The generated half is the part that carries content from everywhere else — a brief quotes the ' +
      'bead, the notes and the debriefs.',
    purpose:
      'What changed a branch, on whose instruction, and under which agent kind. It is the primary control record for an ' +
      'unattended run and the thing every other store here is supporting context for.',
    adequacy: 'Adequate, and the one store whose adequacy is load-bearing: if this is wrong the change management claim is wrong.',
    personal: Object.freeze({
      state: 'possible',
      what:
        'A transcript quotes the bead it was working, so it carries whatever that bead named — and it is permanent, which ' +
        'makes it the longest-lived copy of anything a bead said about a person. Recorded here rather than in the evidence ' +
        'register because that register asks what may alter it, not what is in it.',
    }),
    access: 'Anybody with the checkout, which for a shared repository is everybody on it. Written by the daemon; there is no per-session secrecy.',
    retention: 'permanent',
    disposal:
      'None on a schedule — the disposal unit of a chained ref is the whole ref. Dropping one is a deliberate act against a ' +
      'named bead rather than a sweep, and it is the path a deletion request would have to take.',
    evidence: 'session-transcripts',
    suppliers: Object.freeze(['github', 'anthropic']),
    gap: null,
  },
  {
    id: 'audit-runs',
    title: 'Audit runs — what the audit agent read, and what it concluded was repeated work',
    holds:
      'One record per review of finished sessions: which archived sessions were read, which repeated shapes were found, which candidate beads were filed off them, and every finding that was refused with the reason.',
    where: Object.freeze(['refs/beadcause/audits — in the checkout whose sessions were read']),
    provenance:
      "Composed by beadcause from the run: the ids and the refusals are this repo's own bookkeeping, and the findings are " +
      "the agent's own words about sessions it was shown. It never copies the transcripts — it cites them by bead and by " +
      'commit, which is why it is small enough to keep forever.',
    purpose:
      'Why a bead exists, traced to the sessions that argued for it rather than to a person who asked for it — and the ' +
      'record that makes re-running the audit safe, since it is the only thing that says what has already been read.',
    adequacy:
      'Adequate for both questions it is asked: what has been audited, and what came of it. It is deliberately not evidence ' +
      'of what the sessions did — that is the transcripts, and this cites them rather than restating them.',
    personal: Object.freeze({
      state: 'possible',
      what:
        'A finding quotes what sessions did, so it can carry whatever those sessions named. The quantity is small and the ' +
        'subject is always the work rather than a person, but nothing prevents a quoted line naming one.',
    }),
    access: 'Anybody with the checkout, exactly as for the transcripts it cites. Written by the daemon.',
    retention: 'permanent',
    disposal:
      'None on a schedule, and here permanence is also the cheap answer: a run record is a few kilobytes of ids and ' +
      'sentences. The disposal unit of a chained ref is the whole ref, so dropping it is a deliberate act.',
    evidence: 'audit-runs',
    suppliers: Object.freeze(['anthropic']),
    gap: null,
  },
  {
    id: 'console-records',
    title: 'Consoles and terminals — attended work, as opposed to dispatched runs',
    holds: 'The chat consoles and ptys an operator opened against a repo, and what was said in them.',
    where: Object.freeze(['~/.config/beadcause/consoles/', '~/.config/beadcause/terminals/']),
    provenance:
      'A person and an agent in turn — the only store here whose contents were typed by a human in real time rather than ' +
      'generated, quoted or streamed.',
    purpose: 'The attended half of the record, alongside the transcripts covering the unattended runs.',
    adequacy:
      'Adequate for showing that attended work happened and what was said. Not a substitute for a bead: a decision reached ' +
      'in a console and never written to a bead is a decision nothing downstream can act on.',
    personal: Object.freeze({
      state: 'possible',
      what:
        'Free-form typing by a person, which is the least predictable input in the system. Reaped when the surface closes, ' +
        'but the common repo keeps the version behind it, so closing one is not a deletion.',
    }),
    access: 'Anybody with the config directory, and the daemon while the surface is live.',
    retention: RETENTION_FLOOR_MONTHS,
    disposal:
      'The file is reaped when the console or terminal closes; the versions behind it are in the common repo history, which ' +
      'nothing prunes. So the stated period is the floor and the practical answer is longer, which is worth saying plainly ' +
      'rather than leaving the two facts in different registers.',
    evidence: 'console-and-terminal-records',
    suppliers: Object.freeze(['anthropic']),
    gap: null,
  },
]);

/**
 * Evidence classes that are records of the system acting, rather than data it holds about
 * anything — with the sentence saying why, one each.
 *
 * Not a waiver list, and the same rule `NOT_EVIDENCE` sets for itself: the coverage check
 * below cannot tell the difference between a class nobody classified and a class somebody
 * decided about, so the cost of being out is having to write the reason. What every entry
 * here has in common is that its contents were composed by the daemon out of its own
 * actions — a commit sha, a criterion state, a config key, a dispatch decision — and the
 * only personal data in any of them is `UBIQUITOUS_PERSONAL`.
 */
export const NOT_SUBJECT = Object.freeze([
  {
    evidence: 'foundation-amendments',
    why: 'what an agent kind is permitted to be, and the approvals and refusals of changes to it. Its contents are a permission set and a decision, both composed here; the person in it is the approver, which the access register already covers as a grant.',
  },
  {
    evidence: 'election-history',
    why: 'which criteria this install elected to be held to, and when that changed. A declaration about the system by its operator, with no subject data in it at all.',
  },
  {
    evidence: 'publication-chain',
    why: 'chain heads, transitions and digests published to the control daemon — and, by construction, never the records they stand for. A digest of something is not the something.',
  },
  {
    evidence: 'management-transitions',
    why: 'whether the management system was on, and every time that changed, with the reason. A statement about the control layer rather than about anything it governs.',
  },
  {
    evidence: 'merge-notes',
    why: 'a few lines per commit and merge: which bead, which agent, what outcome, which requirement. It names beads rather than quoting them, so what a bead said stays in `bead-content` and in the transcript.',
  },
  {
    evidence: 'configuration-history',
    why: 'what the daemon was configured to do and when that changed. Credentials are refused entry to the common repo, so what is versioned is settings — and the accounts among them are the access register\'s subject, not this one\'s.',
  },
  {
    evidence: 'advocate-dispatch-state',
    why: 'which advocates exist, which are paused, and what each last dispatched. Bead ids and timestamps; the run it decided on is in the transcript.',
  },
  {
    evidence: 'deployment-record',
    why: 'what was shipped, from which commit, and whether the swap took. Shas, times and statuses.',
  },
]);

/* ------------------------------------------------ the control, rather than the feature */

/**
 * The contentless push, written as a control instead of as behaviour.
 *
 * Every field here is checked by `test/datastores.mjs` against the real modules, which is
 * what separates this from a paragraph: `decidedBy` and `enforcedIn` have to exist,
 * `pushers` has to be exactly the set of `push*` exports in `lib/notify.js`, and the two
 * text rules have to hold for every one of them.
 *
 * `NEVER` is the content — nothing on that list may appear anywhere in a minimal payload.
 * `LINK_ONLY` is the limit, and stating it is the point: the deep link has to name the
 * workspace and the bead or the tap has nothing to land on, so a minimal push conceals what
 * is being asked and not that something is being asked in a named repo. The tailnet
 * hostname is in every push regardless, and the notification's own priority still tracks
 * the bead's. An honest control says all three.
 */
export const CONTENTLESS_PUSH = Object.freeze({
  id: 'contentless-push',
  serves: 'ISO/IEC 42001 Annex A.7 and SOC 2 CC6 — confidentiality of what leaves this Mac for a channel other people can read.',
  because:
    'An ntfy.sh topic is a shared secret on a public relay rather than an account: anybody who guesses the name receives ' +
    'the messages. A workspace shared with other people therefore cannot have its questions pushed in full, and the ' +
    'default for one is a nudge you tap through to the tailnet.',
  configuredBy: Object.freeze(['ntfy.minimalWorkspaces', 'ntfy.detail', 'a space\'s own ntfyDetail']),
  decidedBy: Object.freeze({ module: 'lib/spaces.js', fn: 'ntfyDetailFor' }),
  enforcedIn: 'lib/notify.js',
  reportedBy: 'lib/team.js',
  /** What may never appear in a minimal payload, in any field. */
  NEVER: Object.freeze([
    'the question text or the bead title',
    'the labels or responses of any decision option',
    'an answer given previously, or an agent\'s reply',
    'the body of a foundation request or of a comment on one',
    'a deploy\'s error text, a landing\'s title, or the repo path a deploy ran in',
  ]),
  /** What a minimal payload may carry, and only in the deep link. */
  LINK_ONLY: Object.freeze([
    'the workspace name',
    'the bead id',
  ]),
  /** What minimal does not conceal, said rather than left to be discovered. */
  limits: Object.freeze([
    'the tailnet hostname, which is the click target of every push whether minimal or not',
    'that a decision is waiting at all, and roughly what kind it is — the tag and the sentence differ per pusher',
    'the notification priority, which still tracks the bead\'s priority for a question',
    'that a question has been asked before — `Beadcause · asked again` is the one permitted addition to a minimal title, and it is there because giving the same answer twice from a lock screen is a real failure while the fact of a repeat leaks nothing',
  ]),
});

/* -------------------------------------------------------------- what must hold */

const prose = (v, min = 40) => typeof v === 'string' && v.trim().length >= min;
const named = (v) => typeof v === 'string' && v.trim().length >= 2;
const strings = (v) => Array.isArray(v) && v.length > 0 && v.every(named);
const BEAD_RE = /^[a-z]{2}-[a-z0-9]+(\.\d+)*$/;

/**
 * Everything wrong with one entry, as sentences.
 *
 * Takes one entry rather than reading `REGISTER`, for the reason `lib/evidence.js` and
 * `lib/documents.js` both give for the same split: the register is frozen and supposed to
 * be clean, so a rule that only ever runs against it reports a pass and can never be shown
 * to fail. `test/datastores.mjs` runs these against deliberately broken entries.
 */
export function entryProblems(e) {
  const problems = [];
  const at = `REGISTER[${e?.id || '?'}]`;

  if (!/^[a-z][a-z0-9-]*$/.test(String(e?.id || ''))) problems.push(`${at}: id must be kebab-case`);
  if (!named(e?.title)) problems.push(`${at}: \`title\` must name the store`);
  if (!prose(e?.holds)) problems.push(`${at}: \`holds\` must say what data is in it, in a sentence`);
  if (!strings(e?.where)) problems.push(`${at}: \`where\` must name at least one location it is actually held at`);

  for (const [field, what] of [
    ['provenance', 'where the data came from and who authored it'],
    ['purpose', 'what it is used for'],
    ['adequacy', 'whether it is adequate for that purpose — including what it is not adequate for'],
    ['access', 'who can read it. "Every agent" is an answer; a blank is not'],
    ['disposal', 'when it is disposed of, or whose rule decides that'],
  ]) {
    if (!prose(e?.[field])) problems.push(`${at}: \`${field}\` must say ${what}`);
  }

  const p = e?.personal;
  if (!p || !PERSONAL_STATES.includes(p.state)) {
    problems.push(`${at}: \`personal.state\` must be one of ${PERSONAL_STATES.join(', ')} — "possible" is usually the true answer and is not a hedge`);
  }
  if (!prose(p?.what)) {
    problems.push(
      `${at}: \`personal.what\` must say which personal data is in it and where — and for \`none\`, why there is none. ` +
        'A blank reads as "nobody asked", which is the finding this register exists to prevent'
    );
  }

  const r = e?.retention;
  const okRetention = RETENTION_WORDS.includes(r) || (Number.isInteger(r) && r >= RETENTION_FLOOR_MONTHS);
  if (!okRetention) {
    problems.push(
      `${at}: \`retention\` must be ${RETENTION_WORDS.join(' or ')}, or a whole number of months no smaller than ` +
        `${RETENTION_FLOOR_MONTHS} — the floor is lib/evidence.js's and this register does not get a second one`
    );
  }
  if (r === 'external' && !(Array.isArray(e?.suppliers) && e.suppliers.length)) {
    problems.push(`${at}: \`retention: 'external'\` says somebody else decides, so \`suppliers\` has to name who`);
  }

  if (e?.evidence !== null && !named(e?.evidence)) problems.push(`${at}: \`evidence\` must be an evidence-register id, or null for a store that is not an evidence class`);
  if (!Array.isArray(e?.suppliers) || !e.suppliers.every(named)) problems.push(`${at}: \`suppliers\` must be an array of supplier-register ids, empty if it reaches none`);

  if (e?.gap !== null) {
    if (!BEAD_RE.test(String(e?.gap?.bead || ''))) problems.push(`${at}: \`gap.bead\` must name the bead that closes it`);
    if (!prose(e?.gap?.says)) problems.push(`${at}: \`gap.says\` must say what is not known yet, in a sentence`);
  }

  return problems;
}

/** Everything wrong with the register itself, as sentences. */
export function registerProblems(register = REGISTER, notSubject = NOT_SUBJECT) {
  const problems = [];
  const seen = new Set();

  for (const e of register) {
    if (seen.has(e.id)) problems.push(`REGISTER[${e.id}]: two entries with the same id`);
    seen.add(e.id);
    problems.push(...entryProblems(e));
  }

  for (const x of notSubject) {
    if (!named(x?.evidence)) problems.push('NOT_SUBJECT: an entry naming no evidence class');
    if (!prose(x?.why)) problems.push(`NOT_SUBJECT[${x?.evidence}]: \`why\` must say why it holds no data this register is about`);
  }

  return problems;
}

/**
 * This register against the two it cites: bad citations, unclassified classes, and the one
 * failure a fourth register is actually likely to produce — a retention period that
 * disagrees with the register that already stated it.
 *
 * The evidence register is the coverage baseline rather than the filesystem, and that is
 * the choice worth defending. A sweep of `lib/` would find modules; what this register is
 * about is *bodies of data*, and the existing inventory of those is `lib/evidence.js`. So a
 * new evidence class cannot land without somebody here saying whether it holds data about a
 * person — which is exactly the question that otherwise gets answered once, at the start,
 * and never again.
 *
 * Two stores below are deliberately not evidence classes and have `evidence: null`: bead
 * content belongs to the tracker and prompt context has already left. Neither is an omission
 * from that register, and neither can be checked against it.
 */
export function coverageProblems(register = REGISTER, notSubject = NOT_SUBJECT, evidence = EVIDENCE, suppliers = SUPPLIERS) {
  const problems = [];
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  const supplierIds = new Set(suppliers.map((s) => s.id));
  const claimed = new Map();

  for (const e of register) {
    for (const id of e.suppliers || []) {
      if (!supplierIds.has(id)) problems.push(`REGISTER[${e.id}]: names supplier \`${id}\`, which is not in lib/suppliers.js`);
    }

    if (e.evidence === null) continue;
    const cls = evidenceById.get(e.evidence);
    if (!cls) {
      problems.push(`REGISTER[${e.id}]: names evidence class \`${e.evidence}\`, which is not in lib/evidence.js — a citation to nothing`);
      continue;
    }
    claimed.set(e.evidence, [...(claimed.get(e.evidence) || []), e.id]);

    // The disagreement this whole file was made to avoid. `permanent` and a number are
    // different kinds of answer and neither may be rounded to the other.
    if (String(cls.retention) !== String(e.retention)) {
      problems.push(
        `REGISTER[${e.id}]: says retention ${JSON.stringify(e.retention)} and lib/evidence.js says ` +
          `${JSON.stringify(cls.retention)} for \`${e.evidence}\`. Two registers disagreeing about how long one store ` +
          'lives is worse than either answer — change the evidence register, or cite what it says'
      );
    }
  }

  for (const x of notSubject) {
    if (!evidenceById.has(x.evidence)) {
      problems.push(`NOT_SUBJECT[${x.evidence}]: not an evidence class — an exemption for something that is not there excuses nothing`);
    }
    if (claimed.has(x.evidence)) {
      problems.push(`NOT_SUBJECT[${x.evidence}]: also claimed by REGISTER[${claimed.get(x.evidence).join(', ')}] — it cannot be both`);
    }
  }

  const excused = new Set(notSubject.map((x) => x.evidence));
  for (const cls of evidence) {
    if (claimed.has(cls.id) || excused.has(cls.id)) continue;
    problems.push(
      `lib/evidence.js has \`${cls.id}\` and this register does not classify it — say what is in it, who can read it and ` +
        'when it goes, or say in NOT_SUBJECT why it holds no data this register is about'
    );
  }

  return problems;
}

/** Every store that may hold data about a person, and the sentence saying which. */
export function personalDataLocations(register = REGISTER) {
  return register
    .filter((e) => e.personal.state !== 'none')
    .map((e) => ({ id: e.id, title: e.title, state: e.personal.state, what: e.personal.what, where: e.where }));
}
