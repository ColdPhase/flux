import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { sql, createDatabase, FLUX_SCHEMA_VERSION, readMigrationManifest, assertExactMigrationLedger, readAppliedMigrationVersions } from '@flux/db';
import type { Database } from '@flux/core';
import type { WorkItem } from '@flux/contracts';
import { internalAgentThreadWriter } from '../../apps/server/src/agent-connection/internal-agent-thread.js';
import { createAuth } from '../../apps/server/src/identity/auth.js';
import { loadIdentityConfig } from '../../apps/server/src/identity/config.js';
import { createOauthRequests } from '../../apps/server/src/identity/oauth-flow.js';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { actionScene, agentConnection, toolFailure } from './support/mcp-actions.js';
import { apiUrl, publicOrigin, register, uniqueEmail } from './support/http.js';
import { expect, toolValue } from './support/mcp.js';
import { db, pool } from './support/db.js';
import { backendPid, barrier, waitUntilBlockedBy } from './support/locks.js';
import { guardFixturePool } from './support/fixture-database.js';

const auth = createAuth({ db, config: loadIdentityConfig(), mailer: null, oauthRequests: createOauthRequests() });
type Scene = Awaited<ReturnType<typeof actionScene>>;
type Command = { projectId: string; taskId: string; runtimeSessionId: string; grantId: string; clientCommandId: string;
  peerRequestClass: 'execute' | 'plan'; sources: { materialId: string; version: number }[]; message: { body: string } };
const envelope = (f: Pick<Scene, 'projectId' | 'runtimeSessionId'>, taskId: string, grantId: string): Command => ({
  projectId: f.projectId, taskId, runtimeSessionId: f.runtimeSessionId, grantId, clientCommandId: randomUUID(),
  peerRequestClass: 'execute', sources: [], message: { body: 'One meaningful measured observation.' } });
