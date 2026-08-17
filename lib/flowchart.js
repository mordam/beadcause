/**
 * The shape of the whole system, as data — and the one question it exists to answer.
 *
 * beadcause is 90-odd modules, 83 routes and seven agent kinds, and the README describes
 * all of it in the order the features were built. What that leaves unanswerable at a
 * glance is the question anybody actually asks first: **where does the code stop and an
 * agent start?** A `bd ready` filter and an unattended `claude -p` sit two lines apart in
 * lib/advocate.js and read almost the same in prose, and they are not remotely the same
 * thing — one is a decision this repo makes deterministically and can be tested, the
 * other is a decision handed to a model with a tool allowlist and a timeout.
 *
 * So: every step of every flow is a node with a `kind`, and `kind` is the axis the whole
 * drawing is coloured by.
 *
 *   code     a function in this repo. Deterministic, testable, reviewable in a diff.
 *   agent    a Claude Code process spawned with a foundation. Non-deterministic.
 *   human    Adam, on a phone or at a keyboard. The steps nothing may do for him.
 *   device   the PWA, the Android shell, the browser — code, but not on this Mac.
 *   external GitHub, JIRA, Confluence, ntfy, Slack, Tailscale, another Mac.
 *   store    state that outlives the process: the tracker, a git ref, a state file.
 *
 * **What keeps this from rotting.** Two things, and neither is discipline.
 *
 * 1. **Agents are not described here.** An `agent` node carries an `agent` id and
 *    nothing else; the model, the tools, the allowlist, the role prompt and whether it
 *    may write to the tracker are read out of lib/foundation.js at build time. That file
 *    is already the single definition of what an agent is — copying any of it into a
 *    diagram would create a second one, which is the exact failure lib/foundation.js was
 *    written to end. An amendment approved on the phone changes what this draws.
 * 2. **Every node names its source, and the suite checks the files exist.** A node
 *    pointing at a module somebody deleted fails `node test/flowchart.mjs` rather than
 *    quietly drawing a box for something that is gone. It cannot catch a step that moved
 *    inside a file it still names — nothing can, short of writing the code twice — but it
 *    does catch the whole-module drift that a year of refactoring actually produces.
 *
 * **What this is not.** It is not generated from the code, and it could not be: "the
 * poller sweeps, then the advocates tick, then the sync takes the write lock" is an
 * ordering decision spread over a 7000-line file, and a tool that inferred it from the
 * call graph would draw every helper and none of the meaning. This is a hand-written map
 * with a machine-checked index — the map is the judgement, the index is what stops the
 * judgement going stale.
 *
 * Read it with `node scripts/flowchart.mjs`, which renders it standalone, or on the
 * phone at `/flow`, which draws the same object from `GET /api/flowchart`.
 */
import { AGENTS, baseline, displayName, mark, PROTECTED, AMENDABLE } from './foundation.js';

/**
 * The six kinds, and the one line each that says what it means to be one.
 *
 * The order is the order the legend is drawn in, and it is deliberate: `code` and
 * `agent` first and adjacent, because the whole point of the drawing is the boundary
 * between those two. Everything after them is context for where that boundary sits.
 */
export const KINDS = [
  {
    id: 'code',
    label: 'Procedural',
    short: 'code',
    hue: 210,
    meaning: 'A function in this repo. Same input, same output — reviewable in a diff, coverable by a suite.',
  },
  {
    id: 'agent',
    label: 'Agentic',
    short: 'agent',
    hue: 280,
    meaning:
      'A Claude Code process spawned with a foundation: a model, a tool allowlist, a timeout, and a brief. What it does next is not decided by this repo.',
  },
  {
    id: 'human',
    label: 'You',
    short: 'human',
    hue: 35,
    meaning: 'A decision nothing here is allowed to make for you. Every one of these is a tap or a keystroke.',
  },
  {
    id: 'device',
    label: 'On the phone',
    short: 'device',
    hue: 160,
    meaning: 'Code, but not on this Mac: the PWA in the browser, the Android shell, the service worker.',
  },
  {
    id: 'external',
    label: 'Off this Mac',
    short: 'external',
    hue: 0,
    meaning: 'GitHub, JIRA, Confluence, ntfy, Slack, another engineer’s laptop. Can be slow, absent or wrong.',
  },
  {
    id: 'store',
    label: 'State that outlives the process',
    short: 'store',
    hue: 50,
    meaning: 'The tracker, a git ref, a file under ~/.config/beadcause. Where a restart is survived.',
  },
];

const KIND_IDS = new Set(KINDS.map((k) => k.id));

/**
 * Node ids mermaid will not accept, because they are its own words.
 *
 * The failure is the bad kind: the parse fails for the whole *diagram*, not for the
 * node, so a flow with one of these draws nothing at all — and "nothing at all" is
 * indistinguishable from the deliberate fallback of leaving the source in a `<pre>`.
 * `end` cost exactly that on the chat flow, which had a step honestly called *the
 * session ends*. Checked in `problems`, so it is a red suite rather than a blank box.
 */
const RESERVED = ['end', 'graph', 'subgraph', 'class', 'classDef', 'click', 'style', 'linkStyle', 'direction', 'default'];

/**
 * An agent node that is not one kind.
 *
 * Two steps in the amendment loop are performed by whichever agent has just finished a
 * task, and naming one of the seven there would be a lie that reads as precision — the
 * whole point of that loop is that every kind can argue with its own foundation. It is a
 * distinct value rather than a null so that `problems` can still insist an agent node
 * says *something* about what is running in it.
 */
export const ANY_AGENT = '*';

/**
 * The flows, in the order somebody meeting this system should read them.
 *
 * A flow is one answerable question — "what happens when an agent needs me?", "what
 * happens when a queue goes empty?" — and not a subsystem. That distinction is what
 * keeps any single diagram small enough to read on a phone: `lib/server.js` appears in
 * six of these and is never the subject of one.
 *
 * `trigger` is the sentence the whole flow hangs off. Every flow has exactly one, and
 * writing it is the test of whether the flow is really one flow.
 *
 * `short` is what a nav pill says. Written rather than derived from the title, because
 * every rule for shortening a sentence gets one of these wrong: "A question reaches you,
 * and your answer unblocks it" has no clause to cut at, and truncating it gives a pill
 * that reads "A question reaches yo…". Eleven hand-written labels is cheaper than a
 * heuristic nobody can predict — and `problems` insists each is short enough to be one.
 */
