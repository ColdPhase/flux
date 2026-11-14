import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { apiKeySpendToday } from '@flux/db';
import { shippedPriceList, type Principal } from '@flux/core';
import { providerPriceList, type AssistantRun, type Conversation, type Project, type Workspace } from '@flux/contracts';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { agentsSettler } from '../../apps/server/src/personal-runs/make-agent.js';
import { db, pool } from './support/db.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { chooseModel, FakeConnections, FakeQueue } from './support/personal-runs.js';
import { startPiRuntime, type PiRuntime } from './support/pi-runtime.js';

// One provider-neutral path for personal runs (#68, #179 F-020 PROV-2/PROV-3), now that every API key runs in pi in the agent runtime (#1441,
// RT-1): the same use cases, worker processor, rechecks and commit, with the real supervisor and the real pinned pi, whose model is the fake
// model gateway at the wire format and path of the connection's provider. The connection lookup is the test fake (production still composes
// none, #68); no real provider is called. What a provider's adapter sends and how it maps its failures is the adapters' own suites
// (personal-runs-anthropic, provider-adapters); what a request costs and where it stops is the model gateway's (RT-4).

const connections = new FakeConnections();
const queue = new FakeQueue();
const runs = personalRunUseCases(db, { queue: queue.factory, connections, providerEnabled: true });
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
/** An endpoint of the owner's own that no run reaches here: pi's requests go to the gateway, which holds the address. */
const OWN_ENDPOINT = 'https://llm.example.test/v1';

async function row(runId: string) {
  return (await pool.query('SELECT status, provider, model, reserved_micros, charged_micros, cost_state FROM personal_runs WHERE id=$1', [runId])).rows[0];
}

describe('personal runs on any provider through the same path (#179)', () => {
  let owner: Person;
  let ws: Workspace;
  let place: Project;
  let thread: Conversation;
  let agentId: string;
  let pi: PiRuntime;
  let processor: ReturnType<PiRuntime['processor']>;

  before(async () => {
    owner = await person('pr-provider-owner');
    ws = await createWorkspace(owner, 'Provider-neutral assistant');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    pi = await startPiRuntime();
    processor = pi.processor(connections);
    await pi.place(owner.id);
  });
  after(async () => { await pi.close(); });

  test('a key without a known price cannot be picked: its daily budget could not hold, so nothing is turned on (#854)', async () => {
    const unpriced = randomUUID();
    connections.connect(owner.id, unpriced, { provider: 'gemini', model: 'gemini-model', price: null });
    await assert.rejects(runs.enable(human(owner), { agentId, connection: unpriced, model: 'gemini-model' }), { code: 'ASSISTANT_MODEL_UNAVAILABLE' });
    assert.equal((await runs.status(human(owner))).state, 'not_enabled');
    assert.equal((await runs.model(human(owner))).groups.some((group) => group.connection === unpriced), false, 'an unpriced key is not offered in the picker');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id=$1', [owner.id])).rows[0].n, 0);
  });

  for (const target of [
    { provider: 'openai_compatible' as const, model: 'llama3.1:8b', baseUrl: OWN_ENDPOINT, path: '/openai_compatible/chat/completions',
      price: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, source: 'owner' as const, checkedOn: null } },
    { provider: 'anthropic' as const, model: 'claude-sonnet-5', baseUrl: null, path: '/anthropic/v1/messages',
      price: { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, source: 'list' as const, checkedOn: '2026-11-12' } },
  ]) {
    test(`${target.provider}: the model of a key, a run that holds nothing until it starts, pi on the provider's wire with the run's own token, the answer names provider and model`, async () => {
      pi.gateway.script([{ text: 'Fact: the camera fails below 5 lux.' }]);
      const enabled = await runs.status(human(owner)).then((status) => status.enablement);
      if (enabled) { await runs.remove(human(owner)); agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id; }
      const connectionId = randomUUID();
      connections.connect(owner.id, connectionId, target);
      await runs.enable(human(owner), { agentId, connection: connectionId, model: target.model });
      await pi.place(owner.id);
      const status = await runs.status(human(owner));
      assert.equal(status.state, 'ready');
      assert.deepEqual([status.enablement!.connection, status.enablement!.engine, status.enablement!.model], [connectionId, 'server', target.model]);
      assert.equal(status.today!.budgetCents, 1_000, 'the key\'s one daily budget');

      const asked = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
      assert.deepEqual(await row(asked.run.id), { status: 'queued', provider: target.provider, model: target.model, reserved_micros: 0, charged_micros: 0, cost_state: 'reserved' },
        'a request waiting its turn holds nothing yet');
      assert.equal(await processor.process(asked.run.id), 'completed', JSON.stringify(pi.lastPi()));
      // Flux's model gateway holds what each request cost on the run's row; the fake gateway charges nothing.
      assert.deepEqual(await row(asked.run.id), { status: 'completed', provider: target.provider, model: target.model, reserved_micros: 0, charged_micros: 0, cost_state: 'released' });
      assert.equal(pi.gateway.requests.length, 1);
      const [sent] = pi.gateway.requests;
      assert.deepEqual([sent!.path, sent!.model], [target.path, target.model]);
      assert.match(`${sent!.authorization} ${sent!.apiKey}`, /flux_mg_/, 'the credential is the run\'s gateway token');
      assert.doesNotMatch(`${sent!.authorization} ${sent!.apiKey} ${sent!.prompt}`, /test-key-ref/, 'never the key');
      const run = expectStatus(await owner.browser.request('GET', `/api/v1/assistant-runs/${asked.run.id}`), 200) as AssistantRun;
      assert.deepEqual(run.answer!.provenance, { provider: target.provider, model: target.model });
      assert.equal(JSON.stringify(run).includes('test-key-ref'), false);
    });
  }
});

