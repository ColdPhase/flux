import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { projectPeoplePath, type Conversation, type Dm, type DmSummary, type Page, type ProjectPerson, type SearchResponse, type SearchResult } from '@flux/contracts';
import { type ClientResponse } from './support/http.js';
import { createSealed, passphrase } from './support/encryption.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';

// v0.2.1 persona round 6 (personas-29):
// - Search for "barrel by the shed" listed 20 messages that held only "the" or "by". People's search leaves out a hit that holds only the
//   little words of a longer search (`isSearchStopWord`); the message with the rare words stays first, a search of a little word alone
//   still finds it, and an encrypted workspace's in-memory index cuts the same hits.
// - A direct message nobody has written in is listed only for the person who started it; its first message brings it to the others.
// - P2 4: a guest named every thread reply "Former member". The client names an author from the space's people when the company's members
//   are not the reader's; a guest's read of the space's people names everyone who wrote there.

const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const text = (value: SearchResult['title'] | null) => (value ?? []).map((part) => part.text).join('');
const MESSAGES = [
  'The barrel by the shed was full on Monday.',
  'Tomek, can you send me the measurements by Wednesday?',
  'Here is the far east bed after the rain.',
  'Ada, the volunteer rota is in the Wiki now.',
  'Short update: the second gateway works from the shed roof.',
  'Then let us order six and put two on the far beds.',
];

describe('persona round 6: search, empty direct messages and a guest\'s names', () => {
  let piotr: Person; let kasia: Person; let gosia: Person;
  let plain: string; let sealed: string;
  const spaces: Record<string, string> = {};

  const search = async (someone: Person, q: string, place: string) =>
    json<SearchResponse>(await someone.browser.request('GET', `/api/v1/search?${new URLSearchParams({ q, place, limit: '50' })}`), 200, `search ${q}`);
  const bodies = (answer: SearchResponse) => answer.items.map((item) => text(item.title) || text(item.snippet));

  before(async () => {
    piotr = await person('Piotr Kowal');
    kasia = await person('Kasia Wrona');
    gosia = await person('Gosia Mlyn');
    plain = (await workspace(piotr, 'Garden club')).id;
    sealed = (await createSealed(piotr, 'Sealed garden', passphrase())).workspace.id;
    for (const ws of [plain, sealed]) {
      await addMember(piotr, ws, kasia, 'member');
      const space = await createProject(piotr, ws, 'Plot committee', 'workspace');
      spaces[ws] = space.id;
      for (const body of MESSAGES) json<Conversation>(await piotr.browser.request('POST', `/api/v1/projects/${space.id}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201, body);
    }
    await addMember(piotr, plain, gosia, 'guest');
  });

  test('"barrel by the shed" lists the messages with its words, not those with only "the" or "by", in a plain and an encrypted workspace', async () => {
    for (const ws of [plain, sealed]) {
      const answer = await search(kasia, 'barrel by the shed', `project:${spaces[ws]}`);
      const found = bodies(answer);
      assert.equal(found[0], MESSAGES[0], `the message with the words comes first (${ws === sealed ? 'encrypted' : 'plain'}): ${found.join(' | ')}`);
      assert.ok(found.includes(MESSAGES[4]), `a message with "shed" stays: ${found.join(' | ')}`);
      for (const loose of [MESSAGES[1], MESSAGES[2], MESSAGES[3], MESSAGES[5]])
        assert.ok(!found.includes(loose!), `"${loose}" holds only little words of the search (${ws === sealed ? 'encrypted' : 'plain'}): ${found.join(' | ')}`);
    }
  });

  test('a little word alone still finds what holds it, and a search of content words keeps "any of the words"', async () => {
    for (const ws of [plain, sealed]) {
      const the = bodies(await search(kasia, 'the', `project:${spaces[ws]}`));
      assert.ok(the.length >= 5, `"the" alone finds every message with it: ${the.join(' | ')}`);
      const either = bodies(await search(kasia, 'barrel rota', `project:${spaces[ws]}`));
      assert.ok(either.includes(MESSAGES[0]) && either.includes(MESSAGES[3]), `either word finds its message: ${either.join(' | ')}`);
    }
  });

  test('a direct message nobody has written in is listed only for the person who started it', async () => {
    const list = async (someone: Person) => json<Page<DmSummary>>(await someone.browser.request('GET', `/api/v1/workspaces/${plain}/dms?limit=100`), 200, 'list').items.map((item) => item.id);
    const created = await piotr.browser.request('POST', `/api/v1/workspaces/${plain}/dms`, { body: { participantIds: [kasia.id] } });
    assert.ok(created.status === 200 || created.status === 201, created.text);
    const dm = created.json as Dm;
    assert.ok((await list(piotr)).includes(dm.id), 'the person who started it has it');
    assert.ok(!(await list(kasia)).includes(dm.id), 'the other person is not shown an empty conversation');
    json(await kasia.browser.request('GET', `/api/v1/dms/${dm.id}`), 200, 'it is still hers to open by its address');
    json(await piotr.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: 'The oven timer is broken again.', clientMessageId: randomUUID() } }), 201, 'first message');
    assert.ok((await list(kasia)).includes(dm.id), 'the first message brings it');
  });

  test('a guest reads the name of everyone who wrote in their space (P2 4)', async () => {
    const space = await createProject(piotr, plain, 'Garden sensors', 'restricted');
    await grant(piotr, space.id, kasia, 'contributor');
    await grant(piotr, space.id, gosia, 'contributor');
    const root = json<Conversation>(await kasia.browser.request('POST', `/api/v1/projects/${space.id}/conversations`, { body: { body: 'Moisture first?', clientMessageId: randomUUID() } }), 201, 'root');
    json(await piotr.browser.request('POST', `/api/v1/conversations/${root.id}/messages`, { body: { body: 'Agreed, moisture first.', clientMessageId: randomUUID() } }), 201, 'reply');
    const thread = json<Conversation>(await gosia.browser.request('GET', `/api/v1/conversations/${root.id}`), 200, 'the guest reads the thread');
    const people = json<ProjectPerson[] | { items: ProjectPerson[] }>(await gosia.browser.request('GET', projectPeoplePath(space.id)), 200, 'the guest reads the space\'s people');
    const named = new Map((Array.isArray(people) ? people : people.items).filter((one) => one.kind === 'human').map((one) => [one.id, one.name]));
    for (const message of thread.messages) {
      assert.ok(message.authorId, 'a person wrote it');
      assert.ok(named.get(message.authorId!), `the guest can name the author of "${message.body}"`);
    }
  });
});
