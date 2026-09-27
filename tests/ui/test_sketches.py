"""Browser tests for persistent sketches (issue #69, AC-3/AC-4).

Runs with tests/ui/test_app_shell.py through scripts/check_ui.sh against the running Compose
application. One person signs up, starts a private sketch and works on it with the pointer and
the keyboard; every change is checked against the API after a reload, so the test proves
persistence rather than local state. Screenshots go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, box, shot, start_forwarder

PASSWORD = "sketching all afternoon"
EMAIL = f"kai.lind+{int(time.time() * 1000)}@example.test"
NAME = "Kai Lind"


def translate(locator) -> tuple[float, float]:
    """The thought's position on the plane, from its inline transform."""
    style = locator.get_attribute("style") or ""
    match = re.search(r"translate\((-?[\d.]+)px, (-?[\d.]+)px\)", style)
    assert match, f"thought is positioned: {style!r}"
    return float(match.group(1)), float(match.group(2))


class SketchJourney(unittest.TestCase):
    """Tests run in name order and share one account and one sketch."""

    pw = None
    browser: Browser
    state: dict | None = None
    sketch_url: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool = False, **extra) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if self.state:
            options["storage_state"] = self.state
        options.update(extra)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, context: BrowserContext | None = None, **kwargs) -> Page:
        page = (context or self.context(**kwargs)).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def stored(self, page: Page) -> dict:
        """The sketch as the API returns it now."""
        sketch_id = self.sketch_url.rsplit("/", 1)[-1]
        response = page.request.get(f"/api/v1/sketches/{sketch_id}")
        self.assertEqual(response.status, 200)
        return json.loads(response.text())

    def thought(self, page: Page, text: str):
        return page.locator(".sk-node", has_text=text)

    def saved(self, page: Page) -> None:
        expect(page.locator(".sk-status")).to_contain_text("Saved")

    def open_sketch(self, **kwargs) -> Page:
        page = self.page(**kwargs)
        page.goto(self.sketch_url)
        expect(page.get_by_role("group", name=re.compile("^Sketch: "))).to_be_visible()
        return page

    # ---------------------------------------------------------------- start and add

    def test_01_start_a_private_sketch_and_add_thoughts(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(NAME)
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()

        page.get_by_role("navigation", name="Views").get_by_role("link", name="Map").click()
        expect(page.get_by_role("heading", name="Start a sketch")).to_be_visible()
        page.get_by_role("button", name="New sketch").click()
        expect(page).to_have_url(re.compile(r"/map/[0-9a-f-]{36}$"))
        type(self).sketch_url = page.url.replace(ORIGIN, "")
        name = page.get_by_label("Sketch name")
        expect(name).to_be_focused()
        name.fill("Lamp ideas")
        name.press("Enter")
        expect(page.get_by_role("button", name="Rename sketch Lamp ideas")).to_be_visible()
        expect(page.locator(".sk-aud")).to_have_text("Only you")

        # The toolbar's Thought adds a thought and edits it in place.
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).click()
        editor = page.get_by_label("Thought text")
        expect(editor).to_be_focused()
        editor.fill("Gesture-controlled desk lamp")
        editor.press("Enter")
        expect(self.thought(page, "Gesture-controlled desk lamp")).to_be_focused()
        expect(page.locator(".sk-status")).to_contain_text("Added “Gesture-controlled desk lamp”")

        # The visible + beside the selected thought adds a connected one.
        self.thought(page, "Gesture-controlled desk lamp").click()
        plus = page.get_by_role("button", name="Add a thought connected to “Gesture-controlled desk lamp”")
        expect(plus).to_be_visible()
        plus.click()
        editor = page.get_by_label("Thought text")
        expect(editor).to_be_focused()
        editor.fill("Swipe to dim, hold to switch off")
        editor.press("Enter")
        expect(page.locator(".sk-edges path")).to_have_count(1)

        # The keyboard: + on a focused thought adds a connected thought too.
        self.thought(page, "Gesture-controlled desk lamp").focus()
        page.keyboard.press("+")
        page.get_by_label("Thought text").fill("ToF distance sensor")
        page.keyboard.press("Enter")
        expect(page.locator(".sk-edges path")).to_have_count(2)
        self.saved(page)
        shot(page, "sketch-desktop-1440-map")

        page.reload()
        expect(page.locator(".sk-node")).to_have_count(3)
        stored = self.stored(page)
        self.assertEqual(stored["title"], "Lamp ideas")
        self.assertEqual(sorted(t["text"] for t in stored["thoughts"]), ["Gesture-controlled desk lamp", "Swipe to dim, hold to switch off", "ToF distance sensor"])
        self.assertEqual(len(stored["links"]), 2)
        self.assertEqual((stored["scope"], stored["createdBy"]["name"]), ("private", NAME))

    # ---------------------------------------------------------------- keyboard path

    def test_02_keyboard_moves_and_edits(self) -> None:
        page = self.open_sketch()
        node = self.thought(page, "ToF distance sensor")
        before = {t["text"]: t for t in self.stored(page)["thoughts"]}["ToF distance sensor"]
        node.focus()
        for _ in range(3):
            page.keyboard.press("ArrowRight")
        page.keyboard.press("Shift+ArrowDown")
        expect(page.locator(".sk-status")).to_contain_text("with the keyboard")
        self.saved(page)
        page.wait_for_timeout(600)  # the burst is sent once the keys rest
        after = {t["text"]: t for t in self.stored(page)["thoughts"]}["ToF distance sensor"]
        self.assertEqual((after["x"], after["y"]), (before["x"] + 36, before["y"] + 48))

        node.focus()
        page.keyboard.press("Enter")
        editor = page.get_by_label("Thought text")
        expect(editor).to_be_focused()
        editor.fill("ToF distance sensor (VL53L5CX)")
        page.keyboard.press("Enter")
        expect(self.thought(page, "ToF distance sensor (VL53L5CX)")).to_be_focused()
        # Escape keeps the previous text.
        page.keyboard.press("Enter")
        page.get_by_label("Thought text").fill("discarded")
        page.keyboard.press("Escape")
        expect(self.thought(page, "discarded")).to_have_count(0)
        expect(page.locator(".sk-status")).to_contain_text("Edit cancelled")
        page.wait_for_timeout(300)
        texts = [t["text"] for t in self.stored(page)["thoughts"]]
        self.assertIn("ToF distance sensor (VL53L5CX)", texts)
        self.assertNotIn("discarded", texts)

        # The toolbar's labelled Edit edits the one selected thought.
        self.thought(page, "Swipe to dim").click()
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Edit", exact=True).click()
        expect(page.get_by_label("Thought text")).to_be_focused()
        page.keyboard.press("Escape")

        # Space selects several; Escape clears the selection.
        page.keyboard.press("Escape")
        expect(page.locator(".sk-node[aria-pressed='true']")).to_have_count(0)
        self.thought(page, "Gesture-controlled desk lamp").focus()
        page.keyboard.press("Space")
        self.thought(page, "Swipe to dim").focus()
        page.keyboard.press("Space")
        expect(page.locator(".sk-node[aria-pressed='true']")).to_have_count(2)
        expect(page.locator(".sk-status")).to_contain_text("2 thoughts selected")
        page.keyboard.press("Escape")
        expect(page.locator(".sk-node[aria-pressed='true']")).to_have_count(0)

    # ---------------------------------------------------------------- pointer path

    def test_03_drag_multi_select_pan_zoom_and_undo(self) -> None:
        page = self.open_sketch()
        lamp = self.thought(page, "Gesture-controlled desk lamp")
        swipe = self.thought(page, "Swipe to dim")
        start = {t["id"]: (t["x"], t["y"]) for t in self.stored(page)["thoughts"]}

        # Drag one thought.
        b = box(page, swipe)
        page.mouse.move(b["x"] + 30, b["y"] + 20)
        page.mouse.down()
        page.mouse.move(b["x"] + 90, b["y"] + 60, steps=6)
        page.mouse.move(b["x"] + 150, b["y"] + 100, steps=6)
        page.mouse.up()
        expect(page.locator(".sk-status")).to_contain_text("Moved “Swipe to dim")
        self.saved(page)
        moved = {t["text"]: (t["x"], t["y"]) for t in self.stored(page)["thoughts"]}
        swipe_id = swipe.get_attribute("data-id")
        self.assertEqual(moved["Swipe to dim, hold to switch off"], (start[swipe_id][0] + 120, start[swipe_id][1] + 80))

        # Selecting or dragging never opens a management panel.
        expect(page.get_by_role("complementary", name="Details")).to_have_count(0)
        expect(page.get_by_role("dialog")).to_have_count(0)

        # Shift-click selects several; dragging one moves them together.
        lamp.click()
        swipe.click(modifiers=["Shift"])
        expect(page.locator(".sk-node[aria-pressed='true']")).to_have_count(2)
        shot(page, "sketch-desktop-1440-select")
        b = box(page, lamp)
        page.mouse.move(b["x"] + 30, b["y"] + 20)
        page.mouse.down()
        page.mouse.move(b["x"] + 60, b["y"] + 20, steps=5)
        page.mouse.move(b["x"] + 90, b["y"] + 20, steps=5)
        page.mouse.up()
        expect(page.locator(".sk-status")).to_contain_text("Moved 2 thoughts")
        self.saved(page)
        together = {t["text"]: (t["x"], t["y"]) for t in self.stored(page)["thoughts"]}
        self.assertEqual(together["Gesture-controlled desk lamp"][0], moved["Gesture-controlled desk lamp"][0] + 60)
        self.assertEqual(together["Swipe to dim, hold to switch off"][0], moved["Swipe to dim, hold to switch off"][0] + 60)
        expect(page.get_by_role("complementary", name="Details")).to_have_count(0)

        # Undo is an inverse change on the server too.
        page.keyboard.press("Control+z")
        expect(page.locator(".sk-status")).to_contain_text("Undid: moved thoughts")
        page.wait_for_timeout(300)
        self.saved_or_idle(page)
        undone = {t["text"]: (t["x"], t["y"]) for t in self.stored(page)["thoughts"]}
        self.assertEqual(undone["Gesture-controlled desk lamp"], moved["Gesture-controlled desk lamp"])

        # Zoom and pan.
        page.get_by_role("button", name="Zoom in").click()
        page.get_by_role("button", name="Zoom in").click()
        page.get_by_role("button", name="Zoom in").click()
        expect(page.get_by_role("button", name=re.compile(r"^Zoom 150%"))).to_be_visible()
        canvas = page.locator(".sk-canvas")
        c = box(page, canvas)
        page.mouse.move(c["x"] + c["width"] - 30, c["y"] + c["height"] - 60)
        page.mouse.down()
        page.mouse.move(c["x"] + c["width"] - 200, c["y"] + c["height"] - 160, steps=8)
        page.mouse.up()
        self.assertGreater(canvas.evaluate("el => el.scrollLeft + el.scrollTop"), 0, "dragging empty space pans")
        page.get_by_role("button", name=re.compile(r"^Zoom 150%")).click()
        expect(page.get_by_role("button", name=re.compile(r"^Zoom 100%"))).to_be_visible()

        # Remove takes a thought off the map; undo brings it and its link back.
        self.thought(page, "ToF distance sensor").click()
        page.keyboard.press("Delete")
        expect(self.thought(page, "ToF distance sensor")).to_have_count(0)
        self.saved(page)
        self.assertEqual(len(self.stored(page)["thoughts"]), 2)
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Undo").click()
        expect(self.thought(page, "ToF distance sensor")).to_have_count(1)
        page.wait_for_timeout(300)
        self.saved_or_idle(page)
        restored = self.stored(page)
        self.assertEqual(len(restored["thoughts"]), 3)
        self.assertEqual(len(restored["links"]), 2)

    def saved_or_idle(self, page: Page) -> None:
        expect(page.locator(".sk-status")).not_to_contain_text("Saving")

    # ---------------------------------------------------------------- connect and shape

    def test_04_connect_and_shape(self) -> None:
        page = self.open_sketch()
        self.thought(page, "Swipe to dim").click()
        tools = page.get_by_role("toolbar", name="Sketch tools")
        tools.get_by_role("button", name="Connect", exact=True).click()
        expect(tools.get_by_role("button", name="Connect", exact=True)).to_have_attribute("aria-pressed", "true")
        self.thought(page, "ToF distance sensor").click()
        expect(page.locator(".sk-status")).to_contain_text("Linked “Swipe to dim")
        expect(page.locator(".sk-edges path")).to_have_count(3)
        tools.get_by_role("button", name="Change shape").click()
        self.saved(page)
        shapes = {t["text"]: t["shape"] for t in self.stored(page)["thoughts"]}
        self.assertEqual(sorted(shapes.values()), ["card", "pill", "pill"])
        self.assertEqual(len(self.stored(page)["links"]), 3)

    # ---------------------------------------------------------------- list view

    def test_05_list_view_is_the_accessible_alternative(self) -> None:
        page = self.open_sketch()
        page.get_by_role("radio", name="List").click()
        items = page.get_by_role("list", name="Thoughts in Lamp ideas")
        expect(items).to_be_visible()
        expect(items.get_by_role("listitem")).to_have_count(3)
        expect(items).to_contain_text("Linked to")
        item = items.get_by_role("button", name="Swipe to dim, hold to switch off")
        item.focus()
        page.keyboard.press("Enter")
        page.get_by_label("Thought text").fill("Swipe to dim, hold for off")
        page.keyboard.press("Enter")
        expect(items.get_by_role("button", name="Swipe to dim, hold for off")).to_be_focused()
        page.keyboard.press("+")
        page.get_by_label("Thought text").fill("60 GHz radar through the shade")
        page.keyboard.press("Enter")
        expect(items.get_by_role("listitem")).to_have_count(4)
        self.saved(page)
        shot(page, "sketch-desktop-1280-list")
        # The choice of view is remembered.
        page.reload()
        expect(page.get_by_role("list", name="Thoughts in Lamp ideas")).to_be_visible()
        page.get_by_role("radio", name="Map").click()
        expect(page.get_by_role("group", name="Sketch: Lamp ideas")).to_be_visible()
        texts = [t["text"] for t in self.stored(page)["thoughts"]]
        self.assertIn("60 GHz radar through the shade", texts)

    # ---------------------------------------------------------------- live updates

    def test_06_live_updates_arrive_from_the_stream(self) -> None:
        context = self.context()
        watcher = self.page(context)
        watcher.goto(self.sketch_url)
        expect(watcher.locator(".sk-node")).to_have_count(4)
        worker = self.page(context)
        worker.goto(self.sketch_url)
        expect(worker.locator(".sk-node")).to_have_count(4)
        worker.wait_for_timeout(500)  # both streams are open
        worker.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).click()
        worker.get_by_label("Thought text").fill("Seen from another tab")
        worker.keyboard.press("Enter")
        expect(watcher.locator(".sk-node", has_text="Seen from another tab")).to_be_visible(timeout=10000)
        worker.locator(".sk-node", has_text="Seen from another tab").click()
        worker.keyboard.press("Delete")
        expect(watcher.locator(".sk-node", has_text="Seen from another tab")).to_have_count(0, timeout=10000)

    # ---------------------------------------------------------------- phone, dark, reduced motion

    def test_07_phone_route(self) -> None:
        page = self.open_sketch(phone=True)
        expect(page.get_by_role("group", name="Sketch: Lamp ideas")).to_be_visible()
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no horizontal page scroll")
        shot(page, "sketch-phone-390-map")
        node = self.thought(page, "Gesture-controlled desk lamp")
        node.tap()
        expect(node).to_have_attribute("aria-pressed", "true")
        plus = page.get_by_role("button", name="Add a thought connected to “Gesture-controlled desk lamp”")
        expect(plus).to_be_visible()
        self.assertGreaterEqual(box(page, plus)["width"], 44, "touch target")
        expect(page.get_by_text("Tap a thought to select it")).to_be_visible()
        page.get_by_role("radio", name="List").tap()
        expect(page.get_by_role("list", name="Thoughts in Lamp ideas")).to_be_visible()
        shot(page, "sketch-phone-390-list")
        page.get_by_role("radio", name="Map").tap()
        page.goto("/map")
        expect(page.get_by_role("link", name=re.compile("Lamp ideas"))).to_be_visible()
        shot(page, "sketch-phone-390-index")

    def test_08_dark_and_reduced_motion(self) -> None:
        page = self.open_sketch(color_scheme="dark", reduced_motion="reduce")
        node = self.thought(page, "Gesture-controlled desk lamp")
        self.assertEqual(node.evaluate("el => getComputedStyle(el).transitionDuration.split(',').every(d => parseFloat(d) === 0)"), True, "no motion under reduced motion")
        node.click()
        shot(page, "sketch-desktop-1440-dark")
        calm = self.open_sketch()
        self.assertTrue(calm.locator(".sk-node").first.evaluate("el => getComputedStyle(el).transitionDuration.split(',').some(d => parseFloat(d) > 0)"), "subtle motion otherwise")


    # ---------------------------------------------------------------- phone discoverability

    def test_07a_phone_fits_the_graph_and_labels_actions(self) -> None:
        page = self.open_sketch(phone=True)
        canvas = box(page, page.locator(".sk-canvas"))
        # The phone shows the whole graph in two readable columns at full size: nothing is cut off
        # at the sides and there is no sideways scrolling.
        zoom = page.get_by_role("button", name=re.compile(r"^Zoom \d+%")).get_attribute("aria-label")
        self.assertIn("100%", zoom)
        nodes = page.locator(".sk-node")
        self.assertGreaterEqual(nodes.count(), 4)
        for i in range(nodes.count()):
            b = box(page, nodes.nth(i))
            self.assertGreaterEqual(b["x"], canvas["x"] - 1, f"thought {i} starts inside the canvas")
            self.assertLessEqual(b["x"] + b["width"], canvas["x"] + canvas["width"] + 1, f"thought {i} ends inside the canvas")
        self.assertLessEqual(page.locator(".sk-canvas").evaluate("el => el.scrollWidth - el.clientWidth"), 1, "no sideways scroll")
        for i in range(nodes.count()):
            for j in range(i + 1, nodes.count()):
                a, b = box(page, nodes.nth(i)), box(page, nodes.nth(j))
                overlap = a["x"] < b["x"] + b["width"] and b["x"] < a["x"] + a["width"] and a["y"] < b["y"] + b["height"] and b["y"] < a["y"] + a["height"]
                self.assertFalse(overlap, f"thoughts {i} and {j} do not overlap")
        bar = box(page, page.get_by_role("toolbar", name="Sketch tools"))
        self.assertLessEqual(bar["height"], 100, "the tools take two compact rows on a phone")
        # The toolbar says what each action does.
        tools = page.get_by_role("toolbar", name="Sketch tools")
        for label in ("Thought", "Connect", "Edit", "Shape", "Remove", "Undo"):
            expect(tools.get_by_text(label, exact=True)).to_be_visible()
        # Selecting shows a labelled Edit action beside the +.
        node = self.thought(page, "Gesture-controlled desk lamp")
        node.tap()
        edit = page.get_by_role("button", name="Edit “Gesture-controlled desk lamp”")
        expect(edit).to_be_visible()
        expect(edit).to_have_text("Edit")
        self.assertGreaterEqual(box(page, edit)["height"], 44, "touch target")
        shot(page, "sketch-phone-390-select")
        edit.tap()
        expect(page.get_by_label("Thought text")).to_be_focused()
        page.keyboard.press("Escape")
        # Fit brings the whole graph back after zooming in.
        page.get_by_role("button", name="Zoom in").tap()
        page.get_by_role("button", name="Fit the sketch to the view").tap()
        expect(page.get_by_role("button", name=re.compile(r"^Zoom \d+%"))).to_have_attribute("aria-label", zoom)

    # ---------------------------------------------------------------- many sketches

    def api(self, page: Page, method: str, path: str, body: dict | None = None) -> dict:
        response = page.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
        self.assertLess(response.status, 300, f"{method} {path}: {response.status} {response.text()}")
        return json.loads(response.text()) if response.text() else {}

    def test_09_the_index_pages_through_every_sketch(self) -> None:
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP)
        self.addCleanup(context.close)
        page = self.page(context)
        self.api(page, "POST", "/api/auth/sign-up/email", {"name": "Ines Many", "email": f"many+{int(time.time() * 1000)}@example.test", "password": PASSWORD})
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Many sketches"})
        for i in range(105):
            self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": f"Sketch {i:03d}", "scope": "private"})
        page.goto("/map")
        links = page.get_by_role("list", name="Your sketches").get_by_role("link")
        expect(links).to_have_count(50)
        expect(page.get_by_text("Showing 50 of 105")).to_be_visible()
        page.get_by_role("button", name="Show more sketches").click()
        expect(links).to_have_count(100)
        page.get_by_role("button", name="Show more sketches").click()
        expect(links).to_have_count(105)
        expect(page.get_by_role("button", name="Show more sketches")).to_have_count(0)
        titles = links.all_inner_texts()
        self.assertEqual(len({t.splitlines()[0] for t in titles}), 105, "no sketch hidden or repeated")

    # ---------------------------------------------------------------- account switch in one tab

    def test_10_the_stream_follows_an_account_switch_in_the_same_tab(self) -> None:
        # A second person with a sketch of their own, prepared in a separate context.
        other_email = f"noor+{int(time.time() * 1000)}@example.test"
        prep_context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP)
        self.addCleanup(prep_context.close)
        prep = self.page(prep_context)
        self.api(prep, "POST", "/api/auth/sign-up/email", {"name": "Noor Vale", "email": other_email, "password": PASSWORD})
        ws = self.api(prep, "POST", "/api/v1/workspaces", {"name": "Noor"})
        sketch = self.api(prep, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Noor’s map", "scope": "private"})

        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP)
        self.addCleanup(context.close)
        page = self.page(context)
        sockets: list[dict] = []

        def opened(ws) -> None:
            record = {"url": ws.url, "frames": 0}
            ws.on("framereceived", lambda _frame: record.__setitem__("frames", record["frames"] + 1))
            sockets.append(record)

        page.on("websocket", opened)
        page.goto("/sign-in")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.get_by_role("navigation", name="Views").get_by_role("link", name="Map").click()
        page.get_by_role("link", name=re.compile("Lamp ideas")).click()
        expect(page.get_by_role("group", name="Sketch: Lamp ideas")).to_be_visible()
        deadline = time.time() + 8
        while time.time() < deadline and not any(s["frames"] for s in sockets):
            page.wait_for_timeout(100)
        self.assertTrue(any(s["frames"] for s in sockets), "the first account's stream is live")

        # Sign out and in as the other person without leaving the tab.
        page.get_by_role("button", name=re.compile(NAME)).click()
        page.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click()
        expect(page).to_have_url(re.compile(r"/sign-in"))
        before = len(sockets)
        page.get_by_label("Email").fill(other_email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.get_by_role("navigation", name="Views").get_by_role("link", name="Map").click()
        page.get_by_role("link", name=re.compile("Noor’s map")).click()
        expect(page.get_by_role("group", name="Sketch: Noor’s map")).to_be_visible()

        # A change from Noor's other session arrives live in this tab.
        page.wait_for_timeout(500)
        self.api(prep, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Arrives after the switch", "x": 40, "y": 40})
        expect(page.locator(".sk-node", has_text="Arrives after the switch")).to_be_visible(timeout=10000)
        after = sockets[before:]
        self.assertTrue(after, "a new stream opened for the second account")
        self.assertNotIn("cursor=", after[0]["url"], "the first account's cursor is not reused")
        self.assertLessEqual(len(after), 2, f"no reconnect loop: {after}")
        self.assertTrue(any(s["frames"] for s in after), "the second account's stream delivers")


if __name__ == "__main__":
    unittest.main(verbosity=2)
