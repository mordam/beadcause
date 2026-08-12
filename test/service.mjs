#!/usr/bin/env node
//
// Does anything notice when launchd is running the wrong program?
//
//   npm test              (runs it alongside the rest)
//   node test/service.mjs
//
// The bug: the LaunchAgent in ~/Library/LaunchAgents named bin/beadcause.js while the
// repo, the installer and the README all described a router owning the port and
// swapping a backend under it. Every deploy kickstarted that label, the port answered
// every request, and the hot-swap had simply never run. Nothing was broken enough to
// look at.
//
// So the thing worth testing is not the swap — scripts/test-swap.js already drives a
// real one — but the *detection*: given a plist on disk and what launchd handed the
// process, does lib/service.js name the problem and the command that fixes it? Every
// case here is a directory this test writes, so it never reads the real LaunchAgents
// folder and passes identically on a machine with no service installed at all.
//
// The second half of the file (bc-4irq) is about *delivery*, because detection on its
// own changed nothing: the banner reached ~/Library/Logs/beadcause.log and the diagnosis
// reached a command you only run once you already suspect something, so every surface
// Adam actually looks at went on saying nothing. That half follows the verdict out to the
// advocate console — through the grandchild process that serves it, onto /api/work, and
// as far as the page that has to draw it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import {
  hotSwapProblem,
  installedService,
  launchdProgram,
  plistPath,
  programArguments,
  problemBanner,
  serviceHealth,
  LABEL,
  LOADED_ENV,
} from '../lib/service.js';
import { removeTreeSync } from './helpers/tmp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Nothing below asks anything of the machine this runs on: every case is a directory
// this file writes and a value it passes, which is what lets the suite pass identically
// on a Mac with no service installed at all. One ambient value broke that promise
// (bc-nv25). An iTerm window the beadcause daemon opens is downstream of the router
// launchd started — not through the command string, which starts a fresh login shell,
// but through iTerm.app's own environment — so every shell in it carries
// BEADCAUSE_LAUNCHD_PROGRAM naming the *main checkout's* bin/router.js — a true statement about that terminal's ancestry and no
// statement whatever about the tree under test. serviceHealth() reads it whenever a
// caller passes nothing, so the health checks below saw a running job disagreeing with
// this checkout and reported the stale-plist bug this file exists to detect: red in
// every session an agent opened, green in every terminal a person opened, which is the
// split that guarantees nobody goes looking. So the suite drops it here and every case
// says what it means. The one thing lost is the ability to notice a stale plist on this
// machine, and no case here ever did that — they all read a fake home.
delete process.env[LOADED_ENV];

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-service-'));
process.on('exit', () => removeTreeSync(tmpdir));

