from browser_support import launch
"""Reproducible Chromium interaction/domain checks for Flux 10.
Navigation is blocked by this environment. DOM is loaded via set_content;
storage is an explicit memory double, NOT native localStorage persistence.
Run: python tests/test_flux.py [path/to/html]
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, sys, time, traceback
ROOT=Path(__file__).resolve().parents[1]
HTML=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'flux-studio-v11.html'
RESULTS=[]
STORAGE_JS="""seed => {const data={...seed}; window.__testStorage=data;Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>data[k]??null,setItem:(k,v)=>{data[k]=String(v)},removeItem:k=>delete data[k],clear:()=>Object.keys(data).forEach(k=>delete data[k])}})}"""
def check(value,msg='Assertion failed'):
    if not value: raise AssertionError(msg)
with sync_playwright() as p:
 browser=launch(p)
 context=browser.new_context(viewport={'width':1440,'height':1000},accept_downloads=True)
 page=context.new_page();page.set_default_timeout(3500)
 page.evaluate(STORAGE_JS,{})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content(HTML.read_text(),wait_until='load')
 def ev(expr):return page.evaluate(expr)
 def click(action,extra=''):
    page.locator(f'[data-action="{action}"]{extra}').first.click()
 def reset():
    page.evaluate("""() => {document.activeElement?.blur();document.querySelector('#app').innerHTML='';Flux.reset();document.querySelector('#popover').innerHTML='';document.querySelector('#toasts').innerHTML='';}""")
    page.set_viewport_size({'width':1440,'height':1000})
 def test(name,fn,category='interaction'):
    reset();start=time.monotonic();before=len(errors)
    try:
     fn()
     check(len(errors)==before, 'Uncaught browser error: '+str(errors[before:]))
     RESULTS.append({'name':name,'category':category,'status':'passed','seconds':round(time.monotonic()-start,3)})
    except Exception as e:
     RESULTS.append({'name':name,'category':category,'status':'failed','error':str(e),'seconds':round(time.monotonic()-start,3)})
     try:page.screenshot(path=str(ROOT/'screenshots'/f'failure-{len(RESULTS):02}.png'))
     except:pass
     print('FAIL',name,str(e)[:260])
 def send(text,selector='.editor[data-key="chat:p1"]'):
    el=page.locator(selector);el.fill(text);el.press('Enter')
 def openTask():ev("Flux.openRef('task:t1')")
 def markExisting(kind,mid='m5'):
    ev(f"Flux.action('mark-{kind}',{{dataset:{{id:'{mid}'}}}})")
 test('Rozmowa projektu nie wymaga wyboru tematu',lambda:check(page.locator('.tabs').inner_text().splitlines()==['Rozmowa','Mapa','Zadania','Wiki']))
 test('Wyślij wiadomość klawiszem Enter, bez formularza',lambda:(send('Test atomowej wiadomości'),check(ev("Object.values(Flux.state.messages).some(m=>m.text==='Test atomowej wiadomości'&&!m.parent)")),check(page.locator('.editor[data-key="chat:p1"]').inner_text()=='')))
 def newline():
    e=page.locator('.editor[data-key="chat:p1"]');n=ev('Object.keys(Flux.state.messages).length');e.fill('Pierwsza');e.press('Shift+Enter');e.press('z');check(ev('Object.keys(Flux.state.messages).length')==n);check('\n' in ev("Flux.serializeEditor(document.querySelector('.editor'))"))
 test('Shift Enter dodaje linię zamiast wysyłać',newline)
 def reply():
    ev("Flux.action('comments',{dataset:{id:'m3'}})");send('Odpowiedź przy jednej myśli','.editor[data-key="reply:m3"]');check(ev("Object.values(Flux.state.messages).filter(m=>m.text==='Odpowiedź przy jednej myśli'&&m.parent==='m3').length") ==1);check(page.locator('[data-message] .msg-text',has_text='Odpowiedź przy jednej myśli').count()==1)
 test('Odpowiedź jest jednym obiektem i nie tworzy nowego tematu',reply)
 def mention():
    e=page.locator('.editor[data-key="chat:p1"]');e.press_sequentially('@kamer',delay=10);check(page.locator('.mention-menu').is_visible());n=ev('Object.keys(Flux.state.messages).length');e.press('Enter');check(ev('Object.keys(Flux.state.messages).length')==n);check(e.locator('[data-ref]').count()==1);e.press('Enter');check(ev('Object.keys(Flux.state.messages).length')==n+1)
 test('@ podpowiada materiał; Enter najpierw wybiera, potem wysyła',mention)
 test('Podpowiedzi obejmują pojedyncze wiadomości',lambda:(page.locator('.editor').press_sequentially('@ciemku'),check(page.locator('.mention-menu .type',has_text='Wiadomość').count()>=1)))
 def draft():
    page.locator('.editor[data-key="chat:p1"]').fill('Niedokończone zdanie');ev("Flux.openRef('page:w1')");click('close-drawer');check(page.locator('.editor[data-key="chat:p1"]').inner_text()=='Niedokończone zdanie')
 test('Podgląd wiki nie gubi szkicu rozmowy',draft)
 def taskSingleComposer():
    page.locator('.editor[data-key="chat:p1"]').fill('Poczekaj, jeszcze piszę');openTask();check(page.locator('.editor').count()==1);check(page.locator('.editor').get_attribute('data-key')=='entity:task:t1');click('close-drawer');check(page.locator('.editor').inner_text()=='Poczekaj, jeszcze piszę')
 test('Przy zadaniu jest tylko jeden aktywny composer; szkic główny wraca',taskSingleComposer)
 def taskReply():
    openTask();send('Komentarz do testu','.editor[data-key="entity:task:t1"]');mid=ev("Object.values(Flux.state.messages).find(m=>m.text==='Komentarz do testu').id");check(ev(f"Flux.state.messages['{mid}'].parent")=='m6');click('close-drawer');ev("Flux.action('comments',{dataset:{id:'m6'}})");check(page.locator(f'[data-message="{mid}"]').is_visible())
 test('Komentarz zadania jest tą samą odpowiedzią w rozmowie',taskReply)
 def lazyAnchor():
    n=ev('Object.keys(Flux.state.messages).length');ev("Flux.openRef('node:n2')");check(ev('Object.keys(Flux.state.messages).length')==n);send('Test komentarza myśli','.editor[data-key="entity:node:n2"]');check(ev('Object.keys(Flux.state.messages).length')==n+2);check(ev("!!Flux.state.anchors['node:n2']"))
 test('Samo otwarcie myśli nie publikuje; pierwszy komentarz tworzy kartę i odpowiedź',lazyAnchor)
 def share():
    n=ev('Object.keys(Flux.state.messages).length');ev("Flux.action('share',{dataset:{ref:'node:n2'}})");check(page.locator('.composer').inner_text().find('Pokażesz')>=0);check(ev('Object.keys(Flux.state.messages).length')==n);click('send');check(ev('Object.keys(Flux.state.messages).length')==n+1);check(ev("!!Flux.state.anchors['node:n2']"));ev("Flux.action('share',{dataset:{ref:'node:n2'}})");check(ev('Object.keys(Flux.state.messages).length')==n+1)
 test('Mapa → rozmowa wymaga wysłania, ponowne pokazanie otwiera istniejącą kartę',share)
 def msgMap():
    ev("Flux.action('message-map',{dataset:{id:'c1'}})");page.locator('#node-label').fill('Lokalne przetwarzanie');click('message-map-save');check(ev("Object.values(Flux.state.nodes).some(n=>n.source==='c1')"));check(not ev("Object.values(Flux.state.nodes).some(n=>n.source==='m3')"))
 test('Myśl z konkretnej odpowiedzi zachowuje dokładne źródło',msgMap)
 def creationOrder():
    ev("Flux.transact('test',()=>{Flux.createTask({title:'A',source:'c1'});Flux.createTask({title:'B',source:'m3'});Flux.newNode('map1','Z c1',100,100,{source:'c1'});})")
    check(ev("Object.values(Flux.state.tasks).find(t=>t.title==='A').nodeIds.length") ==1);check(ev("Object.values(Flux.state.tasks).find(t=>t.title==='B').nodeIds.length")==0)
 test('Późniejsza mapa podłącza tylko zadanie z tej samej wypowiedzi',creationOrder,'domain')
 def createMany():
    ev("Flux.action('new-task',{dataset:{nodes:'n1,n3'}})");page.locator('#task-title').fill('Jedna próba, dwa konteksty');click('task-create','[data-take="true"]');t=ev("Object.values(Flux.state.tasks).find(t=>t.title==='Jedna próba, dwa konteksty')");check(t['nodeIds']==['n1','n3']);check(t['assignee']=='u1');check(t['status']=='doing')
 test('Kilka myśli → jedno zadanie, nie kopie 1:1',createMany)
 def taskToSketch():
    n=ev('Object.keys(Flux.state.tasks).length');ev("Flux.action('sketch-task',{dataset:{id:'t1'}})");check(ev('Object.keys(Flux.state.tasks).length')==n);check(ev("Flux.state.tasks.t1.nodeIds.length")==3)
 test('Szkic z zadania nie tworzy podzadań',taskToSketch)
 def normalWaiting():
    openTask();send('Czekam na kamerę','.editor[data-key="entity:task:t1"]');check(ev("Flux.activeBlockers('t1').length")==0)
 test('Samo słowo „czekam” nie jest automatycznym blockerem',normalWaiting)
 def blocker():
    openTask();click('compose-mode','[data-mode="blocker"]');page.locator('#composer-helper').select_option('u2');n=ev('Object.keys(Flux.state.messages).length');send('Brakuje mi dostępu','.editor[data-key="entity:task:t1"]');check(ev('Object.keys(Flux.state.messages).length')==n+1);b=ev("Flux.activeBlockers('t1')[0]");check(b['helper']=='u2');check(ev('Flux.state.tasks.t1.assignee')=='u1');check(ev('Flux.ui.composerMode')=='normal')
 test('Przeszkoda: jeden komentarz, blocker, pomocnik; wykonawca bez zmian',blocker)
 def preventDone():
    ev("Flux.transact('test',()=>Flux.markBlocker('m5','t1','u2'))");openTask();page.locator('[data-change="task-status"]').select_option('done');check(ev('Flux.state.tasks.t1.status')=='doing');check('przeszkody' in page.locator('#toasts').inner_text())
 test('Nie można zakończyć zadania z otwartą przeszkodą',preventDone)
 def resolveOne():
    ids=ev("(()=>{let a=Flux.markBlocker('m5','t1','u2'), b=Flux.markBlocker('m3','t1');return [a,b]})()");ev(f"Flux.action('resolve',{{dataset:{{id:'{ids[0]}'}}}})");page.locator('#resolve-text').fill('Dostęp działa, kamera jest podłączona.');click('resolve-save');check(ev("Flux.activeBlockers('t1').length")==1);check(ev('Flux.state.tasks.t1.status')=='doing');check(ev(f"!!Flux.state.effects['{ids[0]}'].solution"))
 test('Rozwiązanie usuwa jedną przeszkodę, nie wszystkie i nie kończy zadania',resolveOne)
 def question():
    ev("Flux.action('mark-solution',{dataset:{id:'c1'}})");page.locator('#solution-select').select_option('question:m3');click('effect-save');check(ev('Flux.state.messages.m3.solution')=='c1');check(ev('Flux.state.tasks.t1.status')=='doing')
 test('Odpowiedź może rozwiązać pytanie bez zadania',question)
 def sameTextResult():
    before=ev('Object.keys(Flux.state.nodes).length');ev("Flux.transact('test',()=>Flux.setResult('t1','c1',false))");check(ev('Flux.state.tasks.t1.result')=='c1');check(ev('Object.keys(Flux.state.nodes).length')==before);ev("Flux.openRef('node:n1')");check('Tak, wszystko liczymy lokalnie' in page.locator('.task-result').inner_text())
 test('Wynik ma jedną wiadomość; mapa nie tworzy kopii notatki',sameTextResult)
 def resultLive():
    ev("Flux.transact('test',()=>Flux.setResult('t1','c1',false))");ev("Flux.action('message-edit',{dataset:{id:'c1'}})");page.locator('#message-edit-text').fill('Zmieniony wynik z tego samego źródła');click('message-edit-save');ev("Flux.openRef('node:n1')");check('Zmieniony wynik' in page.locator('.task-result').inner_text())
 test('Edycja wiadomości aktualizuje podgląd wyniku na mapie',resultLive)
 def resultFinish():
    openTask();click('compose-mode','[data-mode="result"]');page.locator('#composer-finish').check();send('Test zakończony. Kamera nie działa po ciemku.','.editor[data-key="entity:task:t1"]');check(ev('Flux.state.tasks.t1.status')=='done');check(ev("!('status' in Flux.state.nodes.n1)"));check(ev('Object.keys(Flux.state.proposals).length')==1)
 test('Zakończenie testu nie oznacza zaakceptowania pomysłu',resultFinish)
 def staleProposal():
    ev("Flux.transact('test',()=>Flux.setResult('t1','c1',false))");page.wait_for_function('Object.keys(Flux.state.proposals).length===1');pid=ev('Object.keys(Flux.state.proposals)[0]');ev("Flux.state.messages.c1.text='Nowy wynik';Flux.state.messages.c1.version++");version=ev('Flux.state.pages.w1.version');check(ev(f"(()=>{{try{{Flux.applyProposal('{pid}');return false}}catch(e){{return true}}}})()"));check(ev('Flux.state.pages.w1.version')==version)
 test('Agent blokuje propozycję po zmianie źródłowego wyniku',staleProposal,'domain')
 def applyOnce():
    ev("Flux.transact('test',()=>Flux.setResult('t1','c1',false))");page.wait_for_function('Object.keys(Flux.state.proposals).length===1');pid=ev('Object.keys(Flux.state.proposals)[0]');ev(f"Flux.transact('test',()=>Flux.applyProposal('{pid}'))");check(ev('Flux.state.pages.w1.version')==2);check(ev(f"(()=>{{try{{Flux.applyProposal('{pid}');return false}}catch(e){{return true}}}})()"));check(ev('Flux.state.pages.w1.version')==2)
 test('Propozycja wiki działa raz, tworzy wersję i zachowuje źródło',applyOnce,'domain')
 def dates():
    original=ev('Flux.state.tasks.t1.due');ev("Flux.action('task-plan',{dataset:{id:'t1'}})");page.locator('#date-input').fill('2030-05-10');click('date-save','[data-kind="plan"]:not([data-clear])');check(ev('Flux.state.tasks.t1.due')==original);ev("Flux.action('task-estimate',{dataset:{id:'t1'}})");check(page.locator('input[type="date"]').count()==0);click('effort-preset','[data-value="30"]');click('effort-save');check(ev('Flux.state.tasks.t1.estimate')==30);check(ev("Flux.prefs.plan.t1")=='2030-05-10');check(ev('Flux.state.tasks.t1.due')==original)
 test('Termin, mój plan i nakład są oddzielnymi operacjami',dates)
 def resumePrivate():
    n=ev('Object.keys(Flux.state.messages).length');ev("Flux.action('resume-edit',{dataset:{id:'t1'}})");page.locator('#resume-text').fill('Zacznij od pomiaru napięcia');click('resume-save');check(ev('Object.keys(Flux.state.messages).length')==n);check(ev("!Flux.state.prefs.u2.notes.t1"));click('navigate-home');check('Zacznij od pomiaru napięcia' in page.locator('.resume-card').inner_text())
 test('Punkt powrotu jest osobisty i działa na U mnie',resumePrivate)
 def boardMove():
    n=ev('Object.keys(Flux.state.tasks).length');ev("Flux.action('task-move',{dataset:{id:'t1'}})");page.locator('#board-select').select_option('b2');click('task-move-save');check(ev('Object.keys(Flux.state.tasks).length')==n);check(ev('Flux.state.tasks.t1.board')=='b2');check(ev('Flux.state.tasks.t1.anchor')=='m6')
 test('Przeniesienie między tablicami zachowuje zadanie i rozmowę',boardMove)
 def table():
    click('view','[data-view="tasks"]');ids=page.locator('.task-card').evaluate_all('(els)=>els.map(e=>e.dataset.task).sort()');click('task-view','[data-value="table"]');check(page.locator('.tasks-table [data-task]').evaluate_all('(els)=>els.map(e=>e.dataset.task).sort()')==ids)
 test('Kanban i tabela pokazują te same identyfikatory',table)
 def manyMapsBoards():
    click('new-map') if page.locator('[data-action="new-map"]').count() else ev("Flux.action('new-map')")
    page.locator('#map-title').fill('Alternatywna droga');click('map-create');check(ev('Object.keys(Flux.state.maps).length')==4);ev("Flux.action('new-board')");page.locator('#board-title').fill('Wdrożenie');click('board-create');check(ev('Object.keys(Flux.state.boards).length')==4)
 test('Nowa mapa nie zakłada tablicy, tablica nie zakłada mapy',manyMapsBoards)
 def drag():
    click('view','[data-view="map"]');page.wait_for_timeout(100);box=page.locator('[data-node="n1"]').bounding_box();pos=ev('({x:Flux.state.nodes.n1.x,y:Flux.state.nodes.n1.y})');page.mouse.move(box['x']+50,box['y']+35);page.mouse.down();page.mouse.move(box['x']+125,box['y']+75,steps=8);page.mouse.up();check(abs(ev('Flux.state.nodes.n1.x')-pos['x'])>40);click('map-undo');check(ev('Flux.state.nodes.n1.x')==pos['x']);click('map-redo');check(ev('Flux.state.nodes.n1.x')!=pos['x'])
 test('Przeciąganie myśli i cofanie/ponawianie działa na płótnie',drag)
 def groupDrag():
    click('view','[data-view="map"]');page.wait_for_timeout(120);page.locator('[data-node-text="n1"]').click();page.locator('[data-node-text="n2"]').click(modifiers=['Shift']);check(len(ev('Flux.ui.selected'))==2);before=ev('[Flux.state.nodes.n1.x,Flux.state.nodes.n2.x]');box=page.locator('[data-node="n1"]').bounding_box();page.mouse.move(box['x']+60,box['y']+35);page.mouse.down();page.mouse.move(box['x']+110,box['y']+60,steps=6);page.mouse.up();after=ev('[Flux.state.nodes.n1.x,Flux.state.nodes.n2.x]');check(abs(after[0]-before[0])>20);check(abs((after[0]-before[0])-(after[1]-before[1]))<.1)
 test('Grupa wybrana Shift porusza obie myśli o ten sam wektor',groupDrag)
 def doubleEdit():
    click('view','[data-view="map"]');page.locator('[data-node-text="n1"]').dblclick(delay=100);check(page.locator('[data-node-text="n1"]').get_attribute('contenteditable')=='true');e=page.locator('[data-node-text="n1"]');e.fill('Kamera lokalna');e.press('Enter');check(ev('Flux.state.nodes.n1.text')=='Kamera lokalna');check(page.locator('[data-node="n1"] .node-text').evaluate('(e)=>getComputedStyle(e).borderStyle') in ['none','']);
 test('Dwuklik edytuje w miejscu z pojedynczą ramką',doubleEdit)
 def plus():
    click('view','[data-view="map"]');n=ev('Object.keys(Flux.state.messages).length');t=ev('Object.keys(Flux.state.tasks).length');ev("Flux.action('node-child',{dataset:{id:'n2'}})");e=page.locator('[contenteditable="true"][data-node-text]');e.fill('Zasięg czujnika');e.press('Enter');check(ev('Object.keys(Flux.state.messages).length')==n);check(ev('Object.keys(Flux.state.tasks).length')==t);check(ev('Object.keys(Flux.state.edges).length')==5)
 test('Plus dopisuje myśl i zwykłą linię, bez wiadomości i zadania',plus)
 def connect():
    messages=ev('Object.keys(Flux.state.messages).length');tasks=ev('Object.keys(Flux.state.tasks).length');click('view','[data-view="map"]');ev("Flux.action('connect-start',{dataset:{id:'n1'}})");page.locator('[data-node-text="n2"]').click();check(ev('Object.keys(Flux.state.edges).length')==5);check(ev('Object.keys(Flux.state.messages).length')==messages);check(ev('Object.keys(Flux.state.tasks).length')==tasks);check(page.locator('.edge-line').evaluate_all('(els)=>els.every(e=>getComputedStyle(e).strokeDasharray==="none")'))
 test('Połączenie istniejących myśli ma tę samą linię, bez skutków ubocznych',connect)
 def edgeComments():
    ev("Flux.openRef('edge:e1')");send('Czy ten wybór wymaga więcej zasilania?','.editor[data-key="entity:edge:e1"]');check(ev("!!Flux.state.anchors['edge:e1']"));check(ev("!Flux.state.anchors['node:n0']&&!Flux.state.anchors['node:n1']"))
 test('Komentarz do linii jest jednym wątkiem, nie scala końców',edgeComments)
 def outline():
    click('view','[data-view="map"]');n=ev('Object.keys(Flux.state.tasks).length');ev("Flux.action('paste-outline')");page.locator('#outline').fill('Urządzenie\n  Wejście\n    Gest\n  Wyjście');click('outline-save');check(ev('Object.keys(Flux.state.nodes).length')==11);check(ev('Object.keys(Flux.state.tasks).length')==n)
 test('Lista z wcięciami tworzy myśli i połączenia, nie backlog',outline)
 def pageHistory():
    click('view','[data-view="wiki"]');click('wiki-edit');page.locator('#wiki-source').fill('# Zmieniona strona\n\nNowy warunek.');click('wiki-save');check(ev('Flux.state.pages.w1.version')==2);ev("Flux.action('page-history',{dataset:{id:'w1'}})");click('page-restore','[data-version="1"]');check(ev('Flux.state.pages.w1.version')==3);check('Nie wysyłamy' in ev('Flux.state.pages.w1.content'))
 test('Wiki edytuje i przywraca wersje bez usuwania historii',pageHistory)
 def importMD():
    page.locator('#md-file').set_input_files({'name':'sample.md','mimeType':'text/markdown','buffer':b'# Test importu\n\n<script>window.pwned=1</script>\n\n**Czytelna wiedza**'});page.wait_for_timeout(100);check(page.locator('#wiki-content h1').inner_text()=='Test importu');check(ev('window.pwned') is None);check(page.locator('#wiki-content script').count()==0)
 test('Import Markdown działa, surowy HTML nie jest wykonywany',importMD)
 def stableWikiRef():
    ev("Flux.transact('test',()=>{Flux.createMessage({text:'[[page:w1]]'});Flux.savePage('w1','Nowa nazwa',Flux.state.pages.w1.content);})");check(page.locator('.messages [data-ref="page:w1"]').last.inner_text().endswith('Nowa nazwa'))
 test('Zmiana tytułu wiki nie zrywa odnośnika',stableWikiRef)
 def fragment():
    ev("Flux.openRef('fragment:f1')");check('Nie wysyłamy go do chmury.' in page.locator('.quote-preview').inner_text());check(ev("Flux.fragmentStatus(Flux.state.fragments.f1).ok"));ev("Flux.savePage('w1','Jak działa lampka', '# Inna treść')");check(not ev("Flux.fragmentStatus(Flux.state.fragments.f1).ok"));check(ev('Flux.state.fragments.f1.quote')=='Nie wysyłamy go do chmury.')
 test('Fragment zachowuje historyczny cytat i rozpoznaje zmianę źródła',fragment)
 def fragmentToTaskMap():
    ev("Flux.action('ref-task',{dataset:{ref:'fragment:f1'}})");page.locator('#reference-task').select_option('t2');click('reference-task-save');check('fragment:f1' in ev('Flux.state.tasks.t2.references'));ev("Flux.action('ref-map',{dataset:{ref:'fragment:f1'}})");click('reference-map-save');check(ev("Object.values(Flux.state.nodes).filter(n=>n.reference==='fragment:f1').length")==2);check(ev('Object.keys(Flux.state.pages).length')==3)
 test('Fragment w zadaniu i na mapie wskazuje jedno źródło, bez kopiowania wiki',fragmentToTaskMap)
 def taskUsesSource():
    ev("Flux.transact('test',()=>Flux.createMessage({text:'Sprawdź [[task:t1]]'}))");uses=ev("Flux.usageOf('task:t1')");check(any(u['ref'].startswith('message:') for u in uses));check(any(u['ref']=='page:w1' for u in uses));check(ev("Flux.activeBlockers('t1').length")==0)
 test('Zwykła wzmianka ma odnośnik zwrotny, nie zmienia zadania',taskUsesSource)
 def agent():
    send('/ai ułóż [[map:map1]]');page.wait_for_function('Object.keys(Flux.state.proposals).length===1');check(ev('Object.keys(Flux.state.proposals).length')==1);check(page.locator('.msg.ai').count()==0);# reply lives under request, not another top-level message
    mid=ev("Object.values(Flux.state.messages).find(m=>m.text.startsWith('/ai ułóż')).id");ev(f"Flux.action('comments',{{dataset:{{id:'{mid}'}}}})");check(page.locator('.msg.ai').count()==1);check('DEMO' in page.locator('.msg.ai').inner_text())
 test('/ai odpowiada jako odrębny agent, we właściwej odpowiedzi',agent)
 def layoutConflict():
    ev("Flux.transact('test',()=>Flux.runAI('/ai ułóż [[map:map1]]',null))");page.wait_for_function('Object.keys(Flux.state.proposals).length===1');pid=ev('Object.keys(Flux.state.proposals)[0]');ev("Flux.state.maps.map1.version++");check(ev(f"(()=>{{try{{Flux.applyProposal('{pid}');return false}}catch(e){{return true}}}})()"))
 test('Propozycja układu nie nadpisze zmienionej mapy',layoutConflict,'domain')
 def theme():
    click('settings');click('theme-set','[data-value="light"]');click('accent-set','[data-value="rose"]');check(page.locator('html').get_attribute('data-theme')=='light');check(page.locator('html').get_attribute('data-accent')=='rose');check(page.locator('input[type="color"]').count()==0);check(page.locator('.swatch').count()==9)
 test('Dwie bazy i dziewięć predefiniowanych akcentów, bez własnych kolorów',theme)
 def profile():
    click('settings');click('settings-tab','[data-value="data"]');page.locator('[data-change="demo-user"]').select_option('u3');check('Arduino + AI' not in page.locator('.sidebar').inner_text());click('search');page.locator('#global-search').fill('kamera');check('Brak wyników' in page.locator('#search-results').inner_text())
 test('Widok i wyszukiwanie Oli nie pokazują prywatnego Arduino',profile)
 def crossRef():
    n=ev('Object.keys(Flux.state.messages).length');send('To prywatne [[page:w3]]');check(ev('Object.keys(Flux.state.messages).length')==n);check('odbiorców' in page.locator('#toasts').inner_text());check('w3' in ev("Flux.prefs.drafts['chat:p1']"))
 test('Niedostępny odnośnik blokuje wysłanie i zachowuje szkic',crossRef)
 def createProject():
    click('new-project');page.locator('#project-name').fill('Własny eksperyment');page.locator('input[name="project-member"][value="u2"]').check();click('project-create');s=ev('Flux.state.spaces[Flux.ui.space]');check(s['members']==['u1','u2']);check(ev('Flux.state.spaces.p2.members.length')==4)
 test('Nowy projekt ma własne grono, nie dziedziczy ekipy',createProject)
 def dmPromote():
    click('space','[data-id="dm1"]');ev("Flux.action('promote-dm',{dataset:{id:'m8'}})");page.locator('#project-name').fill('Osobny szkic');click('project-create');s=ev('Flux.state.spaces[Flux.ui.space]');check(s['members']==['u1','u2']);check(ev("Object.values(Flux.state.messages).filter(m=>m.space===Flux.ui.space).length")==1);check(ev("Flux.state.messages.m8.space")=='dm1')
 test('Projekt z DM otrzymuje tylko wybraną wypowiedź, nie całą rozmowę',dmPromote)
 def reminder():
    ev("Flux.action('reminder',{dataset:{id:'t1'}})");page.locator('#date-input').fill(ev('Flux.day()'));click('reminder-save',':not([data-clear])');check(ev("Flux.state.notifications.some(n=>n.text.startsWith('Przypomnienie:')&&n.user==='u1')"))
 test('Osobiste przypomnienie pojawia się przy działającej aplikacji',reminder)
 def export():
    ev("Flux.action('workspace-transfer')")
    page.locator('.transfer-choice summary').click()
    with page.expect_download() as download:click('full-backup-export')
    f=download.value;path=ROOT/'tests/export-sample.json';f.save_as(str(path));data=json.loads(path.read_text());check(data['schema']==11);check(data['tasks']['t1']['source']=='m4');path.unlink()
 test('Eksport pobiera pełny JSON schematu 11',export)
 def badImport():
    page.locator('#json-file').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{"schema":8}'});page.wait_for_timeout(100);check('Import odrzucony' in page.locator('#toasts').inner_text());check(ev('Flux.state.schema')==11)
 test('Nieprawidłowy lub stary import nie nadpisuje danych',badImport)
 def attachment():
    key='chat:p1';ev(f"Flux.ui.attachmentTarget='{key}'");page.locator('#attachment-file').set_input_files({'name':'notatka.txt','mimeType':'text/plain','buffer':b'Wynik proby'});page.wait_for_timeout(80);send('Plik z obserwacją');check(ev("Object.values(Flux.state.messages).some(m=>m.text==='Plik z obserwacją'&&m.files.length===1)"))
 test('Załącznik zostaje przy jednej wysłanej wiadomości',attachment)
 def livePrivacy():
    click('live');check(ev('Flux.ui.live'));check(ev('Object.keys(Flux.ui.streams).length')==0);check(page.locator('.modal').count()==0);click('leave-live');check(not ev('Flux.ui.live'))
 test('Sesja lokalna nie włącza automatycznie mikrofonu, kamery ani ekranu',livePrivacy)
 def mobile():
    page.set_viewport_size({'width':390,'height':844});ev('Flux.render()');check(ev('document.documentElement.scrollWidth<=innerWidth'));click('view','[data-view="map"]');click('map-view','[data-value="list"]');check(page.locator('.outline-item').count()==5);ev("Flux.openRef('task:t1')");check(page.locator('.drawer').bounding_box()['width']<=391);check(ev('document.documentElement.scrollWidth<=innerWidth'))
 test('Telefon: rozmowa, lista mapy i pełny panel bez poziomego rozpychania',mobile)
 def keyboardModal():
    click('settings');page.keyboard.press('Escape');check(page.locator('.modal').count()==0);page.keyboard.press('Control+k');check(page.locator('#global-search').is_visible())
 test('Escape i wyszukiwanie z klawiatury działają',keyboardModal)

 def richTaskDescription():
    ev("Flux.action('task-edit',{dataset:{id:'t1'}})");e=page.locator('#edit-task-description');e.fill('Warunek: ');e.press('End');e.press_sequentially('@kamera');check(page.locator('.mention-menu').is_visible());e.press('Enter');check(e.locator('[data-ref]').count()==1);click('task-edit-save');check('[[' in ev('Flux.state.tasks.t1.description'))
 test('Opis zadania korzysta z tego samego @ i nie wysyła komentarza',richTaskDescription)
 def wikiAt():
    click('view','[data-view="wiki"]');click('wiki-edit');e=page.locator('#wiki-source');e.fill('# Wyniki\n\nZobacz ');e.press('Control+End');e.press_sequentially('@kamer');check(page.locator('.mention-menu').is_visible());e.press('Enter');check('[[' in e.input_value());click('wiki-save');check('[[' in ev('Flux.state.pages.w1.content'))
 test('Wiki Markdown ma podpowiedzi @ bez wymagania znajomości składni',wikiAt)
 def cancelBlocker():
    markExisting('blocker');page.locator('#effect-task').select_option('t1');click('effect-save');check(ev('Flux.activeBlockers("t1").length')==1);ev("Flux.action('unmark-message',{dataset:{id:'m5'}})");click('unmark-save');check(ev('Flux.activeBlockers("t1").length')==0);check(ev('!!Flux.state.messages.m5'));check(ev('Flux.state.tasks.t1.status')!='done')
 test('Cofnięcie omyłkowej blokady zostawia wiadomość i nie kończy zadania',cancelBlocker)
 def cancelResult():
    markExisting('result');page.locator('#effect-task').select_option('t1');click('effect-save');check(ev('Flux.state.tasks.t1.result')=='m5');ev("Flux.action('unmark-message',{dataset:{id:'m5'}})");click('unmark-save');check(ev('Flux.state.tasks.t1.result') is None);check(ev('!!Flux.state.messages.m5'))
 test('Cofnięcie oznaczenia wyniku nie usuwa wypowiedzi',cancelResult)
 def wikiDraft():
    click('view','[data-view="wiki"]');click('wiki-edit');page.locator('#wiki-source').fill('# Szkic jeszcze nieopublikowany');click('view','[data-view="chat"]');click('view','[data-view="wiki"]');click('wiki-edit');check(page.locator('#wiki-source').input_value()=='# Szkic jeszcze nieopublikowany');check(ev('Flux.state.pages.w1.content')!='# Szkic jeszcze nieopublikowany')
 test('Niezapisany szkic wiki wraca po nawigacji i nie zmienia źródła',wikiDraft)
 def noOrphanCapture():
    click('live');click('live-details');ev("window.__stopped=0;Flux.ui.streams.audio={getTracks:()=>[{stop:()=>window.__stopped++}]}");click('close-modal');check(ev('window.__stopped')==0);click('leave-live');check(ev('window.__stopped')==1);check(ev('Object.keys(Flux.ui.streams).length')==0)
 test('Zamknięcie panelu nie zrywa sesji; wyjście zatrzymuje przechwytywanie (atrapa)',noOrphanCapture,'media-double')
 # Persistence round-trip explicitly through a memory double and a fresh document.
 def storageRoundtrip():
    send('Próba odtworzenia danych');data=ev('window.__testStorage');q=context.new_page();q.evaluate(STORAGE_JS,data);q.set_content(HTML.read_text());check(q.evaluate("Object.values(Flux.state.messages).some(m=>m.text==='Próba odtworzenia danych')"));q.close()
 test('Serializacja i odtworzenie w nowym dokumencie (magazyn testowy)',storageRoundtrip,'storage-double')
 def noStorage():
    q=context.new_page();q.set_content(HTML.read_text());check(q.evaluate('Flux.state.schema')==11);q.evaluate("Flux.action('space',{dataset:{id:'p1'}})");q.locator('.editor').fill('Działa też bez magazynu');q.locator('.editor').press('Enter');check(q.evaluate("Object.values(Flux.state.messages).some(m=>m.text==='Działa też bez magazynu')"));check('Brak zapisu' in q.locator('.sidebar').inner_text());q.close()
 test('Brak dostępu do localStorage nie uniemożliwia pracy w pamięci',noStorage,'storage-unavailable')
 report={'app':'Flux Studio 11','environment':'Chromium / Playwright / set_content','html':HTML.name,'storage':'Explicit in-memory test double, except unavailable-storage case. Native file persistence NOT verified.','navigation':'file:// and HTTPS navigation blocked by environment policy. No policy changes made.','generatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'passed':sum(r['status']=='passed' for r in RESULTS),'failed':sum(r['status']=='failed' for r in RESULTS),'browserErrors':errors,'tests':RESULTS}
 (ROOT/'tests/regression-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print('RESULT',report['passed'],'passed,',report['failed'],'failed;',len(errors),'browser errors')
 browser.close()

if report["failed"] or report["browserErrors"]:
    raise SystemExit(1)
