import { createDatabase, readTaskCreationReversalManifest, reverseUnusedTaskCreation } from '@flux/db';

const manifest = await readTaskCreationReversalManifest('packages/db/migrations');
if (process.argv.slice(2).some(argument => argument !== '--execute')) throw new Error('Only the explicit --execute option is supported');
if (!process.argv.includes('--execute')) {
  console.log(JSON.stringify({ current: manifest.current, prior: manifest.prior,
    currentSha256: manifest.currentSha256, priorSha256: manifest.priorSha256, down: manifest.down }, null, 2));
} else {
  if (process.env.FLUX_REVERSE_0048_QUIESCED !== 'true') throw new Error('FLUX_REVERSE_0048_QUIESCED=true is required after stopping API and worker');
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error('DATABASE_URL is required');
  const { pool } = createDatabase(connection);
  try {
    const client = await pool.connect();
    await reverseUnusedTaskCreation(client, manifest, { quiesced: true });
    console.log(`Reversed exactly0048; prior ledger ${manifest.priorSha256}. Start only its matching prior image.`);
  } finally { await pool.end(); }
}
