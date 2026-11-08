"""Real same-tab account lifetime and same-owner queue controls for header composition.

A notification save queued by one account is never sent as the next account to sign in to the same tab (#872).

These identity probes block service workers only to isolate the account boundary.
The original project/header and dedicated PWA lanes retain enabled service workers.

The history-row focus ring probe and test_project_aggregate went in #1002: both read the Details "Now" rows (blocked, open, in progress,
Earlier work) that #972 removed with the old Home paths; nothing shows those counts any more.
"""
from __future__ import annotations
import json
import os
import re
import unittest
from uuid import uuid4
from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

ENGINE = os.environ.get('FLUX_UI_BROWSER', 'chromium')
if ENGINE not in ('chromium', 'webkit'):
    raise ValueError(f'unsupported requested engine {ENGINE!r}')
PASSWORD = 'one careful peer check'

class CompositionProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, ENGINE).launch()
        assert cls.browser.browser_type.name == ENGINE
        print(f'ACTUAL_UI_ENGINE={cls.browser.browser_type.name}', flush=True)
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def api(self, page, method, path, body=None, status=200):
        headers = {'origin': ORIGIN, 'content-type': 'application/json'}
        if method in ('POST', 'PATCH'):
            headers['idempotency-key'] = str(uuid4())
        response = page.request.fetch(ORIGIN + path, method=method, headers=headers,
            data=None if body is None else json.dumps(body))
        self.assertEqual(response.status, status, f'{method} {path}: {response.status}: {response.text()}')
        return response.json() if response.text() else None

    def actor(self, label, *, phone=False, theme="light"):
        context = self.browser.new_context(base_url=ORIGIN, viewport={'width':390,'height':844} if phone else {'width':1440,'height':900},
            device_scale_factor=3 if phone else 1, is_mobile=phone, has_touch=phone, color_scheme=theme,
            service_workers='block', locale='en-GB', timezone_id='Europe/Warsaw')
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        def errors_guard():
            print('PEER_PAGEERRORS ' + json.dumps({'engine':ENGINE,'actor':label,'errors':errors}), flush=True)
            self.assertEqual(errors, [], 'no uncaught browser errors')
        self.addCleanup(errors_guard)
        slug=re.sub(r'[^a-z0-9]+','-',label.lower()).strip('-')
        email = f'peer372.{slug}.{uuid4().hex}@example.test'
        name = f'Peer {label}'
        page.goto('/sign-up')
        page.get_by_label('Name', exact=True).fill(name)
        page.get_by_label('Email', exact=True).fill(email)
        page.get_by_label('Password', exact=True).fill(PASSWORD)
        page.get_by_role('button', name='Create account', exact=True).click()
        expect(page.get_by_role('heading', level=1, name='Home', exact=True)).to_be_visible()
        me = self.api(page,'GET','/api/v1/me')['user']['id']
        ws = self.api(page,'POST','/api/v1/workspaces',{'name':f'Peer {label} workspace'},201)
        project = self.api(page,'POST',f"/api/v1/workspaces/{ws['id']}/projects",
            {'name':f'Peer {label} project','visibility':'restricted'},201)
        return page, {'id':me,'name':name,'email':email,'project':project['id'],'projectName':project['name']}

    def settings(self, page, actor):
        page.goto(f"/projects/{actor['project']}")
        page.get_by_role('link',name='Settings',exact=True).click()
        page.locator('a[href="/settings/notifications"]').first.click()
        expect(page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)'))).to_be_visible()

    def instrument(self, page):
        epoch = uuid4().hex
        page.evaluate("epoch => { window.__peer372 = { epoch, phase: 'A' }; }", epoch)
        return epoch

    def hold_patch(self, page):
        held, requests = {}, []
        def handler(route):
            if route.request.method != 'PATCH':
                route.continue_(); return
            body = route.request.post_data_json
            requests.append({'phase':'B' if held.get('B') else 'A','body':body})
            if 'route' not in held:
                response = route.fetch()
                self.assertEqual(response.status,200,'the first A request really committed before the response was held')
                held.update(route=route,response=response,body=body)
            else:
                route.continue_()
        page.route('**/api/v1/notification-preferences',handler)
        self.addCleanup(lambda:page.unroute_all(behavior='ignoreErrors'))
        return held,requests

    def wait_held(self,page,held):
        for _ in range(80):
            if 'route' in held:return
            page.wait_for_timeout(50)
        self.fail('the first real A PATCH was not captured')

    def signin_swap(self,page,B,epoch):
        page.get_by_role('button',name=re.compile(r'account and sign out$')).click()
        page.get_by_role('button',name='Sign out',exact=True).click()
        expect(page.get_by_role('heading',name='Sign in',exact=True)).to_be_visible()
        page.get_by_label('Email',exact=True).fill(B['email'])
        page.get_by_label('Password',exact=True).fill(PASSWORD)
        page.get_by_role('button',name='Sign in',exact=True).click()
        expect(page.get_by_role('heading',level=1,name='Home',exact=True)).to_be_visible()
        self.assertEqual(page.evaluate('window.__peer372?.epoch'),epoch,'real sign-out/sign-in stays in the same document')
        self.assertEqual(self.api(page,'GET','/api/v1/me')['user']['id'],B['id'])
        page.get_by_role('link',name=B['projectName'],exact=True).click()
        expect(page.locator('header.top').get_by_role('heading',level=1,name=B['projectName'],exact=True)).to_be_visible()

    def test_01_account_switch_rejects_old_response_and_queued_save(self):
        page,A = self.actor('Boundary A')
        other,B = self.actor('Boundary B')
        baselineB = self.api(other,'PATCH','/api/v1/notification-preferences',{'level':'needsYou','quietHours':{'enabled':False}})
        self.api(page,'PATCH','/api/v1/notification-preferences',{'quietHours':{'enabled':False}})
        self.settings(page,A)
        epoch=self.instrument(page)
        held,requests=self.hold_patch(page)
        try:
            page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)')).check()
            self.wait_held(page,held)
            self.assertEqual(held['body'],{'level':'everything'})
            page.get_by_role('radio',name=re.compile(r'^Nothing(?:\s|$)')).check()
            expect(page.get_by_role('radio',name=re.compile(r'^Nothing(?:\s|$)'))).to_be_checked()
            page.wait_for_timeout(100)
            self.assertEqual(len(requests),1,'second A save is really queued behind the held response')
            self.signin_swap(page,B,epoch)
            before=self.api(page,'GET','/api/v1/notification-preferences')
            self.assertEqual(before,baselineB,'B baseline before releasing A is unchanged')
            held['B']=True
            page.evaluate("window.__peer372.phase='B'")
            held['route'].fulfill(response=held['response']);held['released']=True
            page.wait_for_timeout(1500)
            self.assertEqual(page.evaluate('window.__peer372?.epoch'),epoch)
            afterMe=self.api(page,'GET','/api/v1/me')['user']['id']
            after=self.api(page,'GET','/api/v1/notification-preferences')
            postRequests=[r for r in requests if r['phase']=='B']
            print('PEER_IDENTITY_OBSERVED '+json.dumps({'engine':ENGINE,'sameDocument':True,'stillB':afterMe==B['id'],'beforeLevel':before['level'],
                'afterLevel':after['level'],'oldQueueRequestsAfterB':postRequests}),flush=True)
            self.assertEqual(afterMe,B['id'],'the held response must not change the signed-in identity')
            self.assertEqual(postRequests,[],'old A queued command must never dispatch using B cookies')
            self.assertEqual(after,baselineB,'B preferences must stay exactly unchanged')
            self.settings(page,B)
            expect(page.locator('.nset__saved')).to_be_empty()
            expect(page.locator('.nset > .nset__problem').filter(has_text='Current notification')).to_have_count(0)
            self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences'),baselineB,'retired A feedback cannot affect current B settings')
        finally:
            if 'route' in held and not held.get('released'):
                held['route'].fulfill(response=held['response'])

    def test_02_same_owner_navigation_keeps_queued_save(self):
        page,A=self.actor('Same owner')
        self.api(page,'PATCH','/api/v1/notification-preferences',{'quietHours':{'enabled':False},'level':'needsYou'})
        self.settings(page,A)
        epoch=self.instrument(page);held,requests=self.hold_patch(page)
        try:
            page.get_by_role('radio',name=re.compile(r'^Nothing(?:\s|$)')).check()
            self.wait_held(page,held)
            self.assertEqual(held['body'],{'level':'nothing'})
            page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)')).check()
            expect(page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)'))).to_be_checked()
            page.wait_for_timeout(100);self.assertEqual(len(requests),1)
            page.get_by_role('link',name=A['projectName'],exact=True).click()
            expect(page.locator('header.top').get_by_role('heading',level=1,name=A['projectName'],exact=True)).to_be_visible()
            self.assertEqual(page.evaluate('window.__peer372?.epoch'),epoch)
            held['route'].fulfill(response=held['response']);held['released']=True
            page.wait_for_timeout(1500)
            preferences=self.api(page,'GET','/api/v1/notification-preferences')
            print('PEER_SAME_OWNER_OBSERVED '+json.dumps({'engine':ENGINE,'requests':requests,'level':preferences['level']}),flush=True)
            self.assertEqual(self.api(page,'GET','/api/v1/me')['user']['id'],A['id'])
            self.assertEqual(preferences['level'],'everything','ordinary navigation keeps already queued same-session saves')
        finally:
            if 'route' in held and not held.get('released'):
                held['route'].fulfill(response=held['response'])

if __name__=='__main__':
    unittest.main(verbosity=2)
