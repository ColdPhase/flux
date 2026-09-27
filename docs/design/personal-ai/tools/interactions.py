"""Exercise the #57 prototype's interactions in Docker Playwright (same image as tools/audit.py).

  docker run --rm -v "$PWD/docs/design/personal-ai:/work" -w /work \
    mcr.microsoft.com/playwright/python:v1.62.0-noble python3 tools/interactions.py

Each check prints PASS/FAIL. This proves static prototype behavior only: no model, billing,
permission or persistence is involved.
"""

from pathlib import Path

from playwright.sync_api import sync_playwright

URL = f"file://{Path(__file__).resolve().parents[1] / 'prototype.html'}"
results = []


def check(name, ok):
    results.append((name, bool(ok)))
    print("PASS" if ok else "FAIL", name)


def page_for(browser, suffix="", w=1440, h=900, touch=False):
    page = browser.new_page(viewport={"width": w, "height": h}, is_mobile=touch, has_touch=touch)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + suffix)
    page.wait_for_timeout(300)
    return page, errors


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()

        # 1. Plain reply stays a human message; no assistant involved.
        page, errors = page_for(b)
        page.fill("#reply", "Tuesday works for me.")
        page.keyboard.press("Enter")
        page.wait_for_timeout(900)
        last = page.locator(".feed-in > article").last
        check("plain reply is posted as a human message", "Tuesday works" in last.inner_text() and "assistant" not in last.inner_text().lower())

        # 2. Slash command opens, keyboard picks "Summarize", request runs with a Stop affordance, answer is attributed.
        page.focus("#reply")
        page.keyboard.type("/")
        check("typing / opens the command list", page.is_visible("#slash-menu"))
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        check("choosing a command turns on ask mode with its audience", page.is_visible("#ask-bar") and "Kai and you" in page.inner_text("#ask-bar"))
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        check("a run shows a quiet working line with Stop", page.locator("[data-stop]").count() == 1)
        page.wait_for_timeout(1700)
        ans = page.locator(".msg.ai").last.inner_text()
        check("answer is attributed to the requester's own assistant", "Your assistant" in ans and "asked by you" in ans)
        check("answer labels fact and interpretation", "Fact" in ans and "Interpretation" in ans)
        check("ask mode ends after one request", page.is_hidden("#ask-bar"))

        # 3. Stop before the answer: nothing posted.
        page.click("#ask-toggle")
        page.fill("#reply", "Compare radar too")
        page.keyboard.press("Enter")
        page.wait_for_timeout(200)
        n_before = page.locator(".msg.ai").count()
        page.click("[data-stop]")
        page.wait_for_timeout(1900)
        check("Stop prevents the answer from being posted", page.locator(".msg.ai").count() == n_before and "Nothing was posted" in page.inner_text(".feed-in"))

        # 4. Proposal: Accept records it; Undo is offered.
        page.click("#pr-accept")
        page.wait_for_timeout(1200)
        check("Accept turns the proposal into a recorded result", "Result recorded by you" in page.inner_text("#proposal"))
        check("accepted result offers Undo", page.locator("[data-undo-accept]").count() == 1)

        # 5. Requested map change: Undo removes the thought from the map.
        page.click("#undo-map")
        page.wait_for_timeout(500)
        check("Undo reverts the requested map change", page.locator("#tof-node").is_hidden())

        # 6. Suggestion: "Don't suggest again" leaves one quiet note.
        page.click("#sg-never")
        page.wait_for_timeout(400)
        check("dismissing a suggestion records 'unless the evidence changes'", "unless the evidence changes" in page.inner_text("#suggest"))

        # 7. Pause from the assistant panel hides suggestions and blocks runs; Esc closes and returns focus.
        page.click("#ai-btn")
        page.wait_for_timeout(500)
        page.click("#pause-btn")
        page.click("#p-close")
        page.wait_for_timeout(500)
        page.click("#ask-toggle")
        page.fill("#reply", "Anything")
        check("paused assistant cannot be asked (send disabled)", page.get_attribute(".send", "aria-disabled") == "true" and "Paused" in page.inner_text("#ask-bar"))
        page.keyboard.press("Escape")
        check("Esc leaves ask mode", page.is_hidden("#ask-bar"))
        page.click("#ai-btn")
        page.wait_for_timeout(400)
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        check("Esc closes the panel and returns focus to its trigger", page.evaluate("document.activeElement.id") == "ai-btn")
        check("no console errors (Jo)", not errors)
        page.close()

        # 8. Discard removes the draft without saving.
        page, errors = page_for(b)
        page.click("#pr-discard")
        page.wait_for_timeout(500)
        check("Discard removes the draft and says nothing was saved", page.locator("#jo-proposal").count() == 0 and "Nothing was saved" in page.inner_text(".feed-in"))
        page.close()

        # 9. Peer view: Kai sees Jo's proposal but cannot accept it or see Jo's private suggestion.
        page, errors = page_for(b, "?as=kai")
        check("peer sees 'Jo's assistant drafted this — proposal'", "Jo's assistant drafted this" in page.inner_text("#proposal"))
        check("peer has no Accept/Edit/Discard", page.locator("#pr-accept").is_hidden() and page.locator("#pr-discard").is_hidden())
        check("peer does not see the owner's private suggestion", page.locator("#suggest").is_hidden())
        check("peer cannot undo the owner's map action", page.locator("#undo-map").is_hidden())
        check("no console errors (Kai)", not errors)
        page.close()

        # 10. No connection: asking offers Connect your AI; never another person's assistant.
        page, errors = page_for(b, "?ai=none")
        page.click("#ask-toggle")
        page.fill("#reply", "Summarize")
        bar = page.inner_text("#ask-bar")
        check("without a connection, ask mode offers Connect your AI", "Connect your AI" in bar and "can't be used for you" in bar)
        check("without a connection, send is disabled in ask mode", page.get_attribute(".send", "aria-disabled") == "true")
        check("Kai's answer stays readable without a connection", page.is_visible("#kai-answer"))
        page.close()

        # 11. Cap reached: explicit stop, no other payer.
        page, errors = page_for(b, "?ai=limit")
        page.click("#ask-toggle")
        check("at the cap ask mode says it won't use another payer", "won't use another payer" in page.inner_text("#ask-bar"))
        check("at the cap no proactive suggestion appears", page.locator("#suggest").is_hidden())
        page.close()

        # 12. No AI: no assistant affordances; the human flow is complete.
        page, errors = page_for(b, "?ai=off")
        page.focus("#reply")
        page.keyboard.type("/")
        check("no-AI: no assistant button, no / menu, no assistant messages",
              page.locator("#ask-toggle").is_hidden() and page.is_hidden("#slash-menu") and page.locator(".msg.ai:visible").count() == 0)
        page.fill("#reply", "Board is here.")
        page.keyboard.press("Enter")
        page.wait_for_timeout(900)
        check("no-AI: replies still send", "Board is here." in page.inner_text(".feed-in"))
        page.close()

        # 13. Phone: the assistant panel opens as a modal full-screen sheet with the conversation inert.
        page, errors = page_for(b, "", 390, 844, True)
        page.tap("#ai-btn")
        page.wait_for_timeout(600)
        check("phone: assistant details open as a modal sheet", page.get_attribute("#panel", "aria-modal") == "true" and page.evaluate("document.querySelector('#main').inert"))
        check("no console errors (phone)", not errors)
        page.close()

        # 14. Map selection does not open a panel.
        page, errors = page_for(b, "#map")
        page.click("#tof-node .node-b")
        check("selecting a thought shows actions without opening a panel", page.is_visible("#sel-acts") and page.locator("#panel").is_hidden())
        page.close()
        # 15. Phone first screen: the proposal is read before it is acted on (title, fact, author, actions together).
        for w, h in [(390, 844), (360, 780)]:
            page, errors = page_for(b, "", w, h, True)
            vis = page.evaluate("""() => { const f = document.querySelector('#feed').getBoundingClientRect();
              const inView = s => { const r = document.querySelector(s).getBoundingClientRect(); return r.top >= f.top - 1 && r.bottom <= f.bottom + 1; };
              return ['#jo-proposal .meta', '#proposal .pr-t', '#pr-body .claims dd', '#pr-effect', '#pr-accept'].map(inView); }""")
            check(f"phone {w}x{h}: authorship, title, fact, effect and Accept are all in the first view", all(vis))
            check(f"phone {w}x{h}: a Latest pill leads to the newer messages", page.is_visible("#latest"))
            # Keyboard path: from the proposal's source link, Tab reaches Accept next.
            page.focus("#pr-body .ref")
            page.keyboard.press("Tab")
            check(f"phone {w}x{h}: keyboard goes from the fact's source to Accept", page.evaluate("document.activeElement.id") == "pr-accept")
            page.close()

        # 16. Modal focus containment: 30 Tab and 30 Shift+Tab never leave the sheet or drawer.
        inside = "(sel) => { const a = document.activeElement; return !!a && a !== document.body && !!a.closest(sel); }"
        def walk(page, sel):
            ok = True
            for key in ["Tab"] * 30 + ["Shift+Tab"] * 30:
                page.keyboard.press(key)
                ok = ok and page.evaluate(inside, sel)
            return ok
        for label, suffix, opener, sel in [("click-opened assistant sheet", "", "#ai-btn", "#panel"),
                                           ("hash-opened assistant sheet", "#assistant", None, "#panel"),
                                           ("hash-opened sources sheet", "#sources", None, "#panel"),
                                           ("click-opened drawer", "", "#menu-btn", "#sidebar"),
                                           ("hash-opened drawer", "#nav", None, "#sidebar")]:
            page, errors = page_for(b, suffix, 390, 844, True)
            if opener:
                page.tap(opener)
            page.wait_for_timeout(600)
            check(f"{label}: starts with focus inside", page.evaluate(inside, sel))
            check(f"{label}: skip link and page are inert", page.evaluate("document.querySelector('.skip').inert && document.querySelector('#main').inert"))
            check(f"{label}: 30 Tab + 30 Shift+Tab stay inside", walk(page, sel))
            page.keyboard.press("Escape")
            page.wait_for_timeout(600)
            want = (opener or ("#menu-btn" if sel == "#sidebar" else "#ai-btn" if suffix == "#assistant" else "#details-btn")).lstrip("#")
            check(f"{label}: Esc restores focus to its trigger", page.evaluate("document.activeElement.id") == want)
            check(f"no console errors ({label})", not errors)
            page.close()
        b.close()
    failed = [n for n, ok in results if not ok]
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
