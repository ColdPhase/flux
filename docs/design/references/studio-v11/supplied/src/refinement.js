/* Flux Studio 11 — privacy-bound return, searchable work, portable projects.
   Local UI implementation. Private briefs are extractive DEMO, not LLM output.
   Server-side identity, encryption, integrations and media transmission are not implemented. */
function paletteDefs(){return [
 ['mint','Mięta','#8ed8b8'],['iris','Irys','#b7a8ef'],['amber','Miód','#e7c17f'],
 ['teal','Laguna','#79cfcc'],['sky','Błękit','#94bcf3'],['copper','Terakota','#e9ac8d'],
 ['rose','Róża','#dfa7bc'],['lime','Oliwka','#c1cf8c'],['slate','Grafit','#b8c3d0']
];}
function seed(){return normalizeRefinement(seed10());}
function normalizeRefinement(d){
  for(const p of Object.values(d.prefs||{})){
    p.visits=p.visits&&typeof p.visits==='object'?p.visits:{};
    p.privateBriefs=p.privateBriefs&&typeof p.privateBriefs==='object'?p.privateBriefs:{};
  }
  for(const s of Object.values(d.spaces||{}))s.goalInfo=s.goalInfo||{criteria:'',taskIds:[],status:'active',history:[]};
  // Hierarchy is a list presentation. Ordinary graph edges keep the same semantics.
  const parents={n1:'n0',n2:'n0',n3:'n1',n4:'n1'};
  for(const [id,parent] of Object.entries(parents))if(d.nodes[id]&&d.nodes[parent]&&!d.nodes[id].outlineParent&&Object.values(d.edges).some(e=>e.a===parent&&e.b===id))d.nodes[id].outlineParent=parent;
  for(const t of Object.values(d.tasks||{}))if(t.effort&&!validEffort(t.effort.value,t.effort.unit))delete t.effort;
  return d;
}
function initRefinement(){
  ui.queries={};ui.outlineCollapsed={};ui.mapSearchOpen=false;ui.privateScope='project';
  ui.visitBase={};ui.activeVisit=null;ui.privateToken=0;ui.privateBusy=false;
  window.Flux11={normalize:normalizeRefinement,openReview,startPrivateBrief,buildPrivateBrief,reviewCursor,
    beginVisit,finishVisit,touchVisit,buildOutline,effortLabel,parseEffort,
    exportWorkspace,validateWorkspaceArchive,importWorkspace,privateWindow,
    get visit(){return ui.activeVisit},get summary(){return ui.review?.privateResult},
    get queries(){return ui.queries},paletteDefs,validateDeepArchive};
}
function resetRefinement(){if(typeof ui==='undefined')return;ui.activeVisit=null;ui.visitBase={};ui.queries={};ui.outlineCollapsed={};ui.privateToken=(ui.privateToken||0)+1;ui.privateBusy=false;ui.privateScope='project';ui.review=null;ui.reviewBack=null;ui.mapSearchOpen=false;}
function visitRecord(space){return prefs().visits?.[space]||null;}
function touchVisit(){
  const v=ui.activeVisit;if(!v||v.user!==ui.user||!allowed(v.space)||document.hidden)return;
  prefs().visits=prefs().visits||{};prefs().visits[v.space]={at:now(),through:maxActivity(v.space)};persist();
}
function finishVisit(){
  const v=ui.activeVisit;if(v&&v.user===ui.user&&allowed(v.space)){
    prefs().visits=prefs().visits||{};prefs().visits[v.space]={at:now(),through:maxActivity(v.space)};persist();
  }ui.activeVisit=null;
}
function beginVisit(space){
  if(!allowed(space)||document.hidden)return;
  if(ui.activeVisit?.space===space&&ui.activeVisit.user===ui.user)return;
  finishVisit();
  const last=visitRecord(space)||prefs().review?.[space]||{at:null,through:0};
  ui.visitBase=ui.visitBase||{};ui.visitBase[space]=copy(last);
  ui.activeVisit={space,user:ui.user,startedAt:now()};touchVisit();
}
function reviewCursor(space){
  const seen=(ui.activeVisit?.space===space?ui.visitBase?.[space]:visitRecord(space))||prefs().review?.[space]||{through:0,at:null};
  const ack=prefs().review?.[space];
  return ack?.at&&(!seen.at||Date.parse(ack.at)>Date.parse(seen.at))?ack:seen;
}
function setSpace(id){if(!allowed(id))return setSpace10(id);if(ui.space!==id||ui.view==='home')finishVisit();const ok=setSpace10(id);if(ok)beginVisit(id);ui.mapSearchOpen=false;return ok;}
function render(){
  if(ui.view==='home'&&ui.activeVisit)finishVisit();
  else if(ui.view!=='home'&&!ui.activeVisit)beginVisit(ui.space);
  render10();
  // Keep the whole board/table scrolling locally; restore query input caret via captureUI.
  if(ui.view==='map'&&ui.mapView==='list'&&ui.outlineFocus){requestAnimationFrame(()=>{document.querySelector(`[data-outline-open="${CSS.escape(ui.outlineFocus)}"]`)?.focus({preventScroll:true});ui.outlineFocus=null;});}
}
function whenLabel(at){return !at?'od początku projektu':new Date(at).toLocaleString('pl-PL',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});}
function renderSidebar(){
 let h=renderSidebar10().replace('Znajdź we Fluxie <kbd>Ctrl K</kbd>','<span class="search-launch-label">Znajdź we Fluxie</span><kbd>⌘ / Ctrl K</kbd>');
 return h;
}
function goalLabel(s){if(!s.goal)return 'Ustal następny cel';return (s.goalInfo?.status==='achieved'?'Osiągnięto: ':'Cel: ')+s.goal;}
function renderHeader(){
 if(ui.view==='home')return renderHeader10();
 const s=db.spaces[ui.space],b=briefModel(ui.space),n=b.needs.length||b.changes.length;
 const name=s.kind==='dm'?db.users[s.members.find(u=>u!==ui.user)]?.name:s.name;
 return `<header class="header compact-header"><div class="head-top">${IB('menu','Otwórz nawigację','toggle-sidebar','','mobile-only')}<span class="project-symbol">${I(s.icon||'spark')}</span><div class="grow"><div class="head-name">${esc(name)}</div><div class="head-context"><span class="members-label" title="${esc(s.members.map(id=>db.users[id]?.name).join(', '))}">${I('lock')}${s.kind==='private'?'Tylko Ty':s.members.length+' '+plural(s.members.length,'osoba','osoby','osób')}</span>${s.kind==='project'?`<button class="goal-chip ${s.goalInfo?.status==='achieved'?'achieved':''}" data-action="goal-open" title="${esc(goalLabel(s))}">${I(s.goalInfo?.status==='achieved'?'check':'flag')}<span>${esc(goalLabel(s))}</span>${I('down')}</button>`:''}</div></div><div class="head-controls">${s.kind!=='private'?B(I('headphones')+'<span class="live-label"> Razem</span>','live','','live-button quiet small'):''}${IB('robot','Agent projektu — polecenia i propozycje','agent-panel','','head-ai')}${IB('settings','Ustawienia projektu','project-settings')}${IB('sun','Jasne / ciemne tło','toggle-theme','','theme-toggle')}</div></div><div class="tabs-row"><nav class="tabs" aria-label="Widoki projektu">${[['chat','chat','Rozmowa'],['map','map','Mapa'],['tasks','task','Zadania'],['wiki','wiki','Wiki']].map(([view,icon,label])=>`<button class="tab ${ui.view===view?'active':''}" data-action="view" data-view="${view}" ${ui.view===view?'aria-current="page"':''}>${I(icon)}<span>${label}</span></button>`).join('')}</nav><button class="catchup-button ${ui.drawer?.kind==='review'?'active':''}" data-action="return-open" data-space="${ui.space}" title="Twój prywatny skrót od ostatniej wizyty">${I('leaf')}<span>Co ważne</span>${n?`<b>${n}</b>`:''}</button></div></header>`;
}
function renderReturnStrip(){return '';}
function renderHome(){
 let h=renderHome10();
 h=h.replace(/<button class="btn [^"]*" data-action="demo-week"[^>]*>[\s\S]*?<\/button>/,'');
 h=h.replace('Najpierw aktualny stan i sprawy do Ciebie. Historię otwierasz tylko wtedy, gdy jej potrzebujesz.','Od ostatniej wizyty w każdym projekcie. Prywatny skrót, źródła i Twoje następne kroki.');
 return h;
}
/* Private catch-up. A window is a stable snapshot, independent from chat read receipts. */
function privateWindow(space,customAt=null){
 const c=reviewCursor(space),since=customAt||c.at;
 return {space,from:customAt?Math.max(0,...db.activity.filter(e=>e.space===space&&Date.parse(e.at)<=Date.parse(since)).map(e=>e.seq)):c.through,
   until:maxActivity(space),baselineAt:since,at:now()};
}
function openReview(space=ui.space,customAt=null){
 if(!allowed(space)){toast('Nie masz dostępu do tego projektu.');return;}
 captureUI();const previous={view:ui.view,space:ui.space,drawer:ui.drawer,chat:$('#chat-scroll')?.scrollTop||0};
 if(ui.space!==space||ui.view==='home')setSpace(space);else beginVisit(space);
 const win=privateWindow(space,customAt);
 ui.privateToken=(ui.privateToken||0)+1;ui.privateBusy=false;
 ui.review={...win,model:copy(briefModel(space,win.from,win.until)),privateResult:null,scope:ui.privateScope||'project'};
 ui.reviewBack=previous;ui.drawer={kind:'review'};ui.scrollEnd=false;ui.flash=null;
 const cached=prefs().privateBriefs?.[space];
 if(cached&&cached.scope===ui.review.scope&&cached.baselineAt===win.baselineAt&&cached.untilAt===win.at)ui.review.privateResult=cached;
 render();
}
function relevantMessage(m,user){
 if(m.author===user||refsIn(m.text).includes('person:'+user))return true;
 const root=db.messages[rootId(m.id)];if(root?.author===user)return true;
 const ids=new Set([m.id,root?.id]);
 return Object.values(db.tasks).some(t=>t.space===m.space&&(t.assignee===user||activeBlockers(t.id).some(e=>e.helper===user))&&
    (ids.has(t.source)||ids.has(anchorFor('task:'+t.id))||m.primary==='task:'+t.id||refsIn(m.text).includes('task:'+t.id)||t.result===m.id));
}
function buildPrivateBrief(space,baselineAt,untilAt,scope='project',user=ui.user){
 if(user!==ui.user||!allowed(space))throw Error('Brak dostępu do prywatnego skrótu.');
 const start=baselineAt?Date.parse(baselineAt):0,end=Date.parse(untilAt);
 const all=Object.values(db.messages).filter(m=>m.space===space&&m.author!=='ai'&&Date.parse(m.at)>start&&Date.parse(m.at)<=end&&m.text.trim()).sort((a,b)=>a.at.localeCompare(b.at));
 const selected=scope==='mine'?all.filter(m=>relevantMessage(m,user)):all;
 const grouped=new Map();
 for(const m of selected){const root=rootId(m.id);if(!grouped.has(root))grouped.set(root,[]);grouped.get(root).push(m);}
 // Extractive local fallback: quotes and explicit outcomes, never inferred decisions.
 const groups=[...grouped.entries()].map(([root,ms])=>{
   const source=db.messages[root],last=ms.at(-1),primary=source?.primary;
   const text=primary&&getObj(primary)?titleOf(primary):short(plain(source?.text||last.text),90);
   const refs=[...new Set(ms.flatMap(m=>[...(m.primary?[m.primary]:[]),...refsIn(m.text)]))].filter(r=>canRef(r,space)&&!r.startsWith('person:'));
   return {root,title:text,first:ms[0].id,last:last.id,excerpt:last.text,count:ms.length,refs:refs.slice(0,3),version:last.version,at:last.at};
 }).sort((a,b)=>b.at.localeCompare(a.at));
 const tasks=Object.values(db.tasks).filter(t=>t.space===space&&(scope==='project'||t.assignee===user||activeBlockers(t.id).some(e=>e.helper===user)));
 const results=tasks.filter(t=>t.result&&Date.parse(db.messages[t.result]?.at)>start&&Date.parse(db.messages[t.result]?.at)<=end).map(t=>({task:t.id,message:t.result,text:db.messages[t.result].text}));
 return {user,space,scope,baselineAt,untilAt,createdAt:now(),method:'extractive-demo',messageCount:selected.length,allMessageCount:all.length,groups,results};
}
function startPrivateBrief(){
 const r=ui.review;if(!r||!allowed(r.space))return;
 const token=++ui.privateToken,user=ui.user,snapshot=copy(r);ui.privateBusy=true;r.privateResult=null;render();
 setTimeout(()=>{
   if(token!==ui.privateToken||ui.user!==user||!ui.review||ui.review.space!==snapshot.space||!allowed(snapshot.space))return;
   try{
     const result=buildPrivateBrief(snapshot.space,snapshot.baselineAt,snapshot.at,snapshot.scope,user);
     ui.review.privateResult=result;ui.privateBusy=false;
     prefs().privateBriefs=prefs().privateBriefs||{};prefs().privateBriefs[snapshot.space]=copy(result);persist();render();
   }catch(err){ui.privateBusy=false;toast(err.message);render();}
 },280);
}
function renderPrivateBrief(){
 const r=ui.review,s=r.privateResult;
 const count=Object.values(db.messages).filter(m=>m.space===r.space&&m.author!=='ai'&&Date.parse(m.at)>(r.baselineAt?Date.parse(r.baselineAt):0)&&Date.parse(m.at)<=Date.parse(r.at)).length;
 return `<section class="private-brief" aria-label="Prywatne podsumowanie"><div class="row between"><span class="eyebrow">${I('lock')} Tylko dla Ciebie</span><span class="pill">AI · demo</span></div><h3>Wróć do rozmowy bez nadrabiania.</h3><p>Wybierz zakres. Skrót pojawi się tutaj — nikt nie dostanie wiadomości na czacie.</p><div class="segmented summary-scope"><button data-action="summary-scope" data-value="project" class="${r.scope==='project'?'active':''}" aria-pressed="${r.scope==='project'}">Cały projekt</button><button data-action="summary-scope" data-value="mine" class="${r.scope==='mine'?'active':''}" aria-pressed="${r.scope==='mine'}">Dotyczy mnie</button></div>${B(I('spark')+(ui.privateBusy?' Przygotowuję…':s?' Odśwież mój skrót':' Podsumuj rozmowy dla mnie'),'private-summary','','primary summary-generate'+(ui.privateBusy?' busy':''))}<div class="summary-disclosure">W tym HTML: wybór cytatów i zapisanych wyników, bez LLM. ${count} wiadomości w wybranym okresie.</div>${ui.privateBusy?'<div class="private-loading" role="status">Zbieram źródła z tego zakresu…</div>':''}${s?`<div class="private-summary-result" aria-live="polite"><div class="row between"><b>Twój skrót</b><small>${s.messageCount} wiadomości · ${s.groups.length} rozmów</small></div>${!s.groups.length?'<p class="hint">Brak wypowiedzi w tym zakresie. Otwarte prośby poniżej nadal mogą wymagać reakcji.</p>':''}${s.results.length?`<h4>Zapisane wyniki</h4>${s.results.map(x=>`<div class="summary-item"><b>${esc(db.tasks[x.task]?.title||'Zadanie')}</b><p>${esc(short(plain(x.text),240))}</p>${B('Wynik u źródła','brief-source',`data-id="${x.message}"`,'small quiet')}</div>`).join('')}`:''}${s.groups.length?'<h4>W rozmowach — ostatnie wypowiedzi</h4>':''}${s.groups.slice(0,6).map(g=>summaryGroup(g)).join('')}${s.groups.length>6?`<details><summary>Pozostałe rozmowy · ${s.groups.length-6}</summary>${s.groups.slice(6).map(g=>summaryGroup(g)).join('')}</details>`:''}<p class="hint">Cytat nie oznacza przyjętej decyzji. Powiązania i źródła sprawdzisz jednym kliknięciem.</p></div>`:''}</section>`;
}
function summaryGroup(g){
 const current=db.messages[g.last],changed=current&&current.version!==g.version;
 return `<div class="summary-item"><b>${esc(g.title)}</b><blockquote>${esc(short(plain(g.excerpt),220))}</blockquote><div class="row wrap">${B(I('chat')+' Zobacz rozmowę','brief-source',`data-id="${g.last}"`,'small quiet')}<small>${g.count} ${plural(g.count,'wypowiedź','wypowiedzi','wypowiedzi')}</small>${changed?'<span class="pill warn">Źródło edytowano</span>':''}</div>${g.refs.length?`<div class="summary-refs">${g.refs.map(r=>renderRef(r)).join(' ')}</div>`:''}</div>`;
}
function renderReview(){
 const r=ui.review;if(!r||!allowed(r.space))return '';
 const b=r.model,newChanges=maxActivity(r.space)>r.until||Object.values(db.messages).some(m=>m.space===r.space&&Date.parse(m.at)>Date.parse(r.at));
 return `<aside class="drawer review-drawer" aria-label="Twój prywatny skrót projektu"><div class="drawer-head"><span class="eyebrow">${I('leaf')} Co ważne</span>${B('Odśwież','return-refresh','','small quiet')}${IB('x','Wróć do pracy','close-drawer')}</div><div class="drawer-body" id="drawer-scroll"><div class="brief-intro"><h2>${esc(db.spaces[r.space].name)}</h2><div class="summary-period"><span>Od ${r.baselineAt?esc(whenLabel(r.baselineAt)):'początku'}</span>${B('Zmień okres','summary-period','','small quiet')}</div><small>${r.custom?'Wybrany okres':'Od ostatniej wizyty / ostatniego obejrzanego skrótu'}. Stan przeczytania czatu pozostaje osobny.</small></div>${renderPrivateBrief()}${newChanges?`<div class="brief-update">${I('history')} Doszły nowsze zmiany. Skrót nie przestawia się podczas czytania.${B('Odśwież','return-refresh','','small')}</div>`:''}<section class="brief-section"><h3>Potrzebuje Ciebie <span>${b.needs.length}</span></h3>${b.needs.length?b.needs.map(briefCard).join(''):'<p class="hint">Nie ma otwartej prośby o pomoc ani pilnego terminu dla Ciebie.</p>'}</section><section class="brief-section"><h3>Zapisane zmiany <span>${b.changes.length}</span></h3>${b.changes.length?b.changes.map(briefCard).join(''):'<p class="hint">Brak nowych oznaczonych zmian. Luźne wypowiedzi sprawdzisz w skrócie rozmów powyżej.</p>'}</section>${b.signals.length?`<details class="brief-section"><summary>Wzmianki i odpowiedzi · ${b.signals.length}</summary>${b.signals.map(n=>`<button class="notification" data-action="brief-ref" data-ref="${esc(n.ref)}">${I('chat')}<span>${esc(n.text)}</span></button>`).join('')}</details>`:''}${b.proposals.length?`<details class="brief-section"><summary>Nieprzyjęte propozycje agenta · ${b.proposals.length}</summary><p class="hint">To propozycje, nie ustalenia zespołu.</p>${b.proposals.map(p=>proposalHTML(p.id)).join('')}</details>`:''}<div class="brief-coverage"><b>Rozmowa nadal jest dostępna.</b><p>${b.unread} nieprzeczytanych. Nie stają się automatycznie decyzjami ani zaległymi zadaniami.</p>${B('Otwórz rozmowę','return-chat','','small quiet')}</div></div><div class="drawer-footer brief-footer">${B(I('check')+' Mam kontekst','return-ack','','primary')}<small>Tylko ten zakres. Bez publikowania i bez czyszczenia czatu.</small></div></aside>`;
}
/* Scoped search — no background index with data from inaccessible projects. */
function queryFor(kind){ui.queries=ui.queries||{};const s=ui.queries[ui.space]||(ui.queries[ui.space]={});return s[kind]||'';}
function setQuery(kind,value){ui.queries=ui.queries||{};const s=ui.queries[ui.space]||(ui.queries[ui.space]={});s[kind]=value;}
function searchBox(kind,label){const q=queryFor(kind);return `<div class="local-search">${I('search')}<input type="search" id="search-${kind}" data-local-search="${kind}" data-preserve="search-${kind}" aria-label="${label}" placeholder="${label}" value="${esc(q)}" autocomplete="off">${q?IB('x','Wyczyść wyszukiwanie','clear-search',`data-kind="${kind}"`):''}</div>`;}
function textMatch(text,q){return norm(String(text||'')).includes(norm(q));}
function taskSearchText(t){return [t.title,t.description,t.id,'FX-'+(Object.keys(db.tasks).indexOf(t.id)+1),db.users[t.assignee]?.name,db.boards[t.board]?.title,resultMessage(t.id)?.text,...activeBlockers(t.id).map(e=>db.messages[e.message]?.text)].join(' ');}
function validEffort(v,u){return Number.isFinite(Number(v))&&Number(v)>0&&Number(v)<=1000&&['minute','hour','day','week'].includes(u);}
function parseEffort(v,u){v=Number(String(v).replace(',','.'));if(!validEffort(v,u))throw Error('Podaj dodatni nakład do 1000 wybranych jednostek.');return {value:v,unit:u,minutes:Math.round(v*({minute:1,hour:60,day:480,week:2400}[u]))};}
function effortLabel(t){
 if(t.effort&&validEffort(t.effort.value,t.effort.unit)){const {value,unit}=t.effort;return String(value).replace('.',',')+' '+({minute:'min',hour:'h',day:value===1?'dzień':'dni',week:value===1?'tydzień':value<5?'tygodnie':'tygodni'}[unit]);}
 if(!t.estimate)return 'Nie oszacowano';return t.estimate<60?t.estimate+' min':Number((t.estimate/60).toFixed(1)).toLocaleString('pl-PL')+' h';
}
function renderTasks(){
 const boards=Object.values(db.boards).filter(b=>b.space===ui.space);
 if(ui.board!=='all'&&!boards.some(b=>b.id===ui.board))ui.board=boards[0]?.id||'all';
 const q=queryFor('tasks'),scope=Object.values(db.tasks).filter(t=>t.space===ui.space&&(ui.board==='all'||t.board===ui.board)&&(ui.filterTasks!=='mine'||t.assignee===ui.user)),ts=scope.filter(t=>!q||textMatch(taskSearchText(t),q));
 const toolbar=`<div class="toolbar tasks-toolbar"><div class="toolbar-group"><select aria-label="Tablica zadań" data-change="board"><option value="all" ${ui.board==='all'?'selected':''}>Wszystkie tablice</option>${boards.map(b=>`<option value="${b.id}" ${ui.board===b.id?'selected':''}>${esc(b.title)}</option>`).join('')}</select>${IB('plus','Nowa tablica','new-board')}</div>${searchBox('tasks','Szukaj zadań')}<div class="toolbar-group task-toolbar-actions"><div class="segmented"><button data-action="task-view" data-value="kanban" class="${ui.taskView==='kanban'?'active':''}" title="Kanban">${I('columns')}<span>Kanban</span></button><button data-action="task-view" data-value="table" class="${ui.taskView==='table'?'active':''}" title="Tabela">${I('table')}<span>Tabela</span></button></div><button class="btn small ${ui.filterTasks==='mine'?'soft':'quiet'}" data-action="filter-mine">${I('user')} Moje</button>${B(I('plus')+' Zadanie','new-task','','small primary')}</div></div>${q?`<div class="search-status" role="status">${ts.length} z ${scope.length} zadań w tym widoku.${ui.board!=='all'?B('Szukaj we wszystkich tablicach','search-all-boards','','small quiet'):''}</div>`:''}`;
 const board=`<div class="board">${Object.entries(STATUSES).map(([status,label])=>`<section class="column" data-column="${status}"><div class="column-head"><span class="status-circle ${status}"></span><span>${label}</span><span class="count">${ts.filter(t=>t.status===status).length}</span><span class="grow"></span>${IB('plus','Dodaj: '+label,'new-task',`data-status="${status}"`)}</div><div class="column-cards">${ts.filter(t=>t.status===status).map(taskCard).join('')}${!ts.some(t=>t.status===status)?`<div class="column-empty">${q?'Brak pasujących zadań':'Jeszcze nic tutaj.'}</div>`:''}</div><button class="add-card" data-action="new-task" data-status="${status}">${I('plus')} Dodaj zadanie</button></section>`).join('')}</div>`;
 const table=`<div class="tasks-table-wrap"><table class="tasks-table"><thead><tr><th>Zadanie</th><th>Etap</th><th>Wykonawca</th><th>Termin</th><th>Nakład</th></tr></thead><tbody>${ts.map(t=>`<tr data-task="${t.id}" data-action="open-ref" data-ref="task:${t.id}" tabindex="0"><td><div class="task-name">${esc(t.title)}</div><div class="table-ref">${esc(db.boards[t.board]?.title)}${activeBlockers(t.id).length?' · Czeka na pomoc':''}</div></td><td><span class="pill ${t.status==='doing'?'accent':t.status==='done'?'good':''}">${STATUSES[t.status]}</span></td><td>${t.assignee?avatar(t.assignee,true)+' '+esc(db.users[t.assignee]?.name):'—'}</td><td>${t.due?dateLabel(t.due):'—'}</td><td>${t.estimate?esc(effortLabel(t)):'—'}</td></tr>`).join('')}</tbody></table>${!ts.length?'<div class="empty">Nie znaleziono zadań. Zmień zapytanie lub filtr.</div>':''}</div>`;
 return toolbar+(ui.taskView==='kanban'?board:table);
}
function taskCard(t){
 const blockers=activeBlockers(t.id),node=t.nodeIds.map(id=>db.nodes[id]).find(n=>n&&!n.archived),result=resultMessage(t.id),no=Object.keys(db.tasks).indexOf(t.id)+1;
 const context=node?{icon:'map',label:node.text}:t.source?{icon:'chat',label:plain(db.messages[t.source]?.text||'Z rozmowy')}:t.references?.length?{icon:'wiki',label:titleOf(t.references[0])}:null;
 return `<article class="task-card task-card11" draggable="true" data-task="${t.id}" data-action="open-ref" data-ref="task:${t.id}" tabindex="0" aria-label="Zadanie ${esc(t.title)}"><div class="task-card-top"><span class="task-number">FX-${no}</span><span class="task-board-label">${esc(db.boards[t.board]?.title||'')}</span></div><h3 title="${esc(t.title)}">${esc(t.title)}</h3>${blockers.length?`<div class="task-blocker">${I('block')}<div><b>Czeka${blockers[0].helper?' na '+esc(db.users[blockers[0].helper]?.name):' na rozwiązanie'}</b><span>${esc(short(plain(db.messages[blockers[0].message]?.text),130))}</span></div></div>`:result?`<div class="task-result-mini">${I('flag')}<span>${esc(short(plain(result.text),100))}</span></div>`:''}${context?`<div class="task-context-link" title="${esc(context.label)}">${I(context.icon)}<span>${esc(short(context.label,76))}</span></div>`:''}<div class="task-card-footer"><div class="task-owner">${avatar(t.assignee||'unknown',true)}<span>${esc(t.assignee?db.users[t.assignee]?.name:'Bez osoby')}</span></div><div class="task-facts">${t.due?`<span class="task-date ${t.due<=day()&&t.status!=='done'?'urgent':''}" title="Termin ukończenia">${I('calendar')}${dateLabel(t.due)}</span>`:''}${t.estimate?`<span title="Orientacyjny nakład">${I('clock')}${esc(effortLabel(t))}</span>`:''}</div></div>${prefs().plan[t.id]===day()?'<div class="task-plan-line">W Twoim planie na dziś</div>':''}</article>`;
}
/* Graph → spanning forest plus visible cross-links. Never drops cyclic/multi-parent edges. */
function buildOutline(mapId){
 const nodes=Object.values(db.nodes).filter(n=>n.map===mapId&&!n.archived),ids=new Set(nodes.map(n=>n.id)),edges=Object.values(db.edges).filter(e=>e.map===mapId&&ids.has(e.a)&&ids.has(e.b));
 const parent={},children={},depth={},used=new Set(),roots=[];nodes.forEach(n=>children[n.id]=[]);
 // Prefer declared branches if the edge still exists and the parent chain is acyclic.
 for(const n of nodes){const p=n.outlineParent;if(!ids.has(p)||p===n.id||!edges.some(e=>e.a===n.id&&e.b===p||e.b===n.id&&e.a===p))continue;let cur=p,cycle=false;while(cur){if(cur===n.id){cycle=true;break}cur=parent[cur]}if(!cycle)parent[n.id]=p;}
 const visited=new Set();
 function walk(id,d){if(visited.has(id))return;visited.add(id);depth[id]=d;for(const n of nodes.filter(n=>parent[n.id]===id)){children[id].push(n.id);used.add(edges.find(e=>e.a===id&&e.b===n.id||e.b===id&&e.a===n.id).id);walk(n.id,d+1);}
   for(const edge of edges.filter(e=>e.a===id||e.b===id)){const next=edge.a===id?edge.b:edge.a;if(visited.has(next)||parent[next])continue;parent[next]=id;children[id].push(next);used.add(edge.id);walk(next,d+1);}
 }
 const ordered=[...nodes.filter(n=>n.root&&!parent[n.id]),...nodes.filter(n=>!parent[n.id]&&!n.root),...nodes];
 for(const n of ordered)if(!visited.has(n.id)){roots.push(n.id);delete parent[n.id];walk(n.id,0);}
 return {nodes,edges,parent,children,depth,roots,cross:edges.filter(e=>!used.has(e.id))};
}
function renderOutline(){
 const o=buildOutline(ui.map),q=queryFor('map'),collapsed=ui.outlineCollapsed||{};
 function item(id){const n=db.nodes[id],kids=o.children[id],cross=o.cross.filter(e=>e.a===id||e.b===id),open=!collapsed[id];
  return `<li class="outline-item" data-outline-node="${id}"><div class="outline-row ${ui.selected.includes(id)?'selected':''} ${q&&textMatch(n.text,q)?'search-match':''}">${kids.length?`<button class="outline-toggle" data-action="outline-toggle" data-id="${id}" aria-label="${open?'Zwiń':'Rozwiń'} ${esc(n.text)}" aria-expanded="${open}">${I(open?'down':'arrow')}</button>`:'<span class="outline-terminal"></span>'}<button class="outline-main" data-action="outline-open" data-id="${id}" data-outline-open="${id}">${I(n.root?'spark':n.reference?kindIcon[n.reference.split(':')[0]]:'map')}<span><b>${esc(titleOf('node:'+id))}</b>${tasksForNode(id).length?`<small>${tasksForNode(id).length} ${plural(tasksForNode(id).length,'zadanie','zadania','zadań')}</small>`:''}</span></button><div class="outline-actions">${IB('send','Do rozmowy','share',`data-ref="node:${id}"`)}${IB('edit','Edytuj myśl','node-edit',`data-id="${id}"`)}${IB('plus','Dopisz gałąź','node-child',`data-id="${id}"`)}</div></div>${cross.length?`<div class="outline-cross">${cross.map(e=>{const other=e.a===id?e.b:e.a;return `<button data-action="outline-reveal" data-id="${other}" title="Połączenie boczne, bez kopiowania myśli">${I('git')}↔ ${esc(short(titleOf('node:'+other),55))}</button>`}).join('')}</div>`:''}${kids.length&&open?`<ul class="outline-children">${kids.map(item).join('')}</ul>`:''}</li>`;
 }
 return `<div class="map-outline"><div class="outline-caption"><span>${o.nodes.length} myśli · ${o.edges.length} połączeń</span>${B('Rozwiń wszystko','outline-expand','','small quiet')}</div><ul class="outline-roots" aria-label="Gałęzie mapy">${o.roots.map(item).join('')}</ul>${!o.nodes.length?'<div class="empty">Dodaj pierwszą myśl.</div>':''}${B(I('upload')+' Wklej listę myśli','paste-outline','','quiet')}</div>`;
}
function mapMatches(){const q=queryFor('map');if(!q)return [];return Object.values(db.nodes).filter(n=>n.space===ui.space&&!n.archived&&textMatch(n.text+' '+titleOf('node:'+n.id)+' '+db.maps[n.map]?.title,q));}
function renderMap(){
 let h=renderMap10();if(!ui.map)return h;
 h=h.replace('<span class="grow"></span>',searchBox('map','Szukaj na mapach'));
 if(ui.mapView==='list'){const start=h.indexOf('<div class="map-list">');if(start>=0)h=h.slice(0,start)+renderOutline();}
 const q=queryFor('map');
 if(q&&ui.mapSearchOpen){const matches=mapMatches(),maps=Object.values(db.maps).filter(m=>m.space===ui.space&&textMatch(m.title,q));
  const panel=`<div class="map-search-results" aria-label="Wyniki na mapach"><div class="row between"><span class="hint">${matches.length} myśli · we wszystkich mapach projektu</span>${IB('x','Schowaj wyniki','map-search-close')}</div>${maps.map(m=>`<button class="local-result" data-action="search-map-open" data-map="${m.id}">${I('map')}<span><b>${esc(m.title)}</b><small>Mapa</small></span>${I('arrow')}</button>`).join('')}${matches.slice(0,40).map(n=>`<button class="local-result" data-action="search-map-open" data-map="${n.map}" data-id="${n.id}">${I('map')}<span><b>${esc(titleOf('node:'+n.id))}</b><small>${esc(db.maps[n.map].title)}</small></span>${I('arrow')}</button>`).join('')}${!matches.length&&!maps.length?'<p class="empty">Brak wyników. Zmień słowo lub nazwę mapy.</p>':''}${matches.length>40?'<p class="hint">Pokazano 40 wyników. Doprecyzuj zapytanie.</p>':''}</div>`;
  const end=h.indexOf('</div>')+6; // toolbar contains nested divs — insert after actual outer via temporary DOM.
  const temp=document.createElement('div');temp.innerHTML=h;temp.querySelector('.toolbar')?.insertAdjacentHTML('afterend',panel);h=temp.innerHTML;
 }
 return h;
}
function wikiSnippet(p,q){const text=p.content.replace(/[#`*]/g,''),index=norm(text).indexOf(norm(q));return short(text.slice(Math.max(0,index-45),Math.max(0,index-45)+170).replace(/\n/g,' '),150);}
function renderWiki(){
 let h=renderWiki10(),q=queryFor('wiki');const tmp=document.createElement('div');tmp.innerHTML=h;
 const list=tmp.querySelector('.wiki-list');if(!list)return h;
 const pages=Object.values(db.pages).filter(p=>p.space===ui.space&&!p.archived&&(!q||textMatch(p.title+' '+p.content,q)));
 list.innerHTML=`<div class="eyebrow" style="padding:8px 9px 12px">Pamięć projektu</div>${searchBox('wiki','Szukaj w wiki')}${q?`<div class="hint wiki-search-count" role="status">${pages.length} stron · tytuły i treść</div>`:''}${pages.map(p=>`<button class="wiki-page-item ${ui.page===p.id?'active':''}" data-action="wiki-search-open" data-id="${p.id}">${I('wiki')}<span><b>${esc(p.title)}</b>${q?`<small>${esc(wikiSnippet(p,q))}</small>`:''}</span></button>`).join('')}${!pages.length?'<p class="empty">Brak pasujących stron.</p>':''}<div class="wiki-side-actions">${B(I('plus')+' Nowa strona','new-page','','small quiet')}${B(I('upload')+' Importuj .md','import-md','','small quiet')}</div>`;
 return tmp.innerHTML;
}
function shareRef(ref){
 // No parent/source inference here. The clicked material is the only share target.
 const target=String(ref||'');if(!canRef(target)){toast('Materiał nie jest dostępny w tym projekcie.');return;}
 const root=anchorFor(target),anchor=root&&db.messages[root];
 if(anchor&&anchor.primary===target){jumpMessage(root);toast('Otworzyłem rozmowę tego konkretnego materiału.');return;}
 captureUI();ui.view='chat';ui.drawer=null;ui.pendingShares=ui.pendingShares||{};
 ui.pendingShares['chat:'+ui.space]=target;ui.scrollEnd=true;ui.flash=null;render();editorFor('chat:'+ui.space)?.focus();
}
/* Portable project archives. Restore as a new project, never merge people by name. */
function blankPrefs(){return {theme:'dark',accent:'mint',plan:{},notes:{},read:{},drafts:{},reminders:{},notify:{},review:{},visits:{},privateBriefs:{}};}
function emptyDataset(){return {schema:11,revision:0,users:{},spaces:{},boards:{},maps:{},nodes:{},edges:{},pages:{},fragments:{},messages:{},tasks:{},effects:{},anchors:{},attachments:{},proposals:{},prefs:{},activity:[],nextActivity:1,agentRuns:{},agentChecked:{},sessionsArchive:{},notifications:[],audit:[]};}
function stripExternalRefs(value,space){
 if(typeof value==='string')return value.replace(/\[\[([a-z]+:[\w-]+)\]\]/g,(whole,ref)=>canRef(ref,space)?whole:'[materiał spoza eksportu]');
 if(Array.isArray(value))return value.map(v=>stripExternalRefs(v,space));
 if(value&&typeof value==='object'){const out={};for(const [k,v] of Object.entries(value)){
   if(['__proto__','prototype','constructor'].includes(k))throw Error('Niebezpieczny klucz w danych.');
   if(/^(accessToken|refreshToken|apiKey|password|cookie|secret|credentials)$/i.test(k))continue;
   out[k]=stripExternalRefs(v,space);
 }return out;}return value;
}
function exportWorkspace(space=ui.space){
 if(!allowed(space))throw Error('Brak dostępu do eksportu tego projektu.');
 captureUI();const d=emptyDataset(),s=db.spaces[space];
 d.spaces[space]=copy(s);
 for(const coll of ['boards','maps','nodes','edges','pages','fragments','messages','tasks'])
   for(const [id,o] of Object.entries(db[coll]))if(o.space===space)d[coll][id]=stripExternalRefs(copy(o),space);
 for(const [id,e] of Object.entries(db.effects))if(d.tasks[e.task]&&d.messages[e.message])d.effects[id]=copy(e);
 for(const [ref,id] of Object.entries(db.anchors))if(d.messages[id]&&refScope(ref)===space)d.anchors[ref]=id;
 const authors=new Set(s.members);
 Object.values(d.messages).forEach(m=>authors.add(m.author));
 db.audit.filter(e=>e.space===space).forEach(e=>authors.add(e.actor));
 for(const p of Object.values(d.pages))for(const v of p.history||[])for(const key of ['author','by','actor'])if(v[key])authors.add(v[key]);
 for(const u of authors)if(db.users[u])d.users[u]={name:db.users[u].name,sourceProfile:u,historical:true};
 d.users.ai={name:db.users.ai.name,historical:true};
 for(const m of Object.values(d.messages))for(const id of m.files||[])if(db.attachments[id])d.attachments[id]=copy(db.attachments[id]);
 for(const [id,p] of Object.entries(db.proposals))if(p.space===space)d.proposals[id]={...copy(p),originalStatus:p.originalStatus||p.status,status:'archived-import',importReadOnly:true};
 for(const [id,r] of Object.entries(db.agentRuns))if(r.space===space)d.agentRuns[id]={...copy(r),originalState:r.originalState||r.state,state:'archived',importReadOnly:true};
 d.activity=copy(db.activity.filter(e=>e.space===space));d.nextActivity=Math.max(1,...d.activity.map(e=>e.seq+1));
 d.audit=stripExternalRefs(copy(db.audit.filter(e=>e.space===space)),space);
 for(const [id,sess] of Object.entries(db.sessionsArchive))if(sess.space===space)d.sessionsArchive[id]=stripExternalRefs(copy(sess),space);
 // Personal preferences, local drafts, read receipts and private AI output never leave in a project archive.
 return {format:'flux.workspace',formatVersion:1,archiveId:uid('archive'),exportedAt:now(),application:'Flux Studio 11',
   projectId:space,projectName:s.name,personalDataIncluded:false,data:d};
}
function rejectDangerous(value,depth=0){if(depth>80)throw Error('Zbyt głęboka struktura pliku.');if(!value||typeof value!=='object')return;for(const [k,v] of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(k))throw Error('Niedozwolony klucz w imporcie.');rejectDangerous(v,depth+1);}}
function validateDeepArchive(d){
 const collections=['spaces','boards','maps','nodes','edges','pages','fragments','messages','tasks','effects','anchors','attachments','proposals','users'];
 for(const name of collections)if(!d[name]||typeof d[name]!=='object'||Array.isArray(d[name]))throw Error('Brakuje sekcji '+name);
 let count=0;
 for(const coll of collections.filter(k=>k!=='anchors'))for(const [id,o] of Object.entries(d[coll])){
   if(!/^[\w-]+$/.test(id)||!o||typeof o!=='object')throw Error('Nieprawidłowy identyfikator '+coll);
   if(coll!=='users'&&coll!=='attachments'&&o.id!==id)throw Error('Niezgodny identyfikator '+id);
   if(++count>50000)throw Error('Maksymalnie 50 000 rekordów w lokalnym imporcie.');
 }
 for(const [id,s] of Object.entries(d.spaces))if(s.id!==id||typeof s.name!=='string'||!Array.isArray(s.members)||s.members.some(u=>!d.users[u]))throw Error('Nieprawidłowi uczestnicy projektu.');
 const inSame=(a,b)=>!!a&&!!b&&a.space===b.space;
 for(const c of ['boards','maps','nodes','edges','pages','fragments','messages','tasks'])for(const o of Object.values(d[c]))if(!d.spaces[o.space])throw Error('Materiał bez projektu.');
 for(const n of Object.values(d.nodes))if(!inSame(n,d.maps[n.map])||!Number.isFinite(n.x)||!Number.isFinite(n.y)||typeof n.text!=='string')throw Error('Nieprawidłowa myśl.');
 for(const e of Object.values(d.edges))if(!inSame(e,d.nodes[e.a])||!inSame(e,d.nodes[e.b])||e.a===e.b||d.nodes[e.a].map!==e.map||d.nodes[e.b].map!==e.map)throw Error('Uszkodzone połączenie.');
 for(const m of Object.values(d.messages))if(!d.users[m.author]||typeof m.text!=='string'||!Number.isFinite(Date.parse(m.at))||m.parent&&(!inSame(m,d.messages[m.parent])||d.messages[m.parent].parent))throw Error('Uszkodzona wiadomość albo odpowiedź.');
 for(const t of Object.values(d.tasks))if(!inSame(t,d.boards[t.board])||!STATUSES[t.status]||!Array.isArray(t.nodeIds)||!Array.isArray(t.references)||t.assignee&&!d.users[t.assignee])throw Error('Uszkodzone zadanie.');
 for(const p of Object.values(d.pages))if(typeof p.content!=='string'||typeof p.title!=='string'||!Array.isArray(p.history)||!Number.isFinite(p.version))throw Error('Uszkodzona wiki.');
 for(const f of Object.values(d.fragments))if(!inSame(f,d.pages[f.page])||typeof f.quote!=='string')throw Error('Uszkodzony cytat.');
 for(const e of Object.values(d.effects))if(!inSame(d.messages[e.message],d.tasks[e.task]))throw Error('Uszkodzone oznaczenie wiadomości.');
 for(const [ref,id] of Object.entries(d.anchors))if(!/^(task|node|page|fragment|map|edge):[\w-]+$/.test(ref)||!d.messages[id])throw Error('Uszkodzone źródło rozmowy.');
 for(const a of Object.values(d.attachments))if(typeof a.data!=='string'||!/^data:(image\/(png|jpeg|webp)|text\/(plain|markdown)|application\/pdf);base64,[A-Za-z0-9+/=\r\n]*$/i.test(a.data))throw Error('Nieobsługiwany załącznik.');
 return d;
}
function validateWorkspaceArchive(a){
 rejectDangerous(a);
 if(a?.format!=='flux.workspace'||a.formatVersion!==1||typeof a.archiveId!=='string'||!/^[\w-]+$/.test(a.archiveId)||!a.data||a.data.schema!==11)throw Error('To nie jest obsługiwany eksport projektu.');
 if(Object.keys(a.data.spaces||{}).length!==1||!a.data.spaces[a.projectId])throw Error('Eksport musi zawierać jeden wskazany projekt.');
 if(Object.keys(a.data.prefs||{}).length||a.data.notifications?.length)throw Error('Archiwum projektu nie może importować cudzych danych osobistych.');
 validateDeepArchive(a.data);
 for(const k of ['activity','audit'])if(!Array.isArray(a.data[k]))throw Error('Uszkodzona historia: '+k);
 for(const k of ['agentRuns','sessionsArchive'])if(!a.data[k]||typeof a.data[k]!=='object'||Array.isArray(a.data[k]))throw Error('Uszkodzona historia: '+k);
 for(const e of a.data.activity)if(e.space!==a.projectId||!Number.isFinite(e.seq)||typeof e.id!=='string'||!Number.isFinite(Date.parse(e.at)))throw Error('Uszkodzone zdarzenie historii.');
 for(const e of a.data.audit)if(e.space!==a.projectId||!Number.isFinite(Date.parse(e.at)))throw Error('Uszkodzony zapis audytu.');
 for(const k of ['agentRuns','sessionsArchive','proposals'])for(const e of Object.values(a.data[k]))if(e.space!==a.projectId)throw Error('Historia spoza eksportowanego projektu.');
 return copy(a);
}
function remapArchive(value,ids){
 if(typeof value==='string'){
   if(ids[value])return ids[value];
   const exact=value.match(/^([a-z]+):([\w-]+)$/);if(exact&&ids[exact[2]])return exact[1]+':'+ids[exact[2]];
   return value.replace(/\[\[([a-z]+):([\w-]+)\]\]/g,(_,type,id)=>'[['+type+':'+(ids[id]||id)+']]');
 }
 if(Array.isArray(value))return value.map(v=>remapArchive(v,ids));
 if(value&&typeof value==='object'){const out={};for(const [key,v] of Object.entries(value))out[remapArchive(key,ids)]=remapArchive(v,ids);return out;}return value;
}
function importWorkspace(a,identity=null){
 a=validateWorkspaceArchive(a);
 if(Object.values(db.spaces).some(s=>s.importedArchiveId===a.archiveId))throw Error('Ten plik został już zaimportowany. Nie utworzono drugiej kopii.');
 if(identity&&!a.data.spaces[a.projectId].members.includes(identity))throw Error('Wybierz profil z tego projektu.');
 const ids={ai:'ai'};
 for(const old of Object.keys(a.data.users))if(old!=='ai')ids[old]=old===identity?ui.user:uid('profile');
 for(const coll of ['spaces','boards','maps','nodes','edges','pages','fragments','messages','tasks','effects','attachments','proposals','agentRuns','sessionsArchive'])for(const old of Object.keys(a.data[coll]||{})){
  if(ids[old])throw Error('Niejednoznaczny identyfikator w archiwum.');ids[old]=uid(coll.slice(0,3));
 }
 const fresh=remapArchive(a.data,ids),newSpace=ids[a.projectId],s=fresh.spaces[newSpace];
 s.importedArchiveId=a.archiveId;s.importedAt=now();s.importSourceName=a.projectName;
 s.members=[...new Set([...s.members,ui.user])];s.ai=false;s.aiBackground=false;
 const before=copy(db);
 try{
   for(const [id,u] of Object.entries(fresh.users))if(id!=='ai'&&id!==ui.user){db.users[id]={...u,historical:true};db.prefs[id]=blankPrefs();}
   for(const coll of ['spaces','boards','maps','nodes','edges','pages','fragments','messages','tasks','effects','attachments','proposals','agentRuns','sessionsArchive'])Object.assign(db[coll],fresh[coll]);
   Object.assign(db.anchors,fresh.anchors);
   for(const evt of fresh.activity||[])db.activity.push({...evt,id:uid('activity'),seq:db.nextActivity++});
   for(const evt of fresh.audit||[])db.audit.push({...evt,id:uid('history'),imported:true});
   db.audit.push({id:uid('history'),actor:ui.user,space:newSpace,at:now(),action:'workspace.import',archive:a.archiveId});
   db.revision++;normalizeRefinement(db);validateDeepArchive(db);
   if(!persist())throw Error('Nie udało się zapisać importu. Dane nie zostały dodane — zwolnij miejsce lub wyeksportuj kopię.');
 }catch(err){db=before;throw err;}
 closeModal();finishVisit();setSpace(newSpace);render();toast('Dodano nowy projekt. Historie i źródła zachowane; automatyzacje wyłączone.');return newSpace;
}
function archiveCounts(d){return [['Rozmowy',Object.keys(d.messages).length],['Mapy',Object.keys(d.maps).length],['Myśli',Object.keys(d.nodes).length],['Zadania',Object.keys(d.tasks).length],['Strony wiki',Object.keys(d.pages).length],['Wersje wiki',Object.values(d.pages).reduce((n,p)=>n+p.history.length,0)],['Autorzy',Object.keys(d.users).length],['Załączniki',Object.keys(d.attachments).length]];}
function goalModal(){
 const s=db.spaces[ui.space],g=s.goalInfo||{criteria:'',taskIds:[],status:'active',history:[]},ts=Object.values(db.tasks).filter(t=>t.space===ui.space);
 const total=g.taskIds.filter(id=>db.tasks[id]).length,done=g.taskIds.filter(id=>db.tasks[id]?.status==='done').length;
 modalShell('Co pokażecie jako następne?',`<p class="modal-description">Jeden rezultat, nie plan całego produktu. Możesz go zmienić po próbie lub zostawić pusty.</p><label for="goal-title">Najbliższy cel</label><input id="goal-title" maxlength="180" value="${esc(s.goal||'')}" placeholder="Np. lampka reaguje na jeden gest"><div class="field"><label for="goal-criteria">Po czym poznamy, że działa? <span class="muted">Opcjonalnie</span></label><textarea id="goal-criteria" rows="2" placeholder="Np. gest włącza światło także przy zgaszonej lampie">${esc(g.criteria||'')}</textarea></div><details class="goal-tasks" ${total?'open':''}><summary>Powiąż już istniejące kroki${total?' · '+done+'/'+total+' zakończonych':''}</summary><p class="hint">Nie tworzymy tasków z celu. Wskazujesz te, które go realizują.</p>${ts.map(t=>`<label class="checkbox"><input type="checkbox" name="goal-task" value="${t.id}" ${g.taskIds.includes(t.id)?'checked':''}><span>${esc(t.title)}${t.status==='done'?' · zakończone':''}</span></label>`).join('')}</details>${total?'<p class="hint" style="margin-top:12px">Ukończone zadania nie potwierdzają automatycznie efektu. Zespół ocenia rezultat.</p>':''}${g.status==='achieved'?'<p class="notice">Ten cel został potwierdzony jako osiągnięty.</p>':''}${g.history?.length?`<details class="goal-history"><summary>Poprzednie kierunki · ${g.history.length}</summary>${g.history.slice().reverse().map(v=>`<p><b>${esc(v.title)}</b><br><small>${esc(v.status==='achieved'?'Osiągnięto':'Zmieniono kierunek')} · ${whenLabel(v.at)}</small></p>`).join('')}</details>`:''}`,B('Zamknij','close-modal','','quiet')+(s.goal&&g.status!=='achieved'?B('Potwierdź osiągnięcie','goal-achieve','','soft'):g.status==='achieved'?B('Następny cel','goal-next','','soft'):'')+B('Zapisz cel','goal-save','','primary'));
}
function renderModal(){
 const m=ui.modal;if(!m)return;
 if(m.type==='goal'){goalModal();return;}
 if(m.type==='task-estimate'){
  const t=db.tasks[m.id],v=t.effort?.value??(t.estimate>=60?t.estimate/60:t.estimate||''),unit=t.effort?.unit||(t.estimate>=60?'hour':'minute');
  modalShell('Orientacyjny nakład',`<p class="modal-description">Ile pracy mniej więcej potrzeba? To nie termin ani rezerwacja czasu w kalendarzu.</p><div class="effort-input"><div><label for="effort-value">Ilość</label><input id="effort-value" type="number" min="0.01" max="1000" step="any" value="${v}" placeholder="Np. 2"></div><div><label for="effort-unit">Jednostka</label><select id="effort-unit">${[['minute','minuty'],['hour','godziny'],['day','dni pracy'],['week','tygodnie pracy']].map(([u,n])=>`<option value="${u}" ${unit===u?'selected':''}>${n}</option>`).join('')}</select></div></div><div class="effort-presets">${[[30,'minute','30 min'],[2,'hour','2 h'],[2,'day','2 dni'],[1,'week','Tydzień']].map(([v,u,l])=>B(l,'effort-preset',`data-value="${v}" data-unit="${u}"`,'small quiet')).join('')}</div><p class="hint">1 dzień pracy = 8 godzin; 1 tydzień = 5 takich dni. Zachowujemy wybraną jednostkę. Nie przesuwa to terminu.</p>`,B('Jeszcze nie wiem','effort-clear',`data-id="${t.id}"`,'quiet')+B('Zapisz nakład','effort-save',`data-id="${t.id}"`,'primary'));return;
 }
 if(m.type==='summary-period'){
  const r=ui.review,v=r.baselineAt?new Date(Date.parse(r.baselineAt)-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  modalShell('Zakres Twojego skrótu',`<p class="modal-description">Domyślnie wracasz do zmian od ostatniej wizyty. Możesz świadomie rozszerzyć okres; nie zmieni to historii odczytania wiadomości.</p><label for="summary-since">Pokaż od</label><input id="summary-since" type="datetime-local" value="${v}"><div class="row wrap" style="margin-top:14px">${B('Ostatnie 24 h','summary-relative','data-hours="24"','small quiet')}${B('Ostatnie 7 dni','summary-relative','data-hours="168"','small quiet')}${B('Od ostatniej wizyty','summary-default','','small quiet')}</div>`,B('Anuluj','close-modal','','quiet')+B('Zmień zakres','summary-since-save','','primary'));return;
 }
 if(m.type==='workspace-transfer'){
  const s=db.spaces[ui.space];
  modalShell('Przenieś projekt lub zabezpiecz dane',`<div class="transfer-choice"><div>${I('map')}<h3>Tylko ${esc(s.name)}</h3><p>Uczestnicy i autorstwo, wiadomości z odpowiedziami, mapy i połączenia, tablice, zadania, wiki z wersjami, oznaczenia, załączniki i zapisana historia.</p><p class="hint">Bez prywatnych szkiców, punktów powrotu, podsumowań i ustawień osób. To plik z jawną treścią projektu — traktuj go jak poufny eksport.</p>${B(I('download')+' Eksportuj ten projekt','workspace-export','','primary')}</div><div>${I('upload')}<h3>Dodaj projekt z pliku</h3><p>Import tworzy osobną kopię. Nie scala kont po nazwie ani nie nadpisuje innych projektów.</p>${B('Importuj projekt','import-json')}</div><details><summary>Pełna kopia lokalnej aplikacji</summary><p class="notice warning">Zawiera wszystkie dane tej demonstracji, także prywatne szkice i preferencje wszystkich profili. Nie udostępniaj jako eksport zespołu.</p><div class="row wrap">${B('Pełny backup JSON','full-backup-export','','small')}${B('Odtwórz backup','import-json','','small quiet')}</div></details></div>`,B('Zamknij','close-modal','','quiet'),true);return;
 }
 if(m.type==='workspace-import'){
  const a=m.data,d=a.data,s=d.spaces[a.projectId];
  modalShell('Dodaj kopię projektu',`<h3>${esc(a.projectName)}</h3><div class="archive-counts">${archiveCounts(d).map(([k,v])=>`<div><b>${v}</b><span>${k}</span></div>`).join('')}</div><div class="field"><label for="import-identity">Który profil w historii należy do Ciebie?</label><select id="import-identity"><option value="">Żaden — dołączam jako ${esc(db.users[ui.user].name)}</option>${s.members.filter(id=>id!=='ai').map(id=>`<option value="${id}">${esc(d.users[id].name)} → mój profil (${esc(db.users[ui.user].name)})</option>`).join('')}</select></div><p class="hint">Przypisanie nastąpi wyłącznie po Twoim wyborze. Pozostali autorzy zachowają osobne profile historyczne; plik nie tworzy kont, logowania ani zgód.</p><div class="notice">Nowe identyfikatory zachowają wzajemne odnośniki. Projekty już w aplikacji pozostaną bez zmian. Agent i importowane propozycje nie uruchomią się samoczynnie.</div><label class="checkbox" style="margin-top:15px"><input id="import-trust" type="checkbox">Mam prawo przenieść te materiały do swojej lokalnej aplikacji.</label>`,B('Anuluj','close-modal','','quiet')+B('Dodaj jako nowy projekt','workspace-import-apply','','primary'),true);return;
 }
 renderModal10();
 if(m.type==='settings'){
   if(ui.settingsTab==='appearance'){
    const sw=$('.swatches',$('#overlay'));if(sw)sw.innerHTML=paletteDefs().map(([v,l,c])=>`<button class="swatch ${prefs().accent===v?'active':''}" data-action="accent-set" data-value="${v}" aria-label="Akcent ${l}" aria-pressed="${prefs().accent===v}"><span class="dot" style="--sample:${c}"></span>${l}</button>`).join('');
   }else if(ui.settingsTab==='data'){
    const area=$('.modal-content');if(area){let p=document.createElement('p');p.className='notice';p.textContent='Studio 11: przenoś projekt z historią albo odtwarzaj pełną kopię. Prywatne podsumowania nie trafiają do eksportu projektu.';area.prepend(p);}
   }
 }
 if(m.type==='project-settings'){
  const label=$('#project-goal')?.previousElementSibling;if(label)label.textContent='Cel do pokazania · opcjonalnie';
  const area=$('.modal-content');if(area)area.insertAdjacentHTML('beforeend',`<div class="settings-section"><h3>Dane projektu</h3><p class="hint">Eksport z historią, bez osobistych ustawień uczestników.</p>${B('Import / eksport projektu','workspace-transfer','','small')}</div>`);
 }
}
function refinementAction(a,el){
 const d=el?.dataset||{};
 switch(a){
  case 'return-open':if(ui.review&&ui.review.space===(d.space||ui.space)&&ui.reviewBack){ui.drawer={kind:'review'};ui.flash=null;render();}else openReview(d.space||ui.space);return true;
  case 'return-refresh':{const r=ui.review,from=r?.custom?r.baselineAt:null;openReview(r?.space||ui.space,from);if(from)ui.review.custom=true;return true;}
  case 'private-summary':case 'return-ai':if(!ui.privateBusy)startPrivateBrief();return true;
  case 'summary-scope':ui.privateScope=d.value==='mine'?'mine':'project';if(ui.review){ui.review.scope=ui.privateScope;ui.review.privateResult=null;ui.privateBusy=false;ui.privateToken++;render();}return true;
  case 'summary-period':modal('summary-period');return true;
  case 'summary-relative':{const date=new Date(Date.now()-Number(d.hours)*3600000);$('#summary-since').value=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);return true;}
  case 'summary-default':closeModal();openReview(ui.review.space);return true;
  case 'summary-since-save':{const raw=$('#summary-since').value,t=Date.parse(raw);if(!raw||!Number.isFinite(t)||t>Date.now()){toast('Wybierz poprawną datę w przeszłości.');return true;}const space=ui.review.space;closeModal();openReview(space,new Date(t).toISOString());ui.review.custom=true;render();return true;}
  case 'goal-open':modal('goal');return true;
  case 'goal-save':case 'goal-achieve':{
    const title=$('#goal-title').value.trim(),criteria=$('#goal-criteria').value.trim(),taskIds=$$('input[name=goal-task]:checked').map(e=>e.value);
    if(a==='goal-achieve'&&!title){toast('Najpierw nazwij rezultat.');return true;}
    transact('project.goal',()=>{const s=db.spaces[ui.space],g=s.goalInfo||{history:[]};if(s.goal&&s.goal!==title)g.history.push({title:s.goal,criteria:g.criteria,taskIds:g.taskIds,at:now(),status:g.status,by:ui.user});g.criteria=criteria;g.taskIds=taskIds;g.status=a==='goal-achieve'?'achieved':s.goal!==title?'active':g.status||'active';g.updatedAt=now();s.goal=title;s.goalInfo=g;closeModal();});return true;
  }
  case 'goal-next':transact('project.goal.next',()=>{const s=db.spaces[ui.space],g=s.goalInfo;g.history.push({title:s.goal,criteria:g.criteria,taskIds:g.taskIds,at:now(),status:g.status,by:ui.user});s.goal='';g.criteria='';g.taskIds=[];g.status='active';});return true;
  case 'effort-preset':$('#effort-value').value=d.value;$('#effort-unit').value=d.unit;return true;
  case 'effort-save':try{const ef=parseEffort($('#effort-value').value,$('#effort-unit').value);transact('task.effort',()=>{const t=db.tasks[d.id];t.effort={value:ef.value,unit:ef.unit};t.estimate=ef.minutes;t.version++;closeModal();});}catch(err){toast(err.message)}return true;
  case 'effort-clear':transact('task.effort',()=>{db.tasks[d.id].effort=null;db.tasks[d.id].estimate=null;db.tasks[d.id].version++;closeModal();});return true;
  case 'clear-search':document.activeElement?.blur();setQuery(d.kind,'');if(d.kind==='map')ui.mapSearchOpen=false;render();return true;
  case 'search-all-boards':ui.board='all';render();return true;
  case 'map-search-close':ui.mapSearchOpen=false;render();return true;
  case 'search-map-open':document.activeElement?.blur();ui.map=d.map;ui.drawer=null;ui.edge=null;ui.selected=d.id?[d.id]:[];ui.mapSearchOpen=false;render();if(ui.mapView==='canvas')requestAnimationFrame(()=>fitMap(d.id?[d.id]:undefined));else if(d.id){outlineReveal(d.id);render();requestAnimationFrame(()=>$(`[data-outline-node="${d.id}"]`)?.scrollIntoView({block:'center'}));}return true;
  case 'outline-toggle':ui.outlineCollapsed[d.id]=!ui.outlineCollapsed[d.id];render();return true;
  case 'outline-expand':ui.outlineCollapsed={};render();return true;
  case 'outline-open':ui.selected=[d.id];ui.edge=null;openRef('node:'+d.id);return true;
  case 'outline-reveal':outlineReveal(d.id);ui.selected=[d.id];ui.outlineFocus=d.id;render();requestAnimationFrame(()=>$(`[data-outline-node="${d.id}"]`)?.scrollIntoView({block:'center'}));return true;
  case 'wiki-search-open':if(ui.wikiEdit)captureUI();ui.page=d.id;ui.wikiEdit=false;ui.drawer=null;render();highlightWikiQuery(queryFor('wiki'));return true;
  case 'accent-set':if(paletteDefs().some(p=>p[0]===d.value)){prefs().accent=d.value;persist();render();}return true;
  case 'export':case 'workspace-transfer':modal('workspace-transfer');return true;
  case 'workspace-export':try{const a=exportWorkspace();downloadData('flux-'+db.spaces[ui.space].name.replace(/[^\p{L}\p{N}_-]+/gu,'-')+'-'+day()+'.json',JSON.stringify(a,null,2),'application/json');toast('Wyeksportowano projekt bez osobistych szkiców i podsumowań.');}catch(err){toast(err.message)}return true;
  case 'full-backup-export':captureUI();touchVisit();downloadData('flux-studio-11-backup-'+day()+'.json',JSON.stringify(db,null,2),'application/json');return true;
  case 'workspace-import-apply':if(!$('#import-trust').checked){toast('Potwierdź prawo do przeniesienia materiałów.');return true;}try{importWorkspace(ui.modal.data,$('#import-identity').value||null);}catch(err){toast('Import odrzucony: '+err.message)}return true;
  case 'import-apply':finishVisit();resetRefinement();return false;
  case 'demo-week':simulateAbsence(7);return true; // test hook; no longer an ordinary product entry
 }
 return false;
}
function outlineReveal(id){const o=buildOutline(db.nodes[id]?.map);let p=o.parent[id];while(p){delete ui.outlineCollapsed[p];p=o.parent[p];}}
function highlightWikiQuery(q){if(!q)return;requestAnimationFrame(()=>{
 const root=$('#wiki-content');if(!root)return;let walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),n;
 while(n=walker.nextNode()){if(n.parentElement.closest('button,.inline-ref,.linked-group,script,style'))continue;const i=norm(n.textContent).indexOf(norm(q));if(i>=0){let r=document.createRange();r.setStart(n,i);r.setEnd(n,Math.min(n.length,i+q.length));let mark=document.createElement('mark');r.surroundContents(mark);mark.scrollIntoView({block:'center'});break;}}
 });}
document.addEventListener('input',e=>{
 const el=e.target;if(!el.dataset.localSearch)return;
 setQuery(el.dataset.localSearch,el.value);if(el.dataset.localSearch==='map')ui.mapSearchOpen=true;
 render();
});
document.addEventListener('keydown',e=>{
 const button=e.target.closest('[data-outline-open]');if(!button||!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
 e.preventDefault();e.stopImmediatePropagation();const id=button.dataset.outlineOpen,o=buildOutline(ui.map),visible=$$('[data-outline-open]'),i=visible.indexOf(button);let next;
 if(e.key==='ArrowDown')next=visible[Math.min(i+1,visible.length-1)];if(e.key==='ArrowUp')next=visible[Math.max(i-1,0)];if(e.key==='Home')next=visible[0];if(e.key==='End')next=visible.at(-1);
 if(next){next.focus();return;}
 if(e.key==='ArrowRight'){if(ui.outlineCollapsed[id]){ui.outlineCollapsed[id]=false;ui.outlineFocus=id;render();}else if(o.children[id][0])$(`[data-outline-open="${o.children[id][0]}"]`)?.focus();}
 if(e.key==='ArrowLeft'){if(o.children[id].length&&!ui.outlineCollapsed[id]){ui.outlineCollapsed[id]=true;ui.outlineFocus=id;render();}else if(o.parent[id])$(`[data-outline-open="${o.parent[id]}"]`)?.focus();}
},true);
document.addEventListener('visibilitychange',()=>{
 if(document.hidden){finishVisit();persist();}else if(ui.view!=='home'){beginVisit(ui.space);if(ui.drawer?.kind!=='review')render();}
});
window.addEventListener('pagehide',()=>{finishVisit();persist();});
setInterval(()=>{if(typeof ui!=='undefined'&&ui.activeVisit&&!document.hidden)touchVisit();},15000);