// F-027 AST-11 (#596), Connect AI (#854): the model of an agent, picked from any of its owner's connections in one list grouped by
// connection, with Connect AI's default (the connection made first) preselected. The run is recorded and sent at the chosen model, and a
// change reaches the next request only. Picking a model of another connection moves the assistant there.
describe('the assistant\'s model from any connection (F-027 AST-11, #854)', () => {
  let owner: Person; let viewer: Person; let guest: Person;
  let thread: Conversation;
  let agentId: string;
  let pi: PiRuntime;
  let processor: ReturnType<PiRuntime['processor']>;
  const sonnet5 = randomUUID();

  before(async () => {
    owner = await person('pr-model-owner');
    viewer = await person('pr-model-viewer');
    guest = await person('pr-model-guest');
    const ws = await createWorkspace(owner, 'Assistant model');
    const place = await createProject(owner, ws.id, 'Lamp sensor model', 'workspace');
    expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/members`, { body: { email: viewer.email, role: 'member' } }), 201);
    expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/grants`, { body: { principal: { kind: 'human', id: viewer.id }, role: 'contributor' } }), 201);
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    // The key's models as its provider listed them (#1218): the only source of the picker's list.
    const listed = (id: string, family: string, createdAt: string) => ({ id, name: null, family, createdAt });
    connections.connect(owner.id, sonnet5, { provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: null, models: {
      listed: [listed('claude-sonnet-5', 'Sonnet', '2026-06-01T00:00:00Z'), listed('claude-sonnet-5-5', 'Sonnet', '2026-09-28T00:00:00Z'),
        listed('claude-opus-5-5', 'Opus', '2026-09-21T00:00:00Z'), listed('claude-haiku-5-5', 'Haiku', '2026-10-07T00:00:00Z'),
        listed('claude-fable-5-2', 'Fable', '2026-11-05T00:00:00Z')],
      // Priced by Flux's price list as the release ships it (#1465), as the repository passes it with the key.
      listedAt: new Date(), checkedAt: new Date(), status: 'listed', prices: {}, retired: [], list: providerPriceList(shippedPriceList(), 'anthropic') } });
    pi = await startPiRuntime();
    processor = pi.processor(connections);
    await pi.place(owner.id);
  });
  after(async () => { await pi.close(); });

  test('AST-11.1/AST-11.5: the grouped list, a choice at turn-on, the request at the chosen model; a change reaches the next request only', async () => {
    let choice = await runs.model(human(owner));
    assert.deepEqual([choice.current, choice.default, choice.saved], [null, { connection: sonnet5, model: 'claude-sonnet-5' }, false]);
    assert.equal(choice.groups.length, 1);
    assert.deepEqual([choice.groups[0]!.connection, choice.groups[0]!.account, choice.groups[0]!.company], [sonnet5, 'api_key', 'Anthropic']);
    assert.deepEqual(choice.groups[0]!.options.map((option) => [option.id, option.name, option.note]), [
      // By family, the family with the newest model first (#1218).
      ['claude-fable-5-2', 'Fable 5.2', 'Input $8, output $40 per 1M tokens'],
      ['claude-haiku-5-5', 'Haiku 5.5', 'Input $0.10, output $0.50 per 1M tokens'],
      ['claude-sonnet-5-5', 'Sonnet 5.5', 'Input $2, output $10 per 1M tokens'],
      ['claude-sonnet-5', 'Sonnet 5', 'Input $2, output $10 per 1M tokens'],
      ['claude-opus-5-5', 'Opus 5.5', 'Input $4, output $20 per 1M tokens'],
    ]);
    // A model outside the key's list, or another provider's, is refused at turn-on and nothing is turned on.
    for (const bad of ['gpt-6-sol', 'sonnet', '--model']) {
      await assert.rejects(runs.enable(human(owner), { agentId, connection: sonnet5, model: bad }),
        { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: 'Your API key doesn\'t offer that model. Nothing was turned on.' }, bad);
    }
    // A plan the person is not signed in to is not theirs to pick.
    await assert.rejects(runs.enable(human(owner), { agentId, connection: 'claude_plan', model: 'sonnet' }),
      { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: 'Sign in to Claude first. Nothing was turned on.' });
    assert.equal((await runs.status(human(owner))).state, 'not_enabled');

    const enabled = await runs.enable(human(owner), { agentId, connection: sonnet5, model: 'claude-haiku-5-5' });
    assert.deepEqual([enabled.model.connection, enabled.model.model], [sonnet5, 'claude-haiku-5-5']);
    choice = await runs.model(human(owner));
    assert.deepEqual([choice.current, choice.saved], [{ connection: sonnet5, model: 'claude-haiku-5-5' }, true]);

    pi.gateway.script([{ text: 'Fact: the camera fails below 5 lux.' }]);
    const first = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
    // The next request is sent with the new model; this one keeps Haiku even though the choice changes before it runs.
    choice = await chooseModel(runs, human(owner), { connection: sonnet5, model: 'claude-sonnet-5' });
    assert.deepEqual(choice.current, { connection: sonnet5, model: 'claude-sonnet-5' });
    assert.deepEqual(await row(first.run.id), { status: 'queued', provider: 'anthropic', model: 'claude-haiku-5-5', reserved_micros: 0, charged_micros: 0, cost_state: 'reserved' });
    assert.equal(await processor.process(first.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.deepEqual(pi.gateway.requests.map((item) => [item.path, item.model]), [['/anthropic/v1/messages', 'claude-haiku-5-5']], 'the request sent before the change used Haiku');
    pi.gateway.script([{ text: 'Fact: the camera fails below 5 lux.' }]);
    const second = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'And now?' });
    assert.equal(await processor.process(second.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.equal(pi.gateway.requests[0]!.model, 'claude-sonnet-5');
  });

  test('AST-11.1: another provider\'s model, a bad id or a connection the person does not have is refused with the exact copy and the previous model stays', async () => {
    const refusals: [{ connection: string; model: string }, string][] = [
      [{ connection: sonnet5, model: 'gpt-6-sol' }, 'Your API key doesn\'t offer that model. It is still Sonnet 5.'],
      [{ connection: sonnet5, model: 'not a model id' }, 'Your API key doesn\'t offer that model. It is still Sonnet 5.'],
      [{ connection: randomUUID(), model: 'claude-sonnet-5' }, 'Connect that API key first. It is still Sonnet 5.'],
      [{ connection: 'chatgpt_plan', model: 'gpt-6.1-sol' }, 'Sign in to ChatGPT first. It is still Sonnet 5.'],
    ];
    for (const [pick, message] of refusals) {
      await assert.rejects(chooseModel(runs, human(owner), pick), { code: 'ASSISTANT_MODEL_UNAVAILABLE', message }, JSON.stringify(pick));
    }
    assert.deepEqual((await runs.model(human(owner))).current, { connection: sonnet5, model: 'claude-sonnet-5' });
    // Choosing the same model again changes nothing; a costly model is fine: there is no per-request limit (#843).
    const version = (await runs.status(human(owner))).enablement!.version;
    await chooseModel(runs, human(owner), { connection: sonnet5, model: 'claude-sonnet-5' });
    assert.equal((await runs.status(human(owner))).enablement!.version, version);
    await chooseModel(runs, human(owner), { connection: sonnet5, model: 'claude-fable-5-2' });
    await chooseModel(runs, human(owner), { connection: sonnet5, model: 'claude-sonnet-5' });
  });

  test('#854: several connections at once; the picker is grouped by connection in the order they were made, and a model of another moves the assistant there', async () => {
    const other = await person('pr-model-several-owner');
    const first = randomUUID();
    const second = randomUUID();
    connections.connect(other.id, first, { provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: OWN_ENDPOINT,
      price: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, source: 'owner', checkedOn: null } });
    connections.connect(other.id, second, { provider: 'openai', model: 'gpt-6-luna' });
    const choice = await runs.model(human(other));
    assert.deepEqual(choice.groups.map((group) => group.connection), [first, second], 'one group per connection, the first made first');
    assert.deepEqual(choice.default, { connection: first, model: 'llama3.1:8b' }, 'Connect AI\'s default is the connection made first');
    assert.deepEqual(choice.groups[0]!.options.map((option) => [option.id, option.name]), [['llama3.1:8b', 'llama3.1:8b']], 'an own endpoint offers only its own model');
    assert.deepEqual(choice.groups[1]!.options.map((option) => option.id), ['gpt-6-luna'],
      'a key whose provider has not listed its models yet offers only its own model: Flux keeps no list of its own (#1218)');
  });

  test('AST-11.2: only the owner reads or changes the model; anyone else gets their own empty answer or a refusal', async () => {
    for (const someone of [viewer, guest]) {
      const theirs = await runs.model(human(someone));
      assert.deepEqual([theirs.groups, theirs.current, theirs.default, theirs.saved], [[], null, null, false]);
      await assert.rejects(runs.updateAgent(human(someone), agentId, { connection: sonnet5, model: 'claude-haiku-5-5' }), { code: 'AGENT_NOT_FOUND' }, 'another person\'s agent is not found');
    }
    assert.deepEqual((await runs.model(human(owner))).current, { connection: sonnet5, model: 'claude-sonnet-5' }, 'nobody else changed it');
    // Over HTTP (the API container's own lookup does not hold this test's fake keys): a viewer or guest sees nothing of the owner's.
    for (const [someone, current] of [[viewer, null], [guest, null], [owner, { connection: sonnet5, model: 'claude-sonnet-5' }]] as const) {
      const read = expectStatus(await someone.browser.request('GET', '/api/v1/personal-assistant/model'), 200) as { groups: unknown[]; current: unknown };
      assert.deepEqual([read.groups, read.current], [[], current], 'the API container offers this account no list; only the owner sees their own stored model');
    }
    for (const someone of [viewer, guest]) {
      const refused = await someone.browser.request('PATCH', `/api/v1/my-agents/${agentId}`, { body: { connection: sonnet5, model: 'claude-haiku-5-5' } });
      assert.equal(refused.status, 404, refused.text);
      assert.equal((refused.json as { code: string }).code, 'AGENT_NOT_FOUND');
    }
    const anonymous = await fetch(`${process.env.FLUX_API_URL ?? 'http://api:8080'}/api/v1/personal-assistant/model`);
    assert.equal(anonymous.status, 401);
  });
});

