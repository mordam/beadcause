/**
 * What beadcause keeps as evidence, for how long, and how you would know it was altered.
 *
 * A Type II report is not an opinion about the controls that exist today. It asks
 * whether they **operated throughout a period**, and it answers that by sampling the
 * period — three dispatches from March, one deploy from the week of the outage. Any
 * evidence source that is overwritten, rotated without retention, or reset between
 * runs cannot answer a question about March, and a control that cannot be tested is a
 * testing exception rather than a control. An exception in a first report is the part
 * a buyer actually reads.
 *
 * So the thing this file is is a **register**: one entry per evidence class, saying
 * what it is, where it lives, who writes it, what it is evidence *of*, how long it is
 * kept, how it is disposed of, who can alter it, and — the field the rest hangs on —
 * whether you could tell if somebody had. `test/evidence.mjs` is the half that makes
 * it stay true: it walks `lib/` and `bin/` for anything that persists state outside
 * the repo and fails when it appears in neither this register nor `NOT_EVIDENCE`.
 * Adding a module that writes a new file under `~/.config/beadcause` is therefore no
 * longer something you can do without saying how long the file is kept.
 *
 * **A register nobody can fail is a policy document, and policy documents are what
 * this is written instead of.** The rules in `entryProblems` are deliberately the ones
 * that hurt: a class an auditor would sample must be tamper-evident or must name the
 * bead saying it is not; a class kept as evidence with nothing behind it must name one
 * too; a retention shorter than `RETENTION_FLOOR_MONTHS` cannot be stated at all. They
 * live in a function that takes *one* entry rather than reading `REGISTER` itself, so
 * a check can point them at a deliberately broken class — a rule only ever run against
 * a register that passes is a rule nobody has seen fire.
 *
 * **Three integrity mechanisms, and the middle one is weaker than it looks.**
 *
 * - `chained` — the record is a commit on a `refs/beadcause/*` ref, written only
 *   through the compare-and-swap in lib/gitref.js. Every commit's sha covers its
 *   parent, so removing or editing anything but the tip breaks every sha after it.
 *   This is the shape lib/amendment.js established and the shape the rest should
 *   follow; `verifyRef` below is how you demonstrate it rather than assert it.
 * - `history` — the file lives inside the common repo (lib/commonrepo.js), which
 *   commits after each write, so prior versions are recoverable. That is **recovery,
 *   not tamper-evidence**: the snapshot is explicitly best-effort and losable on an
 *   `index.lock` collision, the repo has no remote, and nothing outside it anchors the
 *   head — so a `git reset` there leaves nothing to compare against. Good enough for
 *   "what did this say before the advocate rewrote it", not good enough for an
 *   auditor's sample, which is why `sampled` classes may not rest on it.
 * - `none` — overwritten or deleted in place, ignored by the common repo, with
 *   nothing behind it. Allowed only with a `gap` naming the bead that will fix it.
 *
 * **What is deliberately not in the register.** `NOT_EVIDENCE` is not a waiver list —
 * it is the other half of the same inventory, and each entry has to say why the state
 * it persists is not evidence of anything: it is a credential, it is liveness rewritten
 * every few seconds, it is bookkeeping consumed within thirty seconds by the poll cycle
 * that wrote it, or the module only reads what some other module owns. Those sentences
 * are the ones an auditor will push on, so they are written to be pushed on.
 *
 * **`serves` is prose on purpose, for now.** Naming the criterion a record is evidence
 * *of* is bc-eqn1.2's closed vocabulary and bc-eqn1.3's edges; inventing a second,
 * weaker vocabulary here would be the "three separately-built control sets" failure the
 * epic is written against. These strings are what the corpus will be crosswalked to,
 * not a substitute for it.
 *
 * Nothing here imports lib/config.js, and that is the same rule lib/reposcan.js keeps:
 * the register names paths as text, so it stays a leaf that a check can import without
 * resolving anybody's config directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git, ok } from './gitref.js';

/**
 * The shortest retention that can be stated for anything sampled, in months.
 *
 * Set from the report rather than from the disk: a Type II observation window is
 * twelve months, and the report is relied on by user entities for about twelve months
 * after issuance — during which an auditor, or the buyer's own security review, can
 * come back to the population the sample was drawn from. Twenty-four is the sum, and
 * it is a floor rather than a target. Anything shorter is not a retention decision,
 * it is disk convenience with a number written beside it.
 */
