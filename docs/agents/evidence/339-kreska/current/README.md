# #339 bounded review corrections — 2026-10-07

This is a component increment for [#339](https://github.com/ColdPhase/flux/issues/339)
under [#336/F-026](https://github.com/ColdPhase/flux/issues/336), not whole-issue or
release acceptance. Initial source was frozen at `d225edbb67aa0e762bcc20d1c45bf3e234e685cd`;
the stable-capture follow-up test source is
`f5f7c882fd20d63761cdd8f595ce35805a0d0a58`. The documentation/screenshot commit
that contains this record adds no application code.

## Corrected behavior

- A connected external session and a recent **completed** action leave Kreska idle.
  The connection read has no proven current-run/claim field; #347 must integrate
  those actual states. An activity timestamp never proves working.
- `ProjectPerson.agentOwner` is additive and optional. The existing project policy
  still decides each audience member. A human owner is named only when already
  present in that same authorized audience; workspace ownership is explicit.
  No workspace roster, e-mail, connection secret or new authority is exposed.
  The independent contract review accepted this boundary before final verification.
- The owner hook has no module cache. It fences account/workspace/project/visit and
  router revalidation synchronously, aborts obsolete reads and clears labels on
  failure/access changes. Focus, online, visits and authorized events retry reads.
- Native List/Board owners, proposed decisions, native discussion roots, decision
  details and Agents task messages use Kreska/Agent plus an authorized owner label.
  Human initials remain human initials. Unknown owner names are omitted.
- Phone Agent metadata uses `--fs-xs` (12.5 px, 25 px at 200% root text).
  The original nowrap owner relation overflowed a 390 px viewport with the actual
  name “Ada Zamojska-Kreska Research Lead” at 200%. It now wraps the complete name.

## Verification and source provenance

| Actual run | Source/image | Result |
| --- | --- | --- |
| Full configured API/persistence phase | `51b7aabce8e07a9deaa699a4fb3e4fe62921cf54`, test image `sha256:1f5835dd87e1a212fec33d0a0f5d4498621849908c17ef8e88215b9745f8c07c` | 1084/1084, including guest/hidden member/owner deny/agent revoke/reader revoke projection cases |
| First configured PWA/access stream phases | Same application snapshot | 3 PWA + 1 access-stream tests pass |
| Fresh frontend build/type/lint and UI | `34247d1a19d76283d50cea1f94272acafc2dcf8d`; e2e image `sha256:311291cbf950845791671c16e6f040cf37e2a92f366ea483766dd0441166a852` | Build/type/lint pass; 59/59 Kreska, Tasks Board, Agents, personal assistant, One Conversation tests |
| Final owner-wrap build/type/lint and UI | `1987254e6a992f25b031f8f768c43be8386cafbc`; original production image `sha256:e9a99fc970e0238a5d54947523e0fff967f4bec061e733ba4ed12f800be49f37` | 17/17 Kreska/Tasks Board tests, real long owner at 390 px, light/dark, Chromium/WebKit, normal/200% text, complete-label bounding and no horizontal overflow |
| Final actor/owner browser | Test source bound from `d225edbb67aa0e762bcc20d1c45bf3e234e685cd` into the runner above; API serves production `1987254e`, cache-only rebuilt as `sha256:91fcce70e17f8ad42c8f39eee106d089db82a8d082322f10db0109bcfbf92d3b` | 2/2; genuine trusted agent writes, persisted human replies, native List/Board/proposed/Details/Agents thread, 503→retry, held stale answer after real deny, second project rights, same-document sign-out/sign-in to guest, roster 403; no asynchronous test error |
| Final component browser | Same runner with production Kreska component/built CSS and real fonts; Kreska code/tokens/motion selectors unchanged since the runner snapshot | 1/1; all 16 expressions × 16/20/24/32/48 px, Chromium/WebKit light/dark, geometry and frame/brow weights, reduced motion gives no animations, normal motion only loading/thinking/working |
| Repository checks | Source changes plus evidence | Agent setup, 76 Python tests and `git diff --check` pass |

The API/core/database/contracts/server/worker source has **no diff** from
`51b7aabc` to `d225edbb`. Application web source has **no diff** from `1987254e`
to `d225edbb`; those later commits change browser test navigation/cleanup and
captures only. The long-name fix changes only `.agent-for` wrapping; it does not
change the component's Kreska paths, tokens or motion.

The original `check_application.sh` run did not complete all later configured
stages: its earlier owner browser test used a button selector for the List radio.
The corrected, stronger current browser tests above pass. This record does not
claim a final full-script or integrated release pass. The current driver includes
the explicit web tsconfig required to render the actual React component in its
separate component harness.

Maintained checks are `scripts/check_application.sh` (API/e2e) and
`scripts/check_ui.sh test_kreska test_tasks_board`. For the broader unchanged UI
paths the actual earlier invocation also included `test_agents_view`,
`test_personal_assistant`, `test_one_conversation`.
The manual target used a separate Compose project, ports and volumes and the
same server code/migrations; it was removed with its volumes after checks.
Actual check excerpts are in [checks.txt](checks.txt). Full local transcripts:
`/tmp/flux339-application.log`, `/tmp/flux339-final-build.log`,
`/tmp/flux339-ui.log`, `/tmp/flux339-ui-final.log`,
`/tmp/flux339-actors-final.log`, `/tmp/flux339-frames-final.log`.

## Stable capture follow-up

The first neutral visual review at `b81eba8e` found that the Agents-thread PNG
caught the closing Details panel over the page and omitted the owner visibly.
That capture is superseded by the five native PNGs now in this directory; its
unmodified bytes remain locally in `/tmp/flux339-raw-evidence/b81-pre-stable-capture`.

The follow-up did not change production code. The docked panel intentionally
remains mounted through its exit animation, and selecting a task commits a new
`?task=` route visit, which fences/reloads the authorized owner projection. The
previous test asserted a label before capturing those transitions. The new test
waits for the panel to detach, the intended task URL to commit and finite
animations to end. It then checks the full owner label, positive in-viewport
bounds, visible/non-inert ancestors at opacity 1, same-surface hit testing, and
identical metrics over three rendered frames and before/after the raw screenshot.
The task card's transparent stretched button may own hits over its own label;
a different panel/overlay is rejected. Motion stays enabled.

The rerun at `f5f7c882fd20d63761cdd8f595ce35805a0d0a58` passes 2/2 real
actor/owner journeys, with no asynchronous test error. All five native captures
include `*-visibility.json` with actual before/after measurements. The Agents
thread's `for Scoped Casey` is at x633, y634.46875, width99, height17.15625;
all recorded ancestors have opacity1/visibilityvisible and the label is
uncovered, in the viewport, and unchanged throughout capture.

The unchanged production image is
`sha256:91fcce70e17f8ad42c8f39eee106d089db82a8d082322f10db0109bcfbf92d3b`
(`1987254e`). The existing runner is
`sha256:311291cbf950845791671c16e6f040cf37e2a92f366ea483766dd0441166a852`;
only the current test file is mounted into it. Type checking of the application
workspace with that test file and targeted ESLint pass in the existing Docker
runner; no heavy application build is needed. Web production source has no diff
from `1987254e` to `f5f7c882`, and backend/contracts source has no diff from
`51b7aabc` to `f5f7c882`. Source checks, suite and cleanup transcripts are
`/tmp/flux339-capture-source-checks.log`, `/tmp/flux339-capture.log` and
`/tmp/flux339-capture-cleanup.log`. The separate capture project and volumes were
removed. A fresh independent source/test and visual delta review is required for
this follow-up; the prior review is not represented as a pass for these captures.

## Neutral visual review input

A project collaborator needs to recognize an agent, its human/workspace owner
where visible, and its task or contribution without confusing the agent with a
person. Inspect the production screenshots below against the final design's
Kreska, Tasks and Agents references at 1440×900 and 390×844. Phone text enlargement
is included. The frame boards are separate evidence of the production component;
they are not application screens. Screenshots prove visible appearance only;
interaction, persistence and authorization results are the runs above.

- Four `339-kreska-80-frames-*` images: actual component in each engine/theme.
- Four `339-native-list-webkit-phone-*` images: light/dark, normal/enlarged text,
  real scoped owners including the long owner name.
- `339-scoped-owner-board/list/task-details/decision-details/agents-thread.png`:
  native project surfaces with actual agent contributions and authorized owner.
- `agent-root-desktop.png`: actual canonical conversation with human reply.
- `339-logo-sidebar-light.png`: integrated logo sample.

Images are copied unmodified from the browser output. No injected replacement
face, fake font sample, post-render edit or changed viewport zoom is used.

## Remaining #339 outcomes

#339 stays open and PR #356 stays **Part of #339**. The whole final-design
integration still requires Inbox (#342), command menu/search/mentions (#343/#345/#349), hand-off
and Settings agent/AI colors (#347/#350), working-run/claim indicators (#347),
phone Home/splash/small moments (#352), and live map cursor/presence (#228/#231).
Live map/co-editing is required for v0.1; it is not deferred out of scope.

Visible remaining native identity fields include WorkDetails “Added by” creator,
pivot candidate owners and selected task owner identity (#339/#344/#346).
Native select options may remain textual accessible options, but the displayed
selected owner still needs the final identity treatment. This bounded change does
not claim every agent everywhere, all seven hue placements, all small moments,
final rendering/contrast/accessibility acceptance or final release completion.
Independent source/test and neutral visual review at the frozen head are pending;
eligible independent GitHub approval, required checks and resolved threads remain
necessary before merge. No push, approval or merge was performed by this writer.
