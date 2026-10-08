import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { LIVE_SESSIONS_PATH, projectWorkDetailPath, STREAM_PATH, taskCreationUndoPath, taskDiscussionPath, type ConversationMessage,
  projectWorkPath, type SketchDetail, type TaskCreationNotice, type UndoTaskCreationResult, type WorkItem } from '@flux/contracts';
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
  return page;
}
async function storedDraft(page: Page, key: string) {
  return await page.evaluate((value) => JSON.parse(localStorage.getItem(value) ?? sessionStorage.getItem(value) ?? 'null'), key) as {
    body: string; files: { state: string; staged: { id: string }; name: string }[]; references: { materialId: string; version: number; title: string }[]; commandId: string;
    pending: { id: string; body: string; state: string; error?: string; files: unknown[]; references: unknown[] }[];
  };
}
async function stageDraft(page: Page, f: Scene, item: WorkItem) {
  await panel(page).getByRole('textbox', { name: 'First message about this task', exact: true }).fill('Unsent measurement notes stay with this task.');
  await panel(page).locator('.composer-files input[type=file]').first().setInputFiles({ name: 'trial-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Private staged measurement notes\n') });
  await panel(page).getByText(/trial-notes.txt/).waitFor();
  await panel(page).getByText(/Ready, private/).waitFor();
  const value = await storedDraft(page, draftKey(f, item)); assert.equal(value.files[0]?.state, 'ready'); return value;
}
/** Read-only history: no Undo, no change, no live entry, no composer; the reverter and the time are named. */
async function reverted(page: Page, item: WorkItem) {
  await title(page, item).waitFor();
  await panel(page).getByText('Creation undone · read-only history', { exact: true }).waitFor();
  await panel(page).locator('[data-task-lifecycle="creation_reverted"]').waitFor();
  assert.equal(await panel(page).locator('.details__eyebrow .ui-task-number').innerText(), `#${item.number}`);
  assert.equal(await undoButton(page).count(), 0); assert.equal(await panel(page).getByLabel('Status', { exact: true }).count(), 0);
  assert.equal(await panel(page).getByRole('textbox').count(), 0);
  assert.equal(await panel(page).locator('.lv-inline').count(), 0);
  assert.equal(await panel(page).getByRole('button', { name: 'Attach a result', exact: true }).count(), 0);
}
async function withContexts(contexts: BrowserContext[], run: () => Promise<void>) {
  const failures: unknown[] = [];
  try { await run(); } catch (error) { failures.push(error); }
  const closed = await Promise.allSettled(contexts.map((context) => finite(context.close(), 'context close')));
  for (const result of closed) if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Browser control and context cleanup failed');
}
async function withHeldContribution(page: Page, matches: (url: URL) => boolean, handler: (route: Route) => Promise<void>,
  hold: { release: () => void; used: () => boolean; settled: Promise<void>; failure: () => unknown }, run: () => Promise<void>) {
  const failures: unknown[] = [];
  try { await page.route(matches, handler); await run(); }
  catch (error) { failures.push(error); }
  finally {
    try { hold.release(); }
    catch (error) { failures.push(error); }
    try { if (hold.used()) await finite(hold.settled, 'held contribution cleanup'); }
    catch (error) { failures.push(error); }
    try { await page.unroute(matches, handler); }
    catch (error) { failures.push(error); }
    const handlerFailure = hold.failure();
    if (handlerFailure && !failures.includes(handlerFailure)) failures.push(handlerFailure);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Contribution scenario, handler and route cleanup failed');
}
async function notices(f: Scene, item: WorkItem) {
  const value = expectStatus(await f.author.browser.request('GET', `/api/v1/projects/${f.place.id}/task-notices?limit=100`), 200) as { items: TaskCreationNotice[] };
  return value.items.filter((notice) => notice.workId === item.id);
}
const receipts = async (item: WorkItem) => (await pool.query('SELECT count(*)::int AS n FROM task_creation_undo_receipts WHERE work_id=$1', [item.id])).rows[0].n as number;

// Each hold has one real response, a finite release deadline, immediate rejection observation and explicit settlement.
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
const detailPath = (f: Scene, item: WorkItem) => projectWorkDetailPath(f.place.id, 'work', item.id);

test('pending contribution cannot be retried from undone read-only history and both private drafts survive', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author);
  await withContexts([context], async () => {
    const page = await open(context, f, item);
    const held = gate<{ clientMessageId: string }>(); const release = gate(); const settled = gate();
    const matches = (url: URL) => url.pathname === taskDiscussionPath(item.id);
    const writes: string[] = [];
    let used = false; let failure: unknown;
    const handler = async (route: Route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      if (used) { await route.continue(); return; }
      used = true;
      try {
        held.resolve(route.request().postDataJSON());
        // No task use has reached the server: Undo may still win its real transaction.
        await finite(release.promise, 'held contribution release', 30_000);
        const response = await route.fetch({ timeout: 15_000 });
        assert.equal(response.status(), 409, await response.text());
        assert.equal((await response.json() as { code: string }).code, 'TASK_CREATION_REVERTED');
        await route.fulfill({ response });
      } catch (error) { failure = error; }
      finally { settled.resolve(); }
    };
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === taskDiscussionPath(item.id))
        writes.push(request.postDataJSON().clientMessageId);
    });
    await withHeldContribution(page, matches, handler,
      { release: () => release.resolve(), used: () => used, settled: settled.promise, failure: () => failure }, async () => {
      const unsent = 'This measurement has not been sent to the task.';
      await panel(page).getByRole('textbox', { name: 'First message about this task', exact: true }).fill(unsent);
      await panel(page).getByRole('button', { name: 'Start the discussion', exact: true }).click();
      const command = await finite(held.promise, 'outgoing contribution');
      const original = await stageDraft(page, f, item);
      const pendingBefore = original.pending.find((entry) => entry.id === command.clientMessageId)!;
      assert.equal(pendingBefore.body, unsent);
      await f.undo(item); await reverted(page, item);
      release.resolve(); await finite(settled.promise, 'contribution refusal settlement');
      if (failure) throw failure;
      const pending = panel(page).locator(`[data-client-message-id="${command.clientMessageId}"]`);
      await finite((async () => {
        while ((await storedDraft(page, draftKey(f, item))).pending.find((entry) => entry.id === command.clientMessageId)?.state !== 'failed'
          || await pending.getAttribute('data-send-state') !== 'failed')
          await page.waitForTimeout(100);
      })(), 'refused pending contribution kept');
      assert.equal(await pending.getByRole('button', { name: 'Retry', exact: true }).count(), 0,
        'read-only history has no contribution retry control');
      assert.equal(await pending.getByRole('button', { name: 'Remove', exact: true }).count(), 0,
        'the history presentation keeps the unsent record intact');
      const current = await storedDraft(page, draftKey(f, item));
      assert.deepEqual({ body: current.body, files: current.files, references: current.references, commandId: current.commandId },
        { body: original.body, files: original.files, references: original.references, commandId: original.commandId }, 'second private draft kept');
      const pendingAfter = current.pending.find((entry) => entry.id === command.clientMessageId)!;
      assert.deepEqual({ id: pendingAfter.id, body: pendingAfter.body, files: pendingAfter.files, references: pendingAfter.references },
        { id: pendingBefore.id, body: pendingBefore.body, files: pendingBefore.files, references: pendingBefore.references }, 'unsent command and content kept');
      const discussion = expectStatus(await f.author.browser.request('GET', taskDiscussionPath(item.id)), 200) as { root: ConversationMessage | null; messages: ConversationMessage[] };
      assert.equal(discussion.root, null); assert.deepEqual(discussion.messages, []);
      assert.equal((await notices(f, item)).length, 2); assert.equal(await receipts(item), 1);
      await page.reload(); await reverted(page, item);
      const reloaded = panel(page).locator(`[data-client-message-id="${command.clientMessageId}"]`);
      await reloaded.waitFor(); assert.equal(await reloaded.getByRole('button').count(), 0);
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), current, 'reload keeps both private records');
      assert.deepEqual(writes, [command.clientMessageId], 'history and reload never retry the refused command');
    });
  });
});

