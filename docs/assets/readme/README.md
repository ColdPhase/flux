# README screenshots

The images at the top of the [README](../../../README.md) are unedited captures of the
running application, not of the prototype or a mockup.

| File | Source capture | Viewport |
| --- | --- | --- |
| `conversation-desktop.png` | `project-conversation-desktop-1440.png` from `test_02` in `app/tests/ui/test_project_surface.py` | 1440 × 900 CSS px, light theme |
| `conversation-phone.png` | `project-conversation-phone-390.png` from `test_07` in the same file | 390 × 844 CSS px at device scale 3 |

The content is the browser suite's fictional *Gesture lamp* project (Ada, Jonas and Nia),
created through the public API by the test itself.

**Captured at:** commit `6468eff659741000eb9c2a4eb80c8600f3afc183` (#184 Studio shell), by:

```sh
shots="$(mktemp -d)"
FLUX_UI_SCREENSHOT_DIR="$shots" ./scripts/check_ui.sh
cp "$shots/project-conversation-desktop-1440.png" docs/assets/readme/conversation-desktop.png
cp "$shots/project-conversation-phone-390.png" docs/assets/readme/conversation-phone.png
```

`FLUX_UI_SCREENSHOT_DIR` must be an absolute path; without it the captures stay in the
run's disposable volume. Replace both images, and the commit above, together when the
interface changes noticeably.
