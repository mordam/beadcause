/**
 * Promotion — a candidate becomes a real requirement, and a human is the one who says so.
 *
 * A candidate (lib/beadreqs.js) is a sentence an advocate wrote when it knew most: this
 * work is an instance of something somebody would write down. It is worth nothing until it
 * is in the corpus, and the corpus is `resources/reqs/**` in the architecture repo — a
 * file forty people clone, review and are held to.
 *
 * So the rule is absolute and is the whole of this file's design: **nothing here writes to
 * architecture on its own.** The daemon renders the exact YAML block it would add, names
 * the file and the id it would take, and files it as a question. Applying it happens after
 * a person says yes, from `bin/requirements.js`. That is lib/filing.js's shape — an agent
 * may create the *proposal* the moment it has one, and the review sits in front of the act
 * that is hard to take back — pointed at somebody else's repo, where the stakes are a
 * shared file rather than a local bead.
 *
 * ## Three refusals
 *
 * - **A token that does not exist.** `EN`, `AS`, `CDP` are products with a file each; a
 *   token nobody has heard of is a question for a human, not a file to create. Inventing
 *   `resources/reqs/product/xyz.product-requirements.yaml` would be this system deciding
 *   Climative has a new product.
 * - **An id that already exists.** Then this is not a promotion, it is an edit of somebody
 *   else's requirement, and the honest answer is to link the existing id instead.
 * - **A rewrite of any existing definition.** Nothing in this file ever changes a line it
 *   did not add. The insert is append-only inside the right document.
 *
 * ## Why the YAML is rendered rather than serialised
 *
 * The corpus is read by hand, and half of it is not valid YAML anyway (see
 * lib/requirements.js). A serialiser would reflow every quote and indent in the file it
 * touched, turning a one-line addition into a diff nobody can review — which is the surest
 * way to have the proposal rejected on sight. So the block is built as text, matched to the
 * indentation the target document already uses, and inserted at the end of that document's
 * requirements.
 */
import fs from 'node:fs';
import path from 'node:path';
import { candidateId } from './beadreqs.js';
import { isRequirement } from './requirements.js';

/** The label on a promotion question, so `bd list --label` finds every one ever asked. */
export const PROMOTION_LABEL = 'req-promotion';

const oneLine = (v, max = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Where a token's requirements are written, and how deeply.
 *
 * Derived from the corpus rather than from the filename, because the mapping is not
 * regular — `EN` is in `energy-navigator.product-requirements.yaml`, `platform` is in
 * `platform.technical-requirements.yaml`, and two tokens share
 * `climative-data-platform.product-requirements.yaml`. The one reliable answer is where
 * the ids we already parsed came from.
 */
export function homeFor(corpus, token) {
  const entries = corpus?.byToken?.get(token) || [];
  if (!entries.length) return null;
  const counts = new Map();
  for (const e of entries) counts.set(e.file, (counts.get(e.file) || 0) + 1);
  const [file] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return file || null;
}

/**
 * What a promotion would do, without doing any of it.
 *
 * `{ ok, id, file, block, why }`. `why` carries the refusal when `ok` is false, in the
 * words the question will use — a refusal a person cannot act on is the same as no answer.
 */
export function promotionFor(candidate, corpus) {
  const id = candidateId(candidate);
  if (!id) return { ok: false, why: 'the candidate names no token and name' };
  if (!corpus?.ids?.size) return { ok: false, why: 'no requirements corpus is readable on this machine' };
  if (isRequirement(corpus, id)) return { ok: false, id, why: `${id} already exists — link it rather than promoting it` };

  const file = homeFor(corpus, candidate.token);
  if (!file)
    return {
      ok: false,
      id,
      why: `no requirements file uses the token \`${candidate.token}\` — a token that does not exist is a question, not a file to create`,
    };

  const definition = oneLine(candidate.definition, 600);
  if (!definition) return { ok: false, id, why: 'the candidate has no definition, and a requirement without one cannot be tested' };

  return { ok: true, id, file, token: candidate.token, definition, block: `    ${id}:\n        definition: ${definition}\n` };
}

/**
 * The question Adam is asked, as `{ title, body }`.
 *
 * The whole proposal is in the body, because the decision is "is this sentence right" and
 * nothing about that is answerable from a title. The diff it would make is quoted exactly
 * — a proposal you have to go and reconstruct is a proposal that gets approved unread.
 */
export function promotionAsk(promotion, { bead = '', workspace = '', from = '' } = {}) {
  if (!promotion?.ok) return null;
  const lines = [
    `A candidate requirement is ready to become a real one.`,
    '',
    `**\`${promotion.id}\`** — ${promotion.definition}`,
    '',
    `It would be added to \`resources/reqs/${promotion.file}\` in the architecture repo, exactly this:`,
    '',
    '```yaml',
    promotion.block.replace(/\n$/, ''),
    '```',
    '',
    bead ? `It came from ${workspace ? `${workspace}/` : ''}${bead}${from ? `, which landed as: ${oneLine(from, 200)}` : ''}.` : '',
    '',
    '**Nothing has been written.** Approving this is a change to a repo the whole team clones,',
    'so it is applied by hand afterwards:',
    '',
    `    beadcause-requirements promote ${bead || '<bead>'}`,
    '',
    'Say no and the candidate stays on the bead — it is still a true description of what',
    'shipped, it simply is not a requirement anybody else is held to.',
  ];
  return {
    title: `Promote ${promotion.id} into the requirements corpus?`,
    body: lines.filter((l) => l !== null).join('\n'),
  };
}

/**
 * Write the block into the corpus. The one call that touches architecture.
 *
 * Inserted at the end of the document that owns the token — after its last requirement and
 * before the next `---`, so a file holding two products keeps them apart. Idempotent: an id
 * already in the file is left exactly as it is, because the alternative is this function
 * editing somebody else's definition, which it may never do.
 *
 * Returns `{ written, why }`.
 */
export function applyPromotion(corpusRoot, promotion) {
  if (!promotion?.ok) return { written: false, why: promotion?.why || 'nothing to apply' };
  const target = path.join(corpusRoot, promotion.file);
  let text = '';
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return { written: false, why: `cannot read ${promotion.file}: ${err.message.split('\n')[0]}` };
  }
  if (new RegExp(`^\\s*${promotion.id.replace(/[.]/g, '\\.')}\\s*:`, 'm').test(text)) {
    return { written: false, why: `${promotion.id} is already in ${promotion.file}` };
  }

  const lines = text.split('\n');
  // The document that declares this token, and where it ends.
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (new RegExp(`^token:\\s*${promotion.token}\\s*$`).test(lines[i])) start = i;
  }
  if (start < 0) return { written: false, why: `${promotion.file} does not declare token ${promotion.token}` };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^(?:---|===)/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // Back up over the blank lines at the end of the document, so the insert lands under the
  // last requirement rather than after the gap somebody left for readability.
  let at = end;
  while (at > start && !lines[at - 1].trim()) at -= 1;

  // Match the indentation this document already uses — four spaces in most files, two in
  // some. A block that does not line up reads as a mistake even when it parses.
  const sample = lines.slice(start, end).find((l) => /^\s+\S+.*:\s*$|^\s+\S+.*:\s+\S/.test(l) && /^\s+/.test(l));
  const indent = sample ? sample.match(/^\s*/)[0] : '    ';
  const block = promotion.block
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => l.replace(/^ {4}/, indent).replace(/^ {8}/, indent + indent))
    .join('\n');

  lines.splice(at, 0, block);
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  return { written: true, why: '', file: target };
}
