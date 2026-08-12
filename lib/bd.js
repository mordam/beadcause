import { execFile } from 'node:child_process';
import { UNENDORSED } from './endorse.js';
import { isSuperseded } from './superseded.js';
import { ownAddresseeLabels } from './addressee.js';

/**
 * Adapter around the `bd` CLI.
 *
 * Two things matter here:
 *
 * 1. We spawn `bd` DIRECTLY, never through a shell. `~/.zshenv` runs
 *    `_bd_set_workspace`, which rewrites BEADS_DIR from the shell's cwd — so
 *    `BEADS_DIR=... zsh -c 'bd ...'` silently resolves to the wrong workspace.
 *    execFile does no shell startup, so the BEADS_DIR we pass is the one that
 *    sticks, and one daemon can serve every workspace at once.
 *
 * 2. Embedded Dolt is single-writer. A write racing an agent session's write
 *    fails on the lock, so writes retry with backoff. Do NOT reach for
 *    BEADS_DOLT_SHARED_SERVER to dodge that: the workspaces pin
 *    dolt_mode="embedded" in .beads/metadata.json, and forcing shared mode makes
 *    every command fail against a Dolt server that isn't running. It's
 *    config-gated (`sharedServer: true`) for anyone who has run `bd dolt start`.
 *
 * 3. **Who a write is attributed to is per-call, not per-daemon.** `this.actor` is
 *    the default and it is "beadcause" — right for everything the daemon does on its
 *    own, and wrong for the one caller that now has a name: a browser holding a
 *    Google session (lib/auth.js). Every write method therefore takes `{ actor }`,
 *    and the handlers for the things a person *says* or *decides* — an answer, a
 *    comment, a dismissal note, the beads a "yes" files, the verdict a pull request
 *    gets — pass the signed-in address so the bead's history says who said it.
 *    Omitting it is the old behaviour exactly, which is what keeps the token callers
 *    (ntfy, the Android app, `curl`) writing as they always have.
 *
 *    **What `--actor` actually writes on a create is `created_by`, and never
 *    `owner`.** Worth stating because the opposite was assumed, and it is the whole
 *    reason attributing a create is safe: `owner` comes from the *git identity* of
 *    the directory bd runs in, is untouched by the flag and by BEADS_ACTOR, and is
 *    what `bd ready` and beadcause's own agent list read as "whose queue is this".
 *    Verified against the real binary in `test/attribution.mjs`, which files one bead
 *    each way and asserts both come back ready with the same owner.
 */

const LOCK_RE = /(lock|locked|another process|resource busy|database is busy)/i;

/**
 * How many times the three sweep reads retry a *lock* before giving up.
 *
 * Reads used not to retry at all, on the reasoning that a read is cheap to repeat on
 * the next poll. That reasoning was wrong about what the failure costs: the poll is
 * thirty seconds away, and in the meantime the inbox has drawn the repo as empty and
 * told you there is nothing to answer (bc-ksdc). A write has retried since the
 * beginning for exactly the collision this is — around twenty agent sessions share
 * these workspaces and embedded Dolt is single-writer.
 *
 * Two rather than the four a write gets, because a read is on the request path: this
 * is at most 400ms + 800ms added to a sweep that already failed, and only ever for an
 * error that matches LOCK_RE. Anything else still fails on the first attempt, at once.
 */
const SWEEP_RETRIES = 2;

/**
 * Children, in the order a person reads them: what is left, then what is finished.
 *
 * Ids are compared numerically rather than as text, because bd's own are `bc-goo.1`
 * through `bc-goo.10` and a plain string sort files the tenth child between the first
 * and the second.
 */
const byDoneThenId = (a, b) =>
  Number(a.status === 'closed') - Number(b.status === 'closed') ||
  String(a.id).localeCompare(String(b.id), 'en', { numeric: true });

/**
 * How long any one `bd` invocation gets before it is killed — two minutes, and the
 * number is measured rather than picked.
 *
 * It used to be thirty seconds, and thirty seconds is a ceiling this laptop clears on an
 * ordinary afternoon. The largest read here — `bd list --all` over 503 beads — answers in
 * **about a second idle and took 28.6 seconds under a load average of 33**: twenty agent
 * sessions and a full `npm test`, which is what a Tuesday looks like on this machine, not
 * a pathological case. `Bd.listAll` was given a ceiling of its own when that was measured
 * (bc-nib3.1), and that fixed one call site out of seven — while the six it did not fix
 * are the *small* reads that run on a timer, across every workspace, every thirty seconds.
 *
 * **A timeout is not a slow answer, it is a broken workspace.** `execFile` kills the
 * child, `run` rejects, and every caller downstream reads that as "this repo failed": the
 * sweep puts it in `trouble` (lib/sweep.js), `/api/work` draws it as an error, and
 * lib/history.js turns it into a row in `errors[]`. So the failure mode of a busy laptop
 * was repos reporting as broken while bd was merely slow — and on a thirty-second poll it
 * recurred for as long as the load lasted.
 *
 * **A default rather than a ceiling per call**, because a per-call ceiling is exactly what
 * was already tried and it is one call site away from the same bug every time somebody
 * adds a read. Reads are the argument for the number and writes get it too, which is
 * deliberate on both counts:
 *
 *  - **A read cannot block anything.** None of these queues behind Dolt's single writer,
 *    so a ceiling nobody hits costs one slow request and nothing else.
 *  - **A killed write is worse than a slow one.** What the old default did to a write on
 *    a loaded machine was SIGTERM it mid-`bd`; waiting is the safer of the two.
 *  - **A timeout never retries** (see `run`), so this is one ceiling per call and not
 *    four — which is what would have made two minutes on the request path indefensible.
 *
 * The cost of being wrong in this direction is that a genuinely hung `bd` is noticed a
 * minute and a half later than it was. The cost of being wrong in the other direction is
 * the screen this app exists never to show: a repo full of open questions, drawn as quiet.
 */
