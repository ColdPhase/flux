# Historical evidence archive

The large review captures and raw diagnostic outputs that used to be part of the
checkout remain available in the immutable source tree at commit
[`b17ae9e357441e9a383eb275d1034e69ec50c98a`](https://github.com/ColdPhase/flux/tree/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs).
The remote branch `archive/evidence-319-b17ae9e` pins that same commit and keeps
the tree discoverable. Existing image citations point directly to files at this
commit, so their contents do not depend on a mutable branch name.

This cleanup removes historical raster and video captures from the current tree
under `docs/agents/evidence/`, `docs/development/evidence/`, and the superseded
design exploration folders. The accepted [Prostota design](../design/final/README.md)
and its screen references, plus the local [Spokój boards](../design/spokoj/README.md),
remain in the working tree. Compact prose reports, source notes, metadata and
small scripts remain where they explain engineering outcomes or support later
work.

For a report that cites an archived capture, follow its immutable GitHub link.
For new review work, preserve the short conclusion, tested commit, commands and
result in the report, and keep full screenshot sets, recordings and raw runner
output in a CI workflow artifact linked from the report or PR. Do not copy the
archive back into the current tree.
