import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { coworkHostScope, type CoworkHostBinding } from '../../tooling/cowork.js';
import { coworkProductionInvoke } from './support/cowork-production-invoke.js';

test('production-parity invoke keeps auth/backend overrides out and binds Resume to its own thread', () => {
  const binding: CoworkHostBinding = { schema: 'flux.cowork.host/1', ...coworkHostScope('https://fixture.invalid', randomUUID(), randomUUID(), 'codex', '/isolated'),
    threadId: null, outcome: 'new', updatedAt: new Date().toISOString() };
  const start = coworkProductionInvoke(binding, 'start');
  assert.ok(start.includes('--ignore-user-config')); assert.ok(start.includes('--json'));
  assert.equal(start[start.indexOf('--sandbox') + 1], 'workspace-write');
  const config = start.filter((_, index) => start[index - 1] === '-c');
  assert.ok(config.some(value => value.startsWith('mcp_servers.flux.url=') && value.includes(binding.connectionId) && value.includes(binding.projectId)));
  assert.ok(config.some(value => value.startsWith('developer_instructions=') && value.includes('CURRENT playbook resource')));
  assert.ok(!config.some(value => /oauth|credentials_store|callback|model_provider/.test(value)), 'no test-only auth workaround reaches the invoke');
  assert.ok(!start.includes('--ephemeral') && !start.includes('--last'), 'Start remains its own resumable native thread');
  assert.throws(() => coworkProductionInvoke(binding, 'resume'));
  const threadId = randomUUID(), resume = coworkProductionInvoke({ ...binding, threadId }, 'resume');
  assert.equal(resume[resume.indexOf('resume') + 1], threadId);
  assert.throws(() => coworkProductionInvoke({ ...binding, threadId: '--last' }, 'resume'));
});
