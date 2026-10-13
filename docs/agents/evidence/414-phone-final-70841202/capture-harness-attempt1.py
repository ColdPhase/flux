"""Temporary visual captures for #414; removed after the evidence packet is updated."""
from __future__ import annotations

import re
import unittest

from playwright.sync_api import expect

from test_app_shell import shot
from test_home_final import HomeFinal
from test_phone_final import PhoneFinal, SIZES


class ProjectDetailsCapture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        PhoneFinal.setUpClass()

    @classmethod
    def tearDownClass(cls):
        PhoneFinal.tearDownClass()

    def __getattr__(self, name):
        if hasattr(PhoneFinal, name):
            return getattr(PhoneFinal, name)
        raise AttributeError(name)

    def test_capture_project_details(self):
        for size in SIZES:
            for dark in (False, True):
                theme = "dark" if dark else "light"
                page = PhoneFinal.page(self, size, dark=dark)
                page.goto(f"/projects/{self.project['id']}/tasks")
                page.get_by_role("heading", level=1, name=re.compile("Community garden sensors")).get_by_role("button").click()
                page.get_by_role("button", name="Details, goal and people").click()
                details = page.get_by_role("dialog", name="Details")
                expect(details).to_be_visible()
                shot(page, f"341-details-{size['width']}-{theme}")
                page.close()


class ReturningHomeCapture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        HomeFinal.setUpClass()

    @classmethod
    def tearDownClass(cls):
        HomeFinal.tearDownClass()

    def __getattr__(self, name):
        if hasattr(HomeFinal, name):
            return getattr(HomeFinal, name)
        raise AttributeError(name)

    def test_capture_returning_home_continue(self):
        HomeFinal.test_05_phone_home_orders_continue_then_what_needs_you(self)
        page = HomeFinal.page(self, phone=True, dark=True)
        page.goto("/")
        expect(page.get_by_role("link", name=re.compile("^Continue where you left off"))).to_be_visible()
        shot(page, "341-home-returning-390-dark")


if __name__ == "__main__":
    unittest.main(verbosity=2)
