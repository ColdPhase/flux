import assert from 'node:assert/strict';
import { createHmac,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createDatabase } from '@flux/db';
import { NotFoundError,type Database,type GithubProvider,type Principal } from '@flux/core';
import type { CreatedThought,GithubPullFacts,Sketch,Thought,WorkItem } from '@flux/contracts';
import { sketchUseCases } from '../../apps/server/src/sketches/adapters.js';
import { taskDiscussionUseCases } from '../../apps/server/src/work/task-discussions.js';
import { nativeWorkInTransaction,workUseCases } from '../../apps/server/src/work/adapters.js';
import { diskFileStorage } from '../../apps/server/src/files/storage.js';
import { createGithubUseCases } from '../../apps/server/src/github/adapters.js';
import { githubWebhookRoutes } from '../../apps/server/src/github/webhook.js';
import { db,pool,connectionString } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect,toolValue } from './support/mcp.js';
import { fillThread,nativeThreadPost,threadBudget,threadCommand,turnLimit,type ThreadNativeScene } from './support/internal-agent-threads.js';
import { backendPid,barrier,waitUntilBlockedBy } from './support/locks.js';
import { internalNativeWork } from './support/internal-native-work.js';

async function setup(){const f=await actionScene(pool),grant=await f.grant('conversation.reply','execute',100);
  const ownerId=(expect(await f.owner.request('GET','/api/v1/me'),200).user as{id:string}).id;
  return{...f,grantId:grant.id,ownerId,principal:{kind:'human' as const,id:ownerId},
    task:async(title:string)=>expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/work`,{body:{title}}),201) as unknown as WorkItem};}
const map=async(f:ThreadNativeScene,scope:'project'|'private'='project')=>expect(await f.owner.request('POST',`/api/v1/workspaces/${f.workspaceId}/sketches`,
  {body:{title:'Canonical source map',scope,...(scope==='project'?{projectId:f.projectId}:{})}}),201) as unknown as Sketch;
const thought=async(f:ThreadNativeScene,s:Sketch,text:string,id=randomUUID())=>(expect(await f.owner.request('POST',`/api/v1/sketches/${s.id}/thoughts`,
  {body:{id,text,x:20,y:20},headers:{'idempotency-key':randomUUID()}}),201) as unknown as CreatedThought).thought;
const edit=(f:ThreadNativeScene,s:Sketch,t:Thought,changes:Record<string,unknown>,key=randomUUID())=>f.owner.request('PATCH',`/api/v1/sketches/${s.id}/thoughts/${t.id}`,
  {body:changes,headers:{'if-match':`"${t.version}"`,'idempotency-key':key}});
const link=async(f:ThreadNativeScene,id:string,t:Thought)=>expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/links`,
  {body:{from:{type:'work',id},to:{type:'thought',id:t.id}}}),201);
async function upload(f:ThreadNativeScene,bytes:Buffer,name='measured.txt'){
  const response=await fetch(new URL(`/api/v1/projects/${f.projectId}/files?uploadId=${randomUUID()}&name=${name}`,f.owner.base),{
    method:'POST',headers:{'content-type':'application/octet-stream',cookie:f.owner.cookieHeader(),origin:f.owner.defaultOrigin},body:Buffer.from(bytes),
  });assert.equal(response.status,201);return await response.json() as{id:string;sha256:string;size:number};}
const publish=(f:ThreadNativeScene,taskId:string,fileId:string,commandId=randomUUID())=>f.owner.request('POST',`/api/v1/work/${taskId}/discussion`,
  {body:{body:'A real published work product',attachmentIds:[fileId],clientMessageId:commandId}});
const count=async(kind:string,taskId:string)=>(await pool.query(`SELECT count(*)::int n FROM agent_thread_artifact_resets r
  JOIN agent_thread_artifact_boundaries b ON b.id=r.boundary_id WHERE b.kind=$1 AND r.task_id=$2 AND r.sequence IS NOT NULL`,[kind,taskId])).rows[0].n as number;
