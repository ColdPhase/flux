"""The sidebar's account row (#1419): your name is the one way into Settings, and Sign out is a row of Settings › Account.

There is no account menu and no gear any more, so a test that signs out goes the way a person does: the name, then Settings › Account.
"""
from __future__ import annotations

import re

from playwright.sync_api import Locator, Page, expect


def account_link(page: Page, name: str | None = None) -> Locator:
    """The foot of the sidebar: the face and name, one link to Settings (the rail has the face alone, named the same)."""
    return page.get_by_role("link", name=re.compile(rf"{re.escape(name)}, Settings$" if name else r".+, Settings$")).first


def open_settings(page: Page, name: str | None = None) -> None:
    """The name opens Settings; Sign out is in its Account section, one row down the list on a phone and in the list beside the page on a computer."""
    account_link(page, name).click()
    expect(page.get_by_role("heading", level=1, name="Settings")).to_be_visible()
    page.get_by_role("link", name=re.compile(r"^Account")).first.click()
    expect(page.get_by_role("heading", name="Account", exact=True)).to_be_visible()


def sign_out_button(page: Page) -> Locator:
    """Settings › Account's one Sign out row (the other devices have their own, named after the device)."""
    return page.locator('form[action="/sign-out"] button')


def sign_out(page: Page, name: str | None = None, **click) -> None:
    """Opens Settings from the sidebar and signs out of this device."""
    open_settings(page, name)
    sign_out_button(page).click(**click)
