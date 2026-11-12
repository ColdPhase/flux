"""One state, both colour schemes, for the evidence of a UI change.

`shot_both(page, "1216-newspace-1440-chromium")` writes `<name>-light.png` and `<name>-dark.png` to FLUX_UI_SCREENSHOTS (nothing when it is
unset, as `shot`) and leaves the page in the scheme it had. The app follows the system scheme, so emulating it is what a person's setting does.
"""

from __future__ import annotations

from playwright.sync_api import Page

from test_app_shell import shot


def shot_both(page: Page, name: str) -> None:
    was = "dark" if page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches") else "light"
    for scheme in ("light", "dark"):
        page.emulate_media(color_scheme=scheme)
        shot(page, f"{name}-{scheme}")
    page.emulate_media(color_scheme=was)
