# The Claude Design bundle

Beadcause's design system, published to claude.ai/design as a project of 54 preview
cards. This directory is the generator; the cards are derived.

    project  Beadcause
    id       4ad339ac-2345-41ab-b77c-4af54de68b37

The id is what `DesignSync` takes as `projectId`; open the project itself from the
design-system list on claude.ai.

```sh
node scripts/design/build.mjs        # → design-bundle/ (gitignored)
node scripts/design/check.mjs        # the gate: run this before any push
node scripts/design/serve.mjs 4577   # look at it in a browser first
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
