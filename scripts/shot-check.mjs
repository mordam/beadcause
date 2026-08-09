#!/usr/bin/env node
//
// Does the thing that gives agents eyes still work?
//
//   node scripts/shot-check.mjs [--keep]
//
// scripts/shot.mjs is the only reason an agent in this repo can see the app it is
// changing, and every way it can break is silent. Pairing stops working and it
// photographs the setup dialog — a perfectly good PNG of the wrong thing, which
// reads to an agent as "the app is broken". The error capture stops working and a
// page with a 401 behind a blank panel comes back looking fine. The exit code stops
// tracking whether the page loaded and a shot of Chrome's own error page passes.
// None of those announce themselves; a picture always arrives.
//
// So: a fixture page served from this process, shot for real by the real script,
// and the four properties asserted rather than eyeballed. Same shape as
// console-check.mjs and its siblings, and it needs no daemon and no beads — it runs
// against its own server with its own throwaway config, so it can never photograph,
// or leak, anything of yours.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = path.join(ROOT, 'scripts', 'shot.mjs');
const KEEP = process.argv.includes('--keep');

// Its own config directory, with a token this file knows. Two things follow: the
// script under test never reads your real config, and "the token stayed off the
// screen" becomes an assertion rather than a hope, because we know the string to
// look for.
const TOKEN = 'shot-check-token-4e3a91';
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-shotcheck-cfg-'));
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-shotcheck-out-'));
fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({ port: 4318, token: TOKEN, workspaces: [] }, null, 2)
);

/* ---------------------------------------------------------------- fixture */

// Deliberately noisy in the two ways that matter: it says something on
// console.error, and it asks for a URL that is not there. A run that reports
// neither has lost the half of this that a screenshot cannot show you.
const PAGE = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shot-check</title>
<style>
  body { margin: 0; font: 16px/1.4 -apple-system, system-ui, sans-serif; background: #0b0f14; color: #e6edf3; padding: 24px; }
  #paired { color: #5eead4; font-weight: 700; }
  @media (prefers-color-scheme: light) { body { background: #fff; color: #111; } }
</style>
<h1>shot-check fixture</h1>
<!-- Rendered from what the init script left behind, so this element existing at all
     is proof that pairing happened before the page's own code ran. The value is
     never written to the DOM: this file asserts the token stays off the screen. -->
<div id="pending">not paired</div>
<div id="scheme"></div>
<script>
  if ((localStorage.getItem('beadcause.token') || '').length > 0) {
    const el = document.createElement('div');
    el.id = 'paired';
    el.textContent = 'paired';
    document.getElementById('pending').replaceWith(el);
  }
  // Reported through console.error on purpose. It is the one channel the script
  // under test prints verbatim, which makes "the emulated media is what it claims"
  // checkable from the outside instead of by looking at a picture.
  const env =
    'env scheme:' + (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') +
    ' motion:' + (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference') +
    ' width:' + innerWidth + ' touch:' + ('ontouchstart' in window);
  document.getElementById('scheme').textContent = env;
  console.error(env);
  console.error('fixture says something went wrong');
  fetch('/missing').catch(() => {});
</script>
`;

function serve() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/missing')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* -------------------------------------------------------------------- run */

const run = (args) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [SHOT, ...args],
      { cwd: ROOT, env: { ...process.env, BEADCAUSE_CONFIG_DIR: CONFIG_DIR } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` })
    );
  });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const png = (n) => path.join(OUT_DIR, `${n}.png`);
const isPng = (f) => fs.existsSync(f) && fs.readFileSync(f).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));

try {
  console.log('shot.mjs');

  // The whole thing at once: it pairs before the page runs, it waits for something
  // the page only draws once paired, and it photographs it.
  const a = await run(['/', '--base', BASE, '--out', png('phone'), '--wait', '#paired']);
  check('exits 0 on a page that loads', a.code === 0, `exit ${a.code}`);
  check('writes a real PNG', isPng(png('phone')), `${isPng(png('phone')) ? fs.statSync(png('phone')).size + ' bytes' : 'missing'}`);
  check('pairs before the page runs', !/never appeared/.test(a.out), '#paired was drawn');
  check('the token never reaches the output', !a.out.includes(TOKEN));
  check('reports console.error', /console\.error: fixture says something went wrong/.test(a.out));
  check('reports the 404', /http: 404 \/missing/.test(a.out));
  check('says where and how big', a.out.includes('390x844 @3x mobile'), '390x844 @3x mobile');
  // Read back out of the page rather than trusted from the flag: the header claims
  // pinned dark and reduced motion, and this is the page saying whether it got them.
  const env = (a.out.match(/env scheme:\S+ motion:\S+ width:\d+ touch:\S+/) || [''])[0];
  check('the phone really is the default', env === 'env scheme:dark motion:reduce width:390 touch:true', env || 'the page never said');

  // The phone is the default, and --desktop is the only thing that changes it.
  const b = await run(['/', '--base', BASE, '--out', png('desktop'), '--desktop']);
  const envB = (b.out.match(/env scheme:\S+ motion:\S+ width:\d+ touch:\S+/) || [''])[0];
  check('--desktop is 1280x900 and not mobile', b.code === 0 && /1280x900 @2x( |$)/m.test(b.out) && !/ mobile/.test(b.out), `exit ${b.code}`);
  check('--desktop turns touch off and keeps the media pinned', envB === 'env scheme:dark motion:reduce width:1280 touch:false', envB || 'the page never said');

  // A page that never arrived must not read as a page that rendered.
  const c = await run(['/', '--base', 'http://127.0.0.1:4399', '--out', png('dead')]);
  check('exits 1 when the page never loaded', c.code === 1, `exit ${c.code}`);
  check('says so in words, not just a code', /never loaded/.test(c.out));
  check('still photographs the error state', isPng(png('dead')));

  // --strict is the switch for a caller that wants any complaint to be a failure.
  const d = await run(['/', '--base', BASE, '--out', png('strict'), '--strict']);
  check('--strict fails on a page that complains', d.code === 1, `exit ${d.code}`);

  // A selector that will never appear must say so rather than quietly shoot anyway.
  const e = await run(['/', '--base', BASE, '--out', png('wait'), '--wait', '#nothing-like-this']);
  check('--wait reports a selector that never arrived', /never appeared/.test(e.out) && isPng(png('wait')));
} finally {
  server.close();
  if (KEEP) {
    console.log(`\nkept: ${OUT_DIR}`);
  } else {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
