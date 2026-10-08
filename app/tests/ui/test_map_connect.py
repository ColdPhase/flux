"""#349 (F-026, P12 and S15): drag a thought's dot to connect; the phone only views and adds."""
from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

COMPUTER = {'width': 1440, 'height': 900}
A, B, C = 'Weatherproof enclosure', 'Calibrate the probes', 'Frost warnings later'


class MapConnectJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(base_url=ORIGIN)
        response = context.request.post('/api/auth/sign-up/email', data={
            'name': 'Ada Connect', 'email': f'map-connect-{uuid.uuid4()}@example.test',
            'password': 'drag the dot to connect',
        }, headers={'origin': ORIGIN})
        assert response.status == 200, response.text()
        cls.state = context.storage_state()
        cls.workspace = cls.api(context, 'POST', '/api/v1/workspaces', {'name': 'Community garden'}, 201)['id']
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

    def page(self, viewport, scheme='light', touch=False):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.state, viewport=viewport, color_scheme=scheme,
            has_touch=touch, is_mobile=touch, device_scale_factor=3 if touch else 1)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], 'no uncaught browser errors'))
        return page

    def scene(self, page):
        project = self.api(page.context, 'POST', f'/api/v1/workspaces/{self.workspace}/projects',
            {'name': f'Sensors {uuid.uuid4().hex[:6]}', 'visibility': 'restricted'}, 201)['id']
        sketch = self.api(page.context, 'POST', f'/api/v1/workspaces/{self.workspace}/sketches',
            {'title': 'Community garden sensors', 'scope': 'project', 'projectId': project}, 201)['id']
        for text, x, y in ((f'{A} volunteers can open', 40, 40), (f'{B} at two soil depths', 420, 40), (f'{C}, one probe at the gateway', 40, 260)):
            self.api(page.context, 'POST', f'/api/v1/sketches/{sketch}/thoughts', {'text': text, 'x': x, 'y': y}, 201)
        page.goto(f'/projects/{project}/map/{sketch}')
        expect(page.locator('.sk-node')).to_have_count(3)
        return sketch

    def stored(self, page, sketch):
        return self.api(page.context, 'GET', f'/api/v1/sketches/{sketch}')

    def drag_dot(self, page, source, target=None, point=None):
        """Drag from the dot of `source` onto thought `target`, or release at `point` (page pixels)."""
        node = page.locator('.sk-node', has_text=source)
        node.hover()
        dot = page.locator(f'.sk-dot[data-for="{node.get_attribute("data-id")}"]')
        d = dot.bounding_box()
        page.mouse.move(d['x'] + d['width'] / 2, d['y'] + d['height'] / 2)
        page.mouse.down()
        if target:
            t = page.locator('.sk-node', has_text=target).bounding_box()
            point = (t['x'] + t['width'] / 2, t['y'] + t['height'] / 2)
        page.mouse.move(point[0], point[1], steps=12)
        return point

    def test_01_drag_a_dot_to_connect_and_release_on_empty_space(self):
        for scheme in ('light', 'dark'):
            with self.subTest(scheme=scheme):
                page = self.page(COMPUTER, scheme)
                sketch = self.scene(page)
                self.drag_dot(page, A, target=B)
                shot(page, f'map-connect-drag-1440-{scheme}')
                page.mouse.up()
                expect(page.locator('.sk-status')).to_contain_text('Linked')
                expect(page.locator('.sk-edges path')).to_have_count(1)
                expect(page.locator('.sk-status')).to_contain_text('Saved')
                self.assertEqual(len(self.stored(page, sketch)['links']), 1)
                # Released on empty space: a connected thought exists only as a local draft.
                canvas = page.locator('.sk-canvas').bounding_box()
                point = (canvas['x'] + canvas['width'] * 0.75, canvas['y'] + canvas['height'] * 0.7)
                self.drag_dot(page, B, point=point)
                expect(page.locator('.sk-ghost')).to_contain_text('New thought')
                expect(page.get_by_text('Release to add a connected thought')).to_be_visible()
                shot(page, f'map-connect-release-1440-{scheme}')
                page.mouse.up()
                draft = page.get_by_role('form', name='New thought draft')
                expect(draft).to_contain_text('Connected to')
                expect(draft).to_contain_text('private until saved')
                expect(page.locator('.sk-ghost--draft')).to_be_visible()
                self.assertEqual(len(self.stored(page, sketch)['thoughts']), 3, 'nothing is shared before it is saved')
                draft.get_by_label('Thought text').fill('Solar panel on the enclosure?')
                draft.get_by_label('Thought text').press('Enter')
                expect(page.locator('.sk-node')).to_have_count(4)
                shared = self.stored(page, sketch)
                self.assertEqual((len(shared['thoughts']), len(shared['links'])), (4, 2))
                shot(page, f'map-connect-saved-1440-{scheme}')

    def test_02_connecting_works_without_a_pointer(self):
        page = self.page(COMPUTER)
        sketch = self.scene(page)
        a = page.locator('.sk-node', has_text=A)
        a.focus()
        page.keyboard.press('Space')
        expect(a).to_have_attribute('aria-pressed', 'true')
        page.keyboard.press('Tab')
        expect(page.locator('.sk-dot:focus')).to_have_count(1)
        page.keyboard.press('Enter')
        expect(page.locator('.sk-status')).to_contain_text('Choose the thought to link to')
        page.locator('.sk-node', has_text=C).focus()
        page.keyboard.press('Enter')
        expect(page.locator('.sk-status')).to_contain_text('Linked')
        expect(page.locator('.sk-status')).to_contain_text('Saved')
        self.assertEqual(len(self.stored(page, sketch)['links']), 1)

    def test_03_several_thoughts_become_one_task(self):
        page = self.page(COMPUTER)
        self.scene(page)
        page.locator('.sk-node', has_text=A).click()
        page.locator('.sk-node', has_text=B).click(modifiers=['Shift'])
        page.locator('.sk-node', has_text=C).focus()
        page.keyboard.press('Space')
        expect(page.locator('.sk-node[aria-pressed="true"]')).to_have_count(3)
        tools = page.get_by_role('toolbar', name='Sketch tools')
        expect(tools.get_by_text('Create task', exact=True)).to_be_visible()
        tools.get_by_role('button', name='Create work from selected thoughts').click()
        expect(page.locator('.sk-status')).to_contain_text('Created work')

    def test_04_tablet_touch_selects_several_with_select_several(self):
        page = self.page({'width': 820, 'height': 1180}, touch=True)
        self.scene(page)
        tools = page.get_by_role('toolbar', name='Sketch tools')
        tools.get_by_role('button', name='Select several').tap()
        page.locator('.sk-node', has_text=A).tap()
        page.locator('.sk-node', has_text=B).tap()
        expect(page.locator('.sk-node[aria-pressed="true"]')).to_have_count(2)
        tools.get_by_role('button', name='Create work from selected thoughts').tap()
        expect(page.locator('.sk-status')).to_contain_text('Created work')

    def test_05_phone_views_and_adds_only(self):
        for scheme in ('light', 'dark'):
            with self.subTest(scheme=scheme):
                page = self.page(PHONE, scheme, touch=True)
                sketch = self.scene(page)
                expect(page.get_by_text('Connect and arrange on a computer')).to_be_visible()
                add = page.get_by_role('button', name='Add a thought', exact=True)
                expect(add).to_be_visible()
                self.assertGreaterEqual(add.bounding_box()['height'], 44)
                expect(page.locator('.sk-dot')).to_have_count(0)
                tools = page.get_by_role('toolbar', name='Sketch tools')
                for name in ('Connect', 'Change shape', 'Select several'):
                    expect(tools.get_by_role('button', name=name, exact=True)).to_have_count(0)
                self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), PHONE['width'])
                # Tapping selects one thought at a time; dragging does not arrange it.
                node = page.locator('.sk-node', has_text=A)
                node.tap()
                page.locator('.sk-node', has_text=B).tap()
                expect(page.locator('.sk-node[aria-pressed="true"]')).to_have_count(1)
                before = {t['text']: (t['x'], t['y']) for t in self.stored(page, sketch)['thoughts']}
                box = page.locator('.sk-node', has_text=B).bounding_box()
                page.mouse.move(box['x'] + 20, box['y'] + 10)
                page.mouse.down()
                page.mouse.move(box['x'] + 120, box['y'] + 120, steps=6)
                page.mouse.up()
                self.assertEqual(before, {t['text']: (t['x'], t['y']) for t in self.stored(page, sketch)['thoughts']})
                shot(page, f'map-connect-phone-390-{scheme}')
                add.tap()
                draft = page.get_by_role('form', name='New thought draft')
                expect(draft).to_be_visible()
                draft.get_by_label('Thought text').fill('Solar panel on the enclosure?')
                draft.get_by_role('button', name='Save thought').tap()
                expect(page.locator('.sk-node')).to_have_count(4)


if __name__ == '__main__':
    unittest.main()
