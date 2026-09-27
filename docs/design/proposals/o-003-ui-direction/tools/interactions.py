"""Interaction checks for O-003 variant C in Docker Playwright (Chromium).

Run from the repository root:
  docker run --rm -v "$PWD/docs/design/proposals/o-003-ui-direction:/work" -w /work \
    mcr.microsoft.com/playwright/python:v1.62.0-noble-arm64 \
    sh -c "pip install -q playwright==1.62.0 && python3 tools/interactions.py"

Covers modal focus containment, the Map as a thinking surface, the #44 DM -> sketch -> project scenario,
the #57 personal-assistant states and the earlier conversation journey, in both identity options.
Writes interactions.json. Exercises the static prototype only: no persistence, permissions or model calls.
"""

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = f"file://{ROOT / 'variant-c-calm-messenger.html'}"
IDENTITIES = {"rail": "", "accent": "?identity=accent"}
results = []


def check(name, ok, detail=""):
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


def page_for(browser, w, h, url, **kw):
    touch = w <= 1024
    pg = browser.new_page(viewport={"width": w, "height": h}, is_mobile=touch, has_touch=touch, **kw)
    pg.errors = []
    pg.on("console", lambda m: pg.errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.goto(url)
    pg.wait_for_timeout(350)
    return pg


INSIDE = "sel => { const m = document.querySelector(sel), a = document.activeElement; return !!m && m.contains(a) && a !== document.body; }"
ACTIVE = "() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) + '|' + (a.textContent || '').trim().slice(0, 20) : 'none'; }"


def contain(pg, modal, label):
    """30 Tab and 30 Shift+Tab presses never leave the modal; outside targets (skip link) are inert."""
    check(f"{label}: {modal} is aria-modal", pg.eval_on_selector(modal, "m => m.getAttribute('aria-modal') === 'true'"))
    check(f"{label}: skip link inert while open", pg.evaluate("() => document.querySelector('.skip').inert"))
    escaped, seen = [], set()
    for key in ("Tab", "Shift+Tab"):
        for i in range(30):
            pg.keyboard.press(key)
            seen.add(pg.evaluate(ACTIVE))
            if not pg.evaluate(INSIDE, modal):
                escaped.append(f"{key} #{i + 1}: {pg.evaluate(ACTIVE)}")
    check(f"{label}: 30 Tab + 30 Shift+Tab stay inside {modal}", not escaped, "; ".join(escaped[:3]))
    check(f"{label}: focus moves between several targets", len(seen) >= 3, str(len(seen)))


def focus_containment(browser):
    for ident, q in IDENTITIES.items():
        for w, h in [(390, 844), (768, 1024)]:
            pg = page_for(browser, w, h, URL + q)
            pg.click("#review-btn")
            pg.wait_for_timeout(450)
            contain(pg, "#panel", f"{ident} {w}x{h} details sheet")
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(350)
            check(f"{ident} {w}x{h} sheet: Esc returns focus to Review result", pg.evaluate("() => document.activeElement.id") == "review-btn")
            check(f"{ident} {w}x{h} sheet: skip link usable again", not pg.evaluate("() => document.querySelector('.skip').inert"))
            pg.close()
        for w, h in [(390, 844), (768, 1024), (1024, 768)]:
            pg = page_for(browser, w, h, URL + q)
            pg.click("#menu-btn")
            pg.wait_for_timeout(400)
            contain(pg, "#sidebar", f"{ident} {w}x{h} drawer")
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(300)
            check(f"{ident} {w}x{h} drawer: Esc returns focus to the menu button", pg.evaluate("() => document.activeElement.id") == "menu-btn")
            pg.close()
        # Sheets opened in the other places are contained too.
        pg = page_for(browser, 390, 844, URL + q + "#lamp")
        pg.click("#kai-proposal .ref[data-open='kai-assistant']")
        pg.wait_for_timeout(450)
        contain(pg, "#panel", f"{ident} 390x844 Kai's assistant sheet")
        pg.close()
        pg = page_for(browser, 390, 844, URL + q + "#dm-sketch")
        pg.click("#promote-btn")
        pg.wait_for_timeout(450)
        contain(pg, "#panel", f"{ident} 390x844 new-project sheet")
        pg.close()


NODE_X = "id => parseFloat(document.querySelector(`#sk-lamp .sk-node[data-id='${id}']`).style.getPropertyValue('--x'))"
COUNT = "sel => document.querySelectorAll(sel).length"


def sketch(browser, ident, q):
    pg = page_for(browser, 1440, 900, URL + q + "#lamp-map")
    n = lambda: pg.evaluate(COUNT, "#sk-lamp .sk-node")
    e = lambda: pg.evaluate(COUNT, "#sk-lamp .sk-edges path")
    status = lambda: pg.inner_text("#sk-lamp .sk-status")
    check(f"{ident} map: branching sketch with 9 thoughts and 13 links", n() == 9 and e() == 13, f"{n()} / {e()}")
    deg = pg.evaluate("""() => { const d = {}; document.querySelectorAll('#sk-lamp .sk-edges path').forEach(p => {
      d[p.dataset.a] = (d[p.dataset.a] || 0) + 1; d[p.dataset.b] = (d[p.dataset.b] || 0) + 1; }); return d; }""")
    check(f"{ident} map: many-to-many, not a pipeline (the idea links 4 thoughts, the experiment tests 3)",
          deg.get("n1", 0) >= 4 and deg.get("n8", 0) >= 4 and deg.get("n3", 0) >= 4, str(deg))
    pg.click("#sk-lamp .sk-node[data-id='n3']")
    check(f"{ident} map: click selects without opening a panel", pg.get_attribute("#sk-lamp .sk-node[data-id='n3']", "aria-pressed") == "true"
          and pg.evaluate("() => document.getElementById('panel').hidden"))
    check(f"{ident} map: visible + beside the selection", pg.is_visible("#sk-lamp .sk-plus"))
    pg.click("#sk-lamp .sk-plus")
    pg.wait_for_timeout(100)
    check(f"{ident} map: + adds a connected thought in one action", n() == 10 and e() == 14 and pg.is_visible("#sk-lamp .sk-edit"))
    pg.fill("#sk-lamp .sk-edit", "ToF: swipe + hold only")
    pg.keyboard.press("Enter")
    check(f"{ident} map: inline edit saves with feedback", "ToF: swipe + hold only" in pg.inner_text("#sk-lamp .sk-plane") and "Added" in status(), status())
    # Pointer drag moves the thought and its links; the canvas does not move.
    box = pg.locator("#sk-lamp .sk-node[data-id='n2']").bounding_box()
    x0, d0 = pg.evaluate(NODE_X, "n2"), pg.inner_html("#sk-lamp .sk-edges")
    sl0 = pg.evaluate("() => document.querySelector('#sk-lamp .sk-canvas').scrollLeft")
    pg.mouse.move(box["x"] + 40, box["y"] + 20)
    pg.mouse.down()
    pg.mouse.move(box["x"] + 80, box["y"] + 50, steps=6)
    pg.mouse.move(box["x"] + 100, box["y"] + 60, steps=4)
    pg.mouse.up()
    x1 = pg.evaluate(NODE_X, "n2")
    check(f"{ident} map: drag moves the thought", abs(x1 - x0 - 60) <= 2, f"{x0} -> {x1}")
    check(f"{ident} map: links follow the drag", pg.inner_html("#sk-lamp .sk-edges") != d0)
    check(f"{ident} map: drag does not pan the canvas", pg.evaluate("() => document.querySelector('#sk-lamp .sk-canvas').scrollLeft") == sl0)
    check(f"{ident} map: drag feedback", "Moved" in status(), status())
    check(f"{ident} map: drag does not open a panel", pg.evaluate("() => document.getElementById('panel').hidden"))
    # Keyboard alternative
    pg.focus("#sk-lamp .sk-node[data-id='n4']")
    kx0 = pg.evaluate(NODE_X, "n4")
    pg.keyboard.press("ArrowRight"); pg.keyboard.press("ArrowRight"); pg.keyboard.press("Shift+ArrowDown")
    check(f"{ident} map: arrow keys move the selected thought", pg.evaluate(NODE_X, "n4") == kx0 + 24 and "Moved" in status(), f"{kx0} -> {pg.evaluate(NODE_X, 'n4')}")
    pg.keyboard.press("Enter")
    check(f"{ident} map: Enter edits", pg.is_visible("#sk-lamp .sk-edit") and pg.evaluate("() => document.activeElement.classList.contains('sk-edit')"))
    pg.keyboard.type(" (later)")
    pg.keyboard.press("Escape")
    check(f"{ident} map: Esc cancels the edit and returns focus", "(later)" not in pg.inner_text("#sk-lamp .sk-plane")
          and pg.evaluate("() => document.activeElement.dataset.id") == "n4" and pg.evaluate("() => document.getElementById('panel').hidden"))
    pg.keyboard.press("Control+z")
    check(f"{ident} map: Ctrl+Z undoes the keyboard move in one step", pg.evaluate(NODE_X, "n4") == kx0, str(pg.evaluate(NODE_X, "n4")))
    # Multi-select, connect, undo
    pg.click("#sk-lamp .sk-node[data-id='n2']")
    pg.click("#sk-lamp .sk-node[data-id='n4']", modifiers=["Shift"])
    check(f"{ident} map: Shift-click multi-selects", pg.evaluate(COUNT, "#sk-lamp .sk-node[aria-pressed='true']") == 2 and "2 thoughts selected" in status(), status())
    e0 = e()
    pg.click("#sk-lamp [data-act='connect']")
    check(f"{ident} map: Connect links the selected thoughts", e() == e0 + 1 and "Linked" in status(), status())
    pg.click("#sk-lamp [data-act='undo']")
    check(f"{ident} map: Undo removes the link", e() == e0 and "Undid" in status(), status())
    # Connect mode from one thought, by keyboard
    pg.click("#sk-lamp .sk-node[data-id='n7']")
    pg.click("#sk-lamp [data-act='connect']")
    check(f"{ident} map: Connect with one thought asks for the other", "Choose the thought" in status())
    pg.focus("#sk-lamp .sk-node[data-id='n4']")
    pg.keyboard.press("Enter")
    check(f"{ident} map: Enter on a thought completes the link", e() == e0 + 1 and "Linked" in status(), status())
    # One experiment tests several thoughts
    pg.click("#sk-lamp .sk-node[data-id='n4']")
    pg.click("#sk-lamp .sk-node[data-id='n6']", modifiers=["Shift"])
    pg.click("#sk-lamp [data-act='experiment']")
    pg.keyboard.type("Radar in the dark")
    pg.keyboard.press("Enter")
    check(f"{ident} map: Experiment links one task to both thoughts", pg.evaluate(COUNT, "#sk-lamp .sk-node.k-task") == 2 and e() == e0 + 3
          and "Radar in the dark" in pg.inner_text("#sk-lamp .sk-plane"), f"edges {e()}")
    # List alternative
    pg.click("#sk-lamp [data-mode='list']")
    pg.wait_for_timeout(200)
    check(f"{ident} map: List shows every thought with its links", pg.evaluate(COUNT, "#sk-lamp .sk-list > li") == n()
          and not pg.is_visible("#sk-lamp .sk-canvas") and "Linked to" in pg.inner_text("#sk-lamp .sk-list"))
    pg.focus("#sk-lamp .sk-li-t[data-id='n1']")
    pg.keyboard.press("Enter")
    pg.keyboard.press("End"); pg.keyboard.type(" v1"); pg.keyboard.press("Enter")
    check(f"{ident} map: List items are editable", "Gesture-controlled desk lamp v1" in pg.inner_text("#sk-lamp .sk-list"))
    check(f"{ident} map: no console errors", not pg.errors, "; ".join(pg.errors[:2]))
    pg.close()
    # Touch: tap selects, + adds, and the shared (Tide) map is a sketch too.
    pg = page_for(browser, 390, 844, URL + q + "#lamp-map")
    pg.tap("#sk-lamp .sk-node[data-id='n3']")
    check(f"{ident} 390x844 map: tap selects a thought", pg.get_attribute("#sk-lamp .sk-node[data-id='n3']", "aria-pressed") == "true")
    pb = pg.locator("#sk-lamp .sk-plus").bounding_box()
    check(f"{ident} 390x844 map: + is a 44 px target", pb and pb["width"] >= 44 and pb["height"] >= 44, str(pb))
    pg.tap("#sk-lamp .sk-plus")
    check(f"{ident} 390x844 map: + adds a connected thought", pg.evaluate(COUNT, "#sk-lamp .sk-node") == 10 and pg.is_visible("#sk-lamp .sk-edit"))
    check(f"{ident} 390x844 map: no page overflow", not pg.evaluate("() => document.documentElement.scrollWidth > innerWidth"))
    pg.close()
    pg = page_for(browser, 1440, 900, URL + q + "#map")
    check(f"{ident} Shared export map: branching sketch (9 thoughts, 9 links)", pg.evaluate(COUNT, "#sk-shared .sk-node") == 9 and pg.evaluate(COUNT, "#sk-shared .sk-edges path") == 9)
    pg.click("#sk-shared .sk-node[data-id='s5']")
    check(f"{ident} Shared export map: selecting opens nothing", pg.evaluate("() => document.getElementById('panel').hidden"))
    pg.click("#sk-shared [data-act='open']")
    pg.wait_for_timeout(400)
    check(f"{ident} Shared export map: Open shows the thought's details on request", pg.is_visible("[data-view='handoff']"))
    pg.close()


def lamp_scenario(browser, ident, q, w, h):
    pg = page_for(browser, w, h, URL + q + "#dm")
    tag = f"{ident} {w}x{h} #44"
    check(f"{tag}: the project does not exist yet", pg.evaluate("() => [...document.querySelectorAll('.lamp-link')].every(e => getComputedStyle(e).display === 'none')"))
    check(f"{tag}: DM names its audience", "Only you two" in pg.inner_text("#place-dm .top"))
    pg.click("#dm-select-btn")
    check(f"{tag}: Start is disabled until a message is selected", pg.get_attribute("#dm-start", "aria-disabled") == "true")
    for m in ("m1", "m2", "m3", "m4"):
        pg.click(f"[data-mid='{m}'] .msel")
    check(f"{tag}: 4 messages selected", "4 messages selected" in pg.inner_text("#dm-count") and pg.get_attribute("#dm-start", "aria-disabled") == "false")
    pg.click("#dm-start")
    pg.wait_for_timeout(400)
    check(f"{tag}: sketch starts in the DM from those messages", pg.is_visible("#pane-dm-sketch") and pg.evaluate(COUNT, "#sk-dm .sk-node") == 7)
    check(f"{tag}: sketch thoughts keep their source", "From Kai" in pg.inner_text("#sk-dm .sk-plane") and "Mira" not in pg.inner_text("#sk-dm"))
    check(f"{tag}: no project created by sketching", pg.evaluate("() => [...document.querySelectorAll('.lamp-link')].every(e => getComputedStyle(e).display === 'none')"))
    pg.click("#promote-btn")
    pg.wait_for_timeout(450)
    v = pg.inner_text("[data-view='promote']")
    check(f"{tag}: audience preview 'Jo, Kai — only you two'", "Jo, Kai — only you two" in v)
    check(f"{tag}: preview lists exactly what is shared", "7 thoughts" in v and "4 messages" in v and "The other 3 messages" in v and "not synced" in v)
    pg.click("#promote-go")
    pg.wait_for_timeout(450)
    check(f"{tag}: Create opens the new project", pg.is_visible("#place-lamp") and pg.inner_text("#place-lamp h1") == "Gesture lamp"
          and "fresh" in pg.get_attribute("#place-lamp", "class"))
    check(f"{tag}: the project appears in navigation", pg.evaluate("() => [...document.querySelectorAll('.lamp-link')].some(e => getComputedStyle(e).display !== 'none')"))
    check(f"{tag}: origin line with provenance", "4 messages" in pg.inner_text("#lamp-origin") and "Only Kai and you" in pg.inner_text("#lamp-origin"))
    pg.click("#tab-lamp-map")
    pg.wait_for_timeout(300)
    check(f"{tag}: the sketch moved into the project", pg.evaluate(COUNT, "#sk-lamp .sk-node") == 7)
    check(f"{tag}: no console errors", not pg.errors, "; ".join(pg.errors[:2]))
    pg.close()


def assistant(browser, ident, q):
    tag = f"{ident} #57"
    pg = page_for(browser, 1440, 900, URL + q + "#lamp")
    kp = pg.inner_text("#kai-proposal")
    check(f"{tag}: reader sees 'Kai's assistant drafted this — proposal'", "Kai's assistant drafted this — proposal" in kp and "asked by Kai" in kp)
    check(f"{tag}: reader gets no Accept/Edit/Discard/Retry on Kai's run", not any(x in kp for x in ("Accept", "Discard", "Retry")) and "Waiting for Kai" in kp)
    pg.click("#kai-proposal .ref[data-open='kai-assistant']")
    pg.wait_for_timeout(400)
    v = pg.inner_text("[data-view='kai-assistant']")
    check(f"{tag}: Kai's assistant panel: only Kai can use it, no cost shown", "only Kai can use it" in v and "$" not in v and "can't retry" in v)
    pg.keyboard.press("Escape")
    pg.click("#ask-toggle")
    check(f"{tag}: owner asks their own assistant; audience and payer shown", pg.is_visible("#ask-bar") and "Answer shown to Kai and you" in pg.inner_text("#ask-bar")
          and "paid by you" in pg.inner_text("#ask-bar"))
    pg.fill("#lamp-reply", "Compare the sensors for dim rooms.")
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(150)
    check(f"{tag}: working line with Stop", pg.is_visible("#ai-working") and "Your assistant is reading" in pg.inner_text("#ai-working"))
    pg.wait_for_timeout(1400)
    a = pg.inner_text("#my-answer") if pg.locator("#my-answer").count() else ""
    check(f"{tag}: attributed answer with fact / interpretation / proposal", "Your assistant" in a and "asked by you" in a and "Fact" in a and "Proposal" in a, a[:60])
    check(f"{tag}: composer back to a plain reply", not pg.is_visible("#ask-bar") and pg.get_attribute("#ask-toggle", "aria-pressed") == "false")
    pg.click("#ask-toggle"); pg.fill("#lamp-reply", "Another question"); pg.keyboard.press("Enter")
    pg.wait_for_timeout(100); pg.click("#ai-stop"); pg.wait_for_timeout(1400)
    check(f"{tag}: Stop posts nothing", pg.evaluate(COUNT, "#my-answer") == 1 and not pg.locator("#ai-working").count())
    pg.fill("#lamp-reply", "/ai what next")
    check(f"{tag}: /ai turns on ask mode", pg.get_attribute("#ask-toggle", "aria-pressed") == "true" and pg.input_value("#lamp-reply") == "what next")
    pg.keyboard.press("Escape")
    pg.fill("#lamp-reply", "Tuesday works for the test.")
    pg.keyboard.press("Enter")
    check(f"{tag}: ordinary human reply still posts", "Tuesday works for the test." in pg.inner_text("#lamp-log"))
    check(f"{tag}: no console errors", not pg.errors, "; ".join(pg.errors[:2]))
    pg.close()
    # No assistant connected
    pg = page_for(browser, 1440, 900, URL + (q + "&" if q else "?") + "ai=none#lamp")
    check(f"{tag} none: header offers Connect your AI", pg.is_visible("[aria-label='Connect your AI']") and not pg.is_visible("[aria-label='Your assistant, ready']"))
    check(f"{tag} none: no 'Ask my assistant' on Kai's answer", not pg.is_visible("#ask-about"))
    pg.click("#ask-toggle")
    t = pg.inner_text("#ask-bar")
    check(f"{tag} none: 'Kai's can't be used for you'", "You haven't connected an assistant" in t and "Kai's can't be used for you" in t)
    pg.fill("#lamp-reply", "Summarize this")
    check(f"{tag} none: Send disabled while asking", pg.get_attribute("#lamp-composer .send", "aria-disabled") == "true")
    pg.keyboard.press("Enter")
    check(f"{tag} none: nothing runs or posts", not pg.locator("#ai-working").count() and not pg.locator("#my-answer").count())
    pg.click("#ask-bar [data-open='connect-ai']")
    pg.wait_for_timeout(400)
    check(f"{tag} none: Connect your AI explains it is optional", "Flux works fully without AI" in pg.inner_text("[data-view='connect-ai']"))
    pg.keyboard.press("Escape")
    pg.click("#ask-off")
    pg.fill("#lamp-reply", "No AI needed for this.")
    pg.keyboard.press("Enter")
    check(f"{tag} none: human work continues", "No AI needed for this." in pg.inner_text("#lamp-log"))
    check(f"{tag} none: no console errors", not pg.errors, "; ".join(pg.errors[:2]))
    pg.close()


def journey(browser, ident, q):
    tag = f"{ident} journey"
    pg = page_for(browser, 1440, 900, URL + q)
    pg.click("#review-btn")
    pg.wait_for_timeout(450)
    check(f"{tag}: Review result opens the docked panel", pg.is_visible("[data-view='result']") and pg.get_attribute("#panel", "aria-modal") is None)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(350)
    check(f"{tag}: Esc closes and returns focus", pg.evaluate("() => document.activeElement.id") == "review-btn")
    pg.keyboard.press("]"); pg.wait_for_timeout(400)
    check(f"{tag}: ] opens details", pg.is_visible("[data-view='overview']"))
    pg.keyboard.press("]"); pg.wait_for_timeout(400)
    pg.click("#tab-conversation"); pg.keyboard.press("ArrowRight")
    check(f"{tag}: arrow keys switch views", pg.get_attribute("#tab-tasks", "aria-selected") == "true")
    pg.keyboard.press("Home")
    pg.click("#retry-btn"); pg.wait_for_timeout(2600)
    check(f"{tag}: Retry sends the kept draft", not pg.locator("#failed-msg.failed").count())
    pg.click("[data-place-go='dm'].rail-btn" if ident == "rail" else ".sec-dms [data-place-go='dm']")
    pg.wait_for_timeout(300)
    check(f"{tag}: navigation reaches the DM", pg.is_visible("#place-dm") and not pg.is_visible("#place-shared"))
    pg.click("[data-place-go='lamp'].rail-btn" if ident == "rail" else ".sec-projects [data-place-go='lamp']")
    pg.wait_for_timeout(300)
    check(f"{tag}: navigation reaches Gesture lamp", pg.is_visible("#place-lamp"))
    check(f"{tag}: no console errors", not pg.errors, "; ".join(pg.errors[:2]))
    pg.close()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        focus_containment(browser)
        for ident, q in IDENTITIES.items():
            sketch(browser, ident, q)
            for w, h in [(1440, 900), (390, 844)]:
                lamp_scenario(browser, ident, q, w, h)
            assistant(browser, ident, q)
            journey(browser, ident, q)
        pg = page_for(browser, 1440, 900, URL, reduced_motion="reduce")
        pg.click("#tab-map"); pg.wait_for_timeout(100)
        check("reduced motion: sketch renders without animation", pg.evaluate(COUNT, "#sk-shared .sk-node") == 9)
        pg.close()
        browser.close()
    passed = sum(r["ok"] for r in results)
    (ROOT / "interactions.json").write_text(json.dumps({"passed": passed, "total": len(results), "checks": results}, indent=1) + "\n")
    print(f"\n{passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
