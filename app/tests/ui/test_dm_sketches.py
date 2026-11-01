"""Browser tests for sketches bound to a direct message (issue #96).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose
application. Ada owns the workspace, Jo is an admin, Kai and Mo are members. Jo and Kai talk in a
1:1 DM. Jo selects two of its messages and starts a sketch from them; Kai opens it from the DM's
Sketches tab; Mo (outside the DM) cannot; the phone layout keeps the selection bar usable; Jo
makes a project from the sketch after an exact audience preview, and later DM messages do not
reach the copy; when Kai leaves, Kai loses the sketch at once and Jo's becomes read-only. Every
step is checked against the API. Screenshots (dm-sketch-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, box, shot, start_forwarder

PASSWORD = "sketching in private"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Nowak", f"ada.n+{STAMP}@example.test", None),
    "jo": ("Jo Lindqvist", f"jo.l+{STAMP}@example.test", "admin"),
    "kai": ("Kai Lind", f"kai.l+{STAMP}@example.test", "member"),
    "mo": ("Mo Haddad", f"mo.h+{STAMP}@example.test", "member"),
}
MESSAGES = [
    ("kai", "Weekend idea: a desk lamp you control with gestures. Swipe to dim, hold your palm over it to switch it off."),
    ("jo", "Love it. Camera and hand tracking? A tiny OpenMV board could run that."),
    ("kai", "A camera worries me for a bedside lamp. Maybe a ToF distance sensor?"),
    ("jo", "Unrelated: are you coming to Mira's on Saturday?"),
]


SELECTION_PEOPLE = {
    "ada": ("Ada Nowak", f"sel.ada+{STAMP}@example.test", None),
    "jo": ("Jo Lindqvist", f"sel.jo+{STAMP}@example.test", "admin"),
    "kai": ("Kai Lind", f"sel.kai+{STAMP}@example.test", "member"),
}
# A run from each person, a long message, a message with replies and own ones with and without a run, after fillers to scroll.
SELECTION_MESSAGES = [
    ("kai", "Weekend idea: a desk lamp you control with gestures. Swipe to dim, hold your palm over it to switch it off."),
    ("kai", "I sketched the housing already."),
    ("jo", "Love it. Camera and hand tracking? A tiny OpenMV board could run that and it fits the base."),
    ("jo", "A tiny OpenMV board."),
    ("kai", "A camera worries me for a bedside lamp. Maybe a ToF distance sensor? " * 4),
    ("jo", "OK."),
    ("kai", "Thanks!"),
]
SELECTION_FILLERS = 24


class DmSelectionMode(unittest.TestCase):
    """#594: choosing messages keeps every message where it is and looks like one calm mode, on both sides' screens."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    dm_id = ""
    ids: list[str] = []

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=10000)
        contexts: dict[str, BrowserContext] = {}
        people: dict[str, str] = {}
        for key, (name, email, _) in SELECTION_PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            people[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def post(who: str, path: str, body: dict):
            response = contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), response.text()
            return response.json()

        workspace_id = post("ada", "/api/v1/workspaces", {"name": "Lamp selection"})["id"]
        for key, (_, email, role) in SELECTION_PEOPLE.items():
            if role:
                post("ada", f"/api/v1/workspaces/{workspace_id}/members", {"email": email, "role": role})
        cls.dm_id = post("jo", f"/api/v1/workspaces/{workspace_id}/dms", {"participantIds": [people["kai"]]})["id"]

        def say(who: str, body: str) -> str:
            return post(who, f"/api/v1/dms/{cls.dm_id}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})["id"]

        for index in range(SELECTION_FILLERS):
            say("kai" if index % 3 else "jo", f"Parts note {index + 1}: the sensor board is in the second drawer.")
        cls.ids = [say(who, body) for who, body in SELECTION_MESSAGES]
        post("jo", f"/api/v1/dms/{cls.dm_id}/threads/{cls.ids[4]}/replies", {"body": "Let us try the ToF sensor.", "clientMessageId": str(uuid.uuid4())})
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def open(self, who: str, width: int, height: int, *, dark: bool = False, reduced: bool = False) -> Page:
        phone = width <= 480
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who],
                         "color_scheme": "dark" if dark else "light", "reduced_motion": "reduce" if reduced else "no-preference"}
        if phone:
            options.update(viewport={"width": width, "height": height}, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport={"width": width, "height": height}, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        page.goto(f"/dm/{self.dm_id}")
        expect(page.locator(f'.dm-msg[data-message-id="{self.ids[-1]}"]')).to_be_visible()
        page.wait_for_timeout(300)
        return page

    def choose(self, page: Page) -> None:
        phone = page.viewport_size["width"] <= 480
        button = page.get_by_role("button", name="Choose messages", exact=True)
        button.tap() if phone else button.click()
        expect(page.get_by_role("region", name="Selected messages")).to_be_visible()
        page.evaluate("Promise.all(document.getAnimations().map((a) => a.finished))")

    def message(self, page: Page, index: int):
        return page.locator(f'.dm-msg[data-message-id="{self.ids[index]}"]')

    PLACES = """() => Object.fromEntries([...document.querySelectorAll('.dm-msg[data-message-id]')].map((li) => {
      const bubble = li.querySelector('.message-bubble').getBoundingClientRect();
      return [li.dataset.messageId, {left: bubble.left, right: bubble.right, top: bubble.top, own: li.classList.contains('is-mine')}];
    }))"""

    COLUMN = """() => { const list = document.querySelector('.dm__list').getBoundingClientRect(), row = document.querySelector('.dm-msg__row').getBoundingClientRect();
      return {list: list.width, gutter: list.width + 2 * 8}; }"""

    def test_01_every_message_keeps_its_place_in_the_selection_mode(self) -> None:
        for width, height in ((1440, 900), (1920, 1080), (2560, 1440), (390, 844)):
            for who in ("jo", "kai"):
                with self.subTest(width=width, who=who):
                    page = self.open(who, width, height)
                    before = page.evaluate(self.PLACES)
                    column = page.evaluate(self.COLUMN)
                    self.choose(page)
                    after = page.evaluate(self.PLACES)
                    chosen = page.evaluate(self.COLUMN)
                    print(f"COLUMN {width}px {who}: messages {column['list']:.0f}px, with the gutter {column['gutter']:.0f}px; in selection {chosen['list']:.0f}px / {chosen['gutter']:.0f}px", flush=True)
                    self.assertAlmostEqual(chosen["list"], column["list"], delta=0.5, msg="selection does not widen the message column")
                    self.assertEqual(before.keys(), after.keys())
                    check = 44 if width <= 480 else 32
                    for key, was in before.items():
                        now = after[key]
                        if was["own"]:
                            # Mine stay on the right edge of the same column, exactly where they were.
                            self.assertAlmostEqual(now["right"], was["right"], delta=0.5, msg=f"{key}: an own bubble keeps its right edge")
                        else:
                            self.assertAlmostEqual(now["left"], was["left"], delta=1, msg=f"{key}: another person's bubble keeps its left edge")
                        self.assertLessEqual(abs(now["left"] - was["left"]), check + 12, f"{key}: no bubble moves by more than the check column")
                        if width > 480:
                            # On a phone a long own message wraps once more beside its check (allowed by AC-1); there the
                            # reading position test below holds the message the person is on.
                            self.assertAlmostEqual(now["top"], was["top"], delta=1, msg=f"{key}: nothing moves up or down")
                    lefts = {round(v["left"]) for k, v in after.items() if not v["own"]}
                    self.assertEqual(len(lefts), 1, "other people's bubbles share one left edge")
                    page.context.close()

    ROWS = """(ids) => ids.map((id) => {
      const li = document.querySelector(`.dm-msg[data-message-id="${id}"]`), row = li.querySelector('.dm-msg__row');
      const r = row.getBoundingClientRect(), fillStyle = getComputedStyle(row, '::before'), list = document.querySelector('.dm__list').getBoundingClientRect();
      const left = r.left + parseFloat(fillStyle.left), top = r.top + parseFloat(fillStyle.top);
      const fill = {left, top, right: left + parseFloat(fillStyle.width), bottom: top + parseFloat(fillStyle.height), color: fillStyle.backgroundColor};
      const rect = (el) => { const b = el.getBoundingClientRect(); return {left: b.left, right: b.right, top: b.top, bottom: b.bottom}; };
      const bubble = rect(li.querySelector('.message-bubble')), meta = li.querySelector('.dm-msg__meta'), check = li.querySelector('.dm-msel'), box = check.querySelector('i');
      const body = li.querySelector('.dm-msg__body'), range = document.createRange(); range.selectNodeContents(body);
      const line = range.getClientRects()[0], tail = [...li.querySelectorAll('.message-bubble, .message-time, .dm-replies')].map((el) => el.getBoundingClientRect().bottom);
      const probe = document.createElement('i'); probe.style.background = 'var(--pick)'; document.body.append(probe);
      const soft = getComputedStyle(probe).backgroundColor; probe.remove();
      const bubbleBg = getComputedStyle(li.querySelector('.message-bubble')).backgroundColor;
      return {id, bubbleBg, own: li.classList.contains('is-mine'), cont: li.classList.contains('dm-msg--cont'), fill, bubble, soft, list: {left: list.left, right: list.right},
        topmost: meta ? meta.getBoundingClientRect().top : bubble.top, bottommost: Math.max(...tail), check: rect(check), box: rect(box),
        line: {top: line.top, bottom: line.bottom}, replies: !!li.querySelector('.dm-replies'), author: !!meta};
    })"""

    def test_02_the_picked_fill_has_equal_inset_and_the_check_meets_the_first_line(self) -> None:
        for width, height in ((1440, 900), (2560, 1440), (390, 844)):
            for dark in (False, True):
                with self.subTest(width=width, dark=dark):
                    page = self.open("jo", width, height, dark=dark)
                    self.choose(page)
                    # One message, then three (the evidence shots), then all of the kinds below: grouped and not, with an
                    # author row and without, own, and a root with replies.
                    def pick(*indexes: int) -> None:
                        for index in indexes:
                            self.message(page, index).scroll_into_view_if_needed()
                            body = self.message(page, index).locator(".dm-msg__body")
                            body.tap() if width <= 480 else body.click()
                        page.evaluate("Promise.all(document.getAnimations().map((a) => a.finished))")

                    mode = f"{width}-{'dark' if dark else 'light'}"
                    pick(4)
                    shot(page, f"dm-selection-{mode}-1-picked")
                    pick(2, 0)
                    shot(page, f"dm-selection-{mode}-3-picked")
                    pick(1, 3, 5)
                    order = (0, 1, 2, 3, 4, 5)
                    picked = page.evaluate(self.ROWS, [self.ids[i] for i in order])
                    seen = {(row["own"], row["cont"], row["replies"]) for row in picked}
                    self.assertIn((True, True, False), seen, "an own grouped message")
                    self.assertIn((False, False, True), seen, "a root with replies")
                    for row in picked:
                        label = f"{row['id']} own={row['own']} grouped={row['cont']} author={row['author']}"
                        fill, inset = row["fill"], 8
                        self.assertEqual(fill["color"], row["soft"], f"{label}: the one soft fill")
                        # A chosen bubble, an own one too, does not melt into the fill: they differ by a visible step.
                        step = max(abs(int(a) - int(b)) for a, b in zip(re.findall(r"\d+", fill["color"])[:3], re.findall(r"\d+", row["bubbleBg"])[:3]))
                        self.assertGreaterEqual(step, 8, f"{label}: the fill {fill['color']} apart from the bubble {row['bubbleBg']}")
                        self.assertAlmostEqual(row["topmost"] - fill["top"], inset, delta=1, msg=f"{label}: the fill has an inset above the bubble")
                        self.assertAlmostEqual(fill["bottom"] - row["bottommost"], inset, delta=1, msg=f"{label}: and below its time")
                        self.assertAlmostEqual(row["box"]["left"] - fill["left"], inset, delta=1, msg=f"{label}: and to the left of the check")
                        self.assertAlmostEqual(fill["left"], row["list"]["left"] - inset, delta=1, msg=f"{label}: the fill starts at the content column")
                        self.assertAlmostEqual(fill["right"], row["list"]["right"] + inset, delta=1, msg=f"{label}: and ends at its other edge")
                        if row["own"]:
                            self.assertAlmostEqual(fill["right"] - row["bubble"]["right"], inset, delta=1, msg=f"{label}: equal inset right of an own bubble")
                        centre, line = (row["check"]["top"] + row["check"]["bottom"]) / 2, (row["line"]["top"] + row["line"]["bottom"]) / 2
                        self.assertAlmostEqual(centre, line, delta=1.5, msg=f"{label}: the check is centred on the bubble's first line")
                        size = row["check"]["bottom"] - row["check"]["top"]
                        self.assertGreaterEqual(size, 44 if width <= 480 else 32, f"{label}: the check keeps its touch target")
                    page.context.close()

    BAR = """() => {
      const box = (selector) => { const b = document.querySelector(selector).getBoundingClientRect(); return {left: b.left, right: b.right, width: b.width}; };
      return {list: box('.dm__list'), bar: box('.dm-selbar__in'), count: box('.dm-selbar__count'), note: box('.dm-selbar__note'),
        primary: box('.dm-selbar .ui-btn--primary'), cancel: box('.dm-selbar .ui-btn--quiet')};
    }"""

    def test_03_the_selection_bar_shares_the_streams_column_edges(self) -> None:
        for width, height in ((1440, 900), (1920, 1080), (2560, 1440), (390, 844)):
            with self.subTest(width=width):
                page = self.open("jo", width, height)
                self.choose(page)
                measured = page.evaluate(self.BAR)
                self.assertAlmostEqual(measured["bar"]["left"], measured["list"]["left"], delta=1, msg=f"the bar starts where the messages do {measured}")
                self.assertAlmostEqual(measured["bar"]["right"], measured["list"]["right"], delta=1, msg=f"and ends where they do {measured}")
                self.assertAlmostEqual(measured["count"]["left"], measured["list"]["left"], delta=1, msg="the count is on the column's left edge")
                self.assertAlmostEqual(measured["note"]["left"], measured["count"]["left"], delta=1, msg="the note starts under the count")
                if width <= 480:
                    self.assertAlmostEqual(measured["primary"]["width"], measured["bar"]["width"], delta=1, msg="the primary action is full width on a phone")
                else:
                    self.assertAlmostEqual(measured["primary"]["right"], measured["list"]["right"], delta=1, msg="the primary action ends on the column's right edge")
                page.context.close()

    def test_04_entering_and_leaving_do_not_move_the_reading_position(self) -> None:
        for width, height in ((1440, 900), (390, 844)):
            for where in ("middle", "bottom"):
                with self.subTest(width=width, where=where):
                    page = self.open("jo", width, height)
                    page.evaluate("""(where) => { const feed = document.querySelector('.dm__feed'); feed.scrollTop = where === 'middle' ? (feed.scrollHeight - feed.clientHeight) / 2 : feed.scrollHeight; }""", where)
                    page.wait_for_timeout(250)
                    # The message the reader is on: the one crossing the middle of the pane.
                    anchor = page.evaluate_handle("""() => { const feed = document.querySelector('.dm__feed').getBoundingClientRect(), middle = (feed.top + feed.bottom) / 2;
                      return [...document.querySelectorAll('.dm-msg[data-message-id]')].find((li) => li.getBoundingClientRect().bottom > middle); }""")
                    top = lambda: anchor.evaluate("li => li.getBoundingClientRect().top")
                    start = top()
                    self.choose(page)
                    page.wait_for_timeout(250)
                    self.assertAlmostEqual(top(), start, delta=1.5, msg="entering selection leaves the message where it was")
                    cancel = page.get_by_role("region", name="Selected messages").get_by_role("button", name="Cancel")
                    cancel.tap() if width <= 480 else cancel.click()
                    expect(page.get_by_role("region", name="Selected messages")).to_have_count(0)
                    page.wait_for_timeout(250)
                    self.assertAlmostEqual(top(), start, delta=1.5, msg="and so does leaving it")
                    page.context.close()

    def test_05_the_swap_uses_the_motion_tokens_and_is_still_with_reduced_motion(self) -> None:
        for reduced in (False, True):
            with self.subTest(reduced=reduced):
                page = self.open("jo", 1440, 900, reduced=reduced)
                button = page.get_by_role("button", name="Choose messages", exact=True)
                button.click()
                bar = page.get_by_role("region", name="Selected messages")
                expect(bar).to_be_visible()
                token = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--dur-2').trim()")
                measured = page.evaluate("""() => ({bar: getComputedStyle(document.querySelector('.dm-selbar')), check: getComputedStyle(document.querySelector('.dm-msel'))})
                  && ({bar: [getComputedStyle(document.querySelector('.dm-selbar')).animationName, getComputedStyle(document.querySelector('.dm-selbar')).animationDuration],
                       check: [getComputedStyle(document.querySelector('.dm-msel')).animationName, getComputedStyle(document.querySelector('.dm-msel')).animationDuration],
                       fill: getComputedStyle(document.querySelector('.dm-msg__row'), '::before').transitionDuration})""")
                def seconds(text: str) -> float:
                    text = text.strip()
                    return float(text[:-2]) / 1000 if text.endswith("ms") else float(text[:-1])

                self.assertAlmostEqual(seconds(token), 0.0 if reduced else 0.18, msg="the shared token")
                for part in ("bar", "check"):
                    self.assertAlmostEqual(seconds(measured[part][1]), seconds(token), msg=f"{part} animates for the token's time ({measured[part]})")
                self.assertAlmostEqual(seconds(measured["fill"].split(",")[0]), 0.0 if reduced else 0.12, msg="the fill fades for the short token's time")
                # Only transform and opacity (and colours) move, never the layout. `scale` is the press (ui/press.ts, #593): it is the
                # individual transform property and may still be springing back from the click that opened the mode.
                names = page.evaluate("""() => { const frames = new Set(); for (const a of document.getAnimations()) for (const f of a.effect?.getKeyframes?.() ?? []) for (const k of Object.keys(f)) frames.add(k); return [...frames]; }""")
                self.assertTrue(set(names) <= {"offset", "computedOffset", "easing", "composite", "opacity", "transform", "scale", "backgroundColor", "color", "boxShadow", "outlineColor", "outlineOffset", "borderColor"}, names)
                page.context.close()


class DmSketchJourney(unittest.TestCase):
    """Tests run in name order and share the accounts, the DM and its sketch."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    dm_id = ""
    message_ids: list[str] = []
    sketch_id = ""
    copy_path = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=10000)
        contexts: dict[str, BrowserContext] = {}
        for key, (name, email, _) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def post(who: str, path: str, body: dict):
            response = contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), response.text()
            return response.json()

        cls.workspace_id = post("ada", "/api/v1/workspaces", {"name": "Lamp makers"})["id"]
        for key, (_, email, role) in PEOPLE.items():
            if role:
                post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": email, "role": role})
        cls.dm_id = post("jo", f"/api/v1/workspaces/{cls.workspace_id}/dms", {"participantIds": [cls.ids["kai"]]})["id"]
        cls.message_ids = [post(who, f"/api/v1/dms/{cls.dm_id}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})["id"] for who, body in MESSAGES]
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, path: str) -> tuple[int, dict]:
        response = page.request.get(path)
        return response.status, (json.loads(response.text()) if response.text() else {})

    def message(self, page: Page, index: int):
        return page.locator(f'.dm-msg[data-message-id="{self.message_ids[index]}"]')

    # ---------------------------------------------------------------- start from messages

    def test_01_select_messages_and_start_a_sketch(self) -> None:
        page = self.page("jo")
        page.goto(f"/dm/{self.dm_id}")
        expect(page.locator(".dm-msg__body", has_text="gestures")).to_be_visible()
        select = page.get_by_role("button", name="Choose messages", exact=True)
        select.click()
        expect(select).to_have_attribute("aria-pressed", "true")
        bar = page.get_by_role("region", name="Selected messages")
        expect(bar.get_by_role("status")).to_have_text("Choose the messages to sketch from")
        expect(bar).to_contain_text("only you and Kai can see it. No project is created.")
        expect(page.get_by_label(re.compile(r"^Message "))).to_be_hidden()
        # Pointer: a whole row toggles. Keyboard: the check is a button, Space toggles it.
        self.message(page, 0).locator(".dm-msg__body").click()
        check = self.message(page, 2).get_by_role("button", name=re.compile(r"^Select Kai Lind’s message"))
        check.focus()
        page.keyboard.press("Space")
        expect(check).to_have_attribute("aria-pressed", "true")
        expect(bar.get_by_role("status")).to_have_text("2 messages selected")
        expect(self.message(page, 0)).to_have_class(re.compile(r"is-picked"))
        shot(page, "dm-sketch-select")
        # Esc cancels without starting anything.
        page.keyboard.press("Escape")
        expect(bar).to_be_hidden()
        expect(select).to_be_focused()
        select.click()
        self.message(page, 0).locator(".dm-msg__body").click()
        self.message(page, 2).locator(".dm-msg__body").click()
        bar.get_by_role("button", name="Start sketch from these messages").click()

        page.wait_for_url(re.compile(rf"/dm/{self.dm_id}/sketches/[0-9a-f-]{{36}}$"))
        type(self).sketch_id = page.url.rsplit("/", 1)[-1]
        expect(page.get_by_label("Sketch name")).to_be_focused()
        page.keyboard.press("Escape")  # keep the proposed name
        expect(page.get_by_label("Sketch name")).to_have_count(0)
        expect(page.locator(".sk-status")).to_contain_text("Started from 2 messages · only you and Kai can see it")
        expect(page.locator(".sk-aud")).to_contain_text("Only you and Kai, in this direct message")
        expect(page.get_by_role("navigation", name="Direct message views").get_by_role("link", name=re.compile(r"^Sketches"))).to_contain_text("1")
        nodes = page.locator(".sk-node")
        expect(nodes).to_have_count(2)
        expect(nodes.first).to_contain_text("Message from Kai")
        shot(page, "dm-sketch-map")

        status, sketch = self.api(page, f"/api/v1/sketches/{self.sketch_id}")
        self.assertEqual(status, 200)
        self.assertEqual((sketch["scope"], sketch["dmId"], sketch["projectId"]), ("dm", self.dm_id, None))
        self.assertEqual([t["source"]["dmMessageId"] for t in sketch["thoughts"]], [self.message_ids[0], self.message_ids[2]])
        self.assertEqual({t["source"]["author"]["id"] for t in sketch["thoughts"]}, {self.ids["kai"]})

    def test_02_the_other_participant_opens_it_and_outsiders_cannot(self) -> None:
        kai = self.page("kai")
        kai.goto(f"/dm/{self.dm_id}")
        kai.get_by_role("navigation", name="Direct message views").get_by_role("link", name=re.compile(r"^Sketches")).click()
        expect(kai).to_have_url(re.compile(rf"/dm/{self.dm_id}/sketches$"))
        expect(kai.get_by_text("can see these. They stay in this conversation.")).to_be_visible()
        kai.get_by_role("link", name=re.compile(r"^From 2 messages")).click()
        expect(kai.locator(".sk-node")).to_have_count(2)
        # Kai can change it: add a connected thought.
        kai.locator(".sk-node").first.click()
        kai.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).click()
        editor = kai.get_by_label("Thought text")
        expect(editor).to_be_focused()
        editor.fill("60 GHz radar sees through the shade")
        editor.press("Enter")
        expect(kai.locator(".sk-node", has_text="60 GHz radar")).to_be_visible()
        expect(kai.locator(".sk-status")).to_contain_text("Saved")

        mo = self.page("mo")
        mo.goto(f"/dm/{self.dm_id}/sketches/{self.sketch_id}")
        expect(mo.get_by_role("heading", name="This sketch isn’t available")).to_be_visible()
        expect(mo.get_by_text("gestures")).to_have_count(0)
        status, _ = self.api(mo, f"/api/v1/sketches/{self.sketch_id}")
        self.assertEqual(status, 404)
        status, listed = self.api(mo, f"/api/v1/workspaces/{self.workspace_id}/sketches?dmId={self.dm_id}")
        self.assertEqual((status, listed["total"]), (200, 0))
        ada = self.page("ada")
        status, _ = self.api(ada, f"/api/v1/sketches/{self.sketch_id}")
        self.assertEqual(status, 404, "the workspace owner outside the DM gets 404")

    def test_03_phone_selection_bar(self) -> None:
        page = self.page("kai", phone=True)
        page.goto(f"/dm/{self.dm_id}")
        page.wait_for_function("navigator.serviceWorker.controller?.state === 'activated'")
        expect(page.get_by_test_id("flux-update-prompt")).to_have_count(0)
        select = page.get_by_role("button", name="Choose messages", exact=True)
        select.tap()
        self.message(page, 1).locator(".dm-msg__body").tap()
        bar = page.get_by_role("region", name="Selected messages")
        expect(bar.get_by_role("status")).to_have_text("1 message selected")
        start = bar.get_by_role("button", name="Start sketch from these messages")
        expect(start).to_be_visible()
        # Measure once the checks and the bar have finished scaling in.
        page.evaluate("Promise.all(document.getAnimations().map((a) => a.finished))")
        for target in (start, bar.get_by_role("button", name="Cancel"), self.message(page, 1).locator(".dm-msel")):
            size = box(page, target)
            self.assertGreaterEqual(min(size["width"], size["height"]), 44, "44 px touch targets")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no horizontal scrolling")
        shot(page, "dm-sketch-phone-select")
        bar.get_by_role("button", name="Cancel").tap()
        expect(bar).to_be_hidden()

    # ---------------------------------------------------------------- make it a project

    def test_04_make_a_project_after_an_exact_preview(self) -> None:
        page = self.page("jo")
        page.goto(f"/dm/{self.dm_id}/sketches/{self.sketch_id}")
        page.get_by_role("button", name="Make it a project…").click()
        panel = page.locator("#details")
        expect(panel.get_by_role("heading", name="Make a project from this sketch")).to_be_visible()
        # Nobody from the conversation joins unless Jo chooses it (#188): the preview names who would.
        expect(panel.locator(".promote__aud b")).to_have_text("Ada and you — only you two")
        grant = panel.get_by_role("checkbox", name="Also give Kai access")
        expect(grant).not_to_be_checked()
        grant.check()
        expect(panel.locator(".promote__aud b")).to_have_text("You, Kai and Ada")
        expect(panel.locator(".promote__aud")).to_contain_text("Ada manages every project in this workspace")
        expect(panel).to_contain_text("3 thoughts, with their 1 link")
        expect(panel).to_contain_text("2 thoughts started from messages keep who wrote them and when")
        expect(panel).to_contain_text("The other 2 messages of the conversation, and everything written there later. Nothing is synced to the project.")
        status, preview = self.api(page, f"/api/v1/sketches/{self.sketch_id}/promotion?target=new")
        self.assertEqual({p["id"] for p in preview["audience"]}, {self.ids["jo"], self.ids["kai"], self.ids["ada"]})
        shot(page, "dm-sketch-promote")
        panel.get_by_label("Name").fill("Gesture lamp")
        panel.get_by_role("button", name="Create project").click()

        page.wait_for_url(re.compile(r"/projects/[0-9a-f-]{36}/map/[0-9a-f-]{36}$"))
        type(self).copy_path = page.url.split(ORIGIN, 1)[-1]
        project_id, copy_id = re.findall(r"[0-9a-f-]{36}", self.copy_path)
        expect(page.locator(".top__title h1")).to_have_text("Gesture lamp")
        expect(page.locator(".sk-origin")).to_contain_text("Copied from a direct message by you")
        expect(page.locator(".sk-node")).to_have_count(3)
        status, people = self.api(page, f"/api/v1/projects/{project_id}/people")
        self.assertEqual({p["id"] for p in people}, {p["id"] for p in preview["audience"]}, "the preview named exactly the readers")
        status, project = self.api(page, f"/api/v1/projects/{project_id}")
        self.assertEqual(project["visibility"], "restricted")
        mo = self.page("mo")
        self.assertEqual(self.api(mo, f"/api/v1/sketches/{copy_id}")[0], 404, "a member outside the DM cannot open the copy")
        shot(page, "dm-sketch-copied")

        # The DM sketch notes the copy; later DM messages never reach the project.
        page.goto(f"/dm/{self.dm_id}/sketches/{self.sketch_id}")
        expect(page.locator(".sk-copies")).to_contain_text("Copied to Gesture lamp")
        page.request.post(f"/api/v1/dms/{self.dm_id}/messages", data={"body": "One more lamp thought, later", "clientMessageId": str(uuid.uuid4())}, headers={"origin": ORIGIN})
        _, copy = self.api(page, f"/api/v1/sketches/{copy_id}")
        self.assertEqual(len(copy["thoughts"]), 3)
        self.assertNotIn(self.dm_id, json.dumps(copy))
        self.assertTrue(all(t["source"] is None or t["source"]["dmMessageId"] is None for t in copy["thoughts"]))

    def test_04c_phone_maps_keep_the_room_for_the_map(self) -> None:
        """The DM map and the project copy at 390x844: one compact header, one line of context, one row of tools."""
        page = self.page("jo", phone=True)
        for label, path in (("dm", f"/dm/{self.dm_id}/sketches/{self.sketch_id}"), ("copied", self.copy_path)):
            page.goto(path)
            canvas = page.locator(".sk-canvas")
            expect(canvas).to_be_visible()
            top = canvas.bounding_box()["y"]
            # Before this review the copied map started at about 508 px of 844. The sketch's own chrome
            # (header, context line, tools) is what this surface controls; the shell above it is shared.
            chrome = top - page.locator(".sk").bounding_box()["y"]
            print(f"PHONE-MAP {label}: canvas top {top:.0f}px, sketch chrome {chrome:.0f}px", flush=True)
            shot(page, f"dm-sketch-phone-{label}")
            self.assertLessEqual(top, 440, f"{label}: the map starts near the upper half of the screen (at {top:.0f}px)")
            self.assertLessEqual(chrome, 300, f"{label}: the sketch's own header, context and tools stay compact ({chrome:.0f}px)")
            # S15: no toolbar row on the phone; the map views and adds, and says where to connect.
            expect(page.get_by_role("toolbar", name="Sketch tools")).to_have_count(0)
            add = page.get_by_role("button", name="Add a thought", exact=True)
            expect(add).to_be_visible()
            self.assertGreaterEqual(add.bounding_box()["height"], 43.5, f"{label}: Add a thought is a touch target")
            expect(page.get_by_text("Connect and arrange on a computer")).to_be_visible()
            page.locator(".sk-node").first.tap()
            page.get_by_role("button", name="Thought actions", exact=True).tap()
            actions = page.get_by_role("dialog", name="Thought actions", exact=True)
            expect(actions.get_by_role("button", name="Remove from map", exact=True)).to_be_visible()
            for name in ("Connect", "Change shape", "Undo"):
                expect(actions.get_by_role("button", name=name, exact=True)).to_have_count(0)
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], f"{label}: no horizontal scrolling")
            actions.get_by_role("button", name="Close thought actions", exact=True).tap()
            shot(page, f"dm-sketch-phone-{label}")
        # The copy still says where it came from and that the conversation stays private.
        expect(page.locator(".sk-origin")).to_contain_text("Copied from a direct message by you")
        expect(page.locator(".sk-origin")).to_contain_text("the conversation stays private")

    def test_04b_search_finds_the_dm_sketch_and_opens_it_in_the_dm(self) -> None:
        page = self.page("jo")
        # "60 GHz radar sees through the shade" is Kai's thought in the DM sketch; its copy lives in Gesture lamp.
        page.goto(f"/search?q=shade&place=dm:{self.dm_id}")
        results = page.get_by_role("region", name="Results")
        expect(results.get_by_role("link")).to_have_count(1)
        expect(results).to_contain_text("60 GHz radar")
        expect(results).to_contain_text("Kai Lind")
        results.get_by_role("link").first.click()
        expect(page).to_have_url(re.compile(rf"/dm/{self.dm_id}/sketches/{self.sketch_id}#thought-[0-9a-f-]{{36}}$"))
        expect(page.locator(".sk-aud")).to_contain_text("in this direct message")
        # Across every place: the DM thought and the project copy, each opening where it lives.
        page.goto("/search?q=shade")
        expect(results.get_by_role("link")).to_have_count(2)
        hrefs = sorted(results.get_by_role("link").evaluate_all("(links) => links.map((a) => a.getAttribute('href'))"))
        self.assertTrue(any(h.startswith(f"/dm/{self.dm_id}/sketches/{self.sketch_id}#thought-") for h in hrefs), hrefs)
        self.assertTrue(any(h.startswith(f"{self.copy_path.split('/map/')[0]}/map/") or h.startswith("/map/") for h in hrefs if not h.startswith("/dm/")), hrefs)
        # Mo is outside the DM and the project: nothing, not even a count.
        mo = self.page("mo")
        mo.goto("/search?q=shade")
        expect(mo.get_by_role("heading", name="Nothing matches “shade”")).to_be_visible()
        self.assertNotIn("radar", mo.content())
        shot(page, "dm-sketch-search")

    # ---------------------------------------------------------------- leaving

    def test_05_leaving_ends_access_and_the_sketch_turns_read_only(self) -> None:
        kai = self.page("kai")
        kai.goto(f"/dm/{self.dm_id}/sketches/{self.sketch_id}")
        expect(kai.locator(".sk-node")).to_have_count(3)
        left = kai.request.post(f"/api/v1/dms/{self.dm_id}/leave", headers={"origin": ORIGIN})
        self.assertEqual(left.status, 204)
        kai.reload()
        expect(kai.get_by_role("heading", name=re.compile(r"isn’t available"))).to_be_visible()
        self.assertEqual(self.api(kai, f"/api/v1/sketches/{self.sketch_id}")[0], 404)

        jo = self.page("jo")
        jo.goto(f"/dm/{self.dm_id}/sketches/{self.sketch_id}")
        expect(jo.locator(".sk-readonly")).to_contain_text("read-only until the other person reopens it")
        expect(jo.get_by_role("button", name="Make it a project…")).to_have_count(0)
        expect(jo.get_by_role("toolbar", name="Sketch tools")).to_have_count(0)
        jo.goto(f"/dm/{self.dm_id}")
        expect(jo.locator(".dm__notice")).to_contain_text("left this conversation")
        expect(jo.get_by_role("button", name="Choose messages", exact=True)).to_have_count(0)
        shot(jo, "dm-sketch-left")


if __name__ == "__main__":
    unittest.main()
