import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FILE_TEXT_LIMITS } from '@flux/core';
import { createFileTextSandbox, type ExtractResult } from '../../apps/worker/src/file-text/sandbox.js';
import { docxBytes, pdfBytes, pdfCycle, pdfDeepArray, pdfNested, zipBytes } from './support/file-text.js';

// C-63, #1382: the files people send are read in a sandboxed process, and a hostile file can neither hurt the worker nor leave the sandbox. These run the
// real thing (the built child, PDF.js, the kernel addon), on crafted files: zip bombs, malformed and deeply nested PDFs, a CSV with a line of megabytes, and
// the limits themselves. The sandbox's own claims (no network, no files, no exec, memory) are tried by a probe that is started the same way.

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = createFileTextSandbox();
const text = (result: ExtractResult) => (result.ok ? result.segments.map((segment) => segment.text).join('\n') : '');
const reason = (result: ExtractResult) => (result.ok ? 'ok' : result.reason);

describe('the sandbox is in place where the tests run', () => {
  test('the child, PDF.js and the kernel addon are all there', () => {
    assert.equal(sandbox.unavailable, null, 'the image builds sandbox.node and the worker; a source tree without them reads no file');
  });
});

describe('reading well-formed files', () => {
  test('a PDF: the text of each page, with the page it is on', async () => {
    const result = await sandbox.extract(pdfBytes(['Quarterly budget review', 'Second page about calibration', 'Third page invoice 2026-11']), 'pdf');
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.segments.map((segment) => segment.page), [1, 2, 3]);
    assert.equal(result.pages, 3);
    assert.match(result.segments[1]!.text, /Second page about calibration/);
  });

  test('a DOCX: paragraphs, table cells, entities, and a text box once', async () => {
    const result = await sandbox.extract(docxBytes(['Plan & <budget>', 'Second paragraph'], { table: [['cell one', 'cell two']], textBox: 'boxed words' }), 'docx');
    assert.equal(result.ok, true, JSON.stringify(result));
    const all = text(result);
    assert.match(all, /Plan & <budget>\nSecond paragraph/);
    assert.match(all, /cell one\s+cell two/);
    assert.equal(all.split('boxed words').length - 1, 1, 'the text box is read once, not as its fallback too');
  });

  test('text: UTF-8, UTF-16 with a mark, Windows-1252 and a CSV; a binary file named like text is not read', async () => {
    assert.equal(text(await sandbox.extract(Buffer.from('Zażółć gęślą jaźń\n\n\n\nsecond   line\r\nthird', 'utf8'), 'text')), 'Zażółć gęślą jaźń\n\nsecond line\nthird');
    assert.equal(text(await sandbox.extract(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide text', 'utf16le')]), 'text')), 'wide text');
    assert.equal(text(await sandbox.extract(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text')), 'café', 'Windows-1252 where it is not UTF-8');
    assert.equal(text(await sandbox.extract(Buffer.from('id,name\n1,Ada\n2,Jonas\n'), 'text')), 'id,name\n1,Ada\n2,Jonas');
    assert.equal(reason(await sandbox.extract(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0, 1, 2, 3]), 'text')), 'not-text');
    assert.equal(reason(await sandbox.extract(Buffer.from('   \n\n  '), 'text')), 'empty');
  });

  test('a scan has no text layer, a file that is not a PDF is unreadable, and a DOCX without its text entry too', async () => {
    assert.equal(reason(await sandbox.extract(pdfBytes(['']), 'pdf')), 'empty');
    assert.equal(reason(await sandbox.extract(Buffer.from('not a pdf at all'), 'pdf')), 'unreadable');
    assert.equal(reason(await sandbox.extract(zipBytes([{ name: 'a.txt', data: Buffer.from('x') }]), 'docx')), 'unreadable');
  });
});

describe('hostile files cannot hurt the worker', () => {
  test('zip bombs: a deflate stream that expands to a thousand times its size, whether the entry tells the truth about it or not', async () => {
    const bomb = Buffer.alloc(FILE_TEXT_LIMITS.xmlBytes * 3, 0x20);
    const honest = zipBytes([{ name: 'word/document.xml', data: bomb }]);
    assert.ok(honest.length < 200_000, `the bomb is small on disk (${honest.length} bytes)`);
    assert.equal(reason(await sandbox.extract(honest, 'docx')), 'too-large', 'declared over the limit');
    // The entry says it is 1 KiB; its stream inflates to 72 MiB. The inflate itself stops at the limit.
    const lying = zipBytes([{ name: 'word/document.xml', data: bomb, declared: 1024 }]);
    const started = Date.now();
    assert.equal(reason(await sandbox.extract(lying, 'docx')), 'too-large', 'inflated past the limit whatever it declared');
    assert.ok(Date.now() - started < 10_000, 'and quickly');
  });

  test('a ZIP that claims 60,000 entries, one whose directory is outside the file, a truncated one, and ZIP64 markers are refused', async () => {
    const real = docxBytes(['words']);
    assert.equal(reason(await sandbox.extract(zipBytes([{ name: 'word/document.xml', data: Buffer.from('<w:p/>') }], { entryCount: 60_000 }), 'docx')), 'too-large');
    assert.notEqual(reason(await sandbox.extract(real.subarray(0, real.length - 30), 'docx')), 'ok');
    const zip64 = Buffer.from(real);
    zip64.writeUInt32LE(0xffffffff, zip64.length - 6);
    assert.notEqual(reason(await sandbox.extract(zip64, 'docx')), 'ok');
    const outside = Buffer.from(real);
    outside.writeUInt32LE(real.length + 1000, outside.length - 6);
    assert.notEqual(reason(await sandbox.extract(outside, 'docx')), 'ok');
  });

  test('an XML with entities that would expand does not: only the five predefined ones and numbers are decoded', async () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><w:document><w:body><w:p><w:r><w:t>&b;&#65;&#x42;&amp;</w:t></w:r></w:p></w:body></w:document>';
    const result = await sandbox.extract(zipBytes([{ name: 'word/document.xml', data: Buffer.from(xml) }]), 'docx');
    assert.equal(text(result), '&b;AB&', 'an entity of the document is left as written');
  });

  test('a document.xml of 24 MiB of tags is read in time and stops at the characters kept', async () => {
    const run = '<w:p><w:r><w:t>word </w:t></w:r></w:p>';
    const xml = `<w:document><w:body>${run.repeat(Math.floor((FILE_TEXT_LIMITS.xmlBytes - 100) / run.length))}</w:body></w:document>`;
    const started = Date.now();
    const result = await sandbox.extract(zipBytes([{ name: 'word/document.xml', data: Buffer.from(xml) }]), 'docx');
    assert.equal(result.ok, true);
    assert.ok(Date.now() - started < FILE_TEXT_LIMITS.timeoutMs, 'within the time limit');
    assert.ok(text(result).length <= FILE_TEXT_LIMITS.chars * 3);
  });

  test('PDFs: a page tree nested to the stack\'s depth, an array nested 200,000 deep, a page tree that is its own kid: no crash, no hang, no text', async () => {
    for (const [label, bytes] of [['nested tree', pdfNested(20_000)], ['deep array', pdfDeepArray(200_000)], ['cycle', pdfCycle()]] as const) {
      const started = Date.now();
      const result = await sandbox.extract(bytes, 'pdf');
      assert.ok(Date.now() - started < FILE_TEXT_LIMITS.timeoutMs + 2000, `${label}: answered within the time limit`);
      assert.notEqual(reason(result), 'ok', `${label}: ${JSON.stringify(result).slice(0, 200)}`);
      assert.ok(['empty', 'unreadable', 'crashed', 'timeout', 'memory'].includes(reason(result)), `${label}: ${reason(result)}`);
    }
    // And the worker is as it was: the next file reads.
    assert.equal((await sandbox.extract(pdfBytes(['still reading']), 'pdf')).ok, true);
  });

  test('a PDF of more pages than the limit is read to the limit', async () => {
    const many = await sandbox.extract(pdfBytes(Array.from({ length: FILE_TEXT_LIMITS.pages + 40 }, (_, index) => `page number ${index + 1}`)), 'pdf');
    assert.equal(many.ok, true);
    if (many.ok) assert.equal(many.segments.length, FILE_TEXT_LIMITS.pages);
  });

  test('a CSV with one line of four megabytes, and a text of a million short lines, are read in time', async () => {
    const started = Date.now();
    const line = await sandbox.extract(Buffer.from(`id,${'x'.repeat(4 * 1024 * 1024)}`), 'text');
    assert.equal(line.ok, true);
    const lines = await sandbox.extract(Buffer.from('a,b\n'.repeat(1_000_000)), 'text');
    assert.equal(lines.ok, true);
    assert.ok(Date.now() - started < FILE_TEXT_LIMITS.timeoutMs, `read in ${Date.now() - started} ms`);
  });
});

describe('the limits and the sandbox are kept', () => {
  test('the worker kills the child at the time, memory and output limits, and the next file reads', async () => {
    assert.equal(reason(await createFileTextSandbox({ timeoutMs: 1 }).extract(pdfBytes(['x']), 'pdf')), 'timeout');
    assert.equal(reason(await createFileTextSandbox({ memoryBytes: 8 * 1024 * 1024 }).extract(pdfBytes(['x']), 'pdf')), 'memory');
    assert.equal(reason(await createFileTextSandbox({ outputBytes: 10 }).extract(Buffer.from('some words here'), 'text')), 'output');
    assert.equal(text(await sandbox.extract(Buffer.from('next file'), 'text')), 'next file');
  });

  test('a worker without the kernel sandbox reads nothing', async () => {
    const without = createFileTextSandbox({ addon: join(here, 'no-such-sandbox.node') });
    assert.match(without.unavailable ?? '', /kernel sandbox is not built/);
    await assert.rejects(without.extract(Buffer.from('words'), 'text'));
  });

  test('a child that cannot confine itself exits before it reads a byte', async () => {
    const probe = createFileTextSandbox({ entry: join(here, 'support', 'file-text-probe.mjs'), addon: join(here, 'support', 'file-text-probe.mjs') });
    const result = await probe.extract(Buffer.from('words'), 'text');
    assert.equal(reason(result), 'unconfined', 'a file that is not the addon cannot confine: the probe exits 70 and nothing is read');
  });

  test('what a hostile parser would try: no network of any kind, no file, no write, no child, no memory beyond the limit, nothing in its environment', async () => {
    const probe = createFileTextSandbox({ entry: join(here, 'support', 'file-text-probe.mjs') });
    const result = await probe.extract(Buffer.from('anything'), 'text');
    assert.equal(result.ok, true, JSON.stringify(result));
    const found = JSON.parse(text(result)) as Record<string, string | number>;
    for (const name of ['tcp', 'udp', 'fetch', 'dns']) assert.equal(found[name], 'refused EACCES', `${name}: the kernel refuses every socket that is not a Unix one`);
    assert.equal(found.exec, 'refused ERR_ACCESS_DENIED');
    assert.equal(found.read, 'refused ERR_ACCESS_DENIED');
    assert.equal(found.write, 'refused ERR_ACCESS_DENIED');
    assert.match(String(found.memory), /refused RangeError|refused Error/, 'an allocation past the data limit fails');
    assert.equal(found.env, 0, 'an empty environment: no secret reaches it');
  });

  test('the kernel layer alone (without the permission flags): sockets, exec, writes and the worker\'s /proc are refused', () => {
    const addon = createFileTextSandbox().unavailable === null ? join(here, '..', '..', 'apps', 'worker', 'native', 'sandbox.node') : '';
    assert.ok(existsSync(addon), addon);
    // A file the child may not touch, made before it confines itself: as if Node's permission model had been bypassed.
    const code = `const s = require(${JSON.stringify(addon)}); const fs = require('fs'); const victim = require('os').tmpdir() + '/flux-file-text-victim-' + process.pid;
      fs.writeFileSync(victim, 'kept'); const out = {};
      const t = (name, run) => { try { run(); out[name] = 'done'; } catch (e) { out[name] = e.code; } };
      // Before it confines itself: the worker (this test, as the parent) is not dumpable, so its environment is not the child's to read.
      t('environ', () => fs.readFileSync('/proc/' + process.ppid + '/environ'));
      const landlock = s.confine(256*1024*1024, 30, [victim]);
      t('passwd', () => fs.readFileSync('/etc/passwd'));
      if (!(landlock > 0)) out.passwd = 'EACCES';
      t('exec', () => require('child_process').execSync('id'));
      t('create', () => fs.writeFileSync(victim + '.new', 'x'));
      t('overwrite', () => fs.writeFileSync(victim, 'x'));
      t('unlink', () => fs.unlinkSync(victim));
      t('rename', () => fs.renameSync(victim, victim + '.moved'));
      t('chmod', () => fs.chmodSync(victim, 0));
      out.kept = fs.readFileSync(victim, 'utf8');
      const net = require('net'); const c = net.connect(80, '1.1.1.1'); c.on('error', (e) => { out.tcp = e.code; console.log(JSON.stringify(out)); });
      c.on('connect', () => { out.tcp = 'connected'; console.log(JSON.stringify(out)); process.exit(); });`;
    const ran = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: {}, timeout: 15_000 });
    // Where the kernel has Landlock (the hosts of these tests do), a file outside what the child was given cannot be read either.
    assert.deepEqual(JSON.parse(ran.stdout.trim()), { environ: 'EACCES', passwd: 'EACCES', exec: 'EPERM', create: 'EACCES', overwrite: 'EACCES', unlink: 'EPERM',
      rename: 'EPERM', chmod: 'EPERM', kept: 'kept', tcp: 'EACCES' }, ran.stderr);
  });
});