const FLOWS = [
  /* ------------------------------------------------------------------ 1. boot */
  {
    id: 'boot',
    short: 'Boot & swap',
    title: 'Booting, and never restarting',
    icon: '🚀',
    trigger: 'launchd starts the job at login — and after that, an edit to lib/.',
    summary: `What launchd runs is the router, not the app. The router owns port 4318 and supervises a
backend on a loopback port; when files that only take effect at startup move, it brings a
second backend up beside the first, health-checks it, hands over and drains the old one.
That is why editing lib/ needs no restart, and why exactly one process is ever polling.`,
    nodes: [
      {
        id: 'launchd',
        kind: 'code',
        label: 'launchd\nm4m.beadcause',
        detail:
          'The generated plist — never committed, because a checked-in one names a `node` path that moves between machines. KeepAlive turns a boot crash into a loud restart loop rather than a silence.',
        source: ['scripts/install.sh', 'lib/launchagent.js'],
      },
      {
        id: 'router',
        kind: 'code',
        label: 'bin/router.js\nowns :4318',
        detail:
          'Stays small on purpose: every import at its top is a leaf, and none of them reaches lib/server.js, so a syntax error in the app costs you a swap and not the port. It cannot replace itself — a change to its own source waits for `launchctl kickstart`.',
        source: ['bin/router.js'],
      },
      {
        id: 'watch',
        kind: 'code',
        label: 'watch the files\nthat only load at startup',
        detail:
          'A debounce on lib/, bin/ and package.json. The swap fires a few seconds after the files settle, so a session mid-save does not get half a tree promoted.',
        source: ['bin/router.js', 'lib/build.js'],
      },
      {
        id: 'standby',
        kind: 'code',
        label: 'start the new backend\n--port N --standby',
        detail:
          '`--standby` starts it without its poller. Two live pollers would both see a new question and both push it, so the new process is promoted only after the old one has stood down.',
        source: ['bin/beadcause.js', 'lib/startup.js'],
      },
      {
        id: 'health',
        kind: 'code',
        label: 'health-check it',
        detail:
          'A child that exits is a broken build and is condemned; a child that is alive and has not answered yet is a busy Mac, and is retried on a scaling window. If nothing ends up behind the port, the 503 says so and it is pushed to the phone rather than only logged.',
        source: ['lib/startup.js', 'bin/router.js'],
      },
      {
        id: 'poisoned',
        kind: 'store',
        label: 'condemned build\nmarker',
        detail:
          'A build that would not start is remembered, so the router does not spend the day promoting it again. `npm run swap:status` is what says a green-looking daemon is serving stale code.',
        source: ['lib/build.js', 'bin/router.js'],
      },
      {
        id: 'handover',
        kind: 'code',
        label: 'hand over,\ndrain the old one',
        detail:
          'The phone sees one continuous server. The WebSocket the terminal rides goes through the router too, and a swap ends it on purpose rather than leaving it pointed at a drained backend.',
        source: ['bin/router.js', 'lib/termsocket.js'],
      },
      {
        id: 'app',
        kind: 'code',
        label: 'lib/server.js\nthe app: 83 routes',
        detail:
          'Refuses to start with the same (method, path) registered twice — a duplicate route is never intentional, and the second one is dead code that returns a 200 with the wrong body.',
        source: ['lib/server.js'],
      },
      {
        id: 'poller',
        kind: 'code',
        label: 'startPoller\nthe clock everything hangs off',
        detail: 'The one loop in the system. Everything in the Sweeps flow is a beat of it.',
        source: ['lib/server.js'],
      },
      {
        id: 'tls',
        kind: 'code',
        label: 'HTTPS on the tailnet name',
        detail:
          'A certificate for the Tailscale name, renewed before it expires and swapped onto the live socket without a rebind. Once it has actually expired it stays HTTPS, broken and loud, rather than silently falling back to cleartext.',
        source: ['lib/tls.js', 'lib/tlsswitch.js'],
      },
    ],
    edges: [
      { from: 'launchd', to: 'router', label: 'at login' },
      { from: 'router', to: 'watch' },
      { from: 'router', to: 'app', label: 'first backend' },
      { from: 'watch', to: 'standby', label: 'files moved' },
      { from: 'standby', to: 'health' },
      { from: 'health', to: 'handover', label: 'answered' },
      { from: 'health', to: 'poisoned', label: 'never answered' },
      { from: 'handover', to: 'app', label: 'promoted' },
      { from: 'app', to: 'poller' },
      { from: 'router', to: 'tls' },
    ],
  },

  /* -------------------------------------------------------------- 2. question */
  {
    id: 'question',
    short: 'A question',
    title: 'A question reaches you, and your answer unblocks it',
    icon: '📥',
    trigger: 'An agent anywhere runs `bd human <id>` — or `bd label add <id> human`.',
    summary: `The original loop, and still the centre of the app. Nothing here is agentic on the
beadcause side: the daemon polls, decides whether to make a noise, and writes your words
onto the bead. The only agent in it is the one that filed the question, and it exited days
ago.`,
    nodes: [
      {
        id: 'filed',
        kind: 'agent',
        label: 'an agent files\na `human` bead',
        detail:
          'Any agent session, in any repo, in any workspace. Usually a work session that hit a decision it may not make; it then exits. Nothing is listening for it to come back.',
        agent: 'worker',
        source: ['bin/ask.js', 'lib/session.js'],
      },
      {
        id: 'tracker',
        kind: 'store',
        label: 'the tracker\n~/beads/*/.beads',
        detail:
          'Embedded Dolt, one per workspace. Every write is a Dolt commit, which is why nothing here is ever really lost.',
        source: ['lib/bd.js'],
      },
      {
        id: 'tick',
        kind: 'code',
        label: 'poll tick\nallQuestions()',
        detail:
          'One `bd human list` per workspace, on the fast clock — or immediately, when the change detector sees a workspace move. Everything below is decided from that list.',
        source: ['lib/server.js', 'lib/detect.js'],
      },
      {
        id: 'fresh',
        kind: 'code',
        label: 'is it new?',
        detail:
          'Keyed by `<workspace>/<id>` against a set on disk. On the very first tick after a restart the whole backlog is marked seen without pushing, so a restart is not a burst of notifications.',
        source: ['lib/server.js'],
        gate: true,
      },
      {
        id: 'addressee',
        kind: 'code',
        label: 'is it for you?',
        detail:
          'A `for:` label names one person on a tracker two Macs share. A question addressed to somebody else files a card and never rings — and the log says which of the three reasons it was.',
        source: ['lib/addressee.js'],
        gate: true,
      },
      {
        id: 'quiet',
        kind: 'code',
        label: 'quiet? filtered?',
        detail:
          'A muted space and a narrowed inbox filter are two different quiets. Either way the event is still emitted and the card still files — suppressing it outright would hide the question, which is much worse than an unwanted buzz.',
        source: ['lib/spaces.js', 'lib/hushed.js'],
        gate: true,
      },
      {
        id: 'bus',
        kind: 'code',
        label: 'event bus\nemit()',
        detail:
          'The app’s own notification, emitted before the push so it is never gated on ntfy being reachable. Every parked client on `/api/poll` wakes on it.',
        source: ['lib/events.js'],
      },
      {
        id: 'ntfy',
        kind: 'external',
        label: 'ntfy relay',
        detail:
          'Optional and usually off — nothing subscribes, and the phone long-polls `/api/poll` instead. A two- or three-option question puts its answers on the notification’s own action buttons.',
        source: ['lib/notify.js'],
      },
      {
        id: 'slack',
        kind: 'external',
        label: 'Slack',
        detail:
          'The same decision in a channel, for the repos mapped to one. Two tokens, because posting and pressing a button are different apps.',
        source: ['lib/slack.js'],
      },
      {
        id: 'phone',
        kind: 'device',
        label: 'the PWA\ninbox card',
        detail:
          'One list, six kinds — proposal, delivery, question, pull request, JIRA ticket, live bead. `KINDS` in public/inboxfilter.js is the only place that knows which row is which.',
        source: ['public/app.js', 'public/inboxfilter.js'],
      },
      {
        id: 'read',
        kind: 'human',
        label: 'you read the brief',
        detail:
          'The whole reason this is not two buttons on a lock screen: the diagram, the images, the links, the dependency subtree, and what the question is blocking.',
        source: ['public/app.js', 'public/graph.js'],
      },
      {
        id: 'answer',
        kind: 'human',
        label: 'you answer',
        detail:
          'An option, or free text, or a set of proposed beads you have edited. Setting a card aside is deliberately not answering it.',
        source: ['public/app.js'],
      },
      {
        id: 'gate',
        kind: 'code',
        label: 'closeGate',
        detail:
          'Asks bd whether it would refuse the close *before* writing anything — an open child, a blocking dependency. A refusal after the comment had landed would be an answer on a bead that stayed open.',
        source: ['lib/bd.js'],
        gate: true,
      },
      {
        id: 'respond',
        kind: 'code',
        label: 'POST /api/respond\nbd comment + bd close',
        detail:
          'Your words, plus a record of what was created, declined, amended or delivered by this same answer. One writer, and it is this.',
        source: ['lib/server.js'],
      },
      {
        id: 'ready',
        kind: 'store',
        label: '`bd ready` unblocks',
        detail: 'Whatever was waiting on the answer turns up for the next agent session — which is the point of the whole app.',
        source: ['lib/bd.js'],
      },
    ],
    edges: [
      { from: 'filed', to: 'tracker' },
      { from: 'tracker', to: 'tick', label: 'every 5s / on change' },
      { from: 'tick', to: 'fresh' },
      { from: 'fresh', to: 'addressee', label: 'new' },
      { from: 'addressee', to: 'quiet', label: 'yours' },
      { from: 'quiet', to: 'bus' },
      { from: 'bus', to: 'ntfy', label: 'if enabled' },
      { from: 'bus', to: 'slack', label: 'if mapped' },
      { from: 'bus', to: 'phone', label: '/api/poll wakes' },
      { from: 'ntfy', to: 'phone' },
      { from: 'phone', to: 'read' },
      { from: 'read', to: 'answer' },
      { from: 'answer', to: 'gate' },
      { from: 'gate', to: 'respond', label: 'it will close' },
      { from: 'gate', to: 'phone', label: '409 — say why, offer a comment' },
      { from: 'respond', to: 'ready' },
      { from: 'respond', to: 'tracker' },
    ],
  },

  /* ----------------------------------------------------------------- 3. reply */
  {
    id: 'reply',
    short: 'A reply',
    title: 'You comment, and something answers you',
    icon: '💬',
    trigger: 'You leave a comment on a question rather than answering it.',
    summary: `\`human-replied\` was once a passive flag: you commented, the bead was labelled, and the
session that filed it had exited days ago. Five threads sat unanswered, one of them
reading "Can anyone hear me?". A comment now dispatches an unattended agent, and the
reply poller you already had notices the answer and pushes it back.`,
    nodes: [
      {
        id: 'comment',
        kind: 'human',
        label: 'you comment',
        detail: 'Optionally choosing which agent answers, and optionally arming one extra tool for this comment only.',
        source: ['public/app.js'],
      },
      {
        id: 'post',
        kind: 'code',
        label: 'POST /api/comment',
        detail: 'Writes the comment, labels the bead `human-replied`, and decides whether an agent may be spawned at all.',
        source: ['lib/server.js'],
      },
      {
        id: 'allowed',
        kind: 'code',
        label: 'may a session\nbe spawned?',
        detail:
          'Off on a shared workspace unless configured, off in observer mode, off when the space says so. An unattended agent commenting on a graph the whole team reads is a decision, not a default.',
        source: ['lib/spaces.js', 'lib/config.js'],
        gate: true,
      },
      {
        id: 'pick',
        kind: 'code',
        label: 'which agent',
        detail:
          'Four built-in briefs over one foundation — answerer, researcher, critic, summariser. Different jobs, not different phrasings: half the time what a question needs is a counter-argument, not an answer.',
        source: ['lib/agents.js'],
      },
      {
        id: 'brief',
        kind: 'code',
        label: 'compose the brief\npromptFor()',
        detail:
          'The thread, the bead, the memory brief, the lookup brief, and — if a space has named one — the wiki brief. The foundation is what it is on every run; this is what it was asked this time.',
        source: ['lib/dispatch.js', 'lib/memory.js'],
      },
      {
        id: 'agent',
        kind: 'agent',
        label: 'claude -p\nthe comment answerer',
        detail:
          'Unattended, headless, streamed to a log you can watch on the phone. It may comment on the bead — that comment IS the answer — and may not close anything.',
        agent: 'dispatch',
        source: ['lib/dispatch.js', 'lib/agentlog.js'],
      },
      {
        id: 'agentcomment',
        kind: 'store',
        label: 'its comment,\non the bead',
        detail: 'The only write it has. Everything downstream reads the tracker rather than the process.',
        source: ['lib/bd.js'],
      },
      {
        id: 'checkreplies',
        kind: 'code',
        label: 'checkReplies\none `bd comments` per watched bead',
        detail:
          'Only threads you have replied to are watched — bounded to the handful you are actually waiting on rather than the whole inbox. A comment does not move `updated_at`, so counting is the only way to see one.',
        source: ['lib/server.js'],
      },
      {
        id: 'push',
        kind: 'code',
        label: 'push the reply,\nclear the flag',
        detail: 'An agent has answered you, so you are no longer the one waiting: `human-replied` comes off.',
        source: ['lib/server.js', 'lib/notify.js'],
      },
      {
        id: 'thread',
        kind: 'device',
        label: 'the thread,\nfolded to the last exchange',
        detail: 'It opens on your half of it, because the thing you are reading is the reply to what you said.',
        source: ['public/app.js'],
      },
    ],
    edges: [
      { from: 'comment', to: 'post' },
      { from: 'post', to: 'allowed' },
      { from: 'allowed', to: 'pick', label: 'yes' },
      { from: 'allowed', to: 'agentcomment', label: 'no — the flag waits for a session' },
      { from: 'pick', to: 'brief' },
      { from: 'brief', to: 'agent' },
      { from: 'agent', to: 'agentcomment' },
      { from: 'agentcomment', to: 'checkreplies' },
      { from: 'checkreplies', to: 'push', label: 'author is not you' },
      { from: 'push', to: 'thread' },
    ],
  },

  /* ------------------------------------------------------------------ 4. chat */
  {
    id: 'chat',
    short: 'Chat to beads',
    title: 'Deciding what to file — the chat session',
    icon: '✍️',
    trigger: 'You tap ＋ and start a conversation about work that does not exist yet.',
    summary: `Everything else in beadcause acts on beads that already exist. This is the one place work
is decided. The agent cannot write to the tracker at all — proposing *is* filing, as far
as it is concerned — and nothing reaches bd until you have read the proposal on screen,
edited it, and pressed the button.`,
    nodes: [
      {
        id: 'open',
        kind: 'human',
        label: 'open a chat\non a repo',
        detail: 'A tab per repo in the launcher, and several chats open at once; switching between them is a repaint, not a fetch.',
        source: ['public/console.js'],
      },
      {
        id: 'turn',
        kind: 'code',
        label: 'POST /api/console/message\na fresh `claude -p` per turn',
        detail:
          'Not a long-lived process. A phone conversation has minutes of silence in it, and a parked process dies to a laptop lid. `--session-id` on the first turn and `--resume` after gives the same continuity for free, and Claude Code’s transcript is the durable copy.',
        source: ['lib/console.js'],
      },
      {
        id: 'agent',
        kind: 'agent',
        label: 'the chat session',
        detail:
          'Asks the questions that would change the beads — is this one bead or four, what does done mean, does something already cover this — and reads the repo and the tracker to answer what it can itself.',
        agent: 'console',
        source: ['lib/console.js'],
      },
      {
        id: 'block',
        kind: 'code',
        label: 'extractProposal\nthe ```beads block',
        detail:
          'The agent writes a fenced block; this parses it. The markdown you read above the fold is rendered from the same parsed object, so the two cannot disagree.',
        source: ['lib/draft.js'],
      },
      {
        id: 'review',
        kind: 'device',
        label: 'the proposal,\neditable on screen',
        detail:
          'The proposal is the review, so the review is editable: retype a title, drop one of four, and what is created is what is on screen. A card that is already a bead says so — and still files.',
        source: ['public/console.js'],
      },
      {
        id: 'press',
        kind: 'human',
        label: 'you press create',
        detail: 'The one writer. This is the review step the agent’s read-only allowlist exists to protect.',
        source: ['public/console.js'],
      },
      {
        id: 'create',
        kind: 'code',
        label: 'bd create ×N',
        detail: 'Filed with their dependencies, under the epic they belong to, labelled for the repo they are about.',
        source: ['lib/server.js', 'lib/filing.js'],
      },
      {
        // Not `end`: that is a mermaid keyword (it closes a `subgraph`), and a node id
        // that collides with one fails the whole diagram rather than the node. See
        // RESERVED below.
        id: 'ended',
        kind: 'code',
        label: 'the session ends\nwhen the beads exist',
        detail: 'What you just filed is one tap away; an old proposal says what became of it rather than sitting there re-offering itself.',
        source: ['lib/console.js'],
      },
      {
        id: 'memory',
        kind: 'store',
        label: 'beadcause-memory',
        detail:
          'Not a tracker write. The chat session cannot touch a bead; it can keep what it has learned about how you like one shaped.',
        source: ['lib/memory.js', 'bin/beadcause-memory'],
      },
    ],
    edges: [
      { from: 'open', to: 'turn' },
      { from: 'turn', to: 'agent' },
      { from: 'agent', to: 'turn', label: 'asks you something' },
      { from: 'agent', to: 'block', label: 'proposes' },
      { from: 'agent', to: 'memory', label: 'what it learned about you' },
      { from: 'block', to: 'review' },
      { from: 'review', to: 'press' },
      { from: 'press', to: 'create' },
      { from: 'create', to: 'ended' },
    ],
  },

  /* -------------------------------------------------------------- 5. advocate */
  {
    id: 'advocate',
    short: 'The advocate',
    title: 'The advocate — an agent per repo, whose job is the queue reaching zero',
    icon: '📣',
    trigger: 'The poll tick, every cycle. An advocate has no clock of its own.',
    summary: `Everything else here is a channel; nothing in it ever cared whether the work got done. The
advocate is the missing party. Note where the boundary falls: **the whole queue-narrowing
chain is procedural** — eleven filters, each of which can say out loud why a bead is not
being worked — and an agent is spawned only at the two ends, to do a bead or to argue that
the queue is genuinely finished.`,
    nodes: [
      {
        id: 'tick',
        kind: 'code',
        label: 'advocates.tick()',
        detail: 'Called by the poller on the poll it already makes. One filesystem read of live sessions, so every advocate is matched against the same snapshot.',
        source: ['lib/advocate.js'],
      },
      {
        id: 'reconcile',
        kind: 'code',
        label: 'reconcile the windows\nit thinks it has',
        detail:
          'It knows it launched a window for a bead; it does not know that a given `claude` process is that window. They are matched on the name the session was told to take, and nothing else.',
        source: ['lib/advocate.js', 'lib/claude.js'],
      },
      {
        id: 'housekeep',
        kind: 'code',
        label: 'housekeeping sweeps',
        detail:
          'Archive finished sessions, retire worktrees, mark superseded beads, flag work already in main, flag branches that never reached it. All before the survey, because some of them change what the survey sees.',
        source: ['lib/tidy.js', 'lib/superseded.js', 'lib/inmain.js', 'lib/notinmain.js'],
      },
      {
        id: 'ready',
        kind: 'store',
        label: '`bd ready`\nminus the excluded labels',
        detail: 'Unendorsed work is out of every queue and every count that says how much work is waiting.',
        source: ['lib/bd.js', 'lib/endorse.js'],
      },
      {
        id: 'narrow',
        kind: 'code',
        label: 'the narrowing chain\n— eleven filters —',
        detail: `In order: nothing decided above it · priority floor · names no checkout this workspace can work in ·
held by its own children · grouped into an epic’s plan or batch · claimed by another Mac ·
a twin of work already under way · already in an open pull request · a session already open
on it · its files being edited by another session. Every one of them can say out loud why,
because a queue emptied by a filter is not a clear queue — and an advocate that said "clear"
over one would go on to propose *more* work beside it.`,
        source: [
          'lib/advocate.js',
          'lib/underroot.js',
          'lib/repos.js',
          'lib/plan.js',
          'lib/lease.js',
          'lib/dupe.js',
          'lib/inflight.js',
          'lib/beadfiles.js',
        ],
        gate: true,
      },
      {
        id: 'stops',
        kind: 'code',
        label: 'paused? quiet hours?\nobserver instance?',
        detail:
          'Everything above this line is looking; everything below it is doing. An observer instance stops exactly here — the survey has run, so the queue is on screen, which is the whole reason to boot a second one.',
        source: ['lib/advocate.js', 'lib/spaces.js', 'lib/config.js'],
        gate: true,
      },
      {
        id: 'slots',
        kind: 'code',
        label: 'a free slot?\nper-repo and global caps',
        detail: 'Every cap is loud: a launch refused for want of a slot says so, in the log and on the card, because a silent drop reads exactly like nothing to do.',
        source: ['lib/advocate.js'],
        gate: true,
      },
      {
        id: 'lastlook',
        kind: 'code',
        label: 'the last three reads\nbefore a window opens',
        detail:
          'Did the PR land on github.com, is there one open already, is somebody sitting in it. Unconditional rather than on the interval, because being ten minutes late here is a whole session spent proving that work already in main is already in main.',
        source: ['lib/landed.js', 'lib/inflight.js', 'lib/advocate.js'],
        gate: true,
      },
      {
        id: 'lease',
        kind: 'code',
        label: 'take a lease',
        detail:
          'The one claim two Macs can both read. `bd update --claim` is atomic against the *local* Dolt, and the sync interval is two minutes — claim-then-check inside that window is two local writes that both succeed.',
        source: ['lib/lease.js'],
      },
      {
        id: 'launch',
        kind: 'code',
        label: 'open an iTerm window\nwith a generated brief',
        detail:
          'The brief is a pure function, asserted line by line in the suite, because it is the whole interface between this daemon and an unattended agent: the claim, the endings, the marker step, and the delivery command as an absolute path.',
        source: ['lib/session.js', 'scripts/open-session.applescript'],
      },
      {
        id: 'worker',
        kind: 'agent',
        label: 'a work session',
        detail:
          'The only agent that edits files, and the only one where permission mode means anything. It reads the repo’s own CLAUDE.md before the first edit, and assumes nobody is watching.',
        agent: 'worker',
        source: ['lib/session.js'],
      },
      {
        id: 'empty',
        kind: 'code',
        label: 'queue genuinely empty\nand nothing held',
        detail:
          'The only state in which proposing is allowed. A queue emptied by a filter is not this state, and the difference is the whole reason those eleven filters each keep a count.',
        source: ['lib/advocate.js'],
        gate: true,
      },
      {
        id: 'survey',
        kind: 'agent',
        label: 'the repo advocate\nsurveys',
        detail:
          'What has just closed, what is stuck, what is already open, and the comments under it — plus, in this repo, a screenshot script so it can look at the screen rather than only read the source of it.',
        agent: 'advocate',
        source: ['lib/advocate.js'],
      },
      {
        id: 'proposal',
        kind: 'code',
        label: 'parse the ```beadproposal',
        detail:
          'It may open sessions on work that exists without asking. It may not invent work: a bead filed on your behalf is something you become answerable for.',
        source: ['lib/proposal.js'],
      },
      {
        id: 'card',
        kind: 'device',
        label: 'an ordinary question\nin your inbox',
        detail: 'Carrying the full text of every bead it wants. Nothing is created until you press create — the same button as the chat session’s.',
        source: ['public/app.js'],
      },
      {
        id: 'agentrepo',
        kind: 'store',
        label: 'a repo one agent owns',
        detail:
          'Tier 3, and the advocate is the one agent that has it — not a favour, but because it is the agent the experiment can be run on: unattended, repeated against the same workspace, and the kind that most wants to know what it concluded last time.',
        source: ['lib/agentrepo.js'],
      },
    ],
    edges: [
      { from: 'tick', to: 'reconcile' },
      { from: 'reconcile', to: 'housekeep' },
      { from: 'housekeep', to: 'ready' },
      { from: 'ready', to: 'narrow' },
      { from: 'narrow', to: 'stops' },
      { from: 'stops', to: 'slots', label: 'running' },
      { from: 'slots', to: 'lastlook' },
      { from: 'lastlook', to: 'lease' },
      { from: 'lease', to: 'launch' },
      { from: 'launch', to: 'worker' },
      { from: 'narrow', to: 'empty', label: 'nothing left' },
      { from: 'empty', to: 'survey', label: 'and nothing held back' },
      { from: 'survey', to: 'agentrepo', label: 'what it concluded' },
      { from: 'survey', to: 'proposal' },
      { from: 'proposal', to: 'card' },
    ],
  },

  /* ------------------------------------------------------------------ 6. epic */
  {
    id: 'epic',
    short: 'An epic you own',
    title: 'An epic you own — planned, not worked',
    icon: '🧭',
    trigger: 'You own an epic, at whatever priority. The advocate opens its supervisor rather than a worker.',
    summary: `A fifth agent kind rather than a mode of the repo advocate, because the two differ in
their permissions and not their code path: the repo advocate is \`writes: false\` because it
is arguing about a queue nobody agreed to, and this one is \`writes: true\` because an epic
somebody owns has already been agreed to, and decomposing it is what planning is. It is
re-entrant, so everything it knows has to be written on the bead.`,
    nodes: [
      {
        id: 'own',
        kind: 'human',
        label: 'you own an epic',
        detail: 'Priority and ownership are yours, and an epic needs no particular priority to have an advocate. No agent may change either.',
        source: ['lib/ownership.js'],
      },
      {
        id: 'open',
        kind: 'code',
        label: 'openPlanSession',
        detail: 'Opened on child events rather than left running — a supervisor holding a worker slot for the life of an epic is expensive and gets reaped.',
        source: ['lib/session.js', 'lib/epicadvocate.js'],
      },
      {
        id: 'advocate',
        kind: 'agent',
        label: 'the Epic Advocate',
        detail:
          'Decides which children should exist, groups them for child-workers, writes each group’s prompt, and argues them through approval, merge and release. It does not do the work itself.',
        agent: 'epic-advocate',
        source: ['lib/epicadvocate.js'],
      },
      {
        id: 'children',
        kind: 'store',
        label: 'children, filed\nunder the epic',
        detail: 'Everything it files goes under the epic with `--parent`. A bead with nothing decided above it is not workable, by design.',
        source: ['lib/underroot.js'],
      },
      {
        id: 'plan',
        kind: 'store',
        label: 'the plan,\nas a bd comment',
        detail:
          'A comment and not a field: `bd update --notes` replaces, so the daemon and the planning agent writing in the same minute would silently overwrite one another — and the thing overwritten would be the plan N windows are being dispatched against. Comments cannot lose a write.',
        source: ['lib/plan.js'],
      },
      {
        id: 'dispatch',
        kind: 'code',
        label: 'the survey reads the plan\nand dispatches groups',
        detail: 'A group’s prompt is injected into the generated brief and never replaces it — the claim, the endings and the delivery command are still generated.',
        source: ['lib/plan.js', 'lib/advocate.js'],
      },
      {
        id: 'workers',
        kind: 'agent',
        label: 'child workers',
        detail: 'Ordinary work sessions, one per group, subject to every cap and every filter in the advocate flow.',
        agent: 'worker',
        source: ['lib/session.js'],
      },
      {
        id: 'waiting',
        kind: 'store',
        label: 'what the epic is waiting on\n— one sentence, in notes',
        detail:
          'Not decoration. An epic that has not moved in a week and one quietly progressing are identical from outside, and the inbox card has a slot for exactly this.',
        source: ['lib/epicadvocate.js'],
      },
      {
        id: 'promote',
        kind: 'code',
        label: 'promotion, when the plan\nis all closed',
        detail:
          'An epic whose children are all in main is a feature that has not been through UAT. Filed even on a paused advocate and during quiet hours — no window opens and no notification fires, and the record is worth most on a quiet night.',
        source: ['lib/promote.js'],
      },
      {
        id: 'endorse',
        kind: 'human',
        label: 'you endorse the subtree',
        detail: 'It may not endorse its own. Filing work *and* agreeing to it would make the review a formality performed by the agent that wanted the answer.',
        source: ['lib/endorse.js', 'public/endorse.js'],
      },
    ],
    edges: [
      { from: 'own', to: 'open' },
      { from: 'open', to: 'advocate' },
      { from: 'advocate', to: 'children' },
      { from: 'advocate', to: 'plan' },
      { from: 'advocate', to: 'waiting' },
      { from: 'children', to: 'endorse' },
      { from: 'endorse', to: 'dispatch', label: 'endorsed' },
      { from: 'plan', to: 'dispatch' },
      { from: 'dispatch', to: 'workers' },
      { from: 'workers', to: 'plan', label: 're-opens the supervisor' },
      { from: 'plan', to: 'promote', label: 'all closed' },
    ],
  },

  /* ------------------------------------------------------------------ 7. land */
  {
    id: 'land',
    short: 'Landing work',
    title: 'Landing work — branch, pull request, merge, deploy, live',
    icon: '🚢',
    trigger: 'A work session finishes and runs `beadcause-deliver`.',
    summary: `This used to end with a question on your phone and nothing merged until you tapped. That
fixed a race and introduced a queue: a bead finished at three in the morning sat unmerged
until breakfast, and the next bead to touch the same file started from a \`main\` without
it. So the merge moved off your phone, and the card there is now the *exception*:
something stopped this landing on its own.

**And then it moved off the worker too.** A worker files a merge-bead and stops, which is
the whole of its involvement in landing; the MergeAdvocate owns the queue of those. The
deterministic half of it — downmerge, wait for checks, merge, close both beads — runs in
the daemon with no window at all, because putting a model in front of \`gh pr merge\` adds
judgement to the one part of this that has none. What the daemon buys over each worker
doing it is *position*: one merge at a time per repo, so five branches about to conflict
stop each spending five minutes discovering it separately. A window opens only where
something refused and somebody has to read it.`,
    nodes: [
      {
        id: 'deliver',
        kind: 'code',
        label: 'beadcause-deliver',
        detail: 'Six steps, in order, and the fourth is the whole change. Refuses to run on main — nothing in beadcause can push to main at all.',
        source: ['bin/deliver.js'],
      },
      {
        id: 'push',
        kind: 'code',
        label: 'push the branch',
        detail: 'Only ever a branch.',
        source: ['bin/deliver.js'],
      },
      {
        id: 'pr',
        kind: 'external',
        label: 'open the pull request\n(or find the open one)',
        detail: 'The ordinary case on a second delivery after changes were requested is finding the one that is already there.',
        source: ['lib/pr.js'],
      },
      {
        id: 'mergebead',
        kind: 'store',
        label: 'a merge-bead,\nand the worker stops',
        detail:
          'The end of the worker’s involvement. Everything the merge needs is written on this bead rather than held in the window that filed it — `queueState` — because the agent that may later be opened on it is re-entrant and starts knowing only what the bead says.',
        source: ['lib/mergebead.js'],
      },
      {
        id: 'review',
        kind: 'agent',
        label: 'the reviewer',
        detail:
          'Reads the diff nobody else reads. Its verdict — the comments it raised, whether it approved, and if not why — is a fenced block in a comment on the merge-bead, so the worker can answer it and the next round can read the answers back. **Half-built, and drawn that way on purpose:** the kind, its verdict format and its brief exist; nothing opens a window on a delivered pull request yet and the queue does not yet wait for a verdict, so today a merge-bead still goes straight to the queue.',
        agent: 'review-advocate',
        source: ['lib/reviewadvocate.js'],
      },
      {
        id: 'mergequeue',
        kind: 'code',
        label: 'the merge queue,\nin the daemon',
        detail:
          'One merge at a time per repo. The deterministic half — downmerge, check, merge, close both beads — and it runs with no window, because a language model in front of `gh pr merge` would add judgement to the one part of this that has none.',
        source: ['lib/mergequeue.js', 'lib/mergeadvocate.js'],
      },
      {
        id: 'mergeadv',
        kind: 'agent',
        label: 'the merge advocate',
        detail:
          'Opened only where the deterministic half refused: a conflicted downmerge somebody has to actually resolve, a check that went red and needs reading. It merges to `main` and closes two beads, which makes it the widest-reaching agent in the roster — a kind rather than a mode, so that reach is readable off the agents screen instead of inferable from a code path.',
        agent: 'merge-advocate',
        source: ['lib/mergeadvocate.js'],
      },
      {
        id: 'checks',
        kind: 'external',
        label: 'wait for the checks',
        detail:
          'And then a second, shorter wait: GitHub computes mergeability asynchronously and reports UNKNOWN for a few seconds after a push, which in a repo with no checks is exactly where the first wait leaves this standing.',
        source: ['lib/pr.js'],
      },
      {
        id: 'merge',
        kind: 'external',
        label: 'gh pr merge',
        detail:
          'The same call and the same preflight as the button on the phone. It happens *there* rather than in a local `git merge` because GitHub serialises it — which is what keeps five concurrent workers from being the race this was invented to stop.',
        source: ['lib/pr.js'],
      },
      {
        id: 'downmerge',
        kind: 'code',
        label: 'bring this Mac’s main\nup to the merge',
        detail:
          'The merge is at GitHub, so the laptop is a commit behind and stays behind until something fetches it. In between, every new worktree branches from before this delivery. Refuses to touch a checkout with uncommitted work in it.',
        source: ['lib/prboard.js'],
      },
      {
        id: 'blocked',
        kind: 'code',
        label: 'the ```beadpr block\n— it could not land',
        detail:
          'GitHub refused it, a check went red, the checks never reported, or the session asked for review outright. The card is unchanged in shape and changed in meaning: it is now the answer to "something stopped this".',
        source: ['lib/delivery.js'],
      },
      {
        id: 'card',
        kind: 'device',
        label: 'a delivery card',
        detail: 'Three buttons: ship it, request changes, decline. Request changes is a sentence, not a button — and decline is not a stronger no.',
        source: ['public/prcard.js', 'public/app.js'],
      },
      {
        id: 'you',
        kind: 'human',
        label: 'you decide',
        detail: 'The one merge that still waits for a tap.',
        source: ['public/app.js'],
      },
      {
        id: 'ladder',
        kind: 'code',
        label: 'the ladder\nreview · merged · pushed · deployed · live',
        detail:
          'Six rungs, one function, and every screen reads `row.stage`. Three implementations of "where is this PR" is how two screens come to disagree about the same pull request — and on this subject "did it actually ship?" must have one answer.',
        source: ['lib/prstage.js', 'lib/prboard.js'],
      },
      {
        id: 'queue',
        kind: 'code',
        label: 'the release queue\n— the number over Ship',
        detail:
          'Four merges and one deploy is not four ships; it is one, and the number says how much of the day’s work it would make live. A bead per merge, filed when the merge is seen and closed when it ships.',
        source: ['lib/release.js'],
      },
      {
        id: 'deploy',
        kind: 'code',
        label: 'deploy, if the repo\nhas declared how',
        detail:
          'Every deploy on this Mac used to be you at a keyboard, and the Ship button opened an iTerm window to ask you to be. It now runs what the repo declares, and opens that window only for a repo that has declared nothing.',
        source: ['lib/deploy.js', 'scripts/deploy-runner.mjs'],
      },
      {
        id: 'autoship',
        kind: 'code',
        label: 'auto-ship',
        detail: 'The merge that does not wait for the tap, where a space has said it may.',
        source: ['lib/autoship.js'],
      },
      {
        id: 'live',
        kind: 'store',
        label: 'live',
        detail: 'Deployed and live are two rungs because they answer different questions and go true at different times.',
        source: ['lib/prstage.js'],
      },
    ],
    edges: [
      { from: 'deliver', to: 'push' },
      { from: 'push', to: 'pr' },
      { from: 'pr', to: 'mergebead' },
      { from: 'mergebead', to: 'mergequeue' },
      { from: 'mergebead', to: 'review', label: 'not wired yet' },
      { from: 'review', to: 'mergequeue', label: 'approved' },
      { from: 'mergequeue', to: 'checks' },
      { from: 'checks', to: 'merge', label: 'green' },
      { from: 'checks', to: 'mergeadv', label: 'conflicted / red' },
      { from: 'mergeadv', to: 'merge', label: 'resolved' },
      { from: 'mergeadv', to: 'blocked', label: 'it cannot' },
      { from: 'checks', to: 'blocked', label: 'never reported / --review' },
      { from: 'merge', to: 'downmerge', label: 'merged' },
      { from: 'merge', to: 'blocked', label: 'GitHub refused' },
      { from: 'blocked', to: 'card' },
      { from: 'card', to: 'you' },
      { from: 'you', to: 'merge', label: 'ship it' },
      { from: 'autoship', to: 'merge', label: 'where a space allows it' },
      { from: 'downmerge', to: 'ladder' },
      { from: 'ladder', to: 'queue' },
      { from: 'queue', to: 'deploy', label: 'you press Ship' },
      { from: 'deploy', to: 'live' },
    ],
  },

  /* ------------------------------------------------------------- 8. amendment */
  {
    id: 'amendment',
    short: 'Amendments',
    title: 'An agent asking to be different',
    icon: '⚖️',
    trigger: 'An agent finishes a task and concludes its foundation stopped it doing something worth doing.',
    summary: `lib/foundation.js made what an agent *is* one object. This is the loop that lets the agent
argue with it. The agent never writes the foundation and never files the bead — both are
beadcause’s, and that separation is the entire safety property: an agent that could amend
itself has no constitution, and an agent that could file its own request could fill your
inbox with its own opinions.`,
    nodes: [
      {
        id: 'ran',
        kind: 'agent',
        label: 'an agent finishes a task',
        detail: 'Any of the five kinds. The reflection question is the last thing in its context, on purpose.',
        agent: ANY_AGENT,
        source: ['lib/advocate.js', 'lib/dispatch.js'],
      },
      {
        id: 'block',
        kind: 'agent',
        label: 'it writes an\n```amendment block',
        detail: 'On stdout. That is the whole of its part in this; everything after it is code you own.',
        agent: ANY_AGENT,
        source: ['lib/amendment.js'],
      },
      {
        id: 'denial',
        kind: 'code',
        label: 'harvest the denial\nfrom the transcript',
        detail:
          'Prohibition and omission are not symmetric. A prohibition is observable — the agent asked for a tool and was denied — so it is harvested as evidence rather than taken on the agent’s word. An omission is not observable at all, and is speculative by construction.',
        source: ['lib/amendment.js', 'lib/transcript.js'],
      },
      {
        id: 'scope',
        kind: 'code',
        label: 'is it in scope,\nand is it AMENDABLE?',
        detail: `A request with no scope is rejected before it can become a bead — "give me Write" is not a
decision anyone can make on a phone; "give me Write under my own directory, because X" is.
A field outside AMENDABLE is not dropped either: it becomes an ordinary bead against the
file a commit would have to touch.`,
        source: ['lib/foundation.js', 'lib/amendment.js'],
        gate: true,
      },
      {
        id: 'bead',
        kind: 'code',
        label: 'file it as an ordinary\n`human` question',
        detail: 'Its own channel on every surface — the pane is drawn above the inbox and outside every filter on it.',
        source: ['lib/amendment.js', 'lib/server.js'],
      },
      {
        id: 'screen',
        kind: 'device',
        label: 'the foundations screen',
        detail: 'What each agent is today, what it has asked for, and the history of what it was allowed to become.',
        source: ['public/foundations.js', 'public/foundations.html'],
      },
      {
        id: 'decide',
        kind: 'human',
        label: 'approve, or decline',
        detail: 'A "no" is remembered — so the same request does not come back every week as though it had never been made.',
        source: ['public/foundations.js'],
      },
      {
        id: 'commit',
        kind: 'store',
        label: 'a commit on\nrefs/beadcause/foundations',
        detail:
          'Written with git plumbing, so nothing touches the working tree and a human mid-edit in the same checkout never sees it. `git log` on that ref reads as the history of what each agent was allowed to become.',
        source: ['lib/gitref.js', 'lib/foundation.js'],
      },
      {
        id: 'effective',
        kind: 'code',
        label: 'baseline ⊕ overlay,\nresolved at spawn',
        detail:
          'Keeping the two apart is what makes both directions safe: editing a baseline prompt in a release does not revert an approved amendment, and an approved amendment does not freeze a copy of a prompt development has moved on from.',
        source: ['lib/foundation.js'],
      },
    ],
    edges: [
      { from: 'ran', to: 'block' },
      { from: 'block', to: 'denial' },
      { from: 'denial', to: 'scope' },
      { from: 'scope', to: 'bead', label: 'amendable, scoped' },
      { from: 'scope', to: 'bead', label: 'protected → a bead against the file instead' },
      { from: 'bead', to: 'screen' },
      { from: 'screen', to: 'decide' },
      { from: 'decide', to: 'commit', label: 'approved' },
      { from: 'commit', to: 'effective' },
      { from: 'effective', to: 'ran', label: 'the next run' },
    ],
  },

  /* ---------------------------------------------------------------- 9. sweeps */
  {
    id: 'sweeps',
    short: 'The cycle',
    title: 'The cycle — one clock, two speeds',
    icon: '🔁',
    trigger: 'setInterval, and the workspace change detector.',
    summary: `Everything unattended in beadcause is a beat of this loop. The fast clock is what a phone
is waiting on; everything else is on the slow one, in an order that is itself an argument —
the sync goes last because it is the only sweep that touches the network *and* takes Dolt’s
write lock, and nothing a phone is waiting on should be behind it. An overlap guard stops a
slow sweep from having a second one started on top of it.`,
    nodes: [
      {
        id: 'beat',
        kind: 'code',
        label: 'beat()\noverlap-guarded',
        detail:
          'At five seconds a slow `bd list` is an ordinary Tuesday — 28 seconds over 500 beads has been measured under load. Without the guard, each new sweep would queue behind the same Dolt lock that made the first one slow. Skipped beats are counted and reported once, when the long one ends.',
        source: ['lib/server.js'],
      },
      {
        id: 'detect',
        kind: 'code',
        label: 'did a workspace move?',
        detail: 'Sampled before anything else and on every beat, so the baseline is always from before the sweep about to read bd. A write landing mid-sweep is seen on the next beat rather than missed.',
        source: ['lib/detect.js'],
        gate: true,
      },
      {
        id: 'tick',
        kind: 'code',
        label: 'tick() — the question sweep',
        detail: 'The fast half. Everything in the Question flow.',
        source: ['lib/server.js'],
      },
      {
        id: 'deploys',
        kind: 'code',
        label: 'settleDeploys',
        detail: 'Reads a directory and may send one notification. Nothing about it should be able to delay a question reaching the phone, which is why it is here and not earlier.',
        source: ['lib/deploy.js'],
      },
      {
        id: 'owed',
        kind: 'code',
        label: 'retryOwedCloses',
        detail: 'A bead whose close was refused when its work landed, tried again now that the blocker may have cleared.',
        source: ['lib/owed.js'],
      },
      {
        id: 'advocates',
        kind: 'code',
        label: 'advocates.tick()',
        detail: 'The whole Advocate flow, once per cycle. The only sweep that opens windows.',
        source: ['lib/advocate.js'],
      },
      {
        id: 'merges',
        kind: 'code',
        label: 'the conflict sweep',
        detail: 'After the tick, because the tick is what finds out about a merge on github.com. One inbox card per sweep: what conflicted, what got fixed, what needs you.',
        source: ['lib/prsweep.js', 'lib/mergesweep.js', 'lib/sweepcard.js'],
      },
      {
        id: 'release',
        kind: 'code',
        label: 'the release sweep',
        detail: 'What has merged and is not running yet.',
        source: ['lib/release.js'],
      },
      {
        id: 'jira',
        kind: 'external',
        label: 'the JIRA poll',
        detail:
          'One query, written in one file, and the JQL is not a parameter — the defence against beadcause growing a general JIRA query surface is that there is no caller who can name one. A failure is never a quietly empty list.',
        source: ['lib/jirapoll.js', 'lib/jira.js'],
      },
      {
        id: 'sync',
        kind: 'external',
        label: 'the tracker sync\nbd dolt push / pull',
        detail:
          'Last, and the ordering is the argument the others make. Which workspaces sync is decided by which have a remote, deliberately not by a list in the config. A sync that stopped is loud; a conflict is louder.',
        source: ['lib/sync.js'],
      },
      {
        id: 'failed',
        kind: 'code',
        label: 'a sweep that failed\nbecomes a bead',
        detail:
          'Every catch in this cycle is right to carry on — none of these may stop the others — but "logged every thirty seconds for a week with nobody reading it" is how a TypeError in a background sweep survives.',
        source: ['lib/crash.js', 'lib/errors.js'],
      },
    ],
    edges: [
      { from: 'beat', to: 'detect' },
      { from: 'detect', to: 'tick', label: 'moved, or the backstop' },
      { from: 'tick', to: 'deploys', label: 'slow clock' },
      { from: 'deploys', to: 'owed' },
      { from: 'owed', to: 'advocates' },
      { from: 'advocates', to: 'merges' },
      { from: 'merges', to: 'release' },
      { from: 'release', to: 'jira' },
      { from: 'jira', to: 'sync' },
      { from: 'sync', to: 'beat', label: 'next beat' },
      { from: 'advocates', to: 'failed', label: 'threw' },
      { from: 'tick', to: 'failed', label: 'threw' },
    ],
  },

  /* --------------------------------------------------------------- 10. errors */
  {
    id: 'errors',
    short: 'Errors',
    title: 'An error the app hits files itself as a P0',
    icon: '🐞',
    trigger: 'An uncaught exception in the browser, a crash in the daemon, or a sweep that threw a bug.',
    summary: `An error in the browser used to be a red toast and nothing else — seen, shown, and lost.
Filing is the easy half; not filing the same thing forty times is the hard half. One broken
selector on a page that re-renders every poll is not forty bugs, and a tracker that says it
is has been made useless by the feature meant to help it.`,
    nodes: [
      {
        id: 'browser',
        kind: 'device',
        label: 'the reporter on the page',
        detail: 'On every page. It refuses to file six specific things — the ones that are the network, the phone, or the app being replaced under it.',
        source: ['public/report.js'],
      },
      {
        id: 'daemon',
        kind: 'code',
        label: 'the daemon’s own\ncrash handler',
        detail: 'It reports itself, through the same door — with the care that door needs, since the thing being reported may be the reporting path.',
        source: ['lib/crash.js'],
      },
      {
        id: 'post',
        kind: 'code',
        label: 'POST /api/error',
        detail: 'The one entrance.',
        source: ['lib/server.js'],
      },
      {
        id: 'hold',
        kind: 'code',
        label: 'is a deploy in flight?',
        detail:
          'Nothing is filed across a deploy, and the daemon is what decides — a swap is not a deploy, so the router leaves a marker of its own. Two of these are filed without the hold, and the reason is said out loud where it is done.',
        source: ['lib/errors.js', 'lib/deploy.js'],
        gate: true,
      },
      {
        id: 'print',
        kind: 'code',
        label: 'fingerprint it',
        detail: 'What decides between three outcomes, and the reason a re-render is one bug rather than forty.',
        source: ['lib/errors.js'],
      },
      {
        id: 'new',
        kind: 'store',
        label: 'a new P0 bead',
        detail: 'Titled from the message.',
        source: ['lib/errors.js'],
      },
      {
        id: 'again',
        kind: 'store',
        label: 'a comment: this happened again',
        detail: 'With when, where and how many times. No second bead. A burst is one comment, not a comment each.',
        source: ['lib/errors.js'],
      },
      {
        id: 'regression',
        kind: 'store',
        label: 'a new bead, `discovered-from`\nthe closed one',
        detail: 'Deliberately not a reopen: a bug that comes back after being fixed is a different fact about the code than one that was never fixed.',
        source: ['lib/errors.js'],
      },
    ],
    edges: [
      { from: 'browser', to: 'post' },
      { from: 'daemon', to: 'post' },
      { from: 'post', to: 'hold' },
      { from: 'hold', to: 'print', label: 'no deploy in flight' },
      { from: 'print', to: 'new', label: 'no match' },
      { from: 'print', to: 'again', label: 'matches an open bead' },
      { from: 'print', to: 'regression', label: 'matches a closed one' },
    ],
  },

  /* ------------------------------------------------------------- 11. surfaces */
  {
    id: 'surfaces',
    short: 'The app',
    title: 'The app itself — four tabs, and everything reachable from them',
    icon: '📱',
    trigger: 'You open the PWA, or tap a notification.',
    summary: `A tab is not a shortcut to a page; it is a claim that the page is somewhere you go
repeatedly. Several pages are reachable, load-bearing and not tabs — Chat, PRs and the
Mirror each lost or never had one, and the argument for each is written where the bar is
built. Everything is loaded once and kept: a tab tap is a repaint, not a fetch.`,
    nodes: [
      {
        id: 'shell',
        kind: 'device',
        label: 'the shell\nservice worker + precache',
        detail:
          'One cache key over every shell file. Whether a branch owes a bump is decided by reading the diff — and the failure mode is the quiet one: two files that changed together, arriving under one key, one of them stale.',
        source: ['public/sw.js', 'lib/swbump.js'],
      },
      {
        id: 'auth',
        kind: 'code',
        label: 'the token, or Google',
        detail: 'A one-time setup link puts the token in localStorage. Signing in with Google is the other door, and whose answer it is is recorded either way.',
        source: ['lib/auth.js', 'public/login.js'],
      },
      {
        id: 'inbox',
        kind: 'device',
        label: '📥 Inbox',
        detail: 'One list, six kinds, a space picker in the top bar, and a filter that says out loud what it is hiding.',
        source: ['public/index.html', 'public/app.js', 'public/inboxfilter.js'],
      },
      {
        id: 'advocates',
        kind: 'device',
        label: '📣 Advocates',
        detail: 'The console the advocates report into, with panes for sessions, pull requests, the board and the Mirror.',
        source: ['public/monitor.html', 'public/monitor.js', 'public/montabs.js'],
      },
      {
        id: 'history',
        kind: 'device',
        label: '📜 History',
        detail: 'The ledger: everything that has been answered, with the door back into a closed conversation.',
        source: ['public/history.html', 'public/history.js'],
      },
      {
        id: 'admin',
        kind: 'device',
        label: '⏸ Admin',
        detail: 'Pause all, resume all, the HTTPS switch, devices, and the things you least want to hit by accident.',
        source: ['public/admin.html', 'public/admin.js'],
      },
      {
        id: 'detail',
        kind: 'device',
        label: 'detail opens *over* the tab',
        detail: 'Not instead of it. One rule for closing a subordinate view, in one place, so the tab is always given back.',
        source: ['public/drawer.js'],
      },
      {
        id: 'stream',
        kind: 'device',
        label: 'the delta stream',
        detail: 'Every view on the event log. A repaint leaves alone what did not change.',
        source: ['public/stream.js', 'lib/events.js'],
      },
      {
        id: 'chat',
        kind: 'device',
        label: '＋ chat sessions',
        detail: 'Not a tab, deliberately — it was the one tab that was also the way to create something.',
        source: ['public/console.js'],
      },
      {
        id: 'foundations',
        kind: 'device',
        label: 'the foundations screen',
        detail: 'What an agent is, what it has asked to become, and what you said.',
        source: ['public/foundations.js'],
      },
      {
        id: 'term',
        kind: 'device',
        label: 'the terminal',
        detail: 'Driving a session from the phone. It keeps running when your screen locks, and survives the daemon.',
        source: ['public/term.js', 'lib/termsocket.js', 'lib/terminal.js'],
      },
      {
        id: 'mirror',
        kind: 'device',
        label: 'the Mirror',
        detail: 'Whatever the phone has open, with room to read it. A pane and not a tab: it is meaningless on the device a bottom tab bar is for.',
        source: ['public/mirror.js', 'lib/presence.js'],
      },
      {
        id: 'editmode',
        kind: 'device',
        label: 'edit mode',
        detail: 'Editing the app from inside the app: the screen holds still and says so, and an element anchors back to the line of source that drew it.',
        source: ['public/editmode.js'],
      },
      {
        id: 'android',
        kind: 'device',
        label: 'the Android shell',
        detail: 'A WebView around the same PWA, plus the notification channel and the five-second wake that means it does not have to sweep to find out.',
        source: ['android/app/src/main/java/m4m/beadcause/MainActivity.kt'],
      },
    ],
    edges: [
      { from: 'shell', to: 'auth' },
      { from: 'auth', to: 'inbox' },
      { from: 'android', to: 'shell' },
      { from: 'inbox', to: 'advocates' },
      { from: 'inbox', to: 'history' },
      { from: 'inbox', to: 'admin' },
      { from: 'inbox', to: 'detail', label: 'tap a card' },
      { from: 'inbox', to: 'chat', label: '＋' },
      { from: 'advocates', to: 'term' },
      { from: 'advocates', to: 'mirror' },
      { from: 'admin', to: 'foundations' },
      { from: 'stream', to: 'inbox' },
      { from: 'stream', to: 'advocates' },
      { from: 'detail', to: 'editmode' },
    ],
  },
];

