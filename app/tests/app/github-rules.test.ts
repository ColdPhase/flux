import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';
import { createDatabase } from '@flux/db';
import type { GithubBinding, GithubCapabilities, GithubCheck, GithubPullFacts, GithubTaskLink, GithubTaskRuleView, ReturnSummary, WorkItem } from '@flux/contracts';
import { NotFoundError, type GithubProvider, type Principal } from '@flux/core';
import { createGithubUseCases } from '../../apps/server/src/github/adapters.js';
import { githubRoutes } from '../../apps/server/src/github/routes.js';
import { githubCredentials } from '../../apps/server/src/github/credentials.js';
import { githubTransport } from '../../apps/server/src/github/http.js';
import type { GithubConfig } from '../../apps/server/src/github/config.js';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';
import { publicOrigin } from './support/http.js';

// "Let linked PRs move this task" (#74 G-1a) through the real routes, SQL, durable inbox and per-binding processing.
// Only the provider is a typed fixture (no real installation); every effect is read back from the API and database.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString); after(() => pool.end());
// Its own App ID: signed deliveries fan out to every binding of a repository under one App, and github.test.ts counts them.
const APP = '54321'; const INSTALL = '555'; const REPO = '777'; const REPO2 = '778';
const SHA1 = 'a'.repeat(40); const SHA2 = 'b'.repeat(40);
const config: GithubConfig = { clientId: 'Iv1.rule-fixture', clientSecret: 'rule-fixture-client-secret', appId: APP, appSlug: 'flux-rule-fixture',
  webhookSecret: 'rule-fixture-webhook-secret-at-least-thirty-two', encryptionKey: Buffer.alloc(32, 21), publicOrigin };
const actor = (p: Person): Principal => ({ kind: 'human', id: p.id });
const check = (state: GithubCheck['state'], name = 'firmware / test'): GithubCheck => ({ id: '982', name, appId: '55', state, sourceUpdatedAt: '2026-10-05T10:00:00.000Z' });
type Pull = { state: 'open' | 'closed'; draft: boolean; merged: boolean; headSha: string; checks: GithubCheck[] };

class RuleProvider implements GithubProvider {
  allowed = new Map<string, Set<string>>(); generations = new Map<string, string>(); pulls = new Map<string, Pull>(); githubIds = new Map<string, string>();
  authorize(p: Person, repositories = [REPO, REPO2]) {
    this.allowed.set(p.id, new Set(repositories)); this.generations.set(p.id, randomUUID());
    if (!this.githubIds.has(p.id)) this.githubIds.set(p.id, String(7000 + this.githubIds.size)); // one GitHub account per person
  }
  set(repositoryId: string, number: number, change: Partial<Pull>) {
    this.pulls.set(`${repositoryId}:${number}`, { state: 'open', draft: false, merged: false, headSha: SHA1, checks: [check('success')], ...this.pulls.get(`${repositoryId}:${number}`), ...change });
  }
  async repository(principal: Principal, installationId: string, repositoryId: string) {
    if (!this.allowed.get(principal.id)?.has(repositoryId) || installationId !== INSTALL) throw new NotFoundError('Repository', 'GITHUB_ACCESS_UNAVAILABLE');
    return { host: 'github.com' as const, installationId, repositoryId, owner: 'lamp-team', name: `repo-${repositoryId}`, private: true,
      url: `https://github.com/lamp-team/repo-${repositoryId}`, githubUserId: this.githubIds.get(principal.id)!, appId: APP, authorizationGeneration: this.generations.get(principal.id)! };
  }
  async pull(principal: Principal, repository: { repositoryId: string; url: string }, number: number): Promise<GithubPullFacts> {
    if (!this.allowed.get(principal.id)?.has(repository.repositoryId)) throw new NotFoundError('Pull request', 'GITHUB_ACCESS_UNAVAILABLE');
    const pull = this.pulls.get(`${repository.repositoryId}:${number}`) ?? { state: 'open', draft: false, merged: false, headSha: SHA1, checks: [check('success')] };
    const execution = pull.merged ? 'merged' : pull.state === 'closed' ? 'closed_unmerged' : pull.draft ? 'draft'
      : pull.checks.some((item) => item.state === 'failure') ? 'checks_failed' : pull.checks.every((item) => item.state === 'success') ? 'ready_for_review' : 'checks_pending';
    return { repositoryId: repository.repositoryId, pullId: `${repository.repositoryId}${number}`, number, title: 'PRIVATE firmware change', url: `${repository.url}/pull/${number}`,
      author: { id: '765', login: 'nia-firmware' }, headSha: pull.headSha, state: pull.state, draft: pull.draft, merged: pull.merged,
      sourceCreatedAt: '2026-10-01T10:00:00.000Z', sourceUpdatedAt: '2026-10-05T10:00:00.000Z', sourceMergedAt: pull.merged ? '2026-10-05T11:00:00.000Z' : null,
      checks: pull.checks, reviews: [], truncated: false, execution };
  }
}

