import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, SearchResponse, SearchResult } from '@flux/contracts';
import { pool } from './support/db.js';
import { type ClientResponse } from './support/http.js';
import { addMember, expectStatus, person, project as createProject, workspace, type Person } from './support/people.js';

// v0.2.1 personas round (P3s of the final round): Search for "mockup" did not find "mock-up", and "price list" listed the person
// "Kasia Lis" (one edit from "list") beside the price list itself. A hyphenated word is one word on both sides (migration 0085 and
// `joinHyphenatedWords`), and a typo only finds what no visible hit holds whole (docs/development/search.md).

const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const text = (value: SearchResult['title'] | null) => (value ?? []).map((part) => part.text).join('');
const marked = (value: SearchResult['title'] | null) => (value ?? []).filter((part) => part.match).map((part) => part.text);
const search = async (someone: Person, q: string) =>
  json<SearchResponse>(await someone.browser.request('GET', `/api/v1/search?${new URLSearchParams({ q })}`), 200, `search ${q}`);
const shown = (answer: SearchResponse) => answer.items.map((item) => `${item.kind}: ${text(item.title) || text(item.snippet)}`);

describe('search: a hyphenated word is one word, and a typo finds only what no word found whole', () => {
  let piotr: Person;

  before(async () => {
    piotr = await person('Piotr Nowak');
    const kasia = await person('Kasia Lis');
    const ws = await workspace(piotr, 'Nowak Bakery');
    await addMember(piotr, ws.id, kasia, 'member');
    const shop = await createProject(piotr, ws.id, 'Shop', 'workspace');
    const thread = json<Conversation>(await piotr.browser.request('POST', `/api/v1/projects/${shop.id}/conversations`,
      { body: { body: 'The mock-up of the shop window is ready.', clientMessageId: randomUUID() } }), 201, 'conversation');
    for (const body of ['Here is the price list for Christmas.', 'Two new mockups for the newsletter.'])
      json(await piotr.browser.request('POST', `/api/v1/conversations/${thread.id}/messages`, { body: { body, clientMessageId: randomUUID() } }), 201, 'message');
  });

  test('migration 0085 indexes the joined words of every title and body', async () => {
    const index = (await pool.query(`SELECT pg_get_indexdef('search_documents_bm25_idx'::regclass) AS def`)).rows[0] as { def: string };
    assert.match(index.def, /flux_joined_words\(title\).*alias=title_joined/);
    assert.match(index.def, /flux_joined_words\(body\).*alias=body_joined/);
    assert.deepEqual((await pool.query(`SELECT public.flux_joined_words('mock-up e‑mail a - b 2026-11-14') AS joined`)).rows[0], { joined: 'mockup email a - b 20261114' });
  });

  test('"mockup" finds "mock-up" and marks it, and "mock-up" finds "mockups"', async () => {
    const plain = await search(piotr, 'mockup');
    assert.ok(shown(plain).includes('message: The mock-up of the shop window is ready.'), shown(plain).join(' | '));
    assert.ok(shown(plain).includes('message: Two new mockups for the newsletter.'), shown(plain).join(' | '));
    const hyphened = plain.items.find((item) => `${text(item.title)}${text(item.snippet)}`.includes('The mock-up'))!;
    assert.deepEqual([...marked(hyphened.title), ...marked(hyphened.snippet)], ['mock-up'], 'the hyphenated word is marked whole');
    for (const q of ['mock-up', 'mock‐up']) {
      const answer = await search(piotr, q);
      assert.ok(shown(answer).includes('message: Two new mockups for the newsletter.'), `${q}: ${shown(answer).join(' | ')}`);
      assert.ok(shown(answer).includes('message: The mock-up of the shop window is ready.'), `${q}: ${shown(answer).join(' | ')}`);
    }
  });

  test('"price list" lists the price list and not a person one edit from "list"; a word found nowhere still finds her by its typo', async () => {
    const answer = await search(piotr, 'price list');
    assert.deepEqual(shown(answer), ['message: Here is the price list for Christmas.']);
    assert.deepEqual(shown(await search(piotr, 'liss')), ['person: Kasia Lis'], 'with nothing found whole, a typo in a name still finds it');
    assert.ok(shown(await search(piotr, 'Kasia')).includes('person: Kasia Lis'));
  });
});
