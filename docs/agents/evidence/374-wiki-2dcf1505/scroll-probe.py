from __future__ import annotations

import json
import unittest
from pathlib import Path

from playwright.sync_api import expect
from test_app_shell import ORIGIN, PHONE, SHOTS, shot
from test_wiki_final import WikiFinal


class WikiMenuScrollProbe(WikiFinal):
    def open(self, viewport, theme, touch=False):
        # Keep phone CSS dimensions/touch support but leave WebKit desktop input enabled for a real wheel gesture.
        context = self.browser.new_context(
            base_url=ORIGIN, viewport=viewport, storage_state=self.state,
            color_scheme=theme, locale="en-GB", has_touch=True,
            device_scale_factor=2, service_workers="block",
        )
        self.addCleanup(context.close)
        context.add_init_script(f"localStorage.setItem('flux.theme', '{theme}')")
        page = context.new_page()
        page.goto(f"/projects/{self.project_id}/docs/{self.doc_id}")
        expect(page.get_by_role("heading", level=2, name="Hardware")).to_be_visible()
        return page

    def test_last_page_action_scrolls_into_view_and_opens_details(self) -> None:
        page = self.open(PHONE, "light", touch=True)
        more = page.locator("header.top").get_by_role("button", name="More", exact=True)
        more.tap()
        pop = page.get_by_role("dialog", name="Page actions")
        expect(pop).to_be_visible()
        last = pop.locator(".wiki-pop__item").last
        self.assertIn("Details", last.inner_text())

        before = pop.evaluate("el => ({scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, rect: (() => { const r = el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()})")
        box = pop.bounding_box()
        assert box is not None
        # A real browser wheel gesture over the open menu, not an element.scrollIntoView call.
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        for _ in range(4):
            page.mouse.wheel(0, 160)
            page.wait_for_timeout(150)
        page.wait_for_function("() => { const menu = document.querySelector('.wiki-pop'); const row = menu?.querySelector('.wiki-pop__item:last-child'); if (!menu || !row) return false; const m = menu.getBoundingClientRect(); const r = row.getBoundingClientRect(); return menu.scrollTop > 0 && r.bottom <= m.bottom + 1; }", timeout=3000)

        after = pop.evaluate("el => ({scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, rect: (() => { const r = el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()})")
        details_box = last.bounding_box()
        nav_box = page.locator(".ui-bottomnav").bounding_box()
        viewport = page.evaluate("() => ({width: innerWidth, height: innerHeight})")
        assert details_box is not None and nav_box is not None
        overlaps_nav = max(0, min(details_box["y"] + details_box["height"], nav_box["y"] + nav_box["height"]) - max(details_box["y"], nav_box["y"]))
        center = {"x": details_box["x"] + details_box["width"] / 2, "y": details_box["y"] + details_box["height"] / 2}
        hit = page.evaluate("({x,y}) => { const hit = document.elementFromPoint(x,y); const rows = [...document.querySelectorAll('.wiki-pop__item')]; const last = rows[rows.length - 1]; return !!last && !!hit && (last === hit || last.contains(hit)); }", center)
        env = page.evaluate("() => ({pointerCoarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches, maxTouchPoints: navigator.maxTouchPoints})")
        metrics = {"browserViewportMode": "WebKit is_mobile=False; 390x844 CSS viewport; has_touch=True", "environment": env, "before": before, "after": after, "details": details_box, "bottomNav": nav_box, "viewport": viewport, "detailsNavOverlapPx": overlaps_nav, "centerHitTargetsDetails": hit}
        if SHOTS:
            (SHOTS / "wiki-page-actions-scroll-probe.json").write_text(json.dumps(metrics, indent=2) + "\n")
        self.assertGreater(after["scrollTop"], before["scrollTop"], metrics)
        self.assertGreater(after["scrollHeight"], after["clientHeight"], metrics)
        self.assertGreaterEqual(details_box["y"], after["rect"]["top"] - 1, metrics)
        self.assertLessEqual(details_box["y"] + details_box["height"], after["rect"]["bottom"] + 1, metrics)
        self.assertGreaterEqual(details_box["y"], 0, metrics)
        self.assertLessEqual(details_box["y"] + details_box["height"], viewport["height"], metrics)
        self.assertEqual(overlaps_nav, 0, metrics)
        self.assertTrue(hit, metrics)
        shot(page, "wiki-phone-390-page-actions-scrolled")
        page.touchscreen.tap(center["x"], center["y"])
        expect(page.get_by_role("dialog", name="Details")).to_be_visible()
