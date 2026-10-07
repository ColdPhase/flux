import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright';
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

async function signedIn(who: Person, width: number) {
  const context = await browser.newContext({ baseURL: origin.origin, viewport: { width, height: 900 }, serviceWorkers: 'block' });
  contexts.push(context);
  const signed = await context.request.post('/api/auth/sign-in/email', {
    data: { email: who.email, password }, headers: { origin: origin.origin },
  });
  assert.equal(signed.status(), 200, await signed.text());
  return context;
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
      assert.match(await agentRow.innerText(), /Trial analyst\s*Agent/);
      assert.equal(await agentRow.locator('a[href*="/dm/new"]').count(), 0);
      const humanRow = view.locator(`#message-${human.id}`);
      await humanRow.waitFor();
      assert.equal(await humanRow.locator(`a[href$="with=${owner.id}"]`).count(), 1);
      const thread = view.locator('#thread');
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
    }
    assert.deepEqual((await pool.query('SELECT * FROM project_messages WHERE id=$1', [root.id])).rows[0], stored);
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
    const capture = async (name: string) => {
      const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
      if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `339-${name}.png`), fullPage: true }); }
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
    await capture('scoped-owner-board');
    await page.getByRole('radio', { name: 'List', exact: true }).click();
    const row = page.locator(`[data-work-id="${task.id}"]`);
    await row.locator('.agent-for').waitFor();
    assert.equal(await row.locator('.agent-tag').innerText(), 'Agent');
    assert.equal(await row.locator('.ws-av').count(), 0);
    const decision = page.locator(`[data-work-id="${proposal.id}"]`);
    await decision.locator('.agent-for').waitFor();
    assert.equal(await decision.locator('.agent-tag').innerText(), 'Agent');
    assert.equal((await decision.innerText()).includes('(agent)'), false);
    await capture('scoped-owner-list');
    await row.getByRole('button').click();
    await page.locator('.wd-discussion .agent-for').waitFor();
    assert.equal(await page.locator('.wd-discussion .agent-tag').innerText(), 'Agent');
    assert.equal(await page.locator('.wd-discussion .agent-for').innerText(), 'for Scoped Casey');
    await capture('scoped-owner-task-details');
    await page.keyboard.press('Escape');
    await decision.getByRole('button').click();
    await page.locator('.details .agent-for').waitFor();
    assert.equal(await page.locator('.details .agent-for').innerText(), 'for Scoped Casey');
    await capture('scoped-owner-decision-details');
    await page.keyboard.press('Escape');
    await page.locator(`a[href^="/projects/${place.id}/agents"]`).click();
    await page.getByLabel('Task', { exact: true }).selectOption(task.id);
    await page.locator('.agents-msg__meta .agent-for').waitFor();
    assert.equal(await page.locator('.agents-msg__meta .agent-for').innerText(), 'for Scoped Casey');
    await capture('scoped-owner-agents-thread');
    await page.locator(`a[href^="/projects/${place.id}/tasks"]`).click();
    await page.getByRole('radio', { name: 'List', exact: true }).click();
    await row.locator('.agent-for').waitFor();
    // The same workspace has a second project with different agent rights. A workspace-keyed
    // owner cache would wrongly reuse the first project's authorized name here.
    await page.getByRole('link', { name: 'Other owner scope', exact: true }).click();
    await page.locator(`a[href^="/projects/${elsewhere.id}/tasks"]`).click();
    await page.getByRole('radio', { name: 'Kanban', exact: true }).click();
    await page.locator(`[data-card-id="${otherTask.id}"]`).waitFor();
    assert.equal(await page.locator(`[data-card-id="${otherTask.id}"] .agent-for`).count(), 0);
    await page.getByRole('link', { name: 'Owner scope', exact: true }).click();
    await page.locator(`a[href^="/projects/${place.id}/tasks"]`).click();
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
    await page.route(endpoint, async (route) => {
      if (!once) {
        const response = await route.fetch();
        const people = await response.json() as { id: string }[];
        await route.fulfill({ response });
        if (!people.some((person) => person.id === agent.id)) currentRead();
        return;
      }
      once = false;
      const response = await route.fetch();
      held();
      await gate;
      await route.fulfill({ response }).catch(() => undefined);
      heldDone();
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await gotHeld;
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, {
      body: { principal: { kind: 'agent', id: agent.id }, role: 'denied' },
    }), 201);
    await page.waitForFunction((id) => !document.querySelector(`[data-work-id="${id}"] .agent-for`), task.id);
    await gotCurrentRead;
    release();
    await gotHeldDone;
    await page.unrouteAll({ behavior: 'wait' });
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
    await page.locator(`a[href^="/projects/${place.id}/tasks"]`).click();
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
