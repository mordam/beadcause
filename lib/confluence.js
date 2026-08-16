/**
 * Publishing a document to Confluence — outward, deliberately, and never by itself.
 *
 * **What this is for.** Work that reaches beadcause produces durable prose: a UX
 * review, a foundation, the summary a worker leaves behind. All of it lives in a repo
 * or on a bead, and both of those are places the team does not look. Confluence is
 * where they look. So a document beadcause can already *render* — anything the reader
 * tab at `/doc?p=…` opens — can be pushed to a page, and pushed again later to the
 * same page.
 *
 * **Two halves, and they are two switches.** Reading a page back *in* as context for
 * an agent is the other half — it arrived later, under bc-xecw, and it lives at the
 * bottom of this file behind its own gate. Nothing above it is affected by anything
 * below it: an install that publishes into `ENG` reads nothing at all until
 * `confluence.readSpaces` names a space, because the token that publishes can read the
 * entire site and inheriting would make that decision for somebody by accident.
 *
 * Four properties, and each of them is a decision that was made rather than fallen
 * into. They are the acceptance criteria of bc-c6qp, in the order they were argued:
 *
 * 1. **Re-publishing updates the page it made, it never makes a second one.** The page
 *    id is remembered in `state.json` under `published`, keyed by the document's own
 *    absolute path. If that record is ever lost — a state file restored from an older
 *    copy, a document published from a machine that is not this one — the space is
 *    still searched for a page with the same title before anything is created, so the
 *    worst case is an update to a page beadcause did not know it owned rather than a
 *    duplicate nobody notices for a month. Both halves matter: the record is fast and
 *    exact, the search is what makes losing it survivable.
 *
 * 2. **A re-publish overwrites the body; it does not append.** The document on the Mac
 *    is the source of truth and the page is a copy of it — appending would make the
 *    page a transcript of every version the document has ever had, which is both wrong
 *    and unreadable. Nothing is lost by overwriting: Confluence keeps its own version
 *    history, and every update this makes carries a version message saying beadcause
 *    published it and from which file.
 *
 * 3. **Publishing is never automatic.** There is no poller here, no hook, and nothing
 *    that publishes as a side effect of some other act. It happens when somebody
 *    presses a button, and the button names the space and the page title *before* it
 *    is pressed — `target()` is what the screen draws and `publish()` refuses a
 *    confirmation that does not match what `target()` would say right now. That is
 *    what makes "the target page was named before it happened" a property of the
 *    server rather than a promise the client makes.
 *
 * 4. **Unconfigured, nothing here runs and no credential is read.** `settings()` is
 *    the gate: with no `confluence` block in the config it answers null and the token
 *    file is never opened. The token itself is never in `config.json` — that file is
 *    committed to the git repo lib/commonrepo.js keeps, after every write, so a secret
 *    in it is in a history a rotation cannot reach back into. It goes in
 *    `~/.config/beadcause/confluence.key`, whose name that repo both ignores and
 *    refuses, at 0600. Same rule, same reasoning and the same two protections as the
 *    Google client secret in lib/auth.js — and the JIRA bead (bc-0i27) can reuse this
 *    path unchanged if it turns out to be the same Atlassian tenant.
 *
 * **Which spaces may publish.** A beadcause space (lib/spaces.js) may carry
 * `confluenceSpace`: a string names the Confluence space its workspaces publish into,
 * and `false` says this space may not publish at all. Absent, it inherits the global
 * `confluence.space`. It is deliberately *not* in `SETTINGS` — not editable from the
 * space details screen — for exactly the reason `name` and `workspaces` are not:
 * choosing where an evening's work gets published to a team's wiki is a config-file
 * act, not a thing to do with a thumb on a phone. Publishing is outward-facing and
 * hard to take back, and the whole point of this integration being deliberate is lost
 * if the target can be changed as easily as the act.
 */
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { spaceFor } from './spaces.js';
import {
  basicAuth,
  credentialFile,
  readCredential,
  saidAboutFailure,
  send,
  tokenFileWarning as atlassianTokenFileWarning,
  Unreachable,
  writeCredential,
} from './atlassian.js';

/**
 * How long one Confluence call may take before it is abandoned.
 *
 * Longer than lib/jira.js's, because this one is not only reads: a `PUT` of a long
 * document to a page with a big version history is the slowest thing beadcause asks
 * Atlassian for. It had no timeout at all until bc-jv4p, which is a publish that can
 * sit on a request handler until the socket gives up — the phone that pressed the
 * button gets nothing back and cannot tell that from a publish still in flight.
 */
const TIMEOUT_MS = 30000;

/**
 * Where the API token is read from when the config does not name a file.
 *
 * `.key`, and the extension is the entire reason for the name — see the header, and
 * `google-client-secret.key` beside it, which is named on the same reasoning. Derived
 * from lib/atlassian.js rather than spelled out, so the name in the README and the name
 * the denylist actually protects cannot become two different strings.
 */
export const DEFAULT_TOKEN_FILE = path.basename(credentialFile('confluence'));

/**
 * The file the API token is read from — yours if you named one, ours if you did not.
 *
 * A relative `apiTokenFile` resolves *inside* `CONFIG_DIR`, which is both the obvious
 * reading of `"confluence.key"` and the same rule `jira.<workspace>.tokenFile` follows.
 * It used to be taken as written, and a relative one was then resolved against whatever
 * directory the daemon started in — a token that reads correctly by hand from the repo
 * and is missing under launchd.
 */
export const apiTokenFile = (cfg = {}) => {
  const named = String(cfg.confluence?.apiTokenFile || '').trim();
  return named ? path.resolve(CONFIG_DIR, named) : credentialFile('confluence');
};

