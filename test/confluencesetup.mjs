#!/usr/bin/env node
/**
 * The setup question with two switches in it, and the one whose safe answer is "no".
 *
 *     npm test
 *     node test/confluencesetup.mjs
 *
 * `npm run configure` asks about Confluence (lib/confluencesetup.js). Three things about
 * that block are worth a suite of its own, and none of them is "does it ask questions".
 *
 * **The API token must not reach `config.json`.** That file is committed to the git repo
 * lib/commonrepo.js keeps, after every write — so a token in it is not on a disk, it is in
 * a history a rotation cannot reach back into. It is the same rule the Google client
 * secret is under (test/signinsetup.mjs asserts the same thing about that one), and a
 * setup script that asks somebody to paste a credential is the most natural place in the
 * codebase to break it by accident. So the assertion is blunt and deliberately not about
 * fields: the pasted string must not appear **anywhere** in the serialised config.
 *
 * **`readSpaces` must not acquire a default.** Reading is off on every install until
 * somebody names a space, and it deliberately does not inherit `confluence.space` — the
 * token that publishes can read the whole site, so inheriting would mean *every
 * unattended agent this Mac dispatches may read the company wiki*, decided by nobody, on
 * the day publishing was switched on for an unrelated reason (bc-xecw). A wizard is the
 * easiest place in the codebase to lose that property, because the obliging thing for a
 * prompt to do is offer back the space you typed one question earlier. So this suite
 * asserts the *offered default* as well as the answer: an install publishing into `ENG`
 * is offered `none`, and Enter through it leaves the list empty.
 *
 * **Turning it off has to turn all of it off.** Clearing the site and leaving `space` or
 * `readSpaces` behind is a config that `problem` and `readProblem` both read as "wants
 * Confluence", so every summary afterwards would report a deliberate off as a
 * misconfiguration naming the site that was just deleted on purpose.
 *
 * The prompts are scripted rather than typed: `askConfluence` takes its `ask`/`yes`/
 * `secret` from the caller, so a test can hand it a queue of answers and read back both
 * what it wrote and every line it printed. That is the whole reason the block lives in
 * lib/ rather than inline in scripts/configure.js, where nothing could reach it without a
 * pty.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-confsetup-'));
// Before lib/config.js is imported: CONFIG_DIR resolves once, at module load, and the
// token file is looked for underneath it.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// The env var masks the file in `apiToken`, which is precisely what several of these
// assertions are about.
delete process.env.BEADCAUSE_CONFLUENCE_TOKEN;

const { askConfluence, parseSpaceKeys } = await import(LIB('confluencesetup.js'));
const { apiTokenFile, confluenceStatus, readableSpaces } = await import(LIB('confluence.js'));

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const is = (name, got, want) =>
  got === want ? ok(name) : bad(name, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const has = (name, haystack, needle) =>
  haystack.includes(needle)
    ? ok(name)
    : bad(name, `no ${JSON.stringify(needle)} in:\n      ${haystack.replace(/\n/g, '\n      ')}`);

/* ------------------------------------------------------------------- a terminal */

/**
 * Somebody at the keyboard, replaced by a list.
 *
 * Answers are taken in order, and an empty string means they pressed Enter — which is why
 * `ask` applies the default the same way scripts/configure.js does. Running out of answers
 * throws rather than blocking, so a block that grows a question and a test that does not
 * is a failure and never a hang.
 *
 * `offered` is the half `keyboard` in test/signinsetup.mjs does not need: what this block
 * *proposes* for the readable-spaces question is itself a property under test, and it is
 * invisible in the answer, since the answer is whatever the script said.
 */
function keyboard(answers) {
  const queue = [...answers];
  const lines = [];
  const asked = [];
  const take = (what) => {
    if (!queue.length) throw new Error(`ran out of scripted answers at ${what}`);
    return queue.shift();
  };
  return {
    lines,
    asked,
    left: () => queue.length,
    offered: (fragment) => asked.find((a) => a.q.includes(fragment))?.dflt,
    io: {
      ask: async (q, dflt) => {
        const typed = take(q);
        asked.push({ q, dflt });
        return String(typed).trim() || dflt;
      },
      yes: async (q, dflt = 'n') => /^y/i.test(String(take(q)).trim() || dflt),
      secret: async (q) => {
        const typed = take(q);
        asked.push({ q, dflt: '' });
        return String(typed).trim();
      },
      log: (line) => lines.push(String(line)),
    },
  };
}

