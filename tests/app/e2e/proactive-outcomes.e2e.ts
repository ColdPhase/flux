import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import type { BackgroundComputeUsage, Page as OutcomePage, ProactiveComparisonOutcome } from '@flux/contracts';

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

test('all pages render quiet comparisons and insufficient evidence with current checked references on desktop, phone and tablet', async () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 1024, height: 768 }]) {
    const touch = viewport.width < 1440;
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width === 390, hasTouch: touch });
    const page = await context.newPage(); const errors: string[] = []; const offsets: number[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { const url = new URL(request.url()); if (url.pathname.endsWith('/proactive-comparison-outcomes')) offsets.push(Number(url.searchParams.get('offset'))); });
    try {
      await login(page); await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks`);
      const comparison = page.getByRole('article', { name: 'Comparison suggestion for Bedside gesture lamp' });
      const insufficient = page.getByRole('article', { name: 'Insufficient evidence for Bedside gesture lamp' });
      await comparison.waitFor(); await insufficient.waitFor();
      assert.ok(offsets.includes(100), 'the older open outcomes load from page 2 rather than disappearing');
      assert.equal(await page.locator('.ws-proposal').count(), 2);
      // A saved task filter can hide an outcome link's destination. These links
      // must restore the whole project before landing on real persisted work/results.
      const views = page.getByRole('navigation', { name: 'Task views' });
      const jumps = page.getByRole('navigation', { name: 'Project work sections' });
      for (const [label, target] of [['Results', 'g-results'], ['Work', 'g-open']] as const) {
        await views.getByRole('button', { name: /^Open / }).click();
        await views.getByRole('checkbox', { name: 'Only mine', exact: true }).check();
        assert.equal(await page.locator(`#${target}`).count(), 0, 'the destination is hidden by the saved view');
        const jump = jumps.getByRole('button', { name: new RegExp(`^${label} `) });
        if (touch) await jump.tap(); else await jump.click();
        await page.locator(`#${target}`).waitFor();
        assert.equal(await views.getByRole('button', { name: 'All', exact: true }).getAttribute('aria-pressed'), 'true');
        assert.equal(await views.getByRole('checkbox', { name: 'Only mine', exact: true }).isChecked(), false);
        await page.waitForFunction((id) => {
          const bounds = document.getElementById(id)?.getBoundingClientRect();
          return !!bounds && bounds.y > 0 && bounds.bottom < innerHeight;
        }, target);
      }
      await page.locator('.ws-tasks').evaluate((node) => { node.parentElement!.scrollTop = 0; });
      await page.waitForFunction(() => {
        const buttons = [...document.querySelectorAll('nav[aria-label="Task views"] button')];
        return buttons.length > 0 && buttons.every((node) => node.getAnimations()
          .every((animation) => animation.playState !== 'running'));
      });
      if (touch && viewport.width === 390) assert.ok(await insufficient.locator('.ws-proposal__source').evaluate((node) => node.getBoundingClientRect().height < 50), 'a long insufficient reason stays compact until inspected');
      await page.screenshot({ path: `/state/comparison-outcomes-${viewport.width}-collapsed.png`, fullPage: true });
      const toggle = comparison.locator('.ws-proposal__toggle');
      if (touch) await toggle.tap(); else { await toggle.focus(); await page.keyboard.press('Enter'); }
      assert.match(await comparison.innerText(), /Sources cited[\s\S]*Checked sources/);
      const evidence = comparison.locator('.ws-proposal__evidence');
      await evidence.locator('summary').click();
      assert.match(await evidence.innerText(), /Excerpt inspected[\s\S]*full source/);
      assert.match(await evidence.innerText(), /1 checked source is no longer available to you/);
      assert.ok(!(await evidence.innerText()).includes('Repeat the low-light gesture trial'), 'a source removed from the project exposes no old title');
      assert.ok(await evidence.locator('li').count() > await comparison.locator('.ws-proposal__sources').first().locator('li').count(), 'the full inspected set stays separate from the citation subset');
      assert.ok(!(await comparison.innerText()).includes('Earlier suggestion'), 'the recorded vector is not described as legacy');
      await insufficient.locator('.ws-proposal__toggle').click();
      await insufficient.locator('summary').click();
      assert.match(await insufficient.innerText(), /no matching ToF measurement/);
      assert.equal(await insufficient.locator('.ws-proposal__body > p').innerText(), ('The camera trial has no matching ToF measurement under the same lighting. ' +
        'Record a comparable sensor trial before choosing which approach to continue. '.repeat(7)).trim(), 'inspection retains the complete reason');
      assert.equal(await insufficient.getByRole('button', { name: 'Use as work', exact: true }).count(), 0);
      assert.equal(await insufficient.getByRole('button', { name: 'Edit', exact: true }).count(), 0);
      assert.equal(await insufficient.getByRole('button', { name: 'Dismiss', exact: true }).count(), 1);
      assert.ok(!(await page.locator('.ws-proposals').innerText()).includes('Lamp research group'), 'private payer details stay out of project outcomes');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the expanded outcomes fit the viewport');
      for (const node of await page.locator('.ws-proposal__evidence a, .ws-proposal__evidence button, .ws-proposal__evidence summary').all()) {
        const bounds = await node.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, 'checked references stay inside the column');
        if (touch) assert.ok(bounds.height >= 44, 'checked-source controls have 44px touch height');
      }
      await comparison.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/state/comparison-outcomes-${viewport.width}-checked.png`, fullPage: true });
      await insufficient.getByRole('button', { name: 'Dismiss', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/state/comparison-outcomes-${viewport.width}-insufficient-footer.png`, fullPage: true });
      if (!touch) {
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        await page.waitForFunction(() => document.querySelector('.side__jump')!.getAnimations().every((animation) => animation.playState !== 'running'));
        const colors = await page.locator('.side__jump').evaluate((node) => {
          const style = getComputedStyle(node);
          return { foreground: style.color, background: style.backgroundColor };
        });
        const luminance = (color: string) => {
          const channels = color.match(/[\d.]+/g)!.slice(0, 3).map((value) => { const n = Number(value) / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; });
          return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
        };
        const [a, b] = [luminance(colors.foreground), luminance(colors.background)].sort((x, y) => y - x);
        const contrast = (a! + 0.05) / (b! + 0.05);
        assert.ok(contrast >= 4.5, `settled dark search text contrast is ${contrast.toFixed(2)}:1`);
        await comparison.scrollIntoViewIfNeeded();
        await page.screenshot({ path: '/state/comparison-outcomes-1440-dark.png', fullPage: true });
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'light';
          for (const token of ['--fs-xs', '--fs-sm', '--fs-md', '--fs-base', '--fs-lg', '--fs-xl', '--fs-2xl']) {
            const size = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token));
            if (Number.isFinite(size)) document.documentElement.style.setProperty(token, `${size * 1.25}px`);
          }
        });
        await page.waitForFunction(() => document.querySelector('.side__jump')!.getAnimations()
          .every((animation) => animation.playState !== 'running'));
        const lightColors = await page.locator('.side__jump').evaluate((node) => {
          const style = getComputedStyle(node);
          return { foreground: style.color, background: style.backgroundColor };
        });
        const [lightA, lightB] = [luminance(lightColors.foreground), luminance(lightColors.background)].sort((x, y) => y - x);
        const lightContrast = (lightA! + 0.05) / (lightB! + 0.05);
        assert.ok(lightContrast >= 4.5, `settled enlarged-text light search contrast is ${lightContrast.toFixed(2)}:1`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: '/state/comparison-outcomes-1440-text125.png', fullPage: true });
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('a project viewer can inspect outcomes while owner accounting and controls remain private', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await login(page, fixture.viewerEmail); await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks`);
    const insufficient = page.getByRole('article', { name: 'Insufficient evidence for Bedside gesture lamp' });
    await insufficient.waitFor(); await insufficient.locator('.ws-proposal__toggle').tap();
    assert.equal(await insufficient.getByRole('button', { name: 'Dismiss', exact: true }).count(), 0);
    const foreign = await api(page, 'GET', `/api/v1/background-compute-usage?ownerId=${fixture.ownerId}`);
    assert.equal(foreign.status, 200); assert.deepEqual((foreign.data as BackgroundComputeUsage).candidates, []);
    await page.goto(`${origin.origin}/settings/background-compute`);
    const usage = page.locator('.background-usage'); await usage.waitFor();
    assert.match(await usage.innerText(), /0 requests[\s\S]*\$0.00/);
    assert.ok(!(await page.locator('.background-settings').innerText()).includes('Lamp research group'));
    await usage.locator('summary').tap(); assert.match(await usage.innerText(), /No background requests have been recorded for you/);
    await usage.scrollIntoViewIfNeeded(); await page.screenshot({ path: '/state/comparison-usage-390-viewer.png', fullPage: true });
  } finally { await context.close(); }
});

test('owner usage distinguishes known, uncertain and no-cost requests and survives disconnect; insufficient dismissal creates no work', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await context.newPage();
  try {
    await login(page);
    for (const width of [1440, 390, 1024]) {
      const usageContext = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : width === 1024 ? 768 : 900 },
        storageState: await context.storageState(), deviceScaleFactor: 1, isMobile: width === 390, hasTouch: width < 1440 });
      const usagePage = await usageContext.newPage();
      try {
      await usagePage.goto(`${origin.origin}/settings/background-compute`);
      const usage = usagePage.locator('.background-usage'); await usage.waitFor();
      assert.match(await usage.innerText(), /3 \/ 3 requests[\s\S]*\$0.15 \/ \$0.50[\s\S]*\$0.02[\s\S]*\$0.05[\s\S]*\$0.00 reserved/);
      await usage.getByRole('button', { name: 'Refresh usage', exact: true }).scrollIntoViewIfNeeded();
      await usagePage.screenshot({ path: `/state/comparison-usage-${width}-summary.png`, fullPage: true });
      if (width < 1440) {
        await usage.locator('summary').tap();
        for (const control of [usage.locator('summary'), usage.getByRole('button', { name: 'Refresh usage', exact: true })]) {
          assert.ok((await control.boundingBox())!.height >= 44, 'owner usage controls have 44px touch height');
        }
      } else { await usage.locator('summary').focus(); await usagePage.keyboard.press('Enter'); }
      assert.match(await usage.innerText(), /Did not run[\s\S]*No paid request · \$0.00 usage[\s\S]*Charge uncertain[\s\S]*Up to \$0.05 possible charge/);
      assert.match(await usage.innerText(), /Completed[\s\S]*earlier reservation · usage not recorded/);
      const ownUsage = (await api(usagePage, 'GET', '/api/v1/background-compute-usage')).data as BackgroundComputeUsage;
      const stopped = ownUsage.candidates.find((candidate) => candidate.status === 'not_run');
      assert.ok(stopped);
      const destination = usage.getByRole('link', { name: `View triggering result for request ${stopped.id}`, exact: true });
      assert.ok((await destination.locator('..').innerText()).includes(`Request ${stopped.id.slice(0, 8)}`));
      if (width < 1440) assert.ok((await destination.boundingBox())!.height >= 44, 'request destination has 44px touch height');
      assert.ok(!(await usage.innerText()).includes('sk-ant-'));
      await usage.scrollIntoViewIfNeeded(); await usagePage.screenshot({ path: `/state/comparison-usage-${width}-owner.png`, fullPage: true });
      await usage.locator('li').nth(4).scrollIntoViewIfNeeded();
      await usagePage.screenshot({ path: `/state/comparison-usage-${width}-history.png`, fullPage: true });
      assert.ok(await usagePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width < 1440) await destination.tap(); else { await destination.focus(); await usagePage.keyboard.press('Enter'); }
      await usagePage.getByRole('heading', { name: 'Request without available key', exact: true }).waitFor();
      assert.ok(usagePage.url().includes(`/projects/${fixture.projectId}/tasks`), 'history opens the actual triggering result in its project');
      } finally { await usageContext.close(); }
    }
    await page.goto(`${origin.origin}/settings/background-compute`);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByRole('heading', { name: 'Connect your background source', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh usage', exact: true }).click();
    const accounting = (await api(page, 'GET', '/api/v1/background-compute-usage')).data as BackgroundComputeUsage;
    assert.equal(accounting.currentLimits, null); assert.equal(accounting.conservativeCountedCents, 15);
    assert.match(await page.locator('.background-usage').innerText(), /3 requests[\s\S]*\$0.15/);
    await page.goto(`${origin.origin}/projects/${fixture.projectId}/tasks`);
    const insufficient = page.getByRole('article', { name: 'Insufficient evidence for Bedside gesture lamp' }); await insufficient.waitFor();
    await insufficient.locator('.ws-proposal__toggle').focus(); await page.keyboard.press('Enter');
    await insufficient.getByRole('button', { name: 'Dismiss', exact: true }).focus(); await page.keyboard.press('Enter');
    await insufficient.waitFor({ state: 'hidden' });
    const page2 = (await api(page, 'GET', `/api/v1/projects/${fixture.projectId}/proactive-comparison-outcomes?limit=100&offset=100`)).data as OutcomePage<ProactiveComparisonOutcome>;
    const dismissed = page2.items.find((item) => item.kind === 'insufficient_evidence' && item.id === fixture.insufficientId);
    assert.ok(dismissed?.kind === 'insufficient_evidence' && dismissed.status === 'dismissed' && dismissed.version === 2);
    const work = await api(page, 'GET', `/api/v1/projects/${fixture.projectId}/work?limit=100`);
    assert.equal((work.data as { items: unknown[] }).items.length, 1, 'insufficient evidence never creates work');
    assert.equal(((await api(page, 'GET', '/api/v1/background-compute-usage')).data as BackgroundComputeUsage).startedRequestsToday, 3, 'inspect and dismiss start no paid request');
    // A local accounting reference is not a grant to reopen its project source.
    assert.equal((await api(page, 'POST', `/api/v1/projects/${fixture.projectId}/grants`,
      { principal: { kind: 'human', id: fixture.ownerId }, role: 'denied' })).status, 201);
    await page.goto(`${origin.origin}/settings/background-compute`);
    const privateUsage = page.locator('.background-usage'); await privateUsage.waitFor();
    assert.ok(!(await privateUsage.innerText()).includes('Bedside gesture lamp'));
    await privateUsage.locator('summary').click();
    const ownStopped = accounting.candidates.find((candidate) => candidate.status === 'not_run'); assert.ok(ownStopped);
    const deniedSource = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${fixture.projectId}`);
    await privateUsage.getByRole('link', { name: `View triggering result for request ${ownStopped.id}`, exact: true }).click();
    assert.equal((await deniedSource).status(), 404);
    assert.ok(!(await page.locator('body').innerText()).includes('Request without available key'));
    const retained = (await api(page, 'GET', '/api/v1/background-compute-usage')).data as BackgroundComputeUsage;
    assert.equal(retained.conservativeCountedCents, 15); assert.equal(retained.startedRequestsToday, 3);
  } finally { await context.close(); }
});
