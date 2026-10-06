import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase } from '@flux/db';
import { guardFixturePool } from './support/fixture-database.js';

test('actual pre-notice human rows and search provenance survive notice and agent migrations without backfill', async () => {
  const name = `flux_actor_history_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase(process.env.DATABASE_URL!).pool;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  let history: ReturnType<typeof createDatabase>['pool'] | undefined;
  let guard: ReturnType<typeof guardFixturePool> | undefined;
  try {
    const createFixture = { text: `CREATE DATABASE "${name}"`, query_timeout: 60_000 };
    await admin.query(createFixture);
    history = createDatabase(url.toString()).pool;
    guard = guardFixturePool(history);
    const dir = 'packages/db/migrations';
    const files = (await readdir(dir)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
    for (const file of files.filter((file) => Number(file.slice(0, 4)) < 33))
      await history.query(await readFile(join(dir, file), 'utf8'));
    const user = 'historic-person';
    const [workspace, project, conversation, message, material, work, command] = Array.from({ length: 7 }, () => randomUUID());
    const at = '2026-09-01T12:34:56.789Z';
    await history.query('INSERT INTO auth_users(id,name,email) VALUES($1,$2,$3)', [user, 'Historical author', 'history@example.test']);
    await history.query('INSERT INTO workspaces(id,name,created_by) VALUES($1,$2,$3)', [workspace, 'Historical workspace', user]);
    await history.query('INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,$4,$5)',
      [project, workspace, 'Historical project', 'restricted', user]);
    await history.query(`INSERT INTO project_materials(id,workspace_id,project_id,created_by,client_mutation_id,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6)`, [material, workspace, project, user, randomUUID(), 'historic-material']);
    await history.query(`INSERT INTO project_material_versions(workspace_id,project_id,material_id,version,title,body,author_id,created_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7)`, [workspace, project, material, 'Original measured source', 'Unchanged source bytes', user, at]);
    await history.query(`INSERT INTO project_conversations(id,workspace_id,project_id,created_by,next_sequence,created_at)
      VALUES($1,$2,$3,$4,2,$5)`, [conversation, workspace, project, user, at]);
    await history.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_id,client_message_id,
      request_fingerprint,sequence,body,source_material_id,source_material_version,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,1,$10)`,
    [message, workspace, project, conversation, user, command, 'historic-message', 'Original contribution: do not reclassify this text.', material, at]);
    await history.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,created_by_kind,created_by_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'human',$5,$6,$6)`, [work, workspace, project, 'Historical work', user, at]);
    const snapshot = async () => ({
      conversation: (await history!.query('SELECT id,created_by,next_sequence,created_at FROM project_conversations')).rows,
      messages: (await history!.query(`SELECT id,conversation_id,author_id,client_message_id,request_fingerprint,sequence,body,
        source_material_id,source_material_version,created_at FROM project_messages`)).rows,
      search: (await history!.query("SELECT * FROM search_documents WHERE doc_key=$1", [`message:${message}`])).rows,
    });
    const before = await snapshot();
    assert.equal(before.search.length, 1);
    await history.query(await readFile(join(dir, '0033_task_creation_notices.sql'), 'utf8'));
    assert.equal((await history.query('SELECT count(*)::int AS count FROM project_task_notices')).rows[0].count, 0);
    assert.equal((await history.query('SELECT count(*)::int AS count FROM project_task_discussions')).rows[0].count, 0);
    assert.deepEqual(await snapshot(), before, 'notice migration does not infer historical task messages');
    await history.query(`INSERT INTO project_task_discussions(work_id,workspace_id,project_id,conversation_id,root_message_id)
      VALUES($1,$2,$3,$4,$5)`, [work, workspace, project, conversation, message]);
    const binding = (await history.query('SELECT * FROM project_task_discussions')).rows;
    await history.query(await readFile(join(dir, '0037_task_message_actors.sql'), 'utf8'));
    assert.deepEqual(await snapshot(), before, 'actor migration preserves exact human authors, IDs, times, source and search row');
    assert.deepEqual((await history.query('SELECT * FROM project_task_discussions')).rows, binding);
    assert.equal((await history.query('SELECT author_agent_id FROM project_messages')).rows[0].author_agent_id, null);
    assert.equal((await history.query('SELECT created_by_agent_id FROM project_conversations')).rows[0].created_by_agent_id, null);
    await assert.rejects(history.query('UPDATE project_messages SET author_id=NULL WHERE id=$1', [message]), /check constraint/);
    await assert.rejects(history.query('UPDATE project_conversations SET created_by=NULL WHERE id=$1', [conversation]), /check constraint/);
    assert.deepEqual(await snapshot(), before);
  } finally {
    guard?.cleanup();
    await history?.end();
    // Database administration/fsync can outlast the API's 2 s read deadline, and on a busy host even
    // 10 s (twice observed, 2026-10-03); the assertions above keep the ordinary runtime deadlines.
    // FORCE ends a lingering session instead of waiting for it, as in contribution-effects-migration.
    const cleanup = { text: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, query_timeout: 60_000 };
    await admin.query(cleanup).finally(() => admin.end());
  }
  guard?.assertNoEarlyErrors();
});
