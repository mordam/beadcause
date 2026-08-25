/**
 * Every third party beadcause sends anything to, and what leaves for each one.
 *
 * The auditable question about a supplier is always the same four: **what is sent, why,
 * under what terms, and when was that last looked at.** Until this file existed the only
 * way to answer any of them was to read `lib/notify.js`, `lib/confluence.js`,
 * `lib/atlassian.js`, `lib/auth.js`, `lib/slack.js` and `lib/team.js` and add it up — and
 * the answer you got that way was a snapshot of the day you did it, with no way to tell
 * whether an eighth supplier had arrived since.
 *
 * **The register is the boring half. The enforcement is the point.**
 * `scripts/secret-scan.mjs` is the precedent and it makes the argument: a guard is a
 * promise about the future, and the honest question is the one asked of what is already
 * there. So this sweeps `lib/` and `bin/` for outbound hosts and for the commands that
 * are actually executed, and fails the repo on one no supplier claims. A new integration
 * then cannot ship without its supplier entry, which is the control *operating* rather
 * than being described.
 *
 * ## Anthropic is not a host, and that is the finding that shaped this file
 *
 * A sweep for `https://` finds Google, GitHub, Tailscale, ntfy, Slack and Atlassian, and
 * it does not find Anthropic — because nothing here ever calls an Anthropic URL. Every
 * agent is a `claude -p` subprocess, so the largest egress in the system by a wide margin
 * is a **command**, not a URL, and a URL-only sweep would have reported a clean tree while
 * prompt content, bead text, whole source files and the occasional screenshot left the
 * machine. Hence two axes rather than one, and hence `commandsIn` matching execution
 * shapes rather than words: this repo writes prose inside template literals, so a sweep
 * for the bare word `claude` finds the paragraph explaining what a session is.
 *
 * ## What this deliberately cannot see, which is a shorter list than it was
 *
 * - **A binary resolved through a variable.** `lib/bd.js` and `lib/tailnet.js` execute a
 *   path they computed, so there is no literal for the scan to find. Both are registered
 *   anyway, by hand — which is why a declared command is *not* required to appear in the
 *   source, while an executed one is required to be declared. The enforcement runs in the
 *   direction that catches a new supplier, and the direction that would catch a stale
 *   entry is left to the review date.
 * - **An interpolated host.** `https://${site}.atlassian.net` has no static text, so it is
 *   skipped for exactly the reason `lib/checkaudit.js` skips an interpolated selector.
 *   Suppliers reached at a hostname the operator configures are registered as a suffix
 *   pattern (`*.atlassian.net`) instead.
 * - **`test/` and `scripts/`.** Both are full of fixture hostnames — `evil.example`,
 *   `100.96.105.106`, `climative.atlassian.net` — and sweeping them in would mean either
 *   registering fixtures as suppliers or an exemption list longer than the register. The
 *   same call `lib/evidence.js` makes about `scripts/`, for the same reason.
 *
 * ## Why every entry says its terms are unconfirmed
 *
 * Because they are, and the register's whole value is that it does not round that up.
 * What each entry states from the code — what is sent, by which module, and why — is
 * verifiable here and is most of what an auditor wants. What it cannot state from the code
 * is the retention and training terms *in force*, which depend on which account and which
 * plan the traffic runs under and which change without telling anybody. So
 * `termsConfirmedOn` is `null` on every entry today and each carries a `gap` naming
 * `bc-eqn1.17`, which is where the agreements get read and transcribed, supplier by
 * supplier. A register that guessed would read exactly the same and be worse than nothing
 * — `bc-eqn1.9` says so in as many words about Anthropic specifically.
 *
 * A leaf, like `lib/evidence.js`, but for `lib/documents.js`: the review dates here are
 * `reviewStatus` from that file rather than a second date implementation beside it, and
 * this register is itself the first entry in that one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { blankComments } from './evidence.js';
import { MAX_REVIEW_MONTHS, parseDate, reviewStatus } from './documents.js';

/** Where a supplier can be reached from. `scripts/` and `test/` are fixtures; see above. */
export const SCAN_DIRS = Object.freeze(['lib', 'bin']);

/* -------------------------------------------------------------- the register */

/**
 * Every supplier, in the order of how much of the system depends on it.
 *
 * `sends` is the data categories, one string each, written as what an auditor would call
 * them rather than as field names. `reachedBy` is the modules that do the reaching, and it
 * is checked to still exist — a supplier reached by a file that has been deleted is either
 * a supplier that has gone or a rename nobody carried through here.
 */
