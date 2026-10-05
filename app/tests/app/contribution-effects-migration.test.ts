import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase, FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { guardFixturePool } from './support/fixture-database.js';

const dir = 'packages/db/migrations';

test('0040 keeps every historical row byte-identical as plain text, adds only empty receipts, and reverses only before use', async () => {
  const manifest = await readMigrationManifest(dir, FLUX_SCHEMA_VERSION);
  const migration = manifest.find((file) => file.version === 40);
  assert.equal(migration?.name, '0040_native_contribution_effects.sql');
  const name = `flux_effects_history_${randomUUID().replaceAll('-', '')}`;
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
    for (const file of manifest.filter((file) => file.version < 40)) await history.query(await readFile(join(dir, file.name), 'utf8'));
    const user = 'historic-person';
    const [workspace, project, conversation, first, second, work, result, command1, command2] = Array.from({ length: 9 }, () => randomUUID());
    const at = '2026-09-01T12:34:56.789Z';
    await history.query('INSERT INTO auth_users(id,name,email) VALUES($1,$2,$3)', [user, 'Historical author', 'effects-history@example.test']);
    await history.query('INSERT INTO workspaces(id,name,created_by) VALUES($1,$2,$3)', [workspace, 'Historical workspace', user]);
    await history.query('INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,$4,$5)', [project, workspace, 'Historical project', 'restricted', user]);
    await history.query(`INSERT INTO project_conversations(id,workspace_id,project_id,created_by,next_sequence,created_at) VALUES($1,$2,$3,$4,3,$5)`, [conversation, workspace, project, user, at]);
    for (const [id, sequence, body, clientId] of [[first, 1, 'A historical blocker-looking text: Blocked on the hinge.', command1], [second, 2, 'Result: not reclassified.', command2]] as const)
      await history.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_id,client_message_id,request_fingerprint,sequence,body,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, workspace, project, conversation, user, clientId, `historic-${sequence}`, sequence, body, at]);
    await history.query(`INSERT INTO project_work_items(id,workspace_id,project_id,title,status,blocker,created_by_kind,created_by_id,created_at,updated_at)
      VALUES($1,$2,$3,'Historical work','blocked','Blocked on the hinge','human',$4,$5,$5)`, [work, workspace, project, user, at]);
    await history.query(`INSERT INTO project_results(id,workspace_id,project_id,title,finding,created_by_kind,created_by_id,created_at)
      VALUES($1,$2,$3,'Historical result','positive','human',$4,$5)`, [result, workspace, project, user, at]);
    const snapshot = async () => ({
      messages: (await history!.query(`SELECT id,conversation_id,author_id,author_agent_id,client_message_id,request_fingerprint,sequence,body,
        source_material_id,source_material_version,created_at FROM project_messages ORDER BY sequence`)).rows,
      search: (await history!.query("SELECT * FROM search_documents WHERE doc_key LIKE 'message:%' ORDER BY doc_key")).rows,
      work: (await history!.query('SELECT * FROM project_work_items')).rows,
      results: (await history!.query('SELECT * FROM project_results')).rows,
      discussions: (await history!.query('SELECT count(*)::int AS n FROM project_task_discussions')).rows,
    });
    const before = await snapshot();
    assert.equal(before.search.length, 2);
    await history.query(await readFile(join(dir, migration!.name), 'utf8'));
    assert.deepEqual(await snapshot(), before, 'the migration rewrites no historical author, time, sequence, source, search row, task or result');
    assert.deepEqual((await history.query('SELECT contribution_kind,result_id FROM project_messages ORDER BY sequence')).rows,
      [{ contribution_kind: 'text', result_id: null }, { contribution_kind: 'text', result_id: null }],
      'nothing is inferred: a text that looks like a blocker or a result stays plain text');
    assert.equal((await history.query('SELECT count(*)::int AS n FROM native_command_receipts')).rows[0].n, 0, 'no receipt is backfilled');
    assert.equal((await history.query('SELECT count(*)::int AS n FROM project_task_discussions')).rows[0].n, 0, 'no thread or binding is inferred');

    // Pre-use reversal restores the previous shape and the data; re-applying the migration works again.
    const reverse = await readFile(join(dir, 'reverse', '0040_native_contribution_effects.down.sql'), 'utf8');
    await history.query(reverse);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await history.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='project_messages' AND column_name IN ('contribution_kind','result_id')")).rows[0].n, 0);
    assert.equal((await history.query("SELECT to_regclass('native_command_receipts') AS name")).rows[0].name, null);
    await history.query(await readFile(join(dir, migration!.name), 'utf8'));
    assert.deepEqual(await snapshot(), before);

    // After real use the previous schema cannot represent the data: the reversal refuses and changes nothing.
    await history.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_id,client_message_id,request_fingerprint,sequence,body,contribution_kind)
      VALUES($1,$2,$3,$4,$5,$6,'blocker',3,'Now an explicit blocker','blocker')`, [randomUUID(), workspace, project, conversation, user, randomUUID()]);
    await assert.rejects(history.query(reverse), /reversal refused: blocker, result or handoff contributions exist/);
    assert.equal((await history.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='project_messages' AND column_name='contribution_kind'")).rows[0].n, 1);
    await history.query("DELETE FROM project_messages WHERE contribution_kind='blocker'");
    await history.query(`INSERT INTO native_command_receipts(workspace_id,project_id,actor_kind,actor_id,operation,client_command_id,request_fingerprint,result_id)
      VALUES($1,$2,'human',$3,'result.create',$4,'x',$5)`, [workspace, project, user, randomUUID(), result]);
    await assert.rejects(history.query(reverse), /reversal refused: native command receipts exist/);
    assert.equal((await history.query('SELECT count(*)::int AS n FROM native_command_receipts')).rows[0].n, 1);
  } finally {
    guard?.cleanup();
    await history?.end();
    // Database administration can outlast the API's short read deadline under the parallel suite (another
    // migration fixture creates and drops databases at the same time); the assertions above keep ordinary deadlines.
    // FORCE ends a lingering session instead of waiting for it.
    const cleanup = { text: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, query_timeout: 60_000 };
    await admin.query(cleanup).finally(() => admin.end());
  }
  guard?.assertNoEarlyErrors();
});
