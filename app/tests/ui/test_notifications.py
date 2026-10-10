"""Browser tests for the inbox and notification settings (issue #116, AC-2/AC-3/AC-4/AC-6; #342: the Inbox is the "Needs you" queue).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose
application, whose worker turns committed events into notifications. Kai creates real activity
for Ada through the public API (a question, a reply, a DM, assigned work, a decision to review
and a mention). Ada finds it from the rail's quiet dot, opens exact sources, marks items read,
changes preferences, mutes a place, adds and verifies an extra address through Mailpit and uses
the inbox on a phone. Each step is checked against the API. FLUX_UI_BROWSER selects chromium
(default) or webkit. Screenshots (notifications-*-<browser>.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import urllib.parse
import urllib.request
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, MAILPIT, ORIGIN, PHONE, UPSTREAM, start_forwarder
from test_settings import UI_BROWSER, assert_touch_target, shot

PASSWORD = "a calm inbox for the garden"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.n+{STAMP}@example.test"),
    "kai": ("Kai Tanaka", f"kai.n+{STAMP}@example.test"),
}
EXTRA = f"ada.home+{STAMP}@example.test"


def wait_for_mail(address: str, containing: str) -> str:
    assert MAILPIT, "FLUX_MAILPIT_URL is required"
    query = urllib.parse.quote(f'to:"{address}"')
    for _ in range(80):
        with urllib.request.urlopen(f"{MAILPIT}/api/v1/search?query={query}") as response:
            found = json.load(response)
        for message in found.get("messages", []):
            with urllib.request.urlopen(f"{MAILPIT}/api/v1/message/{message['ID']}") as response:
                text = json.load(response)["Text"]
            if containing in text:
                return text
        time.sleep(0.25)
    raise AssertionError(f"no mail with {containing!r} arrived for {address}")


class NotificationJourney(unittest.TestCase):
    """Tests run in name order and share the accounts, the workspace and the activity."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    project_id = ""
    urls: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        contexts: dict[str, BrowserContext] = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def post(who: str, path: str, body: dict) -> dict:
            response = contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        cls.workspace_id = post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE["kai"][1], "role": "member"})
        cls.project_id = post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Garden sensors", "visibility": "workspace"})["id"]
        post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Tool library", "visibility": "workspace"})
        message = lambda who, conversation, body: post(who, f"/api/v1/conversations/{conversation}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731
        opened = lambda who, body: post(who, f"/api/v1/projects/{cls.project_id}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731

        # Realistic activity for Ada, oldest first.
        wiring = opened("ada", "Wiring plan for the east beds")
        message("kai", wiring["id"], "I pulled the 3 m cable, but the connectors don't fit the new probes.")
        question = opened("kai", "@Ada Kowalska could you check the calibration table before Friday? Readings drift after rain.")
        cls.urls["question"] = f"/projects/{cls.project_id}/conversations/{question['id']}#message-{question['messages'][0]['id']}"
        dm = post("kai", f"/api/v1/workspaces/{cls.workspace_id}/dms", {"participantIds": [cls.ids["ada"]]})
        post("kai", f"/api/v1/dms/{dm['id']}/messages", {"body": "Can you bring the soldering iron tomorrow?", "clientMessageId": str(uuid.uuid4())})
        work = post("kai", f"/api/v1/projects/{cls.project_id}/work", {"title": "Replace the corroded probe in bed 4", "owner": {"kind": "human", "id": cls.ids["ada"]}})
        cls.urls["work"] = work["id"]
        post("kai", f"/api/v1/projects/{cls.project_id}/decisions", {"title": "Switch to capacitive probes", "rationale": "They do not corrode in wet soil", "affects": [work["id"]]})
        message("kai", question["id"], "Thanks @Ada Kowalska, the dashboard is live now.")
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None) -> dict:
        response = page.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
        self.assertLess(response.status, 300, response.text())
        return response.json() if response.text() else {}

    def settled(self, page: Page, done) -> dict:
        """Settings save as you change them; waits until the stored preferences show the change."""
        for _ in range(40):
            prefs = self.api(page, "GET", "/api/v1/notification-preferences")
            if done(prefs):
                return prefs
            time.sleep(0.25)
        return prefs

    def wait_for_inbox(self, page: Page, count: int) -> dict:
        for _ in range(80):
            inbox = self.api(page, "GET", "/api/v1/inbox")
            if len(inbox["items"]) >= count:
                return inbox
            time.sleep(0.25)
        raise AssertionError(f"expected {count} notifications, found {inbox}")

    # ---------------------------------------------------------------- the inbox from the rail

    def wait_for_needs(self, page: Page, count: int) -> dict:
        for _ in range(80):
            queue = self.api(page, "GET", "/api/v1/needs-you")
            if queue["count"] >= count:
                return queue
            time.sleep(0.25)
        raise AssertionError(f"expected {count} things that need Ada, found {queue}")

    def test_01_inbox_from_the_sidebar_with_its_count(self) -> None:
        page = self.page("ada")
        self.wait_for_inbox(page, 6)
        queue = self.wait_for_needs(page, 3)
        self.assertEqual([item["kind"] for item in queue["items"]], ["decision", "question", "mention"])
        page.goto("/")
        rail = page.get_by_role("navigation", name="Places")
        inbox_link = rail.get_by_role("link", name=re.compile(r"^Inbox, \d+ new$"))
        expect(inbox_link).to_be_visible()
        # The final design's Inbox count (F-026 §4): what needs you, and the same number the link's name gives.
        count = inbox_link.locator(".side__count")
        expect(count).to_have_text("3")
        self.assertEqual(re.search(r"\d+", inbox_link.get_attribute("aria-label")).group(), count.inner_text())
        inbox_link.click()
        expect(page).to_have_url(re.compile(r"/inbox$"))
        expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
        cards = page.locator(".nyc")
        expect(cards).to_have_count(3)
        # Every item has its reason in words and says where it came from; replies, direct messages and assigned
        # work are notifications, not needs, and stay out of the queue (they reach you where they happen).
        for title, kind in [
            ("Decision to review", None),
            ("Kai Tanaka asked you in Garden sensors", "Question"),
            ("Kai Tanaka mentioned you in Garden sensors", None),
        ]:
            if kind:
                expect(page.locator(".nyc", has_text=title)).to_contain_text(kind)
        expect(page.locator(".nyc", has_text="Switch to capacitive probes")).to_contain_text("They do not corrode in wet soil")
        expect(cards.filter(has_text="soldering iron")).to_have_count(0)
        expect(cards.filter(has_text="replied in")).to_have_count(0)
        # Nothing was removed: the notifications are all still there for the API and for push and email links.
        self.assertEqual(len(self.api(page, "GET", "/api/v1/inbox?limit=100")["items"]), 6)
        page.mouse.move(900, 880)  # no hover tooltip in the capture
        shot(page, "notifications-desktop-1440-inbox")

    def test_02_open_the_exact_source_and_done_reads_it(self) -> None:
        page = self.page("ada")
        page.goto("/inbox")
        page.locator(".nyc", has_text="asked you in Garden sensors").get_by_role("button", name="Reply").click()
        expect(page).to_have_url(re.compile(re.escape(self.urls["question"]) + "$"))
        message = page.locator("#" + self.urls["question"].split("#", 1)[1])
        expect(message).to_be_visible()
        expect(message).to_contain_text("could you check the calibration table before Friday?")

        # A proposed decision opens in Details on its project, and nothing is read or decided by looking.
        page.get_by_role("navigation", name="Places").get_by_role("link", name=re.compile("^Inbox")).click()
        page.locator(".nyc", has_text="Switch to capacitive probes").get_by_role("button", name="Switch to capacitive probes").click()
        expect(page.locator("#details")).to_contain_text("Switch to capacitive probes")
        page.keyboard.press("Escape")
        self.assertEqual(self.api(page, "GET", "/api/v1/needs-you")["count"], 3)

        # Done leaves the queue and reads the notification; Undo (Z) brings both back. Nothing is deleted.
        mention = page.locator(".nyc", has_text="mentioned you")
        mention.hover()
        mention.get_by_role("button", name="Done").click()
        expect(mention).to_have_count(0)
        expect(page.get_by_role("status").filter(has_text="Marked done")).to_be_visible()
        read = lambda: next(item for item in self.api(page, "GET", "/api/v1/inbox?limit=100")["items"] if "mentioned you" in item["title"])["readAt"]  # noqa: E731
        for _ in range(40):
            if self.api(page, "GET", "/api/v1/needs-you")["count"] == 2 and read():
                break
            time.sleep(0.25)
        self.assertEqual(self.api(page, "GET", "/api/v1/needs-you")["count"], 2)
        self.assertTrue(read())
        page.keyboard.press("z")
        expect(page.locator(".nyc", has_text="mentioned you")).to_have_count(1)
        for _ in range(40):
            if not read():
                break
            time.sleep(0.25)
        self.assertIsNone(read())
        expect(page.get_by_role("navigation", name="Places").get_by_role("link", name="Inbox, 3 new")).to_be_visible()

    # ---------------------------------------------------------------- preferences

    def test_03_preferences_quiet_hours_and_a_muted_place(self) -> None:
        page = self.page("ada")
        page.goto("/inbox")
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Notification settings").click()
        expect(page).to_have_url(re.compile(r"/settings/notifications$"))
        expect(page.get_by_role("heading", level=1, name="Settings")).to_be_visible()
        expect(page.get_by_role("heading", level=2, name="Notifications")).to_be_visible()
        # S22: Only "Needs you" by default: push for what needs you, not for replies; Inbox keeps everything.
        levels = page.get_by_role("radiogroup", name="Notify me about")
        self.assertEqual([re.sub(r"\s+", " ", text).strip() for text in levels.locator(".sset-row__t").all_inner_texts()], ["Only “Needs you”", "Everything", "Nothing"])
        expect(levels.get_by_role("radio", name="Only “Needs you”")).to_be_checked()
        start = self.api(page, "GET", "/api/v1/notification-preferences")
        self.assertEqual(start["level"], "needsYou")
        self.assertFalse(start["channels"]["reply"]["push"])
        levels.get_by_text("Nothing", exact=True).click()
        prefs = self.settled(page, lambda stored: stored["level"] == "nothing")
        self.assertTrue(all(choice["inApp"] and not choice["push"] and not choice["email"] for choice in prefs["channels"].values()), "Nothing keeps only the inbox")
        expect(page.get_by_label("Mentions: Email")).not_to_be_checked()
        levels.get_by_text("Everything", exact=True).click()
        prefs = self.settled(page, lambda stored: stored["level"] == "everything")
        self.assertTrue(all(choice["push"] for choice in prefs["channels"].values()))
        self.assertTrue(prefs["channels"]["mention"]["email"], "email returns to its defaults after Nothing")
        levels.get_by_text("Only “Needs you”", exact=True).click()
        self.settled(page, lambda stored: stored["level"] == "needsYou")
        expect(levels.get_by_role("radio", name="Only “Needs you”")).to_be_checked()
        replies_email = page.get_by_label("Replies: Email")
        expect(replies_email).not_to_be_checked()
        replies_email.check()
        expect(page.get_by_role("status").filter(has_text="Saved")).to_be_visible()
        # This stack has no VAPID keys: the Push column says so and cannot be changed.
        expect(page.get_by_text("Push is not set up on this Flux server")).to_be_visible()
        expect(page.get_by_label("Direct messages: Push")).to_be_disabled()
        page.get_by_label("Reviews for you: Inbox").uncheck()
        expect(page.get_by_label("Reviews for you: Inbox")).not_to_be_checked()

        quiet = page.get_by_role("switch", name="Quiet hours")
        expect(quiet).to_have_attribute("aria-checked", "false")
        expect(page.get_by_label("From", exact=True)).to_have_count(0)
        quiet.click()
        expect(quiet).to_have_attribute("aria-checked", "true")
        page.get_by_label("From", exact=True).fill("21:30")
        page.get_by_label("Until", exact=True).fill("07:15")
        expect(page.get_by_label("Time zone")).to_have_value("Europe/Warsaw")

        page.get_by_label("Place to mute").select_option(label="# Tool library")
        page.get_by_role("button", name="Mute", exact=True).click()
        muted = page.locator(".nset__muted")
        expect(muted).to_contain_text("Tool library")

        prefs = self.settled(page, lambda prefs: prefs["quietHours"]["end"] == "07:15" and len(prefs["muted"]) == 1 and not prefs["channels"]["review"]["inApp"])
        self.assertTrue(prefs["channels"]["reply"]["email"])
        self.assertFalse(prefs["channels"]["review"]["inApp"])
        self.assertEqual(prefs["quietHours"], {"enabled": True, "start": "21:30", "end": "07:15", "timeZone": "Europe/Warsaw"})
        self.assertEqual([place["name"] for place in prefs["muted"]], ["Tool library"])
        self.assertEqual(prefs["email"]["destination"], "account")
        # Rapid edits of two fields both survive a reload.
        page.get_by_label("From", exact=True).fill("21:45")
        page.get_by_label("Until", exact=True).fill("06:30")
        self.settled(page, lambda stored: stored["quietHours"]["start"] == "21:45" and stored["quietHours"]["end"] == "06:30")
        page.reload()
        expect(page.get_by_label("From", exact=True)).to_have_value("21:45")
        expect(page.get_by_label("Until", exact=True)).to_have_value("06:30")
        page.get_by_label("From", exact=True).fill("21:30")
        page.get_by_label("Until", exact=True).fill("07:15")
        self.settled(page, lambda stored: stored["quietHours"]["start"] == "21:30" and stored["quietHours"]["end"] == "07:15")
        expect(page.get_by_text("21:30 – 7:15 · Europe/Warsaw")).to_be_visible()
        # The morning summary (S22): off by default, one push a day at a local time when on.
        summary = page.get_by_role("switch", name="Morning summary")
        expect(summary).to_have_attribute("aria-checked", "false")
        summary.click()
        page.get_by_label("At", exact=True).fill("08:30")
        prefs = self.settled(page, lambda stored: stored["morningSummary"] == {"enabled": True, "at": "08:30"})
        self.assertEqual(prefs["morningSummary"], {"enabled": True, "at": "08:30"})
        expect(page.get_by_text("One digest at 8:30 instead of single pings")).to_be_visible()
        page.reload()
        expect(page.get_by_role("switch", name="Morning summary")).to_have_attribute("aria-checked", "true")
        page.get_by_role("switch", name="Morning summary").click()
        self.settled(page, lambda stored: not stored["morningSummary"]["enabled"])
        expect(page.get_by_label("At", exact=True)).to_have_count(0)
        shot(page, "notifications-desktop-1440-settings")

        muted.get_by_role("button", name="Unmute").click()
        expect(page.locator(".nset__muted")).to_have_count(0)
        self.assertEqual(self.api(page, "GET", "/api/v1/notification-preferences")["muted"], [])

    def test_04_verify_an_extra_address_through_mailpit(self) -> None:
        page = self.page("ada")
        page.goto("/settings/notifications")
        extra_radio = page.get_by_role("radio", name=re.compile("^Extra address"))
        expect(extra_radio).to_be_disabled()
        page.get_by_label("Add an extra address").fill(EXTRA)
        page.get_by_role("button", name="Send link").click()
        expect(page.locator(".nset__addr")).to_contain_text(EXTRA)
        expect(page.locator(".nset__addr")).to_contain_text("Waiting for you to open the link")
        text = wait_for_mail(EXTRA, "/settings/notifications/verify?token=")
        self.assertIn("can never be used to sign in", text)
        link = re.search(r"https?://\S+/settings/notifications/verify\?token=\S+", text)
        assert link, text
        page.goto(link.group(0).replace(re.match(r"https?://[^/]+", link.group(0)).group(0), ""))
        expect(page.get_by_role("heading", name="Address confirmed")).to_be_visible()
        page.get_by_role("link", name="Notification settings").last.click()
        expect(page.locator(".nset__addr")).to_contain_text("Confirmed")
        expect(extra_radio).to_be_enabled()
        page.get_by_role("radio", name=re.compile("^Both")).check()
        expect(page.get_by_role("radio", name=re.compile("^Both"))).to_be_checked()
        prefs = self.settled(page, lambda prefs: prefs["email"]["destination"] == "both")
        self.assertEqual(prefs["email"]["destination"], "both")
        self.assertTrue(prefs["email"]["extra"]["verified"])
        shot(page, "notifications-desktop-1440-address")
        # The extra address is not a sign-in identity.
        sign_in = page.request.post("/api/auth/sign-in/email", data={"email": EXTRA, "password": PASSWORD}, headers={"origin": ORIGIN})
        self.assertNotEqual(sign_in.status, 200)

    # ---------------------------------------------------------------- phone

    def test_05_inbox_and_settings_on_the_phone(self) -> None:
        page = self.page("ada", phone=True)
        page.goto("/inbox")
        expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
        expect(page.get_by_role("button", name="Details")).to_have_count(0)
        cards = page.locator(".nyc")
        expect(cards).to_have_count(3)
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "no sideways scroll")
        first = cards.first.get_by_role("button", name=re.compile("^Accept"))
        self.assertGreaterEqual(box(page, first)["height"], 44)
        shot(page, "notifications-phone-390-inbox")
        # The capsule marks the Inbox; Settings are one tap on the avatar away (#341).
        capsule = page.get_by_role("navigation", name="Main places").get_by_role("link", name=re.compile("^Inbox"))
        expect(capsule).to_have_attribute("aria-current", "page")
        self.assertGreaterEqual(box(page, capsule)["height"], 44)
        page.get_by_role("link", name="Settings and account").tap()
        page.get_by_role("link", name=re.compile("^What reaches you")).tap()
        expect(page.get_by_role("heading", level=1, name="Notification settings")).to_be_visible()
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "settings fit the phone")
        for control in (page.get_by_role("radiogroup", name="Notify me about").get_by_role("radio").all()
                        + [page.get_by_role("switch", name="Quiet hours"), page.get_by_role("switch", name="Morning summary")]):
            assert_touch_target(self, page, control)
        assert_touch_target(self, page, page.get_by_label("Mentions: Email"))
        page.get_by_role("heading", level=2, name="Notifications").scroll_into_view_if_needed()
        shot(page, "notifications-phone-390-settings")
        page.locator(".nset__sec").nth(1).scroll_into_view_if_needed()
        check = page.get_by_label("Replies: Push")
        assert_touch_target(self, page, check)
        # The native input's associated label is the target. Shrinking that target fails
        # in either dimension even though the surrounding table row stays full height.
        for dimension in ("width", "height"):
            style = page.add_style_tag(content=f".nset__check {{ {dimension}: 43.99px !important; }}")
            with self.assertRaisesRegex(AssertionError, "44 × 44 px touch target"):
                assert_touch_target(self, page, check)
            style.evaluate("el => el.remove()")
        assert_touch_target(self, page, check)
        page.locator(".nset__sec").nth(1).scroll_into_view_if_needed()
        shot(page, "notifications-phone-390-email")

    def test_06_dark_inbox_and_unsubscribe_page(self) -> None:
        page = self.page("ada", dark=True)
        page.goto("/inbox")
        expect(page.locator(".nyc")).to_have_count(3)
        shot(page, "notifications-desktop-1440-inbox-dark")
        anonymous = self.browser.new_context(base_url=ORIGIN, viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        self.addCleanup(anonymous.close)
        other = anonymous.new_page()
        other.goto("/unsubscribe?token=not-a-real-token")
        expect(other.get_by_role("heading", name="Stop notification emails?")).to_be_visible()
        other.get_by_role("button", name="Stop these emails").tap()
        expect(other.get_by_role("heading", name="This link has expired")).to_be_visible()
        expect(other.get_by_role("link", name="Notification settings")).to_be_visible()
        shot(other, "notifications-phone-390-unsubscribe")


if __name__ == "__main__":
    unittest.main()
