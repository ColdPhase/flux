"""Browser driver of the simulated public host (#63). Runs on the simulated Internet, reaches each client's
Playwright server only through that client's NAT router, and drives the real Flux web app at
https://flux.sim.test. Impairments and restarts are asked of scripts/check_public_sim.sh through /ctl.

Environment: FLUX_SIM_BROWSER_A (behind the restrictive router), FLUX_SIM_BROWSER_B (behind the open router), each
BROWSER[+DEVICE] where DEVICE is pixel7, iphone13 or ipad (Playwright's device descriptors: viewport, user agent,
touch); FLUX_SIM_PHASES (comma list of connect, ai-off, four, profiles, screen, drop, loss, weak, sfu-restart,
sfu-update, api-restart, access; or "all"); FLUX_SIM_CALIBRATE=1 records the profile thresholds without enforcing them.
Prints one JSON line per measurement prefixed "SIM " and writes /ctl/result-<run>.json.
"""
from __future__ import annotations

import base64
import json
import os
import re
import time
import uuid

from playwright.sync_api import Page, expect, sync_playwright

import profiles

ORIGIN = "https://flux.sim.test"
RUN = re.sub(r"[^a-z0-9-]", "", f"{os.environ['FLUX_SIM_BROWSER_A']}-{os.environ['FLUX_SIM_BROWSER_B']}-{int(time.time())}".replace("+", "-"))
PHASES = os.environ.get("FLUX_SIM_PHASES", "all")
PHASES = {"connect", "drop", "loss", "weak", "sfu-restart", "api-restart", "access"} if PHASES == "all" else set(PHASES.split(","))
DEVICES = {"pixel7": "Pixel 7", "iphone13": "iPhone 13", "ipad": "iPad (gen 7)"}
DESCRIPTORS: dict = {}  # Playwright's device descriptors, filled in main()


def spec(value: str) -> tuple[str, str | None]:
    """BROWSER[+DEVICE] of one person: the engine and an optional Playwright device descriptor."""
    browser, _, device = value.partition("+")
    return browser, (DEVICES[device] if device else None)
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


def launch_options(browser: str, presenter: bool = False) -> dict:
    """How each simulated person's browser starts on its client.

    A presenter shares a real screen: the browser runs headed on the client's X display, whose content
    `screen-source` sets, and keeps its own window off that screen. Chromium then has no fake devices (its fake
    display would replace the real screen), so its microphone is the client's PulseAudio speech source and it has
    no camera. Everyone else in Chromium has fake devices fed by the synthetic camera and speech files. Firefox
    gets the simulation's CA in its profile through the `firefox-ca` wrapper and fake camera and microphone."""
    if browser == "chromium" and presenter:
        return {"headless": False, "args": ["--use-fake-ui-for-media-stream", "--auto-select-desktop-capture-source=Entire screen",
                                            "--window-position=1920,0", "--window-size=1440,900", "--disable-backgrounding-occluded-windows"]}
    if browser == "chromium":
        return {"args": ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
                         "--use-file-for-fake-video-capture=/media/camera-1080p30.y4m", "--use-file-for-fake-audio-capture=/media/speech.wav"]}
    if browser == "webkit" and presenter:
        # Headed on the client's X display: WebKit asks in its own info bar before sharing a screen, and the person
        # answers it there (allow-display). Playwright's WebKit then shares its mock screen source (1920x1080, 30 fps).
        return {"headless": False}
    if browser == "firefox":
        return {"headless": not presenter, "executablePath": "/usr/local/bin/firefox-ca",
                "firefoxUserPrefs": {"media.navigator.streams.fake": True, "media.navigator.permission.disabled": True}}
    return {}


def connect(pw, browser: str, router: str, port: int = 3000, presenter: bool = False):
    kind = getattr(pw, browser)
    return kind.connect(f"ws://{router}:{port}/", headers={"x-playwright-launch-options": json.dumps(launch_options(browser, presenter))},
                        timeout=60_000)


