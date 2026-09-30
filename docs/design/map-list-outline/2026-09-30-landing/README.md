# Related destination landing correction (#134)

The independent #148/#134 visual integration review found that the phone
related-navigation image left the selected thought at the bottom edge. The
correction reveals its whole title, metadata and path cue below the sticky Back
action; Back still restores collapse, selection and the previous scroll position.

[Seven Docker UI tests](docker-ui-check.txt) pass at production `763cf10`, including
new real touch/focus/viewport assertions. [Independent image review](independent-visual.md)
retains the original finding and records a focused visual pass for this corrected
390×844 capture. [Metadata](metadata.json) distinguishes the source and limits.
The original 2026-09-30 evidence remains unchanged, tied to its earlier head.

This branch retains the original Mint/Iris/Sky contract. The separately tested
#148 successor integrates the fix under Mint/Sky/Copper. Eligible GitHub approval
is still required; the image reviewer is not GitHub approval.
