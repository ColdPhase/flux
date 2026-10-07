import assert from 'node:assert/strict';
import { hasMinimumTouchSize } from '../support/touch-target.js';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createDatabase } from '@flux/db';
import type { GithubBinding, GithubCheck, GithubPullFacts, WorkItem } from '@flux/contracts';
import { NotFoundError, type GithubProvider, type Principal } from '@flux/core';
import { createGithubUseCases } from '../../../apps/server/src/github/adapters.js';
import { githubCredentials } from '../../../apps/server/src/github/credentials.js';
import { githubRoutes } from '../../../apps/server/src/github/routes.js';
import type { GithubConfig } from '../../../apps/server/src/github/config.js';
import type { GithubTransport } from '../../../apps/server/src/github/http.js';
import { loadIdentityConfig, registerIdentity } from '../../../apps/server/src/identity/index.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from '../support/people.js';
import { apiUrl, publicOrigin } from '../support/http.js';

/** "Let linked PRs move this task" (#74 G-1a) in the running web app: the toggle, its history line, the paused state with
 * Resume and Ready to close with one-tap Done, at desktop and 390 px. Real sessions, routes and SQL; only the GitHub
 * provider is a typed fixture injected in this process, behind the same proxy as github.e2e.ts. No real installation. */
const config: GithubConfig = { appId: '34567', appSlug: 'flux-rule-browser', clientId: 'Iv1.rule-browser', clientSecret: 'rule-browser-client-secret',
  webhookSecret: 'rule-browser-webhook-secret-thirty-two-chars', encryptionKey: Buffer.alloc(32, 23), publicOrigin };
const SHA = 'c'.repeat(40);
const check = (state: GithubCheck['state']): GithubCheck => ({ id: '4401', name: 'firmware / test', appId: '45', state, sourceUpdatedAt: '2026-10-05T10:00:00.000Z' });
class Provider implements GithubProvider {
  readers = new Set<string>(); generation = randomUUID(); now = { state: 'open' as 'open' | 'closed', merged: false, checks: [check('pending')] };
  async repository(principal: Principal, installationId: string, repositoryId: string) {
    if (!this.readers.has(principal.id)) throw new NotFoundError('Repository', 'GITHUB_ACCESS_UNAVAILABLE');
    return { host: 'github.com' as const, installationId, repositoryId, owner: 'lamp-team', name: 'gesture-lamp-firmware', private: true,
      url: 'https://github.com/lamp-team/gesture-lamp-firmware', githubUserId: '765', appId: config.appId, authorizationGeneration: this.generation };
  }
  async pull(principal: Principal, repository: { repositoryId: string; url: string }, number: number): Promise<GithubPullFacts> {
    if (!this.readers.has(principal.id)) throw new NotFoundError('Pull request', 'GITHUB_ACCESS_UNAVAILABLE');
    const { state, merged, checks } = this.now;
    return { repositoryId: repository.repositoryId, pullId: '77742', number, title: 'Keep a manual off switch when calibration fails', url: `${repository.url}/pull/${number}`,
      author: { id: '981', login: 'nia-firmware' }, headSha: SHA, state, draft: false, merged, sourceCreatedAt: '2026-10-01T10:00:00.000Z',
      sourceUpdatedAt: '2026-10-05T10:00:00.000Z', sourceMergedAt: merged ? '2026-10-05T12:00:00.000Z' : null, checks, reviews: [], truncated: false,
      execution: merged ? 'merged' : checks.some((item) => item.state === 'failure') ? 'checks_failed' : checks.every((item) => item.state === 'success') ? 'ready_for_review' : 'checks_pending' };
  }
}
/** Only the stored credential's own identity check (capabilities reports "connected"); facts come from the provider fixture. */
const identityOnly: GithubTransport = { async json() { return { data: { id: 765, login: 'ada-fixture' }, truncated: false }; } };

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
const provider = new Provider(); const github = createGithubUseCases(db, provider);
const app = Fastify({ logger: false });
const identity = registerIdentity(app, { db, config: loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: publicOrigin, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET, FLUX_AUTH_RATE_LIMIT: 'false' }), mailer: null });
const upstream = new URL(apiUrl);
const proxy = http.createServer(async (request, response) => {
  if (request.url?.startsWith('/api/v1/') && request.url.includes('/github')) {
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
let browser: Browser; const contexts: BrowserContext[] = []; const errors: string[] = [];
before(async () => {
  await app.register(githubRoutes, { db, sessions: identity, config, transport: identityOnly, provider, background: false }); await app.ready();
  await new Promise<void>((resolve) => proxy.listen(Number(new URL(publicOrigin).port), '127.0.0.1', resolve));
  browser = await chromium.launch();
});
after(async () => {
  await Promise.all(contexts.map((ctx) => ctx.close())); await browser?.close();
  proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); await app.close(); await pool.end();
});
async function open(who: Person, path: string, phone = false): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: publicOrigin, locale: 'en-GB', timezoneId: 'Europe/Warsaw', serviceWorkers: 'block',
    ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1440, height: 900 } }) });
  contexts.push(ctx);
  await ctx.addCookies([...who.browser.cookies].map(([name, value]) => ({ name, value, url: publicOrigin, httpOnly: true, sameSite: 'Lax' as const })));
  const page = await ctx.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(path); return page;
}
async function settle(binding: GithubBinding) {
  const rows = await pool.query(`SELECT gp.delivery_id FROM github_processing gp JOIN github_deliveries gd ON gd.id=gp.delivery_id
    WHERE gp.binding_id=$1 AND gp.state='pending' ORDER BY gd.received_at, gd.id`, [binding.id]);
  for (const row of rows.rows) await github.process(row.delivery_id, binding.id);
}
async function evidence(page: Page, name: string) {
  const directory = process.env.FLUX_E2E_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.locator('#details').screenshot({ path: join(directory, `github-rule-${name}.png`) });
}
const details = (page: Page) => page.locator('#details');

