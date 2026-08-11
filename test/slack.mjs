#!/usr/bin/env node
/**
 * Slack as a second delivery surface for the same decision — lib/slack.js.
 *
 *     npm test
 *     node test/slack.mjs
 *
 * Four claims, and they are the four ways this feature goes wrong rather than four ways
 * it goes right.
 *
 * 1. **Unconfigured, nothing happens at all.** Not "posts nowhere" — *nothing runs*, and
 *    in particular no token is read off disk. The gate order in `slackReady` is the
 *    contract that says so, and it is checked here by its reason word: `disabled` can
 *    only be returned by the branch that comes before the one that opens the file.
 * 2. **A space decides which channel a repo reaches, in both directions.** The failure
 *    this exists to prevent is not a missing message: it is a question from a private
 *    side project appearing in a channel other people read. So a space must be able to
 *    say *no* as well as *there*, and the per-repo veto must outrank it.
 * 3. **A pressed button answers through `/api/respond`, with the option's own response.**
 *    The button carries an index and never the answer, so a payload from outside this
 *    process cannot decide what gets written on a bead. Checked against a fake endpoint
 *    that records exactly what arrived.
 * 4. **A message does not sit in a channel with live buttons over a bead that is gone.**
 *    `settleQuestion` rewrites it and forgets it — and forgets it *whatever* Slack said,
 *    because the half that matters is on our side: no registry entry, no answer.
 *
 * Hermetic. `BEADCAUSE_CONFIG_DIR` is a scratch directory, `slack.apiBase` and
 * `slack.answerBase` point at two servers this file starts, and nothing reaches
 * slack.com or the tracker. The env is scrubbed before the first import for the same
 * reason test/observe.mjs builds one from scratch: a `BEADCAUSE_OBSERVE` or a real bot
 * token in the shell must not be able to decide the result.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/* ------------------------------------------------------- a scrubbed environment */

for (const k of ['BEADCAUSE_OBSERVE', 'BEADCAUSE_READONLY', 'BEADCAUSE_SLACK_BOT_TOKEN', 'BEADCAUSE_SLACK_APP_TOKEN']) {
  delete process.env[k];
}
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-slack-'));
process.env.BEADCAUSE_CONFIG_DIR = DIR;
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }));

// After the env, never before: `CONFIG_DIR` resolves once, at module load.
const { loadState, saveState } = await import('../lib/config.js');
const { protectedPath } = await import('../lib/commonrepo.js');
const { slackChannelFor, slackDetailFor } = await import('../lib/spaces.js');
const slack = await import('../lib/slack.js');

/**
 * The shipped `slack` block, read out of the source rather than called.
 *
 * `defaults()` is not exported, and exporting it to be asserted on would be the wrong
 * trade: it shells out to git, tailscale and `~/beads` to build the *rest* of a config,
 * none of which this suite has any business doing. The claim being made here is about
 * what is written in the file — that no field in it is a token — and a static read is
 * the honest way to ask that.
 */
const CONFIG_SRC = fs.readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8');
const SHIPPED_SLACK = (() => {
  const start = CONFIG_SRC.indexOf('\n    slack: {');
  assert.ok(start > 0, 'no `slack:` block in lib/config.js — this suite is asserting about the wrong file');
  const end = CONFIG_SRC.indexOf('\n    },', start);
  return CONFIG_SRC.slice(start, end);
})();

/* --------------------------------------------------------------- the harness */

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    const r = fn();
    return r instanceof Promise
      ? r.then(
          () => console.log(`  \x1b[32m✓\x1b[0m ${name}`),
          (err) => {
            failures += 1;
            console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n').join('\n      ')}`);
          }
        )
      : Promise.resolve(console.log(`  \x1b[32m✓\x1b[0m ${name}`));
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n').join('\n      ')}`);
    return Promise.resolve();
  }
};

/** Every request the fake Slack and the fake beadcause have been sent, in order. */
const seen = [];
const reset = () => {
  seen.length = 0;
  saveState({ slack: {} });
};

function body(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({ raw });
      }
    });
  });
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * Slack, as far as this file is concerned: `chat.postMessage`, `chat.update`, and the
 * `response_url` an ephemeral reply goes to.
 *
 * `ts` counts up so two posts are distinguishable, which is how the "posted twice" case
 * would show itself if the guard against it ever went.
 */
