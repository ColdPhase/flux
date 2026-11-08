"""The text of a Wiki page, edited where it is read (#869), in either lane of FLUX_LIVE_EDITING.

A page is one editor on the page itself, the "Page text": with live editing configured (the default lane, #613) it is
the page's shared working copy, whose typing is shared as it happens; with FLUX_LIVE_EDITING=off it is this tab's copy.
In both lanes versions save by themselves a moment after the typing rests, and the row above the title says
"Saved · just now". A test names the difference through this module, so it says what it checks instead of which lane
happens to run.
"""
from __future__ import annotations

import json
import os
import re
import time

from playwright.sync_api import Locator, Page, expect

LIVE = os.environ.get("FLUX_LIVE_EDITING", "on") != "off"
TEXT = '.cm-content[aria-label="Page text"]'


def existing_text(page: Page) -> Locator:
    """The text of the open page."""
    return page.locator(TEXT)


def wait_until_shared(page: Page) -> None:
    """The page's text is editable (with live editing, the shared room is connected); typed text is kept from here on."""
    expect(page.locator(TEXT)).to_have_attribute("contenteditable", "true")


def saved(page: Page) -> Locator:
    """The page's state line once nothing waits to be saved."""
    return page.get_by_role("status").filter(has_text=re.compile(r"^Saved · "))


def has_text(text: Locator, snippet: str) -> None:
    """The page's text holds `snippet`. A `flux:` reference is drawn as its chip, so it is read from the editor's own document."""
    text.page.wait_for_function("([node, snippet]) => (node.cmTile?.root?.view?.state.doc.toString() ?? node.textContent).includes(snippet)",
                                arg=[text.element_handle(), snippet])


def text_of(text: Locator) -> str:
    """The page's whole Markdown text, as the editor holds it."""
    return text.evaluate("node => node.cmTile?.root?.view?.state.doc.toString() ?? node.textContent")


def type_at_end(page: Page, text: Locator, value: str) -> None:
    """Appends `value` to the page's text as typed text, and waits until it is kept."""
    # Focus, not a click: a click on a reference's chip opens what it refers to.
    text.focus()
    page.keyboard.press("Control+End")
    page.keyboard.insert_text(value)
    expect(saved(page)).to_be_visible()


def saved_version(page: Page, doc_id: str, snippet: str, timeout: float = 20.0) -> dict:
    """The page's saved version once it holds `snippet`: versions save by themselves when typing rests."""
    deadline = time.monotonic() + timeout
    while True:
        response = page.request.get(f"/api/v1/docs/{doc_id}")
        doc = json.loads(response.text())
        if snippet in doc.get("body", ""):
            return doc
        if time.monotonic() > deadline:
            raise AssertionError(f"no saved version holds {snippet!r}; the latest is version {doc.get('version')}")
        time.sleep(0.25)
