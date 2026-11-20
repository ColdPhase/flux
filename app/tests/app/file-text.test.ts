import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { conversationMessagePath, conversationPath, type Conversation, type SearchResponse, type SearchResult, type StagedFile } from '@flux/contracts';
import { startFileText } from '../../apps/worker/src/file-text/index.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { mcp, toolValue } from './support/mcp.js';
import { connectionString, db, pool } from './support/db.js';
import { createSealed, passphrase, unlock } from './support/encryption.js';
import { docxBytes, pdfBytes, pdfOfPictures, type PicturePage } from './support/file-text.js';
import { jpeg } from './support/pictures.js';
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

  test('every file is found by its name (#1424 B): a photo, a video and a spreadsheet, with no job; only who may read the space finds them', async () => {
    const tag = word('trip');
    const sent = await send(owner, spaceId, [
      { name: `IMG_2041 ${tag}.jpg`, bytes: jpeg() },
      { name: `Site walk ${tag}.mp4`, bytes: readFileSync(join(import.meta.dirname, '../ui/fixtures/video/clip.mp4')) },
      { name: `Budget ${tag}.xlsx`, bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]) },
    ]);
    // The rows are there the moment the message is sent, and nothing waits for the worker: their insides are never read.
    // A video and a spreadsheet get no job; a photo is read only by OCR when it is on (C-70), and this tiny one keeps nothing.
    assert.equal(await jobs(sent.fileIds.slice(1)), 0, 'no job for a video or a spreadsheet');
    for (const fileId of sent.fileIds) assert.deepEqual((await rowsOf(fileId)).map((row) => row.version), [0], 'the name row alone');
    assert.deepEqual(files(await search(reader, 'IMG_2041')).map(titleOf), [`IMG_2041 ${tag}.jpg`], 'the photo by its name');
    assert.deepEqual(files(await search(reader, 'site walk')).map(titleOf).filter((name) => name.includes(tag)), [`Site walk ${tag}.mp4`], 'the video by its name');
    const all = files(await search(owner, tag));
    assert.deepEqual(all.map(titleOf).sort(), [`Budget ${tag}.xlsx`, `IMG_2041 ${tag}.jpg`, `Site walk ${tag}.mp4`]);
    const photo = all.find((hit) => titleOf(hit).startsWith('IMG_2041'))!;
    assert.deepEqual({ ...photo.target }, { type: 'file', projectId: spaceId, conversationId: sent.conversation.id, messageId: sent.messageId, fileId: sent.fileIds[0]! },
      'a hit opens the message with the file');
    assert.equal(photo.label, 'File');
    assert.deepEqual((await search(outsider, tag)).items, [], 'a member outside the restricted space finds none of them');
  });

  test('a file nobody can read is finished without text and is still found by its name; a file of a kind that is not read has its name row only', async () => {
    const sent = await send(owner, spaceId, [
      { name: 'scanned-contract.pdf', bytes: pdfBytes(['']) },
      { name: 'broken-binary.txt', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0]) },
      { name: 'sheet.xlsx', bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]) },
    ]);
    await settled(sent.fileIds);
    assert.deepEqual((await rowsOf(sent.fileIds[0]!)).map((row) => row.version), [0], 'the name row alone');
    assert.deepEqual((await rowsOf(sent.fileIds[1]!)).map((row) => row.version), [0]);
    assert.deepEqual((await rowsOf(sent.fileIds[2]!)).map((row) => row.version), [0], 'a spreadsheet is not read: its name row alone');
    assert.deepEqual(files(await search(reader, 'scanned contract')).map(titleOf), ['scanned-contract.pdf']);
  });

  test('an encrypted space: no job and no text, and a file is found by its name only in the unlocked space, never from a visible column', async () => {
    const secret = passphrase();
    const sealed = (await createSealed(owner, 'File text garden', secret)).workspace;
    assert.equal((await unlock(owner.browser, sealed.id, { password: secret })).status, 200);
    const space = await project(owner, sealed.id, 'Beds', 'workspace');
    const name = word('gardennotes');
    const sent = await send(owner, space.id, [{ name: `${name}.pdf`, bytes: pdfBytes([`Hidden ${word('garden')}`]) }, { name: `${name} beds.jpg`, bytes: jpeg() }]);
    assert.equal(await jobs(sent.fileIds), 0, 'nothing is queued to be read');
    const rows = (await pool.query('SELECT version, sealed, title, body FROM search_documents WHERE kind = \'file\' AND object_id = ANY($1::text[]) ORDER BY object_id', [sent.fileIds])).rows;
    assert.deepEqual(rows, sent.fileIds.map(() => ({ version: 0, sealed: true, title: '', body: '' })), 'a placeholder name row each, with nothing in it');
    const plain = await pool.query('SELECT 1 FROM search_documents WHERE workspace_id = $1 AND (title LIKE $2 OR body LIKE $2)', [sealed.id, `%${name}%`]);
    assert.equal(plain.rowCount, 0, 'the name is in no visible column');
    // The in-memory index of the unlocked space finds both by their names, and opens their message.
    const found = files(await search(owner, name));
    assert.deepEqual(found.map(titleOf).sort(), [`${name} beds.jpg`, `${name}.pdf`]);
    const hit = found.find((item) => titleOf(item) === `${name}.pdf`)!;
    assert.deepEqual({ ...hit.target }, { type: 'file', projectId: space.id, conversationId: sent.conversation.id, messageId: sent.messageId, fileId: sent.fileIds[0]! });
    assert.deepEqual((await search(outsider, name)).items, [], 'and nobody outside the space finds them');
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
    // C-70: this worker reads scans and pictures by OCR, as the operator's FLUX_FILE_OCR=on does (the suites' own worker has it on too).
    worker = await startFileText({ db, connectionString, pauseMs: 0, env: { ...process.env, FLUX_FILE_OCR: 'on' } });
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

  test('C-69 (#1557): a PDF of pictures only is marked "no text" for people and gives an agent the pictures of its pages, a few a call', async () => {
    const pages: PicturePage[] = [{ kind: 'rgb', width: 2000, height: 1400 }, { kind: 'jpeg', bytes: jpeg(), width: 16, height: 8 },
      { kind: 'grey', width: 800, height: 600 }, { kind: 'grey', width: 400, height: 300 }];
    const sent = await send(lead, spaceId, [{ name: 'OH-mapa-pomyslow.pdf', bytes: pdfOfPictures(pages) }]);
    await settled(sent.fileIds);
    const fileId = sent.fileIds[0]!;
    assert.deepEqual((await pool.query('SELECT no_text FROM project_files WHERE id = $1', [fileId])).rows[0], { no_text: true });
    const kept = (await pool.query('SELECT page, width, height, png FROM file_page_pictures WHERE file_id = $1 ORDER BY page', [fileId])).rows as
      { page: number; width: number; height: number; png: Buffer }[];
    assert.deepEqual(kept.map((row) => [row.page, row.width, row.height]), [[1, 1568, 1098], [2, 16, 8], [3, 800, 600], [4, 400, 300]],
      'each page\'s picture, the long side at most 1,568 px');
    for (const row of kept) {
      assert.ok(row.png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'a PNG');
      assert.equal(row.png.readUInt32BE(16), row.width);
    }
    assert.equal(kept[0]!.png[25], 2, 'a colour page stays RGB');
    assert.equal(kept[2]!.png[25], 0, 'a grey scan is a grey PNG');
    // People: the message's file says it has no text.
    const thread = expectStatus(await member.browser.request('GET', conversationPath(sent.conversation.id)), 200) as Conversation;
    assert.equal(thread.messages[0]!.files?.[0]?.noText, true);

    // An agent (a local client sees pictures): the first three pages' pictures, then the fourth.
    const first = (await call('flux_read_file', { fileId })).message as { result: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean } };
    assert.notEqual(first.result.isError, true, JSON.stringify(first).slice(0, 500));
    const told = JSON.parse(first.result.content[0]!.text!) as { noText: boolean; nextOffset: number | null; note: string; body: string };
    assert.equal(told.noText, true);
    assert.equal(told.body, '');
    assert.equal(told.nextOffset, 3);
    assert.match(told.note, /^This PDF has no text \(a scan or a picture\)\. Pictures of pages 1, 2, 3 follow; continue with nextOffset/);
    const images = first.result.content.slice(1);
    assert.deepEqual(images.map((part) => [part.type, part.mimeType]), [['image', 'image/png'], ['image', 'image/png'], ['image', 'image/png']]);
    assert.ok(Buffer.from(images[0]!.data!, 'base64').equals(kept[0]!.png), 'the stored picture, as it is');
    const rest = (await call('flux_read_file', { fileId, offset: 3 })).message as { result: { content: { type: string; text?: string }[] } };
    assert.equal((JSON.parse(rest.result.content[0]!.text!) as { nextOffset: number | null }).nextOffset, null);
    assert.deepEqual(rest.result.content.slice(1).map((part) => part.type), ['image']);
    // Deleting the message deletes the file, and its pictures with it.
    const removed = await lead.browser.request('DELETE', conversationMessagePath(sent.conversation.id, sent.messageId));
    assert.ok(removed.status === 200 || removed.status === 204, removed.text);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM file_page_pictures WHERE file_id = $1', [fileId])).rows[0].n, 0);
  });

  test('C-70 (#1575): OCR reads a scan and a picture in Polish; people and agents find them by a word, flux_read_file reads their text, a landscape keeps nothing', async () => {
    // Fixtures (tests/app/fixtures/ocr, rendered with ImageMagick and DejaVu Sans, 2026-11-20): five lines of Polish with diacritics, as a PNG
    // and a JPEG, and a 400×300 plasma fractal with no text.
    const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'ocr', name));
    const scan = pdfOfPictures([{ kind: 'jpeg', bytes: fixture('faktura.jpg'), width: 1000, height: 420, grey: true }]);
    const sent = await send(lead, spaceId, [{ name: 'skan-faktury.pdf', bytes: scan }, { name: 'faktura.png', bytes: fixture('faktura.png') },
      { name: 'krajobraz.jpg', bytes: fixture('landscape.jpg') }]);
    const [pdfId, pngId, photoId] = sent.fileIds as [string, string, string];
    const state = async (id: string) => (await pool.query('SELECT ocr_state, no_text FROM project_files WHERE id = $1', [id])).rows[0] as { ocr_state: string | null; no_text: boolean };
    for (let waited = 0; ; waited += 200) {
      if ((await Promise.all(sent.fileIds.map(state))).every((row) => row.ocr_state !== null) && await jobs(sent.fileIds) === 0) break;
      assert.ok(waited < 120_000, `OCR did not read the files in time: ${JSON.stringify(await Promise.all(sent.fileIds.map(state)))}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.deepEqual(await state(pdfId), { ocr_state: 'text', no_text: false }, 'a scan with words is no longer "no text"');
    assert.deepEqual(await state(pngId), { ocr_state: 'text', no_text: false });
    assert.deepEqual(await state(photoId), { ocr_state: 'none', no_text: false }, 'a landscape keeps nothing');
    assert.deepEqual((await rowsOf(photoId)).map((row) => row.version), [0], 'its name row alone');
    // People: search finds both by a Polish word with diacritics, the scan at its page.
    for (const q of ['kalibratorów', 'płatności']) {
      const found = files(await search(member, q));
      assert.deepEqual(found.map(titleOf).sort(), ['faktura.png', 'skan-faktury.pdf'], q);
    }
    // An agent's own search (point 2): the scan is a file hit with its page.
    const hits = (toolValue((await call('flux_search', { q: 'kalibratorów', kind: 'file' })).message) as unknown as { results: Hit[] }).results;
    assert.deepEqual(hits.map((hit) => hit.title).sort(), ['faktura.png', 'skan-faktury.pdf']);
    assert.equal(hits.find((hit) => hit.title === 'skan-faktury.pdf')!.page, 1);
    // flux_read_file (point 1): the text, each page under [Page N], said to be OCR; no pictures when there is text.
    const pdfRead = (await call('flux_read_file', { fileId: pdfId })).message as { result: { content: { type: string; text?: string }[] } };
    assert.deepEqual(pdfRead.result.content.map((part) => part.type), ['text']);
    const pdfText = JSON.parse(pdfRead.result.content[0]!.text!) as { body: string; ocr: boolean; note: string; nextOffset: number | null };
    assert.equal(pdfText.ocr, true);
    assert.match(pdfText.body, /^\[Page 1\]\nFaktura nr 2026\/11\/17/);
    assert.match(pdfText.body, /Zażółć gęślą jaźń/);
    assert.match(pdfText.note, /^Flux read this text by OCR from a scan; \[Page N\] marks its pages\. It may contain mistakes\.$/);
    const pngText = toolValue((await call('flux_read_file', { fileId: pngId })).message) as unknown as { body: string; note: string };
    assert.match(pngText.body, /dostawa kalibratorów czujników/);
    assert.match(pngText.note, /^Flux read this text by OCR from the picture\./);
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
