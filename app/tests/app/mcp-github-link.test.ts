import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { assistantChangeActionPath, type Agent, type GithubPullFacts, type GithubTaskLink, type WorkItem } from '@flux/contracts';
import { NotFoundError, parseGithubPullUrl, type GithubProvider, type Principal } from '@flux/core';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { createGithubUseCases } from '../../apps/server/src/github/adapters.js';
import { db, pool } from './support/db.js';
import { Browser } from './support/http.js';
import { agentConnection, toolFailure } from './support/mcp-actions.js';
import { mcp, toolValue } from './support/mcp.js';
import { expectStatus, grant, person, project, removeFromSpace, workspace, addMember, type Person } from './support/people.js';

// #160 AC-3: an agent links the pull request it produced to the task it holds (`flux_link_pull_request`). Real sessions, OAuth
// bearers and MCP over HTTP, against a second in-process API on the same database whose GitHub App provider is a fixture; so no
// real GitHub installation is claimed. The default API of the stack has no GitHub App, which the last test uses.
const APP = '24680', INSTALL = '556';
const REPO = String(randomInt(100_000, 500_000)), OTHER_REPO = String(randomInt(500_001, 900_000)), UNBOUND_REPO = String(randomInt(900_001, 999_999));
const SHA = (c: string) => c.repeat(40);
const url = (repo: string, number: number, owner = 'fixture') => `https://github.com/${owner}/repo-${repo}/pull/${number}`;

/** Records who GitHub was asked as: it must always be the agent's owner, a person, never the agent. */
class Provider implements GithubProvider {
  allowed = new Set<string>(); calls: { call: string; as: string; kind: string }[] = []; generation = randomUUID();
  /** Pull numbers that GitHub answers as belonging to another repository, or does not know. */
  foreign = new Set<number>(); missing = new Set<number>();
  async repository(principal: Principal, installationId: string, repositoryId: string) {
    this.calls.push({ call: 'repository', as: principal.id, kind: principal.kind });
    if (principal.kind !== 'human' || !this.allowed.has(principal.id) || installationId !== INSTALL) throw new NotFoundError('Repository', 'GITHUB_ACCESS_UNAVAILABLE');
    return { host: 'github.com' as const, installationId, repositoryId, owner: 'fixture', name: `repo-${repositoryId}`, private: false,
      url: `https://github.com/fixture/repo-${repositoryId}`, githubUserId: `9${principal.id.length}`, appId: APP, authorizationGeneration: this.generation };
  }
  async pull(principal: Principal, repository: { repositoryId: string }, number: number): Promise<GithubPullFacts> {
    this.calls.push({ call: 'pull', as: principal.id, kind: principal.kind });
    if (principal.kind !== 'human' || !this.allowed.has(principal.id) || this.missing.has(number)) throw new NotFoundError('Pull request', 'GITHUB_PULL_NOT_FOUND');
    const repositoryId = this.foreign.has(number) ? UNBOUND_REPO : repository.repositoryId;
    return { repositoryId, pullId: `${repositoryId}${number}`, number, title: 'A title that only a person may read', url: `https://github.com/fixture/repo-${repositoryId}/pull/${number}`,
      author: { id: '765', login: 'someone' }, headSha: SHA('a'), state: 'open', draft: false, merged: false, sourceCreatedAt: '2026-10-29T10:00:00.000Z',
      sourceUpdatedAt: '2026-10-30T10:00:00.000Z', sourceMergedAt: null, checks: [], reviews: [], truncated: false, execution: 'ready_for_review' };
  }
}
const provider = new Provider();
const github = createGithubUseCases(db, provider);
let base = '';
let closeApp: () => Promise<void> = async () => undefined;

before(async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, FLUX_AUTH_SECRET: process.env.FLUX_AUTH_SECRET ?? `mcp-github-link-${'x'.repeat(40)}`,
    FLUX_PUBLIC_ORIGIN: process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:8080' };
  const app = await buildApp(loadServerConfig(env, '/nonexistent/flux_background_key'), 'packages/db/migrations', { githubProvider: provider });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  closeApp = () => app.close();
});
after(async () => { await closeApp(); });

