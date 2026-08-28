/**
 * The claims a delivery makes, checked against what the branch actually says — bc-dgx7.130.
 *
 * Four beadcause-worker sessions in the deluvia tracker (dv-5i2.98, dv-5i2.97, dv-5i2.96,
 * dv-5i2.92) each ended the same way: write a prose `--tests` string and a PR body from
 * memory, run `git diff main...HEAD --name-only`, read the two against each other by eye,
 * then fire `bin/deliver.js`. dv-5i2.98's own eyeball read "Matches what I described" —
 * true of the file list, false of a sentence three paragraphs earlier that decided
 * `--review` and never threaded it back into the actual argv. The file list was never the
 * risk; the risk was a claim the eyeball had no reason to re-check because it read as prose,
 * not as an argument.
 *
 * This is the pure decision logic — three independent checks, each returning a list of
 * findings or nothing. `bin/b7e-vouch` is the argv parsing, the `git diff` and `bd show`
 * calls, and the printing around it.
 *
 * 1. `checkFlags` — a flag from `bin/deliver.js`'s own surface (`KNOWN_FLAGS` below),
 *    written literally as `--something` in the body's prose, checked against the argv the
 *    caller says it is about to hand `deliver.js`. Both directions for the two flags whose
 *    silent presence or absence actually changes what a delivery does (`--review`,
 *    `--no-merge`); the body-claims-it-but-argv-lacks-it direction for every other flag on
 *    `deliver.js`'s surface, since a body almost never spells out `--tests` or `--risk` by
 *    flag name and checking that direction for those would be noise, not signal.
 *
 * 2. `checkPaths` — every file the branch actually touched (`git diff <base>...HEAD
 *    --name-only`, the same three-dot form `bin/deliver.js` itself runs for its diffstat)
 *    against what the body's prose names. A changed file is "mentioned" by its full path,
 *    its bare filename, or its filename stem (extension off) appearing anywhere in the
 *    body — checked with the bead's own `description` and `acceptance_criteria` folded in
 *    as a fallback, because a body is allowed to say "both files named in the bead's
 *    acceptance criteria" rather than repeat them (dv-5i2.96's real PR body does exactly
 *    this for `CHAPTER_18A_THE_PARTING.summary.md`, and the check has to survive that
 *    without flagging a body a human read and accepted). A path-like token *in the body*
 *    that names something not in the diff is checked against the body alone — the bead's
 *    own fields describe the ticket, not this branch, and folding them into that direction
 *    would flag every file the epic ever talks about that this particular diff didn't touch.
 *
 * 3. `checkTests` — script/suite names mentioned in the `--tests` value itself (the value
 *    handed to `deliver.js --tests`, not the free-form body) against the recorded gate run
 *    at `--ran`. A name that does not appear anywhere in that record did not run — most
 *    often because it was renamed after the run and the `--tests` prose was never updated
 *    to match.
 */

/** Every flag `bin/deliver.js` actually reads off its own argv (grepped from its `arg()`/
 * `has()` calls) — the surface a body's prose could plausibly claim about. Short aliases
 * (`-w`, `-b`, `-t`, `-f`, `-h`) are deliberately not scanned for in prose: a bare `-w` or
 * `-t` in ordinary text is not a claim about anything. */
export const KNOWN_FLAGS = [
  '--workspace',
  '--bead',
  '--method',
  '--base',
  '--tests',
  '--risk',
  '--left',
  '--title',
  '--file',
  '--dir',
  '--owed',
  '--review',
  '--no-merge',
  '--help',
];

/** The two flags whose silent presence or absence actually changes what a delivery does —
 * `review` in `bin/deliver.js` is `has('--review') || has('--no-merge')`, so either spelling
 * routes the same way. Checked in both directions; every other known flag only forward. */
export const GOVERNANCE_FLAGS = ['--review', '--no-merge'];

/** Whether `token` occurs in `text` as itself — not as a substring of a longer flag or
 * identifier (`--review` must not match inside a hypothetical `--reviewed`, and a filename
 * stem like `12` must not match inside `120`). Hyphens count as part of the token for this
 * purpose, since a flag like `--no-merge` is itself hyphenated. */