def new_page(browser, name: str, device: str | None = None) -> Page:
    # Every engine checks the simulation's certificate: Chromium through the client's NSS database, WebKit through
    # the system store and Firefox through its profile database (firefox-ca).
    options: dict = {"viewport": {"width": 1440, "height": 900}}
    if device:
        options = {k: v for k, v in DESCRIPTORS[device].items() if k != "default_browser_type"}
        if browser.browser_type.name == "firefox":  # Playwright does not emulate is_mobile or touch for Firefox.
            options.pop("is_mobile", None)
            options.pop("has_touch", None)
    context = browser.new_context(base_url=ORIGIN, locale="en-GB", **options)
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
    """Creates the account through the sign-up page. Every simulated person behind one router shares its public
    address, so many runs in a row can meet the sign-up rate limit of the authentication server (HTTP 429); the
    person then waits and tries again, as a person would."""
    for attempt in range(5):
        statuses: list[int] = []
        page.on("response", lambda r: statuses.append(r.status) if "/sign-up" in r.url and r.request.method == "POST" else None)
        page.goto("/sign-up")
        page.get_by_label("Name").fill(name)
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        try:
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible(timeout=20_000)
            return ok(page, "GET", "/api/v1/me")["user"]["id"]
        except AssertionError:
            log("sign-up", who=name, attempt=attempt + 1, statuses=statuses, url=page.url)
            page.screenshot(path=f"/ctl/{RUN}-sign-up-{name.split()[0].lower()}-{attempt + 1}.png")
            if 429 not in statuses and attempt:
                raise
            time.sleep(12)
    raise AssertionError(f"sign-up of {name} did not finish")


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
        # textContent, not innerText: on a phone the strip shows the state as a dot and keeps the word for
        # assistive technology only.
        return (bar(page).get_by_role("status").first.text_content(timeout=1_000) or "").strip()
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

JWT = re.compile(rb"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")


def watch_signal_tokens(page: Page, seen: list[str]) -> None:
    """Keeps every JWT the SFU sends this page over the signalling WebSocket: LiveKit refreshes the join token
    there (its `refreshToken` message), so a refreshed token can be replayed after access is removed."""
    def on_socket(socket) -> None:
        def frame(payload) -> None:
            data = payload if isinstance(payload, bytes) else str(payload).encode()
            for match in JWT.findall(data):
                token = match.decode()
                if token not in seen:
                    seen.append(token)
        socket.on("framereceived", frame)
    page.on("websocket", on_socket)


