#!/usr/bin/env node
//
// Accounts — the level above a space, and the one thing on the screen that decides
// which of your lives the whole app is about.
//
//     npm test
//     node test/accounts.mjs
//
// Five failures are worth a suite, and not one of them is visible by reading a function:
//
// 1. **An install with no accounts has to be byte-for-byte what it was.** Every predicate
//    in lib/accounts.js answers "in scope" for a null account, and the whole feature is
//    off until somebody adds the second one. A default that happened to be permissive
//    would rot; a branch that cannot be entered does not. Checked here in both
//    directions — the model, and a live daemon's payload.
//
// 2. **Adding the first account must not orphan the rest.** Somebody adding "Work —
//    architecture" has said nothing about the eight repos that are not it, and appending
//    only what they typed would leave those in no account and visible from nowhere. This
//    is what `withAccount` exists for, and the failure it prevents is silent.
//
// 3. **The payload and the push have to agree.** `quietReasonFor` answers `'account'` for
//    a bead in the other life, and the payload does not carry it — if those two ever
//    parted, the phone would ring for a bead the app cannot show, which is the single
//    failure this program exists to prevent. The foundation channel is exempt from both,
//    and that pairing is asserted rather than described.
//
// 4. **Identity follows the account.** The address in the top bar is the handle a filing
//    is stamped with, and the mechanism is one reorder of `cfg.me` — so a test that only
//    checked `accountHandles` would pass while every stamp went on naming whichever
//    address the config was typed with first. `ownAddresseeLabels` is asked directly.
//
// 5. **Nothing an account hides is lost — the narrowing is in the payload, never in the
//    sweep.** So it has to be reversible in the same second: the daemon here is switched
//    from one account to the other and back out of accounts altogether, and the picker's
//    payload is asked for after each, because a scope you cannot undo is a scope that
//    loses things.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-accounts-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  accountHandles,
  accountList,
  accountRoster,
  accountSpaces,
  accountWorkspaces,
  activeAccount,
  inAccount,
  repoInAccount,
  withAccount,
  withoutAccount,
} = await import(LIB('accounts.js'));
const { quietReasonFor } = await import(LIB('spaces.js'));
const { ownAddresseeLabels } = await import(LIB('addressee.js'));
const { loadState, saveState, STATE_PATH } = await import(LIB('config.js'));

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
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
const checkAsync = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('accounts');

/* ------------------------------------------------------------------ the model */

const NAMES = ['beadcause', 'sophab', 'personal', 'architecture'];
const TWO = {
  me: ['you@gmail.com', 'you@work.example'],
  accounts: [
    { email: 'you@gmail.com', label: 'Personal', workspaces: ['beadcause', 'sophab', 'personal'] },
    {
      email: 'you@work.example',
      label: 'Work',
      workspaces: ['architecture'],
      repos: { architecture: ['architecture', 'athena-service'] },
    },
  ],
};

check(() => {
  assert.equal(activeAccount({}, {}), null);
  assert.equal(activeAccount({ accounts: [] }, { account: 'you@gmail.com' }), null);
}, 'no accounts configured resolves to null — the branch every predicate reads as "everything"');

check(() => {
  assert.equal(inAccount(null, 'anything'), true);
  assert.deepEqual(accountWorkspaces(null, NAMES), NAMES);
  assert.equal(repoInAccount(null, 'architecture', 'athena-service'), true);
}, 'and with null every predicate says yes, so an install without accounts is unchanged');

check(() => {
  const one = { accounts: [{ email: 'solo@example.com' }] };
  assert.deepEqual(accountWorkspaces(activeAccount(one, {}), NAMES), NAMES);
}, 'one account with no workspace list still owns everything — the first account changes nothing but the chip');

check(() => {
  assert.equal(activeAccount(TWO, { account: 'you@work.example' }).label, 'Work');
  // Case and whitespace: a config file is typed by hand and a stored value came off a
  // phone. Neither is a reason to be in the wrong account.
  assert.equal(activeAccount(TWO, { account: ' YOU@Work.Example ' }).label, 'Work');
}, 'the stored address selects the account, however it was typed');

