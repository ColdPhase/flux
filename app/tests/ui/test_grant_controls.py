"""Browser tests for the owner's standing-grant controls on the Connect page (#152 T152-a, CO-1).

Runs with the other tests/ui journeys through scripts/check_ui.sh. Hubert has two connections of his
own agent: "Desk laptop" may run approved actions in two projects, "Review laptop" only reads and
suggests. On desktop (1440) and phone (390) he grants changes within that ceiling, narrows one and
revokes another; every change is checked against the server's saved grants at once. Marek, who manages
the same workspace, sees and changes only his own grants. This suite has no OAuth client, so the
agent's MCP calls under these grants are covered by tests/app/agent-grant-controls.test.ts and the
browser-to-MCP journey in tests/app/e2e/agent-grant-controls.e2e.ts.
"""

from __future__ import annotations

import json
import time
import unittest
from datetime import datetime, timedelta, timezone

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "grants that end on time"
STAMP = int(time.time() * 1000)
HUBERT = {"name": "Hubert Grant", "email": f"hubert.grants+{STAMP}@example.test"}
MAREK = {"name": "Marek Grant", "email": f"marek.grants+{STAMP}@example.test"}
ACTION_SCOPES = ["flux.context.read", "flux.proposal.write", "flux.action.execute"]


def parse(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


class GrantControlsJourney(unittest.TestCase):
    """Tests run in name order and share two accounts, three projects and three connections."""

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
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str | None, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None):
        headers = {"origin": ORIGIN}
        if body is not None:
            headers["content-type"] = "application/json"
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers=headers, data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, f"{method} {path}: {response.text()}")
        return json.loads(response.text()) if response.text() else {}

    def grants(self, page: Page, connection: str) -> list[dict]:
        return self.api(page, "GET", f"/api/v1/agent-connections/{self.ids[connection]}/action-grants?limit=50", status=200)["items"]

    def live(self, page: Page, connection: str) -> list[dict]:
        now = datetime.now(timezone.utc)
        return [g for g in self.grants(page, connection) if not g["revokedAt"] and parse(g["expiresAt"]) > now]

    def open_connect(self, who: str, **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto("/connect-agent")
        expect(page.get_by_role("heading", level=1, name="Your agent connections")).to_be_visible()
        return page

    def panel(self, page: Page, connection: str):
        return page.get_by_role("region", name=f"Standing grants for {connection}")

    def test_01_two_people_with_connections(self) -> None:
        for key, person in {"hubert": HUBERT, "marek": MAREK}.items():
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
        hubert, marek = self.page("hubert"), self.page("marek")
        workspace = self.api(hubert, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        self.ids["workspace"] = workspace["id"]
        self.api(hubert, "POST", f"/api/v1/workspaces/{workspace['id']}/members", {"email": MAREK["email"], "role": "admin"}, status=201)
        for key, name in {"sensor": "Sensor study", "field": "Field notes", "archive": "Archive"}.items():
            self.ids[key] = self.api(hubert, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": name, "visibility": "restricted"}, status=201)["id"]
        agent = self.api(hubert, "POST", f"/api/v1/workspaces/{workspace['id']}/agents", {"name": "Hubert's agent", "owner": "self"}, status=201)
        for key in ("sensor", "field", "archive"):
            self.api(hubert, "POST", f"/api/v1/projects/{self.ids[key]}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        # "Archive" is granted to the agent but not selected by either connection, so it stays above their ceiling.
        self.ids["Desk laptop"] = self.api(hubert, "POST", "/api/v1/agent-connections", {"agentId": agent["id"], "name": "Desk laptop", "clientDesignation": "codex",
                                           "selectedProjectIds": [self.ids["sensor"], self.ids["field"]], "scopes": ACTION_SCOPES}, status=201)["id"]
        self.ids["Review laptop"] = self.api(hubert, "POST", "/api/v1/agent-connections", {"agentId": agent["id"], "name": "Review laptop", "clientDesignation": "claude_code",
                                             "selectedProjectIds": [self.ids["sensor"]], "scopes": ["flux.context.read", "flux.proposal.write"]}, status=201)["id"]
        # Marek, a workspace admin, has his own agent, connection and one grant.
        mine = self.api(marek, "POST", f"/api/v1/workspaces/{workspace['id']}/agents", {"name": "Marek's agent", "owner": "self"}, status=201)
        self.api(marek, "POST", f"/api/v1/projects/{self.ids['sensor']}/grants", {"principal": {"kind": "agent", "id": mine["id"]}, "role": "contributor"}, status=201)
        self.ids["Workshop PC"] = self.api(marek, "POST", "/api/v1/agent-connections", {"agentId": mine["id"], "name": "Workshop PC", "clientDesignation": "claude_code",
                                           "selectedProjectIds": [self.ids["sensor"]], "scopes": ACTION_SCOPES}, status=201)["id"]
        self.ids["marek-grant"] = self.api(marek, "POST", f"/api/v1/agent-connections/{self.ids['Workshop PC']}/action-grants", {
            "clientCommandId": "6f0e5c1a-7a51-4c5e-9d0b-2a1f5d6c7e80", "projectId": self.ids["sensor"], "operation": "doc.update",
            "peerRequestClass": "execute", "maximumUses": 12, "expiresAt": (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()}, status=201)["id"]

    def test_02_desktop_grant_within_the_ceiling_narrow_and_revoke(self) -> None:
        page = self.open_connect("hubert")
        desk = self.panel(page, "Desk laptop")
        expect(desk).to_contain_text("None yet")
        # A read-and-suggest connection offers no grants at all.
        review = self.panel(page, "Review laptop")
        expect(review).to_contain_text("This connection can read and suggest only.")
        expect(review.get_by_role("button", name="Add a grant")).to_have_count(0)

        desk.get_by_role("button", name="Add a grant").click()
        form = desk.get_by_role("form", name="Add a grant to Desk laptop")
        project = form.get_by_label("Project", exact=True)
        # Only the connection's selected projects: "Archive" is never offered.
        self.assertEqual(sorted(project.locator("option").all_inner_texts()), ["Field notes", "Sensor study"])
        acts = form.get_by_label("Acts as", exact=True)
        self.assertEqual(acts.locator("option").all_inner_texts(), ["Doing the work", "Planning"], "no review grant for native changes")
        acts.select_option(label="Planning")
        expect(form.get_by_role("checkbox", name="Record results")).to_have_count(0)
        expect(form.get_by_role("checkbox", name="Propose decisions")).to_have_count(1)
        acts.select_option(label="Doing the work")
        project.select_option(label="Sensor study")
        for change in ("Create tasks", "Change tasks", "Record results"):
            form.get_by_role("checkbox", name=change).check()
        form.get_by_label("Uses for each change").fill("20")
        form.get_by_label("Ends", exact=True).select_option(label="In 7 days")
        shot(page, "grant-add-desktop")
        form.get_by_role("button", name="Grant 3 changes").click()

        sensor = desk.get_by_role("list", name="Sensor study")
        expect(sensor.get_by_role("listitem")).to_have_count(3)
        expect(desk).to_contain_text("3 active")
        expect(sensor.get_by_role("listitem").filter(has_text="Create tasks")).to_contain_text("20 of 20 uses left")
        saved = self.live(page, "Desk laptop")
        self.assertEqual(sorted(g["operation"] for g in saved), ["result.record", "work.create", "work.update"], "the server saved exactly what was granted")
        for grant in saved:
            self.assertEqual((grant["projectId"], grant["peerRequestClass"], grant["maximumUses"], grant["objectId"]), (self.ids["sensor"], "execute", 20, None))
            ends = parse(grant["expiresAt"]) - datetime.now(timezone.utc)
            self.assertTrue(timedelta(days=6, hours=23) < ends <= timedelta(days=7), ends)

        # Narrow "Create tasks": fewer uses and an earlier end.
        create = sensor.get_by_role("listitem").filter(has_text="Create tasks")
        create.get_by_role("button", name="Narrow Create tasks, Doing the work").click()
        narrow = create.get_by_role("form", name="Narrow Create tasks")
        narrow.get_by_label("Uses left").fill("5")
        narrow.get_by_label("Ends", exact=True).select_option(label="In 1 day")
        narrow.get_by_role("button", name="Save").click()
        expect(create).to_contain_text("5 of 5 uses left")
        narrowed = next(g for g in self.live(page, "Desk laptop") if g["operation"] == "work.create")
        self.assertEqual(narrowed["maximumUses"], 5)
        self.assertTrue(parse(narrowed["expiresAt"]) - datetime.now(timezone.utc) <= timedelta(days=1))
        # Narrowing cannot widen: the uses field stops at what is left.
        create.get_by_role("button", name="Narrow Create tasks, Doing the work").click()
        uses = create.get_by_role("form", name="Narrow Create tasks").get_by_label("Uses left")
        self.assertEqual((uses.get_attribute("min"), uses.get_attribute("max")), ("1", "5"))
        uses.fill("9")
        expect(create.get_by_role("button", name="Save")).to_be_disabled()
        create.get_by_role("button", name="Cancel").click()

        # Revoke "Change tasks".
        change = sensor.get_by_role("listitem").filter(has_text="Change tasks")
        change.get_by_role("button", name="Revoke Change tasks, Doing the work").click()
        expect(change).to_contain_text("The agent’s next call with it is refused.")
        shot(page, "grant-revoke-desktop")
        change.get_by_role("button", name="Revoke now").click()
        expect(sensor.get_by_role("listitem")).to_have_count(2)
        expect(desk).to_contain_text("2 active")
        revoked = next(g for g in self.grants(page, "Desk laptop") if g["operation"] == "work.update")
        self.assertIsNotNone(revoked["revokedAt"], "the revocation is saved")
        desk.get_by_role("button", name="Show ended grants (1)").click()
        expect(desk.get_by_role("list", name="Ended grants")).to_contain_text("Change tasks")
        expect(desk.get_by_role("list", name="Ended grants")).to_contain_text("Revoked")
        shot(page, "grant-list-desktop")

        # After a reload the page shows the saved state, not a local copy.
        page.reload()
        desk = self.panel(page, "Desk laptop")
        expect(desk.get_by_role("list", name="Sensor study").get_by_role("listitem")).to_have_count(2)
        expect(desk.get_by_role("list", name="Sensor study").get_by_role("listitem").filter(has_text="Create tasks")).to_contain_text("5 of 5 uses left")
        # The server keeps the same ceiling for a hand-made request.
        self.api(page, "POST", f"/api/v1/agent-connections/{self.ids['Review laptop']}/action-grants", {"clientCommandId": "0b6a4f6e-5d0c-4d4e-8a1f-3c2b1a0d9e8f",
                 "projectId": self.ids["sensor"], "operation": "work.create", "peerRequestClass": "execute", "maximumUses": 5,
                 "expiresAt": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}, status=404)
        self.api(page, "POST", f"/api/v1/agent-connections/{self.ids['Desk laptop']}/action-grants", {"clientCommandId": "1c7b5e7f-6e1d-4e5f-9b2a-4d3c2b1a0f9e",
                 "projectId": self.ids["archive"], "operation": "work.create", "peerRequestClass": "execute", "maximumUses": 5,
                 "expiresAt": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}, status=404)

    def test_03_phone_grant_narrow_and_revoke(self) -> None:
        page = self.open_connect("hubert", phone=True)
        desk = self.panel(page, "Desk laptop")
        desk.get_by_role("button", name="Add a grant").click()
        form = desk.get_by_role("form", name="Add a grant to Desk laptop")
        form.get_by_label("Project", exact=True).select_option(label="Field notes")
        form.get_by_label("Acts as", exact=True).select_option(label="Planning")
        form.get_by_role("checkbox", name="Edit docs").check()
        form.get_by_role("checkbox", name="Reply in conversations").check()
        form.get_by_label("Uses for each change").fill("8")
        form.get_by_label("Ends", exact=True).select_option(label="In 30 days (the longest)")
        submit = form.get_by_role("button", name="Grant 2 changes")
        submit.scroll_into_view_if_needed()
        self.assertGreaterEqual(submit.bounding_box()["height"], 44, "a phone-sized target")
        shot(page, "grant-add-phone")
        submit.click()
        field = desk.get_by_role("list", name="Field notes")
        expect(field.get_by_role("listitem")).to_have_count(2)
        saved = [g for g in self.live(page, "Desk laptop") if g["projectId"] == self.ids["field"]]
        self.assertEqual(sorted((g["operation"], g["peerRequestClass"], g["maximumUses"]) for g in saved),
                         [("conversation.reply", "plan", 8), ("doc.update", "plan", 8)])
        for grant in saved:
            self.assertTrue(timedelta(days=29, hours=23) < parse(grant["expiresAt"]) - datetime.now(timezone.utc) <= timedelta(days=30))

        docs = field.get_by_role("listitem").filter(has_text="Edit docs")
        docs.get_by_role("button", name="Narrow Edit docs, Planning").click()
        docs.get_by_role("form", name="Narrow Edit docs").get_by_label("Uses left").fill("3")
        docs.get_by_role("button", name="Save").click()
        expect(docs).to_contain_text("3 of 3 uses left")
        self.assertEqual(next(g for g in self.live(page, "Desk laptop") if g["operation"] == "doc.update")["maximumUses"], 3)

        reply = field.get_by_role("listitem").filter(has_text="Reply in conversations")
        revoke = reply.get_by_role("button", name="Revoke Reply in conversations, Planning")
        self.assertGreaterEqual(revoke.bounding_box()["height"], 44)
        revoke.click()
        reply.get_by_role("button", name="Revoke now").click()
        expect(field.get_by_role("listitem")).to_have_count(1)
        self.assertIsNotNone(next(g for g in self.grants(page, "Desk laptop") if g["operation"] == "conversation.reply")["revokedAt"])
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "no sideways scrolling")
        desk.scroll_into_view_if_needed()
        shot(page, "grant-list-phone")

    def test_04_another_member_sees_and_changes_only_their_own_grants(self) -> None:
        for phone in (False, True):
            page = self.open_connect("marek", phone=phone)
            mine = self.panel(page, "Workshop PC")
            expect(mine.get_by_role("list", name="Sensor study").get_by_role("listitem")).to_have_count(1)
            expect(mine).to_contain_text("Edit docs")
            for other in ("Desk laptop", "Review laptop"):
                expect(page.get_by_text(other)).to_have_count(0)
                expect(self.panel(page, other)).to_have_count(0)
            shot(page, f"grant-other-member-{'phone' if phone else 'desktop'}")
        hubert = self.page("hubert")
        before = self.grants(hubert, "Desk laptop")
        target = next(g for g in before if g["operation"] == "work.create")
        base = f"/api/v1/agent-connections/{self.ids['Desk laptop']}/action-grants"
        marek = self.page("marek")
        self.api(marek, "GET", base, status=404)
        self.api(marek, "PATCH", f"{base}/{target['id']}", {"maximumUses": 1}, status=404)
        self.api(marek, "DELETE", f"{base}/{target['id']}", status=404)
        self.api(marek, "POST", base, {"clientCommandId": "2d8c6f80-7f2e-4f60-8c3b-5e4d3c2b1a0f", "projectId": self.ids["sensor"], "operation": "work.create",
                 "peerRequestClass": "execute", "maximumUses": 900, "expiresAt": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}, status=404)
        self.assertEqual(self.grants(hubert, "Desk laptop"), before, "Hubert's grants are unchanged")
        # The project Agents view lists Hubert's connections for Marek, but offers no grant controls there.
        agents = self.page("marek")
        agents.goto(f"/projects/{self.ids['sensor']}/agents")
        expect(agents.get_by_role("heading", level=1, name="Agents")).to_be_visible()
        expect(agents.get_by_role("list", name="Agents in this project")).to_contain_text("Desk laptop")
        expect(agents.get_by_text("Standing grants")).to_have_count(0)
        expect(agents.get_by_role("button", name="Revoke")).to_have_count(0)
        # And Hubert's page never shows Marek's connection or grant.
        own = self.open_connect("hubert")
        expect(own.get_by_text("Workshop PC")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
