"""Browser journeys for live work sessions (issue #62, contract #59).

Two modes:

* In the ordinary ``scripts/check_ui.sh`` run the server has no media server. The tests check
  that the interface says so calmly and that ordinary work is unaffected.
* ``scripts/check_live_ui.sh`` runs the same file with ``FLUX_UI_LIVE=1`` against the pinned
  self-hosted LiveKit SFU. Real Chromium clients with Chromium's fake microphone, camera and
  screen then go through the required journey twice: two people, then four — blocked task →
  join → show a fragment and a screen → save a result → leave.

Fake devices and one local network are local evidence only. Physical devices, restrictive
networks and TURN are verified in #63.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

LIVE = os.environ.get("FLUX_UI_LIVE") == "1"
PASSWORD = "work on it together calmly"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": {"name": "Ada Kowalska", "email": f"ada.live+{STAMP}@example.test"},
    "jonas": {"name": "Jonas Berg", "email": f"jonas.live+{STAMP}@example.test"},
    "nia": {"name": "Nia Okafor", "email": f"nia.live+{STAMP}@example.test"},
    "kai": {"name": "Kai Moreau", "email": f"kai.live+{STAMP}@example.test"},
    "lee": {"name": "Lee Park", "email": f"lee.live+{STAMP}@example.test"},
}
TABLET = {"width": 820, "height": 1180}
SMALL_DESKTOP = {"width": 1280, "height": 800}
TASK = "Test the night camera on the lamp board"
BLOCKER = "Night-mode frames come out black on board rev B; need a second pair of eyes on the capture settings"
DOC = "Low-light test protocol"
DOC_BODY = """## Setup

Dark room, lamp at 1.2 m, 20 waves per light level. Count a wave as caught when the LED ring answers within 300 ms.

## Levels

| Light | Caught | Notes |
| --- | --- | --- |
| 200 lux | 97% | daylight reference |
| 50 lux | 71% | desk lamp only |
| 5 lux | 38% | night light |

## Open question

