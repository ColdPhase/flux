"""Opt-in #155 AC-5 evidence: a Playwright trace and a video of navigation feedback and typing presence on the running head.

Not part of normal test_*.py discovery. Run it through the pinned UI stack with an absolute output directory outside the
repository: `FLUX_UI_SCREENSHOT_DIR=<dir> ./scripts/check_ui.sh motion_trace`. It writes, per profile (`desktop`, `phone`),
`trace-<profile>.zip` (open it with `npx playwright show-trace`) and `<profile>.webm`, then `trace-marks.json` naming the
steps. What is committed under docs/development/evidence/ is those, re-encoded small with the ffmpeg command in that
report (#319).

One person (Bob) navigates a realistic project (three projects, 60 conversation roots and 40 tasks each, a 40-reply thread:
`motion_performance.build_fixture`) while another (Ada) types in the thread he has open. Bob's page is what is recorded:
the work tab's and the project's traveling highlight on the computer, the title menu leaving on the phone, and the
"Ada Kowalska is typing…" line appearing and going. Ada's text is never sent. A trace and a video show what was drawn and
when; they do not certify interaction or accessibility, which the test modules assert.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import unittest

from playwright.sync_api import expect, sync_playwright

from motion_performance import DESKTOP, build_fixture
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

OUT = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots"))
BEAT = 700  # long enough for a motion to finish and be seen before the next begins
PHONE = {"width": 390, "height": 844}
TYPING = re.compile(r"Ada Kowalska is typing")


class MotionTrace(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        cls.fixture = build_fixture(cls.browser)
        OUT.mkdir(parents=True, exist_ok=True)
        cls.marks = {"sourceCommit": os.environ.get("FLUX_GIT_COMMIT", "unavailable"), "browser": cls.browser.version, "profiles": {}}

    @classmethod
    def tearDownClass(cls):
        (OUT / "trace-marks.json").write_text(json.dumps(cls.marks, indent=2) + "\n")
        cls.browser.close()
        cls.pw.stop()

    def record(self, profile, viewport, phone):
        """Bob's page for `profile`, traced and filmed; Ada's page is beside it, unrecorded, on the same thread."""
        thread = f"/projects/{self.fixture['projects'][0]}/conversations/{self.fixture['thread']['id']}"
        project = f"/projects/{self.fixture['projects'][0]}"
        film = OUT / f"film-{profile}"
        shutil.rmtree(film, ignore_errors=True)
        bob_context = self.browser.new_context(base_url=ORIGIN, storage_state=self.fixture["states"]["bob"], viewport=viewport, locale="en-GB",
                                               has_touch=phone, is_mobile=phone, service_workers="block", record_video_dir=str(film), record_video_size=viewport)
        ada_context = self.browser.new_context(base_url=ORIGIN, storage_state=self.fixture["states"]["ada"], viewport=DESKTOP, locale="en-GB", service_workers="block")
        bob, ada = bob_context.new_page(), ada_context.new_page()
        errors = []
        bob.on("pageerror", lambda error: errors.append(str(error)))
        steps = []

        def step(name):
            steps.append({"step": name})
            bob.wait_for_timeout(BEAT)
        # Ada is on the thread first; Bob's tracing starts when his page is ready, so the trace is the journey and not the sign-in.
        ada.goto(thread)
        expect(ada.locator("#thread-composer")).to_be_visible()
        bob.goto(project)
        bob.wait_for_selector(".top__views .ui-tabs__indicator[data-target], .views .ui-tabs__indicator[data-target], .phead__menu")
        bob.wait_for_timeout(1000)
        # DOM snapshots (the viewer redraws each action's before and after); the film is the video. Screenshots would be 8 MB.
        bob_context.tracing.start(screenshots=False, snapshots=True, sources=False)
        if phone:
            for view in ("Tasks", "Conversation"):
                bob.locator(".phead__menu").first.tap()
                menu = bob.locator(".phone-menu__list")
                menu.wait_for()
                bob.wait_for_timeout(BEAT)
                menu.get_by_role("link", name=re.compile(f"^{view}")).tap()
                step(f"phone title menu, {view}")
        else:
            tabs = bob.locator(".views, .top__views").first
            for view in ("tasks", "conversation"):
                tabs.locator(f'[data-tab="{view}"]').click()
                step(f"work tab, {view}")
            for index in (1, 2, 0):
                bob.locator(f'.side .side__project[data-glide-id="{self.fixture["projects"][index]}"]').click()
                step(f"project {index + 1} of 3")
        bob.goto(thread)
        expect(bob.locator(".typing-notice")).to_have_attribute("data-availability", "ready")
        step("thread opened")
        composer = ada.locator("#thread-composer")
        composer.click()
        composer.press_sequentially("Checking the reading before I answer", delay=60)
        expect(bob.locator(".typing-notice")).to_have_text(TYPING, timeout=3000)
        step("Ada types, Bob sees it")
        composer.blur()
        expect(bob.locator(".typing-notice")).not_to_have_text(TYPING, timeout=3000)
        step("Ada stops, the line goes")
        bob_context.tracing.stop(path=str(OUT / f"trace-{profile}.zip"))
        composer.fill("")
        self.assertEqual(errors, [], "no uncaught browser errors")
        video = bob.video
        bob_context.close()
        ada_context.close()
        video.save_as(str(OUT / f"{profile}.webm"))
        shutil.rmtree(film, ignore_errors=True)
        self.marks["profiles"][profile] = {"viewport": viewport, "touch": phone, "steps": [s["step"] for s in steps]}

    def test_desktop(self):
        self.record("desktop", DESKTOP, False)

    def test_phone(self):
        self.record("phone", PHONE, True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