async function scene() {
  const hubert = await person('mcp-pr-hubert'), marek = await person('mcp-pr-marek');
  provider.allowed.add(hubert.id); provider.allowed.add(marek.id);
  const ws = await workspace(hubert, 'MCP PR link');
  await addMember(hubert, ws.id, marek, 'admin');
  const p = await project(hubert, ws.id, 'Printer firmware', 'restricted');
  // An admin's agents work only in the spaces the admin was added to (C-15, #934).
  await grant(hubert, p.id, marek, 'contributor');
  const elsewhere = await project(hubert, ws.id, 'Another project', 'restricted');
  const principal: Principal = { kind: 'human', id: hubert.id };
  const bound = await github.bind(principal, p.id, { installationId: INSTALL, repositoryId: REPO });
  const otherBinding = await github.bind(principal, elsewhere.id, { installationId: INSTALL, repositoryId: OTHER_REPO });
  /** One OAuth-connected agent of `who` with contributor rights on the project. */
  const makeAgent = async (who: Person, name: string) => {
    const agent = expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name, owner: 'self' } }), 201) as Agent;
    return { agent, connected: await agentConnection(pool, who.browser, agent.id, [p.id]) };
  };
  const mine = await makeAgent(hubert, 'Hubert Codex');
  /** A task; `holder` is the agent it is assigned to, in progress. A task is given to your own agent (#904), so its owner (`by`) gives it. */
  const task = async (title: string, holder?: Agent, by: Person = hubert) => {
    let item = expectStatus(await by.browser.request('POST', `/api/v1/projects/${p.id}/work`, { body: { title } }), 201) as WorkItem;
    if (holder) item = expectStatus(await by.browser.request('PATCH', `/api/v1/work/${item.id}`, { body: { owner: { kind: 'agent', id: holder.id }, status: 'in_progress' },
      headers: { 'if-match': `"${item.version}"` } }), 200) as WorkItem;
    return item;
  };
  let call = 1000;
  /** The tool over HTTP at the second API, which has the fixture provider. */
  const link = async (who: typeof mine, workId: string, pullRequestUrl: string, extra: Record<string, unknown> = {}) => {
    const response = await mcp(who.connected.accessToken, call++, 'tools/call', { name: 'flux_link_pull_request', arguments: {
      projectId: p.id, runtimeSessionId: who.connected.runtimeSessionId, clientCommandId: randomUUID(),
      workId, pullRequestUrl, ...extra } }, { base });
    assert.equal(response.status, 200, `MCP flux_link_pull_request returned ${response.status}`);
    return response.message;
  };
  /** The task's links as its owner reads them: through the same use case and the fixture provider (the stack's own API has no GitHub App). */
  const links = async (taskId: string): Promise<GithubTaskLink[]> => github.links(principal, taskId);
  const linkRows = async (taskId: string) => Number((await pool.query('SELECT count(*) AS n FROM github_task_links WHERE task_id=$1', [taskId])).rows[0].n);
  return { hubert, marek, ws, p, elsewhere, principal, bound, otherBinding, mine, makeAgent, task, link, links, linkRows };
}

