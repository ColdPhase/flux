/** Research-only probe for #460; no application/client source patch and no vendor model/account. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createDatabase } from '@flux/db';
import { chromium } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { password } from '../support/people.js';
import { beginOauth, oauthToken, expect } from '../support/mcp.js';
import { cleanClientHome, connectClient, seedOauthClient, scopes, sh, type ClientSpec } from '../support/mcp-client-harness.js';
import { startClientModelMock } from '../support/client-model-mock.js';

import { coworkPlaybookUri, coworkPlaybookReference } from '@flux/core';

let capturedBearer: string | undefined;
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
    if (observed) { exchanges.push(observed); if (request.headers.authorization) capturedBearer = request.headers.authorization; }
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
  const grant = expect(await owner.request('POST', `/api/v1/agent-connections/${connection.id}/action-grants`, { body: { clientCommandId: randomUUID(), projectId: project.id, operation: 'work.create', peerRequestClass: 'execute', maximumUses: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }), 201);
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
          text(JSON.stringify(await tools.mcp__flux__flux_create_task({projectId:${JSON.stringify(project.id)},runtimeSessionId:boot.runtime.id,grantId:${JSON.stringify(grant.id)},clientCommandId:${JSON.stringify(randomUUID())},peerRequestClass:'execute',task:{title:${JSON.stringify('Protocol-460 '+name)}}})));
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
  const defaultFirst = await runCase('prototype-default', [], true);
  assert.equal(defaultFirst.names.length, 45);
  assert.ok(defaultFirst.protocolExchanges.some(value => value.method === 'initialize' && value.selected === '2025-06-18'));
  assert.ok(defaultFirst.outputs.join('\n').includes('Selected research'));
  assert.ok(defaultFirst.outputs.join('\n').includes('PROJECT_NOT_FOUND'));
  const flagged = await runCase('prototype-flagged', ['--enable', 'mcp_2026_07_28'], true);
  assert.ok(flagged.protocolExchanges.some(value => value.protocolHeader === '2026-07-28' && value.httpStatus === 200));
  assert.deepEqual(defaultFirst.names, flagged.names);
  assert.ok(flagged.outputs.join('\n').includes('PROJECT_NOT_FOUND'));
  const work = expect(await owner.request('GET', `/api/v1/projects/${project.id}/work`), 200);
  assert.ok(JSON.stringify(work).includes('Protocol-460 prototype-default'));
  assert.ok(JSON.stringify(work).includes('Protocol-460 prototype-flagged'));
  assert.equal(readFileSync(configPath, 'utf8'), configBefore);
  const defaultAgain = await runCase('prototype-default-after-flag');
  assert.deepEqual(defaultAgain.names, defaultFirst.names);
  assert.ok(capturedBearer, 'real native OAuth supplied a bearer');
  const nativeBearer = capturedBearer;
  const probes: any[] = [];
  let rpcId = 400;
  async function raw(version: string, method: string, params: any = {}, bearer = nativeBearer, protocolHeader = version, protocolClaim = version) {
    const modern = version >= '2026';
    const result = await fetch(new URL('/mcp', upstream), {method:'POST', headers:{authorization:bearer,
      'content-type':'application/json', accept:'application/json, text/event-stream',
      'mcp-protocol-version':protocolHeader, ...(modern ? {'mcp-method':method,
        ...(params.name || params.uri ? {'mcp-name':params.name ?? params.uri} : {})} : {})},
      body:JSON.stringify({jsonrpc:'2.0',id:rpcId++,method,params:{...params,...(modern ? {_meta:{
        'io.modelcontextprotocol/protocolVersion':protocolClaim,
        'io.modelcontextprotocol/clientInfo':{name:'research-probe',version:'1'},
        'io.modelcontextprotocol/clientCapabilities':{}}} : {})}})});
    const body = await result.text();
    let message: any;
    if(result.headers.get('content-type')?.includes('text/event-stream')) {
      for(const line of body.split('\n')) if(line.startsWith('data:')) {
        try {const value=JSON.parse(line.slice(5)); if(value.result || value.error) message=value;} catch { /* SSE framing */ }
      }
    } else if(body) message=JSON.parse(body);
    return {status:result.status,message};
  }
  const toolNames: any[]=[];
  const resourceTexts: any[]=[];
  const promptTexts: any[]=[];
  for(const version of ['2025-06-18','2026-07-28']) {
    const tools=await raw(version,'tools/list'); assert.equal(tools.status,200);
    assert.ok(!tools.message.error);toolNames.push(tools.message.result.tools);
    const resources=await raw(version,'resources/list'); assert.equal(resources.status,200);
    assert.ok(resources.message.result.resources.some((item:any)=>item.uri===coworkPlaybookUri()));
    const read=await raw(version,'resources/read',{uri:coworkPlaybookUri()});assert.equal(read.status,200);
    assert.ok(!read.message.error);resourceTexts.push(read.message.result.contents[0].text);
    const prompts=await raw(version,'prompts/list');assert.equal(prompts.status,200);
    assert.deepEqual(prompts.message.result.prompts.map((item:any)=>item.name).sort(),['resume_work','start_work']);
    const prompt=await raw(version,'prompts/get',{name:'start_work',arguments:{projectId:project.id}});assert.equal(prompt.status,200);
    assert.ok(!prompt.message.error);promptTexts.push(prompt.message.result.messages[0].content.text);
    probes.push({kind:'feature-projection',version,toolCount:tools.message.result.tools.length,
      playbookBytes:resourceTexts.at(-1).length,promptBytes:promptTexts.at(-1).length});
  }
  assert.deepEqual(toolNames[0],toolNames[1]);
  assert.equal(resourceTexts[0],resourceTexts[1]);assert.equal(promptTexts[0],promptTexts[1]);
  // A separate genuine narrowed OAuth token, not an edited token or mocked auth.
  const readConnection=expect(await owner.request('POST','/api/v1/agent-connections',{body:{name:'Read-only research',
    agentId:agent.id,selectedProjectIds:[project.id],scopes:['flux.context.read']}}),201);
  const readSpec:ClientSpec={...spec,key:'research-read-only',port:19828};
  const readClient=await seedOauthClient(pool,readSpec);
  await pool.query('UPDATE oauth_client SET name=$1 WHERE client_id=$2',['Flux HTTP test client',readClient]);
  const redirect='http://127.0.0.1:19828/callback';
  const readToken=await oauthToken(owner,String(readConnection.id),readClient,redirect,
    await beginOauth(owner,readClient,redirect,{scope:'flux.context.read offline_access'}));
  for(const version of ['2025-06-18','2026-07-28']) {
    const denied=await raw(version,'tools/call',{name:'flux_create_proposal',arguments:{projectId:project.id,
      materialId:randomUUID(),version:1,clientCommandId:randomUUID(),fact:'probe',interpretation:'probe',suggestedAction:'probe'}},`Bearer ${readToken.access_token}`);
    assert.equal(denied.status,200);assert.ok(denied.message.error || denied.message.result?.isError);
    probes.push({kind:'denied-scope',version,status:denied.status,error:denied.message.error ?? denied.message.result?.content});
  }
  const badLegacy=await raw('2024-11-05','initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'probe',version:'1'}});
  assert.equal(badLegacy.status,400);assert.equal(badLegacy.message.error.code,-32022);
  probes.push({kind:'unsupported-legacy',...badLegacy});
  const badModern=await raw('2027-01-01','server/discover');assert.equal(badModern.status,400);
  assert.equal(badModern.message.error.code,-32022);probes.push({kind:'unsupported-modern',...badModern});
  const mismatch=await raw('2026-07-28','tools/list',{},nativeBearer,'2025-06-18','2026-07-28');
  assert.equal(mismatch.status,400);assert.ok(!mismatch.message.result?.tools);probes.push({kind:'modern-header-mismatch',...mismatch});
  const missingHeader=await raw('2025-06-18','tools/list',{},nativeBearer,'');
  assert.equal(missingHeader.status,400);probes.push({kind:'legacy-missing-version',...missingHeader});
  expect(await owner.request('DELETE', `/api/v1/agent-connections/${connection.id}`),204);
  for(const version of ['2025-06-18','2026-07-28']) {
    const revoked=await raw(version,'tools/list');assert.equal(revoked.status,403);
    assert.ok(!JSON.stringify(revoked.message).includes('Selected research'));probes.push({kind:'revoked',version,...revoked});
  }
  for(const [name,flags] of [['prototype-revoked-default',[]],['prototype-revoked-flagged',['--enable','mcp_2026_07_28']]] as const) {
    const revoked=await runCase(name,[...flags]);assert.equal(revoked.names.length,0);
    assert.ok(revoked.protocolExchanges.some(value=>value.httpStatus===403));
  }
  const report = { serverHead: process.env.FLUX_GIT_COMMIT, clientVersion: version.output.match(/codex-cli \S+/)?.[0], versionPathAliasWarning: version.output.includes('Refusing to create helper binaries'), featureLineBefore,
    codexBinarySha256: createHash('sha256').update(readFileSync('/usr/local/bin/codex')).digest('hex'),
    researchPatchSha256: process.env.FLUX_RESEARCH_PATCH_SHA256, probes, playbookReference: coworkPlaybookReference(),
    configMutationFromFlag: false, cases, setupProtocolExchanges: exchanges.filter(value => value.phase === 'setup'),
    boundaries: { realClient: true, realFluxOAuth: true, seededOAuthClient: true, model: 'local scripted fixture only', vendorAccount: false, vendorKey: false, vendorSpend: 0, fullStartResume: 'not assessed' } };
  writeFileSync('/evidence/results.json', JSON.stringify(report, null, 2));
  console.log('PROTOTYPE_RESEARCH_PASSED');
} finally {
  await heldModel?.close(); await browser.close(); proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve)); await pool.end();
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
}
