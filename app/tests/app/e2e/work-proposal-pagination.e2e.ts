import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';

const fixture = JSON.parse(readFileSync('/state/proactive-outcomes-ui.json', 'utf8')) as {
  email: string; viewerEmail: string; password: string; projectId: string; proposalId: string; insufficientId: string; ownerId: string;
};
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const origin = new URL(process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:18089');
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: Number(upstream.port || 80), method: request.method,
    path: request.url, headers: request.headers }, (answer) => { response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response); });
  forward.on('error', () => response.destroy()); request.pipe(forward);
});
let browser: Browser;
async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  }, { method, path, body });
}
async function login(page: Page, email = fixture.email) {
  await page.goto(origin.origin);
  assert.equal((await api(page, 'POST', '/api/auth/sign-in/email', { email, password: fixture.password })).status, 200);
}
before(async () => {
  await new Promise<void>((resolve) => proxy.listen(Number(origin.port || 80), origin.hostname, resolve));
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); });

test('comparison jumps expose headings below sticky controls on a bounded page and outside All first page', async () => {
  const setup = await browser.newContext(); const creator = await setup.newPage();
  try {
    await login(creator);
    for (let i = 0; i < 52; i++) {
      assert.equal((await api(creator, 'POST', `/api/v1/projects/${fixture.projectId}/work`, { title: `Bounded jump work ${i}` })).status, 201);
      assert.equal((await api(creator, 'POST', `/api/v1/projects/${fixture.projectId}/results`, { title: `Bounded jump result ${i}`, finding: 'positive', evidence: 'A native persisted result; no comparison trigger.' })).status, 201);
    }
    for (const width of [1440, 390, 1024]) {
      const context = await browser.newContext({ storageState: await setup.storageState(), viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width < 1440, isMobile: width === 390 });
      const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks?view=list`);
        const views = page.getByRole('navigation', { name: 'Task views' });
        const jumps = page.getByRole('navigation', { name: 'Project work sections' });
        await jumps.waitFor();
        for (const [label, target, expectedView] of [['Work', 'g-open', 'All'], ['Results', 'g-results', 'Results']] as const) {
          // The phone has no group views: its saved view is Mine (and a group only when a jump names one).
          const phone = width === 390; const mine = page.getByRole('group', { name: 'Whose tasks' });
          if (phone) await mine.getByRole('button', { name: 'Mine', exact: true }).tap();
          else {
            await views.getByRole('button', { name: /^Open / }).click();
            await views.getByRole('checkbox', { name: 'Only mine', exact: true }).check();
          }
          await page.locator('.ws-none').waitFor();
          assert.equal(await page.locator(`#${target}`).count(), 0);
          const jump = jumps.getByRole('button', { name: new RegExp(`^${label} `) });
          if (width < 1440) await jump.tap(); else await jump.click();
          const heading = page.locator(`#${target}`); await heading.waitFor();
          await page.waitForFunction((id) => {
            const h = document.getElementById(id), c = document.querySelector('.ws-task-controls');
            if (!h || !c) return false;
            const target = h.getBoundingClientRect(), controls = c.getBoundingClientRect();
            return target.top >= controls.bottom && target.bottom < innerHeight;
          }, target, { timeout: 3000 });
          const geometry = await heading.evaluate((node) => ({ top: node.getBoundingClientRect().top,
            controlsBottom: document.querySelector('.ws-task-controls')!.getBoundingClientRect().bottom }));
          assert.ok(geometry.top >= geometry.controlsBottom, `heading remains visible below controls: ${JSON.stringify(geometry)}`);
          if (phone) {
            assert.equal(await mine.getByRole('button', { name: 'All', exact: true }).getAttribute('aria-pressed'), 'true');
            assert.equal(await mine.getByRole('button', { name: 'Mine', exact: true }).getAttribute('aria-pressed'), 'false');
            assert.equal(new URL(page.url()).searchParams.get('status'), expectedView === 'All' ? null : 'results');
          } else {
            const chosen = expectedView === 'All' ? views.getByRole('button', { name: 'All', exact: true }) : views.getByRole('button', { name: /^Results / });
            assert.equal(await chosen.getAttribute('aria-pressed'), 'true');
            assert.equal(await views.getByRole('checkbox', { name: 'Only mine', exact: true }).isChecked(), false);
          }
          const path = expectedView === 'All' ? 'work-view?limit=50' : 'work-view?group=results&limit=50';
          const read = await api(page, 'GET', `/api/v1/projects/${fixture.projectId}/${path}`);
          assert.equal(read.status, 200);
          assert.equal((read.data as { items: unknown[] }).items.length, 50);
          console.log('BOUND_JUMP_GEOMETRY', JSON.stringify({ width, label, expectedView, ...geometry }));
          await page.screenshot({ path: `${process.env.FLUX_E2E_EVIDENCE_DIR ?? '/state'}/bounded-proposal-jump-${label.toLowerCase()}-${width}.png` });
        }
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await setup.close(); }
});
