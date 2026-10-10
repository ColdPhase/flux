"""Soft volume tokens and components (#338, final design F-026): one neutral palette in light, dark and
system, no accent colour, Geist bundled with the app, the drawn components and the task-state glyphs.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import json
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from contrast import MEASURE
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, open_details, shot, start_forwarder

PASSWORD = "soft volume everywhere"
# The final design's tokens (docs/design/final/README.md §2).
LIGHT = {"--side": "#ebebed", "--bg": "#f4f4f5", "--el": "#ffffff", "--sub": "#ebebec", "--hov": "#e3e3e5",
         "--t1": "#18181b", "--t2": "#4a4a4a", "--t3": "#6b6b6b", "--inv": "#18181b", "--oninv": "#ffffff"}
DARK = {"--side": "#0b0b0b", "--bg": "#111111", "--el": "#1c1c1c", "--sub": "#242424", "--hov": "#2c2c2c",
        "--t1": "#f0f0f0", "--t2": "#bdbdbd", "--t3": "#a1a1a1", "--inv": "#f0f0f0", "--oninv": "#111111"}
# The served CSS is minified (#ffffff becomes #fff), so values are compared as resolved colours.
TOKENS = """names => Object.fromEntries(names.map(n => { const i = document.createElement('i'); i.style.color = `var(${n})`;
  document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return [n, c]; }))"""
RGB = lambda value: f"rgb({int(value[1:3], 16)}, {int(value[3:5], 16)}, {int(value[5:7], 16)})"
STATES = {"open": "Open", "in_progress": "In progress", "blocked": "Blocked", "done": "Done", "not_pursued": "Not pursued"}
TITLES = {"open": "Calibrate the topsoil probe", "in_progress": "Check the calibration batch",
          "blocked": "Await the battery shipment", "done": "Measure ambient light",
          "not_pursued": "Order the spare enclosure"}


class SoftVolume(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}
    engine = "chromium"

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, cls.engine).launch()
        cls.email = f"ada.soft+{uuid.uuid4()}@example.test"
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool = False, scheme: str = "light", reduced: bool = False, init: str | None = None) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "reduced_motion": "reduce" if reduced else "no-preference"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        if init:
            context.add_init_script(init)
        self.addCleanup(context.close)
        return context.new_page()

    def api(self, page: Page, method: str, path: str, body: dict, *, status: int = 201) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body))
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text())

    def assert_mono(self, node) -> None:
        family = node.evaluate("e => getComputedStyle(e).fontFamily")
        # CSSOM may serialize a family containing spaces with or without quotes.
        self.assertEqual(family.split(",")[0].strip(" \"'"), "Geist Mono", family)

    def ensure_account(self) -> None:
        if self.state:
            return
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Soft")
        page.get_by_label("Email").fill(self.email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Garden sensors"})
        project = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Soil probes", "visibility": "restricted"})
        type(self).ids["project"] = project["id"]
        type(self).ids["workspace"] = workspace["id"]
        for status in STATES:
            body = {"title": TITLES[status], "status": status}
            if status == "blocked":
                body["blocker"] = "The supplier has no stock"
            task = self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", body)
            type(self).ids[status] = task["id"]
        parked = self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Compare the replacement enclosure"})
        previous = self.api(page, "POST", f"/api/v1/projects/{project['id']}/decisions", {"title": "Use the original enclosure"})
        self.api(page, "POST", f"/api/v1/decisions/{previous['id']}/accept", {"expectedVersion": 1}, status=200)
        pivot = self.api(page, "POST", f"/api/v1/projects/{project['id']}/decisions",
                         {"title": "Keep the measured enclosure", "supersedes": previous["id"], "affects": [parked["id"]]})
        self.api(page, "POST", f"/api/v1/decisions/{pivot['id']}/accept", {"expectedVersion": 1, "park": [parked["id"]]}, status=200)
        type(self).ids["parked"] = parked["id"]
        preview = self.api(page, "POST", f"/api/v1/projects/{project['id']}/decisions",
                           {"title": "Compare the next enclosure batch", "supersedes": pivot["id"]})
        type(self).ids["pivot_preview"] = preview["id"]
        upload = page.request.post(f"/api/v1/projects/{project['id']}/files?uploadId={uuid.uuid4()}&name=calibration.csv",
                                   data=b"lux,temperature\n5,21\n", headers={"origin": ORIGIN, "content-type": "application/octet-stream"})
        self.assertEqual(upload.status, 201, upload.text())
        conversation = self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations",
                                {"body": "The calibration readings are attached. Compare them before ordering a replacement.",
                                 "attachmentIds": [upload.json()["id"]], "clientMessageId": str(uuid.uuid4())})
        type(self).ids["conversation"] = conversation["id"]

    def ensure_dm(self) -> None:
        self.ensure_account()
        if "dm" in self.ids:
            return
        other = self.browser.new_context(base_url=ORIGIN)
        try:
            email = f"ben.soft+{uuid.uuid4()}@example.test"
            signup = other.request.post("/api/auth/sign-up/email", data={"name": "Ben Reviewer", "email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
            self.assertEqual(signup.status, 200, signup.text())
            person = other.request.get("/api/v1/me").json()["user"]["id"]
            page = self.page()
            self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/members", {"email": email, "role": "member"})
            dm = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/dms", {"participantIds": [person]})
            self.api(page, "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": "Compare the readings before our next delivery.", "clientMessageId": str(uuid.uuid4())})
            type(self).ids["dm"] = dm["id"]
        finally:
            other.close()

    def test_01_light_dark_and_system_use_the_final_tokens(self) -> None:
        self.ensure_account()
        for scheme, stored, expected in (("light", None, LIGHT), ("dark", None, DARK), ("light", "dark", DARK), ("dark", "light", LIGHT)):
            with self.subTest(scheme=scheme, stored=stored):
                page = self.page(scheme=scheme, init=f"localStorage.setItem('flux.theme', '{stored}')" if stored else None)
                page.goto("/")
                expect(page.locator(".app")).to_be_visible()
                self.assertEqual(page.evaluate(TOKENS, list(expected)), {name: RGB(value) for name, value in expected.items()})
                # The outer background is --side and the panel on it --bg.
                self.assertEqual(page.evaluate("getComputedStyle(document.body).backgroundColor"), RGB(expected["--side"]))
                self.assertEqual(page.locator(".app__main").evaluate("e => getComputedStyle(e).backgroundColor"), RGB(expected["--bg"]))

    def test_02_there_is_no_accent_colour_and_old_choices_are_forgotten(self) -> None:
        self.ensure_account()
        page = self.page(init="localStorage.setItem('flux.accent.light', 'copper'); localStorage.setItem('flux.accent.dark', 'sky'); localStorage.setItem('flux.accent', 'iris')")
        page.goto("/settings")
        expect(page.get_by_role("radiogroup", name="Theme")).to_be_visible()
        self.assertIsNone(page.evaluate("document.documentElement.getAttribute('data-accent')"))
        self.assertEqual(page.evaluate("['flux.accent', 'flux.accent.light', 'flux.accent.dark'].map(k => localStorage.getItem(k))"), [None, None, None])
        group = page.get_by_role("radiogroup", name="Theme")
        self.assertEqual([radio.inner_text().strip() for radio in group.get_by_role("radio").all()], ["Light", "Dark", "Match system"])
        expect(page.get_by_text("Accent", exact=True)).to_have_count(0)
        # No stylesheet defines or uses an accent token.
        used = page.evaluate("""() => [...document.styleSheets].flatMap(s => { try { return [...s.cssRules].map(r => r.cssText); } catch { return []; } })
          .filter(t => /--accent|data-accent|--bg-chrome|--text-[23]|--action\\b/.test(t)).slice(0, 5)""")
        self.assertEqual(used, [])
        # Keyboard: arrows move the choice.
        group.get_by_role("radio", name="Match system").focus()
        page.keyboard.press("ArrowLeft")
        expect(group.get_by_role("radio", name="Dark")).to_be_focused()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")
        page.keyboard.press("ArrowRight")
        self.assertIsNone(page.evaluate("document.documentElement.dataset.theme ?? null"))

    def test_03_geist_is_served_by_flux_and_used_for_text_and_numbers(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            for phone in (False, True):
                with self.subTest(scheme=scheme, phone=phone):
                    page = self.page(scheme=scheme, phone=phone)
                    fonts: list[str] = []
                    page.on("request", lambda request: fonts.append(request.url) if request.resource_type == "font" else None)
                    page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
                    replies = page.get_by_role("complementary", name="Replies")
                    timestamp = replies.locator(".thread__root-meta time")
                    filename = replies.locator(".message-files a span").first
                    expect(timestamp).to_be_visible()
                    expect(filename).to_have_text("calibration.csv")
                    for node in (timestamp, filename):
                        self.assert_mono(node)
                    # Exercise the actual upload draft, not an injected font demonstration.
                    with page.expect_file_chooser() as chooser:
                        replies.get_by_role("button", name="Attach files", exact=True).click()
                    chooser.value.set_files({"name": "delivery.csv", "mimeType": "text/csv", "buffer": b"batch,count\nnext,4\n"})
                    draft = replies.locator(".composer-files__name")
                    expect(draft).to_contain_text("delivery.csv")
                    expect(draft).to_contain_text("Ready, private")
                    self.assert_mono(draft)
                    page.evaluate("document.fonts.ready")
                    shot(page, f"338-{self.engine}-files-{'390' if phone else '1440'}-{scheme}")
                    page.goto(f"/projects/{self.ids['project']}/tasks")
                    page.get_by_role("radio", name="List", exact=True).click()
                    counter = page.locator(".ws-view__n").first
                    expect(counter).to_be_visible()
                    self.assert_mono(counter)
                    page.wait_for_function("() => ['Geist', 'Geist Mono'].every(name => [...document.fonts].some(f => f.family.replace(/\"/g, '') === name && f.status === 'loaded'))")
                    self.assertTrue(page.evaluate("getComputedStyle(document.body).fontFamily").startswith('Geist'))
                    self.assertTrue(fonts, "the fonts are requested")
                    self.assertTrue(all(url.startswith(ORIGIN) for url in fonts), f"no third-party font host: {fonts}")

    def test_04_components_have_the_drawn_shape_and_press(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        primary = page.locator(".ui-btn--primary").first
        expect(primary).to_be_visible()
        style = primary.evaluate("e => { const s = getComputedStyle(e); return [s.borderTopLeftRadius, s.backgroundImage.startsWith('linear-gradient'), s.boxShadow !== 'none']; }")
        self.assertEqual(style[1:], [True, True], "the primary button is the inverted gradient with volume")
        self.assertGreaterEqual(float(style[0].rstrip("px")), 17, "buttons are pills")
        self.assertEqual(page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--press').trim()"), ".97")
        calm = self.page(reduced=True)
        calm.goto("/")
        self.assertEqual(calm.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--press').trim()"), "1")
        # The segmented control (the account menu's theme choice) is a pill track.
        page.goto("/")
        page.locator(".me__btn").click()
        self.assertEqual(page.get_by_role("dialog", name="Account").locator(".seg").evaluate("e => getComputedStyle(e).borderTopLeftRadius"), "999px")

    def test_05_every_task_state_has_its_glyph_and_word_in_both_themes(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            for phone in (False, True):
                with self.subTest(scheme=scheme, phone=phone):
                    page = self.page(scheme=scheme, phone=phone)
                    page.goto(f"/projects/{self.ids['project']}/tasks")
                    page.get_by_role("radio", name="List", exact=True).click()
                    for status, word in STATES.items():
                        task = page.locator(f"li[data-work-id='{self.ids[status]}']")
                        row = task.locator(".ui-glyph--" + status)
                        expect(row).to_be_visible()
                        # Normal task titles contain no state. Require the row's own secondary label.
                        self.assertIn(word, task.locator(".ws-item__s").inner_text().split(" · "))
                        minimum = 3
                        value = page.evaluate(MEASURE, {"selector": f".ui-glyph--{status}", "property": "color"})
                        self.assertGreaterEqual(value["ratio"], minimum, (scheme, status, value))
                    shot(page, f"338-{self.engine}-task-glyphs-{'390' if phone else '1440'}-{scheme}")
                    parked = page.locator(f"li[data-work-id='{self.ids['parked']}']")
                    parked.scroll_into_view_if_needed()
                    expect(parked.locator(".ws-item__s")).to_contain_text("Parked · was open")
                    value = page.evaluate(MEASURE, {"selector": ".ui-glyph--open.ui-glyph--parked"})
                    self.assertGreaterEqual(value["ratio"], 3, (scheme, phone, value))
                    shot(page, f"338-{self.engine}-task-parked-{'390' if phone else '1440'}-{scheme}")

    def test_06_own_dm_initials_and_real_shortcuts_are_readable(self) -> None:
        self.ensure_dm()
        for scheme in ("light", "dark"):
            for phone in (False, True):
                with self.subTest(scheme=scheme, phone=phone):
                    page = self.page(scheme=scheme, phone=phone)
                    page.goto(f"/dm/{self.ids['dm']}")
                    expect(page.locator(".dm-msg__meta time").first).to_be_visible()
                    self.assert_mono(page.locator(".dm-msg__meta time").first)
                    open_details(page)
                    page.wait_for_timeout(400)  # the panel finishes fading in before contrast is measured
                    avatar = page.locator(".details__person .ui-avatar--me")
                    expect(avatar).to_have_text("AS")
                    page.wait_for_function("""() => { const el = document.querySelector('.details__person .ui-avatar--me');
                      if (!el) return false; for (let n = el; n; n = n.parentElement) {
                        if (Number(getComputedStyle(n).opacity) !== 1) return false; } return true; }""")
                    value = page.evaluate(MEASURE, {"selector": ".details__person .ui-avatar--me"})
                    self.assertGreaterEqual(value["ratio"], 4.5, (scheme, phone, value))
                    shortcut = page.locator(".details__keys kbd").first
                    expect(shortcut).to_be_visible()
                    self.assert_mono(shortcut)
                    shot(page, f"338-{self.engine}-dm-details-{'390' if phone else '1440'}-{scheme}")

    def test_07_details_title_scales_with_200_percent_text(self) -> None:
        self.ensure_account()
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['done']}")
                title = page.locator(".wd .details__title").first
                expect(title).to_have_text(TITLES["done"])
                before = title.evaluate("e => parseFloat(getComputedStyle(e).fontSize)")
                page.evaluate("document.documentElement.style.fontSize = '200%'")
                page.wait_for_function("""before => {
                  const title = document.querySelector('.wd .details__title');
                  return title && parseFloat(getComputedStyle(title).fontSize) >= before * 1.99;
                }""", arg=before)
                bounds = title.bounding_box()
                self.assertLessEqual(bounds["x"] + bounds["width"], page.viewport_size["width"] + 1)
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.viewport_size["width"])
                shot(page, f"338-{self.engine}-title-200-{'390' if phone else '1440'}")

    def test_08_native_radio_selection_and_keyboard_focus_are_neutral(self) -> None:
        self.ensure_account()
        for scheme, tokens in (("light", LIGHT), ("dark", DARK)):
            for phone in (False, True):
                with self.subTest(scheme=scheme, phone=phone):
                    page = self.page(scheme=scheme, phone=phone)
                    page.goto(f"/projects/{self.ids['project']}/tasks?open=decision:{self.ids['pivot_preview']}")
                    group = page.locator(".wd-pivot__row").first
                    selected = group.get_by_role("radio", name="Still applies", exact=True)
                    selected.check()
                    expect(selected).to_be_checked()
                    self.assertEqual(selected.evaluate("e => getComputedStyle(e).accentColor"), RGB(tokens["--t1"]))
                    # Native keyboard movement changes the actual choice, with the shared neutral focus ring.
                    selected.press("ArrowRight")
                    parked = group.get_by_role("radio", name="Park", exact=True)
                    expect(parked).to_be_checked()
                    expect(parked).to_be_focused()
                    # Reach the selected radio by Tab, rather than carrying the earlier pointer focus.
                    page.keyboard.press("Tab")
                    page.keyboard.press("Shift+Tab")
                    expect(parked).to_be_focused()
                    self.assertEqual(parked.evaluate("e => e.matches(':focus-visible')"), True)
                    ring = parked.evaluate("e => { const s = getComputedStyle(e); return [s.outlineColor, s.outlineStyle, s.outlineWidth]; }")
                    self.assertEqual(ring, [RGB(tokens["--t1"]), "solid", "2px"])
                    value = page.evaluate(MEASURE, {"selector": ".wd-pivot__c input:checked", "property": "accentColor"})
                    self.assertGreaterEqual(value["ratio"], 3, (scheme, phone, value))
                    shot(page, f"338-{self.engine}-pivot-radio-{'390' if phone else '1440'}-{scheme}")


class SoftVolumeWebKit(SoftVolume):
    engine = "webkit"
    state: dict = {}
    ids: dict = {}


if __name__ == "__main__":
    unittest.main()
