import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Conversation, SearchResponse, SearchResult, StagedFile } from '@flux/contracts';
import { startFileText } from '../../apps/worker/src/file-text/index.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { mcp, toolValue } from './support/mcp.js';
import { connectionString, db, pool } from './support/db.js';
import { createSealed, passphrase, unlock } from './support/encryption.js';
import { docxBytes, pdfBytes } from './support/file-text.js';
import { addMember, expectStatus, grant, person, project, removeFromSpace, workspace, type Person } from './support/people.js';
import { ensureSpaceAiAllowed } from './support/space-ai.js';

// C-63, #1382: the text inside the files people send is found by ⌘K and by agents. The trigger of migration 0072 queues a file when its message is sent, the
// worker reads it in the sandbox and writes search rows with the audience of the file's message, and everything after that is the ordinary search: access
// at query time, one result for a file, nothing for who may not read the space, and nothing left when the file or its message or its space is removed.

const word = (tag: string) => `${tag}${randomUUID().replaceAll('-', '').replace(/\d/g, '').slice(0, 10)}`;
const titleOf = (result: SearchResult) => result.title.map((part) => part.text).join('');
const snippetOf = (result: SearchResult) => (result.snippet ?? []).map((part) => part.text).join('');
const search = async (who: Person, q: string, extra = '') =>
  expectStatus(await who.browser.request('GET', `/api/v1/search?${new URLSearchParams({ q })}${extra}`), 200, 'search') as SearchResponse;
const files = (answer: SearchResponse) => answer.items.filter((item) => item.kind === 'file');