export const REGISTER = Object.freeze([
  {
    id: 'anthropic',
    name: 'Anthropic (Claude, via the Claude Code CLI)',
    purpose:
      'Every agent in the system. The advocate opens worker windows, a comment dispatches a reply, the chat session ' +
      'answers a phone, and a JIRA ticket is ingested — all four are a `claude -p` subprocess, and there is no other model.',
    sends: Object.freeze([
      'prompt text, including the whole of a generated brief',
      'bead titles, descriptions, comments and answers',
      'the contents of any repository file an agent reads, and the output of any command it runs',
      'screenshots, when a session takes one',
      'the paths and names of repositories and worktrees on this Mac',
    ]),
    hosts: Object.freeze([]),
    commands: Object.freeze(['claude']),
    reachedBy: Object.freeze(['lib/advocate.js', 'lib/console.js', 'lib/dispatch.js', 'lib/jiraingest.js']),
    terms:
      'Claude Code is signed in with an OAuth Claude account rather than an API key, so what governs it is the terms ' +
      'attached to that subscription rather than the commercial API agreement. Which of the two is in force is a fact ' +
      'about the account, not about this repo, and it is the single most consequential unconfirmed line in this register.',
    termsUrl: 'https://www.anthropic.com/legal',
    termsConfirmedOn: null,
    retention: 'Unconfirmed. Conversation retention is set by the account and by Anthropic\'s retention schedule, neither of which this repo can read.',
    training: 'Unconfirmed, and the answer differs between a consumer subscription and the commercial terms. Nothing here opts in or out on the account\'s behalf.',
    reviewedOn: '2026-08-15',
    reviewMonths: 6,
    gap: Object.freeze({
      bead: 'bc-eqn1.17',
      says:
        'The retention and training terms in force have not been read against the account these sessions run under. ' +
        'Everything above about what is sent is from the code and is verifiable; the two lines about what Anthropic then does with it are not.',
    }),
  },
  {
    id: 'github',
    name: 'GitHub',
    purpose:
      'Where the code, the pull requests and the shared tracker live. Branches are pushed, pull requests opened and ' +
      'read back, and the Dolt issue database rides a ref in a private repository.',
    sends: Object.freeze([
      'repository source, branches and commit history',
      'pull request titles, bodies and review comments, which quote bead text',
      'the whole issue graph of a shared workspace, as Dolt data on a git ref',
    ]),
    hosts: Object.freeze(['github.com']),
    commands: Object.freeze(['gh', 'git', 'bd']),
    reachedBy: Object.freeze(['lib/pr.js', 'lib/changegather.js', 'lib/lookup.js', 'lib/team.js', 'lib/bd.js']),
    terms:
      'The GitHub Terms of Service as they apply to a private repository in the organisation that owns it. Nothing here ' +
      'makes a repository public, and the contentless-push argument does not apply: this is the repository itself.',
    termsUrl: 'https://docs.github.com/site-policy/github-terms/github-terms-of-service',
    termsConfirmedOn: null,
    retention: 'Unconfirmed. A pushed commit must be assumed permanent and readable by anybody with access to the repository.',
    training: 'Unconfirmed against the plan in force.',
    reviewedOn: '2026-08-15',
    reviewMonths: 12,
    gap: Object.freeze({
      bead: 'bc-eqn1.17',
      says: 'The plan in force and what it says about private repository content have not been read and transcribed.',
    }),
  },
  {
    id: 'atlassian',
    name: 'Atlassian (JIRA and Confluence)',
    purpose:
      'JIRA is read for the tickets assigned to you and is never written to. Confluence is written to: a document ' +
      'published from here becomes a page in a space somebody chose.',
    sends: Object.freeze([
      'an API token and the email address it belongs to, on every request',
      'the full text of any document published to a space, which is composed from bead content',
      'nothing at all in the JIRA direction — that integration reads and may never write',
    ]),
    hosts: Object.freeze(['*.atlassian.net']),
    commands: Object.freeze([]),
    reachedBy: Object.freeze(['lib/atlassian.js', 'lib/jira.js', 'lib/confluence.js', 'lib/confluencesetup.js']),
    terms:
      'The Atlassian Cloud Terms of Service as they apply to the site the token belongs to, which is the customer\'s ' +
      'own instance rather than one this repo administers. The hostname is per-install, which is why it is a pattern here.',
    termsUrl: 'https://www.atlassian.com/legal/cloud-terms-of-service',
    termsConfirmedOn: null,
    retention: 'Unconfirmed, and it is the site owner\'s decision rather than Atlassian\'s — a published page is retained until somebody deletes it.',
    training: 'Unconfirmed against the site\'s own settings.',
    reviewedOn: '2026-08-15',
    reviewMonths: 12,
    gap: Object.freeze({
      bead: 'bc-eqn1.17',
      says: 'Whose site the token belongs to, and that site\'s retention settings, have not been recorded here.',
    }),
  },
  {
    id: 'google',
    name: 'Google (sign-in)',
    purpose: 'Signing a browser in. Nothing else here touches Google, and no content is ever sent to it.',
    sends: Object.freeze([
      'the OAuth client id and secret, and the authorisation code being exchanged',
      'nothing about beads, prompts, repositories or files — the transaction is identity and ends there',
    ]),
    hosts: Object.freeze(['accounts.google.com', 'oauth2.googleapis.com']),
    commands: Object.freeze([]),
    reachedBy: Object.freeze(['lib/auth.js']),
    terms: 'Google\'s OAuth 2.0 policies as they apply to the client registered in the operator\'s own Google Cloud project.',
    termsUrl: 'https://developers.google.com/terms/api-services-user-data-policy',
    termsConfirmedOn: null,
    retention: 'Unconfirmed. What Google keeps of a sign-in is a Google decision; this install keeps only a signed session cookie.',
    training: 'Not applicable — no content is sent, so there is nothing to train on. Recorded rather than left blank because a blank reads as unasked.',
    reviewedOn: '2026-08-15',
    reviewMonths: 12,
    gap: Object.freeze({
      bead: 'bc-eqn1.17',
      says: 'The user-data policy has not been read against the scopes this client actually requests.',
    }),
  },
  {
    id: 'tailscale',
    name: 'Tailscale',
    purpose:
      'The private network the phone reaches this Mac over, and the name the certificate is issued for. It is how the ' +
      'app is reachable at all without anything being exposed to the internet.',
    sends: Object.freeze([
      'device identity, the tailnet name and coordination metadata',
      'a certificate request for this machine\'s tailnet hostname',
      'no request or response content — traffic between devices is end-to-end encrypted and does not transit Tailscale',
    ]),
    hosts: Object.freeze(['login.tailscale.com']),
    commands: Object.freeze(['tailscale']),
    reachedBy: Object.freeze(['lib/tls.js', 'lib/tailnet.js', 'lib/notify.js']),
    terms: 'Tailscale\'s terms as they apply to the tailnet this Mac belongs to. The architectural claim above is the one that matters and it is checkable.',
    termsUrl: 'https://tailscale.com/terms',
    termsConfirmedOn: null,
    retention: 'Unconfirmed. Coordination and audit logs are kept by Tailscale on a schedule this repo has not recorded.',
    training: 'Not applicable — no content reaches it.',
    reviewedOn: '2026-08-15',
    reviewMonths: 12,
    gap: Object.freeze({
      bead: 'bc-eqn1.17',
      says: 'The log retention schedule has not been read and written down.',
    }),
  },
  {
    id: 'ntfy',
    name: 'ntfy',
    purpose:
      'Push notification to a phone that is not on the tailnet, or is asleep. The one supplier in this list that is a ' +
      'public relay by default, which is why what is sent to it is deliberately thin.',
    sends: Object.freeze([
      'a notification title and body, which by default names a bead and quotes a line of it',
      'a URL back into this install',
      'nothing in a `minimal` space, where the nudge is a tap-through with no question text in it',
    ]),
    hosts: Object.freeze(['ntfy.sh']),
    commands: Object.freeze([]),
    reachedBy: Object.freeze(['lib/notify.js', 'lib/config.js']),
    terms:
      'ntfy.sh is a public relay operated by a third party, and a topic is a shared secret rather than an account. ' +
      'The honest description of the trust boundary is that anybody who learns the topic name receives the messages.',
    termsUrl: 'https://ntfy.sh/docs/privacy/',
    termsConfirmedOn: null,
    retention: 'Unconfirmed. The public server caches messages for a period this repo has not recorded, and a self-hosted server changes the answer entirely.',
    training: 'Not applicable — it is a relay, not a model.',
    reviewedOn: '2026-08-15',
    reviewMonths: 6,
    gap: Object.freeze({
      bead: 'bc-eqn1.17',
      says: 'The cache window on the public server has not been recorded, and it is the number that decides how much a notification may say.',
    }),
  },
  {
    id: 'slack',
    name: 'Slack',
    purpose: 'The same decision, in a channel — a question posted where a team can answer it instead of only on a phone.',
    sends: Object.freeze([
      'the question text, its options and the answer that was chosen',
      'a bot token, on every request',
    ]),
    hosts: Object.freeze(['slack.com']),
    commands: Object.freeze([]),
    reachedBy: Object.freeze(['lib/slack.js', 'lib/config.js']),
    terms: 'Slack\'s customer terms as they apply to the workspace the bot token belongs to, which the operator does not necessarily administer.',
    termsUrl: 'https://slack.com/terms-of-service',
    termsConfirmedOn: null,
    retention: 'Unconfirmed, and it is the workspace\'s retention setting rather than Slack\'s — a posted question stays until that setting removes it.',
    training: 'Unconfirmed against the workspace\'s plan.',
    reviewedOn: '2026-08-15',
    reviewMonths: 12,
    gap: Object.freeze({
      bead: 'bc-eqn1.17',
      says: 'Which workspace the token belongs to, and its retention setting, have not been recorded.',
    }),
  },
]);