test('a committed contribution with a held answer stays unconfirmed after write access is revoked', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author);
  await withContexts([context], async () => {
    const page = await open(context, f, item);
    const committed = gate<{ clientMessageId: string; message: ConversationMessage }>();
    const release = gate(); const settled = gate();
    const matches = (url: URL) => url.pathname === taskDiscussionPath(item.id);
    const writes: string[] = [];
    let used = false; let failure: unknown;
    const handler = async (route: Route) => {
      if (route.request().method() !== 'POST' || used) { await route.continue(); return; }
      used = true;
      try {
        const command = route.request().postDataJSON() as { clientMessageId: string };
        // The actual upstream response proves this task contribution committed before revocation.
        const response = await route.fetch({ timeout: 15_000 });
        assert.equal(response.status(), 201, await response.text());
        committed.resolve({ clientMessageId: command.clientMessageId, message: await response.json() as ConversationMessage });
        await finite(release.promise, 'committed contribution answer release', 45_000);
        await route.fulfill({ response });
      } catch (error) { failure = error; }
      finally { settled.resolve(); }
    };
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === taskDiscussionPath(item.id))
        writes.push(request.postDataJSON().clientMessageId);
    });
    await withHeldContribution(page, matches, handler,
      { release: () => release.resolve(), used: () => used, settled: settled.promise, failure: () => failure }, async () => {
      const body = 'The sensor measurement is saved while its answer is still on the way.';
      await panel(page).getByRole('textbox', { name: 'First message about this task', exact: true }).fill(body);
      await panel(page).getByRole('button', { name: 'Start the discussion', exact: true }).click();
      const command = await finite(committed.promise, 'actual committed contribution', 20_000);
      assert.equal(command.message.body, body);
      const original = await stageDraft(page, f, item);
      const pendingBefore = original.pending.find((entry) => entry.id === command.clientMessageId)!;
      assert.equal(pendingBefore.state, 'sending'); assert.equal(pendingBefore.body, body);
      await grant(f.manager, f.place.id, f.author, 'viewer');
      const refreshed = finite(page.waitForResponse((response) => response.request().method() === 'GET'
        && new URL(response.url()).pathname === detailPath(f, item) && response.status() === 200), 'actual viewer Details refresh', 20_000);
      // A real work event re-reads Details without reloading or abandoning the held request.
      expectStatus(await f.manager.browser.request('POST', projectWorkPath(f.place.id),
        { body: { title: 'A separate task refreshes current project authority', clientCommandId: randomUUID() } }), 201);
      assert.equal((await (await refreshed).json() as { access: string }).access, 'viewer');
      await panel(page).getByRole('textbox', { name: 'First message about this task', exact: true }).waitFor({ state: 'detached' });
      const pending = panel(page).locator('[data-client-message-id="' + command.clientMessageId + '"]');
      await pending.waitFor(); assert.equal(await pending.getAttribute('data-send-state'), 'sending');
      assert.equal(await pending.getByRole('button').count(), 0, 'a viewer cannot retry or remove through the task composer');
      assert.equal(await pending.getByRole('status').innerText(), 'Send not confirmed. Your message is kept. You cannot send to this task.');
      assert.equal(await pending.locator('..').getAttribute('aria-label'), 'Pending messages kept');
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), original, 'permission changes keep both private records');
      const stored = expectStatus(await f.author.browser.request('GET', taskDiscussionPath(item.id)), 200) as { root: ConversationMessage | null; messages: ConversationMessage[] };
      assert.equal(stored.root?.id, command.message.id); assert.deepEqual(stored.messages.map((message) => message.id), [command.message.id]);
      release.resolve(); await finite(settled.promise, 'committed answer settlement');
      if (failure) throw failure;
      await finite((async () => {
        while ((await storedDraft(page, draftKey(f, item))).pending.some((entry) => entry.id === command.clientMessageId))
          await page.waitForTimeout(100);
      })(), 'confirmed command leaves the private queue');
      const current = await storedDraft(page, draftKey(f, item));
      assert.deepEqual({ body: current.body, files: current.files, references: current.references, commandId: current.commandId },
        { body: original.body, files: original.files, references: original.references, commandId: original.commandId }, 'confirming the earlier send keeps the later staged draft');
      await grant(f.manager, f.place.id, f.author, 'contributor');
      await page.goto('/projects/' + f.place.id + '/tasks?open=work:' + item.id); await title(page, item).waitFor();
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), current, 'returning write access keeps the draft and does not restore a confirmed command');
      assert.deepEqual(writes, [command.clientMessageId], 'authority refresh, confirmation and reload never duplicate the saved send');
      const after = expectStatus(await f.author.browser.request('GET', taskDiscussionPath(item.id)), 200) as { messages: ConversationMessage[] };
      assert.deepEqual(after.messages.map((message) => message.id), [command.message.id]);
      assert.equal((await notices(f, item)).length, 1); assert.equal(await receipts(item), 0);
    });
  });
});

