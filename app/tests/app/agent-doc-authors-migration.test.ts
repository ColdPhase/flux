import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AGENT_OPERATIONS } from '@flux/contracts';
import { assertExactMigrationLedger, assertMigrationSqlLedgerChange, assertMigrationStepLedger, createDatabase,
  FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';

// 0043 (#152): agent-written docs and the doc/conversation standing-grant operations. The previous ledger (last file
// 0041; 0042 is left to an open branch) upgrades in place, every material, doc, version, search row and grant survives
// byte for byte, only docs can name an agent author, and the SQL is re-runnable.
const migrationsDir = 'packages/db/migrations';
const { pool } = createDatabase(process.env.DATABASE_URL!);
after(() => pool.end());

test('0043 lets only docs name a genuine agent author, keeps every historical row exact, widens only the operation list and re-runs cleanly', async () => {
  const client = await pool.connect();
  const schema = `flux152_docs_${randomUUID().replaceAll('-', '')}`;
  const owner = randomUUID(); const workspace = randomUUID(); const otherWorkspace = randomUUID(); const project = randomUUID();
  const agent = randomUUID(); const foreignAgent = randomUUID(); const connection = randomUUID();
  const material = randomUUID(); const doc = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
    const manifest = await readMigrationManifest(migrationsDir, FLUX_SCHEMA_VERSION);
    const migration = manifest.find((file) => file.version === 43);
    assert.equal(migration?.name, '0043_agent_doc_authors.sql');
    const upToCurrent = manifest.filter((file) => file.version <= 43);
    for (const file of upToCurrent.filter((file) => file.version < 43)) {
      await client.query(await readFile(join(migrationsDir, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    const before = await readAppliedMigrationVersions(client);
    assert.equal(before.at(-1), 41, 'the previous ledger ends at 0041');
    assert.throws(() => assertExactMigrationLedger(upToCurrent, before), /0043_agent_doc_authors\.sql/, 'the migrator must apply 0043 before Flux starts');

    // History written under the previous schema: a person's material and doc, with their search rows, and a grant.
    await client.query("INSERT INTO auth_users (id,name,email) VALUES ($1,'Doc owner',$2)", [owner, `${owner}@example.test`]);
    await client.query("INSERT INTO workspaces (id,name,created_by) VALUES ($1,'Doc space',$3), ($2,'Other space',$3)", [workspace, otherWorkspace, owner]);
    await client.query("INSERT INTO projects (id,workspace_id,name,created_by) VALUES ($1,$2,'Doc project',$3)", [project, workspace, owner]);
    await client.query("INSERT INTO agents (id,workspace_id,name,owner_user_id,created_by) VALUES ($1,$2,'Doc agent',$4,$4), ($3,$5,'Foreign agent',$4,$4)",
      [agent, workspace, foreignAgent, owner, otherWorkspace]);
    await client.query(`INSERT INTO project_materials (id,workspace_id,project_id,created_by,client_mutation_id,request_fingerprint,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'2026-01-02T03:04:05Z','2026-01-02T03:04:05Z')`, [material, workspace, project, owner, randomUUID(), 'c'.repeat(64)]);
    await client.query(`INSERT INTO project_material_versions (workspace_id,project_id,material_id,version,title,body,author_id,created_at)
      VALUES ($1,$2,$3,1,'Old source','Body',$4,'2026-01-02T03:04:05Z')`, [workspace, project, material, owner]);
    await client.query(`INSERT INTO project_materials (id,workspace_id,project_id,created_by,kind,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'doc','2026-01-03T03:04:05Z','2026-01-03T03:04:05Z')`, [doc, workspace, project, owner]);
    await client.query(`INSERT INTO project_material_versions (workspace_id,project_id,material_id,version,title,body,author_id,state,reason,created_at)
      VALUES ($1,$2,$3,1,'Old doc','Text',$4,'published','Started the doc','2026-01-03T03:04:05Z')`, [workspace, project, doc, owner]);
    await client.query("INSERT INTO agent_connections (id,workspace_id,owner_user_id,agent_id,scopes) VALUES ($1,$2,$3,$4,$5)",
      [connection, workspace, owner, agent, ['flux.context.read', 'flux.action.execute']]);
    await client.query('INSERT INTO agent_connection_projects (workspace_id,connection_id,project_id) VALUES ($1,$2,$3)', [workspace, connection, project]);
    const grant = (operation: string) => client.query(
      `INSERT INTO agent_standing_grants (id,workspace_id,project_id,connection_id,owner_user_id,client_command_id,request_fingerprint,
        operation,peer_request_class,maximum_uses,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'plan',3,now()+interval '1 hour')`,
      [randomUUID(), workspace, project, connection, owner, randomUUID(), 'a'.repeat(64), operation]);
    await grant('map.create');
    const snapshot = async () => ({
      materials: (await client.query('SELECT * FROM project_materials ORDER BY id')).rows,
      versions: (await client.query('SELECT * FROM project_material_versions ORDER BY material_id, version')).rows,
      search: (await client.query("SELECT doc_key, kind, author_kind, author_id, title, body, at FROM search_documents WHERE doc_key LIKE 'material:%' ORDER BY doc_key")).rows,
      grants: (await client.query('SELECT * FROM agent_standing_grants ORDER BY id')).rows,
    });
    const old = await snapshot();
    assert.deepEqual(new Set(old.search.map((row) => `${row.kind}:${row.author_kind}:${row.author_id}`)), new Set([`material:human:${owner}`, `doc:human:${owner}`]));
    // A failed statement aborts the surrounding transaction unless it is isolated by a savepoint.
    const refused = async (sql: string, values: unknown[]) => {
      await client.query('SAVEPOINT refused');
      try { await client.query(sql, values); } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT refused');
        return error as { code?: string; constraint?: string };
      }
      throw new Error(`accepted: ${sql}`);
    };
    const agentVersion = (materialId: string, version: number, state: string | null, authorId: string | null,
      agentId: string | null): [string, unknown[]] => [
      `INSERT INTO project_material_versions (workspace_id,project_id,material_id,version,title,body,author_id,author_agent_id,state)
        VALUES ($1,$2,$3,$4,'Agent text','Body',$5,$6,$7)`, [workspace, project, materialId, version, authorId, agentId, state]];
    // Before: the previous schema has no agent author column and refuses the new operations.
    assert.equal((await refused('INSERT INTO project_material_versions (workspace_id,project_id,material_id,version,title,body,author_agent_id,state) VALUES ($1,$2,$3,2,$4,$5,$6,$7)',
      [workspace, project, doc, 't', 'b', agent, 'draft'])).code, '42703');
    for (const operation of ['doc.create', 'doc.update', 'conversation.create', 'conversation.reply'])
      assert.equal((await refused(`INSERT INTO agent_standing_grants (id,workspace_id,project_id,connection_id,owner_user_id,client_command_id,request_fingerprint,
        operation,peer_request_class,maximum_uses,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'plan',3,now()+interval '1 hour')`,
      [randomUUID(), workspace, project, connection, owner, randomUUID(), 'a'.repeat(64), operation])).constraint, 'agent_standing_grants_operation_check');

    // Apply exactly as tooling/migrate.ts does, including its ledger checks.
    const sql = await readFile(join(migrationsDir, migration!.name), 'utf8');
    await client.query(sql);
    const afterSql = await readAppliedMigrationVersions(client);
    assertMigrationSqlLedgerChange(before, afterSql, migration!);
    await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [migration!.version]);
    const after = await readAppliedMigrationVersions(client);
    assertMigrationStepLedger(before, after, migration!);
    assertExactMigrationLedger(upToCurrent, after);
    const withoutNewColumns = (rows: Record<string, unknown>[], column: string) => rows.map((row) => {
      assert.equal(row[column], null, `${column} is not backfilled`);
      return Object.fromEntries(Object.entries(row).filter(([key]) => key !== column));
    });
    const now = await snapshot();
    assert.deepEqual(withoutNewColumns(now.materials, 'created_by_agent_id'), old.materials, 'materials keep their human author and times');
    assert.deepEqual(withoutNewColumns(now.versions, 'author_agent_id'), old.versions, 'versions keep their human author and times');
    assert.deepEqual([now.search, now.grants], [old.search, old.grants], 'search rows and grants are untouched');

    // After: an agent of the same workspace can write a doc version, indexed with its real actor.
    const [insertAgentVersion, agentValues] = agentVersion(doc, 2, 'published', null, agent);
    await client.query(insertAgentVersion, agentValues);
    assert.deepEqual((await client.query('SELECT author_kind, author_id FROM search_documents WHERE doc_key=$1', [`material:${doc}:2`])).rows,
      [{ author_kind: 'agent', author_id: agent }]);
    const agentDoc = randomUUID();
    await client.query("INSERT INTO project_materials (id,workspace_id,project_id,created_by_agent_id,kind) VALUES ($1,$2,$3,$4,'doc')", [agentDoc, workspace, project, agent]);
    // Never on a plain material, never both or neither actor, never an agent of another workspace.
    assert.equal((await refused(...agentVersion(material, 2, null, null, agent))).constraint, 'project_material_version_agent_doc');
    assert.equal((await refused(...agentVersion(doc, 3, 'draft', owner, agent))).constraint, 'project_material_version_exact_actor');
    assert.equal((await refused(...agentVersion(doc, 3, 'draft', null, null))).constraint, 'project_material_version_exact_actor');
    assert.equal((await refused(...agentVersion(doc, 3, 'draft', null, foreignAgent))).constraint, 'project_material_version_agent_workspace');
    assert.equal((await refused("INSERT INTO project_materials (id,workspace_id,project_id,created_by_agent_id,client_mutation_id,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6)",
      [randomUUID(), workspace, project, agent, randomUUID(), 'd'.repeat(64)])).constraint, 'project_material_agent_doc');
    assert.equal((await refused("INSERT INTO project_materials (id,workspace_id,project_id,created_by,created_by_agent_id,kind) VALUES ($1,$2,$3,$4,$5,'doc')",
      [randomUUID(), workspace, project, owner, agent])).constraint, 'project_material_exact_actor');
    assert.equal((await refused("INSERT INTO project_materials (id,workspace_id,project_id,created_by_agent_id,kind) VALUES ($1,$2,$3,$4,'doc')",
      [randomUUID(), workspace, project, foreignAgent])).constraint, 'project_material_agent_workspace');
    // Versions stay immutable.
    assert.equal((await refused('UPDATE project_material_versions SET author_agent_id=$1 WHERE material_id=$2 AND version=1', [agent, doc])).code, '23514');

    // The operation list is exactly the contract list: the four new commands and nothing else.
    for (const operation of ['doc.create', 'doc.update', 'conversation.create', 'conversation.reply']) await grant(operation);
    for (const operation of ['doc.publish', 'doc.*', 'conversation.dm', 'message.post', 'DOC.CREATE', ''])
      assert.equal((await refused(`INSERT INTO agent_standing_grants (id,workspace_id,project_id,connection_id,owner_user_id,client_command_id,request_fingerprint,
        operation,peer_request_class,maximum_uses,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'plan',3,now()+interval '1 hour')`,
      [randomUUID(), workspace, project, connection, owner, randomUUID(), 'a'.repeat(64), operation])).constraint, 'agent_standing_grants_operation_check', operation);
    const definition = (await client.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='agent_standing_grants'::regclass AND conname='agent_standing_grants_operation_check'")).rows[0].definition as string;
    assert.deepEqual([...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1]).sort(), [...AGENT_OPERATIONS].sort());

    // Idempotent: a second application keeps every row, constraint and the ledger.
    const counts = async () => (await client.query(`SELECT (SELECT count(*)::int FROM project_materials) AS m, (SELECT count(*)::int FROM project_material_versions) AS v,
      (SELECT count(*)::int FROM agent_standing_grants) AS g, (SELECT count(*)::int FROM pg_constraint WHERE conrelid IN
        ('project_materials'::regclass, 'project_material_versions'::regclass)) AS c`)).rows[0];
    const once = await counts();
    await client.query(sql);
    assert.deepEqual(await counts(), once);
    assert.deepEqual(await readAppliedMigrationVersions(client), after, 'the SQL records no ledger version itself');
  } finally {
    await client.query('ROLLBACK'); client.release();
  }
});
