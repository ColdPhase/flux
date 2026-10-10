import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AGENT_MCP_ENTRIES, type AgentMcpPolicy } from '@flux/contracts';
import { requireAgentMcpEntry } from '@flux/core';
import { createMcpDispatch } from '../../apps/server/src/agent-connection/mcp-dispatch.js';

const entry = (name: string) => AGENT_MCP_ENTRIES.find((item) => item.name === name)!;
const policy = (): AgentMcpPolicy => ({ connectionId: randomUUID(), version: 7, selectedProjectIds: [randomUUID()],
  enabledEntryIds: AGENT_MCP_ENTRIES.map((item) => item.id),
  enabledCapabilityIds: [...new Set(AGENT_MCP_ENTRIES.flatMap((item) => item.requiredCapabilities))] });

test('same-content Off then On does not revive an old captured request or an unselected alias', () => {
  const saved = policy(); const doc = entry('flux_get_doc');
  requireAgentMcpEntry(saved, 7, doc);
  const off = { ...saved, version: 8, enabledCapabilityIds: [] };
  assert.throws(() => requireAgentMcpEntry(off, 7, doc), { code: 'MCP_ENTRY_UNAVAILABLE' });
  const on = { ...saved, version: 9 };
  assert.throws(() => requireAgentMcpEntry(on, 7, doc), { code: 'MCP_ENTRY_UNAVAILABLE' });
  requireAgentMcpEntry(on, 9, doc);
  const noAlias = { ...on, enabledEntryIds: on.enabledEntryIds.filter((id) => id !== doc.id) };
  assert.throws(() => requireAgentMcpEntry(noAlias, 9, doc), { code: 'MCP_ENTRY_UNAVAILABLE' });
  requireAgentMcpEntry(noAlias, 9, entry('flux_read_material'));
});

test('an aggregate cannot project a disabled source kind, and runtime capability does not imply an effect', () => {
  const saved = policy();
  const restricted = { ...saved, enabledCapabilityIds: saved.enabledCapabilityIds.filter((id) => id !== 'project.knowledge.read' && id !== 'work.create') };
  assert.throws(() => requireAgentMcpEntry(restricted, 7, entry('flux_search_project'), ['project.knowledge.read']), { code: 'MCP_ENTRY_UNAVAILABLE' });
  requireAgentMcpEntry(restricted, 7, entry('flux_search_project'), ['project.work.read']);
  assert.throws(() => requireAgentMcpEntry(restricted, 7, entry('flux_create_task')), { code: 'MCP_ENTRY_UNAVAILABLE' });
  requireAgentMcpEntry(restricted, 7, entry('flux_acknowledge_playbook'));
});

test('parallel callbacks keep their own trusted entry while delivery dependencies survive callback exit', async () => {
  const a = createMcpDispatch(7); const b = createMcpDispatch(12);
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const first = a.run('tool', 'flux_get_doc', async () => {
    a.project('project-a', 'project.read');
    await held;
    assert.equal(a.current().name, 'flux_get_doc');
    a.project('project-a', 'project.write'); a.project('project-a', 'project.read');
  });
  await b.run('resource', 'flux_cowork_playbook', async () => {
    assert.equal(b.current().name, 'flux_cowork_playbook'); release();
  });
  await first;
  assert.throws(() => a.current(), { code: 'MCP_ENTRY_UNAVAILABLE' });
  assert.deepEqual([...a.dependencies.entryIds], ['tool:flux_get_doc']);
  assert.deepEqual([...a.dependencies.capabilities], ['project.knowledge.read']);
  assert.equal(a.dependencies.projects.get('project-a'), 'project.write');
  assert.deepEqual([...b.dependencies.capabilities], ['cowork.playbook.read']);
  assert.equal(a.dependencies.capturedVersion, 7); assert.equal(b.dependencies.capturedVersion, 12);
  assert.throws(() => a.run('tool', 'future_alias', () => undefined), { code: 'MCP_ENTRY_UNAVAILABLE' });
});

test('actual registration coverage refuses a missing resource, unsupported name and duplicate', () => {
  const dispatch = createMcpDispatch(1);
  for (const item of AGENT_MCP_ENTRIES.filter((item) => item.name !== 'flux_project_policy')) dispatch.declare(item.kind, item.name);
  assert.throws(() => dispatch.verifyRegistrations());
  assert.throws(() => dispatch.declare('tool', 'future_alias'));
  assert.throws(() => dispatch.declare('tool', 'flux_get_doc'));
  dispatch.declare('resource', 'flux_project_policy'); dispatch.verifyRegistrations();
});
