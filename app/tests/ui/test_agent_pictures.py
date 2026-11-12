"""Browser tests for a picture an agent attaches to its answer (#1217, F-036 AG-8, C-59; design guide, `/ai`).

Runs with the other tests/ui journeys through scripts/check_ui.sh, on the TEST-ONLY mock provider: the real worker sends the run through the
real Anthropic adapter to `tests/ui/anthropic_mock.py`, which calls `flux_attach_image` once; the real API downloads the picture from the link
mock (`public.test`, tests/ui/link_mock.py) under the web reads' guard. Nothing here calls a model or a real site.

Jo asks "/ai find a picture of a raised garden bed and show it": the picture shows in Jo's private card as a message's photo does, with its change
line and Undo; Kai sees nothing until Jo's Show everyone, then the photo in Jo's message, on the computer and on the phone, after a reload too.
"""

from __future__ import annotations

import json
import os
import time
import unittest
import urllib.request
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "a picture worth showing"
STAMP = int(time.time() * 1000)
JO = {"name": "Jo Weber", "email": f"jo.weber.pic+{STAMP}@example.test"}
KAI = {"name": "Kai Lund", "email": f"kai.lund.pic+{STAMP}@example.test"}
PICTURE = "http://public.test/pic/raised-bed.png"
ANSWER = "Here is a raised garden bed built from larch boards, about 40 cm high (picture from public.test)."


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


def attach(caption: str = "Raised garden bed", text: str = ANSWER) -> None:
    mock("/__script", {"reset": True, "text": text,
                       "tool": {"name": "flux_attach_image", "input": {"clientCommandId": str(uuid.uuid4()), "url": PICTURE, "caption": caption}}})


