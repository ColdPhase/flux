import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import {
  projectConversationViewPath, projectSpaceShellPath, type Conversation, type ConversationView, type SpaceShell, type WorkItem, type WorkspaceMember,
} from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, removeFromSpace, workspace, type Person } from './support/people.js';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';

// #1109: one read per screen. Each part of `space-shell` and `conversation-view` is what the part's own route answers the same
// person at the same moment, so the parts keep their own access checks; a person who cannot open the space gets the space's refusal.

describe('the space-shell and conversation-view reads', () => {
  let ada: Person, ben: Person, cy: Person;
  let workspaceId: string, projectId: string;
  let conversation: Conversation, task: WorkItem;
  const base = () => `/api/v1/projects/${projectId}`;
  const post = async <T>(who: Person, path: string, body: unknown) =>
    expectStatus(await who.browser.request('POST', path, { body, headers: { 'idempotency-key': randomUUID() } }), 201) as T;
  const get = async <T>(who: Person, path: string, status = 200) => {
    const response = await who.browser.request('GET', path);
    return expectStatus(response, status, path) as T;
  };

  before(async () => {
    [ada, ben, cy] = await Promise.all(['Ada', 'Ben', 'Cy'].map(person));
    workspaceId = (await workspace(ada, 'View reads')).id;
    await addMember(ada, workspaceId, ben, 'member');
    await addMember(ada, workspaceId, cy, 'member');
    projectId = (await project(ada, workspaceId, 'Rain barrels', 'restricted')).id;
    await grant(ada, projectId, ben, 'contributor');
    conversation = await post<Conversation>(ada, `${base()}/conversations`, { body: 'The overflow pipe sits low', clientMessageId: randomUUID() });
    await post(ada, `${base()}/conversations`, { body: 'Barrel two fills second', clientMessageId: randomUUID() });
    task = await post<WorkItem>(ada, `${base()}/work`, { title: 'Raise the pipe', sources: [{ type: 'message', id: conversation.messages[0]!.id }] });
    await post(ada, `${base()}/docs`, { title: 'How the barrels fill', body: 'Barrel one first.', state: 'published', reason: 'First page' });
    await post(ada, `/api/v1/workspaces/${workspaceId}/sketches`, { title: 'Where the sensors go', scope: 'project', projectId });
  });

  test('the shell is the space with its people, pages, sketches and work summary, each as its own route answers it', async () => {
    const response = await ben.browser.request('GET', projectSpaceShellPath(projectId));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const shell = expectStatus(response, 200) as SpaceShell;
    assert.deepEqual(shell.project, await get(ben, base()));
    assert.deepEqual(shell.people, await get(ben, `${base()}/people`));
    assert.deepEqual(shell.docs, await get(ben, `${base()}/docs?limit=100&offset=0`));
    assert.deepEqual(shell.sketches, await get(ben, `/api/v1/workspaces/${workspaceId}/sketches?limit=20&offset=0&projectId=${projectId}&hideEmpty=true`));
    const summary = await get<{ observedAt: string }>(ben, `${base()}/work-summary`);
    assert.deepEqual({ ...shell.workSummary, observedAt: '' }, { ...summary, observedAt: '' });
    assert.equal(shell.docs?.items[0]?.title, 'How the barrels fill');
  });

  test('the conversation view is the stream\'s first reads: roots, notices, agents\' questions and the roots\' work', async () => {
    const view = await get<ConversationView>(ben, projectConversationViewPath(projectId));
    assert.equal(view.projectId, projectId);
    assert.deepEqual(view.roots, await get(ben, `${base()}/conversation-roots`));
    assert.deepEqual(view.taskNotices, await get(ben, `${base()}/task-notices?limit=100&offset=0`));
    assert.deepEqual(view.objectNotices, await get(ben, `${base()}/object-notices?limit=100&offset=0`));
    assert.deepEqual(view.agentQuestions, await get(ben, `${base()}/agent-questions`));
    assert.equal(view.roots.roots.length, 2);
    const ids = view.roots.roots.map((root) => root.message.id).sort().join(',');
    const own = await get<{ observedAt: string }>(ben, `${base()}/work-associations?relation=source&limit=50&messageIds=${ids}`);
    assert.deepEqual({ ...view.workAssociations, observedAt: '' }, { ...own, observedAt: '' });
    assert.ok(view.workAssociations?.items.some((item) => item.id === task.id), 'the task made from the first root is among its work');
    // #1429: the company's people, as their route answers them without the last-active times, so the stream names its authors without a read of its own.
    const members = await get<WorkspaceMember[]>(ben, `/api/v1/workspaces/${workspaceId}/members`);
    assert.deepEqual(view.members, members.map((member) => { const shown = { ...member }; delete shown.lastActiveAt; return shown; }));
    assert.deepEqual(view.members?.map((member) => member.name).sort(), ['Ada', 'Ben', 'Cy']);
  });

  test('a guest\'s view has no company people, as their route refuses a guest (#1429)', async () => {
    const dee = await person('Dee');
    await addMember(ada, workspaceId, dee, 'guest');
    await grant(ada, projectId, dee, 'contributor');
    await get(dee, `/api/v1/workspaces/${workspaceId}/members`, 403);
    const view = await get<ConversationView>(dee, projectConversationViewPath(projectId));
    assert.equal(view.members, null);
    assert.equal(view.roots.roots.length, 2, 'the conversation still opens');
  });

  test('the announcements reach back as far as the roots, so the stream needs no further page when it opens (#1429)', async () => {
    const busy = (await project(ada, workspaceId, 'Seed library', 'workspace')).id;
    const start = (body: string) => post<Conversation>(ada, `/api/v1/projects/${busy}/conversations`, { body, clientMessageId: randomUUID() });
    const task = (title: string) => post<WorkItem>(ada, `/api/v1/projects/${busy}/work`, { title });
    await start('Seed swap: the first note');
    await task('Label the jars');
    await task('Count the packets');
    for (let index = 0; index < 50; index++) await start(`Seed swap note ${index + 1}`);
    for (let index = 0; index < 101; index++) await task(`Sort seed packet ${index + 1}`);
    const view = await get<ConversationView>(ben, projectConversationViewPath(busy));
    assert.equal(view.roots.rootPage.hasMoreBefore, true, 'the first note is older than the window');
    const oldest = view.roots.roots[0]!.message.createdAt;
    const { items, total } = view.taskNotices;
    assert.equal(total, 103);
    assert.equal(items.length, 102, 'the 101 announcements after the oldest root of the window and the first one before it');
    assert.ok(items.slice(0, 101).every((notice) => notice.createdAt >= oldest));
    assert.ok(items[101]!.createdAt < oldest && items[101]!.workTitle === 'Count the packets');
    // The same announcements, in the same order, as the route's own pages.
    const first = await get<{ items: unknown[] }>(ben, `/api/v1/projects/${busy}/task-notices?limit=100&offset=0`);
    const second = await get<{ items: unknown[] }>(ben, `/api/v1/projects/${busy}/task-notices?limit=100&offset=100`);
    assert.deepEqual(items, [...first.items, ...second.items].slice(0, 102));
    // When the window holds the oldest root, every announcement comes with the view.
    const quiet = (await project(ada, workspaceId, 'Seed archive', 'workspace')).id;
    await post(ada, `/api/v1/projects/${quiet}/conversations`, { body: 'Archive opened', clientMessageId: randomUUID() });
    for (let index = 0; index < 101; index++) await post(ada, `/api/v1/projects/${quiet}/work`, { title: `Archive packet ${index + 1}` });
    const all = await get<ConversationView>(ben, projectConversationViewPath(quiet));
    assert.equal(all.roots.rootPage.hasMoreBefore, false);
    assert.equal(all.taskNotices.total, 101);
    assert.equal(all.taskNotices.items.length, 101);
  });

  test('while the space\'s AI is off, the view leaves the agents\' questions out, as their route refuses them', async () => {
    await setSpaceAi(projectId, 'blocked');
    try {
      const refusal = await get<{ code: string }>(ben, `${base()}/agent-questions`, 403);
      assert.equal(refusal.code, 'SPACE_AI_OFF');
      const view = await get<ConversationView>(ben, projectConversationViewPath(projectId));
      assert.equal(view.agentQuestions, null);
      assert.equal(view.roots.roots.length, 2, 'the rest of the conversation still opens');
    } finally { await ensureSpaceAiAllowed(projectId); }
  });

  test('a person who cannot open the space gets the space\'s own refusal from both reads, and no part of it', async () => {
    const own = await get<{ code: string }>(cy, base(), 404);
    for (const path of [projectSpaceShellPath(projectId), projectConversationViewPath(projectId)]) {
      const refusal = await get<{ code: string; items?: unknown }>(cy, path, 404);
      assert.equal(refusal.code, own.code, path);
      assert.equal(JSON.stringify(refusal).includes('overflow pipe'), false, path);
    }
    await get(cy, projectSpaceShellPath(randomUUID()), 404);
    expectStatus(await (await person('Nobody')).browser.request('GET', projectConversationViewPath(projectId)), 404);
  });

  test('a person taken off the space loses both reads at once (#592: a lost space says so)', async () => {
    await get(ben, projectSpaceShellPath(projectId));
    await removeFromSpace(ada, projectId, ben);
    try {
      await get(ben, projectSpaceShellPath(projectId), 404);
      await get(ben, projectConversationViewPath(projectId), 404);
    } finally { await grant(ada, projectId, ben, 'contributor'); }
  });
});
