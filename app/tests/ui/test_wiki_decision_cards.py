"""Decisions in the Wiki are one live card with a short reason (F-034, #763 E1, founder decision 2026-10-30).

A page holding decision references standing on their own lines shows them as drawn, with the reason under each; a
card opens its decision and leaves the outline and the history to the page's own headings and the edits people made.
"Add to a Wiki page" inserts the card; a later change of the decision shows on the card without a new version; a proposed decision cannot be added.
Runs on Chromium and WebKit (FLUX_UI_BROWSER), at 1440x900 and on a 390x844 touch phone.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, expect, sync_playwright

from app_select import choose, expect_value
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

STAMP = int(time.time() * 1000)
PASSWORD = "decisions are live cards"


class WikiDecisionCards(unittest.TestCase):
    browser: Browser
    state: dict

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=8000)
        ctx = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        page = ctx.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Kowalska")
        page.get_by_label("Email").fill(f"ada.cards+{STAMP}@example.test")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        cls.api = staticmethod(lambda method, path, body=None, headers=None: cls.call(page, method, path, body, headers))
        api = cls.api
        ws = api("POST", "/api/v1/workspaces", {"name": "Garden cards"})
        project = api("POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"})
        pid = cls.project_id = project["id"]

        def decide(title, rationale, supersedes=None, accept=True):
            made = api("POST", f"/api/v1/projects/{pid}/decisions", {"title": title, "rationale": rationale, **({"supersedes": supersedes} if supersedes else {})})
            if accept:
                api("POST", f"/api/v1/decisions/{made['id']}/accept", {"expectedVersion": made["version"]})
            return api("GET", f"/api/v1/decisions/{made['id']}")
        cls.moisture = decide("Measure soil moisture first; frost warnings later", "Moisture is what kills seedlings in June. Frost comes in autumn.")
        cls.gateway = decide("One gateway in the shed", "The shed has power all year. It reaches every bed.")
        cls.resistive = decide("Use resistive probes", "Cheap and easy to buy.")
        cls.capacitive = decide("Use capacitive probes", "They do not corrode in wet soil.", cls.resistive["id"])
        cls.proposal = decide("Add frost warnings", "Night frost killed two beds last May.", accept=False)
        card = lambda decision: f"[{decision['title']}](flux:decision/{decision['id']})"
        body = "\n".join([
            "Six capacitive probes on ESP32 boards send readings over LoRa to one gateway in the shed.", "",
            card(cls.moisture), "",
            "## Parts", "", "| Part | Qty |", "| --- | ---: |", "| Capacitive soil probe v2 | 6 |", "",
            card(cls.gateway), "",
            card(cls.resistive), "",
            "## Range", "", "The far east bed sits 180 m from the shed behind a hedge.", "",
        ])
        sensors = api("POST", f"/api/v1/projects/{pid}/docs", {"title": "How the garden sensors work", "body": body, "state": "published"},
                      {"idempotency-key": str(uuid.uuid4())})
        cls.sensors_id = sensors["id"]
        rules = api("POST", f"/api/v1/projects/{pid}/docs", {"title": "Decisions and why", "body": "The rules we keep.", "state": "published"},
                    {"idempotency-key": str(uuid.uuid4())})
        cls.rules_id = rules["id"]
        cls.state = ctx.storage_state()
        ctx.close()

    @staticmethod
    def call(page, method, path, body=None, headers=None):
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                      headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
        assert response.status < 300, f"{method} {path}: {response.status} {response.text()}"
        return json.loads(response.text() or "{}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, viewport, touch=False, theme="light"):
        options = dict(base_url=ORIGIN, viewport=viewport, storage_state=self.state, color_scheme=theme, locale="en-GB")
        if touch:
            options.update(is_mobile=True, has_touch=True, device_scale_factor=2)
        context = self.browser.new_context(**options, service_workers="block")
        self.addCleanup(context.close)
        context.add_init_script(f"localStorage.setItem('flux.theme', '{theme}')")
        return context.new_page()

    def doc_url(self, doc_id):
        return f"/projects/{self.project_id}/docs/{doc_id}"

    def test_01_the_page_shows_live_cards_with_their_reason(self) -> None:
        page = self.context(DESKTOP)
        page.goto(self.doc_url(self.sensors_id))
        expect(page.get_by_role("heading", level=2, name="How the garden sensors work")).to_be_visible()
        cards = page.locator("a.doc-decision")
        expect(cards).to_have_count(3)
        first = cards.nth(0)
        expect(first).to_contain_text("Decision accepted")
        expect(first).to_contain_text(self.moisture["title"])
        expect(first.locator(".doc-decision__meta")).to_contain_text("Ada Kowalska")
        expect(first.locator(".doc-decision__reason")).to_have_text("Moisture is what kills seedlings in June.")
        expect(cards.nth(1).locator(".doc-decision__reason")).to_have_text("The shed has power all year.")
        expect(cards.nth(2)).to_contain_text("Decision replaced")
        # Prostota's one line: the state, the title and the date with who sit on one row; the reason is the row under it.
        line = first.locator(".doc-decision__t").bounding_box()
        reason = first.locator(".doc-decision__reason").bounding_box()
        assert line and reason
        self.assertGreater(reason["y"], line["y"] + line["height"] - 2, "the reason is under the line")
        # No copied text: no "Decision:" heading, no Source line, no copied second sentence.
        prose = page.locator(".doc-prose")
        expect(prose.get_by_role("heading", name=re.compile("^Decision:"))).to_have_count(0)
        expect(prose).not_to_contain_text("Source:")
        expect(prose).not_to_contain_text("Frost comes in autumn")
        # The outline lists the page's own topics only.
        outline = page.get_by_role("complementary", name="On this page")
        expect(outline.get_by_role("link")).to_have_text(["Parts", "Range"])
        # Cards are not listed again under the page.
        expect(page.get_by_role("region", name=re.compile("^Links in this page"))).to_have_count(0)
        shot(page, "wiki-decision-cards-desktop-1440")
        # The card opens the decision itself.
        first.click()
        panel = page.locator("#details")
        expect(panel).to_contain_text(self.moisture["title"])
        expect(panel).to_contain_text("Frost comes in autumn")

    def test_02_a_changed_decision_rewrites_no_page_and_leaves_history_to_people(self) -> None:
        page = self.context(DESKTOP)
        replacement = self.call(page, "POST", f"/api/v1/projects/{self.project_id}/decisions",
                                {"title": "Measure moisture and frost together", "rationale": "The new probes report both.", "supersedes": self.moisture["id"]})
        self.call(page, "POST", f"/api/v1/decisions/{replacement['id']}/accept", {"expectedVersion": replacement["version"]})
        page.goto(self.doc_url(self.sensors_id))
        expect(page.locator("a.doc-decision").first).to_contain_text("Decision replaced")
        expect(page.get_by_role("complementary", name="On this page").get_by_role("link")).to_have_text(["Parts", "Range"])
        page.goto(f"{self.doc_url(self.sensors_id)}/history")
        versions = page.locator(".doc-versions > li")
        expect(versions).to_have_count(1)
        expect(versions.first).to_contain_text("Started the page")

    def test_03_add_to_docs_inserts_the_card_and_it_follows_the_decision(self) -> None:
        page = self.context(DESKTOP)
        page.goto(f"/projects/{self.project_id}/tasks?open=decision:{self.gateway['id']}")
        panel = page.locator("#details")
        panel.get_by_role("button", name="Add to a Wiki page").click()
        expect(panel).to_contain_text("one card with its reason")
        choose(panel.get_by_label("Wiki page", exact=True), value=self.rules_id)
        expect_value(panel.get_by_label("Wiki page", exact=True), self.rules_id)
        panel.get_by_role("button", name="Add the card").click()
        # The form closes back to the decision with one toast; Open leads to the page (#763 D4).
        expect(page.get_by_text("Added to “Decisions and why”")).to_be_visible()
        page.get_by_role("button", name="Open", exact=True).click()
        expect(page.get_by_role("heading", level=2, name="Decisions and why")).to_be_visible()
        card = page.locator("a.doc-decision")
        expect(card).to_have_count(1)
        expect(card).to_contain_text("Decision accepted")
        expect(card.locator(".doc-decision__reason")).to_have_text("The shed has power all year.")
        doc = self.call(page, "GET", f"/api/v1/docs/{self.rules_id}")
        self.assertEqual(doc["version"], 2)
        self.assertTrue(doc["body"].endswith(f"[One gateway in the shed](flux:decision/{self.gateway['id']})\n"), doc["body"])
        # Another person replaces the decision; the open page's card follows on its own refresh, the page keeps its version.
        replacement = self.call(page, "POST", f"/api/v1/projects/{self.project_id}/decisions",
                                {"title": "Two gateways, shed and greenhouse", "rationale": "The hedge blocks the far bed.", "supersedes": self.gateway["id"]})
        self.call(page, "POST", f"/api/v1/decisions/{replacement['id']}/accept", {"expectedVersion": replacement["version"]})
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(card).to_contain_text("Decision replaced")
        self.assertEqual(self.call(page, "GET", f"/api/v1/docs/{self.rules_id}")["version"], 2)

    def test_04_a_proposed_decision_cannot_be_added(self) -> None:
        page = self.context(DESKTOP)
        page.goto(f"/projects/{self.project_id}/tasks?open=decision:{self.proposal['id']}")
        panel = page.locator("#details")
        button = panel.get_by_role("button", name="Add to a Wiki page")
        expect(button).to_be_disabled()
        hint = panel.get_by_text("Accept it first to add it to the Wiki.")
        expect(hint).to_be_visible()
        expect(button).to_have_attribute("aria-describedby", re.compile(r"^wd-docs-hint-"))
        # The hint is the button's own caption: directly under it, on the same left edge. Both boxes are read in one
        # frame, so the Details panel's entrance motion cannot skew one against the other.
        page.wait_for_function("""() => {
          const hint = document.querySelector('#details [id^="wd-docs-hint-"]');
          const button = hint && document.querySelector(`#details [aria-describedby="${hint.id}"]`);
          if (!hint || !button) return false;
          const b = button.getBoundingClientRect(), h = hint.getBoundingClientRect();
          return Math.abs(b.left - h.left) <= 1 && h.top >= b.bottom - 1 && h.top - b.bottom <= 10;
        }""")
        shot(page, "wiki-decision-cards-proposed-details-1440")

    def test_05_phone_reads_and_opens_the_cards(self) -> None:
        page = self.context(PHONE, touch=True, theme="dark")
        page.goto(self.doc_url(self.sensors_id))
        cards = page.locator("a.doc-decision")
        expect(cards).to_have_count(3)
        expect(cards.first.locator(".doc-decision__reason")).to_be_visible()
        box = cards.first.bounding_box()
        assert box
        self.assertLessEqual(box["x"] + box["width"], PHONE["width"], "the card fits the phone")
        self.assertGreaterEqual(box["height"], 44, "the card is a full touch target")
        shot(page, "wiki-decision-cards-phone-390-dark")
        cards.first.tap()
        expect(page.get_by_text("Frost comes in autumn")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
