/**
 * The two things JIRA and Confluence are the same about: the credential, and the wire.
 *
 * beadcause reaches Atlassian twice, for two unrelated reasons. lib/jira.js reads the
 * tickets assigned to you, per workspace, and may never write (bc-0i27). lib/confluence.js
 * publishes a document to a page, per space, and exists to write (bc-c6qp). They landed
 * within minutes of each other and independently reached the same answers about the two
 * things underneath both — which was the good news, and the duplication was the bill
 * (bc-jv4p).
 *
 * ## What belongs here, and what deliberately does not
 *
 * Here: **the credential convention** — where an Atlassian API token lives, what mode it
 * is written at, why it may never be a config field, and how to tell somebody they have
 * pointed it somewhere that leaks. And **the wire** — one abortable request that turns a
 * fetch rejection into something with a name, reads the body once, and hands back the
 * status with whatever the site said about it.
 *
 * Not here: **every sentence either integration says out loud.** That is not tidiness
 * left undone, it is the point. A 401 from JIRA means *check the token in this file, and
 * that it belongs to that address*, and it is thrown; a 401 from Confluence means *502*,
 * because the phone that asked is signed in perfectly well and must not be sent to a
 * login screen. Folding those together would produce a message that is wrong for both
 * and a status that is wrong for one. Same for the shape of the two integrations: one is
 * per workspace and read-only, the other is per space and outward — `settingsFor` and
 * `settings` stay where they are.
 *
 * ## The credential rule, in one place at last
 *
 * An Atlassian API token goes in a file under `~/.config/beadcause` whose name ends
 * `.key`, at 0600. Never in `config.json`. That directory is a git repo lib/commonrepo.js
 * snapshots after **every write**, so a secret in `config.json` is not merely on disk in
 * the clear — it is in a history that a rotation cannot reach back into. The filename is
 * the whole protection, and it is protection by construction rather than by anybody
 * choosing well: `*.key` is both on that module's `FORBIDDEN` list, which aborts the
 * commit, and in the `.gitignore` it writes. Same rule and the same reasoning as
 * `google-client-secret.key` in lib/auth.js.
 *
 * An environment variable still wins when it is set, for a hand-run script or a test,
 * because it leaves no copy on disk. It is not the mechanism the daemon can rely on: the
 * daemon runs under launchd with launchd's environment, so a client that expected to
 * inherit `JIRA_API_TOKEN` from `~/.zshenv` would work in every hand-test from a terminal
 * and authenticate as nobody in the only place it actually runs.
 *
 * `tokenFileWarning` covers the one hole that leaves. Both integrations let you *name*
 * the file, and a name like `confluence-token.txt` inside that directory is a credential
 * the denylist does not refuse and the repo therefore commits. It is said out loud rather
 * than refused — see `leakWarning` in lib/commonrepo.js, which owns the question.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { leakWarning } from './commonrepo.js';

/** How long one Atlassian request may take before it is abandoned, unless told otherwise. */
export const TIMEOUT_MS = 15000;

/**
 * The `Authorization` value for an Atlassian Cloud API token: the address, then the token.
 *
 * Cloud wants basic auth over `email:token` for an account API token — not a bearer
 * header, which is what a first attempt reaches for and which Atlassian answers 401 to
 * with no hint that the *scheme* is the problem. Byte-identical in both integrations
 * before this file existed, which is the least surprising duplication to find and the
 * easiest for one side to drift on.
 */
export const basicAuth = (email, token) =>
  `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`;

/**
 * The default home of a credential named `<name>`: `~/.config/beadcause/<name>.key`.
 *
 * The name is sanitised rather than trusted because one caller builds it out of a
 * workspace name — `jira-climative` — and a workspace called `../../etc/evil` must not
 * be able to write outside the directory whose *rules* are the entire protection.
 */
export const credentialFile = (name) =>
  path.join(CONFIG_DIR, `${String(name || '').replace(/[^\w.-]/g, '_')}.key`);

/**
 * The token: the environment, or the file. There is deliberately no third place.
 *
 * `read` is injectable so a suite can prove the stronger half of "unconfigured, nothing
 * runs" — that the file was not so much as *opened*. Asserting that any other way means
 * asserting about atimes, which is not a thing a suite can do honestly.
 */
