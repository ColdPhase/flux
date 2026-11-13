import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import { assistantChangeActionPath, assistantRunShowPath, filePath, type ShowAnswerResult } from '@flux/contracts';
import { type PersonalComputeResult } from '@flux/core';
import { pool } from './support/db.js';
import { expectStatus } from './support/people.js';
import { assistantScene, changesOf, human, result, text, type AssistantScene } from './support/assistant-scene.js';

// An agent attaches a file to its answer (#1437, RT-5, AG-8), on the real /mcp route with a run's token and through the real worker loop with
// a fake provider: an API-key run gives a text file's content (a run on the owner's Claude Code or Codex names a file of its scratch instead,
// proved on the runtime's real networks by step 9e of scripts/check_agent_runtime.sh). The file goes through the asker's own upload path,
// staged for the asker alone, with its change line, waits and Undo, until Show everyone posts it with the answer.

const usage = { inputTokens: 300, outputTokens: 20 };
const calls = (...list: { name: string; input: Record<string, unknown> }[]): PersonalComputeResult => ({ kind: 'completed', text: 'working', stopReason: 'tool_use', usage,
  toolCalls: list.map((call, index) => ({ id: `call-${index}-${randomUUID()}`, name: call.name, input: call.input })) });
const answer = (words: string): PersonalComputeResult => ({ kind: 'completed', text: words, stopReason: 'end_turn', usage });
const stagedFor = async (userId: string) => (await pool.query(`SELECT id, name, size, message_id FROM project_files WHERE uploader_id = $1 AND message_id IS NULL ORDER BY created_at`,
  [userId])).rows as { id: string; name: string; size: number; message_id: string | null }[];
const fileChanges = async (runId: string) => (await changesOf(runId)).filter((row) => row.operation === 'answer.file.attach');
const download = async (who: AssistantScene['owner'], id: string) => {
  const response = await fetch(new URL(filePath(id), who.browser.base), { headers: { cookie: who.browser.cookieHeader() } });
  return { status: response.status, text: Buffer.from(await response.arrayBuffer()).toString('utf8') };
};
const PAGE = '<!doctype html><title>Lamp report</title><h1>Lamp sensor</h1><p>Fails below 5 lux.</p><script>alert(1)</script>';

