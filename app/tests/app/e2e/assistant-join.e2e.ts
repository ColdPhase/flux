import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright';
import { expect } from 'playwright/test';
import { PERSONAL_RUN_CONSENT_VERSION } from '@flux/contracts';
import { personalRunUseCases } from '../../../apps/server/src/personal-runs/adapters.js';
import { db, pool } from '../support/db.js';
import { addMember, expectStatus, password, person, project, workspace, type Person } from '../support/people.js';
import { FakeConnections, FakeQueue } from '../support/personal-runs.js';

// Real sessions/UI/SQL/grants; only compute metadata is fake, with no model call or vendor spend.
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
// A transport fault at the test proxy also covers fetches owned by a real service worker.
const rejectedCommands = new Set<string>();
const proxy = http.createServer((request, response) => {
  if (request.method === 'POST' && rejectedCommands.delete(request.url ?? '')) {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'FORBIDDEN', message: 'Not allowed' })); return;
  }
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
  });
  response.on('close', () => forward.destroy());
  forward.on('error', () => response.destroy()); request.pipe(forward);
});
before(async () => { await new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve)); });
after(async () => { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); });

async function signedIn(context: BrowserContext, who: Person, path: string) {
  const signed = await context.request.post(`${origin}/api/auth/sign-in/email`, { data: { email: who.email, password }, headers: { origin } });
  assert.equal(signed.status(), 200, await signed.text());
  const page = await context.newPage(); await page.goto(`${origin}${path}`); return page;
}
async function capture(page: Page, label: string) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.evaluate(async () => { await document.fonts.ready; (document.activeElement as HTMLElement | null)?.blur(); });
  await page.screenshot({ path: join(evidence, label + '.png'), fullPage: true });
}
async function theme(page: Page, choice: 'light' | 'dark') {
  await page.evaluate((value) => { localStorage.setItem('flux.theme', value); window.dispatchEvent(new StorageEvent('storage', { key: 'flux.theme' })); }, choice);
  await expect(page.locator('html')).toHaveAttribute('data-theme', choice);
}

