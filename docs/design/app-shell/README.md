# App shell and design system (issue #40)

**Status:** implemented on branch `claude-maurycy/40-app-shell`, awaiting independent
evaluation. Direction: O-003 variant C ("calm messenger", #15 / PR #33), adjusted for the
creative-collaboration founder direction in #44. Date: 2026-09-27.

## Where things live

| What | Path |
| --- | --- |
| Tokens: colour (light, dark), type, spacing, radii, sizes, motion, layers | `apps/web/src/ui/tokens.css` |
| Base styles and core components | `apps/web/src/ui/` (`Button`/`IconButton`, `Input`, `Tabs`, `SidePanel`, `Overlay` → `Drawer`/`Sheet`, `Toast`, `EmptyState`, `ErrorState`, `Avatar`, `Icon`, `motion.ts`) |
| Screens | `apps/web/src/auth/` (sign-up, sign-in, sign-out, reset request and form), `apps/web/src/app/` (shell, sidebar, views, Details) |
| Routes (React Router 8 Data Mode) | `apps/web/src/router.tsx` |
| Contrast check for every token pair, both themes | `python3 scripts/check_contrast.py` |
| Browser tests and screenshots | `tests/ui/test_app_shell.py`, `scripts/check_ui.sh` |

Screens compose components and do not restyle them. A new colour, duration or radius is
added as a token first.

## What was carried over from C

- Near-monochrome neutrals, one indigo accent (`--accent`) used only for the primary action,
  links and "needs you"; 1px rules instead of boxes; Inter (self-hosted via
  `@fontsource-variable/inter`, no third-party font request); quiet dots instead of badges.
- Frame: 244px sidebar · 52px header with a quiet `Conversation · Tasks · Map · Docs`
  switcher whose 2px underline slides (translate + scaleX) · 700px reading column · a
  labelled **Details** button (`]`) opening a 384px side panel, closed by default.
- Breakpoints: sidebar becomes a drawer at ≤1180px; Details overlays at ≤980px and is a
  full-screen sheet at ≤640px, where the composer is pinned above the safe area.
- Motion tokens `--dur-1/2/3` = 120/180/260ms with C's easings. Only transform and opacity
  animate (panel slide + FLIP of the work column, drawer/sheet slides, view panes entering
  from their tab's side, toasts, popover). Every duration is 0ms under
  `prefers-reduced-motion`, and the script-driven animations read the same tokens.
- Coarse pointers get 44px controls (`--ctl`), the tooltips only exist for fine pointers.

## Adjusted for the founder direction (#44)

- No workspace selector. The administrative workspace is a data boundary only; the sidebar
  shows the instance name quietly and leads with **Home** (the personal return view),
  **New thought** (quick private capture), **Projects** and **Direct messages**. People are
  reached through DMs rather than a directory, so a project never reveals another project.
- Home's conversation is the person's private notes. The composer always shows its audience
  ("Only you · private note"); Enter saves. Until notes exist on the server (#36) they are kept
  in this browser per account, and the interface says so. Nothing is sent anywhere.
- Map's empty state invites thinking ("Start a sketch", **+ New thought**). Tasks and Docs
  say what will appear and that nothing is due. No counts, streaks or unread pressure.

## Honest data

The shell components take `workspace`, `projects` and `directMessages` props
(`apps/web/src/app/data.ts`). The loader returns empty lists until the workspace and
conversation APIs exist (#29 slice 2, #36); production code contains no sample data.

## Accessibility notes

- Visible 2px focus ring on every control; skip link; landmarks (`Sidebar`, `Views`
  navigation, `Details` complementary or dialog).
- Drawer, overlay panel and sheet are modal dialogs: focus moves in, Tab is trapped, the app
  root is `inert`, Esc or the scrim closes, and focus returns to the opener. The docked panel
  is non-modal; Esc inside it closes it and returns focus to Details.
- Forms: labels above fields, `aria-invalid` + described-by errors, first invalid field focused,
  form-level errors in a focused `role="alert"`; server codes are never shown.
- Contrast: all listed pairs pass WCAG 2.2 AA in both themes (`scripts/check_contrast.py`).
  Input borders use `--line-input` (≥3:1) rather than the decorative `--line`.

## Screenshots

Captured by `tests/ui` against the running Compose app (Chromium 151, 1× desktop, 3× phone):
`desktop-1440-light`, `desktop-1440-empty-light`, `desktop-1440-map-light`,
`desktop-1440-details-light`, `desktop-1440-dark`, `desktop-1440-details-dark`,
`tablet-1024-light`, `phone-390-light`, `phone-390-dark`, `phone-390-drawer-light`,
`phone-390-drawer-dark`, `phone-390-details-light`, `phone-360-tasks-light`,
`sign-in-desktop-light`, `sign-up-desktop-light`, `sign-in-phone-dark`,
`reset-unavailable-desktop-light`. They are self-assessed; an independent visual review is
still required. Screenshots do not prove behaviour; the browser tests do.

## Known gaps

- No project, DM or real conversation routes yet (#36, #29 slice 2); the switcher currently
  switches Home's views. Map canvas, tasks and docs are empty states only.
- Private notes are browser-local, not synced, and are lost if site data is cleared.
- Not yet verified on real iOS/Android devices or with a screen reader (#20 / #41).
