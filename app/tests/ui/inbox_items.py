"""Where an Inbox item's buttons are (#1367): at a computer width the list is the left column and the open item is the right column
(`.nyc--open`), so a row has no button and a test chooses the row first; in one column (a phone, a tablet in portrait) the selected card is
expanded inside the list. `open_item` returns the locator that holds the item's actions in either layout."""

from __future__ import annotations

from playwright.sync_api import Locator, expect


def open_item(row: Locator) -> Locator:
    """Chooses an item's row, and returns where its actions are: the open column, or its own card in one column."""
    page = row.page
    expect(row).to_be_visible()
    if not page.locator(".nyq--two").count():
        if "nyc--compact" in (row.get_attribute("class") or ""):
            frame = row.locator(".nyc__card").bounding_box()
            page.mouse.click(frame["x"] + 10, frame["y"] + frame["height"] / 2)
            expect(row).to_have_attribute("aria-current", "true")
        return row
    if row.get_attribute("aria-current") != "true":
        row.locator(".nyc__open").click()
        expect(row).to_have_attribute("aria-current", "true")
    pane = page.locator(".nyc--open")
    expect(pane).to_be_visible()
    return pane
