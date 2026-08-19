import { AGENTS, baseline } from './foundation.js';
import { allowlist } from './auth.js';
import { deviceRows } from './devices.js';
import { CONFIG_DIR } from './config.js';

/**
 * Who and what can reach this system, on whose authority, and what takes it away.
 *
 * An auditor asking CC6.1 — "identify and authenticate the principals, authorise them
 * against a role, and remove the access when the role ends" — expects to be handed a
 * list of accounts. There is no such list here and inventing one would be the wrong
 * answer written convincingly, because **most of the principals in this system are
 * agents, and an agent is not a user account.** Nothing spawned by this daemon holds a
 * credential of its own: every one of them runs as the single Claude subscription
 * signed in on this Mac, in a process whose reach was decided before it started. Give
 * each agent kind a row that reads like a user and you have described seven accounts that
 * do not exist, cannot be disabled one at a time, and would pass a review by being
 * ticked.
 *
 * So the rows here are **grants, not accounts** — the thing that hands a principal its
 * reach, chosen because it is the thing an access review can actually revoke:
 *
 *   - a **foundation** (lib/foundation.js) — what an agent kind *is* on every run: its
 *     tool allowlist, whether it may write, whether it owns a repo. Amendable only by
 *     a commit, and `PROTECTED` fields not even then.
 *   - an **endorsement** — an unendorsed bead is worked by nobody, so the gate is the
 *     authorisation step for the work itself rather than for the agent.
 *   - an **environment** — `JIRA_API_TOKEN` is exported by `~/.zshenv` only under work
 *     paths, so a session rooted in a personal repo physically cannot authenticate
 *     against the work JIRA. The credential is scoped by the directory the process was
 *     started in, which is a grant nobody has to remember to remove.
 *   - a **network position** — the daemon binds a tailnet address and nothing else. An
 *     unenrolled device cannot reach a port to present a credential to.
 *   - an **allowlist entry**, a **device row**, or **possession of the shared token**,
 *     for the three ways a human gets in.
 *
 * ## Derived where it can be, refused where it cannot
 *
 * The roster of agent kinds is `AGENTS` in lib/foundation.js, read at call time — so an
 * eighth kind cannot come into existence without this file having heard of it. What
 * *cannot* be derived is the sentence saying what that kind reaches and what revokes
 * it, and a register whose answer to a new kind is silence is a register that reports
 * completeness on the day it stopped being complete. So `AGENT_ACCESS` below must cover
 * `AGENTS` exactly and a kind with no row is a **refusal**, the same shape `MARKS` uses
 * to keep a new agent kind from shipping as a generic 🤖 (test/agentchats.mjs).
 *
 * The human half is the opposite: read from live config and live state on every call —
 * the allowlist, the device rows, whether a token exists — because "who can sign in" is
 * a fact about the file, and a copy of it typed into this module would be a second
 * answer that drifts and is believed.
 *
 * ## What is deliberately not here: framework ids
 *
 * **Nothing in the register is keyed by a framework id, and no exported value contains
 * one.** That is a seam rather than an omission: bc-4r10.1 builds one closed control
 * corpus across the three frameworks with crosswalk edges on the control, and an id
 * written into the data here first would be a second vocabulary — exactly the "same
 * control implemented three times" that the corpus exists to prevent. The register is the
 * *evidence*; the corpus cites it, in that direction.
 *
 * Comments are the exception, and deliberately: a couple below name the criterion they
 * are answering, because a reader deciding whether a paragraph still earns its place
 * needs to know what it was for. A comment cannot be joined on, indexed, or mistaken for
 * a vocabulary — a field can.
 *
 * ## The review, and the one honest limit of it
 *
 * `REVIEWS` is append-only, and appending to it is a commit — so who performed a review
 * and when is the git identity on that commit, in a history nobody here can rewrite.
 * `reviewState` turns the last entry into a due date, `test/access.mjs` fails when it is
 * past, and `bin/access.js` exits non-zero on the same condition. A control whose only
 * enforcement is a diary entry is not a control.
 *
 * The limit, said out loud because an auditor will find it otherwise: the merge queue
 * ignores checks that `main` is already failing (lib/mergequeue.js), so once this red
 * lands on `main` it stops blocking *other* people's merges rather than halting the
 * fleet. That is the right failure direction — an unreviewed register must not become a
 * deadlock nobody can commit their way out of — but it means the teeth here are a
 * visible red and a card, not a gate. Turning it into one is bc-eqn1.8's job, which is
 * where enforcement gates live for the whole programme.
 */