async function upload(who: Person, projectId: string, name: string, bytes: Uint8Array) {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin }, body: Buffer.from(bytes) });
  assert.equal(response.status, 201, await response.clone().text());
  return await response.json() as StagedFile;
}
/** A message with these files in a new conversation of the space; the files are published with it. */
async function send(who: Person, projectId: string, attachments: { name: string; bytes: Uint8Array }[], body = '') {
  const staged = await Promise.all(attachments.map((file) => upload(who, projectId, file.name, file.bytes)));
  const conversation = expectStatus(await who.browser.request('POST', `/api/v1/projects/${projectId}/conversations`,
    { body: { body, attachmentIds: staged.map((file) => file.id), clientMessageId: randomUUID() } }), 201) as Conversation;
  return { conversation, messageId: conversation.messages[0]!.id, fileIds: staged.map((file) => file.id) };
}
const jobs = async (fileIds: string[]) => (await pool.query('SELECT count(*)::int AS n FROM file_text_jobs WHERE file_id = ANY($1::uuid[])', [fileIds])).rows[0].n as number;
async function settled(fileIds: string[]) {
  for (let waited = 0; waited < 90_000; waited += 100) {
    if (await jobs(fileIds) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`the worker did not read ${fileIds.join(', ')} in time`);
}
const rowsOf = async (fileId: string) => (await pool.query('SELECT version, page, title, length(body)::int AS chars FROM search_documents WHERE kind = \'file\' AND object_id = $1 ORDER BY version', [fileId])).rows as
  { version: number; page: number | null; title: string; chars: number }[];

describe('the text inside files, found by people and agents (C-63)', () => {
  let owner: Person; let reader: Person; let outsider: Person;
  let spaceId: string; let ws: { id: string };
  let worker: Awaited<ReturnType<typeof startFileText>>;

  before(async () => {
    [owner, reader, outsider] = await Promise.all(['File text owner', 'File text reader', 'File text outsider'].map(person));
    ws = await workspace(owner, 'File text company');
    await addMember(owner, ws.id, reader, 'member');
    await addMember(owner, ws.id, outsider, 'member');
    const space = await project(owner, ws.id, 'Contracts', 'restricted');
    spaceId = space.id;
    await grant(owner, spaceId, reader, 'contributor');
    await ensureSpaceAiAllowed(spaceId);
    worker = await startFileText({ db, connectionString, pauseMs: 0 });
  });
  after(async () => { await worker.stop(); });

  test('a PDF, a DOCX, a text and a CSV are found by what they say, with a snippet, the page and the message to open; whoever may not read the space finds nothing', async () => {
    const [pdfWord, docxWord, textWord, csvWord] = [word('pdfword'), word('docxword'), word('textword'), word('csvword')];
    const sent = await send(owner, spaceId, [
      { name: 'budget-plan.pdf', bytes: pdfBytes(['Opening page of the plan', `Second page names ${pdfWord} twice, ${pdfWord}.`]) },
      { name: 'Meeting notes.docx', bytes: docxBytes([`Agreed: ${docxWord}`], { table: [['owner', 'Ada']] }) },
      { name: 'readme.md', bytes: Buffer.from(`# Plan\n\nThe ${textWord} section.\n`) },
      { name: 'rows.csv', bytes: Buffer.from(`id,name\n1,${csvWord}\n2,Jonas\n`) },
    ]);
    // The name is searchable the moment the message is sent; the words are, once the worker has read the file.
    assert.deepEqual(files(await search(reader, 'budget plan')).map(titleOf), ['budget-plan.pdf']);
    await settled(sent.fileIds);
    for (const [query, name, fileId] of [[pdfWord, 'budget-plan.pdf', sent.fileIds[0]!], [docxWord, 'Meeting notes.docx', sent.fileIds[1]!], [textWord, 'readme.md', sent.fileIds[2]!], [csvWord, 'rows.csv', sent.fileIds[3]!]] as const) {
      for (const who of [owner, reader]) {
        const found = files(await search(who, query));
        assert.equal(found.length, 1, `${who.id === owner.id ? 'owner' : 'reader'} finds ${name} by ${query}`);
        const hit = found[0]!;
        assert.equal(titleOf(hit), name);
        assert.ok(snippetOf(hit).includes(query) && hit.snippet!.some((part) => part.match && part.text.includes(query)), `the snippet shows the match: ${snippetOf(hit)}`);
        assert.equal(hit.target.type, 'file');
        if (hit.target.type === 'file') assert.deepEqual({ ...hit.target }, { type: 'file', projectId: spaceId, conversationId: sent.conversation.id, messageId: sent.messageId, fileId, ...(name === 'budget-plan.pdf' ? { page: 2 } : {}) });
        assert.equal(hit.place.type, 'project');
      }
      assert.deepEqual((await search(outsider, query)).items, [], `a member outside the restricted space finds nothing of ${name}`);
    }
    assert.equal(files(await search(reader, pdfWord))[0]!.label, 'File · page 2');
    assert.deepEqual(files(await search(reader, textWord, '&type=file')).map(titleOf), ['readme.md'], 'the file filter');
    assert.deepEqual((await search(reader, textWord, '&type=doc')).items, [], 'and no other kind');
  });

  test('a file counts once however many of its parts match, and the part that matches best is the one shown', async () => {
    const common = word('common'); const rare = word('rare');
    const filler = (index: number) => `${'Lorem ipsum dolor sit amet consectetur. '.repeat(40)}${index}\n`;
    const long = Array.from({ length: 24 }, (_, index) => `${filler(index)}${index === 9 ? `A line with ${rare} ${rare} here.\n` : ''}${index % 3 === 0 ? `Mentions ${common}.\n` : ''}`).join('');
    const sent = await send(owner, spaceId, [{ name: 'long-report.txt', bytes: Buffer.from(long) }]);
    await settled(sent.fileIds);
    const parts = (await rowsOf(sent.fileIds[0]!)).filter((row) => row.version >= 1);
    assert.ok(parts.length >= 10, `${parts.length} parts`);
    assert.ok(parts.every((row) => row.chars <= 4000));
    const found = files(await search(reader, `${common} ${rare}`));
    assert.equal(found.length, 1, 'one result for the file');
    assert.ok(snippetOf(found[0]!).includes(rare), `the best part shows the rare word: ${snippetOf(found[0]!)}`);
    // The text is all there, in order: the read tool and the parts agree.
    const joined = (await pool.query('SELECT string_agg(body, \'\' ORDER BY version) AS text FROM search_documents WHERE kind = \'file\' AND object_id = $1 AND version >= 1', [sent.fileIds[0]!])).rows[0].text as string;
    assert.equal(joined, long.split('\n').map((line) => line.trim()).filter((line, index, all) => line || (index > 0 && all[index - 1])).join('\n').trim());
  });

  test('a file removed with its message, and a space that is deleted, leave nothing: no row, no job', async () => {
    const sent = await send(owner, spaceId, [{ name: 'to-remove.docx', bytes: docxBytes([`Gone: ${word('gone')}`]) }]);
    await settled(sent.fileIds);
    assert.ok((await rowsOf(sent.fileIds[0]!)).length >= 2, 'a name and a text row');
    const removed = await owner.browser.request('DELETE', `/api/v1/conversations/${sent.conversation.id}/messages/${sent.messageId}`);
    assert.ok(removed.status === 200 || removed.status === 204, removed.text);
    assert.deepEqual(await rowsOf(sent.fileIds[0]!), [], 'the rows went in the transaction that removed the file');

    const doomed = await project(owner, ws.id, 'Doomed', 'workspace');
    const inDoomed = await send(owner, doomed.id, [{ name: 'doomed.txt', bytes: Buffer.from(`doomed ${word('doomed')}`) }]);
    assert.equal((await rowsOf(inDoomed.fileIds[0]!)).length >= 1, true, 'its name row at once');
    await pool.query('DELETE FROM projects WHERE id = $1', [doomed.id]);
    assert.deepEqual(await rowsOf(inDoomed.fileIds[0]!), []);
    assert.equal(await jobs(inDoomed.fileIds), 0);
  });

  test('access is decided on every search: a grant lost and the very next search finds nothing', async () => {
    const lost = word('lost');
    const sent = await send(owner, spaceId, [{ name: 'lost-access.txt', bytes: Buffer.from(`Only readers: ${lost}`) }]);
    await settled(sent.fileIds);
    assert.equal(files(await search(reader, lost)).length, 1);
    await removeFromSpace(owner, spaceId, reader);
    assert.deepEqual((await search(reader, lost)).items, []);
    await grant(owner, spaceId, reader, 'contributor');
    assert.equal(files(await search(reader, lost)).length, 1, 'and again once the grant is back');
  });

  test('a file nobody can read is finished without text and is still found by its name; a file of a kind that is not read gets no row', async () => {
    const sent = await send(owner, spaceId, [
      { name: 'scanned-contract.pdf', bytes: pdfBytes(['']) },
      { name: 'broken-binary.txt', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0]) },
      { name: 'sheet.xlsx', bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]) },
    ]);
    await settled(sent.fileIds);
    assert.deepEqual((await rowsOf(sent.fileIds[0]!)).map((row) => row.version), [0], 'the name row alone');
    assert.deepEqual((await rowsOf(sent.fileIds[1]!)).map((row) => row.version), [0]);
    assert.deepEqual(await rowsOf(sent.fileIds[2]!), [], 'a spreadsheet is not read and has no row');
    assert.deepEqual(files(await search(reader, 'scanned contract')).map(titleOf), ['scanned-contract.pdf']);
  });

  test('an encrypted space is not indexed: no row and no job, not even for a name', async () => {
    const secret = passphrase();
    const sealed = (await createSealed(owner, 'File text garden', secret)).workspace;
    assert.equal((await unlock(owner.browser, sealed.id, { password: secret })).status, 200);
    const space = await project(owner, sealed.id, 'Beds', 'workspace');
    const sent = await send(owner, space.id, [{ name: 'garden-notes.pdf', bytes: pdfBytes([`Hidden ${word('garden')}`]) }]);
    assert.deepEqual(await rowsOf(sent.fileIds[0]!), []);
    assert.equal(await jobs(sent.fileIds), 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM search_documents WHERE workspace_id = $1 AND kind = \'file\'', [sealed.id])).rows[0].n, 0);
  });
});

