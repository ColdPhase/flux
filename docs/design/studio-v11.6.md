# Studio 11.6 — current UI and connected-work contract

**F-017, 2026-09-30.** Hubert adopts the supplied Studio 11.6 as the complete
appearance direction, with useful functional additions and no regression to
stronger repository behavior. This supersedes 11.1 as the current visual target;
it does not reset the stack or replace existing capabilities. [Original seven-file
package](references/studio-v11.6/README.md), [co-work contract F-016](../product/mcp-cowork.md),
and [adaptive workspaces F-015](adaptive-workspaces.md) are required together.

The present change is informational: reference, reconciliation, milestone/issue
amendments and review evidence. Production implementation remains in those issues.

## Familiar surfaces — UI116-1

Use 11.6's calm neutral surfaces, compact typography, project selection and
Conversation / Map / Tasks / Wiki / Agents navigation. Own messages remain right,
other people's left, with readable prose and a useful narrowed conversation next
to panels. Agents is an optional project capability, not a new obligatory home or
a duplicate backlog. Personal capture, DM, live collaboration and the embedded
helper keep their existing roles and access boundaries.

Preserve #133 explicit “I have the context” acknowledgment (visiting is not
acknowledging), #134 personal ID-only map-list hierarchy, #148 Mint/Sky/Copper and
separate remembered light/dark choices after #135, and #149 draft-before-save.
No prototype `outlineParent`, shared localStorage schema, simulated AI/session,
new task status, or fixed effort-unit assumption becomes production architecture.

Long names, drafts, attachments, focus, scroll anchors, source return, map camera
and pending writes survive navigation/pane changes. Preserve historical results,
decisions and useful #44 journeys with no AI. The design should be learnable from
ordinary use; expose one primary action and reveal advanced details on demand.

### One project conversation — UI116-1 clarification

**2026-10-02, founder direction (Hubert).** A project has one Conversation: a
single chronological stream with no mandatory topic, where replies sit with the
message they answer in one flat thread. This follows the 11.6 prototype: its About
dialog (“Jedna rozmowa projektu, bez obowiązkowych tematów”; “Odpowiedzi przy
wiadomości, bez nieskończonych podwątków”), its empty state (“Napisz myśl. Nie
potrzebujesz tematu ani gotowego planu.”) and its reply drawer (“Odpowiedz na tę
konkretną myśl. Bez zakładania tematu.”). It replaces the #117 list of separately
started conversations under the open project in the sidebar and its “New
conversation” control. The founder's condition: the flow must not break and must
stay intuitive and connected.

