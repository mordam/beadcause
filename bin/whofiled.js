#!/usr/bin/env node
/**
 * Which run filed a bead — bc-xl7n.145.
 *
 *     beadcause-whofiled -w beadcause -b bc-abc123
 *     beadcause-whofiled -w beadcause -b bc-abc123 --json
 *
 * `created_by` cannot answer this — it is the git identity of the workspace
 * directory, the same string for every session that has ever written there (see
 * lib/byline.js). The chain that can already exists on the bead: `filed-while:<bead>`
 * (lib/filing.js) names the bead its filer was working, and that bead's own archive
 * (`refs/beadcause/sessions/<bead>`, lib/sessionlog.js) carries the session. This is
 * that chain, resolved in one call instead of the three a reader used to assemble by
 * hand — `bd show`, then `bd show` again on the filed-while target, then
 * `git cat-file -p refs/beadcause/sessions/<target>:meta.json`.
 *
 * Exit codes: `0` resolved to a session. `1` carries `filed-while` but the chain does
 * not close — the filer bead has no archived session (still running, or ended before
 * a commit was there to archive). `2` carries no `filed-while` label at all — not
 * filed through this path, or filed before the label existed. `3` bad usage. `4` the
 * workspace or bead named does not exist.
 */
import { Bd } from '../lib/bd.js';
import { loadConfig } from '../lib/config.js';
import { filedWhileTarget } from '../lib/filing.js';
import { resolveSessionDir } from '../lib/session.js';
import { filerSession } from '../lib/sessionlog.js';

const argv = process.argv.slice(2);
function arg(...names) {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i > -1) return argv[i + 1];
  }
  return undefined;
}
const has = (...names) => names.some((n) => argv.includes(n));

const USAGE = 'usage: beadcause-whofiled -w <workspace> -b <bead> [--json]';

function fail(msg, code) {
  console.error(`beadcause-whofiled: ${msg}`);
  console.error(USAGE);
  process.exit(code);
}

if (has('-h', '--help')) {
  console.log(USAGE);
  process.exit(0);
}

const cfg = loadConfig();
const wsName = arg('-w', '--workspace');
const id = arg('-b', '--bead', '--id');
const JSON_MODE = has('--json');

if (!wsName || !id) fail('both -w/--workspace and -b/--bead are required', 3);

const ws = (cfg.workspaces || []).find((w) => w.name === wsName);
if (!ws) fail(`no workspace named "${wsName}" — configured: ${(cfg.workspaces || []).map((w) => w.name).join(', ') || '(none)'}`, 4);

const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });
const row = await bd.show(ws, id).catch(() => null);
if (!row) fail(`${ws.name} has no bead ${id}`, 4);

const target = (row.labels || []).map(filedWhileTarget).find(Boolean) || null;

function out(payload) {
  if (JSON_MODE) console.log(JSON.stringify(payload, null, 2));
}

if (!target) {
  out({ id: row.id, filedWhile: null, closed: false });
  if (!JSON_MODE) console.log(`${row.id} carries no filed-while label — not filed through bin/file.js, or filed before that stamp existed.`);
  process.exitCode = 2;
} else {
  const dir = resolveSessionDir(cfg, ws);
  const result = await filerSession(dir, target, row.created_at);

  if (!result.sessions) {
    out({ id: row.id, filedWhile: target, closed: false, reason: `no session is archived for ${target}` });
    if (!JSON_MODE) {
      console.log(`${row.id} was filed while working ${target}, but no session is archived for it —`);
      console.log('the chain does not close: that run is likely still going, or it ended before it had');
      console.log('a commit to archive.');
    }
    process.exitCode = 1;
  } else {
    const { session } = result;
    const meta = session?.meta || {};
    out({
      id: row.id,
      filedWhile: target,
      closed: true,
      exact: result.exact,
      commit: session.commit,
      archivedAt: session.at,
      sessionId: meta.sessionId || null,
      branch: meta.branch || null,
      worktree: meta.worktree || null,
      commits: meta.commits || [],
    });
    if (!JSON_MODE) {
      console.log(`${row.id} was filed while working ${target}${result.exact ? '' : ' (nearest archive — not confirmed by a matching session window)'}:`);
      console.log(`  session   ${meta.sessionId || '(unknown)'}`);
      if (meta.branch) console.log(`  branch    ${meta.branch}`);
      if (meta.worktree) console.log(`  worktree  ${meta.worktree}`);
      console.log(`  archived  ${session.commit.slice(0, 9)} · ${session.at}`);
      if (result.sessions > 1) console.log(`  (${target} has ${result.sessions} archived sessions in all; this is the one that fits)`);
    }
    process.exitCode = 0;
  }
}
