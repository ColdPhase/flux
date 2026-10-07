"""Soft volume tokens and components (#338, final design F-026): one neutral palette in light, dark and
system, no accent colour, Geist bundled with the app, the drawn components and the task-state glyphs.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import json
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from contrast import MEASURE
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "soft volume everywhere"
EMAIL = f"ada.soft+{int(time.time() * 1000)}@example.test"
# The final design's tokens (docs/design/final/README.md §2).
LIGHT = {"--side": "#ebebed", "--bg": "#f4f4f5", "--el": "#ffffff", "--sub": "#ebebec", "--hov": "#e3e3e5",
         "--t1": "#18181b", "--t2": "#4a4a4a", "--t3": "#6b6b6b", "--inv": "#18181b", "--oninv": "#ffffff"}
DARK = {"--side": "#0b0b0b", "--bg": "#111111", "--el": "#1c1c1c", "--sub": "#242424", "--hov": "#2c2c2c",
        "--t1": "#f0f0f0", "--t2": "#acacac", "--t3": "#8c8c8c", "--inv": "#f0f0f0", "--oninv": "#111111"}
# The served CSS is minified (#ffffff becomes #fff), so values are compared as resolved colours.
TOKENS = """names => Object.fromEntries(names.map(n => { const i = document.createElement('i'); i.style.color = `var(${n})`;
  document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return [n, c]; }))"""
RGB = lambda value: f"rgb({int(value[1:3], 16)}, {int(value[3:5], 16)}, {int(value[5:7], 16)})"
STATES = {"open": "Open", "in_progress": "In progress", "blocked": "Blocked", "done": "Done", "not_pursued": "Not pursued"}


class SoftVolume(unittest.TestCase):
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

    def api(self, page: Page, method: str, path: str, body: dict) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body))
        self.assertEqual(response.status, 201, response.text())
        return json.loads(response.text())

    def ensure_account(self) -> None:
        if self.state:
            return
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Soft")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Garden sensors"})
        project = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Soil probes", "visibility": "restricted"})
        type(self).ids["project"] = project["id"]
        for status, word in STATES.items():
            body = {"title": f"{word} probe check", "status": status}
            if status == "blocked":
                body["blocker"] = "The supplier has no stock"
            self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", body)

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
        expect(page.get_by_role("radiogroup", name="Appearance")).to_be_visible()
        self.assertIsNone(page.evaluate("document.documentElement.getAttribute('data-accent')"))
        self.assertEqual(page.evaluate("['flux.accent', 'flux.accent.light', 'flux.accent.dark'].map(k => localStorage.getItem(k))"), [None, None, None])
        group = page.get_by_role("radiogroup", name="Appearance")
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
        page = self.page()
        fonts: list[str] = []
        page.on("request", lambda request: fonts.append(request.url) if request.resource_type == "font" else None)
        page.goto(f"/projects/{self.ids['project']}/tasks")
        expect(page.locator(".app")).to_be_visible()
        page.evaluate("document.fonts.ready")
        page.locator("body").evaluate("e => { const m = document.createElement('code'); m.textContent = '#12'; m.style.fontFamily = 'var(--mono)'; e.append(m); }")
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
        # The segmented control is a pill track.
        page.goto("/settings")
        self.assertEqual(page.locator(".seg").evaluate("e => getComputedStyle(e).borderTopLeftRadius"), "999px")

    def test_05_every_task_state_has_its_glyph_and_word_in_both_themes(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            for phone in (False,):
                with self.subTest(scheme=scheme, phone=phone):
                    page = self.page(scheme=scheme, phone=phone)
                    page.goto(f"/projects/{self.ids['project']}/tasks")
                    page.get_by_role("radio", name="List", exact=True).click()
                    for status, word in STATES.items():
                        row = page.locator(".ui-glyph--" + status).first
                        expect(row).to_be_visible()
                        # The word is on the same row: in the title (these titles carry it) or the group.
                        self.assertIn(word.lower(), row.evaluate("e => e.closest('li, a, button, [role=row]')?.textContent?.toLowerCase() ?? ''"))
                        minimum = 3
                        value = page.evaluate(MEASURE, {"selector": f".ui-glyph--{status}", "property": "color"})
                        self.assertGreaterEqual(value["ratio"], minimum, (scheme, status, value))
                    shot(page, f"338-task-glyphs-{'390' if phone else '1440'}-{scheme}")


if __name__ == "__main__":
    unittest.main()
