"""Round 15 of the v0.2.1 release gate, admin screens (personas-39 and the atlas-39 visual review, 2026-11-17).

Each test is one finding, measured in the running app:
* daily P2-1: after an encrypted space is unlocked from its centre card, People and encryption no longer says "… is locked.";
* daily P2-2: an encrypted space's people use the rows of every other list (the role menu at once, Remove on the row, Add people's list),
  listed once (Space settings does not list them a second time beside the panel);
* daily P2-5: New space's Name is a heading as People is, and the AI and Encrypted rows start their words at one edge;
* new P3-b, daily P3-1: a role that cannot be changed ends on the column's right edge, where a menu's chevron ends; People starts where Name starts;
* new P3-i: a new invite link comes into view with its sentence (Settings › Company) or below the field the cursor stays in (Space settings);
* daily P3-2: Space settings lists its links newest first, as the company does;
* daily P3-3: every ask opens on its safe answer, drawn the same (Lock's Keep it unlocked as Remove's Keep);
* daily P3-5: a person restored while the page is open takes their sorted place, not the end of the list.
Runs through scripts/check_ui.sh against the running app.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from app_select import choose
from create_window import create_other, new_space_window, open_create
from light_motion_fixture import settled
from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, shot, start_forwarder
from test_encrypted_workspaces import A_NAME, UNLOCK_PASSWORD, Base

PASSWORD = "round fifteen admin screens"
STAMP = int(time.time() * 1000)
COMPANY = "Riverside Makers"
SPACE = "Tool library"
PEOPLE = {"ada": ("Ada Kowalska", f"ada.r15+{STAMP}@example.test"), "kai": ("Kai Tanaka", f"kai.r15+{STAMP}@example.test"),
          "lee": ("Lee Moreno", f"lee.r15+{STAMP}@example.test"), "mia": ("Mia Novak", f"mia.r15+{STAMP}@example.test")}

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

BOX = "el => { const r = el.getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom}; }"
# The box of an element's own words (a Range over its text), not of its padding.
WORDS = """el => { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect();
  return {left: r.left, top: r.top, right: r.right, bottom: r.bottom}; }"""
# Where an element is inside the pane that scrolls it: in view when its top and bottom are both inside.
IN_PANE = """el => { const pane = el.closest('.pane-scroll') || document.scrollingElement; const p = pane.getBoundingClientRect(); const r = el.getBoundingClientRect();
  return {top: r.top - p.top, bottom: p.bottom - r.bottom}; }"""


class Round15Admin(unittest.TestCase):
    browser: Browser
    states: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}")
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "ada") -> Page:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=DESKTOP, device_scale_factor=1,
                                           storage_state=self.states[who])
        self.addCleanup(context.close)
        try:
            context.grant_permissions(["clipboard-read", "clipboard-write"], origin=ORIGIN)
        except Exception:  # WebKit has no clipboard permission to grant: the link is said "created" instead of "created and copied".
            pass
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | tuple[int, ...] = 200) -> dict | list:
        headers = {"origin": ORIGIN, "idempotency-key": str(uuid.uuid4()), **({"content-type": "application/json"} if body is not None else {})}
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None, headers=headers)
        self.assertIn(response.status, status if isinstance(status, tuple) else (status,), response.text())
        return json.loads(response.text()) if response.text() else {}

    def ensure_world(self) -> None:
        if self.states:
            return
        for who, (name, email) in PEOPLE.items():
            context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block")
            self.addCleanup(context.close)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            self.assertEqual(response.status, 200, response.text())
            type(self).states[who] = context.storage_state()
        page = self.page("ada")
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": COMPANY}, status=201)["id"]
        type(self).ids["workspace"] = workspace
        for who in ("kai", "lee", "mia"):
            self.api(page, "POST", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE[who][1], "role": "member"}, status=201)
            type(self).ids[who] = self.api(self.page(who), "GET", "/api/v1/me")["user"]["id"]
        space = self.api(page, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": SPACE, "visibility": "restricted"}, status=201)["id"]
        type(self).ids["space"] = space
        for who in ("kai", "lee"):
            self.api(page, "POST", f"/api/v1/projects/{space}/grants", {"principal": {"kind": "human", "id": self.ids[who]}, "role": "contributor"}, status=(200, 201))

    def space_settings(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['space']}/settings")
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
        expect(page.get_by_role("list", name=f"People in {SPACE}").locator("[data-person]")).to_have_count(3)

    def test_01_a_fixed_role_ends_where_a_menus_chevron_ends_and_people_starts_with_name(self) -> None:
        """New P3-b, daily P3-1: "Owner" (932–969) did not line up with "Member ⌄" (922–985); Company, all menus, lines them up. People sat at 520,
        Name at 522."""
        self.ensure_world()
        page = self.page()
        self.space_settings(page)
        people = page.get_by_role("list", name=f"People in {SPACE}")
        owner = people.locator(f"[data-person] .spset__role").first.evaluate(WORDS)
        chevron = people.locator(f"[data-person='{self.ids['kai']}'] .ui-select__chev").evaluate(BOX)
        self.assertAlmostEqual(owner["right"], chevron["right"], delta=1.5, msg=f"Owner ends on the column's edge, where Member ⌄ ends: {owner} vs {chevron}")
        name = page.get_by_role("heading", name="Name", exact=True).evaluate(WORDS)
        heading = page.locator("#space-people").evaluate(WORDS)
        self.assertAlmostEqual(heading["left"], name["left"], delta=0.5, msg=f"People starts where Name starts: {heading} vs {name}")
        shot(page, f"round15-space-roles-{UI_BROWSER}")

    def test_02_new_space_name_is_a_heading_and_its_switch_rows_start_at_one_edge(self) -> None:
        """Daily P2-5: "Name" was a small grey label 4 px under the head's hairline while People was a bold heading; the AI row's words started at
        462 and Encrypted's at 498 (only Encrypted had an icon)."""
        self.ensure_world()
        page = self.page()
        page.goto("/")
        open_create(page)
        create_other(page, "Space")
        window = new_space_window(page)
        name = window.locator(".ui-field__label").first
        expect(name).to_have_text("Name")
        people = window.locator(".newspace__label").first
        style = "el => { const s = getComputedStyle(el); return [s.fontSize, s.fontWeight, s.color]; }"
        self.assertEqual(name.evaluate(style), people.evaluate(style), "Name is drawn as People: one heading style")
        head = window.locator(".newspace__head").evaluate(BOX)
        self.assertGreaterEqual(name.evaluate(BOX)["top"] - head["bottom"], 12, "Name has room under the head's hairline")
        ai = window.get_by_role("switch", name="AI").locator("xpath=ancestor::*[contains(@class,'sset-row')][1]").locator(".sset-row__t").evaluate(BOX)
        encrypted = window.get_by_role("switch", name="Encrypted").locator("xpath=ancestor::*[contains(@class,'sset-row')][1]").locator(".sset-row__t").evaluate(BOX)
        self.assertAlmostEqual(ai["left"], encrypted["left"], delta=0.5, msg=f"AI and Encrypted start at one edge: {ai} vs {encrypted}")
        shot(page, f"round15-new-space-{UI_BROWSER}")

    def test_03_a_new_company_link_comes_into_view_with_its_sentence(self) -> None:
        """New P3-i: Enter moved the focus to the link at the pane's bottom edge and the "created and copied" line was below the fold."""
        self.ensure_world()
        page = self.page()
        page.goto("/settings/company")
        page.get_by_role("button", name="Invite", exact=True).click()
        field = page.get_by_label("Email (optional)")
        field.fill(f"lena.{uuid.uuid4().hex[:6]}@example.test")
        field.press("Enter")
        link = page.locator("#people-invite-link")
        expect(link).to_be_focused()
        said = page.get_by_role("status").filter(has_text=re.compile("^Invite link created"))
        expect(said).to_be_visible()
        page.wait_for_timeout(300)
        for what, element in (("the link", link), ("its sentence", said)):
            room = element.evaluate(IN_PANE)
            self.assertGreaterEqual(room["top"], 0, f"{what} is in view: {room}")
            self.assertGreaterEqual(room["bottom"], 0, f"{what} is in view: {room}")
        self.assertEqual(said.evaluate("el => el.closest('li')?.dataset.invite ?? null"), link.evaluate("el => el.closest('li')?.dataset.invite ?? null"),
                         "the sentence stands in the new link's row")
        shot(page, f"round15-company-link-{UI_BROWSER}")

    def test_04_a_new_space_link_comes_into_view_newest_first_and_the_cursor_stays_for_the_next(self) -> None:
        """New P3-i: Space settings kept the focus in the field and put the link out of view. Daily P3-2: its links were oldest first."""
        self.ensure_world()
        page = self.page()
        self.space_settings(page)
        page.get_by_role("button", name="Add people").click()
        email = page.locator("#spset-new-email")
        older = f"older.{uuid.uuid4().hex[:6]}@example.test"
        email.fill(older)
        email.press("Enter")
        expect(page.get_by_role("list", name=re.compile(r"^Waiting to be used · ")).locator("li").first).to_contain_text(older)
        newer = f"newer.{uuid.uuid4().hex[:6]}@example.test"
        email.fill(newer)
        email.press("Enter")
        links = page.get_by_role("list", name=re.compile(r"^Waiting to be used · "))
        expect(links.locator("li").first).to_contain_text(newer)
        expect(email).to_be_focused()
        page.wait_for_timeout(400)
        row = links.locator("li").filter(has_text=newer)
        room = row.locator("input").evaluate(IN_PANE)
        self.assertGreaterEqual(room["top"], 0, f"the new link is in view: {room}")
        self.assertGreaterEqual(room["bottom"], 0, f"the new link is in view: {room}")
        shot(page, f"round15-space-link-{UI_BROWSER}")

    def test_05_a_restored_person_takes_their_place_in_the_list(self) -> None:
        """Daily P3-5: Restore moved Tomek to the end of People."""
        self.ensure_world()
        page = self.page()
        self.api(page, "DELETE", f"/api/v1/workspaces/{self.ids['workspace']}/members/{self.ids['kai']}", status=204)
        page.goto("/settings/company")
        people = page.get_by_role("list", name=f"People in {COMPANY}")
        expect(people.locator("[data-person]")).to_have_count(3)
        page.get_by_role("button", name="Restore", exact=True).click()
        expect(people.locator("[data-person]")).to_have_count(4)
        names = people.locator("[data-person] .people__who b").all_inner_texts()
        self.assertEqual([re.sub(r"\s*\(you\)$", "", name) for name in names], ["Ada Kowalska", "Kai Tanaka", "Lee Moreno", "Mia Novak"],
                         "Kai is back in his place, by role and name, not at the end")
        shot(page, f"round15-company-restored-{UI_BROWSER}")


