import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { agentMcpPolicyPath, type AgentMcpPolicy, type AgentConnectionSetupFacts } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { chromium, webkit, type BrowserContext, type Page, type Request as BrowserRequest } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { expect, toolValue } from '../support/mcp.js';
import { agentConnection, toolFailure } from '../support/mcp-actions.js';
import { password } from '../support/people.js';

// Genuine sessions, persisted owner API/CAS and an already-issued OAuth bearer.
// These controls do not certify queued MCP bytes, action replay or complete S6.
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const evidenceDir = process.env.FLUX_E2E_EVIDENCE_DIR;
type HeldRead = { captured(body: Buffer): void; failed(error: Error): void; release: Promise<void>; settled(): void };
const heldReads = new Map<string, HeldRead>();
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
    const held = request.method === 'GET' ? heldReads.get(request.url ?? '') : undefined;
    if (!held) { response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response); return; }
    heldReads.delete(request.url!);
    const chunks: Buffer[] = []; let bytes = 0;
    answer.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 512_000) { held.failed(new Error('Genuine owner response exceeds finite test buffer')); answer.destroy(); return; }
      chunks.push(chunk);
    });
    answer.on('error', (error) => { held.failed(error); held.settled(); response.destroy(); });
    answer.on('end', () => {
      const body = Buffer.concat(chunks);
      // Large JSON answers are compressed; the captured copy is decoded, the forwarded bytes stay untouched.
      const encoding = String(answer.headers['content-encoding'] ?? '');
      held.captured(encoding === 'br' ? brotliDecompressSync(body) : encoding === 'gzip' ? gunzipSync(body) : body);
      void held.release.then(() => {
        // Preserve the actual upstream status, headers and bytes. Cancellation
        // may already have closed this old request; never substitute JSON.
        if (!response.destroyed) { response.writeHead(answer.statusCode ?? 502, answer.headers); response.end(body); }
      }).finally(() => held.settled());
    });
  });
  forward.on('error', () => response.destroy()); request.pipe(forward);
});
before(async () => { await new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve)); });
after(async () => { await new Promise<void>((resolve) => proxy.close(() => resolve())); });

async function fixture() {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  try {
    const email = uniqueEmail('permission-controls'); const { browser: owner } = await register(email, password, 'Marta Owner');
    const ws = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Workshop' } }), 201);
    const project = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/projects`,
      { body: { name: 'Sensor workshop', visibility: 'restricted' } }), 201);
    const projectId = String(project.id);
    const agent = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
      { body: { name: 'Research partner', owner: 'self' } }), 201);
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`,
      { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    const doc = expect(await owner.request('POST', `/api/v1/projects/${projectId}/docs`,
      { body: { title: 'Calibration notes', body: 'Private calibration observation' } }), 201);
    const connection = await agentConnection(pool, owner, String(agent.id), [projectId]);
    const path = agentMcpPolicyPath(connection.connectionId);
    const settings = async () => expect(await owner.request('GET', path), 200) as unknown as { policy: AgentMcpPolicy; connection: unknown; setup: AgentConnectionSetupFacts };
    const initial = await settings();
    return { pool, email, owner, projectId, doc, connection, initial, settings };
  } catch (error) { await pool.end(); throw error; }
}

async function open(context: BrowserContext, email: string) {
  const signedIn = await context.request.post(`${origin}/api/auth/sign-in/email`, { data: { email, password }, headers: { origin } });
  assert.equal(signedIn.status(), 200);
  const page = await context.newPage(); await page.goto(`${origin}/connect-agent`);
  const panel = page.getByRole('region', { name: 'Permissions for External connection', exact: true });
  await panel.getByRole('status').getByText('Showing saved permissions', { exact: true }).waitFor();
  return { page, panel };
}
async function capture(page: Page, name: string) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map((animation) => animation.finished.catch(() => undefined)));
  });
  await page.screenshot({ path: join(evidenceDir, name + '.png'), fullPage: true });
}
async function finite<T>(work: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 15_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}