/**
 * What the sweep finds that is not egress, and why each one is not.
 *
 * Not a waiver list — the other half of the same inventory, which is the rule
 * `lib/evidence.js` sets for `NOT_EVIDENCE`. Each entry has to say why the thing it names
 * does not reach a third party, and each is checked to still be found: an exemption for
 * something that has left the tree is a sentence excusing nothing, and it is the way a
 * list like this quietly stops describing the repo.
 */
export const NOT_EGRESS = Object.freeze([
  {
    what: 'localhost',
    kind: 'host',
    why: 'this machine, talking to its own backend through the router. Never leaves the loopback interface.',
  },
  {
    what: '127.0.0.1',
    kind: 'host',
    why: 'the same thing written as an address — the monitor and the browse guard both name it literally.',
  },
  {
    what: 'www.w3.org',
    kind: 'host',
    why:
      'the SVG XML namespace in lib/qr.js. It is a URI used as an identifier and nothing fetches it; a namespace that ' +
      'resolved to a real request would be a bug in every SVG ever written.',
  },
  {
    what: 'tar',
    kind: 'command',
    why:
      'lib/premerge.js unpacks a `git archive` stream into a scratch directory for `--tree`, and lib/prtree.js pipes ' +
      "`git archive`'s own stdout into it to unpack a pull request's tree on disk. Both read only what `git archive` " +
      'hands them on stdin and write only under a directory they have already resolved and asserted contained, under ' +
      "os.tmpdir() (see lib/evidence.js's entry for lib/prtree.js) — no socket, no network option is ever passed, and " +
      'nothing about extracting an archive onto local disk can reach a third party.',
  },
  {
    what: 'python3',
    kind: 'command',
    why:
      "lib/checks.js runs a workspace repo's own gate scripts (`scripts/check_*.py`) — argv is always the script's " +
      "own repo-relative path plus '.' and, for `studio_status.py`, `--json`; nothing beadcause constructs ever " +
      'passes a network-capable flag. What a specific check script then does is that checked-out repo\'s own code, ' +
      "the same trust boundary already crossed running `bd`/`git` inside it, or running THIS repo's own `test/*.mjs` " +
      "via `node` — invisible to this sweep only because `node` is invoked through `process.execPath`, a resolved " +
      "path rather than a literal, the blind spot this file's own header already names. `test/b7echecks.mjs` proves " +
      "the argv shape directly: every check this runs is executed as `python3 <script> .`, one process per script, " +
      'exit code read from that one process alone — never through a shell string a network call could be smuggled ' +
      'into.',
  },
]);

