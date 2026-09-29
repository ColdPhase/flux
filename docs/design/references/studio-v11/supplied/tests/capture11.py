from browser_support import launch
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'screenshots';OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
 b=launch(p);page=b.new_page(viewport={'width':1440,'height':960},device_scale_factor=1)
 page.evaluate("()=>{const d={};Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>d[k]??null,setItem:(k,v)=>d[k]=String(v),removeItem:k=>delete d[k]}})}")
 page.set_content((ROOT/'flux-studio-v11.html').read_text());page.set_default_timeout(5000)
 def ev(s):return page.evaluate(s)
 def act(a,**d):return page.evaluate('([a,d])=>Flux.action(a,{dataset:d})',[a,d])
 def click(a,sel=''):page.locator('[data-action="'+a+'"]'+sel).first.click()
 def shot(name):
  page.wait_for_timeout(150);ev("document.querySelector('#toasts').innerHTML=''");page.screenshot(path=str(OUT/name))
 def reset():
  ev("()=>{document.activeElement?.blur();document.querySelector('#app').innerHTML='';Flux.reset();}");page.set_viewport_size({'width':1440,'height':960});act('accent-set',value='mint')
 reset();shot('01-rozmowa.png')
 click('return-open');click('private-summary');page.wait_for_timeout(400);shot('02-prywatny-skrot.png')
 reset();act('view',view='tasks');ev("()=>{Flux.state.tasks.t1.effort={value:2,unit:'day'};Flux.state.tasks.t1.estimate=960;Flux.state.tasks.t10.effort={value:1,unit:'week'};Flux.state.tasks.t10.estimate=2400;Flux.render();}");shot('03-kanban.png')
 ev("Flux.openRef('task:t1')");act('task-estimate',id='t1');shot('04-naklad.png')
 reset();act('view',view='map');act('map-view',value='list');ev("()=>{Flux.state.edges.cross={id:'cross',a:'n3',b:'n2',space:'p1',map:'map1',kind:'related'};Flux.render();}");shot('05-mapa-lista.png')
 act('map-view',value='canvas');page.locator('#search-map').fill('ciemnym');shot('06-szukaj-mapa.png')
 reset();act('view',view='wiki');page.locator('#search-wiki').fill('chmury');shot('07-szukaj-wiki.png')
 reset();click('goal-open');page.locator('#goal-criteria').fill('Jeden gest zapala światło bez połączenia z internetem.');page.locator('.goal-tasks summary').click();page.locator('[name=goal-task][value=t1]').check();shot('08-cel.png')
 reset();click('settings');act('settings-tab',value='appearance');shot('09-palety.png')
 reset();act('workspace-transfer');shot('10-eksport.png')
 ev('window.__archive=Flux11.exportWorkspace()');click('close-modal');ev("Flux.ui.modal={type:'workspace-import',data:window.__archive};Flux.render()");shot('11-import.png')
 reset();page.set_viewport_size({'width':390,'height':844});click('return-open');shot('12-mobile-skrot.png')
 reset();page.set_viewport_size({'width':390,'height':844});act('view',view='tasks');shot('13-mobile-kanban.png')
 reset();act('theme-set',value='light');act('accent-set',value='teal');act('view',view='wiki');page.locator('#search-wiki').fill('chmury');shot('14-jasna-laguna.png')
 reset();ev("Flux.transact('demo',()=>Flux.runAI('/ai ułóż [[map:map1]] bez zmiany treści',null))");page.wait_for_function('Object.keys(Flux.state.proposals).length>0');mid=ev("Object.values(Flux.state.messages).find(m=>m.text.startsWith('/ai ułóż')).id");act('comments',id=mid);shot('15-agent.png')
 reset();ev("Flux.openRef('node:n1')");click('live');click('close-drawer');act('live-demo-join');ev('Flux.fitMap()');shot('16-razem.png')
 b.close()
print('16 screenshots saved')
