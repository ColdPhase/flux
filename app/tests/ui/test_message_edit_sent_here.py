"""Browser tests for editing and deleting a message the person has just SENT from the composer on this page (#1006).

The page keeps a copy of every message its composer sent, to show it at once. That copy must never hide a later change: the author
who sends, spots a typo and fixes it (or takes the message back) sees the new words with "edited", or "Message removed", in the same
place, on the same page, without a reload. `test_message_edit_delete` seeds its messages through the API and so never takes this path.
Covered: a reply in a space's thread, a direct message and a reply in a direct message's thread; and the same person's other tab
changing a message this tab sent. The rules (who may, what goes where) are the API tests' (`tests/app/message-edit-delete.test.ts`).
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "words can be taken back"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.sent+{STAMP}@example.test"), "kai": ("Kai Tanaka", f"kai.sent+{STAMP}@example.test")}
ID = re.compile(r"^(?:thread-)?message-([0-9a-f-]{36})$")


def words(label: str) -> str:
    return f"{label} {uuid.uuid4().hex[:8]}"


class EditedAfterSentHere(unittest.TestCase):
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
        cls.workspace_id = cls.send("ada", "POST", "/api/v1/workspaces", {"name": "Typos"}, 201)["id"]
        cls.send("ada", "POST", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE["kai"][1], "role": "member"}, 201)
        cls.project_id = cls.send("ada", "POST", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Garden", "visibility": "workspace"}, 201)["id"]
        cls.dm_id = cls.send("ada", "POST", f"/api/v1/workspaces/{cls.workspace_id}/dms", {"participantIds": [cls.ids["kai"]]}, 201)["id"]

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

    def page(self, who: str) -> Page:
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, locale="en-GB", storage_state=self.states[who], viewport=DESKTOP)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def conversation_by_kai(self) -> str:
        made = self.send("kai", "POST", f"/api/v1/projects/{self.project_id}/conversations", {"body": words("kai asks"), "clientMessageId": str(uuid.uuid4())}, 201)
        return made["id"]

    def dm_root_by_kai(self) -> str:
        return self.send("kai", "POST", f"/api/v1/dms/{self.dm_id}/messages", {"body": words("kai opens"), "clientMessageId": str(uuid.uuid4())}, 201)["id"]

    def typed(self, page: Page, field: str, text: str) -> None:
        """Sends `text` from the composer, the way a person does."""
        page.locator(field).fill(text)
        page.locator(field).press("Enter")

    def stored(self, scope: Locator, text: str) -> tuple[Locator, str]:
        """The list item of the message with `text`, once it carries the message's own id (the queued copy has none), and that id."""
        found = scope.locator("li[id*='message-']", has_text=text).first
        expect(found).to_have_id(ID)
        attr = found.get_attribute("id")
        return scope.locator(f"li[id='{attr}']"), ID.match(attr).group(1)

    def edit(self, page: Page, item: Locator, new: str) -> None:
        item.hover()
        item.get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Edit", exact=True).click()
        field = item.get_by_role("textbox", name="Edit message")
        field.fill(new)
        field.press("Enter")
        expect(item.get_by_role("textbox")).to_have_count(0)

    def delete(self, page: Page, item: Locator) -> None:
        item.hover()
        item.get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Delete", exact=True).click()
        item.get_by_role("button", name="Delete", exact=True).click()
        expect(item.get_by_role("group", name="Delete this message")).to_have_count(0)

    def shows_edited(self, page: Page, item: Locator, old: str, new: str) -> None:
        expect(item).to_contain_text(new)
        expect(item.locator(".message-edited")).to_be_visible()
        # Nothing brings the sent words back: the page reads again on its own, so give it the time to.
        page.wait_for_timeout(1500)
        expect(item).to_contain_text(new)
        expect(item).not_to_contain_text(old)

    def shows_removed(self, page: Page, item: Locator, old: str) -> None:
        expect(item.locator(".message-body--removed")).to_have_text("Message removed")
        page.wait_for_timeout(1500)
        expect(item.locator(".message-body--removed")).to_have_text("Message removed")
        expect(item).not_to_contain_text(old)
        # A removed message offers no Edit or Delete: it is not offered a second time, so nobody gets a 409 from it.
        item.hover()
        item.get_by_role("button", name="More actions").click()
        menu = page.get_by_role("menu", name="Message actions")
        expect(menu.get_by_role("menuitem", name="Edit", exact=True)).to_have_count(0)
        expect(menu.get_by_role("menuitem", name="Delete", exact=True)).to_have_count(0)
        page.keyboard.press("Escape")

    # ---------------------------------------------------------------- a reply in a space's thread

    def test_01_a_thread_reply_sent_here_is_edited(self) -> None:
        conversation = self.conversation_by_kai()
        page = self.page("ada")
        page.goto(f"/projects/{self.project_id}/conversations/{conversation}")
        first, second = words("typo here"), words("typo fixed")
        self.typed(page, "#thread-composer", first)
        item, message_id = self.stored(page.locator("#thread"), first)
        self.edit(page, item, second)
        self.shows_edited(page, item, first, second)
        read = self.send("ada", "GET", f"/api/v1/conversations/{conversation}", None, 200)["messages"]
        self.assertEqual([m["body"] for m in read if m["id"] == message_id], [second], "the server holds the new words the page shows")

    def test_02_a_thread_reply_sent_here_is_deleted(self) -> None:
        conversation = self.conversation_by_kai()
        page = self.page("ada")
        page.goto(f"/projects/{self.project_id}/conversations/{conversation}")
        text = words("regret this")
        self.typed(page, "#thread-composer", text)
        item, _ = self.stored(page.locator("#thread"), text)
        self.delete(page, item)
        self.shows_removed(page, item, text)

    def test_03_a_thread_reply_sent_here_and_changed_in_another_tab_follows(self) -> None:
        conversation = self.conversation_by_kai()
        page = self.page("ada")
        page.goto(f"/projects/{self.project_id}/conversations/{conversation}")
        first, second = words("sent in one tab"), words("fixed in another")
        self.typed(page, "#thread-composer", first)
        item, message_id = self.stored(page.locator("#thread"), first)
        self.send("ada", "PATCH", f"/api/v1/conversations/{conversation}/messages/{message_id}", {"body": second}, 200)
        expect(item).to_contain_text(second, timeout=20000)
        self.shows_edited(page, item, first, second)
        self.send("ada", "DELETE", f"/api/v1/conversations/{conversation}/messages/{message_id}", None, 200)
        expect(item.locator(".message-body--removed")).to_have_text("Message removed", timeout=20000)

    # ---------------------------------------------------------------- a direct message

    def test_04_a_direct_message_sent_here_is_edited(self) -> None:
        page = self.page("ada")
        page.goto(f"/dm/{self.dm_id}")
        first, second = words("dm typo"), words("dm fixed")
        self.typed(page, "#dm-composer", first)
        item, message_id = self.stored(page.locator(".dm__list").first, first)
        self.edit(page, item, second)
        self.shows_edited(page, item, first, second)
        read = self.send("ada", "GET", f"/api/v1/dms/{self.dm_id}", None, 200)["messages"]
        self.assertEqual([m["body"] for m in read if m["id"] == message_id], [second])

    def test_05_a_direct_message_sent_here_is_deleted(self) -> None:
        page = self.page("ada")
        page.goto(f"/dm/{self.dm_id}")
        text = words("dm regret")
        self.typed(page, "#dm-composer", text)
        item, _ = self.stored(page.locator(".dm__list").first, text)
        self.delete(page, item)
        self.shows_removed(page, item, text)

    def test_06_a_direct_message_sent_here_and_changed_in_another_tab_follows(self) -> None:
        page = self.page("ada")
        page.goto(f"/dm/{self.dm_id}")
        first, second = words("dm one tab"), words("dm other tab")
        self.typed(page, "#dm-composer", first)
        item, message_id = self.stored(page.locator(".dm__list").first, first)
        page.wait_for_timeout(2000)  # the stream of this page is open before the change is made
        self.send("ada", "PATCH", f"/api/v1/dms/{self.dm_id}/messages/{message_id}", {"body": second}, 200)
        expect(item).to_contain_text(second, timeout=20000)
        self.shows_edited(page, item, first, second)

    # ---------------------------------------------------------------- a reply in a direct message's thread

    def test_07_a_direct_message_thread_reply_sent_here_is_edited(self) -> None:
        root = self.dm_root_by_kai()
        page = self.page("ada")
        page.goto(f"/dm/{self.dm_id}?thread={root}")
        panel = page.locator("[data-dm-thread]")
        first, second = words("reply typo"), words("reply fixed")
        self.typed(page, "#dm-thread-composer", first)
        item, message_id = self.stored(panel.locator("ol[aria-label='Replies']"), first)
        self.edit(page, item, second)
        self.shows_edited(page, item, first, second)
        read = self.send("ada", "GET", f"/api/v1/dms/{self.dm_id}/threads/{root}", None, 200)["replies"]
        self.assertEqual([m["body"] for m in read if m["id"] == message_id], [second])

    def test_08_a_direct_message_thread_reply_sent_here_is_deleted(self) -> None:
        root = self.dm_root_by_kai()
        page = self.page("ada")
        page.goto(f"/dm/{self.dm_id}?thread={root}")
        panel = page.locator("[data-dm-thread]")
        text = words("reply regret")
        self.typed(page, "#dm-thread-composer", text)
        item, _ = self.stored(panel.locator("ol[aria-label='Replies']"), text)
        self.delete(page, item)
        self.shows_removed(page, item, text)


if __name__ == "__main__":
    unittest.main()