export function readCredential(file, { envVar = null, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const fromEnv = envVar ? process.env[envVar]?.trim() : '';
  if (fromEnv) return fromEnv;
  try {
    return read(file).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Write a token to a file, at 0600, creating the directory if it is not there.
 *
 * Here rather than in a script because the mode is the point: a token written 0644 by a
 * helper somebody wrote in a hurry is the failure the naming scheme exists to prevent,
 * and there should be exactly one function that knows the number.
 */
export function writeCredential(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${String(value || '').trim()}\n`, { mode: 0o600 });
  // writeFileSync only applies `mode` when it *creates* the file, so an existing one
  // keeps whatever it had — which is how a 0644 written by an earlier hand survives.
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * A token file inside the config repo that the denylist does not refuse, or null.
 *
 * Both integrations let the config name this file, and pointing it at
 * `~/.config/beadcause/confluence-token.txt` puts a credential in a file that directory
 * commits after every write. Not refused — that would turn a working integration off
 * over a filename — said out loud instead, on the same cadence as whatever else the
 * screen reports about that integration.
 */
export const tokenFileWarning = (file) => leakWarning(file);

/**
 * Whatever the site said about a failure, as one sentence, or null.
 *
 * The two products disagree about the shape, and a shared reader has to know both —
 * which is exactly the kind of fact that gets learned once and then written down in only
 * one of the two places that needed it:
 *
 * - **Confluence v2** answers `{ errors: [{ title, detail }] }` — an array.
 * - **JIRA v3** answers `{ errorMessages: [...], errors: { field: "why" } }` — a list of
 *   sentences, and an object keyed by *field*, which is not the same `errors` at all.
 *
 * Worth carrying: these are sentences a person can act on ("space ENG not found",
 * "current user not permitted", "the JQL is malformed near …"). Losing them to a bare
 * `HTTP 400` is the difference between a screen that says what to fix and one that says
 * something went wrong.
 */
export function saidAboutFailure(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const said = [];
  if (Array.isArray(parsed.errors)) {
    for (const e of parsed.errors) said.push(e?.title || e?.detail);
  } else if (parsed.errors && typeof parsed.errors === 'object') {
    for (const [field, why] of Object.entries(parsed.errors)) said.push(why ? `${field}: ${why}` : null);
  }
  if (Array.isArray(parsed.errorMessages)) said.push(...parsed.errorMessages);
  const text = said.filter(Boolean).map((s) => String(s).trim()).filter(Boolean).join('; ');
  return text || null;
}

/**
 * A network failure with a name, so a caller can phrase it in its own words.
 *
 * `timedOut` rather than sniffing `err.name === 'AbortError'` at every call site: the
 * abort is *ours*, we know why we raised it, and the alternative is two copies of a
 * string comparison against a class name node could rename.
 */
export class Unreachable extends Error {
  constructor(site, cause, timedOut) {
    super(String(cause?.message || cause || 'no answer'));
    this.name = 'AtlassianUnreachable';
    this.site = site;
    this.cause = cause;
    this.timedOut = timedOut;
  }
}

/**
 * One request, and the whole of what both integrations do the same way.
 *
 * It does four things and refuses to do a fifth. It **abandons** a request that has not
 * answered — Confluence had no timeout at all before this file, which is a publish that
 * can hang a request handler until the socket gives up. It turns a **fetch rejection**
 * into `Unreachable`, which is where "was that a timeout or a bad hostname" is decided,
 * once. It reads the body **exactly once**, as text, because a response body is a stream
 * that cannot be read twice and the error path wants the same bytes the success path
 * does. And it parses that text when it can, leaving `json` null when it cannot — an
 * HTML error page from a proxy is not a body worth quoting back.
 *
 * The fifth thing, which it does not do: decide what a status *means*. It hands back
 * `ok`, the status, and the two readings of the body, and every sentence a person sees
 * is written by the integration that knows what it was asking for.
 *
 * `method` and `body` are the caller's, and lib/jira.js's `method: 'GET'` literal is
 * still written at its own call site on purpose — test/jira.mjs reads that module's
 * source and asserts that every method literal in it is GET and that nothing in it
 * constructs a body. Moving the verb in here would have made that assertion vacuous
 * while leaving it green, which is the worst outcome available: a read-only guarantee
 * that has stopped guaranteeing anything and still passes.
 */
export async function send(
  url,
  { method = 'GET', headers = {}, body, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, redirect = 'follow' } = {}
) {
  const control = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => control.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(String(url), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: control.signal,
      redirect,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    // An abort is our own timeout; anything else is the network. The caller decides what
    // to say about it, but only one of us should have to know how to tell them apart.
    throw new Unreachable(url, err, err?.name === 'AbortError');
  }
  if (timer) clearTimeout(timer);

  const text = await res.text();
  let json = null;
  let parsed = false;
  try {
    if (text.trim()) {
      json = JSON.parse(text);
      parsed = true;
    }
  } catch {
    /* left null: not everything that answers an API is an API */
  }
  // `parsed` rather than `json !== null`, because those are not the same question: an
  // empty body, an HTML error page from a proxy, and a body that really is the four
  // bytes `null` all leave `json` null, and only one of them is a JIRA that has stopped
  // speaking JSON. The callers that report that as a fault need to be able to tell.
  return { ok: res.status >= 200 && res.status < 300, status: res.status, text, json, parsed };
}
