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

  const promptFile = path.join(os.tmpdir(), `beadcause-${crypto.randomBytes(6).toString('hex')}.md`);
  fs.writeFileSync(promptFile, promptFor(workspace.name, id, title), { mode: 0o600 });

  // `cd` first: the interactive chpwd hook re-runs _bd_set_workspace there, which is
  // what points BEADS_DIR and CLAUDE_CONFIG_DIR at the right tree before claude starts.
  const command =
    `cd ${shq(dir)} && P="$(cat ${shq(promptFile)})" && rm -f ${shq(promptFile)} && claude${permissionFlag(cfg)} "$P"`;
  const tabTitle = safeTitle(`${id} · ${title || workspace.name}`);

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
