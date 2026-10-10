"""Emulated platform rows for live work sessions (#63 AC-3; founder direction #266 item 10).

Runs only with FLUX_UI_LIVE=1 against the pinned SFU, through
``FLUX_LIVE_UI_PATTERN=test_live_platforms.py scripts/check_live_ui.sh``. Four rows run in Docker,
each in its own Playwright engine: Android Chrome (Chromium), Android Firefox (Gecko, viewport and
touch only, because Playwright rejects ``is_mobile`` there), iPhone Safari and iPad Safari (WebKit).
Each row joins a session that a desktop Chromium participant starts, shows the screen-capture
state, publishes its microphone, is refused the camera, receives that participant's screen,
survives a viewport rotation and a dispatched visibility change, then leaves. Two checks are
recorded as unverified rather than passed for WebKit: the camera denial and the instrumented
microphone track, because WebKit capture does not pass through the page's instrumented
getUserMedia (see ``cameraInstrument`` and ``microphoneTrackLevel`` in the evidence file).

What is emulated and what is not:

* Capability. Android and iOS browsers have no ``getDisplayMedia`` (MDN browser-compat-data, read
  2026-10-10). Playwright's engines on Linux report it present even under device emulation, so
  each row removes it explicitly, after recording the engine's own value in
  ``live-platform-rows.json``. The result is a documented capability state, not a real device.
* Media. Fake microphone and camera come from each engine (Chromium flags, Firefox prefs, WebKit's
  mock devices). Camera denial is the existing ``__denyCamera`` hook.
* Lifecycle. Rotation is a viewport change. Visibility is a dispatched ``visibilitychange`` after
  faking ``document.visibilityState``. Neither is an operating-system suspension or rotation event.
  Offline/rejoin, headphone changes and service-worker updates are not covered here.

No physical device is used, and nothing here certifies a network path (see live-turn checks).
"""

from __future__ import annotations

import json
import re
import unittest
from dataclasses import dataclass
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, SHOTS, UPSTREAM, shot, start_forwarder
from test_live_sessions import INSTRUMENT, LIVE, LiveBase

# Documented capability state: no getDisplayMedia on Android Chrome, Firefox for Android or iOS Safari.
NO_DISPLAY_CAPTURE = """(() => {
  window.__noDisplayCapture = true;
  if (typeof MediaDevices !== 'undefined') {
    try { delete MediaDevices.prototype.getDisplayMedia; } catch (error) { window.__noDisplayError = String(error); }
  }
  if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = undefined;
})();"""

SET_VISIBILITY = """(state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}"""

# Stacking and position of the screen stage and the session sheet, read after they settle. Keeps the
# evidence about why a pointer click cannot reach a control, without changing the product.
STAGE_PROBE = """() => {
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const describe = (el) => el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}` : null;
  const stage = document.querySelector('.lv-stage');
  const back = [...document.querySelectorAll('.lv-stage button')].find((b) => b.textContent.includes('Back to work'));
  let atBackCenter = null;
  if (back) { const b = back.getBoundingClientRect(); atBackCenter = describe(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); }
  const cs = stage ? getComputedStyle(stage) : null;
  return { stage: rect(stage), back: rect(back), zIndex: cs?.zIndex ?? null, opacity: cs?.opacity ?? null,
    transform: cs?.transform ?? null, atBackCenter, viewport: [innerWidth, innerHeight] };
}"""

CAMERA_LABELS = """() => [...document.querySelectorAll('[role="dialog"][aria-label="Live session"] button')]
  .map((b) => b.getAttribute('aria-label')).filter((label) => label && /Camera/.test(label))"""

SHEET_PROBE = """() => {
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const describe = (el) => el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}` : null;
  const sheet = document.querySelector('[role="dialog"][aria-label="Live session"]');
  const camera = [...document.querySelectorAll('[role="dialog"][aria-label="Live session"] button')].find((b) => /^Camera off/.test(b.getAttribute('aria-label') || ''));
  let atCameraCenter = null;
  if (camera) { const b = camera.getBoundingClientRect(); atCameraCenter = describe(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); }
  return { sheet: rect(sheet), camera: rect(camera), atCameraCenter, viewport: [innerWidth, innerHeight] };
}"""