let nextTs = 100;
let postReply = null;
const slackApi = http.createServer(async (req, res) => {
  const payload = await body(req);
  seen.push({ at: 'slack', path: req.url, auth: req.headers.authorization || null, payload });
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/chat.postMessage') {
    if (postReply) return res.end(JSON.stringify(postReply));
    return res.end(JSON.stringify({ ok: true, channel: payload.channel, ts: `1700000000.000${nextTs++}` }));
  }
  return res.end(JSON.stringify({ ok: true }));
});

/** This daemon's own `/api/respond`, standing in for the real one. */
let respondWith = { status: 200, payload: { ok: true, closed: true } };
const beadcause = http.createServer(async (req, res) => {
  const payload = await body(req);
  seen.push({ at: 'beadcause', path: req.url, token: req.headers['x-beadcause-token'] || null, payload });
  res.writeHead(respondWith.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(respondWith.payload));
});

const apiPort = await listen(slackApi);
const appPort = await listen(beadcause);

/* ------------------------------------------------------------------- fixtures */

const BOT = path.join(DIR, 'slack-bot.key');
fs.writeFileSync(BOT, 'xoxb-not-a-real-token\n', { mode: 0o600 });

const base = (over = {}) => ({
  baseUrl: 'https://mac.example.ts.net:4317',
  token: 'test-token-not-a-secret',
  port: appPort,
  spaces: [],
  ntfy: { enabled: false, detail: 'full', minimalWorkspaces: [] },
  slack: {
    // Written out rather than spread from the shipped block, so a default changing
    // under this suite is a decision somebody makes here rather than a silent shift in
    // what every case below was testing.
    detail: 'full',
    buttons: true,
    maxButtons: 5,
    excludeWorkspaces: [],
    appTokenFile: path.join(DIR, 'no-app-token.key'),
    enabled: true,
    channel: 'C-DEFAULT',
    botTokenFile: BOT,
    apiBase: `http://127.0.0.1:${apiPort}`,
    answerBase: `http://127.0.0.1:${appPort}`,
    ...over,
  },
});

const question = (over = {}) => ({
  key: 'acme/ac-1',
  workspace: 'acme',
  id: 'ac-1',
  question: 'Charge the platform fee on gross or net?',
  space: 'Work',
  decision: {
    options: [
      { id: 'gross', label: 'Gross', response: 'Gross — fee on the full charge amount.', closes: true },
      { id: 'net', label: 'Net', response: 'Net — fee after the seller share.', closes: true },
    ],
  },
  ...over,
});

const buttons = (blocks) =>
  (blocks.find((b) => b.type === 'actions')?.elements || []).filter((e) => /^bc-opt-/.test(e.action_id));

/* ============================================================ the space policy */

console.log('\nslack — which repos reach which channel\n');

await check('the global channel is the default for every workspace', () => {
  assert.equal(slackChannelFor(base(), 'acme'), 'C-DEFAULT');
});

await check('a space names its own channel, and it wins', () => {
  const cfg = base();
  cfg.spaces = [{ name: 'Work', workspaces: ['acme'], slackChannel: 'C-WORK' }];
  assert.equal(slackChannelFor(cfg, 'acme'), 'C-WORK');
  assert.equal(slackChannelFor(cfg, 'elsewhere'), 'C-DEFAULT', 'a repo outside the space still gets the global');
});

await check('a space can say NO — the failure this whole resolver exists to prevent', () => {
  const cfg = base();
  // Quiet on the phone and noisy in a work channel is a bug, so a space that has
  // opted out has to be able to say so against a global that is set.
  cfg.spaces = [{ name: 'Personal', workspaces: ['sideproject'], slackChannel: null, muted: true }];
  assert.equal(slackChannelFor(cfg, 'sideproject'), null);
  cfg.spaces = [{ name: 'Personal', workspaces: ['sideproject'], slackChannel: '' }];
  assert.equal(slackChannelFor(cfg, 'sideproject'), null, 'an empty string is the same no');
});

await check('the per-repo veto outranks the space, like ntfy.minimalWorkspaces does', () => {
  const cfg = base({ excludeWorkspaces: ['acme'] });
  cfg.spaces = [{ name: 'Work', workspaces: ['acme'], slackChannel: 'C-WORK' }];
  assert.equal(slackChannelFor(cfg, 'acme'), null);
});

await check('off means no channel at all, whatever the spaces say', () => {
  const cfg = base({ enabled: false });
  cfg.spaces = [{ name: 'Work', workspaces: ['acme'], slackChannel: 'C-WORK' }];
  assert.equal(slackChannelFor(cfg, 'acme'), null);
});

