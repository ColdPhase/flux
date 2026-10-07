"""Kreska (#339, final design F-026 §3): the Flux logo, every agent's icon with the "Agent" tag and
"for <owner>", agent colours only in the Agents section, and the install icons.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import json
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "a face in a squircle"
EMAIL = f"ada.kreska+{int(time.time() * 1000)}@example.test"
TILE = "M7 0H17C21.2 0 24 2.8 24 7V17C24 21.2 21.2 24 17 24H7C2.8 24 0 21.2 0 17V7C0 2.8 2.8 0 7 0Z"
INK = "e => { const i = document.createElement('i'); i.style.color = 'var(--inv)'; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; }"


class KreskaJourney(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}

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

    def page(self, *, phone: bool = False, scheme: str = "light", reduced: bool = False, signed_in: bool = True) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "reduced_motion": "reduce" if reduced else "no-preference"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if signed_in and self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def api(self, page: Page, method: str, path: str, body: dict) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body))
        self.assertEqual(response.status, 201, response.text())
        return json.loads(response.text())

    def ensure_account(self) -> None:
        if self.state:
            return
        page = self.page(signed_in=False)
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Kreska")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Garden sensors"})
        project = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Soil probes", "visibility": "restricted"})
        agent = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/agents", {"name": "Codex", "owner": "self"})
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"})
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Calibrate the probes", "owner": {"kind": "agent", "id": agent["id"]}})
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Order the enclosures", "owner": {"kind": "human", "id": self.me(page)}})
        type(self).ids = {"workspace": workspace["id"], "project": project["id"], "agent": agent["id"]}
        type(self).state = page.context.storage_state()

    def me(self, page: Page) -> str:
        return json.loads(page.request.get(f"{ORIGIN}/api/v1/me").text())["user"]["id"]

    def test_01_the_logo_is_the_tile_with_the_face_knocked_out(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            with self.subTest(scheme=scheme):
                signed_out = self.page(scheme=scheme, signed_in=False)
                signed_out.goto("/sign-in")
                brand = signed_out.locator(".brand")
                expect(brand.locator("svg.flux-logo")).to_have_count(1)
                expect(brand.locator(".brand__name")).to_have_text("flux")
                self.assertEqual(brand.locator(".flux-logo__tile").get_attribute("d"), TILE)
                self.assertEqual(brand.locator(".flux-logo__tile").evaluate("e => getComputedStyle(e).fill"), signed_out.evaluate(INK, None))
                page = self.page(scheme=scheme)
                page.goto("/")
                logo = page.get_by_role("img", name="Flux")
                expect(logo.locator("svg.flux-logo")).to_have_count(1)
                # Nothing leaves the tile: the face is drawn inside its 24×24 box.
                box = logo.locator(".flux-logo__face").evaluate("e => { const b = e.getBBox(); return [b.x, b.y, b.x + b.width, b.y + b.height]; }")
                self.assertTrue(all(0 <= value <= 24 for value in box), box)
                shot(page, f"339-logo-sidebar-{scheme}")

    def test_02_agents_are_kreska_with_the_tag_and_people_keep_their_initials(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        agent_card = page.locator(".tb-card", has_text="Calibrate the probes")
        owner = agent_card.locator(".tb-card__owner")
        expect(owner.locator(":scope > .kreska")).to_have_count(1)
        expect(owner.locator(".agent-tag")).to_have_text("Agent")
        expect(owner.locator(".agent-for")).to_have_text("for Ada Kreska")
        expect(agent_card.locator(".tb-av")).to_have_count(0)
        person_card = page.locator(".tb-card", has_text="Order the enclosures")
        expect(person_card.locator(".tb-av")).to_have_text("AK")
        expect(person_card.locator(".kreska")).to_have_count(0)
        # Outside the Agents section an agent is monochrome: no colour class.
        self.assertEqual(owner.locator(":scope > .kreska").get_attribute("class").strip(), "kreska")
        shot(page, "339-tasks-agent-owner")

    def test_03_integrated_task_owner_is_static_under_reduced_motion(self) -> None:
        self.ensure_account()
        page = self.page(reduced=True)
        page.goto(f"/projects/{self.ids['project']}/tasks")
        face = page.locator(".tb-card .kreska").first
        expect(face).to_be_visible()
        # The frame, both eyes and the brow are drawn, and nothing animates.
        self.assertGreaterEqual(face.locator("path").count(), 3)
        self.assertEqual(page.evaluate("document.getAnimations().filter(a => a.effect?.target?.closest?.('.kreska')).length"), 0)

    def test_03b_native_list_and_phone_metadata_include_scoped_owner(self) -> None:
        self.ensure_account()
        webkit = self.pw.webkit.launch()
        self.addCleanup(webkit.close)
        for engine in (self.browser, webkit):
            for scheme in ("light", "dark"):
                context = engine.new_context(base_url=ORIGIN, storage_state=self.state, viewport=PHONE, is_mobile=True, has_touch=True, color_scheme=scheme, service_workers="block")
                self.addCleanup(context.close)
                page = context.new_page()
                page.goto(f"/projects/{self.ids['project']}/tasks?view=list")
                agent_row = page.locator(".ws-item", has_text="Calibrate the probes")
                expect(agent_row.locator(".agent-for")).to_have_text("for Ada Kreska")
                expect(agent_row.locator(".agent-tag")).to_have_text("Agent")
                expect(agent_row.locator(".ws-av")).to_have_count(0)
                human_row = page.locator(".ws-item", has_text="Order the enclosures")
                expect(human_row.locator(".ws-av")).to_have_text("A")
                expect(human_row.locator(".kreska")).to_have_count(0)
                tag = agent_row.locator(".agent-tag")
                self.assertGreaterEqual(tag.evaluate("e => parseFloat(getComputedStyle(e).fontSize)"), 12.5)
                shot(page, f"339-native-list-{engine.browser_type.name}-phone-{scheme}")
                page.evaluate("document.documentElement.style.fontSize = '32px'")
                self.assertGreaterEqual(tag.evaluate("e => parseFloat(getComputedStyle(e).fontSize)"), 25)
                expect(tag).to_be_visible()
                expect(agent_row.locator(".agent-for")).to_be_visible()
                shot(page, f"339-native-list-{engine.browser_type.name}-phone-{scheme}-text200")

    def test_04_install_icons_and_the_tab_icon_are_the_logo(self) -> None:
        page = self.page(signed_in=False)
        svg = page.request.get(f"{ORIGIN}/icons/icon.svg")
        self.assertEqual(svg.status, 200)
        self.assertIn(TILE, svg.text())
        self.assertIn('fill="#18181B"', svg.text())
        manifest = json.loads(page.request.get(f"{ORIGIN}/manifest.webmanifest").text())
        purposes = {icon["purpose"] for icon in manifest["icons"]}
        self.assertEqual(purposes, {"any", "maskable"})
        for icon in manifest["icons"]:
            response = page.request.get(f"{ORIGIN}{icon['src']}")
            self.assertEqual(response.status, 200, icon)
            self.assertEqual(response.body()[:8], b"\x89PNG\r\n\x1a\n", icon)
        page.goto("/sign-in")
        self.assertEqual(page.locator('link[rel="icon"][type="image/svg+xml"]').get_attribute("href"), "/icons/icon.svg")


if __name__ == "__main__":
    unittest.main()
