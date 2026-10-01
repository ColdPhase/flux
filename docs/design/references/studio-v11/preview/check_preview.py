"""Focused Docker checks and matched before/after renders for the refined preview."""
from pathlib import Path
from datetime import datetime,timezone
import atexit,hashlib,json
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'preview/evidence';OUT.mkdir(exist_ok=True)
report={'scope':'Local refined prototype only; no production backend, LLM, remote media or hardware.','complete':False,'tests':[],'screenshots':[],'errors':[],'hashes':{}}
def save_report():
    report['passed']=sum(t['passed'] for t in report['tests'])
    report['failed']=sum(not t['passed'] for t in report['tests'])
    (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
atexit.register(save_report)
for name,p in [('before',ROOT/'supplied/flux-studio-v11.html'),('after',ROOT/'preview/flux-studio-v11-refined.html')]:report['hashes'][name]=hashlib.sha256(p.read_bytes()).hexdigest()
def check(name,value):
    report['tests'].append({'name':name,'passed':bool(value)})
    assert value,name
def contrast(a,b):
    def lum(css):
        parts=[float(v)/255 for v in re.findall(r'[\d.]+',css)[:3]]
        linear=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in parts]
        return sum(v*w for v,w in zip(linear,[.2126,.7152,.0722]))
    values=sorted([lum(a),lum(b)])
    return (values[1]+.05)/(values[0]+.05)
