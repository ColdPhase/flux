"""The text editor of an existing Wiki page in both lanes of check_ui.sh (#683).

`FLUX_LIVE_EDITING` is `on` unless a run says `off` (check_ui.sh sets it). With it on, an existing page opens
the shared Markdown editor: a CodeMirror textbox named "Shared Markdown", where typing is shared as it
happens and only Save version keeps a version. With it off, the editor is the private textarea named
"Text (Markdown)". A new page and a restored version use the private textarea in both lanes.
"""

from __future__ import annotations

import os

from playwright.sync_api import Locator, Page, expect

LIVE = os.environ.get("FLUX_LIVE_EDITING", "on") != "off"
SHARED = '.cm-content[aria-label="Shared Markdown"]'
# The shared editor's status line once nothing waits to be shared.
SHARED_STATUS = "All changes shared"


def page_text(page: Page) -> Locator:
    """The text field of the page being edited, in this lane."""
    return page.locator(SHARED) if LIVE else page.get_by_label("Text (Markdown)")


def editor_ready(page: Page) -> Locator:
    """Wait until the editor can be typed into (the shared copy is connected in the live lane)."""
    if LIVE:
        expect(page.locator('[data-live-status="live"]')).to_be_visible()
    text = page_text(page)
    expect(text).to_be_visible()
    return text


def replace_text(page: Page, text: str) -> None:
    """Replace the whole text of the page being edited, as a person would by selecting all and typing."""
    field = editor_ready(page)
    if LIVE:
        field.click()
        page.keyboard.press("Control+a")
        page.keyboard.insert_text(text)
        expect(page.get_by_role("status").filter(has_text=SHARED_STATUS)).to_be_visible()
    else:
        field.fill(text)
