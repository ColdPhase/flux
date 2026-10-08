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
import re
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
# One line of purpose in every state (#272, PR #292 B1): what the policy is, who writes it, whether to act.
WHAT = "Rules connected agents read before they plan work in this project."
FOR_READERS = f"{WHAT} Only Hubert Nowak or Ola Kowalska write them; you don\u2019t need to do anything."
FOR_MANAGERS_BEFORE = f"{WHAT} They\u2019re optional: write them when agents here should keep to certain work or meet review rules."
FOR_MANAGERS_AFTER = f"{WHAT} You can change them at any time."
PUBLISHED = "Published. Agents use it from their next task."
# Words of Flux's internals that people should not need (PR #292 S3).
INTERNAL = ("checkpoint", "grants", "bootstrap")
FONT_SIZE = "el => parseFloat(getComputedStyle(el).fontSize)"
# The smallest visible text in an element (Apple HIG checklist HIG-08: none under 11 px on a touch screen).
SMALLEST_TEXT = """el => {
  const sizes = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (walker.currentNode.textContent.trim() && parent.getClientRects().length) sizes.push(parseFloat(getComputedStyle(parent).fontSize));
  }
  return Math.min(...sizes);
}"""
# What a press may change (HIG-16): fill, opacity, scale or brightness.
PRESS_STYLE = "el => { const s = getComputedStyle(el); return [s.backgroundColor, s.opacity, s.transform, s.filter].join(' | '); }"


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
        # The policy is one row of the Agents list; `?policy=open` opens it, as its row does.
        page.goto(f"/projects/{self.ids['project']}/agents?policy=open")
        expect(page.get_by_role("heading", level=1, name="Agents")).to_be_visible()
        return page

    def policy(self, page: Page):
        return page.get_by_role("region", name="Agent policy")

    def editor(self, page: Page):
        return self.policy(page).get_by_role("form", name="Edit agent policy")

    def to_top(self, locator) -> None:
        """Scrolls the view's pane so the policy starts at the top of the screenshot."""
        locator.evaluate("el => el.scrollIntoView({ block: 'start' })")

    def press_changes(self, page: Page, button) -> tuple[str, str]:
        """The button's look before and while pressed, with :active forced as the HIG checklist's check does."""
        before = button.evaluate(PRESS_STYLE)
        button.evaluate("el => el.setAttribute('data-press-probe', '')")
        cdp = page.context.new_cdp_session(page)
        try:
            cdp.send("DOM.enable")
            cdp.send("CSS.enable")
            root = cdp.send("DOM.getDocument", {"depth": 0})["root"]["nodeId"]
            node = cdp.send("DOM.querySelector", {"nodeId": root, "selector": "[data-press-probe]"})["nodeId"]
            cdp.send("CSS.forcePseudoState", {"nodeId": node, "forcedPseudoClasses": ["active"]})
            page.wait_for_timeout(300)  # past the colour transition
            pressed = button.evaluate(PRESS_STYLE)
            cdp.send("CSS.forcePseudoState", {"nodeId": node, "forcedPseudoClasses": []})
        finally:
            cdp.detach()
            button.evaluate("el => el.removeAttribute('data-press-probe')")
        return before, pressed

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

    def assert_plain_words(self, locator) -> None:
        text = locator.inner_text().lower()
        for word in INTERNAL:
            self.assertNotIn(word, text, f"no internal vocabulary: {word!r}")

    def test_01b_before_the_first_publish_everyone_learns_what_it_is_and_whether_to_act(self) -> None:
        for phone in (False, True):
            size = "phone-390" if phone else "desktop-1440"
            # A contributor: what it is, who writes it, and that there is nothing to do; nothing to press.
            marek = self.open_agents("marek", phone=phone)
            policy = self.policy(marek)
            expect(policy.locator(".agents-policy__meta")).to_have_text("None yet")
            expect(policy.locator(".agents-policy__purpose")).to_have_text(FOR_READERS)
            expect(policy.locator(".agents-policy__purpose")).to_be_visible()
            expect(policy.get_by_role("button")).to_have_count(0)
            self.assert_plain_words(policy)
            shot(marek, f"policy-none-reader-{size}")
            # A manager: why one might write it, and that it is optional.
            hubert = self.open_agents("hubert", phone=phone)
            policy = self.policy(hubert)
            expect(policy.locator(".agents-policy__purpose")).to_have_text(FOR_MANAGERS_BEFORE)
            expect(policy.locator(".agents-policy__purpose")).to_be_visible()
            expect(policy.get_by_role("button", name="Write policy")).to_be_visible()
            self.assert_plain_words(policy)
            if phone:
                self.assertGreaterEqual(policy.evaluate(SMALLEST_TEXT), 11)
                self.assert_no_sideways_scroll(hubert)
            shot(hubert, f"policy-none-manager-{size}")

    def test_02_desktop_manager_writes_and_publishes_the_first_revision(self) -> None:
        page = self.open_agents("hubert")
        policy = self.policy(page)
        expect(policy).to_contain_text("None yet")
        expect(policy.get_by_role("button", name="Show policy")).to_have_count(0)
        policy.get_by_role("button", name="Write policy").click()
        form = self.editor(page)
        expect(form.get_by_label("Scope", exact=True)).to_be_focused()
        expect(form).to_contain_text("It only narrows what agents do; it never gives them more access.")

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
        expect(form).to_contain_text("Agents use revision 1 from their next task.")
        self.assert_plain_words(form)
        self.to_top(policy)
        shot(page, "policy-edit-desktop-1440")

        form.get_by_role("button", name="Publish revision 1").click()
        expect(policy.get_by_role("status")).to_have_text(PUBLISHED)
        expect(form).to_have_count(0)
        expect(policy).to_contain_text("Revision 1 · Hubert Nowak")
        # The revision is named once, in the line under the title (PR #292 nit).
        self.assertEqual(policy.inner_text().count("Revision 1"), 1)
        expect(policy.locator(".agents-policy__purpose")).to_have_text(FOR_MANAGERS_AFTER)
        self.assert_plain_words(policy)
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
        # The agent list and its one primary button are still there above it.
        expect(page.get_by_role("list", name="Agents in this project").get_by_role("listitem")).to_have_count(1)
        expect(page.get_by_role("button", name="Hand off a task")).to_be_visible()

    def lose_answers(self, page: Page, state: dict) -> None:
        """The next PUT is saved by the server but its answer never arrives; GETs fail while `offline` is set."""
        def handle(route) -> None:
            if route.request.method == "PUT" and state["lose"]:
                state["lose"] -= 1
                route.fetch()  # the server publishes
                route.abort()  # the answer is lost
            elif route.request.method == "GET" and state["offline"]:
                route.abort()
            else:
                route.continue_()
        page.route("**/agent-policy", handle)
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))

    def test_02b_a_lost_answer_is_reported_truthfully_and_never_shown_as_someone_else(self) -> None:
        # Flux is reachable again at once: the page asks, finds the revision it made, and is done.
        base = self.publish_through_api("hubert", {"scope": FIRST["Scope"]})["revision"]
        page = self.open_agents("hubert")
        self.lose_answers(page, state := {"lose": 1, "offline": False})
        policy = self.policy(page)
        policy.get_by_role("button", name="Show policy").click()
        policy.get_by_role("button", name="Edit policy").click()
        form = self.editor(page)
        form.get_by_label("Scope", exact=True).fill("Firmware and the PIR mount.")
        form.get_by_role("button", name=f"Publish revision {base + 1}").click()
        expect(policy.get_by_role("status")).to_have_text(PUBLISHED)
        expect(form).to_have_count(0)
        expect(policy).not_to_contain_text("while you were editing")
        expect(policy).not_to_contain_text("another tab")
        self.assertEqual(state["lose"], 0, "the answer was lost")
        saved = self.saved(page)
        self.assertEqual((saved["revision"], saved["scope"], saved["publishedBy"]["id"]), (base + 1, "Firmware and the PIR mount.", PEOPLE["hubert"]["id"]))

        # Flux stays unreachable for a moment: the page says only what it knows, keeps the text, and a changed text
        # published later continues from the revision the lost publish made, not as a conflict with oneself.
        base = saved["revision"]
        page = self.open_agents("hubert")
        self.lose_answers(page, state := {"lose": 1, "offline": True})
        policy = self.policy(page)
        policy.get_by_role("button", name="Show policy").click()
        policy.get_by_role("button", name="Edit policy").click()
        form = self.editor(page)
        form.get_by_label("Scope", exact=True).fill("Firmware, the PIR mount and the enclosure.")
        form.get_by_role("button", name=f"Publish revision {base + 1}").click()
        expect(form.get_by_role("alert")).to_have_text("Flux couldn\u2019t confirm the publish. Your text is kept; publishing again won\u2019t publish it twice.")
        expect(form.get_by_label("Scope", exact=True)).to_have_value("Firmware, the PIR mount and the enclosure.")
        self.assertEqual(self.saved(page)["revision"], base + 1, "it was saved after all")
        shot(page, "policy-lost-answer-desktop-1440")
        state["offline"] = False
        form.get_by_label("Scope", exact=True).fill("Firmware, the PIR mount and the enclosure lid.")
        form.get_by_role("button", name=f"Publish revision {base + 1}").click()
        expect(form.get_by_role("status")).to_have_text(f"Your earlier publish went through as revision {base + 1}. Your later changes aren\u2019t published yet.")
        expect(form.get_by_role("alert")).to_have_count(0)
        expect(policy).not_to_contain_text("while you were editing")
        expect(policy).not_to_contain_text("another tab")
        form.get_by_role("button", name=f"Publish revision {base + 2}").click()
        expect(policy.get_by_role("status")).to_have_text(PUBLISHED)
        saved = self.saved(page)
        self.assertEqual((saved["revision"], saved["scope"]), (base + 2, "Firmware, the PIR mount and the enclosure lid."))

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
        expect(conflict).to_have_text(f"Ola Kowalska published revision {base + 1} while you were editing. "
                                      "Your text is kept; the changes are shown under Allowed work. Publishing yours replaces them.")
        expect(form.get_by_label("Scope", exact=True)).to_have_value(mine)
        saved = self.saved(hubert)
        self.assertEqual((saved["revision"], saved["scope"], saved["allowedWork"]), (base + 1, FIRST["Scope"], theirs), "Hubert's edit was not published")
        # Only the part she changed is shown, under its own field, so he can keep it (PR #292 S2).
        changed = self.their_part(form, "Allowed work")
        expect(form.get_by_role("group")).to_have_count(1)
        expect(changed).to_contain_text("Their allowed work")
        expect(changed).to_contain_text(theirs)
        self.to_top(policy)
        shot(hubert, "policy-conflict-desktop-1440")
        changed.get_by_role("button", name="Use their allowed work").click()
        expect(form.get_by_label("Allowed work", exact=True)).to_have_value(theirs)
        expect(changed).to_contain_text("Yours now matches it.")
        expect(form.get_by_label("Scope", exact=True)).to_have_value(mine)
        publish = form.get_by_role("button", name=f"Publish mine as revision {base + 2}")
        publish.scroll_into_view_if_needed()
        shot(hubert, "policy-conflict-actions-desktop-1440")

        # He has read hers and kept her part; publishing now replaces her revision as the next one, knowingly.
        publish.click()
        expect(policy.get_by_role("status")).to_have_text(PUBLISHED)
        saved = self.saved(hubert)
        self.assertEqual((saved["revision"], saved["scope"], saved["allowedWork"], saved["publishedBy"]["id"]),
                         (base + 2, mine, theirs, PEOPLE["hubert"]["id"]))
        # Ola's open view follows without a reload.
        expect(ola_policy).to_contain_text(f"Revision {base + 2} · Hubert Nowak")

    def their_part(self, form, label: str):
        """The other revision's text for one part; it sits right under that part's own field."""
        group = form.get_by_role("group", name=f"Their {label.lower()}")
        field = form.get_by_label(label, exact=True).bounding_box()
        box = group.bounding_box()
        self.assertGreater(box["y"], field["y"] + field["height"], f"under the {label} field")
        self.assertLess(box["y"] - (field["y"] + field["height"]), 90, f"right under the {label} field, after its hint only")
        return group

    def test_03b_phone_conflict_shows_their_text_under_the_changed_field(self) -> None:
        base = self.publish_through_api("hubert", {field: FIRST[label] for label, field in FIELD.items()})["revision"]
        for width, height in ((390, 844), (320, 568)):
            hubert = self.open_agents("hubert", phone=True)
            hubert.set_viewport_size({"width": width, "height": height})
            policy = self.policy(hubert)
            policy.get_by_role("button", name="Show policy").click()
            policy.get_by_role("button", name="Edit policy").click()
            form = self.editor(hubert)
            form.get_by_label("Scope", exact=True).fill(f"Firmware only ({width} px).")
            theirs = f"Results only, no tasks this week ({width} px)."
            base = self.publish_through_api("ola", {"allowedWork": theirs})["revision"] - 1
            publish = form.get_by_role("button", name=re.compile(r"^Publish revision \d+$"))
            publish.scroll_into_view_if_needed()
            publish.click()
            banner = form.get_by_role("alert")
            expect(banner).to_contain_text(f"Ola Kowalska published revision {base + 1} while you were editing.")
            # A short banner: four lines at most at 390 px, five at 320 px.
            lines = banner.evaluate("el => Math.round((el.clientHeight - 16) / parseFloat(getComputedStyle(el).lineHeight))")
            self.assertLessEqual(lines, 4 if width == 390 else 5, f"banner lines at {width} px")
            changed = self.their_part(form, "Allowed work")
            changed.scroll_into_view_if_needed()
            use = changed.get_by_role("button", name="Use their allowed work")
            self.assertGreaterEqual(use.bounding_box()["height"], 44)
            self.assert_no_sideways_scroll(hubert)
            shot(hubert, f"policy-conflict-phone-{width}")
            use.click()
            expect(form.get_by_label("Allowed work", exact=True)).to_have_value(theirs)
            form.get_by_role("button", name=f"Publish mine as revision {base + 2}").click()
            expect(policy.get_by_role("status")).to_have_text(PUBLISHED)
            saved = self.saved(hubert)
            self.assertEqual((saved["revision"], saved["scope"], saved["allowedWork"]), (base + 2, f"Firmware only ({width} px).", theirs))

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
        # Readable on a touch screen: nothing under 11 px, secondary lines at 13 px, the policy itself at 16 px.
        expect(policy.get_by_role("definition").first).to_be_visible()
        self.assertGreaterEqual(policy.evaluate(SMALLEST_TEXT), 11, "no text under 11 px (HIG-08)")
        self.assertGreaterEqual(policy.locator(".agents-policy__meta").evaluate(FONT_SIZE), 13, "the revision line")
        for definition in policy.get_by_role("definition").all():
            self.assertGreaterEqual(definition.evaluate(FONT_SIZE), 16, "the policy reads at 16 px (HIG-09)")
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
        gap = cancel.bounding_box()["x"] - (publish.bounding_box()["x"] + publish.bounding_box()["width"])
        self.assertGreaterEqual(gap, 12, "12 px between neighbouring buttons (HIG-15)")
        self.assertGreaterEqual(form.evaluate(SMALLEST_TEXT), 11, "no text under 11 px in the editor (HIG-08)")
        self.assert_no_sideways_scroll(page)
        shot(page, "policy-edit-phone-390")
        publish.click()
        expect(policy.get_by_role("status")).to_have_text(PUBLISHED)
        saved = self.saved(page)
        self.assertEqual((saved["revision"], saved["reviewCriteria"], saved["publishedBy"]["id"]), (base + 1, criteria, PEOPLE["ola"]["id"]))
        self.assert_no_sideways_scroll(page)
        self.to_top(policy)
        shot(page, "policy-read-phone-390")

    def test_04b_phone_buttons_have_a_press_state_and_no_hover_fill(self) -> None:
        page = self.open_agents("ola", phone=True)
        self.assertTrue(page.evaluate("() => matchMedia('(hover: none)').matches"), "the phone context has no hover")
        policy = self.policy(page)
        show = policy.get_by_role("button", name="Show policy")
        before, pressed = self.press_changes(page, show)
        self.assertNotEqual(before, pressed, "Show policy has a press state (HIG-16)")
        show.click()
        hide = policy.get_by_role("button", name="Hide policy")
        expect(hide).to_have_css("background-color", "rgba(0, 0, 0, 0)")
        policy.get_by_role("button", name="Edit policy").click()
        form = self.editor(page)
        for button in (form.get_by_role("button", name="Cancel"), form.get_by_role("button", name=re.compile(r"^Publish revision \d+$"))):
            button.scroll_into_view_if_needed()
            self.assertEqual(button.evaluate("el => getComputedStyle(el).touchAction"), "manipulation", "no double-tap delay (HIG-17)")
            before, pressed = self.press_changes(page, button)
            self.assertNotEqual(before, pressed, f"{button.inner_text()} has a press state (HIG-16)")
        form.get_by_role("button", name="Cancel").click()
        expect(form).to_have_count(0)

    def test_05_contributor_and_viewer_read_it_without_an_editor(self) -> None:
        before = self.saved(self.page("hubert"))
        for who in ("marek", "lee"):
            for phone in (False, True):
                page = self.open_agents(who, phone=phone)
                policy = self.policy(page)
                expect(policy).to_contain_text(f"Revision {before['revision']} · {before['publishedBy']['name']}")
                policy.get_by_role("button", name="Show policy").click()
                expect(policy.get_by_role("definition").filter(has_text=before["reviewCriteria"])).to_have_count(1)
                expect(policy.locator(".agents-policy__purpose")).to_have_text(FOR_READERS)
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
