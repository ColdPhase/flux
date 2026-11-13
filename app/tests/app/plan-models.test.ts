import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { assistantPlanModels, ASSISTANT_PLANS, type PlanModelEntry, type PlanModels, type Workspace } from '@flux/contracts';
import { agentRuntimeUseCases, noPersonalConnections, planModelRetired, runtimeModelAccount, type AgentRuntimeConfig, type PersonalRuntimeAvailability, type PersonalRuntimeStanding, type Principal,
  type RuntimeManagerPort } from '@flux/core';
import { agentRuntimeStore, personalRuntimeRow } from '@flux/db';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { db, insertedHuman, pool } from './support/db.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeQueue } from './support/personal-runs.js';
import { FAKE_PLAN_MODELS } from './support/plan-models.js';

// #1332 (F-022 amended, CA-2): a plan's models come from the signed-in CLI. Part one: what a sign-in and the worker's reading leave in
// PostgreSQL (the real store and use cases, a scripted manager). Part two: what the owner may choose and what pauses an agent, from that list
// (the real use cases, a scripted standing). No CLI, no vendor and no account is used.

const entry = (id: string, extra: Partial<PlanModelEntry> = {}): PlanModelEntry => ({ id, name: id[0]!.toUpperCase() + id.slice(1), note: '', default: false, seesPictures: true, ...extra });
const [OPUS, SONNET, HAIKU] = FAKE_PLAN_MODELS.claude_code as [PlanModelEntry, PlanModelEntry, PlanModelEntry];
const today = () => new Date().toISOString().slice(0, 10);

