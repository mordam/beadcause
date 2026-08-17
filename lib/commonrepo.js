/**
 * One repo every agent can reach, whichever repo it is working in.
 *
 * Tier 1 put an agent's memory on a ref inside the codebase it was about, which is
 * the right place for it and is also the reason two agents can never hear each
 * other: the beadcause advocate writes into the beadcause checkout, the sophab
 * advocate writes into sophab's, and neither ref is visible from the other side. A
 * shared place is not an optimisation of that, it is the missing half.
 *
 * `~/.config/beadcause` is already that place — it is the one directory every
 * instance of every agent on this Mac has in common, and it already holds the state
 * whose loss hurts. Making it a git repo therefore buys two things at once:
 *
 * 1. **A home for the cross-agent refs** in lib/memory.js. They ride here for the
 *    same reason session logs ride on refs elsewhere: a ref outside `refs/heads/*`
 *    and `refs/tags/*` touches no working tree, so the daemon can commit one while
 *    something else is rewriting `config.json` beside it.
 * 2. **History and recovery for the state files**, which was being done by hand —
 *    `config.json.bak-20260808` and `config.json.bak-scope` are sitting in that
 *    directory right now, made with `cp` at moments somebody was nervous. A commit
 *    after each write is the same instinct, automated, and it answers "what did this
 *    say before the advocate rewrote it" without anyone having remembered to ask.
 *
 * **The .gitignore is written before `git init`, and that ordering is not tidiness.**
 * That directory holds `android-keystore.jks` — the release signing key for the
 * Android app — and its password file beside it. A `git init && git add -A` there
 * commits a signing key into a history that is then hard to truly remove. So the
 * ignore file lands first, and `commit()` re-checks the staged list against
 * `FORBIDDEN` every single time rather than trusting that it did: an ignore rule is
 * one `git add -f` or one edited `.gitignore` away from not applying, and the cost
 * of being wrong once is a leaked key.
 *
 * Nothing here has a remote and nothing here pushes. This is local history, on a
 * repo whose contents are a token, a tailnet layout, and whatever an agent said.
 *
 * **A losable snapshot is fine, and that is deliberate.** The daemon is not the only
 * process that writes here — `bin/status.js` and `npm run configure` do too — so two
 * of them can collide on `index.lock` and one commit fails. It is logged and
 * dropped, because the state file itself is already safely on disk (lib/atomic.js
 * owns that half) and the next write's `add -A` picks up both changes anyway. The
 * cost of losing this race is one missing line of history, not one missing file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { git, gitInput, ok } from './gitref.js';

/**
 * What must never be committed, checked against the staged list at every commit.
 *
 * Deliberately matched on the path rather than on content: the point is to be
 * unmissable and to fail closed, not to be clever. Anything matching here aborts the
 * commit outright instead of being quietly unstaged — a snapshot that silently drops
 * files is a backup you find out about when you need it.
 *
 * `.secret` and `google-client-secret*` are here for the Google OAuth client secret
 * (lib/auth.js), which lands in a file whose name ends in `.key` by default — so the
 * rule that already covers the tailnet private key covers it too — but which somebody
 * may well have put in a `google.secret` beside it, because that is the name the README
 * used to suggest.
 */
const FORBIDDEN = [
  /(^|\/)[^/]*\.(jks|keystore|p12|pem|key|secret)$/i,
  /(^|\/)android-keystore\./i,
  /(^|\/)google-client-secret/i,
];

/** Is this repo-relative path one the denylist refuses? Asked by lib/auth.js too. */
export const protectedPath = (p) => FORBIDDEN.some((re) => re.test(p));

