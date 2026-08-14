#!/usr/bin/env node
//
// What a settled deploy tells a client about itself — lib/update.js.
//
//   npm test
//   node test/update.mjs
//
// The two facts this file is about are read off a record somebody else wrote, and both
// of them have an obvious wrong reading that a test is the only thing standing in front
// of:
//
//   - **`web` is not "the deploy succeeded".** The runner fast-forwards the checkout the
//     daemon serves `public/` from, so the files moved the moment the pull did — and a
//     deploy whose *restart* then failed has still changed the page under an open tab.
//     Gating on `status === 'ok'` would leave every such client on a stale bundle, and
//     for this repo — where a deploy ordinarily settles as `unconfirmed`, because it
//     killed the process that would have reported on it — it would leave *every* client
//     on one.
//   - **The APK sidecar is not trusted because it exists.** It states a `versionCode`
//     that nothing else on disk can corroborate, and a stale one is the single input
//     that could put a phone in a download loop: told it is behind, it fetches, installs
//     the same build, and is told it is behind again. So the size has to match the file
//     it claims to describe, and where it does not the version is unknown.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  apkInfo,
  deployEffects,
  isOurs,
  lastEffects,
  movedWeb,
  rebuiltApk,
  updateView,
} = await import(new URL('../lib/update.js', import.meta.url).href);

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran++;
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-update-'));
const root = path.join(tmp, 'checkout');
fs.mkdirSync(path.join(root, 'public'), { recursive: true });

/** A record shaped like the one scripts/deploy-runner.mjs writes. */
const record = (patch = {}) => ({
  id: 'd-1',
  dir: root,
  status: 'ok',
  changed: [],
  steps: [],
  requestedAt: '2026-08-13T10:00:00.000Z',
  ...patch,
});

console.log('what a deploy did to the client\n');

/* ------------------------------------------------------------------ the page */

check('a change under public/ moved the page', () =>
  assert.equal(movedWeb(['lib/server.js', 'public/app.js']), true)
);

check('a change nowhere near it did not', () =>
  assert.equal(movedWeb(['lib/server.js', 'test/update.mjs', 'README.md']), false)
);

check('nothing changed is not a change', () => {
  assert.equal(movedWeb([]), false);
  assert.equal(movedWeb(undefined), false);
});

// The APK lives in public/ because that is where the daemon serves from. A rebuild that
// republished it and touched nothing else must not tell every open tab to reload.
check('the published APK is in public/ and is not the page', () => {
  assert.equal(movedWeb(['public/beadcause.apk']), false);
  assert.equal(movedWeb(['public/beadcause.apk', 'public/beadcause.apk.json']), false);
  assert.equal(movedWeb(['public/beadcause.apk', 'public/style.css']), true);
});

// `publicity/` starts with `public` and is not `public/`.
check('a directory that merely starts with the word is not it', () =>
  assert.equal(movedWeb(['publicity/notes.md']), false)
);

/* ------------------------------------------------------------------- the APK */

check('an apk step that exited 0 rebuilt the shell', () =>
  assert.equal(rebuiltApk(record({ steps: [{ name: 'apk', code: 0 }] })), true)
);

check('one that failed did not', () =>
  assert.equal(rebuiltApk(record({ steps: [{ name: 'apk', code: 1 }] })), false)
);

check('and neither did a deploy that never ran one', () =>
  assert.equal(rebuiltApk(record({ steps: [{ name: 'git fetch', code: 0 }, { name: 'deploy', code: 0 }] })), false)
);

/* ------------------------------------------------------------- whose deploy */

check("a record naming this checkout's directory is ours", () =>
  assert.equal(isOurs(record(), { root }), true)
);

check('one naming another tree is not', () => {
  assert.equal(isOurs(record({ dir: path.join(tmp, 'sophab') }), { root }), false);
  assert.equal(isOurs(record({ dir: null }), { root }), false);
  assert.equal(isOurs(null, { root }), false);
});

check('a trailing slash is the same directory', () =>
  assert.equal(isOurs(record({ dir: `${root}/` }), { root }), true)
);

/* --------------------------------------------------------------- the effects */

