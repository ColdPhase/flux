import { createHash, randomUUID } from 'node:crypto';
import { and,eq,sql } from 'drizzle-orm';
import { editingSessionRows, liveMapRows, schema, type DbExecutor } from '@flux/db';
import { ConflictError, InvalidInputError, derivedUuid,policySketchAccess, type MapNativeChange, type Principal, type SketchLiveJournal } from '@flux/core';
import type { SketchRepository } from '@flux/core';
import { decodeMapChange } from './map-state.js';
import { apiEditingOutputBudget } from './output.js';
import { EditingHTTPAdmission } from './http-admission.js';
import { editingMapContextCharge } from './context-charge.js';
const admissions=new EditingHTTPAdmission(apiEditingOutputBudget,10_000,'native');
export const closeNativeMapAdmission=()=>admissions.close();

/** Native validated copies and their exact raw/context retainers are charged before SQL admission. */
export async function prepareNativeMap(context:unknown) {
  const input=apiEditingOutputBudget.reserve(2*editingMapContextCharge(context));
  try {const response=await admissions.admit(0);return ()=>{response();input();};}
  catch(error){input();throw error;}
}
export const nativeMapAdmissionQueued=()=>admissions.queued;
/** Non-locking room read before any live preparation; a map without a live room stays ordinary (#239 review). */
export const nativeMapRoomExists=(db:DbExecutor,sketchId:string)=>liveMapRows(db,decodeMapChange).exists(sketchId);

