"""Driving the app's own select (apps/web/src/ui/Select.tsx, #695) the way a person does: open it, pick an option.

The select is a combobox button that opens a listbox (a popover on a computer, a bottom sheet on a phone). The native
`select_option` and `to_have_value` do not apply to it, so tests use these helpers instead.
"""
from __future__ import annotations

import re

from playwright.sync_api import Locator, expect


# An open select and its list carry the same accessible name (the listbox is named like its combobox), so a bare
# `get_by_label("Place")` finds both while the list is open. The control comes first in the page: `.first` is the control.


def listbox_of(select: Locator) -> Locator:
    """The listbox an open select controls (ids from React contain colons, so the id is matched as an attribute)."""
    select = select.first
    expect(select).to_have_attribute("aria-expanded", "true")
    return select.page.locator(f'[id="{select.get_attribute("aria-controls")}"]')


def closed(select: Locator, box: Locator) -> None:
    """Waits until the list has left (it fades for a moment), so a `get_by_label` finds one element again."""
    expect(select.first).to_have_attribute("aria-expanded", "false")
    expect(box).to_have_count(0)


def open_select(select: Locator) -> Locator:
    select.first.click()
    return listbox_of(select)


def choose(select: Locator, option: str | None = None, *, label: str | None = None, value: str | None = None) -> None:
    """Open `select` and pick an option by `label=` or `value=`; a bare `option` matches a value, else a label."""
    select = select.first
    box = open_select(select)
    if label is not None:
        target = box.get_by_role("option", name=label, exact=True)
    elif value is not None:
        target = box.locator(f'[role="option"][data-value="{value}"]')
    else:
        target = box.locator(f'[role="option"][data-value="{option}"]').or_(box.get_by_role("option", name=str(option), exact=True)).first
    target.click()
    closed(select, box)


def values(select: Locator) -> list[str]:
    """The values of every option, read with the list open and closed again."""
    select = select.first
    box = open_select(select)
    found = box.locator('[role="option"]').evaluate_all("els => els.map(el => el.dataset.value)")
    select.press("Escape")
    closed(select, box)
    return found


def labels(select: Locator) -> list[str]:
    select = select.first
    box = open_select(select)
    found = box.locator('[role="option"]').evaluate_all("els => els.map(el => el.textContent.trim())")
    select.press("Escape")
    closed(select, box)
    return found


def expect_value(select: Locator, value: str | re.Pattern[str]) -> None:
    """What `to_have_value` was for a native select: the value the select shows now."""
    expect(select.first).to_have_attribute("data-value", value)
