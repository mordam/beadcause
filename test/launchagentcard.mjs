#!/usr/bin/env node
/**
 * A refusal over a stale LaunchAgent, as fields rather than as one truncated paragraph.
 *
 *     npm test
 *     node test/launchagentcard.mjs
 *
 * bc-tj36 gave the deploy a verdict and wrote it onto the record, and both readers then
 * threw the structure away. The deploy strip printed `rec.error` — the whole verdict as
 * a wrapped paragraph in the gap above the steps — and the notification sent
 * `rec.error.slice(0, 300)`. That slice is the bug worth a suite: the message leads with
 * the refusal and *ends* with the command that fixes it, so the truncation eats the fix
 * first. A notification that says a deploy was refused and cannot say what to type is one
 * that costs you the walk to the Mac it was sent to save.
 *
 * The notification is a bus event rather than an ntfy push since bc-ka5y.15.1 — the
 * Android app draws the card — so claim 3 below reads `deployEvent` in lib/news.js. The
 * composition moved with it verbatim, which is why the assertions did not have to.
 *
 * So four claims, one per reader:
 *
 * 1. **The verdict carries the facts as keys**, not only inside its prose — `label`,
 *    `program`, `plist`, `fix`, `fixCommand`. Nothing downstream should be parsing a
 *    paragraph to find a path.
 * 2. **They survive onto the deploy record**, which is the only thing either reader
 *    ever sees. test/deploy.mjs drives the runner into a real refusal; this asserts the
 *    shape it wrote.
 * 3. **The notification carries them, and stays short enough that none is cut.** The
 *    old behaviour is checked as a regression rather than described: the message must
 *    reach the fix, and a 300-character slice of the paragraph provably does not. It
 *    also checks the classification — a refused deploy is *work being stuck* rather than
 *    a release, which is the difference between the one voice allowed to insist and a
 *    water drop you never hear.
 * 4. **The screen reads the fields rather than the paragraph.** A static read of
 *    public/prs.js and public/style.css, like test/quietcard.mjs: the renderer needs the
 *    whole board document to run, so what is checked is what a refactor breaks quietly
 *    — that each field is read, that the error paragraph is no longer printed beside
 *    them, and that the classes it draws have rules.
 *
 * Hermetic: fake homes and fake checkouts under a scratch dir, so nothing reads the
 * real ~/Library/LaunchAgents and this passes on a machine with no service installed.
 * Claim 3 needs no server at all now — the event is a value, so it is asserted directly
 * rather than through a relay stood up to catch it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-lacard-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// Not a bare `fs.rmSync`: an `exit` handler cannot await, and a scratch tree the code
// under test may still be writing into is what test/helpers/tmp.mjs exists for.
process.on('exit', () => removeTreeSync(tmp));

const { LABEL } = await import('../lib/service.js');
const { launchAgentProblem } = await import('../lib/launchagent.js');
const { deployEvent } = await import('../lib/news.js');

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/** A checkout to deploy: a directory with the two programs install.sh chooses between. */
function checkout(name) {
  const dir = path.join(tmp, name, 'repo');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'router.js'), '');
  fs.writeFileSync(path.join(dir, 'bin', 'beadcause.js'), '');
  return dir;
}

