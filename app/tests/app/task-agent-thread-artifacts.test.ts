import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { artifactResetRows,createDatabase,sql,taskUseRows } from '@flux/db';
import type { Doc,WorkItem,Decision } from '@flux/contracts';
import { docUseCases } from '../../apps/server/src/docs/adapters.js';
import { workUseCases } from '../../apps/server/src/work/adapters.js';
import { actionScene } from './support/mcp-actions.js';
import { expect,toolValue } from './support/mcp.js';
import { db,pool,connectionString } from './support/db.js';
import { fillThread,nativeThreadPost,threadBudget,threadCommand,turnLimit,type ThreadNativeScene } from './support/internal-agent-threads.js';
import { backendPid,barrier,waitUntilBlockedBy } from './support/locks.js';
import { person } from './support/people.js';

async function setup(){const f=await actionScene(pool),grant=await f.grant('conversation.reply','execute',100);
  const task=async(title:string)=>expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/work`,{body:{title}}),201) as unknown as WorkItem;
  return{...f,grantId:grant.id,task};}
async function doc(f:ThreadNativeScene,body:string){return expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/docs`,{body:{title:'Measured work',body,state:'published'}}),201) as unknown as Doc;}
const edit=(f:ThreadNativeScene,d:Doc,body:Record<string,unknown>,key=randomUUID())=>f.owner.request('PATCH',`/api/v1/docs/${d.id}`,
  {body,headers:{'if-match':`"${d.version}"`,'idempotency-key':key}});
const link=(f:ThreadNativeScene,from:{type:'work'|'result';id:string},to:Record<string,unknown>)=>f.owner.request('POST',`/api/v1/projects/${f.projectId}/links`,{body:{from,to}});
const mentions=(...ids:string[])=>ids.map((id,i)=>`[Measured task${i}](flux:work/${id})`).join('\n');

test('new committed doc mentions reset only the new set; shared/current references work and title/no-op/old links do not',async()=>{
  const f=await setup(),a=await f.task('First'),b=await f.task('Second'),c=await f.task('Third');
  for(const t of[a,b,c])await fillThread(f,t.id,f.grantId);
  let d=await doc(f,mentions(a.id,b.id));assert.equal(await threadBudget(a.id),0);assert.equal(await threadBudget(b.id),0);assert.equal(await threadBudget(c.id),5);
  await fillThread(f,a.id,f.grantId);await fillThread(f,b.id,f.grantId);
  d=expect(await edit(f,d,{title:'A title change only'}),200) as unknown as Doc;
  assert.equal(await threadBudget(a.id),5);assert.equal(await threadBudget(b.id),5);
  const unchanged=expect(await edit(f,d,{body:d.body}),200) as unknown as Doc;assert.equal(unchanged.version,d.version);
  expect(await link(f,{type:'work',id:c.id},{type:'doc',id:d.id}),201);assert.equal(await threadBudget(c.id),5);
  d=expect(await edit(f,d,{body:mentions(a.id,c.id)+'\nA genuinely new observation.'}),200) as unknown as Doc;
  assert.equal(await threadBudget(a.id),0);assert.equal(await threadBudget(c.id),0);assert.equal(await threadBudget(b.id),5);
  const recipients=(await pool.query("SELECT r.task_id FROM agent_thread_artifact_resets r JOIN agent_thread_artifact_boundaries b ON b.id=r.boundary_id WHERE b.kind='doc' AND b.source_id=$1 AND b.revision=$2 ORDER BY r.task_id",[d.id,String(d.version)])).rows.map(r=>r.task_id);
  assert.deepEqual(recipients,[a.id,c.id].sort());
});

