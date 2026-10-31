import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SearchResponse, WorkItem } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace } from './support/people.js';

// #276 (F-023 FF-1): each project numbers its tasks "#1", "#2", … in creation order; a number is never reused or
// changed. Migration 0055 numbers existing tasks by creation time, and a trigger numbers every new one.

test('tasks created over the API get distinct consecutive numbers, also when created at once', async () => {
  const owner = await person('Task numbers owner');
  const ws = await workspace(owner, 'Numbers');
  const place = await project(owner, ws.id, 'Numbered tasks', 'restricted');
  const other = await project(owner, ws.id, 'Second project', 'restricted');
  const create = async (projectId: string, title: string) => expectStatus(await owner.browser.request('POST', `/api/v1/projects/${projectId}/work`,
    { body: { title }, headers: { 'idempotency-key': randomUUID() } }), 201) as WorkItem;
  const first = await create(place.id, 'Order probes');
  assert.equal(first.number, 1);
  const burst = await Promise.all(Array.from({ length: 20 }, (_, index) => create(place.id, `Burst ${index}`)));
  assert.deepEqual(burst.map((item) => item.number).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 2));
  assert.equal((await create(other.id, 'Elsewhere')).number, 1, 'each project counts on its own');
  const read = expectStatus(await owner.browser.request('GET', `/api/v1/work/${first.id}`), 200) as WorkItem;
  assert.equal(read.number, 1);
  const changed = expectStatus(await owner.browser.request('PATCH', `/api/v1/work/${first.id}`,
    { body: { title: 'Order six probes', clientCommandId: randomUUID() }, headers: { 'if-match': `"${read.version}"` } }), 200) as WorkItem;
  assert.equal(changed.number, 1, 'a change keeps the number');
});

test('"#n" finds the task in search, only for people who can open it', async () => {
  const owner = await person('Number search owner');
  const member = await person('Number search member');
  const reader = await person('Number search reader');
  const ws = await workspace(owner, 'Number search');
  await addMember(owner, ws.id, member, 'member');
  await addMember(owner, ws.id, reader, 'member');
  const place = await project(owner, ws.id, 'Hedge sensors', 'restricted');
  await grant(owner, place.id, reader, 'viewer');
  // 26 tasks: #20–#26 share the prefix "2", and two titles name the number 2 in words.
  const titles = ['Phase 2 walnut probes', 'Seal the barrel lid', 'Order 2 spare probes',
    ...Array.from({ length: 23 }, (_, index) => `Log the hedge readings ${String.fromCharCode(97 + index)}`)];
  const made: WorkItem[] = [];
  for (const title of titles) made.push(expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`,
    { body: { title }, headers: { 'idempotency-key': randomUUID() } }), 201) as WorkItem);
  const search = async (who: typeof owner, q: string, limit?: number) => expectStatus(await who.browser.request('GET',
    `/api/v1/search?${new URLSearchParams({ q, ...(limit ? { limit: String(limit) } : {}) })}`), 200) as SearchResponse;
  const found = async (who: typeof owner, q: string) => (await search(who, q)).items.filter((item) => item.kind === 'work').map((item) => item.id);
  const second = `work:${made[1]!.id}`;
  const id = (index: number) => `work:${made[index]!.id}`;
  for (const q of ['#2', '2', ' #2 ']) assert.equal((await found(owner, q))[0], second, `${JSON.stringify(q)} finds task #2 first`);
  // Exactly #2 and the titles with the word 2; never #20–#26 by prefix.
  assert.deepEqual(new Set(await found(owner, '#2')), new Set([second, id(0), id(2)]));
  const page = await search(owner, '#2', 8);
  assert.equal(page.items[0]?.id, second, 'the numbered task leads a short page, ahead of every other kind of hit');
  assert.equal((await found(owner, '#21'))[0], id(20), '"#21" finds task #21');
  assert.ok((await found(reader, '#2')).includes(second), 'a viewer of the project finds it too');
  assert.deepEqual(await found(member, '#2'), [], 'a workspace member without access to the project finds nothing');
  assert.ok(!(await found(owner, '#99')).length, 'a number no task has finds no task');
});
