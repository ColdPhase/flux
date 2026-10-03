"""Browser tests for first notes on Home (#190 HOME-3).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose
application. A person without any space writes a first note: it creates one "Personal" space and is
a private draft there. Notes an account once kept only in this browser are offered, explicitly, to
move into that space, one draft per note, exactly once, across lost responses, two tabs and a
same-tab account switch; another account is never offered them. Screenshots (home-notes-*.png) go
to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "notes that reach my account"
STAMP = int(time.time() * 1000)


def notes(prefix: str, count: int) -> list[dict]:
    return [{"id": f"{prefix}-{index}", "text": f"{prefix} note {index}: the shade could be paper", "createdAt": f"2026-09-2{index}T09:00:00.000Z"}
            for index in range(1, count + 1)]


class HomeNotesJourney(unittest.TestCase):
    """Each test signs up its own people, so the tests stay independent."""

    pw = None
    browser: Browser

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def watch(self, page: Page) -> Page:
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def sign_up(self, context: BrowserContext, name: str) -> tuple[Page, dict]:
        email = f"{name.lower().replace(' ', '.')}+{STAMP}-{time.time_ns()}@example.test"
        page = self.watch(context.new_page())
        page.goto("/sign-up")
        page.get_by_label("Name").fill(name)
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        user = page.evaluate("fetch('/api/v1/me').then(r => r.json())")["user"]
        return page, {"id": user["id"], "email": email, "name": name}

    def get(self, page: Page, path: str):
        return page.evaluate(f"fetch({json.dumps(path)}).then(r => r.json())")

    def spaces(self, page: Page) -> list[dict]:
        return self.get(page, "/api/v1/workspaces")

    def drafts(self, page: Page, workspace_id: str) -> list[str]:
        return sorted(item["body"] for item in self.get(page, f"/api/v1/workspaces/{workspace_id}/drafts?limit=100")["items"])

    def keep_in_browser(self, page: Page, user_id: str, items: list[dict]) -> None:
        page.evaluate(f"localStorage.setItem('flux.captures.{user_id}', {json.dumps(json.dumps(items))})")

    def in_browser(self, page: Page, user_id: str) -> list[dict]:
        return json.loads(page.evaluate(f"localStorage.getItem('flux.captures.{user_id}') ?? '[]'"))

    def offer(self, page: Page):
        return page.get_by_role("region", name="Notes in this browser")

    # ---------------------------------------------------------------- the first note

    def test_01_the_first_note_creates_one_personal_space(self) -> None:
        context = self.context()
        page, _ = self.sign_up(context, "Nia First")
        composer = page.get_by_label("Private note", exact=True)
        expect(page.locator(".composer__where")).to_have_text("private draft in your personal space")
        # A double Enter and a second tab saving at the same moment still make one space.
        other = self.watch(context.new_page())
        other.goto("/")
        other.get_by_label("Private note", exact=True).fill("From the other tab")
        composer.fill("The first note")
        composer.press("Enter")
        composer.press("Enter")
        other.get_by_label("Private note", exact=True).press("Enter")
        drafts = page.get_by_role("region", name="Private drafts")
        expect(drafts.get_by_text("The first note")).to_be_visible()
        expect(other.get_by_role("region", name="Private drafts").get_by_text("From the other tab")).to_be_visible()
        spaces = self.spaces(page)
        self.assertEqual([space["name"] for space in spaces], ["Personal"])
        self.assertEqual(self.drafts(page, spaces[0]["id"]), ["From the other tab", "The first note"], "each note saved once")
        expect(page.locator(".composer__where")).to_have_text("private draft in Personal, which only you can open")
        shot(page, "home-notes-first-desktop-1440")
        # A sketch afterwards uses the same space.
        page.get_by_role("navigation", name="Views").get_by_role("link", name="Map").click()
        page.get_by_role("button", name="New sketch").click()
        expect(page).to_have_url(re.compile(r"/map/[0-9a-f-]{36}$"))
        self.assertEqual(len(self.spaces(page)), 1, "a sketch reuses the personal space")
        # The open private sketch is Home's Map view.
        expect(page.get_by_role("navigation", name="Views").get_by_role("link", name="Map")).to_have_attribute("aria-current", "page")
        shot(page, "home-notes-first-sketch-desktop-1440")

    def test_02_a_first_save_that_fails_keeps_the_text(self) -> None:
        context = self.context()
        page, _ = self.sign_up(context, "Nia Offline")
        page.route(re.compile(r"/api/v1/workspaces/[^/]+/drafts$"), lambda route: route.abort("failed") if route.request.method == "POST" else route.continue_())
        composer = page.get_by_label("Private note", exact=True)
        composer.fill("Keep me if the network drops")
        composer.press("Enter")
        expect(page.get_by_role("status").filter(has_text="Save failed. Your text is still here")).to_be_visible()
        expect(composer).to_have_value("Keep me if the network drops")
        self.assertEqual(self.in_browser(page, self.get(page, "/api/v1/me")["user"]["id"]), [], "nothing falls back to this browser")
        page.unroute(re.compile(r"/api/v1/workspaces/[^/]+/drafts$"))
        composer.press("Enter")
        expect(page.get_by_role("region", name="Private drafts").get_by_text("Keep me if the network drops")).to_be_visible()
        spaces = self.spaces(page)
        self.assertEqual(len(spaces), 1, "the retry used the space the failed attempt created")
        self.assertEqual(self.drafts(page, spaces[0]["id"]), ["Keep me if the network drops"])

    # ---------------------------------------------------------------- moving browser notes

    def test_03_moving_survives_a_lost_response_and_moves_each_note_once(self) -> None:
        context = self.context()
        page, nia = self.sign_up(context, "Nia Mover")
        kept = notes("lost", 3)
        self.keep_in_browser(page, nia["id"], kept)
        page.reload()
        offer = self.offer(page)
        expect(offer.get_by_role("listitem")).to_have_count(3)
        move = offer.get_by_role("button", name="Move 3 notes into Personal")
        expect(offer).to_contain_text("They become private drafts only you can open")
        shot(page, "home-notes-offer-desktop-1440")
        # The second note's draft is created, but its answer never arrives.
        seen = {"count": 0}

        def lose_second(route) -> None:
            if route.request.method != "POST":
                route.continue_()
                return
            seen["count"] += 1
            if seen["count"] == 2:
                route.fetch()
                route.abort("failed")
            else:
                route.continue_()
        drafts_path = re.compile(r"/api/v1/workspaces/[^/]+/drafts$")
        page.route(drafts_path, lose_second)
        move.click()
        expect(offer.get_by_role("status")).to_contain_text("Moved 2 of 3. The rest stay in this browser")
        self.assertEqual([item["id"] for item in self.in_browser(page, nia["id"])], ["lost-2"], "only the unconfirmed note stays")
        page.unroute(drafts_path, lose_second)
        offer.get_by_role("button", name="Move 1 note into Personal").click()
        expect(page.get_by_role("status").filter(has_text="Moved 1 note into Personal.")).to_be_visible()
        expect(self.offer(page)).to_have_count(0)
        self.assertEqual(self.in_browser(page, nia["id"]), [])
        space = self.spaces(page)
        self.assertEqual(len(space), 1)
        self.assertEqual(self.drafts(page, space[0]["id"]), sorted(item["text"] for item in kept), "one draft per note, the lost answer included")
        expect(page.get_by_role("region", name="Private drafts").get_by_role("listitem")).to_have_count(3)

    def test_04_two_tabs_and_a_deletion_elsewhere(self) -> None:
        context = self.context()
        first, nia = self.sign_up(context, "Nia Tabs")
        kept = notes("tabs", 4)
        self.keep_in_browser(first, nia["id"], kept)
        first.reload()
        second = self.watch(context.new_page())
        second.goto("/")
        expect(self.offer(second).get_by_role("listitem")).to_have_count(4)
        # Deleted in the second tab: the first tab's list follows, and the move skips it.
        self.offer(second).get_by_role("button", name=re.compile("Delete note: tabs note 2")).click()
        expect(self.offer(first).get_by_role("listitem")).to_have_count(3)
        # Both tabs move at the same moment: every note becomes exactly one draft.
        first_move = self.offer(first).get_by_role("button", name=re.compile(r"^Move \d notes? into Personal$"))
        second_move = self.offer(second).get_by_role("button", name=re.compile(r"^Move \d notes? into Personal$"))
        expect(first_move).to_have_text("Move 3 notes into Personal")
        first_move.click()
        second_move.click()
        expect(self.offer(first)).to_have_count(0)
        expect(self.offer(second)).to_have_count(0)
        self.assertEqual(self.in_browser(first, nia["id"]), [])
        space = self.spaces(first)
        self.assertEqual(len(space), 1)
        self.assertEqual(self.drafts(first, space[0]["id"]), sorted(item["text"] for item in kept if item["id"] != "tabs-2"))
        # A stale tab never writes them back.
        second.reload()
        expect(self.offer(second)).to_have_count(0)
        self.assertEqual(self.in_browser(second, nia["id"]), [])

    def test_05_another_account_is_never_offered_them_and_a_switch_stops_the_move(self) -> None:
        context = self.context()
        page, nia = self.sign_up(context, "Nia Switch")
        _, olek = self.sign_up(self.context(), "Olek Switch")
        kept = notes("switch", 3)
        self.keep_in_browser(page, nia["id"], kept)
        page.reload()
        offer = self.offer(page)
        expect(offer.get_by_role("listitem")).to_have_count(3)
        # The move's look at Nia's spaces is answered only after Olek has signed in to this tab, and as a real
        # success ("no spaces yet"). Only the page dropping Nia's move keeps it from creating a space and
        # drafts under Olek's session; the held request itself would otherwise just fail on the server.
        held: list = []

        def hold_first_list(route) -> None:
            if route.request.method == "GET" and not held:
                held.append(route)
                return
            route.continue_()

        spaces_path = re.compile(r"/api/v1/workspaces$")
        page.route(spaces_path, hold_first_list)
        offer.get_by_role("button", name="Move 3 notes into Personal").click()
        for _ in range(60):
            if held:
                break
            page.wait_for_timeout(50)
        self.assertEqual(len(held), 1, "the move asked for Nia's spaces")
        page.get_by_role("button", name=re.compile("Nia Switch")).click()
        page.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click()
        expect(page).to_have_url(re.compile("/sign-in"))
        page.get_by_label("Email").fill(olek["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("heading", name="Welcome, Olek")).to_be_visible()
        try:
            held[0].fulfill(status=200, content_type="application/json", body="[]")
        except Exception:  # the page already gave up on it when the account changed
            pass
        page.unroute(spaces_path)
        page.wait_for_timeout(800)
        # Olek is never offered Nia's notes, and nothing of hers was saved under his session.
        expect(self.offer(page)).to_have_count(0)
        self.assertNotIn("switch note", page.content())
        self.assertEqual(self.spaces(page), [], "Olek has no space and so no drafts")
        self.assertEqual(sorted(item["id"] for item in self.in_browser(page, nia["id"])), ["switch-1", "switch-2", "switch-3"],
                         "the move stopped with the account switch; every note is still Nia's, in this browser")

    def test_05b_a_sign_in_in_another_tab_never_receives_this_tabs_notes(self) -> None:
        # Requests carry the browser's one session. After Nia signs out and Olek signs in in another tab, tabs
        # that still show Nia write nothing: not her browser notes, not a typed first note (#211 review B1).
        context = self.context()
        moving, nia = self.sign_up(context, "Nia Stale")
        _, olek = self.sign_up(self.context(), "Olek Stale")
        kept = notes("stale", 2)
        self.keep_in_browser(moving, nia["id"], kept)
        moving.reload()
        expect(self.offer(moving).get_by_role("listitem")).to_have_count(2)
        typing = self.watch(context.new_page())
        typing.goto("/")
        typing.get_by_label("Private note").fill("Typed while Nia was signed in")
        switching = self.watch(context.new_page())
        switching.goto("/")
        switching.get_by_role("button", name=re.compile("Nia Stale")).click()
        switching.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click()
        expect(switching).to_have_url(re.compile("/sign-in"))
        switching.get_by_label("Email").fill(olek["email"])
        switching.get_by_label("Password").fill(PASSWORD)
        switching.get_by_role("button", name="Sign in").click()
        expect(switching.get_by_role("heading", name="Welcome, Olek")).to_be_visible()
        # The stale tabs still show Nia's Home. Moving and saving check the session first, write nothing,
        # and the tab catches up with the account that is signed in now.
        self.offer(moving).get_by_role("button", name="Move 2 notes into Personal").click()
        expect(moving.get_by_role("heading", name="Welcome, Olek")).to_be_visible()
        typing.get_by_role("button", name="Save note").click()
        expect(typing.get_by_role("heading", name="Welcome, Olek")).to_be_visible()
        self.assertEqual(self.spaces(switching), [], "nothing was created or saved for Olek")
        self.assertEqual(sorted(item["id"] for item in self.in_browser(moving, nia["id"])), ["stale-1", "stale-2"],
                         "Nia's notes stay in this browser, still hers")

    def test_06_not_now_and_phone(self) -> None:
        context = self.context(phone=True)
        page, nia = self.sign_up(context, "Nia Phone")
        self.keep_in_browser(page, nia["id"], notes("phone", 2))
        page.reload()
        offer = self.offer(page)
        move = offer.get_by_role("button", name="Move 2 notes into Personal")
        box = move.bounding_box()
        assert box
        self.assertGreaterEqual(box["height"], 44, "touch target")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no horizontal scroll")
        shot(page, "home-notes-offer-phone-390")
        offer.get_by_role("button", name="Not now").tap()
        expect(move).to_have_count(0)
        expect(offer.get_by_role("listitem")).to_have_count(2)
        # The offer returns on the next visit; nothing moved meanwhile.
        page.reload()
        expect(self.offer(page).get_by_role("button", name="Move 2 notes into Personal")).to_be_visible()
        self.assertEqual(self.spaces(page), [])


if __name__ == "__main__":
    unittest.main()