/** A fake home whose LaunchAgents folder holds exactly the plist a case needs. */
function home(name, label, program) {
  const dir = path.join(tmp, name, 'home');
  const agents = path.join(dir, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  if (program !== null) {
    fs.writeFileSync(
      path.join(agents, `${label}.plist`),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/node</string><string>${program}</string></array>
</dict>
</plist>
`
    );
  }
  return dir;
}

const KICKSTART = (label) => ['launchctl', 'kickstart', '-k', `gui/501/${label}`];

/* --------------------------------------------------- 1. the verdict has fields */

console.log('the verdict carries the facts as keys, not only in its prose');

// The bug exactly as it sat on this Mac: the plist names a program inside the right
// checkout, and it is the wrong file. This is the verdict a real refusal here produces.
const dir = checkout('stale');
const server = path.join(dir, 'bin', 'beadcause.js');
const plist = path.join(tmp, 'stale', 'home', 'Library', 'LaunchAgents', `${LABEL}.plist`);
const v = launchAgentProblem({ command: KICKSTART(LABEL), dir, home: home('stale', LABEL, server) });

check('the label it refused', v?.label === LABEL, String(v?.label));
check('the program launchd would have restarted', v?.program === server, String(v?.program));
check('the plist that says so', v?.plist === plist, String(v?.plist));
check('the fix, as a phrase', typeof v?.fix === 'string' && v.fix.length > 0, JSON.stringify(v?.fix));
check('and as the command that performs it', v?.fixCommand === 'npm run install-service', String(v?.fixCommand));

// The whole point of the fields is that nothing has to go looking in the prose. A path
// found by regex over `message` is a path that moves when a sentence is reworded.
check(
  'none of them needs the paragraph read to be found',
  [v?.label, v?.program, v?.plist, v?.fixCommand].every((x) => typeof x === 'string' && x.length),
  JSON.stringify({ label: v?.label, program: v?.program, plist: v?.plist, fixCommand: v?.fixCommand })
);

// A verdict about a label this repo did not install still has to answer the same
// questions. There is no command it can honestly offer — how someone else's job is
// installed is not ours to know — so `fixCommand` is null and `fix` still says what to
// do. Null is the honest answer; a made-up command would be worse than the paragraph.
{
  const d = checkout('foreign');
  const other = path.join(tmp, 'elsewhere', 'bin', 'thing.js');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, '');
  const f = launchAgentProblem({
    command: KICKSTART('org.someone.thing'),
    dir: d,
    home: home('foreign', 'org.someone.thing', other),
  });
  check('a foreign label is answered with the same keys', f?.label === 'org.someone.thing' && f?.program === other, JSON.stringify(f?.code));
  check('it says what to do', typeof f?.fix === 'string' && f.fix.length > 0, JSON.stringify(f?.fix));
  check('and offers no command it cannot stand behind', f?.fixCommand === null, String(f?.fixCommand));
}

// A plist that is not there has no program and no path to read — and must say so
// rather than carrying an empty string that renders as a blank field.
{
  const d = checkout('absent');
  const n = launchAgentProblem({ command: KICKSTART(LABEL), dir: d, home: home('absent', LABEL, null) });
  check('with no plist installed the program is null, not blank', n?.program === null, JSON.stringify(n?.program));
  check('but where launchd looked is still named', typeof n?.plist === 'string' && n.plist.endsWith('.plist'), String(n?.plist));
}

/* --------------------------------------------- 3. what the notification carries */

console.log('\nthe notification carries the fields, and none of them is cut off');

// An event on the bus rather than an ntfy push since bc-ka5y.15.1 — the Android app
// draws this card itself, on the one channel it is allowed to be insistent about. So
// there is no relay to stand up here any more: `deployEvent` composes the whole payload
// and the assertions below are the same four, against `text` instead of `message`.
const rec = {
  id: 'd-test',
  workspace: 'beadcause',
  status: 'failed',
  base: 'main',
  to: 'abcdef1234567890',
  bead: 'bc-jrw0',
  reason: 'shipping bc-jrw0',
  error: v.message,
  launchAgent: v,
};
const event = deployEvent(rec);
const msg = event.text || '';

check('a refused deploy is work being stuck, not a release', event.type === 'stuck' && event.state === 'stuck', JSON.stringify(event.type));
check('and a muted space cannot silence it', event.quiet === false, JSON.stringify(event.quiet));
check('it names the label', msg.includes(LABEL), JSON.stringify(msg));
check('it names the program launchd would have restarted', msg.includes(server), JSON.stringify(msg));
check('and it reaches the fix', msg.includes('npm run install-service'), JSON.stringify(msg));

// The regression, stated as arithmetic rather than as a description: the paragraph this
// replaced puts the fix past the cut, so the old push could not have carried it however
// carefully it was read.
check(
  'which the 300-character slice of the paragraph provably did not',
  !v.message.slice(0, 300).includes('npm run install-service'),
  `the message got shorter than 300 chars — this check no longer proves anything: ${JSON.stringify(v.message)}`
);
check('and it stays short enough to read on a lock screen', msg.length < 300, `${msg.length} chars`);

// Every other deploy is untouched: a failure with no LaunchAgent verdict still says the
// error it always said, and a success is a release rather than a blockage.
{
  const plain = deployEvent({ ...rec, launchAgent: null, error: 'the deploy command failed (exit 1)' });
  check('an ordinary failure still carries its error', (plain.text || '').includes('exit 1'), JSON.stringify(plain.text));
  const good = deployEvent({ ...rec, status: 'ok', launchAgent: null, error: null });
  check('and a success is a release', good.type === 'released' && good.title.includes('deployed'), JSON.stringify(good.title));
}

/* ----------------------------------------------------- 4. what the screen reads */

console.log('\nthe deploy strip reads the fields rather than the paragraph');

const prs = fs.readFileSync(path.join(ROOT, 'public', 'prs.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

check('there is a renderer for the verdict at all', /function launchAgentHtml/.test(prs));
for (const field of ['label', 'program', 'plist', 'fix', 'fixCommand']) {
  check(`it reads la.${field}`, new RegExp(`la\\.${field}\\b`).test(prs), 'the field is on the record and nothing on screen reads it');
}
check(
  'the unfolded deploy draws it',
  /rec\.launchAgent \? launchAgentHtml\(rec\)/.test(prs),
  'launchAgentHtml exists but nothing calls it'
);
// The acceptance criterion is fields *rather than* a paragraph. Drawing both would
// leave the truncated-looking prose on screen beside the thing that replaced it.
check(
  'and does not print the error paragraph beside it',
  /rec\.launchAgent \? launchAgentHtml\(rec\) : rec\.error \?/.test(prs),
  'the paragraph is still drawn for a refusal'
);
for (const cls of ['deploy-la', 'la-head', 'la-fields', 'la-row', 'la-note', 'la-why']) {
  check(`.${cls} has a rule`, new RegExp(`\\.${cls}[\\s,{:]`).test(css), 'a class the strip draws with no styling behind it');
}

console.log(
  failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\n\x1b[32mall ${ran} passed\x1b[0m`
);
process.exit(failures ? 1 : 0);
