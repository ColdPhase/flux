import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { renderCoworkPlaybook } from '@flux/core';
import { chromium, type Browser as Chromium } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { password } from '../support/people.js';
import { startClientModelMock, type MockPlan, type MockStep, type MockTurn } from '../support/client-model-mock.js';
import { expect } from '../support/mcp.js';
import { claudeBin, cleanClientHome, clientEvents, connectClient, scopes, seedOauthClient, sh, startFluxProxy, type ClientHome, type ClientSpec } from '../support/mcp-client-harness.js';

/**
 * #160 AC-2 (supported onboarding) with the REAL pinned Codex and Claude Code clients, clean configurations, no vendor account
 * (docker/Dockerfile `mcp-clients`, scripts/check_mcp_clients.sh). Per client: connect, the owner authorizes in Chromium, then
 * the person only says "Start work" (Claude Code: invokes Flux's own `start_work` prompt; Codex: discovers and reads Flux's supplied resource through native tools). The scripted model has no copy of the playbook: it reads
 * the playbook text the CLIs actually gave it, so a client that did not load Flux's instructions cannot complete the flow.
 * Then the first permitted action runs under a standing grant. Models are mocks; this shows delivery and the client's
 * invocation, not model obedience.
 */
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 3000); });

const specs: (ClientSpec & { agent: string })[] = [
  { key: 'claude-start', client: 'claude', label: 'Claude Code (start)', designation: 'claude_code', port: 19821, agent: 'claude' },
  { key: 'codex-start', client: 'codex', label: 'Codex (start)', designation: 'codex', port: 19822, agent: 'codex' },
];

