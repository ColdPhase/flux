import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { PgBoss } from 'pg-boss';
import { assistantRunChangesActionPath, assistantRunShowPath } from '@flux/contracts';
import { deliverNotificationEmail, type NotificationMailer } from '@flux/core';
import { coworkUnitRows, pushDeliveryRepository } from '@flux/db';
import { emailUnitOfWork } from '../../apps/worker/src/notifications/adapters.js';
import { assistantScene, changesOf, text, type AssistantScene } from './support/assistant-scene.js';
import { db, pool } from './support/db.js';
import { publicOrigin } from './support/http.js';
import { beginOauth, consentContext, mcp, oauthToken, toolValue } from './support/mcp.js';
import { expectStatus, project } from './support/people.js';
import { ensureSpaceAiAllowed, setSpaceAi } from './support/space-ai.js';
import { createConnection, oauthTokenFor, registerOauthClient } from './support/mcp-actions.js';

// AG-10 (F-029 S1 rows of the AC-5 matrix, #614; per space under F-037), each an AI-off case with its control.
// Push and e-mail of AI-origin notifications created before the block; an external client's tool call that names the space;
// co-work epochs; connecting a client, which is not a space's business; idempotent replay of a gated command; the owner's Undo
// while AI is off.

const code = (json: unknown) => (json as { code?: string } | null)?.code;
const fakeBoss = () => {
  const sent: { name: string; data: unknown }[] = [];
  const boss = { send: async (name: string, data?: unknown) => { sent.push({ name, data }); return randomUUID(); } } as unknown as Pick<PgBoss, 'send'> & PgBoss;
  return { boss, sent };
};

