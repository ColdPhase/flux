import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { agentMcpPolicyPath, type AgentMcpPolicy } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { expect, toolValue } from '../support/mcp.js';
import { agentConnection, toolFailure } from '../support/mcp-actions.js';
import { password } from '../support/people.js';

// Genuine sessions, persisted owner API/CAS and an already-issued OAuth bearer.
// These controls do not certify queued MCP bytes, action replay or complete S6.
const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const evidenceDir = process.env.FLUX_E2E_EVIDENCE_DIR;
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response);
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
    const settings = async () => expect(await owner.request('GET', path), 200) as unknown as { policy: AgentMcpPolicy; connection: unknown };
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

test('ordinary owner switches persist, the same old MCP bearer loses wiki access, and all Off remains manageable without new consent', { timeout: 120_000 }, async () => {
  const f = await fixture(); const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    await wiki.check(); await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await panel.getByRole('status').getByText('Permissions saved', { exact: true }).waitFor();
    assert.equal(toolValue(await f.connection.tool('flux_get_doc', { projectId: f.projectId, id: f.doc.id })).title, 'Calibration notes');
    await panel.getByRole('button', { name: 'Disable all', exact: true }).click();
    await panel.getByRole('button', { name: 'Save permissions', exact: true }).click();
    await panel.getByRole('status').getByText('Permissions saved', { exact: true }).waitFor();
    assert.deepEqual((await f.settings()).policy, { connectionId: f.connection.connectionId,
      version: f.initial.policy.version + 3, enabledCapabilityIds: [], enabledEntryIds: [], selectedProjectIds: [] });
    await page.reload(); await panel.getByRole('status').getByText('Showing saved permissions', { exact: true }).waitFor();
    assert.ok(await panel.getByRole('button', { name: 'Reload saved permissions', exact: true }).isEnabled());
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM agent_standing_grants WHERE connection_id=$1',
      [f.connection.connectionId])).rows[0].n, 0, 'switches create no standing authority');
    await capture(page, 'mcp-permissions-all-off-desktop');
  } finally { await context.close(); await browser.close(); await f.pool.end(); }
});

test('stale tabs and an actual offline save keep unconfirmed changes distinct from saved permissions', { timeout: 120_000 }, async () => {
  const f = await fixture(); const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
          const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
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
