"""The release-gate fixes of the full UI audit (#1424): the sidebar's small controls are the 32 px control token (a finger gets 44), the
32 px face's initials are a type token on the phone, and a task or decision opened by address on a phone, while its reads fail, shows the one
error of its sheet with a working Try again (the place beneath it does not say it again under the scrim).
Runs through scripts/check_ui.sh against the running app, on the engine named by FLUX_UI_BROWSER (chromium or webkit).
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder

PASSWORD = "small controls and one error"
STAMP = int(time.time() * 1000)
EMAIL = f"ada.gate+{STAMP}@example.test"
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


# What the audit's deep links read: the place's own read (the route's space-shell, the board's or the conversation's) and the sheet's.
TASK_READS = re.compile(r".*/api/v1/projects/[^/]+/(work-objects/work/[^/?]+|work-view|work-relations|space-shell)(\?.*)?$")
DECISION_READS = re.compile(r".*/api/v1/projects/[^/]+/(work-objects/decision/[^/?]+|conversation-view|work-relations|space-shell)(\?.*)?$")


def sized(locator) -> tuple[float, float]:
    box = locator.bounding_box()
    assert box, "rendered"
    return round(box["width"], 1), round(box["height"], 1)


class ReleaseGateUi(unittest.TestCase):
    browser: Browser
    state: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, phone: bool = False, width: int | None = None) -> Page:
        options = dict(viewport={**PHONE, "width": width or PHONE["width"]}, device_scale_factor=2, is_mobile=True, has_touch=True) if phone else dict(viewport=DESKTOP)
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", reduced_motion="reduce", storage_state=self.state["storage"], **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 200) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def world(self) -> None:
        if self.state:
            return
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block")
        self.addCleanup(context.close)
        response = context.request.post("/api/auth/sign-up/email", data={"email": EMAIL, "password": PASSWORD, "name": "Ada Kowalska"}, headers={"origin": ORIGIN})
        self.assertEqual(response.status, 200, response.text())
        type(self).state["storage"] = context.storage_state()
        page = self.page()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Gate makers"}, status=201)["id"]
        space = self.api(page, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Gate plans", "visibility": "restricted"}, status=201)["id"]
        task = self.api(page, "POST", f"/api/v1/projects/{space}/work", {"title": "Check the gate hinges"}, status=201)["id"]
        decision = self.api(page, "POST", f"/api/v1/projects/{space}/decisions", {"title": "Use steel hinges", "rationale": "They last"}, status=201)["id"]
        type(self).state.update(space=space, task=task, decision=decision)

    # ---------------------------------------------------------------- #1424 point 5: the sidebar's small controls

    def test_01_the_sidebars_icon_buttons_are_the_control_token_and_the_profile_row_is_one_row(self) -> None:
        self.world()
        page = self.page()
        page.goto("/")
        sidebar = page.get_by_role("complementary", name="Sidebar")
        expect(sidebar).to_be_visible()
        ctl = page.evaluate("() => { const p = document.createElement('i'); p.style.cssText = 'display:block;height:var(--ctl)'; document.body.append(p); const h = p.getBoundingClientRect().height; p.remove(); return h; }")
        self.assertEqual(ctl, 32, "--ctl is 32 px with a mouse")
        more = sidebar.get_by_role("button", name="More for Spaces", exact=True)
        add = sidebar.get_by_role("link", name="New message", exact=True)
        expect(more).to_be_visible()
        expect(add).to_be_visible()
        self.assertEqual(sized(more), (32, 32), "More for Spaces is the 32 px icon button")
        self.assertEqual(sized(add), (32, 32), "New message is the 32 px icon button")
        # The bigger target does not push its heading row apart: 16 px of padding and the button's 24 px of room, as with the 24 px button.
        head = sidebar.locator(".side__head").first.bounding_box()
        assert head
        self.assertAlmostEqual(head["height"], 40, delta=0.6, msg="the heading row is as tall as before")
        self.assertEqual(sized(sidebar.locator(".me__btn"))[1], 32, "your name at the bottom is one 32 px row")

    def test_02_on_a_touch_screen_the_same_controls_are_44_px_targets(self) -> None:
        self.world()
        page = self.page(phone=True, width=660)  # 641-680 px: not a phone, and the sidebar is its drawer
        page.goto("/")
        page.get_by_role("button", name="Open navigation").tap()
        drawer = page.get_by_role("dialog")
        expect(drawer).to_be_visible()
        page.wait_for_timeout(400)
        for target in (drawer.get_by_role("button", name="More for Spaces", exact=True), drawer.get_by_role("link", name="New message", exact=True), drawer.locator(".me__btn")):
            expect(target).to_be_visible()
            width, height = sized(target)
            self.assertGreaterEqual(min(width, height), 43.9, f"a 44 px target: {width}x{height}")

    # ---------------------------------------------------------------- #1424 point 6: the 32 px face's initials

    def test_03_the_32px_faces_initials_are_a_type_token_on_the_phone_and_stay_in_their_circle(self) -> None:
        self.world()
        for phone, width, expected in ((False, None, 12), (True, 412, 12.5)):
            with self.subTest(phone=phone):
                page = self.page(phone=phone, width=width)
                page.goto("/")
                measured = page.evaluate("""() => {
                  const face = document.createElement('span'); face.className = 'ui-avatar ui-avatar--lg'; face.textContent = 'MW'; document.body.append(face);
                  const token = (name) => { const p = document.createElement('i'); p.style.fontSize = `var(${name})`; document.body.append(p); const v = parseFloat(getComputedStyle(p).fontSize); p.remove(); return v; };
                  const result = { size: parseFloat(getComputedStyle(face).fontSize), tokens: ['--fs-glyph', '--fs-xs', '--fs-sm', '--fs-md', '--fs-base', '--fs-lg', '--fs-xl'].map(token),
                    inside: face.scrollWidth <= face.clientWidth, circle: face.getBoundingClientRect().width };
                  face.remove(); return result; }""")
                self.assertEqual(measured["size"], expected)
                self.assertIn(measured["size"], measured["tokens"] + [12], "a --fs token (12 px on a computer is --fs-xs)")
                self.assertTrue(measured["inside"], "two capitals stay inside the 32 px circle")
                self.assertEqual(measured["circle"], 32)

    # ---------------------------------------------------------------- #1424 point 4: one error on a phone's sheet

    def open_failing(self, page: Page, path: str, failing: re.Pattern, state: dict) -> None:
        page.route(failing, lambda route: route.fulfill(status=503, json={"error": {"code": "UNAVAILABLE", "message": "Service unavailable"}})
                   if state["on"] and route.request.method == "GET" else route.continue_())
        page.goto(path)

    def check_one_error(self, key: str, path: str, failing: re.Pattern, place_error: str, chip: str) -> None:
        self.world()
        page = self.page(phone=True)
        state = {"on": True}
        self.open_failing(page, path.format(**self.state), failing, state)
        sheet = page.get_by_role("dialog", name=re.compile("Details|Task|Decision"))
        expect(sheet.get_by_role("heading", name="The details couldn’t be loaded")).to_be_visible()
        # One error block and one Try again: the sheet's. The place beneath it (inert, under the scrim) does not say its own.
        expect(page.get_by_role("button", name="Try again")).to_have_count(1)
        expect(page.get_by_role("heading", name=place_error)).to_have_count(0)
        expect(page.get_by_text(place_error)).to_be_hidden()
        self.assertEqual(sheet.get_by_role("button", name="Try again").count(), 1)
        # It works with a finger: the reads come back, the sheet shows the object.
        state["on"] = False
        sheet.get_by_role("button", name="Try again").tap()
        expect(sheet.get_by_text(chip, exact=True).first).to_be_visible()
        expect(page.get_by_text("The details couldn’t be loaded")).to_have_count(0)

    def test_04_a_task_opened_by_address_with_failing_reads_shows_the_sheets_error_once(self) -> None:
        self.check_one_error("task", "/projects/{space}/tasks?view=board&open=work:{task}",
                             TASK_READS, "Tasks couldn’t be loaded", "Check the gate hinges")

    def test_05_a_decision_opened_by_address_with_failing_reads_shows_the_sheets_error_once(self) -> None:
        self.check_one_error("decision", "/projects/{space}?open=decision:{decision}",
                             DECISION_READS, "The conversation couldn’t be loaded", "Use steel hinges")

    def test_06_the_place_says_its_own_error_again_once_the_sheet_is_closed(self) -> None:
        self.world()
        for kind, path, reads, error in (
            ("task", "/projects/{space}/tasks?view=board&open=work:{task}", TASK_READS, "Tasks couldn’t be loaded"),
            ("decision", "/projects/{space}?open=decision:{decision}", DECISION_READS, "The conversation couldn’t be loaded"),
        ):
            with self.subTest(kind):
                page = self.page(phone=True)
                state = {"on": True}
                self.open_failing(page, path.format(**self.state), reads, state)
                sheet = page.get_by_role("dialog", name=re.compile("Details|Task|Decision"))
                expect(sheet.get_by_role("heading", name="The details couldn’t be loaded")).to_be_visible()
                expect(page.get_by_role("heading", name=error)).to_have_count(0)
                sheet.get_by_role("button", name=re.compile("^Close")).tap()
                expect(page.get_by_role("dialog")).to_have_count(0)
                expect(page.get_by_role("heading", name=error)).to_be_visible()
                expect(page.get_by_role("button", name="Try again")).to_have_count(1)

if __name__ == "__main__":
    unittest.main()
