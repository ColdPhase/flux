"""Browser tests for editing and deleting one's own messages (#1006, F-026 S6).

Three people share a space and a group message. The author's ⋯ menu ends, below a line, with Edit and Delete; nobody else's
message offers them. Edit puts the words in a field in place (Enter saves, Esc cancels) and the message shows "edited" beside its
time; Delete asks once, leaves "Message removed" in the same place and keeps the replies. The same on a thread reply and in a
direct message, on a phone's long-press list, and live in another person's open page. The rules (who may, what goes where) are
the API tests' (`tests/app/message-edit-delete.test.ts`).
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from message_gestures import long_press
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "words can be taken back"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.ed+{STAMP}@example.test"),
    "kai": ("Kai Tanaka", f"kai.ed+{STAMP}@example.test"),
    "lee": ("Lee Moreno", f"lee.ed+{STAMP}@example.test"),
}
OWN_MENU = ["Add to map", "Copy link", "Edit", "Delete"]
OTHER_MENU = ["Add to map", "Copy link"]
PHONE_OWN = ["Reply in thread", "Create task", "Add to map", "Copy link", "Edit", "Delete"]
PHONE_OTHER = ["Reply in thread", "Create task", "Add to map", "Copy link"]


def words(label: str) -> str:
    return f"{label} {uuid.uuid4().hex[:8]}"


class MessageEditDelete(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    project_id = ""
    dm_id = ""

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
        cls.workspace_id = cls.send("ada", "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)["id"]
        for key in ("kai", "lee"):
            cls.send("ada", "POST", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE[key][1], "role": "member"}, 201)
        cls.project_id = cls.send("ada", "POST", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Garden sensors", "visibility": "workspace"}, 201)["id"]
        cls.dm_id = cls.send("ada", "POST", f"/api/v1/workspaces/{cls.workspace_id}/dms", {"participantIds": [cls.ids["kai"], cls.ids["lee"]], "title": "Lamp crew"}, 201)["id"]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def send(cls, who: str, method: str, path: str, body: dict | None, expected: int) -> dict:
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states[who])
        try:
            response = context.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
            assert response.status == expected, f"{method} {path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}
        finally:
            context.close()

    def context(self, who: str, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
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

    def start(self, who: str, body: str) -> dict:
        """A new conversation in the space: its first message and the conversation's id."""
        made = self.send(who, "POST", f"/api/v1/projects/{self.project_id}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)
        return {"id": made["messages"][0]["id"], "conversation": made["id"]}

    def answer(self, who: str, conversation: str, body: str) -> str:
        return self.send(who, "POST", f"/api/v1/conversations/{conversation}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)["id"]

    def say(self, who: str, body: str, root: str | None = None) -> str:
        path = f"/api/v1/dms/{self.dm_id}/threads/{root}/replies" if root else f"/api/v1/dms/{self.dm_id}/messages"
        return self.send(who, "POST", path, {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)["id"]

    def menu_of(self, page: Page, message) -> list[str]:
        """Opens a message's ⋯ menu on a computer and lists its items."""
        message.hover()
        message.get_by_role("button", name="More actions").click()
        menu = page.get_by_role("menu", name="Message actions")
        expect(menu).to_be_visible()
        return [text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()]

    def search(self, page: Page, query: str) -> list[dict]:
        return page.request.get(f"/api/v1/search?q={query}").json()["items"]

    # ---------------------------------------------------------------- the space's conversation

    def test_01_only_the_author_is_offered_edit_and_delete_below_a_line(self) -> None:
        mine = self.start("ada", words("my opening"))
        theirs = self.start("kai", words("kai opening"))
        page = self.page("ada")
        page.goto(f"/projects/{self.project_id}")
        own = page.locator(f"#message-{mine['id']}")
        self.assertEqual(self.menu_of(page, own), OWN_MENU)
        menu = page.get_by_role("menu", name="Message actions")
        # One line divides Add to map and Copy link from Edit and Delete.
        expect(menu.get_by_role("separator")).to_have_count(1)
        order = menu.evaluate("el => [...el.children].map((child) => child.getAttribute('role') === 'separator' ? '---' : child.textContent.trim())")
        self.assertEqual(order, ["Add to map", "Copy link", "---", "Edit", "Delete"])
        shot(page, "edit-delete-menu-desktop")
        page.keyboard.press("Escape")
        self.assertEqual(self.menu_of(page, page.locator(f"#message-{theirs['id']}")), OTHER_MENU, "someone else's message has neither")
        page.keyboard.press("Escape")

    def test_02_edit_puts_the_words_in_a_field_enter_saves_and_the_message_says_edited(self) -> None:
        before, after = words("first words"), words("second words")
        made = self.start("ada", before)
        page = self.page("ada")
        page.goto(f"/projects/{self.project_id}")
        message = page.locator(f"#message-{made['id']}")
        self.menu_of(page, message)
        page.get_by_role("menuitem", name="Edit", exact=True).click()
        field = message.get_by_role("textbox", name="Edit message")
        expect(field).to_have_value(before)
        expect(field).to_be_focused()
        expect(message.get_by_role("button", name="Save")).to_be_visible()
        shot(page, "edit-in-place-desktop")
        # Escape puts everything back; the words are as they were.
        page.keyboard.press("Escape")
        expect(message.get_by_role("textbox")).to_have_count(0)
        expect(message).to_contain_text(before)
        expect(message).to_be_focused()
        # Edit again and save with Enter.
        self.menu_of(page, message)
        page.get_by_role("menuitem", name="Edit", exact=True).click()
        field.fill(after)
        field.press("Enter")
        expect(message.get_by_role("textbox")).to_have_count(0)
        expect(message.locator(".message-body")).to_have_text(after)
        expect(message.locator(".message-time .message-edited")).to_have_text(re.compile(r"edited"))
        # It persists and another person reads the new words with the mark; the first words are not findable any more.
        other = self.page("kai")
        other.goto(f"/projects/{self.project_id}")
        seen = other.locator(f"#message-{made['id']}")
        expect(seen.locator(".message-body")).to_have_text(after)
        expect(seen.locator(".message-edited")).to_be_visible()
        self.assertEqual(self.search(other, before.split()[-1]), [])
        self.assertEqual(len(self.search(other, after.split()[-1])), 1)

    def test_03_delete_asks_once_and_leaves_message_removed_in_the_same_place_with_its_replies(self) -> None:
        text = words("take this back")
        made = self.start("ada", text)
        reply = self.answer("kai", made["conversation"], "a reply that stays")
        page = self.page("ada")
        page.goto(f"/projects/{self.project_id}/conversations/{made['conversation']}")
        thread = page.locator("#thread")
        root = page.locator(f"#message-{made['id']}").first
        self.menu_of(page, root)
        page.get_by_role("menuitem", name="Delete", exact=True).click()
        ask = root.get_by_role("group", name="Delete this message")
        expect(ask).to_be_visible()
        expect(ask.get_by_role("button", name="Keep")).to_be_focused()
        shot(page, "delete-ask-desktop")
        page.keyboard.press("Escape")
        expect(ask).to_have_count(0)
        expect(root).to_contain_text(text)
        self.menu_of(page, root)
        page.get_by_role("menuitem", name="Delete", exact=True).click()
        root.get_by_role("button", name="Delete", exact=True).click()
        expect(root.locator(".message-body--removed")).to_have_text("Message removed")
        expect(root).not_to_contain_text(text)
        # The thread and its reply are still there, and a removed message offers Copy link and Reply in thread only.
        expect(thread.locator(f"#message-{reply}")).to_contain_text("a reply that stays")
        self.assertEqual(self.menu_of(page, root.first), ["Copy link"])
        shot(page, "delete-removed-desktop")
        page.keyboard.press("Escape")
        self.assertEqual(self.search(page, text.split()[-1]), [])
        page.reload()
        expect(page.locator(f"#message-{made['id']}").first.locator(".message-body--removed")).to_have_text("Message removed")

    def test_04_a_thread_reply_is_edited_and_deleted_in_the_thread(self) -> None:
        made = self.start("kai", words("kai asks"))
        mine = self.answer("ada", made["conversation"], words("ada answers"))
        page = self.page("ada")
        page.goto(f"/projects/{self.project_id}/conversations/{made['conversation']}")
        thread = page.locator("#thread")
        reply = thread.locator(f"#message-{mine}")
        expect(reply).to_be_visible()
        self.assertEqual(self.menu_of(page, reply), OWN_MENU)
        page.get_by_role("menuitem", name="Edit", exact=True).click()
        field = reply.get_by_role("textbox", name="Edit message")
        changed = words("answer changed")
        field.fill(changed)
        reply.get_by_role("button", name="Save").click()
        expect(reply.locator(".message-body")).to_have_text(changed)
        expect(reply.locator(".message-edited")).to_be_visible()
        self.assertEqual(self.menu_of(page, page.locator(f"#message-{made['id']}").first), OTHER_MENU, "the root is Kai's")
        page.keyboard.press("Escape")
        self.menu_of(page, reply)
        page.get_by_role("menuitem", name="Delete", exact=True).click()
        reply.get_by_role("button", name="Delete", exact=True).click()
        expect(reply.locator(".message-body--removed")).to_have_text("Message removed")

    def test_05_another_open_page_follows_an_edit_and_a_delete_live(self) -> None:
        first, second = words("live first"), words("live second")
        made = self.start("ada", first)
        watcher = self.page("kai")
        watcher.goto(f"/projects/{self.project_id}")
        seen = watcher.locator(f"#message-{made['id']}")
        expect(seen.locator(".message-body")).to_have_text(first)
        self.send("ada", "PATCH", f"/api/v1/conversations/{made['conversation']}/messages/{made['id']}", {"body": second}, 200)
        expect(seen.locator(".message-body")).to_have_text(second, timeout=20000)
        expect(seen.locator(".message-edited")).to_be_visible()
        self.send("ada", "DELETE", f"/api/v1/conversations/{made['conversation']}/messages/{made['id']}", None, 200)
        expect(seen.locator(".message-body--removed")).to_have_text("Message removed", timeout=20000)

    def test_06_a_failed_save_says_so_and_keeps_the_words_in_the_field(self) -> None:
        made = self.start("ada", words("will not save"))
        page = self.page("ada")
        page.goto(f"/projects/{self.project_id}")
        message = page.locator(f"#message-{made['id']}")
        self.menu_of(page, message)
        page.get_by_role("menuitem", name="Edit", exact=True).click()
        page.route(re.compile(rf"/api/v1/conversations/{made['conversation']}/messages/{made['id']}$"),
                   lambda route: route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": "Try later", "code": "UNAVAILABLE"})))
        field = message.get_by_role("textbox", name="Edit message")
        field.fill("typed but not saved")
        message.get_by_role("button", name="Save").click()
        expect(page.locator(".ui-toast", has_text="Could not save")).to_be_visible()
        expect(field).to_have_value("typed but not saved")

    # ---------------------------------------------------------------- the phone

    def test_07_a_phone_long_press_lists_edit_and_delete_for_own_messages_only(self) -> None:
        mine = self.start("ada", words("phone mine"))
        theirs = self.start("kai", words("phone theirs"))
        page = self.page("ada", phone=True)
        page.goto(f"/projects/{self.project_id}")
        for message, expected in ((mine, PHONE_OWN), (theirs, PHONE_OTHER)):
            bubble = page.locator(f"#message-{message['id']} .message-bubble > .message-body")
            bubble.scroll_into_view_if_needed()
            long_press(bubble)
            menu = page.get_by_role("menu", name="Message actions")
            expect(menu).to_be_visible()
            self.assertEqual([text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()], expected)
            if expected is PHONE_OWN:
                expect(menu.get_by_role("separator")).to_have_count(1)
                shot(page, "edit-delete-menu-phone")
            page.keyboard.press("Escape")
        # Edit on the phone: Enter adds a line, the Save button saves.
        bubble = page.locator(f"#message-{mine['id']} .message-bubble > .message-body")
        long_press(bubble)
        page.get_by_role("menuitem", name="Edit", exact=True).click()
        field = page.locator(f"#message-{mine['id']}").get_by_role("textbox", name="Edit message")
        field.fill("changed on a phone")
        field.press("Enter")
        expect(field).to_be_visible()
        page.locator(f"#message-{mine['id']}").get_by_role("button", name="Save").click()
        expect(page.locator(f"#message-{mine['id']} .message-body")).to_contain_text("changed on a phone")

    # ---------------------------------------------------------------- direct messages

    def test_08_a_direct_message_and_its_reply_are_edited_and_deleted_the_same_way(self) -> None:
        root = self.say("ada", words("dm opening"))
        theirs = self.say("kai", words("kai in dm"))
        reply = self.say("ada", words("ada private reply"), root)
        page = self.page("ada")
        page.goto(f"/dm/{self.dm_id}")
        message = page.locator(f"#message-{root}")
        expect(message).to_be_visible()
        self.assertEqual(self.menu_of(page, message), OWN_MENU)
        page.keyboard.press("Escape")
        self.assertEqual(self.menu_of(page, page.locator(f"#message-{theirs}")), OTHER_MENU)
        page.keyboard.press("Escape")
        self.menu_of(page, message)
        page.get_by_role("menuitem", name="Edit", exact=True).click()
        changed = words("dm changed")
        field = message.get_by_role("textbox", name="Edit message")
        field.fill(changed)
        field.press("Enter")
        expect(message.locator(".dm-msg__body")).to_have_text(changed)
        expect(message.locator(".message-edited")).to_be_visible()
        # The thread: its reply is edited and deleted in the panel; the root stays.
        page.goto(f"/dm/{self.dm_id}?thread={root}")
        panel = page.locator("[data-dm-thread]")
        mine = panel.locator(f"#thread-message-{reply}")
        expect(mine).to_be_visible()
        self.assertEqual(self.menu_of(page, mine), OWN_MENU)
        page.get_by_role("menuitem", name="Delete", exact=True).click()
        mine.get_by_role("button", name="Delete", exact=True).click()
        expect(mine.locator(".message-body--removed")).to_have_text("Message removed")
        expect(panel.locator(f"#thread-message-{root}").locator(".dm-msg__body")).to_have_text(changed)
        # The other person's open conversation follows.
        other = self.page("kai")
        other.goto(f"/dm/{self.dm_id}")
        expect(other.locator(f"#message-{root} .dm-msg__body")).to_have_text(changed)
        other.wait_for_timeout(2000)  # the stream of this page is open before the change is made
        self.send("ada", "DELETE", f"/api/v1/dms/{self.dm_id}/messages/{root}", None, 200)
        expect(other.locator(f"#message-{root} .message-body--removed")).to_have_text("Message removed", timeout=20000)
        self.assertEqual(self.search(other, changed.split()[-1]), [])


if __name__ == "__main__":
    unittest.main()
