"""Round 14 of the v0.2.1 release gate, admin screens (personas-38 and the second fresh-eyes visual review, 2026-11-17).

Each test is one finding, measured in the running app: Space settings' links waiting to be used keep the card's inset (daily P2-2), what
Remove ends is said under the person's row (look-a A9), the company's invite form is a card of its own (look-a A8), Remove asking on a
company row leaves the role where it was (new P3-a, daily P3-4, look-a B9), the same links are one list on both pages (daily P3-5, P3-7)
(a person removed from the company is told so in Settings: test_accounts_by_link test_07, which has the real company).
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

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, shot, start_forwarder

PASSWORD = "round fourteen admin screens"
STAMP = int(time.time() * 1000)
COMPANY = "Riverside Makers"
SPACE = "Tool library"
PEOPLE = {"ada": ("Ada Kowalska", f"ada.r14+{STAMP}@example.test"), "kai": ("Kai Tanaka", f"kai.r14+{STAMP}@example.test"),
          "lee": ("Lee Moreno", f"lee.r14+{STAMP}@example.test")}
INVITED = f"lena.fox.r14+{STAMP}@example.test"

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

BOX = "el => { const r = el.getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom}; }"


class Round14Admin(unittest.TestCase):
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
        for who in ("kai", "lee"):
            self.api(page, "POST", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE[who][1], "role": "member"}, status=201)
            type(self).ids[who] = self.api(self.page(who), "GET", "/api/v1/me")["user"]["id"]
        space = self.api(page, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": SPACE, "visibility": "restricted"}, status=201)["id"]
        type(self).ids["space"] = space
        for who in ("kai", "lee"):
            self.api(page, "POST", f"/api/v1/projects/{space}/grants", {"principal": {"kind": "human", "id": self.ids[who]}, "role": "contributor"}, status=(200, 201))
        # Someone new invited to the space with a link (#1438): it waits to be used under the space's people.
        self.api(page, "POST", f"/api/v1/workspaces/{workspace}/invites", {"role": "member", "email": INVITED, "expiresInDays": 7, "spaceId": space}, status=201)

    @staticmethod
    def words(links) -> list[str]:
        """The words a row's buttons show (not their names for a screen reader, which add whose link it is)."""
        return links.get_by_role("listitem").first.get_by_role("button").evaluate_all(
            "els => els.map((el) => [...el.childNodes].filter((n) => !n.classList?.contains('ui-vh')).map((n) => n.textContent).join('').trim())")

    def space_settings(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['space']}/settings")
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
        expect(page.get_by_role("list", name=f"People in {SPACE}").locator("[data-person]")).to_have_count(3)

    def test_01_space_links_waiting_keep_the_cards_inset_and_read_as_the_companys(self) -> None:
        """Daily P2-2: "Invited with a link" rows had no inner padding, the address on the card's edge (x 520) while the people above start 18 px in.
        Daily P3-5: the same links were "Copy link" / "Invited with a link" here and "Copy" / "Waiting to be used" in Settings › Company."""
        self.ensure_world()
        page = self.page()
        self.space_settings(page)
        links = page.get_by_role("list", name=re.compile(r"^Waiting to be used · 1$"))
        expect(links).to_contain_text(INVITED)
        card = links.evaluate(BOX)
        who = links.locator(".people__who").first.evaluate(BOX)
        person = page.get_by_role("list", name=f"People in {SPACE}").locator(".spset__who").first.evaluate(BOX)
        avatar = page.get_by_role("list", name=f"People in {SPACE}").locator("[data-person] .ui-avatar").first.evaluate(BOX)
        self.assertGreaterEqual(who["left"] - card["left"], 16, f"the address stands inside the card, not on its edge: {who} in {card}")
        self.assertAlmostEqual(who["left"], avatar["left"], delta=1, msg=f"the address starts where the people's rows start: {who} vs {avatar} ({person})")
        self.assertEqual(self.words(links), ["Copy link", "Revoke"])
        # Revoke asks once, with the focus on its safe answer, as Remove's Keep (daily P3-7); Esc gives it back to Revoke.
        links.get_by_role("button", name=re.compile("^Revoke link for")).click()
        expect(page.get_by_role("group", name=re.compile("^Revoke link for")).get_by_role("button", name="Keep it")).to_be_focused()
        page.keyboard.press("Escape")
        expect(links.get_by_role("button", name=re.compile("^Revoke link for"))).to_be_focused()
        shot(page, f"round14-space-links-{UI_BROWSER}")
        company = self.page()
        company.goto("/settings/company")
        waiting = company.get_by_role("list", name=re.compile(r"^Waiting to be used · 1$"))
        expect(waiting).to_contain_text(INVITED)
        self.assertEqual(self.words(waiting), ["Copy link", "Revoke"], "one list on both pages")

    def test_02_space_remove_says_what_it_ends_under_the_persons_row(self) -> None:
        """Look-a A9: "Jonas stops seeing … not even its name." stood at the card's foot, rows below Jonas (on the phone partly under the tab bar)."""
        self.ensure_world()
        page = self.page()
        self.space_settings(page)
        people = page.get_by_role("list", name=f"People in {SPACE}")
        kai = people.locator(f"[data-person='{self.ids['kai']}']")
        role_before = kai.locator(".spset__rolecell").evaluate(BOX)
        kai.get_by_role("button", name=f"Remove Kai Tanaka from {SPACE}").click()
        line = people.locator(".spset__removing")
        expect(line).to_have_text(f"Kai stops seeing {SPACE} at once, not even its name.")
        row = kai.evaluate(BOX)
        said = line.evaluate(BOX)
        name = kai.locator(".spset__who b").evaluate(BOX)
        self.assertLessEqual(abs(said["top"] - row["bottom"]), 4, f"the sentence is right under Kai's row: {said} vs {row}")
        self.assertTrue(line.evaluate("el => el.previousElementSibling?.dataset.person"), "the row before the sentence is the person's")
        self.assertAlmostEqual(said["left"] + float(line.evaluate("el => getComputedStyle(el).paddingLeft").rstrip("px")), name["left"], delta=1,
                               msg="the sentence starts under the name")
        self.assertEqual(kai.locator(".spset__rolecell").evaluate(BOX)["left"], role_before["left"], "the role stays where it was")
        shot(page, f"round14-space-remove-{UI_BROWSER}")
        kai.get_by_role("group", name="Remove Kai Tanaka").get_by_role("button", name="Keep").click()
        expect(line).to_have_count(0)

    def test_03_company_invite_form_is_a_card_of_its_own(self) -> None:
        """Look-a A8: the "Create invite link / Close" row touched the people's card (0 px), and More stood 12 px in from the field's edge."""
        self.ensure_world()
        page = self.page()
        page.goto("/settings/company")
        page.get_by_role("button", name="Invite", exact=True).click()
        form = page.get_by_role("form", name="Invite people")
        expect(form).to_be_visible()
        drawn = form.evaluate(BOX)
        card = page.locator(".people__card").evaluate(BOX)
        self.assertGreaterEqual(card["top"] - drawn["bottom"], 12, f"the form and the people's card have room between them: {drawn} / {card}")
        self.assertNotEqual(form.evaluate("el => getComputedStyle(el).backgroundColor"), "rgba(0, 0, 0, 0)", "the form is drawn as a card")
        field = form.get_by_label("Email (optional)").evaluate(BOX)
        more = form.get_by_role("button", name="More").evaluate("el => { const r = el.getBoundingClientRect(); return r.left + parseFloat(getComputedStyle(el).paddingLeft); }")
        self.assertAlmostEqual(more, field["left"], delta=2, msg="More's word starts at the field's edge")
        # No hairline between the form's parts: the card's row rule is not drawn inside a form.
        self.assertEqual(form.evaluate("el => [...el.children].filter((c) => parseFloat(getComputedStyle(c).borderTopWidth) > 0).length"), 0)
        shot(page, f"round14-company-invite-{UI_BROWSER}")

    def test_04_company_remove_asks_on_the_row_and_the_role_stays(self) -> None:
        """New P3-a, daily P3-4, look-a B9: while Remove asked, the role and Reset link moved 55–62 px left; the sentence started at the face."""
        self.ensure_world()
        page = self.page()
        page.goto("/settings/company")
        row = page.locator(f"[data-person='{self.ids['kai']}']")
        role = row.locator(".people__rolecell")
        expect(role).to_be_visible()
        before = role.evaluate(BOX)
        row.get_by_role("button", name=f"Remove Kai Tanaka from {COMPANY}").click()
        ask = row.get_by_role("group", name="Remove Kai Tanaka")
        expect(ask.get_by_role("button", name="Keep")).to_be_focused()
        self.assertEqual(role.evaluate(BOX), before, "the role does not move while Remove asks")
        said = row.locator(".people__removing").evaluate(BOX)
        name = row.locator(".people__who b").evaluate(BOX)
        self.assertAlmostEqual(said["left"], name["left"], delta=1, msg="what Remove ends starts under the name")
        shot(page, f"round14-company-remove-{UI_BROWSER}")
        ask.get_by_role("button", name="Keep").click()
        expect(row.get_by_role("button", name="Reset link for Kai Tanaka")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
