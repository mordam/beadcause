#!/usr/bin/env node
//
// A deploy that restarts a label, against the plist that label actually points at.
//
//   npm test                  (runs it alongside the rest)
//   node test/launchagent.mjs
//
// The failure this exists for is the only one in a deploy that exits 0. `launchctl
// kickstart -k gui/501/m4m.beadcause` restarts whatever job is loaded under that label;
// it has no opinion about the checkout the three steps before it just fast-forwarded,
// and on this Mac it spent three days faithfully restarting bin/beadcause.js while the
// repo, the installer and the README all described bin/router.js. Every deploy would
// have reported success.
//
// So what is worth testing is the refusal, and its two halves:
//
//   1. **It only judges what it can judge.** `fly deploy` has no label. `bootout` is
//      the reload, not the drift. A `system/` target is a LaunchDaemon nobody here
//      installed. Each of those must come back clean, because a false refusal takes a
//      working deploy off the air — which is worse than the bug.
//   2. **When it does refuse, it names the program.** "The LaunchAgent is stale" is not
//      actionable; "launchd would have restarted /x/bin/beadcause.js" is. The bead's
//      acceptance criterion is that sentence, so it is asserted as a string.
//
// Every case writes its own fake home, so nothing reads the real ~/Library/LaunchAgents
// and this passes identically on a machine with no service installed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LABEL } from '../lib/service.js';
import { launchAgentProblem, restartedLabel } from '../lib/launchagent.js';

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-launchagent-'));
process.on('exit', () => fs.rmSync(tmpdir, { recursive: true, force: true }));

/** A checkout to deploy: a directory with the two programs install.sh chooses between. */
function checkout(name) {
  const dir = path.join(tmpdir, name, 'repo');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'router.js'), '');
  fs.writeFileSync(path.join(dir, 'bin', 'beadcause.js'), '');
  return dir;
}