/** The kinds of principal this register knows. An id outside it is a refusal. */
export const PRINCIPAL_KINDS = ['human', 'device', 'agent', 'machine'];

/**
 * What each agent kind reaches, and what takes it away.
 *
 * Keyed by the ids in `AGENTS`, which this must cover exactly. `grant` names the thing
 * that hands this kind its reach — always something that can be withdrawn, never "it is
 * trusted". `revoke` is the act, in the imperative, because a review that produces
 * "consider whether X should still…" produces nothing.
 *
 * `writes` and `ownsRepo` are read off the foundation rather than restated, so a kind
 * whose baseline is widened in a release cannot keep a narrow description here.
 */
export const AGENT_ACCESS = {
  console: {
    reaches: 'The repo it was opened on, read-only, and its own memory.',
    grant: 'A chat opened from the phone, gated by the token or a signed-in session.',
    revoke: 'Revoke the device (Devices screen), or rotate the API token.',
  },
  dispatch: {
    reaches: 'The bead it was dispatched for, plus the read-only allowlist in lib/toolbelt.js.',
    grant: 'A comment left on a question bead — the comment is the whole authorisation.',
    revoke: 'Answer or close the bead; nothing dispatches against a closed one.',
  },
  advocate: {
    reaches: 'One approved repo checkout, read-only, and the repo it owns under the agent-repo root.',
    grant: 'The repo being on the approved list in config.json, and its queue reaching zero.',
    revoke: 'Remove the repo from the approved list, or switch the advocate off for that space.',
  },
  'epic-advocate': {
    reaches: 'One owned epic and the beads it files underneath it, in one approved repo.',
    grant: 'Ownership of an endorsed P0 epic — no epic, no session.',
    revoke: 'Unclaim or close the epic; park the bead.',
  },
  worker: {
    reaches: 'One git worktree of one approved repo, with write access to that worktree alone.',
    grant: 'An endorsed, ready bead plus the worktree lock the session holds for the run.',
    revoke: 'Park or close the bead; prune the worktree, which ends the lock.',
  },
  'merge-advocate': {
    reaches: 'Every open branch of one approved repo, and `main` — the only agent that may write it.',
    grant: 'A delivery on the merge queue, which is itself a bead.',
    revoke: 'Close the merge bead; deauthenticate `gh`, which is what its push depends on.',
  },
  'review-advocate': {
    reaches: "One pull request's diff in one approved repo, read-only, plus a comment on the merge bead.",
    grant: 'A delivered pull request waiting on the merge queue — the merge bead is the whole authorisation.',
    revoke: 'Close the merge bead; deauthenticate `gh`, which is what it reads the diff through.',
  },
};

/**
 * Every credential this system can hold, where it lives, and the act that ends it.
 *
 * Hand-written and closed, because there is nothing to derive it from: a credential is
 * a fact about a file or an environment variable, and the only honest way to know they
 * are all here is that adding one without a row fails a test (`JML.leaver` below closes
 * the loop — see test/access.mjs).
 *
 * `scope` is the field worth reading twice. Three of these are scoped by something other
 * than a permission system — a directory, a checkout, a network — and that is the design
 * this register exists to state rather than to leave as an arrangement.
 */
