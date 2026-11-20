import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { dmAiOffPath, dmFilesPath, searchTargetPath, type Dm, type DmMessage, type SearchResponse, type SearchResult, type StagedFile } from '@flux/contracts';
import { startFileText } from '../../apps/worker/src/file-text/index.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { mcp, toolValue } from './support/mcp.js';
import { connectionString, db, pool } from './support/db.js';
import { assistantScene, human, type AssistantScene } from './support/assistant-scene.js';
import { pdfBytes } from './support/file-text.js';
import { expectStatus, removeMember, type Person } from './support/people.js';

// #1590, C-64 (3): a file sent in a direct message follows its message. Its name and its text (OCR's too, C-70) are rows of the same search with the
// audience of the conversation's messages (`dm:<id>`, migration 0109), so only the conversation's current people find them, and an agent finds and reads
// them only inside a run in that conversation (`/ai` in it or in its thread), as it reads the messages (AG-4, AG-12).

const word = (tag: string) => `${tag}${randomUUID().replaceAll('-', '').replace(/\d/g, '').slice(0, 10)}`;
const titleOf = (result: SearchResult) => result.title.map((part) => part.text).join('');
const search = async (who: Person, q: string, extra = '') =>
  expectStatus(await who.browser.request('GET', `/api/v1/search?${new URLSearchParams({ q })}${extra}`), 200, 'search') as SearchResponse;
const found = async (who: Person, q: string, extra = '') => (await search(who, q, extra)).items.filter((item) => item.kind === 'file');
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'ocr', name));
const headers = (who: Person, extra: Record<string, string> = {}) => ({ cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin, ...extra });

