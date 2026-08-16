# design/ — the screens as something you can move

`*.excalidraw` files are plain JSON. That is the entire reason they are here: Adam
can drag a box at excalidraw.com and an agent can read what moved out of the diff,
with no export step and nothing in between that has to be trusted.

## The loop

1. **Open** `design/inbox.excalidraw` at <https://excalidraw.com> — *File → Open*, or
   just drag the file onto the canvas.
2. **Move things.** Boxes, cards, whole screens. Each card is a group, so dragging
   one takes its pills and its question with it; each screen is a group too.
3. **Save back to the same file** — ⌘S in Chrome, which holds a handle on the file
   you opened. In a browser without the File System Access API you get a download to
   `~/Downloads` instead, and you have to move it over the original yourself.
4. **Tell the session it moved.** `git diff design/` is the whole handoff — an agent
   reads the coordinates and turns them into `public/style.css`.

There is a VS Code extension (`pomdtr.excalidraw-editor`) that opens these files in
the editor if you would rather not leave it. Same file, same loop.

## Why not Figma

Figma can be imported *into* — the `html.to.design` plugin pulls a live URL in as
real layers, and it would give a prettier starting point than this does. What it
cannot do is give the file back. Figma's REST API is read-only for document content:
nothing an agent writes becomes a `.fig`, and reading hand-edits out means walking
node geometry and re-deriving intent. That is a re-implementation, not a diff, and it
is wrong often enough that you would stop trusting it. An `.excalidraw` costs some
fidelity and buys a round trip that actually closes.

## The generator, and the rule it lives under

`wireframe.mjs` seeds a screen from a layout spec carrying the real numbers off
`public/style.css` — the topbar's 10/16/10, `--tabbar-h: 54px`, `--radius: 14px`,
`.card-head`'s 14/15/0, `.list`'s 12px gap, the 52px compose. A wireframe that lies
about spacing is worse than no wireframe, because it gets believed.

```sh
node design/wireframe.mjs --check          # has anything been moved yet?
node design/wireframe.mjs --write inbox    # (re)seed a screen — DESTRUCTIVE
```

**`--write` over a screen somebody has edited destroys exactly the thing this
directory exists to collect.** `--check` is the safe verb: it regenerates into memory
and tells you whether the file on disk still matches. It never exits non-zero — drift
*is* the point — so nothing in `npm test` gates on it. Once a screen has been touched
by hand, the `.excalidraw` is the source of truth and the generator is history.

Adding a *new* screen is what `--write` is for: write a function, add it to `SCREENS`,
run `--write <name>` once, and it joins the loop.

## Two details that are load-bearing

- **Every label is a bound text child of its box** — `containerId` on the text,
  `boundElements` on the rectangle. An unbound label is a separate element that stays
  behind when you drag the box it names, and after three drags the file is a field of
  orphaned words. `validate()` in the generator refuses to emit a file where the two
  halves of a binding disagree.
- **Seeds are derived from element ids, not random**, so a regenerate of an untouched
  screen is a byte-identical file rather than a whole-file diff.

## What the first save looks like

Excalidraw rewrites the file in its own key order and with its own `appState`, so the
*first* save after opening produces a large diff even if you moved one box. That is
one-time. After that the diffs are small and readable: `x`/`y` on what you moved, plus
a bumped `version` and `updated` on those elements — which is itself useful, because
it says which elements you touched.
