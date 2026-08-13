/**
 * JIRA, per workspace, read-only — the setting, the credential, and the client.
 *
 * Turn this on for one workspace and the tickets assigned to you start arriving in
 * beadcause (bc-0i27). This module is the foundation the rest of that stands on: it
 * answers *is JIRA on for this workspace*, *where does it point*, *what do we
 * authenticate as*, and *how is a read issued* — and it deliberately answers nothing
 * about tickets, rows, epics or the inbox.
 *
 * ## The standing rule: nothing here ever writes to JIRA
 *
 * JIRA is the team's source of truth and beadcause is not allowed near it with a pen.
 * That rule is easy to state and easy to break by accident, so it is implemented the
 * same way lib/lookup.js implements "GET only" for an agent's network grant: **there
 * is no code path that constructs a request body, and no exported function that names
 * a method.** `get()` below hard-codes `GET` and never passes `body`. A future caller
 * that wants to POST cannot reach one by passing a flag, because there is no flag —
 * it would have to add the capability, which is the point at which somebody has to
 * decide, explicitly and with an allowlist, that beadcause writes to JIRA.
 *
 * ## Where the setting lives, and where it deliberately does not
 *
 * `cfg.jira` is a map keyed by workspace name — the same shape as `sessionDirs` and
 * `advocates.perWorkspace`:
 *
 *     "jira": { "climative": { "enabled": true, "email": "you@company.com" } }
 *
 * It does **not** go on the `workspaces` array. That array is auto-discovered from
 * `~/beads/*​/.beads` and *reconciled on every start* (lib/config.js), so anything
 * hand-written onto an entry there is dropped the next time the daemon boots — which
 * would present as JIRA silently turning itself off after a restart.
 *
 * ## Why one setting is enough — bd already knows the rest
 *
 * `bd` holds per-workspace JIRA configuration of its own, and on this machine the
 * climative workspace already has it:
 *
 *     bd config get jira.url       ->  https://climative.atlassian.net
 *     bd config get jira.projects  ->  TECH
 *     bd config get jira.username  ->  adam.morgan@climative.ai
 *
 * Those live in the workspace's Dolt database rather than in `.beads/config.yaml`
 * (that file carries only a comment about them), so they are read by asking `bd`.
 * That is what lets the setting here be a boolean and an address: everything else is
 * already configured, once, where the tracker's own JIRA integration configured it.
 * An explicit `url` / `projects` / `email` in the beadcause block wins, for a
 * workspace whose `bd` has never been pointed at JIRA.
 *
 * **`bd config get` reports a missing key on stdout and exits 0**, printing
 * `jira.url (not set)`. Read naively that string becomes the site URL, and the first
 * symptom is a request to a hostname made of a sentence. `bdConfig` below is the one
 * place that knows, and `NOT_SET` is what it recognises.
 *
 * ## The credential is the one thing that cannot be reused
 *
 * `bd` resolves `jira.api_token` from the `JIRA_API_TOKEN` environment variable — on
 * this machine exported per-directory by `_bd_set_workspace` in `~/.zshenv`, out of an
 * unexported value in a 0600 file. That is a **shell** mechanism. The beadcause daemon
 * runs under launchd with launchd's environment and will never see it, so a client
 * that expected to inherit the token would work in every hand-test from a terminal and
 * authenticate as nobody in the only place it actually runs.
 *
 * So the token gets a file: `~/.config/beadcause/jira-<workspace>.key`, at 0600. The
 * rule, the mode and the reasoning are lib/atlassian.js's, shared with Confluence, and
 * this module holds only the part that is JIRA's — that the file is named *per
 * workspace*, because two workspaces may be two JIRA sites with two accounts and a
 * single credential would quietly authenticate one of them as the wrong person.
 * `JIRA_API_TOKEN` still wins when it is set, for the same reason it does in
 * lib/auth.js: it leaves no copy on disk.
 *
 * ## What is shared with Confluence, and what is not (bc-jv4p)
 *
 * lib/atlassian.js holds the credential convention and one abortable request. It does
 * **not** hold a single sentence either integration says: a 401 here sends you to a
 * named file and is thrown, and the same 401 in lib/confluence.js becomes a 502 so a
 * signed-in phone is not bounced to a login screen. The read-only rule above is also
 * unshared on purpose — `method: 'GET'` is written at the call site below, in this
 * file, because test/jira.mjs asserts against this module's own source.
 */
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import {
  basicAuth,
  credentialFile as atlassianCredentialFile,
  readCredential,
  saidAboutFailure,
  send,
  tokenFileWarning as atlassianTokenFileWarning,
  Unreachable,
  writeCredential,
} from './atlassian.js';