async function upload(who: Person, dmId: string, name: string, bytes: Uint8Array) {
  const response = await fetch(new URL(`${dmFilesPath(dmId)}?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base),
    { method: 'POST', headers: headers(who, { 'content-type': 'application/octet-stream' }), body: Buffer.from(bytes) });
  assert.equal(response.status, 201, await response.clone().text());
  return await response.json() as StagedFile;
}
/** A message with these files in a direct message: the files are published with it. */
async function send(who: Person, dmId: string, attachments: { name: string; bytes: Uint8Array }[], body = '', rootId?: string) {
  const staged = await Promise.all(attachments.map((file) => upload(who, dmId, file.name, file.bytes)));
  const message = expectStatus(await who.browser.request('POST', rootId ? `/api/v1/dms/${dmId}/threads/${rootId}/replies` : `/api/v1/dms/${dmId}/messages`,
    { body: { body, clientMessageId: randomUUID(), attachmentIds: staged.map((file) => file.id) } }), 201) as DmMessage;
  return { messageId: message.id, fileIds: staged.map((file) => file.id) };
}
const jobs = async (fileIds: string[]) => (await pool.query('SELECT count(*)::int AS n FROM file_text_jobs WHERE file_id = ANY($1::uuid[])', [fileIds])).rows[0].n as number;
/** The worker has read every file: no job left, and a picture's OCR has answered (the suites' own worker reads them too, so this waits for whoever does). */
async function settled(fileIds: string[]) {
  for (let waited = 0; waited < 120_000; waited += 200) {
    const pending = (await pool.query(`SELECT count(*)::int AS n FROM project_files WHERE id = ANY($1::uuid[]) AND ocr_state IS NULL AND lower(name) ~ '[.](png|jpe?g)$'`, [fileIds])).rows[0].n as number;
    if (await jobs(fileIds) === 0 && pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`the worker did not read ${fileIds.join(', ')} in time`);
}
const rowsOf = async (fileId: string) => (await pool.query(`SELECT doc_key, audience_key, project_id, parent_id, version, page FROM search_documents WHERE kind = 'file' AND object_id = $1 ORDER BY version`, [fileId])).rows as
  { doc_key: string; audience_key: string; project_id: string | null; parent_id: string; version: number; page: number | null }[];

describe('the files of a direct message, found by its people and read by /ai in it (C-64 (3), #1590)', () => {
  let scene: AssistantScene;
  let worker: Awaited<ReturnType<typeof startFileText>>;
  let pair: Dm; let group: Dm; let other: Dm;
  let pdfWord: string; let textWord: string;
  let pdf: { messageId: string; fileId: string }; let notes: { fileId: string }; let picture: { fileId: string };
  const run = (dmId: string, threadRootId: string | null = null) => scene.runs.invoke(human(scene.owner), { kind: 'dm', dmId, threadRootId },
    { clientRunId: randomUUID(), kind: 'ask', prompt: 'What does the file say?' });
  /** A call of a run at `place`, the run ended after it so that the owner's lane is free for the next. */
  async function asRun<T>(place: { kind: 'dm'; dmId: string; threadRootId?: string | null } | { kind: 'chat' } | { kind: 'space' }, work: (call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown> | null>) => Promise<T>) {
    const started = place.kind === 'dm' ? await run(place.dmId, place.threadRootId ?? null)
      : place.kind === 'chat' ? await scene.runs.invoke(human(scene.owner), { kind: 'chat', agentId: scene.agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look in Flux' })
        : await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look in the space' });
    const live = await scene.liveOf(started.run.id);
    try { return await work(async (name, args) => (await live.raw('tools/call', { name, arguments: args })).message); } finally { await scene.complete(live.runId); }
  }
  const open = async (ids: string[], title?: string) => {
    const response = await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/dms`, { body: { participantIds: ids, ...(title ? { title } : {}) } });
    return expectStatus(response, response.status === 200 ? 200 : 201) as Dm;
  };
  const hits = (message: Record<string, unknown> | null) => (toolValue(message) as unknown as { results: { kind: string; id: string; title?: string; page?: number; messageId?: string; link: string; snippet?: string; place: { type: string; id: string } | null }[] }).results;

  before(async () => {
    scene = await assistantScene('dmfiles');
    // The suites' own worker reads files as they are sent; this one is the same code with OCR on, so the test does not depend on the other's pace.
    worker = await startFileText({ db, connectionString, pauseMs: 0, env: { ...process.env, FLUX_FILE_OCR: 'on' } });
    pair = await open([scene.peer.id]);
    group = await open([scene.peer.id, scene.viewer.id], 'Sensor group');
    other = await open([scene.admin.id]);
    [pdfWord, textWord] = [word('pdfword'), word('textword')];
    const sentPdf = await send(scene.owner, pair.id, [{ name: 'budget-plan.pdf', bytes: pdfBytes(['Opening page of the plan', `Second page names ${pdfWord} twice, ${pdfWord}.`]) },
      { name: 'notes.txt', bytes: Buffer.from(`Notes for Jonas: the ${textWord} section.\n`) }, { name: 'faktura.png', bytes: fixture('faktura.png') }], 'Here are the files');
    [pdf, notes, picture] = [{ messageId: sentPdf.messageId, fileId: sentPdf.fileIds[0]! }, { fileId: sentPdf.fileIds[1]! }, { fileId: sentPdf.fileIds[2]! }];
    await settled(sentPdf.fileIds);
  });
  beforeEach(async () => { await scene.reset(); });
  after(async () => { await worker.stop(); });

  test('a participant finds a word from the PDF, the text and the picture (OCR), and each file by its name; the rows are the conversation\'s, with no space', async () => {
    for (const who of [scene.peer, scene.owner]) {
      const byPdf = await found(who, pdfWord);
      assert.deepEqual(byPdf.map(titleOf), ['budget-plan.pdf'], 'the sender and the other person both find it');
      const [hit] = byPdf as [SearchResult];
      assert.equal(hit.label, 'File · page 2');
      assert.equal(hit.place.type, 'dm');
      assert.equal((hit.place as { id: string }).id, pair.id);
      assert.deepEqual(hit.target, { type: 'dm_file', dmId: pair.id, messageId: pdf.messageId, fileId: pdf.fileId, page: 2 });
      assert.equal(searchTargetPath(hit.target), `/dm/${pair.id}?file=${pdf.fileId}&page=2#message-${pdf.messageId}`);
      assert.match((hit.snippet ?? []).map((part) => part.text).join(''), new RegExp(pdfWord));
      assert.deepEqual((await found(who, textWord)).map(titleOf), ['notes.txt']);
      // C-70: with OCR on, the picture's words are its text.
      assert.deepEqual((await found(who, 'kalibratorów')).map(titleOf), ['faktura.png']);
      for (const [name, query] of [['budget-plan.pdf', 'budget plan'], ['notes.txt', 'notes'], ['faktura.png', 'faktura']] as const)
        assert.ok((await found(who, query)).some((item) => titleOf(item) === name), `${name} is found by its name`);
    }
    const rows = await rowsOf(pdf.fileId);
    assert.deepEqual(rows.map((row) => row.version), [0, 1, 2], 'the name, and a part for each page');
    for (const row of rows) assert.deepEqual([row.audience_key, row.project_id, row.parent_id], [`dm:${pair.id}`, null, pair.id]);
    assert.deepEqual((await rowsOf(picture.fileId)).map((row) => row.version), [0, 1], 'the picture\'s name and the text OCR read');
  });

  test('someone of the company who is not in the conversation gets nothing, from ⌘K and from the API, by the words or by the name', async () => {
    const attempts = [pdfWord, textWord, 'kalibratorów', 'budget plan', 'faktura'];
    for (const who of [scene.outsider, scene.lead, scene.admin, scene.viewer]) {
      for (const q of attempts) {
        assert.deepEqual(await found(who, q), [], `${who.id}: ${q}`);
        assert.deepEqual((await search(who, q, '&type=file')).items, [], `${who.id}: ${q} as a Files search`);
        assert.deepEqual((await search(who, q, `&place=dm:${pair.id}`)).items, [], `${who.id}: ${q} in that conversation`);
      }
    }
    // The people of another conversation find that one's files and not this one's.
    const sent = await send(scene.owner, other.id, [{ name: 'other.txt', bytes: Buffer.from(`Only for Admin ${word('otherword')}`) }]);
    await settled(sent.fileIds);
    assert.deepEqual((await found(scene.admin, 'other')).map(titleOf), ['other.txt']);
    assert.deepEqual(await found(scene.peer, 'other'), []);
  });

  test('/ai in the conversation (or in its thread) finds and reads the file; a run elsewhere cannot reach it', async () => {
    await asRun({ kind: 'dm', dmId: pair.id }, async (call) => {
      const [hit] = hits(await call('flux_search', { q: pdfWord, kind: 'file' }));
      assert.ok(hit, 'the run finds the file');
      assert.deepEqual([hit.kind, hit.id, hit.title, hit.page, hit.messageId], ['file', pdf.fileId, 'budget-plan.pdf', 2, pdf.messageId]);
      assert.equal(hit.place?.type, 'dm');
      assert.equal(hit.link, `/dm/${pair.id}?file=${pdf.fileId}&page=2#message-${pdf.messageId}`);
      assert.match(hit.snippet ?? '', new RegExp(`\\*\\*${pdfWord}\\*\\*`));
      const read = toolValue(await call('flux_read_file', { fileId: pdf.fileId })) as unknown as { body: string; dmId: string; messageId: string; nextOffset: number | null };
      assert.match(read.body, new RegExp(`Second page names ${pdfWord}`));
      assert.deepEqual([read.dmId, read.messageId, read.nextOffset], [pair.id, pdf.messageId, null]);
      // The picture's OCR text and a text file are read the same way, the OCR said to be OCR.
      const ocr = toolValue(await call('flux_read_file', { fileId: picture.fileId })) as unknown as { body: string; ocr?: boolean };
      assert.match(ocr.body, /dostawa kalibratorów czujników/);
      assert.equal(ocr.ocr, true);
      assert.match((toolValue(await call('flux_read_file', { fileId: notes.fileId })) as unknown as { body: string }).body, new RegExp(textWord));
    });
    // `/ai` in a thread of the conversation is a run in that conversation.
    await asRun({ kind: 'dm', dmId: pair.id, threadRootId: pdf.messageId }, async (call) => {
      assert.equal(hits(await call('flux_search', { q: textWord, kind: 'file' })).length, 1);
      assert.match((toolValue(await call('flux_read_file', { fileId: notes.fileId })) as unknown as { body: string }).body, new RegExp(textWord));
    });
    // The owner's private chat reads their conversations' files too (C-73, #1591), with the line "used AI here" there.
    await asRun({ kind: 'chat' }, async (call) => {
      assert.equal(hits(await call('flux_search', { q: pdfWord, kind: 'file' })).length, 1, 'chat: the PDF\'s word');
      assert.equal((toolValue(await call('flux_read_file', { fileId: pdf.fileId })) as unknown as { dmId: string }).dmId, pair.id);
    });
    // With AI off in the conversation (C-73), no run reads its files, in it or from the chat; people still find them.
    expectStatus(await scene.peer.browser.request('PUT', dmAiOffPath(pair.id)), 200);
    try {
      await asRun({ kind: 'chat' }, async (call) => {
        assert.deepEqual(hits(await call('flux_search', { q: pdfWord, kind: 'file' })), [], 'AI off: no hit');
        assert.equal(toolFailure(await call('flux_read_file', { fileId: pdf.fileId })).code, 'FILE_NOT_FOUND', 'AI off: nothing read');
      });
      await assert.rejects(run(pair.id), (error: { code?: string }) => error.code === 'DM_AI_OFF', '/ai there is refused');
    } finally { expectStatus(await scene.peer.browser.request('DELETE', dmAiOffPath(pair.id)), 200); }
    // A run in another conversation of the same owner and in a space find nothing and read nothing: one answer, as for a file that is not there.
    const elsewhere = [{ kind: 'dm' as const, dmId: group.id }, { kind: 'space' as const }];
    for (const place of elsewhere) {
      await asRun(place, async (call) => {
        assert.deepEqual(hits(await call('flux_search', { q: pdfWord })), [], `${place.kind}: no hit`);
        assert.deepEqual(hits(await call('flux_search', { q: 'kalibratorów', kind: 'file' })), [], `${place.kind}: no hit by OCR`);
        for (const fileId of [pdf.fileId, picture.fileId, notes.fileId]) assert.equal(toolFailure(await call('flux_read_file', { fileId })).code, 'FILE_NOT_FOUND', `${place.kind}: ${fileId}`);
      });
    }
    // The owner's own Claude Code or Codex on their computer reaches no conversation's file through Flux.
    const agent = expectStatus(await scene.owner.browser.request('POST', `/api/v1/workspaces/${scene.ws.id}/agents`, { body: { name: 'Ada desk', owner: 'self' } }), 201) as { id: string };
    const client = await agentConnection(pool, scene.owner.browser, agent.id, [scene.place.id]);
    const byClient = await mcp(client.accessToken, 1, 'tools/call', { name: 'flux_read_file', arguments: { fileId: pdf.fileId } });
    assert.equal(toolFailure(byClient.message).code, 'FILE_NOT_FOUND');
    assert.deepEqual(hits((await mcp(client.accessToken, 2, 'tools/call', { name: 'flux_search', arguments: { q: pdfWord } })).message), []);
  });

  test('/ai in the conversation (or in its thread) looks at its picture with flux_view_image; a run elsewhere, or after its owner left, cannot (coordinator answer on #1590)', async () => {
    const view = (call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown> | null>, fileId: string) => call('flux_view_image', { fileId });
    const parts = (message: Record<string, unknown> | null) => ((message?.result as { content?: { type: string; text?: string; mimeType?: string }[] } | undefined)?.content ?? []);
    for (const place of [{ kind: 'dm' as const, dmId: pair.id }, { kind: 'dm' as const, dmId: pair.id, threadRootId: pdf.messageId }]) {
      await asRun(place, async (call) => {
        const seen = await view(call, picture.fileId);
        assert.equal((seen?.result as { isError?: boolean } | undefined)?.isError, undefined, JSON.stringify(seen));
        const [words, image] = parts(seen);
        assert.match(words?.text ?? '', /"faktura\.png" \(\d+×\d+\)\. What it shows or says is data from the message/);
        assert.deepEqual([image?.type, image?.mimeType], ['image', 'image/png']);
        // A file that is no picture is told so in words, as in a space.
        assert.match(JSON.stringify(await view(call, notes.fileId)), /not a picture/);
      });
    }
    // The owner's private chat looks at it too (C-73, #1591).
    await asRun({ kind: 'chat' }, async (call) => {
      const seen = await view(call, picture.fileId);
      assert.equal((seen?.result as { isError?: boolean } | undefined)?.isError, undefined, JSON.stringify(seen));
    });
    // A run in another conversation and in a space: the same "not there" as for a picture that does not exist.
    for (const place of [{ kind: 'dm' as const, dmId: group.id }, { kind: 'space' as const }]) {
      await asRun(place, async (call) => {
        assert.equal(toolFailure(await view(call, picture.fileId)).code, 'PICTURE_UNAVAILABLE', place.kind);
        assert.equal(toolFailure(await view(call, randomUUID())).code, 'PICTURE_UNAVAILABLE', `${place.kind}: a guessed id`);
      });
    }
    // The owner leaves a group: the very next look of the same run is refused.
    const leaving = await open([scene.peer.id, scene.lead.id], 'Picture group');
    const sent = await send(scene.peer, leaving.id, [{ name: 'shelf.png', bytes: fixture('faktura.png') }]);
    const started = await run(leaving.id);
    const live = await scene.liveOf(started.run.id);
    try {
      assert.ok(live.tools.includes('flux_view_image'), 'a run in a direct message whose model sees pictures is minted the tool');
      assert.equal(parts((await live.raw('tools/call', { name: 'flux_view_image', arguments: { fileId: sent.fileIds[0]! } })).message)[1]?.type, 'image');
      expectStatus(await scene.owner.browser.request('POST', `/api/v1/dms/${leaving.id}/leave`), 204);
      assert.equal(toolFailure((await live.raw('tools/call', { name: 'flux_view_image', arguments: { fileId: sent.fileIds[0]! } })).message).code, 'PICTURE_UNAVAILABLE');
    } finally { await scene.complete(live.runId); }
  });

  test('a run in a conversation whose owner has left it reads nothing: the file is read by its owner only while they are one of its people', async () => {
    const leaving = await open([scene.peer.id, scene.lead.id], 'Leaving group');
    const sent = await send(scene.peer, leaving.id, [{ name: 'group-note.txt', bytes: Buffer.from(`Group note ${word('groupword')}`) }]);
    await settled(sent.fileIds);
    const started = await run(leaving.id);
    const live = await scene.liveOf(started.run.id);
    try {
      const read = (await live.raw('tools/call', { name: 'flux_read_file', arguments: { fileId: sent.fileIds[0]! } })).message;
      assert.match((toolValue(read) as unknown as { body: string }).body, /Group note/, 'while the owner is one of its people');
      expectStatus(await scene.owner.browser.request('POST', `/api/v1/dms/${leaving.id}/leave`), 204);
      assert.equal(toolFailure((await live.raw('tools/call', { name: 'flux_read_file', arguments: { fileId: sent.fileIds[0]! } })).message).code, 'FILE_NOT_FOUND',
        'the very next read of the same run, once its owner left');
      assert.deepEqual(hits((await live.raw('tools/call', { name: 'flux_search', arguments: { q: 'group note', kind: 'file' } })).message), []);
    } finally { await scene.complete(live.runId); }
  });

  test('a group\'s members find its file; a member who leaves, and a person removed from the company, find nothing from then on', async () => {
    const groupWord = word('groupfile');
    const sent = await send(scene.peer, group.id, [{ name: 'group-plan.txt', bytes: Buffer.from(`The ${groupWord} plan of the group`) }]);
    await settled(sent.fileIds);
    for (const who of [scene.owner, scene.peer, scene.viewer]) assert.deepEqual((await found(who, groupWord)).map(titleOf), ['group-plan.txt'], who.id);
    assert.deepEqual(await found(scene.outsider, groupWord), []);
    // The viewer leaves the group.
    expectStatus(await scene.viewer.browser.request('POST', `/api/v1/dms/${group.id}/leave`), 204);
    assert.deepEqual(await found(scene.viewer, groupWord), [], 'a member who left finds nothing, the very next search');
    assert.deepEqual(await found(scene.viewer, 'group plan'), []);
    assert.deepEqual((await found(scene.peer, groupWord)).map(titleOf), ['group-plan.txt'], 'the others still do');
    // The conversation's other person is removed from the company: nothing of it is theirs any more.
    await removeMember(scene.lead, scene.ws.id, scene.admin);
    assert.deepEqual(await found(scene.admin, 'other'), [], 'a person removed from the company loses the conversation\'s files with it');
    assert.equal((await pool.query(`SELECT 1 FROM search_documents WHERE kind = 'file' AND object_id = $1`, [sent.fileIds[0]!])).rows.length, 2, 'the rows stay for those who remain');
  });

  test('deleting the message removes its file\'s results, for people and for a run in the conversation', async () => {
    const goneWord = word('goneword');
    const sent = await send(scene.owner, pair.id, [{ name: 'gone.txt', bytes: Buffer.from(`This ${goneWord} is removed with its message`) }], 'to be deleted');
    await settled(sent.fileIds);
    assert.deepEqual((await found(scene.peer, goneWord)).map(titleOf), ['gone.txt']);
    expectStatus(await scene.owner.browser.request('DELETE', `/api/v1/dms/${pair.id}/messages/${sent.messageId}`), 200);
    for (const who of [scene.peer, scene.owner]) {
      assert.deepEqual(await found(who, goneWord), [], 'the words are gone with the message');
      assert.deepEqual(await found(who, 'gone'), [], 'and so is the name');
    }
    assert.equal((await rowsOf(sent.fileIds[0]!)).length, 0);
    await asRun({ kind: 'dm', dmId: pair.id }, async (call) => {
      assert.deepEqual(hits(await call('flux_search', { q: goneWord, kind: 'file' })), []);
      assert.equal(toolFailure(await call('flux_read_file', { fileId: sent.fileIds[0]! })).code, 'FILE_NOT_FOUND');
    });
  });

  test('v0.2.1\'s files of a conversation, which have no row, get their name rows and are queued by the migration, and their text is read after the upgrade (OCR through the bounded batch)', async () => {
    const earlierWord = word('earlier');
    const sent = await send(scene.owner, pair.id, [{ name: 'earlier.txt', bytes: Buffer.from(`Written in v0.2.1 ${earlierWord}`) }, { name: 'earlier.png', bytes: fixture('faktura.png') }]);
    const [textId, pictureId] = sent.fileIds as [string, string];
    await settled(sent.fileIds);
    // As v0.2.1 left them: no rows, no job, never read by OCR.
    await pool.query(`DELETE FROM search_documents WHERE kind = 'file' AND object_id = ANY($1::text[])`, [sent.fileIds]);
    await pool.query(`UPDATE project_files SET ocr_state = NULL WHERE id = ANY($1::uuid[])`, [sent.fileIds]);
    assert.deepEqual(await found(scene.owner, earlierWord), []);
    // The migration's own statements for the files that are already there.
    const migration = readFileSync(join(import.meta.dirname, '../../packages/db/migrations/0109_dm_file_search.sql'), 'utf8');
    const backfill = migration.slice(migration.indexOf('-- The direct message files that are already there'));
    assert.ok(backfill.includes('INSERT INTO file_text_jobs') && backfill.includes('search_put'));
    // In one transaction no worker sees the rows before they are committed, so what the migration queued is read exactly.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(backfill);
      const named = (await client.query(`SELECT object_id, audience_key, version FROM search_documents WHERE kind = 'file' AND version = 0 AND object_id = ANY($1::text[])`, [sent.fileIds])).rows as
        { object_id: string; audience_key: string; version: number }[];
      assert.deepEqual(named.map((row) => [row.object_id, row.audience_key, row.version]).sort(), [[textId, `dm:${pair.id}`, 0], [pictureId, `dm:${pair.id}`, 0]].sort(), 'the name rows at once');
      const queued = (await client.query(`SELECT file_id::text FROM file_text_jobs WHERE file_id = ANY($1::uuid[])`, [sent.fileIds])).rows.map((row) => row.file_id as string);
      // A worker's own tick may have queued the picture for OCR meanwhile (its bounded batch); the migration queues readable kinds only.
      assert.ok(queued.includes(textId), 'the readable file is queued');
      assert.ok(!/file_ocr_picture|ocr/.test(backfill.replace(/--[^\n]*\n/g, '')), 'the migration queues no picture: OCR does, in its bounded batches');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
    assert.deepEqual((await found(scene.owner, 'earlier')).map(titleOf).sort(), ['earlier.png', 'earlier.txt'], 'found by name as soon as the upgrade ran');
    // The worker reads the queued file, and, its queue empty, takes the next batch of what OCR has yet to read: the picture.
    await worker.tick();
    await settled(sent.fileIds);
    assert.deepEqual((await found(scene.owner, earlierWord)).map(titleOf), ['earlier.txt']);
    assert.deepEqual((await found(scene.owner, 'kalibratorów')).map(titleOf).sort(), ['earlier.png', 'faktura.png'], 'the picture was read by OCR');
    assert.equal((await pool.query('SELECT ocr_state FROM project_files WHERE id = $1', [pictureId])).rows[0].ocr_state, 'text');
  });
});
