import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { LIVE_SESSIONS_PATH, STREAM_PATH, taskCreationUndoPath, taskDiscussionPath, type ConversationMessage, type Material,
  type SketchDetail, type TaskCreationNotice, type UndoTaskCreationResult, type WorkItem } from '@flux/contracts';
import { pool } from '../support/db.js';
import { agentConnection } from '../support/mcp-actions.js';
import { toolValue } from '../support/mcp.js';
import { addMember, expectStatus, grant, password, person, project, workspace, type Person } from '../support/people.js';

// Real OAuth/native creation, two real human accounts, real HTTP/SQL and Chromium.
// Holds interpose on genuine responses; they do not fabricate objects or events.
// Phone-width evidence is a rendered UI check, not physical-device/PWA evidence.
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

function finite<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  // Observe rejection immediately, including a failed request before a held barrier.
  void promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  })]).finally(() => clearTimeout(timer));
  void bounded.catch(() => undefined); return bounded;
}
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let browser: Browser;
const disconnected = new WeakSet<BrowserContext>();
const pageErrors: string[] = [];
before(async () => {
  await finite(new Promise<void>((resolve, reject) => {
    proxy.once('error', reject); proxy.listen(Number(origin.port || 80), origin.hostname, resolve);
  }), 'proxy listen');
  browser = await chromium.launch({ timeout: 15_000 });
}, { timeout: 30_000 });
after(async () => {
  try { if (browser) await finite(browser.close(), 'browser close'); }
  finally {
    for (const socket of sockets) socket.destroy(); proxy.closeAllConnections();
    await finite(new Promise<void>((resolve) => proxy.close(() => resolve())), 'proxy close');
  }
  assert.deepEqual(pageErrors, [], 'no unhandled browser application errors');
}, { timeout: 30_000 });