export function mentionsToken(text, token) {
  if (!text || !token) return false;
  const esc = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9_-])${esc}(?![A-Za-z0-9_-])`);
  return re.test(text);
}

/**
 * The flags a body's prose claims about a delivery, checked against the argv the caller
 * says it is actually about to run. `argvTail` is `null` when the caller supplied no `--
 * <argv>` at all — there is nothing to compare against, so this returns no findings rather
 * than guessing that an absent argv means an empty one.
 */
export function checkFlags(body, argvTail) {
  if (argvTail === null || argvTail === undefined) return [];
  const findings = [];
  for (const flag of KNOWN_FLAGS) {
    const claimed = mentionsToken(body, flag);
    const present = argvTail.includes(flag);
    if (claimed && !present) {
      findings.push({
        where: 'body',
        kind: 'flag-not-in-argv',
        message: `body claims ${flag} — the argv handed to deliver.js does not include it`,
      });
    }
    if (GOVERNANCE_FLAGS.includes(flag) && present && !claimed) {
      findings.push({
        where: 'argv',
        kind: 'flag-not-in-body',
        message: `argv passes ${flag} — the body never mentions it`,
      });
    }
  }
  return findings;
}

/** Extensions a claimed "this file changed" mention plausibly ends in — source, docs,
 * config, data. Deliberately excludes binary/asset extensions (`.bin`, `.png`, …): a body
 * describing what an *existing* asset is used for often names it slash-and-all (dv-5i2.98's
 * real PR body explains the live atlas reading `elevation.bin/biomes.bin`, neither of
 * which this diff touched) without claiming it changed, and nothing distinguishes that
 * from a real claim except that a changed-file list here never contains one. */
const PATH_CLAIM_EXTENSIONS = 'js|mjs|ts|py|md|json|jsonl|sh|txt|yml|yaml|html|css';

/** Paragraphs `lib/prtext.js`'s `prBody` appends as their own bold-label blocks —
 * `**Tests:** <the --tests value>`, `**Worth knowing:** <--risk>`, `**Left undone:**
 * <--left>`. These name scripts/suites that *ran*, not files that changed (a real
 * `--tests` value routinely reads `scripts/check_entry040_funday.py . → PASS`, a path-
 * shaped token this diff never touched), so they are excluded before extracting "this
 * file changed" claims — never from the lenient "is this changed file mentioned
 * anywhere" direction, where the extra text can only help. */
const SIDE_PARAGRAPH_RE = /^\*\*(?:Tests|Worth knowing|Left undone):\*\*/;

/** `lib/prtext.js`'s own `filesBlock` — the auto-generated `<details>…</details>`
 * diffstat `prBody` appends. Mechanically derived from the real diff, so it can never
 * itself disagree with it; stripped before claim-extraction so its own path tokens (which
 * routinely fragment on a directory name that contains a space, like deluvia's `novel/
 * Deluvia Book 3/…`) are never mistaken for a hand-written claim. */
const DETAILS_BLOCK_RE = /<details>[\s\S]*?<\/details>/g;

function withoutSideParagraphs(body) {
  return String(body || '')
    .replace(DETAILS_BLOCK_RE, '')
    .split(/\n\s*\n/)
    .filter((para) => !SIDE_PARAGRAPH_RE.test(para.trim()))
    .join('\n\n');
}

/** Path-like tokens named in free-form prose: at least one directory segment, ending in a
 * short extension — `reference/maps/rebuild_world_data.py`, `lib/toolbelt.js`. Deliberately
 * requires a `/`, so an ordinary abbreviation like `e.g.` or `i.e.` never matches: nothing
 * in real prose that isn't a path claim happens to look like one under this shape.
 *
 * Rejects a match whose non-final segment itself ends in a recognised extension — a real
 * directory component never does, but prose shorthand for "these two files" routinely
 * joins two bare filenames with a bare `/` (dv-5i2.98's real PR body reads
 * `AMERICAS_SOUTH.md/PERU_BOLIVIA.md`, meaning "and", not a path), and that shape would
 * otherwise read as one path one directory deep. */
function extractPathClaims(body) {
  const re = new RegExp(`(?:[\\w.-]+/)+[\\w.-]+\\.(?:${PATH_CLAIM_EXTENSIONS})\\b`, 'g');
  const extRe = new RegExp(`\\.(?:${PATH_CLAIM_EXTENSIONS})$`);
  const matches = String(body || '').match(re) || [];
  return [
    ...new Set(
      matches.filter((m) => {
        const segments = m.split('/');
        return !segments.slice(0, -1).some((seg) => extRe.test(seg));
      })
    ),
  ];
}

/** Is `claim` (a path-like token pulled out of prose) the same file as `diffFile` (a real
 * repo-relative path from `git diff --name-only`) — exact, or one ending where the other
 * begins, so `maps/rebuild_world_data.py` still matches `reference/maps/rebuild_world_data.py`. */
function samePath(claim, diffFile) {
  if (claim === diffFile) return true;
  return diffFile.endsWith(`/${claim}`) || claim.endsWith(`/${diffFile}`);
}

/**
 * Every changed file (`diffFiles`, from `git diff <base>...HEAD --name-only`) against what
 * `body` names, with `context` (the bead's own description + acceptance criteria, joined)
 * as a fallback source of mentions — never a fallback source of *claims*, so a file the bead
 * talks about that this particular diff never touched is never flagged from `context` alone.
 */
export function checkPaths(body, context, diffFiles) {
  const findings = [];
  const bodyText = String(body || '');
  const files = diffFiles || [];

  for (const claim of extractPathClaims(withoutSideParagraphs(bodyText))) {
    if (!files.some((f) => samePath(claim, f))) {
      findings.push({
        where: 'body',
        kind: 'path-not-in-diff',
        message: `body names ${claim} — not in the diff against the base`,
      });
    }
  }

  const searchText = `${bodyText}\n${context || ''}`;
  for (const f of files) {
    const base = f.includes('/') ? f.slice(f.lastIndexOf('/') + 1) : f;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    // The stem fallback is for an identifier like `CHANGE_LOG` standing in for
    // `CHANGE_LOG.md` — real prose does this for a distinctive name, never for a plain
    // dictionary word. Gated on looking like an identifier (a digit, an underscore, or an
    // uppercase letter) rather than ordinary lowercase prose, so a stem like `regions`
    // cannot silently match the word "regions" inside an unrelated sentence about a
    // *different* file's directory (dv-5i2.98's own real PR body says "New
    // reference/regions/map_guides/…", which would otherwise stand in for
    // `reference/maps/web/regions.json` — a different file it never mentions at all).
    const stemLooksLikeAnIdentifier = /[A-Z0-9_]/.test(stem);
    const mentioned =
      searchText.includes(f) ||
      mentionsToken(searchText, base) ||
      (stem.length >= 3 && stemLooksLikeAnIdentifier && mentionsToken(searchText, stem));
    if (!mentioned) {
      findings.push({
        where: 'diff',
        kind: 'path-not-in-body',
        message: `${f} changed — the body never mentions it`,
      });
    }
  }
  return findings;
}

/** Script/suite-shaped names mentioned in a `--tests` value: a path segment or bare name
 * ending in a common test-script extension — `scripts/check_saga_audit.py`,
 * `test/b7evouch.mjs`, `check_entry040_funday.py`. */
export function extractGateNames(testsValue) {
  const re = /[\w][\w./-]*\.(?:py|mjs|js|ts|sh)\b/g;
  return [...new Set(String(testsValue || '').match(re) || [])];
}

/**
 * Gate names claimed in `testsValue` against `ranContent` — the raw text of whatever
 * `--ran` pointed at (a captured transcript, a `lib/gaterun.js` JSONL run, anything a
 * gate's real name would appear in verbatim). A name not found there did not run under
 * that name — renamed, typo'd, or never run at all — and `ranFile` is carried on the
 * finding so the message can say where it looked.
 */
export function checkTests(testsValue, ranContent, ranFile) {
  if (testsValue == null || ranContent == null) return [];
  const findings = [];
  for (const name of extractGateNames(testsValue)) {
    if (!ranContent.includes(name)) {
      findings.push({
        where: '--tests',
        kind: 'gate-not-in-run',
        message: `--tests claims a run of ${name} — not found in the recorded run${ranFile ? ` at ${ranFile}` : ''}`,
      });
    }
  }
  return findings;
}
