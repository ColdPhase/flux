import { artifactResetRows, canonicalArtifactTaskIds, fileRows, liveMapRows, prepareCanonicalArtifactTasks, sketchRows, type DbExecutor, visibleFilter, accessReader, type Database, type Transaction } from '@flux/db';
import {
  createSketchUseCases,
  ForbiddenError,
  ConflictError,
  placeThoughtImage,
  prepareThoughtImage,
  policySketchAccess,
  recordEvent,
  ServiceUnavailableError,
  type FileStorage,
  type Principal,
  type SketchFiles,
  type SketchPorts,
  type SketchRepository,
  type SketchUnitOfWork,
} from '@flux/core';
import { decodeMapChange } from '../editing/map-state.js';
import { nativeMapJournal,prepareNativeMap, type NativeMapOptions } from '../editing/native-map-journal.js';
import { transactionEventSession,type TransactionEventSession } from '../work/transaction-events.js';
import { eventPorts } from '../events.js';

// Adapters that connect the core sketch use cases to Drizzle, the access policy and the event
// log (issue #69; #46: core defines the ports, the server assembles them).

function author(principal: Principal): { kind: 'human' | 'agent'; id: string } {
  if (principal.kind === 'fixture') throw new Error('A fixture principal cannot author sketch content');
  return { kind: principal.kind, id: principal.id };
}

export function sketchRepository(db: DbExecutor): SketchRepository {
  const rows = sketchRows(db);
  return {
    ...rows,
    /** The policy's own list condition (`visibleFilter`) is applied before the limit and in the total. */
    async listVisible(principal, workspaceId, filter, page) {
      return rows.list(workspaceId, await visibleFilter(principal, workspaceId, 'sketch', db), filter, page);
    },
    // A second private map for one person is refused by the database too (#947); two requests that raced answer like the check.
    insertSketch: async (sketch) => {
      try {
        return await rows.insertSketch({ ...sketch, createdBy: author(sketch.createdBy) });
      } catch (error) {
        const code = (error as { code?: string; cause?: { code?: string } } | null);
        if (sketch.scope === 'private' && (code?.code ?? code?.cause?.code) === '23505') throw new ConflictError('You already have your map', 'MY_MAP_EXISTS');
        throw error;
      }
    },
    insertThought: async (thought) => {
      const versions=liveMapRows(db,decodeMapChange);const previous=await versions.version('thought',thought.id);
      if(previous&&previous.sketchId!==thought.sketchId)throw new ConflictError('This retained ID belongs to another map','EDITING_IDEMPOTENCY_CONFLICT');
      return rows.insertThought({...thought,version:(previous?.version??0)+1,createdBy:author(thought.createdBy)});
    },
    insertLink: async (link) => {
      const previous=await liveMapRows(db,decodeMapChange).version('link',link.id);
      if(previous&&previous.sketchId!==link.sketchId)throw new ConflictError('This retained link ID belongs to another map','EDITING_IDEMPOTENCY_CONFLICT');
      return rows.insertLink({ ...link, createdBy: author(link.createdBy) });
    },
  };
}

/**
 * Map thought images (#252) over the stored-files rows of the same transaction. Without the files volume (compositions
 * that only read maps, such as agent reads) placing an image is refused; agents are refused by the files rule anyway.
 */
export function sketchFiles(tx: Database, storage?: FileStorage): SketchFiles {
  const files = fileRows(tx as DbExecutor);
  return {
    ofThoughts: (projectId, thoughtIds) => files.thoughtFiles(projectId, thoughtIds),
    place: (principal, input) => placeThoughtImage(files, storage ?? { read: async () => {
      throw new ForbiddenError('Images cannot be placed on a map here', 'FILE_PLACEMENT_UNAVAILABLE');
    } }, principal, input),
    preparePlace:(principal,input)=>prepareThoughtImage(files,storage??{read:async()=>{
      throw new ForbiddenError('Images cannot be placed on a map here','FILE_PLACEMENT_UNAVAILABLE');
    }},principal,input),
  };
}