test('pinned material/doc revisions never follow a later version; actual material replay/title/no-op/old-link leaves budget exhausted',async()=>{
  const f=await setup(),current=await f.task('Current doc'),pinned=await f.task('Pinned doc'),material=await f.task('Pinned material');
  let d=await doc(f,'Baseline content without task mentions');
  expect(await link(f,{type:'work',id:current.id},{type:'doc',id:d.id}),201);
  expect(await link(f,{type:'work',id:pinned.id},{type:'material',id:d.id,version:1}),201);
  expect(await link(f,{type:'work',id:material.id},{type:'material',id:f.source.materialId,version:1}),201);
  for(const t of[current,pinned,material])await fillThread(f,t.id,f.grantId);
  d=expect(await edit(f,d,{body:'New canonical doc body'}),200) as unknown as Doc;
  assert.equal(await threadBudget(current.id),0);assert.equal(await threadBudget(pinned.id),5);
  const mutation={clientMutationId:randomUUID(),expectedVersion:1,body:'A new real material revision'};
  expect(await f.owner.request('PATCH',`/api/v1/materials/${f.source.materialId}`,{body:mutation}),200);
  expect(await f.owner.request('PATCH',`/api/v1/materials/${f.source.materialId}`,{body:mutation}),200);
  expect(await f.owner.request('PATCH',`/api/v1/materials/${f.source.materialId}`,{body:{clientMutationId:randomUUID(),expectedVersion:2,title:'Title only'}}),200);
  expect(await f.owner.request('PATCH',`/api/v1/materials/${f.source.materialId}`,{body:{clientMutationId:randomUUID(),expectedVersion:3,body:mutation.body}}),200);
  expect(await link(f,{type:'work',id:material.id},{type:'material',id:f.source.materialId,version:2}),201);
  assert.equal(await threadBudget(material.id),5);await assert.rejects(nativeThreadPost(f,threadCommand(f,material.id,f.grantId)),turnLimit);
  assert.equal((await pool.query("SELECT count(*)::int n FROM agent_thread_artifact_resets r JOIN agent_thread_artifact_boundaries b ON b.id=r.boundary_id WHERE r.task_id=$1 AND b.kind='material'",[material.id])).rows[0].n,0);
  // Supported material refs always pin a real version; no fabricated unpinned SQL/public journey.
});

test('real native doc creation is a canonical reset; document reads and reset without a thread create no agent conversation',async()=>{
  const f=await setup(),item=await f.task('Native doc task'),empty=await f.task('No thread yet');await fillThread(f,item.id,f.grantId);
  const grant=await f.grant('doc.create','execute',10);
  const value=toolValue(await f.tool('flux_create_doc',{projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,grantId:grant.id,
    clientCommandId:randomUUID(),peerRequestClass:'execute',sources:[],doc:{title:'Actual native artifact',body:mentions(item.id,empty.id),state:'published'}}));
  assert.equal(await threadBudget(item.id),0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM project_conversations WHERE work_id=$1',[empty.id])).rows[0].n,0);
  expect(await f.owner.request('GET',`/api/v1/docs/${value.docId}`),200);assert.equal(await threadBudget(item.id),0);
});

test('new immutable native result resets its about tasks once; receipt replay and old related links cannot replenish',async()=>{
  const f=await setup(),a=await f.task('Result target'),b=await f.task('Incidental source');for(const t of[a,b])await fillThread(f,t.id,f.grantId);
  const grant=await f.grant('result.record','execute',10),command={projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,grantId:grant.id,
    clientCommandId:randomUUID(),peerRequestClass:'execute',sources:[],result:{title:'Measurement confirmed',finding:'positive',evidence:'Actual comparison',work:[a.id]}};
  const saved=toolValue(await f.tool('flux_record_result',command));assert.equal(await threadBudget(a.id),0);assert.equal(await threadBudget(b.id),5);
  await fillThread(f,a.id,f.grantId);toolValue(await f.tool('flux_record_result',command));assert.equal(await threadBudget(a.id),5);
  expect(await link(f,{type:'result',id:String(saved.resultId)},{type:'work',id:b.id}),201);assert.equal(await threadBudget(b.id),5);
  assert.equal((await pool.query("SELECT count(*)::int n FROM agent_thread_artifact_resets r JOIN agent_thread_artifact_boundaries b ON b.id=r.boundary_id WHERE b.kind='result' AND b.source_id=$1",[saved.resultId])).rows[0].n,1);
});

test('actual proposed/accepted/superseded decision boundaries reset their own direct tasks, never incidental sources',async()=>{
  const f=await setup(),a=await f.task('Earlier rule'),b=await f.task('New rule'),other=await f.task('Incidental');for(const t of[a,b,other])await fillThread(f,t.id,f.grantId);
  const earlier=expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/decisions`,{body:{title:'First rule',rationale:'Observed data',affects:[a.id],sources:[{type:'work',id:other.id}]}}),201) as unknown as Decision;
  assert.equal(await threadBudget(a.id),0);assert.equal(await threadBudget(other.id),5);
  await fillThread(f,a.id,f.grantId);expect(await f.owner.request('POST',`/api/v1/decisions/${earlier.id}/accept`,{body:{},headers:{'if-match':'"1"'}}),200);assert.equal(await threadBudget(a.id),0);
  await fillThread(f,a.id,f.grantId);
  const next=expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/decisions`,{body:{title:'Changed rule',rationale:'New observed condition',supersedes:earlier.id,affects:[b.id]}}),201) as unknown as Decision;
  assert.equal(await threadBudget(a.id),5);assert.equal(await threadBudget(b.id),0);await fillThread(f,b.id,f.grantId);
  expect(await f.owner.request('POST',`/api/v1/decisions/${next.id}/accept`,{body:{},headers:{'if-match':'"1"'}}),200);
  assert.equal(await threadBudget(a.id),0);assert.equal(await threadBudget(b.id),0);assert.equal(await threadBudget(other.id),5);
});

