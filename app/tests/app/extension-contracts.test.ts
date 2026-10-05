import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { PROJECT_EXPORT_BUNDLE_QUERY, PROJECT_EXPORT_FORMAT, PROJECT_EXPORT_FORMAT_VERSION, PROJECT_EXPORT_JSON_SCHEMA,
  PROJECT_EXPORT_SCHEMA_ID, projectExportPath, type ProjectExport, type ProjectExportManifest } from '@flux/contracts';
import { COWORK_PLAYBOOK, renderCoworkPlaybook } from '@flux/core';
import { assertPinned, compareExact, compareKeyed, compareSchema, compareSet, contractReport, structural,
  type ContractChange } from './support/contract-compat.js';
import { pool } from './support/db.js';
import { apiUrl, publicOrigin, register, uniqueEmail } from './support/http.js';
import { beginOauth, expect, mcp, oauthToken, toolValue } from './support/mcp.js';
import { expectStatus, person, project, workspace } from './support/people.js';

// Public extension contracts of v0.1 (O-009, #251, docs/product/extension-contracts.md):
// EXT-1 the MCP tool contract and EXT-2 the project export format, each pinned to a
// versioned snapshot in tests/app/contracts/. A breaking change fails unless the
// contract version is bumped and a new snapshot is added.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- snapshot JSON is untyped
type Json = any;
const root = resolve(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Error codes raised as string literals in the server and core source. */
function sourceErrorCodes() {
  const codes = new Set<string>();
  for (const dir of ['apps/server/src', 'packages/core/src'])
    for (const file of sourceFiles(join(root, dir)))
      for (const match of readFileSync(file, 'utf8').matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)) codes.add(match[1]!);
  return codes;
}

const sorted = (values: Iterable<string>) => [...values].sort();
const names = (value: Json) => sorted(Object.keys(value ?? {}));

// --- EXT-1: MCP tool contract ---------------------------------------------------------------

/** A new prompt argument is additive only when it is optional. */
function promptArguments(before: Json[], after: Json[], path: string): ContractChange[] {
  return compareKeyed(before, after, (argument: Json) => argument.name, path, (a, b, at) => a.required === b.required ? []
    : [{ path: at, kind: b.required ? 'breaking' : 'additive', detail: b.required ? 'now required' : 'no longer required' }])
    .map((change) => change.detail === 'added' && after.find((argument) => `${path}.${argument.name}` === change.path)?.required
      ? { ...change, kind: 'breaking' as const, detail: 'added as required' } : change);
}

function compareMcp(before: Json, after: Json): ContractChange[] {
  const text = (a: Json, b: Json, at: string): ContractChange[] => a === b ? [] : [{ path: at, kind: 'additive', detail: 'text changed' }];
  return [
    ...compareExact(before.contract, after.contract, 'contract'),
    ...compareExact(before.toolContractVersion, after.toolContractVersion, 'toolContractVersion'),
    ...compareExact(before.endpoint, after.endpoint, 'endpoint'),
    ...compareExact(before.protectedResource?.resource, after.protectedResource?.resource, 'protectedResource.resource'),
    ...compareSet(before.protectedResource?.scopes, after.protectedResource?.scopes, 'protectedResource.scopes'),
    ...compareKeyed(before.tools ?? [], after.tools ?? [], (tool: Json) => tool.name, 'tools', (a, b, at) => [
      ...text(a.title, b.title, `${at}.title`),
      ...compareExact(a.requiredScope, b.requiredScope, `${at}.requiredScope`),
      ...compareExact(a.operation, b.operation, `${at}.operation`),
      ...compareExact(a.classes, b.classes, `${at}.classes`),
      ...compareExact(a.annotations, b.annotations, `${at}.annotations`),
      ...compareSchema(a.inputSchema, b.inputSchema, 'input', `${at}.inputSchema`),
    ]),
    ...compareKeyed(before.prompts ?? [], after.prompts ?? [], (prompt: Json) => prompt.name, 'prompts', (a, b, at) => [
      ...text(a.title, b.title, `${at}.title`),
      ...promptArguments(a.arguments ?? [], b.arguments ?? [], `${at}.arguments`),
    ]),
    ...compareKeyed(before.resources ?? [], after.resources ?? [], (resource: Json) => resource.name, 'resources', (a, b, at) => [
      ...compareExact(a.uri, b.uri, `${at}.uri`), ...compareExact(a.mimeType, b.mimeType, `${at}.mimeType`)]),
    ...compareKeyed(before.resourceTemplates ?? [], after.resourceTemplates ?? [], (resource: Json) => resource.name, 'resourceTemplates', (a, b, at) => [
      ...compareExact(a.uriTemplate, b.uriTemplate, `${at}.uriTemplate`), ...compareExact(a.mimeType, b.mimeType, `${at}.mimeType`)]),
    ...compareExact(before.errorEnvelope, after.errorEnvelope, 'errorEnvelope'),
    ...compareSet(before.errorCodes, after.errorCodes, 'errorCodes'),
    ...compareExact(before.bootstrap?.contractVersion, after.bootstrap?.contractVersion, 'bootstrap.contractVersion'),
    ...compareSet(before.bootstrap?.keys, after.bootstrap?.keys, 'bootstrap.keys'),
    ...compareSet(before.bootstrap?.trusted, after.bootstrap?.trusted, 'bootstrap.trusted'),
    ...compareSet(before.bootstrap?.capability, after.bootstrap?.capability, 'bootstrap.capability'),
  ];
}