async function bounded<T>(p:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>reject(new Error('Remaining artifact race exceeded10s')),10_000);})]);}finally{clearTimeout(timer);}}

test('real shared project thought content resets direct tasks; geometry/title/no-op/old association/private placement do not',async()=>{
  const f=await setup(),s=await map(f),a=await f.task('First source reader'),b=await f.task('Second source reader'),unlinked=await f.task('Unlinked reader');
  let t=await thought(f,s,'Original measured content');await link(f,a.id,t);await link(f,b.id,t);
  for(const item of[a,b,unlinked])await fillThread(f,item.id,f.grantId);
  t=expect(await edit(f,s,t,{x:40,width:240,shape:'circle'}),200) as unknown as Thought;
  t=expect(await edit(f,s,t,{text:t.text}),200) as unknown as Thought;
  assert.equal(await threadBudget(a.id),5);assert.equal(await threadBudget(b.id),5);
  expect(await f.owner.request('PATCH',`/api/v1/sketches/${s.id}`,{body:{title:'A map title only'},headers:{'if-match':'"1"'}}),200);
  t=expect(await edit(f,s,t,{text:'A genuinely new measured result'}),200) as unknown as Thought;
  assert.equal(await threadBudget(a.id),0);assert.equal(await threadBudget(b.id),0);assert.equal(await threadBudget(unlinked.id),5);
  await fillThread(f,a.id,f.grantId);await link(f,unlinked.id,t);assert.equal(await threadBudget(unlinked.id),5);
  const privateMap=await map(f,'private'),privateThought=await thought(f,privateMap,'Private note');
  expect(await edit(f,privateMap,privateThought,{text:'Private progress'}),200);assert.equal(await threadBudget(a.id),5);
  assert.equal(await count('thought',a.id),1);assert.equal(await count('thought',b.id),1);
});

test('a real native map content command resets once; receipt replay and identical native text cannot replenish',async()=>{
  const f=await setup(),s=await map(f),item=await f.task('Native source mutation'),t=await thought(f,s,'Baseline');await link(f,item.id,t);await fillThread(f,item.id,f.grantId);
  const grant=await f.grant('map.thought.update','execute',10,s.id),command={projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,grantId:grant.id,
    clientCommandId:randomUUID(),peerRequestClass:'execute',sources:[],mapId:s.id,thoughtId:t.id,expectedVersion:t.version,changes:{text:'Real native content progress'}};
  const changed=toolValue(await f.tool('flux_update_thought',command));assert.equal(await threadBudget(item.id),0);await fillThread(f,item.id,f.grantId);
  toolValue(await f.tool('flux_update_thought',command));assert.equal(await threadBudget(item.id),5);
  toolValue(await f.tool('flux_update_thought',{...command,clientCommandId:randomUUID(),expectedVersion:changed.version,changes:{text:'Real native content progress'}}));
  assert.equal(await threadBudget(item.id),5);assert.equal(await count('thought',item.id),1);
});

test('original verified file publication resets its bound task once; staging/replay/consumed bytes do not, human-message rule remains separate',async()=>{
  const f=await setup(),a=await f.task('Original bytes'),b=await f.task('Separate byte consumer'),bytes=Buffer.from('Genuine measured artifact bytes');
  for(const item of[a,b])await fillThread(f,item.id,f.grantId);
  const first=await upload(f,bytes);assert.equal(await threadBudget(a.id),5);const commandId=randomUUID();expect(await publish(f,a.id,first.id,commandId),201);
  assert.equal(await threadBudget(a.id),0);assert.equal(await threadBudget(b.id),5);await fillThread(f,a.id,f.grantId);
  expect(await publish(f,a.id,first.id,commandId),201);assert.equal(await threadBudget(a.id),5);
  const same=await upload(f,bytes,'renamed.txt');expect(await publish(f,a.id,same.id),201);assert.equal(await threadBudget(a.id),5);assert.equal(await count('file',a.id),1);
  const other=await upload(f,bytes);expect(await publish(f,b.id,other.id),201);assert.equal(await threadBudget(b.id),0);
  const duplicateForHuman=await upload(f,bytes);expect(await f.owner.request('POST',`/api/v1/work/${a.id}/agent-thread`,
    {body:{body:'A genuinely new human message',attachmentIds:[duplicateForHuman.id],clientMessageId:randomUUID()}}),201);
  assert.equal(await threadBudget(a.id),0);assert.equal(await count('file',a.id),1);
});