await check('detail defaults to full even where ntfy is minimal — a channel is not a public relay', () => {
  const cfg = base();
  cfg.ntfy.minimalWorkspaces = ['acme'];
  cfg.spaces = [{ name: 'Work', workspaces: ['acme'], ntfyDetail: 'minimal' }];
  assert.equal(slackDetailFor(cfg, 'acme'), 'full');
  cfg.spaces[0].slackDetail = 'minimal';
  assert.equal(slackDetailFor(cfg, 'acme'), 'minimal', 'and it is sayable when you mean it');
});

/* ====================================================== unconfigured is silent */

console.log('\nslack — unconfigured, nothing runs\n');

await check('disabled: the reason names the gate that stopped it, which is the one before the token', async () => {
  reset();
  // Everything else present and correct — a real token file, a channel — so a post
  // could only be stopped by the switch. `disabled` is returned by the branch above
  // the one that opens the file, so this word is the evidence no token was read.
  const r = await slack.postQuestion(base({ enabled: false }), question());
  assert.equal(r.skipped, 'disabled');
  assert.equal(seen.length, 0, 'and nothing was sent');
  assert.deepEqual(loadState().slack, {}, 'and nothing was written down');
});

await check('enabled with no bot token says which of the two silences it is', async () => {
  reset();
  const r = await slack.postQuestion(base({ botTokenFile: path.join(DIR, 'not-here.key') }), question());
  assert.equal(r.skipped, 'no-bot-token');
  assert.equal(seen.length, 0);
});

await check('a workspace with no channel is skipped by name, not by silence', async () => {
  reset();
  const r = await slack.postQuestion(base({ excludeWorkspaces: ['acme'] }), question());
  assert.equal(r.skipped, 'no-channel');
  assert.equal(seen.length, 0);
});

await check('the startup line says which half is missing', () => {
  assert.match(slack.slackStatusLine(base({ enabled: false })), /disabled/);
  assert.match(slack.slackStatusLine(base({ botTokenFile: path.join(DIR, 'nope.key') })), /no bot token/);
  // The half-configured case that reads as a broken app: questions post, buttons die.
  assert.match(slack.slackStatusLine(base()), /no app token/);
  assert.match(slack.slackStatusLine(base({ appTokenFile: BOT })), /Socket Mode/);
});

/* ================================================================ the posting */

console.log('\nslack — a question in a channel\n');

await check('a question posts to the configured channel with a button per option', async () => {
  reset();
  const r = await slack.postQuestion(base(), question());
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  const [call] = seen;
  assert.equal(call.path, '/chat.postMessage');
  assert.equal(call.auth, 'Bearer xoxb-not-a-real-token', 'the token goes in the header, from the 0600 file');
  assert.equal(call.payload.channel, 'C-DEFAULT');
  assert.match(call.payload.text, /ac-1/, 'the fallback text is what a notification shows');

  const opts = buttons(call.payload.blocks);
  assert.equal(opts.length, 2);
  assert.deepEqual(opts.map((b) => b.text.text), ['Gross', 'Net']);
  // The value is an index and a key, never the answer — see `optionsFor`.
  assert.deepEqual(JSON.parse(opts[0].value), { k: 'acme/ac-1', n: 0 });
  assert.ok(!JSON.stringify(call.payload.blocks).includes('full charge amount'), 'the answer text is not in the payload');
  // And the link out, which is the only thing a minimal message keeps.
  const link = call.payload.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'bc-open');
  assert.match(link.url, /#acme%2Fac-1$/);
});

await check('what was posted is written down, because the backend is replaced on every deploy', () => {
  const entry = loadState().slack['acme/ac-1'];
  assert.ok(entry, 'nothing remembered');
  assert.equal(entry.channel, 'C-DEFAULT');
  assert.match(entry.ts, /^1700000000\./);
  assert.equal(entry.options.length, 2);
  assert.equal(entry.options[0].response, 'Gross — fee on the full charge amount.');
  assert.equal(entry.title, 'Charge the platform fee on gross or net?');
});

await check('and it is not posted twice — two messages, one settle, one stale forever', async () => {
  const before = seen.length;
  const r = await slack.postQuestion(base(), question());
  assert.equal(r.skipped, 'already-posted');
  assert.equal(seen.length, before);
});

