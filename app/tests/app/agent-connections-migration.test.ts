import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

test('0034 upgrades the prior schema without changing historic connection, proposal or singleton-selection records', async () => {
  const client = await pool.connect();
  const schema = `flux152_upgrade_${randomUUID().replaceAll('-', '')}`;
  const owner = randomUUID(); const workspace = randomUUID(); const project = randomUUID();
  const agent = randomUUID(); const connection = randomUUID(); const material = randomUUID(); const proposal = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
    const manifest = await readMigrationManifest('packages/db/migrations', FLUX_SCHEMA_VERSION);
    for (const file of manifest.filter((file) => file.version < 34)) {
      await client.query(await readFile(join('packages/db/migrations', file.name), 'utf8'));
    }
    await client.query("INSERT INTO auth_users (id,name,email) VALUES ($1,'Historic owner',$2)", [owner, `${owner}@example.test`]);
    await client.query("INSERT INTO workspaces (id,name,created_by) VALUES ($1,'Historic space',$2)", [workspace, owner]);
    await client.query("INSERT INTO projects (id,workspace_id,name,created_by) VALUES ($1,$2,'Historic project',$3)", [project, workspace, owner]);
    await client.query("INSERT INTO agents (id,workspace_id,name,owner_user_id,created_by) VALUES ($1,$2,'Historic agent',$3,$3)", [agent, workspace, owner]);
    await client.query("INSERT INTO agent_connections (id,workspace_id,owner_user_id,agent_id,scopes,created_at) VALUES ($1,$2,$3,$4,$5,'2026-09-01')",
      [connection, workspace, owner, agent, ['flux.context.read', 'flux.proposal.write']]);
    await client.query('INSERT INTO agent_connection_projects (workspace_id,connection_id,project_id) VALUES ($1,$2,$3)', [workspace, connection, project]);
    await client.query("INSERT INTO project_materials (id,workspace_id,project_id,created_by,client_mutation_id,request_fingerprint) VALUES ($1,$2,$3,$4,$5,'historic')",
      [material, workspace, project, owner, randomUUID()]);
    await client.query("INSERT INTO project_material_versions (workspace_id,project_id,material_id,version,title,author_id) VALUES ($1,$2,$3,1,'Historic source',$4)",
      [workspace, project, material, owner]);
    await client.query(`INSERT INTO agent_proposals (id,workspace_id,project_id,agent_id,owner_user_id,compute_source,agent_grant_id,
      agent_grant_role,source_material_id,source_material_version,client_command_id,request_fingerprint,fact,interpretation,suggested_action,created_at)
      VALUES ($1,$2,$3,$4,$5,'user_operated_claude_code',$6,'contributor',$7,1,$8,'receipt','Original fact','Original interpretation','Original suggestion','2026-09-02')`,
      [proposal, workspace, project, agent, owner, randomUUID(), material, randomUUID()]);
    const session = randomUUID();
    await client.query("INSERT INTO auth_sessions (id,user_id,token,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')", [session, owner, randomUUID()]);
    await client.query('INSERT INTO agent_oauth_selections (session_id,owner_user_id,connection_id) VALUES ($1,$2,$3)', [session, owner, connection]);
    const beforeConnection = (await client.query('SELECT * FROM agent_connections WHERE id=$1', [connection])).rows[0];
    const beforeProposal = (await client.query('SELECT * FROM agent_proposals WHERE id=$1', [proposal])).rows[0];
    const beforeSelection = (await client.query('SELECT * FROM agent_oauth_selections WHERE session_id=$1', [session])).rows[0];
    await client.query(await readFile('packages/db/migrations/0034_multiple_agent_connections.sql', 'utf8'));
    const after = (await client.query('SELECT * FROM agent_connections WHERE id=$1', [connection])).rows[0];
    const { name, client_designation, compute_source, ...historic } = after;
    assert.deepEqual(historic, beforeConnection);
    assert.equal(name, 'External connection'); assert.equal(client_designation, 'claude_code'); assert.equal(compute_source, 'user_operated_claude_code');
    assert.deepEqual((await client.query('SELECT * FROM agent_proposals WHERE id=$1', [proposal])).rows[0], beforeProposal);
    assert.deepEqual((await client.query('SELECT * FROM agent_oauth_selections WHERE session_id=$1', [session])).rows[0], beforeSelection);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM agent_oauth_bindings')).rows[0].count, 0, 'no guessed grant backfill');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM agent_oauth_flows')).rows[0].count, 0);
  } finally {
    await client.query('ROLLBACK'); client.release();
  }
});
