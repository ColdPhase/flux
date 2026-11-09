import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { PROJECT_EXPORT_BUNDLE_QUERY, PROJECT_EXPORT_FORMAT, PROJECT_EXPORT_FORMAT_VERSION, PROJECT_EXPORT_JSON_SCHEMA,
  PROJECT_EXPORT_SCHEMA_ID, projectExportPath, type ProjectExport, type ProjectExportManifest } from '@flux/contracts';
import { createConnection, oauthTokenFor } from './support/mcp-actions.js';
import { COWORK_PLAYBOOK, renderCoworkPlaybook } from '@flux/core';
import { assertPinned, contractReport, differences, structural } from './support/contract-snapshot.js';
import { pool } from './support/db.js';
import { apiUrl, publicOrigin, register, uniqueEmail } from './support/http.js';
import { expect, mcp, toolValue } from './support/mcp.js';
import { expectStatus, person, project, workspace } from './support/people.js';

// Public extension contracts (O-010, #251, docs/product/extension-contracts.md): EXT-1 the MCP
// tool contract and EXT-2 the project export format, each pinned to its one current snapshot in
// tests/app/contracts/. A change to either fails until the snapshot is edited in the same PR;
// nothing is kept compatible before the first public release.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- snapshot JSON is untyped
type Json = any;
const root = resolve(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Server/core codes plus the DB-owned task-use refusals the composition roots map unchanged. */
function sourceErrorCodes() {
  const codes = new Set<string>();
  const files = ['apps/server/src', 'packages/core/src'].flatMap((dir) => sourceFiles(join(root, dir)));
  files.push(join(root, 'packages/db/src/repositories/task-use.ts'));
  for (const file of files)
    for (const match of readFileSync(file, 'utf8').matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)) codes.add(match[1]!);
  return codes;
}

const sorted = (values: Iterable<string>) => [...values].sort();
const names = (value: Json) => sorted(Object.keys(value ?? {}));

// --- EXT-1: MCP tool contract ---------------------------------------------------------------

async function connectedAgent() {
  const { browser: owner } = await register(uniqueEmail('contracts'), 'correct horse battery staple');
  const ws = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Contract pins' } }), 201);
  const agent = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Contract agent', owner: 'self' } }), 201);
  const place = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Contract project', visibility: 'restricted' } }), 201);
  const connection = await createConnection(pool, owner, { agentId: String(agent.id) });
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
     response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
    [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const tokens = await oauthTokenFor(pool, owner, String(connection.id), clientId, redirectUri);
  let id = 500;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await mcp(tokens.access_token, id++, method, params);
    assert.equal(response.status, 200, `MCP ${method} returned ${response.status}`);
    assert.ok(response.message && !response.message.error, `${method}: ${JSON.stringify(response.message?.error)}`);
    return response;
  };
  /** Every page of a list method. */
  const list = async (method: string, key: string) => {
    const items: Json[] = [];
    let cursor: string | undefined;
    do {
      const result = (await call(method, cursor ? { cursor } : {})).message!.result as Json;
      items.push(...result[key]);
      cursor = result.nextCursor;
    } while (cursor);
    return items;
  };
  return { projectId: String(place.id), call, list, owner, connectionId: String(connection.id) };
}

