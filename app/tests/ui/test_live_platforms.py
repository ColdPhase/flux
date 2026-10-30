"""Emulated platform rows for live work sessions (#63 AC-3; founder direction #266 item 10).

Runs only with FLUX_UI_LIVE=1 against the pinned SFU, through
``FLUX_LIVE_UI_PATTERN=test_live_platforms.py scripts/check_live_ui.sh``. Four rows run in Docker,
each in its own Playwright engine: Android Chrome (Chromium), Android Firefox (Gecko; the Pixel 7
viewport and user agent only, with no touch and no ``is_mobile``, because Playwright does not emulate
those for Firefox), iPhone Safari and iPad Safari (WebKit). Each row joins a session that a desktop
Chromium participant starts, shows the screen-capture state, publishes its microphone, is refused the
camera, receives that participant's screen, survives a viewport rotation and a dispatched visibility
change, then leaves. Capture counts come from the instrumentation in ``test_live_sessions.INSTRUMENT``
plus ``PROTOTYPE_INSTRUMENT`` here, which also sees WebKit's capture calls on ``MediaDevices.prototype``.
Each count is asserted to be observed before it is used as evidence, so an unobserved capture cannot
pass as "no new capture".

What is emulated and what is not:

* Capability. Android and iOS browsers have no ``getDisplayMedia`` (MDN browser-compat-data, read
  2026-10-10). Playwright's engines on Linux report it present even under device emulation, so
  each row removes it explicitly, after recording the engine's own value in
  ``live-platform-rows.json``. The result is a documented capability state, not a real device.
* Media. Fake microphone and camera come from each engine (Chromium flags, Firefox prefs, WebKit's
  mock devices). Camera denial is the existing ``__denyCamera`` hook.
* Lifecycle. Rotation is a viewport change. Visibility is a dispatched ``visibilitychange`` after
  faking ``document.visibilityState``. Neither is an operating-system suspension or rotation event.
  A headphone change is a dispatched ``devicechange`` (no device actually changes). A Flux update is
  its only effect on the page, one reload (``register.ts``): the reloaded page must capture nothing
  until the person joins and turns the microphone on again. Network loss is not covered here.

No physical device is used, and nothing here certifies a network path (see live-turn checks).
"""

from __future__ import annotations

import fcntl
import json
import re
import socket
import struct
import unittest
from dataclasses import dataclass
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, SHOTS, UPSTREAM, shot, start_forwarder
from test_live_sessions import INSTRUMENT, LIVE, LiveBase

SIOCGIFADDR = 0x8915


def container_network() -> dict:
    """This container's interfaces, default-route interface and the SFU's address on the media network it shares.

    Linux only (procfs and SIOCGIFADDR), which is where the browsers run. Diagnostic: it is recorded with each row.
    """
    interfaces: dict[str, str | None] = {}
    for _, name in socket.if_nameindex():
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                raw = fcntl.ioctl(probe.fileno(), SIOCGIFADDR, struct.pack("256s", name.encode()[:15]))
            interfaces[name] = socket.inet_ntoa(raw[20:24])
        except OSError:
            interfaces[name] = None
    default_route = None
    for line in Path("/proc/net/route").read_text().splitlines()[1:]:
        fields = line.split()
        if fields[1] == "00000000":
            default_route = fields[0]
            break
    media_remote = socket.gethostbyname("livekit")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        # UDP connect selects the kernel route without sending a packet. Attribute the SFU path
        # to its local interface so a mismatched default route is visible in the row evidence.
        probe.connect((media_remote, 7882))
        media_local = probe.getsockname()[0]
    media_route = next((name for name, address in interfaces.items() if address == media_local), None)
    return {"interfaces": interfaces, "defaultRouteInterface": default_route, "mediaRemote": media_remote,
            "mediaRouteInterface": media_route, "mediaRouteAddress": media_local}


def bound_udp_addresses() -> dict[int, str]:
    """The IPv4 address each UDP socket of this network namespace is bound to, by local port (0.0.0.0 = wildcard).

    The browsers run in this container's network namespace, so their ICE sockets are listed here.
    """
    bound: dict[int, str] = {}
    for line in Path("/proc/net/udp").read_text().splitlines()[1:]:
        address, port = line.split()[1].split(":")
        bound.setdefault(int(port, 16), socket.inet_ntoa(bytes.fromhex(address)[::-1]))
    return bound


