"""Shared realistic fixture for the #151 adaptive-layout checks (F-015 ADAPT-1–ADAPT-5).

Two owners share one restricted project with long names, a dense conversation with threads,
a deep map with links spread over a wide plane, active and blocked tasks, wiki prose and the
F-017 Agents case: Hubert's agent has two personal connections (Codex and Claude Code) and
Marek's agent one. Everything is written through the public API, so the browser checks read
persisted data. Names and content are synthetic test fixtures.
"""

from __future__ import annotations

import time
import uuid

from test_app_shell import ORIGIN

PASSWORD = "the same lamp on every screen"
STAMP = int(time.time() * 1000)
HUBERT = {"name": "Hubert Kowalczyk-Nowakowski", "email": f"hubert.adapt+{STAMP}@example.test"}
MAREK = {"name": "Marek Lis", "email": f"marek.adapt+{STAMP}@example.test"}
WORKSPACE = "Riverside interaction studies"
PROJECT = "Quiet gesture lamp for the bedside, sensor comparison"
SKETCH = "Bedside interaction directions"
OPEN_TASK = "Compare the ToF sensor with the radar prototype in low light"
BLOCKED_TASK = "Try the low-light receiver trace on the second board"
WIKI_PAGE = "How the bedside lamp recognises a gesture"

# Long enough to wrap several lines at every width: the measure, not the screen, sets the line.
PROSE = (
    "We tried the distance sensor at three heights above the pillow. At 40 cm it caught almost every "
    "slow wave of the hand, at 60 cm it missed the quick ones, and the radar prototype stayed steady "
    "at both heights but woke up when the curtain moved. The next step is a quiet hold gesture that "
    "works without recording any camera images, so nothing about the room leaves the lamp."
)
ROOTS = [
    ("hubert", "Starting the comparison notes here. " + PROSE),
    ("marek", "Bench numbers from last night: ToF caught 96% of gestures at 5 lux, the camera only 38%. "
              "Power draw stays under 0.4 W while idle, which is fine for a lamp that is always listening."),
    ("hubert", "Question for the next session: do we keep both sensors on the first board, or pick one now "
               "and keep the second as a spare for the low-light trace?"),
    ("marek", "The receiver trace is blocked until the second board arrives; the supplier says Thursday. "
              "I parked the soldering notes in the wiki so they are not lost in this stream."),
    ("hubert", PROSE + " " + PROSE),
    ("marek", "Short one: the warm-white strip flickers at the lowest step. Probably the PWM frequency."),
    ("hubert", "I sketched the three directions on the map: camera-free gestures, a radar fallback and the "
               "quiet hold. Please add anything that is missing before Friday."),
    ("marek", "Read through the map. The radar fallback needs a link to the power budget, otherwise it looks "
              "free. Added a thought for it."),
    ("hubert", "Agreed. Next: compare the ToF sensor with the radar prototype in low light, with the same "
               "hand movements, and write the result next to the task."),
    ("marek", "Latest: the delivery moved to Monday. I will keep the receiver trace blocked and say so."),
]
REPLIES = [
    ("marek", "Both on the first board, please. The spare can wait; the comparison needs them side by side."),
    ("hubert", "Fine by me. I will route the second I2C bus so they never share an address."),
]
THOUGHTS = [
    # key, text, x, y, parent key
    ("root", "Capture a gesture without recording camera images", 40, 40, None),
    ("tof", "Compare the distance sensor with the radar prototype at three heights", 380, 40, "root"),
    ("radar", "Radar fallback when the room is completely dark", 720, 200, "tof"),
    ("power", "Power budget: under 0.4 W while idle, always listening", 1080, 200, "radar"),
    ("hold", "A quiet hold gesture that turns the light on slowly", 380, 360, "root"),
    ("curtain", "The curtain moving must never wake the lamp", 720, 520, "hold"),
    ("pwm", "Warm-white strip flickers at the lowest step (PWM frequency)", 1080, 520, "curtain"),
    ("trace", "Low-light receiver trace on the second board", 380, 720, "root"),
    ("supplier", "Second board delivery moved to Monday", 720, 860, "trace"),
    ("far", "Long-distance calibration notes for the ceiling lamp", 1500, 1100, "supplier"),
]
TASKS = [
    (OPEN_TASK, "in_progress", None, ("tof", "radar")),
    ("Check long-distance gesture reliability above the pillow", "open", None, ("far",)),
    (BLOCKED_TASK, "blocked", "Waiting for the second board delivery (Monday)", ("trace",)),
    ("Measure the idle power draw with both sensors", "open", None, ("power",)),
    ("Fix the warm-white flicker at the lowest PWM step", "open", None, ("pwm",)),
    ("Write the curtain test procedure", "done", None, ("curtain",)),
]
WIKI_BODY = """A small project. First we make one gesture work, then we add the rest.

## What we want

Moving a hand closer turns the light on. The gesture should also work in low light, and nothing about the room should leave the lamp: no camera images, no audio, no cloud processing. """ + PROSE + """

## What we test

- Gesture recognition in different light, from 1 to 300 lux
- The delay between the gesture and the light, which should feel immediate
- Power draw while running, idle and in the quiet hold

## Running it

```
python capture.py --device 0 --local --lux-log bench.csv
```

""" + PROSE + "\n"