class AgentPictures(unittest.TestCase):
    """Tests run in name order and share two accounts and one space."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        mock("/__script", {"reset": True})

    @classmethod
    def tearDownClass(cls) -> None:
        mock("/__script", {"reset": True})
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def space(self, who: str, **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator("#project-composer")).to_be_visible()
        return page

    def ask(self, page: Page, prompt: str) -> None:
        page.locator("#project-composer").fill(f"/ai {prompt}")
        page.get_by_role("button", name="Send to your assistant").click()

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    def loaded(self, image) -> None:
        """The photo really drew: the browser decoded the picture the server kept."""
        expect(image).to_be_visible(timeout=15000)
        image.page.wait_for_function("image => image.complete && image.naturalWidth === 480 && image.naturalHeight === 320", arg=image.element_handle())

    # ---------------------------------------------------------------- setup

    def test_01_two_people_share_a_space(self) -> None:
        for key, person in (("jo", JO), ("kai", KAI)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        jo = self.page("jo")
        ws = self.api(jo, "POST", "/api/v1/workspaces", {"name": "Allotment club"}, status=201)
        self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": KAI["email"], "role": "member"}, status=201)
        project = self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Raised beds", "visibility": "restricted"}, status=201)
        self.api(jo, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": KAI["id"]}, "role": "contributor"}, status=201)
        self.api(jo, "POST", f"/api/v1/projects/{project['id']}/conversations",
                 {"body": "We need four beds by the fence. What should they look like?", "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"]}
        type(self).ids["agent"] = self.api(jo, "POST", "/api/v1/my-agents", {"workspaceId": ws["id"]}, status=201)["id"]

    # ---------------------------------------------------------------- the picture

    def test_02_the_picture_is_jos_until_show_everyone_then_kai_sees_it_after_a_reload_too(self) -> None:
        attach()
        jo = self.space("jo")
        kai = self.space("kai")
        self.ask(jo, "find a picture of a raised garden bed and show it")
        card = jo.locator(".assistant-private")
        expect(card).to_be_visible(timeout=20000)
        expect(card).to_contain_text("larch boards")
        self.loaded(card.locator(".photo-grid img"))
        expect(card).to_contain_text("Attached the picture Raised garden bed from public.test/pic/raised-bed.png")
        expect(card.get_by_role("button", name="Undo")).to_be_visible()
        expect(card).not_to_contain_text("![")  # no picture written as Markdown
        shot(jo, "agent-picture-1440-light-private-card")
        # The run asked the provider with the tool, and the server, not the browser, fetched the picture.
        sent = [item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"]
        self.assertTrue(any(tool["name"] == "flux_attach_image" for tool in sent[0]["body"]["tools"]))
        self.assertIn("The picture is attached to your answer", json.dumps(sent[-1]["body"]))
        expect(kai.locator(".assistant-private")).to_have_count(0)
        expect(kai.locator(".photo-grid img")).to_have_count(0)
        # The viewer opens it, as any photo.
        card.get_by_role("button", name="Open photo Raised garden bed.png").click()
        viewer = jo.get_by_role("dialog")
        expect(viewer.locator("img")).to_be_visible()
        expect(viewer).to_contain_text("Raised garden bed.png")
        viewer.get_by_role("button", name="Close photo").click()
        # Show everyone: Jo's own message, via the agent, with the photo for everyone in the space.
        card.get_by_role("button", name="Show everyone").click()
        expect(card).to_have_count(0)
        posted = kai.locator(".project-convo__message").filter(has_text="larch boards")
        expect(posted).to_be_visible(timeout=15000)
        expect(posted).to_contain_text("via Assistant")
        self.loaded(posted.locator(".photo-grid img"))
        kai.reload()
        posted = kai.locator(".project-convo__message").filter(has_text="larch boards")
        self.loaded(posted.locator(".photo-grid img"))
        shot(kai, "agent-picture-1440-light-shown")

    def test_03_on_the_phone_and_in_dark_the_photo_fits(self) -> None:
        kai = self.space("kai", phone=True)
        posted = kai.locator(".project-convo__message").filter(has_text="larch boards")
        posted.scroll_into_view_if_needed()
        self.loaded(posted.locator(".photo-grid img"))
        self.no_horizontal_scroll(kai)
        shot(kai, "agent-picture-390-light-shown")
        dark = self.space("kai", dark=True)
        self.loaded(dark.locator(".project-convo__message").filter(has_text="larch boards").locator(".photo-grid img"))
        shot(dark, "agent-picture-1440-dark-shown")
        dark_phone = self.space("kai", phone=True, dark=True)
        self.loaded(dark_phone.locator(".project-convo__message").filter(has_text="larch boards").locator(".photo-grid img"))
        self.no_horizontal_scroll(dark_phone)
        shot(dark_phone, "agent-picture-390-dark-shown")

    def test_04_undo_takes_the_picture_off_the_answer_and_show_everyone_posts_the_words_alone(self) -> None:
        attach("Bed with a trellis", "Here is a bed with a trellis for the beans.")
        jo = self.space("jo", phone=True)
        self.ask(jo, "show me a bed with a trellis")
        card = jo.locator(".assistant-private")
        expect(card).to_be_visible(timeout=20000)
        self.loaded(card.locator(".photo-grid img"))
        self.no_horizontal_scroll(jo)
        shot(jo, "agent-picture-390-light-private-card")
        undo = card.get_by_role("button", name="Undo")
        box = undo.bounding_box()
        self.assertIsNotNone(box)
        undo.click()
        expect(card.locator(".photo-grid")).to_have_count(0)
        card.get_by_role("button", name="Show everyone").click()
        kai = self.space("kai")
        posted = kai.locator(".project-convo__message").filter(has_text="trellis for the beans")
        expect(posted).to_be_visible(timeout=15000)
        expect(posted.locator(".photo-grid")).to_have_count(0)

    def test_05_dark_private_card(self) -> None:
        attach("Raised bed in dark", "Another raised bed, seen from the path.")
        jo = self.space("jo", dark=True)
        self.ask(jo, "one more raised bed picture")
        card = jo.locator(".assistant-private")
        expect(card).to_be_visible(timeout=20000)
        self.loaded(card.locator(".photo-grid img"))
        shot(jo, "agent-picture-1440-dark-private-card")
        card.get_by_role("button", name="Dismiss").click()
        expect(card).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
