"""Browser tests for link cards with the page's own words (#469, F-026 §6).

Runs with the other tests/ui journeys through scripts/check_ui.sh; FLUX_UI_BROWSER selects chromium (default) or webkit.
The Flux server fetches the page behind a link in a message (here the Compose `link-mock`, named public.test) and the card shows
the page's title and its description in three lines, not the address. Negative controls: a page with a title and no
description keeps the address as its third line; links to a private name, loopback and a redirect to a private name are never
requested (the mock sees nothing) and keep the address card; a message without a link has no card. Everything the browser
loads comes from Flux: the page's site is never contacted by the reader.
"""

from __future__ import annotations

import json
import os
import time
import unittest
import urllib.request
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from contrast import MEASURE
from link_mock import DESCRIPTION
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

MOCK = os.environ.get("FLUX_LINK_MOCK_URL", "http://link-mock:8098")
SHOTS = os.environ.get("FLUX_UI_SCREENSHOTS")
PASSWORD = "links need a harbour"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.links+{STAMP}@example.test"), "jonas": ("Jonas Berg", f"jonas.links+{STAMP}@example.test")}
TITLE = "Harbour & Co: the winter ferry timetable"


def mock_hits(prefix: str = "") -> list[dict]:
    with urllib.request.urlopen(f"{MOCK}/__hits", timeout=5) as response:
        return [hit for hit in json.load(response) if hit["path"].startswith(prefix)]


