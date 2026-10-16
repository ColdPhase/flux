"""Browser tests for one private message bubble (#503 AC-3 and AC-5; #534, #536, #537).

Four people share a workspace: Ada, Kai and Lee are in the group message "Lamp crew", Max is in the
workspace but not in it. They cover: actions beside the bubble instead of a permanent Reply (computer) and
swipe right and long press (phone); a private reply thread whose count stays under its root and which
survives a reload; real "Seen by" receipts that need every message of a run to be observed (offscreen
messages do not count) and update live; and an explicit excerpt-to-task copy that previews the text, the
project and the audience, writes nothing on cancel, copies only the chosen excerpt and survives a lost
response. Screenshots (dm-threads-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from message_gestures import centre, long_press, swipe, touch
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "messages between friends"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.t+{STAMP}@example.test"),
    "kai": ("Kai Tanaka", f"kai.t+{STAMP}@example.test"),
    "lee": ("Lee Moreno", f"lee.t+{STAMP}@example.test"),
    "max": ("Max Weber", f"max.t+{STAMP}@example.test"),
}
ROOT_TEXT = "Should the lamp dim with a wave of the hand?"
CHOSEN = "dim with a wave"
FILLERS = 24


class DmThreadsReceipts(unittest.TestCase):
    """Tests run in name order and share the accounts, the workspace and the group message."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    project_id = ""
    dm_id = ""
    root = ""
    run_x: list[str] = []
    run_y = ""

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
        cls.workspace_id = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)["id"]
        for key in ("kai", "lee", "max"):
            cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE[key][1], "role": "member"}, 201)
        cls.project_id = cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Garden sensors", "visibility": "workspace"}, 201)["id"]
        cls.dm_id = cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/dms", {"participantIds": [cls.ids["kai"], cls.ids["lee"]], "title": "Lamp crew"}, 201)["id"]
        n = 0

        def say(who: str, body: str) -> str:
            nonlocal n
            n += 1
            return cls.post(who, f"/api/v1/dms/{cls.dm_id}/messages", {"body": body, "clientMessageId": f"00000000-0000-4000-8000-{n:012d}"}, 201)["id"]

        cls.root = say("kai", ROOT_TEXT)
        cls.run_x = [say("ada", "I think so. Wave to dim, hold to switch off."), say("ada", "Let me sketch it tonight.")]
        for index in range(FILLERS):
            say("kai", f"Parts note {index + 1}: the sensor board is in the second drawer.")
        cls.run_y = say("ada", "Ordering the sensors now.")

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

    def get(self, page: Page, path: str) -> dict:
        response = page.request.get(path)
        return json.loads(response.text()) if response.text() else {}

    def tasks(self, page: Page) -> list[dict]:
        return self.get(page, f"/api/v1/projects/{self.project_id}/work?limit=100")["items"]

    def row(self, page: Page, message_id: str):
        return page.locator(f"#message-{message_id}")

    def run_footer(self, page: Page, message_id: str):
        return self.row(page, message_id).locator(".message-time")

    # ------------------------------------------------------------------ actions beside the bubble

    def test_01_actions_appear_beside_the_hovered_bubble_and_reply_is_not_permanent(self) -> None:
        page = self.page("ada")
        page.goto(f"/dm/{self.dm_id}")
        expect(page.locator(".dm-msg").first).to_be_visible()
        self.row(page, self.root).scroll_into_view_if_needed()
        row = self.row(page, self.root)
        actions = row.get_by_role("group", name="Actions on this message")
        # Nothing permanent: the pill is transparent and inert until the bubble is hovered or focused.
        self.assertEqual(actions.evaluate("el => getComputedStyle(el).opacity"), "0")
        self.assertEqual(page.get_by_text("Reply", exact=True).count(), 0, "no permanent Reply link")
        row.locator(".dm-msg__body").hover()
        expect(actions).to_have_css("opacity", "1")
        self.assertEqual([b.get_attribute("aria-label") for b in actions.get_by_role("button").all()], ["Reply in thread", "Create task", "More actions"])
        body, pill = row.locator(".dm-msg__body").bounding_box(), actions.bounding_box()
        assert body and pill
        self.assertGreaterEqual(pill["x"], body["x"] + body["width"] - 1, "the actions sit beside the bubble, not over its text")
        shot(page, "dm-threads-desktop-actions-light")
        # More lists only real, authorized commands.
        actions.get_by_role("button", name="More actions").click()
        menu = page.get_by_role("menu", name="Message actions")
        self.assertEqual([i.inner_text().strip() for i in menu.get_by_role("menuitem").all()], ["Reply in thread", "Create task", "Copy text"])
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        # Own bubbles take the actions on their left.
        own = self.row(page, self.run_x[0])
        own.locator(".dm-msg__body").hover()
        own_body, own_pill = own.locator(".dm-msg__body").bounding_box(), own.get_by_role("group", name="Actions on this message").bounding_box()
        assert own_body and own_pill
        self.assertLessEqual(own_pill["x"] + own_pill["width"], own_body["x"] + 1)

    # ------------------------------------------------------------------ private reply thread

    def test_02_a_private_reply_thread_with_a_visible_count_that_survives_reload(self) -> None:
        kai = self.page("kai")
        kai.goto(f"/dm/{self.dm_id}")
        expect(self.row(kai, self.run_y)).to_be_visible()
        ada = self.page("ada")
        ada.goto(f"/dm/{self.dm_id}")
        row = self.row(ada, self.root)
        row.scroll_into_view_if_needed()
        self.assertEqual(row.locator(".dm-replies").count(), 0, "no count before there is a thread")
        row.locator(".dm-msg__body").hover()
        row.get_by_role("button", name="Reply in thread").click()
        panel = ada.locator("[data-dm-thread]")
        expect(panel).to_be_visible()
        expect(ada).to_have_url(re.compile(rf"\?thread={self.root}"))
        expect(ada.locator("#dm-thread-composer")).to_be_focused()
        panel.locator("#dm-thread-composer").fill("Yes. A wave, and a long hold to switch off.")
        panel.locator("#dm-thread-composer").press("Enter")
        expect(panel.locator(".dm-msg__body", has_text="long hold to switch off")).to_be_visible()
        expect(panel.locator("[data-client-message-id]")).to_have_count(0)
        shot(ada, "dm-threads-desktop-thread-light")
        # The count stays visible under the root, for everyone in the conversation, live.
        expect(row.locator(".dm-replies")).to_have_text("1 reply")
        expect(self.row(kai, self.root).locator(".dm-replies")).to_have_text("1 reply", timeout=15000)
        status = self.get(ada, f"/api/v1/dms/{self.dm_id}/threads/{self.root}")
        self.assertEqual([m["body"] for m in status["replies"]], ["Yes. A wave, and a long hold to switch off."])
        # The reply is not a message of the conversation itself.
        main = self.get(ada, f"/api/v1/dms/{self.dm_id}")
        self.assertNotIn(status["replies"][0]["id"], [m["id"] for m in main["messages"]])
        # Reload: the same canonical state, with the thread still open.
        ada.reload()
        expect(ada.locator("[data-dm-thread] .dm-msg__body", has_text="long hold to switch off")).to_be_visible()
        expect(self.row(ada, self.root).locator(".dm-replies")).to_have_text("1 reply")
        # Esc closes it and the message that opened it takes focus back.
        ada.locator("#dm-thread-composer").focus()
        ada.keyboard.press("Escape")
        expect(ada.locator("[data-dm-thread]")).to_have_count(0)
        expect(self.row(ada, self.root)).to_be_focused()
        # Opening the count row reopens it.
        self.row(ada, self.root).locator(".dm-replies").click()
        expect(ada.locator("[data-dm-thread]")).to_be_visible()

    def test_03_nobody_outside_the_conversation_reaches_the_thread(self) -> None:
        max_ = self.page("max")
        max_.goto(f"/dm/{self.dm_id}?thread={self.root}")
        expect(max_.get_by_role("heading", name="This conversation isn’t available")).to_be_visible()
        self.assertNotIn("long hold", max_.content())
        for path in (f"/api/v1/dms/{self.dm_id}/threads/{self.root}", f"/api/v1/dms/{self.dm_id}"):
            self.assertEqual(max_.request.get(path).status, 404)

    # ------------------------------------------------------------------ real "Seen by" receipts

    def test_04_seen_by_needs_every_message_of_the_run_to_be_observed(self) -> None:
        ada = self.page("ada")
        ada.goto(f"/dm/{self.dm_id}")
        expect(self.row(ada, self.run_y)).to_be_visible()
        # Kai already read the end of the conversation in the thread test: the last run is claimed for Kai, the earlier
        # run (far above his screen) is not, and sending or an open composer is not an observation.
        expect(self.run_footer(ada, self.run_y).locator(".message-seen")).to_have_text(re.compile(r"Seen by Kai$"), timeout=20000)
        expect(self.run_footer(ada, self.run_x[1]).locator(".message-seen")).to_have_count(0)

        kai = self.page("kai")
        kai.goto(f"/dm/{self.dm_id}")
        expect(self.row(kai, self.run_y)).to_be_in_viewport()
        # The earlier run is far above Kai's screen: not one of its messages was observed, so nothing is claimed.
        self.assertEqual(self.post_receipts(ada, [self.run_x]), [[]], "the server agrees: offscreen messages are not observed")

        lee = self.page("lee")
        lee.goto(f"/dm/{self.dm_id}")
        expect(self.row(lee, self.run_y)).to_be_in_viewport()
        expect(self.run_footer(ada, self.run_y).locator(".message-seen")).to_have_text(re.compile(r"Seen by Kai and Lee$"), timeout=20000)
        expect(self.run_footer(ada, self.run_x[1]).locator(".message-seen")).to_have_count(0)

        # Kai scrolls up and reads the whole earlier run; reading it makes the claim true for Kai alone.
        self.row(kai, self.run_x[0]).scroll_into_view_if_needed()
        self.row(kai, self.run_x[1]).scroll_into_view_if_needed()
        expect(self.run_footer(ada, self.run_x[1]).locator(".message-seen")).to_have_text(re.compile(r"Seen by Kai$"), timeout=20000)
        self.assertEqual(self.post_receipts(ada, [self.run_x, self.run_x[:1]]), [["Kai Tanaka"], ["Kai Tanaka"]])
        shot(ada, "dm-threads-desktop-seen-light")

    def test_05_seen_by_in_the_thread_and_for_a_person_who_left(self) -> None:
        ada = self.page("ada")
        ada.goto(f"/dm/{self.dm_id}?thread={self.root}")
        reply = ada.locator("[data-dm-thread] .dm-msg.is-mine").last
        expect(reply).to_be_visible()
        kai = self.page("kai")
        kai.goto(f"/dm/{self.dm_id}?thread={self.root}")
        expect(kai.locator("[data-dm-thread] .dm-msg__body", has_text="long hold to switch off")).to_be_in_viewport()
        expect(reply.locator(".message-seen")).to_have_text(re.compile(r"Seen by Kai$"), timeout=20000)
        # A person who left is never named again, whatever they saw.
        lee = self.context("lee")
        left = lee.request.post(f"/api/v1/dms/{self.dm_id}/leave", headers={"origin": ORIGIN})
        self.assertEqual(left.status, 204)
        ada.goto(f"/dm/{self.dm_id}")
        expect(self.run_footer(ada, self.run_y).locator(".message-seen")).to_have_text(re.compile(r"Seen by Kai$"), timeout=20000)

    @staticmethod
    def scrolled(page: Page) -> None:
        """Waits until the scroll that just happened has been reported, so it cannot close a row that is revealed next."""
        page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")

    def post_receipts(self, page: Page, runs: list[list[str]]) -> list[list[str]]:
        response = page.request.post(f"/api/v1/dms/{self.dm_id}/receipts", data={"runs": runs}, headers={"origin": ORIGIN})
        self.assertEqual(response.status, 200, response.text())
        return [sorted(p["name"] for p in run["seenBy"]) for run in response.json()["runs"]]

    # ------------------------------------------------------------------ excerpt to a project task

    def test_06_create_task_previews_the_excerpt_and_audience_and_cancel_writes_nothing(self) -> None:
        page = self.page("ada")
        page.goto(f"/dm/{self.dm_id}")
        row = self.row(page, self.root)
        row.scroll_into_view_if_needed()
        before = len(self.tasks(page))
        # Select part of the text, then Create task: the dialog starts from exactly that selection.
        page.evaluate("""([id, chosen]) => {
          const text = document.querySelector(`#message-${id} .dm-msg__body`).firstChild;
          const range = document.createRange();
          range.setStart(text, text.textContent.indexOf(chosen)); range.setEnd(text, text.textContent.indexOf(chosen) + chosen.length);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }""", [self.root, CHOSEN])
        row.locator(".dm-msg__body").hover()
        row.get_by_role("button", name="Create task").click()
        dialog = page.get_by_role("dialog", name="Create a task from this message")
        expect(dialog).to_be_visible()
        expect(dialog.get_by_label("Text that will be copied")).to_have_text(CHOSEN)
        expect(dialog.get_by_text("Garden sensors", exact=True)).to_be_visible()
        audience = dialog.locator("[data-audience]")
        for name in ("Ada Kowalska", "Kai Tanaka", "Max Weber"):
            expect(audience).to_contain_text(name)
        # Max is in the workspace project but not in this conversation: the dialog says so before anything is shared.
        expect(dialog.locator(".dm-copy__warn")).to_contain_text("not in this conversation")
        shot(page, "dm-threads-desktop-copy-light")
        self.assertEqual(len(self.tasks(page)), before, "a preview writes nothing")
        dialog.get_by_role("button", name="Cancel").click()
        expect(dialog).to_have_count(0)
        self.assertEqual(len(self.tasks(page)), before, "cancel writes nothing")
        expect(row).to_be_focused()

        # A lost response is retried and creates exactly one task, carrying only the chosen excerpt.
        page.evaluate("""([id, chosen]) => {
          const text = document.querySelector(`#message-${id} .dm-msg__body`).firstChild;
          const range = document.createRange();
          range.setStart(text, text.textContent.indexOf(chosen)); range.setEnd(text, text.textContent.indexOf(chosen) + chosen.length);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }""", [self.root, CHOSEN])
        row.locator(".dm-msg__body").hover()
        row.get_by_role("button", name="Create task").click()
        expect(dialog).to_be_visible()
        state = {"lost": False}

        def lose_first(route):
            if route.request.method == "POST" and not state["lost"]:
                state["lost"] = True
                route.fetch()  # the server commits ...
                route.abort("failed")  # ... but the browser never hears back
                return
            route.continue_()

        page.route("**/api/v1/dms/*/task-copies", lose_first)
        dialog.get_by_role("button", name="Create task").click()
        expect(dialog.get_by_role("alert")).to_contain_text("not created")
        dialog.get_by_role("button", name="Create task").click()
        expect(dialog).to_have_count(0)
        expect(page.get_by_text("Task created in Garden sensors")).to_be_visible()
        made = [t for t in self.tasks(page) if t["outcome"] == CHOSEN]
        self.assertEqual(len(made), 1, "one task, however many attempts")
        self.assertEqual(made[0]["createdBy"]["id"], self.ids["ada"])
        text = json.dumps(made[0])
        for private in (self.dm_id, self.root, "Kai Tanaka", "wave of the hand", "Lamp crew"):
            self.assertNotIn(private, text, "the copy carries nothing of the private conversation")
        self.assertEqual(made[0]["links"], [])
        # Max reads the task in the project: the excerpt and who copied it, no way back into the conversation.
        maxp = self.page("max")
        maxp.goto(f"/projects/{self.project_id}/tasks?open=work:{made[0]['id']}")
        expect(maxp.get_by_text(CHOSEN).first).to_be_visible()
        self.assertEqual(maxp.request.get(f"/api/v1/dms/{self.dm_id}").status, 404)

    def test_07_phone_swipe_right_long_press_and_the_sheets(self) -> None:
        page = self.page("kai", phone=True)
        page.goto(f"/dm/{self.dm_id}")
        expect(page.locator(".dm-msg").first).to_be_visible()
        row = self.row(page, self.root)
        row.scroll_into_view_if_needed()
        self.scrolled(page)
        # The thread count row is visible without any gesture.
        expect(row.locator(".dm-replies")).to_have_text("1 reply")
        # A swipe right the way a finger makes it: each step waits for the row to have followed the one before.
        body = row.locator(".dm-msg__body")
        x, y = centre(body)
        touch(body, "pointerdown", x, y)
        touch(body, "pointermove", x + 40, y)
        expect(row).to_have_class(re.compile(r"is-dragging"))
        touch(body, "pointermove", x + 80, y)
        expect(row).to_have_css("transform", re.compile(r"matrix\(1, 0, 0, 1, 80, 0\)"))
        shot(page, "dm-threads-phone-swipe-light")
        touch(body, "pointerup", x + 80, y)
        panel = page.locator("[data-dm-thread]")
        expect(panel).to_be_visible()
        expect(panel.locator(".dm-msg__body", has_text="long hold to switch off")).to_be_visible()
        shot(page, "dm-threads-phone-thread-light")
        page.get_by_role("button", name="Close replies").click()
        expect(panel).to_have_count(0)
        expect(row).to_be_focused()
        # Long press opens the menu; Create task opens the preview as a sheet.
        long_press(row.locator(".dm-msg__body"))
        menu = page.get_by_role("menu", name="Message actions")
        self.assertEqual([i.inner_text().strip() for i in menu.get_by_role("menuitem").all()], ["Reply in thread", "Create task", "Copy text"])
        menu.get_by_role("menuitem", name="Create task").click()
        dialog = page.get_by_role("dialog", name="Create a task from this message")
        expect(dialog).to_be_visible()
        expect(dialog.get_by_label("Text that will be copied")).to_have_text(ROOT_TEXT)
        box = dialog.bounding_box()
        assert box
        self.assertLessEqual(box["x"] + box["width"], PHONE["width"] + 1, "the sheet fits the phone")
        shot(page, "dm-threads-phone-copy-light")
        dialog.get_by_role("button", name="Cancel").click()
        expect(dialog).to_have_count(0)
        # The plain gesture helper (a burst of pointer events): nothing swipes left, and a short swipe right springs back.
        other = self.row(page, self.run_y)
        other.scroll_into_view_if_needed()
        self.scrolled(page)
        swipe(other.locator(".dm-msg__body"), -150)
        expect(other).not_to_have_class(re.compile(r"is-swiped"))
        swipe(other.locator(".dm-msg__body"), 40)
        expect(other).not_to_have_class(re.compile(r"is-swiped"))
        expect(page.locator("[data-dm-thread]")).to_have_count(0)

    def test_08_project_conversation_roots_and_thread_replies_show_real_receipts(self) -> None:
        import uuid

        def start(who: str, body: str) -> dict:
            return self.post(who, f"/api/v1/projects/{self.project_id}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)

        first = start("ada", "Sensor board arrives Thursday.")
        second = start("ada", "I will wire the first prototype on Friday.")
        a, b = first["messages"][0]["id"], second["messages"][0]["id"]
        ada = self.page("ada")
        ada.goto(f"/projects/{self.project_id}")
        expect(ada.locator(f"#message-{b}")).to_be_visible()
        expect(ada.locator(".message-seen")).to_have_count(0)
        # Kai reads the end of the stream: both roots of Ada's run are on his screen, so the footer appears live.
        kai = self.page("kai")
        kai.goto(f"/projects/{self.project_id}")
        expect(kai.locator(f"#message-{b}")).to_be_in_viewport()
        expect(ada.locator(f"#message-{b} .message-seen")).to_have_text(re.compile(r"Seen by Kai$"), timeout=30000)
        expect(ada.locator(f"#message-{a} .message-seen")).to_have_count(0)
        # A thread: Ada's reply is claimed only once Kai has the thread open.
        self.post("ada", f"/api/v1/conversations/{second['id']}/messages", {"body": "Reply from the bench.", "clientMessageId": str(uuid.uuid4())}, 201)
        ada.goto(f"/projects/{self.project_id}/conversations/{second['id']}")
        reply = ada.locator("[id^=message-].is-mine", has_text="Reply from the bench.")
        expect(reply).to_be_visible()
        expect(reply.locator(".message-seen")).to_have_count(0)
        kai.goto(f"/projects/{self.project_id}/conversations/{second['id']}")
        expect(kai.locator("[id^=message-]", has_text="Reply from the bench.")).to_be_in_viewport()
        expect(reply.locator(".message-seen")).to_have_text(re.compile(r"Seen by Kai$"), timeout=30000)
        shot(ada, "dm-threads-desktop-project-thread-seen-light")
        # The API agrees, and an outsider to the project's audience learns nothing.
        runs = ada.request.post(f"/api/v1/projects/{self.project_id}/receipts", data={"runs": [[a, b]]}, headers={"origin": ORIGIN})
        self.assertEqual([[p["name"] for p in run["seenBy"]] for run in runs.json()["runs"]], [["Kai Tanaka"]])

    def test_09_dark_theme_screens(self) -> None:
        page = self.page("ada", dark=True)
        page.goto(f"/dm/{self.dm_id}?thread={self.root}")
        expect(page.locator("[data-dm-thread] .dm-msg__body", has_text="long hold")).to_be_visible()
        shot(page, "dm-threads-desktop-thread-dark")
        self.row(page, self.root).locator(".dm-msg__body").hover()
        self.row(page, self.root).get_by_role("button", name="Create task").click()
        expect(page.get_by_role("dialog", name="Create a task from this message")).to_be_visible()
        shot(page, "dm-threads-desktop-copy-dark")
        page.get_by_role("button", name="Cancel").click()
        phone = self.page("ada", phone=True, dark=True)
        phone.goto(f"/dm/{self.dm_id}")
        expect(self.run_footer(phone, self.run_y).locator(".message-seen")).to_have_text(re.compile(r"Seen by Kai$"), timeout=20000)
        shot(phone, "dm-threads-phone-seen-dark")


if __name__ == "__main__":
    unittest.main()
