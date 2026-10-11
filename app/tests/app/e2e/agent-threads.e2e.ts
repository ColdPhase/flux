import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { join } from 'node:path';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import type { TaskAgentThread, ConversationMessage, WorkItem } from '@flux/contracts';
import { addMember, expectStatus, grant, person, password, project, workspace, type Person } from '../support/people.js';
import { pool } from '../support/db.js';

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
  const context = await browser.newContext({ baseURL: origin.origin, viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390, serviceWorkers: 'block' });
  context.setDefaultTimeout(15_000);
  const response = await context.request.post('/api/auth/sign-in/email', { data: { email: who.email, password }, headers: { origin: origin.origin } });
  assert.equal(response.status(), 200, await response.text()); return context;
}
const panel = (page: Page) => page.locator('[data-agent-thread-task]');
async function capture(page: Page, name: string) {
  const directory = process.env.FLUX_E2E_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true }); await page.screenshot({ path: join(directory, `${engine}-${name}.png`) });
}

test('task Details opens the one thread surface; real contributor sends, viewer reads and keyboard/drafts survive', { timeout: 180_000 }, async () => {
  const f = await fixture();
  for (const width of [1440, 390]) {
    const context = await session(f.writer, width); const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(`/projects/${f.place.id}/tasks?open=work:${f.task.id}`);
      const entry = page.locator(`[data-agent-thread-entry="${f.task.id}"]`);
      await entry.waitFor(); await entry.click(); await panel(page).getByRole('heading', { name: f.task.title }).waitFor();
      await panel(page).getByRole('textbox', { name: 'Write in the agents’ thread' }).waitFor();
      assert.equal((await f.read()).messageCount, width === 1440 ? 0 : 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_conversations WHERE work_id=$1', [f.task.id])).rows[0].n, width === 1440 ? 0 : 1, 'opening/reading never creates a thread');
      const field = panel(page).getByRole('textbox', { name: 'Write in the agents’ thread' });
      if (width === 1440) await capture(page, 'empty-desktop-light');
      await field.fill(width === 1440 ? 'Both measurements are repeatable. The warm light has a steadier baseline.' : 'The second prototype also passes the low-light check.');
      await panel(page).getByRole('button', { name: 'Back to task' }).click();
      await page.waitForFunction(id => document.activeElement?.getAttribute('data-agent-thread-entry') === id, f.task.id);
      await entry.press('Enter'); await field.waitFor(); assert.ok((await field.inputValue()).includes(width === 1440 ? 'repeatable' : 'low-light'));
      const accepted = page.waitForResponse(response => new URL(response.url()).pathname === f.path && response.request().method() === 'POST');
      await field.press('Control+Enter'); assert.equal((await accepted).status(), 201);
      await page.waitForFunction(() => document.querySelectorAll('.at-message').length > 0);
      await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.waitForFunction(n => document.querySelectorAll('.at-message').length === n, width === 1440 ? 1 : 2);
      assert.equal(await field.inputValue(), '');
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
        await capture(page, `writer-${width}-${theme}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no page horizontal overflow');
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
    const readers = await session(f.viewer, width); const readPage = await readers.newPage();
    try {
      await readPage.goto(`/projects/${f.place.id}/tasks?open=work:${f.task.id}&agentThread=1`);
      await panel(readPage).locator('.at-message').first().waitFor(); assert.equal(await panel(readPage).getByRole('textbox').count(), 0);
      assert.equal(await panel(readPage).getByRole('button', { name: 'Send', exact: true }).count(), 0);
      await capture(readPage, `viewer-${width}-light`);
    } finally { await readers.close(); }
  }
  const nobody = await session(f.outsider, 390); const page = await nobody.newPage();
  try { await page.goto(`/projects/${f.place.id}/tasks?open=work:${f.task.id}&agentThread=1`); assert.equal(await page.locator('.at-message').count(), 0); assert.equal(await page.getByRole('textbox', { name: 'Write in the agents’ thread' }).count(), 0); }
  finally { await nobody.close(); }
});

test('older search arrival focuses the exact message; real refused/lost-response retry preserves identity and access revocation', { timeout: 180_000 }, async () => {
  const f = await fixture(); const first = await f.say('Original measurement outside the latest fifty messages.');
  for (let i = 0; i < 50; i++) await f.say(`Prototype observation ${i + 1}`);
  const context = await session(f.writer, 390); const page = await context.newPage();
  try {
    await page.goto(`/projects/${f.place.id}/tasks?open=work:${f.task.id}&agentThread=1#message-${first.id}`);
    await page.waitForFunction(id => document.activeElement?.getAttribute('data-message-id') === id, first.id);
    const box = await panel(page).locator(`[data-message-id="${first.id}"]`).boundingBox(); assert.ok(box && box.y >= 0 && box.y < 844);
    const field = panel(page).getByRole('textbox', { name: 'Write in the agents’ thread' });
    let commandId = ''; let actualMessageId = ''; let intercepted = false;
    await page.route(`**${f.path}`, async route => {
      if (route.request().method() !== 'POST' || intercepted) { await route.continue(); return; }
      intercepted = true; commandId = (route.request().postDataJSON() as { clientMessageId: string }).clientMessageId;
      const actual = await route.fetch(); assert.equal(actual.status(), 201); actualMessageId = (await actual.json() as ConversationMessage).id;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'TEST_RESPONSE_LOST', message: 'The stored response was unavailable.' }) });
    });
    await field.fill('The comparison is stored once even when its acknowledgement is lost.'); await panel(page).getByRole('button', { name: 'Send', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Retry', exact: true }).waitFor();
    const replay = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === f.path);
    await panel(page).getByRole('button', { name: 'Retry', exact: true }).click(); const response = await replay;
    assert.equal(response.status(), 201); assert.equal((response.request().postDataJSON() as { clientMessageId: string }).clientMessageId, commandId);
    assert.equal((await response.json() as ConversationMessage).id, actualMessageId);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE conversation_id=$1 AND client_message_id=$2', [first.conversationId, commandId])).rows[0].n, 1);
    await field.fill('Keep this unsent reading after my rights change.');
    await grant(f.owner, f.place.id, f.writer, 'viewer');
    const refused = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === f.path);
    await panel(page).getByRole('button', { name: 'Send', exact: true }).click(); assert.equal((await refused).status(), 403);
    await page.waitForFunction(() => (document.querySelector('.at-composer textarea') as HTMLTextAreaElement | null)?.value.includes('Keep this unsent'));
    await capture(page, 'refused-phone-light');
    await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.at-composer textarea'));
    const kept = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), `flux:composer:${f.writer.id}:${f.place.id}:agent-thread:${f.task.id}`) as { body: string };
    assert.ok(kept.body.includes('Keep this unsent'));
    await grant(f.owner, f.place.id, f.writer, 'denied'); await page.reload();
    assert.equal(await panel(page).locator('.at-message').count(), 0);
  } finally { await context.close(); }
});
