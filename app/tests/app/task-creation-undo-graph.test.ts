import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { prepareReferencedTaskUse, referencedTaskIds, taskGraphRows, taskUseRows } from '@flux/db';
import type { WorkItem } from '@flux/contracts';
import { nativeWorkInTransaction } from '../../apps/server/src/work/adapters.js';
import { db, pool } from './support/db.js';
import { actionScene } from './support/mcp-actions.js';
import { expect, toolValue } from './support/mcp.js';
import { backendPid, barrier, settled, waitUntilBlockedBy } from './support/locks.js';
async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function fixture() {
  const f = await actionScene(pool); const grant = await f.grant('work.create', 'execute');
  const value = toolValue(await f.tool('flux_create_task', { projectId:f.projectId,runtimeSessionId:f.runtimeSessionId,
    grantId:grant.id,clientCommandId:randomUUID(),peerRequestClass:'execute',sources:[],task:{title:'Exact shared graph target'} }));
  const item = await f.read(String(value.workId)) as unknown as WorkItem;
  const result = expect(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/results`,
    {body:{title:'Initially unassociated result',finding:'positive'}}),201);
  const owner = String((await pool.query('SELECT owner_user_id FROM agents WHERE id=$1',[f.agentId])).rows[0].owner_user_id);
  const ref = {type:'result',id:String(result.id)};
  const link = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    const native = nativeWorkInTransaction(tx);
    await native.createLink({kind:'human',id:owner},f.projectId,{from:ref as {type:'result';id:string},to:{type:'work',id:item.id}});
    await native.flushEvents();
  };
  return {...f,item,ref,link};
}

test('actual native64-bit project graph owner blocks task-use preparation before its single task pass', {timeout:30_000}, async()=>{
  const f = await fixture(); const held = barrier<number>(); const release = barrier();
  let owner: Promise<unknown>|undefined; let use: Promise<unknown>|undefined;
  try {
    owner = db.transaction(async tx=>{await taskGraphRows(tx).lockTaskGraphs([f.projectId]);held.resolve(await backendPid(tx));await bounded(release.promise,'native graph release');});
    void owner.catch(()=>undefined); const pid = await bounded(held.promise,'native graph acquisition');
    use = db.transaction(async tx=>{const fence=await taskUseRows(tx).prepare([f.item.id]);assert.deepEqual(fence.ids,[f.item.id]);});
    void use.catch(()=>undefined); const done = settled(use);
    await waitUntilBlockedBy(pool,pid);assert.equal(done(),false);release.resolve();await bounded(Promise.all([owner,use]),'graph settlement');
    assert.equal((await f.read(f.item.id) as unknown as WorkItem).creationUndo?.eligible,true,'Graph/task observation does not mark use');
  } finally {release.resolve();await bounded(Promise.all([owner?.catch(()=>undefined),use?.catch(()=>undefined)]),'graph cleanup');}
});

test('native association commits first; initially empty canonical preparation waits on the same graph then retains the new complete task set', {timeout:30_000},async()=>{
  const f=await fixture();const held=barrier<number>();const release=barrier();let owner:Promise<unknown>|undefined;let reader:Promise<unknown>|undefined;
  try {
    owner=db.transaction(async tx=>{await f.link(tx);held.resolve(await backendPid(tx));await bounded(release.promise,'association COMMIT');});void owner.catch(()=>undefined);
    const pid=await bounded(held.promise,'native association');assert.deepEqual(await referencedTaskIds(db,[f.ref]),[],'Uncommitted association remains invisible');
    reader=db.transaction(async tx=>{const fence=await prepareReferencedTaskUse(tx,f.projectId,[f.ref]);assert.deepEqual(fence.ids,[f.item.id]);});void reader.catch(()=>undefined);
    const done=settled(reader);await waitUntilBlockedBy(pool,pid);assert.equal(done(),false);release.resolve();await bounded(Promise.all([owner,reader]),'complete association fence');
    assert.deepEqual(await referencedTaskIds(db,[f.ref]),[f.item.id]);assert.equal((await f.read(f.item.id) as unknown as WorkItem).creationUndo?.reason,'task_used');
  } finally {release.resolve();await bounded(Promise.all([owner?.catch(()=>undefined),reader?.catch(()=>undefined)]),'association-first cleanup');}
});

test('empty canonical preparation retains the native graph first; later actual association creation waits and only its persisted effect marks use', {timeout:30_000},async()=>{
  const f=await fixture();const held=barrier<number>();const release=barrier();let reader:Promise<unknown>|undefined;let writer:Promise<unknown>|undefined;
  try {
    reader=db.transaction(async tx=>{const fence=await prepareReferencedTaskUse(tx,f.projectId,[f.ref]);assert.deepEqual(fence.ids,[]);assert.deepEqual(fence.projectIds,[f.projectId]);held.resolve(await backendPid(tx));await bounded(release.promise,'empty graph release');});void reader.catch(()=>undefined);
    const pid=await bounded(held.promise,'empty canonical graph');writer=db.transaction(tx=>f.link(tx));void writer.catch(()=>undefined);
    const done=settled(writer);await waitUntilBlockedBy(pool,pid);assert.equal(done(),false);
    assert.equal((await f.read(f.item.id) as unknown as WorkItem).creationUndo?.eligible,true);release.resolve();await bounded(Promise.all([reader,writer]),'late association settlement');
    assert.deepEqual(await referencedTaskIds(db,[f.ref]),[f.item.id]);assert.equal((await f.read(f.item.id) as unknown as WorkItem).creationUndo?.reason,'task_used');
  } finally {release.resolve();await bounded(Promise.all([reader?.catch(()=>undefined),writer?.catch(()=>undefined)]),'empty-first cleanup');}
});
