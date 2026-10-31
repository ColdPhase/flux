"""Measured media profiles of the simulated public host (#63 AC-2, AC-3). Imported by driver.py.

Profiles (docs/development/live-media.md, "Measured profiles on the simulated public host"):
  speech  every person's microphone plays the same synthetic continuous speech (espeak-ng, 48 kHz);
  camera  Jonas's camera is a 1920x1080, 30 fps synthetic file (testsrc2, motion over the whole frame);
  motion  Ada shares her real X screen through the app's button: testsrc2 (ffplay) as Sharp text (the default), then
          a scrolling SMPTE pattern at a true 1920x1080, 60 fps (GStreamer) as Smooth motion (the sharing line's choice);
  large   Ada shows Jonas's camera large on her camera stage (the tile's own toggle), so automatic quality asks for
          its 1080p layer;
  second  with four people, Mia shares a second real screen (testsrc, 1920x1080, 30 fps) at the same time;
  loss    5 % loss and 40 +/- 20 ms delay both ways at router A (Ada's, and Mia's, network) while they present;
  weak    with four people, Tom alone at 400 kbit/s, 60 ms and 3 % loss both ways (router B, his address only).
Each window samples getStats() at every receiver and sender, maps every inbound video track to the element that
shows it (its accessible name says whose screen or camera it is) and compares the result with THRESHOLDS.
"""
from __future__ import annotations

import re
import time

from playwright.sync_api import Page, expect
from playwright.sync_api import TimeoutError as PlaywrightTimeout

# Calibrated pass/fail thresholds (docs/development/live-media.md, "Calibrated thresholds"). They come from the
# calibration runs recorded there, with margin for a shared host; they are gates for this simulation, not promises
# for every network or device. A run with FLUX_SIM_CALIBRATE=1 records the measurements without enforcing them.
# At the 10 Mbit/s cap the encoder keeps 60 fps and sends a whole-frame-moving 1080p capture at 1280x720.
SMOOTH = {"minHeight": 720, "minFps": 45.0, "maxFreezeS": 2.0, "maxLossPct": 1.0, "maxLatencyMs": 300.0}
LARGE = {"minHeight": 1080, "minFps": 20.0, "maxFreezeS": 2.0, "maxLossPct": 1.0}
THRESHOLDS = {
    # Clean path, every received speech track.
    "speech": {"minKbps": 20.0, "maxLossPct": 1.0, "maxConcealedPct": 3.0, "maxJitterMs": 30.0, "maxLatencyMs": 500.0},
    # Clean path, Jonas's camera on Ada's camera stage. The stage shows cameras as tiles, so a receiver asks for
    # the simulcast layer of the tile's size (automatic quality); what the camera captures is checked at the sender.
    "camera": {"minHeight": 180, "minFps": 12.0, "maxFreezeS": 3.0, "maxLossPct": 1.0, "captureMinHeight": 1080, "captureMinFps": 15.0},
    # Clean path, the motion screen on a receiver's stage, sent as Sharp text (up to 15 fps).
    "motion": {"minHeight": 1080, "minFps": 7.0, "maxFreezeS": 4.0, "maxLossPct": 1.0, "maxLatencyMs": 400.0},
    # The same screen sent as Smooth motion (up to 1920x1080 at 60 fps, simulcast).
    "smooth": SMOOTH,
    # Jonas's camera shown large on Ada's camera stage: its top layer.
    "large": LARGE,
    # 5 % loss and 40 +/- 20 ms at the presenters' router (TURN over TLS, so TCP): speech keeps going, the screen
    # keeps its resolution and still moves.
    "loss": {"speechMaxConcealedPct": 15.0, "speechMinKbps": 16.0, "screenMinFps": 0.5, "screenMinHeight": 1080},
    # One weak receiver among four: the presenter's sending and the other receivers' speech are untouched, the
    # other receivers keep at least half their clean frame rate. For the weak receiver: during the weak window only
    # liveness (some speech still arrives; not intelligibility), and 8 s after the link returns every speech track is
    # back at clean bitrate with little concealment, and his screen moves again.
    "weak": {"senderMinFpsShare": 0.8, "othersMinFpsShare": 0.5, "othersMaxConcealedPct": 3.0, "weakSpeechMinKbps": 5.0,
             "weakAfterMinFps": 5.0, "weakAfterSpeechMinKbps": 20.0, "weakAfterMaxConcealedPct": 5.0},
}

