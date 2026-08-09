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
 * A short hash of every watched file's path, size and mtime.
 *
 * Content hashing would be truer, but this runs on every health check; size+mtime
 * is what every build tool uses for the same reason and is wrong only if a file is
 * edited without its mtime moving, which no editor does.
 */
export function buildStamp() {
  const h = crypto.createHash('sha256');
  for (const dir of WATCHED) {
    const full = path.join(ROOT, dir);
    let names;
    try {
      names = fs.readdirSync(full).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.js')) continue;
      try {
        const st = fs.statSync(path.join(full, name));
        h.update(`${dir}/${name}:${st.size}:${st.mtimeMs}\n`);
      } catch {
        /* vanished mid-scan — the next check will see it */
      }
    }
  }
  return h.digest('hex').slice(0, 12);
}
