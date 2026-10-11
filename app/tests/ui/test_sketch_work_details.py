"""Project-map work creation opens the native object from both supported map routes."""
import os
import re
import unittest
import uuid
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_work_pagination import api


class SketchWorkDetailsJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=10000)
        cls.ctx = cls.browser.new_context(base_url=ORIGIN)
        api(cls.ctx, "POST", "/api/auth/sign-up/email", {
            "name": "Ada Kowalska", "email": f"map-details-{uuid.uuid4()}@example.test",
            "password": "Compare the same measured observations",
        })
        ws = api(cls.ctx, "POST", "/api/v1/workspaces", {"name": "Riverside makers"}, 201)
        cls.project = api(cls.ctx, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {
            "name": "Library lighting measurements", "visibility": "restricted",
        }, 201)["id"]
        cls.sketch = api(cls.ctx, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {
            "title": "Sensing options", "scope": "project", "projectId": cls.project,
        }, 201)["id"]
        cls.text = "Compare the same shield in both low-light trials"
        cls.thought = api(cls.ctx, "POST", f"/api/v1/sketches/{cls.sketch}/thoughts", {
            "text": cls.text, "x": 0, "y": 0,
        }, 201)["thought"]["id"]
        cls.state = cls.ctx.storage_state()

    @classmethod
    def tearDownClass(cls):
        cls.ctx.close()
        cls.browser.close()
        cls.pw.stop()

    def test_01_workspace_and_project_maps_open_the_exact_created_native_work(self):
        for route in ("workspace", "project"):
            for phone in (False, True):
                with self.subTest(route=route, phone=phone):
                    ctx = self.browser.new_context(base_url=ORIGIN, storage_state=self.state,
                        viewport={"width": 412 if phone else 1500, "height": 915 if phone else 900},
                        is_mobile=phone, has_touch=phone)
                    self.addCleanup(ctx.close)
                    page = ctx.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    # A project sketch opened at /map/:id is canonicalised to its project map (#210);
                    # creation and the details must keep that project route on both entries.
                    canonical = f"/projects/{self.project}/map/{self.sketch}"
                    page.goto(f"/map/{self.sketch}" if route == "workspace" else canonical)
                    expect(page).to_have_url(re.compile(rf"{re.escape(canonical)}$"))
                    page.locator(f".sk-node[data-id='{self.thought}']").click()
                    if phone:
                        page.get_by_role('button', name='Thought actions', exact=True).tap()
                    create = page.get_by_role("button", name="Create task from selected thoughts", exact=True)
                    expect(create).to_have_attribute("aria-disabled", "false")
                    with page.expect_response(lambda response: response.request.method == "POST"
                        and urlsplit(response.url).path == f"/api/v1/projects/{self.project}/work") as saved:
                        create.click()
                    self.assertEqual(saved.value.status, 201)
                    item = saved.value.json()
                    self.assertEqual(item["projectId"], self.project)
                    panel = page.locator(f".wd[data-detail-kind='work'][data-detail-id='{item['id']}']")
                    expect(panel).to_be_visible()
                    expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "ready")
                    expect(panel).to_contain_text(self.text)
                    expect(panel).to_contain_text("Everyone with access to Library lighting measurements")
                    expect(panel.get_by_role("heading", name="Not available", exact=True)).to_have_count(0)
                    self.assertEqual(urlsplit(page.url).path, canonical)
                    native = api(self.ctx, "GET", f"/api/v1/work/{item['id']}")
                    self.assertEqual(native["title"], self.text)
                    self.assertTrue(any(link["role"] == "source" and link["to"]["type"] == "thought"
                        and link["to"]["id"] == self.thought for link in native["links"]))
                    sketch = api(self.ctx, "GET", f"/api/v1/sketches/{self.sketch}")
                    self.assertEqual([thought["id"] for thought in sketch["thoughts"]], [self.thought])
                    self.assertEqual(errors, [])
                    shot(page, f"155-{route}-map-work-details-{'phone' if phone else 'desktop'}")
