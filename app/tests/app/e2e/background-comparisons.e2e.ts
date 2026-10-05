import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { COMPARISON_RECOVERY_JOB, COMPARISON_TICK_JOB } from '@flux/core';
import type { ProactiveComparisonProposal, WorkResult } from '@flux/contracts';
import type { SwitchState } from '../background-comparisons-switch.js';
import { pool } from '../support/db.js';
import { signIn } from '../support/http.js';
import { expectStatus, password } from '../support/people.js';
import type { RecordedProviderRequest } from '../support/provider-mock.js';

// Background comparisons switched on in the running app (#58, T58-b). scripts/check_application.sh
// restarts the API and the worker with FLUX_BACKGROUND_COMPARISONS=on after
// `background-comparisons-switch.ts prepare`. The owner enables the paused rule in the real settings
// page; a contributor records a negative result; the worker's own scheduled tick (no test trigger,
// no fixture shortcut) waits out the 2-minute quiet window and dispatches it through the production
// provider registry to the Compose `providermock`; the quiet proposal appears in the project. Pausing
// stops new candidates. `background-comparisons-switch.ts off` then checks the switched-off state.
// providermock is never a provider: nothing here is a provider, billing or quality pass.

const stateDir = process.env.FLUX_TEST_STATE_DIR ?? '/state';
const stateFile = join(stateDir, 'background-comparisons.json');
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as SwitchState;
const MOCK = process.env.FLUX_PROVIDER_MOCK_URL ?? 'http://providermock:8095';
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const origin = new URL(process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:18089');
const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: Number(upstream.port || 80),
    method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(response);
  });
  forward.on('error', () => response.destroy());
  request.pipe(forward);
});

let browser: Browser;
let page: Page;