/**
 * Commands that are the operating system rather than a supplier.
 *
 * An absolute path into the system\'s own binary directories is macOS itself: `/bin/zsh`
 * runs a shell, `/usr/bin/osascript` drives iTerm, `/usr/bin/id` asks who you are. Naming
 * the eight of them one at a time in `NOT_EGRESS` would be eight sentences saying "macOS",
 * which is the failure `lib/evidence.js` warns about when it keeps `scripts/` out of its
 * own scan — so this is structural instead, and argued here rather than repeated there.
 *
 * `NEVER_LOCAL` is what stops that being a hole. A path is exempt because of where it
 * lives, and `/usr/bin/curl` lives in exactly the same place as `/usr/bin/id` while doing
 * something entirely different. So a binary whose *name* is one of these is egress no
 * matter what directory it was found in, and the exemption never reaches it.
 */
const SYSTEM_BINARY = /^\/(?:usr\/)?s?bin\//;
export const NEVER_LOCAL = Object.freeze(['curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet', 'openssl']);

/* ------------------------------------------------------- reading this repo */

/**
 * Every outbound host named literally in this source.
 *
 * Comments are blanked first — every file in this repo argues in prose that names the
 * hosts around it, and a sweep that skipped that step would find `api.anthropic.com` in
 * the paragraph explaining that nothing here calls it. An interpolated host yields no
 * static text and is dropped, which is the same choice and the same limit `checkaudit`
 * takes on an interpolated selector; a fragment left over from one (`api.` in
 * `https://api.${d}`) has no dot once its trailing one is trimmed and falls out here.
 */