export const CREDENTIALS = [
  {
    id: 'api-token',
    what: 'The shared token every non-browser caller presents.',
    where: `${CONFIG_DIR}/config.json — the top-level \`token\``,
    holder: 'The phone, the Android app, ntfy action buttons, lib/notify.js, scripts/shot.mjs.',
    scope: 'Everything under /api/*, from anywhere on the tailnet. No identity attached to it.',
    // The one credential that is *in* config.json rather than in a `.key` file beside it,
    // which matters for rotation and is the kind of thing a register exists to surface:
    // that file is snapshotted into the ~/.config git repo after every write, so a rotated
    // token is still in a history the rotation cannot reach back into. Worth doing anyway
    // — the history is on this Mac, behind the same tailnet — but worth knowing.
    revoke: 'Rotate: replace the top-level `token`, restart, re-pair each caller from the QR. The old value stays in the config repo history.',
  },
  {
    id: 'session-key',
    what: 'The HMAC key every browser session cookie is signed with.',
    where: `${CONFIG_DIR}/session.key`,
    holder: 'The daemon. Never leaves the Mac.',
    scope: 'Signs and verifies every cookie; deleting it ends every session everywhere at once.',
    revoke: 'Delete the file. Every browser signs in again.',
  },
  {
    id: 'device-session',
    what: 'One signed-in browser: a `sid` row in state.json beside the cookie holding it.',
    where: `${CONFIG_DIR}/state.json — \`devices\``,
    holder: 'One browser on one device, under one allowlisted email.',
    scope: 'The pages and API a signed-in person may use, for 30 days or until the row is deleted.',
    revoke: 'Delete the row — the Devices screen, or signing that browser out.',
  },
  {
    id: 'google-client-secret',
    what: 'The OAuth client secret sign-in is configured with.',
    where: `${CONFIG_DIR}/google-client-secret.key`,
    holder: 'The daemon, when sign-in is on.',
    scope: 'Exchanging an authorisation code for an id token. Nothing else.',
    revoke: 'Rotate in the Google console, rewrite the file, restart.',
  },
  {
    id: 'tls-key',
    what: 'The private key for the tailnet MagicDNS certificate.',
    where: `${CONFIG_DIR}/tls/<name>.key`,
    holder: 'The daemon.',
    scope: 'Terminating HTTPS on the tailnet name. Re-fetchable at any time.',
    revoke: 'Delete the pair and re-fetch with `tailscale cert`.',
  },
  {
    id: 'slack-bot',
    what: 'The Slack bot token questions are posted with.',
    where: `${CONFIG_DIR}/slack-bot.key`,
    holder: 'The daemon, when Slack is configured.',
    scope: 'The channels named in the per-space Slack config, posting only.',
    revoke: 'Revoke in the Slack app config, delete the file.',
  },
  {
    id: 'slack-app',
    what: 'The Slack app token the socket connection uses.',
    where: `${CONFIG_DIR}/slack-app.key`,
    holder: 'The daemon, when Slack is configured.',
    scope: 'One socket-mode connection, for button presses coming back.',
    revoke: 'Revoke in the Slack app config, delete the file.',
  },
  {
    id: 'atlassian-token',
    what: 'The JIRA/Confluence API token, per workspace.',
    where: `${CONFIG_DIR}/jira-<workspace>.key, or \`JIRA_API_TOKEN\` in the environment`,
    holder: 'The daemon for polling; an agent session only under a work path.',
    scope:
      'Read-only against JIRA by policy and pull-only by configuration; Confluence writes only to allowlisted spaces. The environment copy is exported by ~/.zshenv under work paths alone, so a personal-repo session cannot authenticate at all.',
    revoke: 'Revoke the token in Atlassian, delete the file, and unset the export.',
  },
  {
    id: 'github-cli',
    what: 'The `gh` logins every push, pull request, merge and approving review rides on. There may be more than one, and on this Mac there are two: `resolve` in lib/pr.js picks the account that can write, and `reviewerFor` picks a second one that can only see the repo — because GitHub refuses an approving review from the account that opened the pull request.',
    where: "The `gh` CLI's own credential store, in the daemon's user account. A second account's token is read with `gh auth token --user <login>` and passed as `GH_TOKEN` for that one call.",
    holder: 'The merge queue and every worker delivery, as the writing account. The reviewer identity is used for exactly two calls — the approving review and the comment naming the agent that left it (`approve`, lib/pr.js).',
    scope: 'The repos each account can see on GitHub — wider than beadcause, and worth naming for that reason. The reviewing account needs no more than READ, and is deliberately left with no more.',
    revoke: '`gh auth logout` for each account, and revoke each token on GitHub. Logging out the reviewer alone leaves everything working except approvals, which fall back to being recorded on the bead.',
  },
  {
    id: 'claude-subscription',
    what: 'The Claude account every agent in this system runs as.',
    where: "The Claude CLI's own credential store, in the daemon's user account.",
    holder: 'Every agent kind. There is one of these, not seven.',
    scope: 'Whatever the foundation of the spawning agent allows — the credential itself is unscoped.',
    revoke: 'Sign the CLI out; the daemon can spawn nothing until it is signed back in.',
  },
];

