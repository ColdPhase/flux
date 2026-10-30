"""Browser tests for provider-neutral AI connection settings (#179, F-020 PROV-1, PROV-2, PROV-4, PROV-5).

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

    def fill_consent(self, page: Page, key: str) -> None:
        page.get_by_label("API key", exact=True).fill(key)
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
        page.goto("/settings/ai-connections")
        expect(page.get_by_role("heading", name="Add an AI connection")).to_be_visible()
        provider = page.get_by_label("Provider", exact=True)
        expect_value(provider, "")
        options = [text.strip() for text in labels(provider)]
        self.assertEqual(options, ["Choose a provider", *PROVIDERS])
        body = page.locator(".background-settings").inner_text()
        for vendor in ("Claude Platform", "claude-sonnet-5", "pays Anthropic", "sk-ant-"):
            self.assertNotIn(vendor, body, "no vendor is named before the owner chooses one (PROV-2)")
        expect(page.get_by_label("Endpoint base URL")).to_have_count(0)
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
        self.fill_consent(page, KEYS["openai_compatible"])
        shot(page, "ai-connection-1440-compatible-form")
        page.get_by_role("button", name="Save connection and consent").click()
        expect(page.get_by_role("heading", name="Your AI connections")).to_be_visible()
        expect(page.get_by_text("Used for background suggestions", exact=True)).to_be_visible()
        metadata = page.locator('[aria-labelledby="background-current"] .background-settings__metadata').first
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
        page.goto("/settings/ai-connections")
        page.get_by_role("button", name="Add a connection").click()
        page.get_by_label("Connection name").fill("Work Anthropic")
        choose(page.get_by_label("Provider", exact=True), label="Anthropic")
        expect(page.get_by_label("Endpoint base URL")).to_have_count(0)
        expect(page.get_by_role("button", name="Show available models")).to_have_count(0)
        expect(page.get_by_text("Type the model id exactly as the provider names it.")).to_be_visible()
        page.get_by_label("Model", exact=True).fill("claude-sonnet-5")
        expect(page.get_by_test_id("connection-price")).to_contain_text("$2.00 input · $10.00 output per 1M tokens · Flux price table, checked 2026-10-02")
        expect(page.get_by_role("group", name="Price per 1M tokens (USD)")).to_have_count(0)
        self.fill_consent(page, KEYS["anthropic"])
        # PROV-1: a second connection is added beside the first; marked, it serves background suggestions.
        page.get_by_label(re.compile("^Use this connection for background suggestions")).check()
        page.get_by_role("button", name="Save connection and consent").click()
        expect(page.get_by_role("heading", name="Add a connection")).to_have_count(0)
        expect(page.locator(".background-settings__connection")).to_have_count(2)
        expect(page.locator(".background-settings__connection").first.get_by_role("heading", name="Work Anthropic")).to_be_visible()
        metadata = page.locator('[aria-labelledby="background-current"] .background-settings__metadata').first
        expect(metadata).to_contain_text("Anthropic · claude-sonnet-5")
        expect(metadata).to_contain_text("One request reserves up to $0.05")
        expect(page.locator(".background-settings__connection").first).to_contain_text("pays Anthropic")
        self.assertEqual(self.current(page)["price"]["source"], "table")
        self.no_key_anywhere(page)

    def test_05_a_private_endpoint_the_operator_has_not_allowed_is_refused_and_the_key_is_cleared(self) -> None:
        page = self.page()
        page.goto("/settings/ai-connections")
        before = self.current(page)
        page.get_by_role("button", name="Add a connection").click()
        choose(page.get_by_label("Provider", exact=True), label="OpenAI-compatible endpoint")
        page.get_by_label("Endpoint base URL").fill("http://10.20.30.40:11434/v1")
        page.get_by_role("button", name="Show available models").click()
        expect(page.get_by_role("status").filter(has_text="This endpoint is not allowed on this server")).to_be_visible()
        page.get_by_label("Model", exact=True).fill("llama3.1:8b")
        page.get_by_label("Input price").fill("0")
        page.get_by_label("Output price").fill("0")
        self.fill_consent(page, KEYS["openai_compatible"])
        page.get_by_role("button", name="Save connection and consent").click()
        alert = page.get_by_role("alert")
        expect(alert).to_contain_text("This endpoint cannot be used")
        expect(page.get_by_label("API key", exact=True)).to_have_value("")
        self.assertEqual(self.current(page), before, "a refused connection changes nothing")
        self.no_key_anywhere(page)
        shot(page, "ai-connection-1440-endpoint-refused")

    def test_06_the_form_fits_a_phone_and_the_price_fields_are_touch_sized(self) -> None:
        page = self.page(phone=True)
        page.goto("/settings/ai-connections")
        page.get_by_role("button", name="Add a connection").tap()
        choose(page.get_by_label("Provider", exact=True), label="OpenRouter")
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
        # #160 AC-2 / #460: Codex starts from Flux's playbook; the guide says how, and which Codex versions are tested.
        expect(guide).not_to_contain_text("Start and Resume are pending")
        expect(guide).to_contain_text("use its supplied Start/Resume command")
        expect(guide).to_contain_text("Codex 0.160.1")
        expect(guide).to_contain_text("Unsupported protocol version")
        expect(guide).to_contain_text("/mcp__flux__start_work")
        expect(guide).to_contain_text("Verified with a real Claude Code 2.1.285 account on 30 October 2026")
        # #320: the quick start's loopback http:// address is the one to use; HTTPS is needed only
        # for a client on another computer, so the guide must not ask for it here.
        self.assertRegex(ORIGIN, r"^http://(127\.\d+\.\d+\.\d+|localhost)(:\d+)?$", "this suite runs on a loopback http origin")
        expect(guide).to_contain_text("Add this Flux address to the client you already use.")
        expect(guide).to_contain_text("This address works only on this computer.")
        expect(guide).not_to_contain_text("Use your self-hosted Flux HTTPS address")
        expect(guide).to_contain_text("run only the actions you grant")
        shot(page, "ai-connection-1440-connect-guide")
        guide.get_by_role("heading", name="Start work").scroll_into_view_if_needed()
        shot(page, "ai-connection-1440-connect-guide-codex")
        page.set_viewport_size({"width": 390, "height": 844})
        guide.get_by_role("heading", name="Codex", exact=True).scroll_into_view_if_needed()
        shot(page, "ai-connection-390-connect-guide-codex")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))
        page.set_viewport_size({"width": 1440, "height": 900})
        page.goto("/settings/assistant")
        expect(page.get_by_role("heading", level=1, name="Your assistant")).to_be_visible()
        self.assertNotIn("Anthropic API key", page.locator("body").inner_text())

    def test_08_the_assistant_consent_names_exactly_the_connection_chosen(self) -> None:
        """#192 review B2: with several connections, the disclosure, the consent sentence and the request all
        follow the connection selected, never the server's default. The UI suite runs personal runs on a test
        fixture, so the status is stubbed as "ready to enable" and the enable request is answered with a refusal."""
        page = self.page()
        headers = {"origin": ORIGIN}
        ws = page.request.post(f"{ORIGIN}/api/v1/workspaces", data={"name": "Sensor lab"}, headers=headers)
        self.assertEqual(ws.status, 201, ws.text())
        agent = page.request.post(f"{ORIGIN}/api/v1/workspaces/{ws.json()['id']}/agents", data={"name": "Ada's assistant", "owner": "self"}, headers=headers)
        self.assertEqual(agent.status, 201, agent.text())
        owned = page.request.get(f"{ORIGIN}/api/v1/background-compute-connections").json()
        self.assertEqual(len(owned), 2, "the endpoint and the Anthropic connection from the earlier tests")
        real = page.request.get(f"{ORIGIN}/api/v1/personal-assistant").json()
        stub = {**real, "state": "not_enabled", "unavailableReason": None, "enablement": None, "setup": {"provider": "on", "connection": "active"}}
        sent: list[dict] = []

        def fulfil(route) -> None:
            if route.request.method == "GET":
                route.fulfill(status=200, content_type="application/json", body=json.dumps(stub))
            elif route.request.method == "POST":
                sent.append(json.loads(route.request.post_data or "{}"))
                route.fulfill(status=409, content_type="application/json", body=json.dumps({"code": "PERSONAL_RUN_CONNECTION_REQUIRED", "message": "Stubbed refusal"}))
            else:
                route.continue_()

        page.route("**/api/v1/personal-assistant", fulfil)
        page.goto("/settings/assistant")
        select = page.get_by_label("AI connection")
        facts = page.locator(".aset__facts")
        consent = page.locator(".aset__consent")
        for item in owned:
            choose(select, value=item["id"])
            provider = "your own endpoint" if item["provider"] == "openai_compatible" else {"anthropic": "Anthropic"}[item["provider"]]
            expect(consent).to_contain_text(f"are sent to {provider} under")
            expect(facts).to_contain_text(item["model"])
            expect(facts).to_contain_text(f"{item['payerOrganization']} · {item['providerWorkspace']}")
        shot(page, "ai-connections-1440-assistant-consent-chosen")
        chosen = owned[-1]
        choose(select, value=chosen["id"])
        page.get_by_role("checkbox", name=re.compile("^I agree that excerpts")).check()
        page.get_by_role("button", name="Turn on my assistant").click()
        expect(page.get_by_role("alert")).to_contain_text("Nothing was turned on")
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0].get("connectionId"), chosen["id"], "the request names the connection the consent described")

    def test_09_every_entry_point_opens_the_one_ai_connections_page(self) -> None:
        """#513 B2: "Use an API key", each key row and the assistant's set-up hint lead to one AI connections page,
        titled as such, with the connection list and form; nothing there claims a connection enables nothing."""
        page = self.page()
        page.goto("/settings/agents")
        flux = page.get_by_role("region", name="Agent in Flux", exact=True)
        api_key = flux.get_by_role("link", name=re.compile("^Use an API key"))
        expect(api_key).to_have_attribute("href", "/settings/ai-connections")
        # "Use an API key" and the two connections saved by the earlier tests, all on the same page.
        expect(flux.locator('a.sset-row[href="/settings/ai-connections"]')).to_have_count(3)
        expect(flux.locator('a.sset-row', has_text="Work Anthropic")).to_have_attribute("href", "/settings/ai-connections")
        api_key.click()
        expect(page).to_have_url(re.compile(r"/settings/ai-connections$"))
        expect(page.locator("header.top").get_by_role("heading", level=1, name="AI connections", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", level=2, name="AI connections", exact=True)).to_be_visible()
        # On the phone the header alone names the page (#513: one title).
        phone = self.page(phone=True)
        phone.goto("/settings/ai-connections")
        expect(phone.locator(".app__main header").get_by_role("heading", level=1, name="AI connections", exact=True)).to_be_visible()
        expect(phone.get_by_role("button", name="Add a connection", exact=True)).to_be_visible()
        expect(phone.get_by_role("heading", name="AI connections", exact=True)).to_have_count(1)
        shot(phone, "ai-connections-390-page")
        expect(page.get_by_role("navigation", name="Settings sections").get_by_role("link", name="Agents and AI")).to_have_attribute("aria-current", "page")
        expect(page.locator(".background-settings__connection")).to_have_count(2)
        expect(page.get_by_role("heading", name=re.compile("background suggestions", re.I))).to_have_count(0)
        self.assertNotIn("enables nothing", page.locator(".background-settings").inner_text())
        expect(page.get_by_role("link", name="Back to Agents and AI")).to_have_attribute("href", "/settings/agents")
        shot(page, "ai-connections-1440-page")
        # The assistant's set-up hint, shown when no key of its own is connected (a stubbed status), points there too.
        real = page.request.get(f"{ORIGIN}/api/v1/personal-assistant").json()
        stub = {**real, "state": "not_enabled", "enablement": None, "setup": {"provider": "on", "connection": "none"}}
        page.route("**/api/v1/personal-assistant", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(stub))
                   if route.request.method == "GET" else route.continue_())
        page.goto("/settings/assistant")
        hint = page.get_by_role("note").filter(has_text="Your own AI key isn’t connected")
        expect(hint.get_by_role("link", name="AI connections")).to_have_attribute("href", "/settings/ai-connections")

    @staticmethod
    def runtime_answer(status: str):
        """A route handler that answers the background runtime read with the given status."""
        body = json.dumps({"status": status})
        return lambda route: route.fulfill(status=200, content_type="application/json", body=body)

    def test_10_background_keeps_usage_and_rules_under_one_status_line_and_no_control_moves(self) -> None:
        """#513 B1, B2 and Spokój rule 7: with background suggestions off (this server) and on (a stubbed runtime),
        Background suggestions shows one status line with AI connections beside it, then usage and project rules, in
        the same places; it has no connection form. AI connections looks the same in both states."""
        positions: dict[str, dict] = {}
        for runtime in ("unavailable", "available"):
            for phone in (False, True):
                page = self.page(phone=phone)
                page.route("**/api/v1/background-comparisons/runtime", self.runtime_answer(runtime))
                page.goto("/settings/background-compute")
                note = page.get_by_role("note")
                expect(note).to_have_text("Off on this Flux server · not available until your admin turns it on" if runtime == "unavailable" else "On · uses Work Anthropic")
                link = page.locator(".background-settings__status").get_by_role("link", name="AI connections", exact=True)
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
                    self.assertGreaterEqual(box(page, link)["height"], 44, "AI connections is a 44 px target on touch")
                    self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
                status = page.locator(".background-settings__status")
                spots = {name: (round(b["x"]), round(b["y"]), round(b["width"]), round(b["height"])) for name, b in
                         (("status", box(page, status)), ("link", box(page, link)), ("usage", box(page, usage)), ("rules", box(page, rules)))}
                spots["note-x"] = round(box(page, note)["x"])
                shot(page, f"background-{'390' if phone else '1440'}-{runtime}")
                page.goto("/settings/ai-connections")
                add = page.get_by_role("button", name="Add a connection", exact=True)
                expect(add).to_be_visible()
                page.wait_for_function("document.getAnimations().every((a) => a.playState !== 'running')")
                added = box(page, add)
                spots["add"] = (round(added["x"]), round(added["y"]), round(added["width"]), round(added["height"]))
                positions[f"{runtime}-{'phone' if phone else 'computer'}"] = spots
        for device in ("computer", "phone"):
            self.assertEqual(positions[f"unavailable-{device}"], positions[f"available-{device}"],
                             f"{device}: the status line, AI connections, usage, rules and Add a connection keep their places")

    def test_11_a_codex_host_action_is_labelled_pending_native_verification(self) -> None:
        """#635: the Codex Start/Resume host action says it is pending native verification, as Claude's path does,
        and the guide does not claim a recorded real-account Resume. The Codex connection is created through the API."""
        page = self.page()
        headers = {"origin": ORIGIN, "content-type": "application/json"}

        def post(path: str, body: dict) -> dict:
            response = page.request.post(f"{ORIGIN}{path}", data=body, headers=headers)
            self.assertEqual(response.status, 201, response.text())
            return response.json()

        ws = post("/api/v1/workspaces", {"name": "Codex label studio"})
        project = post(f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Codex label", "visibility": "workspace"})
        agent = post(f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Ada's Codex", "owner": "self"})
        post(f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"})
        post("/api/v1/agent-connections", {"agentId": agent["id"], "selectedProjectIds": [project["id"]], "name": "Ada Codex laptop",
             "scopes": ["flux.context.read", "flux.proposal.write"], "clientDesignation": "codex"})
        page.goto("/connect-agent")
        page.locator("label.connection__choice", has_text="Ada Codex laptop").locator("input").check()
        host = page.locator(".mcp-permissions .cowork-host-actions")
        expect(host).to_have_count(1)
        expect(host.locator("summary")).to_contain_text("pending native verification")
        expect(host).to_contain_text("no real-account Start or exact-thread Resume through this action is recorded yet")
        expect(page.locator(".connection__guide")).to_contain_text("It is pending native verification")
        expect(page.locator(".connection__guide")).not_to_contain_text("resumes only its own saved native thread")
        shot(page, "ai-connection-1440-codex-host-pending")


if __name__ == "__main__":
    unittest.main()
