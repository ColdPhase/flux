import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';
import { createDatabase, githubRows } from '@flux/db';
import type { GithubBinding, GithubPullFacts, WorkItem } from '@flux/contracts';
import { DomainError, githubId, NotFoundError, type GithubProvider, type Principal } from '@flux/core';
import { createGithubUseCases } from '../../apps/server/src/github/adapters.js';
import { githubWebhookRoutes } from '../../apps/server/src/github/webhook.js';
import { githubRoutes } from '../../apps/server/src/github/routes.js';
import { githubCredentials } from '../../apps/server/src/github/credentials.js';
import { githubProvider } from '../../apps/server/src/github/provider.js';
import type { GithubConfig } from '../../apps/server/src/github/config.js';
import { githubTransport, type GithubTransport } from '../../apps/server/src/github/http.js';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { addMember, expectStatus, grant, person, project, workspace, secondSession, type Person } from './support/people.js';
import { publicOrigin } from './support/http.js';
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString); after(() => pool.end());
const APP = '12345'; const INSTALL = '555'; const REPO = '777'; const SHA1 = 'a'.repeat(40); const SHA2 = 'b'.repeat(40);
const config: GithubConfig = { clientId: 'Iv1.fixture', clientSecret: 'fixture-private-client-secret', appId: APP, appSlug: 'flux-fixture',
  webhookSecret: 'fixture-webhook-secret-at-least-thirty-two', encryptionKey: Buffer.alloc(32, 14), publicOrigin };
const actor = (p: Person): Principal => ({ kind: 'human', id: p.id });
const rejected = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);
function facts(repositoryId = REPO, number = 42, headSha = SHA1): GithubPullFacts {
  return { repositoryId, pullId: `${repositoryId}${number}`, number, title: 'PRIVATE provider implementation', url: `https://github.com/fixture/repo-${repositoryId}/pull/${number}`,
    author: { id: '765', login: 'original-github-author' }, headSha, state: 'open', draft: false, merged: false,
    sourceCreatedAt: '2026-09-29T10:00:00.000Z', sourceUpdatedAt: '2026-09-30T10:00:00.000Z', sourceMergedAt: null,
    checks: [{ id: '982', name: 'Required check', appId: '55', state: 'success', sourceUpdatedAt: '2026-09-30T10:00:00.000Z' }], reviews: [], truncated: false, execution: 'ready_for_review' };
}
class ProviderFixture implements GithubProvider {
  appId = APP;
  allowed = new Map<string, Set<string>>(); generations = new Map<string, string>(); calls: string[] = []; failing = new Set<string>(); head = SHA1;
  authorize(p: Person, repositories = [REPO, '778']) { this.allowed.set(p.id, new Set(repositories)); this.generations.set(p.id, randomUUID()); }
  async repository(principal: Principal, installationId: string, repositoryId: string) {
    this.calls.push(`repository:${principal.id}:${repositoryId}`);
    if (!this.allowed.get(principal.id)?.has(repositoryId) || installationId !== INSTALL) throw new NotFoundError('Repository', 'GITHUB_ACCESS_UNAVAILABLE');
    return { host: 'github.com' as const, installationId, repositoryId, owner: 'fixture', name: `repo-${repositoryId}`, private: true,
      url: `https://github.com/fixture/repo-${repositoryId}`, githubUserId: principal.id === 'never-real-provider-id' ? '1' : '999', appId: this.appId, authorizationGeneration: this.generations.get(principal.id)! };
  }
  async pull(principal: Principal, repository: { repositoryId: string }, number: number) {
    this.calls.push(`pull:${principal.id}:${repository.repositoryId}:${number}`);
    if (this.failing.has(principal.id)) throw new Error('fixture provider failure');
    if (!this.allowed.get(principal.id)?.has(repository.repositoryId)) throw new NotFoundError('Pull request', 'GITHUB_ACCESS_UNAVAILABLE');
    return facts(repository.repositoryId, number, this.head);
  }
}
const fixture = new ProviderFixture(); const github = createGithubUseCases(db, fixture);
const rawPull = (pullId: string, repositoryId = REPO, sha = SHA1) => JSON.stringify({ action: 'synchronize', installation: { id: Number(INSTALL) }, repository: { id: Number(repositoryId) },
  pull_request: { id: Number(pullId), number: 42, base: { repo: { id: Number(repositoryId) } }, head: { sha } } });