check(() => {
  // The account named by state was deleted from the config while a phone still had it
  // selected. Falling back to "everything" would answer "which of my lives" by showing
  // all of them, which is the state this whole feature exists to end.
  const gone = activeAccount(TWO, { account: 'deleted@example.com' });
  assert.equal(gone.email, 'you@gmail.com');
  assert.deepEqual(accountWorkspaces(gone, NAMES), ['beadcause', 'sophab', 'personal']);
}, 'a stored address naming nothing falls back to the first account, never to everything');

check(() => {
  const work = activeAccount(TWO, { account: 'you@work.example' });
  assert.deepEqual(accountWorkspaces(work, NAMES), ['architecture']);
  assert.equal(inAccount(work, 'beadcause'), false);
  // A workspace the account names that is not on this Mac is not offered — the rule
  // stays in the config, the picker only draws what exists.
  assert.deepEqual(accountWorkspaces(work, ['beadcause']), []);
}, 'an account sees its own workspaces and nothing else');

check(() => {
  const work = activeAccount(TWO, { account: 'you@work.example' });
  assert.equal(repoInAccount(work, 'architecture', 'athena-service'), true);
  assert.equal(repoInAccount(work, 'architecture', 'secrets-repo'), false);
  // The second grain never overrides the first: a workspace it cannot see is out
  // whatever the repo map says.
  assert.equal(repoInAccount(work, 'sophab', 'sophab'), false);
  // And a bead that never said which checkout it was about belongs to whoever holds the
  // workspace — invisible in every account is the losing-a-question failure.
  assert.equal(repoInAccount(work, 'architecture', ''), true);
}, 'the second grain narrows inside a workspace and cannot widen past one');

check(() => {
  const personal = activeAccount(TWO, { account: 'you@gmail.com' });
  // A chat session started outside every repo. The space picker hides one of these while
  // anything is selected and can afford to — All is a tap away. An account has no All.
  assert.equal(inAccount(personal, ''), true);
  assert.equal(inAccount(personal, undefined), true);
}, 'a row belonging to no workspace at all is in scope in every account');

check(() => {
  const rows = [
    { name: 'Personal', workspaces: ['beadcause', 'sophab'] },
    { name: 'Climative', workspaces: ['architecture'] },
    { name: 'Other', workspaces: ['personal'] },
  ];
  const work = accountSpaces(activeAccount(TWO, { account: 'you@work.example' }), rows);
  assert.deepEqual(work.map((s) => s.name), ['Climative']);
  const personal = accountSpaces(activeAccount(TWO, {}), rows);
  assert.deepEqual(personal.map((s) => s.name), ['Personal', 'Other']);
  assert.deepEqual(personal[0].workspaces, ['beadcause', 'sophab']);
}, 'a space with nothing left in it is dropped from the picker rather than drawn empty');

check(() => {
  const roster = accountRoster(TWO, { account: 'you@work.example' }, NAMES);
  assert.deepEqual(roster.map((a) => a.active), [false, true]);
  assert.deepEqual(roster[1].workspaces, ['architecture']);
}, 'the roster flags the active row rather than naming it in a second field');

check(() => {
  const junk = { accounts: [{ label: 'nameless' }, { email: 'a@b.c' }, { email: 'A@B.C' }] };
  assert.deepEqual(accountList(junk).map((a) => a.email), ['a@b.c']);
  // The local part, so an account with no label still has a name a chip can draw.
  assert.equal(accountList(junk)[0].label, 'a');
}, 'an account with no address is not one, and a duplicate address is not a second');

/* --------------------------------------------------- adding the first account */

check(() => {
  const cfg = { me: ['you@gmail.com'], accounts: [] };
  const out = withAccount(cfg, { email: 'you@work.example', label: 'Work', workspaces: ['architecture'] }, {
    implicit: 'you@gmail.com',
    known: NAMES,
  });
  assert.equal(out.length, 2, 'two accounts, not one');
  assert.deepEqual(out[0].email, 'you@gmail.com');
  // Everything the new account did not take — written out as a list rather than as "*",
  // because "*" would keep sweeping up every workspace added afterwards.
  assert.deepEqual(out[0].workspaces, ['beadcause', 'sophab', 'personal']);
  assert.deepEqual(out[1].workspaces, ['architecture']);
}, 'adding the first account materialises the one it implies, owning the rest');

