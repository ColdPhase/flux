<!-- Independent visual review (neutral brief, screenshots only), 2026-10-05, by a separate reviewer session for claude-hubert. -->
# Visual review: #266 phone-first shell (PR #267 evidence)

Images only, no code. The earlier-build images (`151-adaptive-matrix/…`) are missing from the repo, so there is **no before/after comparison**.

**What you notice first**
- Home: "Welcome, Ada", then a filled **Conversation** chip. With the chips and Details, Home reads as a project conversation.
- Conversation/Tasks: the title, then the filled chip. The view is unmistakable, and the bottom-bar pill marks the place.

**Work vs chrome at 375×667**
- Conversation: 150 px at the top and 120 px of composer. That leaves about 60% for the stream. With the keyboard open, one item shows.
- Tasks: 229 px (34%) of chrome before any card. About 2½ cards are visible.

**Labels**: most controls have labels. Unclear: the bare people icon in the header, the sparkle in the Home composer, the sparkle used for **Projects** (the AI glyph), "What matters", "I have the context", "Kanban".

**Material problems**
1. *Unclear location on Home*: the project chips and Details appear on Home. Ada can't tell whether she is on her overview or in a space. Remove the chips or name the space.
2. *Stacked project chrome*: there are three bands. At 375 the title and "Decision needs you · Rule…" are cut off, and the pills are heavier than 11.6's text tabs. Fold the state row into the header, use lighter tabs, and collapse the bands while she types.
3. *No thumb route out of a project*: there is no bottom bar and no back arrow, only ☰ at top left. Add a back control within thumb reach.
4. *Noise*: hex IDs head every task card, and Home shows "Arrival probe 1791231679950". Five identical "New task" rows fill the stream. Home says "Nothing needs you" while the project says "Decision needs you". Demote the IDs, group repeated events and make the states agree.

**Preserve**: the labelled bottom bar; projects at full height; the composer with its audience line; the column switcher with counts; the labelled toolbar; the visible filter; grouped Settings with Back pages; the clear drawer.

**Dark mode** (only Conversation was captured): consistent with 11.6. The selected chip has less contrast than in light mode, and the meta text and timestamps are faint.

**Live-test questions**: How is a task moved (only ••• is visible)? Does the chip row show that it scrolls? How does a real iOS keyboard behave? Is there a back gesture? Do the icons have accessible names? Does it hold up at 200% text?

**Verdict: acceptable with fixes.** Thumb navigation, the composer and labelled tools are real gains, but Home's location ambiguity and project chrome need fixing.