async function bounded<T>(promise:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Artifact race exceeded10s')),10_000);})]);}finally{clearTimeout(timer);}}
test('canonical doc reset and native post have both forced lock orders and a nested rollback preserves source/budget', {timeout:60_000},async()=>{
  for(const winner of['post','reset'] as const){
    const f=await setup(),item=await f.task('Ordered current doc'),d=await doc(f,'Baseline');expect(await link(f,{type:'work',id:item.id},{type:'doc',id:d.id}),201);
    for(let i=0;i<4;i++)await nativeThreadPost(f,threadCommand(f,item.id,f.grantId));
    const ownerId=(expect(await f.owner.request('GET','/api/v1/me'),200).user as{id:string}).id,held=barrier<number>(),release=barrier();let other:Promise<unknown>|undefined;
    const first=db.transaction(async tx=>{if(winner==='post')await nativeThreadPost(f,threadCommand(f,item.id,f.grantId),tx);
      else await docUseCases(tx).updateDoc({kind:'human',id:ownerId},d.id,{body:'Committed content reset'},d.version);
      held.resolve(await backendPid(tx));await bounded(release.promise);});void first.catch(()=>undefined);
    try{const pid=await bounded(held.promise);other=winner==='post'?edit(f,d,{body:'Committed content reset'}):nativeThreadPost(f,threadCommand(f,item.id,f.grantId));void other.catch(()=>undefined);
      await waitUntilBlockedBy(pool,pid);release.resolve();await bounded(first);const result=await bounded(other);if(winner==='post')assert.equal((result as{status:number}).status,200);
      assert.equal(await threadBudget(item.id),winner==='post'?0:1);
    }finally{release.resolve();await bounded(Promise.all([first.catch(()=>undefined),other?.catch(()=>undefined)]));}
  }
  const f=await setup(),item=await f.task('Rollback artifact'),d=await doc(f,'Original body');expect(await link(f,{type:'work',id:item.id},{type:'doc',id:d.id}),201);await fillThread(f,item.id,f.grantId);
  const ownerId=(expect(await f.owner.request('GET','/api/v1/me'),200).user as{id:string}).id,sentinel=new Error('After canonical reset');
  await assert.rejects(db.transaction(async tx=>{await docUseCases(tx).updateDoc({kind:'human',id:ownerId},d.id,{body:'Must roll back'},d.version);
    const pulse=await tx.execute<{n:number}>(sql`SELECT count(*)::int n FROM agent_thread_artifact_resets r JOIN agent_thread_artifact_boundaries b ON b.id=r.boundary_id WHERE b.source_id=${d.id} AND b.revision='2'`);assert.equal(pulse.rows[0]!.n,1);throw sentinel;}),sentinel);
  assert.equal(await threadBudget(item.id),5);assert.equal((expect(await f.owner.request('GET',`/api/v1/docs/${d.id}`),200) as unknown as Doc).body,'Original body');
  const fresh=createDatabase(connectionString);try{await assert.rejects(nativeThreadPost(f,threadCommand(f,item.id,f.grantId),fresh.db),turnLimit);}finally{await fresh.pool.end();}
});

test('actual result reset versus unused native-task Undo has both forced orders without partial result/reset/use', {timeout:60_000},async()=>{
  for(const winner of['result','undo'] as const){const f=await setup(),create=await f.grant('work.create','execute',10);
    const saved=toolValue(await f.tool('flux_create_task',{projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,grantId:create.id,clientCommandId:randomUUID(),peerRequestClass:'execute',sources:[],task:{title:'Unused artifact target'}}));
    const item=await f.read(String(saved.workId)) as unknown as WorkItem,ownerId=(expect(await f.owner.request('GET','/api/v1/me'),200).user as{id:string}).id;
    const command={title:'Real result',finding:'positive' as const,evidence:'Observed behavior',work:[item.id],clientCommandId:randomUUID()},held=barrier<number>(),release=barrier();let other:Promise<unknown>|undefined;
    const first=db.transaction(async tx=>{const work=workUseCases(tx);if(winner==='result')await work.createResult({kind:'human',id:ownerId},f.projectId,command);
      else await work.undoTaskCreation({kind:'human',id:ownerId},item.id,{clientCommandId:randomUUID(),expectedVersion:item.version});held.resolve(await backendPid(tx));await bounded(release.promise);});void first.catch(()=>undefined);
    try{const pid=await bounded(held.promise);other=winner==='result'?f.owner.request('POST',`/api/v1/work/${item.id}/creation-undo`,{body:{clientCommandId:randomUUID(),expectedVersion:item.version}})
      :f.owner.request('POST',`/api/v1/projects/${f.projectId}/results`,{body:command});void other.catch(()=>undefined);await waitUntilBlockedBy(pool,pid);release.resolve();await bounded(first);
      assert.equal((await bounded(other) as{status:number}).status,409);
      const pulses=(await pool.query('SELECT count(*)::int n FROM agent_thread_artifact_resets WHERE task_id=$1',[item.id])).rows[0].n;assert.equal(pulses,winner==='result'?1:0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM project_conversations WHERE work_id=$1',[item.id])).rows[0].n,0);
    }finally{release.resolve();await bounded(Promise.all([first.catch(()=>undefined),other?.catch(()=>undefined)]));}}
});

test('current viewer/non-reader rights and forged/old boundary packets cannot mutate source or replenish a later budget',async()=>{
  const f=await setup(),item=await f.task('Private source authority'),d=await doc(f,'Authorized body');expect(await link(f,{type:'work',id:item.id},{type:'doc',id:d.id}),201);
  await fillThread(f,item.id,f.grantId);const changed=expect(await edit(f,d,{body:'Actual revision'}),200) as unknown as Doc;await fillThread(f,item.id,f.grantId);
  const [viewer,outsider]=await Promise.all([person('artifact-viewer'),person('artifact-outsider')]);
  expect(await f.owner.request('POST',`/api/v1/workspaces/${f.workspaceId}/members`,{body:{email:viewer.email,role:'member'}}),201);
  expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/grants`,{body:{principal:{kind:'human',id:viewer.id},role:'viewer'}}),201);
  assert.equal((await viewer.browser.request('PATCH',`/api/v1/docs/${d.id}`,{body:{body:'Denied'},headers:{'if-match':`"${changed.version}"`}})).status,403);
  assert.equal((await outsider.browser.request('GET',`/api/v1/docs/${d.id}`)).status,404);
  await assert.rejects(pool.query(`INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,transaction_id)
    VALUES($1,$2,'doc',$3,'9000',txid_current())`,[f.workspaceId,f.projectId,d.id]),/fresh canonical/);
  await db.transaction(async tx=>{const fence=await taskUseRows(tx).prepare([item.id]);
    await artifactResetRows(tx).canonical({workspaceId:f.workspaceId,projectId:f.projectId},{kind:'doc',id:d.id,version:changed.version},
      {kind:'doc',id:d.id,revision:String(changed.version)},fence);});
  assert.equal(await threadBudget(item.id),5);assert.equal((expect(await f.owner.request('GET',`/api/v1/docs/${d.id}`),200) as unknown as Doc).body,'Actual revision');
});