async function api(method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, { method, credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }, { method, path, body });
}
async function mock(path: string, body?: unknown) {
  const response = await fetch(`${MOCK}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return response.json() as Promise<{ requests: RecordedProviderRequest[] }>;
}
async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
const rule = async () => (await pool.query<{ status: string; version: number }>('SELECT status, version FROM proactive_comparison_rules WHERE id=$1', [state.ruleId])).rows[0]!;

before(async () => {
  await new Promise<void>((resolve) => proxy.listen(Number(origin.port || 80), origin.hostname, resolve));
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
  await page.goto(origin.origin);
  const login = await api('POST', '/api/auth/sign-in/email', { email: state.ownerEmail, password });
  assert.equal(login.status, 200);
});
after(async () => {
  await browser?.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
});

test('switched on: the owner enables the rule in settings, the scheduled tick pays once, and the quiet proposal appears', async () => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The worker registered and scheduled both jobs.
  const scheduled = await until('the comparison schedules', async () => {
    const rows = (await pool.query<{ name: string; cron: string }>('SELECT name, cron FROM pgboss.schedule WHERE name = ANY($1) ORDER BY name',
      [[COMPARISON_TICK_JOB, COMPARISON_RECOVERY_JOB]])).rows;
    return rows.length === 2 ? rows : null;
  }, 60_000, 1_000);
  assert.deepEqual(scheduled.map((row) => [row.name, row.cron]).sort(),
    [[COMPARISON_RECOVERY_JOB, '*/10 * * * *'], [COMPARISON_TICK_JOB, '* * * * *']]);
  assert.deepEqual((await api('GET', '/api/v1/background-comparisons/runtime')).data, { status: 'available' });
  await mock('/__reset', {});

  // The owner enables the paused rule through the real settings page.
  await page.goto(`${origin.origin}/settings/background-compute?project=${state.projectId}`);
  const enable = page.getByRole('button', { name: 'Enable rule', exact: true });
  await enable.waitFor();
  assert.match(await page.locator('section[aria-labelledby="background-rules"]').innerText(), /can start a paid comparison for any of the project’s negative results/);
  await page.screenshot({ path: join(stateDir, 'background-comparisons-1440-paused.png'), fullPage: true });
  await enable.click();
  await page.locator('.background-settings__saved', { hasText: 'Rule enabled.' }).waitFor();
  await page.getByRole('button', { name: 'Pause rule', exact: true }).waitFor();
  const enabled = await rule();
  assert.equal(enabled.status, 'enabled');
  assert.equal(enabled.version, 2);

  // A contributor records a negative result; the answer the provider mock will give cites it.
  const peer = (await signIn(state.peerEmail, password)).browser;
  const result = expectStatus(await peer.request('POST', `/api/v1/projects/${state.projectId}/results`, { body: {
    title: 'Camera missed the low-light target', finding: 'negative', evidence: 'Camera A recognized 38% of gestures at 5 lux; target was 90%.',
    sources: [{ type: 'material', id: state.materialId, version: 1 }] } }), 201) as WorkResult;
  const recordedAt = Date.now();
  await mock('/__script', { wire: 'openai', usage: { input: 300, output: 90 }, text: JSON.stringify({ outcome: { kind: 'comparison',
    fact: 'Camera A recognized 38% of gestures at 5 lux against a 90% target.',
    interpretation: 'Exposure may limit the camera in low light; this is an interpretation, not a decision.',
    suggestedAction: 'Compare a ToF distance sensor under the same 5 lux protocol.',
    citations: [{ type: 'result', id: result.id, version: 1 }, { type: 'material', id: state.materialId, version: 1 }] } }) });

  // Nothing triggers a tick here: the worker's schedule runs it after the quiet window.
  const settled = await until('the scheduled tick to settle the candidate', async () => {
    const rows = (await pool.query('SELECT id, status, proposal_id, connection_id, reserved_cents, usage_input_tokens, usage_output_tokens, usage_estimated_cents, dispatch_started_at FROM proactive_comparison_outbox WHERE result_id=$1',
      [result.id])).rows;
    return rows.length === 1 && rows[0].status !== 'queued' && rows[0].status !== 'reserved' ? rows[0] : null;
  }, 6 * 60_000);
  console.log(JSON.stringify({ check: 'background-comparisons', settledAfterMs: Date.now() - recordedAt }));
  assert.equal(settled.status, 'completed');
  assert.ok(settled.proposal_id);
  assert.ok(settled.dispatch_started_at);
  assert.deepEqual([settled.connection_id, settled.reserved_cents, settled.usage_input_tokens, settled.usage_output_tokens, settled.usage_estimated_cents],
    [state.connectionId, 13, 300, 90, 1], 'reserved at the connection price; usage as the provider reported it');

  // Exactly one provider request: the owner's own key and model, the project's evidence, no private capture.
  const sent = (await mock('/__requests')).requests;
  assert.equal(sent.length, 1, 'one paid request');
  const [request] = sent;
  assert.deepEqual([request!.wire, request!.method, request!.path, request!.key], ['openai', 'POST', '/openai/v1/chat/completions', state.key]);
  const body = JSON.stringify(request!.body);
  assert.equal((request!.body as { model: string }).model, state.model);
  assert.ok(body.includes(state.marker), 'the cited project material was sent');
  assert.equal(body.includes(state.canary), false, 'a private draft never reaches the provider');
  const others = await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_outbox WHERE dispatch_started_at >= $1 AND id <> $2', [state.preparedAt, settled.id]);
  assert.equal(others.rows[0].n, 0, 'no other candidate was dispatched after the switch');
  const ticks = await pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state = 'completed' AND created_on >= $2", [COMPARISON_TICK_JOB, state.preparedAt]);
  assert.ok(ticks.rows[0].n >= 2, 'scheduled ticks ran in the worker');

  // A project reader sees the quiet proposal on the owner's connection; the owner sees it in the project.
  const proposals = expectStatus(await peer.request('GET', `/api/v1/projects/${state.projectId}/proactive-comparison-proposals`), 200) as ProactiveComparisonProposal[];
  const proposal = proposals.find((item) => item.resultId === result.id);
  assert.ok(proposal);
  assert.deepEqual([proposal.id, proposal.status, proposal.agentId, proposal.computeSource, proposal.provider, proposal.model],
    [settled.proposal_id, 'proposed', state.agentId, 'owner_background_connection', 'openai_compatible', state.model]);
  assert.equal(JSON.stringify(proposal).includes(state.canary), false);
  await page.goto(`${origin.origin}/projects/${state.projectId}/tasks?view=list`);
  const card = page.locator('.ws-proposal', { hasText: 'Compare a ToF distance sensor under the same 5 lux protocol.' });
  await card.waitFor();
  assert.match(await card.locator('.ws-proposal__source').innerText(), /Camera missed the low-light target/);
  await page.screenshot({ path: join(stateDir, 'background-comparisons-1440-proposal.png'), fullPage: true });

  // Pausing in settings stops new candidates: a later negative result queues nothing.
  await page.goto(`${origin.origin}/settings/background-compute?project=${state.projectId}`);
  await page.getByRole('button', { name: 'Pause rule', exact: true }).click();
  await page.locator('.background-settings__saved', { hasText: 'Rule paused.' }).waitFor();
  assert.equal((await rule()).status, 'paused');
  const later = expectStatus(await peer.request('POST', `/api/v1/projects/${state.projectId}/results`, { body: {
    title: 'Second camera trial also missed', finding: 'negative', evidence: 'Camera A recognized 40% of gestures at 5 lux.',
    sources: [{ type: 'material', id: state.materialId, version: 1 }] } }), 201) as WorkResult;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proactive_comparison_outbox WHERE result_id=$1', [later.id])).rows[0].n, 0);
  // Enabled again for the switched-off check, which then finds it as an operator would.
  await page.getByRole('button', { name: 'Enable rule', exact: true }).click();
  await page.locator('.background-settings__saved', { hasText: 'Rule enabled.' }).waitFor();
  assert.deepEqual(await rule(), { status: 'enabled', version: 4 });
  assert.equal((await mock('/__requests')).requests.length, 1, 'still one paid request');
  assert.deepEqual(errors, []);
  writeFileSync(stateFile, JSON.stringify({ ...state, paidResultId: result.id } satisfies SwitchState));
});