async function post(f: Pick<Scene, 'tokens'>, command: Command | Record<string, unknown>, database: Database = db) {
  const request = new Request(`${publicOrigin}/mcp`, { method: 'POST', headers: {
    authorization: `Bearer ${f.tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify(command) });
  const response = await internalAgentThreadWriter(database, auth, publicOrigin, `${apiUrl}/api/auth/jwks`)(request);
  assert.equal(response.status, 200, `internal authenticated writer ${response.status}: ${await response.clone().text()}`);
  return await response.json() as { taskId: string; conversationId: string; messageId: string; sequence: number; replayed: boolean };
}
const fails = (code: string) => (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === code;
async function task(f: Scene, title = 'Measure current thread effects') {
  return expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title } }), 201) as unknown as WorkItem;
}
async function state(taskId: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM project_conversations WHERE work_id=$1) AS threads,
    (SELECT count(*)::int FROM project_messages m JOIN project_conversations c ON c.id=m.conversation_id WHERE c.work_id=$1) AS messages,
    (SELECT count(*)::int FROM agent_thread_guard_events WHERE task_id=$1) AS boundaries,
    COALESCE((SELECT turn_count FROM agent_thread_guard_events WHERE task_id=$1 ORDER BY sequence DESC LIMIT 1),0) AS turns,
    (SELECT first_persisted_use_at IS NOT NULL FROM project_work_items WHERE id=$1) AS used`, [taskId])).rows[0];
}

test('real OAuth native posts share one lazy thread and fifth slot across two owners/agents/connections', async () => {
  const f = await actionScene(pool), item = await task(f), grant = await f.grant('conversation.reply', 'execute', 20);
  const peer = await register(uniqueEmail('thread-peer'), 'correct horse battery staple');
  const me = expect(await peer.browser.request('GET', '/api/v1/me'), 200).user as { id: string; email: string };
  expect(await f.owner.request('POST', `/api/v1/workspaces/${f.workspaceId}/members`, { body: { email: me.email, role: 'admin' } }), 201);
  const agent = expect(await peer.browser.request('POST', `/api/v1/workspaces/${f.workspaceId}/agents`, { body: { name: 'Independent measurement', owner: 'self' } }), 201);
  expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const second = await agentConnection(pool, peer.browser, String(agent.id), [f.projectId]);
  const peerGrant = await second.grant('conversation.reply', 'execute', 20);
  const firstCommand = envelope(f, item.id, grant.id);
  const secondCommand = { ...envelope({ ...second, projectId: f.projectId }, item.id, peerGrant.id), clientCommandId: firstCommand.clientCommandId };
  const first = await Promise.all([post(f, firstCommand), post(second, secondCommand)]);
  assert.equal(first[0].conversationId, first[1].conversationId); assert.notEqual(first[0].messageId, first[1].messageId);
  await post(f, envelope(f, item.id, grant.id)); await post(second, envelope({ ...second, projectId: f.projectId }, item.id, peerGrant.id));
  const race = await Promise.allSettled([post(f, envelope(f, item.id, grant.id)), post(second, envelope({ ...second, projectId: f.projectId }, item.id, peerGrant.id))]);
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  const refused = race.find(r => r.status === 'rejected') as PromiseRejectedResult; assert.ok(fails('AGENT_THREAD_TURN_LIMIT')(refused.reason));
  assert.deepEqual(await state(item.id), { threads: 1, messages: 5, boundaries: 5, turns: 5, used: true });
  const authors = (await pool.query('SELECT DISTINCT author_agent_id,author_id FROM project_messages WHERE conversation_id=$1', [first[0].conversationId])).rows;
  assert.deepEqual(authors.map(r => r.author_agent_id).sort(), [f.agentId, agent.id].sort()); assert.ok(authors.every(r => r.author_id === null));
  assert.equal(await f.used(grant.id) + await f.used(peerGrant.id), 5);
  assert.equal((await pool.query("SELECT count(*)::int n FROM events WHERE kind='project.agent_thread_message_sent.v1' AND object_id=$1", [f.projectId])).rows[0].n, 5);
});

test('private task-target receipt stays stable, rejects changed/old-mode intent and a human replay cannot replenish turns', async () => {
  const f = await actionScene(pool), item = await task(f), grant = await f.grant('conversation.reply', 'execute', 20);
  const command = envelope(f, item.id, grant.id), first = await post(f, command);
  assert.deepEqual(await post(f, command), { ...first, replayed: true });
  await assert.rejects(post(f, { ...command, message: { body: 'Different effect' } }), fails('IDEMPOTENCY_CONFLICT'));
  assert.equal(toolFailure(await f.tool('flux_reply_in_conversation', { ...command, taskId: undefined,
    conversationId: first.conversationId })).code, 'IDEMPOTENCY_CONFLICT');
  const human = { body: 'A new human measurement boundary', clientMessageId: randomUUID() };
  expect(await f.owner.request('POST', `/api/v1/conversations/${first.conversationId}/messages`, { body: human }), 201);
  assert.equal((await state(item.id)).turns, 0);
  for (let i = 0; i < 5; i++) await post(f, envelope(f, item.id, grant.id));
  expect(await f.owner.request('POST', `/api/v1/conversations/${first.conversationId}/messages`, { body: human }), 201);
  assert.equal((await state(item.id)).turns, 5); await assert.rejects(post(f, envelope(f, item.id, grant.id)), fails('AGENT_THREAD_TURN_LIMIT'));
  const before = await state(item.id);
  await assert.rejects(pool.query('DELETE FROM project_messages WHERE id=$1', [first.messageId]), /immutable/);
  const owner = (expect(await f.owner.request('GET', '/api/v1/me'), 200).user as { id: string }).id;
  await assert.rejects(pool.query('UPDATE project_messages SET author_agent_id=NULL,author_id=$1 WHERE id=$2', [owner, first.messageId]), /immutable/);
  await assert.rejects(pool.query('UPDATE agent_thread_guard_events SET turn_count=0 WHERE message_id=$1', [first.messageId]), /immutable/);
  await pool.query('UPDATE project_messages SET body=$1 WHERE id=$2', ['Edited text cannot refund the native turn', first.messageId]);
  assert.deepEqual(await state(item.id), before);
  await assert.rejects(pool.query(`INSERT INTO agent_thread_guard_events(workspace_id,project_id,task_id,conversation_id,message_id,kind,turn_count,transaction_id)
    SELECT workspace_id,project_id,$1,conversation_id,id,'human_message',0,txid_current() FROM project_messages WHERE client_message_id=$2`, [item.id, human.clientMessageId]), /human reset/);
});

test('production generic writers and raw SQL remain closed; no client mode or new public tool is admitted', async () => {
  const f = await actionScene(pool), item = await task(f), grant = await f.grant('conversation.reply', 'execute', 20);
  const first = await post(f, envelope(f, item.id, grant.id));
  assert.ok(!(await f.toolNames()).includes('flux_post_agent_thread'));
  assert.equal(toolFailure(await f.tool('flux_reply_in_conversation', { ...envelope(f, item.id, grant.id), taskId: undefined,
    conversationId: first.conversationId })).code, 'AGENT_EXECUTION_UNAVAILABLE');
  await assert.rejects(pool.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_agent_id,client_message_id,request_fingerprint,sequence,body)
    VALUES($1,$2,$3,$4,$5,$6,'unguarded',99,'Bypass')`, [randomUUID(),f.workspaceId,f.projectId,first.conversationId,f.agentId,randomUUID()]),
    (e: unknown) => !!e && typeof e === 'object' && 'constraint' in e && e.constraint === 'agent_thread_agent_writes_closed');
  await assert.rejects(post(f, { ...envelope(f, item.id, grant.id), targetMode: 'task-agent-thread/v1' }));
  const people = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/conversations`, { body: { body: 'People still use v1', clientMessageId: randomUUID() } }), 201);
  assert.equal(toolValue(await f.tool('flux_reply_in_conversation', { ...envelope(f,item.id,grant.id), taskId: undefined,
    conversationId: people.id })).sequence, 2);
  assert.equal((await state(item.id)).turns, 1); assert.equal(await f.used(grant.id), 2);
});

