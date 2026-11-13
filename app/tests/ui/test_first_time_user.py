"""Browser tests for the #763 first-time user study fixes (docs/agents/release-acceptance/evidence/first-time-user.md).

Anna owns a space with a restricted project "Volunteer sign-up app". Dev is a member who writes there but does not manage it.

* FT-1 as F-036 AG-3 changed it: Dev's own agent has Dev's rights, so Connect offers the project at once and nobody asks a manager.
* FT-2 as #859 changed it: Dev's own agent has Dev's rights and there are no standing grants, so handing it a task is one
  click in the Owner field, and nothing is granted.
* FT-3: An invite link made from the project's People also opens the project; the new person lands in it.
* FT-4: A phone's long-press menu is one level (#867), and a visible ⋯ opens the same menu.
* FT-7, FT-11, FT-13: Change access alone offers Invite; the project field is "Space name"; Revoke asks once.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from app_select import choose
from create_window import create_other, open_create
from message_gestures import long_press
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot as save_shot, start_forwarder

PASSWORD = "first time users find their way"
STAMP = int(time.time() * 1000)
ANNA = {"name": "Anna Nowak", "email": f"anna.ftu+{STAMP}@example.test"}
DEV = {"name": "Dev Patel", "email": f"dev.ftu+{STAMP}@example.test"}


def shot(page: Page, name: str) -> None:
    save_shot(page, name if UI_BROWSER == "chromium" else f"{name}-{UI_BROWSER}")


class FirstTimeUser(unittest.TestCase):
    """Tests run in name order and share two accounts, one space and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

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

    def context(self, who: str | None, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None):
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def sign_up(self, person: dict) -> Page:
        page = self.page(None)
        page.goto("/sign-up")
        page.get_by_label("Name").fill(person["name"])
        page.get_by_label("Email").fill(person["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        return page

    def test_01_a_space_a_project_and_a_member_who_writes_there(self) -> None:
        for key, person in {"anna": ANNA, "dev": DEV}.items():
            page = self.sign_up(person)
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        anna = self.page("anna")
        ws = self.api(anna, "POST", "/api/v1/workspaces", {"name": "Volunteer space"}, status=201)
        self.api(anna, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": DEV["email"], "role": "member"}, status=201)
        project = self.api(anna, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Volunteer sign-up app", "visibility": "restricted"}, status=201)
        self.api(anna, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": DEV["id"]}, "role": "contributor"}, status=201)
        conversation = self.api(anna, "POST", f"/api/v1/projects/{project['id']}/conversations",
                                {"body": "Should sign-up ask for a phone number, or is email enough?", "clientMessageId": str(uuid.uuid4())}, status=201)
        task = self.api(anna, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Write the FAQ page"}, status=201)
        dev = self.page("dev")
        agent = self.api(dev, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Dev's Claude Code", "owner": "self"}, status=201)
        type(self).ids.update(workspace=ws["id"], project=project["id"], message=conversation["messages"][0]["id"],
                              conversation=conversation["id"], task=task["id"], agent=agent["id"])

    def test_02_a_member_connects_a_client_with_one_click_and_nobody_is_asked(self) -> None:
        # F-036 AG-3 (#855, #859): the agent has exactly its owner's rights, so there is no project to choose and nobody to ask.
        dev = self.page("dev")
        dev.goto("/settings/agents/connect")
        expect(dev.get_by_role("heading", level=1, name="Claude Code, Codex or another app on your computer")).to_be_visible()
        expect(dev.get_by_text("Nothing is connected yet")).to_be_visible()
        for chooser in ("checkbox", "radio"):
            expect(dev.get_by_role("region", name="Claude Code, Codex or another app").get_by_role(chooser)).to_have_count(0)
        expect(dev.get_by_role("button", name="Ask a manager to let it in")).to_have_count(0)
        shot(dev, "ftu-connect-owner-rights")
        grants = self.api(self.page("anna"), "GET", f"/api/v1/projects/{self.ids['project']}/grants", status=200)
        self.assertFalse(any(g["principal"]["kind"] == "agent" for g in grants))

    def test_03_hand_off_to_your_own_agent_needs_no_grant(self) -> None:
        dev = self.page("dev")
        connection = self.api(dev, "POST", "/api/v1/integration/agent-connections", {"agentId": self.ids["agent"], "name": "Dev laptop", "clientDesignation": "claude_code"}, status=201)
        type(self).ids["connection"] = connection["id"]
        dev.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['task']}")
        # There is no hand-off window (S12, #868). A local client's agent takes a task when told to (#859); giving it the task as
        # its owner needs no grant, and the panel's Owner field shows it.
        task = self.api(dev, "GET", f"/api/v1/work/{self.ids['task']}", status=200)
        self.api(dev, "PATCH", f"/api/v1/work/{self.ids['task']}", {"owner": {"kind": "agent", "id": self.ids["agent"]}, "expectedVersion": task["version"]}, status=200)
        dev.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['task']}")
        expect(dev.locator("#details").get_by_role("button", name="Owner", exact=True)).to_contain_text("Claude Code")
        expect(dev.get_by_role("button", name="Hand off to an agent")).to_have_count(0)
        shot(dev, "ftu-handoff-allow")
        self.api(dev, "GET", f"/api/v1/agent-connections/{connection['id']}/action-grants?limit=50", status=404)  # no grant list exists any more
        self.assertEqual(self.api(dev, "GET", f"/api/v1/work/{self.ids['task']}", status=200)["owner"]["id"], self.ids["agent"])

    def test_04_a_phone_proposes_a_decision_from_a_message(self) -> None:
        page = self.page("dev", phone=True)
        page.goto(f"/projects/{self.ids['project']}")
        message = page.locator(f"#message-{self.ids['message']}")
        expect(message).to_be_visible()
        # A visible ⋯ on the message opens the same menu as a long press.
        dots = message.get_by_role("button", name="Message actions", exact=True)
        expect(dots).to_be_visible()
        self.assertGreaterEqual(dots.bounding_box()["height"], 28)
        dots.click()
        menu = page.get_by_role("menu", name="Message actions")
        expect(menu).to_be_visible()
        page.keyboard.press("Escape")
        long_press(message.locator(".message-bubble > .message-body"))
        expect(menu).to_be_visible()
        # One level, the same on every device (#867): Reply in thread and Create task lead the phone's list, then Add to map and Copy link.
        self.assertEqual([text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()], ["Reply in thread", "Create task", "Add to map", "Copy link", "Copy text"])
        shot(page, "ftu-phone-message-menu")
        menu.get_by_role("menuitem", name="Create task").click()
        expect(page.get_by_role("dialog", name="New task").get_by_label("Title", exact=True)).to_have_value(re.compile("Should sign-up ask for a phone number"))

    def test_05_someone_new_joins_the_company_by_link_and_is_then_added_to_the_space(self) -> None:
        """F-037: an invite link joins the company; the space's people are added from the company afterwards."""
        anna = self.page("anna")
        anna.goto(f"/projects/{self.ids['project']}/settings")
        # Someone new is invited to the company first, in Settings › Company; the space's people are chosen from the company.
        anna.goto("/settings/company?invite=1")
        anna.get_by_role("button", name="Create invite link").click()
        link = anna.locator("#people-invite-link").input_value()
        basia = self.page(None)
        token = link.split("#", 1)[1]
        basia.goto(f"/join#{token}")
        basia.get_by_role("button", name="Create an account").click()
        basia.get_by_label("Name").fill("Basia Wrona")
        basia.get_by_label("Email").fill(f"basia.ftu+{STAMP}@example.test")
        basia.get_by_label("Password").fill(PASSWORD)
        basia.get_by_role("button", name="Create account").click()
        # #1424: no "You joined" page; she lands in Everyone, where she can write at once.
        expect(basia.get_by_role("heading", level=1, name="Everyone")).to_be_visible()
        expect(basia).to_have_url(re.compile(r"/projects/[0-9a-f-]+$"))
        # The inviter hears it in the Inbox, with the way to the company's people.
        items = self.api(anna, "GET", "/api/v1/inbox", status=200)["items"]
        self.assertTrue(any(item["title"] == "Basia Wrona joined Volunteer space" and item["url"] == "/settings/company" for item in items))
        # The space stays closed to Basia until Anna adds her there.
        self.api(basia, "GET", f"/api/v1/projects/{self.ids['project']}", status=404)
        anna.goto(f"/projects/{self.ids['project']}/settings")
        anna.get_by_role("button", name="Add people", exact=True).click()
        add = anna.get_by_role("group", name="Add people")
        add.get_by_role("checkbox", name=re.compile("Basia Wrona")).check()
        add.get_by_role("button", name="Add 1 person").click()
        expect(anna.get_by_text("Basia is now in Volunteer sign-up app.")).to_be_visible()
        self.assertEqual(self.api(basia, "GET", f"/api/v1/projects/{self.ids['project']}", status=200)["access"], "contributor")

    def test_06_revoking_a_link_asks_once_and_project_name_is_the_label(self) -> None:
        anna = self.page("anna")
        invite = self.api(anna, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/invites", {"role": "guest"}, status=201,
                          headers={"idempotency-key": str(uuid.uuid4())})
        anna.goto("/settings/company?invite=1")
        row = anna.locator(".people__item", has_text="Guest")
        row.get_by_role("button", name=re.compile("^Revoke")).first.click()
        confirm = anna.get_by_role("group", name=re.compile("^Revoke link"))
        expect(confirm).to_contain_text("can’t be restored")
        confirm.get_by_role("button", name="Keep it").click()
        listed = self.api(anna, "GET", f"/api/v1/workspaces/{self.ids['workspace']}/invites", status=200)
        self.assertTrue(any(item["id"] == invite["id"] for item in listed), "Keep it revokes nothing")
        row.get_by_role("button", name=re.compile("^Revoke")).first.click()
        anna.get_by_role("group", name=re.compile("^Revoke link")).get_by_role("button", name="Revoke link").click()
        expect(anna.get_by_text("Invite link revoked. It no longer works.")).to_be_visible()
        # FT-11: the new project's only field is its name.
        anna.goto("/")
        open_create(anna)
        create_other(anna, "Space")
        expect(anna.get_by_label("Space name")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