FIXTURE="""() => {const s=Flux.state,base=s.nodes.n3;for(const [id,text,parent] of [['deep3','Zasilanie przy słabym świetle','n3'],['deep4','Pomiar poboru energii przy wykryciu gestu','deep3'],['newRoot','Nowy kierunek: lokalna analiza obrazu',null]]){s.nodes[id]={...base,id,text,root:!parent,outlineParent:parent};if(parent)s.edges['fixture-'+id]={id:'fixture-'+id,a:parent,b:id,space:base.space,map:base.map,kind:'related'};}s.edges['fixture-cross']={id:'fixture-cross',a:'newRoot',b:'deep4',space:'p1',map:'map1',kind:'related'};Flux.render();}"""
CHAT_FIXTURE="""() => {for(const [id,min] of Object.entries({m1:0,m2:3,m3:5,c1:6,m4:7,m5:11,m6:13,c2:14})){Flux.state.messages[id].at=`2026-09-28T11:${String(min).padStart(2,'0')}:00.000Z`;}Flux.render();}"""
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox']);report['browser']=browser.version
    def make(file):
        page=browser.new_page(viewport={'width':1440,'height':900},device_scale_factor=1)
        page.clock.install(time=datetime(2026,9,29,12,0,tzinfo=timezone.utc))
        page.on('pageerror',lambda e:report['errors'].append({'file':file.name,'message':str(e),'stack':e.stack}))
        # A disposable browser context uses real file-origin demo storage.
        page.goto(file.as_uri());page.set_default_timeout(5000)
        return page
    before=make(ROOT/'supplied/flux-studio-v11.html');after=make(ROOT/'preview/flux-studio-v11-refined.html')
    def act(page,a,**d):return page.evaluate('([a,d])=>Flux.action(a,{dataset:d})',[a,d])
    def reset(page,width=1440,height=900,theme='dark',accent='mint'):
        page.evaluate("() => {document.activeElement?.blur();document.querySelector('#app').innerHTML='';Flux.reset();}")
        page.set_viewport_size({'width':width,'height':height});act(page,'theme-set',value=theme);act(page,'accent-set',value=accent)
    def shot(page,name):
        page.evaluate("() => {document.querySelector('#toasts').innerHTML='';for(const e of document.querySelectorAll('#chat-scroll,#drawer-scroll,.view-scroll'))e.scrollTop=0;}")
        page.screenshot(path=str(OUT/name));report['screenshots'].append({'file':name,'viewport':page.viewport_size,'zoom':'100%'})
    geometry={}
    for width,height in [(1440,900),(390,844)]:
        for label,page in [('before',before),('after',after)]:
            reset(page,width,height);page.evaluate("Flux11.openReview('p1','2026-09-29T12:00:00.000Z')")
            shot(page,f'recap-empty-{width}-{label}.png')
            geometry[f'{width}-{label}']={'generate':page.locator('.summary-generate').bounding_box(),'complete':page.locator('[data-action=return-ack]').bounding_box()}
    report['recap_geometry']=geometry
    check('Desktop recap action has content-sized width',geometry['1440-after']['generate']['width']<200)
    check('Desktop recap action remains >=32 px high',geometry['1440-after']['generate']['height']>=32)
    check('Phone recap action remains >=44 px high',geometry['390-after']['generate']['height']>=44)
    check('Mam kontekst keeps its dimensions',all(geometry[f'{w}-before']['complete'][k]==geometry[f'{w}-after']['complete'][k] for w in [1440,390] for k in ['width','height']))
    check('Zero-message state is explicit',after.locator('.summary-count').inner_text().startswith('0 '))
    check('Demo explanation is available on demand',after.locator('.summary-about').count()==1 and not after.locator('.summary-about').evaluate('e=>e.open'))
    after.locator('.summary-about summary').focus();after.locator('.summary-about summary').press('Enter')
    check('Explanation opens with keyboard',after.locator('.summary-about').evaluate('e=>e.open'))
    reset(after);act(after,'return-open')
    counts=lambda:after.evaluate('JSON.stringify({m:Object.keys(Flux.state.messages).length,n:Flux.state.notifications.length,a:Flux.state.audit.length,r:Object.keys(Flux.state.agentRuns).length})')
    previous=counts();act(after,'private-summary');after.wait_for_timeout(400)
    check('Private recap result stays off shared message/audit/notification/run paths',counts()==previous and after.locator('.private-summary-result').count()==1)
    shot(after,'recap-generated-1440-after.png')
    reset(after);act(after,'return-open');act(after,'private-summary');act(after,'summary-scope',value='mine');after.wait_for_timeout(400)
    check('Old-scope generation result is discarded',after.evaluate('Flux.ui.review.privateResult===null&&Flux.ui.review.scope==="mine"'))
    chat_geometry=[]
    for width,height,panel in [(1440,900,False),(1280,800,False),(390,844,False),(768,1024,False),(1280,800,True)]:
        for label,page in [('before',before),('after',after)]:
            reset(page,width,height);page.evaluate(CHAT_FIXTURE)
            if panel:act(page,'return-open')
            suffix='-panel' if panel else ''
            shot(page,f'chat-{width}{suffix}-{label}.png')
            if label=='after':
                pane=page.locator('#chat-scroll').bounding_box()
                own=page.locator('#chat-scroll .msg.self .bubble').first.bounding_box()
                other=page.locator('#chat-scroll .msg:not(.self) .bubble').first.bounding_box()
                chat_geometry.append({'width':width,'panel':panel,'pane':pane,'own':own,'other':other})
                check(f'{width}{suffix}: own bubble anchors at right edge',pane['x']+pane['width']-own['x']-own['width']<=80)
                check(f'{width}{suffix}: other bubble anchors at left edge',other['x']-pane['x']<=80)
                check(f'{width}{suffix}: long message measure is bounded',page.locator('#chat-scroll .msg-wrap').evaluate_all('es=>es.every(e=>e.getBoundingClientRect().width<=561)'))
                check(f'{width}{suffix}: conversation has no horizontal overflow',page.locator('#chat-scroll').evaluate('e=>e.scrollWidth<=e.clientWidth'))
    report['chat_geometry']=chat_geometry
    reset(after);page=after
    act(page,'space',id='dm1')
    page.locator('.editor[data-key="chat:dm1"]').fill('Jasne, podeślę szkic obudowy tutaj. Wypróbujmy jeden wariant.')
    page.locator('[data-action=send][data-key="chat:dm1"]').click()
    check('DM send preserves own-right and other-left authorship',page.locator('#chat-scroll .msg.self .msg-meta b').last.inner_text()=='Hubert' and page.locator('#chat-scroll .msg:not(.self) .msg-meta b').first.inner_text()=='Marek')
    shot(page,'chat-dm-1440-after.png')
    page.evaluate("() => {Flux.ui.user='u2';Flux.render();}")
    check('Own alignment follows active profile rather than a fixed author',page.locator('#chat-scroll .msg.self .msg-meta b').first.inner_text()=='Marek')
    reset(after);page.evaluate(CHAT_FIXTURE)
    draft='Testujemy lampkę przy słabym świetle.'
    page.locator('.editor[data-key="chat:p1"]').fill(draft)
    page.locator('[data-message=m3] [data-action=comments]').click()
    check('Reply/source drawer still opens exact message',page.evaluate('Flux.ui.drawer.id')=='m3')
    act(page,'close-drawer')
    check('Conversation draft survives source/reply panel',page.locator('.editor[data-key="chat:p1"]').inner_text()==draft)
    page.set_viewport_size({'width':390,'height':844})
    page.locator('.editor[data-key="chat:p1"]').fill('Przy zgaszonej lampie zapiszę obserwację i pobór energii. '*16)
    page.locator('[data-action=send][data-key="chat:p1"]').click()
    check('Long own text wraps without horizontal phone scroll',page.locator('#chat-scroll').evaluate('e=>e.scrollWidth<=e.clientWidth') and page.locator('#chat-scroll .msg.self .bubble').last.bounding_box()['width']<=321)
    for width,height in [(1440,900),(390,844)]:
        for label,page in [('before',before),('after',after)]:
            reset(page,width,height);act(page,'view',view='map');act(page,'map-view',value='list');page.evaluate(FIXTURE)
            shot(page,f'deep-map-{width}-{label}.png')
            if label=='after':
                outline=page.evaluate('Flux11.buildOutline(Flux.ui.map)')
                check(f'{width}: root stays at depth 0 after ordinary deep relation',outline['depth']['newRoot']==0)
                check(f'{width}: deep relation remains an explicit cross-link','fixture-cross' in [e['id'] for e in outline['cross']])
                check(f'{width}: each thought occurs once',page.locator('[data-outline-node]').count()==len(outline['nodes']))
                if width==390:
                    search=page.locator('.map-toolbar .local-search').bounding_box();create=page.locator('.map-toolbar [data-action=new-node]').bounding_box()
                    check('Phone map search and create share one row',abs(search['y']-create['y'])<1)
                    check('Phone map create retains >=44 px target',create['height']>=44)
                    check('Phone map toolbar fits two rows without horizontal scroll',page.locator('.map-toolbar').bounding_box()['height']<130 and page.locator('.map-toolbar').evaluate('e=>e.scrollWidth<=e.clientWidth'))
    for width,height in [(1440,900),(390,844)]:
        for label,page in [('before',before),('after',after)]:
            reset(page,width,height,theme='light');act(page,'view',view='map');act(page,'map-view',value='list');page.evaluate(FIXTURE)
            shot(page,f'deep-map-{width}-light-{label}.png')
    state=after.evaluate('JSON.stringify({nodes:Flux.state.nodes,edges:Flux.state.edges})')
    parent_path=after.locator('[data-outline-node=deep4] > .outline-entry > .outline-path')
    check('Phone deep row names its immediate parent',parent_path.locator('summary').inner_text()=='W gałęzi: Zasilanie przy słabym świetle')
    parent_path.locator('summary').focus();parent_path.locator('summary').press('Enter')
    check('Phone ancestor path opens with keyboard and retains ordered names',parent_path.evaluate('e=>e.open') and parent_path.locator('p').inner_text()=='Lampka reagująca na gest › Kamera + rozpoznawanie gestu › A co w ciemnym pokoju? › Zasilanie przy słabym świetle')
    act(after,'map-view',value='canvas');act(after,'map-view',value='list')
    check('List/canvas switching does not mutate graph',state==after.evaluate('JSON.stringify({nodes:Flux.state.nodes,edges:Flux.state.edges})'))
    act(after,'outline-toggle',id='n0')
    destination=after.locator('[data-action=outline-reveal][data-id=deep4]');destination.focus();destination.press('Enter')
    check('Cross-link reveals exact collapsed destination',after.locator('[data-outline-open=deep4]').is_visible() and after.evaluate('Flux.ui.selected.includes("deep4")'))
    after.wait_for_function("document.querySelector('[data-outline-open=deep4]')===document.activeElement")
    check('Cross-link focus returns to exact thought',after.locator('[data-outline-open=deep4]').evaluate('e=>e===document.activeElement'))
    # User creation paths stay available: add a branch and exact-object sharing.
    act(after,'outline-expand');act(after,'node-child',id='deep4')
    child=after.evaluate('Flux.ui.selected[0]')
    check('Adding a child retains its explicit parent',after.evaluate('(id)=>Flux.state.nodes[id].outlineParent',child)=='deep4')
    reset(after);act(after,'view',view='map');act(after,'map-view',value='list')
    after.locator('[data-outline-node=n1] .outline-more summary').first.click()
    check('Secondary share/edit actions remain discoverable',after.locator('[data-outline-node=n1] .outline-more [data-action=share]').first.is_visible())
    act(after,'share',ref='node:n1')
    check('Sharing still targets the exact thought',after.evaluate('Flux.ui.pendingShares["chat:p1"]==="node:n1"'))
    reset(after);act(after,'view',view='map');act(after,'map-view',value='list');after.evaluate(FIXTURE)
    after.evaluate("() => {Flux.state.nodes.deep3.outlineParent='deep4';Flux.render();}")
    outline=after.evaluate('Flux11.buildOutline(Flux.ui.map)')
    check('Cyclic parent hints terminate without losing thoughts',len(outline['depth'])==len(outline['nodes']) and after.locator('[data-outline-node]').count()==len(outline['nodes']))
    after.set_viewport_size({'width':390,'height':844})
    after.evaluate("""() => {Flux.state.nodes.deep3.outlineParent='n3';let parent='deep4';for(let i=5;i<=10;i++){const id='deep'+i;Flux.state.nodes[id]={...Flux.state.nodes.deep4,id,text:'Pomiar '+i,outlineParent:parent};Flux.state.edges['fixture-'+id]={...Flux.state.edges['fixture-deep4'],id:'fixture-'+id,a:parent,b:id};parent=id;}Flux.render();}""")
    check('Phone indentation stays bounded beyond level 6',after.locator('[data-outline-open=deep10]').bounding_box()['x']==after.locator('[data-outline-open=deep4]').bounding_box()['x'])
    palettes=[];contrast_pairs=[]
    for theme in ['light','dark']:
        reset(before,theme=theme);act(before,'settings');act(before,'settings-tab',value='appearance')
        shot(before,f'appearance-{theme}-before.png')
        for accent in ['mint','iris','sky']:
            reset(after,theme=theme,accent=accent);act(after,'settings');act(after,'settings-tab',value='appearance')
            check(f'{theme}/{accent}: exactly three named accent choices',after.locator('.swatches .swatch').count()==3)
            check(f'{theme}/{accent}: exactly one selected accent',after.locator('.swatches .swatch[aria-pressed=true]').count()==1)
            color=after.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")
            palettes.append({'theme':theme,'accent':accent,'value':color})
            shot(after,f'appearance-{theme}-{accent}-after.png')
            act(after,'close-modal');shot(after,f'conversation-{theme}-{accent}-after.png')
            act(after,'return-open')
            colors=after.locator('.summary-generate').evaluate('e=>{const s=getComputedStyle(e);return {color:s.color,background:s.backgroundColor}}')
            ratio=contrast(colors['color'],colors['background'])
            contrast_pairs.append({'theme':theme,'accent':accent,'pair':'recap label / soft button','ratio':round(ratio,2),**colors})
            check(f'{theme}/{accent}: compact recap text contrast >=4.5',ratio>=4.5)
            status=after.locator('.resolution-status').first.evaluate('e=>getComputedStyle(e).color')
            palettes[-1]['resolution_status']=status
    report['palettes']=palettes
    report['contrast_pairs']=contrast_pairs
    check('Light and dark resolve distinct accents in every family',all(next(p['value'] for p in palettes if p['theme']=='light' and p['accent']==a)!=next(p['value'] for p in palettes if p['theme']=='dark' and p['accent']==a) for a in ['mint','iris','sky']))
    check('Resolution status keeps a stable meaning across accent families',all(len({p['resolution_status'] for p in palettes if p['theme']==theme})==1 for theme in ['light','dark']))
    reset(after);act(after,'accent-set',value='sky');after.reload()
    check('Selected family persists through actual reload',after.evaluate('Flux.prefs.accent')=='sky')
    check('No browser page errors',not report['errors'])
    browser.close()
report['complete']=True
save_report()
print(report['passed'],'checks passed;',len(report['screenshots']),'screenshots;',len(report['errors']),'page errors')
