# Final disposition — d87 phone Tasks visual review

This disposition supplements and does not edit `visual-review.md`.

## 320×568 findings

**Withdraw the initial P2 claim that the bottom dock cuts off task content as a required visual issue.** The initial All-list screenshots show only the first rows in the short viewport, with the next row continuing beneath the bottom chrome. That image alone did not establish whether later rows could be reached. The added `flux375-d87-probe/screenshots/375-probe-final-row-at-scroll-bottom.png` shows the list scrolled to its end, with task #6 fully visible above the Create button and dock. The accompanying probe manifest/output reports that the row was fully inside the scrollport and its center hit-testable. This closes the visual concern about the final task being hidden by the dock; the interaction evidence separately establishes reachability.

**Downgrade the 320×568 toast overlap to optional polish (P3).** In the Chromium and WebKit success frames, the two-line “#4 in progress” toast covers the task row beneath it. In the offline error frames, the large toast covers the underlying recovery page, including part of the “Refresh work” link. These are visible overlaps in the supplied pre-dismiss snapshots. The probe shows the toast’s close control is hit-testable; after dismissal and scrolling, “Refresh work” is fully visible and center-hit-testable; restoring the connection and activating it restores all six tasks. Therefore the screenshots do not support a claim that the list or recovery action is inaccessible. Compacting the toast or reducing its overlap at 320px would improve legibility, but no required visual issue remains on this evidence.

## Remaining required visual issues

None identified in the supplied d87 Chromium and WebKit screenshots or the added 320px scroll/recovery states. The 390×844 list maintains clear status and ownership hierarchy; the toast and floating Create control remain separate in the provided frames. This is a visual disposition only. The probe measurements are interaction evidence from the supplied manifest, not a visual inference; neither screenshot nor probe certifies accessibility or a broader responsive matrix.

## Added evidence reviewed

- WebKit current-pin captures under `/home/hubert/Develop/flux-evidence-archive/flux375-d87fde2d/webkit/`, including 320px task, success and error frames and 390px task list. Their visible layout matches the Chromium concerns described above.
- Chromium scroll/recovery frames under `/home/hubert/Develop/flux-evidence-archive/flux375-d87-probe/screenshots/`: `375-probe-final-row-at-scroll-bottom.png`, `375-probe-offline-before-dismiss.png`, and `375-probe-refresh-work-reachable.png`.
- Probe metadata: `/home/hubert/Develop/flux-evidence-archive/flux375-d87-probe/PROBE-MANIFEST.md` and `probe-output-excerpt.txt`. Exact source pin is `d87fde2df4cbddafc8fb6c4771d5d9fda9eab8a2`; probe viewport is 320×568 CSS px, DPR 3, light/default text.
