import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { MyAgent, Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import { addMember, expectStatus, person, workspace, type Person } from './support/people.js';

// The first agent (F-036 AG-1, #857): connecting AI the first time gives a person Assistant, made once on the server when the
// connection is made, never by opening a page. A person who deleted their only agent is not given another by the next
// connection, and a guest, who has no AI, is given nothing. The connection itself never fails because of it.
// Needs AI switched on for the server, which the check stack does with FLUX_TEST_PERSONAL_RUNS=anthropic-mock and
// FLUX_TEST_ANTHROPIC_URL=http://providermock:8095 (skipped otherwise).

const live = process.env.FLUX_TEST_PERSONAL_RUNS === 'anthropic-mock';

const path = '/api/v1/background-compute-connections';
const marker = 'first-agent-key-';
const keyBody = (name: string, suffix: string) => ({ name, provider: 'anthropic', model: 'claude-sonnet-5', apiKey: `sk-ant-api03-${marker.repeat(3)}${suffix}`,
  dailyBudgetCents: 750, timeZone: 'Europe/Warsaw' });
const mine = async (who: Person) => (expectStatus(await who.browser.request('GET', '/api/v1/my-agents'), 200) as { items: MyAgent[] }).items;

describe('the first agent comes with the first connection (#857)', { skip: !live && 'needs FLUX_TEST_PERSONAL_RUNS=anthropic-mock' }, () => {
  let owner: Person; let member: Person; let guest: Person; let alone: Person; let racer: Person; let dual: Person; let ws: Workspace;

  before(async () => {
    owner = await person('first-agent-owner');
    member = await person('first-agent-member');
    guest = await person('first-agent-guest');
    alone = await person('first-agent-alone');
    racer = await person('first-agent-racer');
    dual = await person('first-agent-dual');
    ws = await workspace(owner, 'First agent club');
    await addMember(owner, ws.id, member, 'member');
    await addMember(owner, ws.id, guest, 'guest');
    await addMember(owner, ws.id, racer, 'member');
  });

  test('saving the first key gives the person Assistant, once; a second key does not add another', async () => {
    assert.deepEqual(await mine(owner), [], 'opening the app makes no agent');
    expectStatus(await owner.browser.request('POST', path, { body: keyBody('First key', 'FA01') }), 201);
    const made = await mine(owner);
    assert.deepEqual(made.map((agent) => [agent.name, agent.answersAi]), [['Assistant', true]]);
    expectStatus(await owner.browser.request('POST', path, { body: keyBody('Second key', 'FA02') }), 201);
    assert.deepEqual((await mine(owner)).map((agent) => agent.id), made.map((agent) => agent.id), 'still the one Assistant');
  });

  test('an agent that was deleted is not made again by the next connection', async () => {
    const [assistant] = await mine(owner);
    expectStatus(await owner.browser.request('DELETE', `/api/v1/my-agents/${assistant!.id}`), 204);
    assert.deepEqual(await mine(owner), []);
    expectStatus(await owner.browser.request('POST', path, { body: keyBody('Third key', 'FA03') }), 201);
    assert.deepEqual(await mine(owner), [], 'the person chose to have none');
    // They can still make one themselves, and it is their first again by name only if they say so.
    const again = expectStatus(await owner.browser.request('POST', '/api/v1/my-agents', { body: { workspaceId: ws.id, name: 'Planner' } }), 201) as MyAgent;
    assert.equal(again.name, 'Planner');
  });

  test('each person gets their own Assistant when they connect; nobody else’s is touched', async () => {
    assert.deepEqual(await mine(member), []);
    expectStatus(await member.browser.request('POST', path, { body: keyBody('Member key', 'FA04') }), 201);
    const theirs = await mine(member);
    assert.deepEqual(theirs.map((agent) => agent.name), ['Assistant']);
    const hers = await mine(owner);
    assert.deepEqual(hers.map((agent) => agent.name), ['Planner'], 'the owner is unchanged');
    assert.equal(hers.some((agent) => theirs.some((other) => other.id === agent.id)), false);
  });

  test('a guest is given no agent and cannot make one; a person with no workspace is given none and still connects', async () => {
    const attempt = await guest.browser.request('POST', path, { body: keyBody('Guest key', 'FA05') });
    assert.ok(attempt.status < 500, `the connection is never a server error: ${attempt.status}`);
    assert.deepEqual(await mine(guest), [], 'a guest has no agents and no AI');
    expectStatus(await guest.browser.request('POST', '/api/v1/my-agents', { body: { workspaceId: ws.id } }), 403);
    expectStatus(await alone.browser.request('POST', path, { body: keyBody('Lone key', 'FA06') }), 201);
    assert.deepEqual(await mine(alone), [], 'nowhere to make it');
  });

  test('a guest of the company is refused every step that connects AI and is given nothing, though another workspace has them as a member; as a member they are given their Assistant in the company (#959, #995)', async () => {
    // The page reads the company (else the first workspace) for its "a guest has no AI" line; the server must not make an agent elsewhere.
    const company = (await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company')).rows[0];
    assert.ok(company, 'the stack has its company');
    await workspace(dual, 'Dual club');
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, 'guest', $2)`, [company.id, dual.id]);
    const refusal = (response: { status: number; json?: unknown; text: string }) => [response.status, (JSON.parse(response.text) as { code?: string }).code];
    assert.deepEqual(refusal(await dual.browser.request('POST', path, { body: keyBody('Dual key', 'FA07') })), [403, 'GUEST_NO_AI'], 'a key is not saved');
    assert.deepEqual(refusal(await dual.browser.request('POST', '/api/v1/ai-model-lists', { body: { provider: 'anthropic' } })), [403, 'GUEST_NO_AI'], 'and a provider\'s models are not looked up (#995)');
    assert.deepEqual(await mine(dual), [], 'a guest has no agents, wherever else they are a member');
    // The same person as a member of the company may look the models up, and is given their Assistant there, in the company.
    await pool.query(`UPDATE workspace_members SET role = 'member' WHERE workspace_id = $1 AND user_id = $2`, [company.id, dual.id]);
    expectStatus(await dual.browser.request('POST', '/api/v1/ai-model-lists', { body: { provider: 'anthropic' } }), 200);
    expectStatus(await dual.browser.request('POST', path, { body: keyBody('Dual second key', 'FA08') }), 201);
    const made = await mine(dual);
    assert.deepEqual(made.map((agent) => agent.name), ['Assistant']);
    assert.equal(made[0]!.workspaceId, company.id, 'made in the company');
  });

  test('two connections made at once give one Assistant, not two', async () => {
    const both = await Promise.all([1, 2, 3].map((n) => racer.browser.request('POST', path, { body: keyBody(`Racing key ${n}`, `FB0${n}`) })));
    for (const response of both) assert.ok(response.status === 201, `each key is saved: ${response.status}`);
    assert.deepEqual((await mine(racer)).map((agent) => agent.name), ['Assistant']);
  });
});