test('project thought reset and native post serialize in both forced orders; rollback/restart retain source and budget',{timeout:60_000},async()=>{
  for(const winner of['post','thought'] as const){const f=await setup(),s=await map(f),item=await f.task('Ordered thought'),t=await thought(f,s,'Baseline');await link(f,item.id,t);
    for(let i=0;i<4;i++)await nativeThreadPost(f,threadCommand(f,item.id,f.grantId));
    const held=barrier<number>(),release=barrier();let other:Promise<unknown>|undefined;
    const first=db.transaction(async tx=>{if(winner==='post')await nativeThreadPost(f,threadCommand(f,item.id,f.grantId),tx);
      else await sketchUseCases(tx).updateThought(f.principal,s.id,t.id,{text:'Ordered new content',expectedVersion:t.version});held.resolve(await backendPid(tx));await bounded(release.promise);});void first.catch(()=>undefined);
    try{const pid=await bounded(held.promise);other=winner==='post'?edit(f,s,t,{text:'Ordered new content'}):nativeThreadPost(f,threadCommand(f,item.id,f.grantId));void other.catch(()=>undefined);
      await waitUntilBlockedBy(pool,pid);release.resolve();await bounded(first);const result=await bounded(other);if(winner==='post')assert.equal((result as{status:number}).status,200);
      assert.equal(await threadBudget(item.id),winner==='post'?0:1);
    }finally{release.resolve();await bounded(Promise.all([first.catch(()=>undefined),other?.catch(()=>undefined)]));}}
  const f=await setup(),s=await map(f),item=await f.task('Rolled back source'),t=await thought(f,s,'Kept body');await link(f,item.id,t);await fillThread(f,item.id,f.grantId);
  const sentinel=new Error('After thought reset');await assert.rejects(db.transaction(async tx=>{await sketchUseCases(tx).updateThought(f.principal,s.id,t.id,{text:'Must roll back',expectedVersion:t.version});throw sentinel;}),sentinel);
  assert.equal(await threadBudget(item.id),5);assert.equal(await count('thought',item.id),0);
  const fresh=createDatabase(connectionString);try{await assert.rejects(nativeThreadPost(f,threadCommand(f,item.id,f.grantId),fresh.db),turnLimit);}finally{await fresh.pool.end();}
});