/**
 * The sentence to say about a credential file this repo would commit — or null.
 *
 * The denylist above is a *refusal*, and a refusal is the wrong answer to a file
 * somebody deliberately pointed a working integration at: aborting every snapshot
 * from then on turns a badly-named token file into a daemon that has quietly stopped
 * keeping history. So the third case — inside the directory, holding a secret, and
 * **not** matched by `FORBIDDEN` — is said out loud instead, and nothing is switched
 * off over it.
 *
 * It lives here rather than beside any one of its callers because the question is
 * this module's and only this module's: *would the config repo commit a file at this
 * path*. Three integrations ask it about a path their config lets you name — Google's
 * client secret (lib/auth.js), and the two Atlassian tokens through
 * `tokenFileWarning` in lib/atlassian.js — and when they each answered it themselves
 * they answered it differently: one against `protectedPath`, one against a hand-copied
 * `/\.(key|secret)$/` that did not know about `.pem` or `google-client-secret`. A
 * denylist with a second, weaker copy of itself is the same bug as no denylist.
 *
 * A file *outside* `CONFIG_DIR` is not this repo's business and draws nothing.
 */
export function leakWarning(file) {
  const rel = path.relative(CONFIG_DIR, String(file || ''));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (protectedPath(rel)) return null;
  return `${file} is inside the config repo and not on its denylist, so the secret in it WILL be committed — give it a name ending .key or .secret, or move it out of ${CONFIG_DIR}`;
}

/**
 * The other half of the denylist: secrets that live *inside* a file this repo commits.
 *
 * The path rules above are enough for a secret that has a file of its own, and they are
 * the whole story for the Android signing key and the tailnet private key. They are no
 * story at all for a secret written into `config.json` — which is committed on every
 * write, by design, because a history of the state files is the reason this repo exists.
 * Google sign-in brought exactly that: a `clientSecret` field, documented as the
 * convenient-and-worst place to put one, in the one file here that is guaranteed to be
 * in the history.
 *
 * So every commit greps the staged blobs as well as reading their names. Two kinds of
 * pattern, and they catch different mistakes:
 *
 * - **the field**, below — a secret sitting in a config file under a name that says what
 *   it is. Caught even when it is not a secret this machine has ever used, which is what
 *   makes it useful in a hand-edited file;
 * - **the value**, `guardedValues()` — the literal bytes of the secrets this directory
 *   already refuses by path, found wherever they turn up. That one is not paranoia: the
 *   bead consoles under `consoles/` are committed and are full of whatever was typed
 *   into a chat, and a secret pasted into a chat window is the most ordinary leak there
 *   is.
 *
 * Only the *staged* files are searched, exactly like the path check, so this is a guard
 * on what is about to be added and never a re-litigation of what is already in. That
 * matters: a check that read the whole index would, the day after a secret got in, abort
 * every commit forever over a file nobody was touching — and `scanHistory()` is the
 * right tool for that question, because the answer to it is rotation, not a refusal.
 */
const FORBIDDEN_FIELDS = [
  { re: '"clientSecret"[[:space:]]*:[[:space:]]*"[^"]', what: 'a Google OAuth client secret' },
  { re: '"sessionKey"[[:space:]]*:[[:space:]]*"[^"]', what: 'a session signing key' },
  // Slack's two tokens (lib/slack.js). They are read from `*.key` files, which the path
  // rules above already refuse — this is for the other way one gets in: a `botToken`
  // field typed into `config.json` by somebody following a Slack tutorial rather than
  // this README. `botTokenFile` does not match, and is meant not to: the *path* is the
  // thing that belongs in the config.
  //
  // Two entries rather than one alternation, deliberately: these strings are handed to
  // `git grep -E`, and a rule that quietly matches nothing is a guard that reports
  // success on the day it is needed. The shape above is the one that has been proven
  // here, so it is the shape both of these use.
  { re: '"botToken"[[:space:]]*:[[:space:]]*"[^"]', what: 'a Slack bot token' },
  { re: '"appToken"[[:space:]]*:[[:space:]]*"[^"]', what: 'a Slack app-level token' },
];

