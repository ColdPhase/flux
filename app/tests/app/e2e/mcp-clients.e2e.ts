import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium, type Browser as Chromium } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { password } from '../support/people.js';
import { startClientModelMock, type MockPlan } from '../support/client-model-mock.js';
import { expect } from '../support/mcp.js';
import { claudeBin, cleanClientHome, clientEvents, connectClient, scopes, seedOauthClient, sh, startFluxProxy, type ClientHome, type ClientSpec } from '../support/mcp-client-harness.js';

/**
 * AC-4 of #152 with the REAL pinned `codex` and `claude` clients (docker/Dockerfile `mcp-clients`, run by
 * scripts/check_mcp_clients.sh). Founder direction 2026-10-08: no vendor account, mocks only.
 *
 * What is real: both CLIs register Flux with their own `mcp add`, complete Flux's OAuth for MCP in a real
 * Chromium sign-in and consent as the person (not as a vendor account), list and call Flux's tools over
 * Streamable HTTP, and stop when the owner revokes a connection. What is a mock: the model endpoint (the
 * clients' own model traffic goes to `client-model-mock.ts`, which scripts the tool calls) and their
 * vendor sign-in, which is never used. Flux's OAuth clients are seeded rows; the CLIs use their
 * pre-registered client id options, so Client ID Metadata Documents are not exercised here.
 */
// The CLIs leave keep-alive sockets and helper processes behind; end the file once its results are reported.
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 3000); });

interface Spec extends ClientSpec { agent: 'codex' | 'claude'; projects: ('study' | 'field')[] }
const specs: Spec[] = [
  { key: 'codex-laptop', client: 'codex', label: 'Codex on laptop', designation: 'codex', agent: 'codex', projects: ['study'], port: 19811 },
  { key: 'codex-desktop', client: 'codex', label: 'Codex on desktop', designation: 'codex', agent: 'codex', projects: ['study', 'field'], port: 19812 },
  { key: 'claude-laptop', client: 'claude', label: 'Claude Code on laptop', designation: 'claude_code', agent: 'claude', projects: ['study', 'field'], port: 19813 },
];
// Names every personal connection must offer: the shared domain tools of the same owner-visible project data.
const sharedTools = ['flux_bootstrap', 'flux_list_contexts', 'flux_list_materials', 'flux_read_material', 'flux_create_proposal',
  'flux_list_work', 'flux_get_work', 'flux_create_task', 'flux_update_task', 'flux_record_result', 'flux_propose_decision',
  'flux_list_docs', 'flux_create_doc', 'flux_list_maps', 'flux_create_map', 'flux_list_conversations', 'flux_start_conversation'];

interface ToolCall { tool: string; text: string }
interface Session { names: string[]; calls: ToolCall[]; output: string }

