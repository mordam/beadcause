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
 * **Publish-out only.** Reading a Confluence page back in as context for an agent is
 * the other half and it is deliberately not here: it is a different credential story
 * (a token that only has to read), a different surface, and a different decision about
 * what an unattended agent may reach. bc-c6qp says to scope it separately and this
 * file does not pretend otherwise.
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

export { ConfluenceError };
