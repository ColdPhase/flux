# Friendly Flux evidence (#272, F-023, PR #275)

These captures were taken on 2026-10-06 in Chromium (Playwright 1.62), quantized to 128 colours, at 1× scale. Phone sizes use emulated touch and a coarse pointer. The source is a production build (`vite build`) of branch `claude-hubert/272-friendly-home`, with the `./flux demo` seed. The API is a dev twin without migration 0053, so the project header shows "Add a goal" rather than a goal.

| File | Shows |
| --- | --- |
| `phone-390-home.png`, `phone-375-home.png`, `phone-390-home-dark.png`, `desktop-1440-home.png`, `desktop-1440-home-dark.png` | FF-2: Home as the place to get back to work. Date and greeting, the return card with "Back to work", and My work with Moving and All. |
| `phone-390-home-for-you.png` | FF-2: For you, with "Decide: …" rows, other changes, "I have the context" and Your projects. Each project card carries its goal and state words. |
| `phone-390-notes.png`, `phone-390-sketchbook-map.png`, `desktop-1440-notes.png` | FF-3: My sketchbook as a private place, with Notes in chat order and the actions "Copy" and "Send to a project", and Map. |
| `phone-390-conversation.png`, `phone-375-conversation.png`, `phone-390-conversation-dark.png`, `desktop-1440-conversation.png` | FF-1 and FF-6: the header holds the goal (or "Add a goal") instead of the decision in force. Consecutive task announcements read as one list. "Cite" in the composer. The phone's Back control, the tab bar with Projects current, and the larger phone type (HIG-08/09). |
| `phone-390-tasks.png` | Cards without hex ids. |
| `phone-390-agents.png`, `desktop-1440-agents.png` | FF-8: Working together, with the two ways to bring AI in and the task's status in words. |
| `phone-390-dm.png`, `phone-390-inbox.png`, `phone-390-projects.png` | Messages, Inbox and Projects, each with its tab current. |
| `phone-390-settings.png`, `desktop-1440-settings.png` | FF-4: Settings as a page, opened from the person row. |
| `desktop-1440-sidebar-hidden.png` | FF-5: the sidebar hidden with `[`, and "Show sidebar" in the header. |

These images do not prove behaviour. That is covered by `app/tests/ui/test_friendly_home.py` and the migrated UI modules listed on PR #275.
