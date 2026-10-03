import {
  agentAccessOperations,
  githubRows,
  createDatabase,
  FLUX_SCHEMA_VERSION,
  readAppliedMigrationVersions,
  readMigrationManifest,
} from '@flux/db';

// Maintenance commands of ./flux backup, restore and upgrade (issue #123), run in the migrate
// container of the image being restored or started:
//   node tooling/dist/operations.js migration-files        FLUX_MIGRATIONS <versions of this image's SQL files>
//   node tooling/dist/operations.js migration-ledger       FLUX_MIGRATIONS <versions recorded in the database>
//   node tooling/dist/operations.js migration-gate <list> [--migrate]
//                                                        whether a backup ledger may be restored on this image
//   node tooling/dist/operations.js agent-access           prints active connections and refresh tokens
//   node tooling/dist/operations.js revoke-agent-access    revokes every agent connection and OAuth token
// The migration commands use the #118 ledger parser of @flux/db, the one the migrator trusts.

const migrationsDir = 'packages/db/migrations';
const [command, ...args] = process.argv.slice(2);
const list = (versions: readonly number[]) => versions.join(',');

function parseList(value: string | undefined): number[] {
  if (value === undefined || !/^(\d+(,\d+)*)?$/.test(value)) throw new Error(`invalid migration list "${value ?? ''}"`);
  return value ? value.split(',').map(Number) : [];
}

async function imageFiles() {
  return readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
}

/**
 * A backup's ledger may be restored on this image only if the migrator can make it exact:
 * every recorded version must have a file here (else the backup is from another line of
 * development and is refused, with or without --migrate); versions the backup lacks are applied
 * by the migrator, which the operator must request with --migrate.
 */
function gate(files: Awaited<ReturnType<typeof imageFiles>>, backup: readonly number[], migrate: boolean) {
  const known = new Set(files.map((file) => file.version));
  const recorded = new Set(backup);
  const foreign = backup.filter((version) => !known.has(version));
  const missing = files.filter((file) => !recorded.has(file.version));
  if (foreign.length) {
    return { ok: false, message: `the backup's migration ledger has versions without files in this image: ${foreign.join(', ')}. Restore it with the Flux version that wrote it.` };
  }
  if (missing.length && !migrate) {
    return { ok: false, message: `the backup lacks migrations of this image: ${missing.map((file) => file.name).join(', ')}. Pass --migrate to restore and apply them.` };
  }
  return { ok: true, message: missing.length ? `the backup lacks ${missing.length} migration(s) of this image; they are applied after the restore: ${missing.map((file) => file.name).join(', ')}` : `the backup's migration ledger matches this image exactly (${files.length} migrations)` };
}

if (command === 'migration-files') {
  console.log(`FLUX_MIGRATIONS ${list((await imageFiles()).map((file) => file.version))}`);
} else if (command === 'migration-gate') {
  const result = gate(await imageFiles(), parseList(args[0]), args.includes('--migrate'));
  console.log(`FLUX_MIGRATION_GATE ${result.ok ? 'ok' : 'refused'} ${result.message}`);
  process.exitCode = result.ok ? 0 : 3;
} else {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const { pool, db } = createDatabase(connectionString);
  try {
    if (command === 'migration-ledger') {
      console.log(`FLUX_MIGRATIONS ${list(await readAppliedMigrationVersions(pool))}`);
    } else if (command === 'agent-access') {
      const status = await agentAccessOperations(db).status();
      console.log(`FLUX_AGENT_ACCESS ${status.activeConnections} ${status.liveRefreshTokens}`);
    } else if (command === 'revoke-agent-access') {
      const revoked = await db.transaction((tx) => agentAccessOperations(tx).revokeAll());
      console.log(`Revoked ${revoked.connections} agent connection(s), ${revoked.refreshTokens} refresh token(s) and ${revoked.accessTokens} access token(s).`);
    } else if (command === 'revoke-github-access') {
      const revoked = await db.transaction((tx) => githubRows(tx).revokeRestored());
      console.log(`Revoked ${revoked.credentials} GitHub authorization(s) and ${revoked.bindings} GitHub binding(s); retained history is unavailable until reconnected.`);
    } else {
      throw new Error(`unknown operation ${command ?? ''} (use migration-files, migration-ledger, migration-gate, agent-access, revoke-agent-access or revoke-github-access)`);
    }
  } finally {
    await pool.end();
  }
}
