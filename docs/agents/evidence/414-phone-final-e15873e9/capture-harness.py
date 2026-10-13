"""Temporary, behavior-neutral screenshots for the #414 visual delta; remove after capture."""
from __future__ import annotations

import unittest

from playwright.sync_api import expect
from test_phone_final import PhoneFinal, SIZES
from test_app_shell import shot


class PhoneDeltaCapture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        PhoneFinal.setUpClass()

    @classmethod
    def tearDownClass(cls):
        PhoneFinal.tearDownClass()

    def __getattr__(self, name):
        # Reuse only the existing authenticated fixture's project/workspace/browser data.
        if hasattr(PhoneFinal, name):
            return getattr(PhoneFinal, name)
        raise AttributeError(name)

    def capture(self, width: int):
        size = next(size for size in SIZES if size["width"] == width)
        for dark in (False, True):
            theme = "dark" if dark else "light"
            page = PhoneFinal.page(self, size, dark=dark)
            page.goto("/projects")
            page.get_by_role("button", name="Create", exact=True).click()
            create = page.get_by_role("dialog", name="Create")
            expect(create.get_by_role("textbox", name="Create a task from text")).to_be_visible()
            shot(page, f"414-create-quicktext-{width}-{theme}")
            page.keyboard.press("Escape")
            page.goto(f"/projects/{self.project['id']}/tasks")
            page.get_by_role("heading", level=1, name="Community garden sensors").get_by_role("button").click()
            page.get_by_role("button", name="Details, goal and people").click()
            details = page.get_by_role("dialog", name="Details")
            expect(details.get_by_role("button", name="What matters")).to_be_visible()
            shot(page, f"414-details-what-matters-{width}-{theme}")
            page.close()

    def test_capture_390(self):
        self.capture(390)

    def test_capture_320(self):
        self.capture(320)


if __name__ == "__main__":
    unittest.main(verbosity=2)
