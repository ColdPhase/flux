"""Focused inspection of the unchanged Studio 11.1 reference in Docker.
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
HTML = ROOT / 'supplied/flux-studio-v11.1.html'
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
    page.goto(f'http://127.0.0.1:{server.server_port}/flux-studio-v11.1.html')
    report['browser'] = browser.version
    page.wait_for_function('window.Flux && window.Flux11')
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
    for theme in ['light','dark']:
        reset(theme=theme)
        shot(f'conversation-1440-{theme}.png')
        for accent in ['mint','sky','copper']:
            act('accent-set',value=accent)
            shot(f'palette-1440-{theme}-{accent}.png')
    reset()
    act('return-open')
    shot('recap-1440.png')
    report['observations']['recap_actions'] = page.locator('.summary-generate').evaluate_all("els=>els.map(e=>({label:e.innerText,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))")
    page.set_viewport_size({'width':390,'height':844})
    shot('recap-390.png')
    reset()
    act('settings')
    shot('appearance-1440-dark.png')
    act('accent-set', value='copper')
    act('theme-set', value='light')
    act('accent-set', value='sky')
    shot('appearance-1440-light.png')
    act('theme-set', value='dark')
    report['observations']['independent_theme_choices_before_reload'] = page.evaluate('({theme:Flux.prefs.theme,accent:Flux.prefs.accent,accents:Flux.prefs.accents})')
    page.reload()
    page.wait_for_function('window.Flux')
    report['observations']['independent_theme_choices_after_reload'] = page.evaluate('({theme:Flux.prefs.theme,accent:Flux.prefs.accent,accents:Flux.prefs.accents})')
    reset()
    act('view',view='map'); act('map-view',value='list')
    # Explicit disposable deep fixture, not shipped startup data.
    page.evaluate("""()=>{const s=Flux.state,b=s.nodes.n3;for(const [id,text,parent] of [
      ['deep3','Zasilanie przy słabym świetle','n3'],['deep4','Pomiar poboru energii przy wykryciu gestu','deep3'],
      ['newRoot','Nowy kierunek: lokalna analiza obrazu',null]]) {
      s.nodes[id]={...b,id,text,root:!parent,outlineParent:parent};
      if(parent)s.edges['fixture-'+id]={id:'fixture-'+id,a:parent,b:id,space:b.space,map:b.map,kind:'related'};
    }Flux.render();}""")
    before=page.evaluate('Flux11.buildOutline(Flux.ui.map)')
    page.evaluate("""()=>{const s=Flux.state,b=s.nodes.n3;s.edges['fixture-cross']={id:'fixture-cross',a:'newRoot',b:'deep4',space:b.space,map:b.map,kind:'related'};Flux.render();}""")
    after=page.evaluate('Flux11.buildOutline(Flux.ui.map)')
    report['observations']['deep_cross_link']={'before_depth':before['depth'].get('newRoot'),'after_depth':after['depth'].get('newRoot'),'parent':after['parent'].get('newRoot'),'fixture':'deep3/deep4/newRoot with explicit outlineParent and ordinary cross edge'}
    shot('map-list-1440.png')
    page.set_viewport_size({'width':390,'height':844}); shot('map-list-390.png')
    act('outline-open',id='newRoot')
    report['observations']['selection_opens_drawer']=page.evaluate('Flux.ui.drawer !== null')
    count=page.evaluate('Object.keys(Flux.state.nodes).length')
    act('new-node')
    report['observations']['new_draft_creates_record']=page.evaluate('Object.keys(Flux.state.nodes).length') != count
    page.locator('[data-outline-input]').fill('Próba zapisu nowej myśli\nDruga linia')
    shot('map-draft-390.png')
    act('outline-draft-cancel')
    report['observations']['cancel_keeps_node_count']=page.evaluate('Object.keys(Flux.state.nodes).length') == count
    for width,height in [(390,844),(768,1024)]:
        reset(width,height);act('view',view='tasks');shot(f'tasks-{width}.png')
    report['observations']['horizontal_document_overflow']={}
    for view in ['chat','map','tasks','wiki']:
        reset(390,844);act('view',view=view)
        report['observations']['horizontal_document_overflow'][view]=page.evaluate('document.documentElement.scrollWidth>innerWidth')
    browser.close()
server.shutdown()
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'screenshots':len(report['screenshots']),'page_errors':report['page_errors'],'observations':report['observations']},ensure_ascii=False,indent=2))
