import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { Doc } from '@flux/contracts';
import { docRows, sql } from '@flux/db';
import { prepareDocWrite } from '../../apps/server/src/docs/preparation.js';
import { docUseCases } from '../../apps/server/src/docs/adapters.js';
import { EditingHTTPAdmission, editingHTTPQueued } from '../../apps/server/src/editing/http-admission.js';
import { apiEditingOutputBudget, EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import { docRoutes } from '../../apps/server/src/docs/routes.js';
import { UnauthenticatedError, type SessionContext, type SessionResolver } from '../../apps/server/src/identity/session.js';
import { backendPid, barrier, waitUntilBlockedBy } from './support/locks.js';
import { db, pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';

// This isolates actual document persistence and canonical read admission. Bulk SQL
// rows establish high fan-out data; they are not production writer-coverage proof.
test('native snapshot Save counts full canonical fan-out before UUID loading; capacity refusal leaves every document row/version/latch unchanged', {timeout:60_000},async()=>{
  const f=await actionScene(pool);const owner=String((await pool.query('SELECT owner_user_id FROM agents WHERE id=$1',[f.agentId])).rows[0].owner_user_id);
  const result=expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/results`,{body:{title:'Large canonical association fixture',finding:'positive'}}),201);
  await pool.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id)
    SELECT gen_random_uuid(),$1::uuid,$2::uuid,'Historical fan-out '||n,'human',$3::text FROM generate_series(1,10000) n`,[f.workspaceId,f.projectId,owner]);
  // Retain the complete10k fixture while every setup query keeps the real2s
  // deadline. A single10k link INSERT can exceed it through actual link triggers.
  for (let offset=0;offset<10000;offset+=100) await pool.query(`INSERT INTO project_object_links(id,workspace_id,project_id,role,from_type,from_id,to_type,to_id,created_by_kind,created_by_id)
    SELECT gen_random_uuid(),$1::uuid,$2::uuid,'about','result',$3::uuid,'work',id,'human',$4::text FROM project_work_items WHERE project_id=$2 AND title LIKE 'Historical fan-out %'
    ORDER BY id LIMIT 100 OFFSET $5`,[f.workspaceId,f.projectId,result.id,owner,offset]);
  const doc=expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/docs`,{body:{title:'Counted Save owner',body:'Saved.'}}),201) as unknown as Doc;
  const body=`Shared [result](flux:result/${result.id})`;const generation=randomUUID();const hash=createHash('sha256').update(body).digest('hex');
  await pool.query(`INSERT INTO doc_live_heads(doc_id,workspace_id,project_id,generation,sequence,body,hash,saved_version,saved_sequence,codec_state)
    VALUES($1,$2,$3,$4,1,$5,$6,1,0,NULL)`,[doc.id,f.workspaceId,f.projectId,generation,body,hash]);
  const state=async()=>({material:(await pool.query('SELECT * FROM project_materials WHERE id=$1',[doc.id])).rows,
    versions:(await pool.query('SELECT * FROM project_material_versions WHERE material_id=$1 ORDER BY version',[doc.id])).rows,
    head:(await pool.query('SELECT * FROM doc_live_heads WHERE doc_id=$1',[doc.id])).rows,
    links:(await pool.query("SELECT * FROM project_object_links WHERE from_type='doc' AND from_id=$1 ORDER BY id",[doc.id])).rows,
    used:(await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1 AND first_persisted_use_at IS NOT NULL',[f.projectId])).rows});
  const before=await state();const budget=new EditingOutputBudget();const admission=new EditingHTTPAdmission(budget);const preparation=await prepareDocWrite({docId:doc.id},budget,admission);
  let counted=false;let loaded=false;
  try {
    // Actual SQL executes COUNT; its allocation reservation fails before the
    // corresponding expanded UUID SELECT can be submitted to PostgreSQL.
    await assert.rejects(db.transaction(async tx=>{
      const controlled=new Proxy(tx,{get(target,property){if(property==='execute')return async(query:Parameters<typeof tx.execute>[0])=>{
        const compiled=new PgDialect().sqlToQuery(typeof query === 'string' ? sql.raw(query) : query.getSQL());if(compiled.sql.includes('canonical_tasks')){if(compiled.sql.includes('count(*)'))counted=true;else loaded=true;}
        return target.execute(query);
      };const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
      const ports=docRows(controlled,preparation.memory);
      await ports.prepareTaskUse({workspaceId:f.workspaceId,projectId:f.projectId},doc.id,[{type:'result',id:String(result.id)}]);
    }),error=>error instanceof Error&&'code' in error&&error.code==='EDITING_OUTPUT_CAPACITY');
    assert.equal(counted,true);assert.equal(loaded,false);
    await assert.rejects(docUseCases(db,preparation.memory).saveLiveVersion({kind:'human',id:owner},doc.id,{generation,headSequence:1,headHash:hash},1),error=>error instanceof Error&&'code' in error&&error.code==='EDITING_OUTPUT_CAPACITY');
    assert.deepEqual(await state(),before);
  } finally {preparation.release();admission.close();assert.equal(budget.bytes,0);}
});

test('one borrowed24MiB preparation owns simultaneous parser overlap, failure, queue wakeup and close inside unchanged32MiB', {timeout:5000},async()=>{
  const budget=new EditingOutputBudget();const admission=new EditingHTTPAdmission(budget,1000,'wiki');const before=editingHTTPQueued().wiki;
  const owner=await admission.admitOwned(1024);owner.reserve(2*1024*1024);
  assert.equal(budget.bytes,24*1024*1024+1024,'Retained base borrows the already admitted lease');
  const parser=owner.temporary(24*1024*1024);assert.equal(budget.bytes,26*1024*1024+1024,'Parser and retained context are simultaneous');
  assert.throws(()=>owner.reserve(7*1024*1024),{code:'EDITING_OUTPUT_CAPACITY'});assert.equal(budget.bytes,26*1024*1024+1024);
  parser();assert.equal(budget.bytes,24*1024*1024+1024);
  const waiting=admission.admitOwned(1024);void waiting.catch(()=>undefined);assert.equal(editingHTTPQueued().wiki,before+1);
  owner.release();const next=await waiting;assert.equal(editingHTTPQueued().wiki,before);next.release();assert.equal(budget.bytes,0);
  const held=await admission.admitOwned(0);const closing=admission.admitOwned(1024);void closing.catch(()=>undefined);
  admission.close();await assert.rejects(closing,{code:'EDITING_OUTPUT_CLOSED'});assert.equal(editingHTTPQueued().wiki,before);held.release();assert.equal(budget.bytes,0);
});

test('actual REST and standing-grant native document writers retain legal100k bodies under the shared preparation', {timeout:60_000},async()=>{
  const f=await actionScene(pool);const body='a'.repeat(100000);
  const human=expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/docs`,{headers:{'idempotency-key':randomUUID()},body:{title:'Maximum human body',body}}),201) as unknown as Doc;
  assert.equal(human.body,body);const grant=await f.grant('doc.create','execute');
  const value=toolValue(await f.tool('flux_create_doc',{projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,grantId:grant.id,
    clientCommandId:randomUUID(),peerRequestClass:'execute',sources:[],doc:{title:'Maximum native body',body}}));
  const native=expect(await f.owner.request('GET',`/api/v1/docs/${value.docId}`),200) as unknown as Doc;
  assert.equal(native.body,body);assert.equal(native.author.id,f.agentId);assert.equal(await f.used(grant.id),1);
});