/**
 * The API token: the env var, or a file. There is deliberately no third place.
 *
 * `read` is injectable so a test can prove the stronger half of the fourth property
 * above — that an unconfigured install does not so much as *open* the file. Asserting
 * "no credential is read" any other way means asserting about atimes, which is not a
 * thing a suite can do honestly.
 */
export function apiToken(cfg = {}, opts = {}) {
  return readCredential(apiTokenFile(cfg), { envVar: 'BEADCAUSE_CONFLUENCE_TOKEN', ...opts });
}

/**
 * Write the API token to wherever `apiTokenFile` says, at 0600. The mode is atlassian's.
 *
 * The mirror of `writeToken` in lib/jira.js, and it exists for the same reason that one
 * does: `npm run configure` asks for the token now (lib/confluencesetup.js), and a setup
 * script that wrote a credential itself would be a second place that knows the mode. One
 * function knows the number — see `writeCredential`.
 */
export const writeApiToken = (cfg = {}, token) => writeCredential(apiTokenFile(cfg), token);

/** `https://x.atlassian.net/wiki/` → `https://x.atlassian.net`. Null for nonsense. */
function normalSite(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * What the config says, or null when it says nothing at all.
 *
 * Null is the gate the fourth property rests on, so it is asked *first* by everything
 * below and it touches no file. A block that is present but incomplete is a different
 * answer — see `problem`, which is what the screen says out loud.
 */
export function settings(cfg = {}) {
  const c = cfg.confluence;
  if (!c || typeof c !== 'object') return null;
  const site = normalSite(c.site);
  const email = String(c.email || '').trim();
  const space = String(c.space || '').trim();
  if (!site || !email) return null;
  return { site, email, space: space || null };
}

/**
 * Why publishing is off, in one sentence, or null when it is on — or when nothing was
 * ever asked for.
 *
 * The silence for an install with no `confluence` block is the point: an install that
 * never wanted this must not be told off about it, which is the same shape as
 * `googleProblem` in lib/auth.js and for the same reason.
 */
export function problem(cfg = {}, opts) {
  const c = cfg.confluence;
  if (!c || typeof c !== 'object') return null;
  // An empty block is the *default* block — `defaults()` writes one so the fields are
  // discoverable in config.json — and an install that has filled none of it in has not
  // asked for anything to work. Silence, and no file opened, exactly as if it were
  // absent. Anything filled in is somebody meaning it, and then a gap is worth saying.
  if (!['site', 'email', 'space'].some((k) => String(c[k] || '').trim())) return null;
  if (!normalSite(c.site)) return 'confluence.site is missing or is not a URL';
  if (!String(c.email || '').trim()) return 'confluence.email is missing — it is the Atlassian account the token belongs to';
  if (!apiToken(cfg, opts)) return `no API token — put one in ${apiTokenFile(cfg)} at 0600, or in BEADCAUSE_CONFLUENCE_TOKEN`;
  if (!String(c.space || '').trim() && !(cfg.spaces || []).some((s) => typeof s.confluenceSpace === 'string')) {
    return 'no Confluence space to publish into — set confluence.space, or confluenceSpace on a space';
  }
  return null;
}

/**
 * A token file inside the config repo that the denylist does not refuse.
 *
 * The same hole `secretFileWarning` covers in lib/auth.js and `tokenFileWarning` now
 * covers in lib/jira.js: `apiTokenFile` is yours to point anywhere, and pointing it at
 * `~/.config/beadcause/confluence-token.txt` puts a credential in a file that directory
 * commits after every write. Not refused — that would turn a working integration off
 * over a filename — said out loud instead.
 *
 * The rule itself is `leakWarning` in lib/commonrepo.js now, which is the module that
 * owns the denylist. This used to ask a hand-copied `/\.(key|secret)$/` instead, and so
 * said nothing at all about `.pem`, `.p12` or a file called `google-client-secret` —
 * three names the real list refuses, which meant the *warning* and the *refusal* had
 * quietly stopped agreeing about which files are safe.
 */
export function tokenFileWarning(cfg = {}) {
  if (!cfg.confluence) return null;
  return atlassianTokenFileWarning(apiTokenFile(cfg));
}

/**
 * The Confluence space this workspace publishes into, or null if it may not publish.
 *
 * `false` on a beadcause space is a refusal and not "inherit", which is why this reads
 * the field's type rather than its truthiness: a space that has said no must not start
 * publishing again the day somebody sets the global default.
 */
export function spaceKeyFor(cfg = {}, workspace) {
  const own = spaceFor(cfg, workspace)?.confluenceSpace;
  if (own === false) return null;
  if (typeof own === 'string' && own.trim()) return own.trim();
  return settings(cfg)?.space || null;
}

/* ------------------------------------------------------------------ the document */

/**
 * The page title for a document: its first `# heading`, or its filename.
 *
 * The heading first because that is what the document calls itself, and a page called
 * "ux-review" beside one called "UX review — the inbox" reads as two different
 * documents. The filename is the fallback rather than the rule because a document with
 * no heading has nothing better to offer, and an untitled page is not an option: the
 * title is the key a lost `published` record is recovered by.
 */
export function titleFor(filePath, text = '') {
  const heading = String(text).match(/^\s{0,3}#\s+(.+?)\s*$/m);
  if (heading) return heading[1].replace(/\s+#*\s*$/, '').trim().slice(0, 250);
  return path.basename(String(filePath || 'document')).replace(/\.(md|markdown)$/i, '') || 'document';
}

const VOID = ['br', 'hr', 'img', 'input', 'col', 'meta', 'link'];

/**
 * Markdown → Confluence storage format.
 *
 * Storage format is XHTML, and marked's output is HTML — so the whole of the
 * difference is void elements, which XHTML insists are closed. Everything else marked
 * emits (`<p>`, `<h2>`, `<ul>`, `<table>`, `<pre><code>`, `<blockquote>`) is storage
 * format already.
 *
 * Two things it deliberately does not do, both worth knowing before you read a
 * published page and think something is broken:
 *
 * - **A fenced code block arrives as preformatted text, not the Confluence code
 *   macro.** The macro would be prettier and it is a `<ac:structured-macro>` wrapped
 *   around escaped text, which means parsing marked's output back out again. Not worth
 *   the class of bug that invites for a first version.
 * - **A mermaid block arrives as its source.** Confluence has no mermaid without an
 *   app installed, so the honest rendering of a diagram is the text that describes it.
 *
 * `dropLeadingHeading` is on for a publish and is not cosmetic: the page's title *is*
 * that heading (see `titleFor`), and Confluence draws the title above the body — so
 * leaving it in publishes every document with its own name written twice.
 *
 * `marked` is imported lazily because this module is loaded by lib/server.js at boot
 * and the parser is only ever wanted at the moment somebody publishes.
 */
export async function toStorage(markdown, { dropLeadingHeading = false } = {}) {
  const { marked } = await import('marked');
  let text = String(markdown || '');
  if (dropLeadingHeading) text = text.replace(/^\s*#\s+.*(?:\r?\n)?/, '');
  let html = marked.parse(text, { gfm: true, breaks: false });
  for (const tag of VOID) {
    html = html.replace(new RegExp(`<${tag}([^>]*?)\\s*/?>`, 'gi'), (m, attrs) => `<${tag}${attrs} />`);
  }
  // A task list is the one thing marked emits that storage format has no element for.
  html = html
    .replace(/<input[^>]*checked[^>]*\/>/gi, '☑ ')
    .replace(/<input[^>]*\/>/gi, '☐ ');
  return html;
}

/* -------------------------------------------------------------------- the record */

/**
 * How many published documents are remembered.
 *
 * A cap and deliberately **no TTL**, which is where this differs from every other
 * keyed record in `state.json`. `answered` expires because a stale answer is merely
 * uninteresting; a `published` record that expires is a *second page*, silently, the
 * next time somebody publishes a document they last touched a year ago. The cap is
 * here only so the file cannot grow without bound, and it is high enough that reaching
 * it means something else has gone wrong.
 */
export const PUBLISHED_MAX = 500;

/** Newest first, capped. Pure, like `pruneAnswered`, so the tests need no filesystem. */
export function prunePublished(published, max = PUBLISHED_MAX) {
  const rows = Object.entries(published || {});
  if (rows.length <= max) return { ...(published || {}) };
  rows.sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || '')));
  return Object.fromEntries(rows.slice(0, max));
}

/**
 * The key a publish record lives under: the document's own absolute path.
 *
 * Everything else in `state.json` is keyed `workspace/id` because everything else is
 * about a bead. This is about a *file*, and a file on this Mac is unique whichever
 * workspace happens to be looking at it — keying it by workspace as well would let one
 * document become two pages by being published from two screens.
 */
export const publishKey = (filePath) => path.resolve(String(filePath || ''));

/* ---------------------------------------------------------------------- the API */

class ConfluenceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ConfluenceError';
    this.status = status;
  }
}

