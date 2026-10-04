import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { listAssignedWork } from '../../apps/web/src/work/api.js';

/**
 * Home's Tasks (#190 HOME-2, #211 review A2.1): the display cap is shared across workspaces, but
 * every workspace's total is still read, so "Showing N of M" counts the tasks the cap hid.
 */
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const item = (value: number) => ({ id: id(value), projectId: id(900), title: `Task ${value}`, status: 'open', updatedAt: '2026-10-01T09:00:00.000Z' });

/** The assigned-work API of two workspaces: A holds 500 of the caller's tasks, B holds 10. */
function serve(totals: Record<string, number>) {
  const requests: { workspace: string; limit: number; offset: number }[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://flux.test');
    const workspace = /\/workspaces\/([^/]+)\/work\/assigned$/.exec(url.pathname)?.[1];
    assert.ok(workspace && workspace in totals, `unexpected request ${url.pathname}`);
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset'));
    assert.ok(limit >= 1 && limit <= 100, `limit ${limit} is within the API's page size`);
    requests.push({ workspace, limit, offset });
    const base = workspace === 'a' ? 0 : 10_000;
    const total = totals[workspace]!;
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => item(base + offset + index));
    return new Response(JSON.stringify({ items, total }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return requests;
}

test('a workspace after the cap is full is still asked for its total, with a one-row page', async () => {
  const requests = serve({ a: 500, b: 10 });
  const first = await listAssignedWork('a', 500);
  assert.equal(first.items.length, 500);
  assert.equal(first.total, 500);
  const second = await listAssignedWork('b', 500 - first.items.length);
  assert.deepEqual(second.items, [], 'nothing is shown past the cap');
  assert.equal(second.total, 10, "B's tasks are counted, so Home says Showing 500 of 510");
  assert.deepEqual(requests.filter((request) => request.workspace === 'b'), [{ workspace: 'b', limit: 1, offset: 0 }]);
});

test('a cap reached part-way through a workspace keeps its whole total and stops paging', async () => {
  const requests = serve({ a: 30, b: 250 });
  const first = await listAssignedWork('a', 120);
  assert.equal(first.items.length, 30);
  const second = await listAssignedWork('b', 120 - first.items.length);
  assert.equal(second.items.length, 90);
  assert.equal(second.total, 250);
  assert.deepEqual(requests.filter((request) => request.workspace === 'b').map((request) => request.offset), [0], 'one page holds the 90 shown');
});
