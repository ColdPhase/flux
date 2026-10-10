"""Browser tests for Settings → Appearance's text size and reduce-motion rows (#350, F-026 "Prostota" §2, §9).

On the computer the Appearance card holds Text size (Small, Default, Large), Reduce motion and Kreska's
small-moments switch. On the phone the text size follows the system and is a plain value, and Reduce
motion is not shown. Both choices are kept on this device, applied before the first render, and only
ever add reduction: a stored "off" never overrides the operating system's reduced-motion setting.

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application.
FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import os
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot as save_shot, start_forwarder
from touch_targets import has_minimum_touch_size

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

    def page(self, *, phone: bool = False, reduced_motion: str = "no-preference") -> Page:
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
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def root_font_size(self, page: Page) -> str:
        return page.evaluate("getComputedStyle(document.documentElement).fontSize")

    def script_duration_ms(self, page: Page) -> float:
        """The --dur-2 token the scripts read, in ms (browsers serialise 0ms as 0s and 180ms as .18s)."""
        return page.evaluate(
            "() => { const v = getComputedStyle(document.documentElement).getPropertyValue('--dur-2').trim();"
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

    # ---------------------------------------------------------------- text size, computer

    def test_01_text_size_on_the_computer_applies_and_persists(self) -> None:
        page = self.page()
        page.goto("/settings")
        size = page.get_by_role("radiogroup", name="Text size")
        expect(size).to_be_visible()
        self.assertEqual(size.get_by_role("radio").all_inner_texts(), ["Small", "Default", "Large"])
        expect(size.get_by_role("radio", name="Default")).to_be_checked()
        self.assertIsNone(page.evaluate("document.documentElement.dataset.textSize ?? null"), "Default is the unscaled root")
        self.assertEqual(self.root_font_size(page), "16px")
        shot(page, "settings-desktop-1440-text-size-default")

        size.get_by_role("radio", name="Large").click()
        self.assertEqual(page.evaluate("[document.documentElement.dataset.textSize, localStorage.getItem('flux.textSize')]"), ["large", "large"])
        self.assertEqual(self.root_font_size(page), "18px", "the rem tokens scale with the root size")
        page.reload()
        expect(page.get_by_role("radiogroup", name="Text size").get_by_role("radio", name="Large")).to_be_checked()
        self.assertEqual(page.evaluate("document.documentElement.dataset.textSize"), "large", "applied before the page renders")
        self.assertEqual(self.root_font_size(page), "18px")
        shot(page, "settings-desktop-1440-text-size-large")

        # Arrow keys move the choice and its focus: Large to Default, then Default to Small.
        size.get_by_role("radio", name="Large").press("ArrowLeft")
        expect(size.get_by_role("radio", name="Default")).to_be_checked()
        expect(size.get_by_role("radio", name="Default")).to_be_focused()
        self.assertIsNone(page.evaluate("localStorage.getItem('flux.textSize')"), "Default is the stored absence of a choice")
        self.assertEqual(self.root_font_size(page), "16px")
        size.get_by_role("radio", name="Default").press("ArrowLeft")
        expect(size.get_by_role("radio", name="Small")).to_be_checked()
        self.assertEqual(self.root_font_size(page), "15px")
        self.assertEqual(page.evaluate("localStorage.getItem('flux.textSize')"), "small")
        size.get_by_role("radio", name="Default").click()
        self.assertIsNone(page.evaluate("document.documentElement.dataset.textSize ?? null"))

    def test_02_phone_follows_the_system_text_size_and_has_no_control(self) -> None:
        phone = self.page(phone=True)
        # A stored Large choice (from the computer) must not scale the phone: the phone keeps the system size.
        # The init script stores it before the first render, so no reload races the first load's requests.
        phone.context.add_init_script("localStorage.setItem('flux.textSize', 'large')")
        phone.goto("/settings")
        self.assertEqual(self.root_font_size(phone), "16px")
        self.assertEqual(phone.get_by_role("radiogroup", name="Text size").count(), 0)
        row = phone.locator(".sset-row", has_text="Text size")
        expect(row).to_have_count(1)
        expect(row).to_contain_text("Follows your phone")
        self.assertFalse(row.evaluate("el => el.matches('a, button, input, [role=radio], [role=switch]')"), "a plain value row, not a control")
        self.assertGreaterEqual(row.evaluate("el => el.getBoundingClientRect().height"), 44, "the row is at least 44 px tall")
        self.assertEqual(phone.get_by_role("switch", name="Reduce motion").count(), 0, "Reduce motion is drawn for the computer only")
        shot(phone, "settings-phone-390-text-size-follows")

    # ---------------------------------------------------------------- reduce motion

    def test_03_reduce_motion_switch_turns_css_and_script_motion_off_and_persists(self) -> None:
        page = self.page()
        page.goto("/settings")
        switch = page.get_by_role("switch", name="Reduce motion")
        expect(switch).to_have_attribute("aria-checked", "false")
        self.assertIsNone(page.evaluate("document.documentElement.dataset.motion ?? null"))
        self.assertEqual(self.probe_animation_duration(page), "1.2s", "the system allows motion and the choice is off")
        self.assertGreater(self.script_duration_ms(page), 0, "the system allows motion and the choice is off")
        shot(page, "settings-desktop-1440-reduce-motion-off")

        switch.click()
        expect(switch).to_have_attribute("aria-checked", "true")
        self.assertEqual(page.evaluate("[document.documentElement.dataset.motion, localStorage.getItem('flux.reduceMotion')]"), ["reduce", "on"])
        self.assertEqual(self.probe_animation_duration(page), "0s", "CSS motion stops at once")
        self.assertEqual(self.script_duration_ms(page), 0, "script motion reads 0 ms")
        page.reload()
        expect(page.get_by_role("switch", name="Reduce motion")).to_have_attribute("aria-checked", "true")
        self.assertEqual(page.evaluate("document.documentElement.dataset.motion"), "reduce", "applied before the page renders")
        self.assertEqual(self.probe_animation_duration(page), "0s")
        shot(page, "settings-desktop-1440-reduce-motion-on")

        page.get_by_role("switch", name="Reduce motion").press("Space")
        expect(page.get_by_role("switch", name="Reduce motion")).to_have_attribute("aria-checked", "false")
        self.assertIsNone(page.evaluate("localStorage.getItem('flux.reduceMotion')"))
        self.assertEqual(self.probe_animation_duration(page), "1.2s")

    def test_04_stored_off_never_overrides_the_system_reduced_motion_setting(self) -> None:
        page = self.page(reduced_motion="reduce")
        page.goto("/settings")
        expect(page.get_by_role("switch", name="Reduce motion")).to_have_attribute("aria-checked", "false")
        self.assertIsNone(page.evaluate("localStorage.getItem('flux.reduceMotion')"), "the choice stays off")
        self.assertEqual(self.probe_animation_duration(page), "0s", "the operating system still reduces motion")
        self.assertEqual(self.script_duration_ms(page), 0, "the system setting still reads 0 ms")
        shot(page, "settings-desktop-1440-reduce-motion-system")

    def test_05_reduce_motion_is_not_shown_on_the_phone(self) -> None:
        page = self.page(phone=True)
        page.goto("/settings")
        expect(page.get_by_role("radiogroup", name="Theme")).to_be_visible()
        self.assertEqual(page.get_by_role("switch", name="Reduce motion").count(), 0)
        self.assertEqual(page.get_by_text("Reduce motion").count(), 0)


if __name__ == "__main__":
    unittest.main()
