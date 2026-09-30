"""Flux 11 focused interaction, privacy, import and layout checks.
Real Chromium DOM; explicit memory storage. No real LLM, media transport or server ACL.
"""
from pathlib import Path
import json, time
from playwright.sync_api import sync_playwright
from browser_support import launch
ROOT=Path(__file__).resolve().parents[1]
HTML=ROOT/'flux-studio-v11.html'
STORAGE="""seed=>{const d={...seed};window.__testStorage=d;Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>d[k]??null,setItem:(k,v)=>d[k]=String(v),removeItem:k=>delete d[k]}})}"""
results=[]; errors=[]
def check(value, message='Assertion failed'):
    if not value: raise AssertionError(message)
with sync_playwright() as p:
    browser=launch(p); context=browser.new_context(viewport={'width':1440,'height':940},accept_downloads=True)
    page=context.new_page();page.set_default_timeout(4000);page.evaluate(STORAGE,{})
    page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(HTML.read_text())
    def ev(s,arg=None):return page.evaluate(s,arg)
    def act(a,**d):return ev('([a,d])=>Flux.action(a,{dataset:d})',[a,d])
    def click(a,s=''):page.locator('[data-action="'+a+'"]'+s).first.click()
    def view(v):act('view',view=v)
    def reset():
        ev("()=>{document.activeElement?.blur();document.querySelector('#app').innerHTML='';Flux.reset();document.querySelector('#popover').innerHTML='';document.querySelector('#toasts').innerHTML='';}")
        page.set_viewport_size({'width':1440,'height':940})
    def test(name,f,category='interaction'):
        reset();start=time.monotonic();before=len(errors)
        try:
            f();check(len(errors)==before,'Browser error: '+str(errors[before:]));results.append({'name':name,'category':category,'status':'passed','seconds':round(time.monotonic()-start,3)})
        except Exception as e:
            results.append({'name':name,'category':category,'status':'failed','error':str(e),'seconds':round(time.monotonic()-start,3)})
            page.screenshot(path=str(ROOT/'screenshots'/('refinement-failure-'+str(len(results))+'.png')))
            print('FAIL',len(results),name,str(e)[:300],flush=True)
    def private():
        click('return-open');click('private-summary');page.wait_for_timeout(360)
    def state_counts():return ev('({messages:Object.keys(Flux.state.messages).length,runs:Object.keys(Flux.state.agentRuns).length,notifications:Flux.state.notifications.length,audit:Flux.state.audit.length})')
    def summary_privacy():
        before=state_counts();private();check(state_counts()==before);check(page.locator('.private-summary-result').is_visible());check(ev('!!Flux.prefs.privateBriefs.p1'));check(ev('!Flux.state.prefs.u2.privateBriefs?.p1'))
    test('Podsumowanie zapisuje się wyłącznie prywatnie; nie dodaje wiadomości, audytu, powiadomień ani wykonań wspólnego agenta',summary_privacy)
    def ai_top():
        click('return-open');a=page.locator('[data-action=private-summary]').bounding_box();b=page.locator('.brief-section').first.bounding_box();check(a['y']<b['y']);check(a['y']<page.viewport_size['height']-100)
    test('Akcja podsumowania jest nad zmianami i widoczna bez przewijania',ai_top)
    def scope():
        now=ev('new Date().toISOString()');ev("at=>{Flux.state.messages.foreign={...Flux.state.messages.m1,id:'foreign',author:'u2',parent:null,text:'Osobny temat: obudowa',primary:null,at};}",now)
        a=ev("Flux11.buildPrivateBrief('p1',null,new Date(Date.now()+1000).toISOString(),'project')")
        b=ev("Flux11.buildPrivateBrief('p1',null,new Date(Date.now()+1000).toISOString(),'mine')")
        check(a['messageCount']>b['messageCount']);check(any(g['root']=='foreign' for g in a['groups']));check(not any(g['root']=='foreign' for g in b['groups']))
    test('Cały projekt obejmuje także rozmowy niezwiązane ze mną; Dotyczy mnie ma węższy zakres',scope)
    def since():
        ev("()=>{Flux11.finishVisit();Flux.prefs.visits.p1={at:'2026-09-28T09:00:00.000Z',through:5};Flux11.beginVisit('p1');}")
        click('return-open');check(ev('Flux.ui.review.baselineAt')=='2026-09-28T09:00:00.000Z');check(ev('Flux.ui.review.from')==5)
    test('Początek skrótu wynika z ostatniej wizyty, nie sztywnego tygodnia',since)
    def first_visit():
        ev("()=>{Flux11.finishVisit();delete Flux.prefs.visits.p1;delete Flux.prefs.review.p1;Flux11.beginVisit('p1');}")
        click('return-open');check(ev('Flux.ui.review.from')==0);check(ev('Flux.ui.review.baselineAt') is None)
    test('Pierwsza wizyta ma jawny zakres od początku projektu',first_visit)
    def presence():
        old=ev('Flux.prefs.visits.p1?.at');page.wait_for_timeout(20);act('navigate-home');check(ev('Flux11.visit') is None);saved=ev('Flux.prefs.visits.p1.at');check(saved!=old);act('space',id='p1');check(ev("Flux11.reviewCursor('p1').at")==saved)
    test('Wyjście do U mnie zapisuje wizytę; ponowne wejście używa tego momentu',presence)
    def ack():
        click('return-open');read=ev('JSON.stringify(Flux.prefs.read)');messages=ev('Object.keys(Flux.state.messages).length');click('return-ack');check(ev('JSON.stringify(Flux.prefs.read)')==read);check(ev('Object.keys(Flux.state.messages).length')==messages)
    test('Mam kontekst nie czyści przeczytania czatu ani nie publikuje wiadomości',ack)
    def period():
        click('return-open');click('summary-period');click('summary-relative','[data-hours="24"]');chosen=page.locator('#summary-since').input_value();check(bool(chosen));click('summary-since-save');check(ev('Flux.ui.review.custom') is True)
    test('Użytkownik może jawnie zmienić przedział podsumowania',period)
    def future():
        click('return-open');click('summary-period');page.locator('#summary-since').fill('2099-01-01T12:00');click('summary-since-save');check(page.locator('#summary-since').is_visible());check('przeszłości' in page.locator('#toasts').inner_text())
    test('Przyszły zakres podsumowania jest odrzucany',future)
    def scope_race():
        click('return-open');click('private-summary');click('summary-scope','[data-value=mine]');page.wait_for_timeout(380);check(ev('Flux.ui.review.privateResult') is None);check(ev('Flux.ui.review.scope')=='mine')
    test('Spóźniony skrót poprzedniego zakresu nie nadpisuje nowego wyboru',scope_race)
    def user_race():
        click('return-open');click('private-summary');act('settings');act('settings-tab',value='data');page.locator('[data-change=demo-user]').select_option('u3');page.wait_for_timeout(360);check(ev('Flux.ui.user')=='u3');check(ev('!Flux.prefs.privateBriefs?.p1'));check(ev('!Flux.state.spaces.p1.members.includes(Flux.ui.user)'))
    test('Zmiana profilu przerywa prywatne podsumowanie poprzedniego użytkownika',user_race)
    def keepdraft():
        e=page.locator('.editor[data-key="chat:p1"]');e.fill('Mój jeszcze niewysłany tekst');private();click('close-drawer');check(e.inner_text()=='Mój jeszcze niewysłany tekst')
    test('Generowanie prywatnego skrótu zachowuje szkic czatu',keepdraft)
    def header():
        check(page.locator('.focus-strip').count()==0);check(page.locator('.return-strip').count()==0);check(page.locator('.head-controls [data-action=agent-panel]').count()==1);check(page.locator('.tabs-row [data-action=agent-panel]').count()==0)
    test('Brak dużego efektu i dodatkowego paska; jeden przycisk agenta w nagłówku',header)
    def stable_button():
        a=page.locator('.catchup-button').bounding_box();private();act('brief-source',id='m4');b=page.locator('.catchup-button').bounding_box();check(abs(a['x']-b['x'])<1 and abs(a['y']-b['y'])<1);click('return-open');check(page.locator('.private-summary-result').is_visible())
    test('Co ważne nie przeskakuje po otwarciu źródła, a prywatny skrót wraca',stable_button)
    def goal():
        count=ev('Object.keys(Flux.state.tasks).length');click('goal-open');page.locator('#goal-title').fill('Jedna działająca lampka');page.locator('#goal-criteria').fill('Gest włącza diodę przy zgaszonym świetle');page.locator('.goal-tasks summary').click();page.locator('[name=goal-task][value=t1]').check();click('goal-save');check(ev('Flux.state.spaces.p1.goalInfo.criteria').startswith('Gest'));check(ev('Flux.state.spaces.p1.goalInfo.taskIds')==['t1']);check(ev('Object.keys(Flux.state.tasks).length')==count);check(page.locator('.goal-chip').bounding_box()['height']<35)
    test('Zwijany cel ma kryterium i wskazanie istniejących zadań bez produkowania backlogu',goal)
    def human_goal():
        ev("()=>{Flux.state.spaces.p1.goalInfo.taskIds=['t1'];Flux.state.tasks.t1.status='done';}");click('goal-open');check(ev('Flux.state.spaces.p1.goalInfo.status')=='active');click('goal-achieve');check(ev('Flux.state.spaces.p1.goalInfo.status')=='achieved')
    test('Ukończenie tasków nie potwierdza celu bez decyzji człowieka',human_goal)
    def history_goal():
        click('goal-open');page.locator('#goal-title').fill('Nowy kierunek');click('goal-save');check(ev('Flux.state.spaces.p1.goalInfo.history.length')>0);check('Nowy kierunek' in page.locator('.goal-chip').inner_text())
    test('Zmiana celu zachowuje poprzedni kierunek w historii',history_goal)
    def effort(v,u,expected):
        due=ev('Flux.state.tasks.t1.due');plan=ev('JSON.stringify(Flux.prefs.plan)');act('task-estimate',id='t1');page.locator('#effort-value').fill(str(v));page.locator('#effort-unit').select_option(u);click('effort-save');check(ev('Flux11.effortLabel(Flux.state.tasks.t1)')==expected);check(ev('Flux.state.tasks.t1.due')==due);check(ev('JSON.stringify(Flux.prefs.plan)')==plan);ev("Flux.openRef('task:t1')");check(expected in page.locator('[data-action=task-estimate]').inner_text())
    test('Nakład 2 dni zachowuje jednostkę w karcie i szczegółach bez zmiany terminu',lambda:effort(2,'day','2 dni'))
    test('Nakład 1 tydzień nie staje się datą ukończenia ani 40 h w UI',lambda:effort(1,'week','1 tydzień'))
    test('Nakład ułamkowy 1,5 h jest obsługiwany',lambda:effort(1.5,'hour','1,5 h'))
    def invalid_effort():
        before=ev('Flux.state.tasks.t1.estimate');act('task-estimate',id='t1');page.locator('#effort-value').fill('-2');click('effort-save');check(page.locator('#effort-value').is_visible());check(ev('Flux.state.tasks.t1.estimate')==before)
    test('Ujemny nakład nie zmienia zadania',invalid_effort)
    def tasksearch():
        view('tasks');page.locator('#search-tasks').fill('slabym');check(page.locator('.task-card').count()==1);check(page.locator('.task-card').get_attribute('data-task')=='t1');page.locator('#search-tasks').fill('nic-xxxyyy');check(page.locator('.task-card').count()==0);click('clear-search');check(page.locator('.task-card').count()>0)
    test('Wyszukiwanie tasków jest lokalne, ignoruje polskie znaki i ma czyszczenie',tasksearch)
    def task_otherboard():
        ev("()=>{Flux.state.boards.other={id:'other',space:'p1',title:'Sprzęt'};Flux.state.tasks.t1.board='other';}");view('tasks');page.locator('#search-tasks').fill('kamer');click('search-all-boards');check(page.locator('[data-task=t1]').count()==1)
    test('Wynik można odnaleźć również w innej tablicy projektu',task_otherboard)
    def task_result_search():
        ev("()=>{Flux.state.tasks.t1.result='m4';Flux.state.messages.m4.text='unikalny-pomiar-zasilania';}");view('tasks');page.locator('#search-tasks').fill('unikalny-pomiar');check(page.locator('[data-task=t1]').count()==1)
    test('Wyszukiwanie zadań uwzględnia zapisany wynik',task_result_search)
    def mapsearch():
        view('map');page.locator('#search-map').fill('ciemnym');check(page.locator('.map-search-results [data-id=n3]').count()==1);click('search-map-open','[data-id=n3]');check(ev('Flux.ui.selected')==['n3']);check(page.locator('.map-search-results').count()==0)
    test('Wyszukiwanie mapy otwiera dokładną myśl i ustawia zaznaczenie',mapsearch)
    def mapother():
        ev("()=>{Flux.state.maps.mtwo={id:'mtwo',space:'p1',title:'Druga mapa'};Flux.state.nodes.ntwo={...Flux.state.nodes.n1,id:'ntwo',map:'mtwo',text:'Unikalny rezonator'};}");view('map');page.locator('#search-map').fill('rezonator');click('search-map-open','[data-id=ntwo]');check(ev('Flux.ui.map')=='mtwo');check(ev('Flux.ui.selected')==['ntwo'])
    test('Wyszukiwanie map obejmuje wszystkie mapy bieżącego projektu',mapother)
    def wiki_search():
        view('wiki');page.locator('#search-wiki').fill('chmury');check(page.locator('.wiki-page-item').count()>=1);check(page.locator('.wiki-page-item small').count()>=1);page.locator('.wiki-page-item').first.click();page.wait_for_timeout(50);check(page.locator('#wiki-content mark').count()==1)
    test('Wiki wyszukuje treść i otwiera podświetlony fragment',wiki_search)
    def wiki_private():
        ev("()=>{Flux.state.pages.hiddenpage={...Flux.state.pages.w1,id:'hiddenpage',space:'p2',title:'TAJNE-X-HHH',content:'TAJNE-X-HHH'};}");view('wiki');page.locator('#search-wiki').fill('TAJNE-X-HHH');check(page.locator('.wiki-page-item').count()==0)
    test('Wyniki lokalnego wyszukiwania wiki nie przenikają z innego projektu',wiki_private,'scope-model')
    def draftwiki():
        view('wiki');click('wiki-edit');page.locator('#wiki-source').fill('# Niezapisany szkic');page.locator('#search-wiki').fill('chmury');click('clear-search');check(page.locator('#wiki-source').input_value()=='# Niezapisany szkic');check(ev('Flux.state.pages.w1.content')!='# Niezapisany szkic')
    test('Wyszukiwanie wiki nie gubi niezapisanego szkicu',draftwiki)
    def share_child():
        view('map');ev("Flux.openRef('node:n1')");act('node-child',id='n1');child=ev('Flux.ui.selected[0]');e=page.locator('[data-node-text="'+child+'"]');e.fill('Nowy pomysł dziecka');e.press('Enter');act('share',ref='node:'+child);check(ev('Flux.ui.pendingShares["chat:p1"]')=='node:'+child);click('send','[data-key="chat:p1"]');check(ev('Object.values(Flux.state.messages).at(-1).primary')=='node:'+child);check(ev('Flux.state.nodes.'+child+'.outlineParent')=='n1')
    test('Regresja: Do rozmowy z nowej gałęzi wskazuje dziecko nawet po otwarciu panelu rodzica',share_child)
    def share_siblings():
        act('share',ref='node:n1');click('send','[data-key="chat:p1"]');act('share',ref='node:n3');check(ev('Flux.ui.pendingShares["chat:p1"]')=='node:n3')
    test('Rozmowa rodzica nie przejmuje udostępnienia innego dziecka',share_siblings)
    def outline():
        view('map');act('map-view',value='list');check(page.locator('[data-outline-node=n1] > ul > [data-outline-node=n3]').count()==1);check(page.locator('.outline-item').count()==5);click('outline-toggle','[data-id=n1]');check(page.locator('[data-outline-node=n3]').count()==0);click('outline-expand');check(page.locator('[data-outline-node=n3]').count()==1)
    test('Lista mapy ma rzeczywiste gałęzie i zwijanie bez usuwania myśli',outline)
    def cross_cycle():
        ev("()=>{Flux.state.edges.loop={id:'loop',space:'p1',map:'map1',a:'n3',b:'n2',kind:'related'};Flux.state.edges.loop.map=Flux.state.nodes.n3.map;}");view('map');act('map-view',value='list');o=ev('Flux11.buildOutline(Flux.ui.map)');check(len(o['cross'])>=1);check(page.locator('.outline-item').count()==5);check(page.locator('.outline-cross').count()>=1)
    test('Cykl/połączenie boczne jest widoczne bez duplikacji myśli w liście',cross_cycle)
    def no_selfcycle():
        ev("()=>{Flux.state.nodes.n1.outlineParent='n3';Flux.state.nodes.n3.outlineParent='n1';}");o=ev('Flux11.buildOutline(Flux.ui.map)');check(len(o['depth'])==5)
    test('Cykliczne wskazanie rodzica nie zapętla listy',no_selfcycle)
    def keyboardtree():
        view('map');act('map-view',value='list');page.locator('[data-outline-open=n1]').focus();page.keyboard.press('ArrowLeft');page.wait_for_timeout(60);check(ev('Flux.ui.outlineCollapsed.n1') is True);page.keyboard.press('ArrowRight');page.wait_for_timeout(60);check(ev('Flux.ui.outlineCollapsed.n1') is False)
    test('Lista gałęzi wspiera rozwijanie i zwijanie z klawiatury',keyboardtree)
    def ai_bubble():
        ev("()=>{Flux.state.messages.aidemo={...Flux.state.messages.m1,id:'aidemo',author:'ai',text:'Zwykła odpowiedź agenta',parent:null,at:new Date().toISOString(),primary:null};Flux.render();}")
        styles=ev("()=>['[data-message=aidemo] .bubble','[data-message=m3] .bubble'].map(s=>{const x=getComputedStyle(document.querySelector(s));return [x.padding,x.borderRadius,x.borderColor,x.backgroundColor,x.boxShadow]})")
        check(styles[0]==styles[1],str(styles));check('AI' in page.locator('[data-message=aidemo]').inner_text() or page.locator('[data-message=aidemo] .avatar').count())
    test('Wiadomość AI dziedziczy tę samą geometrię, tło i ramkę co cudza wiadomość człowieka',ai_bubble)
    def palettes():
        click('settings');act('settings-tab',value='appearance');check(page.locator('.swatch').count()==9);old=ev('Flux.prefs.accent');act('accent-set',value='custom-red');check(ev('Flux.prefs.accent')==old);act('accent-set',value='teal');check(ev('Flux.prefs.accent')=='teal');check(page.locator('input[type=color]').count()==0)
    test('Dziewięć zamkniętych akcentów, brak własnego selektora i odrzucanie nieznanej palety',palettes)
    def archive_shape():
        ev("()=>{Flux.prefs.privateBriefs.p1={secret:'prywatny-skrót-uniq'};Flux.prefs.notes.t1='notatka-prywatna-uniq';Flux.prefs.drafts.x='szkic-prywatny-uniq';}");a=ev('Flux11.exportWorkspace()');raw=json.dumps(a,ensure_ascii=False);check(len(a['data']['spaces'])==1);check(not a['data']['prefs']);check('prywatny-skrót-uniq' not in raw and 'notatka-prywatna-uniq' not in raw and 'szkic-prywatny-uniq' not in raw);check(a['data']['messages']['m4']['author']=='u1')
    test('Eksport projektu zawiera treść i autorstwo, ale nie osobiste notatki, szkice i skróty',archive_shape,'archive')
    def archive_roundtrip():
        a=ev('Flux11.exportWorkspace()');before=ev('JSON.stringify(Flux.state.spaces.p2)');new=ev('a=>Flux11.importWorkspace(a)',a);check(new!='p1');check(ev('JSON.stringify(Flux.state.spaces.p2)')==before);counts=ev('s=>["messages","nodes","edges","tasks","pages"].map(k=>Object.values(Flux.state[k]).filter(x=>x.space===s).length)',new);check(counts==[len(a['data'][k]) for k in ['messages','nodes','edges','tasks','pages']]);check(ev('s=>Flux.state.spaces[s].ai',new) is False)
    test('Import tworzy nowy projekt bez nadpisywania pozostałych i zachowuje liczby materiałów',archive_roundtrip,'archive')
    def archive_links():
        a=ev('Flux11.exportWorkspace()');new=ev('a=>Flux11.importWorkspace(a)',a);ev('Flux11.validateDeepArchive(Flux.state)');check(ev("s=>Object.values(Flux.state.tasks).filter(t=>t.space===s).every(t=>t.source?Flux.state.messages[t.source]?.space===s:true)",new));check(ev("s=>Object.values(Flux.state.tasks).filter(t=>t.space===s).every(t=>t.nodeIds.every(id=>Flux.state.nodes[id]?.space===s))",new));check(ev("s=>Object.values(Flux.state.messages).filter(m=>m.space===s).every(m=>!m.parent||Flux.state.messages[m.parent]?.space===s)",new))
    test('Nowe identyfikatory w imporcie zachowują źródła zadań, gałęzie i odpowiedzi',archive_links,'archive')
    def archive_authors():
        a=ev('Flux11.exportWorkspace()');new=ev('a=>Flux11.importWorkspace(a)',a);users=ev('s=>Flux.state.spaces[s].members',new);check('u2' not in users);check(len([u for u in users if u!='u1'])>=2);check(ev('s=>Object.values(Flux.state.messages).filter(m=>m.space===s&&m.author!=="ai").every(m=>Flux.state.users[m.author].historical)',new));act('settings');act('settings-tab',value='data');check(page.locator('[data-action=demo-user]').count()<=4)
    test('Import nie scala osób po imieniu; historyczni autorzy nie są nowymi kontami logowania',archive_authors,'archive')
    def archive_identity():
        a=ev('Flux11.exportWorkspace()');new=ev('a=>Flux11.importWorkspace(a,"u1")',a);check(ev('s=>Object.values(Flux.state.messages).some(m=>m.space===s&&m.author==="u1"&&m.text.includes("Sprawdzę to"))',new))
    test('Jawne przypisanie własnego profilu zachowuje autorstwo zgodnie z wyborem',archive_identity,'archive')
    def duplicate():
        a=ev('Flux11.exportWorkspace()');ev('a=>Flux11.importWorkspace(a)',a);count=ev('Object.keys(Flux.state.spaces).length');msg=ev('a=>{try{Flux11.importWorkspace(a);return ""}catch(e){return e.message}}',a);check('już zaimportowany' in msg);check(ev('Object.keys(Flux.state.spaces).length')==count)
    test('Ponowny import tego samego archiwum nie tworzy drugiej kopii',duplicate,'archive')
    def reject(which):
        a=ev('Flux11.exportWorkspace()')
        if which=='edge':a['data']['edges'][next(iter(a['data']['edges']))]['b']='missing'
        if which=='private':a['data']['prefs']['intruder']={'notes':{'x':'secret'}}
        if which=='prototype':a['data']['__proto__']={'polluted':True}
        if which=='history':a['data']['activity']={'not':'an array'}
        count=ev('Object.keys(Flux.state.spaces).length');msg=ev('raw=>{try{Flux11.importWorkspace(JSON.parse(raw));return ""}catch(e){return e.message}}',json.dumps(a));check(bool(msg));check(ev('Object.keys(Flux.state.spaces).length')==count);check(ev('({}).polluted') is None)
    for kind,title in [('edge','uszkodzone połączenie'),('private','cudze preferencje'),('prototype','prototype pollution'),('history','błędną historię')]:
        test('Import odrzuca '+title+' przed zmianą danych',lambda k=kind:reject(k),'archive-negative')
    def archive_rollback():
        a=ev('Flux11.exportWorkspace()');before=ev('Object.keys(Flux.state.spaces).length');ev("()=>{window.__origSet=localStorage.setItem;localStorage.setItem=()=>{throw Error('QuotaExceeded')};}");msg=ev('a=>{try{Flux11.importWorkspace(a);return ""}catch(e){return e.message}}',a);ev('()=>{localStorage.setItem=window.__origSet}');check(bool(msg));check(ev('Object.keys(Flux.state.spaces).length')==before)
    test('Błąd zapisu wycofuje import zamiast pozostawić częściowy projekt',archive_rollback,'storage-double')
    def archive_download():
        act('workspace-transfer');with_download=None
        with page.expect_download() as info:click('workspace-export')
        path=ROOT/'tests/download-workspace.json';info.value.save_as(str(path));a=json.loads(path.read_text());path.unlink();check(a['format']=='flux.workspace');check(not a['data']['prefs'])
    test('Przycisk eksportu pobiera rzeczywisty plik archiwum projektu',archive_download,'download')
    def file_import():
        a=ev('Flux11.exportWorkspace()');page.locator('#json-file').set_input_files({'name':'project.json','mimeType':'application/json','buffer':json.dumps(a).encode()});check(page.locator('#import-identity').is_visible());before=ev('Object.keys(Flux.state.spaces).length');click('workspace-import-apply');check(ev('Object.keys(Flux.state.spaces).length')==before);page.locator('#import-trust').check();click('workspace-import-apply');check(ev('Object.keys(Flux.state.spaces).length')==before+1)
    test('Import pliku ma podgląd, wybór tożsamości i świadome potwierdzenie',file_import,'upload')
    def storage_brief():
        private();ev('Flux11.touchVisit()');store=ev('window.__testStorage');q=context.new_page();q.evaluate(STORAGE,store);q.set_content(HTML.read_text());check(q.evaluate('!!Flux.state.prefs.u1.privateBriefs.p1'));check(q.evaluate('!!Flux.state.prefs.u1.visits.p1.at'));q.close()
    test('Wizyty i prywatne skróty przechodzą serializację do nowego dokumentu',storage_brief,'storage-double')
    def responsive(width,mode):
        page.set_viewport_size({'width':width,'height':850});view(mode);page.wait_for_timeout(80);check(ev('document.documentElement.scrollWidth<=innerWidth+1'),'Global horizontal overflow')
        if mode=='tasks':
            cols=page.locator('.column').all();check(all(x.bounding_box()['width']>=255 for x in cols));check(ev("document.querySelector('.board').scrollWidth>document.querySelector('.board').clientWidth") if width<900 else True)
        if mode=='wiki':check(page.locator('#search-wiki').is_visible())
        if mode=='map':check(page.locator('#search-map').is_visible())
    for width,mode in [(390,'tasks'),(760,'tasks'),(1100,'tasks'),(390,'wiki'),(390,'map'),(760,'chat')]:
        test(f'Responsywność {width}px: {mode} nie rozpycha strony, kontrolki pozostają dostępne',lambda w=width,m=mode:responsive(w,m),'layout')
    def mobilebrief():
        page.set_viewport_size({'width':390,'height':844});private();b=page.locator('[data-action=private-summary]').bounding_box();check(b['x']>=0 and b['x']+b['width']<=391);check(b['y']<844);check(ev('document.documentElement.scrollWidth<=innerWidth+1'))
    test('Prywatne podsumowanie na telefonie ma widoczną akcję na górze i brak globalnego overflow',mobilebrief,'layout')
    def sidebar():
        page.set_viewport_size({'width':390,'height':844});click('toggle-sidebar');b=page.locator('.search-launch').bounding_box();check(b['width']<=page.locator('.sidebar').bounding_box()['width']);page.locator('.search-launch').click();check(page.locator('#global-search').is_visible());check(page.locator('.modal').bounding_box()['width']<=390)
    test('Znajdź we Fluxie i globalne wyszukiwanie mieszczą się na telefonie',sidebar,'layout')
    report={'app':'Flux Studio 11','suite':'refinement','environment':'Chromium / Playwright / set_content; explicit memory storage, no server or real LLM', 'generatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'passed':sum(x['status']=='passed' for x in results),'failed':sum(x['status']=='failed' for x in results),'browserErrors':errors,'tests':results}
    (ROOT/'tests/refinement-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print('RESULT',report['passed'],'passed',report['failed'],'failed',len(errors),'browser errors',flush=True);browser.close()
if report['failed'] or errors:raise SystemExit(1)
