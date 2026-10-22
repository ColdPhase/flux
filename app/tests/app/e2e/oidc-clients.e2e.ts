import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { startClientModelMock } from '../support/client-model-mock.js';
import { claudeBin, cleanClientHome, clientEvents, mcpUrl, origin, run, scopes, seedOauthClient, sh, startFluxProxy, waitFor,
  type ClientHome, type ClientSpec, type Running } from '../support/mcp-client-harness.js';

// #483 S1-AC-10: the official pinned CLIs and real Keycloak/Flux OAuth. Only the model is scripted;
// no vendor account, manual ready state, intercepted discovery or substituted OAuth transport.
const keycloak = 'http://keycloak:8080';
const authorization = /(https?:\/\/[^\s"']*\/api\/auth\/oauth2\/authorize\?[^\s"']+)/;
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 3000); });

async function providerSignIn(context: BrowserContext, url: string) {
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole('button', { name: 'Sign in with Keycloak', exact: true }).click();
  await page.waitForURL((target) => target.origin === keycloak);
  await page.locator('#username').fill('erin');
  await page.locator('#password').fill(process.env.FLUX_OIDC_TEST_PASSWORD!);
  await page.locator('#kc-login').click();
  await page.waitForURL((target) => target.origin === origin, { timeout: 30_000 });
  return page;
}

