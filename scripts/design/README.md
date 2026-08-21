# The Claude Design bundle

Beadcause's design system, published to claude.ai/design as a project of 54 preview
cards. This directory is the generator; the cards are derived.

    project  Beadcause
    id       4ad339ac-2345-41ab-b77c-4af54de68b37

The id is what `DesignSync` takes as `projectId`; open the project itself from the
design-system list on claude.ai.

```sh
node scripts/design/build.mjs        # → design-bundle/ (gitignored)
node scripts/design/check.mjs        # the static gate: run this before any push
node scripts/design/shots.mjs        # the rendering gate: real Chrome, both themes
node scripts/design/serve.mjs 4577   # look at it in a browser yourself
node scripts/design/audit.mjs [path] # what a card is missing
node scripts/design/coverage.mjs     # what no card covers yet
node scripts/design/compound-coverage.mjs  # what no card covers *together*
```

## Why it is generated rather than hand-written

`public/style.css` is 293 KB and 1,314 rules. A card cannot inline it — fifty times
over that is 15 MB — and it cannot link to it either, because a preview has to stand
on its own. So `cssslice.mjs` parses the sheet and each card gets three things: the
token block, the element-level base rules, and **only** the rules whose classes that
card actually renders.

The match is **strict**: a rule survives only if *every* class in its selector is one
the card's markup carries. Permissive matching — "any class in common" — drags a card
like `.card` into every descendant rule in the sheet, hundreds of which never fire.
Strict also fails in the useful direction: a rule that vanishes because the markup
forgot a class shows up as a preview that looks wrong, and wrong is a signal where
dead CSS is not.

Selector lists are kept per comma-part, so `.pill, .chip` survives for a card that
only draws pills. The split is on top-level commas only — `:not(a, b)` and
`color-mix(…)` both carry commas that are not selector separators.

## What is in a card

`manifest.mjs` (foundations, chrome, decisions) and `cards-surfaces.mjs` (everything
else) are the authored part. Each entry is:

| field | |
|---|---|
| `path` | file inside the project, and its identity there — **keep it stable** |
| `group` | the section it lands in in the Design System pane |
| `note` | why the component is the way it is, not what it looks like |
| `markup` | the app's own markup, with synthetic content in it |
| `extraCss` | spec-sheet styling for foundations cards, which have no app classes |
| `bodyClass` | when a rule keys off `body.console-body` and friends |

The first line of every built file is `<!-- @dsCard group="…" -->`, which is what the
Design System pane builds its card index from. No explicit `register_assets` call is
needed.

**Markup is copied, never invented.** `node scripts/design-shapes.mjs monitor.js`
prints the distinct `class=` combinations a file emits; that is where these came from.
`node scripts/design-inventory.mjs` is the wider survey — all 821 classes the sheet
defines and which of the app's files use each.

**Content is synthetic on purpose.** The project lives on claude.ai. Real bead titles,
agent logs and account addresses have no business being uploaded to it, so the beads in
these previews are invented and the structure around them is real.

## The gate

`check.mjs` fails the bundle on five things:

- a class the app has never heard of — a typo that renders fine and is not the component
- a slice thin enough to mean the matcher rejected everything (`< 8` rules, `< 3` for foundations)
- a missing `@dsCard` marker, or a missing token block
- two cards claiming the same path, which `write_files` would silently collapse
- a **load-bearing rule that went missing** — a small table of declarations that must
  survive, so a future change to the slicer fails here rather than shipping fifty
  previews that are subtly not the app

`roundtrip.mjs` is the parser's own test: it must put `public/style.css` back together
byte for byte.

## The rendering gate

`check.mjs` reads the built files and `audit.mjs` reads the sheet; neither has ever seen
a card *render*, which is the one claim a design system actually makes. `shots.mjs`
drives the repo's own headless-Chrome harness (`scripts/helpers/chrome.mjs`, the same one
`topbar-check.mjs` uses) over `design-bundle/`, screenshots each card light **and** dark
into `design-shots/`, and probes the computed styles.

The screenshots are for a person. The probes are the gate, because a screenshot of a
completely unstyled page looks fine to a script and wrong only to an eye that happens to
be looking. Three things it proves without one:

1. **the token block reached the page** — `body`'s background *is* that theme's `--bg`
2. **the two themes are really two** — the PNGs differ byte for byte, which is the only
   thing that catches a card whose `prefers-color-scheme` block was lost in slicing
3. **the component's own rules fired** — a `PROBES` table of computed-style assertions,
   applied only where the selector is present, so one table covers all 77 with no
   per-card wiring

