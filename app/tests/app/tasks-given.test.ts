import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Agent, Page, WorkItem } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, removeFromSpace, removeMember, workspace, type Person } from './support/people.js';

/**
 * "Tasks I gave others" (#1519, founder decision 2026-11-14, PM essentials): the unfinished tasks a person created for another person, across the
 * spaces of a workspace they can read. A task made for yourself, for your own agent or for no one is not on it, and neither is a finished one.
 */
describe('tasks I gave others (#1519)', () => {
  const post = async <T>(who: Person, path: string, body: unknown): Promise<T> => expectStatus(await who.browser.request('POST', path, { body }), 201) as T;
  const get = async <T>(who: Person, path: string): Promise<T> => expectStatus(await who.browser.request('GET', path), 200) as T;

  test('only what you made for another person, still unfinished', async () => {
    const [ada, kai] = await Promise.all(['given-ada', 'given-kai'].map(person));
    const ws = await workspace(ada, 'Given tasks');
    await addMember(ada, ws.id, kai, 'member');
    const space = await project(ada, ws.id, 'Seed swap', 'workspace');
    const agent = await post<Agent>(ada, `/api/v1/workspaces/${ws.id}/agents`, { name: 'Ada planner', owner: 'self' });
    const task = (who: Person, title: string, extra: Record<string, unknown> = {}) => post<WorkItem>(who, `/api/v1/projects/${space.id}/work`, { title, ...extra });
    const forKai = await task(ada, 'Book the hall for Kai', { owner: { kind: 'human', id: kai.id }, dueOn: '2031-05-01' });
    const forKaiLater = await task(ada, 'Print the posters', { owner: { kind: 'human', id: kai.id } });
    const forSelf = await task(ada, 'Ada does this herself', { owner: { kind: 'human', id: ada.id } });
    const forAgent = await task(ada, 'Ada\'s agent does this', { owner: { kind: 'agent', id: agent.id } });
    const forNobody = await task(ada, 'Nobody owns this');
    const fromKai = await task(kai, 'Kai asks Ada for the keys', { owner: { kind: 'human', id: ada.id } });

    const given = async (who: Person) => (await get<Page<WorkItem>>(who, `/api/v1/workspaces/${ws.id}/work/given`)).items.map((item) => item.id).sort();
    assert.deepEqual(await given(ada), [forKai.id, forKaiLater.id].sort(), 'Ada gave Kai two tasks, and nothing she kept for herself, her agent or no one');
    assert.deepEqual(await given(kai), [fromKai.id], 'Kai gave Ada one');
    for (const id of [forSelf.id, forAgent.id, forNobody.id]) assert.ok(!(await given(ada)).includes(id));
    const page = await get<Page<WorkItem>>(ada, `/api/v1/workspaces/${ws.id}/work/given`);
    assert.equal(page.total, 2);
    assert.equal(page.items.find((item) => item.id === forKai.id)?.dueOn, '2031-05-01', 'a row carries its due day');
    assert.equal(page.items.find((item) => item.id === forKai.id)?.owner?.id, kai.id, 'and its owner');

    // Done leaves the list, and a task handed to someone else joins it.
    expectStatus(await ada.browser.request('PATCH', `/api/v1/work/${forKai.id}`, { body: { status: 'done' }, headers: { 'if-match': `"${forKai.version}"` } }), 200);
    assert.deepEqual(await given(ada), [forKaiLater.id]);
    expectStatus(await ada.browser.request('PATCH', `/api/v1/work/${forSelf.id}`, { body: { owner: { kind: 'human', id: kai.id } }, headers: { 'if-match': `"${forSelf.version}"` } }), 200);
    assert.deepEqual(await given(ada), [forKaiLater.id, forSelf.id].sort(), 'a task handed to Kai is one Ada gave');
  });

  test('only in spaces the caller can still read: a space they left, or a company they left, drops its tasks', async () => {
    const [ada, kai, lea] = await Promise.all(['given-acl-ada', 'given-acl-kai', 'given-acl-lea'].map(person));
    const ws = await workspace(ada, 'Given access');
    await addMember(ada, ws.id, kai, 'member');
    await addMember(ada, ws.id, lea, 'member');
    const open = await project(ada, ws.id, 'Everyone garden', 'workspace');
    const closed = await project(ada, ws.id, 'Board room', 'restricted');
    await grant(ada, closed.id, kai, 'contributor');
    const make = async (where: string, title: string) => expectStatus(await kai.browser.request('POST', `/api/v1/projects/${where}/work`, { body: { title, owner: { kind: 'human', id: ada.id } } }), 201) as WorkItem;
    const inOpen = await make(open.id, 'Water the beds');
    const inClosed = await make(closed.id, 'Sign the lease');
    const given = async (who: Person) => (await get<Page<WorkItem>>(who, `/api/v1/workspaces/${ws.id}/work/given`)).items.map((item) => item.id).sort();
    assert.deepEqual(await given(kai), [inOpen.id, inClosed.id].sort());
    assert.deepEqual(await given(lea), [], 'another member sees none of Kai\'s');

    await removeFromSpace(ada, closed.id, kai);
    assert.deepEqual(await given(kai), [inOpen.id], 'a restricted space Kai left drops out at once');

    await removeMember(ada, ws.id, kai);
    const after = await kai.browser.request('GET', `/api/v1/workspaces/${ws.id}/work/given`);
    if (after.status === 200) assert.deepEqual((after.json as Page<WorkItem>).items, [], 'a company Kai left shows nothing');
    else assert.ok([403, 404].includes(after.status), `a company Kai left is refused (${after.status})`);
  });
});
