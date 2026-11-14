import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, InboxResponse, NeedsYouResponse, Project, SentConversationMessage } from '@flux/contracts';
import { pool } from './support/db.js';
import { createSealed, passphrase } from './support/encryption.js';
import { addMember, expectStatus, person, workspace, type Person } from './support/people.js';
import { waitFor } from './support/push.js';

// An answer to your question reaches you (founder decision, Hubert, 2026-11-14, #1424 decision 1) by one rule in every space: the generator
// records on the asker's notification that it is an answer (`notifications.answer`, migration 0084), from the answer it found, never from
// the words. So an encrypted space, whose notice keeps only its fixed words ("Ben mentioned you in Garden club", no body), lists it as the
// same Reply as a plain space does.

describe('an answer is a Reply in an encrypted space as in a plain one (#1424 decision 1)', () => {
  let ada: Person;
  let ben: Person;
  const spaces: Record<'sealed' | 'plain', { workspace: string; project: string }> = {} as never;

  const post = async <T>(who: Person, path: string, body: unknown) =>
    expectStatus(await who.browser.request('POST', path, { body, headers: { 'idempotency-key': randomUUID() } }), 201, path) as T;
  const queue = async (who: Person) => expectStatus(await who.browser.request('GET', '/api/v1/needs-you'), 200) as NeedsYouResponse;

  before(async () => {
    [ada, ben] = await Promise.all(['Ada', 'Ben'].map(person));
    const sealed = (await createSealed(ada, 'Garden club', passphrase())).workspace.id;
    const plain = (await workspace(ada, 'Book club')).id;
    for (const [side, ws] of [['sealed', sealed], ['plain', plain]] as const) {
      await addMember(ada, ws, ben, 'member');
      const project = await post<Project>(ada, `/api/v1/workspaces/${ws}/projects`, { name: `Shelves ${side}`, visibility: 'workspace' });
      spaces[side] = { workspace: ws, project: project.id };
    }
  });

  for (const side of ['sealed', 'plain'] as const) {
    test(`${side}: Ben's answer to Ada's question is a Reply in her Inbox`, async () => {
      const asked = await post<Conversation>(ada, `/api/v1/projects/${spaces[side].project}/conversations`,
        { body: '@Ben can you send a photo of the new shelf?', clientMessageId: randomUUID() });
      await waitFor(async () => (await queue(ben)).items.find((item) => item.url.includes(asked.id)), 'the question reaches Ben');
      const answer = await post<SentConversationMessage>(ben, `/api/v1/conversations/${asked.id}/messages`, { body: 'Here it is, the left side is done.', clientMessageId: randomUUID() });
      const item = await waitFor(async () => (await queue(ada)).items.find((entry) => entry.url.endsWith(`#message-${answer.id}`)), 'the answer reaches Ada');
      assert.equal(item.kind, 'mention');
      assert.equal(item.answer, true, 'a Reply: the kind is the same in every space');
      assert.equal(item.from?.id, ben.id);
      const note = (expectStatus(await ada.browser.request('GET', '/api/v1/inbox'), 200) as InboxResponse).items.find((entry) => entry.id === item.key.slice(5));
      const row = (await pool.query<{ answer: boolean; title: string; body: string }>('SELECT answer, title, body FROM notifications WHERE id = $1', [item.key.slice(5)])).rows[0]!;
      assert.equal(row.answer, true, 'the generator recorded the answer on the notification');
      if (side === 'sealed') {
        // Content-free: who and where in fixed words, no body; the Inbox shows that sentence as the item's title, and the kind is still Reply.
        assert.deepEqual([row.title, row.body], ['Ben mentioned you in Garden club', '']);
        assert.equal(item.title, 'Ben mentioned you in Garden club');
        assert.equal(note?.title, 'Ben mentioned you in Garden club');
      } else {
        assert.equal(row.title, 'Ben answered you in Shelves plain');
        assert.equal(item.title, 'Here it is, the left side is done.');
      }
      // A notification that is not an answer keeps the flag off, and the database refuses the flag on a reason that cannot answer.
      const other = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND answer AND id <> $2", [ada.id, item.key.slice(5)])).rows[0]!.n;
      assert.equal(other, 0);
      if (side === 'plain') {
        await assert.rejects(pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, reason, title, body, url, ai_origin, answer)
          VALUES (gen_random_uuid(), $1, $2, 'project', $3, 'reply', 'Ben replied', '', '/x', false, true)`, [ada.id, spaces.plain.workspace, spaces.plain.project]),
        { constraint: 'notifications_answer_reason' });
      }
    });
  }
});
