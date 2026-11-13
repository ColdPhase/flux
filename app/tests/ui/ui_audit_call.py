"""The call screens of the v0.2.1 UI audit (#1215, #1245): the strip, the live bar elsewhere, Audio settings, Here now, a shared screen
on a phone and the call notice, at the audit's windows, light and dark.

Not part of the default suite (the name does not match test_*.py). It needs the live stack (the pinned self-hosted SFU), so it runs
through `FLUX_LIVE_UI_PATTERN=ui_audit_call.py FLUX_UI_SCREENSHOT_DIR=<dir> scripts/check_live_ui.sh` or on GitHub Actions with
`scripts/ci_test.sh <ref> live chromium ui_audit_call` (screenshots as the run's artifact). Chromium only: the live suite has no
WebKit lane, so the WebKit call screens stay unverified there. Each test captures what it reaches and asserts only that the call's
parts are there; geometry is measured by the #763 measurement (`visual_consistency_audit.MEASURE_JS`), written beside each
screenshot as `<name>.json`.
"""
from __future__ import annotations

import json
import os
import re
import unittest
from pathlib import Path

from playwright.sync_api import Page, expect

import visual_consistency_audit as vca
from test_live_sessions import LIVE, LiveBase

OUT = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots")) / "ui-audit-call"
WINDOWS = {"1440": {"width": 1440, "height": 900}, "820p": {"width": 820, "height": 1180}, "390": {"width": 390, "height": 844}, "320": {"width": 320, "height": 640}}


@unittest.skipUnless(LIVE, "set FLUX_UI_LIVE=1 (scripts/check_live_ui.sh)")
class CallScreens(LiveBase):
    def capture(self, page: Page, name: str) -> None:
        OUT.mkdir(parents=True, exist_ok=True)
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / f"{name}.png"), animations="disabled", caret="hide")
        found = page.evaluate(vca.MEASURE_JS, {})
        flags = [{k: f.get(k) for k in ("rule", "prio", "detail", "label", "sig")} for f in found["flags"]]
        (OUT / f"{name}.json").write_text(json.dumps(flags, indent=1, ensure_ascii=False), encoding="utf-8")
        try:
            (OUT / f"{name}.aria.yml").write_text(page.locator("body").aria_snapshot(), encoding="utf-8")
        except Exception:
            pass
        print(f"call {name}: {len(flags)} flags ({sum(1 for f in flags if f['prio'] == 'P2')} P2)", flush=True)

    def window(self, who: str, win: str, dark: bool) -> Page:
        if win in ("390", "320", "820p"):
            return self._touch(who, win, dark)
        return self.page(who, viewport=WINDOWS[win], dark=dark)

    def _touch(self, who: str, win: str, dark: bool) -> Page:
        from test_live_sessions import INSTRUMENT
        from test_app_shell import ORIGIN
        options = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                   "viewport": WINDOWS[win], "device_scale_factor": 1, "is_mobile": True, "has_touch": True, "storage_state": self.states[who]}
        context = self.browser.new_context(**options)
        context.grant_permissions(["microphone", "camera"], origin=ORIGIN)
        context.add_init_script(INSTRUMENT)
        self.addCleanup(context.close)
        return context.new_page()

    def open_space(self, page: Page) -> None:
        """The seeded space's conversation, with any thread panel closed (under 360 px Join folds into ⋯, so only the header is awaited)."""
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator("header.top, header.phead").first).to_be_visible()
        page.wait_for_timeout(1200)

    def press(self, locator, touch: bool) -> None:
        locator.tap() if touch else locator.click()

    def test_01_the_call_screens_at_each_window_and_theme(self) -> None:
        self.seed()
        for dark in (False, True):
            theme = "dark" if dark else "light"
            nia = self.page("nia", dark=dark)
            self.open_conversation(nia)
            rejoin = nia.locator("header.top, header.phead").get_by_role("button", name="Join")
            if rejoin.count() and rejoin.first.is_visible():  # the first pass's call may still be live: Nia joins it again
                rejoin.first.click()
                expect(self.bar(nia)).to_be_visible(timeout=20000)
            else:
                self.call(nia)
            for win in WINDOWS:
                touch = win in ("390", "320", "820p")
                jonas = self.window("jonas", win, dark)
                self.open_space(jonas)
                self.capture(jonas, f"{theme}-{win}-join-offered")
                header = jonas.locator("header.top, header.phead")
                join = header.get_by_role("button", name="Join")
                if join.count() and join.first.is_visible():
                    self.press(join.first, touch)
                else:  # under 360 px Join folds into ⋯ (#1239)
                    self.press(header.get_by_role("button", name=re.compile("^More")).first, touch)
                    self.capture(jonas, f"{theme}-{win}-join-in-more")
                    self.press(jonas.get_by_role("menuitem", name=re.compile("Join")).first, touch)
                bar = self.bar(jonas)
                expect(bar).to_be_visible(timeout=20000)
                jonas.wait_for_timeout(2500)
                self.capture(jonas, f"{theme}-{win}-strip")
                # Audio settings: the arrow beside the microphone.
                audio = bar.get_by_role("button", name=re.compile("Audio settings|Audio|Sound", re.I))
                if audio.count() and audio.first.is_visible():
                    self.press(audio.first, touch)
                    self.capture(jonas, f"{theme}-{win}-audio-settings")
                    jonas.keyboard.press("Escape")
                    jonas.wait_for_timeout(400)
                # The strip's ⋯: Here now and the rest.
                more = bar.get_by_role("button", name=re.compile("^More", re.I))
                if more.count() and more.first.is_visible():
                    self.press(more.first, touch)
                    self.capture(jonas, f"{theme}-{win}-strip-more")
                    here = jonas.get_by_role("menuitem", name=re.compile("Here now|People", re.I))
                    if here.count():
                        self.press(here.first, touch)
                        self.capture(jonas, f"{theme}-{win}-here-now")
                    jonas.keyboard.press("Escape")
                    jonas.wait_for_timeout(400)
                # The live bar on another place, reached inside the app (a reload would leave the call).
                home = jonas.get_by_role("link", name=re.compile("^Home"))
                if home.count() and home.first.is_visible():
                    self.press(home.first, touch)
                else:
                    back = header.get_by_role("button", name=re.compile("^Back")).or_(header.get_by_role("link", name=re.compile("^Back")))
                    self.press(back.first, touch)
                jonas.wait_for_timeout(1500)
                self.capture(jonas, f"{theme}-{win}-live-bar-elsewhere")
                leave = self.bar(jonas).get_by_role("button", name=re.compile("^Leave"))
                if leave.count() and leave.first.is_visible():
                    self.press(leave.first, touch)
                jonas.context.close()
            nia.context.close()


if __name__ == "__main__":
    unittest.main()
