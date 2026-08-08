/**
 * What build is this process actually running?
 *
 * The failure this exists for: static files are read from disk on every request,
 * server code is loaded once at startup. Edit `lib/` without restarting and the
 * browser gets today's page talking to yesterday's server — which is how `/sessions`
 * came to 404 against a ten-hour-old process while every file on disk was correct.
 *
 * A stamp over the files that only take effect at startup makes that visible, and
 * lets the router decide for itself that a swap is due.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// `public/` is deliberately absent: it is served from disk per request, so it can
// change under a running process without anything being stale. Restarting for a CSS
// edit would be churn for nothing.
const WATCHED = ['lib', 'bin'];

/**
 * A short hash of the given files' path, size and mtime.
 *
 * Content hashing would be truer, but this runs every few seconds; size+mtime is
 * what every build tool uses for the same reason and is wrong only if a file is
 * edited without its mtime moving, which no editor does.
 */
function hash(files) {
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    try {
      const st = fs.statSync(path.join(ROOT, rel));
      h.update(`${rel}:${st.size}:${st.mtimeMs}\n`);
    } catch {
      // Absent counts as a state too, and a distinct one: a file being deleted has
      // to move the stamp, or removing a module would never trigger a swap.
      h.update(`${rel}:-\n`);
    }
  }
  return h.digest('hex').slice(0, 12);
}

/** Every `.js` under the watched directories, sorted so the stamp is stable. */
function watchedFiles() {
  const out = [];
  for (const dir of WATCHED) {
    let names;
    try {
      names = fs.readdirSync(path.join(ROOT, dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith('.js')) out.push(`${dir}/${name}`);
  }
  return out;
}

/** The stamp a backend reports, and the one the router compares against disk. */
export function buildStamp() {
  return hash(watchedFiles());
}

/**
 * The router's own code, stamped separately — because it cannot swap itself.
 *
 * The router owns the listening socket; replacing it means giving up the port, and
 * a port the phone can't reach is the outage this whole feature exists to avoid.
 * So a change here is reported rather than acted on, and you restart it by hand.
 */
export function routerStamp() {
  return hash(['bin/router.js', 'lib/build.js', 'lib/config.js']);
}
