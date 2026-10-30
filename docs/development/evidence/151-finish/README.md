# #151 close-out: short threads, safe areas, map and list latency, visual review (2026-10-30)

Branch `claude-hubert/151-finish`, code head `fd0561f88` (the evidence commit adds this page and its files only).
Everything ran in Docker through `scripts/check_ui.sh` on ports 32400/32401, one suite at a time, on a host other agents'
suites shared. Emulated viewports in headless Chromium 151.0.7922.34 and Playwright WebKit; not devices.

## AC-2: short threads on tall screens

Space between the newest message and its field, CSS px (`test_adaptive_matrix` test_09, the same in Chromium and WebKit):

| Feed | 390×844 | 820×1180 | 1440×900 | 2560×1440 | 3440×1440 |
| --- | --- | --- | --- | --- | --- |
| Direct message's reply thread, before (`main` `355e41e25`) | 396 | 775 | 404 | 944 | 944 |
| Direct message's reply thread, after | 23 | 26 | 28 | 28 | 28 |
| Agents task thread, after | 32 | 32 | 32 | 32 | 32 |

The Agents thread was not measured before; it was bottom-aligned with an auto margin, which moved the rows above a
message that grew in place. Both now use `ui/spareHeight.ts` like the stream and the project thread.

## AC-4: safe areas

`test_22` simulates a notched phone upright (47/0/34/0) and on its side (0/47/21/47) with Chromium's
`Emulation.setSafeAreaInsetsOverride`, first proving that `env(safe-area-inset-*)` resolves to it. Its first run failed on
three real defects, fixed here: the phone composer (field and Send 2 px into the home indicator), the map's "Add a thought",
and the rail on a phone on its side (controls 10 px into the left inset, the account 19 px into the bottom one, Settings
below the window). WebKit has no override: the case is skipped there and stays unverified, as do real devices.

## AC-4: map and list latency

`motion_performance.MotionPerformance.test_map_and_list_latency_budgets`, full size. Report:
[`motion-performance-map-list.json`](motion-performance-map-list.json). p95 in ms against the budget:

| Distribution | Desktop 1280×800 | Phone 390×844, CPU 4× |
| --- | --- | --- |
| Tasks pane, wheel | 58 / 100 | 65 / 200 |
| Conversation stream, wheel | 59 / 100 | 65 / 200 |
| Map pan, wheel | 75 / 100 (78 in the first run) | 78 / 200 |
| Map zoom (Ctrl+wheel; phone: zoom control in Map options) | 75 / 100 | 65 / 200 |
| Worst frame gap, any of the above | 17 / 50 | 17 / 100 |

Outcome `within-budgets`. Basis per row: [adaptive workspaces](../../../design/adaptive-workspaces.md#agreed-performance-budgets).

## AC-5: visual review

**Limited review, labelled as such.** Done by the session that wrote this branch's fixes, at the founder's request (no
sub-agents). It is independent of the authors of PR #669 and PR #714 (other sessions), not of this branch's small changes.

- **Brief (neutral).** A member of a small hardware studio, two owners and one colleague, with three agent connections,
  catches up on a bedside-lamp project and continues it: reads the latest discussion and replies, checks the map, tasks
  and wiki, follows a task's thread in Agents, and answers a private reply thread. On a small phone, a phone, a tablet, a
  laptop, a 1440p monitor and an ultrawide.
- **Shots.** 72: conversation, map, tasks, wiki, Agents with a task thread open, a direct message with its reply thread
  open; at 320×568, 390×844 (touch), 820×1180 (touch), 1440×900, 2560×1440, 3440×1440; light and dark; DPR 1. Captured by
  the opt-in `app/tests/ui/adaptive_review_shots.py` at `fd0561f88`. Six representative ones are here; the module recreates all.
- **References.** `docs/design/final/screens` (desktop and phone conversation, thread, map, tasks, wiki, agents).
  Constraint: the Agents column's 854 px cap is a founder design decision.

Material problems (at most three):

1. **Phone conversation, 320×568 and 390×844:** an empty band of 137–147 px between the newest message and the composer
   when the stream opens ([conversation-320x568-light](conversation-320x568-light.webp)). On the smallest screen it is a
   third of the feed, so the composer looks detached and a message fewer fits. Measured cause: the opening "whole messages"
   room. [#725](https://github.com/ColdPhase/flux/issues/725).
2. **Map at Fit on a 1440×900 laptop:** thought text at about 7 px (Fit's 60% floor), and the last thought wedged between
   the toolbar and the minimap ([map-1440x900-light](map-1440x900-light.webp)). An overview, not a readable working map.
   [#726](https://github.com/ColdPhase/flux/issues/726).
3. **Ultrawide (3440×1440):** the Agents list and the one panel sit at opposite ends with roughly 900 px of empty canvas (about 500 px at 2560×1440)
   between them, and the Tasks board's columns spread sparse ([agents-thread-2560x1440-dark](agents-thread-2560x1440-dark.webp),
   [conversation-3440x1440-dark](conversation-3440x1440-dark.webp)). The conversation keeps its 760 px column as Spokój draws.
   Recorded, not changed: the Agents cap is the founders' decision.

Preserve: short threads and direct messages now sit against their fields at every size
([dm-thread-1440x900-light](dm-thread-1440x900-light.webp)); place names, view order and primary actions are the same at
every size; the phone keeps one clear primary action per view; dark and light are at parity in every shot; the tablet
board keeps three columns readable ([tasks-820x1180-light](tasks-820x1180-light.webp)).

Not judged from images: interaction, focus, keyboard, accessibility, transitions (the matrix tests them). A separate
finding outside the review set: on a window under about 420 px tall the rail has no room for projects
([#727](https://github.com/ColdPhase/flux/issues/727)).
