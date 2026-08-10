#!/usr/bin/env node
/**
 * Has a secret ever reached the config repo's history? — `npm run secrets`.
 *
 * Every commit is guarded (lib/commonrepo.js refuses one that carries a secret, by path
 * or by content), but a guard is a promise about the future and this is the question
 * about the past. It is the *only* honest way to ask it: `~/.config/beadcause` exists to
 * remember what `config.json` used to say, so "there is no secret in it" is worth
 * nothing unless it is asked of every commit on every ref.
 *
 * Safe to run at any time, with the daemon up — it reads and never writes. Exit 0 means
 * nothing was found; exit 1 means something was, and the fix is to **rotate that
 * credential**, not to rewrite the history: a commit cannot be honestly unmade, and the
 * one thing you can be sure of is that the old value no longer works.
 *
 *   npm run secrets
 *
 * Rotating either one is in the README under "Signing in with Google".
 */
import { CONFIG_DIR } from '../lib/config.js';
import { scanHistory } from '../lib/commonrepo.js';

const { commits, findings } = await scanHistory();

console.log(`\n${CONFIG_DIR} — ${commits} commit${commits === 1 ? '' : 's'} on every ref\n`);

if (!findings.length) {
  console.log('  \x1b[32m✓\x1b[0m no secret found in any commit');
  console.log('\nWhat was looked for: a file the denylist forbids (a signing key, a private');
  console.log('key, a client secret in a file of its own), a secret written into a committed');
  console.log('file as a field, and the literal contents of every secret file in that');
  console.log('directory — the last of which is what would catch one pasted into a chat.\n');
  process.exit(0);
}

for (const f of findings) {
  const where = f.commits.length === 1 ? f.commits[0].slice(0, 8) : `${f.commits.length} commits, newest ${f.commits[0].slice(0, 8)}`;
  console.log(`  \x1b[31m✗\x1b[0m ${f.file} — ${f.what}`);
  console.log(`      ${where}`);
}

console.log(`\n${findings.length} finding${findings.length === 1 ? '' : 's'}. Rotate what was found:`);
console.log('  · the Google client secret — regenerate it in the Google Cloud console, then');
console.log(`    write the new one to ${CONFIG_DIR}/google-client-secret.key`);
console.log(`  · the session signing key — delete ${CONFIG_DIR}/session.key (this signs`);
console.log('    every browser out) and the next backend swap makes a new one');
console.log('  · the shared token — delete `token` from config.json and re-pair every device');
console.log('\nDo not try to rewrite the history. Anything that was in it has to be assumed read.\n');
process.exit(1);