/**
 * The ignore file, written before the repo exists.
 *
 * Every line here is something that is either dangerous (the signing key), large and
 * regenerated (the check PNGs are 150–260KB each and are rewritten by every
 * `phone-check` run), or pure churn — `status.json` is rewritten every few seconds by
 * lib/activity.js and a history of it would be noise deep enough to hide the state
 * changes that matter.
 */
const GITIGNORE = `# Written by lib/commonrepo.js before this directory became a repo.
#
# The first block is the one that matters: android-keystore.jks is the release
# signing key for the Android app, and a key committed once is in the history
# forever. lib/commonrepo.js re-checks the staged list at every commit, so editing
# this file is not enough to get one in — but do not test that.
android-keystore.jks
android-keystore.properties
*.jks
*.keystore
*.p12
*.pem

# The tailnet certificate and its private key (lib/tls.js). Fetched by \`tailscale
# cert\`, re-fetchable at any time, and the key is matched by FORBIDDEN — so an
# un-ignored one does not leak, it aborts every snapshot from then on.
tls/
*.key
*.crt

# Google sign-in's client secret (lib/auth.js). It lives in a file ending \`.key\` —
# \`google-client-secret.key\` unless you named another — so the rule above already
# covers it; \`*.secret\` is here because an earlier README suggested \`google.secret\`.
*.secret
google-client-secret*

# Check output: regenerated by scripts/phone-check.mjs and scripts/console-check.mjs,
# 150-260KB a piece, and never the thing you want the history of.
*.png

# Churn. status.json is rewritten every few seconds by lib/activity.js; logs/ is the
# streamed output of every agent run; workers/ is scratch. restart.json is one line the
# router overwrites on every blue/green handover (lib/deploy.js) and it expires thirty
# seconds later — unlike deploys/, which is a record of things somebody pressed Ship on
# and is worth the history. handovers.json is the longer form of the same thing
# (lib/handover.js): the last twenty handovers, rewritten whole every time one happens, so
# a commit per swap would be the same twenty rows written twenty times over. What shipped
# is still deploys/. merge-sweeps.json is the same shape as restart.json: a merge
# writes one line saying which repo to sweep for conflicts and the next poll cycle takes
# it (lib/mergesweep.js), so it is empty within thirty seconds and what it recorded is
# already on the pull request it merged. sweep-cards.json is the follow-up half of that
# one — the rows of the inbox card a sweep filed, chased until every resolver has finished
# and then deleted (lib/sweepcard.js). It is bookkeeping about a bead, and the bead is
# where the history of it actually lives. coverage.json is what \`npm run coverage\`
# publishes (lib/coverage.js): a few hundred kilobytes rewritten whole by each
# measurement, and meaningless against any commit but the one stamped inside it — so a
# history of it would be a large diff per run saying nothing the run did not print.
status.json
restart.json
handovers.json
merge-sweeps.json
sweep-cards.json
coverage.json
logs/
workers/

# Tier 3 (lib/agentrepo.js): one git repo per agent, per workspace, that the *agent*
# owns. This rule is load-bearing rather than tidy. \`commit()\` below runs \`git add -A\`,
# and a nested repo is only skipped once it has a \`.git\` of its own — so the window
# between \`mkdir\` and \`git init\`, or any tree an init failed halfway through, would put
# an agent's private files straight into this shared history. Which is the exact
# opposite of the thing being built. usage.jsonl lives here too and is beadcause's
# measurement of the experiment, not the agent's memory; it is ignored for the same
# reason, being about what is in those repos.
agents/

# The atomic writer's temp files, in the window before the rename.
.*.tmp-*
`;

/** Where it lives. A function, not a constant: see the import cycle note in `snapshot`. */
const dir = () => CONFIG_DIR;

/** Is this directory already a repo? Cheap, and the answer is usually yes. */
async function initialised() {
  const out = await ok(git(dir(), ['rev-parse', '--git-dir']));
  return Boolean(out);
}

