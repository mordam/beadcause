#!/usr/bin/env node
/**
 * lib/bd.js — dismissing a question, which is the one write with nothing to say.
 *
 *     npm test
 *     node test/dismiss.mjs
 *
 * A fake `bd` on disk that records its own argv, and the real Bd class driving it.
 * Nothing here touches a workspace of yours.
 *
 * Three things are pinned, and all three are things a reasonable refactor breaks:
 *
 * 1. **It must never become `bd human dismiss`.** That is the tracker's own word for
 *    this and it is exactly what the code looks like it should call — but it is
 *    broken in bd 1.1.2 the same way `bd human respond` is ("resolving issue ID:
 *    storage is nil"), and the failure lands on a phone, on a card that has already
 *    flown off the list. So the argv is asserted to be `comment` then `close`, and
 *    asserted never to contain the subcommand that looks nicer.
 * 2. **The comment comes first.** Dolt is single-writer, so the close is the step
 *    that loses a race. Comment-then-close means a lost race leaves the reason in
 *    the thread and the question still open — answerable again. Close-then-comment
 *    would leave a bead closed with no word anywhere about why, which is the state
 *    the whole "dismissed with a note" idea exists to avoid.
 * 3. **The note reaches both surfaces.** `bd show` prints the close reason months
 *    later; an agent watching the thread reads comments and never sees a close
 *    reason at all. Dropping either one loses the dismissal for one of its two
 *    readers, and neither loss shows up anywhere at runtime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib', 'bd.js');

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ------------------------------------------------------------------ the world */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-dismiss-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const BIN = path.join(tmp, 'bd');
const LOG = path.join(tmp, 'calls.log');
const WS = { name: 'widgets', dir: path.join(tmp, 'beads', 'widgets', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });

// Extensionless, so node runs it as CommonJS whatever this package's "type" says.
// It records every invocation and fails whichever subcommand $BD_FAKE_FAIL names —
// which is how the half-written dismissal above gets tested at all.
fs.writeFileSync(
  BIN,
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BD_FAKE_LOG, JSON.stringify(args) + '\\n');
if (process.env.BD_FAKE_FAIL && args[0] === process.env.BD_FAKE_FAIL) {
  process.stderr.write('bd: refused\\n');
  process.exit(1);
}
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

/* ----------------------------------------------------------- with a note typed */

reset();
await bd.dismiss(WS, 'wd-42', 'not doing this, the feature is going away');
let seen = calls();
const NOTE = 'Dismissed via Beadcause — not doing this, the feature is going away';

check('two calls, comment then close', seen.length === 2 && seen[0][0] === 'comment' && seen[1][0] === 'close', JSON.stringify(seen));
check(
  'the comment carries the note',
  seen[0] && seen[0][1] === 'wd-42' && seen[0][2] === NOTE,
  JSON.stringify(seen[0])
);
check(
  'the close reason carries it too',
  seen[1] && seen[1][1] === 'wd-42' && seen[1][2] === '--reason' && seen[1][3] === NOTE,
  JSON.stringify(seen[1])
);
check(
  'never `bd human dismiss` — it is broken in 1.1.2',
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
await bd.dismiss(WS, 'wd-43', '');
seen = calls();
check(
  'no note: a bare "Dismissed via Beadcause", with no dangling dash',
  seen.length === 2 && seen[0][2] === 'Dismissed via Beadcause' && seen[1][3] === 'Dismissed via Beadcause',
  JSON.stringify(seen)
);

/* ------------------------------------------- a close that loses the write lock */

reset();
process.env.BD_FAKE_FAIL = 'close';
let threw = null;
try {
  await bd.dismiss(WS, 'wd-44', 'why');
} catch (err) {
  threw = err;
}
delete process.env.BD_FAKE_FAIL;
seen = calls();
check('a refused close is reported, never swallowed', Boolean(threw), String(threw));
check(
  'and the reason is already in the thread when it happens',
  seen[0] && seen[0][0] === 'comment' && seen[0][2] === 'Dismissed via Beadcause — why',
  JSON.stringify(seen)
);

/* ------------------------------------------------- and the route above it */

// The adapter being right is half of it. The other half is that `POST /api/dismiss`
// reaches it at all — a route that 404s would fail on the phone exactly the way a
// broken `bd` call would, and nothing above this line would notice.
const { createApp, listen } = await import(path.join(HERE, '..', 'lib', 'server.js'));
const PORT = 4386;
const cfg = {
  port: PORT,
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
const post = (body) =>
  fetch(`http://127.0.0.1:${PORT}/api/dismiss`, {
    method: 'POST',
    headers: { 'x-beadcause-token': cfg.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const servers = listen(cfg, createApp(cfg).handler);
try {
  reset();
  const res = await post({ workspace: WS.name, id: 'wd-9', reason: 'the report was dropped' });
  // The route reads the bead before it writes — that is the amendment check, looking
  // for an agent's request to be changed so a dismissal is recorded as the refusal it
  // is. Only the writes are the subject here.
  const writes = () => calls().filter((a) => a[0] !== 'show' && a[0] !== 'comments');
  seen = writes();
  check('POST /api/dismiss is answered', res.status === 200, `status ${res.status}`);
  check('and says the bead is closed', (await res.json()).closed === true, '');
  check(
    'the route reaches the adapter — a comment and a close, in that order',
    seen.length === 2 && seen[0][0] === 'comment' && seen[1][0] === 'close',
    JSON.stringify(calls())
  );
  check(
    'with the note the phone sent',
    seen[1] && seen[1][3] === 'Dismissed via Beadcause — the report was dropped',
    JSON.stringify(seen[1])
  );
  check(
    'the bead it looked at first is the one it was asked about',
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
    empty.status === 200 && writes().length === 2 && writes()[1][3] === 'Dismissed via Beadcause',
    `status ${empty.status}, ${JSON.stringify(writes())}`
  );
} finally {
  for (const s of servers) s.close();
}

/* --------------------------------------------------------------------- verdict */

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
