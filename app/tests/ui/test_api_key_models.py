"""Browser tests for an API key's models (CA-2, #1218): Provider → API key → Model, the key's own list, its refusal and its failure.

Runs through scripts/check_ui.sh in Chromium and WebKit (FLUX_UI_BROWSER). The API lists the key's models from the stack's mock
(`tests/ui/anthropic_mock.py`, `/lists/…`, FLUX_TEST_PROVIDER_LISTS): a key containing `refused` is refused, `slow` answers after the
8-second bound. The agent page's API-key dropdown is shown on a stubbed model choice (the rules are proven against the real store
in app/tests/app/api-key-model-lists.test.ts). No key is real and no provider is called.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, Page, Route, expect, sync_playwright

from app_select import choose, open_select, values
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "a provider of my own choosing"
STAMP = int(time.time() * 1000)
OWNER = {"name": "Ines Park", "email": f"ines.park+{STAMP}@example.test"}
MARK = "owner-budget-key-"
GOOD = f"sk-ant-api03-{MARK * 3}KM01"
REFUSED = f"sk-ant-api03-refused-{MARK * 2}KM02"
SLOW = f"sk-ant-api03-slow-{MARK * 2}KM03"


def named(name: str) -> str:
    return name if UI_BROWSER == "chromium" else f"{name}-{UI_BROWSER}"


class ApiKeyModels(unittest.TestCase):
    """Tests run in name order and share one owner."""

    pw = None
    browser: Browser
    state: dict | None = None

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=UI_BROWSER == "chromium", has_touch=True)
        else:
            options.update(viewport=DESKTOP)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def form(self, page: Page) -> None:
        page.goto("/settings/ai-connections?new=1")
        expect(page.get_by_role("heading", name="Use an API key")).to_be_visible()
        choose(page.get_by_label("Provider", exact=True), label="Anthropic")

    def type_key(self, page: Page, key: str) -> None:
        field = page.get_by_label("API key", exact=True)
        field.fill(key)
        field.blur()

    def no_key_in_page(self, page: Page) -> None:
        html = page.content()
        storage = page.evaluate("JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })")
        for key in (GOOD, REFUSED, SLOW):
            self.assertNotIn(key, storage)
            self.assertNotIn(f'value="{key}"', html)

    def test_01_owner_signs_up(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(OWNER["name"])
        page.get_by_label("Email").fill(OWNER["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()

    def test_02_the_key_comes_before_the_model_and_fills_it_by_family_with_prices(self) -> None:
        page = self.page()
        self.form(page)
        # The order is Provider, API key, Model; the Model waits for the key.
        order = page.evaluate("""() => [...document.querySelectorAll('.background-settings__fields > label')].map((label) => label.childNodes[0].textContent.trim())""")
        self.assertEqual(order[:3], ["Provider", "API key", "Model"])
        model = page.get_by_role("combobox", name="Model")
        expect(model).to_be_disabled()
        expect(model).to_contain_text("Enter the API key first")
        expect(page.locator("datalist")).to_have_count(0)
        self.type_key(page, GOOD)
        expect(page.get_by_role("status").filter(has_text="6 models from Anthropic.")).to_be_visible()
        expect(model).to_be_enabled()
        self.assertEqual(values(model), ["claude-sonnet-5-7", "claude-sonnet-5-5", "claude-sonnet-5", "claude-fable-5-2", "claude-opus-5-5",
                                         "claude-haiku-4-5-20251001", "__other__"], "by family, the newest family and model first")
        box = open_select(model.first)
        groups = box.locator(".ui-select__group").all_inner_texts()
        self.assertEqual([text.strip() for text in groups], ["Sonnet", "Fable", "Opus", "Haiku"])
        expect(box.get_by_role("option", name="Claude Opus 5.5 · $4 / $20", exact=True)).to_be_visible()
        expect(box.get_by_role("option", name="Claude Sonnet 5.7 · price unknown, enter it", exact=True)).to_be_visible()
        expect(box.get_by_role("option", name="Other model id…", exact=True)).to_be_visible()
        shot(page, named("api-key-models-1440-open"))
        page.keyboard.press("Escape")
        # Nothing is preselected: the models are the provider's own (founder direction, 2026-11-12). Opus shows its table price.
        expect(model).to_contain_text("Choose a model")
        expect(page.get_by_test_id("connection-price")).to_have_count(0)
        choose(model, value="claude-opus-5-5")
        expect(page.get_by_test_id("connection-price")).to_contain_text("$4.00 input · $20.00 output per 1M tokens · Flux price table, checked 2026-11-12")
        # A model Flux has no price for asks its price; "Other model id…" opens the plain field.
        choose(model, value="claude-sonnet-5-7")
        price = page.get_by_role("group", name="Price per 1M tokens (USD)")
        expect(price).to_contain_text("Flux doesn’t know this model’s price yet. Enter it to use it with a daily budget")
        choose(model, value="__other__")
        expect(page.get_by_label("Model id", exact=True)).to_be_visible()
        choose(model, value="claude-opus-5-5")
        expect(page.get_by_label("Model id", exact=True)).to_have_count(0)
        page.get_by_label("Daily budget (USD)", exact=True).last.fill("5")
        page.get_by_label("Name", exact=True).fill("Ines's Anthropic key")
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.get_by_role("status").filter(has_text="Key saved with a daily budget of $5.00.")).to_be_visible()
        saved = [item for item in json.loads(page.request.get(f"{ORIGIN}/api/v1/background-compute-connections").text()) if item["name"] == "Ines's Anthropic key"]
        self.assertEqual([(item["provider"], item["model"]) for item in saved], [("anthropic", "claude-opus-5-5")])
        self.no_key_in_page(page)

    def test_03_a_refused_key_says_so_and_connect_waits_for_another(self) -> None:
        page = self.page()
        self.form(page)
        self.type_key(page, REFUSED)
        alert = page.get_by_role("alert").filter(has_text="This key was refused by Anthropic. Check it and try again.")
        expect(alert).to_be_visible()
        expect(page.get_by_label("API key", exact=True)).to_have_attribute("aria-invalid", "true")
        expect(page.get_by_role("combobox", name="Model")).to_be_disabled()
        expect(page.get_by_role("button", name="Connect", exact=True)).to_be_disabled()
        shot(page, named("api-key-models-1440-refused"))
        # Another key clears the refusal and is read again.
        self.type_key(page, f"sk-ant-api03-{MARK * 3}KM04")
        expect(alert).to_have_count(0)
        expect(page.get_by_role("button", name="Connect", exact=True)).to_be_enabled()
        expect(page.get_by_role("combobox", name="Model")).to_be_enabled()

    def test_04_a_list_that_cannot_be_read_leaves_the_plain_field_with_a_note(self) -> None:
        page = self.page()
        self.form(page)
        self.type_key(page, SLOW)
        expect(page.get_by_role("status").filter(has_text="Reading Anthropic’s models…")).to_be_visible()
        note = page.get_by_role("status").filter(has_text="Anthropic’s model list couldn’t be read. Type the model id from Anthropic’s documentation.")
        expect(note).to_be_visible(timeout=20000)
        field = page.get_by_label("Model", exact=True)
        expect(field).to_be_editable()
        field.fill("claude-opus-5-5")
        expect(page.get_by_test_id("connection-price")).to_contain_text("$4.00 input · $20.00 output per 1M tokens")
        expect(page.get_by_role("button", name="Connect", exact=True)).to_be_enabled()

    def test_05_the_form_fits_a_phone_light_and_dark(self) -> None:
        for dark in (False, True):
            page = self.page(phone=True, dark=dark)
            self.form(page)
            self.type_key(page, GOOD)
            model = page.get_by_role("combobox", name="Model")
            expect(model).to_be_enabled()
            box = model.bounding_box()
            self.assertIsNotNone(box)
            self.assertGreaterEqual(box["height"], 44, "a touch-sized dropdown")
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))
            shot(page, named(f"api-key-models-390-{'dark' if dark else 'light'}"))
            sheet = open_select(model.first)
            expect(sheet.get_by_role("option", name="Claude Opus 5.5 · $4 / $20", exact=True)).to_be_visible()
            shot(page, named(f"api-key-models-390-{'dark' if dark else 'light'}-open"))
        desk = self.page(dark=True)
        self.form(desk)
        self.type_key(desk, GOOD)
        expect(desk.get_by_role("combobox", name="Model")).to_be_enabled()
        shot(desk, named("api-key-models-1440-dark"))

    def test_06_the_agent_page_lists_the_key_models_asks_a_price_and_offers_try_again(self) -> None:
        page = self.page()
        headers = {"origin": ORIGIN}
        ws = page.request.post(f"{ORIGIN}/api/v1/workspaces", data={"name": "Model lab"}, headers=headers)
        self.assertEqual(ws.status, 201, ws.text())
        made = page.request.post(f"{ORIGIN}/api/v1/my-agents", data={"workspaceId": ws.json()["id"], "name": "Planner"}, headers=headers)
        self.assertEqual(made.status, 201, made.text())
        agent = made.json()
        # The UI stack runs agents on a test-only fixture key, so the key's group is stubbed; its id is the agent's own connection.
        connection = (agent.get("model") or {}).get("connection") or "4c1f0a52-7d3e-4b8a-9f61-2e5d8c7b9a10"
        options = [
            {"id": "claude-sonnet-5-7", "name": "Claude Sonnet 5.7", "note": "Price unknown, enter it", "callsTools": True, "family": "Sonnet", "priced": False},
            {"id": "claude-sonnet-5-5", "name": "Sonnet 5.5", "note": "Input $2, output $10 per 1M tokens", "callsTools": True, "family": "Sonnet", "priced": True},
            {"id": "claude-opus-5-5", "name": "Opus 5.5", "note": "Input $4, output $20 per 1M tokens", "callsTools": True, "family": "Opus", "priced": True},
            {"id": "claude-opus-5", "name": "Opus 5", "note": "Input $5, output $25 per 1M tokens", "callsTools": True, "family": "Opus", "priced": True, "retired": True},
        ]
        world = {"listing": {"state": "unavailable", "checkedOn": "2026-11-11"}, "puts": [], "patches": [], "refreshed": 0}

        def choice(route: Route) -> None:
            group = {"connection": connection, "account": "api_key", "label": "Work Anthropic", "company": "Anthropic", "options": options, "listing": world["listing"]}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"current": {"connection": connection, "model": "claude-opus-5-5"}, "default": None, "groups": [group], "saved": True}))

        def refresh(route: Route) -> None:
            world["refreshed"] += 1
            world["listing"] = {"state": "listed", "checkedOn": "2026-11-12"}
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"listing": world["listing"]}))

        def price(route: Route) -> None:
            world["puts"].append(json.loads(route.request.post_data or "{}"))
            route.fulfill(status=200, content_type="application/json", body="{}")

        def patch(route: Route) -> None:
            if route.request.method != "PATCH":
                route.fallback()
                return
            world["patches"].append(json.loads(route.request.post_data or "{}"))
            route.fulfill(status=200, content_type="application/json", body=json.dumps(agent))

        page.route(re.compile(r".*/api/v1/personal-assistant/model$"), choice)
        page.route(re.compile(r".*/model-list$"), refresh)
        page.route(re.compile(r".*/model-price$"), price)
        page.route(re.compile(rf".*/api/v1/my-agents/{agent['id']}$"), patch)
        page.goto(f"/settings/agents/{agent['id']}")
        listing = page.get_by_role("status").filter(has_text="Couldn’t read Anthropic’s model list.")
        expect(listing).to_be_visible()
        model = page.locator(".agp__key-models .ui-select")
        self.assertEqual(values(model), ["claude-sonnet-5-7", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5"])
        box = open_select(model.first)
        expect(box.get_by_role("option", name="Opus 5 · no longer offered by Anthropic", exact=True)).to_have_attribute("aria-disabled", "true")
        page.keyboard.press("Escape")
        shot(page, named("api-key-models-agent-1440-unavailable"))
        listing.get_by_role("button", name="Try again").click()
        expect(listing).to_have_count(0)
        self.assertEqual(world["refreshed"], 1)
        choose(model, value="claude-sonnet-5-7")
        form = page.get_by_role("form", name="Price of Claude Sonnet 5.7")
        expect(form).to_contain_text("Flux doesn’t know this model’s price yet. Enter it to use it with a daily budget.")
        form.get_by_label("Input, USD per 1M tokens").fill("3")
        form.get_by_label("Output, USD per 1M tokens").fill("15")
        shot(page, named("api-key-models-agent-1440-price"))
        form.get_by_role("button", name="Save price").click()
        expect(form).to_have_count(0)
        self.assertEqual(world["puts"], [{"model": "claude-sonnet-5-7", "inputMicrosPerMTok": 3_000_000, "outputMicrosPerMTok": 15_000_000}])
        self.assertEqual(world["patches"][-1], {"connection": connection, "model": "claude-sonnet-5-7"})


if __name__ == "__main__":
    unittest.main()
