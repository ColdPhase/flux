/** Research-only probe for #460; no application/client source patch and no vendor model/account. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createDatabase } from '@flux/db';
import { chromium } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { password } from '../support/people.js';
import { expect } from '../support/mcp.js';
import { cleanClientHome, connectClient, seedOauthClient, scopes, sh, type ClientSpec } from '../support/mcp-client-harness.js';
import { startClientModelMock } from '../support/client-model-mock.js';

const origin = process.env.FLUX_PUBLIC_ORIGIN!;
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
let phase = 'setup';
const exchanges: any[] = [];
const proxy = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    let rpc: any;
    try { rpc = JSON.parse(body.toString()); } catch { /* only initialization is recorded */ }
    const meta = rpc?.params?._meta ?? rpc?._meta ?? {};
    const observed = request.url?.split('?')[0] === '/mcp' && rpc?.method ? {
      phase, method: rpc.method, offered: rpc.params?.protocolVersion ?? request.headers['mcp-protocol-version'] ?? null,
      metadataKeys: Object.keys(meta), protocolMetadata: Object.fromEntries(Object.entries(meta).filter(([key]) => key.toLowerCase().includes('protocol'))),
      clientInfo: rpc.params?.clientInfo,
      clientCapabilities: rpc.params?.capabilities,
      protocolHeader: request.headers['mcp-protocol-version'] ?? null,
      authenticated: Boolean(request.headers.authorization),
    } : null;
    if (observed) exchanges.push(observed);
    const forward = http.request({ host: upstream.hostname, port: upstream.port || 80,
      method: request.method, path: request.url, headers: request.headers }, answer => {
      if (observed) Object.assign(observed, { httpStatus: answer.statusCode,
        responseType: answer.headers['content-type'], responseProtocolHeader: answer.headers['mcp-protocol-version'] ?? null });
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      const resultChunks: Buffer[] = [];
      answer.on('data', chunk => { if (observed) resultChunks.push(chunk); response.write(chunk); });
      answer.on('end', () => {
        if (observed) {
          const text = Buffer.concat(resultChunks).toString();
          let result: any;
          try { result = JSON.parse(text); } catch {
            for (const line of text.split('\n')) if (line.startsWith('data:')) {
              try { const value = JSON.parse(line.slice(5)); if (value.result || value.error) result = value; } catch { /* no payload retained */ }
            }
          }
          Object.assign(observed, { selected: result?.result?.protocolVersion ?? null, supported: result?.result?.protocolVersions ?? result?.result?.versions ?? null,
            serverInfo: result?.result?.serverInfo ?? null, discovery: observed.method === 'server/discover' ? result?.result ?? null : undefined,
            serverCapabilityKeys: Object.keys(result?.result?.capabilities ?? {}),
            serverInstructionLength: result?.result?.instructions?.length ?? 0,
            error: result?.error ? { code: result.error.code, message: result.error.message, data: result.error.data } : null });
        }
        response.end();
      });
    });
    forward.on('error', () => response.destroy()); forward.end(body);
  });
});

