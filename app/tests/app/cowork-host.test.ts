import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { coworkHostInstructions, coworkHostScope, coworkHostUrl, coworkNativeOutcome, type CoworkHostBinding } from '../../tooling/cowork.js';

test('host adapter retains only its own native thread and requires live resource instructions', async () => {
  const scope = coworkHostScope('https://flux.example', randomUUID(), randomUUID(), 'codex', '/work');
  const binding: CoworkHostBinding = { schema: 'flux.cowork.host/1', ...scope, threadId: null, outcome: 'new', updatedAt: new Date().toISOString() };
  const url = new URL(coworkHostUrl(binding));
  assert.equal(url.pathname, '/mcp'); assert.equal(url.searchParams.get('flux_project'), scope.projectId);
  assert.match(coworkHostInstructions(binding, 'start'), /CURRENT playbook resource/);
  assert.doesNotMatch(coworkHostInstructions(binding, 'resume'), /--last/);
  for (const origin of ['http://outside.example', 'https://user:secret@flux.example', 'https://flux.example/mcp'])
    assert.throws(() => coworkHostScope(origin, scope.connectionId, scope.projectId, 'codex', '/work'));
  const dir = await mkdtemp(join(tmpdir(), 'cowork-host-')); const path = join(dir, 'events.jsonl');
  try {
    const nativeId = randomUUID();
    await writeFile(path, JSON.stringify({ type: 'thread.started', thread_id: nativeId }) + '\n' + JSON.stringify({ type: 'turn.completed' }) + '\n');
    const started = await coworkNativeOutcome(path, binding, 0);
    assert.equal(started.binding.threadId, nativeId); assert.equal(started.binding.outcome, 'waiting');
    assert.equal((await coworkNativeOutcome(path, started.binding, 1)).binding.outcome, 'failed');
    await assert.rejects(coworkNativeOutcome(path, { ...binding, threadId: randomUUID() }, 0), /another thread/);
    await writeFile(path, JSON.stringify({ type: 'turn.completed' }) + '\n');
    assert.equal((await coworkNativeOutcome(path, binding, 0)).binding.outcome, 'failed', 'no unbound completion is accepted as a resumable native thread');
    assert.equal((await coworkNativeOutcome(path, started.binding, 0)).binding.threadId, nativeId, 'Resume preserves explicit native ID when CLI omits a repeated started event');
  } finally { await rm(dir, { recursive: true }); }
});
