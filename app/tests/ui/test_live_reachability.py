"""Pointer reachability of the live controls on phone and tablet (#63).

Covers the three product findings from the emulated platform rows: on a phone the screen stage's
"Back to work" was painted over by the open thread sheet; on an iPad the session sheet's camera
control was painted over by the thread; and a WebKit camera click showed "Camera on" while the
instrumented getUserMedia hook was not called. Each control is checked with elementFromPoint at its
centre and then with a real pointer action (click or tap), so a covered control fails here.

Runs only with FLUX_UI_LIVE=1 against the pinned SFU, through
``FLUX_LIVE_UI_PATTERN=test_live_reachability.py scripts/check_live_ui.sh``. Browsers use fake media
devices; this proves layering, pointer hit-testing and the captured-track state in Chromium and
WebKit emulation, not touch hardware, real networks or physical cameras.
"""

from __future__ import annotations

import json
import re
import unittest

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, SHOTS, UPSTREAM, shot, start_forwarder
from test_live_sessions import INSTRUMENT, LIVE, LiveBase

# elementFromPoint at the element's centre: the element itself (or one of its children) must be on top.
HIT_TEST = """(el) => {
  const b = el.getBoundingClientRect();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  const top = document.elementFromPoint(x, y);
  const label = (node) => node ? `${node.tagName.toLowerCase()}.${(node.getAttribute('class') || '').split(' ').filter(Boolean).slice(0, 2).join('.')}` : null;
  return { ok: !!top && (el === top || el.contains(top)), top: label(top), centre: [Math.round(x), Math.round(y)],
    box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)], stackOrder: [
      getComputedStyle(el.closest('.lv-stage') ?? el).zIndex, getComputedStyle(document.querySelector('.thread--sheet') ?? document.body).zIndex] };
}"""

VIDEO_DECODED = "() => { const v = document.querySelector('video.lv-stage__video'); return !!v && v.videoWidth > 0; }"

# Counts calls that reach the MediaDevices prototype, below any instance-level hook. It is installed
# before INSTRUMENT, so an instance hook calling the original also increments this counter.
PROTO_PROBE = """(() => {
  const proto = window.MediaDevices && MediaDevices.prototype;
  if (!proto || typeof proto.getUserMedia !== 'function') return;
  window.__protoGum = 0;
  const native = proto.getUserMedia;
  proto.getUserMedia = function (...args) { window.__protoGum += 1; return native.apply(this, args); };
})();"""

CAMERA_STATE = """() => {
  const live = window.__live;
  const md = navigator.mediaDevices;
  return {
    instanceGum: live ? live.gum : null,
    protoGum: window.__protoGum ?? null,
    instanceOwnProperty: md ? Object.prototype.hasOwnProperty.call(md, 'getUserMedia') : null,
    sameAsPrototype: md && window.MediaDevices ? md.getUserMedia === MediaDevices.prototype.getUserMedia : null,
    tracks: live ? live.tracks.map((t) => ({ kind: t.kind, readyState: t.readyState })) : [],
    localVideo: [...document.querySelectorAll('video[aria-label="Your camera"]')].map((v) => ({ width: v.videoWidth, height: v.videoHeight })),
  };
}"""


