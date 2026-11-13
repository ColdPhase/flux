import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { agentChatFilesPath, type MessageFile, type StagedFile } from '@flux/contracts';
import { CHAT_FILES_LINE } from '@flux/core';
import { fileTextRows } from '@flux/db';
import { diskFileStorage } from '../../apps/server/src/files/storage.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { db, pool } from './support/db.js';
import { expectStatus, removeMember, type Person } from './support/people.js';
import { assistantScene, human, result, text, type AssistantScene } from './support/assistant-scene.js';
import { png } from './support/pictures.js';
import { agentConnection } from './support/mcp-actions.js';
import { mcp } from './support/mcp.js';
import { startPiRuntime, type PiRuntime } from './support/pi-runtime.js';

// Files, photos and videos in an agent's private chat (#1438 point 10, C-64 point 4): the owner stages them in the chat and sends them with a
// request; only the owner reaches them, and only a run of that chat reads them (flux_view_image, flux_read_file). No space, direct message,
// search or other run sees them.

const filesDir = process.env.FLUX_TEST_FILES_DIR ?? '/data/files';
const headers = (who: Person, extra: Record<string, string> = {}) => ({ cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin, ...extra });
/** A request that was never dispatched ends as Stop leaves it: it no longer holds the owner's lane. */
const end = (runId: string) => pool.query(`UPDATE personal_runs SET status = 'stopped', completed_at = now(), cost_state = 'released', charged_micros = 0 WHERE id = $1`, [runId]);
const download = (who: Person, fileId: string) => fetch(new URL(`/api/v1/files/${fileId}`, who.browser.base), { headers: headers(who) });

