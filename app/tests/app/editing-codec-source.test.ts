import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('production public codec modules match their explicit current source manifest', async () => {
  const manifest = await readFile('apps/server/src/editing/codec/source.sha256', 'utf8');
  for (const line of manifest.trim().split('\n')) {
    const [expected, filename] = line.split('  ');
    assert.match(filename!, /^[a-z-]+\.mjs$/);
    const source = await readFile(`apps/server/src/editing/codec/${filename}`);
    assert.equal(createHash('sha256').update(source).digest('hex'), expected, filename);
  }
});
