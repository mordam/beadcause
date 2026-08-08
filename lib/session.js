import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'open-session.applescript');

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
function permissionFlag(cfg) {
  const mode = cfg.sessionPermissionMode;
  if (!mode) return '';
  if (!PERMISSION_MODES.has(mode)) {
    console.warn(`[beadcause] ignoring unknown sessionPermissionMode "${mode}" — expected one of ${[...PERMISSION_MODES].join(', ')}`);
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
 */
function workPromptFor(workspace, bead, attempt) {
  const id = bead.id;
  const retry =
    attempt > 1
      ? `\n**This is attempt ${attempt}.** A previous session was opened on this bead and ended without\nclosing it. Read the comments before you start — whatever stopped it is probably\nstill there, and if it is a question for Adam, hand it back rather than grinding.\n`
      : '';

  return `You are working bead **${workspace}/${id}**, opened automatically by the ${workspace}
advocate in beadcause because it came up ready. **Adam is not at the keyboard** — treat
this as unattended work that he will read the results of later.

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

**When it is done:**

    bd close ${id} --reason "<one line: what you actually did>"

**If you cannot finish it, do not force it.** There are exactly two honest endings,
and the second is not a failure:

1. **It needs a decision from Adam.** Put the question on the bead and hand it to
   him — the \`decision\` block is what makes it answerable from a phone:

       bd comment ${id} "Blocked on which way to go. See the decision block."
       bd label add ${id} human

   Then stop. Do not guess at his intent to keep moving; a wrong guess costs more
   than the wait.
2. **It is bigger than it looked.** Say so in a comment, with what you learned, and
   leave the bead open. The advocate will bring it back to him.

**Do not create beads.** Adam approves every bead before it exists — that is a rule
of this system, not a preference. If you find work worth tracking, write it in a
comment on this bead under a \`## Discovered\` heading, one item per bullet with
enough detail to act on. The advocate reads those and asks him about them.

Name this session "${projectName(workspace)} - ${id} ${(bead.title || '').slice(0, 40)}" and keep the bead id
in the name as you rename it. That id is the only thing that lets the advocate match
this window to the bead it opened it for.
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
 * Open a session to *work* a bead, on an advocate's initiative rather than yours.
 *
 * Same window, same permission mode, deliberately different brief. The discuss
 * prompt above exists because you tapped a question and want to talk; this one is
 * opened by lib/advocate.js when a bead comes ready and you are, as often as not,
 * asleep. So it says the thing the other prompt never has to: nobody is watching,
 * the repo's own rules are the rules, and the two ways to stop — done, or handed
 * back to Adam — are both spelled out, because an unattended session with no honest
 * exit invents one.
 */
export function openWorkSession(cfg, workspace, bead, { attempt = 1, doneFile = null } = {}) {
  const dir = resolveSessionDir(cfg, workspace);
  return launch(
    cfg,
    dir,
    workPromptFor(workspace.name, bead, attempt),
    safeTitle(`▶ ${bead.id} · ${bead.title || workspace.name}`),
    { doneFile }
  );
}

/**
 * The AppleScript half, shared by both: write the brief, hand iTerm the command.
 *
 * `doneFile` is what makes an unattended session *end* rather than merely stop.
 * The command is typed into an interactive shell, so when `claude` exits you get a
 * prompt back and the window sits there forever — fine for the one you opened to
 * talk something through, useless for an advocate that will open dozens. So a work
 * session appends two things: the exit status written to a file, and `exit`, which
 * ends the shell and lets iTerm close the window behind it.
 *
 * The file is the more valuable half. Without it the daemon can only *infer* that a
 * session finished, by watching the bead and waiting out a grace period; with it,
 * the moment the process exits is a fact, and "exited having closed the bead" and
 * "exited leaving it open" stop looking the same. It is written with `;` rather
 * than `&&` on purpose — a session that failed is exactly the one worth hearing
 * about.
 */
function launch(cfg, dir, prompt, tabTitle, { doneFile = null } = {}) {
  const promptFile = path.join(os.tmpdir(), `beadcause-${crypto.randomBytes(6).toString('hex')}.md`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });

  // `cd` first: the interactive chpwd hook re-runs _bd_set_workspace there, which is
  // what points BEADS_DIR and CLAUDE_CONFIG_DIR at the right tree before claude starts.
  const ending = doneFile ? `; printf '%s' "$?" > ${shq(doneFile)}; exit` : '';
  const command =
    `cd ${shq(dir)} && P="$(cat ${shq(promptFile)})" && rm -f ${shq(promptFile)} && claude${permissionFlag(cfg)} "$P"${ending}`;

  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', [SCRIPT, command, tabTitle], { timeout: 20000 }, (err, stdout, stderr) => {
      // Report the mode back so it lands in the log. A session that silently came
      // up in the wrong permission mode is invisible otherwise — you'd only notice
      // when it stopped to ask you something from the other room.
      if (!err) return resolve({ dir, mode: cfg.sessionPermissionMode || 'default' });
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
