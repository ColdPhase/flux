import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, Decision, InboxResponse, Material, NeedsYouItem, NeedsYouResponse, Project, Workspace, WorkItem } from '@flux/contracts';
import type { ClientResponse } from './support/http.js';
import { register } from './support/http.js';
import { addMember, expectStatus, grant, password, person, project as createProject, workspace, type Person } from './support/people.js';
import { waitFor } from './support/push.js';

// The Inbox "Needs you" queue (#342): what asks something of a person is computed from current rows and
// the access policy; only what the person did with an item is stored. One person accepts a decision
// (O-009 DA-2), so the queue shows who can still accept; there is no un-accept, so Undo is the client's.

const post = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('POST', path, { body, headers });
const patch = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('PATCH', path, { body, headers });
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const queue = async (someone: Person) => json<NeedsYouResponse>(await someone.browser.request('GET', '/api/v1/needs-you'), 200);
const resolve = (someone: Person, key: string, body: unknown) => post(someone, `/api/v1/needs-you/${encodeURIComponent(key)}`, body);
const restore = (someone: Person, key: string) => someone.browser.request('DELETE', `/api/v1/needs-you/${encodeURIComponent(key)}`);
const find = (response: NeedsYouResponse, key: string): NeedsYouItem | undefined => response.items.find((item) => item.key === key);
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

