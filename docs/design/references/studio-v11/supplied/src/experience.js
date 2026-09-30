/* Flux Studio 10 — integrated return, assistant and contextual live sessions.
 * Local domain implementation. No remote media, LLM calls or server authority.
 * The brief is a projection of source records, NOT an AI-generated truth store.
 */
function seed10() {
  const d=seed09();
  d.schema=11; d.activity=[]; d.nextActivity=1; d.agentRuns={}; d.agentChecked={}; d.sessionsArchive={};
  // A small, explicitly fictional return scenario. Original v9 tasks remain intact.
  const ago=h=>new Date(Date.now()-h*3600000).toISOString();
  d.tasks.t10={id:'t10',space:'p1',board:'b2',title:'Wybrać zasilanie pierwszego prototypu',description:'USB-C wystarczy do pierwszej próby. Baterię rozważymy osobno.',status:'doing',assignee:'u2',due:null,estimate:15,nodeIds:['n5'],references:['page:w2'],source:null,anchor:'r10',result:null,version:2,created:ago(60)};
  d.messages.r10={id:'r10',space:'p1',author:'u2',text:'Do pierwszego testu wystarczy USB-C. Hubert, potwierdzisz, czy odkładamy baterię?',primary:'task:t10',at:ago(5),version:1};
  d.messages.r11={id:'r11',space:'p1',author:'u2',text:'Taśma reaguje na sygnał testowy. Pomiar zasilania zostawiamy na oddzielną próbę.',primary:'task:t3',at:ago(8),version:1};
  d.messages.r12={id:'r12',space:'p1',author:'u2',text:'Mam dostęp do stanowiska. Kamera jest podłączona — można wrócić do testu.',at:ago(12),version:1};
  d.messages.r13={id:'r13',space:'p1',author:'u1',text:'Dostęp gotowy, dzięki. To rozwiązuje pytanie o stanowisko.',parent:'r12',at:ago(11),version:1};
  d.messages.r12.solution='r13';
  d.effects.e10={id:'e10',kind:'blocker',task:'t10',message:'r10',helper:'u1',createdAt:ago(5),createdBy:'u2',resolvedAt:null};
  d.effects.e11={id:'e11',kind:'result',task:'t3',message:'r11',createdAt:ago(8)};
  d.tasks.t3.result='r11';d.anchors['task:t10']='r10';d.anchors['task:t3']='r11';
  const events=[
    {kind:'result',ref:'task:t3',source:'r11',at:ago(8),actor:'u2',space:'p1'},
    {kind:'answer',ref:'message:r12',source:'r13',at:ago(11),actor:'u1',space:'p1'},
    {kind:'blocker',ref:'task:t10',source:'r10',effect:'e10',at:ago(5),actor:'u2',space:'p1'}
  ].sort((a,b)=>a.at.localeCompare(b.at));
  for(const e of events)d.activity.push({id:'ev10_'+d.nextActivity,seq:d.nextActivity++,...e});
  for(const [id,p] of Object.entries(d.prefs)){
    p.review={};for(const sid of Object.keys(d.spaces))p.review[sid]={through:0,at:ago(24)};
    p.read.r13=true;
  }
  d.notifications.push({id:'n10',user:'u1',space:'p1',ref:'message:r10',text:'Marek potrzebuje potwierdzenia zasilania.',at:ago(5),read:false});
  return d;
}
function normalizeExperience(d) {
  d.activity=Array.isArray(d.activity)?d.activity:[];
  d.nextActivity=Math.max(Number(d.nextActivity)||1,...d.activity.map(e=>(Number(e.seq)||0)+1));
  d.agentRuns=d.agentRuns||{}; d.agentChecked=d.agentChecked||{}; d.sessionsArchive=d.sessionsArchive||{};
  for(const p of Object.values(d.prefs))p.review=p.review||{};
  return normalizeRefinement(d);
}
function validateImport(input) {
  // Import is explicit, never a silent rewrite of the old v9 storage key.
  rejectDangerous(input);
  const d=copy(input);
  if(d?.schema===9)d.schema=11;
  const checked=validateCoreImport(d);
  for(const key of ['activity'])if(checked[key]!==undefined&&!Array.isArray(checked[key]))throw Error('Nieprawidłowy dziennik zmian.');
  for(const key of ['agentRuns','agentChecked','sessionsArchive'])if(checked[key]!==undefined&&(!checked[key]||typeof checked[key]!=='object'||Array.isArray(checked[key])))throw Error('Nieprawidłowa sekcja: '+key);
  if((checked.activity||[]).some(e=>!Number.isInteger(e.seq)||e.seq<1||!checked.spaces[e.space]||!Number.isFinite(Date.parse(e.at))))throw Error('Nieprawidłowe zdarzenie powrotu.');
  const seqs=(checked.activity||[]).map(e=>e.seq);if(new Set(seqs).size!==seqs.length)throw Error('Powtórzony numer zdarzenia.');
  return normalizeExperience(checked);
}
function initExperience() {
  normalizeExperience(db);
  ui.review=null;ui.reviewBack=null;ui.session=null;ui.live=false;ui.runTimers={};ui.mediaPending={};ui.localRunEpoch=1;
  ui.view='home';ui.scrollEnd=false;
  for(const r of Object.values(db.agentRuns))if(['queued','running'].includes(r.state)){r.state='interrupted';r.finishedAt=now();if(db.messages[r.response])db.messages[r.response].text='Przerwano po ponownym otwarciu aplikacji. Żadna niedokończona operacja nie została wykonana.';}
  // Media sessions are intentionally not deserialized. Invitations expire with them.
  db.notifications=db.notifications.filter(n=>n.kind!=='live');
  initRefinement();
  window.Flux10={brief:briefModel,openReview,recordActivity,startSession,endLiveSession,processRun,runAI,
    get activity(){return db.activity},get session(){return ui.session},get review(){return ui.review},
    snapshot:()=>maxActivity(),ackReview,simulateAbsence,showToSession,receiveShared,adoptShared,normalizeExperience,
    mediaToggle,stopMedia,makeProposal,undoProposal,projectionEvents};
}
function maxActivity(space=null){return Math.max(0,...(db.activity||[]).filter(e=>!space||e.space===space).map(e=>e.seq));}
function reviewCursor10(space){return prefs().review?.[space]||{through:0,at:null};}
function emitActivity(kind,ref,source=null,details={}) {
  const space=details.space||refScope(ref)||ui.space;
  if(!db.spaces[space])return;
  const seq=db.nextActivity++;
  const e={id:'activity_'+seq,seq,space,kind,ref,source,actor:ui.user,at:now(),...details};
  db.activity.push(e);
  // Do not silently drop old records. Server implementation will paginate/retain explicitly.
  if(ui.session&&ui.session.space===space)ui.session.eventIds.push(e.id);
  return e;
}
function recordActivity(before,label) {
  normalizeExperience(db);
  for(const e of Object.values(db.effects)){
    const old=before.effects[e.id];
    if(e.kind==='blocker'){
      if(!old&&!e.resolvedAt)emitActivity('blocker','task:'+e.task,e.message,{effect:e.id});
      else if(old&&!old.resolvedAt&&e.resolvedAt)emitActivity(e.cancelledAt?'withdrawn':'unblocked','task:'+e.task,e.solution||e.message,{effect:e.id});
      else if(old&&old.resolvedAt&&!e.resolvedAt)emitActivity('blocker','task:'+e.task,e.message,{effect:e.id});
    }
  }
  for(const t of Object.values(db.tasks)){
    const old=before.tasks[t.id];
    if(!old){emitActivity('task','task:'+t.id,t.source);continue;}
    if(t.result!==old.result)emitActivity(t.result?'result':'result-withdrawn','task:'+t.id,t.result||old.result);
    else if(t.result&&db.messages[t.result]?.version!==before.messages[t.result]?.version)emitActivity('result','task:'+t.id,t.result);
    if(t.status!==old.status)emitActivity(t.status==='done'?'done':'task','task:'+t.id,t.result||t.source);
    if(t.due!==old.due||t.assignee!==old.assignee)emitActivity('task','task:'+t.id,t.source);
  }
  for(const m of Object.values(db.messages)){
    const old=before.messages[m.id];
    if(m.solution!==old?.solution&&(m.solution||old?.solution))emitActivity(m.solution?'answer':'answer-withdrawn','message:'+m.id,m.solution||m.id);
  }
  for(const p of Object.values(db.pages)){
    const old=before.pages[p.id];
    if(!old||p.version!==old.version)emitActivity('wiki','page:'+p.id,null,{version:p.version});
  }
  for(const s of Object.values(db.spaces))if(before.spaces[s.id]&&s.goal!==before.spaces[s.id].goal)emitActivity('direction',null,null,{space:s.id,text:s.goal});
  // An applied layout is a material change; mouse movement is deliberately not a headline.
  if(label==='agent.apply')for(const p of Object.values(db.proposals))if(p.status==='applied'&&before.proposals[p.id]?.status!=='applied'&&p.kind==='layout')emitActivity('map','map:'+p.map,null,{version:db.maps[p.map]?.version});
  if(ui.session&&ui.session.space===ui.space){
    for(const m of Object.values(db.messages))if(!before.messages[m.id]&&m.space===ui.session.space&&m.author!=='ai')ui.session.messageIds.push(m.id);
  }
  for(const t of Object.values(db.tasks)){const old=before.tasks[t.id];if(t.result&&old&&(t.result!==old.result||db.messages[t.result]?.version!==before.messages[t.result]?.version))prepareWikiProposal(t,db.messages[t.result]);}
  if(db.spaces[ui.space]?.ai)db.agentChecked[ui.space]={at:now(),seq:maxActivity(ui.space),mode:'local-rule'};
}
function projectionEvents(space,from,to){return (db.activity||[]).filter(e=>e.space===space&&e.seq>from&&e.seq<=to);}
function briefModel(space,from=reviewCursor(space).through,to=maxActivity(space)) {
  if(!allowed(space))return {needs:[],changes:[],signals:[],unread:0,events:[],proposals:[]};
  const events=projectionEvents(space,from,to),keys=new Map();
  for(const e of events)keys.set(e.ref||'direction',e);
  const changes=[];
  for(const [ref,last] of keys){
    if(ref==='direction'){changes.push({key:ref,ref:null,kind:'direction',title:'Najbliższy efekt',text:db.spaces[space].goal,source:last.source,seq:last.seq});continue;}
    const o=getObj(ref);if(!o)continue;
    const type=ref.split(':')[0];
    if(type==='task'){
      const blockers=activeBlockers(o.id),result=resultMessage(o.id);
      const same=events.filter(e=>e.ref===ref);
      const resolved=same.filter(e=>e.kind==='unblocked'||e.kind==='withdrawn');
      let kind=blockers.length?'blocker':result?'result':o.status==='done'?'done':resolved.length?'unblocked':'task';
      let text=blockers.length?plain(db.messages[blockers[0].message]?.text):result?plain(result.text):resolved.length?'Przeszkoda jest rozwiązana. Zadanie '+(o.status==='done'?'zakończono.':'można kontynuować.'):'Stan: '+STATUSES[o.status]+(o.due?' · Termin: '+dateLabel(o.due):'');
      const source=blockers.length?blockers[0].message:result?.id||last.source;
      changes.push({key:ref,ref,kind,title:o.title,text,source,seq:last.seq,task:o.id,alsoResolved:resolved.length>0});
    }else if(type==='message'){
      if(o.solution&&db.messages[o.solution])changes.push({key:ref,ref,kind:'answer',title:short(plain(o.text),110),text:plain(db.messages[o.solution].text),source:o.solution,seq:last.seq});
      else if(last.kind==='answer-withdrawn')changes.push({key:ref,ref,kind:'answer-withdrawn',title:'Pytanie jest znów otwarte',text:plain(o.text),source:o.id,seq:last.seq});
    }else if(type==='page')changes.push({key:ref,ref,kind:'wiki',title:o.title,text:'Aktualna wersja '+o.version+'. Otwórz dokument i jego historię.',source:null,seq:last.seq});
    else if(type==='map')changes.push({key:ref,ref,kind:'map',title:o.title,text:'Układ zmieniony świadomie. Zobacz aktualny szkic.',source:null,seq:last.seq});
  }
  const needs=[];
  for(const e of Object.values(db.effects)){
    const t=db.tasks[e.task];
    if(e.kind==='blocker'&&!e.resolvedAt&&t?.space===space&&(e.helper===ui.user||(!e.helper&&t.assignee===ui.user)))
      needs.push({key:'need:'+e.id,kind:'blocker',title:t.title,text:plain(db.messages[e.message]?.text),ref:'task:'+t.id,source:e.message,effect:e.id,label:e.helper===ui.user?'Potrzebna Twoja pomoc':'Twoja praca czeka'});
  }
  for(const t of Object.values(db.tasks))if(t.space===space&&t.assignee===ui.user&&t.status!=='done'&&t.due&&t.due<=day()&&!needs.some(n=>n.ref==='task:'+t.id))
    needs.push({key:'due:'+t.id,kind:'due',title:t.title,text:'Termin ukończenia: '+dateLabel(t.due)+'. To wspólny termin, nie licznik wiadomości.',ref:'task:'+t.id,source:t.source,label:t.due<day()?'Termin minął':'Termin dzisiaj'});
  const signals=db.notifications.filter(n=>n.space===space&&n.user===ui.user&&!n.read&&n.kind!=='live'&&!needs.some(c=>c.ref===n.ref||'message:'+c.source===n.ref));
  const proposals=Object.values(db.proposals).filter(p=>p.space===space&&p.status==='pending');
  return {space,from,to,events,needs,changes:changes.filter(c=>!needs.some(n=>n.ref===c.ref)).sort((a,b)=>b.seq-a.seq),signals,proposals,unread:unreadCount(space)};
}
function relativeStamp(at){if(!at)return 'od początku';const h=Math.max(0,Math.round((Date.now()-Date.parse(at))/3600000));return h<1?'od ostatniego skrótu':h<24?'od '+h+' godz.':h<48?'od wczoraj':'z ostatnich '+Math.round(h/24)+' dni';}
function renderReturnStrip10() {
  const cursor=reviewCursor(ui.space),b=briefModel(ui.space),pending=b.changes.length;
  const back=ui.review&&ui.reviewBack&&ui.drawer?.kind!=='review'&&ui.review.space===ui.space?B(I('back')+' Do skrótu','return-back','','small quiet'):'';
  return `<div class="return-strip">${back}<button class="return-open" data-action="return-open" data-space="${ui.space}">${I('leaf')}<span><b>Co ważne</b><small>${b.needs.length?b.needs.length+' '+plural(b.needs.length,'sprawa dla Ciebie','sprawy dla Ciebie','spraw dla Ciebie'):pending?pending+' '+plural(pending,'zmiana','zmiany','zmian')+' '+relativeStamp(cursor.at):'Kontekst bez przewijania czatu'}</small></span>${I('arrow')}</button><button class="agent-presence" data-action="agent-panel" title="Działanie agenta projektu">${I('robot')}<span>${b.proposals.length?'Propozycja do sprawdzenia':db.spaces[ui.space].ai?'Pomoc w tle · demo':'AI wyłączone'}</span></button></div>`;
}
function renderHome10(){
  let h=renderCoreHome();
  const projects=Object.values(db.spaces).filter(s=>allowed(s.id)&&s.kind==='project');
  const cards=projects.map(s=>{
    const b=briefModel(s.id),changed=b.changes.length,need=b.needs.length;
    return `<button class="return-project" data-action="return-open" data-space="${s.id}"><div class="row between"><span class="project-symbol">${I(s.icon||'spark')}</span><span class="pill ${need?'warn':''}">${need?need+' dla Ciebie':changed?changed+' zmian':'Bez nowych oznaczeń'}</span></div><h3>${esc(s.name)}</h3><p>${esc(s.goal||'Wasza bieżąca praca.')}</p><div class="return-project-bottom"><span>${b.unread?b.unread+' nieprzeczytanych · nie lista zadań':'Bez nowych wiadomości'}</span>${I('arrow')}</div></button>`;
  }).join('');
  h=h.replace('<div class="home-grid">',`<section class="return-home"><div class="row between"><h3>Wróć bez nadrabiania całego czatu</h3>${B('Pokaż powrót po tygodniu','demo-week','','small quiet')}</div><p class="hint">Najpierw aktualny stan i sprawy do Ciebie. Historię otwierasz tylko wtedy, gdy jej potrzebujesz.</p><div class="return-project-grid">${cards}</div></section><div class="home-grid">`);
  const resume=h.match(/<section class="resume-card">[\s\S]*?<\/section>/)?.[0];
  if(resume&&projects.some(s=>briefModel(s.id).changes.length)){h=h.replace(resume,'');h=h.replace('<div class="home-grid">',resume+'<div class="home-grid">');}
  return h;
}
function openReview10(space=ui.space){
  if(!allowed(space)){toast('Ten projekt nie jest dostępny.');return;}
  captureUI();
  const previous={view:ui.view,space:ui.space,drawer:ui.drawer,chat:$('#chat-scroll')?.scrollTop||0};
  if(ui.space!==space)setSpace(space);
  ui.view='chat';ui.scrollEnd=false;ui.flash=null;
  const cursor=reviewCursor(space),until=maxActivity(space);
  ui.review={space,from:cursor.through,until,at:now(),baselineAt:cursor.at,model:copy(briefModel(space,cursor.through,until))};
  ui.reviewBack=previous;ui.drawer={kind:'review'};render();
}
function ackReview(){
  const r=ui.review;if(!r||!allowed(r.space))return;
  prefs().review=prefs().review||{};
  prefs().review[r.space]={through:Math.max(reviewCursor(r.space).through,r.until),at:r.at};
  persist();ui.drawer=null;ui.reviewBack=null;render();toast('Zapamiętano punkt powrotu. Nie oznaczono wiadomości jako przeczytanych.');
}
function briefCard(c){
  c={...c};
  if(c.task&&db.tasks[c.task]){const t=db.tasks[c.task],bs=activeBlockers(t.id),r=resultMessage(t.id);c.title=t.title;if(bs.length){c.kind='blocker';c.text=plain(db.messages[bs[0].message]?.text);c.source=bs[0].message;}else if(r){c.kind='result';c.text=plain(r.text);c.source=r.id;}else if(c.kind==='blocker'){c.kind='unblocked';c.text='Ta przeszkoda została już rozwiązana. Sprawdź aktualne zadanie.';}}
  // Snapshot fixes membership/order, not claims that have since become false.
  if(c.ref?.startsWith('message:')){
    const m=getObj(c.ref);
    if(m&&['answer','answer-withdrawn'].includes(c.kind)){
      if(m.solution&&db.messages[m.solution]){c.kind='answer';c.text=plain(db.messages[m.solution].text);c.source=m.solution;}
      else {c.kind='answer-withdrawn';c.text='Oznaczenie rozwiązania zostało cofnięte. '+plain(m.text);c.source=m.id;}
    }
  }
  if(c.ref?.startsWith('page:')&&getObj(c.ref)){const p=getObj(c.ref);c.title=p.title;c.text='Aktualna wersja '+p.version+'. Otwórz dokument i jego historię.';}
  if(c.kind==='due'&&c.ref){const t=getObj(c.ref);if(t){c.title=t.title;if(t.status==='done'||t.assignee!==ui.user||!t.due||t.due>day()){c.label='Nie jest już pilnym terminem dla Ciebie';c.text=t.status==='done'?'Zadanie zakończono.':'Stan lub termin zadania zmienił się. Odśwież skrót.';}else{c.label=t.due<day()?'Termin minął':'Termin dzisiaj';c.text='Termin ukończenia: '+dateLabel(t.due)+'. To wspólny termin, nie licznik wiadomości.';}}}
  const icons={blocker:'block',due:'calendar',result:'flag',answer:'check','answer-withdrawn':'chat',unblocked:'check',done:'check',wiki:'wiki',map:'map',task:'task',direction:'spark'};
  const labels={blocker:'Przeszkoda',due:'Termin',result:'Aktualny wynik',answer:'Przyjęte rozwiązanie','answer-withdrawn':'Ponownie otwarte',unblocked:'Odblokowane',done:'Zakończone',wiki:'Wiki · zmiana',map:'Mapa · zmiana',task:'Zadanie · zmiana',direction:'Cel projektu'};
  const eff=c.effect?db.effects[c.effect]:null,stale=!!c.effect&&!!eff?.resolvedAt;
  return `<article class="brief-card ${c.kind==='blocker'&&!stale?'needs':''}" data-brief-key="${esc(c.key)}"><div class="brief-kind">${I(stale?'check':icons[c.kind]||'link')} ${esc(stale?'Już rozwiązane':c.label||labels[c.kind]||'Zmiana')}${c.alsoResolved&&c.kind!=='unblocked'?'<span class="subtle-label"> · po odblokowaniu</span>':''}</div><h3>${esc(c.title)}</h3><p>${esc(short(c.text,240))}</p><div class="brief-links">${c.ref?B('Otwórz '+(c.ref.startsWith('task:')?'zadanie':c.ref.startsWith('page:')?'wiki':c.ref.startsWith('map:')?'mapę':'pytanie'),'brief-ref',`data-ref="${esc(c.ref)}"`,'small quiet'):''}${c.source?B(I('reply')+' Źródło','brief-source',`data-id="${esc(c.source)}"`,'small quiet'):''}${c.effect&&!stale?B('Odpowiedz i odblokuj','resolve',`data-id="${c.effect}"`,'small soft'):''}</div></article>`;
}
function renderReview10(){
  const r=ui.review;if(!r||!allowed(r.space))return '';
  const b=r.model,newChanges=maxActivity(r.space)>r.until;
  return `<aside class="drawer review-drawer" aria-label="Skrót zmian projektu"><div class="drawer-head"><span class="eyebrow">${I('leaf')} Co ważne</span>${B('Odśwież','return-refresh','','small quiet')}${IB('x','Wróć do rozmowy','close-drawer')}</div><div class="drawer-body" id="drawer-scroll"><div class="brief-intro"><h2>Nie musisz czytać wszystkiego.</h2><p>${esc(db.spaces[r.space].name)} · ${esc(relativeStamp(r.baselineAt))}</p><small>Fakty z oznaczeń i stanu pracy. Nie streszczenie wszystkich wypowiedzi.</small></div>${newChanges?`<div class="brief-update">${I('history')} Są nowsze zmiany. Ten skrót pozostaje na miejscu.${B('Odśwież','return-refresh','','small')}</div>`:''}<section class="brief-section"><h3>Potrzebuje Ciebie <span>${b.needs.length}</span></h3>${b.needs.length?b.needs.map(briefCard).join(''):'<p class="hint">Brak przypisanych Ci przeszkód i pilnych terminów.</p>'}</section><section class="brief-section"><h3>Co się zmieniło <span>${b.changes.length}</span></h3>${b.changes.length?b.changes.map(briefCard).join(''):'<p class="hint">Brak nowych oznaczonych zmian. To nie znaczy, że w rozmowie nic ważnego nie padło.</p>'}</section>${b.signals.length?`<details class="brief-section"><summary>Wzmianki i odpowiedzi do Ciebie · ${b.signals.length}</summary>${b.signals.map(n=>`<button class="notification" data-action="brief-ref" data-ref="${esc(n.ref)}">${I('chat')}<span>${esc(n.text)}</span></button>`).join('')}</details>`:''}${b.proposals.length?`<div class="brief-ai">${I('robot')}<span>Agent przygotował ${b.proposals.length} ${plural(b.proposals.length,'propozycję','propozycje','propozycji')}. To nie są przyjęte ustalenia.</span>${B('Sprawdź','agent-panel','','small')}</div>`:''}<div class="brief-coverage"><b>Rozmowa nadal jest dostępna.</b><p>${b.unread} nieprzeczytanych wiadomości. Zwykłe wypowiedzi nie stają się automatycznie decyzjami.</p>${B('Otwórz rozmowę','return-chat','','small quiet')}${B(I('robot')+' Zapytaj o kontekst','return-ai','','small quiet')}</div></div><div class="drawer-footer brief-footer">${B(I('check')+' Mam kontekst','return-ack','','primary')}<small>Zapamięta ten skrót. Nie wyczyści nieprzeczytanych.</small></div></aside>`;
}
function renderDrawer(){
  if(ui.drawer?.kind==='review')return renderReview();
  if(ui.drawer?.kind==='agent')return renderAgentPanel();
  let html=renderCoreDrawer();
  if(html&&ui.reviewBack&&ui.review)html=html.replace('<div class="drawer-body" id="drawer-scroll">',`<div class="drawer-body" id="drawer-scroll">${B(I('back')+' Wróć do skrótu','return-back','','small quiet back-to-brief')}`);
  if(html&&ui.drawer?.kind==='object')html=html.replace('<div class="drawer-tabs">',`<div class="context-live-link">${B(I('headphones')+' Zróbmy to razem','live',`data-ref="${esc(ui.drawer.ref)}"`,'small quiet')}</div><div class="drawer-tabs">`);
  return html;
}
function simulateAbsence(days=7){
  const since=new Date(Date.now()-days*86400000).toISOString();
  prefs().review=prefs().review||{};
  prefs().review[ui.space]={through:0,at:since};
  Object.values(db.messages).filter(m=>m.space===ui.space&&m.author!==ui.user).forEach(m=>delete prefs().read[m.id]);
  persist();openReview(ui.space);toast('Scenariusz demo: powrót po '+days+' dniach. Dane projektu nie zostały zmienione.');
}

