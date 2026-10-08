"""Shared locators for the one Create window (F-026 S3, #345) so every journey creates a task the same way."""

from __future__ import annotations

import re

from playwright.sync_api import Locator, Page, expect


def dialog(page: Page) -> Locator:
    return page.get_by_role("dialog", name="Create")


def title_field(page: Page) -> Locator:
    return dialog(page).get_by_label("Title", exact=True)


def submit_button(page: Page) -> Locator:
    return dialog(page).get_by_role("button", name=re.compile("^Create task"))


def open_from_tasks(page: Page) -> Locator:
    """Opens the window with the Tasks toolbar's "Task" button and returns the title field."""
    page.get_by_role("button", name=re.compile("^(New )?Task$")).first.click()
    expect(dialog(page)).to_be_visible()
    field = title_field(page)
    expect(field).to_be_focused()
    return field


def add_task(page: Page, title: str) -> None:
    """Creates one task from the Tasks view through the window and waits for the window to close."""
    field = open_from_tasks(page)
    field.fill(title)
    submit_button(page).click()
    expect(dialog(page)).to_have_count(0)


def create_other(page: Page, name: str) -> None:
    """From the open Create window: Project, Message or Private note (what the old New menu offered)."""
    expect(dialog(page)).to_be_visible()
    dialog(page).get_by_role("button", name=name, exact=True).click()