/** What `bd config get` prints for a key nobody has set. It still exits 0. */
const NOT_SET = /\(not set\)\s*$/;

/** How long a single JIRA read may take before it is abandoned. */
const TIMEOUT_MS = 15000;

/** The most issues one search may ask for, whatever a caller passes. */
export const MAX_RESULTS = 100;

/**
 * The block for one workspace, or null.
 *
 * `enabled` has to be literally true. An absent block, a `false`, or a block that is
 * not an object are all the same answer — off — because the failure mode of guessing
 * generously here is a daemon making network calls about a workspace nobody asked it
 * to.
 */
export function jiraBlock(cfg = {}, workspaceName = '') {
  const all = cfg && typeof cfg.jira === 'object' && cfg.jira ? cfg.jira : {};
  const block = all[workspaceName];
  return block && typeof block === 'object' ? block : null;
}

/** Is JIRA switched on for this workspace at all? Asked before anything costs anything. */
export function jiraEnabled(cfg = {}, workspaceName = '') {
  return jiraBlock(cfg, workspaceName)?.enabled === true;
}

/**
 * Where this workspace's API token is read from — ours, or the one the block names.
 *
 * `jira.<workspace>.tokenFile` is the same option lib/confluence.js has always had as
 * `apiTokenFile`, and it is here for the same two reasons: a token that already lives
 * somewhere (a password manager's export, a file shared with another tool) should not
 * have to be copied to be used, and a copy of a credential is a credential to rotate
 * twice. A relative name resolves *inside* `CONFIG_DIR`, so `tokenFile: "work.key"`
 * means the obvious thing rather than something relative to whatever directory the
 * daemon happened to start in.
 *
 * Naming one is also the only way to put the token somewhere the config repo would
 * commit — which is exactly what `tokenFileWarning` below is for.
 */
export function credentialFile(workspaceName, cfg = {}) {
  const named = String(jiraBlock(cfg, workspaceName)?.tokenFile || '').trim();
  if (named) return path.resolve(CONFIG_DIR, named);
  return atlassianCredentialFile(`jira-${workspaceName || ''}`);
}

/**
 * The token: the environment, or the file. There is deliberately no third place, and
 * `config.json` is specifically not one — see the header and lib/atlassian.js.
 */
export function readToken(workspaceName, cfg = {}, opts = {}) {
  return readCredential(credentialFile(workspaceName, cfg), { envVar: 'JIRA_API_TOKEN', ...opts });
}

/** Write a token to this workspace's file, at 0600. The mode is lib/atlassian.js's. */
export function writeToken(workspaceName, token, cfg = {}) {
  return writeCredential(credentialFile(workspaceName, cfg), token);
}

/**
 * A `tokenFile` pointed inside the config repo at a name its denylist does not refuse.
 *
 * The hole `secretFileWarning` covers in lib/auth.js and `tokenFileWarning` covers in
 * lib/confluence.js. lib/jira.js had no equivalent, which read as "JIRA does not have
 * this problem" and was true only for as long as the file was not nameable (bc-jv4p).
 * Silence for a workspace that never asked for JIRA, exactly like the two beside it.
 */
export function tokenFileWarning(cfg = {}, workspaceName = '') {
  if (!jiraBlock(cfg, workspaceName)) return null;
  return atlassianTokenFileWarning(credentialFile(workspaceName, cfg));
}

/**
 * Ask `bd` for one of its own config keys, in this workspace.
 *
 * Returns null for a key nobody has set, for a `bd` that failed, and for a `bd` that
 * is not there — all three are "no answer", and none of them should be able to become
 * a URL. See `NOT_SET`: the unset case is *not* an error, it is a sentence on stdout
 * with an exit code of 0.
 */
export async function bdConfig(bd, workspace, key) {
  try {
    const out = await bd.run(workspace, ['config', 'get', key], { timeout: 10000 });
    const value = String(out || '').trim();
    if (!value || NOT_SET.test(value)) return null;
    // A multi-line answer is not a value we understand; take nothing rather than a
    // fragment, because every caller of this puts the result into a request.
    return value.includes('\n') ? null : value;
  } catch {
    return null;
  }
}

