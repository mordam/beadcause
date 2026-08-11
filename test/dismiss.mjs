#!/usr/bin/env node
/**
 * Dismissing a question — the one way out of a card that must not write to bd.
 *
 *     npm test
 *     node test/dismiss.mjs
 *
 * A fake `bd` on disk that records its own argv, and the real Bd class driving it.
 * Nothing here touches a workspace of yours.
 *
 * **This file used to pin the opposite behaviour**, and the story is worth keeping,
 * because the shape it pinned was wrong rather than broken. Dismissing was a close:
 * comment the reason, then `bd close --reason "Dismissed via Beadcause"`. It read
 * like the tracker's own `bd human dismiss` and it passed its tests. What it could
 * not do was survive contact with the card you most want to dismiss — an epic with
 * thirty open children, which bd flatly refuses to close. Three taps, three
 * duplicate comments, no dismissal.
 *
 * The fix was not to make the close work. It was that **"I am not dealing with this
 * now" is not "this is decided"**, and closing the bead to clear the card throws
 * away the thing it was tracking. So the acknowledgement lives in beadcause's own
 * state (see `withoutDismissed` in lib/server.js) and the tracker never hears about
 * it. Three things are pinned now, and all three are things a reasonable refactor
 * breaks:
 *
 * 1. **A wordless dismissal writes nothing at all.** Not a comment, and above all
 *    not a close. bd should have no idea it happened.
 * 2. **A note is a comment, verbatim.** No "Dismissed via Beadcause" wrapper: the
 *    bead is not dismissed, you are, and an agent reading the thread should see what
 *    you typed rather than a status word beadcause invented.
 * 3. **Never `bd human dismiss`.** The tracker's own word for this closes the bead,
 *    which is the whole thing being avoided — and it is broken in bd 1.1.2 besides
 *    ("resolving issue ID: storage is nil"), on a path whose failure lands on a
 *    phone, on a card that has already flown off the list.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib', 'bd.js');

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-dismiss-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const WS = { name: 'wd', dir: path.join(tmp, 'ws') };
fs.mkdirSync(path.join(WS.dir, '.beads'), { recursive: true });

const BIN = path.join(tmp, 'bd');
const LOG = path.join(tmp, 'calls.log');
fs.writeFileSync(
  BIN,
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BD_FAKE_LOG, JSON.stringify(args) + '\\n');
// Enough of a bead for the hold lookup to resolve: no blockers, no children, so a
// dismissal here is the plain "comes back on the next comment" case.
if (args[0] === 'show') {
  process.stdout.write(JSON.stringify([{ id: args[1], issue_type: 'task', status: 'open', comment_count: 2, dependencies: [] }]));
  process.exit(0);
}
if (process.env.BD_FAKE_FAIL && args[0] === process.env.BD_FAKE_FAIL) {
  process.stderr.write('bd: refused\\n');
  process.exit(1);
}
process.stdout.write('[]');
process.exit(0);
`,
  { mode: 0o755 }
);
process.env.BD_FAKE_LOG = LOG;

const { Bd } = await import(LIB);
const bd = new Bd({ bin: BIN, actor: 'beadcause' });

const calls = () =>
  fs
    .readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const reset = () => fs.writeFileSync(LOG, '');
/** Reads are `show` and `comments`; everything else changes the tracker. */
const writes = () => calls().filter((a) => !['show', 'comments', 'list', 'human'].includes(a[0]));

console.log('\ndismiss — the write that is not one\n');

/* ----------------------------------------------------------- with a note typed */