/** A fake home whose LaunchAgents folder holds exactly the plist a case needs. */
function home(name, label, program) {
  const dir = path.join(tmpdir, name, 'home');
  const agents = path.join(dir, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  if (program !== null) fs.writeFileSync(path.join(agents, `${label}.plist`), plistFor(label, program));
  return dir;
}

const plistFor = (label, program) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>${program}</string>
  </array>
</dict>
</plist>
`;

const KICKSTART = (label) => ['launchctl', 'kickstart', '-k', `gui/501/${label}`];

/* ------------------------------------------------------------ what has a label */

console.log('which commands have a label at all');

check('a kickstart names the label it would restart', restartedLabel(KICKSTART('m4m.x')) === 'm4m.x');
check('so does a kill, whose signal sits where the flag was', restartedLabel(['launchctl', 'kill', 'SIGHUP', 'user/501/m4m.x']) === 'm4m.x');
check('an absolute launchctl is still launchctl', restartedLabel(['/bin/launchctl', 'kickstart', 'gui/0/m4m.x']) === 'm4m.x');

// Every one of these must be null, and for a different reason. A false positive here
// is a refused deploy of a repo that never had a LaunchAgent in the first place.
check('fly deploy has no label', restartedLabel(['fly', 'deploy']) === null);
check('a script has no label', restartedLabel(['bash', 'scripts/deploy.sh']) === null);
check('bootstrap is the reload, not the drift', restartedLabel(['launchctl', 'bootstrap', 'gui/501', '/x/a.plist']) === null);
check('bootout likewise', restartedLabel(['launchctl', 'bootout', 'gui/501/m4m.x']) === null);
check('a system target is a LaunchDaemon this cannot see', restartedLabel(['launchctl', 'kickstart', '-k', 'system/m4m.x']) === null);
check('an empty command is not a launchctl line', restartedLabel([]) === null && restartedLabel(null) === null);

/* -------------------------------------------------------------- our own label */

console.log('\nour own label gets the hot-swap verdict');

{
  const dir = checkout('good');
  const h = home('good', LABEL, path.join(dir, 'bin', 'router.js'));
  check(
    'a plist naming this checkout’s bin/router.js is no problem at all',
    launchAgentProblem({ command: KICKSTART(LABEL), dir, home: h }) === null
  );
}

{
  // The bug, exactly as it sat here: the program is inside the right checkout, and it
  // is the wrong file. No containment test could catch this, which is why the label
  // beadcause installs gets lib/service.js's verdict rather than the generic one.
  const dir = checkout('stale');
  const server = path.join(dir, 'bin', 'beadcause.js');
  const problem = launchAgentProblem({ command: KICKSTART(LABEL), dir, home: home('stale', LABEL, server) });
  check('a plist naming bin/beadcause.js is refused', problem?.code === 'runs-the-server', JSON.stringify(problem?.code));
  check('and it names the program launchd would have restarted', problem?.program === server, String(problem?.program));
  check(
    'the message a phone sees says so in a sentence',
    problem?.message.includes(`launchd would have restarted ${server}`),
    JSON.stringify(problem?.message)
  );
  check('it says what fixes it', problem?.message.includes('npm run install-service'), JSON.stringify(problem?.message));
  check('and which label it refused', problem?.label === LABEL, String(problem?.label));
}

{
  const dir = checkout('none');
  const problem = launchAgentProblem({ command: KICKSTART(LABEL), dir, home: home('none', LABEL, null) });
  check('no plist at all is a refusal, not a shrug', problem?.code === 'not-installed', JSON.stringify(problem?.code));
  check(
    'and it admits it cannot name the program, rather than inventing one',
    problem?.program === null && problem?.message.includes('cannot be named'),
    JSON.stringify(problem?.message)
  );
}

/* ------------------------------------------------------------- another label */

console.log('\nany other label: is the program in the tree we deployed?');

{
  const dir = checkout('other');
  const h = home('other', 'org.someone.thing', path.join(dir, 'bin', 'serve.js'));
  check(
    'a program inside the deployed directory passes, whatever it is called',
    launchAgentProblem({ command: KICKSTART('org.someone.thing'), dir, home: h }) === null
  );
}

{
  const dir = checkout('elsewhere');
  const h = home('elsewhere', 'org.someone.thing', '/opt/other-checkout/bin/serve.js');
  const problem = launchAgentProblem({ command: KICKSTART('org.someone.thing'), dir, home: h });
  check('a program outside it is refused', problem?.code === 'foreign-program', JSON.stringify(problem?.code));
  check(
    'and the refusal names it',
    problem?.message.includes('launchd would have restarted /opt/other-checkout/bin/serve.js'),
    JSON.stringify(problem?.message)
  );
  check(
    'saying plainly that the restart would change nothing',
    problem?.message.includes('put back exactly what was already running'),
    JSON.stringify(problem?.message)
  );
}

{
  const dir = checkout('binary');
  const agents = path.join(tmpdir, 'binary', 'home', 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'org.someone.thing.plist'), 'bplist00 rubbish');
  const problem = launchAgentProblem({
    command: KICKSTART('org.someone.thing'),
    dir,
    home: path.join(tmpdir, 'binary', 'home'),
  });
  check('a plist that cannot be parsed is unknown, and unknown is not yes', problem?.code === 'unreadable', JSON.stringify(problem?.code));
}

/* ---------------------------------------------------------- the declaration */

console.log('\nwhat the declaration can say about it');

{
  const dir = checkout('optout');
  const h = home('optout', 'org.someone.thing', '/opt/other-checkout/bin/serve.js');
  check(
    '`launchAgent: false` says this is none of our business, and is obeyed',
    launchAgentProblem({ command: KICKSTART('org.someone.thing'), dir, home: h, launchAgent: false }) === null
  );
}

{
  // A declared program is a stricter test than containment, not a looser one: it must
  // be that program, so the file that is inside the tree and wrong is caught too.
  const dir = checkout('declared');
  const h = home('declared', 'org.someone.thing', path.join(dir, 'bin', 'beadcause.js'));
  const cmd = KICKSTART('org.someone.thing');
  check(
    'a declared program that matches passes',
    launchAgentProblem({ command: cmd, dir, home: h, launchAgent: 'bin/beadcause.js' }) === null
  );
  const problem = launchAgentProblem({ command: cmd, dir, home: h, launchAgent: 'bin/router.js' });
  check('one that does not is refused even though it is in the tree', problem?.code === 'foreign-program', JSON.stringify(problem?.code));
  check(
    'and it says a rewritten plist still has to be booted out',
    problem?.message.includes('never booted out'),
    JSON.stringify(problem?.message)
  );
}

{
  // A declaration overrides even our own label's verdict — the escape hatch has to work
  // on the one repo most likely to need it.
  const dir = checkout('ownoverride');
  const h = home('ownoverride', LABEL, path.join(dir, 'bin', 'beadcause.js'));
  check(
    'declaring bin/beadcause.js for our own label is allowed, deliberately',
    launchAgentProblem({ command: KICKSTART(LABEL), dir, home: h, launchAgent: 'bin/beadcause.js' }) === null
  );
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
