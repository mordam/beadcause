#!/usr/bin/env node
/**
 * **The four arrivals that tell you something** — as events the phone can file, not as
 * ntfy pushes.
 *
 *     npm test
 *     node test/news.mjs
 *
 * A question, a foundation request and an agent reply have reached the Android app as
 * native notifications since it existed. Everything else the daemon had to say went to
 * ntfy — a merge landing, a deploy ending, a tracker that stopped syncing — which meant
 * it arrived in *ntfy's* app, on ntfy's channel, with a sound beadcause cannot set. That
 * is what bc-ka5y.15.1 moved, and there are four ways for the move to be quietly wrong:
 *
 * 1. **Both.** The native card lands and the ntfy push is left running beside it, so
 *    the phone says everything twice. Checked by asserting the pushers are *gone* from
 *    lib/notify.js, not merely unused.
 * 2. **Neither.** The push is deleted and the emit is not wired, so work lands, deploys
 *    and breaks in total silence — the one failure nobody notices, because a
 *    notification that never arrives looks exactly like a quiet morning.
 * 3. **An event the phone cannot file without asking.** One `news` type with a `kind`
 *    field would make every consumer go back to the server to learn which card, which
 *    channel, whether it expires. Four types is the acceptance criterion and it is
 *    asserted as four.
 * 4. **A blockage silenced by something meant for news.** A muted space must not be able
 *    to swallow a deploy that failed, and the tray sweep that clears answered questions
 *    must not clear a card that is not a question.
 *
 * The end-to-end half is real: `createApp`, a real listener, `POST /api/landed` — the
 * door `bin/deliver.js` uses because it is a separate process with no bus — and then
 * `GET /api/poll`, which is the exact request the watch service is parked on. `bd` is
 * never reached, because the poll asks with `want=presence`: that path returns the
 * events and skips the question sweep, so this suite needs no fake tracker at all.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-news-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const { landedEvent, deployEvent, deployClearEvent, syncStuckEvent, syncClearEvent, epicDoneEvent, mutedNews } = await import(LIB('news.js'));

/* ------------------------------------------------------- 1. four types, not one */

console.log('\nfour types, each filed without asking the server anything\n');

const LANDING = {
  workspace: 'demo',
  bead: 'zz-work',
  repo: 'acme/widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  title: 'Take the counts off the picker',
  base: 'main',
  sha: 'abcdef1234567890',
  owed: 'a deploy',
};

const landed = landedEvent(LANDING);
const released = deployEvent({ workspace: 'demo', repo: 'widgets', id: 'd-1', status: 'ok', base: 'main', to: 'abcdef1234567890', bead: 'zz-work' });
const stuck = deployEvent({ workspace: 'demo', repo: 'widgets', id: 'd-2', status: 'failed', error: 'the deploy command failed (exit 1)' });
const trouble = syncStuckEvent([{ workspace: 'demo', error: 'ssh: permission denied', dir: '/tmp/ws', conflict: true }]);
const epic = epicDoneEvent({ workspace: 'demo', id: 'zz-epic', title: 'Five notification voices', closed: 6 });

const ALL = { landed, released, stuck, trouble, epic };
const types = new Set([landed.type, released.type, stuck.type, epic.type]);

check('a landing, a release, a blockage and an epic are four distinct types', types.size === 4, [...types].join(','));
check('and they are the four the app knows', [...types].sort().join(',') === 'epic-done,landed,released,stuck', [...types].sort().join(','));
for (const [name, e] of Object.entries(ALL)) {
  check(`${name} carries a title`, typeof e.title === 'string' && e.title.trim().length > 0, JSON.stringify(e.title));
  check(`${name} carries a key`, typeof e.key === 'string' && e.key.length > 0, JSON.stringify(e.key));
}

// The card has to be readable in the shade without opening anything, which for a
// landing means the number, the bead and the title.
check('a landing names the pull request number', landed.title.includes('#42'), landed.title);
check('and the title of the work', landed.title.includes('Take the counts off the picker'), landed.title);
check('and the bead, so it is findable six months later', landed.id === 'zz-work', String(landed.id));
check('and what moved, and what is still owed', landed.text.includes('abcdef12') && landed.text.includes('a deploy'), JSON.stringify(landed.text));