/** A configuration with nothing about Confluence in it, the way a fresh install arrives. */
const fresh = () => ({ port: 4318 });

const TOKEN = 'ATATT3x-not-a-real-token';
const TOKEN_FILE = apiTokenFile({});
const forget = () => fs.rmSync(TOKEN_FILE, { force: true });

console.log('\nnpm run configure — the Confluence block');

/* ------------------------------------------------------------------ answering n */

{
  forget();
  const cfg = fresh();
  const kb = keyboard(['n']);
  const out = await askConfluence(cfg, kb.io);
  is('declining asks nothing else', kb.left(), 0);
  is('declining leaves publishing off', out.on, false);
  is('declining leaves reading off', out.reading, false);
  is('declining changes nothing', out.changed, false);
  is('declining writes no config', cfg.confluence, undefined);
  is('declining writes no token file', fs.existsSync(TOKEN_FILE), false);
  has('the current state is shown before the question', kb.lines.join('\n'), 'currently: off');
}

/* ------------------------------------------------------- the whole thing, at once */

{
  forget();
  const cfg = fresh();
  // site, email, space, token, readable spaces — in the order they are asked.
  const kb = keyboard(['y', 'https://yourteam.atlassian.net', 'you@yourteam.com', 'ENG', TOKEN, 'eng, RUNBOOKS']);
  const out = await askConfluence(cfg, kb.io);

  is('every answer was used', kb.left(), 0);
  is('publishing comes out on', out.on, true);
  is('reading comes out on', out.reading, true);
  is('the site is in the config', cfg.confluence.site, 'https://yourteam.atlassian.net');
  is('the email is in the config', cfg.confluence.email, 'you@yourteam.com');
  is('the space is in the config', cfg.confluence.space, 'ENG');
  is('the readable spaces are uppercased and kept in order', cfg.confluence.readSpaces.join(','), 'ENG,RUNBOOKS');

  // The assertion this file exists for. Not "there is no token field" — the whole
  // serialised config, because a token that reached any other field would be in the same
  // committed history and would pass a field-shaped check.
  is('the token is NOWHERE in the config', JSON.stringify(cfg).includes(TOKEN), false);
  is('the token is in the file', fs.readFileSync(TOKEN_FILE, 'utf8').trim(), TOKEN);
  is('the file is 0600', (fs.statSync(TOKEN_FILE).mode & 0o777).toString(8), '600');
  // The default path, whose `.key` name is what the config repo both ignores and refuses.
  is('the file is the .key one', path.basename(TOKEN_FILE), 'confluence.key');

  is('and the status agrees on both halves', confluenceStatus(cfg).text, 'publishing into ENG, reading ENG, RUNBOOKS');
  has('it says publishing is on', kb.lines.join('\n'), 'Publishing is on');
  has('and names what may be read', kb.lines.join('\n'), 'Reading is on for ENG, RUNBOOKS');
}

/* ------------------------------------- the space you publish into is not a default */

{
  // The property bc-xecw settled, at the one screen most likely to undo it. Publishing is
  // fully configured and the readable-spaces question still opens at "none"; Enter leaves
  // the list empty rather than helpfully filling in the space named two questions earlier.
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://yourteam.atlassian.net', 'you@yourteam.com', 'ENG', TOKEN, '']);
  const out = await askConfluence(cfg, kb.io);

  is('the readable-spaces question opens at none', kb.offered('readable spaces'), 'none');
  is('Enter through it reads nothing', cfg.confluence.readSpaces.length, 0);
  is('publishing is on all the same', out.on, true);
  is('and reading is off', out.reading, false);
  is('which is not a misconfiguration', confluenceStatus(cfg).text, 'publishing into ENG, reading nothing');
  has('and is said as the default rather than a fault', kb.lines.join('\n'), 'which is the default');
  // No "re-run configure to finish it": an install that publishes and deliberately reads
  // nothing is finished, and nagging it would be nagging it about the safe answer.
  is('nothing tells them to run it again', kb.lines.join('\n').includes('to finish it'), false);

  // A second run over that install offers back the empty list, not the space. Same
  // property, one run later, which is where a "helpful" default would actually appear.
  const again = keyboard(['y', '', '', '', '', '']);
  await askConfluence(cfg, again.io);
  is('a re-run still opens at none', again.offered('readable spaces'), 'none');
  is('and still reads nothing', cfg.confluence.readSpaces.length, 0);
}

/* ------------------------------------------------------ cancelled means cancelled */

