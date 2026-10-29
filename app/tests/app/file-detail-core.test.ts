import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileDetailOf, pdfPages, readsDetail, tableRows } from '@flux/core';

// What the bytes of a file say about it (#469): pages, data rows, playing time. Each reader answers nothing rather than a guess.

const text = (value: string) => Buffer.from(value, 'latin1');
const u32 = (value: number, little = false) => { const b = Buffer.alloc(4); if (little) b.writeUInt32LE(value); else b.writeUInt32BE(value); return b; };
const u16le = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };

function wav(seconds: number, rate = 8000) {
  const data = Buffer.alloc(Math.round(seconds * rate * 2));
  const header = Buffer.concat([text('RIFF'), u32(36 + data.length, true), text('WAVEfmt '), u32(16, true), u16le(1), u16le(1), u32(rate, true), u32(rate * 2, true), u16le(2), u16le(16), text('data'), u32(data.length, true)]);
  return Buffer.concat([header, data]);
}
const box = (type: string, ...body: Buffer[]) => { const inner = Buffer.concat(body); return Buffer.concat([u32(8 + inner.length), text(type), inner]); };
const mp4 = (timescale: number, duration: number) => Buffer.concat([box('ftyp', text('M4A '), u32(0)), box('moov', box('mvhd', Buffer.alloc(4), u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80)))]);
function ogg(codec: 'opus' | 'vorbis', granule: number) {
  const page = (payload: Buffer, position: bigint) => { const header = Buffer.alloc(27); header.write('OggS', 0, 'latin1'); header.writeBigUInt64LE(position, 6); header[26] = 1; return Buffer.concat([header, Buffer.from([payload.length]), payload]); };
  const first = codec === 'opus' ? Buffer.concat([text('OpusHead'), Buffer.from([1, 1]), u16le(312), u32(48000, true), Buffer.alloc(3)])
    : Buffer.concat([Buffer.from([1]), text('vorbis'), u32(0, true), Buffer.from([1]), u32(44100, true), Buffer.alloc(8)]);
  return Buffer.concat([page(first, 0n), page(Buffer.alloc(20), BigInt(granule))]);
}
const ebml = (id: number[], body: Buffer) => Buffer.concat([Buffer.from(id), Buffer.from([0x80 | body.length]), body]);
function webm(milliseconds: number | null) {
  const duration = Buffer.alloc(8); duration.writeDoubleBE(milliseconds ?? 0);
  const info = ebml([0x15, 0x49, 0xa9, 0x66], Buffer.concat([ebml([0x2a, 0xd7, 0xb1], u32(1_000_000)), ...(milliseconds === null ? [] : [ebml([0x44, 0x89], duration)])]));
  return Buffer.concat([ebml([0x1a, 0x45, 0xdf, 0xa3], Buffer.alloc(2)), Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01]), Buffer.alloc(6), Buffer.from([info.length]), info])]);
}

