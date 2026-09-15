#!/usr/bin/env node
/**
 * The installer, run for real, in a fake home with fake `launchctl` — because the two
 * ways it could not be run from an agent session cancelled each other out.
 *
 *   npm test
 *   node test/install.mjs
 *
 * `scripts/install.sh` feeds `configure.js` from `/dev/tty` rather than stdin, because
 * `npm run` pipes stdin and an installer that silently skipped its own questions was
 * the original bug. But `/dev/tty` is the *controlling terminal*, not a human: in an
 * agent session it is the agent's own terminal, so the questions are asked of nobody and
 * the install hangs on the first one. The escape — `setsid`, so `/dev/tty` fails and the
 * step warns and carries on — also leaves the GUI session, so `launchctl bootstrap
 * gui/<uid>` then failed with `Bootstrap failed: 5: Input/output error`. It failed
 * *after* the bootout, with `set -e` on, which left the daemon **unloaded**: port dead,
 * readiness wait dying, and the loaded-program check, the monitor and the QRs all
 * skipped. It was recovered by hand, but the window between the two was a real outage on
 * the one path whose whole job is not to have one.
 *
 * So two things are pinned here, and the second is the one worth the machinery:
 *
 * 1. **The decision about the questions**, in all four directions: the flag, the
 *    environment variable, an inferred agent session, and `--interactive` overriding the
 *    inference. On every skipping path `configure.js` must still run — it prints what is
 *    configured — and must be handed something that is *not* a terminal, which is the
 *    whole fix. (The hang itself cannot be reproduced here: the `node` on PATH is a shim
 *    that never blocks. What is testable is the choice, and the choice is the fix.)
 *
 * 2. **A failed load never leaves nothing loaded.** Three shapes: the domain refuses
 *    every job (the setsid case) and the running service is therefore never booted out
 *    at all; the domain is fine but *this* plist is refused, and the one that was
 *    installed before is put back and loaded again; and the same with no previous plist,
 *    where there is nothing to fall back to and it has to say so rather than imply a
 *    recovery.
 *
 * Nothing here touches the real service. `HOME` is a temporary directory, and `PATH` is
 * a directory of shims — `launchctl`, `curl`, `npm`, `node`, `bd` — followed by
 * /usr/bin:/bin for the coreutils the script uses. The shims log their argv, so the
 * assertions can be about the order things happened in, which is where the bug lived:
 * the probe has to come *before* the bootout, or it is not a probe.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'scripts', 'install.sh');
const LABEL = 'm4m.beadcause';
const UID = process.getuid();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-install-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

/* ------------------------------------------------------------------- harness */

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* --------------------------------------------------------------------- shims */

/**
 * The `node` the installer finds on PATH.
 *
 * It answers the five questions install.sh asks node — the version, the team tracker, the
 * monitor flag, configure.js, and the pairing QR — and records every call. For configure.js
 * it also records whether what it was handed on stdin is a terminal, which is the difference
 * between "asked a human" and "printed the current config": a skipping run must never
 * see a tty here.
 *
 * BEADCAUSE_TEST_ONBOARD_EXIT is what scripts/onboard.mjs returns, and it is switchable
 * because the installer reads it rather than ignoring it: 1 is a refusal that must stop the
 * install with the running service untouched, and 2 is a step that may work next time and
 * must not. The real script's own behaviour is test/onboard.mjs's business; what is
 * testable here is what install.sh does with the answer.
 */
const NODE_SHIM = `#!/bin/bash
log="$BEADCAUSE_TEST_LOGDIR/node.log"
if [ -t 0 ]; then stdin=tty; else stdin=notty; fi
printf '%s [stdin=%s]\\n' "$*" "$stdin" >> "$log"
case "$*" in
  *onboard.mjs*) exit "\${BEADCAUSE_TEST_ONBOARD_EXIT:-0}" ;;
  *phone-host*)  printf '%s' "\${BEADCAUSE_TEST_PHONE:-noip}"; exit 0 ;;
  *bind-host*)   printf '%s' "\${BEADCAUSE_TEST_HOST:-127.0.0.1}"; exit 0 ;;
esac
case "$1" in
  -p) echo "\${BEADCAUSE_TEST_NODE_MAJOR:-22}" ;;
  -e) printf '%s' "\${BEADCAUSE_TEST_MONITOR:-0}" ;;
  *)  ;;
esac
exit 0
`;