/**
 * One call to the Confluence Cloud v2 API.
 *
 * The error path is the interesting half: an Atlassian failure is a JSON body with an
 * `errors[]` in it, and the message inside is a sentence a person can act on ("space
 * ENG not found", "current user not permitted"). Losing that to a bare `HTTP 400` is
 * the difference between a screen that says what to fix and one that says something
 * went wrong. Reading it out of the body is lib/atlassian.js's job since bc-jv4p, only
 * because JIRA wants the same thing out of a differently-shaped body; deciding what to
 * *do* about a status stays here, and is the half that must not be shared.
 */
async function call(conf, method, endpoint, body, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const url = `${conf.site}/wiki/api/v2${endpoint}`;
  let res;
  try {
    res = await send(url, {
      method,
      headers: {
        Authorization: basicAuth(conf.email, conf.token),
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      fetchImpl,
      timeoutMs,
    });
  } catch (err) {
    if (!(err instanceof Unreachable)) throw err;
    const why = err.timedOut ? `no answer in ${Math.round(timeoutMs / 1000)}s` : err.message;
    throw new ConfluenceError(`could not reach ${conf.site} — ${why}`, 502);
  }
  if (!res.ok) {
    const said = saidAboutFailure(res.json);
    // 502 whatever Confluence said, including its 401: the caller of this daemon is
    // not the one who got the credential wrong, and answering 401 to a phone that is
    // signed in perfectly well would send it to a login screen it does not need.
    throw new ConfluenceError(`Confluence ${res.status}${said ? ` — ${said}` : ''}`, 502);
  }
  return res.json;
}

/** The space's internal id, which every other v2 call wants instead of its key. */
async function spaceId(conf, key, opts) {
  const found = await call(conf, 'GET', `/spaces?keys=${encodeURIComponent(key)}&limit=1`, null, opts);
  const row = found?.results?.[0];
  if (!row?.id) throw new ConfluenceError(`no Confluence space with key ${key} on ${conf.site}`, 404);
  return String(row.id);
}

/** A current page in this space with exactly this title, or null. */
async function pageByTitle(conf, id, title, opts) {
  const found = await call(
    conf,
    'GET',
    `/spaces/${encodeURIComponent(id)}/pages?title=${encodeURIComponent(title)}&status=current&limit=25`,
    null,
    opts
  );
  return (found?.results || []).find((r) => r.title === title) || null;
}

/**
 * The page's address for a person, which is not the address the API uses.
 *
 * `_links.webui` is relative to `_links.base`, and `base` is only on the *envelope* of
 * a list response — so it is passed in where there is one and rebuilt from the site
 * otherwise. A URL is the whole product of this feature as far as a bead is concerned,
 * so it is worth the two fallbacks rather than a link that is right most of the time.
 */
export function pageUrl(conf, page, base) {
  const webui = page?._links?.webui;
  if (webui && /^https?:/i.test(webui)) return webui;
  const root = base || page?._links?.base || `${conf.site}/wiki`;
  if (webui) return `${root.replace(/\/$/, '')}${webui.startsWith('/') ? '' : '/'}${webui}`;
  return `${conf.site}/wiki/spaces/${page?.spaceId || ''}/pages/${page?.id || ''}`;
}

/* --------------------------------------------------------------- naming, then act */

/**
 * What publishing this document *would* do, named before it happens.
 *
 * This is what the screen draws, and it is also what `publish` re-derives and compares
 * a confirmation against. Both halves come from here on purpose: a preview computed
 * one way and an act computed another is exactly how a button ends up meaning
 * something other than what it said.
 *
 * It reaches Confluence only far enough to answer "does this page exist already" —
 * a space lookup and a title search, both GETs. An install whose token has gone stale
 * therefore finds out here, on the screen, rather than half way through a publish.
 */
export async function target(cfg, { workspace, filePath, text, state = {} }, opts = {}) {
  const conf = settings(cfg);
  if (!conf) return null;
  const token = apiToken(cfg, opts);
  if (!token) return null;
  const spaceKey = spaceKeyFor(cfg, workspace);
  if (!spaceKey) {
    return { publishable: false, why: `no Confluence space is configured for ${workspace || 'this document'}` };
  }

  const title = titleFor(filePath, text);
  const key = publishKey(filePath);
  const remembered = (state.published || {})[key] || null;

  const full = { ...conf, token };
  let existing = null;
  if (remembered?.pageId) {
    try {
      const page = await call(full, 'GET', `/pages/${encodeURIComponent(remembered.pageId)}`, null, opts);
      if (page?.id) existing = { pageId: String(page.id), title: page.title, version: page.version?.number || null, url: remembered.url || pageUrl(full, page) };
    } catch {
      // A page that has been deleted or moved out of reach is not an error to report
      // here — it is simply not there, and the title search below is what decides
      // between updating something else and creating one.
      existing = null;
    }
  }
  if (!existing) {
    const id = await spaceId(full, spaceKey, opts);
    const found = await pageByTitle(full, id, title, opts);
    if (found) existing = { pageId: String(found.id), title: found.title, version: found.version?.number || null, url: pageUrl(full, found) };
  }

  return {
    publishable: true,
    site: conf.site,
    spaceKey,
    title,
    file: key,
    action: existing ? 'update' : 'create',
    existing,
    lastPublished: remembered ? { at: remembered.at, by: remembered.by || null, url: remembered.url } : null,
  };
}

/**
 * Publish it. Returns the record to be written into `state.json` under `published`.
 *
 * `confirm` is not optional and not a formality: it is `{ spaceKey, title }` as the
 * screen showed them, and a mismatch against what `target` says *now* is refused with
 * a 409. That is what stops the two ways a named target can stop being true between
 * being drawn and being pressed — the document's `# heading` was edited in the
 * meantime, or the space it belongs to was reconfigured — and it is the only way the
 * "named before it happens" property can be enforced anywhere but in the client.
 */
export async function publish(cfg, { workspace, filePath, text, state = {}, actor = null, confirm }, opts = {}) {
  const conf = settings(cfg);
  if (!conf) throw new ConfluenceError('Confluence is not configured', 400);
  const token = apiToken(cfg, opts);
  if (!token) throw new ConfluenceError(`no Confluence API token — ${apiTokenFile(cfg)}`, 400);

  const plan = await target(cfg, { workspace, filePath, text, state }, opts);
  if (!plan?.publishable) throw new ConfluenceError(plan?.why || 'this document may not be published', 403);
  if (!confirm || confirm.spaceKey !== plan.spaceKey || confirm.title !== plan.title) {
    throw new ConfluenceError(
      `this would now publish "${plan.title}" to ${plan.spaceKey}, which is not what you were shown — read it again and press again`,
      409
    );
  }

  const full = { ...conf, token };
  const value = await toStorage(text, { dropLeadingHeading: true });
  const body = { representation: 'storage', value };
  const message = `published by beadcause from ${plan.file}`;

  let page;
  if (plan.existing) {
    const current = await call(full, 'GET', `/pages/${encodeURIComponent(plan.existing.pageId)}`, null, opts);
    const version = Number(current?.version?.number || plan.existing.version || 1) + 1;
    page = await call(
      full,
      'PUT',
      `/pages/${encodeURIComponent(plan.existing.pageId)}`,
      { id: String(plan.existing.pageId), status: 'current', title: plan.title, body, version: { number: version, message } },
      opts
    );
  } else {
    const id = await spaceId(full, plan.spaceKey, opts);
    page = await call(full, 'POST', '/pages', { spaceId: id, status: 'current', title: plan.title, body }, opts);
  }

  return {
    pageId: String(page?.id || plan.existing?.pageId || ''),
    url: pageUrl(full, page),
    title: plan.title,
    spaceKey: plan.spaceKey,
    site: conf.site,
    version: page?.version?.number || null,
    action: plan.action,
    file: plan.file,
    workspace: workspace || null,
    at: new Date().toISOString(),
    by: actor,
  };
}


/* =========================================================== reading one back in */

/**
 * The other half: a named Confluence page, read into an agent's context.
 *
 * The publish half above pushes prose *out* to a page. This pushes nothing; it reads
 * one page and prints it. It is a separate decision rather than a smaller version of
 * the same one, and bc-xecw is where the four questions it turns on were settled. All
 * four answers are conservative, and each of them is a thing that could reasonably
 * have gone the other way:
 *
 * 1. **Which pages may be read: only the spaces named in `confluence.readSpaces`, and
 *    the list is empty until you write it.** A token that can publish can read the
 *    whole site, so "read-in is on because publishing is configured" would quietly
 *    mean *every agent this Mac dispatches may read the company wiki* — including the
 *    HR space, including the space with the incident write-ups in it. So reading is
 *    off even on an install that publishes happily, and turning it on is naming the
 *    spaces one at a time. The check is against the space Confluence says the page is
 *    **actually** in, never against what the caller claimed, which is what stops a
 *    page id from an unlisted space being read by pointing at it directly.
 *
 * 2. **Who reads it: the same unattended agents that already have the lookup grant,
 *    through the same shape of wrapper** (`bin/beadcause-confluence`,
 *    `Bash(beadcause-confluence:*)`). Worth being honest about how this differs from
 *    `beadcause-get`: that one reaches *public* URLs and acts as nobody, and this one
 *    carries Adam's Atlassian token and therefore reads as Adam. The narrowing that
 *    makes it grantable is the allowlist above plus the shape of the command — it
 *    takes a page and prints it, and there is no code path here that writes, searches
 *    the site, lists a space, or reads an attachment. It is inert on an install that
 *    has not named a space, so the grant costs an install that never wanted this
 *    exactly nothing.
 *
 * 3. **What it becomes: markdown, converted from storage format** (`fromStorage`),
 *    with the page's own metadata printed above it. Not `atlas_doc_format`, which is a
 *    JSON tree an agent would have to be taught to read, and not the raw XHTML, which
 *    spends an agent's context on markup. The conversion is lossy in ways that are
 *    listed rather than hidden — see `fromStorage`.
 *
 * 4. **Fetched every time, never cached.** A wiki page is edited by other people and a
 *    cached copy read as current is a wrong fact with nothing on it to say so. The
 *    version number and the last-updated date come back with every read for exactly
 *    that reason: they are what makes the page citable, in the same way
 *    `beadcause-get` prints the URL it actually landed on.
 *
 * The one thing this deliberately does **not** do is search. "Find the page about the
 * on-call rota" is a nice affordance and it is a different capability — it reaches
 * every title in a space rather than a page somebody named, and it is the shape that
 * turns a narrow grant back into a wide one. A page is named by URL, by id, or by
 * `SPACE/Title`, and the URL is what a bead comment or a person actually pastes.
 */

/**
 * The spaces an agent may read, uppercased, or `[]` when read-in is off.
 *
 * Space keys are case-insensitive at Atlassian and are conventionally upper case, so
 * they are normalised here rather than at each comparison — a config that says `eng`
 * and a URL that says `ENG` are the same space, and finding that out at the refusal is
 * finding it out too late.
 */
export function readableSpaces(cfg = {}) {
  const raw = cfg.confluence?.readSpaces;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const seen = new Set();
  for (const entry of list) {
    const key = String(entry || '').trim().toUpperCase();
    if (key) seen.add(key);
  }
  return [...seen];
}

/** Is this space key one an agent may read from? */
export const readable = (cfg, spaceKey) =>
  readableSpaces(cfg).includes(String(spaceKey || '').trim().toUpperCase());

/**
 * Why reading is off, in one sentence, or null when it is on.
 *
 * Same shape and same silence rule as `problem` above: an install that has asked for
 * nothing is not told off. The difference is that a *complete* publish config is still
 * "asked for nothing" here — `readSpaces` is the ask, and its absence is a decision
 * rather than an omission to nag about.
 */
export function readProblem(cfg = {}, opts) {
  if (!readableSpaces(cfg).length) return null;
  if (!settings(cfg)) return 'confluence.readSpaces is set but confluence.site or confluence.email is missing';
  if (!apiToken(cfg, opts)) return `no API token — put one in ${apiTokenFile(cfg)} at 0600, or in BEADCAUSE_CONFLUENCE_TOKEN`;
  return null;
}

/**
 * Both halves in one line, for a screen that has room for one — `signinStatus`'s shape,
 * and it is here rather than in the setup block for the same reason that one is in
 * lib/auth.js: what the config *means* belongs beside the config, and two callers say it
 * (the `npm run configure` summary, and the block that asks the questions).
 *
 * **Both halves, always, and that is the whole point of the line.** Publishing and
 * reading are two switches with two answers, and a status that reported the first would
 * say "Confluence is on" about an install where every unattended agent reads nothing —
 * which is the state `readSpaces` starts every install in, deliberately. They can also
 * disagree in the other direction: a site with no `space` and no space naming its own
 * cannot publish and can still read perfectly well.
 *
 * `off` is reserved for an install that has asked for nothing at all, so the summary of
 * a machine that never wanted this says one word rather than two clauses of nothing.
 */
export function confluenceStatus(cfg = {}, opts) {
  const set = settings(cfg);
  const why = problem(cfg, opts);
  const readWhy = readProblem(cfg, opts);
  const spaces = readableSpaces(cfg);
  const on = Boolean(set) && !why;
  const reading = spaces.length > 0 && !readWhy;
  if (!on && !why && !reading && !readWhy) return { on: false, reading: false, text: 'off' };
  // "the spaces that name their own" rather than a space key: with no global `space`,
  // `problem` is satisfied by a beadcause space carrying `confluenceSpace`, and naming
  // the global default there would be naming a thing that is not set.
  const publishText = on
    ? `publishing into ${set.space || 'the spaces that name their own'}`
    : why
      ? `NOT publishing — ${why}`
      : 'not publishing';
  const readText = reading ? `reading ${spaces.join(', ')}` : readWhy ? `NOT reading — ${readWhy}` : 'reading nothing';
  return { on, reading, text: `${publishText}, ${readText}` };
}

/**
 * What the caller named, as either a page id or a space-and-title.
 *
 * Three spellings, because there are three ways a page gets referred to in practice: a
 * URL somebody pasted out of their browser, the id out of a previous run's output, and
 * the space and title a person would say out loud.
 *
 * The short link (`/wiki/x/AbCdEf`) is refused with its own message rather than falling
 * through to "not a page reference". It is a real Confluence URL and resolving it means
 * following a redirect the API does not serve, so the useful answer is to say what it
 * is and ask for the long one — which is one click away in the same browser it came
 * from.
 */
export function parseRef(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) return { pageId: text };

  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    const byId = /\/pages\/(\d+)/.exec(url.pathname);
    if (byId) {
      const space = /\/spaces\/([^/]+)/.exec(url.pathname);
      return { pageId: byId[1], claimedSpace: space ? decodeURIComponent(space[1]).toUpperCase() : null };
    }
    const pageIdParam = url.searchParams.get('pageId');
    if (pageIdParam && /^\d+$/.test(pageIdParam)) return { pageId: pageIdParam };
    if (/^\/wiki\/x\//.test(url.pathname)) return { shortLink: true };
    return null;
  }

  const slash = text.indexOf('/');
  if (slash > 0) {
    const spaceKey = text.slice(0, slash).trim().toUpperCase();
    const title = text.slice(slash + 1).trim();
    if (spaceKey && title) return { spaceKey, title };
  }
  return null;
}