test('two accounts keep Conversation, Tasks, Map and Agents current after real Undo, with one retained notice history and private draft', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create();
  const sketch = expectStatus(await f.author.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/sketches`,
    { body: { title: 'Low-light measurement map', scope: 'project', projectId: f.place.id } }), 201) as { id: string };
  const mapBefore = expectStatus(await f.author.browser.request('GET', `/api/v1/sketches/${sketch.id}`), 200) as SketchDetail;
  const a = await signedIn(f.author); const b = await signedIn(f.manager);
  await withContexts([a, b], async () => {
    const pages: Page[] = [];
    for (const surface of ['conversations', 'tasks', `map/${sketch.id}`, 'agents']) pages.push(await open(a, f, item, surface));
    const peer = await open(b, f, item, 'tasks', false);
    assert.equal(await undoButton(peer).count(), 0, 'manager B is not the creator, its owner or its agent owner');
    expectStatus(await f.manager.browser.request('POST', taskCreationUndoPath(item.id),
      { body: { clientCommandId: randomUUID(), expectedVersion: item.version } }), 403);
    const original = await stageDraft(pages[0]!, f, item);
    const resultResponse = finite(pages[1]!.waitForResponse((response) => new URL(response.url()).pathname === taskCreationUndoPath(item.id) && response.request().method() === 'POST'), 'real UI Undo response', 15_000);
    await undoButton(pages[1]!).focus(); await pages[1]!.keyboard.press('Enter');
    const response = await resultResponse; assert.equal(response.status(), 200, await response.text());
    const result = await response.json() as UndoTaskCreationResult;
    // Every open Details, in every tab and account, re-reads on the project's stream event and turns read only.
    for (const page of [...pages, peer]) await reverted(page, item);
    assert.deepEqual(await storedDraft(pages[0]!, draftKey(f, item)), original, 'the private staged draft is kept');
    const list = expectStatus(await f.author.browser.request('GET', `/api/v1/projects/${f.place.id}/work`), 200) as { items: WorkItem[] };
    assert.ok(!list.items.some((entry) => entry.id === item.id), 'the active work list leaves it out');
    await pages[1]!.locator(`.tb-card[data-card-id="${item.id}"]`).waitFor({ state: 'detached' });
    await pages[3]!.evaluate(() => window.dispatchEvent(new Event('focus')));
    await finite((async () => { while (await pages[3]!.locator(`#agents-task option[value="${item.id}"]`).count()) await pages[3]!.waitForTimeout(100); })(), 'Agents task choice removed');
    const history = await notices(f, item); assert.equal(history.length, 2);
    const appended = history.find((notice) => notice.kind === 'task.creation_reverted')!;
    assert.equal(appended.id, result.noticeId); assert.equal(appended.createdBy.id, f.author.id);
    assert.equal(history.find((notice) => notice.kind === 'task.created')!.createdBy.kind, 'agent', 'the original creator stays the genuine agent');
    await pages[0]!.reload(); await title(pages[0]!, item).waitFor();
    for (const notice of history) {
      const row = pages[0]!.locator(`#notice-${notice.id}`); await row.waitFor();
      assert.equal(await row.locator('time').getAttribute('datetime'), notice.createdAt);
      assert.equal(notice.workNumber, item.number);
      assert.equal(await row.locator('.convo-notice__num').innerText(), `#${item.number}`);
      assert.equal(await row.getByRole('button', { name: `Open task #${item.number} ${item.title}`, exact: true }).count(), 1);
    }
    const undoNotice = pages[0]!.locator(`#notice-${appended.id}`);
    assert.equal(await undoNotice.locator('.convo-notice__meta strong').innerText(), 'Ari Task author · you');
    assert.equal(await undoNotice.locator('.convo-notice__kind').textContent(), 'Task creation undone · ');
    assert.equal(await undoNotice.getByRole('button').getAttribute('data-native-ref'), `work:${item.id}`);
    assert.equal(await receipts(item), 1);
    assert.deepEqual(expectStatus(await f.author.browser.request('GET', `/api/v1/sketches/${sketch.id}`), 200), mapBefore,
      'the map is unchanged; it never had a task node to remove');
    await pages[0]!.getByRole('button', { name: 'Close details', exact: true }).click();
    await pages[0]!.locator(`#notice-${appended.id}`).getByRole('button').click(); await reverted(pages[0]!, item);
  });
});

