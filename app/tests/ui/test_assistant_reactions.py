"""F-027 A5/A9 UI. Real owner settings, fixed pickers, durable Reply handoff; fake fixtures only.

Storage/event/authority behavior is exercised in assistant-reactions.test.ts and assistant-changes.test.ts.
Unavailable GitHub and error responses are explicit UI fixtures. Run this module with Chromium and WebKit.
"""
from __future__ import annotations

import json
import re
import unittest
import uuid

from playwright.sync_api import expect

from app_select import choose, expect_value, labels, values
import test_assistant_schedules as schedules
from test_app_shell import shot


class AssistantReactions(unittest.TestCase):
    pw = None
    state = None
    ids = {}
    setUpClass = classmethod(schedules.AssistantSchedules.setUpClass.__func__)
    tearDownClass = classmethod(schedules.AssistantSchedules.tearDownClass.__func__)
    context = schedules.AssistantSchedules.context
    page = schedules.AssistantSchedules.page
    api = schedules.AssistantSchedules.api
    json = schedules.AssistantSchedules.json
    no_horizontal_scroll = schedules.AssistantSchedules.no_horizontal_scroll
    tag = schedules.AssistantSchedules.tag
    test_01_an_owner_with_a_project_and_a_working_assistant = schedules.AssistantSchedules.test_01_an_owner_with_a_project_and_a_working_assistant

    @property
    def path(self):
        return f"/api/v1/workspaces/{self.ids['workspace']}/people/{schedules.ADA['id']}/assistant/when"

    def screen(self, page):
        page.goto('/settings/assistant')
        card = page.get_by_role('region', name='When something happens')
        expect(card).to_be_visible()
        return card

    def test_02_empty_to_on_two_taps_then_off_edit_and_error(self):
        for phone in (False, True):
            for dark in (False, True):
                with self.subTest(phone=phone, dark=dark):
                    page = self.page(phone=phone, dark=dark)
                    # Each viewport starts with the empty response, while saves/toggles use the real owner API.
                    rules = self.api(page, 'GET', self.path, status=200)['items']
                    for rule in rules:
                        self.api(page, 'PUT', f"{self.path}/{rule['id']}", {**{key: rule[key] for key in ('projectId','event','action','dailyLimit')}, 'enabled': False, 'expectedVersion':rule['version']}, status=200)
                    # A new project supplies an empty real collection without deleting another viewport's history.
                    project = self.api(page,'POST',f"/api/v1/workspaces/{self.ids['workspace']}/projects",{'name':{(False,False):'Low-light calibration',(False,True):'Connector bench test',(True,False):'Sensor verification',(True,True):'Assembly check'}[(phone,dark)],'visibility':'workspace'},status=201)
                    rows = []
                    def collection(route):
                        if route.request.method == 'GET':
                            self.json(route, {'items': rows})
                        else:
                            route.continue_()
                    page.route(f'**{self.path}', collection)
                    card = self.screen(page)
                    card.get_by_role('button', name='Tell me when a task is blocked').click()
                    dialog = page.get_by_role('dialog', name='When something happens')
                    expect_value(dialog.get_by_label('When', exact=True), 'blocked')
                    expect_value(dialog.get_by_label('Then', exact=True), 'tell')
                    choose(dialog.get_by_label('Project', exact=True), project['id'])
                    # PR cannot appear on an unlinked project.
                    self.assertEqual(len(values(dialog.get_by_label('When',exact=True))), 4)
                    dialog.get_by_role('button',name='Turn on',exact=True).click()
                    expect(dialog).not_to_be_visible()
                    saved=self.api(page,'GET',self.path,status=200)['items']
                    rule=next(item for item in saved if item['projectId']==project['id'])
                    rows.append(rule)
                    page.reload()
                    card=page.get_by_role('region',name='When something happens')
                    toggle=card.get_by_role('switch',name='When one of my tasks is blocked')
                    expect(toggle).to_be_checked()
                    with page.expect_response(lambda response: response.request.method == 'PUT' and response.url.endswith(rule['id'])) as toggled:
                        toggle.click()
                    self.assertEqual(toggled.value.status,200)
                    rows[0]=next(item for item in self.api(page,'GET',self.path,status=200)['items'] if item['id']==rule['id'])
                    page.reload()
                    expect(card.get_by_role('switch')).not_to_be_checked()
                    card.get_by_role('button',name=re.compile('When one of my tasks is blocked')).click()
                    dialog=page.get_by_role('dialog',name='When something happens')
                    choose(dialog.get_by_label('Then',exact=True), 'next_steps')
                    shot(page,f"assistant-when-{self.tag(phone,dark)}")
                    visible=dialog.inner_text()
                    self.assertIsNone(schedules.FORBIDDEN.search(visible),visible)
                    self.no_horizontal_scroll(page)
                    page.route(f"**{self.path}/{rule['id']}",lambda route:self.json(route,{'code':'UNAVAILABLE','error':'Could not save. Try again.'},503))
                    dialog.get_by_role('button',name='Turn on',exact=True).click()
                    expect(dialog.get_by_role('alert')).to_be_visible()
                    expect_value(dialog.get_by_label('Then',exact=True), 'next_steps')
                    dialog.get_by_role('button',name='Cancel',exact=True).click()
                    page.close()

    def test_03_pr_picker_only_in_a_linked_project(self):
        page=self.page()
        page.route(f"**/api/v1/projects/{self.ids['project']}/github/bindings",lambda route:self.json(route,[{'id':str(uuid.uuid4()),'state':'active'}]))
        card=self.screen(page)
        card.get_by_role('button',name='Add',exact=True).click()
        dialog=page.get_by_role('dialog',name='When something happens')
        choose(dialog.get_by_label('Project',exact=True), self.ids['project'])
        self.assertEqual(len(values(dialog.get_by_label('When',exact=True))), 5)
        choose(dialog.get_by_label('When',exact=True), 'pr_ready')
        self.assertEqual([text.strip() for text in labels(dialog.get_by_label('Then',exact=True))], ['tell me','check it against the task'])
        dialog.get_by_role('button',name='Cancel',exact=True).click()

    def test_04_reply_is_prefilled_private_and_only_send_posts(self):
        for phone in (False,True):
            page=self.page(phone=phone)
            notification=str(uuid.uuid4())
            messages=self.api(page,'GET',f"/api/v1/conversations/{self.ids['conversation']}?limit=100",status=200)
            # An owner-bound draft comes from the dedicated owner-only endpoint. Native Reply and Send remain real.
            url=f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}"
            body='I checked the sensor connector. Let us repeat the low-light test.'
            page.route(f'**/api/v1/inbox/{notification}',lambda route:self.json(route,{'id':notification,'title':'Jonas mentioned you','body':'Please check the connector','reason':'mention','url':url,'source':{'type':'project','id':self.ids['project'],'workspaceId':self.ids['workspace']},'assistantRequestIdentity':None}))
            page.route(f'**/api/v1/inbox/{notification}/assistant-draft',lambda route:self.json(route,{'ownerUserId':schedules.ADA['id'],'body':body,'projectId':self.ids['project'],'conversationId':self.ids['conversation'],'url':url}))
            page.goto(f'/inbox/{notification}')
            reply=page.get_by_role('textbox',name='Reply',exact=True)
            expect(reply).to_have_value(body)
            expect(page.get_by_text('Drafted by your assistant',exact=True)).to_be_visible()
            current=self.api(page,'GET',f"/api/v1/conversations/{self.ids['conversation']}?limit=100",status=200)
            self.assertEqual(len(current['messages']),len(messages['messages']))
            shot(page,f"assistant-reply-{self.tag(phone)}")
            with page.expect_response(lambda response: response.request.method == 'POST' and response.url.endswith(f"/conversations/{self.ids['conversation']}/messages")) as delivered:
                page.get_by_role('button',name='Send reply',exact=True).click()
            self.assertEqual(delivered.value.status,201)
            expect(reply).to_have_value('')
            posted=self.api(page,'GET',f"/api/v1/conversations/{self.ids['conversation']}?limit=100",status=200)
            self.assertEqual(len(posted['messages']),len(messages['messages'])+1)
            self.assertEqual(posted['messages'][-1]['body'],body)
            page.close()

    def test_05_typed_suggestion_review_accept_dismiss_and_authority_error(self):
        for phone in (False,True):
            page=self.page(phone=phone)
            change=str(uuid.uuid4())
            run=str(uuid.uuid4())
            waiting={'on':True}
            accepted=[]
            item={'key':f'assistant:suggestion:{change}','kind':'question','title':"Jonas's assistant suggests: edit page Suppliers",'detail':"Drafted by Jonas's assistant",'project':{'id':self.ids['project'],'name':'Gesture lamp'},'from':None,'at':'2026-10-18T15:00:00Z','url':f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}",'decision':None,'blocked':None,'reason':'question','snoozeTask':None,'assistantChanges':{'runId':run,'suggestion':True,'verb':'Accept','summary':'edit page','changes':[{'id':change,'version':2,'phrase':'edit page','objectTitle':'Suppliers','line':'Sent to Ada','preview':'Page: Use the manufacturer’s current connector pinout.'}]}}
            page.route('**/api/v1/needs-you',lambda route:self.json(route,{'items':[item] if waiting['on'] else [],'count':1 if waiting['on'] else 0,'later':0,'doneToday':0}))
            def decide(route):
                accepted.append(route.request.post_data_json)
                if route.request.url.endswith('/accept'):
                    self.json(route,{'code':'FORBIDDEN','error':'Only someone who can decide this can accept it.'},403)
                else:
                    waiting['on']=False
                    self.json(route,{'change':{'id':change,'state':'not_now'},'message':None})
            page.route(f'**/api/v1/assistant-changes/{change}/*',decide)
            page.goto('/inbox')
            card=page.locator('li.nyc').filter(has_text="Jonas's assistant suggests")
            expect(card).to_be_visible()
            card.get_by_role('button',name='Review',exact=True).click()
            expect(card).to_contain_text('Use the manufacturer’s current connector pinout.')
            shot(page,f"assistant-suggestion-{self.tag(phone)}")
            self.assertEqual(accepted,[],'review never accepts or starts compute')
            card.get_by_role('button',name='Accept',exact=True).click()
            expect(page.get_by_text('Only someone who can decide this can accept it.',exact=True)).to_be_visible()
            expect(card).to_be_visible()
            self.assertEqual(accepted,[{'expectedVersion':2}])
            card.get_by_role('button',name='Dismiss',exact=True).click()
            expect(card).not_to_be_visible()
            self.no_horizontal_scroll(page)
            page.close()
