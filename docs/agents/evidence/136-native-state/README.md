# Canonical native project status and reader navigation — partial #136

2026-10-01. The header claimed no work while canonical Tasks contained an Open
task. Include actual Open and retained history in the shared native summary;
desktop controls and phone Details open real records. Make status/audience text
readable and project-reader navigation, empty states and Sources agree with
current access. Writer drafts and existing reply/assistant behavior are retained.

## Source pins and verification

Base: accepted main `7af78f29c7da3799a57bf204b343b5647516afc5`. No peer branch edits.
Latest runtime/test source: `1f0264b8953c1828895eaf2aeaf1e0289e15da15`.
The eventual evidence commit changes documentation/evidence only.

| Source | Actual configured Docker browser result |
| --- | --- |
| Test-only `8a3eeed`, original main runtime | Canonical-route failure: expected 1 Open, actual false empty. First invalid-route fixture is excluded. |
| `6c0c6bbff2d2bad21fbe80940baf281a78ba5650` | Build/type/lint; 21 state/project/work cases pass 42.113s. |
| `489956cc85cdc97b191baf0e6610c5efc7599e78` | Build/type/lint; 21 affected cases pass 44.117s. |
| `7c5aed47535287b1e60e3db8f0d9d937be72a988` | Build/type/lint; 62 expanded cases pass 198.480s. |
| `a5d02f2cc91b6e30c2166adf2b822128b1191923` | Build/type/lint; 62 expanded cases pass 197.914s. |
| `1f0264b8953c1828895eaf2aeaf1e0289e15da15` | Build/type/lint; 22/22 affected state/project/work cases pass 44.645s. Only delta is viewer Details copy and its assertions; earlier 62-case outcome remains pinned to its own source. |

The expanded suite includes `test_project_state`, `test_project_surface`,
`test_work_decisions`, `test_app_shell`, `test_personal_assistant`,
`test_return_view`. The final focused suite uses the first three modules.
Docker Compose uses separate generated project names, volumes and ports 19061/19062;
script traps remove their own stacks/images. Real native API/SQL persistence and
authenticated browsers, with Compose mock-provider configuration for preexisting
personal-assistant regressions; no real model/client/hardware acceptance claim.

Four new journeys cover empty→Open, blocked/done/not-pursued history and actual
object/Tasks agreement; 320/390/820/1280px reader views, actual viewer/denied policy;
uncited text-only exact-version source with Enter activation and visible body;
existing conversation through the phone drawer and role downgrade/upgrade with
saved writer draft recovery. New clipping assertions check visible text bounds,
not merely DOM text presence. Existing tests cover work/results/pivot, source
versions/revocation, drafts, reading anchors, assistant authority and return
acknowledgment. Native status/role transitions use reload/navigation, not stream
proof. Captures are emulation at 100% zoom, not device evidence.

At 1f0264b: agent setup/local links, 34 stdlib Python tests (1.935s) and diff check pass.
No full server application run is claimed by this UI-only correction.

## Reproduction and evidence

Run the configured source `scripts/check_ui.sh` wrapper at the pinned worktree;
only its working-directory entry and unittest module list are adapted. Exact
wrappers/check excerpts and raw local log SHA256s are included. Excerpts avoid
unrelated build chatter and failure cleanup environment values. The baseline
failure and excluded invalid-route attempt are explicit.

- [Neutral brief](neutral-brief.md) and [separate independent reviews](independent-reviews.md).
- [Baseline screenshot](baseline/136-state-single-open-desktop.png).
- [Current 22-case check excerpt](current-checks.txt); [final reader desktop](current/136-state-reader-1280-light.png), [320px reader](current/136-state-reader-320-light.png), [320px Details](current/136-state-overview-320.png), [retained history](current/136-state-retained-history-desktop.png) and [matched writer conversation](current/project-conversation-desktop-1280.png).

## Scope still open

This contributes to #136 AC1 (native shell state/read access), AC2 (phone state
route), AC3 (draft/source continuity) and AC5 (bounded real browser/pixel evidence).
None of the whole AC1–AC5, #151 or #155 is completed. Full Agents with actual
owners/connections/instruction loading/Start/Resume/Handoff, all integrated code
and non-code journeys, adaptive/performance/motion/input/zoom matrix, real
4K/ultrawide/Android/iPhone/iPad/PWA/push, eligible independent functional review
and protected integrated release remain required. No criteria are lowered.

Final command exited 0; its own Compose stack/volumes/images were removed.
The neutral focused final review found no material role-copy contradiction in
the two reader Details frames and saved phone conversation. Source reviewer found
no material delta issue at the current source. Both are bounded independent
internal reviews; @PelikanFix16 must still provide eligible functional/PR review.
