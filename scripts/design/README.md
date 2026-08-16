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
| `bodyClass` | when a rule keys off `body.has-tabbar` and friends |

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
`tabbar-check.mjs` uses) over `design-bundle/`, screenshots each card light **and** dark
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