test('real file reset versus native post has both forced orders, and rollback leaves no publication/reset',{timeout:60_000},async()=>{
  const storage=await diskFileStorage(process.env.FLUX_TEST_FILES_DIR??'/data/files');
  for(const winner of['post','file'] as const){const f=await setup(),item=await f.task('Ordered file'),file=await upload(f,Buffer.from('Real ordered bytes'));
    for(let i=0;i<4;i++)await nativeThreadPost(f,threadCommand(f,item.id,f.grantId));const command={body:'Published file',attachmentIds:[file.id],clientMessageId:randomUUID()};
    const held=barrier<number>(),release=barrier();let other:Promise<unknown>|undefined;
    const first=db.transaction(async tx=>{if(winner==='post')await nativeThreadPost(f,threadCommand(f,item.id,f.grantId),tx);
      else await taskDiscussionUseCases(tx,storage).contribute(f.principal,item.id,command);held.resolve(await backendPid(tx));await bounded(release.promise);});void first.catch(()=>undefined);
    try{const pid=await bounded(held.promise);other=winner==='post'?f.owner.request('POST',`/api/v1/work/${item.id}/discussion`,{body:command}):nativeThreadPost(f,threadCommand(f,item.id,f.grantId));void other.catch(()=>undefined);
      await waitUntilBlockedBy(pool,pid);release.resolve();await bounded(first);const result=await bounded(other);if(winner==='post')assert.equal((result as{status:number}).status,201);
      assert.equal(await threadBudget(item.id),winner==='post'?0:1);
    }finally{release.resolve();await bounded(Promise.all([first.catch(()=>undefined),other?.catch(()=>undefined)]));}}
  const f=await setup(),item=await f.task('File rollback'),file=await upload(f,Buffer.from('Must remain staged'));await fillThread(f,item.id,f.grantId);
  const sentinel=new Error('After actual file publication');await assert.rejects(db.transaction(async tx=>{await taskDiscussionUseCases(tx,storage).contribute(f.principal,item.id,
    {body:'Must roll back',attachmentIds:[file.id],clientMessageId:randomUUID()});throw sentinel;}),sentinel);
  assert.equal(await threadBudget(item.id),5);assert.equal(await count('file',item.id),0);
  assert.equal((await pool.query('SELECT published_at FROM project_files WHERE id=$1',[file.id])).rows[0].published_at,null);
});