def main() -> None:
    result = RESULT
    four = "four" in PHASES
    presenting = bool(PHASES & {"profiles", "screen"})
    with sync_playwright() as pw:
        DESCRIPTORS.update(pw.devices)
        (engine_a, device_a), (engine_b, device_b) = spec(os.environ["FLUX_SIM_BROWSER_A"]), spec(os.environ["FLUX_SIM_BROWSER_B"])
        browser_a = connect(pw, engine_a, "203.0.113.101", presenter=presenting)
        browser_b = connect(pw, engine_b, "203.0.113.102")
        browsers = [browser_a, browser_b]
        result["versions"] = {"a": f"{os.environ['FLUX_SIM_BROWSER_A']} {browser_a.version}",
                              "b": f"{os.environ['FLUX_SIM_BROWSER_B']} {browser_b.version}"}
        if four:
            # Mia shares a second screen from client C (behind router A); Tom only receives, on client D (router B).
            browser_c = connect(pw, "chromium", "203.0.113.101", 3001, presenter=True)
            browser_d = connect(pw, "chromium", "203.0.113.102", 3001)
            browsers += [browser_c, browser_d]
            result["versions"].update(c=f"chromium {browser_c.version}", d=f"chromium {browser_d.version}")
        log("browsers", **result["versions"])
        expect.set_options(timeout=30_000)
        stamp = int(time.time() * 1000)
        ada, jonas = new_page(browser_a, "ada", device_a), new_page(browser_b, "jonas", device_b)
        lee = new_page(browser_b, "lee")
        people = {"ada": ("Ada Kowalska", ada), "jonas": ("Jonas Berg", jonas), "lee": ("Lee Park", lee)}
        if four:
            people.update(mia=("Mia Novak", new_page(browser_c, "mia")), tom=("Tom Reyes", new_page(browser_d, "tom")))
        ids = {who: sign_up(page, name, f"{who}.sim+{stamp}@example.test") for who, (name, page) in people.items()}
        pages = {who: page for who, (_, page) in people.items()}
        ws = ok(ada, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        for who in people:
            if who != "ada":
                ok(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": f"{who}.sim+{stamp}@example.test", "role": "member"}, 201)
        pid = ok(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, 201)["id"]
        for who in people:
            if who not in ("ada", "lee"):
                ok(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": ids[who]}, "role": "contributor"}, 201)
        doc = ok(ada, "POST", f"/api/v1/projects/{pid}/docs", {"title": DOC, "body": "## Path\n\nTURN over TLS on 443.", "state": "published",
                                                               "reason": "Notes for the call"}, 201, {"idempotency-key": str(uuid.uuid4())})
        url = f"/projects/{pid}/docs/{doc['id']}"
        if "ai-off" in PHASES:
            # The workspace administrator turns AI off for the whole workspace before anyone calls (F-029).
            version = ok(ada, "GET", f"/api/v1/workspaces/{ws['id']}").get("ai", {}).get("version", 1)
            policy = ok(ada, "PUT", f"/api/v1/workspaces/{ws['id']}/ai-policy", {"state": "blocked", "expectedVersion": version})
            result["phases"]["ai-off"] = {"policy": policy.get("ai"), "changed": policy.get("changed")}
            log("ai-off", **result["phases"]["ai-off"])
            assert (policy.get("ai") or {}).get("state") == "blocked", policy
        tokens: list[str] = []
        jonas.on("response", lambda r: tokens.append(r.json().get("token", "")) if re.search(r"/live-sessions/[^/]+/join$", r.url) and r.status == 200 else None)
        signal_tokens: list[str] = []
        watch_signal_tokens(jonas, signal_tokens)

        if "turn-tls-probe" in PHASES:
            turn_tls_probe(ada, jonas, url, result)
            for browser in browsers:
                browser.close()
            with open(f"/ctl/result-{RUN}.json", "w") as handle:
                json.dump(result, handle, indent=1)
            log("done", run=RUN)
            return
        try:
            connect_phase(ada, jonas, url, result)
            if four:
                for who in ("mia", "tom"):
                    join_page(pages[who], url)
                microphone_on(pages["mia"])
                result["phases"]["four"] = {"live": {who: live_status(pages[who]) for who in ("ada", "jonas", "mia", "tom")},
                                            "selectedMia": selected(pages["mia"]), "selectedTom": selected(pages["tom"])}
                log("four", **result["phases"]["four"])
                assert all(state == "Live" for state in result["phases"]["four"]["live"].values()), result["phases"]["four"]
        except Exception:
            for who, page in pages.items():
                try:
                    page.screenshot(path=f"/ctl/{RUN}-failed-{who}.png")
                except Exception:
                    pass
            diagnose(ada, "ada")
            diagnose(jonas, "jonas")
            raise
        sid = ok(ada, "GET", f"/api/v1/projects/{pid}/live-sessions")["items"][0]["id"]
        if "ai-off" in PHASES:
            session = ok(ada, "GET", f"/api/v1/live-sessions/{sid}")
            current = ok(ada, "GET", f"/api/v1/workspaces/{ws['id']}")
            result["phases"]["ai-off"].update(participants=sorted(p.get("userId") for p in session.get("participants", [])),
                                              workspaceAi=current.get("ai"), callAudioBothWays=True)
            assert set(result["phases"]["ai-off"]["participants"]) <= {ids["ada"], ids["jonas"]}, result["phases"]["ai-off"]
        if PHASES & {"profiles", "screen"}:
            profiles.run(PHASES, pages, result, ctl, log, RUN, engine_a, calibrate=os.environ.get("FLUX_SIM_CALIBRATE") == "1")
        _phases(ada, jonas, lee, ids, pid, sid, tokens, signal_tokens, result)
        for browser in browsers:
            browser.close()
    with open(f"/ctl/result-{RUN}.json", "w") as handle:
        json.dump(result, handle, indent=1)
    log("done", run=RUN)


def turn_tls_probe(ada: Page, jonas: Page, url: str, result: dict) -> None:
    """What browser A sends to TURN/TLS when only TCP/443 leaves its network (an observation, not a pass).

    Records whether the join relayed and the first bytes A's browser sent to the media host's TCP/443, captured on
    router A: 0x16 is a TLS ClientHello, 0x0003 a plain TURN Allocate request."""
    import threading
    sniffed: dict = {}
    thread = threading.Thread(target=lambda: sniffed.update(out=ctl("sniff a", timeout=60)))
    thread.start()
    time.sleep(1)
    probe: dict = {}
    try:
        connect_phase(ada, jonas, url, result)
        probe["relayed"] = True
    except Exception as error:
        probe["relayed"] = False
        probe["error"] = str(error)[:300]
        diagnose(ada, "ada")
    thread.join()
    packets: list[str] = []
    for line in sniffed.get("out", "").splitlines():
        line = line.strip()
        if line.startswith("0x0000:"):
            packets.append("")
        if line.startswith("0x") and packets:
            packets[-1] += "".join(line.split(":", 1)[1].split()[:8])
    probe["packetsSeen"] = len(packets)
    probe["packets"] = [re.sub(r"^\S+ ", "", line.strip())[:110] for line in sniffed.get("out", "").splitlines() if " IP " in f" {line}" and " > " in line][:12]
    first_byte = ""
    if packets:
        raw = packets[0]
        ihl = int(raw[1], 16) * 4
        tcp = int(raw[2 * (ihl + 12)], 16) * 4
        payload = raw[2 * (ihl + tcp):]
        probe["firstPayloadHex"] = payload[:32]
        first_byte = payload[:2]
    probe["firstPayloadByte"] = first_byte
    probe["looksLike"] = {"16": "TLS ClientHello", "00": "plain TURN (STUN) over TCP"}.get(first_byte, "unknown")
    result["phases"]["turn-tls-probe"] = probe
    log("turn-tls-probe", **probe)


def join_page(page: Page, url: str) -> None:
    page.goto(url)
    join = page.locator("header.top, header.phead").get_by_role("button", name="Join")
    expect(join).to_be_visible()
    join.click()
    expect(bar(page).get_by_role("status").first).to_contain_text("Live")


def connect_phase(ada: Page, jonas: Page, url: str, result: dict) -> None:
    # Connect: Ada (restrictive network) starts, Jonas (open network) joins, both turn the microphone on.
    t0 = time.time()
    ada.goto(url)
    expect(ada.get_by_role("heading", name=DOC, level=2)).to_be_visible()
    ada.locator("header.top, header.phead").get_by_role("button", name="Together").click()
    expect(bar(ada).get_by_role("status").first).to_contain_text("Live")
    join_page(jonas, url)
    microphone_on(ada)
    microphone_on(jonas)
    # A presenter's browser has no camera (it shares the real screen of its client instead).
    try:
        if not PHASES & {"profiles", "screen"}:
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
    relay = os.environ.get("FLUX_SIM_A_RELAY") or "tls"
    if relay == "ice-tcp":
        # UDP blocked, TCP/7881 allowed: A reaches the SFU directly over ICE/TCP, without TURN or TLS.
        assert sel_a and all(s["localType"] != "relay" and s["localProtocol"] == "tcp" and s["remotePort"] == 7881 for s in sel_a), f"A uses ICE/TCP: {sel_a}"
        ada.screenshot(path=f"/ctl/{RUN}-connected-a.png")
        return
    # WebKit leaves relayProtocol out of its stats; its candidate's TURN URL then names the transport.
    scheme = "turns:" if relay == "tls" else "turn:"
    assert sel_a and all(s["localType"] == "relay" and (s["relayProtocol"] == relay or (
        s["relayProtocol"] is None and str(s.get("url") or "").startswith(scheme))) for s in sel_a), f"A relays over {relay}: {sel_a}"
    ada.screenshot(path=f"/ctl/{RUN}-connected-a.png")
    jonas.screenshot(path=f"/ctl/{RUN}-connected-b.png")


def _phases(ada: Page, jonas: Page, lee: Page, ids: dict, pid: str, sid: str, tokens: list, signal_tokens: list, result: dict) -> None:

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
        if outcome["automaticS"] is None and outcome.get("audioAtAS") is None:
            diagnose(ada, "ada")
            log("counters", out=ctl("counters a"))
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

    if "sfu-update" in PHASES:
        # The documented SFU upgrade (docs/development/live-media.md, Compose deployment): a new pinned image, then
        # a rollback to the previous digest. Each recreates the SFU container, so the call rejoins as after a restart.
        update: dict = {}
        for step in ("update", "rollback"):
            output = ctl(f"{step} livekit", timeout=240)
            update[step] = recover(f"sfu-{step}", ada, jonas)
            update[step]["image"] = output.strip().splitlines()[-1] if output.strip() else ""
            update[step]["selectedAfter"] = selected(ada)
            assert update[step].get("audioAtAS") is not None or update[step]["automaticS"] is not None, update
        result["phases"]["sfu-update"] = update

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
        # LiveKit sends a refreshed token over the signalling socket soon after the join; wait for it.
        deadline = time.time() + 40
        refreshed = ""
        while time.time() < deadline and not refreshed:
            refreshed = next((t for t in reversed(signal_tokens) if t not in tokens), "")
            time.sleep(0.5)
        access["capturedRefreshedToken"] = bool(refreshed)
        if refreshed and issued:
            claims = [json.loads(base64.urlsafe_b64decode(t.split(".")[1] + "==")) for t in (issued, refreshed)]
            access["refreshedSameRoom"] = claims[0].get("video", {}).get("room") == claims[1].get("video", {}).get("room")
            access["refreshedLaterExpiry"] = claims[1].get("exp", 0) >= claims[0].get("exp", 0)
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
        for key, token in (("replay", issued), ("refreshedReplay", refreshed)):
            if not token:
                continue
            access[f"{key}Validate"] = jonas.evaluate(
                "async (t) => (await fetch('/media/rtc/validate?access_token=' + encodeURIComponent(t))).status", token)
            access[f"{key}Socket"] = jonas.evaluate("""(t) => new Promise((resolve) => {
                const s = new WebSocket('wss://flux.sim.test/media/rtc?access_token=' + encodeURIComponent(t) + '&protocol=16&sdk=js');
                const timer = setTimeout(() => { s.close(); resolve('no answer in 10 s'); }, 10000);
                s.onopen = () => { clearTimeout(timer); s.close(); resolve('opened'); };
                s.onerror = () => { clearTimeout(timer); resolve('refused'); };
            })""", token)
        access["outsiderJoinAfter"] = answer(lee, "POST", f"/api/v1/live-sessions/{sid}/join")
        log("access", **access)
        result["phases"]["access"] = access
        assert access["outsiderList"].startswith("404") and access["outsiderJoin"].startswith("404"), access
        assert access["revokedJoin"].startswith("404") and access["revokedDisconnectedS"] is not None, access
        assert access.get("replayValidate") in (401, 403) and access.get("replaySocket") != "opened", access
        assert access["capturedRefreshedToken"] and access.get("refreshedSameRoom"), access
        assert access.get("refreshedReplayValidate") in (401, 403) and access.get("refreshedReplaySocket") != "opened", access
        assert access["onlyHumans"], access
    ada.screenshot(path=f"/ctl/{RUN}-end-a.png")


if __name__ == "__main__":
    main()
