import { createDatabase, FLUX_SCHEMA_VERSION, readTaskCreationReversalPlan, reverseUnusedTaskCreation } from '@flux/db';

// Guarded pre-use reversal of #238 (0060, then 0048) for a return to the matching prior image. Without --execute it
// prints the plan. See docs/development/task-creation-undo/README.md#reversal.
const plan = await readTaskCreationReversalPlan('packages/db/migrations', FLUX_SCHEMA_VERSION);
if (process.argv.slice(2).some((argument) => argument !== '--execute')) throw new Error('Only the explicit --execute option is supported');
if (!process.argv.includes('--execute')) {
  console.log(JSON.stringify({ reverse: plan.downs.map((down) => down.name), priorLedger: plan.prior.map((file) => file.version) }, null, 2));
} else {
  if (process.env.FLUX_REVERSE_0048_QUIESCED !== 'true') throw new Error('Set FLUX_REVERSE_0048_QUIESCED=true after stopping the API and worker');
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new Error('DATABASE_URL is required');
  const { pool } = createDatabase(connection);
  try {
    const client = await pool.connect();
    await reverseUnusedTaskCreation(client, plan, { quiesced: true });
    console.log(`Reversed 0060 and 0048. The ledger is now ${plan.prior.at(-1)?.version ?? 'empty'}-based; start only the matching prior image.`);
  } finally { await pool.end(); }
}
