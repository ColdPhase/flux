import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { projectExportPath, type Agent, type Conversation, type ConversationMessage, type Doc, type Page, type Project, type WorkItem, type Workspace } from '@flux/contracts';
import { docUseCases } from '../../apps/server/src/docs/adapters.js';
import { db, pool } from './support/db.js';
import { createSealed, passphrase } from './support/encryption.js';
import type { ClientResponse } from './support/http.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';

// Deleting a Wiki page (#941): ⋯ › Delete page after an OK. The server removes the page for everyone: its versions, shared text,
// links, search rows and live room; a message that cited a version keeps its text and says the page was deleted; an agent's
// suggestion about it and the task plan items made from it are cleared (the tasks stay).

const post = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('POST', path, { body, headers });
const patch = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('PATCH', path, { body, headers });
const get = (someone: Person, path: string) => someone.browser.request('GET', path);
const remove = (someone: Person, path: string, headers?: Record<string, string>) => someone.browser.request('DELETE', path, { headers });
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const code = (response: ClientResponse) => (response.json as { code?: string }).code;
const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });
const count = async (sql: string, values: unknown[]) => (await pool.query(sql, values)).rows[0].n as number;

describe('deleting a Wiki page for everyone (#941)', () => {
  let owner: Person;
  let partner: Person;
  let outsider: Person;
  let ws: Workspace;
  let lamp: Project;
  let conversation: Conversation;

  before(async () => {
    [owner, partner, outsider] = await Promise.all(['del-owner', 'del-partner', 'del-outsider'].map(person));
    ws = await workspace(owner, 'Deleting pages');
    for (const someone of [partner, outsider]) await addMember(owner, ws.id, someone, 'member');
    lamp = await createProject(owner, ws.id, 'Gesture lamp', 'restricted');
    await grant(owner, lamp.id, partner, 'contributor');
    conversation = json<Conversation>(await post(owner, `/api/v1/projects/${lamp.id}/conversations`,
      { body: 'The PIR sensor misses slow hand movements.', clientMessageId: randomUUID() }), 201);
  });

  const page = async (title: string, body = 'Fit the brass collar first.') => json<Doc>(await post(owner, `/api/v1/projects/${lamp.id}/docs`, { title, body }), 201);

  test('it needs the version the caller saw, and then nothing of the page remains', async () => {
    const doc = await page('Wiring notes', 'We use a **PIR** sensor and [the lamp](flux:doc/00000000-0000-4000-8000-000000000000).');
    const edited = json<Doc>(await patch(partner, `/api/v1/docs/${doc.id}`, { body: 'We use a **ToF** sensor.' }, ifMatch(1)), 200);
    // Without the version: 428. With a stale one: 409 and the latest page, so nobody deletes text they have not seen.
    assert.equal((await remove(owner, `/api/v1/docs/${doc.id}`)).status, 428);
    const stale = await remove(owner, `/api/v1/docs/${doc.id}`, ifMatch(1));
    assert.deepEqual([stale.status, code(stale), (stale.json as { current?: Doc }).current?.version], [409, 'VERSION_CONFLICT', 2]);
    assert.equal(json<Doc>(await get(owner, `/api/v1/docs/${doc.id}`), 200).version, 2, 'a refused delete deletes nothing');

    const live = await get(owner, `/api/v1/docs/${doc.id}/live`);
    assert.equal(live.status, 200, 'the page has a shared text');
    assert.ok(await count('SELECT count(*)::int AS n FROM doc_live_heads WHERE doc_id = $1', [doc.id]) > 0);
    assert.ok(await count(`SELECT count(*)::int AS n FROM search_documents WHERE doc_key LIKE $1`, [`material:${doc.id}:%`]) > 0, 'the page is searchable');

    const gone = await remove(owner, `/api/v1/docs/${doc.id}`, { ...ifMatch(edited.version), 'idempotency-key': randomUUID() });
    assert.equal(gone.status, 204, gone.text);
    for (const path of [`/api/v1/docs/${doc.id}`, `/api/v1/docs/${doc.id}/versions`, `/api/v1/docs/${doc.id}/versions/1`, `/api/v1/docs/${doc.id}/live`, `/api/v1/materials/${doc.id}/versions/1`]) {
      assert.equal((await get(partner, path)).status, 404, path);
    }
    const listed = json<Page<{ id: string }>>(await get(partner, `/api/v1/projects/${lamp.id}/docs`), 200);
    assert.ok(!listed.items.some((item) => item.id === doc.id), 'the project list no longer holds it');
    assert.equal(await count('SELECT count(*)::int AS n FROM project_materials WHERE id = $1', [doc.id]), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM project_material_versions WHERE material_id = $1', [doc.id]), 0);
    for (const table of ['doc_live_heads', 'doc_live_updates', 'doc_live_snapshots', 'doc_live_archives', 'doc_live_presence', 'doc_live_replicas']) {
      assert.equal(await count(`SELECT count(*)::int AS n FROM ${table} WHERE doc_id = $1`, [doc.id]), 0, table);
    }
    assert.equal(await count(`SELECT count(*)::int AS n FROM search_documents WHERE doc_key LIKE $1`, [`material:${doc.id}:%`]), 0, 'its search rows go');
    assert.equal(await count(`SELECT count(*)::int AS n FROM project_object_links WHERE from_id = $1 OR to_id = $1`, [doc.id]), 0, 'its links go');
    // A retry after the page is gone says so.
    assert.equal((await remove(owner, `/api/v1/docs/${doc.id}`, ifMatch(edited.version))).status, 404);
  });

  test('links to the page go with it, and other pages that name it read it as missing', async () => {
    const target = await page('Target page');
    const task = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Order the collar' }), 201);
    // A task that took a version of the target as a source: that link goes too, so the project export has no id of a deleted page.
    const sourced = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Follow the target', sources: [{ type: 'material', id: target.id, version: 1 }] }), 201);
    assert.equal(await count(`SELECT count(*)::int AS n FROM project_object_links WHERE to_type = 'material' AND to_id = $1`, [target.id]), 1);
    const from = await page('Names the target', `See [the target](flux:doc/${target.id}) and [the task](flux:work/${task.id}).`);
    assert.ok(from.links.some((link) => link.role === 'mentions' && link.to.id === target.id));
    assert.equal(json<Doc>(await get(owner, `/api/v1/docs/${target.id}`), 200).links.some((link) => link.from.id === from.id), true, 'a backlink');
    assert.equal((await remove(owner, `/api/v1/docs/${target.id}`, ifMatch(1))).status, 204);
    const after = json<Doc>(await get(owner, `/api/v1/docs/${from.id}`), 200);
    assert.ok(!after.links.some((link) => link.to.id === target.id), 'the link to the deleted page is gone');
    assert.equal(await count('SELECT count(*)::int AS n FROM project_object_links WHERE from_id = $1 OR to_id = $1', [target.id]), 0, 'including the task source that named a version');
    assert.equal(json<WorkItem>(await get(owner, `/api/v1/work/${sourced.id}`), 200).id, sourced.id, 'the task stays');

    assert.deepEqual(after.mentions.filter((item) => item.id === target.id).map((item) => item.path), [null], 'the name of a deleted page reads as missing');
    // A page that only a task's source names: after the delete the link and the creation notice's entry are gone, so the project
    // export holds no id of it (the other page's text still spells the first one's address, which is its own words and no link).
    const lone = await page('Only a source');
    json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Read the lone page', sources: [{ type: 'material', id: lone.id, version: 1 }] }), 201);
    assert.ok((await get(owner, projectExportPath(lamp.id))).text.includes(lone.id), 'the export names the page while it exists');
    assert.equal((await remove(owner, `/api/v1/docs/${lone.id}`, ifMatch(1))).status, 204);
    const exported = await get(owner, projectExportPath(lamp.id));
    assert.equal(exported.status, 200);
    assert.ok(!exported.text.includes(lone.id), 'the project export has no id of the deleted page');
    assert.equal(await count(`SELECT count(*)::int AS n FROM project_task_notices WHERE sources::text LIKE $1`, [`%${lone.id}%`]), 0, 'the task\'s creation notice drops the entry');
    // The page that mentions a task is deleted too: the task stays, and so does its evidence of use.
    assert.equal((await remove(owner, `/api/v1/docs/${from.id}`, ifMatch(1))).status, 204);
    assert.equal(json<WorkItem>(await get(owner, `/api/v1/work/${task.id}`), 200).id, task.id);
    assert.equal(await count('SELECT count(*)::int AS n FROM project_object_links WHERE from_id = $1', [from.id]), 0);
  });

  test('a message that cited a version keeps its text and says the page was deleted', async () => {
    const doc = await page('Cited page');
    const citing = json<ConversationMessage>(await post(partner, `/api/v1/conversations/${conversation.id}/messages`,
      { body: 'See the cited page.', clientMessageId: randomUUID(), source: { materialId: doc.id, version: 1 } }), 201);
    assert.deepEqual(citing.source, { materialId: doc.id, version: 1 });
    assert.equal((await remove(owner, `/api/v1/docs/${doc.id}`, ifMatch(1))).status, 204);
    const read = json<Conversation>(await get(owner, `/api/v1/conversations/${conversation.id}`), 200).messages.find((item) => item.id === citing.id)!;
    assert.deepEqual([read.body, read.source, read.sourceDeleted], ['See the cited page.', null, true], 'the message reads as it was written, with no citation to open');
    const stored = (await pool.query('SELECT source_material_id, source_material_version, source_deleted FROM project_messages WHERE id = $1', [citing.id])).rows[0];
    assert.deepEqual([stored.source_material_id, stored.source_material_version, stored.source_deleted], [null, null, true]);
    // A message that never cited a page does not say so.
    const plain = json<Conversation>(await get(owner, `/api/v1/conversations/${conversation.id}`), 200).messages.find((item) => item.sequence === 1)!;
    assert.equal(plain.sourceDeleted, undefined);
    // The database refuses a message that is deleted-sourced and still cites a version.
    await assert.rejects(pool.query('UPDATE project_messages SET source_deleted = true, source_material_id = $2, source_material_version = 1 WHERE id = $1', [citing.id, randomUUID()]), /project_message_source_deleted|violates/);
  });

  test('an agent\'s suggestion about the page and the plan items made from it are cleared; the tasks stay', async () => {
    const doc = await page('Plan page', 'Measure, then fit.');
    const agent = json<Agent>(await post(owner, `/api/v1/workspaces/${ws.id}/agents`, { name: 'Page reader', owner: 'self' }), 201);
    await pool.query(`INSERT INTO agent_proposals (id, workspace_id, project_id, agent_id, owner_user_id, compute_source, source_material_id, source_material_version,
      client_command_id, request_fingerprint, fact, interpretation, suggested_action)
      VALUES ($1, $2, $3, $4, $5, 'user_operated_external_client', $6, 1, $7, $8, 'A fact', 'A reading', 'An action')`,
    [randomUUID(), ws.id, lamp.id, agent.id, owner.id, doc.id, randomUUID(), 'a'.repeat(64)]);
    const task = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Measure the bracket' }), 201);
    await pool.query(`INSERT INTO project_task_plan_intents (workspace_id, project_id, material_id, material_version, intent_key, task_id, creation_fingerprint, task_version)
      VALUES ($1, $2, $3, 1, 'measure', $4, $5, 1)`, [ws.id, lamp.id, doc.id, task.id, 'b'.repeat(64)]);
    assert.equal((await remove(owner, `/api/v1/docs/${doc.id}`, ifMatch(1))).status, 204);
    assert.equal(await count('SELECT count(*)::int AS n FROM agent_proposals WHERE source_material_id = $1', [doc.id]), 0, 'the suggestion is cleared');
    assert.equal(await count('SELECT count(*)::int AS n FROM project_task_plan_intents WHERE material_id = $1', [doc.id]), 0, 'the plan item is cleared');
    assert.equal(json<WorkItem>(await get(owner, `/api/v1/work/${task.id}`), 200).title, 'Measure the bracket', 'the task made from the page stays');
  });

  test('a live room on the page ends with it', async () => {
    const doc = await page('Room page');
    const room = randomUUID();
    const ended = randomUUID();
    for (const [id, state] of [[room, 'available'], [ended, 'ended']] as const) {
      await pool.query(`INSERT INTO live_sessions (id, workspace_id, project_id, doc_id, created_by, client_session_id, room_id, state)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, ws.id, lamp.id, doc.id, owner.id, randomUUID(), `live_${randomUUID()}`, state]);
    }
    assert.equal((await remove(owner, `/api/v1/docs/${doc.id}`, ifMatch(1))).status, 204);
    const sessions = (await pool.query('SELECT id, state, doc_id FROM live_sessions WHERE id = ANY($1) ORDER BY id', [[room, ended]])).rows as { id: string; state: string; doc_id: string }[];
    assert.deepEqual(sessions.map((row) => [row.id, row.state, row.doc_id]).sort(), [[room, 'ending', doc.id], [ended, 'ended', doc.id]].sort(),
      'the open room is ending (the live lifecycle closes it at the media server); an ended one stays as history');
    // The live lifecycle ends every pending room of the database when it recovers: leave none behind for the next file.
    await pool.query(`UPDATE live_sessions SET state = 'ended', ended_at = now(), updated_at = now() WHERE id = $1`, [room]);
  });

  test('the delete is an event with ids only, and the stream carries it to the project', async () => {
    const doc = await page('Event page');
    assert.equal((await remove(owner, `/api/v1/docs/${doc.id}`, ifMatch(1))).status, 204);
    const events = (await pool.query(`SELECT kind, object_id, data FROM events WHERE kind = 'project.doc_deleted.v1' AND data->>'docId' = $1`, [doc.id])).rows;
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].object_id, Object.keys(events[0].data).sort()], [lamp.id, ['docId', 'version']], 'ids only');
  });

  test('a write that waits for a delete reads the page as gone: 404, not a 500, and a second Delete says it is already deleted', async () => {
    const doc = await page('Race page');
    const holder = await pool.connect();
    try {
      // What a delete in flight holds: the page's row, taken after the caller was let in and before the others look at the page.
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM project_materials WHERE id = $1 FOR UPDATE', [doc.id]);
      const waiting = [
        patch(partner, `/api/v1/docs/${doc.id}`, { title: 'Renamed meanwhile' }, ifMatch(1)),
        remove(partner, `/api/v1/docs/${doc.id}`, { ...ifMatch(1), 'idempotency-key': randomUUID() }),
      ];
      for (let waited = 0; ; waited += 50) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%project_materials%'`);
        if (rows[0].n >= 2) break;
        assert.ok(waited < 10_000, 'both requests wait for the page');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await holder.query('DELETE FROM project_materials WHERE id = $1', [doc.id]);
      await holder.query('COMMIT');
      const [renamed, deleted] = await Promise.all(waiting);
      assert.deepEqual([renamed.status, code(renamed)], [404, 'DOC_NOT_FOUND'], renamed.text);
      assert.deepEqual([deleted.status, code(deleted)], [404, 'DOC_NOT_FOUND'], deleted.text);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  test('who may: a member of the space writes, an outsider sees nothing, and a read of a restricted space is not enough', async () => {
    const doc = await page('Access page');
    const hidden = await remove(outsider, `/api/v1/docs/${doc.id}`, ifMatch(1));
    assert.deepEqual([hidden.status, code(hidden)], [404, 'DOC_NOT_FOUND'], 'a page the caller cannot see reads exactly like a missing one');
    assert.equal(json<Doc>(await get(owner, `/api/v1/docs/${doc.id}`), 200).version, 1);
    // A person-facing use case refuses an agent: only the standing composition (the owner's OK) deletes for an agent.
    const agent = json<Agent>(await post(owner, `/api/v1/workspaces/${ws.id}/agents`, { name: 'Deleter', owner: 'self' }), 201);
    await assert.rejects(docUseCases(db).deleteDoc({ kind: 'agent', id: agent.id }, doc.id, 1), (error: unknown) => (error as { code?: string }).code === 'DOC_NEEDS_PERSON');
    assert.equal((await remove(partner, `/api/v1/docs/${doc.id}`, ifMatch(1))).status, 204, 'a contributor deletes');
  });

  test('an encrypted space deletes pages the same way', async () => {
    const sealed = await createSealed(owner, 'Sealed pages', passphrase());
    const project = json<Project>(await post(owner, `/api/v1/workspaces/${sealed.workspace.id}/projects`, { name: 'Sealed sensors', visibility: 'workspace' }), 201);
    const doc = json<Doc>(await post(owner, `/api/v1/projects/${project.id}/docs`, { title: 'Sealed page', body: 'Sealed text.' }), 201);
    assert.equal(await count('SELECT count(*)::int AS n FROM project_material_versions WHERE material_id = $1 AND flux_is_sealed(body)', [doc.id]), 1, 'the text is sealed');
    assert.equal((await remove(owner, `/api/v1/docs/${doc.id}`, ifMatch(1))).status, 204);
    assert.equal(await count('SELECT count(*)::int AS n FROM project_materials WHERE id = $1', [doc.id]), 0);
    assert.equal((await get(owner, `/api/v1/docs/${doc.id}`)).status, 404);
  });
});