**Narrow every probe to the exact variant.** All of the first run's false alarms were the
probe's fault: `.pill` matched `.pill.id` first (a bead id is deliberately not uppercased),
`.card` matched `.card.open` (square on purpose, being the screen), `.primary` matched
`.primary.danger` (red on purpose), and `.filter-typeahead .pill` opts out of uppercase
because it is a monospaced id. A probe that asserts the base case against a page showing
the exception reports a defect that is not there.

It still earned its keep on the first run — three real defects, all the same shape, a
positioned element previewed without the ancestor it positions against:

| card | was | is |
|---|---|---|
| `monitor/release` | `.release-count` in `.release-head` → escaped to the page corner | inside `.board-btn.ship`, where the sheet puts it |
| `overlays/drawer` | bare `.drawer` → measured against the page and spilled | inside `.drawer-wrap`, the `fixed; inset: 0` layer |
| `workrows/tags` | prose claiming `.spark` animates | it is a grey dot; it breathes only in context |

That last one is the useful kind: the CSS was right, the *card's own explanation* was
wrong, and only a render could tell them apart.

## Pushing an update

The sync is **incremental, one component at a time** — never a wholesale replace. Paths
are the card's identity in the project, so renaming one orphans its card rather than
moving it.

```
DesignSync list_files    → what is up there now
DesignSync finalize_plan → lock the paths, with localDir = design-bundle/
DesignSync write_files   → localPath, so contents never enter the model context
```

## The one-way part

`DesignSync` writes to claude.ai; nothing writes back to `public/style.css`. The local
sheet stays the source of truth and this project is a reference surface — it drifts
unless somebody rebuilds and pushes. `check.mjs` catches a card that no longer matches
the sheet's *classes*, but not one whose values have moved on.

## The contrast audit

```sh
node scripts/design/contrast.mjs        # every text run, both themes, WCAG AA
node scripts/design/contrast.mjs --all  # including the passes, for the ratios
```

It has to run in a browser. Almost nothing in `public/style.css` states a contrast pair
outright: colours arrive through `var(--muted)`, through
`color-mix(in srgb, var(--accent) 60%, transparent)`, through an `rgba()` over a surface
that is itself tinted — and the background a piece of text sits on is usually painted by
an ancestor three levels up. Only the computed style knows, and only after the cascade
has run in both schemes.

Three things it must get right, each a way the naive version lies:

- **Alpha.** `color` is frequently `rgba(…, .72)` here, because `color-mix(…, transparent)`
  computes to exactly that. Text at 72% alpha does not have the contrast of its own
  colour; it is composited over what is behind it first.
- **The real background.** `backgroundColor` is `rgba(0, 0, 0, 0)` on most elements. The
  ground is whichever ancestor last painted, composited down the chain.
- **What is actually text.** An element with no own text node contributes nothing.
  Measuring containers double-counts and reports one string under a dozen selectors.

Findings group by rule, not by card: one rule is wrong everywhere it is drawn, and fifty
rows saying `.subtitle` is thin is one finding.

**It exits non-zero when anything is under AA** (bc-15tu), which it did not before: it
printed its findings, returned 0, and the rules it had already named stayed in the sheet
while a bead carried them around instead. A check nothing can fail is a check nothing runs,
and this one is cheap enough — one Chrome, 77 cards, both themes — to be run before any
push that touches colour. `--all` is exempt: that mode is for reading the ratios of rules
that pass, and it is not asking a question.

**A card's own furniture is excluded, and its prose along with it.** `.ds-stack` and
`.ds-label` wrap the app's markup, so only the wrapper is skipped and its children are
still the component. `.ds-note` is different — it is the card's commentary, so everything
inside it is skipped too. That half was missing, and it read as a real finding: a note
carrying `<a href="#">` gives the anchor no class, the sliced sheet has no element rule
for one, and the UA's default blue measured 2.05:1 on the dark page. A failing rule the
app does not have is worse than no audit at all, because it is the one you learn to
scroll past. It is also why the run measures around 1,300 text runs rather than the 1,660
it used to — the difference is `<b>`, `<code>` and `<a>` inside the notes, which were
never the app.

**What no card draws, this cannot measure.** `.pr-stage.st-live` was under AA in the light
scheme for as long as the rules bc-15tu was filed for, and never appeared in a single run:
the pills card drew `pill st-live` where public/prcard.js draws `pill pr-stage st-live`, so
the colour rule never matched, the card showed a grey pill, and the audit measured
`--muted` and passed it. That is the hazard of a strict slice — markup that forgets a class
produces a card that looks wrong *and* an audit that reports nothing — and it is worse than
`coverage.mjs` could see, because coverage is decided one class at a time and both halves
of that selector were covered separately. The rule from the top of this file is the first
defence: **markup is copied, never invented.**