// #854, #843: no payer switching and one daily budget. A removed key pauses its assistant even when another connection exists;
// a request that finds the key's budget used waits, queued, for the key's next day, and nothing is sent to anyone.
describe('no payer switching; the API key\'s one daily budget pauses a request until the next day (#854, #843)', () => {
  let owner: Person;
  let ws: Workspace;
  let thread: Conversation;
  let agentId: string;
  let pi: PiRuntime;
  let processor: ReturnType<PiRuntime['processor']>;

  before(async () => {
    owner = await person('pr-budget-owner');
    ws = await createWorkspace(owner, 'Budget assistant');
    const place = await createProject(owner, ws.id, 'Lamp sensor budget', 'workspace');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
      { body: { body: 'Camera fails below 5 lux in the low-light test', clientMessageId: randomUUID() } }), 201) as Conversation;
    pi = await startPiRuntime();
    processor = pi.processor(connections);
    await pi.place(owner.id);
  });
  after(async () => { await pi.close(); });

  test('a removed key stops its assistant while the owner has several connections; it never switches between them and nothing is sent', async () => {
    const used = randomUUID();
    const spare = randomUUID();
    const another = randomUUID();
    connections.connect(owner.id, used, { provider: 'anthropic', model: 'claude-sonnet-5' });
    connections.connect(owner.id, spare, { provider: 'openai', model: 'gpt-6-luna' });
    connections.connect(owner.id, another, { provider: 'anthropic', model: 'claude-sonnet-5' });
    await runs.enable(human(owner), { agentId, connection: used, model: 'claude-sonnet-5' });
    connections.disconnect(owner.id, used);
    const status = await runs.status(human(owner));
    assert.deepEqual([status.state, status.unavailableReason, status.enablement!.connection], ['unavailable', 'connection_changed', used]);
    const before = (await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id=$1', [owner.id])).rows[0].n;
    await assert.rejects(runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' }), { code: 'PERSONAL_RUN_UNAVAILABLE' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM personal_runs WHERE owner_user_id=$1', [owner.id])).rows[0].n, before, 'nothing ran on the spare key');
    // Only the owner's own pick moves it: then the next request goes to the other connection.
    await chooseModel(runs, human(owner), { connection: spare, model: 'gpt-6-luna' });
    assert.equal((await runs.status(human(owner))).state, 'ready');
    connections.disconnect(owner.id, spare); connections.disconnect(owner.id, another);
    await runs.remove(human(owner));
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
  });

  test('#1424: the only key is removed and another is added: the agent answers on it, nothing is re-pointed, and a second key added later moves nothing', async () => {
    const settle = agentsSettler(db, { queue: queue.factory, connections, providerEnabled: true });
    const first = randomUUID(); const replacement = randomUUID(); const lazy = randomUUID(); const later = randomUUID();
    connections.connect(owner.id, first, { provider: 'anthropic', model: 'claude-sonnet-5' });
    await runs.enable(human(owner), { agentId, connection: first, model: 'claude-sonnet-5' });
    await pi.place(owner.id);

    // The only key is removed: no connection to use, and the agent says so (the page reads "Needs a connection").
    connections.disconnect(owner.id);
    await settle(owner.id);
    const none = await runs.status(human(owner));
    assert.deepEqual([none.state, none.unavailableReason], ['unavailable', 'no_connection']);
    await assert.rejects(runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' }), { code: 'PERSONAL_RUN_UNAVAILABLE' });

    // Another key is added: what the API does after a connect (and after a removal) moves the agent onto the one connection there is, at that key's own model.
    connections.connect(owner.id, replacement, { provider: 'anthropic', model: 'claude-haiku-5-5' });
    assert.equal(await runs.settleAgents(human(owner)), 1);
    assert.deepEqual((await pool.query('SELECT api_key_id, engine, provider, model FROM assistant_settings WHERE agent_id = $1', [agentId])).rows,
      [{ api_key_id: replacement, engine: 'server', provider: 'anthropic', model: 'claude-haiku-5-5' }], 'the agent is on the new key; nothing was asked');
    assert.deepEqual((await runs.listAgents(human(owner))).map((agent) => [agent.model.connection, agent.model.model]), [[replacement, 'claude-haiku-5-5']]);
    assert.equal(await runs.settleAgents(human(owner)), 0, 'an agent on a live key is never touched');
    pi.gateway.script([{ text: 'Fact: the camera fails below 5 lux.' }]);
    const asked = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
    assert.equal(await processor.process(asked.run.id), 'completed', JSON.stringify(pi.lastPi()));
    assert.deepEqual([(await row(asked.run.id)).provider, (await row(asked.run.id)).model], ['anthropic', 'claude-haiku-5-5'], 'the answer came from the new key\'s model');

    // The same without any hook (a plan signed in somewhere the API was not told of): the first request finds it so and keeps it.
    connections.disconnect(owner.id);
    connections.connect(owner.id, lazy, { provider: 'anthropic', model: 'claude-sonnet-5' });
    const seen = await runs.status(human(owner));
    assert.deepEqual([seen.state, seen.enablement!.connection, seen.enablement!.model], ['ready', lazy, 'claude-sonnet-5'], 'a reader shows where it runs now');
    assert.equal((await pool.query('SELECT api_key_id FROM assistant_settings WHERE agent_id = $1', [agentId])).rows[0].api_key_id, replacement, 'reading changes nothing stored');
    const again = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'And now?' });
    assert.equal(again.run.status, 'queued');
    assert.equal((await pool.query('SELECT api_key_id FROM assistant_settings WHERE agent_id = $1', [agentId])).rows[0].api_key_id, lazy, 'the request that found it so kept it');
    await runs.stop(human(owner), again.run.id);

    // A second key added later moves nothing: the agent keeps the one it is on, and a person with two connections chooses per agent.
    connections.connect(owner.id, later, { provider: 'openai', model: 'gpt-6-luna' });
    const stays = await runs.status(human(owner));
    assert.deepEqual([stays.state, stays.enablement!.connection], ['ready', lazy]);
    connections.disconnect(owner.id, later);
    connections.disconnect(owner.id, lazy);
    await runs.remove(human(owner));
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
  });

  test('at the key\'s budget a request waits for the next day, with one line and no switch; the assistant reads "capped"', async () => {
    const tiny = randomUUID();
    const sentBefore = pi.gateway.requests.length;
    // A model whose one request is above the key's whole budget would wait for a day that never comes: it is refused.
    connections.connect(owner.id, tiny, { provider: 'anthropic', model: 'claude-sonnet-5', dailyBudgetCents: 10 });
    await assert.rejects(runs.enable(human(owner), { agentId, connection: tiny, model: 'claude-sonnet-5' }), /can cost more than this key's daily budget/);
    // One request with tools and Anthropic's own web search (#954): (64,000 + 50,000 for the results) × $2/M + 4,000 × $10/M = $0.268;
    // the searches themselves are charged as the gateway meters them, not reserved (#1113).
    connections.connect(owner.id, tiny, { provider: 'anthropic', model: 'claude-sonnet-5', dailyBudgetCents: 26 });
    await assert.rejects(runs.enable(human(owner), { agentId, connection: tiny, model: 'claude-sonnet-5' }), /can cost more than this key's daily budget/);
    connections.connect(owner.id, tiny, { provider: 'anthropic', model: 'claude-sonnet-5', dailyBudgetCents: 27 });
    await runs.enable(human(owner), { agentId, connection: tiny, model: 'claude-sonnet-5' });
    // $0.10 left of the day: less than one largest request of Sonnet 5 (32,000 × $2/M + 4,000 × $10/M = $0.104).
    connections.connect(owner.id, tiny, { provider: 'anthropic', model: 'claude-sonnet-5', dailyBudgetCents: 10 });
    const status = await runs.status(human(owner));
    assert.deepEqual([status.state, status.today!.budgetCents], ['capped', 10]);
    const asked = await runs.invoke(human(owner), thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Where are we?' });
    assert.equal(asked.run.status, 'queued');
    assert.equal(asked.run.endReason, 'budget');
    assert.ok(asked.run.resumesAt && Date.parse(asked.run.resumesAt) > Date.now(), 'it resumes when the key\'s next day starts');
    assert.equal(queue.runIds.includes(asked.run.id), false, 'a paused request is not dispatched now');
    assert.equal(await processor.process(asked.run.id), 'skipped', 'the worker does not start it before its resume time');
    assert.equal((await row(asked.run.id)).status, 'queued');
    assert.equal(pi.gateway.requests.length, sentBefore, 'and nothing is sent to anyone');
    await runs.stop(human(owner), asked.run.id);
    await runs.remove(human(owner));
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
  });

  test('#910: a key\'s day ends at the next local midnight, also on a day the clocks change', async () => {
    const resets = async (timeZone: string, at: string) => (await apiKeySpendToday(db, randomUUID(), undefined, { dailyBudgetCents: 500, timeZone }, new Date(at)))!.resetsAt.toISOString();
    // Warsaw leaves summer time on 25 Oct 2026 (a 25-hour day) and enters it on 28 Mar 2027 (a 23-hour day): 24 hours on would be an hour off.
    assert.equal(await resets('Europe/Warsaw', '2026-10-25T10:00:00Z'), '2026-10-25T23:00:00.000Z');
    assert.equal(await resets('Europe/Warsaw', '2027-03-28T10:00:00Z'), '2027-03-28T22:00:00.000Z');
    assert.equal(await resets('Europe/Warsaw', '2026-11-07T10:00:00Z'), '2026-11-07T23:00:00.000Z');
    assert.equal(await resets('UTC', '2026-11-07T10:00:00Z'), '2026-11-08T00:00:00.000Z');
  });

  test('#915: where the clocks go back at midnight (Havana, 2 Nov 2025) the day begins at the first midnight, and the day before ends there', async () => {
    const window = async (at: string) => (await apiKeySpendToday(db, randomUUID(), undefined, { dailyBudgetCents: 500, timeZone: 'America/Havana' }, new Date(at)))!.resetsAt.toISOString();
    // This was 1 Nov 2026 until tzdata 2026f (IANA NEWS, "Release 2026f - 2026-10-27": "Cuba will not fall back to -05 on 2026-11-01 and instead
    // plans to maintain -04 through 2027-11-07"), which Debian's tzdata 2026f-0+deb13u1 in Flux's database image has. The last fall-back at midnight
    // that is past is 2 Nov 2025; tzdata 2026d and 2026f give it alike, and a future Cuban decision cannot move it.
    // Midnight of 2 Nov 2025 comes twice: 04:00Z (summer time, -04) and 05:00Z (winter time, -05). The eve ends at the first.
    assert.equal(await window('2025-11-01T12:00:00Z'), '2025-11-02T04:00:00.000Z');
    // The day that follows begins at the same instant, so its first hour counts in it, and it ends at the next midnight, which is single.
    assert.equal(await window('2025-11-02T04:30:00Z'), '2025-11-03T05:00:00.000Z');
    assert.equal(await window('2025-11-02T05:30:00Z'), '2025-11-03T05:00:00.000Z');
    assert.equal(await window('2025-11-02T20:00:00Z'), '2025-11-03T05:00:00.000Z');
  });
});