ENGINE_PROBE = """() => ({
  userAgent: navigator.userAgent,
  maxTouchPoints: navigator.maxTouchPoints,
  coarsePointer: matchMedia('(pointer: coarse)').matches,
  getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
  getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia,
})"""


@dataclass(frozen=True)
class Row:
    name: str
    engine: str
    device: str
    note: str


ROWS = (
    Row("android-chrome", "chromium", "Pixel 7", "Android phone, Chrome (Chromium)"),
    Row("android-firefox", "firefox", "Pixel 7", "Android phone, Firefox (Gecko); viewport and touch only"),
    Row("iphone-safari", "webkit", "iPhone 13", "iPhone, Safari (WebKit)"),
    Row("ipad-safari", "webkit", "iPad (gen 7)", "iPad, Safari (WebKit), tablet layout"),
)


@unittest.skipUnless(LIVE, "needs FLUX_UI_LIVE=1, run through scripts/check_live_ui.sh with the pinned SFU")
class PlatformRows(LiveBase):
    """One join-and-use journey per emulated platform row, with a desktop Chromium host."""

    engines: dict = {}
    observed: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.engines = {
            "chromium": cls.pw.chromium.launch(args=[
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
                "--auto-select-desktop-capture-source=Entire screen",
                "--enable-usermedia-screen-capturing",
            ]),
            # Firefox refuses the microphone/camera permission names; these prefs grant fake media.
            "firefox": cls.pw.firefox.launch(firefox_user_prefs={
                "media.navigator.streams.fake": True,
                "media.navigator.permission.disabled": True,
            }),
            "webkit": cls.pw.webkit.launch(),
        }
        expect.set_options(timeout=15000)

    @classmethod
    def tearDownClass(cls) -> None:
        if SHOTS and cls.observed:
            SHOTS.mkdir(parents=True, exist_ok=True)
            (SHOTS / "live-platform-rows.json").write_text(json.dumps(cls.observed, indent=2) + "\n")
        for browser in cls.engines.values():
            browser.close()
        cls.pw.stop()

    def use(self, engine: str) -> None:
        self.engine = engine
        self.browser = self.engines[engine]

    def context(self, who: str | None, *, viewport: dict | None = None, device: str | None = None):
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if device:
            descriptor = {k: v for k, v in self.pw.devices[device].items() if k != "default_browser_type"}
            if self.engine == "firefox":
                # Playwright does not emulate is_mobile or touch for Firefox; keep the viewport and UA.
                descriptor.pop("is_mobile", None)
                descriptor.pop("has_touch", None)
            options.update(descriptor)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        if self.engine != "firefox":
            context.grant_permissions(["microphone", "camera"], origin=ORIGIN)
        context.add_init_script(INSTRUMENT)
        self.addCleanup(context.close)
        return context

    def leave_quietly(self, page: Page) -> None:
        bar = self.bar(page)
        try:
            if bar.count():
                bar.get_by_role("button", name="Leave", exact=True).click(timeout=5000)
                expect(bar).to_have_count(0, timeout=10000)
        except Exception:  # cleanup only; the failure that matters is already recorded by the test
            pass

    def run_row(self, row: Row) -> None:
        self.use("chromium")
        self.seed()
        conversation = f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}"

        host = self.page("nia")
        host.goto(conversation)
        host_bar = self.bar(host)
        together = host.locator("header.top").get_by_role("button", name="Together", exact=True)
        join = host.locator("header.top").get_by_role("button", name="Join", exact=True)
        # The header shows Together, or Join when a session is already open (left by an earlier failure).
        expect(together.or_(join).or_(host_bar)).to_be_visible()
        if together.is_visible():
            together.click()
        elif join.is_visible() and not host_bar.is_visible():
            join.click()
        expect(host_bar).to_be_visible()

        self.use(row.engine)
        page = self.page("kai", device=row.device)
        # Leave whatever a failed run left open, before the context closes (cleanups run last-in first).
        self.addCleanup(self.leave_quietly, page)
        self.addCleanup(self.leave_quietly, host)
        # Read the engine's own capability first, in a separate page, before emulation applies.
        probe = page.context.new_page()
        probe.goto("/sign-up")
        engine_value = probe.evaluate(ENGINE_PROBE)
        probe.close()
        page.context.add_init_script(NO_DISPLAY_CAPTURE)
        self.observed[row.name] = {"note": row.note, "engine": row.engine,
                                   "engineVersion": self.browser.version, "device": row.device,
                                   "engineBeforeCapabilityEmulation": engine_value,
                                   "capabilityEmulation": "getDisplayMedia removed (MDN BCD, 2026-10-10)"}

        page.goto(conversation)
        page.locator("header.top").get_by_role("button", name="Join").click()
        bar = self.bar(page)
        expect(bar.get_by_role("status").first).to_contain_text("Live")
        shot(page, f"live-platform-{row.name}-joined")
        # The emulated state must be in the page the app rendered, not only in the context.
        in_page = page.evaluate("""() => ({ installed: window.__noDisplayCapture === true,
          getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia,
          error: window.__noDisplayError ?? null })""")
        self.observed[row.name]["engineAfterCapabilityEmulation"] = in_page
        self.assertEqual(in_page["installed"], True, "the capability emulation ran in this document")
        self.assertEqual(in_page["getDisplayMedia"], "undefined", "the documented capability state is in place")

        # Honest capability state: no screen button in the strip, and the panel explains why.
        expect(bar.get_by_role("button", name=re.compile("Share a window"))).to_have_count(0)
        bar.get_by_role("button", name="Session details and more").click()
        sheet = page.get_by_role("dialog", name="Live session")
        expect(sheet).to_contain_text("This browser cannot share its screen.")
        expect(sheet.get_by_role("button", name=re.compile("Share a window"))).to_have_count(0)
        self.observed[row.name]["sheetDiagnostics"] = page.evaluate(SHEET_PROBE)

        # Refusal is truthful: the camera stays off and is shown as blocked.
        page.evaluate("window.__denyCamera = true")
        gum_before = page.evaluate("({ gum: window.__live.gum, constraints: window.__live.gumConstraints.length })")
        camera = sheet.get_by_role("button", name=re.compile("^Camera off"))
        # Pointer reachability is recorded as a finding (the sheet can sit under the thread on tablets);
        # when a pointer cannot reach it, the same control is activated by a DOM click instead.
        try:
            camera.click(timeout=5000)
            pointer_camera = True
        except Exception:
            pointer_camera = False
            camera.dispatch_event("click")
        self.observed[row.name]["cameraPointerReachable"] = pointer_camera
        page.wait_for_timeout(1000)
        self.observed[row.name]["cameraLabelsAfterDenyRequest"] = page.evaluate(CAMERA_LABELS)
        self.observed[row.name]["cameraInstrument"] = {"before": gum_before, "after": page.evaluate(
            "({ gum: window.__live.gum, constraints: window.__live.gumConstraints, denyFlag: window.__denyCamera })")}
        if row.engine == "webkit":
            # UNVERIFIED, not passed: in WebKit the camera click made no call to the instrumented
            # getUserMedia (cameraInstrument.after.gum stays 0) while the strip showed "Camera on".
            # The denial hook cannot reach this path yet; the row keeps every other check.
            self.observed[row.name]["cameraDenial"] = "unverified: no instrumented getUserMedia call in WebKit"
        else:
            expect(sheet.get_by_role("button", name=re.compile("Camera blocked by the browser"))).to_be_visible()
            self.observed[row.name]["cameraDenial"] = "verified: blocked by the browser state"
        page.evaluate("window.__denyCamera = false")
        page.keyboard.press("Escape")
        expect(sheet).to_be_hidden()

        # Microphone publishes with the engine's fake device; the track is live.
        bar.get_by_role("button", name=re.compile("^Microphone off")).click()
        expect(bar.get_by_role("button", name=re.compile("^Microphone on"))).to_be_visible(timeout=30000)
        # The track-level check needs the instrumented capture. WebKit capture does not pass through it
        # (no instrumented call), so there the product state above is the only evidence recorded.
        live_mic_tracks = page.evaluate("window.__live.tracks.filter((t) => t.kind === 'audio' && t.readyState === 'live').length")
        self.observed[row.name]["liveMicrophoneTracksInstrumented"] = live_mic_tracks
        if row.engine != "webkit":
            self.assertGreater(live_mic_tracks, 0, "published microphone track is live")
        else:
            self.observed[row.name]["microphoneTrackLevel"] = "unverified: WebKit capture is not instrumented; product state only"

        # The desktop host shares a screen; this row receives and decodes it.
        host_bar.get_by_role("button", name="Share a window, tab or screen").click()
        expect(host_bar.get_by_role("button", name=re.compile("Stop sharing")).first).to_be_visible(timeout=30000)
        bar.get_by_role("button", name=re.compile(r"^(View|.*’s screen)$")).first.click()
        page.wait_for_function("() => { const v = document.querySelector('video.lv-stage__video'); return !!v && v.videoWidth > 0; }",
                               timeout=60000)
        self.observed[row.name]["receivedScreenWidth"] = page.evaluate("document.querySelector('video.lv-stage__video').videoWidth")
        page.wait_for_timeout(1500)
        self.observed[row.name]["stageDiagnostics"] = page.evaluate(STAGE_PROBE)
        shot(page, f"live-platform-{row.name}-screen")
        # "Back to work" by pointer is recorded, not assumed: in every emulated row a conversation element
        # paints above the stage (see stageDiagnostics.atBackCenter; 412, 390 and 810 px layouts). Escape
        # from the focused stage is the keyboard route, and it must close the stage either way.
        stage = page.get_by_role("region", name="Shared screens and cameras")
        try:
            stage.get_by_role("button", name="Back to work").click(timeout=5000)
            reachable = True
        except Exception:
            reachable = False
        self.observed[row.name]["backToWorkPointerReachable"] = reachable
        if not reachable:
            page.keyboard.press("Escape")
        expect(stage).to_be_hidden()

        # Rotation and a dispatched visibility change keep the session and request no new capture.
        captures = page.evaluate("window.__live.gum + window.__live.gdm")
        size = page.viewport_size or DESKTOP
        page.set_viewport_size({"width": size["height"], "height": size["width"]})
        expect(bar.get_by_role("status").first).to_contain_text("Live")
        overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        self.assertLessEqual(overflow, 0, "no horizontal overflow after rotation")
        page.set_viewport_size(size)
        page.evaluate(SET_VISIBILITY, "hidden")
        page.wait_for_timeout(1000)
        page.evaluate(SET_VISIBILITY, "visible")
        expect(bar.get_by_role("status").first).to_contain_text("Live")
        expect(bar.get_by_role("button", name=re.compile("^Microphone on"))).to_be_visible()
        self.assertEqual(page.evaluate("window.__live.gum + window.__live.gdm"), captures,
                         "rotation and visibility return request no capture")

        bar.get_by_role("button", name="Leave", exact=True).click()
        expect(bar).to_have_count(0)
        host_bar.get_by_role("button", name="Leave", exact=True).click()
        expect(host_bar).to_have_count(0)

    def test_01_android_chrome(self) -> None:
        self.run_row(ROWS[0])

    def test_02_android_firefox(self) -> None:
        self.run_row(ROWS[1])

    def test_03_iphone_safari(self) -> None:
        self.run_row(ROWS[2])

    def test_04_ipad_safari(self) -> None:
        self.run_row(ROWS[3])


if __name__ == "__main__":
    unittest.main()
