import { createHash } from 'node:crypto';
import { and,eq,inArray,sql } from 'drizzle-orm';
import { liveMapRows,schema,type DbExecutor } from '@flux/db';
import { ConflictError,InvalidInputError,recordEvent,type MapNativeChange,type MapJournalLink,type SketchRecord,type ThoughtRecord } from '@flux/core';
import type { UndoLiveMap } from '@flux/contracts';
import { sketchRepository } from '../sketches/adapters.js';
import { decodeMapChange } from './map-state.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const conflict=()=>new ConflictError('An original object or its links changed; the entire undo remains private','EDITING_UNDO_CONFLICT');
function canonical(value:unknown):unknown {
  if(value instanceof Date)return value.toISOString();
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='updatedAt').sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>
    [key,key==='createdBy'&&child&&typeof child==='object'&&'kind' in child&&'id' in child?{kind:child.kind,id:child.id}:canonical(child)]));
  return value;
}
const equal=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const bags=(links:Map<string,MapJournalLink|null>,thoughtId:string)=>[...links.values()].filter((link):link is MapJournalLink=>!!link&&(link.fromId===thoughtId||link.toId===thoughtId))
  .map(link=>({id:link.id,epoch:link.epoch})).sort((a,b)=>a.id.localeCompare(b.id));
const sorted=(bag:{id:string;epoch:number}[])=>[...bag].sort((a,b)=>a.id.localeCompare(b.id));