async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
test('actual idempotent REST doc writer keeps preparation past its savepoint until outer COMMIT and response; waiting Undo refuses after use', {timeout:30_000},async()=>{
  const f=await actionScene(pool);const grant=await f.grant('work.create','execute');
  const created=toolValue(await f.tool('flux_create_task',{projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,grantId:grant.id,
    clientCommandId:randomUUID(),peerRequestClass:'execute',sources:[],task:{title:'Outer doc use target'}}));
  const workId=String(created.workId);const owner=String((await pool.query('SELECT owner_user_id FROM agents WHERE id=$1',[f.agentId])).rows[0].owner_user_id);
  const held=barrier<number>();const release=barrier();const title='Owned outer idempotent document';
  const controlled=new Proxy(db,{get(target,property){
    if(property==='transaction')return(action:Parameters<typeof db.transaction>[0])=>target.transaction(async tx=>{
      const result=await action(tx);
      if(result&&typeof result==='object'&&'body' in result&&(result.body as Doc)?.title===title){held.resolve(await backendPid(tx));await bounded(release.promise,'outer doc COMMIT release');}
      return result;
    });
    const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
  // Only session resolution is interposed; the cookie belongs to a real currently
  // authenticated human. Production doc routes/cache/policy/SQL remain unchanged.
  const resolve:SessionResolver['resolveSession']=async headers=>{
    if(headers.cookie!==f.owner.cookieHeader())return null;
    const [row]=(await pool.query(`SELECT s.id,s.expires_at,u.id AS user_id,u.name,u.email FROM auth_sessions s
      JOIN auth_users u ON u.id=s.user_id WHERE s.user_id=$1 AND s.expires_at>clock_timestamp() ORDER BY s.created_at DESC LIMIT 1`,[owner])).rows;
    return row?{sessionId:row.id,expiresAt:row.expires_at,principal:{kind:'human',id:row.user_id},user:{id:row.user_id,name:row.name,email:row.email}} as SessionContext:null;
  };
  const sessions:SessionResolver={resolveSession:resolve,async requirePrincipal(request){const session=await resolve(request.headers);if(!session)throw new UnauthenticatedError();return session;}};
  const app=Fastify();await app.register(async child=>docRoutes(child,{db:controlled,sessions}));await Promise.resolve(app.ready());
  let response:Promise<unknown>|undefined;let undo:ReturnType<typeof f.owner.request>|undefined;
  try {
    response=Promise.resolve(app.inject({method:'POST',url:`/api/v1/projects/${f.projectId}/docs`,
      headers:{cookie:f.owner.cookieHeader(),'idempotency-key':randomUUID()},payload:{title,body:`Actual [trial](flux:work/${workId})`}}));void response.catch(()=>undefined);
    const pid=await bounded(held.promise,'inner doc savepoint completion');
    assert.ok(apiEditingOutputBudget.bytes>=24*1024*1024,'Actual outer transaction still owns the complete preparation');
    assert.equal((await pool.query('SELECT first_persisted_use_at FROM project_work_items WHERE id=$1',[workId])).rows[0].first_persisted_use_at,null,'Use is not visible before actual outer COMMIT');
    undo=f.owner.request('POST',`/api/v1/work/${workId}/creation-undo`,{body:{clientCommandId:randomUUID(),expectedVersion:1}});void undo.catch(()=>undefined);
    await waitUntilBlockedBy(pool,pid);release.resolve();
    const delivered=await bounded(response,'doc response') as {statusCode:number;json():Doc};assert.equal(delivered.statusCode,201);assert.equal(delivered.json().title,title);
    assert.equal((await bounded(undo,'waiting Undo')).status,409);assert.equal(apiEditingOutputBudget.bytes,0);
  } finally {release.resolve();try{await bounded(Promise.all([response?.catch(()=>undefined),undo?.catch(()=>undefined)]),'outer doc cleanup');}finally{await app.close();assert.equal(apiEditingOutputBudget.bytes,0);}}
});
