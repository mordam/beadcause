import { execFile } from 'node:child_process';
import { UNENDORSED } from './endorse.js';

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
 *    and the handlers for the things a person *says* — an answer, a comment, a
 *    dismissal note — pass the signed-in address so the bead's history says who
 *    said it. Omitting it is the old behaviour exactly, which is what keeps the
 *    token callers (ntfy, the Android app, `curl`) writing as they always have.
 */

const LOCK_RE = /(lock|locked|another process|resource busy|database is busy)/i;

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

export class Bd {
  constructor({ bin, actor, sharedServer = false }) {
    this.bin = bin;
    this.actor = actor;
    this.sharedServer = sharedServer;
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
  run(workspace, rawArgs, { retries = 0, timeout = 30000, actor = null } = {}) {
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
            if (left > 0 && LOCK_RE.test(detail)) {
              const wait = (retries - left + 1) * 400;
              return setTimeout(() => attempt(left - 1).then(resolve, reject), wait);
            }
            const e = new Error(`bd ${args.join(' ')} failed in ${workspace.name}: ${detail.trim() || err.message}`);
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
    const rows = await this.json(workspace, ['human', 'list']);
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
   * attempted. Both are exact rather than a guess at bd's rules:
   *
   *   - **blocked by open issues** — the `blocks` dependencies `bd show` already
   *     returns, minus the closed ones. This is the same list bd names.
   *   - **an epic with open children** — one extra call, and only for an epic,
   *     because children are not in `dependencies` at all.
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
   */
  async close(workspace, id, reason) {
    await this.run(workspace, ['close', id, '--reason', reason], { retries: 4 });
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
    }
  ) {
    const args = ['create', '--title', title, '--type', type, '--priority', String(priority)];
    for (const label of labels) args.push('--label', label);
    if (body) args.push('--description', body);
    if (acceptance) args.push('--acceptance', acceptance);
    if (design) args.push('--design', design);
    if (notes) args.push('--notes', notes);
    // `bd create --deps` takes 'type:id' or a bare id, and is repeatable.
    for (const dep of deps) args.push('--deps', dep);
    // A bead created without its parent has to be re-parented by hand afterwards,
    // and the console's drafts hang whole trees off one another.
    if (parent) args.push('--parent', parent);
    const created = await this.json(workspace, args, { retries: 4 });
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
   * `excludeLabel` is still read, for a caller written before this took a list.
   */
  async ready(workspace, { excludeLabels = null, excludeLabel = null } = {}) {
    const asked = [].concat(excludeLabels ?? excludeLabel ?? ['human']).filter(Boolean).map(String);
    const labels = [...new Set([...asked, UNENDORSED])];
    const args = ['ready', '--limit', '0'];
    for (const label of labels) args.push('--exclude-label', label);
    const rows = (await this.json(workspace, args)) || [];
    return rows.filter((r) => !(r?.labels || []).some((l) => labels.includes(String(l).trim())));
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
    const rows = (await this.json(workspace, args)) || [];
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
    return (await this.json(workspace, args)) || [];
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
   * The interactive dependency graph as a standalone HTML page: `bd graph --html`
   * for one issue, or every open issue in the workspace when `id` is null.
   *
   * Read-only, so no lock retry — a read never loses to Dolt's single writer. The
   * timeout is generous anyway: `--all` walks the whole graph, which is a lot more
   * work than the list calls everything else here makes.
   */
  graphHtml(workspace, id) {
    const args = id ? ['graph', '--html', id] : ['graph', '--all', '--html'];
    return this.run(workspace, args, { timeout: 60000 });
  }

  /** Answer without closing — for questions you want to keep open. */
  comment(workspace, id, text, { actor = null } = {}) {
    return this.run(workspace, ['comment', id, text], { retries: 4, actor });
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
