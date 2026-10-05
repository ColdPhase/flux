import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileReceiveTimeoutError, FileTooLargeError, displayName } from '@flux/core';
import { diskFileStorage } from '../../apps/server/src/files/storage.js';

const chunks = async function* (...bytes: Buffer[]) { for (const chunk of bytes) yield chunk; };
test('disk storage measures streamed limits, timeout, immutable objects and leaf symlink refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flux-files-'));
  try {
    const storage = await diskFileStorage(root);
    await assert.rejects(storage.receive(chunks(Buffer.from('123'), Buffer.from('456')), { maxBytes: 5, deadline: Date.now() + 1000 }), FileTooLargeError);
    const stalled = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); yield Buffer.from('late'); } };
    await assert.rejects(storage.receive(stalled, { maxBytes: 5, deadline: Date.now() + 20 }), FileReceiveTimeoutError);
    const received = await storage.receive(chunks(Buffer.from('hello')), { maxBytes: 5, deadline: Date.now() + 1000 });
    const id = randomUUID();
    await received.commit(id);
    assert.deepEqual(await storage.read(id), Buffer.from('hello'));
    assert.equal(await storage.has(id, 5, received.sha256), true);
    assert.equal(await storage.has(id, 5, '0'.repeat(64)), false);
    const collision = await storage.receive(chunks(Buffer.from('other')), { maxBytes: 5, deadline: Date.now() + 1000 });
    await assert.rejects(collision.commit(id), /already exists/);
    await collision.discard();
    assert.deepEqual(await storage.read(id), Buffer.from('hello'));
    const leaf = join(root, 'attachments', 'objects', id.slice(0, 2), id);
    await rm(leaf);
    const secret = join(root, 'secret');
    await writeFile(secret, 'other');
    await symlink(secret, leaf);
    assert.equal(await storage.read(id), null);
    await storage.remove(id);
    assert.equal(await readFile(secret, 'utf8'), 'other');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('attachment directories refuse symlinks and display names reject controls before trimming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flux-file-dirs-'));
  const outside = await mkdtemp(join(tmpdir(), 'flux-file-outside-'));
  try {
    await symlink(outside, join(root, 'attachments'));
    await assert.rejects(diskFileStorage(root), /real directories/);
    for (const name of ['\nreport.txt', 'report.txt\t', '../report', 'a\\b', 'a\u202eb', '.', '..'])
      assert.throws(() => displayName(name));
    assert.equal(displayName('  report.txt  '), 'report.txt');
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