describe('flux_link_pull_request (#160 AC-3)', () => {
  test('an agent that holds the task links its pull request with its owner\'s GitHub authorization, once', async () => {
    const s = await scene();
    const item = await s.task('Fix the thermal runaway check', s.mine.agent);
    provider.calls = [];
    const first = toolValue(await s.link(s.mine, item.id, url(REPO, 42)));
    assert.equal(first.workId, item.id); assert.equal(first.bindingId, s.bound.id); assert.equal(first.role, 'required_output');
    assert.equal(first.number, 42); assert.equal(first.url, url(REPO, 42)); assert.equal(first.headSha, SHA('a')); assert.equal(first.linkState, 'current');
    assert.equal(first.replayed, false);
    assert.equal(JSON.stringify(first).includes('only a person may read'), false, 'the agent receives references, not provider text');
    // The same link a person would have made: verified facts, once.
    const stored = await s.links(item.id);
    assert.deepEqual(stored.map((row) => [row.id, row.bindingId, row.role, row.state, row.facts.number, row.facts.repositoryId]), [[first.linkId, s.bound.id, 'required_output', 'current', 42, REPO]]);
    // GitHub was asked only as the owner, a person; the agent never has a GitHub identity, and nothing was written there.
    assert.ok(provider.calls.length >= 2 && provider.calls.every((row) => row.as === s.hubert.id && row.kind === 'human'), JSON.stringify(provider.calls));
    assert.deepEqual([...new Set(provider.calls.map((row) => row.call))].sort(), ['pull', 'repository']);
    // A related pull request (any letter case, a trailing page of the URL) is its own link and never moves the task's rule.
    const related = toolValue(await s.link(s.mine, item.id, `${url(REPO, 43, 'Fixture').replace('repo-', 'REPO-')}/files#diff`, { role: 'related' }));
    assert.equal(related.role, 'related'); assert.equal(related.number, 43);
    assert.equal((await s.links(item.id)).length, 2);
    assert.equal((await pool.query('SELECT 1 FROM github_task_rules WHERE task_id=$1', [item.id])).rows.length, 0);
  });

  test('a retry returns the stored result, and the same pull request is never linked twice', async () => {
    const s = await scene();
    const item = await s.task('Replay the link', s.mine.agent);
    const commandId = randomUUID();
    const first = toolValue(await s.link(s.mine, item.id, url(REPO, 51), { clientCommandId: commandId }));
    const calls = provider.calls.length;
    const replay = toolValue(await s.link(s.mine, item.id, url(REPO, 51), { clientCommandId: commandId }));
    assert.equal(replay.replayed, true);
    assert.deepEqual({ ...replay, replayed: false }, first);
    assert.equal(provider.calls.length, calls, 'a replay asks GitHub nothing');
    // The same command ID for another pull request is a conflict, not a second link.
    assert.equal(toolFailure(await s.link(s.mine, item.id, url(REPO, 52), { clientCommandId: commandId })).code, 'IDEMPOTENCY_CONFLICT');
    // A new command for the same pull request finds the same link.
    const again = toolValue(await s.link(s.mine, item.id, url(REPO, 51)));
    assert.equal(again.linkId, first.linkId);
    assert.equal(await s.linkRows(item.id), 1);
  });


  test('only the agent that holds the task may link', async () => {
    const s = await scene();
    const other = await s.makeAgent(s.hubert, 'Hubert Claude');
    const code = async (workId: string) => toolFailure(await s.link(s.mine, workId, url(REPO, 71))).code;
    assert.equal(await code((await s.task('Nobody holds this')).id), 'TASK_NOT_HELD');
    assert.equal(await code((await s.task('Held by the other agent', other.agent)).id), 'TASK_NOT_HELD');
    const done = await s.task('Already finished', s.mine.agent);
    expectStatus(await s.hubert.browser.request('PATCH', `/api/v1/work/${done.id}`, { body: { status: 'done' }, headers: { 'if-match': `"${done.version}"` } }), 200);
    assert.equal(await code(done.id), 'TASK_NOT_HELD');
    const held = await s.task('Held by this agent', s.mine.agent);
    assert.equal(toolValue(await s.link(s.mine, held.id, url(REPO, 72))).number, 72);
    // A task of another project is not found, whoever holds it.
    const foreign = expectStatus(await s.hubert.browser.request('POST', `/api/v1/projects/${s.elsewhere.id}/work`, { body: { title: 'Elsewhere' } }), 201) as WorkItem;
    assert.ok(['OBJECT_NOT_FOUND', 'AGENT_EXECUTION_UNAVAILABLE'].includes(await code(foreign.id)));
    assert.equal(await s.linkRows(foreign.id), 0);
  });

  test('a repository no person connected to the project, or a pull request that is not in it, is refused', async () => {
    const s = await scene();
    const item = await s.task('Wrong repository', s.mine.agent);
    const failure = async (pullRequestUrl: string, extra: Record<string, unknown> = {}) => toolFailure(await s.link(s.mine, item.id, pullRequestUrl, extra)).code;
    const schemaError = async (extra: Record<string, unknown>) => {
      const message = await s.link(s.mine, item.id, url(REPO, 84), extra);
      const result = message?.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
      assert.equal(result?.isError, true); return result?.content?.[0]?.text ?? '';
    };
    provider.calls = [];
    assert.equal(await failure(url(UNBOUND_REPO, 81)), 'GITHUB_REPOSITORY_NOT_BOUND', 'a repository nobody connected');
    assert.equal(await failure(url(OTHER_REPO, 81)), 'GITHUB_REPOSITORY_NOT_BOUND', 'a repository connected to another project only');
    assert.equal(await failure(url(REPO, 81, 'someone-else')), 'GITHUB_REPOSITORY_NOT_BOUND', 'the same name under another owner');
    assert.deepEqual(provider.calls, [], 'GitHub is not asked about a repository the project has not connected');
    provider.missing.add(82); provider.foreign.add(83);
    assert.equal(await failure(url(REPO, 82)), 'GITHUB_PULL_NOT_FOUND', 'GitHub does not know the pull request');
    assert.equal(await failure(url(REPO, 83)), 'NOT_FOUND', 'the pull request belongs to another repository');
    for (const bad of ['not a url', 'http://github.com/fixture/repo-1/pull/4', 'https://evil.example/fixture/repo-1/pull/4', 'https://github.com/fixture/repo-1/issues/4',
      'https://github.com/fixture/repo-1/pull/0', 'https://user:pw@github.com/fixture/repo-1/pull/4', 'https://github.com:444/fixture/repo-1/pull/4'])
      assert.equal(await failure(bad), 'GITHUB_PULL_URL_INVALID', bad);
    assert.match(await schemaError({ role: 'blocker' }), /Input validation/, 'a relationship that does not exist is a schema error');
    assert.match(await schemaError({ sources: [] }), /Input validation/, 'the input is strict');
    // A person disconnects the repository: the agent can no longer link on it.
    await github.disconnect(s.principal, s.bound.id);
    assert.equal(await failure(url(REPO, 85)), 'GITHUB_REPOSITORY_NOT_BOUND');
    assert.equal(await s.linkRows(item.id), 0);
  });

  test('the owner\'s own GitHub authorization and write access are required, not the agent\'s alone', async () => {
    const s = await scene();
    const item = await s.task('Owner authorization', s.mine.agent);
    provider.allowed.delete(s.hubert.id);
    assert.equal(toolFailure(await s.link(s.mine, item.id, url(REPO, 91))).code, 'GITHUB_ACCESS_UNAVAILABLE', 'the owner has no GitHub access to the repository');
    provider.allowed.add(s.hubert.id);
    assert.equal(await s.linkRows(item.id), 0);
    // Marek owns a second agent and, as a workspace admin, may manage the project. Once he is only a
    // member who can read the project, his agent cannot link through his authority any more, whatever its own role.
    const theirs = await s.makeAgent(s.marek, 'Marek Claude');
    const marekItem = await s.task('Marek\'s task', theirs.agent, s.marek);
    assert.equal(toolValue(await s.link(theirs, marekItem.id, url(REPO, 92))).number, 92);
    expectStatus(await s.hubert.browser.request('PATCH', `/api/v1/workspaces/${s.ws.id}/members/${s.marek.id}`, { body: { role: 'member' } }), 200);
    await removeFromSpace(s.hubert, s.p.id, s.marek);
    // Demoted to a member and taken out of the space, Marek has lost it.
    // The agent has exactly its owner's rights, so the tool answers as for a space that is not there; the use case behind the tool
    // refuses on its own too, as a second fence, with no GitHub call and nothing stored.
    const refused = await mcp(theirs.connected.accessToken, 2000, 'tools/call', { name: 'flux_link_pull_request', arguments: { projectId: s.p.id,
      runtimeSessionId: theirs.connected.runtimeSessionId, clientCommandId: randomUUID(), peerRequestClass: 'execute',
      workId: marekItem.id, pullRequestUrl: url(REPO, 93) } }, { base });
    assert.equal(refused.status, 200);
    assert.equal((refused.message?.result as { isError?: boolean } | undefined)?.isError, true, 'the tool is refused');
    provider.calls = [];
    await assert.rejects(github.linkForAgent({ kind: 'agent', id: theirs.agent.id }, { kind: 'human', id: s.marek.id }, marekItem.id, { pullRequestUrl: url(REPO, 93) }),
      (error: { code?: string }) => ['FORBIDDEN', 'NOT_FOUND', 'PROJECT_NOT_FOUND'].includes(error.code ?? ''));
    assert.deepEqual(provider.calls, []);
    assert.deepEqual((await s.links(marekItem.id)).map((row) => row.facts.number), [92]);
  });

  test('the pull request URL parser accepts only github.com pull requests', () => {
    assert.deepEqual(parseGithubPullUrl('https://github.com/acme/firmware/pull/42'), { owner: 'acme', name: 'firmware', number: 42 });
    assert.deepEqual(parseGithubPullUrl('https://GitHub.com/Acme/fire.ware-2/pull/7/files?w=1#x'), { owner: 'Acme', name: 'fire.ware-2', number: 7 });
    for (const bad of [undefined, 42, '', 'github.com/acme/firmware/pull/42', 'https://github.com/acme/firmware/pull/042', 'https://github.com/acme/pull/42',
      'https://github.com/acme/firmware/pull/12345678901', 'https://gist.github.com/acme/firmware/pull/1'])
      assert.throws(() => parseGithubPullUrl(bad), /pull request as https:\/\/github.com/, String(bad));
  });

  test('an installation without a GitHub App says so, before any effect, and the tool is part of the work-change permission', async () => {
    const s = await scene();
    const item = await s.task('No GitHub App here', s.mine.agent);
    // The stack's own API has no GitHub App configured.
    const refused = toolFailure(await s.mine.connected.tool('flux_link_pull_request', { projectId: s.p.id, runtimeSessionId: s.mine.connected.runtimeSessionId,
      clientCommandId: randomUUID(), peerRequestClass: 'execute', workId: item.id, pullRequestUrl: url(REPO, 99) }));
    assert.equal(refused.code, 'GITHUB_UNAVAILABLE');
    assert.ok((await s.mine.connected.toolNames()).includes('flux_link_pull_request'));
    const listed = (s.mine.connected.bootstrap.capabilities as { name: string; operation: string | null; classes: string[] }[]).find((row) => row.name === 'flux_link_pull_request');
    assert.deepEqual([listed?.operation, listed?.classes], ['work.update', ['execute', 'plan']]);
  });

  test('#1419: under Ask me first the link waits for the owner\'s OK, and the owner\'s Approve links it once', async () => {
    const s = await scene();
    const item = await s.task('Link after the OK', s.mine.agent);
    expectStatus(await s.hubert.browser.request('PATCH', `/api/v1/agent-connections/${s.mine.connected.connectionId}`, { body: { mayDo: 'ask' } }), 200);
    const commandId = randomUUID();
    assert.match(JSON.stringify((await s.link(s.mine, item.id, url(REPO, 61), { clientCommandId: commandId }))?.result), /Waiting for .+'s OK/);
    assert.equal(await s.linkRows(item.id), 0, 'nothing is linked yet');
    const [row] = (await pool.query(`SELECT id, operation, object_title FROM assistant_changes WHERE connection_id = $1 AND state = 'waiting'`,
      [s.mine.connected.connectionId])).rows as { id: string; operation: string; object_title: string }[];
    assert.equal(row!.operation, 'work.update');
    assert.match(row!.object_title, new RegExp(`Link after the OK · pull request ${url(REPO, 61).replaceAll('.', '\\.')}$`));
    // The owner approves at the API that has the GitHub App (the stack's own has none), in their own signed-in session.
    const there = new Browser(base);
    for (const [name, value] of s.hubert.browser.cookies) there.cookies.set(name, value);
    expectStatus(await there.request('POST', assistantChangeActionPath(row!.id, 'apply'), { body: {} }), 200);
    assert.equal(await s.linkRows(item.id), 1);
    assert.equal(((await pool.query(`SELECT state FROM assistant_changes WHERE id = $1`, [row!.id])).rows[0] as { state: string }).state, 'applied_after_wait');
    assert.equal(toolValue(await s.link(s.mine, item.id, url(REPO, 61), { clientCommandId: commandId })).replayed, true, 'the client\'s retry finds it made');
    assert.equal(await s.linkRows(item.id), 1);
  });
});
