import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { ConversationMessage, TaskDiscussion, WorkItem } from '@flux/contracts';
import { addMember, expectStatus, grant, password, person, project, workspace, type Person } from '../support/people.js';

// A saved blocker, the line saved at Done (what came of it) and an explicit handoff reach the task's canonical conversation (#154).
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

test('a saved blocker, what came of a finished task and a handoff appear as marked messages in the task conversation',
  { timeout: 120_000 }, async () => {
    const [owner, writer, reader] = await Promise.all(['Casey Owner', 'Jonas Writer', 'Lee Reader'].map(person));
    const ws = await workspace(owner, 'Task effects');
    for (const other of [writer, reader]) await addMember(owner, ws.id, other, 'member');
    const place = await project(owner, ws.id, 'Hinge trial', 'restricted');
    await grant(owner, place.id, writer, 'contributor');
    await grant(owner, place.id, reader, 'contributor');
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
    const status = page.getByRole('button', { name: 'Status', exact: true });
    await status.waitFor();
    const blockedStatus = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1/work/${task.id}`);
    await status.click();
    await page.getByRole('menuitemradio', { name: 'Blocked' }).click();
    assert.equal((await blockedStatus).status(), 200);
    assert.equal((await discussion()).root, null, 'blocking alone is not a comment');
    // Since the unified task panel (#601) the reason is written after Edit in the Blocker section. Blocked is one field, "Waiting for"
    // (#1447, #1438 point 12): the reason as typed words, or a person, decision or task picked from the list under it.
    await page.getByRole('region', { name: 'Blocker' }).getByRole('button', { name: 'Edit', exact: true }).click();
    const waiting = page.getByRole('combobox', { name: 'Waiting for', exact: true });
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
    // The status line saved before the reason says none, so the reason is shown in the task's Activity, marked (#1146).
    const savedLine = page.getByRole('list', { name: 'Task activity' }).locator(`[data-message-id="${afterBlocker.rootMessageId}"]`);
    await savedLine.waitFor();
    assert.match(await savedLine.innerText(), /Waiting for the replacement hinge/);
    assert.equal(await savedLine.locator('[data-contribution="blocker"]').innerText(), 'Saved as the task blocker');

    // 2. The line saved at Done ("What came of it") appears in the same conversation, once, with exactly the saved text.
    const finishedStatus = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1/work/${task.id}`);
    await status.click();
    await page.getByRole('menuitemradio', { name: 'Done' }).click();
    assert.equal((await finishedStatus).status(), 200);
    assert.equal((await discussion()).messages.length, 1, 'finishing alone adds no line');
    await page.getByRole('button', { name: 'What came of it, add a line' }).click();
    await page.getByRole('textbox', { name: 'What came of it' }).fill('The new hinge holds at 40 N');
    const lineSaved = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1/work/${task.id}`);
    await page.getByRole('textbox', { name: 'What came of it' }).press('Enter');
    const lineResponse = await lineSaved;
    assert.equal(lineResponse.status(), 200, await lineResponse.text());
    const lineCommand = JSON.parse(lineResponse.request().postData() ?? '{}') as { cameOfIt?: string; clientCommandId?: string };
    assert.equal(lineCommand.cameOfIt, 'The new hinge holds at 40 N');
    assert.match(lineCommand.clientCommandId ?? '', /^[0-9a-f-]{36}$/);
    const afterResult = await discussion();
    assert.deepEqual(afterResult.messages.map((message) => [message.sequence, message.contribution?.kind, message.authorId]),
      [[1, 'blocker', writer.id], [2, 'came_of_it', writer.id]]);

    // 3. An explicit public handoff is a contribution of its own kind (no UI composer exists for it yet).
    const handoff = expectStatus(await owner.browser.request('POST', `/api/v1/work/${task.id}/discussion`, {
      body: { body: 'Please re-run the load test on the new hinge.', clientMessageId: randomUUID(), kind: 'handoff' },
    }), 201) as ConversationMessage;

    // 4. Every contribution is shown in the task's discussion, for another member of the space, and the lines of an effect carry their kind.
    // The discussion is read in the task's Details (#868, #1048); a link to one of its messages opens it as a thread beside the stream,
    // whose opening message is the blocker; the blocker's reason is also a marked line of the Details' Activity (#1146).
    const evidence = process.env.FLUX_E2E_EVIDENCE_DIR;
    for (const width of [1280, 390]) {
      const readerPage = await (await signedIn(reader, width)).newPage();
      readerPage.on('pageerror', (error) => errors.push(error.message));
      await readerPage.goto(`/projects/${place.id}/tasks?open=work:${task.id}`);
      const activity = readerPage.getByRole('list', { name: 'Task activity' });
      const blockerLine = activity.locator(`[data-message-id="${afterBlocker.rootMessageId}"]`);
      await blockerLine.waitFor();
      assert.match(await blockerLine.innerText(), /Waiting for the replacement hinge/);
      assert.equal(await blockerLine.locator('[data-contribution="blocker"]').innerText(), 'Saved as the task blocker');
      const cameOfItLine = activity.locator(`[data-message-id="${afterResult.messages[1]!.id}"]`);
      await cameOfItLine.waitFor();
      assert.match(await cameOfItLine.innerText(), /The new hinge holds at 40 N/);
      assert.equal(await cameOfItLine.locator('[data-contribution="came_of_it"]').innerText(), 'What came of it');
      assert.equal(await activity.locator(`[data-message-id="${handoff.id}"] [data-contribution="handoff"]`).innerText(), 'Instruction for an agent');
      assert.ok(await readerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal overflow in the task at ${width}px`);
      if (evidence) { mkdirSync(evidence, { recursive: true }); await readerPage.screenshot({ path: join(evidence, `task-effects-reader-details-${width}.png`), fullPage: true }); }

      await readerPage.goto(path);
      const opening = readerPage.locator(`#thread-root-${afterBlocker.rootMessageId}`);
      await opening.waitFor();
      assert.equal(await readerPage.locator(`#message-${afterBlocker.rootMessageId}`).count(), 0, 'the discussion\'s root is not a row of the stream');
      assert.match(await opening.innerText(), /Jonas Writer/);
      assert.match(await opening.innerText(), /Waiting for the replacement hinge/);
      const line = readerPage.locator(`#message-${afterResult.messages[1]!.id}`);
      // The line is a reply: the thread beside the stream stays hidden until its own first reads settle
      // (#155, up to 1 s), and innerText omits hidden text (#271). Read it once its text is shown.
      await line.getByText('The new hinge holds at 40 N').first().waitFor();
      assert.match(await line.innerText(), /The new hinge holds at 40 N/);
      assert.equal(await line.locator('[data-contribution="came_of_it"]').innerText(), 'What came of it');
      assert.equal(await readerPage.locator(`#message-${handoff.id} [data-contribution="handoff"]`).innerText(), 'Instruction for an agent');
      // A space has no read-only reader since #903 (Member and Admin): the person added to it can answer in the thread.
      await readerPage.getByRole('textbox', { name: 'Reply', exact: true }).waitFor();
      assert.ok(await readerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal overflow at ${width}px`);
      if (evidence) { mkdirSync(evidence, { recursive: true }); await readerPage.screenshot({ path: join(evidence, `task-effects-reader-${width}.png`), fullPage: true }); }
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
