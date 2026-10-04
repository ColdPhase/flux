# App shell and design system (issue #40)

> **Superseded appearance, 2026-10-02.** The shell now follows the measured Studio 11.6 system
> ([contract](../studio-v11.6.md), measured mapping in #182, #136): no identity rail, one 220px sidebar on the chrome,
> a rounded sheet, the system UI font instead of Inter, and a neutral `--action` for primary buttons.
> The structure below is kept as the history of #40.

**Status:** implemented on branch `claude-maurycy/40-app-shell`, awaiting independent
evaluation. Direction: O-003 variant C ("calm messenger", #15 / PR #33), adjusted for the
creative-collaboration founder direction in #44. Date: 2026-09-27.

## Where things live

| What | Path |
| --- | --- |
| Tokens: colour (light, dark), type, spacing, radii, sizes, motion, layers | `app/apps/web/src/ui/tokens.css` |
| Base styles and core components | `app/apps/web/src/ui/` (`Button`/`IconButton`, `Input`, `Tabs`, `SidePanel`, `Overlay` → `Drawer`/`Sheet`, `Toast`, `EmptyState`, `ErrorState`, `Avatar`, `Icon`, `motion.ts`) |
| Screens | `app/apps/web/src/auth/` (sign-up, sign-in, sign-out, reset request and form), `app/apps/web/src/app/` (shell, sidebar, views, Details) |
| Routes (React Router 8 Data Mode) | `app/apps/web/src/router.tsx` |
| Contrast check for every token pair, both themes | `python3 scripts/check_contrast.py` |
| Browser tests and screenshots | `app/tests/ui/test_app_shell.py`, `scripts/check_ui.sh` |

Screens compose components and do not restyle them. A new colour, duration or radius is
added as a token first.

## What was carried over from C

- Near-monochrome neutrals, one indigo accent (`--accent`) used only for the primary action,
  links and "needs you"; 1px rules instead of boxes; Inter (self-hosted via
  `@fontsource-variable/inter`, no third-party font request); quiet dots instead of badges.
- Frame: 60px identity rail · 232px sidebar · 52px header with a quiet `Conversation · Tasks · Map · Docs`
  switcher whose 2px underline slides (translate + scaleX) · 700px reading column · a
  labelled **Details** button (`]`) opening a 384px side panel, closed by default.
- Breakpoints: sidebar becomes a drawer at ≤1180px; Details overlays at ≤980px and is a
  full-screen sheet at ≤640px, where the composer is pinned above the safe area.
- Motion tokens `--dur-1/2/3` = 120/180/260ms with C's easings. Only transform and opacity
  animate (panel slide + FLIP of the work column, drawer/sheet slides, view panes entering
  from their tab's side, toasts, popover). Every duration is 0ms under
  `prefers-reduced-motion`, and the script-driven animations read the same tokens.
- Coarse pointers get 44px controls (`--ctl`), the tooltips only exist for fine pointers.

## Identity: the rail (founder decision on #40, 2026-09-27)

Of the two identity options in `docs/design/direction.md` (PR #33, which must merge before or
with this PR), the founder chose **rail**. A 60px dark rail (`--rail-bg` #111310; #0B0C0A with a
1px `--rail-line` edge in dark theme) at the far left holds the Flux mark (v8's two slanted
strokes, lime), **Home**, **Direct messages** and one geometric monogram per project the
person belongs to (none until projects exist; no "New project" button until projects can be
made). A lime bar marks the current place. The light sidebar beside it shows what is inside
that place. Indigo `--accent` #5159C8 stays the only accent. Below 1180px rail and sidebar
travel together inside the navigation drawer. `scripts/check_contrast.py` covers the rail pairs.

## Unfinished work is kept

- The composer text before Send is stored per account and context
  (`localStorage` `flux:draft:<userId>:<context>`), restored after a view switch and a
  reload, and cleared by Send. The hint says "Draft kept on this device" (or "until you close
  this tab" when the browser refuses storage).
- Each view's reading position is kept the same way (`flux:scroll:<userId>:<path>`).

## Personal AI placeholder (#57, PR #64)

A quiet ✦ **Ask my assistant** toggle sits inside the composer. It targets only the signed-in
person's own assistant. No compute path exists yet, so ask mode says "You haven’t connected an
assistant, so nothing will be sent", disables Send (the text is kept) and offers **Connect your
AI**, which opens Details with the options marked "not available yet". Nothing calls a model.

## PWA (#41) in the shell

`main.tsx` registers the service worker, the router root renders the update prompt on every
page, the account menu holds this device's notification control and session, the shell
refreshes the push subscription after sign-in, and sign-out calls `signOutDevice()`.

## Signing out

**Sign out** in the account menu is a navigation (a form post to `/sign-out`), not a background
request, so it replaces whatever the tab is still loading: a slow page can never land after the
sign-in page or take its address. It ends on `/sign-in` with "You’re signed out." When the server
cannot sign the device out, the person stays signed in and the sign-out page says so and offers
to try again. An object opened through `?open=` (a notification, a search result or a doc
reference) opens in Details once, and the flag leaves the address without reloading the page's
data.

With react-router 8.4 a fetcher whose action redirects does not cancel a navigation that is
still loading; that navigation finishes later and can take the page and its address back. An
action that moves the person elsewhere is therefore posted with a navigation form, not
`useFetcher`.

## Adjusted for the founder direction (#44)

- No workspace selector. The administrative workspace is a data boundary only. Home (the
  personal return view) holds **New thought** (quick private capture) and **Projects**;
  **Direct messages** is its own place. People are
  reached through DMs rather than a directory, so a project never reveals another project.
- Home's conversation is the person's private notes. The composer always shows its audience
  ("Only you · private note"); Enter saves. Until notes exist on the server (#36) they are kept
  in this browser per account, and the interface says so. Nothing is sent anywhere.
- Map's empty state invites thinking ("Start a sketch", **+ New thought**). Tasks and Docs
  say what will appear and that nothing is due. No counts, streaks or unread pressure.

## Honest data

The shell components take `workspace`, `projects` and `directMessages` props
(`app/apps/web/src/app/data.ts`). The loader returns empty lists until the workspace and
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

Captured by `app/tests/ui` against the running Compose app (Chromium 151, 1× desktop, 3× phone):
`desktop-1440-light`, `desktop-1440-empty-light`, `desktop-1440-map-light`,
`desktop-1440-details-light`, `desktop-1440-dm-light`, `desktop-1440-draft-light`,
`desktop-1440-ask-light`, `desktop-1440-account-light`, `desktop-1440-dark`, `desktop-1440-details-dark`,
`tablet-1024-light`, `phone-390-light`, `phone-390-dark`, `phone-390-drawer-light`,
`phone-390-drawer-dark`, `phone-390-details-light`, `phone-360-tasks-light`,
`sign-in-desktop-light`, `sign-up-desktop-light`, `sign-in-phone-dark`,
`reset-unavailable-desktop-light`. They are self-assessed; an independent visual review is
still required. Screenshots do not prove behaviour; the browser tests do.

## Known gaps

- No project or real conversation routes yet (#36, #29 slice 2); `/dm` is an empty place and
  the switcher currently switches Home's views. Details shows a no-selection prompt until
  selectable content exists. Map canvas, tasks and docs are empty states only.
- Home's notes are private drafts in the person's account (#190 HOME-3); notes an older
  version kept only in this browser are offered to move there. Unsent text and reading positions
  stay browser-local and are lost if site data is cleared.
- Not yet verified on real iOS/Android devices or with a screen reader (#20 / #41).
