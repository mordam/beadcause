/**
 * Whose beadcause this is — the one name the app says out loud.
 *
 * Every unattended agent is told about a person: who is not at the keyboard, who
 * approves a bead before it exists, who a pull request is waiting on, whose "no" is
 * already recorded. That person used to be spelled `Adam` as a literal in nine
 * files, which made every one of those sentences a lie on any other machine — and
 * worse than a lie in the agent prompts, where a model given a stranger's name has
 * no way to tell that the name is the mistake.
 *
 * So there is exactly one string, `owner` in config.json, and this module is how
 * anything reaches it:
 *
 * - `ownerName(cfg)` where a config is already in hand — every daemon path, since
 *   the server, the advocate and the console all carry one.
 * - `ownerName()` where one is not, which is a CLI or a module-level prompt
 *   fragment. It reads the file itself rather than calling `loadConfig`, because
 *   `loadConfig` reconciles workspaces and may write, and building a prompt must
 *   never have that as a side effect.
 *
 * `detectOwner()` is the fallback and the installer's default. Nothing here ever
 * returns an empty string: a prompt with a hole where the name goes reads as a
 * template that failed, and an agent will say so instead of doing the work.
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
// Circular and safe, exactly as lib/commonrepo.js is: config.js calls `detectOwner`
// only from `defaults()`, and this file reads `CONFIG_PATH` only inside a function,
// so neither half needs the other to have finished evaluating. The alternative — a
// second copy of the `~/.config/beadcause` path — is the one that goes wrong quietly
// when BEADCAUSE_CONFIG_DIR is set.
import { CONFIG_PATH } from './config.js';

/** When there is no config, no git identity and no full name on the account. */
export const OWNER_FALLBACK = 'the owner';

let detected = null;

/**
 * A first guess at what to call whoever is installing this.
 *
 * Git first, because `user.name` is a name a person chose to have their own work
 * attributed under, and it is the same name the commits an agent makes will carry.
 * Then the account's full name (macOS keeps one, and `id -F` is the only reliable
 * way to it), then the login name, which is at least theirs.
 *
 * Trimmed to the first word on purpose. The value is used inline in prose an agent
 * reads — "Morgan Adams is not at the keyboard" is fine, "Adam" is what a person
 * would have written — and the installer shows this as an editable default, so a
 * mononym, a nickname or a full name are all one keystroke away.
 *
 * Cached: it spawns processes, and prompts are built on a hot path often enough
 * that doing it per prompt would be visible in the log.
 */
export function detectOwner() {
  if (detected !== null) return detected;
  detected = firstWord(gitUserName()) || firstWord(accountFullName()) || loginName() || OWNER_FALLBACK;
  return detected;
}

/**
 * The configured name, or the detected one.
 *
 * `cfg` wins when it has an `owner`; a config that is loaded but has none is a
 * config written before this setting existed, so it detects rather than reading the
 * file back for a key that is not in it.
 */
export function ownerName(cfg = null) {
  const named = clean(cfg?.owner);
  if (named) return named;
  if (cfg) return detectOwner();
  return fromDisk() || detectOwner();
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const firstWord = (s) => clean(s).split(' ')[0] || '';

/** The config file, read directly and never written. Absent is the ordinary case. */
function fromDisk() {
  try {
    return clean(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).owner);
  } catch {
    return '';
  }
}

function gitUserName() {
  try {
    return execFileSync('git', ['config', '--get', 'user.name'], { encoding: 'utf8', timeout: 3000 });
  } catch {
    return '';
  }
}

function accountFullName() {
  try {
    // `id -F` is macOS-only and this installer is macOS-only; elsewhere it exits
    // non-zero and the login name below is what answers.
    return execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8', timeout: 3000 });
  } catch {
    return '';
  }
}

function loginName() {
  try {
    return firstWord(os.userInfo().username);
  } catch {
    return '';
  }
}