DETAIL = """
async () => {
  const labels = {};
  for (const video of document.querySelectorAll('video')) {
    const track = video.srcObject && video.srcObject.getVideoTracks ? video.srcObject.getVideoTracks()[0] : null;
    if (!track) continue;
    const named = video.getAttribute('aria-label') ? video : video.closest('[aria-label]');
    labels[track.id] = { label: (named && named.getAttribute('aria-label') || '').split(',')[0].split('.')[0],
      shownWidth: video.getBoundingClientRect().width, naturalWidth: video.videoWidth };
  }
  const out = { at: Date.now(), rtt: 0, available: 0, inbound: [], outbound: [], sources: [] };
  for (const [index, pc] of (window.__pcs || []).entries()) {
    if (pc.connectionState === 'closed') continue;
    const stats = await pc.getStats();
    const selected = new Set();
    stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) selected.add(r.selectedCandidatePairId); });
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && (selected.has(r.id) || r.selected) && r.state === 'succeeded')
        { out.rtt = Math.max(out.rtt, r.currentRoundTripTime || 0); out.available = Math.max(out.available, r.availableOutgoingBitrate || 0); }
      if (r.type === 'inbound-rtp') {
        const shown = labels[r.trackIdentifier] || {};
        out.inbound.push({ id: index + ':' + r.ssrc, kind: r.kind, label: shown.label || (r.kind === 'audio' ? 'speech' : 'not shown'),
          shownWidth: shown.shownWidth || 0, bytes: r.bytesReceived || 0, packets: r.packetsReceived || 0, lost: r.packetsLost || 0,
          frames: r.framesDecoded || 0, width: r.frameWidth || 0, height: r.frameHeight || 0,
          freezes: r.freezeCount || 0, freezeS: r.totalFreezesDuration || 0, jitter: r.jitter || 0,
          jbDelay: r.jitterBufferDelay || 0, jbCount: r.jitterBufferEmittedCount || 0,
          concealed: r.concealedSamples || 0, samples: r.totalSamplesReceived || 0, concealEvents: r.concealmentEvents || 0,
          energy: r.totalAudioEnergy || 0 });
      }
      if (r.type === 'media-source' && r.kind === 'video')
        out.sources.push({ width: r.width || 0, height: r.height || 0, fps: r.framesPerSecond || 0 });
      if (r.type === 'outbound-rtp') {
        out.outbound.push({ id: index + ':' + r.ssrc + ':' + (r.rid || ''), kind: r.kind, rid: r.rid || null,
          bytes: r.bytesSent || 0, frames: r.framesEncoded || 0, width: r.frameWidth || 0, height: r.frameHeight || 0,
          limit: r.qualityLimitationReason || null, active: r.active !== false, target: r.targetBitrate || 0 });
      }
    });
  }
  return out;
}
"""