// A landing key that was the bead's own `<workspace>/<id>` would collide with the card
// the delivery filed — the tray sweeps by key across its decks, so the landing would
// replace the question rather than sit beside it.
check('its key is not the bead key a question card uses', landed.key !== 'demo/zz-work' && landed.key.startsWith('news/'), landed.key);

check('a release says where it ran and what went live', released.title.includes('deployed') && released.text.includes('abcdef12'), `${released.title} / ${released.text}`);
check('a failed deploy is a blockage rather than a release', stuck.type === 'stuck' && stuck.source === 'deploy', JSON.stringify(stuck));
check('and it carries the daemon’s own verdict', stuck.text.includes('exit 1'), JSON.stringify(stuck.text));

// `unconfirmed` was a blockage here until bc-ka5y.15.5 and is news now. `sweepDeploys`
// writes that word only for a deploy with `restarts` set, so it is the ordinary ending of
// every deploy beadcause makes of itself — and the insistent voice going off several times
// a day about a deploy that almost certainly worked is what teaches somebody to ignore it.
// The card still says "unconfirmed" rather than "deployed"; only the sound moved. The whole
// argument is in lib/voices.js and it is pinned by test/voices.mjs.
const unconfirmed = deployEvent({ workspace: 'demo', id: 'd-3', status: 'unconfirmed' });
check('an unconfirmed deploy does not use the insistent voice', unconfirmed.type === 'released', JSON.stringify(unconfirmed.type));
check('but the card still refuses to call it deployed', unconfirmed.title.includes('unconfirmed'), unconfirmed.title);
check('and it is filed as news, so the card expires on its own', unconfirmed.key.startsWith('news/'), unconfirmed.key);
check('a lost deploy is still a blockage', deployEvent({ workspace: 'demo', id: 'd-4', status: 'lost' }).type === 'stuck');

check('an epic says which epic', epic.title.includes('Five notification voices'), epic.title);
check('and how many beads closed under it', epic.text.includes('6 beads'), epic.text);

/* ------------------------------------------------ 2. a state, and taking it back */

console.log('\nthe one arrival that stops being true\n');

const clear = syncClearEvent([{ workspace: 'demo' }]);
check('a tracker in trouble is a stuck event', trouble.type === 'stuck' && trouble.state === 'stuck', JSON.stringify(trouble.state));
check('and the recovery is the same type saying it ended', clear.type === 'stuck' && clear.state === 'clear', JSON.stringify(clear.state));
check('under the same key, which is what takes the card away', clear.key === trouble.key, `${trouble.key} vs ${clear.key}`);
check('a conflict says it will not clear on its own', trouble.text.includes('will not clear on its own'), trouble.text);
check('and the fix is a command, in a directory that exists', trouble.text.includes('cd /tmp/ws'), trouble.text);

// The same for a deploy, and the case that is easy to miss: the warning a failure left
// in the shade has to be taken away by the deploy that fixed it, or it sits there
// through the one moment it is provably wrong.
const REPO = { workspace: 'demo', repo: 'widgets' };
const broke = deployEvent({ ...REPO, id: 'd-9', status: 'failed', error: 'boom' });
const fixed = deployClearEvent({ ...REPO, id: 'd-10' });
check('a deploy that failed and the one that fixed it name the same card', broke.key === fixed.key, `${broke.key} vs ${fixed.key}`);
check('and the second one clears it', fixed.state === 'clear');
// Keyed on the repo, not the attempt: an id is unique per deploy, so a card keyed by one
// could never be cancelled by the run that succeeded.
check('the key is the repo rather than the attempt', !broke.key.includes('d-9'), broke.key);
check(
  'and a second failure of the same repo replaces the row rather than stacking',
  deployEvent({ ...REPO, id: 'd-11', status: 'lost' }).key === broke.key
);

/* ----------------------------------------------------- 3. what a mute may silence */

console.log('\nwhat a muted space may and may not silence\n');

