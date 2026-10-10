import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { PERSONAL_RUN_CONSENT_VERSION } from '@flux/contracts';
import { assertAssistantMigrationCompatibility, FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

const directory = 'packages/db/migrations';

test('0077 fresh/upgrade/reverse preserves legacy identity, grants and consent while adding read-only assistant authority', async () => {
  const client = await pool.connect(); const namespace = `assistant_migration_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA ${namespace}`);
    await client.query(`SET LOCAL search_path TO ${namespace}, pg_catalog`);
    const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
    for (const file of manifest.filter((file) => file.version !== 77)) {
      await client.query(await readFile(join(directory, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    const owner = randomUUID(); const ws = randomUUID(); const agent = randomUUID(); const allowed = randomUUID(); const notJoined = randomUUID();
    await client.query("INSERT INTO auth_users(id,name,email) VALUES($1,'Legacy assistant owner',$2)", [owner, `${owner}@example.test`]);
    await client.query("INSERT INTO workspaces(id,name,created_by) VALUES($1,'Legacy workspace',$2)", [ws, owner]);
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role,created_by) VALUES($1,$2,'owner',$2)", [ws, owner]);
    await client.query("INSERT INTO agents(id,workspace_id,name,owner_user_id,created_by) VALUES($1,$2,'Legacy agent',$3,$3)", [agent, ws, owner]);
    for (const id of [allowed, notJoined]) await client.query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,'Legacy project','workspace',$3)", [id, ws, owner]);
    await client.query("INSERT INTO project_grants(id,workspace_id,project_id,agent_id,role,created_by) VALUES($1,$2,$3,$4,'contributor',$5)", [randomUUID(),ws,allowed,agent,owner]);
    await client.query(`INSERT INTO personal_run_enablements(owner_user_id,connection_id,consent_version,consent_provider,consent_model,
      consent_payer_organization,consent_payer_workspace,per_run_cents,daily_cap_cents,time_zone)
      VALUES($1,$2,$3,'anthropic','fixture-model','Legacy payer','Legacy payer workspace',20,100,'UTC')`, [owner,randomUUID(),PERSONAL_RUN_CONSENT_VERSION]);
    await client.query('INSERT INTO personal_run_agents(owner_user_id,workspace_id,agent_id) VALUES($1,$2,$3)', [owner,ws,agent]);
    const external = randomUUID();
    await client.query("INSERT INTO agent_connections(id,workspace_id,owner_user_id,agent_id,name,compute_source,scopes) VALUES($1,$2,$3,$4,'Retained external','user_operated_external_client',ARRAY['flux.context.read']::text[])", [external,ws,owner,agent]);
    const ordinary = (await client.query('SELECT * FROM agent_connections WHERE id=$1', [external])).rows[0];
    const before = {
      enablement: (await client.query('SELECT * FROM personal_run_enablements')).rows,
      agents: (await client.query('SELECT * FROM personal_run_agents')).rows,
      grants: (await client.query('SELECT * FROM project_grants')).rows,
    };
    const applied = manifest.filter((file) => file.version !== 77).map((file) => file.version);
    await assertAssistantMigrationCompatibility(client, applied);
    await client.query(await readFile(join(directory, '0077_assistant_settings.sql'), 'utf8'));
    await assert.rejects(assertAssistantMigrationCompatibility(client, applied), /assistant tables exist without reserved ledger version 77/);
    await client.query('INSERT INTO flux_schema_version(version) VALUES(77)');
    await assertAssistantMigrationCompatibility(client, [...applied,77]);
    const identity = (await client.query('SELECT * FROM assistant_settings WHERE owner_user_id=$1', [owner])).rows[0];
    assert.equal(identity.agent_id, agent); assert.equal(identity.approval_mode, 'act');
    assert.equal(identity.changes_per_run, 20); assert.equal(identity.background_runs_per_day, 24);
    const policy = (await client.query('SELECT * FROM agent_connection_mcp_policies WHERE connection_id=$1', [identity.connection_id])).rows[0];
    assert.ok(policy.enabled_capability_ids.every((id: string) => id.endsWith('.read')), 'legacy upgrade never adds an effect capability');
    assert.ok(!policy.enabled_entry_ids.includes('tool:flux_bootstrap'));
    assert.deepEqual((await client.query('SELECT project_id FROM agent_connection_projects WHERE connection_id=$1', [identity.connection_id])).rows, [{ project_id: allowed }]);
    assert.deepEqual((await client.query('SELECT * FROM agent_connections WHERE id=$1', [external])).rows[0], ordinary);
    assert.deepEqual((await client.query('SELECT * FROM personal_run_enablements')).rows, before.enablement);
    assert.deepEqual((await client.query('SELECT * FROM personal_run_agents')).rows, before.agents);
    assert.deepEqual((await client.query('SELECT * FROM project_grants')).rows, before.grants, 'upgrade creates no manager-owned project grant');
    await client.query('SAVEPOINT invalid_settings');
    await assert.rejects(client.query('UPDATE assistant_settings SET changes_per_run=21'), /assistant_settings_changes_per_run_check/);
    await client.query('ROLLBACK TO SAVEPOINT invalid_settings');
    await client.query(await readFile(join(directory, 'reverse/0077_assistant_settings.down.sql'), 'utf8'));
    await client.query('DELETE FROM flux_schema_version WHERE version=77');
    assert.equal((await client.query("SELECT 1 FROM agent_connections WHERE compute_source='user_operated_external_client'")).rowCount, 1);
    assert.deepEqual((await client.query('SELECT * FROM agent_connections WHERE id=$1', [external])).rows[0], ordinary);
    assert.deepEqual((await client.query('SELECT * FROM personal_run_enablements')).rows, before.enablement);
    assert.deepEqual((await client.query('SELECT * FROM project_grants')).rows, before.grants);
    await assertAssistantMigrationCompatibility(client, applied);
    // A fresh schema with no enablement gets no manufactured assistant on re-apply.
    await client.query('DELETE FROM personal_run_agents'); await client.query('DELETE FROM personal_run_enablements');
    await client.query(await readFile(join(directory, '0077_assistant_settings.sql'), 'utf8'));
    assert.equal((await client.query('SELECT * FROM assistant_settings')).rowCount, 0);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('the reserved assistant footprint refuses an unrelated/incomplete 0077 marker without changing rows', async () => {
  const client = await pool.connect(); const namespace = `assistant_footprint_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA ${namespace}`); await client.query(`SET LOCAL search_path TO ${namespace}, pg_catalog`);
    await assertAssistantMigrationCompatibility(client, []);
    await client.query('CREATE TABLE assistant_settings(owner_user_id text PRIMARY KEY, private_note text)');
    await client.query("INSERT INTO assistant_settings VALUES('retained-owner','retained data')");
    const before = (await client.query('SELECT * FROM assistant_settings')).rows;
    await assert.rejects(assertAssistantMigrationCompatibility(client, []), /without reserved ledger version 77/);
    await assert.rejects(assertAssistantMigrationCompatibility(client, [77]), /assistant footprint is incomplete/);
    assert.deepEqual((await client.query('SELECT * FROM assistant_settings')).rows, before);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
