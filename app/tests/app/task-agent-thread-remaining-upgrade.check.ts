// The runner mounts this check read-only into the immutable pre-cutover test image for preparation,
// then uses the head image after real pg_dump/restore and migration. No product-row SQL fabrication.
// NOTE (#400): no script runs this file yet; the runner is a follow-up. Its pins are the head ledger: main's
// migrations through 0094 plus the PR's late 0082, 0087, 0088 and 0089 (migrator order, missing files only).
import assert from 'node:assert/strict';
import { createHmac,randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { assertExactMigrationLedger,FLUX_SCHEMA_VERSION,readAppliedMigrationVersions,readMigrationManifest } from '@flux/db';
import { NotFoundError,type GithubProvider,type Principal } from '@flux/core';
import type { GithubPullFacts,CreatedThought,Sketch,WorkItem } from '@flux/contracts';
import { createGithubUseCases } from '../../apps/server/src/github/adapters.js';
import { githubWebhookRoutes } from '../../apps/server/src/github/webhook.js';
import { Browser } from './support/http.js';
import { actionScene } from './support/mcp-actions.js';
import { expect,toolValue } from './support/mcp.js';
import { db,pool } from './support/db.js';
import { nativeThreadPost,threadBudget,threadCommand,turnLimit,type ThreadNativeScene } from './support/internal-agent-threads.js';

const directory=process.env.FLUX_G2_UPGRADE_EVIDENCE;if(!directory)throw new Error('FLUX_G2_UPGRADE_EVIDENCE required');
const phase=process.env.FLUX_G2_UPGRADE_PHASE;if(!['prepare','verify'].includes(phase??''))throw new Error('Expected prepare/verify phase');
const tables=['auth_users','workspaces','workspace_members','projects','agents','project_grants','agent_connections','agent_connection_projects',
  'oauth_client','agent_oauth_bindings','agent_runtime_sessions','agent_standing_grants','agent_command_receipts','project_work_items',
  'project_materials','project_material_versions','project_object_links','project_conversations','project_task_discussions','project_messages','project_files',
  'sketches','sketch_thoughts','github_bindings','github_task_links','github_deliveries','github_processing','agent_thread_guard_events','agent_thread_artifact_mutations'];
async function snapshot(){const result:Record<string,unknown[]>={};for(const table of tables)result[table]=(await pool.query(`SELECT row_to_json(r)::text AS value FROM ${table} r ORDER BY row_to_json(r)::text`)).rows;return result;}
type State={projectId:string;workspaceId:string;ownerId:string;cookies:[string,string][];tokens:ThreadNativeScene['tokens'];runtimeSessionId:string;grantId:string;
  taskIds:string[];mapId:string;thoughtId:string;thoughtVersion:number;fileId:string;bindingId:string;generation:string;
  firstCommand:ReturnType<typeof threadCommand>;firstResult:Awaited<ReturnType<typeof nativeThreadPost>>;original:Awaited<ReturnType<typeof snapshot>>;
  boundaries:{value:string}[];resets:{value:string}[];sequence:unknown[];ledger:number[];bytes:string};
class Provider implements GithubProvider{
  head='a'.repeat(40);
  constructor(readonly ownerId:string,readonly generation:string){}
  async repository(principal:Principal,installationId:string,repositoryId:string){
    if(principal.kind!=='human'||principal.id!==this.ownerId||installationId!=='555'||repositoryId!=='777')throw new NotFoundError('Repository');
    return{host:'github.com' as const,installationId,repositoryId,owner:'fixture',name:'private',private:true,url:'https://github.com/fixture/private',
      githubUserId:'999',appId:'12345',authorizationGeneration:this.generation};
  }
  async pull(principal:Principal,repository:{repositoryId:string},number:number):Promise<GithubPullFacts>{await this.repository(principal,'555',repository.repositoryId);
    return{repositoryId:'777',pullId:'777'+number,number,title:'Actual pinned source history',url:`https://github.com/fixture/private/pull/${number}`,
      author:{id:'765',login:'source-author'},headSha:this.head,state:'open',draft:false,merged:false,sourceCreatedAt:'2026-10-10T10:00:00Z',
      sourceUpdatedAt:'2026-10-11T04:00:00Z',sourceMergedAt:null,checks:[],reviews:[],truncated:false,execution:'ready_for_review'};}
}
async function publish(browser:Browser,projectId:string,taskId:string,bytes:Buffer){
  const response=await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=retained.txt`,browser.base),{
    method:'POST',headers:{'content-type':'application/octet-stream',cookie:browser.cookieHeader(),origin:browser.defaultOrigin},body:Buffer.from(bytes),
  });assert.equal(response.status,201);const file=await response.json() as{id:string};
  expect(await browser.request('POST',`/api/v1/work/${taskId}/discussion`,{body:{body:'Real canonical file publication',attachmentIds:[file.id],clientMessageId:randomUUID()}}),201);return file.id;
}
async function refresh(provider:Provider,bindingId:string){
  const commands=createGithubUseCases(db,provider),app=Fastify(),secret='fixture-upgrade-signed-provider-secret';
  await app.register(githubWebhookRoutes,{secret,appId:'12345',admit:commands.admit});await app.ready();
  try{const id=randomUUID(),body=JSON.stringify({action:'synchronize',installation:{id:555},repository:{id:777},pull_request:{id:77742,number:42,head:{sha:provider.head},base:{repo:{id:777}}}});
    const response=await app.inject({method:'POST',url:'/api/v1/integrations/github/webhook',payload:body,headers:{'content-type':'application/json','x-github-delivery':id,
      'x-github-event':'pull_request','x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(body).digest('hex')}});assert.equal(response.statusCode,202,response.body);
    assert.equal(await commands.process(id,bindingId),'completed');
  }finally{await app.close();}
}

test(phase==='prepare'?'actual pre-cutover native/canonical history exists before cutover':'actual restored history upgrades to the head ledger without pulses and current canonical effects remain guarded',async()=>{
  const manifest=await readMigrationManifest('packages/db/migrations',FLUX_SCHEMA_VERSION),ledger=await readAppliedMigrationVersions(pool);
  assertExactMigrationLedger(manifest,ledger);
  if(phase==='prepare'){
    assert.equal(FLUX_SCHEMA_VERSION,94,'the head image records main through 94 and the PR migrations');
    const f=await actionScene(pool),ownerId=(expect(await f.owner.request('GET','/api/v1/me'),200).user as{id:string}).id,grant=await f.grant('conversation.reply','execute',100);
    const items:WorkItem[]=[];for(const title of['Retained thought','Retained file','Retained PR'])items.push(expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/work`,{body:{title}}),201) as unknown as WorkItem);
    const firstCommand=threadCommand(f,items[0]!.id,grant.id),firstResult=await nativeThreadPost(f,firstCommand);
    for(let i=1;i<5;i++)await nativeThreadPost(f,threadCommand(f,items[0]!.id,grant.id));
    for(const item of items.slice(1))for(let i=0;i<5;i++)await nativeThreadPost(f,threadCommand(f,item.id,grant.id));
    const map=expect(await f.owner.request('POST',`/api/v1/workspaces/${f.workspaceId}/sketches`,{body:{title:'Actual88 source',scope:'project',projectId:f.projectId}}),201) as unknown as Sketch;
    let thought=(expect(await f.owner.request('POST',`/api/v1/sketches/${map.id}/thoughts`,{body:{text:'Before change',x:20,y:20}}),201) as unknown as CreatedThought).thought;
    expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/links`,{body:{from:{type:'work',id:items[0]!.id},to:{type:'thought',id:thought.id}}}),201);
    const nativeMapGrant=await f.grant('map.thought.update','execute',10,map.id);
    const changed=toolValue(await f.tool('flux_update_thought',{projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,grantId:nativeMapGrant.id,clientCommandId:randomUUID(),peerRequestClass:'execute',sources:[],
      mapId:map.id,thoughtId:thought.id,expectedVersion:thought.version,changes:{text:'Genuine native progress while88 producer is closed'}}));thought={...thought,version:Number(changed.version)};
    const bytes='Verified original bytes published under88',fileId=await publish(f.owner,f.projectId,items[1]!.id,Buffer.from(bytes));
    const provider=new Provider(ownerId,randomUUID()),commands=createGithubUseCases(db,provider),binding=await commands.bind({kind:'human',id:ownerId},f.projectId,{installationId:'555',repositoryId:'777'});
    await commands.link({kind:'human',id:ownerId},items[2]!.id,{bindingId:binding.id,number:42,role:'related'});provider.head='b'.repeat(40);await refresh(provider,binding.id);
    for(const item of items)assert.equal(await threadBudget(item.id),5,'88 canonical progress is historical, not an invented reset');
    // A real already-installed Doc producer supplies nonempty88 boundary/reset history.
    const retained=expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/work`,{body:{title:'Existing88 Doc reset'}}),201) as unknown as WorkItem;
    const document=expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/docs`,{body:{title:'Actual88 progress',
      body:`[Direct task](flux:work/${retained.id})\nA genuinely published observation.`,state:'published'}}),201);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM agent_thread_artifact_resets r JOIN agent_thread_artifact_boundaries b ON b.id=r.boundary_id
      WHERE r.task_id=$1 AND b.kind='doc' AND b.source_id=$2 AND r.sequence>0`,[retained.id,document.id])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM project_conversations WHERE work_id=$1',[retained.id])).rows[0].n,0,'the old canonical reset itself never creates a thread');
    items.push(retained);for(let i=0;i<5;i++)await nativeThreadPost(f,threadCommand(f,retained.id,grant.id));
    assert.equal(await threadBudget(retained.id),5,'real native posts refill the task after the existing88 reset');
    const state:State={projectId:f.projectId,workspaceId:f.workspaceId,ownerId,cookies:[...f.owner.cookies],tokens:f.tokens,runtimeSessionId:f.runtimeSessionId,grantId:grant.id,
      taskIds:items.map(t=>t.id),mapId:map.id,thoughtId:thought.id,thoughtVersion:thought.version,fileId,bindingId:binding.id,generation:provider.generation,
      firstCommand,firstResult,original:await snapshot(),boundaries:(await pool.query('SELECT row_to_json(r)::text AS value FROM agent_thread_artifact_boundaries r ORDER BY row_to_json(r)::text')).rows,
      resets:(await pool.query('SELECT row_to_json(r)::text AS value FROM agent_thread_artifact_resets r ORDER BY row_to_json(r)::text')).rows,
      sequence:(await pool.query('SELECT last_value,is_called FROM agent_thread_guard_sequence')).rows,ledger,bytes};
    await writeFile(`${directory}/actual-state.json`,JSON.stringify(state));
  }else{
    assert.equal(FLUX_SCHEMA_VERSION,94);const state=JSON.parse(await readFile(`${directory}/actual-state.json`,'utf8')) as State;
    assert.deepEqual([...ledger].sort((a,b)=>a-b),[...state.ledger,82,87,88,89].sort((a,b)=>a-b),'cutover adds exactly the PR migrations 0082, 0087, 0088 and 0089');
    assert.deepEqual(await snapshot(),state.original,'every actual retained domain/native/witness row is unchanged by restore/cutover');
    assert.deepEqual((await pool.query('SELECT last_value,is_called FROM agent_thread_guard_sequence')).rows,state.sequence,'upgrade never allocates a reset sequence');
    const boundaries=(await pool.query('SELECT row_to_json(r)::text AS value FROM agent_thread_artifact_boundaries r ORDER BY row_to_json(r)::text')).rows;
    for(const row of state.boundaries)assert.ok(boundaries.some(r=>JSON.stringify(r)===JSON.stringify(row)));
    const resets=(await pool.query('SELECT row_to_json(r)::text AS value FROM agent_thread_artifact_resets r ORDER BY row_to_json(r)::text')).rows;
    for(const row of state.resets)assert.ok(resets.some(r=>JSON.stringify(r)===JSON.stringify(row)),'every retained88 reset row remains identical');
    assert.ok(state.boundaries.length>0&&state.resets.length>0,'actual existing88 provenance must be nonempty');
    assert.equal((await pool.query('SELECT count(*)::int n FROM agent_thread_artifact_resets WHERE sequence IS NOT NULL')).rows[0].n,
      state.resets.filter(row=>JSON.parse(row.value).sequence!==null).length,'migration does not allocate or erase a reset');
    assert.equal((await pool.query('SELECT count(*)::int n FROM agent_thread_artifact_resets WHERE task_id=$1 AND content_identity IS NOT NULL',[state.taskIds[1]])).rows[0].n,1);
    const browser=new Browser();for(const[k,v]of state.cookies)browser.cookies.set(k,v);expect(await browser.request('GET','/api/v1/me'),200);
    const identity={tokens:state.tokens};assert.deepEqual(await nativeThreadPost(identity,state.firstCommand),{...state.firstResult,replayed:true});
    for(const id of state.taskIds){assert.equal(await threadBudget(id),5);await assert.rejects(nativeThreadPost(identity,threadCommand(state,id,state.grantId)),turnLimit);}
    const before=await snapshot(),client=await pool.connect();try{await client.query('BEGIN');await client.query(await readFile('packages/db/migrations/reverse/0089_agent_thread_remaining_artifacts.down.sql','utf8'));
      assert.deepEqual((await client.query('SELECT last_value,is_called FROM agent_thread_guard_sequence')).rows,state.sequence);await client.query('ROLLBACK');}finally{client.release();}
    assert.deepEqual(await snapshot(),before);
    expect(await browser.request('PATCH',`/api/v1/sketches/${state.mapId}/thoughts/${state.thoughtId}`,{body:{text:'New89 actual content'},headers:{'if-match':`"${state.thoughtVersion}"`}}),200);
    assert.equal(await threadBudget(state.taskIds[0]!),0);
    await publish(browser,state.projectId,state.taskIds[1]!,Buffer.from(state.bytes));assert.equal(await threadBudget(state.taskIds[1]!),5,'old consumed bytes do not replenish');
    const provider=new Provider(state.ownerId,state.generation);provider.head='c'.repeat(40);await refresh(provider,state.bindingId);assert.equal(await threadBudget(state.taskIds[2]!),0);
    assert.equal(await threadBudget(state.taskIds[3]!),5,'new remaining-kind progress does not replenish the unrelated retained Doc task');
    const check=await pool.connect();try{await check.query('BEGIN');await assert.rejects(check.query(await readFile('packages/db/migrations/reverse/0089_agent_thread_remaining_artifacts.down.sql','utf8')),/Cannot reverse 0089/);await check.query('ROLLBACK');}finally{check.release();}
  }
});