async function fixture() {
  const [author, manager] = await Promise.all(['Ari Task author', 'Blair Project manager'].map(person));
  // Real standing grants require project management. A is temporarily admin for
  // that setup only, then returns to ordinary member before any task or browser
  // observation; B can change A's grant and A never has the owner override.
  const ws = await workspace(manager, 'Current task history');
  await addMember(manager, ws.id, author, 'admin');
  const place = await project(manager, ws.id, 'Gesture trial', 'restricted');
  await grant(manager, place.id, author, 'contributor');
  const agent = expectStatus(await author.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Trial planning agent', owner: 'self' } }), 201) as { id: string };
  expectStatus(await manager.browser.request('POST', `/api/v1/projects/${place.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const connection = await agentConnection(pool, author.browser, agent.id, [place.id]);
  const authority = await connection.grant('work.create', 'execute', 5);
  expectStatus(await manager.browser.request('PATCH', `/api/v1/workspaces/${ws.id}/members/${author.id}`,
    { body: { role: 'member' } }), 200);
  assert.equal((expectStatus(await author.browser.request('GET', `/api/v1/workspaces/${ws.id}`), 200) as { role: string }).role, 'member');
  assert.equal((expectStatus(await author.browser.request('GET', `/api/v1/projects/${place.id}`), 200) as { access: string }).access, 'contributor');
  const read = async (id: string) => expectStatus(await author.browser.request('GET', `/api/v1/work/${id}`), 200) as WorkItem;
  const create = async (title = 'Measure gestures at five lux') => {
    const result = toolValue(await connection.tool('flux_create_task', { projectId: place.id,
      runtimeSessionId: connection.runtimeSessionId, grantId: authority.id, clientCommandId: randomUUID(),
      peerRequestClass: 'execute', sources: [], task: { title, outcome: 'A reproducible low-light measurement',
        criteria: ['Twenty gestures per light level', 'Attach the raw counts before drawing a conclusion'] } }));
    const item = await read(String(result.workId)); assert.equal(item.creationUndo?.eligible, true); return item;
  };
  const undo = async (item: WorkItem, who = author, clientCommandId = randomUUID()) =>
    expectStatus(await who.browser.request('POST', taskCreationUndoPath(item.id),
      { body: { clientCommandId, expectedVersion: item.version } }), 200) as UndoTaskCreationResult;
  return { author, manager, ws, place, create, read, undo };
}
type Scene = Awaited<ReturnType<typeof fixture>>;
const panel = (page: Page) => page.locator('.details.wd');
const title = (page: Page, item: WorkItem) => panel(page).getByRole('heading', { name: item.title, exact: true });
const undoButton = (page: Page) => panel(page).getByRole('button', { name: 'Undo task creation', exact: true });
const draftKey = (f: Scene, item: WorkItem) => `flux:composer:${f.author.id}:${f.place.id}:task:${item.id}`;
async function signedIn(who: Person, options: { disconnected?: boolean; width?: number; height?: number } = {}) {
  const context = await browser.newContext({ baseURL: origin.origin, viewport: { width: options.width ?? 1280, height: options.height ?? 900 } });
  context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(15_000);
  if (options.disconnected) { disconnected.add(context); await context.routeWebSocket(`**${STREAM_PATH}*`, (socket) => socket.close()); }
  const response = await context.request.post('/api/auth/sign-in/email',
    { data: { email: who.email, password }, headers: { origin: origin.origin }, timeout: 15_000 });
  assert.equal(response.status(), 200, await response.text()); return context;
}
async function open(context: BrowserContext, f: Scene, item: WorkItem, surface = 'tasks', eligible = true) {
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const ready = gate();
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== STREAM_PATH) return;
    socket.on('framereceived', (frame) => { try { if (JSON.parse(String(frame.payload)).type === 'ready') ready.resolve(); } catch { /* A non-JSON frame is not stream readiness. */ } });
  });
  await page.goto(`/projects/${f.place.id}${surface === 'conversations' ? '' : `/${surface}`}?open=work:${item.id}`);
  if (!disconnected.has(context)) await finite(ready.promise, 'real authorized stream ready');
  await title(page, item).waitFor(); if (eligible) await undoButton(page).waitFor();
  await panel(page).getByRole('textbox', { name: 'First message about this task', exact: true }).waitFor();
  return page;
}
async function storedDraft(page: Page, key: string) {
  return await page.evaluate((value) => JSON.parse(localStorage.getItem(value) ?? 'null'), key) as {
    body: string; files: { state: string; staged: { id: string }; name: string }[]; references: { materialId: string; version: number; title: string }[]; commandId: string;
  };
}
async function stageDraft(page: Page, f: Scene, item: WorkItem) {
  await panel(page).getByRole('textbox', { name: 'First message about this task', exact: true }).fill('Unsent measurement notes stay with this task.');
  await panel(page).locator('.composer-files input[type=file]').first().setInputFiles({ name: 'trial-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Private staged measurement notes\n') });
  await panel(page).getByText(/trial-notes.txt/).waitFor();
  await panel(page).getByText(/Ready, private/).waitFor();
  const value = await storedDraft(page, draftKey(f, item)); assert.equal(value.files[0]?.state, 'ready'); return value;
}
async function reverted(page: Page, item: WorkItem) {
  await title(page, item).waitFor();
  await panel(page).getByText('Creation undone · read-only history', { exact: true }).waitFor();
  assert.equal(await undoButton(page).count(), 0); assert.equal(await panel(page).getByLabel('Status', { exact: true }).count(), 0);
  assert.equal(await panel(page).getByRole('textbox').count(), 0);
  assert.equal(await panel(page).locator('.lv-inline').count(), 0);
}
async function withContexts(contexts: BrowserContext[], run: () => Promise<void>) {
  const failures: unknown[] = [];
  try { await run(); } catch (error) { failures.push(error); }
  const closed = await Promise.allSettled(contexts.map((context) => finite(context.close(), 'context close')));
  for (const result of closed) if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Browser control and context cleanup failed');
}
async function notices(f: Scene, item: WorkItem) {
  const value = expectStatus(await f.author.browser.request('GET', `/api/v1/projects/${f.place.id}/task-notices?limit=100`), 200) as { items: TaskCreationNotice[] };
  return value.items.filter((notice) => notice.workId === item.id);
}

// Each hold has one real response, a finite release deadline, immediate rejection
// observation and explicit settlement. Retired requests are allowed only by the
// test after it has deliberately invalidated their captured read scope.
async function holdRead(page: Page, path: string, all = false) {
  const held = gate<unknown>(); const release = gate(); const pending = new Set<Promise<void>>();
  let used = false; let retired = false; let failure: unknown;
  const handler = (route: Route) => {
    if (finished || (used && !all) || route.request().method() !== 'GET') return route.continue();
    used = true;
    const run = (async () => { try {
      const response = await route.fetch({ timeout: 15_000 }); held.resolve(await response.json());
      await finite(release.promise, 'held real read release', 30_000);
      await route.fulfill({ response });
    } catch (error) { if (!retired) failure = error; } })();
    pending.add(run); void run.then(() => pending.delete(run), () => pending.delete(run)); return run;
  };
  const matches = (url: URL) => url.pathname === path;
  let finished = false;
  await page.route(matches, handler);
  return { held: finite(held.promise, 'held real read'), retire: () => { retired = true; },
    async finish() { if (finished) return; finished = true; release.resolve(); try { await finite(Promise.all([...pending]), 'held real read settle'); }
      finally { await page.unroute(matches, handler); } if (failure) throw failure; } };
}

test('two accounts keep Conversation, Tasks, Map and Agents current after real Undo, with one retained notice history and private draft', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create();
  const sketch = expectStatus(await f.author.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/sketches`,
    { body: { title: 'Low-light measurement map', scope: 'project', projectId: f.place.id } }), 201) as { id: string };
  expectStatus(await f.author.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`,
    { body: { text: 'Keep the lamp distance fixed', x: 120, y: 100 } }), 201);
  const mapBefore = expectStatus(await f.author.browser.request('GET', `/api/v1/sketches/${sketch.id}`), 200) as SketchDetail;
  const a = await signedIn(f.author); const b = await signedIn(f.manager);
  await withContexts([a, b], async () => {
    const errors: string[] = [];
    const pages: Page[] = [];
    for (const surface of ['conversations', 'tasks', `map/${sketch.id}`, 'agents']) {
      const page = await open(a, f, item, surface); page.on('pageerror', (error) => errors.push(error.message)); pages.push(page);
    }
    const peer = await open(b, f, item, 'tasks', false);
    assert.equal(await undoButton(peer).count(), 0, 'manager B is unrelated to the actual creator');
    expectStatus(await f.manager.browser.request('POST', taskCreationUndoPath(item.id),
      { body: { clientCommandId: randomUUID(), expectedVersion: item.version } }), 403);
    const original = await stageDraft(pages[0]!, f, item);
    const resultResponse = finite(pages[1]!.waitForResponse((response) => new URL(response.url()).pathname === taskCreationUndoPath(item.id) && response.request().method() === 'POST'), 'real UI Undo response', 15_000);
    await undoButton(pages[1]!).focus(); await pages[1]!.keyboard.press('Enter');
    const response = await finite(resultResponse, 'real UI Undo response', 15_000); assert.equal(response.status(), 200, await response.text());
    const result = await response.json() as UndoTaskCreationResult;
    for (const page of [...pages, peer]) await reverted(page, item);
    assert.deepEqual(await storedDraft(pages[0]!, draftKey(f, item)), original);
    const list = expectStatus(await f.author.browser.request('GET', `/api/v1/projects/${f.place.id}/work`), 200) as { items: WorkItem[] };
    assert.ok(!list.items.some((entry) => entry.id === item.id));
    assert.equal(await pages[1]!.locator(`.tb-card[data-card-id="${item.id}"]`).count(), 0);
    assert.equal(await pages[3]!.locator(`.agents__task option[value="${item.id}"]`).count(), 0);
    const history = await notices(f, item); assert.equal(history.length, 2);
    for (const notice of history) {
      const row = pages[0]!.locator(`#notice-${notice.id}`); await row.waitFor();
      assert.equal(await row.locator('time').getAttribute('datetime'), notice.createdAt);
      assert.equal(await row.getByRole('button', { name: `Open task: ${item.title}`, exact: true }).count(), 1);
    }
    const appended = history.find((notice) => notice.kind === 'task.creation_reverted')!;
    assert.equal(appended.id, result.noticeId); assert.equal(appended.createdBy.id, f.author.id);
    assert.match(await pages[0]!.locator(`#notice-${appended.id}`).innerText(), /Ari Task author · you/);
    const receipts = await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id]); assert.equal(receipts.rows[0].n, 1);
    assert.deepEqual(expectStatus(await f.author.browser.request('GET', `/api/v1/sketches/${sketch.id}`), 200), mapBefore,
      'real map thoughts are unchanged; the map has no invented persisted task nodes');
    await pages[0]!.locator(`#notice-${appended.id}`).getByRole('button').click(); await reverted(pages[0]!, item);
    assert.deepEqual(errors, []);
  });
});

