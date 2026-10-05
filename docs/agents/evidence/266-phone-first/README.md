# Phone-first shell evidence (#266, PR #267)

These captures were taken on 2026-10-05 in Chromium with emulated viewports. Phone sizes use touch and a coarse pointer, at 2× scale, quantized to 128 colours. The source is branch `claude-hubert/266-phone-shell`, run in the `./flux dev` stack with the `./flux demo` seed plus a few extra tasks, decisions and projects. Under #266 item 10, physical devices are optional.

| File | Shows |
| --- | --- |
| `phone-375-conversation-light.png`, `-dark.png` | PF-1 bottom view bar with the current view. PF-2 52 px header with What matters and Details as icons, and the project's state line on Conversation. PF-3 compact composer with the paperclip. |
| `phone-375-tasks-light.png`, `-dark.png`, `phone-320-tasks-light.png` | PF-6 Tasks toolbar in one row. The first card sits about 160 px higher than before. |
| `phone-375-map-light.png` | The map's sketch list under the bar. |
| `phone-375-drawer-light.png` | Drawer with the accent-tinted current project. The account row opens Settings. |
| `phone-375-details-light.png` | Details sheet with its grabber, which closes with a downward drag. |
| `phone-375-settings-light.png`, `desktop-1440-settings-light.png` | PF-5 Settings. |
| `desktop-1440-tasks-light.png` | PF-1 desktop tabs, where the mark spans the whole current label, and the accent sidebar row. |

Behaviour is not proven by these images. It is covered by `app/tests/ui/test_phone_shell.py` and the updated modules listed on PR #267.