/** The caller holds the current session/policy/native-room fence and a bounded preparation lease. */
export async function undoMap(db:DbExecutor,principal:{kind:'human';id:string},room:{sketchId:string;workspaceId:string;generation:string;sequence:number},sketch:SketchRecord,command:UndoLiveMap):Promise<string> {
  if(!command||Object.keys(command).some(key=>!['clientCommandId','originalCommandIds'].includes(key))||!UUID.test(command.clientCommandId)
    ||!Array.isArray(command.originalCommandIds)||!command.originalCommandIds.length||command.originalCommandIds.length>200
    ||command.originalCommandIds.some(id=>typeof id!=='string'||!UUID.test(id))||new Set(command.originalCommandIds).size!==command.originalCommandIds.length)
    throw new InvalidInputError('Undo names1–200 distinct original command UUIDs and one fresh inverse UUID');
  const commandId=command.clientCommandId.toLowerCase();const ids=command.originalCommandIds.map(id=>id.toLowerCase());
  const operation='map-undo';const fingerprint=createHash('sha256').update(JSON.stringify({workspace:room.workspaceId,kind:'map',room:room.sketchId,generation:room.generation,
    actor:principal.id,operation,commandId,originalCommandIds:ids})).digest('hex');
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'flux.editing.intent:'+principal.id+':'+commandId},0))`);
  const [known]=await db.select().from(schema.liveEditingIntents).where(and(eq(schema.liveEditingIntents.actorId,principal.id),eq(schema.liveEditingIntents.commandId,commandId)));
  if(known) {
    if(known.kind!=='map'||known.resourceId!==room.sketchId||known.workspaceId!==room.workspaceId||known.generation!==room.generation||known.operation!==operation||known.fingerprint!==fingerprint)
      throw new ConflictError('This UUID belongs to another immutable intent','EDITING_IDEMPOTENCY_CONFLICT');
    return commandId;
  }
  const rows=liveMapRows(db,decodeMapChange);const originals=await rows.originals(room.sketchId,room.generation,ids);
  if(originals.length!==ids.length||originals.some(row=>row.actorKind!=='human'||row.actorId!==principal.id||row.commandId===commandId))throw conflict();
  const ordered=[...originals].sort((a,b)=>b.sequence-a.sequence);
  if((await rows.undone(room.sketchId,room.generation,ordered.map(row=>row.sequence))).length)throw conflict();
  const thoughtIds=[...new Set(ordered.flatMap(row=>row.change.thoughts.map(item=>item.id)))];
  const linkIds=[...new Set(ordered.flatMap(row=>row.change.links.map(item=>item.id)))];
  if(thoughtIds.length>2000||linkIds.length>20_000)throw new ConflictError('The bounded undo dependency preparation is full','EDITING_MAP_CAPACITY');
  await rows.journalCapacity(room.sketchId,thoughtIds,linkIds,'undo');
  const repository=sketchRepository(db);const currentThoughts=new Map((await repository.lockThoughts(room.sketchId,thoughtIds)).map(thought=>[thought.id,thought]));
  const currentLinks=await rows.dependencyLinks(room.sketchId,thoughtIds,linkIds);
  const thoughts=new Map<string,ThoughtRecord|null>(thoughtIds.map(id=>[id,currentThoughts.get(id)??null]));
  const links=new Map<string,MapJournalLink|null>([...new Set([...linkIds,...currentLinks.map(link=>link.id)])].map(id=>[id,currentLinks.find(link=>link.id===id)??null]));
  let virtualSketch=sketch;let restoreTitle=false;
  // Every comparison and inverse is virtual. No native row changes until the entire reverse dry run succeeds.
  for(const original of ordered) {
    const change=original.change;
    for(const item of change.thoughts)if(!equal(thoughts.get(item.id)??null,item.after))throw conflict();
    for(const item of change.links)if(!equal(links.get(item.id)??null,item.after))throw conflict();
    for(const dependency of change.dependencies)if(!equal(bags(links,dependency.thoughtId),sorted(dependency.after)))throw conflict();
    if(change.sketchBefore) {if(!change.sketchAfter||!equal(virtualSketch,change.sketchAfter))throw conflict();virtualSketch=change.sketchBefore;restoreTitle=true;}
    for(const item of change.thoughts)thoughts.set(item.id,item.before);
    for(const item of change.links)links.set(item.id,item.before);
  }
  const thoughtChanges=thoughtIds.filter(id=>!equal(currentThoughts.get(id)??null,thoughts.get(id)??null));
  const linkChanges=[...links.keys()].filter(id=>!equal(currentLinks.find(link=>link.id===id)??null,links.get(id)??null));
  // Retained absence is also guarded: delete/restore/delete is an intervening peer effect even when no row survives.
  const checkedAbsence=new Set<string>();
  for(const original of ordered)for(const removed of original.change.removedThoughts) {
    if(checkedAbsence.has(removed.id))continue;checkedAbsence.add(removed.id);
    if(currentThoughts.has(removed.id))continue;
    const version=await rows.version('thought',removed.id);if(!version||version.sketchId!==room.sketchId||version.version!==removed.version)throw conflict();
  }
  for(const id of linkChanges) {
    const old=await rows.version('link',id);if(old&&old.sketchId!==room.sketchId)throw conflict();
    const earliest=ordered.find(row=>row.change.links.some(item=>item.id===id));
    const removed=earliest?.change.links.find(item=>item.id===id);
    if(!currentLinks.some(link=>link.id===id)&&removed?.before&&!removed.after&&old?.version!==removed.before.epoch+1)throw conflict();
  }
  const change:MapNativeChange={sketchBefore:restoreTitle?sketch:null,sketchAfter:null,
    thoughts:thoughtIds.map(id=>({id,before:currentThoughts.get(id)??null,after:null})),
    links:[...links.keys()].map(id=>({id,before:currentLinks.find(link=>link.id===id)??null,after:null})),
    dependencies:thoughtIds.map(thoughtId=>({thoughtId,before:sorted(currentLinks.filter(link=>link.fromId===thoughtId||link.toId===thoughtId).map(link=>({id:link.id,epoch:link.epoch}))),after:[]})),
    removedThoughts:[],clearedLeaseIds:[]};
  // Remove changed links first, then removed thoughts; restore thoughts before links, all in this transaction.
  if(linkChanges.length)await db.delete(schema.sketchLinks).where(and(eq(schema.sketchLinks.sketchId,room.sketchId),inArray(schema.sketchLinks.id,linkChanges)));
  for(const id of thoughtChanges) {
    const target=thoughts.get(id)??null;const retained=await rows.version('thought',id);if(retained&&retained.sketchId!==room.sketchId)throw conflict();
    const version=Math.max(retained?.version??0,currentThoughts.get(id)?.version??0)+1;
    if(!Number.isSafeInteger(version)||version>2147483647)throw new ConflictError('The native version capacity is full','EDITING_MAP_CAPACITY');
    if(!target) {await repository.deleteThought(room.sketchId,id);change.removedThoughts.push({id,version});}
    else {
      const values={text:target.text,x:target.x,y:target.y,width:target.width,height:target.height,shape:target.shape,version,
        placementType:target.placement?.type??null,placementId:target.placement?.id??null,sourceAuthorId:target.source?.authorId??null,
        sourceAuthorName:target.source?.authorName??null,sourceSentAt:target.source?.sentAt??null,sourceDmId:target.source?.dmId??null,sourceMessageId:target.source?.messageId??null,
        createdByUserId:target.createdBy.kind==='human'?target.createdBy.id:null,createdByAgentId:target.createdBy.kind==='agent'?target.createdBy.id:null,createdAt:target.createdAt,updatedAt:sql`clock_timestamp()`};
      await db.insert(schema.sketchThoughts).values({id,workspaceId:room.workspaceId,sketchId:room.sketchId,...values})
        .onConflictDoUpdate({target:schema.sketchThoughts.id,set:values,setWhere:eq(schema.sketchThoughts.sketchId,room.sketchId)});
    }
    await rows.putVersion('thought',id,room.sketchId,version);
  }
  for(const id of linkChanges) {
    const target=links.get(id);const retained=await rows.version('link',id);const epoch=(retained?.version??0)+1;if(!Number.isSafeInteger(epoch))throw new ConflictError('The link epoch capacity is full','EDITING_MAP_CAPACITY');
    if(target) {
      if(!thoughts.get(target.fromId)||!thoughts.get(target.toId))throw conflict();
      await db.insert(schema.sketchLinks).values({id,workspaceId:room.workspaceId,sketchId:room.sketchId,fromId:target.fromId,toId:target.toId,label:target.label,createdAt:target.createdAt,
        createdByUserId:target.createdBy.kind==='human'?target.createdBy.id:null,createdByAgentId:target.createdBy.kind==='agent'?target.createdBy.id:null});
    }
    await rows.putVersion('link',id,room.sketchId,epoch);
  }
  if(restoreTitle)await repository.renameSketch(room.sketchId,virtualSketch.title);
  await repository.touchSketch(room.sketchId);
  const finalThoughts=new Map((await repository.lockThoughts(room.sketchId,thoughtIds)).map(thought=>[thought.id,thought]));
  const finalLinks=await rows.dependencyLinks(room.sketchId,thoughtIds,[...links.keys()]);
  for(const item of change.thoughts)item.after=finalThoughts.get(item.id)??null;
  for(const item of change.links)item.after=finalLinks.find(link=>link.id===item.id)??null;
  for(const dependency of change.dependencies)dependency.after=sorted(finalLinks.filter(link=>link.fromId===dependency.thoughtId||link.toId===dependency.thoughtId).map(link=>({id:link.id,epoch:link.epoch})));
  change.sketchAfter=(await repository.findSketch(room.sketchId))!;change.clearedLeaseIds=await rows.clearAffected(room.sketchId,thoughtChanges);
  const sequence=await rows.append(room,{kind:'human',id:principal.id},commandId,fingerprint,change);
  await rows.markUndone(room.sketchId,room.generation,ordered.map(row=>row.sequence),sequence);
  await db.insert(schema.liveEditingIntents).values({actorId:principal.id,commandId,workspaceId:room.workspaceId,kind:'map',resourceId:room.sketchId,generation:room.generation,
    operation,fingerprint,byteLength:0,receipt:{commandId,generation:room.generation,sequence,operation,originalCommandIds:ids}});
  await recordEvent(db,principal,room.workspaceId,'sketch.changed.v1',room.sketchId,{op:'own_undo',thoughtIds:thoughtChanges,linkIds:linkChanges});
  return commandId;
}