/** The ports of one unit of work (exported for the concurrency tests). */
export function sketchPorts(tx: Database, storage?: FileStorage): SketchPorts {
  const sketches=sketchRepository(tx as DbExecutor);
  return {
    access: policySketchAccess(accessReader(tx)),
    files: sketchFiles(tx, storage),
    sketches,
    live:nativeMapJournal(tx as DbExecutor,sketches).journal,
    artifacts:{async prepare(sketch,thoughtIds){
      if(sketch.scope!=='project'||!sketch.projectId)return null;
      const scope={workspaceId:sketch.workspaceId,projectId:sketch.projectId};
      const retained=await prepareCanonicalArtifactTasks(tx,scope,thoughtIds.map(id=>({kind:'thought' as const,id})),[]);
      return{
        async thought(before,after){
          if(before&&before.text===after.text)return;
          const recipients=await canonicalArtifactTaskIds(tx,scope,{kind:'thought',id:after.id});
          await artifactResetRows(tx).record(scope,{kind:'thought',id:after.id,revision:String(after.version)},recipients,retained);
        },
        file:(fileId)=>artifactResetRows(tx).publishedFile(scope,fileId,retained),
      };
    }},
    events: { record: async (principal, workspaceId, kind, sketchId, data) => { await recordEvent(eventPorts(tx), principal, workspaceId, kind, sketchId, data); } },
  };
}

/** A finite native map/output capacity refusal is a retryable 503, never an internal error. */
export function nativeCapacityRefusal(error: unknown): unknown {
  if(error instanceof Error&&'code' in error&&(error.code==='EDITING_MAP_CAPACITY'||error.code==='EDITING_OUTPUT_CAPACITY')&&!(error instanceof ServiceUnavailableError)) {
    const refusal=new ServiceUnavailableError('The finite native map capacity is busy',String(error.code));refusal.details={outcome:'refused',retryable:true};return refusal;
  }
  return error;
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function sketchUnitOfWork(db: Database, storage?: FileStorage, options: NativeMapOptions = {}): SketchUnitOfWork {
  return { async run<T>(work:(ports:SketchPorts)=>Promise<T>):Promise<T> {
    let release=()=>{};let releasePreparation=()=>{};
    try {
      // Only a map with an established live room takes the live preparation (#239 review); an
      // ordinary map is neither charged nor queued. A room that appears later is admitted by the journal.
      const live=!options.prepared&&!!options.principal&&!!options.resourceId&&await liveMapRows(db as DbExecutor,decodeMapChange).exists(options.resourceId);
      if(live){options.protectLifetime?.();releasePreparation=await prepareNativeMap(options.context??{principal:options.principal,sessionId:options.sessionId,resourceId:options.resourceId,commandId:options.commandId,operation:options.operation,fingerprint:options.fingerprint});}
      const prepared=!!options.prepared||live;
      return await db.transaction(async tx=>{
        const ports=sketchPorts(tx,storage);const events=transactionEventSession(tx);ports.events=events;const journal=nativeMapJournal(tx,ports.sketches,{...options,prepared});ports.live=journal.journal;release=()=>journal.release();
        const replay=await journal.replay();if(replay.found)return replay.value as T;
        const result=await events.run(()=>work(ports));await journal.finish(result);await events.flushEvents();return result;
      });
    } catch(error) {
      throw nativeCapacityRefusal(error);
    } finally {release();if(options.retainUntil)options.retainUntil(releasePreparation);else releasePreparation();}
  } };
}

/** The sketch use cases bound to a connection or transaction; `storage` lets a thought take a staged image (#252). */
export const sketchUseCases = (db: Database, storage?: FileStorage, options: NativeMapOptions = {}) => createSketchUseCases(sketchUnitOfWork(db, storage, options));

/** Sketch commands sharing a composing caller's transaction and single final event batch (#152 map actions). */
export function nativeSketchInEventSession(tx: Transaction, session: TransactionEventSession,options:NativeMapOptions={}) {
  const ports:SketchPorts={...sketchPorts(tx),events:session};const journal=nativeMapJournal(tx,ports.sketches,options);ports.live=journal.journal;
  return createSketchUseCases({run:(action)=>session.run(async()=>{try {const result=await action(ports);await journal.finish(result);return result;}
    catch(error){throw nativeCapacityRefusal(error);}
    finally{journal.release();}})});
}
