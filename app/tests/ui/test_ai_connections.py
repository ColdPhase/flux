"""Browser tests for provider-neutral AI connection settings (#179, F-020 PROV-1, PROV-2, PROV-4, PROV-5).

Runs with the other tests/ui journeys through scripts/check_ui.sh, whose stack has a throwaway
key-custody secret and an operator allowlist naming only `tests/ui/openai_mock.py`. The owner saves
connections for several providers through the real form and API; the server lists the mock
endpoint's models without a key. No model is called and no key is real: nothing here is a
provider, billing or compatibility pass.
"""

from __future__ import annotations

import json
import os
import time
import unittest
import urllib.request

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

MOCK = os.environ.get("FLUX_OPENAI_MOCK_URL", "http://127.0.0.1:8091")
ENDPOINT = "http://openai-mock:8091/v1"
PASSWORD = "a provider of my own choosing"
STAMP = int(time.time() * 1000)
OWNER = {"name": "Ada Nowak", "email": f"ada.nowak+{STAMP}@example.test"}
KEYS = {
    "openai_compatible": f"local-{'owner-budget-key-' * 3}UI01",
    "anthropic": f"sk-ant-api03-{'owner-budget-key-' * 3}UI02",
    "openrouter": f"sk-or-v1-{'owner-budget-key-' * 3}UI03",
}
PROVIDERS = ["Anthropic", "OpenAI", "OpenRouter", "Google Gemini", "OpenAI-compatible endpoint"]


def mock_requests() -> list[dict]:
    with urllib.request.urlopen(f"{MOCK}/__requests", timeout=5) as response:
        return json.loads(response.read())["requests"]


