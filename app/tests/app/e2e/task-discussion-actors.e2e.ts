import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Route } from 'playwright';
import { taskDiscussionPath, type ConversationMessage, type WorkItem } from '@flux/contracts';
import { workUseCases } from '../../../apps/server/src/work/adapters.js';
import { taskDiscussionUseCases } from '../../../apps/server/src/work/task-discussions.js';
import { db, pool } from '../support/db.js';
import { addMember, expectStatus, grant, password, person, project, workspace, type Person } from '../support/people.js';

// Genuine trusted core agent writes plus real authenticated Chromium rendering/replies.
// This does not certify an external MCP client or built-in instruction activation.
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const origin = new URL(process.env.FLUX_PUBLIC_ORIGIN!);
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
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
async function fixturePhase<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Actor fixture timed out: ${phase}`)), 15_000);
    timer.unref();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
async function closeFixtureContexts(phase: string): Promise<void> {
  const closing = contexts.splice(0);
  const outcomes = await Promise.allSettled(closing.map((context) => fixturePhase(context.close(), phase)));
  const failures: unknown[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      contexts.push(closing[index]);
      failures.push(outcome.reason);
    }
  });
  if (failures.length) throw new AggregateError(failures, `Actor fixture failed: ${phase}`);
}
before(async () => {
  await new Promise<void>((resolve) => proxy.listen(Number(origin.port || 80), origin.hostname, resolve));
  browser = await chromium.launch();
});
afterEach(async () => {
  // A preceding journey's live pages and fixture routes must not survive into another one.
  await closeFixtureContexts('context cleanup');
});
after(async () => {
  const failures: unknown[] = [];
  try { await closeFixtureContexts('final context cleanup'); } catch (cause) { failures.push(cause); }
  try { await fixturePhase(browser?.close() ?? Promise.resolve(), 'browser cleanup'); } catch (cause) { failures.push(cause); }
  proxy.closeAllConnections();
  try {
    await fixturePhase(new Promise<void>((resolve) => proxy.close(() => resolve())), 'proxy cleanup');
  } catch (cause) { failures.push(cause); }
  if (failures.length) throw new AggregateError(failures, 'Actor fixture final cleanup failed');
});

async function signedIn(who: Person, width: number, touch = false) {
  const context = await browser.newContext({ baseURL: origin.origin, viewport: { width, height: 900 },
    isMobile: touch, hasTouch: touch, serviceWorkers: 'block' });
  contexts.push(context);
  const signed = await context.request.post('/api/auth/sign-in/email', {
    data: { email: who.email, password }, headers: { origin: origin.origin },
  });
  assert.equal(signed.status(), 200, await signed.text());
  return context;
}


function isFinishedFixtureRoute(cause: unknown): boolean {
  // Playwright can finish/continue a superseded route before its fixture response is fulfilled.
  // This public handled-route error does not always populate Request.failure(); no network
  // cancellation reason is inferred. Fetch/JSON/other fulfillment failures still throw.
  return cause instanceof Error && cause.message.includes('route.fulfill: Route is already handled!');
}

/** F-026: people and agents keep a 32px face in the same column on every viewport. */
async function assertAuthorColumn(row: Locator, width: number) {
  await row.waitFor();
  const geometry = await row.evaluate((el) => {
    const face = el.querySelector<HTMLElement>(':scope > :is(.ui-avatar, .author-face), :scope > .thread__root-meta > :is(.ui-avatar, .author-face)')!;
    const meta = el.querySelector<HTMLElement>('.project-convo__message-meta, .thread__root-meta, .convo-notice__meta, .agents-msg__meta')!;
    const r = el.getBoundingClientRect();
    const f = face.getBoundingClientRect();
    const m = meta.getBoundingClientRect();
    return { display: getComputedStyle(face).display,
      rowX: r.x, faceX: f.x, faceRight: f.right, faceWidth: f.width, faceHeight: f.height,
      metaX: m.x, direction: getComputedStyle(meta).flexDirection };
  });
  assert.notEqual(geometry.display, 'none', 'the phone retains the full author avatar');
  assert.ok(Math.abs(geometry.faceWidth - 32) <= 0.01 && Math.abs(geometry.faceHeight - 32) <= 0.01,
    'both author shapes have the required 32px size');
  assert.ok(Math.abs(geometry.faceX - geometry.rowX) <= 1, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.metaX - geometry.faceRight - (width <= 680 ? 10 : 12)) <= 1,
    'the author name follows the common face column and required gap');
  assert.equal(geometry.direction, 'row', 'own authors keep the same order');
}

async function captureVisibleAuthor(page: Page, row: Locator, name: string, evidence: string | undefined) {
  const meta = row.locator('.project-convo__message-meta, .convo-notice__meta');
  await meta.scrollIntoViewIfNeeded();
  if (await page.evaluate(() => matchMedia('(hover: hover)').matches)) await meta.hover();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.effect?.getTiming().iterations === Infinity || (!animation.pending && animation.playState !== 'running')));
  const inspect = () => row.evaluate((element) => {
    const label = element.querySelector<HTMLElement>('.agent-for, .convo-notice__meta strong')!;
    const meta = element.querySelector<HTMLElement>('.project-convo__message-meta, .convo-notice__meta')!;
    const face = element.querySelector<HTMLElement>(':scope > :is(.ui-avatar, .author-face)')!;
    const parts = [];
    const authorName = meta.querySelector<HTMLElement>('.agent-id__name, :scope > strong')!;
    const tag = meta.querySelector<HTMLElement>('.agent-tag');
    const identities = [['label', label], ['meta', meta], ['face', face], ['name', authorName]] as const;
    const targets = [...identities, ...(tag ? [['tag', tag] as const] : [])];
    for (const [name, part] of targets) {
      const ancestors = [];
      for (let node: HTMLElement | null = part; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        ancestors.push({ opacity: Number(style.opacity), display: style.display,
          visibility: style.visibility, hidden: node.hidden, inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') });
      }
      const r = part.getBoundingClientRect();
      const points = [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]];
      const uncovered = points.every(([x, y]) => {
        const hit = document.elementFromPoint(r.x + r.width * x, r.y + r.height * y);
        return !!hit && (hit === part || part.contains(hit));
      });
      parts.push({ name, x: r.x, y: r.y, width: r.width, height: r.height, ancestors,
        inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        uncovered });
    }
    return { text: label.innerText, parts };
  });
  const samples = [];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const sample = await inspect();
    assert.ok(sample.parts.every((part) => part.width > 0 && part.height > 0 && part.inViewport && part.uncovered),
      `${name}: the actual full author and face are in the viewport and uncovered`);
    assert.ok(sample.parts.every((part) => part.ancestors.every((a, index) => a.opacity === 1 && a.display !== 'none'
      && a.visibility === 'visible' && !a.hidden && !a.inert
      && (a.ariaHidden !== 'true' || (part.name === 'face' && index === 0)))),
    `${name}: visible identity has no hidden ancestor; only the decorative face itself may be aria-hidden`);
    samples.push(sample);
  }
  assert.deepEqual(samples[1], samples[0], `${name}: visible identity is stable over rendered frames`);
  assert.deepEqual(samples[2], samples[1], `${name}: visible identity remains stable over rendered frames`);
  if (evidence) {
    await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
    const after = await inspect();
    assert.deepEqual(after, samples[2], `${name}: the author stays visible throughout the raw capture`);
    writeFileSync(join(evidence, `${name}-visibility.json`), JSON.stringify({ before: samples[2], after }, null, 2));
  }
}

test('agent root renders without a human DM link, real human reply persists, and readers retain genuine history',
  { timeout: 90_000 }, async () => {
    const [owner, reader] = await Promise.all(['Casey Human', 'Lee Reader'].map(person));
    const ws = await workspace(owner, 'Actual task authors');
    await addMember(owner, ws.id, reader, 'member');
    const place = await project(owner, ws.id, 'Measured trial', 'restricted');
    await grant(owner, place.id, reader, 'viewer');
    const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
      body: { title: 'Inspect the actual trial', clientCommandId: randomUUID() },
    }), 201) as WorkItem;
    const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, {
      body: { name: 'Trial analyst', owner: 'self' },
    }), 201) as { id: string };
    const access = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, {
      body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' },
    }), 201) as { id: string };
    const actor = { kind: 'agent' as const, id: agent.id };
    const command = { body: 'The measured result needs a human counterexample.', clientMessageId: randomUUID() };
    const root = await taskDiscussionUseCases(db).contribute(actor, task.id, command);
    const stored = (await pool.query('SELECT * FROM project_messages WHERE id=$1', [root.id])).rows[0];
    const context = await signedIn(owner, 1280);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const path = `/projects/${place.id}/conversations/${root.conversationId}`;
    await page.goto(path);
    const row = page.locator(`#message-${root.id}`);
    await row.waitFor();
    await assertAuthorColumn(row, 1280);
    assert.match(await row.innerText(), /Trial analyst\s*Agent/);
    assert.equal(await row.locator('.kreska').count() > 0, true, 'an agent author is Kreska, never initials (#339)');
    assert.equal(await row.locator('a[href*="/dm/new"]').count(), 0);
    assert.equal(await row.locator('.project-convo__message-meta time').getAttribute('datetime'), root.createdAt);
    // One project conversation (UI116-1): the root is in the stream, its replies and reply box in the thread beside it.
    const audience = page.locator('#thread .project-convo__composer .composer__audience').filter({ hasText: '1 agent' });
    await audience.waitFor();
    assert.doesNotMatch(await audience.innerText(), /Only you|only you two/);
    // The thread starts with an agent, so the composer must not name a person who is not in the visible thread.
    const composer = page.getByRole('textbox', { name: 'Reply', exact: true });
    assert.equal(await composer.getAttribute('placeholder'), 'Reply in this conversation…');
    await composer.fill('I checked the trial: the counterexample is real.');
    const savedReply = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === taskDiscussionPath(task.id));
    await page.getByRole('button', { name: 'Send reply', exact: true }).click();
    const replyResponse = await savedReply;
    assert.equal(replyResponse.status(), 201, await replyResponse.text());
    const humanCommand = replyResponse.request().postDataJSON();
    assert.equal(humanCommand.kind, 'text');
    assert.equal(humanCommand.body, 'I checked the trial: the counterexample is real.');
    assert.match(humanCommand.clientMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const receipt = await replyResponse.json() as ConversationMessage;
    await assertAuthorColumn(page.locator(`#message-${receipt.id}`), 1280);
    await page.getByText('I checked the trial: the counterexample is real.', { exact: true }).waitFor();
    const read = expectStatus(await owner.browser.request('GET', `/api/v1/conversations/${root.conversationId}`), 200) as { messages: ConversationMessage[] };
    const human = read.messages[1]!;
    assert.equal(read.messages.length, 2);
    assert.deepEqual(human, receipt);
    assert.equal(human.authorId, owner.id);
    assert.equal(Object.hasOwn(human, 'author'), false);
    assert.deepEqual(expectStatus(await owner.browser.request('POST', taskDiscussionPath(task.id), {
      body: humanCommand,
    }), 201), receipt);
    const replayed = expectStatus(await owner.browser.request('GET', `/api/v1/conversations/${root.conversationId}`), 200) as { messages: ConversationMessage[] };
    assert.deepEqual(replayed.messages, read.messages);
    assert.deepEqual(await taskDiscussionUseCases(db).contribute(actor, task.id, command), root);
    await page.reload();
    await row.waitFor();
    assert.equal(await page.locator(`#message-${root.id}`).count(), 1);
    const opening = page.locator(`#thread-root-${root.id}`);
    await assertAuthorColumn(opening, 1280);
    await opening.locator('.agent-for').filter({ hasText: 'for Casey Human' }).waitFor();
    const notice = page.locator(`.convo-notice[data-work-id="${task.id}"]`);
    await assertAuthorColumn(notice, 1280);
    assert.equal(await notice.locator('.convo-notice__meta strong').innerText(), 'Casey Human · you');
    const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
    if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'agent-root-desktop.png'), fullPage: true }); }
    expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${place.id}/grants/${access.id}`), 204);
    for (const width of [1280, 390]) {
      const readerContext = await signedIn(reader, width);
      const view = await readerContext.newPage();
      view.on('pageerror', (error) => errors.push(error.message));
      await view.goto(path);
      const agentRow = view.locator(`#message-${root.id}`);
      await agentRow.waitFor();
      await assertAuthorColumn(agentRow, width);
      await agentRow.locator('.agent-for').filter({ hasText: 'for Casey Human' }).waitFor();
      assert.match(await agentRow.innerText(), /Trial analyst\s*Agent/);
      assert.equal(await agentRow.locator('a[href*="/dm/new"]').count(), 0);
      const humanRow = view.locator(`#message-${human.id}`);
      await humanRow.waitFor();
      await assertAuthorColumn(humanRow, width);
      assert.equal(await humanRow.locator(`a[href$="with=${owner.id}"]`).count(), 1);
      const thread = view.locator('#thread');
      await assertAuthorColumn(thread.locator(`#thread-root-${root.id}`), width);
      await thread.locator('.thread__root .agent-for').filter({ hasText: 'for Casey Human' }).waitFor();
      await thread.getByText('You have read access to this project.', { exact: true }).waitFor();
      assert.equal(await view.getByRole('textbox', { name: 'Reply', exact: true }).count(), 0);
      assert.equal(await view.getByRole('button', { name: 'Send reply', exact: true }).count(), 0);
      const sources = thread.getByRole('button', { name: 'Sources', exact: true });
      await sources.focus();
      await sources.press('Enter');
      await view.getByRole('heading', { name: `Sources · saved for ${place.name}`, exact: true }).waitFor();
      assert.equal(await view.getByRole('button', { name: 'Add material', exact: true }).count(), 0);
      await view.getByRole('button', { name: 'Close sources', exact: true }).click();
      expectStatus(await reader.browser.request('POST', `/api/v1/conversations/${root.conversationId}/messages`, {
        body: { body: 'This viewer cannot publish.', clientMessageId: randomUUID() },
      }), 403);
      expectStatus(await reader.browser.request('POST', taskDiscussionPath(task.id), {
        body: { body: 'This viewer cannot publish to the canonical task.', clientMessageId: randomUUID(), kind: 'text' },
      }), 403);
      if (evidence) await view.screenshot({ path: join(evidence, `mixed-authors-reader-${width}.png`), fullPage: true });
      if (width === 390) {
        await view.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        await assertAuthorColumn(humanRow, width);
        await assertAuthorColumn(thread.locator(`#thread-root-${root.id}`), width);
        assert.equal(await view.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0,
          'full author names and faces fit the phone at enlarged text');
        if (evidence) await view.screenshot({ path: join(evidence, 'mixed-authors-reader-390-text200.png'), fullPage: true });
        await view.getByRole('button', { name: 'Close replies', exact: true }).click();
        await view.locator('#thread').waitFor({ state: 'detached' });
        await assertAuthorColumn(agentRow, width);
        await captureVisibleAuthor(view, agentRow, 'agent-owner-reader-390-text200', evidence);
        const event = view.locator(`.convo-notice[data-work-id="${task.id}"]`);
        await assertAuthorColumn(event, width);
        assert.equal(await event.locator('.convo-notice__meta strong').innerText(), 'Casey Human');
        await captureVisibleAuthor(view, event, 'task-event-reader-390-text200', evidence);
      }
    }
    assert.deepEqual((await pool.query('SELECT * FROM project_messages WHERE id=$1', [root.id])).rows[0], stored);
    const workspaceAgent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, {
      body: { name: 'Workspace analyst', owner: 'workspace' },
    }), 201) as { id: string };
    const workspaceActor = { kind: 'agent' as const, id: workspaceAgent.id };
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, {
      body: { principal: workspaceActor, role: 'contributor' },
    }), 201);
    const workspaceTask = await workUseCases(db).createWork(workspaceActor, place.id, { title: 'Check the workspace trial' });
    const workspaceRoot = await taskDiscussionUseCases(db).contribute(workspaceActor, workspaceTask.id, {
      body: 'The workspace agent recorded this observation.', clientMessageId: randomUUID(),
    });
    for (const touch of [false, true]) {
      const workspaceContext = await signedIn(reader, 390, touch);
      const workspaceView = await workspaceContext.newPage();
      workspaceView.on('pageerror', (error) => errors.push(error.message));
      await workspaceView.emulateMedia({ colorScheme: 'dark' });
      await workspaceView.goto(`/projects/${place.id}/conversations/${workspaceRoot.conversationId}`);
      assert.equal(await workspaceView.evaluate(() => matchMedia('(pointer: coarse)').matches), touch,
        'both the actual narrow mouse window and touch-emulated phone are exercised');
      await workspaceView.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await workspaceView.getByRole('button', { name: 'Close replies', exact: true }).click();
      await workspaceView.locator('#thread').waitFor({ state: 'detached' });
      const workspaceEvent = workspaceView.locator(`.convo-notice[data-work-id="${workspaceTask.id}"]`);
      await assertAuthorColumn(workspaceEvent, 390);
      await workspaceEvent.locator('.agent-for').filter({ hasText: 'for the workspace' }).waitFor();
      assert.match(await workspaceEvent.innerText(), /Workspace analyst\s*Agent/);
      await captureVisibleAuthor(workspaceView, workspaceEvent, `workspace-agent-event-390-dark-text200${touch ? '-touch' : ''}`, evidence);
      const workspaceRow = workspaceView.locator(`#message-${workspaceRoot.id}`);
      await assertAuthorColumn(workspaceRow, 390);
      await workspaceRow.locator('.agent-for').filter({ hasText: 'for the workspace' }).waitFor();
      assert.equal(await workspaceRow.locator('a[href*="/dm/new"]').count(), 0);
      assert.equal(await workspaceView.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
      await captureVisibleAuthor(workspaceView, workspaceRow, `workspace-agent-author-390-dark-text200${touch ? '-touch' : ''}`, evidence);
    }
    assert.deepEqual(errors, []);
  });


