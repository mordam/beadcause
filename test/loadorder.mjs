#!/usr/bin/env node
//
// Every module under lib/ can be the first one imported.
//
//   npm test
//   node test/loadorder.mjs
//
// bc-u4na. `lib/foundation.js` read `DEFAULT_TOOL_LIST` from `lib/agents.js` at module
// scope, and `lib/agents.js` imported `baseline` and `mark` back. A cycle is not itself
// a fault in ESM — `lib/config.js` is in four of them and they all load — but a cycle
// where one side *uses* the other's binding while that side is still evaluating is,
// because the binding is in its temporal dead zone until its own module body reaches it.
// So the graph had an entry order: come in through `foundation.js` and both loaded, come
// in through `agents.js` and it threw `Cannot access 'DEFAULT_TOOL_LIST' before
// initialization`.
//
// Nothing in the running daemon was ever broken by that, which is exactly what made it
// expensive. Every real entry point happened to reach `foundation.js` first, so the trap
// was sprung only by *new* code: adding `import … from './agents.js'` to any lib/ module
// that `lib/server.js` imports early moved agents ahead of foundation and killed the
// daemon at boot, and `npm test` died at whichever suite first imported `server.js`. Nine
// suites had grown an otherwise-pointless `await import('lib/foundation.js')` at the top
// to force the order, the reason was written down in none of them, and the error named a
// constant rather than a cycle. Two sessions paid twenty minutes each to rediscover it.
//
// The fix was `lib/toolbelt.js` — one leaf both sides import — and this file is what
// stops the next one. It imports each `lib/*.js` **in its own process**, which is the
// only way to ask the question: once a module is loaded, the order is decided, so a
// single process can test exactly one first-import and no more. ~85 processes, ~3s,
// eight at a time.
//
// What it does *not* claim: that lib/ is acyclic. Several cycles are here on purpose and
// are safe, because neither half touches the other's bindings at module scope. The
// property worth having is not "no cycles" but "no module that only works second", and
// this asserts that one directly rather than through a proxy for it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cleanupTmp } from './helpers/tmp.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = path.join(ROOT, 'lib');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

console.log('lib/ load order\n');

// Redirected before a single module is spawned: CONFIG_DIR resolves at load, and a
// sweep that imported the whole app against the real ~/.config/beadcause would be
// eighty-five processes reading — and possibly writing — a running daemon's mind.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-loadorder-'));
const env = { ...process.env, BEADCAUSE_CONFIG_DIR: path.join(tmp, 'config') };
fs.mkdirSync(env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const modules = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).sort();

/**
 * Import one module in a process that has imported nothing else.
 *
 * `process.exit` on the resolve path deliberately: a module that leaves a timer or a
 * handle open would otherwise hold the process past its own success and read as a
 * hang. The failure path prints the message only — a TDZ error's stack is all node
 * internals and the message is the whole of what identifies it.
 */
async function importsCold(file) {
  const code = "import(process.argv[1]).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); })";
  try {
    await run(process.execPath, ['-e', code, path.join(LIB, file)], { env, timeout: 60_000 });
    return null;
  } catch (err) {
    const why = String(err.stderr || '').trim().split('\n')[0] || err.message;
    return `lib/${file}: ${why}`;
  }
}

/** Eight at a time: the sweep is process-startup-bound, and a laptop is running others. */
async function pool(items, width, fn) {
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
    })
  );
  return out;
}

await check('there are lib modules to sweep', () => {
  assert.ok(modules.length > 50, `only ${modules.length} found in lib/ — the read is wrong, not the tree`);
});

await check('every lib/ module loads when it is the first one in', async () => {
  const broken = (await pool(modules, 8, importsCold)).filter(Boolean);
  assert.deepEqual(
    broken,
    [],
    `${broken.length} module(s) only load second. A "Cannot access X before initialization" here is a\n` +
      'cycle whose evaluation order decides whether it loads — move the shared constant into a leaf\n' +
      'module both sides import, as bc-u4na did with lib/toolbelt.js:\n' +
      broken.join('\n')
  );
});

await check('lib/toolbelt.js is a leaf, so it cannot be drawn back into one', () => {
  // The fix only holds while the module both sides import imports nothing itself. An
  // `import './config.js'` here would put toolbelt in the middle of a new cycle and hand
  // the load order back to whoever enters first — and it would look entirely reasonable
  // in a diff, which is why it is asserted rather than left to good sense.
  const src = fs.readFileSync(path.join(LIB, 'toolbelt.js'), 'utf8');
  const imports = [...src.matchAll(/^import\s[\s\S]*?from\s*'([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, [], `lib/toolbelt.js must import nothing; it imports ${imports.join(', ')}`);
});

await check('the tool list has one home, and lib/agents.js re-exports it', async () => {
  // Two copies of an allowlist is one copy that gets widened without the other noticing,
  // which is the whole reason foundation.js quoted agents.js and the cycle existed at
  // all. Whatever else moves, that must not become two arrays.
  const toolbelt = await import(path.join(LIB, 'toolbelt.js'));
  const agents = await import(path.join(LIB, 'agents.js'));
  const foundation = await import(path.join(LIB, 'foundation.js'));
  assert.equal(agents.DEFAULT_TOOL_LIST, toolbelt.DEFAULT_TOOL_LIST, 'lib/agents.js has its own copy of the list');
  assert.deepEqual(foundation.baseline('dispatch').allowedTools, toolbelt.DEFAULT_TOOL_LIST);
  const src = fs.readFileSync(path.join(LIB, 'foundation.js'), 'utf8');
  assert.ok(
    !/^import[^\n]*from '\.\/agents\.js';$/m.test(src),
    'lib/foundation.js imports lib/agents.js again — that is the bc-u4na cycle coming back'
  );
});

await cleanupTmp(tmp);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
