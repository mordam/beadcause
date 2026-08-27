/**
 * `lib/scaffold.js` — the templates `bin/b7e-scaffold` prints, kept out of the bin file
 * itself so `test/scaffold.mjs` can assert what they say without spawning a process for
 * every case.
 *
 * bc-dgx7.32: four sessions (bc-zjab.7, bc-zjab.9, bc-zjab.10, bc-zjab.6) each built a
 * new `b7e-*` command by reading two or three existing ones for their shape, then
 * disagreed with each other on nearly everything they had just copied — extensionless
 * vs `.js`, one file vs a paired `lib/` module, exit code 1 vs 2 for a bad argv. This is
 * the shape they converged on (see `bin/b7e-field`, the most recent worked example),
 * written down once so the fifth session gets it printed instead of re-deriving it.
 *
 * Every decision this module bakes in is a real one already made elsewhere in the repo,
 * not a guess: extensionless naming is [[only-an-extensionless-bin-resolves-on-path]],
 * `@grant` as a self-declared header tag (never a default this file could safely
 * invent) is [[b7e-grant-moved-to-tool-headers]], and `2` for a refused/bad-argv exit is
 * the majority convention across the existing `b7e-*` family (grep `process.exit(2)` —
 * 145 call sites at the time this was written, against 57 for `process.exit(1)`, which
 * commands use for a command-specific "ran fine but found something wrong" result).
 */

