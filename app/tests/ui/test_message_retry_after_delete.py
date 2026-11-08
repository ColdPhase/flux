"""Browser tests for a send that is retried after the message it made was deleted (#1052).

The answer to a send is lost: the server stored the message, the page does not know it and queues the send for a retry. The page then shows
the stored copy (it arrives on the stream), the person deletes it, and the outbox's retry arrives with the same `clientMessageId`. The retry
must find the deleted message and be done quietly: the composer stays empty and nothing says the send conflicts. Before the fix the server
answered 409 and the outbox put the deleted words back in the composer, inviting a resend of words the person had just taken back.

Covered: a direct message and a reply in a space's thread (the DM's thread reply and the start of a conversation share the same server code,
tested over the API in `tests/app/message-edit-delete.test.ts`). The first request of a send reaches the server and its answer is dropped; the
retries fail the same way until the delete is done, then they go through.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Locator, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "words can be taken back"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.retry+{STAMP}@example.test"), "kai": ("Kai Tanaka", f"kai.retry+{STAMP}@example.test")}
ID = re.compile(r"^(?:thread-)?message-([0-9a-f-]{36})$")


def words(label: str) -> str:
    return f"{label} {uuid.uuid4().hex[:8]}"


class RetryAfterDelete(unittest.TestCase):
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
        cls.workspace_id = cls.send("ada", "POST", "/api/v1/workspaces", {"name": "Retries"}, 201)["id"]
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

    def lose_the_answer(self, page: Page, send_path: str) -> dict:
        """The first POST to `send_path` reaches the server and its answer never reaches the page; later ones fail the same way
        until `state["open"]` is set, then they go through and their status is recorded."""
        state: dict = {"posts": 0, "open": False, "statuses": []}

        def handle(route: Route) -> None:
            if route.request.method != "POST":
                route.continue_()
                return
            state["posts"] += 1
            if state["posts"] == 1:
                route.fetch()  # the server stores the message
                route.abort("connectionreset")
            elif not state["open"]:
                route.abort("connectionreset")
            else:
                response = route.fetch()
                state["statuses"].append(response.status)
                route.fulfill(response=response)

        page.route(lambda url: url.split("?")[0].endswith(send_path), handle)
        return state

    def stored(self, scope: Locator, text: str) -> Locator:
        """The list item of the message with `text`, once it carries the message's own id (the queued copy has none)."""
        found = scope.locator("li[id*='message-']", has_text=text).first
        expect(found).to_have_id(ID)
        return scope.locator(f"li[id='{found.get_attribute('id')}']")

    def delete(self, page: Page, item: Locator) -> None:
        item.hover()
        item.get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Delete", exact=True).click()
        item.get_by_role("button", name="Delete", exact=True).click()
        expect(item.get_by_role("group", name="Delete this message")).to_have_count(0)

    def retry_after_delete(self, page: Page, composer: str, scope: Locator, state: dict) -> None:
        text = words("wrong chat")
        page.locator(composer).fill(text)
        page.locator(composer).press("Enter")
        # The answer was lost; the stored copy arrives on the stream and the person takes it back.
        item = self.stored(scope, text)
        expect(item).to_contain_text(text)
        self.delete(page, item)
        expect(item.locator(".message-body--removed")).to_have_text("Message removed")
        self.assertEqual(state["statuses"], [], "the retry has not been let through yet")
        # The outbox retries now, and the server answers.
        state["open"] = True
        deadline = time.time() + 60
        while not state["statuses"] and time.time() < deadline:
            page.wait_for_timeout(250)
        self.assertEqual(state["statuses"], [201], "the server finds the deleted message and answers the retry, not 409")
        page.wait_for_timeout(1500)
        # The words stay deleted: not in the composer, no conflict notice, no "Not sent", and the marker is still the only trace.
        expect(page.locator(composer)).to_have_value("")
        expect(page.get_by_text("conflicts with an earlier")).to_have_count(0)
        expect(page.get_by_text("Not sent")).to_have_count(0)
        expect(item.locator(".message-body--removed")).to_have_text("Message removed")
        expect(page.locator("main")).not_to_contain_text(text)

    def test_01_a_direct_message_retried_after_its_delete_leaves_the_composer_empty(self) -> None:
        page = self.page("ada")
        state = self.lose_the_answer(page, f"/api/v1/dms/{self.dm_id}/messages")
        page.goto(f"/dm/{self.dm_id}")
        self.retry_after_delete(page, "#dm-composer", page.locator(".dm__list").first, state)

    def test_02_a_thread_reply_retried_after_its_delete_leaves_the_composer_empty(self) -> None:
        conversation = self.send("kai", "POST", f"/api/v1/projects/{self.project_id}/conversations", {"body": words("kai asks"), "clientMessageId": str(uuid.uuid4())}, 201)["id"]
        page = self.page("ada")
        state = self.lose_the_answer(page, f"/api/v1/conversations/{conversation}/messages")
        page.goto(f"/projects/{self.project_id}/conversations/{conversation}")
        self.retry_after_delete(page, "#thread-composer", page.locator("#thread"), state)


if __name__ == "__main__":
    unittest.main()
