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

from app_select import choose, labels, open_more, open_select, values
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

# The price fields' plain words (design §7, founder decision 2026-11-14, #1424).
PRICE = "Price in US dollars for a million tokens sent to the model (input) and a million it writes (output)"
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
        # The order is Provider, API key, then the Model once the key's models are read (#1424); the Model is not there before.
        order = page.evaluate("""() => [...document.querySelectorAll('fieldset.background-settings__fields > label')].map((label) => label.childNodes[0].textContent.trim())""")
        self.assertEqual(order, ["Provider", "API key"])
        model = page.get_by_role("combobox", name="Model")
        expect(model).to_have_count(0)
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
        # #1424: Anthropic's newest Sonnet, the balanced model, is already chosen (here a model Flux has no price for, so its price is asked). The models are the provider's own (founder direction, 2026-11-12). Opus shows its list price.
        expect(model).to_contain_text("Claude Sonnet 5.7")
        expect(page.get_by_role("group", name=PRICE)).to_be_visible()
        expect(page.get_by_test_id("connection-price")).to_have_count(0)
        choose(model, value="claude-opus-5-5")
        expect(page.get_by_test_id("connection-price")).to_contain_text("$4.00 for what you send and $20.00 for what it writes, per million tokens · Flux’s price list of ")
        # A model Flux has no price for asks its price; "Other model id…" opens the plain field.
        choose(model, value="claude-sonnet-5-7")
        price = page.get_by_role("group", name=PRICE)
        expect(price).to_contain_text("Flux doesn’t know this model’s price yet. Enter it to use it with a daily budget")
        choose(model, value="__other__")
        expect(page.get_by_label("Model id", exact=True)).to_be_visible()
        choose(model, value="claude-opus-5-5")
        expect(page.get_by_label("Model id", exact=True)).to_have_count(0)
        open_more(page)
        page.get_by_label("Daily budget (USD)", exact=True).last.fill("5")
        page.get_by_label("Name (optional)", exact=True).fill("Ines's Anthropic key")
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.get_by_role("status").filter(has_text="Key saved with a daily budget of $5.00.")).to_be_visible()
        saved = [item for item in json.loads(page.request.get(f"{ORIGIN}/api/v1/background-compute-connections").text()) if item["name"] == "Ines's Anthropic key"]
        self.assertEqual([(item["provider"], item["model"]) for item in saved], [("anthropic", "claude-opus-5-5")])
        # Your API keys names the model as Connect AI did, the provider's "Claude Opus 5.5", never Flux's short "Opus 5.5" (release audit ffcb07c);
        # and its budget line is whole sentences, with no "counts against it: your agents."
        card = page.get_by_role("listitem", name="Ines's Anthropic key")
        expect(card.locator("dt", has_text="Model").locator("xpath=following-sibling::dd")).to_have_text("Claude Opus 5.5")
        expect(card).not_to_contain_text("counts against it:")
        self.no_key_in_page(page)

    def test_02a_the_key_step_opens_with_only_the_provider_and_the_key_and_connect_waits_for_a_provider(self) -> None:
        """Re-review of v0.2.1 (P2), design §7 (#1424, founder decision 2026-11-14): the step shows first only Provider and API key. No Model
        field before a provider is chosen (it showed an empty free box), and Connect is disabled while nothing can be connected. The plain
        field stays where it belongs: an endpoint's model before any list is read."""
        page = self.page()
        page.goto("/settings/ai-connections?new=1")
        expect(page.get_by_role("heading", name="Use an API key")).to_be_visible()
        form = page.locator(".cai-window form")
        # Every control a person can see and reach, in order: the two fields, More, then Cancel and Connect.
        visible = """form => [...form.querySelectorAll('button, input, select, textarea')]
            .filter((el) => el.type !== 'hidden' && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0)
            .map((el) => el.getAttribute('aria-label') || el.labels?.[0]?.childNodes[0]?.textContent.trim() || el.textContent.trim())"""
        self.assertEqual(form.evaluate(visible), ["Provider", "API key", "More settings", "Cancel", "Connect"])
        expect(page.get_by_label("Model", exact=True)).to_have_count(0)
        expect(page.get_by_role("textbox", name="Model")).to_have_count(0)
        expect(page.get_by_role("combobox", name="Model")).to_have_count(0)
        connect = page.get_by_role("button", name="Connect", exact=True)
        expect(connect).to_be_disabled()
        # One plain line under the key; the provider's key shape only once a provider is chosen (design §7, #1424).
        plain = "Paste the key from your provider’s website. Flux uses it only for your agents."
        help_line = page.locator("#background-key-help")
        expect(help_line).to_have_text(plain)
        expect(page.get_by_label("API key", exact=True)).to_have_attribute("aria-describedby", "background-key-help")
        shot(page, named("api-key-models-1440-first"))
        # Enter in the key field submits nothing either.
        before = self.connected(page)
        key = page.get_by_label("API key", exact=True)
        key.fill(f"sk-ant-api03-{MARK * 3}KM10")
        key.press("Enter")
        expect(page.get_by_role("alert")).to_have_count(0)
        self.assertEqual(self.connected(page), before, "nothing is saved")
        # A provider chosen: Connect can be pressed; Anthropic's Model waits for the key to be read, an endpoint's is the plain field.
        provider = page.get_by_label("Provider", exact=True)
        choose(provider, label="Anthropic")
        expect(connect).to_be_enabled()
        # One rule for every provider (atlas v0.2.2: Google Gemini's Connect was dark with an empty key): Connect waits for a key.
        key.fill("")
        expect(connect).to_be_disabled()
        choose(provider, label="Google Gemini")
        expect(connect).to_be_disabled()
        key.fill("AIza-1")
        expect(connect).to_be_enabled()
        key.fill("")
        expect(connect).to_be_disabled()
        choose(provider, label="Anthropic")
        expect(connect).to_be_disabled()
        expect(page.get_by_label("Model", exact=True)).to_have_count(0)
        expect(help_line).to_have_text(f"{plain} Anthropic API keys begin with sk-ant-. A key of your Claude Max, Ultra or Team plan uses its monthly API credits.")
        choose(provider, label="OpenAI-compatible endpoint")
        expect(page.get_by_role("textbox", name="Model")).to_be_editable()
        # "Choose a provider" is the closed field's placeholder, not an option to tick (v0.2.1 UI audit, P3 4).
        self.assertNotIn("Choose a provider", labels(provider))

    def test_02b_the_form_asks_first_only_for_the_provider_and_the_key_and_keeps_the_rest_behind_more(self) -> None:
        """#1424 (founder decision, 2026-11-14): Provider and API key first; the model already chosen once the key is read; the budget and the
        optional name behind More; plain words; the window does not scroll at 1440 × 900; connecting without opening More uses the default budget."""
        page = self.page()
        self.form(page)
        window = page.locator(".cai-window")

        def fits() -> None:
            height, visible = window.evaluate("el => [el.scrollHeight, el.clientHeight]")
            self.assertLessEqual(height, visible + 1, "the window does not scroll")

        self.assertEqual(page.viewport_size, {"width": 1440, "height": 900})
        expect(page.get_by_label("Provider", exact=True)).to_be_visible()
        expect(page.get_by_label("API key", exact=True)).to_be_visible()
        expect(page.get_by_role("combobox", name="Model")).to_have_count(0)
        expect(page.get_by_role("group", name=PRICE)).to_have_count(0)
        expect(window.get_by_label("Daily budget (USD)", exact=True)).to_be_hidden()
        expect(window.get_by_label("Name (optional)", exact=True)).to_be_hidden()
        more = page.get_by_role("button", name="More settings")
        expect(more).to_have_attribute("aria-expanded", "false")
        expect(page.get_by_test_id("budget-line")).to_have_text("Daily budget $5.00")
        fits()
        self.type_key(page, GOOD)
        model = page.get_by_role("combobox", name="Model")
        expect(model).to_contain_text("Claude Sonnet 5.7")  # Anthropic's newest Sonnet, the balanced model
        choose(model, value="claude-opus-5-5")
        expect(page.get_by_role("group", name=PRICE)).to_have_count(0)
        fits()
        words = window.inner_text()
        for jargon in ("Chat Completions", "Console organization", "input / output", "per 1M tokens, input"):
            self.assertNotIn(jargon, words)
        more.click()
        expect(more).to_have_attribute("aria-expanded", "true")
        expect(window.get_by_label("Daily budget (USD)", exact=True)).to_have_value("5.00")
        expect(window.get_by_label("Name (optional)", exact=True)).to_be_visible()
        fits()
        shot(page, named("api-key-models-1440-more"))
        more.click()
        # Connecting with More closed saves the key with the default budget and its provider's default name.
        before = self.connected(page)
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.get_by_role("status").filter(has_text="Key saved with a daily budget of $5.00.")).to_be_visible()
        added = [item for item in json.loads(page.request.get(f"{ORIGIN}/api/v1/background-compute-connections").text()) if item["name"] not in before]
        self.assertEqual([(item["name"], item["model"], item["dailyBudgetCents"]) for item in added], [("Anthropic key", "claude-opus-5-5", 500)])
        self.no_key_in_page(page)

    def test_02b2_an_unpriced_model_asks_its_price_in_plain_words_and_the_window_still_does_not_scroll(self) -> None:
        """v0.2.1 UI audit P2-2, design §7 (founder decision 2026-11-14, #1424): the price reads "Price in US dollars for a million tokens sent
        to the model (input) and a million it writes (output)", never "per 1M tokens" or "Input price". With the price fields and More open,
        the window does not scroll and Cancel and Connect stay in view, at 1440 × 900 and at 1280 × 800. The fields have no native steppers."""
        for size in ({"width": 1440, "height": 900}, {"width": 1280, "height": 800}):
            with self.subTest(size=size):
                page = self.page()
                page.set_viewport_size(size)
                self.form(page)
                self.type_key(page, GOOD)
                model = page.get_by_role("combobox", name="Model")
                expect(model).to_contain_text("Claude Sonnet 5.7")  # the default, a model Flux has no price for in the stack
                price = page.get_by_role("group", name=PRICE)
                expect(price).to_be_visible()
                expect(price).to_contain_text("Flux doesn’t know this model’s price yet. Enter it to use it with a daily budget.")
                for field in ("Input", "Output"):
                    expect(price.get_by_label(field, exact=True)).to_be_editable()
                    self.assertEqual(price.get_by_label(field, exact=True).evaluate("el => getComputedStyle(el).appearance"), "textfield", f"{field}: no steppers")
                open_more(page)
                window = page.locator(".cai-window")
                expect(window.get_by_label("Name (optional)", exact=True)).to_be_visible()
                words = window.inner_text()
                for jargon in ("1M", "Input price", "Output price", "USD per"):
                    self.assertNotIn(jargon, words, "plain words")
                height, visible = window.evaluate("el => [el.scrollHeight, el.clientHeight]")
                self.assertLessEqual(height, visible + 1, f"the window does not scroll: {height} px in {visible}")
                frame = page.locator(".cai-dialog").bounding_box()
                for name in ("Cancel", "Connect"):
                    button = window.get_by_role("button", name=name, exact=True).bounding_box()
                    self.assertLessEqual(button["y"] + button["height"], min(frame["y"] + frame["height"], size["height"]), f"{name} is in view: {button} {frame}")
                # The two prices sit on one line, and the budget beside the name.
                inputs = [price.get_by_label(field, exact=True).bounding_box() for field in ("Input", "Output")]
                self.assertAlmostEqual(inputs[0]["y"], inputs[1]["y"], delta=1)
                budget, name = window.get_by_label("Daily budget (USD)", exact=True).bounding_box(), window.get_by_label("Name (optional)", exact=True).bounding_box()
                self.assertAlmostEqual(budget["y"], name["y"], delta=1)
                shot(page, named(f"api-key-models-{size['width']}-unpriced-more"))
        # The phone: one column, the price fields touch-sized and without the WebKit steppers.
        phone = self.page(phone=True)
        self.form(phone)
        self.type_key(phone, GOOD)
        price = phone.get_by_role("group", name=PRICE)
        expect(price).to_be_visible()
        for field in ("Input", "Output"):
            box = price.get_by_label(field, exact=True)
            self.assertEqual(box.evaluate("el => getComputedStyle(el).appearance"), "textfield", f"{field}: no steppers on the phone")
            self.assertGreaterEqual(box.bounding_box()["height"], 44, field)
        self.assertLessEqual(phone.evaluate("document.documentElement.scrollWidth"), phone.evaluate("window.innerWidth"))
        shot(phone, named("api-key-models-390-unpriced"))

    def test_02c_the_model_chosen_is_the_providers_balanced_one_found_by_family_name(self) -> None:
        """#1424 (founder decision, 2026-11-14): Anthropic's newest Sonnet, OpenAI's newest Sol, Gemini's newest Flash, whatever their place in the
        list; Opus, Fable, Astra, Carbon and the cheaper models stay in it; with no such family the first of the list."""
        def model(model_id: str, name: str, family: str, created: str) -> dict:
            return {"id": model_id, "name": name, "family": family, "createdAt": created}

        lists = {
            "anthropic": [model("claude-fable-5-3", "Claude Fable 5.3", "Fable", "2026-11-12T00:00:00Z"), model("claude-opus-5-6", "Claude Opus 5.6", "Opus", "2026-11-11T00:00:00Z"),
                          model("claude-sonnet-5-7", "Claude Sonnet 5.7", "Sonnet", "2026-11-10T00:00:00Z"), model("claude-sonnet-5-5", "Claude Sonnet 5.5", "Sonnet", "2026-09-28T00:00:00Z"),
                          model("claude-haiku-5", "Claude Haiku 5", "Haiku", "2026-06-01T00:00:00Z")],
            "openai": [model("gpt-6.2-astra", "GPT-6.2 Astra", "Astra", "2026-11-12T00:00:00Z"), model("gpt-6-luna", "GPT-6 Luna", "Luna", "2026-11-11T00:00:00Z"),
                       model("gpt-6.1-sol", "GPT-6.1 Sol", "Sol", "2026-10-01T00:00:00Z"), model("gpt-6.2-sol", "GPT-6.2 Sol", "Sol", "2026-11-10T00:00:00Z")],
            "gemini": [model("gemini-4-carbon", "Gemini 4 Carbon", "Carbon", "2026-11-12T00:00:00Z"), model("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", "Flash-Lite", "2026-11-11T00:00:00Z"),
                       model("gemini-3.5-flash", "Gemini 3.5 Flash", "Flash", "2026-11-01T00:00:00Z"), model("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", "Pro", "2026-09-01T00:00:00Z")],
        }
        # Lists with no Sonnet, no Sol and no Flash: the first of the list.
        without = {"anthropic": lists["anthropic"][:2], "openai": lists["openai"][:2], "gemini": [lists["gemini"][0], lists["gemini"][3]]}
        served = {"lists": lists}

        def answer(route: Route) -> None:
            provider = route.request.post_data_json["provider"]
            route.fulfill(json={"provider": provider, "status": "listed", "checkedOn": "2026-11-14", "models": served["lists"][provider], "priceList": None})

        page = self.page()
        page.route(re.compile(r".*/api/v1/ai-model-lists$"), answer)
        self.form(page)
        keys = {"anthropic": "sk-ant-api03-balanced-model-key-01", "openai": "sk-proj-balanced-model-key-01", "gemini": "AIzabalanced-model-key-0001"}
        labels = {"anthropic": "Anthropic", "openai": "OpenAI", "gemini": "Google Gemini"}
        for round_, (shown, expected) in enumerate(((lists, {"anthropic": "Claude Sonnet 5.7", "openai": "GPT-6.2 Sol", "gemini": "Gemini 3.5 Flash"}),
                                                    (without, {"anthropic": "Claude Fable 5.3", "openai": "GPT-6.2 Astra", "gemini": "Gemini 4 Carbon"}))):
            served["lists"] = shown
            for provider in ("anthropic", "openai", "gemini"):
                choose(page.get_by_label("Provider", exact=True), label=labels[provider])
                key = page.get_by_label("API key", exact=True)
                key.fill(f"{keys[provider]}{round_}")
                key.blur()
                model = page.get_by_role("combobox", name="Model")
                expect(model).to_contain_text(expected[provider])
                # Every model of the provider's list stays to be chosen, the top tiers and the cheaper ones too (and "Other model id…").
                self.assertEqual(len(values(model)), len(shown[provider]) + 1, f"{provider}: the whole list is there")

    def test_02d_a_gemini_key_says_googles_terms_apply_to_its_web_search(self) -> None:
        """#1585 (founder decision, Hubert, 2026-11-20, C-72): a Gemini key's web search is Google Search grounding and its fit to Google's
        Gemini API terms is the key owner's: one quiet line with a link to the terms, in Connect AI and on the key's card, and for no other provider."""
        terms = "Web search uses Google Search grounding; Google’s Gemini API terms apply to your key."
        for phone, dark in ((False, False), (True, True)):
            page = self.page(phone=phone, dark=dark)
            self.form(page)
            line = page.get_by_test_id("gemini-search-terms")
            expect(line).to_have_count(0)
            choose(page.get_by_label("Provider", exact=True), label="Google Gemini")
            expect(line).to_have_text(terms)
            link = line.get_by_role("link", name="Google’s Gemini API terms")
            expect(link).to_have_attribute("href", "https://aistudio.google.com/docs/terms")
            expect(link).to_have_attribute("target", "_blank")
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))
            shot(page, named(f"api-key-models-{'390-dark' if phone else '1440-light'}-gemini-terms"))
            for other in ("OpenRouter", "OpenAI", "Anthropic"):
                choose(page.get_by_label("Provider", exact=True), label=other)
                expect(line).to_have_count(0)

        def card(provider: str, last_four: str) -> dict:
            return {"id": f"00000000-0000-4000-8000-00000000000{last_four[-1]}", "ownerUserId": "00000000-0000-4000-8000-000000000000", "name": f"My {provider} key",
                    "provider": provider, "model": "gemini-3.5-flash" if provider == "gemini" else "claude-sonnet-5", "modelName": "Gemini 3.5 Flash" if provider == "gemini" else "Claude Sonnet 5",
                    "baseUrl": None, "price": {"inputMicrosPerMTok": 300000, "outputMicrosPerMTok": 2500000, "source": "owner", "checkedOn": "2026-11-20"},
                    "keyLastFour": last_four, "keyFingerprint": "f" * 16, "dailyBudgetCents": 500, "timeZone": "UTC",
                    "today": {"spentMicros": 0, "resetsAt": "2026-11-21T00:00:00Z"}, "createdAt": "2026-11-20T08:00:00Z"}

        for phone, dark in ((False, False), (True, True)):
            page = self.page(phone=phone, dark=dark)
            page.route(re.compile(r".*/api/v1/background-compute-connections$"),
                       lambda route: route.fulfill(json=[card("gemini", "AB01"), card("anthropic", "CD02")]) if route.request.method == "GET" else route.fallback())
            page.goto("/settings/ai-connections")
            cards = page.locator(".background-settings__connection")
            expect(cards).to_have_count(2)
            expect(cards.nth(0).get_by_test_id("gemini-search-terms")).to_have_text(terms)
            expect(cards.nth(0).get_by_role("link", name="Google’s Gemini API terms")).to_have_attribute("href", "https://aistudio.google.com/docs/terms")
            expect(cards.nth(1).get_by_test_id("gemini-search-terms")).to_have_count(0)
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))
            shot(page, named(f"api-key-cards-{'390-dark' if phone else '1440-light'}-gemini-terms"))

    def test_03_a_refused_key_says_so_and_connect_waits_for_another(self) -> None:
        page = self.page()
        self.form(page)
        self.type_key(page, REFUSED)
        alert = page.get_by_role("alert").filter(has_text="This key was refused by Anthropic. Check it and try again.")
        expect(alert).to_be_visible()
        expect(page.get_by_label("API key", exact=True)).to_have_attribute("aria-invalid", "true")
        expect(page.get_by_role("combobox", name="Model")).to_have_count(0)
        expect(page.get_by_role("button", name="Connect", exact=True)).to_be_disabled()
        shot(page, named("api-key-models-1440-refused"))
        # Another key clears the refusal and is read again.
        self.type_key(page, f"sk-ant-api03-{MARK * 3}KM04")
        expect(alert).to_have_count(0)
        expect(page.get_by_role("button", name="Connect", exact=True)).to_be_enabled()
        expect(page.get_by_role("combobox", name="Model")).to_be_enabled()

    def test_03a_a_key_of_another_provider_says_so_in_the_servers_words_and_opens_no_free_field(self) -> None:
        """Review of v0.2.1 (P2-3), model-providers.md (#1424): the server turns away an OpenAI key under Anthropic (400 AI_KEY_FORMAT)
        before asking Anthropic. That is said under the key, Connect waits for another, and the free Model field stays closed: it is
        only for a list that can't be read (a timeout, a 5xx), as a stubbed 503 still shows."""
        page = self.page()
        self.form(page)
        before = self.connected(page)
        self.type_key(page, f"sk-proj-{MARK * 3}KM07")
        alert = page.get_by_role("alert").filter(has_text="This doesn’t look like an Anthropic key")
        expect(alert).to_be_visible()
        expect(page.get_by_label("API key", exact=True)).to_have_attribute("aria-invalid", "true")
        expect(page.get_by_text("couldn’t be read")).to_have_count(0)
        expect(page.get_by_role("combobox", name="Model")).to_have_count(0)
        expect(page.get_by_role("textbox", name="Model")).to_have_count(0)
        expect(page.get_by_role("button", name="Connect", exact=True)).to_be_disabled()
        # One plain sentence with Anthropic's key shape; the help line under the key, which says the shape too, is hidden meanwhile.
        expect(alert).to_have_text("This doesn’t look like an Anthropic key: those begin with sk-ant-.")
        # A whole sentence, never the fragment "An Anthropic API key beginning with sk-ant-." (release audit ffcb07c).
        hint = "Anthropic API keys begin with sk-ant-."
        self.assertEqual(page.evaluate("document.body.innerText").count("sk-ant-"), 1, "the key shape is said once")
        self.assertEqual(page.evaluate("document.body.innerText").count(hint), 0, "the help line is hidden while the alert says it")
        expect(page.get_by_label("API key", exact=True)).to_have_attribute("aria-describedby", re.compile(r"^\S+-refused$"))
        shot(page, named("api-key-models-wrong-format"))
        self.assertEqual(self.connected(page), before, "nothing is saved")
        # An Anthropic key clears it and is read.
        self.type_key(page, f"sk-ant-api03-{MARK * 3}KM08")
        expect(alert).to_have_count(0)
        self.assertEqual(page.evaluate("document.body.innerText").count(hint), 1, "the help line says the hint again, once")
        expect(page.get_by_role("combobox", name="Model")).to_be_enabled()
        expect(page.get_by_role("button", name="Connect", exact=True)).to_be_enabled()
        # A list the server can't read (a 5xx) is the one case for the free field.
        failing = self.page()
        failing.route(re.compile(r".*/api/v1/ai-model-lists$"), lambda route: route.fulfill(
            status=503, content_type="application/json", body=json.dumps({"error": "Service unavailable", "code": "UNAVAILABLE"})))
        self.form(failing)
        self.type_key(failing, f"sk-ant-api03-{MARK * 3}KM09")
        expect(failing.get_by_role("status").filter(has_text="Anthropic’s model list couldn’t be read.")).to_be_visible()
        expect(failing.get_by_label("Model", exact=True)).to_be_editable()
        expect(failing.get_by_role("alert")).to_have_count(0)

    def connected(self, page: Page) -> list[str]:
        return [item["name"] for item in json.loads(page.request.get(f"{ORIGIN}/api/v1/background-compute-connections").text())]

    def test_03b_a_key_is_never_saved_on_a_model_nobody_chose(self) -> None:
        """Enter in the key field reads the models instead of saving, and Connect while they are being read says to choose one."""
        page = self.page()
        self.form(page)
        before = self.connected(page)
        key = page.get_by_label("API key", exact=True)
        key.fill(f"sk-ant-api03-{MARK * 3}KM05")
        key.press("Enter")  # the field is not left: no blur, so no reading would have run before
        expect(page.get_by_role("status").filter(has_text="6 models from Anthropic.")).to_be_visible()
        model = page.get_by_role("combobox", name="Model")
        expect(model).to_be_enabled()
        expect(model).to_contain_text("Claude Sonnet 5.7")
        expect(page.get_by_role("status").filter(has_text="Key saved")).to_have_count(0)
        self.assertEqual(self.connected(page), before, "Enter saved nothing")
        # Connect while the list is still being read.
        waiting = self.page()
        self.form(waiting)
        self.type_key(waiting, SLOW)
        expect(waiting.get_by_role("status").filter(has_text="Reading Anthropic’s models…")).to_be_visible()
        waiting.get_by_role("button", name="Connect", exact=True).click()
        expect(waiting.get_by_role("alert").filter(has_text="Choose a model first.")).to_be_visible()
        self.assertEqual(self.connected(waiting), before, "Connect saved nothing")
        # The server holds the same line: a command without a model is a 422 and nothing is saved.
        refused = waiting.request.post(f"{ORIGIN}/api/v1/background-compute-connections", headers={"origin": ORIGIN},
                                       data={"provider": "anthropic", "apiKey": f"sk-ant-api03-{MARK * 3}KM06", "dailyBudgetCents": 500})
        self.assertEqual((refused.status, refused.json()["code"]), (422, "AI_MODEL_REQUIRED"), refused.text())
        self.assertEqual(self.connected(waiting), before)

    def test_03bb_the_line_about_a_model_goes_when_the_key_is_refused(self) -> None:
        """B-6/D-6: "Choose a model first…" was said while the list was read; a refused key has no model field, so the line goes with it."""
        page = self.page()
        self.form(page)
        held: list[Route] = []
        page.route(re.compile(r".*/api/v1/ai-model-lists$"), lambda route: held.append(route))  # the answer waits until the test lets it through
        self.type_key(page, REFUSED)
        expect(page.get_by_role("status").filter(has_text="Reading Anthropic’s models…")).to_be_visible()
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.get_by_role("alert").filter(has_text="Choose a model first.")).to_be_visible()
        held[0].fulfill(status=200, content_type="application/json", body=json.dumps({"provider": "anthropic", "status": "key_refused", "models": [], "checkedOn": "2026-11-14"}))
        expect(page.get_by_role("alert").filter(has_text="This key was refused by Anthropic.")).to_be_visible()
        expect(page.get_by_text("Choose a model first")).to_have_count(0)
        expect(page.get_by_role("combobox", name="Model")).to_have_count(0)
        expect(page.get_by_role("button", name="Connect", exact=True)).to_be_disabled()

    def test_03c_a_model_that_cannot_use_tools_is_refused_and_the_key_stays_for_another(self) -> None:
        """RT-1 rule 2 (#1441): the server's one `ping` check refuses the model, not the key, so the key is not cleared."""
        page = self.page()
        self.form(page)
        before = self.connected(page)
        self.type_key(page, GOOD)
        expect(page.get_by_role("status").filter(has_text="6 models from Anthropic.")).to_be_visible()
        model = page.get_by_role("combobox", name="Model")
        choose(model, value="__other__")
        page.get_by_label("Model id", exact=True).fill("claude-no-tools-1")
        page.get_by_label("Input", exact=True).fill("1")
        page.get_by_label("Output", exact=True).fill("5")
        open_more(page)
        page.get_by_label("Daily budget (USD)", exact=True).last.fill("5")
        page.get_by_role("button", name="Connect", exact=True).click()
        alert = page.get_by_role("alert")
        expect(alert).to_have_text("This model can't use tools. Choose another.")
        expect(alert).not_to_contain_text("cleared")
        expect(page.get_by_label("API key", exact=True)).to_have_value(GOOD)
        self.assertEqual(self.connected(page), before, "nothing is saved for a model that cannot use tools")
        shot(page, named("api-key-models-1441-no-tools"))
        # Another model of the same key, without typing the key again.
        choose(model, value="claude-opus-5-5")
        page.get_by_label("Name (optional)", exact=True).fill("Ines's second key")
        page.get_by_role("button", name="Connect", exact=True).click()
        expect(page.get_by_role("status").filter(has_text="Key saved with a daily budget of $5.00.")).to_be_visible()
        self.assertIn("Ines's second key", self.connected(page))
        self.no_key_in_page(page)

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
        expect(page.get_by_test_id("connection-price")).to_contain_text("$4.00 for what you send and $20.00 for what it writes, per million tokens")
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
        current = (agent.get("model") or {}).get("model") or "claude-sonnet-5"
        options = [
            {"id": "claude-sonnet-5-7", "name": "Claude Sonnet 5.7", "note": "Price unknown, enter it", "family": "Sonnet", "priced": False},
            {"id": "claude-sonnet-5-5", "name": "Sonnet 5.5", "note": "Input $2, output $10 per 1M tokens", "family": "Sonnet", "priced": True},
            {"id": "claude-opus-5-5", "name": "Opus 5.5", "note": "Input $4, output $20 per 1M tokens", "family": "Opus", "priced": True},
            {"id": "claude-opus-5", "name": "Opus 5", "note": "Input $5, output $25 per 1M tokens", "family": "Opus", "priced": True, "retired": True},
            # The agent's own model, which its provider stopped offering (CA-2): shown because the agent is on it.
            {"id": current, "name": "Sonnet 5", "note": "Input $2, output $10 per 1M tokens", "family": "Sonnet", "priced": True, "retired": True},
        ]
        world = {"listing": {"state": "unavailable", "checkedOn": "2026-11-11"}, "puts": [], "patches": [], "refreshed": 0}

        def choice(route: Route) -> None:
            group = {"connection": connection, "account": "api_key", "label": "Work Anthropic", "company": "Anthropic", "options": options, "listing": world["listing"]}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"current": {"connection": connection, "model": current}, "default": None, "groups": [group], "saved": True}))

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
        # The agent's own model was retired: it stays, as "no longer offered", with the line that the agent is paused. A retired model
        # that no agent is on ("Opus 5") is left out of the list.
        expect(model).to_contain_text("Sonnet 5 · no longer offered by Anthropic")
        expect(page.get_by_role("note").filter(has_text="Sonnet 5 is no longer offered by Anthropic. Planner is paused until you choose another model.")).to_be_visible()
        self.assertEqual(sorted(values(model)), sorted(["claude-sonnet-5-7", "claude-sonnet-5-5", "claude-opus-5-5", current]))
        box = open_select(model.first)
        expect(box.get_by_role("option", name="Sonnet 5 · no longer offered by Anthropic", exact=True)).to_have_attribute("aria-disabled", "true")
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