/* ------------------ Project-bound assistant, optional and explicit ------------------ */
function withScope(space,user,fn){
  if(!db.spaces[space]?.members.includes(user))throw Error('Dostęp do projektu został cofnięty.');
  const old={space:ui.space,user:ui.user};
  ui.space=space;ui.user=user;
  try{return fn();}finally{ui.space=old.space;ui.user=old.user;}
}
function makeProposal(kind,params,run=null){
  const id=uid('prop');const p={id,space:ui.space,kind,status:'pending',createdAt:now(),requestedBy:ui.user,...params};
  db.proposals[id]=p;
  if(run){run.proposal=id;run.state='proposal';run.finishedAt=now();p.run=run.id;}
  return p;
}
function prepareWikiProposal(t,m){
  if(!db.spaces[t.space]?.ai||db.spaces[t.space].aiBackground===false)return;
  const ps=[...new Set(t.references.map(r=>r.startsWith('fragment:')?db.fragments[r.split(':')[1]]?.page:r.startsWith('page:')?r.split(':')[1]:null).filter(Boolean))];
  if(ps.length!==1)return;
  const page=db.pages[ps[0]];
  if(!page||page.space!==t.space||Object.values(db.proposals).some(p=>p.kind==='wiki'&&p.source===m.id&&p.sourceVersion===m.version))return;
  const p=makeProposal('wiki',{page:page.id,pageVersion:page.version,task:t.id,source:m.id,sourceVersion:m.version,trigger:'result',addition:`\n\n## Obserwacja z próby\n\n${plain(m.text)}\n\nŹródło: [[message:${m.id}]] · [[task:${t.id}]]`});
  const response=createMessage({space:t.space,parent:ensureAnchor('task:'+t.id),author:'ai',text:'Zapisaliście wynik. Jest już przy zadaniu i mapie. Przygotowałem dopisanie obserwacji do powiązanej wiki — nie decyzję o zmianie kierunku.'});
  response.proposal=p.id;response.agentSources=['message:'+m.id,'task:'+t.id,'page:'+page.id];response.agentTrigger='Po zapisaniu wyniku';
  const rid=uid('run');db.agentRuns[rid]={id:rid,space:t.space,actor:ui.user,state:'proposal',trigger:'result',response:response.id,proposal:p.id,startedAt:now(),finishedAt:now(),sources:response.agentSources};p.run=rid;response.agentRun=rid;p.response=response.id;
}
function runAI(text,parent){
  if(!db.spaces[ui.space]?.ai)throw Error('Agent jest wyłączony w tym projekcie. Szkic został zachowany.');
  const command=createMessage({text,parent});
  const explicit=refsIn(text).filter(r=>!r.startsWith('person:'));
  let context=[];
  if(parent&&db.messages[rootId(parent)]?.primary)context.push(db.messages[rootId(parent)].primary);
  if(ui.drawer?.kind==='object')context.push(ui.drawer.ref);
  if(ui.view==='map'){context.push('map:'+ui.map);context.push(...ui.selected.map(id=>'node:'+id));}
  if(ui.view==='wiki'&&ui.page)context.push('page:'+ui.page);
  const sources=[...new Set([...explicit,...context])].filter(r=>getObj(r)&&refScope(r)===ui.space&&canRef(r));
  const r={id:uid('run'),space:ui.space,actor:ui.user,command:command.id,parent:rootId(command.id),state:'running',trigger:'command',startedAt:now(),text,sources,explicit,epoch:ui.localRunEpoch};
  const response=createMessage({text:'Sprawdzam wskazany kontekst projektu…',parent:r.parent,author:'ai'});
  r.response=response.id;response.agentRun=r.id;response.agentSources=sources;
  db.agentRuns[r.id]=r;
  ui.runTimers=ui.runTimers||{};ui.runTimers[r.id]=setTimeout(()=>processRun(r.id),550);
  return command;
}
function processRun(id){
  const r=db.agentRuns[id];if(!r||r.state!=='running'||r.epoch!==ui.localRunEpoch)return;
  captureUI();
  try{
    withScope(r.space,r.actor,()=>{
      if(!db.spaces[r.space].ai)throw Error('Agent został wyłączony. Niczego nie zmieniono.');
      const response=db.messages[r.response];if(!response)throw Error('Brakuje odpowiedzi źródłowej.');
      const prompt=r.text.toLowerCase(),explicit=r.explicit||[],sources=r.sources;
      let proposal=null;
      if(/ułóż|uloz|uporządkuj|uporzadkuj/.test(prompt)){
        const explicitNodes=explicit.filter(x=>x.startsWith('node:')).map(x=>getObj(x));
        const maps=[...new Set(explicitNodes.map(n=>n.map))];
        const mapRef=explicit.find(x=>x.startsWith('map:'))||sources.find(x=>x.startsWith('map:'));
        const mid=maps.length===1?maps[0]:mapRef?.split(':')[1];
        if(maps.length>1||!mid){response.text='Wskaż jedną mapę lub jej myśli przez @. Nie wybieram za Ciebie fragmentu do przestawienia.';}
        else {
          const mp=db.maps[mid];if(!mp||mp.space!==r.space)throw Error('Mapa niedostępna.');
          const selected=explicitNodes.length?explicitNodes:sources.filter(x=>x.startsWith('node:')).map(getObj).filter(n=>n?.map===mid);
          const nodes=selected.length?selected:Object.values(db.nodes).filter(n=>n.map===mid&&!n.archived);
          proposal=makeProposal('layout',{map:mid,mapVersion:mp.version,positions:nodes.map((n,i)=>({id:n.id,x:90+(i%3)*290,y:100+Math.floor(i/3)*205})),beforePositions:nodes.map(n=>({id:n.id,x:n.x,y:n.y})),source:r.command},r);
          response.text=`Przygotowałem układ ${nodes.length} myśli. Treść i połączenia pozostają bez zmian. To propozycja regułowa, nie analiza LLM.`;
          response.agentSources=[...new Set(sources.concat('map:'+mid))];
        }
      }else if(/wiki|dopisz|obserwacj/.test(prompt)&&sources.some(x=>x.startsWith('task:'))){
        const t=getObj(sources.find(x=>x.startsWith('task:'))),m=resultMessage(t.id);
        const pageRefs=sources.filter(x=>x.startsWith('page:')||x.startsWith('fragment:')).map(x=>x.startsWith('fragment:')?'page:'+getObj(x).page:x);
        const fallback=t.references.filter(x=>x.startsWith('page:')||x.startsWith('fragment:')).map(x=>x.startsWith('fragment:')?'page:'+getObj(x).page:x);
        const ps=[...new Set(pageRefs.length?pageRefs:fallback)];
        if(!m)response.text='To zadanie nie ma jeszcze opublikowanego wyniku. Nie dopiszę do wiki domysłu.';
        else if(ps.length!==1)response.text='Wskaż jedną stronę wiki przez @. Nie będę aktualizować kilku dokumentów na chybił trafił.';
        else {const p=getObj(ps[0]);if(p.space!==r.space)throw Error('Wiki spoza projektu.');proposal=makeProposal('wiki',{page:p.id,pageVersion:p.version,task:t.id,source:m.id,sourceVersion:m.version,addition:`\n\n## Obserwacja z próby\n\n${plain(m.text)}\n\nŹródło: [[message:${m.id}]] · [[task:${t.id}]]`},r);response.text='Przygotowałem dopisanie wyniku do wskazanej strony. Pozostała treść pozostaje bez zmian.';response.agentSources=['task:'+t.id,'message:'+m.id,'page:'+p.id];}
      }else if(/(?:zadanie|krok)\s*:|(?:utwórz|stwórz|dodaj|zaproponuj).*zadanie/.test(prompt)){
        const title=r.text.replace(/^\/ai\s*/i,'').replace(/^(?:utwórz|stwórz|dodaj|zaproponuj)\s+(?:jedno\s+)?/i,'').replace(/^(zadanie|krok)\s*:?\s*/i,'').replace(/\[\[[^\]]+\]\]/g,'').trim();
        if(!title)response.text='Podaj treść jednego działania, np. /ai zadanie: Sprawdzić zasilanie USB-C.';
        else {proposal=makeProposal('task',{title:short(title,180),source:r.command,sourceVersion:db.messages[r.command]?.version,nodeIds:sources.filter(x=>x.startsWith('node:')).map(x=>x.split(':')[1])},r);response.text='Przygotowałem jeden krok z Twojego opisu. Nie przypisuję wykonawcy, terminu ani zobowiązania bez akceptacji.';}
      }else{
        const b=briefModel(r.space,reviewCursor(r.space).through,maxActivity(r.space));
        const facts=b.changes.slice(0,4).map(c=>`${c.title}: ${short(c.text,180)}${c.source?' [[message:'+c.source+']]':c.ref?' [['+c.ref+']]':''}`);
        const needs=b.needs.map(c=>`${c.label}: [[${c.ref}]]${c.source?' · [[message:'+c.source+']]':''}`);
        const recent=Object.values(db.messages).filter(m=>m.space===r.space&&m.author!=='ai'&&m.id!==r.command&&(db.messages[r.command]?.parent?rootId(m.id)===r.parent:true)).sort((a,b)=>a.at.localeCompare(b.at)).slice(-3);
        response.text='Zapisany stan projektu — tryb demonstracyjny, bez interpretacji LLM.\n\n'+(needs.length?'Potrzebuje uwagi:\n'+needs.join('\n')+'\n\n':'')+(facts.length?facts.join('\n\n'):'Brak nowych oznaczonych zmian od ostatniego skrótu.')+'\n\nDalszy kontekst rozmowy:\n'+recent.map(m=>'[[message:'+m.id+']]').join('\n')+'\n\nZwykłe wypowiedzi nie są tu uznawane za ustalenia. Skrót może nie obejmować nieoznaczonych decyzji.';
        response.agentSources=[...new Set([...sources,...recent.map(m=>'message:'+m.id),...b.changes.flatMap(c=>c.source?['message:'+c.source]:c.ref?[c.ref]:[])])];
      }
      response.version++;response.agentTrigger='Na Twoje polecenie';
      if(proposal){response.proposal=proposal.id;proposal.response=response.id;}
      else{r.state='completed';r.finishedAt=now();}
      db.agentChecked[r.space]={at:now(),seq:maxActivity(r.space),mode:'local-rule'};
      db.revision++;persist();
    });
  }catch(e){r.state='failed';r.finishedAt=now();if(db.messages[r.response])db.messages[r.response].text=e.message;persist();}
  if(allowed(r.space))render();
}
function cancelLocalRuns(){
  for(const t of Object.values(ui.runTimers||{}))clearTimeout(t);
  ui.runTimers={};ui.localRunEpoch=(ui.localRunEpoch||0)+1;
  if(db?.agentRuns)for(const r of Object.values(db.agentRuns))if(r.state==='running'){r.state='cancelled';r.finishedAt=now();if(db.messages[r.response])db.messages[r.response].text='Anulowano. Nie wykonano zmiany.';}
}
function proposalStale(p){
  if(p.kind==='wiki')return db.pages[p.page]?.version!==p.pageVersion||db.messages[p.source]?.version!==p.sourceVersion||db.tasks[p.task]?.result!==p.source;
  if(p.kind==='layout')return db.maps[p.map]?.version!==p.mapVersion||p.positions.some(n=>!db.nodes[n.id]);
  return !db.messages[p.source]||db.messages[p.source]?.space!==p.space||(p.sourceVersion!==undefined&&db.messages[p.source]?.version!==p.sourceVersion);
}
function miniPositions(p){
  const positions=p.positions||[];if(!positions.length)return '';
  const maxX=Math.max(...positions.map(n=>n.x))+230,maxY=Math.max(...positions.map(n=>n.y))+120;
  return `<svg class="layout-preview" viewBox="0 0 ${maxX} ${maxY}" role="img" aria-label="Proponowane rozmieszczenie myśli">${positions.map(n=>`<rect x="${n.x}" y="${n.y}" width="235" height="100" rx="14" fill="var(--elevated)" stroke="var(--line)"/><text x="${n.x+16}" y="${n.y+55}" fill="var(--text)" font-size="17">${esc(short(db.nodes[n.id]?.text,22))}</text>`).join('')}</svg>`;
}
function proposalHTML(id){
  const p=db.proposals[id];if(!p||!allowed(p.space))return '';
  const stale=p.status==='pending'&&proposalStale(p),active=p.status==='pending'&&!stale&&db.spaces[p.space].ai;
  const labels={pending:'Propozycja · jeszcze bez zmian',applied:'Zastosowano',dismissed:'Odrzucono',undone:'Cofnięto',cancelled:'Anulowano'};
  const target=p.kind==='wiki'?'page:'+p.page:p.kind==='layout'?'map:'+p.map:p.createdTask?'task:'+p.createdTask:null;
  return `<div class="proposal" data-proposal="${p.id}"><div class="label">${I(stale?'history':'robot')} ${stale?'Źródło zmieniło się · propozycja nieaktualna':labels[p.status]||p.status}</div><p>${p.kind==='task'?esc(p.title):p.kind==='wiki'?'Dopisanie obserwacji do '+renderRef(target):'Układ wskazanej mapy '+renderRef(target)}</p>${p.kind==='layout'?miniPositions(p):p.kind==='wiki'?`<blockquote class="proposal-quote">${esc(short(plain(db.messages[p.source]?.text),300))}</blockquote>`:''}${p.kind==='task'?'<p class="hint">Bez osoby i terminu. Zadanie nie powstanie przed zatwierdzeniem.</p>':''}<div class="proposal-actions">${active?B(I('check')+' Zastosuj','proposal-apply',`data-id="${p.id}"`,'small primary'):''}${p.status==='pending'?B('Odrzuć','proposal-dismiss',`data-id="${p.id}"`,'small quiet'):''}${p.status==='applied'&&p.undo?B(I('undo')+' Cofnij zmianę','proposal-undo',`data-id="${p.id}"`,'small quiet'):''}${p.createdTask&&db.tasks[p.createdTask]?renderRef('task:'+p.createdTask):''}</div>${stale?'<p class="hint">Najpierw sprawdź nowe źródło i zleć aktualną propozycję. Nie nadpisujemy nowszej pracy.</p>':''}</div>`;
}
function applyProposal(id){
  const p=db.proposals[id];if(!p||p.space!==ui.space||!allowed(p.space)||p.status!=='pending')throw Error('Ta propozycja nie jest dostępna do zastosowania.');
  if(!db.spaces[p.space].ai)throw Error('Agent wyłączony w tym projekcie.');
  if(proposalStale(p))throw Error('Źródło zmieniło się. Nie nadpisano nowszej pracy.');
  p.undo=p.kind==='wiki'?{title:db.pages[p.page].title,content:db.pages[p.page].content}:p.kind==='layout'?{positions:p.positions.map(n=>({id:n.id,x:db.nodes[n.id].x,y:db.nodes[n.id].y}))}:{kind:'task'};
  coreApplyProposal(id);
  if(p.kind==='task'&&p.nodeIds?.length)db.tasks[p.createdTask].nodeIds=[...p.nodeIds];
  p.appliedBy=ui.user;p.executor='ai';p.afterVersion=p.kind==='wiki'?db.pages[p.page].version:p.kind==='layout'?db.maps[p.map].version:db.tasks[p.createdTask].version;
  if(p.run&&db.agentRuns[p.run])db.agentRuns[p.run].state='applied';
}
function undoProposal(id){
  const p=db.proposals[id];if(!p||p.space!==ui.space||p.status!=='applied'||!p.undo)throw Error('Nie można cofnąć tej propozycji.');
  if(p.kind==='wiki'){
    const page=db.pages[p.page];if(page?.version!==p.afterVersion)throw Error('Wiki ma nowsze zmiany. Nie cofniemy cudzej pracy.');
    savePage(page.id,p.undo.title,p.undo.content);
  }else if(p.kind==='layout'){
    const mp=db.maps[p.map];if(mp?.version!==p.afterVersion)throw Error('Mapa ma nowsze zmiany. Cofnięcie zatrzymane.');
    p.undo.positions.forEach(pos=>Object.assign(db.nodes[pos.id],pos));mp.version++;
  }else if(p.kind==='task'){
    const t=db.tasks[p.createdTask];
    if(!t||t.version!==p.afterVersion||anchorFor('task:'+t.id)||usageOf('task:'+t.id).length||t.result||t.status!=='todo')throw Error('Zadanie jest już używane. Usuń lub zmień je świadomie zamiast cofać cudzą pracę.');
    delete db.tasks[t.id];
  }
  p.status='undone';p.undoneAt=now();if(p.run&&db.agentRuns[p.run])db.agentRuns[p.run].state='undone';
}
function messageHTML(m,inDrawer=false){
  let html=coreMessageHTML(m,inDrawer);
  if(m.author==='ai'){
    const r=db.agentRuns?.[m.agentRun];
    const extras=`<div class="agent-message-meta">${m.agentTrigger?`<span>${esc(m.agentTrigger)}</span>`:''}${r?.state==='running'?B('Anuluj','agent-cancel',`data-id="${r.id}"`,'small quiet'):''}${(m.agentSources||[]).length?`<details><summary>Użyty kontekst · ${m.agentSources.length}</summary><div class="agent-sources">${m.agentSources.filter(x=>canRef(x)).map(x=>renderRef(x)).join(' ')}</div></details>`:''}</div>`;
    html=html.replace('<div class="msg-actions">',extras+'<div class="msg-actions">');
  }
  return html;
}
function renderAgentPanel(){
  const space=db.spaces[ui.space],checked=db.agentChecked[ui.space],props=Object.values(db.proposals).filter(p=>p.space===ui.space&&p.status==='pending'),runs=Object.values(db.agentRuns).filter(r=>r.space===ui.space).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,5);
  return `<aside class="drawer agent-drawer" aria-label="Pomoc agenta projektu"><div class="drawer-head">${I('robot')}<span class="eyebrow">Flux · agent AI</span>${IB('x','Zamknij pomocnika','close-drawer')}</div><div class="drawer-body" id="drawer-scroll"><h2>Pomaga przy Twojej pracy.</h2><p class="context-intro">Polecenia zostają w rozmowie. Agent odpowiada pod własną tożsamością i pokazuje źródła.</p><div class="notice">${I('robot')} Wersja demonstracyjna · reguły lokalne, bez modelu LLM.</div><div class="agent-status"><span class="status-dot"></span><div><b>${space.ai?'Dostępny w otwartej aplikacji':'Wyłączony w tym projekcie'}</b><small>${checked?'Ostatnio sprawdzono '+time(checked.at):'Oczekuje na polecenie lub zapisanie wyniku'}. Po zamknięciu HTML nic nie pracuje.</small></div></div><section class="settings-section"><h3>Zleć w tej samej rozmowie</h3><div class="agent-quick">${[['podsumuj','Co się zmieniło?','leaf'],['ułóż','Uporządkuj wskazaną mapę','map'],['zadanie','Zaproponuj jeden krok','task'],['wiki','Dopisz wynik do wiki','wiki']].map(([id,label,icon])=>B(I(icon)+label,'agent-command',`data-command="${id}"`,'small')).join('')}</div><p class="hint">To wstawi edytowalne polecenie /ai. Ty je wysyłasz. @ wskazuje materiał.</p></section><section class="settings-section"><h3>Pomoc bez wywoływania</h3><label class="checkbox"><input type="checkbox" data-exp-change="agent-enabled" ${space.ai?'checked':''}> Agent dostępny w projekcie</label><label class="checkbox"><input type="checkbox" data-exp-change="agent-background" ${space.aiBackground!==false?'checked':''}> Przygotuj poprawkę wiki po wyniku zadania</label><p class="hint">Tylko gdy jest jedno jednoznaczne źródło. Odrzucony wariant nie wróci bez zmiany wyniku.</p></section><div class="agent-boundary">${I('lock')}<div><b>Kontekst: ${esc(space.name)}</b><p>Rozmowa, dozwolone materiały, zapisane zmiany. Bez innych projektów, prywatnych punktów powrotu i audio.</p></div></div>${props.length?`<section class="settings-section"><h3>Przygotowane · nieprzyjęte ustalenia</h3>${props.map(p=>proposalHTML(p.id)).join('')}</section>`:''}<details class="settings-section"><summary>Ostatnie wykonania · ${runs.length}</summary>${runs.map(r=>`<div class="run-row">${I('robot')}<div><b>${r.trigger==='result'?'Po wyniku zadania':'Polecenie z rozmowy'}</b><small>${esc(({running:'Pracuje',proposal:'Propozycja',completed:'Odpowiedziano',applied:'Zastosowano',cancelled:'Anulowano',failed:'Błąd',interrupted:'Przerwano',undone:'Cofnięto'})[r.state]||r.state)} · ${time(r.startedAt)}</small></div>${r.response?IB('arrow','Zobacz odpowiedź','jump-message',`data-id="${r.response}"`):''}</div>`).join('')}</details><p class="hint" style="margin-top:18px">Codex, Claude, API i MCP są opisane w README. Ten plik nie przyjmuje sekretów i nie łączy się z dostawcami.</p></div></aside>`;
}

