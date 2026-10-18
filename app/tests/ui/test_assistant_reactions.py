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
                    project = self.api(page,'POST',f"/api/v1/workspaces/{self.ids['workspace']}/projects",{'name':f"Low light {phone} {dark}",'visibility':'workspace'},status=201)
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
                    expect(dialog.get_by_label('When', exact=True)).to_have_value('blocked')
                    expect(dialog.get_by_label('Then', exact=True)).to_have_value('tell')
                    dialog.get_by_label('Project', exact=True).select_option(project['id'])
                    # PR cannot appear on an unlinked project.
                    expect(dialog.get_by_label('When',exact=True).locator('option')).to_have_count(4)
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
                    toggled.value.finished()
                    rows[0]=next(item for item in self.api(page,'GET',self.path,status=200)['items'] if item['id']==rule['id'])
                    page.reload()
                    expect(card.get_by_role('switch')).not_to_be_checked()
                    card.get_by_role('button',name=re.compile('When one of my tasks is blocked')).click()
                    dialog=page.get_by_role('dialog',name='When something happens')
                    dialog.get_by_label('Then',exact=True).select_option('next_steps')
                    shot(page,f"assistant-when-{self.tag(phone,dark)}")
                    visible=dialog.inner_text()
                    self.assertIsNone(schedules.FORBIDDEN.search(visible),visible)
                    self.no_horizontal_scroll(page)
                    page.route(f"**{self.path}/{rule['id']}",lambda route:self.json(route,{'code':'UNAVAILABLE','error':'Could not save. Try again.'},503))
                    dialog.get_by_role('button',name='Turn on',exact=True).click()
                    expect(dialog.get_by_role('alert')).to_be_visible()
                    expect(dialog.get_by_label('Then',exact=True)).to_have_value('next_steps')
                    dialog.get_by_role('button',name='Cancel',exact=True).click()
                    page.close()

    def test_03_pr_picker_only_in_a_linked_project(self):
        page=self.page()
        page.route(f"**/api/v1/projects/{self.ids['project']}/github/bindings",lambda route:self.json(route,[{'id':str(uuid.uuid4()),'state':'active'}]))
        card=self.screen(page)
        card.get_by_role('button',name='Add',exact=True).click()
        dialog=page.get_by_role('dialog',name='When something happens')
        dialog.get_by_label('Project',exact=True).select_option(self.ids['project'])
        expect(dialog.get_by_label('When',exact=True).locator('option')).to_have_count(5)
        dialog.get_by_label('When',exact=True).select_option('pr_ready')
        expect(dialog.get_by_label('Then',exact=True).locator('option')).to_have_text(['tell me','check it against the task'])
        dialog.get_by_role('button',name='Cancel',exact=True).click()

    def test_04_reply_is_prefilled_private_and_only_send_posts(self):
        for phone in (False,True):
            page=self.page(phone=phone)
            notification=str(uuid.uuid4())
            messages=self.api(page,'GET',f"/api/v1/conversations/{self.ids['conversation']}/messages?limit=100",status=200)
            # An owner-bound draft comes from the dedicated owner-only endpoint. Native Reply and Send remain real.
            url=f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}"
            body='I checked the sensor connector. Let us repeat the low-light test.'
            page.route(f'**/api/v1/inbox/{notification}',lambda route:self.json(route,{'id':notification,'title':'Jonas mentioned you','body':'Please check the connector','reason':'mention','url':url,'source':{'type':'project','id':self.ids['project'],'workspaceId':self.ids['workspace']},'assistantRequestIdentity':None}))
            page.route(f'**/api/v1/inbox/{notification}/assistant-draft',lambda route:self.json(route,{'ownerUserId':schedules.ADA['id'],'body':body,'projectId':self.ids['project'],'conversationId':self.ids['conversation'],'url':url}))
            page.goto(f'/inbox/{notification}')
            reply=page.get_by_role('textbox',name='Reply',exact=True)
            expect(reply).to_have_value(body)
            expect(page.get_by_text('Drafted by your assistant',exact=True)).to_be_visible()
            current=self.api(page,'GET',f"/api/v1/conversations/{self.ids['conversation']}/messages?limit=100",status=200)
            self.assertEqual(len(current['items']),len(messages['items']))
            page.get_by_role('button',name='Send reply',exact=True).click()
            expect(reply).to_have_value('')
            page.close()