describe('agents find the text inside files and read an excerpt of it (C-63)', () => {
  let lead: Person; let member: Person; let spaceId: string; let hiddenId: string;
  let token: string; let nextCall = 5000;
  let worker: Awaited<ReturnType<typeof startFileText>>;
  const call = (name: string, args: Record<string, unknown>) => mcp(token, nextCall++, 'tools/call', { name, arguments: args });
  type Hit = { kind: string; id: string; link: string; title?: string; snippet?: string; page?: number; messageId?: string; place: { type: string; id: string } | null };

  before(async () => {
    // The agent's owner is a plain member of the company: the restricted space is one they may not read, so their agent does not reach it either.
    [lead, member] = await Promise.all(['Agent file lead', 'Agent file member'].map(person));
    const ws = await workspace(lead, 'Agent file company');
    await addMember(lead, ws.id, member, 'member');
    spaceId = (await project(lead, ws.id, 'Agent files', 'workspace')).id;
    hiddenId = (await project(lead, ws.id, 'Agent hidden files', 'restricted')).id;
    await Promise.all([ensureSpaceAiAllowed(spaceId), ensureSpaceAiAllowed(hiddenId)]);
    const agent = expectStatus(await member.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Claude Code', owner: 'self' } }), 201) as { id: string };
    token = (await agentConnection(pool, member.browser, agent.id, [spaceId])).accessToken;
    worker = await startFileText({ db, connectionString, pauseMs: 0 });
  });
  after(async () => { await worker.stop(); });

  test('flux_search returns a file hit with its page, message and link, flux_read_file reads its text in pages, and a file of a space its owner may not read is not found', async () => {
    const known = word('clause'); const secret = word('secretclause');
    const body = `${'Preamble sentence of the contract. '.repeat(300)}\nThe ${known} says the sensors are calibrated every spring.\n${'Closing sentence of the contract. '.repeat(300)}`;
    const visible = await send(lead, spaceId, [{ name: 'contract.pdf', bytes: pdfBytes([`Cover page`, `Clause ${known} applies here.`]) }, { name: 'contract-full.txt', bytes: Buffer.from(body) }]);
    const hidden = await send(lead, hiddenId, [{ name: 'secret.txt', bytes: Buffer.from(`The ${secret} is hidden.`) }]);
    await settled([...visible.fileIds, ...hidden.fileIds]);
    const found = toolValue((await call('flux_search', { q: known, kind: 'file' })).message) as unknown as { results: Hit[] };
    assert.deepEqual(found.results.map((hit) => hit.title).sort(), ['contract-full.txt', 'contract.pdf']);
    const pdfHit = found.results.find((hit) => hit.title === 'contract.pdf')!;
    assert.equal(pdfHit.kind, 'file');
    assert.equal(pdfHit.id, visible.fileIds[0]);
    assert.equal(pdfHit.page, 2);
    assert.equal(pdfHit.messageId, visible.messageId);
    assert.match(pdfHit.snippet ?? '', new RegExp(`\\*\\*${known}\\*\\*`));
    assert.equal(pdfHit.link, `/projects/${spaceId}/conversations/${visible.conversation.id}?file=${visible.fileIds[0]}&page=2#message-${visible.messageId}`);
    assert.deepEqual((toolValue((await call('flux_search', { q: secret })).message) as unknown as { results: Hit[] }).results, [], 'a space the agent\'s owner may not read is not searched');

    const first = toolValue((await call('flux_read_file', { fileId: visible.fileIds[1] })).message) as unknown as
      { name: string; offset: number; totalLength: number; nextOffset: number | null; body: string; messageId: string };
    assert.equal(first.name, 'contract-full.txt');
    assert.equal(first.messageId, visible.messageId);
    assert.ok(first.totalLength > 20_000 && first.body.length <= 20_000 && first.nextOffset === first.body.length, `${first.totalLength} chars, page of ${first.body.length}`);
    let text = first.body; let next: number | null = first.nextOffset;
    while (next !== null) {
      const page = toolValue((await call('flux_read_file', { fileId: visible.fileIds[1], offset: next })).message) as unknown as { body: string; nextOffset: number | null; offset: number };
      assert.equal(page.offset, next);
      text += page.body; next = page.nextOffset;
    }
    assert.equal(text.length, first.totalLength, 'the pages add up to the whole text');
    assert.ok(text.includes(`The ${known} says the sensors are calibrated every spring.`));
    const pdfText = toolValue((await call('flux_read_file', { fileId: visible.fileIds[0] })).message) as unknown as { body: string; pages?: number; nextOffset: number | null };
    assert.match(pdfText.body, /Cover page\nClause /);
    assert.equal(pdfText.nextOffset, null);
    // A file of a space the connection does not reach, an unknown file and a file that is not a file are one answer.
    for (const fileId of [hidden.fileIds[0]!, randomUUID()]) assert.equal(toolFailure((await call('flux_read_file', { fileId })).message).code, 'FILE_NOT_FOUND');
  });

  test('a space whose AI is turned off is reached by nobody: its file is not read', async () => {
    const word1 = word('offline');
    const sent = await send(lead, spaceId, [{ name: 'offline.txt', bytes: Buffer.from(`Text ${word1} of the file`) }]);
    await settled(sent.fileIds);
    assert.equal(((toolValue((await call('flux_search', { q: word1 })).message) as unknown as { results: Hit[] }).results).length, 1);
    await pool.query(`UPDATE project_ai_policies SET state = 'blocked', epoch = epoch + 1 WHERE project_id = $1`, [spaceId]);
    try {
      assert.equal(toolFailure((await call('flux_read_file', { fileId: sent.fileIds[0] })).message).code, 'FILE_NOT_FOUND');
    } finally { await ensureSpaceAiAllowed(spaceId); }
  });
});
