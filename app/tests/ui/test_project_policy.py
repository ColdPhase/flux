"""Browser tests for the agent policy editor in the project Agents view (#160 T160-b, F-018 CW-1).

Runs with the other tests/ui journeys through scripts/check_ui.sh. Hubert owns the workspace and Ola is
its admin, so both manage the restricted project "Porch light"; Marek contributes and Lee views. A manager
writes, edits and publishes the policy at 1440 and 390 px; every publish is checked against the server's
saved revision. Two managers editing the same revision get a calm conflict that keeps the second one's
text. Marek and Lee read the policy but are offered no editor, and Lee sees a new revision without a
reload. That an agent's next bootstrap names the published revision is covered by tests/app/agent-policy.test.ts.
"""

from __future__ import annotations

import json
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "the porch light stays calm"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "hubert": {"name": "Hubert Nowak", "email": f"hubert.policy+{STAMP}@example.test"},
    "ola": {"name": "Ola Kowalska", "email": f"ola.policy+{STAMP}@example.test"},
    "marek": {"name": "Marek Lis", "email": f"marek.policy+{STAMP}@example.test"},
    "lee": {"name": "Lee Park", "email": f"lee.policy+{STAMP}@example.test"},
}
FIRST = {
    "Scope": "Firmware and wiring for the porch light: motion sensing, dusk detection and the dimming curve. "
             "The garden lights and the phone app are out of scope.",
    "Priorities": "1. Fewer false triggers from passing cars.\n2. Battery life through the winter.\n3. A smoother fade-out.",
    "Review criteria": "Each change names the bench test it passed and the measured current draw. "
                       "Firmware changes are reviewed by someone who did not write them.",
    "Allowed work": "Tasks, results and wiki notes. No releases, and no change to the shared wiring diagram without a person's decision.",
}
FIELD = {"Scope": "scope", "Priorities": "priorities", "Review criteria": "reviewCriteria", "Allowed work": "allowedWork"}
COARSE = "() => matchMedia('(pointer: coarse)').matches"
FONT_SIZE = "el => parseFloat(getComputedStyle(el).fontSize)"