async function authorize(browser: Browser, home: ClientHome, url: string) {
  const context = await browser.newContext();
  try {
    const page = await providerSignIn(context, url);
    await page.waitForURL(`${origin}/connect-agent?**`);
    assert.ok(new URL(page.url()).searchParams.get('sig'));
    await page.locator('.connection__saved').filter({ hasText: home.spec.label }).getByRole('radio').check();
    await page.getByRole('button', { name: 'Continue to consent' }).click();
    await page.waitForURL(`${origin}/consent?**`);
    await page.locator('.connection__summary').filter({ hasText: home.spec.label }).waitFor();
    const consent = await context.request.get(`${origin}/api/v1/agent-oauth/consent-context?oauth_query=${encodeURIComponent(new URL(page.url()).search.slice(1))}`);
    assert.equal(consent.status(), 200);
    const display = await consent.json() as { redirect: { kind: string; host: string }; clientIdHost: string | null };
    assert.equal(display.redirect.kind, 'loopback');
    assert.ok(display.redirect.host.endsWith(`:${home.spec.port}`));
    assert.equal(display.clientIdHost, new URL(url).searchParams.get('client_id')?.startsWith('https:')
      ? new URL(new URL(url).searchParams.get('client_id')!).host : null);
    await page.getByText('This address is on your own computer, where your agent client runs.', { exact: false }).waitFor();
    const framed = await context.request.get(page.url());
    assert.equal(framed.headers()['x-frame-options'], 'DENY');
    assert.match(framed.headers()['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    const callback = page.waitForURL(new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${home.spec.port}/callback`), { waitUntil: 'commit' });
    await page.getByRole('button', { name: 'Allow access' }).click();
    await callback;
  } finally { await context.close(); }
}

async function connect(browser: Browser, home: ClientHome, clientId?: string) {
  const { spec, env, cwd } = home;
  let login: Running | undefined;
  let actualClientId: string | null = null;
  try {
    if (spec.client === 'codex') {
      login = run('codex', ['mcp', 'add', 'flux', '--url', mcpUrl, ...(clientId ? ['--oauth-client-id', clientId] : []),
        '-c', `mcp_oauth_callback_port=${spec.port}`], env, cwd);
      let match = await waitFor(login, authorization, 'Codex add').catch(() => null);
      if (!match) {
        assert.equal(await login.done, 0, login.output());
        login = run('codex', ['mcp', 'login', 'flux', '--no-browser', '-c', `mcp_oauth_callback_port=${spec.port}`], env, cwd);
        match = await waitFor(login, authorization, 'Codex login');
      }
      actualClientId = new URL(match[1]!).searchParams.get('client_id');
      await authorize(browser, home, match[1]!);
    } else {
      const added = await sh(claudeBin, ['mcp', 'add', '--transport', 'http', '--scope', 'user', ...(clientId ? ['--client-id', clientId] : []),
        '--callback-port', String(spec.port), 'flux', mcpUrl], env, cwd);
      assert.equal(added.code, 0, added.output);
      login = run('script', ['-qefc', `${claudeBin} mcp login flux --no-browser`, '/dev/null'], env, cwd, true);
      const match = await waitFor(login, authorization, 'Claude login');
      const url = match[1]!.split(String.fromCharCode(27))[0]!.split(/(?=https?:\/\/)/)[0]!;
      actualClientId = new URL(url).searchParams.get('client_id');
      await authorize(browser, home, url);
    }
    assert.equal(await login.done, 0, login.output());
    assert.ok(actualClientId);
    return actualClientId;
  } finally { login?.kill(); }
}

async function nativeRead(home: ClientHome, projectId: string) {
  const args = { projectId, clientSessionId: randomUUID() };
  const model = await startClientModelMock((turn) => {
    if (home.spec.client === 'codex') return turn.outputs.length === 0 ? { js:
      `text(JSON.stringify(Object.keys(tools))); text(JSON.stringify(await tools.mcp__flux__flux_bootstrap(${JSON.stringify(args)}))); text(JSON.stringify(await tools.mcp__flux__flux_list_contexts({})));` } : { text: 'finished' };
    if (turn.outputs.length === 0) return { call: { name: 'mcp__flux__flux_bootstrap', args } };
    return turn.outputs.length === 1 ? { call: { name: 'mcp__flux__flux_list_contexts', args: {} } } : { text: 'finished' };
  });
  try {
    const { env, cwd } = home;
    const result = home.spec.client === 'codex'
      ? await sh('codex', ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_provider="mock"',
        '-c', `model_providers.mock={name="mock",base_url="http://127.0.0.1:${model.port}/v1",env_key="MOCK_MODEL_KEY",wire_api="responses",supports_websockets=false}`, 'Use the Flux tools'], env, cwd)
      : await sh(claudeBin, ['-p', 'Use the Flux tools', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__flux', '--max-turns', '8'],
        { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}` }, cwd);
    assert.equal(result.code, 0, result.output);
    const calls = new Map<string, string>(); const used = new Map<string, string>();
    for (const event of clientEvents(result.output)) {
      if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item.server === 'flux')
        calls.set(event.item.tool!, event.item.result?.content?.[0]?.text ?? '');
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') used.set(block.id!, String(block.name).replace(/^mcp__flux__/, ''));
        if (block.type === 'tool_result' && used.has(block.tool_use_id!)) calls.set(used.get(block.tool_use_id!)!,
          Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('') : String(block.content));
      }
    }
    assert.ok(model.requests.length > 0);
    const boot = JSON.parse(calls.get('flux_bootstrap') ?? 'null') as { project?: { id: string }; trusted?: { playbook?: { digest: string } } } | null;
    assert.equal(boot?.project?.id, projectId, result.output);
    assert.match(boot?.trusted?.playbook?.digest ?? '', /^sha256:[0-9a-f]{64}$/);
    const contexts = JSON.parse(calls.get('flux_list_contexts') ?? 'null') as { projects?: { id: string }[] } | null;
    assert.deepEqual(contexts?.projects?.map((project) => project.id), [projectId], result.output);
  } finally { await model.close(); }
}

test('real official Codex and Claude Code authorize through Keycloak and execute their own allowed Flux tools', async (t) => {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  const proxy = startFluxProxy(); await proxy.listen();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const owner = await browser.newContext();
  try {
    await providerSignIn(owner, `${origin}/sign-in`);
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await owner.request.fetch(`${origin}${path}`, { method, headers: { origin }, data: body });
      assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
      return await response.json() as Record<string, unknown>;
    };
    const me = await api('GET', '/api/v1/me'); const userId = (me.user as { id: string }).id;
    const workspace = await api('POST', '/api/v1/workspaces', { name: 'Keycloak official-client proof' });
    const project = await api('POST', `/api/v1/workspaces/${workspace.id}/projects`, { name: 'Identity study', visibility: 'restricted' });
    const clients = [{ client: 'codex', cimd: false }, { client: 'claude', cimd: false }, { client: 'claude', cimd: true }] as const;
    for (const [index, { client, cimd }] of clients.entries()) {
      const label = `${client} ${cimd ? 'CIMD' : 'pre-registered'}`;
      const spec: ClientSpec = { key: `oidc-${client}-${index}`, client, label: `Keycloak ${label}`, designation: client === 'codex' ? 'codex' : 'claude_code', port: 19841 + index };
      const agent = await api('POST', `/api/v1/workspaces/${workspace.id}/agents`, { name: spec.label, owner: 'self' });
      await api('POST', `/api/v1/projects/${project.id}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' });
      const connection = await api('POST', '/api/v1/agent-connections', { name: spec.label, clientDesignation: spec.designation,
        agentId: agent.id, selectedProjectIds: [project.id], scopes });
      const home = cleanClientHome(spec); const clientId = cimd ? undefined : await seedOauthClient(pool, spec);
      await t.test(`${label}: real fresh-browser Keycloak authorization, native bootstrap and authorized context read`, async () => {
        const version = await sh(client === 'codex' ? 'codex' : claudeBin, ['--version'], home.env, home.cwd);
        assert.equal(version.code, 0); t.diagnostic(`${client} ${version.output.trim()}`);
        const actualClientId = await connect(browser, home, clientId);
        if (cimd) {
          const metadata = new URL(actualClientId);
          assert.equal(metadata.protocol, 'https:'); assert.equal(metadata.hostname, 'claude.ai');
          t.diagnostic(`CIMD fetched by Flux from ${metadata.hostname}; no client row was seeded for this connection`);
        } else assert.equal(actualClientId, clientId);
        const facts = await pool.query(`SELECT f.auth_method FROM oauth_grant_authentication f JOIN oauth_refresh_token r
          ON r.authorization_code_id = f.authorization_code_id WHERE r.client_id = $1 AND f.user_id = $2`, [actualClientId, userId]);
        assert.ok(facts.rows.length > 0 && facts.rows.every((row) => row.auth_method === process.env.FLUX_OIDC_PROVIDER_ID));
        await nativeRead(home, String(project.id));
        const retained = await pool.query('SELECT owner_user_id, agent_id, revoked_at FROM agent_connections WHERE id = $1', [connection.id]);
        assert.deepEqual(retained.rows[0], { owner_user_id: userId, agent_id: agent.id, revoked_at: null });
      });
    }
  } finally { await owner.close(); await browser.close(); await proxy.close(); await pool.end(); }
});
