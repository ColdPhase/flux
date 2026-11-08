"""Browser tests for the API keys of Connect AI (#179, F-020 PROV-1, PROV-2, PROV-4, PROV-5; #854 one daily budget).

Runs with the other tests/ui journeys through scripts/check_ui.sh, whose stack has a throwaway
key-custody secret and an operator allowlist naming only `tests/ui/openai_mock.py`. The owner saves
connections for several providers through the real form and API; the server lists the mock
endpoint's models without a key. No model is called and no key is real: nothing here is a
provider, billing or compatibility pass.
"""

from __future__ import annotations

import json
import re
import os
import time
import unittest
import urllib.request

from playwright.sync_api import Browser, Page, expect, sync_playwright

from app_select import choose, expect_value, labels

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, box, shot, start_forwarder

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
        context = self.browser.new_context(service_workers="block", **options)
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

    def fill_key(self, page: Page, key: str, budget: str = "5.00") -> None:
        page.get_by_label("API key", exact=True).fill(key)
        # The form for a new key comes after the budget of each key already there.
        page.get_by_label("Daily budget (USD)", exact=True).last.fill(budget)

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
        page.goto("/settings/ai-connections")
        expect(page.get_by_role("heading", name="Use an API key")).to_be_visible()
        provider = page.get_by_label("Provider", exact=True)
        expect_value(provider, "")
        options = [text.strip() for text in labels(provider)]
        self.assertEqual(options, ["Choose a provider", *PROVIDERS])
        body = page.locator(".background-settings").inner_text()
        for vendor in ("Claude Platform", "claude-sonnet-5", "pays Anthropic", "sk-ant-"):
            self.assertNotIn(vendor, body, "no vendor is named before the owner chooses one (PROV-2)")
        expect(page.get_by_label("Endpoint base URL")).to_have_count(0)
        # #854: one daily budget is all there is to set; no payer, workspace, allowance or consent checkboxes.
        expect(page.get_by_label("Daily budget (USD)", exact=True)).to_have_value("5.00")
        for gone in ("Provider organization", "Provider workspace", "Per-request local allowance (USD)"):
            expect(page.get_by_label(gone)).to_have_count(0)
        expect(page.get_by_role("checkbox")).to_have_count(0)
        shot(page, "ai-connection-1440-empty")

    def test_03_an_openai_compatible_endpoint_lists_its_models_through_the_server_and_takes_an_owner_price(self) -> None:
        page = self.page()
        page.goto("/settings/ai-connections")
        choose(page.get_by_label("Provider", exact=True), label="OpenAI-compatible endpoint")
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
        self.fill_key(page, KEYS["openai_compatible"])
        shot(page, "ai-connection-1440-compatible-form")
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.get_by_role("status").filter(has_text="Key saved with a daily budget of $5.00.")).to_be_visible()
        expect(page.get_by_role("heading", name="Keys", exact=True)).to_be_visible()
        expect(page.get_by_text("Used for background suggestions", exact=True)).to_be_visible()
        key = page.locator(".background-settings__connection").first
        metadata = key.locator(".background-settings__metadata")
        expect(metadata).to_contain_text("OpenAI-compatible endpoint · llama3.1:8b")
        expect(metadata).to_contain_text(ENDPOINT)
        expect(metadata).to_contain_text("$0.00 input · $0.00 output per 1M tokens · Entered by you")
        expect(key.get_by_test_id("key-usage")).to_have_text("$0.00 of $5 today")
        saved = self.current(page)
        self.assertEqual((saved["provider"], saved["model"], saved["baseUrl"], saved["price"]["source"], saved["dailyBudgetCents"]),
                         ("openai_compatible", "llama3.1:8b", ENDPOINT, "owner", 500))
        for gone in ("payerOrganization", "providerWorkspace", "maxRunsPerDay", "periodBudgetCents", "perRunCents"):
            self.assertNotIn(gone, saved, "one daily budget, nothing else (#854)")
        self.no_key_anywhere(page)
        shot(page, "ai-connection-1440-compatible-saved")

    def test_04_a_table_priced_model_needs_no_price_and_names_its_provider(self) -> None:
        page = self.page()
        page.goto("/settings/ai-connections")
        page.get_by_role("button", name="Add a key").click()
        choose(page.get_by_label("Provider", exact=True), label="Anthropic")
        expect(page.get_by_label("Endpoint base URL")).to_have_count(0)
        expect(page.get_by_role("button", name="Show available models")).to_have_count(0)
        expect(page.get_by_text("Type the model id exactly as the provider names it.")).to_be_visible()
        page.get_by_label("Model", exact=True).fill("claude-sonnet-5")
        expect(page.get_by_test_id("connection-price")).to_contain_text("$2.00 input · $10.00 output per 1M tokens · Flux price table, checked 2026-10-02")
        expect(page.get_by_role("group", name="Price per 1M tokens (USD)")).to_have_count(0)
        page.get_by_label("Name", exact=True).fill("Work Anthropic")
        self.fill_key(page, KEYS["anthropic"], "12.50")
        # PROV-1: a second key is added beside the first; marked, it serves background suggestions.
        page.get_by_label(re.compile("^Use this key for background suggestions")).check()
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.get_by_role("heading", name="Use an API key")).to_have_count(0)
        expect(page.locator(".background-settings__connection")).to_have_count(2)
        work = page.locator(".background-settings__connection").filter(has=page.get_by_role("heading", name="Work Anthropic"))
        expect(work).to_contain_text("Anthropic · claude-sonnet-5")
        expect(work).to_contain_text("Used for background suggestions")
        expect(work.get_by_test_id("key-usage")).to_have_text("$0.00 of $12.50 today")
        current = self.current(page)
        self.assertEqual((current["price"]["source"], current["dailyBudgetCents"]), ("table", 1250))
        self.no_key_anywhere(page)

    def test_04b_the_one_daily_budget_is_changed_in_place_and_bounded(self) -> None:
        page = self.page()
        page.goto("/settings/ai-connections")
        work = page.locator(".background-settings__connection").filter(has=page.get_by_role("heading", name="Work Anthropic"))
        budget = work.get_by_label("Daily budget (USD)", exact=True)
        expect(budget).to_have_value("12.50")
        budget.fill("0.05")
        self.assertTrue(budget.evaluate("input => input.validity.rangeUnderflow"), "the field itself refuses a budget under $0.10")
        work.get_by_role("button", name="Save budget").click()
        self.assertEqual(self.current(page)["dailyBudgetCents"], 1250, "a refused budget changes nothing")
        budget.fill("20")
        work.get_by_role("button", name="Save budget").click()
        expect(page.get_by_role("status").filter(has_text="Work Anthropic: daily budget $20.00.")).to_be_visible()
        expect(work.get_by_test_id("key-usage")).to_have_text("$0.00 of $20 today")
        self.assertEqual(self.current(page)["dailyBudgetCents"], 2000)
        refused = page.request.patch(f"{ORIGIN}/api/v1/background-compute-connections/{self.current(page)['id']}",
                                     data={"dailyBudgetCents": 5}, headers={"origin": ORIGIN})
        self.assertEqual(refused.status, 400, refused.text())

    def test_05_a_private_endpoint_the_operator_has_not_allowed_is_refused_and_the_key_is_cleared(self) -> None:
        page = self.page()
        page.goto("/settings/ai-connections")
        before = self.current(page)
        page.get_by_role("button", name="Add a key").click()
        choose(page.get_by_label("Provider", exact=True), label="OpenAI-compatible endpoint")
        page.get_by_label("Endpoint base URL").fill("http://10.20.30.40:11434/v1")
        page.get_by_role("button", name="Show available models").click()
        expect(page.get_by_role("status").filter(has_text="This endpoint is not allowed on this server")).to_be_visible()
        page.get_by_label("Model", exact=True).fill("llama3.1:8b")
        page.get_by_label("Input price").fill("0")
        page.get_by_label("Output price").fill("0")
        self.fill_key(page, KEYS["openai_compatible"])
        page.get_by_role("button", name="Connect", exact=True).click()
        alert = page.get_by_role("alert")
        expect(alert).to_contain_text("This endpoint cannot be used")
        expect(page.get_by_label("API key", exact=True)).to_have_value("")
        self.assertEqual(self.current(page), before, "a refused key changes nothing")
        self.no_key_anywhere(page)
        shot(page, "ai-connection-1440-endpoint-refused")

    def test_06_the_form_fits_a_phone_and_the_price_fields_are_touch_sized(self) -> None:
        page = self.page(phone=True)
        page.goto("/settings/ai-connections")
        page.get_by_role("button", name="Add a key").tap()
        choose(page.get_by_label("Provider", exact=True), label="OpenRouter")
        page.get_by_label("Model", exact=True).fill("vendor/model-without-a-listing")
        expect(page.get_by_role("group", name="Price per 1M tokens (USD)")).to_be_visible()
        for label in ("Provider", "Model", "Input price", "Output price", "Daily budget (USD)"):
            box = page.get_by_label(label, exact=True).last.bounding_box()
            self.assertIsNotNone(box)
            self.assertGreaterEqual(box["height"], 44, label)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))
        shot(page, "ai-connection-390-openrouter")

    def test_07_connect_guide_and_details_treat_every_client_and_provider_alike(self) -> None:
        page = self.page()
        page.goto("/connect-agent")
        # #763 AG-2: managing connections is a Settings page; the way back is first, on the left.
        expect(page).to_have_url(re.compile(r"/settings/agents/connect$"))
        back = page.locator(".connection-settings__back")
        expect(back).to_have_text("AI")
        expect(back).to_have_attribute("href", "/settings/agents")
        guide = page.locator(".connection__guide")
        expect(guide.get_by_role("heading", name="Connect your MCP client")).to_be_visible()
        self.assertLess(back.bounding_box()["x"], guide.bounding_box()["x"] + 1, "the way back starts at the content's left edge")
        # One client at a time (#763 AG-2): a tab each, with its own commands.
        tabs = guide.get_by_role("tablist", name="Your client")
        for client in ("Claude Code", "Codex", "Other client"):
            expect(tabs.get_by_role("tab", name=client, exact=True)).to_be_visible()
        expect(guide).to_contain_text(f"claude mcp add --transport http flux {ORIGIN}/mcp")
        expect(guide).to_contain_text("claude mcp login flux")
        expect(guide).to_contain_text("/mcp__flux__start_work")
        expect(guide).not_to_contain_text("codex mcp add")
        tabs.get_by_role("tab", name="Codex", exact=True).click()
        expect(guide).to_contain_text(f"codex mcp add flux --url {ORIGIN}/mcp")
        expect(guide).to_contain_text("codex mcp login flux")
        expect(guide).to_contain_text("Unsupported protocol version")
        expect(guide).not_to_contain_text("claude mcp add")
        tabs.get_by_role("tab", name="Other client", exact=True).click()
        expect(guide).to_contain_text("Start it from your client")
        # #763 AG-3: no release-verification notes or tested-version claims on the page.
        body = page.locator("body").inner_text()
        for internal in ("Verified with a real", "is tested with", "pending native", "Flux checkout"):
            self.assertNotIn(internal, body)
        # #320: the quick start's loopback http:// address is the one to use; HTTPS is needed only
        # for a client on another computer, so the guide must not ask for it here.
        self.assertRegex(ORIGIN, r"^http://(127\.\d+\.\d+\.\d+|localhost)(:\d+)?$", "this suite runs on a loopback http origin")
        expect(guide).to_contain_text("Add this Flux address to the client you already use.")
        expect(guide).to_contain_text("This address works only on this computer.")
        expect(guide).not_to_contain_text("Use your self-hosted Flux HTTPS address")
        expect(guide).to_contain_text("only as far as its “What it may do” allows")
        tabs.get_by_role("tab", name="Claude Code", exact=True).click()
        shot(page, "ai-connection-1440-connect-guide")
        tabs.get_by_role("tab", name="Codex", exact=True).click()
        shot(page, "ai-connection-1440-connect-guide-codex")
        page.set_viewport_size({"width": 390, "height": 844})
        guide.scroll_into_view_if_needed()
        shot(page, "ai-connection-390-connect-guide-codex")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))
        page.set_viewport_size({"width": 1440, "height": 900})
        page.goto("/settings/assistant")
        expect(page.get_by_role("heading", level=1, name="Your assistant")).to_be_visible()
        self.assertNotIn("Anthropic API key", page.locator("body").inner_text())

    def test_08_the_assistant_names_exactly_the_connection_chosen(self) -> None:
        """#854: with several keys, the model picker groups the models by key and the request names the key and the model
        chosen, never the server's default. The UI suite runs personal runs on a TEST-ONLY fixture key, so the model choice is
        stubbed from Ada's two saved keys and the enable request is answered with a refusal."""
        page = self.page()
        headers = {"origin": ORIGIN}
        ws = page.request.post(f"{ORIGIN}/api/v1/workspaces", data={"name": "Sensor lab"}, headers=headers)
        self.assertEqual(ws.status, 201, ws.text())
        agent = page.request.post(f"{ORIGIN}/api/v1/workspaces/{ws.json()['id']}/agents", data={"name": "Ada's assistant", "owner": "self"}, headers=headers)
        self.assertEqual(agent.status, 201, agent.text())
        owned = page.request.get(f"{ORIGIN}/api/v1/background-compute-connections").json()
        self.assertEqual(len(owned), 2, "the endpoint and the Anthropic key from the earlier tests")
        groups = [{"connection": item["id"], "account": "api_key", "label": item["name"], "company": "Anthropic",
                   "options": [{"id": item["model"], "name": item["model"], "note": "", "callsTools": True}]} for item in owned]
        choice = {"current": None, "default": {"connection": owned[-1]["id"], "model": owned[-1]["model"]}, "groups": groups, "saved": False}
        sent: list[dict] = []

        def fulfil(route) -> None:
            if route.request.method == "POST":
                sent.append(json.loads(route.request.post_data or "{}"))
                route.fulfill(status=409, content_type="application/json", body=json.dumps({"code": "PERSONAL_RUN_CONNECTION_REQUIRED", "message": "Stubbed refusal"}))
            else:
                route.continue_()

        page.route("**/api/v1/personal-assistant", fulfil)
        page.route("**/api/v1/personal-assistant/model", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(choice))
                   if route.request.method == "GET" else route.continue_())
        page.goto("/settings/assistant")
        model = page.get_by_role("button", name=re.compile(r"^Model: .+\. Change$"))
        expect(model).to_have_accessible_name(f"Model: {owned[-1]['model']} · {owned[-1]['name']}. Change")
        model.click()
        menu = page.get_by_role("menu", name="Model")
        for item in owned:
            expect(menu.get_by_role("group", name=item["name"])).to_be_visible()
        chosen = owned[0]
        menu.get_by_role("group", name=chosen["name"]).get_by_role("menuitemradio").click()
        expect(model).to_have_accessible_name(f"Model: {chosen['model']} · {chosen['name']}. Change")
        shot(page, "ai-connections-1440-assistant-model-chosen")
        page.get_by_role("button", name="Turn on", exact=True).click()
        expect(page.get_by_role("alert")).to_be_visible()
        self.assertEqual(len(sent), 1)
        self.assertEqual((sent[0].get("connection"), sent[0].get("model")), (chosen["id"], chosen["model"]), "the request names the key chosen")

    def test_09_every_entry_point_opens_the_one_api_keys_page(self) -> None:
        """#513 B2, #854: Connect AI's "API key" choice and each key's Change lead to one API keys page, titled as such, with
        the keys and the form; nothing there claims a key enables nothing."""
        page = self.page()
        page.goto("/settings/agents")
        connect = page.get_by_role("region", name=re.compile("^Connect AI"))
        rows = connect.locator("li[data-connection=api_key]")
        expect(rows).to_have_count(2)
        work = rows.filter(has_text="Work Anthropic")
        expect(work).to_contain_text("$0.00 of $20 today")
        change = work.get_by_role("link", name="Change Work Anthropic")
        expect(change).to_have_attribute("href", re.compile(r"^/settings/ai-connections\?key=[0-9a-f-]{36}$"))
        change.click()
        expect(page).to_have_url(re.compile(r"/settings/ai-connections\?key="))
        expect(page.locator("header.top").get_by_role("heading", level=1, name="Your API keys", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", level=2, name="Your API keys", exact=True)).to_be_visible()
        # On the phone the header alone names the page (#513: one title).
        phone = self.page(phone=True)
        phone.goto("/settings/ai-connections")
        expect(phone.locator(".app__main header").get_by_role("heading", level=1, name="Your API keys", exact=True)).to_be_visible()
        expect(phone.get_by_role("button", name="Add a key", exact=True)).to_be_visible()
        expect(phone.get_by_role("heading", name="Your API keys", exact=True)).to_have_count(1)
        shot(phone, "ai-connections-390-page")
        expect(page.get_by_role("navigation", name="Settings sections").get_by_role("link", name="AI", exact=True)).to_have_attribute("aria-current", "page")
        expect(page.locator(".background-settings__connection")).to_have_count(2)
        expect(page.get_by_role("heading", name=re.compile("background suggestions", re.I))).to_have_count(0)
        self.assertNotIn("enables nothing", page.locator(".background-settings").inner_text())
        expect(page.get_by_role("link", name="Back to AI")).to_have_attribute("href", "/settings/agents")
        shot(page, "ai-connections-1440-page")
        # ?new=1 opens the form at once.
        page.goto("/settings/ai-connections?new=1")
        expect(page.get_by_role("heading", name="Use an API key")).to_be_visible()

    @staticmethod
    def runtime_answer(status: str):
        """A route handler that answers the background runtime read with the given status."""
        body = json.dumps({"status": status})
        return lambda route: route.fulfill(status=200, content_type="application/json", body=body)

    def test_10_background_keeps_usage_and_rules_under_one_status_line_and_no_control_moves(self) -> None:
        """#513 B1, B2 and Spokój rule 7: with background suggestions off (this server) and on (a stubbed runtime),
        Background suggestions shows one status line with API keys beside it, then usage and project rules, in
        the same places; it has no key form. API keys looks the same in both states."""
        positions: dict[str, dict] = {}
        for runtime in ("unavailable", "available"):
            for phone in (False, True):
                page = self.page(phone=phone)
                page.route("**/api/v1/background-comparisons/runtime", self.runtime_answer(runtime))
                page.goto("/settings/background-compute")
                note = page.get_by_role("note")
                expect(note).to_have_text("Off on this Flux server · not available until your admin turns it on" if runtime == "unavailable"
                                          else "On · uses Work Anthropic and counts against its daily budget")
                link = page.locator(".background-settings__status").get_by_role("link", name="API keys", exact=True)
                expect(link).to_have_attribute("href", "/settings/ai-connections")
                usage = page.get_by_role("heading", name="Your local usage", exact=True)
                rules = page.get_by_role("heading", name="Rules for your projects", exact=True)
                expect(usage).to_be_visible()
                expect(rules).to_be_visible()
                expect(page.get_by_label("Project", exact=True)).to_be_enabled()
                expect(page.get_by_role("button", name="View recent requests", exact=True)).to_be_visible()
                page.wait_for_function("document.getAnimations().every((a) => a.playState !== 'running')")
                self.assertTrue(box(page, note)["y"] < box(page, usage)["y"] < box(page, rules)["y"], "the status line first, then usage and rules")
                # The connections and their form are on AI connections only.
                expect(page.get_by_label("API key", exact=True)).to_have_count(0)
                expect(page.get_by_role("button", name=re.compile("^Disconnect"))).to_have_count(0)
                if phone:
                    self.assertGreaterEqual(box(page, link)["height"], 44, "API keys is a 44 px target on touch")
                    self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
                status = page.locator(".background-settings__status")
                spots = {name: (round(b["x"]), round(b["y"]), round(b["width"]), round(b["height"])) for name, b in
                         (("status", box(page, status)), ("link", box(page, link)), ("usage", box(page, usage)), ("rules", box(page, rules)))}
                spots["note-x"] = round(box(page, note)["x"])
                shot(page, f"background-{'390' if phone else '1440'}-{runtime}")
                page.goto("/settings/ai-connections")
                add = page.get_by_role("button", name="Add a key", exact=True)
                expect(add).to_be_visible()
                page.wait_for_function("document.getAnimations().every((a) => a.playState !== 'running')")
                added = box(page, add)
                spots["add"] = (round(added["x"]), round(added["y"]), round(added["width"]), round(added["height"]))
                positions[f"{runtime}-{'phone' if phone else 'computer'}"] = spots
        for device in ("computer", "phone"):
            self.assertEqual(positions[f"unavailable-{device}"], positions[f"available-{device}"],
                             f"{device}: the status line, API keys, usage, rules and Add a key keep their places")

    def test_10b_the_connect_ai_window_adds_a_key_and_refuses_a_budget_below_one_request(self) -> None:
        """#854: the key form is a step of the one window, and a budget that could never cover one request is refused when saved."""
        page = self.page()
        page.goto("/settings/agents")
        connect = page.get_by_role("region", name="Connect AI", exact=True)
        connect.get_by_role("button", name="Connect another").click()
        window = page.get_by_role("dialog", name="Connect your AI")
        expect(window.locator("[data-choice=api_key] input")).to_be_checked()
        window.get_by_role("button", name="Continue").click()
        choose(window.get_by_label("Provider", exact=True), label="Anthropic")
        window.get_by_label("Model", exact=True).fill("claude-sonnet-5")
        window.get_by_label("Name", exact=True).fill("From the window")
        window.get_by_label("API key", exact=True).fill(KEYS["anthropic"])
        window.get_by_label("Daily budget (USD)", exact=True).fill("0.10")
        window.get_by_role("button", name="Connect", exact=True).click()
        expect(window.get_by_role("alert")).to_contain_text("can cost up to $0.17, so the daily budget must be at least that")
        window.get_by_label("API key", exact=True).fill(KEYS["anthropic"])
        window.get_by_label("Daily budget (USD)", exact=True).fill("5")
        window.get_by_role("button", name="Connect", exact=True).click()
        expect(window).to_have_count(0)
        expect(connect.locator("li[data-connection=api_key]").filter(has_text="From the window")).to_be_visible()
        expect(page).to_have_url(re.compile(r"/settings/agents$"))
        self.no_key_anywhere(page)
        key = next(item for item in json.loads(page.request.get(f"{ORIGIN}/api/v1/background-compute-connections").text()) if item["name"] == "From the window")
        self.assertEqual(page.request.delete(f"{ORIGIN}/api/v1/background-compute-connections/{key['id']}", headers={"origin": ORIGIN}).status, 204)

    def test_11_a_codex_host_action_speaks_to_the_person(self) -> None:
        """#635/#160, #763 AG-3: the Codex Start/Resume host action gives its commands in plain words, without the release
        verification notes (those stay in docs/development/evidence/160-workflow/README.md). The connection is created through the API."""
        page = self.page()
        headers = {"origin": ORIGIN, "content-type": "application/json"}

        def post(path: str, body: dict) -> dict:
            response = page.request.post(f"{ORIGIN}{path}", data=body, headers=headers)
            self.assertEqual(response.status, 201, response.text())
            return response.json()

        ws = post("/api/v1/workspaces", {"name": "Codex label studio"})
        project = post(f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Codex label", "visibility": "workspace"})
        agent = post(f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Ada's Codex", "owner": "self"})
        post("/api/v1/integration/agent-connections", {"agentId": agent["id"], "name": "Ada Codex laptop", "clientDesignation": "codex"})
        # The Start/Resume commands sit on the project's Agents view, with the connection's row (the settings page lists clients, nothing more).
        page.goto(f"/projects/{project['id']}/agents")
        page.locator(f"[data-agent='{agent['id']}'] .agents-row__btn").click()
        host = page.locator(".cowork-host-actions")
        expect(host).to_have_count(1)
        expect(host.locator("summary")).to_have_text("Start / Resume in Codex")
        host.locator("summary").click()
        expect(host).to_contain_text("./flux cowork start --client codex")
        expect(host).to_contain_text("in the folder where Flux was installed")
        # #763 AG-3: words for the person, not release QA notes.
        for internal in ("Verified with a real", "Flux checkout", "built Docker image", "0.160.1"):
            expect(host).not_to_contain_text(internal)
        shot(page, "ai-connection-1440-codex-host-verified")


if __name__ == "__main__":
    unittest.main()