async function named(name: string): Promise<Person> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}@example.test`;
  const { browser } = await register(email, password, name);
  const me = json<{ user: { id: string } }>(await browser.request('GET', '/api/v1/me'), 200);
  return { id: me.user.id, email, browser };
}

describe('the Inbox needs-you queue', () => {
  let owner: Person;
  let partner: Person;
  let viewer: Person;
  let outsider: Person;
  let ws: Workspace;
  let lamp: Project;
  let conversation: Conversation;
  let material: Material;

  before(async () => {
    owner = await named('Needs Owner');
    [partner, viewer, outsider] = await Promise.all(['ny-partner', 'ny-viewer', 'ny-outsider'].map(person));
    ws = await workspace(owner, 'Garden space');
    for (const someone of [partner, viewer, outsider]) await addMember(owner, ws.id, someone, 'member');
    lamp = await createProject(owner, ws.id, 'Garden sensors', 'restricted');
    await grant(owner, lamp.id, partner, 'contributor');
    await grant(owner, lamp.id, viewer, 'viewer');
    conversation = json<Conversation>(await post(owner, `/api/v1/projects/${lamp.id}/conversations`,
      { body: 'Measure soil moisture or frost first?', clientMessageId: randomUUID() }), 201);
    material = json<Material>(await post(owner, `/api/v1/projects/${lamp.id}/materials`,
      { clientMutationId: randomUUID(), title: 'Probe notes', body: 'Overwatering is the problem now' }), 201);
  });

  test('a proposed decision needs the people who can accept it, and only them', async () => {
    const probes = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Calibrate the probes' }), 201);
    const proposed = json<Decision>(await post(partner, `/api/v1/projects/${lamp.id}/decisions`, {
      title: 'Measure soil moisture first', rationale: 'Overwatering is the problem now; frost only matters in spring.',
      affects: [probes.id], sources: [{ type: 'message', id: conversation.messages[0]!.id }, { type: 'material', id: material.materialId, version: 1 }],
    }), 201);
    const key = `decision:${proposed.id}`;

    const mine = find(await queue(owner), key);
    assert.ok(mine, 'a manager can accept it');
    assert.equal(mine.kind, 'decision');
    assert.equal(mine.title, 'Measure soil moisture first');
    assert.deepEqual(mine.project, { id: lamp.id, name: 'Garden sensors' });
    assert.equal(mine.decision?.canAccept, true);
    assert.deepEqual(mine.decision?.proposedBy, { kind: 'human', id: partner.id, name: 'ny-partner' });
    assert.equal(mine.decision?.basedOn.length, 2, 'what it is based on');
    assert.deepEqual(mine.decision?.affects.map((task) => task.id), [probes.id]);
    assert.equal(mine.snoozeTask?.id, probes.id, '"when #N is done" waits for the task it affects');
    // One person accepts: the card names who still can, you first.
    const names = mine.decision!.accepters.map((person) => [person.name, person.you]);
    assert.deepEqual(names[0], ['Needs Owner', true]);
    assert.ok(names.some(([name]) => name === 'ny-partner'));
    assert.ok(!names.some(([name]) => name === 'ny-viewer'), 'a viewer cannot accept');

    // The contributor who proposed it can accept it too (DA-2); a viewer, a member without access and a
    // stranger are never asked.
    assert.ok(find(await queue(partner), key));
    assert.equal(find(await queue(viewer), key), undefined);
    assert.equal(find(await queue(outsider), key), undefined);

    // Accepting leaves everyone's queue.
    json(await post(owner, `/api/v1/decisions/${proposed.id}/accept`, {}, { 'if-match': '"1"' }), 200);
    assert.equal(find(await queue(owner), key), undefined);
    assert.equal(find(await queue(partner), key), undefined);
  });

  test('Done, Not now and Decline are per person, and Undo brings the item back', async () => {
    const task = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Order six capacitive probes' }), 201);
    const proposed = json<Decision>(await post(partner, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Buy probes in bulk', affects: [task.id] }), 201);
    const key = `decision:${proposed.id}`;

    json(await resolve(owner, key, { action: 'done' }), 200);
    assert.equal(find(await queue(owner), key), undefined, 'done leaves your queue');
    assert.ok(find(await queue(partner), key), 'and nobody else\'s');
    assert.equal((await restore(owner, key)).status, 204);
    assert.ok(find(await queue(owner), key), 'Undo restores it');
    assert.equal((await restore(owner, key)).status, 204, 'undoing twice changes nothing');

    // Not now: at a time.
    const later = json<{ state: string; until: string }>(await resolve(owner, key, { action: 'snooze', until: inHours(20) }), 200);
    assert.equal(later.state, 'snoozed');
    const hidden = await queue(owner);
    assert.equal(find(hidden, key), undefined);
    assert.equal(hidden.later, 1, 'what is put off can be counted');
    assert.equal(hidden.count, hidden.items.length);
    await restore(owner, key);

    // Not now: until the task is done.
    assert.equal((await resolve(owner, key, { action: 'snooze', untilWorkId: randomUUID() })).status, 400, 'only the item\'s own task');
    json(await resolve(owner, key, { action: 'snooze', untilWorkId: task.id }), 200);
    assert.equal(find(await queue(owner), key), undefined);
    json(await patch(owner, `/api/v1/work/${task.id}`, { status: 'in_progress', expectedVersion: task.version }), 200);
    assert.equal(find(await queue(owner), key), undefined, 'still waiting while it is only in progress');
    const started = json<WorkItem>(await owner.browser.request('GET', `/api/v1/work/${task.id}`), 200);
    json(await patch(owner, `/api/v1/work/${task.id}`, { status: 'done', expectedVersion: started.version }), 200);
    assert.ok(find(await queue(owner), key), 'it returns when the task is done');

    // Out-of-range or malformed choices are refused and change nothing.
    for (const body of [{ action: 'snooze', until: inHours(-1) }, { action: 'snooze', until: inHours(24 * 90) }, { action: 'snooze' },
      { action: 'snooze', until: inHours(5), untilWorkId: task.id }, { action: 'done', until: inHours(5) }, { action: 'later' }]) {
      assert.equal((await resolve(owner, key, body)).status, 400, JSON.stringify(body));
    }
    assert.ok(find(await queue(owner), key));

    // Decline for good removes it for you only; the decision stays proposed.
    json(await resolve(owner, key, { action: 'decline' }), 200);
    assert.equal(find(await queue(owner), key), undefined);
    assert.ok(find(await queue(partner), key));
    assert.equal(json<Decision>(await owner.browser.request('GET', `/api/v1/decisions/${proposed.id}`), 200).status, 'proposed');
  });

  test('items someone cannot read answer like items that do not exist', async () => {
    const proposed = json<Decision>(await post(partner, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Private to the garden' }), 201);
    const key = `decision:${proposed.id}`;
    assert.equal((await resolve(outsider, key, { action: 'done' })).status, 404);
    assert.equal((await resolve(viewer, key, { action: 'done' })).status, 404, 'a viewer is not asked, so cannot answer');
    assert.equal((await resolve(owner, 'decision:not-a-key', { action: 'done' })).status, 404);
    assert.equal((await resolve(owner, `decision:${randomUUID()}`, { action: 'done' })).status, 404);
    assert.equal((await restore(outsider, key)).status, 204, 'restoring touches only your own choice');
    assert.equal((await outsider.browser.request('GET', '/api/v1/needs-you', { headers: {} })).status, 200);
  });

  test('your blocked tasks need you until they are unblocked', async () => {
    const blocked = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, {
      title: 'Design the enclosure', owner: { kind: 'human', id: owner.id }, status: 'blocked', blocker: 'Waiting for the probe dimensions',
    }), 201);
    const key = `blocked:${blocked.id}`;
    const item = find(await queue(owner), key);
    assert.ok(item);
    assert.equal(item.kind, 'blocked');
    assert.equal(item.blocked?.number, blocked.number);
    assert.equal(item.blocked?.blocker, 'Waiting for the probe dimensions');
    assert.equal(item.blocked?.version, blocked.version);
    assert.equal(find(await queue(partner), key), undefined, 'a blocked task is the owner\'s need');

    json(await patch(owner, `/api/v1/work/${blocked.id}`, { status: 'in_progress', blocker: null, expectedVersion: blocked.version }), 200);
    assert.equal(find(await queue(owner), key), undefined);
  });

  test('a mention is a need until it is done, and Done is also read', async () => {
    const asker = partner;
    const question = json<Conversation>(await post(asker, `/api/v1/projects/${lamp.id}/conversations`,
      { body: '@Needs Owner can you check the shed roof?', clientMessageId: randomUUID() }), 201);
    const note = await waitFor(async () => (await queue(owner)).items.find((item) => item.url.includes(question.id)), 'the question reaches the queue');
    assert.equal(note.kind, 'question');
    assert.ok(note.key.startsWith('note:'));

    json(await resolve(owner, note.key, { action: 'done' }), 200);
    assert.equal(find(await queue(owner), note.key), undefined);
    const inbox = json<InboxResponse>(await owner.browser.request('GET', '/api/v1/inbox'), 200);
    assert.ok(inbox.items.find((item) => item.id === note.key.slice(5))?.readAt, 'Done also reads the notification');
    await restore(owner, note.key);
    assert.ok(find(await queue(owner), note.key));
    assert.equal(json<InboxResponse>(await owner.browser.request('GET', '/api/v1/inbox'), 200).items.find((item) => item.id === note.key.slice(5))?.readAt, null);
  });
});