class AiConnectionSettings(unittest.TestCase):
    """Tests run in name order and share one owner."""

    pw = None
    browser: Browser
    state: dict | None = None

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def current(self, page: Page) -> dict | None:
        response = page.request.get(f"{ORIGIN}/api/v1/background-compute-connections/current")
        self.assertEqual(response.status, 200)
        return json.loads(response.text())

    def fill_consent(self, page: Page, key: str) -> None:
        page.get_by_label("Background API key", exact=True).fill(key)
        page.get_by_label("Provider organization", exact=True).fill("Ada's lab")
        page.get_by_label("Provider workspace", exact=True).fill("Sensors")
        page.get_by_label("Per-request local allowance (USD)").fill("0.20")
        for check in page.locator(".background-settings__check input").all():
            check.check()

    def no_key_anywhere(self, page: Page) -> None:
        html = page.content()
        storage = page.evaluate("JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })")
        for key in KEYS.values():
            self.assertNotIn(key, html)
            self.assertNotIn(key, storage)

    def test_01_owner_signs_up(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(OWNER["name"])
        page.get_by_label("Email").fill(OWNER["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()

    def test_02_every_provider_is_offered_the_same_way_and_none_is_preselected(self) -> None:
        page = self.page()
        page.goto("/settings/background-compute")
        expect(page.get_by_role("heading", name="Connect your background source")).to_be_visible()
        provider = page.get_by_label("Provider", exact=True)
        expect(provider).to_have_value("")
        options = [text.strip() for text in provider.locator("option").all_inner_texts()]
        self.assertEqual(options, ["Choose a provider", *PROVIDERS])
        body = page.locator(".background-settings").inner_text()
        for vendor in ("Claude Platform", "claude-sonnet-5", "pays Anthropic", "sk-ant-"):
            self.assertNotIn(vendor, body, "no vendor is named before the owner chooses one (PROV-2)")
        expect(page.get_by_label("Endpoint base URL")).to_have_count(0)
        shot(page, "ai-connection-1440-empty")

    def test_03_an_openai_compatible_endpoint_lists_its_models_through_the_server_and_takes_an_owner_price(self) -> None:
        page = self.page()
        page.goto("/settings/background-compute")
        page.get_by_label("Provider", exact=True).select_option(label="OpenAI-compatible endpoint")
        expect(page.locator("#background-key-help")).to_contain_text("If it needs none, enter any placeholder")
        page.get_by_label("Endpoint base URL").fill(ENDPOINT)
        page.get_by_role("button", name="Show available models").click()
        expect(page.get_by_role("status").filter(has_text="2 models from OpenAI-compatible endpoint")).to_be_visible()
        options = page.locator("datalist option")
        self.assertEqual([options.nth(i).get_attribute("value") for i in range(options.count())], ["llama3.1:8b", "qwen2.5:7b-instruct"])
        self.assertEqual([item["authorization"] for item in mock_requests() if item["path"] == "/v1/models"], [None],
                         "the server lists models without any key")
        page.get_by_label("Model", exact=True).fill("llama3.1:8b")
        expect(page.get_by_role("group", name="Price per 1M tokens (USD)")).to_be_visible()
        page.get_by_label("Input price").fill("0")
        page.get_by_label("Output price").fill("0")
        self.fill_consent(page, KEYS["openai_compatible"])
        shot(page, "ai-connection-1440-compatible-form")
        page.get_by_role("button", name="Save connection and consent").click()
        expect(page.get_by_role("heading", name="Your saved connection")).to_be_visible()
        metadata = page.locator('[aria-labelledby="background-current"] .background-settings__metadata')
        expect(metadata).to_contain_text("OpenAI-compatible endpoint · llama3.1:8b")
        expect(metadata).to_contain_text(ENDPOINT)
        expect(metadata).to_contain_text("$0.00 input · $0.00 output per 1M tokens · Entered by you")
        expect(page.locator("[aria-labelledby=background-current]")).to_contain_text("pays the endpoint’s operator")
        saved = self.current(page)
        self.assertEqual((saved["provider"], saved["model"], saved["baseUrl"], saved["price"]["source"]),
                         ("openai_compatible", "llama3.1:8b", ENDPOINT, "owner"))
        self.no_key_anywhere(page)
        shot(page, "ai-connection-1440-compatible-saved")

    def test_04_a_table_priced_model_needs_no_price_and_names_its_provider(self) -> None:
        page = self.page()
        page.goto("/settings/background-compute")
        page.get_by_role("button", name="Replace connection").click()
        page.get_by_label("Provider", exact=True).select_option(label="Anthropic")
        expect(page.get_by_label("Endpoint base URL")).to_have_count(0)
        expect(page.get_by_role("button", name="Show available models")).to_have_count(0)
        expect(page.get_by_text("Type the model id exactly as the provider names it.")).to_be_visible()
        page.get_by_label("Model", exact=True).fill("claude-sonnet-5")
        expect(page.get_by_test_id("connection-price")).to_contain_text("$2.00 input · $10.00 output per 1M tokens · Flux price table, checked 2026-10-02")
        expect(page.get_by_role("group", name="Price per 1M tokens (USD)")).to_have_count(0)
        self.fill_consent(page, KEYS["anthropic"])
        page.get_by_role("button", name="Replace and save consent").click()
        expect(page.get_by_role("heading", name="Replace your connection")).to_have_count(0)
        metadata = page.locator('[aria-labelledby="background-current"] .background-settings__metadata')
        expect(metadata).to_contain_text("Anthropic · claude-sonnet-5")
        expect(metadata).to_contain_text("One request reserves up to $0.05")
        expect(page.locator("[aria-labelledby=background-current]")).to_contain_text("pays Anthropic")
        self.assertEqual(self.current(page)["price"]["source"], "table")
        self.no_key_anywhere(page)

    def test_05_a_private_endpoint_the_operator_has_not_allowed_is_refused_and_the_key_is_cleared(self) -> None:
        page = self.page()
        page.goto("/settings/background-compute")
        before = self.current(page)
        page.get_by_role("button", name="Replace connection").click()
        page.get_by_label("Provider", exact=True).select_option(label="OpenAI-compatible endpoint")
        page.get_by_label("Endpoint base URL").fill("http://10.20.30.40:11434/v1")
        page.get_by_role("button", name="Show available models").click()
        expect(page.get_by_role("status").filter(has_text="This endpoint is not allowed on this server")).to_be_visible()
        page.get_by_label("Model", exact=True).fill("llama3.1:8b")
        page.get_by_label("Input price").fill("0")
        page.get_by_label("Output price").fill("0")
        self.fill_consent(page, KEYS["openai_compatible"])
        page.get_by_role("button", name="Replace and save consent").click()
        alert = page.get_by_role("alert")
        expect(alert).to_contain_text("This endpoint cannot be used")
        expect(page.get_by_label("Background API key", exact=True)).to_have_value("")
        self.assertEqual(self.current(page), before, "the refused replacement keeps the earlier connection")
        self.no_key_anywhere(page)
        shot(page, "ai-connection-1440-endpoint-refused")

    def test_06_the_form_fits_a_phone_and_the_price_fields_are_touch_sized(self) -> None:
        page = self.page(phone=True)
        page.goto("/settings/background-compute")
        page.get_by_role("button", name="Replace connection").tap()
        page.get_by_label("Provider", exact=True).select_option(label="OpenRouter")
        page.get_by_label("Model", exact=True).fill("vendor/model-without-a-listing")
        expect(page.get_by_role("group", name="Price per 1M tokens (USD)")).to_be_visible()
        for label in ("Provider", "Model", "Input price", "Output price"):
            box = page.get_by_label(label, exact=True).bounding_box()
            self.assertIsNotNone(box)
            self.assertGreaterEqual(box["height"], 44, label)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))
        shot(page, "ai-connection-390-openrouter")

    def test_07_connect_guide_and_details_treat_every_client_and_provider_alike(self) -> None:
        page = self.page()
        page.goto("/connect-agent")
        guide = page.locator(".connection__guide")
        expect(guide.get_by_role("heading", name="Connect your MCP client")).to_be_visible()
        for client in ("Claude Code", "Codex", "Another MCP client"):
            expect(guide.get_by_role("heading", name=client, exact=True)).to_be_visible()
        expect(guide).to_contain_text(f"claude mcp add --transport http flux {ORIGIN}/mcp")
        expect(guide).to_contain_text(f"codex mcp add flux --url {ORIGIN}/mcp")
        expect(guide).to_contain_text("codex mcp login flux")
        shot(page, "ai-connection-1440-connect-guide")
        page.goto("/settings/assistant")
        expect(page.get_by_role("heading", level=1, name="Your assistant")).to_be_visible()
        self.assertNotIn("Anthropic API key", page.locator("body").inner_text())


if __name__ == "__main__":
    unittest.main()
