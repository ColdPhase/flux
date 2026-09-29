import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

interface Fixture { email: string; password: string; projectId: string; proposalIds: string[];
  conversationId: string; messageId: string; workId: string; sketchId: string; thoughtId: string }
const fixture = JSON.parse(readFileSync('/state/proactive-ui.json', 'utf8')) as Fixture;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const origin = new URL(process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:18089');
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: Number(upstream.port || 80),
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(response);
  });
  forward.on('error', () => response.destroy());
  request.pipe(forward);
});
let browser: Browser;
let context: BrowserContext;
let page: Page;

async function api(method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, { method, credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }, { method, path, body });
}
async function proposals() {
  const response = await api('GET', `/api/v1/projects/${fixture.projectId}/proactive-comparison-proposals`);
  assert.equal(response.status, 200);
  return response.data as Array<{ id: string; status: string; version: number; fact: string; usedWorkId: string | null }>;
}

before(async () => {
  await new Promise<void>((resolve) => proxy.listen(Number(origin.port || 80), origin.hostname, resolve));
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  await page.goto(origin.origin);
  const login = await api('POST', '/api/auth/sign-in/email', { email: fixture.email, password: fixture.password });
  assert.equal(login.status, 200);
});
after(async () => {
  await browser?.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
});

test('real project UI presents sourced quiet suggestions, then persists edits, use and dismissal', async () => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks`);
  const cards = page.locator('.ws-proposal');
  await cards.first().waitFor();
  assert.equal(await cards.count(), 2);
  const initial = (await proposals()).filter((item) => item.status === 'proposed');
  assert.equal(initial.length, 2);
  assert.match(await cards.first().locator('.ws-proposal__action').innerText(), /Compare a ToF distance sensor/);
  assert.match(await cards.first().locator('.ws-proposal__source').innerText(), /Second low-light trial/);
  assert.match(await cards.nth(1).locator('.ws-proposal__source').innerText(), /Camera trial failed/);
  assert.equal(await cards.first().locator('.ws-proposal__toggle').getAttribute('aria-expanded'), 'false');
  assert.match(await page.locator('.ws-proposals__intro').innerText(), /has not changed any work or decision/);
  const workRow = await page.locator('#g-open + .ws-list .ws-item').first().boundingBox();
  const resultRow = await page.locator('#g-results + .ws-list .ws-item').nth(1).boundingBox();
  assert.ok(workRow && workRow.y + workRow.height < 900, 'ordinary work remains visible at 1440×900');
  assert.ok(resultRow && resultRow.y + resultRow.height < 900,
    'both ordinary results remain visible below the suggestions at 1440×900');
  await page.screenshot({ path: '/state/proactive-ui-1440.png', fullPage: true });

  await cards.first().locator('.ws-proposal__toggle').focus();
  await page.keyboard.press('Enter');
  assert.equal(await cards.first().locator('.ws-proposal__toggle').getAttribute('aria-expanded'), 'true');
  assert.match(await cards.first().innerText(), /Observed fact[\s\S]*Interpretation[\s\S]*Suggested next step[\s\S]*Sources/);
  const message = cards.first().getByRole('link', { name: 'Could a ToF distance sensor work better than our camera in a dark bedroom?' });
  assert.equal(await message.getAttribute('href'),
    `/projects/${fixture.projectId}/conversations/${fixture.conversationId}#message-${fixture.messageId}`);
  await message.click();
  await page.locator(`#message-${fixture.messageId}`).waitFor();

  const originalPage = page;
  const storageState = await context.storageState();
  for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    const touch = viewport.width < 1440;
    const viewportContext = await browser.newContext({ viewport, storageState, deviceScaleFactor: 1,
      isMobile: viewport.width === 390, hasTouch: touch });
    page = await viewportContext.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const activate = async (control: Locator) => touch ? control.tap() : control.click();
    const viewportCards = page.locator('.ws-proposal');
    try {
      await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks`);
      await viewportCards.first().waitFor();
      await page.screenshot({ path: `/state/proactive-ui-${viewport.width}-collapsed.png`, fullPage: true });
      await activate(viewportCards.first().locator('.ws-proposal__toggle'));
      const workSource = viewportCards.first().getByRole('link', { name: /^Measure ToF response at 5 lux/ });
      assert.equal(await workSource.getAttribute('href'), `/projects/${fixture.projectId}/tasks?open=work:${fixture.workId}`);
      const thoughtSource = viewportCards.first().getByRole('link', { name: /^Test a ToF sensor using the same 5 lux protocol/ });
      assert.equal(await thoughtSource.getAttribute('href'), `/projects/${fixture.projectId}/map/${fixture.sketchId}#thought-${fixture.thoughtId}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'expanded sources fit the viewport');
      for (const source of await viewportCards.first().locator('.ws-proposal__sources li').all()) {
        const bounds = await source.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width,
          'each source label stays within the visible column');
      }
      if (touch) {
        assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
        for (const control of await page.locator('.ws-proposal__sources a, .ws-proposal__sources button, .ws-proposals__jumps button').all()) {
          const bounds = await control.boundingBox();
          assert.ok(bounds && bounds.height >= 44, 'source links and section jumps have 44px touch targets');
        }
      }
      await page.screenshot({ path: `/state/proactive-ui-${viewport.width}-expanded.png`, fullPage: true });
      const jumps = page.getByRole('navigation', { name: 'Project work sections' });
      await activate(jumps.getByRole('button', { name: 'Work 1', exact: true }));
      await page.waitForFunction(() => {
        const bounds = document.getElementById('g-open')?.getBoundingClientRect();
        return !!bounds && bounds.y > 0 && bounds.bottom < innerHeight;
      });
      await activate(jumps.getByRole('button', { name: 'Results 2', exact: true }));
      await page.waitForFunction(() => {
        const bounds = document.getElementById('g-results')?.getBoundingClientRect();
        return !!bounds && bounds.y > 0 && bounds.bottom < innerHeight;
      });
      await activate(workSource);
      await page.getByRole('heading', { name: 'Measure ToF response at 5 lux', exact: true }).waitFor();
      await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks`);
      await activate(viewportCards.first().locator('.ws-proposal__toggle'));
      await activate(viewportCards.first().getByRole('link', { name: /^Test a ToF sensor using the same 5 lux protocol/ }));
      const selected = page.locator(`.sk-node[data-id="${fixture.thoughtId}"], .sk-li-t[data-id="${fixture.thoughtId}"]`).first();
      await selected.waitFor();
      await page.waitForFunction((id) => {
        const node = document.querySelector(`.sk-node[data-id="${id}"], .sk-li-t[data-id="${id}"]`);
        return node?.getAttribute('aria-selected') === 'true' || node?.getAttribute('aria-pressed') === 'true';
      }, fixture.thoughtId);
      const thought = await api('GET', `/api/v1/sketches/${fixture.sketchId}`);
      assert.equal(thought.status, 200);
      assert.ok((thought.data as { thoughts: Array<{ id: string }> }).thoughts.some((item) => item.id === fixture.thoughtId));
    } finally {
      page = originalPage;
      await viewportContext.close();
    }
  }
  await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks`);
  await cards.first().waitFor();
  await cards.first().locator('.ws-proposal__toggle').click();
  await cards.first().getByRole('button', { name: 'Edit', exact: true }).click();
  await cards.first().getByLabel('Interpretation').fill('The camera result suggests testing a distance sensor, but needs a controlled comparison.');
  await cards.first().getByRole('button', { name: 'Save edits' }).click();
  await page.waitForFunction(() => document.querySelector('.ws-proposal')?.textContent?.includes('needs a controlled comparison'));
  await page.reload();
  await cards.first().locator('.ws-proposal__toggle').click();
  assert.match(await cards.first().innerText(), /needs a controlled comparison/);
  let stored = await proposals();
  assert.equal(stored.find((item) => item.id === initial[0]?.id)?.version, 2);

  await cards.first().getByRole('button', { name: 'Use as work' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ws-proposal').length === 1);
  stored = await proposals();
  const used = stored.find((item) => item.id === initial[0]?.id);
  assert.equal(used?.status, 'used');
  assert.ok(used?.usedWorkId);
  const work = await api('GET', `/api/v1/projects/${fixture.projectId}/work?limit=100`);
  assert.equal(work.status, 200);
  assert.ok((work.data as { items: Array<{ id: string }> }).items.some((item) => item.id === used.usedWorkId));

  await cards.first().locator('.ws-proposal__toggle').click();
  await cards.first().getByRole('button', { name: 'Dismiss' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ws-proposal').length === 0);
  await page.reload();
  assert.equal(await cards.count(), 0);
  stored = await proposals();
  assert.equal(stored.find((item) => item.id === initial[1]?.id)?.status, 'dismissed');
  await page.getByLabel('New work').fill('Repeat the sensor test with a manual switch');
  await page.getByRole('button', { name: 'Add work' }).click();
  await page.getByRole('heading', { name: 'Repeat the sensor test with a manual switch' }).waitFor();
  const manual = await api('GET', `/api/v1/projects/${fixture.projectId}/work?limit=100`);
  assert.equal(manual.status, 200);
  assert.ok((manual.data as { items: Array<{ title: string }> }).items.some((item) =>
    item.title === 'Repeat the sensor test with a manual switch'));
  assert.deepEqual(errors, []);
});