test('native agent owners retry failed reads, fence stale permission answers and survive same-tab account changes',
  { timeout: 90_000 }, async () => {
    const [owner, guest] = await Promise.all(['Scoped Casey', 'Scoped Guest'].map(person));
    const ws = await workspace(owner, 'Owner projection');
    await addMember(owner, ws.id, guest, 'guest');
    const place = await project(owner, ws.id, 'Owner scope', 'restricted');
    await grant(owner, place.id, guest, 'viewer');
    const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, {
      body: { name: 'Scoped analyst', owner: 'self' },
    }), 201) as { id: string };
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, {
      body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' },
    }), 201);
    const work = workUseCases(db);
    const actor = { kind: 'agent' as const, id: agent.id };
    const task = await work.createWork({ kind: 'human', id: owner.id }, place.id, { title: 'Scoped owner task', owner: actor });
    const proposal = await work.proposeDecision(actor, place.id, { title: 'Scoped agent decision', rationale: 'Measured by an actual authorized actor' });
    await taskDiscussionUseCases(db).contribute(actor, task.id, { body: 'Current scoped agent reply', clientMessageId: randomUUID() });
    const elsewhere = await project(owner, ws.id, 'Other owner scope', 'restricted');
    await grant(owner, elsewhere.id, guest, 'viewer');
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${elsewhere.id}/grants`, {
      body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' },
    }), 201);
    const otherTask = await work.createWork({ kind: 'human', id: owner.id }, elsewhere.id, { title: 'Other scoped task', owner: actor });
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${elsewhere.id}/grants`, {
      body: { principal: { kind: 'agent', id: agent.id }, role: 'denied' },
    }), 201);
    const context = await signedIn(owner, 1440);
    const page = await context.newPage();
    const capture = async (name: string, ownerSelector: string) => {
      // A route may still be settling after a fast input. Wait for real animation completion;
      // do not disable production motion or accept a DOM label hidden by a leaving panel.
      await page.waitForFunction(() => document.getAnimations().every((animation) =>
        animation.effect?.getTiming().iterations === Infinity || (!animation.pending && animation.playState !== 'running')));
      const inspect = () => page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(selector)].map((label) => {
        const rect = label.getBoundingClientRect();
        const ancestors = [];
        for (let node: HTMLElement | null = label; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          ancestors.push({ tag: node.tagName, className: node.className, display: style.display,
            visibility: style.visibility, opacity: Number(style.opacity), hidden: node.hidden,
            inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') });
        }
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        // The board's transparent stretched task button owns hits over its metadata.
        // Accept that same card/row hit surface, but reject a different overlay or panel.
        const surface = label.closest('.tb-card, .ws-item, .wd-discussion, .details, .agents-msg');
        return { text: label.innerText, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          inViewport: rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          uncovered: !!hit && (hit === label || label.contains(hit) || !!surface?.contains(hit)),
          hitTarget: hit ? { tag: hit.tagName, className: hit.className } : null, ancestors };
      }), ownerSelector);
      await page.locator(ownerSelector).first().waitFor();
      // Three rendered frames must show the same full ownership relation and geometry.
      const samples = [];
      for (let frame = 0; frame < 3; frame++) {
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        samples.push(await inspect());
      }
      for (const labels of samples) {
        assert.ok(labels.length > 0, `${name}: an actual owner label is rendered`);
        for (const label of labels) {
          assert.equal(label.text, 'for Scoped Casey');
          assert.ok(label.rect.width > 0 && label.rect.height > 0 && label.inViewport && label.uncovered, `${name}: owner is visibly drawn and uncovered`);
          assert.ok(label.ancestors.every((node) => node.display !== 'none' && node.visibility === 'visible' && node.opacity >= .999
            && !node.hidden && !node.inert && node.ariaHidden !== 'true'), `${name}: every owner ancestor is visible at full opacity`);
        }
      }
      assert.deepEqual(samples[1], samples[0], `${name}: settled layout`);
      assert.deepEqual(samples[2], samples[1], `${name}: settled layout`);
      const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `339-${name}.png`), fullPage: true });
        const after = await inspect();
        assert.deepEqual(after, samples[2], `${name}: owner remains visible throughout the raw capture`);
        writeFileSync(join(evidence, `339-${name}-visibility.json`), JSON.stringify({ url: page.url(), before: samples[2], after }, null, 2));
      }
    };
    const endpoint = `**/api/v1/projects/${place.id}/people`;
    await page.route(endpoint, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"TEMPORARY_UNAVAILABLE"}' }));
    await page.goto(`/projects/${place.id}/tasks?view=board`);
    const card = page.locator(`[data-card-id="${task.id}"]`);
    await card.waitFor();
    assert.equal(await card.locator('.agent-for').count(), 0, 'failed owner reads show no obsolete relation');
    await page.unrouteAll({ behavior: 'wait' });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await card.locator('.agent-for').waitFor();
    assert.equal(await card.locator('.agent-for').innerText(), 'for Scoped Casey', '503 was not cached');
    await capture('scoped-owner-board', '.tb-card__owner .agent-for');
    await page.getByRole('radio', { name: 'List', exact: true }).click();
    const row = page.locator(`[data-work-id="${task.id}"]`);
    await row.locator('.agent-for').waitFor();
    assert.equal(await row.locator('.agent-tag').innerText(), 'Agent');
    assert.equal(await row.locator('.ws-av').count(), 0);
    const decision = page.locator(`[data-work-id="${proposal.id}"]`);
    await decision.locator('.agent-for').waitFor();
    assert.equal(await decision.locator('.agent-tag').innerText(), 'Agent');
    assert.equal((await decision.innerText()).includes('(agent)'), false);
    await capture('scoped-owner-list', '.ws-item .agent-for');
    await row.getByRole('button').click();
    await page.locator('.wd-discussion .agent-for').waitFor();
    assert.equal(await page.locator('.wd-discussion .agent-tag').innerText(), 'Agent');
    assert.equal(await page.locator('.wd-discussion .agent-for').innerText(), 'for Scoped Casey');
    await capture('scoped-owner-task-details', '.wd-discussion .agent-for');
    await page.keyboard.press('Escape');
    await page.locator('#details').waitFor({ state: 'detached' });
    await decision.getByRole('button').click();
    await page.locator('.details .agent-for').waitFor();
    assert.equal(await page.locator('.details .agent-for').innerText(), 'for Scoped Casey');
    await capture('scoped-owner-decision-details', '.details .agent-for');
    await page.keyboard.press('Escape');
    await page.locator('#details').waitFor({ state: 'detached' });
    await page.locator(`a[href^="/projects/${place.id}/agents"]`).click();
    await page.getByLabel('Task', { exact: true }).selectOption(task.id);
    await page.waitForURL((url) => url.pathname === `/projects/${place.id}/agents` && url.searchParams.get('task') === task.id);
    await page.locator('#details').waitFor({ state: 'detached' });
    await page.locator('.agents-msg__meta .agent-for').waitFor();
    assert.equal(await page.locator('.agents-msg__meta .agent-for').innerText(), 'for Scoped Casey');
    await assertAuthorColumn(page.locator('.agents-msg').first(), 1440);
    const messageBody = await page.locator('.agents-msg__body').first().boundingBox();
    const messageMeta = await page.locator('.agents-msg__meta').first().boundingBox();
    assert.ok(messageBody && messageMeta && Math.abs(messageBody.x - messageMeta.x) <= 1,
      'the actual Agents reply starts in its author content column');
    await capture('scoped-owner-agents-thread', '.agents-msg__meta .agent-for');
    await page.locator(`a[data-tab="tasks"][href^="/projects/${place.id}/tasks"]`).click();
    await page.getByRole('radio', { name: 'List', exact: true }).click();
    await row.locator('.agent-for').waitFor();
    // The same workspace has a second project with different agent rights. A workspace-keyed
    // owner cache would wrongly reuse the first project's authorized name here.
    await page.getByRole('link', { name: 'Other owner scope', exact: true }).click();
    await page.locator(`a[data-tab="tasks"][href^="/projects/${elsewhere.id}/tasks"]`).click();
    await page.getByRole('radio', { name: 'Kanban', exact: true }).click();
    await page.locator(`[data-card-id="${otherTask.id}"]`).waitFor();
    assert.equal(await page.locator(`[data-card-id="${otherTask.id}"] .agent-for`).count(), 0);
    await page.getByRole('link', { name: 'Owner scope', exact: true }).click();
    await page.locator(`a[data-tab="tasks"][href^="/projects/${place.id}/tasks"]`).click();
    await page.getByRole('radio', { name: 'List', exact: true }).click();
    await row.locator('.agent-for').waitFor();
    // A response completed under old authority is held while a real grant changes. The stream
    // must fence the held response as well as clear the current label.
    let release!: () => void;
    let held!: () => void;
    const gotHeld = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let currentRead!: () => void;
    const gotCurrentRead = new Promise<void>((resolve) => { currentRead = resolve; });
    let heldDone!: () => void;
    const gotHeldDone = new Promise<void>((resolve) => { heldDone = resolve; });
    let once = true;
    const pendingHandlers = new Set<Promise<void>>();
    const handlerFailures: unknown[] = [];
    const handlePeople = async (route: Route) => {
      if (!once) {
        const response = await route.fetch();
        assert.equal(response.status(), 200, 'the current authorized people read succeeds');
        const people = await response.json() as { id: string }[];
        try {
          await route.fulfill({ response });
        } catch (cause) {
          // The production scope fence can abort a superseded request while its fixture fetch finishes.
          // Only an already-finished fixture route is expected; every other handler error still fails.
          if (!isFinishedFixtureRoute(cause)) throw cause;
          return;
        }
        if (!people.some((person) => person.id === agent.id)) currentRead();
        return;
      }
      once = false;
      const response = await route.fetch();
      const originalPeople = await response.json() as { id: string }[];
      assert.ok(originalPeople.some((person) => person.id === agent.id), 'the held wire answer was genuinely authorized before the deny');
      held();
      await gate;
      try {
        await route.fulfill({ response });
      } catch (cause) {
        if (!isFinishedFixtureRoute(cause)) throw cause;
      }
      heldDone();
    };
    const peopleHandler = (route: Route) => {
      const pending = handlePeople(route);
      pendingHandlers.add(pending);
      void pending.then(() => pendingHandlers.delete(pending), (cause: unknown) => {
        handlerFailures.push(cause);
        pendingHandlers.delete(pending);
      });
      return pending;
    };
    await page.route(endpoint, peopleHandler);
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await fixturePhase(gotHeld, 'authorized answer held');
      expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, {
        body: { principal: { kind: 'agent', id: agent.id }, role: 'denied' },
      }), 201);
      await page.waitForFunction((id) => !document.querySelector(`[data-work-id="${id}"] .agent-for`), task.id);
      await fixturePhase(gotCurrentRead, 'delivered current answer without agent');
      release();
      await fixturePhase(gotHeldDone, 'held answer handler finished');
      // Remove this fixture only after releasing its old real answer. Drain every actual
      // callback explicitly instead of waiting on Playwright's separate internal route latch.
      await fixturePhase(page.unroute(endpoint, peopleHandler), 'people fixture removed');
      const outcomes = await fixturePhase(Promise.allSettled([...pendingHandlers]), 'people callbacks drained');
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected' && !handlerFailures.includes(outcome.reason)) handlerFailures.push(outcome.reason);
      }
      if (handlerFailures.length) throw new AggregateError(handlerFailures, 'People fixture callbacks failed');
    } finally {
      // A failed assertion must still release the real old answer before context cleanup.
      release();
    }
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction((id) => !document.querySelector(`[data-work-id="${id}"] .agent-for`), task.id);
    assert.equal(await row.locator('.agent-for').count(), 0, 'an old authorized response cannot reintroduce the relation');
    // The same live document signs into a guest account after permissions changed.
    await page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; });
    await page.getByRole('button', { name: /Scoped Casey.*account and sign out/ }).click();
    await page.getByRole('dialog', { name: 'Account', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('heading', { name: 'Sign in to Flux' }).waitFor();
    await page.getByLabel('Email').fill(guest.email); await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('link', { name: 'Owner scope', exact: true }).click();
    await page.locator(`a[data-tab="tasks"][href^="/projects/${place.id}/tasks"]`).click();
    await page.locator(`[data-card-id="${task.id}"]`).waitFor();
    assert.equal(await page.locator(`[data-card-id="${task.id}"] .agent-for`).count(), 0);
    assert.equal(await page.evaluate(() => (window as unknown as { sameDocument: boolean }).sameDocument), true);
    assert.equal((await context.request.get(`/api/v1/workspaces/${ws.id}/members`)).status(), 403, 'guest cannot request the roster');
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, {
      body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' },
    }), 201);
    await page.locator(`[data-card-id="${task.id}"] .agent-for`).waitFor();
    assert.equal(await page.locator(`[data-card-id="${task.id}"] .agent-for`).innerText(), 'for Scoped Casey', 'guest sees only project-authorized identity');
    const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
    if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, '339-scoped-agent-owner-board.png'), fullPage: true }); }
  });