def record_ice(page: Page) -> list[dict]:
    """The page's ICE path, with each candidate pair's local socket attributed to the address it is bound to."""
    ice = page.evaluate(ICE_PATH)
    bound = bound_udp_addresses()
    for entry in ice:
        for pair in entry["pairs"]:
            port = pair["local"]["port"] if pair["local"] else None
            pair["localSocketBound"] = bound.get(port) if port is not None else None
    return ice

# Documented capability state: no getDisplayMedia on Android Chrome, Firefox for Android or iOS Safari.
NO_DISPLAY_CAPTURE = """(() => {
  window.__noDisplayCapture = true;
  if (typeof MediaDevices !== 'undefined') {
    try { delete MediaDevices.prototype.getDisplayMedia; } catch (error) { window.__noDisplayError = String(error); }
  }
  if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = undefined;
})();"""

# Runs after INSTRUMENT. INSTRUMENT binds the native MediaDevices methods before this replaces them,
# so an instance-level call is counted once (by INSTRUMENT) and a call that reaches the prototype
# directly (WebKit, per the 2026-10-10 probe) is counted once here. Same counters, same denial hook.
PROTOTYPE_INSTRUMENT = """(() => {
  const state = window.__live;
  const proto = typeof MediaDevices !== 'undefined' ? MediaDevices.prototype : null;
  if (!state || !proto) return;
  const gum = proto.getUserMedia;
  proto.getUserMedia = async function (constraints) {
    state.gum += 1; state.gumConstraints.push(JSON.stringify(constraints));
    if (window.__denyCamera && constraints && constraints.video) throw new DOMException('Permission denied', 'NotAllowedError');
    const stream = await gum.call(this, constraints);
    stream.getTracks().forEach((track) => state.tracks.push(track));
    return stream;
  };
  if (proto.getDisplayMedia) {
    const gdm = proto.getDisplayMedia;
    proto.getDisplayMedia = async function (constraints) {
      state.gdm += 1;
      const stream = await gdm.call(this, constraints);
      stream.getTracks().forEach((track) => state.tracks.push(track));
      return stream;
    };
  }
})();"""

# Observes every RTCPeerConnection the app creates (#63, reviewer finding on the Firefox Join): the
# local candidates the page gathered, the remote candidates it was given, and the ICE servers it was
# configured with (credentials are not recorded). Observational only: the constructor is subclassed,
# nothing is changed. Runs after INSTRUMENT in the same init script, so the order is fixed.
ICE_RECORD = """(() => {
  const state = window.__live;
  const Native = window.RTCPeerConnection;
  if (!state || typeof Native !== 'function') return;
  state.pcs = [];
  const candidateLines = (sdp) => String(sdp || '').split(/\\r?\\n/).filter((line) => line.startsWith('a=candidate:'));
  window.RTCPeerConnection = class extends Native {
    constructor(configuration, ...rest) {
      super(configuration, ...rest);
      const record = { pc: this, iceServers: (this.getConfiguration().iceServers ?? []).map((server) => ({ urls: server.urls })), local: [], remote: [] };
      this.addEventListener('icecandidate', (event) => { if (event.candidate) record.local.push(event.candidate.candidate); });
      const setRemoteDescription = this.setRemoteDescription;
      this.setRemoteDescription = function (description, ...args) { record.remote.push(...candidateLines(description?.sdp)); return setRemoteDescription.call(this, description, ...args); };
      const addIceCandidate = this.addIceCandidate;
      this.addIceCandidate = function (candidate, ...args) { if (candidate?.candidate) record.remote.push(candidate.candidate); return addIceCandidate.call(this, candidate, ...args); };
      state.pcs.push(record);
    }
  };
})();"""