test('late real object GET and loadContext cannot restore obsolete authority or overwrite another task draft', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const other = await f.create('Calibrate the replacement sensor');
  const context = await signedIn(f.author);
  await withContexts([context], async () => {
    const page = await open(context, f, item); const original = await stageDraft(page, f, item);
    const oldObject = await holdRead(page, `/api/v1/work/${item.id}`);
    let currentContext: Awaited<ReturnType<typeof holdRead>> | undefined;
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const snapshot = await oldObject.held as WorkItem; assert.equal(snapshot.version, item.version); assert.equal(snapshot.lifecycle?.state, 'active');
      await panel(page).getByRole('status').filter({ hasText: 'Checking current task details' }).waitFor();
      assert.equal(await undoButton(page).count(), 0); assert.equal(await panel(page).getByLabel('Status', { exact: true }).count(), 0);
      assert.equal(await panel(page).getByRole('textbox').getAttribute('readonly'), '');
      currentContext = await holdRead(page, `/api/v1/projects/${f.place.id}`, true);
      oldObject.retire(); const result = await f.undo(item);
      await currentContext.held;
      assert.equal(await undoButton(page).count(), 0, 'known Undo retires authority before its context read completes');
      assert.equal(await panel(page).locator('.lv-inline').count(), 0);
      await currentContext.finish(); currentContext = undefined;
      await reverted(page, item);
      assert.equal((await f.read(item.id)).version, result.work.version);
      await oldObject.finish(); await reverted(page, item);
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);
      // Same mounted Details tree changes object. A captured A read cannot replace B.
      const late = await holdRead(page, `/api/v1/work/${item.id}`);
      try {
        await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await late.held;
        late.retire(); await page.locator(`.tb-card[data-card-id="${other.id}"]`).getByRole('button', { name: other.title, exact: true }).click();
        await title(page, other).waitFor(); await undoButton(page).waitFor();
        await panel(page).getByRole('textbox', { name: 'First message about this task' }).fill('A separate calibration draft');
        const otherDraft = await storedDraft(page, draftKey(f, other));
        await late.finish(); assert.equal(await title(page, other).count(), 1);
        assert.deepEqual(await storedDraft(page, draftKey(f, other)), otherDraft);
        assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);
        const oldDiscussion = await holdRead(page, taskDiscussionPath(other.id));
        try {
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          const empty = await oldDiscussion.held as { root: unknown }; assert.equal(empty.root, null);
          oldDiscussion.retire();
          const root = expectStatus(await f.manager.browser.request('POST', taskDiscussionPath(other.id),
            { body: { body: 'The replacement sensor calibration is now measured.', clientMessageId: randomUUID(), kind: 'text' } }), 201) as ConversationMessage;
          await panel(page).getByText(root.body, { exact: true }).waitFor();
          assert.equal(await panel(page).locator('.wd-discussion time').getAttribute('datetime'), root.createdAt);
          await oldDiscussion.finish(); await panel(page).getByText(root.body, { exact: true }).waitFor();
          assert.deepEqual(await storedDraft(page, draftKey(f, other)), otherDraft);
          assert.equal(await undoButton(page).count(), 0);
        } finally { oldDiscussion.retire(); await oldDiscussion.finish(); }
      } finally { await late.finish(); }
    } finally { oldObject.retire(); currentContext?.retire(); if (currentContext) await currentContext.finish(); await oldObject.finish(); }
  });
});

