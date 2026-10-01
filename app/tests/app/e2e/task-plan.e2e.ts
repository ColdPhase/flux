import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Material, WorkItem } from '@flux/contracts';
import { addMember, expectStatus, grant, password, person, project, workspace, type Person } from '../support/people.js';

// A planned task's criteria, prerequisites and plan revision in the real task details (#152), including the unmet-prerequisite
// refusal, keyboard operation and a phone-width read-only viewer. It does not certify an MCP client or model-driven planning.
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const origin = new URL(process.env.FLUX_PUBLIC_ORIGIN!);
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80, method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(response);
  });
  forward.on('error', () => response.destroy());
  request.pipe(forward);
});
proxy.on('upgrade', (request, socket, head) => {
  const target = net.connect(Number(upstream.port || 80), upstream.hostname, () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    target.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) target.write(head);
    target.pipe(socket); socket.pipe(target);
  });
  target.on('error', () => { target.destroy(); socket.destroy(); });
  socket.on('error', () => { target.destroy(); socket.destroy(); });
});

let browser: Browser;
const contexts: BrowserContext[] = [];
before(async () => {
  await new Promise<void>((resolve) => proxy.listen(Number(origin.port || 80), origin.hostname, resolve));
  browser = await chromium.launch();
});
after(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
});

async function signedIn(who: Person, width: number, height = 900) {
  const context = await browser.newContext({ baseURL: origin.origin, viewport: { width, height } });
  contexts.push(context);
  const signed = await context.request.post('/api/auth/sign-in/email', { data: { email: who.email, password }, headers: { origin: origin.origin } });
  assert.equal(signed.status(), 200, await signed.text());
  return context;
}
const heading = (page: Page) => page.locator('.details.wd .details__title');