```sh
node scripts/design/compound-coverage.mjs        # gaps, colour-bearing ones first
node scripts/design/compound-coverage.mjs --all  # every compound, matched or not
```

bc-ka5y.16 is the general form, and this is its answer: every selector in the sheet that
chains two or more classes on one element (`.pr-stage.st-live`, not the descendant
`.pr-stage .st-live`), checked against whether any card's actual `class="…"` attribute
carries the whole set — not whether each class is covered somewhere on its own. A crude
probe over the sheet when the bead was filed counted 525 such compounds, 290 rendered
together by no card at all, 134 of those setting a colour or background; both the
co-occurrence test and the colour test here are still text matches rather than a real
cascade, so treat every count as an upper bound the same way — some gaps are legitimately
uncoverable (`:has()`, a state no static card can be in). `test/compoundcoverage.mjs` pins
`.pr-stage.st-live` itself as the worked example: it asserts the real sheet and the real
manifest report that selector as covered, so a markup edit that separates the two classes
again fails a suite that runs in `npm test`, rather than waiting to be noticed in a
browser-driven contrast run nothing gates on.

## The vocabulary count, and the two scales it produced

```sh
node scripts/design/vocabulary.mjs          # the smear, per axis
node scripts/design/vocabulary.mjs --full   # including the long tail of one-offs
```

A design system's claim is that a screen is assembled from a small vocabulary, and that is
checkable rather than assertable: the baseline fingerprint already holds every computed
value on every element of all 77 cards, so this reads it back and counts. What it looks for
is the **smear** — 13px and 13.5px and 12.5px doing one job, three radii within two pixels
of each other, a weight scale with 650 and 640 and 620 in it.

Run at bc-03pz it found the palette and the metrics in very different health. The colours
were disciplined: 12 distinct text colours in the light scheme, all of them tokens, nothing
drifted. The metrics were not: 23 radii, 16 weights, 22 type sizes. **The difference is that
the palette was checkable and the metrics were not** — an off-palette colour is a literal
hex among `var(--…)` and fails review on sight, where `9px` beside `10px` and `11px` looks
like every line around it.

So two of the three axes now have a scale and a suite, and `test/metricscale.mjs` is the
thing the palette had all along:

| axis | scale | why |
|---|---|---|
| corner radius | `6 / 10 / 14 / 18`, plus `999px` and `50%` | four apart on purpose — this script calls two radii within 2px a smear, so a scale with 2px steps would be one |
| font weight | `400 / 550 / 600 / 650 / 700` | the four this count found carrying the app, plus the one real bold |
| type size | **not enforced** | 22 sizes and the worst of the three, but a type scale moves layout on a 360px phone. That is a design decision, not a normalization, and it is still open |

Radius and weight could land unattended precisely because neither can move a box: the whole
snap moved seven text runs by 1–3px and not one box height, which is what `baseline.mjs`
below was used to prove. Re-run this count after any change to the sheet.

## The regression baseline

```sh
node scripts/design/baseline.mjs --save   # record
node scripts/design/baseline.mjs          # compare
```

**It fingerprints computed styles, not pixels**, and that was not the first design.
Hashing the PNG is the obvious build and it does not work: `captureBeyondViewport` at
`deviceScaleFactor: 2` is not byte-stable, and a save-then-compare with nothing changed
moved between one and fifteen cards per run, never the same ones. Disabling every
animation and waiting two frames for layout did not fix it. A screenshot is the right
artifact for a person and the wrong one for a machine.

Reading the cascade back out of the page is deterministic — two consecutive runs of an
unchanged tree agree exactly — and it diffs far better. Pixels can only say a card moved;
this says which rule, in which theme, from what to what:

```
button.primary.danger · color · rgb(255, 255, 255) → rgb(43, 13, 13)
    3 render(s) — decisions/answer-box-variants.html:dark, overlays/dialog.html:dark, …
```

One residual needed `freeze()` in the harness: `.spark`'s opacity, read mid-breath.
`shots.mjs` deliberately does **not** freeze — its probe asserts that a live row's spark
really is running, which a frozen page cannot show.

The baseline lives in `design-shots/`, which is gitignored, so it is per-machine and a
fresh clone has none. That is the honest default: a baseline recorded on someone else's
machine is a claim about their fonts.