def measure(pages: dict[str, Page], seconds: float) -> dict:
    """Interval rates of every inbound and outbound stream of each named page over `seconds`."""
    first = {who: page.evaluate(DETAIL) for who, page in pages.items()}
    time.sleep(seconds)
    last = {who: page.evaluate(DETAIL) for who, page in pages.items()}
    report: dict = {}
    for who in pages:
        a, b = first[who], last[who]
        span = max(0.001, (b["at"] - a["at"]) / 1000)
        before = {item["id"]: item for item in a["inbound"]}
        inbound = []
        for item in b["inbound"]:
            prev = before.get(item["id"])
            if not prev or item["packets"] <= prev["packets"]:
                continue
            packets, lost = item["packets"] - prev["packets"], max(0, item["lost"] - prev["lost"])
            row = {"kind": item["kind"], "label": item["label"], "kbps": round(8 * (item["bytes"] - prev["bytes"]) / span / 1000, 1),
                   "lossPct": round(100 * lost / max(1, packets + lost), 2), "jitterMs": round(1000 * item["jitter"], 1)}
            emitted = item["jbCount"] - prev["jbCount"]
            jb = 1000 * (item["jbDelay"] - prev["jbDelay"]) / emitted if emitted > 0 else None
            row["latencyMs"] = round(1000 * b["rtt"] / 2 + jb, 1) if jb is not None else None
            if item["kind"] == "video":
                row.update(fps=round((item["frames"] - prev["frames"]) / span, 1), size=f"{item['width']}x{item['height']}",
                           height=item["height"], freezes=item["freezes"] - prev["freezes"],
                           freezeS=round(item["freezeS"] - prev["freezeS"], 2), shownWidth=round(item["shownWidth"]))
            else:
                samples = item["samples"] - prev["samples"]
                row.update(concealedPct=round(100 * (item["concealed"] - prev["concealed"]) / max(1, samples), 2),
                           interruptions=item["concealEvents"] - prev["concealEvents"],
                           speech=item["energy"] - prev["energy"] > 0)
            inbound.append(row)
        sent_before = {item["id"]: item for item in a["outbound"]}
        outbound = []
        for item in b["outbound"]:
            prev = sent_before.get(item["id"])
            if not prev or item["bytes"] <= prev["bytes"]:
                continue
            row = {"kind": item["kind"], "rid": item["rid"], "kbps": round(8 * (item["bytes"] - prev["bytes"]) / span / 1000, 1)}
            if item["kind"] == "video":
                row.update(fps=round((item["frames"] - prev["frames"]) / span, 1), size=f"{item['width']}x{item['height']}",
                           limit=item["limit"], targetKbps=round(item["target"] / 1000))
            outbound.append(row)
        report[who] = {"seconds": round(span, 1), "rttMs": round(1000 * b["rtt"], 1), "availableOutKbps": round(b["available"] / 1000),
                       "captured": [f"{c['width']}x{c['height']}@{c['fps']}" for c in b["sources"]],
                       "inbound": inbound, "outbound": outbound}
    return report


def tracks(report: dict, who: str, kind: str, label: str | None = None) -> list[dict]:
    return [row for row in report.get(who, {}).get("inbound", [])
            if row["kind"] == kind and (label is None or label in row["label"])]


def bar(page: Page):
    return page.get_by_role("region", name="Live session")


def stage(page: Page):
    return page.get_by_role("region", name="Shared screens and cameras")


def share_screen(page: Page, answer=None) -> str:
    """The person's own action: the strip's share button, then `answer` for a browser that asks in its own prompt.
    Returns what the button then says."""
    bar(page).get_by_role("button", name="Share a window, tab or screen").click()
    if answer:
        time.sleep(2)
        answer()
    try:
        expect(bar(page).get_by_role("button", name="Stop sharing your screen")).to_be_visible(timeout=20_000)
    except AssertionError:
        pass
    return page.evaluate("(document.querySelector('.lv-bar .lv-dev--screen') || {}).getAttribute?.('data-tip') || ''") or ""


def open_stage(page: Page, button: str | re.Pattern, focus: str | None = None) -> None:
    if not stage(page).count():
        bar(page).get_by_role("button", name=button).click()
    expect(stage(page)).to_be_visible()
    if focus:
        stage(page).get_by_role("radio", name=focus).click()


def screen_mode(page: Page, mode: str) -> str:
    """The presenter's own choice in the sharing line: "Sharp text" or "Smooth motion". Returns what is checked."""
    group = bar(page).get_by_role("radiogroup", name="How your screen is sent")
    group.get_by_role("radio", name=mode).click()
    expect(group.get_by_role("radio", name=mode)).to_have_attribute("aria-checked", "true")
    return mode


def sent_video(report: dict, who: str) -> list[dict]:
    return [r for r in report.get(who, {}).get("outbound", []) if r["kind"] == "video"]


