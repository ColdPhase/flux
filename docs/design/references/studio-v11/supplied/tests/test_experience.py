from browser_support import launch
"""Flux Studio 11 integration contract tests. No LLM or remote media.
DOM runs on about:blank via set_content with an explicit storage double.
The denied HTTP smoke probe is separate; no browser policy bypass.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, time, traceback
ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'flux-studio-v11.html').read_text()
STORAGE="""seed=>{const d={...seed};window.__testStorage=d;Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>d[k]??null,setItem:(k,v)=>d[k]=String(v),removeItem:k=>delete d[k]}})}"""
results=[]
def check(v,msg='Assertion failed'):
 if not v: raise AssertionError(msg)
with sync_playwright() as p:
 browser=launch(p)
 ctx=browser.new_context(viewport={'width':1440,'height':1000})
 page=ctx.new_page();page.set_default_timeout(3000)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.evaluate(STORAGE,{});page.set_content(HTML);page.wait_for_timeout(50)
 def ev(s):return page.evaluate(s)
 def click(a,sel=''):page.locator(f'[data-action="{a}"]{sel}').first.click()
 def reset():
  page.evaluate("""()=>{document.activeElement?.blur();document.querySelector('#app').innerHTML='';Flux.reset();Flux.ui.availableSession=null;Flux.ui.agentContext=[];document.querySelector('#popover').innerHTML='';document.querySelector('#toasts').innerHTML='';} """)
  page.set_viewport_size({'width':1440,'height':1000})
 def test(name,f,category='interaction'):
  reset();before=len(errors);t=time.monotonic();print('TEST',len(results)+1,name,flush=True)
  try:
   f();check(len(errors)==before,'Uncaught error: '+str(errors[before:]));results.append({'name':name,'category':category,'status':'passed','seconds':round(time.monotonic()-t,3)})
  except Exception as e:
   results.append({'name':name,'category':category,'status':'failed','error':str(e),'seconds':round(time.monotonic()-t,3)})
   try:page.screenshot(path=str(ROOT/'screenshots'/f'exp-failure-{len(results):02}.png'))
   except:pass
   print('FAIL',name,str(e)[:280])
 def newBlock():
  return ev("(()=>{let m,id;Flux.transact('test',()=>{m=Flux.createMessage({text:'Potrzebuję dostępu do kamery',parent:'m6'});id=Flux.markBlocker(m.id,'t1','u2')});return {message:m.id,effect:id}})()")
 def result(text='Wynik testu: lokalna próba zakończona.'):
  return ev("""text=>{let m;Flux.transact('result.test',()=>{m=Flux.createMessage({text,parent:'m6'});Flux.setResult('t1',m.id)});return m.id}""" if False else "(()=>{let m;Flux.transact('result.test',()=>{m=Flux.createMessage({text:"+json.dumps(text)+",parent:'m6'});Flux.setResult('t1',m.id)});return m.id})()")
 def request(cmd):
  return ev("(()=>{let m;Flux.transact('agent.request',()=>m=Flux.runAI("+json.dumps(cmd)+",null));return m.id})()")
 def waitRun():page.wait_for_function("Object.values(Flux.state.agentRuns).some(r=>r.trigger==='command'&&r.state!=='running')")

 test('Skrót jest dostępny z rozmowy bez nowej zakładki',lambda:(check(page.locator('[data-action="return-open"]').count()==1),click('return-open'),check(page.locator('.review-drawer').is_visible()),check(page.locator('.tabs').inner_text().splitlines()==['Rozmowa','Mapa','Zadania','Wiki'])))
 def readSeparate():
  ev("Flux.action('navigate-home')");before=ev('JSON.stringify(Flux.prefs.read)');n=ev('Object.keys(Flux.state.messages).length');ev("Flux10.openReview('p1')");page.wait_for_timeout(150);check(ev('JSON.stringify(Flux.prefs.read)')==before,'Reading the brief marked chat as read');check(ev('Object.keys(Flux.state.messages).length')==n)
 test('Otwarcie skrótu nie czyta czatu ani nie publikuje wiadomości',readSeparate)
 def noMirror():
  r=result();b=ev("Flux10.brief('p1')");check(sum(c['ref']=='task:t1' for c in b['needs']+b['changes'])==1,'Same task duplicated');check(all(c['source'] is None or c['source'] in ev('Flux.state.messages') for c in b['changes']))
 test('Skrót grupuje jedną pracę, a nie kopie jej zdarzeń',noMirror)
 def staleBlock():
  x=newBlock();ev("Flux.transact('solve',()=>{let m=Flux.createMessage({text:'Dostęp gotowy',parent:'m6'});Flux.solveBlocker('"+x['effect']+"',m.id)})");b=ev("Flux10.brief('p1')");check(not any(c.get('effect')==x['effect'] for c in b['needs']));check(all(c['kind']!='blocker' for c in b['changes'] if c['ref']=='task:t1'))
 test('Rozwiązany blocker nie udaje aktualnej przeszkody po powrocie',staleBlock)
 def latestResult():
  a=result('Stary wynik testu');b=result('Nowszy wynik testu');ev("Flux.state.tasks.t1.due=null");br=ev("Flux10.brief('p1')");c=[x for x in br['changes'] if x['ref']=='task:t1'];check(len(c)==1);check(c[0]['source']==b);check(c[0]['text']=='Nowszy wynik testu')
 test('Dwa wyniki → jeden aktualny wynik ze źródłem',latestResult)
 def ackCut():
  ev("Flux10.openReview('p1')");cut=ev('Flux10.review.until');ev("Flux.transact('test',()=>Flux.createTask({title:'Nowa zmiana po otwarciu'}))");check(page.locator('.brief-update').is_visible());ev('Flux10.ackReview()');check(ev('Flux.prefs.review.p1.through')==cut);check(ev("Flux10.brief('p1').changes.some(c=>c.title==='Nowa zmiana po otwarciu')"))
 test('Mam kontekst nie połyka zmian, które przyszły podczas czytania',ackCut)
 def openNeedsSurvive():
  ev("Flux10.openReview('p1');Flux10.ackReview()");b=ev("Flux10.brief('p1')");check(any(c.get('effect')=='e10' for c in b['needs']));check(len(b['changes'])==0)
 test('Potrzebna pomoc pozostaje po zapoznaniu się ze skrótem',openNeedsSurvive)
 def frozenOrder():
  ev("Flux10.openReview('p1')");keys=page.locator('[data-brief-key]').evaluate_all('(els)=>els.map(x=>x.dataset.briefKey)');ev("Flux.transact('new',()=>Flux.createTask({title:'Nowe w trakcie'}))");check(page.locator('[data-brief-key]').evaluate_all('(els)=>els.map(x=>x.dataset.briefKey)')==keys);click('return-refresh');check('Nowe w trakcie' in page.locator('.review-drawer').inner_text())
 test('Nowe wydarzenie nie przestawia czytanego skrótu; jest odświeżenie',frozenOrder)
 def onlyAllowed():
  ev("Flux.ui.user='u3';Flux.action('space',{dataset:{id:'p2'}})");b=ev("Flux10.brief('p1')");check(not b['changes'] and not b['needs']);ev("Flux.action('navigate-home')");check('Arduino + AI' not in page.locator('body').inner_text())
 test('Osobisty powrót filtruje projekty bieżącego profilu',onlyAllowed)
 def sourceBack():
  ev("Flux10.openReview('p1')");click('brief-source');check(page.locator('[data-action="return-back"]').count()>=1 or ev('Flux.ui.drawer') is None)
  ev("Flux.action('return-back')");check(page.locator('.review-drawer').is_visible())
 test('Źródło prowadzi do wypowiedzi; można wrócić do tego samego skrótu',sourceBack)
 def noise():
  before=ev('Flux10.activity.length');ev("Flux.transact('chat.noise',()=>{for(let i=0;i<80;i++)Flux.createMessage({text:'Luźna rozmowa '+i})})");check(ev('Flux10.activity.length')==before);ev("Flux10.openReview('p1')");check('nie są tu uznawane' not in page.locator('.brief-intro').inner_text());check('nie stają się automatycznie decyzjami' in page.locator('.brief-coverage').inner_text().lower())
 test('80 zwykłych wiadomości nie produkuje 80 faktów ani domniemanych decyzji',noise)
 def aiNotNeeded():
  ev("Flux.state.spaces.p1.ai=false;Flux10.openReview('p1')");check(page.locator('.brief-card').count()>0)
 test('Powrót i konsekwencje oznaczeń działają bez AI',aiNotNeeded)

 def asyncReply():
  mid=request('/ai podsumuj');check(ev("Object.values(Flux.state.agentRuns).some(r=>r.state==='running')"));ev("Flux.action('comments',{dataset:{id:'"+mid+"'}})");check(page.locator('.msg.ai').is_visible());waitRun();r=ev("Object.values(Flux.state.agentRuns).find(r=>r.command==='"+mid+"')");check(ev("Flux.state.messages['"+r['response']+"'].author")=='ai');check(ev("Flux.state.messages['"+r['response']+"'].parent")==mid)
 test('Polecenie użytkownika i odpowiedź AI to osobne tożsamości w tym samym wątku',asyncReply)
 def draftSafe():
  request('/ai podsumuj');page.locator('.editor[data-key="chat:p1"]').fill('Jeszcze kończę własną myśl');waitRun();check(page.locator('.editor[data-key="chat:p1"]').inner_text()=='Jeszcze kończę własną myśl')
 test('Odpowiedź agenta nie gubi aktualnego szkicu',draftSafe)
 def cancel():
  request('/ai zadanie: Nie twórz tego po anulowaniu');rid=ev("Object.values(Flux.state.agentRuns).find(r=>r.state==='running').id");ev("Flux.action('agent-cancel',{dataset:{id:'"+rid+"'}})");page.wait_for_timeout(650);check(not ev("Object.values(Flux.state.proposals).some(p=>p.title?.includes('anulowaniu'))"));check(ev("Flux.state.agentRuns['"+rid+"'].state")=='cancelled')
 test('Anulowanie agenta przed końcem nie tworzy propozycji ani zadania',cancel)
 def scopeRun():
  mid=request('/ai zadanie: Krok tylko w Arduino');ev("Flux.action('space',{dataset:{id:'p2'}})");waitRun();prop=ev("Object.values(Flux.state.proposals).find(p=>p.title==='Krok tylko w Arduino')");check(prop['space']=='p1');check('Krok tylko w Arduino' not in page.locator('body').inner_text());check(ev('Flux.ui.space')=='p2')
 test('Agent kończy w pierwotnym projekcie, nie w aktualnie oglądanym',scopeRun)
 def disablePrompt():
  ev("Flux.state.spaces.p1.ai=false");e=page.locator('.editor');e.fill('/ai podsumuj');e.press('Enter');check(e.inner_text()=='/ai podsumuj');check(len(ev('Object.values(Flux.state.agentRuns)'))==0)
 test('Wyłączony agent zachowuje polecenie jako szkic zamiast udawać wykonanie',disablePrompt)
 def revoked():
  mid=request('/ai zadanie: Niedozwolone');ev("Flux.state.spaces.p1.members=['u2'];Flux.action('space',{dataset:{id:'p2'}})");page.wait_for_timeout(700);check(not ev("Object.values(Flux.state.proposals).some(p=>p.title==='Niedozwolone')"))
 test('Cofnięcie dostępu w trakcie wykonania zatrzymuje zmianę',revoked)
 def autoProposal():
  before=ev('Object.keys(Flux.state.messages).length');mid=result();props=ev("Object.values(Flux.state.proposals).filter(p=>p.kind==='wiki')");check(len(props)==1);check(ev("Object.values(Flux.state.messages).some(m=>m.author==='ai'&&m.agentTrigger==='Po zapisaniu wyniku')"));check(ev('Flux.state.pages.w1.version')==1);check(ev('Object.keys(Flux.state.messages).length')==before+2)
 test('Wynik uruchamia propozycję wiki bez /ai, nie zmienia dokumentu sam',autoProposal)
 def rejectNoSpam():
  mid=result();pid=ev('Object.keys(Flux.state.proposals)[0]');ev("Flux.action('proposal-dismiss',{dataset:{id:'"+pid+"'}})");ev("Flux.transact('repeat',()=>Flux.setResult('t1','"+mid+"'))");check(ev('Object.keys(Flux.state.proposals).length')==1)
 test('Odrzucona propozycja nie wraca dla tego samego wyniku',rejectNoSpam)
 def editedResultNewProposal():
  mid=result();ev("Flux.transact('edit',()=>{Flux.state.messages['"+mid+"'].text='Poprawiony wynik';Flux.state.messages['"+mid+"'].version++})");check(ev('Object.keys(Flux.state.proposals).length')==2)
 test('Nowa wersja wyniku pozwala przygotować aktualną propozycję',editedResultNewProposal)
 def noTargets():
  ev("Flux.state.tasks.t1.references=['page:w1','page:w2']");result();check(ev('Object.keys(Flux.state.proposals).length')==0)
 test('Agent nie zgaduje wiki przy kilku możliwych dokumentach',noTargets)
 def layoutPreview():
  request('/ai ułóż [[node:n1]] [[node:n3]]');waitRun();p1=ev('Object.values(Flux.state.proposals)[0]');check(len(p1['positions'])==2);before=ev('Flux.state.nodes.n2.x');ev("Flux.action('proposal-apply',{dataset:{id:'"+p1['id']+"'}})");check(ev('Flux.state.nodes.n2.x')==before);check(ev('Flux.state.nodes.n1.text')=='Kamera + rozpoznawanie gestu')
 test('Agent układa wyłącznie wskazane myśli, nie zmienia treści',layoutPreview)
 def staleProposal():
  result();pid=ev('Object.keys(Flux.state.proposals)[0]');ev("Flux.transact('wiki.edit',()=>Flux.state.pages.w1.version++)");check(ev("(()=>{try{Flux.applyProposal('"+pid+"');return false}catch(e){return true}})()"));check(ev("Flux.state.proposals['"+pid+"'].status")=='pending')
 test('Nieaktualna propozycja nie nadpisuje nowszej wiki',staleProposal)
 def applyOnceUndo():
  result();pid=ev('Object.keys(Flux.state.proposals)[0]');ev("Flux.action('proposal-apply',{dataset:{id:'"+pid+"'}})");v=ev('Flux.state.pages.w1.version');ev("Flux.action('proposal-apply',{dataset:{id:'"+pid+"'}})");check(ev('Flux.state.pages.w1.version')==v);ev("Flux.action('proposal-undo',{dataset:{id:'"+pid+"'}})");check('## Obserwacja z próby' not in ev('Flux.state.pages.w1.content'))
 test('Jedno zastosowanie i cofnięcie bez duplikatu',applyOnceUndo)
 def undoConflict():
  result();pid=ev('Object.keys(Flux.state.proposals)[0]');ev("Flux.action('proposal-apply',{dataset:{id:'"+pid+"'}})");ev("Flux.state.pages.w1.version++");check(ev("(()=>{try{Flux10.undoProposal('"+pid+"');return false}catch(e){return true}})()"))
 test('Cofnięcie nie kasuje późniejszej edycji człowieka',undoConflict)

 def startNoCapture():
  n=ev('Object.keys(Flux.state.messages).length');click('live');check(ev('!!Flux10.session'));check(ev('Object.keys(Flux.ui.streams).length')==0);check(ev('Object.keys(Flux.state.messages).length')==n);check(page.locator('.modal').count()==0)
 test('Zróbmy to razem: wejście jednym kliknięciem bez dzwonka, urządzeń i nowego czatu',startNoCapture)
 def keepSession():
  ev("Flux.openRef('task:t1')");click('live');sid=ev('Flux10.session.id');ev("Flux.action('view',{dataset:{view:'wiki'}})");check(ev('Flux10.session.id')==sid);check(ev('Flux10.session.origin')=='task:t1');check(ev('Flux10.session.shown')==['task:t1'])
 test('Zmiana zakładki nie kończy sesji ani nie podmienia pokazywanego materiału',keepSession)
 def nativeShare():
  click('live');click('view','[data-view="map"]');ev("Flux.ui.selected=['n1','n3'];Flux.render()");click('live-show-current');check(ev('Flux10.session.shown')==['node:n1','node:n3']);check(ev('Object.keys(Flux.ui.streams).length')==0)
 test('Pokazanie myśli nie jest przechwytywaniem ekranu',nativeShare)
 def otherProject():
  ev("Flux.openRef('task:t1')");click('live');ev("Flux.action('space',{dataset:{id:'p2'}})");ev("Flux.openRef('page:w3')");click('live-show-current');check(ev('Flux10.session.shown')==['task:t1']);check(ev('Flux10.session.space')=='p1');check('inny projekt' in page.locator('#toasts').inner_text())
 test('Nawigacja do innego projektu nie publikuje jego treści w sesji',otherProject)
 def invite():
  click('live');ev("Flux.action('live-invite',{dataset:{user:'u2'}})");ev("Flux.action('live-invite',{dataset:{user:'u2'}})");check(ev("Flux.state.notifications.filter(n=>n.kind==='live'&&n.user==='u2').length")==1);ev("Flux.action('live-invite',{dataset:{user:'u3'}})");check(ev("Flux.state.notifications.filter(n=>n.kind==='live'&&n.user==='u3').length")==0)
 test('Zaproszenie jest pojedynczym sygnałem tylko dla członka projektu',invite)
 def followConsent():
  click('live');click('view','[data-view="map"]');ev("Flux.action('live-demo-join');Flux.action('live-demo-show')");check(ev('Flux.ui.view')=='map');check(page.locator('.live-offer').is_visible());click('live-follow');check(ev('Flux.ui.view')=='wiki');check(ev('Flux10.session.following'));click('view','[data-view="tasks"]');check(not ev('Flux10.session.following'))
 test('Pokazanie przez kolegę jest propozycją; własna nawigacja kończy podążanie',followConsent)
 def silence():
  click('live');ev("window.stopped=0;Flux.ui.streams={audio:{getTracks:()=>[{stop:()=>window.stopped++}]},video:{getTracks:()=>[{stop:()=>window.stopped++}]},screen:{getTracks:()=>[{stop:()=>window.stopped++}]}};")
  click('live-silence');check(ev('window.stopped')==3);check(ev('Flux10.session.silent'));click('live-silence');check(not ev('Flux10.session.silent'));check(ev('Object.keys(Flux.ui.streams).length')==0)
 test('Cisza zatrzymuje wszystkie urządzenia; powrót niczego nie włącza',silence,'media-double')
 def latePermission():
  click('live');ev("""window.stopped=0;Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise(r=>window.__grant=r)}});Flux10.mediaToggle('audio');void 0;""");click('leave-live');ev("window.__grant({getTracks:()=>[{stop:()=>window.stopped++,addEventListener:()=>{}}]})");page.wait_for_timeout(60);check(ev('window.stopped')==1);check(ev('Object.keys(Flux.ui.streams).length')==0)
 test('Spóźniona zgoda na mikrofon po wyjściu natychmiast zatrzymuje strumień',latePermission,'media-double')
 def denyPermission():
  click('live');ev("Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getDisplayMedia:()=>Promise.reject(Object.assign(new Error('No'),{name:'NotAllowedError'}))}})");ev("Flux10.mediaToggle('screen')");page.wait_for_timeout(70);check(ev('Object.keys(Flux.ui.streams).length')==0);check('Dostęp nie został udzielony' in page.locator('#toasts').inner_text())
 test('Odmowa uprawnień nie udaje aktywnego screensharingu',denyPermission,'media-double')
 def noEmptyReport():
  n=ev('Object.keys(Flux.state.messages).length');click('live');click('leave-live');check(ev('Object.keys(Flux.state.messages).length')==n)
 test('Pusta sesja nie tworzy pustego podsumowania ani fałszywej transkrypcji',noEmptyReport)
 def actualReport():
  ev("Flux.openRef('task:t1')");click('live');result();click('leave-live');s=ev('Object.values(Flux.state.sessionsArchive)[0]');check(s['origin']=='task:t1');check(s['summary'] is not None);m=ev("Flux.state.messages['"+s['summary']+"']");check(m['parent']=='m6');check('bez nagrania i bez transkrypcji' in m['text']);check('task:t1' in m['text'])
 test('Efekty sesji wracają do istniejącej rozmowy zadania, bez nowego czatu',actualReport)
 def leavePeer():
  click('live');ev("Flux.action('live-demo-join')");sid=ev('Flux10.session.id');click('leave-live');check(ev('Flux.ui.availableSession.participants')==['u2']);click('live');check(ev('Flux10.session.id')==sid);check(ev('Object.keys(Flux.ui.streams).length')==0)
 test('Wyjście nie wyrzuca kolegi demo; ponowne wejście nadal bez urządzeń',leavePeer)
 def reloadNoSession():
  click('live');ev('Flux.persist()');state=ev('window.__testStorage');q=ctx.new_page();q.evaluate(STORAGE,state);q.set_content(HTML);check(q.evaluate('Flux10.session') is None);check(q.evaluate('Object.keys(Flux.ui.streams).length')==0);q.close()
 test('Odtworzenie danych nie uruchamia sesji ani urządzeń',reloadNoSession,'storage-double')
 def migration():
  check(ev("(()=>{let d=Flux.copy(Flux.state);d.schema=9;delete d.activity;delete d.agentRuns;delete d.sessionsArchive;const migrated=Flux.validateImport(d);return migrated.schema===11&&migrated.tasks.t1.source==='m4'&&Array.isArray(migrated.activity)})()"))
 test('Jawny import schematu 09 zachowuje materiały i inicjuje nowe sekcje',migration,'domain')
 def mobileBrief():
  page.set_viewport_size({'width':390,'height':844});ev("Flux10.openReview('p1')");check(ev('document.documentElement.scrollWidth<=innerWidth'));check(page.locator('.review-drawer').bounding_box()['width']<=390);check(page.locator('[data-action="return-ack"]').is_visible())
 test('Telefon: skrót jest czytelny i ma widoczne wyjście bez poziomego przewijania',mobileBrief)
 def mobileLive():
  page.set_viewport_size({'width':390,'height':844});click('live');ev("Flux.action('view',{dataset:{view:'map'}});Flux.action('map-view',{dataset:{value:'list'}})");check(page.locator('.live-dock').is_visible());check(ev('document.documentElement.scrollWidth<=innerWidth'));click('leave-live')
 test('Telefon: sesja trwa przy pracy bez rozpychania dokumentu',mobileLive)
 def staleAcceptedAnswer():
  ev("Flux10.openReview('p1')")
  ev("Flux.transact('answer.change',()=>{delete Flux.state.messages.r12.solution});Flux.render()")
  card=page.locator('[data-brief-key="message:r12"]')
  check('Ponownie otwarte' in card.inner_text());check('cofnięte' in card.inner_text())
 test('Otwarty skrót nie podaje wycofanego rozwiązania jako aktualnego',staleAcceptedAnswer)
 def sourceCommandEdited():
  request('/ai zadanie: Sprawdź jedno urządzenie');waitRun()
  pid=ev('Object.keys(Flux.state.proposals)[0]')
  ev("Flux.state.messages[Flux.state.proposals['"+pid+"'].source].version++")
  check(ev("(()=>{try{Flux.applyProposal('"+pid+"');return false}catch(e){return true}})()"))
 test('Edycja polecenia unieważnia starą propozycję nowego zadania',sourceCommandEdited)
 def briefRootBack():
  ev("Flux10.openReview('p1')")
  ev("Flux.action('brief-source',{dataset:{id:'r10'}})")
  check(page.locator('[data-action="return-open"]').count()==1)
  click('return-open');check(page.locator('.review-drawer').is_visible())
 test('Z dokładnej wiadomości źródła można wrócić do zachowanego skrótu',briefRootBack)
 report={'app':'Flux Studio 11','suite':'return-agent-live','passed':sum(t['status']=='passed' for t in results),'failed':sum(t['status']=='failed' for t in results),'browserErrors':errors,'storage':'Explicit in-memory double. Native persistence NOT verified.','media':'Stream lifecycle doubles only. No physical device or remote transmission test.','tests':results}
 (ROOT/'tests/experience-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print('RESULT',report['passed'],'passed',report['failed'],'failed',len(errors),'browser errors')
 browser.close()

if report["failed"] or report["browserErrors"]:
    raise SystemExit(1)
