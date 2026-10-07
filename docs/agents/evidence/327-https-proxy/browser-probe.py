import json, re, sys, uuid
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

origin = "https://localhost:19443"
mode = sys.argv[1]
password = "proxy proof " + str(uuid.uuid4())
report = {"origin": origin, "mode": mode, "browserLocalCertificateErrorsIgnored": True, "accounts": [], "uncaughtErrors": []}

def result(path):
    Path(path).write_text(json.dumps(report, indent=2) + "\n")

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    contexts = []
    try:
        expect.set_options(timeout=15000)
        for name in (["Untrusted Proxy Probe"] if mode == "untrusted" else ["Ari HTTPS Probe", "Kai HTTPS Probe"]):
            context = browser.new_context(base_url=origin, ignore_https_errors=True, service_workers="block", viewport={"width": 1440, "height": 900})
            contexts.append(context)
            page = context.new_page()
            page.on("pageerror", lambda err: report["uncaughtErrors"].append(str(err)))
            handshakes, frames = [], []
            cdp = context.new_cdp_session(page)
            cdp.send("Network.enable")
            cdp.on("Network.webSocketHandshakeResponseReceived", lambda event, captured=handshakes: captured.append({"status": event["response"]["status"]}))
            def socket_open(socket, captured=frames):
                def received(payload):
                    try: data = json.loads(payload)
                    except (ValueError, TypeError): return
                    if data.get("type") == "event": captured.append({key: data.get(key) for key in ("type", "id", "kind", "objectType", "objectId")})
                socket.on("framereceived", received)
            page.on("websocket", socket_open)
            email = f"proxy.{mode}+{uuid.uuid4()}@example.test"
            page.goto("/sign-up")
            page.get_by_label("Name", exact=True).fill(name)
            page.get_by_label("Email", exact=True).fill(email)
            page.get_by_label("Password", exact=True).fill(password)
            page.get_by_role("button", name="Create account", exact=True).click()
            expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
            cookie = next(c for c in context.cookies() if "session_token" in c["name"])
            assert cookie["secure"] and cookie["httpOnly"], "Actual HTTPS session must be Secure and HttpOnly"
            account = {"name": name, "email": email, "signupUI": True, "cookie": {key: cookie[key] for key in ("name", "secure", "httpOnly", "sameSite")}}
            report["accounts"].append(account)
            if mode == "trusted":
                page.goto("/sign-out")
                page.get_by_role("button", name="Sign out", exact=True).click()
                expect(page.get_by_role("heading", name="Sign in to Flux", exact=True)).to_be_visible()
                page.get_by_label("Email", exact=True).fill(email)
                page.get_by_label("Password", exact=True).fill(password)
                page.get_by_role("button", name="Sign in", exact=True).click()
                expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                account["signoutUI"] = account["signinUI"] = True
                account["userId"] = page.request.get("/api/v1/me").json()["user"]["id"]
            account["handshakes"] = handshakes
            account["frames"] = frames
            account["page"] = page
        if mode == "trusted":
            owner, peer = report["accounts"]
            def post(path, body):
                response = owner["page"].request.post(path, data=body, headers={"origin": origin})
                assert response.status in (200, 201), f"Fixture request failed: {path} status {response.status}"
                return response.json()
            workspace = post("/api/v1/workspaces", {"name": "HTTPS proxy proof"})
            post(f"/api/v1/workspaces/{workspace['id']}/members", {"email": peer["email"], "role": "member"})
            project = post(f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "One HTTPS origin", "visibility": "restricted"})
            post(f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": peer["userId"]}, "role": "contributor"})
            thread = post(f"/api/v1/projects/{project['id']}/conversations", {"body": "An actual shared thread behind Caddy", "clientMessageId": str(uuid.uuid4())})
            for account in (owner, peer):
                account["page"].goto(f"/projects/{project['id']}/conversations/{thread['id']}")
                expect(account["page"].get_by_role("heading", name="Replies", exact=True)).to_be_visible()
            receiver = peer["page"]
            receiver.evaluate("window.__proxyDocument = document")
            navigations = []
            receiver.on("framenavigated", lambda frame: navigations.append(frame.url) if frame == receiver.main_frame else None)
            assert any(h["status"] == 101 for h in peer["handshakes"]), "Receiver has a real HTTPS WebSocket upgrade101"
            text = "This message crossed the real Caddy WebSocket without reloading"
            sender = owner["page"]
            sender.get_by_label("Reply", exact=True).fill(text)
            with sender.expect_response(lambda response: response.request.method == "POST" and urlsplit(response.url).path == f"/api/v1/conversations/{thread['id']}/messages") as pending:
                sender.get_by_role("button", name="Send reply", exact=True).click()
            answer = pending.value
            assert answer.status == 201, f"Message post status {answer.status}"
            message = answer.json()
            expect(receiver.get_by_role("region", name="Replies to this message", exact=True).get_by_text(text, exact=True)).to_be_visible(timeout=40000)
            matches = [frame for frame in peer["frames"] if frame["objectId"] == project["id"] and frame["kind"] == "project.message_sent.v1"]
            assert matches, "Received the real project.message_sent.v1 stream frame for this isolated project"
            assert receiver.evaluate("window.__proxyDocument === document") and not navigations, "No receiver reload/document navigation"
            sender.screenshot(path="/evidence/sender.png", full_page=True)
            receiver.screenshot(path="/evidence/receiver.png", full_page=True)
            report["messageProof"] = {"messageId": message["id"], "projectId": project["id"], "conversationId": thread["id"], "uiRefreshMechanism": "Production thread refresh polls every 15 seconds; stream receipt independently proven", "matchingFrames": matches, "receiverDocumentUnchanged": True, "receiverNavigations": navigations, "postStatus": answer.status}
            # Extra session with a spoofed client header; inspect only its stored IP later.
            response = sender.request.post("/api/auth/sign-in/email", data={"email": owner["email"], "password": password}, headers={"origin": origin, "X-Forwarded-For": "203.0.113.199"})
            assert response.status == 200, "Spoof-control sign-in succeeds through the ordinary proxy"
            report["spoofControl"] = {"injectedXForwardedFor": "203.0.113.199", "status": response.status}
        assert not report["uncaughtErrors"], "No uncaught browser errors"
    finally:
        for account in report["accounts"]: account.pop("page", None)
        result(f"/evidence/{mode}-browser.json")
        browser.close()
print(f"HTTPS {mode} browser proof PASS")