export const BD_TIMEOUT = 120_000;

/** Seconds, because that is what a ceiling is argued about in — but never a rounded `0s`. */
const fmtMs = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);

export class Bd {
  /**
   * `me` is who this Mac's questions are for, and it is not the same thing as `actor`.
   *
   * `actor` is a byline — the string `beadcause`, identical on every machine, which is
   * exactly why it cannot answer "whose question is this" on a tracker six people
   * share. `me` is the person holding this laptop, and it is stamped onto every
   * question this daemon files so the other five phones can stay dark about it. Absent
   * — the default, and every install that has never heard of this — nothing is stamped
   * and every question is everybody's. See lib/addressee.js.
   */
  constructor({ bin, actor, sharedServer = false, me = null }) {
    this.bin = bin;
    this.actor = actor;
    this.sharedServer = sharedServer;
    this.me = me;
  }

  /**
   * `actor` overrides who this one command is written as. See `Bd.actor` above for
   * why it is a flag and not just an env var.
   *
   * Null or absent means `this.actor` — "beadcause" — which is what every caller
   * meant before there was anything else to be, and what every caller without a face
   * still means: an ntfy action button, the Android app, `curl`, the poller. Only a
   * request carrying a signed-in session has an address to pass here, and only the
   * handlers for the things a *person* says pass it (see lib/server.js).
   */
  run(workspace, rawArgs, { retries = 0, timeout = BD_TIMEOUT, actor = null } = {}) {
    const who = actor || this.actor;
    const env = {
      ...process.env,
      BEADS_DIR: workspace.dir,
      BEADS_ACTOR: who,
    };
    if (this.sharedServer) env.BEADS_DOLT_SHARED_SERVER = '1';
    else delete env.BEADS_DOLT_SHARED_SERVER;

    // BEADS_ACTOR is NOT enough: a workspace config.yaml with `actor: "…"` beats
    // the env var — observed with a workspace pinning a personal address — so
    // comments written from the phone came back attributed to the human rather
    // than to beadcause, and reply-detection then notified you about your own
    // comments. The --actor flag does win.
    const args = [...rawArgs, '--actor', who];
    const attempt = (left) =>
      new Promise((resolve, reject) => {
        execFile(
          this.bin,
          args,
          { env, cwd: workspace.dir, timeout, maxBuffer: 32 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (!err) return resolve(stdout);
            const detail = `${stderr || ''}${stdout || ''}`;
            // A child *we* killed is not a child that failed, and it is the one error here
            // that arrives with nothing to explain itself: the timeout above SIGTERMs bd
            // mid-answer, so stderr is empty and `err.message` is Node's own "Command
            // failed". Undecorated, that reads downstream — in `trouble`, in `errors[]`, on
            // the phone — as a broken tracker rather than a slow one. `killed` is set when
            // maxBuffer is blown as well, which is a real failure, so that one is left to
            // fall through and say so.
            const timedOut = Boolean(err.killed) && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            // And it must not be retried. A retry is for the Dolt lock, where waiting is the
            // fix; here it would spend the whole ceiling again on a machine that has just
            // proved it is too busy to answer inside it.
            if (!timedOut && left > 0 && LOCK_RE.test(detail)) {
              const wait = (retries - left + 1) * 400;
              return setTimeout(() => attempt(left - 1).then(resolve, reject), wait);
            }
            // `bd … <verb> in <ws>: <sentence>` on both branches, because lib/sweep.js
            // strips everything up to that colon before the phone sees it — so the half
            // that has to survive a four-inch screen is the half after it.
            const e = new Error(
              timedOut
                ? `bd ${args.join(' ')} timed out in ${workspace.name}: still running after ${fmtMs(timeout)}, killed rather than broken`
                : `bd ${args.join(' ')} failed in ${workspace.name}: ${detail.trim() || err.message}`
            );
            e.timedOut = timedOut;
            e.stdout = stdout;
            e.stderr = stderr;
            reject(e);
          }
        );
      });
    return attempt(retries);
  }

  async json(workspace, args, opts) {
    const out = await this.run(workspace, [...args, '--json'], opts);
    return parseJson(out);
  }

  /** Open issues carrying the `human` label, with their full description. */
  async listHuman(workspace) {
    const rows = await this.json(workspace, ['human', 'list'], { retries: SWEEP_RETRIES });
    return (rows || []).filter((r) => r && r.status !== 'closed');
  }

  async show(workspace, id) {
    const rows = await this.json(workspace, ['show', id]);
    return (rows || [])[0] || null;
  }

