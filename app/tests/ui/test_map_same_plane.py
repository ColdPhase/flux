"""#1553 (C-67): a map looks the same on every device: the phone shows the computer's plane with free pan and pinch zoom, never two
columns; a thought is not moved by a pan; the view is remembered per map and device; a thought's provenance never overlaps itself."""
from __future__ import annotations

import os
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

COMPUTER = {'width': 1440, 'height': 900}
TABLET = {'width': 820, 'height': 1180}
NAME = 'Hubert Osypowicz-Wiśniewski'
# A wide plane: three columns of two, with a thought far to the right and below, so a phone cannot show it all at a readable size.
ROWS = (
    ('Marketing', 40, 40), ('Darmowe kampanie dla schronisk ?', 420, 40), ('ale musi byc jakis efekt widoczny z np, jest duzo starych psow bez adobcji', 800, 40),
    ('Kampania w dwa dni', 40, 300), ('Wyniki: adoptuja', 420, 300), ('Plan na przyszly tydzien', 800, 300),
)


class MapSamePlane(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get('FLUX_UI_BROWSER', 'chromium')).launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(service_workers='block', base_url=ORIGIN)
        response = context.request.post('/api/auth/sign-up/email', data={
            'name': NAME, 'email': f'map-plane-{uuid.uuid4()}@example.test', 'password': 'the same plane everywhere',
        }, headers={'origin': ORIGIN})
        assert response.status == 200, response.text()
        cls.state = context.storage_state()
        cls.workspace = cls.api(context, 'POST', '/api/v1/workspaces', {'name': 'Marketing OH'}, 201)['id']
        context.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def api(context, method, path, body=None, status=200):
        response = context.request.fetch(path, method=method, data=body, headers={'origin': ORIGIN, 'idempotency-key': str(uuid.uuid4())})
        assert response.status == status, response.text()
        return response.json() if response.text() else None

    def page(self, viewport, scheme='light', touch=False):
        context = self.browser.new_context(service_workers='block', base_url=ORIGIN, storage_state=self.state, viewport=viewport, color_scheme=scheme,
            has_touch=touch, is_mobile=touch, device_scale_factor=2 if touch else 1)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], 'no uncaught browser errors'))
        return page

    def make(self, rows=ROWS, link=True):
        """A space's map with `rows` as (text, x, y) and a line between the first two; returns (project, sketch, ids)."""
        context = self.browser.new_context(service_workers='block', base_url=ORIGIN, storage_state=self.state)
        self.addCleanup(context.close)
        project = self.api(context, 'POST', f'/api/v1/workspaces/{self.workspace}/projects', {'name': f'Marketing {uuid.uuid4().hex[:6]}', 'visibility': 'restricted'}, 201)['id']
        sketch = self.api(context, 'POST', f'/api/v1/workspaces/{self.workspace}/sketches', {'title': 'Marketing OH', 'scope': 'project', 'projectId': project}, 201)['id']
        ids = []
        for text, x, y in rows:
            body = {'text': text, 'x': x, 'y': y}
            if link and len(ids) == 1:
                body['linkFrom'] = {'thoughtId': ids[0]}
            ids.append(self.api(context, 'POST', f'/api/v1/sketches/{sketch}/thoughts', body, 201)['thought']['id'])
        return project, sketch, ids

    def open(self, page, project, sketch, count=len(ROWS), fragment=''):
        page.goto(f'/projects/{project}/map/{sketch}{fragment}')
        expect(page.locator('.sk-node')).to_have_count(count)
        page.wait_for_timeout(600)  # the opening view settles (Fit or the remembered one)

    def stored(self, page, sketch):
        return {t['text']: (t['x'], t['y']) for t in self.api(page.context, 'GET', f'/api/v1/sketches/{sketch}')['thoughts']}

    @staticmethod
    def close(first, second, tolerance=2):
        return all(abs(a - b) <= tolerance for a, b in zip(first, second))

    def zoom(self, page):
        return float(page.locator('.sk-zoomed').get_attribute('data-zoom'))

    def scroll(self, page):
        return page.locator('.sk-canvas').evaluate('el => [Math.round(el.scrollLeft), Math.round(el.scrollTop)]')

    def layout(self, page):
        """Each thought's place relative to the first, in plane units (screen distance over the zoom)."""
        zoom = self.zoom(page)
        boxes = {n.inner_text().split('\n')[0]: n.bounding_box() for n in page.locator('.sk-node').all()}
        first = boxes[ROWS[0][0]]
        return {text: (round((box['x'] - first['x']) / zoom), round((box['y'] - first['y']) / zoom), round(box['width'] / zoom)) for text, box in boxes.items()}

    # -- touch through Chromium's own gesture handling
    def cdp(self, page):
        if not hasattr(page, '_cdp'):
            page._cdp = page.context.new_cdp_session(page)
        return page._cdp

    def touch(self, page, kind, *points):
        self.cdp(page).send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': index} for index, (x, y) in enumerate(points)]})

    def swipe(self, page, start, end, *, hold_ms=0, steps=8):
        self.touch(page, 'touchStart', start)
        if hold_ms:
            page.wait_for_timeout(hold_ms)
        for step in range(1, steps + 1):
            self.touch(page, 'touchMove', (start[0] + (end[0] - start[0]) * step / steps, start[1] + (end[1] - start[1]) * step / steps))
            page.wait_for_timeout(16)
        self.touch(page, 'touchEnd')
        page.wait_for_timeout(700)  # a fling settles

    def pinch(self, page, centre, from_gap, to_gap, steps=8):
        def at(gap):
            return (centre[0] - gap / 2, centre[1]), (centre[0] + gap / 2, centre[1])
        self.touch(page, 'touchStart', *at(from_gap))
        for step in range(1, steps + 1):
            self.touch(page, 'touchMove', *at(from_gap + (to_gap - from_gap) * step / steps))
            page.wait_for_timeout(16)
        self.touch(page, 'touchEnd')
        page.wait_for_timeout(300)

    def tap(self, page, point):
        self.touch(page, 'touchStart', point)
        page.wait_for_timeout(40)
        self.touch(page, 'touchEnd')

    def empty_point(self, page):
        """A point on the canvas where nothing but the plane lies (a pan or a double tap there is on empty space)."""
        return page.evaluate('''() => {
          const view = document.querySelector('.sk-canvas').getBoundingClientRect();
          for (let y = view.bottom - 130; y > view.top + 90; y -= 24) for (let x = view.left + 24; x < view.right - 24; x += 24) {
            const hit = document.elementFromPoint(x, y);
            if (hit && (hit.classList.contains('sk-plane') || hit.classList.contains('sk-zoomed'))) return [x, y];
          }
          return null;
        }''')

    def node(self, page, text):
        return page.locator('.sk-node', has_text=text)

    def centre(self, page, text):
        box = self.node(page, text).bounding_box()
        return (box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)

    def test_01_a_phone_shows_the_computers_plane(self):
        project, sketch, ids = self.make()
        for scheme in ('light', 'dark'):
            computer = self.page(COMPUTER, scheme)
            self.open(computer, project, sketch)
            wide = self.layout(computer)
            stored = self.stored(computer, sketch)
            for text, (x, y) in stored.items():
                self.assertTrue(self.close(wide[text][:2], (x - stored[ROWS[0][0]][0], y - stored[ROWS[0][0]][1])), f'the computer draws {text!r} where it was arranged')
            shot(computer, f'same-plane-computer-1440-{scheme}')
            for viewport in (PHONE, {'width': 360, 'height': 780}):
                with self.subTest(scheme=scheme, width=viewport['width']):
                    phone = self.page(viewport, scheme, touch=True)
                    self.open(phone, project, sketch)
                    expect(phone.locator('.sk-canvas[data-layout]')).to_have_count(0)
                    narrow = self.layout(phone)
                    self.assertEqual(narrow.keys(), wide.keys())
                    for text in wide:
                        self.assertTrue(self.close(narrow[text], wide[text]), f'{text!r} stands where the computer has it: {narrow[text]} against {wide[text]}')
                    # The first thought is below the floating header, not hidden under it.
                    header = max(b['y'] + b['height'] for b in (el.bounding_box() for el in phone.locator('.sk-over > *, .sk-map-options').all() if el.is_visible()))
                    self.assertGreaterEqual(self.node(phone, ROWS[0][0]).bounding_box()['y'], header - 1, 'no thought opens under the header')
                    if viewport is PHONE:
                        shot(phone, f'same-plane-phone-390-{scheme}')

    def test_02_one_finger_pans_and_nothing_moves(self):
        page = self.page(PHONE, touch=True)
        project, sketch, ids = self.make()
        self.open(page, project, sketch)
        before = self.stored(page, sketch)
        layout = self.layout(page)
        start = self.scroll(page)
        point = self.empty_point(page)
        self.swipe(page, point, (point[0], point[1] - 140))
        up = self.scroll(page)
        self.assertGreater(up[1], start[1] + 40, f'a finger moving up on empty space pans the plane up: {start} then {up}')
        self.swipe(page, point, (point[0] - 140, point[1]))
        left = self.scroll(page)
        self.assertGreater(left[0], up[0] + 40, f'and a finger moving left pans it sideways: {up} then {left}')
        # The same pan that begins on a selected thought is a pan too.
        node = self.node(page, ROWS[3][0])
        node.scroll_into_view_if_needed()
        node.tap()
        expect(page.locator('.sk-node[aria-pressed="true"]')).to_have_count(1)
        page.wait_for_timeout(300)
        again = self.scroll(page)
        centre = self.centre(page, ROWS[3][0])
        self.swipe(page, centre, (centre[0] + 70, centre[1]))
        after = self.scroll(page)
        self.assertLess(after[0], again[0] - 30, f'a finger on a selected thought pans the plane: {again} then {after}')
        self.assertEqual(before, self.stored(page, sketch), 'no pan moved a thought')
        for text, place in self.layout(page).items():
            self.assertTrue(self.close(place, layout[text]), f'{text!r} is where it was')

    def test_03_two_fingers_pinch_and_a_double_tap_zooms_in(self):
        page = self.page(PHONE, touch=True)
        project, sketch, ids = self.make()
        self.open(page, project, sketch)
        start = self.zoom(page)
        view = page.locator('.sk-canvas').bounding_box()
        centre = (view['x'] + view['width'] / 2, view['y'] + view['height'] / 2)
        self.pinch(page, centre, 80, 200)
        grown = self.zoom(page)
        self.assertGreater(grown, start + 0.1, 'spreading two fingers zooms in')
        self.assertLessEqual(grown, 1.5, 'to 150 % at most')
        self.pinch(page, centre, 220, 60)
        smaller = self.zoom(page)
        self.assertLess(smaller, grown - 0.1, 'pinching in zooms out')
        self.assertGreaterEqual(smaller, 0.6, 'no lower than Fit\'s floor')
        point = self.empty_point(page)
        before = self.zoom(page)
        self.tap(page, point)
        page.wait_for_timeout(120)
        self.tap(page, point)
        page.wait_for_timeout(300)
        self.assertGreater(self.zoom(page), before, 'a double tap on empty space zooms in')
        self.assertEqual(len(self.stored(page, sketch)), len(ROWS))

    def test_04_selecting_a_thought_moves_no_other(self):
        page = self.page(PHONE, touch=True)
        project, sketch, ids = self.make()
        self.open(page, project, sketch)
        for text, _, _ in ROWS[:4]:
            self.node(page, text).scroll_into_view_if_needed()  # the tap may not scroll the map itself
            page.wait_for_timeout(300)
            screen = {n.inner_text().split('\n')[0]: n.bounding_box() for n in page.locator('.sk-node').all()}
            self.node(page, text).tap()
            expect(self.node(page, text)).to_have_attribute('aria-pressed', 'true')
            page.wait_for_timeout(300)
            for other, box in {n.inner_text().split('\n')[0]: n.bounding_box() for n in page.locator('.sk-node').all()}.items():
                self.assertTrue(self.close((box['x'], box['y']), (screen[other]['x'], screen[other]['y']), 1), f'selecting {text!r} moved {other!r} on the screen: {screen[other]} then {box}')
        expect(page.get_by_role('button', name='Thought actions')).to_be_visible()

    def test_05_a_thought_moves_only_after_a_long_press(self):
        page = self.page(TABLET, touch=True)
        project, sketch, ids = self.make()
        self.open(page, project, sketch)
        before = self.stored(page, sketch)
        text = ROWS[1][0]
        centre = self.centre(page, text)
        scroll = self.scroll(page)
        self.swipe(page, centre, (centre[0] - 80, centre[1] - 60))
        self.assertEqual(before, self.stored(page, sketch), 'a quick drag on a thought pans; it does not move it')
        self.assertNotEqual(self.scroll(page), scroll, 'the plane panned under the finger')
        centre = self.centre(page, text)
        self.swipe(page, centre, (centre[0] + 120, centre[1] + 90), hold_ms=700)
        expect(self.node(page, text)).to_have_attribute('aria-pressed', 'true')
        for _ in range(40):
            now = self.stored(page, sketch)
            if now[text] != before[text]:
                break
            page.wait_for_timeout(150)
        self.assertGreater(now[text][0], before[text][0] + 40, 'held first, the thought follows the finger')
        self.assertEqual({k: v for k, v in now.items() if k != text}, {k: v for k, v in before.items() if k != text}, 'only that thought moved')

    def tab(self, page, name):
        page.get_by_role('navigation', name='Space views').get_by_role('tab', name=name).click()

    def test_06_the_view_is_where_you_left_it(self):
        for label, viewport, touch in (('computer', COMPUTER, False), ('phone', PHONE, True)):
            with self.subTest(device=label):
                page = self.page(viewport, touch=touch)
                project, sketch, ids = self.make()
                self.open(page, project, sketch)
                first = self.zoom(page)
                # Framed the first time (the whole map or its top left at a readable size), and not under the header.
                self.assertGreaterEqual(first, 0.6)
                canvas = page.locator('.sk-canvas')
                canvas.evaluate('el => { el.scrollLeft += 160; el.scrollTop += 70; }')
                if touch:
                    point = self.empty_point(page)
                    self.tap(page, point); page.wait_for_timeout(120); self.tap(page, point)
                else:
                    page.get_by_role('button', name='Zoom in').click()
                page.wait_for_timeout(400)
                self.node(page, ROWS[4][0]).tap() if touch else self.node(page, ROWS[4][0]).click()
                expect(self.node(page, ROWS[4][0])).to_have_attribute('aria-pressed', 'true')
                zoom, scroll = self.zoom(page), self.scroll(page)
                self.assertNotEqual(zoom, first, 'the view was changed')
                page.wait_for_timeout(500)
                for how in ('tab', 'back'):
                    self.tab(page, 'Conversation')
                    expect(page.locator('.sk-node')).to_have_count(0)
                    if how == 'tab':
                        self.tab(page, 'Map')
                    else:
                        page.go_back()
                    expect(page.locator('.sk-node')).to_have_count(len(ROWS))
                    page.wait_for_timeout(700)
                    self.assertEqual(self.zoom(page), zoom, f'the same zoom after leaving by {how}')
                    now = self.scroll(page)
                    self.assertLessEqual(abs(now[0] - scroll[0]) + abs(now[1] - scroll[1]), 4, f'the same place after leaving by {how}: {scroll} then {now}')
                    expect(self.node(page, ROWS[4][0])).to_have_attribute('aria-pressed', 'true')
                page.reload()
                expect(page.locator('.sk-node')).to_have_count(len(ROWS))
                page.wait_for_timeout(700)
                self.assertEqual(self.zoom(page), zoom, 'and after a reload')
                # Fit stays available and frames the map again.
                if touch:
                    page.get_by_role('button', name='Map options').tap()
                    page.get_by_role('dialog', name='Map options').get_by_role('button', name='Fit the map to the view').tap()
                else:
                    page.get_by_role('button', name='Fit the map to the view').click()
                page.wait_for_timeout(500)
                self.assertNotEqual(self.scroll(page), scroll)

    def test_07_a_link_to_a_thought_centres_it(self):
        for label, viewport, touch in (('computer', COMPUTER, False), ('phone', PHONE, True)):
            with self.subTest(device=label):
                page = self.page(viewport, touch=touch)
                project, sketch, ids = self.make()
                # A view left elsewhere on this device is not restored over a link to a thought.
                self.open(page, project, sketch)
                page.locator('.sk-canvas').evaluate('el => { el.scrollLeft = 0; el.scrollTop = 0; }')
                page.wait_for_timeout(600)
                linked = page.context.new_page()
                self.addCleanup(linked.close)
                text = ROWS[5][0]
                self.open(linked, project, sketch, fragment=f'#thought-{ids[5]}')
                box = self.node(linked, text).bounding_box()
                view = linked.locator('.sk-canvas').bounding_box()
                self.assertAlmostEqual(box['x'] + box['width'] / 2, view['x'] + view['width'] / 2, delta=view['width'] * 0.22, msg='centred sideways')
                self.assertAlmostEqual(box['y'] + box['height'] / 2, view['y'] + view['height'] / 2, delta=view['height'] * 0.22, msg='and up and down')
                expect(self.node(linked, text)).to_have_attribute('aria-pressed', 'true')

    def test_08_a_thoughts_provenance_never_overlaps_itself(self):
        """#1553/#1568: at 360 px a card with a long author name keeps "(you)" and the time whole and clamps the name to its first
        letters with an ellipsis; no part is over another and none is outside the card."""
        rows = (('Darmowe kampanie dla schronisk ?', 40, 40), ('Marketing', 420, 40))
        for width in (360, 390):
            with self.subTest(width=width):
                page = self.page({'width': width, 'height': 780}, touch=True)
                project, sketch, ids = self.make(rows)
                self.open(page, project, sketch, count=2)
                page.evaluate('document.fonts.ready.then(() => true)')  # measured in the face the person sees
                page.wait_for_timeout(300)
                node = self.node(page, rows[0][0])
                meta = node.locator('.sk-p')
                text = meta.text_content()
                self.assertTrue(text.startswith(f'From {NAME} (you) · '), text)
                self.assertTrue(meta.get_attribute('title').startswith(f'From {NAME} (you) · '), 'the whole line is its title')
                parts = meta.evaluate("""el => [...el.children].map((c) => { const b = c.getBoundingClientRect(); return {cls: c.className, text: c.textContent, left: b.left, right: b.right, whole: c.scrollWidth <= c.clientWidth + 0.5}; })""")
                card = node.bounding_box()
                for before, after in zip(parts, parts[1:]):
                    self.assertLessEqual(before['right'], after['left'] + 0.5, f'{before["text"]!r} runs over {after["text"]!r}: {parts}')
                for part in parts:
                    self.assertLessEqual(part['right'], card['x'] + card['width'] + 0.5, f'{part["text"]!r} reaches past the card: {parts}')
                by = {part['cls']: part for part in parts if part['cls'] != 'sk-p__w'}
                self.assertEqual([p['text'] for p in parts if p['cls'] == 'sk-p__w'], ['From ', ' (you)'], 'the lead and "(you)" are whole')
                self.assertTrue(by['sk-p__t']['whole'], f'the time stays whole: {parts}')
                self.assertGreaterEqual(by['sk-p__n']['right'] - by['sk-p__n']['left'], 12, f'the name keeps its first letters: {parts}')
                self.assertFalse(by['sk-p__n']['whole'], 'and ends in an ellipsis, since the full name does not fit')
                if width == 360:
                    shot(page, 'same-plane-meta-360-light')


if __name__ == '__main__':
    unittest.main()
