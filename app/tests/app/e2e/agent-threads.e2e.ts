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
  const context = await browser.newContext({ baseURL: origin.origin, viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width <= 680, hasTouch: width <= 680, serviceWorkers: 'block' });
  context.setDefaultTimeout(15_000);
  const response = await context.request.post('/api/auth/sign-in/email', { data: { email: who.email, password }, headers: { origin: origin.origin } });
  assert.equal(response.status(), 200, await response.text()); return context;
}
const panel = (page: Page) => page.locator('[data-agent-thread-task]');
async function settledSurface(page: Page) {
  // Observe the real panel/sheet entrance finishing; keep product motion and all geometry assertions.
  await page.waitForFunction(() => {
    const surface = document.querySelector('.at-panel')?.closest('.ui-panel');
    if (!surface) return false;
    for (const animation of surface.getAnimations()) if (animation.playState === 'running') return false;
    return true;
  }, undefined, { timeout: 5000 });
}
async function composerReachable(page: Page) {
  await settledSurface(page);
  const geometry = await panel(page).evaluate(element => {
    const form = element.querySelector('.at-composer'), box = form?.querySelector('.composer__box');
    const send = form?.querySelector('[aria-label="Send"]'), field = form?.querySelector('textarea');
    // Plain observations, with no transpiler-generated helper closure in the browser realm.
    const f = form?.getBoundingClientRect(), b = box?.getBoundingClientRect(), s = send?.getBoundingClientRect(), t = field?.getBoundingClientRect();
    return { form: f ? { top: f.top, bottom: f.bottom, left: f.left, right: f.right } : null,
      box: b ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right } : null,
      send: s ? { top: s.top, bottom: s.bottom, left: s.left, right: s.right } : null,
      field: t ? { top: t.top, bottom: t.bottom, left: t.left, right: t.right } : null,
      bottom: window.visualViewport?.height ?? innerHeight, width: innerWidth };
  });
  for (const key of ['box', 'send', 'field'] as const) {
    const box = geometry[key]; assert.ok(box && box.top >= 0 && box.bottom <= geometry.bottom + 1 && box.left >= 0 && box.right <= geometry.width, `${key} is reachable in the visible thread surface: ${JSON.stringify(geometry)}`);
  }
  assert.ok(geometry.form && geometry.bottom - geometry.form.bottom < 36, 'composer remains at the bottom, without blank space beneath the action');
}
async function storedTheme(page: Page, theme: 'light' | 'dark') {
  // Apply the actual device preference through normal app initialization. Direct dataset mutation
  // bypassed the app's atomic theme switch and photographed an unreadable intermediate cross-fade.
  const taskId = await panel(page).getAttribute('data-agent-thread-task');
  assert.ok(taskId);
  // The existing shell consumes its one-shot `open` address. Re-enter the authorized task link
  // when loading the stored preference; do not invent persistence for another surface's URL state.
  const address = new URL(page.url()); address.searchParams.set('open', `work:${taskId}`);
  await page.evaluate(choice => localStorage.setItem('flux.theme', choice), theme);
  await page.goto(address.href);
  await panel(page).getByRole('heading').waitFor();
  await page.waitForFunction(choice => document.documentElement.dataset.theme === choice, theme);
  await settledSurface(page);
}
function rgb(value: string) {
  const numbers = value.match(/[\d.]+/g)?.map(Number);
  assert.ok(numbers && numbers.length >= 3, `actual CSS color is measurable: ${value}`);
  return numbers;
}
function ratio(foreground: string, background: string) {
  const light = (value: string) => {
    const [r, g, b] = rgb(value).map(channel => { const x = channel / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
    return .2126 * r! + .7152 * g! + .0722 * b!;
  };
  const a = light(foreground), b = light(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
async function settledComposer(page: Page) {
  // Enabling/disabling the existing action animates its foreground and surface. Observe the
  // actual finished colors without disabling motion or changing the contrast requirements.
  await page.waitForFunction(() => {
    const box = document.querySelector('.at-composer .composer__box');
    if (!box) return true;
    for (const animation of box.getAnimations({ subtree: true })) if (animation.playState === 'running') return false;
    return true;
  }, undefined, { timeout: 5000 });
}
async function composerContrast(page: Page, theme: 'light' | 'dark') {
  await settledComposer(page);
  const actual = await panel(page).evaluate(element => {
    const box = element.querySelector('.composer__box')!, field = box.querySelector('textarea')!;
    const attach = box.querySelector('.composer__attach')!, send = box.querySelector('.composer__send')!;
    const surface = getComputedStyle(box), text = getComputedStyle(field), placeholder = getComputedStyle(field, '::placeholder');
    const attachment = getComputedStyle(attach.querySelector('svg')!), action = getComputedStyle(send.querySelector('svg')!);
    return { background: surface.backgroundColor, fieldBackground: text.backgroundColor, text: text.color,
      placeholder: placeholder.color, placeholderOpacity: placeholder.opacity, attachment: attachment.color,
      send: action.color, sendBackground: getComputedStyle(send, '::before').backgroundColor, disabled: send.getAttribute('aria-disabled') };
  });
  console.log(JSON.stringify({ engine, viewport: page.viewportSize(), theme, composerContrast: actual }));
  assert.deepEqual(rgb(actual.fieldBackground), [0, 0, 0, 0], 'transparent field shares the actual elevated composer surface');
  if (theme === 'dark') assert.ok(rgb(actual.background).slice(0, 3).every(channel => channel < 64), `dark composer remains a dark elevated input: ${JSON.stringify(actual)}`);
  assert.equal(Number(actual.placeholderOpacity), 1);
  assert.ok(ratio(actual.text, actual.background) >= 4.5, 'actual input text contrast');
  assert.ok(ratio(actual.placeholder, actual.background) >= 4.5, 'actual placeholder contrast');
  assert.ok(ratio(actual.attachment, actual.background) >= 3, 'actual attachment glyph contrast');
  assert.ok(ratio(actual.send, actual.sendBackground) >= 3, `actual enabled/inactive action glyph contrast: ${JSON.stringify(actual)}`);
}
async function capture(page: Page, name: string) {
  const directory = process.env.FLUX_E2E_EVIDENCE_DIR;
  if (!directory) return;
  await settledSurface(page);
  await settledComposer(page);
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
      if (width === 1440) {
        await capture(page, 'empty-desktop-light');
        await storedTheme(page, 'dark'); await field.waitFor(); await composerContrast(page, 'dark');
        await capture(page, 'empty-desktop-dark');
        await storedTheme(page, 'light'); await field.waitFor();
      }
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
      await composerReachable(page);
      const aligned = await panel(page).locator('.at-message').first().evaluate(element => {
        const avatar = element.firstElementChild!.getBoundingClientRect();
        const name = element.querySelector('strong')!.getBoundingClientRect();
        const body = element.querySelector('.at-message__body')!.getBoundingClientRect();
        return { avatarWidth: avatar.width, avatarRight: avatar.right, nameLeft: name.left, bodyLeft: body.left };
      });
      assert.equal(aligned.avatarWidth, 32); assert.ok(Math.abs(aligned.nameLeft - aligned.bodyLeft) < 1);
      assert.ok(Math.abs(aligned.bodyLeft - aligned.avatarRight - (width === 390 ? 10 : 12)) < 1);
      for (const theme of ['light', 'dark'] as const) {
        await storedTheme(page, theme);
        await field.waitFor();
        await composerReachable(page); await composerContrast(page, theme);
        await field.fill('A private contrast check, kept out of the project.');
        await page.waitForFunction(() => document.querySelector('.at-composer [aria-label="Send"]')?.getAttribute('aria-disabled') === 'false');
        await composerContrast(page, theme); await composerReachable(page);
        await field.fill('');
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
      await storedTheme(readPage, 'dark'); await panel(readPage).locator('.at-message').first().waitFor();
      await capture(readPage, `viewer-${width}-dark`);
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
    await panel(page).locator('.composer-files__error').waitFor();
    await composerReachable(page);
    await capture(page, 'refused-phone-light');
    const appearance = await context.newPage();
    try {
      await appearance.goto('/settings');
      await appearance.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: 'Dark', exact: true }).click();
    } finally { await appearance.close(); }
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && !document.documentElement.hasAttribute('data-theme-switching'));
    await composerReachable(page); await composerContrast(page, 'dark');
    await capture(page, 'refused-phone-dark');
    await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.at-composer textarea'));
    const kept = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), `flux:composer:${f.writer.id}:${f.place.id}:agent-thread:${f.task.id}`) as { body: string };
    assert.ok(kept.body.includes('Keep this unsent'));
    await grant(f.owner, f.place.id, f.writer, 'denied'); await page.reload();
    assert.equal(await panel(page).locator('.at-message').count(), 0);
  } finally { await context.close(); }
});