  async comments(workspace, id) {
    try {
      return (await this.json(workspace, ['comments', id])) || [];
    } catch {
      return [];
    }
  }

  /**
   * Would `bd close` refuse this bead, and why?
   *
   * bd has two gates on a close, and answering a question tripped either of them
   * the same way: the comment went in, the close threw, and the whole answer came
   * back to the phone as an error over a question that had in fact been answered.
   * The card stayed in the inbox looking untouched, so it got answered again —
   * five beads across two workspaces ended up carrying the same answer two and
   * three times over.
   *
   * There is no `--dry-run` on `bd close` (and `--readonly` refuses the operation
   * before it evaluates anything), so the gates are asked about rather than
   * attempted. Both are **measured** against the binary rather than guessed at, and
   * measured is now literal: test/closegatereal.mjs builds each of these shapes in a
   * throwaway workspace and asserts that what this returns and what `bd close` then
   * does are the same answer. bd 1.1.2, on 2026-08-11:
   *
   *   - **blocked by open issues** — the `blocks` dependencies `bd show` already
   *     returns, minus the closed ones. This is the same list bd names, and `bd show`
   *     carries only *outgoing* edges, so what blocks this bead is all that is there.
   *   - **an epic with open children** — one extra call, and only for an epic,
   *     because children are not in `dependencies` at all.
   *
   * Two things about that pair are easy to assume the other way round, and both cost
   * somebody an hour:
   *
   *   - **`epic` means the word, not "has children".** A `feature`, `task`, `bug` or
   *     `chore` closes over as many open children as it likes, and bd says nothing.
   *     bc-5864 was filed on that: bc-rk2o closed by bin/deliver.js while bc-rk2o.1
   *     was still open, read as bd permitting a close this would have refused. bc-rk2o
   *     is a feature. Nothing disagreed with anything.
   *   - **Not-closed is what counts, not open.** `in_progress` and `deferred` are both
   *     still a child, and both still a blocker — which is why the filters here are
   *     `!== 'closed'` and not a list of the statuses that gate.
   *
   * **bin/deliver.js does not ask this, and that is agreement rather than a second
   * opinion.** It attempts the close and handles the refusal (`oweClose`, then a
   * comment saying so in bd's own words), because a delivery has already merged by
   * then and has somewhere to put a refusal. A tap on a card has not: it is about to
   * write a comment it cannot take back. Same rules, both paths — one asks first, the
   * other cleans up after, and bd is the thing refusing in both.
   *
   * Reordering to close-before-comment would have been the other way to learn
   * this, and it trades one lost answer for another: a close that succeeds and a
   * comment that then fails on the Dolt lock leaves the bead closed with nothing
   * recorded on it. Asking first costs one `bd show` and writes nothing either way.
   *
   * Returns `null` when the close would go through. Anything else is the reason
   * it would not, in the words the phone shows you.
   */
  async closeGate(workspace, id) {
    let issue;
    try {
      issue = await this.show(workspace, id);
    } catch {
      // Not being able to ask is not the same as being refused. Let the close
      // itself be the judge rather than blocking an answer on a failed lookup.
      return null;
    }
    return this.gateFor(workspace, issue);
  }

  /**
   * The gate, given an issue `show` has already returned.
   *
   * Split out because two callers want it from one lookup: `closeGate` above, and
   * `hold` below, which needs the comment count off the same issue and should not
   * pay for a second `bd show` to get it.
   */
  async gateFor(workspace, issue) {
    if (!issue) return null;

    const blockers = (issue.dependencies || [])
      .filter((d) => d && d.dependency_type === 'blocks' && d.status !== 'closed')
      .map((d) => ({ id: d.id, title: d.title || '' }));
    if (blockers.length) {
      return { kind: 'blocked', blockers, reason: `blocked by ${blockers.map((b) => b.id).join(', ')}` };
    }

    if (issue.issue_type === 'epic') {
      let children = [];
      try {
        children = await this.children(workspace, issue.id);
      } catch {
        return null;
      }
      const open = children.filter((c) => c.status !== 'closed').map((c) => ({ id: c.id, title: c.title }));
      if (open.length) {
        return {
          kind: 'epic',
          blockers: open,
          reason: `an epic with ${open.length} open child ${open.length === 1 ? 'issue' : 'issues'}`,
        };
      }
    }
    return null;
  }

