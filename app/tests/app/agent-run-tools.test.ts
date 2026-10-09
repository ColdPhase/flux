import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentToolCapability } from '@flux/contracts';
import { fluxToolCapabilities } from '../../apps/server/src/agent-connection/mcp-tools.js';
import { READ_ONLY_RUN_POLICY, selectRunTools } from '../../apps/server/src/agent-connection/run-tools.js';

// F-022 T5: a run's tool list is derived from the connection's scopes and the run policy, not written in
// the run code. Read-only is the default today; a later policy (F-027) may add write scopes.

const cap = (name: string, requiredScope: AgentToolCapability['requiredScope'], available: boolean): AgentToolCapability =>
  ({ name, title: name, requiredScope, available, operation: null, classes: [] });

test('the default run policy takes only available read tools and never a write tool', () => {
  const capabilities = [
    cap('flux_get_doc', 'flux.context.read', true),
    cap('flux_list_work', 'flux.context.read', false),
    cap('flux_create_proposal', 'flux.proposal.write', true),
  ];
  assert.deepEqual(selectRunTools(capabilities), ['flux_get_doc']);
  assert.deepEqual(selectRunTools(capabilities, READ_ONLY_RUN_POLICY), ['flux_get_doc']);
});

test('a later policy adds write tools without changing the derivation', () => {
  const capabilities = [cap('flux_get_doc', 'flux.context.read', true), cap('flux_create_proposal', 'flux.proposal.write', true)];
  assert.deepEqual(selectRunTools(capabilities, { allowedScopes: ['flux.context.read', 'flux.proposal.write'] }), ['flux_get_doc', 'flux_create_proposal']);
});

test('the live tool registrations give a read-only run list by default', () => {
  const claims = { ownerUserId: 'owner', connectionId: 'c', scopes: ['flux.context.read', 'flux.proposal.write'], clientId: null, grantReferenceId: null };
  const capabilities = fluxToolCapabilities(null as never, claims, 'a-cursor-secret-of-sufficient-length-here');
  const run = selectRunTools(capabilities);
  assert.ok(run.length > 0, 'at least one read tool');
  const byName = new Map(capabilities.map((tool) => [tool.name, tool]));
  for (const name of run) assert.equal(byName.get(name)?.requiredScope, 'flux.context.read', `${name} is a read tool`);
  assert.ok(!run.includes('flux_create_proposal'), 'a write tool is not in the default run');
});
