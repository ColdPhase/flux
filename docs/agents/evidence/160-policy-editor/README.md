# Agent policy editor in the Agents view (#160, T160-b)

Tested code: `97ba7e36`, branch `claude-maurycy/160-policy-editor`. It started from protected main
`698313b3`, and current main `4e99d223` (#267, #268, #283, #285) was merged in at `1bee689a`
without conflicts. The commit that adds this evidence changes only this directory and the editor
note in `docs/development/agent-connection.md`. Owner of the slice:
Zamojski5 (claude-maurycy), taking over from PelikanFix16
([claim](https://github.com/ColdPhase/flux/issues/160#issuecomment-6002521933)). Independent
evaluation is still required. #160 stays open (see "What remains").

## What changed

- **UI.** The project's Agents view shows the approved agent policy as one folded line under the
  connections: revision, publisher and time
  (`app/apps/web/src/agents/ProjectPolicy.tsx`, `policy.css`; `ProjectAgents.tsx` only renders it).
  - Project managers (workspace owners and admins) write or edit the four parts (scope, priorities,
    review criteria, allowed work) and publish the next revision from the one they loaded. Each
    attempt has its own `Idempotency-Key`, and a retry after a lost answer reuses it.
  - The editor checks the server's rules before sending and names the part at fault: no part over
    4,000 characters (counted as code points, like the server) and at least one part written.
  - A newer revision published by someone else shows in an open editor at once. Publishing then
    answers `409 VERSION_CONFLICT`. The manager's text is kept, the parts the other manager changed
    are named, each can be taken over with "Use their …", and only pressing Publish again replaces
    that revision.
  - Everyone else who can read the project sees the parts read-only, with the managers named when
    there are three or fewer. An open view follows `project.agent_policy_published.v1` without a
    reload.
  - On touch screens it follows the [Apple HIG checklist](../../../design/apple-hig-mobile.md):
    - fields at 16 px (HIG-41; the shared #267 rule enforces this too);
    - 44 px targets (HIG-14) with 12 px between the form's buttons (HIG-15);
    - a press state on every button (HIG-16), and no hover fill left after a tap;
    - `touch-action: manipulation` (HIG-17, from #267's shared rule);
    - no text under 11 px, secondary lines at 13 px and the policy itself at 16 px (HIG-08, HIG-09);
    - labelled fields, with the over-length error under its field and linked by
      `aria-describedby` (HIG-45, HIG-47);
    - a busy Publish button that ignores a second tap (HIG-59).
  - While the editor is open, Publish is the one enabled filled button (HIG-56). The task
    composer's Send below it stays disabled until its own draft has text.
- **API.** None. The editor uses #214's `GET`/`PUT /api/v1/projects/:id/agent-policy` and
  bootstrap's `trusted.approvedPolicy` unchanged, so no amendment was needed.
  - The brief's "required capabilities" and "allowed workflows/modules" are not project-policy
    fields in CW-1. Required capabilities are declared per module by the `flux.cowork` bundle.
    Which work agents may take on is the "Allowed work" part.
  - Observed while testing: Fastify's default schema options drop unknown body fields rather than
    refusing them. This is unchanged here and is not part of this slice.
- **Tests.**
  - `app/tests/app/agent-policy.test.ts` keeps #214's 5 tests and adds a second suite of 4 that
    follows one agent's bootstrap, in one resumed client session, across publishes:
    - a workspace admin, then the owner, publish, and the same session's next `flux_bootstrap` names
      revision 1, then 2 (digest and resource URI). Both revisions stay readable through
      `flux://policy/…`.
    - a contributor and a viewer (403 `FORBIDDEN`), a workspace member without access (404) and the
      agent's own bearer on the HTTP `PUT` (401) are refused. Nothing changes and bootstrap is
      unchanged.
    - an invalid policy is refused with a specific reason and changes nothing: whitespace only gives
      `POLICY_EMPTY`; 4,001 characters gives a message naming `priorities` and the limit; a missing
      part, `expectedRevision` −1 and 1.5 are also refused.
    - two managers edit the same revision: the second gets `VERSION_CONFLICT` with
      `currentVersion` and the newer policy as `current`. The agent is never told the refused edit.
      Publishing from the shown revision then succeeds.
  - `app/tests/ui/test_project_policy.py` has 8 tests at desktop 1440 and phone 390 (coarse
    pointer, no hover). Every publish is checked against the server's saved revision. The phone
    checks:
    - the fields use 16 px text;
    - Show, Hide, Edit, Publish and Cancel are at least 44 px tall, with 12 px between Publish and
      Cancel;
    - there is no text under 11 px, the revision line is 13 px and the policy is 16 px;
    - forcing `:active` through the DevTools protocol changes the look of Show policy, Cancel and
      Publish (the HIG checklist's own check);
    - touch-action is `manipulation`;
    - the tapped Hide has no fill;
    - there is no sideways scroll.
- **Docs.** `docs/development/agent-connection.md`, "Approved project policy": an "Editor (T160-b)"
  item.

## Runs (Docker, one at a time through the shared slot lock)

| Run | Code | Result |
| --- | --- | --- |
| UI, `check_ui.sh test_project_policy test_agents_view test_grant_controls test_shared_composer test_typing test_app_shell test_phone_shell` (image build ran build, typecheck and lint; these screenshots) | `97ba7e36` | 86/86 OK (8 + 17 + 4 + 14 + 11 + 20 + 12) |
| API, `tests/app/agent-policy.test.ts` | `1899e6f4`; the policy's server, core and DB code and this test file are unchanged since (main brought changes to other agent-connection files) | 9/9 pass; the same 9 run again in the full check below |
| `./scripts/check_application.sh` (build, typecheck, lint, app tests and every browser/e2e phase) | `97ba7e36` | exit 0: 969/969 application tests (both policy suites included), then 13 later phases with 20/20 tests; 0 failures |
| Before the merge: the same UI modules without `test_phone_shell`, and the full check | `8f0ba3f3` and `e4b63298` | 72/72 OK; full check exit 0 (943/943, then 20/20) |

## Negative controls

Each patch in [negative-controls/](negative-controls/) breaks one or more behaviors in a scratch
copy of `97ba7e36`. The tests named below then fail, and the others still pass.

| Patch | Behavior removed | Failing tests (observed) |
| --- | --- | --- |
| `negU.patch` | (a) the editor is offered regardless of project access; (b) the base revision is refetched right before publishing, a silent overwrite; (c) no client check of the length before sending; (d) the policy text keeps its 14 px desktop size on a touch screen; (e) buttons have no press state of their own | `test_01b` (a: "Write policy" offered to a contributor), `test_02` (c: the alert reads the server's generic length message, not "Shorten Priorities to publish"), `test_03` (b: no conflict, Hubert's publish replaced Ola's), `test_04` (d: "14 not greater than or equal to 16: the policy reads at 16 px"), `test_04b` (e: the look is the same pressed and not pressed), `test_05` (a: an editor instead of "Only Hubert Nowak or Ola Kowalska can change it."). 6 fail; `test_01` and `test_06` pass. Before the merge, (d) made the fields 14 px; #267's shared 16 px rule now covers fields, so (d) targets the policy text instead. |
| `negA.patch` | (1) bootstrap names revision 1 instead of the newest; (2) any project reader may publish; (3) a stale `expectedRevision` is ignored, so the last write wins | Editor suite: test 1 (1: the next bootstrap still names revision 1, not 2), test 2 (2: a contributor's publish returned 201, not 403), test 4 (3: the stale publish returned 201, not 409); the invalid-policy test passes. #214's first and fifth tests also fail, as they check the same rules. 5 fail, 4 pass |

## Independent visual review

A separate reviewer saw only a neutral brief and the screenshots, taken at `6022fc6a`. The verdict
was "acceptable with changes", with nothing blocking. Changed in `8f0ba3f3`:

- The conflict had been one large tinted block showing the whole other revision. It is now one
  tinted line plus only the parts the other manager changed, each with "Use their …".
- Publish now comes before Cancel, as in the app's other forms.
- Readers are told who can change the policy.
- The "Published …" line no longer repeats the note's opening words.

Not changed:

- The policy is already folded by default; the reader screenshots were taken after "Show policy".
- The grey "Hide policy" was the shared button's hover state, left by the click. After the merge,
  touch screens no longer keep a hover fill (`test_04b`).
- The fields use the column width, like the task composer below them.

That review predates the merge of #267, the HIG sizing and the redesigned conflict view. A fresh
neutral visual pass on these screenshots, taken at the merged head, is still owed.

The HIG checks in the browser tests cover the read view and the editor at 390 px. That means Show,
Hide, Edit, Publish, Cancel and the fields; target size is measured as height. The conflict view's
"Use their …" buttons use the same button rules, but the tests exercise them only at 1440 px.

## Screenshots

- Desktop 1440:
  - `policy-none-reader-desktop-1440.png` (a contributor before any publish)
  - `policy-edit-desktop-1440.png`
  - `policy-read-desktop-1440.png`
  - `policy-conflict-desktop-1440.png`
  - `policy-conflict-actions-desktop-1440.png`
  - `policy-marek-desktop-1440.png` (contributor)
  - `policy-lee-desktop-1440.png` (viewer)
- Phone 390 (3x, coarse pointer):
  - `policy-edit-phone-390.png`
  - `policy-read-phone-390.png`
  - `policy-marek-phone-390.png`
  - `policy-lee-phone-390.png`

Screenshots do not prove interaction or accessibility; the browser tests above exercise those in
the running application.

## What remains of #160

This slice is T160-b only. It counts toward AC-1 (the bounded, approved project policy) and AC-4
(a project-policy update reaching the agent's next bootstrap). T160-a, the playbook naming every
registered tool (`flux.cowork` 1.2.0), is already on main through #256 (`a2a71007`). Still open:

- **Inbox, safe-checkpoint scheduling and recovery (AC-3/AC-4):** these need #153.
- **AC-5:** the Agents controls (Start/Resume/Pause/Stop and the request states) need #136.
- **AC-2:** real Claude Code and Codex onboarding in a fresh context, with pinned versions. This
  needs Maurycy.

The F-018 row of the release acceptance ledger (`docs/agents/release-acceptance/v0.1.0-rc.1.md`)
lives on `claude-maurycy/release-prep` and is not changed here.