class ProjectPolicyJourney(unittest.TestCase):
    """Tests run in name order and share four accounts and one project."""

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

    def saved(self, page: Page) -> dict | None:
        """The approved policy as the server has it now."""
        return self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/agent-policy", status=200)["policy"]

    def open_agents(self, who: str, **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(page.get_by_role("heading", level=1, name="Working together")).to_be_visible()
        return page

    def policy(self, page: Page):
        return page.get_by_role("region", name="Agent policy")

    def editor(self, page: Page):
        return self.policy(page).get_by_role("form", name="Edit agent policy")

    def to_top(self, locator) -> None:
        """Scrolls the view's pane so the policy starts at the top of the screenshot."""
        locator.evaluate("el => el.scrollIntoView({ block: 'start' })")

    def assert_no_sideways_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "no sideways scrolling")

    def test_01_four_people_and_one_project(self) -> None:
        for key, person in PEOPLE.items():
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        hubert = self.page("hubert")
        workspace = self.api(hubert, "POST", "/api/v1/workspaces", {"name": "Porch workshop"}, status=201)
        roles = {"ola": "admin", "marek": "member", "lee": "member"}
        for key, role in roles.items():
            self.api(hubert, "POST", f"/api/v1/workspaces/{workspace['id']}/members", {"email": PEOPLE[key]["email"], "role": role}, status=201)
        project = self.api(hubert, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Porch light", "visibility": "restricted"}, status=201)
        pid = project["id"]
        for key, role in {"marek": "contributor", "lee": "viewer"}.items():
            self.api(hubert, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": PEOPLE[key]["id"]}, "role": role}, status=201)
        # Realistic surroundings: one connected agent and an open task with its thread.
        agent = self.api(hubert, "POST", f"/api/v1/workspaces/{workspace['id']}/agents", {"name": "Hubert's coding agent", "owner": "self"}, status=201)
        self.api(hubert, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        self.api(hubert, "POST", "/api/v1/agent-connections", {"agentId": agent["id"], "selectedProjectIds": [pid], "scopes": ["flux.context.read", "flux.proposal.write"],
                 "name": "Desk laptop", "clientDesignation": "codex"}, status=201)
        self.api(hubert, "POST", f"/api/v1/projects/{pid}/work", {"title": "Stop the light waking for passing cars", "status": "in_progress"}, status=201)
        type(self).ids = {"workspace": workspace["id"], "project": pid}
        self.assertIsNone(self.saved(hubert), "no policy yet")

    def test_02_desktop_manager_writes_and_publishes_the_first_revision(self) -> None:
        # Before anything is published, a contributor sees that there is none and is offered nothing to write.
        marek = self.open_agents("marek")
        expect(self.policy(marek)).to_contain_text("None yet")
        expect(self.policy(marek).get_by_role("button")).to_have_count(0)
        shot(marek, "policy-none-reader-desktop-1440")

        page = self.open_agents("hubert")
        policy = self.policy(page)
        expect(policy).to_contain_text("None yet")
        expect(policy.get_by_role("button", name="Show policy")).to_have_count(0)
        policy.get_by_role("button", name="Write policy").click()
        form = self.editor(page)
        expect(form.get_by_label("Scope", exact=True)).to_be_focused()
        expect(form).to_contain_text("never gives them more access")

        # Nothing written: a specific message, and nothing reaches the server.
        form.get_by_role("button", name="Publish revision 1").click()
        expect(form.get_by_role("alert")).to_have_text("Write at least one part of the policy before publishing.")
        self.assertIsNone(self.saved(page))

        for label, text in FIRST.items():
            form.get_by_label(label, exact=True).fill(text)
        # One part over the limit: the part says by how much, and publishing names it instead of sending it.
        priorities = form.get_by_label("Priorities", exact=True)
        priorities.fill("p" * 4012)
        expect(form).to_contain_text("12 characters over the 4,000 limit. Shorten Priorities to publish.")
        expect(form).to_contain_text("4,012 / 4,000")
        expect(priorities).to_have_attribute("aria-invalid", "true")
        form.get_by_role("button", name="Publish revision 1").click()
        expect(form.get_by_role("alert")).to_have_text("Shorten Priorities to publish. Each part can be up to 4,000 characters.")
        expect(priorities).to_be_focused()
        self.assertIsNone(self.saved(page), "an invalid policy is never sent")
        priorities.fill(FIRST["Priorities"])
        expect(form).not_to_contain_text("over the 4,000 limit")
        expect(form.get_by_role("alert")).to_have_count(0, timeout=2000)
        expect(form).to_contain_text("Agents load revision 1 at their next start or safe checkpoint.")
        self.to_top(policy)
        shot(page, "policy-edit-desktop-1440")

        form.get_by_role("button", name="Publish revision 1").click()
        expect(policy.get_by_role("status")).to_have_text("Published revision 1. Agents pick it up at their next start or safe checkpoint.")
        expect(form).to_have_count(0)
        expect(policy).to_contain_text("Revision 1 · Hubert Nowak")
        saved = self.saved(page)
        self.assertEqual(saved["revision"], 1)
        self.assertEqual({label: saved[field] for label, field in FIELD.items()}, FIRST, "the server saved exactly what was typed")
        self.assertEqual(saved["publishedBy"]["id"], PEOPLE["hubert"]["id"])
        for label, text in FIRST.items():
            expect(policy.get_by_role("definition").filter(has_text=text.split("\n")[0])).to_have_count(1)
        self.to_top(policy)
        shot(page, "policy-read-desktop-1440")

        # After a reload the view shows the saved revision, folded until asked for.
        page.reload()
        policy = self.policy(page)
        expect(policy).to_contain_text("Revision 1 · Hubert Nowak")
        expect(policy.get_by_role("definition")).to_have_count(0)
        policy.get_by_role("button", name="Show policy").click()
        expect(policy.get_by_role("button", name="Hide policy")).to_have_attribute("aria-expanded", "true")
        expect(policy.get_by_role("definition").filter(has_text="Battery life through the winter.")).to_have_count(1)
        # The thread and the connection list are still there below and above it.
        expect(page.get_by_role("list", name="Agent connections in this project").get_by_role("listitem")).to_have_count(1)
        expect(page.get_by_label("Write to this task")).to_be_visible()

    def publish_through_api(self, who: str, changes: dict[str, str]) -> dict:
        """Publishes the next revision from the saved one, with these parts changed: a known starting point."""
        page = self.page(who)
        current = self.saved(page)
        body = {field: (current or {}).get(field, FIRST[label]) for label, field in FIELD.items()}
        body.update(changes)
        return self.api(page, "PUT", f"/api/v1/projects/{self.ids['project']}/agent-policy",
                        {**body, "expectedRevision": current["revision"] if current else 0}, status=201)

    def test_03_two_managers_edit_the_same_revision(self) -> None:
        # Both start from the same known revision, whatever the earlier tests left.
        base = self.publish_through_api("hubert", {field: FIRST[label] for label, field in FIELD.items()})["revision"]
        hubert = self.open_agents("hubert")
        policy = self.policy(hubert)
        policy.get_by_role("button", name="Show policy").click()
        policy.get_by_role("button", name="Edit policy").click()
        form = self.editor(hubert)
        expect(form.get_by_label("Scope", exact=True)).to_have_value(FIRST["Scope"])
        mine = "Firmware for the porch light only: motion sensing and dusk detection. The dimming curve waits for the new LED driver."
        form.get_by_label("Scope", exact=True).fill(mine)

        # Meanwhile Ola, the workspace admin, publishes the next revision from her own editor.
        ola = self.open_agents("ola")
        theirs = "Tasks and results only. Wiki notes go through a person until the wiring diagram is settled."
        ola_policy = self.policy(ola)
        ola_policy.get_by_role("button", name="Show policy").click()
        ola_policy.get_by_role("button", name="Edit policy").click()
        self.editor(ola).get_by_label("Allowed work", exact=True).fill(theirs)
        self.editor(ola).get_by_role("button", name=f"Publish revision {base + 1}").click()
        expect(ola_policy).to_contain_text(f"Revision {base + 1} · Ola Kowalska")
        self.assertEqual(self.saved(ola)["allowedWork"], theirs)
        # Hubert's open editor is told at once, without a reload, and keeps his text.
        expect(form.get_by_role("status")).to_contain_text(f"Ola Kowalska published revision {base + 1} while you were editing.")
        expect(form.get_by_label("Scope", exact=True)).to_have_value(mine)

        # He still edits revision {base}. Publishing does not overwrite Ola's: it shows her revision and keeps his text.
        form.get_by_role("button", name=f"Publish revision {base + 1}").click()
        conflict = form.get_by_role("alert")
        expect(conflict).to_contain_text(f"Ola Kowalska published revision {base + 1} while you were editing.")
        expect(conflict).to_contain_text("Your text is still here. They changed Allowed work.")
        expect(form.get_by_label("Scope", exact=True)).to_have_value(mine)
        saved = self.saved(hubert)
        self.assertEqual((saved["revision"], saved["scope"], saved["allowedWork"]), (base + 1, FIRST["Scope"], theirs), "Hubert's edit was not published")
        # Only the part she changed is shown, so he can keep it.
        changed = form.get_by_role("list", name=f"Changed in revision {base + 1}").get_by_role("listitem")
        expect(changed).to_have_count(1)
        expect(changed).to_contain_text("Their allowed work")
        expect(changed).to_contain_text(theirs)
        self.to_top(policy)
        shot(hubert, "policy-conflict-desktop-1440")
        changed.get_by_role("button", name="Use their allowed work").click()
        expect(form.get_by_label("Allowed work", exact=True)).to_have_value(theirs)
        expect(changed).to_contain_text("Your allowed work now matches theirs.")
        expect(form.get_by_label("Scope", exact=True)).to_have_value(mine)
        publish = form.get_by_role("button", name=f"Publish mine as revision {base + 2}")
        publish.scroll_into_view_if_needed()
        shot(hubert, "policy-conflict-actions-desktop-1440")

        # He has read hers and kept her part; publishing now replaces her revision as the next one, knowingly.
        publish.click()
        expect(policy.get_by_role("status")).to_contain_text(f"Published revision {base + 2}.")
        saved = self.saved(hubert)
        self.assertEqual((saved["revision"], saved["scope"], saved["allowedWork"], saved["publishedBy"]["id"]),
                         (base + 2, mine, theirs, PEOPLE["hubert"]["id"]))
        # Ola's open view follows without a reload.
        expect(ola_policy).to_contain_text(f"Revision {base + 2} · Hubert Nowak")

    def test_04_phone_manager_edits_with_touch_sized_controls(self) -> None:
        base = self.publish_through_api("hubert", {"reviewCriteria": FIRST["Review criteria"]})["revision"]
        page = self.open_agents("ola", phone=True)
        self.assertTrue(page.evaluate(COARSE), "the phone context has a coarse pointer")
        policy = self.policy(page)
        show = policy.get_by_role("button", name="Show policy")
        self.assertGreaterEqual(show.bounding_box()["height"], 44, "a touch-sized target")
        title = policy.get_by_role("heading", name="Agent policy").bounding_box()
        self.assertLess(abs((show.bounding_box()["y"] + 22) - (title["y"] + title["height"] / 2)), 12, "the action sits beside the title")
        show.click()
        edit = policy.get_by_role("button", name="Edit policy")
        self.assertGreaterEqual(edit.bounding_box()["height"], 44)
        edit.click()
        form = self.editor(page)
        for label in FIELD:
            box = form.get_by_label(label, exact=True)
            self.assertGreaterEqual(box.evaluate(FONT_SIZE), 16, f"{label}: 16 px text, so the phone does not zoom on focus")
            self.assertGreaterEqual(box.bounding_box()["height"], 44)
        criteria = "Each change names the bench test it passed, the measured current draw and a photo of the mounted sensor."
        form.get_by_label("Review criteria", exact=True).fill(criteria)
        publish = form.get_by_role("button", name=f"Publish revision {base + 1}")
        cancel = form.get_by_role("button", name="Cancel")
        publish.scroll_into_view_if_needed()
        for button in (publish, cancel):
            self.assertGreaterEqual(button.bounding_box()["height"], 44)
        self.assert_no_sideways_scroll(page)
        shot(page, "policy-edit-phone-390")
        publish.click()
        expect(policy.get_by_role("status")).to_contain_text(f"Published revision {base + 1}.")
        saved = self.saved(page)
        self.assertEqual((saved["revision"], saved["reviewCriteria"], saved["publishedBy"]["id"]), (base + 1, criteria, PEOPLE["ola"]["id"]))
        self.assert_no_sideways_scroll(page)
        self.to_top(policy)
        shot(page, "policy-read-phone-390")

    def test_05_contributor_and_viewer_read_it_without_an_editor(self) -> None:
        before = self.saved(self.page("hubert"))
        for who in ("marek", "lee"):
            for phone in (False, True):
                page = self.open_agents(who, phone=phone)
                policy = self.policy(page)
                expect(policy).to_contain_text(f"Revision {before['revision']} · {before['publishedBy']['name']}")
                policy.get_by_role("button", name="Show policy").click()
                expect(policy.get_by_role("definition").filter(has_text=before["reviewCriteria"])).to_have_count(1)
                expect(policy).to_contain_text("Only Hubert Nowak or Ola Kowalska can change it.")
                expect(policy.get_by_role("button", name="Edit policy")).to_have_count(0)
                expect(policy.get_by_role("button", name="Write policy")).to_have_count(0)
                expect(policy.get_by_role("form")).to_have_count(0)
                expect(policy.locator("textarea")).to_have_count(0)
                if phone:
                    self.assertGreaterEqual(policy.get_by_role("button", name="Hide policy").bounding_box()["height"], 44)
                    self.assert_no_sideways_scroll(page)
                    shot(page, f"policy-{who}-phone-390")
                else:
                    shot(page, f"policy-{who}-desktop-1440")
                # The server refuses them as well, whatever the page offers.
                refused = self.api(page, "PUT", f"/api/v1/projects/{self.ids['project']}/agent-policy",
                                   {**{field: before[field] for field in FIELD.values()}, "scope": f"{who} narrows the scope", "expectedRevision": before["revision"]})
                self.assertEqual(refused.get("code"), "FORBIDDEN")
        self.assertEqual(self.saved(self.page("hubert")), before, "the policy is unchanged")

    def test_06_a_reader_sees_a_new_revision_without_reloading(self) -> None:
        lee = self.open_agents("lee")
        policy = self.policy(lee)
        policy.get_by_role("button", name="Show policy").click()
        current = self.saved(lee)
        scope = "Firmware for the porch light, including the new LED driver."
        self.api(self.page("hubert"), "PUT", f"/api/v1/projects/{self.ids['project']}/agent-policy",
                 {**{field: current[field] for field in FIELD.values()}, "scope": scope, "expectedRevision": current["revision"]}, status=201)
        expect(policy).to_contain_text(f"Revision {current['revision'] + 1} · Hubert Nowak", timeout=6000)
        expect(policy.get_by_role("definition").filter(has_text=scope)).to_have_count(1)


if __name__ == "__main__":
    unittest.main()