/**
 * Add any rule this file has gained since that directory became a repo.
 *
 * The ignore file was written once, before `git init`, and never looked at again — so
 * until now every rule added to `GITIGNORE` afterwards protected fresh installs only.
 * That was survivable while the list was static, and stopped being survivable the
 * moment `tls/` joined it: the private key underneath is matched by `FORBIDDEN`, so an
 * install with a stale ignore file does not leak the key — it refuses every commit from
 * then on, and a history that has quietly stopped is exactly what this repo exists to
 * prevent.
 *
 * Appended, never rewritten: the file is yours to edit, and a rule you added by hand
 * must survive an upgrade. Only non-comment lines are compared, so the commentary here
 * can be reworded without every install growing a copy of it.
 */
function topUpIgnore(file) {
  const rules = (text) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  let current;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const have = new Set(rules(current));
  const missing = rules(GITIGNORE).filter((rule) => !have.has(rule));
  if (!missing.length) return;
  fs.appendFileSync(file, `\n# Added by lib/commonrepo.js — rules this file predates.\n${missing.join('\n')}\n`);
  console.log(`[beadcause] common repo: ignoring ${missing.join(' ')} — added to ${file}`);
}

/**
 * Make the common repo exist, and return where it is.
 *
 * Idempotent and safe to call on every write — the check is one `rev-parse` against
 * a directory that is already warm. `--initial-branch=main` because git otherwise
 * prints a paragraph about `master` to stderr on every init, and the branch name is
 * never seen by anyone here anyway.
 */
export async function ensureRepo() {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const ignore = path.join(d, '.gitignore');
  // Before the init, always: see the note at the top of the file.
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, GITIGNORE, { mode: 0o600 });
  else topUpIgnore(ignore);
  if (!(await initialised())) {
    await git(d, ['init', '--initial-branch=main', '-q']);
  }
  return d;
}

/** Everything git would commit right now, as repo-relative paths. */
async function staged(d) {
  const out = await git(d, ['diff', '--cached', '--name-only']);
  return out.split('\n').filter(Boolean);
}

/**
 * The literal secrets sitting in this directory, as `{ name, value }`.
 *
 * Read straight off the disk rather than passed in, and that is what keeps the layering
 * the right way up: this file already knows which *names* it refuses, so asking it to
 * also refuse their *contents* adds no new knowledge and no import. A `clientSecretFile`
 * pointed somewhere else entirely is therefore not covered here — lib/auth.js warns
 * about that case instead, because only it knows where the config says to look.
 *
 * The filters are what stop this being noise. A value has to be one printable line of at
 * least 16 characters to be searched for: `android-keystore.jks` is binary, its
 * `.properties` neighbour is several lines of `key=value`, and a short or empty file
 * would match half the repo. Both of those are refused by path anyway.
 */
