# Agent evidence

See the [archive and retention guide](../../development/evidence-archive.md). Compact reports, source notes, and run metadata stay here when they are useful to
maintain the product. Raster/video captures and bulky raw outputs from the
original evidence set are preserved at the [immutable archive commit](https://github.com/ColdPhase/flux/tree/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence)
on branch `archive/evidence-319-b17ae9e`.

For new work, keep the conclusion, tested commit, commands, and outcome in a
short report. Put full screenshot matrices, recordings, and raw runner output in
a CI workflow artifact and link it from the report or PR. Do not add large
raster/video files here.