describe('flux_attach_file: an agent attaches a file to its answer like its asker\'s own upload (#1437)', () => {
  let scene: AssistantScene;
  before(async () => { scene = await assistantScene('files'); });
  beforeEach(async () => {
    await scene.reset();
    scene.compute.dispatched.length = 0;
    await pool.query(`DELETE FROM project_files WHERE uploader_id = $1 AND message_id IS NULL`, [scene.owner.id]);
  });

  test('/ai "make a page of the report": an API-key run attaches an HTML file; the asker\'s alone until Show everyone, then every member opens it', async () => {
    const replies = [calls({ name: 'flux_attach_file', input: { clientCommandId: randomUUID(), name: 'lamp-report.html', content: PAGE } }),
      answer('Here is the report as a page.')];
    scene.compute.respond = async () => replies.shift()!;
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'make a page of the report' });
    assert.equal(await scene.processor.process(started.run.id), 'completed');
    assert.ok(scene.compute.dispatched[0]!.tools?.some((tool) => tool.name === 'flux_attach_file'), 'offered on /ai in a space');
    assert.match(scene.compute.dispatched[0]!.system, /attach it to your answer with flux_attach_file: its name with the extension and its content/);
    assert.match(JSON.stringify(scene.compute.dispatched[1]!.turns), /The file is attached to your answer/);
    const [change] = await fileChanges(started.run.id);
    assert.deepEqual([change!.state, change!.object_title], ['applied', 'lamp-report.html']);
    assert.deepEqual((await pool.query(`SELECT object_type FROM assistant_changes WHERE id = $1`, [change!.id])).rows, [{ object_type: 'file' }],
      'its own object type, not a picture (migration 0077)');
    const [file] = await stagedFor(scene.owner.id);
    assert.deepEqual([file!.name, file!.size, change!.object_id], ['lamp-report.html', Buffer.byteLength(PAGE), file!.id]);
    assert.deepEqual(await download(scene.owner, file!.id), { status: 200, text: PAGE }, 'the asker\'s own staged upload, as it was written');
    assert.equal((await download(scene.peer, file!.id)).status, 404, 'nobody else sees a private answer\'s file');
    const shown = expectStatus(await scene.owner.browser.request('POST', assistantRunShowPath(started.run.id)), 200) as ShowAnswerResult;
    assert.deepEqual((await pool.query(`SELECT id FROM project_files WHERE message_id = $1`, [shown.messageId])).rows, [{ id: file!.id }]);
    assert.equal((await download(scene.peer, file!.id)).status, 200, 'every member of the space opens it now');
    assert.equal((await download(scene.stranger, file!.id)).status, 404, 'and nobody outside the space');
  });

  test('a CSV and a Markdown file, Undo before Show everyone, and every refusal in plain words with nothing kept', async () => {
    const run = await scene.liveRun(undefined, 'export the tasks');
    const csv = await run.call('flux_attach_file', { name: 'tasks.csv', content: 'title,status\nCheck the camera,open\n' });
    assert.equal(result(csv.message)?.isError, undefined, text(csv.message));
    const md = await run.call('flux_attach_file', { name: 'notes.md', content: '# Notes\n\nFails below **5 lux**.\n' });
    assert.equal(result(md.message)?.isError, undefined, text(md.message));
    assert.deepEqual((await stagedFor(scene.owner.id)).map((file) => file.name), ['tasks.csv', 'notes.md']);
    const [first] = await fileChanges(run.runId);
    expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(first!.id, 'undo'), { body: {} }), 200);
    assert.deepEqual((await stagedFor(scene.owner.id)).map((file) => file.name), ['notes.md'], 'Undo removes the file');
    for (const [args, words] of [
      [{ name: 'x.txt', content: 'a', path: 'x.txt' }, /^Not attached\. Give either `path`/],
      [{ content: 'no name' }, /^Not attached\. Give the file a `name`/],
      [{ path: 'report.pdf' }, /^Not attached\. You have no working directory of your own here/],
      [{ name: '../escape.txt', content: 'x' }, /^Not attached\. /],
    ] as const) {
      const said = await run.call('flux_attach_file', args);
      assert.equal(result(said.message)?.isError, true, JSON.stringify(args));
      assert.match(text(said.message), words, text(said.message));
    }
    assert.deepEqual((await stagedFor(scene.owner.id)).map((file) => file.name), ['notes.md'], 'nothing refused was kept');
    await scene.complete(run.runId);
    const shown = expectStatus(await scene.owner.browser.request('POST', assistantRunShowPath(run.runId)), 200) as ShowAnswerResult;
    assert.deepEqual((await pool.query(`SELECT name FROM project_files WHERE message_id = $1`, [shown.messageId])).rows, [{ name: 'notes.md' }]);
  });

  test('Ask me first: the file is staged at once (the run\'s files go when it ends) and joins the answer only on Approve; Only read has no tool', async () => {
    await scene.setMayDo('ask');
    const run = await scene.liveRun(undefined, 'a page please');
    const said = await run.call('flux_attach_file', { name: 'page.html', content: PAGE });
    assert.match(text(said.message), /^Waiting for .+'s OK: attach file page\.html\./, text(said.message));
    const [waiting] = await fileChanges(run.runId);
    assert.equal(waiting!.state, 'waiting');
    assert.deepEqual((await stagedFor(scene.owner.id)).map((file) => file.name), ['page.html'], 'kept for the decision');
    await scene.complete(run.runId);
    expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(waiting!.id, 'apply'), { body: {} }), 200);
    assert.equal((await fileChanges(run.runId))[0]!.state, 'applied_after_wait');
    const shown = expectStatus(await scene.owner.browser.request('POST', assistantRunShowPath(run.runId)), 200) as ShowAnswerResult;
    assert.deepEqual((await pool.query(`SELECT name FROM project_files WHERE message_id = $1`, [shown.messageId])).rows, [{ name: 'page.html' }]);
    await scene.setMayDo('read');
    const reading = await scene.liveRun(undefined, 'a page please');
    assert.ok(!reading.tools.includes('flux_attach_file'), 'Only read: no tool');
    await scene.complete(reading.runId);
  });

  test('in the agent\'s private chat: the file is its answer\'s at once, only its owner opens it, and it shows with the run', async () => {
    const started = await scene.runs.invoke(human(scene.owner), { kind: 'chat', agentId: scene.agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'a page of my notes' });
    const run = await scene.liveOf(started.run.id);
    assert.ok(run.tools.includes('flux_attach_file'), 'the chat run has the tool');
    const command = randomUUID();
    const said = await run.call('flux_attach_file', { clientCommandId: command, name: 'notes.html', content: PAGE });
    assert.equal(result(said.message)?.isError, undefined, text(said.message));
    assert.match(text(said.message), /only your owner sees it/);
    assert.match(text(await run.call('flux_attach_file', { clientCommandId: command, name: 'notes.html', content: PAGE }).then((again) => again.message)), /"replayed":true/);
    const kept = (await pool.query(`SELECT id, name, size FROM personal_run_pictures WHERE run_id = $1`, [run.runId])).rows as { id: string; name: string; size: number }[];
    assert.deepEqual(kept.map((file) => [file.name, file.size]), [['notes.html', Buffer.byteLength(PAGE)]]);
    assert.deepEqual(await changesOf(run.runId), [], 'no change log in a chat: it changes nothing');
    assert.deepEqual(await stagedFor(scene.owner.id), [], 'no space\'s file');
    assert.deepEqual(await download(scene.owner, kept[0]!.id), { status: 200, text: PAGE });
    assert.equal((await download(scene.peer, kept[0]!.id)).status, 404, 'nobody else opens it');
    const video = await run.call('flux_attach_file', { name: 'clip.mp4', content: 'not a video' });
    assert.match(text(video.message), /^Not attached\. A video cannot be attached in this chat/);
    await scene.complete(run.runId);
    const view = await scene.runs.get(human(scene.owner), run.runId);
    assert.deepEqual(view.pictures, [{ id: kept[0]!.id, name: 'notes.html', size: Buffer.byteLength(PAGE) }]);
  });

  test('never in an encrypted space: refused in words, nothing staged', async () => {
    const run = await scene.liveRun(undefined, 'a file');
    const encrypted = async (value: boolean) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); await client.query('SET LOCAL session_replication_role = replica');
        await client.query('UPDATE workspaces SET encrypted = $2 WHERE id = $1', [scene.ws.id, value]); await client.query('COMMIT');
      } finally { client.release(); }
    };
    await encrypted(true);
    try {
      const said = await run.call('flux_attach_file', { name: 'a.txt', content: 'secret plan' });
      assert.match(text(said.message), /^Not attached\. This space is encrypted/);
      assert.deepEqual(await stagedFor(scene.owner.id), []);
    } finally { await encrypted(false); }
    await scene.complete(run.runId);
  });
});