test('real sign-out and account switch reject a held old-account context and keep the new account draft isolated', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author);
  await withContexts([context], async () => {
    const page = await open(context, f, item); await stageDraft(page, f, item);
    const late = await holdRead(page, `/api/v1/projects/${f.place.id}`);
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await late.held;
      late.retire(); await page.goto('/sign-out'); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('heading', { name: 'Sign in to Flux', exact: true }).waitFor();
      await page.getByLabel('Email', { exact: true }).fill(f.manager.email); await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL((url) => !url.pathname.includes('sign-in'));
      await page.goto(`/projects/${f.place.id}/tasks?open=work:${item.id}`); await title(page, item).waitFor();
      assert.equal(await undoButton(page).count(), 0);
      await panel(page).getByRole('textbox', { name: 'First message about this task' }).fill('Blair account draft only');
      const key = `flux:composer:${f.manager.id}:${f.place.id}:task:${item.id}`;
      const before = await storedDraft(page, key); await late.finish();
      assert.deepEqual(await storedDraft(page, key), before); assert.equal(before.body, 'Blair account draft only');
      assert.equal(await page.evaluate((value) => localStorage.getItem(value), draftKey(f, item)), null,
        'confirmed sign-out follows the existing explicit account draft retirement policy');
      assert.equal(await undoButton(page).count(), 0);
    } finally { late.retire(); await late.finish(); }
  });
});

