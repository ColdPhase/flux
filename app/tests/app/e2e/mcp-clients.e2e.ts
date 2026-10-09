import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium, type Browser as Chromium } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { password } from '../support/people.js';
import { startClientModelMock, type MockPlan } from '../support/client-model-mock.js';
import { expect } from '../support/mcp.js';

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
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const mcpUrl = `${origin}/mcp`;
const scopes = ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'];
const claudeBin = '/opt/flux-tools/claude/bin/claude';
const root = mkdtempSync(join(tmpdir(), 'mcp-clients-'));

// The clients reach Flux at its public origin (127.0.0.1), which inside this container is this proxy.
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80, method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
  });
  forward.on('error', () => response.destroy()); request.pipe(forward);
});

interface Running { output: () => string; done: Promise<number | null>; kill: () => void }
function run(command: string, args: string[], env: Record<string, string>, cwd: string, keepStdin = false): Running {
  const child: ChildProcess = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  if (!keepStdin) child.stdin!.end();
  let text = '';
  child.stdout!.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  const done = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000); done.then(() => clearTimeout(timer));
  return { output: () => text, done, kill: () => child.kill('SIGKILL') };
}
async function waitFor(running: Running, pattern: RegExp, label: string): Promise<RegExpMatchArray> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const match = running.output().match(pattern);
    if (match) return match;
    if (await Promise.race([running.done, new Promise((resolve) => setTimeout(resolve, 150, 'wait'))]) !== 'wait') { const last = running.output().match(pattern); if (last) return last; throw new Error(`${label}: exited without ${pattern}:\n${running.output()}`); }
  }
  throw new Error(`${label}: no ${pattern} in\n${running.output()}`);
}
const sh = async (command: string, args: string[], env: Record<string, string>, cwd: string) => {
  const running = run(command, args, env, cwd);
  return { code: await running.done, output: running.output() };
};

interface Spec { key: string; client: 'codex' | 'claude'; label: string; designation: 'codex' | 'claude_code'; agent: 'codex' | 'claude'; projects: ('study' | 'field')[]; port: number }
const specs: Spec[] = [
  { key: 'codex-laptop', client: 'codex', label: 'Codex on laptop', designation: 'codex', agent: 'codex', projects: ['study'], port: 19811 },
  { key: 'codex-desktop', client: 'codex', label: 'Codex on desktop', designation: 'codex', agent: 'codex', projects: ['study', 'field'], port: 19812 },
  { key: 'claude-laptop', client: 'claude', label: 'Claude Code on laptop', designation: 'claude_code', agent: 'claude', projects: ['study', 'field'], port: 19813 },
];
// Names every personal connection must offer: the shared domain tools of the same owner-visible project data.
const sharedTools = ['flux_bootstrap', 'flux_list_contexts', 'flux_list_materials', 'flux_read_material', 'flux_create_proposal',
  'flux_list_work', 'flux_get_work', 'flux_create_task', 'flux_update_task', 'flux_record_result', 'flux_propose_decision',
  'flux_list_docs', 'flux_create_doc', 'flux_list_maps', 'flux_create_map', 'flux_list_conversations', 'flux_start_conversation'];

/** The few fields read from `codex exec --json` and `claude -p --output-format stream-json` lines. */
interface ClientEvent {
  type?: string;
  item?: { type?: string; server?: string; tool?: string; result?: { content?: { text?: string }[] }; error?: { message?: string } };
  message?: { content?: { type?: string; id?: string; name?: string; tool_use_id?: string; content?: string | { text?: string }[] }[] };
}
interface ToolCall { tool: string; text: string }
interface Session { names: string[]; calls: ToolCall[]; output: string }