test('real pinned Codex and Claude Code clients: three personal connections, one OAuth each, shared domain tools, revocation', async (t) => {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  const proxy = startFluxProxy(); await proxy.listen();
  const browser: Chromium = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const mock = { current: null as Awaited<ReturnType<typeof startClientModelMock>> | null };
  try {
    // --- One person, two projects, two agents (Hubert / Codex, Hubert / Claude), three named connections.
    const email = uniqueEmail('mcp-clients');
    const { browser: owner } = await register(email, password, 'Client owner');
    const workspace = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Client contract' } }), 201);
    const makeProject = async (name: string) => String(expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { body: { name, visibility: 'restricted' } }), 201).id);
    const projects = { study: await makeProject('Sensor study'), field: await makeProject('Field notes') };
    const names = { study: 'Sensor study', field: 'Field notes' };
    const agents: Record<string, string> = {};
    for (const [key, name] of [['codex', 'Owner Codex'], ['claude', 'Owner Claude']] as const) {
      agents[key] = String(expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/agents`, { body: { name, owner: 'self' } }), 201).id);
      for (const projectId of Object.values(projects)) expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'agent', id: agents[key] }, role: 'contributor' } }), 201);
    }
    const connections: Record<string, string> = {};
    for (const spec of specs) {
      connections[spec.key] = String(expect(await owner.request('POST', '/api/v1/agent-connections', { body: { name: spec.label, clientDesignation: spec.designation,
        agentId: agents[spec.agent], selectedProjectIds: spec.projects.map((project) => projects[project]), scopes } }), 201).id);
    }
    const clientIds: Record<string, string> = {};
    for (const spec of specs) clientIds[spec.key] = await seedOauthClient(pool, spec);
    // A standing grant for the first connection: the one place the shared domain is written to.
    const grant = expect(await owner.request('POST', `/api/v1/agent-connections/${connections['codex-laptop']}/action-grants`, { body: {
      clientCommandId: randomUUID(), projectId: projects.study, operation: 'work.create', peerRequestClass: 'execute', maximumUses: 2,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as { id: string };

    // --- Each client's own commands: add, authenticate through Flux's OAuth, then ask it for its MCP status.
    const homes: Record<string, ClientHome> = {};
    for (const spec of specs) {
      homes[spec.key] = cleanClientHome(spec);
      await t.test(`${spec.label}: ${spec.client} adds Flux and completes OAuth as the person`, async () => {
        await connectClient(browser, email, homes[spec.key]!, clientIds[spec.key]!);
      });
    }

    // --- Model-driven use: the scripted model asks each client to list and call Flux's tools.
    async function session(spec: Spec, steps: (outputs: string[][]) => string[]): Promise<Session> {
      // Codex: one `exec` script per step. Claude Code: one MCP tool call per step; `steps` gives the next tool names.
      const { env, cwd } = homes[spec.key]!;
      const calls: ToolCall[] = [];
      let plan: MockPlan;
      if (spec.client === 'codex') {
        plan = (turn) => turn.outputs.length === 0 ? { js: steps([]).join('\n') } : { text: 'finished' };
      } else {
        plan = (turn) => {
          const next = steps(turn.outputs);
          return next.length === 0 ? { text: 'finished' } : { call: { name: `mcp__flux__${next[0]}`, args: JSON.parse(next[1] ?? '{}') as Record<string, unknown> } };
        };
      }
      const model = mock.current = await startClientModelMock(plan);
      try {
        const result = spec.client === 'codex'
          ? await sh('codex', ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
            // Flux speaks MCP 2026-07-28 only; the pinned Codex asks for 2025-06-18 unless this under-development feature is on.
            '--enable', 'mcp_2026_07_28', '-c', 'model_provider="mock"',
            '-c', `model_providers.mock={name="mock",base_url="http://127.0.0.1:${model.port}/v1",env_key="MOCK_MODEL_KEY",wire_api="responses",supports_websockets=false}`, 'Use the Flux tools'], env, cwd)
          : await sh(claudeBin, ['-p', 'Use the Flux tools', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__flux', '--max-turns', '8'],
            { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}` }, cwd);
        assert.ok(model.requests.length > 0, `${spec.label}: the client never asked the model endpoint:\n${result.output}`);
        const lines = clientEvents(result.output);
        if (spec.client === 'codex') {
          for (const line of lines) if (line.type === 'item.completed' && line.item?.type === 'mcp_tool_call' && line.item.server === 'flux')
            calls.push({ tool: line.item.tool ?? '', text: line.item.result?.content?.[0]?.text ?? `ERROR ${line.item.error?.message ?? ''}` });
          const printed = model.requests.at(-1)!.outputs[0] ?? [];
          assert.ok(printed[0]?.startsWith('['), `the exec script printed no tool list:\n${printed.join('\n')}\n${result.output}`);
          const all = JSON.parse(printed[0] ?? '[]') as string[];
          assert.ok(all.some((name) => name.startsWith('mcp__flux__')), `Codex offered no Flux tools: ${all.join(', ')}\n${result.output}`);
          return { names: all.filter((name) => name.startsWith('mcp__flux__')).map((name) => name.slice('mcp__flux__'.length)), calls, output: result.output };
        }
        const used = new Map<string, string>();
        for (const line of lines) {
          for (const block of line.message?.content ?? []) {
            if (block.type === 'tool_use') used.set(block.id!, String(block.name).replace(/^mcp__flux__/, ''));
            if (block.type === 'tool_result' && used.has(block.tool_use_id!)) calls.push({ tool: used.get(block.tool_use_id!)!, text: Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('') : String(block.content) });
          }
        }
        const offered = model.requests.find((request) => request.tools.some((name) => name.startsWith('mcp__flux__')))?.tools ?? [];
        return { names: offered.filter((name) => name.startsWith('mcp__flux__')).map((name) => name.slice('mcp__flux__'.length)), calls, output: result.output };
      } finally { await model.close(); mock.current = null; }
    }
    const json = (call: ToolCall | undefined) => { assert.ok(call, 'the client called the tool'); assert.ok(!call.text.startsWith('ERROR'), call.text); return JSON.parse(call.text) as Record<string, unknown>; };
    const contextNames = (call: ToolCall | undefined) => (json(call).projects as { name: string }[]).map((item) => item.name).sort();
    const codexScript = (body: string) => ['text(JSON.stringify(Object.keys(tools)));', body];
    const listAll = codexScript('text(JSON.stringify(await tools.mcp__flux__flux_list_contexts({})));');
    const seen: Record<string, Session> = {};

    await t.test('every connection lists the same shared domain tools and only its own projects', async () => {
      for (const spec of specs) {
        const claudeSteps = (outputs: string[][]) => outputs.length === 0 ? ['flux_list_contexts', '{}'] : [];
        const result = seen[spec.key] = await session(spec, spec.client === 'codex' ? () => listAll : claudeSteps);
        for (const tool of sharedTools) assert.ok(result.names.includes(tool), `${spec.label} offers ${tool}: ${result.names.join(', ')}`);
        assert.deepEqual(contextNames(result.calls.find((call) => call.tool === 'flux_list_contexts')), spec.projects.map((project) => names[project]).sort(), `${spec.label} sees exactly its selected projects`);
      }
      assert.deepEqual(seen['codex-laptop']!.names, seen['codex-desktop']!.names, 'the same client offers the same tools on two connections');
      assert.deepEqual([...seen['claude-laptop']!.names].sort(), [...seen['codex-desktop']!.names].sort(), 'both clients offer the same shared tool set');
    });

    await t.test('one connection writes a task under a standing grant; the others read it from the shared project', async () => {
      const title = `Compare against the baseline ${randomUUID().slice(0, 8)}`;
      const created = await session(specs[0]!, () => codexScript(`
        const boot = JSON.parse((await tools.mcp__flux__flux_bootstrap({ projectId: ${JSON.stringify(projects.study)}, clientSessionId: ${JSON.stringify(randomUUID())} })).content[0].text);
        text(JSON.stringify(await tools.mcp__flux__flux_create_task({ projectId: ${JSON.stringify(projects.study)}, runtimeSessionId: boot.runtime.id, grantId: ${JSON.stringify(grant.id)},
          clientCommandId: ${JSON.stringify(randomUUID())}, peerRequestClass: 'execute', task: { title: ${JSON.stringify(title)} } })));`));
      // The authenticated bootstrap envelope the real client received names the connection's capabilities and the trusted playbook
      // reference (#160's Start/Resume consumes it; instruction loading by a model is not claimed here).
      const boot = json(created.calls.find((call) => call.tool === 'flux_bootstrap'));
      const capabilities = boot.capabilities as { name: string; available: boolean }[];
      assert.deepEqual(capabilities.filter((item) => item.name === 'flux_create_task').map((item) => item.available), [true]);
      assert.match((boot.trusted as { playbook: { digest: string } }).playbook.digest, /^sha256:[0-9a-f]{64}$/);
      assert.deepEqual((boot.project as { id: string }).id, projects.study);
      const task = json(created.calls.find((call) => call.tool === 'flux_create_task'));
      assert.equal(typeof task.workId, 'string', JSON.stringify(task));
      const stored = expect(await owner.request('GET', `/api/v1/work/${task.workId}`), 200);
      assert.equal(stored.title, title);
      assert.deepEqual([(stored.createdBy as { kind: string }).kind, (stored.createdBy as { id: string }).id], ['agent', agents.codex], 'the task is attributed to the connection\'s agent');
      for (const spec of [specs[1]!, specs[2]!]) {
        const read = await session(spec, spec.client === 'codex'
          ? () => codexScript(`text(JSON.stringify(await tools.mcp__flux__flux_list_work({ projectId: ${JSON.stringify(projects.study)} })));`)
          : (outputs) => outputs.length === 0 ? ['flux_list_work', JSON.stringify({ projectId: projects.study })] : []);
        assert.ok(JSON.stringify(json(read.calls.find((call) => call.tool === 'flux_list_work'))).includes(title), `${spec.label} reads the task another connection created`);
      }
    });

    await t.test('revoking one connection stops that client and leaves the others working', async () => {
      expect(await owner.request('DELETE', `/api/v1/agent-connections/${connections['claude-laptop']}`), 204);
      const refused = await session(specs[2]!, (outputs) => outputs.length === 0 ? ['flux_list_contexts', '{}'] : []);
      assert.ok(!refused.output.includes('Sensor study'), `a revoked connection returned data:\n${refused.output}`);
      assert.ok(!refused.calls.some((call) => call.text.includes('Sensor study')), 'a revoked connection returned project data');
      const still = await session(specs[1]!, () => listAll);
      assert.deepEqual(contextNames(still.calls.find((call) => call.tool === 'flux_list_contexts')), ['Field notes', 'Sensor study']);
    });
  } finally {
    await mock.current?.close();
    await browser.close();
    await proxy.close();
    await pool.end();
  }
});
