"""Focused inspection of the byte-preserved supplied Studio 11.6 in Docker.
Every capture records source hash, runtime release, view and scenario. Test-hook
observations are prototype checks, never production integration acceptance.
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
HTML = ROOT / 'supplied/flux-studio-v11.6.html'
SOURCE_HASH = hashlib.sha256(HTML.read_bytes()).hexdigest()
assert SOURCE_HASH == '5c0f26dd05709d18d0a8c28bfa412bc29948f4b49f2738ac5c537ddbe4f943e7'
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT / 'supplied')))
Thread(target=server.serve_forever, daemon=True).start()
report = {'source_file': HTML.name, 'html_sha256': SOURCE_HASH, 'date': '2026-09-30',
          'zoom': '100%', 'origin': 'container loopback HTTP, native localStorage',
          'screenshots': [], 'observations': {}, 'page_errors': [],
          'limits': 'Focused unchanged prototype. View/modal navigation uses its public test hooks; task/comment check uses domain hooks. Not full UI interaction coverage, production API/auth/concurrency, real MCP/GitHub/LLM/media, device/scaling, IME or accessibility acceptance. 4K/ultrawide are emulated CSS viewports, not hardware evidence.'}
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':1440,'height':900}, device_scale_factor=1)
    page = context.new_page()
    page.on('pageerror', lambda e: report['page_errors'].append(str(e)))
    page.clock.install(time=datetime(2026,9,30,12,0,tzinfo=timezone.utc))
    report['fixture_clock']='2026-09-30T12:00:00Z'
    url=f'http://127.0.0.1:{server.server_port}/{HTML.name}'
    page.goto(url)
    page.wait_for_function('window.Flux && window.FluxCoop')
    report['browser'] = browser.version
    def act(a, **data):
        page.evaluate('([a,data])=>Flux.action(a,{dataset:data})',[a,data])
    def co(a, **data):
        page.evaluate('([a,data])=>FluxCoop.action(a,data)',[a,data])
    def fresh(width=1440,height=900,theme='dark'):
        page.evaluate('localStorage.clear()');page.reload()
        page.wait_for_function('window.FluxCoop')
        page.set_viewport_size({'width':width,'height':height})
        act('theme-set',value=theme)
    def shot(name, scenario):
        meta=page.evaluate('({release:Flux.release,coop:FluxCoop.version,view:Flux.ui.view,space:Flux.ui.space,modal:Flux.ui.modal?.type||null})')
        assert meta['release']=='11.6' and meta['coop']=='11.6', meta
        page.evaluate("document.querySelector('#toasts').innerHTML=''")
        page.clock.run_for(250)
        filename='studio-v11.6-'+name
        page.screenshot(path=str(OUT/filename),animations='disabled')
        report['screenshots'].append({'file':filename,'scenario':scenario,'viewport':page.viewport_size,
            'source_file':HTML.name,'source_sha256':SOURCE_HASH,'runtime':meta,
            'sha256':hashlib.sha256((OUT/filename).read_bytes()).hexdigest()})
    report['observations']['release'] = page.evaluate('Flux.release')
    report['observations']['palettes'] = page.evaluate("({light:Flux11.paletteDefs('light'),dark:Flux11.paletteDefs('dark')})")
    for width,height in [(1440,900),(390,844),(768,1024),(320,740),(1920,1080)]:
        page.set_viewport_size({'width':width,'height':height})
        for view in ['chat','map','tasks','wiki','agents']:
            act('view',view=view)
            assert page.evaluate('Flux.ui.view')==view
            shot(f'{view}-{width}-dark.png',f'Original startup project, {view}, dark theme')
    fresh(theme='light')
    for view in ['chat','agents']:
        act('view',view=view);shot(f'{view}-1440-light.png',f'Original {view}, light theme')
    for width,height in [(3840,2160),(5120,1440)]:
        fresh(width,height);act('view',view='agents')
        shot(f'agents-{width}-dark.png','Original Agents at an emulated wide CSS viewport; no hardware/scaling claim')
    for theme in ['dark','light']:
        fresh(theme=theme);act('settings')
        for accent in ['mint','sky','copper']:
            act('accent-set',value=accent)
            shot(f'appearance-{theme}-{accent}.png','Original 11.6 appearance preferences')
    for width,height in [(1440,900),(390,844)]:
        fresh(width,height);act('return-open')
        shot(f'recap-{width}.png','Original private recap; production acknowledgment semantics still differ')
        fresh(width,height);act('view',view='map');act('map-view',value='list')
        shot(f'map-list-{width}.png','Original map list; no injected outline fixture')
    act('new-node')
    shot('map-draft-390.png','New unsaved thought in original 11.6 map list')
    fresh();act('view',view='agents')
    for action in ['settings','connect-local','repos','delegate','context','packet','checkpoint']:
        co(action,**({'id':'cr1'} if action=='checkpoint' else {'id':'tc1'} if action in ['context','packet'] else {}))
        assert page.evaluate('Flux.ui.modal !== null'), action
        shot(f'coop-{action}-1440.png',f'Original co-work {action} dialog, simulated local data')
        co('close')
    artifact=page.evaluate('FluxCoop.runs().find(r=>r.artifact).artifact')
    co('artifact',id=artifact)
    shot('coop-pr-review-1440.png','Original demo PR/current-review detail, not a real GitHub connection')
    co('close')
    fresh();act('view',view='agents');co('connect-local')
    page.locator('#co-client-name').fill('Claude Code')
    page.locator('#co-device-name').fill('Laptop Huberta — fixture')
    co('connect-save')
    connections=page.evaluate('Object.values(FluxCoop.state.connections).filter(c=>c.space===Flux.ui.space).map(c=>({id:c.id,name:c.name,owner:c.owner}))')
    assert len(connections)==3 and sum(c['owner']=='u1' for c in connections)==2
    report['observations']['three_connections_disposable_fixture']=connections
    co('settings')
    shot('coop-three-connections-1440.png','Disposable third connection added through the demo connection form: two Hubert, one Marek; no live MCP')
    # Explicit domain-hook fixture; demonstrates source semantics, not click-path coverage.
    fresh();act('view',view='chat')
    result=page.evaluate("""()=>{
      let task,first,second;
      Flux.transact('inspection.task',()=>{task=Flux.createTask({title:'Próba 11.6: jedno zadanie i rozmowa'});});
      const notice=Flux.state.messages[task.createdMessage];
      const originalCreator=notice.author;
      const noticeBefore=JSON.stringify(notice);
      Flux.ui.user='u2';
      Flux.transact('inspection.first',()=>{first=Flux.createMessage({parent:Flux.ensureAnchor('task:'+task.id),text:'Pierwsza rzeczywista wiadomość Marka — sprawdzam połączenie.'});});
      Flux.transact('inspection.second',()=>{second=Flux.createMessage({parent:Flux.ensureAnchor('task:'+task.id),text:'Druga wiadomość pozostaje w tym samym wątku.'});});
      Flux.render();
      return {task:task.id,notice:notice.id,root:task.anchor,first:first.id,firstParent:first.parent,
        firstAuthor:first.author,creator:originalCreator,secondParent:second.parent,
        noticeUnchanged:JSON.stringify(Flux.state.messages[notice.id])===noticeBefore,
        announcementCount:Object.values(Flux.state.messages).filter(m=>m.systemEvent==='task.created'&&m.primary==='task:'+task.id).length};
    }""")
    assert result['announcementCount']==1 and result['noticeUnchanged']
    assert result['root']==result['first'] and result['firstParent'] is None
    assert result['secondParent']==result['first'] and result['firstAuthor']!=result['creator']
    report['observations']['creation_notice_and_first_message_domain_fixture']=result
    page.get_by_text('Pierwsza rzeczywista wiadomość Marka — sprawdzam połączenie.',exact=True).scroll_into_view_if_needed()
    shot('task-first-message-1440.png','Disposable task + one notice + true first author/root + reply, via prototype domain hooks')
    page.set_viewport_size({'width':390,'height':844})
    page.get_by_text('Pierwsza rzeczywista wiadomość Marka — sprawdzam połączenie.',exact=True).scroll_into_view_if_needed()
    shot('task-first-message-390.png','Same disposable task/message fixture on phone')
    fresh();act('theme-set',value='dark');act('accent-set',value='copper')
    before=page.evaluate('({theme:Flux.prefs.theme,accent:Flux.prefs.accent})')
    page.reload();page.wait_for_function('window.FluxCoop')
    after=page.evaluate('({theme:Flux.prefs.theme,accent:Flux.prefs.accent})')
    assert before==after
    report['observations']['native_storage_reload']={'before':before,'after':after}
    browser.close()
server.shutdown()
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'screenshots':len(report['screenshots']),'page_errors':report['page_errors'],'observations':report['observations']},ensure_ascii=False,indent=2))