/** Validates a scaffold target name. Returns an error string, or null if it is fine. */
export function nameProblem(name) {
  if (!name) return 'a command name is required, e.g. b7e-scaffold b7e-thing';
  if (!/^b7e-[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    return `"${name}" doesn't look like a b7e-* command name (lowercase, hyphen-separated, starting with "b7e-") — pass the name as it will be typed, e.g. b7e-prior`;
  }
  return null;
}

const GRANT_TODO = ` * TODO: decide the grant — one of these three lines, added for real, is what makes
 * this command reachable (or deliberately not) from dispatch's allowlist:
 *
 *     * @grant read        it reads only — bd/git/fs reads, no writes, no spawns that write
 *     * @grant write        it writes — a bd write, a git write, a spawned command that writes
 *     * @grant excluded    deliberately NOT on the list, with the reason argued here too
 *
 * Leaving this TODO in place (rather than one of those three lines) is a real, checked
 * state — undeclared, same as b7e-packet and b7e-say today — not an oversight, but it is
 * not a state to ship in. See lib/tooldecl.js and [[b7e-grants-are-declared-not-registered]].`;

function usageBlock(name, { workspaceArg, jsonMode }) {
  const lines = [`usage: ${name}${workspaceArg ? ' -w <workspace> -b <bead>' : ''} <TODO: argv shape>`];
  if (workspaceArg) {
    lines.push('  -w, --workspace <n>  which tracker <bead> lives in (required)');
    lines.push('  -b, --bead <id>      the bead to act on (required)');
  }
  if (jsonMode) lines.push('  --json               the machine-readable form instead of the printed report');
  lines.push('  -h, --help           this text');
  return lines.join('\n');
}

/** The bin/<name> file text — the part meant to be redirected straight to a file. */
export function scaffoldBin(name, { workspaceArg = false, jsonMode = false } = {}) {
  const usage = usageBlock(name, { workspaceArg, jsonMode });
  const imports = workspaceArg
    ? `import { loadConfig } from '../lib/config.js';\nimport { Bd } from '../lib/bd.js';\n\n`
    : '';

  const argvParse = workspaceArg
    ? `let wsName = null;
let beadId = null;
const rest = [];

for (let i = 0; i < argvIn.length; i += 1) {
  const a = argvIn[i];
  if (a === '-w' || a === '--workspace') {
    wsName = argvIn[i + 1];
    i += 1;
  } else if (a === '-b' || a === '--bead') {
    beadId = argvIn[i + 1];
    i += 1;
  } else if (a === '-h' || a === '--help') {
    // already handled above; kept out of \`rest\`
  } else {
    // TODO: any other flags this command takes — --json among them, if you asked for it
    rest.push(a);
  }
}

if (!wsName || !beadId) fail(\`-w/--workspace and -b/--bead are both required\\n\${USAGE}\`, 2);

const cfg = loadConfig();
const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws) {
  console.error(\`${name}: no such workspace "\${wsName}"\`);
  console.error(\`workspaces: \${cfg.workspaces.map((w) => w.name).join(', ')}\`);
  process.exit(2);
}

const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

let bead;
try {
  bead = await bd.show(ws, beadId);
} catch (err) {
  fail(\`could not read \${beadId} (\${err.message.split('\\n')[0]})\`, 2);
}
if (!bead) fail(\`\${ws.name} has no bead \${beadId}\`, 2);

`
    : `// TODO: argv parsing. Nothing here yet but --help, which is handled above.
const rest = argvIn;

`;

  const jsonConst = jsonMode
    ? `const JSON_MODE = rest.includes('--json');\n\n`
    : '';

  const body = jsonMode
    ? `if (JSON_MODE) {
  console.log(JSON.stringify({ /* TODO: the machine-readable form */ }, null, 2));
} else {
  // TODO: the printed report
}
`
    : `// TODO: the command's own work.
`;

  return `#!/usr/bin/env node
/**
 * \`${name}\` — TODO: one clause, the way every other b7e-* header opens: what this
 * replaces and why it earns being a command instead of being re-derived by hand.
 *
 *     ${name}${workspaceArg ? ' -w beadcause -b bc-xyz' : ' TODO'}
 *
 * TODO: the paragraph — the bead this came from, what sessions were doing by hand
 * before this existed (with real examples, the way the bead that ordered this one
 * cited exact commands four other sessions ran), and which lib/ module (if any) does
 * the real work underneath this file's argv parsing and printing.
 *
 * Exit codes: \`0\` ok. \`2\` refused — bad usage${workspaceArg ? ', an unconfigured workspace, or a bead that does not exist' : ''}. TODO: name any
 * other exit code this command uses and what it means.
 *
${GRANT_TODO}
 */
${imports}const USAGE = \`${usage}\`;

function fail(msg, code) {
  console.error(\`${name}: \${msg}\`);
  process.exit(code);
}

const argvIn = process.argv.slice(2);
if (argvIn.includes('-h') || argvIn.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}

${argvParse}${jsonConst}${body}
process.exit(0);
`;
}

/** The lib/<libName>.js stub text — printed only with --lib. */
export function scaffoldLib(libName, name) {
  return `/**
 * \`lib/${libName}.js\` — TODO: one line saying what this holds, and why it is a module
 * of its own instead of living inline in \`bin/${name}\`.
 *
 * Split out because \`bin/${name}\` is the argv parsing and the printing; this is
 * everything a test can drive without spawning a process for it.
 *
 * If this module ends up importing \`CONFIG_DIR\` from \`lib/config.js\`, or writing
 * anywhere under it, or touching a \`refs/beadcause/*\` ref, it owes an entry in
 * \`lib/evidence.js\`'s register — see [[the-five-registers-and-what-a-new-one-owes]] and
 * \`test/evidence.mjs\`. Nothing here touches \`CONFIG_DIR\` yet, so nothing is owed until
 * it does.
 */

// TODO: the module's real exports. \`bin/${name}\` imports from here as
// \`import { TODO } from '../lib/${libName}.js';\`.
export function TODO() {
  throw new Error('lib/${libName}.js: not implemented yet');
}
`;
}

/**
 * The full text b7e-scaffold prints for one invocation — the bin file alone, or the
 * bin file followed by a clearly-marked lib file section when \`lib\` is requested.
 */
export function scaffold(name, { lib = false, workspaceArg = false, jsonMode = false } = {}) {
  const binText = scaffoldBin(name, { workspaceArg, jsonMode });
  if (!lib) return binText;
  const libName = name.slice('b7e-'.length);
  const libPath = `lib/${libName}.js`;
  const marker = `\n/* ============================================================================
 * Save the section above as bin/${name}.
 * The section below is a SEPARATE file — split it out yourself. Save it as ${libPath}.
 * ============================================================================ */\n\n`;
  return binText + marker + scaffoldLib(libName, name);
}