Rev B uses the IR-cut filter from the old supplier. Check whether night mode actually switches it off.
"""

# Counts every capture request and every media signaling socket, so a test can prove that
# joining asked for nothing and that navigation kept one connection.
INSTRUMENT = """
(() => {
  const state = { gum: 0, gdm: 0, tracks: [], sockets: 0, gumConstraints: [], rtc: [] };
  Object.defineProperty(window, '__live', { value: state });
  const md = navigator.mediaDevices;
  if (md) {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      state.gum += 1; state.gumConstraints.push(JSON.stringify(constraints));
      if (window.__denyCamera && constraints && constraints.video) throw new DOMException('Permission denied', 'NotAllowedError');
      const stream = await gum(constraints);
      stream.getTracks().forEach((track) => state.tracks.push(track));
      // A test can hold a capture as a slow permission prompt would, then release it later.
      if (window.__holdCapture) await new Promise((resolve) => { window.__releaseCapture = resolve; });
      return stream;
    };
    if (md.getDisplayMedia) {
      const gdm = md.getDisplayMedia.bind(md);
      md.getDisplayMedia = async (constraints) => {
        state.gdm += 1;
        const stream = await gdm(constraints);
        stream.getTracks().forEach((track) => state.tracks.push(track));
        return stream;
      };
    }
    const enumerate = md.enumerateDevices.bind(md);
    md.enumerateDevices = async () => {
      const list = await enumerate();
      return window.__noCamera ? list.filter((device) => device.kind !== 'videoinput') : list;
    };
  }
  const Native = window.WebSocket;
  // A test can hold the media server's answers (for example "track published") and release them
  // in order later, so a publication stays pending after capture has finished.
  const heldSignals = [];
  window.__releaseSignals = () => { window.__holdSignals = false; heldSignals.splice(0).forEach(([socket, data]) => { const event = new MessageEvent('message', { data }); event.__released = true; socket.dispatchEvent(event); }); };
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      if (!String(url).includes('/rtc')) return;
      state.sockets += 1;
      state.rtc.push(this);
      this.addEventListener('message', (event) => {
        if (!window.__holdSignals || event.__released) return;
        event.stopImmediatePropagation();
        heldSignals.push([this, event.data]);
      });
    }
  };
})();
"""


def live_tracks(page: Page) -> list[dict]:
    return page.evaluate("() => window.__live.tracks.map((t) => ({ kind: t.kind, state: t.readyState, label: t.label }))")


class LiveBase(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=[
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            "--auto-select-desktop-capture-source=Entire screen",
            "--enable-usermedia-screen-capturing",
        ])
        expect.set_options(timeout=15000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, viewport: dict | None = None, phone: bool = False, reduced: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1)
        if reduced:
            options["reduced_motion"] = "reduce"
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        context.grant_permissions(["microphone", "camera"], origin=ORIGIN)
        context.add_init_script(INSTRUMENT)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None):
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def seed(self) -> None:
        if self.ids:
            return
        for key, person in PEOPLE.items():
            if key in self.states:
                continue
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
            page.context.close()
        ada, jonas, nia = self.page("ada"), self.page("jonas"), self.page("nia")
        ws = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, status=201)
        for key in ("jonas", "nia", "kai", "lee"):
            self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE[key]["email"], "role": "member"}, status=201)
        project = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        pid = project["id"]
        for key in ("jonas", "nia", "kai"):
            self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": PEOPLE[key]["id"]}, "role": "contributor"}, status=201)
        thread = self.api(nia, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "The night camera test is stuck: frames are black on rev B. Can someone look with me?", "clientMessageId": str(uuid.uuid4())}, status=201)
        for page, body in ((jonas, "I can look after lunch. Is it the IR-cut filter again?"), (nia, "Maybe. The old supplier's filter never switches off in night mode."),
                           (ada, "Let's do it together at the task so the result lands in the right place.")):
            self.api(page, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, status=201)
        base = f"/api/v1/projects/{pid}"
        work = self.api(nia, "POST", f"{base}/work", {"title": TASK, "outcome": "Know whether rev B can see gestures at 5 lux", "owner": {"kind": "human", "id": PEOPLE["nia"]["id"]},
                                                       "status": "blocked", "blocker": BLOCKER, "sources": [{"type": "message", "id": thread["messages"][0]["id"]}]}, status=201)
        self.api(jonas, "POST", f"{base}/work", {"title": "Order two VL53L5CX boards", "owner": {"kind": "human", "id": PEOPLE["jonas"]["id"]}}, status=201)
        doc = self.api(ada, "POST", f"{base}/docs", {"title": DOC, "body": DOC_BODY, "state": "published", "reason": "Protocol for the camera tests"}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        sketch = self.api(jonas, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Why are night frames black?", "scope": "project", "projectId": pid}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        root = self.api(jonas, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Black frames at 5 lux on rev B", "x": 0, "y": 0}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        thoughts = []
        for index, text in enumerate(("IR-cut filter stays in", "Exposure capped at 33 ms", "Wrong sensor mode in firmware")):
            made = self.api(jonas, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": text, "x": -260 + index * 260, "y": 170, "linkFrom": {"thoughtId": root["thought"]["id"]}}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
            thoughts.append(made["thought"]["id"])
        type(self).ids = {"workspace": ws["id"], "project": pid, "conversation": thread["id"], "work": work["id"], "doc": doc["id"], "sketch": sketch["id"], "filter": thoughts[0]}
        for page in (ada, jonas, nia):
            page.context.close()

    def task_url(self) -> str:
        return f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['work']}"

    def bar(self, page: Page):
        return page.get_by_role("region", name="Live session")


@unittest.skipIf(LIVE, "the media server is configured in this run")
class LiveUnavailable(LiveBase):
    """Without a media server the interface explains it once and ordinary work continues."""

    def test_01_unavailable_is_explained_and_work_is_unchanged(self) -> None:
        self.seed()
        page = self.page("nia")
        page.goto(self.task_url())
        panel = page.locator("#details")
        expect(panel.get_by_role("heading", name=TASK)).to_be_visible()
        expect(panel).to_contain_text("Live sessions are not set up on this Flux server")
        header = page.locator("header.top")
        header.get_by_role("button", name="Together").click()
        dialog = page.get_by_role("dialog", name="Live sessions")
        expect(dialog).to_contain_text("no media server configured")
        page.keyboard.press("Escape")
        expect(dialog).to_be_hidden()
        self.assertEqual(page.evaluate("window.__live.gum + window.__live.gdm"), 0, "nothing asked for a device")
        expect(self.bar(page)).to_have_count(0)
        self.assertEqual(self.api(page, "GET", "/api/v1/live-sessions/capabilities", status=200)["status"], "unavailable")


@unittest.skipUnless(LIVE, "set FLUX_UI_LIVE=1 with the live media profile (scripts/check_live_ui.sh)")
class LiveJourney(LiveBase):
    """Tests run in name order and share accounts, one project and its sessions."""

    def test_01_two_people_blocker_join_show_screen_result_leave(self) -> None:
        self.seed()
        nia = self.page("nia")
        nia.goto(self.task_url())
        panel = nia.locator("#details")
        expect(panel.get_by_role("heading", name=TASK)).to_be_visible()
        expect(panel).to_contain_text(f"Blocked: {BLOCKER}")
        start = panel.get_by_role("button", name="Work on this together")
        expect(start).to_be_visible()
        expect(panel).to_contain_text("Ada, Jonas and Kai can join")
        shot(nia, "live-desktop-1440-blocked-task")

        # AC-1: one action, no wizard, no device prompt.
        start.click()
        bar = self.bar(nia)
        expect(bar.get_by_role("status").first).to_contain_text("Live")
        expect(bar.get_by_role("button", name=re.compile(re.escape(TASK)))).to_be_visible()
        self.assertEqual(nia.evaluate("window.__live.gum + window.__live.gdm"), 0, "starting and joining request no microphone, camera or screen")
        mic = bar.get_by_role("button", name=re.compile("^Microphone off"))
        expect(mic).to_have_attribute("aria-pressed", "false")
        expect(panel).to_contain_text("You are in the live session for this task")
        work_before = self.api(nia, "GET", f"/api/v1/work/{self.ids['work']}", status=200)
        self.assertEqual(work_before["status"], "blocked", "starting a session changes no work status")

        # A targeted invitation: one quiet inbox item with join, later and text.
        bar.get_by_role("button", name="Session details and more").click()
        details = nia.get_by_role("dialog", name="Live session")
        expect(details.get_by_role("heading", name=TASK)).to_be_visible()
        row = details.locator(".lv-person--absent", has_text="Jonas Berg")
        row.get_by_role("button", name="Invite").click()
        expect(row).to_contain_text("Invited")
        shot(nia, "live-desktop-1440-panel")
        nia.keyboard.press("Escape")
        expect(details).to_be_hidden()
        expect(bar.get_by_role("button", name="Session details and more")).to_be_focused()
        # Inviting again stays one inbox item (the server deduplicates).
        sessions = self.api(nia, "GET", f"/api/v1/projects/{self.ids['project']}/live-sessions", status=200)["items"]
        session_id = next(item["id"] for item in sessions if item["context"]["id"] == self.ids["work"])
        type(self).ids["session1"] = session_id
        self.api(nia, "POST", f"/api/v1/live-sessions/{session_id}/invitations", {"recipientId": PEOPLE["jonas"]["id"]}, status=201)

        jonas = self.page("jonas")
        jonas.goto("/inbox")
        item = jonas.get_by_role("link", name=re.compile("Nia Okafor invited you to work together"))
        expect(item).to_have_count(1)
        expect(item).to_contain_text(TASK)
        shot(jonas, "live-desktop-1440-inbox")
        item.click()
        card = jonas.get_by_role("region", name="Invitation to work together")
        expect(card).to_contain_text("Nia Okafor asked you to work together on")
        expect(card.get_by_role("button", name="Later")).to_be_visible()
        expect(card.get_by_role("button", name="Reply in text")).to_be_visible()
        shot(jonas, "live-desktop-1440-invitation")
        card.get_by_role("button", name="Join").click()
        jbar = self.bar(jonas)
        expect(jbar.get_by_role("status").first).to_contain_text("Live")
        self.assertEqual(jonas.evaluate("window.__live.gum + window.__live.gdm"), 0, "joining requests no device")
        expect(jbar.locator(".lv-face")).to_have_count(2)
        expect(self.bar(nia).locator(".lv-face")).to_have_count(2)

        # Explicit microphone: only now does the browser capture, and the other side hears it.
        mic.click()
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Microphone on"))).to_have_attribute("aria-pressed", "true")
        self.assertEqual(nia.evaluate("window.__live.gum"), 1)
        expect(jonas.locator("[data-live-audio] audio")).to_have_count(1)
        jbar.get_by_role("button", name="Session details and more").click()
        jdetails = jonas.get_by_role("dialog", name="Live session")
        expect(jdetails.locator(".lv-person", has_text="Nia Okafor")).to_contain_text("microphone on")
        jonas.keyboard.press("Escape")

        # AC-2: navigation keeps one connection; showing a doc does not move anybody.
        tabs = nia.get_by_role("navigation", name="Project views")
        tabs.get_by_role("link", name=re.compile("^Docs")).click()
        nia.get_by_role("link", name=re.compile(DOC)).click()
        expect(nia.get_by_role("heading", name=DOC, level=2)).to_be_visible()
        expect(self.bar(nia)).to_be_visible()
        self.assertEqual(nia.evaluate("window.__live.sockets"), 1, "one media connection across routes")
        jonas_url = jonas.url
        self.bar(nia).get_by_role("button", name="Show this").click()
        shown = self.bar(jonas).locator(".lv-line--shown")
        expect(shown).to_contain_text(f"Nia Okafor is showing “{DOC}”")
        expect(shown).to_contain_text("doc · version 1")
        self.assertEqual(jonas.url, jonas_url, "a shown fragment never moves the recipient")
        shot(jonas, "live-desktop-1440-shown-fragment")
        shown.get_by_role("button", name="Follow Nia").click()
        expect(jonas).to_have_url(re.compile(f"/docs/{self.ids['doc']}$"))
        expect(jonas.get_by_role("heading", name=DOC, level=2)).to_be_visible()
        # Following opens the next fragment: selected thoughts on the map.
        tabs.get_by_role("link", name=re.compile("^Map")).click()
        nia.get_by_role("link", name=re.compile("Why are night frames black")).click()
        nia.get_by_text("IR-cut filter stays in").first.click()
        self.bar(nia).get_by_role("button", name="Show this").click()
        expect(jonas).to_have_url(re.compile(f"/map/{self.ids['sketch']}$"))
        expect(self.bar(jonas)).to_contain_text("“IR-cut filter stays in” · thought on")
        expect(self.bar(jonas).get_by_role("button", name="Stop following")).to_be_visible()
        expect(jonas.locator(f'.sk-node[data-id="{self.ids["filter"]}"]')).to_have_attribute("aria-pressed", "true")
        # Independent navigation ends following, calmly.
        jonas.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Tasks")).click()
        expect(jonas.get_by_text("Stopped following Nia Okafor")).to_be_visible()
        expect(self.bar(jonas).get_by_role("button", name="Stop following")).to_have_count(0)
        self.assertEqual(jonas.evaluate("window.__live.sockets"), 1)

        # External screen: explicit browser picker (auto-selected by the fake UI here).
        self.bar(nia).get_by_role("button", name="Share a window, tab or screen").click()
        expect(self.bar(nia).get_by_role("button", name="Stop sharing your screen")).to_have_attribute("aria-pressed", "true")
        expect(self.bar(nia)).to_contain_text("You are sharing your screen")
        self.assertEqual(nia.evaluate("window.__live.gdm"), 1)
        screen = self.bar(jonas).get_by_role("button", name=re.compile("Nia.s screen"))
        screen.click()
        stage = jonas.get_by_role("region", name="Shared screens and cameras")
        video = stage.locator("video.lv-stage__video")
        expect(video).to_be_visible()
        jonas.wait_for_function("() => { const v = document.querySelector('video.lv-stage__video'); return v && v.videoWidth > 0; }", timeout=20000)
        stage.get_by_role("button", name="1:1").click()
        expect(stage.get_by_role("button", name="1:1")).to_have_attribute("aria-pressed", "true")
        stage.get_by_role("button", name="Zoom in").click()
        expect(stage).to_contain_text("125%")
        shot(jonas, "live-desktop-1440-stage-one-screen")
        jonas.keyboard.press("Escape")
        expect(stage).to_be_hidden()

        # A persisted result through the ordinary task action, during the session (no reload).
        jonas.get_by_text(TASK).first.click()
        jpanel = jonas.locator("#details")
        expect(jpanel.get_by_role("heading", name=TASK)).to_be_visible()
        # The result is saved through the ordinary work API while the session runs; the form
        # itself is covered by tests/ui/test_work_decisions.py.
        self.api(jonas, "POST", f"/api/v1/projects/{self.ids['project']}/results", {
            "title": "IR-cut filter stays in on rev B; night mode works with it removed", "finding": "positive",
            "evidence": "Filter out: 18 of 20 waves caught at 5 lux. Filter in: 0 of 20.", "work": [self.ids["work"]]}, status=201,
            headers={"idempotency-key": str(uuid.uuid4())})
        self.assertEqual(self.api(jonas, "GET", f"/api/v1/work/{self.ids['work']}", status=200)["status"], "blocked", "a result does not change status by itself")
        self.assertEqual(jonas.evaluate("window.__live.sockets"), 1, "saving the result kept the one connection")

        # Leaving releases every device; saved work stays; nothing is generated.
        self.bar(nia).get_by_role("button", name="Leave", exact=True).click()
        expect(self.bar(nia)).to_have_count(0)
        nia.wait_for_function("() => window.__live.tracks.every((t) => t.readyState === 'ended')")
        expect(self.bar(jonas).locator(".lv-face")).to_have_count(1)
        self.bar(jonas).get_by_role("button", name="Leave", exact=True).click()
        expect(jonas.get_by_text(re.compile("Nobody else was here"))).to_be_visible()
        results = self.api(jonas, "GET", f"/api/v1/projects/{self.ids['project']}/results", status=200)
        items = results["items"] if isinstance(results, dict) else results
        self.assertTrue(any("IR-cut filter stays in" in item["title"] for item in items), "the result is saved in the project")
        self.assertEqual(self.api(jonas, "GET", f"/api/v1/docs/{self.ids['doc']}", status=200)["version"], 1, "showing a doc made no new version")
        docs = self.api(jonas, "GET", f"/api/v1/projects/{self.ids['project']}/docs", status=200)
        self.assertEqual(len(docs["items"] if isinstance(docs, dict) else docs), 1, "no meeting report or empty doc was generated")

    def test_02_four_people_two_screens_quiet_and_device_problems(self) -> None:
        self.seed()
        ada = self.page("ada")
        ada.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}")
        expect(ada.get_by_role("heading", name=DOC, level=2)).to_be_visible()
        ada.locator("header.top").get_by_role("button", name="Together").click()
        expect(self.bar(ada).get_by_role("button", name=re.compile(re.escape(DOC)))).to_be_visible()

        pages = {"ada": ada}
        for who in ("jonas", "nia", "kai"):
            page = self.page(who, viewport=SMALL_DESKTOP) if who == "kai" else self.page(who)
            if who == "kai":
                page.add_init_script("window.__denyCamera = true;")
            page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}")
            join = page.locator("header.top").get_by_role("button", name="Join")
            expect(join).to_be_visible()
            join.click()
            expect(self.bar(page).get_by_role("status").first).to_contain_text("Live")
            pages[who] = page
        for page in pages.values():
            expect(self.bar(page).locator(".lv-face")).to_have_count(4)
            self.assertEqual(page.evaluate("window.__live.gum + window.__live.gdm"), 0)

        # Refusal is truthful: Kai's camera is blocked, nothing is shown as sending.
        kai = pages["kai"]
        self.bar(kai).get_by_role("button", name=re.compile("^Camera off")).click()
        blocked = self.bar(kai).get_by_role("button", name=re.compile("Camera blocked by the browser"))
        expect(blocked).to_have_attribute("aria-pressed", "false")
        # Missing hardware: no camera at all is said before any prompt.
        jonas = pages["jonas"]
        jonas.evaluate("window.__noCamera = true")
        before = jonas.evaluate("window.__live.gum")
        self.bar(jonas).get_by_role("button", name=re.compile("^Camera off")).click()
        expect(self.bar(jonas).get_by_role("button", name=re.compile("No camera found"))).to_be_visible()
        self.assertEqual(jonas.evaluate("window.__live.gum"), before, "no prompt when there is no camera")

        # Cameras on for two people: stable tiles.
        self.bar(ada).get_by_role("button", name=re.compile("^Camera off")).click()
        self.bar(pages["nia"]).get_by_role("button", name=re.compile("^Camera off")).click()
        expect(self.bar(ada).get_by_role("button", name=re.compile("^Camera on"))).to_be_visible()

        # Two simultaneous screens with an explicit focus choice for each viewer.
        self.bar(pages["nia"]).get_by_role("button", name="Share a window, tab or screen").click()
        self.bar(kai).get_by_role("button", name="Share a window, tab or screen").click()
        two = self.bar(ada).get_by_role("button", name="2 screens")
        expect(two).to_be_visible()
        two.click()
        stage = ada.get_by_role("region", name="Shared screens and cameras")
        picks = stage.get_by_role("radiogroup")
        expect(picks.get_by_role("radio")).to_have_count(2)
        picks.get_by_role("radio", name=re.compile("Kai.s screen")).click()
        expect(picks.get_by_role("radio", name=re.compile("Kai.s screen"))).to_have_attribute("aria-checked", "true")
        ada.wait_for_function("() => { const v = document.querySelector('video.lv-stage__video'); return v && v.videoWidth > 0; }", timeout=20000)
        expect(stage.locator(".lv-cam")).to_have_count(2)
        shot(ada, "live-desktop-1440-stage-two-screens")
        stage.get_by_role("button", name="Back to work").click()
        expect(stage).to_be_hidden()
        expect(ada.get_by_role("heading", name=DOC, level=2)).to_be_visible()
        shot(ada, "live-desktop-1440-four-people")
        shot(kai, "live-desktop-1280-four-people")

        # Quiet stops outgoing devices and incoming audio; return stays muted.
        nia = pages["nia"]
        self.bar(nia).get_by_role("button", name=re.compile("^Microphone off")).click()
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Microphone on"))).to_be_visible()
        self.bar(nia).get_by_role("button", name="Session details and more").click()
        dialog = nia.get_by_role("dialog", name="Live session")
        dialog.get_by_role("switch", name=re.compile("Work quietly")).click()
        nia.keyboard.press("Escape")
        expect(self.bar(nia).get_by_role("status").first).to_contain_text("Quiet")
        nia.wait_for_function("() => window.__live.tracks.every((t) => t.readyState === 'ended')")
        self.assertTrue(nia.evaluate("[...document.querySelectorAll('[data-live-audio] audio')].every((a) => a.muted)"), "incoming audio is off")
        expect(self.bar(ada)).not_to_contain_text("Nia’s screen")
        self.bar(nia).get_by_role("button", name="Return").click()
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Microphone off"))).to_have_attribute("aria-pressed", "false")
        self.assertTrue(nia.evaluate("[...document.querySelectorAll('[data-live-audio] audio')].every((a) => !a.muted)"), "listening resumes")

        # A capture that finishes after Quiet sends nothing: hold Nia's microphone prompt, choose
        # Work quietly, then let the browser return the live track (review of #131).
        # Ids of the live audio tracks Ada receives; a capture after Quiet must add none.
        heard = lambda: ada.evaluate("[...document.querySelectorAll('[data-live-audio] audio')].flatMap((a) => a.srcObject ? a.srcObject.getAudioTracks() : []).filter((t) => t.readyState === 'live').map((t) => t.id)")
        before = heard()
        nia.evaluate("window.__holdCapture = true")
        self.bar(nia).get_by_role("button", name=re.compile("^Microphone off")).click()
        nia.wait_for_function("() => typeof window.__releaseCapture === 'function'")
        self.bar(nia).get_by_role("button", name="Session details and more").click()
        nia.get_by_role("dialog", name="Live session").get_by_role("switch", name=re.compile("Work quietly")).click()
        nia.keyboard.press("Escape")
        expect(self.bar(nia).get_by_role("status").first).to_contain_text("Quiet")
        nia.evaluate("window.__holdCapture = false; window.__releaseCapture()")
        nia.wait_for_function("() => window.__live.tracks.every((t) => t.readyState === 'ended')")
        nia.wait_for_timeout(2500)
        self.assertEqual(nia.evaluate("window.__live.tracks.filter((t) => t.readyState === 'live').length"), 0, "the late track was stopped")
        self.assertTrue(set(heard()) <= set(before), "Ada receives no new audio track")
        # After Return the microphone is truthfully off.
        self.bar(nia).get_by_role("button", name="Return").click()
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Microphone off"))).to_have_attribute("aria-pressed", "false")

        # Capture finished, publication still pending (the server's answer is held): Quiet stops the
        # microphone at once, before publication resolves, and the late publication sends nothing.
        nia.evaluate("window.__holdSignals = true")
        self.bar(nia).get_by_role("button", name=re.compile("^Microphone off")).click()
        nia.wait_for_function("() => window.__live.tracks.some((t) => t.kind === 'audio' && t.readyState === 'live')")
        self.bar(nia).get_by_role("button", name="Session details and more").click()
        nia.get_by_role("dialog", name="Live session").get_by_role("switch", name=re.compile("Work quietly")).click()
        nia.keyboard.press("Escape")
        nia.wait_for_function("() => window.__live.tracks.every((t) => t.readyState === 'ended')", timeout=3000)
        self.assertTrue(nia.evaluate("window.__holdSignals"), "still before the publication answer")
        nia.evaluate("window.__releaseSignals()")
        nia.wait_for_timeout(2500)
        self.assertEqual(nia.evaluate("window.__live.tracks.filter((t) => t.readyState === 'live').length"), 0, "nothing captures after the publication answer")
        self.assertTrue(set(heard()) <= set(before), "Ada receives no audio from a publication that finished after Quiet")
        self.bar(nia).get_by_role("button", name="Return").click()
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Microphone off"))).to_have_attribute("aria-pressed", "false")
        # A capture that spans a dropped connection is superseded by it: after the reconnect the
        # late track ends, nothing reaches Ada, and turning the microphone on needs a new action.
        nia.evaluate("window.__holdCapture = true; window.__releaseCapture = undefined")
        self.bar(nia).get_by_role("button", name=re.compile("^Microphone off")).click()
        nia.wait_for_function("() => typeof window.__releaseCapture === 'function'")
        nia.evaluate("window.__live.rtc.filter((s) => s.readyState === 1).forEach((s) => s.close())")
        expect(self.bar(nia).get_by_role("status").first).to_contain_text("Reconnecting", timeout=15000)
        expect(self.bar(nia).get_by_role("status").first).to_contain_text("Live", timeout=30000)
        nia.evaluate("window.__holdCapture = false; window.__releaseCapture()")
        nia.wait_for_function("() => window.__live.tracks.every((t) => t.readyState === 'ended')")
        nia.wait_for_timeout(2500)
        self.assertEqual(nia.evaluate("window.__live.tracks.filter((t) => t.readyState === 'live').length"), 0, "the capture from before the reconnect was not published")
        self.assertTrue(set(heard()) <= set(before), "Ada receives no audio from a capture that spanned the reconnect")
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Microphone off"))).to_have_attribute("aria-pressed", "false")
        # The same for leaving while a capture is pending.
        nia.evaluate("window.__holdCapture = true; window.__releaseCapture = undefined")
        self.bar(nia).get_by_role("button", name=re.compile("^Microphone off")).click()
        nia.wait_for_function("() => typeof window.__releaseCapture === 'function'")
        self.bar(nia).get_by_role("button", name="Leave", exact=True).click()
        expect(self.bar(nia)).to_have_count(0)
        nia.evaluate("window.__holdCapture = false; window.__releaseCapture()")
        nia.wait_for_function("() => window.__live.tracks.every((t) => t.readyState === 'ended')")
        expect(self.bar(ada).locator(".lv-face")).to_have_count(3)
        ada.wait_for_timeout(2000)
        self.assertTrue(set(heard()) <= set(before), "Ada receives no audio from a capture that finished after leaving")

        # Everyone leaves; the last one is told the session closes; the doc is unchanged.
        for who in ("kai", "jonas", "ada"):
            self.bar(pages[who]).get_by_role("button", name="Leave", exact=True).click()
            expect(self.bar(pages[who])).to_have_count(0)
        self.assertEqual(self.api(ada, "GET", f"/api/v1/docs/{self.ids['doc']}", status=200)["version"], 1)

    def test_03_phone_and_tablet_keep_the_work_reachable(self) -> None:
        self.seed()
        nia = self.page("nia")
        nia.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        nia.locator("header.top").get_by_role("button", name="Together").click()
        expect(self.bar(nia)).to_be_visible()
        phone = self.page("jonas", phone=True)
        phone.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        phone.locator("header.top").get_by_role("button", name="Join").click()
        bar = self.bar(phone)
        expect(bar.locator(".lv-where")).to_be_visible()
        # One compact row in the flow: the composer stays visible and above the fold.
        bar_box = bar.bounding_box()
        composer = phone.locator(".composer").last.bounding_box()
        assert bar_box and composer
        self.assertLessEqual(bar_box["height"], 60, "the phone strip is one compact row")
        self.assertLessEqual(composer["y"] + composer["height"], PHONE["height"] + 1, "the composer is not pushed off screen")
        self.assertGreaterEqual(composer["y"], bar_box["y"] + bar_box["height"], "the strip never covers the composer")
        for button in bar.get_by_role("button").all():
            box = button.bounding_box()
            assert box
            self.assertGreaterEqual(min(box["width"], box["height"]), 43.5, f"touch target {button.get_attribute('aria-label') or button.inner_text()}")
        # No fake screen publishing on a phone browser without the picker.
        can_capture = phone.evaluate("typeof navigator.mediaDevices?.getDisplayMedia === 'function'")
        if not can_capture:
            expect(bar.get_by_role("button", name="Share a window, tab or screen")).to_have_count(0)
        shot(phone, "live-phone-390-strip")
        bar.get_by_role("button", name="Session details and more").click()
        sheet = phone.get_by_role("dialog", name="Live session")
        expect(sheet.get_by_role("heading", name=re.compile("night camera test"))).to_be_visible()
        shot(phone, "live-phone-390-sheet")
        # A labelled way back is in the first screen of the sheet, as a touch target (review of #131).
        back = sheet.get_by_role("button", name="Back to work")
        box = back.bounding_box()
        assert box
        self.assertGreaterEqual(min(box["width"], box["height"]), 43.5, "touch target")
        self.assertLessEqual(box["y"] + box["height"], PHONE["height"], "visible without scrolling")
        back.tap()
        expect(sheet).to_be_hidden()
        expect(self.bar(phone).get_by_role("status").first).to_contain_text("Live")
        expect(self.bar(phone).get_by_role("button", name="Session details and more")).to_be_focused()
        # Nia shares her screen; the phone views it and zooms without publishing anything.
        self.bar(nia).get_by_role("button", name="Share a window, tab or screen").click()
        bar.get_by_role("button", name="View").click()
        stage = phone.get_by_role("region", name="Shared screens and cameras")
        phone.wait_for_function("() => { const v = document.querySelector('video.lv-stage__video'); return v && v.videoWidth > 0; }", timeout=20000)
        shot(phone, "live-phone-390-stage")
        stage.get_by_role("button", name="Back to work").click()
        # Typing with the session open keeps the draft through navigation.
        composer_box = phone.get_by_role("textbox").last
        composer_box.fill("Filter out gives 18 of 20 at 5 lux, writing it up now")
        phone.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Wiki")).click()
        phone.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Conversation")).click()
        expect(phone.get_by_role("textbox").last).to_have_value("Filter out gives 18 of 20 at 5 lux, writing it up now")
        expect(self.bar(phone)).to_be_visible()
        self.assertEqual(phone.evaluate("window.__live.sockets"), 1)

        tablet = self.page("kai", viewport=TABLET)
        tablet.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        tablet.locator("header.top").get_by_role("button", name="Join").click()
        expect(self.bar(tablet).locator(".lv-where")).to_be_visible()
        overflow = tablet.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        self.assertLessEqual(overflow, 0, "no horizontal overflow on the tablet")
        shot(tablet, "live-tablet-820-session")
        for page in (tablet, phone, nia):
            self.bar(page).get_by_role("button", name="Leave", exact=True).click()
            expect(self.bar(page)).to_have_count(0)

    def test_04_keyboard_reduced_motion_and_outsiders(self) -> None:
        self.seed()
        page = self.page("ada", reduced=True)
        page.goto(self.task_url())
        page.locator("#details").get_by_role("button", name=re.compile("Work on this together|Join")).click()
        bar = self.bar(page)
        expect(bar.get_by_role("status").first).to_contain_text("Live")
        self.assertIn(page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--dur-2').trim()"), ("0ms", "0s"))
        # Every strip control is reachable with Tab and names its state.
        more = bar.get_by_role("button", name="Session details and more")
        more.focus()
        page.keyboard.press("Enter")
        dialog = page.get_by_role("dialog", name="Live session")
        expect(dialog).to_be_visible()
        for _ in range(30):
            page.keyboard.press("Tab")
            inside = page.evaluate("document.activeElement.closest('[role=dialog]') !== null")
            self.assertTrue(inside, "Tab stays inside the open panel")
        page.keyboard.press("Escape")
        expect(more).to_be_focused()
        # Someone without project access sees no session, title or presence.
        lee = self.page("lee")
        found = self.api(lee, "GET", f"/api/v1/projects/{self.ids['project']}/live-sessions")
        self.assertNotIn(TASK, json.dumps(found))
        lee.goto(f"/projects/{self.ids['project']}/live/{self.ids['session1']}")
        expect(lee.get_by_role("heading", level=1).first).to_be_visible()
        self.assertNotIn(TASK, lee.content(), "the invitation link reveals nothing to an outsider")
        expect(self.bar(lee)).to_have_count(0)
        bar.get_by_role("button", name="Leave", exact=True).click()


if __name__ == "__main__":
    unittest.main()
