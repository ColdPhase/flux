import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createDatabase, EditingTransactionError } from '@flux/db';
import type { Doc, LiveReceipt, WikiTextEnvelope } from '@flux/contracts';
import { wikiAuthority } from '../../apps/server/src/editing/authority.js';
import type { SessionContext } from '../../apps/server/src/identity/session.js';
import { connectionString, pool } from './support/db.js';
import { expectStatus, person, project, workspace } from './support/people.js';

/** Boundary interposition ONLY: PostgreSQL really completes awaited COMMIT before its response is lost.
 * Authentication, policy, codec, receipt/journal SQL and transaction orchestration are production code.
 * A fresh authority is a controller/codec reconstruction, not a claim that an API process restarted. */
test('real committed wiki intent with a lost COMMIT response reconciles its immutable receipt without another contribution', { timeout: 20_000 }, async () => {
  const owner=await person('Live commit response reconciliation');
  const ws=await workspace(owner,'Lost response receipt');const place=await project(owner,ws.id,'Exact original retry','restricted');
  const doc=expectStatus(await owner.browser.request('POST',`/api/v1/projects/${place.id}/docs`,{body:{title:'Lost COMMIT response',body:'Saved original. '}}),201) as Doc;
  const [session]=(await pool.query('SELECT id,expires_at FROM auth_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[owner.id])).rows;
  const [user]=(await pool.query('SELECT name,email FROM auth_users WHERE id=$1',[owner.id])).rows;
  const who:SessionContext={sessionId:session.id,expiresAt:session.expires_at,principal:{kind:'human',id:owner.id},user:{id:owner.id,...user}};
  const database=createDatabase(connectionString);const lost=new Error('fixture: response lost AFTER real PostgreSQL COMMIT');
  let armed=false,realLostCommits=0;const releases:boolean[]=[];
  const instrumented={async connect(){
    const client=await database.pool.connect();const query=client.query;const release=client.release;
    client.query=function(...args:unknown[]){
      if(armed&&args[0]==='COMMIT'){
        armed=false;
        return Promise.resolve(Reflect.apply(query,client,args)).then(()=>{realLostCommits++;throw lost;});
      }
      return Reflect.apply(query,client,args);
    } as typeof client.query;
    client.release=function(discard?:Error|boolean){
      releases.push(Boolean(discard));client.query=query;client.release=release;Reflect.apply(release,client,[discard]);
    };
    return client;
  }};
  const authority=wikiAuthority({pool:instrumented});let reconstructed:ReturnType<typeof wikiAuthority>|null=null;const local=new Y.Doc();
  try {
    const head=await authority.bootstrap(who,doc.id);
    await authority.enroll(who,doc.id,{generation:head.generation,replicaId:local.clientID});
    Y.applyUpdate(local,Buffer.from(head.checkpoint,'base64'));local.getText('body').insert(head.body.length,'Durable before missing response 🚀. ');
    const bytes=Y.encodeStateAsUpdate(local);const sealed=Buffer.from(bytes).toString('base64');
    const envelope:WikiTextEnvelope={workspace:head.workspaceId,kind:'wiki',room:doc.id,generation:head.generation,actor:owner.id,operation:'text',uuid:randomUUID(),replica:local.clientID,parameters:null};
    const events=Number((await pool.query('SELECT count(*)::int n FROM events WHERE workspace_id=$1',[ws.id])).rows[0].n);
    armed=true;let returned=false;
    await assert.rejects(authority.submit(who,doc.id,envelope,bytes,authority.reserve(bytes)).then(()=>{returned=true;}),error=>error instanceof EditingTransactionError&&error.outcome==='unknown'&&error.cause===lost);
    assert.equal(returned,false,'Lost COMMIT response cannot manufacture an ACK');assert.equal(realLostCommits,1);assert.equal(releases.at(-1),true,'The ambiguous response discards that pooled backend');
    const persisted=(await pool.query('SELECT receipt FROM live_editing_intents WHERE actor_id=$1 AND command_id=$2',[owner.id,envelope.uuid])).rows[0]?.receipt as LiveReceipt|undefined;
    assert.ok(persisted);assert.equal(persisted.sequence,1);assert.equal(persisted.changed,true);
    const durable=(await pool.query('SELECT sequence,body,hash FROM doc_live_heads WHERE doc_id=$1',[doc.id])).rows[0];
    assert.equal(Number(durable.sequence),1);assert.equal(durable.body,local.getText('body').toString());assert.equal(durable.hash,persisted.hash);
    assert.equal((expectStatus(await owner.browser.request('GET',`/api/v1/docs/${doc.id}`),200) as Doc).body,doc.body,'Confirmed live characters do not rewrite saved material');
    await authority.close();reconstructed=wikiAuthority({pool:database.pool});
    assert.deepEqual(await reconstructed.receipt(who,doc.id,envelope.uuid),persisted,'Reconciliation reads the durable original receipt under current authority');
    assert.equal(Buffer.from(bytes).toString('base64'),sealed,'Original retry bytes stay immutable');
    assert.deepEqual(await reconstructed.submit(who,doc.id,envelope,bytes,reconstructed.reserve(bytes)),persisted);
    const replay=Buffer.from(sealed,'base64');assert.deepEqual(await reconstructed.submit(who,doc.id,envelope,replay,reconstructed.reserve(replay)),persisted);
    assert.equal(Number((await pool.query('SELECT count(*)::int n FROM doc_live_updates WHERE doc_id=$1',[doc.id])).rows[0].n),1,'Two exact retries create no second journal contribution');
    assert.equal(Number((await pool.query('SELECT count(*)::int n FROM live_editing_intents WHERE actor_id=$1 AND command_id=$2',[owner.id,envelope.uuid])).rows[0].n),1);
    assert.equal(Number((await pool.query('SELECT count(*)::int n FROM events WHERE workspace_id=$1',[ws.id])).rows[0].n),events,'Character/reconciliation work produces no project notifications or AI trigger events');
    local.getText('body').insert(local.getText('body').length,'Changed sealed intent');const different=Y.encodeStateAsUpdate(local);
    await assert.rejects(reconstructed.submit(who,doc.id,envelope,different,reconstructed.reserve(different)),error=>error instanceof Error&&'code' in error&&error.code==='EDITING_IDEMPOTENCY_CONFLICT');
    const afterRefusal=await reconstructed.bootstrap(who,doc.id);
    assert.equal(afterRefusal.sequence,Number(durable.sequence));assert.equal(afterRefusal.body,durable.body);assert.equal(afterRefusal.hash,durable.hash,'Changed UUID payload cannot poison the acknowledged confirmed head');
    assert.deepEqual(await reconstructed.receipt(who,doc.id,envelope.uuid),persisted);
    await pool.query('DELETE FROM auth_sessions WHERE id=$1',[who.sessionId]);
    await assert.rejects(reconstructed.receipt(who,doc.id,envelope.uuid),error=>error instanceof Error&&'code' in error&&error.code==='UNAUTHENTICATED');
  } finally {local.destroy();await authority.close();await reconstructed?.close();await database.pool.end();}
});
