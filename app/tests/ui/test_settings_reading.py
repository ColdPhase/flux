"""Browser tests for Settings → Appearance and the system's text size and reduced motion (#350; #1419 item 17, F-026 "Prostota" §2, §9).

Appearance holds Theme and the face switch, on the computer and on the phone: no Text size and no Reduce motion. The app follows the
system instead: the type tokens are rem, so the root font size the browser or the phone sets scales the text, and the CSS and the
scripts follow the system's reduced-motion setting. A value stored by the earlier switches (`flux.textSize`, `flux.reduceMotion`) does nothing.

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application.
FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import os
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot as save_shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "reading and motion stay yours"
STAMP = int(time.time() * 1000)
NAME, EMAIL = "Ada Kowalska", f"ada.reading+{STAMP}@example.test"
# A probe with a real keyframe from the app's own stylesheet (ui.css), so the test measures the
# app's override rather than a value it sets itself.
PROBE = "kreska-dot 1.2s ease-in-out infinite"


def shot(page: Page, name: str) -> None:
    save_shot(page, f"{name}-{UI_BROWSER}")


class ReadingAndMotion(unittest.TestCase):
    pw = None
    browser: Browser
    state: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        context = cls.browser.new_context(base_url=ORIGIN)
        response = context.request.post("/api/auth/sign-up/email", data={"email": EMAIL, "password": PASSWORD, "name": NAME}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        space = context.request.post("/api/v1/workspaces", data={"name": "Riverside Makers"}, headers={"origin": ORIGIN})
        assert space.status == 201, space.text()
        cls.state = context.storage_state()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool = False, reduced_motion: str = "no-preference") -> BrowserContext:
        """One browser profile: its pages share localStorage, so a choice in one tab reaches the others."""
        options: dict = {
            "base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
            "storage_state": self.state, "reduced_motion": reduced_motion,
        }
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context: BrowserContext = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def watch(self, page: Page) -> Page:
        """Fails the test when the page raises an uncaught error."""
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def page(self, *, phone: bool = False, reduced_motion: str = "no-preference") -> Page:
        return self.watch(self.context(phone=phone, reduced_motion=reduced_motion).new_page())

    def start_live_probe(self, page: Page) -> None:
        """Leaves a probe running in the page with the app's real keyframe, as a looping mark would."""
        page.evaluate(
            """(css) => {
              const probe = document.createElement('span');
              probe.id = 'motion-probe-live';
              probe.style.animation = css;
              document.body.appendChild(probe);
            }""",
            PROBE,
        )

    def live_probe(self, page: Page) -> dict:
        """The probe's computed duration and iteration count, and how many of its animations still run."""
        return page.evaluate(
            """() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
              const probe = document.getElementById('motion-probe-live');
              const style = getComputedStyle(probe);
              resolve({
                duration: style.animationDuration,
                iterations: style.animationIterationCount,
                running: probe.getAnimations().filter((animation) => animation.playState === 'running').length,
              });
            })))"""
        )

    def root_font_size(self, page: Page) -> str:
        return page.evaluate("getComputedStyle(document.documentElement).fontSize")

    def script_duration_ms(self, page: Page) -> float:
        """The --dur-in token the scripts read, in ms (browsers serialise 0ms as 0s and 180ms as .18s)."""
        return page.evaluate(
            "() => { const v = getComputedStyle(document.documentElement).getPropertyValue('--dur-in').trim();"
            " return v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000; }"
        )

    def probe_animation_duration(self, page: Page) -> str:
        """The computed duration of a real keyframe animation; 0s means the app turned motion off."""
        return page.evaluate(
            """(css) => {
              const probe = document.createElement('span');
              probe.id = 'motion-probe';
              probe.style.animation = css;
              document.body.appendChild(probe);
              const value = getComputedStyle(probe).animationDuration;
              probe.remove();
              return value;
            }""",
            PROBE,
        )

    # ---------------------------------------------------------------- what Appearance holds

    def test_01_appearance_has_the_theme_and_the_face_switch_only(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                page.goto("/settings/appearance")
                expect(page.get_by_role("radiogroup", name="Theme")).to_be_visible()
                expect(page.get_by_role("switch", name="Show the face on loading and empty screens")).to_be_visible()
                self.assertEqual(page.get_by_role("switch").count(), 1, "the face switch is the only switch")
                self.assertEqual(page.get_by_role("radiogroup").count(), 1, "Theme is the only choice")
                self.assertEqual(page.get_by_text("Text size").count(), 0)
                self.assertEqual(page.get_by_text("Reduce motion").count(), 0)
                self.assertEqual(page.get_by_text("one neutral palette", exact=False).count(), 0, "no sentence that explains the palette")
                shot(page, f"settings-appearance-{'phone-390' if phone else 'desktop-1440'}")

    # ---------------------------------------------------------------- text size follows the system

    def test_02_the_text_follows_the_systems_text_size(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                page.goto("/")
                self.assertEqual(self.root_font_size(page), "16px", "Flux sets no root size of its own")
                body = "parseFloat(getComputedStyle(document.body).fontSize)"
                normal = page.evaluate(body)
                # The system's text size is the root font size: the rem tokens scale with it, on the computer as on the phone.
                page.evaluate("document.documentElement.style.fontSize = '125%'")
                self.assertAlmostEqual(page.evaluate(body), normal * 1.25, delta=0.05, msg="the text grows with the system's size")
                page.evaluate("document.documentElement.style.removeProperty('font-size')")

    def test_03_a_text_size_stored_by_the_old_choice_does_nothing(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                page.context.add_init_script("localStorage.setItem('flux.textSize', 'large')")
                page.goto("/settings/appearance")
                self.assertEqual(self.root_font_size(page), "16px")
                self.assertIsNone(page.evaluate("document.documentElement.dataset.textSize ?? null"))

    # ---------------------------------------------------------------- motion follows the system

    def test_04_motion_runs_when_the_system_allows_it_and_stops_when_it_asks(self) -> None:
        allowed = self.page()
        allowed.goto("/settings")
        self.assertEqual(self.probe_animation_duration(allowed), "1.2s", "the system allows motion")
        self.assertGreater(self.script_duration_ms(allowed), 0, "script motion runs")
        shot(allowed, "settings-desktop-1440-motion-allowed")
        for phone in (False, True):
            with self.subTest(phone=phone):
                reduced = self.page(phone=phone, reduced_motion="reduce")
                reduced.goto("/settings")
                self.assertEqual(self.probe_animation_duration(reduced), "0s", "CSS motion stops under the system's setting")
                self.assertEqual(self.script_duration_ms(reduced), 0, "script motion reads 0 ms")

    def test_05_a_choice_stored_by_the_old_reduce_motion_switch_does_nothing(self) -> None:
        page = self.page()
        page.context.add_init_script("localStorage.setItem('flux.reduceMotion', 'on')")
        page.goto("/settings")
        self.assertIsNone(page.evaluate("document.documentElement.dataset.motion ?? null"))
        self.assertEqual(self.probe_animation_duration(page), "1.2s", "the system allows motion, and nothing else decides")
        self.assertGreater(self.script_duration_ms(page), 0)

    def test_06_a_change_of_the_systems_setting_reaches_an_open_page(self) -> None:
        page = self.page()
        page.goto("/")
        self.start_live_probe(page)
        self.assertEqual(self.live_probe(page)["duration"], "1.2s")
        page.emulate_media(reduced_motion="reduce")
        live = self.live_probe(page)
        self.assertEqual(live["duration"], "0s", "the running animation stops at once")
        self.assertEqual(live["running"], 0)
        self.assertEqual(self.script_duration_ms(page), 0)
        page.emulate_media(reduced_motion="no-preference")
        self.assertEqual(self.live_probe(page)["duration"], "1.2s", "motion returns with the setting")


if __name__ == "__main__":
    unittest.main()
