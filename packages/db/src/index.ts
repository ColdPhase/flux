import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export { schema };
export { sql } from 'drizzle-orm';
// Highest numbered file in packages/db/migrations. The API refuses other versions.
export const FLUX_SCHEMA_VERSION = 3;
// pg-boss 12.35.0 declares schema 43. Update this with the pinned package.
export const PG_BOSS_SCHEMA_VERSION = 43;

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1500, query_timeout: 2000 });
  const db = drizzle({ client: pool, schema });
  return { pool, db };
}
