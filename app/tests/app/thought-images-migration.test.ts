import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase, FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';

// #252: migration 0050 lets a stored file be published to one map thought. It keeps every earlier file row as it was,
// keeps "published to exactly one place" in the database, and reverses only before any image was placed on a thought.
test('0050 keeps stored files as they were, publishes to one place only and reverses only before use', async () => {
  const dir = 'packages/db/migrations';
  const manifest = await readMigrationManifest(dir, FLUX_SCHEMA_VERSION);
  const migration = manifest.find((entry) => entry.version === 50)!;
  assert.equal(migration.name, '0050_thought_images.sql');
  const name = `flux_thought_images_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase(process.env.DATABASE_URL!).pool;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  let history: ReturnType<typeof createDatabase>['pool'] | undefined;
  try {
    await admin.query({ text: `CREATE DATABASE "${name}"`, query_timeout: 60_000 });
    history = createDatabase(url.toString()).pool;
    for (const file of manifest.filter((entry) => entry.version < 50)) await history.query(await readFile(join(dir, file.name), 'utf8'));
    const [ws, project, conversation, message, attached, staged] = Array.from({ length: 6 }, () => randomUUID());
    const user = 'thought-image-person';
    await history.query('INSERT INTO auth_users(id,name,email) VALUES($1,$2,$3)', [user, 'Historical uploader', 'thought-image@example.test']);
    await history.query('INSERT INTO workspaces(id,name,created_by) VALUES($1,$2,$3)', [ws, 'Historical workspace', user]);
    await history.query('INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,$4,$5)', [project, ws, 'Historical project', 'restricted', user]);
    await history.query('INSERT INTO project_conversations(id,workspace_id,project_id,created_by,next_sequence) VALUES($1,$2,$3,$4,2)', [conversation, ws, project, user]);
    await history.query(`INSERT INTO project_messages(id,workspace_id,project_id,conversation_id,author_id,client_message_id,request_fingerprint,sequence,body,attachment_count)
      VALUES($1,$2,$3,$4,$5,$6,'historical-message',1,'',1)`, [message, ws, project, conversation, user, randomUUID()]);
    const digest = 'a'.repeat(64);
    await history.query(`INSERT INTO project_files(id,workspace_id,project_id,uploader_id,upload_id,name,state,reserved_bytes,size,sha256,ready_at,message_id,position,published_at)
      VALUES($1,$2,$3,$4,$5,'dusk.png','ready',5242880,68,$6,now(),$7,0,now())`, [attached, ws, project, user, randomUUID(), digest, message]);
    await history.query(`INSERT INTO project_files(id,workspace_id,project_id,uploader_id,upload_id,name,state,reserved_bytes,size,sha256,ready_at,expires_at)
      VALUES($1,$2,$3,$4,$5,'staged.png','ready',5242880,68,$6,now(),now()+interval '7 days')`, [staged, ws, project, user, randomUUID(), digest]);
    const snapshot = async () => (await history!.query(`SELECT id,workspace_id,project_id,uploader_id,upload_id,name,state,reserved_bytes,size,sha256,
      created_at,ready_at,expires_at,message_id,position,published_at FROM project_files ORDER BY id`)).rows;
    const before = await snapshot();
    const forward = await readFile(join(dir, migration.name), 'utf8');
    const reverse = await readFile(join(dir, 'reverse', '0050_thought_images.down.sql'), 'utf8');
    await history.query(forward);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await history.query('SELECT thought_id FROM project_files')).rows, [{ thought_id: null }, { thought_id: null }]);
    await history.query(reverse);
    assert.deepEqual(await snapshot(), before);
    await history.query(forward);

    // Published to exactly one place, never both; a published image never expires; staging still must expire.
    await assert.rejects(history.query('UPDATE project_files SET thought_id = $1 WHERE id = $2', [randomUUID(), attached]), /project_file_publication/);
    await assert.rejects(history.query('UPDATE project_files SET thought_id = $1 WHERE id = $2', [randomUUID(), staged]), /project_file_publication/);
    await assert.rejects(history.query('UPDATE project_files SET thought_id = $1, published_at = now() WHERE id = $2', [randomUUID(), staged]), /project_file_published_ready/);
    const thought = randomUUID();
    await history.query('UPDATE project_files SET thought_id = $1, published_at = now(), expires_at = NULL WHERE id = $2', [thought, staged]);
    await assert.rejects(history.query('UPDATE project_files SET thought_id = NULL, published_at = NULL WHERE id = $1', [staged]), /project_file_unpublished_expires/);
    // One image per thought.
    const second = randomUUID();
    await history.query(`INSERT INTO project_files(id,workspace_id,project_id,uploader_id,upload_id,name,state,reserved_bytes,size,sha256,ready_at,expires_at)
      VALUES($1,$2,$3,$4,$5,'second.png','ready',5242880,68,$6,now(),now()+interval '7 days')`, [second, ws, project, user, randomUUID(), digest]);
    await assert.rejects(history.query('UPDATE project_files SET thought_id = $1, published_at = now(), expires_at = NULL WHERE id = $2', [thought, second]), /project_files_thought_idx/);

    // After an image was placed on a thought, the reversal refuses and changes nothing.
    await assert.rejects(history.query(reverse), /0050 reversal refused/);
    assert.equal((await history.query('SELECT thought_id FROM project_files WHERE id = $1', [staged])).rows[0].thought_id, thought);
  } finally {
    await history?.end();
    await admin.query({ text: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, query_timeout: 60_000 });
    await admin.end();
  }
});
