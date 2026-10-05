import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_OPERATIONS, AGENT_PEER_REQUEST_CLASSES } from '@flux/contracts';
import { assertExactMigrationLedger, assertMigrationSqlLedgerChange, assertMigrationStepLedger,
  FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

const migrationsDir = 'packages/db/migrations';
const UNIT_COLUMNS = `id,workspace_id,project_id,work_id,lineage_work_id,run_id,unit_key,role,assignment_connection_id,state,generation,
  version,lease_id,lease_session_id,lease_expires_at,checkpoint_id,created_at,updated_at`;

test('0054 adds exactly unit completion/transfer to the grant CHECK and a guarded outcome column: rows survive and it is idempotent', async () => {
  const client = await pool.connect();
  const schema = `flux153_transitions_${randomUUID().replaceAll('-', '')}`;
  const owner = randomUUID(); const workspace = randomUUID(); const project = randomUUID(); const agent = randomUUID(); const connection = randomUUID();
  const task = randomUUID(); const pending = randomUUID(); const completed = randomUUID(); const historicGrant = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
    const manifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
    const migration = manifest.find((file) => file.version === 54);
    assert.equal(migration?.name, '0054_cowork_unit_transitions.sql');
    const upToCurrent = manifest.filter((file) => file.version <= 54);
    // The migrator owns ledger rows for files that do not self-record, so replay exactly its apply loop.
    for (const file of upToCurrent.filter((file) => file.version < 54)) {
      await client.query(await readFile(join(migrationsDir, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    const before = await readAppliedMigrationVersions(client);
    assert.deepEqual(before, upToCurrent.filter((file) => file.version < 54).map((file) => file.version), 'the current ledger before 0054');
    assert.throws(() => assertExactMigrationLedger(upToCurrent, before), /0054_cowork_unit_transitions\.sql/, 'the migrator must apply 0054 before Flux starts');

    await client.query("INSERT INTO auth_users (id,name,email) VALUES ($1,'Transition owner',$2)", [owner, `${owner}@example.test`]);
    await client.query("INSERT INTO workspaces (id,name,created_by) VALUES ($1,'Transition space',$2)", [workspace, owner]);
    await client.query("INSERT INTO projects (id,workspace_id,name,created_by) VALUES ($1,$2,'Transition project',$3)", [project, workspace, owner]);
    await client.query("INSERT INTO agents (id,workspace_id,name,owner_user_id,created_by) VALUES ($1,$2,'Transition agent',$3,$3)", [agent, workspace, owner]);
    await client.query("INSERT INTO agent_connections (id,workspace_id,owner_user_id,agent_id,scopes) VALUES ($1,$2,$3,$4,$5)",
      [connection, workspace, owner, agent, ['flux.context.read', 'flux.action.execute']]);
    await client.query('INSERT INTO agent_connection_projects (workspace_id,connection_id,project_id) VALUES ($1,$2,$3)', [workspace, connection, project]);
    await client.query(`INSERT INTO project_work_items (id,workspace_id,project_id,title,created_by_kind,created_by_id)
      VALUES ($1,$2,$3,'Transition task','human',$4)`, [task, workspace, project, owner]);
    for (const [id, key, state] of [[pending, 'pending-unit', 'pending'], [completed, 'completed-unit', 'completed']] as const)
      await client.query(`INSERT INTO cowork_units (id,workspace_id,project_id,work_id,lineage_work_id,run_id,unit_key,role,
        assignment_connection_id,state) VALUES ($1,$2,$3,$4,$4,$5,$6,'execute',$7,$8)`, [id, workspace, project, task, randomUUID(), key, connection, state]);
    const insert = (id: string, operation: string, peerRequestClass = 'execute') => client.query(
      `INSERT INTO agent_standing_grants (id,workspace_id,project_id,connection_id,owner_user_id,client_command_id,request_fingerprint,
        operation,peer_request_class,maximum_uses,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,3,now()+interval '1 hour')`,
      [id, workspace, project, connection, owner, randomUUID(), 'a'.repeat(64), operation, peerRequestClass]);
    // A failed statement aborts the surrounding transaction unless it is isolated by a savepoint.
    const refused = async (statement: () => Promise<unknown>) => {
      await client.query('SAVEPOINT refused');
      try { await statement(); } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT refused');
        return error as { code?: string; constraint?: string };
      }
      throw new Error('The statement was accepted');
    };
    const constraint = async (table: string, name: string) => (await client.query(
      'SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2', [table, name])).rows;
    const listed = (definition: string) => [...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1]).sort();
    const outcomeColumn = async () => (await client.query(`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='cowork_units' AND column_name='outcome_ref'`, [schema])).rows;
    const units = async () => (await client.query(`SELECT ${UNIT_COLUMNS} FROM cowork_units WHERE workspace_id=$1 ORDER BY id`, [workspace])).rows;

    // Before: neither operation nor the outcome column exists (the failing-before observation).
    for (const operation of ['cowork.unit.complete', 'cowork.unit.transfer']) {
      const rejected = await refused(() => insert(randomUUID(), operation));
      assert.equal(rejected.code, '23514'); assert.equal(rejected.constraint, 'agent_standing_grants_operation_check');
    }
    assert.deepEqual(await outcomeColumn(), []);
    const prior = listed((await constraint('agent_standing_grants', 'agent_standing_grants_operation_check'))[0]!.definition as string);
    await insert(historicGrant, 'cowork.unit.create', 'review');
    const historic = (await client.query('SELECT * FROM agent_standing_grants WHERE id=$1', [historicGrant])).rows[0];
    const unitsBefore = await units();

    // Apply exactly as tooling/migrate.ts does, including its ledger checks.
    const sql = await readFile(join(migrationsDir, migration!.name), 'utf8');
    await client.query(sql);
    const afterSql = await readAppliedMigrationVersions(client);
    assertMigrationSqlLedgerChange(before, afterSql, migration!);
    await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [migration!.version]);
    const after = await readAppliedMigrationVersions(client);
    assertMigrationStepLedger(before, after, migration!);
    assertExactMigrationLedger(upToCurrent, after);

    // After: rows are untouched; the database list is exactly the contract list, i.e. the prior list plus the two operations.
    assert.deepEqual((await client.query('SELECT * FROM agent_standing_grants WHERE id=$1', [historicGrant])).rows[0], historic);
    const definition = (await constraint('agent_standing_grants', 'agent_standing_grants_operation_check'))[0]!.definition as string;
    assert.deepEqual(listed(definition), [...AGENT_OPERATIONS].sort());
    assert.deepEqual(listed(definition), [...prior, 'cowork.unit.complete', 'cowork.unit.transfer'].sort());
    for (const operation of AGENT_OPERATIONS) for (const peerRequestClass of AGENT_PEER_REQUEST_CLASSES) await insert(randomUUID(), operation, peerRequestClass);
    for (const operation of ['cowork.unit.finish', 'cowork.complete', 'cowork.unit.reassign', 'COWORK.UNIT.COMPLETE', 'cowork.unit.transfer ', '']) {
      const error = await refused(() => insert(randomUUID(), operation));
      assert.equal(error.code, '23514', `${JSON.stringify(operation)} stays refused`); assert.equal(error.constraint, 'agent_standing_grants_operation_check');
    }

    // Existing units keep every original column and gain no inferred outcome, even one already stored as completed.
    assert.deepEqual(await outcomeColumn(), [{ data_type: 'jsonb', is_nullable: 'YES' }]);
    assert.deepEqual(await units(), unitsBefore);
    assert.deepEqual((await client.query('SELECT outcome_ref FROM cowork_units WHERE workspace_id=$1', [workspace])).rows,
      [{ outcome_ref: null }, { outcome_ref: null }]);
    // The outcome is one bounded native reference and only on a completed unit.
    const outcome = (ref: unknown, id: string) => client.query('UPDATE cowork_units SET outcome_ref=$1::jsonb WHERE id=$2', [JSON.stringify(ref), id]);
    for (const [ref, id, label] of [[{ type: 'result', id: randomUUID() }, pending, 'a pending unit'],
      [{ type: 'github_pr', bindingId: randomUUID(), linkId: randomUUID(), headSha: 'a'.repeat(40) }, completed, 'a GitHub reference'],
      [[{ type: 'result', id: randomUUID() }], completed, 'an array'], [{ type: 'result', id: 'x'.repeat(1100) }, completed, 'an oversized reference']] as const) {
      const error = await refused(() => outcome(ref, id));
      assert.equal(error.code, '23514', `${label} is refused`); assert.equal(error.constraint, 'cowork_units_outcome_check');
    }
    const result = { type: 'result', id: randomUUID() };
    await outcome(result, completed);
    assert.deepEqual((await client.query('SELECT outcome_ref FROM cowork_units WHERE id=$1', [completed])).rows[0].outcome_ref, result);
    const reopened = await refused(() => client.query("UPDATE cowork_units SET state='paused' WHERE id=$1", [completed]));
    assert.equal(reopened.code, '23514', 'a unit with an outcome stays completed'); assert.equal(reopened.constraint, 'cowork_units_outcome_check');

    // Idempotent: a second application keeps both definitions, the column and every row.
    const count = async () => (await client.query('SELECT count(*)::int AS n FROM agent_standing_grants')).rows[0].n as number;
    const rows = await count();
    const outcomeDefinition = (await constraint('cowork_units', 'cowork_units_outcome_check'))[0]!.definition as string;
    const stored = await client.query(`SELECT ${UNIT_COLUMNS}, outcome_ref FROM cowork_units WHERE workspace_id=$1 ORDER BY id`, [workspace]);
    await client.query(sql);
    assert.equal((await constraint('agent_standing_grants', 'agent_standing_grants_operation_check'))[0]!.definition, definition);
    assert.equal((await constraint('cowork_units', 'cowork_units_outcome_check'))[0]!.definition, outcomeDefinition);
    assert.equal(await count(), rows);
    assert.deepEqual((await client.query(`SELECT ${UNIT_COLUMNS}, outcome_ref FROM cowork_units WHERE workspace_id=$1 ORDER BY id`, [workspace])).rows,
      stored.rows);
    assert.deepEqual(await readAppliedMigrationVersions(client), after, 'the SQL records no ledger version itself');
  } finally {
    await client.query('ROLLBACK'); client.release();
  }
});