class Gate:
    """Collects threshold results; enforced unless calibrating."""

    def __init__(self, calibrate: bool):
        self.calibrate = calibrate
        self.checks: list[dict] = []

    def check(self, name: str, value, limit, ok: bool) -> None:
        self.checks.append({"check": name, "value": value, "limit": limit, "pass": bool(ok)})

    def at_least(self, name: str, value, limit) -> None:
        self.check(name, value, f">= {limit}", value is not None and value >= limit)

    def at_most(self, name: str, value, limit) -> None:
        self.check(name, value, f"<= {limit}", value is not None and value <= limit)

    def failures(self) -> list[dict]:
        return [c for c in self.checks if not c["pass"]]


def speech_gate(gate: Gate, report: dict, receivers: list[str], step: str) -> None:
    t = THRESHOLDS["speech"]
    for who in receivers:
        rows = tracks(report, who, "audio")
        gate.check(f"{step}: {who} receives speech", len(rows), ">= 1", len(rows) >= 1)
        for i, row in enumerate(rows):
            name = f"{step}: speech {i + 1} at {who}"
            gate.at_least(f"{name} kbps", row["kbps"], t["minKbps"])
            gate.at_most(f"{name} loss %", row["lossPct"], t["maxLossPct"])
            gate.at_most(f"{name} concealed %", row["concealedPct"], t["maxConcealedPct"])
            gate.at_most(f"{name} jitter ms", row["jitterMs"], t["maxJitterMs"])
            gate.at_most(f"{name} latency estimate ms", row["latencyMs"], t["maxLatencyMs"])
            gate.check(f"{name} carries speech energy", row["speech"], "true", row["speech"])


def video_gate(gate: Gate, row: dict | None, name: str, t: dict) -> None:
    if row is None:
        gate.check(f"{name} received", None, "a decoded track", False)
        return
    gate.at_least(f"{name} height", row["height"], t["minHeight"])
    gate.at_least(f"{name} fps", row["fps"], t["minFps"])
    gate.at_most(f"{name} freeze s", row["freezeS"], t["maxFreezeS"])
    gate.at_most(f"{name} loss %", row["lossPct"], t["maxLossPct"])
    if "maxLatencyMs" in t:
        gate.at_most(f"{name} latency estimate ms", row["latencyMs"], t["maxLatencyMs"])


def first(rows: list[dict]) -> dict | None:
    return max(rows, key=lambda r: r["kbps"]) if rows else None