test('task Details: turn the rule on, see sourced automatic changes, resume after a manual change and finish when ready (desktop, 390 px)', { timeout: 120_000 }, async () => {
  const owner = await person('Ada Lind'); const viewer = await person('Jonas Berg');
  const ws = await workspace(owner, 'Lamp workshop'); await addMember(owner, ws.id, viewer, 'member');
  const place = await project(owner, ws.id, 'Gesture lamp', 'restricted'); await grant(owner, place.id, viewer, 'viewer');
  const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: {
    title: 'Keep a manual off switch when calibration fails', criteria: ['The lamp turns off by hand after a failed calibration'] } }), 201) as WorkItem;
  provider.readers.add(owner.id);
  await githubCredentials(db, config, identityOnly).store(owner.id, { access_token: 'ghu_rule_browser_fixture', token_type: 'bearer', scope: '' });
  const binding = await github.bind({ kind: 'human', id: owner.id }, place.id, { installationId: '555', repositoryId: '777' });
  await github.link({ kind: 'human', id: owner.id }, task.id, { bindingId: binding.id, number: 42, role: 'required_output' });
  const link = `/projects/${place.id}/tasks?open=work:${task.id}`;

  // Turn it on from task Details.
  let page = await open(owner, link);
  const toggle = details(page).getByRole('switch', { name: 'Let linked PRs move this task' });
  await details(page).getByRole('link', { name: '#42 · Keep a manual off switch when calibration fails' }).waitFor();
  assert.equal(await toggle.isChecked(), false);
  await details(page).getByText('Everyone who can see this task sees these changes, with PR numbers, check names and commits.', { exact: false }).waitFor();
  await evidence(page, 'desktop-off');
  await toggle.click(); // controlled by the server's answer, so not Playwright's check()
  await details(page).getByText('Set up by Ada Lind.', { exact: false }).waitFor();
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await details(page).getByLabel('When every required PR is merged').inputValue(), 'ready', 'written criteria default to Ready to close');

  // A failing check on the PR's head blocks it, with the check and PR as the reason and a history line.
  provider.now.checks = [check('failure')]; await settle(binding);
  page = await open(owner, link);
  await details(page).getByText('Blocked: Check “firmware / test” failed on PR #42').waitFor();
  const history = details(page).getByRole('list', { name: 'Changes by GitHub rule' });
  await history.getByText('by GitHub rule · set up by Ada Lind', { exact: false }).first().waitFor();
  assert.match(await history.innerText(), /Blocked\s*Check “firmware \/ test” failed on PR #42/);
  await evidence(page, 'desktop-blocked');

  // A person changes the status by hand: the rule pauses until someone resumes it.
  await details(page).getByLabel('Status', { exact: true }).selectOption('in_progress');
  await details(page).getByText('Paused because someone changed the status or blocker by hand.', { exact: false }).waitFor();
  await evidence(page, 'desktop-paused');
  await details(page).getByRole('button', { name: 'Resume' }).click();
  await details(page).getByText('Paused because', { exact: false }).waitFor({ state: 'detached' });

  // Every required PR merged: Ready to close, and a reader without GitHub access sees the same task state.
  provider.now = { state: 'closed', merged: true, checks: [check('success')] }; await settle(binding);
  const phone = await open(owner, link, true);
  const ready = details(phone).getByRole('button', { name: 'Mark done' });
  await ready.waitFor();
  await details(phone).getByText('Ready to close.', { exact: true }).waitFor();
  for (const target of [ready, details(phone).locator('.wd-gh-toggle'), details(phone).getByLabel('When every required PR is merged'), details(phone).getByRole('link', { name: /#42 · Keep a manual off switch/ })]) {
    const box = await target.boundingBox();
    assert.ok(box && hasMinimumTouchSize(box.height), `44 px touch target at 390 px (${box?.height})`);
  }
  assert.ok(await phone.locator('body').evaluate((el) => el.scrollWidth) <= 390, 'no horizontal overflow at 390 px');
  await evidence(phone, 'phone-ready');
  const reader = await open(viewer, link);
  await details(reader).getByText('Ready to close.', { exact: true }).waitFor();
  assert.equal(await details(reader).getByRole('button', { name: 'Mark done' }).count(), 0, 'a viewer cannot finish it');
  assert.equal(await details(reader).getByRole('switch').count(), 0, 'a viewer cannot change the rule');
  assert.equal(await details(reader).getByText('Keep a manual off switch when calibration fails · ', { exact: false }).count(), 0);
  assert.match(await details(reader).getByRole('list', { name: 'Changes by GitHub rule' }).innerText(), /Every required PR is merged · ready to close/);
  await evidence(reader, 'desktop-reader');

  await ready.click();
  await details(phone).getByRole('button', { name: 'Mark done' }).waitFor({ state: 'detached' });
  const finished = expectStatus(await owner.browser.request('GET', `/api/v1/work/${task.id}`), 200) as WorkItem;
  assert.deepEqual([finished.status, finished.githubRule?.state, finished.githubRule?.readyToClose], ['done', 'active', false]);
  await evidence(phone, 'phone-done');
  assert.deepEqual(errors, [], 'no uncaught page errors');
});
