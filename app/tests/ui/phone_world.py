"""One small world for the phone behaviour tests (test_phone_back.py, test_no_keyboard_on_touch.py): Ada (the person on the phone) and Kai in
one workspace with a space that has a conversation with a thread, a task, a decision that needs Ada, and a direct message, plus an agent of Ada's.
Ids are plain strings in the returned dictionary; `states` holds each person's signed-in browser state."""
from __future__ import annotations

import uuid

from phone_audit import call

PASSWORD = "phones keep their keyboards down"
LADDER = "Are you at the garden this afternoon? I have the ladder."


def build(browser, origin: str, stamp: str) -> dict:
    world: dict = {"states": {}, "ids": {}, "emails": {}}
    for who, name in (("ada", "Ada Kowalska"), ("kai", "Kai Tanaka")):
        context = browser.new_context(base_url=origin, service_workers="block")
        email = f"{who}.keys+{stamp}@example.test"
        response = context.request.post("/api/auth/sign-up/email", data={"name": name, "email": email, "password": PASSWORD}, headers={"origin": origin})
        assert response.status == 200, response.text()
        world["ids"][who] = context.request.get("/api/v1/me").json()["user"]["id"]
        world["emails"][who] = email
        world["states"][who] = context.storage_state()
        context.close()

    def api(who: str):
        context = browser.new_context(base_url=origin, storage_state=world["states"][who], extra_http_headers={"origin": origin}, service_workers="block")
        world.setdefault("open", []).append(context)
        return context.request

    ada, kai = api("ada"), api("kai")
    workspace = call(ada, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
    call(ada, "POST", f"/api/v1/workspaces/{workspace['id']}/members", {"email": world["emails"]["kai"], "role": "member"}, 201)
    project = call(ada, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Community garden sensors", "visibility": "workspace"}, 201)
    ids = world["ids"]
    ids.update(workspace=workspace["id"], project=project["id"])
    root = call(kai, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": LADDER, "clientMessageId": str(uuid.uuid4())}, 201)
    for body in ("Yes, and the spare cable.", "Thursday works"):
        call(ada, "POST", f"/api/v1/conversations/{root['id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)
    call(ada, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Soil probes arrive on Friday.", "clientMessageId": str(uuid.uuid4())}, 201)
    ids["conversation"] = root["id"]
    task = call(ada, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Order the replacement probes from the blue box"}, 201)
    ids["task"] = task["id"]
    decision = call(kai, "POST", f"/api/v1/projects/{project['id']}/decisions", {"title": "Water the beds at dawn; frost covers later", "rationale": "Overwatering is the problem now."}, (200, 201))
    ids["decision"] = decision["id"]
    dm = call(ada, "POST", f"/api/v1/workspaces/{workspace['id']}/dms", {"participantIds": [ids["kai"]]}, (200, 201))
    ids["dm"] = dm["id"]
    for who, body in ((kai, "Siema, are you coming on Saturday?"), (ada, "Yes, I bring the ladder.")):
        call(who, "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)
    agent = call(ada, "POST", "/api/v1/my-agents", {"workspaceId": workspace["id"], "name": "Planner"}, 201)
    ids["agent"] = agent["id"]
    for context in world.pop("open"):
        context.close()
    return world
