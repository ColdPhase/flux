import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { ConversationMessage, TaskDiscussion, WorkItem, WorkResult } from '@flux/contracts';
import { addMember, expectStatus, grant, password, person, project, workspace, type Person } from '../support/people.js';

// A saved blocker, a published result and an explicit handoff reach the task's canonical conversation (#154).
// Real authenticated Chromium drives the Tasks panel; this does not certify an external MCP client.
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

test('a saved blocker, a published result and a handoff appear as marked messages in the task conversation',
  { timeout: 120_000 }, async () => {
    const [owner, writer, reader] = await Promise.all(['Casey Owner', 'Jonas Writer', 'Lee Reader'].map(person));
    const ws = await workspace(owner, 'Task effects');
    for (const other of [writer, reader]) await addMember(owner, ws.id, other, 'member');
    const place = await project(owner, ws.id, 'Hinge trial', 'restricted');
    await grant(owner, place.id, writer, 'contributor');
    await grant(owner, place.id, reader, 'viewer');
    const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
      body: { title: 'Inspect the hinge', clientCommandId: randomUUID() },
    }), 201) as WorkItem;
    const discussion = async () => expectStatus(await reader.browser.request('GET', `/api/v1/work/${task.id}/discussion`), 200) as TaskDiscussion;
    const errors: string[] = [];
    const context = await signedIn(writer, 1280);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));

    // 1. Status alone is not a comment; the saved blocker is one, with exactly the saved text.
    await page.goto(`/projects/${place.id}/tasks`);
    await page.getByRole('button', { name: /Inspect the hinge/ }).click();
    const status = page.getByRole('combobox', { name: 'Status' });
    await status.waitFor();
    const blockedStatus = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1/work/${task.id}`);
    await status.selectOption('blocked');
    assert.equal((await blockedStatus).status(), 200);
    assert.equal((await discussion()).root, null, 'blocking alone is not a comment');
    const waiting = page.getByRole('textbox', { name: 'What is it waiting for?' });
    await waiting.fill('Waiting for the replacement hinge');
    const saved = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1/work/${task.id}`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const savedResponse = await saved;
    assert.equal(savedResponse.status(), 200, await savedResponse.text());
    const command = JSON.parse(savedResponse.request().postData() ?? '{}') as { blocker?: string; clientCommandId?: string };
    assert.match(command.clientCommandId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'the browser always sends a stable command UUID');
    const afterBlocker = await discussion();
    assert.deepEqual([afterBlocker.root?.body, afterBlocker.root?.contribution, afterBlocker.root?.authorId],
      ['Waiting for the replacement hinge', { kind: 'blocker' }, writer.id]);
    const path = `/projects/${place.id}/conversations/${afterBlocker.conversationId}`;

    // 2. The result is published from the task and appears in the same conversation, linking the exact result.
    await page.getByRole('button', { name: 'Attach a result' }).click();
    await page.getByRole('textbox', { name: 'Finding' }).fill('The new hinge holds at 40 N');
    await page.getByRole('radio', { name: 'Positive' }).check();
    const published = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/projects/${place.id}/results`);
    await page.getByRole('button', { name: 'Attach result' }).click();
    const publishedResponse = await published;
    assert.equal(publishedResponse.status(), 201, await publishedResponse.text());
    const made = await publishedResponse.json() as WorkResult;
    assert.match((JSON.parse(publishedResponse.request().postData() ?? '{}') as { clientCommandId?: string }).clientCommandId ?? '', /^[0-9a-f-]{36}$/);
    const afterResult = await discussion();
    assert.deepEqual(afterResult.messages.map((message) => [message.sequence, message.contribution?.kind, message.authorId]),
      [[1, 'blocker', writer.id], [2, 'result', writer.id]]);
    assert.deepEqual(afterResult.messages[1]!.contribution, { kind: 'result', resultId: made.id });

    // 3. An explicit public handoff is a contribution of its own kind (no UI composer exists for it yet).
    const handoff = expectStatus(await owner.browser.request('POST', `/api/v1/work/${task.id}/discussion`, {
      body: { body: 'Please re-run the load test on the new hinge.', clientMessageId: randomUUID(), kind: 'handoff' },
    }), 201) as ConversationMessage;

    // 4. Every contribution is shown in the conversation, marked by its kind, for a person who can only read.
    const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
    for (const width of [1280, 390]) {
      const readerPage = await (await signedIn(reader, width)).newPage();
      readerPage.on('pageerror', (error) => errors.push(error.message));
      await readerPage.goto(path);
      const blocker = readerPage.locator(`#message-${afterBlocker.rootMessageId}`);
      await blocker.waitFor();
      assert.match(await blocker.innerText(), /Jonas Writer/);
      assert.match(await blocker.innerText(), /Waiting for the replacement hinge/);
      assert.equal(await blocker.locator('[data-contribution="blocker"]').innerText(), 'Saved as the task blocker');
      const result = readerPage.locator(`#message-${afterResult.messages[1]!.id}`);
      assert.match(await result.innerText(), /The new hinge holds at 40 N/);
      const open = result.locator('[data-contribution="result"]');
      assert.match(await open.innerText(), /Result/);
      assert.equal(await readerPage.locator(`#message-${handoff.id} [data-contribution="handoff"]`).innerText(), 'Handoff instruction');
      assert.equal(await readerPage.getByRole('textbox', { name: 'Reply', exact: true }).count(), 0, 'a reader has no composer');
      assert.ok(await readerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal overflow at ${width}px`);
      if (evidence) { mkdirSync(evidence, { recursive: true }); await readerPage.screenshot({ path: join(evidence, `task-effects-reader-${width}.png`), fullPage: true }); }
      // The result marker opens that exact canonical result.
      await open.click();
      await readerPage.getByRole('heading', { name: 'The new hinge holds at 40 N' }).first().waitFor();
      if (evidence) await readerPage.screenshot({ path: join(evidence, `task-effects-result-details-${width}.png`), fullPage: true });
    }
    // The ordinary messages and DM links of other people keep working beside the markers.
    const plain = expectStatus(await writer.browser.request('POST', `/api/v1/conversations/${afterBlocker.conversationId}/messages`, {
      body: { body: 'A plain reply in the same thread.', clientMessageId: randomUUID() },
    }), 201) as ConversationMessage;
    assert.equal(Object.hasOwn(plain, 'contribution'), false);
    await page.goto(path);
    await page.locator(`#message-${plain.id}`).waitFor();
    assert.equal(await page.locator(`#message-${plain.id} [data-contribution]`).count(), 0);
    assert.deepEqual(errors, []);
  });
