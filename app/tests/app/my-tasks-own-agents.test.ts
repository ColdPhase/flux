import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Agent, Page, ProjectWorkSummary, ProjectWorkView, WorkItem } from '@flux/contracts';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';

/**
 * "Mine" and My tasks include the tasks your own agents own (#865, answer 4): an agent works for its owner, so what it holds
 * is on its owner's lists, and nobody else's. The Tasks view's Mine filter and its counts read the same rule as My tasks.
 */
describe('mine and My tasks include the tasks owned by your own agents (#865)', () => {
  const post = async <T>(who: Person, path: string, body: unknown): Promise<T> => expectStatus(await who.browser.request('POST', path, { body }), 201) as T;
  const get = async <T>(who: Person, path: string): Promise<T> => expectStatus(await who.browser.request('GET', path), 200) as T;

  test('your agent\'s tasks are yours, and only yours', async () => {
    const [ada, kai] = await Promise.all(['mine-ada', 'mine-kai'].map(person));
    const ws = await workspace(ada, 'Mine and agents');
    await addMember(ada, ws.id, kai, 'member');
    const space = await project(ada, ws.id, 'Rain barrel monitor', 'workspace');
    const adaAgent = await post<Agent>(ada, `/api/v1/workspaces/${ws.id}/agents`, { name: 'Ada planner', owner: 'self' });
    const kaiAgent = await post<Agent>(kai, `/api/v1/workspaces/${ws.id}/agents`, { name: 'Kai planner', owner: 'self' });
    const task = (who: Person, title: string, owner: { kind: 'human' | 'agent'; id: string } | null) =>
      post<WorkItem>(who, `/api/v1/projects/${space.id}/work`, { title, ...(owner ? { owner } : {}) });
    const own = await task(ada, 'Ada does this herself', { kind: 'human', id: ada.id });
    const byAgent = await task(ada, 'Ada\'s agent does this', { kind: 'agent', id: adaAgent.id });
    const kaisAgents = await task(kai, 'Kai\'s agent does this', { kind: 'agent', id: kaiAgent.id });
    const nobody = await task(ada, 'Nobody owns this', null);

    // My tasks (the workspace's assigned work).
    const assigned = async (who: Person) => (await get<Page<WorkItem>>(who, `/api/v1/workspaces/${ws.id}/work/assigned`)).items.map((item) => item.id).sort();
    assert.deepEqual(await assigned(ada), [own.id, byAgent.id].sort(), 'Ada has her own task and her agent\'s');
    assert.deepEqual(await assigned(kai), [kaisAgents.id], 'Kai has his agent\'s task only');

    // The Tasks view's Mine filter, and the counts that sit beside it.
    const mine = async (who: Person) => (await get<ProjectWorkView>(who, `/api/v1/projects/${space.id}/work-view?mine=true&kinds=work`)).items.map((row) => row.id).sort();
    assert.deepEqual(await mine(ada), [own.id, byAgent.id].sort());
    assert.deepEqual(await mine(kai), [kaisAgents.id]);
    const summary = await get<ProjectWorkSummary>(ada, `/api/v1/projects/${space.id}/work-summary`);
    assert.equal(summary.all.open, 4, 'the board holds all four');
    assert.equal(summary.mine.open, 2, 'Mine counts the two that are Ada\'s');
    assert.ok(!(await mine(ada)).includes(nobody.id));
  });
});
