import { readFile } from 'node:fs/promises';
import { createDatabase } from '@flux/db';
import { PgBoss } from 'pg-boss';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
try {
  const sql = await readFile('packages/db/migrations/0001_foundation.sql', 'utf8');
  await pool.query(sql);
  const boss = new PgBoss({ connectionString });
  boss.on('error', (error) => console.error(error));
  await boss.start();
  await boss.createQueue('sample.process');
  await boss.stop();
  console.log('Flux schema 1 and pg-boss ready');
} finally {
  await pool.end();
}