const { pool } = createDatabase(process.env.DATABASE_URL!);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let heldModel: Awaited<ReturnType<typeof startClientModelMock>> | undefined;
const cases: any[] = [];
try {
  await new Promise<void>(resolve => proxy.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  const email = uniqueEmail('protocol-460');
  const { browser: owner } = await register(email, password, 'Protocol researcher');
  const ws = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Protocol research' } }), 201);
  const project = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Selected research', visibility: 'restricted' } }), 201);
  const other = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Outside selection', visibility: 'restricted' } }), 201);
  const agent = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Research Codex', owner: 'self' } }), 201);
  for (const id of [project.id, other.id]) expect(await owner.request('POST', `/api/v1/projects/${id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const spec: ClientSpec = { key: 'research-460', client: 'codex', label: 'Pinned Codex research', designation: 'codex', port: 19829 };
  const connection = expect(await owner.request('POST', '/api/v1/agent-connections', { body: { name: spec.label, clientDesignation: spec.designation, agentId: agent.id, selectedProjectIds: [project.id], scopes } }), 201);
  const grant = expect(await owner.request('POST', `/api/v1/agent-connections/${connection.id}/action-grants`, { body: { clientCommandId: randomUUID(), projectId: project.id, operation: 'work.create', peerRequestClass: 'execute', maximumUses: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201);
  const home = cleanClientHome(spec);
  const version = await sh('codex', ['--version'], home.env, home.cwd);
  assert.equal(version.code, 0); assert.match(version.output, /0\.160\.1/);
  const featuresBefore = await sh('codex', ['features', 'list'], home.env, home.cwd);
  const featureLineBefore = featuresBefore.output.split('\n').find(line => /^mcp_2026_07_28\s/.test(line.trim()));
  await connectClient(browser, email, home, await seedOauthClient(pool, spec));
  const configPath = `${home.env.CODEX_HOME}/config.toml`;
  const configBefore = readFileSync(configPath, 'utf8');

  async function runCase(name: string, flags: string[] = [], effect = false) {
    phase = name;
    const code = [
      'text(JSON.stringify(Object.keys(tools).filter(name => name.startsWith("mcp__flux__"))));',
      'if (tools.mcp__flux__flux_list_contexts) text(JSON.stringify(await tools.mcp__flux__flux_list_contexts({})));',
      ...(effect ? [
        `if (tools.mcp__flux__flux_bootstrap) {
          const boot = JSON.parse((await tools.mcp__flux__flux_bootstrap({projectId:${JSON.stringify(project.id)},clientSessionId:${JSON.stringify(randomUUID())}})).content[0].text);
          text(JSON.stringify({kind:'bootstrap', projectId:boot.project.id, digest:boot.trusted.playbook.digest}));
          text(JSON.stringify(await tools.mcp__flux__flux_create_task({projectId:${JSON.stringify(project.id)},runtimeSessionId:boot.runtime.id,grantId:${JSON.stringify(grant.id)},clientCommandId:${JSON.stringify(randomUUID())},peerRequestClass:'execute',task:{title:'Protocol-460 bounded task'}})));
          text(JSON.stringify(await tools.mcp__flux__flux_list_work({projectId:${JSON.stringify(other.id)}})));
        }`,
      ] : []),
    ].join('\n');
    const model = heldModel = await startClientModelMock(turn => turn.outputs.length === 0 ? { js: code } : { text: 'finished' });
    try {
      const result = await sh('codex', ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...flags,
        '-c', 'model_provider="mock"', '-c', `model_providers.mock={name="mock",base_url="http://127.0.0.1:${model.port}/v1",env_key="MOCK_MODEL_KEY",wire_api="responses",supports_websockets=false}`, 'Inspect the research connection'], home.env, home.cwd);
      assert.ok(model.requests.length > 0, 'the only model endpoint is the local scripted fixture');
      const outputs = model.requests.at(-1)?.outputs.flat() ?? [];
      const names = outputs.find(value => value.startsWith('[')) ?? '[]';
      const record = { name, flags, cliExit: result.code, modelRequests: model.requests.length,
        names: JSON.parse(names), outputs: outputs.slice(1), unsupportedDiagnostic: result.output.includes('Unsupported protocol version'),
        protocolExchanges: exchanges.filter(value => value.phase === name) };
      cases.push(record); console.log(JSON.stringify({ case: name, cliExit: result.code, fluxToolCount: record.names.length, protocolExchanges: record.protocolExchanges }));
      return record;
    } finally { await model.close(); heldModel = undefined; }
  }
  const defaultFirst = await runCase('default');
  assert.ok(defaultFirst.protocolExchanges.some(value => value.offered === '2025-06-18' && value.error?.code === -32022));
  assert.equal(defaultFirst.names.length, 0);
  const flagged = await runCase('explicit-flag', ['--enable', 'mcp_2026_07_28'], true);
  assert.ok(flagged.protocolExchanges.some(value => value.protocolHeader === '2026-07-28' && value.httpStatus === 200));
  assert.ok(flagged.names.includes('mcp__flux__flux_list_contexts'));
  assert.ok(flagged.outputs.join('\n').includes('Selected research'));
  assert.equal(flagged.outputs.join('\n').includes('Outside selection'), false);
  const work = expect(await owner.request('GET', `/api/v1/projects/${project.id}/work`), 200);
  assert.ok(JSON.stringify(work).includes('Protocol-460 bounded task'));
  assert.equal(readFileSync(configPath, 'utf8'), configBefore, '--enable does not persist a configuration change');
  const defaultAgain = await runCase('default-after-flag');
  assert.ok(defaultAgain.protocolExchanges.some(value => value.offered === '2025-06-18' && value.error?.code === -32022));
  assert.equal(defaultAgain.names.length, 0);
  const enabled = await sh('codex', ['features', 'enable', 'mcp_2026_07_28'], home.env, home.cwd);
  assert.equal(enabled.code, 0, enabled.output);
  const configAfter = readFileSync(configPath, 'utf8');
  assert.match(configAfter, /mcp_2026_07_28\s*=\s*true/);
  assert.ok(configAfter.includes('[mcp_servers.flux]'), 'native feature enable preserves the registered server');
  const persistent = await runCase('native-persistent-enable');
  assert.ok(persistent.protocolExchanges.some(value => value.protocolHeader === '2026-07-28' && value.httpStatus === 200));
  assert.deepEqual(persistent.names, flagged.names);
  expect(await owner.request('DELETE', `/api/v1/agent-connections/${connection.id}`), 204);
  const revoked = await runCase('revoked-with-feature');
  assert.equal(revoked.names.length, 0);
  assert.equal(revoked.outputs.join('\n').includes('Selected research'), false);
  const report = { serverHead: process.env.FLUX_GIT_COMMIT, clientVersion: version.output.match(/codex-cli \S+/)?.[0], versionPathAliasWarning: version.output.includes('Refusing to create helper binaries'), featureLineBefore,
    codexBinarySha256: createHash('sha256').update(readFileSync('/usr/local/bin/codex')).digest('hex'),
    nativeEnable: { exit: enabled.code, persisted: true, existingServerPreserved: true },
    configMutationFromFlag: false, cases, setupProtocolExchanges: exchanges.filter(value => value.phase === 'setup'),
    boundaries: { realClient: true, realFluxOAuth: true, seededOAuthClient: true, model: 'local scripted fixture only', vendorAccount: false, vendorKey: false, vendorSpend: 0, fullStartResume: 'not assessed' } };
  writeFileSync('/evidence/results.json', JSON.stringify(report, null, 2));
  console.log('PROTOCOL_RESEARCH_PASSED');
} finally {
  await heldModel?.close(); await browser.close(); proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve)); await pool.end();
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
}
