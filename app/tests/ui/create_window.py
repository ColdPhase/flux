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


def linked_labels(page: Page) -> Locator:
    """The window's "Link" chips: what the task comes from (a message, or the thoughts of a Map selection, #509)."""
    return dialog(page).locator(".create__chip--link")


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
    """The Create window whichever tab it shows: its name follows the tab ("New task", "New thought", "New decision", "New page", "New space")."""
    return page.get_by_role("dialog", name=re.compile(r"^New (task|thought|decision|page|space)$"))


def kind_tab(page: Page, name: str) -> Locator:
    return window(page).get_by_role("tablist", name="Create").get_by_role("tab", name=name, exact=True)


def open_create(page: Page) -> None:
    """New in the computer sidebar: the Create window (or, with no space of the person's own yet, the New space window)."""
    page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="New", exact=True).click()


def new_space_window(page: Page) -> Locator:
    """The New space window (F-037, S20): its own title, Name, People, AI and Cancel. It is not a tab of the Create window."""
    return page.get_by_role("dialog", name="New space")


def open_new_space(page: Page) -> Locator:
    """From the open Create window, its Space tab opens the New space window in its place."""
    expect(window(page)).to_be_visible()
    kind_tab(page, "Space").click()
    expect(new_space_window(page).get_by_role("heading", name="New space")).to_be_visible()
    return new_space_window(page)


def create_other(page: Page, name: str) -> None:
    """From the open Create window: one of its other tabs (Thought, Decision or Page, #521, #867), or "Space", which opens the New space
    window (F-037). With no project yet the window opens on New space (#763 FR-2), so any window may be showing."""
    if name == "Space":
        if new_space_window(page).count() == 0:
            open_new_space(page)
        expect(new_space_window(page)).to_be_visible()
        return
    expect(window(page)).to_be_visible()
    kind_tab(page, name).click()
    expect(kind_tab(page, name)).to_have_attribute("aria-selected", "true")
    # A pointer on a tab goes on to its text one frame later (CreateWindow pointerOnTab). A fill into another field of
    # the window must not start before that focus move, or WebKit types into the text (#491).
    page.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


def open_decision(page: Page) -> Locator:
    """The Create window on its Decision tab, whichever way the device opens it: `C` on a computer, the "+" sheet's Decision row on a phone (#867)."""
    if (page.viewport_size or {"width": 1500})["width"] <= 640:
        page.get_by_role("button", name="Create", exact=True).click()
        page.get_by_role("button", name="Decision", exact=True).click()
    else:
        page.locator("body").press("c")
        create_other(page, "Decision")
    decision = page.get_by_role("dialog", name="New decision")
    expect(decision).to_be_visible()
    return decision


def propose_decision(page: Page, title: str, *, why: str | None = None, replaces: str | None = None) -> None:
    """Proposes a decision through the one form (#1419): the words, why, what it replaces (an accepted decision's title), then Propose decision.
    The proposal is held for Undo and reaches the people who can accept it when that window ends, so callers wait for it by its record."""
    decision = open_decision(page)
    decision.get_by_role("textbox", name="Decision", exact=True).fill(title)
    if why:
        decision.get_by_role("textbox", name="Why", exact=True).fill(why)
    if replaces:
        from app_select import choose
        decision.get_by_role("button", name="Replace an accepted decision…").click()
        choose(decision.get_by_label("Does it replace an earlier decision?", exact=True), label=replaces)
    decision.get_by_role("button", name=re.compile("^Propose decision")).click()
    expect(decision).to_have_count(0)
