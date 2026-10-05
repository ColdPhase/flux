import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase, FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { guardFixturePool } from './support/fixture-database.js';

test('0045 preserves historical text and search, reverses before use and refuses real staged files', async () => {
  const dir = 'packages/db/migrations';
  const manifest = await readMigrationManifest(dir, FLUX_SCHEMA_VERSION);
  const migration = manifest.find((entry) => entry.version === 45)!;
  assert.equal(migration.name, '0045_stored_files.sql');
  const name = `flux_file_history_${randomUUID().replaceAll('-', '')}`;
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
    for (const file of manifest.filter((entry) => entry.version < 45)) await history.query(await readFile(join(dir, file.name), 'utf8'));
    const [ws, project, conversation, message, command, file] = Array.from({ length: 6 }, () => randomUUID());
    const user = 'file-history-person';
    await history.query('INSERT INTO auth_users(id,name,email) VALUES($1,$2,$3)', [user, 'Historical author', 'file-history@example.test']);
    await history.query('INSERT INTO workspaces(id,name,created_by) VALUES($1,$2,$3)', [ws, 'Historical workspace', user]);
    await history.query('INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,$4,$5)', [project, ws, 'Historical project', 'restricted', user]);
    await history.query('INSERT INTO project_conversations(id,workspace_id,project_id,created_by,next_sequence) VALUES($1,$2,$3,$4,2)', [conversation, ws, project, user]);
    await history.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_id,client_message_id,request_fingerprint,sequence,body)
      VALUES($1,$2,$3,$4,$5,$6,'historical-message',1,'Original authored text')`, [message, ws, project, conversation, user, command]);
    const snapshot = async () => ({
      messages: (await history!.query('SELECT id,workspace_id,project_id,conversation_id,author_id,client_message_id,request_fingerprint,sequence,body,created_at FROM project_messages')).rows,
      search: (await history!.query("SELECT * FROM search_documents WHERE kind='message'")).rows,
    });
    const before = await snapshot();
    const forward = await readFile(join(dir, migration.name), 'utf8');
    const reverse = await readFile(join(dir, 'reverse', '0045_stored_files.down.sql'), 'utf8');
    await history.query(forward);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await history.query('SELECT attachment_count FROM project_messages')).rows[0].attachment_count, 0);
    await history.query(reverse);
    assert.deepEqual(await snapshot(), before);
    await history.query(forward);
    await history.query(`INSERT INTO project_files(id,workspace_id,project_id,uploader_id,upload_id,name,state,reserved_bytes,expires_at)
      VALUES($1,$2,$3,$4,$5,'receiving.txt','receiving',5242880,now()+interval '15 minutes')`, [file, ws, project, user, randomUUID()]);
    await assert.rejects(history.query(reverse), /reversal refused/);
    assert.equal((await history.query('SELECT count(*)::int AS n FROM project_files')).rows[0].n, 1);
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(history.query("UPDATE project_messages SET body='' WHERE id=$1", [message]), /check constraint/);
  } finally {
    guard?.cleanup();
    await history?.end();
    const dropFixture = { text: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, query_timeout: 60_000 };
    await admin.query(dropFixture);
    await admin.end();
  }
  guard?.assertNoEarlyErrors();
});