def api(context, method: str, path: str, body: dict | None = None, status: int | tuple = (200, 201)) -> dict:
    response = context.request.fetch(f"{ORIGIN}{path}", method=method, data=body,
                                     headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
    allowed = status if isinstance(status, tuple) else (status,)
    assert response.status in allowed, f"{method} {path}: {response.status} {response.text()}"
    return response.json() if response.text() else {}


def seed(browser) -> dict:
    """Creates the two accounts and the project; returns storage states and ids."""
    states: dict[str, dict] = {}
    ids: dict = {"thoughts": {}, "tasks": {}, "roots": []}
    contexts = {}
    for key, person in (("hubert", HUBERT), ("marek", MAREK)):
        context = browser.new_context(base_url=ORIGIN)
        response = context.request.post("/api/auth/sign-up/email", data={"name": person["name"], "email": person["email"], "password": PASSWORD},
                                        headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        ids[key] = api(context, "GET", "/api/v1/me")["user"]["id"]
        states[key] = context.storage_state()
        contexts[key] = context
    hubert, marek = contexts["hubert"], contexts["marek"]
    ws = api(hubert, "POST", "/api/v1/workspaces", {"name": WORKSPACE})["id"]
    api(hubert, "POST", f"/api/v1/workspaces/{ws}/members", {"email": MAREK["email"], "role": "member"})
    project = api(hubert, "POST", f"/api/v1/workspaces/{ws}/projects", {"name": PROJECT, "visibility": "restricted"})["id"]
    api(hubert, "POST", f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": ids["marek"]}, "role": "contributor"})
    ids.update(workspace=ws, project=project)

    # Conversation: ten roots from both people, the third with a two-reply thread.
    for index, (who, body) in enumerate(ROOTS):
        root = api(contexts[who], "POST", f"/api/v1/projects/{project}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})
        ids["roots"].append({"conversation": root["id"], "message": root["messages"][0]["id"]})
        if index == 2:
            for replier, text in REPLIES:
                api(contexts[replier], "POST", f"/api/v1/conversations/{root['id']}/messages", {"body": text, "clientMessageId": str(uuid.uuid4())})

    # Map: a deep, linked graph that is wider and taller than a laptop canvas.
    sketch = api(hubert, "POST", f"/api/v1/workspaces/{ws}/sketches", {"title": SKETCH, "scope": "project", "projectId": project})["id"]
    ids["sketch"] = sketch
    for key, text, x, y, parent in THOUGHTS:
        extra = {"linkFrom": {"thoughtId": ids["thoughts"][parent]}} if parent else {}
        ids["thoughts"][key] = api(hubert, "POST", f"/api/v1/sketches/{sketch}/thoughts", {"text": text, "x": x, "y": y, **extra})["thought"]["id"]

    # Tasks: active, blocked and finished work linked to the map.
    for title, status, blocker, sources in TASKS:
        body = {"title": title, "status": status, "sources": [{"type": "thought", "id": ids["thoughts"][key]} for key in sources]}
        if blocker:
            body["blocker"] = blocker
        ids["tasks"][title] = api(hubert, "POST", f"/api/v1/projects/{project}/work", body)["id"]

    # Wiki: one published page with long prose.
    ids["doc"] = api(hubert, "POST", f"/api/v1/projects/{project}/docs",
                     {"title": WIKI_PAGE, "body": WIKI_BODY, "state": "published", "reason": "First notes"})["id"]

    # Agents (F-017): Hubert's agent with two personal connections, Marek's with one.
    for who, name, connections in (("hubert", "Hubert's coding agent", (("Desk laptop", "codex"), ("Travel laptop", "claude_code"))),
                                   ("marek", "Marek's coding agent", (("Workshop PC", "claude_code"),))):
        agent = api(contexts[who], "POST", f"/api/v1/workspaces/{ws}/agents", {"name": name, "owner": "self"})["id"]
        api(hubert, "POST", f"/api/v1/projects/{project}/grants", {"principal": {"kind": "agent", "id": agent}, "role": "contributor"})
        for label, client in connections:
            api(contexts[who], "POST", "/api/v1/agent-connections", {"agentId": agent, "selectedProjectIds": [project],
                "scopes": ["flux.context.read", "flux.proposal.write"], "name": label, "clientDesignation": client})
    for context in contexts.values():
        context.close()
    return {"states": states, "ids": ids}
