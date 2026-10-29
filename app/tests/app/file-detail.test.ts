import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, Project, StagedFile, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';

// File detail (#469, F-026 §6): the server reads pages, data rows or playing time from the bytes at upload, stores them with the
// file and shows them on the staged file and on the message's file, so "type · detail · size" is true for every reader.

const text = (value: string) => Buffer.from(value, 'latin1');
const pdf = text('%PDF-1.4\n1 0 obj\n<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>\nendobj\n2 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n%%EOF');
const csv = text('bed,reading\nfar east,-112\nnear,-80\nhedge,-95\n');
function wav(seconds: number) {
  const rate = 8000;
  const data = Buffer.alloc(seconds * rate * 2);
  const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const u16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
  return Buffer.concat([text('RIFF'), u32(36 + data.length), text('WAVEfmt '), u32(16), u16(1), u16(1), u32(rate), u32(rate * 2), u16(2), u16(16), text('data'), u32(data.length), data]);
}

describe('file detail', () => {
  let ada: Person;
  let jonas: Person;
  let ws: Workspace;
  let place: Project;

  const upload = async (who: Person, name: string, bytes: Buffer, uploadId = randomUUID()) => {
    const response = await fetch(new URL(`/api/v1/projects/${place.id}/files?uploadId=${uploadId}&name=${encodeURIComponent(name)}`, who.browser.base), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin }, body: new Uint8Array(bytes) });
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as StagedFile;
  };

  before(async () => {
    [ada, jonas] = await Promise.all(['detail-ada', 'detail-jonas'].map(person));
    ws = await workspace(ada, 'Detail');
    await addMember(ada, ws.id, jonas, 'member');
    place = await project(ada, ws.id, 'Garden sensors', 'workspace');
  });

  test('a PDF, a table and a voice note carry pages, rows and duration from staging to every reader of the message', async () => {
    const staged = {
      pdf: await upload(ada, 'probe-v2-drawing.pdf', pdf),
      csv: await upload(ada, 'lora-range-far-beds.csv', csv),
      wav: await upload(ada, 'voice-note.wav', wav(3)),
      plain: await upload(ada, 'notes.txt', text('a,b\n1,2\n')),
      liar: await upload(ada, 'not-really.pdf', text('hello world')),
    };
    assert.equal(staged.pdf.pages, 2);
    assert.equal(staged.csv.rows, 3, 'the header line is not a row');
    assert.equal(staged.wav.durationMs, 3000);
    for (const bare of [staged.plain, staged.liar]) assert.deepEqual(['pages', 'rows', 'durationMs'].filter((key) => key in bare), [], 'a name alone sets nothing');
    const conversation = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, { body: {
      body: 'Drawing, readings and a note', clientMessageId: randomUUID(), attachmentIds: Object.values(staged).map((file) => file.id) } }), 201) as Conversation;
    const files = conversation.messages[0]!.files!;
    assert.deepEqual(files.map((file) => [file.name, file.pages, file.rows, file.durationMs]), [
      ['probe-v2-drawing.pdf', 2, undefined, undefined], ['lora-range-far-beds.csv', undefined, 3, undefined], ['voice-note.wav', undefined, undefined, 3000],
      ['notes.txt', undefined, undefined, undefined], ['not-really.pdf', undefined, undefined, undefined]]);
    const read = expectStatus(await jonas.browser.request('GET', `/api/v1/conversations/${conversation.id}`), 200) as Conversation;
    assert.deepEqual(read.messages[0]!.files, files);
    const stored = await pool.query('SELECT name, page_count, row_count, duration_ms FROM project_files WHERE message_id = $1 ORDER BY position', [conversation.messages[0]!.id]);
    assert.deepEqual(stored.rows.map((row) => [row.name, row.page_count, row.row_count, row.duration_ms]),
      [['probe-v2-drawing.pdf', 2, null, null], ['lora-range-far-beds.csv', null, 3, null], ['voice-note.wav', null, null, 3000], ['notes.txt', null, null, null], ['not-really.pdf', null, null, null]]);
  });

  test('the same upload again returns the same staged file with its detail', async () => {
    const uploadId = randomUUID();
    const first = await upload(ada, 'again.pdf', pdf, uploadId);
    const again = await upload(ada, 'again.pdf', pdf, uploadId);
    assert.deepEqual(again, first);
    assert.equal(again.pages, 2);
  });
});
