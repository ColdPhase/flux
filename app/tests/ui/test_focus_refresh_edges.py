"""Actual pause deadlines, acknowledged side effects and current-read recovery.

Only declared UI error responses are injected. Commands and Mailpit receipts are real; APIRequest
observations bypass those page routes. Original helpers retain their account and pageerror guards.
"""
from __future__ import annotations
import json
import re
import time
import unittest
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from uuid import uuid4
from urllib.parse import urlsplit
from playwright.sync_api import expect
import test_focus_refresh as original
import test_notifications as mail
from test_app_shell import ORIGIN, shot


def instant(seconds):
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class RefreshEdges(unittest.TestCase):
    def api(self, page, method, path, body=None, status=200):
        if method == 'DELETE' and body is None:
            response = page.request.delete(ORIGIN + path, headers={'origin': ORIGIN})
            self.assertEqual(response.status, status, response.text())
            return response.json() if response.text() else None
        return original.PauseRefreshProbe.api(self, page, method, path, body, status)
    actor = original.PauseRefreshProbe.actor
    pill = original.PauseRefreshProbe.pill
    note = original.PauseRefreshProbe.note
    setUpClass = classmethod(original.PauseRefreshProbe.setUpClass.__func__)
    tearDownClass = classmethod(original.PauseRefreshProbe.tearDownClass.__func__)

    def focused(self, label, **options):
        page, actor = self.actor(label, **options)
        until = instant(time.time() + 3600)
        self.api(page, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': until}, 'quietHours': {'enabled': False}})
        page.goto(f"/projects/{actor['project']}")
        if options.get('phone'):
            self.assertEqual(self.api(page, 'GET', '/api/v1/notification-preferences')['pause'], {'until': until})
        else:
            expect(self.pill(page)).to_be_visible()
        return page, actor, until

    def settings(self, page):
        if page.viewport_size['width'] <= 680:
            page.locator('header.top').get_by_role('button', name='Open navigation', exact=True).click()
            page.get_by_role('link', name=re.compile(r'settings and sign out$')).click()
            page.locator('a[href=\"/settings/notifications\"]').first.click()
        else:
            original.PauseRefreshProbe.settings(self, page)

    def warning(self, page):
        return page.locator('.nset > .nset__problem').filter(has_text='Current notification')

    def wait_held(self, page, held):
        for _ in range(80):
            if 'route' in held:
                return
            page.wait_for_timeout(50)
        self.fail('the real successful mutation must reach the response barrier')

    def wait_deadline(self, page, deadline):
        while time.time() < deadline + 0.3:
            page.wait_for_timeout(50)

    def assert_current_pause(self, page, until):
        self.assertEqual(self.api(page, 'GET', '/api/v1/notification-preferences')['pause'], {'until': until})
        if until:
            expect(self.pill(page)).to_be_visible()
            expect(self.note(page).locator('time')).to_have_attribute('datetime', until)
        else:
            expect(self.pill(page)).to_have_count(0)
            expect(self.note(page)).to_have_count(0)

    def mail_count(self, address):
        query = urllib.parse.quote(f'to:"{address}"')
        with urllib.request.urlopen(f'{mail.MAILPIT}/api/v1/search?query={query}') as response:
            return len(json.load(response).get('messages', []))

    def capture(self, page, state, *, phone=False, theme='light'):
        shot(page, f"focus-{state}-{'phone-390' if phone else 'desktop-1440'}-{theme}-{original.helper.base.ENGINE}")

    def assert_read_feedback_at_working_viewport(self, page, *, acknowledged):
        observed = page.get_by_role('note').filter(has_text='Current notification settings could not be refreshed.').evaluate_all("""notes => notes.map(note => {
          const box=note.getBoundingClientRect(), pane=note.closest('.pane-scroll')?.getBoundingClientRect();
          const button=Array.from(note.querySelectorAll('button')).find(button=>button.textContent.includes('Retry current settings'));
          const retry=button?.getBoundingClientRect(), hit=retry&&document.elementFromPoint(retry.x+retry.width/2,retry.y+retry.height/2);
          return {text:note.textContent, box:{top:box.top,bottom:box.bottom}, pane:pane&&{top:pane.top,bottom:pane.bottom},
            retry:retry&&{top:retry.top,bottom:retry.bottom,height:retry.height}, usable:!!hit&&(hit===button||button.contains(hit))};
        })""")
        receipt=page.locator('.nset__saved').evaluate("""element=>{
          const box=element.getBoundingClientRect(),pane=element.closest('.pane-scroll').getBoundingClientRect();
          return {text:element.textContent,visible:box.top>=pane.top&&box.bottom<=pane.bottom};
        }""")
        print('ACTUAL_WORKING_FEEDBACK ' + json.dumps({'engine':original.helper.base.ENGINE,'viewport':page.viewport_size,'notes':observed,'receipt':receipt}),flush=True)
        visible=[note for note in observed if note['pane'] and note['retry']
            and note['box']['top'] >= note['pane']['top'] and note['box']['bottom'] <= note['pane']['bottom']
            and note['retry']['top'] >= note['pane']['top'] and note['retry']['bottom'] <= note['pane']['bottom'] and note['usable']]
        self.assertTrue(visible, 'current-read qualifier and usable read-only Retry remain visible at the original action viewport')
        if acknowledged is not None:
            self.assertTrue((receipt['visible'] and acknowledged in receipt['text']) or any(acknowledged + '.' in note['text'] for note in visible),
                'the actual acknowledged result remains visible beside current-read feedback or in the existing visible header')

    def test_01_silent_remote_extension_is_read_at_the_old_deadline(self):
        page, actor = self.actor('Silent Extension')
        deadline = time.time() + 8
        until = instant(deadline)
        extended = instant(deadline + 30)
        self.api(page, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': until}, 'quietHours': {'enabled': False}})
        page.goto(f"/projects/{actor['project']}")
        self.settings(page)
        expect(self.note(page).locator('time')).to_have_attribute('datetime', until)
        self.assertEqual(self.api(page, 'GET', '/api/v1/notification-preferences')['pause'], {'until': until}, 'loaded before the real deadline')
        page.evaluate("window.__expiryFocusEvents=0; window.addEventListener('focus',()=>window.__expiryFocusEvents++)")
        reads = []
        page.on('request', lambda request: reads.append(time.time()) if request.method == 'GET' and urlsplit(request.url).path == '/api/v1/notification-preferences' else None)
        other = self.browser.new_context(base_url=ORIGIN, storage_state=page.context.storage_state(), service_workers='block')
        self.addCleanup(other.close)
        self.assertEqual(self.api(other, 'GET', '/api/v1/me')['user']['id'], actor['id'])
        self.api(other, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': extended}})
        self.wait_deadline(page, deadline)
        self.assert_current_pause(page, extended)
        self.assertEqual(page.evaluate('window.__expiryFocusEvents'), 0, 'no new page or synthetic window-focus signal')
        self.assertTrue(any(at >= deadline - 0.1 for at in reads), 'the old deadline actually made a current client GET')

    def test_02_failed_expiry_read_marks_unknown_then_read_only_retry_restores_remote_extension(self):
        page, actor = self.actor('Expiry Unavailable')
        deadline = time.time() + 8
        until, extended = instant(deadline), instant(deadline + 30)
        self.api(page, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': until}, 'quietHours': {'enabled': False}})
        page.goto(f"/projects/{actor['project']}")
        self.settings(page)
        expect(self.note(page)).to_be_visible()
        self.assertEqual(self.api(page, 'GET', '/api/v1/notification-preferences')['pause'], {'until': until})
        other = self.browser.new_context(base_url=ORIGIN, storage_state=page.context.storage_state(), service_workers='block')
        self.addCleanup(other.close)
        self.api(other, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': extended}})
        phase = {'fail': True}
        reads, patches = [], []
        def handler(route):
            if route.request.method == 'GET' and phase['fail']:
                reads.append(route.request.url)
                route.fulfill(status=500, content_type='application/json', body='{}')
            else:
                if route.request.method == 'PATCH': patches.append(route.request.post_data_json)
                route.continue_()
        page.route('**/api/v1/notification-preferences', handler)
        self.addCleanup(lambda: page.unroute_all(behavior='ignoreErrors'))
        self.wait_deadline(page, deadline)
        expect(self.warning(page)).to_contain_text('Current notification pause could not be checked.')
        expect(self.warning(page)).to_contain_text('last confirmed')
        expect(self.pill(page)).to_have_count(0)
        expect(self.note(page)).to_have_count(0)
        self.assertEqual(self.api(page, 'GET', '/api/v1/notification-preferences')['pause'], {'until': extended}, 'unknown does not mean resumed')
        self.assertGreater(len(reads), 0)
        self.capture(page, 'expired-read-unavailable')
        phase['fail'] = False
        self.warning(page).get_by_role('button', name='Retry current settings', exact=True).click()
        expect(self.warning(page)).to_have_count(0)
        self.assert_current_pause(page, extended)
        self.assertEqual(patches, [], 'expiry/recovery performs no guessed mutation')
        self.capture(page, 'extended-read-recovered')

    def test_03_acknowledged_settings_save_keeps_fields_and_recovers_without_another_patch(self):
        for phone in (False, True):
            for theme in ('light', 'dark'):
                with self.subTest(phone=phone, theme=theme):
                    page, actor, until = self.focused('Saved Read ' + str(phone) + theme, phone=phone, theme=theme)
                    self.settings(page)
                    held, reads, patches = {}, [], []
                    def handler(route):
                        if route.request.method == 'GET' and held.get('fail'):
                            reads.append(route.request.url)
                            route.fulfill(status=500, content_type='application/json', body='{}')
                        elif route.request.method == 'PATCH' and 'route' not in held:
                            patches.append(route.request.post_data_json)
                            self.assertEqual(route.request.post_data_json, {'level': 'everything'})
                            response = route.fetch()
                            self.assertEqual(response.status, 200)
                            held.update(route=route, response=response)
                        else:
                            if route.request.method == 'PATCH': patches.append(route.request.post_data_json)
                            route.continue_()
                    page.route('**/api/v1/notification-preferences', handler)
                    self.addCleanup(lambda p=page: None if p.is_closed() else p.unroute_all(behavior='ignoreErrors'))
                    try:
                        page.get_by_role('radio', name=re.compile(r'^Everything(?:\s|$)')).check()
                        self.wait_held(page, held)
                        if phone:
                            other = self.browser.new_context(base_url=ORIGIN, storage_state=page.context.storage_state(), service_workers='block')
                            self.addCleanup(other.close)
                            self.api(other, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': None}})
                            # The actual focus observation confirms the other context's Resume.
                            page.evaluate("window.dispatchEvent(new Event('focus'))")
                            expect(self.note(page)).to_have_count(0)
                        else:
                            self.pill(page).click()
                            expect(self.pill(page)).to_have_count(0)
                        held['fail'] = True
                        held['route'].fulfill(response=held['response']); held['released'] = True
                        expect(self.warning(page)).to_contain_text('Current notification settings could not be refreshed.')
                        expect(page.locator('.nset__saved')).to_have_text('Saved')
                        expect(page.get_by_role('radio', name=re.compile(r'^Everything(?:\s|$)'))).to_be_checked()
                        expect(page.get_by_text('Could not save. Try again.', exact=True)).to_have_count(0)
                        actual = self.api(page, 'GET', '/api/v1/notification-preferences')
                        self.assertEqual(actual['level'], 'everything'); self.assertEqual(actual['pause'], {'until': None})
                        self.assertGreater(len(reads), 0)
                        self.capture(page, 'save-current-read-unavailable', phone=phone, theme=theme)
                        self.assert_read_feedback_at_working_viewport(page, acknowledged='Saved')
                        expect(page.locator('.ui-toast')).to_have_count(0, timeout=7000)
                        self.capture(page, 'save-current-read-unavailable-feedback-retired', phone=phone, theme=theme)
                        self.assert_read_feedback_at_working_viewport(page, acknowledged='Saved')
                        before = len(patches)
                        self.api(page, 'PATCH', '/api/v1/notification-preferences', {'level': 'nothing'})
                        held['fail'] = False
                        self.warning(page).get_by_role('button', name='Retry current settings', exact=True).click()
                        expect(self.warning(page)).to_have_count(0)
                        expect(page.get_by_role('radio', name='Nothing', exact=True)).to_be_checked()
                        self.assertEqual(len(patches), before, 'Retry is a read, not a duplicate save')
                        self.capture(page, 'save-current-read-recovered', phone=phone, theme=theme)
                    finally:
                        if 'route' in held and not held.get('released'): held['route'].fulfill(response=held['response'])
                    page.close()

    def test_04_overtaken_focus_acknowledgement_survives_failed_read_and_recovers(self):
        for theme in ('light', 'dark'):
            with self.subTest(theme=theme):
                page, actor = self.actor('Focus Saved ' + theme, theme=theme)
                self.api(page, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': None}, 'quietHours': {'enabled': False}})
                page.goto(f"/projects/{actor['project']}")
                expect(page.locator('header.top').get_by_role('navigation', name='Project views')).to_be_visible()
                held, reads, patches = {}, [], []
                def handler(route):
                    if route.request.method == 'GET' and held.get('fail'):
                        reads.append(route.request.url)
                        route.fulfill(status=500, content_type='application/json', body='{}')
                    elif route.request.method == 'PATCH' and 'route' not in held:
                        patches.append(route.request.post_data_json)
                        self.assertIsInstance(route.request.post_data_json['pause']['until'], str)
                        response = route.fetch(); self.assertEqual(response.status, 200)
                        held.update(route=route, response=response)
                    else:
                        if route.request.method == 'PATCH': patches.append(route.request.post_data_json)
                        route.continue_()
                page.route('**/api/v1/notification-preferences', handler)
                self.addCleanup(lambda p=page: None if p.is_closed() else p.unroute_all(behavior='ignoreErrors'))
                try:
                    page.locator('body').press('f')
                    self.wait_held(page, held)
                    self.settings(page)
                    expect(self.note(page)).to_be_visible()
                    with page.expect_response(lambda response: response.request.method == 'PATCH'
                                              and urlsplit(response.url).path == '/api/v1/notification-preferences'
                                              and response.request.post_data_json == {'pause': {'until': None}}
                                              and response.status == 200):
                        page.get_by_role('button', name='Resume now', exact=True).click()
                    expect(self.note(page)).to_have_count(0)
                    self.assert_current_pause(page, None)
                    held['fail'] = True
                    held['route'].fulfill(response=held['response']); held['released'] = True
                    expect(page.get_by_text('Focus change saved, but the current notification pause could not be checked. The last confirmed state is shown.', exact=True)).to_be_visible()
                    expect(page.get_by_text('Focus did not start: notifications are not paused', exact=True)).to_have_count(0)
                    self.assert_current_pause(page, None)
                    self.assertGreater(len(reads), 0)
                    self.capture(page, 'focus-ack-current-read-unavailable', theme=theme)
                    before = len(patches)
                    held['fail'] = False
                    page.locator('header.top').get_by_role('button', name='More', exact=True).click()
                    page.get_by_role('menuitemcheckbox', name='Check notification pause', exact=True).click()
                    expect(self.warning(page)).to_have_count(0)
                    self.assert_current_pause(page, None)
                    self.assertEqual(len(patches), before, 'uncertain Focus recovery only reads')
                    self.capture(page, 'focus-ack-current-read-recovered', theme=theme)
                finally:
                    if 'route' in held and not held.get('released'): held['route'].fulfill(response=held['response'])
                page.close()

    def test_05_acknowledged_address_sends_one_mail_and_read_retry_clears_input_without_resending(self):
        for phone in (False, True):
            for theme in ('light', 'dark'):
                with self.subTest(phone=phone, theme=theme):
                    page, actor, until = self.focused('Address Saved ' + str(phone) + theme, phone=phone, theme=theme)
                    self.settings(page)
                    address = f'focus-refresh-{uuid4().hex}@example.test'
                    held, posts, reads = {}, [], []
                    def address_handler(route):
                        if route.request.method == 'POST':
                            posts.append(route.request.post_data_json)
                            response = route.fetch(); self.assertEqual(response.status, 200)
                            held.update(route=route, response=response)
                        else: route.continue_()
                    def preferences_handler(route):
                        if route.request.method == 'GET' and held.get('fail'):
                            reads.append(route.request.url)
                            route.fulfill(status=500, content_type='application/json', body='{}')
                        else: route.continue_()
                    page.route('**/api/v1/notification-address', address_handler)
                    page.route('**/api/v1/notification-preferences', preferences_handler)
                    self.addCleanup(lambda p=page: None if p.is_closed() else p.unroute_all(behavior='ignoreErrors'))
                    try:
                        field = page.get_by_label('Add an extra address, for example the inbox you read most', exact=True)
                        field.fill(address)
                        page.get_by_role('button', name='Send link', exact=True).click()
                        self.wait_held(page, held)
                        mail.wait_for_mail(address, '/settings/notifications/verify')
                        self.assertEqual(self.mail_count(address), 1)
                        if phone:
                            other = self.browser.new_context(base_url=ORIGIN, storage_state=page.context.storage_state(), service_workers='block')
                            self.addCleanup(other.close)
                            self.api(other, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': None}})
                            page.evaluate("window.dispatchEvent(new Event('focus'))")
                            expect(self.note(page)).to_have_count(0)
                        else:
                            self.pill(page).click(); expect(self.pill(page)).to_have_count(0)
                        held['fail'] = True
                        held['route'].fulfill(response=held['response']); held['released'] = True
                        expect(page.locator('.nset__saved')).to_have_text('Verification link sent')
                        expect(page.locator('.nset__extra').get_by_text(address, exact=True)).to_be_visible()
                        local_warning = page.locator('.nset__extra > .nset__problem')
                        expect(local_warning).to_contain_text('Current notification settings could not be refreshed.')
                        expect(page.get_by_text('Could not send the link. Try again.', exact=True)).to_have_count(0)
                        actual = self.api(page, 'GET', '/api/v1/notification-preferences')
                        self.assertEqual(actual['email']['extra']['email'], address)
                        self.assertFalse(actual['email']['extra']['verified'])
                        self.assertEqual(actual['pause'], {'until': None})
                        self.assertGreater(len(reads), 0); self.assertEqual(len(posts), 1)
                        self.capture(page, 'address-current-read-unavailable', phone=phone, theme=theme)
                        self.assert_read_feedback_at_working_viewport(page, acknowledged=None)
                        # The other current server facts change before read-only Retry. The cleared
                        # form returning after this real removal proves the successful boolean path.
                        self.api(page, 'DELETE', '/api/v1/notification-address')
                        self.api(page, 'PATCH', '/api/v1/notification-preferences', {'level': 'everything'})
                        held['fail'] = False
                        local_warning.get_by_role('button', name='Retry current settings', exact=True).click()
                        expect(self.warning(page)).to_have_count(0)
                        expect(field).to_have_value('')
                        expect(page.get_by_role('radio', name=re.compile(r'^Everything(?:\s|$)'))).to_be_checked()
                        self.assertEqual(len(posts), 1, 'Retry must not repeat the acknowledged POST')
                        self.assertEqual(self.mail_count(address), 1, 'Retry sends no additional confirmation email')
                        self.assert_current_pause(page, None)
                        self.capture(page, 'address-current-read-recovered', phone=phone, theme=theme)
                    finally:
                        if 'route' in held and not held.get('released'): held['route'].fulfill(response=held['response'])
                    page.close()

    def test_06_failed_address_mutation_keeps_inline_error_input_and_no_success(self):
        page, actor, until = self.focused('Address Failed')
        self.settings(page)
        address = f'focus-failed-{uuid4().hex}@example.test'
        page.route('**/api/v1/notification-address', lambda route: route.fulfill(status=500, content_type='application/json', body='{}') if route.request.method == 'POST' else route.continue_())
        self.addCleanup(lambda: page.unroute_all(behavior='ignoreErrors'))
        field = page.get_by_label('Add an extra address, for example the inbox you read most', exact=True)
        field.fill(address)
        page.get_by_role('button', name='Send link', exact=True).click()
        expect(page.get_by_role('alert')).to_have_text('Could not send the link. Try again.')
        expect(field).to_have_value(address)
        expect(page.locator('.nset__saved')).to_have_text('')
        self.assertEqual(self.api(page, 'GET', '/api/v1/notification-preferences')['email']['extra'], None)
        self.assertEqual(self.mail_count(address), 0)

    def test_07_old_lifetime_read_and_deadline_cannot_publish_into_the_next_account(self):
        page, actor = self.actor('Deadline A')
        other, next_actor = self.actor('Deadline B')
        self.api(other, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': None}, 'quietHours': {'enabled': False}})
        deadline = time.time() + 8
        self.api(page, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': instant(deadline)}, 'quietHours': {'enabled': False}})
        page.goto(f"/projects/{actor['project']}")
        expect(self.pill(page)).to_be_visible()
        epoch = original.helper.base.CompositionProbe.instrument(self, page)
        held = {}
        def handler(route):
            if route.request.method == 'GET' and 'route' not in held:
                response = route.fetch(); self.assertEqual(response.status, 200)
                held.update(route=route, response=response)
            else: route.continue_()
        page.route('**/api/v1/notification-preferences', handler)
        self.addCleanup(lambda: page.unroute_all(behavior='ignoreErrors'))
        try:
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            self.wait_held(page, held)
            original.helper.base.CompositionProbe.signin_swap(self, page, next_actor, epoch)
            page.wait_for_function("id => window.__peer372.events.some(e=>e.detail.ownerId===id)", arg=next_actor['id'])
            page.evaluate("window.__peer372.phase='B'")
            held['route'].fulfill(response=held['response']); held['released'] = True
            self.wait_deadline(page, deadline)
            self.assertEqual(self.api(page, 'GET', '/api/v1/me')['user']['id'], next_actor['id'])
            self.assertEqual(self.api(page, 'GET', '/api/v1/notification-preferences')['pause'], {'until': None})
            expect(self.pill(page)).to_have_count(0)
            events = page.evaluate('window.__peer372.events')
            self.assertEqual([e for e in events if e['phase'] == 'B' and e['detail']['ownerId'] == actor['id']], [], 'retired read/timer cannot emit as A')
        finally:
            if 'route' in held and not held.get('released'): held['route'].fulfill(response=held['response'])

    def test_08_confirmed_local_replacement_retires_the_previous_deadline(self):
        page, actor = self.actor('Deadline Replacement')
        deadline = time.time() + 8
        self.api(page, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': instant(deadline)}, 'quietHours': {'enabled': False}})
        page.goto(f"/projects/{actor['project']}")
        self.settings(page)
        expect(self.note(page)).to_be_visible()
        page.locator('body').press('f'); expect(self.pill(page)).to_have_count(0)
        page.locator('body').press('f'); expect(self.pill(page)).to_be_visible()
        current = self.api(page, 'GET', '/api/v1/notification-preferences')['pause']['until']
        self.assertIsNotNone(current)
        reads = []
        page.on('request', lambda request: reads.append(request.url) if request.method == 'GET' and urlsplit(request.url).path == '/api/v1/notification-preferences' else None)
        self.wait_deadline(page, deadline)
        self.assert_current_pause(page, current)
        self.assertEqual(reads, [], 'the retired old deadline must not schedule another read')

    def test_09_initial_load_error_stays_an_error_and_real_retry_loads_without_mutation(self):
        page, actor = self.actor('Initial Read Failed')
        phase = {'fail': True}
        patches = []
        def handler(route):
            if route.request.method == 'GET' and phase['fail']:
                route.fulfill(status=500, content_type='application/json', body='{}')
            else:
                if route.request.method == 'PATCH': patches.append(route.request.post_data_json)
                route.continue_()
        page.route('**/api/v1/notification-preferences', handler)
        self.addCleanup(lambda: page.unroute_all(behavior='ignoreErrors'))
        page.goto(f"/projects/{actor['project']}")
        self.settings(page)
        expect(page.get_by_role('heading', name='Notification settings could not load', exact=True)).to_be_visible()
        phase['fail'] = False
        page.get_by_role('button', name='Retry', exact=True).click()
        expect(page.get_by_role('radiogroup')).to_be_visible()
        expect(page.get_by_role('heading', name='Notification settings could not load', exact=True)).to_have_count(0)
        self.assertEqual(patches, [])

    def test_10_old_settings_load_rejection_cannot_mark_a_newer_validated_pause_unknown(self):
        page, actor, until = self.focused('Old Load Failure')
        held = {}
        def handler(route):
            if route.request.method == 'GET' and 'route' not in held and '/settings/notifications' in page.url:
                response = route.fetch(); self.assertEqual(response.status, 200)
                held.update(route=route, response=response)
            else: route.continue_()
        page.route('**/api/v1/notification-preferences', handler)
        self.addCleanup(lambda: page.unroute_all(behavior='ignoreErrors'))
        try:
            self.settings(page)
            self.wait_held(page, held)
            current = instant(time.time() + 7200)
            self.api(page, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': current}})
            page.evaluate("window.__pauseRace=[];window.addEventListener('flux:pause-changed',e=>window.__pauseRace.push(e.detail));window.dispatchEvent(new Event('focus'))")
            expect(self.pill(page).locator('time')).to_have_attribute('datetime', current)
            self.assertTrue(page.evaluate('window.__pauseRace.some(e=>!e.uncertain)'), 'a newer actual current read was accepted')
            page.evaluate('window.__pauseRace=[]')
            held['route'].fulfill(status=500, content_type='application/json', body='{}'); held['released'] = True
            expect(page.get_by_role('heading', name='Notification settings could not load', exact=True)).to_be_visible()
            self.assertEqual(self.api(page, 'GET', '/api/v1/notification-preferences')['pause'], {'until': current})
            self.assertEqual(page.evaluate('window.__pauseRace.filter(e=>e.uncertain)'), [], 'the obsolete failing load cannot invalidate the newer observation')
            expect(self.pill(page).locator('time')).to_have_attribute('datetime', current)
        finally:
            if 'route' in held and not held.get('released'): held['route'].fulfill(response=held['response'])

    def test_11_old_reconciliation_rejection_keeps_newer_pause_verified_and_full_settings_uncertain(self):
        page, actor, until = self.focused('Old Reconciliation Failure')
        self.settings(page)
        held = {'reconcile': False}
        def handler(route):
            if route.request.method == 'PATCH' and 'route' not in held:
                self.assertEqual(route.request.post_data_json, {'level': 'everything'})
                response = route.fetch(); self.assertEqual(response.status, 200)
                held.update(route=route, response=response)
            elif route.request.method == 'GET' and held['reconcile'] and 'readRoute' not in held:
                response = route.fetch(); self.assertEqual(response.status, 200)
                held.update(readRoute=route, readResponse=response)
            else: route.continue_()
        page.route('**/api/v1/notification-preferences', handler)
        self.addCleanup(lambda: page.unroute_all(behavior='ignoreErrors'))
        try:
            page.get_by_role('radio', name=re.compile(r'^Everything(?:\s|$)')).check()
            self.wait_held(page, held)
            self.pill(page).click(); expect(self.pill(page)).to_have_count(0)
            held['reconcile'] = True
            held['route'].fulfill(response=held['response']); held['released'] = True
            for _ in range(80):
                if 'readRoute' in held: break
                page.wait_for_timeout(50)
            self.assertIn('readRoute', held, 'the actual reconciliation GET must precede the newer read')
            current = instant(time.time() + 7200)
            self.api(page, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': current}})
            page.evaluate("window.__pauseRace=[];window.addEventListener('flux:pause-changed',e=>window.__pauseRace.push(e.detail));window.dispatchEvent(new Event('focus'))")
            expect(self.pill(page).locator('time')).to_have_attribute('datetime', current)
            self.assertTrue(page.evaluate('window.__pauseRace.some(e=>!e.uncertain)'))
            page.evaluate('window.__pauseRace=[]')
            held['readRoute'].fulfill(status=500, content_type='application/json', body='{}'); held['readReleased'] = True
            expect(page.locator('.nset__saved')).to_have_text('Saved')
            expect(self.warning(page)).to_contain_text('Current notification settings could not be refreshed.')
            self.assertEqual(page.evaluate('window.__pauseRace.filter(e=>e.uncertain)'), [], 'the older failed read cannot downgrade current pause verification')
            expect(self.pill(page).locator('time')).to_have_attribute('datetime', current)
            actual = self.api(page, 'GET', '/api/v1/notification-preferences')
            self.assertEqual(actual['level'], 'everything'); self.assertEqual(actual['pause'], {'until': current})
        finally:
            if 'route' in held and not held.get('released'): held['route'].fulfill(response=held['response'])
            if 'readRoute' in held and not held.get('readReleased'): held['readRoute'].fulfill(response=held['readResponse'])

    def test_12_future_unverified_pause_is_qualified_and_f_recovers_by_read_only(self):
        for phone in (False, True):
            for theme in ('light', 'dark'):
                with self.subTest(phone=phone, theme=theme):
                    page, actor, until = self.focused('Future Read ' + str(phone) + theme, phone=phone, theme=theme)
                    self.settings(page)
                    expect(self.note(page)).to_be_visible()
                    phase = {'fail': True}
                    reads, patches = [], []
                    def handler(route):
                        if route.request.method == 'GET':
                            reads.append({'failed': phase['fail'], 'url': route.request.url})
                            if phase['fail']:
                                route.fulfill(status=500, content_type='application/json', body='{}'); return
                        elif route.request.method == 'PATCH': patches.append(route.request.post_data_json)
                        route.continue_()
                    page.route('**/api/v1/notification-preferences', handler)
                    self.addCleanup(lambda p=page: None if p.is_closed() else p.unroute_all(behavior='ignoreErrors'))
                    page.evaluate("window.dispatchEvent(new Event('focus'))")
                    expect(self.warning(page)).to_contain_text('Current notification pause could not be checked.')
                    qualified = page.get_by_role('status').filter(has_text='Last confirmed pause: push and email were paused until')
                    expect(qualified.locator('time')).to_have_attribute('datetime', until)
                    expect(self.note(page)).to_have_count(0)
                    if not phone:
                        pill = page.locator('header.top').get_by_role('button', name=re.compile(r'^Focus · last confirmed pause until'))
                        expect(pill).to_be_visible()
                        expect(pill.locator('time')).to_have_attribute('datetime', until)
                        expect(pill).to_have_attribute('title', 'Check current notification pause (F)')
                    self.assertEqual(self.api(page, 'GET', '/api/v1/notification-preferences')['pause'], {'until': until})
                    self.assertEqual(len(reads), 1, 'the actual unavailable current read is accounted for')
                    self.capture(page, 'future-pause-read-unavailable', phone=phone, theme=theme)
                    other = self.browser.new_context(base_url=ORIGIN, storage_state=page.context.storage_state(), service_workers='block')
                    self.addCleanup(other.close)
                    self.assertEqual(self.api(other, 'GET', '/api/v1/me')['user']['id'], actor['id'])
                    self.api(other, 'PATCH', '/api/v1/notification-preferences', {'pause': {'until': None}})
                    phase['fail'] = False
                    if phone:
                        self.warning(page).get_by_role('button', name='Retry current settings', exact=True).click()
                    else:
                        page.locator('body').press('f')
                    expect(self.warning(page)).to_have_count(0)
                    expect(qualified).to_have_count(0)
                    self.assert_current_pause(page, None)
                    self.assertEqual(len(reads), 2, 'one recovery GET, no extra action')
                    self.assertFalse(reads[-1]['failed'])
                    self.assertEqual(patches, [], 'F/header recovery must not guess or send a PATCH')
                    expect(page.get_by_text('Current notification pause could not be checked. Try again.', exact=True)).to_have_count(0)
                    self.capture(page, 'future-pause-read-recovered', phone=phone, theme=theme)
                    page.close()


    def test_13_expired_link_recovery_keeps_readable_primary_label(self):
        for phone in (False, True):
            for theme in ('light', 'dark'):
                with self.subTest(phone=phone, theme=theme):
                    context = self.browser.new_context(base_url=ORIGIN, viewport={'width':390,'height':844} if phone else {'width':1440,'height':900},
                        device_scale_factor=3 if phone else 1, is_mobile=phone, has_touch=phone, color_scheme=theme, service_workers='block')
                    self.addCleanup(context.close)
                    page=context.new_page(); errors=[]
                    page.on('pageerror',lambda error:errors.append(str(error)))
                    def guard(observed=errors):
                        print('PEER_PAGEERRORS '+json.dumps({'engine':original.helper.base.ENGINE,'actor':'Expired recovery','errors':observed}),flush=True)
                        self.assertEqual(observed,[],'no uncaught browser errors')
                    self.addCleanup(guard)
                    page.goto('/unsubscribe?token=not-a-real-token')
                    with page.expect_response(lambda response: urlsplit(response.url).path=='/api/v1/notifications/unsubscribe') as request:
                        page.get_by_role('button',name='Stop these emails',exact=True).click()
                    self.assertEqual(request.value.status,404,'the actual invalid-token guard refuses before changing email destination')
                    expect(page.get_by_role('heading',name='This link has expired',exact=True)).to_be_visible()
                    link=page.get_by_role('link',name='Notification settings',exact=True)
                    expect(link).to_be_visible()
                    self.capture(page,'expired-link-recovery',phone=phone,theme=theme)
                    colors=link.evaluate("""element=>{
                      const style=getComputedStyle(element), box=element.getBoundingClientRect();
                      const probe=document.createElement('span');probe.style.color='var(--oninv)';element.append(probe);
                      const inverted=getComputedStyle(probe).color;probe.remove();
                      return {color:style.color,inverted,background:style.backgroundColor,gradient:style.backgroundImage,
                        width:box.width,height:box.height,top:box.top,bottom:box.bottom,viewport:innerHeight};
                    }""")
                    print('ACTUAL_EXPIRED_RECOVERY '+json.dumps({'engine':original.helper.base.ENGINE,'phone':phone,'theme':theme,'colors':colors}),flush=True)
                    self.assertGreaterEqual(colors['height'],44)
                    self.assertGreaterEqual(colors['top'],0); self.assertLessEqual(colors['bottom'],colors['viewport'])
                    self.assertEqual(colors['color'],colors['inverted'],'the actual primary recovery action uses the fixed readable on-inverted foreground')
                    def luminance(color):
                        rgb=[float(x)/255 for x in re.findall(r'[\d.]+',color)[:3]]
                        linear=[x/12.92 if x<=0.04045 else ((x+0.055)/1.055)**2.4 for x in rgb]
                        return sum(v*w for v,w in zip(linear,[0.2126,0.7152,0.0722]))
                    backgrounds=re.findall(r'rgba?\([^)]+\)',colors['gradient']) or [colors['background']]
                    foreground=luminance(colors['color'])
                    self.assertGreaterEqual(min((max(foreground,luminance(bg))+0.05)/(min(foreground,luminance(bg))+0.05) for bg in backgrounds),4.5)
                    self.assertEqual(errors,[],'no uncaught browser errors')
                    page.close()

    def test_14_other_settings_commands_keep_read_feedback_at_their_own_controls(self):
        for area in ('quietHours', 'morningSummary', 'mention', 'mute'):
            for phone in (False, True):
                for theme in ('light', 'dark'):
                    with self.subTest(area=area, phone=phone, theme=theme):
                        page, actor, until = self.focused('Working ' + area + str(phone) + theme, phone=phone, theme=theme)
                        self.settings(page)
                        held, writes, reads = {}, [], []
                        def handler(route):
                            if route.request.method == 'GET':
                                reads.append({'failed': bool(held.get('fail')), 'url': route.request.url})
                                if held.get('fail'):
                                    route.fulfill(status=500, content_type='application/json', body='{}'); return
                            elif route.request.method in ('PATCH', 'PUT'):
                                writes.append({'method':route.request.method,'body':route.request.post_data_json})
                                if 'route' not in held:
                                    response=route.fetch(); self.assertEqual(response.status,200)
                                    held.update(route=route,response=response); return
                            route.continue_()
                        page.route('**/api/v1/notification-preferences**',handler)
                        self.addCleanup(lambda p=page:None if p.is_closed() else p.unroute_all(behavior='ignoreErrors'))
                        try:
                            if area=='mute':
                                page.get_by_label('Place to mute',exact=True).select_option('project:'+actor['project'])
                                control=page.get_by_role('button',name='Mute',exact=True)
                                done='Muted '+actor['projectName']
                            elif area=='mention':
                                control=page.get_by_role('checkbox',name='Mentions: Inbox',exact=True).locator('..')
                                done='Saved'
                            else:
                                control=page.get_by_role('switch',name=re.compile('^'+('Quiet hours' if area=='quietHours' else 'Morning summary')))
                                done='Saved'
                            control.tap() if phone else control.click()
                            self.wait_held(page,held)
                            other=self.browser.new_context(base_url=ORIGIN,storage_state=page.context.storage_state(),service_workers='block')
                            self.addCleanup(other.close)
                            self.assertEqual(self.api(other,'GET','/api/v1/me')['user']['id'],actor['id'])
                            self.api(other,'PATCH','/api/v1/notification-preferences',{'pause':{'until':None}})
                            page.evaluate("window.dispatchEvent(new Event('focus'))")
                            expect(self.note(page)).to_have_count(0)
                            held['fail']=True
                            held['route'].fulfill(response=held['response']);held['released']=True
                            expect(self.warning(page)).to_contain_text('Current notification settings could not be refreshed.')
                            expect(page.locator('.nset__saved')).to_have_text(done)
                            actual=self.api(page,'GET','/api/v1/notification-preferences')
                            self.assertEqual(actual['pause'],{'until':None})
                            if area in ('quietHours','morningSummary'):self.assertTrue(actual[area]['enabled'])
                            elif area=='mention':self.assertFalse(actual['channels']['mention']['inApp'])
                            else:self.assertTrue(any(place['id']==actor['project'] for place in actual['muted']))
                            self.assertEqual(len(writes),1,'only the actual control command was admitted')
                            self.assertEqual(sum(read['failed'] for read in reads),1)
                            self.capture(page,'working-'+area+'-read-unavailable',phone=phone,theme=theme)
                            self.assert_read_feedback_at_working_viewport(page,acknowledged=done)
                            local=page.get_by_role('note').filter(has_text=done+'.').filter(has_text='Current notification settings could not be refreshed.')
                            expect(local).to_have_count(1)
                            self.assertIsNone(local.get_attribute('aria-live'),'the compact counterpart adds no second live announcement')
                            held['fail']=False
                            retry=local.get_by_role('button',name='Retry current settings',exact=True)
                            retry.tap() if phone else retry.click()
                            expect(self.warning(page)).to_have_count(0);expect(local).to_have_count(0)
                            self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences'),actual)
                            self.assertEqual(len(writes),1,'read-only recovery sends no duplicate control command')
                            self.assertFalse(reads[-1]['failed'])
                        finally:
                            if 'route' in held and not held.get('released'):held['route'].fulfill(response=held['response'])
                        page.close()


    def test_15_mixed_queued_actions_keep_only_the_latest_ack_at_the_latest_control(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, actor, until=self.focused('Mixed Working '+str(phone),phone=phone)
                self.settings(page)
                held, writes, failed_reads={},[],[]
                def handler(route):
                    if route.request.method=='GET' and held.get('fail'):
                        failed_reads.append(route.request.url)
                        route.fulfill(status=500,content_type='application/json',body='{}');return
                    if route.request.method=='PATCH':
                        writes.append(route.request.post_data_json)
                        response=route.fetch();self.assertEqual(response.status,200)
                        key='first' if 'first' not in held else 'second'
                        held[key]={'route':route,'response':response};return
                    route.continue_()
                page.route('**/api/v1/notification-preferences',handler)
                self.addCleanup(lambda p=page:None if p.is_closed() else p.unroute_all(behavior='ignoreErrors'))
                try:
                    page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)')).check()
                    for _ in range(80):
                        if 'first' in held:break
                        page.wait_for_timeout(50)
                    self.assertIn('first',held)
                    page.get_by_role('checkbox',name='Mentions: Inbox',exact=True).uncheck()
                    self.assertEqual(len(writes),1,'second real action is queued while first ACK is held')
                    other=self.browser.new_context(base_url=ORIGIN,storage_state=page.context.storage_state(),service_workers='block')
                    self.addCleanup(other.close)
                    self.api(other,'PATCH','/api/v1/notification-preferences',{'pause':{'until':None}})
                    page.evaluate("window.dispatchEvent(new Event('focus'))")
                    expect(self.note(page)).to_have_count(0)
                    held['fail']=True
                    held['first']['route'].fulfill(response=held['first']['response']);held['first']['released']=True
                    for _ in range(80):
                        if 'second' in held:break
                        page.wait_for_timeout(50)
                    self.assertIn('second',held)
                    expect(page.locator('.nset__saved')).to_be_empty()
                    expect(page.get_by_role('note').filter(has_text=re.compile(r'^Saved\.'))).to_have_count(0)
                    self.assertEqual(len(failed_reads),1,'the overtaken first ACK has its real failed reconciliation')
                    actual=self.api(page,'GET','/api/v1/notification-preferences')
                    self.assertEqual(actual['pause'],{'until':None});self.assertFalse(actual['channels']['mention']['inApp'])
                    held['second']['route'].fulfill(response=held['second']['response']);held['second']['released']=True
                    expect(page.locator('.nset__saved')).to_have_text('Saved')
                    expect(self.warning(page)).to_contain_text('Current notification settings could not be refreshed.')
                    local=page.get_by_role('note').filter(has_text=re.compile(r'^Saved\.'))
                    expect(local).to_have_count(1)
                    self.assertEqual(local.locator('xpath=ancestor::tr/preceding-sibling::tr[1]').get_by_role('rowheader').inner_text().splitlines()[0],'Mentions',
                        'the real latest command keeps its feedback beside its actual channel row')
                    self.assertEqual(writes,[{'level':'everything'},{'channels':{'mention':{'inApp':False}}}])
                    self.assertEqual(len(failed_reads),2)
                    self.capture(page,'mixed-latest-command-read-unavailable',phone=phone)
                    self.assert_read_feedback_at_working_viewport(page,acknowledged='Saved')
                    held['fail']=False
                    local.get_by_role('button',name='Retry current settings',exact=True).click()
                    expect(self.warning(page)).to_have_count(0);expect(local).to_have_count(0)
                    self.assertEqual(len(writes),2,'Retry performs no command for either queued action')
                    self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences'),actual)
                finally:
                    for key in ('first','second'):
                        if key in held and not held[key].get('released'):held[key]['route'].fulfill(response=held[key]['response'])
                page.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