test('current grant change retires obsolete controls before fresh context settles and keeps private staged text/files', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author);
  await withContexts([context], async () => {
    const page = await open(context, f, item); const original = await stageDraft(page, f, item);
    const late = await holdRead(page, `/api/v1/projects/${f.place.id}`, true);
    try {
      await grant(f.manager, f.place.id, f.author, 'viewer');
      const current = await late.held as { access: string }; assert.equal(current.access, 'viewer');
      await panel(page).getByRole('status').filter({ hasText: 'Checking current task details' }).waitFor();
      assert.equal(await undoButton(page).count(), 0); assert.equal(await panel(page).getByLabel('Status', { exact: true }).count(), 0);
      assert.equal(await panel(page).locator('.lv-inline').count(), 0); assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);
      await late.finish(); await title(page, item).waitFor();
      await panel(page).getByText('Nobody has written about this task yet.', { exact: true }).waitFor();
      assert.equal(await panel(page).getByRole('textbox').count(), 0); assert.equal(await undoButton(page).count(), 0);
      const response = await f.author.browser.request('POST', taskCreationUndoPath(item.id),
        { body: { clientCommandId: randomUUID(), expectedVersion: item.version } }); assert.equal(response.status, 403);
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), original); assert.equal((await f.read(item.id)).lifecycle?.state, 'active');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id])).rows[0].n, 0);
    } finally { late.retire(); await late.finish(); }
  });
});