/** `TECH` or `TECH,OPS` from bd, or a list in the config, as an array. */
const projectList = (raw) =>
  (Array.isArray(raw) ? raw : String(raw || '').split(','))
    .map((p) => String(p || '').trim())
    .filter(Boolean);

/**
 * Everything one workspace needs to make a JIRA read — or the reason it cannot.
 *
 * Resolution order for the three non-secret fields is *the config block, then bd*.
 * Config first because a value somebody typed into beadcause is a decision about
 * beadcause, and bd's is a decision about bd that happens to be reusable.
 *
 * `problem` is a sentence rather than a boolean, and it is the only thing that ever
 * says why JIRA is not working for a workspace. Three failures cover the whole of a
 * first configuration going wrong — no site, no address, no credential — and each one
 * names the fix rather than the symptom.
 */
export async function settingsFor(bd, workspace, cfg = {}) {
  const name = workspace?.name || '';
  const block = jiraBlock(cfg, name);
  const off = { workspace: name, enabled: false, url: null, email: null, projects: [], token: null, tokenFile: null, problem: null };
  if (!jiraEnabled(cfg, name)) return off;

  const url = String(block.url || (await bdConfig(bd, workspace, 'jira.url')) || '').trim().replace(/\/+$/, '');
  const email = String(block.email || (await bdConfig(bd, workspace, 'jira.username')) || '').trim();
  const projects = projectList(block.projects ?? (await bdConfig(bd, workspace, 'jira.projects')));
  // Carried on the settings rather than re-derived where it is needed: `reason()` names
  // this file in a 401, and it has only the settings — recomputing it there would mean
  // handing `cfg` to the client too, so that one sentence could name the file the
  // credential did *not* come from the day somebody sets `tokenFile`.
  const tokenFile = credentialFile(name, cfg);
  const token = readToken(name, cfg);

  const problem = !url
    ? `no JIRA site for ${name} — set jira.${name}.url in config.json, or \`bd config set jira.url\` in that workspace`
    : !/^https?:\/\//i.test(url)
      ? `the JIRA site for ${name} is not a URL (${url}) — it wants https://<your-site>.atlassian.net`
      : !email
        ? `no JIRA address for ${name} — set jira.${name}.email in config.json to the address whose assignments count as yours`
        : !token
          ? `no JIRA credential for ${name} — put an API token in ${tokenFile} (it is 0600 and the config repo refuses the name)`
          : null;

  return { workspace: name, enabled: true, url, email, projects, token, tokenFile, problem };
}

/**
 * What went wrong, in the words of the thing that has to be fixed.
 *
 * A first configuration goes wrong in two ways and they are indistinguishable from
 * the stack trace: the credential is wrong, or the site is. So the two statuses that
 * mean those say so, and everything else is reported as itself rather than guessed at.
 *
 * `said` is whatever JIRA itself put in the body — its `errorMessages` and its
 * per-field `errors`, read by lib/atlassian.js because Confluence's shape is different
 * and one reader should know both. It is appended rather than substituted: JIRA's own
 * sentence is precise about the request and says nothing about *this install*, so
 * "the JQL is malformed near 'assigne'" is worth having next to the workspace it was
 * asked for, and worthless instead of it.
 */
function reason(status, settings, said) {
  const also = said ? ` (JIRA said: ${said})` : '';
  // The default when the settings were built by hand rather than by `settingsFor` —
  // which the suite does, and which a future caller will. Naming the wrong file is
  // recoverable; printing the word `undefined` where a path belongs is not a message.
  const file = settings.tokenFile || credentialFile(settings.workspace);
  if (status === 401)
    return `JIRA refused the credential for ${settings.workspace} — check the token in ${file} and that it belongs to ${settings.email}${also}`;
  if (status === 403)
    return `JIRA accepted the credential for ${settings.workspace} but refused the request — ${settings.email} may not have access to that project${also}`;
  if (status === 404)
    return `JIRA has no such endpoint at ${settings.url} — check the site URL for ${settings.workspace}${also}`;
  if (status === 429) return `JIRA is rate-limiting ${settings.workspace} — the next poll will try again${also}`;
  return `JIRA answered ${status} for ${settings.workspace}${also}`;
}

