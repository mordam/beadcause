# A probe pull request — bc-36xx.8

This file exists so that this pull request has a diff. Nothing here is meant to merge, and
the pull request is closed within a minute of being opened.

Why it exists: bc-36xx.8 adds `approve()` to `lib/pr.js` — an approving review submitted as
the GitHub account that did *not* open the pull request, because GitHub refuses one from an
author. That a `READ` collaborator may approve a pull request it did not author is
documented GitHub behaviour, and until this probe nothing in beadcause had ever tried it.
Proving it on a real change would have meant claiming a review of work nobody reviewed, so
it is proved here instead, on a pull request whose only content is this paragraph.

The approving review on this pull request, and the comment under it, are exactly what the
shipped code produces. The verdict they were built from says what they are.
