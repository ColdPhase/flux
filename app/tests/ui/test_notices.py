"""Browser tests for the in-app notice (#1243; docs/design/final/README.md "Notices", docs/product/mobile-pwa.md "While Flux is open").

Runs through scripts/check_ui.sh against the running Compose application, whose worker turns committed events into
notifications and announces the ones that interrupt their person on the live stream. Jonas writes to Ada through the
public API while Ada's tab is open elsewhere (Home); Nia follows on a phone. The card must come within 2 s, carry the
right buttons, open the exact place and read the item, group a burst into one card, pause while hovered, stay away from
the place on screen and from quiet hours, and never take focus. FLUX_UI_BROWSER selects chromium (default) or webkit.
Screenshots (notices-*-<browser>.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder
from test_settings import UI_BROWSER, shot

PASSWORD = "a calm notice in the corner"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.nt+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.nt+{STAMP}@example.test"),
    "nia": ("Nia Okafor", f"nia.nt+{STAMP}@example.test"),
}
SPACE = "Community garden sensors"


class NoticeJourney(unittest.TestCase):
    """Tests run in name order and share the accounts and the places."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    project_id = ""
    dm_id = ""
    nia_dm_id = ""
    conversation_id = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        cls.api_contexts: dict[str, BrowserContext] = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            cls.api_contexts[key] = context
        cls.workspace_id = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        for key in ("jonas", "nia"):
            cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE[key][1], "role": "member"})
        cls.project_id = cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": SPACE, "visibility": "workspace"})["id"]
        cls.conversation_id = cls.post("ada", f"/api/v1/projects/{cls.project_id}/conversations", {"body": "Wiring plan for the east beds", "clientMessageId": str(uuid.uuid4())})["id"]
        cls.dm_id = cls.post("jonas", f"/api/v1/workspaces/{cls.workspace_id}/dms", {"participantIds": [cls.ids["ada"]]})["id"]
        cls.nia_dm_id = cls.post("jonas", f"/api/v1/workspaces/{cls.workspace_id}/dms", {"participantIds": [cls.ids["nia"]]})["id"]

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.api_contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def post(cls, who: str, path: str, body: dict) -> dict:
        response = cls.api_contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
        return response.json()

    @classmethod
    def request(cls, who: str, method: str, path: str, body: dict | None = None) -> dict:
        response = cls.api_contexts[who].request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
        assert response.status < 300, f"{path}: {response.status} {response.text()}"
        return response.json() if response.text() else {}

    def dm(self, body: str, dm_id: str | None = None) -> float:
        self.post("jonas", f"/api/v1/dms/{dm_id or self.dm_id}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
        return time.monotonic()

    def say(self, body: str) -> float:
        self.post("jonas", f"/api/v1/conversations/{self.conversation_id}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
        return time.monotonic()

    def page(self, who: str, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "storage_state": self.states[who], "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def home(self, who: str = "ada", **kwargs) -> Page:
        page = self.page(who, **kwargs)
        # The live stream is open before anyone writes (the notice rides on it, #1243): wait for its socket's first frame.
        frames: list[str] = []
        page.on("websocket", lambda socket: socket.on("framereceived", lambda payload: frames.append(str(payload))) if "/api/v1/stream" in socket.url else None)
        page.goto("/")
        expect(page.locator(".app__pane")).to_be_visible()
        for _ in range(150):
            if any('"ready"' in frame for frame in frames):
                break
            page.wait_for_timeout(100)
        self.assertTrue(any('"ready"' in frame for frame in frames), "the live stream is open")
        return page

    def card(self, page: Page):
        return page.locator(".ui-notices .ui-notice")

    def unread(self, who: str, notification_id: str) -> bool:
        return self.request(who, "GET", f"/api/v1/inbox/{notification_id}")["readAt"] is None

    def quiet(self, who: str, on: bool) -> None:
        self.request(who, "PATCH", "/api/v1/notification-preferences", {"quietHours": {"enabled": on, "start": "00:00", "end": "23:59", "timeZone": "UTC"}} if on else {"quietHours": {"enabled": False}})

    def newest(self, who: str, reason: str) -> dict:
        items = [item for item in self.request(who, "GET", "/api/v1/inbox?limit=20")["items"] if item["reason"] == reason]
        self.assertTrue(items, f"a {reason} notification")
        return items[0]

    # ---------------------------------------------------------------- a direct message

    def test_01_a_direct_message_shows_a_notice_within_2_s_and_open_reads_it(self) -> None:
        page = self.home()
        focused = page.evaluate("() => document.activeElement?.tagName")
        sent = self.dm("Can you check the probe readings before Friday? Two of them look off since the rain.")
        card = self.card(page)
        expect(card).to_be_visible(timeout=5000)
        took = time.monotonic() - sent
        self.assertLess(took, 2.0, f"the notice came in {took:.2f} s")
        expect(card).to_contain_text("Jonas Berg sent you a message")
        expect(card).to_contain_text("probe readings")
        expect(card.locator(".ui-avatar")).to_have_text("JB")
        expect(card.get_by_role("button", name="Reply")).to_be_visible()
        expect(card.get_by_role("button", name="Open")).to_be_visible()
        expect(card.get_by_role("button", name="Close")).to_be_visible()
        # Polite, and it never takes focus.
        self.assertEqual(page.locator(".ui-notices").get_attribute("role"), "status")
        self.assertEqual(page.locator(".ui-notices").get_attribute("aria-live"), "polite")
        self.assertEqual(page.evaluate("() => document.activeElement?.tagName"), focused)
        # Bottom right on a computer, 20 px from the edges (measured once its entrance has ended).
        card.evaluate("el => Promise.all(el.getAnimations().map((animation) => animation.finished))")
        box = card.bounding_box()
        assert box
        self.assertAlmostEqual(box["x"] + box["width"], DESKTOP["width"] - 20, delta=1)
        self.assertAlmostEqual(box["y"] + box["height"], DESKTOP["height"] - 20, delta=1)
        self.assertLessEqual(box["width"], 360.5)
        page.mouse.move(10, 10)
        shot(page, "notices-desktop-1440-light-dm")
        item = self.newest("ada", "dm")
        self.assertTrue(self.unread("ada", item["id"]))
        card.get_by_role("button", name="Open").click()
        expect(page).to_have_url(re.compile(rf"/dm/{self.dm_id}"))
        expect(card).to_have_count(0)
        for _ in range(40):
            if not self.unread("ada", item["id"]):
                break
            time.sleep(0.1)
        self.assertFalse(self.unread("ada", item["id"]), "opening it reads the item")

    def test_02_reply_opens_the_conversation_with_the_composer_focused(self) -> None:
        page = self.home()
        self.dm("Also, do we have spare connectors?")
        card = self.card(page)
        expect(card).to_be_visible(timeout=5000)
        card.get_by_role("button", name="Reply").click()
        expect(page).to_have_url(re.compile(rf"/dm/{self.dm_id}"))
        expect(page.locator("#dm-composer")).to_be_focused()

    def test_03_nothing_for_the_place_on_screen(self) -> None:
        page = self.page("ada")
        page.goto(f"/dm/{self.dm_id}")
        expect(page.locator("#dm-composer")).to_be_visible()
        page.wait_for_timeout(800)
        self.dm("I'm in the shed now.")
        expect(page.get_by_text("I'm in the shed now.")).to_be_visible()
        page.wait_for_timeout(2500)
        expect(self.card(page)).to_have_count(0)

    # ---------------------------------------------------------------- a mention, a task, a burst

    def test_04_a_mention_and_a_task_show_open(self) -> None:
        page = self.home()
        self.say("@Ada Kowalska could you check the calibration table before Friday")
        card = self.card(page)
        expect(card).to_contain_text(f"Jonas Berg mentioned you in {SPACE}", timeout=5000)
        expect(card.get_by_role("button", name="Open")).to_be_visible()
        expect(card.get_by_role("button", name="Reply")).to_have_count(0)
        card.get_by_role("button", name="Close").click()
        expect(card).to_have_count(0)
        self.post("jonas", f"/api/v1/projects/{self.project_id}/work", {"title": "Replace the corroded probe in bed 4", "owner": {"kind": "human", "id": self.ids["ada"]}})
        expect(card).to_contain_text("Jonas Berg assigned you", timeout=5000)
        expect(card).to_contain_text("Replace the corroded probe")
        card.get_by_role("button", name="Open").click()
        # The task opens in its panel (the address's ?open= is short-lived, so the panel is what is checked).
        expect(page).to_have_url(re.compile(rf"/projects/{self.project_id}/tasks"))
        expect(page.locator("#details")).to_contain_text("Replace the corroded probe in bed 4")

    def test_05_a_burst_from_one_place_is_one_grouped_card(self) -> None:
        page = self.home()
        for line in ("@Ada Kowalska the east bed reads 41%", "@Ada Kowalska the west bed reads 38%", "@Ada Kowalska I moved the calibration notes to the Wiki"):
            self.say(line)
        card = self.card(page)
        expect(card).to_contain_text(f"3 new messages in {SPACE}", timeout=8000)
        # The newest preview says whose it is, and drops the opening mention of Ada herself.
        expect(card.locator(".ui-notice__body")).to_have_text("Jonas: I moved the calibration notes to the Wiki")
        self.assertEqual(page.locator(".ui-notice").count(), 1, "never more than one card")
        page.mouse.move(10, 10)
        shot(page, "notices-desktop-1440-light-grouped")
        card.get_by_role("button", name="Open").click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.project_id}/conversations/"))

    def test_06_it_stays_about_6_s_and_pauses_while_hovered(self) -> None:
        page = self.home()
        self.dm("Quick one: the gate code changed.")
        card = self.card(page)
        expect(card).to_be_visible(timeout=5000)
        card.hover()
        page.wait_for_timeout(7500)
        expect(card).to_be_visible()
        page.mouse.move(10, 10)
        expect(card).to_have_count(0, timeout=8000)

    def test_06b_tab_reaches_the_actions_then_close_and_escape_closes_it(self) -> None:
        page = self.home()
        self.dm("Quick one: the shed key is under the pot.")
        card = self.card(page)
        expect(card).to_be_visible(timeout=5000)
        page.locator("#content").focus()
        card.get_by_role("button", name="Reply").focus()
        page.keyboard.press("Tab")
        expect(card.get_by_role("button", name="Open")).to_be_focused()
        page.keyboard.press("Tab")
        expect(card.get_by_role("button", name="Close")).to_be_focused()
        page.keyboard.press("Escape")
        expect(card).to_have_count(0)
        self.assertEqual(page.evaluate("document.activeElement?.id"), "content", "focus goes back where it came from")

    def test_07_quiet_hours_hold_it(self) -> None:
        self.quiet("ada", True)
        self.addCleanup(lambda: self.quiet("ada", False))
        page = self.home()
        self.dm("Are you around tonight?")
        page.wait_for_timeout(3000)
        expect(self.card(page)).to_have_count(0)

    # ---------------------------------------------------------------- dark and the phone

    def test_08_dark_on_the_computer(self) -> None:
        page = self.home(dark=True)
        self.dm("The rain barrel sensor is back online.")
        card = self.card(page)
        expect(card).to_be_visible(timeout=5000)
        page.mouse.move(10, 10)
        shot(page, "notices-desktop-1440-dark-dm")

    def test_09_on_the_phone_it_is_at_the_top_and_its_buttons_are_44_px(self) -> None:
        for dark in (False, True):
            page = self.home("nia", phone=True, dark=dark)
            self.dm("Nia, can you water bed 2 on your way?", self.nia_dm_id)
            card = self.card(page)
            expect(card).to_be_visible(timeout=5000)
            # Focus in the card holds it past its 6 s while it is measured (a slow runner measures for longer than that).
            card.get_by_role("button", name="Close").focus()
            # Everything is read in one step once the entrance has ended; if the card is gone by then, say what the page shows.
            found = page.evaluate("""async () => {
                const card = document.querySelector('.ui-notices .ui-notice');
                if (!card) return { gone: true, modal: !!document.querySelector('[aria-modal="true"]'), text: document.body.innerText.slice(0, 400) };
                await Promise.all(card.getAnimations().map((animation) => animation.finished));
                const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
                const buttons = Object.fromEntries([...card.querySelectorAll('button')].map((button) => [button.getAttribute('aria-label') || button.textContent.trim(), rect(button)]));
                return { gone: false, card: rect(card), buttons, text: card.innerText };
            }""")
            self.assertFalse(found["gone"], f"the card is still there: {found}")
            box = found["card"]
            self.assertLess(box["y"], 80, "at the top, under the safe area")
            self.assertAlmostEqual(box["x"], 16, delta=1)
            self.assertAlmostEqual(box["width"], PHONE["width"] - 32, delta=1)
            for name in ("Reply", "Open", "Close"):
                self.assertIn(name, found["buttons"], f"{name} in {found}")
                self.assertGreaterEqual(found["buttons"][name]["height"], 44, f"{name} is a 44 px target")
            shot(page, f"notices-phone-390-{'dark' if dark else 'light'}-dm")
            card.get_by_role("button", name="Close").tap()
            expect(card).to_have_count(0)

    # ---------------------------------------------------------------- the tab, the badge and sound

    FAKE_AUDIO_AND_BADGE = """
        window.__tones = 0; window.__badges = [];
        class FakeAudio {
          constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
          resume() { return Promise.resolve(); }
          createOscillator() { return { type: '', frequency: { value: 0 }, connect: (node) => node, start() { window.__tones += 1; }, stop() {} }; }
          createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node) => node }; }
        }
        window.AudioContext = FakeAudio;
        navigator.setAppBadge = (count) => { window.__badges.push(count); return Promise.resolve(); };
        navigator.clearAppBadge = () => { window.__badges.push(0); return Promise.resolve(); };
    """

    def test_10_the_tab_title_favicon_and_badge_count_what_would_notify_and_clear_when_read(self) -> None:
        self.request("ada", "POST", "/api/v1/inbox/read-all")
        page = self.page("ada")
        page.add_init_script(self.FAKE_AUDIO_AND_BADGE)
        page.goto("/")
        expect(page).to_have_title("Flux")
        page.wait_for_timeout(1500)
        self.dm("Did the new connectors arrive?")
        expect(page).to_have_title("(1) Flux", timeout=8000)
        icon = page.locator('link[rel="icon"]').first
        expect(icon).to_have_attribute("href", "/icons/icon-dot.svg")
        page.wait_for_function("() => window.__badges.includes(1)")
        page.mouse.move(10, 10)
        shot(page, "notices-desktop-1440-light-tab-count")
        self.card(page).get_by_role("button", name="Open").click()
        expect(page).to_have_url(re.compile(rf"/dm/{self.dm_id}"))
        expect(page).to_have_title("Flux", timeout=8000)
        expect(icon).to_have_attribute("href", "/icons/icon.svg")
        page.wait_for_function("() => window.__badges.at(-1) === 0")

    def test_11_sounds_are_one_switch_on_by_default_that_plays_once_and_turns_off(self) -> None:
        """#1419 item 18: one "Sounds" switch (a call's chime and the message tone together) replaces the two of #1243."""
        page = self.page("ada")
        page.add_init_script(self.FAKE_AUDIO_AND_BADGE)
        page.goto("/settings/notifications")
        sounds = page.get_by_role("switch", name="Sounds")
        expect(sounds).to_have_attribute("aria-checked", "true")
        # One switch, not two: the old pair is gone, whether or not this server has calls.
        expect(page.get_by_role("switch", name="Sound for messages")).to_have_count(0)
        expect(page.get_by_role("switch", name="Sound when someone calls me")).to_have_count(0)
        expect(page.get_by_role("heading", name="Sound", exact=True)).to_have_count(0)
        # Its own card after Where, with no heading, and Hide previews / Quiet hours stay where #1346 drew them.
        expect(page.get_by_role("group", name="Where").get_by_role("switch", name="Sounds")).to_have_count(0)
        shot(page, "notices-desktop-1440-light-sound-settings")
        page.goto("/")
        page.wait_for_timeout(1500)
        self.dm("Now you hear me.")
        expect(self.card(page)).to_be_visible(timeout=5000)
        page.wait_for_function("() => window.__tones === 1")
        # A burst that joins the card shown does not sound again.
        self.dm("And again.")
        expect(self.card(page)).to_contain_text("2 new messages", timeout=5000)
        page.wait_for_timeout(500)
        self.assertEqual(page.evaluate("window.__tones"), 1)
        self.card(page).get_by_role("button", name="Close").click()

        # Turning the one switch off silences the next notice, and stores both of the pair.
        page.goto("/settings/notifications")
        switch = page.get_by_role("switch", name="Sounds")
        switch.click()
        expect(switch).to_have_attribute("aria-checked", "false")
        self.addCleanup(lambda: self.request("ada", "PATCH", "/api/v1/notification-preferences", {"sound": {"messages": False, "calls": True}}))
        for _ in range(40):
            if self.request("ada", "GET", "/api/v1/notification-preferences")["sound"] == {"messages": False, "calls": False}:
                break
            time.sleep(0.1)
        self.assertEqual(self.request("ada", "GET", "/api/v1/notification-preferences")["sound"], {"messages": False, "calls": False})
        page.get_by_role("link", name=re.compile("^Home")).first.click()
        page.wait_for_timeout(1500)
        self.dm("Silent again.")
        expect(self.card(page)).to_be_visible(timeout=5000)
        page.wait_for_timeout(500)
        self.assertEqual(page.evaluate("window.__tones"), 0, "no sound while Sounds is off")


if __name__ == "__main__":
    unittest.main()
