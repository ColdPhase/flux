import assert from 'node:assert/strict';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { createDatabase } from '@flux/db';
import type { Agent, GithubPullFacts, WorkItem } from '@flux/contracts';
import { NotFoundError, type GithubProvider, type Principal } from '@flux/core';
import { createGithubUseCases } from '../../apps/server/src/github/adapters.js';
import { githubWebhookRoutes } from '../../apps/server/src/github/webhook.js';
import { githubTransport } from '../../apps/server/src/github/http.js';
import { agentConnection } from './support/mcp-actions.js';
import { toolValue } from './support/mcp.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { setSpaceAi } from './support/space-ai.js';

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

test('#479: a linked PR event reaches the task\'s current holder once, private facts stay with the author', async () => {
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
  // An admin's agents work only in the spaces the admin was added to (C-15, #934).
  await grant(hubert, p.id, marek, 'contributor');
  const makeAgent = async (who: Person, name: string) => {
    const agent = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as Agent;
    return { agent, connected: await agentConnection(pool, who.browser, agent.id, [p.id]) };
  };
  const hubertAgent = await makeAgent(hubert, 'Hubert Codex'), marekAgent = await makeAgent(marek, 'Marek Claude');
  /** The agent takes the task over MCP and the task is handed to it: the standing subscription of the bridge. */
  const hold = async (who: Person, held: Awaited<ReturnType<typeof makeAgent>>, title: string) => {
    const item = expectStatus(await who.browser.request('POST', `/api/v1/projects/${p.id}/work`, { body: { title } }), 201) as WorkItem;
    const run = { projectId: p.id, runtimeSessionId: held.connected.runtimeSessionId, peerRequestClass: 'execute' };
    const unit = toolValue(await held.connected.tool('flux_create_unit', { ...run, clientCommandId: randomUUID(), taskId: item.id, unitKey: 'take',
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

  const principal: Principal = { kind: 'human', id: hubert.id };
  const privateBinding = await github.bind(principal, p.id, { installationId: INSTALL, repositoryId: PRIVATE_REPO });
  const publicBinding = await github.bind(principal, p.id, { installationId: INSTALL, repositoryId: PUBLIC_REPO });

  // Nobody holds the task yet: recorded, delivered to nobody, nothing created.
  const firmware = expectStatus(await hubert.browser.request('POST', `/api/v1/projects/${p.id}/work`, { body: { title: 'Unheld firmware' } }), 201) as WorkItem;
  await github.link(principal, firmware.id, { bindingId: privateBinding.id, number: 41, role: 'required_output' });
  await send('pull_request', pullEvent(PRIVATE_REPO, 41));
  assert.deepEqual((await outbox(firmware.id)).map((row) => [row.event, row.state, row.recipient_connection_id]), [['pull_request', 'no_recipient', null]]);

  // Hubert's agent holds the task: the event is delivered to its connection, once.
  const mine = await hold(hubert, hubertAgent, 'Fix the thermal runaway check');
  await github.link(principal, mine.item.id, { bindingId: privateBinding.id, number: 42, role: 'required_output' });
  await send('pull_request', pullEvent(PRIVATE_REPO, 42));
  await send('pull_request', pullEvent(PRIVATE_REPO, 42)); // a redelivery with the same facts
  assert.deepEqual((await outbox(mine.item.id)).map((row) => [row.state, row.recipient_connection_id]), [['delivered', hubertAgent.connected.connectionId]]);
  provider.head = SHA('b');
  await send('pull_request', pullEvent(PRIVATE_REPO, 42));
  // A review event on the same head reaches the holder like any other: Flux coordinates no review of its own whose echo it would hold back.
  const reviewEvent = (id: number, user: number, state: string) => ({ action: 'submitted', repository: { id: Number(PRIVATE_REPO) },
    review: { id, user: { id: user }, state }, pull_request: { id: Number(`${PRIVATE_REPO}42`), number: 42, base: { repo: { id: Number(PRIVATE_REPO) } }, head: { sha: SHA('b') } } });
  await send('pull_request_review', reviewEvent(5001, 7001, 'approved'));
  await send('pull_request_review', reviewEvent(5002, 8888, 'changes_requested'));
  assert.deepEqual((await outbox(mine.item.id)).map((row) => [row.event, row.state, row.head_sha]),
    [['pull_request', 'delivered', SHA('a')], ['pull_request', 'delivered', SHA('b')], ['pull_request_review', 'delivered', SHA('b')],
      ['pull_request_review', 'delivered', SHA('b')]]);

  // A G-1c poll window (no webhook at all) that finds a newer head is processed too.
  provider.head = SHA('d');
  const window = String(randomInt(1_000_000, 9_000_000));
  for (let round = 0; round < 50; round++) if (!await github.schedule(APP, window, 'poll')) break;
  assert.equal(await github.process(`poll-${privateBinding.id}-${window}`, privateBinding.id), 'completed');

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

  // F-029 (#614): the holder is an agent, so the bridge respects the space's AI switch. The flip is applied without its
  // sweep (the window before the sweep commits): while AI is off nobody receives the event, and after AI is on again the
  // unit admitted under the old epoch is no holder, so no event of the blocked period ever reaches the agent.
  await setSpaceAi(p.id, 'blocked');
  provider.head = SHA('e');
  await send('pull_request', pullEvent(PUBLIC_REPO, 7));
  await setSpaceAi(p.id, 'allowed');
  provider.head = SHA('f');
  await send('pull_request', pullEvent(PUBLIC_REPO, 7));
  assert.deepEqual((await outbox(open.item.id)).map((row) => [row.state, row.head_sha]),
    [['delivered', SHA('d')], ['no_recipient', SHA('e')], ['no_recipient', SHA('f')]]);

  // Disconnecting the binding withdraws what its deliveries showed; nothing is woken.
  await github.disconnect(principal, privateBinding.id);
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
