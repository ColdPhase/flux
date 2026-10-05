# Phone-first shell evidence (#266, PR #267)

These captures were taken on 2026-10-05 in Chromium (Playwright 1.62), quantized to 128 colours, at 1× scale. Phone sizes use emulated touch and a coarse pointer. The source is branch `claude-hubert/266-phone-shell` after the PF-1 v2 revision, run in the `./flux dev` stack with the `./flux demo` seed. Under #266 item 10, physical devices are optional.

| File | Shows |
| --- | --- |
| `phone-375-home-places-bar.png`, `phone-390-home-places-bar.png` | PF-1 v2: the bottom bar of main places (Home, Inbox, Messages, Projects) on a top-level page, with the current one marked by a pill, its label and `aria-current`. |
| `phone-375-conversation-chips-state-row.png`, `phone-390-conversation-chips-state-row.png`, `phone-390-conversation-dark.png` | Inside a project there is no bottom bar: the work takes the full height. PF-1 view chips under the header, the current one filled. PF-2: one 52 px header with a labelled Details, and the state row with What matters, on Conversation only. PF-3: the composer card with the paperclip. |
| `phone-375-tasks-labelled-toolbar.png`, `phone-390-tasks-labelled-toolbar.png` | PF-6: a labelled Tasks toolbar (Search, Decisions with its count, Kanban, List, Mine, + Task). The column keeps a single "New task" row. |
| `phone-390-tasks-filter-in-use.png` | PF-6, review item 1: a filter in use stays readable next to the tools after focus leaves. The search was opened with a touch tap on the tile's edge (review item 3). |
| `phone-390-composer-three-lines.png` | PF-3, review item 5: the field grows to show a three-line draft. |
| `phone-390-keyboard-simulated-464.png` | PF-3/PF-7: the viewport is shrunk from 844 to 464 px while the field has focus. The field and Send stay visible and the draft is kept. |
| `phone-390-drawer.png` | The drawer, with the account row leading to Settings. |
| `phone-390-settings.png`, `phone-390-settings-section-back.png` | PF-5: the Settings list, and a section page with Back in the header. |
| `desktop-1440-tasks-tab-mark.png` | PF-1 on desktop: the tab mark spans the whole current label, and the sidebar row is tinted. |

These images do not prove behaviour. That is covered by `app/tests/ui/test_phone_shell.py`, including the simulated keyboard (test_11) and the 16 px fields (test_12), and by the modules listed on PR #267.