export const RETENTION_FLOOR_MONTHS = 24;

/** How you would know a record had been altered. See the note at the top of the file. */
export const INTEGRITY = Object.freeze(['chained', 'history', 'none']);

/** A bead id, as `gap.bead` has to be written. `bc-eqn1.7` and `bc-4r10` both. */
const BEAD_RE = /^[a-z]{2}-[a-z0-9]+(\.\d+)+$|^[a-z]{2}-[a-z0-9]+$/;

/**
 * The evidence classes.
 *
 * A class is an *artefact*, not a file and not a module: `deployment-record` is one
 * class written by two modules into two places, because "show me that release went
 * through the queue" is one question and an auditor does not care that half the answer
 * is a JSON file and half a directory.
 */
export const REGISTER = Object.freeze([
  {
    id: 'session-transcripts',
    what: 'Every dispatched session, as it was written: the brief it was given, what it did, and what it said back.',
    where: ['refs/beadcause/sessions/<bead> — in the checkout the session ran in'],
    writers: ['lib/sessionlog.js'],
    serves: [
      'change management — what changed a branch, on whose instruction, and under which agent kind',
      'AI system logging — what an autonomous run actually did, in its own words',
    ],
    sampled: true,
    retention: 'permanent',
    disposal:
      'None, and permanence is the consequence of the shape rather than a preference: removing the middle of a commit chain breaks every sha after it, so the disposal unit is the whole ref. Dropping one is a deliberate act against a named bead, not a sweep.',
    alterableBy:
      'anyone with write access to the checkout. Rewriting one is detectable — every later sha changes — but only against a head somebody recorded; see verifyRef and its anchor.',
    integrity: 'chained',
    gap: null,
  },
  {
    id: 'foundation-amendments',
    what: 'What each agent kind is permitted to be, and every approved or declined request to change it.',
    where: ['refs/beadcause/foundations — in the beadcause checkout'],
    writers: ['lib/foundation.js', 'lib/amendment.js'],
    serves: [
      'authorisation — what an unattended agent may do, and who agreed to it',
      'change management — a privilege change is a commit with a human approval behind it',
    ],
    sampled: true,
    retention: 'permanent',
    disposal:
      'None. The declines are the half that must not be pruned: lib/amendment.js seeds a refusal back into the next reflection prompt, so a disposed decline is an argument that starts again from nothing.',
    alterableBy: 'anyone with write access to the checkout; every write goes through the compare-and-swap in lib/gitref.js.',
    integrity: 'chained',
    gap: null,
  },
  {
    id: 'management-transitions',
    what: 'Whether this install has a management system at all, and every time that was turned on or off — with the reason given at the time and the person who gave it.',
    where: ['refs/beadcause/management — in ~/.config/beadcause'],
    writers: ['lib/management.js'],
    serves: [
      'change management — enabling or disabling the whole control layer is itself a change, with an author and a reason, rather than a settings key somebody edited',
      'the observation window — a disabled period is a recorded gap with a stated reason, which is what makes a report over that window mean anything',
    ],
    sampled: true,
    retention: 'permanent',
    disposal:
      'None. Disposing of a transition disposes of the gap it opened, and a window whose gaps have been pruned reads as continuous operation that never happened.',
    alterableBy:
      'anyone with write access to ~/.config/beadcause; every write goes through the compare-and-swap in lib/gitref.js. The honest limit is the one lib/foundation.js has too — the chain answers "was a transition removed from the middle", which `verify()` reports as a hole, and not "was the tip truncated".',
    integrity: 'chained',
    gap: null,
  },
  {
    id: 'merge-notes',
    what: 'A few lines on each commit a session made and on the merge that brought it into main: which bead, which agent, what outcome, and which requirement it fulfils.',
    where: ['refs/notes/beadcause — in the checkout the merge landed in'],
    writers: ['lib/sessionlog.js'],
    serves: [
      'change management — traceability from a requirement to the bead to the immutable commit that satisfied it',
      'authorisation — that what reached main came through a bead and a queue rather than around them',
    ],
    sampled: true,
    retention: 'permanent',
    disposal:
      'None. A note is anchored to a commit that will still be in main in five years, so disposing of the note without disposing of the commit would leave the change with no account of itself.',
    alterableBy:
      "anyone with write access to the checkout. Re-noting uses `git notes add -f`, which overwrites the note and does so as a new commit on the notes ref — so the previous text is behind it rather than gone.",
    integrity: 'chained',
    gap: null,
  },
  {
    id: 'agent-memory',
    what: "What agents have learned and reported: the two memory stores, the cross-agent bus, and every run's debrief.",
    where: [
      'refs/beadcause/memory, refs/beadcause/agents/<kind>, refs/beadcause/bus/<topic>, refs/beadcause/debrief/<bead>',
    ],
    writers: ['lib/memory.js'],
    serves: [
      'AI system records — what an agent was operating on the belief of, at the time it acted',
      'competence and awareness — supporting rather than primary; the control record is the bead and the transcript',
    ],
    sampled: false,
    retention: 'permanent',
    disposal:
      'None today. Keeping an agent-authored store forever is a data-governance question of its own rather than a settled decision, and it is bc-eqn1.10 rather than a rule invented here.',
    alterableBy: 'the agents themselves, through bin/memory.js; every write is a commit on its own ref.',
    integrity: 'chained',
    gap: null,
  },
  {
    id: 'configuration-history',
    what: 'What the daemon was configured to do and when that changed — every non-ignored file in ~/.config/beadcause, with a commit after each write.',
    where: [
      '~/.config/beadcause/config.json',
      '~/.config/beadcause/state.json',
      '~/.config/beadcause/admin.json',
      'the common repo history behind all of them',
    ],
    writers: ['lib/commonrepo.js', 'lib/config.js', 'lib/admin.js'],
    serves: [
      'change management — a configuration change is a commit rather than a file somebody edited',
      'logical access — which accounts, workspaces and repos the daemon was pointed at during the period',
    ],
    sampled: false,
    retention: 'permanent',
    disposal: 'None. Nothing prunes the common repo, and its whole purpose is answering what a state file said before it was rewritten.',
    alterableBy:
      'anyone with write access to ~/.config/beadcause, and the daemon itself. A lost snapshot is expected rather than exceptional — lib/commonrepo.js drops a commit that collides on index.lock.',
    integrity: 'history',
    gap: null,
  },
  {
    id: 'advocate-dispatch-state',
    what: 'Which advocates exist, which are paused, and what each last dispatched — the state an unattended launch is decided from.',
    where: ['~/.config/beadcause/advocates.json'],
    writers: ['lib/advocate.js'],
    serves: ['operations — that unattended dispatch was running, and was paused when it was said to be paused'],
    sampled: false,
    retention: 24,
    disposal:
      'The file is rewritten in place; prior versions live in the common repo history, which nothing prunes. The durable record of any one dispatch is its session transcript and its bead, not this file.',
    alterableBy: 'anyone with write access to ~/.config/beadcause, and the daemon on every tick.',
    integrity: 'history',
    gap: null,
  },
  {
    id: 'console-and-terminal-records',
    what: 'The chat consoles and ptys an operator opened against a repo, and what was said in them.',
    where: ['~/.config/beadcause/consoles/', '~/.config/beadcause/terminals/'],
    writers: ['lib/console.js', 'lib/terminal.js'],
    serves: ['operations — attended work on the system, alongside the unattended runs the transcripts cover'],
    sampled: false,
    retention: 24,
    disposal: 'Reaped when a console or terminal is closed; the file is versioned in the common repo, so closing one leaves the history behind it.',
    alterableBy: 'anyone with write access to ~/.config/beadcause, and the daemon while the surface is live.',
    integrity: 'history',
    gap: null,
  },
  {
    id: 'agent-owned-repos',
    what: "Tier 3 — one git repo per agent kind, holding whatever that agent chose to keep, plus beadcause's log of how it used it.",
    where: ['~/.config/beadcause/agents/<kind>/', '~/.config/beadcause/agents/memory-reads.jsonl'],
    writers: ['lib/agentrepo.js', 'lib/memoryuse.js'],
    serves: ['AI system records — what an agent kept for itself, as distinct from what beadcause kept about it'],
    sampled: false,
    retention: 'permanent',
    disposal:
      'None today, and the same open question as agent-memory. Ignored by the common repo on purpose — a nested repo swept into the shared history is the exact thing lib/commonrepo.js refuses — so each one is its own history rather than part of that one.',
    alterableBy: 'the agent that owns it, through bin/agentrepo.js. Each directory is a git repo of its own with a commit per write.',
    integrity: 'history',
    gap: null,
  },
  {
    id: 'agent-run-logs',
    what: 'The streamed output of a dispatched run, line by line, as the phone tails it.',
    where: ['~/.config/beadcause/logs/<workspace>_<bead>.log'],
    writers: ['lib/agentlog.js'],
    serves: [
      'AI system logging — what a run did while it was doing it, including the runs that failed',
      'incident handling — the retried run is the one an incident is reconstructed from, and it is the one currently destroyed',
    ],
    sampled: true,
    retention: RETENTION_FLOOR_MONTHS,
    disposal:
      'No disposal rule can be stated while there is no retention: reset() deletes the previous run outright at the next dispatch, and logs/ is ignored by the common repo, so there is nothing to dispose of. The rule above is what should hold once bc-eqn1.7 lands.',
    alterableBy: 'anyone with write access to ~/.config/beadcause. The daemon truncates it at every dispatch.',
    integrity: 'none',
    gap: {
      bead: 'bc-eqn1.7',
      says:
        'lib/agentlog.js reset() removes the previous run rather than archiving it, so the record survives exactly until the next dispatch at the same bead — and a retried run, which is the one worth reading, is the one guaranteed to be gone.',
    },
  },
  {
    id: 'deployment-record',
    what: 'What was shipped, when, from which commit, and whether the swap took — the ledger and the per-deploy records behind it.',
    where: ['~/.config/beadcause/releases.json', '~/.config/beadcause/deploys/'],
    writers: ['lib/release.js', 'lib/deploy.js'],
    serves: [
      'change management — that a change reached production through the queue rather than around it',
      'availability — that a failed swap was detected and condemned rather than served',
    ],
    sampled: true,
    retention: RETENTION_FLOOR_MONTHS,
    disposal: 'Neither is pruned today; both are versioned in the common repo, so a rewritten ledger leaves its prior versions behind it.',
    alterableBy: 'anyone with write access to ~/.config/beadcause, and the daemon on every ship.',
    integrity: 'history',
    gap: {
      bead: 'bc-j3d5',
      says:
        'the deployment record rests on the common repo, whose snapshot is best-effort, whose head nothing outside anchors, and which is written by the same process that writes the file — so it answers "what did this say before" and not "was this altered". A sampled class needs the chained shape.',
    },
  },
]);

