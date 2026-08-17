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

// Rounding `unconfirmed` to either side is exactly the lie the deploy notification has
// always refused: the deploy that restarts beadcause kills the process reporting on it.
check(
  'an unconfirmed deploy is not reported as a release',
  deployEvent({ workspace: 'demo', id: 'd-3', status: 'unconfirmed' }).type === 'stuck'
);
check('and neither is a lost one', deployEvent({ workspace: 'demo', id: 'd-4', status: 'lost' }).type === 'stuck');

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
check('and a deploy settling', /bus\.emit\(deployEvent\(rec/.test(SERVER));
check('and a tracker breaking, and recovering', /bus\.emit\(syncStuckEvent\(/.test(SERVER) && /bus\.emit\(syncClearEvent\(/.test(SERVER));
check('a successful deploy also clears the last failure’s card', /bus\.emit\(deployClearEvent\(rec\)\)/.test(SERVER));

const DELIVER = read('bin/deliver.js');
check('a worker recording an external merge no longer imports the push', !/from '\.\.\/lib\/notify\.js'/.test(DELIVER));
check('it posts to the daemon instead, because it has no bus of its own', /\/api\/landed/.test(DELIVER));

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
// Immutable-by-design: Android takes a channel's sound from the first
// createNotificationChannel and ignores every one after it, forever. Cutting the five
// channels before their sounds exist would burn the ids bc-ka5y.15.4 needs.
check(
  'no channel is published before bc-ka5y.15.4 can give it a sound',
  !/CHANNEL_MERGED|CHANNEL_RELEASED|CHANNEL_EPIC|CHANNEL_STUCK/.test(NOTIF),
  'a channel created with the wrong sound is a channel that needs a _v2 on day one'
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

for (const s of servers) s.close();

/* ----------------------------------------------------------------------- verdict */

cleanupTmp(tmp);
console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall ${ran} passed\x1b[0m`}`);
process.exit(failures ? 1 : 0);
