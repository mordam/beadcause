/**
 * What launchd is *actually* running — as opposed to what this repo intends.
 *
 * The bug this exists for ran for three days without anyone noticing. bin/router.js
 * landed, scripts/install.sh was updated to point the LaunchAgent at it, and the
 * whole hot-swap — a router owning the port, a backend swapped under it on every
 * edit to `lib/` — was described in the README as how deploys work. Meanwhile the
 * plist in ~/Library/LaunchAgents, written weeks earlier, still named
 * `bin/beadcause.js`, and every `launchctl kickstart -k` faithfully restarted the
 * plain unsupervised server. Nothing in the program was wrong. Nothing in the
 * program was *live*, either.
 *
 * The reason it could hide is that the two halves never meet: install.sh writes the
 * plist and is run by hand, perhaps once; the deploy kickstarts a label and never
 * looks at what the label points to. A file generated months ago is not something
 * `git pull` updates, so the repo can improve indefinitely while the installed
 * service stands still.
 *
 * So this reads the plist off disk and compares it to this checkout, and callers pair
 * that with the one fact only a running process has: what launchd actually handed it.
 * Two independent facts, because they fail apart —
 *
 *   - the plist file names bin/beadcause.js  → install.sh has never been re-run since
 *     the router landed. The fix is `npm run install-service`.
 *   - the plist file names bin/router.js, but the process launchd started is the
 *     server → the file was rewritten and the job never reloaded, so launchd is still
 *     serving the arguments it bootstrapped with. Same fix, and only a bootout and
 *     bootstrap clears it — rewriting the file alone does nothing.
 *
 * It is deliberately a leaf: `node:fs`, `node:os`, `node:path` and nothing from the
 * app. bin/router.js imports it, and the router's whole safety property is that it
 * depends on almost nothing — see the note at the top of that file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The LaunchAgent label. Kept in step with scripts/install.sh and scripts/uninstall.sh. */
export const LABEL = 'm4m.beadcause';

/** Where install.sh writes the plist for a given home directory. */
export function plistPath(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const unescapeXml = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, name) =>
    name.startsWith('#') ? String.fromCharCode(Number(name.slice(1))) : ENTITIES[name]
  );

/**
 * The `ProgramArguments` array out of an XML plist, or null.
 *
 * A hand-rolled scan rather than a parser because the only plist this ever reads is
 * one install.sh generated a few lines of heredoc above, and pulling in an XML
 * dependency for it would put weight on the one module that must stay weightless.
 * Anything it cannot make sense of returns null and is reported as unreadable —
 * a wrong *guess* here would accuse a correct install of being broken, which is
 * worse than admitting the file was not understood.
 */
export function programArguments(xml) {
  const key = xml.indexOf('<key>ProgramArguments</key>');
  if (key < 0) return null;
  const open = xml.indexOf('<array>', key);
  if (open < 0) return null;
  const close = xml.indexOf('</array>', open);
  if (close < 0) return null;
  const out = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m;
  const body = xml.slice(open + '<array>'.length, close);
  while ((m = re.exec(body))) out.push(unescapeXml(m[1]));
  return out.length ? out : null;
}

/**
 * The installed LaunchAgent, as a fact rather than a judgement.
 *
 * `exists: false` is an ordinary answer — a checkout that has never been installed as
 * a service is not misconfigured, it is just a checkout — so this reports and leaves
 * the verdict to hotSwapProblem().
 */
export function installedService({ home = os.homedir() } = {}) {
  const file = plistPath(home);
  let xml;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return { path: file, exists: false, argv: null, program: null, unreadable: false };
  }
  // A binary plist is legal and launchctl reads it happily; this does not, and says
  // so rather than pretending the ProgramArguments were absent.
  if (xml.startsWith('bplist00')) return { path: file, exists: true, argv: null, program: null, unreadable: true };
  const argv = programArguments(xml);
  if (!argv) return { path: file, exists: true, argv: null, program: null, unreadable: true };
  // The program is the last .js in argv, not argv[1]: the plist runs node with an
  // absolute path, and a future one might carry an interpreter flag between them.
  const program = argv.filter((a) => a.endsWith('.js')).pop() || argv[argv.length - 1];
  return { path: file, exists: true, argv, program, unreadable: false };
}

