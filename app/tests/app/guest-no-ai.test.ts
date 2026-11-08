import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_CONSOLE_PATH, backgroundComputeConnectionsPath } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, person, workspace as createWorkspace, type Person } from './support/people.js';

// A guest has no AI (F-036, assistant.md): the pages that connect it are hidden, and the server refuses the two steps that make a
// connection, saving an API key and starting a plan sign-in, so a direct address or a hand-made request changes nothing (#959).
// A control for each: a member saving the same key, and a member asking for the same sign-in, are not refused for this.
// A guest is decided by the role in the company (F-037: one company per Flux; C-22), the role the web reads: a role in any other
// workspace changes nothing (#968).

const key = (tag: string) => `sk-ant-api03-owner-budget-key-owner-budget-key-owner-budget-key-${tag}`;
const keyBody = (tag: string) => ({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: key(tag), dailyBudgetCents: 50 });
const codeOf = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;

describe('a guest has no AI (#959, #968)', () => {
  let member: Person; let guest: Person; let outsider: Person; let guestWithRoom: Person; let memberGuestElsewhere: Person;

  before(async () => {
    [member, guest, outsider, guestWithRoom, memberGuestElsewhere] = await Promise.all(['gna-member', 'gna-guest', 'gna-outsider', 'gna-guest-room', 'gna-member-guest-elsewhere'].map(person));
    // The company's roles, written as an invitation would have (a new account is in no company).
    const company = (await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company')).rows[0]!.id;
    for (const [someone, role] of [[member, 'member'], [guest, 'guest'], [guestWithRoom, 'guest'], [memberGuestElsewhere, 'member']] as const)
      await pool.query('INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, $3, $2)', [company, someone.id, role]);
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

  test('the role in the company decides: a guest of the company with a place of their own elsewhere is still refused, and a member who is a guest elsewhere is not', async () => {
    // The guest is a member of another workspace; that does not make them a member of the company.
    const other = await createWorkspace(member, 'Where the guest is a member');
    await addMember(member, other.id, guestWithRoom, 'member');
    const refused = await guestWithRoom.browser.request('POST', backgroundComputeConnectionsPath, { body: keyBody('GU02') });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(codeOf(refused), 'GUEST_NO_AI');
    // A member of the company who is only a guest in another workspace keeps AI.
    const theirs = await createWorkspace(member, 'Where the member is a guest');
    await addMember(member, theirs.id, memberGuestElsewhere, 'guest');
    const allowed = await memberGuestElsewhere.browser.request('POST', backgroundComputeConnectionsPath, { body: keyBody('ME02') });
    assert.notEqual(codeOf(allowed), 'GUEST_NO_AI', allowed.text);
  });

  test('a guest of the company makes no agent in another workspace where they are a member; a member of the company there does (#978)', async () => {
    const otherWorkspace = await createWorkspace(member, 'Another workspace the guest was added to');
    await addMember(member, otherWorkspace.id, guestWithRoom, 'member');
    const agentsOf = async (someone: Person) => Number((await pool.query('SELECT count(*)::int AS n FROM agents WHERE owner_user_id = $1', [someone.id])).rows[0].n);
    const refused = await guestWithRoom.browser.request('POST', `/api/v1/workspaces/${otherWorkspace.id}/agents`, { body: { name: 'Sneaky', owner: 'self' } });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(codeOf(refused), 'GUEST_NO_AI');
    assert.equal(await agentsOf(guestWithRoom), 0, 'no agent was made');
    // The same request from a member of the company, in the same workspace, works.
    await addMember(member, otherWorkspace.id, memberGuestElsewhere, 'member');
    expectStatus(await memberGuestElsewhere.browser.request('POST', `/api/v1/workspaces/${otherWorkspace.id}/agents`, { body: { name: 'Helper', owner: 'self' } }), 201);
    assert.equal(await agentsOf(memberGuestElsewhere), 1);
  });
});
