import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import {
  agentConnectionPath, assistantChangeActionPath, assistantRunChangesActionPath, projectAssistantChangesPath,
  type AssistantChange, type AssistantChangeDecision, type AssistantChangeScope, type AssistantRunUndone,
} from '@flux/contracts';
import { pool } from './support/db.js';
import { toolValue } from './support/mcp.js';
import { actionScene } from './support/mcp-actions.js';
import { addMember, expectStatus, grant, person, type Person } from './support/people.js';
import { text } from './support/assistant-scene.js';

// mcp-cowork LC-2, #868: a local client's task, Wiki page and map changes show their change line and Undo on the task, page or map
// they are about, as its messages do on the message. Everything goes through the real `/mcp` route with the client's OAuth token; what
// the page reads is `GET /api/v1/projects/:projectId/assistant-changes?kind=&id=`, and Undo is the one the change log already has.

let f: Awaited<ReturnType<typeof actionScene>>;
let ada: Person; let jonas: Person; let stranger: Person; let outsider: Person;

const base = (clientCommandId: string = randomUUID()) => ({ projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, clientCommandId, peerRequestClass: 'execute', sources: [] });
const request = (who: Person, kind: string, id: string) => who.browser.request('GET', `${projectAssistantChangesPath(f.projectId)}?kind=${kind}&id=${id}`);
const linesOf = async (who: Person, kind: AssistantChangeScope, id: string) => (expectStatus(await request(who, kind, id), 200) as { items: AssistantChange[] }).items;
const setMayDo = async (mayDo: 'read' | 'act' | 'ask') => expectStatus(await f.owner.request('PATCH', agentConnectionPath(f.connectionId), { body: { mayDo } }), 200);
const undoGroup = (who: Person, runId: string) => who.browser.request('POST', assistantRunChangesActionPath(runId, 'undo'), { body: {} });
const undoOne = (who: Person, id: string) => who.browser.request('POST', assistantChangeActionPath(id, 'undo'), { body: {} });
const newTask = async (title: string) => expectStatus(await f.owner.request('POST', `/api/v1/projects/${f.projectId}/work`, { body: { title } }), 201) as { id: string; number: number; version: number; status: string };
const task = async (id: string) => expectStatus(await f.owner.request('GET', `/api/v1/work/${id}`), 200) as { status: string; title: string; version: number };
const doc = async (id: string) => expectStatus(await f.owner.request('GET', `/api/v1/docs/${id}`), 200) as { title: string; body: string; version: number };
const sketch = async (id: string) => expectStatus(await f.owner.request('GET', `/api/v1/sketches/${id}`), 200) as { title: string; version: number; thoughts: { id: string; text: string }[] };
const update = (workId: string, version: number, changes: Record<string, unknown>) => f.tool('flux_update_task', { ...base(), workId, expectedVersion: version, changes });
const updateDoc = (docId: string, version: number, body: string) => f.tool('flux_update_doc', { ...base(), docId, expectedVersion: version, changes: { body, reason: 'The client edits' } });

