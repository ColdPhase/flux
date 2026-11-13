"""Browser journeys for live work sessions (issue #62, contract #59).

Two modes:

* In the ordinary ``scripts/check_ui.sh`` run the server has no media server. The tests check
  that the interface says so calmly and that ordinary work is unaffected.
* ``scripts/check_live_ui.sh`` runs the same file with ``FLUX_UI_LIVE=1`` against the pinned
  self-hosted LiveKit SFU. Real Chromium clients with Chromium's fake microphone, camera and
  screen then go through the required journey twice: two people, then four — blocked task →
  join → show a fragment and a screen → save a change → leave.

Fake devices and one local network are local evidence only. Physical devices, restrictive
networks and TURN are verified in #63.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from contrast import MEASURE

from project_views import project_view
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from inbox_items import open_item

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
# A public key as the server gives it (65 bytes, base64url): the page only compares it with a subscription it would make.
PUSH_KEY = base64.urlsafe_b64encode(bytes([4]) + bytes(64)).decode().rstrip("=")
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

    def context(self, who: str | None, *, viewport: dict | None = None, phone: bool = False, reduced: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
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

    def open_conversation(self, page: Page, url: str | None = None) -> None:
        """Open the seeded conversation. Its URL is a thread: the app opens it in the detail panel, a sheet or an
        overlay over the header on a phone or tablet (#344, #601). A person closes it to reach Call or Join."""
        page.goto(url or f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        header = page.locator("header.top, header.phead").get_by_role("button", name=re.compile("^(Call|Join)$"))
        panel_close = page.locator(".ui-panel__close")
        expect(header.or_(panel_close).first).to_be_visible()
        if panel_close.first.is_visible():
            panel_close.first.click()
            expect(panel_close).to_have_count(0)
        expect(header.first).to_be_visible()

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
        doc = self.api(ada, "POST", f"{base}/docs", {"title": DOC, "body": DOC_BODY}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
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

    def call(self, page: Page) -> None:
        """Start a call with ONE click on the header's Call, once the open view has said where it is (until then Call only says why it
        cannot start, and the real button is not there). The strip is there at once; it reads Live when the connection is made (#1304)."""
        header = page.locator("header.top, header.phead")
        header.get_by_role("button", name="Call", exact=True).and_(header.locator(".lv-entry__btn:not(.lv-entry__btn--why)")).click()
        expect(self.bar(page)).to_be_visible(timeout=10000)
        expect(self.bar(page).get_by_role("status").first).to_contain_text("Live", timeout=30000)

    def bar(self, page: Page):
        return page.get_by_role("region", name="Call", exact=True)

    def see_shared_screen(self, page: Page) -> None:
        """A screen someone shares reaches the stage as the product has it (F-041 point 8): on a computer and a tablet the stage opens by
        itself, also on joining a call where a screen is already shared; on a phone a sheet offers it and its View opens the stage."""
        stage = page.get_by_role("region", name="Shared screens and cameras")
        offer = page.get_by_role("dialog", name="Shared screen")
        expect(stage.or_(offer).first).to_be_visible(timeout=30000)
        if offer.is_visible():
            offer.get_by_role("button", name=re.compile(r"^View .*’s screen$")).click()
        expect(stage).to_be_visible()

    def put_off_shared_screen_if_offered(self, page: Page) -> None:
        """Joining a call where a screen is already shared offers it on a phone (a sheet) and opens the stage on a tablet or a computer:
        a phone's sheet, if it comes, is put off with Not now."""
        offer = page.get_by_role("dialog", name="Shared screen")
        try:
            offer.wait_for(state="visible", timeout=5000)
        except Exception:  # no sheet: the stage opened by itself, or nothing is shared
            return
        offer.get_by_role("button", name="Not now").click()
        expect(offer).to_have_count(0)

    def put_off_shared_screen(self, page: Page) -> None:
        """On a phone, answers the sheet that offers a shared screen with Not now: the strip's View is then the way to it."""
        offer = page.get_by_role("dialog", name="Shared screen")
        expect(offer).to_be_visible(timeout=30000)
        offer.get_by_role("button", name="Not now").tap()
        expect(offer).to_have_count(0)


@unittest.skipIf(LIVE, "the media server is configured in this run")
class LiveUnavailable(LiveBase):
    """Without a media server the interface explains it once and ordinary work continues."""

    def test_01_unavailable_is_explained_and_work_is_unchanged(self) -> None:
        self.seed()
        page = self.page("nia")
        page.goto(self.task_url())
        panel = page.locator("#details")
        expect(panel.get_by_role("heading", name=TASK)).to_be_visible()
        # #1424 (#1419 decision 4): a server that cannot make calls shows no Call at all, neither in the header nor in the task: nothing that
        # explains why it does nothing.
        expect(panel).not_to_contain_text("Live sessions")
        header = page.locator("header.top, header.phead")
        expect(header.get_by_role("button", name="Call")).to_have_count(0)
        expect(page.get_by_role("dialog", name="Live sessions")).to_have_count(0)
        expect(panel.get_by_role("button", name=re.compile("Work on this together|Join"))).to_have_count(0)
        self.assertEqual(page.evaluate("window.__live.gum + window.__live.gdm"), 0, "nothing asked for a device")
        expect(self.bar(page)).to_have_count(0)
        self.assertEqual(self.api(page, "GET", "/api/v1/live-sessions/capabilities", status=200)["status"], "unavailable")

    def test_02_dark_device_controls_keep_readable_text(self) -> None:
        # Device buttons exist only with a media server, so this renders their markup (DeviceButton.tsx)
        # on the signed-in app: the stylesheet that colours them is the real live.css.
        self.seed()
        for scheme in ("light", "dark"):
            with self.subTest(scheme=scheme):
                page = self.page("nia", dark=scheme == "dark")
                page.goto(self.task_url())
                expect(page.locator("#details").get_by_role("heading", name=TASK)).to_be_visible()
                self.assertEqual(page.evaluate("getComputedStyle(document.documentElement).colorScheme") == "dark", scheme == "dark", "the requested theme is in effect")
                page.evaluate("""() => {
                  const row = document.createElement('div');
                  row.innerHTML = '<button type="button" class="lv-dev lv-dev--screen is-on" aria-pressed="true" aria-label="Stop sharing your screen"></button>'
                    + '<button type="button" class="lv-dev lv-dev--camera is-problem" aria-label="Camera blocked by the browser · try again"><span class="lv-dev__badge" aria-hidden="true">!</span></button>';
                  document.body.append(row);
                }""")
                screen = page.evaluate(MEASURE, {"selector": ".lv-dev--screen.is-on"})
                badge = page.evaluate(MEASURE, {"selector": ".lv-dev--camera .lv-dev__badge"})
                self.assertGreaterEqual(screen["ratio"], 4.5, (scheme, "screen toggle", screen))
                self.assertGreaterEqual(badge["ratio"], 4.5, (scheme, "badge", badge))
                size = page.evaluate("parseFloat(getComputedStyle(document.querySelector('.lv-dev__badge')).fontSize)")
                self.assertGreaterEqual(size, 12, (scheme, "the badge uses the meta size token, not 10 px"))


@unittest.skipUnless(LIVE, "set FLUX_UI_LIVE=1 with the live media profile (scripts/check_live_ui.sh)")
class LiveJourney(LiveBase):
    """Tests run in name order and share accounts, one project and its sessions."""

    def test_00_a_call_that_can_be_joined_moves_nothing_in_the_computer_header(self) -> None:
        """#873: the people, Call (or Join) and More have fixed slots on the computer, so someone else's call appears without a shift,
        and the tablet's row keeps the people and Join. A space of its own: a call is joinable there for a while after everyone has left,
        and one elsewhere in the space adds a "Live now" button to the row."""
        self.seed()
        ada = self.page("ada")
        project = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Rain barrel monitor", "visibility": "restricted"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": PEOPLE["nia"]["id"]}, "role": "contributor"}, status=201)
        thread = self.api(ada, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Which barrel overflows first?", "clientMessageId": str(uuid.uuid4())}, status=201)
        url = f"/projects/{project['id']}/conversations/{thread['id']}"
        nia = self.page("nia")
        self.open_conversation(nia, url)
        watcher = self.page("ada")
        self.open_conversation(watcher, url)
        wide = watcher.locator("header.top")
        people = wide.get_by_role("button", name=re.compile("who can see this space$"))
        more = wide.get_by_role("button", name="More", exact=True)
        expect(wide.get_by_role("button", name=re.compile("^Live now"))).to_have_count(0)
        before = {"people": people.bounding_box(), "More": more.bounding_box(), "Call": wide.get_by_role("button", name="Call", exact=True).bounding_box()}
        self.call(nia)
        expect(self.bar(nia)).to_be_visible()
        join = wide.get_by_role("button", name="Join", exact=True)
        expect(join).to_be_visible()
        after = {"people": people.bounding_box(), "More": more.bounding_box(), "Join": join.bounding_box()}
        for name in ("people", "More"):
            self.assertAlmostEqual(before[name]["x"], after[name]["x"], delta=1, msg=f"{name} did not move when the call became joinable")
        self.assertAlmostEqual(before["Call"]["x"] + before["Call"]["width"] / 2, after["Join"]["x"] + after["Join"]["width"] / 2, delta=1, msg="Join sits where Call was")
        shot(watcher, "live-desktop-1440-join-in-header")
        # The tablet's row has room for the people and Join too: they stay in the header at 820 px (they are not only in More).
        tablet = self.page("ada", viewport=TABLET)
        self.open_conversation(tablet, url)
        row = tablet.locator("header.top")
        expect(row.get_by_role("button", name="Join", exact=True)).to_be_visible()
        expect(row.get_by_role("button", name=re.compile("who can see this space$"))).to_be_visible()
        self.assertLessEqual(tablet.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, "no sideways scroll at 820")
        shot(tablet, "live-tablet-820-join-in-header")
        # Under 360 px Call is in More: a call that can be joined is a dot on More, and the row reads Join the moment More opens.
        small = self.page("ada", viewport={"width": 320, "height": 568})
        small.goto(f"/projects/{project['id']}")
        phead = small.locator("header.phead")
        expect(phead.locator(".top__live-cue")).to_be_visible()
        expect(phead.get_by_role("button", name="Join", exact=True)).to_be_hidden()
        # The live mark is part of More's name, so a screen reader hears it, and Join takes Call's row (after Search) from the first frame.
        more_small = phead.get_by_role("button", name=re.compile("^More live now here"))
        expect(more_small).to_be_visible()
        more_small.click()
        menu = small.get_by_role("menu", name="More")
        expect(menu).to_be_visible()
        rows = [text.split("\n")[0] for text in menu.locator("[role^=menuitem]:visible").all_inner_texts()]
        self.assertEqual(rows[0], "Search", "Search stays More's first row (#1239)")
        self.assertTrue(rows[1].startswith("Join"), f"the row after Search is Join, not Call, from the first frame: {rows}")
        shot(small, "live-phone-320-more-join")
        small.keyboard.press("Escape")
        self.bar(nia).get_by_role("button", name="Leave", exact=True).click()
        expect(self.bar(nia)).to_have_count(0)

    def test_00b_a_call_elsewhere_in_the_space_takes_the_join_slot_and_moves_nothing(self) -> None:
        """#1230 (F-041): a call started at another place in the space (a Wiki page here) takes the header's Join slot, which says who is in
        it and where, so it is not hidden as a dot on More. The views, the name's slot, the people and More stay where they are at 820, 1180
        and 1440 px; at 1024 px, where Call is in More, More carries the dot and its first row is Join. More offers "Start a call here"."""
        self.seed()
        ada = self.page("ada")
        project = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Tool library", "visibility": "restricted"}, status=201)
        pid = project["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": PEOPLE["nia"]["id"]}, "role": "contributor"}, status=201)
        thread = self.api(ada, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "Who has the soldering iron?", "clientMessageId": str(uuid.uuid4())}, status=201)
        doc = self.api(ada, "POST", f"/api/v1/projects/{pid}/docs", {"title": "Loan rules", "body": "Two weeks, then back on the shelf."}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        conversation_url = f"/projects/{pid}/conversations/{thread['id']}"
        watchers = {}
        for width, height in ((820, 1180), (1024, 768), (1180, 820), (1440, 900)):
            page = self.page("ada", viewport={"width": width, "height": height})
            if width == 1024:
                # A 1024 px window has "+ Task"'s slot in the header and no room for the people and Call: they are in More (no Call to wait for).
                page.goto(conversation_url)
                if page.locator(".ui-panel__close").first.is_visible():
                    page.locator(".ui-panel__close").first.click()
                expect(page.locator("header.top").get_by_role("button", name=re.compile("^More"))).to_be_visible()
            else:
                self.open_conversation(page, conversation_url)
            watchers[width] = page

        def places(page: Page) -> dict:
            header = page.locator("header.top")
            out = {name: header.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile(f"^{name}")).bounding_box()
                   for name in ("Conversation", "Tasks", "Map", "Wiki")}
            out["name"] = header.locator(".top__title").bounding_box()
            people = header.get_by_role("button", name=re.compile("who can see this space$"))
            if people.count():
                out["people"] = people.bounding_box()
            out["More"] = header.get_by_role("button", name=re.compile("^More")).bounding_box()
            return out

        before = {width: places(page) for width, page in watchers.items()}
        calls = {width: page.locator("header.top").get_by_role("button", name="Call", exact=True).bounding_box() for width, page in watchers.items() if width != 1024}
        nia = self.page("nia")
        nia.goto(f"/projects/{pid}/docs/{doc['id']}")
        self.call(nia)
        expect(self.bar(nia)).to_be_visible()
        started = time.monotonic()
        for width, page in watchers.items():
            header = page.locator("header.top")
            if width == 1024:
                expect(header.locator(".top__live-cue"), "1024: Call is in More, so More carries the live dot").to_be_visible()
                expect(header.get_by_role("button", name="More live now in this space")).to_be_visible()
            else:
                join = header.get_by_role("button", name="Join", exact=True)
                expect(join, f"{width}: the call elsewhere takes the header's Join").to_be_visible()
                if width == 820:
                    self.assertLess(time.monotonic() - started, 2.5, "Join shows within 2 s of the call starting")
                expect(join).to_have_accessible_description(re.compile("^Join · Nia · at “Loan rules”"))
                box = join.bounding_box()
                self.assertAlmostEqual(calls[width]["x"] + calls[width]["width"] / 2, box["x"] + box["width"] / 2, delta=1, msg=f"{width}: Join sits where Call was")
                expect(header.locator(".top__live-cue"), f"{width}: one call, nothing more in More").to_have_count(0)
            after = places(page)
            for name, box in before[width].items():
                for key in ("x", "width"):
                    self.assertAlmostEqual(box[key], after[name][key], delta=1, msg=f"{width}: {name} did not change its {key} when a call started elsewhere")
            shot(page, f"live-desktop-{width}-join-elsewhere")
        # More offers a separate call here, and the header's Join joins the call at the page.
        page = watchers[1440]
        page.locator("header.top").get_by_role("button", name=re.compile("^More")).click()
        expect(page.get_by_role("menu", name="More").get_by_role("menuitem", name=re.compile("^Start a call here"))).to_be_visible()
        page.keyboard.press("Escape")
        # At 1024 the people and Call are in More, in that order (Spokój rule 3): opened from the keyboard, the row after People is the Join,
        # named from the first frame with who and where.
        folded = watchers[1024]
        more = folded.locator("header.top").get_by_role("button", name=re.compile("^More"))
        more.focus()
        folded.keyboard.press("Enter")
        menu = folded.get_by_role("menu", name="More")
        row = menu.get_by_role("menuitem", name=re.compile("^Join · Nia · at “Loan rules”"))
        expect(row).to_be_visible()
        expect(menu.get_by_role("menuitem", name=re.compile("^People"))).to_be_focused()
        folded.keyboard.press("ArrowDown")
        expect(row).to_be_focused()
        folded.keyboard.press("Escape")
        page.locator("header.top").get_by_role("button", name="Join", exact=True).click()
        expect(self.bar(page)).to_be_visible()
        expect(self.bar(page).locator(".lv-where")).to_contain_text("Loan rules")
        # A phone has Call in its row from 360 px and under it in More; under 360 px the Join row is Call's, after Search.
        small = self.page("ada", viewport={"width": 320, "height": 568})
        small.goto(f"/projects/{pid}")
        expect(small.locator("header.phead .top__live-cue")).to_be_visible()
        small.locator("header.phead").get_by_role("button", name=re.compile("^More")).click()
        rows = small.get_by_role("menu", name="More").locator("[role^=menuitem]:visible")
        expect(rows.first).to_contain_text("Search")
        expect(rows.nth(1)).to_contain_text(re.compile("^Join · "))
        small.keyboard.press("Escape")
        for leaver in (page, nia):
            self.bar(leaver).get_by_role("button", name="Leave", exact=True).click()
            expect(self.bar(leaver)).to_have_count(0)
        # An empty room is not "live now": a call that stays joinable for a while after everyone left takes no Join slot.
        expect(watchers[820].locator("header.top").get_by_role("button", name="Call", exact=True)).to_be_visible(timeout=40000)

    def test_00c_a_call_from_the_conversation_is_the_spaces_and_join_shows_on_every_view(self) -> None:
        """#1230 acceptance and #1223 point 1: Nia starts a call in the conversation, then someone posts a message. The call is "Call in
        <space>", not the message's text, and Ada's open tabs show Join within 2 s on the same conversation, on Tasks, Map and Wiki and on the
        tablet; under 360 px More shows the dot and Join takes Call's row after Search. Joining from Tasks joins the same call."""
        self.seed()
        ada = self.page("ada")
        project = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Seed swap", "visibility": "restricted"}, status=201)
        pid = project["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": PEOPLE["nia"]["id"]}, "role": "contributor"}, status=201)
        thread = self.api(ada, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "Tomato seeds are in the blue box", "clientMessageId": str(uuid.uuid4())}, status=201)
        self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/sketches", {"title": "What to plant", "scope": "project", "projectId": pid}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        self.api(ada, "POST", f"/api/v1/projects/{pid}/docs", {"title": "Swap rules", "body": "Bring one, take one."}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        tabs = {}
        for view in ("Conversation", "Tasks", "Map", "Wiki"):
            page = self.page("ada")
            page.goto(f"/projects/{pid}")
            if view != "Conversation":
                project_view(page, view)
            expect(page.locator("header.top").get_by_role("button", name="Call", exact=True)).to_be_visible()
            tabs[view] = page
        tablet = self.page("ada", viewport=TABLET)
        tablet.goto(f"/projects/{pid}")
        expect(tablet.locator("header.top").get_by_role("button", name="Call", exact=True)).to_be_visible()
        tabs["tablet"] = tablet
        small = self.page("ada", viewport={"width": 320, "height": 568})
        small.goto(f"/projects/{pid}/tasks")
        expect(small.locator("header.phead").get_by_role("button", name=re.compile("^More"))).to_be_visible()

        nia = self.page("nia")
        nia.goto(f"/projects/{pid}")
        self.call(nia)
        bar = self.bar(nia)
        expect(bar.locator(".lv-where")).to_have_text("Call in Seed swap")
        # A message after the call started moves nothing: the call is the space's, not the newest message's.
        self.api(ada, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": "Posting after the call started", "clientMessageId": str(uuid.uuid4())}, status=201)
        started = time.monotonic()
        for view, page in tabs.items():
            join = page.locator("header.top").get_by_role("button", name="Join", exact=True)
            expect(join, f"{view}: Join in the header").to_be_visible(timeout=2500 if view == "Conversation" else 15000)
            expect(join).to_have_accessible_description(re.compile("^Join · Nia\\. "))
        self.assertLess(time.monotonic() - started, 4, "every open tab shows Join within about 2 s")
        shot(tabs["Tasks"], "live-desktop-1440-join-on-tasks")
        shot(tablet, "live-tablet-820-join-on-conversation")
        expect(small.locator("header.phead .top__live-cue")).to_be_visible()
        small.locator("header.phead").get_by_role("button", name=re.compile("^More")).click()
        rows = small.get_by_role("menu", name="More").locator("[role^=menuitem]:visible")
        expect(rows.first).to_contain_text("Search")
        expect(rows.nth(1)).to_contain_text("Join · Nia")
        shot(small, "live-phone-320-more-join-space-call")
        small.keyboard.press("Escape")
        # Joining from Tasks is the same call, named by the space.
        tabs["Tasks"].locator("header.top").get_by_role("button", name="Join", exact=True).click()
        expect(self.bar(tabs["Tasks"]).locator(".lv-where")).to_have_text("Call in Seed swap")
        expect(self.bar(tabs["Tasks"]).locator(".lv-face")).to_have_count(2)
        expect(bar.locator(".lv-face")).to_have_count(2)
        sessions = self.api(ada, "GET", f"/api/v1/projects/{pid}/live-sessions", status=200)["items"]
        self.assertEqual([item["context"] for item in sessions], [{"type": "space", "id": pid}])
        for leaver in (tabs["Tasks"], nia):
            self.bar(leaver).get_by_role("button", name="Leave", exact=True).click()
            expect(self.bar(leaver)).to_have_count(0)

    def test_00g_one_click_on_call_right_after_being_added_shows_the_call_at_once(self) -> None:
        """#1304: right after Ada adds Kai to a new space, Kai's one click on Call shows the strip, "Connecting…", at once, though joining is
        held for 4 s; nothing starts twice; then the call reads Live. No second click is needed."""
        self.seed()
        ada = self.page("ada")
        project = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Quick start", "visibility": "restricted"}, status=201)
        pid = project["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": PEOPLE["kai"]["id"]}, "role": "contributor"}, status=201)
        kai = self.page("kai")
        # Joining is slow on this page: the page's own request for the join waits 4 s (no route is stubbed; the service worker stays allowed).
        kai.context.add_init_script(r"""(() => {
          const real = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
            if (/\/api\/v1\/live-sessions\/[^/]+\/join/.test(url)) await new Promise((resolve) => setTimeout(resolve, 4000));
            return real(input, init);
          };
        })();""")
        kai.goto(f"/projects/{pid}")
        header = kai.locator("header.top")
        views_at = lambda: header.locator(".top__views").bounding_box()["x"]
        before = views_at()
        header.get_by_role("button", name="Call", exact=True).and_(header.locator(".lv-entry__btn:not(.lv-entry__btn--why)")).click()
        clicked = time.monotonic()
        bar = self.bar(kai)
        expect(bar).to_be_visible(timeout=3000)
        self.assertLess(time.monotonic() - clicked, 3.5, "the strip is there at once, not after the connection")
        expect(bar.get_by_role("status").first).to_contain_text("Connecting")
        expect(bar.locator(".lv-where")).to_have_text("Call in Quick start")
        expect(bar.get_by_role("button", name="Leave", exact=True)).to_have_count(0)
        # The strip's items share one centre line: the place's title is level with the live word (#1378), not at the top of the row.
        centres = bar.evaluate("""el => { const c = (s) => { const r = el.querySelector(s).getBoundingClientRect(); return r.top + r.height / 2; }; return [c('.lv-row__lead'), c('.lv-where__t')]; }""")
        self.assertLessEqual(abs(centres[0] - centres[1]), 2, f"the title is on the row's centre line: {centres}")
        shot(kai, "live-desktop-1440-connecting")
        # While it connects, the header shows the call's state, not a Call button again (#1378), and it starts no second call: it says it is connecting.
        in_call = header.get_by_role("button", name="In call", exact=True)
        expect(in_call).to_have_text("In call")
        expect(header.get_by_role("button", name="Call", exact=True)).to_have_count(0)
        # "In call" fits the Call slot: its word is not cut and the views do not move (Spokój rule 7).
        self.assertEqual(in_call.evaluate("el => { const l = el.querySelector('.lv-entry__label'); return l.scrollWidth <= l.clientWidth + 0.5 && el.scrollWidth <= el.clientWidth + 0.5; }"), True)
        self.assertAlmostEqual(views_at(), before, delta=0.5, msg="the views keep their place while the call connects")
        in_call.click()
        expect(kai.locator(".lv-pop__text")).to_have_text("Connecting to the call.")
        kai.keyboard.press("Escape")
        expect(bar.get_by_role("status").first).to_contain_text("Live", timeout=30000)
        expect(in_call.locator(".lv-dot")).to_be_visible()
        self.assertTrue(in_call.evaluate("el => el.scrollWidth <= el.clientWidth + 0.5"), "In call with its dot fits the slot")
        self.assertAlmostEqual(views_at(), before, delta=0.5, msg="the views keep their place in the call")
        calls = [item for item in self.api(kai, "GET", f"/api/v1/projects/{pid}/live-sessions", status=200)["items"] if item["context"]["id"] == pid]
        self.assertEqual(len(calls), 1, "one call, not one per click")
        bar.get_by_role("button", name="Leave", exact=True).click()
        expect(bar).to_have_count(0)

    def test_00i_in_the_call_the_header_shows_it_and_takes_you_to_it(self) -> None:
        """#1424: while you are in a call the header's slot reads "In call" with the live dot and goes to the call, never "You are in a live
        session" and a click that does nothing."""
        self.seed()
        nia = self.page("nia")
        nia.goto(f"/projects/{self.ids['project']}")
        self.call(nia)
        header = nia.locator("header.top")
        in_call = header.get_by_role("button", name="In call", exact=True)
        expect(in_call).to_be_visible()
        expect(header.get_by_role("button", name="Call", exact=True)).to_have_count(0)
        # Somewhere else in the space (the Tasks view has no place of the call's), it takes you back to the call's place.
        project_view(nia, "Tasks")
        expect(nia).to_have_url(re.compile(r"/tasks"))
        in_call.click()
        expect(nia).to_have_url(re.compile(rf"/projects/{self.ids['project']}$"))
        expect(self.bar(nia)).to_be_visible()
        # At its own place with nothing shown, the call is already in view: the strip's place button takes the focus.
        in_call.click()
        expect(self.bar(nia).locator(".lv-where")).to_be_focused()
        expect(nia.get_by_text("You are in a live session")).to_have_count(0)
        self.bar(nia).get_by_role("button", name="Leave", exact=True).click()
        expect(self.bar(nia)).to_have_count(0)

    def test_00d_a_call_is_noticed_in_the_inbox_and_sidebar_and_invitations_reach_people(self) -> None:
        """#1223 points 2 to 6 (F-041): Lee starts a call; Ada's open tab on Home shows the space's call glyph and her Inbox the call with
        Join, within 2 s; Join joins it. Lee alone reads "Nobody joined · Invite someone"; Invite… invites Jonas and Kai. The call leaves
        the Inbox when it is over. (The invitation's chime is #1243's "Sound when someone calls me".)"""
        self.seed()
        ada = self.page("ada")
        project = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Repair cafe", "visibility": "restricted"}, status=201)
        pid = project["id"]
        for key in ("lee", "jonas", "kai"):
            self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": PEOPLE[key]["id"]}, "role": "contributor"}, status=201)
        ada.goto("/")
        space = ada.locator("aside").get_by_role("link", name=re.compile("^Repair cafe"))
        expect(space).to_be_visible()
        expect(space.locator("svg.side__live[data-call-mark]")).to_have_count(0)
        jonas = self.page("jonas")
        # This run's server has no push keys: Jonas's page is told it has them and has not been asked, as on a server that can push (the page's
        # own request is answered, so no route is stubbed and the service worker stays allowed).
        jonas.context.add_init_script("""(() => {
          Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' });
          const real = window.fetch.bind(window);
          window.fetch = (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
            if (url.includes('/api/v1/push/public-key')) return Promise.resolve(new Response(JSON.stringify({ status: 'available', publicKey: %s }), { status: 200, headers: { 'content-type': 'application/json' } }));
            return real(input, init);
          };
        })();""" % json.dumps(PUSH_KEY))
        jonas.goto("/")
        # Kai takes everything that happens (the level "Everything" pushes an open call too), with Flux open on Home: the corner notice card (#1268)
        # and the tab's "(N)" (#1283) tell him of the call; the call has no sound of its own (the chime is the invitation's).
        kai = self.page("kai")
        self.api(kai, "PATCH", "/api/v1/notification-preferences", {"level": "everything"}, status=200)
        self.addCleanup(lambda: self.api(kai, "PATCH", "/api/v1/notification-preferences", {"level": "needsYou"}))
        kai.goto("/")
        expect(kai.locator(".app__pane")).to_be_visible()
        kai.wait_for_timeout(1500)

        # Lee starts it: each person runs at most a few calls at once, and the journeys before this one started theirs.
        nia = self.page("lee")
        nia.goto(f"/projects/{pid}")
        self.call(nia)
        bar = self.bar(nia)
        expect(bar.locator(".lv-where")).to_have_text("Call in Repair cafe")
        expect(bar.get_by_role("status").filter(has_text="Nobody joined")).to_be_visible()
        notice = kai.locator(".ui-notices .ui-notice")
        expect(notice).to_contain_text("Lee Park started a call in Repair cafe", timeout=5000)
        expect(notice.get_by_role("button", name="Join")).to_be_visible()
        expect(notice.get_by_role("button", name="Open")).to_have_count(0)
        expect(kai).to_have_title(re.compile(r"^\(1\) "), timeout=5000)
        shot(kai, "live-desktop-1440-call-notice-card")
        started = time.monotonic()
        expect(space).to_have_accessible_name(re.compile("call on"), timeout=2500)
        expect(space.locator("svg.side__live[data-call-mark]")).to_be_visible()
        self.assertLess(time.monotonic() - started, 3, "the space's call glyph shows within about 2 s")
        shot(ada, "live-desktop-1440-sidebar-call-on")
        # The Inbox: the call with Join (the notice is written by the worker, a moment after the start).
        # A call is a Call, never a Question (#1368): Home names it so too, in its one row.
        ada.goto("/")
        row = ada.get_by_role("list", name="Top of your Inbox").locator(".home__row", has_text="Lee Park started a call in Repair cafe")
        expect(row.locator(".home__row-k")).to_have_text("Call")
        expect(row).not_to_contain_text("Question")
        ada.goto("/inbox")
        card = ada.locator(".nyc", has_text="Lee Park started a call in Repair cafe")
        expect(card).to_be_visible()
        expect(card).to_contain_text("Call")
        expect(card).not_to_contain_text("Question")
        shot(ada, "live-desktop-1440-inbox-call")
        open_item(card).get_by_role("button", name="Join").first.click()
        expect(self.bar(ada).locator(".lv-where")).to_have_text("Call in Repair cafe")
        # Joined, it asks nothing more of her: it leaves the Inbox and Home while the call goes on (#1368).
        expect(card).to_have_count(0)
        ada.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
        expect(ada.locator(".home__hello")).to_be_visible()
        expect(ada.locator(".home__row", has_text="started a call in Repair cafe")).to_have_count(0)
        expect(bar.get_by_role("status").filter(has_text="Nobody joined")).to_have_count(0)

        # #1424: "Invite someone" is the strip's one invite control (no "Invite…" beside it, and the "Nobody joined" line has no second one on a
        # computer); it opens the people who can join, and only them: no microphone, camera or screen rows repeated.
        expect(bar.get_by_role("button", name="Invite…")).to_have_count(0)
        expect(bar.get_by_role("button", name="Invite someone")).to_have_count(1)
        bar.get_by_role("button", name="Invite someone").click()
        panel = nia.get_by_role("dialog", name="Invite someone", exact=True)
        expect(panel).to_be_visible()
        expect(panel).not_to_contain_text("Microphone")
        expect(panel).not_to_contain_text("Camera")
        expect(panel).not_to_contain_text("Share a window")
        shot(nia, "live-desktop-1440-invite")
        for name in ("Jonas Berg", "Kai Moreau"):
            row = panel.locator(".lv-person--absent", has_text=name)
            row.get_by_role("button", name="Invite").click()
            expect(row).to_contain_text("Invited")
        nia.keyboard.press("Escape")
        # Closed and opened again, the ones invited stay "Invited": they are not offered twice.
        bar.get_by_role("button", name="Invite someone").click()
        expect(nia.get_by_role("dialog", name="Invite someone", exact=True).locator(".lv-person--absent", has_text="Jonas Berg")).to_contain_text("Invited")
        nia.keyboard.press("Escape")
        # Each invitation is an Inbox item with Join for its person.
        jonas.goto("/inbox")
        invitation = jonas.locator(".nyc", has_text="invited you to a call")
        expect(invitation.first).to_contain_text("Call")
        expect(invitation.first).not_to_contain_text("Question")
        expect(open_item(invitation.first).get_by_role("button", name="Join").first).to_be_visible()
        # Opening the invitation: its strip offers to turn notifications on, once, with Home's card and no earlier message (#1243, F-041).
        open_item(invitation.first).get_by_role("button", name="Open").first.click()
        strip = jonas.get_by_role("region", name="Invitation to work together")
        offer = strip.locator("section.push-offer")
        expect(offer).to_contain_text("Get notified when someone writes to you or calls")
        expect(offer.get_by_role("button", name="Turn on")).to_be_visible()
        shot(jonas, "live-desktop-1440-invitation-push-offer")
        offer.get_by_role("button", name="Not now").click()
        expect(offer).to_have_count(0)
        expect(strip.get_by_role("button", name="Join")).to_be_visible()
        for leaver in (ada, nia):
            self.bar(leaver).get_by_role("button", name="Leave", exact=True).click()
            expect(self.bar(leaver)).to_have_count(0)
        # Over: the space loses its dot and the Inbox its call.
        ada.goto("/")
        expect(ada.locator("aside").get_by_role("link", name=re.compile("^Repair cafe")).locator("svg.side__live[data-call-mark]")).to_have_count(0, timeout=40000)
        ada.goto("/inbox")
        expect(ada.locator(".nyc", has_text="started a call in Repair cafe")).to_have_count(0)
        # The tab stops counting the call once nobody is in it (its card stays until the call ends, as #1268 draws it).
        expect(kai).not_to_have_title(re.compile(r"^\(\d+\) "), timeout=30000)

    def test_00f_a_call_is_one_line_in_the_conversation(self) -> None:
        """#1223 point 6 (F-041): a call started in the conversation shows one line on another member's open tab within 2 s, with Join;
        Join from the line joins the call; when it ends the line reads "Call · N min · Lee, Ada"; it survives a reload. A call nobody
        joined reads "Nia called · nobody joined"."""
        self.seed()
        ada = self.page("ada")
        project = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Sewing circle", "visibility": "restricted"}, status=201)
        pid = project["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": PEOPLE["lee"]["id"]}, "role": "contributor"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "Who has the overlocker this week?", "clientMessageId": str(uuid.uuid4())}, status=201)
        ada.goto(f"/projects/{pid}")
        expect(ada.get_by_text("Who has the overlocker this week?")).to_be_visible()
        nia = self.page("lee")
        nia.goto(f"/projects/{pid}")
        self.call(nia)
        expect(self.bar(nia)).to_be_visible()
        line = ada.locator("li.convo-call")
        started = time.monotonic()
        expect(line).to_contain_text("Lee", timeout=2500)
        expect(line).not_to_contain_text("Lee Park")  # first names, as a task line has them
        expect(line).to_contain_text("started a call")
        self.assertLess(time.monotonic() - started, 3, "the line shows within about 2 s")
        expect(line.get_by_role("button", name="Join")).to_be_visible()
        shot(ada, "live-desktop-1440-call-line-running")
        line.get_by_role("button", name="Join").click()
        expect(self.bar(ada).locator(".lv-where")).to_have_text("Call in Sewing circle")
        expect(line.get_by_role("button", name="Join")).to_have_count(0)
        for leaver in (ada, nia):
            self.bar(leaver).get_by_role("button", name="Leave", exact=True).click()
            expect(self.bar(leaver)).to_have_count(0)
        # Everyone left: the call ends after its short grace, and the same line says how long and who.
        expect(line).to_contain_text(re.compile(r"Call · \d+ min · Lee, Ada"), timeout=150000)
        ada.reload()
        expect(ada.locator("li.convo-call")).to_contain_text(re.compile(r"Call · \d+ min · Lee, Ada"))
        shot(ada, "live-desktop-1440-call-line-ended")

    def test_00e_a_shared_screen_opens_the_others_stage_once_and_says_when_it_stops(self) -> None:
        """#1223 point 8 (F-041): when Kai shares, Jonas's stage opens on it within 2 s with the line "Kai is sharing a screen", and Kai's face
        carries a screen badge; closed, it stays closed for that share, also across a reconnect; when Kai stops, it closes and says "Kai
        stopped sharing". A new share opens it again. While Jonas types in the composer the stage does not open (it would cover the field):
        the line's View is the offer."""
        self.seed()
        ada = self.page("ada")
        project = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Bike kitchen", "visibility": "restricted"}, status=201)
        pid = project["id"]
        for key in ("kai", "jonas"):
            self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": PEOPLE[key]["id"]}, "role": "contributor"}, status=201)
        nia = self.page("kai")
        nia.goto(f"/projects/{pid}")
        self.call(nia)
        expect(self.bar(nia)).to_be_visible()
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{pid}")
        jonas.locator("header.top").get_by_role("button", name="Join", exact=True).click()
        expect(self.bar(jonas).locator(".lv-face")).to_have_count(2)
        composer = jonas.get_by_label("Write a message", exact=True)
        composer.click()
        composer.type("Brake pads are in")
        stage = jonas.get_by_role("region", name="Shared screens and cameras")
        sharing = self.bar(jonas).get_by_role("status").filter(has_text="Kai is sharing a screen")
        expect(stage).to_have_count(0)

        # Typing in the composer: the share is offered in the strip, the stage stays shut and the field stays in view.
        self.bar(nia).get_by_role("button", name="Share a window, tab or screen").click()
        expect(sharing.get_by_role("button", name="View")).to_be_visible(timeout=2500)
        jonas.wait_for_timeout(1500)
        expect(stage).to_have_count(0)
        expect(composer).to_be_visible()
        expect(composer).to_be_focused()
        composer.type(" the drawer")
        expect(composer).to_have_value("Brake pads are in the drawer")
        self.bar(nia).get_by_role("button", name="Stop sharing your screen").click()
        expect(self.bar(jonas).get_by_role("status").filter(has_text="Kai stopped sharing")).to_be_visible()

        # Not typing: a new share opens the stage by itself, at once, without taking focus.
        jonas.evaluate("() => document.activeElement && document.activeElement.blur()")
        self.bar(nia).get_by_role("button", name="Share a window, tab or screen").click()
        started = time.monotonic()
        expect(stage).to_be_visible(timeout=2500)
        self.assertLess(time.monotonic() - started, 3, "the stage opens within about 2 s")
        expect(sharing).to_be_visible()
        expect(self.bar(jonas).locator(".lv-face[data-sharing] .lv-face__screen")).to_have_count(1)
        expect(composer).not_to_be_focused()
        shot(jonas, "live-desktop-1440-stage-opened-by-share")
        # Closed for this share, it stays closed, also after the connection drops and comes back.
        stage.get_by_role("button", name="Back to work").click()
        expect(stage).to_be_hidden()
        jonas.wait_for_timeout(2500)
        expect(stage).to_be_hidden()
        expect(sharing.get_by_role("button", name="View")).to_be_visible()
        jonas.evaluate("window.__live.rtc.filter((s) => s.readyState === 1).forEach((s) => s.close())")
        expect(self.bar(jonas).get_by_role("status").first).to_contain_text("Reconnecting", timeout=15000)
        expect(self.bar(jonas).get_by_role("status").first).to_contain_text("Live", timeout=30000)
        jonas.wait_for_timeout(3000)
        expect(stage).to_be_hidden()
        expect(self.bar(jonas).get_by_role("status").filter(has_text="Kai stopped sharing")).to_have_count(0)
        # View brings it back; when Kai stops, it closes and says so.
        sharing.get_by_role("button", name="View").click()
        expect(stage).to_be_visible()
        self.bar(nia).get_by_role("button", name="Stop sharing your screen").click()
        expect(stage).to_be_hidden()
        expect(self.bar(jonas).get_by_role("status").filter(has_text="Kai stopped sharing")).to_be_visible()
        shot(jonas, "live-desktop-1440-stopped-sharing")
        # A new share opens it again, once.
        self.bar(nia).get_by_role("button", name="Share a window, tab or screen").click()
        expect(stage).to_be_visible()
        for leaver in (jonas, nia):
            self.bar(leaver).get_by_role("button", name="Leave", exact=True).click()
            expect(self.bar(leaver)).to_have_count(0)

    def test_00h_a_screen_stopped_right_after_its_mode_changed_leaves_nothing_behind_when_the_camera_follows(self) -> None:
        """#1339: Stop sharing pressed while the screen is being sent again in the other mode, and the camera turned on at once, are three
        steps with the media server. The others' strip and stage drop the screen within moments, stay without it, and offer the camera."""
        self.seed()
        ada = self.page("ada")
        project = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Repair bench", "visibility": "restricted"}, status=201)
        pid = project["id"]
        for key in ("nia", "jonas"):
            self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": PEOPLE[key]["id"]}, "role": "contributor"}, status=201)
        nia = self.page("nia")
        nia.goto(f"/projects/{pid}")
        self.call(nia)
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{pid}")
        jonas.locator("header.top").get_by_role("button", name="Join", exact=True).click()
        expect(self.bar(jonas).locator(".lv-face")).to_have_count(2)
        self.bar(nia).get_by_role("button", name=re.compile("^Microphone off")).click()
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Microphone on"))).to_be_visible()
        sharing = self.bar(jonas).get_by_role("status").filter(has_text="sharing a screen")
        cameras = self.bar(jonas).get_by_role("button", name="Cameras")
        modes = self.bar(nia).get_by_role("radiogroup", name="How your screen is sent")
        # Stops at different moments of the switch back: while the capture is constrained, unpublished, published again, and after.
        for delay in (0, 40, 80, 120, 0, 80):
            self.bar(nia).get_by_role("button", name="Share a window, tab or screen").click()
            expect(sharing).to_be_visible(timeout=10000)
            modes.get_by_role("radio", name="Smooth motion").click()
            expect(modes.get_by_role("radio", name="Smooth motion")).to_have_attribute("aria-checked", "true")
            nia.wait_for_timeout(600)  # the switch to Smooth motion is over; the next one is what the stop meets
            modes.get_by_role("radio", name="Smooth motion").press("ArrowLeft")
            expect(modes.get_by_role("radio", name="Sharp text")).to_have_attribute("aria-checked", "true")
            nia.wait_for_timeout(delay)
            self.bar(nia).get_by_role("button", name="Stop sharing your screen").click()
            self.bar(nia).get_by_role("button", name=re.compile("^Camera off")).click()
            expect(self.bar(nia).get_by_role("button", name=re.compile("^Camera on"))).to_be_visible()
            expect(sharing).to_have_count(0, timeout=5000)
            expect(cameras).to_be_visible(timeout=5000)
            # A screen sent again for a moment may show again before it goes: what is left once things have settled is what counts.
            jonas.wait_for_timeout(1500)
            expect(sharing).to_have_count(0)
            expect(cameras).to_be_visible()
            self.bar(nia).get_by_role("button", name=re.compile("^Camera on")).click()
            expect(cameras).to_have_count(0, timeout=5000)
        for leaver in (jonas, nia):
            self.bar(leaver).get_by_role("button", name="Leave", exact=True).click()
            expect(self.bar(leaver)).to_have_count(0)

    def test_01_two_people_blocker_join_show_screen_result_leave(self) -> None:
        self.seed()
        nia = self.page("nia")
        nia.goto(self.task_url())
        panel = nia.locator("#details")
        expect(panel.get_by_role("heading", name=TASK)).to_be_visible()
        # The blocker is read in place (Edit opens the field), with who it waits for (#344, #550).
        expect(panel.get_by_role("region", name="Blocker")).to_contain_text(BLOCKER)
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
        expect(panel).to_contain_text("You are in the call for this task")
        work_before = self.api(nia, "GET", f"/api/v1/work/{self.ids['work']}", status=200)
        self.assertEqual(work_before["status"], "blocked", "starting a session changes no work status")

        # A targeted invitation: one quiet inbox item with join, later and text.
        bar.get_by_role("button", name="Call details and more").click()
        details = nia.get_by_role("dialog", name="Call details", exact=True)
        expect(details.get_by_role("heading", name=TASK)).to_be_visible()
        # #1424: ⋯'s panel is who is here and the devices; the invite list is "Invite someone"'s own, never a second one beside it.
        expect(details.locator(".lv-person--absent")).to_have_count(0)
        expect(details.get_by_role("button", name="Invite someone")).to_have_count(0)
        shot(nia, "live-desktop-1440-panel")
        nia.keyboard.press("Escape")
        expect(details).to_be_hidden()
        expect(bar.get_by_role("button", name="Call details and more")).to_be_focused()
        bar.get_by_role("button", name="Invite someone").click()
        invite = nia.get_by_role("dialog", name="Invite someone", exact=True)
        row = invite.locator(".lv-person--absent", has_text="Jonas Berg")
        # Jonas has Flux open elsewhere (Home): the invitation reaches him at once as a call notice with Join (#1243).
        jonas = self.page("jonas")
        jonas.goto("/")
        expect(jonas.locator(".app__pane")).to_be_visible()
        jonas.wait_for_timeout(1500)
        row.get_by_role("button", name="Invite").click()
        expect(row).to_contain_text("Invited")
        notice = jonas.locator(".ui-notices .ui-notice")
        expect(notice).to_contain_text("Nia Okafor invited you", timeout=5000)
        expect(notice.get_by_role("button", name="Join")).to_be_visible()
        expect(notice.get_by_role("button", name="Open")).to_have_count(0)
        jonas.wait_for_timeout(6500)
        expect(notice).to_be_visible()  # a call's notice stays until the call ends or it is closed
        shot(jonas, "live-desktop-1440-call-notice")
        nia.keyboard.press("Escape")
        expect(invite).to_be_hidden()
        expect(bar.get_by_role("button", name="Invite someone")).to_be_focused()
        # Inviting again stays one inbox item (the server deduplicates).
        sessions = self.api(nia, "GET", f"/api/v1/projects/{self.ids['project']}/live-sessions", status=200)["items"]
        session_id = next(item["id"] for item in sessions if item["context"]["id"] == self.ids["work"])
        type(self).ids["session1"] = session_id
        self.api(nia, "POST", f"/api/v1/live-sessions/{session_id}/invitations", {"recipientId": PEOPLE["jonas"]["id"]}, status=201)

        jonas.goto("/inbox")
        item = jonas.locator(".nyc", has_text="Nia Okafor invited you to work together")
        expect(item).to_have_count(1)
        expect(item).to_contain_text(TASK)
        shot(jonas, "live-desktop-1440-inbox")
        open_item(item).get_by_role("button", name="Open").click()
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
        jbar.get_by_role("button", name="Call details and more").click()
        jdetails = jonas.get_by_role("dialog", name="Call details", exact=True)
        expect(jdetails.locator(".lv-person", has_text="Nia Okafor")).to_contain_text("microphone on")
        jonas.keyboard.press("Escape")

        # AC-2: navigation keeps one connection; showing a doc does not move anybody.
        tabs = nia.get_by_role("navigation", name="Space views")
        tabs.get_by_role("tab", name=re.compile("^Wiki")).click()
        # The Wiki opens its first page itself; with one page there is no list to click (#869).
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
        tabs.get_by_role("tab", name=re.compile("^Map")).click()
        # A project with one sketch opens it from the Map tab; with several the list comes first.
        sketch_link = nia.get_by_role("link", name=re.compile("Why are night frames black"))
        thought = nia.get_by_text("IR-cut filter stays in").first
        expect(sketch_link.or_(thought).first).to_be_visible()
        if sketch_link.count():
            sketch_link.click()
        thought.click()
        self.bar(nia).get_by_role("button", name="Show this").click()
        expect(jonas).to_have_url(re.compile(f"/map/{self.ids['sketch']}$"))
        expect(self.bar(jonas)).to_contain_text("“IR-cut filter stays in” · thought on")
        expect(self.bar(jonas).get_by_role("button", name="Stop following")).to_be_visible()
        expect(jonas.locator(f'.sk-node[data-id="{self.ids["filter"]}"]')).to_have_attribute("aria-pressed", "true")
        # Independent navigation ends following, calmly.
        jonas.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile("^Tasks")).click()
        expect(jonas.get_by_text("Stopped following Nia Okafor")).to_be_visible()
        expect(self.bar(jonas).get_by_role("button", name="Stop following")).to_have_count(0)
        self.assertEqual(jonas.evaluate("window.__live.sockets"), 1)

        # External screen: explicit browser picker (auto-selected by the fake UI here).
        self.bar(nia).get_by_role("button", name="Share a window, tab or screen").click()
        expect(self.bar(nia).get_by_role("button", name="Stop sharing your screen")).to_have_attribute("aria-pressed", "true")
        expect(self.bar(nia)).to_contain_text("You are sharing your screen")
        self.assertEqual(nia.evaluate("window.__live.gdm"), 1)
        # F-041: Jonas's stage opens by itself on her screen, and the strip says who shares.
        stage = jonas.get_by_role("region", name="Shared screens and cameras")
        expect(stage).to_be_visible()
        expect(self.bar(jonas).get_by_role("status").filter(has_text="Nia is sharing a screen")).to_be_visible()
        expect(self.bar(jonas).get_by_role("button", name=re.compile("Nia.s screen"))).to_have_attribute("aria-pressed", "true")

        video = stage.locator("video.lv-stage__video")
        expect(video).to_be_visible()
        jonas.wait_for_function("() => { const v = document.querySelector('video.lv-stage__video'); return v && v.videoWidth > 0; }", timeout=20000)
        stage.get_by_role("button", name="1:1").click()
        expect(stage.get_by_role("button", name="1:1")).to_have_attribute("aria-pressed", "true")
        stage.get_by_role("button", name="Zoom in").click()
        expect(stage).to_contain_text("125%")
        shot(jonas, "live-desktop-1440-stage-one-screen")
        # Smooth motion (#63): chosen in the sharing line while sharing; the same capture is sent again, no new
        # picker, and Jonas keeps seeing the screen in the same place.
        modes = self.bar(nia).get_by_role("radiogroup", name="How your screen is sent")
        expect(modes.get_by_role("radio", name="Sharp text")).to_have_attribute("aria-checked", "true")
        modes.get_by_role("radio", name="Smooth motion").click()
        expect(modes.get_by_role("radio", name="Smooth motion")).to_have_attribute("aria-checked", "true")
        expect(self.bar(nia).get_by_role("button", name="Stop sharing your screen")).to_have_attribute("aria-pressed", "true")
        self.assertEqual(nia.evaluate("window.__live.gdm"), 1, "switching asks for no new screen")
        jonas.wait_for_function("() => { const v = document.querySelector('video.lv-stage__video'); return v && v.videoWidth > 0 && !v.paused; }", timeout=20000)
        expect(stage.locator("video.lv-stage__video")).to_have_count(1)
        shot(nia, "live-desktop-1440-sharing-smooth-motion")
        # Arrow keys move the choice back; it is remembered for the next share on this browser.
        modes.get_by_role("radio", name="Smooth motion").press("ArrowLeft")
        expect(modes.get_by_role("radio", name="Sharp text")).to_have_attribute("aria-checked", "true")
        expect(modes.get_by_role("radio", name="Sharp text")).to_be_focused()
        jonas.keyboard.press("Escape")
        expect(stage).to_be_hidden()
        self.bar(nia).get_by_role("button", name="Stop sharing your screen").click()
        expect(self.bar(nia).get_by_role("button", name="Share a window, tab or screen")).to_be_visible()

        # A larger camera (#63): on the camera stage a tile is its own toggle; the camera then fills the stage.
        self.bar(nia).get_by_role("button", name=re.compile("^Camera off")).click()
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Camera on"))).to_be_visible()
        # Nia's screen leaves Jonas's strip within moments of her stopping it, though she went on to the camera at once (#1339: the strip
        # kept a screen nobody sent when the stop overlapped the screen's last switch of mode and the camera's publication).
        expect(self.bar(jonas).get_by_role("status").filter(has_text="sharing a screen")).to_have_count(0, timeout=5000)
        expect(self.bar(jonas).get_by_role("button", name=re.compile("Nia.s screen"))).to_have_count(0)
        # The same place then offers the cameras once her camera track reaches him
        # through the SFU, which takes as long as the other media waits here under load (#249 acceptance run).
        expect(self.bar(jonas).get_by_role("button", name="Cameras")).to_be_visible(timeout=20000)
        self.bar(jonas).get_by_role("button", name="Cameras").click()
        stage = jonas.get_by_role("region", name="Shared screens and cameras")
        large = stage.get_by_role("button", name=re.compile("^Show Nia.* camera large$"))
        large.click()
        expect(large).to_have_attribute("aria-pressed", "true")
        big = stage.get_by_label(re.compile("^Nia.* camera, enlarged$"))
        expect(big).to_be_visible()
        jonas.wait_for_function("() => { const v = document.querySelector('.lv-stage__view--camera video'); return v && v.videoWidth > 0; }", timeout=20000)
        tile = stage.locator(".lv-cam").first.bounding_box()["width"]
        self.assertGreater(big.bounding_box()["width"], 2 * tile, "the enlarged camera fills the stage, far wider than a tile")
        expect(stage.locator(".lv-cam.is-enlarged")).to_contain_text("Shown large")
        shot(jonas, "live-desktop-1440-camera-large")
        large.click()
        expect(large).to_have_attribute("aria-pressed", "false")
        expect(stage.locator(".lv-stage__view--camera")).to_have_count(0)
        jonas.keyboard.press("Escape")
        expect(stage).to_be_hidden()
        self.bar(nia).get_by_role("button", name=re.compile("^Camera on")).click()
        expect(self.bar(nia).get_by_role("button", name=re.compile("^Camera off"))).to_be_visible()

        # A persisted change through the ordinary task action, during the session (no reload).
        jonas.get_by_text(TASK).first.click()
        jpanel = jonas.locator("#details")
        expect(jpanel.get_by_role("heading", name=TASK)).to_be_visible()
        # The change is saved through the ordinary work API while the session runs; the panel's own
        # controls are covered by tests/ui/test_work_details.py.
        note = "IR-cut filter stays in on rev B; night mode works with it removed"
        task = self.api(jonas, "GET", f"/api/v1/work/{self.ids['work']}", status=200)
        self.api(jonas, "PATCH", f"/api/v1/work/{self.ids['work']}", {"outcome": note, "expectedVersion": task["version"]}, status=200,
                 headers={"idempotency-key": str(uuid.uuid4())})
        self.assertEqual(self.api(jonas, "GET", f"/api/v1/work/{self.ids['work']}", status=200)["status"], "blocked", "saving the outcome does not change status by itself")
        self.assertEqual(jonas.evaluate("window.__live.sockets"), 1, "saving the change kept the one connection")

        # Leaving releases every device; saved work stays; nothing is generated.
        self.bar(nia).get_by_role("button", name="Leave", exact=True).click()
        expect(self.bar(nia)).to_have_count(0)
        nia.wait_for_function("() => window.__live.tracks.every((t) => t.readyState === 'ended')")
        expect(self.bar(jonas).locator(".lv-face")).to_have_count(1)
        self.bar(jonas).get_by_role("button", name="Leave", exact=True).click()
        expect(jonas.get_by_text(re.compile("Nobody else was here"))).to_be_visible()
        self.assertEqual(self.api(jonas, "GET", f"/api/v1/work/{self.ids['work']}", status=200)["outcome"], note, "the change is saved in the task")
        self.assertEqual(self.api(jonas, "GET", f"/api/v1/docs/{self.ids['doc']}", status=200)["version"], 1, "showing a doc made no new version")
        docs = self.api(jonas, "GET", f"/api/v1/projects/{self.ids['project']}/docs", status=200)
        self.assertEqual(len(docs["items"] if isinstance(docs, dict) else docs), 1, "no meeting report or empty doc was generated")

    def test_02_four_people_two_screens_quiet_and_device_problems(self) -> None:
        self.seed()
        ada = self.page("ada")
        ada.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}")
        expect(ada.get_by_role("heading", name=DOC, level=2)).to_be_visible()
        ada.locator("header.top, header.phead").get_by_role("button", name="Call").click()
        expect(self.bar(ada).get_by_role("button", name=re.compile(re.escape(DOC)))).to_be_visible()

        pages = {"ada": ada}
        for who in ("jonas", "nia", "kai"):
            page = self.page(who, viewport=SMALL_DESKTOP) if who == "kai" else self.page(who)
            if who == "kai":
                page.add_init_script("window.__denyCamera = true;")
            page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}")
            join = page.locator("header.top, header.phead").get_by_role("button", name="Join")
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
        # The first shared screen opened Ada's stage by itself (F-041); the second joins its choice.
        expect(two).to_have_attribute("aria-pressed", "true")
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
        self.bar(nia).get_by_role("button", name="Call details and more").click()
        dialog = nia.get_by_role("dialog", name="Call details", exact=True)
        dialog.get_by_role("switch", name=re.compile("Work quietly")).click()
        nia.keyboard.press("Escape")
        # Escape closes the panel; it leaves through a short exit (inert meanwhile) before its controls are gone.
        expect(dialog).to_have_count(0)
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
        self.bar(nia).get_by_role("button", name="Call details and more").click()
        nia.get_by_role("dialog", name="Call details", exact=True).get_by_role("switch", name=re.compile("Work quietly")).click()
        nia.keyboard.press("Escape")
        expect(nia.get_by_role("dialog", name="Call details", exact=True)).to_have_count(0)
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
        self.bar(nia).get_by_role("button", name="Call details and more").click()
        nia.get_by_role("dialog", name="Call details", exact=True).get_by_role("switch", name=re.compile("Work quietly")).click()
        nia.keyboard.press("Escape")
        expect(nia.get_by_role("dialog", name="Call details", exact=True)).to_have_count(0)
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
        self.open_conversation(nia)
        nia.locator("header.top, header.phead").get_by_role("button", name="Call").click()
        expect(self.bar(nia)).to_be_visible()
        phone = self.page("jonas", phone=True)
        self.open_conversation(phone)
        phone.locator("header.top, header.phead").get_by_role("button", name="Join").click()
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
        # #1378: at 390 px the live dot keeps its word, every item shares the row's centre line and nothing in the row is cut or outside it.
        expect(bar.locator(".lv-status").first).to_be_visible()
        row = bar.evaluate("""el => { const row = el.querySelector('.lv-row').getBoundingClientRect(); const mid = (r) => r.top + r.height / 2;
          const items = ['.lv-row__lead', '.lv-where__t', '.lv-row__acts'].map((s) => el.querySelector(s)).filter(Boolean).map((n) => n.getBoundingClientRect());
          return { centres: items.map((r) => Math.round(Math.abs(mid(r) - mid(row)))), inside: items.every((r) => r.left >= row.left - 0.5 && r.right <= row.right + 0.5) }; }""")
        self.assertTrue(all(gap <= 2 for gap in row["centres"]), row)
        self.assertTrue(row["inside"], row)
        # No fake screen publishing on a phone browser without the picker.
        can_capture = phone.evaluate("typeof navigator.mediaDevices?.getDisplayMedia === 'function'")
        if not can_capture:
            expect(bar.get_by_role("button", name="Share a window, tab or screen")).to_have_count(0)
        shot(phone, "live-phone-390-strip")
        bar.get_by_role("button", name="Call details and more").click()
        sheet = phone.get_by_role("dialog", name="Call details", exact=True)
        # Call on the conversation page is the space's call (F-041): the space is the session's name, never a message's text.
        expect(sheet.get_by_role("heading", name="Gesture lamp")).to_be_visible()
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
        expect(self.bar(phone).get_by_role("button", name="Call details and more")).to_be_focused()
        # #1424: on a phone ⋯'s sheet has the one "Invite someone" row, which opens the small list of people and nothing else.
        bar.get_by_role("button", name="Call details and more").tap()
        phone.get_by_role("dialog", name="Call details", exact=True).get_by_role("button", name="Invite someone").tap()
        invite = phone.get_by_role("dialog", name="Invite someone", exact=True)
        expect(invite.locator(".lv-person--absent").first).to_be_visible()
        expect(invite).not_to_contain_text("Microphone")
        shot(phone, "live-phone-390-invite")
        invite.get_by_role("button", name="Close").tap()
        expect(invite).to_be_hidden()
        # Nia shares her screen; the phone views it and zooms without publishing anything.
        self.bar(nia).get_by_role("button", name="Share a window, tab or screen").click()
        # On a phone a new shared screen is offered in a sheet (F-041), not opened over the work.
        offer = phone.get_by_role("dialog", name="Shared screen")
        expect(offer).to_contain_text("Nia is sharing a screen")
        shot(phone, "live-phone-390-screen-offer")
        offer.get_by_role("button", name=re.compile("^View Nia.s screen$")).click()
        stage = phone.get_by_role("region", name="Shared screens and cameras")
        phone.wait_for_function("() => { const v = document.querySelector('video.lv-stage__video'); return v && v.videoWidth > 0; }", timeout=20000)
        shot(phone, "live-phone-390-stage")
        stage.get_by_role("button", name="Back to work").click()
        # Typing with the session open keeps the draft through navigation.
        draft = "Filter out gives 18 of 20 at 5 lux, writing it up now"
        composer_box = phone.get_by_label("Write a message", exact=True)
        composer_box.fill(draft)
        project_view(phone, "Wiki")
        expect(phone).to_have_url(re.compile(r"/docs(/|$)"))
        expect(phone.locator(".wiki-editor")).to_be_visible()
        project_view(phone, "Conversation")
        # The router keeps the Wiki on screen until the conversation has loaded, and under load that takes a moment after the tap: the
        # last textbox then is the page's editor, and `to_have_value` does not retry on an element that is not a field ("Not an input
        # element", #1074). Wait for the place first, then read the composer by its name.
        expect(phone).not_to_have_url(re.compile(r"/docs(/|$)"))
        expect(composer_box).to_have_value(draft)
        expect(self.bar(phone)).to_be_visible()
        self.assertEqual(phone.evaluate("window.__live.sockets"), 1)

        tablet = self.page("kai", viewport=TABLET)
        self.open_conversation(tablet)
        tablet.locator("header.top, header.phead").get_by_role("button", name="Join").click()
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
        self.assertIn(page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--dur-in').trim()"), ("0ms", "0s"))
        # Every strip control is reachable with Tab and names its state.
        more = bar.get_by_role("button", name="Call details and more")
        more.focus()
        page.keyboard.press("Enter")
        dialog = page.get_by_role("dialog", name="Call details", exact=True)
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