describe('what a sign-in and the worker\'s reading leave in the database', () => {
  const config: AgentRuntimeConfig = { clients: ['claude_code', 'codex'], commercialTermsAgreedOn: '2026-10-05', idleDays: null, manager: { url: 'http://unused:1', secret: 'x'.repeat(40) } };
  const signed = (label = 'a***@example.org') => ({ signedIn: true as const, facts: { authMethod: 'claude.ai', plan: 'max', accountLabel: label, accountDigest: null } });
  const store = agentRuntimeStore(db);
  const slot = `runtime-${600 + Math.floor(Math.random() * 99)}`;
  const bootId = randomUUID();
  let owner: { id: string }; let bindingId: string; let sessionId: string;
  let reading: PlanModelEntry[] | null = [OPUS, SONNET, HAIKU];
  const asked: string[] = [];
  const manager: RuntimeManagerPort = {
    async slots() { return { ok: true, value: [] }; }, async bind() { return { ok: true, value: undefined }; },
    async release() { return { ok: true, value: { deleted: true, logoutFailed: false, notInstalled: [] } }; },
    async status() { return { ok: true, value: { ...signed(), bootId } }; },
    async logout() { return { ok: true, value: { logout: 'ok', bootId } }; },
    async models(_slot, _id, client) { asked.push(client); return reading ? { ok: true, value: { models: reading, bootId } } : { ok: false, code: 'busy' }; },
  };
  const runtime = agentRuntimeUseCases(config, store, manager);
  const row = async () => (await pool.query<{ models: { listed: { id: string }[]; retired: { id: string; name: string }[] } | null; models_status: string | null; models_checked_at: Date | null }>(
    'SELECT models, models_status, models_checked_at FROM agent_runtime_connections WHERE binding_id = $1 AND client = $2', [bindingId, 'claude_code'])).rows[0]!;
  const standing = () => personalRuntimeRow(db, owner.id, ['claude_code']);
  async function signIn(label?: string) {
    const operation = (await runtime.beginConsole({ ownerUserId: owner.id, sessionId }, 'claude_code', { digest: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: new Date(Date.now() + 60_000) })).operation;
    return runtime.recordSignIn(owner.id, { operation, method: 'sso' }, { ...signed(label), bootId: operation.bootId });
  }

  before(async () => {
    owner = await insertedHuman('plan-models-owner');
    sessionId = randomUUID(); bindingId = randomUUID();
    await pool.query(`INSERT INTO auth_sessions(id, user_id, token, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')`, [sessionId, owner.id, `fixture-${randomUUID()}`]);
    await pool.query(`INSERT INTO agent_runtime_slots(slot, state, boot_id) VALUES ($1, 'ready', $2) ON CONFLICT (slot) DO UPDATE SET state = 'ready', boot_id = $2`, [slot, bootId]);
    await pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'active')`, [bindingId, owner.id, slot]);
  });
  after(async () => {
    await pool.query('DELETE FROM auth_users WHERE id = $1', [owner.id]);
    await pool.query('DELETE FROM agent_runtime_slots WHERE slot = $1', [slot]);
  });

  test('a sign-in stores the list its CLI gave, as ids, names and notes only; the owner\'s standing carries it', async () => {
    assert.equal((await signIn()).signedIn, true);
    assert.deepEqual(asked, ['claude_code'], 'read once, right after the sign-in');
    const stored = await row();
    assert.deepEqual([stored.models_status, stored.models?.listed.map((model) => model.id), stored.models?.retired], ['listed', ['opus', 'sonnet', 'haiku'], []]);
    const shown = (await standing()).models;
    assert.deepEqual(shown, { listed: [OPUS, SONNET, HAIKU], retired: [], state: 'listed', checkedOn: today() });
    assert.ok(!/token|secret|credential|sk-/i.test(JSON.stringify(stored.models)), 'display facts only');
  });

  test('a later list keeps what the plan stopped offering, with the name its CLI gave it; a model that comes back leaves it', async () => {
    await store.saveModels(bindingId, 'claude_code', [OPUS, SONNET], new Date());
    assert.deepEqual((await row()).models, { listed: [OPUS, SONNET], retired: [{ id: 'haiku', name: HAIKU.name }] });
    await store.saveModels(bindingId, 'claude_code', [OPUS, entry('sonnet-6')], new Date());
    assert.deepEqual((await row()).models?.retired.map((model) => model.id), ['haiku', 'sonnet'], 'models stopped one after the other all stay, the oldest first');
    await store.saveModels(bindingId, 'claude_code', [OPUS, SONNET, HAIKU], new Date());
    assert.deepEqual((await row()).models?.retired.map((model) => model.id), ['sonnet-6'], 'the ones that came back are offered again');
  });

  test('a CLI that cannot be read leaves the last list as it was, marked unavailable; the plan with no list says nothing', async () => {
    await store.saveModels(bindingId, 'claude_code', null, new Date());
    const kept = await row();
    assert.deepEqual([kept.models_status, kept.models?.listed.map((model) => model.id)], ['unavailable', ['opus', 'sonnet', 'haiku']]);
    assert.equal((await standing()).models?.state, 'unavailable');
    assert.deepEqual((await standing()).models?.listed, [OPUS, SONNET, HAIKU]);
    // Another connection's row is not touched, and a binding that is not the owner's live signed-in one changes nothing.
    await store.saveModels(randomUUID(), 'claude_code', [OPUS], new Date());
    await store.saveModels(bindingId, 'codex', [OPUS], new Date());
    assert.deepEqual((await row()).models?.listed.map((model) => model.id), ['opus', 'sonnet', 'haiku']);
  });

  test('signing out clears the list, and so does signing in to another account; the same account keeps it', async () => {
    reading = [HAIKU];
    asked.length = 0;
    await signIn();
    assert.deepEqual(asked, [], 'the same account: its list is there, and is not read again');
    assert.deepEqual((await row()).models?.listed.map((model) => model.id), ['opus', 'sonnet', 'haiku']);
    await signIn('b***@example.org');
    assert.deepEqual(asked, ['claude_code'], 'another account: its own models are read');
    assert.deepEqual((await row()).models?.listed.map((model) => model.id), ['haiku']);
    assert.deepEqual((await row()).models?.retired, [], 'nothing of the first account stays');
    await runtime.signOut(owner.id, 'claude_code', sessionId);
    const out = await row();
    assert.deepEqual([out.models, out.models_status, out.models_checked_at], [null, null, null]);
    assert.equal((await standing()).models, null);
    // Signed in again: due at once (never read), whatever the first account had.
    reading = null;
    await signIn();
    assert.equal((await row()).models, null, 'a reading that failed leaves the list unread, for the worker\'s tick');
    const due = (await store.modelsDue({ clients: ['claude_code'], refreshBefore: new Date(), retryBefore: new Date(), limit: 1000 })).filter((item) => item.bindingId === bindingId);
    assert.deepEqual(due, [{ bindingId, slot, client: 'claude_code' }]);
  });

  test('what is due: unread now, read ones after six hours, failed ones after five minutes, and only signed-in plans of a CLI the operator listed', async () => {
    const mine = async (clients: ('claude_code' | 'codex')[] = ['claude_code'], limit = 1000) =>
      (await store.modelsDue({ clients, refreshBefore: new Date(Date.now() - 6 * 3600_000), retryBefore: new Date(Date.now() - 5 * 60_000), limit })).filter((item) => item.bindingId === bindingId).length;
    const set = (status: string | null, ago: string | null) => pool.query(
      `UPDATE agent_runtime_connections SET models = '{"listed":[],"retired":[]}'::jsonb, models_status = $2, models_checked_at = ${ago ? `now() - interval '${ago}'` : 'NULL'} WHERE binding_id = $1 AND client = 'claude_code'`, [bindingId, status]);
    await pool.query(`UPDATE agent_runtime_connections SET state = 'signed_in', signed_in_at = now(), revoked_at = NULL WHERE binding_id = $1 AND client = 'claude_code'`, [bindingId]);
    for (const [status, ago, due] of [['listed', '1 hour', 0], ['listed', '7 hours', 1], ['unavailable', '1 minute', 0], ['unavailable', '6 minutes', 1], [null, null, 1]] as const) {
      await set(status, ago);
      assert.equal(await mine(), due, `${status} ${ago}`);
    }
    assert.equal(await mine(['codex']), 0, 'a CLI the operator did not list is not read');
    assert.equal(await mine([]), 0);
    await pool.query(`UPDATE agent_runtime_connections SET state = 'sign_in_again', signed_in_at = NULL WHERE binding_id = $1`, [bindingId]);
    assert.equal(await mine(), 0, 'a plan that is not signed in has nothing to read');
    await pool.query(`UPDATE agent_runtime_connections SET state = 'signed_in', signed_in_at = now() WHERE binding_id = $1`, [bindingId]);
    await pool.query(`UPDATE agent_runtime_bindings SET state = 'sign_in_again' WHERE id = $1`, [bindingId]);
    assert.equal(await mine(), 0, 'nor one whose place is not active');
    await pool.query(`UPDATE agent_runtime_bindings SET state = 'active' WHERE id = $1`, [bindingId]);
  });

  test('the column holds at most 64 KiB, so a CLI cannot fill the row', async () => {
    await assert.rejects(pool.query(`UPDATE agent_runtime_connections SET models = $2::jsonb WHERE binding_id = $1`, [bindingId, JSON.stringify({ listed: 'x'.repeat(70_000) })]), /models_check/);
  });
});

describe('what the owner may choose, and what pauses an agent, comes from the plan\'s list', () => {
  const queue = new FakeQueue();
  const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
  let owner: Person; let ws: Workspace; let agentId: string; let threadId: string;
  const state: { client: 'claude_code' | 'codex'; models: PlanModels | null; signedIn: boolean } = { client: 'claude_code', models: null, signedIn: true };
  const listed = (ids: string[], extra: Partial<PlanModels> = {}): PlanModels => ({ listed: ids.map((id) => [OPUS, SONNET, HAIKU, entry('claude-fable-5-1')].find((model) => model.id === id) ?? entry(id)), retired: [], state: 'listed', checkedOn: today(), ...extra });
  const availability: PersonalRuntimeAvailability = {
    async standing(_owner, client): Promise<PersonalRuntimeStanding> {
      if (!state.signedIn || (client && client !== state.client)) return { state: 'signed_out', payer: null, accountLabel: null, client: client ?? state.client };
      return { state: 'signed_in', payer: 'claude_plan', accountLabel: null, client: state.client, signedInAt: new Date(Date.UTC(2026, 10, 1)), models: state.models };
    },
  };
  const runs = () => personalRunUseCases(db, { queue: queue.factory, connections: noPersonalConnections, providerEnabled: false, runtime: availability });

  before(async () => {
    owner = await person('plan-models-owner-2');
    ws = await createWorkspace(owner, 'Plan models');
    agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    const place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    threadId = (expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, { body: { body: 'Camera fails below 5 lux', clientMessageId: randomUUID() } }), 201) as { id: string }).id;
  });

  test('the choice is exactly what the CLI listed, in its order, under its names, with its own default; Fable and an unsafe id are never shown', async () => {
    state.models = listed(['sonnet', 'opus', 'claude-fable-5-1', 'haiku'], { listed: [SONNET, { ...OPUS, default: true }, entry('claude-fable-5-1'), HAIKU, entry('--bad'), entry('Opus')] });
    const choice = await runs().model(human(owner));
    assert.deepEqual(choice.groups.map((group) => [group.connection, group.account, group.label, group.company, group.options.map((option) => [option.id, option.name, option.callsTools])]),
      [['claude_plan', 'claude_plan', ASSISTANT_PLANS.claude_code.plan, 'Claude', [['sonnet', 'Sonnet 5.5', true], ['opus', 'Opus 5.5', true], ['haiku', 'Haiku 4.5', true]]]]);
    assert.deepEqual(choice.default, { connection: 'claude_plan', model: 'opus' }, 'the CLI\'s own default');
    state.models = listed(['sonnet', 'haiku'], { listed: [SONNET, HAIKU] });
    assert.deepEqual((await runs().model(human(owner))).default, { connection: 'claude_plan', model: 'sonnet' }, 'none marked: the first');
  });

  test('an agent can be set only to a model of the list: others, and one the plan stopped offering, are refused with a plain line', async () => {
    state.models = listed(['opus', 'sonnet'], { listed: [OPUS, SONNET], retired: [{ id: 'haiku', name: 'Haiku 4.5' }] });
    const agent = await runs().enable(human(owner), { agentId, connection: 'claude_plan', model: 'sonnet' });
    assert.deepEqual(agent.model, { connection: 'claude_plan', model: 'sonnet' });
    const refuse = (model: string) => runs().updateAgent(human(owner), agentId, { connection: 'claude_plan', model });
    await assert.rejects(refuse('gpt-6.1-sol'), { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: 'Your Claude plan doesn\'t offer that model. It is still Sonnet.' });
    await assert.rejects(refuse('claude-fable-5-1'), { code: 'ASSISTANT_MODEL_UNAVAILABLE' });
    await assert.rejects(refuse('haiku'), { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: 'Haiku 4.5 is no longer offered by Claude. It is still Sonnet.' });
    const choice = await runs().model(human(owner));
    assert.deepEqual(choice.groups[0]!.options.map((option) => [option.id, option.retired ?? false]), [['opus', false], ['sonnet', false], ['haiku', true]], 'listed, so its agents can say why they are paused');
    assert.equal((await refuse('opus')).model.model, 'opus', 'a negative control: a listed model is accepted');
  });

  test('an agent on a model the plan stopped offering is paused, with no model switched; choosing another model resumes it', async () => {
    state.models = listed(['opus', 'sonnet'], { listed: [OPUS, SONNET], retired: [] });
    await runs().updateAgent(human(owner), agentId, { connection: 'claude_plan', model: 'sonnet' });
    assert.equal((await runs().agentStatus(human(owner), agentId)).state, 'ready');
    // The plan's next list lacks Sonnet.
    state.models = listed(['opus'], { listed: [OPUS], retired: [{ id: 'sonnet', name: 'Sonnet 5.5' }] });
    const paused = await runs().agentStatus(human(owner), agentId);
    assert.deepEqual([paused.state, paused.unavailableReason, paused.enablement?.model], ['unavailable', 'model_retired', 'sonnet'], 'it stays on its model');
    await assert.rejects(runs().invoke(human(owner), threadId, { clientRunId: randomUUID(), kind: 'ask', prompt: 'Hello' }), (error: Error & { details?: { reason?: string } }) => error.details?.reason === 'model_retired');
    await runs().updateAgent(human(owner), agentId, { connection: 'claude_plan', model: 'opus' });
    const back = await runs().agentStatus(human(owner), agentId);
    assert.deepEqual([back.state, back.unavailableReason], ['ready', null]);
  });

  test('a list that was never read pauses nothing, offers no model and does not make up a default; a list that could not be read keeps its last', async () => {
    await runs().updateAgent(human(owner), agentId, { connection: 'claude_plan', model: 'opus' }).catch(() => undefined);
    state.models = null;
    assert.equal((await runs().agentStatus(human(owner), agentId)).state, 'ready', 'nothing is paused for a list Flux could not read');
    const choice = await runs().model(human(owner));
    assert.deepEqual([choice.groups.length, choice.groups[0]!.options, choice.default], [1, [], null], 'the plan is there, with no models yet');
    const another = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'Another', owner: 'self' } }), 201) as { id: string }).id;
    await assert.rejects(runs().enable(human(owner), { agentId: another }), { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: 'Flux is still reading the models of your Claude plan. Try again in a moment. Nothing was turned on.' });
    state.models = listed(['opus', 'haiku'], { listed: [OPUS, HAIKU], state: 'unavailable' });
    assert.deepEqual((await runs().model(human(owner))).groups[0]!.options.map((option) => option.id), ['opus', 'haiku'], 'the CLI cannot be reached: the last list still works');
    assert.equal((await runs().agentStatus(human(owner), agentId)).state, 'ready');
  });

  test('a plan that is not signed in offers nothing, and an agent on the CLI\'s own default is never paused for a list', async () => {
    state.signedIn = false;
    assert.deepEqual((await runs().model(human(owner))).groups, []);
    state.signedIn = true;
    assert.equal(planModelRetired(listed(['opus']), 'claude-code'), false, 'the engine\'s own label is no model of the list');
    assert.equal(planModelRetired(listed(['opus']), 'codex'), false);
    assert.equal(planModelRetired(listed(['opus']), null), false);
    assert.equal(planModelRetired(listed(['opus']), 'haiku'), true);
    assert.equal(planModelRetired({ ...listed([]), listed: [] }, 'haiku'), false, 'an empty list says nothing');
  });

  test('the pure list: no model of Flux\'s own, the CLI\'s default else the first, retired ones last and named as the CLI named them', () => {
    assert.deepEqual(assistantPlanModels(null), { options: [], default: '' });
    assert.deepEqual(assistantPlanModels(undefined), { options: [], default: '' });
    const withRetired = assistantPlanModels({ listed: [SONNET, OPUS], retired: [{ id: 'haiku', name: 'Haiku 4.5' }, { id: 'sonnet', name: 'Old name' }, { id: 'claude-fable-5-1', name: 'Fable' }, { id: '--x', name: 'x' }], state: 'listed', checkedOn: today() });
    assert.deepEqual(withRetired.options.map((option) => [option.id, option.name, option.retired ?? false]), [['sonnet', 'Sonnet 5.5', false], ['opus', 'Opus 5.5', false], ['haiku', 'Haiku 4.5', true]]);
    assert.equal(withRetired.default, 'sonnet');
    assert.equal(runtimeModelAccount('codex', null).company, 'ChatGPT');
    assert.deepEqual(runtimeModelAccount('codex', listed(['opus'])).options.map((option) => option.id), ['opus'], 'the same reading for either CLI');
  });
});
