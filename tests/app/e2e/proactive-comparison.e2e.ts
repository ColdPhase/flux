import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

interface Fixture { email: string; password: string; projectId: string; proposalIds: string[];
  conversationId: string; messageId: string }
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
  assert.match(await cards.first().locator('h3').innerText(), /Second low-light trial/);
  assert.match(await cards.nth(1).locator('h3').innerText(), /Camera trial failed/);
  assert.match(await cards.first().innerText(), /Observed fact[\s\S]*Interpretation[\s\S]*Suggested next step[\s\S]*Sources/);
  assert.match(await page.locator('.ws-proposals__intro').innerText(), /has not changed any work or decision/);
  const resultRow = await page.locator('#g-results + .ws-list .ws-item').first().boundingBox();
  assert.ok(resultRow && resultRow.y + resultRow.height < 900,
    'the first ordinary result remains visible below the suggestions at 1440×900');
  await page.screenshot({ path: '/state/proactive-ui-1440.png', fullPage: true });

  const message = cards.first().getByRole('link', { name: /Project message/ });
  assert.equal(await message.getAttribute('href'),
    `/projects/${fixture.projectId}/conversations/${fixture.conversationId}#message-${fixture.messageId}`);
  await message.click();
  await page.locator(`#message-${fixture.messageId}`).waitFor();
  await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks`);
  await cards.first().waitFor();
  await cards.first().getByRole('button', { name: 'Edit', exact: true }).click();
  await cards.first().getByLabel('Interpretation').fill('The camera result suggests testing a distance sensor, but needs a controlled comparison.');
  await cards.first().getByRole('button', { name: 'Save edits' }).click();
  await page.waitForFunction(() => document.querySelector('.ws-proposal')?.textContent?.includes('needs a controlled comparison'));
  await page.reload();
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