  /**
   * A bead's children — all of them, closed included.
   *
   * This is a second `bd` call and there is no way around it. `bd show --json` does
   * not carry children: on bc-goo, an epic with seven, it returns `dependent_count: 7`
   * and no rows whatsoever. The *text* output of `bd show` has a CHILDREN section, the
   * JSON has nothing to read it from — so `bd list --parent` is the one that knows.
   *
   * Each of the three flags is load-bearing:
   *
   *  - **`--all`**, because `bd list` hides closed issues by default, and on a finished
   *    epic the closed children are nearly all of what there is to show. bc-goo comes
   *    back as one row without it and seven with.
   *  - **`--limit 0`**, because the default is 50 and the truncation is silent. A list
   *    that prints "6/7 done" beside itself cannot be quietly cut off at fifty.
   *  - `--json`, via `json()`.
   *
   * Rows arrive with the full description on every one of them — kilobytes each, for a
   * list that draws an id and a title — so only what is drawn survives the trip.
   *
   * Three callers now, and none of them may have the list pre-filtered: the panel that
   * draws it, `gateFor` above deciding whether an epic is a question or a question's
   * future, and lib/advocate.js deciding whether an epic is work or the *sum* of work
   * already in its queue. All three ask the same thing of it — are any of these still
   * open — which is why `--all` is here and no `status` filter is.
   *
   * **Order is decided here**, because bd's own is neither id nor status: bc-goo prints
   * its seven as 5, 7, 1, 4, 6, 2, 3. Open work first and the closed tail last is what
   * makes folding the closed ones away cheap to look at — the rows that go are the ones
   * at the bottom, and nothing above them moves.
   */
  async children(workspace, id) {
    const rows = (await this.json(workspace, ['list', '--parent', id, '--all', '--limit', '0'])) || [];
    return rows
      .filter(Boolean)
      .map((r) => ({
        id: r.id,
        title: r.title || '',
        status: r.status || 'open',
        issue_type: r.issue_type || '',
        priority: r.priority ?? null,
      }))
      .sort(byDoneThenId);
  }

  /**
   * What a dismissal has to remember, and what it has to watch.
   *
   * Dismissing acknowledges a card and takes it out of the inbox. It closes
   * nothing — so the bead is still open, and something has to decide when it is
   * worth showing you again. Two things can, and which one applies is decided here,
   * off one `bd show`:
   *
   *   - **A gate** — the epic's open children, the blocker still open. The card
   *     comes back when that clears, because that is the moment it becomes
   *     something you can act on. This is the case you actually hit: an epic with
   *     thirty open children is not a question, it is a question's future.
   *   - **A comment count**, for a bead with no gate at all. Nothing about it is
   *     going to change on its own, so the only honest trigger is somebody saying
   *     something new on the thread.
   *
   * `comments` is `comment_count` off the same `show`, not a second `bd comments`
   * call — the list rows do not carry it, which is the whole reason the reply
   * poller costs an extra call per watched thread.
   */
  async hold(workspace, id) {
    let issue;
    try {
      issue = await this.show(workspace, id);
    } catch {
      return null;
    }
    if (!issue) return null;
    return { gate: await this.gateFor(workspace, issue), comments: Number(issue.comment_count) || 0 };
  }

  /**
   * Answer and close.
   *
   * This is what `bd human respond` is meant to do, but it is broken in bd 1.1.2
   * ("resolving issue ID: storage is nil") — so do the two steps it documents
   * ourselves. Comment first: if the close then fails on the Dolt lock, the
   * answer is already recorded rather than lost.
   *
   * The caller is expected to have asked `closeGate` first — this still throws if
   * bd refuses, because a gate that appeared between the check and the write is a
   * real failure and not something to swallow.
   *
   * Both writes carry the same `actor`, so a bead answered from a signed-in browser
   * has that address on the comment *and* on the close. Splitting them — the answer
   * from the person, the close from the daemon — would read six months later as two
   * people, which is the exact confusion this is meant to end.
   */
  async respond(workspace, id, response, { actor = null } = {}) {
    await this.run(workspace, ['comment', id, response], { retries: 4, actor });
    await this.run(workspace, ['close', id, '--reason', 'Answered via Beadcause'], { retries: 4, actor });
  }

  /**
   * Answer and hand the work back — `respond` for an option that commissions.
   *
   * The other ending an answer can have. "Build both as written" is not a full stop,
   * and closing on it files the work as finished at the moment it is ordered; the
   * session that picks it up then has to reopen the bead to do what it was just told
   * to do, and the reopen is what walks the card back into the inbox. See the
   * `closes: false` note in lib/decision.js for the bead that taught us this.
   *
   * Three writes, in this order and for these reasons:
   *
   *   - **The comment**, first, exactly as in `respond`: whatever else fails after
   *     it, the answer is on the thread rather than lost.
   *   - **The `human` label comes off**, which is the whole of "out of the inbox".
   *     The inbox is `bd human list` and an advocate's queue is `bd ready
   *     --exclude-label human`, so this one write moves the bead from the first to
   *     the second — it is the same fact read from two sides, not two states to keep
   *     in step.
   *   - **Open, and unclaimed.** `bd ready` skips an assigned bead, and a question
   *     picked up by an agent session carries that agent. Handing back work nobody
   *     can claim would be a quieter version of the failure this replaces.
   *
   * Throws if any of them do, like `respond` does on a refused close — none of these
   * has a gate the way a close does, so a failure here is the Dolt lock or nothing,
   * and `retries` is the answer to that.
   */
  async commission(workspace, id, response, { actor = null } = {}) {
    await this.run(workspace, ['comment', id, response], { retries: 4, actor });
    // The label and the status are the daemon moving a bead between two queues, not
    // anybody speaking, so they stay written as beadcause. What a reader wants a name
    // on is the sentence that ordered the work, and that is the comment above.
    await this.removeLabel(workspace, id, 'human');
    await this.reopen(workspace, id);
  }

