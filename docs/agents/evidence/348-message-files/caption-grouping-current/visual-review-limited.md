# PR #369 — limited visual review of current pixels

**Source:** `d5c99322412b4906e082e554963a326a5c021312`. **Date:** 2026-10-08. **Result:** normal photo/caption and file/reference grouping largely follow F-026 §6, but the offline WebKit image is visibly broken and two smaller readability/fidelity gaps remain. This is not whole-task acceptance.

**Independence limitation:** I did not author application changes, and this assessment is based on the pixels listed below. However, this reused agent context previously read implementation and fixtures while preparing the test wrapper. Under `.agents/skills/flux-review-visual/SKILL.md` and `docs/design/README.md`, it cannot count as the required fresh-context independent visual gate. It is a limited review; obtain fresh review before claiming that gate passed.

Neutral job: read messages containing files, photos, captions and native references; recognize the associated object or file; inspect a photo; understand a queued or unavailable photo. Constraints read: current `docs/design/final/README.md` §§1–2, 6 and 9, plus the design evaluation guidance. Reference pixels inspected under `.worktrees/348-files/docs/design/final/screens/`: `attachments.webp`, `desktop-attachments.webp`, `phone-photosent.webp`, `phone-photoview.webp`, `phone-photopick.webp`. No older design was treated as an appearance target.

## Material visible findings

1. **Offline WebKit photo loses its image, and the caption no longer forms a compact group with it.** Location: `/private/tmp/flux369-current-targeted/offline-1440-full-1440x900-webkit.png`. The queued photo is a flat grey rectangle with `IMG_4001.png` and a broken-image marker visible; only the clock/waiting overlay remains. Its photo begins around x705, while its caption begins around x489, leaving most of the caption to the left of the image. Consequence: the user cannot recognize the queued photo and its caption looks detached. The matching Chromium crop `/private/tmp/flux369-ui-current/offline-1440.png` contains the coloured photo pixels but also shows the displaced caption, so image loss and alignment should be tracked separately within this state. Direction: retain the readable local photo under the waiting overlay and keep photo, caption and waiting status aligned as one message group, following the offline example in `attachments.webp`. Pixels establish the broken presentation; they do not establish its cause, persistence or data loss.

2. **The phone native task reference becomes unnecessarily narrow inside a photo caption bubble.** Location: `phone-390-photos-dark-full-390x844-webkit.png` in the targeted directory, corroborated by `/private/tmp/flux369-ui-current/phone-390-photos-dark.png`. The task card under “Sensor 3 is in, far east bed” has a narrow title column, with the number and “Open” occupying neighbouring columns. A short title wraps into three lines while substantial width remains to the right of the enclosing bubble. Consequence: scanning the attached task takes more vertical space and attention than the compact cards in `attachments.webp` / `phone-photosent.webp`. Direction: let the reference and its enclosing bubble use enough available message width; keep kind/number together and preserve title reading width. The card is correctly inside the message, and no text is visibly clipped—preserve that grouping.

3. **The link card duplicates the URL rather than providing the drawn descriptive preview.** Locations: `desktop-1440-files-light-full-1440x900-webkit.png`, `desktop-1440-files-dark-full-1440x900-webkit.png`, and both `phone-390-files-{light,dark}-full-390x844-webkit.png`; Chromium `desktop-1440-files-light.png` corroborates it. The message shows a long raw URL; the card repeats its domain, the generic title “placement guide”, and the path again instead of a useful description. The phone path is ellipsized. Consequence: the card consumes a full row group without helping much to decide what the destination contains. Direction: render the accepted domain/title/description hierarchy with a site identity icon when preview information is available; show a deliberate compact fallback when it is not. The optional preview image is not itself required. This is an observed mismatch to §6 / `attachments.webp`, not evidence about metadata retrieval or why it is absent.

## Useful elements to preserve

- Normal two-photo and four-tile grids visibly contain image pixels in WebKit and the sampled Chromium crops. They have no file frame, retain rounded outside corners and show a clear `+2` on the last tile. Captions are below the complete grid in desktop/phone and both themes. No normal-state caption overlap or horizontal clipping is visible in these captures.
- Text, file rows, voice note, link card and native task card share one outer message bubble. Folded file icons and PDF band distinguish types; filename, type/size, download glyph, waveform and play control are legible. Inline person/task chips remain readable within the sentence. The ordinary task reference in the larger file bubble wraps acceptably on phone.
- The viewer stays black in both theme sets; author, photo count, caption, filename and Reply/Create task/Save/Share remain visible and organized. The shown phone photo leaves comfortable separation from its caption/actions. The smaller desktop photo is visible; these fixture pixels do not establish how large real photographs scale.
- Chromium `composer-390.png` visibly presents numbered chosen thumbnails and remove controls; `failed-390.png` places Retry on each visible photo, and `sending-390.png` places sending feedback on the photos. These static appearances do not verify ordering, removal, retries or progress accuracy.

## Broader shell, kept separate

The surrounding project shell does not yet match the accepted screen composition: phone captures have a multi-row project header, large persistent project tabs, a tall composer, and a full-width four-item bottom bar; `phone-photosent.webp` uses a much lighter conversation header/composer composition. Desktop also has an extra header row compared with `desktop-attachments.webp`. These consume conversation space, but they belong to the wider shell integration and are not evidence that the attachment grouping itself is misplaced. This review neither accepts the shell nor proposes changing its contract.

## Evidence and remaining limits

All **18 WebKit full-viewport PNGs** in `/private/tmp/flux369-current-targeted/` were inspected: desktop and phone `files`, `photos`, `grid` in light/dark (12); desktop/phone `viewer` in light/dark (4); `access-lost-1440-full-1440x900-webkit.png`; `offline-1440-full-1440x900-webkit.png`. Desktop is 1440×900 CSS px / DPR 1; phone is 390×844 CSS px / DPR 3 (1170×2532 source image). Phone references are 2×. Inspection accounts for that scale difference; no measured contrast claim is made.

Additional Chromium evidence actually inspected under `/private/tmp/flux369-ui-current/`: `desktop-1440-files-light.png`, `phone-390-photos-dark.png`, `composer-390.png`, `failed-390.png`, `sending-390.png`, `offline-1440.png`. Other files in that directory were not reviewed for this report.

No application, browser, tests, Docker command, code edit or GitHub write was performed for this review. The supplied runtime summary says WebKit was **7/8 with an uncaught CORS page error in an action test**; that is not a full pass and these images cannot overturn it. The positive normal-state images also cannot override the visibly broken offline capture.

Still requiring live evidence: offline photo decode and recovery across both engines; actual caption/reference ordering beyond the shown states; thread/Details/Agents consumers at the same viewport/theme matrix; viewer focus/Escape/navigation and source persistence; access denial beyond its displayed notice; zoom/enlarged text, long filenames/titles, landscape/tablet and narrower widths; keyboard, touch targets, contrast/WCAG and native share/picker behavior. Current captures do not cover every reference kind or real photographic detail. The image review makes no behavior, authorization, data correctness or accessibility certification.

## Evidence packaging note

The 18 inspected WebKit PNGs and sanitized diagnostics are preserved alongside
this report. The six inspected Chromium PNGs are preserved in `chromium/` with
unchanged filenames and bytes. Absolute temporary paths above identify the
original review inputs. This packaging does not add a new visual review.
