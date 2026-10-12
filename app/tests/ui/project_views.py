"""Moving between a project's views in browser tests.

On the phone Wiki the project title is the view menu and there is no row of views (F-026 §4 Phone,
#354); every other place keeps the "Project views" row. `project_view` opens the menu when it is the
switcher, so a journey can move between views the way a person would at that size.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from playwright.sync_api import Locator, Page

PHONE_MAX = 640


def title_menu(page: Page) -> bool:
    """True where the title is the view menu: a project's Wiki on a phone-width screen."""
    size = page.viewport_size or {"width": 1440}
    return size["width"] <= PHONE_MAX and bool(re.search(r"^/projects/[^/]+/docs(/|$)", urlparse(page.url).path))


def project_views(page: Page) -> Locator:
    """The "Project views" navigation, opening the title menu first where that is the switcher."""
    if title_menu(page):
        menu = page.locator("header.top .top__viewmenu")
        if menu.get_attribute("aria-expanded") != "true":
            menu.click()
    return page.get_by_role("navigation", name="Project views")


def project_view(page: Page, name: str, *, touch: bool = False) -> None:
    link = project_views(page).get_by_role("link", name=re.compile(f"^{re.escape(name)}"))
    link.tap() if touch else link.click()
