"""Real same-tab account lifetime and same-owner queue controls for header composition.

These identity/ring probes block service workers only to isolate the account boundary.
The original project/header and dedicated PWA lanes retain enabled service workers.
"""
from __future__ import annotations
import json
import os
import re
import time
import unittest
from datetime import datetime, timezone
from uuid import uuid4
from urllib.parse import urlsplit
from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, open_details, start_forwarder

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
        page.evaluate("""epoch => {
          window.__peer372={epoch,phase:'A',events:[]};
          window.addEventListener('flux:pause-changed',e=>window.__peer372.events.push({phase:window.__peer372.phase,detail:e.detail}));
        }""", epoch)
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
                held.update(route=route,response=response,body=body,serverPause=response.json()['pause'])
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
        expect(page.locator('header.top').get_by_role('button',name=re.compile(r'^Focus · notifications paused until'))).to_have_count(0)

    def test_01_account_switch_rejects_old_response_broadcast_and_queued_save(self):
        page,A = self.actor('Boundary A')
        other,B = self.actor('Boundary B')
        baselineB = self.api(other,'PATCH','/api/v1/notification-preferences',{'level':'needsYou','pause':{'until':None},'quietHours':{'enabled':False}})
        until=datetime.fromtimestamp(time.time()+3600,tz=timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        self.api(page,'PATCH','/api/v1/notification-preferences',{'pause':{'until':until},'quietHours':{'enabled':False}})
        self.settings(page,A)
        epoch=self.instrument(page)
        held,requests=self.hold_patch(page)
        try:
            page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)')).check()
            self.wait_held(page,held)
            self.assertEqual(held['body'],{'level':'everything'})
            self.assertEqual(held['serverPause']['until'],until)
            page.get_by_role('radio',name='Nothing',exact=True).check()
            expect(page.get_by_role('radio',name='Nothing',exact=True)).to_be_checked()
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
            events=page.evaluate('window.__peer372.events')
            postRequests=[r for r in requests if r['phase']=='B']
            visible=page.locator('header.top').get_by_role('button',name=re.compile(r'^Focus · notifications paused until')).count()
            observed={'engine':ENGINE,'sameDocument':True,'stillB':afterMe==B['id'],'beforeLevel':before['level'],
                'afterLevel':after['level'],'beforePause':before['pause'],'afterPause':after['pause'],
                'oldQueueRequestsAfterB':postRequests,'pauseEventsAfterB':[e for e in events if e['phase']=='B'],'focusPills':visible}
            print('PEER_IDENTITY_OBSERVED '+json.dumps(observed),flush=True)
            self.assertEqual(afterMe,B['id'],'the held response must not change the signed-in identity')
            self.assertEqual(postRequests,[],'old A queued command must never dispatch using B cookies')
            self.assertEqual([e for e in events if e['phase']=='B'],[],'old A completion must not broadcast into B session')
            self.assertEqual(after,baselineB,'B preferences must stay exactly unchanged')
            self.assertEqual(visible,0,'A pause cannot be shown as B focus')
            self.settings(page,B)
            expect(page.locator('.nset__saved')).to_be_empty()
            expect(page.locator('.nset__read-feedback')).to_have_count(0)
            expect(page.locator('.nset > .nset__problem, .nset__mute-read').filter(has_text='Current notification')).to_have_count(0)
            self.assertEqual(self.api(page,'GET','/api/v1/notification-preferences'),baselineB,'retired A feedback cannot affect current B settings')
        finally:
            if 'route' in held and not held.get('released'):
                held['route'].fulfill(response=held['response'])

    def test_02_same_owner_navigation_keeps_queued_save_and_confirmed_pause(self):
        page,A=self.actor('Same owner')
        until=datetime.fromtimestamp(time.time()+3600,tz=timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        self.api(page,'PATCH','/api/v1/notification-preferences',{'pause':{'until':until},'quietHours':{'enabled':False},'level':'needsYou'})
        self.settings(page,A)
        epoch=self.instrument(page);held,requests=self.hold_patch(page)
        try:
            page.get_by_role('button',name='Resume now',exact=True).click()
            self.wait_held(page,held)
            self.assertEqual(held['body'],{'pause':{'until':None}})
            self.assertEqual(held['serverPause'],{'until':None})
            page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)')).check()
            expect(page.get_by_role('radio',name=re.compile(r'^Everything(?:\s|$)'))).to_be_checked()
            page.wait_for_timeout(100);self.assertEqual(len(requests),1)
            page.get_by_role('link',name=A['projectName'],exact=True).click()
            expect(page.locator('header.top').get_by_role('heading',level=1,name=A['projectName'],exact=True)).to_be_visible()
            self.assertEqual(page.evaluate('window.__peer372?.epoch'),epoch)
            held['route'].fulfill(response=held['response']);held['released']=True
            page.wait_for_timeout(1500)
            preferences=self.api(page,'GET','/api/v1/notification-preferences')
            print('PEER_SAME_OWNER_OBSERVED '+json.dumps({'engine':ENGINE,'requests':requests,'level':preferences['level'],'pause':preferences['pause']}),flush=True)
            self.assertEqual(self.api(page,'GET','/api/v1/me')['user']['id'],A['id'])
            self.assertEqual(preferences['level'],'everything','ordinary navigation keeps already queued same-session saves')
            self.assertEqual(preferences['pause'],{'until':None})
            expect(page.locator('header.top').get_by_role('button',name=re.compile(r'^Focus · notifications paused until'))).to_have_count(0)
        finally:
            if 'route' in held and not held.get('released'):
                held['route'].fulfill(response=held['response'])

    def test_03_actual_history_keyboard_ring_settles_within_bounded_transition(self):
        page,A=self.actor('Ring')
        root=f"/api/v1/projects/{A['project']}"
        self.api(page,'POST',root+'/work',{'title':'Peer retained completed work','status':'done'},201)
        self.api(page,'POST',root+'/work',{'title':'Peer retained unpursued work','status':'not_pursued'},201)
        summary=self.api(page,'GET',root+'/work-summary')
        target=summary['state']['history']['firstWork']
        self.assertIsNotNone(target,'actual canonical history target exists')
        self.assertEqual(summary['state']['history']['completed'],1)
        self.assertEqual(summary['state']['history']['notPursued'],1)
        page.goto(f"/projects/{A['project']}");open_details(page)
        row=page.locator('#details').get_by_role('button',name=re.compile(r'^Earlier work'))
        expect(row).to_contain_text(target['title']);expect(row).to_contain_text('1 completed task · 1 not pursued')
        row.hover();row.press('Tab');page.keyboard.press('Shift+Tab')
        started=time.monotonic();samples=[]
        while True:
            sample=row.evaluate("""e=>{const s=getComputedStyle(e);return {visible:e.matches(':focus-visible'),style:s.outlineStyle,width:parseFloat(s.outlineWidth),color:s.outlineColor,property:s.transitionProperty,duration:s.transitionDuration}}""")
            sample['elapsedMs']=round((time.monotonic()-started)*1000,1);samples.append(sample)
            self.assertTrue(sample['visible'],'keyboard focus must remain on the history row during settling')
            durations=[float(v.strip()[:-2]) if v.strip().endswith('ms') else float(v.strip()[:-1])*1000 for v in sample['duration'].split(',')]
            settled_ms=max(200,max(durations,default=0)+50)
            if sample['elapsedMs']>=settled_ms and sample['style'] not in ('none','hidden') and sample['width']>0 and sample['color'] not in ('transparent','rgba(0, 0, 0, 0)'):
                break
            if time.monotonic()-started>=0.6:break
            page.wait_for_timeout(25)
        print('PEER_FOCUS_RING_OBSERVED '+json.dumps({'engine':ENGINE,'target':target,'samples':samples}),flush=True)
        final=samples[-1]
        self.assertNotIn(final['style'],('none','hidden'));self.assertGreater(final['width'],0)
        self.assertNotIn(final['color'],('transparent','rgba(0, 0, 0, 0)'),'visible computed outline within600ms; guard retained')
        with page.expect_response(lambda r:r.request.method=='GET' and urlsplit(r.url).path==f"/api/v1/projects/{A['project']}/work-objects/work/{target['id']}" and r.status==200) as opened:
            row.click()
        self.assertEqual(opened.value.json()['object']['kind'],'work')
        self.assertEqual(opened.value.json()['object']['id'],target['id'],'the row opened the actual canonical native ID')
        expect(page.locator('#details').get_by_role('heading',name=target['title'],exact=True)).to_be_visible()

if __name__=='__main__':
    unittest.main(verbosity=2)