/**
 * `launchctl`, with the two failures that matter switchable.
 *
 * BEADCAUSE_TEST_BOOTSTRAP_FAIL_ALL — every bootstrap fails, including the probe. This
 * is the shell with no GUI session, and the shape of its error is launchd's own.
 *
 * BEADCAUSE_TEST_BOOTSTRAP_FAIL_MATCH — a bootstrap fails only if the plist it is given
 * *contains* this string. Set to `bin/router.js` it refuses the newly generated plist
 * while accepting both the probe and a previous plist that named bin/beadcause.js, which
 * is the real drift this repo has already lived through.
 */
const LAUNCHCTL_SHIM = `#!/bin/bash
printf '%s\\n' "$*" >> "$BEADCAUSE_TEST_LOGDIR/launchctl.log"
case "$1" in
  bootstrap)
    if [ -n "\${BEADCAUSE_TEST_BOOTSTRAP_FAIL_ALL:-}" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    if [ -n "\${BEADCAUSE_TEST_BOOTSTRAP_FAIL_MATCH:-}" ] &&
       grep -q "\$BEADCAUSE_TEST_BOOTSTRAP_FAIL_MATCH" "$3" 2>/dev/null; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    exit 0 ;;
  print)
    printf '\\targuments = {\\n\\t\\t/usr/bin/node\\n\\t\\t%s\\n\\t}\\n' "\${BEADCAUSE_TEST_LOADED:-}" ;;
  list) ;;
esac
exit 0
`;

const CURL_SHIM = `#!/bin/bash
printf '%s\\n' "$*" >> "$BEADCAUSE_TEST_LOGDIR/curl.log"
[ -n "\${BEADCAUSE_TEST_CURL_FAIL:-}" ] && exit 7
echo '{"ok":true,"workspaces":["beadcause"]}'
exit 0
`;

const NOOP_SHIM = `#!/bin/bash
printf '%s\\n' "$*" >> "$BEADCAUSE_TEST_LOGDIR/$(basename "$0").log"
exit 0
`;

/**
 * `brew`, present only in a run that asks for it. It logs its argv and makes what it was
 * asked to install actually appear — a shim on PATH, an app bundle in the fake
 * Applications folder, the Tailscale binary where BEADCAUSE_TAILSCALE points — so the
 * installer's re-check afterwards finds it the way it would find the real thing.
 * BEADCAUSE_TEST_BREW_FAIL makes every call fail.
 */
const BREW_SHIM = `#!/bin/bash
printf '%s\\n' "$*" >> "$BEADCAUSE_TEST_LOGDIR/brew.log"
[ -n "\${BEADCAUSE_TEST_BREW_FAIL:-}" ] && exit 1
bin="$(dirname "$0")"
shim() { printf '#!/bin/bash\\nexit 0\\n' > "$bin/$1"; chmod +x "$bin/$1"; }
case "$*" in
  "install beads"|"upgrade beads") shim bd ;;
  "install gh") shim gh ;;
  "install jq") shim jq ;;
  "install --cask claude-code") shim claude ;;
  "install --cask iterm2") mkdir -p "$BEADCAUSE_APP_DIRS/iTerm.app" ;;
  "install --cask tailscale-app") : > "$BEADCAUSE_TAILSCALE" ;;
esac
exit 0
`;

/**
 * A run of the installer: its own HOME, its own shim log, nothing shared.
 *
 * `brew: true` puts the brew shim on PATH. `shims` overrides a default shim's body, or
 * removes it with null — which is how a dependency is made missing. `apps` is what the
 * fake Applications folder holds.
 */