# Reads what the page's peer connections actually use: the selected candidate pair (or a succeeded pair
# that is nominated or selected) resolved to its local and remote candidates, from getStats().
ICE_PATH = """async () => {
  const out = [];
  for (const [index, record] of (window.__live?.pcs ?? []).entries()) {
    const pc = record.pc;
    const entry = { index, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
      iceServers: record.iceServers, localCandidates: record.local.slice(0, 40), remoteCandidates: record.remote.slice(0, 40), pairs: [] };
    try {
      const report = await pc.getStats();
      const byId = new Map();
      report.forEach((stat) => byId.set(stat.id, stat));
      const transports = [...byId.values()].filter((stat) => stat.type === 'transport');
      const selectedIds = new Set(transports.map((stat) => stat.selectedCandidatePairId).filter(Boolean));
      const describe = (id) => {
        const candidate = byId.get(id);
        return candidate ? { candidateType: candidate.candidateType, protocol: candidate.protocol ?? null, address: candidate.address ?? candidate.ip ?? null,
          port: candidate.port ?? null, relayProtocol: candidate.relayProtocol ?? null, url: candidate.url ?? null } : null;
      };
      for (const stat of byId.values()) {
        if (stat.type !== 'candidate-pair') continue;
        const selected = selectedIds.has(stat.id) || stat.selected === true;
        if (!selected && stat.state !== 'succeeded') continue;
        entry.pairs.push({ id: stat.id, state: stat.state, nominated: stat.nominated === true, selected, bytesSent: stat.bytesSent ?? null,
          bytesReceived: stat.bytesReceived ?? null, local: describe(stat.localCandidateId), remote: describe(stat.remoteCandidateId) });
      }
    } catch (error) {
      entry.error = String(error);
    }
    out.push(entry);
  }
  return out;
}"""

