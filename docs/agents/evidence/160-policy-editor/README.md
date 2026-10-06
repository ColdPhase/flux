# Agent policy editor in the Agents view (#160, T160-b)

Tested code: `f0e397cf`, branch `claude-maurycy/160-policy-editor`. That commit answers
claude-hubert's review of `c6ac24e3` on PR #292; see "Review of PR #292" below. Main has been
merged in twice without conflicts:
- `4e99d223` (#267, #268, #283, #285) at `1bee689a`;
- `e68c39c6` (#284, #286, #294, #293, #274, #270, #291) at `626386cb`.

The commit that adds this evidence changes only this directory. Owner of the slice:
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
    answers `409 VERSION_CONFLICT`. The manager's text is kept and one short line says who
    published which revision. Under each field the other revision changed, its text appears with
    "Use their …". Only pressing Publish again replaces that revision.
  - Every state has one line saying what the policy is, who writes it and whether the reader needs
    to act. Readers see "Only Hubert Nowak or Ola Kowalska write them; you don't need to do
    anything" (the managers are named when there are three or fewer). Managers see that it is
    optional and why they might write one.
  - Everyone else who can read the project sees the parts read-only. An open view follows
    `project.agent_policy_published.v1` without a reload.
  - A publish whose answer is lost says "Flux couldn't confirm the publish. Your text is kept;
    publishing again won't publish it twice" and asks again. A revision that the person's own
    unconfirmed publish made is recognised as theirs: the edit ends, or carries on from it if the
    text changed since. It is never shown as another person's revision and never causes a conflict
    with oneself.
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
    follows one agent's bootstrap, in one resumed client session, across publishes. Tests 2 to 4
    publish their own starting revision when none exists, so none depends on test 1:
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
  - `app/tests/ui/test_project_policy.py` has 10 tests at desktop 1440 and on phones at 390 and 320
    (coarse pointer, no hover). Every publish is checked against the server's saved revision.
    - `test_01b`: before the first publish, the exact purpose line for a contributor and for a
      manager, at 1440 and at 390. Each also checks that the section has no internal words
      ("checkpoint", "grants", "bootstrap").
    - `test_02b`: a lost answer, with Flux reachable again (the edit ends as published) and with
      Flux unreachable for a moment (the exact message; a later changed text continues from the
      revision the lost publish made). Neither case ever says "while you were editing" or "another
      tab".
    - `test_03b`: a conflict on phones at 390 and 320. The other revision's text sits right under
      the changed field, and the banner is at most 4 lines at 390 px and 5 at 320 px.
    - The phone checks of `test_04` and `test_04b`:
      - the fields use 16 px text;
      - Show, Hide, Edit, Publish and Cancel are at least 44 px tall, with 12 px between Publish
        and Cancel;
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
| UI, `check_ui.sh test_project_policy test_agents_view test_grant_controls test_shared_composer test_typing test_app_shell test_phone_shell test_agents_accents` (image build ran build, typecheck and lint; these screenshots) | `f0e397cf` | 90/90 OK (10 + 17 + 4 + 14 + 11 + 20 + 12 + 2) |
| `./scripts/check_application.sh` (build, typecheck, lint, app tests including both policy suites, every browser/e2e phase) | `f0e397cf` | RESULT_FULL |
| Earlier heads | `97ba7e36`; `8f0ba3f3` and `e4b63298` | UI 86/86 and full check exit 0 (969/969, then 20/20); before the first merge, UI 72/72 and full check exit 0 (943/943, then 20/20) |

## Negative controls

Each patch in [negative-controls/](negative-controls/) breaks one or more behaviors in a scratch
copy of the tested code. The tests named below then fail, and the others still pass.

| Patch | Code | Behavior removed | Failing tests (observed) |
| --- | --- | --- | --- |
| `negE.patch` | `f0e397cf` | (f) the purpose line, so the empty state is "Agent policy · None yet" again, as Hubert found it | `test_01b` (the contributor's purpose line is missing, at 1440), `test_02` (the manager's line after the first publish is missing), `test_05` (the reader's line is missing). 3 fail; the other 7 pass. |
| `negU.patch` | `f0e397cf` | (a) the editor is offered regardless of project access; (b) the base revision is refetched right before publishing, a silent overwrite; (c) no client check of the length before sending; (d) the policy text keeps its 14 px desktop size on a touch screen; (e) buttons have no press state of their own; (g) a revision the person's own unconfirmed publish made is never recognised as theirs | `test_01b` and `test_05` (a: a contributor gets the manager's line and editor), `test_02` (c: the alert reads the server's generic length message), `test_02b` (g: the lost publish's own revision is not recognised, so the edit never ends as published), `test_03` and `test_03b` (b: no conflict, Ola's revision silently replaced), `test_04` (d: "14 not greater than or equal to 16"), `test_04b` (e: the look is the same pressed and not pressed). 8 fail; `test_01` and `test_06` pass. |
| `negA.patch` | `97ba7e36` | (1) bootstrap names revision 1 instead of the newest; (2) any project reader may publish; (3) a stale `expectedRevision` is ignored, so the last write wins | Editor suite: test 1 (1: the next bootstrap still names revision 1, not 2), test 2 (2: a contributor's publish returned 201, not 403), test 4 (3: the stale publish returned 201, not 409); the invalid-policy test passes. #214's first and fifth tests also fail, as they check the same rules. 5 fail, 4 pass. The API code is unchanged since; the only later test change makes tests 2 to 4 publish their own starting revision, so this was not repeated. |

Before the first merge, (d) made the fields 14 px. #267's shared 16 px rule now covers fields, so
(d) targets the policy text instead.

## Review of PR #292 (claude-hubert, `c6ac24e3`, changes requested)

| Item | Fix in `f0e397cf` | Test |
| --- | --- | --- |
| B1: the empty state explains nothing | One line of purpose in every state. Readers see "Rules connected agents read before they plan work in this project. Only Hubert Nowak or Ola Kowalska write them; you don't need to do anything." Managers before a publish see "… They're optional: write them when agents here should keep to certain work or meet review rules."; after a publish, "… You can change them at any time." | `test_01b` (contributor and manager, 1440 and 390), `test_02`, `test_05`; negative control `negE` |
| S1: the lost-answer message is false; one's own revision is shown as another person's | The new message, a re-read after the lost answer, and recognition of one's own unconfirmed revision, in both the live update and a later 409. | `test_02b` (both cases); negative control `negU` (g) |
| S2: the conflict is far from the field on phones | The other revision's text and "Use their …" sit under the field it changed, and the banner is one short sentence pair. | `test_03` (1440), `test_03b` (390 and 320) |
| S3: internal words | "It only narrows what agents do; it never gives them more access." "Agents use revision N from their next task." "Published. Agents use it from their next task." | `test_01b`, `test_02` (no "checkpoint", "grants" or "bootstrap") |
| Nit: tests 2 to 4 depend on test 1 | They publish their own starting revision if none exists. | API run in the full check |
| Nit: the revision is named twice | The status is "Published. Agents use it from their next task."; the revision appears once, in the line under the title. | `test_02` |

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

That review predates the merge of #267, the HIG sizing and the conflict view under each field.
claude-hubert's evaluation of `c6ac24e3` included a second neutral visual pass, and B1, S2 and S3
came from it. A fresh visual pass at `f0e397cf` is still owed.

The HIG checks in the browser tests cover the read view and the editor at 390 px: Show, Hide, Edit,
Publish, Cancel and the fields. "Use their …" is also checked at 390 and 320 px. Target size is
measured as height.

## Screenshots

- Desktop 1440:
  - `policy-none-reader-desktop-1440.png` (a contributor before any publish)
  - `policy-none-manager-desktop-1440.png` (a manager before any publish)
  - `policy-lost-answer-desktop-1440.png` (Flux couldn't confirm the publish)
  - `policy-edit-desktop-1440.png`
  - `policy-read-desktop-1440.png`
  - `policy-conflict-desktop-1440.png`
  - `policy-conflict-actions-desktop-1440.png`
  - `policy-marek-desktop-1440.png` (contributor)
  - `policy-lee-desktop-1440.png` (viewer)
- Phone 390 and 320 (3x, coarse pointer):
  - `policy-none-reader-phone-390.png`
  - `policy-none-manager-phone-390.png`
  - `policy-conflict-phone-390.png`
  - `policy-conflict-phone-320.png`
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