check('a deploy of another repo says nothing to us', () =>
  assert.equal(
    deployEffects(record({ dir: path.join(tmp, 'sophab'), changed: ['public/app.js'] }), { root }),
    null
  )
);

check('and neither does one that is still running', () => {
  for (const status of ['queued', 'pulling', 'building', 'deploying']) {
    assert.equal(deployEffects(record({ status, changed: ['public/app.js'] }), { root }), null, status);
  }
});

// The heart of it: this is what every beadcause deploy of itself looks like on disk.
check('an unconfirmed restart still reports the page it moved', () => {
  const e = deployEffects(
    record({
      status: 'unconfirmed',
      changed: ['public/app.js', 'lib/server.js'],
      from: '1111111111111111',
      to: '2222222222222222',
    }),
    { root }
  );
  assert.equal(e.web, true);
  assert.equal(e.status, 'unconfirmed');
  assert.equal(e.from, '1111111');
  assert.equal(e.to, '2222222');
});

check('a deploy that failed at the restart moved the files all the same', () => {
  const e = deployEffects(record({ status: 'failed', changed: ['public/style.css'] }), { root });
  assert.equal(e.web, true);
  assert.equal(e.status, 'failed');
});

check('a rebuilt APK is reported beside it', () => {
  const e = deployEffects(
    record({ changed: ['android/app/src/main/java/m4m/beadcause/MainActivity.kt'], steps: [{ name: 'apk', code: 0 }] }),
    { root }
  );
  assert.equal(e.apk, true);
  assert.equal(e.web, false);
});

check('the newest deploy that changed anything is the one that is reported', () => {
  const deploys = [
    record({ id: 'd-3', changed: ['README.md'] }),
    record({ id: 'd-2', changed: ['public/app.js'] }),
    record({ id: 'd-1', changed: ['public/style.css'] }),
  ];
  assert.equal(lastEffects(deploys, { root }).id, 'd-2');
});

check('a journal with nothing in it for us reports nothing', () => {
  assert.equal(lastEffects([record({ changed: ['lib/server.js'] })], { root }), null);
  assert.equal(lastEffects([], { root }), null);
});

/* ------------------------------------------------------------- the APK on disk */

const apk = path.join(root, 'public', 'beadcause.apk');
const sidecar = `${apk}.json`;

check('no APK published is not an error', () => assert.equal(apkInfo({ root }), null));

fs.writeFileSync(apk, Buffer.alloc(2048, 7));

check('an APK with no sidecar is a size and a date, and an unknown version', () => {
  const info = apkInfo({ root });
  assert.equal(info.size, 2048);
  assert.equal(info.versionCode, null);
  assert.equal(info.url, '/beadcause.apk');
  assert.ok(Date.parse(info.builtAt), `builtAt is not a date: ${info.builtAt}`);
});

check('a sidecar whose size matches names the build', () => {
  fs.writeFileSync(sidecar, JSON.stringify({ versionCode: 412, versionName: '1.0.412', size: 2048, sha256: 'ab' }));
  const info = apkInfo({ root });
  assert.equal(info.versionCode, 412);
  assert.equal(info.versionName, '1.0.412');
  assert.equal(info.sha256, 'ab');
});

check('one describing a different file names nothing', () => {
  fs.writeFileSync(sidecar, JSON.stringify({ versionCode: 999, versionName: '1.0.999', size: 4096 }));
  assert.equal(apkInfo({ root }).versionCode, null);
});

check('and neither does one that will not parse', () => {
  fs.writeFileSync(sidecar, '{ half a fi');
  assert.equal(apkInfo({ root }).versionCode, null);
  assert.equal(apkInfo({ root }).size, 2048);
});

/* ----------------------------------------------------------------- the view */

check('the view carries both halves at once', () => {
  fs.writeFileSync(sidecar, JSON.stringify({ versionCode: 7, versionName: '1.0.7', size: 2048 }));
  const view = updateView({ deploys: [record({ changed: ['public/app.js'] })], root });
  assert.equal(view.apk.versionCode, 7);
  assert.equal(view.deploy.web, true);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
