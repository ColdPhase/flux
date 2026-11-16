import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { Conversation, SearchResponse } from '@flux/contracts';
import { pool } from './support/db.js';
import { expectStatus, person, project as createProject, workspace } from './support/people.js';

// Train 33 (2026-11-16): with the text of a few files in pg_search's mutable segment, every reader of the BM25 index tokenized those rows
// again for each clause, so a six-word search planned past the API's 2 s statement limit and Search answered 500. Migration 0093 makes
// every write a written segment (docs/development/search.md "The BM25 index writes whole segments").

describe('search: the BM25 index writes whole segments', () => {
  test('the index keeps no mutable segment, and what is written is found', async () => {
    const options = (await pool.query(`SELECT reloptions FROM pg_class WHERE oid = 'search_documents_bm25_idx'::regclass`)).rows[0] as { reloptions: string[] | null };
    assert.ok(options.reloptions?.includes('mutable_segment_rows=0'), `the index option: ${JSON.stringify(options.reloptions)}`);
    const ada = await person('Ada Segment');
    const ws = await workspace(ada, 'Segment Bakery');
    const shop = await createProject(ada, ws.id, 'Granary', 'workspace');
    const word = `rye${randomUUID().slice(0, 6)}`;
    expectStatus(await ada.browser.request('POST', `/api/v1/projects/${shop.id}/conversations`,
      { body: { body: `Three sacks of ${word} on Monday`, clientMessageId: randomUUID() } }), 201, 'conversation') as Conversation;
    const segments = (await pool.query(`SELECT mutable, num_docs FROM paradedb.index_info('search_documents_bm25_idx', true)`)).rows as { mutable: boolean; num_docs: string }[];
    assert.deepEqual(segments.filter((segment) => segment.mutable && Number(segment.num_docs) > 0), [], 'no rows wait in a mutable segment');
    const answer = expectStatus(await ada.browser.request('GET', `/api/v1/search?${new URLSearchParams({ q: `Three sacks of ${word} on Monday` })}`), 200, 'search') as SearchResponse;
    assert.ok(answer.items.some((item) => item.kind === 'message'), 'the message is found');
  });
});
