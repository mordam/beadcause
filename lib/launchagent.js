/**
 * Does the label a deploy restarts point at the tree the deploy just updated?
 *
 * `deploys.beadcause.command` is `["launchctl", "kickstart", "-k", "gui/{uid}/m4m.
 * beadcause"]`. That restarts whatever job is *loaded under that label*, which is not
 * the same thing as "this checkout" and on this Mac has already not been: bin/router.js
 * landed, scripts/install.sh was updated to point the LaunchAgent at it, and the plist
 * in `~/Library/LaunchAgents` — generated weeks earlier, and not a file `git pull`
 * touches — went on naming bin/beadcause.js for three days. Every kickstart succeeded.
 * Every kickstart restarted the wrong program.
 *
 * A deploy walks straight into that: it fast-forwards the checkout, rebuilds what the
 * fast-forward moved, and then restarts a *label*. The one generated file that decides
 * what actually runs is the only thing in the chain nobody looked at.
 *
 * **So this refuses, and it does not rewrite anything.** The other way out — have the
 * deploy run `scripts/install.sh` when the pull touched the installer — is available
 * and needs no code at all, because it is a rebuild step:
 *
 * ```json
 * "rebuild": [{ "label": "launchagent", "when": ["scripts/install.sh", "bin/router.js"],
 *               "command": ["bash", "scripts/install.sh"] }]
 * ```
 *
 * That is the right shape for the repo that wants it, and the wrong default for
 * everyone: rewriting a LaunchAgent from inside an unattended deploy at three in the
 * morning is a big hammer, and the failure it is swung at is one that a sentence names
 * perfectly well. The check runs *after* the rebuilds precisely so that both can be
 * true — a repo that declares the installer above fixes the drift, and then this passes.
 *
 * ## What it will and will not judge
 *
 * Only a command that restarts an *already-loaded* job in a user domain: `launchctl
 * kickstart|kill|stop` against `gui/<uid>/<label>` or `user/<uid>/<label>`. Everything
 * else is left alone, and each exclusion is a case where the check would be wrong
 * rather than merely quiet:
 *
 *   - `bootout`/`bootstrap` *are* the reload. Second-guessing the command that fixes
 *     the drift is how you refuse a correct deploy.
 *   - `system/<label>` is a LaunchDaemon in `/Library/LaunchDaemons`, installed by root
 *     for reasons this daemon has no view of.
 *   - Anything that is not `launchctl` — `fly deploy`, an rsync, a script — has no
 *     label, no plist, and nothing here to say about it.
 *
 * For our own label the verdict is lib/service.js's, whole: it knows that a plist
 * naming bin/beadcause.js *inside the right checkout* is the actual bug, which no
 * generic "is the program in the tree" test could ever catch. For any other label the
 * test is the one that cannot be argued with — launchd must be starting a program that
 * lives inside the directory the deploy just fast-forwarded — with `launchAgent` in the
 * declaration to name the program exactly, or `false` to say this is none of our
 * business.
 */
import os from 'node:os';
import path from 'node:path';

import { LABEL, agentPlistPaths, hotSwapProblem, installedService } from './service.js';

/** Subcommands that restart what is already loaded, rather than loading it afresh. */
const RESTARTS = new Set(['kickstart', 'kill', 'stop']);

/** `gui/501/m4m.beadcause` → `m4m.beadcause`. User domains only; see the note above. */
const TARGET = /^(?:gui|user)\/\d+\/(.+)$/;

/**
 * The label this command would restart, or null if it would not restart one.
 *
 * A scan rather than a position, because the flags move: `kickstart -k <target>`,
 * `kill SIGTERM <target>`, and a future `-p` all put the target somewhere different.
 * The first argument shaped like a service target is the target — there is only ever
 * one, and nothing else in a launchctl line looks like it.
 */
export function restartedLabel(command) {
  if (!Array.isArray(command) || !command.length) return null;
  if (path.basename(String(command[0])) !== 'launchctl') return null;
  const sub = command.slice(1).find((a) => !String(a).startsWith('-'));
  if (!RESTARTS.has(String(sub ?? ''))) return null;
  for (const arg of command.slice(1)) {
    const m = TARGET.exec(String(arg));
    if (m) return m[1];
  }
  return null;
}