def run(phases: set, pages: dict[str, Page], result: dict, ctl, log, run_name: str, engine_a: str, calibrate: bool) -> None:
    four = "four" in phases
    ada, jonas = pages["ada"], pages["jonas"]
    gate = Gate(calibrate)
    out: dict = {"people": 4 if four else 2, "thresholds": THRESHOLDS, "steps": {}}
    result["phases"]["profiles" if "profiles" in phases else "screen"] = out

    def step(name: str, who: dict[str, Page], seconds: float = 15) -> dict:
        ctl(f"mark {run_name} {name} begin")
        report = measure(who, seconds)
        ctl(f"mark {run_name} {name} end")
        out["steps"][name] = report
        log("profile", step=name, report=report)
        return report

    if "screen" in phases and "profiles" not in phases:
        # Screen publication from browser A (AC-3): the app's own button, a real X screen with a moving pattern.
        # Playwright's WebKit shares its own mock screen source instead (1920x1080, 30 fps), not the X display; a
        # full-screen pattern would only cover the window it renders in.
        if engine_a != "webkit":
            ctl("screen a on testsrc2=size=1920x1080:rate=30")
        # WebKit asks "Allow access to display device?" in its own info bar; the person presses Yes.
        out["shareButton"] = share_screen(ada, (lambda: out.update(prompt=ctl("allow-display a").strip())) if engine_a == "webkit" else None)
        sharing = bar(ada).get_by_role("button", name="Stop sharing your screen").count() > 0
        out["sharing"] = sharing
        out["engine"] = engine_a
        if sharing:
            open_stage(jonas, re.compile("’s screen$"))
            # Measure once the receiver decodes the screen (subscription and the first key frame take a moment).
            jonas.wait_for_function("(() => { const v = document.querySelector('.lv-stage__video'); return v && v.videoWidth > 0; })()", timeout=30_000)
            time.sleep(3)
            report = step("screen", {"jonas": jonas, "ada": ada}, 10)
            row = first(tracks(report, "jonas", "video", "screen"))
            out["received"] = row
            jonas.screenshot(path=f"/ctl/{run_name}-screen-received.png")
            gate.check("screen from browser A decodes at the receiver", row and row["fps"], "> 0", bool(row and row["fps"] > 0))
        else:
            ada.screenshot(path=f"/ctl/{run_name}-screen-refused.png")
        ctl("screen a off")
        out["checks"] = gate.checks
        assert sharing and not gate.failures(), out
        return

    # Speech and camera: Jonas's camera on, Ada watches it on the camera stage.
    bar(jonas).get_by_role("button", name=re.compile("^Camera off")).click()
    expect(bar(jonas).get_by_role("button", name=re.compile("^Camera on"))).to_be_visible()
    open_stage(ada, "Cameras")
    time.sleep(6)
    everyone = dict(pages)
    everyone.pop("lee", None)
    report = step("speech-camera", everyone)
    speech_gate(gate, report, [w for w in everyone if w != "jonas"] + ["jonas"], "clean")
    video_gate(gate, first(tracks(report, "ada", "video", "camera")), "clean: Jonas's camera at Ada", THRESHOLDS["camera"])

    ada.screenshot(path=f"/ctl/{run_name}-camera-at-ada.png")

    # Jonas's camera shown large: the tile's own toggle; automatic quality then receives the top layer.
    large = stage(ada).get_by_role("button", name=re.compile(r"^Show Jonas.* camera large$"))
    large.click()
    expect(large).to_have_attribute("aria-pressed", "true")
    # Wait for the top layer instead of a fixed pause: automatic quality asks for it once the element is large and
    # the SFU switches layers on a key frame, which takes longer on a loaded host. The wait is bounded and its length
    # is recorded; a layer that never arrives still fails the height gate in the measured window below.
    waited = time.monotonic()
    try:
        ada.wait_for_function(
            "(rows) => [...document.querySelectorAll('video.lv-stage__video')].some((v) =>"
            " (v.getAttribute('aria-label') || '').includes('camera, enlarged') && v.videoHeight >= rows)",
            arg=THRESHOLDS["large"]["minHeight"], timeout=30_000)
    except PlaywrightTimeout:
        pass
    out["cameraLargeLayerAfterS"] = round(time.monotonic() - waited, 1)
    time.sleep(2)
    report = step("camera-large", {"ada": ada, "jonas": jonas})
    video_gate(gate, first(tracks(report, "ada", "video", "camera")), "clean: Jonas's camera shown large at Ada", THRESHOLDS["large"])
    out["cameraLargeSent"] = sent_video(report, "jonas")
    ada.screenshot(path=f"/ctl/{run_name}-camera-large-at-ada.png")
    large.click()
    expect(large).to_have_attribute("aria-pressed", "false")
    time.sleep(3)

    # Motion: Ada shares her real screen; Jonas watches it on his stage.
    ctl("screen a on testsrc2=size=1920x1080:rate=60")
    out["adaShare"] = share_screen(ada)
    open_stage(jonas, re.compile("’s screen$"))
    viewers = {"jonas": jonas, "ada": ada}
    if four:
        ctl("screen c on testsrc=size=1920x1080:rate=30")
        out["miaShare"] = share_screen(pages["mia"])
        open_stage(pages["tom"], re.compile("(’s screen|screens)$"), "Ada’s screen")
        open_stage(jonas, re.compile("(’s screen|screens)$"), "Mia’s screen")
        viewers.update(mia=pages["mia"], tom=pages["tom"])
    time.sleep(8)
    report = step("motion" if not four else "two-shares", viewers)
    motion_at = "tom" if four else "jonas"
    video_gate(gate, first(tracks(report, motion_at, "video", "Ada")), f"clean: Ada's motion screen at {motion_at}", THRESHOLDS["motion"])
    if four:
        video_gate(gate, first(tracks(report, "jonas", "video", "Mia")), "clean: Mia's screen at Jonas", THRESHOLDS["motion"])
    speech_gate(gate, report, list(viewers), "with screens")
    for who, page in viewers.items():
        if who != "ada":
            page.screenshot(path=f"/ctl/{run_name}-{who}-stage.png")

    # What Jonas's camera captures (the sender's media-source): dynacast sends only the layers someone shows.
    captured = [c for c in report["jonas"].get("captured", [])]
    out["cameraCaptured"] = captured
    best = max(((int(c.split("x")[1].split("@")[0]), float(c.split("@")[1])) for c in captured), default=(0, 0.0))
    gate.at_least("clean: Jonas's camera capture height", best[0], THRESHOLDS["camera"]["captureMinHeight"])
    gate.at_least("clean: Jonas's camera capture fps", best[1], THRESHOLDS["camera"]["captureMinFps"])

    # 1:1 on the receiver: one screen pixel per display pixel.
    receiver = pages["tom"] if four else jonas
    stage(receiver).get_by_role("button", name="1:1").click()
    time.sleep(1)
    one = receiver.evaluate("(() => { const v = document.querySelector('.lv-stage__video'); return v && { natural: v.videoWidth, shown: Math.round(v.getBoundingClientRect().width * devicePixelRatio) }; })()")
    out["oneToOne"] = one
    gate.check("1:1 shows the received width in display pixels", one, "shown == natural", bool(one and one["natural"] and abs(one["shown"] - one["natural"]) <= 1))
    stage(receiver).get_by_role("button", name="Fit").click()

    if four:
        # One weak receiver among four: Tom alone, both ways.
        clean = out["steps"]["two-shares"]
        ctl("netem-host b 10.213.2.11 rate 400kbit delay 60ms loss 3%")
        time.sleep(8)
        report = step("weak", viewers, 15)
        ctl("netem-host b 10.213.2.11 off")
        t = THRESHOLDS["weak"]
        # Her top layer: the layer the other receivers use.
        top = lambda rows: max(rows, key=lambda r: int(r["size"].split("x")[1] or 0), default=None)
        sent_clean, sent_weak = top(sent_video(clean, "ada")), top(sent_video(report, "ada"))
        if sent_clean and sent_clean["fps"]:
            gate.at_least("weak: Ada's screen sending fps share of clean", round((sent_weak["fps"] if sent_weak else 0) / sent_clean["fps"], 2), t["senderMinFpsShare"])
        for who, label in (("jonas", "Mia"), ("ada", "camera")):
            before, now = first(tracks(clean, who, "video", label)), first(tracks(report, who, "video", label))
            if before and before["fps"]:
                gate.at_least(f"weak: {who}'s {label} fps share of clean", round((now["fps"] if now else 0) / before["fps"], 2), t["othersMinFpsShare"])
        for who in ("ada", "jonas", "mia"):
            for i, row in enumerate(tracks(report, who, "audio")):
                gate.at_most(f"weak: speech {i + 1} at {who} concealed %", row["concealedPct"], t["othersMaxConcealedPct"])
        sent = [r for r in report["ada"]["outbound"] if r["kind"] == "video"]
        out["weakAdaSends"] = sent
        weak_speech = tracks(report, "tom", "audio")
        gate.at_least("weak: Tom still receives speech kbps (liveness)", max((r["kbps"] for r in weak_speech), default=0), t["weakSpeechMinKbps"])
        time.sleep(8)
        after = step("weak-after", {"tom": pages["tom"]}, 8)
        row = first(tracks(after, "tom", "video", "Ada"))
        gate.at_least("weak: Tom's screen fps after the link returns", row and row["fps"], t["weakAfterMinFps"])
        after_speech = tracks(after, "tom", "audio")
        gate.check("weak: Tom receives speech after the link returns", len(after_speech), ">= 1", len(after_speech) >= 1)
        for i, speech in enumerate(after_speech):
            gate.at_least(f"weak: speech {i + 1} at Tom after the link returns kbps", speech["kbps"], t["weakAfterSpeechMinKbps"])
            gate.at_most(f"weak: speech {i + 1} at Tom after the link returns concealed %", speech["concealedPct"], t["weakAfterMaxConcealedPct"])

    # The same screen as Smooth motion: Ada's own choice in her sharing line, while she keeps sharing.
    # A moving demo: the whole frame scrolls at a true 60 fps (GStreamer on the X display; ffplay above draws about
    # 30 there). Sharp text on this content gave 2.6 to 4.3 fps in calibration (recorded, not gated).
    ctl("screen a on gst:pattern=smpte horizontal-speed=6")
    out["adaMode"] = screen_mode(ada, "Smooth motion")
    time.sleep(8)
    smooth_name = "smooth" if not four else "two-shares-smooth"
    report = step(smooth_name, viewers)
    # One layer: the receiver gets the whole 1080p stream whatever size the stage shows it at.
    video_gate(gate, first(tracks(report, motion_at, "video", "Ada")), f"clean: Ada's smooth motion screen at {motion_at}", THRESHOLDS["smooth"])
    out["smoothCaptured"] = report["ada"]["captured"]
    if four:
        video_gate(gate, first(tracks(report, "jonas", "video", "Mia")), "smooth: Mia's screen at Jonas", THRESHOLDS["motion"])
    speech_gate(gate, report, list(viewers), "with smooth motion")
    out["smoothSent"] = sent_video(report, "ada")
    (pages["tom"] if four else jonas).screenshot(path=f"/ctl/{run_name}-smooth-stage.png")

    if four:
        # The same weak receiver while Ada sends Smooth motion (one layer at up to 10 Mbit/s): what Tom receives is
        # recorded (it starves his speech: see the docs); the others must not be affected.
        ctl("netem-host b 10.213.2.11 rate 400kbit delay 60ms loss 3%")
        time.sleep(8)
        report = step("weak-smooth", viewers, 15)
        ctl("netem-host b 10.213.2.11 off")
        out["weakSmoothTomScreen"] = first(tracks(report, "tom", "video", "Ada"))
        out["weakSmoothTomSpeech"] = tracks(report, "tom", "audio")
        for who in ("ada", "jonas", "mia"):
            for i, row in enumerate(tracks(report, who, "audio")):
                gate.at_most(f"weak smooth: speech {i + 1} at {who} concealed %", row["concealedPct"], THRESHOLDS["weak"]["othersMaxConcealedPct"])
        time.sleep(8)
        step("weak-smooth-after", {"tom": pages["tom"]}, 8)

    # Back to Sharp text (the loss gates are for the one-layer readable screen), still without a new capture.
    out["adaModeBack"] = screen_mode(ada, "Sharp text")
    time.sleep(6)
    # Loss and jitter at the presenters' router.
    ctl("netem a delay 40ms 20ms loss 5%")
    time.sleep(5)
    report = step("loss", viewers, 15)
    ctl("netem a off")
    t = THRESHOLDS["loss"]
    # Speech is gated at the receivers outside router A; the presenters' own network is the lossy one, and what
    # they receive over it is recorded (it can collapse on the TCP relay: see the docs).
    for who in [w for w in viewers if w in ("jonas", "tom")]:
        for i, row in enumerate(tracks(report, who, "audio")):
            gate.at_most(f"loss: speech {i + 1} at {who} concealed %", row["concealedPct"], t["speechMaxConcealedPct"])
            gate.at_least(f"loss: speech {i + 1} at {who} kbps", row["kbps"], t["speechMinKbps"])
    row = first(tracks(report, motion_at, "video", "Ada"))
    gate.at_least(f"loss: Ada's screen at {motion_at} fps", row and row["fps"], t["screenMinFps"])
    gate.at_least(f"loss: Ada's screen at {motion_at} height", row and row["height"], t["screenMinHeight"])

    ctl("screen a off")
    if four:
        ctl("screen c off")
    out["checks"] = gate.checks
    out["failures"] = gate.failures()
    log("thresholds", calibrate=calibrate, failures=out["failures"], checked=len(gate.checks))
    if not calibrate:
        assert not out["failures"], out["failures"]
