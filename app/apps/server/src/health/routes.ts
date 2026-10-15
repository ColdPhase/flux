import { open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { assertExactMigrationLedger, FLUX_SCHEMA_VERSION, PG_BOSS_SCHEMA_VERSION, readAppliedMigrationVersions, type MigrationFile } from '@flux/db';

/**
 * `GET /api/v1/health`: ready only when the database has exactly this release's migrations, the
 * queue schema matches, and the files volume takes a write.
 */
export function registerHealth(app: FastifyInstance, { pool, boss, manifest, filesDir }: {
  pool: Parameters<typeof readAppliedMigrationVersions>[0]; boss: Pick<PgBoss, 'schemaVersion'>; manifest: readonly MigrationFile[]; filesDir: string;
}) {
  app.get('/api/v1/health', async (_request, reply) => {
    try {
      assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(pool));
      if ((await boss.schemaVersion()) !== PG_BOSS_SCHEMA_VERSION) throw new Error('Queue schema mismatch');
      const probe = join(filesDir, `.flux-health-${randomUUID()}`);
      const file = await open(probe, 'wx');
      try { await file.writeFile('ok'); } finally { await file.close(); await unlink(probe); }
      return { status: 'ok', schemaVersion: FLUX_SCHEMA_VERSION };
    } catch (error) {
      app.log.warn(error);
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