/**
 * The verdict, in the shape the runner can fail with.
 *
 * `message` is what lands in the deploy record and on the phone, so it leads with the
 * refusal and names the program launchd would have restarted — that name is the whole
 * of what was missing, and "the LaunchAgent is stale" without it is a sentence nobody
 * can act on. lib/service.js's own `lines` follow, because they already end with the
 * one command that fixes it.
 */
function verdict(problem, label, dir) {
  const program = problem.installed?.program || null;
  return {
    ...problem,
    label,
    program,
    message: [
      `refusing to restart ${label}: the LaunchAgent is not in step with ${dir}.`,
      program
        ? `launchd would have restarted ${program}.`
        : 'there is no readable LaunchAgent for it, so what launchd would have restarted cannot be named.',
      ...problem.lines,
    ].join('\n'),
  };
}

/**
 * Is this deploy about to restart something other than what it deployed?
 *
 * `null` — the ordinary answer — means either that the command restarts nothing this
 * can reason about, or that the job launchd holds really is the tree that was just
 * brought up to date.
 */
export function launchAgentProblem({ command, dir, launchAgent = null, home = os.homedir() } = {}) {
  if (launchAgent === false) return null;
  const label = restartedLabel(command);
  if (!label) return null;

  const root = path.resolve(dir || '.');

  // Our own label, and no declaration overriding it: the full hot-swap verdict, which
  // is the only one that catches a plist pointing at the *right checkout's wrong file*.
  if (label === LABEL && !launchAgent) {
    const own = hotSwapProblem({ root, home });
    return own ? verdict(own, label, root) : null;
  }

  const svc = installedService({ home, label, paths: agentPlistPaths(home, label) });

  if (!svc.exists) {
    return verdict(
      {
        code: 'not-installed',
        summary: `no LaunchAgent for ${label} in ${path.dirname(svc.path)}`,
        lines: [
          `there is no plist for ${label} anywhere launchd loads user agents from,`,
          'so restarting it would either fail outright or restart a job nobody can name.',
          'install the service, or set `launchAgent: false` on this deploy if the job is',
          'loaded some way this cannot see.',
        ],
        installed: svc,
      },
      label,
      root
    );
  }

  if (svc.unreadable) {
    return verdict(
      {
        code: 'unreadable',
        summary: `could not read ProgramArguments out of ${svc.path}`,
        lines: [
          `${svc.path} exists but its ProgramArguments could not be read,`,
          'so which program launchd would restart is unknown — and a deploy is the wrong',
          'moment to assume it is the right one.',
        ],
        installed: svc,
      },
      label,
      root
    );
  }

  const program = path.resolve(svc.program);
  const want = launchAgent ? path.resolve(root, String(launchAgent)) : null;
  // Without a declared program the test is containment: the deploy fast-forwarded this
  // directory, so a job started from outside it did not get whatever was just pulled.
  const matches = want ? program === want : program === root || program.startsWith(`${root}${path.sep}`);
  if (matches) return null;

  return verdict(
    {
      code: 'foreign-program',
      summary: want
        ? `${svc.path} names ${svc.program}, and this deploy declares ${want}`
        : `${svc.path} names ${svc.program}, which is not inside ${root}`,
      lines: want
        ? [
            `${svc.path} names ${svc.program}.`,
            `this deploy declares that ${label} should run ${want}.`,
            'the plist has not been rewritten since, or it was rewritten and never booted out —',
            'launchd keeps the argv it bootstrapped with, so editing the file alone changes nothing.',
          ]
        : [
            `${svc.path} names ${svc.program}.`,
            `this deploy just fast-forwarded ${root}, which that program is not in — so the`,
            'restart would put back exactly what was already running.',
            'reinstall the service from this checkout, or declare the program with `launchAgent`.',
          ],
      installed: svc,
    },
    label,
    root
  );
}