test('a planned task shows its criteria, prerequisite states and plan revision; unmet prerequisites refuse a start with words and keyboard works', { timeout: 120_000 }, async () => {
  const [owner, reader] = await Promise.all(['Casey Planner', 'Lee Reader'].map(person));
  const ws = await workspace(owner, 'Planned work');
  await addMember(owner, ws.id, reader, 'member');
  const place = await project(owner, ws.id, 'Low-light trial', 'restricted');
  await grant(owner, place.id, reader, 'viewer');
  const api = `/api/v1/projects/${place.id}/work`;
  const create = async (body: Record<string, unknown>) => expectStatus(await owner.browser.request('POST', api, { body }), 201) as WorkItem;
  const plan = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Measurement plan', body: 'Calibrate, then measure at 5 lux.' } }), 201) as Material;
  const calibrated = await create({ title: 'Calibrate the sensor', status: 'done' });
  const ordered = await create({ title: 'Order the replacement lens', outcome: 'A lens that fits the lamp head' });
  const planned = await create({ title: 'Measure gestures at 5 lux', outcome: 'A table of detections per light level',
    criteria: ['At least 20 gestures per light level', 'The room is dark enough that no screen is visible and the setup is photographed from the side for the record', 'Raw counts are attached'],
    dependencyIds: [calibrated.id, ordered.id], planIntent: { materialId: plan.materialId, version: plan.version, intentKey: 'measure-low-light' } });
  const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
  const errors: string[] = [];

  const context = await signedIn(owner, 1280);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/projects/${place.id}/tasks`);
  const row = page.getByRole('button', { name: /Measure gestures at 5 lux/ });
  await row.waitFor();
  assert.match(await row.innerText(), /waits for 1 task/, 'the list says it is waiting without opening it');
  await row.click();
  await heading(page).filter({ hasText: 'Measure gestures at 5 lux' }).waitFor();
  const panel = page.locator('.details.wd');
  const criteria = panel.getByRole('region', { name: 'Done when' });
  assert.deepEqual(await criteria.locator('li').allInnerTexts(), planned.criteria);
  assert.match(await criteria.innerText(), /Flux does not check them off/);
  const waits = panel.getByRole('region', { name: 'Waits for' });
  assert.match(await waits.getByRole('status').innerText(), /Waiting on 1 of 2 prerequisites\. It can start when every one is done/);
  assert.deepEqual((await waits.getByRole('button').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim()).sort(),
    ['Calibrate the sensor Done', 'Order the replacement lens Open · waiting']);
  const intent = panel.locator('.wd-plan');
  assert.match(await intent.innerText(), /plan revision 1 as measure-low-light/);
  assert.equal(await intent.getByRole('link').getAttribute('href'), `/materials/${plan.materialId}/versions/${plan.version}`);
  if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'task-plan-desktop.png'), fullPage: true }); }

  // A start with an open prerequisite is refused in plain words and changes nothing.
  await panel.getByLabel('Status').selectOption('in_progress');
  await panel.getByRole('alert').filter({ hasText: 'every task it waits for is done' }).waitFor();
  assert.equal(((expectStatus(await owner.browser.request('GET', `/api/v1/work/${planned.id}`), 200)) as WorkItem).status, 'open');

  // Keyboard: the waiting prerequisite is a real button that opens that task's own details.
  const lens = waits.getByRole('button', { name: /Order the replacement lens/ });
  await lens.focus();
  await page.keyboard.press('Enter');
  await heading(page).filter({ hasText: 'Order the replacement lens' }).waitFor();
  assert.equal(await panel.getByRole('region', { name: 'Waits for' }).count(), 0, 'a task without prerequisites has no waiting section');
  assert.equal(await panel.getByRole('region', { name: 'Done when' }).count(), 0, 'and no criteria section');

  // Finishing the prerequisite lets the dependent task start; its panel now says everything is done.
  const finished = (await owner.browser.request('PATCH', `/api/v1/work/${ordered.id}`, { body: { status: 'done' }, headers: { 'if-match': '"1"' } }));
  assert.equal(finished.status, 200, finished.text);
  await page.goto(`/projects/${place.id}/tasks`);
  await page.getByRole('button', { name: /Measure gestures at 5 lux/ }).click();
  await heading(page).filter({ hasText: 'Measure gestures at 5 lux' }).waitFor();
  await page.locator('.details.wd').getByRole('region', { name: 'Waits for' }).getByRole('status').filter({ hasText: 'Every prerequisite is done.' }).waitFor();
  await page.locator('.details.wd').getByLabel('Status').selectOption('in_progress');
  await page.locator('.details.wd .wd-eyebrow').filter({ hasText: 'In progress' }).waitFor();
  assert.equal(((expectStatus(await owner.browser.request('GET', `/api/v1/work/${planned.id}`), 200)) as WorkItem).status, 'in_progress');

  // A viewer on a phone reads the same plan without any control, and the page does not scroll sideways.
  const phone = await signedIn(reader, 390, 844);
  const view = await phone.newPage();
  view.on('pageerror', (error) => errors.push(error.message));
  await view.goto(`/projects/${place.id}/tasks`);
  await view.getByRole('button', { name: /Measure gestures at 5 lux/ }).click();
  const small = view.locator('.details.wd');
  await small.getByRole('region', { name: 'Done when' }).waitFor();
  assert.equal(await small.getByRole('region', { name: 'Done when' }).locator('li').count(), 3);
  assert.equal(await small.getByLabel('Status').count(), 0, 'a viewer cannot change it');
  // The page never scrolls sideways and the text of every new part stays inside the panel (a row's hover highlight may bleed 6px, as elsewhere).
  const overflow = await view.evaluate(() => {
    const panel = (document.querySelector('.details.wd') as HTMLElement).getBoundingClientRect();
    const outside = [...document.querySelectorAll('.details.wd .wd-criteria li, .details.wd .wd-plan, .details.wd .wd-waiting, .details.wd .wd-link > span, .details.wd .wd-link > small')]
      .filter((element) => element.getBoundingClientRect().right > panel.right + 0.5).map((element) => element.className || element.tagName);
    return { page: document.documentElement.scrollWidth - window.innerWidth, outside };
  });
  assert.ok(overflow.page <= 0 && overflow.outside.length === 0, `no sideways scroll or clipped text: ${JSON.stringify(overflow)}`);
  const touch = await small.getByRole('region', { name: 'Waits for' }).getByRole('button').first().boundingBox();
  assert.ok(touch && touch.height >= 38, `a prerequisite is easy to touch: ${touch?.height}`);
  if (evidence) await view.screenshot({ path: join(evidence, 'task-plan-phone-viewer.png'), fullPage: true });
  assert.deepEqual(errors, []);
});