check(() => {
  const cfg = { me: ['you@gmail.com'], accounts: [] };
  const out = withAccount(cfg, { email: 'you@work.example' }, { implicit: 'you@gmail.com', known: NAMES });
  // It owns everything, so there is nothing left over and nothing to materialise.
  assert.deepEqual(out.map((a) => a.email), ['you@work.example']);
}, 'unless the first account owns everything, in which case it orphans nothing');

check(() => {
  const out = withAccount(TWO, { email: 'you@work.example', label: 'Climative', workspaces: ['architecture'] }, {});
  assert.equal(out.length, 2, 'rewritten, not appended');
  assert.equal(out[1].label, 'Climative');
}, 'saving an address that already exists rewrites that row');

check(() => {
  assert.deepEqual(withoutAccount(TWO, 'you@work.example').map((a) => a.email), ['you@gmail.com']);
  assert.deepEqual(withoutAccount({ accounts: [{ email: 'a@b.c' }] }, 'a@b.c'), []);
}, 'removing the last account turns the scoping off again');

/* ------------------------------------------------------- identity follows it */

check(() => {
  assert.deepEqual(accountHandles(TWO, { account: 'you@work.example' }), ['you@work.example', 'you@gmail.com']);
  assert.deepEqual(accountHandles(TWO, {}), ['you@gmail.com', 'you@work.example']);
  // Both addresses survive the reorder: a question addressed to the other one is still
  // yours, and `addressedElsewhere` tests membership rather than position.
  assert.equal(accountHandles(TWO, { account: 'you@work.example' }).length, 2);
}, 'the active account moves to the front of `me` and takes nothing off it');

check(() => {
  const stamped = ownAddresseeLabels({ me: accountHandles(TWO, { account: 'you@work.example' }) });
  assert.deepEqual(stamped, ['for:you@work.example']);
  const personal = ownAddresseeLabels({ me: accountHandles(TWO, {}) });
  assert.deepEqual(personal, ['for:you@gmail.com']);
}, 'so a filing is stamped with the account you are in — the reorder is the whole mechanism');

check(() => {
  const outsider = { me: ['you@gmail.com'], accounts: [{ email: 'new@work.example', workspaces: ['architecture'] }] };
  assert.deepEqual(accountHandles(outsider, { account: 'new@work.example' }), ['new@work.example', 'you@gmail.com']);
}, 'an account address missing from `me` is prepended rather than ignored');

/* ------------------------------------------------------------ the push path */

const beadIn = (workspace) => ({ workspace, space: null, key: `${workspace}/x-1`, id: 'x-1' });
const ALL = { space: 'all', workspace: 'all' };
const work = activeAccount(TWO, { account: 'you@work.example' });

check(() => {
  assert.equal(quietReasonFor(TWO, ALL, beadIn('architecture'), new Date(), work), null);
  assert.equal(quietReasonFor(TWO, ALL, beadIn('sophab'), new Date(), work), 'account');
}, 'a bead in the other account goes quiet, and says which kind of quiet it is');

check(() => {
  // Above the filter, because widening the filter cannot reach it: the picker does not
  // offer the other account's repos at all. Reporting it as `filtered` would send
  // somebody to press All for a bead that pressing All cannot bring back.
  const narrowed = { space: 'Personal', workspace: 'sophab' };
  assert.equal(quietReasonFor(TWO, narrowed, beadIn('sophab'), new Date(), work), 'account');
}, 'and it outranks the filter, which is the lever it would otherwise send you to');

check(() => {
  const request = { ...beadIn('sophab'), foundation: true };
  assert.equal(quietReasonFor(TWO, ALL, request, new Date(), work), null);
}, 'a foundation request is exempt — it is drawn outside every scope, so silencing it would ring for nothing');

check(() => {
  assert.equal(quietReasonFor(TWO, ALL, beadIn('sophab'), new Date(), null), null);
}, 'and with no account configured nothing is quietened that was not quiet before');

/* ---------------------------------------------------------- the round trip */

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'accounts-test-token',
  actor: 'beadcause-test',
  me: ['you@gmail.com'],
  workspaces: [
    { name: 'beadcause', dir: path.join(tmp, 'beadcause', '.beads') },
    { name: 'architecture', dir: path.join(tmp, 'architecture', '.beads') },
  ],
  spaces: [
    { name: 'Personal', workspaces: ['beadcause'] },
    { name: 'Climative', workspaces: ['architecture'] },
  ],
  accounts: [],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const call = (pathname, opts = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : {} }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });

await checkAsync(async () => {
  const res = await call('/api/accounts');
  assert.equal(res.status, 200);
  assert.equal(res.body.account, null);
  assert.deepEqual(res.body.accounts, []);
  // Every workspace on the Mac, not the scoped list — this is what the form is built
  // from, and a form offering only what you can already see could never reach the rest.
  assert.deepEqual(res.body.workspaces, ['beadcause', 'architecture']);
  assert.equal(res.body.me, 'you@gmail.com');
}, 'GET /api/accounts on an install with none says so, and offers every workspace to the form');

await checkAsync(async () => {
  const res = await call('/api/spaces');
  assert.deepEqual(res.body.workspaces, ['beadcause', 'architecture']);
  assert.deepEqual(res.body.spaces.map((s) => s.name), ['Personal', 'Climative']);
}, 'and the picker still offers both spaces — nothing is scoped until an account exists');

await checkAsync(async () => {
  const res = await call('/api/accounts', {
    method: 'POST',
    body: { email: 'you@work.example', label: 'Work', workspaces: ['architecture'] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.accounts.map((a) => a.email), ['you@gmail.com', 'you@work.example']);
  // Selected on the way in: adding your first account and then having to switch to it is
  // two taps for one intention.
  // Selected on the way in, the way an account you have just added is the one you meant
  // to look at — and the one it implied is a tap away in the picker you added it from.
  assert.equal(res.body.account, 'you@work.example');
  assert.equal(loadState().account, 'you@work.example');
}, 'POST /api/accounts adds the account, the one it implies, and selects the new one');

await checkAsync(async () => {
  const res = await call('/api/spaces');
  assert.deepEqual(res.body.workspaces, ['architecture']);
  assert.deepEqual(res.body.spaces.map((s) => s.name), ['Climative']);
}, 'and the picker is that account’s at once — the personal space is not on it at all');

await checkAsync(async () => {
  const res = await call('/api/accounts', { method: 'POST', body: { email: 'not an address' } });
  assert.equal(res.status, 400);
}, 'an address that is not one is refused rather than stored');

await checkAsync(async () => {
  const res = await call('/api/account', { method: 'POST', body: { email: 'nobody@example.com' } });
  assert.equal(res.status, 400);
  assert.equal(loadState().account, 'you@work.example', 'and nothing was written');
}, 'switching to an account that does not exist is refused, not stored');

await checkAsync(async () => {
  const res = await call('/api/account', { method: 'POST', body: { email: 'you@work.example' } });
  assert.equal(res.status, 200);
  assert.equal(loadState().account, 'you@work.example');
  // Identity followed it, in the running process rather than only at the next load.
  assert.equal(cfg.me[0], 'you@work.example');
  assert.deepEqual(ownAddresseeLabels(cfg), ['for:you@work.example']);
}, 'POST /api/account switches, and the daemon starts filing as that address');

await checkAsync(async () => {
  const res = await call('/api/spaces');
  assert.deepEqual(res.body.workspaces, ['architecture']);
  assert.deepEqual(res.body.spaces.map((s) => s.name), ['Climative']);
}, 'and every picker on every page is the work account’s now');

await checkAsync(async () => {
  // Through the query rather than a body: Node's HTTP server refuses a chunked DELETE
  // body with an empty 400 before the handler sees it, which is exactly why the route
  // takes the address from either place. The picker in the browser sends the body.
  const res = await call('/api/accounts?email=you%40work.example', { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.accounts.map((a) => a.email), ['you@gmail.com']);
  // The stored selection still names the deleted address; `activeAccount` resolves it to
  // the survivor rather than a second writer racing the poll to rewrite it.
  assert.equal(res.body.account, 'you@gmail.com');
}, 'DELETE /api/accounts forgets one and lands you in the account that is left');

servers.forEach((s) => s.close());
app.stop?.();

fs.rmSync(STATE_PATH, { force: true });
cleanupTmp(tmp);

console.log(`\n${failures ? `${failures}/${ran} failed` : `${ran} checks passed`}`);
process.exit(failures ? 1 : 0);