  /**
   * Say something on the way past — the only mark a dismissal leaves on a bead.
   *
   * **Dismissing used to close the bead, and that was the wrong shape entirely.**
   * "I am not dealing with this now" is not "this is decided": an epic with thirty
   * open children is not a question you can answer, and closing it to get it off
   * the screen would have thrown away the thing it was tracking. So the
   * acknowledgement lives in beadcause's own state, the bead is untouched, and
   * this exists for the one case where you typed something first.
   *
   * A comment rather than a close reason, because an agent watching the thread
   * reads comments — a close reason is a line only `bd show` prints. A wordless
   * dismissal calls nothing at all: bd should have no idea it happened.
   */
  async noteOnly(workspace, id, note, { actor = null } = {}) {
    if (!String(note || '').trim()) return;
    await this.run(workspace, ['comment', id, note], { retries: 4, actor });
  }

  /**
   * Close an issue with a reason of the caller's choosing.
   *
   * Distinct from `respond`, which closes the *question* with a fixed reason. This
   * closes the bead a question was *about* — the work bead a merged pull request
   * finishes — and the reason there should say what landed, since that line is what
   * `bd show` prints months later when the PR is a number nobody remembers.
   *
   * `actor` for the same reason `respond` takes one: tapping Merge closes two beads,
   * the question and the work, and they are one act. Two names across them would read
   * as two people, which is the exact confusion bc-vq21 set out to end.
   */
  async close(workspace, id, reason, { actor = null } = {}) {
    await this.run(workspace, ['close', id, '--reason', reason], { retries: 4, actor });
  }

  /**
   * Put a closed or in-progress bead back in the ready queue.
   *
   * What "request changes" needs: the work bead was claimed by the session that
   * built the branch, and a claimed bead never comes back through `bd ready`. So
   * asking for changes reopens it and drops the claim, which is the only signal the
   * advocate reads — without it your note would sit on a bead nothing would ever
   * pick up again.
   */
  async reopen(workspace, id) {
    await this.run(workspace, ['update', id, '--status', 'open', '--assignee', ''], { retries: 3 });
  }

  /**
   * Rewrite the fields of a bead that already exists — one `bd update`, whatever moved.
   *
   * What "adjust" needs (lib/verdict.js): a bead filed by an agent whose title is wrong
   * or whose priority is optimistic, corrected before it is endorsed. Everything that
   * moves goes in one invocation rather than one per field, because each is a Dolt
   * write on a single-writer database and six of them is six chances to lose a lock
   * race over what the caller thinks of as one edit.
   *
   * Labels move as `--add-label` / `--remove-label` and never `--set-labels`. The
   * difference matters: a bead carries labels this daemon manages — `unendorsed` is the
   * hold itself — and a replacing write would take them off as collateral of an edit
   * that never mentioned them. What may be added and removed is decided in
   * lib/verdict.js, which knows which labels are nobody's to set.
   *
   * A call with nothing to do runs nothing at all, so a client that posts its whole
   * form on every save costs a `bd show` and no write.
   */
  async update(
    workspace,
    id,
    { title, type, priority, description, acceptance, notes, addLabels = [], removeLabels = [] } = {},
    { actor = null } = {}
  ) {
    const args = ['update', id];
    if (title) args.push('--title', String(title));
    if (type) args.push('--type', String(type));
    if (priority !== undefined && priority !== null && priority !== '') args.push('--priority', String(priority));
    if (description) args.push('--description', String(description));
    if (acceptance) args.push('--acceptance', String(acceptance));
    if (notes) args.push('--notes', String(notes));
    for (const label of addLabels) args.push('--add-label', String(label));
    for (const label of removeLabels) args.push('--remove-label', String(label));
    if (args.length === 2) return;
    await this.run(workspace, args, { retries: 4, actor });
  }

  /**
   * File a new issue and return its id.
   *
   * Same shape as `bin/ask.js`, but the body arrives over HTTP rather than a pipe,
   * so there's no shell to quote a fenced decision block past. The optional fields
   * exist for approved advocate proposals, which carry everything a hand-written
   * bead would — what done looks like, the design call, what it hangs off — and
   * would otherwise be flattened into one description on the way in.
   *
   * `actor` is separate from the fields because it is not one: it is who filed this,
   * not anything about the bead. It lands in `created_by` — a byline — and leaves
   * `owner` alone, so a bead you filed from your phone is still in the same queue,
   * still returned by `bd ready`, and still offered to the advocate. See the note on
   * the class above; that distinction is the reason this parameter exists at all.
   */
  async create(
    workspace,
    {
      title,
      body = '',
      priority = 1,
      type = 'task',
      labels = ['human'],
      acceptance = '',
      design = '',
      notes = '',
      deps = [],
      parent = '',
    },
    { actor = null } = {}
  ) {
    const args = ['create', '--title', title, '--type', type, '--priority', String(priority)];
    /**
     * A question filed by this daemon is this Mac's person's question.
     *
     * Here rather than at each of the four call sites — an advocate's proposal, an
     * agent's foundation request, an error the app filed on itself, a release — because
     * they have exactly one thing in common and it is the thing that matters: they were
     * all written by *this* machine, on a graph five others can see. A fifth call site
     * added next month gets it for free, and a call site that forgot would be a
     * question ringing six phones with nothing to say it should not have.
     *
     * **Only when the bead is a question.** `labels` is `['human']` by default and
     * something else entirely for the work beads lib/filing.js creates, which nobody is
     * notified about and which belong to whoever picks them up. Addressing one of those
     * would be claiming work rather than routing a decision.
     */
    const own = labels.includes('human') ? ownAddresseeLabels({ me: this.me }) : [];
    for (const label of [...labels, ...own]) args.push('--label', label);
    if (body) args.push('--description', body);
    if (acceptance) args.push('--acceptance', acceptance);
    if (design) args.push('--design', design);
    if (notes) args.push('--notes', notes);
    // `bd create --deps` takes 'type:id' or a bare id, and is repeatable.
    for (const dep of deps) args.push('--deps', dep);
    // A bead created without its parent has to be re-parented by hand afterwards,
    // and the console's drafts hang whole trees off one another.
    if (parent) args.push('--parent', parent);
    const created = await this.json(workspace, args, { retries: 4, actor });
    return created?.id || created?.issue?.id || null;
  }