test('a stale Details action after another tab undid the task is refused without a second notice or receipt, and Refresh shows the history', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author, { disconnected: true });
  await withContexts([context], async () => {
    const page = await open(context, f, item); const original = await stageDraft(page, f, item);
    // No stream here: this tab still shows the Undo action when another tab undoes the task.
    const result = await f.undo(item);
    const refusal = finite(page.waitForResponse((response) => new URL(response.url()).pathname === taskCreationUndoPath(item.id) && response.request().method() === 'POST'), 'stale Undo response', 15_000);
    await undoButton(page).click(); assert.equal((await refusal).status(), 409);
    await panel(page).getByRole('alert').filter({ hasText: 'changed or been used' }).waitFor();
    assert.equal(await receipts(item), 1); assert.equal((await notices(f, item)).length, 2);
    assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);
    await panel(page).getByRole('button', { name: 'Refresh details', exact: true }).click();
    await reverted(page, item);
    assert.equal((await f.read(item.id)).version, result.work.version);
    assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);
  });
});

test('real sign-out and account switch reject a held old-account read and keep the new account draft isolated', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author);
  await withContexts([context], async () => {
    const page = await open(context, f, item); await stageDraft(page, f, item);
    const late = await holdRead(page, detailPath(f, item));
    try {
      // A real project work event (another task) re-reads the open Details; that read is held across the account switch.
      await f.create('A second task that only triggers a re-read');
      await late.held; late.retire();
      await page.goto('/sign-out'); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
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
      assert.equal(await page.evaluate((value) => localStorage.getItem(value) ?? sessionStorage.getItem(value), draftKey(f, item)), null,
        'a confirmed sign-out retires the previous account drafts');
      assert.equal(await undoButton(page).count(), 0, 'the old account read gives the new account no Undo action');
      assert.equal(await receipts(item), 0);
    } finally { late.retire(); await late.finish(); }
  });
});