class LinkCards(unittest.TestCase):
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
        expect.set_options(timeout=15000)
        contexts = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def post(who: str, path: str, body: dict) -> dict:
            response = contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        ws = post("ada", "/api/v1/workspaces", {"name": "Ferry desk"})
        post("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        project = post("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Island ferry", "visibility": "workspace"})["id"]
        cls.ids["project"] = project

        def say(key: str, body: str) -> None:
            cls.ids[key] = post("ada", f"/api/v1/projects/{project}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})["messages"][0]["id"]

        say("plain", "Nothing to open here, only words.")
        say("ferry", "Sailings change in November: http://public.test/ferry")
        say("title", "A page with a title only: http://public.test/title-only")
        say("blocked", "Never fetch these: http://link-mock/secret http://127.0.0.1/secret http://localhost/secret")
        say("redirect", "A redirect to a private name: http://public.test/redirect-private")
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "ada", phone: bool = False, dark: bool = False) -> tuple[Page, list[str]]:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who],
                         "color_scheme": "dark" if dark else "light"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        # What the browser asks for: only Flux, ever. The reader never contacts the linked site.
        requested: list[str] = []
        page.on("request", lambda request: requested.append(request.url))
        page.goto(f"/projects/{self.ids['project']}")
        self.addCleanup(lambda: self.assertEqual([url for url in requested if not url.startswith(ORIGIN) and not url.startswith(("data:", "blob:"))], [], "the browser contacts only Flux"))
        return page, requested

    def message(self, page: Page, key: str):
        return page.locator(f"#message-{self.ids[key]}")

    def settled(self, page: Page, requested: list[str], keys: list[str]) -> None:
        """Waits until the page has asked for, and been answered about, the link cards of these messages."""
        for key in keys:
            page.wait_for_function("(id) => performance.getEntriesByType('resource').some((entry) => entry.name.includes(`/messages/${id}/link-previews`) && entry.responseEnd > 0)", arg=self.ids[key], timeout=20000)

    def shot(self, page: Page, name: str) -> None:
        if SHOTS:
            page.evaluate("document.fonts.ready.then(() => true)")
            page.wait_for_timeout(400)
            page.screenshot(path=os.path.join(SHOTS, f"{name}.png"))

    def test_a_the_card_shows_the_pages_title_and_description_not_the_address(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, _ = self.page("ada", phone=phone)
                card = self.message(page, "ferry").locator("a.link-preview")
                expect(card).to_have_attribute("data-page", "described")
                expect(card.locator("strong")).to_have_text(TITLE)
                expect(card.locator(".link-preview__site")).to_have_text("public.test")
                description = card.locator("small")
                expect(description).to_have_text(DESCRIPTION)
                self.assertNotIn("public.test/ferry", description.inner_text(), "not an address echo")
                expect(card).to_have_attribute("href", "http://public.test/ferry")
                expect(card).to_have_attribute("rel", "noopener noreferrer nofollow")
                metrics = description.evaluate("""node => { const style = getComputedStyle(node);
                  return { lines: node.getBoundingClientRect().height / parseFloat(style.lineHeight), clamp: style.getPropertyValue('-webkit-line-clamp'),
                           scroll: node.scrollHeight, client: node.clientHeight }; }""")
                self.assertEqual(metrics["clamp"], "3", metrics)
                self.assertLessEqual(metrics["lines"], 3.05, f"at most three lines: {metrics}")
                if phone:
                    self.assertGreaterEqual(metrics["lines"], 2.9, f"the description fills three lines on a phone: {metrics}")
                    self.assertGreater(metrics["scroll"], metrics["client"], f"the rest is clamped, not shown: {metrics}")
                    self.assertLessEqual(page.locator("body").evaluate("el => el.scrollWidth"), PHONE["width"])
                    self.assertGreaterEqual(card.bounding_box()["height"], 56 - 0.001, "a coarse pointer gets a tall enough card")
                else:
                    self.assertGreaterEqual(metrics["lines"], 2.0, metrics)
                self.shot(page, f"link-card-described-{'390' if phone else '1280'}")

    def test_b_dark_mode_keeps_the_card_readable(self) -> None:
        page, _ = self.page("ada", dark=True)
        card = self.message(page, "ferry").locator("a.link-preview")
        expect(card).to_have_attribute("data-page", "described")
        selector = f"#message-{self.ids['ferry']} a.link-preview small"
        page.wait_for_function("(selector) => { for (let n = document.querySelector(selector); n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) !== 1) return false; return true; }", arg=selector)
        for target in (selector, f"#message-{self.ids['ferry']} a.link-preview strong"):
            value = page.evaluate(MEASURE, {"selector": target})
            self.assertGreaterEqual(value["ratio"], 4.5, (target, value))
        self.shot(page, "link-card-described-dark")

    def test_c_negative_controls_keep_the_address_card(self) -> None:
        page, requested = self.page("ada", phone=True)
        self.settled(page, requested, ["ferry", "title", "blocked", "redirect"])
        # A title and no description: the title is the page's, the third line is still the address.
        titled = self.message(page, "title").locator("a.link-preview")
        expect(titled).to_have_attribute("data-page", "titled")
        expect(titled.locator("strong")).to_have_text("A page with a title and no description")
        expect(titled.locator("small")).to_have_text("public.test/title-only")
        # Addresses the server must not fetch, and a redirect to one: the address card, and the mock saw nothing of /secret.
        blocked = self.message(page, "blocked").locator("a.link-preview")
        expect(blocked).to_have_count(3)
        for index in range(3):
            expect(blocked.nth(index)).to_have_attribute("data-page", "address")
        expect(blocked.nth(0).locator("small")).to_have_text("link-mock/secret")
        redirected = self.message(page, "redirect").locator("a.link-preview")
        expect(redirected).to_have_attribute("data-page", "address")
        expect(redirected.locator("small")).to_have_text("public.test/redirect-private")
        self.assertEqual(mock_hits("/secret"), [], "the private target was never requested")
        self.assertEqual(len(mock_hits("/redirect-private")), 1, "the redirecting page itself was fetched, once")
        # No address, no card.
        expect(self.message(page, "plain").locator(".link-previews")).to_have_count(0)
        self.shot(page, "link-card-address-fallbacks-390")

    def test_d_one_fetch_serves_everyone_and_carries_nothing_of_the_reader(self) -> None:
        page, requested = self.page("jonas")
        expect(self.message(page, "ferry").locator("a.link-preview")).to_have_attribute("data-page", "described")
        page.reload()
        expect(self.message(page, "ferry").locator("a.link-preview")).to_have_attribute("data-page", "described")
        hits = mock_hits("/ferry")
        self.assertEqual(len(hits), 1, "the page was fetched once for every reader and every load")
        self.assertRegex(hits[0]["user-agent"], r"^FluxLinkPreview/1 ")
        for header in ("cookie", "referer", "authorization"):
            self.assertIsNone(hits[0][header], header)
        self.assertTrue(any("/link-previews" in url for url in requested), "the card data came from Flux")

    def test_e_the_route_takes_no_address_from_the_caller(self) -> None:
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states["ada"], service_workers="block")
        self.addCleanup(context.close)
        before = len(mock_hits("/ferry"))
        response = context.request.get(f"/api/v1/projects/{self.ids['project']}/messages/{self.ids['plain']}/link-previews?url=http://public.test/ferry")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json(), {"status": "ready", "cards": []})
        self.assertEqual(len(mock_hits("/ferry")), before)


if __name__ == "__main__":
    unittest.main()