  /** `bd dep add <issue> <depends-on>` — issue is blocked until depends-on closes. */
  addDep(workspace, id, dependsOn) {
    return this.run(workspace, ['dep', 'add', id, dependsOn], { retries: 4 });
  }

  /**
   * Take the edge back off: `bd dep remove <issue> <depends-on>`.
   *
   * What a merge needs. A delivery parks its work bead behind its merge card, so
   * answering that card cannot close the work bead — the card is still open at the
   * moment the merge runs, and bd refuses a close over an open blocker. The card is
   * being answered in the same breath, which is exactly when the edge stops meaning
   * anything, so the merge drops it rather than leaving the close to fail.
   */
  dropDep(workspace, id, dependsOn) {
    return this.run(workspace, ['dep', 'remove', id, dependsOn], { retries: 3 });
  }

  /**
   * Does this id exist in this workspace?
   *
   * The console's drafts may name real beads in `dependsOn` — that is how "this new
   * work waits on the one we started from" is written — and a ref and an id are not
   * reliably distinguishable by shape. So the tracker is asked rather than the regex
   * trusted, and an id that isn't there is reported instead of failing the whole
   * create at `bd dep add`.
   */
  async exists(workspace, id) {
    try {
      return Boolean(await this.show(workspace, id));
    } catch {
      return false;
    }
  }

  /**
   * Claimable work: open, unblocked, not deferred, nobody on it.
   *
   * `bd ready` applies the blocker-aware semantics itself, which is the reason to
   * use it over `list --status=open` — "ready" is a question about the dependency
   * graph, and reimplementing it here would drift from bd's own answer the first
   * time a dependency type was added. An advocate pushing at a blocked bead is
   * pushing at something only another bead can move.
   *
   * `--limit 0` overrides bd's default of 100. An advocate that saw the first
   * hundred beads of a busy repo and called the rest done would be wrong in the
   * one direction that matters.
   *
   * **`unendorsed` is excluded whatever the caller asks for.** Not a default a caller
   * can talk past: a bead nothing may open a session on is not claimable work, so
   * "ready" must never name one, and a stale call site passing `{ excludeLabel:
   * 'human' }` on its own would otherwise put the hole in lib/endorse.js's first layer
   * straight back. `--exclude-label` is a repeatable string slice in bd (checked against
   * 1.1.2 rather than assumed: repeated and comma-joined both exclude ANY of them), and the
   * rows are filtered here as well — the rows carry `labels`, the check costs nothing,
   * and this way the queue is right even against a bd that quietly ignored the flag.
   *
   * **And `superseded-by:<id>` is excluded too**, for the same reason and by a weaker
   * mechanism. A bead a worker has marked a duplicate of another is not claimable work
   * either — see lib/superseded.js — but the label carries the original's id in it, so
   * there is no fixed string to hand `--exclude-label` and the filter is the row check
   * below and nothing else. That is why the refusal in `openWorkSession` matters more
   * here than it does for endorsement: this half is one call site away from a hole.
   *
   * `excludeLabel` is still read, for a caller written before this took a list.
   */
  async ready(workspace, { excludeLabels = null, excludeLabel = null } = {}) {
    const asked = [].concat(excludeLabels ?? excludeLabel ?? ['human']).filter(Boolean).map(String);
    const labels = [...new Set([...asked, UNENDORSED])];
    const args = ['ready', '--limit', '0'];
    for (const label of labels) args.push('--exclude-label', label);
    const rows = (await this.json(workspace, args)) || [];
    return rows.filter(
      (r) => !isSuperseded(r) && !(r?.labels || []).some((l) => labels.includes(String(l).trim()))
    );
  }

  /**
   * The other side of that filter: ready, not in the inbox, and marked a duplicate.
   *
   * What lib/superseded.js sweeps. "Ready" is the whole of the timing — a duplicate
   * parked behind its original is blocked until the original closes, so a marked bead
   * turning up here *is* the event the sweep exists for.
   *
   * `--exclude-label human` does double duty: a bead already asked about carries it, so
   * this list is "not yet asked" without a second thought. There is no `--label` to
   * narrow it with the way `readyHeld` can — the id is in the label — so this pays for
   * a full `bd ready --json`, which is why it runs on the sweep interval and not on the
   * tick.
   */
  async readySuperseded(workspace) {
    const args = ['ready', '--limit', '0', '--exclude-label', 'human'];
    const rows = (await this.json(workspace, args)) || [];
    return rows.filter((r) => isSuperseded(r));
  }

