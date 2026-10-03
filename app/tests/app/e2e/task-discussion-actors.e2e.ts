import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { ConversationMessage, WorkItem } from '@flux/contracts';
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
  const context = await browser.newContext({ baseURL: origin.origin, viewport: { width, height: 900 } });
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
    assert.match(await row.innerText(), /Trial analyst · agent/);
    assert.equal(await row.locator('a[href*="/dm/new"]').count(), 0);
    assert.equal(await row.locator('.project-convo__message-meta time').getAttribute('datetime'), root.createdAt);
    const audience = page.locator('.project-convo__composer .composer__audience').filter({ hasText: '1 agent' });
    await audience.waitFor();
    assert.doesNotMatch(await audience.innerText(), /Only you|only you two/);
    // The thread starts with an agent, so the composer must not name a person who is not in the visible thread.
    const composer = page.getByRole('textbox', { name: 'Reply', exact: true });
    assert.equal(await composer.getAttribute('placeholder'), 'Reply in this conversation…');
    await composer.fill('I checked the trial: the counterexample is real.');
    const savedReply = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/v1/conversations/${root.conversationId}/messages`);
    await page.getByRole('button', { name: 'Send reply', exact: true }).click();
    const replyResponse = await savedReply;
    assert.equal(replyResponse.status(), 201, await replyResponse.text());
    await page.getByText('I checked the trial: the counterexample is real.', { exact: true }).waitFor();
    const read = expectStatus(await owner.browser.request('GET', `/api/v1/conversations/${root.conversationId}`), 200) as { messages: ConversationMessage[] };
    const human = read.messages[1]!;
    assert.equal(human.authorId, owner.id);
    assert.equal(Object.hasOwn(human, 'author'), false);
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
      assert.match(await agentRow.innerText(), /Trial analyst · agent/);
      assert.equal(await agentRow.locator('a[href*="/dm/new"]').count(), 0);
      const humanRow = view.locator(`#message-${human.id}`);
      await humanRow.waitFor();
      assert.equal(await humanRow.locator(`a[href$="with=${owner.id}"]`).count(), 1);
      await view.getByText('You have read access to this project.', { exact: true }).waitFor();
      assert.equal(await view.getByRole('textbox', { name: 'Reply', exact: true }).count(), 0);
      assert.equal(await view.getByRole('button', { name: 'Send reply', exact: true }).count(), 0);
      const sources = view.getByRole('button', { name: 'Sources', exact: true });
      await sources.focus();
      await sources.press('Enter');
      await view.getByRole('heading', { name: `Sources · saved for ${place.name}`, exact: true }).waitFor();
      assert.equal(await view.getByRole('button', { name: 'Add material', exact: true }).count(), 0);
      await view.getByRole('button', { name: 'Close sources', exact: true }).click();
      expectStatus(await reader.browser.request('POST', `/api/v1/conversations/${root.conversationId}/messages`, {
        body: { body: 'This viewer cannot publish.', clientMessageId: randomUUID() },
      }), 403);
      if (evidence) await view.screenshot({ path: join(evidence, `mixed-authors-reader-${width}.png`), fullPage: true });
    }
    assert.deepEqual((await pool.query('SELECT * FROM project_messages WHERE id=$1', [root.id])).rows[0], stored);
    assert.deepEqual(errors, []);
  });
