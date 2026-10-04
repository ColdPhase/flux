import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page, WorkItem } from '@flux/contracts';
import { readAssignedAcross } from '../../apps/web/src/work/assigned.js';

/**
 * Home's Tasks (#190 HOME-2, #211 review A2.1): the display cap is shared across workspaces, but
 * every workspace's total is still read, so "Showing N of M" counts the tasks the cap hid.
 */
const CAP = 500;
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const item = (value: number) => ({ id: id(value), projectId: id(900), title: `Task ${value}`, status: 'open', updatedAt: '2026-10-01T09:00:00.000Z' }) as unknown as WorkItem;

/** One workspace's assigned-work API holding `total` of the caller's tasks; requests are recorded. */
function workspace(total: number, base: number) {
  const requests: { limit: number; offset: number }[] = [];
  const readPage = async (limit: number, offset: number): Promise<Page<WorkItem>> => {
    assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 100, `limit ${limit} is a valid page size`);
    requests.push({ limit, offset });
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => item(base + offset + index));
    return { items, total } as Page<WorkItem>;
  };
  return { readPage, requests };
}

/** Home's Tasks across workspaces in order, as HomeTasks reads them: the items shown and the sum of every total. */
async function acrossWorkspaces(spaces: ReturnType<typeof workspace>[]) {
  const byId = new Map(spaces.map((space, index) => [`ws-${index}`, space]));
  const read = await readAssignedAcross([...byId.keys()], (workspaceId, limit, offset) => byId.get(workspaceId)!.readPage(limit, offset), CAP);
  assert.equal(read.failed, false);
  assert.equal(new Set(read.items.map((one) => one.id)).size, read.items.length, 'no task twice');
  return { shown: read.items.length, total: read.total };
}

test('a workspace after the cap is full is still asked for its total, with a one-row page', async () => {
  // The review's example: 500 tasks in workspace A and 10 in B.
  const a = workspace(500, 0);
  const b = workspace(10, 10_000);
  assert.deepEqual(await acrossWorkspaces([a, b]), { shown: 500, total: 510 }, 'Home says "Showing 500 of 510"');
  assert.equal(a.requests.length, 5);
  assert.deepEqual(b.requests, [{ limit: 1, offset: 0 }], "B's total is read with one row, not its pages");
});

test('three workspaces after a full cap each add their total', async () => {
  const spaces = [workspace(620, 0), workspace(3, 10_000), workspace(0, 20_000), workspace(140, 30_000)];
  assert.deepEqual(await acrossWorkspaces(spaces), { shown: 500, total: 763 });
  for (const later of spaces.slice(1)) assert.deepEqual(later.requests, [{ limit: 1, offset: 0 }]);
});

test('a cap reached part-way through a workspace keeps its whole total and stops paging', async () => {
  const a = workspace(430, 0);
  const b = workspace(250, 10_000);
  assert.deepEqual(await acrossWorkspaces([a, b]), { shown: 500, total: 680 });
  assert.deepEqual(b.requests.map((request) => request.offset), [0], 'one page holds the 70 shown');
});

test('under the cap every page is read', async () => {
  const a = workspace(230, 0);
  const b = workspace(10, 10_000);
  assert.deepEqual(await acrossWorkspaces([a, b]), { shown: 240, total: 240 });
  assert.deepEqual(a.requests.map((request) => request.offset), [0, 100, 200]);
});

test('a workspace that cannot be read is reported, and the others still count', async () => {
  const a = workspace(20, 0);
  const read = await readAssignedAcross(['a', 'broken', 'c'], (workspaceId, limit, offset) => {
    if (workspaceId === 'broken') return Promise.reject(new Error('unreachable'));
    return (workspaceId === 'a' ? a : workspace(5, 10_000)).readPage(limit, offset);
  }, CAP);
  assert.deepEqual({ shown: read.items.length, total: read.total, failed: read.failed }, { shown: 25, total: 25, failed: true });
});
