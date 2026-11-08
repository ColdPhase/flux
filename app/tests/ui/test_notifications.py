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

from app_select import choose, expect_value

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
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
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
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who], "service_workers": "block"}
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
        # The Inbox opens one item at a time (#763): the selected card carries Done; a click on a card's free space selects it.
        mention.locator(".nyc__card > :first-child").click()  # its face: free space, not a link or button
        expect(mention).to_have_attribute("aria-current", "true")
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

    def test_03_level_email_me_too_quiet_hours_and_a_muted_place(self) -> None:
        page = self.page("ada")
        page.goto("/inbox")
        expect(page.get_by_role("navigation", name="Places").get_by_role("link", name="Notification settings")).to_have_count(0)  # #437 item 9
        page.goto("/settings/notifications")
        expect(page).to_have_url(re.compile(r"/settings/notifications$"))
        expect(page.get_by_role("heading", level=1, name="Settings")).to_be_visible()
        expect(page.get_by_role("heading", level=2, name="Notifications")).to_be_visible()
        expect(page.get_by_text("The Inbox always shows everything that waits for you.")).to_be_visible()
        # Three choices, Only what needs me by default: push and email for what needs you, not for replies; the Inbox keeps everything.
        levels = page.get_by_role("radiogroup", name="Tell me about")
        self.assertEqual([re.sub(r"\s+", " ", text).strip() for text in levels.locator(".sset-row__t").all_inner_texts()], ["Only what needs me", "Everything", "Nothing"])
        expect(levels.get_by_role("radio", name="Only what needs me")).to_be_checked()
        start = self.api(page, "GET", "/api/v1/notification-preferences")
        self.assertEqual((start["level"], start["emailMe"]), ("needsYou", True))
        self.assertNotIn("channels", start, "there is no per-kind matrix to store or show")
        expect(page.get_by_role("table")).to_have_count(0)
        levels.get_by_text("Nothing", exact=True).click()
        self.settled(page, lambda stored: stored["level"] == "nothing")
        expect(levels.get_by_role("radio", name="Nothing")).to_be_checked()
        levels.get_by_text("Everything", exact=True).click()
        self.settled(page, lambda stored: stored["level"] == "everything")
        levels.get_by_text("Only what needs me", exact=True).click()
        self.settled(page, lambda stored: stored["level"] == "needsYou")
        expect(levels.get_by_role("radio", name="Only what needs me")).to_be_checked()

        # Where it reaches you: Email me too, covering the same events by email to every confirmed address.
        email_me = page.get_by_role("switch", name="Email me too")
        expect(email_me).to_have_attribute("aria-checked", "true")
        expect(page.get_by_text("To 1 address")).to_be_visible()
        email_me.click()
        expect(email_me).to_have_attribute("aria-checked", "false")
        self.settled(page, lambda stored: stored["emailMe"] is False)
        expect(page.get_by_role("status").filter(has_text="Saved")).to_be_visible()
        email_me.click()
        self.settled(page, lambda stored: stored["emailMe"] is True)
        # This stack has no VAPID keys: one line says so and there is no row for this device (#763 SG-3).
        expect(page.get_by_text("Push isn’t set up on this Flux server. Your inbox always works.")).to_be_visible()
        expect(page.get_by_text("On this device")).to_have_count(0)

        # Quiet hours are one row; Change opens the switch, the window and its zone.
        quiet_row = page.locator(".sset-row").filter(has=page.get_by_text("Quiet hours", exact=True))
        expect(quiet_row).to_contain_text("Off")
        expect(page.get_by_label("From", exact=True)).to_have_count(0)
        page.get_by_role("button", name="Change quiet hours").click()
        quiet = page.get_by_role("switch", name="Use quiet hours")
        expect(quiet).to_have_attribute("aria-checked", "false")
        quiet.click()
        expect(quiet).to_have_attribute("aria-checked", "true")
        page.get_by_label("From", exact=True).fill("21:30")
        page.get_by_label("Until", exact=True).fill("07:15")
        expect_value(page.get_by_label("Time zone"), "Europe/Warsaw")
        expect(quiet_row).to_contain_text("21:30–7:15 · no email or push then; the Inbox keeps everything")

        # Muted places are behind a link row.
        muted_row = page.locator(".sset-row").filter(has=page.get_by_text("Muted places", exact=True))
        expect(muted_row).to_contain_text("None")
        expect(page.get_by_label("Place to mute")).to_have_count(0)
        page.get_by_role("button", name="Change muted places").click()
        choose(page.get_by_label("Place to mute"), label="# Tool library")
        page.get_by_role("button", name="Mute", exact=True).click()
        muted = page.locator(".nset__muted")
        expect(muted).to_contain_text("Tool library")
        expect(muted_row).to_contain_text("Tool library")

        prefs = self.settled(page, lambda prefs: prefs["quietHours"]["end"] == "07:15" and len(prefs["muted"]) == 1)
        self.assertEqual(prefs["quietHours"], {"enabled": True, "start": "21:30", "end": "07:15", "timeZone": "Europe/Warsaw"})
        self.assertEqual([place["name"] for place in prefs["muted"]], ["Tool library"])
        self.assertEqual((prefs["level"], prefs["emailMe"]), ("needsYou", True))
        # Rapid edits of two fields both survive a reload.
        page.get_by_label("From", exact=True).fill("21:45")
        page.get_by_label("Until", exact=True).fill("06:30")
        self.settled(page, lambda stored: stored["quietHours"]["start"] == "21:45" and stored["quietHours"]["end"] == "06:30")
        page.reload()
        page.get_by_role("button", name="Change quiet hours").click()
        expect(page.get_by_label("From", exact=True)).to_have_value("21:45")
        expect(page.get_by_label("Until", exact=True)).to_have_value("06:30")
        page.get_by_label("From", exact=True).fill("21:30")
        page.get_by_label("Until", exact=True).fill("07:15")
        self.settled(page, lambda stored: stored["quietHours"]["start"] == "21:30" and stored["quietHours"]["end"] == "07:15")
        expect(page.get_by_text("21:30–7:15 · no email or push then")).to_be_visible()
        shot(page, "notifications-desktop-1440-settings")

        page.get_by_role("button", name="Change muted places").click()
        page.locator(".nset__muted").get_by_role("button", name="Unmute").click()
        expect(page.locator(".nset__muted")).to_have_count(0)
        self.assertEqual(self.api(page, "GET", "/api/v1/notification-preferences")["muted"], [])

    def test_04_verify_an_extra_address_through_mailpit(self) -> None:
        page = self.page("ada")
        page.goto("/settings/notifications")
        # The sign-in address comes first; a new address gets a confirmation link before any notification goes there.
        expect(page.get_by_text("Your sign-in address")).to_be_visible()
        expect(page.get_by_text("We send a confirmation link to a new address before any notification goes there.")).to_be_visible()
        page.get_by_label("Add another address").fill(EXTRA)
        page.get_by_role("button", name="Add", exact=True).click()
        expect(page.locator(".nset__extra")).to_contain_text(EXTRA)
        expect(page.locator(".nset__extra")).to_contain_text("Waiting for you to open the link")
        expect(page.get_by_role("button", name="Send again")).to_be_visible()
        expect(page.get_by_text("To 1 address")).to_be_visible()
        text = wait_for_mail(EXTRA, "/settings/notifications/verify?token=")
        self.assertIn("can never be used to sign in", text)
        link = re.search(r"https?://\S+/settings/notifications/verify\?token=\S+", text)
        assert link, text
        page.goto(link.group(0).replace(re.match(r"https?://[^/]+", link.group(0)).group(0), ""))
        expect(page.get_by_role("heading", name="Address confirmed")).to_be_visible()
        page.get_by_role("link", name="Notification settings").last.click()
        expect(page.locator(".nset__extra")).to_contain_text("Confirmed")
        expect(page.get_by_text("To 2 addresses")).to_be_visible()
        prefs = self.api(page, "GET", "/api/v1/notification-preferences")
        self.assertTrue(prefs["email"]["extra"]["verified"])
        self.assertTrue(prefs["emailMe"])
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
        assert_touch_target(self, page, first)
        shot(page, "notifications-phone-390-inbox")
        # The capsule marks the Inbox; Settings are one tap on the avatar away (#341).
        capsule = page.get_by_role("navigation", name="Main places").get_by_role("link", name=re.compile("^Inbox"))
        expect(capsule).to_have_attribute("aria-current", "page")
        assert_touch_target(self, page, capsule)
        page.get_by_role("link", name="Settings and account").tap()
        page.get_by_role("link", name=re.compile("^Notifications")).tap()
        expect(page.get_by_role("heading", level=2, name="Notifications")).to_be_visible()
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "settings fit the phone")
        for control in (page.get_by_role("radiogroup", name="Tell me about").get_by_role("radio").all()
                        + [page.get_by_role("switch", name="Email me too"), page.get_by_role("button", name="Change quiet hours"),
                           page.get_by_role("button", name="Change muted places"), page.get_by_role("button", name="Remove")]):
            assert_touch_target(self, page, control)
        page.get_by_role("heading", level=2, name="Notifications").scroll_into_view_if_needed()
        shot(page, "notifications-phone-390-settings")
        page.get_by_role("button", name="Change quiet hours").tap()
        for control in (page.get_by_role("switch", name="Use quiet hours"), page.get_by_label("From", exact=True)):
            assert_touch_target(self, page, control)
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "the opened quiet hours fit the phone")
        shot(page, "notifications-phone-390-quiet-hours")

    def test_06_dark_inbox_and_unsubscribe_page(self) -> None:
        page = self.page("ada", dark=True)
        page.goto("/inbox")
        expect(page.locator(".nyc")).to_have_count(3)
        shot(page, "notifications-desktop-1440-inbox-dark")
        anonymous = self.browser.new_context(base_url=ORIGIN, viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True, service_workers="block")
        self.addCleanup(anonymous.close)
        other = anonymous.new_page()
        other.goto("/unsubscribe?token=not-a-real-token")
        expect(other.get_by_role("heading", name="Stop notification emails?")).to_be_visible()
        other.get_by_role("button", name="Stop these emails").tap()
        expect(other.get_by_role("heading", name="This link has expired")).to_be_visible()
        expect(other.get_by_role("link", name="Notification settings")).to_be_visible()
        shot(other, "notifications-phone-390-unsubscribe")


    # ---------------------------------------------------------------- failures and queued saves (Kai has no extra address)

    def mail_count(self, address: str) -> int:
        query = urllib.parse.quote(f'to:"{address}"')
        with urllib.request.urlopen(f"{MAILPIT}/api/v1/search?query={query}") as response:
            return len(json.load(response).get("messages", []))

    def test_07_a_failed_add_keeps_the_error_and_the_typed_address_and_sends_no_mail(self) -> None:
        page = self.page("kai")
        page.goto("/settings/notifications")
        address = f"kai-failed-{uuid.uuid4().hex}@example.test"
        page.route("**/api/v1/notification-address", lambda route: route.fulfill(status=500, content_type="application/json", body="{}") if route.request.method == "POST" else route.continue_())
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))
        field = page.get_by_label("Add another address")
        field.fill(address)
        page.get_by_role("button", name="Add", exact=True).click()
        expect(page.get_by_role("alert")).to_have_text("Could not send the link. Try again.")
        expect(field).to_have_value(address)
        expect(page.locator(".nset__saved")).to_have_text("")
        self.assertIsNone(self.api(page, "GET", "/api/v1/notification-preferences")["email"]["extra"])
        self.assertEqual(self.mail_count(address), 0)

    def test_08_a_first_load_error_offers_retry_and_retry_saves_nothing(self) -> None:
        page = self.page("kai")
        phase = {"fail": True}
        patches: list = []

        def handler(route) -> None:
            if route.request.method == "GET" and phase["fail"]:
                route.fulfill(status=500, content_type="application/json", body="{}")
                return
            if route.request.method == "PATCH":
                patches.append(route.request.post_data_json)
            route.continue_()

        page.route("**/api/v1/notification-preferences", handler)
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))
        page.goto("/settings/notifications")
        expect(page.get_by_role("heading", name="Notification settings could not load", exact=True)).to_be_visible()
        phase["fail"] = False
        page.get_by_role("button", name="Retry", exact=True).click()
        expect(page.get_by_role("radiogroup", name="Tell me about")).to_be_visible()
        expect(page.get_by_role("heading", name="Notification settings could not load", exact=True)).to_have_count(0)
        self.assertEqual(patches, [])

    def test_09_the_expired_link_button_keeps_44_px_and_readable_contrast(self) -> None:
        def luminance(color: str) -> float:
            rgb = [float(x) / 255 for x in re.findall(r"[\d.]+", color)[:3]]
            linear = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in rgb]
            return sum(v * w for v, w in zip(linear, [0.2126, 0.7152, 0.0722]))

        for phone in (False, True):
            for theme in ("light", "dark"):
                with self.subTest(phone=phone, theme=theme):
                    context = self.browser.new_context(base_url=ORIGIN, viewport=PHONE if phone else DESKTOP, device_scale_factor=3 if phone else 1,
                                                       is_mobile=phone, has_touch=phone, color_scheme=theme, service_workers="block")
                    self.addCleanup(context.close)
                    page = context.new_page()
                    page.goto("/unsubscribe?token=not-a-real-token")
                    with page.expect_response(lambda response: urllib.parse.urlsplit(response.url).path == "/api/v1/notifications/unsubscribe") as request:
                        page.get_by_role("button", name="Stop these emails", exact=True).click()
                    self.assertEqual(request.value.status, 404, "the invalid-token guard refuses before changing anything")
                    expect(page.get_by_role("heading", name="This link has expired", exact=True)).to_be_visible()
                    link = page.get_by_role("link", name="Notification settings", exact=True)
                    expect(link).to_be_visible()
                    # The link turns from secondary to primary as the answer arrives: measure once its colours have settled.
                    link.evaluate("el => Promise.all(el.getAnimations().map((animation) => animation.finished))")
                    colors = link.evaluate("""element => {
                      const style = getComputedStyle(element), box = element.getBoundingClientRect();
                      const probe = document.createElement('span'); probe.style.color = 'var(--oninv)'; element.append(probe);
                      const inverted = getComputedStyle(probe).color; probe.remove();
                      return { color: style.color, inverted, background: style.backgroundColor, gradient: style.backgroundImage,
                               height: box.height, top: box.top, bottom: box.bottom, viewport: innerHeight };
                    }""")
                    self.assertGreaterEqual(colors["height"], 44)
                    self.assertGreaterEqual(colors["top"], 0)
                    self.assertLessEqual(colors["bottom"], colors["viewport"])
                    self.assertEqual(colors["color"], colors["inverted"], "the primary recovery action uses the fixed readable on-inverted foreground")
                    backgrounds = re.findall(r"rgba?\([^)]+\)", colors["gradient"]) or [colors["background"]]
                    foreground = luminance(colors["color"])
                    ratio = min((max(foreground, luminance(bg)) + 0.05) / (min(foreground, luminance(bg)) + 0.05) for bg in backgrounds)
                    self.assertGreaterEqual(ratio, 4.5)
                    page.close()

    def test_10_queued_saves_acknowledge_only_the_newest_and_a_failed_read_offers_refresh(self) -> None:
        page = self.page("kai")
        page.goto("/settings/notifications")
        levels = page.get_by_role("radiogroup", name="Tell me about")
        held: dict = {}
        patches: list = []

        def handler(route) -> None:
            if route.request.method != "PATCH":
                route.continue_()
                return
            patches.append(route.request.post_data_json)
            if "route" not in held:
                held.update(route=route, response=route.fetch())
            else:
                route.continue_()

        page.route("**/api/v1/notification-preferences", handler)
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))
        levels.get_by_text("Everything", exact=True).click()
        for _ in range(80):
            if "route" in held:
                break
            page.wait_for_timeout(50)
        self.assertIn("route", held, "the first save reached the server")
        levels.get_by_text("Nothing", exact=True).click()
        levels.get_by_text("Only what needs me", exact=True).click()
        page.wait_for_timeout(150)
        self.assertEqual(patches, [{"level": "everything"}], "the later saves wait behind the first")
        held["route"].fulfill(response=held["response"])
        stored = self.settled(page, lambda prefs: len(patches) == 3 and prefs["level"] == "needsYou")
        self.assertEqual(stored["level"], "needsYou")
        self.assertEqual(patches, [{"level": "everything"}, {"level": "nothing"}, {"level": "needsYou"}])
        expect(levels.get_by_role("radio", name="Only what needs me")).to_be_checked()
        expect(page.get_by_role("status").filter(has_text="Saved")).to_be_visible()

        # A save that fails and a read that fails after it: the page says the shown settings are the last confirmed ones.
        phase = {"fail": False}
        page.unroute_all(behavior="ignoreErrors")
        mutated: list = []

        def failing(route) -> None:
            if route.request.method == "PATCH":
                mutated.append(route.request.post_data_json)
                route.fulfill(status=500, content_type="application/json", body="{}")
            elif phase["fail"]:
                route.fulfill(status=500, content_type="application/json", body="{}")
            else:
                route.continue_()

        page.route("**/api/v1/notification-preferences", failing)
        phase["fail"] = True
        levels.get_by_text("Nothing", exact=True).click()
        note = page.get_by_role("note").filter(has_text="Current notification settings could not be refreshed")
        expect(note).to_be_visible()
        phase["fail"] = False
        note.get_by_role("button", name="Retry current settings").click()
        expect(note).to_have_count(0)
        expect(levels.get_by_role("radio", name="Only what needs me")).to_be_checked()
        self.assertEqual(mutated, [{"level": "nothing"}], "refreshing sends no second save")

    def test_11_a_failed_mute_keeps_the_choice_and_does_not_resend(self) -> None:
        page = self.page("kai")
        page.goto("/settings/notifications")
        puts: list = []

        def handler(route) -> None:
            if route.request.method == "PUT":
                puts.append(route.request.post_data_json)
                route.fulfill(status=500, content_type="application/json", body="{}")
            else:
                route.continue_()

        page.route("**/api/v1/notification-preferences/mutes", handler)
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))
        page.get_by_role("button", name="Change muted places").click()
        choose(page.get_by_label("Place to mute"), label="# Tool library")
        page.get_by_role("button", name="Mute", exact=True).click()
        expect(page.get_by_text("Could not save. Try again.")).to_be_visible()
        expect(page.get_by_label("Place to mute").first).to_contain_text("Tool library")
        expect(page.locator(".nset__mute-pending")).to_have_count(0)
        page.wait_for_timeout(300)
        self.assertEqual(len(puts), 1, "a failed mute is not sent again by itself")
        self.assertEqual(self.api(page, "GET", "/api/v1/notification-preferences")["muted"], [])


if __name__ == "__main__":
    unittest.main()