{
  // scripts/configure.js promises that Ctrl+C anywhere leaves everything as it was, and
  // the token is the one answer that goes somewhere other than the config object — so it
  // is the one place that promise could quietly stop being true. Running out of scripted
  // answers stands in for the interrupt: the block gets as far as the readable-spaces
  // question, with the token already typed, and then never finishes.
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://yourteam.atlassian.net', 'you@yourteam.com', 'ENG', TOKEN]);
  let threw = false;
  try {
    await askConfluence(cfg, kb.io);
  } catch {
    threw = true;
  }
  is('the block did not finish', threw, true);
  is('and the typed token never reached the disk', fs.existsSync(TOKEN_FILE), false);
  is('and nothing was written to the config either', cfg.confluence, undefined);
}

/* --------------------------------------------------------- keeping and turning off */

{
  // A second run over a working install: Enter through every answer, and in particular an
  // empty token. Blank there means "keep it", not "wipe it" — the alternative is a
  // configure run that breaks publishing for touching an unrelated question.
  forget();
  const cfg = fresh();
  const first = keyboard(['y', 'https://yourteam.atlassian.net', 'you@yourteam.com', 'ENG', TOKEN, 'ENG']);
  await askConfluence(cfg, first.io);

  const again = keyboard(['y', '', '', '', '', '']);
  const out = await askConfluence(cfg, again.io);
  is('Enter through it all keeps publishing on', out.on, true);
  is('and reading on', out.reading, true);
  is('the token file is untouched', fs.readFileSync(TOKEN_FILE, 'utf8').trim(), TOKEN);
  is('the site is untouched', cfg.confluence.site, 'https://yourteam.atlassian.net');
  is('the space is untouched', cfg.confluence.space, 'ENG');
  is('the readable spaces are untouched', cfg.confluence.readSpaces.join(','), 'ENG');
  has('and it offers to keep the token rather than asking again', again.lines.join('\n'), 'One is already there');

  // "none" at the site is the way out, and it is the same word the workspace, Slack and
  // advocate questions use. It must not delete the token file: that is not this script's
  // to throw away.
  const off = keyboard(['y', 'none']);
  const gone = await askConfluence(cfg, off.io);
  is('"none" at the site turns Confluence off', gone.on, false);
  is('and says off rather than half-configured', gone.text, 'off');
  is('the site is cleared', cfg.confluence.site, null);
  is('the email is cleared', cfg.confluence.email, null);
  // Each of these left behind would read as "wants Confluence" and turn a deliberate off
  // into a misconfiguration reported at every startup from then on.
  is('the space goes with it', cfg.confluence.space, null);
  is('and so do the readable spaces', cfg.confluence.readSpaces.length, 0);
  is('a summary after that says off', confluenceStatus(cfg).text, 'off');
  is('the token file is left where it is', fs.readFileSync(TOKEN_FILE, 'utf8').trim(), TOKEN);
  has('it says which spaces it dropped', off.lines.join('\n'), 'the readable spaces went with it: ENG');
  has('and where the token it left behind is', off.lines.join('\n'), TOKEN_FILE);

  // And turning it back on is one run of the same question, with the site typed back in.
  const back = keyboard(['y', 'https://yourteam.atlassian.net', 'you@yourteam.com', 'ENG', '', 'none']);
  is('answering it again turns publishing back on', (await askConfluence(cfg, back.io)).on, true);
  is('on the token that was left on disk', cfg.confluence.site, 'https://yourteam.atlassian.net');
}

/* ------------------------------------------------- not enough, and which piece it is */

// Each of these leaves out exactly one piece and asserts the missing piece is the one
// named. That the daemon would draw no button is `problem`'s business and
// test/confluence.mjs's; what is tested here is that a person is told, at the moment they
// can still fix it.

{
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://yourteam.atlassian.net', '', 'ENG', TOKEN, 'none']);
  const out = await askConfluence(cfg, kb.io);
  is('no email → not publishing', out.on, false);
  has('and the email is what it names', kb.lines.join('\n'), 'confluence.email is missing');
  has('with an offer to come back to it', kb.lines.join('\n'), 'to finish it');
}

{
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://yourteam.atlassian.net', 'you@yourteam.com', 'ENG', '', 'none']);
  const out = await askConfluence(cfg, kb.io);
  is('no token → not publishing', out.on, false);
  has('and the file to put one in is named', kb.lines.join('\n'), TOKEN_FILE);
}

