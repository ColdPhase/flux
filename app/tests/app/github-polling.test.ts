import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import type { GithubPullFacts, WorkItem } from '@flux/contracts';
import { NotFoundError, type GithubProvider, type Principal } from '@flux/core';
import { createGithubUseCases } from '../../apps/server/src/github/adapters.js';
import { githubTransport } from '../../apps/server/src/github/http.js';
import { expectStatus, person, project, workspace } from './support/people.js';

// G-1c (#479): conditional GETs and the poll window that reconciles bound repositories. The GitHub provider is a fixture, so no real
// installation is claimed. (The #153 bridge outbox that used to be tested here was removed in #1032.)
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(url);
after(() => pool.end());

const APP = '24680', INSTALL = '556';
const SHA = (c: string) => c.repeat(40);
class Provider implements GithubProvider {
  appId = APP; head = SHA('a'); allowed = new Set<string>(); generation = randomUUID();
  async repository(principal: Principal, installationId: string, repositoryId: string) {
    if (!this.allowed.has(principal.id ?? '') || installationId !== INSTALL) throw new NotFoundError('Repository', 'GITHUB_ACCESS_UNAVAILABLE');
    return { host: 'github.com' as const, installationId, repositoryId, owner: 'fixture', name: `repo-${repositoryId}`, private: false,
      url: `https://github.com/fixture/repo-${repositoryId}`, githubUserId: `9${principal.id!.length}`, appId: APP, authorizationGeneration: this.generation };
  }
  async pull(principal: Principal, repository: { repositoryId: string }, number: number): Promise<GithubPullFacts> {
    if (!this.allowed.has(principal.id ?? '')) throw new NotFoundError('Pull request', 'GITHUB_ACCESS_UNAVAILABLE');
    return { repositoryId: repository.repositoryId, pullId: `${repository.repositoryId}${number}`, number, title: 'PRIVATE title', url: `https://github.com/fixture/pull/${number}`,
      author: { id: '765', login: 'someone' }, headSha: this.head, state: 'open', draft: false, merged: false, sourceCreatedAt: '2026-10-29T10:00:00.000Z',
      sourceUpdatedAt: '2026-10-30T10:00:00.000Z', sourceMergedAt: null, checks: [], reviews: [], truncated: false, execution: 'ready_for_review' };
  }
}

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
