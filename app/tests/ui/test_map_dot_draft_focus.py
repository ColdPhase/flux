"""#1554: a new thought made from a connection dot (or its + button) always has the focus and its caret on the first try: what is typed
at once lands in the draft, over repeated presses, with a slow release and with a small movement of the pointer under the press."""
from __future__ import annotations

import os
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

COMPUTER = {'width': 1440, 'height': 900}
A, B, C = 'Weatherproof enclosure', 'Calibrate the probes', 'Frost warnings later'
REPEATS = 20


class MapDotDraftFocus(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get('FLUX_UI_BROWSER', 'chromium')).launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(service_workers='block', base_url=ORIGIN)
        response = context.request.post('/api/auth/sign-up/email', data={
            'name': 'Ada Dots', 'email': f'map-dot-draft-{uuid.uuid4()}@example.test', 'password': 'type into the new thought',
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
        response = context.request.fetch(path, method=method, data=body, headers={'origin': ORIGIN, 'idempotency-key': str(uuid.uuid4())})
        assert response.status == status, response.text()
        return response.json() if response.text() else None

    def scene(self):
        context = self.browser.new_context(service_workers='block', base_url=ORIGIN, storage_state=self.state, viewport=COMPUTER)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], 'no uncaught browser errors'))
        project = self.api(context, 'POST', f'/api/v1/workspaces/{self.workspace}/projects', {'name': f'Sensors {uuid.uuid4().hex[:6]}', 'visibility': 'restricted'}, 201)['id']
        sketch = self.api(context, 'POST', f'/api/v1/workspaces/{self.workspace}/sketches', {'title': 'Community garden sensors', 'scope': 'project', 'projectId': project}, 201)['id']
        for text, x, y in ((A, 40, 40), (B, 420, 40), (C, 40, 260)):
            self.api(context, 'POST', f'/api/v1/sketches/{sketch}/thoughts', {'text': text, 'x': x, 'y': y}, 201)
        page.goto(f'/projects/{project}/map/{sketch}')
        expect(page.locator('.sk-node')).to_have_count(3)
        return page

    def dot_of(self, page, text):
        node = page.locator('.sk-node', has_text=text)
        node.hover()
        dot = page.locator(f'.sk-dot[data-for="{node.get_attribute("data-id")}"][data-side="right"]')
        expect(dot).to_be_visible()
        box = dot.bounding_box()
        return box['x'] + box['width'] / 2, box['y'] + box['height'] / 2

    def cancel(self, page):
        form = page.get_by_role('form', name='New thought draft')
        if form.count():
            form.get_by_role('button', name='Cancel').click()
        expect(form).to_have_count(0)

    def typed_at_once(self, page, text='ab'):
        """Types with no pause after the gesture, as a person does; True when it landed in the draft, else what was seen instead."""
        page.keyboard.type(text)
        field = page.get_by_role('form', name='New thought draft').get_by_label('Thought text')
        try:
            expect(field).to_have_value(text, timeout=3000)
            expect(field).to_be_focused()
            return True
        except AssertionError:
            return page.evaluate("""() => { const f = document.querySelector('form[aria-label="New thought draft"] textarea'); const a = document.activeElement;
              return {draft: !!f, value: f && f.value, focused: a === f, active: a && (a.tagName + '.' + (a.className || '') + (a.dataset && a.dataset.side ? '/' + a.dataset.side : '')),
                connecting: !!document.querySelector('.sk-canvas.is-connecting'), status: (document.querySelector('.sk-status') || {}).textContent}; }""")

    def press_dot(self, page, text, *, hold_ms=0, wobble=0, steps=10):
        """The dot's real pointer sequence: down on the dot, a movement to empty space (first `wobble` px at a time), a pause, up."""
        x, y = self.dot_of(page, text)
        canvas = page.locator('.sk-canvas').bounding_box()
        target = (canvas['x'] + canvas['width'] * 0.7, canvas['y'] + canvas['height'] * 0.65)
        page.mouse.move(x, y)
        page.mouse.down()
        if wobble:
            page.mouse.move(x + wobble, y + 1)
            page.mouse.move(x + wobble + 3, y + 2)
        page.mouse.move(*target, steps=steps)
        if hold_ms:
            page.wait_for_timeout(hold_ms)
        page.mouse.up()

    def test_01_a_thought_dropped_from_a_dot_takes_typing_at_once_every_time(self):
        page = self.scene()
        misses = []
        for index in range(REPEATS):
            self.press_dot(page, (A, B, C)[index % 3], hold_ms=(0, 120, 400)[index % 3], wobble=(0, 5, 2)[(index // 3) % 3], steps=(1, 6, 14)[index % 3])
            seen = self.typed_at_once(page)
            if seen is not True:
                misses.append((index, seen))
            self.cancel(page)
        self.assertEqual(misses, [], 'every new thought from a dot took what was typed at once')

    def test_02_the_plus_beside_a_selected_thought_takes_typing_at_once_every_time(self):
        page = self.scene()
        misses = []
        for index in range(REPEATS):
            node = page.locator('.sk-node', has_text=(A, B, C)[index % 3])
            node.click()
            page.get_by_role('button', name='Add a thought connected to', exact=False).click()
            seen = self.typed_at_once(page)
            if seen is not True:
                misses.append((index, seen))
            self.cancel(page)
        self.assertEqual(misses, [], 'every new thought from the + took what was typed at once')

    def test_03_a_press_on_the_dot_that_hardly_moves_does_not_leave_a_dead_draft(self):
        """A press that moves less than the click threshold connects from the dot (no draft); the next drop from it still takes typing."""
        page = self.scene()
        misses = []
        for index in range(REPEATS * 2):
            x, y = self.dot_of(page, A)
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 2, y + 1)
            page.mouse.up()
            page.keyboard.press('Escape')
            self.press_dot(page, B, hold_ms=60)
            seen = self.typed_at_once(page)
            if seen is not True:
                misses.append((index, seen))
            self.cancel(page)
        self.assertEqual(misses, [])

    def test_04_what_takes_the_focus_at_the_end_of_the_same_press_does_not_keep_it(self):
        """The end of the press (its release, mouseup or click) may move the focus to the map, as a click on the map's canvas does for its keys:
        the draft's field has it back at once, and what is typed lands in it. Simulated by a listener that does exactly that at the event."""
        page = self.scene()
        misses = []
        for index in range(REPEATS):
            event = ('pointerup', 'mouseup', 'click')[index % 3]
            x, y = self.dot_of(page, (A, B, C)[index % 3])
            canvas = page.locator('.sk-canvas').bounding_box()
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(canvas['x'] + canvas['width'] * 0.7, canvas['y'] + canvas['height'] * 0.65, steps=8)
            page.evaluate("""(type) => document.addEventListener(type, () => document.querySelector('.sk-canvas').focus({ preventScroll: true }), { once: true })""", event)
            page.mouse.up()
            seen = self.typed_at_once(page)
            if seen is not True:
                misses.append((index, event, seen))
            self.cancel(page)
        self.assertEqual(misses, [], 'the new thought took what was typed although the press ended by moving the focus to the map')


if __name__ == '__main__':
    unittest.main()
