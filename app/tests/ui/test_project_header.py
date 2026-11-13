"""The computer's one-row project header (#340, final design F-026 §4; Focus mode went with F-038, #872).

One row holds the project name, the views as underline tabs, the people and agents, and More. What needs the
person is only in the Inbox: the header carries no "N needs you" (#865).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import os

import json
import re
import time
import unittest
from datetime import datetime, timezone

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from themed_shots import shot_both

PASSWORD = "one calm header"
EMAIL = f"ada.header+{int(time.time() * 1000)}@example.test"
PROJECT = "Community garden sensors"


def soon() -> str:
    """A pause end the server accepts: a few hours ahead."""
    return datetime.fromtimestamp(time.time() + 3 * 3600, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


class ProjectHeader(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}")
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, scheme: str = "light", viewport: dict | None = None) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "viewport": viewport or DESKTOP, "device_scale_factor": 1}
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 201) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def ensure_project(self) -> None:
        if self.state:
            return
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Header")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Garden sensors"})
        project = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": PROJECT, "visibility": "restricted"})
        type(self).ids["project"] = project["id"]
        type(self).state = page.context.storage_state()

    def header(self, page: Page):
        return page.locator("header.top")

    def test_01_one_row_name_views_people_and_more(self) -> None:
        self.ensure_project()
        for scheme in ("light", "dark"):
            page = self.page(scheme)
            page.goto(f"/projects/{self.ids['project']}")
            header = self.header(page)
            expect(header.get_by_role("heading", level=1, name=PROJECT)).to_be_visible()
            views = header.get_by_role("navigation", name="Space views")
            self.assertEqual([text.strip() for text in views.get_by_role("tab").all_inner_texts()], ["Conversation", "Tasks", "Map", "Wiki"])
            expect(views.get_by_role("tab", name="Conversation")).to_have_attribute("aria-current", "page")
            # One row: the views sit beside the name, and no second toolbar row follows the header.
            name_box = header.get_by_role("heading", level=1).bounding_box()
            views_box = views.bounding_box()
            self.assertLess(abs((name_box["y"] + name_box["height"] / 2) - (views_box["y"] + views_box["height"] / 2)), 4)
            self.assertLessEqual(header.bounding_box()["height"], 72)
            expect(page.locator(".app__main > .views, .app__main > .state-row")).to_have_count(0)
            # The views are underline tabs (#1239): the current one has a 2 px underline as wide as its word, on the header's hairline, and no track or pill.
            word = views.get_by_role("tab", name="Conversation").locator(".ui-tabs__label").bounding_box()
            mark = views.locator(".ui-tabs__indicator").bounding_box()
            self.assertAlmostEqual(mark["width"], word["width"], delta=1.5)
            self.assertAlmostEqual(mark["height"], 2, delta=0.1)
            self.assertAlmostEqual(mark["y"] + mark["height"], header.bounding_box()["y"] + header.bounding_box()["height"], delta=1)
            self.assertEqual(views.locator(".ui-tabs__bar").evaluate("el => getComputedStyle(el).boxShadow"), "none")
            # People and agents as faces, which open the space's settings.
            faces = header.get_by_role("button", name=re.compile("who can see this space$"))
            expect(faces.locator(".ui-avatar")).to_have_count(1)
            # What needs Ada is in the Inbox alone: no chip in the header claims it (#865).
            expect(header.get_by_role("button", name=re.compile("needs you$"))).to_have_count(0)
            shot(page, f"340-header-1440-{scheme}")
        page.get_by_role("tab", name="Tasks", exact=True).click()
        expect(views.get_by_role("tab", name="Tasks")).to_have_attribute("aria-current", "page")
        faces.click()
        # The faces open the space's settings, where its people are (F-037).
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()

    def test_02_more_lists_settings_mute_and_details_and_no_sidebar_row(self) -> None:
        self.ensure_project()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        more = self.header(page).get_by_role("button", name="More", exact=True)
        more.click()
        menu = page.get_by_role("menu", name="More")
        # "People" is in More only where the header has no room for the faces (a narrow main column).
        items = menu.locator("[role^=menuitem]:visible")
        # Mute space (#1249) carries a one-line hint inside its label, so only the single-line labels are compared.
        labels = [text.strip() for text in items.locator("span").all_inner_texts() if "\n" not in text.strip()]
        self.assertEqual(labels, ["Settings", "Mute space", "Space details"])
        # The sidebar has its own control and `[`: no row for it here, so no key hint on touch either (#1376).
        self.assertEqual([items.nth(index).get_attribute("aria-keyshortcuts") for index in range(items.count())], [None, None, None])
        self.assertEqual(items.locator("kbd").all_inner_texts(), [])
        expect(menu.get_by_role("menuitem", name="Settings")).to_be_focused()
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(more).to_be_focused()
        more.click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Details").click()
        expect(page.get_by_role("complementary", name="Details")).to_be_visible()

    NAMES = ("Ada Kowalska", "Maja Wiśniewska", "Jonas Berg", "Piotr Nowak", "Sara Olsen", "Kai Tanaka", "Lee Moreno", "Nia Okafor", "Ben Okafor", "Zoe Lindqvist", "Ari Haddad", "Mia Novak")
    FACES = """() => {
      const visible = (el) => el.getClientRects().length > 0;
      const slot = document.querySelector('header.top .top__faces-slot'), pill = slot.querySelector('.top__faces');
      const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; };
      const faces = [...pill.querySelectorAll('.top__face, .top__more-faces')].filter(visible);
      const more = faces.find((el) => el.classList.contains('top__more-faces'));
      return { slot: box(slot), pill: box(pill), faces: faces.map(box), drawn: faces.filter((el) => el.classList.contains('top__face')).length,
        more: more ? { ...box(more), text: more.textContent } : null, background: getComputedStyle(pill).backgroundColor,
        wide: document.querySelector('.app__main').clientWidth >= 70 * 16 };
    }"""

    def people_of(self, page: Page, humans: int, agents: int) -> None:
        """The space's audience as the server would answer it for that many people and agents (the header only draws what it is given)."""
        people = [{"kind": "human", "id": f"00000000-0000-4000-8000-{n:012d}", "name": self.NAMES[n % len(self.NAMES)], "access": "contributor"} for n in range(humans)]
        people += [{"kind": "agent", "id": f"00000000-0000-4000-9000-{n:012d}", "name": f"Agent {n + 1}", "access": "contributor"} for n in range(agents)]
        page.unroute_all(behavior="ignoreErrors")
        page.route(re.compile(r".*/api/v1/projects/[0-9a-f-]{36}/people$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(people)))

        def shell(route) -> None:
            # Entering a space reads its people with its frame (#1109).
            response = route.fetch()
            route.fulfill(response=response, json={**response.json(), "people": people})
        page.route(re.compile(r".*/api/v1/projects/[0-9a-f-]{36}/space-shell$"), shell)

    def test_03_the_people_pill_hugs_its_touching_faces_inside_a_slot_that_never_moves(self) -> None:
        """#1236: the faces touch with whole initials; a header pane of 70 rem and up draws three people, the agent and "+N", a narrower one two
        people, the agent and "+N" (two digits too); the pill is as wide as its faces and ends at the slot's right edge; the slot (the width #873
        keeps: 100 px, 120 px from 70 rem) and the header's other controls are where they were whatever the number of people."""
        self.ensure_project()
        engine = UI_BROWSER
        counts = [(h, a) for h in (1, 2, 3, 4, 12, 99) for a in (0, 2)] + [(120, 0)]
        # An 820 px tablet in portrait has the people in More, where the name would otherwise be cut under its slot (#1375): 1180 is the tablet here.
        for width, height in ((1180, 820), (1280, 800), (1440, 900)):
            page = self.page("light", {"width": width, "height": height})
            slots, places = set(), []
            for humans, agents in counts:
                where = f"{width}: {humans} people and {agents} agents"
                self.people_of(page, humans, agents)
                page.goto(f"/projects/{self.ids['project']}")
                header = self.header(page)
                expect(header.get_by_role("button", name=re.compile("who can see this space$"))).to_be_visible()
                faces = page.evaluate(self.FACES)
                self.assertEqual(faces["wide"], width >= 1440, f"{width}: the header pane is {'wide' if width >= 1440 else 'narrow'}")
                people_shown = min(humans, 3 if faces["wide"] else 2)
                shown = people_shown + min(agents, 1)
                self.assertEqual(faces["drawn"], shown, f"{where}: {3 if faces['wide'] else 2} people and one agent at most")
                content = faces["faces"][-1]["right"] - faces["faces"][0]["left"]
                self.assertAlmostEqual(faces["pill"]["width"] - content, 12, delta=1.5, msg=f"{where}: the pill is its faces and 6 px each side, no empty area: {faces}")
                self.assertAlmostEqual(faces["faces"][0]["left"] - faces["pill"]["left"], faces["pill"]["right"] - faces["faces"][-1]["right"], delta=1, msg=f"{where}: equal padding")
                self.assertAlmostEqual(faces["pill"]["right"], faces["slot"]["right"], delta=1, msg=f"{where}: the pill ends at the slot's right edge")
                self.assertLessEqual(faces["pill"]["width"], faces["slot"]["width"] + 0.5, f"{where}: the pill fits its slot: {faces}")
                self.assertAlmostEqual(faces["slot"]["width"], 120 if faces["wide"] else 100, delta=1.5, msg=f"{where}: the slot keeps its width")
                self.assertEqual(faces["background"], "rgba(0, 0, 0, 0)", f"{where}: no grey area while nobody hovers it")
                for before, after in zip(faces["faces"], faces["faces"][1:]):
                    self.assertAlmostEqual(after["left"] - before["right"], 0, delta=0.6, msg=f"{where}: the faces touch, none overlaps: {faces['faces']}")
                rest = humans + agents - shown
                if rest:
                    self.assertIsNotNone(faces["more"], f"{where}: what does not fit is a +N face")
                    self.assertEqual(faces["more"]["text"], "99+" if rest > 99 else f"+{rest}")
                    self.assertAlmostEqual(faces["more"]["height"], 20, delta=0.5)
                    if rest < 10:
                        self.assertAlmostEqual(faces["more"]["width"], 20, delta=0.5, msg=f"{where}: +{rest} is a circle")
                    else:
                        self.assertLessEqual(faces["more"]["width"], 28, f"{where}: a two-digit count is a short pill")
                else:
                    self.assertIsNone(faces["more"], f"{where}: no +N when everyone is drawn")
                slots.add((round(faces["slot"]["left"]), round(faces["slot"]["right"])))
                places.append({"More": header.get_by_role("button", name="More", exact=True).bounding_box(),
                               "views": header.get_by_role("navigation", name="Space views").bounding_box(), "name": header.locator(".top__title").bounding_box()})
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, f"{where}: no sideways scroll")
                if (humans, agents) in ((2, 0), (4, 2), (12, 0), (99, 2)):
                    shot_both(page, f"1236-header-people-{width}-{humans}p{agents}a-{engine}")
            self.assertEqual(len(slots), 1, f"{width}: the slot is the same for every number of people: {slots}")
            for key in ("More", "views", "name"):
                for box in places[1:]:
                    for edge in ("x", "y", "width"):
                        self.assertAlmostEqual(places[0][key][edge], box[key][edge], delta=1, msg=f"{width}: {key} did not change its {edge} with the number of people")
        # Hovered, the pill is as wide as its faces too.
        page = self.page("light")
        self.people_of(page, 2, 0)
        page.goto(f"/projects/{self.ids['project']}")
        pill = self.header(page).get_by_role("button", name=re.compile("who can see this space$"))
        before = pill.bounding_box()
        pill.hover()
        # The hover colour arrives with the fill transition.
        page.wait_for_function("getComputedStyle(document.querySelector('.top__faces')).backgroundColor !== 'rgba(0, 0, 0, 0)'")
        self.assertEqual(pill.bounding_box(), before)
        shot_both(page, f"1236-header-people-hover-1440-{engine}")
        # The phone's header has no pill (the people are in More and the space's settings).
        phone = self.page("light", PHONE)
        self.people_of(phone, 4, 1)
        phone.goto(f"/projects/{self.ids['project']}")
        expect(phone.get_by_role("heading", level=1, name=PROJECT)).to_be_visible()
        shot_both(phone, f"1236-header-people-390-{engine}")


if __name__ == "__main__":
    unittest.main()
