import assert from 'node:assert/strict';
import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { createDatabase, schema } from '@flux/db';
import type { Agent, GithubPullFacts, WorkItem } from '@flux/contracts';
import { NotFoundError, type GithubProvider, type Principal } from '@flux/core';
import { createGithubUseCases } from '../../apps/server/src/github/adapters.js';
import { githubWebhookRoutes } from '../../apps/server/src/github/webhook.js';
import { githubTransport } from '../../apps/server/src/github/http.js';
import { agentConnection } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// #479 AC-3/AC-4: the #153 current-recipient bridge (docs/development/github-integration/README.md "#153 current-recipient
// bridge"). Real sessions, OAuth bearers and MCP tools; the GitHub provider is a fixture, so no real installation is claimed.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(url);
after(() => pool.end());

const APP = '24680', INSTALL = '556', SECRET = 'fixture-webhook-secret-at-least-thirty-two';
const PRIVATE_REPO = String(randomInt(100_000, 900_000)), PUBLIC_REPO = String(randomInt(900_001, 999_999));
const SHA = (c: string) => c.repeat(40);
class Provider implements GithubProvider {
  appId = APP; head = SHA('a'); allowed = new Set<string>(); generation = randomUUID();
  async repository(principal: Principal, installationId: string, repositoryId: string) {
    if (!this.allowed.has(principal.id ?? '') || installationId !== INSTALL) throw new NotFoundError('Repository', 'GITHUB_ACCESS_UNAVAILABLE');
    return { host: 'github.com' as const, installationId, repositoryId, owner: 'fixture', name: `repo-${repositoryId}`, private: repositoryId === PRIVATE_REPO,
      url: `https://github.com/fixture/repo-${repositoryId}`, githubUserId: `9${principal.id!.length}`, appId: APP, authorizationGeneration: this.generation };
  }
  async pull(principal: Principal, repository: { repositoryId: string }, number: number): Promise<GithubPullFacts> {
    if (!this.allowed.has(principal.id ?? '')) throw new NotFoundError('Pull request', 'GITHUB_ACCESS_UNAVAILABLE');
    return { repositoryId: repository.repositoryId, pullId: `${repository.repositoryId}${number}`, number, title: 'PRIVATE title', url: `https://github.com/fixture/pull/${number}`,
      author: { id: '765', login: 'someone' }, headSha: this.head, state: 'open', draft: false, merged: false, sourceCreatedAt: '2026-10-29T10:00:00.000Z',
      sourceUpdatedAt: '2026-10-30T10:00:00.000Z', sourceMergedAt: null, checks: [], reviews: [], truncated: false, execution: 'ready_for_review' };
  }
}

