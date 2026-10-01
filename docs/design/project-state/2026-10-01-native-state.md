# Native project-state correction — partial #136

2026-10-01. Local correction within Studio11.6/UI116-1 and #136's existing
canonical Tasks/Conversation/Details continuity. Preserve the current shell,
palette, source navigation, audience, drafts, explicit recap acknowledgment and
all unfinished Agents/adaptation/motion/client/device/release requirements.

## User job and observed discrepancy

A collaborator opens a restricted project to identify the next task and reach
its saved details. The peer reported a project header claiming “No decisions
or work yet” while Tasks contains an actual open task. Both views already use
the same parent route's canonical work records; state summarization currently
omits Open and retained historical work. The correction needs no provider facts,
model call, new task status or separate state/cache/API.

## Local presentation choice

Include an Open part for actual unparked `open` tasks: a quiet static task icon,
`1 open task` / `N open tasks`, and a control opening the actual first listed task.
Keep the exact task title available in the existing Details view and control
tooltip; do not suggest that an open task is executing or animate it as active.
Desktop and phone share this count; the phone's existing44px state control opens
the overview, where the same native task is reachable under its actual state.

Current rules, work in progress, blocked work, results and proposals keep their
existing meaning and priority. When no current part exists but saved task history
does, summarize the real completed/not-pursued/parked categories and open an
actual retained task. Earlier decisions likewise remain reachable history.
“No decisions or work yet” is reserved for genuinely absent native records.
This is a local correctness correction, not a new global pane/breakpoint design.

## Verification and limits

Use persisted native API records, two authenticated accounts, current restricted
project viewer/deny policy, empty→Open→blocked→done transitions, Tasks and actual
Details navigation. Exercise320/390px phone,820px tablet and1280px desktop, with
representative light/dark captures at100% zoom. Existing project/work/decision
journeys must still pass. Obtain a separate neutral rendered review and pin the
tested source, commands and outcomes. Label emulation as such; it does not prove
physical phone/tablet/4K/ultrawide or the full F-015 matrix.

## First rendered review and bounded correction

The independent review of the first six full-view captures found clipped short
status summaries on desktop/tablet, a clipped two-person audience at320px, and
write-oriented empty/composer instructions shown to a reader. Keep native counts
and existing navigation, but allow header parts and audience text to wrap within
available space. Reader empty-state guidance describes reading saved objects;
the composer retains Sources with an explicit read-only notice, without a reply
input/send or a material discussion action. Saved writer drafts remain untouched.
Verify rendered text bounds and reader controls in the real browser separately
from the second neutral screenshot review. Status transitions use API mutation
and reload, not proof of stream-driven live refresh.

Source review then identified two reader seams requiring correction: saved
text-only source rows need a keyboard-reachable exact-version reader link, and
the New conversation destination must distinguish an empty project from a
project with existing conversations. Add actual saved-source/body and existing
conversation journeys with contributor→reader→contributor draft retention.

A second neutral visual review confirmed the improved status/audience/read-only
layout, but retained one material access-expectation finding: the sidebar still
exposed New conversation to a reader and the phone footer said Replying to.
Use current matching project access for the creation link and label a reader
footer Conversation. This focused third correction addresses the observed role
contradiction; it is not a new general visual exploration. Verify saved-thread
navigation through the phone drawer and keep existing writer flows unchanged.