reset();
await bd.noteOnly(WS, 'wd-42', 'not doing this, the feature is going away');
let seen = calls();
check('one call, and it is a comment', seen.length === 1 && seen[0][0] === 'comment', JSON.stringify(seen));
check(
  'carrying exactly what you typed — no "Dismissed via Beadcause" wrapper',
  seen[0] && seen[0][1] === 'wd-42' && seen[0][2] === 'not doing this, the feature is going away',
  JSON.stringify(seen[0])
);
check('and no close, which is the whole point', !seen.some((a) => a[0] === 'close'), JSON.stringify(seen));
check(
  'never `bd human dismiss` — it closes the bead, and it is broken in 1.1.2 besides',
  !seen.some((a) => a[0] === 'human'),
  JSON.stringify(seen)
);
check(
  'attributed to beadcause, not to whoever git says you are',
  seen.every((a) => a.includes('--actor') && a[a.indexOf('--actor') + 1] === 'beadcause'),
  JSON.stringify(seen)
);

/* ------------------------------------------------------------ with an empty box */

reset();
await bd.noteOnly(WS, 'wd-43', '');
check('an empty box calls bd not at all — it should not know this happened', calls().length === 0, JSON.stringify(calls()));

reset();
await bd.noteOnly(WS, 'wd-43', '   \n  ');
check('nor does whitespace someone tapped by accident', calls().length === 0, JSON.stringify(calls()));

/* ------------------------------------------- a comment that loses the write lock */

reset();
process.env.BD_FAKE_FAIL = 'comment';
let threw = null;
try {
  await bd.noteOnly(WS, 'wd-44', 'why');
} catch (err) {
  threw = err;
}
delete process.env.BD_FAKE_FAIL;
check('a refused comment is reported, never swallowed', Boolean(threw), String(threw));

/* ------------------------------------------------- and the route above it */

// The adapter being right is half of it. The other half is that `POST /api/dismiss`
// reaches it at all — a route that 404s would fail on the phone exactly the way a
// broken `bd` call would, and nothing above this line would notice.
const { createApp, listen } = await import(path.join(HERE, '..', 'lib', 'server.js'));
// Port 0, never a number typed here: a dozen sessions run this suite at once and a
// fixed port makes the loser of that race exit 1 on an EADDRINUSE that reads like a
// regression. `createApp` never looks at cfg.port — only `listen` does — so the app
// is happy to be built before the kernel has picked one. See test/helpers/net.mjs.
const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'dismiss-test-token',
  workspaces: [WS],
  spaces: [],
  claudeSessions: false,
  openSessions: false,
  advocates: { enabled: false, workspaces: [] },
  ntfy: {},
  bdBin: BIN,
  actor: 'beadcause',
};
const servers = listen(cfg, createApp(cfg).handler);
const PORT = await boundPort(servers);

const post = (body) =>
  fetch(`http://127.0.0.1:${PORT}/api/dismiss`, {
    method: 'POST',
    headers: { 'x-beadcause-token': cfg.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

try {
  reset();
  const res = await post({ workspace: WS.name, id: 'wd-9', reason: 'the report was dropped' });
  const body = await res.json();
  check('POST /api/dismiss is answered', res.status === 200, `status ${res.status}`);
  check('and says the bead was NOT closed', body.closed === false, JSON.stringify(body));
  check('while confirming the card is gone', body.dismissed === true, JSON.stringify(body));
  seen = writes();
  check(
    'the route wrote one comment and nothing else',
    seen.length === 1 && seen[0][0] === 'comment' && seen[0][2] === 'the report was dropped',
    JSON.stringify(calls())
  );
  check(
    'the bead it looked at is the one it was asked about',
    calls().every((a) => a.includes('wd-9')),
    JSON.stringify(calls())
  );

  reset();
  const bare = await post({ workspace: WS.name });
  check('a dismissal with no id is refused', bare.status === 400, `status ${bare.status}`);
  check('and nothing was written', calls().length === 0, JSON.stringify(calls()));

  reset();
  const empty = await post({ workspace: WS.name, id: 'wd-10' });
  check(
    'an empty box is not an error — most dismissals have nothing to say',
    empty.status === 200,
    `status ${empty.status}`
  );
  check(
    'and it reaches bd only to read, never to write',
    writes().length === 0,
    JSON.stringify(calls())
  );
} finally {
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* --------------------------------------------------------------------- verdict */

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
