import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PERSONAL_RUN_CONSENT_VERSION, personalRunTokenPath, RUNTIME_RUN_LIMITS, type Conversation } from '@flux/contracts';
import { personalRunTokenRows } from '@flux/db';
import { RUN_BRIEF } from '../../../apps/runtime/src/supervisor/run.js';
import { cliEnvironment, RUN_TEMPLATES } from '../../../apps/runtime/src/supervisor/templates.js';
import { personalRunUseCases } from '../../../apps/server/src/personal-runs/adapters.js';
import { startClientModelMock, type MockTurn } from '../support/client-model-mock.js';
import { db, pool } from '../support/db.js';
import { apiUrl } from '../support/http.js';
import { claudeBin } from '../support/mcp-client-harness.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace } from '../support/people.js';
import { FakeConnections, FakeQueue } from '../support/personal-runs.js';

/**
 * OPT-IN (F-022 T5 #280, F-027 A2; scripts/check_mcp_clients.sh, `mcp-clients` image): the REAL pinned Claude Code,
 * started with exactly the runtime's run template and environment, reads Flux through the MCP route with a run
 * token minted by the API for an in-flight run. No vendor account: `ANTHROPIC_BASE_URL` points it at the scripted
 * local model (client-model-mock.ts) with a fixed non-vendor key. It records the `system/init` field names and
 * checks that the tool list it shows equals the run's switch-derived list, that the Flux server is connected, and
 * that FLUX_RUN_TOKEN reached the MCP Authorization header (a call answered with the run's place). These are the
 * T5 contract facts that a real account cannot change; plan limits and sign-in errors stay for T10.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('the pinned real claude, run with the runtime\'s exact argv, shows only the run\'s Flux tools and reads Flux with FLUX_RUN_TOKEN', { timeout: 240_000 }, async (t) => {
  const owner = await person('real-claude-run');
  const ws = await createWorkspace(owner, 'Real Claude run');
  const place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
  const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
  const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
    { body: { body: 'Camera fails below 5 lux', clientMessageId: randomUUID() } }), 201) as Conversation;
  const connections = new FakeConnections();
  const connectionId = randomUUID();
  connections.connect(owner.id, connectionId);
  const runs = personalRunUseCases(db, { queue: new FakeQueue().factory, connections, providerEnabled: true });
  await runs.enable({ kind: 'human', id: owner.id }, { consentVersion: PERSONAL_RUN_CONSENT_VERSION, agentId, connectionId });
  const started = await runs.invoke({ kind: 'human', id: owner.id }, thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Which projects can you see?' });
  await pool.query(`UPDATE personal_runs SET status = 'reading' WHERE id = $1`, [started.run.id]);
  const nonce = randomBytes(32).toString('hex');
  assert.ok(await db.transaction((tx) => personalRunTokenRows(tx).arm(started.run.id, sha256(nonce))));
  const minted = await fetch(`${apiUrl}${personalRunTokenPath(started.run.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  assert.equal(minted.status, 200);
  const grant = await minted.json() as { token: string; tools: string[] };

  const model = await startClientModelMock((turn: MockTurn) => turn.outputs.length === 0
    ? { call: { name: 'mcp__flux__flux_list_contexts', args: {} } } : { text: 'Done: I can see one project.' });
  const root = mkdtempSync(join(tmpdir(), 'real-claude-run-'));
  const binding = join(root, 'binding');
  for (const dir of ['claude', 'home', 'tmp']) mkdirSync(join(binding, dir), { recursive: true, mode: 0o700 });
  const mcpConfigPath = join(root, 'tmp-mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { flux: { type: 'http', url: `${apiUrl}/mcp`, headers: { Authorization: 'Bearer ${FLUX_RUN_TOKEN}' } } } }), { mode: 0o600 });
  const argv = RUN_TEMPLATES.claude_code({ tools: grant.tools, caps: { ...RUNTIME_RUN_LIMITS, maxTurns: 4 }, mcpConfigPath, mcpUrl: `${apiUrl}/mcp`, brief: RUN_BRIEF });
  // The slot's own environment, with the egress proxy left out (this container has no runtime-egress) and the model mock.
  const env: Record<string, string> = { ...cliEnvironment('claude_code', binding, 'runtime-egress', { FLUX_RUN_TOKEN: grant.token }),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}`, ANTHROPIC_API_KEY: 'sk-ant-not-a-vendor-key' };
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) delete env[name];
  env.PATH = `/opt/flux-tools/claude/bin:${env.PATH}`;
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(claudeBin, argv, { env, cwd: binding, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end('Which projects can you see? Use the Flux tools.');
  });
  await model.close();
  const events = output.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  assert.ok(init, `no system/init event:\n${output.stdout.slice(0, 4000)}\n${output.stderr.slice(0, 2000)}`);
  t.diagnostic(`system/init field names: ${Object.keys(init).sort().join(', ')}`);
  t.diagnostic(`claude_code_version: ${String(init.claude_code_version ?? 'not reported')}`);
  t.diagnostic(`system/init tools: ${JSON.stringify(init.tools)}`);
  t.diagnostic(`system/init mcp_servers: ${JSON.stringify(init.mcp_servers)}`);
  const tools = (init.tools as string[]).filter((tool) => tool !== 'EndConversation').sort();
  assert.deepEqual(tools, grant.tools.map((tool) => `mcp__flux__${tool}`).sort(), 'the start-up list is exactly the run\'s switch-derived Flux tools');
  // 2.1.285 adds `source` ("dynamic" for --mcp-config); the read-back uses only `name` and `status`.
  assert.deepEqual((init.mcp_servers as { name: string; status: string }[]).map(({ name, status }) => ({ name, status })), [{ name: 'flux', status: 'connected' }],
    'Flux is the only MCP server, connected with the run token');
  const offered = model.requests.find((request) => request.tools.some((name) => name.startsWith('mcp__flux__')))?.tools ?? [];
  assert.deepEqual(offered.filter((name) => name !== 'EndConversation').sort(), tools, 'the model is offered the same list');
  const result = events.find((event) => event.type === 'result');
  assert.equal(result?.subtype, 'success', output.stdout.slice(-2000));
  // The call went through /mcp with FLUX_RUN_TOKEN in the Authorization header: its answer names the run's place.
  const answered = JSON.stringify(model.requests.at(-1)?.outputs ?? []);
  assert.ok(answered.includes(place.id), `the Flux call was answered with the place:\n${answered.slice(0, 2000)}`);
});