async function holdUndo(page: Page, item: WorkItem, lostResponse = false) {
  const held = gate<{ clientCommandId: string; expectedVersion: number }>(); const release = gate();
  const forwarded = gate<{ status: number; body: unknown }>(); const settled = gate();
  const matches = (url: URL) => url.pathname === taskCreationUndoPath(item.id);
  let used = false; let failure: unknown; let finished = false;
  const handler = async (route: Route) => {
    if (used || route.request().method() !== 'POST') { await route.continue(); return; }
    used = true;
    try {
      held.resolve(route.request().postDataJSON()); await finite(release.promise, 'held Undo release', 30_000);
      const response = await route.fetch({ timeout: 15_000 }); forwarded.resolve({ status: response.status(), body: await response.json() });
      if (lostResponse) await route.abort('failed'); else await route.fulfill({ response });
    } catch (error) { failure = error; }
    finally { settled.resolve(); }
  };
  await page.route(matches, handler);
  return { held: finite(held.promise, 'outgoing real Undo'), forwarded: finite(forwarded.promise, 'forwarded real Undo', 30_000),
    release: () => release.resolve(),
    async finish() { if (finished) return; finished = true; release.resolve(); try { if (used) await finite(settled.promise, 'Undo settle'); }
      finally { await page.unroute(matches, handler); } if (failure) throw failure; } };
}

test('pending Undo disables one scoped action and lost real response retries the exact committed UUID/receipt without a new notice', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author, { disconnected: true });
  await withContexts([context], async () => {
    const page = await open(context, f, item); const draft = await stageDraft(page, f, item);
    const command = await holdUndo(page, item, true);
    try {
      await undoButton(page).click(); const outgoing = await command.held;
      assert.equal(outgoing.expectedVersion, item.version); assert.match(outgoing.clientCommandId, /^[a-f0-9-]{36}$/);
      assert.equal(await undoButton(page).isDisabled(), true); assert.equal(await undoButton(page).getAttribute('aria-busy'), 'true');
      const identity = `flux:creation-undo:${f.author.id}:${f.place.id}:${item.id}:${item.version}`;
      assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), identity), outgoing.clientCommandId);
      command.release(); const actual = await command.forwarded; assert.equal(actual.status, 200);
      const result = actual.body as UndoTaskCreationResult;
      await panel(page).getByRole('alert').filter({ hasText: /could not be reached|Could not confirm|Network/i }).waitFor();
      assert.equal(await undoButton(page).isDisabled(), false); assert.deepEqual(await storedDraft(page, draftKey(f, item)), draft);
      const before = (await pool.query('SELECT count(*)::int AS n FROM events WHERE object_id=$1', [f.place.id])).rows[0].n;
      const replayPromise = finite(page.waitForResponse((response) => new URL(response.url()).pathname === taskCreationUndoPath(item.id) && response.request().method() === 'POST'), 'real exact UUID replay', 15_000);
      await undoButton(page).click(); const replay = await finite(replayPromise, 'real exact UUID replay', 15_000);
      assert.equal(replay.request().postDataJSON().clientCommandId, outgoing.clientCommandId); assert.equal(replay.status(), 200);
      assert.deepEqual(await replay.json(), result); await reverted(page, item);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM events WHERE object_id=$1', [f.place.id])).rows[0].n, before);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id])).rows[0].n, 1);
      assert.equal((await notices(f, item)).length, 2); assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), identity), null);
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), draft);
    } finally { await command.finish(); }
  });
});