function webhook(app: ReturnType<typeof Fastify>, body: string, id = randomUUID(), event = 'pull_request', signature?: string) {
  return app.inject({ method: 'POST', url: '/api/v1/integrations/github/webhook', payload: body, headers: { 'content-type': 'application/json',
    'x-github-delivery': id, 'x-github-event': event, 'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', config.webhookSecret).update(body).digest('hex')}` } });
}
describe('GitHub App binding, provenance and durable per-binding inbox (#74)', () => {
  let owner: Person; let second: Person; let viewer: Person; let place: { id: string; workspaceId: string }; let other: { id: string; workspaceId: string };
  let work: WorkItem; let otherWork: WorkItem; let binding: GithubBinding; let otherBinding: GithubBinding; let app: ReturnType<typeof Fastify>;
  before(async () => {
    [owner, second, viewer] = await Promise.all(['github-owner', 'github-second', 'github-flux-only'].map(person));
    const ws = await workspace(owner, 'GitHub fixtures'); const ws2 = await workspace(second, 'GitHub second fixtures');
    await addMember(owner, ws.id, viewer, 'member');
    place = await project(owner, ws.id, 'Private source projection', 'restricted'); other = await project(second, ws2.id, 'Same repository separate project', 'restricted');
    await grant(owner, place.id, viewer, 'viewer'); fixture.authorize(owner); fixture.authorize(second);
    work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Native work title' } }), 201) as WorkItem;
    otherWork = expectStatus(await second.browser.request('POST', `/api/v1/projects/${other.id}/work`, { body: { title: 'Second native task' } }), 201) as WorkItem;
    binding = await github.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: REPO });
    otherBinding = await github.bind(actor(second), other.id, { installationId: INSTALL, repositoryId: REPO });
    app = Fastify({ logger: false }); await app.register(githubWebhookRoutes, { secret: config.webhookSecret, appId: APP, admit: github.admit }); await app.ready();
  });
  after(async () => { await app.close(); });
  test('binds distinct project/repository authority and verifies local PR references', async () => {
    assert.notEqual(binding.id, otherBinding.id);
    assert.equal((await github.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: REPO })).id, binding.id, 'rebind is stable');
    await rejected(github.bind(actor(viewer), place.id, { installationId: INSTALL, repositoryId: REPO }), 'FORBIDDEN');
    await rejected(github.link(actor(owner), work.id, { bindingId: otherBinding.id, number: 42, role: 'required_output' }), 'NOT_FOUND');
    const link = await github.link(actor(owner), work.id, { bindingId: binding.id, number: 42, role: 'required_output' });
    const retry = await github.link(actor(owner), work.id, { bindingId: binding.id, number: 42, role: 'required_output' });
    assert.equal(link.id, retry.id); assert.equal(link.facts.author.login, 'original-github-author');
    assert.equal(link.facts.sourceCreatedAt, '2026-09-29T10:00:00.000Z'); assert.equal(link.taskId, work.id);
    const secondRepo = await github.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: '778' });
    await github.link(actor(owner), work.id, { bindingId: secondRepo.id, number: 42, role: 'required_output' });
    await github.link(actor(owner), work.id, { bindingId: binding.id, number: 99, role: 'related' });
    await github.link(actor(second), otherWork.id, { bindingId: otherBinding.id, number: 42, role: 'required_output' });
    assert.equal((await github.links(actor(owner), work.id)).length, 3);
    assert.equal((await github.links(actor(second), otherWork.id)).length, 1, 'same-repository binding never shares native links');
    await rejected(github.links(actor(second), work.id), 'PROJECT_NOT_FOUND');
    assert.throws(() => githubId(Number.MAX_SAFE_INTEGER + 1), /lossless/); assert.equal(githubId('9007199254740993'), '9007199254740993');
  });
  test('Flux-only member sees no cached private facts, native status/body or ordinary event leak', async () => {
    await rejected(github.links(actor(viewer), work.id), 'GITHUB_ACCESS_UNAVAILABLE');
    await rejected(github.bindings(actor(viewer), place.id), 'GITHUB_ACCESS_UNAVAILABLE');
    const native = expectStatus(await viewer.browser.request('GET', `/api/v1/work/${work.id}`), 200) as WorkItem;
    assert.deepEqual([native.status, native.blocker, native.version], ['open', null, 1]);
    assert.equal(JSON.stringify(native).includes('PRIVATE'), false);
    const events = await pool.query('SELECT data FROM events WHERE object_id=$1', [place.id]);
    assert.equal(JSON.stringify(events.rows).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(events.rows).includes('github.com'), false);
    const exported = expectStatus(await owner.browser.request('GET', `/api/v1/projects/${place.id}/export`), 200);
    assert.equal(JSON.stringify(exported).includes('PRIVATE'), false, 'ordinary project exports cannot broaden private provider facts');
    const notifications = await pool.query('SELECT title,body FROM notifications WHERE workspace_id=$1', [place.workspaceId]);
    assert.equal(JSON.stringify(notifications.rows).includes('PRIVATE'), false, 'no native notification embeds provider facts');
    fixture.allowed.get(owner.id)!.delete(REPO);
    await rejected(github.links(actor(owner), work.id), 'GITHUB_ACCESS_UNAVAILABLE');
    fixture.allowed.get(owner.id)!.add(REPO);
  });
  test('validates exact raw signature, durable admission, GUID/body conflict and event identity', async () => {
    const body = rawPull(facts().pullId); const id = randomUUID();
    assert.equal((await webhook(app, body, id, 'pull_request', 'sha256=' + '0'.repeat(64))).statusCode, 401);
    assert.equal((await webhook(app, `${body} `, id, 'pull_request', `sha256=${createHmac('sha256', config.webhookSecret).update(body).digest('hex')}`)).statusCode, 401);
    const before = fixture.calls.length;
    assert.equal((await webhook(app, body, id)).statusCode, 202); assert.equal(fixture.calls.length, before, 'admission precedes provider processing');
    assert.equal((await webhook(app, body, id)).statusCode, 202);
    assert.equal((await webhook(app, `${body} `, id)).statusCode, 409, 'changed signed bytes under one GUID conflict');
    const pending = await pool.query('SELECT binding_id,state FROM github_processing WHERE delivery_id=$1 ORDER BY binding_id', [id]);
    assert.equal(pending.rowCount, 2); assert.ok(pending.rows.every((row) => row.state === 'pending'));
    assert.equal((await webhook(app, body, randomUUID(), 'check_run')).statusCode, 400, 'header cannot substitute body type');
    assert.equal((await webhook(app, rawPull(facts().pullId, '778').replace('"id":778', '"id":9007199254740993'))).statusCode, 400);
    assert.equal((await webhook(app, 'x'.repeat(2 * 1024 * 1024 + 1))).statusCode, 413);
    const persisted = await pool.query('SELECT digest,origin FROM github_deliveries WHERE id=$1', [id]); assert.equal(persisted.rows[0].origin, 'webhook');
  });
  test('isolates binding failure, converges out-of-order events and deduplicates processing/bridge metadata', async () => {
    const id = randomUUID(); const body = rawPull(facts().pullId); assert.equal((await webhook(app, body, id)).statusCode, 202);
    fixture.failing.add(owner.id);
    await assert.rejects(github.process(id, binding.id), /fixture provider failure/);
    await githubRows(db).failed(id, binding.id, 'GITHUB_UNAVAILABLE');
    assert.equal(await github.process(id, otherBinding.id), 'completed');
    let rows = await pool.query('SELECT binding_id,state FROM github_processing WHERE delivery_id=$1', [id]);
    assert.equal(rows.rows.find((r) => r.binding_id === binding.id).state, 'pending'); assert.equal(rows.rows.find((r) => r.binding_id === otherBinding.id).state, 'completed');
    fixture.failing.delete(owner.id); fixture.head = SHA2;
    await Promise.all([github.process(id, binding.id), github.process(id, binding.id)]);
    assert.equal((await github.links(actor(owner), work.id)).find((r) => r.facts.number === 42 && r.bindingId === binding.id)!.facts.headSha, SHA2);
    const oldDelivery = randomUUID(); assert.equal((await webhook(app, body, oldDelivery)).statusCode, 202); await github.process(oldDelivery, binding.id);
    assert.equal((await github.links(actor(owner), work.id)).find((r) => r.bindingId === binding.id && r.facts.number === 42)!.facts.headSha, SHA2, 'old payload cannot restore old head');
    rows = await pool.query('SELECT * FROM github_bridge_outbox WHERE binding_id=$1 AND head_sha=$2', [binding.id, SHA2]);
    assert.equal(rows.rowCount, 1, 'redelivery with a new GUID and same provider object/current facts updates one correlation');
    assert.equal(rows.rows[0].state, 'pending_audience_adapter');
    const unrelated = JSON.stringify({ action: 'created', installation: { id: Number(INSTALL) }, repository: { id: Number(REPO) }, issue: { number: 1234, pull_request: {} }, comment: { id: 2222 } });
    const unrelatedId = randomUUID(); assert.equal((await webhook(app, unrelated, unrelatedId, 'issue_comment')).statusCode, 202); await github.process(unrelatedId, binding.id);
    assert.equal((await pool.query('SELECT * FROM github_bridge_outbox WHERE delivery_id=$1', [unrelatedId])).rowCount, 0, 'unlinked external comment creates no work request');
  });
  test('current Flux access and authorization generation are rechecked on retry; disconnect retains inaccessible history', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM github_task_links WHERE binding_id=$1', [binding.id]);
    const oldGeneration = fixture.generations.get(owner.id)!; fixture.generations.set(owner.id, randomUUID());
    const id = randomUUID(); await webhook(app, rawPull(facts().pullId), id);
    await rejected(github.process(id, binding.id), 'GITHUB_AUTHORIZATION_CHANGED'); fixture.generations.set(owner.id, oldGeneration);
    await github.disconnect(actor(owner), binding.id);
    await rejected(github.links(actor(owner), work.id), 'GITHUB_BINDING_UNAVAILABLE');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_task_links WHERE binding_id=$1', [binding.id])).rows[0].n, before.rows[0].n);
    binding = await github.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: REPO });
    await grant(owner, place.id, viewer, 'denied');
    const count = fixture.calls.length; await rejected(github.links(actor(viewer), work.id), 'PROJECT_NOT_FOUND'); assert.equal(fixture.calls.length, count, 'invisible project does not call provider');
  });
});

class AuthTransportFixture implements GithubTransport {
  exchanges = 0; refreshes = 0; failRefresh = false; mismatchedApp = false; tokenExpires = 28800; staleCheck = false; neutralCheck = false;
  async json(url: string, init?: RequestInit) {
    const u = new URL(url);
    if (u.pathname === '/login/oauth/access_token') {
      const body = JSON.parse(String(init?.body));
      if (body.grant_type === 'refresh_token') { this.refreshes++; if (this.failRefresh) throw new Error('lost provider response'); }
      else { this.exchanges++; assert.equal(body.client_id, config.clientId); assert.equal(typeof body.code_verifier, 'string'); }
      return { data: { access_token: 'ghu_fixture_private_access', refresh_token: 'ghr_fixture_private_refresh', token_type: 'bearer', scope: '', expires_in: this.tokenExpires, refresh_token_expires_in: 15897600 }, truncated: false };
    }
    if (u.pathname === '/user') return { data: { id: 999, login: 'fixture-user' }, truncated: false };
    if (u.pathname === '/user/installations') return { data: { installations: [{ id: Number(INSTALL), app_id: Number(this.mismatchedApp ? '12346' : APP), account: { login: 'fixture' }, permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' }, suspended_at: null }] }, truncated: false };
    if (u.pathname.endsWith('/repositories')) return { data: { repositories: [{ id: Number(REPO), owner: { login: 'fixture' }, name: 'repo', private: true, permissions: { pull: true } }] }, truncated: false };
    if (/\/pulls\/42$/.test(u.pathname)) return { data: { id: 77742, number: 42, title: 'Private actual provider-shaped fixture', base: { repo: { id: Number(REPO) } }, head: { sha: SHA1 }, user: { id: 765, login: 'original-author' }, state: 'open', draft: false, merged: false, created_at: '2026-09-29T10:00:00Z', updated_at: '2026-09-30T10:00:00Z', merged_at: null }, truncated: false };
    if (u.pathname.endsWith('/check-runs')) return { data: { total_count: 1, check_runs: [{ id: 982, name: 'Required check', app: { id: 55 }, head_sha: this.staleCheck ? SHA2 : SHA1, status: 'completed', conclusion: this.neutralCheck ? 'neutral' : 'success', completed_at: '2026-09-30T10:00:00Z' }] }, truncated: false };
    if (u.pathname.endsWith('/status')) return { data: { sha: SHA1, statuses: [] }, truncated: false };
    if (u.pathname.endsWith('/reviews')) return { data: [] as unknown as Record<string, unknown>, truncated: false };
    throw new Error(`Unexpected fixture provider path: ${u.pathname}`);
  }
}
function tokenReply(expires = 28800) { return { access_token: 'ghu_fixture_private_access', refresh_token: 'ghr_fixture_private_refresh', token_type: 'bearer', scope: '', expires_in: expires, refresh_token_expires_in: 15897600 }; }
test('real session-bound OAuth state/PKCE consumes once, checks current project and encrypts credentials', async () => {
  const owner = await person('github-oauth-owner'); const second = await person('github-oauth-other');
  const ws = await workspace(owner, 'OAuth fixture'); const place = await project(owner, ws.id, 'OAuth callback scope', 'restricted');
  const transport = new AuthTransportFixture(); const app = Fastify({ logger: false });
  const identity = registerIdentity(app, { db, config: loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: publicOrigin, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET, FLUX_AUTH_RATE_LIMIT: 'false' }), mailer: null });
  await app.register(githubRoutes, { db, sessions: identity, config, transport, background: false }); await app.ready();
  const headers = (p: Person) => ({ cookie: p.browser.cookieHeader(), origin: publicOrigin });
  try {
    const start = await app.inject({ method: 'POST', url: `/api/v1/projects/${place.id}/github/authorize`, headers: headers(owner) }); assert.equal(start.statusCode, 200, start.body);
    const url = new URL(start.json().url); const state = url.searchParams.get('state')!; assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('code_challenge')!.length, 43);
    const otherSession = await secondSession(owner);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/integrations/github/callback?state=${state}&code=fixture-code`, headers: { cookie: otherSession.browser.cookieHeader() } })).statusCode, 400, 'same human wrong session cannot consume flow');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/integrations/github/callback?state=${state}&code=fixture-code`, headers: headers(second) })).statusCode, 400);
    const callback = await app.inject({ method: 'GET', url: `/api/v1/integrations/github/callback?state=${state}&code=fixture-code`, headers: headers(owner) }); assert.equal(callback.statusCode, 302, callback.body);
    assert.equal(callback.headers.location, `${publicOrigin}/projects/${place.id}/github`);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/integrations/github/callback?state=${state}&code=fixture-code`, headers: headers(owner) })).statusCode, 400); assert.equal(transport.exchanges, 1);
    const stored = await pool.query('SELECT encrypted_tokens,github_user_id,app_id FROM github_credentials WHERE user_id=$1', [owner.id]);
    assert.equal(stored.rows[0].github_user_id, '999'); assert.equal(stored.rows[0].app_id, APP); assert.equal(stored.rows[0].encrypted_tokens.includes('ghu_'), false);
    const credentials = githubCredentials(db, config, transport); const provider = githubProvider(credentials, config, transport);
    assert.equal((await provider.repository(actor(owner), INSTALL, REPO)).repositoryId, REPO);
    const repo = await provider.repository(actor(owner), INSTALL, REPO);
    const pull = await provider.pull(actor(owner), repo, 42); assert.equal(pull.author.id, '765'); assert.equal(pull.execution, 'ready_for_review');
    transport.neutralCheck = true; assert.equal((await provider.pull(actor(owner), repo, 42)).execution, 'checks_pending', 'neutral is not successful required execution'); transport.neutralCheck = false;
    transport.staleCheck = true; await rejected(provider.pull(actor(owner), repo, 42), 'GITHUB_INVALID_RESPONSE'); transport.staleCheck = false;
    transport.mismatchedApp = true; await rejected(provider.repository(actor(owner), INSTALL, REPO), 'GITHUB_ACCESS_UNAVAILABLE'); transport.mismatchedApp = false;
    const next = await app.inject({ method: 'POST', url: `/api/v1/projects/${place.id}/github/authorize`, headers: headers(owner) }); const nextState = new URL(next.json().url).searchParams.get('state')!;
    await grant(owner, place.id, owner, 'denied');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/integrations/github/callback?state=${nextState}&code=fixture-code`, headers: headers(owner) })).statusCode, 404, 'revoked project authority before callback'); assert.equal(transport.exchanges, 1);
  } finally { await app.close(); }
});
test('uncertain refresh is durably fenced and copied ciphertext cannot become another owner credential', async () => {
  const owner = await person('github-refresh-owner'); const other = await person('github-cipher-other'); const transport = new AuthTransportFixture();
  const credentials = githubCredentials(db, config, transport); await credentials.store(owner.id, tokenReply(1)); await credentials.store(other.id, tokenReply());
  const original = await pool.query('SELECT encrypted_tokens FROM github_credentials WHERE user_id=$1', [owner.id]);
  await pool.query('UPDATE github_credentials SET encrypted_tokens=$1 WHERE user_id=$2', [original.rows[0].encrypted_tokens, other.id]);
  await rejected(credentials.token(other.id), 'GITHUB_AUTHORIZATION_REQUIRED');
  transport.failRefresh = true;
  await rejected(credentials.token(owner.id), 'GITHUB_REFRESH_UNCERTAIN'); assert.equal(transport.refreshes, 1);
  assert.equal(await credentials.state(owner.id), 'uncertain'); await rejected(credentials.token(owner.id), 'GITHUB_AUTHORIZATION_REQUIRED'); assert.equal(transport.refreshes, 1, 'consumed refresh is never replayed');
});
test('provider transport fixes origins, rejects redirects, bounds bodies and suppresses private provider errors', async () => {
  const paths: string[] = [];
  const transport = githubTransport(async (input, init) => { paths.push(String(input)); assert.equal(init?.redirect, 'error');
    return new Response('PRIVATE-TOKEN-RESPONSE', { status: 503 }); });
  await rejected(transport.json('https://evil.example/api'), 'INVALID_INPUT'); assert.equal(paths.length, 0);
  await assert.rejects(transport.json('https://api.github.com/user'), (error: unknown) => error instanceof Error && !error.message.includes('PRIVATE-TOKEN'));
  const bounded = githubTransport(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  await rejected(bounded.json('https://api.github.com/user'), 'GITHUB_INVALID_RESPONSE');
});
test('signed revocations stop selected App/user/repository authority; additions and ping grant nothing', async () => {
  const owner = await person('github-revocation-owner'); const ws = await workspace(owner, 'Revocation fixture');
  const place = await project(owner, ws.id, 'Revoked source', 'restricted');
  const local = new ProviderFixture(); local.authorize(owner); const cases = createGithubUseCases(db, local);
  const transport = new AuthTransportFixture(); const credentials = githubCredentials(db, config, transport);
  await credentials.store(owner.id, tokenReply());
  const first = await cases.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: REPO });
  const second = await cases.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: '778' });
  const app = Fastify({ logger: false }); await app.register(githubWebhookRoutes, { secret: config.webhookSecret, appId: APP, admit: cases.admit }); await app.ready();
  try {
    const selection = (action: string, appId = APP) => JSON.stringify({ action, installation: { id: INSTALL, app_id: appId }, repositories_added: [{ id: '779' }], repositories_removed: [{ id: REPO }] });
    assert.equal((await webhook(app, selection('removed', '12346'), randomUUID(), 'installation_repositories')).statusCode, 400);
    assert.equal((await webhook(app, selection('added'), randomUUID(), 'installation_repositories')).statusCode, 202);
    assert.equal((await githubRows(db).bindings(place.id)).length, 2, 'installation additions never bind');
    assert.equal((await webhook(app, selection('removed'), randomUUID(), 'installation_repositories')).statusCode, 202);
    assert.equal((await githubRows(db).binding(first.id))?.state, 'revoked'); assert.equal((await githubRows(db).binding(second.id))?.state, 'active');
    assert.equal((await webhook(app, JSON.stringify({ hook_id: 99, hook: { id: 99 }, zen: 'fixture' }), randomUUID(), 'ping')).statusCode, 202);
    assert.equal((await githubRows(db).bindings(place.id)).length, 2);
    assert.equal((await webhook(app, JSON.stringify({ action: 'revoked', sender: { id: '999' } }), randomUUID(), 'github_app_authorization')).statusCode, 202);
    assert.equal(await credentials.state(owner.id), 'required'); assert.equal((await githubRows(db).binding(second.id))?.state, 'revoked');
    assert.equal((await pool.query('SELECT encrypted_tokens FROM github_credentials WHERE user_id=$1', [owner.id])).rows[0].encrypted_tokens, null);
    await cases.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: '778' });
    assert.equal((await webhook(app, JSON.stringify({ action: 'suspend', installation: { id: INSTALL, app_id: APP } }), randomUUID(), 'installation')).statusCode, 202);
    assert.equal((await githubRows(db).binding(second.id))?.state, 'revoked');
    assert.equal((await webhook(app, JSON.stringify({ action: 'unsuspend', installation: { id: INSTALL, app_id: APP } }), randomUUID(), 'installation')).statusCode, 202);
    assert.equal((await githubRows(db).binding(second.id))?.state, 'revoked', 'unsuspension never silently restores authority');
  } finally { await app.close(); }
});
test('bounded gap recovery targets only known links and one binding, coalesces pending work and retries with current rights', async () => {
  const owner = await person('github-gap-owner'); const ws = await workspace(owner, 'Gap recovery fixture');
  const provider = new ProviderFixture(); provider.appId = '99981'; provider.authorize(owner); const cases = createGithubUseCases(db, provider);
  const bindings: GithubBinding[] = [];
  for (let n = 0; n < 6; n++) {
    const place = await project(owner, ws.id, `Known binding ${n}`, 'restricted');
    const work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: `Existing work ${n}` } }), 201) as WorkItem;
    const binding = await cases.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: REPO }); bindings.push(binding);
    await cases.link(actor(owner), work.id, { bindingId: binding.id, number: 42, role: 'required_output' });
  }
  const empty = await project(owner, ws.id, 'No linked objects', 'restricted');
  await cases.bind(actor(owner), empty.id, { installationId: INSTALL, repositoryId: REPO });
  assert.equal(await cases.schedule(provider.appId, '501'), 5); assert.equal(await cases.schedule(provider.appId, '501'), 1);
  assert.equal(await cases.schedule(provider.appId, '501'), 0); assert.equal(await cases.schedule(provider.appId, '502'), 0, 'an outage does not accumulate local jobs');
  const deliveryRows = await pool.query('SELECT id,target_binding_id,origin FROM github_deliveries WHERE app_id=$1', [provider.appId]);
  assert.equal(deliveryRows.rowCount, 6);
  for (const delivery of deliveryRows.rows) {
    const processing = await pool.query('SELECT binding_id FROM github_processing WHERE delivery_id=$1', [delivery.id]);
    assert.deepEqual(processing.rows.map((row) => row.binding_id), [delivery.target_binding_id], 'no fanout into another project using the same repository');
  }
  const first = deliveryRows.rows[0]; provider.allowed.get(owner.id)!.delete(REPO);
  await rejected(cases.process(first.id, first.target_binding_id), 'GITHUB_ACCESS_UNAVAILABLE');
  provider.allowed.get(owner.id)!.add(REPO); provider.head = SHA2;
  for (const row of deliveryRows.rows) await cases.process(row.id, row.target_binding_id);
  assert.equal(await cases.schedule(provider.appId, '502'), 5);
  const manual = await cases.reconcile(actor(owner), bindings[0]!.id);
  assert.equal(await cases.reconcile(actor(owner), bindings[0]!.id), manual, 'manual retry coalesces with pending local reconciliation');
  await cases.disconnect(actor(owner), bindings[0]!.id);
  await rejected(cases.reconcile(actor(owner), bindings[0]!.id), 'GITHUB_BINDING_UNAVAILABLE');
});
test('restore maintenance revokes provider credentials, flows and processing while retaining unavailable source history', async () => {
  const owner = await person('github-restored-owner'); const ws = await workspace(owner, 'Restore fixture'); const place = await project(owner, ws.id, 'Retained source', 'restricted');
  const provider = new ProviderFixture(); provider.authorize(owner); const cases = createGithubUseCases(db, provider);
  const transport = new AuthTransportFixture(); const credentials = githubCredentials(db, config, transport); await credentials.store(owner.id, tokenReply());
  const binding = await cases.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: REPO });
  const work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Survives restore' } }), 201) as WorkItem;
  const linked = await cases.link(actor(owner), work.id, { bindingId: binding.id, number: 42, role: 'required_output' }); await cases.reconcile(actor(owner), binding.id);
  const app = Fastify({ logger: false }); const identity = registerIdentity(app, { db, config: loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: publicOrigin, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET, FLUX_AUTH_RATE_LIMIT: 'false' }), mailer: null });
  await app.register(githubRoutes, { db, sessions: identity, config, transport, background: false }); await app.ready();
  try {
    const headers = { cookie: owner.browser.cookieHeader(), origin: publicOrigin };
    const flow = await app.inject({ method: 'POST', url: `/api/v1/projects/${place.id}/github/authorize`, headers });
    assert.equal(flow.statusCode, 200); const state = new URL(flow.json().url).searchParams.get('state')!;
    const maintenance = execFileSync(process.execPath, ['tooling/dist/operations.js', 'revoke-github-access'], { encoding: 'utf8' });
    assert.match(maintenance, /Revoked [1-9]\d* GitHub authorization\(s\) and [1-9]\d* GitHub binding\(s\)/);
    assert.equal(await credentials.state(owner.id), 'required'); assert.equal((await githubRows(db).binding(binding.id))?.state, 'revoked');
    assert.equal((await pool.query('SELECT state,facts FROM github_task_links WHERE id=$1', [linked.id])).rows[0].facts.pullId, linked.facts.pullId);
    assert.equal((await pool.query('SELECT state FROM github_task_links WHERE id=$1', [linked.id])).rows[0].state, 'unavailable');
    assert.equal((await githubRows(db).due()).length, 0, 'restored jobs cannot resume authority');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/integrations/github/callback?state=${state}&code=fixture-code`, headers })).statusCode, 400);
    assert.equal(transport.exchanges, 0, 'restored OAuth flow cannot exchange');
    await rejected(cases.links(actor(owner), work.id), 'GITHUB_BINDING_UNAVAILABLE');
  } finally { await app.close(); }
});
