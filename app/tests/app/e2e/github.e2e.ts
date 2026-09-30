import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { createDatabase } from '@flux/db';
import type { WorkItem } from '@flux/contracts';
import { githubRoutes } from '../../../apps/server/src/github/routes.js';
import type { GithubConfig } from '../../../apps/server/src/github/config.js';
import type { GithubTransport } from '../../../apps/server/src/github/http.js';
import { loadIdentityConfig, registerIdentity } from '../../../apps/server/src/identity/index.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from '../support/people.js';
import { apiUrl, publicOrigin } from '../support/http.js';

/** The browser uses real Flux sessions, routes and SQL. Only the external GitHub transport is
 * injected in the test process. No production fake provider endpoint or real-installation claim. */
const config: GithubConfig = { appId: '12345', appSlug: 'flux-browser-fixture', clientId: 'Iv1.browser-fixture',
  clientSecret: 'browser-fixture-client-secret', webhookSecret: 'browser-fixture-webhook-secret-thirty-two', encryptionKey: Buffer.alloc(32, 16), publicOrigin };
class ReadTransportFixture implements GithubTransport {
  denied = false;
  async json(url: string) {
    const path = new URL(url).pathname;
    if (path === '/login/oauth/access_token') return { data: { token_type: 'bearer', scope: '', access_token: 'ghu_browser_fixture', refresh_token: 'ghr_browser_fixture', expires_in: 28800, refresh_token_expires_in: 15897600 }, truncated: false };
    if (path === '/user') return { data: { id: 765, login: 'ada-fixture' }, truncated: false };
    if (path === '/user/installations') return { data: { installations: [{ id: 555, app_id: 12345, account: { login: 'lamp-team' }, permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', issues: 'read' }, suspended_at: null }] }, truncated: false };
    if (path.endsWith('/repositories')) return { data: { repositories: this.denied ? [] : [{ id: 777, owner: { login: 'lamp-team' }, name: 'gesture-lamp-firmware', private: true, permissions: { pull: true } }] }, truncated: false };
    if (path.endsWith('/pulls/42')) return { data: { id: 77742, number: 42, title: 'Keep a manual off switch when gesture sensing loses calibration',
      user: { id: 981, login: 'nia-firmware' }, base: { repo: { id: 777 } }, head: { sha: 'a'.repeat(40) }, state: 'open', draft: false, merged: false,
      created_at: '2026-09-29T10:00:00Z', updated_at: '2026-09-30T11:00:00Z', merged_at: null }, truncated: false };
    if (path.endsWith('/check-runs')) return { data: { total_count: 1, check_runs: [{ id: 55542, name: 'Firmware regression', app: { id: 45 }, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', completed_at: '2026-09-30T11:00:00Z' }] }, truncated: false };
    if (path.endsWith('/status')) return { data: { sha: 'a'.repeat(40), statuses: [] }, truncated: false };
    if (path.endsWith('/reviews')) return { data: [], truncated: false } as unknown as Awaited<ReturnType<GithubTransport['json']>>;
    throw new Error(`Unexpected browser fixture provider path: ${path}`);
  }
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
const transport = new ReadTransportFixture(); const app = Fastify({ logger: false });
const identity = registerIdentity(app, { db, config: loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: publicOrigin, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET, FLUX_AUTH_RATE_LIMIT: 'false' }), mailer: null });
let configuredFixture = false;
const upstream = new URL(apiUrl);
const proxy = http.createServer(async (request, response) => {
  if (configuredFixture && request.url?.startsWith('/api/v1/') && request.url.includes('/github')) {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await app.inject({ method: request.method as 'GET', url: request.url, headers: request.headers, payload: Buffer.concat(chunks) });
    response.writeHead(result.statusCode, result.headers).end(result.rawPayload); return;
  }
  const forward = http.request({ host: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
  });
  forward.on('error', () => response.destroy()); request.pipe(forward);
});
proxy.on('upgrade', (request, socket, head) => {
  const target = net.connect(Number(upstream.port || 80), upstream.hostname, () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    target.write(`${lines.join('\r\n')}\r\n\r\n`); if (head.length) target.write(head); target.pipe(socket); socket.pipe(target);
  });
  const end = () => { target.destroy(); socket.destroy(); }; target.on('error', end); socket.on('error', end);
});
let browser: Browser; const contexts: BrowserContext[] = [];
before(async () => {
  await app.register(githubRoutes, { db, sessions: identity, config, transport, background: false }); await app.ready();
  await new Promise<void>((resolve) => proxy.listen(Number(new URL(publicOrigin).port), '127.0.0.1', resolve));
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close(); proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); await app.close(); await pool.end();
});
async function context(who: Person, options: { viewport?: { width: number; height: number }; isMobile?: boolean; hasTouch?: boolean } = {}) {
  const ctx = await browser.newContext({ baseURL: publicOrigin, locale: 'en-GB', timezoneId: 'Europe/Warsaw', serviceWorkers: 'block', ...options }); contexts.push(ctx);
  await ctx.addCookies([...who.browser.cookies].map(([name, value]) => ({ name, value, url: publicOrigin, httpOnly: true, sameSite: 'Lax' })));
  // Browser navigation to the external provider is the only fixture redirect; callback runs real OAuth state/PKCE/SQL.
  await ctx.route('https://github.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/login/oauth/authorize' && url.pathname !== `/apps/${config.appSlug}/installations/new`) throw new Error('Unexpected external browser navigation');
    const target = new URL('/api/v1/integrations/github/callback', publicOrigin); target.searchParams.set('state', url.searchParams.get('state')!);
    target.searchParams.set(url.pathname === '/login/oauth/authorize' ? 'code' : 'installation_id', url.pathname === '/login/oauth/authorize' ? 'browser-fixture-code' : '555');
    await route.fulfill({ status: 302, headers: { location: target.toString() }, body: '' });
  });
  return ctx;
}
test('real settings UI binds, verifies PR links and removes private projections on access loss at phone/tablet/desktop sizes', { timeout: 90_000 }, async () => {
  const owner = await person('Ada'); const viewer = await person('Jonas');
  const ws = await workspace(owner, 'Lamp workshop'); await addMember(owner, ws.id, viewer, 'member');
  const place = await project(owner, ws.id, 'Gesture lamp', 'restricted'); await grant(owner, place.id, viewer, 'viewer');
  const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Verify physical off-switch behaviour after calibration fails' } }), 201) as WorkItem;
  const page = await (await context(owner)).newPage(); const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ projectId }) => sessionStorage.setItem(`flux.project-conversation.${projectId}`, `/projects/${projectId}/github`), { projectId: place.id });
  await page.goto(`/projects/${place.id}/github`);
  await page.getByRole('heading', { name: 'GitHub is not configured on this server' }).waitFor();
  const views = page.getByRole('navigation', { name: 'Project views', exact: true });
  assert.equal(await views.locator('[aria-current="page"]').count(), 0, 'settings do not select a conversation tab');
  assert.equal(await views.getByRole('link', { name: 'Conversation', exact: true }).getAttribute('href'), `/projects/${place.id}`, 'old settings destination is not a conversation');
  await views.getByRole('link', { name: 'Conversation', exact: true }).click();
  await page.waitForURL(`**/projects/${place.id}`);
  await page.goto(`/projects/${place.id}/github`);
  await page.getByRole('heading', { name: 'GitHub is not configured on this server' }).waitFor();
  configuredFixture = true; await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to GitHub', exact: true }).click();
  await page.getByRole('heading', { name: 'Connected repositories', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Install App on repositories', exact: true }).click();
  await page.getByRole('button', { name: 'Choose installation', exact: true }).click();
  await page.getByLabel('Installation', { exact: true }).selectOption('555');
  const picker = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add a repository', exact: true }) });
  await picker.getByLabel('Repository', { exact: true }).selectOption('777');
  await page.getByRole('button', { name: 'Connect repository', exact: true }).click();
  await page.getByRole('heading', { name: 'Link an existing pull request', exact: true }).waitFor();
  await page.getByLabel('Task', { exact: true }).selectOption(task.id);
  const linker = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Link an existing pull request', exact: true }) });
  await linker.getByLabel('Repository', { exact: true }).selectOption({ label: 'lamp-team/gesture-lamp-firmware' });
  await page.getByLabel('Pull request number', { exact: true }).fill('42');
  await page.getByRole('button', { name: 'Verify and link PR', exact: true }).click();
  const privatePull = page.getByRole('link', { name: '#42 · Keep a manual off switch when gesture sensing loses calibration', exact: true }); await privatePull.waitFor();
  assert.match(await linker.innerText(), /nia-firmware.*head aaaaaaaaaaaa/);
  for (const [label, width, height] of [['desktop', 1440, 900], ['tablet', 820, 1180], ['phone', 390, 844]] as const) {
    const target = label === 'desktop' ? page : await (await context(owner, { viewport: { width, height }, hasTouch: true, isMobile: label === 'phone' })).newPage();
    await target.setViewportSize({ width, height });
    if (target !== page) {
      await target.goto(`/projects/${place.id}/github`); await target.getByLabel('Task', { exact: true }).selectOption(task.id);
      await target.getByRole('link', { name: /#42 · Keep a manual off switch/ }).waitFor();
    }
    assert.ok(await target.locator('body').evaluate((el) => el.scrollWidth) <= width, `${label} has no horizontal overflow`);
    assert.equal(await target.getByRole('navigation', { name: 'Project views', exact: true }).locator('[aria-current="page"]').count(), 0, `${label} settings do not select a conversation tab`);
    const directory = process.env.FLUX_E2E_EVIDENCE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true }); await target.locator('.github-settings').evaluate((el) => { el.parentElement!.scrollTop = 0; });
      await target.screenshot({ path: join(directory, `github-settings-${label}.png`), fullPage: true });
      await target.locator('.github-settings__pulls').scrollIntoViewIfNeeded();
      await target.screenshot({ path: join(directory, `github-settings-${label}-linked.png`), fullPage: true });
    }
  }
  const memberPage = await (await context(viewer)).newPage(); await memberPage.goto(`/projects/${place.id}/github`);
  await memberPage.getByRole('heading', { name: 'Authorize your GitHub account', exact: true }).waitFor();
  assert.equal(await memberPage.getByText('gesture-lamp-firmware', { exact: false }).count(), 0);
  assert.equal(await memberPage.getByRole('link', { name: /Keep a manual off switch/ }).count(), 0);
  transport.denied = true; await page.getByRole('button', { name: 'Refresh access', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('link', { name: /Keep a manual off switch/ }).count(), 0);
  assert.equal(await page.getByText('gesture-lamp-firmware', { exact: false }).count(), 0);
  const native = expectStatus(await owner.browser.request('GET', `/api/v1/work/${task.id}`), 200) as WorkItem;
  assert.deepEqual([native.status, native.blocker, native.version], ['open', null, 1]); assert.deepEqual(errors, []);
  await Promise.all(contexts.map((ctx) => ctx.close()));
});
