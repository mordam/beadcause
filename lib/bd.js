import { execFile } from 'node:child_process';

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
 */

const LOCK_RE = /(lock|locked|another process|resource busy|database is busy)/i;

export class Bd {
  constructor({ bin, actor, sharedServer = false }) {
    this.bin = bin;
    this.actor = actor;
    this.sharedServer = sharedServer;
  }

  run(workspace, rawArgs, { retries = 0, timeout = 30000 } = {}) {
    const env = {
      ...process.env,
      BEADS_DIR: workspace.dir,
      BEADS_ACTOR: this.actor,
    };
    if (this.sharedServer) env.BEADS_DOLT_SHARED_SERVER = '1';
    else delete env.BEADS_DOLT_SHARED_SERVER;

    // BEADS_ACTOR is NOT enough: a workspace config.yaml with `actor: "…"` beats
    // the env var — observed with a workspace pinning a personal address — so
    // comments written from the phone came back attributed to the human rather
    // than to beadcause, and reply-detection then notified you about your own
    // comments. The --actor flag does win.
    const args = [...rawArgs, '--actor', this.actor];
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
   * Answer and close.
   *
   * This is what `bd human respond` is meant to do, but it is broken in bd 1.1.2
   * ("resolving issue ID: storage is nil") — so do the two steps it documents
   * ourselves. Comment first: if the close then fails on the Dolt lock, the
   * answer is already recorded rather than lost.
   */
  async respond(workspace, id, response) {
    await this.run(workspace, ['comment', id, response], { retries: 4 });
    await this.run(workspace, ['close', id, '--reason', 'Answered via Beadcause'], { retries: 4 });
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
   */
  async ready(workspace, { excludeLabel = 'human' } = {}) {
    const args = ['ready', '--limit', '0'];
    if (excludeLabel) args.push('--exclude-label', excludeLabel);
    return (await this.json(workspace, args)) || [];
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
   * Every issue in one state — `in_progress` is what "an agent is on this" means.
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
  comment(workspace, id, text) {
    return this.run(workspace, ['comment', id, text], { retries: 4 });
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
