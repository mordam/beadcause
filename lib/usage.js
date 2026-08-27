/**
 * What a `bin/` command takes, read out of its own header doc comment — never by
 * running it. `bin/b7e-usage` is the argv and the printing; this is the parsing.
 *
 * Every `bin/` command in this repo already carries a leading `/** ... *\/` block:
 * a one-line summary (often `` `name` — summary. ``, sometimes plain prose), a run of
 * example invocations, and — for the `b7e-*` family especially — a paragraph starting
 * "Exit code(s)". This reads that block as paragraphs (runs of comment lines separated
 * by a blank comment line) and picks the three pieces out of it:
 *
 *   - **summary**: the name-dash pattern on the first paragraph if it has one, else
 *     that paragraph's first sentence.
 *   - **invocation**: the first run of one-or-more consecutive paragraphs whose first
 *     line starts with the command's own *registered* name — not its filename, which
 *     differs for the renamed half of the family (`beadcause-deliver` -> `deliver.js`,
 *     `b7e-owes` -> `b7e-owes.js`) — plus a trailing `Flags:` paragraph if the header
 *     has one (`bin/b7e-sandbox`'s shape).
 *   - **exitCodes**: the first paragraph anywhere in the header whose first line starts
 *     "Exit code" (`Exit codes:`, `EXIT CODE is a linter's:`, both match).
 *
 * None of this executes the file — it is `fs.readFileSync` and string matching, which
 * is the whole point: bc-dgx7.31 names six sessions that ran a command with `--help` to
 * find its flags and started a real 400-suite gate, or a real polling loop, doing it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');

/**
 * The lines of the file's first leading `/** ... *\/` block, each with its ` * ` (or
 * bare ` *` for a blank line) prefix stripped. `[]` if the file opens with anything
 * else — a shebang is skipped first, since every `bin/` file has one before its doc
 * comment.
 */
export function headerLines(source) {
  const lines = source.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '/**') {
      start = i;
      break;
    }
    if (trimmed === '' || trimmed.startsWith('#!')) continue;
    // Real code before any doc comment opened — this file has none.
    break;
  }
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '*/') return out;
    const m = line.match(/^\s*\*( (.*))?$/);
    out.push(m ? (m[2] ?? '') : line.replace(/^\s*\*\/?/, ''));
  }
  return out; // no closing `*/` found — take what there is
}

/** Header lines split into paragraphs: contiguous non-blank runs, blank lines dropped. */
function paragraphs(lines) {
  const out = [];
  let cur = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const joinTrimmed = (para) => para.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim();

function summaryOf(paras) {
  if (!paras.length) return null;
  const joined = joinTrimmed(paras[0]);
  const dashMatch = joined.match(/^`([^`]+)`\s*[—-]\s*(.+)$/);
  if (dashMatch) return dashMatch[2].trim();
  const sentence = joined.match(/^(.*?[.!?])(\s|$)/);
  return (sentence ? sentence[1] : joined).trim();
}

/** Does `para`'s first (trimmed) line start with `name` as a whole word? */
const startsWithName = (para, name) => {
  const first = para[0].trim();
  return first === name || first.startsWith(`${name} `) || first.startsWith(`${name}\t`);
};

function invocationOf(paras, name) {
  const collected = [];
  let collecting = false;
  for (const p of paras) {
    if (!collecting) {
      if (startsWithName(p, name)) {
        collecting = true;
        collected.push(p);
      }
      continue;
    }
    if (startsWithName(p, name)) collected.push(p);
    else break;
  }
  // A trailing `Flags:` paragraph (`bin/b7e-sandbox`'s shape) belongs beside the
  // invocation lines even though it does not itself open with the command's name.
  const flagsPara = paras.find((p) => /^flags:?$/i.test(p[0].trim()));
  if (flagsPara && !collected.includes(flagsPara)) collected.push(flagsPara);
  return collected.flatMap((p, i) => (i === 0 ? p : ['', ...p])).map((l) => l.replace(/\s+$/, ''));
}

function exitCodesOf(paras) {
  const para = paras.find((p) => /^exit code/i.test(p[0].trim()));
  return para ? joinTrimmed(para) : null;
}

/**
 * `{summary, invocation, exitCodes}` for one command's source text. `name` is its
 * *registered* name (a `package.json` `bin` key) — the anchor the invocation lines are
 * matched against, since it is what the header's own examples are written in terms of,
 * not necessarily the file's own basename.
 */
export function parseUsage(source, name) {
  const paras = paragraphs(headerLines(source));
  return {
    summary: summaryOf(paras),
    invocation: invocationOf(paras, name),
    exitCodes: exitCodesOf(paras),
  };
}

/** `package.json`'s `bin` map, `{name: 'bin/relative/path'}`. */
export function loadBinMap(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return pkg.bin || {};
}

/**
 * A registered name or a path resolves to `{name, relPath}` — the same command either
 * way, so `b7e-usage bin/b7e-owes.js` and `b7e-usage b7e-owes` answer identically. `null`
 * for anything the bin map does not know, including a path pointing at a real file that
 * simply is not registered — this is a registry lookup, not a filesystem guess.
 */
export function resolveCommand(input, root = ROOT) {
  const bin = loadBinMap(root);
  if (Object.prototype.hasOwnProperty.call(bin, input)) return { name: input, relPath: bin[input] };
  let norm = input.replace(/^\.\//, '');
  if (!norm.startsWith('bin/')) norm = `bin/${norm}`;
  const found = Object.entries(bin).find(([, v]) => v === norm);
  return found ? { name: found[0], relPath: found[1] } : null;
}
