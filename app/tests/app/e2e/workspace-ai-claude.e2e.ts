import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { workspaceAiPolicyPath, type Workspace } from '@flux/contracts';
import { chromium, type Browser as Chromium } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { password } from '../support/people.js';
import { startClientModelMock, type MockPlan } from '../support/client-model-mock.js';
import { expect } from '../support/mcp.js';
import { claudeBin, cleanClientHome, clientEvents, connectClient, scopes, seedOauthClient, sh, startFluxProxy, type ClientSpec } from '../support/mcp-client-harness.js';

/**
 * F-029 workspace AI lock, S2 (#614), with the REAL pinned Claude Code (scripts/check_mcp_clients.sh): the client adds Flux
 * with its own `mcp add` and completes Flux's OAuth as the person; it lists and calls Flux's tools while AI is on; after an
 * owner turns AI off, the same connected client gets no Flux tool and no Flux content; after AI is turned on again, the same
 * client, with no new sign-in, works again. The model endpoint is the scripted local mock; no vendor account is used.
 */
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 3000); });

const spec: ClientSpec = { key: 'claude-ai-lock', client: 'claude', label: 'Claude Code for the AI lock', designation: 'claude_code', port: 19821 };

test('a connected real Claude Code is refused after AI is turned off and works again after it is turned on', async () => {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  const proxy = startFluxProxy(); await proxy.listen();
  const browser: Chromium = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const email = uniqueEmail('ai-lock-claude');
    const { browser: owner } = await register(email, password, 'Lock owner');
    const workspace = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Garden club' } }), 201) as unknown as Workspace;
    const projectId = String(expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { body: { name: 'Sensor study', visibility: 'restricted' } }), 201).id);
    const agentId = String(expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/agents`, { body: { name: 'Owner Claude', owner: 'self' } }), 201).id);
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
    expect(await owner.request('POST', '/api/v1/agent-connections', { body: { name: spec.label, clientDesignation: spec.designation, agentId, selectedProjectIds: [projectId], scopes } }), 201);
    const clientId = await seedOauthClient(pool, spec);
    const home = cleanClientHome(spec);
    await connectClient(browser, email, home, clientId);

    /** One Claude Code session whose scripted model asks for `flux_list_contexts`. */
    async function session() {
      const plan: MockPlan = (turn) => turn.outputs.length === 0 ? { call: { name: 'mcp__flux__flux_list_contexts', args: {} } } : { text: 'finished' };
      const model = await startClientModelMock(plan);
      try {
        const result = await sh(claudeBin, ['-p', 'Use the Flux tools', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__flux', '--max-turns', '4'],
          { ...home.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}` }, home.cwd);
        const offered = (model.requests.find((request) => request.tools.some((name) => name.startsWith('mcp__flux__')))?.tools ?? []).filter((name) => name.startsWith('mcp__flux__'));
        const results: string[] = [];
        for (const line of clientEvents(result.output)) for (const block of line.message?.content ?? []) {
          if (block.type === 'tool_result') results.push(Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('') : String(block.content));
        }
        return { offered, results, output: result.output };
      } finally { await model.close(); }
    }
    const change = async (state: 'allowed' | 'blocked') => {
      const current = expect(await owner.request('GET', `/api/v1/workspaces/${workspace.id}`), 200) as unknown as Workspace;
      expect(await owner.request('PUT', workspaceAiPolicyPath(workspace.id), { body: { state }, headers: { 'if-match': `"${current.ai.version}"` } }), 200);
    };

    const on = await session();
    assert.ok(on.offered.includes('mcp__flux__flux_list_contexts'), `control: Flux tools are offered while AI is on:\n${on.output}`);
    assert.ok(on.results.some((text) => text.includes('Sensor study')), `control: the call returns the project:\n${on.output}`);

    await change('blocked');
    const off = await session();
    assert.deepEqual(off.offered, [], `no Flux tool is offered while AI is off:\n${off.output}`);
    assert.ok(!off.results.some((text) => text.includes('Sensor study')), `no Flux content reaches the client:\n${off.output}`);

    await change('allowed');
    const again = await session();
    assert.ok(again.offered.includes('mcp__flux__flux_list_contexts'), `the same connected client works again, with no new sign-in:\n${again.output}`);
    assert.ok(again.results.some((text) => text.includes('Sensor study')), again.output);
  } finally {
    await browser.close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
});