export interface NativeMapOptions {
  commandId?:string;sessionId?:string;fingerprint?:string;operation?:string;principal?:Principal;retainUntil?: (release:()=>void)=>void;prepared?:boolean;resourceId?:string;context?:unknown;
  /** Acquire HTTP owner metadata before any protected live input/admission. */
  protectLifetime?:()=>void;
}
const conflict=()=>new ConflictError('This command UUID belongs to another immutable intent','EDITING_IDEMPOTENCY_CONFLICT');
/** Only affected raw objects/dependency bags enter the durable journal; delivery projects current read rights. */
export function nativeMapJournal(db:DbExecutor,repository:SketchRepository,options:NativeMapOptions={}) {
  const rows=liveMapRows(db,decodeMapChange);let subcommand=0;let releaseResponse:(()=>void)|null=null;const retained=new Set<()=>void>();
  const completed: {room:NonNullable<Awaited<ReturnType<typeof rows.head>>>;change:MapNativeChange;commandId:string;principal:Principal}[]=[];
  const pending=new Map<string,{room:NonNullable<Awaited<ReturnType<typeof rows.head>>>;change:MapNativeChange;commandId:string;principal:Principal}>();
  const journal:SketchLiveJournal={
    async before(principal,sketch,affected) {
      // An unprepared command on a map without a live room stays ordinary: no live charge,
      // admission or author requirement (#239 review). A prepared caller saw the room already.
      if(!options.prepared&&!await rows.exists(sketch.id)){if(affected.leaseId)throw new ConflictError('No active drag lease exists','EDITING_LEASE_CHANGED');return;}
      if(principal.kind==='fixture')throw new InvalidInputError('A real map author is required');
      options.protectLifetime?.();
      const releaseInput=apiEditingOutputBudget.reserve(editingMapContextCharge({principal,sketchId:sketch.id,affected,commandId:options.commandId,sessionId:options.sessionId,operation:options.operation}));
      retained.add(releaseInput);
      const room=await rows.head(sketch.id);
      // A first live join atomically establishes the native baseline. Earlier ordinary maps remain ordinary.
      if(!room){retained.delete(releaseInput);releaseInput();if(affected.leaseId)throw new ConflictError('No active drag lease exists','EDITING_LEASE_CHANGED');return;}
      if(!options.prepared)releaseResponse??=await admissions.admit(0);
      await rows.snapshotCapacity(sketch.id);
      await rows.journalCapacity(sketch.id,affected.thoughtIds,affected.linkIds);
      if(options.sessionId&&principal.kind==='human'&&!await editingSessionRows(db).lock({actorId:principal.id,sessionId:options.sessionId}))throw new ConflictError('The current session ended','UNAUTHENTICATED');
      if(pending.has(sketch.id))throw new Error('Await each native map command before composing another');
      const commandId=options.commandId?(subcommand++===0?options.commandId:derivedUuid('flux.map.native-subcommand.v1',options.commandId,String(subcommand))):randomUUID();
      if(principal.kind==='human') {
        await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'flux.editing.intent:'+principal.id+':'+commandId},0))`);
        const [old]=await db.select().from(schema.liveEditingIntents).where(and(eq(schema.liveEditingIntents.actorId,principal.id),eq(schema.liveEditingIntents.commandId,commandId)));
        if(old)throw conflict(); // The ordinary HTTP idempotency layer returns its original response before entering here.
      }
      if(affected.leaseId) {
        const lease=await rows.gesture(affected.leaseId);
        if(principal.kind!=='human'||!options.sessionId||!lease||lease.actorId!==principal.id||lease.sessionId!==options.sessionId||lease.sketchId!==sketch.id||lease.generation!==room.generation
          ||lease.thoughts.length!==affected.thoughtIds.length||lease.thoughts.some(t=>!affected.thoughtIds.includes(t.id)))throw new ConflictError('The drag lease changed; keep the intended placement private','EDITING_LEASE_CHANGED');
        const current=await editingSessionRows(db).lock({actorId:principal.id,sessionId:options.sessionId});
        const live=await db.execute<{alive:boolean}>(sql`SELECT ${lease.expiresAt}::timestamptz > clock_timestamp() AS alive`);
        if(!current||!live.rows[0]?.alive)throw new ConflictError('The drag lease expired','EDITING_LEASE_CHANGED');
      }
      let links=await rows.dependencyLinks(sketch.id,affected.thoughtIds,affected.linkIds);
      const thoughtIds=[...new Set([...affected.thoughtIds,...links.flatMap(l=>[l.fromId,l.toId])])];
      if(thoughtIds.length>2000)throw new ConflictError('The affected dependency bag reached its bounded capacity','EDITING_MAP_CAPACITY');
      links=await rows.dependencyLinks(sketch.id,thoughtIds,affected.linkIds);
      const thoughts=await repository.lockThoughts(sketch.id,thoughtIds);const found=new Map(thoughts.map(t=>[t.id,t]));
      // A retained ID cannot silently move to a different room or reset its version after deletion.
      for(const id of affected.thoughtIds) {
        const old=await rows.version('thought',id);if(old&&old.sketchId!==sketch.id)throw conflict();
        const current=found.get(id);if(current)await rows.putVersion('thought',id,sketch.id,Math.max(old?.version??0,current.version));
      }
      for(const link of links)await rows.putVersion('link',link.id,sketch.id,link.epoch);
      pending.set(sketch.id,{room,principal,commandId,change:{sketchBefore:affected.sketch?sketch:null,sketchAfter:null,
        thoughts:thoughtIds.map(id=>({id,before:found.get(id)??null,after:null})),
        links:[...new Set([...links.map(l=>l.id),...affected.linkIds])].map(id=>({id,before:links.find(l=>l.id===id)??null,after:null})),
        dependencies:thoughtIds.map(thoughtId=>({thoughtId,before:links.filter(l=>l.fromId===thoughtId||l.toId===thoughtId).map(l=>({id:l.id,epoch:l.epoch})),after:[]})),
        removedThoughts:[],clearedLeaseIds:[]}});
    },
    async commit(principal,sketch) {
      const preparation=pending.get(sketch.id);if(!preparation)return;
      if(preparation.principal.id!==principal.id||preparation.principal.kind!==principal.kind)throw new Error('Native map author changed');
      const change=preparation.change;const ids=change.thoughts.map(t=>t.id);
      const after=new Map((await repository.lockThoughts(sketch.id,ids)).map(t=>[t.id,t]));
      for(const item of change.thoughts) {
        item.after=after.get(item.id)??null;
        if(item.before&&!item.after) {const version=item.before.version+1;await rows.putVersion('thought',item.id,sketch.id,version);change.removedThoughts.push({id:item.id,version});}
        else if(item.after)await rows.putVersion('thought',item.id,sketch.id,item.after.version);
      }
      const links=await rows.dependencyLinks(sketch.id,ids,change.links.map(l=>l.id));const byId=new Map(links.map(l=>[l.id,l]));
      for(const item of change.links) {
        const next=byId.get(item.id)??null;const old=await rows.version('link',item.id);
        if(old&&old.sketchId!==sketch.id)throw conflict();
        if(next&&!item.before){next.epoch=(old?.version??0)+1;await rows.putVersion('link',item.id,sketch.id,next.epoch);}
        if(item.before&&!next)await rows.putVersion('link',item.id,sketch.id,item.before.epoch+1);
        item.after=next;
      }
      for(const dep of change.dependencies)dep.after=links.filter(l=>l.fromId===dep.thoughtId||l.toId===dep.thoughtId).map(l=>({id:l.id,epoch:byId.get(l.id)!.epoch}));
      change.sketchAfter=(await repository.findSketch(sketch.id))!;
      change.clearedLeaseIds=await rows.clearAffected(sketch.id,change.thoughts.filter(item=>JSON.stringify(item.before)!==JSON.stringify(item.after)).map(item=>item.id));
      // JSON of unchanged objects is retained as the undo guard, but only changed objects appear on the wire.
      pending.delete(sketch.id); completed.push(preparation);
    },
  };
  return {journal,pending,
    async replay() {
      if(options.principal?.kind==='human'&&options.sessionId&&!await editingSessionRows(db).lock({actorId:options.principal.id,sessionId:options.sessionId}))throw new ConflictError('The current session ended','UNAUTHENTICATED');
      if(!options.commandId||!options.resourceId||options.principal?.kind!=='human')return {found:false as const};
      const principal=options.principal;
      await policySketchAccess(db).requireSketch(principal,'sketch.read',options.resourceId,{lock:true});
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'flux.editing.intent:'+principal.id+':'+options.commandId},0))`);
      const [old]=await db.select().from(schema.liveEditingIntents).where(and(eq(schema.liveEditingIntents.actorId,principal.id),eq(schema.liveEditingIntents.commandId,options.commandId)));
      if(!old)return {found:false as const};
      const room=await rows.head(options.resourceId);const receipt=old.receipt;
      if(!room||old.kind!=='map'||old.resourceId!==room.sketchId||old.workspaceId!==room.workspaceId||old.generation!==room.generation
        ||old.operation!==options.operation||receipt.requestFingerprint!==options.fingerprint||!('nativeResult' in receipt))throw conflict();
      return {found:true as const,value:receipt.nativeResult};
    },
    release() {
      const response=releaseResponse;releaseResponse=null;
      const release=()=>{response?.();for(const input of retained)input();retained.clear();};
      // A prepared MCP/HTTP caller keeps its shared24MiB source reservation through outer SQL settlement.
      // Retain these additional exact metadata leases for that same lifetime as well, even when this
      // journal reused the caller reservation and therefore has no private response lease.
      if(options.retainUntil)options.retainUntil(release);else release();
    },
    async finish(result:unknown) {
      if(pending.size)throw new Error('Native map changes lack their commit preparation');
      for(const preparation of completed.splice(0)) {
        const {room,principal,commandId,change}=preparation;
        if(principal.kind==='fixture')throw new Error('Invalid persisted map author');
        const operation=options.operation??'native';
        const requestFingerprint=options.fingerprint??createHash('sha256').update(JSON.stringify(change)).digest('hex');
        const fingerprint=createHash('sha256').update(JSON.stringify({workspace:room.workspaceId,kind:'map',room:room.sketchId,generation:room.generation,
          actorKind:principal.kind,actor:principal.id,operation,commandId,requestFingerprint})).digest('hex');
        const sequence=await rows.append(room,{kind:principal.kind,id:principal.id},commandId,fingerprint,change);
        if(principal.kind==='human')await db.insert(schema.liveEditingIntents).values({actorId:principal.id,commandId,workspaceId:room.workspaceId,kind:'map',
          resourceId:room.sketchId,generation:room.generation,operation,fingerprint,byteLength:0,
          receipt:{commandId,generation:room.generation,sequence,operation,requestFingerprint,nativeResult:result??null}});
        if(options.sessionId&&principal.kind==='human'&&!await editingSessionRows(db).current({actorId:principal.id,sessionId:options.sessionId}))
          throw new ConflictError('The current session ended before the native commit','UNAUTHENTICATED');
      }
    },
  };
}
