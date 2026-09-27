import type { FastifyInstance } from 'fastify';
import { createDatabase } from '@flux/db';

export function registerDatabase(app: FastifyInstance, connectionString: string) {
  const database = createDatabase(connectionString);
  app.addHook('onClose', async () => database.pool.end());
  return database;
}