function run(name, { args = [], env = {}, previousPlist = null, brew = false, shims = {}, apps = ['iTerm.app'] } = {}) {
  const dir = path.join(tmp, name);
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const logs = path.join(dir, 'logs');
  const appsDir = path.join(dir, 'apps');
  for (const d of [path.join(home, 'Library', 'LaunchAgents'), bin, logs, appsDir]) fs.mkdirSync(d, { recursive: true });
  for (const app of apps) fs.mkdirSync(path.join(appsDir, app), { recursive: true });

  const bodies = {
    node: NODE_SHIM,
    launchctl: LAUNCHCTL_SHIM,
    curl: CURL_SHIM,
    npm: NOOP_SHIM,
    bd: NOOP_SHIM,
    gh: NOOP_SHIM,
    claude: NOOP_SHIM,
    tailscale: NOOP_SHIM,
    ...(brew ? { brew: BREW_SHIM } : {}),
    ...shims,
  };
  for (const [file, body] of Object.entries(bodies)) {
    if (body === null) continue;
    const p = path.join(bin, file);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }

  const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  if (previousPlist) fs.writeFileSync(plist, previousPlist);

  let status;
  // spawnSync rather than execFileSync, for one reason: `execFileSync` hands back stdout
  // alone on a run that *succeeds*, and every `warn` in the installer goes to stderr. So a
  // warning printed by a run that finished — the whole of what a recoverable failure looks
  // like — was invisible to an assertion, and the only reason nothing had noticed is that
  // the checks here were all about runs that died.
  const r = spawnSync('bash', [INSTALL, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // A hang is the bug this file is about, so it must fail rather than wedge `npm test`.
    timeout: 60_000,
    env: {
      // Built from nothing rather than inherited: CLAUDECODE and CI are exactly what
      // the decision under test reads, and this suite runs in both.
      HOME: home,
      TMPDIR: dir,
      PATH: `${bin}:/usr/bin:/bin`,
      BEADCAUSE_TEST_LOGDIR: logs,
      BEADCAUSE_TEST_LOADED: path.join(ROOT, 'bin', 'router.js'),
      // Every place the installer would otherwise look on the real Mac: Homebrew off PATH,
      // /Applications, and the absolute Tailscale paths. Without these a run here could
      // find — or install into — the machine it is running on.
      BEADCAUSE_BREW_SEARCH: '',
      BEADCAUSE_APP_DIRS: appsDir,
      BEADCAUSE_TAILSCALE: path.join(bin, 'tailscale'),
      ...env,
    },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  status = r.error?.code === 'ETIMEDOUT' ? 'TIMED OUT' : (r.status ?? r.error?.code ?? 0);
  const read = (f) => (fs.existsSync(path.join(logs, f)) ? fs.readFileSync(path.join(logs, f), 'utf8') : '');
  return {
    status,
    out,
    plist,
    plistText: fs.existsSync(plist) ? fs.readFileSync(plist, 'utf8') : null,
    rejectedText: fs.existsSync(`${plist}.rejected`) ? fs.readFileSync(`${plist}.rejected`, 'utf8') : null,
    node: read('node.log'),
    launchctl: read('launchctl.log').trim().split('\n').filter(Boolean),
    brew: read('brew.log').trim().split('\n').filter(Boolean),
  };
}

/** The plist that was installed before — the pre-router one this Mac really had. */
const OLD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/node</string><string>${ROOT}/bin/beadcause.js</string></array>
</dict></plist>
`;

/* ------------------------------------------------- 1. asking, and not asking */

console.log('the questions');

{
  const r = run('flag', { args: ['--non-interactive'] });
  check('--non-interactive finishes', r.status === 0, `exit ${r.status}\n${r.out}`);
  check('and says why it did not ask', /not asking the setup questions \(--non-interactive\)/.test(r.out), r.out);
  check('configure.js still runs, so the current config is printed', /configure\.js/.test(r.node), r.node);
  check(
    'and is handed something that is not a terminal — the whole fix',
    /configure\.js.*\[stdin=notty\]/.test(r.node),
    r.node
  );
}

{
  const r = run('env', { env: { SKIP_CONFIGURE: '1' } });
  check('SKIP_CONFIGURE=1 does the same', r.status === 0, `exit ${r.status}\n${r.out}`);
  check('and names the variable rather than a flag', /SKIP_CONFIGURE=1/.test(r.out), r.out);
  check('still not a terminal', /configure\.js.*\[stdin=notty\]/.test(r.node), r.node);
}

{
  const r = run('agent', { env: { CLAUDECODE: '1' } });
  check('an agent session needs no flag at all', r.status === 0, `exit ${r.status}\n${r.out}`);
  check('and is told it looks like one', /agent session/.test(r.out), r.out);
  check('not a terminal there either', /configure\.js.*\[stdin=notty\]/.test(r.node), r.node);
}

{
  const r = run('forced', { args: ['--interactive'], env: { CLAUDECODE: '1' } });
  check('--interactive overrides the inference', r.status === 0, `exit ${r.status}\n${r.out}`);
  check('and does not claim to have skipped anything', !/not asking the setup questions/.test(r.out), r.out);
}

{
  const r = run('plain');
  check('a plain run asks, as it always did', !/not asking the setup questions/.test(r.out), r.out);
}

{
  const r = run('bogus', { args: ['--wat'] });
  check('an unknown option is refused rather than ignored', r.status === 1, `exit ${r.status}`);
  check('and the usage is printed with it', /--non-interactive/.test(r.out), r.out);
}

/* -------------------------------------------- 1b. the team's tracker, and its answer */

/**
 * The step a second engineer's install was missing, and what the installer does with its
 * three exit codes. The tracker has to exist *before* the questions: on a fresh Mac there
 * is no workspace at all, so `configure.js` would print "No beads workspaces found" and
 * exit, and the daemon would come up serving an empty inbox with nothing wrong with it.
 */
console.log("\nthe team's tracker");

{
  const r = run('tracker-order', { args: ['-n'] });
  const onboard = r.node.indexOf('onboard.mjs');
  const configure = r.node.indexOf('configure.js');
  check('the onboarding runs', onboard >= 0, r.node);
  check('before the questions are asked about it', onboard >= 0 && onboard < configure, r.node);
  check('and a solo install is unaffected by it', r.status === 0, `exit ${r.status}\n${r.out}`);
}

{
  const r = run('tracker-refused', { args: ['-n'], env: { BEADCAUSE_TEST_ONBOARD_EXIT: '1' } });
  check('a refusal stops the install', r.status !== 0, `exit ${r.status}\n${r.out}`);
  check('and says a decision is needed', /needs a decision/.test(r.out), r.out);
  // The reason the step sits this early: nothing has been booted out yet, so what was
  // loaded is still loaded and still running. Same argument as the bootstrap probe.
  check(
    'with the running service never booted out',
    !r.launchctl.some((l) => l.startsWith('bootout')),
    r.launchctl.join('\n')
  );
  check('and no plist written', r.plistText === null, String(r.plistText).slice(0, 120));
}

{
  const r = run('tracker-failed', { args: ['-n'], env: { BEADCAUSE_TEST_ONBOARD_EXIT: '2' } });
  check('a step that may work next time only warns', r.status === 0, `exit ${r.status}\n${r.out}`);
  check('and says so, with the code', /not set up yet.*exit 2/.test(r.out), r.out);
  check('the daemon is still installed', r.launchctl.some((l) => l.includes(`${LABEL}.plist`)), r.launchctl.join('\n'));
}

/* ------------------------------------------------- 1c. installing what is missing */

console.log('\ninstalling what is missing');

{
  const r = run('deps-fresh', { args: ['-n'], brew: true, shims: { bd: null, gh: null, claude: null, tailscale: null }, apps: [] });
  check('a Mac with nothing on it still installs', r.status === 0, `exit ${r.status}\n${r.out}`);
  check('beads is installed with brew', r.brew.includes('install beads'), r.brew.join('\n'));
  check('and so are gh, iTerm2 and Claude Code', ['install gh', 'install --cask iterm2', 'install --cask claude-code'].every((l) => r.brew.includes(l)), r.brew.join('\n'));
  check('the bd it installed is the one the service is loaded with', r.launchctl.some((l) => l.includes(`${LABEL}.plist`)), r.launchctl.join('\n'));
  check('Tailscale is not part of the default install', !r.brew.some((l) => l.includes('tailscale')), r.brew.join('\n'));
  check('and nothing complains that it is missing', !/Tailscale not found/.test(r.out), r.out);
}

/* ------------------------------------------------------------- 1d. the phone */

console.log('\nthe phone');

{
  const r = run('loopback', { args: ['-n'] });
  check('without --phone it answers on loopback and says so', /127\.0\.0\.1:4318, on this Mac only/.test(r.out), r.out);
  check('and says how to turn the phone on later', /install-service -- --phone/.test(r.out), r.out);
  check('no pairing QR for an address the phone cannot reach', !/--qr/.test(r.node), r.node);
  check('and the tailnet address is never written', !/phone-host/.test(r.node), r.node);
}

{
  const r = run('phone-tailscale', { args: ['--phone', '--interactive'], brew: true, shims: { tailscale: null } });
  check('--phone installs Tailscale with somebody there', r.brew.includes('install --cask tailscale-app'), r.brew.join('\n'));
  check('and they are told to sign it in', /sign in/.test(r.out), r.out);
}

{
  const r = run('phone-unattended', { args: ['--phone', '-n'], brew: true, shims: { tailscale: null } });
  check('--phone with nobody to type the admin password does not try', !r.brew.some((l) => l.includes('tailscale')), r.brew.join('\n'));
  check('and names the command instead', /brew install --cask tailscale-app/.test(r.out), r.out);
}

{
  const r = run('phone-noip', { args: ['--phone', '-n'] });
  check('--phone before Tailscale is signed in says to sign in and re-run', /sign in, then re-run with --phone/.test(r.out), r.out);
  check('and still finishes', r.status === 0, `exit ${r.status}\n${r.out}`);
}

{
  const r = run('phone-on', {
    args: ['--phone', '-n'],
    env: { BEADCAUSE_TEST_PHONE: 'set 100.64.0.7', BEADCAUSE_TEST_HOST: '100.64.0.7' },
  });
  check('--phone writes the tailnet address', /phone-host/.test(r.node) && /listening on 100\.64\.0\.7/.test(r.out), `${r.node}\n${r.out}`);
  check('before the service is loaded, so it starts listening there', r.node.indexOf('phone-host') < r.node.indexOf('bind-host'), r.node);
  check('and prints the pairing QR', /--qr/.test(r.node), r.node);
}

{
  const r = run('deps-present', { args: ['-n'], brew: true });
  check('nothing already there is installed or upgraded', r.brew.length === 0, r.brew.join('\n'));
}

{
  const old = `#!/bin/bash
[ "$1" = --version ] && echo "bd version 1.1.0 (Homebrew)"
exit 0
`;
  const r = run('deps-oldbd', { args: ['-n'], brew: true, shims: { bd: old } });
  check(`a bd older than 1.2.1 is upgraded`, r.brew.includes('upgrade beads'), r.brew.join('\n'));
}

// Compared number by number, not as text: 1.10.0 is newer than 1.2.1 though it sorts before it.
for (const version of ['1.2.1', '1.10.0']) {
  const bd = `#!/bin/bash
[ "$1" = --version ] && echo "bd version ${version} (Homebrew)"
exit 0
`;
  const r = run(`deps-bd-${version}`, { args: ['-n'], brew: true, shims: { bd } });
  check(`bd ${version} is left alone`, !r.brew.includes('upgrade beads'), r.brew.join('\n'));
}

{
  const r = run('deps-brew-fails', { args: ['-n'], brew: true, apps: [], env: { BEADCAUSE_TEST_BREW_FAIL: '1' } });
  check('a failed optional install does not stop the install', r.status === 0, `exit ${r.status}\n${r.out}`);
  check('and says what failed', /brew install --cask iterm2 failed/.test(r.out), r.out);
}

{
  const r = run('deps-off', { args: ['-n', '--no-deps'], brew: true, shims: { bd: null } });
  check('--no-deps never runs brew', r.brew.length === 0, r.brew.join('\n'));
  check('and a missing bd is still fatal', r.status === 1 && /not on your PATH/.test(r.out), `exit ${r.status}\n${r.out}`);
}

{
  const r = run('deps-nobrew', { args: ['-n'], shims: { bd: null } });
  check('without Homebrew a missing bd is fatal', r.status === 1, `exit ${r.status}\n${r.out}`);
  check('and it says where Homebrew comes from', /brew\.sh/.test(r.out), r.out);
}

/* ------------------------------------------------------ 2. loading, and not */

console.log('\nloading the service');

{
  const r = run('load', { args: ['-n'] });
  const probe = r.launchctl.findIndex((l) => l.startsWith('bootstrap') && l.includes('bootstrap-probe'));
  const bootout = r.launchctl.findIndex((l) => l === `bootout gui/${UID}/${LABEL}`);
  const boot = r.launchctl.findIndex((l) => l.startsWith(`bootstrap gui/${UID} `) && l.includes(`${LABEL}.plist`));
  check('it bootstraps a throwaway job before touching the real one', probe >= 0 && probe < bootout, r.launchctl.join('\n'));
  check('unloads the probe again', r.launchctl.some((l) => l.includes(`bootout gui/${UID}/${LABEL}.bootstrap-probe`)), r.launchctl.join('\n'));
  check('then boots the service out and back in, in that order', bootout >= 0 && boot > bootout, r.launchctl.join('\n'));
  check('and kickstarts it', r.launchctl.includes(`kickstart -k gui/${UID}/${LABEL}`), r.launchctl.join('\n'));
  check('the plist names bin/router.js in this checkout', r.plistText?.includes(`${ROOT}/bin/router.js`), String(r.plistText).slice(0, 200));
  check('nothing was rejected', r.rejectedText === null);
  check('and the whole thing exits 0', r.status === 0, `exit ${r.status}\n${r.out}`);
}

{
  // The setsid case: the domain will not take any job at all.
  const r = run('nogui', { args: ['-n'], env: { BEADCAUSE_TEST_BOOTSTRAP_FAIL_ALL: '1' }, previousPlist: OLD_PLIST });
  check('a domain that refuses everything is a failure', r.status === 1, `exit ${r.status}\n${r.out}`);
  check(
    'and the running service is never booted out — this is the outage that happened',
    !r.launchctl.includes(`bootout gui/${UID}/${LABEL}`),
    r.launchctl.join('\n')
  );
  check('it says the GUI session is the problem, not the plist', /GUI session|gui\//.test(r.out), r.out);
  check('names the state it left behind: rewritten, never reloaded', /never reloaded/.test(r.out), r.out);
  check('reports that what is loaded is still answering', /still up and answering/.test(r.out), r.out);
  check(
    'and hands over the three commands that finish it',
    /launchctl bootout gui\//.test(r.out) && /launchctl bootstrap gui\//.test(r.out) && /launchctl kickstart -k gui\//.test(r.out),
    r.out
  );
}

{
  // The domain is fine; this plist is not. The label is already booted out by then, so
  // the only acceptable end state is the previous one loaded again.
  const r = run('rejected', {
    args: ['-n'],
    env: { BEADCAUSE_TEST_BOOTSTRAP_FAIL_MATCH: 'bin/router.js' },
    previousPlist: OLD_PLIST,
  });
  check('a refused plist is a failure', r.status === 1, `exit ${r.status}\n${r.out}`);
  check('the plist that was installed before is back on disk', r.plistText === OLD_PLIST, String(r.plistText).slice(0, 200));
  check('and it was loaded again, so the service is up', r.launchctl.filter((l) => l.startsWith(`bootstrap gui/${UID} `)).length >= 2, r.launchctl.join('\n'));
  check('restarted too, rather than left loaded but stopped', r.launchctl.includes(`kickstart -k gui/${UID}/${LABEL}`), r.launchctl.join('\n'));
  check('the rejected one is kept for comparison', r.rejectedText?.includes(`${ROOT}/bin/router.js`), String(r.rejectedText).slice(0, 200));
  check('and it says what it put back', /back in place and loaded again/.test(r.out), r.out);
}

{
  // First install, and the generated plist is refused: there is no previous one, and
  // pretending otherwise would be the one thing worse than the failure.
  const r = run('nofallback', { args: ['-n'], env: { BEADCAUSE_TEST_BOOTSTRAP_FAIL_MATCH: 'bin/router.js' } });
  check('a first install that is refused fails', r.status === 1, `exit ${r.status}\n${r.out}`);
  check('says there is nothing to fall back to', /nothing to fall back to/.test(r.out), r.out);
  check('does not claim a recovery it did not do', !/back in place and loaded again/.test(r.out), r.out);
  check('and still keeps the rejected plist', r.rejectedText !== null);
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
