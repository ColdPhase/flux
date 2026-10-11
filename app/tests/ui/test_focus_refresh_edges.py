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
    api = original.PauseRefreshProbe.api
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
                    self.addCleanup(lambda p=page: p.unroute_all(behavior='ignoreErrors'))
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
                self.addCleanup(lambda p=page: p.unroute_all(behavior='ignoreErrors'))
                try:
                    page.locator('body').press('f')
                    self.wait_held(page, held)
                    self.settings(page)
                    expect(self.note(page)).to_be_visible()
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
                    self.addCleanup(lambda p=page: p.unroute_all(behavior='ignoreErrors'))
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
