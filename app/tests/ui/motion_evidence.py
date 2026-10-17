"""Opt-in #593 AC-7 evidence: short videos of the light motion, one per acceptance criterion, light and dark, plus a
reduced-motion run of the same journeys and a phone run.

Not part of normal test_*.py discovery. Run it through the pinned UI stack, once per engine:
`FLUX_UI_BROWSER=chromium|webkit FLUX_UI_SCREENSHOT_DIR=<absolute dir outside the repo> ./scripts/check_ui.sh motion_evidence`.
It writes `<engine>-<scheme>-<criterion>.webm` and, beside each, `.motion.json`: every animation the page started (what it
animates, how long, how it eases), which is the measurement a video cannot be. A video is evidence of what was drawn, not of
interaction or accessibility; those are asserted in test_light_motion.py. Videos stay out of the repository (#319).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import unittest
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

from create_window import add_task
from light_motion_fixture import LightMotion, ready, recorded, settled
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

OUT = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots"))
BEAT = 650  # a pause long enough to see each motion finish before the next begins
TABS = "nav[aria-label='Project views']"


class MotionEvidence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=12000)
        cls.fx = LightMotion(cls.browser).build()
        cls.engine = cls.browser.browser_type.name
        OUT.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()
        cls.browser.close()
        cls.pw.stop()

    # ------------------------------------------------------------------ recording
    def film(self, criterion: str, journey, *, scheme: str = "light", reduced: bool = False, phone: bool = False) -> None:
        label = f"{self.engine}-{'phone-' if phone else ''}{scheme}{'-reduced' if reduced else ''}-{criterion}"
        scratch = OUT / f"_{label}"
        shutil.rmtree(scratch, ignore_errors=True)
        context = self.fx.context(scheme=scheme, reduced=reduced, phone=phone, video_dir=str(scratch))
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            journey(page)
            page.wait_for_timeout(BEAT)
            (OUT / f"{label}.motion.json").write_text(json.dumps(recorded(page), indent=1) + "\n")
        finally:
            video = page.video
            context.close()
            if video is not None:
                video.save_as(str(OUT / f"{label}.webm"))
            shutil.rmtree(scratch, ignore_errors=True)
        self.assertEqual(errors, [], f"{label}: no uncaught browser errors")

    def beat(self, page: Page, ms: int = BEAT) -> None:
        page.wait_for_timeout(ms)

    # ------------------------------------------------------------------ journeys, one per criterion
    def ac1(self, page: Page) -> None:
        """Dialogs, ⌘K, menus and toasts enter and leave; the scrim fades; focus returns at once."""
        page.goto(self.fx.project_url()); ready(page); self.beat(page)
        page.keyboard.press("Control+k"); self.beat(page, 900)
        page.keyboard.press("Escape"); self.beat(page)
        page.goto(self.fx.tasks_url()); ready(page); self.beat(page)
        page.get_by_role("button", name=re.compile("^(New )?Task$")).first.click(); self.beat(page, 900)
        page.keyboard.press("Escape"); self.beat(page)
        page.locator(".ws-task .ws-item").first.click(); self.beat(page, 900)
        panel = page.get_by_role("complementary", name="Details")
        panel.get_by_role("button", name="Status", exact=True).click(); self.beat(page, 900)
        page.keyboard.press("Escape"); self.beat(page)
        panel.get_by_role("button", name="Status", exact=True).click()
        page.get_by_role("menuitemradio", name="In progress").click(); self.beat(page, 1200)
        page.locator(".ui-toast").first.get_by_role("button", name="Dismiss notification").click(); self.beat(page)
        panel.locator(".ui-panel__body").focus()
        page.keyboard.press("Escape"); self.beat(page, 900)

    def ac2(self, page: Page) -> None:
        """The panel's content is replaced in the direction of travel; the shell, its head and controls stay still."""
        page.goto(self.fx.task_url(self.fx.tasks[0])); ready(page); self.beat(page, 900)
        panel = page.get_by_role("complementary", name="Details")
        panel.get_by_role("link", name=re.compile("Message: Should the first sensors")).click(); self.beat(page, 1100)
        panel.get_by_role("button", name=re.compile(r"^Task #\d+$")).click(); self.beat(page, 1100)
        panel.get_by_role("link", name=re.compile("Message: Should the first sensors")).click(); self.beat(page, 1100)
        page.keyboard.press("Escape")

    def ac3(self, page: Page) -> None:
        """Views and places crossfade the content area only; the header, sidebar and tab bar stay still."""
        page.goto(self.fx.project_url()); ready(page); self.beat(page, 900)
        for name in ("Tasks", "Map", "Wiki", "Agents", "Conversation"):
            page.locator(TABS).get_by_role("link", name=name).click(); self.beat(page, 1000)
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Inbox").click(); self.beat(page, 1000)
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click(); self.beat(page, 1000)
        page.goto("/settings/appearance"); ready(page); self.beat(page, 800)
        page.go_back(); self.beat(page, 1000)

    def ac4(self, page: Page) -> None:
        """A state change morphs and the row slides to its group; a row grows in; an accepted decision collapses."""
        page.goto(self.fx.tasks_url()); ready(page); self.beat(page, 900)
        glyph = page.locator("button.ws-task__glyph")
        glyph.first.click(); self.beat(page, 1100)
        glyph.last.click(); self.beat(page, 1100)
        add_task(page, "Order the cable ties"); self.beat(page, 1300)
        page.goto("/inbox"); ready(page); self.beat(page, 900)
        page.locator(".nyc").first.get_by_role("button", name=re.compile("^Accept")).click(); self.beat(page, 1300)

    def ac5(self, page: Page) -> None:
        """Every kind of pressable control scales to .97 and springs back; hover fills ease."""
        page.goto(self.fx.tasks_url()); ready(page); self.beat(page, 900)
        targets = [page.get_by_role("button", name="Collapse sidebar").first, page.get_by_role("button", name=re.compile("^(New )?Task$")).first,
                   page.locator("button.ws-task__glyph").first, page.locator(".ws-task .ws-item").first, page.locator(".side__project").first]
        for target in targets:
            box = target.bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2); self.beat(page, 500)
            page.mouse.down(); self.beat(page, 450)
            page.mouse.move(2, 2); page.mouse.up(); self.beat(page, 700)
        page.goto(self.fx.project_url()); ready(page)
        page.locator("#project-composer").fill("Probes arrive on Thursday"); self.beat(page, 500)
        send = page.locator(".composer__send").first.bounding_box()
        page.mouse.move(send["x"] + send["width"] / 2, send["y"] + send["height"] / 2)
        page.mouse.down(); self.beat(page, 450)
        page.mouse.move(2, 2); page.mouse.up(); self.beat(page, 700)

    def reduced(self, page: Page) -> None:
        """The same journeys under reduced motion: every surface is in its end state at once."""
        self.ac1(page)
        self.ac2(page)
        self.ac3(page)

    def phone(self, page: Page) -> None:
        """On the phone the detail sheet and its scrim follow the same rules; the press is the same."""
        page.goto(self.fx.tasks_url()); ready(page); self.beat(page, 900)
        page.locator(".ws-task .ws-item").first.tap(); self.beat(page, 1200)
        page.get_by_role("dialog", name="Details").get_by_role("button", name="Close details").tap(); self.beat(page, 1000)
        page.get_by_role("button", name="Create", exact=True).tap(); self.beat(page, 1000)
        page.keyboard.press("Escape"); self.beat(page, 800)

    # ------------------------------------------------------------------ the evidence
    def test_videos_for_every_criterion_light_and_dark(self):
        for scheme in ("light", "dark"):
            for criterion, journey in (("ac1-dialogs-menus-toasts", self.ac1), ("ac2-panel-content", self.ac2), ("ac3-views-and-places", self.ac3),
                                       ("ac4-state-and-rows", self.ac4), ("ac5-press", self.ac5)):
                with self.subTest(scheme=scheme, criterion=criterion):
                    self.film(criterion, journey, scheme=scheme)

    def test_videos_of_the_reduced_motion_run_and_the_phone(self):
        self.film("static-frames", self.reduced, reduced=True)
        self.film("sheet", self.phone, phone=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