test('a current grant change refuses a pending Undo with the private staged text and files kept', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author, { disconnected: true });
  await withContexts([context], async () => {
    const page = await open(context, f, item); const original = await stageDraft(page, f, item);
    const pending = await holdUndo(page, item);
    try {
      await undoButton(page).click(); await pending.held;
      await grant(f.manager, f.place.id, f.author, 'viewer'); pending.release(); assert.equal((await pending.forwarded).status, 403);
      await panel(page).getByRole('alert').filter({ hasText: 'not change it' }).waitFor();
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);
      await panel(page).getByRole('button', { name: 'Refresh details', exact: true }).click();
      await finite((async () => { while (await undoButton(page).count()) await page.waitForTimeout(100); })(), 'Undo action retired');
      assert.equal(await panel(page).getByRole('textbox').count(), 0, 'a viewer has no composer');
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);
      assert.equal((await f.read(item.id)).lifecycle?.state, 'active'); assert.equal(await receipts(item), 0);
    } finally { await pending.finish(); }
  });
});

test('pending Undo disables its action and a lost real response retries the exact committed UUID and receipt without a new notice', { timeout: 120_000 }, async () => {
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
      await panel(page).getByRole('alert').filter({ hasText: 'Flux could not be reached' }).waitFor();
      assert.equal(await undoButton(page).isDisabled(), false); assert.deepEqual(await storedDraft(page, draftKey(f, item)), draft);
      const before = (await pool.query('SELECT count(*)::int AS n FROM events WHERE object_id=$1', [f.place.id])).rows[0].n;
      const replayPromise = finite(page.waitForResponse((response) => new URL(response.url()).pathname === taskCreationUndoPath(item.id) && response.request().method() === 'POST'), 'real exact UUID replay', 15_000);
      await undoButton(page).click(); const replay = await replayPromise;
      assert.equal(replay.request().postDataJSON().clientCommandId, outgoing.clientCommandId); assert.equal(replay.status(), 200);
      assert.deepEqual(await replay.json(), result); await reverted(page, item);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM events WHERE object_id=$1', [f.place.id])).rows[0].n, before, 'the replay records no event');
      assert.equal(await receipts(item), 1); assert.equal((await notices(f, item)).length, 2);
      assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), identity), null);
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), draft);
    } finally { await command.finish(); }
  });
});

