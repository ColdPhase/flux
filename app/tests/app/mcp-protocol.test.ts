import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool } from './support/db.js';
import { apiUrl } from './support/http.js';
import { expect } from './support/mcp.js';
import { actionScene } from './support/mcp-actions.js';

// Real OAuth and the running HTTP endpoint. No patched identity or transport stub.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- decoded public JSON-RPC responses
type Json = any;
const legacy = '2025-06-18'; const modern = '2026-07-28';
const initialize = (version = legacy) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: version, capabilities: {}, clientInfo: { name: 'admission-wire-test', version: '1' },
} });
const modernRequest = (version = modern) => ({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: {
  'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'admission-wire-test', version: '1' },
} } });

test('two-era HTTP admission keeps exact revisions, notification semantics, modern isolation and atomic batch refusal', async (t) => {
  const f = await actionScene(pool);
  async function send(body: unknown, headers: Record<string, string> = {}, method = 'POST', bearer: string | null = f.accessToken) {
    const response = await fetch(new URL('/mcp', apiUrl), { method, headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      accept: 'application/json, text/event-stream', ...headers,
    }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    const text = await response.text(); let message: Json;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      for (const line of text.split('\n')) if (line.startsWith('data:')) {
        const item = JSON.parse(line.slice(5)); if (item.result || item.error) message = item;
      }
    } else if (text) message = JSON.parse(text);
    return { status: response.status, text, message, headers: response.headers };
  }
  await t.test('authentication precedes connection-specific protocol refusal', async () => {
    const denied = await send(initialize('2025-11-25'), {}, 'POST', null);
    assert.equal(denied.status, 401); assert.ok(denied.headers.get('www-authenticate'));
    assert.ok(!denied.text.includes('Planned project'));
  });
  await t.test('initialize accepts an absent or agreeing header and reports the exact legacy revision', async () => {
    for (const headers of [{}, { 'mcp-protocol-version': legacy }] as Record<string, string>[]) {
      const reply = await send(initialize(), headers); assert.equal(reply.status, 200);
      assert.equal(reply.message.result.protocolVersion, legacy);
      assert.ok(reply.message.result.instructions.includes('Flux co-work'));
    }
  });
  await t.test('unknown legacy offer and conflicting header cannot silently negotiate another era', async () => {
    for (const headers of [{}, { 'mcp-protocol-version': '2025-11-25' }] as Record<string, string>[]) {
      const reply = await send(initialize('2025-11-25'), headers); assert.equal(reply.status, 400);
      assert.equal(reply.message.error.code, -32022);
      assert.deepEqual(reply.message.error.data, { requested: '2025-11-25', supported: [legacy] });
    }
    for (const version of ['2025-11-25', modern]) assert.equal((await send(initialize(), { 'mcp-protocol-version': version })).status, 400);
  });
  await t.test('single valid initialized notification returns 202 with no body', async () => {
    for (const headers of [{}, { 'mcp-protocol-version': legacy }] as Record<string, string>[]) {
      const reply = await send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, headers);
      assert.equal(reply.status, 202); assert.equal(reply.text, '');
    }
  });
  await t.test('IDs, malformed parameters and unsupported notifications never get a success acknowledgment', async () => {
    for (const body of [
      { jsonrpc: '2.0', id: 9, method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: [] },
      { jsonrpc: '1.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
      { jsonrpc: '2.0', method: 'tools/list' },
    ]) assert.equal((await send(body, { 'mcp-protocol-version': legacy })).status, 400);
    assert.equal((await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': '2025-11-25' })).status, 400);
  });
  await t.test('ordinary legacy requests require their own header and refuse session methods', async () => {
    const list = { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} };
    assert.equal((await send(list)).status, 400);
    assert.equal((await send(list, { 'mcp-protocol-version': legacy })).status, 200);
    for (const method of ['GET', 'DELETE']) assert.equal((await send(null, { 'mcp-protocol-version': legacy }, method)).status, 405);
  });
  await t.test('modern revision errors list modern support only; malformed modern traffic cannot enter legacy', async () => {
    const unknown = await send(modernRequest('2027-01-01'), { 'mcp-protocol-version': '2027-01-01', 'mcp-method': 'tools/list' });
    assert.equal(unknown.status, 400); assert.equal(unknown.message.error.code, -32022);
    assert.deepEqual(unknown.message.error.data, { requested: '2027-01-01', supported: [modern] });
    const request = modernRequest();
    assert.equal((await send(request, { 'mcp-protocol-version': legacy, 'mcp-method': 'tools/list' })).status, 400);
    assert.equal((await send(request, { 'mcp-protocol-version': modern, 'mcp-method': 'tools/call' })).status, 400);
    assert.equal((await send(request, { 'mcp-protocol-version': modern })).status, 400);
    assert.equal((await send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { 'mcp-protocol-version': modern, 'mcp-method': 'tools/list' })).status, 400);
  });
  await t.test('media, malformed JSON, malformed initialize and oversized body keep actual refusal', async () => {
    assert.equal((await send('broken-json')).status, 400);
    assert.equal((await send(initialize(), { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: legacy } })).status, 400);
    assert.equal((await send(JSON.stringify({ padding: 'x'.repeat(5 * 1024 * 1024) }))).status, 413);
  });
  await t.test('arrays containing otherwise valid writes create no task, receipt or grant debit in either era', async () => {
    const grant = await f.grant('work.create', 'execute', 3);
    const counts = async () => ({ tasks: await f.tasks(), used: await f.used(grant.id), receipts:
      (await pool.query('SELECT count(*)::int AS n FROM agent_command_receipts WHERE connection_id=$1', [f.connectionId])).rows[0].n });
    const before = await counts();
    for (const version of [legacy, modern]) {
      const write = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'flux_create_task', arguments: {
        projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: grant.id,
        peerRequestClass: 'execute', clientCommandId: randomUUID(), task: { title: 'Forbidden batch effect' },
      }, ...(version === modern ? modernRequest().params : {}) } };
      const reply = await send([write], { 'mcp-protocol-version': version, ...(version === modern ? { 'mcp-method': 'tools/call', 'mcp-name': 'flux_create_task' } : {}) });
      assert.equal(reply.status, 400); assert.equal(reply.message.error.code, -32600); assert.deepEqual(await counts(), before);
    }
  });
  await t.test('revoked authority also refuses initialized notification and legacy GET', async () => {
    expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${f.connectionId}`), 204);
    assert.equal((await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 403);
    assert.equal((await send(null, { 'mcp-protocol-version': legacy }, 'GET')).status, 403);
  });
});
