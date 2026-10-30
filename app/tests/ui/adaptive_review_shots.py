"""Opt-in screenshots for the #151 AC-5 neutral visual review: six project surfaces at six windows, light and dark.

Not part of normal test_*.py discovery. Run it through the pinned UI stack with a screenshot directory:
`FLUX_UI_SCREENSHOT_DIR="$PWD/../shots" ./scripts/check_ui.sh adaptive_review_shots`. It seeds the adaptive fixture (two owners,
three agent connections, a ten-root conversation, a linked map, tasks, a Wiki page), then adds a short task thread and a direct
message with a private reply thread, so the review sees short work streams on tall screens too.

Surfaces: the project conversation, the map, the tasks board, the Wiki page, the Agents view with a task's thread open, and a
direct message with its reply thread open. Windows: 320×568, 390×844 (phones, touch), 820×1180 (tablet, touch), 1440×900,
2560×1440 and 3440×1440 (mouse), at device pixel ratio 1. Each file is `<surface>-<width>x<height>-<theme>.png`.
Emulated viewports in headless Chromium or WebKit (FLUX_UI_BROWSER), not devices. The screenshots prove nothing about
interaction, focus or accessibility; those are the matrix's (test_adaptive_matrix).
"""
from __future__ import annotations

import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

import adaptive_fixture as fx
from test_app_shell import ORIGIN, SHOTS, UI_BROWSER, UPSTREAM, start_forwarder

WINDOWS = [(320, 568), (390, 844), (820, 1180), (1440, 900), (2560, 1440), (3440, 1440)]
THEMES = ("light", "dark")


class AdaptiveReviewShots(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        seeded = fx.seed(cls.browser)
        cls.states, cls.ids = seeded["states"], seeded["ids"]
        hubert = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states["hubert"])
        marek = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states["marek"])
        cls.task = cls.ids["tasks"][fx.OPEN_TASK]
        for context, body in ((hubert, "I will run both sensors under the bedside shelf tonight, lights off."),
                              (marek, "Log the distance at which each one stops seeing the hand.")):
            fx.api(context, "POST", f"/api/v1/work/{cls.task}/discussion", {"body": body, "clientMessageId": str(uuid.uuid4()), "kind": "text"})
        cls.dm = fx.api(hubert, "POST", f"/api/v1/workspaces/{cls.ids['workspace']}/dms", {"participantIds": [cls.ids["marek"]]})["id"]
        first = fx.api(hubert, "POST", f"/api/v1/dms/{cls.dm}/messages", {"body": "Can you bring the radar board on Thursday?", "clientMessageId": str(uuid.uuid4())})["id"]
        fx.api(marek, "POST", f"/api/v1/dms/{cls.dm}/messages", {"body": "Yes, and the spare cable.", "clientMessageId": str(uuid.uuid4())})
        fx.api(marek, "POST", f"/api/v1/dms/{cls.dm}/threads/{first}/replies", {"body": "It needs the 5 V supply, I will pack that too.", "clientMessageId": str(uuid.uuid4())})
        cls.dm_root = first
        hubert.close()
        marek.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def surfaces(self):
        p = self.ids["project"]
        return [
            ("conversation", f"/projects/{p}", ".project-convo__message"),
            ("map", f"/projects/{p}/map/{self.ids['sketch']}", ".sk-node"),
            ("tasks", f"/projects/{p}/tasks", ".tb-board, .ws-task"),
            ("wiki", f"/projects/{p}/docs/{self.ids['doc']}", "h2"),
            ("agents-thread", f"/projects/{p}/agents?task={self.task}", ".agents-msg"),
            ("dm-thread", f"/dm/{self.dm}?thread={self.dm_root}", "[data-dm-thread] .thread__list > li"),
        ]

    def test_capture(self) -> None:
        self.assertTrue(SHOTS, "FLUX_UI_SCREENSHOT_DIR is set")
        SHOTS.mkdir(parents=True, exist_ok=True)
        taken = 0
        for width, height in WINDOWS:
            touch = width <= 1024
            for theme in THEMES:
                context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states["hubert"], viewport={"width": width, "height": height},
                                                   color_scheme=theme, locale="en-GB", timezone_id="Europe/Warsaw", device_scale_factor=1,
                                                   has_touch=touch, is_mobile=touch and width <= 640, service_workers="block")
                page = context.new_page()
                for name, path, ready in self.surfaces():
                    with self.subTest(surface=name, width=width, height=height, theme=theme):
                        page.goto(path)
                        expect(page.locator(ready).first).to_be_visible()
                        page.wait_for_load_state("networkidle")
                        page.evaluate("document.fonts.ready.then(() => true)")
                        page.wait_for_timeout(600)  # panels, sheets and view motion settle
                        page.screenshot(path=str(SHOTS / f"{name}-{width}x{height}-{theme}.png"))
                        taken += 1
                context.close()
        print(f"\n  {taken} screenshots in {SHOTS}", end="")


if __name__ == "__main__":
    unittest.main(verbosity=2)
