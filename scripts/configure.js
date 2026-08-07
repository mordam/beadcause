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

/* ------------------------------------------------- shared vs private workspaces */

console.log(bold('1. Which of these are shared with other people?'));
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

console.log(`\n${bold('2. Group them into spaces?')}`);
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

console.log(`\n${bold('3. Where does your code live?')}`);
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

console.log(`\n${bold('4. Does your shell pick a beads workspace from the current directory?')}`);
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

console.log(`\n${bold('5. Push notifications')}`);
console.log(
  dim(
    '   The Android app posts its own notifications over your tailnet and needs\n' +
      '   nothing here. Answer y only if you want the PWA to push via ntfy.sh, which\n' +
      '   relays through a public server.'
  )
);
cfg.ntfy = { ...cfg.ntfy, enabled: await yes('   use ntfy? (y/n)', cfg.ntfy?.enabled ? 'y' : 'n') };

/* --------------------------------------------------------------- unattended work */

console.log(`\n${bold('6. Should commenting spawn an agent to answer you?')}`);
console.log(
  dim(
    '   Otherwise a comment just sets a label and waits for an agent session to come\n' +
      '   looking — which, if none ever does, means it is never answered. Costs tokens\n' +
      '   per comment, and the agent runs unattended (read + `bd` only, no edits).'
  )
);
cfg.autoDispatch = await yes('   auto-dispatch? (y/n)', cfg.autoDispatch === false ? 'n' : 'y');

/* ---------------------------------------------------------------------- write */

saveConfig(cfg);
rl.close();

console.log(`\n${bold('Saved')} ${CONFIG_PATH}`);
console.log(summary(cfg));
console.log(`\nEdit any of it later in that file, or re-run ${bold('npm run configure')}.\n`);