/** A fake home whose LaunchAgents folder holds exactly the plist a case needs. */
function home(name, xml) {
  const dir = path.join(tmpdir, name);
  const agents = path.join(dir, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  if (xml !== null) fs.writeFileSync(path.join(agents, `${LABEL}.plist`), xml);
  return dir;
}

/** The plist install.sh writes, parameterised by the program it points at. */
const plistFor = (program) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>${program}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;

const ROUTER = path.join(ROOT, 'bin', 'router.js');
const SERVER = path.join(ROOT, 'bin', 'beadcause.js');

/* ------------------------------------------------------------------- parsing */

console.log('reading the plist');

{
  const h = home('good', plistFor(ROUTER));
  const svc = installedService({ home: h });
  check('finds the plist install.sh would have written', svc.exists && !svc.unreadable, JSON.stringify(svc));
  check('reads the whole argv, node first', svc.argv?.length === 2 && svc.argv[0] === '/opt/homebrew/bin/node', JSON.stringify(svc.argv));
  check('picks the .js out of it as the program', svc.program === ROUTER, String(svc.program));
  check('reports where it looked', svc.path === plistPath(h), svc.path);
}

check(
  'takes ProgramArguments and not some other array of strings',
  programArguments(`<dict><key>WatchPaths</key><array><string>/tmp/a</string></array>
   <key>ProgramArguments</key><array><string>/bin/node</string><string>/x/run.js</string></array></dict>`)?.join(' ') ===
    '/bin/node /x/run.js'
);

check(
  'unescapes a path with an ampersand in it',
  programArguments('<key>ProgramArguments</key><array><string>/a &amp; b/run.js</string></array>')?.[0] === '/a & b/run.js'
);

{
  const svc = installedService({ home: home('binary', 'bplist00\0\0rubbish') });
  check('calls a binary plist unreadable rather than guessing', svc.exists && svc.unreadable, JSON.stringify(svc));
}

/* ------------------------------------------------------------------ verdicts */

console.log('\nthe verdict');

{
  const problem = hotSwapProblem({ root: ROOT, home: home('router', plistFor(ROUTER)) });
  check('a plist pointing at bin/router.js is no problem at all', problem === null, JSON.stringify(problem));
}

{
  // The bug itself, exactly as it sat on this Mac for three days.
  const problem = hotSwapProblem({ root: ROOT, home: home('stale', plistFor(SERVER)) });
  check('catches a plist that runs bin/beadcause.js', problem?.code === 'runs-the-server', JSON.stringify(problem?.code));
  check(
    'says how to fix it, in a command that can be pasted',
    problem?.lines.some((l) => l.includes('npm run install-service')),
    JSON.stringify(problem?.lines)
  );
  const banner = problemBanner(problem, '[x]');
  check(
    'every banner line is prefixed, so none of it is lost in a log',
    banner.every((l) => l.startsWith('[x]')) && banner.some((l) => l.includes('HOT-SWAP IS NOT LIVE')),
    banner.join('\n')
  );
}

{
  const other = '/Users/someone/else/beadcause/bin/router.js';
  const problem = hotSwapProblem({ root: ROOT, home: home('foreign', plistFor(other)) });
  check("catches a router from somebody else's checkout", problem?.code === 'foreign-program', JSON.stringify(problem?.code));
  check('names the path launchd would actually run', problem?.lines.some((l) => l.includes(other)), JSON.stringify(problem?.lines));
}

{
  const problem = hotSwapProblem({ root: ROOT, home: home('none', null) });
  check('says so when there is no LaunchAgent at all', problem?.code === 'not-installed', JSON.stringify(problem?.code));
}

{
  const problem = hotSwapProblem({ root: ROOT, home: home('unreadable', '<plist><dict></dict></plist>') });
  check('a plist with no ProgramArguments is unreadable, not "fine"', problem?.code === 'unreadable', JSON.stringify(problem?.code));
}

/* ---------------------------------------------- the file is right, launchd is not */

console.log('\nrewritten but never reloaded');

{
  // launchd keeps the argv it bootstrapped with. A plist rewritten by install.sh and
  // never booted out leaves the file correct and the running job wrong — invisible to
  // anything that only reads the file, which is why the process passes what it was
  // actually handed.
  const h = home('reloadme', plistFor(ROUTER));
  const problem = hotSwapProblem({ root: ROOT, home: h, loadedProgram: SERVER });
  check('a correct plist plus a stale job is still a problem', problem?.code === 'not-reloaded', JSON.stringify(problem?.code));
  check(
    'says rewriting the file is not enough on its own',
    problem?.lines.some((l) => l.includes('never reloaded')),
    JSON.stringify(problem?.lines)
  );

  const fine = hotSwapProblem({ root: ROOT, home: h, loadedProgram: ROUTER });
  check('and no problem when the job matches the file', fine === null, JSON.stringify(fine));
}

/* ------------------------------------------------- one hop down from launchd (bc-4irq)
 *
 * The verdict above is only as good as `loadedProgram`, and the process that serves the
 * console is a *grandchild* of launchd: the router is what launchd started, the backend
 * answering /api/work is what the router spawned. A backend reading its own
 * `process.argv[1]` sees bin/beadcause.js and would call a perfectly good install
 * "never reloaded" — a false alarm on the one screen this bead exists to make
 * trustworthy. So the router hands down what it was given, and an empty value is a
 * positive statement that nobody's launchd started this.
 */

console.log('\nwhat launchd handed us, one hop down');

check(
  'the value the router passes down wins over our own argv',
  launchdProgram({ env: { [LOADED_ENV]: ROUTER }, argv: [process.execPath, SERVER], ppid: 1 }) === ROUTER
);

check(
  'an empty value means "not a launchd job", not "look at argv"',
  launchdProgram({ env: { [LOADED_ENV]: '' }, argv: [process.execPath, SERVER], ppid: 1 }) === null
);

check(
  'with nothing passed, a process launchd started itself is its own argv',
  launchdProgram({ env: {}, argv: [process.execPath, SERVER], ppid: 1 }) === SERVER
);

check(
  'and a hand-run process claims nothing',
  launchdProgram({ env: {}, argv: [process.execPath, SERVER], ppid: 4242 }) === null
);

// With the inherited value dropped at the top of this file, this asks what it was
// written to ask: a process nobody's launchd started claims nothing, whatever it happens
// to have in its argv.
check(
  'this very process is not pretending to be a launchd job',
  launchdProgram() === null || launchdProgram() === process.argv[1],
  String(launchdProgram())
);

// A grep, and deliberately: the semantics above are worth nothing if the one process
// that can answer the question stops passing the answer on, and there is no way to
// make bin/router.js believe launchd started it from inside a test.
check(
  'bin/router.js hands the variable to every backend it spawns',
  fs.readFileSync(path.join(ROOT, 'bin', 'router.js'), 'utf8').includes('[LOADED_ENV]:'),
  'nothing in bin/router.js writes LOADED_ENV into the backend env'
);

/* ------------------------------------------------------ what a screen can draw (bc-4irq)
 *
 * hotSwapProblem() answers "is anything wrong", which is the right question for a log
 * banner and the wrong one for a console: the three days this bug survived were three
 * days of every surface saying nothing at all, and a line that appears only on a bad day
 * teaches you to read its absence as health. serviceHealth() therefore always answers
 * "what is launchd running".
 */

console.log('\nthe health line, good day and bad');

{
  const good = serviceHealth({ root: ROOT, home: home('healthy', plistFor(ROUTER)) });
  check('a good install still says something', good.ok === true && good.code === 'live', JSON.stringify(good.code));
  check('and says which program', good.label === 'bin/router.js', String(good.label));
  check('short enough for a phone — relative to the checkout', !path.isAbsolute(good.label), String(good.label));
  check('with nothing to fix', good.fix === null && good.lines.length === 0, JSON.stringify(good));
  check('and where it looked, for the doubtful', good.plist.endsWith(`${LABEL}.plist`), good.plist);
}

{
  // Why the good day above needs that scrub, as a case rather than as a comment.
  // serviceHealth() asks the environment whenever its caller passes nothing, so a
  // BEADCAUSE_LAUNCHD_PROGRAM inherited from another checkout's router turns a perfectly
  // good install into `not-reloaded`. The default is right where it lives — the console
  // has no other way to know what launchd started — and wrong for a test, which is the
  // whole of bc-nv25.
  const h = home('inherited', plistFor(ROUTER));
  const elsewhere = '/Users/someone/else/beadcause/bin/router.js';
  let ambient, asked;
  process.env[LOADED_ENV] = elsewhere;
  try {
    ambient = serviceHealth({ root: ROOT, home: h });
    asked = serviceHealth({ root: ROOT, home: h, loadedProgram: null });
  } finally {
    delete process.env[LOADED_ENV];
  }
  check('a caller that passes nothing gets the environment answer', ambient.code === 'not-reloaded', JSON.stringify(ambient.code));
  check('and one that passes null gets the file answer, whatever the shell was carrying', asked.ok === true, JSON.stringify(asked.code));
}

{
  const bad = serviceHealth({ root: ROOT, home: home('served', plistFor(SERVER)) });
  check('the bug itself is not ok', bad.ok === false && bad.code === 'runs-the-server', JSON.stringify(bad.code));
  check('it names what launchd runs', bad.label === 'bin/beadcause.js', String(bad.label));
  check('and what it should have been running', bad.wantLabel === 'bin/router.js', String(bad.wantLabel));
  check('it carries the same sentences as the log banner', bad.lines.length > 0, JSON.stringify(bad.lines));
  check('and the one command that fixes it', bad.fix === 'npm run install-service', String(bad.fix));
  // The log's line breaks are a log's line breaks. On a phone they land mid-sentence,
  // so the same words come as one paragraph for a screen to wrap itself.
  check('the prose is offered as a paragraph, not as log lines', !bad.detail.includes('\n') && bad.detail.length > 40, bad.detail);
  check(
    'and the command is not in it twice — the fix has its own row',
    !bad.detail.includes(bad.fix),
    bad.detail
  );
  check('with the words that introduce it', bad.fixBefore === 'fix it:', JSON.stringify(bad.fixBefore));
}

{
  // The two codes where the words around the command carry meaning: one makes the fix
  // conditional, the other says what it does. A bare command would drop both.
  const foreign = serviceHealth({ root: ROOT, home: home('conditional', plistFor('/x/other/bin/router.js')) });
  check(
    'a foreign checkout keeps the condition on its fix',
    foreign.fixBefore.includes('if this is the checkout'),
    JSON.stringify(foreign.fixBefore)
  );

  const stale = serviceHealth({ root: ROOT, home: home('afterwords', plistFor(ROUTER)), loadedProgram: SERVER });
  check('and a stale job keeps what the fix does after it', stale.fixAfter.includes('boots the job out'), JSON.stringify(stale.fixAfter));
}

{
  // The only case where reading the file alone gives the reassuring answer, so the
  // health line must report the *running* program rather than the file's.
  const h = home('stalejob', plistFor(ROUTER));
  const svc = serviceHealth({ root: ROOT, home: h, loadedProgram: SERVER });
  check('a stale job is reported as the program that is running', svc.label === 'bin/beadcause.js', String(svc.label));
  check('and not as the file that is correct', svc.code === 'not-reloaded', JSON.stringify(svc.code));
}

{
  const other = '/Users/someone/else/beadcause/bin/router.js';
  const svc = serviceHealth({ root: ROOT, home: home('elsewhere', plistFor(other)) });
  check("somebody else's checkout keeps its whole path", svc.label === other, String(svc.label));
}

/* -------------------------------------------------- and it reaches the console (bc-4irq) */

console.log('\non the wire, and on the page');

{
  // A real daemon, asked the way the console asks. HOME is pointed at a fake home
  // holding the plist from the incident, so this asserts the verdict and not merely
  // the shape — and it is restored afterwards, since everything else in the process
  // resolves paths through it.
  const fakeHome = home('viaserver', plistFor(SERVER));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  process.env.BEADCAUSE_CONFIG_DIR = path.join(tmpdir, 'config');
  fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
  try {
    const { createApp, listen } = await import(path.join(ROOT, 'lib', 'server.js'));
    const cfg = {
      port: 0,
      host: '127.0.0.1',
      token: 'test-token-not-a-secret',
      workspaces: [],
      spaces: [],
      claudeSessions: false,
      advocates: { enabled: false, workspaces: [] },
      ntfy: {},
    };
    const app = createApp(cfg);
    const servers = listen(cfg, app.handler);
    cfg.port = await boundPort(servers);
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port}/api/work`, {
        headers: { 'x-beadcause-token': cfg.token },
      });
      const body = await res.json();
      check('/api/work carries the verdict', res.status === 200 && Boolean(body.service), JSON.stringify(body.service));
      check(
        'and it is the real one, not a placeholder',
        body.service?.code === 'runs-the-server' && body.service?.ok === false,
        JSON.stringify(body.service)
      );
      check(
        'with the fix, so the console never has to explain itself',
        body.service?.fix === 'npm run install-service' && body.service?.lines?.length > 0,
        JSON.stringify(body.service)
      );
    } finally {
      for (const s of servers) s.close();
    }
  } finally {
    process.env.HOME = realHome;
  }
}

{
  // The payload is half of it. A field nothing draws is the same silence as before —
  // which is exactly what this bead was filed about.
  const page = fs.readFileSync(path.join(ROOT, 'public', 'monitor.js'), 'utf8');
  check('the advocate console reads it', page.includes('data.service'), 'public/monitor.js never mentions data.service');
  check(
    'it draws the good day as well as the bad one',
    /svc\.ok/.test(page) && page.includes('HOT-SWAP IS NOT LIVE'),
    'public/monitor.js draws only one of the two states'
  );
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  check('and the loud state is actually styled', css.includes('.svc.bad'), 'no .svc.bad in public/style.css');
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
