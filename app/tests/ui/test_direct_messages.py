"""Browser tests for direct messages (issue #107, AC-5/AC-6).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose
application. Three people share a workspace: Ada (owner), Kai and Lee (members). Ada starts a
1:1 DM with Kai from the sidebar, Kai replies from a second browser and Ada sees it arrive live,
a lost response is retried without a duplicate, Lee (outside the DM) cannot open it, the phone
layout keeps the audience and composer in view, and leaving a group removes it. Every step is
checked against the API as well. Screenshots (dm-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, box, shot, start_forwarder

PASSWORD = "messages between friends"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.k+{STAMP}@example.test"),
    "kai": ("Kai Tanaka", f"kai.t+{STAMP}@example.test"),
    "lee": ("Lee Moreno", f"lee.m+{STAMP}@example.test"),
}


class DirectMessageJourney(unittest.TestCase):
    """Tests run in name order and share the accounts, the workspace and the DM."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    project_id = ""
    dm_path = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        # Accounts and the shared workspace come from the public API, as a person's browser would.
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            me = context.request.get("/api/v1/me").json()
            cls.ids[key] = me["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        ada = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states["ada"])
        post = lambda path, body: ada.request.post(path, data=body, headers={"origin": ORIGIN})  # noqa: E731
        workspace = post("/api/v1/workspaces", {"name": "Riverside Makers"})
        assert workspace.status == 201, workspace.text()
        cls.workspace_id = workspace.json()["id"]
        for key in ("kai", "lee"):
            added = post(f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE[key][1], "role": "member"})
            assert added.status == 201, added.text()
        project = post(f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Garden sensors", "visibility": "workspace"})
        assert project.status == 201, project.text()
        cls.project_id = project.json()["id"]
        ada.close()

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
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, path: str) -> tuple[int, dict]:
        response = page.request.get(path)
        return response.status, (json.loads(response.text()) if response.text() else {})

    def dm_id(self) -> str:
        return self.dm_path.rsplit("/", 1)[-1]

    def composer(self, page: Page):
        return page.get_by_label(re.compile(r"^Message "))

    def send(self, page: Page, text: str, touch: bool = False) -> None:
        self.composer(page).fill(text)
        if touch:
            # On a touch device Enter adds a line and the button sends (#189).
            self.composer(page).press("Enter")
            expect(self.composer(page)).to_have_value(f"{text}\n")
            self.composer(page).fill(text)
            page.get_by_role("button", name="Send message").tap()
        else:
            self.composer(page).press("Enter")
        expect(page.locator(".dm-msg__body", has_text=text)).to_be_visible()
        expect(self.composer(page)).to_have_value("")
        # Sending is instant (#264): the message shows at once and is stored a moment later.
        expect(page.locator("[data-client-message-id]")).to_have_count(0)

    # ---------------------------------------------------------------- start and reply

    def test_01_start_a_dm_from_the_sidebar(self) -> None:
        page = self.page("ada")
        page.goto("/")
        page.locator("#side-dms").get_by_role("link", name="Messages", exact=True).click()
        expect(page.get_by_role("heading", name="No direct messages yet")).to_be_visible()
        expect(page.get_by_text("not workspace owners or admins")).to_be_visible()
        page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="New", exact=True).click()
        page.get_by_role("menu", name="New").get_by_role("menuitem", name="Message", exact=True).click()
        expect(page.get_by_role("heading", level=1, name="New message")).to_be_visible()
        people = page.get_by_role("list", name="People")
        expect(people.get_by_text("Kai Tanaka")).to_be_visible()
        expect(people.get_by_text("Lee Moreno")).to_be_visible()
        expect(people.get_by_text("Ada Kowalska")).to_have_count(0)
        page.get_by_placeholder("Find people by name or email").fill("kai")
        expect(people.get_by_text("Lee Moreno")).to_have_count(0)
        people.get_by_text("Kai Tanaka").click()
        expect(page.get_by_text("Only you and Kai", exact=True)).to_be_visible()
        shot(page, "dm-desktop-1440-new-message")
        page.get_by_role("button", name="Message Kai").click()
        expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
        type(self).dm_path = page.url.replace(ORIGIN, "")

        # The header and the composer name the exact audience.
        expect(page.get_by_role("heading", level=1, name="Kai Tanaka")).to_be_visible()
        expect(page.locator(".top__topic")).to_have_text("Only you and Kai")
        expect(page.locator(".composer__audience")).to_contain_text("Only you and Kai")
        self.send(page, "Morning! I sketched the gesture lamp idea on the train. Wave to dim, hold to switch off?")
        self.send(page, "Camera or a distance sensor? I’d rather not point a camera at people’s desks.")
        sidebar = page.get_by_role("navigation", name="Messages")
        expect(sidebar.get_by_role("link", name=re.compile("Kai Tanaka"))).to_have_attribute("aria-current", "page")

        status, dm = self.api(page, f"/api/v1/dms/{self.dm_id()}")
        self.assertEqual(status, 200)
        self.assertEqual(dm["kind"], "pair")
        self.assertEqual(sorted(dm["audience"]["participantIds"]), sorted([self.ids["ada"], self.ids["kai"]]))
        self.assertEqual([m["sequence"] for m in dm["messages"]], [1, 2])

    def test_02_reply_from_a_second_browser_arrives_live(self) -> None:
        ada = self.page("ada")
        ada.goto(self.dm_path)
        expect(ada.locator(".dm-msg__body")).to_have_count(2)
        kai = self.page("kai")
        kai.goto("/")
        kai.locator("#side-dms").get_by_role("link", name="Messages", exact=True).click()
        kai.get_by_role("navigation", name="Messages").get_by_role("link", name=re.compile("Ada Kowalska")).click()
        expect(kai).to_have_url(f"{ORIGIN}{self.dm_path}")
        expect(kai.locator(".composer__audience")).to_contain_text("Only you and Ada")
        expect(kai.get_by_text("Wave to dim, hold to switch off?")).to_be_visible()
        self.send(kai, "Distance sensor. A VL53L1X sees a hand at 30 cm and nobody’s face.")
        # Ada's open conversation receives it through the authorized stream, without a reload.
        expect(ada.get_by_text("A VL53L1X sees a hand at 30 cm")).to_be_visible(timeout=15000)
        self.send(ada, "Perfect. Let’s keep it between us until we know it works in low light.")
        expect(kai.get_by_text("keep it between us")).to_be_visible(timeout=15000)
        # Ada's own message sits on the right, Kai's on the left (#136 AC-1).
        own = ada.locator(".dm-msg.is-mine .dm-msg__body", has_text="keep it between us").bounding_box()
        other = ada.locator(".dm-msg:not(.is-mine) .dm-msg__body", has_text="A VL53L1X").bounding_box()
        feed = ada.locator(".dm__in").bounding_box()
        assert own and other and feed
        self.assertGreater(own["x"] + own["width"], feed["x"] + feed["width"] / 2)
        self.assertLess(other["x"], feed["x"] + feed["width"] / 2)
        self.assertGreater(own["x"] + own["width"], other["x"] + other["width"])
        shot(ada, "dm-desktop-1440-conversation")

        # Opening the DM again from Kai's side (e.g. from Ada's name) reaches the same one.
        kai.goto(f"/dm/new?workspace={self.workspace_id}&with={self.ids['ada']}")
        expect(kai).to_have_url(f"{ORIGIN}{self.dm_path}")

    def test_03_a_lost_response_is_retried_once(self) -> None:
        page = self.page("kai")
        page.goto(self.dm_path)
        expect(page.locator(".dm-msg__body")).to_have_count(4)
        state = {"lost": False}

        def lose_first_response(route):
            if route.request.method == "POST" and not state["lost"]:
                state["lost"] = True
                route.fetch()  # the server commits the message ...
                route.abort("failed")  # ... but the browser never hears back
                return
            route.continue_()

        page.route(re.compile(r".*/api/v1/dms/[0-9a-f-]+/messages$"), lose_first_response)
        sent: list[str] = []
        page.on("request", lambda request: sent.append(request.post_data_json["clientMessageId"]) if request.method == "POST" and request.url.endswith("/messages") else None)
        self.composer(page).fill("I’ll order two sensors today.")
        self.composer(page).press("Enter")
        # Sending is instant (#264): with no answer the message waits on the page with its id (or, once the
        # live refresh brings the stored copy, that copy shows instead), and it is sent again when Flux answers.
        expect(self.composer(page)).to_have_value("")
        expect(page.locator(".dm-msg__body", has_text="I’ll order two sensors today.")).to_have_count(1)
        # The queue (in this tab's session storage) empties only after the resend confirms the stored message.
        key = f"flux:composer:{self.ids['kai']}:dm:dm:{self.dm_id()}"
        page.wait_for_function("key => !JSON.parse(sessionStorage.getItem(key) ?? '{}').pending", arg=key, timeout=20000)
        expect(page.locator("[data-client-message-id]")).to_have_count(0)
        expect(page.locator(".dm-msg__body", has_text="I’ll order two sensors today.")).to_have_count(1)
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[0], sent[1], "the resend reuses the first attempt's client message id")
        expect(self.composer(page)).to_have_value("")
        status, dm = self.api(page, f"/api/v1/dms/{self.dm_id()}")
        self.assertEqual(status, 200)
        self.assertEqual([m["body"] for m in dm["messages"]].count("I’ll order two sensors today."), 1, "the retry did not duplicate")
        page.reload()
        expect(page.locator(".dm-msg__body", has_text="I’ll order two sensors today.")).to_have_count(1)

    def test_04_people_outside_the_dm_cannot_open_it(self) -> None:
        page = self.page("lee")
        page.goto(self.dm_path)
        expect(page.get_by_role("heading", name="This conversation isn’t available")).to_be_visible()
        self.assertEqual(page.locator(".dm-msg__body").count(), 0)
        expect(page.get_by_text("VL53L1X")).to_have_count(0)
        status, _ = self.api(page, f"/api/v1/dms/{self.dm_id()}")
        self.assertEqual(status, 404)
        page.goto("/dm")
        expect(page.get_by_role("heading", name="No direct messages yet")).to_be_visible()

    # ---------------------------------------------------------------- phone and groups

    def test_05_phone_reads_and_replies_with_the_audience_in_view(self) -> None:
        page = self.page("kai", phone=True)
        page.goto("/")
        page.get_by_role("button", name="Open navigation").click()
        page.get_by_role("dialog").locator("#side-dms").get_by_role("link", name="Messages", exact=True).click()
        expect(page).to_have_url(f"{ORIGIN}/dm")
        expect(page.get_by_role("list", name="Conversations").get_by_role("link", name=re.compile("Ada Kowalska"))).to_be_visible()
        shot(page, "dm-phone-390-index")
        page.get_by_role("button", name="Open navigation").click()
        drawer = page.get_by_role("dialog")
        expect(drawer.get_by_role("link", name=re.compile("Ada Kowalska"))).to_be_visible()
        shot(page, "dm-phone-390-drawer")
        drawer.get_by_role("link", name=re.compile("Ada Kowalska")).click()
        expect(page).to_have_url(f"{ORIGIN}{self.dm_path}")
        expect(page.get_by_role("heading", level=1, name="Ada Kowalska")).to_be_visible()
        expect(page.locator(".composer__audience")).to_contain_text("Only you and Ada")
        send = page.get_by_role("button", name="Send message")
        size = box(page, send)
        self.assertGreaterEqual(size["width"], 44)
        self.assertGreaterEqual(size["height"], 44)
        composer = box(page, self.composer(page))
        self.assertLessEqual(composer["y"] + composer["height"], PHONE["height"], "composer stays on screen")
        width = page.evaluate("document.documentElement.scrollWidth")
        self.assertLessEqual(width, PHONE["width"], "no horizontal scrolling")
        self.send(page, "Sent from my phone: the sensor fits in the lamp base.", touch=True)
        shot(page, "dm-phone-390-conversation")

    def test_06_group_dm_and_leaving(self) -> None:
        ada = self.page("ada")
        ada.goto("/dm/new")
        people = ada.get_by_role("list", name="People")
        people.get_by_text("Kai Tanaka").click()
        people.get_by_text("Lee Moreno").click()
        ada.get_by_label("Group name (optional)").fill("Lamp prototype")
        expect(ada.get_by_text("Only you, Kai and Lee", exact=True)).to_be_visible()
        ada.get_by_role("button", name="Start group").click()
        expect(ada.get_by_role("heading", level=1, name="Lamp prototype")).to_be_visible()
        expect(ada.locator(".top__topic")).to_have_text("Only you, Kai and Lee")
        self.send(ada, "Group for the lamp: Lee, could you print a test housing this week?")
        group_path = ada.url.replace(ORIGIN, "")

        lee = self.page("lee")
        lee.goto(group_path)
        expect(lee.get_by_text("print a test housing")).to_be_visible()
        self.send(lee, "Yes, PETG in white. Thursday?")
        expect(ada.get_by_text("PETG in white")).to_be_visible(timeout=15000)
        ada.get_by_role("button", name="Details", exact=True).click()
        expect(ada.get_by_role("heading", name="People in this conversation")).to_be_visible()
        shot(ada, "dm-desktop-1440-group-details")
        ada.keyboard.press("Escape")

        lee.get_by_role("button", name="Details", exact=True).click()
        lee.get_by_role("button", name="Leave conversation").click()
        expect(lee.get_by_text("You won’t see these messages again")).to_be_visible()
        lee.get_by_role("group", name="Leave this conversation").get_by_role("button", name="Leave", exact=True).click()
        expect(lee).to_have_url(f"{ORIGIN}/dm")
        expect(lee.get_by_role("navigation", name="Messages").get_by_role("link", name=re.compile("Lamp prototype"))).to_have_count(0)
        lee.goto(group_path)
        expect(lee.get_by_role("heading", name="This conversation isn’t available")).to_be_visible()
        expect(lee.get_by_text("print a test housing")).to_have_count(0)
        status, _ = self.api(lee, f"/api/v1/dms/{group_path.rsplit('/', 1)[-1]}")
        self.assertEqual(status, 404)

        # The others keep the conversation, with the audience now only Ada and Kai.
        ada.reload()
        expect(ada.locator(".top__topic")).to_have_text("Only you and Kai")
        expect(ada.get_by_text("PETG in white")).to_be_visible()

    def test_07_dark_and_index(self) -> None:
        page = self.page("ada", dark=True)
        page.goto(self.dm_path)
        expect(page.get_by_text("keep it between us")).to_be_visible()
        shot(page, "dm-desktop-1440-dark")
        light = self.page("ada")
        light.goto("/dm")
        expect(light.get_by_role("list", name="Conversations").get_by_role("link")).to_have_count(2)
        shot(light, "dm-desktop-1440-index")

    def test_08_messaging_someone_who_left_explains_instead_of_opening_a_thread(self) -> None:
        post = lambda page, path, body: page.request.post(path, data=body, headers={"origin": ORIGIN})  # noqa: E731
        lee = self.page("lee")
        lee.goto("/")
        said = post(lee, f"/api/v1/projects/{self.project_id}/conversations", {"body": "Housing printed; it fits the sensor.", "clientMessageId": str(uuid.uuid4())})
        self.assertEqual(said.status, 201, said.text())
        ada = self.page("ada")
        ada.goto("/")
        opened = post(ada, f"/api/v1/workspaces/{self.workspace_id}/dms", {"participantIds": [self.ids["lee"]]})
        self.assertIn(opened.status, (200, 201), opened.text())
        pair_id = opened.json()["id"]
        self.assertEqual(post(ada, f"/api/v1/dms/{pair_id}/messages", {"body": "Thanks for the housing!", "clientMessageId": str(uuid.uuid4())}).status, 201)
        self.assertEqual(post(lee, f"/api/v1/dms/{pair_id}/leave", {}).status, 204)

        # Ada clicks Lee's name in the project conversation: a calm notice, no thread for "Only you".
        # Scoped to the conversation: the sidebar's Messages list also links "Lee Moreno" (the 1:1).
        ada.goto(f"/projects/{self.project_id}")
        ada.get_by_role("region", name="Messages").get_by_role("link", name="Lee Moreno").first.click()
        notice = ada.get_by_role("status").filter(has_text="Lee left this conversation. They can reopen it by messaging you.")
        expect(notice).to_be_visible()
        expect(ada.get_by_label(re.compile(r"^Message "))).to_have_count(0)
        self.assertNotIn(pair_id, ada.url)

        # The existing 1:1 stays readable for Ada, with a quiet notice and sending disabled.
        ada.goto(f"/dm/{pair_id}")
        expect(ada.get_by_text("Thanks for the housing!")).to_be_visible()
        expect(ada.locator(".dm__notice")).to_have_text("Lee left this conversation. They can reopen it by messaging you.")
        expect(self.composer(ada)).to_be_disabled()
        expect(ada.get_by_role("button", name="Send message")).to_have_attribute("aria-disabled", "true")
        status, dm = self.api(ada, f"/api/v1/dms/{pair_id}")
        self.assertEqual(dm["audience"]["participantIds"], [self.ids["ada"]])
        shot(ada, "dm-desktop-1440-recipient-left")

        # Lee reopens it himself: both take part again and Ada can send.
        reopened = post(lee, f"/api/v1/workspaces/{self.workspace_id}/dms", {"participantIds": [self.ids["ada"]]})
        self.assertEqual(reopened.status, 200, reopened.text())
        ada.reload()
        expect(ada.locator(".dm__notice")).to_have_count(0)
        self.send(ada, "Welcome back, Lee.")
        lee.goto(f"/dm/{pair_id}")
        expect(lee.get_by_text("Welcome back, Lee.")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
