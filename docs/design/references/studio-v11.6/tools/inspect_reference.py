"""Focused inspection of the unchanged Studio 11.6 reference in Docker.
Serves only supplied/ on loopback inside the container; uses native localStorage.
This is not the missing author test suite or a production application test.
"""
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from threading import Thread
from datetime import datetime, timezone
import hashlib
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'inspection'
OUT.mkdir(exist_ok=True)
HTML = ROOT / 'supplied/flux-studio-v11.6.html'
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT / 'supplied')))
Thread(target=server.serve_forever, daemon=True).start()
report = {'html_sha256': hashlib.sha256(HTML.read_bytes()).hexdigest(), 'date': '2026-09-30',
          'zoom': '100%', 'origin': 'container loopback HTTP, native localStorage',
          'screenshots': [], 'observations': {}, 'page_errors': [],
          'limits': 'Focused prototype inspection only. No supplied tests, production server/access, real users/devices, LLM, remote media or full accessibility audit. Reload checks do not prove persistence after browser restart.'}
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':1440,'height':900}, device_scale_factor=1)
    page = context.new_page()
    page.on('pageerror', lambda e: report['page_errors'].append(str(e)))
    page.clock.install(time=datetime(2026,9,30,12,0,tzinfo=timezone.utc))
    report['fixture_clock']='2026-09-30T12:00:00Z'
    page.goto(f'http://127.0.0.1:{server.server_port}/flux-studio-v11.6.html')
    report['browser'] = browser.version
    page.wait_for_function('window.Flux && window.FluxCoop')
    def act(a, **data):
        page.evaluate('([a,data])=>Flux.action(a,{dataset:data})',[a,data])
    def reset(width=1440,height=900,theme='dark'):
        page.evaluate('Flux.reset()')
        page.set_viewport_size({'width':width,'height':height})
        act('theme-set',value=theme)
    def shot(name):
        page.evaluate("document.querySelector('#toasts').innerHTML=''")
        page.screenshot(path=str(OUT/name))
        report['screenshots'].append({'file':name,'viewport':page.viewport_size,
                                      'sha256':hashlib.sha256((OUT/name).read_bytes()).hexdigest()})
    report['observations']['release'] = page.evaluate('Flux.release')
    report['observations']['palettes'] = page.evaluate("({light:Flux11.paletteDefs('light'),dark:Flux11.paletteDefs('dark')})")
    for width,height in [(1440,900),(390,844),(768,1024),(320,740),(1920,1080)]:
        page.set_viewport_size({'width':width,'height':height})
        for view in ['chat','map','tasks','wiki','agents']:
            act('view',view=view)
            shot(f'{view}-{width}-dark.png')
    page.set_viewport_size({'width':1440,'height':900})
    act('theme-set',value='light')
    for view in ['chat','agents']:
        act('view',view=view); shot(f'{view}-1440-light.png')
    report['observations']['coop_version']=page.evaluate('FluxCoop.version')
    report['observations']['coop_runs']=page.evaluate('FluxCoop.runs().map(r=>({id:r.id,task:r.task,state:r.state}))')
    report['observations']['native_storage_reload']={}
    act('theme-set', value='dark');act('accent-set',value='copper')
    report['observations']['native_storage_reload']['before']=page.evaluate('({theme:Flux.prefs.theme,accent:Flux.prefs.accent})')
    page.reload();page.wait_for_function('window.FluxCoop')
    report['observations']['native_storage_reload']['after']=page.evaluate('({theme:Flux.prefs.theme,accent:Flux.prefs.accent})')
    browser.close()
server.shutdown()
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'screenshots':len(report['screenshots']),'page_errors':report['page_errors'],'observations':report['observations']},ensure_ascii=False,indent=2))