@unittest.skipUnless(LIVE, "needs FLUX_UI_LIVE=1, run through scripts/check_live_ui.sh with the pinned SFU")
class ReachabilityRows(LiveBase):
    """Each test starts its own session: a desktop host and one guest on a phone or tablet row."""

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
            "webkit": cls.pw.webkit.launch(),
        }
        cls.browser = cls.engines["chromium"]
        expect.set_options(timeout=15000)

    @classmethod
    def tearDownClass(cls) -> None:
        if SHOTS and cls.observed:
            SHOTS.mkdir(parents=True, exist_ok=True)
            (SHOTS / "live-reachability.json").write_text(json.dumps(cls.observed, indent=2) + "\n")
        for browser in cls.engines.values():
            browser.close()
        cls.pw.stop()

    def use(self, engine: str) -> None:
        self.browser = self.engines[engine]

    def context(self, who: str | None, *, viewport: dict | None = None, phone: bool = False, reduced: bool = False,
                dark: bool = False, device: str | None = None):
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if device:
            descriptor = {k: v for k, v in self.pw.devices[device].items() if k != "default_browser_type"}
            options.update(descriptor)
        elif phone:
            options.update(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1)
        if reduced:
            options["reduced_motion"] = "reduce"
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        context.grant_permissions(["microphone", "camera"], origin=ORIGIN)
        # Probe first, so an instance-level hook from INSTRUMENT is counted under __protoGum too.
        context.add_init_script(PROTO_PROBE)
        context.add_init_script(INSTRUMENT)
        self.addCleanup(context.close)
        return context

    def conversation_url(self) -> str:
        return f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}"

    def start_host(self) -> Page:
        """A desktop Chromium participant who starts the session on the conversation (as in the other live tests)."""
        self.use("chromium")
        self.seed()
        host = self.page("nia")
        host.goto(self.conversation_url())
        host_bar = self.bar(host)
        together = host.locator("header.top").get_by_role("button", name="Together", exact=True)
        join = host.locator("header.top").get_by_role("button", name="Join", exact=True)
        expect(together.or_(join).or_(host_bar)).to_be_visible()
        if together.is_visible():
            together.click()
        elif join.is_visible() and not host_bar.is_visible():
            join.click()
        expect(host_bar).to_be_visible()
        self.addCleanup(self.leave_quietly, host)
        return host

    def guest_join(self, engine: str, *, phone: bool = False, device: str | None = None) -> Page:
        self.use(engine)
        page = self.page("kai", phone=phone, device=device)
        page.goto(self.conversation_url())
        page.locator("header.top").get_by_role("button", name="Join").click()
        expect(self.bar(page).get_by_role("status").first).to_contain_text("Live")
        self.addCleanup(self.leave_quietly, page)
        return page

    def leave_quietly(self, page: Page) -> None:
        bar = self.bar(page)
        try:
            if bar.count():
                bar.get_by_role("button", name="Leave", exact=True).click(timeout=5000)
                expect(bar).to_have_count(0, timeout=10000)
        except Exception:  # cleanup only; the failure that matters is already recorded by the test
            pass

    def share_host_screen(self, host: Page) -> None:
        host_bar = self.bar(host)
        host_bar.get_by_role("button", name="Share a window, tab or screen").click()
        expect(host_bar.get_by_role("button", name=re.compile("Stop sharing")).first).to_be_visible(timeout=30000)

    def test_01_phone_back_to_work_is_pointer_reachable(self) -> None:
        # Phone (Chromium, 390 px, touch): the conversation sheet is open over the stream, and the stage
        # opened from the strip must be above it. Back to work is the way back, so it must take a click.
        host = self.start_host()
        self.share_host_screen(host)
        guest = self.guest_join("chromium", phone=True)
        bar = self.bar(guest)
        expect(guest.locator(".thread--sheet")).to_be_visible()
        bar.get_by_role("button", name="View").click()
        stage = guest.get_by_role("region", name="Shared screens and cameras")
        expect(stage).to_be_visible()
        guest.wait_for_function(VIDEO_DECODED, timeout=60000)
        back = stage.get_by_role("button", name="Back to work")
        hit = back.evaluate(HIT_TEST)
        self.observed["phone-390-chromium-stage"] = {"hitTest": hit}
        shot(guest, "live-reachability-phone-stage")
        self.assertTrue(hit["ok"], f"Back to work is covered by {hit['top']} at {hit['centre']}")
        back.click(timeout=5000)
        expect(stage).to_be_hidden()
        expect(bar.get_by_role("status").first).to_contain_text("Live")

    def test_02_ipad_session_camera_is_reachable_and_is_a_real_track(self) -> None:
        # iPad (WebKit emulation, touch): the session sheet is a popover in the strip, which must sit
        # above the thread sheet. The camera control takes a real tap, and the state it shows must match
        # a captured, decoded track as the host sees it.
        host = self.start_host()
        guest = self.guest_join("webkit", device="iPad (gen 7)")
        bar = self.bar(guest)
        bar.get_by_role("button", name="Session details and more").click()
        sheet = guest.get_by_role("dialog", name="Live session")
        expect(sheet).to_be_visible()
        camera = sheet.get_by_role("button", name=re.compile("^Camera off"))
        hit = camera.evaluate(HIT_TEST)
        before = guest.evaluate(CAMERA_STATE)
        self.observed["ipad-webkit-session"] = {"hitTest": hit, "before": before}
        self.assertTrue(hit["ok"], f"the camera control is covered by {hit['top']} at {hit['centre']}")
        camera.tap(timeout=5000)
        expect(sheet.get_by_role("button", name=re.compile("^Camera on"))).to_be_visible(timeout=30000)
        after = guest.evaluate(CAMERA_STATE)
        self.observed["ipad-webkit-session"]["afterTap"] = after
        # A capture request reached getUserMedia (below any instance-level hook), so "on" is backed by a call.
        self.assertGreaterEqual(after["protoGum"] or 0, 1, "the tap reached the browser's getUserMedia")
        # The state is "on" only after a track is published. The host decoding the camera's frames is the
        # product proof that the claim is backed by a live track, independent of any test hook.
        host_bar = self.bar(host)
        host_bar.get_by_role("button", name="Cameras", exact=True).click()
        host_stage = host.get_by_role("region", name="Shared screens and cameras")
        expect(host_stage).to_be_visible()
        host.wait_for_function("() => [...document.querySelectorAll('video.lv-cam__video')].some((v) => v.videoWidth > 0)", timeout=60000)
        seen = host.evaluate("() => [...document.querySelectorAll('video.lv-cam__video')].map((v) => ({ width: v.videoWidth, height: v.videoHeight }))")
        self.observed["ipad-webkit-session"]["hostSeesCamera"] = seen
        shot(guest, "live-reachability-ipad-session")

    def test_03_ipad_stage_back_to_work_is_pointer_reachable(self) -> None:
        # iPad (WebKit emulation): the stage over the thread sheet at tablet width, closed by a real tap.
        host = self.start_host()
        self.share_host_screen(host)
        guest = self.guest_join("webkit", device="iPad (gen 7)")
        bar = self.bar(guest)
        bar.get_by_role("button", name=re.compile(r"^(View|.*’s screen)$")).first.click()
        stage = guest.get_by_role("region", name="Shared screens and cameras")
        expect(stage).to_be_visible()
        guest.wait_for_function(VIDEO_DECODED, timeout=60000)
        back = stage.get_by_role("button", name="Back to work")
        hit = back.evaluate(HIT_TEST)
        self.observed["ipad-webkit-stage"] = {"hitTest": hit}
        self.assertTrue(hit["ok"], f"Back to work is covered by {hit['top']} at {hit['centre']}")
        back.tap(timeout=5000)
        expect(stage).to_be_hidden()

    def test_04_phone_session_sheet_paints_above_the_strip(self) -> None:
        # The strip now has the overlay layer (--z-overlay), like the portalled sheet that opens from it.
        # Equal layers are ordered by the DOM (the portal comes last), so the sheet must still cover the strip.
        self.start_host()
        guest = self.guest_join("chromium", phone=True)
        bar = self.bar(guest)
        bar.get_by_role("button", name="Session details and more").click()
        sheet = guest.get_by_role("dialog", name="Live session")
        expect(sheet).to_be_visible()
        leave = bar.get_by_role("button", name="Leave", exact=True)
        covered_by = leave.evaluate("""(el) => {
          const b = el.getBoundingClientRect();
          const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return { insideOverlay: !!top?.closest('.ui-overlay'), top: top ? top.tagName.toLowerCase() : null };
        }""")
        self.observed["phone-390-chromium-sheet-over-strip"] = covered_by
        self.assertTrue(covered_by["insideOverlay"], f"the strip's Leave is painted over by {covered_by['top']}, not the sheet")
        # Closed the way the phone sheet is closed elsewhere (its header control, tapped; see test_03 in test_live_sessions).
        sheet.get_by_role("button", name="Back to work").tap()
        expect(sheet).to_be_hidden()


if __name__ == "__main__":
    unittest.main()
