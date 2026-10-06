import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_OPERATIONS, AGENT_PEER_REQUEST_CLASSES, type AgentOperation } from '@flux/contracts';
import { assertExactMigrationLedger, assertMigrationSqlLedgerChange, assertMigrationStepLedger,
  FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

const migrationsDir = 'packages/db/migrations';
/** Exactly the list 0050 writes. Later migrations (0054) widen it; 0050 itself stays frozen. */
const OPERATIONS_AT_0050: readonly AgentOperation[] = ['work.create', 'work.update', 'result.record', 'decision.propose',
  'map.create', 'map.rename', 'map.thought.create', 'map.thought.update', 'map.thought.delete', 'map.positions.update',
  'map.link.create', 'map.link.delete', 'doc.create', 'doc.update', 'conversation.create', 'conversation.reply',
  'cowork.claim', 'cowork.renew', 'cowork.release', 'cowork.request', 'cowork.request.claim', 'cowork.request.respond',
  'cowork.unit.create'];

test('0050 widens only the closed grant operation CHECK to unit creation: rows survive and it is idempotent', async () => {
  const client = await pool.connect();
  const schema = `flux153_units_${randomUUID().replaceAll('-', '')}`;
  const owner = randomUUID(); const workspace = randomUUID(); const project = randomUUID(); const agent = randomUUID(); const connection = randomUUID();
  const historicGrant = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
    const manifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
    const migration = manifest.find((file) => file.version === 50);
    assert.equal(migration?.name, '0050_cowork_unit_creation.sql');
    const upToCurrent = manifest.filter((file) => file.version <= 50);
    // The migrator owns ledger rows for files that do not self-record, so replay exactly its apply loop.
    for (const file of upToCurrent.filter((file) => file.version < 50)) {
      await client.query(await readFile(join(migrationsDir, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    const before = await readAppliedMigrationVersions(client);
    assert.deepEqual(before, upToCurrent.filter((file) => file.version < 50).map((file) => file.version), 'the current ledger before 0050');
    assert.throws(() => assertExactMigrationLedger(upToCurrent, before), /0050_cowork_unit_creation\.sql/, 'the migrator must apply 0050 before Flux starts');

    await client.query("INSERT INTO auth_users (id,name,email) VALUES ($1,'Unit owner',$2)", [owner, `${owner}@example.test`]);
    await client.query("INSERT INTO workspaces (id,name,created_by) VALUES ($1,'Unit space',$2)", [workspace, owner]);
    await client.query("INSERT INTO projects (id,workspace_id,name,created_by) VALUES ($1,$2,'Unit project',$3)", [project, workspace, owner]);
    await client.query("INSERT INTO agents (id,workspace_id,name,owner_user_id,created_by) VALUES ($1,$2,'Unit agent',$3,$3)", [agent, workspace, owner]);
    await client.query("INSERT INTO agent_connections (id,workspace_id,owner_user_id,agent_id,scopes) VALUES ($1,$2,$3,$4,$5)",
      [connection, workspace, owner, agent, ['flux.context.read', 'flux.action.execute']]);
    await client.query('INSERT INTO agent_connection_projects (workspace_id,connection_id,project_id) VALUES ($1,$2,$3)', [workspace, connection, project]);
    const insert = (id: string, operation: string, peerRequestClass = 'review') => client.query(
      `INSERT INTO agent_standing_grants (id,workspace_id,project_id,connection_id,owner_user_id,client_command_id,request_fingerprint,
        operation,peer_request_class,maximum_uses,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,3,now()+interval '1 hour')`,
      [id, workspace, project, connection, owner, randomUUID(), 'a'.repeat(64), operation, peerRequestClass]);
    // A failed statement aborts the surrounding transaction unless it is isolated by a savepoint.
    const refused = async (operation: string) => {
      await client.query('SAVEPOINT refused');
      try { await insert(randomUUID(), operation); } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT refused');
        return error as { code?: string; constraint?: string };
      }
      throw new Error(`${operation} was accepted`);
    };
    const constraint = async () => (await client.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='agent_standing_grants'::regclass AND conname='agent_standing_grants_operation_check'")).rows;
    const listed = (definition: string) => [...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1]).sort();

    // Before: the 0049 list does not know unit creation (the failing-before observation).
    const rejected = await refused('cowork.unit.create');
    assert.equal(rejected.code, '23514'); assert.equal(rejected.constraint, 'agent_standing_grants_operation_check');
    const prior = listed((await constraint())[0]!.definition as string);
    await insert(historicGrant, 'cowork.request.claim', 'review');
    const historic = (await client.query('SELECT * FROM agent_standing_grants WHERE id=$1', [historicGrant])).rows[0];

    // Apply exactly as tooling/migrate.ts does, including its ledger checks.
    const sql = await readFile(join(migrationsDir, migration!.name), 'utf8');
    await client.query(sql);
    const afterSql = await readAppliedMigrationVersions(client);
    assertMigrationSqlLedgerChange(before, afterSql, migration!);
    await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [migration!.version]);
    const after = await readAppliedMigrationVersions(client);
    assertMigrationStepLedger(before, after, migration!);
    assertExactMigrationLedger(upToCurrent, after);

    // After: rows are untouched; the database list is exactly the 0050 list, i.e. the prior list plus unit creation.
    // The exact contract-list equality now lives in the 0054 test.
    assert.deepEqual((await client.query('SELECT * FROM agent_standing_grants WHERE id=$1', [historicGrant])).rows[0], historic);
    const definition = (await constraint())[0]!.definition as string;
    assert.deepEqual(listed(definition), [...OPERATIONS_AT_0050].sort());
    assert.deepEqual(listed(definition), [...prior, 'cowork.unit.create'].sort());
    assert.ok(OPERATIONS_AT_0050.every((operation) => AGENT_OPERATIONS.includes(operation)), 'every 0050 operation is still a contract operation');
    for (const operation of OPERATIONS_AT_0050) for (const peerRequestClass of AGENT_PEER_REQUEST_CLASSES) await insert(randomUUID(), operation, peerRequestClass);
    for (const operation of ['cowork.unit', 'cowork.units.create', 'cowork.unit.assign', 'cowork.unit.transfer', 'COWORK.UNIT.CREATE', 'cowork.unit.create ', '']) {
      const error = await refused(operation);
      assert.equal(error.code, '23514', `${JSON.stringify(operation)} stays refused`); assert.equal(error.constraint, 'agent_standing_grants_operation_check');
    }

    // Idempotent: a second application keeps the same definition and every row.
    const count = async () => (await client.query('SELECT count(*)::int AS n FROM agent_standing_grants')).rows[0].n as number;
    const rows = await count();
    await client.query(sql);
    assert.equal((await constraint())[0]!.definition, definition); assert.equal(await count(), rows);
    assert.deepEqual(await readAppliedMigrationVersions(client), after, 'the SQL records no ledger version itself');
  } finally {
    await client.query('ROLLBACK'); client.release();
  }
});
