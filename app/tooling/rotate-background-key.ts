import { createDatabase, loadBackgroundMasterKey, openBackgroundKey, sealBackgroundKey } from '@flux/db';

// Run only with API/worker stopped and a database + old/new secret backup. The
// transaction either re-encrypts every live owner key or changes none of them.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const oldKey = loadBackgroundMasterKey();
const newKey = loadBackgroundMasterKey('/run/secrets/flux_background_key_next');
if (!oldKey || !newKey || oldKey.equals(newKey)) throw new Error('Distinct old and new 32-byte background secrets are required');
const { pool } = createDatabase(url);
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('LOCK TABLE background_compute_connections IN ACCESS EXCLUSIVE MODE');
  const rows = await client.query<{ id: string; owner_user_id: string; encrypted_key: string }>(
    'SELECT id, owner_user_id, encrypted_key FROM background_compute_connections WHERE revoked_at IS NULL ORDER BY id');
  for (const row of rows.rows) {
    const plain = openBackgroundKey(row.encrypted_key, row.owner_user_id, row.id, oldKey);
    const encrypted = sealBackgroundKey(plain, row.owner_user_id, row.id, newKey);
    await client.query('UPDATE background_compute_connections SET encrypted_key = $1 WHERE id = $2', [encrypted, row.id]);
  }
  await client.query('COMMIT');
  console.log(`Re-encrypted ${rows.rowCount ?? 0} active background connection(s)`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