/**
 * State that is persisted and is not evidence of anything, with the sentence saying why.
 *
 * The point of writing these down at all is that the check below cannot tell the
 * difference between a file nobody thought about and a file somebody decided about.
 * Every module that touches `CONFIG_DIR` or a `refs/beadcause/*` ref has to be in one
 * list or the other, and the cost of the exemption is having to write the reason.
 */
export const NOT_EVIDENCE = Object.freeze([
  {
    file: 'lib/evidence.js',
    why: 'this register. It names every path and ref below and writes none of them.',
  },
  {
    file: 'lib/changesample.js',
    why: 'reads the sample and writes none of it — it names refs/beadcause/sessions/<bead> in the cells of its report to say where a fact came from, which is the citation and not a write. Its own header is explicit that assembling the records rather than reading them would be producing the wrong artefact; the writers are lib/sessionlog.js and lib/mergebead.js.',
  },
  {
    file: 'lib/reqindex.js',
    why: "a cache, and it says so of itself: every edge on refs/beadcause/requirements/<token> can be rebuilt from refs/notes/beadcause by `rebuildFrom`, and test/reqindex.mjs asserts exactly that. The record is the note, which is anchored to an immutable commit; an index that could not be rebuilt would be one nobody could trust after a bad write, and what fills this is agents.",
  },
  {
    file: 'lib/activity.js',
    why: 'status.json is liveness, rewritten every few seconds and ignored by the common repo for that reason. What a run did is the transcript and the run log, not the phase chip that was showing at the time.',
  },
  {
    file: 'lib/coverage.js',
    why: 'coverage.json is what `npm run coverage` last published — a few hundred kilobytes rewritten whole per measurement and meaningless against any commit but the one stamped inside it. The evidence that tests ran is the CI check on the pull request.',
  },
  {
    file: 'lib/mergesweep.js',
    why: 'merge-sweeps.json is one line naming a repo to sweep, consumed by the next poll cycle within about thirty seconds. What it recorded is already on the pull request it merged.',
  },
  {
    file: 'lib/sweepcard.js',
    why: 'sweep-cards.json is the follow-up half of merge-sweeps.json — inbox rows chased until every resolver has finished and then deleted. It is bookkeeping about a bead, and the bead is where the history of it lives.',
  },
  {
    file: 'lib/owed.js',
    why: 'owed-closes.json is a queue of closes the daemon still has to make; each entry leaves the queue by becoming a close on the bead, which is the record.',
  },
  {
    file: 'lib/resolvers.js',
    why: 'resolvers.json tracks conflict-resolver sessions that are currently open. A finished one leaves its evidence on the pull request and in its own session transcript.',
  },
  {
    file: 'lib/auth.js',
    why: "credentials — the session signing key and Google's client secret. A secret is not evidence, its rotation is; and the common repo refuses to commit either of them.",
  },
  {
    file: 'lib/slack.js',
    why: 'credentials — the Slack bot and app tokens.',
  },
  {
    file: 'lib/atlassian.js',
    why: 'credentials — the JIRA and Confluence API tokens, in files this module only resolves the path of.',
  },
  {
    file: 'lib/jira.js',
    why: 'resolves the path of a credential file the config may name; writes nothing under it.',
  },
  {
    file: 'lib/confluence.js',
    why: 'resolves the path of a credential file the config may name; writes nothing under it.',
  },
  {
    file: 'lib/tls.js',
    why: 'the tailnet certificate and its private key, re-fetchable at any time with `tailscale cert`. A certificate is not a record of anything having happened.',
  },
  {
    file: 'lib/agentview.js',
    why: 'reads advocates.json and the foundation ref to draw a screen. The writers are lib/advocate.js and lib/foundation.js.',
  },
  {
    file: 'bin/monitor.js',
    why: 'reads status.json to print what the daemon is doing. Writes nothing.',
  },
]);