/**
 * Joiner, mover, leaver — written down because CC6.2 is tested against the path and not
 * against the headcount.
 *
 * The org is one person, so every one of these has run zero times. That is not a reason
 * to leave it undocumented: the question an auditor asks is whether the path exists and
 * is followed, and "we would have worked it out" is the answer that fails. It is also
 * the answer that would be *true* at the moment it mattered most — a laptop lost, a
 * contractor finished — which is when nobody is in a state to work anything out.
 *
 * `leaver` steps carry a `credential`, and test/access.mjs asserts every id in
 * `CREDENTIALS` appears in at least one of them. That is the closure worth having:
 * adding a credential without saying how it comes back fails the suite, so the leaver
 * path cannot quietly go stale behind the register.
 */
export const JML = {
  joiner: [
    'Add the email to `auth.google.allowed` in config.json. Nothing else grants a person anything.',
    'Enrol their device on the tailnet — without it there is no address to reach.',
    'Hand over the API token only if they need a non-browser caller; a browser needs sign-in alone.',
    'Record the grant by committing the config snapshot, which ~/.config/beadcause does after every write.',
  ],
  mover: [
    'A role change here is a change to what an agent may do, not to a person: amend the foundation, or edit lib/foundation.js for a protected field.',
    'For a person, the only dial is the allowlist and the token — narrow by removing, never by asking.',
    'Re-run `beadcause-access` afterwards; a move that does not change the register did not change anything.',
  ],
  leaver: [
    { act: 'Remove the email from `auth.google.allowed`.', credential: 'device-session' },
    { act: 'Delete every device row for that email on the Devices screen.', credential: 'device-session' },
    { act: 'Rotate the API token, because possession is the whole of that grant.', credential: 'api-token' },
    { act: 'Delete session.key if a cookie may have been copied rather than merely held.', credential: 'session-key' },
    { act: 'Rotate the Google client secret if they ever configured sign-in.', credential: 'google-client-secret' },
    { act: 'Re-fetch the tailnet certificate if the key left this Mac.', credential: 'tls-key' },
    { act: 'Revoke and replace both Slack tokens.', credential: 'slack-bot' },
    { act: 'Revoke and replace both Slack tokens.', credential: 'slack-app' },
    { act: 'Revoke the Atlassian token and unset the environment export.', credential: 'atlassian-token' },
    { act: '`gh auth logout` and revoke the GitHub token.', credential: 'github-cli' },
    { act: 'Sign the Claude CLI out; every agent stops with it.', credential: 'claude-subscription' },
    { act: 'Remove their tailnet device from the tailnet admin console.', credential: 'api-token' },
  ],
};

/** How long a register stays believable without somebody looking at it again. */
export const REVIEW_INTERVAL_DAYS = 90;

/**
 * Every access review that has been performed. Append-only; the commit is the evidence.
 *
 * A row is `{ at, by, note }` and nothing else, because everything an auditor would ask
 * beyond it — what the register said that day, who signed the change — is answered by
 * the commit this line arrives in and by the file around it. A field restating any of
 * that is a field that can disagree with the history.
 */