/**
 * Where each agent kind is actually spawned, as a list of `<flow>/<node>`.
 *
 * Derived rather than written down, so an agent that gains a spawn site gains a line
 * here for free — and an agent nobody spawns shows up as an empty list, which is a fact
 * worth seeing on the screen rather than an omission to notice.
 */
function spawnSites(agent) {
  const out = [];
  for (const flow of FLOWS) {
    for (const node of flow.nodes) {
      if (node.agent === agent) out.push({ flow: flow.id, flowTitle: flow.title, node: node.id, label: node.label });
    }
  }
  return out;
}

/**
 * What each agent is — read out of lib/foundation.js, never restated here.
 *
 * `foundations` lets a caller hand in the *effective* foundations (baseline ⊕ the
 * overlays on refs/beadcause/foundations) so the screen draws what would actually be
 * spawned. The script does not: it renders from a checkout, where reading a ref would
 * mean the same file produced different diagrams on two machines, and the baseline is
 * the thing that ships.
 */
export function agents(foundations = null) {
  return AGENTS.map((id) => {
    const f = foundations?.[id] || baseline(id);
    const m = mark(id);
    return {
      id,
      name: displayName(id),
      title: f.title,
      purpose: f.purpose,
      emoji: m?.emoji || '🤖',
      /** The two that decide how much of the system this agent could break. */
      writes: Boolean(f.writes),
      ownsRepo: Boolean(f.ownsRepo),
      /** Null means "the CLI default, or the config's — applied by the caller at spawn". */
      model: f.model,
      timeoutMs: f.timeoutMs,
      permissionMode: f.permissionMode,
      tools: f.tools,
      allowedTools: f.allowedTools,
      /** The module that parses its output, and the module that writes its brief. */
      protocolOwner: f.protocolOwner,
      briefOwner: f.briefOwner,
      /** The amendable half of the system prompt. Null is honest, not an oversight. */
      role: f.role,
      /**
       * Which fields an approved amendment moved, as `lib/foundation.js`'s `merge`
       * reports them. An array and not a flag, because "amended" alone is the least
       * useful version of this fact: what you want on the screen is *which* of them —
       * a widened allowlist and a raised timeout are not the same news. Empty on the
       * baselines, which is the state the standalone page renders.
       */
      amended: Array.isArray(f.amended) ? [...f.amended] : [],
      spawnedAt: spawnSites(id),
    };
  });
}

