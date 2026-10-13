# Follow-up visual review — opened project Details

**Scope:** Added screenshots only, at product source `7084120254f35c44ca542b29941aee873abe1938`, Chromium, DPR 1: 320×568 and 390×844, light and dark. Scenario: signed-in PhoneFinal fixture, Community garden sensors, Tasks → title menu → Details, goal and people. This review does not inspect implementation and makes no claim about interaction or scroll behavior.

## Optional polish (low severity; not a blocking F-026 conformance failure)

The “Now in this project” in-progress item repeats its task title verbatim: the main line reads “Task in progress: Order six capacitive probes” and the smaller line below repeats “Task in progress: Order six capacitive probes.” This duplication appears in the 320 and 390 light/dark captures. It adds visual weight without adding context, especially in a compact sheet. Removing it would be a clarity improvement: keep the status and one title, and use the secondary line for distinct information or omit it. Since the canonical design has no opened project Details reference or rule requiring a unique subtitle, this is an optional improvement rather than a required conformance correction.

## What works well

The Details sheet has a clear title and project identity, then separates project overview, current work, sketches, docs, and visibility into recognizable sections. The light and dark frames preserve the same hierarchy and readable monochrome treatment. At 390 px, the snapshot shows useful project context and access information together. At 320 px, the snapshot naturally shows less below the fold; image evidence alone cannot establish whether scrolling is available or comfortable.

## Reference and coverage limits

F-026’s phone view menu establishes “Details, goal and people” as the project entry point, but the canonical screenshot set has no opened project Details reference. This assessment therefore uses the accepted phone structure and the Flux visual system rather than claiming pixel-level conformance to a dedicated Details render. The 320 px frames are 320×568 CSS px as captured, not 320×844. The returning-user Home state is not part of this addendum.