/**
 * One read. GET, always, and there is nowhere to put a body.
 *
 * `fetchImpl` is for the tests, which serve a fake JIRA rather than reaching the real
 * one; production passes nothing and gets node's `fetch`. It is not a hook for a
 * different verb — the method is written here, once, in a string literal.
 *
 * Redirects are followed, which is worth a sentence because the request carries a
 * credential: the host is `settings.url`, which comes from the config or from `bd` and
 * never from a caller, so this is not lib/lookup.js's problem of an agent naming a URL.
 * A site that redirects is an Atlassian site that has been renamed, and the alternative
 * — refusing it — is a configuration that stops working with no explanation.
 */
export async function get(settings, endpoint, params = {}, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!settings?.enabled) throw new Error(`JIRA is not enabled for ${settings?.workspace || 'that workspace'}`);
  if (settings.problem) throw new Error(settings.problem);

  const url = new URL(`${settings.url}${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  let res;
  try {
    res = await send(url.toString(), {
      method: 'GET',
      headers: { Authorization: basicAuth(settings.email, settings.token), Accept: 'application/json' },
      fetchImpl,
      timeoutMs,
    });
  } catch (err) {
    // An abort is a timeout; anything else is the network. Both are the same to a
    // poll loop, and both have to arrive as a sentence rather than as a stack.
    if (!(err instanceof Unreachable)) throw err;
    const why = err.timedOut ? `no answer in ${Math.round(timeoutMs / 1000)}s` : err.message;
    throw new Error(`JIRA is unreachable for ${settings.workspace} — ${why}`);
  }

  if (!res.ok) {
    // The sentence is what a person reads; the number is what a *caller* can branch on.
    // lib/jirapoll.js is the first to need one — a 400 means JIRA refused the query it
    // was given, which is the one failure here that has a second thing worth trying,
    // and text-matching a message written for a phone to find that out would be a
    // sentence nobody could ever reword again.
    const err = new Error(reason(res.status, settings, saidAboutFailure(res.json)));
    err.status = res.status;
    throw err;
  }
  if (!res.parsed) {
    // Not `res.json === null`: an endpoint that legitimately answers `null` is not the
    // same event as a proxy answering an HTML login page with a 200, and only the
    // second one is worth a fault. The first 120 characters, because whatever is there
    // instead of JSON is usually recognisable in one glance and unreadable in ten lines.
    const saw = res.text.trim() ? `it starts "${res.text.trim().slice(0, 120)}"` : 'the body was empty';
    throw new Error(`JIRA answered ${settings.workspace} with something that is not JSON — ${saw}`);
  }
  return res.json;
}

/**
 * What a row needs, and no more. Declared above its one caller rather than below it:
 * a default parameter would resolve either way, but lib/agents.js has already cost
 * this repo a day over a module-scope read of a constant declared later, and the
 * cheapest defence is not writing the shape at all.
 */
export const DEFAULT_FIELDS = ['summary', 'status', 'assignee', 'updated', 'created', 'priority', 'issuetype'];

/**
 * A JQL search.
 *
 * `/rest/api/3/search/jql` rather than the older `/rest/api/3/search`, which Atlassian
 * has deprecated and which pages differently. `fields` is asked for explicitly because
 * the default is every field on the issue, which for a ticket with a long description
 * and a hundred comments is a payload nobody here reads.
 *
 * The JQL is the caller's, and that is the one thing this module takes on trust —
 * which is safe in the way that matters: a search is a read whatever it says, and
 * there is no verb here that could make it anything else.
 */
export async function search(settings, jql, { fields = DEFAULT_FIELDS, limit = 50, ...opts } = {}) {
  const body = await get(
    settings,
    '/rest/api/3/search/jql',
    { jql, maxResults: Math.min(Math.max(1, limit), MAX_RESULTS), fields: fields.join(',') },
    opts
  );
  return Array.isArray(body?.issues) ? body.issues : [];
}

/** Does the site answer, as the credential we hold? One call, for a configuration check. */
export async function check(settings, opts = {}) {
  try {
    const me = await get(settings, '/rest/api/3/myself', {}, opts);
    return { ok: true, as: me?.emailAddress || me?.displayName || null, problem: null };
  } catch (err) {
    return { ok: false, as: null, problem: err?.message || String(err) };
  }
}