/**
 * The whole model, as one object — what both the script and `GET /api/flowchart` return.
 *
 * `counts` is computed rather than written because it is the one number this drawing is
 * for: how much of the system is code and how much is handed to a model.
 */
export function flowchart({ foundations = null } = {}) {
  const roster = agents(foundations);
  const byKind = {};
  for (const k of KINDS) byKind[k.id] = 0;
  for (const flow of FLOWS) for (const n of flow.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;

  return {
    title: 'beadcause — what happens, and what decides it',
    subtitle: 'Every step is either code this repo can be held to, or an agent it cannot.',
    kinds: KINDS,
    flows: structuredClone(FLOWS),
    agents: roster,
    protectedFields: [...PROTECTED],
    amendableFields: [...AMENDABLE],
    counts: { nodes: Object.values(byKind).reduce((a, b) => a + b, 0), byKind, flows: FLOWS.length, agents: roster.length },
  };
}

/** Every source path any node names, deduplicated. What the suite checks exists. */
export function sourcePaths() {
  const out = new Set();
  for (const flow of FLOWS) for (const n of flow.nodes) for (const s of n.source || []) out.add(s);
  return [...out].sort();
}

/**
 * One flow as a mermaid `flowchart`, with a class per kind.
 *
 * Mermaid rather than hand-rolled SVG for one reason: it is already vendored and already
 * rendered inside bead bodies (public/app.js), so a diagram here is drawn by the same
 * engine as a diagram an agent puts on a bead, on a phone that has already cached it.
 *
 * The shape carries the kind as well as the colour, because colour alone is not a
 * distinction on a bad screen in the dark: `code` is a rectangle, `agent` a hexagon,
 * `human` a stadium, `store` a cylinder, `external` a flag, `device` a rounded box, and a
 * gate is a diamond whatever else it is.
 */
export function mermaidFor(flowId, { direction = 'TD' } = {}) {
  const flow = FLOWS.find((f) => f.id === flowId);
  if (!flow) throw new Error(`unknown flow: ${flowId}`);

  /**
   * A label, as mermaid will accept it.
   *
   * Two substitutions, and the second one is not cosmetic. A newline ends a mermaid
   * statement, so a two-line label has to become a `<br/>`; and a **backtick** opens
   * mermaid's markdown-string mode even inside the quotes, which silently fails the
   * whole diagram — not the node, the diagram — leaving its source in the box exactly
   * the way a missing mermaid does. Three flows died that way the first time
   * scripts/flow-check.mjs was widened past the one it opens on, over labels reading
   * `` `bd ready` unblocks `` and ``the ```beads block``. Code voice is worth nothing
   * inside a rounded rectangle, so the backticks are simply dropped.
   */
  const label = (raw) => String(raw).replace(/\n/g, '<br/>').replace(/`/g, '');

  const shape = (n) => {
    const t = JSON.stringify(label(n.label));
    if (n.gate) return `{{${t}}}`;
    switch (n.kind) {
      case 'agent':
        return `[/${t}\\]`;
      case 'human':
        return `([${t}])`;
      case 'store':
        return `[(${t})]`;
      case 'external':
        return `>${t}]`;
      case 'device':
        return `(${t})`;
      default:
        return `[${t}]`;
    }
  };

  const lines = [`flowchart ${direction}`];
  for (const n of flow.nodes) lines.push(`  ${n.id}${shape(n)}`);
  for (const e of flow.edges) {
    const label = e.label ? `|${String(e.label).replace(/[|"]/g, '')}|` : '';
    lines.push(`  ${e.from} -->${label} ${e.to}`);
  }
  // A class per node and deliberately **no `classDef`**. mermaid turns a classDef into
  // inline `style` on the shape, which wins over a stylesheet — so the colours would be
  // frozen at whatever the light scheme happened to be and the diagram would stay light
  // on a phone in the dark. A bare class lets `g.k-agent rect { fill: var(--k-agent-bg) }`
  // do it instead, which follows `prefers-color-scheme` for free.
  //
  // Nothing here is clickable either, for a related reason: mermaid's `click` needs
  // `securityLevel: 'loose'`, which is a global relaxation of the renderer that also
  // draws agent-written diagrams inside bead bodies. The renderer binds taps off the DOM
  // afterwards instead, which costs nothing and grants nothing.
  for (const n of flow.nodes) lines.push(`  class ${n.id} k-${n.kind};`);
  return lines.join('\n');
}

/** Everything wrong with the model, as sentences. Empty is the passing state. */
export function problems({ exists = null } = {}) {
  const out = [];
  const flowIds = new Set();

  for (const flow of FLOWS) {
    if (flowIds.has(flow.id)) out.push(`two flows share the id ${flow.id}`);
    flowIds.add(flow.id);
    if (!flow.trigger) out.push(`${flow.id} has no trigger — every flow hangs off exactly one`);
    // A pill is one line on a phone, and a bar that wraps to four rows is a bar nobody
    // reads. 18 is what fits beside the icon at the size these are drawn.
    if (!flow.short) out.push(`${flow.id} has no short name for its nav pill`);
    else if (flow.short.length > 18) out.push(`${flow.id}: "${flow.short}" is too long for a pill`);

    const ids = new Set();
    for (const n of flow.nodes) {
      if (ids.has(n.id)) out.push(`${flow.id}: two nodes share the id ${n.id}`);
      ids.add(n.id);
      if (!KIND_IDS.has(n.kind)) out.push(`${flow.id}/${n.id}: ${n.kind} is not one of the kinds`);
      if (RESERVED.includes(n.id)) {
        out.push(`${flow.id}/${n.id}: "${n.id}" is a mermaid keyword, so the whole diagram fails to parse — rename it`);
      }
      if (!n.detail) out.push(`${flow.id}/${n.id}: no detail — a box with nothing behind it is a diagram, not a map`);
      if (!n.source?.length) out.push(`${flow.id}/${n.id}: names no source file`);
      if (n.agent && n.agent !== ANY_AGENT && !AGENTS.includes(n.agent)) {
        out.push(`${flow.id}/${n.id}: ${n.agent} is not an agent kind`);
      }
      if (n.kind === 'agent' && !n.agent) {
        out.push(`${flow.id}/${n.id}: drawn as an agent but names no foundation`);
      }
      for (const s of n.source || []) {
        if (exists && !exists(s)) out.push(`${flow.id}/${n.id}: ${s} is not in the tree any more`);
      }
    }
    for (const e of flow.edges) {
      if (!ids.has(e.from)) out.push(`${flow.id}: an edge starts at ${e.from}, which is not a node here`);
      if (!ids.has(e.to)) out.push(`${flow.id}: an edge ends at ${e.to}, which is not a node here`);
    }
    // A node nothing reaches and which reaches nothing is a box somebody forgot to wire
    // up — the one modelling mistake that reads as deliberate in the drawing.
    for (const n of flow.nodes) {
      const touched = flow.edges.some((e) => e.from === n.id || e.to === n.id);
      if (!touched) out.push(`${flow.id}/${n.id}: no edge touches it`);
    }
  }

  // Every agent kind should be drawn somewhere. A kind added to BASELINES and never put
  // on the map is exactly the drift this file exists to make visible.
  for (const a of AGENTS) {
    if (!spawnSites(a).length) out.push(`the ${a} foundation exists and nothing on the map spawns it`);
  }
  return out;
}