/**
 * Is the hot-swap actually installed? `null` when it is; a problem when it is not.
 *
 * `loadedProgram` is what launchd handed the calling process — `process.argv[1]` in a
 * daemon whose parent is pid 1 — and is the only way to catch a plist that is correct
 * on disk but was never reloaded. Callers with no such knowledge pass nothing, and get
 * the disk half of the answer, which is the half that was wrong here.
 *
 * Every problem carries `lines`: what is wrong, then the one command that fixes it.
 * A diagnosis nobody can act on is a diagnosis nobody reads.
 */
export function hotSwapProblem({ root = ROOT, home = os.homedir(), loadedProgram = null } = {}) {
  const want = path.join(root, 'bin', 'router.js');
  const server = path.join(root, 'bin', 'beadcause.js');
  const svc = installedService({ home });
  const fix = 'npm run install-service';

  if (!svc.exists) {
    return {
      code: 'not-installed',
      summary: `no LaunchAgent at ${svc.path} — beadcause is not installed as a service`,
      lines: [`no LaunchAgent at ${svc.path}.`, `install it: ${fix}`],
      installed: svc,
    };
  }

  if (svc.unreadable) {
    return {
      code: 'unreadable',
      summary: `could not read ProgramArguments out of ${svc.path}`,
      lines: [`${svc.path} is installed but its ProgramArguments could not be read.`, `rewrite it: ${fix}`],
      installed: svc,
    };
  }

  if (svc.program !== want) {
    const isOwnServer = svc.program === server;
    return {
      code: isOwnServer ? 'runs-the-server' : 'foreign-program',
      summary: isOwnServer
        ? 'the installed service runs bin/beadcause.js directly — there is no router, so no hot-swap'
        : `the installed service runs ${svc.program}, which is not this checkout's bin/router.js`,
      lines: isOwnServer
        ? [
            'launchd runs bin/beadcause.js directly, not bin/router.js.',
            'so nothing supervises the port: an edit to lib/ is NOT picked up, and every',
            'kickstart restarts the plain server. The hot-swap is installed in the repo',
            'and not in launchd.',
            `fix it: ${fix}`,
          ]
        : [
            `launchd runs ${svc.program}.`,
            `this checkout is ${root}, whose router is ${want}.`,
            `if this is the checkout that should be serving: ${fix}`,
          ],
      installed: svc,
    };
  }

  if (loadedProgram && path.resolve(loadedProgram) !== want) {
    return {
      code: 'not-reloaded',
      summary: `${svc.path} names bin/router.js, but launchd started ${loadedProgram}`,
      lines: [
        `${svc.path} names bin/router.js, but the job launchd actually started is`,
        `${loadedProgram}.`,
        'the file was rewritten and the job never reloaded — launchd keeps the arguments it',
        'bootstrapped with, so rewriting the plist alone changes nothing.',
        `reload it: ${fix}  (it boots the job out and back in)`,
      ],
      installed: svc,
    };
  }

  return null;
}

/**
 * The problem as a banner, in the shape lib's other loud warnings use.
 *
 * Framed rather than merely printed because of where it lands: launchd's log, in
 * among startup lines that all look alike, read by someone scrolling for something
 * else. The one that mattered here would have been the first thing on the screen.
 */
export function problemBanner(problem, prefix = '[beadcause]') {
  const rule = `${prefix} ${'─'.repeat(57)}`;
  return [
    rule,
    `${prefix} HOT-SWAP IS NOT LIVE — ${problem.code}`,
    ...problem.lines.map((l) => `${prefix}   ${l}`),
    rule,
  ];
}