test('ordinary owner switches persist, the same old MCP bearer loses wiki access, and all Off remains manageable without new consent', { timeout: 120_000 }, async () => {
  const f = await fixture(); const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  try {
    const { page, panel } = await open(context, f.email);
    const wiki = panel.getByRole('switch', { name: /^Wiki and materials/ });
    assert.equal(await wiki.isChecked(), true);
    assert.equal(toolValue(await f.connection.tool('flux_get_doc', { projectId: f.projectId, id: f.doc.id })).title, 'Calibration notes');
    await wiki.uncheck(); assert.equal((await f.settings()).policy.version, f.initial.policy.version, 'draft toggles are not saved');
    await panel.getByRole('status').getByText('Changes are not saved yet', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await panel.getByRole('status').getByText('Permissions saved', { exact: true }).waitFor();
    assert.equal(toolFailure(await f.connection.tool('flux_get_doc', { projectId: f.projectId, id: f.doc.id })).code, 'MCP_ENTRY_UNAVAILABLE');
    assert.deepEqual((await f.settings()).connection, f.initial.connection, 'original consent is unchanged');
    assert.equal(new URL(page.url()).pathname, '/connect-agent', 'ordinary save starts no extra login flow');
    await page.reload(); await panel.getByRole('status').getByText('Showing saved permissions', { exact: true }).waitFor();
    assert.equal(await wiki.isChecked(), false); await capture(page, 'mcp-permissions-wiki-off-desktop');
    const playbook = panel.getByRole('switch', { name: /^Flux co-work instructions/ });
    await playbook.uncheck(); await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await panel.getByRole('status').getByText('Permissions saved', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.mcp-permissions')?.getAttribute('aria-busy') !== 'true');
    const runtime = panel.locator('.mcp-permissions__row').filter({ has: page.getByRole('switch', { name: /^Current agent session/ }) });
    await runtime.getByText('Related tools also need: Flux co-work instructions.', { exact: true }).waitFor();
    assert.equal(await runtime.getByRole('switch').isChecked(), true, 'a missing prerequisite is explained without changing another switch');
    assert.equal(toolFailure(await f.connection.tool('flux_bootstrap', { projectId: f.projectId, clientSessionId: randomUUID() })).code,
      'MCP_ENTRY_UNAVAILABLE');
    await capture(page, 'mcp-permissions-missing-playbook-prerequisite-desktop');
    await playbook.check(); await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await panel.getByRole('status').getByText('Permissions saved', { exact: true }).waitFor();
    await wiki.check(); await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await panel.getByRole('status').getByText('Permissions saved', { exact: true }).waitFor();
    assert.equal(toolValue(await f.connection.tool('flux_get_doc', { projectId: f.projectId, id: f.doc.id })).title, 'Calibration notes');
    await panel.getByRole('button', { name: 'Disable all', exact: true }).click();
    await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await panel.getByRole('status').getByText('Permissions saved', { exact: true }).waitFor();
    assert.deepEqual((await f.settings()).policy, { connectionId: f.connection.connectionId,
      version: f.initial.policy.version + 5, enabledCapabilityIds: [], enabledEntryIds: [], selectedProjectIds: [] });
    await page.reload(); await panel.getByRole('status').getByText('Showing saved permissions', { exact: true }).waitFor();
    assert.ok(await panel.getByRole('button', { name: 'Reload saved permissions', exact: true }).isEnabled());
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM agent_standing_grants WHERE connection_id=$1',
      [f.connection.connectionId])).rows[0].n, 0, 'switches create no standing authority');
    await capture(page, 'mcp-permissions-all-off-desktop');
  } finally { await context.close(); await browser.close(); await f.pool.end(); }
});