async function externalConnection(scene: AssistantScene) {
  const connection = await createConnection(pool, scene.owner.browser, { agentId: scene.agentId });
  const clientId = `flux-test-${randomUUID()}`;
  const redirectUri = 'http://127.0.0.1:19737/callback';
  await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types,
    response_types, scopes, require_pkce, created_at, updated_at) VALUES ($1, $2, 'Flux HTTP test client', $3, 'none', $4, $5, $6, true, now(), now())`,
  [randomUUID(), clientId, [redirectUri], ['authorization_code', 'refresh_token'], ['code'], ['offline_access']]);
  await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [randomUUID(), clientId, `${publicOrigin}/mcp`]);
  const scope = 'offline_access';
  const tokens = await oauthTokenFor(pool, scene.owner.browser, String(connection.id), clientId, redirectUri);
  return { connectionId: String(connection.id), clientId, redirectUri, scope, accessToken: tokens.access_token };
}

describe('space AI switch: the remaining surfaces', () => {
  let scene: AssistantScene; let other: AssistantScene;

  before(async () => {
    scene = await assistantScene('ai-surfaces');
    other = await assistantScene('ai-surfaces-other');
  });
  beforeEach(async () => { await ensureSpaceAiAllowed(scene.place.id); await scene.reset(); });
  after(async () => { await ensureSpaceAiAllowed(scene.place.id); });

  test('push and e-mail skip an AI-origin notification created before the block; a person\'s notification is still sent; read is refused', async () => {
    const { owner, ws, place, agentId } = scene;
    const eventId = randomUUID(); const ai = randomUUID(); const person = randomUUID();
    await pool.query(`INSERT INTO events (id, workspace_id, kind, object_id, actor_id, data) VALUES ($1, $2, 'project.agent_question_asked.v1', $3, $4, '{}')`,
      [eventId, ws.id, place.id, `agent:${agentId}`]);
    await pool.query(`INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, event_id, ai_origin) VALUES
      ($1, $2, $3, 'project', $4, 'From the agent', $5, true), ($6, $2, $3, 'project', $4, 'From Jonas', NULL, false)`, [ai, owner.id, ws.id, place.id, eventId, person]);
    const session = (await pool.query('SELECT id FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [owner.id])).rows[0].id as string;
    const subscriptionId = randomUUID();
    await pool.query(`INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, 'p256dh', 'auth')`,
      [subscriptionId, owner.id, session, `https://push.example.test/${subscriptionId}`]);
    const emails = { ai: randomUUID(), person: randomUUID() };
    await pool.query(`INSERT INTO notification_emails (id, notification_id, user_id, address_kind) VALUES ($1, $2, $4, 'account'), ($3, $5, $4, 'account')`,
      [emails.ai, ai, emails.person, owner.id, person]);
    const target = (notificationId: string) => pushDeliveryRepository(db).findTarget({ notificationId, subscriptionId, userId: owner.id });
    assert.ok(await target(ai), 'control: while AI is on the AI-origin notification is a push target');
    await setSpaceAi(place.id, 'blocked');
    assert.equal(await target(ai), null, 'not pushed while AI is off');
    assert.ok(await target(person), 'a person\'s notification is still pushed');
    const sent: string[] = [];
    const mailer = { send: async (message: { to: string }) => { sent.push(message.to); return { messageId: randomUUID() }; } } as unknown as NotificationMailer;
    const options = { available: true, origin: publicOrigin, uow: emailUnitOfWork(db, fakeBoss().boss), mailer };
    const aiMail = await deliverNotificationEmail(options, { emailId: emails.ai });
    assert.equal((aiMail as { reason?: string }).reason, 'AI is off in this space', JSON.stringify(aiMail));
    const personMail = await deliverNotificationEmail(options, { emailId: emails.person });
    assert.equal(personMail.outcome, 'sent', JSON.stringify(personMail));
    assert.equal(sent.length, 1, 'only the person\'s notification was e-mailed');
    assert.equal((await owner.browser.request('POST', `/api/v1/inbox/${ai}/read`)).status, 404, 'a hidden notification cannot be marked read');
    expectStatus(await owner.browser.request('POST', `/api/v1/inbox/${person}/read`), 200);
  });

  test('an external client\'s tool call that names the space answers SPACE_AI_OFF while AI is off there, and works again; the connection itself stays', async () => {
    const external = await externalConnection(scene);
    const call = (id: number) => mcp(external.accessToken, id, 'tools/call', { name: 'flux_bootstrap', arguments: { projectId: scene.place.id, clientSessionId: randomUUID() } });
    const first = await call(1);
    assert.ok(!(first.message?.result as { isError?: boolean } | undefined)?.isError, `control: ${JSON.stringify(first.message).slice(0, 300)}`);
    await setSpaceAi(scene.place.id, 'blocked');
    const refused = await call(2);
    assert.match(JSON.stringify(refused.message), /SPACE_AI_OFF/, 'the tool call is refused for that space');
    // Not for the connection: the tool list is served (a refusal of a whole connection would drop its sign-in in real clients).
    assert.ok((((await mcp(external.accessToken, 3, 'tools/list')).message?.result as { tools?: unknown[] } | undefined)?.tools ?? []).length > 0, 'the connection still lists its tools');
    await setSpaceAi(scene.place.id, 'allowed');
    const again = await call(4);
    assert.ok(!(again.message?.result as { isError?: boolean } | undefined)?.isError, 'works again once AI is on');
    assert.ok(toolValue(again.message));
  });

  test('a co-work unit admitted under an older epoch is not found by its agent', async () => {
    const work = await scene.task(scene.owner, 'Hand to a unit');
    const unitId = randomUUID();
    const epoch = Number((await pool.query('SELECT epoch FROM project_ai_policies WHERE project_id = $1', [scene.place.id])).rows[0].epoch);
    await pool.query(`INSERT INTO cowork_units (id, workspace_id, project_id, work_id, lineage_work_id, run_id, unit_key, role, assignment_connection_id, ai_epoch)
      VALUES ($1, $2, $3, $4, $4, $5, 'unit', 'execute', $6, $7)`, [unitId, scene.ws.id, scene.place.id, work.id, randomUUID(), await scene.assistantConnectionId(), epoch]);
    const connectionId = await scene.assistantConnectionId();
    // The agent's claim path locks its own unit (`coworkUnitRows.lock`, the `own` predicate carries the epoch).
    const located = () => db.transaction(async (tx) => (await coworkUnitRows(tx).lock({ workspaceId: scene.ws.id, projectId: scene.place.id, connectionId, unitId }))?.unit ?? null);
    assert.ok(await located(), 'control: the unit is found at its epoch');
    await setSpaceAi(scene.place.id, 'blocked');
    await setSpaceAi(scene.place.id, 'allowed');
    assert.equal(await located(), null, 'admitted before the block: never found again');
  });

  test('connecting a client is not a space\'s business: the consent page and Allow work while a space\'s AI is off', async () => {
    const { clientId, redirectUri } = await registerOauthClient(pool);
    await setSpaceAi(scene.place.id, 'blocked');
    const started = await beginOauth(scene.owner.browser, clientId, redirectUri);
    assert.equal((await consentContext(scene.owner.browser, started)).clientName, 'Flux HTTP test client', 'the consent page works');
    assert.ok((await oauthToken(scene.owner.browser, clientId, redirectUri, started)).access_token, 'Allow signs the client in');
  });

  test('flux_list_contexts leaves out a space whose AI is off and still lists the client\'s other spaces', async () => {
    const second = await project(scene.owner, scene.ws.id, 'Second room', 'restricted');
    const { accessToken } = await externalConnection(scene);
    let id = 70;
    const listed = async () => (toolValue((await mcp(accessToken, id += 1, 'tools/call', { name: 'flux_list_contexts', arguments: {} })).message).projects as { id: string }[]).map((row) => row.id).sort();
    assert.deepEqual(await listed(), [scene.place.id, second.id].sort(), 'control: both are listed while AI is on');
    await setSpaceAi(scene.place.id, 'blocked');
    assert.deepEqual(await listed(), [second.id], 'the space with AI off is left out and the call still works for the other');
    await setSpaceAi(scene.place.id, 'allowed');
    assert.deepEqual(await listed(), [scene.place.id, second.id].sort(), 'listed again once AI is on');
  });

  test('an idempotent replay of a gated command is refused while AI is off', async () => {
    const key = randomUUID();
    // A finished run's private answer: its asker shows it to everyone with an Idempotency-Key. Show everyone is gated by the space's
    // switch (AG-10) and stores its response; skipping a waiting change, which #1108 put here, is exempt and stores none.
    const run = await scene.liveRun();
    await scene.complete(run.runId);
    const ask = () => scene.owner.browser.request('POST', assistantRunShowPath(run.runId), { headers: { 'idempotency-key': key } });
    const first = await ask();
    assert.equal(first.status, 200, `the answer is shown with an Idempotency-Key: ${first.text}`);
    await setSpaceAi(scene.place.id, 'blocked');
    const replay = await ask();
    assert.deepEqual([replay.status, code(replay.json)], [403, 'SPACE_AI_OFF']);
    assert.equal(replay.headers.get('idempotent-replayed'), null, 'the stored body is not returned');
    await setSpaceAi(scene.place.id, 'allowed');
    assert.equal((await ask()).headers.get('idempotent-replayed'), 'true', 'control: replayed once AI is on');
  });

  test('the owner can Undo an applied assistant change while AI is off', async () => {
    const mine = await scene.task(scene.owner, 'Order spare probes');
    const run = await scene.liveRun();
    assert.ok(JSON.parse(text((await run.call('flux_update_task', { workId: mine.id, expectedVersion: mine.version, changes: { title: 'Order four spare probes' } })).message)).workId);
    assert.deepEqual((await changesOf(run.runId)).map((row) => row.state), ['applied']);
    await scene.complete(run.runId);
    await setSpaceAi(scene.place.id, 'blocked');
    expectStatus(await scene.owner.browser.request('POST', assistantRunChangesActionPath(run.runId, 'undo'), { body: {} }), 200);
    assert.equal((await scene.taskRow(mine.id)).title, 'Order spare probes', 'the person reversed the AI output');
    const apply = await scene.owner.browser.request('POST', assistantRunChangesActionPath(run.runId, 'apply'), { body: {} });
    assert.equal(code(apply.json), 'SPACE_AI_OFF', 'while Apply stays refused');
  });

  test('other spaces keep AI: the second scene\'s owner works normally while the first is blocked', async () => {
    await setSpaceAi(scene.place.id, 'blocked');
    const ask = (who: typeof other) => who.owner.browser.request('POST', `/api/v1/conversations/${who.thread.id}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'List what moved' } });
    const asked = await ask(other);
    assert.notEqual(code(asked.json), 'SPACE_AI_OFF', 'the other space is not refused by the first one\'s switch (the check stack has no provider, which is its own answer)');
    const space = expectStatus(await other.owner.browser.request('GET', `/api/v1/projects/${other.place.id}`), 200) as { ai: string };
    assert.equal(space.ai, 'allowed');
    // The same person in the blocked space: the question is refused there.
    const refused = await ask(scene);
    assert.deepEqual([refused.status, code(refused.json)], [403, 'SPACE_AI_OFF']);
  });
});