  /**
   * The beads `ready` above deliberately never returns: ready in every other way, and
   * held for endorsement.
   *
   * Only a count is wanted (lib/work.js), and it is wanted because the alternative is a
   * monitor that says "9 ready" over a queue of 4 and no explanation of the other five.
   * A separate call rather than one unfiltered `bd ready` because held beads are few and
   * `bd ready --json` carries every row's whole description — a busy workspace is 88KB
   * of it, on a screen that refreshes every twenty seconds.
   */
  async readyHeld(workspace) {
    return (await this.json(workspace, ['ready', '--label', UNENDORSED, '--limit', '0'])) || [];
  }

  /** Live issues carrying a label — how an advocate finds its own outstanding ask. */
  async listLabel(workspace, label) {
    const args = ['list', '--label', label, '--status=open,in_progress,blocked', '--limit', '0'];
    const rows = (await this.json(workspace, args, { retries: SWEEP_RETRIES })) || [];
    return rows.filter((r) => r && r.status !== 'closed');
  }

  /** Issue counts for a whole workspace, in one call. */
  async status(workspace) {
    const out = await this.json(workspace, ['status']);
    return out?.summary || null;
  }

  /**
   * The other half of the tracker: every live bead that is NOT a question.
   *
   * "Live" is open, in_progress or blocked — deferred and closed are deliberately
   * out, since neither is anything an agent is on. The `human` exclusion is done by
   * bd rather than here so the rows never cross the process boundary at all: a
   * workspace like climative is 88KB of `bd list --json` because every row carries
   * its whole description, and the questions are already in hand from listHuman.
   *
   * `--limit 0` overrides bd's default of 50. Without it a busy workspace reports
   * its first fifty beads and the count on the phone reads as the whole truth.
   */
  async listAgent(workspace) {
    const args = [
      'list',
      '--status=open,in_progress,blocked',
      '--exclude-label',
      'human',
      '--limit',
      '0',
    ];
    return (await this.json(workspace, args, { retries: SWEEP_RETRIES })) || [];
  }

  /**
   * Every issue in a state — `in_progress` is what "an agent is on this" means.
   *
   * `status` is passed to bd verbatim, so it takes a comma list as readily as one
   * state: `'open,in_progress,blocked'` is how the graph gets the dates for every
   * live bead at once. Unlike listAgent this excludes nothing, because a `human`
   * bead is a node in the graph like any other.
   *
   * `--limit 0` because bd's own default is 50: without it a busy workspace would
   * silently report the first fifty and the sessions view would look complete.
   */
  async listStatus(workspace, status) {
    return (await this.json(workspace, ['list', `--status=${status}`, '--limit', '0'])) || [];
  }

  /**
   * Every issue that is *not closed*, in one call — bd's own default filter, unnamed.
   *
   * The twin of `listAll` below and for the same reason: a hand-written status list is
   * a second copy of bd's definition of "live", free to drift from it and silent when
   * it does. `bd list` with no `--status` hides closed issues and nothing else, so what
   * comes back is exactly the set a future state nobody here has heard of would join.
   * Measured on this workspace on 2026-08-11: 578 issues, 427 of them closed, 151 back.
   *
   * The one caller is lib/landed.js, where this replaces up to three `bd show`
   * subprocesses *per merged pull request* with one query per sweep. That is the whole
   * reason the sweep can afford to look at a fortnight — see the header there.
   */
  async listLive(workspace) {
    return (await this.json(workspace, ['list', '--limit', '0'], { retries: SWEEP_RETRIES })) || [];
  }

  /**
   * Every issue this workspace has ever had, closed and deferred ones included.
   *
   * `--all` rather than a status list, and the difference is not cosmetic: bd's default
   * filter hides closed issues, and `--all` is documented as overriding *the default
   * filter* rather than as a synonym for naming all five states. A future state nobody
   * here has heard of is in this answer and would not be in a hand-written list — which
   * matters for the one caller, the ledger (lib/history.js), whose whole premise is that
   * it shows you everything.
   *
   * What it still excludes is what bd hides from every list: gates, infrastructure beads
   * (agent/role/message) and template molecules. Those are machinery rather than work,
   * and the flags that reveal them are deliberately not passed — the ledger is a record
   * of what was *done*, not of what the tracker keeps about itself.
   *
   * Nothing is filtered here — not status, not priority, not label — even though bd
   * would happily do all three. The reason is the cache on the other side: see the
   * header of lib/history.js. This is a read, so it never queues behind Dolt's single
   * writer, and it is the most expensive `bd` call in the app (~1s and ~1.5MB of JSON
   * on the largest workspace here), which is why exactly one thing calls it and that
   * thing caches the answer.
   *
   * **This is the call the timeout was measured on**, and it no longer carries one of its
   * own: 503 beads answer in about a second idle and took 28.6 seconds here under a load
   * average of 33, which is the whole argument for `BD_TIMEOUT` above. It had a private
   * 120s ceiling first (bc-nib3.1); that is now the default every call gets, and a
   * per-call number here would only be a second copy of the same decision, free to drift
   * from it. What a timeout costs *this* caller is worth naming anyway: it throws,
   * `ledger` turns the workspace into a row in `errors`, and the History tab draws an
   * empty ledger for a repo with five hundred beads in it.
   */
  async listAll(workspace) {
    return (await this.json(workspace, ['list', '--all', '--limit', '0'], { retries: SWEEP_RETRIES })) || [];
  }