/* ------------------------------------------------------- reading this repo */

/**
 * Comments blanked, everything else kept, and the length preserved.
 *
 * Every file in this repo argues in prose that names the identifiers around it, so a
 * scan that does not do this finds `CONFIG_DIR` in the paragraph explaining that a
 * module deliberately does not touch it — the same wrong answer described in the note
 * at the top of `public/editmode.js`. Strings are kept, because `refs/beadcause/…` is
 * only ever a string, and the blanking preserves offsets so a hit could still be
 * reported against its own line.
 */
export function blankComments(source) {
  const s = String(source);
  let out = '';
  let i = 0;
  // 0 = code, and the template stack is what lets `${`…`}` nest, which this repo does.
  const stack = [];
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    const top = stack[stack.length - 1];

    if (top === "'" || top === '"') {
      if (c === '\\') {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === top) stack.pop();
      out += c;
      i++;
      continue;
    }

    if (top === '`') {
      if (c === '\\') {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '$' && next === '{') {
        stack.push('{');
        out += '${';
        i += 2;
        continue;
      }
      if (c === '`') stack.pop();
      out += c;
      i++;
      continue;
    }

    // In code, or inside a `${…}` hole, which is code too.
    //
    // A backslash out here is only ever inside a regex literal, and skipping the pair
    // is what keeps `/https?:\/\//` from being read as a comment: the scanner would
    // otherwise land on the final `\/` `/` and blank the rest of the line. It fails in
    // the quiet direction — content disappears rather than appearing — which is the
    // worst kind for an inventory that is supposed to notice a new writer.
    if (c === '\\') {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '/' && next === '/') {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end === -1 ? s.length : end + 2;
      out += s.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') stack.push(c);
    else if (c === '{' && top === '{') stack.push('{');
    else if (c === '}' && top === '{') stack.pop();
    out += c;
    i++;
  }
  return out;
}

