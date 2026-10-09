import assert from 'node:assert/strict';
import { hasMinimumTouchSize } from '../support/touch-target.js';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

interface Fixture { email: string; peerEmail: string; password: string; workspaceId: string; projectId: string; proposalIds: string[];
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
async function assertBackgroundContrast() {
  const checks = await page.evaluate(async () => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    const checks: Array<{ theme: string; part: string; foreground: string; background: string; minimum: number }> = [];
    for (const theme of ['light', 'dark']) {
      root.dataset.theme = theme;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const bg = getComputedStyle(document.querySelector('.app__main')!).backgroundColor;
      for (const part of ['.background-settings__help', '.background-settings__note', '.background-settings__fields label']) {
        const node = document.querySelector(part);
        if (!node) continue;
        checks.push({ theme, part, foreground: getComputedStyle(node).color, background: bg, minimum: 4.5 });
      }
      for (const node of document.querySelectorAll('.background-settings .ui-btn:not(:disabled)')) {
        const style = getComputedStyle(node);
        checks.push({ theme, part: node.textContent ?? 'button', foreground: style.color,
          background: style.backgroundColor === 'rgba(0, 0, 0, 0)' ? bg : style.backgroundColor, minimum: 4.5 });
      }
      for (const node of document.querySelectorAll('.background-settings input:not([type=checkbox]), .background-settings select')) {
        const style = getComputedStyle(node);
        checks.push({ theme, part: `${node.tagName} boundary`, foreground: style.borderTopColor, background: style.backgroundColor, minimum: 3 });
      }
    }
    if (previous === undefined) delete root.dataset.theme; else root.dataset.theme = previous;
    return checks;
  });
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map((value) => {
      const n = Number(value) / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  for (const check of checks) {
    const values = [luminance(check.foreground), luminance(check.background)].sort((a, b) => b - a);
    const ratio = (values[0]! + 0.05) / (values[1]! + 0.05);
    assert.ok(ratio >= check.minimum, `${check.theme} ${check.part}: ${ratio.toFixed(2)}:1 must reach ${check.minimum}:1`);
  }
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
  await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks?view=list`);
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
  assert.ok(workRow && workRow.y + workRow.height < 900, 'ordinary work remains visible at 1440×900');
  // Results have no group in Tasks (#342): they show in their task's details, so there is no jump to them.
  assert.equal(await page.locator('#g-results').count(), 0);
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
      await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks?view=list`);
      await viewportCards.first().waitFor();
      if (viewport.width === 390) {
        for (const title of await viewportCards.locator('.ws-proposal__action').all()) {
          assert.ok(await title.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
            'the compact phone experiment title keeps its 5-lux condition visible');
        }
        for (const fact of await viewportCards.locator('.ws-proposal__fact').all()) {
          assert.ok(await fact.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
            'the compact phone observation keeps its quantitative evidence visible');
        }
      }
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
          assert.ok(bounds && hasMinimumTouchSize(bounds.height) && hasMinimumTouchSize(bounds.width), 'source links and section jumps have 44×44px touch targets');
        }
      }
      await page.screenshot({ path: `/state/proactive-ui-${viewport.width}-expanded.png`, fullPage: true });
      const jumps = page.getByRole('navigation', { name: 'Project work sections' });
      await activate(jumps.getByRole('button', { name: 'Work 1', exact: true }));
      await page.waitForFunction(() => {
        const bounds = document.getElementById('g-open')?.getBoundingClientRect();
        return !!bounds && bounds.y > 0 && bounds.bottom < innerHeight;
      });
      await activate(workSource);
      // The board card carries the same title; the source must open that exact work's Details.
      await page.locator(`.wd[data-detail-kind="work"][data-detail-id="${fixture.workId}"]`)
        .getByRole('heading', { name: 'Measure ToF response at 5 lux', exact: true }).waitFor();
      await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks?view=list`);
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
      await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks?view=list`);
      await activate(viewportCards.first().locator('.ws-proposal__toggle'));
      const edit = viewportCards.first().getByRole('button', { name: 'Edit', exact: true });
      await edit.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/state/proactive-ui-${viewport.width}-actions.png`, fullPage: true });
      await activate(edit);
      const interpretation = viewportCards.first().getByLabel('Interpretation');
      const originalInterpretation = await interpretation.inputValue();
      await activate(interpretation);
      if (touch) assert.ok(await interpretation.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize) >= 16),
        'touch editing uses readable 16px input text');
      await interpretation.fill('An unsaved human interpretation.');
      await page.screenshot({ path: `/state/proactive-ui-${viewport.width}-editing.png`, fullPage: true });
      await activate(viewportCards.first().getByRole('button', { name: 'Cancel', exact: true }));
      assert.ok((await viewportCards.first().innerText()).includes(originalInterpretation));
      assert.equal((await proposals()).find((item) => item.id === initial[0]?.id)?.version, 1,
        'cancelling a draft edit does not change the persisted proposal');
    } finally {
      page = originalPage;
      await viewportContext.close();
    }
  }
  await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks?view=list`);
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
  await page.getByLabel('New task').fill('Repeat the sensor test with a manual switch');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByRole('heading', { name: 'Repeat the sensor test with a manual switch' }).waitFor();
  const manual = await api('GET', `/api/v1/projects/${fixture.projectId}/work?limit=100`);
  assert.equal(manual.status, 200);
  assert.ok((manual.data as { items: Array<{ title: string }> }).items.some((item) =>
    item.title === 'Repeat the sensor test with a manual switch'));
  assert.deepEqual(errors, []);
});

