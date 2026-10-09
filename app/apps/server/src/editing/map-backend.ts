import { eq,sql } from 'drizzle-orm';
import { editingSessionRows,editingTransactions,liveMapRows,schema,type createDatabase,type EditingCommit } from '@flux/db';
import { ConflictError,ForbiddenError,InvalidInputError,NotFoundError,ServiceUnavailableError,createSketchUseCases,policySketchAccess,
  presentSketch,presentThoughts,presentThoughtLink,type LiveMapBackend,type MapIdentity,type MapNativeChange,type MapTransient } from '@flux/core';
import type { LiveMapDelta,LiveMapPosition,NamedPrincipal } from '@flux/contracts';
import { sketchFiles,sketchPorts,sketchRepository } from '../sketches/adapters.js';
import { UnauthenticatedError } from '../identity/session.js';
import { decodeMapChange,mapHash } from './map-state.js';
import { undoMap } from './map-undo.js';
import { editingResourcesChanged } from './resource-observation.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id=(value:unknown)=>{if(typeof value!=='string'||!UUID.test(value))throw new InvalidInputError('A UUID is required');return value.toLowerCase();};
const sequence=(value:unknown)=>{if(!Number.isSafeInteger(value)||Number(value)<0)throw new InvalidInputError('A finite sequence is required');return Number(value);};
const changed=(before:unknown,after:unknown)=>JSON.stringify(before)!==JSON.stringify(after);
const stale=()=>new ConflictError('The drag lease changed; keep intended positions private','EDITING_LEASE_CHANGED');
const closed=(value:unknown,keys:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new InvalidInputError('Unknown live map parameter');};
function positions(value:LiveMapPosition[],allowed:string[]) {
  if(!Array.isArray(value)||!value.length||value.length>200||new Set(value.map(p=>p?.id)).size!==value.length)throw new InvalidInputError('Positions must list1–200 distinct thoughts');
  return value.map(p=>{
    closed(p,['id','x','y','width','height']);const thought=id(p.id);
    if(!allowed.includes(thought)||!Number.isInteger(p.x)||!Number.isInteger(p.y)||Math.abs(p.x)>100_000||Math.abs(p.y)>100_000
      ||p.width!==undefined&&(!Number.isInteger(p.width)||p.width<80||p.width>800)||p.height!==undefined&&(!Number.isInteger(p.height)||p.height<40||p.height>800))throw new InvalidInputError('Invalid leased position');
    return {id:thought,x:p.x,y:p.y,...(p.width===undefined?{}:{width:p.width}),...(p.height===undefined?{}:{height:p.height})};
  });
}
export function mapBackend(database:{pool:Pick<ReturnType<typeof createDatabase>['pool'],'connect'>},boundary:{beforeHandoff?:()=>Promise<void>}={}):LiveMapBackend&{readonly sqlActive:number} {
  const transactions=editingTransactions(database.pool);const active=new Set<Promise<unknown>>();let closing=false;
  type Db=Parameters<Parameters<typeof transactions.run>[0]>[0];
  /**
   * Reads, handoff fences and a gesture's lease, preview and presence commit `transient`; bootstrap
   * (which may create the room's head) and undo stay durable (#228 Gate 4).
   */
  async function run<T>(who:MapIdentity,sketchId:string,write:boolean,action:(c:{db:Db;actor:NamedPrincipal;principal:{kind:'human';id:string};room:NonNullable<Awaited<ReturnType<ReturnType<typeof liveMapRows<MapNativeChange>>['head']>>>;sketch:NonNullable<Awaited<ReturnType<ReturnType<typeof sketchRepository>['findSketch']>>>;access:'read'|'write';finalFence:()=>Promise<void>})=>Promise<T>,commit:EditingCommit='durable') {
    if(closing)throw new ServiceUnavailableError('Live maps are closing','EDITING_MAP_CAPACITY');
    const work=transactions.run(async db=>{
      const sessions=editingSessionRows(db);const actor=await sessions.lock(who);if(!actor)throw new UnauthenticatedError();
      const principal={kind:'human' as const,id:actor.id};const access=await policySketchAccess(db).requireSketch(principal,write?'sketch.write':'sketch.read',id(sketchId),{lock:true});
      const sketch=await sketchRepository(db).findSketch(sketchId);if(!sketch)throw new NotFoundError('Sketch');
      const room=await liveMapRows(db,decodeMapChange).ensureHead(sketchId,sketch.workspaceId);
      const finalFence=async()=>{if(!await sessions.current(who))throw new UnauthenticatedError();};
      const result=await action({db,actor,principal,room,sketch,access,finalFence});await finalFence();return result;
    },commit);active.add(work);editingResourcesChanged();try{return await work;}finally{active.delete(work);editingResourcesChanged();}
  }
  async function delta(db:Db,principal:{kind:'human';id:string},room:{generation:string;workspaceId:string},sketch:Parameters<typeof presentThoughts>[2],record:NonNullable<Awaited<ReturnType<ReturnType<typeof liveMapRows<MapNativeChange>>['after']>>>,access:'read'|'write'):Promise<LiveMapDelta> {
    const change=record.change;const accessPort=policySketchAccess(db);
    const thoughts=await presentThoughts({access:accessPort,files:sketchFiles(db)},principal,{...sketch,workspaceId:room.workspaceId},change.thoughts.filter(t=>t.after&&changed(t.before,t.after)).map(t=>t.after!));
    const [author]=record.actorKind==='human'?await db.select({name:schema.authUsers.name}).from(schema.authUsers).where(eq(schema.authUsers.id,record.actorId))
      :await db.select({name:schema.agents.name}).from(schema.agents).where(eq(schema.agents.id,record.actorId));
    return {generation:record.generation,sequence:record.sequence,commandId:record.commandId,actor:{kind:record.actorKind,id:record.actorId,name:author?.name??'Former collaborator'},
      ...(change.sketchAfter?{sketch:presentSketch(change.sketchAfter,access)}:{}),thoughts,removedThoughts:change.removedThoughts,
      links:change.links.filter(l=>l.after&&changed(l.before,l.after)).map(l=>presentThoughtLink(l.after!)),removedLinks:change.links.filter(l=>l.before&&!l.after).map(l=>l.id),clearedLeaseIds:change.clearedLeaseIds};
  }
  async function lease(c:Parameters<Parameters<typeof run>[3]>[0],who:MapIdentity,leaseId:string,gestureId:string,generation:string,connectionId:string) {
    const rows=liveMapRows(c.db,decodeMapChange);const found=await rows.gesture(id(leaseId));
    if(!found||found.sketchId!==c.room.sketchId||found.generation!==id(generation)||found.gestureId!==id(gestureId)||found.actorId!==who.actorId||found.sessionId!==who.sessionId
      ||found.connectionId!==null&&found.connectionId!==id(connectionId))throw stale();
    const alive=await c.db.execute<{alive:boolean}>(sql`SELECT ${found.expiresAt}::timestamptz > clock_timestamp() AS alive`);if(!alive.rows[0]?.alive)throw stale();
    const current=await sketchRepository(c.db).lockThoughts(c.room.sketchId,found.thoughts.map(t=>t.id));
    if(current.length!==found.thoughts.length||found.thoughts.some(t=>current.find(row=>row.id===t.id)?.version!==t.expectedVersion))throw stale();
    return found;
  }
  return {
    get sqlActive(){return active.size;},
    bootstrap(who,sketchId,handoff){return run(who,sketchId,false,async c=>{
      const rows=liveMapRows(c.db,decodeMapChange);await rows.snapshotCapacity(sketchId);
      const sketch=await createSketchUseCases({run:action=>action(sketchPorts(c.db))}).get(c.principal,sketchId);
      await boundary.beforeHandoff?.();await c.finalFence();handoff({kind:'map',workspaceId:c.room.workspaceId,resourceId:sketchId,generation:c.room.generation,
        sequence:c.room.sequence,hash:mapHash(c.room.generation,c.room.sequence),sketch,canWrite:c.access==='write',actor:c.actor});
    });},
    authorize(who,sketchId,handoff){return run(who,sketchId,false,async c=>{await boundary.beforeHandoff?.();await c.finalFence();handoff();},'transient');},
    deliverNative(who,sketchId,body,handoff){return run(who,sketchId,false,async c=>{
      async function project(value:unknown,depth=0):Promise<unknown> {
        if(depth>8)throw new InvalidInputError('The native response is too deep');
        if(Array.isArray(value)){const result=[];for(const item of value)result.push(await project(item,depth+1));return result;}
        if(!value||typeof value!=='object')return value;
        if(value instanceof Date)return value;
        const result:Record<string,unknown>={};
        for(const [key,child] of Object.entries(value)) {
          if(key==='placement'&&child&&typeof child==='object'&&'type' in child&&child.type==='draft'&&'id' in child&&typeof child.id==='string') {
            const current=await policySketchAccess(c.db).placement(c.principal,{type:'draft',id:child.id});
            result[key]={type:'draft',id:child.id,title:current.readable&&current.workspaceId===c.room.workspaceId?current.title:null};
          } else result[key]=await project(child,depth+1);
        }
        return result;
      }
      const current=await project(body);await boundary.beforeHandoff?.();await c.finalFence();handoff(current);
    },'transient');},
    acquire(who,sketchId,gesture){return run(who,sketchId,true,async c=>{
      closed(gesture,['gestureId','thoughts']);id(gesture.gestureId);if(!Array.isArray(gesture.thoughts)||!gesture.thoughts.length||gesture.thoughts.length>200)throw new InvalidInputError('A drag selects1–200 thoughts');
      const requested=gesture.thoughts.map(t=>{closed(t,['id','expectedVersion']);if(!Number.isSafeInteger(t.expectedVersion)||t.expectedVersion<1)throw new InvalidInputError('A native base version is required');return{id:id(t.id),expectedVersion:t.expectedVersion};});
      if(new Set(requested.map(t=>t.id)).size!==requested.length)throw new InvalidInputError('Each selected thought may appear once');
      const current=await sketchRepository(c.db).lockThoughts(sketchId,requested.map(t=>t.id));
      if(current.length!==requested.length||requested.some(t=>current.find(row=>row.id===t.id)?.version!==t.expectedVersion))throw stale();
      const rows=liveMapRows(c.db,decodeMapChange);await rows.expire(sketchId);const leases=await rows.gestures(sketchId,c.room.generation);
      const exact=leases.find(l=>l.lease.actorId===who.actorId&&l.lease.sessionId===who.sessionId&&l.lease.gestureId===gesture.gestureId);
      if(exact){if(JSON.stringify(exact.lease.thoughts)!==JSON.stringify(requested))throw stale();return{leaseId:exact.lease.leaseId,gestureId:gesture.gestureId,generation:c.room.generation,expiresAt:exact.lease.expiresAt.toISOString()};}
      if(leases.some(l=>l.lease.thoughts.some(t=>requested.some(w=>w.id===t.id))))throw new ConflictError('Another collaborator is moving a selected thought','EDITING_GESTURE_CONFLICT');
      await rows.capacity('gesture',sketchId);const added=await rows.insertGesture(sketchId,c.room.generation,who,gesture.gestureId,requested);
      return{leaseId:added.leaseId,gestureId:added.gestureId,generation:added.generation,expiresAt:added.expiresAt.toISOString()};
    },'transient');},
    move(who,sketchId,connectionId,command){return run(who,sketchId,true,async c=>{
      closed(command,['generation','gestureId','leaseId','sequence','positions']);const current=await lease(c,who,command.leaseId,command.gestureId,command.generation,connectionId);
      const next=positions(command.positions,current.thoughts.map(t=>t.id));const seq=sequence(command.sequence);
      if(seq<current.sequence)return;if(seq===current.sequence){if(!current.connectionId||next.length!==current.positions.length||next.some((position,index)=>{const old=current.positions[index];return !old||position.id!==old.id||position.x!==old.x||position.y!==old.y||position.width!==old.width||position.height!==old.height;}))throw new ConflictError('A preview sequence has different positions','EDITING_PREVIEW_SEQUENCE_CONFLICT');return;}
      const packet={type:'map-move',generation:c.room.generation,connectionId,actor:c.actor,gestureId:current.gestureId,leaseId:current.leaseId,sequence:seq,positions:next,expiresAt:new Date().toISOString()};
      if(Buffer.byteLength(JSON.stringify(packet))>65_536)throw new ServiceUnavailableError('The bounded preview frame is full','EDITING_MAP_CAPACITY');
      const rows=liveMapRows(c.db,decodeMapChange);await rows.bindMove(current.leaseId,connectionId,seq,next);await rows.notify(sketchId);
    },'transient');},
    cancel(who,sketchId,connectionId,command){return run(who,sketchId,true,async c=>{closed(command,['generation','gestureId','leaseId']);const current=await lease(c,who,command.leaseId,command.gestureId,command.generation,connectionId);
      const rows=liveMapRows(c.db,decodeMapChange);await rows.removeGesture(current.leaseId);await rows.notify(sketchId);
    },'transient');},
    presence(who,sketchId,connectionId,command){return run(who,sketchId,true,async c=>{
      closed(command,['generation','selected','cursor']);if(id(command.generation)!==c.room.generation)throw new ConflictError('The map generation changed','EDITING_GENERATION_CHANGED');
      if(!Array.isArray(command.selected)||command.selected.length>16)throw new InvalidInputError('Presence names at most16 selected thoughts');
      const selected=command.selected.map(id);if(new Set(selected).size!==selected.length)throw new InvalidInputError('Each selected thought may appear once');
      if((await sketchRepository(c.db).lockThoughts(sketchId,selected)).length!==selected.length)throw new InvalidInputError('Selection contains another map');
      if(command.cursor){closed(command.cursor,['x','y']);if(!Number.isInteger(command.cursor.x)||!Number.isInteger(command.cursor.y)||Math.abs(command.cursor.x)>100_000||Math.abs(command.cursor.y)>100_000)throw new InvalidInputError('Invalid map cursor');}
      const rows=liveMapRows(c.db,decodeMapChange);if(!await rows.hasPresence(connectionId))await rows.capacity('presence',sketchId);
      const packet={type:'map-presence',generation:c.room.generation,connectionId,actor:c.actor,selected,cursor:command.cursor,expiresAt:new Date().toISOString()};
      if(Buffer.byteLength(JSON.stringify(packet))>65_536)throw new ServiceUnavailableError('The bounded presence frame is full','EDITING_MAP_CAPACITY');
      await rows.setPresence(sketchId,c.room.generation,who,id(connectionId),selected,command.cursor);await rows.notify(sketchId);
    },'transient');},
    undo(who,sketchId,command){return run(who,sketchId,true,c=>undoMap(c.db,c.principal,c.room,c.sketch,command));},
    deliverUndo(who,sketchId,commandId,handoff){return run(who,sketchId,false,async c=>{
      const row=await liveMapRows(c.db,decodeMapChange).command({kind:'human',id:who.actorId},id(commandId));
      if(!row||row.sketchId!==sketchId||row.generation!==c.room.generation)throw new NotFoundError('Undo receipt');
      const value=await delta(c.db,c.principal,c.room,c.sketch,row,c.access);await boundary.beforeHandoff?.();await c.finalFence();handoff({commandId,delta:value});
    },'transient');},
    deliver(who,sketchId,generation,afterSequence,handoff,options={}){return run(who,sketchId,false,async c=>{
      if(id(generation)!==c.room.generation)throw new ConflictError('The map generation changed','EDITING_GENERATION_CHANGED');
      const after=sequence(afterSequence);if(after>c.room.sequence)throw new ConflictError('The confirmed map sequence has a gap','EDITING_SEQUENCE_GAP');
      const rows=liveMapRows(c.db,decodeMapChange);
      // Room and policy locks are held: no other transaction changes these rows before they load.
      if(options.prepare){const need=await rows.deliveryNeed(sketchId,generation);
        options.prepare({...need,delta:options.includeDelta!==false&&after<c.room.sequence,nameBytes:need.nameBytes+Buffer.byteLength(c.actor.name)});}
      const record=options.includeDelta===false?null:await rows.after(sketchId,generation,after);
      if(options.includeDelta!==false&&after<c.room.sequence&&record?.sequence!==after+1)throw new ConflictError('The confirmed map sequence has a gap','EDITING_SEQUENCE_GAP');
      const transient:MapTransient[]=[];const access=policySketchAccess(c.db);
      for(const {lease:current,name} of await rows.gestures(sketchId,generation)) {
        if(!current.connectionId||!current.positions.length)continue;
        try{if(!await editingSessionRows(c.db).lock({sessionId:current.sessionId,actorId:current.actorId}))continue;await access.requireSketch({kind:'human',id:current.actorId},'sketch.write',sketchId,{lock:true});}catch(error){if(error instanceof ForbiddenError||error instanceof NotFoundError)continue;throw error;}
        transient.push({type:'map-move',generation,connectionId:current.connectionId,actor:{kind:'human',id:current.actorId,name},gestureId:current.gestureId,leaseId:current.leaseId,sequence:current.sequence,positions:current.positions,expiresAt:current.expiresAt.toISOString()});
      }
      for(const {presence:current,name} of await rows.presence(sketchId,generation)) {
        try{if(!await editingSessionRows(c.db).lock({sessionId:current.sessionId,actorId:current.actorId}))continue;await access.requireSketch({kind:'human',id:current.actorId},'sketch.write',sketchId,{lock:true});}catch(error){if(error instanceof ForbiddenError||error instanceof NotFoundError)continue;throw error;}
        transient.push({type:'map-presence',generation,connectionId:current.connectionId,actor:{kind:'human',id:current.actorId,name},selected:current.selected,cursor:current.cursor,expiresAt:current.expiresAt.toISOString()});
      }
      const next=record?await delta(c.db,c.principal,c.room,c.sketch,record,c.access):null;await boundary.beforeHandoff?.();
      const clock=await rows.currentTransientFence(who,sketchId,generation);if(!clock.recipientAlive)throw new UnauthenticatedError();
      const gestures=new Set(clock.gestureIds),people=new Set(clock.presenceIds);
      // No further await between this recipient+producer clock observation and the synchronous callback.
      const currentTransient=transient.filter(item=>item.type==='map-move'?gestures.has(item.leaseId):item.type==='map-presence'&&people.has(item.connectionId));
      handoff({generation,sequence:c.room.sequence,hash:mapHash(generation,c.room.sequence),workspaceId:c.room.workspaceId,resourceId:sketchId,actor:c.actor,canWrite:c.access==='write',delta:next,transient:currentTransient});
    },'transient');},
    disconnect(who,sketchId,connectionId){return run(who,sketchId,false,async c=>{const rows=liveMapRows(c.db,decodeMapChange);await rows.disconnect(sketchId,who,id(connectionId));await rows.notify(sketchId);},'transient');},
    async close(){closing=true;await Promise.allSettled([...active]);},
  };
}