/* ------------------------------------------------- storage format back to markdown */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  middot: '·', times: '×',
};

/** `&amp;` → `&`. Numeric first, because a page written by a person is full of them. */
function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** `ac:name="code"` → `{'ac:name': 'code'}`. Single and double quotes both. */
function parseAttrs(raw) {
  const out = {};
  for (const m of String(raw || '').matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return out;
}

const READ_VOID = new Set(['br', 'hr', 'img', 'input', 'col', 'meta', 'link', 'ri:page', 'ri:attachment', 'ri:url', 'ri:user']);

/**
 * Storage format (XHTML) → markdown, walked rather than regexed.
 *
 * The regex version of this works until the first nested list and the first table, and
 * a wiki page is mostly nested lists and tables — so it is a tokeniser and a stack,
 * which is more code and the only version that can indent a sub-list correctly or know
 * which row of a table was the header.
 *
 * What it does **not** preserve, said out loud so a thin-looking result is not read as
 * a broken page:
 *
 * - **A macro that is not one of the handful named below arrives as a placeholder**
 *   (`[jira macro]`), because a macro is a server-side include: its content is not in
 *   the storage format at all and no amount of parsing will find it. Saying which
 *   macro was there is the honest answer; emitting nothing silently would let an agent
 *   read a page as saying less than it does.
 * - **Layouts, columns and panels flatten.** Confluence's `ac:layout` machinery is
 *   presentation, and markdown has nowhere to put it.
 * - **An image arrives as its filename**, since the bytes are an attachment behind the
 *   same credential and this reads pages.
 * - **A table nested inside a table cell is dropped.** Markdown has no such thing, and
 *   the inner rows would otherwise merge silently into the outer table, which is worse
 *   than losing them.
 */
export function fromStorage(xhtml) {
  const src = String(xhtml || '');
  const out = [];          // finished blocks, joined with a blank line at the end
  let inline = '';         // the block being accumulated
  const lists = [];        // one entry per open ul/ol: {ordered, n}
  let listBuf = null;      // the lines of the outermost open list
  const quotes = [];       // where in `out` each open blockquote began
  let table = null;        // {rows, header} while inside one
  let row = null;
  let cell = null;
  let pre = false;         // inside a code fence: whitespace is content
  let param = 0;           // inside `ac:parameter`: configuration, not prose
  const linkStack = [];

  const block = (text) => {
    if (text) out.push(text);
  };
  const write = (text) => {
    if (cell !== null) cell += text;
    else inline += text;
  };

  /** The accumulated block, tidied. `raw` keeps the whitespace, which code needs. */
  const flush = (raw = false) => {
    const text = raw
      ? inline.replace(/^\n+|\n+$/g, '')
      : inline.replace(/[ \t]+/g, ' ').replace(/ +\n/g, '\n').trim();
    inline = '';
    return text;
  };

  /**
   * One list item becomes one *line*, not one block.
   *
   * This is the whole reason a list is buffered rather than emitted item by item: the
   * blocks are joined with a blank line at the end, so an item-per-block turns every
   * list on the page into a loose one, and — worse — the leading indent that makes a
   * sub-list a sub-list is exactly what a block-level trim removes.
   */
  const pushItem = () => {
    // The leading run of spaces is the nesting and survives; every other run of
    // whitespace is XHTML's own indentation and collapses. Collapsing both is how a
    // sub-list ends up one space in, which is one short of what markdown reads as one.
    const lead = /^[ \t]*/.exec(inline)[0];
    const text = lead + inline.slice(lead.length).replace(/[ \t]+/g, ' ').replace(/\s+$/, '');
    inline = '';
    if (text.trim()) listBuf.push(text);
  };

  /** End whatever is open: a line if we are inside a list, a block otherwise. */
  const breakBlock = () => {
    if (lists.length && listBuf) pushItem();
    else block(flush());
  };

  const endFence = () => {
    if (!pre) return;
    pre = false;
    write('\n```');
    block(flush(true));
  };

  for (const t of src.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/?([\w:-]+)((?:"[^"]*"|'[^']*'|[^>])*?)\/?>|([^<]+)/g)) {
    if (t[1] !== undefined) {                       // CDATA — verbatim, it is code
      write(t[1]);
      continue;
    }
    if (t[4] !== undefined) {                       // text
      // A macro parameter is how the macro was configured — the `language` of a code
      // block, the `key` of a Jira link. Emitting it puts the word `bash` on the first
      // line of the fence, which reads as part of the command.
      if (!param) write(pre ? t[4] : decodeEntities(t[4]).replace(/\s+/g, ' '));
      continue;
    }
    if (t[2] === undefined) continue;               // a comment
    const raw = t[0];
    const name = t[2].toLowerCase();
    const closing = raw.startsWith('</');
    const attrs = closing ? {} : parseAttrs(t[3]);
    const selfClosing = !closing && (raw.endsWith('/>') || READ_VOID.has(name));

    if (!closing) {
      switch (name) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          breakBlock();
          write(`${'#'.repeat(Number(name[1]))} `);
          break;
        case 'p': case 'div':
          breakBlock();
          break;
        case 'br':
          write('\n');
          break;
        case 'hr':
          breakBlock();
          block('---');
          break;
        case 'strong': case 'b': write('**'); break;
        case 'em': case 'i': write('*'); break;
        case 'del': case 's': write('~~'); break;
        case 'code': if (!pre) write('`'); break;
        case 'pre':
          breakBlock();
          pre = true;
          write('```\n');
          break;
        case 'blockquote':
          breakBlock();
          quotes.push(out.length);
          break;
        case 'a':
          linkStack.push(attrs.href || '');
          write('[');
          break;
        case 'ul': case 'ol':
          breakBlock();
          lists.push({ ordered: name === 'ol', n: 0 });
          if (lists.length === 1) listBuf = [];
          break;
        case 'li': {
          breakBlock();
          const depth = Math.max(0, lists.length - 1);
          const list = lists[depth] || { ordered: false, n: 0 };
          list.n += 1;
          write(`${'  '.repeat(depth)}${list.ordered ? `${list.n}. ` : '- '}`);
          break;
        }
        case 'table':
          breakBlock();
          // A nested table would merge into the one outside it. The outer one wins and
          // the inner rows are dropped — said out loud in the header above.
          if (!table) table = { rows: [], header: false };
          break;
        case 'tr': if (table) row = []; break;
        case 'th': case 'td':
          if (table) {
            cell = '';
            if (name === 'th' && table.rows.length === 0) table.header = true;
          }
          break;
        case 'ac:structured-macro': {
          const macro = attrs['ac:name'] || 'macro';
          if (macro === 'code' || macro === 'noformat') {
            breakBlock();
            pre = true;
            write('```\n');
          } else if (['info', 'note', 'warning', 'tip', 'panel', 'expand'].includes(macro)) {
            breakBlock();
          } else if (!['toc', 'children', 'anchor'].includes(macro)) {
            breakBlock();
            block(`[${macro} macro]`);
          }
          break;
        }
        case 'ac:parameter': param += 1; break;
        case 'ri:page': write(attrs['ri:content-title'] || ''); break;
        case 'ri:attachment': write(attrs['ri:filename'] || 'attachment'); break;
        case 'ri:url': write(attrs['ri:value'] || ''); break;
        case 'ri:user': write(`@${attrs['ri:account-id'] || 'user'}`); break;
        case 'ac:image': write('!['); break;
        case 'time': write(attrs.datetime || ''); break;
        default: break;
      }
      if (selfClosing) continue;
    }

    // Everything below is what a *closing* tag does. An opening tag that got this far
    // has already been handled above and must not fall through — `<strong>` writing the
    // opening `**` and then the closing one in the same pass is the shape of bug this
    // guard exists for, and it is invisible until you read a rendered page.
    if (!closing) continue;

    switch (name) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      case 'p': case 'div':
        breakBlock();
        break;
      case 'strong': case 'b': write('**'); break;
      case 'em': case 'i': write('*'); break;
      case 'del': case 's': write('~~'); break;
      case 'code': if (!pre) write('`'); break;
      case 'pre': case 'ac:plain-text-body':
        endFence();
        break;
      case 'blockquote': {
        // Everything the quote contained is already in `out` as ordinary blocks — a
        // quote can hold paragraphs, lists and a table — so it is taken back out and
        // re-emitted with the marker on every line. Prefixing `inline` alone would
        // quote the last paragraph and silently unquote the rest.
        breakBlock();
        const start = quotes.pop() ?? out.length;
        const inner = out.splice(start).join('\n\n');
        block(inner ? inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') : '');
        break;
      }
      case 'a': {
        const href = linkStack.pop() || '';
        write(href ? `](${href})` : ']');
        break;
      }
      case 'ac:image': write(']'); break;
      case 'ac:parameter': param = Math.max(0, param - 1); break;
      case 'li': breakBlock(); break;
      case 'ul': case 'ol':
        breakBlock();
        lists.pop();
        if (!lists.length && listBuf) {
          block(listBuf.join('\n'));
          listBuf = null;
        }
        break;
      case 'th': case 'td':
        if (table && row) row.push(String(cell || '').replace(/\s+/g, ' ').trim());
        cell = null;
        break;
      case 'tr':
        if (table && row) table.rows.push(row);
        row = null;
        break;
      case 'table':
        if (table) {
          const width = Math.max(0, ...table.rows.map((r) => r.length));
          const lines = table.rows.map(
            (r) => `| ${[...r, ...Array(Math.max(0, width - r.length)).fill('')].map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`
          );
          if (lines.length && table.header) lines.splice(1, 0, `|${' --- |'.repeat(width)}`);
          block(lines.join('\n'));
          table = null;
        }
        break;
      case 'ac:structured-macro':
        endFence();
        breakBlock();
        break;
      default: break;
    }
  }
  endFence();
  if (listBuf) {
    pushItem();
    block(listBuf.join('\n'));
    listBuf = null;
  }
  block(flush());
  return out
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/* --------------------------------------------------------------------- the read */

/** The ids of the spaces an agent may read, as `id → key`. One call, however many. */
async function readableSpaceIds(conf, keys, opts) {
  if (!keys.length) return new Map();
  const query = keys.map((k) => `keys=${encodeURIComponent(k)}`).join('&');
  const found = await call(conf, 'GET', `/spaces?${query}&limit=${keys.length}`, null, opts);
  const map = new Map();
  for (const row of found?.results || []) {
    if (row?.id) map.set(String(row.id), String(row.key || '').toUpperCase());
  }
  return map;
}

/**
 * Read a named page, or refuse and say which of the reasons it was.
 *
 * The order of the checks is the point. Configuration first, so an install that never
 * turned this on never opens the token file; then the reference, which costs nothing;
 * then — for a space-and-title reference — the allowlist, *before* any call, so a page
 * in an unlisted space is refused without Confluence being told anybody was interested.
 * A page-id reference cannot be checked that way, since only Confluence knows which
 * space an id is in, so that one is fetched and then refused on the answer.
 */
export async function readPage(cfg, ref, opts = {}) {
  const allowed = readableSpaces(cfg);
  if (!allowed.length) {
    throw new ConfluenceError('reading Confluence pages is off — no spaces are listed in confluence.readSpaces', 403);
  }
  const conf = settings(cfg);
  if (!conf) throw new ConfluenceError('Confluence is not configured — confluence.site and confluence.email', 400);
  const token = apiToken(cfg, opts);
  if (!token) throw new ConfluenceError(`no Confluence API token — ${apiTokenFile(cfg)}`, 400);

  const parsed = typeof ref === 'string' ? parseRef(ref) : ref;
  if (parsed?.shortLink) {
    throw new ConfluenceError(
      'that is a Confluence short link, which only a browser can resolve — open it and use the long URL, the one with /pages/<id> in it',
      400
    );
  }
  if (!parsed || (!parsed.pageId && !(parsed.spaceKey && parsed.title))) {
    throw new ConfluenceError('not a page reference — give a page URL, a page id, or SPACE/Page title', 400);
  }
  if (parsed.spaceKey && !allowed.includes(parsed.spaceKey)) {
    throw new ConfluenceError(
      `space ${parsed.spaceKey} is not one this install may read — confluence.readSpaces names ${allowed.join(', ')}`,
      403
    );
  }

  const full = { ...conf, token };
  const byId = await readableSpaceIds(full, allowed, opts);

  let pageId = parsed.pageId;
  if (!pageId) {
    const id = await spaceId(full, parsed.spaceKey, opts);
    const found = await pageByTitle(full, id, parsed.title, opts);
    if (!found) throw new ConfluenceError(`no current page titled "${parsed.title}" in ${parsed.spaceKey}`, 404);
    pageId = String(found.id);
  }

  const page = await call(full, 'GET', `/pages/${encodeURIComponent(pageId)}?body-format=storage`, null, opts);
  if (!page?.id) throw new ConfluenceError(`no Confluence page ${pageId} on ${conf.site}`, 404);

  // The allowlist, enforced on what Confluence says rather than on what was asked for:
  // a page id names a page and says nothing at all about which space it is in.
  const key = byId.get(String(page.spaceId)) || null;
  if (!key) {
    throw new ConfluenceError(
      `page ${pageId} is not in a space this install may read — confluence.readSpaces names ${allowed.join(', ')}`,
      403
    );
  }

  return {
    id: String(page.id),
    title: page.title || '',
    spaceKey: key,
    version: page.version?.number ?? null,
    updatedAt: page.version?.createdAt || null,
    url: pageUrl(full, page),
    markdown: fromStorage(page.body?.storage?.value || ''),
  };
}

/**
 * What the agents are told about reading a page — empty when there is nothing to say.
 *
 * The emptiness is the interesting half, and it is `lookupBrief`'s argument one step
 * on: an agent never told about a grant it has may as well not have it, and an agent
 * told about a grant that is switched off spends a run finding that out. So this
 * paragraph appears in a prompt exactly when there is a space to read.
 */
export function confluenceBrief(cfg = {}, owner = 'the user') {
  const spaces = readableSpaces(cfg);
  if (!spaces.length || !settings(cfg)) return '';
  return `**You can read a Confluence page.** ${spaces.length === 1 ? 'One space is' : `${spaces.length} spaces are`} open to you — ${spaces.join(', ')} — and nothing else on that site is:

    beadcause-confluence --spaces          which spaces you may read
    beadcause-confluence <page url>        the page, as markdown
    beadcause-confluence <SPACE>/<title>   the same, by space and title

It reads. There is no way through it to edit a page, comment on one, search the site,
list what a space contains, or fetch an attachment, and a page outside those spaces is
refused whether you name it by title or by id.

Use it when the question turns on something the team wrote down — a runbook, a spec, a
decision recorded on the wiki — and only when a page has actually been named, since you
cannot search for one. **Cite it the way you cite anything else you read**: the URL and
the version number, both of which it prints above the page. A wiki page is edited by
other people, so "the page said this, at v14, today" is a fact and "the page says this"
is a hostage.

It reads as ${owner} — that is whose API token it carries — so treat what is on those
pages as theirs, and quote from it only into the bead you are answering.`;
}

export { ConfluenceError };
