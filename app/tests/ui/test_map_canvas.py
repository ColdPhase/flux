"""#509 (Spokój, F-026): the map is an infinite canvas: pan in every direction, thoughts in negative space,
zoom around the pointer and by pinching, a minimap and one bottom toolbar with the hand tool. #510 AC-5:
the List keeps the map's pill and toolbar in exactly the same places."""
from __future__ import annotations

import os
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, show_map_as, shot, start_forwarder

BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
FIRST = 'Start at the first thought'
SECOND = 'A thought further right and down'


class MapCanvasJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, BROWSER).launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(base_url=ORIGIN)
        response = context.request.post('/api/auth/sign-up/email', data={
            'name': 'Ada Canvas', 'email': f'map-canvas-{uuid.uuid4()}@example.test',
            'password': 'the plane has no edge anywhere',
        }, headers={'origin': ORIGIN})
        assert response.status == 200, response.text()
        cls.state = context.storage_state()
        cls.workspace = cls.api(context, 'POST', '/api/v1/workspaces', {'name': 'Open whiteboard'}, 201)['id']
        context.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def api(context, method, path, body=None, status=200):
        response = context.request.fetch(path, method=method, data=body, headers={
            'origin': ORIGIN, 'idempotency-key': str(uuid.uuid4()),
        })
        assert response.status == status, response.text()
        return response.json() if response.text() else None

    def page(self, width=1440, height=900, **options):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.state,
            viewport={'width': width, 'height': height}, color_scheme='light', **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], 'no uncaught browser errors'))
        return page

    def scene(self, page, extra=()):
        project = self.api(page.context, 'POST', f'/api/v1/workspaces/{self.workspace}/projects',
            {'name': 'Open plane study', 'visibility': 'restricted'}, 201)['id']
        sketch = self.api(page.context, 'POST', f'/api/v1/workspaces/{self.workspace}/sketches',
            {'title': 'Plane directions', 'scope': 'project', 'projectId': project}, 201)['id']
        for text, x, y in ((FIRST, 0, 0), (SECOND, 300, 180), *extra):
            self.api(page.context, 'POST', f'/api/v1/sketches/{sketch}/thoughts', {'text': text, 'x': x, 'y': y}, 201)
        page.goto(f'/projects/{project}/map/{sketch}')
        show_map_as(page, 'Map')
        expect(page.locator('.sk-node')).to_have_count(2 + len(extra))
        expect(page.locator('.sk-canvas')).to_be_visible()
        return sketch

    def stored(self, page, sketch):
        return self.api(page.context, 'GET', f'/api/v1/sketches/{sketch}')

    @staticmethod
    def scroll(page):
        return page.locator('.sk-canvas').evaluate('el => [el.scrollLeft, el.scrollTop]')

    @staticmethod
    def drag(page, start, end, steps=12):
        page.mouse.move(*start)
        page.mouse.down()
        page.mouse.move(*end, steps=steps)
        page.mouse.up()

    @staticmethod
    def center(locator):
        box = locator.bounding_box()
        return box['x'] + box['width'] / 2, box['y'] + box['height'] / 2

    @staticmethod
    def zoom(page):
        return int(re.search(r'(\d+)%', page.locator('.sk-zoom__level').get_attribute('aria-label')).group(1))

    def empty_point(self, page):
        """A point on empty plane: below the thoughts, left of the corner controls, above the toolbar."""
        canvas = page.locator('.sk-canvas').bounding_box()
        return canvas['x'] + canvas['width'] * 0.55, canvas['y'] + canvas['height'] - 150

    def test_01_a_thought_moves_into_negative_space_and_the_view_holds_still(self):
        page = self.page()
        sketch = self.scene(page)
        node = page.locator('.sk-node', has_text=FIRST)
        other = page.locator('.sk-node', has_text=SECOND)
        version = node.get_attribute('data-thought-version')
        # Pan into the empty plane up and left of the first thought: there is room there now.
        moved_view = page.locator('.sk-canvas').evaluate('el => { const from = [el.scrollLeft, el.scrollTop]; el.scrollLeft -= 300; el.scrollTop -= 300; return [from[0] - el.scrollLeft, from[1] - el.scrollTop]; }')
        self.assertEqual(moved_view, [300, 300], 'the view pans past the first thought, up and left')
        before = other.bounding_box()
        plane = page.locator('.sk-zoomed')
        state = lambda: [plane.get_attribute('data-origin-x'), plane.get_attribute('data-origin-y'), *self.scroll(page), page.locator('.sk-zoom__level').inner_text()]
        was = state()
        start = self.center(node)
        self.drag(page, start, (start[0] - 220, start[1] - 160))
        # The save is confirmed when the thought's version moves on; only then is the stored position read.
        expect(node).not_to_have_attribute('data-thought-version', version)
        moved = next(t for t in self.stored(page, sketch)['thoughts'] if t['text'] == FIRST)
        self.assertLess(moved['x'], 0)
        self.assertLess(moved['y'], 0)
        # The plane grew up and left; the view moved with it, so nothing else jumped.
        after = other.bounding_box()
        self.assertAlmostEqual(after['x'], before['x'], delta=1, msg=f'origin/scroll/zoom {was} -> {state()}')
        self.assertAlmostEqual(after['y'], before['y'], delta=1, msg=f'origin/scroll/zoom {was} -> {state()}')
        # The moved thought lands where it was dropped and the plane still reaches beyond it.
        landed = node.bounding_box()
        self.assertAlmostEqual(landed['x'] + landed['width'] / 2, start[0] - 220, delta=2)
        self.assertGreater(page.locator('.sk-canvas').evaluate('el => el.scrollLeft'), 200, 'room to pan further left')
        page.reload()
        expect(node).to_be_visible()
        self.assertLess(int(node.get_attribute('data-thought-x')), 0)

    def test_02_the_hand_tool_pans_the_plane_with_any_pointer(self):
        page = self.page()
        self.scene(page)
        self.assertEqual(page.locator('.sk-zoomed').evaluate('el => getComputedStyle(el).cursor'), 'grab', 'empty space shows the hand')
        hand = page.get_by_role('button', name='Move around', exact=True)
        hand.click()
        expect(hand).to_have_attribute('aria-pressed', 'true')
        self.assertEqual(page.locator('.sk-node').first.evaluate('el => getComputedStyle(el).cursor'), 'grab')
        before = self.scroll(page)
        # Starting on a thought: with the hand tool the thought is part of the plane.
        start = self.center(page.locator('.sk-node', has_text=SECOND))
        self.drag(page, start, (start[0] - 200, start[1] - 120))
        after = self.scroll(page)
        self.assertAlmostEqual(after[0] - before[0], 200, delta=2)
        self.assertAlmostEqual(after[1] - before[1], 120, delta=2)
        self.assertEqual(page.locator('.sk-node[aria-pressed="true"]').count(), 0, 'panning selects nothing')
        page.get_by_role('button', name='Select', exact=True).click()
        expect(hand).to_have_attribute('aria-pressed', 'false')
        # The pointer tool selects and moves thoughts again.
        page.locator('.sk-node', has_text=FIRST).click()
        expect(page.locator('.sk-node', has_text=FIRST)).to_have_attribute('aria-pressed', 'true')

    def test_03_holding_space_pans_and_a_wheel_scrolls_the_plane(self):
        page = self.page()
        self.scene(page)
        node = page.locator('.sk-node', has_text=FIRST)
        node.click()
        expect(node).to_have_attribute('aria-pressed', 'true')
        # Space on the focused thought still selects it, as before (the keyboard path).
        page.keyboard.press('Space')
        expect(node).to_have_attribute('aria-pressed', 'false')
        point = self.empty_point(page)
        page.mouse.click(*point)
        expect(page.locator('.sk-canvas')).to_be_focused()
        before = self.scroll(page)
        page.keyboard.down('Space')
        self.drag(page, point, (point[0] + 150, point[1] - 90))
        page.keyboard.up('Space')
        after = self.scroll(page)
        self.assertAlmostEqual(before[0] - after[0], 150, delta=2)
        self.assertAlmostEqual(after[1] - before[1], 90, delta=2)
        # A plain wheel (or two fingers on a trackpad) scrolls the plane, and does not zoom.
        level = self.zoom(page)
        page.mouse.move(*point)
        page.mouse.wheel(120, 80)
        page.wait_for_function('([l, t]) => { const el = document.querySelector(".sk-canvas"); return el.scrollLeft !== l && el.scrollTop !== t; }', arg=after)
        self.assertEqual(self.zoom(page), level)

    def test_04_the_minimap_shows_every_thought_and_moves_the_view_on_click_and_drag(self):
        page = self.page()
        self.scene(page)
        minimap = page.locator('.sk-minimap')
        expect(minimap).to_be_visible()
        expect(minimap.locator('svg rect')).to_have_count(2)
        expect(minimap.locator('.sk-minimap__view')).to_be_visible()
        frame = minimap.bounding_box()
        before = self.scroll(page)
        page.mouse.click(frame['x'] + 8, frame['y'] + frame['height'] - 8)
        page.wait_for_function('([l, t]) => { const el = document.querySelector(".sk-canvas"); return el.scrollLeft < l && el.scrollTop > t; }', arg=before)
        clicked = self.scroll(page)
        self.drag(page, (frame['x'] + 8, frame['y'] + frame['height'] - 8), (frame['x'] + frame['width'] - 8, frame['y'] + 8), steps=6)
        dragged = self.scroll(page)
        self.assertGreater(dragged[0], clicked[0], 'dragging right moves the view right')
        self.assertLess(dragged[1], clicked[1], 'dragging up moves the view up')
        shot(page, 'map-canvas-minimap-1440-light')

    def test_05_the_drag_hint_stays_until_the_first_connect(self):
        page = self.page()
        sketch = self.scene(page)
        hint = page.locator('.sk-hint')
        expect(hint).to_contain_text('Drag empty space to move around')
        expect(hint).to_contain_text('Drag a dot to connect')
        node = page.locator('.sk-node', has_text=FIRST)
        node.hover()
        dot = page.locator(f'.sk-dot[data-for="{node.get_attribute("data-id")}"][data-side="right"]')
        self.drag(page, self.center(dot), self.center(page.locator('.sk-node', has_text=SECOND)))
        expect(page.locator('.sk-status')).to_contain_text('Linked')
        expect(page.locator('.sk-status')).to_contain_text('Saved')
        self.assertEqual(len(self.stored(page, sketch)['links']), 1)
        page.locator('.sk-canvas').focus()
        page.keyboard.press('Escape')
        page.reload()
        expect(page.locator('.sk-node').first).to_be_visible()
        expect(page.locator('.sk-hint')).to_have_count(0)

    def test_06_phone_keeps_the_view_and_add_only_layout_without_a_minimap(self):
        page = self.page(390, 844, is_mobile=True, has_touch=True)
        self.scene(page)
        expect(page.locator('.sk-minimap')).to_have_count(0)
        expect(page.locator('.sk-map-options')).to_be_visible()
        expect(page.get_by_role('button', name='Move around', exact=True)).to_have_count(0)
        node = page.locator('.sk-node', has_text=FIRST)
        node.tap()
        node.focus()
        page.keyboard.press('ArrowLeft')
        self.assertEqual(node.get_attribute('data-thought-x'), '0', 'the phone views and adds only (S15)')
        self.assertLessEqual(page.locator('body').evaluate('el => el.scrollWidth'), 390)
        shot(page, 'map-canvas-phone-390-light')

    def test_07_ctrl_wheel_zooms_around_the_pointer(self):
        page = self.page()
        self.scene(page)
        node = page.locator('.sk-node', has_text=SECOND)
        before = node.bounding_box()
        pointer = (before['x'] + 30, before['y'] + 20)
        page.mouse.move(*pointer)
        level = self.zoom(page)
        page.keyboard.down('Control')
        page.mouse.wheel(0, -100)
        page.keyboard.up('Control')
        page.wait_for_function('level => !document.querySelector(".sk-zoom__level").textContent.startsWith(level + "%")', arg=level)
        after = node.bounding_box()
        self.assertGreater(after['width'], before['width'], 'zoomed in')
        self.assertNotIn(self.zoom(page), (110, 125, 150), 'a smooth zoom, not a jump to the next step')
        # The plane point under the pointer stays under it.
        self.assertAlmostEqual((pointer[0] - after['x']) / after['width'], (pointer[0] - before['x']) / before['width'], delta=0.02)
        self.assertAlmostEqual(after['y'] + (pointer[1] - before['y']) * after['width'] / before['width'], pointer[1], delta=2)

    def test_08_two_fingers_pinch_to_zoom_around_their_midpoint(self):
        if BROWSER != 'chromium':
            self.skipTest('multi-touch input is driven through the Chromium DevTools protocol')
        page = self.page(1024, 768, has_touch=True)
        self.scene(page)
        node = page.locator('.sk-node', has_text=SECOND)
        before = node.bounding_box()
        mid = (before['x'] + 40, before['y'] + 30)
        level = self.zoom(page)
        cdp = page.context.new_cdp_session(page)

        def touch(kind, spread):
            points = [] if kind == 'touchEnd' else [
                {'x': mid[0] - spread, 'y': mid[1], 'id': 1}, {'x': mid[0] + spread, 'y': mid[1], 'id': 2}]
            cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': points})

        touch('touchStart', 40)
        for spread in range(44, 84, 4):
            touch('touchMove', spread)
        touch('touchEnd', 0)
        page.wait_for_function('level => !document.querySelector(".sk-zoom__level").textContent.startsWith(level + "%")', arg=level)
        after = node.bounding_box()
        self.assertGreater(self.zoom(page), level, 'spreading two fingers zooms in')
        self.assertAlmostEqual((mid[0] - after['x']) / after['width'], (mid[0] - before['x']) / before['width'], delta=0.03)
        expect(page.locator('.sk-node[aria-pressed="true"]')).to_have_count(0)

    def test_09_keyboard_pans_the_focused_map_and_arrows_move_a_thought_into_negative_space(self):
        page = self.page()
        sketch = self.scene(page)
        canvas = page.locator('.sk-canvas')
        canvas.focus()
        expect(canvas).to_be_focused()
        self.assertEqual(canvas.get_attribute('tabindex'), '0', 'the map is in the tab order')
        before = self.scroll(page)
        page.keyboard.press('ArrowRight')
        page.keyboard.press('Shift+ArrowDown')
        self.assertEqual(self.scroll(page), [before[0] + 48, before[1] + 240])
        node = page.locator('.sk-node', has_text=FIRST)
        version = node.get_attribute('data-thought-version')
        node.focus()
        page.keyboard.press('ArrowLeft')
        page.keyboard.press('Shift+ArrowUp')
        expect(node).to_have_attribute('data-thought-x', '-12')
        expect(node).to_have_attribute('data-thought-y', '-48')
        # With live editing off the keys are sent once they rest, as one burst and one new version; with it on each
        # move is its own ordered command and a version per move. The saved position, not the first new version,
        # says that every move landed.
        moved = None
        for _ in range(50):
            moved = next(t for t in self.stored(page, sketch)['thoughts'] if t['text'] == FIRST)
            if (moved['x'], moved['y']) == (-12, -48):
                break
            page.wait_for_timeout(100)
        self.assertEqual((moved['x'], moved['y']), (-12, -48))
        expect(node).not_to_have_attribute('data-thought-version', version)

    def test_10_one_toolbar_at_the_bottom_and_zoom_with_the_minimap_at_the_bottom_right(self):
        page = self.page()
        self.scene(page, extra=(('Far right and low', 900, 420), ('Far left and high', -400, -200)))
        tools = page.get_by_role('toolbar', name='Sketch tools')
        names = [b.get_attribute('aria-label') or b.inner_text().strip() for b in tools.get_by_role('button').all()]
        self.assertEqual(names, ['Select', 'Move around', 'Thought', 'Create task from selected thoughts', 'Cite the selected thought in the conversation', 'Undo'])
        pane = page.locator('.sk-page').bounding_box()
        bar = tools.bounding_box()
        self.assertAlmostEqual(bar['x'] + bar['width'] / 2, pane['x'] + pane['width'] / 2, delta=12, msg='the toolbar is centred')
        self.assertLess(pane['y'] + pane['height'] - (bar['y'] + bar['height']), 40, 'the toolbar is at the bottom')
        zoom = page.get_by_role('group', name='Zoom', exact=True).bounding_box()
        self.assertLess(pane['x'] + pane['width'] - (zoom['x'] + zoom['width']), 30, 'zoom is at the right')
        self.assertLess(pane['y'] + pane['height'] - (zoom['y'] + zoom['height']), 30, 'zoom is at the bottom')
        minimap = page.locator('.sk-minimap').bounding_box()
        self.assertLess(minimap['y'] + minimap['height'], zoom['y'] + 1, 'the minimap sits above the zoom controls')
        self.assertGreater(zoom['x'], bar['x'] + bar['width'], 'zoom does not overlap the toolbar')
        # Fit shows every thought, clear of the minimap and the zoom controls.
        page.get_by_role('button', name='Fit the sketch to the view', exact=True).click()
        canvas = page.locator('.sk-canvas').bounding_box()

        def overlaps(a, b):
            return a['x'] < b['x'] + b['width'] and b['x'] < a['x'] + a['width'] and a['y'] < b['y'] + b['height'] and b['y'] < a['y'] + a['height']
        page.wait_for_function('() => [...document.querySelectorAll(".sk-node")].every((n) => { const r = n.getBoundingClientRect(); const c = document.querySelector(".sk-canvas").getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1; })')
        for node in page.locator('.sk-node').all():
            box = node.bounding_box()
            self.assertGreaterEqual(box['x'], canvas['x'] - 1)
            self.assertLessEqual(box['x'] + box['width'], canvas['x'] + canvas['width'] + 1)
            for control in (page.locator('.sk-minimap').bounding_box(), page.get_by_role('group', name='Zoom', exact=True).bounding_box(), tools.bounding_box()):
                self.assertFalse(overlaps(box, control), 'Fit keeps every thought clear of the controls')
        shot(page, 'map-canvas-fit-1440-light')

    def test_11_map_and_list_keep_the_pill_and_toolbar_in_the_same_places(self):
        for width, height, touch in ((1440, 900, False), (820, 1180, True), (2560, 1440, False)):
            with self.subTest(width=width):
                page = self.page(width, height, has_touch=touch)
                self.scene(page)
                controls = {
                    'pill': page.locator('.sk-head'),
                    'Map': page.get_by_role('radio', name='Map', exact=True),
                    'List': page.get_by_role('radio', name='List', exact=True),
                    'Thought': page.get_by_role('toolbar', name='Sketch tools').get_by_role('button', name='Thought', exact=True),
                    'Create task': page.get_by_role('button', name='Create task from selected thoughts', exact=True),
                    'Undo': page.get_by_role('toolbar', name='Sketch tools').get_by_role('button', name='Undo', exact=True),
                }
                on_map = {name: control.bounding_box() for name, control in controls.items()}
                expect(page.locator('.sk-hint')).to_be_visible()
                tools = page.get_by_role('toolbar', name='Sketch tools')

                def one_row():
                    centres = tools.get_by_role('button').evaluate_all('buttons => buttons.map((b) => { const r = b.getBoundingClientRect(); return r.top + r.height / 2; })')
                    self.assertLessEqual(max(centres) - min(centres), 2, f'{width}: every tool is on one row: {centres}')
                one_row()
                if touch:
                    # From 900 px down the sidebar is the 64 px rail (#505, #562), so a tablet's pane keeps the label and still one row.
                    expect(tools.get_by_role('button', name='Select several', exact=True)).to_be_visible()
                show_map_as(page, 'List')
                one_row()
                expect(page.get_by_role('tree', name='Thoughts in Plane directions')).to_be_visible()
                on_list = {name: control.bounding_box() for name, control in controls.items()}
                for name in controls:
                    for key in ('x', 'y', 'width', 'height'):
                        self.assertAlmostEqual(on_list[name][key], on_map[name][key], delta=1, msg=f'{width}: {name} {key} stays put')
                expect(page.locator('.sk-hint')).to_have_count(0)
                expect(page.get_by_role('button', name='Move around', exact=True)).to_have_attribute('aria-disabled', 'true')
                shot(page, f'map-list-positions-{width}-light')
                show_map_as(page, 'Map')
                self.assertAlmostEqual(controls['Undo'].bounding_box()['x'], on_map['Undo']['x'], delta=1)

    CORNER = """() => {
        const rect = (el) => { const b = el.getBoundingClientRect(); return {x: b.x, y: b.y, width: b.width, height: b.height}; };
        return {zoom: rect(document.querySelector('.sk-corner .sk-zoom')), minimap: rect(document.querySelector('.sk-minimap')), hint: rect(document.querySelector('.sk-hint'))};
    }"""
    # Every frame in which the zoom group is on screen: where it and the minimap are (changes only), from before the first paint.
    FRAMES = """
      window.__corner = [];
      const tick = () => {
        const zoom = document.querySelector('.sk-corner .sk-zoom'), minimap = document.querySelector('.sk-minimap');
        if (zoom && minimap) {
          const z = zoom.getBoundingClientRect(), m = minimap.getBoundingClientRect(), row = [z.x, z.y, m.x, m.y].map((n) => Math.round(n * 10) / 10);
          const last = window.__corner[window.__corner.length - 1];
          if (!last || last.join() !== row.join()) window.__corner.push(row);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    """

    def corner(self, page):
        """The zoom group, the minimap and the hint once they have stopped changing."""
        expect(page.locator('.sk-hint')).to_be_visible()
        before = page.evaluate(self.CORNER)
        for _ in range(20):
            page.wait_for_timeout(250)
            now = page.evaluate(self.CORNER)
            if now == before:
                return now
            before = now
        return before

    def test_12_the_zoom_group_and_minimap_stay_in_one_place_across_mounts_and_map_list_map(self):
        # #510 gap 2 (#500 audit, Spokoj rule 7): at 820 x 1180 the zoom group sat 10 px lower after Map, List, Map. The height
        # that lifts it above the dock starts at 64 px with every mount and was only measured after the first paint, so a map
        # that had just been mounted showed the group 10 px too low for a frame (the audit read it then); and what the map had
        # seen did not outlive it. Now it is measured before the first paint and kept by the view that owns Map and List.
        for width, height, touch in ((820, 1180, False), (820, 1180, True), (1440, 900, False), (2560, 1440, False)):
            with self.subTest(width=width, touch=touch):
                page = self.page(width, height, has_touch=touch)
                page.add_init_script(self.FRAMES)
                self.scene(page)
                first = self.corner(page)
                for trip in (1, 2):
                    show_map_as(page, 'List', touch=touch)
                    expect(page.get_by_role('tree', name='Thoughts in Plane directions')).to_be_visible()
                    show_map_as(page, 'Map', touch=touch)
                    again = self.corner(page)
                    for name in ('zoom', 'minimap', 'hint'):
                        for key in ('x', 'y', 'width', 'height'):
                            self.assertAlmostEqual(again[name][key], first[name][key], delta=0.5, msg=f'{width}: the {name} {key} is where it was before the List (trip {trip})')
                    zoom, hint = again['zoom'], again['hint']
                    if zoom['x'] < hint['x'] + hint['width'] and hint['x'] < zoom['x'] + zoom['width']:
                        self.assertLessEqual(zoom['y'] + zoom['height'], hint['y'], f'{width}: the zoom group stays clear of the hint line')
                frames = page.evaluate('window.__corner')
                self.assertEqual(len({tuple(row) for row in frames}), 1,
                    f'{width}: the zoom group and the minimap were in one place in every frame, at the first load and after two trips to the List: {frames}')
                page.close()


if __name__ == '__main__':
    unittest.main()
