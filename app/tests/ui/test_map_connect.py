"""#349 (F-026, P12 and S15): drag a thought's dot to connect; the phone only views and adds."""
from __future__ import annotations

import os
import base64
import json
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, PHONE, SHOTS, UPSTREAM, open_map_options, show_map_as, shot, start_forwarder
from contrast import MEASURE
from test_map_paste import PASTE, IMAGE

COMPUTER = {'width': 1440, 'height': 900}
A, B, C = 'Weatherproof enclosure', 'Calibrate the probes', 'Frost warnings later'


class MapConnectJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(service_workers='block', base_url=ORIGIN)
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
        context = self.browser.new_context(service_workers='block', base_url=ORIGIN, storage_state=self.state, viewport=viewport, color_scheme=scheme,
            has_touch=touch, is_mobile=touch, device_scale_factor=3 if touch else 1)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], 'no uncaught browser errors'))
        return page

    def scene(self, page, *, link=False, tasks=(), solo=False):
        """A project map with three thoughts (one, if `solo`); `link` joins C to A; `tasks` lists thoughts that get a task."""
        project = self.api(page.context, 'POST', f'/api/v1/workspaces/{self.workspace}/projects',
            {'name': f'Sensors {uuid.uuid4().hex[:6]}', 'visibility': 'restricted'}, 201)['id']
        sketch = self.api(page.context, 'POST', f'/api/v1/workspaces/{self.workspace}/sketches',
            {'title': 'Community garden sensors', 'scope': 'project', 'projectId': project}, 201)['id']
        self.ids = {}
        rows = ((A, f'{A} volunteers can open', 40, 40), (B, f'{B} at two soil depths', 420, 40), (C, f'{C}, one probe at the gateway', 40, 260))
        for key, text, x, y in rows[:1 if solo else 3]:
            body = {'text': text, 'x': x, 'y': y}
            if link and key == C:
                body['linkFrom'] = {'thoughtId': self.ids[A]}
            self.ids[key] = self.api(page.context, 'POST', f'/api/v1/sketches/{sketch}/thoughts', body, 201)['thought']['id']
        self.project = project
        for key in tasks:
            self.api(page.context, 'POST', f'/api/v1/projects/{project}/work', {'title': f'Check {key}', 'sources': [{'type': 'thought', 'id': self.ids[key]}]}, 201)
        page.goto(f'/projects/{project}/map/{sketch}')
        expect(page.locator('.sk-node')).to_have_count(1 if solo else 3)
        return sketch

    def stored(self, page, sketch):
        return self.api(page.context, 'GET', f'/api/v1/sketches/{sketch}')

    def assert_task_sources(self, page, work_id, included, excluded):
        """The persisted source relations: one per selected thought, none for a thought left out."""
        item = self.api(page.context, 'GET', f'/api/v1/work/{work_id}')
        sources = {link['to']['id'] for link in item['links'] if link['role'] == 'source' and link['to']['type'] == 'thought'}
        self.assertEqual(sources, {self.ids[key] for key in included})
        for key in excluded:
            self.assertNotIn(self.ids[key], sources)

    def eventually(self, page, sketch, ready):
        """The stored sketch once `ready(stored)` holds (saves are asynchronous), else the last read."""
        stored = self.stored(page, sketch)
        for _ in range(40):
            if ready(stored):
                break
            page.wait_for_timeout(150)
            stored = self.stored(page, sketch)
        return stored

    def drag_dot(self, page, source, target=None, point=None):
        """Drag from the dot of `source` onto thought `target`, or release at `point` (page pixels)."""
        node = page.locator('.sk-node', has_text=source)
        node.hover()
        dot = page.locator(f'.sk-dot[data-for="{node.get_attribute("data-id")}"][data-side="right"]')
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
                shot(page, f'map-connect-local-draft-1440-{scheme}')
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
        page.keyboard.press('Space')  # C is left out again
        expect(page.locator('.sk-node[aria-pressed="true"]')).to_have_count(2)
        tools = page.get_by_role('toolbar', name='Sketch tools')
        expect(tools.get_by_text('Create task', exact=True)).to_be_visible()
        with page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith(f'/projects/{self.project}/work')) as saved:
            tools.get_by_role('button', name='Create task from selected thoughts').click()
        self.assert_task_sources(page, saved.value.json()['id'], {A, B}, {C})

    def test_04_tablet_touch_selects_several_with_select_several(self):
        page = self.page({'width': 820, 'height': 1180}, touch=True)
        self.scene(page)
        tools = page.get_by_role('toolbar', name='Sketch tools')
        tools.get_by_role('button', name='Select several').tap()
        page.locator('.sk-node', has_text=A).tap()
        page.locator('.sk-node', has_text=B).tap()
        expect(page.locator('.sk-node[aria-pressed="true"]')).to_have_count(2)
        with page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith(f'/projects/{self.project}/work')) as saved:
            tools.get_by_role('button', name='Create task from selected thoughts').tap()
        self.assert_task_sources(page, saved.value.json()['id'], {A, B}, {C})

    def test_05_phone_views_and_adds_only(self):
        for scheme in ('light', 'dark'):
            with self.subTest(scheme=scheme):
                page = self.page(PHONE, scheme, touch=True)
                sketch = self.scene(page)
                expect(page.get_by_text('Connect and arrange on a computer')).to_be_visible()
                add = page.get_by_role('button', name='Add a thought', exact=True)
                expect(add).to_be_visible()
                self.assertGreaterEqual(add.evaluate('el => el.offsetHeight'), 44)
                self.assertGreaterEqual(add.bounding_box()['height'], 44 - 1 / 64)
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

    def test_06_phone_undo_survives_removing_a_thought(self):
        """S15 + undo: removing clears the selection, so Undo must not live in the selection's bar."""
        for solo in (True, False):
            with self.subTest(solo=solo):
                page = self.page(PHONE, touch=True)
                sketch = self.scene(page, solo=solo, link=not solo)
                self.assertEqual(page.get_by_role('button', name='Undo', exact=True).count(), 0, 'a fresh map has nothing to undo')
                before = self.stored(page, sketch)
                target = A if solo else C
                page.locator('.sk-node', has_text=target).tap()
                page.get_by_role('button', name='Thought actions', exact=True).tap()
                page.get_by_role('dialog', name='Thought actions', exact=True).get_by_role('button', name='Remove from sketch', exact=True).tap()
                expect(page.locator('.sk-node')).to_have_count(0 if solo else 2)
                if solo:
                    expect(page.locator('.sk-first')).to_have_text('An empty sketch. Start with Add a thought.')
                    expect(page.get_by_role('button', name=re.compile('connected thought|thought connected'))).to_have_count(0)
                undo = page.get_by_role('button', name='Undo', exact=True)
                expect(undo).to_be_visible()
                if solo:
                    page.get_by_role('button', name='Add a thought', exact=True).tap()
                    page.get_by_label('Thought text').fill('Keep this private thought while Undo restores the map')
                    expect(undo).to_have_text('Undo last saved change')
                self.assertGreaterEqual(undo.evaluate('el => el.offsetHeight'), 44)
                self.assertGreaterEqual(undo.bounding_box()['height'], 44 - 1 / 64)
                undo.tap()
                expect(page.locator('.sk-node')).to_have_count(1 if solo else 3)
                after = self.eventually(page, sketch, lambda s: len(s['thoughts']) == len(before['thoughts']))
                key = lambda t: (t['id'], t['text'])
                self.assertEqual(sorted(map(key, after['thoughts'])), sorted(map(key, before['thoughts'])), 'the exact ID and text return')
                self.assertEqual(sorted((l['fromId'], l['toId']) for l in after['links']), sorted((l['fromId'], l['toId']) for l in before['links']), 'incident links return')
                if solo:
                    draft = page.get_by_role('form', name='New thought draft')
                    expect(draft.get_by_label('Thought text')).to_have_value('Keep this private thought while Undo restores the map')
                    draft.get_by_role('button', name='Cancel', exact=True).tap()
                    self.assertEqual(self.stored(page, sketch), after, 'Undo and Cancel never publish the private draft')

    def test_07_desktop_undo_and_a_fresh_map(self):
        page = self.page(COMPUTER)
        sketch = self.scene(page)
        undo = page.get_by_role('toolbar', name='Sketch tools').get_by_role('button', name='Undo', exact=True)
        expect(undo).to_have_attribute('aria-disabled', 'true')
        page.locator('.sk-node', has_text=B).click()
        page.get_by_role('toolbar', name='Selection actions').get_by_role('button', name='Remove from sketch', exact=True).click()
        expect(page.locator('.sk-node')).to_have_count(2)
        expect(undo).to_have_attribute('aria-disabled', 'false')
        undo.click()
        expect(page.locator('.sk-node')).to_have_count(3)
        stored = self.eventually(page, sketch, lambda s: len(s['thoughts']) == 3)
        self.assertIn(self.ids[B], {t['id'] for t in stored['thoughts']})

    def test_08_a_drop_on_the_task_count_connects_that_thought(self):
        page = self.page(COMPUTER)
        sketch = self.scene(page, tasks=(B, A))
        badge = lambda key: page.locator(f'.sk-work-slot[data-for="{self.ids[key]}"] .sk-work')
        expect(badge(B)).to_be_visible()
        box = badge(B).bounding_box()
        self.drag_dot(page, A, point=(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2))
        page.mouse.up()
        expect(page.locator('.sk-status')).to_contain_text('Linked')
        expect(page.get_by_role('form', name='New thought draft')).to_have_count(0)
        stored = self.eventually(page, sketch, lambda s: len(s['links']) == 1)
        self.assertEqual(len(stored['thoughts']), 3)
        self.assertEqual([(l['fromId'], l['toId']) for l in stored['links']], [(self.ids[A], self.ids[B])])
        # Released on the dot's own thought badge: nothing happens, no draft, no second link.
        own = badge(A).bounding_box()
        self.drag_dot(page, A, point=(own['x'] + own['width'] / 2, own['y'] + own['height'] / 2))
        page.mouse.up()
        expect(page.get_by_role('form', name='New thought draft')).to_have_count(0)
        self.assertEqual(len(self.stored(page, sketch)['links']), 1)

    def test_09_narrowing_to_a_phone_cancels_a_pending_connection(self):
        page = self.page({'width': 820, 'height': 1180})
        sketch = self.scene(page)
        page.locator('.sk-node', has_text=A).click()
        page.get_by_role('toolbar', name='Selection actions').get_by_role('button', name='Connect', exact=True).click()
        expect(page.locator('.sk-status')).to_contain_text('Choose the thought to link to')
        page.set_viewport_size(PHONE)
        expect(page.get_by_role('button', name='Add a thought', exact=True)).to_be_visible()
        page.locator('.sk-node', has_text=B).click()
        expect(page.locator('.sk-node[aria-pressed="true"]')).to_have_count(1)
        page.wait_for_timeout(500)
        self.assertEqual(self.stored(page, sketch)['links'], [], 'phone mode never links')
        # Wider again: linking still works.
        page.set_viewport_size({'width': 820, 'height': 1180})
        page.locator('.sk-node', has_text=A).click()
        page.get_by_role('toolbar', name='Selection actions').get_by_role('button', name='Connect', exact=True).click()
        page.locator('.sk-node', has_text=B).click()
        expect(page.locator('.sk-status')).to_contain_text('Linked')
        self.assertEqual(len(self.eventually(page, sketch, lambda s: len(s['links']) == 1)['links']), 1)

    def test_10_phone_named_sheets_keep_secondary_actions_and_restore_focus(self):
        page = self.page(PHONE, touch=True)
        sketch = self.scene(page)
        before = self.stored(page, sketch)
        node = page.locator('.sk-node', has_text=B)
        node.tap()
        expect(page.get_by_role('toolbar', name='Selection actions')).to_have_count(0)
        expect(page.locator('.sk-phone .sk-plus')).to_have_count(0)
        expect(page.get_by_role('button', name='Add a thought', exact=True)).to_be_visible()
        actions = page.get_by_role('button', name='Thought actions', exact=True)
        self.assertGreaterEqual(actions.evaluate('el => el.offsetHeight'), 44)
        self.assertGreaterEqual(actions.bounding_box()['height'], 44 - 1 / 64)
        actions.focus()
        page.keyboard.press('Enter')
        sheet = page.get_by_role('dialog', name='Thought actions', exact=True)
        expect(sheet).to_have_attribute('aria-modal', 'true')
        expect(sheet.get_by_role('button', name='Add a connected thought', exact=True)).to_have_count(0)
        for name in ('Edit thought', 'Create task from selected thoughts', 'Remove from sketch'):
            row = sheet.get_by_role('button', name=name, exact=True)
            expect(row).to_be_visible()
            self.assertGreaterEqual(row.evaluate('el => parseFloat(getComputedStyle(el).minHeight)'), 44)
            # WebKit can report 43.99994 for a 44px transformed row; allow one layout subpixel,
            # while keeping the actual CSS minimum at 44 and the visible target check above.
            self.assertGreaterEqual(row.bounding_box()['height'], 44 - 1 / 64)
        page.keyboard.press('Escape')
        expect(sheet).to_have_count(0)
        expect(actions).to_be_focused()
        expect(node).to_have_attribute('aria-pressed', 'true')
        actions.tap()
        sheet.get_by_role('button', name='Edit thought', exact=True).tap()
        expect(page.get_by_label('Thought text')).to_be_focused()
        page.get_by_label('Thought text').fill('A private edit not saved')
        page.get_by_role('button', name='Cancel edit', exact=True).tap()
        page.get_by_role('button', name='Add a thought', exact=True).tap()
        draft = page.get_by_role('form', name='New thought draft')
        expect(draft.get_by_label('Thought text')).to_be_focused()
        expect(draft).to_contain_text('Top level')
        expect(draft).not_to_contain_text('Connected to')
        draft.get_by_label('Thought text').fill('A private plain draft')
        self.assertEqual(self.stored(page, sketch), before, 'opening/editing/cancelling the sheet does not change the map')
        shot(page, 'map-phone-plain-draft-390-light')
        draft.get_by_role('button', name='Cancel', exact=True).tap()
        options = open_map_options(page, touch=True)
        for name in ('Fit the sketch to the view', 'Zoom out', 'Zoom in'):
            control = options.get_by_role('button', name=name, exact=True)
            expect(control).to_be_visible()
            self.assertGreaterEqual(control.evaluate('el => el.offsetHeight'), 44)
            self.assertGreaterEqual(control.bounding_box()['height'], 44 - 1 / 64)
        shot(page, 'map-phone-options-390-light')
        options.get_by_role('button', name='Zoom in', exact=True).tap()
        options.get_by_role('button', name='Fit the sketch to the view', exact=True).tap()
        options.get_by_role('button', name='Close map options', exact=True).tap()
        expect(page.get_by_role('button', name='Map options', exact=True)).to_be_focused()
        show_map_as(page, 'List', touch=True)
        expect(page.locator('.sk-li-t')).to_have_count(3)
        show_map_as(page, 'Map', touch=True)
        expect(page.locator('.sk-node')).to_have_count(3)
        self.assertEqual(self.stored(page, sketch), before, 'List and Fit preserve exact map data and positions')
        page.locator('.sk-node', has_text=B).tap()
        actions.tap()
        shot(page, 'map-phone-thought-actions-390-light')
        with page.expect_response(lambda response: response.request.method == 'POST' and f'/projects/{self.project}/work' in response.url) as saved:
            sheet.get_by_role('button', name='Create task from selected thoughts', exact=True).tap()
        self.assertEqual(saved.value.status, 201)
        self.assert_task_sources(page, saved.value.json()['id'], {B}, {A, C})

    def test_11_reading_tokens_keep_persisted_geometry_and_follow_text_size(self):
        for viewport, touch, body, meta in ((COMPUTER, False, 14, 12), (PHONE, True, 15, 12.5)):
            for scheme in ('light', 'dark'):
                with self.subTest(viewport=viewport, scheme=scheme):
                    page = self.page(viewport, scheme, touch=touch)
                    sketch = self.scene(page)
                    before = self.stored(page, sketch)
                    node = page.locator('.sk-node', has_text=A)
                    for selector, minimum in (('.sk-t', body), ('.sk-p', meta)):
                        text = node.locator(selector)
                        size = text.evaluate('el => parseFloat(getComputedStyle(el).fontSize)')
                        self.assertGreaterEqual(size, minimum)
                        node_selector = f'.sk-node[data-id="{self.ids[A]}"]'
                        measured = page.evaluate(MEASURE, {'selector': f'{node_selector} {selector}', 'backgroundSelector': node_selector})
                        self.assertGreaterEqual(measured['ratio'], 4.5, f'{scheme}: actual thought text contrast {measured}')
                        page.add_style_tag(content='html { font-size: 32px; }')
                        self.assertGreaterEqual(text.evaluate('el => parseFloat(getComputedStyle(el).fontSize)'), size * 1.9)
                        page.add_style_tag(content='html { font-size: 16px; }')
                    self.assertEqual(self.stored(page, sketch), before, 'readable text does not rewrite persisted widths or positions')

    def test_12_phone_add_entry_points_preserve_existing_graph_links(self):
        # Browser-delivered ClipboardEvent covers the application paste handler, not OS clipboard permission.
        for entry in ('primary', 'keyboard', 'paste-text', 'paste-lines', 'paste-image', 'wide-draft', 'list-keyboard'):
            with self.subTest(entry=entry):
                page = self.page(COMPUTER if entry == 'wide-draft' else PHONE, touch=entry != 'wide-draft')
                sketch = self.scene(page, link=True)
                before = self.stored(page, sketch)
                node = page.locator('.sk-node', has_text=B)
                node.click() if entry == 'wide-draft' else node.tap()
                if entry == 'wide-draft':
                    page.get_by_role('button', name=re.compile('Add a thought connected to')).click()
                    expect(page.get_by_role('form', name='New thought draft')).to_contain_text('Connected to')
                    page.get_by_label('Thought text').fill('Keep this private text after narrowing')
                    page.set_viewport_size(PHONE)
                elif entry == 'primary':
                    page.get_by_role('button', name='Add a thought', exact=True).tap()
                elif entry == 'keyboard':
                    node.focus()
                    page.keyboard.press('+')
                elif entry == 'list-keyboard':
                    show_map_as(page, 'List', touch=True)
                    row = page.locator(f'.sk-li-t[data-id="{self.ids[B]}"]')
                    row.focus()
                    page.keyboard.press('+')
                else:
                    node.focus()
                    image = {'base64': base64.b64encode(IMAGE).decode(), 'name': 'garden.png', 'type': 'image/png'} if entry == 'paste-image' else None
                    text = 'Check the enclosure after rain\nKeep a spare probe' if entry == 'paste-lines' else 'https://example.test/garden-notes' if entry == 'paste-text' else None
                    page.evaluate(PASTE, [text, image])
                draft = page.get_by_role('form', name='Pasted thoughts draft' if entry == 'paste-lines' else 'New thought draft')
                expect(draft).to_contain_text('Top level')
                expect(draft).not_to_contain_text('Connected to')
                expect(page.locator('.sk-wire, .sk-ghost--draft, .sk-dot')).to_have_count(0)
                if entry in ('primary', 'keyboard', 'list-keyboard'):
                    draft.get_by_label('Thought text').fill(f'Plain addition from {entry}')
                if entry == 'wide-draft':
                    expect(draft.get_by_label('Thought text')).to_have_value('Keep this private text after narrowing')
                self.assertEqual(self.stored(page, sketch), before, 'all drafts stay private until explicit Save')
                draft.get_by_role('button', name=re.compile('^Save (thought|image|2 thoughts)$')).click()
                added = 2 if entry == 'paste-lines' else 1
                after = self.eventually(page, sketch, lambda s: len(s['thoughts']) == 3 + added)
                self.assertEqual(len(after['thoughts']), 3 + added)
                self.assertEqual(after['links'], before['links'], 'phone Save neither creates nor deletes a graph link')
                self.assertEqual([t for t in after['thoughts'] if t['id'] in self.ids.values()], before['thoughts'],
                    'adding on the phone preserves the exact existing thoughts and positions')
                # Let the confirmed saved view's background reads settle before the
                # persistence reload; keep every page-error assertion.
                page.wait_for_load_state('networkidle')
                page.reload()
                expect(page.get_by_role('form', name=re.compile('thought.* draft', re.I))).to_have_count(0)
                expect(page.locator('.sk-node, .sk-li-t')).to_have_count(3 + added)
                self.assertEqual(self.stored(page, sketch)['links'], before['links'], 'the persisted link set survives reload')

    def test_13_composition_keeps_visible_map_context_and_camera(self):
        measurements = []
        for scheme in ('light', 'dark'):
            for viewport, touch in ((COMPUTER, False), ({'width': 1024, 'height': 900}, False), ({'width': 820, 'height': 1180}, True), (PHONE, True)):
                with self.subTest(scheme=scheme, viewport=viewport):
                    page = self.page(viewport, scheme, touch)
                    sketch = self.scene(page, link=True)
                    before = self.stored(page, sketch)
                    source = page.locator('.sk-node', has_text=B)
                    source.tap() if touch else source.click()
                    canvas = page.locator('.sk-canvas')
                    camera = canvas.evaluate('el => ({left:el.scrollLeft, top:el.scrollTop})')
                    if viewport['width'] <= 640:
                        page.get_by_role('button', name='Add a thought', exact=True).tap()
                    else:
                        page.get_by_role('button', name=re.compile('Add a thought connected to')).click()
                    draft = page.get_by_role('form', name='New thought draft')
                    draft.get_by_label('Thought text').fill('Check the solar panel before mounting')
                    expect(draft).to_be_in_viewport(ratio=1)
                    geometry = page.evaluate('''() => {
                      const editor = document.querySelector('.sk-composition').getBoundingClientRect();
                      const canvas = document.querySelector('.sk-canvas').getBoundingClientRect();
                      const pane = document.querySelector('.sk-page').getBoundingClientRect();
                      return {editor:editor.toJSON(), canvas:canvas.toJSON(), pane:pane.toJSON(), nodes:[...document.querySelectorAll('.sk-node')].map(el => ({id:el.dataset.id, ...el.getBoundingClientRect().toJSON()}))};
                    }''')
                    e, c, p = geometry['editor'], geometry['canvas'], geometry['pane']
                    measurements.append({'scheme': scheme, 'viewport': viewport, 'geometry': geometry, 'camera': camera})
                    self.assertGreaterEqual(e['left'], p['left'])
                    self.assertLessEqual(e['right'], p['right'])
                    self.assertGreaterEqual(e['top'], p['top'])
                    self.assertLessEqual(e['bottom'], p['bottom'])
                    for node in geometry['nodes']:
                        visible = node['right'] > c['left'] and node['left'] < c['right'] and node['bottom'] > c['top'] and node['top'] < c['bottom']
                        if visible:
                            overlap = max(0, min(e['right'], node['right']) - max(e['left'], node['left'])) * max(0, min(e['bottom'], node['bottom']) - max(e['top'], node['top']))
                            self.assertEqual(overlap, 0, f'composition keeps visible thought {node["id"]} uncovered')
                    self.assertGreaterEqual(c['height'], 120, 'the phone retains a useful map viewport')
                    self.assertEqual(canvas.evaluate('el => ({left:el.scrollLeft, top:el.scrollTop})'), camera)
                    self.assertEqual(self.stored(page, sketch), before, 'composition changes no graph data')
                    shot(page, f'map-composition-{viewport["width"]}-{scheme}')
                    draft.get_by_role('button', name='Cancel', exact=True).click()
                    self.assertEqual(self.stored(page, sketch), before, 'Cancel leaves exact saved thoughts and links')
                    self.assertEqual(canvas.evaluate('el => ({left:el.scrollLeft, top:el.scrollTop})'), camera)
        if SHOTS:
            (SHOTS / 'map-composition-geometry.json').write_text(json.dumps(measurements, indent=2) + '\n')


if __name__ == '__main__':
    unittest.main()
