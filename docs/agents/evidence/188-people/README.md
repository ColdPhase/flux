# #188 People management: closing evidence on main

Recorded on 2026-10-05 by Zamojski5 (`claude-maurycy`), #188's evaluator, who took
over the close-out while the owner (PelikanFix16) is unavailable. Everything below
was checked on `main` at `fdb70955` (after #195), in a clean detached worktree. The
feature merged in [#198](https://github.com/ColdPhase/flux/pull/198) as `9e080ba0`
after an independent review. This record changes no application code.

The issue stays open until someone closes it by hand: the follow-up PR
[#243](https://github.com/ColdPhase/flux/pull/243) says `Closes #236` only. The
#236 follow-ups (exact open-project access line, admin-view test, recorded v2
promotion default) are separate improvements and do not block #188's criteria.

## Runs at `fdb70955` (Docker)

| Command | Result |
| --- | --- |
| `./scripts/check_ui.sh test_people` | **10 tests, OK** ([log](test-people.txt)) |
| API files `sketch-promotion-participants`, `access`, `access-policy`, `dm-sketches` and `sketches` (`tsx --test --test-concurrency=1`, full Compose stack) | **50 tests in 9 suites, 50 passed, 0 failed** ([log](api-tests.txt)) |

Both runs built the images from this commit. The image step
`pnpm build && pnpm typecheck && pnpm lint` was a cache hit, so an earlier build of
the same inputs had already passed it.

## Acceptance criteria

Paths are under `app/apps/web/src/` unless they name another root.

| AC | Code on `main` | Test evidence |
| --- | --- | --- |
| **AC-1 Workspace people.** People in Home's Details; members and roles; add an existing account by email with a role; change role; remove; leave; plain "account not found"; read-only for non-managers; calm error messages | Home Details "People" section `app/Details.tsx:95-101`, opening `people/WorkspacePeople.tsx` (`app/Details.tsx:35`). List `WorkspacePeople.tsx:92`; add form `:148-153` (the hint says Flux sends no invitations); role editor `:232`; remove with confirmation `:245-253`; leave `:260-291`, with the last owner told what to do first `:113`; read-only text `:108-109`. Error copy `people/api.ts:88-111`: `ACCOUNT_NOT_FOUND` (create an account at this Flux address first), `ALREADY_MEMBER`, `LAST_OWNER`, `OWNER_REQUIRED`, 403. Server rules: `app/packages/core/src/access/domain.ts:234-289` | `test_people` test_01 (keyboard add, three roles, checked against the API), test_02 (not found, already a member, invalid address; nothing changes on the server), test_03 (role change, Esc returns focus), test_04 (last owner cannot step down or leave; member and guest are read-only; a guest does not see the member list), test_09 (remove and leave, both checked against the API) |
| **AC-2 Project access.** "Who can see this" in project Details: add a member as contributor or viewer, change, remove, explicit deny; restricted vs workspace-visible in one line; the exact person who gains access is shown before confirming | `people/ProjectAccess.tsx:143-149` (heading and the one-line mode), `:312-335` (give access, with the preview "Only … gains access … Nobody else is added"), `:106-119` (change, remove, "Keep out of this project" and "Let back in"); mounted at `project/ProjectOverview.tsx:157` | test_05 (grant to Kai only, previewed before confirming; the person giving access is not offered; a member and a guest without a grant get 404, nothing in the sidebar and no search hit), test_06 (change to read, then remove; checked against the API), test_07 (deny and let back in on a workspace-visible project; a member's view is read-only) |
| **AC-3 Connected entry points.** Setup's "invite later"; DM-sketch promotion with an explicit, unchecked "Also give Kai access" naming the people; the header audience line; nothing grants access implicitly | Setup opens "Who can see this" next: `app/ProjectSetup.tsx:30-35`. Promotion checkbox, off by default: `sketch/PromoteSketch.tsx:36-37, 55-58, 182-187`, sending `participants=none` unless it is ticked. The server accepts only `grant`/`none` (`app/apps/server/src/sketches/routes.ts:146`, `app/packages/core/src/sketches/service.ts:123-124`). Header audience line: `app/AppLayout.tsx:203-206, 280`. Default recorded in `docs/development/sketches.md:170-178` | test_05 (setup lands focused on "Who can see this"), test_07 (header audience line opens it), test_08 (promotion without the checkbox: no grants, Kai gets 404; with it: exactly Kai as contributor, Lee still 404), test_10 (phone audience line). API: `sketch-promotion-participants.test.ts:47, 82, 92` |
| **AC-4 Evidence.** Docker UI tests: two workspaces and four people; add, role change, remove, leave; grant and deny; promotion with and without the checkbox; not-found and already-member errors; read-only views; phone 390 and desktop 1440. API tests for any server change; existing access-policy tests unchanged and green | `app/tests/ui/test_people.py` (Riverside Makers and Harbour Studio; Ada, Kai, Lee and Mia). The only server change in #198 is the promotion `participants` choice. `app/tests/app/access.test.ts` and `access-policy.test.ts` were last changed in #191 (`55c54735`), before #198 | All of test_01–test_10 above; test_10 checks 390 px in light and dark (no horizontal scroll, 44 px touch targets) and test_01/test_05 check 1440 px. API: the 3 promotion tests, plus the unchanged `access.test.ts` (12), `access-policy.test.ts` (19), `dm-sketches.test.ts` (8) and `sketches.test.ts` (8), all green |

## Not covered here

- A real person's install on a fresh self-hosted machine. The browser journey runs
  against the Compose application.
- Visual review: the screenshots (`people-*.png`) were produced locally in this run
  and are not committed. #198's independent review covered the visuals.