/**
 * `CONFIG_DIR` as an identifier of its own — never the tail of `CLAUDE_CONFIG_DIR`.
 *
 * That distinction is most of the accuracy here: seven modules mention the Claude
 * one while touching none of ours, and half a dozen more mention `BEADCAUSE_CONFIG_DIR`
 * as the environment variable a test sets.
 */
const CONFIG_DIR_RE = /(?<![A-Za-z0-9_$])CONFIG_DIR(?![A-Za-z0-9_$])/;

/**
 * Both ref families, and the second one is easy to leave out.
 *
 * `refs/beadcause/*` is the obvious half. `refs/notes/beadcause` is the other, and it
 * holds the *authoritative* record of what landed — lib/sessionlog.js says so of itself,
 * and lib/reqindex.js is a cache of it. A scan that matched only the first prefix would
 * have found sessionlog anyway, by its other ref, and would silently stop covering the
 * notes the day somebody moved them into a module of their own.
 */
const BEADCAUSE_REF_RE = /refs\/beadcause\/|refs\/notes\/beadcause/;

/** Does this source persist state outside the repo — and by which of the two routes? */
export function persistsState(source) {
  const code = blankComments(source);
  return { configDir: CONFIG_DIR_RE.test(code), ref: BEADCAUSE_REF_RE.test(code) };
}

