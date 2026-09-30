import type { FastifyInstance } from 'fastify';
import { createDatabase } from '@flux/db';

export function registerDatabase(app: FastifyInstance, connectionString: string) {
  const database = createDatabase(connectionString);
  database.pool.on('error', (error) => app.log.warn({ error }, 'Database connection interrupted'));
  app.addHook('onClose', async () => database.pool.end());
  return database;
}