test('a first use that commits while Undo is pending wins; the refusal keeps the draft and Refresh shows the real root', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const context = await signedIn(f.author, { disconnected: true });
  await withContexts([context], async () => {
    const page = await open(context, f, item); const original = await stageDraft(page, f, item);
    const command = await holdUndo(page, item);
    try {
      await undoButton(page).click(); await command.held;
      const root = expectStatus(await f.manager.browser.request('POST', taskDiscussionPath(item.id),
        { body: { body: 'Blair measured the first actual trial.', clientMessageId: randomUUID(), kind: 'text' } }), 201) as ConversationMessage;
      command.release(); const refusal = await command.forwarded; assert.equal(refusal.status, 409);
      await panel(page).getByRole('alert').filter({ hasText: 'changed or been used' }).waitFor();
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);
      const stored = await f.read(item.id);
      assert.equal(stored.lifecycle?.state, 'active'); assert.deepEqual(stored.creationUndo, { eligible: false, reason: 'task_used' });
      assert.equal(await receipts(item), 0); assert.equal((await notices(f, item)).length, 1);
      await panel(page).getByRole('button', { name: 'Refresh details', exact: true }).click();
      await panel(page).getByText(root.body, { exact: true }).waitFor();
      assert.equal(await undoButton(page).count(), 0);
      assert.deepEqual(await storedDraft(page, draftKey(f, item)), original);
    } finally { await command.finish(); }
  });
});

test('desktop and phone-width history render readable actor and time, keyboard links and no horizontal overflow on realistic content', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create('Measure the gesture lamp under dim light before changing the sensor');
  const result = await f.undo(item); const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
  const life = result.work.lifecycle; assert.ok(life?.state === 'creation_reverted');
  for (const [width, height] of [[1280, 900], [390, 844]]) {
    const context = await signedIn(f.author, { width, height });
    await withContexts([context], async () => {
      const page = await context.newPage(); page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`/projects/${f.place.id}?open=work:${item.id}`); await reverted(page, item);
      assert.match(await panel(page).innerText(), /Creation undone by Ari Task author on/);
      assert.equal(await panel(page).locator('.wd-criteria li').count(), 2);
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
      if (evidence) await notice.screenshot({ path: join(evidence, `task-undo-notice-${width}.png`) });
      const historyLink = notice.getByRole('button', { name: `Open task #${item.number} ${item.title}`, exact: true });
      await historyLink.focus(); await page.keyboard.press('Enter'); await reverted(page, item);
      if (evidence) await page.screenshot({ path: join(evidence, `task-undo-keyboard-history-${width}.png`), fullPage: true });
    });
  }
});

test('Agents, Map and live work never offer a task whose creation was undone, while its link still opens as history', { timeout: 120_000 }, async () => {
  const f = await fixture(); const item = await f.create(); const kept = await f.create('Keep the second sensor in the plan');
  const sketch = expectStatus(await f.author.browser.request('POST', `/api/v1/workspaces/${f.ws.id}/sketches`,
    { body: { title: 'Sensor map', scope: 'project', projectId: f.place.id } }), 201) as { id: string };
  await f.undo(item);
  const context = await signedIn(f.author);
  await withContexts([context], async () => {
    const page = await context.newPage(); page.on('pageerror', (error) => pageErrors.push(error.message));
    // Agents: a ?task= naming the undone task does not open it as a thread; the open task list leaves it out.
    await page.goto(`/projects/${f.place.id}/agents?task=${item.id}`);
    const select = page.locator('#agents-task'); await select.waitFor();
    assert.equal(await select.locator(`option[value="${item.id}"]`).count(), 0);
    assert.equal(await select.inputValue(), kept.id);
    // Map: the map surface has no live or task action on it; the Details link still opens read-only history.
    await page.goto(`/projects/${f.place.id}/map/${sketch.id}?open=work:${item.id}`); await reverted(page, item);
    // Live: the work anchor of an undone task is refused by the server, so no session can start on it.
    const started = await context.request.post(LIVE_SESSIONS_PATH, { data: { context: { type: 'work', id: item.id }, clientSessionId: randomUUID() },
      headers: { origin: origin.origin }, timeout: 15_000 });
    assert.notEqual(started.status(), 201, await started.text());
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM live_sessions WHERE work_id=$1', [item.id])).rows[0].n, 0);
    const stored = (await pool.query('SELECT first_persisted_use_at,creation_reverted_at FROM project_work_items WHERE id=$1', [item.id])).rows[0];
    assert.equal(stored.first_persisted_use_at, null); assert.ok(stored.creation_reverted_at);
  });
});
