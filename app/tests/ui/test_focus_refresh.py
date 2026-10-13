"""External current-state read/expiry and acknowledged-save refresh-error controls."""
from __future__ import annotations
import json
import re
import time
import unittest
from datetime import datetime, timezone
import test_focus_pause_sync as helper
from playwright.sync_api import expect
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

class PauseRefreshProbe(unittest.TestCase):
    api=helper.PauseTruthProbe.api
    actor=helper.PauseTruthProbe.actor
    focused=helper.PauseTruthProbe.focused
    pill=helper.PauseTruthProbe.pill
    note=helper.PauseTruthProbe.note
    settings=helper.PauseTruthProbe.settings
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:start_forwarder(ORIGIN,UPSTREAM)
        cls.pw=helper.base.sync_playwright().start();cls.browser=getattr(cls.pw,helper.base.ENGINE).launch()
        assert cls.browser.browser_type.name==helper.base.ENGINE
        print(f'ACTUAL_UI_ENGINE={cls.browser.browser_type.name}',flush=True)
        expect.set_options(timeout=8000)
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()
    def test_01_other_context_resume_then_real_focus_read_updates_settings(self):
        page,A,until=self.focused('Fresh Read')
        self.settings(page);expect(self.note(page)).to_be_visible()
        other=self.browser.new_context(base_url=ORIGIN,storage_state=page.context.storage_state(),service_workers='block')
        self.addCleanup(other.close)
        self.assertEqual(self.api(other,'GET','/api/v1/me')['user']['id'],A['id'])
        self.api(other,'PATCH','/api/v1/notification-preferences',{'pause':{'until':None}})
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(self.pill(page)).to_have_count(0)
        pause=self.api(page,'GET','/api/v1/notification-preferences')['pause'];self.assertEqual(pause,{'until':None})
        print('PEER_PAUSE_REFRESH_OBSERVED '+json.dumps({'engine':helper.base.ENGINE,'case':'other_context_focus_read','serverPause':pause,'focusPills':self.pill(page).count(),'settingsNotes':self.note(page).all_inner_texts()}),flush=True)
        expect(self.note(page)).to_have_count(0)
    def test_02_actual_timed_expiry_clears_loaded_settings(self):
        page,A=self.actor('Expiry')
        until=datetime.fromtimestamp(time.time()+8,tz=timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        self.api(page,'PATCH','/api/v1/notification-preferences',{'pause':{'until':until},'quietHours':{'enabled':False}})
        page.goto(f"/projects/{A['project']}");expect(self.pill(page)).to_be_visible()
        self.settings(page);expect(self.note(page)).to_be_visible()
        self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences')['pause'],{'until':until},'the real future pause must be loaded before it expires')
        expect(self.pill(page)).to_have_count(0,timeout=15000)
        pause=self.api(page,'GET','/api/v1/notification-preferences')['pause'];self.assertEqual(pause,{'until':None})
        print('PEER_PAUSE_REFRESH_OBSERVED '+json.dumps({'engine':helper.base.ENGINE,'case':'real_expiry','until':until,'serverPause':pause,'settingsNotes':self.note(page).all_inner_texts()}),flush=True)
        expect(self.note(page)).to_have_count(0)
    def test_03_acknowledged_nonpause_save_is_not_called_failed_when_refresh_fails(self):
        page,A,until=self.focused('Ack Refresh')
        self.settings(page);expect(self.note(page)).to_be_visible()
        held={};failed=[]
        def handler(route):
            if route.request.method=='GET' and held.get('failGet'):
                failed.append(route.request.url)
                route.fulfill(status=500,content_type='application/json',body=json.dumps({'code':'PEER_REFRESH_UNAVAILABLE','error':'peer follow-up refresh unavailable'}));return
            if route.request.method=='PATCH' and 'route' not in held:
                self.assertEqual(route.request.post_data_json,{'level':'everything'})
                response=route.fetch();self.assertEqual(response.status,200,'actual mutation succeeded before injecting only GET errors')
                held.update(route=route,response=response,pause=response.json()['pause']);return
            route.continue_()
        page.route('**/api/v1/notification-preferences',handler)
        self.addCleanup(lambda:page.unroute_all(behavior='ignoreErrors'))
        try:
            page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)')).check()
            for _ in range(80):
                if 'route' in held:break
                page.wait_for_timeout(50)
            self.assertIn('route',held);self.assertEqual(held['pause'],{'until':until})
            self.pill(page).click();expect(self.pill(page)).to_have_count(0)
            self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences')['pause'],{'until':None})
            held['failGet']=True
            held['route'].fulfill(response=held['response']);held['released']=True
            page.wait_for_timeout(750)
            preferences=self.api(page,'GET','/api/v1/notification-preferences')
            self.assertEqual(preferences['level'],'everything');self.assertEqual(preferences['pause'],{'until':None})
            self.assertGreater(len(failed),0,'the actual follow-up client GET must have failed')
            errors=page.get_by_text('Could not save. Try again.',exact=True).all_inner_texts()
            print('PEER_PAUSE_REFRESH_OBSERVED '+json.dumps({'engine':helper.base.ENGINE,'case':'acknowledged_save_refresh_error','actualMutationStatus':200,'serverLevel':preferences['level'],'serverPause':preferences['pause'],'failedClientReads':len(failed),'mutationFailureMessages':errors}),flush=True)
            expect(page.get_by_text('Could not save. Try again.',exact=True)).to_have_count(0)
        finally:
            if 'route' in held and not held.get('released'):held['route'].fulfill(response=held['response'])

if __name__=='__main__':unittest.main(verbosity=2)
