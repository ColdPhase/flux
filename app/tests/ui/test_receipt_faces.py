"""Browser tests for the line under a message: the time and the faces of who read it (#1231).

Ada, Kai and Lee share a company and a space. Ada's own groups of messages are read by different people:

- group A by Kai and Lee, who are real people with real sessions (the faces, the accessible name, the list on hover and on tap);
- group B by 500 people who all read it (3 faces and "+497" in one fixed-height row at 1440 and 390 px; the list shows 20 names and
  pages on scroll; opening the conversation asks for no list of all 500);
- group C by nobody (the time alone, the same row height).

The 500 are real sign-ups made over HTTP before the browser tests start, then members of the company, then readers of B. The last test
makes 40 of them read a new message at once while Ada's tab is open and counts the requests that tab makes. Screenshots (receipt-*.png)
go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.cookiejar import CookieJar

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "a long passphrase for the crowd"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.f+{STAMP}@example.test"),
    "kai": ("Kai Tanaka", f"kai.f+{STAMP}@example.test"),
    "lee": ("Lee Moreno", f"lee.f+{STAMP}@example.test"),
}
CROWD = 500
BURST = 40
THREADS = 8


def call(opener, method: str, path: str, body: dict | None = None, cookie: str | None = None) -> tuple[int, dict]:
    headers = {"content-type": "application/json", "origin": ORIGIN}
    if cookie:
        headers["cookie"] = cookie
    request = urllib.request.Request(ORIGIN + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
    try:
        with opener.open(request, timeout=90) as response:
            text = response.read().decode()
            return response.status, json.loads(text) if text else {}
    except urllib.error.HTTPError as error:
        return error.code, {"error": error.read().decode()[:300]}


class ReceiptFaces(unittest.TestCase):
    """Tests run in name order and share the people, the space and the crowd."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    project_id = ""
    a = ""  # the last message of Ada's group A (read by Kai and Lee)
    b = ""  # the last message of Ada's group B (read by the crowd)
    c = ""  # the last message of Ada's group C (read by nobody)
    crowd: list = []

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        cls.workspace_id = cls.post("ada", "/api/v1/workspaces", {"name": "Hundreds of us"}, 201)["id"]
        for key in ("kai", "lee"):
            cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE[key][1], "role": "member"}, 201)
        cls.project_id = cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Everyone", "visibility": "workspace"}, 201)["id"]

        def say(who: str, body: str) -> str:
            made = cls.post(who, f"/api/v1/projects/{cls.project_id}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)
            return made["messages"][0]["id"]

        # Three groups of Ada's, apart because Kai writes between them.
        cls.a = say("ada", "The sensor boards arrive on Thursday.")
        say("kai", "Good, I will clear the second drawer.")
        cls.b = say("ada", "The plan for next week is in the Wiki: please read it before Monday.")
        say("kai", "Read it, looks right to me.")
        cls.c = say("ada", "Friday we calibrate the probes.")
        for who in ("kai", "lee"):
            cls.post(who, f"/api/v1/projects/{cls.project_id}/observations", {"messageIds": [cls.a]}, 200)
        cls.make_crowd()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def post(cls, who: str, path: str, body: dict, expected: int) -> dict:
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states[who])
        try:
            response = context.request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status == expected, f"{path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}
        finally:
            context.close()

    @classmethod
    def make_crowd(cls) -> None:
        """500 people: each signs up, is added to the company by Ada and reads group B. Over HTTP, a few at a time."""
        host = ORIGIN.split("//", 1)[1].split(":")[0]
        ada_cookie = "; ".join(f"{c['name']}={c['value']}" for c in cls.states["ada"]["cookies"] if host in c["domain"])
        plain = urllib.request.build_opener()

        def join(index: int):
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
            email = f"reader{index}.{STAMP}@example.test"
            status, _ = call(opener, "POST", "/api/auth/sign-up/email", {"email": email, "password": PASSWORD, "name": f"Reader{index:03d} Crowd"})
            assert status == 200, f"sign-up {index}: {status}"
            status, _ = call(plain, "POST", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": email, "role": "member"}, ada_cookie)
            assert status == 201, f"add {index}: {status}"
            status, _ = call(opener, "POST", f"/api/v1/projects/{cls.project_id}/observations", {"messageIds": [cls.b]})
            assert status == 200, f"read {index}: {status}"
            return opener

        with ThreadPoolExecutor(THREADS) as pool:
            cls.crowd = list(pool.map(join, range(1, CROWD + 1)))

    def context(self, who: str, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def open_space(self, who: str = "ada", **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.project_id}")
        expect(page.locator(f"#message-{self.c} .message-time")).to_be_visible()
        return page

    @staticmethod
    def requests(page: Page) -> list[tuple[str, str]]:
        seen: list[tuple[str, str]] = []
        page.on("request", lambda request: seen.append((request.method, request.url)))
        return seen

    @staticmethod
    def count(seen: list[tuple[str, str]], tail: str) -> int:
        return sum(1 for method, url in seen if method == "POST" and url.split("?")[0].endswith(tail))

    def footer(self, page: Page, message_id: str):
        return page.locator(f"#message-{message_id} .message-time")

    # ------------------------------------------------------------------ the faces of people

    def test_01_the_time_is_in_the_interface_font_and_a_reader_is_a_face_with_a_screen_reader_name(self) -> None:
        page = self.open_space()
        line = self.footer(page, self.a)
        # No "Seen by" text on screen: the faces carry it, as the name of one button.
        faces = line.get_by_role("button", name="Seen by Lee and Kai")
        expect(faces).to_be_visible()
        self.assertNotIn("Seen", line.inner_text(), "no text such as 'Seen by' is drawn")
        self.assertEqual(faces.locator(".ui-avatar--xs").count(), 2, "one face for each of the two readers")
        self.assertEqual(faces.locator(".seen__more").count(), 0)
        # The time: Geist (the interface font), no monospace, no wide spacing.
        style = line.locator("time").evaluate("""el => { const s = getComputedStyle(el); const root = getComputedStyle(document.documentElement);
          return {family: s.fontFamily, body: getComputedStyle(document.body).fontFamily, mono: root.getPropertyValue('--mono').trim(), spacing: s.letterSpacing, size: s.fontSize, numeric: s.fontVariantNumeric}; }""")
        self.assertEqual(style["family"], style["body"], "the time uses the interface font")
        self.assertNotIn("Mono", style["family"])
        self.assertNotIn("tabular-nums", style["numeric"], "the figures are the interface font's own, not the global tabular ones")
        self.assertIn(style["spacing"], ("normal", "0px"))
        self.assertRegex(line.locator("time").inner_text(), r"\d{1,2}:\d{2}")
        # One face size, one row.
        box = faces.bounding_box()
        assert box
        self.assertAlmostEqual(box["height"], 16, delta=0.5)
        for face in faces.locator(".ui-avatar--xs").all():
            face_box = face.bounding_box()
            assert face_box
            self.assertAlmostEqual(face_box["width"], 16, delta=0.5)
        shot(page, "receipt-faces-desktop-light")

    def test_02_hovering_the_faces_lists_names_and_times_and_escape_closes_with_focus_back(self) -> None:
        page = self.open_space()
        faces = self.footer(page, self.a).get_by_role("button", name=re.compile(r"^Seen by"))
        faces.hover()
        list_ = page.get_by_role("dialog", name="Seen by")
        expect(list_).to_be_visible()
        rows = list_.locator(".seen-list__row")
        expect(rows).to_have_count(2)
        # Newest reader first, each with the time they read it.
        self.assertEqual([row.locator(".seen-list__name").inner_text() for row in rows.all()], ["Lee Moreno", "Kai Tanaka"])
        for row in rows.all():
            self.assertRegex(row.locator(".seen-list__at").inner_text(), r"\d{1,2}:\d{2}")
            self.assertNotIn("tabular-nums", row.locator(".seen-list__at").evaluate("el => getComputedStyle(el).fontVariantNumeric"), "a time in the list uses the interface font's own figures")
        self.assertEqual(list_.locator(".seen-list__more").count(), 0, "two people are the whole list: nothing more to load")
        shot(page, "receipt-list-desktop-light")
        # Clicking keeps it open when the pointer leaves; Escape closes it and focus is back on the faces.
        faces.click()
        page.mouse.move(5, 5)
        page.wait_for_timeout(600)
        expect(list_).to_be_visible()
        page.keyboard.press("Escape")
        expect(list_).to_have_count(0)
        expect(faces).to_be_focused()
        # The keyboard opens it too, and the list takes the focus so the arrow keys scroll it.
        page.keyboard.press("Enter")
        expect(list_).to_be_visible()
        expect(list_.locator(".seen-list__scroll")).to_be_focused()
        page.keyboard.press("Escape")
        expect(faces).to_be_focused()

    def test_03_on_the_phone_a_tap_opens_the_list_and_a_tap_outside_closes_it(self) -> None:
        page = self.open_space(phone=True, dark=True)
        faces = self.footer(page, self.a).get_by_role("button", name=re.compile(r"^Seen by"))
        box = faces.bounding_box()
        assert box
        self.assertAlmostEqual(box["height"], 16, delta=0.5)
        faces.tap()
        list_ = page.get_by_role("dialog", name="Seen by")
        expect(list_).to_be_visible()
        inside = list_.bounding_box()
        assert inside
        self.assertGreaterEqual(inside["x"], 0)
        self.assertLessEqual(inside["x"] + inside["width"], PHONE["width"])
        self.assertGreaterEqual(inside["y"], 0)
        self.assertGreaterEqual(list_.locator(".seen-list__row").first.bounding_box()["height"], 43.5, "a row is a touch target")
        shot(page, "receipt-list-phone-dark")
        page.touchscreen.tap(PHONE["width"] // 2, 40)
        expect(list_).to_have_count(0)

    # ------------------------------------------------------------------ 500 readers

    def test_04_500_readers_are_three_faces_and_a_count_in_the_same_row_at_both_widths(self) -> None:
        for label, kwargs, width in (("desktop", {}, DESKTOP["width"]), ("phone", {"phone": True}, PHONE["width"])):
            for dark in (False, True):
                with self.subTest(label=label, dark=dark):
                    page = self.page("ada", dark=dark, **kwargs)
                    seen = self.requests(page)
                    page.goto(f"/projects/{self.project_id}")
                    big = self.footer(page, self.b).get_by_role("button", name=re.compile(r"^Seen by"))
                    expect(big).to_be_visible()
                    expect(big.locator(".seen__more")).to_have_text(f"+{CROWD - 3}")
                    self.assertEqual(big.locator(".ui-avatar--xs").count(), 3)
                    self.assertRegex(big.get_attribute("aria-label") or "", rf"^Seen by Reader\d+, Reader\d+, Reader\d+ and {CROWD - 3} others$")
                    box = big.bounding_box()
                    assert box
                    self.assertAlmostEqual(box["height"], 16, delta=0.5, msg="the row is 16 px high however many have read")
                    self.assertLess(box["width"], 100, "and never wider than 3 faces and one count")
                    # The same line height with two faces, with 500 and with none; the faces never push the time or the page sideways.
                    heights = [self.footer(page, message).bounding_box()["height"] for message in (self.a, self.b, self.c)]
                    self.assertLessEqual(max(heights) - min(heights), 0.5, f"one footer height: {heights}")
                    self.assertEqual(self.footer(page, self.c).locator(".seen").count(), 0, "a group nobody read shows its time alone")
                    self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0)
                    right = box["x"] + box["width"]
                    self.assertLessEqual(right, width + 0.5, "inside the screen")
                    # Opening the conversation asked for the receipts once and for no list: not one request for all 500.
                    self.assertGreaterEqual(self.count(seen, "/receipts"), 1)
                    self.assertEqual(self.count(seen, "/receipts/readers"), 0, "the list is read only when it is opened")
                    shot(page, f"receipt-crowd-{label}-{'dark' if dark else 'light'}")

    def test_05_the_list_of_500_shows_20_names_then_pages_on_scroll(self) -> None:
        page = self.open_space()
        seen = self.requests(page)
        faces = self.footer(page, self.b).get_by_role("button", name=re.compile(r"^Seen by"))
        faces.click()
        list_ = page.get_by_role("dialog", name="Seen by")
        rows = list_.locator(".seen-list__row")
        expect(rows).to_have_count(20)
        expect(list_.locator(".seen-list__more")).to_have_text(f"and {CROWD - 20} others")
        self.assertEqual(self.count(seen, "/receipts/readers"), 1, "one page for the first 20")
        names = [row.locator(".seen-list__name").inner_text() for row in rows.all()]
        self.assertEqual(len(set(names)), 20)
        shot(page, "receipt-list-crowd-desktop-light")
        # The list is scrollable inside the popover; its end is the trigger for the next page.
        list_.locator(".seen-list__scroll").evaluate("el => { el.scrollTop = el.scrollHeight; }")
        expect(rows).to_have_count(40)
        expect(list_.locator(".seen-list__more")).to_have_text(f"and {CROWD - 40} others")
        self.assertEqual(self.count(seen, "/receipts/readers"), 2)
        names = [row.locator(".seen-list__name").inner_text() for row in rows.all()]
        self.assertEqual(len(set(names)), 40, "no reader twice across pages")
        # The popover stays inside the screen and does not outgrow it.
        box = list_.bounding_box()
        assert box
        self.assertGreaterEqual(box["y"], 0)
        self.assertLessEqual(box["y"] + box["height"], DESKTOP["height"])
        page.keyboard.press("Escape")
        expect(list_).to_have_count(0)

    def test_06_no_look_every_few_seconds_while_the_stream_is_up(self) -> None:
        page = self.open_space()
        seen = self.requests(page)
        page.wait_for_timeout(2500)
        before = self.count(seen, "/receipts")
        page.wait_for_timeout(11000)
        self.assertEqual(self.count(seen, "/receipts"), before, "receipts are told by the stream, not asked for on a timer")

    def test_07_forty_people_reading_at_once_make_a_few_looks_not_forty(self) -> None:
        page = self.open_space()
        # Ada writes two more lines; the page shows them, and the first look for them is the page's own.
        d = self.post("ada", f"/api/v1/projects/{self.project_id}/conversations", {"body": "Last one: the probes arrive on Friday.", "clientMessageId": str(uuid.uuid4())}, 201)["messages"][0]["id"]
        expect(page.locator(f"#message-{d}")).to_be_visible()
        page.wait_for_timeout(3000)
        seen = self.requests(page)
        group = [self.c, d]

        def read(opener):
            status, _ = call(opener, "POST", f"/api/v1/projects/{self.project_id}/observations", {"messageIds": group})
            return status

        with ThreadPoolExecutor(THREADS) as pool:
            self.assertEqual(set(pool.map(read, self.crowd[:BURST])), {200})
        faces = self.footer(page, d).get_by_role("button", name=re.compile(r"^Seen by"))
        expect(faces.locator(".seen__more")).to_have_text(f"+{BURST - 3}", timeout=20000)
        page.wait_for_timeout(3000)
        looks = self.count(seen, "/receipts")
        self.assertLessEqual(looks, 5, f"{BURST} readers made {looks} looks")
        # They read the newer group now, so group B lost them and the faces moved down the conversation: each person once.
        expect(self.footer(page, self.b).locator(".seen__more")).to_have_text(f"+{CROWD - BURST - 3}")


if __name__ == "__main__":
    unittest.main()