test('real pinned Codex and Claude Code clients: three personal connections, one OAuth each, shared domain tools, revocation', async (t) => {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  await new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
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
    for (const spec of specs) {
      const clientId = clientIds[spec.key] = `flux-clientcontract-${spec.key}-${randomUUID()}`;
      await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scopes, require_pkce, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'none', $5, $6, $7, true, now(), now())`, [randomUUID(), clientId, `${spec.label} (pinned ${spec.client} contract)`,
        [`http://127.0.0.1:${spec.port}/callback`, `http://localhost:${spec.port}/callback`], ['authorization_code', 'refresh_token'], ['code'], [...scopes, 'offline_access']]);
      await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1,$2,$3,now())', [randomUUID(), clientId, mcpUrl]);
    }
    // A standing grant for the first connection: the one place the shared domain is written to.
    const grant = expect(await owner.request('POST', `/api/v1/agent-connections/${connections['codex-laptop']}/action-grants`, { body: {
      clientCommandId: randomUUID(), projectId: projects.study, operation: 'work.create', peerRequestClass: 'execute', maximumUses: 2,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201) as { id: string };

    // --- The real person signs in and consents in Chromium for exactly the connection the client is for.
    async function authorize(spec: Spec, url: string) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(url); await page.waitForURL(`${origin}/login?**`);
        await page.getByLabel('Email', { exact: true }).fill(email);
        await page.getByLabel('Password', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL(`${origin}/connect-agent?**`);
        await page.locator('.connection__saved').filter({ hasText: spec.label }).getByRole('radio').check();
        await page.getByRole('button', { name: 'Continue to consent' }).click(); await page.waitForURL(`${origin}/consent?**`);
        await page.locator('.connection__summary').filter({ hasText: spec.label }).waitFor({ state: 'visible' });
        const callback = page.waitForURL(new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${spec.port}/callback`), { waitUntil: 'commit' }).catch(() => undefined);
        await page.getByRole('button', { name: 'Allow access' }).click();
        await callback;
      } catch (error) {
        throw new Error(`${(error as Error).message}\nauthorization URL: ${url}`);
      } finally { await context.close(); }
    }
    const authorizeUrl = /(https?:\/\/[^\s"']*\/api\/auth\/oauth2\/authorize\?[^\s"']+)/;

    // --- Each client's own commands: add, authenticate through Flux's OAuth, then ask it for its MCP status.
    const homes: Record<string, { env: Record<string, string>; cwd: string }> = {};
    for (const spec of specs) {
      const home = join(root, spec.key); mkdirSync(join(home, 'work'), { recursive: true });
      const cwd = join(home, 'work');
      mkdirSync(join(home, 'codex'), { recursive: true }); mkdirSync(join(home, 'claude'), { recursive: true });
      const base = { HOME: home, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
      homes[spec.key] = spec.client === 'codex'
        ? { env: { ...base, CODEX_HOME: join(home, 'codex'), MOCK_MODEL_KEY: 'not-a-vendor-key' }, cwd }
        : { env: { ...base, CLAUDE_CONFIG_DIR: join(home, 'claude'), ANTHROPIC_API_KEY: 'sk-ant-not-a-vendor-key' }, cwd };
      await t.test(`${spec.label}: ${spec.client} adds Flux and completes OAuth as the person`, async () => {
        const { env } = homes[spec.key]!;
        if (spec.client === 'codex') {
          const add = run('codex', ['mcp', 'add', 'flux', '--url', mcpUrl, '--oauth-client-id', clientIds[spec.key]!, '-c', `mcp_oauth_callback_port=${spec.port}`], env, cwd);
          // `mcp add` starts the login itself when the server offers OAuth; otherwise `mcp login` does.
          let match: RegExpMatchArray | null = await waitFor(add, authorizeUrl, 'codex mcp add').catch(() => null);
          let login = add;
          if (!match) {
            assert.equal(await add.done, 0, add.output());
            login = run('codex', ['mcp', 'login', 'flux', '--no-browser', '-c', `mcp_oauth_callback_port=${spec.port}`], env, cwd);
            match = await waitFor(login, authorizeUrl, 'codex mcp login');
          }
          await authorize(spec, match![1]!);
          assert.equal(await login.done, 0, login.output());
          const get = await sh('codex', ['mcp', 'get', 'flux'], env, cwd);
          assert.equal(get.code, 0, get.output);
          assert.match(get.output, new RegExp(mcpUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          const listed = await sh('codex', ['mcp', 'list'], env, cwd);
          assert.match(listed.output, /flux/); assert.doesNotMatch(listed.output, /Not logged in|Unsupported/i, listed.output);
        } else {
          const add = await sh(claudeBin, ['mcp', 'add', '--transport', 'http', '--scope', 'user', '--client-id', clientIds[spec.key]!, '--callback-port', String(spec.port), 'flux', mcpUrl], env, cwd);
          assert.equal(add.code, 0, add.output);
          // Claude Code refuses to log in without a terminal; `script` gives it one and the paste prompt waits on stdin.
          const login = run('script', ['-qefc', `${claudeBin} mcp login flux --no-browser`, '/dev/null'], env, cwd, true);
          const match = await waitFor(login, authorizeUrl, 'claude mcp login');
          // The terminal output wraps the URL in an OSC-8 hyperlink, which repeats it after an escape.
          await authorize(spec, match[1]!.split(String.fromCharCode(27))[0]!.split(/(?=https?:\/\/)/)[0]!);
          assert.equal(await login.done, 0, login.output());
          const listed = await sh(claudeBin, ['mcp', 'list'], env, cwd);
          assert.match(listed.output, /flux: .*Connected/, listed.output);
        }
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
          ? await sh('codex', ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_provider="mock"',
            '-c', `model_providers.mock={name="mock",base_url="http://127.0.0.1:${model.port}/v1",env_key="MOCK_MODEL_KEY",wire_api="responses",supports_websockets=false}`, 'Use the Flux tools'], env, cwd)
          : await sh(claudeBin, ['-p', 'Use the Flux tools', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__flux', '--max-turns', '8'],
            { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}` }, cwd);
        assert.ok(model.requests.length > 0, `${spec.label}: the client never asked the model endpoint:\n${result.output}`);
        const lines = result.output.split('\n').filter((line) => line.startsWith('{')).map((line): ClientEvent => { try { return JSON.parse(line) as ClientEvent; } catch { return {}; } });
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
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await pool.end();
  }
});
