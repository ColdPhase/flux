"""Real confirmed pause changes survive older reads/action replies on the same account."""
from __future__ import annotations
import json
import re
import time
import unittest
from datetime import datetime, timezone
from urllib.parse import urlsplit
import test_focus_lifecycle as base
from playwright.sync_api import expect
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

class PauseTruthProbe(unittest.TestCase):
    api=base.CompositionProbe.api
    actor=base.CompositionProbe.actor
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:start_forwarder(ORIGIN,UPSTREAM)
        cls.pw=base.sync_playwright().start();cls.browser=getattr(cls.pw,base.ENGINE).launch()
        assert cls.browser.browser_type.name==base.ENGINE
        print(f'ACTUAL_UI_ENGINE={cls.browser.browser_type.name}',flush=True)
        expect.set_options(timeout=8000)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def focused(self,label):
        page,A=self.actor(label)
        until=datetime.fromtimestamp(time.time()+3600,tz=timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        self.api(page,'PATCH','/api/v1/notification-preferences',{'pause':{'until':until},'quietHours':{'enabled':False}})
        page.goto(f"/projects/{A['project']}")
        expect(self.pill(page)).to_be_visible()
        return page,A,until
    def pill(self,page):
        return page.locator('header.top').get_by_role('button',name=re.compile(r'^Focus · notifications paused until'))
    def note(self,page):
        return page.get_by_role('status').filter(has_text='Focus: push and email are paused until')
    def settings(self,page):
        page.get_by_role('link',name='Settings',exact=True).click()
        page.locator('a[href="/settings/notifications"]').first.click()
    def test_01_header_resume_keeps_loaded_settings_truthful(self):
        page,A,until=self.focused('Header Truth')
        self.settings(page)
        expect(self.note(page)).to_be_visible()
        self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences')['pause'],{'until':until})
        self.pill(page).click();expect(self.pill(page)).to_have_count(0)
        pause=self.api(page,'GET','/api/v1/notification-preferences')['pause'];self.assertEqual(pause,{'until':None})
        print('PEER_PAUSE_TRUTH_OBSERVED '+json.dumps({'engine':base.ENGINE,'case':'loaded_settings','serverPause':pause,
            'focusPills':self.pill(page).count(),'settingsNotes':self.note(page).all_inner_texts()}),flush=True)
        expect(self.note(page)).to_have_count(0)
    def test_02_held_settings_read_cannot_resurrect_header_resumed_pause(self):
        page,A,until=self.focused('Held Settings')
        held={}
        def handler(route):
            if route.request.method!='GET' or 'route' in held or '/settings/notifications' not in page.url:
                route.continue_();return
            response=route.fetch();self.assertEqual(response.status,200)
            held.update(route=route,response=response,pause=response.json()['pause'])
        page.route('**/api/v1/notification-preferences',handler)
        self.addCleanup(lambda:page.unroute_all(behavior='ignoreErrors'))
        try:
            self.settings(page)
            for _ in range(80):
                if 'route' in held:break
                page.wait_for_timeout(50)
            self.assertIn('route',held,'the real Settings GET must be held')
            self.assertEqual(held['pause'],{'until':until})
            self.pill(page).click();expect(self.pill(page)).to_have_count(0)
            self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences')['pause'],{'until':None})
            held['route'].fulfill(response=held['response']);held['released']=True
            expect(page.get_by_role('heading',name='Notifications',exact=True)).to_be_visible()
            pause=self.api(page,'GET','/api/v1/notification-preferences')['pause'];self.assertEqual(pause,{'until':None})
            print('PEER_PAUSE_TRUTH_OBSERVED '+json.dumps({'engine':base.ENGINE,'case':'held_settings_get','heldPause':held['pause'],
                'serverPause':pause,'focusPills':self.pill(page).count(),'settingsNotes':self.note(page).all_inner_texts()}),flush=True)
            expect(self.note(page)).to_have_count(0);expect(self.pill(page)).to_have_count(0)
        finally:
            if 'route' in held and not held.get('released'):held['route'].fulfill(response=held['response'])

    def test_03_old_settings_patch_snapshot_cannot_undo_header_resume(self):
        page,A,until=self.focused('Held Save')
        self.settings(page);expect(self.note(page)).to_be_visible()
        held={}
        def handler(route):
            if route.request.method!='PATCH' or 'route' in held:
                route.continue_();return
            self.assertEqual(route.request.post_data_json,{'level':'everything'})
            response=route.fetch();self.assertEqual(response.status,200)
            held.update(route=route,response=response,pause=response.json()['pause'])
        page.route('**/api/v1/notification-preferences',handler)
        self.addCleanup(lambda:page.unroute_all(behavior='ignoreErrors'))
        try:
            page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)')).check()
            for _ in range(80):
                if 'route' in held:break
                page.wait_for_timeout(50)
            self.assertIn('route',held,'the actual Settings save must commit before its response is held')
            self.assertEqual(held['pause'],{'until':until})
            self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences')['level'],'everything')
            self.pill(page).click();expect(self.pill(page)).to_have_count(0)
            self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences')['pause'],{'until':None})
            held['route'].fulfill(response=held['response']);held['released']=True
            page.wait_for_timeout(350)
            prefs=self.api(page,'GET','/api/v1/notification-preferences')
            print('PEER_PAUSE_TRUTH_OBSERVED '+json.dumps({'engine':base.ENGINE,'case':'held_settings_patch','heldPause':held['pause'],
                'serverPause':prefs['pause'],'serverLevel':prefs['level'],'focusPills':self.pill(page).count(),'settingsNotes':self.note(page).all_inner_texts()}),flush=True)
            self.assertEqual(prefs['pause'],{'until':None});self.assertEqual(prefs['level'],'everything','keep the actual nonpause preference save')
            expect(self.pill(page)).to_have_count(0);expect(self.note(page)).to_have_count(0)
            expect(page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)'))).to_be_checked()
        finally:
            if 'route' in held and not held.get('released'):held['route'].fulfill(response=held['response'])

    def test_04_old_header_start_response_cannot_undo_settings_resume(self):
        page,A=self.actor('Held Start')
        self.api(page,'PATCH','/api/v1/notification-preferences',{'pause':{'until':None},'quietHours':{'enabled':False}})
        page.goto(f"/projects/{A['project']}")
        expect(page.locator('header.top').get_by_role('navigation',name='Project views')).to_be_visible()
        expect(self.pill(page)).to_have_count(0)
        held={}
        def handler(route):
            if route.request.method!='PATCH' or 'route' in held:
                route.continue_();return
            body=route.request.post_data_json
            self.assertIsInstance(body.get('pause',{}).get('until'),str,'actual header Start supplies a real future pause')
            response=route.fetch();self.assertEqual(response.status,200)
            held.update(route=route,response=response,pause=response.json()['pause'])
        page.route('**/api/v1/notification-preferences',handler)
        self.addCleanup(lambda:page.unroute_all(behavior='ignoreErrors'))
        try:
            page.locator('body').press('f')
            for _ in range(80):
                if 'route' in held:break
                page.wait_for_timeout(50)
            self.assertIn('route',held,'the actual header Start must commit before its response is held')
            self.assertIsNotNone(held['pause']['until'])
            self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences')['pause'],held['pause'])
            self.settings(page);expect(self.note(page)).to_be_visible()
            with page.expect_response(lambda r:r.request.method=='PATCH' and urlsplit(r.url).path=='/api/v1/notification-preferences' and r.request.post_data_json=={'pause':{'until':None}} and r.status==200):
                page.get_by_role('button',name='Resume now',exact=True).click()
            self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences')['pause'],{'until':None})
            expect(self.note(page)).to_have_count(0)
            held['route'].fulfill(response=held['response']);held['released']=True
            page.wait_for_timeout(350)
            pause=self.api(page,'GET','/api/v1/notification-preferences')['pause']
            print('PEER_PAUSE_TRUTH_OBSERVED '+json.dumps({'engine':base.ENGINE,'case':'held_header_start','heldPause':held['pause'],
                'serverPause':pause,'focusPills':self.pill(page).count(),'settingsNotes':self.note(page).all_inner_texts()}),flush=True)
            self.assertEqual(pause,{'until':None})
            expect(self.pill(page)).to_have_count(0);expect(self.note(page)).to_have_count(0)
        finally:
            if 'route' in held and not held.get('released'):held['route'].fulfill(response=held['response'])

if __name__=='__main__':unittest.main(verbosity=2)