test('real grants allow projectwide lazy and exact existing agents thread only; operation/class/project/task cannot widen', async () => {
  const f = await actionScene(pool), a = await task(f), b = await task(f);
  const broad = await f.grant('conversation.reply','execute',20), first = await post(f,envelope(f,a.id,broad.id));
  const exact = await f.grant('conversation.reply','plan',20,first.conversationId);
  await post(f,{ ...envelope(f,a.id,exact.id),peerRequestClass:'plan' });
  await assert.rejects(post(f,{ ...envelope(f,b.id,exact.id),peerRequestClass:'plan' }),fails('AGENT_EXECUTION_UNAVAILABLE'));
  const people = expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/conversations`,{ body:{body:'Only people',clientMessageId:randomUUID()} }),201);
  const peopleGrant = await f.grant('conversation.reply','execute',20,String(people.id));
  await assert.rejects(post(f,envelope(f,a.id,peopleGrant.id)),fails('AGENT_EXECUTION_UNAVAILABLE'));
  const wrongOperation = await f.grant('conversation.create','execute',20);
  await assert.rejects(post(f,envelope(f,b.id,wrongOperation.id)),fails('AGENT_EXECUTION_UNAVAILABLE'));
  await assert.rejects(post(f,{ ...envelope(f,b.id,broad.id),peerRequestClass:'review' }));
  await assert.rejects(post(f,envelope(f,randomUUID(),broad.id)),fails('OBJECT_NOT_FOUND'));
  const other = expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/work`,{body:{title:'Unrelated'}}),201);
  await assert.rejects(pool.query('UPDATE project_conversations SET work_id=$1 WHERE id=$2',[other.id,first.conversationId]),/immutable/);
  assert.equal((await state(b.id)).threads,0); assert.equal(await f.used(peopleGrant.id),0); assert.equal(await f.used(wrongOperation.id),0);
});

