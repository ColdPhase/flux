"""Where an existing wiki page's text is edited, in either lane of FLUX_LIVE_EDITING.

With live editing configured (the default lane, #613) an existing page opens in its shared working copy: the "Shared Markdown" text,
whose typing is shared as it happens, a "Reason for this version" field, and a Save that keeps a version and stays on the editor
("Version N saved"). A new page, and every page under FLUX_LIVE_EDITING=off, is the ordinary editor: "Text (Markdown)", a private draft in
this tab, a "What changed" field, and a Save that goes to the page. A test about one of these guarantees names the difference through
this module, so it says what it checks instead of which editor happens to be on show.
"""
from __future__ import annotations

import os
import re

from playwright.sync_api import Locator, Page, expect

LIVE = os.environ.get("FLUX_LIVE_EDITING", "on") != "off"
SHARED = '.cm-content[aria-label="Shared Markdown"]'


def existing_text(page: Page) -> Locator:
    """The text of the page being edited (a new page has only the ordinary field: `page.get_by_label("Text (Markdown)")`)."""
    return page.locator(SHARED) if LIVE else page.get_by_label("Text (Markdown)", exact=True)


def wait_until_shared(page: Page) -> None:
    """The shared working copy is connected; typed text is shared from here on."""
    if LIVE:
        expect(page.locator('[data-live-status="live"]')).to_be_visible()


def reason_field(page: Page) -> Locator:
    return page.get_by_label("Reason for this version" if LIVE else "What changed")


def ordinary(text: Locator) -> bool:
    """True for the ordinary editor's field (a textarea with a value), false for the shared text (a content-editable)."""
    return bool(text.evaluate("node => node instanceof HTMLTextAreaElement"))


def has_text(text: Locator, snippet: str) -> None:
    """The editor's text holds `snippet` (the field's value in the ordinary editor, its content in the shared one)."""
    if ordinary(text):
        expect(text).to_have_value(re.compile(re.escape(snippet)))
    else:
        # The shared editor draws a `flux:` reference as its kind ("Decision card", CW-4); the text itself still holds it,
        # so it is read from the editor's own document, not from what is drawn.
        text.page.wait_for_function("([node, snippet]) => (node.cmTile?.root?.view?.state.doc.toString() ?? node.textContent).includes(snippet)",
                                    arg=[text.element_handle(), snippet])


def type_at_end(page: Page, text: Locator, value: str) -> None:
    """Appends `value` to the page's text as typed text (the shared text takes it as it would from a keyboard)."""
    if ordinary(text):
        text.focus()
        page.keyboard.press("Control+End")
        text.press_sequentially(value, delay=20)
    else:
        text.click()
        page.keyboard.press("Control+End")
        page.keyboard.insert_text(value)
        expect(page.get_by_role("status").filter(has_text="All changes shared")).to_be_visible()
