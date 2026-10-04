import type { FastifyInstance } from 'fastify';
import type { SessionResolver } from '../identity/session.js';
import { EDITING_CHANNEL, listen, type createDatabase } from '@flux/db';
import { editingGate } from './gate.js';
import { wikiAuthority } from './authority.js';
import { wikiController } from './wiki-controller.js';
import { editingRoutes } from './routes.js';
import { apiEditingOutputBudget } from './output.js';
import { mapBackend } from './map-backend.js';
import { mapAuthority } from './map-authority.js';
import { mapController } from './map-controller.js';

interface Options {
  database: ReturnType<typeof createDatabase>; sessions: SessionResolver; publicOrigin: string; connectionString: string;
  /** Disabled by default; development selection does not certify any of the four required gates. */
  developmentEnabled: boolean;
}
export async function registerEditing(app: FastifyInstance, options: Options) {
  const outputBudget = apiEditingOutputBudget;
  const authority = options.developmentEnabled ? wikiAuthority(options.database,undefined,{outputBudget}) : null;
  const controller = authority ? wikiController(authority, outputBudget) : null;
  const mapsBackend=options.developmentEnabled?mapBackend(options.database):null;
  const mapsAuthority=mapsBackend?mapAuthority(mapsBackend,outputBudget):null;
  const mapsController=mapsAuthority?mapController(mapsAuthority,outputBudget):null;
  await app.register(editingRoutes, { sessions: options.sessions, authority, outputBudget,maps:mapsAuthority });
  if (!authority || !controller||!mapsBackend||!mapsAuthority||!mapsController) return null;
  const gate = editingGate({ sessions: options.sessions, publicOrigin: options.publicOrigin,
    async authorize(context) {
      if(context.target.kind==='wiki')await authority.handoff(context.session,context.target.id,()=>{});
      else await mapsAuthority.authorize(context.session,context.target.id,()=>{});
    }, accept(socket,context){if(context.target.kind==='wiki')controller.accept(socket,context);else mapsController.accept(socket,context);} });
  // NOTIFY contains only a room UUID. Both API replicas re-read committed updates under current policy.
  const notifications = listen(options.connectionString, EDITING_CHANNEL,
    (roomId) => { if (/^[0-9a-f-]{36}$/i.test(roomId)){controller.notify(roomId);mapsController.notify(roomId);} },
    () => {controller.notifyAll();mapsController.notifyAll();}, (error) => app.log.warn({ error }, 'Live editing notifications reconnecting'));
  app.addHook('onClose', async () => { await gate.close(); await notifications.close(); await controller.close();await mapsController.close(); });
  return { gate, controller,mapsAuthority,mapsBackend,mapsController };
}
