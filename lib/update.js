import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a finished deploy did to the thing you are holding.
 *
 * Every other file in this subsystem is about the deploy: lib/deploy.js starts it,
 * scripts/deploy-runner.mjs runs it, lib/release.js says what it would make live,
 * lib/prboard.js says afterwards whether it did. All of that is written from the Mac's
 * side, and it ends the moment the daemon comes back up. Nobody had ever told the
 * *clients* anything: a phone holding a page from twenty minutes ago went on holding it,
 * and an Android shell whose APK had just been rebuilt had no way to learn that short of
 * somebody opening a URL and thumbing through an installer.
 *
 * So this answers one question, per client, about one deploy: **did that change me?**
 * Two ways it can, and they are not the same size:
 *
 *   - **The page moved.** Something under `public/` is different from what your tab
 *     loaded, which for this app means anything from a fixed typo to a script calling a
 *     function its cached sibling does not have. The answer is a reload — through the
 *     service worker, or the shell cache hands you the same files back (public/sw.js).
 *   - **The shell moved.** `android/` changed, so the deploy rebuilt and republished the
 *     APK, and the WebView you are reading this in is one build behind the pages it is
 *     showing. The answer is a download, an install and a restart, which is a great deal
 *     more than a reload and is why it is never done without being asked.
 *
 * ## It follows the pull, not the restart
 *
 * The temptation is to report effects only for a deploy that ended `ok`, and it would be
 * wrong here in a way that matters. This daemon serves `public/` **from disk on every
 * request** (see lib/build.js on why `public` is not in `WATCHED`) and the runner's pull
 * is a fast-forward of that very checkout. So by the time the record carries `changed`,
 * the new files are already what the next request will be answered with — whether or not
 * the restart that follows ever happened. A deploy that fast-forwarded and then failed to
 * kickstart has still changed the page under you, and a client told otherwise would sit
 * on a stale bundle talking to files that had moved.
 *
 * The same goes for the APK a rebuild step publishes: `npm run android` copies it into
 * `public/` itself, so the moment that step exits 0 the phone can fetch the new one. Both
 * facts are therefore read off *steps that completed*, and the record's final word —
 * `ok`, `unconfirmed`, `failed` — travels alongside them rather than gating them.
 *
 * ## And only for this checkout
 *
 * A deploy of sophab moves `public/` too, and it has nothing whatever to do with the app
 * asking. The test is not the repo's key — which is config, and which is `null` on a Mac
 * where this clone is in no workspace — but the record's own `dir`: the directory the
 * runner fast-forwarded. Where that is the tree this file is part of, the deploy changed
 * *us*. Anything else is somebody else's news.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This checkout — the tree the daemon runs out of, and the one it serves. */
const ROOT = path.join(HERE, '..');

/** Where `npm run android` publishes, and what the daemon already serves it as. */
export const APK_URL = '/beadcause.apk';
const APK_REL = 'public/beadcause.apk';
/** What scripts/build-android.sh writes beside it — the version the file cannot state. */
const SIDECAR_REL = `${APK_REL}.json`;

/**
 * The rebuild step's label, as declared in `deploys.<repo>.rebuild`.
 *
 * One string, matched against what the runner recorded. `ownDeployDeclaration` in
 * lib/deploy.js writes exactly this label, so the declaration this Mac makes for itself
 * and this reader agree by construction; a hand-written config that calls the step
 * something else gets no APK news, which is the right failure — an unrecognised step is
 * a step nothing here can describe.
 */
export const APK_STEP = 'apk';

/**
 * Files under `public/` that are not the page.
 *
 * The APK and its sidecar live there because that is where the daemon serves from, and a
 * rebuild that touched nothing else must not tell every open tab to reload itself.
 */
const NOT_THE_PAGE = new Set([APK_REL, SIDECAR_REL]);

/** Did this list of changed paths move the app the browser is running? */
export function movedWeb(changed = []) {
  return (changed || []).some((f) => {
    const p = String(f || '').trim();
    return p.startsWith('public/') && !NOT_THE_PAGE.has(p);
  });
}

