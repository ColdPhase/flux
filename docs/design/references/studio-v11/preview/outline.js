// Reading hierarchy is explicit presentation state; ordinary graph links do not reparent.
function buildOutline(mapId){
 const nodes=Object.values(db.nodes).filter(n=>n.map===mapId&&!n.archived);
 const byId=new Map(nodes.map(n=>[n.id,n]));
 const edges=Object.values(db.edges).filter(e=>e.map===mapId&&byId.has(e.a)&&byId.has(e.b));
 const parent={},children={},depth={},used=new Set(),roots=[];
 for(const n of nodes)children[n.id]=[];
 for(const n of nodes){
  const p=n.outlineParent;
  if(!byId.has(p)||p===n.id||!edges.some(e=>e.a===n.id&&e.b===p||e.b===n.id&&e.a===p))continue;
  let cur=p,cycle=false;
  while(cur){if(cur===n.id){cycle=true;break;}cur=parent[cur];}
  if(!cycle)parent[n.id]=p;
 }
 for(const n of nodes){
  if(parent[n.id]){
   children[parent[n.id]].push(n.id);
   used.add(edges.find(e=>e.a===n.id&&e.b===parent[n.id]||e.b===n.id&&e.a===parent[n.id]).id);
  }else roots.push(n.id);
 }
 const visited=new Set();
 function walk(id,d){if(visited.has(id))return;visited.add(id);depth[id]=d;for(const child of children[id])walk(child,d+1);}
 for(const root of roots)walk(root,0);
 return {nodes,edges,parent,children,depth,roots,cross:edges.filter(e=>!used.has(e.id))};
}
function renderOutline(){
 const o=buildOutline(ui.map),q=queryFor('map'),collapsed=ui.outlineCollapsed||{};
 function item(id){
  const n=db.nodes[id],kids=o.children[id],cross=o.cross.filter(e=>e.a===id||e.b===id),open=!collapsed[id];
  const path=[];let p=o.parent[id];while(p){path.unshift(titleOf('node:'+p));p=o.parent[p];}
  return `<li class="outline-item ${o.depth[id]>=3?'outline-deep':''}" data-outline-node="${id}" data-depth="${o.depth[id]}">
   <div class="outline-entry">
    <div class="outline-row ${ui.selected.includes(id)?'selected':''} ${q&&textMatch(n.text,q)?'search-match':''}">
     ${kids.length?`<button class="outline-toggle" data-action="outline-toggle" data-id="${id}" aria-label="${open?'Zwiń':'Rozwiń'} ${esc(n.text)}" aria-expanded="${open}">${I(open?'down':'arrow')}</button>`:'<span class="outline-terminal"></span>'}
     <button class="outline-main" data-action="outline-open" data-id="${id}" data-outline-open="${id}">${I(n.root?'spark':n.reference?kindIcon[n.reference.split(':')[0]]:'map')}<span><b>${esc(titleOf('node:'+id))}</b>${tasksForNode(id).length?`<small>${tasksForNode(id).length} ${plural(tasksForNode(id).length,'zadanie','zadania','zadań')}</small>`:''}</span></button>
     <div class="outline-actions">${IB('plus','Dopisz gałąź','node-child',`data-id="${id}"`)}<details class="outline-more"><summary aria-label="Więcej działań: ${esc(titleOf('node:'+id))}" title="Więcej działań">···</summary><div>${B(I('edit')+' Edytuj myśl','node-edit',`data-id="${id}"`,'small quiet')}${B(I('send')+' Do rozmowy','share',`data-ref="node:${id}"`,'small quiet')}</div></details></div>
    </div>
    ${o.depth[id]>=3?`<details class="outline-path"><summary aria-label="Pokaż pełną ścieżkę do: ${esc(titleOf('node:'+id))}">${I('down')}<span>W gałęzi: <b>${esc(titleOf('node:'+o.parent[id]))}</b></span></summary><p>${path.map(esc).join(' › ')}</p></details>`:''}
    ${cross.length?`<div class="outline-cross">${cross.map(e=>{const other=e.a===id?e.b:e.a;return `<button data-action="outline-reveal" data-id="${other}" title="Otwórz powiązaną myśl bez zmiany rodzica">${I('git')}<span>Powiązane z <b>${esc(titleOf('node:'+other))}</b></span>${I('arrow')}</button>`;}).join('')}</div>`:''}
   </div>
   ${kids.length&&open?`<ul class="outline-children">${kids.map(item).join('')}</ul>`:''}
  </li>`;
 }
 return `<div class="map-outline"><div class="outline-caption"><span>${o.nodes.length} myśli · ${o.edges.length} połączeń</span>${B('Rozwiń wszystko','outline-expand','','small quiet')}</div><ul class="outline-roots" aria-label="Gałęzie mapy">${o.roots.map(item).join('')}</ul>${!o.nodes.length?'<div class="empty">Dodaj pierwszą myśl.</div>':''}${B(I('upload')+' Wklej listę myśli','paste-outline','','quiet')}</div>`;
}
