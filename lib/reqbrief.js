/**
 * The lookup that pays for the rest of bc-fvmx: *what does this file already carry?*
 *
 * Everything else in this feature records edges. This is the only place one is read back
 * to change what an agent does, and the case for the whole epic stands or falls here — a
 * graph nobody reads is a graph nobody should have built.
 *
 * Two answers come out of one join, and the second is the one that is hard to get any
 * other way:
 *
 * 1. **The acceptance this file is already on the hook for.** A session about to edit
 *    `lib/x.js` is told which requirements landed through it before, in their own words.
 *    That turns "be careful" — which is not actionable and is therefore ignored — into a
 *    list of sentences that must still be true afterwards.
 * 2. **Which tests must pass.** The corpus already names a Playwright spec against most
 *    product requirements. Invert requirement→files and that becomes file→spec: *this
 *    diff touches the implementation path for `EN.HiddenData`; `HiddenData.spec.ts`
 *    covers it.* Nothing else in this system can answer "which of the e2e suite is
 *    relevant to this change", and the data has been sitting in the architecture repo
 *    the whole time.
 *
 * ## What it is not
 *
 * Not a gate, not a warning, and not a claim of completeness. Coverage is partial by
 * construction — an edge exists only where a merge landed after bc-fvmx shipped, naming a
 * requirement — so the absence of a section means *nothing is recorded*, which is not the
 * same as *this file carries no acceptance*. The wording says so, because a section that
 * implied otherwise would be worse than no section: a session told "this file has no
 * requirements" would edit it more freely than one told nothing at all.
 *
 * lib/beadfiles.js's rule applies unchanged and is the reason this is safe to ship half
 * covered: a guess must not withhold work. Nothing here refuses, holds, or delays.
 *
 * ## Silent when it has nothing
 *
 * lib/memory.js's argument, borrowed whole: a heading over an empty list teaches an agent
 * that the section is furniture, and the next one it sees with something in it is skipped
 * too. No edges, no section, no mention.
 */
import { surfaceOf } from './beadfiles.js';
import { edgesForFiles } from './reqindex.js';
import { requirement } from './requirements.js';

/** How many requirements one brief names, and how much of a definition it quotes. */
const MAX_SHOWN = 6;
const MAX_DEFINITION = 220;
/** How many of the files matched are named per requirement. Three is recognisable. */
const MAX_FILES = 3;

/**
 * Render the section. Pure — `matches` is what `edgesForFiles` returned.
 *
 * Ordered by how much of a requirement's evidence these files account for, which
 * `edgesForFiles` already did: a requirement three of whose files you are about to edit is
 * far more likely to be what you are actually working on than one matching a single path.
 */
export function requirementsBrief(matches = [], corpus = null, { source = 'guessed' } = {}) {
  if (!matches.length) return '';
  const shown = matches.slice(0, MAX_SHOWN);

  const specs = new Set();
  const lines = [];
  for (const match of shown) {
    const entry = requirement(corpus, match.id);
    const definition = entry?.definition ? ` — ${entry.definition.slice(0, MAX_DEFINITION)}` : '';
    const files = match.files.slice(0, MAX_FILES);
    const more = match.files.length > files.length ? `, +${match.files.length - files.length}` : '';
    lines.push(`- **\`${match.id}\`**${definition}\n  Carried by ${files.map((f) => `\`${f}\``).join(', ')}${more}.`);
    for (const spec of entry?.specs || []) specs.add(spec.name);
  }
  const rest = matches.length > shown.length ? `\n…and ${matches.length - shown.length} more, less strongly matched.\n` : '';

  const how =
    source === 'declared'
      ? 'the files this bead declares it will touch'
      : "the files this bead's own text names";
  const tests = specs.size
    ? `
**The tests that cover them:** ${[...specs].map((s) => `\`${s}\``).join(', ')}. That list comes from the
requirement itself, not from a guess about this repo — if your change is in the implementation
path for one of the requirements above, that is the spec that has to still pass.
`
    : '';

  return `
**What these files have carried before.** Requirements that landed through ${how},
recorded when the work merged:

${lines.join('\n')}
${rest}${tests}
This is **evidence, not a specification, and not a complete list** — a requirement is only
here if a merge recorded it, so silence about a file means nothing is written down rather
than nothing is at stake. Nothing here blocks you. Treat it as what a colleague who had
worked on these files would have mentioned.
`;
}

/**
 * The section for one bead, or ''.
 *
 * Everything that touches disk lives on this side of the line, so `requirementsBrief`
 * stays a pure function a test can drive — the split every prompt builder in lib/session.js
 * keeps, for the same reason.
 *
 * Never throws. A brief is what an unattended session gets instead of a conversation, and
 * a lookup failure must cost this paragraph rather than the window.
 */
export async function requirementsFor(bead, dirs = [], corpus = null) {
  try {
    if (!corpus?.ids?.size || !dirs.length) return '';
    const { files, source } = surfaceOf(bead, dirs);
    if (!files.length) return '';
    const matches = await edgesForFiles(files, { dirs });
    return requirementsBrief(matches, corpus, { source });
  } catch {
    return '';
  }
}
