import type { FastifyInstance } from 'fastify';
import type { SessionResolver } from '../identity/session.js';
import { EDITING_CHANNEL, listen, sql, type createDatabase, type DbExecutor, type EditingConfirmationPolicy } from '@flux/db';
import { ConflictError } from '@flux/core';
import { editingGate } from './gate.js';
import { wikiAuthority } from './authority.js';
import { wikiController } from './wiki-controller.js';
import { editingRoutes } from './routes.js';
import { apiEditingOutputBudget } from './output.js';
import { mapBackend } from './map-backend.js';
import { mapAuthority } from './map-authority.js';
import { mapController } from './map-controller.js';
import { editingHTTPQueued } from './http-admission.js';
import { closeNativeMapAdmission } from './native-map-journal.js';
import { developmentQueueTelemetry,EDITING_RESOURCE_GAUGES,type EditingQueueTelemetry,type EditingResourceSnapshot } from './telemetry.js';
import { observeEditingResources } from './resource-observation.js';

interface Options {
  database: ReturnType<typeof createDatabase>; sessions: SessionResolver; publicOrigin: string; connectionString: string;
  /** Production availability and isolated diagnostics are independent. */
  enabled: boolean;
  developmentEnabled: boolean;
  env?:NodeJS.ProcessEnv;
  confirmation?:EditingConfirmationPolicy|null;
}
/**
 * F-030: live Wiki and live maps are not offered for an encrypted workspace until S2b seals their persistence. Every
 * live route and room upgrade answers 409 WORKSPACE_ENCRYPTED_UNSUPPORTED for its objects and writes nothing.
 */
export function refuseSealedLive(db: DbExecutor) {
  return async (target: { docId?: unknown; sketchId?: unknown }) => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const query = typeof target.docId === 'string' && UUID.test(target.docId)
      ? sql`SELECT w.encrypted FROM project_materials o JOIN workspaces w ON w.id = o.workspace_id WHERE o.id = ${target.docId}::uuid`
      : typeof target.sketchId === 'string' && UUID.test(target.sketchId)
        ? sql`SELECT w.encrypted FROM sketches o JOIN workspaces w ON w.id = o.workspace_id WHERE o.id = ${target.sketchId}::uuid` : null;
    if (!query) return;
    const [row] = (await db.execute<{ encrypted: boolean }>(query)).rows;
    if (row?.encrypted) throw new ConflictError('Live editing is not available in an encrypted space yet', 'WORKSPACE_ENCRYPTED_UNSUPPORTED');
  };
}

export async function registerEditing(app: FastifyInstance, options: Options) {
  const outputBudget = apiEditingOutputBudget;
  let telemetry:EditingQueueTelemetry|null=null;
  const authority = options.enabled ? wikiAuthority(options.database,undefined,{outputBudget,confirmation:options.confirmation}) : null;
  const controller = authority ? wikiController(authority, outputBudget,()=>telemetry) : null;
  const mapsBackend=options.enabled?mapBackend(options.database,{confirmation:options.confirmation}):null;
  const mapsAuthority=mapsBackend?mapAuthority(mapsBackend,outputBudget):null;
  const mapsController=mapsAuthority?mapController(mapsAuthority,outputBudget,()=>telemetry):null;
  const sealedLive = refuseSealedLive(options.database.db as unknown as DbExecutor);
  await app.register(editingRoutes, { sessions: options.sessions, authority, outputBudget,maps:mapsAuthority, sealedLive });
  if (!authority || !controller||!mapsBackend||!mapsAuthority||!mapsController) return null;
  const gate = editingGate({ sessions: options.sessions, publicOrigin: options.publicOrigin,
    async authorize(context) {
      await sealedLive(context.target.kind === 'wiki' ? { docId: context.target.id } : { sketchId: context.target.id });
      if(context.target.kind==='wiki')await authority.handoff(context.session,context.target.id,()=>{});
      else await mapsAuthority.authorize(context.session,context.target.id,()=>{});
    }, accept(socket,context){if(context.target.kind==='wiki')controller.accept(socket,context);else mapsController.accept(socket,context);} });
  // NOTIFY contains only a room UUID. Both API replicas re-read committed updates under current policy.
  const notifications = listen(options.connectionString, EDITING_CHANNEL,
    (roomId) => { if (/^[0-9a-f-]{36}$/i.test(roomId)){controller.notify(roomId);mapsController.notify(roomId);} },
    () => {controller.notifyAll();mapsController.notifyAll();}, (error) => app.log.warn({ error }, 'Live editing notifications reconnecting'));
  const resources=():EditingResourceSnapshot=>{
    const queues=editingHTTPQueued();
    return{gatePending:gate.pending,gateConnected:gate.connected,...controller.resources,
      httpQueued:queues.http,nativeQueued:queues.native,wikiOutputQueued:queues.wiki,
      admissionQueued:authority.runtime.admissionQueued,codecLeases:authority.runtime.codecLeases,
      codecWaiting:authority.runtime.codecWaiting,codecActive:authority.runtime.codecActive,wikiSqlActive:authority.sqlActive,
      mapQueued:mapsAuthority.queued,mapActive:mapsAuthority.inFlight,mapSqlActive:mapsBackend.sqlActive,...mapsController.resources,
      externalInputBytes:authority.runtime.externalInputBytes,externalOutputBytes:outputBudget.bytes};
  };
  telemetry=developmentQueueTelemetry(options.env??process.env,options.enabled&&options.developmentEnabled,resources);
  const unobserve=telemetry?observeEditingResources(telemetry.observe):()=>{};
  telemetry?.start();
  let closed:Promise<void>|null=null;
  const close=()=>closed??=(async()=>{
    telemetry?.stopSampling();closeNativeMapAdmission();
    await gate.close();await notifications.close();await controller.close();await mapsController.close();
  })();
  app.addHook('onClose',close);
  return { gate, controller,mapsAuthority,mapsBackend,mapsController,close,
    /** Call after Fastify and its HTTP/database hooks settle, never while a SQL fence is held. */
    async finishTelemetry(){
      await close();const current=resources();const drained=EDITING_RESOURCE_GAUGES.every(field=>current[field]===0);
      try{return telemetry?await telemetry.finish(drained)&&drained:true;}finally{unobserve();}
    },
  };
}