export function hostsIn(source) {
  const code = blankComments(source);
  const found = new Set();
  for (const m of code.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
    const host = m[1].replace(/\.+$/, '').toLowerCase();
    if (!host) continue;
    if (!host.includes('.') && host !== 'localhost') continue;
    found.add(host);
  }
  return [...found].sort();
}

/**
 * Every command this source actually executes, by the shape of the execution.
 *
 * Two shapes, and both are needed. `spawn`/`execFile`/`exec` with a literal first argument
 * is how most of them run. `exec <name>` inside a string is how an agent runs: the command
 * handed to a shell in an iTerm window is built as text, and `exec claude -p …` is the only
 * place in the repo where the largest supplier in the system appears at all.
 *
 * A bare word is deliberately *not* a shape. Matching the token `claude` finds it in
 * fifteen files, almost all of them prose inside a template literal explaining what a
 * session is, and a check whose findings are mostly documentation is a check that gets an
 * exemption list instead of being read.
 *
 * `exec(` and `execSync(` are left out of the call shapes on purpose, and it is not an
 * oversight: nothing in `lib/` or `bin/` uses either, while `RegExp.prototype.exec` is
 * everywhere — so including them would buy nothing and would report `/re/.exec('literal')`
 * as a subprocess called `literal` the first time somebody wrote one. If a shell-string
 * `exec` ever does arrive here, it will arrive as `execFile` or through the shell shape
 * below, both of which are already covered.
 */
export function commandsIn(source) {
  const code = blankComments(source);
  const found = new Set();
  const SPAWN = /\b(?:spawnSync|spawn|execFileSync|execFile)\(\s*(['"])([A-Za-z0-9._/-]+)\1/g;
  const SHELL = /\bexec\s+([a-z][a-z0-9-]*)\b/g;
  for (const m of code.matchAll(SPAWN)) found.add(m[2]);
  for (const m of code.matchAll(SHELL)) found.add(m[1]);
  return [...found].sort();
}

/**
 * The register cannot be swept for hosts, because every `termsUrl` in it is one.
 *
 * `https://www.anthropic.com/legal` is a citation — where a person goes to read what the
 * entry above it summarises — and nothing here ever requests it. Left in the sweep, the
 * register reports itself as five unregistered suppliers, which is the check finding its
 * own documentation: the same wrong answer `lib/checkaudit.js` gets when it does not blank
 * comments first, arriving through a field instead of through a paragraph.
 *
 * That exemption is only safe while this file stays data. `test/suppliers.mjs` pins its
 * import list for exactly that reason — the day somebody imports something here that can
 * make a request, the suite fails and this argument has to be made again rather than
 * silently covering it.
 */
export const NOT_SWEPT = 'lib/suppliers.js';

/** Every `.js` under the swept directories, as repo-relative paths. */
function sweptFiles(root) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    let names;
    try {
      names = fs.readdirSync(path.join(root, dir));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const rel = `${dir}/${name}`;
      if (name.endsWith('.js') && rel !== NOT_SWEPT) files.push(rel);
    }
  }
  return files;
}

/**
 * What the tree reaches, and from where.
 *
 * Both maps are host-or-command to the sorted list of files it was found in, because a
 * finding that cannot say where it is is a finding somebody has to go and grep for.
 */
export function scan(root) {
  const hosts = new Map();
  const commands = new Map();
  for (const rel of sweptFiles(root)) {
    let source;
    try {
      source = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    for (const h of hostsIn(source)) hosts.set(h, [...(hosts.get(h) ?? []), rel]);
    for (const c of commandsIn(source)) commands.set(c, [...(commands.get(c) ?? []), rel]);
  }
  return { hosts, commands };
}

/** Does this supplier claim that host — exactly, or by the suffix pattern it registered? */
export function claimsHost(entry, host) {
  return entry.hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : h === host));
}