describe('file detail from the bytes', () => {
  test('a PDF gives the page count of its tree, and nothing when the tree is not readable', () => {
    const pdf = (...objects: string[]) => text(`%PDF-1.4\n${objects.map((body, index) => `${index + 1} 0 obj\n${body}\nendobj\n`).join('')}trailer\n%%EOF`);
    assert.equal(pdfPages(pdf('<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R >>', '<< /Type /Page /Parent 2 0 R >>')), 2);
    // A nested tree: the root's /Count is the total, not the branch's.
    assert.equal(pdfPages(pdf('<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 5 >>', '<< /Type /Pages /Parent 1 0 R /Kids [] /Count 2 >>', '<< /Type /Pages /Parent 1 0 R /Kids [] /Count 3 >>')), 5);
    assert.equal(pdfPages(pdf('<< /Type /Page >>', '<< /Type /Page >>', '<< /Type /Page >>')), 3, 'leaf pages when there is no tree');
    assert.equal(pdfPages(pdf('<< /Type /Catalog >>')), undefined);
    assert.equal(pdfPages(text('not a pdf /Type /Pages /Count 9')), undefined);
    assert.deepEqual(fileDetailOf('probe-v2-drawing.pdf', pdf('<< /Type /Pages /Count 2 >>')), { pages: 2 });
  });

  test('no upload can stall the reader: hostile bytes of the largest size are read in linear time', () => {
    const five = 5 * 1024 * 1024;
    const started = Date.now();
    for (const filler of ['0', ' ', '0 ', '0 0 ', 'obj ', '/Type /Pages ', '1 0 obj ']) {
      const bytes = Buffer.concat([text('%PDF-1.4\n'), Buffer.from(filler.repeat(Math.ceil(five / filler.length)).slice(0, five), 'latin1')]);
      pdfPages(bytes);
      tableRows(bytes);
      for (const name of ['a.pdf', 'a.csv', 'a.wav', 'a.mp3', 'a.m4a', 'a.ogg', 'a.webm']) fileDetailOf(name, bytes);
    }
    assert.ok(Date.now() - started < 8000, `hostile bytes took ${Date.now() - started} ms`);
  });

  test('a table gives its data rows: the header is not one, a quoted line break does not split a row, and blank lines are not rows', () => {
    assert.equal(tableRows(text('name,value\nbed,1\nbed,2\n')), 2);
    assert.equal(tableRows(text('name,value\r\nbed,1\r\nbed,2')), 2, 'CRLF and no final newline');
    assert.equal(tableRows(text('name,note\nbed,"two\nlines"\nbed,x\n\n\n')), 2);
    assert.equal(tableRows(text('only,a,header')), 0);
    assert.equal(tableRows(text('')), undefined);
    assert.equal(tableRows(text('\xef\xbb\xbfa\tb\n1\t2\n')), 1, 'a byte order mark does not make an empty first line a record');
    assert.deepEqual(fileDetailOf('lora-range.CSV', text('a,b\n1,2\n3,4\n')), { rows: 2 });
    assert.deepEqual(fileDetailOf('lora-range.tsv', text('a\tb\n1\t2\n')), { rows: 1 });
  });

  test('audio gives its playing time from the container, never from the name', () => {
    assert.deepEqual(fileDetailOf('note.wav', wav(2.5)), { durationMs: 2500 });
    assert.deepEqual(fileDetailOf('note.m4a', mp4(1000, 42_000)), { durationMs: 42_000 });
    assert.deepEqual(fileDetailOf('note.mp4', mp4(44100, 44100 * 3)), { durationMs: 3000 });
    assert.deepEqual(fileDetailOf('note.opus', ogg('opus', 48000 * 3 + 312)), { durationMs: 3000 });
    assert.deepEqual(fileDetailOf('note.ogg', ogg('vorbis', 44100 * 2)), { durationMs: 2000 });
    assert.deepEqual(fileDetailOf('note.webm', webm(4500)), { durationMs: 4500 });
    assert.deepEqual(fileDetailOf('recording.webm', webm(null)), {}, 'a recording without a duration shows none');
    // 128 kbit/s constant rate: 16000 bytes is one second.
    const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(15_996)]);
    assert.deepEqual(fileDetailOf('note.mp3', mp3), { durationMs: 1000 });
    assert.deepEqual(fileDetailOf('note.mp3', Buffer.concat([text('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 5]), Buffer.alloc(5), mp3])), { durationMs: 1000 }, 'a tag in front is skipped');
    assert.deepEqual(fileDetailOf('note.wav', text('this is not audio')), {});
    assert.deepEqual(fileDetailOf('note.m4a', Buffer.alloc(40)), {});
  });

  test('a name alone sets nothing, and corrupt bytes never throw', () => {
    assert.deepEqual(fileDetailOf('report.pdf', text('hello')), {});
    assert.deepEqual(fileDetailOf('notes.txt', text('a,b\n1,2\n')), {});
    assert.deepEqual(fileDetailOf('photo.png', Buffer.alloc(100)), {});
    for (const name of ['a.pdf', 'a.csv', 'a.wav', 'a.mp3', 'a.m4a', 'a.ogg', 'a.webm']) {
      assert.doesNotThrow(() => fileDetailOf(name, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x01, 0x02])));
      assert.doesNotThrow(() => fileDetailOf(name, Buffer.alloc(0)));
    }
    assert.equal(readsDetail('x.PDF'), true);
    assert.equal(readsDetail('x.png'), false);
    assert.equal(readsDetail('pdf'), false);
  });
});