The stored model is unchanged. Each existing conversation is one root message
(sequence 1) in the project stream; its later messages are that root's one-level
thread. There is no migration, rewrite or loss of history. The main composer
starts a root with the existing start command; the thread drawer (a side panel on
desktop, a full-screen sheet on the phone) replies with the existing reply
command. Existing conversation URLs and message anchors open the stream at that
root with its thread open. The personal assistant is asked from a thread and
answers there. UI116-3 task announcements are part of this stream (2026-10-03,
#154): each is one compact line between the roots, in time order, that opens its
task. A task's first genuine contribution is an ordinary root that names its task
(`ConversationRoot.task`), in the stream and in its thread. Announcements older
than the first loaded root stay hidden until those earlier roots are loaded.

Reconsider if people cannot find or follow earlier discussions in one stream in
observed use, if root volume makes the stream unreadable without filtering, or if
UI116-3 needs a different root model.

## Agents as a view of existing work — UI116-2

Show each connection with client/name, owner and truthful current state, including
**Hubert: Codex + Claude; Marek: one connection**. Avoid one tile/setting per owner
which hides a second agent. Keep task selector, executor → reviewer, current
activity, useful result/PR and source references compact. The composer writes to
the same task thread seen in Conversation and Tasks, with the same draft identity.
Logs/details are on demand, not a full transcript or another inbox to administer.

“Hand off task” selects an existing task, executor, optional reviewer and short
instruction; human-assignee change is a separate unchecked option. Owner standing
grants avoid repetitive prompts. Show precisely whose authority or client is
missing when blocked. A configured/offline connection is not a working process.
No fictional progress percent, model thoughts or “tests passed” from demo seeds.
Keep personal-helper controls distinct from co-work setup and connection identity.

Provide a visible executor/reviewer swap action in assignment, preserving the
instruction and validating the new roles/grants without changing signed-in
identity, human assignee or existing artifact authorship.

Expose “Handoff point” from the same task/Agents conversation with current waiting
state, an action opening the original source message, and download of a bounded
versioned reference packet. It contains authorized references, not credentials
or active grants, and does not create a second conversation or knowledge store.
Read handoff context from current task, last checkpoint and versioned sources;
do not create a summary model call or another wiki copy. Review of a PR and a
non-code result uses the current SHA/message version. CO-1–CO-5 govern actual
permissions, reviewer independence, leases, completion and GitHub behavior.

## One announcement, then the real discussion — UI116-3

Creating a task through any domain entry point publishes exactly one compact
`task.created` system event in its authorized project conversation, linking the
exact task ID and attributed creator. Map/message sources remain attached. This
event is separate from the thread root, not a human comment or large task card.
Task + announcement commit atomically; retries use an idempotency key. Opening,
rendering, cancellation, reload and import never emit another announcement.

The first actual task contribution becomes the visible conversation root with
its true author/time/body/files. Later contributions from task, Agents, map or
Conversation reply to that same one-level thread. Attachments-only, blocker,
result and user handoff instructions are valid first contributions; preserve their
normal output audience and do not turn private helper prompts into public roots.
Never overwrite the creation event or an existing nonempty/historical thread.
Serialize concurrent first contributions in the server transaction.

On failure, no partial task/message/result/event/notification and no false success;
retain draft/files for retry. Safe undo of an unused AI-created task can leave a
historical creation-reverted event without a dead task link; it cannot erase
later work by others. No historical author/date reconstruction, automatic
backfilled notices or destructive thread migration. The prototype placeholder
technique is not a prescribed server implementation.

## Quieter map, board and wiki — UI116-4

Map thoughts show a task count rather than inline task titles/results. The count
opens **all** related tasks with exact IDs, status and people; closing returns to
the same camera/selection. Preserve many-to-many relations and accessible named
links; this is display simplification, not data deletion or a map-to-kanban change.

Board drop feedback highlights the card-list area, leaving header/title/count
neutral; header remains a drop target and empty columns have a usable target.
Clear feedback on leave/drop/cancel; outside drop does nothing, failed transitions
restore the true state. Keep touch and keyboard/menu alternatives to dragging.
This does not add card ordering semantics. Phone status navigation still needs a
clear active/blocked overview; the supplied clipped next column is insufficient.

Wiki selection uses a quiet neutral background, stronger label and small marker,
with `aria-current` and visible keyboard focus. Preserve document/Markdown modes,
history, source links and drafts. Neither subtle selection nor theme color can be
the only indication of state.

## Subtle motion and truthful typing — UI116-5

Motion reinforces a state change after input; it never delays navigation or
blocks actions. Starting design tokens: 120–180 ms control feedback, 160–220 ms
selection/arrival transition, short ease-out, transform/opacity where possible.
These are tunable proposals to validate in actual app performance, not measured
budgets. No bounce, large slide, attention loop or animated layout reflow.

| Place | Intended feedback and continuity |
| --- | --- |
| Project selector | A short traveling active highlight within the existing list; preserve scroll/focus; interrupted transitions settle on the latest selected project |
| Work tabs | One subtle sliding indicator across Conversation/Map/Tasks/Wiki/Agents; content changes immediately, retains its state and does not slide the whole page |
| New messages | Small arrival opacity/translation only when newly received and visible; no animation of restored history, scroll jump or forced return to bottom; offer a quiet new-message affordance when reading earlier content |
| Typing | Real authorized ephemeral activity labeled with person; debounced/throttled, expires after inactivity, cleared on send/blur/disconnect/access loss; never infer from unread status or simulate agent thinking |
| Task movement | Brief target/card placement feedback after confirmed transition; visible failure recovery; reduced-motion and keyboard/menu equivalents |
| Details, saved/reconnected states | Short optional fade and static confirmation; no changes to focus order, modal containment or screen-reader meaning |
| Active agent | Optional small activity mark only for authenticated active execution/review; waiting/CI/offline static; status text always carries meaning |

Typing publishes no draft text, persistent history, unread count, notification
or agent/LLM trigger. Scope it to the current conversation/task audience, including
current revocation and replay boundaries; task/conversation/Agents views share one
presence identity and avoid duplicates. Use real two-user network and expiry
tests, not a frontend timer claiming someone is typing.

With reduced motion, show immediate selection and static activity; no traveling,
pulsing or translation effects. Pause decorative animation while hidden, offscreen
or occluded by a modal. Never announce every animation frame or typing keystroke.
Keep touch hit targets, readable text and keyboard focus independent of animation.
[W3C interaction-animation guidance](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html),
checked 2026-09-30, supports user ability to disable nonessential interaction
motion; this contract deliberately applies that approach throughout Flux.

**Implementation record (#155, 2026-10-05; owner Zamojski5, evaluation pending).** The tokens
chosen within the proposals above, and the rules the views follow. Measured numbers and the method
live in [`155-reference-client-wip`](../agents/evidence/155-reference-client-wip/README.md).

- Selection: the project row's highlight (`.side__glide`) and the work tabs' mark travel with
  `--dur-2` (160 ms, ease-out, transform only; a taller row's height is set at once). They go to the chosen item **at once, while
  its view loads** (router pending navigation); the row or tab becomes current (accent bar,
  `aria-current`) when its content shows. A newer choice retargets from where the mark is; a choice
  that does not happen returns the mark. Focus, scroll and drafts are untouched.
- Arrival: only entries that arrive after the newest one already shown (`arrivals()` in
  `ui/motion-rules.ts`) rise in (opacity + 4 px, `--dur-2`), and only when visible, in a visible page
  and not under a modal or an inert sheet. Restored history, earlier pages and refreshes never move.
  A reader with earlier content is not moved; one static live-region line ("2 new messages · 1 new
  task") offers the end, taking no layout space.
- Loops: the assistant's working mark moves only while the run actually executes (`reading`,
  `dispatching`), not while queued or stopping; it and the live-session mark pause while the page is
  hidden, the mark is off screen or a modal covers it. Typing stays a static, reserved line.
- Reduced motion: every token is 0 ms, so marks are placed at once and nothing arrives with motion.

## Home: acknowledgement, your tasks, first notes — HOME-1 to HOME-3

Accepted 2026-10-03, with amendments, by independent peer review of the proposal on
[#190](https://github.com/ColdPhase/flux/issues/190) (proposal and the
[review with amendments](https://github.com/ColdPhase/flux/issues/190#issuecomment-5963558501)).

- **HOME-1, visiting acknowledges nothing** (amends #106 AC-1). Home's "Since you left" never moves
  its return point on a visit. It ends with "Last caught up …" (the previous acknowledgement) and **I have the context**, which saves
  the visit's mark; the list then closes to "You're caught up. New changes will show here."
  A failure keeps the list ("Could not save. Try again; nothing was changed."). The only automatic
  save is a first visit with no point, which sets a starting point. "Keep these for next time" goes
  away. Details: [return view](../development/return-view.md).
- **HOME-2, your unfinished work on Home's Tasks.** Work you own (open, in progress, blocked; not
  done, not pursued, parked or owned by your agents) across every workspace and project you can
  read now, from `GET /api/v1/workspaces/:id/work/assigned`, every page until `total`, at most 500
  shown. Every workspace's `total` is still read once the 500 are full (a one-row page), so
  "Showing 500 of N" counts every task the cap leaves out. Grouped by project (workspace added when names collide), ordered as the project Tasks
  view (In progress, Blocked, Open), blocked rows with their blocker. Partial failures say so;
  the empty state appears only when every read succeeded. Nothing is kept between mounts or
  accounts; it reads again on mount, visibility and relevant stream events, without polling.
- **HOME-3, first notes go to your account.** The first Home note creates the personal space
  ("Personal", one per account, one shared helper with sketches) and is saved as a private
  draft. When several spaces exist, including ones created after the page loaded, no personal
  space is made: the page reads the person's spaces again and they choose one. Notes kept only in this browser are offered once per visit as "Move N notes from this
  browser into Personal", with a stable per-note idempotency key and target space, cross-tab
  safety and an account-bound abort. Notes stay private drafts: not readable by other members,
  workspace owners or admins, or agents; only the person's own action changes that (F-019).

## Integration and proof

The measured tokens, components and the few deliberate production differences are in
[the 11.6 design system](studio-v11.6-design-system.md) (2026-10-02).

#136 owns the full appearance/integrated UI; #151 its adaptive layout. No parallel
shell writer. Carry all five work tabs, three-agent identity, live/helper panels
and typing affordances into ADAPT-1–ADAPT-5. Large screens can show selected work
beside permitted sources/PR review/context; phone keeps the same actions and
vocabulary in focused views. No mandatory dashboard sprawl or long unreadable
message rows. On very tall screens, keep a short work stream and its composer
visually connected rather than separating them by a large empty region. Preserve 320px Android through 4K/ultrawide, zoom, rotation and
virtual-keyboard requirements and actual #20 device acceptance.

Use the issue map in [F-016](../product/mcp-cowork.md#delivery-and-evidence--co-5).
Review rendered realistic full views independently of behavior. Actual server
access, concurrency, persistence, two-user typing, supported local clients and
GitHub delivery are separate acceptance evidence. Supplied audits and our
prototype screenshots establish none of those production capabilities.