describe('A local client\'s task, page and map changes show their change line and Undo on the page they are about (#868, LC-2)', () => {
  before(async () => {
    f = await actionScene(pool);
    const me = expectStatus(await f.owner.request('GET', '/api/v1/me'), 200) as { user: { id: string } };
    ada = { id: me.user.id, email: '', browser: f.owner };
    jonas = await person('Jonas');
    stranger = await person('Stranger');
    outsider = await person('Outsider');
    await addMember(ada, f.workspaceId, jonas, 'member');
    await grant(ada, f.projectId, jonas, 'contributor');
    await addMember(ada, f.workspaceId, stranger, 'member');
    await pool.query(`UPDATE agent_connections SET client_designation = 'claude_code' WHERE id = $1`, [f.connectionId]);
  });

  test('a task the client changed lists the change with its words, its label and Undo, for everyone who can read the space', async () => {
    const target = await newTask('Calibrate the probes');
    toolValue(await update(target.id, target.version, { status: 'in_progress' }));
    const [line, ...rest] = await linesOf(ada, 'work', target.id);
    assert.equal(rest.length, 0);
    assert.deepEqual([line!.state, line!.operation, line!.objectType, line!.objectId, line!.owner.id, line!.via, line!.runState],
      ['applied', 'work.update', 'work', target.id, ada.id, 'Claude Code', 'done']);
    assert.equal(line!.runId, line!.id, 'a client\'s change is its own group: an Undo takes back that change alone');
    assert.equal(line!.done, `moved #${target.number} to Doing`);
    assert.equal(line!.undoable, true);
    // A person who can edit sees the same line, and so does a person who can only read the space, which is none of its tasks' business.
    const seen = (await linesOf(jonas, 'work', target.id))[0]!;
    assert.deepEqual([seen.id, seen.done, seen.via, seen.undoable], [line!.id, line!.done, 'Claude Code', true]);
    // Another task has none.
    assert.deepEqual(await linesOf(ada, 'work', f.prerequisiteId), []);
    // The same id asked as a page or a map is not a task's change.
    assert.deepEqual(await linesOf(ada, 'doc', target.id), []);
    assert.deepEqual(await linesOf(ada, 'map', target.id), []);
  });

  test('the client\'s label is its kind, or its own name when Flux does not know it, never where it runs', async () => {
    const target = await newTask('Label the soil probes');
    await pool.query(`UPDATE agent_connections SET client_designation = 'other', name = 'Cursor on this computer' WHERE id = $1`, [f.connectionId]);
    try {
      toolValue(await update(target.id, target.version, { title: 'Label the soil probes at dawn' }));
      assert.equal((await linesOf(ada, 'work', target.id))[0]!.via, 'Cursor');
      await pool.query(`UPDATE agent_connections SET client_designation = 'codex' WHERE id = $1`, [f.connectionId]);
      assert.equal((await linesOf(ada, 'work', target.id))[0]!.via, 'Codex');
    } finally {
      await pool.query(`UPDATE agent_connections SET client_designation = 'claude_code', name = 'Claude Code on this computer' WHERE id = $1`, [f.connectionId]);
    }
  });

  test('Undo takes that one change back, and the line then says who undid it', async () => {
    const target = await newTask('Move the stakes');
    toolValue(await update(target.id, target.version, { status: 'in_progress' }));
    const [line] = await linesOf(ada, 'work', target.id);
    const undone = expectStatus(await undoGroup(ada, line!.runId), 200) as AssistantRunUndone;
    assert.deepEqual([undone.undone, undone.changedSince], [1, []]);
    assert.equal((await task(target.id)).status, 'open');
    const [after] = await linesOf(ada, 'work', target.id);
    assert.deepEqual([after!.state, after!.decidedBy?.id, after!.undoable], ['undone', ada.id, false]);
  });

  test('"Changed since": a person who edited the field after the client leaves Undo with nothing to do, and the line stays', async () => {
    const target = await newTask('Water the beds');
    toolValue(await update(target.id, target.version, { status: 'in_progress' }));
    const [line] = await linesOf(ada, 'work', target.id);
    const read = await task(target.id);
    expectStatus(await f.owner.request('PATCH', `/api/v1/work/${target.id}`, { body: { status: 'done' }, headers: { 'if-match': `"${read.version}"` } }), 200);
    const undone = expectStatus(await undoGroup(ada, line!.runId), 200) as AssistantRunUndone;
    assert.deepEqual([undone.undone, undone.changedSince.length], [0, 1]);
    assert.equal(undone.changes[0]!.message, 'Changed since. Open it');
    assert.equal((await task(target.id)).status, 'done', 'nothing was put back');
    assert.deepEqual((await linesOf(ada, 'work', target.id)).map((item) => item.state), ['applied']);
  });

  test('a person who may edit the space takes a change back too; the creation of a task is its owner\'s alone', async () => {
    const target = await newTask('Charge the loggers');
    toolValue(await update(target.id, target.version, { status: 'in_progress' }));
    const [line] = await linesOf(jonas, 'work', target.id);
    expectStatus(await undoOne(jonas, line!.id), 200);
    assert.equal((await task(target.id)).status, 'open');

    const made = toolValue(await f.tool('flux_create_task', { ...base(), task: { title: 'A task the client opened' } }));
    const [creation] = await linesOf(ada, 'work', String(made.workId));
    assert.deepEqual([creation!.operation, creation!.done, creation!.undoable], ['work.create', 'added task A task the client opened', true]);
    assert.equal((await linesOf(jonas, 'work', String(made.workId)))[0]!.undoable, false, 'Jonas is offered no Undo of a task Ada\'s client made');
    const refused = expectStatus(await undoOne(jonas, creation!.id), 200) as AssistantChangeDecision;
    assert.match(refused.message ?? '', /^Only .+ can undo a task their agent added$/);
    assert.deepEqual((await linesOf(ada, 'work', String(made.workId))).map((item) => item.state), ['applied']);
    expectStatus(await undoOne(ada, creation!.id), 200);
    assert.deepEqual((await linesOf(ada, 'work', String(made.workId))).map((item) => item.state), ['undone']);
  });

  test('someone who cannot read the space is told nothing, and a bad question is plainly refused', async () => {
    const target = await newTask('Hidden work');
    toolValue(await update(target.id, target.version, { status: 'in_progress' }));
    const [line] = await linesOf(ada, 'work', target.id);
    // A member without a grant to this restricted space, and a person from nowhere, get the answer of a space that does not exist.
    for (const who of [stranger, outsider]) {
      const answer = await request(who, 'work', target.id);
      assert.deepEqual([answer.status, (answer.json as { code?: string }).code], [404, 'ASSISTANT_CHANGE_NOT_FOUND']);
      assert.equal((await undoOne(who, line!.id)).status, 404);
      assert.equal((await undoGroup(who, line!.runId)).status, 404);
    }
    assert.equal((await request(ada, 'thought', target.id)).status, 400);
    assert.equal((await request(ada, 'work', 'not-a-uuid')).status, 400);
    assert.equal((await f.owner.request('GET', projectAssistantChangesPath(f.projectId))).status, 400);
    assert.equal((await f.owner.request('GET', `${projectAssistantChangesPath(f.projectId)}?kind=__proto__&id=${target.id}`)).status, 400);
    assert.equal((await ada.browser.request('GET', `${projectAssistantChangesPath(randomUUID())}?kind=work&id=${target.id}`)).status, 404, 'another space is not this one');
  });

  test('what waits is the owner\'s Inbox, never a page\'s line; Only read changes nothing; and a client\'s own words are not a change line', async () => {
    const target = await newTask('Needs my OK');
    await setMayDo('ask');
    try {
      assert.match(text(await update(target.id, target.version, { status: 'in_progress' })), /^Waiting for /);
      assert.deepEqual(await linesOf(ada, 'work', target.id), [], 'a waiting change has no line, for its owner either');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM assistant_changes WHERE scope_id = $1 AND state = 'waiting'`, [target.id])).rows[0].n, 1);
      // Approve makes it, and from then on it has its line.
      const [waiting] = (await pool.query(`SELECT id FROM assistant_changes WHERE scope_id = $1 AND state = 'waiting'`, [target.id])).rows as { id: string }[];
      expectStatus(await f.owner.request('POST', assistantChangeActionPath(waiting!.id, 'apply'), { body: {} }), 200);
      const [approved] = await linesOf(ada, 'work', target.id);
      assert.deepEqual([approved!.id, approved!.state, approved!.done], [waiting!.id, 'applied_after_wait', `moved #${target.number} to Doing`]);
    } finally { await setMayDo('act'); }
  });

  test('a page the client made and edited lists both changes; Undo restores the earlier text, and "Changed since" holds after a person wrote', async () => {
    const created = toolValue(await f.tool('flux_create_doc', { ...base(), doc: { title: 'Battery notes', body: 'Four hours.' } }));
    const docId = String(created.docId);
    toolValue(await updateDoc(docId, Number(created.version), 'Four hours, twice.'));
    const lines = await linesOf(ada, 'doc', docId);
    assert.deepEqual(lines.map((item) => [item.operation, item.done, item.via]),
      [['doc.create', 'added the Wiki page Battery notes', 'Claude Code'], ['doc.update', 'updated the Wiki page Battery notes', 'Claude Code']]);
    assert.deepEqual(lines.map((item) => item.undoable), [true, true]);
    expectStatus(await undoGroup(ada, lines[1]!.runId), 200);
    assert.equal((await doc(docId)).body, 'Four hours.', 'the earlier text came back as a new version');
    assert.deepEqual((await linesOf(ada, 'doc', docId)).map((item) => item.state), ['applied', 'undone']);

    // A second client edit, then a person writes on the page: Undo changes nothing and says so.
    const current = await doc(docId);
    toolValue(await updateDoc(docId, current.version, 'Four hours, thrice.'));
    const again = (await linesOf(ada, 'doc', docId)).find((item) => item.state === 'applied' && item.operation === 'doc.update')!;
    const read = await doc(docId);
    expectStatus(await f.owner.request('PATCH', `/api/v1/docs/${docId}`, { body: { body: 'Four hours, thrice, by hand.' }, headers: { 'if-match': `"${read.version}"` } }), 200);
    const since = expectStatus(await undoGroup(ada, again.runId), 200) as AssistantRunUndone;
    assert.deepEqual([since.undone, since.changes[0]!.message], [0, 'Changed since. Open it']);
    assert.equal((await doc(docId)).body, 'Four hours, thrice, by hand.');
    // Another page has only its own.
    const otherDoc = toolValue(await f.tool('flux_create_doc', { ...base(), doc: { title: 'Other notes', body: 'x' } }));
    assert.deepEqual((await linesOf(ada, 'doc', String(otherDoc.docId))).map((item) => item.operation), ['doc.create']);
  });

  test('a map the client made lists its own changes and its thoughts\' and links\'; the line outlives the thought Undo removed', async () => {
    const created = toolValue(await f.tool('flux_create_map', { ...base(), title: 'Comparison map' }));
    const mapId = String(created.mapId);
    const other = toolValue(await f.tool('flux_create_map', { ...base(), title: 'Another map' }));
    const thought = toolValue(await f.tool('flux_add_thought', { ...base(), mapId, thought: { text: 'Measure', x: 0, y: 0 } }));
    toolValue(await f.tool('flux_add_thought', { ...base(), mapId: String(other.mapId), thought: { text: 'Elsewhere', x: 0, y: 0 } }));
    const second = toolValue(await f.tool('flux_add_thought', { ...base(), mapId, thought: { text: 'Compare', x: 240, y: 0, linkFrom: { thoughtId: thought.thoughtId, label: 'then' } } }));
    toolValue(await f.tool('flux_rename_map', { ...base(), mapId, expectedVersion: Number(created.version), title: 'Measured map' }));

    const lines = await linesOf(ada, 'map', mapId);
    assert.deepEqual(lines.map((item) => [item.operation, item.objectType]),
      [['map.create', 'map'], ['map.thought.create', 'thought'], ['map.thought.create', 'thought'], ['map.rename', 'map']]);
    assert.ok(lines.every((item) => item.via === 'Claude Code' && item.runId === item.id));
    assert.deepEqual((await linesOf(ada, 'map', String(other.mapId))).map((item) => item.operation), ['map.create', 'map.thought.create']);
    assert.deepEqual(await linesOf(ada, 'doc', mapId), []);

    // Undo the second thought: the thought is gone, yet its line stays on the map, struck through.
    const removable = lines[2]!;
    assert.equal(removable.undoable, true);
    expectStatus(await undoGroup(ada, removable.runId), 200);
    assert.equal((await sketch(mapId)).thoughts.some((item) => item.id === second.thoughtId), false);
    assert.deepEqual((await linesOf(ada, 'map', mapId)).map((item) => item.state), ['applied', 'applied', 'undone', 'applied']);
    // Jonas sees the same lines and may take the rename back, but not the map the client made.
    const seen = await linesOf(jonas, 'map', mapId);
    assert.deepEqual(seen.map((item) => item.undoable), [false, true, false, true]);
  });
  test('a client\'s move on a map reads "Moved 1 thought", not "Moved thought 1 thought" (#1116)', async () => {
    const created = toolValue(await f.tool('flux_create_map', { ...base(), title: 'Moving map' }));
    const mapId = String(created.mapId);
    const first = toolValue(await f.tool('flux_add_thought', { ...base(), mapId, thought: { text: 'One', x: 0, y: 0 } }));
    const second = toolValue(await f.tool('flux_add_thought', { ...base(), mapId, thought: { text: 'Two', x: 240, y: 0 } }));
    const versions = new Map(((await sketch(mapId)) as unknown as { thoughts: { id: string; version: number }[] }).thoughts.map((item) => [item.id, item.version]));
    toolValue(await f.tool('flux_move_thoughts', { ...base(), mapId, moves: [{ id: String(first.thoughtId), x: 40, y: 40, expectedVersion: versions.get(String(first.thoughtId))! }] }));
    toolValue(await f.tool('flux_move_thoughts', { ...base(), mapId, moves: [
      { id: String(first.thoughtId), x: 80, y: 80, expectedVersion: versions.get(String(first.thoughtId))! + 1 },
      { id: String(second.thoughtId), x: 300, y: 80, expectedVersion: versions.get(String(second.thoughtId))! }] }));
    const moves = (await linesOf(ada, 'map', mapId)).filter((item) => item.operation === 'map.positions.update');
    assert.deepEqual(moves.map((item) => item.done), ['moved 1 thought', 'moved 2 thoughts']);
  });
});
