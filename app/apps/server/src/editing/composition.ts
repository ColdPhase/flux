import type { FastifyInstance } from 'fastify';
import type { SessionResolver } from '../identity/session.js';
import { EDITING_CHANNEL, listen, type createDatabase } from '@flux/db';
import { NotFoundError } from '@flux/core';
import { editingGate } from './gate.js';
import { wikiAuthority } from './authority.js';
import { wikiController } from './wiki-controller.js';
import { editingRoutes } from './routes.js';
import { EditingOutputBudget } from './output.js';

interface Options {
  database: ReturnType<typeof createDatabase>; sessions: SessionResolver; publicOrigin: string; connectionString: string;
  /** Disabled by default; development selection does not certify any of the four required gates. */
  developmentEnabled: boolean;
}
export async function registerEditing(app: FastifyInstance, options: Options) {
  const outputBudget = new EditingOutputBudget();
  const authority = options.developmentEnabled ? wikiAuthority(options.database) : null;
  const controller = authority ? wikiController(authority, outputBudget) : null;
  await app.register(editingRoutes, { sessions: options.sessions, authority, outputBudget });
  if (!authority || !controller) return null;
  const gate = editingGate({ sessions: options.sessions, publicOrigin: options.publicOrigin,
    async authorize(context) {
      if (context.target.kind !== 'wiki') throw new NotFoundError(); // Map authority/journal composition follows its own source slice.
      await authority.handoff(context.session, context.target.id, () => {});
    }, accept: controller.accept });
  // NOTIFY contains only a room UUID. Both API replicas re-read committed updates under current policy.
  const notifications = listen(options.connectionString, EDITING_CHANNEL,
    (docId) => { if (/^[0-9a-f-]{36}$/i.test(docId)) controller.notify(docId); },
    () => controller.notifyAll(), (error) => app.log.warn({ error }, 'Live editing notifications reconnecting'));
  app.addHook('onClose', async () => { await gate.close(); await notifications.close(); await controller.close(); });
  return { gate, controller };
}