function guardedValues() {
  let names = [];
  try {
    names = fs.readdirSync(dir(), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter(protectedPath)) {
    let text;
    try {
      const file = path.join(dir(), name);
      if (fs.statSync(file).size > 4096) continue;
      text = fs.readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    if (text.length < 16 || text.length > 512) continue;
    if (!/^[\x21-\x7e]+$/.test(text)) continue;
    out.push({ name, value: text });
  }
  return out;
}

/**
 * Anything staged whose *contents* carry a secret, as `<file> — <what it is>`.
 *
 * Every pattern goes to `git grep` on **stdin** (`-f -`) rather than in an argument, and
 * that is not style: half of what is searched for here is a live secret, and an argument
 * is visible in `ps` to anything else on the machine for as long as the command runs.
 * `-I` leaves binary files alone, and the pathspecs are `:(literal)` because these paths
 * came out of git and must not be re-read as globs.
 */
async function contentOffences(d, files) {
  const within = files.map((f) => `:(literal)${f}`);
  const grep = async (mode, pattern) => {
    const out = await ok(
      gitInput(d, ['grep', '--cached', '-I', '-l', mode, '-f', '-', '--', ...within], `${pattern}\n`)
    );
    return out ? out.split('\n').filter(Boolean) : [];
  };
  const found = [];
  for (const rule of FORBIDDEN_FIELDS) {
    for (const file of await grep('-E', rule.re)) found.push(`${file} — ${rule.what}`);
  }
  for (const { name, value } of guardedValues()) {
    for (const file of await grep('-F', value)) found.push(`${file} — the contents of ${name}`);
  }
  return found;
}

/**
 * Commit whatever has changed, refusing outright if a secret got staged.
 *
 * Returns the new commit's sha, or null when there was nothing to commit — which is
 * the common case, because this is called after writes that often rewrite a file
 * with identical bytes.
 */
export async function commit(reason = 'state') {
  const d = await ensureRepo();
  await git(d, ['add', '-A']);
  const files = await staged(d);
  if (!files.length) return null;

  // Unstage before throwing, in both cases below: leaving a signing key sitting in the
  // index means the next commit from anywhere — a human running `git commit` in that
  // directory to see what this thing does — picks it up.
  const forbidden = files.filter(protectedPath);
  if (forbidden.length) {
    await ok(git(d, ['reset', '-q']));
    throw new Error(`refusing to commit ${forbidden.join(', ')} — see FORBIDDEN in lib/commonrepo.js`);
  }

  const leaking = await contentOffences(d, files);
  if (leaking.length) {
    await ok(git(d, ['reset', '-q']));
    throw new Error(
      `refusing to commit a secret inside ${leaking.join('; ')} — take it out of the file ` +
        `(see FORBIDDEN_FIELDS in lib/commonrepo.js); snapshots resume once it is gone`
    );
  }

  await git(d, ['commit', '-q', '-m', reason]);
  return (await git(d, ['rev-parse', 'HEAD'])).trim();
}

/* --------------------------------------------------- the debounced snapshot */

/**
 * State is written in bursts, so committing per write would be mostly empty commits.
 *
 * A single advocate cycle rewrites `advocates.json` three or four times in a second
 * — cooldown, attempt count, last proposal. Those are one event to a human reading
 * the history back, and eight commits' worth of `git log` to scroll past. So a write
 * *schedules* a commit and the reasons accumulate; the commit that lands names all
 * of them.
 *
 * `unref()` on the timer matters: without it a scheduled snapshot keeps the process
 * alive, which turns every short-lived CLI in bin/ into something that hangs for two
 * seconds at exit for no reason the user can see.
 */
let timer = null;
let reasons = new Set();
let inFlight = null;

export function snapshot(reason = 'state', { delayMs = 2000 } = {}) {
  reasons.add(reason);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const message = [...reasons].sort().join(', ');
    reasons = new Set();
    inFlight = commit(message).catch((err) => {
      // A snapshot that cannot be taken must never break the write it was taken of.
      // The state file is already safely on disk — this is the history, not the data.
      console.error(`[beadcause] common repo snapshot failed: ${err.message.split('\n')[0]}`);
      return null;
    });
  }, delayMs);
  timer.unref?.();
}

/**
 * Take any pending snapshot now and wait for it. For tests and for shutdown, where
 * "in two seconds" is after the process is gone.
 *
 * **The pending commit is chained onto the running one, not started beside it.** Both
 * states are reachable at once — the timer fires, its commit is a few git subprocesses
 * long, and a write during that window schedules another — and the old code overwrote
 * `inFlight` with the new commit and returned only that. Two ways that was wrong, and the
 * second is worse than the first: `flush` resolved while the earlier commit was still
 * running, so "the repo is quiet now" was not true (test/helpers/tmp.mjs removes a
 * directory on the strength of it, and bc-5uy8 is what that costs); and two `commit()`
 * calls overlapping on one repo race each other's index, which is `git add -A` twice over
 * and `index.lock` already exists. Sequencing them costs nothing here, since `flush` is
 * only called where waiting is the entire point.
 */