for (const [engine, mobile] of [['chromium', false], ['webkit', true]] as const) {
  test(`${engine}: owner Request reaches manager Inbox, only manager Allow creates a contributor grant`, { timeout: 120_000 }, async () => {
    const manager = await person('Jonas Berg'); const owner = await person('Ada Kowalska Nowak – Community Sensor Team'); const viewer = await person('Lee Reader');
    const ws = await workspace(manager, 'Community garden'); await addMember(manager, ws.id, owner, 'member'); await addMember(manager, ws.id, viewer, 'member');
    const place = await project(manager, ws.id, 'Community garden sensors', 'workspace');
    expectStatus(await manager.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: {
      title: 'Calibrate the probes at two soil depths', outcome: 'Repeatable measurements at 10 cm and 25 cm',
    } }), 201);
    const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Ada’s assistant', owner: 'self' } }), 201) as { id: string };
    const connections = new FakeConnections(); connections.connect(owner.id, randomUUID()); const queue = new FakeQueue();
    await personalRunUseCases(db, { connections, queue: queue.factory, providerEnabled: true }).enable({ kind: 'human', id: owner.id }, {
      consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId: agent.id,
    });
    const browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true, ...(engine === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
    const contexts: BrowserContext[] = [];
    try {
      const options = { viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, locale: 'en-GB', reducedMotion: 'reduce' as const };
      const ownerContext = await browser.newContext(options); contexts.push(ownerContext);
      const managerContext = await browser.newContext(options); contexts.push(managerContext);
      const viewerContext = await browser.newContext(options); contexts.push(viewerContext);
      const path = `/projects/${place.id}/agents`;
      const ownerPage = await signedIn(ownerContext, owner, '/settings/assistant');
      // Project access sits under the folded More (#588).
      const openMore = () => ownerPage.locator('details.aset__more > summary').click();
      await openMore();
      const ownRequests = ownerPage.getByRole('region', { name: 'Assistant join requests' });
      const ask = ownRequests.getByRole('button', { name: 'Ask a manager to add my assistant', exact: true });
      await expect(ask).toBeVisible(); await theme(ownerPage, 'light'); await capture(ownerPage, `join-${engine}-owner-request-light`);
      assert.equal((await pool.query('SELECT id FROM project_grants WHERE project_id=$1 AND agent_id=$2', [place.id,agent.id])).rowCount, 0);
      await ask.focus(); await ask.press('Enter');
      await expect(ownRequests.getByRole('status')).toContainText('Asked a project manager');
      const pending = (await pool.query("SELECT id FROM assistant_join_requests WHERE project_id=$1 AND owner_user_id=$2 AND state='pending'", [place.id,owner.id])).rows;
      assert.equal(pending.length, 1);
      assert.equal((await pool.query('SELECT id FROM project_grants WHERE project_id=$1 AND agent_id=$2', [place.id,agent.id])).rowCount, 0, 'Request creates no grant');
      await ownRequests.getByRole('button', { name: /Review/ }).click();
      await expect(ownRequests.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0);
      const outsiderPage = await signedIn(viewerContext, viewer, path);
      await expect(outsiderPage.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
      await expect(outsiderPage.getByRole('region', { name: 'Assistant join requests' })).toHaveCount(0);
      const refused = await viewerContext.request.post(`${origin}/api/v1/projects/${place.id}/assistant-join-requests/${pending[0]!.id}/allow`, { headers: { origin } });
      assert.equal(refused.status(), 403);
      const managerPage = await signedIn(managerContext, manager, '/inbox');
      const invitation = managerPage.locator('.nyc').filter({ hasText: 'Ada’s assistant' });
      await expect(invitation).toHaveCount(1);
      await expect(invitation.locator('.nyc__eyebrow')).toContainText('Ada’s assistant');
      await expect(invitation.locator('.nyc__title')).toHaveText("Ada Kowalska Nowak – Community Sensor Team's assistant asks to join");
      await expect(invitation).toContainText('for Ada Kowalska Nowak – Community Sensor Team');
      await expect(invitation.locator('.nyc__reason')).toContainText('Community garden sensors');
      await expect(invitation.locator('.nyc__face .kreska')).toHaveCount(1);
      await expect(invitation.locator('.nyc__face .ui-avatar')).toHaveCount(0);
      await expect(invitation.locator('.agent-tag')).toHaveText('Agent');
      await expect(invitation.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
       // Final design §3 glyph scale (16/20/24/32/48): the assistant identity uses Kreska without a human avatar holder.
       for (const choice of ['light', 'dark'] as const) {
         await theme(managerPage, choice);
         const glyph = (await invitation.locator('.nyc__face .kreska').boundingBox())!;
         assert.deepEqual([glyph.width, glyph.height], [32, 32], `${choice} Needs you Kreska is 32x32`);
         await capture(managerPage, `join-${engine}-manager-needs-you-${choice}`);
         if (evidence) await invitation.screenshot({ path: join(evidence, `join-${engine}-needs-you-card-${choice}.png`) });
       }
      const review = invitation.getByRole('button', { name: 'Review', exact: true });
      if (mobile) assert.ok((await review.boundingBox())!.height >= 44);
      await review.focus(); await review.press('Enter'); await expect(managerPage).toHaveURL(/\/inbox\/[0-9a-f-]+$/);
      // A pending question remains actionable after it leaves Needs You (legacy read + older than 14 days).
      const notification = (await pool.query('SELECT id FROM notifications WHERE assistant_join_request_id=$1 AND user_id=$2', [pending[0]!.id, manager.id])).rows[0];
      await pool.query("UPDATE notifications SET read_at=now(), created_at=now()-interval '15 days' WHERE id=$1", [notification.id]);
      await managerPage.goto(`${origin}/inbox`);
      await expect(managerPage.locator('.nyc').filter({ hasText: 'Ada’s assistant' })).toHaveCount(0);
      const unauthorized = await viewerContext.request.get(`${origin}/api/v1/inbox/${notification.id}`);
      assert.equal(unauthorized.status(), 404, 'another recipient cannot load the question identity');
      await managerPage.goto(`${origin}/inbox/${notification.id}`);
      const requests = managerPage.getByRole('region', { name: 'Assistant join requests' });
      await theme(managerPage, 'light'); await capture(managerPage, `join-${engine}-manager-row-light`);
      const allow = requests.getByRole('button', { name: 'Allow', exact: true });
      await expect(allow).toBeVisible();
      const inset = await requests.evaluate((element) => {
        const surface = element.getBoundingClientRect();
        return [...element.querySelectorAll('h2, p, footer')].map((child) => {
          const box = child.getBoundingClientRect(); return { left: box.left - surface.left, right: surface.right - box.right };
        });
      });
      assert.ok(inset.every((box) => box.left >= 16 && box.right >= 16), 'review copy and actions stay inside the dialog inset');
      if (mobile) assert.ok((await allow.boundingBox())!.height >= 44);
      await capture(managerPage, `join-${engine}-manager-review-light`);
      await theme(managerPage, 'dark'); await capture(managerPage, `join-${engine}-manager-review-dark`);
      // A refused answer keeps the real pending record; the successful retry uses the actual API.
      const allowUrl = `${origin}/api/v1/projects/${place.id}/assistant-join-requests/${pending[0]!.id}/allow`;
      rejectedCommands.add(new URL(allowUrl).pathname);
      await allow.click(); await expect(requests.getByRole('alert')).toContainText('Only a current project manager');
      assert.equal((await pool.query('SELECT id FROM project_grants WHERE project_id=$1 AND agent_id=$2', [place.id,agent.id])).rowCount, 0);
      await allow.click();
      await expect(requests.getByRole('status')).toHaveText('Request allowed.');
      assert.equal((await pool.query('SELECT role FROM project_grants WHERE project_id=$1 AND agent_id=$2', [place.id,agent.id])).rows[0].role, 'contributor');
      assert.equal((await pool.query('SELECT state FROM assistant_join_requests WHERE id=$1', [pending[0]!.id])).rows[0].state, 'accepted');
      await ownerPage.reload(); await openMore();
      await expect(ownerPage.getByRole('region', { name: 'Assistant join requests' }).getByRole('button', { name: 'Ask a manager to add my assistant', exact: true })).toHaveCount(0);
      await expect(ownerPage.getByRole('region', { name: 'Your assistant’s project access' })).toContainText('Your assistant has access to this project.');
      await ownerPage.goto(`${origin}${path}`);
      await expect(ownerPage.locator('.agents-list')).toHaveCount(0);
      await expect(ownerPage.getByRole('region', { name: 'Assistant join requests' })).toHaveCount(0);
      await outsiderPage.reload();
      await expect(outsiderPage.locator('.agents-list')).toHaveCount(0);
      const memberPeople = await viewerContext.request.get(`${origin}/api/v1/projects/${place.id}/people`);
      assert.equal((await memberPeople.json() as { id: string }[]).some((person) => person.id === agent.id), false, 'another member never discovers the assistant as a project member (#522)');
      if (evidence) writeFileSync(join(evidence, `join-${engine}-manifest.json`), JSON.stringify({ sourceSha: process.env.FLUX_E2E_SOURCE_SHA,
        engine, viewport: options.viewport, cssZoom: 1, themes: ['light','dark'], compute: 'fake metadata only; zero model calls',
        observed: ['Request→Needs You question with immutable assistant/owner identity→manager Review/Allow', 'no grant before Allow', 'ordinary reader sees no request and API Allow403', 'contributor grant persisted after Allow', 'failed Allow keeps pending request', 'keyboard Enter', ...(mobile ? ['44px targets'] : [])] }, null, 2));
    } finally { await Promise.all(contexts.map((context) => context.close())); await browser.close(); }
  });
}
