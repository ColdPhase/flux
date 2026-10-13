# Visual review — Flux PR #417 status clarity delta

**Result: visual pass; prior status-clarity finding closed.** Reviewed the pinned screenshots for commit `4855b2cbd910685c986c8a999ff0db215d95b939` (tree `3bb6b494ae38fdb86619800cb538207e464229da`) against the neutral brief and current F-026 references. This is appearance-only evidence; it does not establish behavior, permissions, accessibility, or persistence.

## Evidence reviewed

All 14 captures in `manifest.json`: Chromium and WebKit `stop-sidebar-card.png`, `stop-agents-desktop-light.png`, `stop-agents-desktop-dark.png`, `stop-agents-phone-light.png`, `stop-agents-phone-dark.png`, `stop-home-desktop.png`, and `stop-home-phone.png`. The manifest pins each image hash and dimensions. Desktop captures are 1440 × 900; phone captures are 1170 × 2532.

F-026 references viewed: `docs/design/final/screens/desktop-agents.webp`, `desktop-handoff.webp`, `phone-agents.webp`, and `phone-handoff.webp`, with the rules in `docs/design/final/README.md` (especially agent marking, agent colours, Kreska expressions, and P9/S13).

## Finding

- **Closed: ambiguous task status versus agent activity.** In `stop-agents-desktop-light.png` and `stop-agents-desktop-dark.png` (both engines), the project header says **“Task in progress”** and names the task; the agent row separately says **“Handed #1 · not signed in yet.”** The detail panel reinforces the distinction with **“No message from it on this task yet”** and “not signed in yet.” The idle/asleep Kreska expression no longer conflicts with the task's native in-progress state. On the phone, the agent card likewise leads with **“Handed #3 · not signed in yet”** and a clearly labeled Stop control. This is a coherent visible account of an in-progress task whose agent has not signed in.

## Elements to preserve

Stop is a labeled, high-visibility control on the desktop agent row and detail panel, in the phone agent card, and in the Home/sidebar working-agent card. This follows the F-026 placement direction and is easy to locate in both themes. The owner and Agent tag remain visible with the agent identity. The detail panel separates the task, recent activity, and capabilities into readable groups. Current Agents and phone layouts retain the list-first structure of the F-026 references.

## Minor visual discrepancy

The same “Claude Code agent” Kreska is indigo in Chromium and plum in WebKit in the Agents captures (`stop-agents-desktop-light.png` and `stop-agents-phone-light.png`); the F-026 reference assigns Claude Code Clay. The agent palette is explicitly allowed in Agents, so this does not block the status-clarity pass, but the captured identity colour is inconsistent across engines and unlike the named reference. **P3**, if tracked; normalize the visible agent colour across engines to the intended identity colour.

Live checks still need to establish Stop behavior, keyboard/touch interaction, state correctness, and accessibility; screenshots cannot verify those.