test('late first-use and grant refusals preserve real staged drafts and a genuinely selected immutable source; refresh shows the canonical root', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author, { disconnected: true });
  await withContexts([context], async () => {
    const page = await open(context, f, item, 'conversations'); const original = await stageDraft(page, f, item);
    const command = await holdUndo(page, item);
    try {
      await undoButton(page).click(); await command.held;
      const root = expectStatus(await f.manager.browser.request('POST', taskDiscussionPath(item.id),
        { body: { body: 'Blair measured the first actual trial.', clientMessageId: randomUUID(), kind: 'text' } }), 201) as ConversationMessage;
      command.release(); const refusal = await command.forwarded; assert.equal(refusal.status, 409);
      await panel(page).getByRole('alert').filter({ hasText: 'changed or been used' }).waitFor();
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);
      assert.equal((await f.read(item.id)).lifecycle?.state, 'active');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id])).rows[0].n, 0);
      await panel(page).getByRole('button', { name: 'Refresh details', exact: true }).click();
      await panel(page).getByText(root.body, { exact: true }).waitFor();
      assert.equal(await undoButton(page).count(), 0);
      assert.equal(await panel(page).locator('.wd-discussion time').getAttribute('datetime'), root.createdAt);
      assert.match(await panel(page).locator('.wd-discussion__who').innerText(), /Blair Project manager/);
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);

      // The admitted source picker exists in the genuine bound project thread,
      // after first use, and shares the task draft. No fresh-task picker is invented.
      const material = expectStatus(await f.manager.browser.request('POST', `/api/v1/projects/${f.place.id}/materials`,
        { body: { clientMutationId: randomUUID(), title: 'Trial measurement protocol', body: 'Keep the same distance and ambient light.' } }), 201) as Material;
      await panel(page).getByRole('link', { name: /Open in Conversation/ }).click();
      const thread = page.locator('#thread'); await thread.getByRole('textbox', { name: 'Reply', exact: true }).waitFor();
      await thread.getByRole('button', { name: /^Sources/ }).click();
      await thread.locator('.project-convo__material').filter({ hasText: material.title }).getByRole('button', { name: 'Discuss this version', exact: true }).click();
      await thread.getByText(`Source: ${material.title} · v${material.version}`, { exact: true }).waitFor();
      const selected = await storedDraft(page, draftKey(f, item));
      assert.deepEqual(selected.references, [{ materialId: material.materialId, version: material.version, title: material.title }]);
      assert.equal(selected.files[0]?.staged.id, original.files[0]?.staged.id); assert.equal(selected.body, original.body);
      // A second actual current-rights refusal preserves that full selected draft.
      await grant(f.manager, f.place.id, f.author, 'viewer');
      const refusedSend = finite(page.waitForResponse((response) => new URL(response.url()).pathname === taskDiscussionPath(item.id) && response.request().method() === 'POST'), 'current-rights real source/file send refusal', 15_000);
      await thread.getByRole('button', { name: 'Send reply', exact: true }).click();
      const send = await finite(refusedSend, 'current-rights real source/file send refusal', 15_000); assert.equal(send.status(), 403);
      await thread.getByRole('alert').filter({ hasText: 'Your draft, files and sources are kept' }).waitFor();
      const retained = await storedDraft(page, draftKey(f, item));
      assert.equal(retained.body, selected.body); assert.deepEqual(retained.files, selected.files); assert.deepEqual(retained.references, selected.references);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_messages WHERE conversation_id=$1', [root.conversationId])).rows[0].n, 1);
      assert.equal((await notices(f, item)).length, 1);
    } finally { await command.finish(); }

    // An unused fresh task with the old command UI gets a genuine Undo403 as
    // well. Grant loss is deliberately disconnected only for this failure path.
    await grant(f.manager, f.place.id, f.author, 'contributor');
    const untouched = await f.create('An unchanged second measurement'); const other = await open(context, f, untouched);
    const secondDraft = await stageDraft(other, f, untouched); const pending = await holdUndo(other, untouched);
    try {
      await undoButton(other).click(); await pending.held;
      await grant(f.manager, f.place.id, f.author, 'viewer'); pending.release(); assert.equal((await pending.forwarded).status, 403);
      await panel(other).getByRole('alert').filter({ hasText: 'not change it' }).waitFor();
      assert.deepEqual(await storedDraft(other, draftKey(f, untouched)), secondDraft);
      await panel(other).getByRole('button', { name: 'Refresh details', exact: true }).click();
      await panel(other).getByText('Nobody has written about this task yet.', { exact: true }).waitFor();
      assert.equal(await undoButton(other).count(), 0); assert.equal(await panel(other).getByRole('textbox').count(), 0);
      assert.deepEqual(await storedDraft(other, draftKey(f, untouched)), secondDraft);
    } finally { await pending.finish(); }
  });
});