const muted = { spaces: [{ name: 'quiet', workspaces: ['demo'], muted: true }] };
check('a muted space is recognised', mutedNews(muted, 'demo') === true);
check('an unmuted one is not', mutedNews({ spaces: [] }, 'demo') === false);
check('and a config with nothing in it is not a reason to go quiet', mutedNews({}, 'demo') === false);
check('a landing obeys the mute', landedEvent(LANDING, { quiet: true }).quiet === true);
check('a release obeys it too', deployEvent({ workspace: 'demo', id: 'd-5', status: 'ok' }, { quiet: true }).quiet === true);
// The whole argument for giving "work is stuck" the one insistent voice is that it
// cannot be arranged not to speak.
check(
  'a failed deploy does not, however the space is set',
  deployEvent({ workspace: 'demo', id: 'd-6', status: 'failed' }, { quiet: true }).quiet === false
);
check('and neither does a tracker that stopped syncing', trouble.quiet === false);

/* ------------------------------------ 4. gone from ntfy, not running beside it */

console.log('\nremoved from the relay rather than duplicated on it\n');

const NOTIFY = read('lib/notify.js');
for (const gone of ['pushLanded', 'pushDeploy', 'pushSyncTrouble', 'pushSyncedAgain']) {
  check(`${gone} no longer exists`, !new RegExp(`export async function ${gone}\\b`).test(NOTIFY), 'the phone would get this twice');
}
// And the three that stayed, each for a reason that is about this pipe rather than
// about taste: a certificate that has expired and a backend that is not answering are
// failures of the path a native notification would have to travel.
for (const stays of ['pushCertificate', 'pushNoBackend', 'pushServingAgain']) {
  check(`${stays} is still on ntfy`, new RegExp(`export async function ${stays}\\b`).test(NOTIFY), 'this one cannot go native — it reports the poll path being down');
}

