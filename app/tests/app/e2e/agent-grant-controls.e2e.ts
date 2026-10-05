import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium, type Page } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { expect, toolValue } from '../support/mcp.js';
import { agentConnection, toolFailure } from '../support/mcp-actions.js';
import { password } from '../support/people.js';

/**
 * The owner's standing-grant controls on the Connect page (#152 T152-a) drive the agent's real MCP calls: what the
 * owner grants, narrows or revokes in Chromium is what the agent's next tool call is allowed or refused. The agent
 * is a real OAuth bearer from the HTTP test client, not a Codex or Claude activation.
 */
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

test('grants made, narrowed and revoked in the browser are what the agent\'s next MCP call may do; an ended grant reads as ended', async () => {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  await new Promise<void>((resolve) => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  try {
    const email = uniqueEmail('grant-controls-e2e');
    const { browser: owner } = await register(email, password, 'Grant owner');
    const workspace = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Grant studio' } }), 201);
    const project = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { body: { name: 'Sensor study', visibility: 'restricted' } }), 201);
    const projectId = String(project.id);
    const agent = expect(await owner.request('POST', `/api/v1/workspaces/${workspace.id}/agents`, { body: { name: 'Owner agent', owner: 'self' } }), 201);
    expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    const connection = await agentConnection(pool, owner, String(agent.id), [projectId]);
    const createTask = (grantId: string, title: string) => connection.tool('flux_create_task', { projectId, runtimeSessionId: connection.runtimeSessionId,
      grantId, clientCommandId: randomUUID(), peerRequestClass: 'execute', sources: [], task: { title } });
    const liveGrant = async () => {
      const page = expect(await owner.request('GET', `/api/v1/agent-connections/${connection.connectionId}/action-grants?limit=50`), 200) as { items: { id: string; operation: string; revokedAt: string | null; expiresAt: string; maximumUses: number; used: number }[] };
      const live = page.items.filter((item) => !item.revokedAt && Date.parse(item.expiresAt) > Date.now() && item.operation === 'work.create');
      assert.equal(live.length, 1, 'exactly one current task grant');
      return live[0]!;
    };

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-GB' });
    const page = await context.newPage();
    await page.goto(`${origin}/login`);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
    await page.goto(`${origin}/connect-agent`);
    const panel = page.getByRole('region', { name: 'Standing grants for External connection' });
    const tasks = panel.getByRole('list', { name: 'Sensor study' }).getByRole('listitem').filter({ hasText: 'Create tasks' });
    const grantInBrowser = async (uses: string) => {
      await panel.getByRole('button', { name: 'Add a grant' }).click();
      const form = panel.getByRole('form', { name: 'Add a grant to External connection' });
      await form.getByRole('checkbox', { name: 'Create tasks' }).check();
      await form.getByLabel('Uses for each change').fill(uses);
      await form.getByRole('button', { name: 'Grant', exact: true }).click();
      await tasks.waitFor();
    };

    // Before any grant the agent's call is refused.
    assert.equal(toolFailure(await createTask(randomUUID(), 'Before any grant')).code, 'AGENT_EXECUTION_UNAVAILABLE');

    // Granted in the browser: the agent's next call creates the task.
    await grantInBrowser('3');
    await tasks.getByText('3 of 3 uses left').waitFor();
    const first = await liveGrant();
    const created = toolValue(await createTask(first.id, 'Created under a browser grant'));
    assert.equal(created.replayed, false);
    assert.equal(expect(await owner.request('GET', `/api/v1/work/${String(created.workId)}`), 200).title, 'Created under a browser grant');
    await page.reload();
    await tasks.getByText('2 of 3 uses left').waitFor();
    if (evidenceDir) { mkdirSync(evidenceDir, { recursive: true }); await page.screenshot({ path: join(evidenceDir, 'grant-controls-granted-desktop.png'), fullPage: true }); }

    // Narrowed in the browser to no uses left: the very next call is refused, nothing is created or debited.
    await tasks.getByRole('button', { name: 'Narrow Create tasks, Doing the work' }).click();
    await tasks.getByRole('form', { name: 'Narrow Create tasks' }).getByLabel('Uses left').fill('0');
    await tasks.getByRole('button', { name: 'Save' }).click();
    await tasks.getByText('No uses left of 1').waitFor();
    assert.deepEqual([(await liveGrant()).maximumUses, (await liveGrant()).used], [1, 1]);
    assert.equal(toolFailure(await createTask(first.id, 'After narrowing')).code, 'AGENT_EXECUTION_UNAVAILABLE');
    assert.equal((await pool.query('SELECT used FROM agent_standing_grants WHERE id=$1', [first.id])).rows[0].used, 1);

    // Revoked in the browser: the next call with it is refused.
    await tasks.getByRole('button', { name: 'Revoke Create tasks, Doing the work' }).click();
    await tasks.getByRole('button', { name: 'Revoke now' }).click();
    await panel.getByRole('button', { name: 'Show ended grants (1)' }).waitFor();
    assert.equal(toolFailure(await createTask(first.id, 'After revocation')).code, 'AGENT_EXECUTION_UNAVAILABLE');

    // A new grant works; once its end has passed, the next call is refused and the page shows it as ended.
    await grantInBrowser('5');
    const second = await liveGrant();
    toolValue(await createTask(second.id, 'Created before the end'));
    await pool.query("UPDATE agent_standing_grants SET expires_at = clock_timestamp() - interval '1 second' WHERE id=$1", [second.id]);
    assert.equal(toolFailure(await createTask(second.id, 'After the end')).code, 'AGENT_EXECUTION_UNAVAILABLE');
    await page.reload();
    await panel.getByText('None yet').waitFor();
    await panel.getByRole('button', { name: 'Show ended grants (2)' }).click();
    await panel.getByRole('list', { name: 'Ended grants' }).getByText(/^Ended /).waitFor();
    await panel.getByRole('list', { name: 'Ended grants' }).getByText(/^Revoked /).waitFor();
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, 'grant-controls-ended-desktop.png'), fullPage: true });
    await phoneCheck(page);
    await context.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => proxy.close(() => resolve())); await pool.end();
  }
});

/** The same page at phone width: no sideways scrolling, and the ended list stays readable. */
async function phoneCheck(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.scrollingElement!.scrollWidth <= 390), 'no sideways scrolling at 390px');
  if (evidenceDir) await page.screenshot({ path: join(evidenceDir, 'grant-controls-ended-phone.png'), fullPage: true });
}
