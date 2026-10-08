"""Browser tests for the conversation as drawn in the final design (F-026 S5-S8, P5, #343).

Authors share one left edge; task notices say where the task came from and fold when several arrive in a
row; "Since you left" jumps to the first unread item; the composer offers "@" and "/" instead of Ask and
Cite buttons; a computer shows hover actions, a phone swipe left and long press. Runs at 1440x900 and
390x844 with touch, in light and dark, and with the keyboard. Ada manages the project and Jonas writes.
Screenshots (conversation-final-*.png) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from author_columns import assert_author_column
from message_gestures import centre, long_press, swipe, touch
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "a calm and long passphrase"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.final+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.final+{STAMP}@example.test"),
}
FAR_BED = "Far east bed: -112 dBm through the hedge."
PROBES = "The probes arrive Thursday. Someone should calibrate them at two depths."
THANKS = "Thanks, I will check the depths tonight."
FROM_MESSAGE = "Calibrate the probes at two soil depths"
IN_TASKS = "Ask the supplier for the probe drawing"
ON_MAP = "Print a label for each bed"
FILLERS = 14
FOLDED = ["Rain-test one enclosure", "Write the volunteer guide", "Order spare batteries", "Check the gateway antenna"]
ORDER = "Then I will order from the second supplier."


class ConversationFinal(unittest.TestCase):
    """Tests run in name order and share two accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        contexts: dict[str, BrowserContext] = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def call(who: str, path: str, body: dict | None = None, method: str = "POST") -> dict:
            response = contexts[who].request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        ws = call("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})
        call("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        pid = call("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"})["id"]
        call("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"})
        start = lambda who, body: call(who, f"/api/v1/projects/{pid}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731
        task = lambda who, body: call(who, f"/api/v1/projects/{pid}/work", {**body, "clientCommandId": str(uuid.uuid4())})  # noqa: E731
        sketch = call("ada", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Garden map", "scope": "project", "projectId": pid})["id"]
        thought = call("ada", f"/api/v1/sketches/{sketch}/thoughts", {"text": ON_MAP, "x": 0, "y": 0})["thought"]["id"]

        start("jonas", FAR_BED)
        probes = start("jonas", PROBES)
        from_message = task("ada", {"title": FROM_MESSAGE, "sources": [{"type": "message", "id": probes["messages"][0]["id"]}]})
        thanks = start("jonas", THANKS)
        in_tasks = task("ada", {"title": IN_TASKS})
        start("jonas", "Is the label printer free on Friday?")
        on_map = task("ada", {"title": ON_MAP, "sources": [{"type": "thought", "id": thought}]})
        marker = start("jonas", "Marker: Jonas has read up to here.")
        # Jonas leaves here: his return point for the project is saved at this moment.
        summary = call("jonas", f"/api/v1/return?place=project&id={pid}", method="GET")
        call("jonas", "/api/v1/return-points", {"place": {"type": "project", "id": pid}, "mark": summary["mark"]}, method="PUT")
        time.sleep(1.1)
        first_unread = start("ada", "First unread: the gateway is back online.")
        for index in range(FILLERS):
            start("ada" if index % 2 else "jonas", f"Later note {index + 1:02}: a short thought about the beds, the gateway or the probes.")
        folded = [task("ada", {"title": title}) for title in FOLDED]
        order = start("ada", ORDER)
        # A task whose announcement is older than the stream's first window, updated after Jonas left.
        old_pid = call("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Old task board", "visibility": "restricted"})["id"]
        call("ada", f"/api/v1/projects/{old_pid}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"})
        old_task = call("ada", f"/api/v1/projects/{old_pid}/work", {"title": "Reorder the weather shield", "clientCommandId": str(uuid.uuid4())})
        for index in range(56):
            call("ada", f"/api/v1/projects/{old_pid}/conversations", {"body": f"Board note {index:02}: a short line.", "clientMessageId": str(uuid.uuid4())})
        old_summary = call("jonas", f"/api/v1/return?place=project&id={old_pid}", method="GET")
        call("jonas", "/api/v1/return-points", {"place": {"type": "project", "id": old_pid}, "mark": old_summary["mark"]}, method="PUT")
        time.sleep(1.1)
        call("ada", f"/api/v1/work/{old_task['id']}", {"status": "in_progress", "expectedVersion": old_task["version"]}, method="PATCH")
        for context in contexts.values():
            context.close()
        cls.ids.update(old_project=old_pid, old_task=old_task["id"], project=pid, workspace=ws["id"], probes=probes["messages"][0]["id"], thanks=thanks["messages"][0]["id"], marker=marker["messages"][0]["id"],
                       from_message=from_message["id"], from_message_number=from_message["number"], in_tasks=in_tasks["id"], on_map=on_map["id"],
                       first_unread=first_unread["messages"][0]["id"], order=order["messages"][0]["id"], folded=json.dumps([item["id"] for item in folded]))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "storage_state": self.states[who]}
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

    def api(self, page: Page, method: str, path: str, body: dict | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        self.assertLess(response.status, 300, response.text())
        return json.loads(response.text()) if response.text() else {}

    def open(self, who: str, **options) -> Page:
        page = self.page(who, **options)
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator(f"#message-{self.ids['order']}")).to_be_visible()
        return page

    def message(self, page: Page, message_id: str) -> Locator:
        return page.locator(f"#message-{message_id}")

    def notice(self, page: Page, work_id: str) -> Locator:
        return page.locator(f'.convo-notice[data-work-id="{work_id}"]')

    def composer(self, page: Page) -> Locator:
        return page.locator("#project-composer")

    def work_titles(self, page: Page) -> list[str]:
        items = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/work?limit=100")["items"]
        return [item["title"] for item in items]

    def test_01_every_author_has_a_face_and_a_full_name_on_one_left_edge(self) -> None:
        for phone in (False, True):
            page = self.open("ada", phone=phone)
            width = PHONE["width"] if phone else DESKTOP["width"]
            label = "phone" if phone else "computer"
            rows = [self.message(page, self.ids["order"]), self.notice(page, self.ids["on_map"])]
            for row in rows:
                row.scroll_into_view_if_needed()
                assert_author_column(self, row, width, f"{label} author")
            # Every author, in messages and in events, keeps one 32 px face at the same x.
            faces = page.locator(".project-convo__message > :is(.ui-avatar, .author-face), .convo-notice > :is(.ui-avatar, .author-face)")
            xs = faces.evaluate_all("items => items.filter(el => el.getClientRects().length).map(el => Math.round(el.getBoundingClientRect().x))")
            self.assertGreater(len(xs), 3)
            self.assertEqual(len(set(xs)), 1, f"{label}: faces share one left edge, saw {sorted(set(xs))}")
            # 20 px avatars appear only as owners in task rows.
            small = page.locator(".project-convo__feed .ui-avatar--sm").evaluate_all("items => items.filter(el => el.getClientRects().length).map(el => !!el.closest('.convo-notice__owner, .convo-fold__faces'))")
            self.assertTrue(all(small), f"{label}: 20 px avatars are task owners or fold faces only")

    def test_02_a_task_notice_is_one_line_with_its_source(self) -> None:
        page = self.open("ada")
        made = self.notice(page, self.ids["from_message"])
        expect(made.locator(".convo-notice__meta strong")).to_have_text("Ada Kowalska · you")
        expect(made.locator(".convo-notice__what")).to_have_text("made a task from Jonas’s message")
        expect(self.notice(page, self.ids["in_tasks"]).locator(".convo-notice__what")).to_have_text("added a task")
        expect(self.notice(page, self.ids["on_map"]).locator(".convo-notice__what")).to_have_text("added a task on the Map")
        expect(made.locator(".convo-notice__num")).to_have_text(f"#{self.ids['from_message_number']}")
        expect(made.get_by_role("button", name=re.compile(rf"^Open task #\d+ {FROM_MESSAGE}$"))).to_be_visible()
        self.assertEqual(page.locator(".convo-notice__kind").count(), 0, "no 'New task' label any more")
        # The line is one line: the lead, the source and the time share a baseline row.
        line = made.locator(".convo-notice__meta").evaluate("el => el.getBoundingClientRect().height")
        self.assertLess(line, 30)
        # The source link takes the reader to that message and focuses it.
        made.get_by_role("button", name="Jonas’s message").click()
        expect(self.message(page, self.ids["probes"])).to_be_focused()
        # The task opens in Details.
        made.get_by_role("button", name=re.compile(rf"^Open task #\d+ {FROM_MESSAGE}$")).click()
        expect(page.locator("#details").get_by_role("heading", name=FROM_MESSAGE)).to_be_visible()
        shot(page, "conversation-final-tasknotice-desktop")

    def test_03_several_task_updates_fold_into_one_expandable_line(self) -> None:
        page = self.open("ada")
        fold = page.locator(".convo-fold")
        expect(fold).to_have_count(1)
        toggle = fold.get_by_role("button", name=re.compile(r"^4 task updates"))
        expect(toggle).to_have_attribute("aria-expanded", "false")
        expect(toggle).to_contain_text("Ada added 4 tasks")
        ids = json.loads(self.ids["folded"])
        for work_id in ids:
            expect(self.notice(page, work_id)).to_be_hidden()
        toggle.focus()
        page.keyboard.press("Enter")
        expect(toggle).to_have_attribute("aria-expanded", "true")
        for work_id in ids:
            expect(self.notice(page, work_id)).to_be_visible()
        assert_author_column(self, self.notice(page, ids[0]), DESKTOP["width"], "folded notice")
        page.keyboard.press("Space")
        expect(toggle).to_have_attribute("aria-expanded", "false")
        # Single notices (one at a time between messages) stay single.
        expect(self.notice(page, self.ids["in_tasks"])).to_be_visible()
        phone = self.open("ada", phone=True)
        expect(phone.locator(".convo-fold__b")).to_be_visible()
        self.assertGreaterEqual(phone.locator(".convo-fold__b").evaluate("el => el.getBoundingClientRect().height"), 44)

    def test_04_since_you_left_jumps_to_the_first_unread_item(self) -> None:
        for phone in (False, True):
            page = self.page("jonas", phone=phone)
            page.goto(f"/projects/{self.ids['project']}")
            expect(page.locator(f"#message-{self.ids['order']}")).to_be_visible()
            line = page.get_by_role("region", name="Since you left")
            expect(line).to_contain_text("Since you left:")
            expect(line).to_contain_text("messages")
            target = self.message(page, self.ids["first_unread"])
            self.assertFalse(target.evaluate("el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }"), "the first unread item starts out of view")
            if not phone:
                shot(page, "conversation-final-since-desktop")
            line.get_by_role("button", name="Jump to the first unread").click()
            expect(target).to_be_focused()
            self.assertTrue(target.evaluate("el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; }"), "it is brought into view")
            expect(line).to_have_count(0)

    def test_05_the_composer_has_at_and_slash_and_no_ask_or_cite_buttons(self) -> None:
        page = self.open("ada")
        composer = self.composer(page)
        expect(page.get_by_role("button", name=re.compile("^Sources"))).to_have_count(0)
        expect(page.get_by_role("button", name="Ask my assistant")).to_have_count(0)
        expect(page.locator(".composer__hint")).to_contain_text("to mention")
        # "/" lists the four actions in order, then the two commands that replaced the old buttons.
        composer.fill("/")
        menu = page.get_by_role("listbox", name="Actions")
        expect(menu).to_be_visible()
        self.assertEqual(menu.get_by_role("option").locator(".cmenu__cmd").all_inner_texts()[:4], ["/task", "/decide", "/handoff", "/file"])
        expect(composer).to_have_attribute("aria-controls", re.compile("menu$"))
        shot(page, "conversation-final-slash-desktop")
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        # Keys choose: Down, Enter makes "/decide ", and sending it opens the proposal with that title.
        composer.fill("")
        composer.fill("/")
        page.keyboard.press("ArrowDown")
        expect(menu.get_by_role("option", selected=True)).to_contain_text("/decide")
        page.keyboard.press("Enter")
        expect(composer).to_have_value("/decide ")
        page.keyboard.type("Use the second supplier")
        page.keyboard.press("Enter")
        expect(page.locator("#details").get_by_label("Decision")).to_have_value("Use the second supplier")
        expect(composer).to_have_value("")
        page.keyboard.press("Escape")
        # /task with a title makes a task and opens it.
        composer.fill("/task Order the probes from the second supplier")
        page.keyboard.press("Enter")
        expect(page.locator("#details").get_by_role("heading", name="Order the probes from the second supplier")).to_be_visible()
        self.assertIn("Order the probes from the second supplier", self.work_titles(page))
        expect(composer).to_have_value("")
        # A command without words says what is missing and posts nothing.
        composer.fill("/task")
        page.keyboard.press("Enter")
        page.keyboard.press("Escape")
        page.keyboard.press("Enter")
        expect(page.get_by_role("status").filter(has_text="Say what it is")).to_be_visible()
        composer.fill("")
        # /file opens the file chooser, /source the saved sources.
        composer.fill("/fi")
        expect(page.get_by_role("listbox", name="Actions").get_by_role("option", selected=True)).to_contain_text("/file")
        attach = page.locator(".composer__attach")
        self.assertEqual(attach.count(), 1, "one attach button")
        self.assertTrue(attach.is_enabled(), "the attach button is enabled")
        with page.expect_file_chooser(timeout=15000) as chooser:
            page.keyboard.press("Enter")
        chooser.value.set_files({"name": "bed-readings.csv", "mimeType": "text/csv", "buffer": b"bed,dbm\nfar east,-112\n"})
        expect(page.get_by_text("bed-readings.csv")).to_be_visible()
        expect(page.get_by_text("Ready, private", exact=False)).to_be_visible()
        page.get_by_role("button", name="Remove bed-readings.csv").click()
        expect(composer).to_have_value("")
        composer.fill("/source")
        page.keyboard.press("Enter")
        expect(page.get_by_role("region", name="Project materials")).to_be_visible()
        # "@" lists people and agents; the chosen name goes in as a chip that sits on the text baseline.
        composer.fill("Thanks @jo")
        people = page.get_by_role("listbox", name="Mention")
        expect(people.get_by_role("option")).to_have_count(1)
        expect(people.get_by_role("option").first).to_contain_text("Jonas Berg")
        page.keyboard.press("Enter")
        expect(composer).to_have_value("Thanks @Jonas Berg ")
        page.keyboard.type("for the depths")
        page.keyboard.press("Enter")
        sent = page.locator(".project-convo__message.is-mine").filter(has_text="for the depths")
        chip = sent.locator(".mention")
        expect(chip).to_have_text("@Jonas Berg")
        text = sent.locator(":scope > p")
        self.assertLess(text.evaluate("el => el.getBoundingClientRect().height") - 38, 4, "the chip does not lift or stretch its line")
        expect(page.get_by_role("listbox")).to_have_count(0)

    def test_06_hover_actions_on_the_computer_and_their_keyboard_path(self) -> None:
        page = self.open("ada")
        message = self.message(page, self.ids["probes"])
        message.scroll_into_view_if_needed()
        actions = message.get_by_role("group", name="Message actions")
        self.assertEqual(actions.evaluate("el => getComputedStyle(el).opacity"), "0", "actions are not shown at rest")
        message.hover()
        expect(actions).to_be_visible()
        expect(actions).to_have_css("opacity", "1")
        expect(actions.get_by_role("button")).to_have_count(3)
        shot(page, "conversation-final-hover-desktop")
        # The keyboard reaches the same actions and the menu; Escape returns to the button.
        message.get_by_role("button", name="Reply in thread").first.focus()
        expect(actions).to_be_visible()
        more = actions.get_by_role("button", name="More actions")
        more.focus()
        page.keyboard.press("Enter")
        menu = page.get_by_role("menu", name="Message actions")
        expect(menu).to_be_visible()
        names = menu.get_by_role("menuitem").all_inner_texts()
        self.assertEqual(names[:5], ["Reply in thread", "Create task", "Hand off to an agent", "Cite", "Copy text"])
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(more).to_be_focused()
        # Cite quotes the message into the composer.
        message.hover()
        more.click()
        page.get_by_role("menuitem", name="Cite").click()
        expect(self.composer(page)).to_have_value(re.compile(r"^> Jonas Berg:\n> The probes arrive Thursday"))
        self.composer(page).fill("")
        # Create task makes a task from the message and opens it.
        message.hover()
        before = len(self.work_titles(page))
        message.get_by_role("button", name="Create task").click()
        expect(page.locator("#details").get_by_role("heading", name=re.compile("^The probes arrive Thursday"))).to_be_visible()
        self.assertEqual(len(self.work_titles(page)), before + 1)
        # Reply in thread opens the thread beside the stream with the reply field focused.
        page.keyboard.press("Escape")
        message.hover()
        message.get_by_role("button", name="Reply in thread").click()
        expect(page.locator("#thread-composer")).to_be_focused()

    def test_07_swipe_left_and_long_press_on_the_phone(self) -> None:
        page = self.open("ada", phone=True)
        message = self.message(page, self.ids["probes"])
        message.scroll_into_view_if_needed()
        bubble = message.locator(":scope > p")
        expect(message.get_by_role("button", name="Create task")).to_have_count(0)
        expect(message.locator(".msg-acts")).to_have_count(0)
        # Nothing swipes right.
        swipe(bubble, 120)
        self.assertEqual(message.evaluate("el => new DOMMatrix(getComputedStyle(el).transform).m41"), 0)
        # Swipe left reveals Reply in thread, Create task and Hand off, each at least 44 px.
        swipe(bubble, -150)
        strip = message.get_by_role("group", name="Swipe actions")
        expect(strip).to_be_visible()
        labels = strip.get_by_role("button").all_inner_texts()
        self.assertEqual(labels, ["Reply in thread", "Create task", "Hand off"])
        for box in strip.get_by_role("button").evaluate_all("items => items.map(el => { const r = el.getBoundingClientRect(); return [r.width, r.height]; })"):
            self.assertGreaterEqual(min(box), 44)
        shot(page, "conversation-final-swipe-phone")
        strip.get_by_role("button", name="Reply in thread").click()
        expect(page.locator("#thread-composer")).to_be_focused()
        page.get_by_role("button", name="Close replies").click()
        # Long press opens the menu with the five drawn actions, the stream dimmed behind it.
        bubble.scroll_into_view_if_needed()
        long_press(bubble)
        menu = page.get_by_role("menu", name="Message actions")
        expect(menu).to_be_visible()
        names = menu.get_by_role("menuitem").all_inner_texts()
        self.assertEqual(names[:5], ["Reply in thread", "Create task", "Hand off to an agent", "Cite", "Copy text"])
        for box in menu.get_by_role("menuitem").evaluate_all("items => items.map(el => el.getBoundingClientRect().height)"):
            self.assertGreaterEqual(box, 44)
        shot(page, "conversation-final-messagemenu-phone")
        page.get_by_role("menuitem", name="Cite").click()
        expect(self.composer(page)).to_have_value(re.compile(r"^> Jonas Berg:\n> The probes arrive Thursday"))
        self.composer(page).fill("")
        # Escape and a tap outside close the menu; the hidden keyboard button opens the same menu.
        long_press(bubble)
        expect(menu).to_be_visible()
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        message.get_by_role("button", name="Message actions", exact=True).focus()
        page.keyboard.press("Enter")
        expect(menu).to_be_visible()
        names = menu.get_by_role("menuitem").all_inner_texts()
        self.assertEqual(names[:5], ["Reply in thread", "Create task", "Hand off to an agent", "Cite", "Copy text"])
        page.keyboard.press("Escape")
        # A scroll gesture is not a long press: nothing opens.
        swipe_down = bubble.bounding_box()
        page.mouse.move(swipe_down["x"] + 20, swipe_down["y"] + 10)
        expect(page.get_by_role("menu", name="Message actions")).to_have_count(0)

    def test_08_the_phone_composer_says_at_and_slash_and_opens_the_menu_by_touch(self) -> None:
        page = self.open("ada", phone=True)
        composer = self.composer(page)
        expect(composer).to_have_attribute("placeholder", "Message · @ · /")
        composer.fill("/")
        menu = page.get_by_role("listbox", name="Actions")
        expect(menu).to_be_visible()
        for box in menu.get_by_role("option").evaluate_all("items => items.map(el => el.getBoundingClientRect().height)"):
            self.assertGreaterEqual(box, 44)
        menu.get_by_role("option").filter(has_text="/task").tap()
        expect(composer).to_have_value("/task ")
        shot(page, "conversation-final-slash-phone")

    def test_09_light_and_dark_screens(self) -> None:
        for dark in (False, True):
            suffix = "dark" if dark else "light"
            page = self.open("ada", dark=dark)
            self.message(page, self.ids["thanks"]).scroll_into_view_if_needed()
            shot(page, f"conversation-final-desktop-{suffix}")
            fold = page.locator(".convo-fold__b")
            fold.click()
            fold.scroll_into_view_if_needed()
            shot(page, f"conversation-final-fold-desktop-{suffix}")
            phone = self.open("ada", phone=True, dark=dark)
            shot(phone, f"conversation-final-phone-{suffix}")
            # Text on the new surfaces keeps its contrast in both schemes.
            for selector in (".convo-notice__task", ".convo-fold__b", ".convo-notice__meta"):
                ratio = phone.locator(selector).first.evaluate("""el => {
                  const lum = c => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
                  let bg = el; while (bg && /rgba\\(0, 0, 0, 0\\)|transparent/.test(getComputedStyle(bg).backgroundColor)) bg = bg.parentElement;
                  const a = lum(getComputedStyle(el).color), b = lum(getComputedStyle(bg).backgroundColor);
                  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }""")
                self.assertGreaterEqual(ratio, 4.5, f"{selector} contrast in {suffix}")

    def test_10_a_thread_reply_has_the_same_actions_and_composer(self) -> None:
        page = self.open("ada")
        self.message(page, self.ids["thanks"]).hover()
        self.message(page, self.ids["thanks"]).get_by_role("button", name="Reply in thread").click()
        thread = page.locator("#thread")
        composer = page.locator("#thread-composer")
        expect(composer).to_be_focused()
        composer.fill("/")
        expect(page.get_by_role("listbox", name="Actions").get_by_role("option").locator(".cmenu__cmd")).to_contain_text(["/task", "/decide", "/handoff", "/file", "/source", "/ai"])
        page.keyboard.press("Escape")
        composer.fill("Checked the depths.")
        page.keyboard.press("Enter")
        reply = thread.locator(".project-convo__message").filter(has_text="Checked the depths.")
        expect(reply).to_be_visible()
        expect(thread.get_by_role("button", name=re.compile("^Sources"))).to_have_count(0)
        expect(thread.get_by_role("button", name="Ask my assistant")).to_have_count(0)
        assert_author_column(self, reply, DESKTOP["width"], "thread reply")
        reply.hover()
        expect(reply.get_by_role("group", name="Message actions")).to_be_visible()
        shot(page, "conversation-final-thread-desktop")

    # ---------------------------------------------------------------- review fixes (#387)

    def hold_work(self, page: Page) -> list:
        held: list = []
        page.route("**/api/v1/projects/*/work", lambda route: held.append(route) if route.request.method == "POST" else route.continue_())
        return held

    def test_11_a_slash_command_consumes_only_the_draft_it_was_given(self) -> None:
        for command in ("task", "handoff"):
            page = self.open("ada")
            composer = self.composer(page)
            held = self.hold_work(page)
            title = f"Held {command} original"
            newer = f"Newer draft typed while /{command} was on its way"
            composer.fill(f"/{command} {title}")
            composer.press("Enter")
            for _ in range(60):
                if held:
                    break
                page.wait_for_timeout(100)
            self.assertEqual(len(held), 1, "the work request is held")
            composer.fill(newer)
            held[0].continue_()
            expect(page.locator("#details").get_by_role("heading", name=title)).to_be_visible()
            page.wait_for_timeout(300)
            expect(composer).to_have_value(newer)
            self.assertEqual(self.work_titles(page).count(title), 1, "exactly the original task exists")
            page.reload()
            expect(page.locator("#project-composer")).to_have_value(newer)
            # Positive control: an unchanged draft is consumed by its command.
            page.locator("#project-composer").fill(f"/{command} Control {command} task")
            page.locator("#project-composer").press("Enter")
            expect(page.locator("#details").get_by_role("heading", name=f"Control {command} task")).to_be_visible()
            expect(page.locator("#project-composer")).to_have_value("")

    def test_12_a_task_without_a_source_does_not_claim_where_it_was_made(self) -> None:
        page = self.open("ada")
        title = "Typed in the conversation without a source"
        self.composer(page).fill(f"/task {title}")
        self.composer(page).press("Enter")
        expect(page.locator("#details").get_by_role("heading", name=title)).to_be_visible()
        made = page.locator(".convo-notice").filter(has_text=title)
        expect(made.locator(".convo-notice__what")).to_have_text("added a task")
        for text in page.locator(".convo-notice__what").all_inner_texts():
            self.assertNotIn("in Tasks", text, "no notice names Tasks as its origin")
        # A task made from a message keeps its truthful source (positive control).
        expect(self.notice(page, self.ids["from_message"]).locator(".convo-notice__what")).to_have_text("made a task from Jonas’s message")

    def test_13_short_taps_leave_no_timer_that_opens_the_next_press_early(self) -> None:
        page = self.open("ada", phone=True)
        first = self.message(page, self.ids["probes"]).locator(":scope > p")
        first.scroll_into_view_if_needed()
        menu = page.get_by_role("menu", name="Message actions")
        # The touches are fired from the page with its own clock, so the gaps are exact even on a loaded machine.
        script = """async ([a, b, scrolled]) => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const fire = (el, type, dy = 0) => { const r = el.getBoundingClientRect();
            el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 41, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
              clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 + dy, bubbles: true, cancelable: true })); };
          const open = () => !!document.querySelector('[role=menu][aria-label="Message actions"]');
          const A = document.querySelector(a), B = document.querySelector(b);
          fire(A, 'pointerdown'); await wait(40); fire(A, 'pointerup');       // a quick tap on the first message
          await wait(250); fire(B, 'pointerdown');                            // then a press on the second
          await wait(300);                                                    // 590 ms after the tap began, 300 ms into the press
          const early = open();
          await wait(350);                                                    // 650 ms held: a genuine long press
          const held = open();
          fire(B, 'pointerup');
          return { early, held };
        }"""
        result = page.evaluate(script, [f"#message-{self.ids['probes']} > p", f"#message-{self.ids['probes']} > p", False])
        self.assertFalse(result["early"], "an earlier tap's timer does not open the next press early")
        self.assertTrue(result["held"], "a real long hold still opens the menu")
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        # Moving down (a scroll) before the hold is up cancels it.
        x, y = centre(first)
        touch(first, "pointerdown", x, y)
        touch(first, "pointermove", x, y + 30)
        page.wait_for_timeout(700)
        expect(menu).to_have_count(0)
        touch(first, "pointerup", x, y + 30)

    def test_14_jump_reaches_a_task_whose_announcement_is_outside_the_loaded_window(self) -> None:
        page = self.page("jonas")
        page.goto(f"/projects/{self.ids['old_project']}")
        expect(page.locator(".project-convo__message").last).to_be_visible()
        expect(page.locator(f'.convo-notice[data-work-id="{self.ids["old_task"]}"]')).to_have_count(0)
        line = page.get_by_role("region", name="Since you left")
        expect(line).to_contain_text("task update")
        line.get_by_role("button", name="Jump to the first unread").click()
        expect(page.locator("#details").get_by_role("heading", name="Reorder the weather shield")).to_be_visible()
        expect(line).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
