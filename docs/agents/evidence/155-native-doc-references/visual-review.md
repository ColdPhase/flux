# Independent visual review — document reference picker

Evidence pin: `8ac82c405d9b20d6f20470a168247acdfddc9cfa` (revision supplied in the review brief; no implementation or author history inspected).

Screenshots inspected with `view_image`:

- `/tmp/flux155-doc-ref-ui-owner-shots/155-doc-reference-work-desktop.png` — supplied 1440×900 CSS viewport, 100% zoom; SHA-256 `1d9ceb9530e208deb9b8dbd3cc5b08c76bef8f2b16e45b2ce22a27d92db39b49`.
- `/tmp/flux155-doc-ref-ui-owner-shots/155-doc-reference-work-phone.png` — supplied 390×844 CSS viewport, 100% zoom; SHA-256 `4a496b34ad4b082b8b7b68cf8e9e73dee796dae53840b2b4a1abea2f228085f5`.

Scope: fresh neutral assessment of the exposed reference picker, controls, list, identity cues, action discoverability and working density. Persona: maker writing project documentation, preserving private text and linking an older native task. Read the Flux visual-review skill, current design README, Studio 11.6 contract/reference index and gallery; inspected the current 1440px Wiki reference. No app edits, code inspection or live interaction. The accepted direction remains a compact readable project workspace with usable controls and phone touch targets; the reference is direction, not a template.

## Material visible findings

1. **Search scope hint conflicts with the selected native type (both captures).** The picker displays `Type: Work` and Work rows, while its search hint says `Find a doc, decision, result…`. The hint omits the category the user is currently searching. A maker seeking an older task has to infer that this field also searches Work. Include Work/task in the hint, or make the hint reflect the selected type using the accepted product vocabulary. This is a visible scope-clarity issue; it does not establish a search defect.

2. **Phone insertion action is weakly signposted (phone, lower picker).** The gray selected `Native work reference 009` row is visible, but the capture contains no `Insert` control or touch instruction. The desktop explicitly explains `Enter insert`; that cue is absent on the phone. Selection alone does not explain whether tapping highlights, previews or inserts. Add a compact visible touch cue or insertion affordance that makes the next action clear. Whether a row actually inserts on one tap is unverified and must be checked live.

## Preserve

- Quiet neutral surfaces, aligned labels and dark readable result titles support the current Studio 11.6 direction.
- The selected native type and repeated Work labels make the broad result category visible; the explicit `51–100 of 105 matches` label makes pagination position understandable.
- Desktop rows are compact and expose eight references; phone rows visibly have more vertical space and expose six. The phone stacks page controls without horizontal clipping. Retain this density and readable typography.
- Desktop preserves visible private-draft text beneath the picker and shows Write/Preview/Both alongside Link. The phone keeps project, Docs, title, Write/Preview and Link context above the picker.
- The desktop keyboard legend is useful and unobtrusive; retain it alongside any phone-specific cue.

## Missing states and live questions — unverified

The screenshots show one populated Work page, with short repetitive fixture titles and one highlighted row. They do not show search results, long or duplicate titles, native task IDs/status, other native types, first/last pages, empty/loading/error states, inaccessible/deleted sources, a closed picker, inserted references, save/preview/history, or restored drafts. Exact source identity and disambiguation under realistic names need live evidence.

Phone draft visibility while selecting, picker scrolling, insertion/close/return behavior, virtual-keyboard layout, focus/keyboard handling, responsive transitions, target sizes, contrast and accessibility require separate running-app checks. Screenshot geometry is not device or WCAG acceptance. Private text retention, network contents, data correctness, API/persistence and permissions are unverified.

Outcome: two focused visible clarity findings; compact working density and readability otherwise support the supplied brief in these states. This is not runtime, data, accessibility, real-device, motion/presence or whole-#155 approval.