test('owner-only background setup persists consent, clears keys and preserves another person without a connection', async () => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: /account and sign out/ }).click();
  await page.getByRole('link', { name: 'Your background suggestions', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Your background suggestions', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Account', exact: true }).count(), 0);
  assert.match(await page.getByRole('note').innerText(), /not available/);
  assert.equal((await api('GET', '/api/v1/background-compute-connections/current')).data, null);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/background-compute-connections') writes++;
  });
  // F-020: no provider is preselected; the owner chooses one and its model.
  assert.equal(await page.getByLabel('Provider', { exact: true }).inputValue(), '');
  await page.getByLabel('Provider', { exact: true }).selectOption({ label: 'Anthropic' });
  await page.getByLabel('Model', { exact: true }).fill('claude-sonnet-5');
  await page.getByText('Flux price table, checked 2026-10-02', { exact: false }).waitFor();
  await page.getByLabel('Background API key', { exact: true }).fill('sk-ant-fixture-background-setup-key-ABCD');
  await page.getByLabel('Provider organization', { exact: true }).fill('Fixture Sensor Research');
  await page.getByLabel('Provider workspace', { exact: true }).fill('Fixture Only');
  await page.getByLabel('Maximum requests a day').fill('2');
  await page.getByLabel('30-day local allowance (USD)').fill('0.25');
  await page.getByLabel('Per-request local allowance (USD)').fill('0.05');
  await assertBackgroundContrast();
  await page.getByRole('button', { name: 'Save connection and consent', exact: true }).click();
  assert.equal(writes, 0, 'missing consent cannot send a credential request');
  for (const check of await page.locator('.background-settings__check input').all()) await check.check();
  await page.getByRole('button', { name: 'Save connection and consent', exact: true }).click();
  // F-020: connections are listed; the first one is used for background suggestions.
  await page.getByRole('heading', { name: 'Your AI connections', exact: true }).waitFor();
  assert.equal(writes, 1);
  assert.equal(await page.locator('input[name="apiKey"]').count(), 0, 'saved keys leave no editable input');
  await page.waitForFunction(() => document.querySelector('.background-settings__saved') === document.activeElement);
  assert.equal(await page.locator('.background-settings__saved').evaluate((element) => element === document.activeElement), true,
    'save completion restores keyboard focus to its status');
  const first = (await api('GET', '/api/v1/background-compute-connections/current')).data as {
    id: string; name: string; ownerUserId: string; keyLastFour: string; periodBudgetCents: number; maxRunsPerDay: number; perRunCents: number;
  };
  assert.equal(first.keyLastFour, 'ABCD'); assert.equal(first.periodBudgetCents, 25);
  assert.equal(first.maxRunsPerDay, 2); assert.equal(first.perRunCents, 5);
  assert.ok(!JSON.stringify(first).includes('sk-ant-'));
  assert.ok(!await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes('sk-ant-')),
    'credentials never enter browser storage');
  await page.reload();
  assert.match(await page.locator('[aria-labelledby="background-current"] .background-settings__metadata').innerText(), /Fixture Sensor Research[\s\S]*ABCD[\s\S]*\$0.25/);
  await page.locator('.background-settings__help').first().click();
  await page.screenshot({ path: '/state/background-setup-1440-saved.png', fullPage: true });
  await assertBackgroundContrast();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.background-settings .ui-btn--secondary')!).color === getComputedStyle(document.body).color);
  await page.screenshot({ path: '/state/background-setup-1440-saved-dark.png', fullPage: true });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.background-settings .ui-btn--secondary')!).color === getComputedStyle(document.body).color);

  const ownerPage = page;
  const peerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await peerContext.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(origin.origin);
    assert.equal((await api('POST', '/api/auth/sign-in/email', { email: fixture.peerEmail, password: fixture.password })).status, 200);
    await page.goto(`${origin.origin}/settings/background-compute`);
    await page.getByRole('heading', { name: 'Connect your background source', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Your AI connections', exact: true }).count(), 0);
    assert.ok(!(await page.locator('.background-settings').innerText()).includes('Fixture Sensor Research'));
    assert.equal((await api('GET', '/api/v1/background-compute-connections/current')).data, null);
    assert.equal((await api('DELETE', `/api/v1/background-compute-connections/${first.id}`)).status, 404);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('.background-settings__help').first().tap();
    await page.screenshot({ path: '/state/background-setup-390-empty.png', fullPage: true });
  } finally { page = ownerPage; await peerContext.close(); }
  assert.equal(((await api('GET', '/api/v1/background-compute-connections/current')).data as { id: string }).id, first.id);

  for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }]) {
  const touchContext = await browser.newContext({ viewport, isMobile: viewport.width === 390,
    hasTouch: true, storageState: await context.storageState() });
  page = await touchContext.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin.origin}/settings/background-compute`);
    await page.getByRole('heading', { name: 'Your AI connections', exact: true }).waitFor();
    await page.locator('.background-settings__help').first().tap();
    await page.screenshot({ path: `/state/background-setup-${viewport.width}-saved.png`, fullPage: true });
    await page.getByRole('button', { name: 'Add a connection', exact: true }).tap();
    const key = page.getByLabel('Background API key', { exact: true });
    const cancel = page.getByRole('button', { name: 'Cancel adding', exact: true });
    const openingCancelBounds = await cancel.boundingBox();
    assert.ok(openingCancelBounds && openingCancelBounds.y >= 0 &&
      openingCancelBounds.y + openingCancelBounds.height <= viewport.height,
    'cancelling is visible beside the opening fields');
    assert.equal(await key.inputValue(), '');
    assert.ok(await key.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize) >= 16));
    for (const check of await page.locator('.background-settings__check').all()) {
      const bounds = await check.boundingBox();
      assert.ok(bounds && hasMinimumTouchSize(bounds.height) && hasMinimumTouchSize(bounds.width));
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/state/background-setup-${viewport.width}-add.png`, fullPage: true });
    await page.locator('input[name="providerBilling"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/state/background-setup-${viewport.width}-consent.png`, fullPage: true });
    await key.fill('sk-ant-fixture-unsaved-touch-key-ABCD');
    await page.getByRole('heading', { name: 'Add a connection', exact: true }).scrollIntoViewIfNeeded();
    await cancel.tap();
    // Focus returns to the button that opened the form.
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Add a connection');
    assert.equal(await key.count(), 0);
    assert.equal(((await api('GET', '/api/v1/background-compute-connections/current')).data as { id: string }).id, first.id);
  } finally { page = ownerPage; await touchContext.close(); }
  }

  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.getByRole('button', { name: 'Add a connection', exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: 'Cancel', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/state/background-setup-1440-zoom2.png', fullPage: true });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.getByRole('button', { name: 'Add a connection', exact: true }).click();
  for (const check of await page.locator('.background-settings__check input').all()) assert.equal(await check.isChecked(), false,
    'another connection requires fresh consent, and is not chosen for background use by default');
  await page.getByLabel('Provider', { exact: true }).selectOption({ label: 'Anthropic' });
  await page.getByLabel('Model', { exact: true }).fill('claude-sonnet-5');
  await page.getByLabel('Provider organization', { exact: true }).fill('Fixture Sensor Research');
  await page.getByLabel('Provider workspace', { exact: true }).fill('Fixture Only');
  await page.getByLabel('Background API key', { exact: true }).fill('invalid-fixture-key');
  for (const check of await page.locator('.background-settings__check input').all()) await check.check();
  // Native minimum-length validation would stop this fixture; a syntactically long invalid key reaches server validation.
  await page.getByLabel('Background API key', { exact: true }).fill('invalid-fixture-key-with-enough-characters');
  await page.getByRole('button', { name: 'Save connection and consent', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.waitForFunction(() => document.querySelector('.background-settings__error') === document.activeElement);
  await page.screenshot({ path: '/state/background-setup-1440-error.png', fullPage: true });
  assert.equal(await page.getByLabel('Background API key', { exact: true }).inputValue(), '', 'failed requests also clear the key');
  assert.equal(((await api('GET', '/api/v1/background-compute-connections/current')).data as { id: string }).id, first.id,
    'a failed addition keeps the earlier connection in use');
  await page.getByLabel('Background API key', { exact: true }).fill('sk-ant-fixture-background-setup-key-WXYZ');
  await page.getByRole('button', { name: 'Save connection and consent', exact: true }).click();
  await page.getByRole('heading', { name: 'Add a connection', exact: true }).waitFor({ state: 'hidden' });
  const replacement = (await api('GET', '/api/v1/background-compute-connections/current')).data as { id: string; keyLastFour: string; name: string };
  assert.notEqual(replacement.id, first.id, 'the chosen new connection is now used'); assert.equal(replacement.keyLastFour, 'WXYZ');
  // Each connection's button names it and its key (F-020): two connections can share a provider and model.
  await page.getByRole('button', { name: `Disconnect ${replacement.name}, key ending ${replacement.keyLastFour}`, exact: true }).click();
  await page.locator('.background-settings__saved', { hasText: 'none takes over by itself' }).waitFor();
  assert.equal((await api('GET', '/api/v1/background-compute-connections/current')).data, null,
    'the remaining connection does not take over');
  await page.getByRole('button', { name: `Disconnect ${first.name}, key ending ${first.keyLastFour}`, exact: true }).click();
  await page.getByRole('heading', { name: 'Connect your background source', exact: true }).waitFor();
  assert.equal((await api('GET', '/api/v1/background-compute-connections/current')).data, null);
  await page.reload();
  assert.equal((await api('GET', '/api/v1/background-compute-connections/current')).data, null);
  await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks?view=list`);
  await page.getByLabel('New task').fill('Manual comparison without a background key');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await page.getByRole('heading', { name: 'Manual comparison without a background key', exact: true }).waitFor();
  const manual = await api('GET', `/api/v1/projects/${fixture.projectId}/work?limit=100`);
  assert.ok((manual.data as { items: Array<{ title: string }> }).items.some((item) => item.title === 'Manual comparison without a background key'));
  assert.deepEqual(errors, []);
});

test('an owner creates a personal project agent and a paused rule, then pauses, revokes and renews an earlier rule without AI', async () => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = await api('POST', `/api/v1/workspaces/${fixture.workspaceId}/projects`,
    { name: 'Independent sensor benchmark', visibility: 'restricted' });
  assert.equal(project.status, 201);
  const projectId = (project.data as { id: string }).id;
  await page.goto(`${origin.origin}/settings/background-compute`);
  assert.equal(await page.getByRole('button', { name: 'Details', exact: true }).count(), 0,
    'private settings do not offer unrelated place details');
  await page.keyboard.press(']');
  assert.equal(await page.getByRole('heading', { name: 'Details', exact: true }).count(), 0);
  await page.getByLabel('Project', { exact: true }).selectOption(projectId);
  await page.getByText('Create another personal agent', { exact: true }).click();
  await page.getByLabel('New personal agent name').fill('My opt-in comparison helper');
  await page.getByRole('button', { name: 'Create personal agent', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select:has(option:checked)') &&
    [...document.querySelectorAll('select option:checked')].some((option) => option.textContent === 'My opt-in comparison helper'));
  const agentId = await page.getByLabel('Your personal agent', { exact: true }).inputValue();
  assert.ok(agentId);
  await page.getByRole('button', { name: 'Grant project contributor access', exact: true }).click();
  await page.getByRole('button', { name: 'Grant project contributor access', exact: true }).waitFor({ state: 'hidden' });
  await page.getByLabel('Rule maximum requests a day').fill('1');
  await page.getByLabel('Rule 30-day allowance (USD)').fill('0.15');
  await page.getByLabel('Rule per-request allowance (USD)').fill('0.05');
  await page.getByLabel('Rule maximum requests a day').focus();
  await page.screenshot({ path: '/state/background-rules-1440-create.png', fullPage: true });
  await page.locator('input[name="ruleConsent"]').check();
  await page.getByRole('button', { name: 'Create paused rule', exact: true }).click();
  await page.getByRole('button', { name: 'Enable unavailable', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Enable unavailable', exact: true }).isDisabled(), true);
  const rules = await api('GET', `/api/v1/projects/${projectId}/proactive-comparison-rules`);
  assert.equal(rules.status, 200);
  const [rule] = rules.data as Array<{ id: string; agentId: string; status: string; maxRunsPerDay: number; periodBudgetCents: number }>;
  assert.equal(rule?.status, 'paused'); assert.equal(rule?.agentId, agentId);
  assert.equal(rule?.maxRunsPerDay, 1); assert.equal(rule?.periodBudgetCents, 15);
  await page.reload();
  await page.getByLabel('Project', { exact: true }).selectOption(projectId);
  await page.getByRole('button', { name: 'Enable unavailable', exact: true }).waitFor();
  await page.locator('.background-settings__metadata').last().click();
  await page.screenshot({ path: '/state/background-rules-1440-paused.png', fullPage: true });
  const desktopPage = page;
  for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }]) {
    const touchContext = await browser.newContext({ viewport, isMobile: viewport.width === 390, hasTouch: true,
      storageState: await context.storageState() });
    page = await touchContext.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(`${origin.origin}/settings/background-compute?project=${projectId}`);
      await page.getByRole('button', { name: 'Revoke rule', exact: true }).waitFor();
      await page.locator('.background-settings__metadata').last().scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      for (const control of await page.locator('.background-settings__actions .ui-btn').all()) {
        const bounds = await control.boundingBox();
        assert.ok(bounds && hasMinimumTouchSize(bounds.height) && hasMinimumTouchSize(bounds.width));
      }
      await page.screenshot({ path: `/state/background-rules-${viewport.width}-paused.png`, fullPage: true });
    } finally { page = desktopPage; await touchContext.close(); }
  }

  await page.getByLabel('Project', { exact: true }).selectOption(fixture.projectId);
  await page.getByRole('button', { name: 'Pause rule', exact: true }).click();
  await page.getByRole('button', { name: 'Enable unavailable', exact: true }).waitFor();
  let earlier = (await api('GET', `/api/v1/projects/${fixture.projectId}/proactive-comparison-rules`)).data as Array<{ id: string; version: number; status: string }>;
  assert.equal(earlier[0]?.status, 'paused');
  const pausedVersion = earlier[0]!.version;
  await page.getByRole('button', { name: 'Revoke rule', exact: true }).click();
  await page.getByText('Your earlier rule is permanently revoked. A fresh rule needs your new scope and allowance confirmation and starts paused.', { exact: true }).waitFor();
  earlier = (await api('GET', `/api/v1/projects/${fixture.projectId}/proactive-comparison-rules`)).data as typeof earlier;
  assert.equal(earlier[0]?.status, 'revoked'); assert.equal(earlier[0]?.version, pausedVersion + 1);
  const revoked = earlier[0]!;
  assert.equal(await page.locator('input[name="ruleConsent"]').isChecked(), false, 'renewal needs fresh scope consent');
  await page.getByLabel('Your personal agent', { exact: true }).selectOption(agentId);
  await page.getByRole('button', { name: 'Grant project contributor access', exact: true }).click();
  await page.getByRole('button', { name: 'Grant project contributor access', exact: true }).waitFor({ state: 'hidden' });
  await page.locator('input[name="ruleConsent"]').check();
  await page.getByRole('button', { name: 'Create paused rule', exact: true }).click();
  await page.getByRole('button', { name: 'Enable unavailable', exact: true }).waitFor();
  const renewed = (await api('GET', `/api/v1/projects/${fixture.projectId}/proactive-comparison-rules`)).data as typeof earlier;
  assert.deepEqual(renewed.find((rule) => rule.id === revoked.id), revoked);
  const fresh = renewed.find((rule) => rule.id !== revoked.id)!;
  assert.ok(fresh); assert.equal(fresh.status, 'paused'); assert.equal(fresh.version, 1);
  await page.reload();
  await page.getByLabel('Project', { exact: true }).selectOption(fixture.projectId);
  await page.getByRole('button', { name: 'Enable unavailable', exact: true }).waitFor();
  assert.deepEqual((await api('GET', `/api/v1/projects/${fixture.projectId}/proactive-comparison-rules`)).data, renewed);
  assert.deepEqual(errors, []);
});