export async function flush() {
  const running = inFlight;
  if (timer) {
    clearTimeout(timer);
    timer = null;
    const message = [...reasons].sort().join(', ');
    reasons = new Set();
    inFlight = Promise.resolve(running)
      .catch(() => null)
      .then(() => commit(message));
  }
  const p = inFlight;
  inFlight = null;
  return p ? p.catch(() => null) : null;
}

/* ------------------------------------------------------------- the audit */

/**
 * Has a secret ever been in this history at all? — `npm run secrets`.
 *
 * The commit guard is a promise about every commit *from now on*, and a promise is not
 * an answer. This is the answer: every reachable commit on every ref, checked for the
 * same two things `commit()` refuses, because "it is not in the working tree" is worth
 * nothing about a repo whose whole purpose is to keep what the working tree used to say.
 *
 * Both halves need the whole graph rather than the tip. The path check walks `git log
 * --all --name-only`, so a file added and deleted again is still found — deleting it is
 * exactly what somebody does on noticing, and it is exactly what does not help. The
 * content check greps the file *at every revision*, in batches, because an argument list
 * of one sha per commit would eventually be longer than the kernel will take.
 *
 * Findings are grouped by what and where, with the commits listed, because a secret that
 * survived thirty rewrites of `config.json` is one mistake and not thirty. An empty
 * `findings` is the only clean result; anything in it means rotating that credential,
 * since a commit cannot be honestly unmade in a repo somebody may already have cloned.
 */
export async function scanHistory({ batch = 400 } = {}) {
  const d = dir();
  const revs = ((await ok(git(d, ['rev-list', '--all']))) || '').split('\n').filter(Boolean);
  const groups = new Map();
  const note = (kind, what, file, sha) => {
    const key = `${kind}\0${what}\0${file}`;
    if (!groups.has(key)) groups.set(key, { kind, what, file, commits: [] });
    groups.get(key).commits.push(sha);
  };

  // `%x00%H` so a commit line can never be mistaken for a file name — a path may
  // legitimately look like a sha, and `--name-only` gives no other marker.
  const log = (await ok(git(d, ['log', '--all', '--format=%x00%H', '--name-only']))) || '';
  let sha = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('\0')) {
      sha = line.slice(1);
      continue;
    }
    const file = line.trim();
    if (file && protectedPath(file)) note('path', 'a file the denylist forbids', file, sha);
  }

  const patterns = [
    ...FORBIDDEN_FIELDS.map((rule) => ({ mode: '-E', pattern: rule.re, what: rule.what })),
    ...guardedValues().map((s) => ({ mode: '-F', pattern: s.value, what: `the contents of ${s.name}` })),
  ];
  for (let i = 0; i < revs.length; i += batch) {
    const chunk = revs.slice(i, i + batch);
    for (const { mode, pattern, what } of patterns) {
      const out = await ok(gitInput(d, ['grep', '-I', '-l', mode, '-f', '-', ...chunk], `${pattern}\n`));
      for (const line of (out || '').split('\n').filter(Boolean)) {
        // `<rev>:<path>`, and the path is what may contain a colon, so split once.
        const at = line.indexOf(':');
        if (at > 0) note('content', what, line.slice(at + 1), line.slice(0, at));
      }
    }
  }

  return { commits: revs.length, findings: [...groups.values()] };
}

/**
 * The history of the state files, newest first — `git log` for someone who is not
 * standing in that directory.
 */
export async function history({ limit = 50 } = {}) {
  const log = await ok(git(dir(), ['log', `--max-count=${limit}`, '--format=%H%x00%aI%x00%s']));
  if (!log) return [];
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, at, subject] = line.split('\0');
      return { commit, at, subject };
    });
}
