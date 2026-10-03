"""#223: the real map uses the space left by the project header and Details."""
from __future__ import annotations

import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder


class MapLayoutJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(base_url=ORIGIN)
        response = context.request.post('/api/auth/sign-up/email', data={
            'name': 'Ada Layout', 'email': f'map-layout-{uuid.uuid4()}@example.test',
            'password': 'keep the map inside the working pane',
        }, headers={'origin': ORIGIN})
        assert response.status == 200, response.text()
        cls.state = context.storage_state()
        cls.workspace = cls.api(context, 'POST', '/api/v1/workspaces', {'name': 'Riverside interaction studies'}, 201)['id']
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

    def scene(self, page):
        project = self.api(page.context, 'POST', f'/api/v1/workspaces/{self.workspace}/projects',
            {'name': 'Quiet gesture lamp', 'visibility': 'restricted'}, 201)['id']
        tasks = []
        for title, status, blocker in (
            ('Compare the ToF sensor with the radar prototype', 'in_progress', None),
            ('Check long-distance gesture reliability', 'open', None),
            ('Try the low-light receiver trace', 'blocked', 'Waiting for the sensor delivery'),
        ):
            tasks.append(self.api(page.context, 'POST', f'/api/v1/projects/{project}/work',
                {'title': title, 'status': status, **({'blocker': blocker} if blocker else {})}, 201))
        sketch = self.api(page.context, 'POST', f'/api/v1/workspaces/{self.workspace}/sketches',
            {'title': 'Bedside interaction directions', 'scope': 'project', 'projectId': project}, 201)['id']
        for text, x, y in (
            ('Capture a gesture without recording camera images', 0, 0),
            ('Compare the distance sensor with the radar prototype', 300, 180),
        ):
            self.api(page.context, 'POST', f'/api/v1/sketches/{sketch}/thoughts', {'text': text, 'x': x, 'y': y}, 201)
        page.goto(f'/projects/{project}/map/{sketch}')
        expect(page.locator('.sk-node')).to_have_count(2)
        return tasks[1]

    def assert_hint_inside_pane(self, page):
        hint = page.locator('.sk-help')
        expect(hint).to_be_in_viewport(ratio=1)
        self.assertTrue(hint.evaluate('el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1'),
            'all hint text wraps inside its own box')
        bounds = hint.evaluate('el => { const h = el.getBoundingClientRect(); const p = el.closest(".sk-page").getBoundingClientRect(); return {left:h.left,right:h.right,top:h.top,bottom:h.bottom,pLeft:p.left,pRight:p.right,pTop:p.top,pBottom:p.bottom}; }')
        self.assertGreaterEqual(bounds['left'], bounds['pLeft'])
        self.assertLessEqual(bounds['right'], bounds['pRight'] + 1)
        self.assertGreaterEqual(bounds['top'], bounds['pTop'])
        self.assertLessEqual(bounds['bottom'], bounds['pBottom'] + 1, 'hint stays above the scroll pane bottom')
        self.assertLessEqual(page.locator('body').evaluate('el => el.scrollWidth'), page.viewport_size['width'])

    def test_01_task_details_and_wrapped_header_keep_the_complete_hint_visible(self):
        page = self.page()
        task = self.scene(page)
        page.locator('header.top [data-seg="open"]').click()
        expect(page.locator('#details').get_by_role('heading', name=task['title'], exact=True)).to_be_visible()
        state = page.locator('header.top [aria-label="Current state"]').bounding_box()
        audience = page.locator('header.top .top__audience').bounding_box()
        self.assertGreaterEqual(state['y'], audience['y'] + audience['height'], 'the fixture exercises a wrapped state row')
        shot(page, 'map-layout-task-details-1440-light')
        self.assert_hint_inside_pane(page)
        page.get_by_role('button', name='Close details', exact=True).click()
        self.assert_hint_inside_pane(page)

    def test_02_hint_wraps_on_short_desktop_tablet_and_phone_panes(self):
        for width, height, touch in ((1440, 720, False), (820, 1180, True), (320, 740, True), (390, 844, True)):
            with self.subTest(width=width, height=height):
                page = self.page(width, height, has_touch=touch, is_mobile=width <= 640)
                self.scene(page)
                self.assert_hint_inside_pane(page)
                toolbar = page.get_by_role('toolbar', name='Sketch tools')
                pane = page.locator('.sk-page').bounding_box()
                for button in toolbar.get_by_role('button').all():
                    expect(button).to_be_in_viewport(ratio=1)
                    bounds = button.bounding_box()
                    self.assertGreaterEqual(bounds['x'], pane['x'], 'every map tool stays inside the pane')
                    self.assertLessEqual(bounds['x'] + bounds['width'], pane['x'] + pane['width'] + 1,
                        'the complete Undo button remains reachable at tablet width')
                shot(page, f'map-layout-{width}-{height}-light')

    def test_03_resizing_with_details_retains_camera_selection_and_private_draft(self):
        page = self.page()
        task = self.scene(page)
        sketch = page.url.rsplit('/', 1)[-1]
        far = self.api(page.context, 'POST', f'/api/v1/sketches/{sketch}/thoughts',
            {'text': 'Long-distance calibration notes', 'x': 1500, 'y': 1200}, 201)['thought']['id']
        page.reload()
        expect(page.locator('.sk-node')).to_have_count(3)
        page.get_by_role('button', name='Zoom in', exact=True).click()
        canvas = page.locator('.sk-canvas')
        camera = canvas.evaluate('el => { el.scrollLeft = 80; el.scrollTop = 100; return {left:el.scrollLeft,top:el.scrollTop}; }')
        level = page.locator('.sk-zoom__level').get_attribute('aria-label')
        self.assertGreater(camera['left'], 0)
        self.assertGreater(camera['top'], 0)
        page.locator('header.top [data-seg="open"]').click()
        expect(page.locator('#details').get_by_role('heading', name=task['title'], exact=True)).to_be_visible()
        self.assertEqual(canvas.evaluate('el => ({left:el.scrollLeft,top:el.scrollTop})'), camera)
        self.assertEqual(page.locator('.sk-zoom__level').get_attribute('aria-label'), level)
        self.assert_hint_inside_pane(page)
        page.get_by_role('button', name='Close details', exact=True).click()
        node = page.locator(f'.sk-node[data-id="{far}"]')
        node.focus()
        page.keyboard.press('Space')
        expect(node).to_have_attribute('aria-pressed', 'true')
        page.keyboard.press(']')
        expect(page.locator('#details .ui-panel__body')).to_be_focused()
        expect(node).to_have_attribute('aria-pressed', 'true')
        page.keyboard.press(']')
        expect(node).to_be_focused()
        page.get_by_role('toolbar', name='Sketch tools').get_by_role('button', name='Thought', exact=True).click()
        draft = page.get_by_role('form', name='New thought draft').get_by_label('Thought text')
        draft.fill('Unsent receiver measurements stay private')
        page.locator('header.top [data-seg="open"]').click()
        expect(page.locator('#details').get_by_role('heading', name=task['title'], exact=True)).to_be_visible()
        expect(draft).to_have_value('Unsent receiver measurements stay private')
        page.get_by_role('button', name='Close details', exact=True).click()
        expect(draft).to_have_value('Unsent receiver measurements stay private')
        stored = self.api(page.context, 'GET', f'/api/v1/sketches/{sketch}')
        self.assertEqual(len(stored['thoughts']), 3, 'layout changes never publish a private draft')
        shot(page, 'map-layout-private-draft-1440-light')

    def test_04_very_short_phone_keeps_full_hint_and_draft_reachable_by_scrolling(self):
        page = self.page(320, 430, has_touch=True, is_mobile=True, reduced_motion='reduce')
        self.scene(page)
        page.get_by_role('toolbar', name='Sketch tools').get_by_role('button', name='Thought', exact=True).click()
        draft = page.get_by_role('form', name='New thought draft').get_by_label('Thought text')
        draft.fill('Keep measurements while the keyboard takes space')
        page.locator('.sk-help').scroll_into_view_if_needed()
        expect(page.locator('.sk-help')).to_be_in_viewport(ratio=1)
        self.assertTrue(page.locator('.sk-help').evaluate('el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1'))
        self.assertLessEqual(page.locator('body').evaluate('el => el.scrollWidth'), 320)
        draft.scroll_into_view_if_needed()
        expect(draft).to_have_value('Keep measurements while the keyboard takes space')
        expect(page.get_by_role('form', name='New thought draft').get_by_role('button', name='Cancel', exact=True)).to_be_visible()