/** The running MCP contract, in the canonical form of the snapshot. */
async function liveMcpContract(snapshotCodes: readonly string[]) {
  const f = await connectedAgent();
  const tools = await f.list('tools/list', 'tools');
  const prompts = await f.list('prompts/list', 'prompts');
  const resources = await f.list('resources/list', 'resources');
  const templates = await f.list('resources/templates/list', 'resourceTemplates');
  const bootstrap = toolValue((await f.call('tools/call', { name: 'flux_bootstrap',
    arguments: { projectId: f.projectId, clientSessionId: randomUUID() } })).message);
  const capabilities = new Map((bootstrap.capabilities as Json[]).map((row) => [row.name, row]));
  assert.deepEqual(sorted(capabilities.keys()), sorted(tools.map((tool) => tool.name)), 'bootstrap capabilities name exactly the listed tools');
  assert.equal((bootstrap.trusted as Json).playbook.toolContractVersion, COWORK_PLAYBOOK.toolContractVersion,
    'bootstrap reports the current tool contract version');

  // A refused call shows the error envelope: an agent set to Only read (#859; there are no scopes to be refused for).
  const reader = await connectedAgent();
  expect(await reader.owner.request('PATCH', `/api/v1/agent-connections/${reader.connectionId}`, { body: { mayDo: 'read' } }), 200);
  const refused = (await reader.call('tools/call', { name: 'flux_create_task', arguments: { projectId: reader.projectId,
    clientCommandId: randomUUID(), task: { title: 'Refused: the agent only reads' } } })).message!.result as Json;
  const envelope = JSON.parse(refused.content[0].text);
  assert.equal(envelope.code, 'AGENT_ONLY_READS');

  const metadata = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', apiUrl));
  assert.equal(metadata.status, 200);
  const resource = await metadata.json() as Json;

  // Documented codes stay listed while the source still raises them; codes the playbook names must be listed.
  const raised = sourceErrorCodes();
  const playbookCodes = renderCoworkPlaybook().match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  const errorCodes = sorted(new Set([...snapshotCodes.filter((code) => raised.has(code)), ...playbookCodes, envelope.code]));

  const version = COWORK_PLAYBOOK.version;
  return {
    contract: 'flux.mcp-tools',
    toolContractVersion: COWORK_PLAYBOOK.toolContractVersion,
    endpoint: '/mcp',
    protectedResource: { resource: String(resource.resource).replace(publicOrigin, '{origin}'), scopes: sorted(resource.scopes_supported ?? []) },
    tools: tools.map((tool) => {
      const capability = capabilities.get(tool.name);
      return { name: tool.name, title: tool.title ?? null, operation: capability?.operation ?? null,
        classes: [...capability?.classes ?? []], annotations: tool.annotations ?? null, inputSchema: structural(tool.inputSchema) };
    }).sort((a, b) => a.name.localeCompare(b.name)),
    prompts: prompts.map((prompt) => ({ name: prompt.name, title: prompt.title ?? null,
      arguments: (prompt.arguments ?? []).map((argument: Json) => ({ name: argument.name, required: argument.required === true }))
        .sort((a: Json, b: Json) => a.name.localeCompare(b.name)) })).sort((a, b) => a.name.localeCompare(b.name)),
    resources: resources.map((item) => ({ name: item.name, uri: String(item.uri).replace(`/${version}`, '/{version}'), mimeType: item.mimeType ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    resourceTemplates: templates.map((item) => ({ name: item.name, uriTemplate: item.uriTemplate, mimeType: item.mimeType ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    errorEnvelope: { isError: refused.isError === true, contentType: refused.content[0].type, keys: names(envelope) },
    errorCodes,
    bootstrap: { contractVersion: bootstrap.contractVersion as Json, keys: names(bootstrap), trusted: names(bootstrap.trusted),
      capability: names((bootstrap.capabilities as Json[])[0]) },
  };
}

// --- EXT-2: project export format --------------------------------------------------------------

/** Reads a ustar archive: path → content. */
function untar(archive: Buffer) {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim(), 8);
    files.set(prefix ? `${prefix}/${name}` : name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The running export contract, from a real bundle of a project with a doc and a published file. */
async function liveExportContract() {
  const owner = await person('Export contract owner');
  const ws = await workspace(owner, 'Export contract');
  const place = await project(owner, ws.id, 'Export contract project', 'restricted');
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`, { body: { title: 'Contract notes', body: 'Pinned.' } }), 201);
  const uploaded = await fetch(new URL(`/api/v1/projects/${place.id}/files?uploadId=${randomUUID()}&name=contract.txt`, owner.browser.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: owner.browser.cookieHeader(), origin: owner.browser.defaultOrigin },
    body: Buffer.from('contract file'),
  });
  assert.equal(uploaded.status, 201, 'staged upload');
  const staged = await uploaded.json() as { id: string };
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
    { body: { body: 'With a file', attachmentIds: [staged.id], clientMessageId: randomUUID() } }), 201);

  const response = await fetch(new URL(`${projectExportPath(place.id)}?${PROJECT_EXPORT_BUNDLE_QUERY}`, apiUrl),
    { headers: { cookie: owner.browser.cookieHeader(), origin: publicOrigin } });
  assert.equal(response.status, 200);
  const files = untar(gunzipSync(Buffer.from(await response.arrayBuffer())));
  const bundleRoot = [...files.keys()][0]!.split('/')[0]!;
  const read = (path: string) => JSON.parse(files.get(`${bundleRoot}/${path}`)!.toString('utf8')) as Json;
  const manifest = read('manifest.json') as ProjectExportManifest;
  const document = read('project.json') as ProjectExport;
  assert.equal(document.formatVersion, PROJECT_EXPORT_FORMAT_VERSION, 'a real export carries the current format version');
  assert.deepEqual(read('schema/project-export.v1.schema.json'), JSON.parse(JSON.stringify(PROJECT_EXPORT_JSON_SCHEMA)));
  const normalize = (path: string) => path.replace(/^docs\/[^/]+\.md$/, 'docs/{docId}.md').replace(/^files\/[^/]+$/, 'files/{fileId}');
  return {
    contract: 'flux.project-export',
    format: document.format,
    formatVersion: document.formatVersion,
    schemaId: document.$schema,
    path: projectExportPath('{projectId}'),
    bundleQuery: PROJECT_EXPORT_BUNDLE_QUERY,
    bundle: {
      root: bundleRoot.replace(place.id.slice(0, 8), '{projectIdPrefix}').replace(/\d{8}T\d{6}Z$/, '{exportedAt}'),
      contentType: response.headers.get('content-type'),
      paths: sorted(new Set([...files.keys()].map((path) => normalize(path.slice(bundleRoot.length + 1))))),
      manifestFormat: manifest.format,
      manifestFormatVersion: manifest.formatVersion,
      manifestKeys: names(manifest),
      manifestFileKeys: names(manifest.files[0]),
    },
    schema: structural(read('schema/project-export.v1.schema.json')),
  };
}

// --- Tests -----------------------------------------------------------------------------------------

describe('public extension contracts (O-010)', () => {
  test('EXT-1: the MCP tool contract matches its snapshot', async () => {
    let snapshotCodes: string[] = [];
    try { snapshotCodes = JSON.parse(readFileSync(new URL('./contracts/mcp-tools.json', import.meta.url), 'utf8')).errorCodes ?? []; }
    catch { /* a missing snapshot is reported by assertPinned */ }
    const live = await liveMcpContract(snapshotCodes);
    assert.ok(live.tools.length > 0 && live.tools.every((tool) => tool.name.startsWith('flux_') && !('requiredScope' in tool)), 'every tool is a flux_ tool and none names a scope');
    assertPinned('mcp-tools', live);
  });

  test('EXT-2: the project export format matches its snapshot', async () => {
    assert.equal(PROJECT_EXPORT_FORMAT, 'flux.project-export');
    assert.equal(PROJECT_EXPORT_SCHEMA_ID, `https://flux.coldphase.dev/schemas/project-export.v${PROJECT_EXPORT_FORMAT_VERSION}.json`,
      'the schema id names the format version');
    const live = await liveExportContract();
    assertPinned('project-export', live);
  });

  test('a difference names every changed path, and a missing snapshot is reported', () => {
    const tool = (name: string, operation: string | null = null) => ({ name, title: name, operation, classes: [], annotations: null,
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] } });
    const snapshot = { contract: 'flux.mcp-tools', tools: [tool('flux_get_work'), tool('flux_list_work')] };

    assert.deepEqual(differences(snapshot, structuredClone(snapshot)), [], 'an equal contract has no difference');
    const renamed = { ...snapshot, tools: [tool('flux_read_work'), tool('flux_list_work')] };
    assert.deepEqual(differences(snapshot, renamed), [
      `$.tools[flux_get_work]: ${JSON.stringify(tool('flux_get_work'))} → missing`,
      `$.tools[flux_read_work]: missing → ${JSON.stringify(tool('flux_read_work'))}`]);
    const reworked = { ...snapshot, tools: [tool('flux_get_work', 'work.update'), tool('flux_list_work')] };
    assert.deepEqual(differences(snapshot, reworked), ['$.tools[flux_get_work].operation: null → "work.update"']);
    const required = structuredClone(snapshot);
    required.tools[1]!.inputSchema.required = [];
    assert.deepEqual(differences(snapshot, required), ['$.tools[flux_list_work].inputSchema.required[0]: "projectId" → missing']);

    const report = contractReport('mcp-tools', snapshot, reworked)!;
    assert.match(report, /^The running mcp-tools contract differs from tests\/app\/contracts\/mcp-tools\.json\. Replace the snapshot in the same PR/);
    assert.ok(report.includes('  $.tools[flux_get_work].operation: null → "work.update"'), 'the report lists the changed path');
    assert.ok(report.endsWith(`CONTRACT-SNAPSHOT mcp-tools.json ${JSON.stringify(reworked)}`), 'the report carries the running contract');
    assert.equal(contractReport('mcp-tools', snapshot, structuredClone(snapshot)), null, 'an equal contract passes');
    assert.match(contractReport('mcp-tools', null, snapshot)!, /^No snapshot tests\/app\/contracts\/mcp-tools\.json for mcp-tools\./);
    assert.throws(() => assertPinned('no-such-contract', snapshot), /No snapshot tests\/app\/contracts\/no-such-contract\.json/);

    // `structural` drops description keywords but keeps a property that is named `description`.
    assert.deepEqual(structural({ type: 'object', description: 'gone', required: ['b', 'a'], properties: { description: { type: 'string', description: 'gone' } } }),
      { type: 'object', required: ['a', 'b'], properties: { description: { type: 'string' } } });
  });
});
