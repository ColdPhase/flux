"""Browser tests for the agent consent page: one decision, and where access goes (#859, #287, MCP 2026-07-28 security considerations).

Runs with the other tests/ui journeys through scripts/check_ui.sh. Browser sessions cannot register
OAuth clients, so two clients are registered through the token-gated integration fixture (the same
path a UI scenario uses): "Local CLI" returns to 127.0.0.1 on this computer, and a look-alike named
"Claude Code" sends access to collector.example.net. Nora authorizes both from her signed-in browser.
Signing in is one click: the page asks nothing to be chosen, only Allow or Deny, and nothing exists
before Allow (looking at the page or pressing Deny makes no agent and no connection). On desktop (1440)
the local one is allowed without a warning and signs in again as the same connection; on a 390 touch phone
the web one shows its host and a warning, with 16px reading text and 44px buttons (Apple HIG-08/09/14 in
docs/design/apple-hig-mobile.md), and is denied. A page on another origin cannot frame the consent page.
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import json
import re
import os
import secrets
import threading
import time
import unittest
import urllib.parse
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "a client that says where it goes"
NORA = {"name": "Nora Lind", "email": f"nora.consent+{int(time.time() * 1000)}@example.test"}
LOCAL_REDIRECT = "http://127.0.0.1:19737/callback"
WEB_REDIRECT = "https://collector.example.net/oauth/callback"
SCOPES = "offline_access"
FIXTURE_PATH = "/api/v1/integration/oauth-clients"


class OauthConsentJourney(unittest.TestCase):
    """Tests run in name order and share one account, one connection and two registered clients."""

    pw = None
    browser: Browser
    state: dict = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool = False, signed_in: bool = True) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if signed_in and self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None):
        sent = {"origin": ORIGIN, **(headers or {})}
        if body is not None:
            sent["content-type"] = "application/json"
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers=sent, data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, f"{method} {path}: {response.text()}")
        return json.loads(response.text()) if response.text() else {}

    def authorize(self, page: Page, client: str, redirect: str, scope: str = SCOPES) -> str:
        """Opens the client's authorization request in the browser and continues to the consent page."""
        verifier = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = str(uuid.uuid4())
        query = urllib.parse.urlencode({"client_id": self.ids[client], "redirect_uri": redirect, "response_type": "code",
                                        "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
                                        "scope": scope, "resource": f"{ORIGIN}/mcp", "prompt": "consent"})
        page.goto(f"/api/auth/oauth2/authorize?{query}")
        # Nothing is chosen first: the client's request leads straight to the one page that asks (#859).
        expect(page.get_by_role("heading", level=1, name=re.compile(r"^Connect .+ to Flux$"))).to_be_visible()
        return state

    def destination(self, page: Page):
        return page.get_by_role("region", name="Where access goes")

    def clients(self, page: Page) -> list[dict]:
        """The connections of local clients Nora holds now (her assistant's own connection is not a client's)."""
        return [item for item in self.api(page, "GET", "/api/v1/agent-connections", status=200)
                if item["computeSource"] != "owner_assistant" and not item.get("revokedAt")]

    def test_01_an_owner_and_two_fixture_clients(self) -> None:
        page = self.page(signed_in=False)
        page.goto("/sign-up")
        page.get_by_label("Name").fill(NORA["name"])
        page.get_by_label("Email").fill(NORA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Lamp workshop"}, status=201)
        self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Sensor study", "visibility": "restricted"}, status=201)
        self.assertEqual(self.clients(page), [], "no client is connected before one asks")
        # Her session cannot register a client; the test deployment's fixture token can.
        self.api(page, "POST", "/api/auth/oauth2/create-client", {"client_name": "Claude Code", "redirect_uris": [WEB_REDIRECT],
                 "token_endpoint_auth_method": "none"}, status=401)
        token = os.environ["FLUX_FIXTURE_TOKEN"]
        for key, name, redirect in (("local", "Local CLI", LOCAL_REDIRECT), ("web", "Claude Code", WEB_REDIRECT)):
            self.ids[key] = self.api(page, "POST", FIXTURE_PATH, {"name": name, "redirectUris": [redirect]}, status=201,
                                     headers={"authorization": f"Bearer {token}"})["clientId"]

    def test_02_desktop_a_local_client_shows_its_loopback_host_without_a_warning_and_allow_connects_it(self) -> None:
        page = self.page()
        page.context.route(f"{LOCAL_REDIRECT}**", lambda route: route.fulfill(body="Connection authorized", content_type="text/plain"))
        state = self.authorize(page, "local", LOCAL_REDIRECT)
        expect(page.get_by_text("Local CLI", exact=True)).to_be_visible()
        expect(page.locator(".connection__head p")).to_contain_text("wants to sign in. It will act as you.")
        destination = self.destination(page)
        expect(destination).to_be_visible()
        expect(destination.locator("dt")).to_have_text(["Sends access to", "Client details from"])
        expect(destination.locator("dd")).to_have_text(["127.0.0.1:19737", "Registered on this Flux server"])
        expect(destination).to_contain_text("This address is on your own computer")
        expect(page.get_by_role("note")).to_have_count(0)
        # What it will be: Nora's rights, "What it may do", and waiting for deleting and other people's things. No capability is offered.
        will = page.get_by_role("list", name="What it will be").get_by_role("listitem")
        expect(will).to_have_count(3)
        expect(will.nth(0)).to_contain_text("Acts with your rights")
        expect(will.nth(1)).to_contain_text("Do it and tell me")
        expect(will.nth(2)).to_contain_text("wait for your OK")
        for chooser in ("checkbox", "radio", "combobox", "textbox"):
            expect(page.get_by_role(chooser)).to_have_count(0)
        expect(page.get_by_role("button", name="Allow", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Deny", exact=True)).to_be_visible()
        self.assertEqual(page.locator(".connection .ui-btn--primary").count(), 1, "one primary on the page")
        self.assertEqual(self.clients(page), [], "looking at the page made nothing")
        shot(page, "oauth-consent-desktop-local")
        page.get_by_role("button", name="Allow", exact=True).click()
        page.wait_for_url(f"{LOCAL_REDIRECT}?**")
        callback = urllib.parse.parse_qs(urllib.parse.urlsplit(page.url).query)
        self.assertEqual(callback["state"], [state])
        self.assertTrue(callback.get("code"), "the local client receives a code")
        made = self.clients(page)
        self.assertEqual([(item["name"], item["mayDo"], item["clientDesignation"]) for item in made], [("Local CLI on this computer", "act", "other")])

    def test_02b_signing_in_again_finds_the_same_connection_and_makes_no_second_one(self) -> None:
        page = self.page()
        page.context.route(f"{LOCAL_REDIRECT}**", lambda route: route.fulfill(body="Connection authorized", content_type="text/plain"))
        before = self.clients(page)
        self.assertEqual(len(before), 1)
        self.authorize(page, "local", LOCAL_REDIRECT)
        expect(page.locator(".connection__head p")).to_contain_text("is already connected as Local CLI on this computer. Allow signs it in again.")
        shot(page, "oauth-consent-desktop-again")
        page.get_by_role("button", name="Allow", exact=True).click()
        page.wait_for_url(f"{LOCAL_REDIRECT}?**")
        self.assertTrue(urllib.parse.parse_qs(urllib.parse.urlsplit(page.url).query).get("code"), "the client signs in again")
        self.assertEqual([item["id"] for item in self.clients(page)], [item["id"] for item in before], "the same connection, not a second one")

    def test_03_phone_a_web_redirect_is_named_and_warned_in_touch_sizes_then_denied(self) -> None:
        page = self.page(phone=True)
        page.context.route("https://collector.example.net/**", lambda route: route.fulfill(body="Collector", content_type="text/plain"))
        state = self.authorize(page, "web", WEB_REDIRECT)
        destination = self.destination(page)
        expect(destination.locator("dd")).to_have_text(["collector.example.net", "Registered on this Flux server"])
        warning = destination.get_by_role("note")
        expect(warning).to_be_visible()
        expect(warning).to_contain_text("This address is not on your computer.")
        expect(warning).to_contain_text("Flux will send access to collector.example.net")
        sizes = page.evaluate("""() => [...document.querySelectorAll(
            '.connection__destination dd, .connection__warning, .connection--consent .connection__head p, .connection__requested p')]
            .map((el) => [el.textContent.trim().slice(0, 40), parseFloat(getComputedStyle(el).fontSize)])""")
        self.assertGreaterEqual(len(sizes), 4)  # #763 WF-5: the requested list has no lead paragraph when nothing was refused
        for text, size in sizes:
            self.assertGreaterEqual(size, 16, f"16px reading text on a touch phone: {text}")
        secondary = page.evaluate("""() => [...document.querySelectorAll('.connection--consent *')]
            .filter((el) => el.checkVisibility() && [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()))
            .map((el) => [el.textContent.trim().slice(0, 40), parseFloat(getComputedStyle(el).fontSize)])
            .filter(([, size]) => size < 11)""")
        self.assertEqual(secondary, [], "no visible text below 11px")
        for name in ("Allow", "Deny"):
            box = page.get_by_role("button", name=name, exact=True).bounding_box()
            self.assertGreaterEqual(min(box["width"], box["height"]), 44, f"44px target: {name}")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no horizontal scroll")
        shot(page, "oauth-consent-phone-web")
        page.get_by_role("button", name="Deny", exact=True).click()
        page.wait_for_url("https://collector.example.net/oauth/callback?**")
        callback = urllib.parse.parse_qs(urllib.parse.urlsplit(page.url).query)
        self.assertEqual(callback["error"], ["access_denied"])
        self.assertEqual(callback["state"], [state])
        self.assertNotIn("code", callback, "a denied request carries no code")
        self.assertEqual([item["name"] for item in self.clients(page)], ["Local CLI on this computer"], "Deny made no agent and no connection")

    def test_04_another_origin_cannot_frame_the_consent_page(self) -> None:
        page = self.page()
        page.context.route("https://collector.example.net/**", lambda route: route.fulfill(body="Collector", content_type="text/plain"))
        self.authorize(page, "web", WEB_REDIRECT)
        consent = page.url
        # A page on another origin of this machine frames it: same site, so the Lax session cookie goes along
        # and only the response headers stand between the frame and a working consent page.
        body = f'<!doctype html><title>Prize</title><iframe src="{consent}" width="800" height="600"></iframe>'.encode()

        class Framer(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(200)
                self.send_header("content-type", "text/html")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args) -> None:
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Framer)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        framing = self.page()
        framing.goto(f"http://127.0.0.1:{server.server_address[1]}/", wait_until="load")
        frame = next(item for item in framing.frames if item != framing.main_frame)
        framing.wait_for_timeout(1500)
        # Chromium replaces a frame refused by frame-ancestors / X-Frame-Options with its error page.
        self.assertTrue(frame.url.startswith("chrome-error://"), f"the framed consent page was refused: {frame.url}")
        expect(framing.frame_locator("iframe").get_by_role("heading", name=re.compile(r"^Connect .+ to Flux$"))).to_have_count(0)
        # The same page opened directly still works.
        expect(page.get_by_role("heading", level=1, name=re.compile(r"^Connect .+ to Flux$"))).to_be_visible()
        # The browser may report the refused framing to the stack's Content-Security-Policy list (a test deployment, scripts/csp_gate.sh).
        # This test caused it on purpose, so it takes the frame-ancestors reports off the list once they have arrived: the gate stays
        # strict for a frame-ancestors report that comes from anywhere else. Not every engine reports it, so none is required.
        listed = f"{ORIGIN}/api/v1/test/csp-reports"
        headers = {"authorization": f"Bearer {os.environ['FLUX_FIXTURE_TOKEN']}", "origin": ORIGIN}  # the context carries her session cookie
        deadline = time.time() + 5
        while time.time() < deadline:
            reports = page.context.request.get(listed, headers=headers).json()["reports"]
            if any(report["directive"] == "frame-ancestors" for report in reports):
                break
            framing.wait_for_timeout(250)
        removed = page.context.request.delete(f"{listed}?directive=frame-ancestors", headers=headers)
        self.assertEqual(removed.status, 204, removed.text())

    def test_05_allow_on_a_web_client_connects_it_named_after_the_asking_client_and_nothing_else_is_asked(self) -> None:
        """#763 AG-6, #859: during a client's sign-in there is nothing to name or choose; Allow saves one connection that starts from
        the asking client's own name (a recognition aid only) and, being off this computer, is not called "on this computer"."""
        page = self.page()
        page.context.route("https://collector.example.net/**", lambda route: route.fulfill(body="Collector", content_type="text/plain"))
        self.authorize(page, "web", WEB_REDIRECT)
        expect(page.get_by_role("button", name="Revoke connection")).to_have_count(0)
        expect(page.get_by_label("Connection name")).to_have_count(0)
        expect(page.get_by_label("Client label", exact=True)).to_have_count(0)
        expect(page.get_by_role("button", name="Continue to consent")).to_have_count(0)
        page.get_by_role("button", name="Allow", exact=True).click()
        page.wait_for_url("https://collector.example.net/oauth/callback?**")
        self.assertTrue(urllib.parse.parse_qs(urllib.parse.urlsplit(page.url).query).get("code"))
        made = {item["name"]: item for item in self.clients(page)}
        self.assertEqual(sorted(made), ["Claude Code", "Local CLI on this computer"])
        self.assertEqual((made["Claude Code"]["clientDesignation"], made["Claude Code"]["mayDo"]), ("claude_code", "act"))
        # Her page of connected clients lists both, each with "What it may do" and Disconnect.
        page.goto("/settings/agents/connect")
        listed = page.get_by_role("list", name="Connected clients").get_by_role("listitem")
        expect(listed).to_have_count(2)
        expect(listed.filter(has_text="Claude Code").get_by_role("button", name="Disconnect")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
