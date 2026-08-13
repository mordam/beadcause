# The service worker's cache versions

One file per bump of `const CACHE = 'beadcause-vNN'` in `public/sw.js`, saying what
changed and — the part worth having — which two files a phone must not be left holding
one each of. The argument is the point: a mixed cache is nearly always an app that
looks like it is working.

These lived as comment blocks above the `const` until bc-5ghk. Around eight worker
sessions run against this repo at once, and every branch that bumped appended to the
same region of the same file, so two unrelated changes conflicted on merge for no
reason but where the prose sat. Adding a version is adding a file now, the same way
adding a suite is adding a file under `test/` — and two branches adding different files
never conflict.

**To bump:** write `vNN.md` for the next free number, with `# vNN — <what changed>` as
its first line, and set the `const` in `public/sw.js` to match. Nothing generates
either from the other; `node test/swcache.mjs` is what checks they agree.

**The name is exactly `vNN.md`** — no slug. Two branches that both pick `v39` have to
collide on one path so git reports it, because the `const` line will not: two branches
writing it the same value merge clean and silently. When that collision happens, keep
both notes, `git mv` yours to the next free number (moving the version pairs named
inside its own prose up with it), and set the `const` by hand to the highest number
here.

The whole argument, including when a change legitimately owes no bump at all, is in the
header of `public/sw.js` and in the README's [cache version
section](../../README.md#the-shells-cache-version--one-note-per-bump-rather-than-one-line).