test('desktop and phone-width history render readable actor/time, keyboard links and no horizontal overflow on realistic content', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create('Measure the gesture lamp under dim light before changing the sensor');
  const result = await f.undo(item); const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
  for (const [width, height] of [[1280, 900], [390, 844]]) {
    const context = await signedIn(f.author, { width, height });
    await withContexts([context], async () => {
      const page = await context.newPage(); page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`/projects/${f.place.id}?open=work:${item.id}`); await reverted(page, item);
      const life = result.work.lifecycle; assert.ok(life?.state === 'creation_reverted');
      assert.match(await panel(page).innerText(), /Creation undone by Ari Task author on/);
      assert.equal(await panel(page).getByRole('region', { name: 'Done when' }).locator('li').count(), 2);
      const overflow = await page.evaluate(() => {
        const bounds = document.querySelector('.details.wd')!.getBoundingClientRect();
        return { page: document.documentElement.scrollWidth - window.innerWidth,
          outside: [...document.querySelectorAll('.details.wd .details__title,.details.wd .wd-criteria li,.details.wd .wd-muted,.details.wd .wd-ids')]
            .filter((element) => element.getBoundingClientRect().right > bounds.right + 1).map((element) => element.className) };
      });
      assert.ok(overflow.page <= 0 && overflow.outside.length === 0, JSON.stringify(overflow));
      if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `task-undo-history-${width}.png`), fullPage: true }); }
      await page.getByRole('button', { name: 'Close details', exact: true }).click();
      const notice = page.locator(`#notice-${result.noticeId}`); await notice.waitFor();
      assert.equal(await notice.locator('time').getAttribute('datetime'), life.revertedAt);
      const historyLink = notice.getByRole('button', { name: `Open task: ${item.title}`, exact: true });
      await historyLink.focus(); await page.keyboard.press('Enter'); await reverted(page, item);
      if (evidence) await page.screenshot({ path: join(evidence, `task-undo-keyboard-history-${width}.png`), fullPage: true });
    });
  }
});

test('configured real LiveKit discovery held across Undo cannot publish or join an obsolete task anchor', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author);
  await withContexts([context], async () => {
    const capability = await context.request.get(`${LIVE_SESSIONS_PATH}/capabilities`, { timeout: 15_000 });
    assert.equal(capability.status(), 200); assert.equal((await capability.json()).status, 'configured',
      'this required control runs with the genuine configured LiveKit test Compose service, never fabricated capabilities');
    const page = await open(context, f, item);
    const posts: string[] = []; page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith(LIVE_SESSIONS_PATH)) posts.push(new URL(request.url()).pathname);
    });
    const discovery = await holdRead(page, `/api/v1/projects/${f.place.id}/live-sessions`);
    try {
      await panel(page).getByRole('button', { name: 'Work on this together', exact: true }).click();
      const actual = await discovery.held as { items: unknown[] }; assert.deepEqual(actual.items, []);
      await f.undo(item); await reverted(page, item);
      const responsePromise = finite(page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${f.place.id}/live-sessions`), 'held discovery response settles', 15_000);
      await discovery.finish();
      const response = await finite(responsePromise, 'held discovery response settles'); await finite(response.finished(), 'held discovery body settles');
      // Flush the continuation of that genuine pending preflight; no publication
      // response can be used as a fake successful check of a not-yet-started call.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.deepEqual(posts, []);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM live_sessions WHERE work_id=$1', [item.id])).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM live_presentations WHERE ref_type='work' AND ref_id=$1", [item.id])).rows[0].n, 0);
      const stored = (await pool.query('SELECT first_persisted_use_at,creation_reverted_at FROM project_work_items WHERE id=$1', [item.id])).rows[0];
      assert.equal(stored.first_persisted_use_at, null); assert.ok(stored.creation_reverted_at);
    } finally { discovery.retire(); await discovery.finish(); }
  });
});
