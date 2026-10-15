"""Native touch transport for maintained Python UI tests; never alters product events in the DOM."""
from contextlib import contextmanager
from importlib.metadata import version
from itertools import count
import os
from pathlib import Path

_TOUCH_IDS = count(1)


@contextmanager
def native_touch_driver(engine):
    """Enable the private RPC only while starting this matched WebKit driver; restore process env."""
    if engine != "webkit":
        yield
        return
    if version("playwright") != "1.62.0":
        raise RuntimeError("FLUX_NATIVE_TOUCH_UNSUPPORTED: Python Playwright 1.62.0 is required")
    from playwright._impl._driver import compute_driver_executable
    node, cli = compute_driver_executable()
    package = Path(cli).parent
    preload = Path(__file__).with_name("native_touch_driver.mjs").resolve()
    if not Path(node).is_file() or not (package / "index.js").is_file() or not preload.is_file():
        raise RuntimeError("FLUX_NATIVE_TOUCH_UNSUPPORTED: matched bundled driver/preloader missing")
    if any(char.isspace() for char in str(preload)):
        raise RuntimeError("FLUX_NATIVE_TOUCH_UNSUPPORTED: preloader path contains whitespace")
    values = {"FLUX_UI_PW_DRIVER_PACKAGE": str(package), "FLUX_UI_NATIVE_TOUCH_RPC": "1",
              "NODE_OPTIONS": (os.environ.get("NODE_OPTIONS", "") + " --import=" + str(preload)).strip()}
    previous = {name: os.environ.get(name) for name in values}
    try:
        os.environ.update(values)
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def _webkit_command(page, kind, point):
    impl = page._impl_obj
    witness = page._sync(impl._channel.send_return_as_dict(
        "fluxNativeTouch", None, {"type": kind, "point": point}, is_internal=True))
    if witness != {"pageGuid": impl._guid, "transport": "webkit-native", "version": "1.62.0", "revision": "2336"}:
        raise RuntimeError("FLUX_NATIVE_TOUCH_UNSUPPORTED: wrong native transport or product Page GUID")


def drag_touch(page, from_y, to_y, x=195):
    engine = page.context.browser.browser_type.name
    if engine == "chromium":
        # Original DetailPanelFinal.drag body, including all original timing and CDP payloads.
        cdp = page.context.new_cdp_session(page)
        steps = 8
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": from_y}]})
        for index in range(1, steps + 1):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": from_y + (to_y - from_y) * index / steps}]})
            page.wait_for_timeout(16)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_timeout(500)
        return
    if engine != "webkit":
        raise RuntimeError("FLUX_NATIVE_TOUCH_UNSUPPORTED: native sheet drag supports Chromium/WebKit only")
    touch_id = next(_TOUCH_IDS)
    # The pinned native WebKit backend parses integer CSS points; rounding stays within half a pixel.
    point = lambda y: {"x": round(x), "y": round(y), "id": touch_id}
    _webkit_command(page, "touchStart", point(from_y))
    for index in range(1, 9):
        _webkit_command(page, "touchMove", point(from_y + (to_y - from_y) * index / 8))
        page.wait_for_timeout(16)
    _webkit_command(page, "touchEnd", point(to_y))
    page.wait_for_timeout(500)


async def native_touch_sender(page):
    """Async counterpart for a maintained single-touch journey; Chromium keeps its exact CDP payloads."""
    engine = page.context.browser.browser_type.name
    if engine not in ("chromium", "webkit"):
        raise RuntimeError("FLUX_NATIVE_TOUCH_UNSUPPORTED: native touch supports Chromium/WebKit only")
    cdp = await page.context.new_cdp_session(page) if engine == "chromium" else None
    touch_id = next(_TOUCH_IDS)
    last = None

    async def send(kind, x=None, y=None):
        nonlocal last
        if kind not in ("touchStart", "touchMove", "touchEnd", "touchCancel"):
            raise RuntimeError("FLUX_NATIVE_TOUCH_UNSUPPORTED: only single-point touch commands are supported")
        if kind in ("touchStart", "touchMove"):
            if x is None or y is None:
                raise RuntimeError("FLUX_NATIVE_TOUCH_UNSUPPORTED: native touch needs CSS coordinates")
            last = (x, y)
        if last is None:
            raise RuntimeError("FLUX_NATIVE_TOUCH_UNSUPPORTED: native touch must start before release")
        if cdp is not None:
            points = [] if kind in ("touchEnd", "touchCancel") else [{"x": x, "y": y}]
            await cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": points})
            return
        # Accepted native WebKit backend needs integer CSS points (at most half-pixel rounding).
        point = {"x": round(last[0]), "y": round(last[1]), "id": touch_id}
        impl = page._impl_obj
        witness = await impl._channel.send_return_as_dict(
            "fluxNativeTouch", None, {"type": kind, "point": point}, is_internal=True)
        if witness != {"pageGuid": impl._guid, "transport": "webkit-native", "version": "1.62.0", "revision": "2336"}:
            raise RuntimeError("FLUX_NATIVE_TOUCH_UNSUPPORTED: wrong native transport or product Page GUID")

    return send