async function stage(who: Person, path: string, name: string, bytes: Uint8Array) {
  const response = await fetch(new URL(`${path}?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base),
    { method: 'POST', headers: headers(who, { 'content-type': 'application/octet-stream' }), body: Buffer.from(bytes) });
  return { status: response.status, body: await response.json() as StagedFile & { code?: string } };
}

describe('files in an agent\'s private chat', () => {
  let scene: AssistantScene;
  let runs: ReturnType<typeof personalRunUseCases>;
  let pi: PiRuntime;
  const chat = () => ({ kind: 'chat' as const, agentId: scene.agentId });
  before(async () => {
    // An API-key agent runs in pi in the agent runtime (#1441, RT-1); its model is a scripted stand-in for Flux's model gateway.
    pi = await startPiRuntime();
    scene = await assistantScene('chatfiles', { pi });
    // The API's own composition, with the files volume: a request in a chat may carry files.
    runs = personalRunUseCases(db, { queue: scene.queue.factory, connections: scene.connections, providerEnabled: true, storage: await diskFileStorage(filesDir) });
  });
  beforeEach(async () => { await scene.reset(); });
  after(async () => { await pi.close(); });

  test('the owner stages a file in the chat and sends it with a request; it is theirs alone and no space\'s', async () => {
    const photo = await stage(scene.owner, agentChatFilesPath(scene.agentId), 'bed.png', png(64, 48, { metadata: true }));
    assert.equal(photo.status, 201, JSON.stringify(photo.body));
    assert.equal(photo.body.agentId, scene.agentId);
    assert.equal(photo.body.projectId, undefined);
    // Another person, even one who shares the space, can neither stage in the owner's chat nor read the file.
    assert.equal((await stage(scene.peer, agentChatFilesPath(scene.agentId), 'mine.txt', Buffer.from('x'))).status, 404);
    assert.equal((await download(scene.peer, photo.body.id)).status, 404);
    assert.equal((await download(scene.owner, photo.body.id)).status, 200);
    const notes = await stage(scene.owner, agentChatFilesPath(scene.agentId), 'notes.txt', Buffer.from('The pump runs at 40 percent.'));
    const started = await runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: 'What do these say?', attachmentIds: [photo.body.id, notes.body.id] });
    assert.deepEqual(started.run.files?.map((file) => file.name), ['bed.png', 'notes.txt']);
    // Read back as the chat lists it.
    const listed = expectStatus(await scene.owner.browser.request('GET', `/api/v1/assistant-runs/${started.run.id}`), 200) as { files?: MessageFile[] };
    assert.deepEqual(listed.files?.map((file) => file.id), [photo.body.id, notes.body.id]);
    const rows = (await pool.query(`SELECT project_id, dm_id, agent_id, run_id, message_id FROM project_files WHERE id = $1`, [photo.body.id])).rows[0];
    assert.deepEqual(rows, { project_id: null, dm_id: null, agent_id: scene.agentId, run_id: started.run.id, message_id: null });
    assert.equal((await pool.query(`SELECT 1 FROM search_documents WHERE object_id = ANY($1)`, [[photo.body.id, notes.body.id]])).rows.length, 0, 'no search row');
    // Files alone are a request; nothing at all is not.
    const alone = await stage(scene.owner, agentChatFilesPath(scene.agentId), 'alone.txt', Buffer.from('only a file'));
    const filesOnly = await runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: '', attachmentIds: [alone.body.id] });
    assert.equal(filesOnly.run.prompt, '');
    assert.equal(filesOnly.run.files?.length, 1);
    await assert.rejects(runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: '' }), /prompt must be/);
    // A file goes once: sent again it is refused.
    await assert.rejects(runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: 'again', attachmentIds: [alone.body.id] }), /already attached/);
    for (const id of [started.run.id, filesOnly.run.id]) await end(id);
  });

  test('a request with files is refused outside the chat, and the chat takes no file of a space, of a direct message or of someone else', async () => {
    const own = await stage(scene.owner, agentChatFilesPath(scene.agentId), 'own.txt', Buffer.from('own'));
    await assert.rejects(runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'look', attachmentIds: [own.body.id] }),
      (error: Error & { code?: string }) => error.code === 'RUN_FILES_ONLY_IN_CHAT');
    const spaceFile = await stage(scene.owner, `/api/v1/projects/${scene.place.id}/files`, 'space.txt', Buffer.from('space'));
    const dm = expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/dms`, { body: { participantIds: [scene.peer.id] } }), 201) as { id: string };
    const dmFile = await stage(scene.owner, `/api/v1/dms/${dm.id}/files`, 'dm.txt', Buffer.from('dm'));
    const peers = await stage(scene.peer, `/api/v1/projects/${scene.place.id}/files`, 'peer.txt', Buffer.from('peer'));
    for (const id of [spaceFile.body.id, dmFile.body.id, peers.body.id, randomUUID()]) {
      await assert.rejects(runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: 'look', attachmentIds: [id] }),
        (error: Error & { code?: string }) => error.code === 'ATTACHMENT_UNAVAILABLE', id);
    }
    // Nor does a chat's file go into a space's message.
    const posted = await scene.owner.browser.request('POST', `/api/v1/conversations/${scene.thread.id}/messages`, { body: { body: 'leak?', clientMessageId: randomUUID(), attachmentIds: [own.body.id] } });
    assert.equal(posted.status, 404);
  });

  test('a run of the chat looks at the picture and reads the file; a run in the space reaches neither', async () => {
    const photo = await stage(scene.owner, agentChatFilesPath(scene.agentId), 'plot.png', png(40, 30));
    const notes = await stage(scene.owner, agentChatFilesPath(scene.agentId), 'plan.md', Buffer.from('# Plan\nWater on Mondays.'));
    const started = await runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: 'Read these', attachmentIds: [photo.body.id, notes.body.id] });
    // The worker reads a chat's file like a space's (C-63): queued when sent, its text kept for the chat only.
    assert.equal((await pool.query(`SELECT 1 FROM file_text_jobs WHERE file_id = $1`, [notes.body.id])).rows.length
      + (await pool.query(`SELECT 1 FROM agent_chat_file_text WHERE file_id = $1`, [notes.body.id])).rows.length > 0, true, 'queued for the worker');
    assert.equal(await fileTextRows(db).store(notes.body.id, [{ part: 1, page: null, text: '# Plan\nWater on Mondays.' }]), true);
    assert.equal((await pool.query(`SELECT 1 FROM search_documents WHERE object_id = $1`, [notes.body.id])).rows.length, 0, 'never a search row');
    const live = await scene.liveOf(started.run.id);
    assert.ok(live.tools.includes('flux_view_image') && live.tools.includes('flux_read_file'), live.tools.join(','));
    const seen = await live.raw('tools/call', { name: 'flux_view_image', arguments: { fileId: photo.body.id } });
    assert.equal(result(seen.message)?.isError, undefined, text(seen.message));
    const read = await live.raw('tools/call', { name: 'flux_read_file', arguments: { fileId: notes.body.id } });
    assert.match(text(read.message), /Water on Mondays/);
    await scene.complete(started.run.id);
    // A run in the space has neither, and is told the same as for a file that is not there.
    const space = await scene.liveRun(undefined, 'look at the plot');
    assert.match(text((await space.raw('tools/call', { name: 'flux_view_image', arguments: { fileId: photo.body.id } })).message), /There is no picture with that id/);
    const unread = await space.raw('tools/call', { name: 'flux_read_file', arguments: { fileId: notes.body.id } });
    assert.equal(result(unread.message)?.isError, true);
    assert.doesNotMatch(text(unread.message), /Mondays/);
    await scene.complete(space.runId);
  });

  test('the run is told the files with their ids, and the model in pi looks at the picture it asks for', async () => {
    const photo = await stage(scene.owner, agentChatFilesPath(scene.agentId), 'leaf.png', png(32, 32));
    pi.gateway.script([{ tool: 'mcp__flux__flux_view_image', args: { fileId: photo.body.id } }, { text: 'A green leaf.' }]);
    const started = await runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: 'What is it?', attachmentIds: [photo.body.id] });
    assert.equal(await scene.processor!.process(started.run.id), 'completed', JSON.stringify(pi.lastPi()));
    const [first, second] = pi.gateway.requests;
    assert.ok(first!.prompt.includes(`<attachment name="leaf.png" bytes="${photo.body.size}" id="${photo.body.id}"/>`), first!.prompt.slice(-600));
    assert.ok(first!.prompt.includes(CHAT_FILES_LINE));
    assert.match(second!.results[0] ?? '', /leaf\.png/, 'the model is given the picture it asked for');
    // The next request in the chat is told the earlier exchange's file too.
    pi.gateway.script([{ text: 'Still a leaf.' }]);
    const next = await runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: 'And now?' });
    assert.equal(await scene.processor!.process(next.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.ok(pi.gateway.requests[0]!.prompt.includes(`id="${photo.body.id}"`), 'the earlier turn names its file');
  });

  test('no run of a direct message, of another agent\'s chat or of a local client reaches a chat\'s file, and deleting the agent deletes its files', async () => {
    const secret = await stage(scene.owner, agentChatFilesPath(scene.agentId), 'safe.txt', Buffer.from('The safe code is 4711.'));
    const kept = await runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: 'Keep this', attachmentIds: [secret.body.id] });
    assert.equal(await fileTextRows(db).store(secret.body.id, [{ part: 1, page: null, text: 'The safe code is 4711.' }]), true);
    await end(kept.run.id);
    const refused = async (live: Awaited<ReturnType<AssistantScene['liveOf']>>, label: string) => {
      const read = await live.raw('tools/call', { name: 'flux_read_file', arguments: { fileId: secret.body.id } });
      assert.equal(result(read.message)?.isError, true, label);
      assert.doesNotMatch(text(read.message), /4711/, label);
      await scene.complete(live.runId);
    };
    // A run in a direct message of the same owner (the one an earlier test opened, or a new one).
    const opened = await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/dms`, { body: { participantIds: [scene.peer.id] } });
    const dm = expectStatus(opened, opened.status === 200 ? 200 : 201) as { id: string };
    await refused(await scene.liveOf((await runs.invoke(human(scene.owner), { kind: 'dm', dmId: dm.id, threadRootId: null },
      { clientRunId: randomUUID(), kind: 'ask', prompt: 'What is the code?' })).run.id), 'a direct message\'s run');
    // A run in the chat of the owner's other agent.
    const newAgent = async (name: string) => (expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as { id: string }).id;
    const other = await newAgent('Ada second');
    await runs.enable(human(scene.owner), { agentId: other, connection: scene.connectionId, model: 'claude-sonnet-5' });
    await refused(await scene.liveOf((await runs.invoke(human(scene.owner), { kind: 'chat', agentId: other },
      { clientRunId: randomUUID(), kind: 'ask', prompt: 'What is the code?' })).run.id), 'another agent\'s chat run');
    // The owner's own Claude Code or Codex on their computer.
    const client = await agentConnection(pool, scene.owner.browser, await newAgent('Ada desk'), [scene.place.id]);
    const byClient = await mcp(client.accessToken, 1, 'tools/call', { name: 'flux_read_file', arguments: { fileId: secret.body.id } });
    assert.equal(result(byClient.message)?.isError, true);
    assert.doesNotMatch(text(byClient.message), /4711/);
    // Deleting the other agent (its row stays, revoked) takes its chat's files, sent and staged, and queues their bytes.
    const sent = await stage(scene.owner, agentChatFilesPath(other), 'sent.txt', Buffer.from('sent'));
    const staged = await stage(scene.owner, agentChatFilesPath(other), 'staged.txt', Buffer.from('staged'));
    await end((await runs.invoke(human(scene.owner), { kind: 'chat', agentId: other }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'keep', attachmentIds: [sent.body.id] })).run.id);
    expectStatus(await scene.owner.browser.request('DELETE', `/api/v1/my-agents/${other}`), 204);
    const ids = [sent.body.id, staged.body.id];
    assert.equal((await pool.query(`SELECT 1 FROM project_files WHERE id = ANY($1)`, [ids])).rows.length, 0, 'its files are gone');
    assert.equal((await pool.query(`SELECT 1 FROM file_garbage WHERE id = ANY($1)`, [ids])).rows.length, 2, 'their bytes are queued for removal');
    assert.equal((await download(scene.owner, sent.body.id)).status, 404);
    // The first agent's file is untouched.
    assert.equal((await download(scene.owner, secret.body.id)).status, 200);
  });

  test('a chat\'s files go with their run, and the owner removed from the company reaches none', async () => {
    const kept = await stage(scene.owner, agentChatFilesPath(scene.agentId), 'kept.txt', Buffer.from('kept'));
    const gone = await stage(scene.owner, agentChatFilesPath(scene.agentId), 'gone.txt', Buffer.from('gone'));
    const keep = await runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: 'keep', attachmentIds: [kept.body.id] });
    const drop = await runs.invoke(human(scene.owner), chat(), { clientRunId: randomUUID(), kind: 'ask', prompt: 'drop', attachmentIds: [gone.body.id] });
    for (const id of [keep.run.id, drop.run.id]) await end(id);
    await pool.query(`DELETE FROM personal_runs WHERE id = $1`, [drop.run.id]);
    assert.equal((await pool.query(`SELECT 1 FROM project_files WHERE id = $1`, [gone.body.id])).rows.length, 0);
    assert.equal((await pool.query(`SELECT 1 FROM file_garbage WHERE id = $1`, [gone.body.id])).rows.length, 1, 'its bytes are queued for removal');
    assert.equal((await download(scene.owner, kept.body.id)).status, 200);
    await removeMember(scene.lead, scene.ws.id, scene.owner);
    assert.equal((await download(scene.owner, kept.body.id)).status, 404);
    assert.equal((await stage(scene.owner, agentChatFilesPath(scene.agentId), 'late.txt', Buffer.from('late'))).status, 404);
  });
});