  /**
   * This workspace's Dolt remote as `{name, url}`, or `null` if it has none.
   *
   * The one question lib/sync.js asks before it does anything, and the reason syncing
   * needs no list in the config: a workspace answers for itself whether it is shared.
   * `--json` is real here — `bd dolt remote list --json` prints `[]` on a solo
   * workspace and `[{name, url, sql_url}]` on a shared one, measured against bd 1.1.2 —
   * which matters because the human-readable form is the sentence "No remotes
   * configured." and parsing prose for a *default off* is how a workspace ends up
   * silently not syncing.
   *
   * The **url** is carried and not just the name, because every screen that says
   * anything about this wants to say where: "in sync with origin" is a sentence that
   * cannot be checked, and on a shared tracker the one thing worth being sure of is
   * which repo your beads are going to.
   *
   * A read, so no lock retry, and `null` for a malformed answer rather than a throw:
   * the caller's next move on `null` is to do nothing, which is the safe direction. A
   * remote that cannot be *listed* is a workspace we should leave alone, not one we
   * should start pushing at.
   */
  async doltRemote(workspace) {
    const rows = await this.json(workspace, ['dolt', 'remote', 'list']);
    if (!Array.isArray(rows) || !rows.length) return null;
    const first = rows[0];
    if (typeof first === 'string') return { name: first, url: null };
    const name = first?.name || first?.remote || null;
    const url = first?.url || first?.sql_url || null;
    return name || url ? { name: name || 'origin', url } : null;
  }

  /**
   * Bring the remote's beads in, and send this machine's out. See lib/sync.js.
   *
   * `retries: 0` on both, and that is a departure from every other write here worth
   * saying out loud. Writes retry four times through Dolt's single-writer lock because
   * a lock collision is an ordinary Tuesday on a laptop running twenty agent sessions;
   * these two do not, because they are the only `bd` calls in the app that go to the
   * *network*, and a retry of a two-minute network timeout is four minutes of a poll
   * cycle spent on a workspace that will be tried again in two minutes anyway. The
   * interval is the retry.
   *
   * They keep `BD_TIMEOUT` rather than taking a shorter ceiling of their own. A push is
   * a git push under the hood: killing one mid-flight loses the push and nothing else —
   * the remote either took the whole thing or none of it — so the cost of waiting is
   * only ever a slow tick, while the cost of a ceiling set too low is a large first
   * sync that can never complete and reports as broken every time.
   */
  doltPull(workspace) {
    return this.run(workspace, ['dolt', 'pull'], { retries: 0 });
  }

  doltPush(workspace) {
    return this.run(workspace, ['dolt', 'push'], { retries: 0 });
  }

  /**
   * The interactive dependency graph as a standalone HTML page: `bd graph --html`
   * for one issue, or every open issue in the workspace when `id` is null.
   *
   * Read-only, so no lock retry — a read never loses to Dolt's single writer. It used to
   * ask for 60s, which was generous against a 30s default and is a *cut* against
   * `BD_TIMEOUT`: `--all` walks the whole graph, which is more work than any list call
   * here makes, so the last thing it should carry is the shortest ceiling in the file.
   */
  graphHtml(workspace, id) {
    const args = id ? ['graph', '--html', id] : ['graph', '--all', '--html'];
    return this.run(workspace, args);
  }

  /** Answer without closing — for questions you want to keep open. */
  comment(workspace, id, text, { actor = null } = {}) {
    return this.run(workspace, ['comment', id, text], { retries: 4, actor });
  }

  /**
   * Add to what a bead says about itself, without reading it first.
   *
   * `--append-notes` rather than `--notes`, and the difference is the whole reason this
   * exists: `--notes` replaces the field, so a caller adding a paragraph would have to
   * read the bead, concatenate, and write back — three steps with a lost write in the
   * middle of them. bd does the append itself, with a newline separator.
   *
   * Notes rather than the description because a description is what the bead *is*, and
   * everything appended here is something that happened to it afterwards. The card reads
   * both (lib/decision.js), so a `decision` block works from either.
   */
  appendNotes(workspace, id, text) {
    return this.run(workspace, ['update', id, '--append-notes', text], { retries: 4 });
  }

  // `bd label add <issue-id...> <label>` — id first, label last.
  addLabel(workspace, id, label) {
    return this.run(workspace, ['label', 'add', id, label], { retries: 3 });
  }

  removeLabel(workspace, id, label) {
    return this.run(workspace, ['label', 'remove', id, label], { retries: 3 });
  }
}

/**
 * bd prints clean JSON with --json, but a stray warning line on stdout would
 * break JSON.parse, so pull out the first balanced array/object.
 */
export function parseJson(out) {
  const text = (out || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to slicing */
  }
  const starts = [text.indexOf('['), text.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (end <= start) return null;
  return JSON.parse(text.slice(start, end + 1));
}