/** A command claimed by name, whatever directory the scan found it in. */
function claimsCommand(entry, command) {
  const name = command.split('/').pop();
  return entry.commands.includes(name);
}

/** Exempt because of where it lives — unless its name is one that is never local. */
function isSystemBinary(command) {
  return SYSTEM_BINARY.test(command) && !NEVER_LOCAL.includes(command.split('/').pop());
}

/* ---------------------------------------------------------- what must hold */

const prose = (v) => typeof v === 'string' && v.trim().length >= 30;
const HOST_RE = /^(?:\*\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

/**
 * Everything wrong with one supplier entry, as sentences.
 *
 * One entry rather than the register, for the reason `lib/evidence.js` gives: a rule only
 * ever run against a register that passes is a rule nobody has seen fail.
 *
 * The rule that carries the weight is the last one. Every other field can be filled in
 * from the code; `terms`, `retention` and `training` cannot, and the only thing stopping
 * them being filled in with something plausible is being made to say, in writing, that
 * nobody has read the agreement yet.
 */
export function entryProblems(e) {
  const problems = [];
  const at = `REGISTER[${e?.id || '?'}]`;

  if (!/^[a-z][a-z0-9-]*$/.test(String(e?.id || ''))) problems.push(`${at}: id must be kebab-case`);
  if (typeof e?.name !== 'string' || e.name.trim().length < 2) problems.push(`${at}: \`name\` must name the third party`);
  if (!prose(e?.purpose)) problems.push(`${at}: \`purpose\` must say why anything is sent to them at all`);

  if (!Array.isArray(e?.sends) || !e.sends.length) {
    problems.push(`${at}: \`sends\` must name the data categories that leave — it is the first question an auditor asks`);
  }
  const hosts = Array.isArray(e?.hosts) ? e.hosts : [];
  const commands = Array.isArray(e?.commands) ? e.commands : [];
  if (!hosts.length && !commands.length) {
    problems.push(`${at}: names neither a host nor a command, so nothing here reaches it and it is not a supplier of this system`);
  }
  for (const h of hosts) if (!HOST_RE.test(String(h))) problems.push(`${at}: "${h}" is not a hostname or a \`*.suffix\` pattern`);
  if (!Array.isArray(e?.reachedBy) || !e.reachedBy.length) problems.push(`${at}: \`reachedBy\` must name the modules that do the reaching`);

  if (!prose(e?.terms)) problems.push(`${at}: \`terms\` must say what the relationship is governed by`);
  if (!/^https:\/\//.test(String(e?.termsUrl || ''))) problems.push(`${at}: \`termsUrl\` must be where those terms can be read`);
  if (!prose(e?.retention)) problems.push(`${at}: \`retention\` must say what they keep and for how long`);
  if (!prose(e?.training)) problems.push(`${at}: \`training\` must say whether what is sent trains anything — "not applicable" is an answer, blank is not`);

  if (parseDate(e?.reviewedOn) === null) problems.push(`${at}: \`reviewedOn\` must be a real date, as YYYY-MM-DD`);
  if (!Number.isInteger(e?.reviewMonths) || e.reviewMonths < 1 || e.reviewMonths > MAX_REVIEW_MONTHS) {
    problems.push(`${at}: \`reviewMonths\` must be a whole number of months between 1 and ${MAX_REVIEW_MONTHS}`);
  }

  if (e?.termsConfirmedOn !== null && parseDate(e?.termsConfirmedOn) === null) {
    problems.push(`${at}: \`termsConfirmedOn\` must be the date somebody read the agreement, or null if nobody has`);
  }
  if (e?.termsConfirmedOn === null && !e?.gap) {
    problems.push(
      `${at}: nobody has read the terms and no bead says so. A supplier whose terms are unconfirmed is a supplier the ` +
        'register is guessing about, and a guess reads identically to an answer — name the bead.'
    );
  }
  if (e?.gap) {
    if (!/^bc-[a-z0-9]+(?:\.\d+)*$/.test(String(e.gap.bead || ''))) problems.push(`${at}: \`gap.bead\` must name the bead that closes it`);
    if (!prose(e.gap.says)) problems.push(`${at}: \`gap.says\` must say what is missing, in a sentence`);
  }

  return problems;
}

/**
 * Everything wrong with the register in this checkout, as sentences.
 *
 * Failures and warnings are separated for the reason `lib/documents.js` separates them: a
 * review coming due is something to plan, and a review that has passed is something to
 * stop and do. `now` is a parameter so both can be shown to fire.
 */
export function registerProblems(root, now = new Date(), register = REGISTER) {
  const problems = [];
  const warnings = [];
  const seen = new Set();

  for (const e of register) {
    problems.push(...entryProblems(e));
    if (seen.has(e.id)) problems.push(`REGISTER[${e.id}]: two entries with the same id`);
    seen.add(e.id);

    for (const rel of e.reachedBy ?? []) {
      if (!fs.existsSync(path.join(root, rel))) {
        problems.push(`REGISTER[${e.id}]: \`reachedBy\` names ${rel}, which is not in the repo — either the supplier has gone or a rename stopped here`);
      }
    }

    const { due, days, state } = reviewStatus(e, now);
    if (state === 'overdue') {
      problems.push(`REGISTER[${e.id}]: supplier review was due ${due}, ${-days} day${days === -1 ? '' : 's'} ago — re-read the terms, then move \`reviewedOn\`.`);
    }
    if (state === 'approaching') warnings.push(`REGISTER[${e.id}]: supplier review due ${due}, in ${days} day${days === 1 ? '' : 's'}.`);
  }

  return { problems, warnings };
}

/**
 * Everything the tree reaches that the register does not account for, as sentences.
 *
 * Two directions, and only one of them can be enforced honestly. **A host or command found
 * in the tree must be claimed** — that is the direction that stops a new integration
 * shipping without its supplier entry, and it is the whole point. **An exemption that
 * matches nothing must go** — a sentence excusing something that has left the tree is how
 * this list stops describing the repo, and it is the same second-half rule
 * `test/evidence.mjs` enforces on its own claims.
 *
 * A *registered* host that the scan no longer finds is deliberately not a failure: half
 * the register is reached through a configured hostname or a binary resolved at runtime,
 * so absence proves nothing. The review date is what catches a supplier that has gone.
 */
export function egressProblems(root, register = REGISTER, exempt = NOT_EGRESS) {
  const problems = [];
  const { hosts, commands } = scan(root);
  const exemptHosts = exempt.filter((x) => x.kind === 'host');
  const exemptCommands = exempt.filter((x) => x.kind === 'command');

  for (const [host, where] of [...hosts].sort()) {
    if (exemptHosts.some((x) => x.what === host)) continue;
    if (register.some((e) => claimsHost(e, host))) continue;
    problems.push(
      `${host} is reached from ${where.join(', ')} and no supplier claims it. Add it to the entry it belongs to, ` +
        'or say in NOT_EGRESS why it is not a third party.'
    );
  }

  for (const [command, where] of [...commands].sort()) {
    if (isSystemBinary(command)) continue;
    // The same claim a REGISTER entry makes, checked by name rather than by which
    // supplier's account it runs under — `claimsCommand` already strips a directory
    // prefix for this reason, and a NOT_EGRESS command exemption is that same lookup
    // with no supplier behind it, so it has to be the same match.
    if (exemptCommands.some((x) => x.what === command.split('/').pop())) continue;
    if (register.some((e) => claimsCommand(e, command))) continue;
    problems.push(
      `\`${command}\` is executed from ${where.join(', ')} and no supplier claims it. If it sends anything anywhere, ` +
        'it needs a supplier entry; if it does not, it belongs in NOT_EGRESS with a sentence saying so.'
    );
  }

  for (const x of exemptHosts) {
    if (!hosts.has(x.what)) {
      problems.push(`NOT_EGRESS names ${x.what}, which the sweep no longer finds — an exemption that matches nothing excuses nothing.`);
    }
  }
  for (const x of exempt.filter((e) => e.kind === 'command')) {
    if (!commands.has(x.what)) {
      problems.push(`NOT_EGRESS names \`${x.what}\`, which the sweep no longer finds — an exemption that matches nothing excuses nothing.`);
    }
  }

  return problems;
}
