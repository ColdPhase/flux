import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { and,eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import { requestHash } from '@flux/core';
import type { LiveMapBootstrap,LiveMapDelta,Sketch,Thought } from '@flux/contracts';
import { mapBackend } from '../../apps/server/src/editing/map-backend.js';
import { mapAuthority } from '../../apps/server/src/editing/map-authority.js';
import { sketchUseCases } from '../../apps/server/src/sketches/adapters.js';
import { sketchRoutes } from '../../apps/server/src/sketches/routes.js';
import { editingRoutes } from '../../apps/server/src/editing/routes.js';
import { apiEditingOutputBudget } from '../../apps/server/src/editing/output.js';
import type { SessionContext,SessionResolver } from '../../apps/server/src/identity/session.js';
import { db,pool } from './support/db.js';
import { addMember,expectStatus,grant,person,project,workspace } from './support/people.js';
const refused=(code:string)=>(error:unknown)=>error instanceof Error&&'code' in error&&error.code===code;
async function context(user:Awaited<ReturnType<typeof person>>):Promise<SessionContext> {
  const row=(await pool.query('SELECT s.id,s.expires_at,u.name,u.email FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 1',[user.id])).rows[0];
  return{sessionId:row.id,expiresAt:row.expires_at,principal:{kind:'human',id:user.id},user:{id:user.id,name:row.name,email:row.email}};
}
async function scene(count=2) {
  const owner=await person('map-live-owner');const peer=await person('map-live-peer');const viewer=await person('map-live-reader');
  const ws=await workspace(owner,'Native live map');await addMember(owner,ws.id,peer,'member');await addMember(owner,ws.id,viewer,'member');
  const place=await project(owner,ws.id,'Native map room','restricted');await grant(owner,place.id,peer,'contributor');await grant(owner,place.id,viewer,'viewer');
  const sketch=expectStatus(await owner.browser.request('POST',`/api/v1/workspaces/${ws.id}/sketches`,{body:{scope:'project',projectId:place.id,title:'Shared positions'}}),201) as Sketch;
  const ids=Array.from({length:count},()=>randomUUID());if(ids.length)await db.insert(schema.sketchThoughts).values(ids.map((id,index)=>({id,workspaceId:ws.id,sketchId:sketch.id,text:`Seed ${index}`,x:index,y:index,createdByUserId:owner.id})));
  return{owner,peer,viewer,ws,place,sketch,ids,ownerSession:await context(owner),peerSession:await context(peer),viewerSession:await context(viewer)};
}
const who=(session:SessionContext)=>({sessionId:session.sessionId,actorId:session.principal.id});
async function bootstrap(backend:ReturnType<typeof mapBackend>,session:SessionContext,id:string) {const heads:LiveMapBootstrap[]=[];await backend.bootstrap(who(session),id,head=>heads.push(head));assert.equal(heads.length,1);return heads[0]!;}
function native(session:SessionContext,sketchId:string,commandId:string,parameters:unknown,operation='fixture-native') {
  return sketchUseCases(db,{principal:session.principal,sessionId:session.sessionId,resourceId:sketchId,context:{session,sketchId,commandId,parameters,operation},commandId,operation,fingerprint:requestHash(parameters)});
}
async function delta(backend:ReturnType<typeof mapBackend>,session:SessionContext,head:LiveMapBootstrap,after:number) {
  const deltas:LiveMapDelta[]=[];await backend.deliver(who(session),head.resourceId,head.generation,after,result=>{if(result.delta)deltas.push(result.delta);});return deltas[0]??null;
}

test('atomic500-thought bootstrap/200-position live preview is visible before native drop and binds one real connection', {timeout:15000},async()=>{
  const f=await scene(500);const backend=mapBackend({pool});const authority=mapAuthority(backend,apiEditingOutputBudget);
  try {
    const head=await bootstrap(backend,f.ownerSession,f.sketch.id);assert.equal(head.sketch.thoughts.length,500);assert.equal(head.sequence,0);
    const selected=f.ids.slice(0,200);const lease=await authority.acquire(f.ownerSession,f.sketch.id,{gestureId:randomUUID(),thoughts:selected.map(id=>({id,expectedVersion:1}))});
    const connection=randomUUID();const positions=selected.map((id,index)=>({id,x:index+100,y:index+200,width:184,height:72}));
    const command={generation:head.generation,gestureId:lease.gestureId,leaseId:lease.leaseId,sequence:1,positions};
    const before=(await pool.query('SELECT count(*)::int n FROM events WHERE object_id=$1',[f.sketch.id])).rows[0].n;
    await authority.move(f.ownerSession,f.sketch.id,connection,command,Buffer.byteLength(JSON.stringify(command)));
    const previews:unknown[]=[];await backend.deliver(who(f.peerSession),f.sketch.id,head.generation,0,result=>previews.push(...result.transient));
    assert.equal(previews.length,1);assert.deepEqual((previews[0] as {positions:unknown}).positions,positions);
    assert.equal((await bootstrap(backend,f.peerSession,f.sketch.id)).sequence,0,'Preview cannot pretend to be durable');
    assert.equal((await pool.query('SELECT count(*)::int n FROM events WHERE object_id=$1',[f.sketch.id])).rows[0].n,before,'Preview cannot trigger unread/AI/project events');
    await authority.move(f.ownerSession,f.sketch.id,connection,command);await authority.move(f.ownerSession,f.sketch.id,connection,{...command,sequence:0});
    await assert.rejects(authority.move(f.ownerSession,f.sketch.id,randomUUID(),{...command,sequence:2}),refused('EDITING_LEASE_CHANGED'));
    await assert.rejects(authority.move(f.ownerSession,f.sketch.id,connection,{...command,positions:positions.map(p=>({...p,x:p.x+1}))}),refused('EDITING_PREVIEW_SEQUENCE_CONFLICT'));
    await assert.rejects(authority.acquire(f.peerSession,f.sketch.id,{gestureId:randomUUID(),thoughts:[{id:selected[0]!,expectedVersion:1}]}),refused('EDITING_GESTURE_CONFLICT'));
    const commandId=randomUUID();const drop={leaseId:lease.leaseId,moves:positions.map(p=>({id:p.id,x:p.x,y:p.y,expectedVersion:1}))};
    await native(f.ownerSession,f.sketch.id,commandId,drop).moveThoughts(f.ownerSession.principal,f.sketch.id,drop);
    const committed=await delta(backend,f.peerSession,head,0);assert.equal(committed?.commandId,commandId);assert.equal(committed?.thoughts.length,200);assert.deepEqual(committed?.clearedLeaseIds,[lease.leaseId]);
    assert.ok(committed?.thoughts.every(t=>t.version===2));assert.equal((await bootstrap(backend,f.peerSession,f.sketch.id)).sequence,1);
    await assert.rejects(authority.move(f.ownerSession,f.sketch.id,connection,{...command,sequence:2}),refused('EDITING_LEASE_CHANGED'));
  } finally {await authority.close();assert.equal(apiEditingOutputBudget.bytes,0);}
});

test('server-journal grouped undo is atomic, immutable on exact retry, and refuses a peer conflict without rebasing', {timeout:15000},async()=>{
  const f=await scene();const backend=mapBackend({pool});const authority=mapAuthority(backend,apiEditingOutputBudget);
  try {
    const head=await bootstrap(backend,f.ownerSession,f.sketch.id);const first=randomUUID();const second=randomUUID();
    const update={expectedVersion:1,text:'Own edit'};await native(f.ownerSession,f.sketch.id,first,update).updateThought(f.ownerSession.principal,f.sketch.id,f.ids[0]!,update);
    const move={moves:[{id:f.ids[0]!,expectedVersion:2,x:900,y:800}]};await native(f.ownerSession,f.sketch.id,second,move).moveThoughts(f.ownerSession.principal,f.sketch.id,move);
    const undo={clientCommandId:randomUUID(),originalCommandIds:[first,second]};assert.equal(await authority.undo(f.ownerSession,f.sketch.id,undo),undo.clientCommandId);
    const restored=(await bootstrap(backend,f.ownerSession,f.sketch.id)).sketch.thoughts.find(t=>t.id===f.ids[0])!;assert.equal(restored.text,'Seed 0');assert.equal(restored.x,0);assert.equal(restored.version,4);
    await authority.undo(f.ownerSession,f.sketch.id,undo);assert.equal((await bootstrap(backend,f.ownerSession,f.sketch.id)).sequence,3);
    await assert.rejects(authority.undo(f.ownerSession,f.sketch.id,{...undo,originalCommandIds:[second]}),refused('EDITING_IDEMPOTENCY_CONFLICT'));
    const own=randomUUID();const other=randomUUID();const edit={expectedVersion:4,text:'Another own edit'};await native(f.ownerSession,f.sketch.id,own,edit).updateThought(f.ownerSession.principal,f.sketch.id,f.ids[0]!,edit);
    const peerEdit={expectedVersion:5,text:'Peer keeps this'};await native(f.peerSession,f.sketch.id,other,peerEdit).updateThought(f.peerSession.principal,f.sketch.id,f.ids[0]!,peerEdit);
    const before=await bootstrap(backend,f.ownerSession,f.sketch.id);await assert.rejects(authority.undo(f.ownerSession,f.sketch.id,{clientCommandId:randomUUID(),originalCommandIds:[own]}),refused('EDITING_UNDO_CONFLICT'));
    const after=await bootstrap(backend,f.ownerSession,f.sketch.id);assert.equal(after.sequence,before.sequence);assert.equal(after.sketch.thoughts.find(t=>t.id===f.ids[0])?.text,'Peer keeps this');
    await assert.rejects(authority.undo(f.peerSession,f.sketch.id,{clientCommandId:randomUUID(),originalCommandIds:[own]}),refused('EDITING_UNDO_CONFLICT'));
    assert.equal((await delta(backend,f.peerSession,head,0))?.sequence,1);
  } finally {await authority.close();assert.equal(apiEditingOutputBudget.bytes,0);}
});

test('native deletion/link restore keep monotonic thought versions and link epochs; old HTTP/core replay never creates new graph state', {timeout:15000},async()=>{
  const f=await scene();const backend=mapBackend({pool});const authority=mapAuthority(backend,apiEditingOutputBudget);
  try {
    const head=await bootstrap(backend,f.ownerSession,f.sketch.id);const linkId=randomUUID();const added=randomUUID();const link={id:linkId,fromId:f.ids[0]!,toId:f.ids[1]!};
    await native(f.ownerSession,f.sketch.id,added,link).addLink(f.ownerSession.principal,f.sketch.id,link);
    const deleted=randomUUID();await native(f.ownerSession,f.sketch.id,deleted,{expectedVersion:1}).removeThought(f.ownerSession.principal,f.sketch.id,f.ids[0]!,1);
    const tombstone=await delta(backend,f.peerSession,head,1);assert.deepEqual(tombstone?.removedThoughts,[{id:f.ids[0],version:2}]);assert.deepEqual(tombstone?.removedLinks,[linkId]);
    await authority.undo(f.ownerSession,f.sketch.id,{clientCommandId:randomUUID(),originalCommandIds:[deleted]});
    const restored=(await bootstrap(backend,f.ownerSession,f.sketch.id)).sketch.thoughts.find(t=>t.id===f.ids[0])!;assert.equal(restored.version,3);
    assert.equal((await pool.query("SELECT version FROM map_live_object_versions WHERE kind='link' AND object_id=$1",[linkId])).rows[0].version,'3');
    const before=(await bootstrap(backend,f.ownerSession,f.sketch.id)).sequence;
    await native(f.ownerSession,f.sketch.id,deleted,{expectedVersion:1}).removeThought(f.ownerSession.principal,f.sketch.id,f.ids[0]!,1);
    assert.equal((await bootstrap(backend,f.ownerSession,f.sketch.id)).sequence,before);assert.equal((await bootstrap(backend,f.ownerSession,f.sketch.id)).sketch.thoughts.find(t=>t.id===f.ids[0])?.version,3);
    await assert.rejects(authority.undo(f.ownerSession,f.sketch.id,{clientCommandId:randomUUID(),originalCommandIds:[added]}),refused('EDITING_UNDO_CONFLICT'),'A link delete/restore is an intervening epoch even though its visible text is unchanged');
    const peerDelete=randomUUID();await native(f.peerSession,f.sketch.id,peerDelete,{expectedVersion:3}).removeThought(f.peerSession.principal,f.sketch.id,f.ids[0]!,3);
    await assert.rejects(authority.undo(f.ownerSession,f.sketch.id,{clientCommandId:randomUUID(),originalCommandIds:[deleted]}),refused('EDITING_UNDO_CONFLICT'));
  } finally {await authority.close();assert.equal(apiEditingOutputBudget.bytes,0);}
});

test('real live/native HTTP shares one budget, uses ordered receipts and current reader/write policy', {timeout:15000},async()=>{
  const f=await scene();const backend=mapBackend({pool});const authority=mapAuthority(backend,apiEditingOutputBudget);let current=f.ownerSession;
  const sessions:SessionResolver={async requirePrincipal(){return current;},async resolveSession(){return current;}};const app=Fastify();
  await app.register(sketchRoutes,{db,sessions,developmentEditing:true,liveBackend:()=>backend});await app.register(editingRoutes,{sessions,authority:null,maps:authority,outputBudget:apiEditingOutputBudget});
  try {
    // Map capability is enabled independently of the wiki fixture; production enables both through one composition.
    const bootstrapResponse=await app.inject({method:'GET',url:`/api/v1/sketches/${f.sketch.id}/live`});assert.equal(bootstrapResponse.statusCode,200,bootstrapResponse.body);const head=JSON.parse(bootstrapResponse.body) as LiveMapBootstrap;
    const commandId=randomUUID();const path=`/api/v1/sketches/${f.sketch.id}/thoughts/${f.ids[0]}`;
    const response=await app.inject({method:'PATCH',url:path,headers:{'idempotency-key':commandId},payload:{text:'Native HTTP',expectedVersion:1}});assert.equal(response.statusCode,200,response.body);
    current=f.peerSession;const changed=await delta(backend,f.peerSession,head,0);assert.equal(changed?.commandId,commandId);assert.equal(changed?.thoughts[0]?.text,'Native HTTP');
    current=f.viewerSession;const denied=await app.inject({method:'PATCH',url:path,payload:{text:'Viewer cannot write',expectedVersion:2}});assert.equal(denied.statusCode,403);assert.equal(JSON.parse(denied.body).current,undefined);
    current=f.ownerSession;await native(f.peerSession,f.sketch.id,randomUUID(),{expectedVersion:2}).removeThought(f.peerSession.principal,f.sketch.id,f.ids[0]!,2);
    const replay=await app.inject({method:'PATCH',url:path,headers:{'idempotency-key':commandId},payload:{text:'Native HTTP',expectedVersion:1}});assert.equal(replay.statusCode,200,replay.body);
    assert.equal((await bootstrap(backend,f.ownerSession,f.sketch.id)).sketch.thoughts.some((t:Thought)=>t.id===f.ids[0]),false);
    await db.delete(schema.projectGrants).where(and(eq(schema.projectGrants.projectId,f.place.id),eq(schema.projectGrants.userId,f.peer.id)));
    await assert.rejects(backend.deliver(who(f.peerSession),f.sketch.id,head.generation,0,()=>assert.fail('Revoked reader receives no delta')),error=>error instanceof Error&&'status' in error&&error.status===404);
  } finally {await app.close();await authority.close();assert.equal(apiEditingOutputBudget.bytes,0);}
});

test('private/DM rooms stay opaque, expired preview cannot revive, and final SQL-clock expiry precedes protected map handoff', {timeout:15000},async()=>{
  const f=await scene();const backend=mapBackend({pool});const authority=mapAuthority(backend,apiEditingOutputBudget);
  try {
    const privateMap=expectStatus(await f.owner.browser.request('POST',`/api/v1/workspaces/${f.ws.id}/sketches`,{body:{scope:'private',title:'Private recovery is never broadcast'}}),201) as Sketch;
    await bootstrap(backend,f.ownerSession,privateMap.id);
    await assert.rejects(backend.bootstrap(who(f.peerSession),privateMap.id,()=>assert.fail('An outsider cannot join a private map')),error=>error instanceof Error&&'status' in error&&error.status===404);
    const dmResponse=await f.peer.browser.request('POST',`/api/v1/workspaces/${f.ws.id}/dms`,{body:{participantIds:[f.viewer.id]}});assert.ok([200,201].includes(dmResponse.status));const dm=dmResponse.json as {id:string};
    const dmMap=expectStatus(await f.peer.browser.request('POST',`/api/v1/workspaces/${f.ws.id}/sketches`,{body:{scope:'dm',dmId:dm.id,title:'Only this direct message'}}),201) as Sketch;
    await bootstrap(backend,f.peerSession,dmMap.id);await assert.rejects(backend.bootstrap(who(f.ownerSession),dmMap.id,()=>assert.fail('Workspace ownership cannot disclose a private DM')),error=>error instanceof Error&&'status' in error&&error.status===404);
    const head=await bootstrap(backend,f.ownerSession,f.sketch.id);const lease=await authority.acquire(f.ownerSession,f.sketch.id,{gestureId:randomUUID(),thoughts:[{id:f.ids[0]!,expectedVersion:1}]});
    await pool.query("UPDATE map_live_gestures SET expires_at=clock_timestamp()-interval'1 second' WHERE lease_id=$1",[lease.leaseId]);
    await assert.rejects(authority.move(f.ownerSession,f.sketch.id,randomUUID(),{generation:head.generation,gestureId:lease.gestureId,leaseId:lease.leaseId,sequence:1,positions:[{id:f.ids[0]!,x:9,y:9}]}),refused('EDITING_LEASE_CHANGED'));
    await assert.rejects(authority.presence(f.viewerSession,f.sketch.id,randomUUID(),{generation:head.generation,selected:[],cursor:null}),error=>error instanceof Error&&'status' in error&&error.status===403);
    await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval'150 milliseconds' WHERE id=$1",[f.peerSession.sessionId]);
    const delayed=mapBackend({pool},{beforeHandoff:()=>new Promise(resolve=>setTimeout(resolve,220))});
    try {await assert.rejects(delayed.deliver(who(f.peerSession),f.sketch.id,head.generation,0,()=>assert.fail('No protected bytes after current SQL session expiry')),error=>error instanceof Error&&'statusCode' in error&&error.statusCode===401);}finally{await delayed.close();}
    assert.equal((await bootstrap(backend,f.ownerSession,f.sketch.id)).sequence,0);
  } finally {await authority.close();assert.equal(apiEditingOutputBudget.bytes,0);}
});