/* ------------------ Together at the material, not a separate meeting app ------------------ */
function currentTargets(){
  if(ui.drawer?.kind==='object')return [ui.drawer.ref];
  if(ui.drawer?.kind==='comments')return ['message:'+ui.drawer.id];
  if(ui.view==='map')return ui.selected.length?ui.selected.map(id=>'node:'+id):ui.edge?['edge:'+ui.edge]:ui.map?['map:'+ui.map]:[];
  if(ui.view==='wiki'&&ui.page)return ['page:'+ui.page];
  return [];
}
function startSession(ref=null){
  if(ui.session){modal('live');return;}
  if(db.spaces[ui.space]?.kind==='private'){toast('Prywatny szkicownik nie jest pokojem rozmowy. Wybierz projekt lub DM.');return;}
  let targets=ref?[ref]:currentTargets();
  if(targets.some(x=>!canRef(x,ui.space)||refScope(x)!==ui.space))throw Error('Materiał spoza grona sesji.');
  const available=ui.availableSession?.space===ui.space?ui.availableSession:null;
  if(available){ui.session=available;ui.availableSession=null;ui.session.participants=[...new Set([...ui.session.participants,ui.user])];ui.session.eventIds=[];ui.session.messageIds=[];ui.session.joinedAt=now();}
  else ui.session={id:uid('live'),space:ui.space,owner:ui.user,origin:targets[0]||null,shown:targets,participants:[ui.user],createdAt:now(),joinedAt:now(),eventIds:[],messageIds:[],invited:[],following:false,offer:null,silent:false,quality:'text',recording:false};
  ui.live=true;ui.session.silent=false;ui.session.following=false;ui.mediaPending={};
  render();toast('Jesteś przy pracy. Mikrofon, kamera i ekran są wyłączone.');
}
function liveTitle(s){return s?.origin&&getObj(s.origin)?titleOf(s.origin):db.spaces[s?.space]?.name||'Wspólna praca';}
function renderLiveBar(){
  const s=ui.session;if(!s||!allowed(s.space))return '';
  const other=ui.space!==s.space;
  return `<section class="live-dock" aria-label="Aktywna sesja przy pracy"><button class="live-context" data-action="live-details">${I('headphones')}<span><b>${esc(short(liveTitle(s),40))}</b><small>${esc(db.spaces[s.space].name)} · ${s.participants.length} ${plural(s.participants.length,'osoba','osoby','osób')} · ${s.silent?'w ciszy':'sesja demo'}</small></span></button><div class="live-controls">${B(I('mic')+(ui.streams.audio?' Mikrofon wł.':' Mikrofon wył.'),'media-toggle','data-kind="audio"','small '+(ui.streams.audio?'soft':''))}${IB('camera',ui.streams.video?'Wyłącz kamerę':'Kamera — test lokalny','media-toggle','data-kind="video"',ui.streams.video?'active':'')}${IB('screen',ui.streams.screen?'Zatrzymaj ekran':'Ekran — test lokalny','media-toggle','data-kind="screen"',ui.streams.screen?'active':'')}${B(I('eye')+' Pokaż fragment','live-show-current','','small quiet')}${B(I('leaf')+(s.silent?' Wracam':' Cisza'),'live-silence','','small '+(s.silent?'soft':'quiet'))}${IB('x','Wyjdź z sesji i zatrzymaj urządzenia','leave-live')}</div>${other?`<div class="live-scope-warning">${I('lock')} Nadal rozmawiasz w ${esc(db.spaces[s.space].name)}. Przeglądanie innego projektu nie udostępnia jego treści.</div>`:''}${s.offer?`<div class="live-offer">${avatar(s.offer.actor,true)}<span>${esc(db.users[s.offer.actor]?.name)} pokazuje ${esc(short(titleOf(s.offer.refs[0]),45))}.</span>${B('Zobacz i podążaj','live-follow','','small soft')}${B('Zostań tutaj','live-dismiss-offer','','small quiet')}</div>`:s.following?`<div class="live-offer">${I('eye')} Podążasz za wskazanym materiałem.${B('Własny widok','live-stop-follow','','small quiet')}</div>`:''}</section>`;
}
function showToSession(refs){
  const s=ui.session;if(!s)throw Error('Najpierw rozpocznij sesję.');
  if(ui.space!==s.space)throw Error('To inny projekt niż sesja. Nie udostępniono materiału.');
  if(!refs.length)throw Error('Otwórz zadanie, stronę wiki albo zaznacz myśli na mapie.');
  if(refs.some(r=>!getObj(r)||refScope(r)!==s.space||!canRef(r,s.space)))throw Error('Ten materiał nie jest dostępny wszystkim w sesji.');
  s.shown=[...new Set(refs)];s.shownBy=ui.user;s.following=false;s.offer=null;
  render();toast('Pokazujesz natywny materiał. Nie uruchomiono przechwytywania ekranu.');
}
function receiveShared(refs,actor=null){
  const s=ui.session;if(!s)throw Error('Brak aktywnej sesji.');
  actor=actor||s.participants.find(id=>id!==ui.user);
  if(!actor||!s.participants.includes(actor)||refs.some(r=>refScope(r)!==s.space||!canRef(r,s.space)))throw Error('Nieprawidłowy kontekst uczestnika.');
  s.offer={refs:[...refs],actor};
  // Even in follow mode this demo offers the new object; no surprise navigation.
  render();
}
function showNative(refs){
  const r=refs[0],o=getObj(r);if(!o||!allowed(o.space))return;
  captureUI();if(ui.space!==o.space)setSpace(o.space);
  const type=r.split(':')[0];
  if(type==='map'||type==='node'||type==='edge'){
    ui.view='map';ui.map=type==='map'?o.id:o.map;ui.drawer=null;ui.selected=refs.filter(x=>x.startsWith('node:')).map(x=>x.split(':')[1]);ui.edge=type==='edge'?o.id:null;render();requestAnimationFrame(()=>fitMap(ui.selected.length?ui.selected:null));
  }else if(type==='page'){ui.view='wiki';ui.page=o.id;ui.wikiEdit=false;ui.drawer=null;render();}
  else if(type==='fragment'){action('locate-fragment',{dataset:{id:o.id}});}
  else openRef(r);
}
function adoptShared(){const s=ui.session;if(!s?.offer)return;const refs=s.offer.refs;s.shown=refs;s.shownBy=s.offer.actor;s.offer=null;s.following=true;showNative(refs);}
function endLiveSession(quiet=false){
  const s=ui.session;if(!s){stopMedia();ui.live=false;return;}
  captureUI();stopMedia();
  const events=db.activity.filter(e=>s.eventIds.includes(e.id)&&e.space===s.space),unique=new Map();
  events.forEach(e=>unique.set(e.ref||e.kind,e));
  const changes=[...unique.values()].filter(e=>e.ref&&getObj(e.ref));
  const archive={id:s.id,space:s.space,origin:s.origin,startedAt:s.joinedAt,endedAt:now(),participants:[...s.participants],eventIds:events.map(e=>e.id),messageIds:[...new Set(s.messageIds)],summary:null};
  if(changes.length&&db.spaces[s.space]?.members.includes(ui.user)){
    withScope(s.space,ui.user,()=>{
      const parent=s.origin?(s.origin.startsWith('message:')?rootId(s.origin.split(':')[1]):ensureAnchor(s.origin)):null;
      const m=createMessage({space:s.space,parent,author:'ai',text:'Zapis czynności z naszej sesji — bez nagrania i bez transkrypcji.\n\n'+changes.map(e=>`${({blocker:'Zgłoszona przeszkoda',unblocked:'Odblokowanie',result:'Zapisany wynik',done:'Zakończenie',wiki:'Zmiana wiki',task:'Zmiana zadania'})[e.kind]||'Zmiana'}: [[${e.ref}]]${e.source?' · [[message:'+e.source+']]':''}`).join('\n')});
      m.sessionSummary=s.id;m.agentTrigger='Dziennik operacji, nie notatki z audio';archive.summary=m.id;
    });
  }
  db.sessionsArchive[archive.id]=archive;ui.lastSessionSummary=archive.id;
  s.participants=s.participants.filter(x=>x!==ui.user);s.silent=false;s.following=false;
  ui.availableSession=s.participants.length?s:null;ui.session=null;ui.live=false;
  db.notifications=db.notifications.filter(n=>n.kind!=='live'||n.session!==s.id||n.user!==ui.user);
  persist();
  if(!quiet){closeModal();render();toast(changes.length?'Wyszedłeś. Zapis czynności jest w rozmowie źródłowej.':'Wyszedłeś. Nie tworzę pustego raportu po sesji.');}
  return archive;
}
function renderLiveDetails(){
  const s=ui.session;if(!s)return;
  const participants=s.participants.map(id=>`<div class="live-person">${avatar(id)}<div><b>${esc(db.users[id]?.name)} ${id===ui.user?'· Ty':'· demo'}</b><small>${id===ui.user?(s.silent?'Pracuje w ciszy':ui.streams.audio?'Mikrofon: test lokalny':'Mikrofon wyłączony'):'Symulowana obecność · nie słyszy urządzeń'}</small></div><span class="pill">${I('headphones')}</span></div>`).join('');
  const candidates=db.spaces[s.space].members.filter(id=>id!==ui.user&&!s.participants.includes(id));
  const body=`<div class="live-room-title"><div class="project-symbol">${I('headphones')}</div><div><span class="eyebrow">Razem przy pracy</span><h3>${esc(liveTitle(s))}</h3><small>${esc(db.spaces[s.space].name)}</small></div></div><p class="context-intro">Nie ma dzwonka ani automatycznej kamery. Sesja pozostaje przy swoim materiale, również gdy przejdziesz do innej zakładki.</p><div class="notice">Demonstracja lokalna. Nikt zdalnie Cię nie widzi ani nie słyszy.</div>${participants}<div class="row wrap" style="margin-top:14px">${candidates.map(id=>B(s.invited.includes(id)?'Zaproszenie wysłane':'Zaproś '+esc(db.users[id].name),'live-invite',`data-user="${id}"`,'small')).join('')}</div><div class="settings-section"><div class="row between"><h3>Wspólny fragment</h3>${B('Pokaż otwarty materiał','live-show-current','','small quiet')}</div><p class="hint">To obiekty Fluxa, nie film z pulpitu. Zmiana własnego widoku nie zmienia tego fragmentu.</p><div class="live-shared">${s.shown.length?withScope(s.space,ui.user,()=>s.shown.map(r=>material(r,'',true)).join('')):'<p class="hint">Na razie rozmowa. Otwórz materiał i świadomie wybierz „Pokaż fragment”.</p>'}</div>${B('Otwórz wspólny fragment','live-open-shared','','small')}${B('Rozmowa źródłowa','live-source','','small quiet')}</div><div class="settings-section"><h3>Urządzenia · test lokalny</h3><div class="live-device-buttons">${B(I('mic')+(ui.streams.audio?' Wyłącz mikrofon':' Włącz mikrofon'),'media-toggle','data-kind="audio"','small')}${B(I('camera')+(ui.streams.video?' Wyłącz kamerę':' Włącz kamerę'),'media-toggle','data-kind="video"','small')}${B(I('screen')+(ui.streams.screen?' Zatrzymaj ekran':' Wybierz ekran'),'media-toggle','data-kind="screen"','small')}</div><label for="live-quality" style="margin-top:16px">Sposób przechwytywania ekranu</label><select id="live-quality" data-exp-change="live-quality"><option value="text" ${s.quality==='text'?'selected':''}>Czytelny tekst · cel do 1440p / 15 fps</option><option value="motion" ${s.quality==='motion'?'selected':''}>Płynne demo · cel do 1080p / 60 fps</option></select><p class="hint" style="margin-top:8px">Preferencja następnego przechwytywania, nie gwarancja jakości. Doboru okna dokonujesz w przeglądarce.</p><video id="live-video" class="live-preview" autoplay playsinline muted ${ui.streams.video||ui.streams.screen?'':'hidden'}></video>${ui.streams.screen?'<div class="notice warning">Udostępniasz wybrane źródło systemowe lokalnie. Zmiana okna w systemie może pokazać dane spoza Fluxa.</div>':''}<div class="agent-boundary" style="margin-top:16px">${I('robot')}<div><b>Agent nie słucha audio.</b><p>Może korzystać z zapisanych czynności w projekcie. Nagrywanie i transkrypcja nie są tu podłączone.</p></div></div></div><details class="settings-section"><summary>Scenariusze demonstracyjne</summary><div class="row wrap" style="margin-top:12px">${B('Kolega dołącza · demo','live-demo-join','','small')}${B('Kolega pokazuje wiki · demo','live-demo-show','','small')}${B('Kolega wychodzi · demo','live-demo-leave','','small')}</div><p class="hint" style="margin-top:8px">Te przyciski nie uruchamiają prawdziwego połączenia.</p></details>`;
  modalShell('Zróbmy to razem',body,B(I('leaf')+(s.silent?' Wracam':' Pracuję w ciszy'),'live-silence','','quiet')+B('Wyjdź','leave-live','','quiet')+B('Wróć do pracy','close-modal','','primary'),true);
  const v=$('#live-video');if(v&&(ui.streams.screen||ui.streams.video))v.srcObject=ui.streams.screen||ui.streams.video;
}
async function mediaToggle(kind){
  const s=ui.session;if(!s){toast('Najpierw rozpocznij sesję przy pracy.');return;}
  if(s.silent){toast('Najpierw wróć z ciszy. Urządzenia nadal pozostaną wyłączone.');return;}
  if(ui.streams[kind]){
    ui.streams[kind].getTracks().forEach(t=>t.stop());delete ui.streams[kind];render();return;
  }
  ui.mediaPending=ui.mediaPending||{};
  if(ui.mediaPending[kind]){toast('Oczekuję na wybór w przeglądarce.');return;}
  const request={epoch:ui.mediaGeneration||0,session:s.id,user:ui.user};ui.mediaPending[kind]=request;
  try{
    if(!navigator.mediaDevices)throw Error('Urządzenia wymagają HTTPS lub localhost i uprawnień przeglądarki.');
    const constraints=s.quality==='motion'?{width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60}}:{width:{ideal:2560},height:{ideal:1440},frameRate:{ideal:15}};
    const stream=kind==='screen'?await navigator.mediaDevices.getDisplayMedia({video:constraints,audio:false}):await navigator.mediaDevices.getUserMedia(kind==='audio'?{audio:{echoCancellation:true,noiseSuppression:true},video:false}:{video:{width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}},audio:false});
    if((ui.mediaGeneration||0)!==request.epoch||ui.session?.id!==request.session||ui.user!==request.user||ui.session?.silent){stream.getTracks().forEach(t=>t.stop());return;}
    ui.streams[kind]=stream;
    if(kind==='screen')stream.getVideoTracks?.().forEach(t=>{try{t.contentHint=s.quality==='motion'?'motion':'detail';}catch(e){}});
    stream.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(ui.streams[kind]===stream){delete ui.streams[kind];render();}}));
    render();toast('Urządzenie działa wyłącznie lokalnie. Nie ma transmisji do kolegi.');
  }catch(e){toast('Nie uruchomiono urządzenia. '+(e.name==='NotAllowedError'?'Dostęp nie został udzielony.':e.message));}
  finally{if(ui.mediaPending[kind]===request)delete ui.mediaPending[kind];}
}
function stopMedia(){
  ui.mediaGeneration=(ui.mediaGeneration||0)+1;
  for(const s of Object.values(ui.streams||{}))s.getTracks().forEach(t=>t.stop());
  ui.streams={};ui.mediaPending={};
}
function renderModal10(){
  if(ui.modal?.type==='live'){renderLiveDetails();return;}
  if(ui.modal?.type==='session-summary'){
    const s=db.sessionsArchive[ui.modal.id];if(!s||!allowed(s.space)){closeModal();return;}
    modalShell('Co zostało po sesji',`<p class="context-intro">Wyłącznie zapisane operacje i wiadomości. Bez podsłuchiwania, nagrania i automatycznej transkrypcji.</p>${s.summary?material('message:'+s.summary):'<p class="hint">Nie zapisano zmian wymagających podsumowania.</p>'}`,B('Zamknij','close-modal','','primary'));return;
  }
  renderCoreModal();
}