const SERVER = read('lib/server.js');
check('the daemon emits a landing when the merge queue lands one', /bus\.emit\(landing\)/.test(SERVER));
// The next three are pinned to `app.bus`, not to `bus`, and the prefix is the whole
// point of the change: these three emits live in `startPoller`, where the only bus in
// scope is the one handed in — while `landing` above is inside `createApp`, where the
// bare local is correct. Written loosely, every one of these was satisfied by a line
// that threw `bus is not defined` on the first deploy the daemon settled (bc-gdub), and
// stayed green for the whole life of the bug. test/pollerbus.mjs is the half of that
// guard which runs the code rather than reading it.
check('and a deploy settling', /app\.bus\.emit\(deployEvent\(rec/.test(SERVER));
check(
  'and a tracker breaking, and recovering',
  /app\.bus\.emit\(syncStuckEvent\(/.test(SERVER) && /app\.bus\.emit\(syncClearEvent\(/.test(SERVER)
);
check('a successful deploy also clears the last failure’s card', /app\.bus\.emit\(deployClearEvent\(rec\)\)/.test(SERVER));

// bc-ka5y.15.8: the snapshot the poll needs when there is no transition left to
// replay, built from the same two functions the transitions above already call.
check('the snapshot is built from the same two sources as the transitions', /syncer\.trouble\(\)\.filter\(mine\)/.test(SERVER) && /deployTrouble\(\)\.filter\(mine\)/.test(SERVER));
check('reusing the transition builders rather than a second event shape', /syncStuckEvent\(sync\)/.test(SERVER) && /deploys\.map\(\(rec\) => deployEvent\(rec\)\)/.test(SERVER));
// Present on both branches of /api/poll, and neither conditioned on `polled`/`fresh` —
// that gate is what `questions`/`requests` cost a `bd` sweep for, and this does not.
const POLL_ROUTE = SERVER.slice(SERVER.indexOf("p === '/api/poll'"), SERVER.indexOf("if (p === '/api/asset'"));
const [resyncBranch, ordinaryBranch] = [POLL_ROUTE.slice(0, POLL_ROUTE.indexOf('const cold =')), POLL_ROUTE.slice(POLL_ROUTE.indexOf('const cold ='))];
check('present on the resync branch', /resync: true,/.test(resyncBranch) && /stuck: currentStuck\(\),/.test(resyncBranch));
check('and on the ordinary branch', /stuck: currentStuck\(\),/.test(ordinaryBranch));
// Ahead of the `...(fresh ? await inboxPayload(...) : { questions: null, ... })`
// spread on both branches, not inside it — that gate is what `questions`/`requests`
// cost a `bd` sweep for, and a `stuck` tucked inside it would go back to null on
// exactly the poll this bead is about.
check(
  'ahead of the spread questions/requests are gated behind, not inside it',
  resyncBranch.indexOf('stuck: currentStuck()') < resyncBranch.indexOf('...(fresh') &&
    ordinaryBranch.indexOf('stuck: currentStuck()') < ordinaryBranch.indexOf('...(polled')
);
// And the line the push left behind, which is why this one is a `!`. When the sync
// notification was an awaited ntfy push, its catch logged `[sync] could not push: …` —
// a *notification* failing, under a prefix whose every other line is `bd dolt push`, so
// the screen said the tracker had failed to push when it had not (bc-y3qk.3). Moving to
// the bus deleted it, nothing pinned that, and a future `catch` around an `emit` would
// put it straight back under the same prefix.
//
// Both tokens on one line, because the prefix and the words are one template literal —
// which also keeps a legitimate `[deploy] could not push` from failing this. Comments
// blanked and strings kept is the right way round: the paragraph above `sweepSync`
// quotes the deleted line to explain why it went, so a scan that read prose would find
// its own documentation and call it the bug. Imported here rather than at the top
// because nothing under lib/ may load before CONFIG_DIR is set.
const { blankComments } = await import('../lib/evidence.js');
check(
  'no [sync] line reports a failed notification as a failed push',
  !/\[sync\][^`\n]*could not push/.test(blankComments(SERVER)),
  'a failed notification must not read as a failed bd dolt push'
);

const DELIVER = read('bin/deliver.js');
check('a worker recording an external merge no longer imports the push', !/from '\.\.\/lib\/notify\.js'/.test(DELIVER));
check('it posts to the daemon instead, because it has no bus of its own', /\/api\/landed/.test(DELIVER));

// The terminal monitor is the other reader of this stream, and an event with no case
// there is an uncoloured, wordless row in a log of forty — which is how a new event type
// gets shipped and then looks broken to the one person watching it happen.
const MONITOR = read('bin/monitor.js');
for (const t of ['landed', 'released', 'epic-done', 'stuck']) {
  check(`the monitor has a line for ${t}`, new RegExp(`case '${t}':`).test(MONITOR), 'it would print an empty detail column');
}

/* ----------------------------------------------- 5. what the phone does with them */

console.log('\nthe shell files all four, and keeps the blockage apart\n');

const KT = (f) => read(path.join('android/app/src/main/java/m4m/beadcause', f));
const WATCH = KT('WatchService.kt');
const TRAY = KT('Tray.kt');
const NOTIF = KT('Notifications.kt');
const API = KT('Api.kt');

check('the watcher handles the three sizes of good news', /"landed", "released", "epic-done" ->/.test(WATCH), 'a type with no branch falls into `else -> Unit` and is silently dropped');
check('and the blockage', /"stuck" -> Notifications\.stuck/.test(WATCH));
check('good news respects a muted space', /"landed", "released", "epic-done" -> if \(!event\.quiet\)/.test(WATCH));
check('the event parser reads the state that clears a blockage', /state = optStringOrNull\("state"\)/.test(API));

check('news and blockages are cards of their own', /enum class Chan \{ WORK, FOUNDATION, NEWS, STUCK \}/.test(TRAY));
// The sweep is driven by the question list off /api/poll. A news key is not a bead, so
// it is in no live set, and sweeping these decks with it would have cleared the shade of
// them on the first resync after they arrived.
check(
  'the answered-question sweep cannot reach them',
  /for \(chan in BEAD_DECKS\) if \(deck\(chan\)\.removeAll \{ it\.key !in liveKeys \}\)/.test(TRAY),
  'retain() over every deck clears a landing on the next resync'
);
check('good news takes itself away', /val expires: Long = 0L/.test(TRAY) && /setTimeoutAfter/.test(NOTIF));
check('a blockage does not', /chan = Tray\.Chan\.STUCK,\n\s*\),/.test(NOTIF), 'the stuck entry must not set expires');
// The confirmation after answering from the shade is posted only when nothing is left
// waiting. A landing is not something waiting.
check(
  'a landing in the shade does not swallow the “Answered” confirmation',
  /Tray\.snapshot\(Tray\.Chan\.WORK, Tray\.Chan\.FOUNDATION\)/.test(NOTIF)
);
// This suite used to assert the *opposite* — that no channel was published yet, because
// a channel's sound is immutable after createNotificationChannel and cutting one before
// its sound existed would have burned the id. bc-ka5y.15.4 cut all five, and the whole of
// what that bead owes is now held by test/channels.mjs. What stays here is only the join:
// news no longer borrows the replies channel, which is what this suite was about.
check(
  'news has its own voice now and does not borrow the replies channel',
  /chan == Tray\.Chan\.NEWS -> newest\.voice/.test(NOTIF),
  'bc-ka5y.15.4 gave the three sizes of good news three channels — see test/channels.mjs'
);

/* ---------------------------------------- 5b. and the stuck card survives a restart */

console.log('\nand the stuck card is reassembled from a snapshot, not replayed — bc-ka5y.15.8\n');

check('the poll model parses a snapshot the daemon never used to send', /val stuck: List<Event>\?/.test(API));
check('read the same way the events themselves are — no second parser for the shape', /stuck = json\.optJSONArray\("stuck"\)\?\.map \{ it\.toEvent\(\) \}/.test(API));

check('the watcher reconciles it on every poll, not only a resync', /reconcileStuck\(poll\.stuck\)/.test(WATCH));
check(
  'resync no longer stops short of that reconciliation',
  !/showing\.retainAll\(byKey\.keys\)\s*\n\s*return\s*\n\s*\}/.test(WATCH),
  'a `return` right after retainAll would skip reconcileStuck on exactly the poll it matters most on'
);
// The whole of "no second buzz for a state it was already showing": a key the shade is
// already showing is left alone, never re-handed to Notifications.stuck.
check(
  'a key already in the shade is never re-notified',
  /for \(key in showingKeys - liveKeys\) Tray\.remove\(this, key\)/.test(WATCH) &&
    /if \(event\.key != null && event\.key !in showingKeys\) Notifications\.stuck\(this, event\)/.test(WATCH)
);
// And the reverse: it cannot be the bead-deck retain(), which would wrongly sweep a
// `stuck/…` key on the very next resync (see the check above pinning BEAD_DECKS).
check(
  'and this is not a second call to retain() over the STUCK deck',
  !/retain\(this, .*Chan\.STUCK/.test(WATCH)
);

/* ------------------------------------------------- 6. and it reaches a real poll */

console.log('\nend to end: the door a worker posts through, and the poll it wakes\n');

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(wsDir, { recursive: true });

const { createApp, listen } = await import(LIB('server.js'));
const cfg = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'news-token',
  actor: 'beadcause-test',
  // Deliberately a path that is not there: nothing in this suite may reach a tracker,
  // and a poll asked with `want=presence` never tries to.
  bdBin: path.join(tmp, 'no-such-bd'),
  workspaces: [{ name: 'demo', dir: wsDir }],
  sessionDirs: { demo: wsDir },
  openSessions: false,
  autoDispatch: false,
  pollSeconds: 3600,
  terminal: false,
  port: 0,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const request = (method, pathname, body = null) =>
  new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'x-beadcause-token': cfg.token,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const before = await request('GET', '/api/poll?want=presence');
const posted = await request('POST', '/api/landed', LANDING);
check('the door takes a landing', posted.status === 200 && posted.json.ok === true, JSON.stringify(posted.json));

const after = await request('GET', `/api/poll?want=presence&since=${before.json.seq}&wait=0`);
const arrived = (after.json.events || []).filter((e) => e.type === 'landed');
check('and it is on the poll the watch service is parked on', arrived.length === 1, JSON.stringify(after.json.events));
check('carrying the number and the title, so nothing has to be asked twice', (arrived[0]?.title || '').includes('#42') && (arrived[0]?.title || '').includes('picker'), JSON.stringify(arrived[0]));

// A pull request number is the one field this door cannot do without: everything else
// is prose, and a landing with no number is a card that cannot say what landed.
const nonsense = await request('POST', '/api/landed', { ...LANDING, number: 'not a number' });
check('a landing with no pull request number is refused', nonsense.status === 400, JSON.stringify(nonsense.json));

const wrongWs = await request('POST', '/api/landed', { ...LANDING, workspace: 'nowhere' });
check('and so is one for a workspace this daemon does not serve', wrongWs.status >= 400, JSON.stringify(wrongWs.json));

/* -------------------------------------- 7. the snapshot bc-ka5y.15.8 needed */

console.log('\nthe stuck snapshot: unconditional, not a replay of a transition\n');

const { DEPLOY_DIR } = await import(LIB('deploy.js'));
fs.mkdirSync(DEPLOY_DIR, { recursive: true });

// A quiet poll — `since` already at the current seq, so nothing on the bus moved and
// `bd` is never asked. This is the exact poll a phone makes after a restart lost its
// tray while nothing else in the world happened: the one `questions`/`requests` are
// deliberately null on, and the one bc-ka5y.15.8 is about.
const quietSince = (await request('GET', '/api/poll?want=presence')).json.seq;
const quiet = await request('GET', `/api/poll?since=${quietSince}&wait=0`);
check('nothing changed, so questions/requests stay null — no bd was asked', quiet.json.questions === null && quiet.json.requests === null, JSON.stringify(quiet.json));
check('but stuck is an array, not null, on that same quiet poll', Array.isArray(quiet.json.stuck), JSON.stringify(quiet.json.stuck));
check('and it is empty — nothing is stuck yet', quiet.json.stuck.length === 0, JSON.stringify(quiet.json.stuck));

// A tracker in conflict, recorded the way `sweepSync` would — straight into the
// syncer, no HTTP door, because bc-ka5y.15.8 is about the daemon already knowing this
// (`syncer.trouble()` survives its own restart) and simply not being asked for it here.
app.syncer.record({ workspace: 'demo', state: 'conflict', error: 'divergent histories', dir: wsDir });

const withSync = await request('GET', `/api/poll?since=${quietSince}&wait=0`);
check('still nothing changed on the bus — questions/requests are still null', withSync.json.questions === null, JSON.stringify(withSync.json.questions));
const syncCard = (withSync.json.stuck || []).find((e) => e.key === 'stuck/sync');
check('and the conflict is on the poll anyway, as a snapshot rather than a bus event', Boolean(syncCard), JSON.stringify(withSync.json.stuck));
check('naming the workspace and saying it will not clear on its own', (syncCard?.title || '').includes('demo') && (syncCard?.text || '').includes('will not clear'), JSON.stringify(syncCard));

// A deploy failure, written straight to the journal the way a real runner leaves it —
// no sweep involved, because the case this is for is a daemon that already restarted
// and is reading a journal an earlier process wrote.
fs.writeFileSync(
  path.join(DEPLOY_DIR, 'd-stuck-news.json'),
  JSON.stringify({
    id: 'd-stuck-news',
    workspace: 'demo',
    repo: 'widgets',
    status: 'failed',
    restarts: false,
    pid: null,
    requestedAt: new Date().toISOString(),
    steps: [],
    error: 'the deploy command failed (exit 1)',
  })
);
const withDeploy = await request('GET', `/api/poll?since=${quietSince}&wait=0`);
const deployCard = (withDeploy.json.stuck || []).find((e) => e.key === 'stuck/deploy/demo/widgets');
check('a repo whose last deploy failed rides the same snapshot', Boolean(deployCard), JSON.stringify(withDeploy.json.stuck));
check('both cards are on the poll side by side', (withDeploy.json.stuck || []).length === 2, JSON.stringify(withDeploy.json.stuck));

// Recovery: the tracker settles, the deploy that fixed it lands. Both are gone from
// the next snapshot without anything having to say "this cleared" — the newest word
// in each journal is the ordinary kind now, and there is nothing left to disagree
// with a `deployClearEvent`/`syncClearEvent` that never has to fire for this to work.
app.syncer.record({ workspace: 'demo', state: 'ok' });
fs.writeFileSync(
  path.join(DEPLOY_DIR, 'd-stuck-news-2.json'),
  JSON.stringify({
    id: 'd-stuck-news-2',
    workspace: 'demo',
    repo: 'widgets',
    status: 'ok',
    restarts: false,
    pid: null,
    requestedAt: new Date().toISOString(),
    steps: [],
  })
);
const clearedPoll = await request('GET', `/api/poll?since=${quietSince}&wait=0`);
check('and both are gone from the snapshot once they are fixed', (clearedPoll.json.stuck || []).length === 0, JSON.stringify(clearedPoll.json.stuck));

for (const s of servers) s.close();

/* ----------------------------------------------------------------------- verdict */

cleanupTmp(tmp);
console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall ${ran} passed\x1b[0m`}`);
process.exit(failures ? 1 : 0);