/**
 * Every module in the repo that persists state outside it, as repo-relative paths.
 *
 * `lib/` and `bin/` only. `scripts/` is deliberately out: every check there runs
 * against a throwaway `BEADCAUSE_CONFIG_DIR` it makes and deletes, so what they write
 * is a fixture rather than a record — and sweeping them in would put fifteen exemptions
 * in the list above that all say the same thing.
 */
export function stateModules(root) {
  const found = [];
  for (const dir of ['lib', 'bin']) {
    const abs = path.join(root, dir);
    let names;
    try {
      names = fs.readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.js')) continue;
      const rel = `${dir}/${name}`;
      const { configDir, ref } = persistsState(fs.readFileSync(path.join(abs, name), 'utf8'));
      if (configDir || ref) found.push(rel);
    }
  }
  return found;
}

/* ---------------------------------------------------------- what must hold */

const isMonths = (v) => Number.isInteger(v) && v >= RETENTION_FLOOR_MONTHS;
const prose = (v) => typeof v === 'string' && v.trim().length >= 20;

/**
 * Everything wrong with one entry, as sentences.
 *
 * Split out from `registerProblems` so the rules can be *proved* rather than asserted:
 * `REGISTER` is frozen and is supposed to be clean, so a check that only ever runs the
 * rules against it can tell you the register passes and cannot tell you the rules would
 * ever fail. `test/evidence.mjs` runs this one against deliberately-broken entries.
 */
