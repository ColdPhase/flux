"""Moving between a project's views with the segmented control every width has (#873)."""

from __future__ import annotations

import re

from playwright.sync_api import Locator, Page


def project_views(page: Page) -> Locator:
    """The "Space views" navigation: in the header's row on the computer and tablet, in the row under the title on a phone."""
    return page.get_by_role("navigation", name="Space views")


def project_view(page: Page, name: str, *, touch: bool = False) -> None:
    link = project_views(page).get_by_role("link", name=re.compile(f"^{re.escape(name)}"))
    link.tap() if touch else link.click()
