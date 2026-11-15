import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, SearchResponse, SearchResult, WorkItem } from '@flux/contracts';
import { type ClientResponse } from './support/http.js';
import { expectStatus, person, project as createProject, workspace, type Person } from './support/people.js';

// v0.2.1 personas round 4 (P3): Search for "6:30" found task #6. A number names a task only when it is the whole query ("#6" or "6");
// as one word of a longer query a task's own number line ("#6", the first line of its indexed body) is not a match of it.

const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const text = (value: SearchResult['title'] | null) => (value ?? []).map((part) => part.text).join('');
const search = async (someone: Person, q: string) =>
  json<SearchResponse>(await someone.browser.request('GET', `/api/v1/search?${new URLSearchParams({ q })}`), 200, `search ${q}`);
const shown = (answer: SearchResponse) => answer.items.map((item) => `${item.kind}: ${text(item.title) || text(item.snippet)}`);

describe('search: a number names a task only on its own', () => {
  let piotr: Person;
  const tasks: WorkItem[] = [];

  before(async () => {
    piotr = await person('Piotr Nowak');
    const ws = await workspace(piotr, 'Nowak Bakery');
    const shift = await createProject(piotr, ws.id, 'Morning shift', 'workspace');
    for (const title of ['Order flour', 'Clean the mixer', 'Label the jars', 'Fix the till', 'Sweep the yard', 'Check the proofing room'])
      tasks.push(json<WorkItem>(await piotr.browser.request('POST', `/api/v1/projects/${shift.id}/work`, { body: { title } }), 201, title));
    json<Conversation>(await piotr.browser.request('POST', `/api/v1/projects/${shift.id}/conversations`,
      { body: { body: 'The first trays go in at 6:30 tomorrow.', clientMessageId: randomUUID() } }), 201, 'conversation');
  });

  test('"6:30" finds the message and never task #6', async () => {
    const six = tasks.find((task) => task.number === 6)!;
    assert.ok(six, 'the space has a task #6');
    const answer = await search(piotr, '6:30');
    assert.ok(shown(answer).includes('message: The first trays go in at 6:30 tomorrow.'), shown(answer).join(' | '));
    assert.ok(!answer.items.some((item) => item.kind === 'work'), `no task for "6:30": ${shown(answer).join(' | ')}`);
  });

  test('"#6" and "6" still find task #6 first', async () => {
    for (const q of ['#6', '6']) {
      const answer = await search(piotr, q);
      assert.equal(answer.items[0]?.kind, 'work', `${q}: ${shown(answer).join(' | ')}`);
      assert.equal(answer.items[0]?.task?.number, 6, `${q}: ${shown(answer).join(' | ')}`);
    }
  });
});