{
  // Reading configured on top of a publish config that cannot work: both halves are off,
  // and the reason each is off is its own sentence rather than one shared apology.
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://yourteam.atlassian.net', 'you@yourteam.com', 'none', '', 'ENG']);
  const out = await askConfluence(cfg, kb.io);
  is('no token → not reading either', out.reading, false);
  has('and reading says so in its own words', kb.lines.join('\n'), 'Reading is off');
}

{
  // No global space, and no beadcause space naming one: publishing has nowhere to go, and
  // reading is entirely unaffected by that. The two switches, disagreeing.
  forget();
  const cfg = fresh();
  const kb = keyboard(['y', 'https://yourteam.atlassian.net', 'you@yourteam.com', 'none', TOKEN, 'ENG']);
  const out = await askConfluence(cfg, kb.io);
  is('no space → not publishing', out.on, false);
  is('but reading is on regardless', out.reading, true);
  has('and the missing space is what it names', kb.lines.join('\n'), 'no Confluence space to publish into');
  is('the status carries both answers', confluenceStatus(cfg).text.endsWith('reading ENG'), true);
}

/* --------------------------------------------------- a token that is only in a shell */

{
  // `BEADCAUSE_CONFLUENCE_TOKEN` makes publishing work in *this* terminal and nowhere
  // else: the daemon runs under launchd and never sees it. So the block must not report
  // it as a token that is already there — that sentence is an offer to press Enter, and
  // pressing Enter here leaves the install with no token at all.
  forget();
  process.env.BEADCAUSE_CONFLUENCE_TOKEN = 'ATATT3x-from-the-shell';
  const cfg = fresh();
  const kb = keyboard(['y', 'https://yourteam.atlassian.net', 'you@yourteam.com', 'ENG', '', 'none']);
  await askConfluence(cfg, kb.io);
  const said = kb.lines.join('\n');
  is('an env-var token is not "already there"', said.includes('One is already there'), false);
  has('and the shell-only half is said out loud', said, 'will not see it');
  is('nothing was written to the file', fs.existsSync(TOKEN_FILE), false);
  delete process.env.BEADCAUSE_CONFLUENCE_TOKEN;
}

/* ------------------------------------------------------------------- the parsing */

console.log('\nspace keys');

{
  const { keys, ignored } = parseSpaceKeys('  eng , ENG,  , RUNBOOKS, https://x.atlassian.net/wiki/spaces/OPS ');
  is('uppercased and de-duplicated', keys.join(','), 'ENG,RUNBOOKS');
  is('a pasted URL is named rather than stored', ignored.join(','), 'https://x.atlassian.net/wiki/spaces/OPS');
  is('an empty line is an empty list', parseSpaceKeys('').keys.length, 0);
  is('"none" alone is an empty list', parseSpaceKeys('none').keys.length, 0);
  // Only as the whole answer. A space genuinely called NONE is unlikely and it is not
  // worth making it unnameable to buy a sentinel that is already unambiguous.
  is('and inside a list it is a key like any other', parseSpaceKeys('ENG, none').keys.join(','), 'ENG,NONE');
  is('a personal space key survives', parseSpaceKeys('~712020abc').keys.join(','), '~712020ABC');
}

/* -------------------------------------------------------------------- the summary */

console.log('\nthe line in the summary');

{
  forget();
  is('nothing configured reads as off', confluenceStatus(fresh()).text, 'off');
  is('an empty block reads as off too', confluenceStatus({ confluence: { site: null, readSpaces: [] } }).text, 'off');
  const half = { confluence: { site: 'https://yourteam.atlassian.net', readSpaces: [] } };
  has('half configured says which piece', confluenceStatus(half).text, 'NOT publishing —');
  is('and is not on', confluenceStatus(half).on, false);
  // The line this exists for: publishing configured, reading off, and the summary must
  // not let that read as "Confluence is on".
  const readless = { confluence: { site: 'https://yourteam.atlassian.net', email: 'you@yourteam.com', space: 'ENG', readSpaces: [] } };
  has('a publishing install still says it reads nothing', confluenceStatus(readless).text, 'reading nothing');
  // Reading asked for on an install with no site: the read half complains on its own.
  const readonly = { confluence: { readSpaces: ['ENG'] } };
  has('readSpaces without a site says so', confluenceStatus(readonly).text, 'NOT reading —');
  is('and readableSpaces still reads the list', readableSpaces(readonly).join(','), 'ENG');
}

await cleanupTmp(tmp);

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'} (${ran} checks)\n`);
process.exit(failures ? 1 : 0);
