"""v0.2.2 phone polish (#1567, #1568), from the phone audit.

Runs with the other tests/ui journeys through scripts/check_ui.sh (`./scripts/check_ui.sh test_phone_polish`, Chromium by default,
`FLUX_UI_BROWSER=webkit` for WebKit). Ada owns a fresh company and has connected no AI; Jonas is a member who asked her a long question. Each
journey is the audit's own, on a phone with touch (390 and 360 wide, light and dark) and, where the rule is the same, on the computer:

- #1567: Home's First steps › Connect AI opens the window over Home; Cancel (and Escape, and a tap on the scrim) leaves Ada on Home with First
  steps as it was, the address has no `?connect=1`, and a reload never opens the window again. Settings › AI's own Connect AI button closes onto
  Settings › AI.
- #1568: a thread opened from an Inbox item starts at the top of the message the item is about; Quiet hours › Change and Muted spaces and
  messages › Change open into view above the tab bar; the thought chooser has no row of its own for Cancel and names Escape only with a keyboard;
  the "Task #N created" toast stands above the task's sheet and not across its top edge; Settings › Appearance has the same title row as the
  other Settings pages.

Screenshots (phone-polish-*-<browser>.png) go to FLUX_UI_SCREENSHOT_DIR when set.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot as save_shot, start_forwarder

PASSWORD = "phone polish for the v0.2.2 audit"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.polish+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.polish+{STAMP}@example.test"),
}
# A question long enough to run past a half sheet on a phone: its first lines are what the person came for.
QUESTION = ("@Ada Kowalska can you check the far-east bed reading? It looks off since Tuesday. "
            "https://example.org/a/very/long/path/that/keeps/going/and/going/without/any/spaces/sensor-readings-2026-11-20.csv")
TASK = "Order six probes"
THOUGHTS = ("Variant B: a sensor behind the shade", "Low light: below 10 lux the camera has to guess")
SMALL = {"width": 360, "height": 800}


def shot(page: Page, name: str) -> None:
    save_shot(page, f"phone-polish-{name}-{UI_BROWSER}")


class PhonePolish(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    contexts: dict[str, BrowserContext] = {}
    workspace = ""
    project = ""
    sketch = ""
    task = ""

    @classmethod
    def post(cls, who: str, path: str, body: dict | None = None) -> dict:
        response = cls.contexts[who].request.post(path, data=body or {}, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
        assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
        return response.json()

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.contexts[key] = context
        cls.workspace = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        cls.post("ada", f"/api/v1/workspaces/{cls.workspace}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        cls.project = cls.post("ada", f"/api/v1/workspaces/{cls.workspace}/projects", {"name": "Community garden sensors", "visibility": "workspace"})["id"]
        cls.sketch = cls.post("ada", f"/api/v1/workspaces/{cls.workspace}/sketches", {"title": "Where the sensors go", "scope": "project", "projectId": cls.project})["id"]
        for index, text in enumerate(THOUGHTS):
            cls.post("ada", f"/api/v1/sketches/{cls.sketch}/thoughts", {"text": text, "x": 60 + index * 360, "y": 80})
        cls.task = cls.post("ada", f"/api/v1/projects/{cls.project}/work", {"title": TASK})["id"]
        cls.post("jonas", f"/api/v1/projects/{cls.project}/conversations", {"body": QUESTION, "clientMessageId": str(uuid.uuid4())})
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()
        # The worker writes the question's notification shortly after the event.
        for _ in range(80):
            if cls.contexts["ada"].request.get("/api/v1/needs-you").json()["items"]:
                break
            time.sleep(0.25)

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool = True, dark: bool = False, small: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "storage_state": self.states["ada"], "service_workers": "block"}
        if phone:
            options.update(viewport=SMALL if small else PHONE, device_scale_factor=2, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    @staticmethod
    def press(control, phone: bool) -> None:
        control.tap() if phone else control.click()

    # ------------------------------------------------------------------ #1567

    def test_01_connect_ai_from_home_cancels_onto_home_and_a_reload_never_reopens_it(self) -> None:
        for phone, dark, small in ((True, True, False), (True, False, True), (False, False, False)):
            with self.subTest(phone=phone, dark=dark, small=small):
                page = self.page(phone=phone, dark=dark, small=small)
                page.goto("/")
                steps = page.locator("[data-first-steps]")
                expect(steps.get_by_role("heading", name="First steps")).to_be_visible()
                self.press(steps.get_by_role("link", name=re.compile("^Connect AI")), phone)
                window = page.get_by_role("dialog", name="Connect your AI")
                expect(window).to_be_visible()
                self.assertEqual(page.url, f"{ORIGIN}/", "the window opens over Home: the address does not change")
                width = "1440" if not phone else ("360" if small else "390")
                shot(page, f"1567-connect-from-home-{width}-{'dark' if dark else 'light'}")
                self.press(window.get_by_role("button", name="Cancel"), phone)
                expect(window).to_have_count(0)
                self.assertEqual(page.url, f"{ORIGIN}/", "Cancel leaves the person on Home, with no ?connect=1")
                expect(steps.get_by_role("heading", name="First steps")).to_be_visible()
                page.reload()
                expect(steps.get_by_role("heading", name="First steps")).to_be_visible()
                page.wait_for_timeout(600)
                expect(page.get_by_role("dialog", name="Connect your AI")).to_have_count(0)
                # Escape on the computer, a tap on the scrim on the phone: the other ways out end on Home too.
                self.press(steps.get_by_role("link", name=re.compile("^Connect AI")), phone)
                expect(page.get_by_role("dialog", name="Connect your AI")).to_be_visible()
                if phone:
                    page.touchscreen.tap(195, 40)
                else:
                    page.keyboard.press("Escape")
                expect(page.get_by_role("dialog", name="Connect your AI")).to_have_count(0)
                self.assertEqual(page.url, f"{ORIGIN}/")
                expect(steps.get_by_role("heading", name="First steps")).to_be_visible()

    def test_02_connect_ai_from_settings_closes_onto_settings(self) -> None:
        for phone in (True, False):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                page.goto("/settings/agents")
                self.press(page.get_by_role("button", name=re.compile("^Connect (AI|another)$")).first, phone)
                window = page.get_by_role("dialog", name="Connect your AI")
                expect(window).to_be_visible()
                self.press(window.get_by_role("button", name="Cancel"), phone)
                expect(window).to_have_count(0)
                self.assertEqual(page.url, f"{ORIGIN}/settings/agents")
                page.reload()
                page.wait_for_timeout(600)
                expect(page.get_by_role("dialog", name="Connect your AI")).to_have_count(0)

    # ------------------------------------------------------------------ #1568

    def test_03_a_thread_opened_from_an_inbox_item_starts_at_the_top_of_its_message(self) -> None:
        for dark, small in ((True, False), (False, True)):
            with self.subTest(dark=dark, small=small):
                page = self.page(dark=dark, small=small)
                page.goto("/inbox")
                row = page.locator(".nyc", has_text="far-east bed reading").first
                expect(row).to_be_visible()
                frame = row.locator(".nyc__card").bounding_box()
                page.touchscreen.tap(frame["x"] + 10, frame["y"] + frame["height"] / 2)
                expect(row).to_have_class(re.compile(r"\bis-selected\b"))
                row.get_by_role("button", name="Reply").tap()
                expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/conversations/[0-9a-f-]{36}#message-"))
                feed = page.locator(".thread__feed")
                expect(feed).to_be_visible()
                page.wait_for_timeout(900)  # the sheet has risen and the thread has opened
                placed = feed.evaluate("""el => {
                  const root = el.querySelector('.thread__root'), feed = el.getBoundingClientRect(), box = root.getBoundingClientRect();
                  return { scrollTop: el.scrollTop, rootTop: box.top, feedTop: feed.top, rootBottom: box.bottom, feedBottom: feed.bottom };
                }""")
                self.assertEqual(placed["scrollTop"], 0, "an unanswered thread opens at its top")
                self.assertGreaterEqual(placed["rootTop"], placed["feedTop"], "the first lines of the message are not under the sheet's head row")
                self.assertGreater(placed["rootBottom"], placed["feedBottom"], "the question is long enough that its end is the part that would have been shown")
                # The head row "‹ Inbox / Thread · 0 replies · Following ×": the count gives way first, "Thread" stays whole (it read "Threa" at 360).
                word = page.locator(".ui-panel__head .ui-panel__word")
                expect(word).to_have_text("Thread")
                fits = word.evaluate("el => el.scrollWidth <= el.clientWidth")
                self.assertTrue(fits, "the kind's word is not cut in the sheet's head row")
                shot(page, f"1568-thread-from-inbox-{'360' if small else '390'}-{'dark' if dark else 'light'}")

    def test_04_what_change_opens_in_quiet_hours_and_muted_places_is_in_view_above_the_tab_bar(self) -> None:
        for dark, small in ((True, False), (False, True)):
            with self.subTest(dark=dark, small=small):
                page = self.page(dark=dark, small=small)
                page.goto("/settings/notifications")
                expect(page.get_by_role("button", name="Change quiet hours")).to_be_visible()
                for name, panel, size in (("Change quiet hours", ".nset__panel:not(.nset__places)", "quiet"), ("Change muted places", ".nset__places", "muted")):
                    page.get_by_role("button", name=name).tap()
                    editor = page.locator(panel)
                    expect(editor).to_be_visible()
                    page.wait_for_timeout(500)
                    self.assertInView(page, editor)
                    shot(page, f"1568-{size}-change-{'360' if small else '390'}-{'dark' if dark else 'light'}")
                    page.get_by_role("button", name=name.replace("Change", "Close")).tap()
                # The times that appear with the switch are brought into view as well.
                page.get_by_role("button", name="Change quiet hours").tap()
                switch = page.get_by_role("switch", name="Use quiet hours")
                times = page.locator(".nset__times")
                if switch.is_checked():  # the other subtest left it on: start from off
                    switch.tap()
                    expect(times).to_have_count(0)
                switch.tap()
                expect(times).to_be_visible()
                page.wait_for_timeout(500)
                self.assertInView(page, times)
                switch.tap()  # and leave it off
                expect(times).to_have_count(0)

    def assertInView(self, page: Page, locator) -> None:
        """The element lies between the header and the tab bar (the capsule of places), not behind either."""
        box = locator.bounding_box()
        dock = page.locator(".phone-dock, .ui-bottomnav").first.bounding_box()
        header = page.locator("header").first.bounding_box()
        self.assertGreaterEqual(box["y"], header["y"] + header["height"] - 1, "not under the header")
        self.assertLessEqual(box["y"] + box["height"], dock["y"] + 1, f"not behind the tab bar: {box} {dock}")

    def test_05_the_thought_chooser_has_no_row_for_cancel_and_names_escape_only_with_a_keyboard(self) -> None:
        for phone, dark, small in ((True, True, False), (True, False, True), (False, False, False)):
            with self.subTest(phone=phone, dark=dark, small=small):
                page = self.page(phone=phone, dark=dark, small=small)
                page.goto(f"/projects/{self.project}/tasks?open=work:{self.task}")
                card = page.locator(f".wd[data-detail-kind='work'][data-detail-id='{self.task}']")
                expect(card).to_be_visible()
                self.press(card.get_by_role("button", name="Add to a thought"), phone)
                picker = card.get_by_role("group", name=re.compile("^Thoughts to link to "))
                expect(picker).to_be_visible()
                page.wait_for_timeout(500)
                head = picker.locator(".wd-pick__head")
                expect(head.get_by_text("Map", exact=True)).to_be_visible()
                cancel = head.get_by_role("button", name="Cancel")
                expect(cancel).to_be_visible()
                label_box, cancel_box, head_box = head.get_by_text("Map", exact=True).bounding_box(), cancel.bounding_box(), head.bounding_box()
                self.assertLessEqual(abs((label_box["y"] + label_box["height"] / 2) - (cancel_box["y"] + cancel_box["height"] / 2)), 2, "Map and Cancel share one row")
                self.assertLessEqual(head_box["height"], cancel_box["height"] + 1, "the row is as tall as Cancel: there is no empty row around it")
                hint = picker.locator(".wd-pick__keys")
                if phone:
                    expect(hint).to_have_text("Choose a thought to link it.")
                    expect(hint).not_to_contain_text("Escape")
                else:
                    expect(hint).to_contain_text("Escape")
                shot(page, f"1568-thought-chooser-{'1440' if not phone else ('360' if small else '390')}-{'dark' if dark else 'light'}")
                self.press(cancel, phone)
                expect(picker).to_have_count(0)

    def test_06_the_task_created_toast_stands_above_the_tasks_sheet(self) -> None:
        for dark, small in ((True, False), (False, True)):
            with self.subTest(dark=dark, small=small):
                page = self.page(dark=dark, small=small)
                page.goto(f"/projects/{self.project}/tasks")
                expect(page.get_by_text(TASK).first).to_be_visible()
                page.get_by_role("button", name="Create", exact=True).tap()
                window = page.get_by_role("dialog", name=re.compile("^(New task|Create)"))
                expect(window).to_be_visible()
                window.get_by_label(re.compile("^Title")).fill(f"Calibrate the far-east moisture probe against a dry-soil sample {'dark' if dark else 'light'}")
                window.get_by_role("button", name=re.compile("^Create task")).tap()
                toast = page.locator(".ui-toast", has_text="created")
                expect(toast).to_be_visible()
                sheet = page.locator(".ui-detent-sheet")
                expect(sheet).to_be_visible()
                page.wait_for_timeout(1500)  # the sheet has risen; the toast is placed where it rests
                gap = sheet.evaluate("(el, ) => el.getBoundingClientRect().top") - toast.evaluate("el => el.getBoundingClientRect().bottom")
                self.assertGreaterEqual(gap, 4, f"the toast stands above the sheet's top edge, not across it (gap {gap})")
                shot(page, f"1568-toast-over-task-sheet-{'360' if small else '390'}-{'dark' if dark else 'light'}")

    def test_07_appearance_has_the_title_row_of_the_other_settings_pages(self) -> None:
        for dark, small in ((False, False), (True, True)):
            with self.subTest(dark=dark, small=small):
                page = self.page(dark=dark, small=small)
                tops = {}
                for path, title in (("/settings/account", "Account"), ("/settings/appearance", "Appearance")):
                    page.goto(path)
                    heading = page.locator(".sset-head").get_by_role("heading", level=2, name=title, exact=True)
                    expect(heading).to_be_visible()
                    tops[title] = heading.bounding_box()["y"]
                    if title == "Appearance":
                        expect(page.get_by_role("heading", level=2, name="This phone", exact=True)).to_be_visible()
                        shot(page, f"1568-appearance-{'360' if small else '390'}-{'dark' if dark else 'light'}")
                self.assertLessEqual(abs(tops["Account"] - tops["Appearance"]), 1, "the title row sits in the same place on every Settings page")


if __name__ == "__main__":
    unittest.main()
