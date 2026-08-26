#!/usr/bin/env node
//
// lib/reachable.js — Rule 1, offline: is a path in this checkout reachable from a phone.
//
//     npm test
//     node test/reachable.mjs
//
// `bin/b7e-packet` is the one caller; this pins the derivation on its own, including the
// two `null` cases the CLI test never reaches — a directory that is not a git checkout at
// all, and one with no `origin` and no `main`/`master` either, where the honest answer is
// "cannot say" and not a guessed `false`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { currentBranch, trunkBranch, rule1Verdict } = await import(path.join(ROOT, 'lib', 'reachable.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reachable-'));

function repo(branch) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', branch);
  git('config', 'user.email', 'test@localhost');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'root');
  return dir;
}

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${String(err.message).split('\n').join('\n       ')}`);
  }
}

console.log('\nlib/reachable.js — Rule 1, without a network call\n');

await check('currentBranch reads the checked-out branch', () => {
  const dir = repo('main');
  assert.equal(currentBranch(dir), 'main');
});

await check('currentBranch is empty outside a git repository', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'notgit-'));
  assert.equal(currentBranch(dir), '');
});

await check('trunkBranch falls back to a local `main` when there is no origin/HEAD', () => {
  const dir = repo('main');
  assert.equal(trunkBranch(dir), 'main');
});

await check('trunkBranch falls back to `master` when that is what exists and `main` does not', () => {
  const dir = repo('master');
  assert.equal(trunkBranch(dir), 'master');
});

await check('trunkBranch is empty when neither exists and there is no origin', () => {
  const dir = repo('some-other-name');
  assert.equal(trunkBranch(dir), '');
});

await check('rule1Verdict: on trunk is reachable', () => {
  const dir = repo('main');
  const v = rule1Verdict(dir);
  assert.equal(v.reachable, true);
  assert.equal(v.branch, 'main');
  assert.equal(v.trunk, 'main');
  assert.match(v.message, /this checkout is on `main`/);
});

await check('rule1Verdict: off trunk is not reachable, and says so', () => {
  const dir = repo('main');
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'worktree-thing']);
  const v = rule1Verdict(dir);
  assert.equal(v.reachable, false);
  assert.match(v.message, /this checkout is on `worktree-thing`, not `main`/);
  assert.match(v.message, /--artifact/);
});

await check('rule1Verdict: not a git checkout answers null, not false', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'notgit-'));
  const v = rule1Verdict(dir);
  assert.equal(v.reachable, null);
  assert.match(v.message, /not a git checkout/);
});

await check('rule1Verdict: no findable trunk answers null, not false', () => {
  const dir = repo('some-other-name');
  const v = rule1Verdict(dir);
  assert.equal(v.reachable, null);
  assert.match(v.message, /could not tell this checkout's trunk branch/);
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
