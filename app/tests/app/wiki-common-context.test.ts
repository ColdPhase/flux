import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { wikiAuthority } from '../../apps/server/src/editing/authority.js';
import { EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import type { SessionContext } from '../../apps/server/src/identity/session.js';

test('every wiki authority continuation uses common context BEFORE SQL and submit refusal releases the passed raw-input lease',async()=>{
  const budget=new EditingOutputBudget();let sql=0;const failure=new Error('Controlled SQL acquisition');
  const authority=wikiAuthority({pool:{async connect(){sql++;throw failure;}}},undefined,{outputBudget:budget});
  const docId=randomUUID();const generation=randomUUID();const session:SessionContext={sessionId:randomUUID(),expiresAt:new Date(Date.now()+60000),principal:{kind:'human',id:randomUUID()},user:{id:randomUUID(),name:'Current fixture actor',email:'fixture@example.test'}};
  const occupy=budget.reserve(32*1024*1024);
  const capacity=(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='EDITING_OUTPUT_CAPACITY';
  try {
    const operations=[()=>authority.bootstrap(session,docId),()=>authority.enroll(session,docId,{generation,replicaId:1}),
      ()=>authority.cursor(session,docId,generation,randomUUID(),null),()=>authority.receipt(session,docId,randomUUID()),
      ()=>authority.save(session,docId,{clientCommandId:randomUUID(),expectedVersion:1,generation,headSequence:0,headHash:'a'.repeat(64)}),
      ()=>authority.handoff(session,docId,()=>assert.fail('No protected handoff under full common capacity')),
      ()=>authority.deliver(session,docId,generation,0,()=>assert.fail('No protected delivery under full common capacity')),
      ()=>authority.deliverReceipt(session,docId,randomUUID(),()=>assert.fail('No receipt handoff under full common capacity'))];
    for(const operation of operations)await assert.rejects(operation(),capacity);
    assert.equal(sql,0);assert.equal(authority.runtime.externalInputBytes,0);assert.equal(authority.runtime.admissionQueued,0);
    const bytes=new Uint8Array(16);const admission=authority.reserve(bytes);assert.ok(authority.runtime.externalInputBytes>0);
    await assert.rejects(authority.submit(session,docId,{workspace:randomUUID(),kind:'wiki',room:docId,generation,actor:session.principal.id,operation:'text',uuid:randomUUID(),replica:1,parameters:null},bytes,admission),capacity);
    assert.equal(authority.runtime.externalInputBytes,0);assert.equal(authority.runtime.codecLeases,0);assert.equal(sql,0);
    occupy();
    // Enough for old metadata alone, insufficient for the new complete preparation
    // base: refusal must still precede SQL and release the passed codec lease.
    const almostFull=budget.reserve(31*1024*1024);
    try {
      const candidate=new Uint8Array(16);const lease=authority.reserve(candidate);
      await assert.rejects(authority.submit(session,docId,{workspace:randomUUID(),kind:'wiki',room:docId,generation,actor:session.principal.id,operation:'text',uuid:randomUUID(),replica:1,parameters:null},candidate,lease),capacity);
      assert.equal(sql,0);assert.equal(authority.runtime.externalInputBytes,0);assert.equal(budget.bytes,31*1024*1024);
    } finally {almostFull();}
    await assert.rejects(authority.receipt(session,docId,randomUUID()),error=>error===failure);
    assert.equal(sql,1);assert.equal(budget.bytes,0,'Common metadata survives its SQL continuation then releases on failure');
    assert.equal(authority.runtime.externalInputBytes,0);
  } finally {occupy();await authority.close();assert.equal(budget.bytes,0);}
});
