"""F-025 slices 1 and 2 (docs/design/people-and-ai.md): monochrome phone chrome (PA-1) and one orb per agent (PA-2).

Runs with the other tests/ui journeys through scripts/check_ui.sh (`./scripts/check_ui.sh test_people_and_ai`).
Ada and Jonas share a restricted project. Ada's "Claude Code" is a real MCP connection (OAuth with PKCE, standing
grants) that starts one conversation and replies in two threads, one of them a task's; Jonas has a configured
"Codex" connection; Ada's own assistant answers in Jonas's thread through the anthropic-mock provider. Every
message is written through the real API and read back in the browser, and each check knows from the API, not
from the page, which entries an agent wrote.

- test_02, at 390×844 with touch, in light and dark: every agent-authored entry (stream, threads, the
  assistant's answer, the Agents thread) shows exactly one orb, the agent's name without "· agent" and an "AI"
  badge; no person's entry has an orb; each connection row in Agents has its agent's orb, in the same palette
  as its messages; the assistant is violet.
- test_03, at 390: the phone tokens are the PA-1 neutrals in light, system dark and the dark toggle, with the
  Copper accent chosen; no element of the conversation, thread, Agents or Tasks paints an accent colour.
- test_04, at 1440 (and 820 / 641): the 11.6 accent is unchanged: Mint and Copper tokens, the tab indicator
  in the accent, no orb or badge, and agents named "<name> · agent" as before.
- test_05: a live orb turns once in 9 s without reduced motion, pauses under data-motion-paused, and has no
  animation at all under reduced motion. `live` is wired to nothing yet (slice 3), so the test sets the class
  the component sets for `live` (orbClassName, unit-tested in tests/app/orb-palette.test.ts).

- test_06, slice 4 (PA-4) at 390×844 and 375×667 with touch, light and dark: own bubbles are the action colour
  with inverse text at 4.5:1 or more; everyone else's are the bubble colour; radius 20; the name heads a run of
  one author's messages and is not repeated inside it (people and agents; an agent's run head keeps orb, name and
  AI); one date line above the day; no message IDs; no coloured side rule on bubbles, notices or cards.
- test_07, slice 4 (PA-7), same sizes: the composer is one pill, and every function is reachable by name and
  works: "+" opens Attach (a file chooser) and Sources (the tray), the assistant's violet orb toggles ask mode in
  a thread (absent in the stream, as today), the 16 px field, Send in the action colour, the audience line under
  the pill; Escape closes the menu back to "+".
- test_08, 1440: the composer, bubbles, names and thread IDs are as before.

Each check also runs once against a planted fault (an injected style or element) and must report it.
Screenshots (people-ai-*.png) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from test_personal_assistant import mock
from test_scenarios import ACTION_SCOPES, McpAgent

PASSWORD = "people and their agents on one lamp"
STAMP = int(time.time() * 1000)
NAMES = {"ada": "Ada Kowalska", "jonas": "Jonas Berg"}
AGENT = "Claude Code"
CODEX = "Codex"
JONAS_ROOT = "Camera or ToF sensor for the bedside lamp?"
AGENT_ROOT = "I compared three ToF sensors: the VL53L1X fits behind the shade and costs under 9 EUR."
ADA_ROOT = "Shopping list is on the wiki page, add anything you need."
ADA_REPLY = "Let's test both tonight in the dark bedroom."
AGENT_REPLY = "I can log the lux readings for both runs and post them here."
TASK = "Order a VL53L1X breakout board"
JONAS_TASK_NOTE = "Two boards, one spare. Ask about shipping to the workshop."
AGENT_TASK_REPLY = "Found a seller with next-day shipping; the link is in the shopping list."
ANSWER = "Short answer: the ToF sensor keeps working in the dark, the camera does not."
ADA_RUN = ["Batteries are in the drawer under the bench.", "And the spare USB-C cable is in the blue box."]
AGENT_RUN = ["Logged run one: 2.1 lux at 40 cm, gestures detected 19 of 20 times.", "Logged run two: 0.4 lux, gestures detected 20 of 20 times."]
JONAS_AFTER = "Great, the ToF board it is."
SIZES = ({"width": 390, "height": 844}, {"width": 375, "height": 667})

# The accent families of #148 in both themes (accent, hover, pressed, soft) and their tinted own bubbles: on a phone
# no chrome may paint any of them (F-025 PA-1).
ACCENTS = {
    "mint": ("#28664f", "#215643", "#1b4737", "#e8f1ec", "#91c9b3", "#a6d5c2", "#7fb9a2", "#293b34", "#e5eee5"),
    "copper": ("#985035", "#853f2a", "#703521", "#f6ede7", "#dba88c", "#e6baa2", "#c69478", "#42342d", "#f3e8de"),
    "sky": ("#345f93", "#2b507d", "#234268", "#eaf0f8", "#9bb7e1", "#b0c7e8", "#88a6d4", "#2b384b", "#e7edf4"),
}
FORBIDDEN = sorted({",".join(str(int(value[i:i + 2], 16)) for i in (1, 3, 5)) for family in ACCENTS.values() for value in family})
# The PA-1 neutrals the accent roles take on a phone.
PHONE_ROLES = {
    "light": {"--accent": "#151515", "--accent-soft": "#f4f2ef", "--accent-selected-bg": "#f4f2ef", "--accent-selected-text": "#151515",
              "--accent-selected-border": "#151515", "--link": "#151515", "--focus": "#151515", "--bubble-own": "#f2f0ed",
              "--nav-current": "#f4f2ef", "--action": "#111111", "--bg": "#fcfbfa", "--text": "#151515"},
    "dark": {"--accent": "#f2f0ed", "--accent-soft": "#242322", "--accent-selected-bg": "#242322", "--accent-selected-text": "#f2f0ed",
             "--accent-selected-border": "#f2f0ed", "--link": "#f2f0ed", "--focus": "#f2f0ed", "--bubble-own": "#262524",
             "--nav-current": "#242322", "--action": "#f2f0ed", "--bg": "#141414", "--text": "#f2f0ed"},
}

# Every entry with a message id on the page: its visible orbs (and their palettes), badges and the name shown.
ENTRIES = r"""(scope) => {
  const shown = (el) => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return [];
  return [...root.querySelectorAll('[data-message-id], [data-answer-run]')].map((entry) => {
    const own = (selector) => [...entry.querySelectorAll(selector)].filter((el) => {
      // Only this entry's header, not a nested entry's.
      const owner = el.parentElement.closest('[data-message-id], [data-answer-run]');
      return owner === entry && shown(el);
    });
    const name = entry.querySelector(':scope > .project-convo__message-meta strong, :scope > .thread__root-meta strong, :scope > .agents-msg__meta b');
    return {
      id: entry.dataset.messageId || `answer:${entry.dataset.answerRun}`,
      orbs: own('.ui-orb').map((el) => el.dataset.orb),
      badges: own('.ui-ai-badge').map((el) => el.textContent),
      suffix: own('.agents-msg__kind').map((el) => el.textContent).join(''),
      name: name ? name.textContent : null,
    };
  });
}"""

# Every visible element (and its ::before/::after) that paints one of the given colours, outside the orbs.
PAINTED = r"""(forbidden) => {
  const bad = new Set(forbidden);
  const props = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor',
    'textDecorationColor', 'fill', 'stroke', 'boxShadow', 'backgroundImage', 'caretColor'];
  const rgb = (value) => [...value.matchAll(/rgba?\(([^)]*)\)/g)].map((match) => match[1].split(/[\s,/]+/).filter(Boolean))
    .filter((parts) => parts.length < 4 || Number(parts[3]) > 0).map((parts) => parts.slice(0, 3).map((part) => Math.round(Number(part))).join(','));
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.ui-orb')) continue;
    const box = el.getBoundingClientRect();
    const own = getComputedStyle(el);
    if (!box.width || !box.height || own.display === 'none' || own.visibility === 'hidden') continue;
    for (const pseudo of [null, '::before', '::after']) {
      const style = pseudo ? getComputedStyle(el, pseudo) : own;
      if (pseudo && (style.content === 'none' || style.content === 'normal')) continue;
      for (const prop of props) {
        if (prop === 'outlineColor' && style.outlineStyle === 'none') continue;
        if (prop.startsWith('border') && style[prop.replace('Color', 'Style')] === 'none') continue;
        if (prop === 'textDecorationColor' && !/underline|overline|line-through/.test(style.textDecorationLine)) continue;
        if (prop === 'caretColor' && !el.matches('input, textarea, [contenteditable="true"]')) continue;
        for (const colour of rgb(style[prop] || '')) {
          if (bad.has(colour)) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}${pseudo || ''} ${prop} rgb(${colour})`);
        }
      }
    }
  }
  return out;
}"""

# Token values as six-digit hex: the production build shortens #111111 to #111.
TOKENS = r"""(names) => Object.fromEntries(names.map((name) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
  return [name, /^#[0-9a-f]{3}$/.test(value) ? '#' + [...value.slice(1)].map((c) => c + c).join('') : value];
}))"""


def iso_in(hours: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat().replace("+00:00", "Z")


class PeopleAndAiPhone(unittest.TestCase):
    """Tests run in name order and share two accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    req: dict = {}
    ids: dict[str, str] = {}
    s: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        agent = cls.s.get("mcp")
        if agent:
            agent.close()
        for context in cls.req.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- helpers

    def fetch(self, who: str, method: str, path: str, body: dict | None = None, headers: dict | None = None):
        return self.req[who].request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                           headers={"origin": ORIGIN, **({"content-type": "application/json"} if body is not None else {}), **(headers or {})})

    def api(self, who: str, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None):
        """The signature McpAgent (test_scenarios) uses for the owner's side of OAuth."""
        response = self.fetch(who, method, path, body, headers)
        if status is not None:
            self.assertEqual(response.status, status, f"{who} {method} {path}: {response.text()}")
        text = response.text()
        return json.loads(text) if text and text[:1] in "[{" else {}

    def wait_for(self, what: str, check, tries: int = 120):
        for _ in range(tries):
            value = check()
            if value:
                return value
            time.sleep(0.25)
        self.fail(f"timed out waiting for {what}")

    def page(self, who: str, *, phone: bool = True, scheme: str = "light", reduced: bool = False, init: str | None = None,
             viewport: dict | None = None) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "storage_state": self.states[who],
                         "reduced_motion": "reduce" if reduced else "no-preference"}
        if phone:
            options.update(viewport=viewport or PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        if init:
            context.add_init_script(init)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def open_stream(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['project']}")
        for message_id in self.s["stream"]:
            expect(page.locator(f".project-convo__message-list [data-message-id='{message_id}']")).to_be_visible()

    def open_thread(self, page: Page, conversation: str, expected: list[str]) -> None:
        page.goto(f"/projects/{self.ids['project']}/conversations/{conversation}")
        thread = page.get_by_role("complementary", name="Replies")
        for entry in expected:
            selector = f"[data-answer-run='{entry[7:]}']" if entry.startswith("answer:") else f"[data-message-id='{entry}']"
            expect(thread.locator(selector)).to_be_visible()

    def open_agents(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['project']}/agents?task={self.ids['task']}")
        expect(page.get_by_role("heading", level=1, name="Working together")).to_be_visible()
        for message_id in (self.s["jonas_task_note"], self.s["agent_task_reply"]):
            expect(page.locator(f".agents-thread__list [data-message-id='{message_id}']")).to_be_visible()

    def entry_problems(self, entries: list[dict], expected: set[str]) -> list[str]:
        """PA-2: an agent's entry has one orb, its name without '· agent' and 'AI'; a person's has no orb or badge."""
        problems = []
        seen = {entry["id"] for entry in entries}
        problems += [f"{entry_id} is missing" for entry_id in sorted(expected - seen)]
        for entry in entries:
            who = self.s["authors"].get(entry["id"])
            if who is None:
                continue
            if who == "person":
                if entry["orbs"]:
                    problems.append(f"{entry['id']} (a person) has an orb")
                if entry["badges"]:
                    problems.append(f"{entry['id']} (a person) has an AI badge")
                continue
            palette, name = ("violet", self.s["assistant_label"]) if who == "assistant" else (self.s["palette"], AGENT)
            if entry["orbs"] != [palette]:
                problems.append(f"{entry['id']} ({who}) shows orbs {entry['orbs']}, expected one {palette}")
            if entry["badges"] != ["AI"]:
                problems.append(f"{entry['id']} ({who}) shows badges {entry['badges']}")
            if (entry["name"] or "").strip() != name or "· agent" in entry["suffix"]:
                problems.append(f"{entry['id']} ({who}) is named {entry['name']!r}{entry['suffix']!r}")
        return problems

    def entries(self, page: Page, scope: str | None = None) -> list[dict]:
        return page.evaluate(ENTRIES, scope)

    # ---------------------------------------------------------------- setup through the API

    def test_01_people_their_agents_and_an_assistant_write(self) -> None:
        cls = type(self)
        for key, name in NAMES.items():
            context = self.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", headers={"origin": ORIGIN},
                                            data={"email": f"{key}.people-ai+{STAMP}@example.test", "password": PASSWORD, "name": name})
            self.assertEqual(response.status, 200, response.text())
            cls.states[key] = context.storage_state()
            cls.req[key] = context
            cls.ids[key] = self.api(key, "GET", "/api/v1/me", status=200)["user"]["id"]
        ws = self.api("ada", "POST", "/api/v1/workspaces", {"name": "Lamp makers"}, status=201)["id"]
        self.api("ada", "POST", f"/api/v1/workspaces/{ws}/members", {"email": f"jonas.people-ai+{STAMP}@example.test", "role": "member"}, status=201)
        pid = self.api("ada", "POST", f"/api/v1/workspaces/{ws}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)["id"]
        self.api("ada", "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": self.ids["jonas"]}, "role": "contributor"}, status=201)
        cls.ids.update(workspace=ws, project=pid)

        # Ada's Claude Code: a real MCP connection with standing grants to start and reply in conversations.
        agent = self.api("ada", "POST", f"/api/v1/workspaces/{ws}/agents", {"name": AGENT, "owner": "self"}, status=201)
        self.api("ada", "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        connection = self.api("ada", "POST", "/api/v1/agent-connections", {"agentId": agent["id"], "name": "Desk laptop", "clientDesignation": "claude_code",
                                                                            "selectedProjectIds": [pid], "scopes": ACTION_SCOPES}, status=201)
        mcp = McpAgent(self, "ada", connection["id"], pid)
        cls.s["mcp"] = mcp
        grants = {}
        for operation in ("conversation.create", "conversation.reply"):
            grants[operation] = self.api("ada", "POST", f"/api/v1/agent-connections/{connection['id']}/action-grants", {
                "clientCommandId": str(uuid.uuid4()), "projectId": pid, "operation": operation, "peerRequestClass": "execute",
                "maximumUses": 5, "expiresAt": iso_in(6)}, status=201)["id"]

        def act(tool: str, operation: str, **arguments) -> dict:
            return mcp.tool(tool, {"projectId": pid, "runtimeSessionId": mcp.runtime, "grantId": grants[operation],
                                   "clientCommandId": str(uuid.uuid4()), "peerRequestClass": "execute", "sources": [], **arguments})

        # Jonas's Codex: configured, never signed in; another agent with its own row in Agents.
        codex = self.api("jonas", "POST", f"/api/v1/workspaces/{ws}/agents", {"name": CODEX, "owner": "self"}, status=201)
        self.api("ada", "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": codex["id"]}, "role": "contributor"}, status=201)
        self.api("jonas", "POST", "/api/v1/agent-connections", {"agentId": codex["id"], "name": "Workshop PC", "clientDesignation": "codex",
                                                                "selectedProjectIds": [pid], "scopes": ["flux.context.read"]}, status=201)

        authors: dict[str, str] = {}
        jonas_root = self.api("jonas", "POST", f"/api/v1/projects/{pid}/conversations", {"body": JONAS_ROOT, "clientMessageId": str(uuid.uuid4())}, status=201)
        authors[jonas_root["messages"][0]["id"]] = "person"
        started = act("flux_start_conversation", "conversation.create", message={"body": AGENT_ROOT})
        authors[started["messageId"]] = "agent"
        ada_root = self.api("ada", "POST", f"/api/v1/projects/{pid}/conversations", {"body": ADA_ROOT, "clientMessageId": str(uuid.uuid4())}, status=201)
        authors[ada_root["messages"][0]["id"]] = "person"
        reply = self.api("ada", "POST", f"/api/v1/conversations/{jonas_root['id']}/messages", {"body": ADA_REPLY, "clientMessageId": str(uuid.uuid4())}, status=201)
        authors[reply["id"]] = "person"
        answered = act("flux_reply_in_conversation", "conversation.reply", conversationId=jonas_root["id"], message={"body": AGENT_REPLY})
        authors[answered["messageId"]] = "agent"

        # A task's thread: Jonas starts it, the agent replies; both show in Agents beside the connections.
        task = self.api("ada", "POST", f"/api/v1/projects/{pid}/work", {"title": TASK, "status": "in_progress"}, status=201)
        note = self.api("jonas", "POST", f"/api/v1/work/{task['id']}/discussion", {"body": JONAS_TASK_NOTE, "clientMessageId": str(uuid.uuid4()), "kind": "text"}, status=201)
        discussion = self.api("jonas", "GET", f"/api/v1/work/{task['id']}/discussion", status=200)
        note_id = note.get("id") or note.get("message", {}).get("id") or discussion["root"]["id"]
        authors[note_id] = "person"
        task_reply = act("flux_reply_in_conversation", "conversation.reply", conversationId=discussion["conversationId"], message={"body": AGENT_TASK_REPLY})
        authors[task_reply["messageId"]] = "agent"

        # Ada's own assistant answers in Jonas's thread (the TEST-ONLY anthropic-mock provider of check_ui.sh).
        assistant = self.api("ada", "POST", f"/api/v1/workspaces/{ws}/agents", {"name": "Ada's assistant", "owner": "self"}, status=201)
        self.api("ada", "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": assistant["id"]}, "role": "viewer"}, status=201)
        self.api("ada", "POST", "/api/v1/personal-assistant", {"consentVersion": "o-008-2026-10-02", "agentId": assistant["id"],
                                                               "perRunCents": 6, "dailyCapCents": 100}, status=201)
        mock("/__script", {"reset": True, "text": ANSWER})
        run = self.api("ada", "POST", f"/api/v1/conversations/{jonas_root['id']}/assistant-runs",
                       {"clientRunId": str(uuid.uuid4()), "kind": "ask", "prompt": "Summarize where we are"}, status=202)
        answers = self.wait_for("the assistant's answer", lambda: self.api(
            "ada", "GET", f"/api/v1/conversations/{jonas_root['id']}/assistant-answers", status=200)["items"])
        self.assertEqual(answers[0]["runId"], run["id"])
        authors[f"answer:{run['id']}"] = "assistant"

        # Every agent message names the agent as its author, never a person (read back from the API). The stream
        # shows every root the API lists.
        roots = self.api("ada", "GET", f"/api/v1/projects/{pid}/conversation-roots?limit=100", status=200)["roots"]
        by_id = {root["message"]["id"]: root["message"] for root in roots}
        self.assertEqual(by_id[started["messageId"]]["author"], {"kind": "agent", "id": agent["id"], "name": AGENT})
        self.assertIsNone(by_id[started["messageId"]]["authorId"])
        for root_id in (jonas_root["messages"][0]["id"], started["messageId"], ada_root["messages"][0]["id"]):
            self.assertIn(root_id, by_id)
        for root_id, message in by_id.items():
            self.assertEqual(authors.get(root_id), "agent" if message["authorId"] is None else "person", message)
        cls.s["act"] = act
        cls.ids.update(task=task["id"], agent=agent["id"], codex=codex["id"], jonas_root=jonas_root["id"], agent_root=started["conversationId"])
        cls.s.update(authors=authors, assistant_label=answers[0]["assistant"]["label"],
                     stream=list(by_id),
                     jonas_thread=[jonas_root["messages"][0]["id"], reply["id"], answered["messageId"], f"answer:{run['id']}"],
                     agent_thread=[started["messageId"]], jonas_task_note=note_id, agent_task_reply=task_reply["messageId"])

    # ---------------------------------------------------------------- PA-2 at 390 with touch

    def test_02_every_agent_entry_has_its_orb_name_and_ai_badge_and_no_person_has_one(self) -> None:
        self.assertIn("authors", self.s, "test_01 ran")
        for scheme in ("light", "dark"):
            page = self.page("ada", scheme=scheme)
            self.open_stream(page)
            stream = self.entries(page, ".project-convo__message-list")
            # The agent's palette, as the stream shows it; every other place must show the same one.
            agent_orbs = {orb for entry in stream if self.s["authors"].get(entry["id"]) == "agent" for orb in entry["orbs"]}
            self.assertEqual(len(agent_orbs), 1, stream)
            type(self).s["palette"] = agent_orbs.pop()
            self.assertNotEqual(self.s["palette"], "violet", "a connection never takes the assistant's violet")
            self.assertEqual(self.entry_problems(stream, set(self.s["stream"])), [], f"{scheme} stream")
            shot(page, f"people-ai-390-{scheme}-stream")

            self.open_thread(page, self.ids["jonas_root"], self.s["jonas_thread"])
            thread = self.entries(page, "#thread")
            self.assertEqual(self.entry_problems(thread, set(self.s["jonas_thread"])), [], f"{scheme} thread")
            shot(page, f"people-ai-390-{scheme}-thread")
            self.open_thread(page, self.ids["agent_root"], self.s["agent_thread"])
            self.assertEqual(self.entry_problems(self.entries(page, "#thread"), set(self.s["agent_thread"])), [], f"{scheme} agent's thread")

            self.open_agents(page)
            agents = self.entries(page, ".agents-thread__list")
            self.assertEqual(self.entry_problems(agents, {self.s["jonas_task_note"], self.s["agent_task_reply"]}), [], f"{scheme} Agents thread")
            rows = page.evaluate("""() => [...document.querySelectorAll('.agents-conn')].map((row) => ({
              name: row.querySelector('.agents-conn__name').textContent,
              orbs: [...row.querySelectorAll('.ui-orb')].filter((orb) => orb.getBoundingClientRect().width > 0).map((orb) => orb.dataset.orb),
              icons: row.querySelectorAll('svg').length }))""")
            self.assertEqual(sorted(row["name"] for row in rows), ["Desk laptop", "Workshop PC"])
            for row in rows:
                self.assertEqual(len(row["orbs"]), 1, row)
                self.assertEqual(row["icons"], 0, "the orb replaces the terminal icon on phones")
            self.assertEqual(next(row for row in rows if row["name"] == "Desk laptop")["orbs"], [self.s["palette"]],
                             "a connection's orb matches its agent's messages")
            shot(page, f"people-ai-390-{scheme}-agents")

        # Negative controls: each fault is reported.
        page = self.page("ada")
        self.open_stream(page)
        person = next(entry_id for entry_id in self.s["stream"] if self.s["authors"][entry_id] == "person")
        page.evaluate("""(id) => { const meta = document.querySelector(`[data-message-id="${id}"] .project-convo__message-meta`);
          meta.insertAdjacentHTML('afterbegin', '<span class="ui-orb ui-orb--sm ui-orb--ember" data-orb="ember"></span>'); }""", person)
        problems = self.entry_problems(self.entries(page, ".project-convo__message-list"), set(self.s["stream"]))
        self.assertIn(f"{person} (a person) has an orb", problems)
        page.reload()
        self.open_stream(page)
        page.add_style_tag(content=".ui-orb { display: none !important; }")
        self.assertTrue(any("shows orbs []" in problem for problem in self.entry_problems(self.entries(page, ".project-convo__message-list"), set(self.s["stream"]))))
        page.reload()
        self.open_stream(page)
        page.add_style_tag(content=".ui-ai-badge { display: none !important; }")
        self.assertTrue(any("shows badges []" in problem for problem in self.entry_problems(self.entries(page, ".project-convo__message-list"), set(self.s["stream"]))))

    # ---------------------------------------------------------------- PA-1 at 390

    def accent_problems(self, page: Page, theme: str) -> list[str]:
        tokens = page.evaluate(TOKENS, list(PHONE_ROLES[theme]))
        problems = [f"{name} is {value}, expected {PHONE_ROLES[theme][name]}" for name, value in tokens.items() if value != PHONE_ROLES[theme][name]]
        return problems + page.evaluate(PAINTED, FORBIDDEN)

    def test_03_phone_chrome_has_no_accent_colour_in_light_or_dark(self) -> None:
        self.assertIn("authors", self.s, "test_01 ran")
        copper = "localStorage.setItem('flux.accent.light', 'copper'); localStorage.setItem('flux.accent.dark', 'copper');"
        for label, scheme, theme, init in (("light", "light", "light", copper), ("dark", "dark", "dark", copper),
                                           ("dark-toggle", "light", "dark", copper + " localStorage.setItem('flux.theme', 'dark');")):
            page = self.page("ada", scheme=scheme, init=init)
            self.open_stream(page)
            self.assertEqual(page.evaluate("document.documentElement.dataset.accent"), "copper", "the person's accent choice is applied")
            if label == "dark-toggle":
                self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")
            self.assertEqual(self.accent_problems(page, theme), [], f"{label} conversation")
            # The current place in the bottom bar: the quiet fill and a heavier weight, never colour alone.
            current = page.locator(".ui-bottomnav__item[aria-current='page']")
            if current.count():
                style = current.first.evaluate("""(el) => ({ weight: Number(getComputedStyle(el).fontWeight),
                  pill: getComputedStyle(el.querySelector('.ui-bottomnav__pill'), '::before').backgroundColor })""")
                self.assertGreaterEqual(style["weight"], 600, "the current place is heavier, not only another colour")
                quiet = PHONE_ROLES[theme]["--accent-soft"]
                self.assertEqual(style["pill"], "rgb({}, {}, {})".format(*(int(quiet[i:i + 2], 16) for i in (1, 3, 5))))
            # With the composer focused (its focus border; the bottom bar steps aside while typing).
            page.locator(".project-convo__composer textarea").first.focus()
            self.assertEqual(self.accent_problems(page, theme), [], f"{label} conversation, composer focused")
            self.open_thread(page, self.ids["jonas_root"], self.s["jonas_thread"])
            self.assertEqual(self.accent_problems(page, theme), [], f"{label} thread")
            self.open_agents(page)
            self.assertEqual(self.accent_problems(page, theme), [], f"{label} Agents")
            page.goto(f"/projects/{self.ids['project']}/tasks")
            expect(page.locator(".tb-bar")).to_be_visible()
            self.assertEqual(self.accent_problems(page, theme), [], f"{label} Tasks")

        # Negative controls: an accent painted in the bottom bar, and the accent token leaking back, are reported.
        page = self.page("ada", init=copper)
        self.open_stream(page)
        page.add_style_tag(content="header.top { background-color: var(--accent-light) !important; }")
        self.assertTrue(any(problem.startswith("header.top") and "backgroundColor rgb(152,80,53)" in problem for problem in self.accent_problems(page, "light")))
        page.add_style_tag(content=":root:root { --link: var(--accent-light) !important; }")
        self.assertIn("--link is #985035, expected #151515", self.accent_problems(page, "light"))

    # ---------------------------------------------------------------- tablet and desktop unchanged

    def desktop_problems(self, page: Page, family: str, theme: str) -> list[str]:
        accent, soft = (ACCENTS[family][0], ACCENTS[family][3]) if theme == "light" else (ACCENTS[family][4], ACCENTS[family][7])
        tokens = page.evaluate(TOKENS, ["--accent", "--accent-soft", "--link", "--focus"])
        expected = {"--accent": accent, "--accent-soft": soft, "--link": accent, "--focus": accent}
        problems = [f"{name} is {value}, expected {expected[name]}" for name, value in tokens.items() if value != expected[name]]
        visible = page.evaluate("""() => [...document.querySelectorAll('.ui-orb, .ui-ai-badge')].filter((el) => el.getBoundingClientRect().width > 0).length""")
        if visible:
            problems.append(f"{visible} orbs or badges shown above phone width")
        return problems

    def test_04_tablet_and_desktop_keep_the_11_6_accent_and_name_agents_as_before(self) -> None:
        self.assertIn("authors", self.s, "test_01 ran")
        for family, init in (("mint", None), ("copper", "localStorage.setItem('flux.accent.light', 'copper'); localStorage.setItem('flux.accent.dark', 'copper');")):
            for theme in ("light", "dark"):
                page = self.page("ada", phone=False, scheme=theme, init=init)
                self.open_stream(page)
                self.assertEqual(self.desktop_problems(page, family, theme), [], f"1440 {family} {theme}")
                indicator = page.locator(".views .ui-tabs__indicator").first
                expected = ACCENTS[family][0] if theme == "light" else ACCENTS[family][4]
                expect(indicator).to_have_css("background-color", "rgb({}, {}, {})".format(*(int(expected[i:i + 2], 16) for i in (1, 3, 5))))
                if family == "mint" and theme == "light":
                    names = page.evaluate("""(id) => document.querySelector(`[data-message-id="${id}"] .project-convo__message-meta strong`).textContent""",
                                          self.s["stream"][1])
                    self.assertEqual(names, f"{AGENT} · agent", "desktop keeps the 11.6 agent label")
                    shot(page, "people-ai-1440-light-stream")
        for width in (820, 641):
            page = self.page("ada", phone=False, viewport={"width": width, "height": 1000})
            self.open_stream(page)
            self.assertEqual(self.desktop_problems(page, "mint", "light"), [], f"{width} px")
        # The phone palette starts at 640 px and not before.
        page = self.page("ada", phone=False, viewport={"width": 640, "height": 1000})
        self.open_stream(page)
        self.assertEqual(page.evaluate(TOKENS, ["--accent"])["--accent"], "#151515")

        # Negative control: phone values leaking to desktop are reported.
        page = self.page("ada", phone=False)
        self.open_stream(page)
        page.add_style_tag(content=":root:root { --accent: #151515 !important; }")
        self.assertIn("--accent is #151515, expected #28664f", self.desktop_problems(page, "mint", "light"))

    # ---------------------------------------------------------------- live orb and reduced motion

    LIVE = r"""(selector) => {
      const orb = document.querySelector(selector);
      orb.classList.add('ui-orb--live');
      const before = getComputedStyle(orb, '::before');
      const turning = orb.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running');
      return { name: before.animationName, duration: before.animationDuration, running: turning.length,
               timing: turning.map((animation) => animation.effect.getComputedTiming().duration) };
    }"""

    def test_05_a_live_orb_turns_slowly_pauses_out_of_sight_and_never_moves_with_reduced_motion(self) -> None:
        self.assertIn("authors", self.s, "test_01 ran")
        agent_entry = next(entry_id for entry_id in self.s["stream"] if self.s["authors"][entry_id] == "agent")
        selector = f"[data-message-id='{agent_entry}'] .ui-orb"
        page = self.page("ada")
        self.open_stream(page)
        # Still by default: `live` is false everywhere until slice 3 wires the working state.
        self.assertEqual(page.evaluate("() => document.getAnimations().filter((a) => String(a.animationName).startsWith('ui-orb')).length"), 0)
        self.assertEqual(page.evaluate("() => document.querySelectorAll('.ui-orb--live').length"), 0)
        live = page.evaluate(self.LIVE, selector)
        self.assertEqual((live["name"], live["duration"], live["running"]), ("ui-orb-turn", "9s", 1), live)
        self.assertEqual(live["timing"], [9000])
        page.evaluate("(selector) => document.querySelector(selector).setAttribute('data-motion-paused', '')", selector)
        self.assertEqual(page.evaluate("(selector) => document.querySelector(selector).getAnimations({ subtree: true }).map((a) => a.playState)", selector), ["paused"])

        calm = self.page("ada", reduced=True)
        self.open_stream(calm)
        still = calm.evaluate(self.LIVE, selector)
        self.assertEqual((still["name"], still["running"]), ("none", 0), still)

        # Negative control: an orb forced to turn under reduced motion is caught by the same reading.
        calm.add_style_tag(content="@media (prefers-reduced-motion: reduce) { .ui-orb.ui-orb--live::before { animation: ui-orb-turn 9s linear infinite !important; "
                                   "animation-duration: 9s !important; animation-iteration-count: infinite !important; } }")
        forced = calm.evaluate(self.LIVE, selector)
        self.assertEqual((forced["name"], forced["running"]), ("ui-orb-turn", 1), forced)


    # ---------------------------------------------------------------- slice 4: messages and composer (PA-4, PA-7)

    # The stream's entries in order: whether each continues a run and whether it shows a name.
    RUNS = r"""(scope) => [...document.querySelectorAll(`${scope} > li`)].map((li) => {
      const shown = (el) => !!el && el.getBoundingClientRect().width > 1 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
      const meta = li.querySelector(':scope > .project-convo__message-meta');
      if (!li.dataset.messageId) return { id: null, kind: li.className };
      return { id: li.dataset.messageId, continues: li.dataset.run === 'continues', named: shown(meta) && shown(meta.querySelector('strong')),
               day: li.previousElementSibling?.classList.contains('project-convo__day') ? li.previousElementSibling.textContent : null,
               spoken: li.textContent };
    })"""

    # Every bubble: its colours, WCAG contrast and radius, and the action / bubble tokens as computed colours.
    BUBBLES = r"""(scope) => {
      const lum = (colour) => { const [r, g, b] = colour.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const token = (name) => { const probe = document.createElement('i'); probe.style.color = `var(${name})`; document.body.append(probe);
        const value = getComputedStyle(probe).color; probe.remove(); return value; };
      const bubbles = [...document.querySelectorAll(`${scope} li[data-message-id] > p`)].map((p) => { const style = getComputedStyle(p); const a = lum(style.color), b = lum(style.backgroundColor);
        return { id: p.parentElement.dataset.messageId, mine: p.parentElement.classList.contains('is-mine'), bg: style.backgroundColor, color: style.color,
                 ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), radius: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius] }; });
      return { bubbles, action: token('--action'), onAction: token('--on-action'), bubble: token('--bubble'), own: token('--bubble-own') };
    }"""

    # Coloured side rules (a thick one-sided border or inset bar) and visible IDs inside the messages.
    MARKS = r"""(scope) => {
      const out = [];
      for (const el of document.querySelectorAll(`${scope} .project-convo__messages *`)) {
        const style = getComputedStyle(el); const box = el.getBoundingClientRect();
        if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden') continue;
        const name = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
        for (const side of ['Left', 'Right']) {
          const width = parseFloat(style[`border${side}Width`]);
          if (width >= 2 && style[`border${side}Style`] !== 'none' && !/rgba\([^)]*,\s*0\)/.test(style[`border${side}Color`]) && parseFloat(style[`border${side === 'Left' ? 'Right' : 'Left'}Width`]) < width)
            out.push(`${name} has a ${side.toLowerCase()} rule`);
        }
        for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
          const lengths = (shadow.replace(/rgba?\([^)]*\)/, '').match(/-?[\d.]+px/g) || []).map(parseFloat);
          if (/inset/.test(shadow) && Math.abs(lengths[0] || 0) >= 2 && !lengths[1] && !lengths[2]) out.push(`${name} has an inset side bar`);
        }
        const own = [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join('');
        if (/(^|\s)#\d+\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(own)) out.push(`${name} shows an id: ${own.trim()}`);
      }
      return out;
    }"""

    def ensure_runs(self) -> None:
        """Ada writes two more roots after her own, then the agent two, then Jonas one: three runs in the stream."""
        if "runs" in self.s:
            return
        pid, authors, act = self.ids["project"], self.s["authors"], self.s["act"]
        added = []
        for body in ADA_RUN:
            root = self.api("ada", "POST", f"/api/v1/projects/{pid}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, status=201)
            authors[root["messages"][0]["id"]] = "person"
            added.append(root["messages"][0]["id"])
        for body in AGENT_RUN:
            started = act("flux_start_conversation", "conversation.create", message={"body": body})
            authors[started["messageId"]] = "agent"
            added.append(started["messageId"])
        after = self.api("jonas", "POST", f"/api/v1/projects/{pid}/conversations", {"body": JONAS_AFTER, "clientMessageId": str(uuid.uuid4())}, status=201)
        authors[after["messages"][0]["id"]] = "person"
        added.append(after["messages"][0]["id"])
        roots = self.api("ada", "GET", f"/api/v1/projects/{pid}/conversation-roots?limit=100", status=200)["roots"]
        order = [root["message"] for root in sorted(roots, key=lambda root: (root["message"]["createdAt"], root["conversationId"]))]
        type(self).s.update(runs=[message["id"] for message in order],
                            keys={message["id"]: message["authorId"] or f"agent:{message['author']['id']}" for message in order},
                            mine={message["id"] for message in order if message["authorId"] == self.ids["ada"]})
        self.assertEqual(added, type(self).s["runs"][-5:], "the new roots are the last five, in order")

    def run_problems(self, rows: list[dict]) -> list[str]:
        problems, previous = [], None
        for row in rows:
            if row["id"] is None:  # a date line or a task notice ends a run
                previous = None
                continue
            key = self.s["keys"].get(row["id"])
            continues = key is not None and key == previous
            previous = key
            if row["continues"] != continues:
                problems.append(f"{row['id']} continues={row['continues']}, expected {continues}")
            if continues and row["named"]:
                problems.append(f"{row['id']} repeats the name inside a run")
            if not continues and not row["named"]:
                problems.append(f"{row['id']} starts a run without a name")
        return problems

    def bubble_problems(self, read: dict) -> list[str]:
        problems = []
        for bubble in read["bubbles"]:
            if bubble["radius"] != ["20px"] * 4:
                problems.append(f"{bubble['id']} radius {bubble['radius']}")
            if bubble["mine"]:
                if bubble["bg"] != read["action"] or bubble["color"] != read["onAction"]:
                    problems.append(f"{bubble['id']} (own) is {bubble['color']} on {bubble['bg']}, expected {read['onAction']} on {read['action']}")
                if bubble["ratio"] < 4.5:
                    problems.append(f"{bubble['id']} (own) contrast {bubble['ratio']:.2f}")
            elif bubble["bg"] != read["bubble"]:
                problems.append(f"{bubble['id']} is on {bubble['bg']}, expected the bubble {read['bubble']}")
        return problems

    def test_06_phone_messages_own_in_the_action_colour_runs_named_once_no_ids_or_side_rules(self) -> None:
        self.assertIn("authors", self.s, "test_01 ran")
        self.ensure_runs()
        mine = self.s["mine"]
        for size in SIZES:
            for scheme in ("light", "dark"):
                label = f"{size['width']}x{size['height']} {scheme}"
                page = self.page("ada", scheme=scheme, viewport=size)
                page.goto(f"/projects/{self.ids['project']}")
                list_ = ".project-convo__message-list"
                for message_id in self.s["runs"]:
                    expect(page.locator(f"{list_} [data-message-id='{message_id}']")).to_have_count(1)
                expect(page.locator(".project-convo__feed")).not_to_have_attribute("aria-busy", "true")
                every = page.evaluate(self.RUNS, list_)
                self.assertEqual(self.run_problems(every), [], label)
                rows = [row for row in every if row["id"]]
                runs = self.s["runs"]
                self.assertEqual([next(row for row in rows if row["id"] == runs[i])["continues"] for i in (-4, -3, -2, -1)], [True, False, True, False], label)
                # One date line heads the day; a continuation still says who wrote it to a screen reader.
                self.assertEqual(every[0]["kind"], "project-convo__day", label)
                self.assertEqual(rows[0]["day"], "Today", label)
                self.assertEqual(page.locator(f"{list_} .project-convo__day").count(), 1, label)
                cont = next(row for row in rows if row["id"] == self.s["runs"][-2])
                self.assertIn(f"{AGENT}, AI", cont["spoken"], label)
                # PA-2 on every run head: agents keep orb, name and AI; people have none.
                heads = [entry for entry in self.entries(page, list_) if not next(row for row in rows if row["id"] == entry["id"])["continues"]]
                self.assertEqual(self.entry_problems(heads, set()), [], label)
                read = page.evaluate(self.BUBBLES, list_)
                self.assertEqual(self.bubble_problems(read), [], label)
                self.assertEqual({bubble["id"] for bubble in read["bubbles"] if bubble["mine"]}, mine & {bubble["id"] for bubble in read["bubbles"]}, label)
                self.assertTrue(any(bubble["mine"] for bubble in read["bubbles"]), label)
                self.assertEqual(page.evaluate(self.MARKS, ".project-convo"), [], f"{label} stream")
                if size["width"] == 390:
                    shot(page, f"people-ai-390-{scheme}-messages")
                # Jonas's thread: no "#n" on replies; the same bubbles and rules.
                self.open_thread(page, self.ids["jonas_root"], self.s["jonas_thread"])
                self.assertEqual(page.evaluate(self.MARKS, "#thread"), [], f"{label} thread")
                self.assertEqual(self.bubble_problems(page.evaluate(self.BUBBLES, "#thread")), [], f"{label} thread")

        # Negative controls: a low-contrast own bubble, a repeated name, a side rule and a visible id are reported.
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator(f"[data-message-id='{self.s['runs'][-1]}']")).to_be_visible()
        page.add_style_tag(content="@media (max-width: 640px) { .project-convo__message.is-mine > p { color: #555 !important; } }")
        self.assertTrue(any("(own)" in problem and "contrast" in problem for problem in self.bubble_problems(page.evaluate(self.BUBBLES, ".project-convo__message-list"))))
        page.evaluate("""(id) => { const li = document.querySelector(`[data-message-id="${id}"]`); delete li.dataset.run;
          li.insertAdjacentHTML('afterbegin', '<div class="project-convo__message-meta"><strong>Ada Kowalska</strong></div>'); }""", self.s["runs"][-4])
        self.assertIn(f"{self.s['runs'][-4]} continues=False, expected True", self.run_problems(page.evaluate(self.RUNS, ".project-convo__message-list")))
        page.add_style_tag(content=".convo-notice, .project-convo__message > p { border-left: 3px solid var(--danger) !important; }")
        page.evaluate("""(id) => document.querySelector(`[data-message-id="${id}"] > p`).insertAdjacentText('beforebegin', '#12')""", self.s["runs"][-1])
        marks = page.evaluate(self.MARKS, ".project-convo")
        self.assertTrue(any("left rule" in mark for mark in marks), marks)
        self.assertTrue(any("shows an id: #12" in mark for mark in marks), marks)

    def composer_problems(self, scope, thread: bool) -> list[str]:
        """PA-7: every composer function reachable by name, as a 44 px target, in one pill with the audience under it."""
        problems: list[str] = []

        def reach(name: str, locator):
            if not locator.count() or not locator.first.is_visible():
                problems.append(f"{name} is not reachable")
                return None
            box = locator.first.bounding_box()
            if box["width"] < 44 or box["height"] < 44:
                problems.append(f"{name} is {box['width']:.0f}x{box['height']:.0f}")
            return locator.first

        pill = scope.locator(".composer__box")
        plus = reach("Attach or cite", pill.get_by_role("button", name="Attach or cite", exact=True))
        if plus:
            if plus.get_attribute("aria-expanded") != "false":
                problems.append("the menu starts open")
            plus.tap()
            reach("Attach files", scope.get_by_role("button", name="Attach files", exact=True))
            reach("Sources", scope.get_by_role("button", name=re.compile("^Sources")))
            plus.tap()
        field = reach("the field", scope.get_by_label("Reply" if thread else "Write a message", exact=True))
        if field and float(field.evaluate("el => parseFloat(getComputedStyle(el).fontSize)")) < 16:
            problems.append("the field is under 16 px")
        send = reach("Send", pill.get_by_role("button", name="Send reply" if thread else "Send message", exact=True))
        if send and field:
            field.fill("Draft")  # Send takes the action colour once there is something to send
            expect(send).to_have_attribute("aria-disabled", "false")
            for _ in range(20):  # past the press and colour transition
                fill = send.evaluate("""(el) => { const probe = document.createElement('i'); probe.style.color = 'var(--action)'; document.body.append(probe);
              const action = getComputedStyle(probe).color; probe.remove(); return [getComputedStyle(el, '::before').backgroundColor, action]; }""")
                if fill[0] == fill[1]:
                    break
                time.sleep(0.1)
            if fill[0] != fill[1]:
                problems.append(f"Send is {fill[0]}, not the action colour {fill[1]}")
            field.fill("")
        ask = pill.get_by_role("button", name="Ask my assistant", exact=True)
        if thread:
            if reach("Ask my assistant", ask) and ask.locator(".ui-orb").get_attribute("data-orb") != "violet":
                problems.append("the assistant is not its violet orb")
        elif ask.count():
            problems.append("the stream offers an assistant it does not have")
        audience = scope.locator(".composer__audience")
        if not audience.count() or not audience.first.is_visible():
            problems.append("the audience line is not shown")
        elif audience.first.bounding_box()["y"] < pill.bounding_box()["y"] + pill.bounding_box()["height"] - 1:
            problems.append("the audience line is not under the pill")
        rows = pill.evaluate("(el) => new Set([...el.children].filter((c) => c.getBoundingClientRect().width > 1).map((c) => Math.round(c.getBoundingClientRect().bottom))).size")
        if rows != 1:
            problems.append(f"the pill has {rows} rows")
        return problems

    def test_07_phone_composer_is_one_pill_and_every_function_is_reachable_by_name(self) -> None:
        self.assertIn("authors", self.s, "test_01 ran")
        for size in SIZES:
            for scheme in ("light", "dark"):
                label = f"{size['width']}x{size['height']} {scheme}"
                page = self.page("ada", scheme=scheme, viewport=size)
                page.goto(f"/projects/{self.ids['project']}")
                stream = page.locator(".project-convo")
                expect(stream.get_by_label("Write a message", exact=True)).to_be_visible()
                self.assertEqual(self.composer_problems(stream, thread=False), [], f"{label} stream")
                if size["width"] == 390:
                    shot(page, f"people-ai-390-{scheme}-composer")

                self.open_thread(page, self.ids["jonas_root"], self.s["jonas_thread"])
                pane = page.get_by_role("complementary", name="Replies")
                self.assertEqual(self.composer_problems(pane, thread=True), [], f"{label} thread")
                # Each function works: Attach opens a file chooser, Sources the tray, the orb ask mode.
                plus = pane.get_by_role("button", name="Attach or cite", exact=True)
                plus.tap()
                with page.expect_file_chooser() as chooser:
                    pane.get_by_role("button", name="Attach files", exact=True).tap()
                chooser.value.set_files([])
                expect(plus).to_have_attribute("aria-expanded", "false")
                plus.tap()
                pane.get_by_role("button", name=re.compile("^Sources")).tap()
                expect(page.get_by_role("region", name="Project materials")).to_be_visible()
                plus.tap()
                expect(page.get_by_role("region", name="Project materials")).to_have_count(0)
                plus.tap()
                page.keyboard.press("Escape")
                expect(plus).to_have_attribute("aria-expanded", "false")
                expect(plus).to_be_focused()
                ask = pane.get_by_role("button", name="Ask my assistant", exact=True)
                ask.tap()
                expect(ask).to_have_attribute("aria-pressed", "true")
                expect(pane.get_by_label("Ask your assistant", exact=True)).to_be_visible()
                if size["width"] == 390:
                    shot(page, f"people-ai-390-{scheme}-composer-ask")
                ask.tap()
                expect(ask).to_have_attribute("aria-pressed", "false")
                field = pane.get_by_label("Reply", exact=True)
                field.fill("Thanks, both runs look good.")
                with page.expect_response(lambda response: response.request.method == "POST" and "/messages" in response.url) as posted:
                    pane.get_by_role("button", name="Send reply", exact=True).tap()
                self.assertEqual(posted.value.status, 201)
                expect(field).to_have_value("")

        # Negative controls: a hidden "+" and an assistant without its orb are reported.
        page = self.page("ada")
        self.open_thread(page, self.ids["jonas_root"], self.s["jonas_thread"])
        pane = page.get_by_role("complementary", name="Replies")
        page.add_style_tag(content=".composer__plus { display: none !important; } .composer__ask--orb .ui-orb { display: none !important; }")
        problems = self.composer_problems(pane, thread=True)
        self.assertIn("Attach or cite is not reachable", problems)
        page.evaluate("() => document.querySelector('.composer__ask--orb .ui-orb').dataset.orb = 'ember'")
        self.assertIn("the assistant is not its violet orb", self.composer_problems(pane, thread=True))

    def test_08_desktop_keeps_the_11_6_composer_bubbles_names_and_thread_numbers(self) -> None:
        self.assertIn("authors", self.s, "test_01 ran")
        self.ensure_runs()
        page = self.page("ada", phone=False)
        page.goto(f"/projects/{self.ids['project']}")
        list_ = ".project-convo__message-list"
        expect(page.locator(f"{list_} [data-message-id='{self.s['runs'][-1]}']")).to_be_visible()
        expect(page.locator(".project-convo__feed")).not_to_have_attribute("aria-busy", "true")

        def problems() -> list[str]:
            found = []
            rows = [row for row in page.evaluate(self.RUNS, list_) if row["id"]]
            found += [f"{row['id']} has no name" for row in rows if row["continues"] or not row["named"]]
            read = page.evaluate(self.BUBBLES, list_)
            for bubble in read["bubbles"]:
                expected = read["own"] if bubble["mine"] else read["bubble"]
                if bubble["bg"] != expected:
                    found.append(f"{bubble['id']} is on {bubble['bg']}, expected {expected}")
                if bubble["radius"] == ["20px"] * 4:
                    found.append(f"{bubble['id']} has the phone radius")
            box = page.locator(".project-convo .composer__box")
            if page.get_by_role("button", name="Attach or cite", exact=True).count():
                found.append("a phone + on desktop")
            for name in ("Attach files", "Sources"):
                if not box.get_by_role("button", name=re.compile(f"^{name}")).first.is_visible():
                    found.append(f"{name} is not in the composer")
            return found

        self.assertEqual(problems(), [])
        self.open_thread(page, self.ids["jonas_root"], self.s["jonas_thread"])
        pane = page.get_by_role("complementary", name="Replies")
        expect(pane.get_by_role("button", name="Ask my assistant", exact=True).locator("svg")).to_have_count(1)
        expect(pane.locator(".ui-orb")).to_have_count(0)
        self.assertTrue(page.evaluate("""() => [...document.querySelectorAll('#thread .project-convo__message-meta span')].some((el) => /^#\\d+$/.test(el.textContent))"""),
                        "replies keep their number on desktop")
        # Negative control: the phone bubble leaking to desktop is reported.
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator(f"{list_} [data-message-id='{self.s['runs'][-1]}']")).to_be_visible()
        page.add_style_tag(content=".project-convo__message.is-mine > p { background: var(--action) !important; border-radius: 20px !important; }")
        self.assertTrue(any("phone radius" in problem for problem in problems()))

if __name__ == "__main__":
    unittest.main()