/** Existing canonical GitHub provider seam, with no real vendor account/network/spend. */
class ProgressProvider implements GithubProvider{
  head='a'.repeat(40);allowed=true;title='Private verified source';
  readonly generation=randomUUID();
  constructor(readonly ownerId:string){}
  async repository(principal:Principal,installationId:string,repositoryId:string){
    if(!this.allowed||principal.kind!=='human'||principal.id!==this.ownerId||installationId!=='555'||repositoryId!=='777')throw new NotFoundError('Repository','GITHUB_ACCESS_UNAVAILABLE');
    return{host:'github.com' as const,installationId,repositoryId,owner:'fixture',name:'private',private:true,url:'https://github.com/fixture/private',
      githubUserId:'999',appId:'12345',authorizationGeneration:this.generation};
  }
  async pull(principal:Principal,repository:{repositoryId:string},number:number):Promise<GithubPullFacts>{
    await this.repository(principal,'555',repository.repositoryId);
    return{repositoryId:'777',pullId:'777'+number,number,title:this.title,url:`https://github.com/fixture/private/pull/${number}`,
      author:{id:'765',login:'source-author'},headSha:this.head,state:'open',draft:false,merged:false,
      sourceCreatedAt:'2026-10-10T10:00:00Z',sourceUpdatedAt:'2026-10-11T04:00:00Z',sourceMergedAt:null,
      checks:[],reviews:[],truncated:false,execution:'ready_for_review'};
  }
}
async function github(f:Awaited<ReturnType<typeof setup>>){
  const provider=new ProgressProvider(f.ownerId),commands=createGithubUseCases(db,provider),binding=await commands.bind(f.principal,f.projectId,{installationId:'555',repositoryId:'777'});
  const secret='fixture-remaining-artifacts-signed-secret',app=Fastify();await app.register(githubWebhookRoutes,{secret,appId:'12345',admit:commands.admit});await app.ready();
  return{provider,commands,binding,app,async delivery(){
    const id=randomUUID(),payload=JSON.stringify({action:'synchronize',installation:{id:555},repository:{id:777},pull_request:{id:77742,number:42,head:{sha:provider.head},base:{repo:{id:777}}}});
    const response=await app.inject({method:'POST',url:'/api/v1/integrations/github/webhook',payload,headers:{'content-type':'application/json','x-github-delivery':id,
      'x-github-event':'pull_request','x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(payload).digest('hex')}});
    assert.equal(response.statusCode,202,response.body);return id;
  }};
}

test('actual verified PR link/full-head changes reset each direct task once; title/check/duplicate/old head/current authority do not',async()=>{
  const f=await setup(),a=await f.task('First PR task'),b=await f.task('Second PR task');for(const item of[a,b])await fillThread(f,item.id,f.grantId);
  const g=await github(f);try{
    await g.commands.link(f.principal,a.id,{bindingId:g.binding.id,number:42,role:'related'});await g.commands.link(f.principal,b.id,{bindingId:g.binding.id,number:42,role:'related'});
    assert.equal(await threadBudget(a.id),0);assert.equal(await threadBudget(b.id),0);for(const item of[a,b])await fillThread(f,item.id,f.grantId);
    g.provider.title='A title/status projection only';const same=await g.delivery();assert.equal(await g.commands.process(same,g.binding.id),'completed');
    assert.equal(await threadBudget(a.id),5);assert.equal(await threadBudget(b.id),5);
    g.provider.head='b'.repeat(40);const changed=await g.delivery();assert.equal(await g.commands.process(changed,g.binding.id),'completed');
    assert.equal(await threadBudget(a.id),0);assert.equal(await threadBudget(b.id),0);await fillThread(f,a.id,f.grantId);
    assert.equal(await g.commands.process(changed,g.binding.id),'already_completed');assert.equal(await threadBudget(a.id),5);
    g.provider.head='a'.repeat(40);assert.equal(await g.commands.process(await g.delivery(),g.binding.id),'completed');assert.equal(await threadBudget(a.id),5);
    assert.equal(await count('github_pr',a.id),2);g.provider.head='c'.repeat(40);const revoked=await g.delivery();g.provider.allowed=false;
    await assert.rejects(g.commands.process(revoked,g.binding.id));assert.equal(await threadBudget(a.id),5);assert.equal(await count('github_pr',a.id),2);
  }finally{await g.app.close();}
});

test('verified PR head reset and native post serialize in both forced orders; full rollback leaves no link/reset',{timeout:60_000},async()=>{
  for(const winner of['post','pr'] as const){const f=await setup(),item=await f.task('Ordered PR'),g=await github(f);try{
    await g.commands.link(f.principal,item.id,{bindingId:g.binding.id,number:42,role:'related'});
    for(let i=0;i<4;i++)await nativeThreadPost(f,threadCommand(f,item.id,f.grantId));g.provider.head='b'.repeat(40);const delivery=await g.delivery();
    const held=barrier<number>(),release=barrier();let other:Promise<unknown>|undefined;
    const first=db.transaction(async tx=>{if(winner==='post')await nativeThreadPost(f,threadCommand(f,item.id,f.grantId),tx);
      else await createGithubUseCases(tx,g.provider).process(delivery,g.binding.id);held.resolve(await backendPid(tx));await bounded(release.promise);});void first.catch(()=>undefined);
    try{const pid=await bounded(held.promise);other=winner==='post'?g.commands.process(delivery,g.binding.id):nativeThreadPost(f,threadCommand(f,item.id,f.grantId));void other.catch(()=>undefined);
      await waitUntilBlockedBy(pool,pid);release.resolve();await bounded(first);await bounded(other);assert.equal(await threadBudget(item.id),winner==='post'?0:1);
    }finally{release.resolve();await bounded(Promise.all([first.catch(()=>undefined),other?.catch(()=>undefined)]));}
  }finally{await g.app.close();}}
  const f=await setup(),item=await f.task('PR rollback'),g=await github(f);try{await fillThread(f,item.id,f.grantId);
    const sentinel=new Error('After real verified PR link');await assert.rejects(db.transaction(async tx=>{
      await createGithubUseCases(tx,g.provider).link(f.principal,item.id,{bindingId:g.binding.id,number:44,role:'related'});throw sentinel;
    }),sentinel);assert.equal(await threadBudget(item.id),5);assert.equal(await count('github_pr',item.id),0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM github_task_links WHERE task_id=$1',[item.id])).rows[0].n,0);
  }finally{await g.app.close();}
});

test('closed internal thought-source native adapter and supported file/PR creation retain both real artifact-versus-Undo outcomes',{timeout:120_000},async()=>{
  const storage=await diskFileStorage(process.env.FLUX_TEST_FILES_DIR??'/data/files');
  for(const kind of['thought','file','github_pr'] as const)for(const winner of['artifact','undo'] as const){
    const f=await setup(),s=await map(f),t=await thought(f,s,'Initial task source'),file=await upload(f,Buffer.from('Unused task work product'));
    const created=await f.grant('work.create','execute',10),input={projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,
      grantId:created.id,clientCommandId:randomUUID(),peerRequestClass:'execute' as const,sources:[]};
    const saved=kind==='thought'?await internalNativeWork(f,input,{title:'Unused canonical target',sources:[{type:'thought',id:t.id}]})
      :toolValue(await f.tool('flux_create_task',{...input,task:{title:'Unused canonical target'}}));
    const item=await f.read(String(saved.workId)) as unknown as WorkItem,g=kind==='github_pr'?await github(f):null;
    const command={body:'Actual task work product',attachmentIds:[file.id],clientMessageId:randomUUID()},undo={clientCommandId:randomUUID(),expectedVersion:item.version};
    const effect=async(database:Database)=>kind==='thought'?sketchUseCases(database).updateThought(f.principal,s.id,t.id,{text:'New actual source content',expectedVersion:t.version})
      :kind==='file'?taskDiscussionUseCases(database,storage).contribute(f.principal,item.id,command)
      :createGithubUseCases(database,g!.provider).link(f.principal,item.id,{bindingId:g!.binding.id,number:42,role:'related'});
    const held=barrier<number>(),release=barrier();let other:Promise<unknown>|undefined;
    const first=db.transaction(async tx=>{if(winner==='artifact')await effect(tx);
      else await workUseCases(tx).undoTaskCreation(f.principal,item.id,undo);held.resolve(await backendPid(tx));await bounded(release.promise);});void first.catch(()=>undefined);
    try{const pid=await bounded(held.promise);
      other=winner==='artifact'?f.owner.request('POST',`/api/v1/work/${item.id}/creation-undo`,{body:undo}):effect(db);void other.catch(()=>undefined);
      await waitUntilBlockedBy(pool,pid);release.resolve();await bounded(first);
      if(winner==='artifact')assert.equal((await bounded(other) as{status:number}).status,kind==='thought'?200:409); // #553: a linked-thought edit is not use
      else if(kind==='thought')await bounded(other); // Reverted provenance does not poison an unrelated source edit.
      else await assert.rejects(bounded(other));
      const state=(await pool.query('SELECT first_persisted_use_at,creation_reverted_at FROM project_work_items WHERE id=$1',[item.id])).rows[0];
      const undone=winner==='undo'||kind==='thought';
      assert.equal(state.creation_reverted_at===null,!undone);assert.equal(state.first_persisted_use_at===null,undone);
      assert.equal(await count(kind,item.id),winner==='artifact'?1:0);
      assert.equal((await pool.query("SELECT count(*)::int n FROM project_conversations WHERE space='agents' AND work_id=$1",[item.id])).rows[0].n,0);
      if(kind==='file'&&winner==='undo')assert.equal((await pool.query('SELECT published_at FROM project_files WHERE id=$1',[file.id])).rows[0].published_at,null);
      if(kind==='github_pr'&&winner==='undo')assert.equal((await pool.query('SELECT count(*)::int n FROM github_task_links WHERE task_id=$1',[item.id])).rows[0].n,0);
    }finally{release.resolve();await bounded(Promise.all([first.catch(()=>undefined),other?.catch(()=>undefined)]));await g?.app.close();}
  }
});

test('closed native thought-source fixture preserves public refusal and actual private/foreign/revoked authority checks',async()=>{
  const f=await setup(),s=await map(f),t=await thought(f,s,'Real project source'),grant=await f.grant('work.create','execute',10);
  const input={projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,grantId:grant.id,clientCommandId:randomUUID(),peerRequestClass:'execute' as const,sources:[]};
  const before=await f.tasks(),refused=await f.tool('flux_create_task',{...input,task:{title:'Public thought input stays unavailable',sources:[{type:'thought',id:t.id}]}});
  assert.equal((refused?.result as{isError?:boolean}).isError,true);assert.equal(await f.tasks(),before);assert.equal(await f.used(grant.id),0);
  const privateMap=await map(f,'private'),privateThought=await thought(f,privateMap,'Private source');
  const other=expect(await f.owner.request('POST',`/api/v1/workspaces/${f.workspaceId}/projects`,{body:{name:'Other source scope',visibility:'restricted'}}),201);
  const foreignMap=expect(await f.owner.request('POST',`/api/v1/workspaces/${f.workspaceId}/sketches`,{body:{title:'Foreign source',scope:'project',projectId:other.id}}),201) as unknown as Sketch;
  const foreign=await thought(f,foreignMap,'Foreign body');
  for(const source of[privateThought,foreign])await assert.rejects(internalNativeWork(f,{...input,clientCommandId:randomUUID()},
    {title:'Denied source',sources:[{type:'thought',id:source.id}]}));
  assert.equal(await f.tasks(),before);assert.equal(await f.used(grant.id),0);
  expect(await f.owner.request('DELETE',`/api/v1/agent-connections/${f.connectionId}/action-grants/${grant.id}`),204);
  await assert.rejects(internalNativeWork(f,{...input,clientCommandId:randomUUID()},{title:'Denied current grant',sources:[{type:'thought',id:t.id}]}));
  assert.equal(await f.tasks(),before);assert.equal(await f.used(grant.id),0);
});

test('editing a thought an unused AI-created task links to resets its budget but keeps Undo; a task-targeted use still ends it (#553)',async()=>{
  const f=await setup(),s=await map(f);let t=await thought(f,s,'Initial task source');
  const item=await db.transaction(async tx=>{const native=nativeWorkInTransaction(tx);
    const created=await native.createWork({kind:'agent',id:f.agentId},f.projectId,{title:'Unused thought-linked task',sources:[{type:'thought',id:t.id}]});await native.flushEvents();return created;});
  const state=async()=>({used:(await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1',[item.id])).rows[0].first_persisted_use_at as Date|null,
    undo:(await f.read(item.id) as unknown as WorkItem).creationUndo});
  assert.deepEqual(await state(),{used:null,undo:{eligible:true,reason:'eligible'}});
  t=expect(await edit(f,s,t,{text:'A genuinely new measured result'}),200) as unknown as Thought;
  assert.equal(await count('thought',item.id),1,'the content edit still resets the agent-thread turn budget');
  assert.deepEqual(await state(),{used:null,undo:{eligible:true,reason:'eligible'}},'a linked thought edit is not use of the task');
  const grant=await f.grant('map.thought.update','execute',10,s.id);
  toolValue(await f.tool('flux_update_thought',{projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,grantId:grant.id,clientCommandId:randomUUID(),peerRequestClass:'execute',
    sources:[],mapId:s.id,thoughtId:t.id,expectedVersion:t.version,changes:{text:'Native content progress'}}));
  assert.equal(await count('thought',item.id),2);assert.deepEqual(await state(),{used:null,undo:{eligible:true,reason:'eligible'}});
  expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/results`,
    {body:{title:'Real result',finding:'positive',evidence:'Observed behavior',work:[item.id],clientCommandId:randomUUID()}}),201);
  const used=await state();assert.ok(used.used,'a result about the task is a task-targeted use');assert.equal(used.undo?.reason,'task_used');
  assert.equal((await f.owner.request('POST',`/api/v1/work/${item.id}/creation-undo`,{body:{clientCommandId:randomUUID(),expectedVersion:item.version}})).status,409);
});