/* One dispatcher for the added flows. All work mutations use core commands. */
function experienceAction(a,el){
  const d=el?.dataset||{};
  if(['view','space','navigate-home','open-ref','jump-message','locate-map','locate-page','locate-fragment'].includes(a)&&ui.session)ui.session.following=false;
  switch(a){
    case 'return-open':openReview(d.space||ui.space);return true;
    case 'return-refresh':openReview(ui.review?.space||ui.space);return true;
    case 'return-ack':ackReview();return true;
    case 'return-chat':ui.drawer=null;ui.reviewBack=null;ui.view='chat';ui.flash=null;render();return true;
    case 'return-back':if(ui.review&&allowed(ui.review.space)){if(ui.space!==ui.review.space)setSpace(ui.review.space);ui.drawer={kind:'review'};ui.view='chat';ui.flash=null;ui.scrollEnd=false;render();}return true;
    case 'brief-ref':openRef(d.ref);return true;
    case 'brief-source':jumpMessage(d.id);return true;
    case 'return-ai':startPrivateBrief();return true;
    case 'demo-week':simulateAbsence(7);return true;
    case 'agent-panel':captureUI();ui.agentContext=currentTargets();ui.drawer={kind:'agent'};ui.flash=null;ui.scrollEnd=false;render();return true;
    case 'agent-command':{
      const targets=ui.agentContext||[];let text='/ai podsumuj zapisane zmiany i pokaż źródła';
      if(d.command==='ułóż'){let ref=targets.find(r=>r.startsWith('map:'))||targets.find(r=>r.startsWith('node:'))||(ui.map&&db.maps[ui.map]?.space===ui.space?'map:'+ui.map:null);text='/ai ułóż '+(ref?'[['+ref+']]':'@mapa')+' — tylko rozmieszczenie, bez zmiany treści';}
      if(d.command==='zadanie')text='/ai zadanie: Sprawdzić jeden kolejny krok';
      if(d.command==='wiki'){const tr=targets.find(r=>r.startsWith('task:'))||Object.values(db.tasks).find(t=>t.space===ui.space&&t.result)&&('task:'+Object.values(db.tasks).find(t=>t.space===ui.space&&t.result).id);const page=Object.values(db.pages).find(p=>p.space===ui.space);text='/ai dopisz wynik '+(tr?'[['+tr+']]':'@zadanie')+' do '+(page?'[[page:'+page.id+']]':'@wiki');}
      ui.drawer=null;ui.view='chat';const key='chat:'+ui.space,old=prefs().drafts[key]||'';
      prefs().drafts[key]=old.trim()?(old.startsWith('/ai')?old:'/ai '+old):text;
      ui.scrollEnd=false;render();const ed=editorFor(key);ed?.focus();if(ed)caretAtText(ed,ed.textContent.length);persist();return true;
    }
    case 'agent-cancel':{
      const r=db.agentRuns[d.id];if(r&&r.space===ui.space&&r.state==='running'){clearTimeout(ui.runTimers[r.id]);r.state='cancelled';r.finishedAt=now();db.messages[r.response].text='Anulowano. Nie wykonano zmiany.';persist();render();}return true;
    }
    case 'proposal-undo':transact('agent.undo',()=>undoProposal(d.id));return true;
    case 'live':if(ui.session)modal('live');else startSession(d.ref||null);return true;
    case 'start-live':startSession(d.ref||null);return true;
    case 'live-details':if(ui.session)modal('live');return true;
    case 'leave-live':endLiveSession();return true;
    case 'live-show-current':try{showToSession(currentTargets());}catch(e){toast(e.message)}return true;
    case 'live-open-shared':{const refs=ui.session?.shown||[];closeModal();if(refs.length)showNative(refs);else toast('Jeszcze nie wskazano wspólnego materiału.');return true;}
    case 'live-source':{const s=ui.session;if(s){closeModal();if(ui.space!==s.space)setSpace(s.space);if(s.origin)openRef(s.origin);else{ui.view='chat';ui.drawer=null;render();}}return true;}
    case 'live-silence':if(ui.session){const silent=!ui.session.silent;stopMedia();ui.session.silent=silent;render();toast(silent?'Pracujesz w ciszy. Urządzenia są zatrzymane.':'Wróciłeś. Mikrofon, kamera i ekran nadal są wyłączone.');}return true;
    case 'media-toggle':mediaToggle(d.kind);return true;
    case 'live-invite':{
      const s=ui.session;if(!s||!db.spaces[s.space].members.includes(d.user)||s.participants.includes(d.user))return true;
      if(!s.invited.includes(d.user)){s.invited.push(d.user);db.notifications.push({id:uid('notif'),kind:'live',space:s.space,user:d.user,session:s.id,ref:s.origin||null,text:db.users[ui.user].name+' zaprasza do wspólnej pracy. Możesz dołączyć, gdy będziesz gotowy.',at:now(),read:false});persist();}
      renderModal();toast('Jedno zaproszenie bez dzwonka. Nie tworzy nieodebranego połączenia.');return true;
    }
    case 'open-notification':{const n=db.notifications.find(n=>n.id===d.id);if(n?.kind==='live'){if(n.user!==ui.user||!allowed(n.space))return true;n.read=true;if(ui.availableSession?.id===n.session){setSpace(n.space);startSession();}else toast('Ta lokalna sesja nie jest już dostępna. Zaproszenie nie jest zaległym zadaniem.');persist();return true;}return false;}
    case 'live-demo-join':{
      const s=ui.session;if(!s)return true;const other=db.spaces[s.space].members.find(id=>!s.participants.includes(id));
      if(other)s.participants.push(other);render();toast(other?'Dodano uczestnika demonstracyjnego. Nie ma zdalnego audio.':'Wszyscy uczestnicy projektu są już w tej sesji demo.');return true;
    }
    case 'live-demo-leave':{const s=ui.session;if(s){const id=s.participants.find(x=>x!==ui.user);s.participants=s.participants.filter(x=>x!==id);s.offer=null;s.following=false;render();}return true;}
    case 'live-demo-show':{
      const s=ui.session;if(!s)return true;const page=Object.values(db.pages).find(p=>p.space===s.space);const actor=s.participants.find(x=>x!==ui.user);
      if(!actor){toast('Najpierw dodaj uczestnika demonstracyjnego.');return true;}if(page){closeModal();receiveShared(['page:'+page.id],actor);}return true;
    }
    case 'live-follow':adoptShared();return true;
    case 'live-dismiss-offer':if(ui.session){ui.session.offer=null;render();}return true;
    case 'live-stop-follow':if(ui.session){ui.session.following=false;render();}return true;
    case 'last-session':if(ui.lastSessionSummary)modal('session-summary',{id:ui.lastSessionSummary});return true;
  }
  return false;
}
document.addEventListener('change',e=>{
  const k=e.target.dataset.expChange;if(!k)return;
  if(k==='agent-enabled'){db.spaces[ui.space].ai=e.target.checked;if(!e.target.checked)for(const r of Object.values(db.agentRuns))if(r.space===ui.space&&r.state==='running'){clearTimeout(ui.runTimers[r.id]);r.state='cancelled';db.messages[r.response].text='Agent wyłączony. Nie wykonano zmiany.';}persist();render();}
  if(k==='agent-background'){db.spaces[ui.space].aiBackground=e.target.checked;persist();}
  if(k==='live-quality'&&ui.session){ui.session.quality=e.target.value;toast('Preferencja zadziała przy następnym wyborze ekranu.');}
});
document.addEventListener('pointerdown',e=>{if(ui.session?.following&&e.target.closest('#map-canvas'))ui.session.following=false;});
