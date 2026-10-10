"""Integrated founder scenarios of #44, played end to end across features (release row R-9; #136 AC-4, T136-F).

Runs with the other tests/ui journeys through scripts/check_ui.sh (`./scripts/check_ui.sh test_scenarios`).
Each viewport class (desktop 1440, and a 390 touch phone that moves between places with the bottom bar
of #266 PF-1) creates its own people, workspace and projects and plays the scenarios in order, as the
people in them would, in the browser:

1. Idea to collaboration (test_1): Ada signs up, starts Riverside Makers with a four-person
   "Marketplace stall" project and adds the people. In a DM, Ada and Jonas discuss a gesture-controlled
   lamp; they select the camera, sensor and privacy messages, sketch from them and make a separate
   two-person "Gesture lamp" project from the sketch. Jonas signs in and writes there; Ada replies in the
   thread with no audience checkbox. Mia and Lee, who share Marketplace, see none of it.
2. Thinking and execution inform each other (test_2): a person proposes and accepts the first rule; one
   experiment is created from several thoughts on the map; Jonas posts the low-light run with an
   attachment; Ada records a negative result that finishes the experiment, reaches the same thread from
   the task and from the map, adds the sensor alternative as a new thought, and writes a wiki page that
   cites the result and the experiment. A task created first is linked to the map later; a removed map
   placement keeps its task; Tasks shows only committed work.
3. An agent proposes the pivot under a standing grant and a person accepts it (test_3; O-009): Ada grants
   her MCP connection "Propose decisions" on the Connect page; the agent (a real OAuth bearer) proposes
   "Switch to a ToF distance sensor"; Jonas reaches it from his inbox and accepts it as a pivot, parking
   the camera work and keeping the sensor order.
4. Return after the pivot without AI (test_4): Ada comes back to Home and the project and finds the new
   direction, the previous rule, the parked work and the work that still applies, with no AI.
5. Inbox, search and the wiki (test_5): the inbox, Jump to and the search page find the items; the wiki
   page gets a second version citing the new rule, and its first version stays as written.
6. Export and audience (test_6): Ada's project export holds the conversation, the attachment, the map,
   the work, both rules, the result, the page and their links, and nothing private. A viewer reads the
   project but not Ada's private note or the DM and cannot accept a decision; a non-member gets 404.

Where the product cannot do a step yet, that step is its own small method marked
@unittest.expectedFailure with the reason (test_2a, test_2b, test_4a), and the scenario continues through
the API so that the later steps still run; an unexpected success fails the run once the product is fixed. Every outcome is read back from the API. Screenshots
(scenario-*.png) go to FLUX_UI_SCREENSHOTS when it is set.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import secrets
import tarfile
import time
import unittest
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "a lamp that listens to hands"
NAMES = {"ada": "Ada Kowalska", "jonas": "Jonas Berg", "mia": "Mia Novak", "lee": "Lee Moreno"}
WORKSPACE = "Riverside Makers"
MARKET = "Marketplace stall"
LAMP = "Gesture lamp"
MARKET_NOTE = "Stall plan: lamps on the left table, price tags on kraft paper."
DM = [
    ("ada", "What if the bedside lamp reacted to a wave of the hand instead of a switch?"),
    ("jonas", "A small camera could read gestures, but it needs some light to see them."),
    ("ada", "Or a ToF distance sensor: it works in the dark and stores no image."),
    ("jonas", "Privacy matters here: nobody wants a camera pointed at their bed."),
    ("jonas", "Unrelated: are you coming to the Saturday market?"),
]
CAMERA, SENSOR, PRIVACY, LEFT_OUT = DM[1][1], DM[2][1], DM[3][1], DM[4][1]
LOW_LIGHT = "Low light: below 10 lux the camera has to guess"
VARIANT_B = "Variant B: a VL53L1X sensor behind the shade"
JONAS_ROOT = "Copied our lamp sketch here. Tonight I test the camera in a dark bedroom."
ADA_REPLY = "Good, note the lux level so we can compare later."
D1, WHY1 = "Use the camera for gesture detection", "It recognises the richest set of gestures"
CAMERA_TASK = "Mount the camera in the lamp head"
ORDER_TASK = "Order a VL53L1X breakout board"
RUN_ROOT = "Low-light run done: at 5 lux the camera recognised 7 of 20 gestures. Readings attached."
RUN_REPLY = "That settles it for the camera at night."
CSV = b"lux,gesture,recognised\n5,swipe,no\n5,hold,yes\n5,wave,no\n50,swipe,yes\n50,hold,yes\n"
RESULT = "Camera misses 13 of 20 gestures at 5 lux"
EVIDENCE = "20 gestures at 60 cm in a dark bedroom; readings in lux-readings.csv"
DOC_TITLE = "How the lamp senses hands"
DOC_BODY = "We started with a camera. The low-light run showed why it fails at night: "
MARKET_THOUGHT = "Ask market visitors what they think about privacy"
MARKET_TASK = "Collect privacy comments at the stall"
D2 = "Switch to a ToF distance sensor"
WHY2 = "The camera missed 13 of 20 gestures at 5 lux. A ToF sensor works in the dark and stores no image."
D3 = "Offer a warm-white shade option"
QUESTION = "Ada, can you solder the VL53L1X board on Thursday?"
DRAFT = "Price the lamp at 89 EUR? Ask Jonas after the market."
REDIRECT = "http://127.0.0.1:19737/callback"
ACTION_SCOPES = ["flux.context.read", "flux.proposal.write", "flux.action.execute"]


class McpAgent:
    """Ada's external agent: a real OAuth authorization-code/PKCE bearer and MCP-over-HTTP calls.

    The UI harness has no database, so the client is registered through the test-only fixture route
    (`FLUX_FIXTURE_TOKEN` and failure injection; browser sessions cannot register clients since #287) instead of
    the SQL fixture of tests/app/support/mcp-actions.ts; authorize, connection selection, consent, token and MCP
    are the same real endpoints."""

    def __init__(self, test: "ScenarioJourney", owner: str, connection_id: str, project_id: str) -> None:
        self.test, self.project_id, self.call_id = test, project_id, 0
        client = test.api(owner, "POST", "/api/v1/integration/oauth-clients", {
            "name": "Ada's Claude Code (scenario client)", "redirectUris": [REDIRECT], "scopes": ACTION_SCOPES + ["offline_access"]},
            status=201, headers={"authorization": f"Bearer {os.environ['FLUX_FIXTURE_TOKEN']}"})
        verifier = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        query = urllib.parse.urlencode({"client_id": client["clientId"], "redirect_uri": REDIRECT, "response_type": "code",
                                        "code_challenge": challenge, "code_challenge_method": "S256", "state": str(uuid.uuid4()),
                                        "scope": " ".join(ACTION_SCOPES + ["offline_access"]), "resource": f"{ORIGIN}/mcp", "prompt": "consent"})
        start = test.req[owner].request.fetch(f"{ORIGIN}/api/auth/oauth2/authorize?{query}", headers={"origin": ORIGIN, "accept": "text/html"}, max_redirects=0)
        location = start.headers.get("location") if start.status == 302 else start.json().get("url")
        choice = urllib.parse.urlsplit(urllib.parse.urljoin(ORIGIN, location))
        test.assertEqual(choice.path, "/connect-agent", "authorize sends the owner to choose a connection")
        test.api(owner, "POST", f"/api/v1/agent-connections/{connection_id}/select-for-oauth", {"oauth_query": choice.query}, status=204)
        continued = test.api(owner, "POST", "/api/auth/oauth2/continue", {"postLogin": True, "oauth_query": choice.query}, status=200)
        destination = urllib.parse.urlsplit(urllib.parse.urljoin(ORIGIN, continued.get("url") or continued.get("redirect_uri")))
        callback = destination
        if destination.path == "/consent":
            shown = test.api(owner, "GET", f"/api/v1/agent-oauth/consent-context?oauth_query={urllib.parse.quote(destination.query)}", status=200)
            test.assertEqual(shown["connection"]["id"], connection_id)
            consent = test.api(owner, "POST", "/api/auth/oauth2/consent", {"accept": True, "oauth_query": destination.query}, status=200)
            callback = urllib.parse.urlsplit(consent.get("url") or consent.get("redirect_uri"))
        code = urllib.parse.parse_qs(callback.query)["code"][0]
        self.http = test.pw.request.new_context()
        token = self.http.post(f"{ORIGIN}/api/auth/oauth2/token", form={"grant_type": "authorization_code", "code": code,
                                                                     "redirect_uri": REDIRECT, "client_id": client["clientId"], "code_verifier": verifier})
        test.assertEqual(token.status, 200, token.text())
        self.bearer = token.json()["access_token"]
        boot = self.tool("flux_bootstrap", {"projectId": project_id, "clientSessionId": str(uuid.uuid4())})
        self.runtime = boot["runtime"]["id"]

    def rpc(self, method: str, params: dict) -> dict:
        self.call_id += 1
        name = params.get("name")
        response = self.http.post(f"{ORIGIN}/mcp", headers={
            "authorization": f"Bearer {self.bearer}", "content-type": "application/json", "accept": "application/json",
            "mcp-protocol-version": "2026-07-28", "mcp-method": method, **({"mcp-name": name} if name else {})},
            data=json.dumps({"jsonrpc": "2.0", "id": self.call_id, "method": method, "params": {**params, "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {"name": "flux-scenario-agent", "version": "1"},
                "io.modelcontextprotocol/clientCapabilities": {}}}}))
        self.test.assertEqual(response.status, 200, response.text())
        text = response.text()
        if "text/event-stream" in (response.headers.get("content-type") or ""):
            text = next(line[6:] for line in text.split("\n") if line.startswith("data: "))
        return json.loads(text)

    def tool(self, name: str, arguments: dict) -> dict:
        message = self.rpc("tools/call", {"name": name, "arguments": arguments})
        result = message.get("result") or {}
        self.test.assertFalse(message.get("error") or result.get("isError"), f"{name}: {message}")
        return json.loads(result["content"][0]["text"])

    def tool_names(self) -> list[str]:
        return [tool["name"] for tool in self.rpc("tools/list", {})["result"]["tools"]]

    def close(self) -> None:
        self.http.dispose()


class ScenarioJourney:
    """Shared steps; the viewport classes below run them in name order on their own data."""

    phone = False
    label = ""
    pw = None
    browser: Browser
    s: dict
    ids: dict
    emails: dict
    states: dict
    req: dict

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        stamp = f"{cls.label}.{int(time.time() * 1000)}"
        cls.s, cls.ids, cls.states, cls.req = {}, {}, {}, {}
        cls.emails = {key: f"{key}.scenario+{stamp}@example.test" for key in NAMES}
        # Jonas, Mia and Lee already have accounts at this Flux address; Ada creates hers in the browser.
        for key in ("jonas", "mia", "lee"):
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": cls.emails[key], "password": PASSWORD, "name": NAMES[key]},
                                            headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            cls.req[key] = context

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.s.get("agent"):
            cls.s["agent"].close()
        for context in cls.req.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- helpers

    def need(self, *keys: str) -> None:
        missing = [key for key in keys if key not in self.s]
        if missing:
            self.skipTest(f"an earlier scenario step did not complete ({', '.join(missing)} missing)")

    def page(self, who: str | None) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "accept_downloads": True}
        if self.phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def keep(self, who: str, page: Page) -> None:
        """Keeps the browser session of a person who signed in through the UI, for later pages and API reads."""
        type(self).states[who] = page.context.storage_state()
        if who in self.req:
            self.req[who].close()
        self.req[who] = self.browser.new_context(base_url=ORIGIN, storage_state=self.states[who])
        self.ids[who] = self.api(who, "GET", "/api/v1/me", status=200)["user"]["id"]

    def fetch(self, who: str, method: str, path: str, body: dict | None = None, headers: dict | None = None):
        return self.req[who].request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                           headers={"origin": ORIGIN, **({"content-type": "application/json"} if body is not None else {}), **(headers or {})})

    def api(self, who: str, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None):
        response = self.fetch(who, method, path, body, headers)
        if status is not None:
            self.assertEqual(response.status, status, f"{who} {method} {path}: {response.text()}")
        text = response.text()
        return json.loads(text) if text and text[:1] in "[{" else {}

    def status(self, who: str, path: str) -> int:
        return self.fetch(who, "GET", path).status

    def tap(self, locator) -> None:
        locator.tap() if self.phone else locator.click()

    def details(self, page: Page):
        return page.get_by_role("dialog", name="Details") if self.phone else page.locator("#details")

    def close_details(self, page: Page) -> None:
        if self.phone:
            page.get_by_role("button", name="Close details").tap()
            expect(page.get_by_role("dialog", name="Details")).to_have_count(0)

    def go_to_place(self, page: Page, name: str) -> None:
        """A main place. Phones have them in the bottom bar (#266 PF-1: Home, Inbox, Messages, Projects); the
        desktop sidebar has Home, Inbox and Direct messages under Places, and the projects themselves."""
        if self.phone:
            bar = page.get_by_role("navigation", name="Main places")
            bar.get_by_role("link", name=re.compile(f"^{name}")).tap()
            expect(bar.get_by_role("link", name=re.compile(f"^{name}"))).to_have_attribute("aria-current", "page")
        else:
            (page.locator("#side-dms").get_by_role("link", name="Messages", exact=True) if name == "Messages" else page.get_by_role("navigation", name="Places").get_by_role("link", name=re.compile(f"^{name}"))).click()

    def project_list(self, page: Page):
        """The projects a person can open: the sidebar on a desktop, the Projects place on a phone."""
        if self.phone:
            self.go_to_place(page, "Projects")
            expect(page.get_by_role("heading", level=1, name="Projects")).to_be_visible()
            return page.get_by_role("list", name="Projects")
        return page.get_by_role("navigation", name="Projects")

    def no_sideways_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"), "no horizontal page scroll")

    def shot(self, page: Page, name: str) -> None:
        shot(page, f"scenario-{self.label}-{name}")

    def roots(self, who: str, project: str) -> list[dict]:
        return self.api(who, "GET", f"/api/v1/projects/{project}/conversation-roots?limit=100", status=200)["roots"]

    def root_of(self, who: str, project: str, body: str) -> dict:
        found = self.wait_for(f"the root {body!r}", lambda: [root for root in self.roots(who, project) if root["message"]["body"] == body])
        self.assertEqual(len(found), 1, f"one root says {body!r}")
        return found[0]

    def sketch(self, who: str, sketch_id: str) -> dict:
        return self.api(who, "GET", f"/api/v1/sketches/{sketch_id}", status=200)

    def thought_id(self, sketch: dict, text: str) -> str:
        found = [thought["id"] for thought in sketch["thoughts"] if thought["text"] == text]
        self.assertEqual(len(found), 1, f"one thought reads {text!r}: {[t['text'] for t in sketch['thoughts']]}")
        return found[0]

    def work_items(self, who: str) -> list[dict]:
        return self.api(who, "GET", f"/api/v1/projects/{self.s['lamp']}/work?limit=100", status=200)["items"]

    def decision_titled(self, who: str, title: str) -> dict:
        items = self.api(who, "GET", f"/api/v1/projects/{self.s['lamp']}/decisions?limit=100", status=200)["items"]
        found = [item for item in items if item["title"] == title]
        self.assertEqual(len(found), 1, f"one decision is titled {title!r}")
        return found[0]

    def wait_for(self, what: str, check, tries: int = 80):
        for _ in range(tries):
            value = check()
            if value:
                return value
            time.sleep(0.25)
        self.fail(f"timed out waiting for {what}")

    def inbox_titles(self, who: str) -> list[str]:
        return [item["title"] for item in self.api(who, "GET", "/api/v1/inbox?limit=100", status=200)["items"]]

    def open_map(self, page: Page) -> None:
        """The project map; the phone uses the List route, where every thought is a tappable row."""
        page.goto(f"/projects/{self.s['lamp']}/map/{self.s['map']}")
        expect(page.get_by_role("group", name=re.compile("^Sketch: ")).or_(page.locator(".sk-outline-list"))).to_be_visible()
        if self.phone:
            page.get_by_role("radio", name="List", exact=True).tap()
            expect(page.locator(".sk-outline-list")).to_be_visible()

    def thought(self, page: Page, thought_id: str):
        return page.locator(f'.sk-li-t[data-id="{thought_id}"]') if self.phone else page.locator(f'.sk-node[data-id="{thought_id}"]')

    def add_connected_thought(self, page: Page, sketch_id: str, parent_id: str, text: str) -> str:
        before = len(self.sketch("ada", sketch_id)["thoughts"])
        self.tap(self.thought(page, parent_id))
        if self.phone:
            row = page.locator(f'.sk-outline-list li[data-id="{parent_id}"]').first
            row.get_by_role("button", name="Add thought", exact=True).first.tap()
        else:
            page.get_by_role("button", name=re.compile("^Add a thought connected to")).click()
        editor = page.get_by_label("Thought text")
        expect(editor).to_be_focused()
        editor.fill(text)
        editor.press("Enter")
        stored = self.wait_for(f"the thought {text!r}", lambda: (lambda s: s if len(s["thoughts"]) == before + 1 else None)(self.sketch("ada", sketch_id)))
        new_id = self.thought_id(stored, text)
        self.assertTrue(any({link["fromId"], link["toId"]} == {parent_id, new_id} for link in stored["links"]), "the new thought is connected to its parent")
        return new_id

    def give_access(self, page: Page, key: str, read_only: bool) -> None:
        region = page.get_by_role("region", name="Who can see this")
        self.tap(region.get_by_role("button", name="Give someone access"))
        give = region.get_by_role("group", name="Give someone access")
        give.get_by_label("Person").select_option(value=self.ids[key])
        if read_only:
            give.get_by_role("group", name="Access").get_by_text("Can read", exact=True).click()
        first = NAMES[key].split()[0]
        self.tap(give.get_by_role("button", name=f"Give {first} access"))
        expect(region.locator(".people__done")).to_contain_text(f"{first} can now {'read' if read_only else 'write'}")

    def send_message(self, page: Page, composer, button) -> None:
        if self.phone:
            button.tap()
        else:
            composer.press("Enter")
        expect(composer).to_have_value("")

    def link_in_doc(self, page: Page, text, kind: str, item_id: str, title: str) -> None:
        """Inserts a reference: Ctrl+K from the text on desktop, the visible Link button on the phone."""
        text.focus()
        text.press("Control+End")
        if self.phone:
            page.get_by_role("button", name="Link", exact=True).tap()
        else:
            text.press("Control+k")
        picker = page.get_by_role("dialog", name="Link to something in this project")
        picker.get_by_label("Reference type").select_option(kind)
        query = picker.get_by_role("combobox", name="Find a doc, decision, result, work, sketch or message", exact=True)
        query.fill(title[:40])
        option = picker.get_by_role("listbox", name="Matches").get_by_role("option").first
        expect(option).to_contain_text(title[:40])
        if self.phone:
            option.tap()
        else:
            query.press("Enter")
        expect(text).to_have_value(re.compile(re.escape(f"flux:{kind}/{item_id}")))
        # The editor puts the caret after the inserted link on the next frames; type after that.
        page.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))")

    # ---------------------------------------------------------------- scenario 1: idea to collaboration

    def test_1_idea_to_collaboration(self) -> None:
        s = self.s
        # Ada creates her account and starts a space with a first, four-person project.
        page = self.page(None)
        page.goto("/sign-up")
        page.get_by_label("Name").fill(NAMES["ada"])
        page.get_by_label("Email").fill(self.emails["ada"])
        page.get_by_label("Password").fill(PASSWORD)
        self.tap(page.get_by_role("button", name="Create account"))
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.keep("ada", page)
        if self.phone:
            self.go_to_place(page, "Projects")
            expect(page.get_by_text("No projects yet.")).to_be_visible()
            page.get_by_role("link", name="Create a project").tap()
        else:
            page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="New", exact=True).click()
            page.get_by_role("menu", name="New").get_by_role("menuitem", name="Project", exact=True).click()
        page.get_by_label("Your space").fill(WORKSPACE)
        page.get_by_label("Project name").fill(MARKET)
        self.tap(page.get_by_role("button", name="Create project"))
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}\?new=1"))
        market = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        workspace = self.api("ada", "GET", f"/api/v1/projects/{market}", status=200)["workspaceId"]

        # She adds the others to the space by email (Home → Details → People).
        page.goto("/")
        self.tap(page.get_by_role("button", name="Details", exact=True))
        self.tap(page.get_by_role("region", name="People").get_by_role("button", name=re.compile(f"^{WORKSPACE}")))
        expect(page.get_by_role("heading", name="People", exact=True)).to_be_visible()
        for key in ("jonas", "mia", "lee"):
            form = page.get_by_role("region", name="Add someone")
            form.get_by_label("Email").fill(self.emails[key])
            self.tap(form.get_by_role("button", name=re.compile("^Add to ")))
            expect(page.locator(".people__done")).to_have_text(f"{NAMES[key]} joined {WORKSPACE} as member.")
        members = {member["userId"]: member["role"] for member in self.api("ada", "GET", f"/api/v1/workspaces/{workspace}/members", status=200)}
        self.assertEqual(members, {self.ids["ada"]: "owner", self.ids["jonas"]: "member", self.ids["mia"]: "member", self.ids["lee"]: "member"})

        # Marketplace is for all four: Jonas and Lee write, Mia reads.
        page.goto(f"/projects/{market}")
        self.tap(page.locator(".top__audience"))
        for key, read_only in (("jonas", False), ("mia", True), ("lee", False)):
            self.give_access(page, key, read_only)
        grants = {grant["principal"]["id"]: grant["role"] for grant in self.api("ada", "GET", f"/api/v1/projects/{market}/grants", status=200)}
        self.assertEqual(grants, {self.ids["jonas"]: "contributor", self.ids["mia"]: "viewer", self.ids["lee"]: "contributor"})
        self.api("lee", "POST", f"/api/v1/projects/{market}/conversations", {"body": MARKET_NOTE, "clientMessageId": str(uuid.uuid4())}, status=201)
        s.update(market=market, workspace=workspace)

        # A private conversation with Jonas, independent of any project.
        page.goto("/")
        self.go_to_place(page, "Messages")
        expect(page.get_by_role("heading", name="No direct messages yet")).to_be_visible()
        self.tap(page.locator(".pane-scroll").get_by_role("link", name="New message"))
        expect(page.get_by_role("heading", level=1, name="New message")).to_be_visible()
        page.get_by_placeholder("Find people by name or email").fill("jonas")
        self.tap(page.get_by_role("list", name="People").get_by_text(NAMES["jonas"]))
        self.tap(page.get_by_role("button", name="Message Jonas"))
        expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
        dm = page.url.rsplit("/", 1)[-1]
        composer = page.get_by_label(re.compile(r"^Message "))
        expect(page.locator(".composer__audience")).to_contain_text("Only you and Jonas")
        for who, body in DM:
            if who == "ada":
                composer.fill(body)
                self.send_message(page, composer, page.get_by_role("button", name="Send message"))
            else:
                self.api("jonas", "POST", f"/api/v1/dms/{dm}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, status=201)
            expect(page.locator(".dm-msg__body", has_text=body)).to_be_visible(timeout=15000)
        stored = self.api("ada", "GET", f"/api/v1/dms/{dm}", status=200)
        self.assertEqual([m["body"] for m in stored["messages"]], [body for _, body in DM])
        self.assertEqual(sorted(stored["audience"]["participantIds"]), sorted([self.ids["ada"], self.ids["jonas"]]))
        message_ids = [m["id"] for m in stored["messages"]]
        s.update(dm=dm)

        # Only the camera, sensor and privacy messages seed a shared sketch; no project yet.
        self.tap(page.get_by_role("button", name="Select", exact=True))
        bar = page.get_by_role("region", name="Selected messages")
        expect(bar).to_contain_text("No project is created.")
        for index in (1, 2, 3):
            self.tap(page.locator(f'.dm-msg[data-message-id="{message_ids[index]}"] .dm-msg__body'))
        expect(bar.get_by_role("status")).to_have_text("3 messages selected")
        self.tap(bar.get_by_role("button", name="Start sketch from these messages"))
        page.wait_for_url(re.compile(rf"/dm/{dm}/sketches/[0-9a-f-]{{36}}$"))
        dm_sketch = page.url.rsplit("/", 1)[-1]
        expect(page.get_by_label("Sketch name")).to_be_focused()
        page.keyboard.press("Escape")
        expect(page.locator(".sk-status")).to_contain_text("Started from 3 messages · only you and Jonas can see it")
        sketch = self.sketch("ada", dm_sketch)
        self.assertEqual((sketch["scope"], sketch["dmId"], sketch["projectId"]), ("dm", dm, None))
        self.assertEqual([t["source"]["dmMessageId"] for t in sketch["thoughts"]], message_ids[1:4])
        s.update(dm_sketch=dm_sketch)

        # Ada thinks further on the sketch: low light is the camera's weak spot.
        if self.phone:
            page.get_by_role("radio", name="List", exact=True).tap()
        camera = self.thought_id(sketch, CAMERA)
        self.add_connected_thought(page, dm_sketch, camera, LOW_LIGHT)
        self.shot(page, "1-dm-sketch")

        # She makes a separate two-person project from the sketch; the preview names the content and readers.
        self.tap(page.get_by_role("button", name="Make it a project…"))
        panel = self.details(page)
        expect(panel.get_by_role("heading", name="Make a project from this sketch")).to_be_visible()
        panel.get_by_role("checkbox", name="Also give Jonas access").check()
        expect(panel.locator(".promote__aud b")).to_have_text("Jonas and you — only you two")
        expect(panel).to_contain_text("4 thoughts")
        expect(panel).to_contain_text("Nothing is synced to the project.")
        preview = self.api("ada", "GET", f"/api/v1/sketches/{dm_sketch}/promotion?target=new&participants=grant", status=200)
        self.assertEqual({person["id"] for person in preview["audience"]}, {self.ids["ada"], self.ids["jonas"]})
        self.assertEqual(preview["staysInDm"]["messages"], 2, "the first and the unrelated message stay in the DM")
        panel.get_by_label("Name").fill(LAMP)
        self.shot(page, "1-promote")
        self.tap(panel.get_by_role("button", name="Create project"))
        page.wait_for_url(re.compile(r"/projects/[0-9a-f-]{36}/map/[0-9a-f-]{36}$"))
        lamp, copy = re.findall(r"[0-9a-f-]{36}", page.url.split(ORIGIN, 1)[-1])
        project = self.api("ada", "GET", f"/api/v1/projects/{lamp}", status=200)
        self.assertEqual((project["name"], project["visibility"]), (LAMP, "restricted"))
        people = self.api("ada", "GET", f"/api/v1/projects/{lamp}/people", status=200)
        self.assertEqual({person["id"] for person in people}, {self.ids["ada"], self.ids["jonas"]})
        copied = self.sketch("ada", copy)
        self.assertEqual(sorted(t["text"] for t in copied["thoughts"]), sorted([CAMERA, SENSOR, PRIVACY, LOW_LIGHT]))
        self.assertNotIn(dm, json.dumps(copied), "the project copy does not point back into the DM")
        self.assertNotIn(LEFT_OUT, json.dumps(copied))
        s.update(lamp=lamp, map=copy)

        # Jonas signs in, finds the new project and writes there; the composer names its audience, no checkbox.
        jonas = self.page(None)
        jonas.goto("/sign-in")
        jonas.get_by_label("Email").fill(self.emails["jonas"])
        jonas.get_by_label("Password").fill(PASSWORD)
        self.tap(jonas.get_by_role("button", name="Sign in"))
        expect(jonas.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.keep("jonas", jonas)
        self.tap(self.project_list(jonas).get_by_role("link", name=re.compile(f"^{LAMP}")))
        expect(jonas.get_by_role("heading", level=1, name=LAMP)).to_be_visible()
        expect(jonas.locator(".composer__audience").first).to_contain_text("Ada and you")
        expect(jonas.locator(".composer").get_by_role("checkbox")).to_have_count(0)
        writing = jonas.get_by_label("Write a message", exact=True)
        writing.fill(JONAS_ROOT)
        self.tap(jonas.get_by_role("button", name="Send message", exact=True))
        expect(writing).to_have_value("")
        root = self.root_of("jonas", lamp, JONAS_ROOT)
        s.update(c1=root["conversationId"], m1=root["message"]["id"])

        # Ada replies in the thread; the reply inherits the project audience without a checkbox.
        page = self.page("ada")
        page.goto(f"/projects/{lamp}")
        self.tap(page.locator(f"#message-{s['m1']}").get_by_role("button", name="Reply", exact=True))
        thread = page.get_by_role("complementary", name="Replies")
        expect(thread.locator(".thread__root")).to_contain_text(JONAS_ROOT)
        expect(thread.locator(".composer__audience")).to_contain_text("Jonas and you")
        expect(thread.get_by_role("checkbox")).to_have_count(0)
        reply = page.locator("#thread-composer")
        self.tap(reply)
        reply.fill(ADA_REPLY)
        self.tap(thread.get_by_role("button", name="Send reply"))
        expect(thread.locator(".project-convo__message", has_text=ADA_REPLY)).to_be_visible()
        self.no_sideways_scroll(page)
        self.shot(page, "1-reply-thread")
        saved = self.api("jonas", "GET", f"/api/v1/conversations/{s['c1']}", status=200)
        self.assertEqual([(m["body"], m["authorId"]) for m in saved["messages"]], [(JONAS_ROOT, self.ids["jonas"]), (ADA_REPLY, self.ids["ada"])])

        # Mia and Lee share Marketplace with them, and see nothing of the DM, the sketch or the new project.
        for key in ("mia", "lee"):
            for path in (f"/api/v1/projects/{lamp}", f"/api/v1/conversations/{s['c1']}", f"/api/v1/dms/{dm}",
                         f"/api/v1/sketches/{dm_sketch}", f"/api/v1/sketches/{copy}"):
                self.assertEqual(self.status(key, path), 404, f"{key} {path}")
            found = self.api(key, "GET", "/api/v1/search?q=gestures", status=200)
            self.assertEqual(found["items"], [], f"{key} finds nothing about the lamp")
            other = self.page(key)
            other.goto("/")
            projects = self.project_list(other)
            expect(projects.get_by_role("link", name=re.compile(f"^{MARKET}"))).to_be_visible()
            expect(projects.get_by_text(LAMP)).to_have_count(0)
            other.goto("/search?q=gestures")
            expect(other.get_by_role("heading", name="Nothing matches “gestures”")).to_be_visible()
            self.assertNotIn(LAMP, other.content())

    # ---------------------------------------------------------------- scenario 2: thinking and execution

    def test_2_thinking_and_execution(self) -> None:
        self.need("lamp", "map", "m1")
        s, lamp = self.s, self.s["lamp"]
        sketch = self.sketch("ada", s["map"])
        thoughts = {text: self.thought_id(sketch, text) for text in (CAMERA, SENSOR, PRIVACY, LOW_LIGHT)}
        s["thoughts"] = thoughts

        # A person proposes the first rule from Jonas's message and accepts it.
        page = self.page("ada")
        page.goto(f"/projects/{lamp}")
        message = page.locator(f"#message-{s['m1']}")
        if self.phone:
            message.get_by_role("button", name="Make from this message").tap()
        else:
            message.hover()
        self.tap(message.get_by_role("button", name="Decision", exact=True))
        panel = self.details(page)
        expect(panel.get_by_role("heading", name="Propose a decision")).to_be_visible()
        panel.get_by_label("Decision").fill(D1)
        panel.get_by_label("Why").fill(WHY1)
        self.tap(panel.get_by_role("button", name="Propose decision", exact=True))
        expect(panel.locator(".wd-eyebrow")).to_contain_text("Proposed decision")
        self.tap(panel.get_by_role("button", name="Accept decision"))
        expect(panel.locator(".wd-eyebrow")).to_contain_text("Current rule")
        d1 = self.decision_titled("ada", D1)
        self.assertEqual((d1["status"], d1["proposedBy"]["id"], d1["decidedBy"]["id"]), ("accepted", self.ids["ada"], self.ids["ada"]))
        s["d1"] = d1["id"]
        self.close_details(page)

        # The camera plan becomes committed work for Jonas.
        camera_task = self.api("ada", "POST", f"/api/v1/projects/{lamp}/work", {"title": CAMERA_TASK, "owner": {"kind": "human", "id": self.ids["jonas"]}}, status=201)
        s["camera_task"] = camera_task["id"]

        # One experiment from several thoughts: camera, low light and privacy.
        self.open_map(page)
        if self.phone:
            # Touch selects one thought at a time (test_2a); the other two are linked through the API below.
            self.tap(self.thought(page, thoughts[CAMERA]))
        else:
            self.thought(page, thoughts[CAMERA]).click()
            for text in (LOW_LIGHT, PRIVACY):
                self.thought(page, thoughts[text]).click(modifiers=["Shift"])
            expect(page.locator(".sk-node[aria-pressed='true']")).to_have_count(3)
        create = page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Create work from selected thoughts")
        with page.expect_response(lambda r: r.request.method == "POST" and urllib.parse.urlsplit(r.url).path == f"/api/v1/projects/{lamp}/work") as saved:
            self.tap(create)
        self.assertEqual(saved.value.status, 201)
        experiment = saved.value.json()
        s["experiment"] = experiment["id"]
        expect(page.locator(f".wd[data-detail-kind='work'][data-detail-id='{experiment['id']}']")).to_be_visible()
        self.assertTrue(page.url.split("?")[0].endswith(f"/map/{s['map']}"), "creating work keeps the map open")
        if self.phone:
            for text in (LOW_LIGHT, PRIVACY):
                self.api("ada", "POST", f"/api/v1/projects/{lamp}/links", {"from": {"type": "work", "id": experiment["id"]}, "to": {"type": "thought", "id": thoughts[text]}}, status=201)
        stored = self.api("ada", "GET", f"/api/v1/work/{experiment['id']}", status=200)
        linked = {link["to"]["id"] for link in stored["links"] if link["to"]["type"] == "thought"}
        self.assertEqual(linked, {thoughts[CAMERA], thoughts[LOW_LIGHT], thoughts[PRIVACY]}, "one experiment investigates three thoughts")
        self.assertEqual(len(self.sketch("ada", s["map"])["thoughts"]), 4, "the thoughts stay on the map")
        s["experiment_title"] = stored["title"]
        self.close_details(page)

        # Jonas posts the low-light run with the readings attached.
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{lamp}")
        jonas.get_by_label("Write a message", exact=True).fill(RUN_ROOT)
        with jonas.expect_file_chooser() as chooser:
            self.tap(jonas.get_by_role("button", name="Attach files", exact=True))
        chooser.value.set_files([{"name": "lux-readings.csv", "mimeType": "text/csv", "buffer": CSV}])
        expect(jonas.get_by_text("Ready, private", exact=False)).to_have_count(1)
        self.tap(jonas.get_by_role("button", name="Send message", exact=True))
        expect(jonas.get_by_label("Write a message", exact=True)).to_have_value("")
        run = self.root_of("jonas", lamp, RUN_ROOT)
        self.assertEqual([item["name"] for item in run["message"]["files"]], ["lux-readings.csv"])
        file_id = run["message"]["files"][0]["id"]
        link = jonas.locator(f"#message-{run['message']['id']}").get_by_role("list", name="1 attached file").get_by_role("link", name="lux-readings.csv")
        expect(link).to_have_attribute("href", f"/api/v1/files/{file_id}")
        self.assertEqual(jonas.request.get(f"/api/v1/files/{file_id}").body(), CSV)
        self.shot(jonas, "2-attachment")
        self.api("ada", "POST", f"/api/v1/conversations/{run['conversationId']}/messages", {"body": RUN_REPLY, "clientMessageId": str(uuid.uuid4())}, status=201)
        s.update(file=file_id, c2=run["conversationId"])

        # A negative result finishes the experiment.
        page.goto(f"/projects/{lamp}/tasks?open=work:{experiment['id']}")
        card = page.locator(f".wd[data-detail-kind='work'][data-detail-id='{experiment['id']}']")
        expect(card.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "ready")
        self.tap(card.get_by_role("button", name="Attach a result", exact=True))
        form = page.locator("#details .wd")
        nav = form.get_by_role("navigation", name="Result work choices")
        expect(nav).to_have_attribute("aria-busy", "false")
        form.get_by_label("Finding", exact=True).fill(RESULT)
        form.get_by_label("Evidence", exact=True).fill(EVIDENCE)
        expect(form.get_by_label("For work", exact=True)).to_have_value(experiment["id"])
        form.get_by_role("radio", name="Negative", exact=True).check()
        form.get_by_role("checkbox", name=re.compile("This finishes")).check()
        self.tap(form.get_by_role("button", name="Attach result", exact=True))
        expect(page.locator('.wd[data-detail-kind="result"]')).to_contain_text(RESULT)
        results = self.api("ada", "GET", f"/api/v1/projects/{lamp}/results?limit=100", status=200)["items"]
        result = next(item for item in results if item["title"] == RESULT)
        self.assertEqual(result["finding"], "negative")
        self.assertEqual(self.api("ada", "GET", f"/api/v1/work/{experiment['id']}", status=200)["status"], "done", "a negative finding finished the experiment")
        s["result"] = result["id"]
        self.close_details(page)

        # The same task thread from the task and from the map.
        page.goto(f"/projects/{lamp}/tasks?open=work:{experiment['id']}")
        discussion = page.get_by_role("region", name="Discussion")
        expect(discussion).to_contain_text(RESULT)
        self.tap(discussion.get_by_role("link", name=re.compile("Open in Conversation")))
        thread = page.get_by_role("complementary", name="Replies")
        expect(thread).to_contain_text(RESULT)
        task_thread = self.api("ada", "GET", f"/api/v1/work/{experiment['id']}/discussion", status=200)
        expect(page).to_have_url(re.compile(rf"/conversations/{task_thread['conversationId']}"))
        self.open_map(page)
        badge = (page.locator(f'.sk-outline-list li[data-id="{thoughts[CAMERA]}"] .sk-work').first if self.phone
                 else page.locator(f'.sk-node[data-id="{thoughts[CAMERA]}"] + .sk-work-slot .sk-work'))
        expect(badge).to_contain_text("1 task")
        self.tap(badge)
        chooser_dialog = page.get_by_role("dialog").filter(has_text="linked to this thought")
        task_link = chooser_dialog.locator(f'a[data-work-id="{experiment["id"]}"]')
        expect(task_link).to_contain_text("Done")
        self.tap(task_link)
        expect(page.locator(".details__title")).to_have_text(stored["title"])
        self.close_details(page)

        # The sensor alternative joins the map; the camera reasoning stays.
        self.open_map(page)
        s["variant_b"] = self.add_connected_thought(page, s["map"], thoughts[SENSOR], VARIANT_B)
        after = self.sketch("ada", s["map"])
        self.assertEqual(sorted(t["text"] for t in after["thoughts"]), sorted([CAMERA, SENSOR, PRIVACY, LOW_LIGHT, VARIANT_B]))
        self.shot(page, "2-map")

        # The wiki page cites the result and the experiment.
        page.goto(f"/projects/{lamp}/docs")
        expect(page.get_by_role("heading", name="No pages yet")).to_be_visible()
        self.tap(page.get_by_role("link", name="New page"))
        page.get_by_label("Title").fill(DOC_TITLE)
        text = page.get_by_label("Text (Markdown)")
        text.fill(DOC_BODY)
        self.link_in_doc(page, text, "result", result["id"], RESULT)
        text.press("Control+End")
        text.press_sequentially(" The experiment: ", delay=20)
        self.link_in_doc(page, text, "work", experiment["id"], stored["title"])
        self.tap(page.get_by_role("radio", name="Published"))
        page.get_by_label("What changed").fill("First notes after the low-light run")
        if self.phone:
            page.get_by_role("button", name="Create page").tap()
        else:
            text.press("Control+s")
        expect(page.get_by_role("heading", level=2, name=DOC_TITLE)).to_be_visible()
        docs = self.api("ada", "GET", f"/api/v1/projects/{lamp}/docs?limit=100", status=200)["items"]
        doc = self.api("ada", "GET", f"/api/v1/docs/{docs[0]['id']}", status=200)
        self.assertEqual((doc["title"], doc["version"], doc["state"]), (DOC_TITLE, 1, "published"))
        mentions = {(link["to"]["type"], link["to"]["id"]) for link in doc["links"] if link["role"] == "mentions"}
        self.assertEqual(mentions, {("result", result["id"]), ("work", experiment["id"])})
        s["doc"] = doc["id"]
        s["doc_v1"] = doc["body"]

        # Task first, map later: Jonas adds the order in Tasks and links it to Variant B from its Details (test_2b).
        jonas.goto(f"/projects/{lamp}/tasks?view=list")
        jonas.get_by_label("New task", exact=True).fill(ORDER_TASK)
        self.tap(jonas.get_by_role("button", name="Add task", exact=True))
        expect(self.details(jonas).get_by_role("heading", name=ORDER_TASK)).to_be_visible()
        order = next(item for item in self.work_items("jonas") if item["title"] == ORDER_TASK)
        s["order_task"] = order["id"]

        # Removing a placement from the map keeps its task.
        market = self.api("jonas", "POST", f"/api/v1/sketches/{s['map']}/thoughts", {"text": MARKET_THOUGHT, "x": 40, "y": 520}, status=201)["thought"]["id"]
        market_task = self.api("jonas", "POST", f"/api/v1/projects/{lamp}/work", {"title": MARKET_TASK, "sources": [{"type": "thought", "id": market}]}, status=201)
        self.open_map(page)
        self.tap(self.thought(page, market))
        self.tap(page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Remove from sketch"))
        self.wait_for("the placement to go", lambda: all(t["id"] != market for t in self.sketch("ada", s["map"])["thoughts"]))
        kept = self.api("ada", "GET", f"/api/v1/work/{market_task['id']}", status=200)
        self.assertEqual((kept["title"], kept["status"]), (MARKET_TASK, "open"), "the task outlives its map placement")

        # Tasks shows the committed work only: four tasks, not the six thoughts.
        page.goto(f"/projects/{lamp}/tasks?view=list")
        rows = page.locator('.ws-tasks [data-work-kind="work"][data-work-id]')
        expect(rows).to_have_count(4)
        for title in (CAMERA_TASK, ORDER_TASK, MARKET_TASK, stored["title"]):
            expect(page.locator(".ws-tasks")).to_contain_text(title[:60])
        expect(page.locator(".ws-tasks")).not_to_contain_text(VARIANT_B)
        self.assertEqual(len(self.work_items("ada")), 4)
        self.shot(page, "2-tasks")

        # Ada has the context now; the next scenario happens while she is away.
        home = self.api("ada", "GET", "/api/v1/return?place=home", status=200)
        page.goto("/")
        if home["items"]:
            region = page.get_by_role("region", name=re.compile("^Since you left"))
            self.tap(region.get_by_role("button", name="I have the context"))
            expect(page.get_by_role("status").filter(has_text="You’re caught up.")).to_be_visible()
        self.wait_for("Home's return point", lambda: not self.api("ada", "GET", "/api/v1/return?place=home", status=200)["items"])
        s["thinking_done"] = True

    @unittest.expectedFailure
    def test_2a_touch_selects_several_thoughts(self) -> None:
        """#44 scenario 2 (multi-selection with click/tap alternatives): on a touch phone, tapping a second thought
        should add it to the selection so one experiment can come from several thoughts. Today a tap replaces the
        selection (SketchView pick(): additive only with Shift/Meta/Ctrl, Space on a focused thought); there is no
        touch control. Draft issue: "Select several thoughts on a touch phone" (see the R-9 report)."""
        if not self.phone:
            self.skipTest("touch selection is a phone check")
        self.need("map", "thoughts")
        page = self.page("ada")
        self.open_map(page)
        thoughts = self.s["thoughts"]
        self.tap(self.thought(page, thoughts[CAMERA]))
        self.tap(self.thought(page, thoughts[LOW_LIGHT]))
        expect(page.locator('.sk-li-t[aria-pressed="true"]')).to_have_count(2, timeout=3000)

    def test_2b_an_existing_task_links_to_a_thought_in_the_browser(self) -> None:
        """#44 scenario 2, "repeat with task creation preceding the map link" (#289): a task made first in Tasks is
        linked to a map thought from its Details. A phone taps the controls; a computer uses the keyboard alone, and
        Escape closes the picker without a change. The link is stored once, and the map counts the task on that
        thought and lists it in the chooser for its other editors too."""
        self.need("order_task", "variant_b", "map")
        s, lamp = self.s, self.s["lamp"]
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{lamp}/tasks?open=work:{s['order_task']}")
        card = jonas.locator(f".wd[data-detail-kind='work'][data-detail-id='{s['order_task']}']")
        expect(card).to_be_visible()
        section = card.get_by_role("region", name="Linked thoughts")
        expect(section.get_by_text("Not linked to a thought yet.")).to_be_visible()
        control = section.get_by_role("button", name="Link to a thought")
        picker = card.get_by_role("group", name=re.compile("^Thoughts to link to "))
        if self.phone:
            self.tap(control)
        else:
            control.focus()
            jonas.keyboard.press("Enter")
            expect(picker).to_be_visible()
            jonas.keyboard.press("Escape")
            expect(picker).to_have_count(0)
            expect(control).to_be_focused()
            jonas.keyboard.press("Enter")
        expect(picker).to_be_visible()
        picker.get_by_label("Map", exact=True).select_option(s["map"])
        choice = picker.get_by_role("button", name=VARIANT_B)
        if self.phone:
            self.tap(choice)
        else:
            choice.focus()
            jonas.keyboard.press("Enter")
        expect(section.get_by_role("status")).to_contain_text("Linked")
        expect(picker).to_have_count(0)
        expect(section.get_by_role("link", name=VARIANT_B)).to_be_visible()
        self.shot(jonas, "2b-linked-in-details")

        order = self.api("jonas", "GET", f"/api/v1/work/{s['order_task']}", status=200)
        thought_links = [(link["role"], link["to"]["id"]) for link in order["links"] if link["to"]["type"] == "thought"]
        self.assertEqual(thought_links, [("related", s["variant_b"])], "one stored link, made from the task's Details")

        ada = self.page("ada")
        self.open_map(ada)
        badge = (ada.locator(f'.sk-outline-list li[data-id="{s["variant_b"]}"] .sk-work').first if self.phone
                 else ada.locator(f'.sk-node[data-id="{s["variant_b"]}"] + .sk-work-slot .sk-work'))
        expect(badge).to_contain_text("1 task")
        self.tap(badge)
        expect(ada.locator(".sk-tasks__list")).to_contain_text(ORDER_TASK[:60])
        self.shot(ada, "2b-map-count")

    # ---------------------------------------------------------------- scenario 3: agent proposes, a person pivots

    def test_3_agent_proposes_a_pivot_and_a_person_accepts(self) -> None:
        self.need("thinking_done", "d1", "camera_task", "order_task")
        s, lamp = self.s, self.s["lamp"]
        # Ada's own external agent, selected for the lamp project only, connected through real OAuth consent.
        agent = self.api("ada", "POST", f"/api/v1/workspaces/{s['workspace']}/agents", {"name": "Ada's Claude Code", "owner": "self"}, status=201)
        self.api("ada", "POST", f"/api/v1/projects/{lamp}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        connection = self.api("ada", "POST", "/api/v1/agent-connections", {"agentId": agent["id"], "name": "Desk laptop", "clientDesignation": "claude_code",
                                                                            "selectedProjectIds": [lamp], "scopes": ACTION_SCOPES}, status=201)
        mcp = McpAgent(self, "ada", connection["id"], lamp)
        s["agent"], s["agent_id"] = mcp, agent["id"]

        # Before any standing grant the proposal is refused.
        refused = mcp.rpc("tools/call", {"name": "flux_propose_decision", "arguments": {
            "projectId": lamp, "runtimeSessionId": mcp.runtime, "grantId": str(uuid.uuid4()), "clientCommandId": str(uuid.uuid4()),
            "peerRequestClass": "plan", "sources": [], "decision": {"title": D2}}})
        self.assertTrue(refused.get("error") or (refused.get("result") or {}).get("isError"), "no grant, no proposal")

        # Ada grants "Propose decisions" on the Connect page.
        page = self.page("ada")
        page.goto("/connect-agent")
        expect(page.get_by_role("heading", level=1, name="Your agent connections")).to_be_visible()
        grants = page.get_by_role("region", name="Standing grants for Desk laptop")
        self.tap(grants.get_by_role("button", name="Add a grant"))
        form = grants.get_by_role("form", name="Add a grant to Desk laptop")
        form.get_by_label("Acts as", exact=True).select_option(label="Planning")
        form.get_by_role("checkbox", name="Propose decisions").check()
        form.get_by_label("Uses for each change").fill("2")
        self.shot(page, "3-grant")
        self.tap(form.get_by_role("button", name="Grant", exact=True))
        expect(grants.get_by_role("listitem").filter(has_text="Propose decisions")).to_contain_text("2 of 2 uses left")
        live = [g for g in self.api("ada", "GET", f"/api/v1/agent-connections/{connection['id']}/action-grants?limit=50", status=200)["items"] if not g["revokedAt"]]
        self.assertEqual([(g["operation"], g["peerRequestClass"], g["projectId"], g["maximumUses"]) for g in live], [("decision.propose", "plan", lamp, 2)])

        # The agent proposes the pivot; it stays a proposal and the camera rule stays current.
        proposed = mcp.tool("flux_propose_decision", {"projectId": lamp, "runtimeSessionId": mcp.runtime, "grantId": live[0]["id"],
                                                      "clientCommandId": str(uuid.uuid4()), "peerRequestClass": "plan", "sources": [],
                                                      "decision": {"title": D2, "rationale": WHY2, "supersedes": s["d1"], "affects": [s["camera_task"]]}})
        d2 = self.api("ada", "GET", f"/api/v1/decisions/{proposed['decisionId']}", status=200)
        self.assertEqual((d2["status"], d2["proposedBy"]["kind"], d2["proposedBy"]["id"], d2["decidedBy"]), ("proposed", "agent", agent["id"], None))
        self.assertEqual(self.api("ada", "GET", f"/api/v1/decisions/{s['d1']}", status=200)["status"], "accepted")
        names = mcp.tool_names()
        self.assertEqual([name for name in names if re.search("accept|approve|decide", name)], [], "no MCP tool accepts a decision")
        s["d2"] = d2["id"]

        # Jonas owns the affected work: the proposal reaches his inbox, and he accepts it as a pivot.
        title = f"Decision to review: {D2}"
        self.wait_for("Jonas's review notification", lambda: title in self.inbox_titles("jonas"))
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{lamp}")
        self.go_to_place(jonas, "Inbox")
        expect(jonas.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
        self.tap(jonas.locator(".inbox__row", has_text=title).get_by_role("link"))
        expect(jonas).to_have_url(re.compile(rf"/projects/{lamp}/tasks"))
        panel = self.details(jonas)
        expect(panel.get_by_role("heading", name="Accept as a pivot")).to_be_visible()
        expect(panel.locator(".agent-tag").first).to_be_visible()
        panel.get_by_role("radiogroup", name=CAMERA_TASK).get_by_label("Park").check()
        panel.get_by_role("radiogroup", name=ORDER_TASK).get_by_label("Still applies").check()
        accept = panel.get_by_role("button", name="Accept and pivot")
        accept.scroll_into_view_if_needed()
        self.shot(jonas, "3-pivot")
        self.tap(accept)
        expect(panel.locator(".wd-eyebrow")).to_contain_text("Current rule")
        expect(panel.get_by_role("region", name="At this pivot")).to_contain_text("parked")
        accepted = self.api("jonas", "GET", f"/api/v1/decisions/{s['d2']}", status=200)
        self.assertEqual((accepted["status"], accepted["decidedBy"]["id"], accepted["proposedBy"]["kind"]), ("accepted", self.ids["jonas"], "agent"))
        earlier = self.api("jonas", "GET", f"/api/v1/decisions/{s['d1']}", status=200)
        self.assertEqual((earlier["status"], earlier["decidedBy"]["id"], earlier["rationale"]), ("superseded", self.ids["ada"], WHY1), "the old rule keeps its history")
        parked = self.api("jonas", "GET", f"/api/v1/work/{s['camera_task']}", status=200)
        self.assertEqual(parked["parked"]["decisionId"], s["d2"])
        self.assertNotEqual(parked["status"], "done", "parked work is not called done")
        self.assertTrue(any(link["role"] == "still_applies" and link["to"]["id"] == s["order_task"] for link in accepted["links"]))
        self.assertEqual(self.api("jonas", "GET", f"/api/v1/results/{s['result']}", status=200)["finding"], "negative", "the result survives the pivot")
        self.close_details(jonas)

        # Jonas asks Ada to pick up the sensor work while she is away.
        jonas.goto(f"/projects/{lamp}")
        ask = jonas.get_by_label("Write a message", exact=True)
        ask.fill(QUESTION)
        self.tap(jonas.get_by_role("button", name="Send message", exact=True))
        expect(ask).to_have_value("")
        s["question"] = self.root_of("jonas", lamp, QUESTION)["message"]["id"]
        s["pivoted"] = True

    # ---------------------------------------------------------------- scenario 4: return after the pivot, no AI

    def test_4_return_after_the_pivot_without_ai(self) -> None:
        self.need("pivoted")
        s, lamp = self.s, self.s["lamp"]
        page = self.page("ada")
        page.goto("/")
        region = page.get_by_role("region", name=re.compile("^Since you left"))
        expect(region).to_be_visible()
        expect(region.get_by_role("link", name=re.compile(f"Current rule changed: {re.escape(D2)}"))).to_contain_text(f"Previously: {D1}")
        expect(region.locator(".since__next")).to_contain_text("Answer Jonas's question")
        expect(page.get_by_role("button", name=re.compile("Mark all", re.I))).to_have_count(0)
        # Ada has no AI of her own: the note composer's spark offers to connect one.
        expect(page.locator(".composer__ask")).to_have_accessible_name("Connect your AI")
        self.no_sideways_scroll(page)
        self.shot(page, "4-home-return")

        # In the project, "What matters" works without AI.
        page.goto(f"/projects/{lamp}")
        self.tap(page.get_by_role("button", name=re.compile("^What matters")))
        recap = page.locator("#details")
        expect(recap.get_by_role("heading", name="What matters")).to_be_visible()
        self.tap(recap.get_by_role("button", name="Summarize"))
        expect(recap.locator("section[aria-labelledby=wm-digest]")).to_contain_text("No AI")
        self.shot(page, "4-what-matters")
        self.tap(recap.get_by_role("link", name=re.compile(f"Current rule changed: {re.escape(D2)}")))
        panel = self.details(page)
        expect(panel.get_by_role("heading", name=D2)).to_be_visible()
        pivot = panel.get_by_role("region", name="At this pivot")
        expect(pivot).to_contain_text(CAMERA_TASK)
        expect(pivot).to_contain_text(ORDER_TASK)
        self.close_details(page)

        # Results, the earlier rule and the still-useful work remain where work is listed.
        page.goto(f"/projects/{lamp}/tasks?view=list")
        expect(page.get_by_role("region", name=re.compile("^Results"))).to_contain_text(RESULT)
        expect(page.get_by_role("region", name=re.compile("^Parked by a pivot"))).to_contain_text(CAMERA_TASK)
        expect(page.get_by_role("region", name=re.compile("^Decisions"))).to_contain_text(D1)
        expect(page.get_by_role("region", name=re.compile("^Open"))).to_contain_text(ORDER_TASK)
        summary = self.api("ada", "GET", f"/api/v1/return?place=project&id={lamp}", status=200)
        self.assertIsNotNone(summary["nextStep"], "a direct next action")
        self.assertTrue(any(item["kind"] == "decision" for item in summary["items"]))

    def test_4a_the_return_view_names_the_work_the_pivot_parked(self) -> None:
        """#44 scenario 3: the returning person sees that the pivot parked the camera work, on Home and in the
        project summary, even though the task's own last event is before their return point (#290, fixed in #293)."""
        self.need("pivoted")
        page = self.page("ada")
        page.goto("/")
        region = page.get_by_role("region", name=re.compile("^Since you left"))
        expect(region).to_be_visible()
        expect(region.get_by_role("link", name=re.compile(f"Current rule changed: {re.escape(D2)}"))).to_be_visible()
        items = self.api("ada", "GET", f"/api/v1/return?place=project&id={self.s['lamp']}", status=200)["items"]
        self.assertIn(f"Parked: {CAMERA_TASK}", [item["text"] for item in items], "the return summary names the parked work")
        expect(region.get_by_role("link", name=re.compile(f"^Parked: {re.escape(CAMERA_TASK)}"))).to_be_visible(timeout=3000)

    # ---------------------------------------------------------------- inbox, search and the wiki

    def test_5_inbox_search_and_the_wiki_find_the_work(self) -> None:
        self.need("pivoted", "doc", "result")
        s, lamp = self.s, self.s["lamp"]
        # Inbox: Ada has Jonas's DM and the agent's proposal for review; Jonas has the reply and his task.
        expected = {"ada": ["Jonas Berg sent you a message", f"Decision to review: {D2}", f"Jonas Berg asked you in {LAMP}"],
                    "jonas": ["Ada Kowalska replied in", f"Ada Kowalska assigned you “{CAMERA_TASK}”"]}
        for who, titles in expected.items():
            self.wait_for(f"{who}'s notifications", lambda who=who, titles=titles: all(any(t.startswith(title) for t in self.inbox_titles(who)) for title in titles))
        page = self.page("ada")
        page.goto("/")
        self.go_to_place(page, "Inbox")
        expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
        for title in expected["ada"]:
            expect(page.locator(".inbox__row", has_text=title).first).to_be_visible()
        self.shot(page, "5-inbox")
        self.tap(page.locator(".inbox__row", has_text="Jonas Berg sent you a message").first.get_by_role("link"))
        expect(page).to_have_url(re.compile(rf"/dm/{s['dm']}#message-"))

        # Search: Jump to, then the full results, find the run, the result, the page and the map.
        page.goto(f"/projects/{lamp}")
        if self.phone:
            page.get_by_role("button", name="Open navigation").tap()
            page.get_by_role("dialog", name="Flux").get_by_role("button", name="Search", exact=True).tap()
        else:
            expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
            page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Jump to")
        dialog.get_by_role("combobox", name="Jump to").fill("lux")
        expect(dialog.get_by_role("listbox", name="Results")).to_contain_text(RESULT)
        self.tap(dialog.get_by_role("option", name=re.compile("See all results")))
        expect(page).to_have_url(re.compile(r"/search\?q=lux"))
        chips = page.get_by_role("group", name="Kind of result")
        for kind in ("Messages", "Docs", "Results", "Sketches"):
            expect(chips.get_by_role("button", name=re.compile(f"^{kind}"))).to_be_visible()
        self.shot(page, "5-search")
        kinds = lambda q: {item["kind"] for item in self.api("ada", "GET", f"/api/v1/search?q={urllib.parse.quote(q)}&limit=50", status=200)["items"]}  # noqa: E731
        self.assertTrue({"message", "result", "doc", "thought"} <= kinds("lux"), kinds("lux"))
        self.assertTrue({"work", "thought"} <= kinds("VL53L1X"), kinds("VL53L1X"))
        self.assertIn("dm_message", kinds("wave of the hand"))
        self.assertIn("decision", kinds("ToF distance sensor"))

        # The wiki page gets a second version citing the new rule; version 1 stays as written.
        page.goto(f"/projects/{lamp}/docs/{s['doc']}")
        expect(page.get_by_role("heading", level=2, name=DOC_TITLE)).to_be_visible()
        self.tap(page.get_by_role("link", name="Edit"))
        text = page.get_by_label("Text (Markdown)")
        text.press("Control+End")
        text.press_sequentially("\n\nAfter the pivot: ", delay=20)
        self.link_in_doc(page, text, "decision", s["d2"], D2)
        page.get_by_label("What changed").fill("The rule changed to the ToF sensor")
        self.tap(page.get_by_role("button", name="Save version"))
        expect(page.get_by_role("heading", level=2, name=DOC_TITLE)).to_be_visible()
        expect(page.locator(".doc-head__k")).to_contain_text("Published · version 2")
        doc = self.wait_for("version 2 of the page", lambda: (lambda d: d if d["version"] == 2 else None)(self.api("ada", "GET", f"/api/v1/docs/{s['doc']}", status=200)))
        self.assertTrue(any(link["role"] == "mentions" and link["to"]["id"] == s["d2"] for link in doc["links"]))
        first = self.api("ada", "GET", f"/api/v1/docs/{s['doc']}/versions/1", status=200)
        self.assertEqual(first["body"], s["doc_v1"], "the first version is not rewritten")
        self.api("ada", "GET", f"/api/v1/results/{s['result']}", status=200)
        s["wiki_v2"] = True

    # ---------------------------------------------------------------- export and audience

    def test_6_export_and_audience(self) -> None:
        self.need("pivoted", "doc", "file")
        s, lamp = self.s, self.s["lamp"]
        # Ada keeps a private note; it stays hers.
        page = self.page("ada")
        page.goto("/")
        note = page.get_by_label("Private note", exact=True)
        note.fill(DRAFT)
        if self.phone:
            page.get_by_role("button", name="Save note").tap()
        else:
            note.press("Enter")
        expect(page.get_by_role("region", name="Private drafts").get_by_text(DRAFT)).to_be_visible()
        private = self.api("ada", "GET", "/api/v1/search?q=89+EUR&place=private", status=200)["items"]
        self.assertEqual(len(private), 1, private)
        draft_id = private[0]["id"]

        # Mia may follow the lamp project read-only.
        page.goto(f"/projects/{lamp}")
        self.tap(page.locator(".top__audience"))
        self.give_access(page, "mia", read_only=True)
        self.assertEqual(self.api("mia", "GET", f"/api/v1/projects/{lamp}", status=200)["access"], "viewer")
        d3 = self.api("ada", "POST", f"/api/v1/projects/{lamp}/decisions", {"title": D3}, status=201)

        viewer = self.page("mia")
        viewer.goto(f"/projects/{lamp}")
        expect(viewer.locator(f"#message-{s['m1']}")).to_contain_text(JONAS_ROOT)
        expect(viewer.locator(".project-convo__read-only")).to_be_visible()
        expect(viewer.locator("#project-composer")).to_have_count(0)
        self.shot(viewer, "6-viewer")
        for path in (f"/api/v1/conversations/{s['c1']}", f"/api/v1/docs/{s['doc']}", f"/api/v1/results/{s['result']}", f"/api/v1/files/{s['file']}"):
            self.assertEqual(self.status("mia", path), 200, f"the viewer reads {path}")
        for path in (f"/api/v1/drafts/{draft_id}", f"/api/v1/dms/{s['dm']}", f"/api/v1/sketches/{s['dm_sketch']}"):
            self.assertEqual(self.status("mia", path), 404, f"the viewer cannot open the private {path}")
        self.assertEqual(self.fetch("mia", "POST", f"/api/v1/decisions/{d3['id']}/accept", {"expectedVersion": 1}).status, 403, "a viewer cannot accept")
        self.assertEqual(self.fetch("mia", "POST", f"/api/v1/conversations/{s['c1']}/messages", {"body": "Can I add a note?", "clientMessageId": str(uuid.uuid4())}).status, 403)
        self.assertEqual(self.fetch("mia", "GET", f"/api/v1/projects/{lamp}/export").status, 403, "a viewer cannot export")
        for query in ("89 EUR", "Saturday market"):
            self.assertEqual(self.api("mia", "GET", f"/api/v1/search?q={urllib.parse.quote(query)}", status=200)["items"], [], query)
        self.assertEqual(self.api("ada", "GET", f"/api/v1/decisions/{d3['id']}", status=200)["status"], "proposed")

        # Lee shares only Marketplace: every lamp address is 404 for him.
        for path in (f"/api/v1/projects/{lamp}", f"/api/v1/conversations/{s['c1']}", f"/api/v1/decisions/{s['d2']}", f"/api/v1/results/{s['result']}",
                     f"/api/v1/docs/{s['doc']}", f"/api/v1/files/{s['file']}", f"/api/v1/sketches/{s['map']}", f"/api/v1/work/{s['experiment']}",
                     f"/api/v1/projects/{lamp}/export"):
            self.assertEqual(self.status("lee", path), 404, f"lee {path}")
        self.assertEqual(self.fetch("lee", "POST", f"/api/v1/decisions/{d3['id']}/accept", {"expectedVersion": 1}).status, 404)
        lee_found = json.dumps(self.api("lee", "GET", "/api/v1/search?q=lux", status=200))
        self.assertNotIn(lamp, lee_found)
        self.assertNotIn(RESULT, lee_found)

        # Ada exports the whole project from the wiki.
        page.goto(f"/projects/{lamp}/docs/{s['doc']}")
        self.tap(page.locator(".wiki-bar").get_by_role("button", name="Download"))
        download = page.get_by_role("dialog", name="Download")
        with page.expect_download() as info:
            self.tap(download.get_by_role("button", name=re.compile("^Export the whole project")))
        name, data = info.value.suggested_filename, Path(info.value.path()).read_bytes()
        self.assertRegex(name, rf"^flux-project-{lamp[:8]}-\d{{8}}T\d{{6}}Z\.tar\.gz$")
        root = name.removesuffix(".tar.gz")
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as bundle:
            exported = json.loads(bundle.extractfile(f"{root}/project.json").read())
            attachment = bundle.extractfile(f"{root}/files/{s['file']}").read()
            page_text = bundle.extractfile(f"{root}/docs/{s['doc']}.md").read().decode("utf-8")
        self.assertEqual(attachment, CSV, "the attachment's exact bytes")
        self.assertIn(f"flux:result/{s['result']}", page_text)
        if s.get("wiki_v2"):
            self.assertIn(f"flux:decision/{s['d2']}", page_text)
        bodies = [m["body"] for c in exported["conversations"] for m in c["messages"]]
        for body in (JONAS_ROOT, ADA_REPLY, RUN_ROOT, RUN_REPLY):
            self.assertIn(body, bodies)
        self.assertEqual([f["name"] for f in exported["files"]], ["lux-readings.csv"])
        self.assertEqual(sorted(t["text"] for t in exported["sketches"][0]["thoughts"]), sorted([CAMERA, SENSOR, PRIVACY, LOW_LIGHT, VARIANT_B]))
        work = {w["title"]: w for w in exported["work"]}
        self.assertEqual(work[self.s["experiment_title"]]["status"], "done")
        self.assertEqual(work[CAMERA_TASK]["parked"]["decisionId"], s["d2"])
        decisions = {d["title"]: d for d in exported["decisions"]}
        self.assertEqual((decisions[D1]["status"], decisions[D2]["status"], decisions[D3]["status"]), ("superseded", "accepted", "proposed"))
        self.assertEqual((decisions[D2]["proposedBy"]["kind"], decisions[D2]["decidedBy"]["id"]), ("agent", self.ids["jonas"]))
        self.assertEqual([(r["title"], r["finding"]) for r in exported["results"]], [(RESULT, "negative")])
        self.assertEqual([len(d["versions"]) for d in exported["docs"]], [self.api("ada", "GET", f"/api/v1/docs/{s['doc']}", status=200)["version"]])
        roles = {(link["role"], link["from"]["type"], link["to"]["type"]) for link in exported["links"]}
        for expected in (("source", "work", "thought"), ("still_applies", "decision", "work"), ("mentions", "doc", "result"), ("about", "result", "work")):
            self.assertIn(expected, roles)
        raw = json.dumps(exported)
        for hidden in (LEFT_OUT, DM[0][1], DRAFT, MARKET_NOTE, MARKET, self.emails["ada"], s["dm"]):
            self.assertNotIn(hidden, raw, f"the export leaves out {hidden!r}")
        self.shot(page, "6-export")


class DesktopScenarios(ScenarioJourney, unittest.TestCase):
    phone = False
    label = "desktop-1440"


class PhoneScenarios(ScenarioJourney, unittest.TestCase):
    phone = True
    label = "phone-390"


if __name__ == "__main__":
    unittest.main()