export const REVIEWS = [
  {
    at: '2026-08-15',
    by: 'neadamthal@gmail.com',
    note: 'Register created: agent kinds, human grants, credentials and the leaver path enumerated for the first time.',
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days before the due date at which `bin/access.js` starts saying so. */
export const REVIEW_WARN_DAYS = 14;

/**
 * Where the review stands — the last one, when the next is due, and whether it is late.
 *
 * `now` is injected rather than read, because a control that fails on a date is a
 * control whose *failing* has to be testable without waiting for the date.
 */
export function reviewState(now = new Date(), reviews = REVIEWS, intervalDays = REVIEW_INTERVAL_DAYS) {
  const at = new Date(now).getTime();
  const last = reviews.length ? reviews[reviews.length - 1] : null;
  if (!last) return { last: null, dueAt: null, daysLeft: null, due: true, overdue: true, daysLate: null };
  const lastAt = Date.parse(`${last.at}T00:00:00Z`);
  const dueAt = lastAt + intervalDays * DAY_MS;
  const daysLeft = Math.ceil((dueAt - at) / DAY_MS);
  return {
    last,
    dueAt: new Date(dueAt).toISOString().slice(0, 10),
    daysLeft,
    due: daysLeft <= REVIEW_WARN_DAYS,
    overdue: daysLeft < 0,
    daysLate: daysLeft < 0 ? -daysLeft : 0,
  };
}

/** The sentence to print about the review — one line, and the only one anybody reads. */
export function reviewLine(state) {
  if (!state.last) return 'No access review has ever been recorded. Perform one and append it to REVIEWS in lib/access.js.';
  if (state.overdue)
    return `Access review is ${state.daysLate} day${state.daysLate === 1 ? '' : 's'} overdue — last ${state.last.at}, due ${state.dueAt}. Perform one and append it to REVIEWS in lib/access.js.`;
  if (state.due) return `Access review due in ${state.daysLeft} days (${state.dueAt}) — last ${state.last.at} by ${state.last.by}.`;
  return `Access review last performed ${state.last.at} by ${state.last.by}; next due ${state.dueAt}.`;
}

/**
 * What this kind may actually execute — the closest thing here to CC6.8's question about
 * unauthorised software.
 *
 * Read off the foundation, and phrased so the honest answer is the loud one: **the worker
 * has no allowlist at all**. That is deliberate and defensible — a session opened to do a
 * bead needs whatever the bead needs, and its containment is the worktree it may write to
 * rather than a list of verbs — but a register that let it read like the other five would
 * be hiding the single widest grant in the system behind a number.
 */
function mayRun(f) {
  const belt = f.tools ? `the ${f.tools} tool set` : "the CLI's default tool set";
  if (!Array.isArray(f.allowedTools)) return `No tool allowlist — ${belt}, contained by the worktree it may write to rather than by a list.`;
  return `${f.allowedTools.length} allowlisted patterns over ${belt}; anything not matched is refused.`;
}

/**
 * The agent half, derived from the roster so it cannot be short.
 *
 * Throws on a kind with no `AGENT_ACCESS` row. A register that answered "seven of the
 * eight" without saying so is the failure this whole file is against.
 */
export function agentPrincipals() {
  return AGENTS.map((id) => {
    const row = AGENT_ACCESS[id];
    if (!row) throw new Error(`agent kind ${id} has no access registered — add it to AGENT_ACCESS in lib/access.js`);
    const f = baseline(id);
    return {
      id: `agent:${id}`,
      kind: 'agent',
      // `title` rather than `displayName` or the pill name: those are a mid-sentence form
      // and a label for a chip row, and a register row wants the sentence-form description
      // of what the kind is — "The merge queue", not "merge-advocate".
      name: f.title,
      what: f.purpose,
      reaches: row.reaches,
      grant: row.grant,
      revoke: row.revoke,
      // Neutral on purpose. lib/foundation.js reads `writes` as "may create, close or
      // delete work" where the advocate is concerned, and as "it comments on the bead"
      // where dispatch is; both are writes to the tracker and neither is the other, so the
      // specific reach is `reaches`'s job and this stays the boolean it came from.
      writes: f.writes ? 'may write to the tracker' : 'read-only against the tracker',
      mayRun: mayRun(f),
      ownsRepo: !!f.ownsRepo,
      credential: 'claude-subscription',
    };
  });
}

/**
 * The human half, read from what is true right now.
 *
 * `cfg` and `state` are passed in rather than loaded, so this answers about *an*
 * install — the daemon's, a test's, an observer's — instead of about whichever config
 * directory the process happened to inherit.
 */
export function humanPrincipals(cfg = {}, state = {}, now = new Date()) {
  const out = [];
  for (const email of allowlist(cfg.auth?.google || {})) {
    out.push({
      id: `human:${email}`,
      kind: 'human',
      name: email,
      what: 'A person who may sign in with Google and use every screen.',
      reaches: 'Every page and every /api route, from a browser on the tailnet.',
      grant: 'An entry in `auth.google.allowed`.',
      revoke: 'Remove the entry, then delete their device rows — the entry alone leaves live cookies working until they expire.',
      credential: 'device-session',
    });
  }
  // `cfg.token`, top-level — not `cfg.auth.token`, which is where it reads as though it
  // ought to live and where this file looked at first. `auth` holds the *second*
  // credential (Google), added later; the shared token predates it and never moved. The
  // cost of getting it wrong is a register that quietly omits the widest human grant in
  // the system on every real install, which is why test/access.mjs builds its config with
  // the real loader rather than by hand.
  if (cfg.token) {
    out.push({
      id: 'human:token-holder',
      kind: 'human',
      name: 'Whoever holds the API token',
      what: 'The shared secret every non-browser caller presents. It carries no identity, which is the point worth registering.',
      reaches: 'Every /api route, from anywhere on the tailnet.',
      grant: 'Possession. There is no list of who has it, and a photographed QR is a grant.',
      revoke: 'Rotate the top-level `token` in config.json and re-pair every caller.',
      credential: 'api-token',
    });
  }
  for (const d of deviceRows(state.devices || {}, { now })) {
    out.push({
      id: `device:${d.id}`,
      kind: 'device',
      name: `${d.label || 'a browser'} — ${d.email || 'unknown'}`,
      what: `Signed in ${d.first || 'at some point'}, last seen ${d.last || 'never'}.`,
      reaches: 'Everything its person may reach, until the cookie expires.',
      grant: 'A signed session cookie whose `sid` is this row.',
      revoke: 'Delete the row — the Devices screen, or sign that browser out.',
      credential: 'device-session',
    });
  }
  return out;
}

/**
 * The machine itself, which is the boundary CC6.6 asks about.
 *
 * One row, and it is the most load-bearing one here: nothing in this system is reachable
 * from the public internet at all. Every credential above is a second gate behind a
 * network position that an unenrolled device cannot take.
 */
export function boundaryPrincipal(cfg = {}) {
  return {
    id: 'machine:this-mac',
    kind: 'machine',
    name: 'This Mac, on the tailnet',
    what: 'The only host anything here runs on, and the only place any credential lives.',
    reaches: 'Binds the tailnet address alone; the router proxies to backends over loopback.',
    grant: 'Tailscale enrolment. There is no public listener and no inbound webhook of any kind.',
    revoke: 'Remove the device from the tailnet admin console.',
    // CC6.7's question, answered in one line because the answer is short and the same
    // whether or not the certificate is there: the tailnet is WireGuard underneath.
    inTransit:
      'HTTPS on the MagicDNS name with a Tailscale-issued certificate, terminated by bin/router.js; WireGuard underneath either way, so a missing certificate costs the browser lock and not the encryption. The only plaintext hop is loopback, between the router and the backend it swapped to.',
    credential: 'tls-key',
    baseUrl: cfg.baseUrl || null,
  };
}

/**
 * The whole register, as one object a screen, a CLI or an auditor can read.
 *
 * Assembled on every call rather than cached: it is a description of the current state
 * of a config file, and a cached one would be a description of a state that has passed.
 */
export function register(cfg = {}, state = {}, now = new Date()) {
  return {
    generatedAt: new Date(now).toISOString(),
    principals: [...humanPrincipals(cfg, state, now), boundaryPrincipal(cfg), ...agentPrincipals()],
    credentials: CREDENTIALS,
    jml: JML,
    review: reviewState(now),
  };
}