async function connectedAgent() {
  const { browser: owner } = await register(uniqueEmail('contracts'), 'correct horse battery staple');
  const ws = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Contract pins' } }), 201);
  const agent = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Contract agent', owner: 'self' } }), 201);
  const place = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/projects`, { body: { name: 'Contract project', visibility: 'restricted' } }), 201);
  expect(await owner.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const scopes = ['flux.context.read', 'flux.proposal.write'];
  const connection = expect(await owner.request('POST', '/api/v1/agent-connections', { body: { agentId: agent.id, selectedProjectIds: [place.id], scopes } }), 201);
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client
    (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
     response_types, scopes, require_pkce, created_at, updated_at)
    VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], [...scopes, 'offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())',
    [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const tokens = await oauthToken(owner, String(connection.id), clientId, redirectUri, await beginOauth(owner, clientId, redirectUri));
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
  return { projectId: String(place.id), call, list };
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
    'bootstrap reports the tool contract version the snapshot is keyed by');

  // A refused call shows the error envelope: no action scope on this connection.
  const refused = (await f.call('tools/call', { name: 'flux_create_task', arguments: { projectId: f.projectId,
    runtimeSessionId: (bootstrap.runtime as Json).id, grantId: randomUUID(), clientCommandId: randomUUID(),
    peerRequestClass: 'plan', sources: [], task: { title: 'Refused without the action scope' } } })).message!.result as Json;
  const envelope = JSON.parse(refused.content[0].text);
  assert.equal(envelope.code, 'MCP_SCOPE_REQUIRED');

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
      return { name: tool.name, title: tool.title ?? null, requiredScope: capability?.requiredScope ?? null, operation: capability?.operation ?? null,
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

function compareExport(before: Json, after: Json): ContractChange[] {
  return [
    ...['contract', 'format', 'formatVersion', 'schemaId', 'path', 'bundleQuery'].flatMap((key) => compareExact(before[key], after[key], key)),
    ...['root', 'contentType', 'manifestFormat', 'manifestFormatVersion'].flatMap((key) => compareExact(before.bundle?.[key], after.bundle?.[key], `bundle.${key}`)),
    ...compareSet(before.bundle?.paths, after.bundle?.paths, 'bundle.paths'),
    ...compareSet(before.bundle?.manifestKeys, after.bundle?.manifestKeys, 'bundle.manifestKeys'),
    ...compareSet(before.bundle?.manifestFileKeys, after.bundle?.manifestFileKeys, 'bundle.manifestFileKeys'),
    ...compareSchema(before.schema, after.schema, 'output', 'schema'),
  ];
}

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
  assert.equal(document.formatVersion, PROJECT_EXPORT_FORMAT_VERSION, 'a real export carries the pinned format version');
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

describe('public extension contracts (O-009)', () => {
  test('EXT-1: the MCP tool contract matches its versioned snapshot', async () => {
    const version = COWORK_PLAYBOOK.toolContractVersion;
    let snapshotCodes: string[] = [];
    try { snapshotCodes = JSON.parse(readFileSync(new URL(`./contracts/mcp-tools.v${version}.json`, import.meta.url), 'utf8')).errorCodes ?? []; }
    catch { /* a missing snapshot is reported by assertPinned */ }
    const live = await liveMcpContract(snapshotCodes);
    assert.ok(live.tools.length > 0 && live.tools.every((tool) => tool.name.startsWith('flux_') && tool.requiredScope), 'every tool has a scope');
    assertPinned('mcp-tools', version, live, compareMcp);
  });

  test('EXT-2: the project export format matches its versioned snapshot', async () => {
    assert.equal(PROJECT_EXPORT_FORMAT, 'flux.project-export');
    assert.equal(PROJECT_EXPORT_SCHEMA_ID, `https://flux.coldphase.dev/schemas/project-export.v${PROJECT_EXPORT_FORMAT_VERSION}.json`,
      'the schema id names the format version');
    const live = await liveExportContract();
    assertPinned('project-export', PROJECT_EXPORT_FORMAT_VERSION, live, compareExport);
  });

  test('the classifier treats inputs and outputs in opposite directions and names every change', () => {
    const base = { type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string', format: 'uuid' }, status: { enum: ['open', 'done'] }, note: { type: 'string', maxLength: 100 } } };
    const kinds = (changes: ContractChange[]) => changes.map((change) => `${change.kind} ${change.path}: ${change.detail}`);
    const edit = (patch: (copy: Json) => void) => { const copy = structuredClone(base) as Json; patch(copy); return copy; };

    // Input (MCP arguments): the new schema must accept everything the old one accepted.
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.extra = { type: 'string' }; }), 'input')), ['additive $.properties.extra: property added']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.extra = { type: 'string' }; s.required.push('extra'); }), 'input')),
      ['breaking $.properties.extra: now required', 'additive $.properties.extra: property added']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { delete s.properties.note; }), 'input')), ['breaking $.properties.note: property removed']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.status.enum.push('blocked'); }), 'input')),
      ['additive $.properties.status.enum: enum values added: ["blocked"]']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.status.enum = ['open']; }), 'input')),
      ['breaking $.properties.status.enum: enum values removed: ["done"]']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.note.maxLength = 50; }), 'input')), ['breaking $.properties.note.maxLength: maxLength 100 → 50']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.note.maxLength = 500; }), 'input')), ['additive $.properties.note.maxLength: maxLength 100 → 500']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.note.pattern = '^a'; }), 'input')), ['breaking $.properties.note.pattern: pattern constraint added']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.id.type = 'integer'; }), 'input')), ['breaking $.properties.id.type: type "string" → "integer"']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.required = []; }), 'input')), ['additive $.properties.id: no longer required']);

    // Output (export documents): the new output must keep every old guarantee for a reader that ignores unknown fields.
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.extra = { type: 'string' }; s.required.push('extra'); }), 'output')),
      ['additive $.properties.extra: now required', 'additive $.properties.extra: property added']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.required = []; }), 'output')), ['breaking $.properties.id: no longer required']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { delete s.properties.note; }), 'output')), ['breaking $.properties.note: property removed']);
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.status.enum.push('blocked'); }), 'output')),
      ['additive $.properties.status.enum: enum values added: ["blocked"]']);
    assert.ok(kinds(compareSchema(base, edit((s) => { s.properties.id = { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] }; }), 'output'))
      .some((line) => line.startsWith('breaking $.properties.id.type')), 'a field that becomes nullable breaks readers');
    assert.deepEqual(kinds(compareSchema(base, edit((s) => { s.properties.note.maxLength = 500; }), 'output')), ['breaking $.properties.note.maxLength: maxLength 100 → 500']);
    assert.deepEqual(kinds(compareSchema(base, { ...base, title: 'Renamed' }, 'output')), ['additive $.title: text changed']);

    // `structural` drops description keywords but keeps a property that is named `description`.
    assert.deepEqual(structural({ type: 'object', description: 'gone', required: ['b', 'a'], properties: { description: { type: 'string', description: 'gone' } } }),
      { type: 'object', required: ['a', 'b'], properties: { description: { type: 'string' } } });
  });

  test('a renamed tool, a changed scope and a missing snapshot fail with the version advice', () => {
    const tool = (name: string, requiredScope = 'flux.context.read') => ({ name, title: name, requiredScope, operation: null, classes: [], annotations: null,
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] } });
    const snapshot = { contract: 'flux.mcp-tools', toolContractVersion: 1, tools: [tool('flux_get_work'), tool('flux_list_work')] };
    const renamed = { ...snapshot, tools: [tool('flux_read_work'), tool('flux_list_work')] };
    const changes = compareMcp(snapshot, renamed);
    assert.deepEqual(changes.map((change) => `${change.kind} ${change.path}`), ['breaking tools.flux_get_work', 'additive tools.flux_read_work']);
    const report = contractReport('mcp-tools', 1, snapshot, renamed, changes)!;
    assert.match(report, /^BREAKING change to mcp-tools version 1\. Do not edit tests\/app\/contracts\/mcp-tools\.v1\.json: bump the version to 2/);
    assert.ok(report.includes('CONTRACT-SNAPSHOT mcp-tools.v1.json {'), 'the report carries the running contract');

    const rescoped = { ...snapshot, tools: [tool('flux_get_work', 'flux.action.execute'), tool('flux_list_work')] };
    assert.deepEqual(compareMcp(snapshot, rescoped).map((change) => `${change.kind} ${change.path}`), ['breaking tools.flux_get_work.requiredScope']);

    const added = { ...snapshot, tools: [...snapshot.tools, tool('flux_get_result')] };
    assert.match(contractReport('mcp-tools', 1, snapshot, added, compareMcp(snapshot, added))!, /^Additive change to mcp-tools version 1\. Replace /);
    assert.equal(contractReport('mcp-tools', 1, snapshot, structuredClone(snapshot), []), null, 'an equal contract passes');
    assert.match(contractReport('mcp-tools', 2, null, snapshot, [])!, /^No snapshot tests\/app\/contracts\/mcp-tools\.v2\.json/);
    assert.throws(() => assertPinned('mcp-tools', 3, snapshot, compareMcp), /the snapshot of version 2 must stay/,
      'a bumped version keeps every older snapshot');
  });
});
