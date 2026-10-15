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
    const unsupportedHeader = await send(initialize(), { 'mcp-protocol-version': '2025-11-25' }); assert.equal(unsupportedHeader.status, 400);
    assert.equal(unsupportedHeader.message.error.code, -32022); assert.equal(unsupportedHeader.message.id, 1);
    assert.deepEqual(unsupportedHeader.message.error.data, { requested: '2025-11-25', supported: [legacy] });
    // A modern header on a legacy initialize stays on the SDK's modern refusal (header/body mismatch); it never reaches legacy handling.
    const modernHeader = await send(initialize(), { 'mcp-protocol-version': modern }); assert.equal(modernHeader.status, 400);
    assert.equal(modernHeader.message.error.code, -32020); assert.equal(modernHeader.message.id, 1); assert.equal(modernHeader.message.result, undefined);
  });
  await t.test('initialize offering modern 2026-07-28 is a refused legacy handshake, never negotiated through initialize', async () => {
    const reply = await send(initialize(modern)); assert.equal(reply.status, 400);
    assert.equal(reply.message.error.code, -32022); assert.equal(reply.message.id, 1);
    assert.deepEqual(reply.message.error.data, { requested: modern, supported: [legacy] });
    assert.equal(reply.message.result, undefined);
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
    const missing = await send(list); assert.equal(missing.status, 400); assert.equal(missing.message.error.code, -32022);
    assert.deepEqual(missing.message.error.data, { requested: 'unknown', supported: [legacy] });
    assert.equal((await send(list, { 'mcp-protocol-version': legacy })).status, 200);
    // A modern-format request that claims the legacy revision is modern-classified: it is refused with the modern support list.
    const claimed = await send(modernRequest(legacy), { 'mcp-protocol-version': legacy, 'mcp-method': 'tools/list' });
    assert.equal(claimed.status, 400); assert.equal(claimed.message.error.code, -32022);
    assert.deepEqual(claimed.message.error.data, { requested: legacy, supported: [modern] });
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
      assert.equal(reply.status, 400); assert.equal(reply.message.error.code, -32600); assert.equal(reply.message.id, null);
      assert.deepEqual(await counts(), before);
    }
    // A mixed-era array with a valid legacy write and a modern request member is refused whole, with no side effect.
    const mixed = [{ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'flux_create_task', arguments: {
      projectId: f.projectId, runtimeSessionId: f.runtimeSessionId, grantId: grant.id, peerRequestClass: 'execute',
      clientCommandId: randomUUID(), task: { title: 'Forbidden mixed-era effect' } } } }, modernRequest()];
    const mixedReply = await send(mixed, { 'mcp-protocol-version': legacy });
    assert.equal(mixedReply.status, 400); assert.equal(mixedReply.message.error.code, -32600); assert.equal(mixedReply.message.id, null);
    assert.deepEqual(await counts(), before);
  });
  await t.test('revoked authority also refuses initialized notification and legacy GET', async () => {
    expect(await f.owner.request('DELETE', `/api/v1/agent-connections/${f.connectionId}`), 204);
    assert.equal((await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 403);
    assert.equal((await send(null, { 'mcp-protocol-version': legacy }, 'GET')).status, 403);
  });
});
