"""The edges of the app follow the theme on a phone (#1544, founder report 2026-11-19: a white strip under the app in dark mode).

An installed Android app paints the strip under the page (its navigation bar) from the web app manifest's colours, which cannot follow the
theme by themselves: the dark theme links the dark manifest (`/manifest-dark.webmanifest`, `#111111`), the light theme the light one. This
module checks, in Chromium on a touch phone:

- the page links the manifest of the theme it shows, from the first load (the system's dark mode, a stored choice that differs from the
  system) and when the theme changes while the page is open;
- both manifests are the same app in the two sets of colours, and `theme-color` follows the page background (the status bar);
- with a bottom safe area of 34 px (a home indicator), nothing the page paints at the bottom edge is light in dark mode: Spaces, the Create
  sheet and the Assistant's page, so a light strip cannot come from Flux itself.

The strip the system draws outside the window cannot be rendered here; the manifest is what Chrome reads for it (reviewed on a device by the
founder). Runs through scripts/check_ui.sh; FLUX_UI_BROWSER selects the engine (the inset is simulated in Chromium only).
"""

from __future__ import annotations

import time
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from phone_audit import window
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "dark edges all around"
STAMP = uuid.uuid4().hex[:8]
EMAIL = f"edges.{STAMP}+{int(time.time() * 1000)}@example.test"
DARK_PAGE = "#111111"

# What the page paints in the last pixel row of the window, composited from the top element down to the first opaque background.
BOTTOM_EDGE = r"""() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  const rgba = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); const p = ctx.getImageData(0, 0, 1, 1).data; return [p[0], p[1], p[2], p[3] / 255]; };
  const luminance = (p) => (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
  const out = [];
  for (const x of [3, Math.round(innerWidth / 2), innerWidth - 4]) {
    let colour = [0, 0, 0, 0];
    for (const el of document.elementsFromPoint(x, innerHeight - 1)) {
      const own = rgba(getComputedStyle(el).backgroundColor);
      if (own[3] === 0) continue;
      const a = colour[3] + own[3] * (1 - colour[3]);
      colour = [0, 1, 2].map((i) => (colour[i] * colour[3] + own[i] * own[3] * (1 - colour[3])) / a).concat(a);
      if (colour[3] >= 0.99) break;
    }
    out.push({ x, painted: colour[3] > 0, luminance: luminance(colour) });
  }
  return out;
}"""