const fixture = new RuleProvider(); const github = createGithubUseCases(db, fixture);
let app: ReturnType<typeof Fastify>;
before(async () => {
  app = Fastify({ logger: false });
  const identity = registerIdentity(app, { db, config: loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: publicOrigin, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET, FLUX_AUTH_RATE_LIMIT: 'false' }), mailer: null });
  await app.register(githubRoutes, { db, sessions: identity, config, provider: fixture, background: false }); await app.ready();
});
after(async () => { await app?.close(); });

async function call(who: Person, method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown) {
  const response = await app.inject({ method, url, headers: { cookie: who.browser.cookieHeader(), origin: publicOrigin }, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: response.statusCode, json: response.body ? JSON.parse(response.body) : null };
}
const rulePath = (task: { id: string }) => `/api/v1/work/${task.id}/github-rule`;
async function work(who: Person, task: { id: string }) { return expectStatus(await who.browser.request('GET', `/api/v1/work/${task.id}`), 200) as WorkItem; }
async function patch(who: Person, task: WorkItem, body: Record<string, unknown>) {
  return expectStatus(await who.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { ...body, expectedVersion: task.version } }), 200) as WorkItem;
}
async function enable(who: Person, task: { id: string }, body: Record<string, unknown> = {}) {
  const current = await work(who, task);
  const response = await call(who, 'PUT', rulePath(task), { enabled: true, expectedVersion: current.version, ...body });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json as GithubTaskRuleView;
}
/** Processes every pending delivery of these bindings, oldest first, as the background sweep does. */
async function settle(...bindings: GithubBinding[]) {
  for (const binding of bindings) {
    const rows = await pool.query(`SELECT gp.delivery_id FROM github_processing gp JOIN github_deliveries gd ON gd.id=gp.delivery_id
      WHERE gp.binding_id=$1 AND gp.state='pending' ORDER BY gd.received_at, gd.id`, [binding.id]);
    for (const row of rows.rows) await github.process(row.delivery_id, binding.id);
  }
}
function webhook(event: string, payload: Record<string, unknown>, id = randomUUID()) {
  const body = JSON.stringify({ installation: { id: Number(INSTALL) }, ...payload });
  return app.inject({ method: 'POST', url: '/api/v1/integrations/github/webhook', payload: body, headers: { 'content-type': 'application/json',
    'x-github-delivery': id, 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', config.webhookSecret).update(body).digest('hex')}` } });
}
const pullEvent = (action: string, repositoryId: string, number: number, sha = SHA1) => ({ action, repository: { id: Number(repositoryId) },
  pull_request: { id: Number(`${repositoryId}${number}`), number, base: { repo: { id: Number(repositoryId) } }, head: { sha } } });
const checkEvent = (repositoryId: string, number: number, sha = SHA1) => ({ action: 'completed', repository: { id: Number(repositoryId) },
  check_run: { id: 982, head_sha: sha, pull_requests: [{ number }] } });
async function changes(who: Person, task: { id: string }) { return ((await call(who, 'GET', rulePath(task))).json as GithubTaskRuleView).changes; }

async function setup(label: string, criteria: string[] = []) {
  const owner = await person(`${label} Ada`); const writer = await person(`${label} Kai`); const viewer = await person(`${label} Jonas`); const outsider = await person(`${label} Mira`);
  const ws = await workspace(owner, `${label} lamp workshop`); await addMember(owner, ws.id, writer, 'member'); await addMember(owner, ws.id, viewer, 'member');
  const place = await project(owner, ws.id, `${label} gesture lamp`, 'restricted');
  await grant(owner, place.id, writer, 'contributor'); await grant(owner, place.id, viewer, 'viewer');
  fixture.authorize(owner); fixture.authorize(writer);
  const task = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Keep a manual off switch', criteria } }), 201) as WorkItem;
  const binding = await github.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: REPO });
  return { owner, writer, viewer, outsider, place, task, binding };
}

describe('linked PRs move the same Flux task (#74 G-1a)', () => {
  test('open, draft, failed check, re-run, merge: one rule moves the task from current facts, idempotently, with sourced history', async () => {
    const { owner, viewer, outsider, task, binding } = await setup('Flow');
    // Another project's lost repository must not make this rule look paused.
    const unrelated = await setup('Unrelated'); await github.disconnect(actor(unrelated.owner), unrelated.binding.id);
    fixture.set(REPO, 42, { draft: true, checks: [check('pending')] });
    await github.link(actor(owner), task.id, { bindingId: binding.id, number: 42, role: 'required_output' });
    assert.equal((await work(owner, task)).githubRule, null, 'nothing moves a task before someone turns its rule on');
    const view = await enable(owner, task);
    assert.deepEqual([view.rule?.state, view.rule?.mode, view.rule?.setUpBy?.id, view.changes.length], ['active', 'complete', owner.id, 0]);
    const scheduled = await pool.query(`SELECT gd.origin FROM github_processing gp JOIN github_deliveries gd ON gd.id=gp.delivery_id WHERE gp.binding_id=$1 AND gp.state='pending'`, [binding.id]);
    assert.deepEqual(scheduled.rows.map((row) => row.origin), ['reconcile'], 'turning it on schedules one local reconciliation');

    await settle(binding);
    let current = await work(viewer, task);
    assert.deepEqual([current.status, current.githubRule?.state, current.githubRule?.setUpBy?.name], ['in_progress', 'active', 'Flow Ada'], 'a draft PR starts open work');
    let history = await changes(viewer, task);
    assert.deepEqual([history[0]!.code, history[0]!.from, history[0]!.to, history[0]!.pullNumber, history[0]!.headSha, history[0]!.cause.origin],
      ['pull_open', 'open', 'in_progress', 42, SHA1, 'reconcile']);

    // The author learns of what the rule did on their behalf, shown as the rule's doing, not as their own.
    const mark = (await expectStatus(await owner.browser.request('GET', `/api/v1/return?place=project&id=${current.projectId}`), 200) as ReturnSummary).mark;
    expectStatus(await owner.browser.request('PUT', '/api/v1/return-points', { body: { place: { type: 'project', id: current.projectId }, mark } }), 200);
    fixture.set(REPO, 42, { draft: false, checks: [check('success', 'lint'), check('failure')] });
    const failed = randomUUID();
    assert.equal((await webhook('check_run', checkEvent(REPO, 42), failed)).statusCode, 202);
    await settle(binding);
    current = await work(viewer, task);
    assert.deepEqual([current.status, current.blocker], ['blocked', 'Check “firmware / test” failed on PR #42']);
    history = await changes(viewer, task);
    assert.deepEqual([history[0]!.code, history[0]!.checkName, history[0]!.cause], ['check_failed', 'firmware / test', { origin: 'webhook', deliveryId: failed }]);
    const back = expectStatus(await owner.browser.request('GET', `/api/v1/return?place=project&id=${current.projectId}`), 200) as ReturnSummary;
    assert.ok(back.items.some((item) => item.kind === 'work' && item.text === 'Blocked: Keep a manual off switch' && item.actor === 'GitHub rule'),
      `the author sees the CI-caused block: ${JSON.stringify(back.items.map((item) => [item.kind, item.text, item.actor]))}`);
    assert.equal((await webhook('check_run', checkEvent(REPO, 42), failed)).statusCode, 202, 'the same delivery again is a no-op');
    await webhook('check_run', checkEvent(REPO, 42)); await webhook('pull_request', pullEvent('synchronize', REPO, 42)); await settle(binding);
    assert.equal((await work(viewer, task)).version, current.version, 'redeliveries of the same facts change nothing');
    assert.equal((await changes(viewer, task)).length, 2);

    fixture.set(REPO, 42, { checks: [check('success', 'lint'), check('pending')] });
    await webhook('check_run', checkEvent(REPO, 42)); await settle(binding);
    assert.equal((await work(viewer, task)).status, 'blocked', 'a re-run in progress keeps it blocked');
    fixture.set(REPO, 42, { checks: [check('success', 'lint'), check('success')] });
    await webhook('check_run', checkEvent(REPO, 42)); await settle(binding);
    current = await work(viewer, task);
    assert.deepEqual([current.status, current.blocker, (await changes(viewer, task))[0]!.code], ['in_progress', null, 'checks_passed']);

    fixture.set(REPO, 42, { state: 'closed', merged: true });
    const lateOpen = randomUUID();
    await webhook('pull_request', pullEvent('closed', REPO, 42)); await settle(binding);
    current = await work(viewer, task);
    assert.deepEqual([current.status, current.githubRule?.readyToClose], ['done', false], 'complete mode without written criteria: merged is done');
    await webhook('pull_request', pullEvent('reopened', REPO, 42), lateOpen); await settle(binding);
    assert.equal((await work(viewer, task)).version, current.version, 'a late event re-reads the merged PR and leaves done work alone');
    history = await changes(viewer, task);
    assert.deepEqual(history.map((change) => change.code), ['merged_done', 'checks_passed', 'check_failed', 'pull_open']);
    assert.ok(history.every((change) => change.setUpBy?.name === 'Flow Ada'));

    // Readers see the rule and its changes as part of the task; outsiders and viewers cannot change it.
    const text = JSON.stringify([await work(viewer, task), await call(viewer, 'GET', rulePath(task))]);
    assert.equal(text.includes('PRIVATE'), false, 'no PR title or repository name reaches the task audience');
    assert.equal(text.includes('lamp-team'), false);
    assert.equal((await call(viewer, 'PUT', rulePath(task), { enabled: false, expectedVersion: current.version })).status, 403);
    assert.equal((await call(outsider, 'GET', rulePath(task))).status, 404);
    assert.equal((await call(outsider, 'PUT', rulePath(task), { enabled: false, expectedVersion: current.version })).status, 404);
    const events = await pool.query(`SELECT actor_id,data FROM events WHERE kind='project.work_updated.v1' AND data->>'workId'=$1 ORDER BY seq`, [task.id]);
    assert.ok(events.rows.every((row) => Object.keys(row.data).every((key) => key === 'workId' || key === 'automation')), 'events carry identifiers only');
    const automated = events.rows.filter((row) => row.data.automation === 'github_rule');
    assert.equal(automated.length, 4, 'every rule-caused change is marked as automation');
    assert.ok(automated.every((row) => row.actor_id === `human:${owner.id}`), 'on behalf of the person who set it up');
    assert.equal(events.rows[0].data.automation, undefined, 'turning the rule on is the person\'s own action');
  });

  test('Ready to close, two required PRs across repositories, closed unmerged and related-only links', async () => {
    const { owner, writer, viewer, place, task, binding } = await setup('Ready', ['Gesture works at 5 lux']);
    const second = await github.bind(actor(owner), place.id, { installationId: INSTALL, repositoryId: REPO2 });
    fixture.set(REPO, 50, {}); fixture.set(REPO2, 51, {}); fixture.set(REPO, 99, { state: 'closed' });
    await github.link(actor(writer), task.id, { bindingId: binding.id, number: 50, role: 'required_output' });
    await github.link(actor(writer), task.id, { bindingId: second.id, number: 51, role: 'required_output' });
    await github.link(actor(writer), task.id, { bindingId: binding.id, number: 99, role: 'related' });
    const view = await enable(writer, task);
    assert.equal(view.rule?.mode, 'ready', 'written criteria make Ready to close the default');
    await settle(binding, second);
    assert.equal((await work(viewer, task)).status, 'in_progress', 'a closed related PR never blocks');

    fixture.set(REPO, 50, { state: 'closed', merged: true });
    await webhook('pull_request', pullEvent('closed', REPO, 50)); await settle(binding);
    let current = await work(viewer, task);
    assert.deepEqual([current.status, current.githubRule?.readyToClose], ['in_progress', false], 'one merged of two required PRs');

    fixture.set(REPO2, 51, { state: 'closed' });
    await webhook('pull_request', pullEvent('closed', REPO2, 51)); await settle(second);
    current = await work(viewer, task);
    assert.deepEqual([current.status, current.blocker], ['blocked', 'PR #51 closed without merge'], 'closed without merge is never completion');
    fixture.set(REPO2, 51, { state: 'open', headSha: SHA2, checks: [check('pending')] });
    await webhook('pull_request', pullEvent('reopened', REPO2, 51, SHA2)); await settle(second);
    assert.deepEqual([(await work(viewer, task)).status, (await changes(viewer, task))[0]!.code], ['in_progress', 'pull_reopened']);

    fixture.set(REPO2, 51, { state: 'closed', merged: true });
    await webhook('pull_request', pullEvent('closed', REPO2, 51, SHA2)); await settle(second);
    current = await work(viewer, task);
    assert.deepEqual([current.status, current.githubRule?.readyToClose, (await changes(viewer, task))[0]!.code], ['in_progress', true, 'merged_ready'],
      'merged with written criteria waits for a person');
    const finished = await patch(owner, current, { status: 'done' });
    assert.deepEqual([finished.status, finished.githubRule?.readyToClose, finished.githubRule?.state], ['done', false, 'active'], 'one ordinary tap on Done finishes it');
    await webhook('pull_request', pullEvent('closed', REPO2, 51, SHA2)); await settle(second);
    assert.equal((await work(viewer, task)).version, finished.version, 'the rule never touches done work');

    // Changing the mode is a writer's explicit choice and re-records them as its author.
    const other = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Ship the calibration fix' } }), 201) as WorkItem;
    await github.link(actor(owner), other.id, { bindingId: binding.id, number: 99, role: 'related' });
    const related = await call(owner, 'PUT', rulePath(other), { enabled: true, expectedVersion: other.version });
    assert.deepEqual([related.status, related.json.code], [422, 'GITHUB_RULE_NEEDS_REQUIRED_PR'], 'related links alone cannot drive a task');
  });

  test('a manual change suspends the rule until resumed; resuming re-records authority; access loss and reconnect suspend it', async () => {
    const { owner, writer, task, binding } = await setup('Override');
    fixture.set(REPO, 60, {});
    await github.link(actor(owner), task.id, { bindingId: binding.id, number: 60, role: 'required_output' });
    await enable(writer, task); await settle(binding);
    let current = await work(owner, task);
    assert.equal(current.status, 'in_progress');

    current = await patch(owner, current, { status: 'blocked', blocker: 'Waiting for the enclosure' });
    assert.deepEqual([current.githubRule?.state, current.githubRule?.suspendedReason], ['suspended', 'manual_change'], 'readers see it paused at once');
    fixture.set(REPO, 60, { checks: [check('failure')] });
    await webhook('check_run', checkEvent(REPO, 60)); await settle(binding);
    let after = await work(owner, task);
    assert.deepEqual([after.status, after.blocker, after.version], ['blocked', 'Waiting for the enclosure', current.version], 'the manual change wins');
    assert.equal((await changes(owner, task))[0]!.code, 'suspended_manual');
    const stale = await call(owner, 'POST', `${rulePath(task)}/resume`, { expectedVersion: current.version - 1 });
    assert.deepEqual([stale.status, stale.json.code], [409, 'VERSION_CONFLICT']);

    let resumed = (await call(owner, 'POST', `${rulePath(task)}/resume`, { expectedVersion: current.version })).json as GithubTaskRuleView;
    assert.deepEqual([resumed.rule?.state, resumed.rule?.setUpBy?.id], ['active', owner.id], 'the person resuming becomes its author');
    fixture.set(REPO, 60, { checks: [check('success')] });
    await webhook('check_run', checkEvent(REPO, 60)); await settle(binding);
    after = await work(owner, task);
    assert.deepEqual([after.status, after.blocker], ['blocked', 'Waiting for the enclosure'], 'it never clears a blocker a person wrote');

    after = await patch(owner, after, { status: 'in_progress' });
    resumed = (await call(writer, 'POST', `${rulePath(task)}/resume`, { expectedVersion: after.version })).json as GithubTaskRuleView;
    assert.equal(resumed.rule?.setUpBy?.id, writer.id);
    // The binding is Ada's; the rule is Kai's. Kai losing write access suspends only the rule.
    await grant(owner, (await work(owner, task)).projectId, writer, 'viewer');
    fixture.set(REPO, 60, { checks: [check('failure')] });
    await webhook('check_run', checkEvent(REPO, 60)); await settle(binding);
    after = await work(owner, task);
    assert.deepEqual([after.status, after.githubRule?.state, after.githubRule?.suspendedReason], ['in_progress', 'suspended', 'author_access']);
    assert.equal((await changes(owner, task))[0]!.code, 'suspended_access');

    await grant(owner, after.projectId, writer, 'contributor');
    await call(writer, 'POST', `${rulePath(task)}/resume`, { expectedVersion: after.version });
    fixture.allowed.get(writer.id)!.delete(REPO);
    await webhook('check_run', checkEvent(REPO, 60)); await settle(binding);
    after = await work(owner, task);
    assert.deepEqual([after.status, after.githubRule?.suspendedReason], ['in_progress', 'author_access'], 'losing GitHub access to the repository stops it');
    fixture.allowed.get(writer.id)!.add(REPO);
    const denied = await call(writer, 'POST', `${rulePath(task)}/resume`, { expectedVersion: after.version });
    assert.equal(denied.status, 200, 'access back: a person resumes it explicitly');
    fixture.generations.set(writer.id, randomUUID());
    await webhook('check_run', checkEvent(REPO, 60)); await settle(binding);
    after = await work(owner, task);
    assert.deepEqual([after.status, after.githubRule?.suspendedReason], ['in_progress', 'author_access'], 'a reconnected GitHub authorization never inherits the rule');

    const noGithub = await person('Override Lena'); await addMember(owner, after.workspaceId, noGithub, 'member'); await grant(owner, after.projectId, noGithub, 'contributor');
    const refused = await call(noGithub, 'PUT', rulePath(task), { enabled: true, expectedVersion: after.version });
    assert.deepEqual([refused.status, refused.json.code], [404, 'GITHUB_ACCESS_UNAVAILABLE'], 'turning it on needs the person\'s own GitHub access');
    const off = (await call(noGithub, 'PUT', rulePath(task), { enabled: false, expectedVersion: after.version })).json as GithubTaskRuleView;
    assert.equal(off.rule?.state, 'off', 'any writer can turn it off without GitHub');
  });

  test('a manual override suspends the rule in its own transaction; the rule revision is its optional compare-and-set', async () => {
    const { owner, writer, task, binding } = await setup('Cas');
    fixture.set(REPO, 70, {});
    await github.link(actor(owner), task.id, { bindingId: binding.id, number: 70, role: 'required_output' });
    const first = await enable(writer, task); await settle(binding);
    assert.equal(first.rule?.revision, 1, 'turning it on is revision 1');
    let current = await work(owner, task);
    assert.deepEqual([current.status, current.githubRule?.revision], ['in_progress', 2], 'an automatic task change is a new revision');

    // Someone else turns it off and on again: the rule moves on while this person still holds revision 2.
    const off = await call(writer, 'PUT', rulePath(task), { enabled: false, expectedVersion: current.version, expectedRuleRevision: 2 });
    assert.deepEqual([off.status, off.json.rule.state, off.json.rule.revision], [200, 'off', 3]);
    const stale = await call(owner, 'PUT', rulePath(task), { enabled: true, expectedVersion: current.version, expectedRuleRevision: 2 });
    assert.deepEqual([stale.status, stale.json.code], [409, 'VERSION_CONFLICT'], 'a rule changed since the person saw it conflicts');
    const again = await call(owner, 'PUT', rulePath(task), { enabled: true, expectedVersion: current.version, expectedRuleRevision: 3 });
    assert.deepEqual([again.status, again.json.rule.state, again.json.rule.revision], [200, 'active', 4]);

    // A status change pinned to a stale rule revision is refused without mutation; the current one overrides.
    current = await work(owner, task);
    const refused = await owner.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { status: 'blocked', blocker: 'Supplier', expectedVersion: current.version, expectedGithubRuleRevision: 3 } });
    assert.equal(refused.status, 409, 'the rule changed after the person saw it');
    const unchanged = await work(owner, task);
    assert.deepEqual([unchanged.status, unchanged.version, unchanged.githubRule?.state], [current.status, current.version, 'active']);
    const rev = current.githubRule!.revision;
    current = expectStatus(await owner.browser.request('PATCH', `/api/v1/work/${task.id}`,
      { body: { status: 'blocked', blocker: 'Supplier', expectedVersion: current.version, expectedGithubRuleRevision: rev } }), 200) as WorkItem;
    assert.deepEqual([current.githubRule?.state, current.githubRule?.suspendedReason, current.githubRule?.revision], ['suspended', 'manual_change', rev + 1]);
    const stored = await pool.query('SELECT state, suspended_reason, revision FROM github_task_rules WHERE task_id=$1', [task.id]);
    assert.deepEqual(stored.rows[0], { state: 'suspended', suspended_reason: 'manual_change', revision: rev + 1 }, 'persisted in the same transaction, before any delivery');
    assert.equal((await changes(owner, task))[0]!.code, 'suspended_manual');

    // Title edits are not overrides; a same-value status correction is. Without a precondition it is an explicit override.
    await call(owner, 'POST', `${rulePath(task)}/resume`, { expectedVersion: current.version, expectedRuleRevision: rev + 1 });
    current = await work(owner, task);
    current = await patch(owner, current, { title: 'Keep a manual off switch, renamed' });
    assert.equal(current.githubRule?.state, 'active', 'other edits keep it');
    current = await patch(owner, current, { status: current.status });
    assert.deepEqual([current.githubRule?.state, current.githubRule?.suspendedReason], ['suspended', 'manual_change']);
    const negative = await owner.browser.request('PATCH', `/api/v1/work/${task.id}`, { body: { status: 'open', expectedVersion: current.version, expectedGithubRuleRevision: -1 } });
    assert.equal(negative.status, 400);
  });

  test('a native command retry is exact only with the same rule pin: a changed, added or removed pin is an idempotency conflict', async () => {
    const { owner, writer, task, binding } = await setup('Idem');
    fixture.set(REPO, 80, {});
    await github.link(actor(owner), task.id, { bindingId: binding.id, number: 80, role: 'required_output' });
    await enable(writer, task); await settle(binding);
    const current = await work(owner, task); const rev = current.githubRule!.revision;
    const commandId = randomUUID();
    const send = (body: Record<string, unknown>) => owner.browser.request('PATCH', `/api/v1/work/${task.id}`, { body });
    const state = async () => {
      const one = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0];
      return { rule: await one('SELECT state, revision FROM github_task_rules WHERE task_id=$1', [task.id]),
        task: await one('SELECT version, status FROM project_work_items WHERE id=$1', [task.id]),
        history: (await one('SELECT count(*)::int AS n FROM github_task_rule_changes WHERE task_id=$1', [task.id])).n,
        receipts: (await one('SELECT count(*)::int AS n FROM native_command_receipts WHERE work_id=$1', [task.id])).n,
        messages: (await one('SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1', [current.projectId])).n,
        blockers: (await one("SELECT count(*)::int AS n FROM project_messages WHERE project_id=$1 AND contribution_kind='blocker'", [current.projectId])).n };
    };
    const conflict = async (label: string, body: Record<string, unknown>) => {
      const before = await state(); const response = await send(body);
      assert.deepEqual([response.status, (response.json as { code?: string }).code], [409, 'IDEMPOTENCY_CONFLICT'], label);
      assert.deepEqual(await state(), before, `${label}: nothing changed`);
    };
    const same = { status: 'blocked', blocker: 'Supplier', expectedVersion: current.version, expectedGithubRuleRevision: rev, clientCommandId: commandId };
    const beforeOverride = await state();
    expectStatus(await send(same), 200);
    const done = await state();
    assert.deepEqual([done.rule.state, done.rule.revision, done.receipts, done.history],
      ['suspended', rev + 1, beforeOverride.receipts + 1, beforeOverride.history + 1]);
    assert.equal(done.blockers, beforeOverride.blockers + 1, 'the first override appends exactly one blocker contribution');
    expectStatus(await send(same), 200);
    assert.deepEqual(await state(), done, 'an exact replay returns the original result and changes nothing');
    await conflict('changed pin', { ...same, expectedGithubRuleRevision: rev + 100 });
    const removed: Record<string, unknown> = { ...same }; delete removed.expectedGithubRuleRevision;
    await conflict('removed pin', removed);
    // An unpinned command, then the same UUID with a pin added.
    const second = randomUUID(); const latest = await work(owner, task);
    const unpinned = { status: 'in_progress', expectedVersion: latest.version, clientCommandId: second };
    expectStatus(await send(unpinned), 200);
    await conflict('added pin', { ...unpinned, expectedGithubRuleRevision: 0 });
    const stale = await send({ status: 'open', expectedVersion: (await work(owner, task)).version, expectedGithubRuleRevision: rev + 100, clientCommandId: randomUUID() });
    assert.deepEqual([stale.status, (stale.json as { code?: string }).code], [409, 'VERSION_CONFLICT'], 'a fresh command with a stale pin is still a version conflict');
  });

  test('a manager\'s project default turns the rule on for new required links, as the person linking', async () => {
    const { owner, writer, viewer, place, binding } = await setup('Default');
    const path = `/api/v1/projects/${place.id}/github/rule-default`;
    assert.equal((await call(writer, 'PUT', path, { enabled: true })).status, 403, 'only a project manager sets the default');
    assert.equal((await call(owner, 'PUT', path, { enabled: true, mode: 'ready' })).status, 200);
    const capabilities = (await call(viewer, 'GET', `/api/v1/projects/${place.id}/github/capabilities`)).json as GithubCapabilities;
    assert.deepEqual([capabilities.taskAutomation, capabilities.ruleDefault?.mode, capabilities.ruleDefault?.setBy?.id], ['available', 'ready', owner.id]);
    const task = expectStatus(await writer.browser.request('POST', `/api/v1/projects/${place.id}/work`, { body: { title: 'Dim at night' } }), 201) as WorkItem;
    fixture.set(REPO, 70, {}); fixture.set(REPO, 71, {});
    await github.link(actor(writer), task.id, { bindingId: binding.id, number: 71, role: 'related' });
    assert.equal((await work(viewer, task)).githubRule, null, 'a related link does not take the default');
    const link = await github.link(actor(writer), task.id, { bindingId: binding.id, number: 70, role: 'required_output' }) as GithubTaskLink;
    const current = await work(viewer, task);
    assert.deepEqual([current.githubRule?.state, current.githubRule?.mode, current.githubRule?.setUpBy?.id], ['active', 'ready', writer.id]);
    await settle(binding);
    const moved = await work(viewer, task);
    assert.equal(moved.status, 'in_progress');
    assert.equal((await changes(viewer, task))[0]!.linkId, link.id);
    assert.equal((await call(owner, 'PUT', path, { enabled: false })).status, 200);
    assert.equal(((await call(owner, 'GET', `/api/v1/projects/${place.id}/github/capabilities`)).json as GithubCapabilities).ruleDefault, null);
  });

  // Runs last: uninstalling the App revokes every binding of this test App's installation.
  test('losing a repository or authorization pauses the rule truthfully; re-binding never restarts it without Resume', async () => {
    const running = async (label: string, number: number, author: 'owner' | 'writer' = 'owner', repositoryId = REPO) => {
      const scene = await setup(label);
      const binding = repositoryId === REPO ? scene.binding : await github.bind(actor(scene.owner), scene.place.id, { installationId: INSTALL, repositoryId });
      fixture.set(repositoryId, number, {});
      await github.link(actor(scene.owner), scene.task.id, { bindingId: binding.id, number, role: 'required_output' });
      await enable(scene[author], scene.task); await settle(binding);
      assert.equal((await work(scene.viewer, scene.task)).status, 'in_progress');
      return { ...scene, binding };
    };
    const paused = async (scene: { viewer: Person; task: WorkItem }, reason: string, cause: GithubTaskRuleView['changes'][number]['cause']['origin']) => {
      const current = await work(scene.viewer, scene.task);
      assert.deepEqual([current.status, current.githubRule?.state, current.githubRule?.suspendedReason], ['in_progress', 'suspended', reason]);
      const [latest] = await changes(scene.viewer, scene.task);
      assert.deepEqual([latest!.code, latest!.cause.origin, latest!.from, latest!.to], [reason === 'author_access' ? 'suspended_access' : 'suspended_repository', cause, 'in_progress', 'in_progress']);
      const row = (await pool.query('SELECT state,suspended_reason FROM github_task_rules WHERE task_id=$1', [scene.task.id])).rows[0];
      assert.deepEqual(row, { state: 'suspended', suspended_reason: reason }, 'persisted, not only presented');
      return current;
    };

    // A manager's disconnect, then re-binding the same repository: no autorun until a person resumes.
    const disconnected = await running('Unbound', 80);
    await github.disconnect(actor(disconnected.owner), disconnected.binding.id);
    let current = await paused(disconnected, 'repository_unavailable', 'binding');
    assert.equal((await github.bind(actor(disconnected.owner), disconnected.place.id, { installationId: INSTALL, repositoryId: REPO })).id, disconnected.binding.id);
    fixture.set(REPO, 80, { checks: [check('failure')] });
    await webhook('check_run', checkEvent(REPO, 80)); await settle(disconnected.binding);
    assert.deepEqual([(await work(disconnected.viewer, disconnected.task)).status, (await work(disconnected.viewer, disconnected.task)).githubRule?.state], ['in_progress', 'suspended']);
    assert.equal((await call(disconnected.owner, 'POST', `${rulePath(disconnected.task)}/resume`, { expectedVersion: current.version })).status, 200);
    await settle(disconnected.binding);
    current = await work(disconnected.viewer, disconnected.task);
    assert.deepEqual([current.status, current.blocker], ['blocked', 'Check “firmware / test” failed on PR #80'], 'resumed: it acts on current facts');
    // Out of order on unfinished work: a late failure event after the checks passed re-reads current facts.
    fixture.set(REPO, 80, { checks: [check('success')] });
    const late = JSON.stringify(checkEvent(REPO, 80));
    await webhook('check_run', checkEvent(REPO, 80)); await settle(disconnected.binding);
    assert.equal((await work(disconnected.viewer, disconnected.task)).status, 'in_progress');
    await webhook('check_run', JSON.parse(late)); await settle(disconnected.binding);
    assert.equal((await work(disconnected.viewer, disconnected.task)).status, 'in_progress', 'a late failure event cannot restore an old block');

    // An explicit authorization revoke: the binding author's revokes their bindings, the rule author's their rules.
    const credentials = githubCredentials(db, config, githubTransport());
    const byWriter = await running('Revoked author', 81, 'writer');
    await credentials.revoke(byWriter.writer.id);
    await paused(byWriter, 'author_access', 'binding');
    const byOwner = await running('Revoked binding', 82, 'writer');
    await credentials.revoke(byOwner.owner.id);
    await paused(byOwner, 'repository_unavailable', 'binding');

    // A signed authorization revocation, and a repository removed from the installation.
    const signed = await running('Signed revocation', 83);
    const revoked = randomUUID();
    assert.equal((await webhook('github_app_authorization', { action: 'revoked', sender: { id: Number(fixture.githubIds.get(signed.owner.id)) } }, revoked)).statusCode, 202);
    await paused(signed, 'repository_unavailable', 'webhook');
    assert.equal((await changes(signed.viewer, signed.task))[0]!.cause.deliveryId, revoked);
    const removed = await running('Removed repository', 84, 'owner', REPO2);
    assert.equal((await webhook('installation_repositories', { action: 'removed', installation: { id: Number(INSTALL), app_id: Number(APP) },
      repositories_removed: [{ id: Number(REPO2) }] })).statusCode, 202);
    await paused(removed, 'repository_unavailable', 'webhook');

    // The App uninstalled: paused, and a manager re-binding afterwards starts nothing.
    const uninstalled = await running('Uninstalled', 85);
    assert.equal((await webhook('installation', { action: 'deleted', installation: { id: Number(INSTALL), app_id: Number(APP) } })).statusCode, 202);
    current = await paused(uninstalled, 'repository_unavailable', 'webhook');
    await github.bind(actor(uninstalled.owner), uninstalled.place.id, { installationId: INSTALL, repositoryId: REPO });
    fixture.set(REPO, 85, { checks: [check('failure')] });
    await webhook('check_run', checkEvent(REPO, 85)); await settle(uninstalled.binding);
    const after = await work(uninstalled.viewer, uninstalled.task);
    assert.deepEqual([after.status, after.version, after.githubRule?.state], ['in_progress', current.version, 'suspended'], 'no autorun after re-binding');
  });
});
