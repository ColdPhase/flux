"""Helpers of the v0.2.1 phone audit tests (test_phone_conversations.py, test_phone_text_fit.py): an API call that checks its status, and a
browser context with the platform's own touch emulation (Pixel 7 in Chromium, iPhone 15 in WebKit, Galaxy Tab S4 and iPad Pro 11 for tablets)
at a window of the audit's matrix, optionally with the root font size at 200 % from the first frame (Android's font scale, large text)."""
from __future__ import annotations

import json

UA_DEVICES = {("chromium", "phone"): "Pixel 7", ("chromium", "tablet"): "Galaxy Tab S4", ("webkit", "phone"): "iPhone 15", ("webkit", "tablet"): "iPad Pro 11"}

# The root font size is set before the page's own scripts and styles run, as the system's text size is, not after the page has laid itself out.
TEXT_SIZE_SCRIPT = """(() => {
  const add = () => { const style = document.createElement('style'); style.textContent = 'html { font-size: %d%%; }'; (document.head || document.documentElement).appendChild(style); };
  if (document.head) add(); else new MutationObserver((_, watch) => { if (document.head) { watch.disconnect(); add(); } }).observe(document, { childList: true, subtree: true });
})()"""


def call(request, method: str, path: str, body: dict | None = None, status=200):
    """One API call that fails with the server's words when its status is not the expected one (an int, or a tuple of them)."""
    response = request.fetch(path, method=method, data=json.dumps(body) if body is not None else None,
                             headers={"content-type": "application/json"} if body is not None else {})
    ok = status if isinstance(status, tuple) else (status,)
    if response.status not in ok:
        raise AssertionError(f"{method} {path}: {response.status}, expected {status}: {response.text()}")
    return response.json() if response.text() else None


def window(pw, browser, engine: str, origin: str, state: dict, width: int, height: int, *, kind: str = "phone", text: int | None = None, dark: bool = False):
    """A browser context at `width` x `height`. `kind`: "phone" or "tablet" (touch, coarse pointer, the platform's user agent) or "computer" (mouse)."""
    options: dict = {"base_url": origin, "viewport": {"width": width, "height": height}, "storage_state": state, "device_scale_factor": 1,
                     "reduced_motion": "reduce", "color_scheme": "dark" if dark else "light"}
    if kind != "computer":
        options.update(user_agent=pw.devices[UA_DEVICES[(engine, kind)]]["user_agent"], has_touch=True, is_mobile=True)
    context = browser.new_context(**options)
    if text:
        context.add_init_script(TEXT_SIZE_SCRIPT % text)
    return context
