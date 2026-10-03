import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium, type BrowserContext } from 'playwright';
import { password } from '../support/people.js';

/** Real browser consent and sign-in against Compose; this fixture is not a Codex/Claude activation test. */
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const evidenceDir = process.env.FLUX_E2E_EVIDENCE_DIR;
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
  });
  forward.on('error', () => response.destroy()); request.pipe(forward);
});

test('named connections and two tabs in one login complete distinct consent flows; signed-out OAuth resumes through sign-in', async () => {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  await new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  const contexts: BrowserContext[] = [];
  try {
    const seed = await browser.newContext(); contexts.push(seed);
    const email = `oauth-browser-${randomUUID()}@example.test`;
    async function post(path: string, body: unknown) {
      const response = await seed.request.post(`${origin}${path}`, { data: body, headers: { origin } });
      assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
      return await response.json() as Record<string, unknown>;
    }
    await post('/api/auth/sign-up/email', { name: 'Connection owner', email, password });
    const workspace = await post('/api/v1/workspaces', { name: 'Agent research' });
    const project = await post(`/api/v1/workspaces/${workspace.id}/projects`, { name: 'Sensor study', visibility: 'restricted' });
    const agent = await post(`/api/v1/workspaces/${workspace.id}/agents`, { name: 'Research agent', owner: 'self' });
    await post(`/api/v1/projects/${project.id}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' });
    const a = await post('/api/v1/agent-connections', { name: 'Research laptop', clientDesignation: 'codex', agentId: agent.id,
      selectedProjectIds: [project.id], scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] });
    const b = await post('/api/v1/agent-connections', { name: 'Delivery laptop', clientDesignation: 'claude_code', agentId: agent.id,
      selectedProjectIds: [project.id], scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute'] });
    const clientId = `flux-browser-${randomUUID()}`; const redirectUri = 'http://127.0.0.1:19737/callback';
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method,
      grant_types, response_types, scopes, require_pkce, created_at, updated_at)
      VALUES ($1, $2, 'Browser protocol fixture', $3, 'none', $4, $5, $6, true, now(), now())`,
    [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'],
      ['flux.context.read', 'flux.proposal.write', 'flux.action.execute', 'offline_access']]);
    await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1,$2,$3,now())',
      [randomUUID(), clientId, `${origin}/mcp`]);
    function authorization() {
      const verifier = randomBytes(32).toString('base64url');
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        scope: 'flux.context.read flux.proposal.write flux.action.execute offline_access', resource: `${origin}/mcp`, state: randomUUID(), prompt: 'consent' });
      return { url: `${origin}/api/auth/oauth2/authorize?${query}`, verifier, state: query.get('state')! };
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context);
    await context.route(`${redirectUri}**`, (route) => route.fulfill({ body: 'Connection authorized', contentType: 'text/plain' }));
    const pageA = await context.newPage(); const authA = authorization();
    await pageA.goto(authA.url); await pageA.waitForURL(`${origin}/login?**`);
    await pageA.getByLabel('Email', { exact: true }).fill(email);
    await pageA.getByLabel('Password', { exact: true }).fill(password);
    await pageA.getByRole('button', { name: 'Sign in', exact: true }).click();
    await pageA.waitForURL(`${origin}/connect-agent?**`);
    const pageB = await context.newPage(); const authB = authorization();
    await pageB.goto(authB.url); await pageB.waitForURL(`${origin}/connect-agent?**`);
    await pageA.locator('.connection__saved').filter({ hasText: 'Research laptop' }).getByRole('radio').check();
    await pageB.locator('.connection__saved').filter({ hasText: 'Delivery laptop' }).getByRole('radio').check();
    await Promise.all([pageA, pageB].map(async (page) => {
      await page.getByRole('button', { name: 'Continue to consent' }).click(); await page.waitForURL(`${origin}/consent?**`);
    }));
    await pageA.locator('.connection__summary').filter({ hasText: 'Research laptop' }).waitFor({ state: 'visible' });
    await pageB.locator('.connection__summary').filter({ hasText: 'Delivery laptop' }).waitFor({ state: 'visible' });
    for (const page of [pageA, pageB]) {
      await page.getByText('Run approved project actions', { exact: true }).waitFor({ state: 'visible' });
      await page.getByText('Each action also needs a current grant from you, with its own limits and expiry.', { exact: true }).waitFor({ state: 'visible' });
    }
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await pageA.screenshot({ path: join(evidenceDir, 'agent-consent-desktop.png'), fullPage: true });
      await pageB.setViewportSize({ width: 390, height: 844 });
      await pageB.screenshot({ path: join(evidenceDir, 'agent-consent-phone.png'), fullPage: true });
    }
    for (const [page, auth, expectedId] of [[pageA, authA, a.id], [pageB, authB, b.id]] as const) {
      await page.getByRole('button', { name: 'Allow access' }).click(); await page.waitForURL(`${redirectUri}?**`);
      const callback = new URL(page.url()); assert.equal(callback.searchParams.get('state'), auth.state);
      const response = await fetch(new URL('/api/auth/oauth2/token', upstream), { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code',
          code: callback.searchParams.get('code')!, client_id: clientId, redirect_uri: redirectUri, code_verifier: auth.verifier }) });
      assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
      const tokens = await response.json() as { access_token: string };
      const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString()) as { flux_connection_id: string };
      assert.equal(claims.flux_connection_id, expectedId);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close())); await browser.close();
    await new Promise<void>((resolve) => proxy.close(() => resolve())); await pool.end();
  }
});