export function entryProblems(e) {
  const problems = [];
  const at = `REGISTER[${e.id || '?'}]`;
  if (!/^[a-z][a-z0-9-]*$/.test(String(e.id || ''))) problems.push(`${at}: id must be kebab-case`);

  if (!prose(e.what)) problems.push(`${at}: \`what\` must say what the artefact is, in a sentence`);
  if (!Array.isArray(e.where) || !e.where.length) problems.push(`${at}: \`where\` must name at least one location`);
  if (!Array.isArray(e.writers) || !e.writers.length) problems.push(`${at}: \`writers\` must name the modules that write it`);
  if (!Array.isArray(e.serves) || !e.serves.length) problems.push(`${at}: \`serves\` must say what it is evidence of`);
  if (typeof e.sampled !== 'boolean') problems.push(`${at}: \`sampled\` must be true or false — would an auditor draw from this`);
  if (!prose(e.disposal)) problems.push(`${at}: \`disposal\` must say how it ends, in a sentence`);
  if (!prose(e.alterableBy)) problems.push(`${at}: \`alterableBy\` must say who can change it, in a sentence`);
  if (!INTEGRITY.includes(e.integrity)) problems.push(`${at}: \`integrity\` must be one of ${INTEGRITY.join(', ')}`);

  if (e.retention !== 'permanent' && !isMonths(e.retention)) {
    problems.push(
      `${at}: \`retention\` must be 'permanent' or a whole number of months no smaller than ${RETENTION_FLOOR_MONTHS} — ` +
        "the floor is the observation window plus the report's useful life, and a shorter number is disk convenience"
    );
  }

  if (e.gap !== null) {
    if (!e.gap || !BEAD_RE.test(String(e.gap.bead || ''))) problems.push(`${at}: \`gap.bead\` must name the bead that fixes it`);
    if (!prose(e.gap?.says)) problems.push(`${at}: \`gap.says\` must say what is missing, in a sentence`);
  }

  // The two rules that cost something, and everything above is only there to stop
  // these two being answered with a word. Each is a claim the register would otherwise
  // be free to make with nobody owning it.
  //
  // There is no third rule for "kept forever with nothing behind it": `permanent` plus
  // `none` is already caught by the second, and a rule that can never be the only one
  // to fire is a rule nobody can test.
  if (e.sampled && e.integrity !== 'chained' && !e.gap) {
    problems.push(
      `${at}: sampled by an auditor and not chained — ${e.integrity === 'history' ? 'the common repo answers "what did this say before", not "was this altered"' : 'nothing stands behind it'}. ` +
        'Chain it, or name the bead that will.'
    );
  }
  if (e.integrity === 'none' && !e.gap) {
    problems.push(`${at}: kept as evidence with nothing behind it. Name the bead that fixes it, or say in NOT_EVIDENCE why it is not evidence.`);
  }

  return problems;
}

/**
 * Everything wrong with the register, as sentences.
 *
 * Returned rather than thrown so one run names every problem: a register is edited in
 * bulk — a class gains a writer, a gap closes — and fixing these one exception at a
 * time is how a check stops being run.
 */
