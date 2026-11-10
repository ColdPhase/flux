"""The scene the README and documentation media show (v0.2): one company, a space that has been in use for a day.

Not a test: scripts/record_demo.sh runs it first, in the Compose stack that `./flux demo` data was just seeded into
(scripts/flux-demo.mjs: Ada Kowalska the owner, Jonas Berg a member, the space "Community garden sensors" with a
conversation, a Map and a Wiki page). Everything is made through the public API as the people it belongs to, so access,
undo and the domain events behave as for real use, and nothing is drawn over:

* the company is named Riverside Makers, with Basia Wrona (admin) and Tomasz Lis (guest), so People shows four roles;
* Ada connects AI with an API key (a made-up key: the stack answers from the TEST-ONLY provider mock, never a provider),
  which makes her Assistant, and adds Planner and Reviewer;
* the conversation has an update from Jonas, a question from Basia, a question from Jonas (and a last one from Basia in Rain barrel monitor), tasks in every state (three
  made from messages, one that is Planner's), an accepted decision and two that wait for Ada, and a post from Ada's Claude
  Code ("via Claude Code", through a real OAuth bearer and MCP call); the Map has seven thoughts and the Wiki three pages;
* two more spaces, so the sidebar reads like a company's.

The `/ai` answer shared with Show everyone ("via Assistant") is made by the recorded journey (record_demo.py), live, last.

Input (environment): FLUX_UI_ORIGIN, FLUX_UI_UPSTREAM, FLUX_DEMO_OWNER_PASSWORD, FLUX_DEMO_PARTNER_PASSWORD, FLUX_FIXTURE_TOKEN,
FLUX_ANTHROPIC_MOCK_URL (the Compose service of scripts/record_demo.sh).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import sys
import urllib.parse
import uuid

from playwright.sync_api import APIRequestContext, Browser, BrowserContext

from media_common import COMPANY, PARTNER, PASSWORD, call, company_id, project_id, sign_in
from test_app_shell import ORIGIN

# Each person who is not in the demo seed: name, email, company role. The password is the owner's, with a suffix.
EXTRA = (("Basia Wrona", "basia@demo.flux.test", "admin"), ("Tomasz Lis", "tomasz@demo.flux.test", "guest"))
EXTRA_PASSWORD = f"{PASSWORD}-colleague"
# A made-up key: the stack's worker sends every run to the provider mock, and the key is only ever shown as its last four characters.
API_KEY = "sk-ant-api03-" + "riverside-demo-" * 3 + "7Q3F"
REDIRECT = "http://127.0.0.1:19737/callback"

SHORT_UPDATE = "Short update: the second gateway works from the shed roof. Signal is strong on every bed except the far east one, which drops to one bar when the hedge is wet."
ROTA_QUESTION = "Ada, the volunteer rota is in the Wiki now. Could you read it before the weekend?"
CLIENT_POST = "I read the gateway log for the last seven days: the far east bed fell below -110 dBm twice, both times after rain. The shed bed never dropped."
SCHOOL_QUESTION = "Ada, the school can lend us two ESP32 kits. Shall I pick them up on Thursday?"
PIPE_QUESTION = "Ada, can you check the overflow pipe before Friday?"
PLANNER_NOTES = "Split a task into 3 to 5 steps, one verb and one result each.\nPlain English, no jargon."
REVIEWER_NOTES = "Read what changed in a task and say what is missing, in two short lines."

ROTA_PAGE = ("## This month\n\n| Day | Beds | Who |\n| --- | --- | --- |\n| Monday | Raised beds, fence side | Basia |\n| Thursday | Raised beds, far east | Jonas |\n"
             "| Saturday | All beds, by the sensors | Everyone |\n\n## Rules\n\nWater only when the sensor reads dry. Write what you did in the conversation.\n")
PLACEMENT_PAGE = ("## Where the sensors go\n\nOne capacitive probe per raised bed, 10 cm deep, away from the drip line.\n\n"
                  "## Gateways\n\nThe first gateway is in the shed. The second one sits on the shed roof and reaches every bed but the far east one.\n")


class LocalClient:
    """Ada's Claude Code: a real OAuth authorization-code/PKCE bearer and MCP-over-HTTP calls (as tests/ui/test_scenarios.McpAgent).

    The client is registered through the test-only fixture route (`FLUX_FIXTURE_TOKEN`), because a browser session cannot register one;
    authorize, consent, token and MCP are the real endpoints. Allowing it on the consent page makes the connection "Claude Code on this computer"."""

    def __init__(self, browser: Browser, owner: APIRequestContext) -> None:
        client = call(owner, "POST", "/api/v1/integration/oauth-clients", {"name": "Claude Code", "redirectUris": [REDIRECT]},
                      headers={"authorization": f"Bearer {os.environ['FLUX_FIXTURE_TOKEN']}"})
        verifier = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        query = urllib.parse.urlencode({"client_id": client["clientId"], "redirect_uri": REDIRECT, "response_type": "code", "code_challenge": challenge,
                                        "code_challenge_method": "S256", "state": str(uuid.uuid4()), "scope": "offline_access", "resource": f"{ORIGIN}/mcp", "prompt": "consent"})
        start = owner.fetch(f"{ORIGIN}/api/auth/oauth2/authorize?{query}", headers={"origin": ORIGIN, "accept": "text/html"}, max_redirects=0)
        location = start.headers.get("location") if start.status == 302 else start.json().get("url")
        destination = urllib.parse.urlsplit(urllib.parse.urljoin(ORIGIN, location))
        consent = call(owner, "POST", "/api/auth/oauth2/consent", {"accept": True, "oauth_query": destination.query})
        callback = urllib.parse.urlsplit(consent.get("url") or consent.get("redirect_uri"))
        code = urllib.parse.parse_qs(callback.query)["code"][0]
        self.http = browser.new_context(ignore_https_errors=True).request
        token = self.http.post(f"{ORIGIN}/api/auth/oauth2/token", form={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
                                                                       "client_id": client["clientId"], "code_verifier": verifier})
        if token.status != 200:
            sys.exit(f"media_scene: the client's token answered {token.status}: {token.text()}")
        self.bearer = token.json()["access_token"]
        self.calls = 0

    def tool(self, name: str, arguments: dict) -> dict:
        self.calls += 1
        params = {"name": name, "arguments": arguments, "_meta": {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": {"name": "claude-code", "version": "2"},
            "io.modelcontextprotocol/clientCapabilities": {}}}
        response = self.http.post(f"{ORIGIN}/mcp", headers={
            "authorization": f"Bearer {self.bearer}", "content-type": "application/json", "accept": "application/json",
            "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name},
            data=json.dumps({"jsonrpc": "2.0", "id": self.calls, "method": "tools/call", "params": params}))
        text = response.text()
        if "text/event-stream" in (response.headers.get("content-type") or ""):
            text = next(line[6:] for line in text.split("\n") if line.startswith("data: "))
        result = (json.loads(text).get("result") or {})
        if response.status != 200 or result.get("isError"):
            sys.exit(f"media_scene: {name} answered {response.status}: {text}")
        return json.loads(result["content"][0]["text"])


def sign_up(browser: Browser, name: str, email: str, password: str) -> None:
    stranger = browser.new_context(base_url=ORIGIN, ignore_https_errors=True)
    stranger.request.post(f"{ORIGIN}/api/auth/sign-up/email", data={"name": name, "email": email, "password": password}, headers={"origin": ORIGIN})
    stranger.close()


def person(browser: Browser, email: str, password: str) -> BrowserContext:
    context = browser.new_context(base_url=ORIGIN, ignore_https_errors=True)
    sign_in(context.request, email, password)
    return context


def build(browser: Browser, admin: BrowserContext) -> dict:
    """Makes the scene as Ada (`admin` is her signed-in context) and returns the ids the recorders need."""
    ada = admin.request
    ws = company_id(ada)
    pid = project_id(ada)
    call(ada, "PATCH", f"/api/v1/workspaces/{ws}", {"name": COMPANY})

    # People: Basia (admin) is in the space; Tomasz (guest) is in the company only.
    people = {"ada": ada, "jonas": person(browser, *PARTNER).request}
    for name, email, role in EXTRA:
        sign_up(browser, name, email, EXTRA_PASSWORD)
        call(ada, "POST", f"/api/v1/workspaces/{ws}/members", {"email": email, "role": role}, ok=(201, 409))
    people["basia"] = person(browser, EXTRA[0][1], EXTRA_PASSWORD).request
    ids = {key: call(request, "GET", "/api/v1/me")["user"]["id"] for key, request in people.items()}
    call(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": ids["basia"]}, "role": "contributor"})
    human = lambda key: {"kind": "human", "id": ids[key]}  # noqa: E731

    # Ada connects AI: the server makes her Assistant. She adds Planner and Reviewer.
    call(ada, "POST", "/api/v1/background-compute-connections", {"name": "Ada's Anthropic key", "provider": "anthropic", "model": "claude-sonnet-5",
                                                                   "apiKey": API_KEY, "dailyBudgetCents": 500, "timeZone": "Europe/Warsaw"})
    planner = call(ada, "POST", "/api/v1/my-agents", {"name": "Planner", "workspaceId": ws, "instructions": PLANNER_NOTES})
    call(ada, "POST", "/api/v1/my-agents", {"name": "Reviewer", "workspaceId": ws, "instructions": REVIEWER_NOTES})

    # Two more spaces for the sidebar. Basia is in the first: she asks Ada something there last of all, so Home's top three come from two spaces.
    barrel = ""
    for name in ("Rain barrel monitor", "Tool library"):
        other = call(ada, "POST", f"/api/v1/workspaces/{ws}/projects", {"name": name})
        call(ada, "POST", f"/api/v1/projects/{other['id']}/grants", {"principal": human("jonas"), "role": "contributor"})
        if name == "Rain barrel monitor":
            call(ada, "POST", f"/api/v1/projects/{other['id']}/grants", {"principal": human("basia"), "role": "contributor"})
            barrel = other["id"]

    # The conversation. The seed's opening question and its three replies are there; the stream goes on.
    conversations = f"/api/v1/projects/{pid}/conversations"
    root = next(item for item in call(ada, "GET", conversations)["items"] if item["firstMessageBody"].startswith("Should the first sensors"))
    thread = call(ada, "GET", f"/api/v1/conversations/{root['id']}")
    replies = [message for message in thread["messages"] if message["body"].startswith("Then let us order six")]
    chosen = [message for message in thread["messages"] if message["body"].startswith("Moisture first")]
    update = call(people["jonas"], "POST", conversations, {"body": SHORT_UPDATE, "clientMessageId": str(uuid.uuid4())})
    call(people["basia"], "POST", conversations, {"body": ROTA_QUESTION, "clientMessageId": str(uuid.uuid4())})
    school = call(people["jonas"], "POST", conversations, {"body": SCHOOL_QUESTION, "clientMessageId": str(uuid.uuid4())})

    def message_id(created: dict) -> str:
        return created["messages"][0]["id"] if "messages" in created else created["id"]

    # Tasks in every state, three of them made from messages; one is Planner's.
    work = f"/api/v1/projects/{pid}/work"
    ref = lambda created: {"type": "message", "id": message_id(created)}  # noqa: E731
    made = {
        "order": call(ada, "POST", work, {"title": "Order six capacitive moisture probes", "status": "done", "owner": human("ada"), "sources": [ref(replies[0])]}),
        "calibrate": call(ada, "POST", work, {"title": "Calibrate the probes in the raised beds", "status": "in_progress", "owner": human("ada")}),
        "antenna": call(ada, "POST", work, {"title": "Test the far east bed with a second antenna", "status": "in_progress", "owner": human("jonas"), "sources": [ref(update)]}),
        "rota": call(ada, "POST", work, {"title": "Draft the volunteer watering rota", "status": "in_progress", "owner": {"kind": "agent", "id": planner["id"]}}),
        "kits": call(ada, "POST", work, {"title": "Ask the school for two ESP32 kits", "owner": human("jonas"), "sources": [ref(school)]}),
        "labels": call(ada, "POST", work, {"title": "Label the sensor enclosures"}),
        "box": call(ada, "POST", work, {"title": "Waterproof the gateway box", "status": "blocked", "blocker": "the new seals", "waitingFor": human("basia"), "owner": human("jonas")}),
        "range": call(ada, "POST", work, {"title": "Test LoRa range from the shed roof", "status": "done", "owner": human("jonas")}),
    }

    # Decisions: one accepted, from the message it is based on; two wait for Ada.
    rule = call(ada, "POST", f"/api/v1/projects/{pid}/decisions", {"title": "Measure soil moisture first; frost warnings later",
                                                                    "rationale": "Volunteers overwater the raised beds; frost is only a spring problem.", "sources": [ref(chosen[0])]})
    call(ada, "POST", f"/api/v1/decisions/{rule['id']}/accept", {"expectedVersion": 1}, ok=(200,))
    call(people["jonas"], "POST", f"/api/v1/projects/{pid}/decisions", {"title": "Borrow two sensors from the school instead of buying more",
                                                                         "rationale": "It saves 36 EUR, and the school has spare ESP32 kits.", "sources": [ref(school)]})
    call(people["basia"], "POST", f"/api/v1/projects/{pid}/decisions", {"title": "Water the raised beds on Mondays and Thursdays",
                                                                         "rationale": "It matches the volunteer rota."})

    # Ada's Claude Code posts as her, marked "via Claude Code".
    LocalClient(browser, ada).tool("flux_start_conversation", {"projectId": pid, "clientCommandId": str(uuid.uuid4()), "sources": [], "message": {"body": CLIENT_POST}})

    # The last thing that happened: Basia asks Ada in the other space.
    call(people["basia"], "POST", f"/api/v1/projects/{barrel}/conversations", {"body": PIPE_QUESTION, "clientMessageId": str(uuid.uuid4())})

    # The Map: three more thoughts on the one the demo made.
    sketch = next(item for item in call(ada, "GET", f"/api/v1/workspaces/{ws}/sketches")["items"] if item["title"] == "Where the sensors go")
    detail = call(ada, "GET", f"/api/v1/sketches/{sketch['id']}")
    thoughts = {item["text"]: item["id"] for item in detail.get("thoughts", [])}
    add = lambda text, x, y, parent, label: call(ada, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts",  # noqa: E731
                                                  {"text": text, "x": x, "y": y, "linkFrom": {"thoughtId": parent, "label": label}})["thought"]["id"]
    far = thoughts["Far beds: test LoRa range first"]
    gateway = add("Gateway on the shed roof", 520, 0, far, "result")
    add("Second antenna for the far east bed?", 520, 110, gateway, "option")
    add("Volunteers water on Mondays and Thursdays", 520, -110, thoughts["Raised beds by the fence: overwatered"], "idea")

    # The Wiki: two more pages next to the one the demo made.
    rota = None
    for title, body in (("Sensor placement", PLACEMENT_PAGE), ("Volunteer rota", ROTA_PAGE)):
        created = call(ada, "POST", f"/api/v1/projects/{pid}/docs", {"title": title, "body": body}, headers={"idempotency-key": str(uuid.uuid4())})
        rota = created if title == "Volunteer rota" else rota
    # Ada reads the rota Basia wrote about and adds a line: Home then offers the page where she left off.
    assert rota is not None
    call(ada, "PATCH", f"/api/v1/docs/{rota['id']}", {"body": ROTA_PAGE + "\nBasia: please add your Saturdays to the table.\n"},
         headers={"if-match": f'"{rota["version"]}"', "idempotency-key": str(uuid.uuid4())})

    for request in (people["jonas"], people["basia"]):
        request.dispose()
    return {"workspace": ws, "project": pid, "conversation": root["id"], "tasks": {key: item["id"] for key, item in made.items()},
            "numbers": {key: item["number"] for key, item in made.items()}, "decision": rule["id"], "sketch": sketch["id"], "doc": rota["id"], "ids": ids}
