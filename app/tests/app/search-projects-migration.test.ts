import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertExactMigrationLedger, FLUX_SCHEMA_VERSION, readAppliedMigrationVersions, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

const directory = 'packages/db/migrations';

test('0090 indexes existing projects, follows renames, visibility and deletes, and reverses without touching other results', async () => {
  const client = await pool.connect();
  const schema = `search_projects_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public, pg_catalog`);
    const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
    assert.equal(manifest.find((file) => file.version === 90)?.name, '0090_search_projects.sql');
    for (const file of manifest.filter((file) => file.version !== 90)) {
      await client.query(await readFile(join(directory, file.name), 'utf8'));
      await client.query('INSERT INTO flux_schema_version(version) VALUES ($1) ON CONFLICT DO NOTHING', [file.version]);
    }
    const userId = randomUUID(); const workspaceId = randomUUID(); const openId = randomUUID(); const restrictedId = randomUUID();
    await client.query("INSERT INTO auth_users(id,name,email) VALUES ($1,'Search owner',$2)", [userId, `${userId}@example.test`]);
    await client.query("INSERT INTO workspaces(id,name,created_by) VALUES ($1,'Search workspace',$2)", [workspaceId, userId]);
    // Projects that exist before 0090 must be indexed by its backfill, not only by later changes.
    await client.query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES ($1,$2,'Gesture lamp','workspace',$3)", [openId, workspaceId, userId]);
    await client.query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES ($1,$2,'Quiet launch','restricted',$3)", [restrictedId, workspaceId, userId]);
    // A result of another kind, which reversal must keep.
    await client.query("SELECT search_put($1,'person',$2,$3,NULL,$4,NULL,NULL,NULL,'Olek','',NULL,NULL,now())", [`person:${userId}`, workspaceId, `members:${workspaceId}`, userId]);
    const projectRows = async () => (await client.query(
      "SELECT doc_key, workspace_id::text AS workspace_id, audience_key, project_id::text AS project_id, object_id, title, status FROM search_documents WHERE kind = 'project' ORDER BY title",
    )).rows;
    const otherRows = async () => (await client.query("SELECT doc_key, kind, title, object_id FROM search_documents WHERE kind <> 'project' ORDER BY doc_key")).rows;
    const row = (id: string, title: string, status: string) => ({
      doc_key: `project:${id}`, workspace_id: workspaceId, audience_key: `project:${id}`, project_id: id, object_id: id, title, status,
    });
    const kept = await otherRows();
    assert.ok(kept.some((result) => result.doc_key === `person:${userId}`), 'the person result exists before the migration');

    await client.query(await readFile(join(directory, '0090_search_projects.sql'), 'utf8'));
    await client.query('INSERT INTO flux_schema_version(version) VALUES (90)');
    assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(client));
    assert.deepEqual(await projectRows(), [row(openId, 'Gesture lamp', 'workspace'), row(restrictedId, 'Quiet launch', 'restricted')]);
    assert.deepEqual(await otherRows(), kept);

    await client.query("UPDATE projects SET name = 'Gesture lamp v2' WHERE id = $1", [openId]);
    await client.query("UPDATE projects SET visibility = 'restricted' WHERE id = $1", [openId]);
    await client.query('DELETE FROM projects WHERE id = $1', [restrictedId]);
    assert.deepEqual(await projectRows(), [row(openId, 'Gesture lamp v2', 'restricted')]);

    await client.query(await readFile(join(directory, 'reverse/0090_search_projects.down.sql'), 'utf8'));
    await client.query('DELETE FROM flux_schema_version WHERE version = 90');
    assert.deepEqual(await projectRows(), []);
    assert.deepEqual(await otherRows(), kept);
    await client.query("UPDATE projects SET name = 'After reverse' WHERE id = $1", [openId]);
    assert.deepEqual(await projectRows(), [], 'after reversal no trigger indexes project changes');

    await client.query(await readFile(join(directory, '0090_search_projects.sql'), 'utf8'));
    await client.query('INSERT INTO flux_schema_version(version) VALUES (90)');
    assertExactMigrationLedger(manifest, await readAppliedMigrationVersions(client));
    assert.deepEqual(await projectRows(), [row(openId, 'After reverse', 'restricted')]);
    assert.deepEqual(await otherRows(), kept);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
