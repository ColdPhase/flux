"""Browser driver of the simulated public host (#63). Runs on the simulated Internet, reaches each client's
Playwright server only through that client's NAT router, and drives the real Flux web app at
https://flux.sim.test. Impairments and restarts are asked of scripts/check_public_sim.sh through /ctl.

Environment: FLUX_SIM_BROWSER_A (behind the restrictive router), FLUX_SIM_BROWSER_B (behind the open router),
FLUX_SIM_PHASES (comma list of connect, drop, loss, weak, sfu-restart, api-restart, access; or "all").
Prints one JSON line per measurement prefixed "SIM " and writes /ctl/result-<run>.json.
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid

from playwright.sync_api import Page, expect, sync_playwright

ORIGIN = "https://flux.sim.test"
RUN = f"{os.environ['FLUX_SIM_BROWSER_A']}-{os.environ['FLUX_SIM_BROWSER_B']}-{int(time.time())}"
PHASES = os.environ.get("FLUX_SIM_PHASES", "all")
PHASES = {"connect", "drop", "loss", "weak", "sfu-restart", "api-restart", "access"} if PHASES == "all" else set(PHASES.split(","))
PASSWORD = "simulated public host calm"
RESULT: dict = {"run": RUN, "phases": {}}
DOC = "Relay test notes"

INSTRUMENT = """
(() => {
  const Native = window.RTCPeerConnection;
  if (!Native || window.__pcs) return;
  const pcs = [];
  Object.defineProperty(window, '__pcs', { value: pcs });
  const events = [];
  Object.defineProperty(window, '__iceEvents', { value: events });
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      const index = pcs.push(this) - 1;
      const note = (item) => { if (events.length < 400) events.push({ pc: index, at: Date.now(), ...item }); };
      this.addEventListener('icecandidate', (e) => e.candidate && note({ candidate: e.candidate.candidate }));
      this.addEventListener('icecandidateerror', (e) => note({ error: e.errorCode, text: e.errorText, url: e.url }));
      this.addEventListener('iceconnectionstatechange', () => note({ ice: this.iceConnectionState }));
    }
  };
})();
"""

# Selected candidate pair and receive/send totals of every open peer connection. Chromium and WebKit name the
# selected pair on the transport; Firefox marks the pair itself.
STATS = """
async () => {
  const out = [];
  for (const [index, pc] of (window.__pcs || []).entries()) {
    if (pc.connectionState === 'closed') { out.push({ index, closed: true }); continue; }
    const stats = await pc.getStats();
    const item = { index, state: pc.connectionState, ice: pc.iceConnectionState, selected: null,
      inbound: { audio: { packets: 0, bytes: 0, lost: 0, jitter: 0, concealed: 0, samples: 0 },
                 video: { packets: 0, bytes: 0, lost: 0, frames: 0, width: 0, height: 0, fps: 0 } },
      outboundBytes: 0 };
    const selectedIds = new Set();
    stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) selectedIds.add(r.selectedCandidatePairId); });
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && (selectedIds.has(r.id) || r.selected) && r.state === 'succeeded') {
        const local = stats.get(r.localCandidateId) || {};
        const remote = stats.get(r.remoteCandidateId) || {};
        item.selected = { localType: local.candidateType, localProtocol: local.protocol, relayProtocol: local.relayProtocol,
          localAddress: local.address || local.ip, remoteType: remote.candidateType, remoteAddress: remote.address || remote.ip,
          remotePort: remote.port, remoteProtocol: remote.protocol, url: local.url,
          bytesSent: r.bytesSent, bytesReceived: r.bytesReceived, rtt: r.currentRoundTripTime };
      }
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        const a = item.inbound.audio;
        a.packets += r.packetsReceived || 0; a.bytes += r.bytesReceived || 0; a.lost += r.packetsLost || 0;
        a.jitter = Math.max(a.jitter, r.jitter || 0); a.concealed += r.concealedSamples || 0; a.samples += r.totalSamplesReceived || 0;
      }
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        const v = item.inbound.video;
        v.packets += r.packetsReceived || 0; v.bytes += r.bytesReceived || 0; v.lost += r.packetsLost || 0;
        v.frames += r.framesDecoded || 0; v.width = Math.max(v.width, r.frameWidth || 0);
        v.height = Math.max(v.height, r.frameHeight || 0); v.fps = Math.max(v.fps, r.framesPerSecond || 0);
      }
      if (r.type === 'outbound-rtp') item.outboundBytes += r.bytesSent || 0;
    });
    out.push(item);
  }
  return out;
}
"""


DIAGNOSE = """
async () => Promise.all((window.__pcs || []).map(async (pc) => {
  const reports = [];
  (await pc.getStats()).forEach((r) => {
    if (['local-candidate', 'remote-candidate', 'candidate-pair', 'transport'].includes(r.type)) reports.push(r);
  });
  const config = pc.getConfiguration();
  return { state: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState,
    iceServers: (config.iceServers || []).map((s) => s.urls), policy: config.iceTransportPolicy, reports };
}))
"""


def diagnose(page: Page, who: str) -> None:
    try:
        devices = page.evaluate("[...document.querySelectorAll('.lv-dev')].map((b) => b.getAttribute('data-tip') || b.getAttribute('aria-label'))")
        log("diagnose", who=who, bar=bar_text(page), devices=devices, pcs=page.evaluate(DIAGNOSE), events=page.evaluate("window.__iceEvents"))
    except Exception as error:
        log("diagnose", who=who, error=str(error)[:300])


def log(kind: str, **data) -> None:
    print("SIM " + json.dumps({"t": round(time.time(), 3), "kind": kind, **data}), flush=True)


def ctl(command: str, timeout: float = 120) -> str:
    """Ask the host script to change the simulation (router rules, netem, restarts) and wait for it."""
    name = uuid.uuid4().hex[:8]
    with open(f"/ctl/req-{name}.tmp", "w") as handle:
        handle.write(command)
    os.rename(f"/ctl/req-{name}.tmp", f"/ctl/req-{name}")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(f"/ctl/done-{name}"):
            with open(f"/ctl/done-{name}") as handle:
                output = handle.read()
            log("ctl", command=command, output=output[-400:])
            return output
        time.sleep(0.1)
    raise TimeoutError(command)


def launch_options(browser: str) -> dict:
    if browser == "chromium":
        return {"args": ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]}
    if browser == "firefox":
        return {"firefoxUserPrefs": {"media.navigator.streams.fake": True, "media.navigator.permission.disabled": True}}
    return {}


def connect(pw, browser: str, router: str):
    kind = getattr(pw, browser)
    return kind.connect(f"ws://{router}:3000/", headers={"x-playwright-launch-options": json.dumps(launch_options(browser))},
                        timeout=60_000)


def new_page(browser, name: str) -> Page:
    # Playwright's Firefox ignores the CA that the client installs for Chromium (NSS database) and WebKit (system
    # store), so its pages accept the simulation's certificate without checking it. Recorded as a deviation.
    lenient = browser.browser_type.name == "firefox"
    context = browser.new_context(base_url=ORIGIN, viewport={"width": 1440, "height": 900}, locale="en-GB",
                                  ignore_https_errors=lenient)
    try:
        context.grant_permissions(["microphone", "camera"], origin=ORIGIN)
    except Exception as error:  # WebKit names permissions differently; the app then asks the browser.
        log("permissions", who=name, error=str(error)[:200])
    context.add_init_script(INSTRUMENT)
    page = context.new_page()
    page.set_default_timeout(30_000)
    page.on("pageerror", lambda error: log("pageerror", who=name, error=str(error)[:300]))
    return page


def api(page: Page, method: str, path: str, body: dict | None = None, headers: dict | None = None):
    sent = {"origin": ORIGIN, **({"content-type": "application/json"} if body is not None else {}), **(headers or {})}
    response = page.request.fetch(ORIGIN + path, method=method, headers=sent,
                                  data=json.dumps(body) if body is not None else None)
    text = response.text()
    return response.status, (json.loads(text) if text else {})


def ok(page: Page, method: str, path: str, body: dict | None = None, status: int = 200, headers: dict | None = None):
    got, data = api(page, method, path, body, headers)
    assert got == status, f"{method} {path}: {got} {data}"
    return data


def sign_up(page: Page, name: str, email: str) -> str:
    page.goto("/sign-up")
    page.get_by_label("Name").fill(name)
    page.get_by_label("Email").fill(email)
    page.get_by_label("Password").fill(PASSWORD)
    page.get_by_role("button", name="Create account").click()
    expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
    return ok(page, "GET", "/api/v1/me")["user"]["id"]


def stats(page: Page) -> list[dict]:
    return page.evaluate(STATS)


def totals(page: Page) -> dict:
    received = {"audio": 0, "video": 0}
    for item in stats(page):
        if item.get("closed"):
            continue
        received["audio"] += item["inbound"]["audio"]["bytes"]
        received["video"] += item["inbound"]["video"]["bytes"]
    return received


def flowing_since(page: Page, timeout: float, kind: str = "audio") -> float | None:
    """Seconds until received bytes of `kind` grow on two consecutive samples 250 ms apart, or None."""
    start = time.time()
    previous = None
    grew = 0
    while time.time() - start < timeout:
        try:
            current = totals(page)[kind]
        except Exception:
            current = None
        if previous is not None and current is not None and current > previous:
            grew += 1
            if grew >= 2:
                return round(time.time() - start, 2)
        else:
            grew = 0
        previous = current
        time.sleep(0.25)
    return None


def selected(page: Page) -> list[dict]:
    return [item["selected"] for item in stats(page) if not item.get("closed") and item.get("selected")]


def bar(page: Page):
    return page.get_by_role("region", name="Live session")


def bar_text(page: Page) -> str:
    try:
        return bar(page).inner_text(timeout=2_000).replace("\n", " · ")[:300]
    except Exception:
        return "(no live bar)"


def microphone_on(page: Page) -> None:
    mic = bar(page).get_by_role("button", name=re.compile("^Microphone off"))
    mic.click()
    expect(bar(page).get_by_role("button", name=re.compile("^Microphone on"))).to_be_visible()


def camera_on(page: Page) -> None:
    bar(page).get_by_role("button", name=re.compile("^Camera off")).click()
    expect(bar(page).get_by_role("button", name=re.compile("^Camera on"))).to_be_visible()


def devices(page: Page) -> list[str]:
    return page.evaluate("[...document.querySelectorAll('.lv-bar .lv-dev')].map((b) => b.getAttribute('aria-label'))")


def live_status(page: Page) -> str:
    try:
        return bar(page).get_by_role("status").first.inner_text(timeout=1_000).strip()
    except Exception:
        return ""


def window(page: Page, seconds: float) -> dict:
    """Received audio/video over an interval: bitrate, packets lost, frames decoded, size, and what Ada sends."""
    def sample():
        audio = {"bytes": 0, "packets": 0, "lost": 0}
        video = {"bytes": 0, "packets": 0, "lost": 0, "frames": 0, "width": 0, "height": 0}
        sent = 0
        for item in stats(page):
            if item.get("closed"):
                continue
            for key in audio:
                audio[key] += item["inbound"]["audio"][key]
            for key in ("bytes", "packets", "lost", "frames"):
                video[key] += item["inbound"]["video"][key]
            video["width"] = max(video["width"], item["inbound"]["video"]["width"])
            video["height"] = max(video["height"], item["inbound"]["video"]["height"])
            sent += item["outboundBytes"]
        return audio, video, sent
    a0, v0, s0 = sample()
    start = time.time()
    time.sleep(seconds)
    a1, v1, s1 = sample()
    span = time.time() - start
    return {"seconds": round(span, 1), "audioKbps": round(8 * (a1["bytes"] - a0["bytes"]) / span / 1000, 1),
            "audioLostPct": round(100 * (a1["lost"] - a0["lost"]) / max(1, a1["packets"] - a0["packets"] + a1["lost"] - a0["lost"]), 2),
            "videoKbps": round(8 * (v1["bytes"] - v0["bytes"]) / span / 1000, 1), "videoFps": round((v1["frames"] - v0["frames"]) / span, 1),
            "videoLostPct": round(100 * (v1["lost"] - v0["lost"]) / max(1, v1["packets"] - v0["packets"] + v1["lost"] - v0["lost"]), 2),
            "videoSize": f"{v1['width']}x{v1['height']}", "sentKbps": round(8 * (s1 - s0) / span / 1000, 1)}


def recover(name: str, page: Page, other: Page, timeout: float = 20) -> dict:
    """How a call comes back after an interruption, as a person sees it.

    First: does media resume by itself (ICE restart, signal resume)? If not, wait until each bar shows the
    session as Live again, or press Join where the app offers it, then turn the microphone back on where the app
    left it off (it never turns capture back on by itself), and time the audio."""
    began = time.time()
    outcome: dict = {"automaticS": None, "manual": []}
    at_page = flowing_since(page, timeout)
    at_other = flowing_since(other, 5.0) if at_page is not None else None
    if at_page is not None and at_other is not None:
        outcome["automaticS"] = round(time.time() - began, 2)
        deadline = time.time() + 60
        while time.time() < deadline and (live_status(page) != "Live" or live_status(other) != "Live"):
            time.sleep(0.25)
        outcome["barLiveBothS"] = round(time.time() - began, 2) if live_status(page) == live_status(other) == "Live" else None
    else:
        for who, candidate in (("A", page), ("B", other)):
            deadline = time.time() + 60
            while time.time() < deadline and live_status(candidate) != "Live":
                join = candidate.locator("header.top, header.phead").get_by_role("button", name="Join")
                if not bar(candidate).count() and join.count() and join.first.is_visible():
                    outcome["manual"].append(f"{who}: Join")
                    join.first.click()
                time.sleep(0.5)
            outcome[f"live{who}S"] = round(time.time() - began, 2) if live_status(candidate) == "Live" else None
            outcome[f"devicesAfter{who}"] = devices(candidate)
        for who, candidate in (("A", page), ("B", other)):
            mic = bar(candidate).get_by_role("button", name=re.compile("^Microphone off"))
            if mic.count():
                outcome["manual"].append(f"{who}: microphone on")
                mic.click()
        outcome["audioAtAS"] = flowing_since(page, 30)
        outcome["audioAtBS"] = flowing_since(other, 10)
        outcome["totalS"] = round(time.time() - began, 2)
    outcome["barA"], outcome["barB"] = bar_text(page), bar_text(other)
    log("recovery", phase=name, **outcome)
    return outcome

def main() -> None:
    result = RESULT
    with sync_playwright() as pw:
        browser_a = connect(pw, os.environ["FLUX_SIM_BROWSER_A"], "203.0.113.101")
        browser_b = connect(pw, os.environ["FLUX_SIM_BROWSER_B"], "203.0.113.102")
        result["versions"] = {"a": f"{os.environ['FLUX_SIM_BROWSER_A']} {browser_a.version}",
                              "b": f"{os.environ['FLUX_SIM_BROWSER_B']} {browser_b.version}"}
        log("browsers", **result["versions"])
        expect.set_options(timeout=30_000)
        stamp = int(time.time() * 1000)
        ada, jonas = new_page(browser_a, "ada"), new_page(browser_b, "jonas")
        lee = new_page(browser_b, "lee")
        ids = {"ada": sign_up(ada, "Ada Kowalska", f"ada.sim+{stamp}@example.test"),
               "jonas": sign_up(jonas, "Jonas Berg", f"jonas.sim+{stamp}@example.test"),
               "lee": sign_up(lee, "Lee Park", f"lee.sim+{stamp}@example.test")}
        ws = ok(ada, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        for who in ("jonas", "lee"):
            ok(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": f"{who}.sim+{stamp}@example.test", "role": "member"}, 201)
        pid = ok(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, 201)["id"]
        ok(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": ids["jonas"]}, "role": "contributor"}, 201)
        doc = ok(ada, "POST", f"/api/v1/projects/{pid}/docs", {"title": DOC, "body": "## Path\n\nTURN over TLS on 443.", "state": "published",
                                                               "reason": "Notes for the call"}, 201, {"idempotency-key": str(uuid.uuid4())})
        url = f"/projects/{pid}/docs/{doc['id']}"
        tokens: list[str] = []
        jonas.on("response", lambda r: tokens.append(r.json().get("token", "")) if re.search(r"/live-sessions/[^/]+/join$", r.url) and r.status == 200 else None)

        try:
            connect_phase(ada, jonas, url, result)
        except Exception:
            for who, page in (("a", ada), ("b", jonas)):
                try:
                    page.screenshot(path=f"/ctl/{RUN}-failed-{who}.png")
                except Exception:
                    pass
            diagnose(ada, "ada")
            diagnose(jonas, "jonas")
            raise
        sid = ok(ada, "GET", f"/api/v1/projects/{pid}/live-sessions")["items"][0]["id"]
        _phases(ada, jonas, lee, ids, pid, sid, tokens, result)
        browser_a.close()
        browser_b.close()
    with open(f"/ctl/result-{RUN}.json", "w") as handle:
        json.dump(result, handle, indent=1)
    log("done", run=RUN)


def connect_phase(ada: Page, jonas: Page, url: str, result: dict) -> None:
    # Connect: Ada (restrictive network) starts, Jonas (open network) joins, both turn the microphone on.
    t0 = time.time()
    ada.goto(url)
    expect(ada.get_by_role("heading", name=DOC, level=2)).to_be_visible()
    ada.locator("header.top, header.phead").get_by_role("button", name="Together").click()
    expect(bar(ada).get_by_role("status").first).to_contain_text("Live")
    jonas.goto(url)
    join = jonas.locator("header.top, header.phead").get_by_role("button", name="Join")
    expect(join).to_be_visible()
    join.click()
    expect(bar(jonas).get_by_role("status").first).to_contain_text("Live")
    microphone_on(ada)
    microphone_on(jonas)
    try:
        camera_on(ada)
    except Exception as error:
        log("camera", who="ada", error=str(error)[:200])
    at_jonas = flowing_since(jonas, 45)
    at_ada = flowing_since(ada, 45)
    connect_s = round(time.time() - t0, 2)
    sel_a, sel_b = selected(ada), selected(jonas)
    result["phases"]["connect"] = {"secondsFromStart": connect_s, "audioAtJonasS": at_jonas, "audioAtAdaS": at_ada,
                                   "selectedA": sel_a, "selectedB": sel_b, "statsA": stats(ada), "statsB": stats(jonas)}
    log("connect", seconds=connect_s, audioAtJonas=at_jonas, audioAtAda=at_ada, selectedA=sel_a, selectedB=sel_b)
    assert at_jonas is not None and at_ada is not None, "audio flows both ways"
    relay = os.environ.get("FLUX_SIM_A_RELAY", "tls")
    # WebKit leaves relayProtocol out of its stats; its candidate's TURN URL then names the transport.
    scheme = "turns:" if relay == "tls" else "turn:"
    assert sel_a and all(s["localType"] == "relay" and (s["relayProtocol"] == relay or (
        s["relayProtocol"] is None and str(s.get("url") or "").startswith(scheme))) for s in sel_a), f"A relays over {relay}: {sel_a}"
    ada.screenshot(path=f"/ctl/{RUN}-connected-a.png")
    jonas.screenshot(path=f"/ctl/{RUN}-connected-b.png")


def _phases(ada: Page, jonas: Page, lee: Page, ids: dict, pid: str, sid: str, tokens: list, result: dict) -> None:

    if "drop" in PHASES:
        ctl("drop a on")
        time.sleep(15)
        during = bar_text(ada)
        restored = time.time()
        ctl("drop a off")
        outcome = recover("drop", ada, jonas)
        outcome.update(dropSeconds=15, barDuringDrop=during, selectedAfter=selected(ada),
                       restoredToFirstCheckS=round(time.time() - restored, 2))
        result["phases"]["drop"] = outcome
        assert outcome["automaticS"] is not None or outcome.get("audioAtAS") is not None, "media back after the drop"

    for side, page in ((("a", ada), ("b", jonas)) if "loss" in PHASES else ()):
        before = {item["index"]: item for item in stats(page)}
        ctl(f"netem {side} delay 40ms 20ms loss 5%")
        time.sleep(20)
        after = stats(page)
        sel = selected(page)
        ctl(f"netem {side} off")
        lost, packets, jitter, vlost, vpackets, frames = 0, 0, 0.0, 0, 0, 0
        empty = {"audio": {"lost": 0, "packets": 0}, "video": {"lost": 0, "packets": 0, "frames": 0}}
        for item in after:
            if item.get("closed"):
                continue
            prev = before.get(item["index"], {}).get("inbound", empty)
            lost += item["inbound"]["audio"]["lost"] - prev["audio"]["lost"]
            packets += item["inbound"]["audio"]["packets"] - prev["audio"]["packets"]
            jitter = max(jitter, item["inbound"]["audio"]["jitter"])
            vlost += item["inbound"]["video"]["lost"] - prev["video"]["lost"]
            vpackets += item["inbound"]["video"]["packets"] - prev["video"]["packets"]
            frames += item["inbound"]["video"]["frames"] - prev["video"]["frames"]
        outcome = {"profile": f"delay 40ms 20ms loss 5% both ways at router {side.upper()}, 20 s", "path": sel, "audioPacketsReceived": packets,
                   "audioPacketsLost": lost, "lossPct": round(100 * lost / max(1, lost + packets), 2), "maxJitterS": jitter,
                   "videoPacketsReceived": vpackets, "videoPacketsLost": vlost, "videoFramesDecoded": frames,
                   "stillFlowingAfterS": flowing_since(page, 10), "bar": bar_text(page)}
        log("loss", **outcome)
        result["phases"][f"loss-{side}"] = outcome

    if "weak" in PHASES:
        # One weak receiver: Jonas's link (router B) at 400 kbit/s with 3 % loss and 60 ms delay, both ways, while Ada
        # sends camera and microphone. What Jonas receives degrades; what Ada sends and receives must not.
        weak: dict = {"profile": "router B: rate 400kbit, delay 60ms, loss 3%, both ways, 25 s"}
        weak["baselineJonas"], weak["baselineAda"] = window(jonas, 8), window(ada, 4)
        ctl("netem b rate 400kbit delay 60ms loss 3%")
        time.sleep(10)
        weak["weakJonas"], weak["weakAda"] = window(jonas, 8), window(ada, 6)
        weak["barJonas"] = bar_text(jonas)
        ctl("netem b off")
        time.sleep(8)
        weak["afterJonas"] = window(jonas, 6)
        log("weak", **weak)
        result["phases"]["weak"] = weak
        assert weak["weakAda"]["audioKbps"] > 0 and weak["afterJonas"]["videoKbps"] > 0, weak

    if "sfu-restart" in PHASES:
        ctl("restart livekit", timeout=180)
        result["phases"]["sfu-restart"] = recover("sfu-restart", ada, jonas)
        assert result["phases"]["sfu-restart"].get("audioAtAS") is not None or result["phases"]["sfu-restart"]["automaticS"] is not None
        result["phases"]["sfu-restart"]["selectedAfter"] = selected(ada)

    if "api-restart" in PHASES:
        ctl("restart api", timeout=180)
        result["phases"]["api-restart"] = recover("api-restart", ada, jonas)
        assert result["phases"]["api-restart"].get("audioAtAS") is not None or result["phases"]["api-restart"]["automaticS"] is not None

    if "access" in PHASES:
        access: dict = {}
        def answer(page: Page, method: str, path: str) -> str:
            status, data = api(page, method, path)
            return f"{status} {data.get('code', '') if isinstance(data, dict) else ''}".strip()
        access["outsiderList"] = answer(lee, "GET", f"/api/v1/projects/{pid}/live-sessions")
        access["outsiderJoin"] = answer(lee, "POST", f"/api/v1/live-sessions/{sid}/join")
        session = ok(ada, "GET", f"/api/v1/live-sessions/{sid}")
        access["participants"] = sorted(p.get("userId") for p in session.get("participants", []))
        access["onlyHumans"] = set(access["participants"]) <= {ids["ada"], ids["jonas"]}
        issued = tokens[-1] if tokens else ""
        access["capturedIssuedToken"] = bool(issued)
        revoked_at = time.time()
        ok(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": ids["jonas"]}, "role": "denied"}, 201)
        gone = None
        while time.time() - revoked_at < 30:
            live = [item for item in stats(jonas) if not item.get("closed") and item.get("state") not in ("closed", "failed")]
            if not live:
                gone = round(time.time() - revoked_at, 2)
                break
            time.sleep(0.25)
        access["revokedDisconnectedS"] = gone
        access["revokedBar"] = bar_text(jonas)
        access["revokedJoin"] = answer(jonas, "POST", f"/api/v1/live-sessions/{sid}/join")
        access["revokedList"] = answer(jonas, "GET", f"/api/v1/projects/{pid}/live-sessions")
        if issued:
            access["replayValidate"] = jonas.evaluate(
                "async (t) => (await fetch('/media/rtc/validate?access_token=' + encodeURIComponent(t))).status", issued)
            access["replaySocket"] = jonas.evaluate("""(t) => new Promise((resolve) => {
                const s = new WebSocket('wss://flux.sim.test/media/rtc?access_token=' + encodeURIComponent(t) + '&protocol=16&sdk=js');
                const timer = setTimeout(() => { s.close(); resolve('no answer in 10 s'); }, 10000);
                s.onopen = () => { clearTimeout(timer); s.close(); resolve('opened'); };
                s.onerror = () => { clearTimeout(timer); resolve('refused'); };
            })""", issued)
        access["outsiderJoinAfter"] = answer(lee, "POST", f"/api/v1/live-sessions/{sid}/join")
        log("access", **access)
        result["phases"]["access"] = access
        assert access["outsiderList"].startswith("404") and access["outsiderJoin"].startswith("404"), access
        assert access["revokedJoin"].startswith("404") and access["revokedDisconnectedS"] is not None, access
        assert access.get("replayValidate") in (401, 403) and access.get("replaySocket") != "opened", access
        assert access["onlyHumans"], access
    ada.screenshot(path=f"/ctl/{RUN}-end-a.png")


if __name__ == "__main__":
    main()