/** Did a rebuild step publish a new APK — that is, run at all, and exit 0? */
export function rebuiltApk(rec) {
  return (rec?.steps || []).some((s) => s?.name === APK_STEP && s.code === 0);
}

/** Is this record about the checkout this daemon is running out of? */
export function isOurs(rec, { root = ROOT } = {}) {
  if (!rec?.dir) return false;
  try {
    return path.resolve(rec.dir) === path.resolve(root);
  } catch {
    return false;
  }
}

/** Statuses a runner still owns — the same set lib/deploy.js calls `LIVE`. */
const RUNNING = new Set(['queued', 'pulling', 'building', 'deploying']);

/**
 * What one record means to a client, or `null` where it means nothing to it.
 *
 * `null` for a deploy of another checkout and for one still running: a deploy that has
 * not finished pulling has changed nothing yet, and telling a page to reload in the
 * middle of a fast-forward would hand it half a tree.
 */
export function deployEffects(rec, { root = ROOT } = {}) {
  if (!rec || !isOurs(rec, { root })) return null;
  if (RUNNING.has(rec.status)) return null;
  return {
    id: rec.id,
    status: rec.status,
    at: rec.finishedAt || rec.startedAt || rec.requestedAt || null,
    web: movedWeb(rec.changed),
    apk: rebuiltApk(rec),
    /* What it moved between, for a client that wants to say so. Short, because the only
       reader is a sentence on a screen. */
    from: rec.from ? String(rec.from).slice(0, 7) : null,
    to: rec.to ? String(rec.to).slice(0, 7) : null,
    reason: rec.reason || '',
  };
}

/** The newest settled deploy of this checkout that changed anything about a client. */
export function lastEffects(deploys = [], { root = ROOT } = {}) {
  for (const rec of deploys) {
    const e = deployEffects(rec, { root });
    if (e && (e.web || e.apk)) return e;
  }
  return null;
}

/**
 * The APK on disk, as much as can be said about it truthfully.
 *
 * Two sources, answering different halves. The **file** says when it was built and how
 * big it is — `stat` cannot lie and needs nothing to have been written. The **sidecar**
 * says which build it is, because an APK's `versionCode` lives inside a binary this
 * process has no business parsing; scripts/build-android.sh writes it out at the moment
 * it publishes.
 *
 * The two are cross-checked rather than merged blindly. A sidecar describing a different
 * file — left behind by a build that failed halfway, or by a copy made with `cp` — would
 * otherwise tell a phone it is running an older version than it is, which is the one
 * mistake here that ends in a download loop. So the size has to match, and where it does
 * not the version is `null`: *there is an APK and I cannot tell you which one*, which is
 * a state the shell already has to handle for every build made before the sidecar
 * existed.
 */
export function apkInfo({ root = ROOT } = {}) {
  const file = path.join(root, APK_REL);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    // No APK has ever been published here. Not an error: a Mac that has never run
    // `npm run android` is an ordinary install with no Android shell to update.
    return null;
  }

  let side = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, SIDECAR_REL), 'utf8'));
    if (raw && typeof raw === 'object' && Number(raw.size) === st.size) side = raw;
  } catch {
    /* absent, unreadable, or about some other file — all of them mean "unknown". */
  }

  return {
    url: APK_URL,
    size: st.size,
    // The file's own mtime, never the sidecar's stamp: this is the one fact that stays
    // true when the sidecar is wrong, and it is what a shell with no version to compare
    // falls back to.
    builtAt: new Date(st.mtimeMs).toISOString(),
    versionCode: Number.isInteger(side?.versionCode) ? side.versionCode : null,
    versionName: typeof side?.versionName === 'string' ? side.versionName : '',
    sha256: typeof side?.sha256 === 'string' ? side.sha256 : '',
  };
}

/**
 * Everything `GET /api/update` answers with.
 *
 * One request, because the two questions arrive together: a client that has just been
 * told a deploy settled wants to know what it did *and* what the APK now is, and a client
 * that has just booted wants the same pair without having seen any event at all.
 */
export function updateView({ deploys = [], root = ROOT } = {}) {
  return { apk: apkInfo({ root }), deploy: lastEffects(deploys, { root }) };
}