class Round15Encrypted(Base):
    """An encrypted space (the real key service, as test_encrypted_workspaces)."""

    def test_10_unlocked_from_the_centre_card_the_panel_no_longer_says_locked(self) -> None:
        """Daily P2-1: "✓ Board minutes is locked." stayed under "Unlocked by Ada Kowalska at 14:39" until a reload."""
        world = self.make_world()
        page = self.page(world, "ada")
        self.open_people(page)
        section = self.section(page)
        section.get_by_role("button", name="Lock now").click()
        section.get_by_role("group", name=f"Lock {A_NAME}").get_by_role("button", name=f"Lock {A_NAME}").click()
        expect(section.get_by_role("status")).to_have_text(f"{A_NAME} is locked.")
        card = page.locator(".locked__card")
        card.get_by_label("Your unlock password").fill(UNLOCK_PASSWORD)
        card.get_by_label("Your unlock password").press("Enter")
        expect(section.locator(".people__enc-line")).to_contain_text("Unlocked by Ada Kowalska")
        expect(section.get_by_text(f"{A_NAME} is locked.")).to_have_count(0)
        shot(page, f"round15-unlocked-from-card-{UI_BROWSER}")

    def test_12_every_ask_opens_on_its_safe_answer_drawn_the_same(self) -> None:
        """Daily P3-3: Remove showed "Remove | Keep" with a grey Keep, Revoke "Revoke link | Keep it", and Lock focused "Lock Board minutes" while
        the others focused Keep."""
        world = self.make_world()
        page = self.page(world, "ada")
        self.open_people(page)
        section = self.section(page)
        section.get_by_role("button", name="Lock now").click()
        ask = section.get_by_role("group", name=f"Lock {A_NAME}")
        expect(ask.get_by_role("button", name="Keep it unlocked")).to_be_focused()
        self.assertIn("ui-btn--secondary", ask.get_by_role("button", name="Keep it unlocked").get_attribute("class") or "")
        self.assertIn("ui-btn--danger", ask.get_by_role("button", name=f"Lock {A_NAME}").get_attribute("class") or "")
        page.keyboard.press("Escape")
        # A row's Remove asks with the same answer: Keep, secondary and focused.
        row = page.get_by_role("list", name=f"People in {A_NAME}").get_by_role("listitem").filter(has_text="Cy Moreno")
        row.get_by_role("button", name=f"Remove Cy Moreno from {A_NAME}").click()
        keep = row.get_by_role("group", name="Remove Cy Moreno").get_by_role("button", name="Keep", exact=True)
        expect(keep).to_be_focused()
        self.assertIn("ui-btn--secondary", keep.get_attribute("class") or "")

    def test_11_an_encrypted_spaces_people_are_the_rows_of_every_list_listed_once(self) -> None:
        """Daily P2-2: the panel repeated the page's people with "Change", whose form had Owner/Admin/Member/Guest with the company's words, Save
        role and Remove inside it; adding was an Email and Role form, not the Add people list."""
        world = self.make_world()
        # Someone of Ada's company who is not in the space yet, for Add people.
        email, eli, _ = self.sign_up("eli", uuid.uuid4().hex[:10], "Eli Dahl")
        self.call(world, "ada", "POST", f"/api/v1/workspaces/{world.b}/members", {"email": email, "role": "member"}, 201)
        page = self.page(world, "ada")
        page.goto(f"/projects/{world.a_project}/settings")
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
        # Listed once: the page has no card of the same people beside the panel.
        expect(page.locator("[data-space-settings]").get_by_role("list", name=f"People in {A_NAME}")).to_have_count(0)
        self.open_people(page)
        panel = page.locator("#details")
        people = panel.get_by_role("list", name=f"People in {A_NAME}")
        expect(people.get_by_role("button", name=re.compile("^Change"))).to_have_count(0)
        expect(panel.get_by_role("region", name="Add someone")).to_have_count(0)
        cy = people.get_by_role("listitem").filter(has_text="Cy Moreno")
        expect(cy.get_by_role("button", name=f"Remove Cy Moreno from {A_NAME}")).to_be_visible()
        # The role menu acts at once, with Undo, as Settings › Company's.
        choose(cy.get_by_role("combobox", name="Role of Cy Moreno"), value="admin")
        expect(page.locator(".ui-toast")).to_contain_text("Cy is an admin now")
        roles = {m["userId"]: m["role"] for m in self.call(world, "ada", "GET", f"/api/v1/workspaces/{world.a}/members")}
        self.assertEqual(roles[world.ids["cy"]], "admin", "the role changed at once, without a Save")
        # Add people is the company's people in one list.
        panel.get_by_role("button", name="Add people").click()
        add = panel.get_by_role("group", name="Add people")
        add.locator("label").filter(has_text="Eli Dahl").get_by_role("checkbox").check()
        add.get_by_role("button", name="Add 1 person").click()
        expect(people.get_by_role("listitem").filter(has_text="Eli Dahl")).to_be_visible()
        self.assertIn(eli, [m["userId"] for m in self.call(world, "ada", "GET", f"/api/v1/workspaces/{world.a}/members")])
        settled(page)
        shot(page, f"round15-encrypted-people-{UI_BROWSER}")


if __name__ == "__main__":
    unittest.main()