test('compact bottom actions survive realistic long history, long drafts, narrow/short phone and real attached-file sends', { timeout: 180_000 }, async () => {
  const f = await fixture();
  await f.say('The reference sensor is stable after the first warm-up.');
  for (let i = 0; i < 18; i++) await f.say(`Reading ${i + 1}: the gesture lamp responds consistently. ` + 'We compared both prototype baselines after warming the housings and rechecked the cold-start measurements. '.repeat(i === 6 ? 15 : 2), i % 2 ? f.writer : f.owner);
  for (const [width, height] of [[1440, 900], [390, 844], [320, 568], [390, 480]] as const) {
    const context = await session(f.writer, width); const page = await context.newPage();
    try {
      await page.setViewportSize({ width, height });
      await page.goto(`/projects/${f.place.id}/tasks?open=work:${f.task.id}&agentThread=1`);
      const field = panel(page).getByRole('textbox', { name: 'Write in the agents’ thread' }); await field.waitFor();
      await composerReachable(page);
      for (const edge of ['first', 'last'] as const) {
        const message = edge === 'first' ? panel(page).locator('.at-message').first() : panel(page).locator('.at-message').last();
        await message.scrollIntoViewIfNeeded(); await composerReachable(page);
        const visible = await message.evaluate(element => {
          const m = element.getBoundingClientRect(), feed = element.closest('.at-feed')!.getBoundingClientRect();
          return m.bottom > feed.top && m.top < feed.bottom;
        }); assert.equal(visible, true, `${edge} message is reachable in the independently scrolling history`);
      }
      await field.fill('A private unsent measurement.\n'.repeat(30)); await field.press('Control+End');
      await composerReachable(page); assert.ok(await field.evaluate(element => element.scrollHeight > element.clientHeight), 'long draft scrolls within the capped field');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (width === 320) {
        const readable = await panel(page).evaluate(element => {
          const feed = element.querySelector('.at-feed')!, head = element.querySelector('.at-head')!;
          feed.scrollTop = 0;
          const region = feed.getBoundingClientRect(), first = feed.querySelector('.at-message')!.getBoundingClientRect();
          const next = feed.querySelectorAll('.at-message')[1]!.querySelector('strong')!.getBoundingClientRect();
          return { height: region.height, header: head.getBoundingClientRect().height, firstVisible: first.top >= region.top && first.bottom <= region.bottom,
            nextAuthorVisible: next.top >= region.top && next.bottom <= region.bottom };
        });
        assert.ok(readable.height >= 200, `narrow phone keeps a useful transcript beside its long draft: ${JSON.stringify(readable)}`);
        assert.ok(readable.firstVisible && readable.nextAuthorVisible, 'one complete observation and the following attribution remain readable');
        await capture(page, 'long-draft-narrow-phone-light');
        await storedTheme(page, 'dark'); await field.waitFor();
        assert.ok((await field.inputValue()).includes('A private unsent measurement.'), 'stored theme and explicit task re-entry retain the private long draft');
        await composerReachable(page); await composerContrast(page, 'dark');
        await capture(page, 'long-draft-narrow-phone-dark');
      }
      if (width === 390 && height === 844) {
        await field.fill('The measured traces are attached.');
        await panel(page).locator('.composer__box input[type="file"]').setInputFiles({ name: 'prototype-measurements.csv', mimeType: 'text/csv', buffer: Buffer.from('probe,value\nA,12\nB,14\n') });
        await panel(page).getByText(/Ready, private/).waitFor(); await composerReachable(page);
        const stored = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === f.path);
        await panel(page).getByRole('button', { name: 'Send', exact: true }).click(); const response = await stored; assert.equal(response.status(), 201);
        const message = await response.json() as ConversationMessage; assert.equal(message.files?.[0]?.name, 'prototype-measurements.csv');
        const file = await context.request.get(`/api/v1/files/${message.files![0]!.id}`); assert.equal(file.status(), 200); assert.equal((await file.body()).toString(), 'probe,value\nA,12\nB,14\n');
        await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
        await panel(page).getByRole('link', { name: /prototype-measurements.csv/ }).waitFor();
      }
    } finally { await context.close(); }
  }
});
