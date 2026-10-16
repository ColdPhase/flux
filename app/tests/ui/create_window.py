"""Shared locators for the one Create window (F-026 S3, #345) so every journey creates a task the same way."""

from __future__ import annotations

import re

from playwright.sync_api import Locator, Page, expect


def dialog(page: Page) -> Locator:
    return page.get_by_role("dialog", name="New task")


def title_field(page: Page) -> Locator:
    return dialog(page).get_by_label("Title", exact=True)


def submit_button(page: Page) -> Locator:
    return dialog(page).get_by_role("button", name=re.compile("^Create task"))


def open_from_tasks(page: Page) -> Locator:
    """Opens the window from Tasks and returns the title field: the toolbar's "Task" on the computer, the phone's "+" sheet on the phone."""
    if (page.viewport_size or {"width": 1500})["width"] <= 640:
        page.get_by_role("button", name="Create", exact=True).click()
        page.get_by_role("button", name="Task", exact=True).click()
        expect(dialog(page)).to_have_count(1)  # the "+" sheet has left the screen before the window is checked
    else:
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


def window(page: Page) -> Locator:
    """The Create window whichever tab it shows: its name follows the tab ("New task", "New thought", …)."""
    return page.get_by_role("dialog", name=re.compile(r"^New (task|thought|message|decision|project)$"))


def kind_tab(page: Page, name: str) -> Locator:
    return window(page).get_by_role("tablist", name="Create").get_by_role("tab", name=name, exact=True)


def create_other(page: Page, name: str) -> None:
    """From the open Create window: one of its other tabs (Thought, Message, Decision or Project, #521)."""
    expect(dialog(page)).to_be_visible()
    kind_tab(page, name).click()
    expect(kind_tab(page, name)).to_have_attribute("aria-selected", "true")
