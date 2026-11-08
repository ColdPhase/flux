import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium, type BrowserContext, type Page } from 'playwright';
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

test('a client signs in with one click: Deny makes nothing, Allow makes one connection, a second tab and a reconnect find it, signed-out OAuth resumes through sign-in', async () => {
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
    await post('/api/v1/workspaces', { name: 'Agent research' });
    const clientId = `flux-browser-${randomUUID()}`; const redirectUri = 'http://127.0.0.1:19737/callback';
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method,
      grant_types, response_types, scopes, require_pkce, created_at, updated_at)
      VALUES ($1, $2, 'Claude Code', $3, 'none', $4, $5, $6, true, now(), now())`,
    [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['offline_access']]);
    await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1,$2,$3,now())',
      [randomUUID(), clientId, `${origin}/mcp`]);
    const connections = async () => (await pool.query('SELECT id, name, client_designation, may_do, revoked_at FROM agent_connections WHERE client_designation = \'claude_code\'')).rows as
      { id: string; name: string; client_designation: string; may_do: string; revoked_at: Date | null }[];
    const agents = async () => Number((await pool.query('SELECT count(*)::int AS n FROM agents WHERE name = \'Claude Code\'')).rows[0].n);
    function authorization() {
      const verifier = randomBytes(32).toString('base64url');
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        scope: 'offline_access', resource: `${origin}/mcp`, state: randomUUID() });
      return { url: `${origin}/api/auth/oauth2/authorize?${query}`, verifier, state: query.get('state')! };
    }
    async function exchange(page: Page, auth: ReturnType<typeof authorization>) {
      await page.waitForURL(`${redirectUri}?**`);
      return redeem(new URL(page.url()), auth);
    }
    async function redeem(callback: URL, auth: ReturnType<typeof authorization>) {
      assert.equal(callback.searchParams.get('state'), auth.state);
      const response = await fetch(new URL('/api/auth/oauth2/token', upstream), { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code',
          code: callback.searchParams.get('code')!, client_id: clientId, redirect_uri: redirectUri, code_verifier: auth.verifier }) });
      assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
      const tokens = await response.json() as { access_token: string };
      return JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString()) as { flux_connection_id: string; scope?: string };
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context);
    await context.route(`${redirectUri}**`, (route) => route.fulfill({ body: 'Connection authorized', contentType: 'text/plain' }));

    // Signed out: the authorization resumes through sign-in and lands on the one consent page, not on a page of choices.
    const first = await context.newPage(); const authA = authorization();
    await first.goto(authA.url); await first.waitForURL(`${origin}/login?**`);
    await first.getByLabel('Email', { exact: true }).fill(email);
    await first.getByLabel('Password', { exact: true }).fill(password);
    await first.getByRole('button', { name: 'Sign in', exact: true }).click();
    await first.waitForURL(`${origin}/consent?**`);
    assert.equal((await connections()).length, 0, 'looking at the request makes nothing');
    assert.equal(await agents(), 0);
    await first.getByRole('heading', { name: 'Connect Claude Code to Flux' }).waitFor({ state: 'visible' });
    await first.getByText('Acts with your rights', { exact: true }).waitFor({ state: 'visible' });
    await first.getByText('Deleting and other people’s things wait for your OK', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await first.getByRole('checkbox').count(), 0, 'there is nothing to tick: no project, scope or permission');
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await first.screenshot({ path: join(evidenceDir, 'agent-consent-desktop.png'), fullPage: true });
      await first.setViewportSize({ width: 390, height: 844 });
      await first.screenshot({ path: join(evidenceDir, 'agent-consent-phone.png'), fullPage: true });
      await first.setViewportSize({ width: 1280, height: 900 });
    }

    // Deny: the client is told, and nothing was made.
    await first.getByRole('button', { name: 'Deny' }).click();
    await first.waitForURL(`${redirectUri}?**`);
    assert.equal(new URL(first.url()).searchParams.get('error'), 'access_denied');
    assert.equal((await connections()).length, 0, 'Deny makes no connection');
    assert.equal(await agents(), 0, 'Deny makes no agent');

    // Two tabs ask at once: each is one click, and the two Allows end in one connection of one agent.
    const pageA = await context.newPage(); const pageB = await context.newPage();
    const authB = authorization(); const authC = authorization();
    await pageA.goto(authB.url); await pageA.waitForURL(`${origin}/consent?**`);
    await pageB.goto(authC.url); await pageB.waitForURL(`${origin}/consent?**`);
    await Promise.all([pageA, pageB].map((page) => page.getByRole('button', { name: 'Allow' }).click()));
    const [claimsA, claimsB] = await Promise.all([exchange(pageA, authB), exchange(pageB, authC)]);
    const made = await connections();
    assert.equal(made.length, 1, 'two Allows of one client by one person are one connection');
    assert.deepEqual([made[0]!.name, made[0]!.may_do, made[0]!.revoked_at], ['Claude Code on this computer', 'act', null]);
    assert.equal(await agents(), 1);
    assert.deepEqual([claimsA.flux_connection_id, claimsB.flux_connection_id], [made[0]!.id, made[0]!.id]);

    // Reconnect: the client holds a connection, so it gets its code with no page at all.
    const authD = authorization();
    const hop = await context.request.get(authD.url, { maxRedirects: 0, headers: { accept: 'text/html' } });
    assert.equal(hop.status(), 302, 'the authorization answers with the redirect to the client at once');
    assert.equal((await redeem(new URL(hop.headers().location!), authD)).flux_connection_id, made[0]!.id);
    assert.equal((await connections()).length, 1, 'signing in again makes no second connection');

    // Settings › AI: one row with its "What it may do" and Disconnect; no project, scope or permission to choose.
    const settings = await context.newPage();
    await settings.goto(`${origin}/settings/agents/connect`);
    const row = settings.locator('.connection__saved').filter({ hasText: 'Claude Code on this computer' });
    await row.waitFor({ state: 'visible' });
    await row.getByRole('radio', { name: 'Ask me first' }).click();
    await settings.waitForFunction(async () => (await (await fetch('/api/v1/agent-connections')).json() as { mayDo: string }[]).some((item) => item.mayDo === 'ask'));
    assert.equal((await connections())[0]!.may_do, 'ask');
    assert.equal(await settings.getByText('Run approved project actions').count(), 0);
    await row.getByRole('button', { name: 'Disconnect' }).click();
    await row.getByRole('button', { name: 'Disconnect', exact: true }).last().click();
    await settings.getByText('Disconnected (1)').waitFor({ state: 'visible' });
    assert.notEqual((await connections())[0]!.revoked_at, null, 'Disconnect ends the connection');
  } finally {
    await Promise.all(contexts.map((context) => context.close())); await browser.close();
    await new Promise<void>((resolve) => proxy.close(() => resolve())); await pool.end();
  }
});
