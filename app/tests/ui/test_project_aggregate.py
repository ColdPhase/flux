"""Project aggregate counts remain visible when their canonical target is linked here."""
from __future__ import annotations
import json
import re
import unittest
from urllib.parse import urlsplit
from uuid import uuid4
import test_focus_lifecycle as base
from playwright.sync_api import expect
from test_app_shell import ORIGIN, UPSTREAM, open_details, start_forwarder

class AggregateProbe(unittest.TestCase):
    api=base.CompositionProbe.api
    actor=base.CompositionProbe.actor
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:start_forwarder(ORIGIN,UPSTREAM)
        cls.pw=base.sync_playwright().start()
        cls.browser=getattr(cls.pw,base.ENGINE).launch()
        assert cls.browser.browser_type.name==base.ENGINE
        print(f'ACTUAL_UI_ENGINE={cls.browser.browser_type.name}',flush=True)
        expect.set_options(timeout=8000)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def test_01_linked_canonical_target_keeps_each_project_aggregate(self):
        page,A=self.actor('Aggregate')
        cases=[('blocked',['blocked','blocked'],'blocked','first','2 blocked'),
               ('open',['open','open'],'open','first','2 open tasks'),
               ('active',['in_progress','in_progress'],'active','first','2 tasks in progress'),
               ('history',['done','not_pursued'],'history','firstWork','1 completed task · 1 not pursued')]
        for label,statuses,family,target_key,expected in cases:
            with self.subTest(family=label):
                workspace=self.api(page,'POST','/api/v1/workspaces',{'name':f'Peer {label} counts'},201)
                project=self.api(page,'POST',f"/api/v1/workspaces/{workspace['id']}/projects",{'name':f'Peer {label} project','visibility':'restricted'},201)
                root=f"/api/v1/projects/{project['id']}"
                thread=self.api(page,'POST',root+'/conversations',{'body':f'Original conversation for {label} count','clientMessageId':str(uuid4())},201)
                message=thread['messages'][0]
                tasks=[]
                for index,status in enumerate(statuses):
                    body={'title':f'Peer {label} native task {index+1}','status':status,'owner':{'kind':'human','id':A['id']}}
                    if status=='blocked':body['blocker']='Waiting for the field measurements'
                    tasks.append(self.api(page,'POST',root+'/work',body,201))
                summary=self.api(page,'GET',root+'/work-summary')
                target=summary['state'][family][target_key]
                self.assertIsNotNone(target,'read the actual canonical native target rather than infer insertion order')
                if family=='history':
                    self.assertEqual(summary['state'][family]['completed'],1)
                    self.assertEqual(summary['state'][family]['notPursued'],1)
                else:self.assertEqual(summary['state'][family]['count'],2)
                native_ids={t['id'] for t in tasks};self.assertIn(target['id'],native_ids)
                edge=self.api(page,'POST',root+'/links',{'from':{'type':'work','id':target['id']},'to':{'type':'message','id':message['id']}},201)
                self.assertEqual(edge['role'],'related','the public create-link API creates a real related association')
                self.assertEqual(edge['from'],{'type':'work','id':target['id']})
                self.assertEqual(edge['to'],{'type':'message','id':message['id']})
                checked=self.api(page,'GET',root+'/work-summary')
                self.assertEqual(checked['state'][family][target_key]['id'],target['id'],'the associated target stays canonical')
                association=self.api(page,'GET',root+f"/work-associations?conversationId={thread['id']}&relation=any&limit=50")
                associated={(item['kind'],item['id']) for item in association['items']}
                self.assertIn(('work',target['id']),associated)
                other=native_ids-{target['id']};self.assertEqual(len(other),1)
                self.assertTrue(all(('work',item) not in associated for item in other),'the second counted native task really lies outside this conversation')
                before=self.api(page,'GET',f"/api/v1/work/{target['id']}")
                page.goto(f"/projects/{project['id']}/conversations/{thread['id']}")
                expect(page.get_by_label('Reply',exact=True)).to_be_visible();open_details(page)
                panel=page.locator('#details');overview=panel.locator('.ov')
                expect(overview).to_have_attribute('data-overview-phase','ready')
                expect(overview).to_have_attribute('data-overview-relations-phase','ready')
                linked=overview.locator(f'[data-work-kind="work"][data-work-id="{target["id"]}"]')
                expect(linked).to_have_count(1);expect(linked).to_contain_text(target['title'])
                text=panel.inner_text()
                print('PEER_AGGREGATE_OBSERVED '+json.dumps({'engine':base.ENGINE,'family':label,'summary':checked['state'][family],
                    'associatedNativeIds':sorted(associated),'expectedText':expected,'visibleText':text,'linkedTarget':target['id']}),flush=True)
                # Gather the native navigation observation even if the count is absent, then assert all semantics.
                with page.expect_response(lambda r:r.request.method=='GET' and urlsplit(r.url).path==f"/api/v1/projects/{project['id']}/work-objects/work/{target['id']}" and r.status==200) as opened:
                    linked.click()
                self.assertEqual(opened.value.json()['object']['kind'],'work')
                self.assertEqual(opened.value.json()['object']['id'],target['id'],'the actual linked-context button opens the canonical native target')
                expect(panel.get_by_role('heading',name=target['title'],exact=True)).to_be_visible()
                self.assertEqual(self.api(page,'GET',f"/api/v1/work/{target['id']}"),before,'Details reads preserve the native object and source links')
                self.assertIn(expected,text,'project-wide aggregate stays visible independently of linked-target deduplication')

if __name__=='__main__':unittest.main(verbosity=2)