await check('minimal is a nudge with a link and no options', async () => {
  reset();
  const cfg = base();
  cfg.spaces = [{ name: 'Work', workspaces: ['acme'], slackDetail: 'minimal' }];
  await slack.postQuestion(cfg, question());
  const blocks = seen[0].payload.blocks;
  assert.equal(buttons(blocks).length, 0);
  assert.ok(!JSON.stringify(blocks).includes('gross or net'), 'the question text does not leak into a minimal post');
});

await check('more options than the cap fit in a row, and the message says how many are left', async () => {
  reset();
  const many = question({
    decision: {
      options: Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}`, response: `r${i}`, closes: true })),
    },
  });
  await slack.postQuestion(base({ maxButtons: 3 }), many);
  const blocks = seen[0].payload.blocks;
  assert.equal(buttons(blocks).length, 3);
  assert.match(JSON.stringify(blocks), /5 more options in the app/);
});

await check('a Slack error is an error, even though it arrives as HTTP 200', async () => {
  reset();
  postReply = { ok: false, error: 'channel_not_found' };
  await assert.rejects(() => slack.postQuestion(base(), question()), /channel_not_found/);
  postReply = null;
  assert.deepEqual(loadState().slack, {}, 'and nothing is remembered for a message that does not exist');
});

/* ================================================================ the settling */

console.log('\nslack — a message that does not outlive its bead\n');

await check('settling rewrites the same message, with the answer, by whom, and no buttons', async () => {
  reset();
  await slack.postQuestion(base(), question());
  const posted = loadState().slack['acme/ac-1'];
  seen.length = 0;

  const r = await slack.settleQuestion(base(), 'acme/ac-1', { response: 'Gross — fee on the full charge amount.', by: 'U123' });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  const call = seen[0];
  assert.equal(call.path, '/chat.update');
  assert.equal(call.payload.channel, posted.channel);
  assert.equal(call.payload.ts, posted.ts, 'the same message, not a new one');
  const text = JSON.stringify(call.payload.blocks);
  assert.match(text, /full charge amount/, 'the answer is on the message');
  assert.match(text, /<@U123>/, 'and who gave it');
  assert.equal(buttons(call.payload.blocks).length, 0, 'a settled message with a live button is the whole failure mode');
});

await check('and it is forgotten, so nothing settles it twice', async () => {
  assert.equal(loadState().slack['acme/ac-1'], undefined);
  assert.equal((await slack.settleQuestion(base(), 'acme/ac-1')).skipped, 'not-posted');
});

await check('an answer given somewhere else settles it without inventing an author', async () => {
  reset();
  await slack.postQuestion(base(), question());
  seen.length = 0;
  // What the poller's sweep calls: the bead left the inbox and this daemon has no idea
  // who closed it or what they said.
  await slack.settleQuestion(base(), 'acme/ac-1');
  const text = JSON.stringify(seen[0].payload.blocks);
  assert.match(text, /Answered/);
  assert.ok(!text.includes('<@'), 'nobody here pressed anything, so nobody is named');
});

await check('a dismissal is not an answer, and the message says the right one', async () => {
  reset();
  await slack.postQuestion(base(), question());
  seen.length = 0;
  await slack.settleQuestion(base(), 'acme/ac-1', { verb: 'Set aside' });
  assert.match(JSON.stringify(seen[0].payload.blocks), /Set aside/);
});

await check('a failed update still forgets it — the half that matters is ours', async () => {
  reset();
  await slack.postQuestion(base(), question());
  const cfg = base({ apiBase: 'http://127.0.0.1:1/nothing-listening' });
  await assert.rejects(() => slack.settleQuestion(cfg, 'acme/ac-1'));
  assert.equal(loadState().slack['acme/ac-1'], undefined, 'a press on the stale message must find nothing to answer with');
});

/* ============================================================== the interaction */

console.log('\nslack — a pressed button answers the bead\n');

const pressed = (over = {}) => ({
  type: 'block_actions',
  user: { id: 'U123', username: 'adam' },
  channel: { id: 'C-DEFAULT' },
  actions: [{ action_id: 'bc-opt-1', type: 'button', value: JSON.stringify({ k: 'acme/ac-1', n: 1 }) }],
  response_url: `http://127.0.0.1:${apiPort}/responses`,
  ...over,
});

await check('a press is read into a bead key and an option index', () => {
  const a = slack.parseAction(pressed());
  assert.equal(a.key, 'acme/ac-1');
  assert.equal(a.index, 1);
  assert.equal(a.user, 'U123');
});

await check('the link button is not an answer, and neither is junk', () => {
  assert.equal(slack.parseAction(pressed({ actions: [{ action_id: 'bc-open', type: 'button' }] })), null);
  assert.equal(slack.parseAction(pressed({ actions: [{ action_id: 'bc-opt-0', value: 'not json' }] })), null);
  assert.equal(slack.parseAction(pressed({ actions: [{ action_id: 'bc-opt-0', value: '{"k":"x"}' }] })), null, 'no index');
  assert.equal(slack.parseAction({ type: 'view_submission' }), null);
});

await check('pressing it POSTs the option`s own response to /api/respond, with the token', async () => {
  reset();
  await slack.postQuestion(base(), question());
  seen.length = 0;
  respondWith = { status: 200, payload: { ok: true, closed: true } };

  const r = await slack.answerFromSlack(base(), slack.parseAction(pressed()));
  assert.equal(r.ok, true);
  const call = seen.find((s) => s.at === 'beadcause');
  assert.equal(call.path, '/api/respond');
  assert.equal(call.token, 'test-token-not-a-secret');
  assert.deepEqual(call.payload, {
    workspace: 'acme',
    id: 'ac-1',
    // The second option's response, read out of our own state rather than off the
    // payload that came back from Slack.
    response: 'Net — fee after the seller share.',
    option: 'net',
    slackUser: 'U123',
  });
});

await check('a press on a message whose bead is gone answers nothing and says so', async () => {
  reset();
  const r = await slack.answerFromSlack(base(), slack.parseAction(pressed()));
  assert.equal(r.skipped, 'not-posted');
  assert.ok(!seen.some((s) => s.at === 'beadcause'), 'nothing was written');
  assert.ok(seen.some((s) => s.path === '/responses'), 'and the person who pressed was told');
});

await check('a refusal to close leaves the question open, with its buttons', async () => {
  reset();
  await slack.postQuestion(base(), question());
  seen.length = 0;
  respondWith = { status: 409, payload: { error: 'blocked', gate: { reason: 'ac-2 is still open' }, canComment: true } };

  const r = await slack.answerFromSlack(base(), slack.parseAction(pressed()));
  assert.equal(r.refused, true);
  assert.ok(loadState().slack['acme/ac-1'], 'the message is still the live question it was');
  assert.ok(!seen.some((s) => s.path === '/chat.update'), 'and it was not rewritten');
  const told = seen.find((s) => s.path === '/responses');
  assert.match(told.payload.text, /ac-2 is still open/);
  assert.equal(told.payload.response_type, 'ephemeral', 'a refusal is for the person who pressed, not the room');
  respondWith = { status: 200, payload: { ok: true, closed: true } };
});

/* ============================================================== the credentials */

console.log('\nslack — where the tokens live\n');

await check('neither token is a field in the config, and the default files are refused by the config repo', () => {
  assert.ok(!/\b(bot|app)Token\s*:/.test(SHIPPED_SLACK), 'a token field here would be a token in a git history');
  assert.match(SHIPPED_SLACK, /botTokenFile:\s*null/, 'the path is the thing that belongs in the config');
  assert.match(SHIPPED_SLACK, /enabled:\s*false/, 'and it is off until somebody says otherwise');
  assert.match(slack.botTokenFile({}), /slack-bot\.key$/);
  assert.match(slack.appTokenFile({}), /slack-app\.key$/);
  // The whole reason for the `.key` names: the repo `~/.config/beadcause` is both
  // ignores them and refuses to commit them, so the default place is safe by
  // construction rather than by anyone choosing well.
  assert.equal(protectedPath('slack-bot.key'), true);
  assert.equal(protectedPath('slack-app.key'), true);
});

await check('the file is read as the token, trimmed, and the env var wins', () => {
  assert.equal(slack.botToken(base()), 'xoxb-not-a-real-token');
  process.env.BEADCAUSE_SLACK_BOT_TOKEN = 'xoxb-from-the-env';
  assert.equal(slack.botToken(base()), 'xoxb-from-the-env', 'the env var leaves no copy on disk, so it wins');
  delete process.env.BEADCAUSE_SLACK_BOT_TOKEN;
  assert.equal(fs.statSync(BOT).mode & 0o777, 0o600, 'and the file this suite wrote is 0600, like the real one');
});

/* -------------------------------------------------------------------- the end */

slackApi.close();
beadcause.close();

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures} of ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