class DarkEdges(unittest.TestCase):
    pw = None
    browser = None
    state: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        maker = cls.browser.new_context(base_url=ORIGIN)
        made = maker.request.post("/api/auth/sign-up/email", data={"email": EMAIL, "password": PASSWORD, "name": "Edith Edge"}, headers={"origin": ORIGIN})
        assert made.status == 200, made.text()
        workspace = maker.request.post("/api/v1/workspaces", data={"name": "Riverside Makers"}, headers={"origin": ORIGIN})
        assert workspace.status in (200, 201), workspace.text()
        project = maker.request.post(f"/api/v1/workspaces/{workspace.json()['id']}/projects", data={"name": "Community garden sensors", "visibility": "workspace"}, headers={"origin": ORIGIN})
        assert project.status in (200, 201), project.text()
        cls.state = maker.storage_state()
        maker.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def phone(self, *, dark: bool):
        context = window(self.pw, self.browser, UI_BROWSER, ORIGIN, self.state, 390, 844, dark=dark)
        self.addCleanup(context.close)
        return context

    def linked(self, page: Page) -> str:
        return page.locator('link[rel="manifest"]').get_attribute("href")

    def test_01_the_dark_theme_links_the_dark_manifest_and_the_light_theme_the_light_one(self) -> None:
        dark = self.phone(dark=True).new_page()
        dark.goto("/")
        expect(dark.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.assertEqual(self.linked(dark), "/manifest-dark.webmanifest")
        light = self.phone(dark=False).new_page()
        light.goto("/")
        expect(light.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.assertEqual(self.linked(light), "/manifest.webmanifest")

    def test_02_a_stored_theme_that_differs_from_the_system_decides(self) -> None:
        # The system is dark, the person chose light in Settings: the light manifest. And the other way round.
        context = self.phone(dark=True)
        context.add_init_script("localStorage.setItem('flux.theme', 'light')")
        page = context.new_page()
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.assertEqual(self.linked(page), "/manifest.webmanifest")
        context = self.phone(dark=False)
        context.add_init_script("localStorage.setItem('flux.theme', 'dark')")
        page = context.new_page()
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.assertEqual(self.linked(page), "/manifest-dark.webmanifest")

    def test_03_the_link_and_the_status_bar_follow_a_theme_that_changes_while_the_page_is_open(self) -> None:
        page = self.phone(dark=False).new_page()
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.assertEqual(self.linked(page), "/manifest.webmanifest")
        page.emulate_media(color_scheme="dark")
        expect(page.locator('link[rel="manifest"]')).to_have_attribute("href", "/manifest-dark.webmanifest")
        colours = page.evaluate("[...document.querySelectorAll('meta[name=\"theme-color\"]')].map((meta) => meta.content)")
        self.assertTrue(colours and all(colour in (DARK_PAGE, "#111") for colour in colours), colours)
        page.emulate_media(color_scheme="light")
        expect(page.locator('link[rel="manifest"]')).to_have_attribute("href", "/manifest.webmanifest")

    def test_04_both_manifests_are_the_same_app_in_the_two_sets_of_colours(self) -> None:
        page = self.phone(dark=True).new_page()
        light = page.request.get(f"{ORIGIN}/manifest.webmanifest").json()
        dark = page.request.get(f"{ORIGIN}/manifest-dark.webmanifest").json()
        self.assertEqual((light["theme_color"], light["background_color"]), ("#F4F4F5", "#F4F4F5"))
        self.assertEqual((dark["theme_color"], dark["background_color"]), ("#111111", "#111111"))
        for key in set(light) - {"theme_color", "background_color"}:
            self.assertEqual(light[key], dark[key], key)

    def test_05_nothing_flux_paints_at_the_bottom_edge_is_light_in_the_dark_theme(self) -> None:
        if UI_BROWSER != "chromium":
            self.skipTest("only Chromium can simulate a bottom safe area (setSafeAreaInsetsOverride)")
        page = self.phone(dark=True).new_page()
        session = page.context.new_cdp_session(page)
        session.send("Emulation.setSafeAreaInsetsOverride", {"insets": {"top": 0, "left": 0, "bottom": 34, "right": 0}})
        page.goto("/projects")
        expect(page.get_by_role("heading", level=1, name="Spaces")).to_be_visible()
        self.assertEqual(page.evaluate("(() => { const p = document.createElement('div'); p.style.cssText = 'position:fixed;padding-bottom:env(safe-area-inset-bottom)'; document.body.append(p); const v = parseFloat(getComputedStyle(p).paddingBottom); p.remove(); return v; })()"), 34)
        self.assert_dark_edge(page, "Spaces")
        shot(page, "dark-edges-spaces-phone")
        page.get_by_role("button", name="Create", exact=True).click()
        expect(page.get_by_role("dialog")).to_be_visible()
        page.wait_for_timeout(400)
        self.assert_dark_edge(page, "the Create sheet")
        shot(page, "dark-edges-create-phone")

    def test_06_the_phones_page_is_the_whole_screen_with_no_frame_in_either_theme(self) -> None:
        for dark in (True, False):
            page = self.phone(dark=dark).new_page()
            page.goto("/projects")
            expect(page.get_by_role("heading", level=1, name="Spaces")).to_be_visible()
            main = page.evaluate("(() => { const m = document.querySelector('.app__main'); const s = getComputedStyle(m); const r = m.getBoundingClientRect(); return { shadow: s.boxShadow, radius: s.borderTopLeftRadius, left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom, app: getComputedStyle(document.querySelector('.app')).backgroundColor, page: getComputedStyle(m).backgroundColor }; })()")
            self.assertEqual(main["shadow"], "none", f"dark={dark}: an inset hairline frames the phone's screen: {main}")
            self.assertEqual((main["radius"], main["left"], main["top"], main["right"], main["bottom"]), ("0px", 0, 0, 0, 0), main)
            self.assertEqual(main["app"], main["page"], f"dark={dark}: the sidebar's colour shows around the page: {main}")
            shot(page, f"1544-phone-spaces-{'dark' if dark else 'light'}-390")

    def assert_dark_edge(self, page: Page, where: str) -> None:
        for edge in page.evaluate(BOTTOM_EDGE):
            self.assertTrue(edge["painted"], f"{where}: nothing paints the bottom edge at x={edge['x']}")
            self.assertLess(edge["luminance"], 0.2, f"{where}: a light strip at the bottom edge, x={edge['x']}: {edge}")


if __name__ == "__main__":
    unittest.main()
