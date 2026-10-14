import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket,{WebSocketServer} from 'ws';
import { wikiAuthority } from '../../apps/server/src/editing/authority.js';
import { wikiController } from '../../apps/server/src/editing/wiki-controller.js';
import { EditingOutputBudget } from '../../apps/server/src/editing/output.js';
import type { SessionContext } from '../../apps/server/src/identity/session.js';
import { pool } from './support/db.js';
import { expectStatus,person,project,workspace } from './support/people.js';
import type { Doc } from '@flux/contracts';

function deferred(){let resolve=()=>{};const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function until(predicate:()=>boolean){const deadline=Date.now()+3000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(predicate(),'The finite observable boundary was reached');}

test('actual SQL/public ws 100k preview reserves before SQL and keeps source through withheld COMMIT/close', {timeout:15000},async()=>{
  const owner=await person('wiki-output-owner');const ws=await workspace(owner,'Wiki output');const place=await project(owner,ws.id,'Large live text','restricted');
  const doc=expectStatus(await owner.browser.request('POST',`/api/v1/projects/${place.id}/docs`,{body:{title:'Escaped shared body',body:'<&😀'.repeat(25000)}}),201) as Doc;
  const row=(await pool.query('SELECT s.id,s.expires_at,u.name,u.email FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 1',[owner.id])).rows[0];
  const session:SessionContext={sessionId:row.id,expiresAt:row.expires_at,principal:{kind:'human',id:owner.id},user:{id:owner.id,name:row.name,email:row.email}};
  const budget=new EditingOutputBudget();const held=deferred();const commit=deferred();let holdNext=false;let connections=0;
  const authority=wikiAuthority({pool:{async connect(){connections++;const client=await pool.connect();const query=client.query.bind(client);
    client.query=function(...args:unknown[]){if(args[0]==='COMMIT'&&holdNext){holdNext=false;held.resolve();return commit.promise.then(()=>Reflect.apply(query,client,args));}return Reflect.apply(query,client,args);} as typeof client.query;
    return client;}}},undefined,{outputBudget:budget});
  const head=await authority.bootstrap(session,doc.id);connections=0;
  const controller=wikiController(authority,budget);const server=createServer();const sockets=new WebSocketServer({server,perMessageDeflate:false});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
  const connected=once(sockets,'connection');const peer=new WebSocket(`ws://127.0.0.1:${address.port}`);await once(peer,'open');const [socket]=await connected as [WebSocket];
  const send=socket.send;let binary=0;
  socket.send=function(...args:unknown[]){if(Buffer.isBuffer(args[0])){binary++;holdNext=true;}return Reflect.apply(send,socket,args);} as typeof socket.send;
  const frames:Buffer[]=[];peer.on('message',(bytes,isBinary)=>{if(isBinary){assert.ok(Buffer.isBuffer(bytes));frames.push(bytes);}});
  const occupying=budget.reserve(8*1024*1024);
  try {
    controller.accept(socket,{connectionId:randomUUID(),session,target:{kind:'wiki',id:doc.id}});
    peer.send(JSON.stringify({type:'subscribe',generation:head.generation,afterSequence:0}));
    await new Promise(resolve=>setTimeout(resolve,40));assert.equal(connections,0,'Shared output pressure queues BEFORE any SQL acquisition');assert.equal(binary,0);
    occupying();await held.promise;await until(()=>frames.length>=1);
    const metadataLength=frames[0]!.readUInt32BE(0);const header=JSON.parse(frames[0]!.subarray(4,4+metadataLength).toString('utf8'));
    assert.equal(header.type,'preview');assert.ok(header.count>1,'The100k boundary takes bounded binary frames');
    // Founder direction 2026-10-09 (A1): the read hands off every frame its window allows under its one fence.
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(frames.reduce((total,frame)=>total+frame.byteLength,0)<=1024*1024,'Frames in flight stay within the per-connection output window');
    assert.ok(frames.every(frame=>JSON.parse(frame.subarray(4,4+frame.readUInt32BE(0)).toString('utf8')).deliveryId===header.deliveryId));
    assert.ok(budget.bytes>=24*1024*1024,'Protected source remains charged while its real COMMIT is withheld');
    const closed=controller.close();await new Promise(resolve=>setTimeout(resolve,20));assert.ok(budget.bytes>=24*1024*1024,'Closing the transport does not free a still-retained SQL result');
    commit.resolve();await closed;await until(()=>budget.bytes===0);
  } finally {
    occupying();commit.resolve();await controller.close();socket.terminate();peer.terminate();
    await new Promise<void>(resolve=>sockets.close(()=>resolve()));await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
