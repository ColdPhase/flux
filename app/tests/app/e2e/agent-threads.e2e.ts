import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { chromium, webkit, type Browser } from 'playwright';
import { expect } from 'playwright/test';
import type { ConversationMessage, TaskAgentThread, WorkItem } from '@flux/contracts';
import { addMember, expectStatus, grant, person, password, project, workspace, type Person } from '../support/people.js';

const engine = process.env.FLUX_E2E_BROWSER ?? 'chromium';
if (engine !== 'chromium' && engine !== 'webkit') throw new Error('Unsupported browser engine');
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const origin = new URL(process.env.FLUX_PUBLIC_ORIGIN!);
const sockets = new Set<net.Socket>();
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
  });
  forward.setTimeout(15_000, () => forward.destroy(new Error('Finite upstream request deadline')));
  forward.on('error', () => response.destroy());
  request.on('aborted', () => forward.destroy());
  request.pipe(forward);
});
proxy.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
proxy.on('upgrade', (request, socket, head) => {
  const target = net.connect(Number(upstream.port || 80), upstream.hostname, () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    target.write(`${lines.join('\r\n')}\r\n\r\n`); if (head.length) target.write(head);
    target.pipe(socket); socket.pipe(target);
  });
  sockets.add(target); target.once('close', () => sockets.delete(target));
  target.on('error', () => { target.destroy(); socket.destroy(); });
  socket.on('error', () => { target.destroy(); socket.destroy(); });
  socket.once('close', () => target.destroy()); target.once('close', () => socket.destroy());
});

let browser: Browser;
before(async () => {
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(Number(origin.port || 80), origin.hostname, resolve); });
  browser = await (engine === 'webkit' ? webkit : chromium).launch();
});
after(async () => {
  try { await browser?.close(); } finally { for (const socket of sockets) socket.destroy(); proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); }
});
async function fixture() {
  const [owner, writer, viewer, outsider] = await Promise.all(['Ari Thread owner', 'Blair Measurements', 'Cleo Observer', 'Dev Other member'].map(person));
  const ws = await workspace(owner, 'Prototype lab');
  for (const p of [writer, viewer, outsider]) await addMember(owner, ws.id, p, 'member');
  const place = await project(owner, ws.id, 'Gesture lamp', 'restricted');
  await grant(owner, place.id, writer, 'contributor'); await grant(owner, place.id, viewer, 'viewer');
  const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Compare the two prototype measurements', outcome: 'Choose the sensor after checking both readings.' } }), 201) as WorkItem;
  const path = `/api/v1/work/${task.id}/agent-thread`;
  const say = async (body: string, who = owner) => expectStatus(await who.browser.request('POST', path, { body: { body, clientMessageId: randomUUID() } }), 201) as ConversationMessage;
  const read = async () => expectStatus(await owner.browser.request('GET', path), 200) as TaskAgentThread;
  return { owner, writer, viewer, outsider, place, task, path, say, read };
}
async function session(who: Person, width: number) {
  const context = await browser.newContext({ baseURL: origin.origin, viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width <= 680, hasTouch: width <= 680, serviceWorkers: 'block' });
  context.setDefaultTimeout(15_000);
  const response = await context.request.post('/api/auth/sign-in/email', { data: { email: who.email, password }, headers: { origin: origin.origin } });
  assert.equal(response.status(), 200, await response.text()); return context;
}
test('task Details links to the agents’ thread with its message count and opens it in the Agents tab (#400)', { timeout: 120_000 }, async () => {
  const f = await fixture();
  expectStatus(await f.owner.browser.request('POST', f.path, { body: { body: 'Both measurements are repeatable.', clientMessageId: randomUUID() } }), 201);
  for (const width of [1440, 390]) {
    const context = await session(f.writer, width); const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(`/projects/${f.place.id}/tasks?open=work:${f.task.id}`);
      await page.locator(`[data-detail-kind="work"][data-detail-id="${f.task.id}"]`).waitFor();
      const link = page.locator(`[data-agent-thread-link="${f.task.id}"]`);
      await link.waitFor();
      // The link shows at once; its count follows the read of the thread (AgentThreadLink), so this retries until the count is there.
      await expect(link, 'Details names the thread with its message count').toHaveText(/Agents’ thread · \d+ messages?/, { timeout: 15_000 });
      assert.equal(await page.locator('[data-agent-thread-task]').count(), 0, 'Details itself holds no thread panel');
      await link.click();
      await page.waitForURL(new RegExp(`/agents\\?thread=${f.task.id}`));
      await page.getByRole('region', { name: /^Agents’ thread of/ }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

// #752: under load the full check timed out waiting for this thread. The thread the address names waited for the
// Agents task list page as well as its own read; a slow or failed list kept it closed. It opens on its own read now.
test('a thread the address names opens on its own read while the Agents task list is still on its way (#752)', { timeout: 120_000 }, async () => {
  const f = await fixture();
  const context = await session(f.writer, 1440); const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const held: { abort(): Promise<void> }[] = []; let listAsked = false;
  try {
    // The list page of open tasks is held for the whole visit; nothing else is.
    await page.route((url) => url.searchParams.get('choice') === 'pivot_work', (route) => { listAsked = true; held.push({ abort: () => route.abort() }); });
    await page.goto(`/projects/${f.place.id}/agents?thread=${f.task.id}`);
    await page.getByRole('region', { name: `Agents’ thread of ${f.task.title}`, exact: true }).waitFor();
    assert.ok(listAsked, 'the Agents list page was asked for and is still held');
    assert.deepEqual(errors, []);
  } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); for (const route of held) await route.abort().catch(() => undefined); await context.close(); }
});
