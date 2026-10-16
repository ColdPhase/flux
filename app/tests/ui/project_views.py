"""Moving between a project's views using the current desktop tabs or phone title menu."""

from __future__ import annotations

import re
from urllib.parse import urlparse

from playwright.sync_api import Locator, Page

TITLE_MENU_MAX = 900


def title_menu(page: Page) -> bool:
    """True where the title is the view menu: all project views on a phone (#341) or tablet (Spokój, #505 AC-2)."""
    size = page.viewport_size or {"width": 1440}
    return size["width"] <= TITLE_MENU_MAX and bool(re.search(r"^/projects/[^/]+(?:/|$)", urlparse(page.url).path))


def project_views(page: Page) -> Locator:
    """The "Project views" navigation, opening the title menu first where that is the switcher."""
    if title_menu(page):
        opener = page.get_by_role("heading", level=1).get_by_role("button")
        if opener.get_attribute("aria-expanded") != "true":
            opener.click()
        return page.get_by_role("dialog").filter(has=page.locator(".phone-menu__list")).locator(".phone-menu__list")
    return page.get_by_role("navigation", name="Project views")


def project_view(page: Page, name: str, *, touch: bool = False) -> None:
    link = project_views(page).get_by_role("link", name=re.compile(f"^{re.escape(name)}"))
    link.tap() if touch else link.click()
