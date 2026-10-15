"""#481: discover, edit and retain map connection labels through the running UI.

The fixture builds real sketches with the public API. Controlled 503/404 responses exercise
recovery. Conflict and replay use another authenticated client saving through the real API.
"""

from __future__ import annotations

import re
import unittest

from playwright.sync_api import expect

import test_map_connect as map_connect
from test_app_shell import ORIGIN, PHONE, UI_BROWSER, show_map_as, shot


class ConnectionLabels(unittest.TestCase):
    # Share fixture helpers without inheriting (or rediscovering) the unrelated drag tests.
    setUpClass = classmethod(map_connect.MapConnectJourney.setUpClass.__func__)
    tearDownClass = classmethod(map_connect.MapConnectJourney.tearDownClass.__func__)
    api = staticmethod(map_connect.MapConnectJourney.api)
    page = map_connect.MapConnectJourney.page
    scene = map_connect.MapConnectJourney.scene
    stored = map_connect.MapConnectJourney.stored

    def link(self, page, sketch):
        links = self.stored(page, sketch)['links']
        self.assertEqual(len(links), 1)
        return links[0]

    def editor(self, page):
        dialog = page.get_by_role('dialog', name='Connection label', exact=True)
        expect(dialog).to_be_visible()
        return dialog

    def connections(self, page, *, touch=False, keyboard=False):
        node = page.locator(f'.sk-node[data-id="{self.ids[map_connect.A]}"]')
        if keyboard:
            node.focus()
            node.press('Space')
        elif touch:
            node.tap()
        else:
            node.click()
        trigger = page.get_by_role('toolbar', name='Selection actions').get_by_role('button', name='Connections', exact=True)
        expect(trigger).to_be_visible()
        bar = trigger.locator('..').bounding_box()
        canvas = page.locator('.sk-canvas').bounding_box()
        self.assertGreaterEqual(bar['x'], canvas['x'], 'all selection controls stay inside the canvas')
        self.assertLessEqual(bar['x'] + bar['width'], canvas['x'] + canvas['width'])
        if keyboard:
            trigger.focus()
            trigger.press('Enter')
        elif touch:
            trigger.tap()
        else:
            trigger.click()
        dialog = page.get_by_role('dialog', name='Connections', exact=True)
        expect(dialog).to_be_visible()
        return trigger, dialog

    def save(self, page, sketch, label, *, touch=False):
        dialog = self.editor(page)
        field = dialog.get_by_role('textbox', name='Label', exact=True)
        field.fill(label)
        with page.expect_response(lambda response: response.request.method == 'PATCH' and '/links/' in response.url) as saved:
            button = dialog.get_by_role('button', name='Save', exact=True)
            button.tap() if touch else button.click()
        self.assertEqual(saved.value.status, 200, saved.value.text())
        expect(dialog).to_have_count(0)
        self.assertEqual(self.link(page, sketch)['label'], label.strip() or None)

    def assert_no_overflow(self, page):
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), page.viewport_size['width'])

    def test_01_selected_thought_exposes_connections_and_saved_label_survives_reload(self):
        for scheme in ('light', 'dark'):
            with self.subTest(scheme=scheme):
                page = self.page(map_connect.COMPUTER, scheme)
                sketch = self.scene(page, link=True)
                original = self.link(page, sketch)
                _, dialog = self.connections(page)
                expect(dialog).to_contain_text(map_connect.A)
                expect(dialog).to_contain_text(map_connect.C)
                add = dialog.get_by_role('button', name=re.compile('^Add label for connection to'))
                expect(add).to_contain_text('Add label')
                shot(page, f'connection-labels-connections-desktop-{scheme}-{UI_BROWSER}')
                add.click()
                editor = self.editor(page)
                expect(editor.get_by_role('textbox', name='Label', exact=True)).to_be_focused()
                expect(editor).to_contain_text(map_connect.A)
                expect(editor).to_contain_text(map_connect.C)
                editor.get_by_role('textbox', name='Label', exact=True).fill('depends on the enclosure')
                shot(page, f'connection-labels-editor-desktop-{scheme}-{UI_BROWSER}')
                self.save(page, sketch, 'depends on the enclosure')
                label = page.locator(f'.sk-el--edit[data-link-id="{original["id"]}"]')
                expect(label).to_have_text('depends on the enclosure')
                page.reload()
                expect(label).to_have_text('depends on the enclosure')
                stored = self.link(page, sketch)
                self.assertEqual((stored['id'], stored['fromId'], stored['toId']),
                                 (original['id'], original['fromId'], original['toId']), 'editing keeps the same connection')
                self.assert_no_overflow(page)
                shot(page, f'connection-labels-map-desktop-{scheme}-{UI_BROWSER}')
                show_map_as(page, 'List')
                item = page.locator('.sk-li-t', has_text=map_connect.A)
                item.click()
                page.get_by_role('toolbar', name='Sketch tools').get_by_role('button', name='Connections', exact=True).click()
                expect(page.get_by_role('dialog', name='Connections', exact=True)).to_contain_text('depends on the enclosure')
                shot(page, f'connection-labels-list-desktop-{scheme}-{UI_BROWSER}')
                page.context.close()

    def test_02_clicking_an_unlabelled_line_opens_editor_and_cancel_or_clear_preserves_link(self):
        page = self.page(map_connect.COMPUTER)
        sketch = self.scene(page, link=True)
        original = self.link(page, sketch)
        expect(page.locator('.sk-el--edit')).to_have_count(0)
        path = page.locator(f'.sk-edge-hits path[data-link-id="{original["id"]}"]')
        # A curved path's bounding-box centre can lie outside its stroke. Click a real point on it.
        point = path.evaluate('''el => {
          const p = el.getPointAtLength(el.getTotalLength() * .4).matrixTransform(el.getScreenCTM());
          const hit = document.elementFromPoint(p.x, p.y);
          return {x:p.x, y:p.y, hitsLine:hit === el};
        }''')
        self.assertTrue(point['hitsLine'], point)
        page.mouse.click(point['x'], point['y'])
        self.save(page, sketch, 'range')
        source = page.locator(f'.sk-node[data-id="{original["fromId"]}"]')
        expect(source).to_be_focused()
        label = page.locator(f'.sk-el--edit[data-link-id="{original["id"]}"]')
        label.click()
        editor = self.editor(page)
        editor.get_by_role('textbox', name='Label', exact=True).fill('unsaved experiment')
        editor.get_by_role('button', name='Cancel', exact=True).click()
        expect(editor).to_have_count(0)
        expect(source).to_be_focused()
        expect(label).to_have_text('range')
        self.assertEqual(self.link(page, sketch)['label'], 'range')
        label.click()
        self.save(page, sketch, '')
        expect(source).to_be_focused()
        stored = self.link(page, sketch)
        self.assertEqual((stored['id'], stored['fromId'], stored['toId']),
                         (original['id'], original['fromId'], original['toId']))
        self.assertIsNone(stored['label'], 'clearing a label leaves its connection in place')
        page.reload()
        expect(page.locator('.sk-edges path')).to_have_count(1)
        expect(page.locator('.sk-el--edit')).to_have_count(0)

    def test_03_another_client_conflict_keeps_my_text_and_requires_explicit_replacement(self):
        page = self.page(map_connect.COMPUTER)
        sketch = self.scene(page, link=True)
        original = self.link(page, sketch)
        _, connections = self.connections(page)
        connections.get_by_role('button', name=re.compile('^Add label for connection to')).click()
        editor = self.editor(page)
        field = editor.get_by_role('textbox', name='Label', exact=True)
        field.fill('needs the weatherproof enclosure')
        other = self.browser.new_context(base_url=ORIGIN, storage_state=self.state, service_workers='block')
        self.addCleanup(other.close)
        self.api(other, 'PATCH', f'/api/v1/sketches/{sketch}/links/{original["id"]}',
                 {'label': 'check frost risk first', 'expectedLabel': None})
        with page.expect_response(lambda response: response.request.method == 'PATCH' and '/links/' in response.url) as conflicted:
            editor.get_by_role('button', name='Save', exact=True).click()
        self.assertEqual(conflicted.value.status, 409)
        expect(editor.get_by_role('alert')).to_contain_text('Someone else changed this label')
        expect(field).to_have_value('needs the weatherproof enclosure')
        expect(editor.locator('.connection-labels__conflict')).to_contain_text('check frost risk first')
        self.assertEqual(self.link(page, sketch)['label'], 'check frost risk first')
        shot(page, f'connection-labels-conflict-desktop-{UI_BROWSER}')
        with page.expect_response(lambda response: response.request.method == 'PATCH' and '/links/' in response.url) as replaced:
            editor.get_by_role('button', name='Replace with my label', exact=True).click()
        self.assertEqual(replaced.value.status, 200, replaced.value.text())
        expect(editor).to_have_count(0)
        self.assertEqual(self.link(page, sketch)['label'], 'needs the weatherproof enclosure')

    def test_04_failed_save_keeps_text_and_retries_the_same_command(self):
        page = self.page(map_connect.COMPUTER)
        sketch = self.scene(page, link=True)
        original = self.link(page, sketch)
        _, connections = self.connections(page)
        connections.get_by_role('button', name=re.compile('^Add label for connection to')).click()
        editor = self.editor(page)
        editor.get_by_role('textbox', name='Label', exact=True).fill('problem in wet weather')
        attempts = []

        def fail_once(route):
            if route.request.method != 'PATCH':
                return route.continue_()
            attempts.append(route.request.headers.get('idempotency-key'))
            if len(attempts) == 1:
                route.fulfill(status=503, content_type='application/json',
                              body='{"error":{"code":"TEST_UNAVAILABLE","message":"Connection temporarily unavailable"}}')
            else:
                route.continue_()

        page.route(f'**/api/v1/sketches/{sketch}/links/{original["id"]}', fail_once)
        editor.get_by_role('button', name='Save', exact=True).click()
        expect(editor.get_by_role('alert')).to_contain_text('Your text is kept')
        expect(editor.get_by_role('textbox', name='Label', exact=True)).to_have_value('problem in wet weather')
        self.assertIsNone(self.link(page, sketch)['label'])
        shot(page, f'connection-labels-failed-desktop-{UI_BROWSER}')
        with page.expect_response(lambda response: response.request.method == 'PATCH' and '/links/' in response.url) as saved:
            editor.get_by_role('button', name='Save', exact=True).click()
        self.assertEqual(saved.value.status, 200, saved.value.text())
        expect(editor).to_have_count(0)
        self.assertEqual(len(attempts), 2)
        self.assertTrue(attempts[0])
        self.assertEqual(attempts[0], attempts[1], 'retry keeps the operation identity')
        self.assertEqual(self.link(page, sketch)['label'], 'problem in wet weather')

    def test_05_keyboard_and_tablet_touch_can_find_the_same_editor(self):
        page = self.page(map_connect.COMPUTER)
        sketch = self.scene(page, link=True)
        trigger, connections = self.connections(page, keyboard=True)
        add = connections.get_by_role('button', name=re.compile('^Add label for connection to'))
        add.focus()
        add.press('Enter')
        editor = self.editor(page)
        field = editor.get_by_role('textbox', name='Label', exact=True)
        expect(field).to_be_focused()
        field.fill('wait for calibration')
        field.press('Escape')
        expect(editor).to_have_count(0)
        expect(trigger).to_be_focused()
        self.assertIsNone(self.link(page, sketch)['label'])

        tablet = self.page({'width': 820, 'height': 1180}, touch=True)
        tablet_sketch = self.scene(tablet, link=True)
        _, connections = self.connections(tablet, touch=True)
        add = connections.get_by_role('button', name=re.compile('^Add label for connection to'))
        self.assertGreaterEqual(add.bounding_box()['height'], 44)
        shot(tablet, f'connection-labels-connections-tablet-820-{UI_BROWSER}')
        add.tap()
        editor = self.editor(tablet)
        for control in (editor.get_by_role('textbox', name='Label', exact=True), editor.get_by_role('button', name='Save', exact=True)):
            self.assertGreaterEqual(control.bounding_box()['height'], 44)
        editor.get_by_role('textbox', name='Label', exact=True).fill('depends on soil temperature')
        shot(tablet, f'connection-labels-editor-tablet-820-{UI_BROWSER}')
        self.save(tablet, tablet_sketch, 'depends on soil temperature', touch=True)
        bar = tablet.get_by_role('toolbar', name='Selection actions').bounding_box()
        label = tablet.locator('.sk-el--edit').bounding_box()
        overlap = max(0, min(bar['x'] + bar['width'], label['x'] + label['width']) - max(bar['x'], label['x'])) * max(0, min(bar['y'] + bar['height'], label['y'] + label['height']) - max(bar['y'], label['y']))
        self.assertEqual(overlap, 0, 'the actions leave the saved label readable')
        self.assert_no_overflow(tablet)
        shot(tablet, f'connection-labels-map-tablet-820-{UI_BROWSER}')

    def test_06_phone_reads_labels_without_exposing_connection_editing(self):
        page = self.page(PHONE, touch=True)
        sketch = self.scene(page, link=True)
        original = self.link(page, sketch)
        self.api(page.context, 'PATCH', f'/api/v1/sketches/{sketch}/links/{original["id"]}',
                 {'label': 'range', 'expectedLabel': None})
        page.reload()
        expect(page.locator('.sk-labels .sk-el')).to_have_text('range')
        page.locator(f'.sk-node[data-id="{self.ids[map_connect.A]}"]').tap()
        expect(page.get_by_role('button', name='Connections', exact=True)).to_have_count(0)
        expect(page.locator('.sk-el--edit, .sk-edge-hits, .sk-dot')).to_have_count(0)
        expect(page.get_by_text('Connect and arrange on a computer')).to_be_visible()
        self.assert_no_overflow(page)
        shot(page, f'connection-labels-phone-view-only-{UI_BROWSER}')
        show_map_as(page, 'List', touch=True)
        expect(page.locator('.sk-li-s, .sk-outline-label').filter(has_text='range').first).to_be_visible()
        expect(page.get_by_role('button', name='Connections', exact=True)).to_have_count(0)

    def test_07_a_replayed_receipt_refreshes_the_newer_saved_label(self):
        page = self.page(map_connect.COMPUTER)
        sketch = self.scene(page, link=True)
        original = self.link(page, sketch)
        _, connections = self.connections(page)
        connections.get_by_role('button', name=re.compile('^Add label for connection to')).click()
        editor = self.editor(page)
        editor.get_by_role('textbox', name='Label', exact=True).fill('first saved label')
        attempts = []
        path = f'/api/v1/sketches/{sketch}/links/{original["id"]}'

        def lose_receipt(route):
            if route.request.method != 'PATCH':
                return route.continue_()
            attempts.append(route.request.headers.get('idempotency-key'))
            if len(attempts) == 1:
                saved = route.fetch()
                self.assertEqual(saved.status, 200, saved.text())
                # The write really committed, but the browser did not receive that receipt.
                route.fulfill(status=503, content_type='application/json',
                              body='{"error":{"code":"TEST_LOST_RECEIPT","message":"Receipt unavailable"}}')
            else:
                route.continue_()

        page.route(f'**{path}', lose_receipt)
        editor.get_by_role('button', name='Save', exact=True).click()
        expect(editor.get_by_role('alert')).to_contain_text('Your text is kept')
        self.assertEqual(self.link(page, sketch)['label'], 'first saved label')
        other = self.browser.new_context(base_url=ORIGIN, storage_state=self.state, service_workers='block')
        self.addCleanup(other.close)
        self.api(other, 'PATCH', path, {'label': 'newer peer label', 'expectedLabel': 'first saved label'})
        with page.expect_response(lambda response: response.request.method == 'PATCH' and response.url.endswith(path)) as replay:
            editor.get_by_role('button', name='Save', exact=True).click()
        self.assertEqual(replay.value.status, 200, replay.value.text())
        self.assertEqual(replay.value.json()['label'], 'first saved label', 'the retry returns the original command receipt')
        expect(editor).to_have_count(0)
        expect(page.locator(f'.sk-el--edit[data-link-id="{original["id"]}"]')).to_have_text('newer peer label')
        self.assertEqual(self.link(page, sketch)['label'], 'newer peer label', 'retry cannot overwrite the peer edit')
        self.assertEqual(attempts, [attempts[0], attempts[0]])

    def test_08_a_missing_sketch_keeps_the_unsaved_label_recoverable(self):
        page = self.page(map_connect.COMPUTER)
        sketch = self.scene(page, link=True)
        original = self.link(page, sketch)
        _, connections = self.connections(page)
        connections.get_by_role('button', name=re.compile('^Add label for connection to')).click()
        editor = self.editor(page)
        editor.get_by_role('textbox', name='Label', exact=True).fill('Keep this unsaved explanation after access changes')
        # The live document's save and subsequent refresh see the same unavailable sketch.
        # Permission enforcement itself is covered by the API label tests.
        def unavailable(route):
            route.fulfill(status=404, content_type='application/json',
                          body='{"error":{"code":"NOT_FOUND","message":"Sketch not found"}}')

        page.route(f'**/api/v1/sketches/{sketch}', unavailable)
        page.route(f'**/api/v1/sketches/{sketch}/links/{original["id"]}', unavailable)
        editor.get_by_role('button', name='Save', exact=True).click()
        recovery = editor.get_by_role('textbox', name='Label', exact=True)
        expect(recovery).to_be_visible()
        expect(recovery).to_have_value('Keep this unsaved explanation after access changes')
        expect(editor.get_by_role('alert')).to_contain_text('Your text is kept below')
        recovery.focus()
        expect(recovery).to_be_focused()
        self.assertIsNone(self.link(page, sketch)['label'], 'no label was written by the failed save')
        shot(page, f'connection-labels-unavailable-recovery-{UI_BROWSER}')


    def test_09_long_labels_stay_compact_and_reopen_in_full(self):
        page = self.page({'width': 820, 'height': 1180}, touch=True)
        sketch = self.scene(page, link=True)
        _, connections = self.connections(page, touch=True)
        connections.get_by_role('button', name=re.compile('^Add label for connection to')).tap()
        label = 'Depends on the enclosure seal and successful range tests before the winter frost'
        self.assertEqual(len(label), 80)
        self.save(page, sketch, label, touch=True)
        button = page.locator('.sk-el--edit')
        expect(button).to_have_attribute('title', label)
        self.assertLessEqual(button.bounding_box()['width'], 180)
        self.assert_no_overflow(page)
        button.tap()
        editor = self.editor(page)
        expect(editor.get_by_role('textbox', name='Label', exact=True)).to_have_value(label)
        editor.get_by_role('button', name='Cancel', exact=True).tap()
        self.assertEqual(self.link(page, sketch)['label'], label)

if __name__ == '__main__':
    unittest.main(verbosity=2)
