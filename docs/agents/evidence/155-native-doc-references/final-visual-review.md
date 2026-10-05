# Independent visual review — current document reference picker

Evidence pin: `0cdf9493d3ae7d7993c33a2ba9bf18db46281b4f` (runtime revision supplied by the review brief; implementation and author explanations were not inspected).

Screenshots inspected using `view_image`:

- `/tmp/flux155-doc-ref-ui-final-shots/155-doc-reference-work-desktop.png` — supplied 1440×900 CSS viewport at 100% zoom; SHA-256 `44197c5b6c14e981ce5eabdad58a5dd39a6dbca3cb25d45b3c6aeea24eb75248`.
- `/tmp/flux155-doc-ref-ui-final-shots/155-doc-reference-work-phone.png` — supplied 390×844 CSS viewport at 100% zoom; SHA-256 `77fd9b9070e7a528c82b60c6a2832dbb643d3b6e118eaed2a717be0756ed123f`.

Scope: independent screenshot assessment under the same neutral brief: a maker writing project documentation, preserving private text and linking an older native task. Assess exposed controls/list readability, native-type/page identity, action discoverability and compact working density. Accepted direction: Studio 11.6, readable compact project workspace, usable phone controls, no global scaling. The Flux visual-review skill and current design/Studio 11.6 references were read for this review sequence. No app/code edits or live interaction.

## Material visible finding

1. **Insertion guidance is not visible within the supplied phone viewport.** The selected `Native work reference 009` row is visible near the bottom, but no touch insertion cue or insertion action appears in the 390×844 capture. The desktop displays `Enter insert`. The phone picker reaches the viewport bottom, so any guidance below the captured row would be out of view in this state. A first-time user has to infer whether tapping highlights, previews or inserts a reference. Put a compact touch cue in the visible picker header/above the results, or keep an insertion affordance visible while browsing. This finding is about action discoverability in the captured state; it does not claim the control or guidance is absent elsewhere or that insertion fails.

## Clear useful elements to preserve

- `Find work…` now agrees with the selected Work type, giving a coherent search scope in both captures.
- `Type: Work`, the row type labels and `51–100 of 105 matches` clearly expose the broad native category and pagination position.
- Neutral backgrounds, dark result titles, aligned columns and a quiet selected row are readable without competing with the project/editor context.
- Eight compact desktop rows and six roomier phone rows provide useful working density. Phone pagination controls stack without horizontal clipping; avoid shrinking text or controls to force more results.
- Desktop keeps private-draft text visible below the picker and provides unobtrusive keyboard guidance. Phone preserves project, Docs, title and Write/Preview/Link context above the picker.

## Missing states and live questions — unverified

Only one populated Work page with short repetitive fixture titles and one selected row is shown. Search results, long/duplicate titles, stable task IDs/status, other native types, first/last pages, empty/loading/error states, inaccessible/deleted references, inserted links, picker closing, restored drafts, save/preview/history and the phone picker footer are not evidenced. Precise reference disambiguation under realistic names needs separate evidence.

Touch insertion/close behavior, picker/page scrolling, draft retention and privacy, virtual-keyboard layout, keyboard/focus behavior, responsive transitions, actual target sizes/contrast/accessibility, permissions, network contents, API/persistence and data correctness remain unverified. Images establish no real-device/PWA acceptance or motion/presence behavior.

Outcome: one remaining visible action-discoverability finding in the supplied phone state; scope/type clarity, readability and working density support the brief. This is not whole-task, runtime, data, accessibility or device approval.