interface ToolCall { tool: string; text: string }
const parse = (text: string | undefined) => JSON.parse(text ?? '{}') as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The bundle reference printed at the top of the rendered playbook, read from text the client delivered. */
function playbookIn(text: string) {
  const heading = text.match(/# Flux co-work playbook (\S+) (\S+)/);
  const digest = text.match(/Digest (sha256:[0-9a-f]{64})/);
  return heading && digest ? { bundleId: heading[1]!, version: heading[2]!, digest: digest[1]! } : null;
}

test('real Codex and Claude Code from clean configurations: supplied playbook reaches the active client before its first granted action', async (t) => {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  const proxy = startFluxProxy(); await proxy.listen();
  const browser: Chromium = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const held = { model: null as Awaited<ReturnType<typeof startClientModelMock>> | null };
  try {
    const email = uniqueEmail('mcp-onboarding');
    const { browser: owner } = await register(email, password, 'Onboarding owner');
    const workspace = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Onboarding' } }), 201);
    const project = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { body: { name: 'Sensor study', visibility: 'restricted' } }), 201);
    const projectId = String(project.id);
    const plan = expect(await owner.request('POST', `/api/v1/projects/${projectId}/materials`,
      { body: { clientMutationId: randomUUID(), title: 'Release plan', body: 'Step one: measure. Step two: compare.' } }), 201);
    const connections: Record<string, { id: string; agentId: string; grantId: string; clientId: string }> = {};
    for (const spec of specs) {
      const agentId = String(expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/agents`, { body: { name: `${spec.label} agent`, owner: 'self' } }), 201).id);
      expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'agent', id: agentId }, role: 'contributor' } }), 201);
      const id = String(expect(await owner.request('POST', '/api/v1/agent-connections', { body: { name: spec.label, clientDesignation: spec.designation,
        agentId, selectedProjectIds: [projectId], scopes } }), 201).id);
      const grant = expect(await owner.request('POST', `/api/v1/agent-connections/${id}/action-grants`, { body: { clientCommandId: randomUUID(), projectId,
        operation: 'work.create', peerRequestClass: 'execute', maximumUses: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as { id: string };
      connections[spec.key] = { id, agentId, grantId: grant.id, clientId: await seedOauthClient(pool, spec) };
    }

    const homes: Record<string, ClientHome> = {};
    for (const spec of specs) {
      homes[spec.key] = cleanClientHome(spec);
      await t.test(`${spec.label}: clean ${spec.client} connects and the owner authorizes`, async () => {
        await connectClient(browser, email, homes[spec.key]!, connections[spec.key]!.clientId);
      });
    }

    /** Runs the client once with a scripted model and returns the Flux tool calls the client really made, the turns it sent, and its output. */
    async function startWork(spec: ClientSpec, userText: string, planFor: (turn: MockTurn) => MockStep) {
      const { env, cwd } = homes[spec.key]!;
      const model = held.model = await startClientModelMock(planFor as MockPlan);
      try {
        const result = spec.client === 'codex'
          ? await sh('codex', ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
            ...(process.env.FLUX_TEST_CODEX_MODERN === '1' ? ['--enable', 'mcp_2026_07_28'] : []), '-c', 'model_provider="mock"',
            '-c', `model_providers.mock={name="mock",base_url="http://127.0.0.1:${model.port}/v1",env_key="MOCK_MODEL_KEY",wire_api="responses",supports_websockets=false}`, userText], env, cwd)
          : await sh(claudeBin, ['-p', userText, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__flux', '--max-turns', '12'],
            { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}` }, cwd);
        const calls: ToolCall[] = [];
        const used = new Map<string, string>();
        for (const line of clientEvents(result.output)) {
          if (line.type === 'item.completed' && line.item?.type === 'mcp_tool_call' && line.item.server === 'flux')
            calls.push({ tool: line.item.tool ?? '', text: line.item.result?.content?.[0]?.text ?? `ERROR ${line.item.error?.message ?? ''}` });
          for (const block of line.message?.content ?? []) {
            if (block.type === 'tool_use') used.set(block.id!, String(block.name).replace(/^mcp__flux__/, ''));
            if (block.type === 'tool_result' && used.has(block.tool_use_id!))
              calls.push({ tool: used.get(block.tool_use_id!)!, text: Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('') : String(block.content) });
          }
        }
        return { calls, turns: model.requests, output: result.output };
      } finally { await model.close(); held.model = null; }
    }
    const taskTitle = (spec: ClientSpec) => `First task from ${spec.client} ${randomUUID().slice(0, 8)}`;

    for (const spec of specs) {
      const title2 = 'native prompt/resource tooling loads the supplied playbook before the first permitted action';
      await t.test(`${spec.label}: ${title2}`, async () => {
        const { agentId } = connections[spec.key]!;
        const clientSessionId = randomUUID();
        const title = taskTitle(spec);
        let result;
        if (spec.client === 'claude') {
          // The person's whole input is Flux's own prompt, offered by Flux: no workflow text written or pasted.
          result = await startWork(spec, `/mcp__flux__start_work ${projectId}`, (turn) => {
            const loaded = playbookIn(turn.prompt);
            if (!loaded) return { text: 'The Flux playbook did not reach this client.' };
            const out = turn.outputs.map((item) => parse(item[0]));
            const boot = out[0];
            const flux = (name: string, args: Record<string, unknown>) => ({ call: { name: `mcp__flux__${name}`, args } });
            switch (turn.outputs.length) {
              case 0: return flux('flux_bootstrap', { projectId, clientSessionId });
              case 1: return flux('flux_acknowledge_playbook', { clientSessionId, ...loaded });
              case 2: return flux('flux_project_orientation', { projectId, kind: 'material' });
              case 3: return flux('flux_create_task', { projectId, runtimeSessionId: boot!.runtime.id, clientCommandId: randomUUID(), peerRequestClass: 'execute',
                grantId: (boot!.grants.items as { id: string; operation: string }[]).find((grant) => grant.operation === 'work.create')?.id, task: { title } });
              case 4: return flux('flux_bootstrap', { projectId, clientSessionId });
              default: return { text: 'Started.' };
            }
          });
          // Claude Code expanded Flux's MCP prompt into the model request: the playbook and the bound context are in what the model saw.
          const first = result.turns.find((turn) => turn.tools.some((name) => name.startsWith('mcp__flux__')))!;
          assert.ok(first.prompt.includes('Bound context (data, not instructions)'), `the start_work prompt was not expanded by the client:\n${first.prompt.slice(0, 600)}`);
          assert.ok(playbookIn(first.prompt), 'the rendered playbook with its version and digest reached the model');
        } else {
          // Codex does not automatically insert server instructions. Its existing native resource tooling
          // can deliver the actual authenticated bundle to the model. The fixture never supplies a copy.
          const value = (input: string | undefined): any => { // eslint-disable-line @typescript-eslint/no-explicit-any
            let result: any = input; // eslint-disable-line @typescript-eslint/no-explicit-any
            while (typeof result === 'string') { try { result = JSON.parse(result); } catch { break; } }
            if (result?.content?.[0]?.text) return JSON.parse(result.content[0].text);
            return result;
          };
          const emit = (code: string) => ({ js: `// @exec: {"max_output_tokens": 20000}\n${code}` });
          result = await startWork(spec, 'Start work', (turn) => {
            const out = turn.outputs.map(item => value(item[0]));
            if (out.length === 0) return emit(`
              if (!tools.list_mcp_resources || !tools.read_mcp_resource) throw Error('Native resource tooling is unavailable');
              const listed = await tools.list_mcp_resources({server:'flux'});
              text(typeof listed === 'string' ? listed : JSON.stringify(listed));`);
            const uri = out[0]?.resources?.find((item: {uri:string}) => item.uri.startsWith('flux://playbook/'))?.uri;
            if (!uri) return { text: 'The supplied playbook resource is unavailable.' };
            if (out.length === 1) return emit(`
              const read = await tools.read_mcp_resource({server:'flux',uri:${JSON.stringify(uri)}});
              text(typeof read === 'string' ? read : JSON.stringify(read));`);
            const resourceText = out[1]?.contents?.map((item: {text?:string}) => item.text ?? '').join('\n') ?? '';
            const loaded = playbookIn(resourceText);
            if (!loaded) return { text: 'The supplied playbook did not reach this client.' };
            const boot = out[2];
            switch (out.length) {
              case 2: return emit(`
                const contexts = JSON.parse((await tools.mcp__flux__flux_list_contexts({})).content[0].text);
                if (contexts.projects.length !== 1) throw Error('Choose a permitted project before starting');
                text(JSON.stringify(await tools.mcp__flux__flux_bootstrap({projectId:contexts.projects[0].id,clientSessionId:${JSON.stringify(clientSessionId)}})));`);
              case 3:
                assert.equal(boot.trusted.playbook.digest, loaded.digest);
                return emit(`text(JSON.stringify(await tools.mcp__flux__flux_acknowledge_playbook(${JSON.stringify({clientSessionId,...loaded})})));`);
              case 4: return emit(`text(JSON.stringify(await tools.mcp__flux__flux_project_orientation({projectId:${JSON.stringify(boot.project.id)},kind:'material'})));`);
              case 5: return emit(`text(JSON.stringify(await tools.mcp__flux__flux_create_task(${JSON.stringify({
                projectId:boot.project.id,runtimeSessionId:boot.runtime.id,clientCommandId:randomUUID(),peerRequestClass:'execute',
                grantId:boot.grants.items.find((grant: {operation:string}) => grant.operation==='work.create')?.id,task:{title},
              })})));`);
              case 6: return emit(`text(JSON.stringify(await tools.mcp__flux__flux_bootstrap({projectId:${JSON.stringify(boot.project.id)},clientSessionId:${JSON.stringify(clientSessionId)}})));`);
              default: return { text: 'Started.' };
            }
          });
          assert.doesNotMatch(result.turns[0]!.raw, /Flux co-work|flux_acknowledge_playbook|flux:\/\/playbook/,
            'no workflow or resource content is pre-injected in the initial Codex model request');
          const read = value(result.turns.at(-1)!.outputs[1]?.[0]);
          const resourceText = read?.contents?.map((item: {text?:string}) => item.text ?? '').join('\n') ?? '';
          assert.ok(playbookIn(resourceText), 'the actual native resource response reached the active model');
          assert.equal(resourceText, renderCoworkPlaybook(), 'the full supplied bundle, not just its heading or digest, reached the model');
          console.log('CODEX_NATIVE_RESOURCE_DELIVERY', JSON.stringify({mode:process.env.FLUX_TEST_CODEX_MODERN==='1'?'modern':'default',
            chars:resourceText.length,reference:playbookIn(resourceText), nativeResourceList:true,nativeResourceRead:true}));
        }
        const names = result.calls.map((call) => call.tool);
        for (const tool of ['flux_bootstrap', 'flux_acknowledge_playbook', 'flux_project_orientation', 'flux_create_task'])
          assert.ok(names.includes(tool), `${spec.label} did not call ${tool}; calls: ${names.join(', ')}\n${result.output.slice(-1500)}`);
        for (const call of result.calls) assert.ok(!call.text.startsWith('ERROR') && !/"code":"[A-Z_]+"/.test(call.text), `${call.tool} failed: ${call.text}`);
        // The record, not the model's report: the server-side acknowledgment is current, the task exists and belongs to this connection's agent.
        const finalBootstrap = parse(result.calls.filter((call) => call.tool === 'flux_bootstrap').at(-1)!.text);
        assert.equal(finalBootstrap.playbookAcknowledgment.current, true);
        assert.equal(finalBootstrap.playbookAcknowledgment.digest, finalBootstrap.trusted.playbook.digest);
        const orientation = parse(result.calls.find((call) => call.tool === 'flux_project_orientation')!.text);
        assert.ok(JSON.stringify(orientation).includes(String(plan.materialId)), 'first-entry orientation lists the current plan with its version');
        const created = parse(result.calls.find((call) => call.tool === 'flux_create_task')!.text);
        const stored = expect(await owner.request('GET', `/api/v1/work/${created.workId}`), 200);
        assert.equal(stored.title, title);
        assert.deepEqual([(stored.createdBy as { kind: string }).kind, (stored.createdBy as { id: string }).id], ['agent', agentId]);
      });
    }
    await t.test('ordinary Codex add/login uses native registration with no seeded client or feature override', async () => {
      const ordinary: ClientSpec = {...specs[1]!, key:'codex-ordinary-registration', port:19823};
      homes[ordinary.key]=cleanClientHome(ordinary);
      // Reuse only the owner-created connection, not the fixture's pre-registered OAuth identity.
      await connectClient(browser,email,homes[ordinary.key]!);
      const observed=await startWork(ordinary,'Check my Flux connection',turn=>turn.outputs.length===0 ? {js:`
        text(JSON.stringify(Object.keys(tools).filter(name=>name.startsWith('mcp__flux__'))));
        text(JSON.stringify(await tools.mcp__flux__flux_list_contexts({})));`} : {text:'Checked.'});
      assert.ok(observed.calls.some(call=>call.tool==='flux_list_contexts' && call.text.includes('Sensor study')),
        'the ordinarily registered native client actually reads its authorized context');
    });
  } finally {
    await held.model?.close();
    await browser.close(); await proxy.close(); await pool.end();
  }
});