test('#479: a linked PR event reaches the task\'s current holder once, echoes are suppressed, a new head supersedes queued reviews, private facts stay with the author', async () => {
  const provider = new Provider();
  const github = createGithubUseCases(db, provider);
  const app = Fastify({ logger: false });
  await app.register(githubWebhookRoutes, { secret: SECRET, appId: APP, admit: github.admit }); await app.ready();
  after(() => app.close());

  const hubert = await person('Hubert bridge'), marek = await person('Marek bridge');
  provider.allowed.add(hubert.id);
  const ws = await workspace(hubert, 'Bridge');
  // Standing grants need project management, so Marek is a workspace admin; he still is not the private binding's author.
  await addMember(hubert, ws.id, marek, 'admin');
  const p = await project(hubert, ws.id, 'Printer firmware', 'restricted');
  const makeAgent = async (who: Person, name: string) => {
    const agent = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as Agent;
    expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/grants`, { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
    return { agent, connected: await agentConnection(pool, who.browser, agent.id, [p.id]) };
  };
  const hubertAgent = await makeAgent(hubert, 'Hubert Codex'), marekAgent = await makeAgent(marek, 'Marek Claude');
  /** The agent takes the task over MCP and the task is handed to it: the standing subscription of the bridge. */
  const hold = async (who: Person, held: Awaited<ReturnType<typeof makeAgent>>, title: string) => {
    const item = expectStatus(await who.browser.request('POST', `/api/v1/projects/${p.id}/work`, { body: { title } }), 201) as WorkItem;
    const run = { projectId: p.id, runtimeSessionId: held.connected.runtimeSessionId, peerRequestClass: 'execute' };
    const create = await held.connected.grant('cowork.unit.create', 'execute', 5, item.id);
    const unit = toolValue(await held.connected.tool('flux_create_unit', { ...run, grantId: create.id, clientCommandId: randomUUID(), taskId: item.id, unitKey: 'take',
      expectedTaskVersion: item.version, assignmentConnectionId: held.connected.connectionId, parent: null })) as { unitId: string };
    expectStatus(await who.browser.request('PATCH', `/api/v1/work/${item.id}`, { body: { owner: { kind: 'agent', id: held.agent.id }, status: 'in_progress' },
      headers: { 'if-match': `"${item.version}"` } }), 200);
    return { item, unitId: unit.unitId };
  };
  const send = async (event: string, body: Record<string, unknown>) => {
    const raw = JSON.stringify({ installation: { id: Number(INSTALL) }, ...body });
    const response = await app.inject({ method: 'POST', url: '/api/v1/integrations/github/webhook', payload: raw, headers: { 'content-type': 'application/json',
      'x-github-delivery': randomUUID(), 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` } });
    assert.equal(response.statusCode, 202, response.body);
    const due = await pool.query("SELECT delivery_id, binding_id FROM github_processing WHERE state='pending' AND binding_id IN (SELECT id FROM github_bindings WHERE project_id=$1)", [p.id]);
    for (const row of due.rows) await github.process(row.delivery_id, row.binding_id);
  };
  const pullEvent = (repo: string, number: number) => ({ action: 'synchronize', repository: { id: Number(repo) },
    pull_request: { id: Number(`${repo}${number}`), number, base: { repo: { id: Number(repo) } }, head: { sha: provider.head } } });
  const outbox = async (taskId: string) => (await pool.query('SELECT event, state, recipient_connection_id, head_sha FROM github_bridge_outbox WHERE task_id=$1 ORDER BY created_at, id', [taskId])).rows;
  const inbox = async (held: Awaited<ReturnType<typeof makeAgent>>) =>
    toolValue(await held.connected.tool('flux_coordination_inbox', { projectId: p.id })) as { providerEvents?: { taskId: string; linkId: string; event: string; headSha: string }[] };

  const principal: Principal = { kind: 'human', id: hubert.id };
  const privateBinding = await github.bind(principal, p.id, { installationId: INSTALL, repositoryId: PRIVATE_REPO });
  const publicBinding = await github.bind(principal, p.id, { installationId: INSTALL, repositoryId: PUBLIC_REPO });

  // Nobody holds the task yet: recorded, delivered to nobody, nothing created.
  const firmware = expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/work`, { body: { title: 'Unheld firmware' } }), 201) as WorkItem;
  await github.link(principal, firmware.id, { bindingId: privateBinding.id, number: 41, role: 'required_output' });
  await send('pull_request', pullEvent(PRIVATE_REPO, 41));
  assert.deepEqual((await outbox(firmware.id)).map((row) => [row.event, row.state, row.recipient_connection_id]), [['pull_request', 'no_recipient', null]]);

  // Hubert's agent holds the task: the event is delivered to its connection, once, and its inbox lists the reference.
  const mine = await hold(hubert, hubertAgent, 'Fix the thermal runaway check');
  const link = await github.link(principal, mine.item.id, { bindingId: privateBinding.id, number: 42, role: 'required_output' });
  await send('pull_request', pullEvent(PRIVATE_REPO, 42));
  await send('pull_request', pullEvent(PRIVATE_REPO, 42)); // a redelivery with the same facts
  assert.deepEqual((await outbox(mine.item.id)).map((row) => [row.state, row.recipient_connection_id]), [['delivered', hubertAgent.connected.connectionId]]);
  const listed = await inbox(hubertAgent);
  assert.deepEqual(listed.providerEvents?.map((row) => [row.taskId, row.linkId, row.event, row.headSha]), [[mine.item.id, link.id, 'pull_request', SHA('a')]]);
  assert.equal(JSON.stringify(listed.providerEvents).includes('PRIVATE'), false, 'references only, no provider text');
  assert.deepEqual((await inbox(marekAgent)).providerEvents, [], 'another connection sees nothing');

  // Flux review requests on this link: a queued one for the old head and one already coordinated for the new head.
  const lineageId = randomUUID(), runId = randomUUID();
  await db.insert(schema.coworkRequestLineages).values({ id: lineageId, workspaceId: ws.id, projectId: p.id, taskId: mine.item.id, runId,
    maximumRequests: 32, maximumDepth: 4, maximumReviewRounds: 4 });
  const review = async (headSha: string) => {
    const id = randomUUID();
    await db.insert(schema.coworkRequests).values({ aiEpoch: 1, id, lineageId, workspaceId: ws.id, projectId: p.id, taskId: mine.item.id, unitId: mine.unitId,
      senderConnectionId: hubertAgent.connected.connectionId, recipientConnectionId: marekAgent.connected.connectionId, senderOwnerId: hubert.id, recipientOwnerId: marek.id,
      intentKey: `review:${headSha}`, fingerprint: createHash('sha256').update(id).digest('hex'), kind: 'review', target: { type: 'github_pr', bindingId: privateBinding.id, linkId: link.id, headSha },
      sourceRefs: [{ type: 'work', id: mine.item.id, version: 1 }], criteriaRefs: [{ type: 'work', id: mine.item.id, version: 1 }], depth: 0, reviewRound: 1,
      priority: 1, peerUnblocking: false, expiresAt: new Date(Date.now() + 86_400_000) });
    return id;
  };
  const stale = await review(SHA('a'));
  provider.head = SHA('b');
  const current = await review(SHA('b'));
  await send('pull_request', pullEvent(PRIVATE_REPO, 42));
  const states = async () => new Map((await pool.query('SELECT id, state, reason FROM cowork_requests WHERE lineage_id=$1', [lineageId])).rows.map((row) => [row.id, [row.state, row.reason]]));
  assert.deepEqual((await states()).get(stale), ['superseded', 'head_changed'], 'a new head stales the queued review of the old head');
  assert.deepEqual((await states()).get(current), ['queued', null], 'the review of the current head stays');
  // GitHub's review of that same head is the echo of the review Flux already coordinates: not requested twice.
  await send('pull_request_review', { action: 'submitted', repository: { id: Number(PRIVATE_REPO) }, review: { id: 5001 },
    pull_request: { id: Number(`${PRIVATE_REPO}42`), number: 42, base: { repo: { id: Number(PRIVATE_REPO) } }, head: { sha: SHA('b') } } });
  assert.deepEqual((await outbox(mine.item.id)).map((row) => [row.event, row.state, row.head_sha]),
    [['pull_request', 'delivered', SHA('a')], ['pull_request', 'delivered', SHA('b')], ['pull_request_review', 'suppressed_echo', SHA('b')]]);

  // Marek's agent holds a task linked to the PRIVATE repository bound by Hubert: Flux never forwards it (no_access).
  const his = await hold(marek, marekAgent, 'Tune the bed PID');
  await github.link(principal, his.item.id, { bindingId: privateBinding.id, number: 43, role: 'related' });
  await send('pull_request', pullEvent(PRIVATE_REPO, 43));
  assert.deepEqual((await outbox(his.item.id)).map((row) => row.state), ['no_access']);
  // The same holder of a task linked to a PUBLIC repository receives it.
  const open = await hold(marek, marekAgent, 'Document the public build');
  await github.link(principal, open.item.id, { bindingId: publicBinding.id, number: 7, role: 'related' });
  await send('pull_request', pullEvent(PUBLIC_REPO, 7));
  assert.deepEqual((await outbox(open.item.id)).map((row) => [row.state, row.recipient_connection_id]), [['delivered', marekAgent.connected.connectionId]]);
  assert.deepEqual((await inbox(marekAgent)).providerEvents?.map((row) => row.taskId), [open.item.id]);

  // Disconnecting the binding withdraws what its deliveries showed; nothing is woken.
  await github.disconnect(principal, privateBinding.id);
  assert.deepEqual((await inbox(hubertAgent)).providerEvents, []);
});

test('G-1c (#479): conditional GETs send the last ETag for the same URL and token and reuse the body on 304', async () => {
  const seen: (string | null)[] = [];
  let calls = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers).get('if-none-match'));
    calls++;
    if (calls === 2) return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ number: calls }), { status: 200, headers: { etag: `"v${calls}"` } });
  }) as typeof fetch;
  const transport = githubTransport(fetcher);
  const url = 'https://api.github.com/repos/fixture/pulls/1';
  const first = await transport.json(url, { headers: { authorization: 'Bearer one' } });
  const second = await transport.json(url, { headers: { authorization: 'Bearer one' } });
  const other = await transport.json(url, { headers: { authorization: 'Bearer two' } });
  assert.deepEqual([first.data, second.data, other.data], [{ number: 1 }, { number: 1 }, { number: 3 }]);
  assert.deepEqual(seen, [null, '"v1"', null], 'the ETag is sent only for the same token');
});

test('G-1c (#479): a poll window reconciles bound repositories with links and refreshes only their open PRs', async () => {
  const provider = new Provider();
  const github = createGithubUseCases(db, provider);
  const hubert = await person('Hubert poll');
  provider.allowed.add(hubert.id);
  const ws = await workspace(hubert, 'Poll');
  const p = await project(hubert, ws.id, 'Poll project', 'restricted');
  const repo = String(randomInt(1_000_000, 9_000_000));
  const principal: Principal = { kind: 'human', id: hubert.id };
  const binding = await github.bind(principal, p.id, { installationId: INSTALL, repositoryId: repo });
  const item = expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/work`, { body: { title: 'Polled task' } }), 201) as WorkItem;
  await github.link(principal, item.id, { bindingId: binding.id, number: 5, role: 'required_output' });
  await github.link(principal, item.id, { bindingId: binding.id, number: 6, role: 'related' });
  await pool.query("UPDATE github_task_links SET facts = jsonb_set(facts, '{state}', '\"closed\"') WHERE binding_id=$1 AND (facts->>'number')::int = 6", [binding.id]);
  const window = String(randomInt(1_000_000, 9_000_000));
  // Every binding of this App with links is a candidate; at least ours is scheduled once per window.
  for (let round = 0; round < 50; round++) if (!await github.schedule(APP, window, 'poll')) break;
  const id = `poll-${binding.id}-${window}`;
  assert.equal((await pool.query('SELECT origin FROM github_deliveries WHERE id=$1', [id])).rows[0]?.origin, 'reconcile');
  provider.head = SHA('c');
  assert.equal(await github.process(id, binding.id), 'completed');
  const heads = new Map((await pool.query("SELECT (facts->>'number')::int AS n, facts->>'headSha' AS head FROM github_task_links WHERE binding_id=$1", [binding.id])).rows.map((row) => [row.n, row.head]));
  assert.deepEqual([heads.get(5), heads.get(6)], [SHA('c'), SHA('a')], 'the open PR is refreshed, the closed one is left to webhooks and the catch-up');
  assert.equal(await github.schedule(APP, window, 'poll') >= 0, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_deliveries WHERE id=$1', [id])).rows[0].n, 1, 'one poll per binding and window');
});