test('current real source/runtime/grant/access authority is enforced on new effects and receipt replay without a debit', async () => {
  const f = await actionScene(pool), item = await task(f), grant = await f.grant('conversation.reply','execute',20);
  const command = { ...envelope(f,item.id,grant.id),sources:[f.source] }, first = await post(f,command);
  expect(await f.owner.request('PATCH',`/api/v1/materials/${f.source.materialId}`,{body:{clientMutationId:randomUUID(),expectedVersion:1,body:'Changed actual material'}}),200);
  await assert.rejects(post(f,command),fails('SOURCE_VERSION_CONFLICT'));
  await assert.rejects(post(f,{...command,clientCommandId:randomUUID()}),fails('SOURCE_VERSION_CONFLICT'));
  const clean = envelope(f,item.id,grant.id); await pool.query("UPDATE agent_standing_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[grant.id]);
  await assert.rejects(post(f,clean),fails('AGENT_EXECUTION_UNAVAILABLE'));
  const live = await f.grant('conversation.reply','execute',20); const other = envelope(f,item.id,live.id);
  await pool.query("UPDATE agent_runtime_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.runtimeSessionId]);
  await assert.rejects(post(f,other),fails('AGENT_EXECUTION_UNAVAILABLE'));
  assert.deepEqual(await state(item.id),{threads:1,messages:1,boundaries:1,turns:1,used:true}); assert.equal(await f.used(live.id),0);
  const receipt = (await pool.query('SELECT value FROM agent_command_receipts WHERE connection_id=$1 AND client_command_id=$2',[f.connectionId,command.clientCommandId])).rows[0].value;
  assert.equal(receipt.messageId,first.messageId);
});

test('revoked project, owner, binding and connection block actual native effects/replay; invalid bearer creates nothing', async () => {
  for (const axis of ['project','owner','binding','connection','grant','expiredGrant','runtime'] as const) {
    const f = await actionScene(pool), item = await task(f), grant = await f.grant('conversation.reply','execute',20);
    const command=envelope(f,item.id,grant.id); await post(f,command);
    if(axis==='project') expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/grants`,{body:{principal:{kind:'agent',id:f.agentId},role:'denied'}}),201);
    if(axis==='owner') {
      const ownerId=(expect(await f.owner.request('GET','/api/v1/me'),200).user as {id:string}).id;
      expect(await f.owner.request('POST',`/api/v1/projects/${f.projectId}/grants`,{body:{principal:{kind:'human',id:ownerId},role:'denied'}}),201);
    }
    if(axis==='binding') await pool.query('UPDATE agent_oauth_bindings SET generation=generation+1 WHERE id=(SELECT binding_id FROM agent_runtime_sessions WHERE id=$1)',[f.runtimeSessionId]);
    if(axis==='connection') expect(await f.owner.request('DELETE',`/api/v1/agent-connections/${f.connectionId}`),204);
    if(axis==='grant') expect(await f.owner.request('DELETE',`/api/v1/agent-connections/${f.connectionId}/action-grants/${grant.id}`),204);
    if(axis==='expiredGrant') await pool.query("UPDATE agent_standing_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[grant.id]);
    if(axis==='runtime') await pool.query("UPDATE agent_runtime_sessions SET revoked_at=clock_timestamp() WHERE id=$1",[f.runtimeSessionId]);
    await assert.rejects(post(f,command)); await assert.rejects(post(f,{...command,clientCommandId:randomUUID()}));
    assert.equal((await state(item.id)).messages,1); assert.equal(await f.used(grant.id),1);
  }
  const f=await actionScene(pool), item=await task(f), grant=await f.grant('conversation.reply','execute',20);
  await assert.rejects(post({...f,tokens:{...f.tokens,access_token:'invalid'}},envelope(f,item.id,grant.id)));
  assert.deepEqual(await state(item.id),{threads:0,messages:0,boundaries:0,turns:0,used:false});
});

test('rollback removes the actual native message, counter, receipt, quota, quiet event and shared use together', async () => {
  const f=await actionScene(pool),item=await task(f),grant=await f.grant('conversation.reply','execute',20),command=envelope(f,item.id,grant.id);
  const sentinel=new Error('After native effect/receipt/events');
  await assert.rejects(db.transaction(async tx=>{
    await post(f,command,tx); await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    const saved=await tx.execute<{n:number}>(sql`SELECT count(*)::int n FROM agent_thread_guard_events WHERE task_id=${item.id}`);
    assert.equal(saved.rows[0]!.n,1); throw sentinel;
  }),sentinel);
  assert.deepEqual(await state(item.id),{threads:0,messages:0,boundaries:0,turns:0,used:false}); assert.equal(await f.used(grant.id),0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM agent_command_receipts WHERE connection_id=$1 AND client_command_id=$2',[f.connectionId,command.clientCommandId])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM events WHERE object_id=$1 AND kind='project.agent_thread_message_sent.v1'",[f.projectId])).rows[0].n,0);
});

test('SQL cannot commit a prepared debit/message without its real native receipt and cannot assign a chosen counter',async()=>{
  const f=await actionScene(pool),item=await task(f),grant=await f.grant('conversation.reply','execute',20);
  const human=expect(await f.owner.request('POST',`/api/v1/work/${item.id}/agent-thread`,{body:{body:'Human-only thread',clientMessageId:randomUUID()}}),201);
  const client=await pool.connect(),messageId=randomUUID();
  try{await client.query('BEGIN');await client.query(`INSERT INTO agent_thread_guard_events(workspace_id,project_id,task_id,conversation_id,message_id,kind,turn_count,author_agent_id,connection_id,client_command_id,runtime_session_id,grant_id,transaction_id)
    VALUES($1,$2,$3,$4,$5,'agent_message',0,$6,$7,$8,$9,$10,0)`,[f.workspaceId,f.projectId,item.id,human.conversationId,messageId,f.agentId,f.connectionId,randomUUID(),f.runtimeSessionId,grant.id]);
    assert.equal((await client.query('SELECT turn_count FROM agent_thread_guard_events WHERE message_id=$1',[messageId])).rows[0].turn_count,1);
    await client.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_agent_id,client_message_id,request_fingerprint,sequence,body)
      VALUES($1,$2,$3,$4,$5,$6,'missing-native-receipt',2,'Cannot commit this bypass')`,[messageId,f.workspaceId,f.projectId,human.conversationId,f.agentId,randomUUID()]);
    await assert.rejects(client.query('COMMIT'),/receipt|foreign key/);await client.query('ROLLBACK');
  }finally{client.release();}
  assert.equal((await state(item.id)).messages,1);assert.equal((await state(item.id)).turns,0);assert.equal((await state(item.id)).boundaries,0);assert.equal(await f.used(grant.id),0);
});

async function bounded<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native guard race exceeded10s')),10_000);})]);}finally{clearTimeout(timer);}}
async function unused(){const f=await actionScene(pool),create=await f.grant('work.create','execute');const value=toolValue(await f.tool('flux_create_task',{...envelope(f,randomUUID(),create.id),taskId:undefined,message:undefined,task:{title:'Unused guarded task'}}));const item=await f.read(String(value.workId)) as unknown as WorkItem;const ownerId=(expect(await f.owner.request('GET','/api/v1/me'),200).user as {id:string}).id;return{...f,item,ownerId};}

test('forced native-post winner fences actual HTTP Undo, while forced Undo winner refuses the authenticated native post', {timeout:60_000},async()=>{
  for(const winner of ['post','undo'] as const){
    const f=await unused(),grant=await f.grant('conversation.reply','execute',20),command=envelope(f,f.item.id,grant.id);
    const held=barrier<number>(),release=barrier();let other:Promise<unknown>|undefined;
    const first=db.transaction(async tx=>{
      if(winner==='post') await post(f,command,tx);
      else{const native=nativeWorkInTransaction(tx);await native.undoTaskCreation({kind:'human',id:f.ownerId},f.item.id,{clientCommandId:randomUUID(),expectedVersion:f.item.version});await native.flushEvents();}
      held.resolve(await backendPid(tx));await bounded(release.promise);
    });void first.catch(()=>undefined);
    try{const pid=await bounded(held.promise);other=winner==='post'?f.owner.request('POST',`/api/v1/work/${f.item.id}/creation-undo`,{body:{clientCommandId:randomUUID(),expectedVersion:f.item.version}}):post(f,command);void other.catch(()=>undefined);await waitUntilBlockedBy(pool,pid);release.resolve();await bounded(first);
      if(winner==='post'){const response=await bounded(other) as {status:number};assert.equal(response.status,409);assert.equal((await state(f.item.id)).turns,1);}
      else{await assert.rejects(bounded(other));assert.deepEqual(await state(f.item.id),{threads:0,messages:0,boundaries:0,turns:0,used:false});assert.equal(await f.used(grant.id),0);}
    }finally{release.resolve();await bounded(Promise.all([first.catch(()=>undefined),other?.catch(()=>undefined)]));}
  }
});

test('fresh/current82 migration preserves exact ledger/history and reverses only before guarded retained effects', {timeout:60_000},async()=>{
  const manifest=await readMigrationManifest('packages/db/migrations',FLUX_SCHEMA_VERSION),prior=manifest.filter(f=>f.version!==87);
  const name=`flux_thread_guard_${randomUUID().replaceAll('-','')}`,url=new URL(process.env.DATABASE_URL!);url.pathname=`/${name}`;
  const createFixture={text:`CREATE DATABASE "${name}"`,query_timeout:60_000};
  await pool.query(createFixture);const fixture=createDatabase(url.toString()).pool;
  const fixtureGuard=guardFixturePool(fixture);
  try{for(const file of prior){await fixture.query(await readFile(`packages/db/migrations/${file.name}`,'utf8'));await fixture.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING',[file.version]);}
    const [human,workspace,project,work,people,thread]=Array.from({length:6},()=>randomUUID());
    await fixture.query("INSERT INTO auth_users(id,name,email) VALUES($1,'Retained human',$2)",[human,`${human}@example.test`]);
    await fixture.query("INSERT INTO workspaces(id,name,created_by) VALUES($1,'Retained workspace',$2)",[workspace,human]);
    await fixture.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Retained project',$3)",[project,workspace,human]);
    await fixture.query("INSERT INTO project_work_items(id,workspace_id,project_id,title,outcome,status,created_by_kind,created_by_id) VALUES($1,$2,$3,'Retained task','Keep exact history','open','human',$4)",[work,workspace,project,human]);
    await fixture.query("INSERT INTO project_conversations(id,workspace_id,project_id,created_by,space,work_id) VALUES($1,$2,$3,$4,'people',NULL),($5,$2,$3,$4,'agents',$6)",[people,workspace,project,human,thread,work]);
    for(const conversation of [people,thread])await fixture.query("INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_id,client_message_id,request_fingerprint,sequence,body) VALUES($1,$2,$3,$4,$5,$6,'retained-history',1,'Retain this exact human text')",[randomUUID(),workspace,project,conversation,human,randomUUID()]);
    const history=()=>fixture.query('SELECT * FROM project_messages ORDER BY id');const oldHistory=(await history()).rows;
    const up=await readFile('packages/db/migrations/0087_agent_thread_turn_guard.sql','utf8'),down=await readFile('packages/db/migrations/reverse/0087_agent_thread_turn_guard.down.sql','utf8');
    const before=await readAppliedMigrationVersions(fixture);await fixture.query(up);await fixture.query('INSERT INTO flux_schema_version(version) VALUES(87)');assertExactMigrationLedger(manifest,await readAppliedMigrationVersions(fixture));
    assert.deepEqual((await history()).rows,oldHistory);await fixture.query(down);await fixture.query('DELETE FROM flux_schema_version WHERE version=87');assert.deepEqual(await readAppliedMigrationVersions(fixture),before);assert.deepEqual((await history()).rows,oldHistory);
    assert.equal((await fixture.query("SELECT to_regclass('agent_thread_guard_events') AS guard")).rows[0].guard,null);assert.equal((await fixture.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname='agent_thread_agent_writes_closed'")).rows[0].n,1);
    await fixture.query(up);await fixture.query('INSERT INTO flux_schema_version(version) VALUES(87)');assertExactMigrationLedger(manifest,await readAppliedMigrationVersions(fixture));assert.deepEqual((await history()).rows,oldHistory);
    const f=await actionScene(pool),item=await task(f),grant=await f.grant('conversation.reply','execute',20);await post(f,envelope(f,item.id,grant.id));
    const client=await pool.connect();try{await client.query('BEGIN');const ledger=await readAppliedMigrationVersions(client);await assert.rejects(client.query(down),/Cannot reverse 0087/);await client.query('ROLLBACK');assert.deepEqual(await readAppliedMigrationVersions(client),ledger);}finally{client.release();}
    assert.equal((await state(item.id)).messages,1);
  }finally{fixtureGuard.cleanup();await fixture.end();const dropFixture={text:`DROP DATABASE "${name}" WITH (FORCE)`,query_timeout:60_000};await pool.query(dropFixture);}
  fixtureGuard.assertNoEarlyErrors();
});
