"""Persona round 6 (personas-29, train/v021-29): one name for a person on every surface, one way of saying one thing.

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER (run it with chromium
and with webkit), on a computer (1440 x 900) and a phone (390 x 844):

* P2 4: a guest reads every thread reply by its author's name, as a member does, never "Former member" (the company's member list is not
  a guest's; the space's people are), on the computer and the phone.
* A blocked task keeps its line on Home ("Waiting for Basia Wrona · the new seals"), as on the board and in the Inbox; the List says
  "No owner" as the board does.
* The fold of task updates names each person once ("Ola Nowicka created 3 tasks"), not once for each way a task was made.
* Company and Space settings draw a person's row alike: the name's weight, and the role's chevron beside its word.
* The new invite link's field is "Link for <address>", without a second, lower-case form of the role written beside it.
* A direct message nobody has written in is not listed for the other person; the first message brings it, live.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "round six persona words"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "piotr": ("Piotr Kowal", f"piotr.round6+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.round6+{STAMP}@example.test"),
    "ada": ("Ada Kowalska", f"ada.round6+{STAMP}@example.test"),
    "ola": ("Ola Nowicka", f"ola.round6+{STAMP}@example.test"),
    "basia": ("Basia Wrona", f"basia.round6+{STAMP}@example.test"),
    "gosia": ("Gosia Mlyn", f"gosia.round6+{STAMP}@example.test"),
}
ROOT = "Moisture first, then temperature: which sensors do we order?"
REPLIES = (("ada", "Agreed, moisture first. The far beds dry out fastest."), ("jonas", "Then let us order six and put two on the far beds."))


class RoundSix(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def call(cls, who: str, method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
        context = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states[who], service_workers="block")
        try:
            response = context.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN, **(headers or {})})
            assert response.status in (200, 201, 204), f"{method} {path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}
        finally:
            context.close()

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        cls.ids["ws"] = cls.call("piotr", "POST", "/api/v1/workspaces", {"name": "Garden club"})["id"]
        for key, role in (("jonas", "member"), ("ada", "member"), ("ola", "member"), ("basia", "member"), ("gosia", "guest")):
            cls.call("piotr", "POST", f"/api/v1/workspaces/{cls.ids['ws']}/members", {"email": PEOPLE[key][1], "role": role})
        # The guest's space: a thread with replies by two members.
        cls.ids["garden"] = cls.call("piotr", "POST", f"/api/v1/workspaces/{cls.ids['ws']}/projects", {"name": "Garden sensors", "visibility": "restricted"})["id"]
        for key in ("jonas", "ada", "gosia"):
            cls.call("piotr", "POST", f"/api/v1/projects/{cls.ids['garden']}/grants", {"principal": {"kind": "human", "id": cls.ids[key]}, "role": "contributor"})
        root = cls.call("jonas", "POST", f"/api/v1/projects/{cls.ids['garden']}/conversations", {"body": ROOT, "clientMessageId": str(uuid.uuid4())})
        cls.ids["thread"] = root["id"]
        cls.ids["root"] = root["messages"][0]["id"]
        for key, body in REPLIES:
            cls.ids[f"reply-{key}"] = cls.call(key, "POST", f"/api/v1/conversations/{root['id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})["id"]
        cls.ids["shed"] = cls.call("piotr", "POST", f"/api/v1/workspaces/{cls.ids['ws']}/projects", {"name": "Tool shed", "visibility": "workspace"})["id"]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, viewport: dict = DESKTOP) -> Page:
        phone = viewport == PHONE
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, locale="en-GB", timezone_id="Europe/Warsaw",
                                           storage_state=self.states[who], viewport=viewport, device_scale_factor=1,
                                           **({"is_mobile": True, "has_touch": True} if phone and UI_BROWSER != "firefox" else {}))
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def task(self, who: str, project: str, title: str, **body) -> dict:
        return self.call(who, "POST", f"/api/v1/projects/{project}/work", {"title": title, "clientCommandId": str(uuid.uuid4()), **body})

    # ---------------------------------------------------------------- P2 4

    def test_01_a_guest_reads_every_reply_by_its_author(self) -> None:
        for viewport in (DESKTOP, PHONE):
            with self.subTest(phone=viewport == PHONE):
                page = self.page("gosia", viewport)
                page.goto(f"/projects/{self.ids['garden']}/conversations/{self.ids['thread']}")
                for key, body in REPLIES:
                    reply = page.locator(f"#message-{self.ids[f'reply-{key}']}")
                    expect(reply).to_contain_text(body)
                    expect(reply).to_have_attribute("aria-label", f"{PEOPLE[key][0]}’s message")
                    expect(reply).to_contain_text(PEOPLE[key][0])
                expect(page.get_by_text("Former member")).to_have_count(0)
                # The stream names the root's author the same way.
                if viewport == DESKTOP:
                    page.goto(f"/projects/{self.ids['garden']}")
                    root = page.locator(f"#message-{self.ids['root']}")
                    expect(root).to_contain_text("Jonas Berg")
                    expect(page.get_by_text("Former member")).to_have_count(0)

    # ---------------------------------------------------------------- One line for a blocked task, one "No owner"

    def test_02_home_keeps_a_blocked_tasks_line_and_the_list_says_no_owner(self) -> None:
        made = self.task("ola", self.ids["shed"], "Seal the rain barrels", owner={"kind": "human", "id": self.ids["ola"]})
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states["ola"], service_workers="block")
        try:
            response = context.request.fetch(f"/api/v1/work/{made['id']}", method="PATCH", headers={"origin": ORIGIN, "If-Match": f"\"{made['version']}\""},
                                             data={"clientCommandId": str(uuid.uuid4()), "status": "blocked", "blocker": "the new seals", "waitingFor": {"kind": "human", "id": self.ids["basia"]}})
            assert response.status == 200, response.text()
        finally:
            context.close()
        page = self.page("ola")
        page.goto("/")
        need = page.get_by_role("region", name=re.compile("^Waiting for you"))
        row = need.locator(".home__row").filter(has_text="Seal the rain barrels")
        expect(row).to_contain_text("Waiting for Basia Wrona · the new seals")
        loose = self.task("ola", self.ids["shed"], "Oil the hinges", owner=None)
        page.goto(f"/projects/{self.ids['shed']}/tasks?view=list")
        line = page.locator(".ws-task").filter(has_text="Oil the hinges")
        expect(line).to_contain_text(f"#{loose['number']} · No owner")
        expect(line).not_to_contain_text("no owner")

    # ---------------------------------------------------------------- The fold names a person once

    def test_03_the_fold_of_task_updates_names_each_person_once(self) -> None:
        space = self.call("piotr", "POST", f"/api/v1/workspaces/{self.ids['ws']}/projects", {"name": "Compost", "visibility": "workspace"})["id"]
        asked = self.call("piotr", "POST", f"/api/v1/projects/{space}/conversations", {"body": "Someone should turn the compost on Friday.", "clientMessageId": str(uuid.uuid4())})
        self.task("ola", space, "Turn the compost", sources=[{"type": "message", "id": asked["messages"][0]["id"]}])
        self.task("ola", space, "Buy a second bin")
        self.task("ola", space, "Label the bins")
        page = self.page("piotr")
        page.goto(f"/projects/{space}")
        fold = page.locator(".convo-fold")
        expect(fold.locator(".convo-fold__t b")).to_have_text("3 task updates")
        expect(fold.locator(".convo-fold__s")).to_have_text(" · Ola Nowicka created 3 tasks")

    # ---------------------------------------------------------------- One look for a person's row

    def test_04_company_and_space_settings_draw_a_persons_row_alike(self) -> None:
        look = """el => {
            const name = getComputedStyle(el.querySelector('.people__who b, .spset__who b'));
            const select = el.querySelector('.ui-select');
            const value = select.querySelector('.ui-select__value').getBoundingClientRect();
            const chev = select.querySelector('.ui-select__chev').getBoundingClientRect();
            return { weight: name.fontWeight, size: name.fontSize, gap: Math.round(chev.left - value.left) };
        }"""
        page = self.page("piotr")
        page.goto("/settings/company")
        company = page.locator(f".people--page .people__item[data-person='{self.ids['jonas']}']").evaluate(look)
        page.goto(f"/projects/{self.ids['garden']}/settings")
        space = page.locator(f".spset .sset-row[data-person='{self.ids['jonas']}']").evaluate(look)
        self.assertEqual(company, space, "the name's weight and size, and where the role's chevron sits, are the same on both pages")

    # ---------------------------------------------------------------- Words

    def test_05_the_new_invite_link_names_its_address_once(self) -> None:
        address = f"kasia.round6+{STAMP}@example.test"
        page = self.page("piotr")
        page.goto("/settings/company?invite=1")
        invite = page.get_by_role("region", name="Invite people")
        invite.get_by_label("Email (optional)").fill(address)
        invite.get_by_role("button", name="Create invite link").click()
        field = page.get_by_label(f"Link for {address}", exact=True)
        expect(field).to_be_visible()
        expect(page.get_by_label(re.compile(r"^Link for .+ · "))).to_have_count(0)

    # ---------------------------------------------------------------- An empty DM

    def test_06_a_direct_message_nobody_wrote_in_is_not_listed_for_the_other_person(self) -> None:
        dm = self.call("basia", "POST", f"/api/v1/workspaces/{self.ids['ws']}/dms", {"participantIds": [self.ids["ada"]]})
        self.assertIn(dm["id"], [item["id"] for item in self.call("basia", "GET", f"/api/v1/workspaces/{self.ids['ws']}/dms?limit=100")["items"]],
                      "the person who started it has it")
        self.assertNotIn(dm["id"], [item["id"] for item in self.call("ada", "GET", f"/api/v1/workspaces/{self.ids['ws']}/dms?limit=100")["items"]],
                         "the other person is not shown an empty conversation")
        page = self.page("ada")
        page.goto("/dm")
        expect(page.get_by_role("heading", name="No messages yet")).to_be_visible()
        expect(page.get_by_text("Basia Wrona")).to_have_count(0)
        # The first message brings it, without a reload.
        self.call("basia", "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": "Can you water the seedlings on Sunday?", "clientMessageId": str(uuid.uuid4())})
        expect(page.locator(".dm-index").get_by_text("Can you water the seedlings on Sunday?")).to_be_visible(timeout=30000)


if __name__ == "__main__":
    unittest.main()