test('a held genuine initial policy response cannot downgrade a later confirmed save', { timeout: 120_000 }, async () => {
  const f = await fixture(); const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const path = agentMcpPolicyPath(f.connection.connectionId);
  let release!: () => void; let captured!: (body: Buffer) => void; let failed!: (error: Error) => void; let settled!: () => void;
  const responseBytes = new Promise<Buffer>((resolve, reject) => { captured = resolve; failed = reject; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const settledResponse = new Promise<void>((resolve) => { settled = resolve; });
  heldReads.set(path, { captured, failed, release: released, settled });
  try {
    assert.equal((await context.request.post(`${origin}/api/auth/sign-in/email`, { data: { email: f.email, password }, headers: { origin } })).status(), 200);
    const page = await context.newPage(); let initial: BrowserRequest | null = null;
    page.on('request', (request) => { if (!initial && request.method() === 'GET' && new URL(request.url()).pathname === path) initial = request; });
    const firstOutcome = new Promise<'finished' | 'aborted'>((resolve, reject) => {
      page.on('requestfinished', (request) => { if (request === initial) resolve('finished'); });
      page.on('requestfailed', (request) => { if (request === initial) {
        const error = request.failure()?.errorText ?? '';
        if (/ABORTED|cancelled|canceled/i.test(error)) resolve('aborted'); else reject(new Error(`Unexpected original-request failure: ${error}`));
      } });
    });
    await page.goto(`${origin}/connect-agent`);
    const original = JSON.parse((await finite(responseBytes, 'genuine initial policy capture')).toString()) as { policy: AgentMcpPolicy };
    assert.deepEqual(original.policy, f.initial.policy, 'the held bytes are the actual old saved policy');
    const panel = page.getByRole('region', { name: 'Permissions for External connection', exact: true });
    await panel.getByRole('button', { name: 'Reload saved permissions', exact: true }).click();
    await panel.getByRole('status').getByText('Showing saved permissions', { exact: true }).waitFor();
    await panel.getByRole('switch', { name: /^Wiki and materials/ }).uncheck();
    await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await panel.getByRole('status').getByText('Permissions saved', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.mcp-permissions')?.getAttribute('aria-busy') !== 'true');
    const winner = await f.settings(); assert.equal(winner.policy.version, f.initial.policy.version + 1);
    release(); await finite(settledResponse, 'released original response'); await finite(firstOutcome, 'original browser request');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await panel.getByRole('switch', { name: /^Wiki and materials/ }).isChecked(), false);
    assert.equal(await panel.getByRole('status').innerText(), 'Permissions saved', 'old initial-read callbacks cannot replace the confirmed status');
    assert.deepEqual(await f.settings(), winner, 'late bytes cannot modify the actual saved policy');
    await capture(page, 'mcp-permissions-late-initial-read-desktop');
  } finally { release(); heldReads.delete(path); await context.close(); await browser.close(); await f.pool.end(); }
});

test('a confirmed project-removal save with failed availability refresh shows unknown access until a genuine reload', { timeout: 120_000 }, async () => {
  const f = await fixture(); const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const pattern = `**${agentMcpPolicyPath(f.connection.connectionId)}`;
  try {
    const { page, panel } = await open(context, f.email);
    assert.ok(await panel.getByText('Saved: available', { exact: true }).count() > 0);
    await panel.getByRole('switch', { name: /^Sensor workshop/ }).uncheck();
    await context.route(pattern, (route) => route.request().method() === 'GET' ? route.abort('failed') : route.continue());
    await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await panel.getByRole('alert').getByText('Permissions were saved, but their current availability could not be refreshed. Reload to check.', { exact: true }).waitFor();
    const saved = await f.settings();
    assert.equal(saved.policy.version, f.initial.policy.version + 1); assert.deepEqual(saved.policy.selectedProjectIds, []);
    assert.deepEqual(saved.policy.enabledCapabilityIds, f.initial.policy.enabledCapabilityIds);
    assert.equal(await panel.getByRole('status').innerText(), 'Permissions saved');
    assert.equal(await panel.getByText('Saved: available', { exact: true }).count(), 0, 'pre-write availability is not labeled as the confirmed policy');
    assert.ok(await panel.getByText('Saved access needs refreshing', { exact: true }).count() > 0);
    await capture(page, 'mcp-permissions-confirmed-save-refresh-failed-desktop');
    await context.unroute(pattern);
    await panel.getByRole('button', { name: 'Reload saved permissions', exact: true }).click();
    await panel.getByRole('status').getByText('Showing saved permissions', { exact: true }).waitFor();
    assert.equal(await panel.getByText('Saved access needs refreshing', { exact: true }).count(), 0);
    const wikiRow = panel.locator('.mcp-permissions__row').filter({ has: panel.getByRole('switch', { name: /^Wiki and materials/ }) });
    assert.equal(await wikiRow.getByText('Saved: available', { exact: true }).count(), 0, 'wiki reads require a selected readable project');
  } finally { await context.close(); await browser.close(); await f.pool.end(); }
});

test('stale tabs and an actual offline save keep unconfirmed changes distinct from saved permissions', { timeout: 120_000 }, async () => {
  const f = await fixture(); const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  try {
    const a = await open(context, f.email); const b = await open(context, f.email);
    await a.panel.getByRole('switch', { name: /^Wiki and materials/ }).uncheck();
    await a.panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await a.panel.getByRole('status').getByText('Permissions saved', { exact: true }).waitFor();
    const winner = await f.settings();
    await b.panel.getByRole('switch', { name: /^Tasks/ }).uncheck();
    await b.panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await b.panel.getByRole('alert').getByText('Permissions changed in another tab. Reload saved permissions before editing.', { exact: true }).waitFor();
    assert.equal(await b.panel.getByRole('button', { name: 'Save permissions', exact: true }).isDisabled(), true);
    assert.deepEqual(await f.settings(), winner, 'a stale save changes no saved policy');
    await capture(b.page, 'mcp-permissions-stale-save-desktop');
    await b.panel.getByRole('button', { name: 'Reload saved permissions', exact: true }).click();
    await b.panel.getByRole('status').getByText('Showing saved permissions', { exact: true }).waitFor();
    await b.panel.getByRole('switch', { name: /^Tasks/ }).uncheck();
    await context.setOffline(true);
    await b.panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await b.panel.getByRole('alert').getByText('The save could not be confirmed. Reload saved permissions before trying again.', { exact: true }).waitFor();
    assert.equal(await b.panel.getByRole('switch', { name: /^Tasks/ }).isChecked(), false, 'unconfirmed draft remains visible');
    assert.deepEqual(await f.settings(), winner, 'an actually offline request does not change persisted permissions');
    await context.setOffline(false);
    await b.panel.getByRole('button', { name: 'Reload saved permissions', exact: true }).click();
    await b.panel.getByRole('status').getByText('Showing saved permissions', { exact: true }).waitFor();
    assert.equal(await b.panel.getByRole('switch', { name: /^Tasks/ }).isChecked(), true);
    assert.equal(await b.panel.getByRole('switch', { name: /^Wiki and materials/ }).isChecked(), false);
  } finally { await context.setOffline(false); await context.close(); await browser.close(); await f.pool.end(); }
});

test('Chromium and WebKit phone owner controls keep 44px switches, keyboard access and saved all-Off management at 320 and 390', { timeout: 240_000 }, async () => {
  for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { args: ['--no-sandbox'] } : {});
      try {
        for (const width of [320, 390]) {
          const f = await fixture();
          const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
          try {
            const { page, panel } = await open(context, f.email);
            const switches = panel.getByRole('switch');
            for (const control of await switches.all()) {
              if (!await control.isVisible()) continue;
              const box = await control.boundingBox(); assert.ok(box);
              assert.ok(box.width >= 44 - .001 && box.height >= 44 - .001, 'the actual switch has a full 44px target');
            }
            const wiki = panel.getByRole('switch', { name: /^Wiki and materials/ });
            await wiki.focus(); const before = await wiki.isChecked(); await wiki.press('Space');
            assert.equal(await wiki.isChecked(), !before, 'keyboard Space controls the actual switch');
            await panel.getByRole('button', { name: 'Discard changes', exact: true }).click();
            assert.equal(await wiki.isChecked(), before);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await capture(page, `mcp-permissions-${engine.name()}-phone-${width}`);
            await panel.getByRole('button', { name: 'Disable all', exact: true }).tap();
            await panel.getByRole('button', { name: 'Save permissions', exact: true }).tap();
            await panel.getByRole('status').getByText('Permissions saved', { exact: true }).waitFor();
            await page.reload(); await panel.getByRole('status').getByText('Showing saved permissions', { exact: true }).waitFor();
            assert.deepEqual((await f.settings()).policy.selectedProjectIds, []);
            assert.ok(await panel.getByRole('button', { name: 'Reload saved permissions', exact: true }).isEnabled());
            await capture(page, `mcp-permissions-${engine.name()}-phone-${width}-all-off`);
          } finally { await context.close(); await f.pool.end(); }
        }
      } finally { await browser.close(); }
  }
});

