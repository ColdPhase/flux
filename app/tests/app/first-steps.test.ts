import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { COMPANY_NAME, readFirstSteps, type FirstStepRows } from '@flux/core';
import type { WorkspaceRole } from '@flux/contracts';
import { pool } from './support/db.js';
import { expectStatus, person } from './support/people.js';

// Home's first-steps card (founder decisions 2026-11-13, #1438): which steps are left, by company role, and Hide for good.

function rows(role: WorkspaceRole | null, facts: Partial<{ name: string; hidden: boolean; invited: boolean; ai: boolean; wrote: boolean; photo: boolean; everyone: string | null }> = {}) {
  const read: string[] = [];
  const port: FirstStepRows = {
    company: async () => (role ? { id: 'c', name: facts.name ?? COMPANY_NAME, role, everyoneSpaceId: facts.everyone === undefined ? 'e' : facts.everyone, hidden: facts.hidden ?? false } : null),
    invitedAnyone: async () => { read.push('invited'); return facts.invited ?? false; },
    aiConnected: async () => { read.push('ai'); return facts.ai ?? false; },
    wroteMessage: async () => { read.push('wrote'); return facts.wrote ?? false; },
    hasPhoto: async () => { read.push('photo'); return facts.photo ?? false; },
    hide: async () => undefined,
  };
  return { port, read };
}

describe('#1438 first steps', () => {
  test('rows by role: owner and admin name, invite, connect AI; a member writes, adds a photo and may turn notifications on', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const { port, read } = rows(role);
      assert.deepEqual(await readFirstSteps('u', port), { steps: ['name_company', 'invite_people', 'connect_ai'], offerPush: false, everyoneSpaceId: 'e' });
      assert.deepEqual(read.sort(), ['ai', 'invited'], 'a member\'s facts are not read for an admin');
    }
    const member = rows('member');
    assert.deepEqual(await readFirstSteps('u', member.port), { steps: ['first_message', 'photo'], offerPush: true, everyoneSpaceId: 'e' });
    assert.deepEqual(member.read.sort(), ['photo', 'wrote']);
  });

  test('each row leaves when done; a guest, someone outside a company and a hidden card get none', async () => {
    assert.deepEqual((await readFirstSteps('u', rows('owner', { name: 'Riverside Makers', invited: true, ai: true }).port)).steps, []);
    assert.deepEqual((await readFirstSteps('u', rows('owner', { name: 'Riverside Makers' }).port)).steps, ['invite_people', 'connect_ai']);
    assert.deepEqual((await readFirstSteps('u', rows('member', { wrote: true }).port)).steps, ['photo']);
    assert.deepEqual((await readFirstSteps('u', rows('member', { everyone: null }).port)).steps, ['photo'], 'no Everyone to write in');
    for (const port of [rows('guest').port, rows(null).port, rows('member', { hidden: true }).port]) {
      assert.deepEqual(await readFirstSteps('u', port), { steps: [], offerPush: false, everyoneSpaceId: null });
    }
  });

  test("the route answers the person's own steps, and Hide is for good", async () => {
    const ada = await person('Ada Steps');
    const first = expectStatus(await ada.browser.request('GET', '/api/v1/me/first-steps'), 200) as { steps: string[]; offerPush: boolean };
    assert.ok(Array.isArray(first.steps) && typeof first.offerPush === 'boolean');
    expectStatus(await ada.browser.request('POST', '/api/v1/me/first-steps/hide', { headers: { 'idempotency-key': randomUUID() } }), 204);
    assert.deepEqual(expectStatus(await ada.browser.request('GET', '/api/v1/me/first-steps'), 200), { steps: [], offerPush: false, everyoneSpaceId: null });
    const hidden = (await pool.query<{ first_steps_hidden_at: Date | null }>('SELECT first_steps_hidden_at FROM auth_users WHERE id = $1', [ada.id])).rows[0]!;
    assert.ok(hidden.first_steps_hidden_at instanceof Date);
    // A second Hide keeps the first time.
    expectStatus(await ada.browser.request('POST', '/api/v1/me/first-steps/hide', { headers: { 'idempotency-key': randomUUID() } }), 204);
    const again = (await pool.query<{ first_steps_hidden_at: Date }>('SELECT first_steps_hidden_at FROM auth_users WHERE id = $1', [ada.id])).rows[0]!;
    assert.equal(again.first_steps_hidden_at.getTime(), hidden.first_steps_hidden_at!.getTime());
  });
});