export function registerProblems() {
  const problems = [];
  const seen = new Set();

  for (const e of REGISTER) {
    if (seen.has(e.id)) problems.push(`REGISTER[${e.id}]: duplicate id`);
    seen.add(e.id);
    problems.push(...entryProblems(e));
  }

  for (const x of NOT_EVIDENCE) {
    if (typeof x.file !== 'string' || !x.file) problems.push('NOT_EVIDENCE: an entry with no file');
    if (!prose(x.why)) problems.push(`NOT_EVIDENCE[${x.file}]: \`why\` must say why this is not evidence, in a sentence`);
  }

  return problems;
}

/** Every module the register or its exemptions claim, as a map to what claims it. */
export function claimed() {
  const map = new Map();
  for (const e of REGISTER) for (const w of e.writers) map.set(w, `REGISTER[${e.id}]`);
  for (const x of NOT_EVIDENCE) map.set(x.file, 'NOT_EVIDENCE');
  return map;
}

/**
 * The inventory against the repo: what persists state and is claimed by neither list,
 * and what is claimed by one of them and no longer persists anything.
 *
 * The second half is what keeps the register from rotting quietly. An exemption whose
 * module stopped writing state is a sentence nobody will ever re-read, and a writer
 * that moved is a class pointing at a file that is not the one doing the writing.
 */
export function coverageProblems(root, claims = claimed()) {
  const problems = [];
  const modules = new Set(stateModules(root));

  for (const m of modules) {
    if (!claims.has(m)) {
      problems.push(
        `${m} persists state outside the repo and appears in neither REGISTER nor NOT_EVIDENCE — ` +
          'say what its retention is, or say why what it writes is not evidence'
      );
    }
  }
  for (const [m, by] of claims) {
    if (!fs.existsSync(path.join(root, m))) problems.push(`${by} names ${m}, which does not exist`);
    else if (!modules.has(m)) {
      problems.push(
        `${by} names ${m}, which no longer touches CONFIG_DIR or a refs/beadcause ref — ` +
          'the entry is stale, and a stale entry reads as a decision somebody made'
      );
    }
  }
  return problems;
}

/* ------------------------------------------------- demonstrating the chain */

/**
 * Walk a `refs/beadcause/*` ref and report whether its chain is intact.
 *
 * This is the difference between claiming the `chained` classes are tamper-evident and
 * showing it. Three separate answers, because they fail separately:
 *
 * - `linear` — no commit has two parents. A merge into an evidence ref means two
 *   histories were joined and neither is the record any more.
 * - `intact` — every parent a commit names is itself in the walk, back to a single
 *   root. This is what a truncated or grafted history fails.
 * - `anchored` — an `anchor` sha somebody wrote down earlier is still in the walk.
 *   **This is the only one of the three that can detect a deliberate rewrite**, and it
 *   is null for every caller today, because nothing in beadcause records a head to pass
 *   — that is bc-hzu4. A rewritten history is perfectly self-consistent, so intactness
 *   alone proves only that the thing you are holding is a chain, not that it is the
 *   chain that was there in March. The parameter is here rather than filed away with
 *   the bead because the missing half is the *store*, not the check.
 */
export async function verifyRef(cwd, ref, { anchor = null } = {}) {
  const head = (await ok(git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])))?.trim() || null;
  if (!head) return { ref, head: null, length: 0, linear: false, intact: false, anchored: anchor ? false : null, why: 'no such ref' };

  const out = await git(cwd, ['rev-list', '--parents', head]);
  const rows = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/));

  const shas = new Set(rows.map((r) => r[0]));
  let linear = true;
  let intact = true;
  let roots = 0;
  for (const [, ...parents] of rows) {
    if (parents.length > 1) linear = false;
    if (!parents.length) roots++;
    for (const p of parents) if (!shas.has(p)) intact = false;
  }
  if (roots !== 1) intact = false;

  return {
    ref,
    head,
    length: rows.length,
    linear,
    intact,
    anchored: anchor ? shas.has(String(anchor).trim()) : null,
    why: null,
  };
}