test('actual owner setup stays pending, refreshes lost authorization, and keeps revoked history in Chromium and WebKit', { timeout: 240_000 }, async () => {
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { args: ['--no-sandbox'] } : {});
    try {
      for (const width of [390, 1440]) {
        const f = await fixture();
        const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: width === 390 ? 844 : 900 },
          isMobile: width === 390, hasTouch: width === 390, deviceScaleFactor: width === 390 ? 3 : 1 });
        try {
          const { page, panel } = await open(context, f.email);
          const setup = panel.getByRole('region', { name: 'Connection setup', exact: true });
          await setup.getByRole('heading', { name: 'Client session open · activation pending', exact: true }).waitFor();
          assert.equal(await setup.getByText('Built-in Start and Resume are pending. This connection is not ready to launch work from Flux.', { exact: true }).count(), 1);
          assert.equal(await page.getByRole('button', { name: /^(Start work|Resume work)$/ }).count(), 0, 'OAuth/bootstrap records do not manufacture a working launch control');
          for (const theme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme: theme });
            await setup.scrollIntoViewIfNeeded();
            await page.evaluate(() => document.fonts.ready);
            if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `connect-setup-${engine.name()}-${width}-${theme}.png`) });
          }
          await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
          const overflow = await page.evaluate(() => [...document.querySelectorAll('.connection *')].filter(element => {
            const box = element.getBoundingClientRect(); return box.width > 0 && box.right > innerWidth + 1;
          }).map(element => ({ tag: element.tagName, class: element.className, text: element.textContent?.slice(0, 80), right: element.getBoundingClientRect().right })));
          await capture(page, `connect-setup-${engine.name()}-${width}-enlarged`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `enlarged text preserves the setup message and controls without horizontal overflow: ${JSON.stringify(overflow)}`);
          await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
          // Revoke the actual OAuth records independently of the UI, then refresh through its keyboard control.
          await f.pool.query('UPDATE oauth_access_token SET revoked=now() WHERE reference_id IN (SELECT \'flux-grant:\' || id FROM agent_oauth_bindings WHERE connection_id=$1)', [f.connection.connectionId]);
          await f.pool.query('UPDATE oauth_refresh_token SET revoked=now() WHERE reference_id IN (SELECT \'flux-grant:\' || id FROM agent_oauth_bindings WHERE connection_id=$1)', [f.connection.connectionId]);
          const reload = panel.getByRole('button', { name: 'Reload saved permissions', exact: true });
          await reload.focus(); await reload.press('Enter');
          await setup.getByRole('heading', { name: 'Authorization needed', exact: true }).waitFor();
          assert.equal((await f.settings()).setup.authorizationRecorded, false);
          await panel.getByRole('button', { name: 'Disable all', exact: true }).click();
          await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
          await setup.getByRole('heading', { name: 'Permissions are Off', exact: true }).waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.getByRole('button', { name: 'Revoke connection', exact: true }).click();
          if (width === 390) await page.getByRole('button', { name: 'Revoke now', exact: true }).tap();
          else await page.getByRole('button', { name: 'Revoke now', exact: true }).click();
          const history = page.locator('.connection__history');
          await history.locator('summary').click();
          assert.equal(await history.getByText('External connection', { exact: true }).count(), 1);
          await page.reload(); await history.locator('summary').click();
          assert.equal(await history.getByText('External connection', { exact: true }).count(), 1, 'revoked history survives page reload');
          assert.equal(await page.getByRole('radio').count(), 0, 'revoked selection cannot reauthorize or retain actionable permission controls');
        } finally { await context.close(); await f.pool.end(); }
      }
    } finally { await browser.close(); }
  }
});