JOIN_PROBE = """() => {
  const region = document.querySelector('[role="region"][aria-label="Live session"]');
  const live = window.__live || {};
  return { url: location.pathname, userAgent: navigator.userAgent,
    header: document.querySelector('header.top, header.phead')?.innerText.slice(0, 200) ?? null,
    regionPresent: !!region, regionText: region ? region.innerText.slice(0, 300) : null,
    gum: live.gum ?? null, gdm: live.gdm ?? null, sockets: live.sockets ?? null,
    rtcReadyStates: (live.rtc || []).map((socket) => socket.readyState) };
}"""

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
    Row("android-firefox", "firefox", "Pixel 7", "Android phone viewport and user agent, Firefox (Gecko); no touch, no is_mobile"),
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
        # One init script, so the order is fixed: capture counters, then the prototype hook, then the ICE record.
        context.add_init_script("\n".join((INSTRUMENT, PROTOTYPE_INSTRUMENT, ICE_RECORD)))
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
        self.open_conversation(host, conversation)
        host_bar = self.bar(host)
        together = host.locator("header.top, header.phead").get_by_role("button", name="Together", exact=True)
        join = host.locator("header.top, header.phead").get_by_role("button", name="Join", exact=True)
        # The header shows Together, or Join when a session is already open (left by an earlier failure).
        expect(together.or_(join).or_(host_bar)).to_be_visible()
        if not host_bar.is_visible():
            # Playwright waits for whichever control is there; a header that changes between a visibility
            # snapshot and the click (seen on the iPhone row) is then not a failure.
            together.or_(join).first.click()
        expect(host_bar).to_be_visible()

        self.use(row.engine)
        page = self.page("kai", device=row.device)
        # Leave whatever a failed run left open, before the context closes (cleanups run last-in first).
        self.addCleanup(self.leave_quietly, page)
        self.addCleanup(self.leave_quietly, host)
        console: list[str] = []
        page.on("console", lambda message: console.append(f"{message.type}: {message.text}")
                if message.type in ("error", "warning") else None)
        page.on("pageerror", lambda error: console.append(f"pageerror: {error}"))
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

        self.open_conversation(page, conversation)
        page.locator("header.top, header.phead").get_by_role("button", name="Join").click()
        bar = self.bar(page)
        try:
            expect(bar.get_by_role("status").first).to_contain_text("Live")
        except Exception:
            # Record what the page showed when the wait gave up (region, status, sockets, console); then fail.
            self.observed[row.name]["joinDiagnostics"] = {"probe": page.evaluate(JOIN_PROBE), "console": console[-40:],
                                                          "ice": record_ice(page), "container": container_network()}
            shot(page, f"live-platform-{row.name}-join-failed")
            raise
        shot(page, f"live-platform-{row.name}-joined")
        self.observed[row.name]["icePath"] = record_ice(page)
        network = container_network()
        self.observed[row.name]["container"] = network
        self.assertIsNotNone(network["defaultRouteInterface"], "the browser container has a default route")
        self.assertIsNotNone(network["mediaRouteInterface"], "the kernel has a route to LiveKit's media address")
        self.assertEqual(network["defaultRouteInterface"], network["mediaRouteInterface"],
                         "the browser's default route must use the interface that reaches LiveKit")
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
        # A real pointer click: if the sheet were covered (as before the z-index fix in live.css), Playwright's
        # hit-target check fails here instead of falling back to a DOM click.
        camera.click()
        page.wait_for_timeout(1000)
        self.observed[row.name]["cameraLabelsAfterDenyRequest"] = page.evaluate(CAMERA_LABELS)
        gum_after = page.evaluate("({ gum: window.__live.gum, constraints: window.__live.gumConstraints, denyFlag: window.__denyCamera })")
        self.observed[row.name]["cameraInstrument"] = {"before": gum_before, "after": gum_after}
        # The camera request must be observed by the instrumentation before the denial can count as verified.
        self.assertGreater(gum_after["gum"], gum_before["gum"], "the camera request reached the instrumented getUserMedia")
        expect(sheet.get_by_role("button", name=re.compile("Camera blocked by the browser"))).to_be_visible()
        self.observed[row.name]["cameraDenial"] = "verified: the instrumented getUserMedia was called and the strip says blocked by the browser"
        page.evaluate("window.__denyCamera = false")
        page.keyboard.press("Escape")
        expect(sheet).to_be_hidden()

        # Microphone publishes with the engine's fake device; the track is live.
        bar.get_by_role("button", name=re.compile("^Microphone off")).click()
        expect(bar.get_by_role("button", name=re.compile("^Microphone on"))).to_be_visible(timeout=30000)
        live_mic_tracks = page.evaluate("window.__live.tracks.filter((t) => t.kind === 'audio' && t.readyState === 'live').length")
        self.observed[row.name]["liveMicrophoneTracksInstrumented"] = live_mic_tracks
        self.assertGreater(live_mic_tracks, 0, "the published microphone track is observed and live")

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
        # "Back to work" must be reachable by pointer: a real click, with Playwright's hit-target check.
        # (Before the stacking fix in live.css a conversation element painted above the stage on phone and tablet.)
        stage = page.get_by_role("region", name="Shared screens and cameras")
        stage.get_by_role("button", name="Back to work").click()
        expect(stage).to_be_hidden()

        # Rotation and a dispatched visibility change keep the session and request no new capture.
        captures = page.evaluate("window.__live.gum + window.__live.gdm")
        # Observability first: the denied camera request and the microphone capture must both be counted,
        # so the equality below compares real counters and cannot pass as 0 == 0.
        self.assertGreaterEqual(captures, 2, "the instrumentation counted the microphone and the camera request")
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

        # Headphones or a Bluetooth headset connecting: the browser fires `devicechange` on mediaDevices. Dispatched
        # here (no device actually changes), so this shows only that the event alone neither ends the session nor
        # mutes or reacquires the microphone.
        page.evaluate("navigator.mediaDevices.dispatchEvent(new Event('devicechange'))")
        page.wait_for_timeout(1500)
        expect(bar.get_by_role("status").first).to_contain_text("Live")
        expect(bar.get_by_role("button", name=re.compile("^Microphone on"))).to_be_visible()
        self.assertEqual(page.evaluate("window.__live.gum + window.__live.gdm"), captures, "a device change requests no capture")
        self.observed[row.name]["deviceChange"] = "dispatched devicechange: session Live, microphone on, no new capture"

        # Applying a Flux update reloads the page once (UpdatePrompt → Reload, register.ts). The reloaded app must not
        # rejoin or capture on its own: the microphone comes back only when the person joins again.
        page.reload()
        self.open_conversation(page, conversation)
        page.wait_for_timeout(3000)
        after_reload = page.evaluate("({ gum: window.__live.gum, gdm: window.__live.gdm })")
        self.observed[row.name]["afterReload"] = after_reload
        self.assertEqual(after_reload, {"gum": 0, "gdm": 0}, "a reload (the update's only effect) captures nothing by itself")
        expect(self.bar(page).get_by_role("button", name=re.compile("^Microphone on"))).to_have_count(0)
        rejoin = page.locator("header.top, header.phead").get_by_role("button", name="Join")
        expect(rejoin).to_be_visible()
        rejoin.click()
        expect(bar.get_by_role("status").first).to_contain_text("Live")
        self.observed[row.name]["rejoinAfterReload"] = "verified: Join after the reload returns the person to the open session"
        # The reloaded document's counters are live, so the zero above was observable: turning the microphone on counts.
        bar.get_by_role("button", name=re.compile("^Microphone off")).click()
        expect(bar.get_by_role("button", name=re.compile("^Microphone on"))).to_be_visible(timeout=30000)
        self.assertGreater(page.evaluate("window.__live.gum"), 0, "the reloaded page's instrumentation counts a capture the person asks for")

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
