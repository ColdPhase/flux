import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_CONSOLE_PATH, backgroundComputeConnectionsPath, type Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, person, workspace as createWorkspace, type Person } from './support/people.js';

// A guest has no AI (F-036, assistant.md): the pages that connect it are hidden, and the server refuses the two steps that make a
// connection, saving an API key and starting a plan sign-in, so a direct address or a hand-made request changes nothing (#959).
// A control for each: a member saving the same key, and a member asking for the same sign-in, are not refused for this.

const key = (tag: string) => `sk-ant-api03-owner-budget-key-owner-budget-key-owner-budget-key-${tag}`;
const keyBody = (tag: string) => ({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: key(tag), dailyBudgetCents: 50 });
const codeOf = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;

describe('a guest has no AI (#959)', () => {
  let owner: Person; let member: Person; let guest: Person; let outsider: Person; let ws: Workspace;

  before(async () => {
    [owner, member, guest, outsider] = await Promise.all(['gna-owner', 'gna-member', 'gna-guest', 'gna-outsider'].map(person));
    ws = await createWorkspace(owner, 'No AI for guests');
    await addMember(owner, ws.id, member, 'member');
    await addMember(owner, ws.id, guest, 'guest');
  });

  const saved = async (someone: Person) => Number((await pool.query('SELECT count(*)::int AS n FROM background_compute_connections WHERE owner_user_id = $1', [someone.id])).rows[0].n);

  test('saving an API key is refused for a guest and makes nothing; a member saves the same key', async () => {
    const refused = await guest.browser.request('POST', backgroundComputeConnectionsPath, { body: keyBody('GU01') });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(codeOf(refused), 'GUEST_NO_AI');
    assert.equal(await saved(guest), 0, 'no connection was made');
    assert.deepEqual((expectStatus(await guest.browser.request('GET', backgroundComputeConnectionsPath), 200) as unknown[]), [], 'and the guest lists none');
    expectStatus(await member.browser.request('POST', backgroundComputeConnectionsPath, { body: keyBody('ME01') }), 201);
    assert.equal(await saved(member), 1);
  });

  test('a plan sign-in is refused for a guest at both steps; a member is not refused for being one', async () => {
    const console = { client: 'claude_code', method: 'claude_account' };
    for (const [path, body] of [[AGENT_RUNTIME_CONSOLE_PATH, console], [AGENT_RUNTIME_BINDING_PATH, undefined]] as const) {
      const refused = await guest.browser.request('POST', path, body ? { body } : {});
      assert.equal(refused.status, 403, `${path}: ${refused.text}`);
      assert.equal(codeOf(refused), 'GUEST_NO_AI', path);
      const allowed = await member.browser.request('POST', path, body ? { body } : {});
      assert.notEqual(codeOf(allowed), 'GUEST_NO_AI', `${path}: a member meets whatever else is true, never the guest rule`);
    }
  });

  test('someone who belongs to no company is not called a guest', async () => {
    const response = await outsider.browser.request('POST', backgroundComputeConnectionsPath, { body: keyBody('OU01') });
    assert.notEqual(codeOf(response), 'GUEST_NO_AI', response.text);
  });

  test('a person who is a guest in one company and a member in another keeps AI (a guest in every workspace they belong to has none)', async () => {
    const other = await createWorkspace(member, 'Where the guest is a member');
    await addMember(member, other.id, guest, 'member');
    const response = await guest.browser.request('POST', backgroundComputeConnectionsPath, { body: keyBody('GU02') });
    assert.notEqual(codeOf(response), 'GUEST_NO_AI', response.text);
  });
});
