#!/usr/bin/env node
/**
 * Ask the handful of questions that can't be guessed, and write the answers into
 * ~/.config/beadcause/config.json.
 *
 *   npm run configure
 *
 * Run by the installer, and re-runnable at any time. Only three things genuinely
 * need a human: which workspaces are shared with other people (that decides what a
 * public relay is allowed to see and where unattended agents may comment), where
 * your code lives (so questions can show you files from it), and whether your shell
 * derives BEADS_DIR from the working directory.
 *
 * Every question offers a default that is the conservative choice, so holding Enter
 * through the whole thing produces a safe configuration. With no TTY — CI, a piped
 * install — it takes those defaults silently rather than blocking.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig, saveConfig, CONFIG_PATH } from '../lib/config.js';
import { globalWorkerCap } from '../lib/advocate.js';
import { ownerName } from '../lib/owner.js';
import { repoList, repoStatusLine, forgetRepos } from '../lib/repos.js';
import { scanTargets, scanRoot, parseApproved, resolveDefaultChoice, tildeHome } from '../lib/reposcan.js';

const HOME = os.homedir();
const tty = process.stdin.isTTY && process.stdout.isTTY;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const cfg = loadConfig();
const workspaces = cfg.workspaces.map((w) => w.name);

/** What is currently configured, in the same shape the interactive run reports. */
function summary(c) {
  const q = (s) => {
    const bits = [];
    if (s.muted) bits.push('muted');
    if (s.quietHours?.from) bits.push(`quiet ${s.quietHours.from}-${s.quietHours.to}`);
    if (s.quietDays?.length) bits.push(s.quietDays.join('/'));
    if (s.ntfyDetail === 'minimal') bits.push('contentless push');
    if (s.autoDispatch === false) bits.push('no agents');
    return bits.length ? ` [${bits.join(', ')}]` : '';
  };
  return [
    // First line, because it is the one that is wrong on a fresh machine and the one
    // nobody thinks to look for: every prompt an agent gets says this name.
    `  agents call you   : ${ownerName(c)}`,
    `  workspaces        : ${workspaces.join(', ') || '(none)'}`,
    // Two separate lists govern this, and reporting only one made a workspace look
    // unprotected when it was actually covered by the other.
    `  shared workspaces : ${
      [...new Set([...(c.autoDispatchExclude || []), ...(c.ntfy?.minimalWorkspaces || [])])].join(', ') || '(none)'
    }`,
    `  spaces            : ${
      (c.spaces || []).length
        ? (c.spaces || []).map((s) => `${s.name} (${(s.workspaces || []).join('/')})${q(s)}`).join(', ')
        : '(none)'
    }`,
    `  asset roots       : ${(c.assetRoots || []).join(', ')}`,
    `  session dirs      : ${c.projectRoot ? `${c.projectRoot}/<workspace>` : '~/beads/<workspace>'}`,
    `  ntfy              : ${c.ntfy?.enabled ? c.ntfy.topic : 'disabled'}`,
    `  auto-dispatch     : ${c.autoDispatch === false ? 'off' : 'on'}`,
    // Both numbers, always: "advocates: sophab" without the session count reads as
    // an unbounded thing, and that is the number people want to be sure of.
    `  advocates         : ${
      (c.advocates?.workspaces || []).length && c.advocates?.enabled !== false
        ? `${(c.advocates.workspaces || []).join(', ')} — up to ${c.advocates.maxWorkers ?? 1} session(s) each, ${globalWorkerCap(
            c
          )} in total`
        : 'off'
    }`,
    `  console at login  : ${c.monitor?.enabled ? 'yes' : 'no (open /monitor yourself)'}`,
    // Only on an install that has a multi-repo workspace at all. Everywhere else the line
    // would say "every workspace is one repo", which is not news and reads as a setting
    // somebody forgot to fill in.
    ...(Object.keys((c.repos && typeof c.repos === 'object' && c.repos) || {}).length
      ? [`  repos             : ${repoStatusLine(c)}`]
      : []),
  ].join('\n');
}

/**
 * No terminal to ask questions with.
 *
 * This is not only CI: running the command through a wrapper that pipes stdin — a
 * `!`-prefixed shell in an agent session, for instance — lands here too, and
 * printing "not a terminal" and exiting looked exactly like the command was broken.
 * So show what IS configured, and say precisely how to change it.
 */
if (!tty) {
  console.log(`\n${bold('Beadcause configuration')}  ${dim(CONFIG_PATH)}\n`);
  console.log(summary(cfg));
  console.log(
    `\n${dim('Nothing was changed: this needs an interactive terminal to ask questions.')}\n` +
      `${dim('Run')} ${bold('npm run configure')} ${dim('directly in Terminal or iTerm, or edit the file above by hand.')}\n`
  );
  process.exit(0);
}

if (!workspaces.length) {
  console.log(`\nNo beads workspaces found under ~/beads.`);
  console.log(`Create one and re-run: ${bold('npm run configure')}\n`);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/**
 * Ctrl+C and Ctrl+D during setup are ordinary — you change your mind, or the
 * installer is being driven by something that closes stdin. Either way it must not
 * dump a Node stack trace at someone who is installing this for the first time, and
 * it must not leave a half-answered config behind: nothing is written until the end.
 */
function bail() {
  rl.close();
  console.log(`\n\nSetup cancelled — nothing was changed. Run ${bold('npm run configure')} when ready.\n`);
  process.exit(0);
}
rl.on('SIGINT', bail);

const ask = async (q, dflt) => {
  try {
    return (await rl.question(`${q} ${dim(`[${dflt}]`)} `)).trim() || dflt;
  } catch {
    bail();
  }
};
const yes = async (q, dflt = 'n') => /^y/i.test(await ask(q, dflt));

console.log(`\n${bold('Beadcause setup')} — Enter accepts the default shown in brackets.`);
console.log(`Workspaces found: ${workspaces.join(', ')}\n`);

/* ------------------------------------------------------------------ your name */

/**
 * Asked first, because it is the one answer that changes what the agents *say*.
 *
 * Every unattended agent is told about a person by name: who is not at the keyboard,
 * who approves a bead before it exists, whose pull request this is waiting on. That
 * name used to be a literal in the source, which on any machine but the author's put
 * a stranger in every prompt — and a model given the wrong name has no way to tell
 * that the name is the mistake rather than the instruction.
 *
 * The default comes from your git `user.name`, first word only, because the value is
 * read inline in prose. Anything you type is kept as typed.
 */
console.log(bold('1. What should the agents call you?'));
console.log(
  dim(
    '   This name goes into every agent prompt, the body of every pull request an\n' +
      '   agent opens, and the notes that land on a bead — "<name> is not at the\n' +
      '   keyboard", "<name> approves every bead before it exists". A first name reads\n' +
      '   best. Guessed from your git identity.'
  )
);
cfg.owner = (await ask('   name:', ownerName(cfg))) || ownerName(cfg);

/* ------------------------------------------------- shared vs private workspaces */

console.log(bold('2. Which of these are shared with other people?'));
console.log(
  dim(
    '   Shared workspaces are treated carefully in two ways: their questions push a\n' +
      '   contentless nudge rather than the text (an ntfy.sh topic is readable by anyone\n' +
      '   who guesses its name), and no unattended agent will comment on them.\n' +
      '   Comma-separated, or "none".'
  )
);
const sharedRaw = await ask('   shared:', 'none');
const shared = /^none$/i.test(sharedRaw)
  ? []
  : sharedRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((name) => {
        const known = workspaces.includes(name);
        if (!known) console.log(dim(`   (ignoring "${name}" — not a workspace under ~/beads)`));
        return known;
      });

cfg.autoDispatchExclude = shared;
cfg.ntfy = { ...cfg.ntfy, minimalWorkspaces: shared };

/* --------------------------------------------------------------------- spaces */

console.log(`\n${bold('3. Group them into spaces?')}`);
console.log(
  dim(
    '   A space is a set of workspaces that share a notification policy — the point\n' +
      '   being that you can mute one. "Work" muted after 18:00 and at weekends means\n' +
      '   work questions still arrive and still show a badge, they just never buzz.\n' +
      '   Skip if you only have one kind of work.'
  )
);

if (await yes('   set up spaces? (y/n)', (cfg.spaces || []).length ? 'y' : 'n')) {
  const spaces = [];
  let remaining = [...workspaces];
  while (remaining.length) {
    console.log(dim(`\n   unassigned: ${remaining.join(', ')}`));
    const name = await ask('   space name (blank to finish):', '');
    if (!name) break;
    const picked = (await ask(`   workspaces in "${name}" (comma-separated):`, remaining.join(', ')))
      .split(',')
      .map((s) => s.trim())
      .filter((s) => remaining.includes(s));
    if (!picked.length) {
      console.log(dim('   (nothing matched — skipping)'));
      continue;
    }
    const space = { name, workspaces: picked };

    if (await yes(`   quiet hours for "${name}"? (y/n)`, 'n')) {
      const from = await ask('     quiet from (HH:MM):', '18:00');
      const to = await ask('     quiet until (HH:MM):', '09:00');
      space.quietHours = { from, to };
      const days = await ask('     also quiet all day on (e.g. sat,sun — blank for none):', 'sat,sun');
      if (days.trim()) space.quietDays = days.split(',').map((d) => d.trim().slice(0, 3).toLowerCase()).filter(Boolean);
    }
    // Shared workspaces were already handled in question 1; this is the space-level
    // equivalent, and it keeps applying as you add workspaces to the space later.
    if (picked.some((w) => shared.includes(w))) space.ntfyDetail = 'minimal';

    spaces.push(space);
    remaining = remaining.filter((w) => !picked.includes(w));
  }
  cfg.spaces = spaces;
} else {
  cfg.spaces = [];
}

/* ---------------------------------------------------------------- asset roots */

console.log(`\n${bold('4. Where does your code live?')}`);
console.log(
  dim(
    '   A question can only show you an image or open a document that sits under one\n' +
      '   of these directories. ~/beads is always included. Blank to skip.'
  )
);
const guesses = ['code', 'src', 'dev', 'projects', 'Projects', 'work', 'repos'].map((d) => path.join(HOME, d));
const guess = guesses.find((d) => fs.existsSync(d)) || '';
const codeRoot = await ask('   path:', guess);

const assetRoots = new Set([path.join(HOME, 'beads'), ...(cfg.assetRoots || [])]);
if (codeRoot) {
  const resolved = path.resolve(codeRoot.replace(/^~/, HOME));
  if (fs.existsSync(resolved)) assetRoots.add(resolved);
  else console.log(dim(`   (${resolved} does not exist — skipping)`));
}
cfg.assetRoots = [...assetRoots];

/* ----------------------------------------------------------------- projectRoot */

console.log(`\n${bold('5. Does your shell pick a beads workspace from the current directory?')}`);
console.log(
  dim(
    '   Some setups have a chpwd hook mapping <root>/<repo> to ~/beads/<repo>, often\n' +
      '   carrying an actor, an API token, or a Claude account along with it. If yours\n' +
      '   does, a session opened from the phone must start in the matching checkout.\n' +
      '   Answer n if you are unsure — sessions then open in ~/beads/<workspace>, which\n' +
      '   always works.'
  )
);
if (await yes('   shell-derived? (y/n)', 'n')) {
  const root = await ask('   the root your checkouts live under:', codeRoot || path.join(HOME, 'code'));
  const resolved = path.resolve(root.replace(/^~/, HOME));
  if (fs.existsSync(resolved)) {
    cfg.projectRoot = resolved;
    const fallback = await ask('   workspace a shell OUTSIDE that root resolves to (blank for none):', '');
    cfg.fallbackWorkspace = fallback || null;
  } else {
    console.log(dim(`   (${resolved} does not exist — leaving sessions on the default)`));
    cfg.projectRoot = null;
  }
} else {
  cfg.projectRoot = null;
  cfg.fallbackWorkspace = null;
}

/* ------------------------------------------------------------------------ push */

console.log(`\n${bold('6. Push notifications')}`);
console.log(
  dim(
    '   The Android app posts its own notifications over your tailnet and needs\n' +
      '   nothing here. Answer y only if you want the PWA to push via ntfy.sh, which\n' +
      '   relays through a public server.'
  )
);
cfg.ntfy = { ...cfg.ntfy, enabled: await yes('   use ntfy? (y/n)', cfg.ntfy?.enabled ? 'y' : 'n') };

/* --------------------------------------------------------------- unattended work */

console.log(`\n${bold('7. Should commenting spawn an agent to answer you?')}`);
console.log(
  dim(
    '   Otherwise a comment just sets a label and waits for an agent session to come\n' +
      '   looking — which, if none ever does, means it is never answered. Costs tokens\n' +
      '   per comment, and the agent runs unattended (read + `bd` only, no edits).'
  )
);
cfg.autoDispatch = await yes('   auto-dispatch? (y/n)', cfg.autoDispatch === false ? 'n' : 'y');

/* -------------------------------------------------------------------- monitor */

console.log(`\n${bold('8. Open the advocate console at login?')}`);
console.log(
  dim(
    '   A browser window on /monitor: what each repo\'s advocate is working on, what it\n' +
      '   will pick up next, its survey agent thinking out loud, the beads it wants to\n' +
      '   file, and what its finished sessions archived. Answer n and nothing auto-opens\n' +
      '   — the page is always there at /monitor, and `npm run monitor` still gives you\n' +
      '   the smaller terminal view.'
  )
);
cfg.monitor = {
  ...(cfg.monitor || {}),
  enabled: await yes('   open the console at login? (y/n)', cfg.monitor?.enabled ? 'y' : 'n'),
};

/* ------------------------------------------------------------------ advocates */

console.log(`\n${bold('9. Which repos should have an advocate?')}`);
console.log(
  dim(
    '   An advocate watches one repo\'s ready beads and opens a Claude session on each\n' +
      '   one until there are none left. It runs unattended and costs tokens; it will\n' +
      '   never create a bead without asking you first. Comma-separated, or "none".'
  )
);
const advRaw = await ask('   advocates:', (cfg.advocates?.workspaces || []).join(',') || 'none');
const advocated = /^none$/i.test(advRaw)
  ? []
  : advRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((name) => {
        const known = workspaces.includes(name) || name === '*';
        if (!known) console.log(dim(`   (ignoring "${name}" — not a workspace under ~/beads)`));
        return known;
      });

let maxWorkers = cfg.advocates?.maxWorkers ?? 1;
if (advocated.length) {
  console.log(
    dim('   How many sessions may ONE advocate have open at once? 1 is calm; 3 is the most\n   it will allow.')
  );
  // Clamped rather than rejected, and echoed back: a silently ignored answer here
  // would be a promise of three windows that only ever opens one.
  const raw = Number(await ask('   sessions per repo (1-3):', String(maxWorkers)));
  maxWorkers = Number.isFinite(raw) ? Math.min(3, Math.max(1, Math.floor(raw))) : 1;
  if (maxWorkers !== raw) console.log(dim(`   (using ${maxWorkers})`));
}

cfg.advocates = { ...(cfg.advocates || {}), workspaces: advocated, maxWorkers, enabled: true };

/* ------------------------------------------------------------------ many repos */

/**
 * Which checkouts of a multi-repo workspace may be worked in.
 *
 * Asked last, and on most installs not asked at all: a workspace is a repo — one tracker,
 * one checkout, one deploy — and only the company-shaped workspace breaks it. Climative is
 * forty-odd services sharing a single `cl-` graph, and a bead there is about
 * `athena-service` rather than about "climative".
 *
 * The list this writes was hand-edited JSON before, which is worse than it sounds: the two
 * facts that decide an entry are both invisible from the config file. Whether the repo is
 * cloned, and what service token its own `config/config.yaml` declares — so writing it by
 * hand meant opening forty YAML files, and getting one token wrong means a bead that
 * resolves to nothing at three in the morning.
 *
 * **What this must not become is discovery.** `approved` exists precisely so that a
 * directory appearing under the root — a colleague's service, a secrets repo, an
 * experiment — is not enough to put an unattended agent inside it. So the tree is
 * *printed* and nothing in it is approved without being named in the answer: the default
 * offered is what is already approved, holding Enter changes nothing, and there is no
 * "all". Showing you the tokens is help; ticking is still a decision.
 */
const repoTargets = scanTargets(cfg);
if (repoTargets.length) {
  console.log(`\n${bold('10. Which repos may be worked in?')}`);
  console.log(
    dim(
      `   ${repoTargets.map((t) => t.workspace).join(', ')} ${
        repoTargets.length === 1 ? 'holds' : 'hold'
      } more than one checkout, so a bead there has to say which one it is\n` +
        '   about — it does that by carrying the repo\'s own service token. Below is what is\n' +
        '   on disk and what each one calls itself; only the ones you name become workable,\n' +
        '   and Enter keeps exactly what is approved today.'
    )
  );

  for (const target of repoTargets) {
    const block = (cfg.repos || {})[target.workspace] || {};
    const current = (block.approved || []).map((e) => String(e || '').trim()).filter(Boolean);

    console.log(
      `\n   ${bold(target.workspace)}${
        target.source === 'guess' ? dim(' — never configured; this tree is named after it') : ''
      }`
    );
    // "none" rather than blank, because `ask` substitutes the default on an empty line —
    // an instruction to press Enter to skip would have been a promise this cannot keep.
    const rootRaw = await ask(`   root ("none" to leave ${target.workspace} alone):`, target.root ? tildeHome(target.root) : 'none');
    if (!rootRaw.trim() || /^(none|skip)$/i.test(rootRaw.trim())) {
      console.log(dim(`   (leaving ${target.workspace} alone)`));
      continue;
    }

    const scan = scanRoot(rootRaw, { tokenPath: block.tokenPath, tokenKey: block.tokenKey });
    if (!scan.exists) {
      console.log(dim(`   (${scan.root} does not exist — leaving ${target.workspace} alone)`));
      continue;
    }
    if (!scan.found.length) {
      console.log(dim(`   (nothing under ${scan.root} — leaving ${target.workspace} alone)`));
      continue;
    }

    // The whole tree, numbered, because forty names is not something anybody types. A ✓ is
    // what is approved today, and the ⚠ is the collision that makes a token unusable as an
    // address — worth seeing *before* you tick the second repo that declares it, rather
    // than in the startup log afterwards.
    const width = Math.min(30, Math.max(...scan.found.map((r) => r.name.length)));
    const wide = String(scan.found.length).length;
    console.log(
      dim(
        `\n   ${scan.found.length} directories under ${tildeHome(scan.root)}${
          current.length ? ', ✓ marking what is approved today' : ''
        }:`
      )
    );
    scan.found.forEach((r, i) => {
      const tick = current.some((c) => c.toLowerCase() === r.name.toLowerCase()) ? '✓' : ' ';
      const shared = scan.shared.find((s) => r.token && s.token === r.token.toLowerCase());
      // Named while there are few enough to read. `xs` is declared by nine repos here,
      // because microservice-base ships it as a placeholder, and spelling the other eight
      // out on each of nine rows buried the rest of the tree.
      const others = shared ? shared.names.filter((n) => n !== r.name) : [];
      const note = shared
        ? dim(others.length <= 2 ? `⚠ ${r.token} is also declared by ${others.join(', ')}` : `⚠ ${r.token} is declared by ${shared.names.length} of these`)
        : r.problem
          ? dim(r.problem)
          : '';
      console.log(
        `   ${String(i + 1).padStart(wide)} ${tick} ${r.name.padEnd(width)} ${(r.token || '—').padEnd(14)} ${note}`
      );
    });

    console.log(dim('   Numbers, ranges and names, comma-separated — "none" to approve nothing.'));
    const { approved, unknown, dropped } = parseApproved(
      await ask('   approved:', current.join(', ') || 'none'),
      scan.found,
      current
    );
    for (const u of unknown) console.log(dim(`   ("${u}" is not under that root — kept, and reported until it is)`));
    for (const d of dropped) console.log(dim(`   (ignoring "${d}" — there is no ${d} in the list above)`));

    const next = { ...block, root: tildeHome(scan.root), approved };
    if (approved.length) {
      console.log(
        dim(
          '   A bead carrying no service token belongs to one of them. Without this, every\n' +
            '   bead that names no repo resolves to nothing. A name or a token; blank for none.'
        )
      );
      const dflt = String(block.default || '').trim() || (approved.length === 1 ? approved[0] : '');
      const { value, problem } = resolveDefaultChoice(await ask('   default repo:', dflt), approved, scan.found);
      if (problem) console.log(dim(`   (${problem})`));
      if (value) next.default = value;
      else delete next.default;
    } else {
      console.log(dim(`   (nothing approved — every ${target.workspace} bead resolves to the workspace, as before)`));
    }

    cfg.repos = { ...(cfg.repos || {}), [target.workspace]: next };

    // Said now, in the answer's own words, rather than only in the startup log tomorrow:
    // these are exactly the sentences the resolver will produce for the list just written.
    forgetRepos();
    for (const w of repoList(cfg, target.workspace).warnings) console.log(dim(`   ! ${w}`));
  }
}

/* ---------------------------------------------------------------------- write */

saveConfig(cfg);
rl.close();

console.log(`\n${bold('Saved')} ${CONFIG_PATH}`);
console.log(summary(cfg));
console.log(`\nEdit any of it later in that file, or re-run ${bold('npm run configure')}.\n`);
